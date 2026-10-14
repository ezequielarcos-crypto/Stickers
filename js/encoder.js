// Codificación a WebP respetando los límites de WhatsApp:
//   sticker estático: 512×512, WebP, ≤ 100 KB · ícono de bandeja: 96×96, PNG, ≤ 50 KB.

import { canvasToBlob, makeCanvas, ctx2d } from './util.js';

export const MAX_STICKER_BYTES = 100 * 1024;
export const MAX_TRAY_BYTES = 50 * 1024;

const JSQUASH = 'https://cdn.jsdelivr.net/npm/@jsquash/webp@1.5.0';
const QUALITIES = [0.95, 0.9, 0.84, 0.78, 0.7, 0.62, 0.54, 0.45, 0.36, 0.28, 0.2];

let nativeWebP;
export function canEncodeWebPNatively() {
  if (nativeWebP === undefined) {
    const c = makeCanvas(2, 2);
    nativeWebP = c.toDataURL('image/webp').startsWith('data:image/webp');
  }
  return nativeWebP;
}

let jsquashPromise;
async function loadJsquash() {
  jsquashPromise ??= (async () => {
    const mod = await import(`${JSQUASH}/encode.js/+esm`);
    await mod.init(undefined, { locateFile: (file) => `${JSQUASH}/codec/enc/${file}` });
    return mod.default;
  })().catch((e) => { jsquashPromise = null; throw e; });
  return jsquashPromise;
}

/** Devuelve { blob, quality } con el WebP más fiel que no supere `maxBytes`. */
export async function encodeWebP(canvas, maxBytes = MAX_STICKER_BYTES) {
  let encode;
  if (canEncodeWebPNatively()) {
    encode = async (q) => {
      const blob = await canvasToBlob(canvas, 'image/webp', q);
      if (blob.type !== 'image/webp') throw new Error('WebP no soportado');
      return blob;
    };
  } else {
    // Safari (iOS/macOS) no codifica WebP desde canvas: usamos libwebp compilado a WASM.
    const jsq = await loadJsquash();
    const data = ctx2d(canvas, { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
    encode = async (q) => new Blob([await jsq(data, { quality: Math.round(q * 100), alpha_quality: 100, method: 4 })], { type: 'image/webp' });
  }
  let last;
  for (const q of QUALITIES) {
    last = { blob: await encode(q), quality: q };
    if (last.blob.size <= maxBytes) return last;
  }
  return last;
}

export async function makeTrayIcon(sourceBlobOrCanvas) {
  let src = sourceBlobOrCanvas;
  if (src instanceof Blob) src = await createImageBitmap(src);
  const c = makeCanvas(96, 96);
  const g = ctx2d(c);
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, 96, 96);
  src.close?.();
  return canvasToBlob(c, 'image/png');
}

export async function blobToPng(blob, size = 512) {
  const bmp = await createImageBitmap(blob);
  const c = makeCanvas(size, size);
  ctx2d(c).drawImage(bmp, 0, 0, size, size);
  bmp.close?.();
  return canvasToBlob(c, 'image/png');
}
