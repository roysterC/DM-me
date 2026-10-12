// Shows "Alisa replied" notifications, and opens the chat when one is tapped. The server only
// sends one when the chat isn't open, so every push shows a notification (iPhones require that).
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // not ours; show the plain version below
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'New message', {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: data.tag || 'chat',
      renotify: true,
      data: { url: data.url || '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows.find((w) => w.url === url) || windows[0];
      if (open) {
        await open.focus();
        if (open.url !== url && 'navigate' in open) await open.navigate(url);
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});

// Takes over right away, so a page that just registered it can subscribe.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
