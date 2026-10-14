import { $, $$, toast, loadImageToCanvas, cloneCanvas, downloadBlob, slugify, formatKB, escapeHtml, canvasToBlob } from './util.js';
import { hydrateIcons, icon } from './icons.js';
import { Cutter } from './cutter.js';
import { Composer, FONTS } from './composer.js';
import { getAlpha, alphaBounds } from './imageops.js';
import * as store from './store.js';
import { encodeWebP, blobToPng, canEncodeWebPNatively, MAX_STICKER_BYTES } from './encoder.js';
import * as wa from './whatsapp.js';
import { createZip } from './zip.js';

const DECOR_EMOJIS = [
  '😂', '🤣', '😍', '🥰', '😘', '😎', '🤩', '🥳', '😭', '😡', '🤯', '😱', '🤔', '🙄', '😴', '🤤',
  '🤡', '💀', '👻', '👽', '🤖', '💩', '🙈', '🔥', '✨', '💯', '❤️', '💔', '💕', '👍', '👎', '👏',
  '🙏', '💪', '👀', '👑', '🎉', '🎂', '🌈', '⭐', '⚡', '💥', '💤', '💦', '🍕', '🍺', '☕', '🐶',
  '🐱', '🦄', '🌹', '🌻', '⚽', '🎮', '🎵', '💸', '✅', '❌', '❓', '‼️', '😏', '🫠', '🤌', '🫶',
];
const SAVE_EMOJIS = ['😀', '😂', '😍', '😎', '😭', '😡', '🤔', '😴', '🥳', '😱', '👍', '🙏', '❤️', '🔥', '🎉', '💀', '🤡', '👀', '💪', '🐶', '🐱', '☕', '🍕', '✨'];
const COLORS = ['#ffffff', '#000000', '#25d366', '#ffd60a', '#ff2d78', '#3a86ff', '#8338ec', '#ff6b00', '#e63946'];
const FILTER_PRESETS = {
  Normal: { brightness: 0, contrast: 0, saturation: 0, warmth: 0 },
  Vivo: { brightness: 4, contrast: 14, saturation: 40, warmth: 0 },
  'B/N': { brightness: 0, contrast: 12, saturation: -100, warmth: 0 },
  Cálido: { brightness: 3, contrast: 4, saturation: 12, warmth: 40 },
  Frío: { brightness: 0, contrast: 6, saturation: -5, warmth: -40 },
  Drama: { brightness: -6, contrast: 40, saturation: 10, warmth: 0 },
};
const TOOL_HINTS = {
  aiobject: 'Tocá el objeto o persona que querés conservar: la IA lo recorta sola.',
  lasso: 'Dibujá con el dedo alrededor de lo que querés conservar.',
  polygon: 'Tocá para poner puntos. Tocá el primero (verde) o «Cerrar» para recortar.',
  wand: 'Tocá una zona de color parejo (por ejemplo el fondo) para borrarla.',
  erase: 'Pasá el dedo por donde quieras borrar. Pellizcá para hacer zoom.',
  restore: 'Pasá el dedo para recuperar partes de la imagen original.',
  rect: 'Arrastrá para marcar un rectángulo.',
  ellipse: 'Arrastrá para marcar un círculo u óvalo.',
  pan: 'Arrastrá para moverte. Pellizcá o usá la rueda para hacer zoom.',
  refine: 'Retocá los bordes del recorte.',
};

const app = {
  view: 'home',
  packId: null,        // paquete abierto en la vista de paquete
  targetPackId: null,  // paquete al que se guardará el sticker en edición
  origin: 'home',
  textOnly: false,
  session: 0,
  composerSession: -1,
  tool: 'lasso',
  tab: 'adjust',
  textStyle: { font: 0, color: '#ffffff', stroke: '#000000', strokeWidth: 6 },
  draftText: '',
  saveBlob: null,
  saveEmojis: ['😀'],
  sticker: null,
  exportData: null,
};

const urls = new Set();
function objectURL(blob) {
  const u = URL.createObjectURL(blob);
  urls.add(u);
  return u;
}
function revokeAll() {
  for (const u of urls) URL.revokeObjectURL(u);
  urls.clear();
}

// =====================================================================
// Navegación (con soporte para el botón "atrás" de Android)
// =====================================================================

let trapped = false;
let ignorePop = false;

function show(name) {
  for (const v of ['home', 'cut', 'compose', 'pack']) $('#view-' + v).hidden = v !== name;
  app.view = name;
  if (name !== 'home' && !trapped) {
    history.pushState({ app: 1 }, '');
    trapped = true;
  } else if (name === 'home' && trapped) {
    trapped = false;
    ignorePop = true;
    history.back();
  }
}

window.addEventListener('popstate', () => {
  if (ignorePop) { ignorePop = false; return; }
  trapped = false;
  goBack();
});

function retrap() {
  if (!trapped && app.view !== 'home') {
    history.pushState({ app: 1 }, '');
    trapped = true;
  }
}

async function goBack() {
  const open = $$('dialog[open]');
  if (open.length) {
    // El botón "atrás" con un diálogo abierto solo lo cierra.
    for (const d of open) { d.returnValue = ''; d.close(); }
    retrap();
    return;
  }
  if (app.view === 'cut') {
    if (cutter.canUndo && !(await confirmDialog('¿Descartar este recorte?', 'Descartar'))) {
      retrap();
      return;
    }
    leaveEditor();
  } else if (app.view === 'compose') {
    if (app.textOnly) leaveEditor();
    else show('cut');
  } else if (app.view === 'pack') {
    goHome();
  }
}

