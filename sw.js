/* Perfect Service OS service worker — offline-first app shell */
const CACHE = 'psos-v1';
const SHELL = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Let Firestore manage its own offline cache — never intercept its traffic.
  if (url.hostname.indexOf('firestore.googleapis.com') >= 0 ||
      url.hostname.indexOf('firebaseio.com') >= 0 ||
      url.hostname.indexOf('googleapis.com') >= 0 && url.pathname.indexOf('firestore') >= 0) {
    return;
  }

  // Navigations: network first, fall back to cached shell (offline launch).
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('./index.html')));
    return;
  }

  // Firebase SDK + Google Fonts: stale-while-revalidate.
  if (url.hostname.indexOf('gstatic.com') >= 0 || url.hostname.indexOf('fonts.googleapis.com') >= 0) {
    e.respondWith(
      caches.open(CACHE).then(c =>
        c.match(req).then(hit => {
          const net = fetch(req).then(res => { if (res && res.status === 200) c.put(req, res.clone()); return res; }).catch(() => hit);
          return hit || net;
        })
      )
    );
    return;
  }

  // Same-origin assets: cache first.
  if (url.origin === self.location.origin) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res && res.status === 200) { const cp = res.clone(); caches.open(CACHE).then(c => c.put(req, cp)); }
      return res;
    }).catch(() => hit)));
  }
});
