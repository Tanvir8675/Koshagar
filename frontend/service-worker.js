const CACHE_NAME = 'shop-manager-v7';
const ASSETS = [
  './index.html',
  './manifest.webmanifest',
  './icons/icon_192.png',
  './icons/icon_512.png',
  // Self-hosted SQLite engine — precached so the relational DB works offline.
  './vendor/sql-wasm.js',
  './vendor/sql-wasm.wasm'
];

self.addEventListener('install', e => {
  // Per-asset add with allSettled (NOT addAll) so one temporarily-unavailable
  // asset can't fail the whole install and leave a stale SW in control.
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => Promise.allSettled(ASSETS.map(a => cache.add(a))))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if(e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  // Pass Firestore / API calls through — only cache local assets
  if(url.origin !== location.origin) return;

  // Network-first for the app shell + code (navigations / .html / .js) so code
  // updates are always picked up; fall back to cache only when offline.
  const isAppCode = e.request.mode === 'navigate' || url.pathname.endsWith('/') || url.pathname.endsWith('index.html') || url.pathname.endsWith('.js');
  if(isAppCode) {
    e.respondWith(
      fetch(e.request).then(resp => {
        if(resp && resp.status === 200) {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        }
        return resp;
      }).catch(() => caches.match(e.request).then(c => c || caches.match('./index.html')))
    );
    return;
  }

  // Cache-first for other static assets (icons, manifest).
  e.respondWith(
    caches.match(e.request).then(cached => {
      if(cached) return cached;
      return fetch(e.request).then(resp => {
        if(resp && resp.status === 200 && resp.type === 'basic') {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        }
        return resp;
      }).catch(() => caches.match('./index.html'));
    })
  );
});