function leaveEditor() {
  if (app.origin === 'pack' && app.targetPackId) openPack(app.targetPackId);
  else goHome();
}

function goHome() {
  show('home');
  renderHome();
}

// =====================================================================
// Inicio
// =====================================================================

async function renderHome() {
  revokeAll();
  const list = $('#pack-list');
  const packs = await store.listPacks();
  if (!packs.length) {
    list.innerHTML = '<div class="empty">Todavía no tenés paquetes. Creá tu primer sticker y se guardará en uno nuevo.</div>';
    return;
  }
  const cards = await Promise.all(packs.map(async (p) => {
    const stickers = await store.listStickers(p.id);
    const thumbs = stickers.slice(0, 3).map((s) => `<img src="${objectURL(s.blob)}" alt="">`).join('') || '<span></span>';
    return `<button class="pack-card" data-pack="${p.id}">
      <div class="thumbs">${thumbs}</div>
      <div class="info"><b>${escapeHtml(p.name)}</b><small>${stickers.length} sticker${stickers.length === 1 ? '' : 's'}${p.author ? ' · ' + escapeHtml(p.author) : ''}</small></div>
      ${icon('back', 'chev')}
    </button>`;
  }));
  list.innerHTML = cards.join('');
  list.querySelectorAll('.chev').forEach((c) => (c.style.transform = 'rotate(180deg)'));
}

$('#pack-list').addEventListener('click', (e) => {
  const card = e.target.closest('[data-pack]');
  if (card) openPack(card.dataset.pack);
});

$('#btn-new-pack').addEventListener('click', async () => {
  const n = (await store.listPacks()).length + 1;
  const pack = await store.createPack({ name: n === 1 ? 'Mis stickers' : `Mis stickers ${n}`, author: localStorage.getItem('sl-author') || '' });
  openPack(pack.id);
});

$('#btn-text-only').addEventListener('click', () => {
  app.origin = app.view === 'pack' ? 'pack' : 'home';
  if (app.view !== 'pack') app.targetPackId = null;
  app.textOnly = true;
  app.session++;
  show('compose');
  composer.resize();
  composer.load(null);
  app.composerSession = app.session;
  composer.addText({ ...app.textStyle, text: 'Hola!', y: 256, fontSize: 96 });
  composer.fitAll();
  setTab('text');
});

for (const id of ['#file-input', '#camera-input', '#pack-file-input']) {
  $(id).addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) startFromBlob(f);
  });
}

// Pegar imagen
document.addEventListener('paste', (e) => {
  if (e.target.closest?.('input, textarea')) return;
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (item) {
    e.preventDefault();
    startFromBlob(item.getAsFile());
  }
});

// Arrastrar y soltar
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
  dragDepth++;
  $('#drop-overlay').hidden = false;
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $('#drop-overlay').hidden = true;
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#drop-overlay').hidden = true;
  const f = [...(e.dataTransfer?.files || [])].find((x) => x.type.startsWith('image/'));
  if (f) startFromBlob(f);
});

async function startFromBlob(blob) {
  let canvas;
  try {
    canvas = await loadImageToCanvas(blob, 1024);
  } catch {
    toast('No pude abrir esa imagen. Probá con JPG, PNG o WebP.');
    return;
  }
  app.origin = app.view === 'pack' ? 'pack' : 'home';
  if (app.view === 'pack') app.targetPackId = app.packId;
  else if (app.view === 'home') app.targetPackId = null;
  app.textOnly = false;
  app.session++;
  for (const d of $$('dialog[open]')) d.close();
  show('cut');
  cutter.resize();
  cutter.load(canvas);
  selectTool('aiobject' === app.tool ? 'aiobject' : 'lasso');
  setHint('Usá «Quitar fondo» para hacerlo automático, o elegí una herramienta de recorte.', 5000);
}

// =====================================================================
// Recortar
// =====================================================================

const cutter = new Cutter($('#cut-canvas'), {
  onChange: updateUndo,
  onBusy: (on, text, progress) => {
    $('#cut-busy').hidden = !on;
    if (on) {
      $('#cut-busy-text').textContent = text || 'Procesando…';
      $('#cut-busy-bar').parentElement.hidden = progress == null;
      $('#cut-busy-bar').style.width = Math.round((progress || 0) * 100) + '%';
    }
  },
  onPolygon: (n) => {
    const close = $('[data-act="poly-close"]'), undo = $('[data-act="poly-undo"]'), cancel = $('[data-act="poly-cancel"]');
    if (close) close.disabled = n < 3;
    if (undo) undo.disabled = n < 1;
    if (cancel) cancel.disabled = n < 1;
  },
  onError: aiError,
});

function aiError(e) {
  console.error(e);
  toast('No se pudo usar la IA. Revisá tu conexión a internet e intentá de nuevo.', 4000);
}

function updateUndo() {
  $('#cut-undo').disabled = !cutter.canUndo;
  $('#cut-redo').disabled = !cutter.canRedo;
}

let hintTimer;
function setHint(text, ms = 3500) {
  const h = $('#cut-hint');
  h.textContent = text;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => (h.textContent = ''), ms);
}

function modeRow(tool) {
  const labels = { keep: 'Conservar dentro', erase: 'Borrar dentro', add: 'Agregar' };
  return `<div class="row"><div class="seg" data-mode-for="${tool}">${Object.entries(labels).map(([m, t]) =>
    `<button data-mode="${m}" class="${cutter.modes[tool] === m ? 'on' : ''}">${t}</button>`).join('')}</div></div>`;
}

