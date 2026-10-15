// Bump this when you deploy changed files so phones pick up the new version.
const VERSION = 'sotd-v25';
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// App shell: network first so updates show up straight away, cache when offline.
// API calls are not cached here. The app keeps its own snapshot of recent results
// so stale ratings are always labelled with when they were saved.
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(
    caches.open(VERSION).then(async cache => {
      try {
        const res = await fetch(event.request, { cache: 'no-cache' });
        if (res.ok) cache.put(event.request, res.clone());
        return res;
      } catch {
        return (await cache.match(event.request, { ignoreSearch: true })) || cache.match('index.html');
      }
    }),
  );
});
