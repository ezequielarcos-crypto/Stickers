// Persistencia local de paquetes y stickers con IndexedDB.

import { uid } from './util.js';

const DB_NAME = 'stickerlab';
const DB_VERSION = 1;
let dbPromise;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('packs')) db.createObjectStore('packs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('stickers')) {
        const s = db.createObjectStore('stickers', { keyPath: 'id' });
        s.createIndex('packId', 'packId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(stores, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let result;
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transacción cancelada'));
    const r = fn(t);
    if (r && 'onsuccess' in r) r.onsuccess = () => (result = r.result);
    else result = r;
  });
}

export function listPacks() {
  return tx('packs', 'readonly', (t) => t.objectStore('packs').getAll())
    .then((packs) => packs.sort((a, b) => b.updated - a.updated));
}

export function getPack(id) {
  return tx('packs', 'readonly', (t) => t.objectStore('packs').get(id));
}

export async function createPack({ name, author }) {
  const pack = { id: uid(), name: name || 'Mis stickers', author: author || '', created: Date.now(), updated: Date.now(), trayId: null };
  await tx('packs', 'readwrite', (t) => t.objectStore('packs').put(pack));
  return pack;
}

export function savePack(pack) {
  pack.updated = Date.now();
  return tx('packs', 'readwrite', (t) => t.objectStore('packs').put(pack));
}

export async function deletePack(id) {
  const stickers = await listStickers(id);
  await tx(['packs', 'stickers'], 'readwrite', (t) => {
    t.objectStore('packs').delete(id);
    for (const s of stickers) t.objectStore('stickers').delete(s.id);
  });
}

export function listStickers(packId) {
  return tx('stickers', 'readonly', (t) => t.objectStore('stickers').index('packId').getAll(packId))
    .then((list) => list.sort((a, b) => a.order - b.order));
}

export async function addSticker(packId, { blob, emojis }) {
  const existing = await listStickers(packId);
  const sticker = { id: uid(), packId, blob, emojis: emojis || ['😀'], created: Date.now(), order: existing.length ? existing[existing.length - 1].order + 1 : 0 };
  await tx('stickers', 'readwrite', (t) => t.objectStore('stickers').put(sticker));
  const pack = await getPack(packId);
  if (pack) await savePack(pack);
  return sticker;
}

export function updateSticker(sticker) {
  return tx('stickers', 'readwrite', (t) => t.objectStore('stickers').put(sticker));
}

export function deleteSticker(id) {
  return tx('stickers', 'readwrite', (t) => t.objectStore('stickers').delete(id));
}

export async function countStickers(packId) {
  return tx('stickers', 'readonly', (t) => t.objectStore('stickers').index('packId').count(packId));
}