function sliderHtml(label, bind, min, max, step, value, fmt = (v) => v) {
  return `<label class="slider"><span>${label}</span><input type="range" min="${min}" max="${max}" step="${step}" value="${value}" data-bind="${bind}"><output>${fmt(value)}</output></label>`;
}

function renderCutOptions() {
  const t = app.tool, s = cutter.settings;
  let html = '';
  if (['lasso', 'polygon', 'rect', 'ellipse', 'aiobject'].includes(t)) html += modeRow(t);
  if (t === 'polygon') {
    const n = cutter.poly.length;
    html += `<div class="row mini-btns">
      <button class="btn primary" data-act="poly-close" data-icon="check" ${n < 3 ? 'disabled' : ''}>Cerrar forma</button>
      <button class="btn" data-act="poly-undo" data-icon="undo" ${n < 1 ? 'disabled' : ''}>Quitar punto</button>
      <button class="btn ghost" data-act="poly-cancel" ${n < 1 ? 'disabled' : ''}>Cancelar</button></div>`;
  }
  if (t === 'wand') {
    html += modeRow('wand');
    html += `<div class="row">${sliderHtml('Tolerancia', 'tolerance', 1, 100, 1, s.tolerance)}
      <label class="switch"><input type="checkbox" data-bind="contiguous" ${s.contiguous ? 'checked' : ''}>Solo zona conectada</label></div>`;
  }
  if (t === 'erase' || t === 'restore') {
    html += `<div class="row">${sliderHtml('Tamaño', 'brushSize', 4, 160, 1, s.brushSize)}
      <label class="switch"><input type="checkbox" data-bind="brushOffset" ${s.brushOffset ? 'checked' : ''}>Pincel desplazado (ver bajo el dedo)</label></div>`;
  }
  if (t === 'refine') {
    html += `<div class="row mini-btns">
      <button class="btn" data-act="feather" data-icon="feather">Suavizar bordes</button>
      <button class="btn" data-act="shrink" data-icon="shrink">Contraer borde</button>
      <button class="btn" data-act="grow" data-icon="grow">Expandir borde</button>
      <button class="btn" data-act="invert" data-icon="invert">Invertir</button>
      <button class="btn danger" data-act="reset" data-icon="reset">Restablecer</button></div>`;
  }
  const box = $('#cut-options');
  box.innerHTML = html;
  hydrateIcons(box);
}

function selectTool(tool) {
  app.tool = tool;
  cutter.setTool(tool === 'refine' ? 'pan' : tool);
  $$('#cut-tools .tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  renderCutOptions();
  if (TOOL_HINTS[tool]) setHint(TOOL_HINTS[tool]);
}

$('#cut-tools').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.tool) selectTool(b.dataset.tool);
  if (b.dataset.action === 'auto-bg') {
    try {
      await cutter.autoRemoveBackground();
      toast('Fondo quitado. Retocá con Borrador o Restaurar si hace falta.');
    } catch (err) {
      aiError(err);
    }
  }
});

$('#cut-options').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.mode) {
    const tool = b.parentElement.dataset.modeFor;
    cutter.setMode(tool, b.dataset.mode);
    b.parentElement.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    return;
  }
  switch (b.dataset.act) {
    case 'poly-close': cutter.closePolygon(); break;
    case 'poly-undo': cutter.undoPolygonPoint(); break;
    case 'poly-cancel': cutter.cancelPolygon(); break;
    case 'feather': cutter.feather(2); toast('Bordes suavizados'); break;
    case 'shrink': cutter.grow(-2); toast('Borde contraído 2 px'); break;
    case 'grow': cutter.grow(2); toast('Borde expandido 2 px'); break;
    case 'invert': cutter.invert(); break;
    case 'reset': cutter.reset(); break;
  }
});

$('#cut-options').addEventListener('input', (e) => {
  const i = e.target;
  const key = i.dataset.bind;
  if (!key) return;
  cutter.settings[key] = i.type === 'checkbox' ? i.checked : +i.value;
  const out = i.parentElement.querySelector('output');
  if (out) out.textContent = i.value;
  if (key === 'brushSize') {
    cutter.hover = { x: cutter.cssW / 2, y: cutter.cssH / 2 };
    cutter.requestRender();
  }
});

$('#cut-undo').addEventListener('click', () => cutter.undo());
$('#cut-redo').addEventListener('click', () => cutter.redo());
$('#cut-back').addEventListener('click', () => history.back());
$('#cut-fit').addEventListener('click', () => cutter.fit());
$('#cut-show-removed').addEventListener('click', (e) => {
  const b = e.currentTarget;
  cutter.settings.showRemoved = !cutter.settings.showRemoved;
  b.setAttribute('aria-pressed', cutter.settings.showRemoved);
  cutter.requestRender();
});

$('#cut-next').addEventListener('click', () => {
  if (cutter.busy) return;
  if (cutter.poly.length >= 3) cutter.closePolygon();
  const cut = cutter.exportCutout();
  if (!cut) {
    toast('El recorte quedó vacío. Usá Deshacer o Restaurar.');
    return;
  }
  show('compose');
  composer.resize();
  if (app.composerSession === app.session) composer.replaceImage(cut);
  else composer.load(cut);
  app.composerSession = app.session;
  setTab(app.tab);
});

