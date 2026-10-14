// Editor de recorte: imagen original + máscara (alfa) editable con varias herramientas.

import { clamp, makeCanvas, ctx2d, checkerPattern } from './util.js';
import { getAlpha, putAlpha, floodSelect, offsetAlpha, blurAlpha, alphaBounds } from './imageops.js';
import * as ai from './ai.js';

const MAX_HISTORY = 30;
const BRUSH_OFFSET = 70; // px de pantalla por encima del dedo
const CLOSE_DIST = 14;   // px de pantalla para cerrar el polígono

export const TOOLS = ['pan', 'lasso', 'polygon', 'rect', 'ellipse', 'wand', 'aiobject', 'erase', 'restore'];

export class Cutter {
  constructor(canvas, { onChange, onBusy, onPolygon, onError } = {}) {
    this.canvas = canvas;
    this.ctx = ctx2d(canvas);
    this.onChange = onChange || (() => {});
    this.onError = onError || ((e) => console.error(e));
    this.onBusy = onBusy || (() => {});
    this.onPolygon = onPolygon || (() => {});
    this.src = null;
    this.view = { scale: 1, x: 0, y: 0 };
    this.tool = 'lasso';
    this.modes = { lasso: 'keep', polygon: 'keep', rect: 'keep', ellipse: 'keep', wand: 'erase', aiobject: 'keep' };
    this.settings = { brushSize: 32, brushOffset: false, tolerance: 30, contiguous: true, showRemoved: false };
    this.pointers = new Map();
    this.gesture = null;
    this.gestureLock = false;
    this.stroke = null;
    this.poly = [];
    this.hover = null;
    this.undoStack = [];
    this.redoStack = [];
    this.busy = false;
    this._raf = 0;
    this._bind();
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
  }

  // ---------- carga y estado ----------

  load(sourceCanvas) {
    this.src = sourceCanvas;
    const { width: w, height: h } = sourceCanvas;
    this.W = w; this.H = h;
    this.srcData = ctx2d(sourceCanvas, { willReadFrequently: true }).getImageData(0, 0, w, h);
    this.mask = makeCanvas(w, h);
    const m = ctx2d(this.mask, { willReadFrequently: true });
    m.fillStyle = '#fff';
    m.fillRect(0, 0, w, h);
    this.cut = makeCanvas(w, h);
    ctx2d(this.cut, { willReadFrequently: true });
    this.sel = makeCanvas(w, h);
    this.undoStack = [];
    this.redoStack = [];
    this.poly = [];
    this.stroke = null;
    this.resize();
    this.fit();
    this.maskChanged();
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  setTool(tool) {
    if (this.tool === 'polygon' && tool !== 'polygon') this.cancelPolygon();
    this.tool = tool;
    this.stroke = null;
    this.canvas.dataset.tool = tool;
    this.requestRender();
  }

  setMode(tool, mode) { this.modes[tool] = mode; }

  pushHistory() {
    this.undoStack.push(getAlpha(this.mask));
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack = [];
  }

  undo() {
    if (!this.canUndo) return;
    this.redoStack.push(getAlpha(this.mask));
    putAlpha(this.mask, this.undoStack.pop());
    this.maskChanged();
  }

  redo() {
    if (!this.canRedo) return;
    this.undoStack.push(getAlpha(this.mask));
    putAlpha(this.mask, this.redoStack.pop());
    this.maskChanged();
  }

  maskChanged() {
    const g = ctx2d(this.cut);
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, this.W, this.H);
    g.drawImage(this.src, 0, 0);
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(this.mask, 0, 0);
    g.globalCompositeOperation = 'source-over';
    this.requestRender();
    this.onChange();
  }

  /** Combina una selección (alfa del canvas `sel`) con la máscara. */
  applySelection(sel, mode) {
    this.pushHistory();
    const m = ctx2d(this.mask);
    m.save();
    m.globalCompositeOperation = mode === 'keep' ? 'destination-in' : mode === 'erase' ? 'destination-out' : 'source-over';
    m.drawImage(sel, 0, 0, this.W, this.H);
    m.restore();
    this.maskChanged();
  }

