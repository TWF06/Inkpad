// Service worker: offline app shell + receiving files shared from other apps ("Share → Inkpad").
const SHELL = 'inkpad-shell-v9';
const SHARED = 'inkpad-shared';
const FILES = ['./', './index.html', './styles.css', './icon.svg', './manifest.webmanifest',
  './src/app.js', './src/theme.js', './src/split.js', './src/export.js', './src/editor.js', './src/library.js', './src/panels.js', './src/render.js', './src/shapes.js',
  './src/store.js', './src/timer.js', './src/ui.js', './src/importer.js', './src/native.js', './src/pdfnote.js', './src/pdfwork.js', './vendor/capacitor/capacitor.js',
  './vendor/pdfjs/pdf.min.mjs', './vendor/pdfjs/pdf.worker.min.mjs', './vendor/pdf-lib/pdf-lib.esm.min.js',
  './vendor/jszip/jszip.min.js'];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('inkpad-shell-') && k !== SHELL).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  if (e.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith((async () => {
      const form = await e.request.formData();
      const cache = await caches.open(SHARED);
      let n = 0;
      for (const f of form.getAll('files')) {
        if (!(f instanceof File)) continue;
        await cache.put(`./shared/${Date.now()}-${n++}`, new Response(f, { headers: { 'Content-Type': f.type || 'application/octet-stream', 'X-Name': encodeURIComponent(f.name) } }));
      }
      return Response.redirect('./#/shared', 303);
    })());
    return;
  }
  if (e.request.method !== 'GET') return;
  // network first (so updates show up), fall back to cache when offline
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok) { const copy = r.clone(); caches.open(SHELL).then((c) => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
