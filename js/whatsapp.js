// Exportación hacia WhatsApp.
//
// Un sitio web no puede instalar un paquete en WhatsApp por sí mismo (eso requiere una app
// nativa con el SDK de WhatsApp). Ofrecemos las vías que sí funcionan desde el navegador:
//   1. Compartir el .webp con la hoja de compartir del sistema. Ojo: WhatsApp para Android lo
//      recibe como imagen, no como sticker.
//   2. Descargar un paquete .wastickers (ZIP con title.txt, author.txt, tray.png y los .webp)
//      que se importa a WhatsApp con una app importadora de paquetes.
//   3. WhatsApp Web / Escritorio: arrastrar los .webp a un chat (deberían enviarse como stickers).

import { createZip } from './zip.js';
import { makeTrayIcon, MAX_STICKER_BYTES, MAX_TRAY_BYTES } from './encoder.js';
import { slugify } from './util.js';

export const MIN_STICKERS = 3;
export const MAX_STICKERS = 30;

export function stickerFile(sticker, i = 0) {
  return new File([sticker.blob], `sticker-${String(i + 1).padStart(2, '0')}.webp`, { type: 'image/webp' });
}

export function canShareFiles(files) {
  try {
    return !!navigator.canShare && navigator.canShare({ files });
  } catch {
    return false;
  }
}

export async function shareFiles(files, title) {
  if (!canShareFiles(files)) throw new Error('Tu navegador no permite compartir archivos');
  try {
    await navigator.share({ files, title });
    return true;
  } catch (e) {
    if (e.name === 'AbortError') return false;
    throw e;
  }
}

export function validatePack(pack, stickers) {
  const issues = [];
  if (stickers.length < MIN_STICKERS) issues.push(`WhatsApp pide al menos ${MIN_STICKERS} stickers por paquete (tenés ${stickers.length}).`);
  if (stickers.length > MAX_STICKERS) issues.push(`Máximo ${MAX_STICKERS} stickers por paquete (tenés ${stickers.length}).`);
  if (!pack.name?.trim()) issues.push('El paquete necesita un nombre.');
  if ((pack.name || '').length > 128) issues.push('El nombre puede tener hasta 128 caracteres.');
  if ((pack.author || '').length > 128) issues.push('El autor puede tener hasta 128 caracteres.');
  const big = stickers.filter((s) => s.blob.size > MAX_STICKER_BYTES).length;
  if (big) issues.push(`${big} sticker(s) superan los 100 KB.`);
  return issues;
}

export async function buildTray(pack, stickers) {
  const traySticker = stickers.find((s) => s.id === pack.trayId) || stickers[0];
  const tray = await makeTrayIcon(traySticker.blob);
  if (tray.size > MAX_TRAY_BYTES) throw new Error('El ícono del paquete supera 50 KB');
  return tray;
}

export async function buildWastickers(pack, stickers) {
  const tray = await buildTray(pack, stickers);
  const files = [
    { name: 'title.txt', data: pack.name.trim() },
    { name: 'author.txt', data: (pack.author || 'StickerLab').trim() },
    { name: 'tray.png', data: tray },
    ...stickers.map((s, i) => ({ name: `${String(i + 1).padStart(2, '0')}.webp`, data: s.blob })),
  ];
  const blob = await createZip(files, 'application/octet-stream');
  return new File([blob], `${slugify(pack.name)}.wastickers`, { type: 'application/octet-stream' });
}

/** ZIP "para desarrolladores" con el formato del proyecto oficial WhatsApp/stickers. */
export async function buildDeveloperZip(pack, stickers) {
  const tray = await buildTray(pack, stickers);
  const id = slugify(pack.name) + '_' + pack.id.slice(-4);
  const contents = {
    android_play_store_link: '',
    ios_app_store_link: '',
    sticker_packs: [{
      identifier: id,
      name: pack.name.trim(),
      publisher: (pack.author || 'StickerLab').trim(),
      tray_image_file: 'tray.png',
      image_data_version: String(pack.updated || 1),
      avoid_cache: false,
      publisher_email: '',
      publisher_website: '',
      privacy_policy_website: '',
      license_agreement_website: '',
      animated_sticker_pack: false,
      stickers: stickers.map((s, i) => ({
        image_file: `${String(i + 1).padStart(2, '0')}.webp`,
        emojis: (s.emojis || []).slice(0, 3),
      })),
    }],
  };
  const files = [
    { name: 'contents.json', data: JSON.stringify(contents, null, 2) },
    { name: `${id}/tray.png`, data: tray },
    ...stickers.map((s, i) => ({ name: `${id}/${String(i + 1).padStart(2, '0')}.webp`, data: s.blob })),
  ];
  return createZip(files);
}