  applyPath(buildPath, mode) {
    const g = ctx2d(this.sel);
    g.clearRect(0, 0, this.W, this.H);
    g.fillStyle = '#fff';
    g.beginPath();
    buildPath(g);
    g.fill();
    this.applySelection(this.sel, mode);
  }

  applyAlpha(alpha) {
    this.pushHistory();
    putAlpha(this.mask, alpha);
    this.maskChanged();
  }

  // ---------- acciones globales ----------

  invert() {
    const alpha = getAlpha(this.mask);
    for (let i = 0; i < alpha.length; i++) alpha[i] = 255 - alpha[i];
    this.applyAlpha(alpha);
  }

  reset() {
    this.applyAlpha(new Uint8ClampedArray(this.W * this.H).fill(255));
  }

  feather(radius = 2) {
    this.applyAlpha(blurAlpha(getAlpha(this.mask), this.W, this.H, radius));
  }

  grow(delta) {
    this.applyAlpha(offsetAlpha(getAlpha(this.mask), this.W, this.H, delta));
  }

  isEmpty() {
    return !alphaBounds(getAlpha(this.mask), this.W, this.H, 8);
  }

  /** Devuelve el recorte final ajustado a su contenido. */
  exportCutout() {
    const alpha = getAlpha(this.cut);
    const b = alphaBounds(alpha, this.W, this.H, 8);
    if (!b) return null;
    const out = makeCanvas(b.w, b.h);
    ctx2d(out).drawImage(this.cut, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
    return out;
  }

  async runBusy(label, fn) {
    if (this.busy) return;
    this.busy = true;
    this.onBusy(true, label, null);
    try {
      return await fn((text, progress) => this.onBusy(true, text, progress));
    } finally {
      this.busy = false;
      this.onBusy(false);
    }
  }

  async autoRemoveBackground() {
    await this.runBusy('Cargando IA para quitar el fondo…', async (progress) => {
      const fg = await ai.removeBackground(this.src, progress);
      this.applySelection(fg, 'keep');
    });
  }

  async selectObjectAt(p) {
    const label = ai.isSegmenterLoaded() ? 'Detectando objeto…' : 'Cargando IA (solo la primera vez)…';
    await this.runBusy(label, async () => {
      const sel = await ai.segmentAtPoint(this.src, clamp(p.x / this.W, 0, 1), clamp(p.y / this.H, 0, 1));
      this.applySelection(sel, this.modes.aiobject);
    });
  }

  magicWand(p) {
    if (p.x < 0 || p.y < 0 || p.x >= this.W || p.y >= this.H) return;
    const alpha = floodSelect(this.srcData, p.x, p.y, this.settings.tolerance, this.settings.contiguous);
    putAlpha(this.sel, alpha);
    this.applySelection(this.sel, this.modes.wand);
  }

  // ---------- polígono ----------

  closePolygon() {
    if (this.poly.length < 3) return;
    const pts = this.poly;
    this.poly = [];
    this.applyPath((g) => {
      g.moveTo(pts[0].x, pts[0].y);
      for (const p of pts.slice(1)) g.lineTo(p.x, p.y);
      g.closePath();
    }, this.modes.polygon);
    this.onPolygon(0);
  }

  undoPolygonPoint() {
    this.poly.pop();
    this.onPolygon(this.poly.length);
    this.requestRender();
  }

  cancelPolygon() {
    this.poly = [];
    this.onPolygon(0);
    this.requestRender();
  }

  // ---------- vista ----------

  resize() {
    const parent = this.canvas.parentElement;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = parent.clientWidth, h = parent.clientHeight;
    if (!w || !h) return;
    const first = !this.cssW;
    this.dpr = dpr;
    this.cssW = w; this.cssH = h;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.checker = checkerPattern(this.ctx, Math.round(9 * dpr));
    // Mientras el usuario no haya hecho zoom, la imagen se reencuadra al cambiar el tamaño.
    if ((first || this.autoFit) && this.src) this.fit();
    this.requestRender();
  }

  fit() {
    if (!this.src || !this.cssW) return;
    const pad = 16;
    const s = Math.min((this.cssW - pad * 2) / this.W, (this.cssH - pad * 2) / this.H);
    this.view.scale = s;
    this.view.x = (this.cssW - this.W * s) / 2;
    this.view.y = (this.cssH - this.H * s) / 2;
    this.autoFit = true;
    this.requestRender();
  }

  zoomAt(sx, sy, factor) {
    const v = this.view;
    const ns = clamp(v.scale * factor, 0.05, 40);
    const k = ns / v.scale;
    v.x = sx - (sx - v.x) * k;
    v.y = sy - (sy - v.y) * k;
    v.scale = ns;
    this.autoFit = false;
    this.requestRender();
  }

  toImage(sp) {
    return { x: (sp.x - this.view.x) / this.view.scale, y: (sp.y - this.view.y) / this.view.scale };
  }

  // ---------- puntero ----------

  _bind() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this._down(e));
    c.addEventListener('pointermove', (e) => this._move(e));
    c.addEventListener('pointerup', (e) => this._up(e, false));
    c.addEventListener('pointercancel', (e) => this._up(e, true));
    c.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse' && !this.stroke) { this.hover = null; this.requestRender(); }
    });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('dblclick', () => { if (this.tool === 'polygon') this.closePolygon(); });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = this._pt(e);
      if (e.ctrlKey || e.metaKey || !e.deltaX) this.zoomAt(p.x, p.y, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
      else { this.view.x -= e.deltaX; this.view.y -= e.deltaY; this.autoFit = false; this.requestRender(); }
    }, { passive: false });
  }

  _pt(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  _brushPoint(sp, e) {
    if (this.settings.brushOffset && e.pointerType !== 'mouse') return { x: sp.x, y: sp.y - BRUSH_OFFSET };
    return sp;
  }

  _down(e) {
    if (!this.src || this.busy) return;
    this.canvas.setPointerCapture(e.pointerId);
    const sp = this._pt(e);
    this.pointers.set(e.pointerId, sp);
    if (this.pointers.size === 2) {
      this._cancelStroke();
      this._startGesture();
      return;
    }
    if (this.pointers.size > 2 || this.gestureLock) return;
    const ip = this.toImage(sp);
    if (this.tool === 'pan' || e.button === 1 || e.button === 2) {
      this.stroke = { type: 'pan', last: sp };
      return;
    }
    switch (this.tool) {
      case 'lasso':
        this.stroke = { type: 'lasso', pts: [ip] };
        break;
      case 'rect':
      case 'ellipse':
        this.stroke = { type: 'shape', a: ip, b: ip };
        break;
      case 'polygon':
      case 'wand':
      case 'aiobject':
        this.stroke = { type: 'tap', start: sp };
        break;
      case 'erase':
      case 'restore': {
        this.pushHistory();
        const bp = this.toImage(this._brushPoint(sp, e));
        this.stroke = { type: 'brush', last: bp };
        this.hover = this._brushPoint(sp, e);
        this._brush(bp, bp);
        break;
      }
    }
    this.requestRender();
  }

  _move(e) {
    const sp = this._pt(e);
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, sp);
    if (this.gesture) { this._updateGesture(); return; }
    const isBrush = this.tool === 'erase' || this.tool === 'restore';
    this.hover = isBrush ? this._brushPoint(sp, e) : sp;
    const s = this.stroke;
    if (!s) { this.requestRender(); return; }
    const ip = this.toImage(sp);
    switch (s.type) {
      case 'pan':
        this.autoFit = false;
        this.view.x += sp.x - s.last.x;
        this.view.y += sp.y - s.last.y;
        s.last = sp;
        break;
      case 'lasso': {
        const last = s.pts[s.pts.length - 1];
        if (Math.hypot(ip.x - last.x, ip.y - last.y) * this.view.scale > 2) s.pts.push(ip);
        break;
      }
      case 'shape':
        s.b = ip;
        break;
      case 'brush': {
        const bp = this.toImage(this._brushPoint(sp, e));
        this._brush(s.last, bp);
        s.last = bp;
        break;
      }
    }
    this.requestRender();
  }

  _up(e, cancelled) {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    if (this.gesture) {
      if (this.pointers.size < 2) this.gesture = null;
      if (this.pointers.size === 0) this.gestureLock = false;
      return;
    }
    if (this.pointers.size === 0) this.gestureLock = false;
    const s = this.stroke;
    this.stroke = null;
    if (e.pointerType !== 'mouse') this.hover = null;
    if (!s || cancelled) { this.requestRender(); return; }
    const sp = this._pt(e);
    const ip = this.toImage(sp);
    switch (s.type) {
      case 'lasso':
        if (s.pts.length >= 3) {
          const pts = s.pts;
          this.applyPath((g) => {
            g.moveTo(pts[0].x, pts[0].y);
            for (const p of pts) g.lineTo(p.x, p.y);
            g.closePath();
          }, this.modes.lasso);
        }
        break;
      case 'shape': {
        const x = Math.min(s.a.x, s.b.x), y = Math.min(s.a.y, s.b.y);
        const w = Math.abs(s.b.x - s.a.x), h = Math.abs(s.b.y - s.a.y);
        if (w * this.view.scale > 4 && h * this.view.scale > 4) {
          this.applyPath((g) => {
            if (this.tool === 'rect') g.rect(x, y, w, h);
            else g.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
          }, this.modes[this.tool]);
        }
        break;
      }
      case 'tap':
        if (Math.hypot(sp.x - s.start.x, sp.y - s.start.y) > 12) break;
        if (this.tool === 'polygon') this._polygonTap(ip);
        else if (this.tool === 'wand') this.magicWand(ip);
        else if (this.tool === 'aiobject') this.selectObjectAt(ip).catch((err) => this.onError(err));
        break;
    }
    this.requestRender();
  }

  _polygonTap(ip) {
    const first = this.poly[0];
    if (first && this.poly.length >= 3) {
      const d = Math.hypot(ip.x - first.x, ip.y - first.y) * this.view.scale;
      if (d < CLOSE_DIST) { this.closePolygon(); return; }
    }
    this.poly.push(ip);
    this.onPolygon(this.poly.length);
  }

  _cancelStroke() {
    const s = this.stroke;
    this.stroke = null;
    if (s && s.type === 'brush' && this.undoStack.length) {
      // Revertimos el trazo que se empezó antes del segundo dedo.
      putAlpha(this.mask, this.undoStack.pop());
      this.maskChanged();
    }
  }

  _startGesture() {
    const [a, b] = [...this.pointers.values()];
    this.gestureLock = true;
    this.hover = null;
    this.gesture = {
      dist: Math.hypot(b.x - a.x, b.y - a.y) || 1,
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      view: { ...this.view },
    };
  }

  _updateGesture() {
    const g = this.gesture;
    const [a, b] = [...this.pointers.values()];
    if (!a || !b) return;
    const dist = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const scale = clamp(g.view.scale * dist / g.dist, 0.05, 40);
    const ix = (g.mid.x - g.view.x) / g.view.scale;
    const iy = (g.mid.y - g.view.y) / g.view.scale;
    this.autoFit = false;
    this.view.scale = scale;
    this.view.x = mid.x - ix * scale;
    this.view.y = mid.y - iy * scale;
    this.requestRender();
  }

  _brush(a, b) {
    const m = ctx2d(this.mask);
    const r = this.settings.brushSize / 2 / this.view.scale;
    m.save();
    m.globalCompositeOperation = this.tool === 'erase' ? 'destination-out' : 'source-over';
    m.fillStyle = m.strokeStyle = '#fff';
    m.lineCap = 'round';
    m.lineJoin = 'round';
    m.lineWidth = r * 2;
    m.beginPath();
    m.arc(b.x, b.y, r, 0, Math.PI * 2);
    m.fill();
    if (a !== b) {
      m.beginPath();
      m.moveTo(a.x, a.y);
      m.lineTo(b.x, b.y);
      m.stroke();
    }
    m.restore();
    this.maskChanged();
  }

  // ---------- render ----------

  requestRender() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.render(); });
  }

  render() {
    const { ctx, dpr } = this;
    if (!dpr) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.src) return;
    const v = this.view;
    // Cuadros de transparencia solo dentro del área de la imagen.
    ctx.fillStyle = this.checker;
    ctx.fillRect(Math.round(v.x * dpr), Math.round(v.y * dpr), Math.round(this.W * v.scale * dpr), Math.round(this.H * v.scale * dpr));
    ctx.setTransform(dpr * v.scale, 0, 0, dpr * v.scale, dpr * v.x, dpr * v.y);
    ctx.imageSmoothingEnabled = v.scale < 3;
    if (this.settings.showRemoved) {
      ctx.globalAlpha = 0.3;
      ctx.drawImage(this.src, 0, 0);
      ctx.globalAlpha = 1;
    }
    ctx.drawImage(this.cut, 0, 0);
    this._overlay(ctx);
  }

  _strokePath(ctx, fill = true) {
    const lw = 1 / this.view.scale;
    if (fill) {
      ctx.fillStyle = 'rgba(37, 211, 102, 0.18)';
      ctx.fill();
    }
    ctx.lineWidth = 3 * lw;
    ctx.strokeStyle = 'rgba(0,0,0,0.65)';
    ctx.setLineDash([]);
    ctx.stroke();
    ctx.lineWidth = 1.5 * lw;
    ctx.strokeStyle = '#fff';
    ctx.setLineDash([6 * lw, 4 * lw]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  _overlay(ctx) {
    const s = this.stroke;
    const lw = 1 / this.view.scale;
    if (s && s.type === 'lasso' && s.pts.length > 1) {
      ctx.beginPath();
      ctx.moveTo(s.pts[0].x, s.pts[0].y);
      for (const p of s.pts) ctx.lineTo(p.x, p.y);
      this._strokePath(ctx);
    }
    if (s && s.type === 'shape') {
      const x = Math.min(s.a.x, s.b.x), y = Math.min(s.a.y, s.b.y);
      const w = Math.abs(s.b.x - s.a.x), h = Math.abs(s.b.y - s.a.y);
      ctx.beginPath();
      if (this.tool === 'rect') ctx.rect(x, y, w, h);
      else ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      this._strokePath(ctx);
    }
    if (this.tool === 'polygon' && this.poly.length) {
      ctx.beginPath();
      ctx.moveTo(this.poly[0].x, this.poly[0].y);
      for (const p of this.poly) ctx.lineTo(p.x, p.y);
      if (this.hover) {
        const hp = this.toImage(this.hover);
        ctx.lineTo(hp.x, hp.y);
      }
      this._strokePath(ctx, this.poly.length > 2);
      this.poly.forEach((p, i) => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, (i === 0 ? 7 : 4.5) * lw, 0, Math.PI * 2);
        ctx.fillStyle = i === 0 ? '#25d366' : '#fff';
        ctx.fill();
        ctx.lineWidth = 1.5 * lw;
        ctx.strokeStyle = '#000';
        ctx.stroke();
      });
    }
    if ((this.tool === 'erase' || this.tool === 'restore') && this.hover) {
      const hp = this.toImage(this.hover);
      ctx.beginPath();
      ctx.arc(hp.x, hp.y, this.settings.brushSize / 2 / this.view.scale, 0, Math.PI * 2);
      ctx.lineWidth = 2.5 * lw;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.stroke();
      ctx.lineWidth = 1.2 * lw;
      ctx.strokeStyle = this.tool === 'erase' ? '#ff5a5f' : '#25d366';
      ctx.stroke();
    }
  }
}
