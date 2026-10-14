// Editor de decoración: lienzo 512×512 con capas (imagen recortada, textos, emojis),
// borde tipo sticker alrededor de todo el contenido, sombra, filtros y fondo.

import { clamp, makeCanvas, ctx2d, uid } from './util.js';
import { outlineCanvas, adjustColors } from './imageops.js';

export const SIZE = 512;
export const MARGIN = 16; // margen recomendado por WhatsApp

export const FONTS = [
  { name: 'Bangers', css: '"Bangers", Impact, sans-serif', weight: '400' },
  { name: 'Luckiest Guy', css: '"Luckiest Guy", Impact, sans-serif', weight: '400' },
  { name: 'Anton', css: '"Anton", Impact, sans-serif', weight: '400' },
  { name: 'Fredoka', css: '"Fredoka", system-ui, sans-serif', weight: '600' },
  { name: 'Permanent Marker', css: '"Permanent Marker", cursive', weight: '400' },
  { name: 'Pacifico', css: '"Pacifico", cursive', weight: '400' },
  { name: 'Lobster', css: '"Lobster", cursive', weight: '400' },
  { name: 'Sistema', css: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif', weight: '800' },
];

const EMOJI_FONT = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", "Twemoji Mozilla", sans-serif';
const HANDLE_R = 14; // radio del tirador en px CSS

export function defaultState() {
  return {
    layers: [],
    selectedId: null,
    border: { on: true, width: 10, color: '#ffffff' },
    shadow: { on: false, blur: 10, offset: 4, opacity: 0.35 },
    filters: { brightness: 0, contrast: 0, saturation: 0, warmth: 0 },
    bg: null, // null = transparente, o '#rrggbb'
    showGuide: true,
  };
}

export class Composer {
  constructor(canvas, { onSelect, onChange } = {}) {
    this.canvas = canvas;
    this.ctx = ctx2d(canvas);
    this.onSelect = onSelect || (() => {});
    this.onChange = onChange || (() => {});
    this.state = defaultState();
    this.content = makeCanvas(SIZE, SIZE);
    ctx2d(this.content, { willReadFrequently: true }); // se lee en cada render para calcular el borde
    this.out = makeCanvas(SIZE, SIZE);
    this.pointers = new Map();
    this.drag = null;
    this._raf = 0;
    this._bind();
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    document.fonts?.addEventListener?.('loadingdone', () => this.requestRender());
  }

  /** Empieza un sticker nuevo con el recorte dado (o vacío, para stickers de solo texto). */
  load(cutout) {
    const prev = this.state;
    this.state = defaultState();
    // Conservamos el estilo de borde/sombra elegido en el sticker anterior.
    this.state.border = { ...prev.border };
    this.state.shadow = { ...prev.shadow };
    this.state.showGuide = prev.showGuide;
    if (cutout) {
      const img = {
        id: uid(), type: 'image', source: cutout, canvas: cutout,
        w: cutout.width, h: cutout.height, x: SIZE / 2, y: SIZE / 2, scale: 1, rotation: 0, flipX: false, flipY: false,
      };
      this.state.layers.push(img);
      this.state.selectedId = img.id;
      this.fitLayer(img);
    }
    this.onSelect(this.selected);
    this.changed();
  }

  /** Reemplaza el recorte manteniendo textos, emojis y estilos (al volver a recortar). */
  replaceImage(cutout) {
    const l = this.imageLayer;
    if (!l) return this.load(cutout);
    const visual = Math.max(l.w, l.h) * l.scale;
    l.source = cutout;
    l.w = cutout.width;
    l.h = cutout.height;
    l.canvas = adjustColors(cutout, this.state.filters);
    l.scale = visual / Math.max(l.w, l.h);
    this.changed();
  }

  get selected() {
    return this.state.layers.find((l) => l.id === this.state.selectedId) || null;
  }

  get imageLayer() {
    return this.state.layers.find((l) => l.type === 'image') || null;
  }

  select(layer) {
    this.state.selectedId = layer ? layer.id : null;
    this.onSelect(layer);
    this.requestRender();
  }

  changed() {
    this.requestRender();
    this.onChange();
  }

  // ---------- capas ----------

  fitLayer(layer = this.imageLayer) {
    if (!layer) return;
    const { hw, hh } = this.layerHalf(layer, 1);
    const avail = SIZE / 2 - MARGIN - (this.state.border.on ? this.state.border.width : 0) - 2;
    // Caja rotada a escala 1
    const c = Math.abs(Math.cos(layer.rotation)), s = Math.abs(Math.sin(layer.rotation));
    const bw = hw * c + hh * s, bh = hw * s + hh * c;
    layer.scale = avail / Math.max(bw, bh);
    layer.x = SIZE / 2;
    layer.y = SIZE / 2;
    this.changed();
  }

  /** Ajusta todo el contenido para que entre en el margen seguro. */
  fitAll() {
    const layers = this.state.layers;
    if (!layers.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const l of layers) {
      for (const p of this.layerCorners(l)) {
        x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
        x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
      }
    }
    const avail = SIZE - 2 * (MARGIN + (this.state.border.on ? this.state.border.width : 0) + 2);
    const k = avail / Math.max(x1 - x0, y1 - y0);
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    for (const l of layers) {
      l.x = SIZE / 2 + (l.x - cx) * k;
      l.y = SIZE / 2 + (l.y - cy) * k;
      l.scale *= k;
    }
    this.changed();
  }

  addText(props = {}) {
    const layer = {
      id: uid(), type: 'text', text: 'Texto', font: 0, color: '#ffffff', stroke: '#000000', strokeWidth: 6,
      fontSize: 72, x: SIZE / 2, y: SIZE * 0.82, scale: 1, rotation: 0, flipX: false, flipY: false, ...props,
    };
    this.state.layers.push(layer);
    this.select(layer);
    this.changed();
    return layer;
  }

  addEmoji(emoji) {
    const n = this.state.layers.filter((l) => l.type === 'emoji').length;
    const layer = {
      id: uid(), type: 'emoji', text: emoji, fontSize: 110,
      x: SIZE * (0.78 - (n % 3) * 0.1), y: SIZE * (0.2 + (n % 3) * 0.08),
      scale: 1, rotation: (Math.random() - 0.5) * 0.4, flipX: false, flipY: false,
    };
    this.state.layers.push(layer);
    this.select(layer);
    this.changed();
  }

  updateSelected(props) {
    const l = this.selected;
    if (!l) return;
    Object.assign(l, props);
    this.changed();
  }

  removeSelected() {
    const l = this.selected;
    if (!l) return;
    if (l.type === 'image' && !this.state.layers.some((x) => x !== l && x.type === 'image')) return false;
    this.state.layers = this.state.layers.filter((x) => x !== l);
    this.select(null);
    this.changed();
    return true;
  }

  duplicateSelected() {
    const l = this.selected;
    if (!l) return;
    const copy = { ...l, id: uid(), x: l.x + 24, y: l.y + 24 };
    this.state.layers.push(copy);
    this.select(copy);
    this.changed();
  }

  moveSelected(dir) {
    const l = this.selected;
    if (!l) return;
    const arr = this.state.layers;
    const i = arr.indexOf(l);
    const j = clamp(i + dir, 0, arr.length - 1);
    arr.splice(i, 1);
    arr.splice(j, 0, l);
    this.changed();
  }

  setFilters(filters) {
    Object.assign(this.state.filters, filters);
    for (const l of this.state.layers) {
      if (l.type === 'image') l.canvas = adjustColors(l.source, this.state.filters);
    }
    this.changed();
  }

  // ---------- geometría ----------

  _font(layer) {
    if (layer.type === 'emoji') return `${layer.fontSize}px ${EMOJI_FONT}`;
    const f = FONTS[layer.font] || FONTS[0];
    return `${f.weight} ${layer.fontSize}px ${f.css}`;
  }

  _textMetrics(layer) {
    const g = this.ctx;
    g.save();
    g.font = this._font(layer);
    const lines = String(layer.text || ' ').split('\n');
    const lh = layer.fontSize * 1.12;
    let w = 0;
    for (const ln of lines) w = Math.max(w, g.measureText(ln).width);
    g.restore();
    const pad = layer.type === 'text' ? layer.strokeWidth : 0;
    return { lines, lh, w: w + pad * 2, h: lines.length * lh + pad * 2 };
  }

  layerHalf(layer, scale = layer.scale) {
    if (layer.type === 'image') return { hw: (layer.w / 2) * scale, hh: (layer.h / 2) * scale };
    const m = this._textMetrics(layer);
    return { hw: (m.w / 2) * scale, hh: (m.h / 2) * scale };
  }

  layerCorners(layer) {
    const { hw, hh } = this.layerHalf(layer);
    const c = Math.cos(layer.rotation), s = Math.sin(layer.rotation);
    return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => ({
      x: layer.x + x * c - y * s, y: layer.y + x * s + y * c,
    }));
  }

  hitTest(p) {
    for (let i = this.state.layers.length - 1; i >= 0; i--) {
      const l = this.state.layers[i];
      const { hw, hh } = this.layerHalf(l);
      const dx = p.x - l.x, dy = p.y - l.y;
      const c = Math.cos(-l.rotation), s = Math.sin(-l.rotation);
      const lx = dx * c - dy * s, ly = dx * s + dy * c;
      const slop = 10 * this.k;
      if (Math.abs(lx) <= hw + slop && Math.abs(ly) <= hh + slop) return l;
    }
    return null;
  }

  handlePos(layer) {
    return this.layerCorners(layer)[2];
  }

  // ---------- render ----------

  drawLayer(g, l) {
    g.save();
    g.translate(l.x, l.y);
    g.rotate(l.rotation);
    g.scale(l.scale * (l.flipX ? -1 : 1), l.scale * (l.flipY ? -1 : 1));
    if (l.type === 'image') {
      g.imageSmoothingQuality = 'high';
      g.drawImage(l.canvas, -l.w / 2, -l.h / 2, l.w, l.h);
    } else {
      const m = this._textMetrics(l);
      g.font = this._font(l);
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.lineJoin = 'round';
      g.miterLimit = 2;
      m.lines.forEach((ln, i) => {
        const y = (i - (m.lines.length - 1) / 2) * m.lh;
        if (l.type === 'text' && l.strokeWidth > 0) {
          g.lineWidth = l.strokeWidth * 2;
          g.strokeStyle = l.stroke;
          g.strokeText(ln, 0, y);
        }
        g.fillStyle = l.type === 'text' ? l.color : '#000';
        g.fillText(ln, 0, y);
      });
    }
    g.restore();
  }

  /** Dibuja el sticker final (512×512) en `this.out` y lo devuelve. */
  renderOutput() {
    const st = this.state;
    const cg = ctx2d(this.content);
    cg.clearRect(0, 0, SIZE, SIZE);
    for (const l of st.layers) this.drawLayer(cg, l);

    let comp = this.content;
    if (st.border.on && st.border.width > 0) {
      comp = outlineCanvas(this.content, st.border.width, st.border.color);
      ctx2d(comp).drawImage(this.content, 0, 0);
    }
    const og = ctx2d(this.out);
    og.save();
    og.clearRect(0, 0, SIZE, SIZE);
    if (st.bg) {
      og.fillStyle = st.bg;
      og.fillRect(0, 0, SIZE, SIZE);
    }
    if (st.shadow.on) {
      og.shadowColor = `rgba(0,0,0,${st.shadow.opacity})`;
      og.shadowBlur = st.shadow.blur;
      og.shadowOffsetX = st.shadow.offset * 0.5;
      og.shadowOffsetY = st.shadow.offset;
    }
    og.drawImage(comp, 0, 0);
    og.restore();
    return this.out;
  }

  resize() {
    const parent = this.canvas.parentElement;
    const size = Math.floor(Math.min(parent.clientWidth, parent.clientHeight) - 24);
    if (size <= 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.dpr = dpr;
    this.css = size;
    this.k = SIZE / size; // unidades de sticker por px CSS
    this.canvas.width = Math.round(size * dpr);
    this.canvas.height = Math.round(size * dpr);
    this.canvas.style.width = size + 'px';
    this.canvas.style.height = size + 'px';
    this.requestRender();
  }

  requestRender() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.render(); });
  }

  render() {
    if (!this.css) return;
    const out = this.renderOutput();
    const g = this.ctx;
    const scale = (this.css * this.dpr) / SIZE;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    g.imageSmoothingQuality = 'high';
    g.drawImage(out, 0, 0, this.canvas.width, this.canvas.height);
    g.setTransform(scale, 0, 0, scale, 0, 0);
    const lw = this.k;
    if (this.state.showGuide) {
      g.setLineDash([4 * lw, 4 * lw]);
      g.lineWidth = lw;
      g.strokeStyle = 'rgba(18,140,126,0.45)';
      g.strokeRect(MARGIN, MARGIN, SIZE - MARGIN * 2, SIZE - MARGIN * 2);
      g.setLineDash([]);
    }
    const sel = this.selected;
    if (sel) {
      const pts = this.layerCorners(sel);
      g.beginPath();
      pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
      g.closePath();
      g.lineWidth = 2.5 * lw;
      g.strokeStyle = 'rgba(0,0,0,0.5)';
      g.stroke();
      g.lineWidth = 1.2 * lw;
      g.setLineDash([5 * lw, 4 * lw]);
      g.strokeStyle = '#fff';
      g.stroke();
      g.setLineDash([]);
      const h = this.handlePos(sel);
      g.beginPath();
      g.arc(h.x, h.y, HANDLE_R * 0.7 * lw, 0, Math.PI * 2);
      g.fillStyle = '#128c7e';
      g.fill();
      g.lineWidth = 2 * lw;
      g.strokeStyle = '#fff';
      g.stroke();
      // Flechas de rotación/escala
      g.beginPath();
      g.arc(h.x, h.y, HANDLE_R * 0.35 * lw, -Math.PI * 0.9, Math.PI * 0.4);
      g.lineWidth = 1.6 * lw;
      g.stroke();
    }
    if (this.drag?.snapX) {
      g.strokeStyle = '#ff2d78'; g.lineWidth = lw;
      g.beginPath(); g.moveTo(SIZE / 2, 0); g.lineTo(SIZE / 2, SIZE); g.stroke();
    }
    if (this.drag?.snapY) {
      g.strokeStyle = '#ff2d78'; g.lineWidth = lw;
      g.beginPath(); g.moveTo(0, SIZE / 2); g.lineTo(SIZE, SIZE / 2); g.stroke();
    }
  }

  // ---------- interacción ----------

  _pt(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) * this.k, y: (e.clientY - r.top) * this.k };
  }

  _bind() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this._down(e));
    c.addEventListener('pointermove', (e) => this._move(e));
    c.addEventListener('pointerup', (e) => this._up(e));
    c.addEventListener('pointercancel', (e) => this._up(e));
    c.addEventListener('dblclick', (e) => {
      const l = this.hitTest(this._pt(e));
      if (l && l.type === 'text') this.onSelect(l, { edit: true });
    });
    c.addEventListener('wheel', (e) => {
      const l = this.selected;
      if (!l) return;
      e.preventDefault();
      if (e.shiftKey) l.rotation += e.deltaY * 0.003;
      else l.scale = clamp(l.scale * Math.exp(-e.deltaY * 0.0015), 0.05, 20);
      this.changed();
      this.onSelect(l, { silent: true });
    }, { passive: false });
  }

  _down(e) {
    this.canvas.setPointerCapture(e.pointerId);
    const p = this._pt(e);
    this.pointers.set(e.pointerId, p);
    const sel = this.selected;
    if (this.pointers.size === 2 && sel) {
      const [a, b] = [...this.pointers.values()];
      this.drag = {
        type: 'pinch', layer: sel, dist: Math.hypot(b.x - a.x, b.y - a.y) || 1,
        angle: Math.atan2(b.y - a.y, b.x - a.x), scale: sel.scale, rotation: sel.rotation,
        mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, x: sel.x, y: sel.y,
      };
      return;
    }
    if (this.pointers.size > 1) return;
    if (sel) {
      const h = this.handlePos(sel);
      if (Math.hypot(p.x - h.x, p.y - h.y) < HANDLE_R * 1.4 * this.k) {
        this.drag = {
          type: 'handle', layer: sel, scale: sel.scale, rotation: sel.rotation,
          dist: Math.hypot(p.x - sel.x, p.y - sel.y) || 1, angle: Math.atan2(p.y - sel.y, p.x - sel.x),
        };
        return;
      }
    }
    const hit = this.hitTest(p);
    if (hit !== sel) this.select(hit);
    if (hit) this.drag = { type: 'move', layer: hit, dx: p.x - hit.x, dy: p.y - hit.y };
  }

  _move(e) {
    if (!this.pointers.has(e.pointerId)) return;
    const p = this._pt(e);
    this.pointers.set(e.pointerId, p);
    const d = this.drag;
    if (!d) return;
    const l = d.layer;
    if (d.type === 'move') {
      let x = p.x - d.dx, y = p.y - d.dy;
      d.snapX = Math.abs(x - SIZE / 2) < 6;
      d.snapY = Math.abs(y - SIZE / 2) < 6;
      if (d.snapX) x = SIZE / 2;
      if (d.snapY) y = SIZE / 2;
      l.x = x; l.y = y;
    } else if (d.type === 'handle') {
      const dist = Math.hypot(p.x - l.x, p.y - l.y);
      const ang = Math.atan2(p.y - l.y, p.x - l.x);
      l.scale = clamp(d.scale * dist / d.dist, 0.05, 20);
      l.rotation = snapAngle(d.rotation + ang - d.angle);
    } else if (d.type === 'pinch') {
      const [a, b] = [...this.pointers.values()];
      if (!a || !b) return;
      const dist = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      l.scale = clamp(d.scale * dist / d.dist, 0.05, 20);
      l.rotation = snapAngle(d.rotation + ang - d.angle);
      l.x = d.x + mid.x - d.mid.x;
      l.y = d.y + mid.y - d.mid.y;
    }
    this.changed();
    this.onSelect(l, { silent: true });
  }

  _up(e) {
    this.pointers.delete(e.pointerId);
    if (this.drag?.type === 'pinch' && this.pointers.size === 1) {
      this.drag = null; // evita saltos al levantar un dedo
      return;
    }
    if (this.pointers.size === 0) {
      this.drag = null;
      this.requestRender();
    }
  }
}

function snapAngle(a) {
  const step = Math.PI / 2;
  const nearest = Math.round(a / step) * step;
  return Math.abs(a - nearest) < 0.05 ? nearest : a;
}
