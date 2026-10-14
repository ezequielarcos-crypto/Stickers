// Funciones de IA cargadas bajo demanda desde CDN (no pesan hasta que se usan).
//  - Quitar fondo automático: @imgly/background-removal (modelo ISNet, corre en el navegador).
//  - Lazo automático (tocar un objeto): MediaPipe Interactive Segmenter ("Magic Touch").

import { canvasToBlob, makeCanvas, ctx2d } from './util.js';

const IMGLY_URL = 'https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.7.0/+esm';
const MP_VERSION = '0.10.21';
const MP_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/vision_bundle.mjs`;
const MP_WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`;
const MAGIC_TOUCH_MODEL =
  'https://storage.googleapis.com/mediapipe-models/interactive_segmenter/magic_touch/float32/1/magic_touch.tflite';

let imglyPromise;
const bgCache = new WeakMap();

/** Devuelve un canvas del mismo tamaño cuyo alfa marca el sujeto principal. */
export async function removeBackground(canvas, onProgress) {
  if (bgCache.has(canvas)) return bgCache.get(canvas);
  imglyPromise ??= import(IMGLY_URL).catch((e) => { imglyPromise = null; throw e; });
  const mod = await imglyPromise;
  const blob = await canvasToBlob(canvas, 'image/png');
  const result = await mod.removeBackground(blob, {
    progress: (key, current, total) => {
      if (total) onProgress?.(key.startsWith('fetch') ? 'Descargando modelo de IA…' : 'Procesando…', current / total);
    },
    output: { format: 'image/png' },
  });
  onProgress?.('Aplicando…', 1);
  const bmp = await createImageBitmap(result);
  const out = makeCanvas(canvas.width, canvas.height);
  ctx2d(out).drawImage(bmp, 0, 0, out.width, out.height);
  bmp.close?.();
  bgCache.set(canvas, out);
  return out;
}

let segmenterPromise;

async function createSegmenter() {
  const { FilesetResolver, InteractiveSegmenter } = await import(MP_URL);
  const fileset = await FilesetResolver.forVisionTasks(MP_WASM);
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: MAGIC_TOUCH_MODEL, delegate },
    outputCategoryMask: false,
    outputConfidenceMasks: true,
  });
  try {
    return await InteractiveSegmenter.createFromOptions(fileset, options('GPU'));
  } catch {
    return await InteractiveSegmenter.createFromOptions(fileset, options('CPU'));
  }
}

export function isSegmenterLoaded() {
  return !!segmenterPromise;
}

/**
 * Segmenta el objeto que hay en el punto normalizado (nx, ny) ∈ [0,1].
 * Devuelve un canvas del tamaño de `canvas` con el objeto en el alfa.
 */
export async function segmentAtPoint(canvas, nx, ny) {
  segmenterPromise ??= createSegmenter().catch((e) => { segmenterPromise = null; throw e; });
  const segmenter = await segmenterPromise;
  const { alpha, width, height } = await new Promise((resolve, reject) => {
    try {
      segmenter.segment(canvas, { keypoint: { x: nx, y: ny } }, (result) => {
        try {
          const masks = result.confidenceMasks || [];
          if (!masks.length) throw new Error('La IA no devolvió máscara');
          const w = masks[0].width, h = masks[0].height;
          const px = Math.min(w - 1, Math.floor(nx * w)) + Math.min(h - 1, Math.floor(ny * h)) * w;
          // Elegimos la máscara con mayor confianza en el punto tocado.
          let best = null, bestVal = -1;
          for (const m of masks) {
            const data = m.getAsFloat32Array();
            if (data[px] > bestVal) { bestVal = data[px]; best = data; }
          }
          const invert = masks.length === 1 && bestVal < 0.5;
          const a = new Uint8ClampedArray(w * h);
          for (let i = 0; i < a.length; i++) a[i] = (invert ? 1 - best[i] : best[i]) * 255;
          resolve({ alpha: a, width: w, height: h });
        } catch (e) { reject(e); }
      });
    } catch (e) { reject(e); }
  });
  const small = makeCanvas(width, height);
  const img = new ImageData(width, height);
  for (let i = 0, j = 0; i < alpha.length; i++, j += 4) {
    img.data[j] = img.data[j + 1] = img.data[j + 2] = 255;
    img.data[j + 3] = alpha[i];
  }
  ctx2d(small).putImageData(img, 0, 0);
  const out = makeCanvas(canvas.width, canvas.height);
  const g = ctx2d(out);
  g.imageSmoothingQuality = 'high';
  g.drawImage(small, 0, 0, out.width, out.height);
  return out;
}
