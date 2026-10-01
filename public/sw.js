// Service worker: keeps the app shell available offline and shows content-free notifications.
const SHELL = 'shlen-shell-v2';
const FILES = ['/', '/app.css', '/app.js', '/webauthn.js', '/icon.svg', '/manifest.webmanifest',
  '/fonts/nunito-latin-800-normal.woff2', '/fonts/figtree-latin-400-normal.woff2', '/fonts/figtree-latin-700-normal.woff2'];

self.addEventListener('install', e => { e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== SHELL).map(k => caches.delete(k))))); self.clients.claim(); });

// App files: network first, fall back to the saved copy. The API is never cached.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(SHELL).then(c => c.put(e.request, copy)); return r; })
    .catch(() => caches.match(e.request).then(r => r || caches.match('/'))));
});

self.addEventListener('push', e => {
  let d = {}; try { d = e.data.json(); } catch {}
  e.waitUntil(self.registration.showNotification(d.title || 'Shlen Box', { tag: d.kind || 'shlen', icon: '/icon.svg', badge: '/icon.svg' }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then(ws => ws[0] ? ws[0].focus() : self.clients.openWindow('/')));
});
