import { useCallback, useEffect, useRef, useState } from 'react'
import { api, connectSocket, setToken } from './api.js'
import Auth from './Auth.jsx'
import Avatar from './Avatar.jsx'
import Chat from './Chat.jsx'
import Notifications from './Notifications.jsx'
import ProfilePanel from './Profile.jsx'
import Sidebar from './Sidebar.jsx'

export default function App() {
  // sessionStorage (not local) so each browser tab can be a different user — handy
  // for trying the realtime features alone with two tabs side by side
  const [me, setMe] = useState(() => {
    try {
      const stored = JSON.parse(sessionStorage.getItem('pulse:me'))
      if (!stored?.token) return null // pre-auth sessions have no token: re-login
      setToken(stored.token)
      return stored
    } catch { return null }
  })
  if (!me) {
    return (
      <Auth onDone={(user) => {
        setToken(user.token)
        sessionStorage.setItem('pulse:me', JSON.stringify(user))
        setMe(user)
      }} />
    )
  }
  return (
    <ChatApp
      me={me}
      onMeChange={(user) => {
        // profile responses carry no token — keep the one we have
        const merged = { ...me, ...user }
        sessionStorage.setItem('pulse:me', JSON.stringify(merged))
        setMe(merged)
      }}
      onLogout={() => {
        api.logout().catch(() => {})
        sessionStorage.removeItem('pulse:me')
        location.reload()
      }}
    />
  )
}

