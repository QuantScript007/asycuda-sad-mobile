// Offline support: cache the app shell (incl. the SheetJS library and the SAD
// model) on install; serve from cache, refreshing in the background.
const CACHE = 'sad-mobile-v1.2.0';
const ASSETS = [
  './', 'index.html', 'css/app.css', 'js/app.js', 'js/sad-core.js', 'js/xls-template.js', 'js/store.js',
  'js/scan.js', 'js/invoice-parse.js',
  'vendor/xlsx.full.min.js', 'templates/SAD_MODEL.xls', 'manifest.webmanifest',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async (cache) => {
    const cached = await cache.match(e.request, { ignoreSearch: true });
    const network = fetch(e.request).then((res) => {
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    }).catch(() => cached);
    return cached || network;
  }));
});
