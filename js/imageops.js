// Operaciones de píxeles: canal alfa, varita mágica, distancias, bordes y ajustes.

import { makeCanvas, ctx2d, clamp } from './util.js';

const INF = 1e20;

export function getAlpha(canvas) {
  const { width: w, height: h } = canvas;
  const data = ctx2d(canvas, { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const a = new Uint8ClampedArray(w * h);
  for (let i = 0, j = 3; i < a.length; i++, j += 4) a[i] = data[j];
  return a;
}

/** Escribe un canal alfa en un canvas blanco (o del color dado). */
export function putAlpha(canvas, alpha, rgb = [255, 255, 255]) {
  const { width: w, height: h } = canvas;
  const img = new ImageData(w, h);
  const d = img.data;
  const [r, g, b] = rgb;
  for (let i = 0, j = 0; i < alpha.length; i++, j += 4) {
    d[j] = r; d[j + 1] = g; d[j + 2] = b; d[j + 3] = alpha[i];
  }
  ctx2d(canvas).putImageData(img, 0, 0);
}

export function alphaToCanvas(alpha, w, h, rgb) {
  const c = makeCanvas(w, h);
  putAlpha(c, alpha, rgb);
  return c;
}

/** Caja que contiene los píxeles con alfa > threshold. Devuelve null si está vacío. */
export function alphaBounds(alpha, w, h, threshold = 8) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (alpha[row + x] > threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// --- Transformada de distancia euclídea (Felzenszwalb & Huttenlocher) ---

function edt1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0; z[0] = -INF; z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q; z[k] = s; z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

/** Distancia (en píxeles) de cada píxel al píxel "semilla" más cercano. */
export function distanceField(isSeed, w, h) {
  const grid = new Float64Array(w * h);
  for (let i = 0; i < grid.length; i++) grid[i] = isSeed[i] ? 0 : INF;
  const n = Math.max(w, h);
  const f = new Float64Array(n), d = new Float64Array(n);
  const v = new Int32Array(n), z = new Float64Array(n + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) f[x] = grid[row + x];
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) grid[row + x] = d[x];
  }
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = Math.sqrt(grid[i]);
  return out;
}

/** Expande (delta > 0) o contrae (delta < 0) una máscara alfa, con bordes suaves. */
export function offsetAlpha(alpha, w, h, delta) {
  const out = new Uint8ClampedArray(alpha.length);
  if (delta > 0) {
    const seed = new Uint8Array(alpha.length);
    for (let i = 0; i < alpha.length; i++) seed[i] = alpha[i] >= 128 ? 1 : 0;
    const dist = distanceField(seed, w, h);
    for (let i = 0; i < alpha.length; i++) {
      const grown = clamp(delta + 0.5 - dist[i], 0, 1) * 255;
      out[i] = Math.max(alpha[i], grown);
    }
  } else {
    const k = -delta;
    const seed = new Uint8Array(alpha.length);
    for (let i = 0; i < alpha.length; i++) seed[i] = alpha[i] < 128 ? 1 : 0;
    const dist = distanceField(seed, w, h);
    for (let i = 0; i < alpha.length; i++) {
      out[i] = Math.min(alpha[i], clamp(dist[i] - k, 0, 1) * 255);
    }
  }
  return out;
}

/** Desenfoque de caja separable aplicado dos veces (aprox. gaussiano). */
export function blurAlpha(alpha, w, h, r) {
  r = Math.max(1, Math.round(r));
  let a = Float32Array.from(alpha);
  let b = new Float32Array(a.length);
  const pass = (src, dst, horizontal) => {
    const len = horizontal ? w : h, lines = horizontal ? h : w;
    const stride = horizontal ? 1 : w, lineStride = horizontal ? w : 1;
    const norm = 1 / (2 * r + 1);
    for (let l = 0; l < lines; l++) {
      const base = l * lineStride;
      let acc = 0;
      for (let i = -r; i <= r; i++) acc += src[base + clamp(i, 0, len - 1) * stride];
      for (let i = 0; i < len; i++) {
        dst[base + i * stride] = acc * norm;
        acc += src[base + clamp(i + r + 1, 0, len - 1) * stride] - src[base + clamp(i - r, 0, len - 1) * stride];
      }
    }
  };
  for (let it = 0; it < 2; it++) {
    pass(a, b, true); pass(b, a, false);
  }
  return Uint8ClampedArray.from(a);
}

/**
 * Varita mágica: selecciona píxeles de color parecido al del punto (sx, sy).
 * tolerance: 0..100. Devuelve alfa 0/255 (con borde de 1px suavizado).
 */
export function floodSelect(imageData, sx, sy, tolerance, contiguous = true) {
  const { width: w, height: h, data } = imageData;
  sx = clamp(Math.floor(sx), 0, w - 1);
  sy = clamp(Math.floor(sy), 0, h - 1);
  const t = tolerance * 2.55;
  const p0 = (sy * w + sx) * 4;
  const r0 = data[p0], g0 = data[p0 + 1], b0 = data[p0 + 2], a0 = data[p0 + 3];
  const out = new Uint8ClampedArray(w * h);
  const match = (i) => {
    const p = i * 4;
    // Los píxeles transparentes se parecen entre sí sin importar su color.
    if (a0 < 16) return data[p + 3] < 16 + t;
    return Math.abs(data[p] - r0) <= t && Math.abs(data[p + 1] - g0) <= t &&
      Math.abs(data[p + 2] - b0) <= t && Math.abs(data[p + 3] - a0) <= t;
  };
  if (!contiguous) {
    for (let i = 0; i < out.length; i++) if (match(i)) out[i] = 255;
  } else {
    const stack = new Int32Array(w * h);
    let sp = 0;
    stack[sp++] = sy * w + sx;
    out[sy * w + sx] = 255;
    while (sp > 0) {
      const i = stack[--sp];
      const x = i % w, y = (i / w) | 0;
      if (x > 0 && !out[i - 1] && match(i - 1)) { out[i - 1] = 255; stack[sp++] = i - 1; }
      if (x < w - 1 && !out[i + 1] && match(i + 1)) { out[i + 1] = 255; stack[sp++] = i + 1; }
      if (y > 0 && !out[i - w] && match(i - w)) { out[i - w] = 255; stack[sp++] = i - w; }
      if (y < h - 1 && !out[i + w] && match(i + w)) { out[i + w] = 255; stack[sp++] = i + w; }
    }
  }
  // Expande 1px suave para cubrir el antialiasing del borde original.
  return offsetAlpha(out, w, h, 1);
}

/** Genera la silueta expandida (borde) de un canvas como un canvas del color pedido. */
export function outlineCanvas(content, width, color) {
  const w = content.width, h = content.height;
  const alpha = getAlpha(content);
  const grown = offsetAlpha(alpha, w, h, width);
  return alphaToCanvas(grown, w, h, hexToRgb(color));
}

export function hexToRgb(hex) {
  let s = hex.replace('#', '');
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  const n = parseInt(s, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Ajustes de color sin depender de ctx.filter (Safari no lo soporta bien).
 * brightness, contrast, saturation: -100..100. warmth: -100..100.
 */
export function adjustColors(src, { brightness = 0, contrast = 0, saturation = 0, warmth = 0 }) {
  const out = makeCanvas(src.width, src.height);
  const g = ctx2d(out, { willReadFrequently: true });
  g.drawImage(src, 0, 0);
  if (!brightness && !contrast && !saturation && !warmth) return out;
  const img = g.getImageData(0, 0, out.width, out.height);
  const d = img.data;
  const b = brightness * 1.28;
  const c = (contrast + 100) / 100;
  const cf = c * c;
  const s = 1 + saturation / 100;
  const wr = warmth * 0.3, wb = -warmth * 0.3;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    let r = d[i] + b, gg = d[i + 1] + b, bl = d[i + 2] + b;
    r = (r - 128) * cf + 128; gg = (gg - 128) * cf + 128; bl = (bl - 128) * cf + 128;
    const l = 0.299 * r + 0.587 * gg + 0.114 * bl;
    r = l + (r - l) * s; gg = l + (gg - l) * s; bl = l + (bl - l) * s;
    d[i] = r + wr; d[i + 1] = gg; d[i + 2] = bl + wb;
  }
  g.putImageData(img, 0, 0);
  return out;
}