function ChatApp({ me, onMeChange, onLogout }) {
  const [chats, setChats] = useState([])
  const [active, setActive] = useState(null)        // username of the open chat
  const [activeUser, setActiveUser] = useState(null) // their profile (works pre-history too)
  const [messages, setMessages] = useState([])
  const [typing, setTyping] = useState({})           // username -> true
  const [toasts, setToasts] = useState([])
  const [wsStatus, setWsStatus] = useState('reconnecting')
  const [profileView, setProfileView] = useState(null) // null | 'me' | username
  const [notifs, setNotifs] = useState([])              // notification-center history
  const [notifOpen, setNotifOpen] = useState(false)

  const socketRef = useRef(null)
  const activeRef = useRef(null)
  const chatsRef = useRef([])
  const typingTimers = useRef({})
  const toastSeq = useRef(0)
  activeRef.current = active
  chatsRef.current = chats

  const loadChats = useCallback(() => {
    api.chats().then(setChats).catch(() => {})
  }, [])

  // Fetch once on mount too — if our stored token is dead, this 401s and the api
  // layer bounces us to the login screen (the socket alone would retry forever).
  useEffect(() => { loadChats() }, [loadChats])

  const loadNotifs = useCallback(() => {
    api.notifications().then(setNotifs).catch(() => {})
  }, [])
  useEffect(() => { loadNotifs() }, [loadNotifs])

  // Register the worker up front so tab-hidden notifications can use it (and click
  // through to a chat) even for users who haven't turned on web push yet.
  useEffect(() => {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {})
  }, [])

  // Coming back to the tab: mark the open chat read (we deliberately held off while
  // it was hidden) and clear its unread badge.
  useEffect(() => {
    const onVisible = () => {
      if (document.hidden || !activeRef.current) return
      socketRef.current?.send({ type: 'read', from: activeRef.current })
      setChats((cs) => cs.map((c) => (c.username === activeRef.current ? { ...c, unread: 0 } : c)))
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  const pushToast = useCallback((t) => {
    const id = ++toastSeq.current
    setToasts((ts) => [...ts.slice(-3), { id, ...t }])
    setTimeout(() => setToasts((ts) => ts.map((x) => (x.id === id ? { ...x, leaving: true } : x))), 3800)
    setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), 4200)
  }, [])

  // OS notification for a message that arrived while the tab is hidden (another
  // tab / minimized). Routed through the service worker when one is registered so
  // a click deep-links to the chat (same handler as web push); falls back to the
  // plain Notification constructor otherwise. When the tab is fully CLOSED this
  // path can't run — that's what server-side web push covers.
  const notify = useCallback((sender, text) => {
    if (!document.hidden) return
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
    const opts = { body: text, tag: sender, renotify: true, data: { actor: sender } }
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker
        .getRegistration()
        .then((reg) => (reg ? reg.showNotification(sender, opts) : new Notification(sender, opts)))
        .catch(() => {})
    } else {
      try { new Notification(sender, opts) } catch { /* unsupported */ }
    }
  }, [])

  const setTypingFor = useCallback((user, on) => {
    clearTimeout(typingTimers.current[user])
    if (on) {
      setTyping((t) => ({ ...t, [user]: true }))
      typingTimers.current[user] = setTimeout(() => {
        setTyping((t) => { const n = { ...t }; delete n[user]; return n })
      }, 2500)
    } else {
      setTyping((t) => { const n = { ...t }; delete n[user]; return n })
    }
  }, [])

  useEffect(() => {
    const sock = connectSocket(me.token, {
      onStatus: (s) => {
        setWsStatus(s)
        if (s === 'connected') { // resync after (re)connect
          loadChats()
          loadNotifs() // catch up on anything that landed while we were disconnected
          const a = activeRef.current
          if (a) api.messages(a).then(setMessages).catch(() => {})
        }
      },
      onEvent: (ev) => {
        if (ev.type === 'message') {
          if (ev.client_id) {
            // echo of my optimistic send: swap the pending bubble for the real thing
            const { type, ...msg } = ev
            setMessages((ms) => ms.map((m) => (m.client_id === ev.client_id ? msg : m)))
          } else {
            setTypingFor(ev.sender, false)
            if (activeRef.current === ev.sender) {
              const { type, ...msg } = ev
              setMessages((ms) => [...ms, msg])
              // if I'm on another tab, don't mark read behind my back — alert me instead;
              // the visibilitychange handler sends the read receipt when I come back
              if (document.hidden) notify(ev.sender, ev.text)
              else socketRef.current?.send({ type: 'read', from: ev.sender })
            } else {
              const from = chatsRef.current.find((c) => c.username === ev.sender) || { username: ev.sender }
              pushToast({ kind: 'message', user: from, title: ev.sender, body: ev.text })
              notify(ev.sender, ev.text)
            }
          }
          loadChats()
        } else if (ev.type === 'delivered') {
          if (activeRef.current === ev.by)
            setMessages((ms) => ms.map((m) =>
              m.sender === me.username && m.status === 'sent' ? { ...m, status: 'delivered' } : m))
          loadChats()
        } else if (ev.type === 'read') {
          if (activeRef.current === ev.by)
            setMessages((ms) => ms.map((m) =>
              m.sender === me.username && m.status !== 'read' ? { ...m, status: 'read' } : m))
          loadChats()
        } else if (ev.type === 'typing') {
          setTypingFor(ev.from, true)
        } else if (ev.type === 'presence') {
          setActiveUser((u) => (u && u.username === ev.user ? { ...u, online: ev.online } : u))
          loadChats()
        } else if (ev.type === 'reaction') {
          const chatWith = ev.message_sender === me.username ? ev.message_recipient : ev.message_sender
          if (activeRef.current === chatWith)
            setMessages((ms) => ms.map((m) => {
              if (m.id !== ev.message_id) return m
              const reactions = m.reactions.filter((r) => r.by !== ev.by)
              if (!ev.removed) reactions.push({ emoji: ev.emoji, by: ev.by })
              return { ...m, reactions }
            }))
          // notify when someone reacts to MY message and I'm not looking at it
          if (ev.by !== me.username && !ev.removed && ev.message_sender === me.username &&
              (activeRef.current !== chatWith || document.hidden)) {
            const from = chatsRef.current.find((c) => c.username === ev.by) || { username: ev.by }
            pushToast({ kind: 'reaction', user: from, emoji: ev.emoji, title: ev.by, body: ev.message_text })
            notify(`${ev.by} reacted ${ev.emoji}`, ev.message_text)
          }
        }
      },
    })
    socketRef.current = sock
    return () => sock.close()
  }, [me.username, me.token, loadChats, loadNotifs, notify, pushToast, setTypingFor])

  // Unread total in the tab title — the poor man's notification badge.
  const totalUnread = chats.reduce((a, c) => a + c.unread, 0)
  useEffect(() => {
    document.title = totalUnread ? `(${totalUnread}) Pulse` : 'Pulse'
  }, [totalUnread])

  const openChat = useCallback((user) => {
    setActive(user.username)
    setActiveUser(user)
    setMessages([])
    api.messages(user.username).then(setMessages).catch(() => {})
    socketRef.current?.send({ type: 'read', from: user.username })
    setChats((cs) => cs.map((c) => (c.username === user.username ? { ...c, unread: 0 } : c)))
  }, [])

  const unreadNotifs = notifs.reduce((a, n) => a + (n.read ? 0 : 1), 0)

  const openNotifications = useCallback(() => {
    setNotifOpen(true)
    setNotifs((ns) => ns.map((n) => (n.read ? n : { ...n, read: 1 }))) // clear the badge
    api.readNotifications().catch(() => {})
  }, [])

  const clearNotifications = useCallback(() => {
    setNotifs([])
    api.clearNotifications().catch(() => {})
  }, [])

  const openChatByName = useCallback((username) => {
    const user = chatsRef.current.find((c) => c.username === username) || { username }
    openChat(user)
    setNotifOpen(false)
  }, [openChat])

  // Deep-link from a notification click: the service worker either opens /?chat=<who>
  // (cold start) or postMessages an already-open tab. Honour both, then clean the URL.
  useEffect(() => {
    const target = new URLSearchParams(location.search).get('chat')
    if (target) {
      openChatByName(target)
      history.replaceState(null, '', location.pathname)
    }
    const onSwMessage = (e) => {
      if (e.data?.type === 'open-chat' && e.data.actor) openChatByName(e.data.actor)
    }
    navigator.serviceWorker?.addEventListener('message', onSwMessage)
    return () => navigator.serviceWorker?.removeEventListener('message', onSwMessage)
  }, [openChatByName])

  const sendMessage = useCallback((text) => {
    const to = activeRef.current
    if (!to) return
    const client_id = crypto.randomUUID()
    setMessages((ms) => [...ms, {
      client_id, sender: me.username, recipient: to, text,
      ts: Date.now() / 1000, status: 'pending', reactions: [],
    }])
    socketRef.current?.send({ type: 'message', to, text, client_id })
  }, [me.username])

  // Freshest view of the open chat's profile (presence/avatar updates ride on chats).
  const displayUser = active
    ? { ...activeUser, ...(chats.find((c) => c.username === active) || {}) }
    : null

  return (
    <div className={`app ${active ? 'has-active' : ''}`}>
      <Sidebar
        me={me}
        chats={chats}
        active={active}
        typing={typing}
        wsStatus={wsStatus}
        unreadNotifs={unreadNotifs}
        onOpen={openChat}
        onOpenProfile={setProfileView}
        onOpenNotifications={openNotifications}
        onLogout={onLogout}
      />
      <Chat
        me={me}
        user={displayUser}
        messages={messages}
        isTyping={!!typing[active]}
        onSend={sendMessage}
        onTyping={() => socketRef.current?.send({ type: 'typing', to: activeRef.current })}
        onReact={(message_id, emoji) => socketRef.current?.send({ type: 'reaction', message_id, emoji })}
        onOpenProfile={setProfileView}
        onBack={() => { setActive(null); setActiveUser(null) }}
      />

      {notifOpen && (
        <Notifications
          items={notifs}
          onClose={() => setNotifOpen(false)}
          onOpenChat={openChatByName}
          onClear={clearNotifications}
        />
      )}

      {profileView && (
        <ProfilePanel
          me={me}
          view={profileView}
          onClose={() => setProfileView(null)}
          onMeChange={(user) => { onMeChange(user); loadChats() }}
        />
      )}

      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <button
            key={t.id}
            className={`toast ${t.leaving ? 'leaving' : ''}`}
            onClick={() => {
              const user = chatsRef.current.find((c) => c.username === t.user.username) || t.user
              openChat(user)
            }}
          >
            <Avatar user={t.user} size={36} />
            <div className="toast-body">
              <strong>
                {t.user.name || t.title}
                {t.kind === 'reaction' && <span className="toast-emoji">{t.emoji}</span>}
              </strong>
              <span>{t.kind === 'reaction' ? `reacted to: ${t.body}` : t.body}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
