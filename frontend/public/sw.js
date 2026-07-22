// Service worker — runs in the background with NO page open, which is the whole
// point: it's what lets a push notification appear when the site is closed.

// A push arrived from the server (via the browser's push service). Decrypt-and-
// show is handled by the browser; we just turn the payload into an OS notification.
self.addEventListener('push', (event) => {
  let data = {}
  try { data = event.data.json() } catch { /* payload-less push */ }
  const title = data.title || 'New message'
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      tag: data.actor || undefined, // collapse repeated pings from the same person
      renotify: true,
      data: { actor: data.actor || null },
    })
  )
})

// Clicking the notification focuses an existing tab (and tells it which chat to
// open) or launches a fresh one at /?chat=<actor>.
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const actor = event.notification.data && event.notification.data.actor
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const c of wins) {
      if ('focus' in c) {
        await c.focus()
        if (actor) c.postMessage({ type: 'open-chat', actor })
        return
      }
    }
    if (self.clients.openWindow)
      return self.clients.openWindow(actor ? `/?chat=${encodeURIComponent(actor)}` : '/')
  })())
})
