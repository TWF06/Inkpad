// Service worker: offline app shell + receiving files shared from other apps ("Share → Inkpad").
const SHELL = 'inkpad-shell-v16';
const SHARED = 'inkpad-shared';
const MAX_SHARED = 20, MAX_SHARED_BYTES = 200 * 1024 * 1024;
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
      // any web page can POST here, so keep it bounded; the app asks before it opens anything (app.js openShared)
      let form;
      try { form = await e.request.formData(); } catch { return Response.redirect('./#/', 303); }
      const cache = await caches.open(SHARED);
      for (const old of await cache.keys()) await cache.delete(old);   // never let unopened shares pile up
      let n = 0;
      for (const f of form.getAll('files')) {
        if (!(f instanceof File) || n >= MAX_SHARED || f.size > MAX_SHARED_BYTES) continue;
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
