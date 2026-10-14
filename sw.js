// Service worker: funciona sin conexión (excepto las funciones de IA, que descargan su modelo
// la primera vez) y recibe imágenes compartidas desde otras apps (Web Share Target).

const VERSION = 'v1';
const SHELL = `stickerlab-${VERSION}`;
const ASSETS = [
  './',
  'index.html',
  'css/app.css',
  'js/main.js',
  'js/util.js',
  'js/icons.js',
  'js/cutter.js',
  'js/composer.js',
  'js/imageops.js',
  'js/ai.js',
  'js/encoder.js',
  'js/store.js',
  'js/whatsapp.js',
  'js/zip.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('stickerlab-') && k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith((async () => {
      const form = await req.formData();
      const file = form.get('image');
      if (file) {
        const inbox = await caches.open('share-inbox');
        await inbox.put('shared-image', new Response(file, { headers: { 'Content-Type': file.type } }));
      }
      return Response.redirect('./?shared=1', 303);
    })());
    return;
  }

  if (req.method !== 'GET') return;

  // Fuentes de Google: cache primero (no cambian).
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(caches.open(`${SHELL}-fonts`).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') c.put(req, res.clone());
      return res;
    }));
    return;
  }

  if (url.origin !== location.origin) return;

  // App: red primero para tener siempre la última versión; cache si no hay conexión.
  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok) (await caches.open(SHELL)).put(req, res.clone());
      return res;
    } catch {
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate') return caches.match('index.html');
      throw new Error('offline');
    }
  })());
});
