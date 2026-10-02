// Keeps the phone app's own code on the phone so it opens with no internet.
// Only these files are cached - never anything from the shop PC (its data lives in
// IndexedDB, see db.js). Bump VERSION whenever a file below changes.
const VERSION = 'jpnpl-phone-v7';
const FILES = ['./', 'index.html', 'app.js', 'app.css', 'gst.js', 'db.js', 'pdf.js', 'relay.js',
  'tokens.css', 'm.css', 'icons.svg', 'ui.js', 'help.js', 'help_texts.js',
  'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Our own files: network first (so an update arrives), the cached copy when offline.
// Anything else (the shop PC, the relay) is not touched.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const scope = new URL(self.registration.scope);
  if (!url.pathname.startsWith(scope.pathname) || url.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(VERSION).then((c) => c.put(e.request, copy));
    }
    return res;
  }).catch(() => caches.match(e.request, {ignoreSearch: true})
    .then((hit) => hit || caches.match('index.html'))));
});
