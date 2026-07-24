const enc = encodeURIComponent

// Set once at boot / after login; every authed call and the socket use it.
let token = null
export const setToken = (t) => { token = t }

const logout = () => {
  sessionStorage.removeItem('pulse:me')
  location.reload()
}

// Surface the server's error message ({"detail": "..."}) so forms can show it.
async function fail(r) {
  let detail = `HTTP ${r.status}`
  try { detail = (await r.json()).detail || detail } catch { /* not json */ }
  throw new Error(detail)
}

// Authenticated request. A 401 means the token is dead — back to the login screen.
async function authed(path, options = {}) {
  const r = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  })
  if (r.status === 401) { logout(); return new Promise(() => {}) } // reload is coming
  if (!r.ok) await fail(r)
  return r.json()
}

// Anonymous POST for login/signup — here a 401/409 is a form error, not a dead session.
async function anon(path, body) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) await fail(r)
  return r.json()
}

export const api = {
  exists: (username) => fetch(`/exists/${enc(username)}`).then((r) => r.json()),
  signup: (username, password, avatar) => anon('/signup', { username, password, avatar }),
  login: (username, password) => anon('/login', { username, password }),
  logout: () => authed('/logout', { method: 'POST', keepalive: true }),
  users: (q = '') => authed(`/users?q=${enc(q)}`),
  chats: () => authed('/chats'),
  messages: (other) => authed(`/messages?other=${enc(other)}`),
  profile: (username) => authed(`/profile/${enc(username)}`),
  updateProfile: (payload) =>
    authed('/profile', { method: 'POST', body: JSON.stringify(payload) }),
  uploadMedia: (data, width, height) =>
    authed('/media', { method: 'POST', body: JSON.stringify({ data, width, height }) }),
  notifications: () => authed('/notifications'),
  readNotifications: () => authed('/notifications/read', { method: 'POST' }),
  clearNotifications: () => authed('/notifications/clear', { method: 'POST' }),
}

// An <img src> can't carry an Authorization header, so the token rides in the query
// string — the same concession the WebSocket makes. Read `token` at call time, not
// at module load: it's set after login.
export const mediaUrl = (id) => `/media/${enc(id)}?token=${enc(token)}`

// --- Web Push: register the service worker + subscribe this browser ---------
// The VAPID key comes from the server base64url-encoded; PushManager wants raw bytes.
function urlBase64ToUint8Array(base64) {
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=')
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)))
}

// Ask for permission, register /sw.js, subscribe, and hand the subscription to
// the server. Returns the final permission ('granted' | 'denied'). Throws with a
// readable message if the browser can't do push at all.
export async function enablePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window))
    throw new Error('This browser does not support push notifications')
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return permission

  const reg = await navigator.serviceWorker.register('/sw.js')
  await navigator.serviceWorker.ready
  const { key } = await fetch('/push/key').then((r) => r.json())
  const sub =
    (await reg.pushManager.getSubscription()) ||
    (await reg.pushManager.subscribe({
      userVisibleOnly: true, // browsers require every push to be user-visible
      applicationServerKey: urlBase64ToUint8Array(key),
    }))
  await authed('/push/subscribe', { method: 'POST', body: JSON.stringify(sub) })
  return permission
}

// One socket per session, auto-reconnects with exponential backoff.
export function connectSocket(wsToken, { onEvent, onStatus }) {
  let ws = null
  let closed = false
  let attempt = 0

  const open = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    ws = new WebSocket(`${proto}://${location.host}/ws?token=${enc(wsToken)}`)
    ws.onopen = () => {
      attempt = 0
      onStatus('connected')
    }
    ws.onmessage = (e) => onEvent(JSON.parse(e.data))
    ws.onclose = () => {
      if (closed) return
      onStatus('reconnecting')
      setTimeout(open, Math.min(8000, 1000 * 2 ** attempt++))
    }
  }
  open()

  return {
    send: (obj) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj))
    },
    close: () => {
      closed = true
      ws?.close()
    },
  }
}