// =====================================================================
// Decorar
// =====================================================================

const composer = new Composer($('#compose-canvas'), {
  onSelect: (layer, opts = {}) => {
    if (opts.silent) { syncPanel(); return; }
    if (opts.edit && layer?.type === 'text') { setTab('text'); $('#compose-panel textarea')?.focus(); return; }
    if (layer?.type === 'text' && app.tab === 'emoji') app.tab = 'text';
    if (app.view === 'compose') renderPanel();
  },
  onChange: () => scheduleSizeEstimate(),
});

$('#compose-back').addEventListener('click', () => history.back());
$('#compose-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (b) setTab(b.dataset.tab);
});

function setTab(tab) {
  app.tab = tab;
  $$('#compose-tabs .tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  renderPanel();
}

function swatchesHtml(bind, current, { allowNone = false } = {}) {
  let html = `<div class="swatches" data-swatches="${bind}">`;
  if (allowNone) html += `<button class="swatch none ${!current ? 'on' : ''}" data-color="" title="Transparente" aria-label="Transparente"></button>`;
  for (const c of COLORS) html += `<button class="swatch ${current === c ? 'on' : ''}" data-color="${c}" style="background:${c}" aria-label="${c}"></button>`;
  html += `<input type="color" value="${current || '#ffffff'}" data-color-input="${bind}" title="Otro color"></div>`;
  return html;
}

const deg = (r) => Math.round((r * 180) / Math.PI);

function renderPanel() {
  const panel = $('#compose-panel');
  const st = composer.state;
  const l = composer.selected;
  let html = '';
  switch (app.tab) {
    case 'adjust':
      if (!l) {
        html = `<p class="muted">Tocá un elemento del sticker para moverlo, girarlo o cambiar su tamaño. Con dos dedos podés pellizcar y rotar.</p>
          <div class="row mini-btns"><button class="btn" data-act="fit-all" data-icon="fit">Encajar todo en el margen</button></div>`;
      } else {
        html = `<div class="row">${sliderHtml('Tamaño', 'scale', Math.log(0.03).toFixed(2), Math.log(8).toFixed(2), 0.01, Math.log(l.scale).toFixed(2), (v) => Math.round(Math.exp(v) * 100) + '%')}</div>
          <div class="row">${sliderHtml('Rotación', 'rotation', -180, 180, 1, deg(l.rotation), (v) => v + '°')}</div>
          <div class="row mini-btns">
            <button class="btn" data-act="flipX" data-icon="flipH">Espejo</button>
            <button class="btn" data-act="flipY" data-icon="flipV">Voltear</button>
            <button class="btn" data-act="rot90" data-icon="rotate">90°</button>
            <button class="btn" data-act="fit" data-icon="fit">${l.type === 'image' ? 'Encajar' : 'Centrar'}</button>
            <button class="btn" data-act="dup" data-icon="copy">Duplicar</button>
            <button class="btn" data-act="up" data-icon="up">Adelante</button>
            <button class="btn" data-act="down" data-icon="down">Atrás</button>
            <button class="btn danger" data-act="del" data-icon="trash">Eliminar</button>
          </div>`;
      }
      break;
    case 'border':
      html = `<div class="row"><label class="switch"><input type="checkbox" data-bind="border.on" ${st.border.on ? 'checked' : ''}>Borde alrededor del sticker</label></div>
        <div class="row">${sliderHtml('Grosor', 'border.width', 1, 30, 1, st.border.width, (v) => v + ' px')}</div>
        <div class="row"><span class="lbl">Color</span>${swatchesHtml('border.color', st.border.color)}</div>`;
      break;
    case 'text': {
      const t = l?.type === 'text' ? l : null;
      const style = t || app.textStyle;
      html = `<div class="row"><textarea class="text-input" rows="2" data-bind="text" placeholder="Escribí tu texto…">${escapeHtml(t ? t.text : app.draftText)}</textarea></div>
        <div class="row"><div class="font-list">${FONTS.map((f, i) =>
          `<button data-font="${i}" class="${style.font === i ? 'on' : ''}" style="font-family:${f.css.replace(/"/g, "'")};font-weight:${f.weight}">${escapeHtml(f.name === 'Sistema' ? 'Aa' : f.name)}</button>`).join('')}</div></div>
        <div class="row"><span class="lbl">Relleno</span>${swatchesHtml('text.color', style.color)}</div>
        <div class="row"><span class="lbl">Contorno</span>${swatchesHtml('text.stroke', style.stroke)}</div>
        <div class="row">${sliderHtml('Grosor', 'text.strokeWidth', 0, 20, 1, style.strokeWidth, (v) => v + ' px')}</div>
        <div class="row mini-btns">
          <button class="btn ${t ? '' : 'primary'}" data-act="add-text" data-icon="plus">${t ? 'Otro texto' : 'Añadir texto'}</button>
          ${t ? '<button class="btn danger" data-act="del" data-icon="trash">Eliminar texto</button>' : ''}
        </div>`;
      break;
    }
    case 'emoji':
      html = `<div class="emoji-grid">${DECOR_EMOJIS.map((e) => `<button data-emoji="${e}">${e}</button>`).join('')}</div>`;
      break;
    case 'filters': {
      const f = st.filters;
      html = `<div class="row mini-btns">${Object.keys(FILTER_PRESETS).map((k) => `<button class="btn" data-preset="${k}">${k}</button>`).join('')}</div>
        <div class="row">${sliderHtml('Brillo', 'f.brightness', -100, 100, 1, f.brightness)}</div>
        <div class="row">${sliderHtml('Contraste', 'f.contrast', -100, 100, 1, f.contrast)}</div>
        <div class="row">${sliderHtml('Saturación', 'f.saturation', -100, 100, 1, f.saturation)}</div>
        <div class="row">${sliderHtml('Calidez', 'f.warmth', -100, 100, 1, f.warmth)}</div>`;
      break;
    }
    case 'shadow': {
      const s = st.shadow;
      html = `<div class="row"><label class="switch"><input type="checkbox" data-bind="shadow.on" ${s.on ? 'checked' : ''}>Sombra</label></div>
        <div class="row">${sliderHtml('Difuminado', 'shadow.blur', 0, 40, 1, s.blur)}</div>
        <div class="row">${sliderHtml('Distancia', 'shadow.offset', 0, 24, 1, s.offset)}</div>
        <div class="row">${sliderHtml('Opacidad', 'shadow.opacity', 0.05, 1, 0.05, s.opacity, (v) => Math.round(v * 100) + '%')}</div>`;
      break;
    }
    case 'bg':
      html = `<div class="row"><span class="lbl">Fondo</span>${swatchesHtml('bg', st.bg, { allowNone: true })}</div>
        <p class="muted">WhatsApp recomienda fondo transparente para que el sticker se vea bien en cualquier chat.</p>
        <div class="row"><label class="switch"><input type="checkbox" data-bind="guide" ${st.showGuide ? 'checked' : ''}>Mostrar margen seguro (16 px)</label></div>`;
      break;
  }
  panel.innerHTML = html;
  hydrateIcons(panel);
}

/** Actualiza valores del panel sin redibujarlo (mientras se arrastra en el lienzo). */
function syncPanel() {
  const l = composer.selected;
  if (!l || app.tab !== 'adjust') return;
  const sc = $('#compose-panel [data-bind="scale"]');
  const rot = $('#compose-panel [data-bind="rotation"]');
  if (!sc) { renderPanel(); return; }
  sc.value = Math.log(l.scale);
  sc.nextElementSibling.textContent = Math.round(l.scale * 100) + '%';
  rot.value = deg(((l.rotation + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI);
  rot.nextElementSibling.textContent = rot.value + '°';
}

function setTextProp(prop, value) {
  const l = composer.selected;
  if (l?.type === 'text') composer.updateSelected({ [prop]: value });
  app.textStyle[prop] = value;
}

function applyColor(bind, color) {
  const st = composer.state;
  if (bind === 'border.color') { st.border.color = color; st.border.on = true; composer.changed(); }
  else if (bind === 'text.color') setTextProp('color', color);
  else if (bind === 'text.stroke') setTextProp('stroke', color);
  else if (bind === 'bg') { st.bg = color || null; composer.changed(); }
}

let filterRaf = 0;
$('#compose-panel').addEventListener('input', (e) => {
  const i = e.target;
  if (i.dataset.colorInput) {
    applyColor(i.dataset.colorInput, i.value);
    i.parentElement.querySelectorAll('.swatch').forEach((s) => s.classList.remove('on'));
    return;
  }
  const key = i.dataset.bind;
  if (!key) return;
  const v = i.type === 'checkbox' ? i.checked : i.type === 'range' ? +i.value : i.value;
  const out = i.parentElement.querySelector('output');
  const st = composer.state;
  const l = composer.selected;
  switch (key) {
    case 'scale': if (l) composer.updateSelected({ scale: Math.exp(v) }); if (out) out.textContent = Math.round(Math.exp(v) * 100) + '%'; return;
    case 'rotation': if (l) composer.updateSelected({ rotation: (v * Math.PI) / 180 }); if (out) out.textContent = v + '°'; return;
    case 'border.on': st.border.on = v; break;
    case 'border.width': st.border.width = v; st.border.on = true; if (out) out.textContent = v + ' px'; renderPanelCheck('border.on', true); break;
    case 'text':
      if (l?.type === 'text') {
        composer.updateSelected({ text: v || ' ' });
        // En stickers de solo texto, el texto ocupa todo el lienzo mientras se escribe.
        if (app.textOnly && composer.state.layers.length === 1) composer.fitAll();
      } else app.draftText = v;
      return;
    case 'text.strokeWidth': setTextProp('strokeWidth', v); if (out) out.textContent = v + ' px'; return;
    case 'shadow.on': st.shadow.on = v; break;
    case 'shadow.blur': case 'shadow.offset': st.shadow[key.split('.')[1]] = v; st.shadow.on = true; renderPanelCheck('shadow.on', true); break;
    case 'shadow.opacity': st.shadow.opacity = v; st.shadow.on = true; renderPanelCheck('shadow.on', true); if (out) out.textContent = Math.round(v * 100) + '%'; break;
    case 'guide': st.showGuide = v; break;
    default:
      if (key.startsWith('f.')) {
        st.filters[key.slice(2)] = v;
        if (out) out.textContent = v;
        cancelAnimationFrame(filterRaf);
        filterRaf = requestAnimationFrame(() => composer.setFilters({}));
        return;
      }
  }
  if (out && !out.textContent.endsWith('%') && !out.textContent.endsWith('px')) out.textContent = v;
  composer.changed();
});

function renderPanelCheck(bind, value) {
  const c = $(`#compose-panel [data-bind="${bind}"]`);
  if (c) c.checked = value;
}

$('#compose-panel').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const l = composer.selected;
  if (b.dataset.color !== undefined && b.parentElement.dataset.swatches) {
    applyColor(b.parentElement.dataset.swatches, b.dataset.color);
    b.parentElement.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('on', s === b));
    if (b.parentElement.dataset.swatches === 'border.color') renderPanelCheck('border.on', true);
    return;
  }
  if (b.dataset.font !== undefined) {
    setTextProp('font', +b.dataset.font);
    b.parentElement.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    return;
  }
  if (b.dataset.emoji) {
    composer.addEmoji(b.dataset.emoji);
    toast('Emoji agregado: arrastralo para ubicarlo');
    return;
  }
  if (b.dataset.preset) {
    Object.assign(composer.state.filters, FILTER_PRESETS[b.dataset.preset]);
    composer.setFilters({});
    renderPanel();
    return;
  }
  switch (b.dataset.act) {
    case 'fit-all': composer.fitAll(); break;
    case 'flipX': composer.updateSelected({ flipX: !l.flipX }); break;
    case 'flipY': composer.updateSelected({ flipY: !l.flipY }); break;
    case 'rot90': composer.updateSelected({ rotation: l.rotation + Math.PI / 2 }); syncPanel(); break;
    case 'fit':
      if (l.type === 'image') composer.fitLayer(l);
      else composer.updateSelected({ x: 256 });
      syncPanel();
      break;
    case 'dup': composer.duplicateSelected(); break;
    case 'up': composer.moveSelected(1); break;
    case 'down': composer.moveSelected(-1); break;
    case 'del':
      if (composer.removeSelected() === false) toast('El sticker necesita la imagen. Volvé al recorte para cambiarla.');
      break;
    case 'add-text': {
      const text = (l?.type === 'text' ? '' : app.draftText.trim()) || 'Texto';
      app.draftText = '';
      const n = composer.state.layers.filter((x) => x.type === 'text').length;
      composer.addText({ ...app.textStyle, text, y: n % 2 ? 80 : 430 });
      setTab('text');
      const ta = $('#compose-panel textarea');
      ta?.focus();
      ta?.select();
      break;
    }
  }
});

