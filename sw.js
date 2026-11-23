/*
 * sw.js: offline support.
 * The app files are served from the cache straight away (so the app opens
 * instantly with no signal) and refreshed in the background when online, so
 * an update shows up the next time the app is opened. Google Fonts files are
 * cached the first time they load. Workout data is not here: it lives in
 * localStorage via storage.js.
 */
const VERSION = 'v0.10';
const APP_CACHE = `wt-app-${VERSION}`;
const FONT_CACHE = 'wt-fonts-v1';
const APP_FILES = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './storage.js',
  './prs.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  // cache: 'reload' skips the browser's HTTP cache so a new version gets fresh files.
  event.waitUntil(caches.open(APP_CACHE)
    .then((c) => c.addAll(APP_FILES.map((u) => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((k) => k.startsWith('wt-') && k !== APP_CACHE && k !== FONT_CACHE)
        .map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Fonts: cache first, they never change.
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(caches.open(FONT_CACHE).then(async (cache) => {
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
      return res;
    }));
    return;
  }

  if (url.origin !== self.location.origin) return;

  // App files: answer from cache, refresh in the background.
  event.respondWith(caches.open(APP_CACHE).then(async (cache) => {
    // The app's start page can be opened as "/" or "/index.html"; both use one entry.
    const key = url.pathname.endsWith('/') ? new URL('./index.html', self.registration.scope).href : url.origin + url.pathname;
    const hit = await cache.match(key);
    // 'no-cache' asks the server whether the file changed instead of trusting the HTTP cache.
    const refresh = fetch(url.href, { cache: 'no-cache', credentials: 'same-origin' }).then((res) => {
      if (res.ok && res.type === 'basic') cache.put(key, res.clone());
      return res;
    }).catch(() => null);
    if (hit) { event.waitUntil(refresh); return hit; }
    const res = await refresh;
    return res || new Response('Offline and this page is not saved yet.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  }));
});
