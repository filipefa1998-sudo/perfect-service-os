/* Perfect Service OS service worker — offline-first app shell
   v2: shell self-refreshes on every online launch, assets update in
   the background, cache bump flushes all stale v1 copies. */
const CACHE = 'psos-v2';
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

  // Let Firebase manage its own traffic — never intercept.
  if (url.hostname.indexOf('firestore.googleapis.com') >= 0 ||
      url.hostname.indexOf('firebaseio.com') >= 0 ||
      url.hostname.indexOf('firebasestorage.googleapis.com') >= 0 ||
      url.hostname.indexOf('cloudfunctions.net') >= 0 ||
      url.hostname.indexOf('identitytoolkit.googleapis.com') >= 0 ||
      url.hostname.indexOf('securetoken.googleapis.com') >= 0 ||
      (url.hostname.indexOf('googleapis.com') >= 0 && url.pathname.indexOf('firestore') >= 0)) {
    return;
  }

  // Navigations: network first, AND refresh the cached shell with what
  // came back — so the offline copy is always the latest launched build.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(res => {
        if (res && res.status === 200) {
          const cp = res.clone();
          caches.open(CACHE).then(c => c.put('./index.html', cp));
        }
        return res;
      }).catch(() => caches.match('./index.html'))
    );
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

  // Same-origin assets (icons, manifest): stale-while-revalidate —
  // serve instantly from cache, but always refresh in the background
  // so new versions land within one extra launch.
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.open(CACHE).then(c =>
        c.match(req).then(hit => {
          const net = fetch(req).then(res => { if (res && res.status === 200) c.put(req, res.clone()); return res; }).catch(() => hit);
          return hit || net;
        })
      )
    );
  }
});