// Estimación de peso del sticker
let sizeTimer;
function scheduleSizeEstimate() {
  clearTimeout(sizeTimer);
  sizeTimer = setTimeout(async () => {
    if (app.view !== 'compose' || !canEncodeWebPNatively()) { $('#compose-size').textContent = '512×512'; return; }
    const b = await canvasToBlob(composer.renderOutput(), 'image/webp', 0.9);
    $('#compose-size').textContent = `512×512 · ≈${formatKB(b.size)}`;
  }, 600);
}

// =====================================================================
// Guardar
// =====================================================================

$('#compose-save').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const out = cloneCanvas(composer.renderOutput());
  if (!composer.state.bg && !alphaBounds(getAlpha(out), out.width, out.height, 8)) {
    toast('El sticker está vacío');
    return;
  }
  btn.disabled = true;
  try {
    if (!canEncodeWebPNatively()) toast('Preparando WebP…');
    const { blob, quality } = await encodeWebP(out);
    app.saveBlob = blob;
    $('#save-img').src = objectURL(blob);
    $('#save-info').innerHTML = `512×512 · ${formatKB(blob.size)} · WebP ${Math.round(quality * 100)}%` +
      (blob.size > MAX_STICKER_BYTES ? '<br><b style="color:var(--danger)">Supera los 100 KB que permite WhatsApp. Simplificá la imagen.</b>' : '');
    await fillPackSelect();
    renderSaveEmojis();
    $('#dlg-save').returnValue = '';
    $('#dlg-save').showModal();
  } catch (err) {
    console.error(err);
    toast('No se pudo generar el WebP: ' + err.message);
  } finally {
    btn.disabled = false;
  }
});

