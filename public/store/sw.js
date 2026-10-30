// يخلّي واجهة التطبيق تفتح بسرعة وحتى لو النت ضعيف. الأسعار والطلبات دايماً من السيرفر.
const CACHE = 'jarak-store-v7';
const SHELL = ['/store/', '/shared.css', '/shared.js', '/store/icon.svg', '/store/manifest.webmanifest', '/fonts/rubik-arabic-500-normal.woff2', '/fonts/rubik-arabic-800-normal.woff2'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('jarak-store-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/')) return;
  if (!u.pathname.startsWith('/store/') && !/^\/(shared\.|livemap\.js|sounds\/|fonts\/|img\/|vendor\/)/.test(u.pathname)) return;
  e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request).then(m => m || caches.match('/store/'))));
});
const SCOPE = '/store/', ICON = '/store/icon-192.png';
// إشعار يوصل والتطبيق مقفول
self.addEventListener('push', (e) => {
  let m = {}; try { m = e.data.json(); } catch (_) { m = { title: 'جارك', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(m.title || 'جارك', {
    body: m.body || '', tag: m.tag || 'jarak', renotify: true, requireInteraction: !!m.urgent, dir: 'rtl', lang: 'ar',
    icon: ICON, badge: ICON, vibrate: m.urgent ? [500, 200, 500, 200, 500, 200, 500] : [200, 100, 200], data: { url: m.url || SCOPE }
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || SCOPE;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(ws => {
    const w = ws.find(x => new URL(x.url).pathname.startsWith(SCOPE));
    if (w) { w.navigate(url).catch(() => {}); return w.focus(); }
    return self.clients.openWindow(url);
  }));
});
