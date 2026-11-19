// Service worker : interface en cache + réception des notifications push.
// Les photos et la base Supabase ne sont jamais mises en cache ici.
const CACHE = 'lonapics-v2';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'config.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/badge-96.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Réseau d'abord (pour avoir toujours la dernière version), cache si hors ligne.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('index.html'))),
  );
});

// Notification reçue (même appli fermée)
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(
    self.registration.showNotification(d.title || 'LonaPics', {
      body: d.body || '',
      icon: 'icons/icon-192.png',
      badge: 'icons/badge-96.png',
      tag: d.tag,
      renotify: Boolean(d.tag),
      data: { url: d.url || '' },
    }),
  );
});

// Toucher la notification ouvre LonaPics au bon endroit
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = new URL(e.notification.data?.url || '', self.registration.scope).href;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (list) => {
      const win = list.find((c) => c.url.startsWith(self.registration.scope));
      if (win) {
        await win.focus();
        win.postMessage({ type: 'open', url: target });
        return;
      }
      return self.clients.openWindow(target);
    }),
  );
});