async function fillPackSelect() {
  const packs = await store.listPacks();
  const sel = $('#save-pack');
  const preferred = app.targetPackId || localStorage.getItem('sl-last-pack');
  sel.innerHTML = packs.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('') +
    '<option value="__new">+ Nuevo paquete…</option>';
  sel.value = packs.some((p) => p.id === preferred) ? preferred : packs[0]?.id || '__new';
  $('#save-new-wrap').hidden = sel.value !== '__new';
}

$('#save-pack').addEventListener('change', (e) => {
  $('#save-new-wrap').hidden = e.target.value !== '__new';
});

function renderSaveEmojis() {
  $('#save-emojis').innerHTML = SAVE_EMOJIS.map((e) =>
    `<button type="button" data-emoji="${e}" class="${app.saveEmojis.includes(e) ? 'on' : ''}">${e}</button>`).join('');
}

$('#save-emojis').addEventListener('click', (e) => {
  const b = e.target.closest('[data-emoji]');
  if (!b) return;
  const em = b.dataset.emoji;
  const list = app.saveEmojis;
  if (list.includes(em)) {
    if (list.length > 1) list.splice(list.indexOf(em), 1);
  } else {
    list.push(em);
    if (list.length > 3) list.shift();
  }
  renderSaveEmojis();
});

$('#save-share').addEventListener('click', async (e) => {
  e.preventDefault();
  await shareOrDownload([new File([app.saveBlob], 'sticker.webp', { type: 'image/webp' })]);
});

