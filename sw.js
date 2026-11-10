'use strict';
// v2: network-first for the app code, cache-first for icons.
//
// v1 was cache-first for everything, which meant a fixed build could never reach a
// phone that had already loaded the broken one. Code now updates as soon as you're
// online and still works with no signal; icons never change, so they stay cache-first.
// deploy.js stamps this with a hash of the shipped files, so every deploy changes sw.js
// and phones notice. No manual bump.
const CACHE = 'p1p-12c0e90f5c';
const SHELL = ['./', 'index.html', 'rules.js', 'core/signals.js', 'core/calendar.js', 'core/engine.js', 'manifest.webmanifest'];
const ASSETS = ['icon-180.png', 'icon-192.png', 'icon-512.png', 'icon-maskable.png'];

self.addEventListener('install', e => {
  // add() one at a time: addAll rejects the whole install if any single file 404s.
  e.waitUntil(caches.open(CACHE)
    .then(c => Promise.all(SHELL.concat(ASSETS).map(f => c.add(new Request(f, { cache: 'reload' })).catch(() => {}))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const isAsset = /\.(png|svg|ico|woff2?)$/i.test(url.pathname);

  if (isAsset) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    })));
    return;
  }

  // Network first, falling back to the cache when offline. no-cache revalidates with the
  // server (a 304 when nothing changed) instead of trusting GitHub Pages' max-age=600.
  e.respondWith(
    fetch(req, { cache: 'no-cache' })
      .then(res => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then(hit => hit || caches.match('index.html')))
  );
});