$('#dlg-save').addEventListener('close', async () => {
  if ($('#dlg-save').returnValue !== 'save') return;
  let packId = $('#save-pack').value;
  try {
    if (packId === '__new') {
      const pack = await store.createPack({ name: $('#save-new-name').value.trim() || 'Mis stickers', author: localStorage.getItem('sl-author') || '' });
      packId = pack.id;
    }
    const count = await store.countStickers(packId);
    if (count >= wa.MAX_STICKERS) {
      toast(`Ese paquete ya tiene ${wa.MAX_STICKERS} stickers (máximo de WhatsApp). Elegí otro o creá uno nuevo.`, 4500);
      return;
    }
    await store.addSticker(packId, { blob: app.saveBlob, emojis: [...app.saveEmojis] });
    localStorage.setItem('sl-last-pack', packId);
    app.session++; // el recorte actual termina acá
    await openPack(packId);
    toast('¡Sticker guardado!');
  } catch (err) {
    console.error(err);
    toast('No se pudo guardar: ' + err.message);
  }
});

async function shareOrDownload(files) {
  try {
    if (wa.canShareFiles(files)) {
      await wa.shareFiles(files, 'Sticker');
      return;
    }
  } catch (err) {
    console.error(err);
  }
  for (const f of files) downloadBlob(f, f.name);
  toast('Tu navegador no permite compartir: descargué el archivo. Arrastralo a un chat de WhatsApp Web.', 4500);
}

// =====================================================================
// Paquete
// =====================================================================

async function openPack(id) {
  app.packId = id;
  app.targetPackId = id;
  app.origin = 'pack';
  show('pack');
  await renderPack();
}

async function renderPack() {
  revokeAll();
  const pack = await store.getPack(app.packId);
  if (!pack) { goHome(); return; }
  const stickers = await store.listStickers(pack.id);
  $('#pack-title').textContent = pack.name;
  $('#pack-name').value = pack.name;
  $('#pack-author').value = pack.author || '';
  const n = stickers.length;
  const status = n < wa.MIN_STICKERS
    ? `Te faltan ${wa.MIN_STICKERS - n} para poder exportar el paquete completo.`
    : n >= wa.MAX_STICKERS ? 'Paquete lleno.' : 'Listo para exportar.';
  $('#pack-meta').innerHTML = `<b>${n}</b> de ${wa.MAX_STICKERS} stickers · ${status}<div class="bar"><div style="width:${(n / wa.MAX_STICKERS) * 100}%"></div></div>`;
  const trayId = pack.trayId && stickers.some((s) => s.id === pack.trayId) ? pack.trayId : stickers[0]?.id;
  $('#sticker-grid').innerHTML = stickers.map((s) => `<button class="sticker-cell" data-sticker="${s.id}" title="${(s.emojis || []).join(' ')}">
      <img src="${objectURL(s.blob)}" alt="Sticker ${escapeHtml((s.emojis || []).join(' '))}">
      ${s.id === trayId ? `<span class="tray-badge" title="Ícono del paquete">${icon('star')}</span>` : ''}
    </button>`).join('') +
    (n < wa.MAX_STICKERS ? `<label class="sticker-cell add" title="Nuevo sticker"><input type="file" accept="image/*" hidden data-add-input>${icon('plus')}</label>` : '');
  $('#pack-export').disabled = n === 0;
  app.packStickers = stickers;
}

$('#sticker-grid').addEventListener('change', (e) => {
  if (!e.target.matches('[data-add-input]')) return;
  const f = e.target.files[0];
  if (f) startFromBlob(f);
});

$('#sticker-grid').addEventListener('click', (e) => {
  const cell = e.target.closest('[data-sticker]');
  if (!cell) return;
  const s = app.packStickers.find((x) => x.id === cell.dataset.sticker);
  if (!s) return;
  app.sticker = s;
  $('#st-img').src = objectURL(s.blob);
  $('#st-info').textContent = `${formatKB(s.blob.size)} · ${(s.emojis || []).join(' ')}`;
  $('#dlg-sticker').showModal();
});

$('#dlg-sticker .action-list').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  e.preventDefault();
  const s = app.sticker;
  const dlg = $('#dlg-sticker');
  const i = app.packStickers.indexOf(s);
  switch (b.value) {
    case 'share':
      await shareOrDownload([wa.stickerFile(s, i)]);
      break;
    case 'download':
      downloadBlob(s.blob, `sticker-${i + 1}.webp`);
      break;
    case 'png':
      downloadBlob(await blobToPng(s.blob), `sticker-${i + 1}.png`);
      break;
    case 'copy':
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blobToPng(s.blob) })]);
        toast('Imagen copiada');
      } catch {
        toast('Tu navegador no permite copiar imágenes');
      }
      break;
    case 'tray': {
      const pack = await store.getPack(app.packId);
      pack.trayId = s.id;
      await store.savePack(pack);
      dlg.close();
      renderPack();
      toast('Ícono del paquete actualizado');
      break;
    }
    case 'edit':
      dlg.close();
      startFromBlob(s.blob);
      break;
    case 'delete':
      dlg.close();
      if (await confirmDialog('¿Eliminar este sticker?')) {
        await store.deleteSticker(s.id);
        renderPack();
      }
      break;
  }
});

$('#pack-name').addEventListener('change', async (e) => {
  const pack = await store.getPack(app.packId);
  pack.name = e.target.value.trim() || 'Mis stickers';
  await store.savePack(pack);
  $('#pack-title').textContent = pack.name;
});

$('#pack-author').addEventListener('change', async (e) => {
  const pack = await store.getPack(app.packId);
  pack.author = e.target.value.trim();
  localStorage.setItem('sl-author', pack.author);
  await store.savePack(pack);
});

$('#pack-back').addEventListener('click', () => history.back());

$('#pack-delete').addEventListener('click', async () => {
  const pack = await store.getPack(app.packId);
  if (await confirmDialog(`¿Eliminar el paquete «${pack.name}» y todos sus stickers?`)) {
    await store.deletePack(pack.id);
    goHome();
  }
});

$('#pack-export').addEventListener('click', async () => {
  const pack = await store.getPack(app.packId);
  const stickers = await store.listStickers(pack.id);
  app.exportData = { pack, stickers };
  const issues = wa.validatePack(pack, stickers);
  $('#export-issues').innerHTML = issues.length
    ? `<div class="issues"><b>Para el paquete .wastickers:</b><ul>${issues.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul></div>`
    : '';
  $('#export-wa').disabled = stickers.length < wa.MIN_STICKERS || stickers.length > wa.MAX_STICKERS;
  $('#dlg-export').showModal();
});

$('#dlg-export .action-list').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  e.preventDefault();
  const { pack, stickers } = app.exportData;
  const slug = slugify(pack.name);
  try {
    switch (b.value) {
      case 'share-all': {
        const files = stickers.map((s, i) => wa.stickerFile(s, i));
        if (wa.canShareFiles(files)) await wa.shareFiles(files, pack.name);
        else toast('Tu navegador no permite compartir varios archivos. Usá «Descargar ZIP de .webp».', 4500);
        break;
      }
      case 'wastickers': {
        const file = await wa.buildWastickers(pack, stickers);
        downloadBlob(file, file.name);
        toast('Descargado. Abrilo con una app importadora de stickers para WhatsApp.', 4500);
        break;
      }
      case 'webp-zip': {
        const zip = await createZip(stickers.map((s, i) => ({ name: `${slug}-${String(i + 1).padStart(2, '0')}.webp`, data: s.blob })));
        downloadBlob(zip, `${slug}-webp.zip`);
        break;
      }
      case 'dev-zip': {
        if (!stickers.length) break;
        downloadBlob(await wa.buildDeveloperZip(pack, stickers), `${slug}-whatsapp-contents.zip`);
        break;
      }
    }
  } catch (err) {
    console.error(err);
    toast('Error al exportar: ' + err.message);
  }
});

// =====================================================================
// Utilidades de UI
// =====================================================================

function confirmDialog(text, okLabel = 'Eliminar') {
  return new Promise((resolve) => {
    const d = $('#dlg-confirm');
    $('#confirm-text').textContent = text;
    $('#confirm-ok').textContent = okLabel;
    d.returnValue = '';
    d.addEventListener('close', () => resolve(d.returnValue === 'ok'), { once: true });
    d.showModal();
  });
}

document.addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, textarea, select') || $$('dialog[open]').length) return;
  const mod = e.ctrlKey || e.metaKey;
  if (app.view === 'cut') {
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? cutter.redo() : cutter.undo(); }
    else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); cutter.redo(); }
    else if (e.key === 'Enter' && app.tool === 'polygon') cutter.closePolygon();
    else if (e.key === 'Escape' && app.tool === 'polygon') cutter.cancelPolygon();
    else if (e.key === 'Backspace' && app.tool === 'polygon') cutter.undoPolygonPoint();
    else if (!mod) {
      const keys = { l: 'lasso', p: 'polygon', w: 'wand', e: 'erase', r: 'restore', h: 'pan', m: 'rect', o: 'ellipse', a: 'aiobject' };
      if (keys[e.key]) selectTool(keys[e.key]);
      if (e.key === '+' || e.key === '=') cutter.zoomAt(cutter.cssW / 2, cutter.cssH / 2, 1.25);
      if (e.key === '-') cutter.zoomAt(cutter.cssW / 2, cutter.cssH / 2, 0.8);
      if (e.key === '0') cutter.fit();
    }
  } else if (app.view === 'compose') {
    const l = composer.selected;
    if ((e.key === 'Delete' || e.key === 'Backspace') && l) {
      if (composer.removeSelected() === false) toast('El sticker necesita la imagen.');
    } else if (l && e.key.startsWith('Arrow')) {
      e.preventDefault();
      const d = e.shiftKey ? 10 : 2;
      const dx = { ArrowLeft: -d, ArrowRight: d }[e.key] || 0;
      const dy = { ArrowUp: -d, ArrowDown: d }[e.key] || 0;
      composer.updateSelected({ x: l.x + dx, y: l.y + dy });
    }
  }
});

// Instalación como app (PWA)
let installEvent;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvent = e;
  $('#btn-install').hidden = false;
});
$('#btn-install').addEventListener('click', async () => {
  if (!installEvent) return;
  installEvent.prompt();
  await installEvent.userChoice;
  installEvent = null;
  $('#btn-install').hidden = true;
});

async function receiveSharedImage() {
  const params = new URLSearchParams(location.search);
  if (!params.has('shared')) return;
  history.replaceState(null, '', location.pathname);
  try {
    const cache = await caches.open('share-inbox');
    const res = await cache.match('shared-image');
    if (res) {
      await cache.delete('shared-image');
      startFromBlob(await res.blob());
    }
  } catch (e) {
    console.error(e);
  }
}

// Arranque
hydrateIcons();
history.replaceState({ app: 0 }, '');
renderHome();
receiveSharedImage();
updateUndo();
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
}

// Exponer para depuración en consola
window.stickerlab = { app, cutter, composer, store };
