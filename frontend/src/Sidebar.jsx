import { useEffect, useState } from 'react'
import { api } from './api.js'
import Avatar from './Avatar.jsx'
import {
  BellIcon, CalendarIcon, LogOutIcon, MessageIcon, MoonIcon, PulseLogo, SearchIcon, SunIcon,
  Ticks, XIcon,
} from './icons.jsx'

function timeLabel(ts) {
  const d = new Date(ts * 1000)
  const now = new Date()
  if (d.toDateString() === now.toDateString())
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const yesterday = new Date(now - 864e5)
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export default function Sidebar({ me, chats, active, typing, wsStatus, unreadNotifs,
                                  onOpen, onOpenProfile, onOpenNotifications, onOpenEvents,
                                  theme, onToggleTheme, onLogout }) {
  const [q, setQ] = useState('')
  const [found, setFound] = useState([])

  // Search the whole user directory while typing (existing chats filter locally).
  useEffect(() => {
    if (!q.trim()) return setFound([])
    let stale = false
    api.users(q.trim()).then((users) => !stale && setFound(users)).catch(() => {})
    return () => { stale = true }
  }, [q])

  const searching = !!q.trim()
  const needle = q.trim().toLowerCase()
  const chatMatches = searching
    ? chats.filter((c) => c.username.toLowerCase().includes(needle))
    : chats
  const chatNames = new Set(chats.map((c) => c.username))
  const newPeople = found.filter((u) => !chatNames.has(u.username))
  // you can't chat with yourself — the server never returns you in results, so
  // catch it here when someone searches their own username/name
  const matchesMe = searching &&
    (me.username.toLowerCase().includes(needle) || (me.name || '').toLowerCase().includes(needle))

  const open = (user) => {
    setQ('')
    onOpen(user)
  }

  return (
    <aside className="sidebar">
      {/* the empty state carries the full lockup; this keeps the brand on screen
          once a conversation is open */}
      <div className="brand" title="Conversations with a pulse.">
        <span className="brand-mark"><PulseLogo size={15} /></span>
        <span className="brand-name">Pulse <span>Messenger</span></span>
      </div>

      <header className="sidebar-header">
        <button className="avatar-btn" onClick={() => onOpenProfile('me')} aria-label="My profile" title="My profile">
          <Avatar user={me} size={40} />
        </button>
        <div className="sidebar-me">
          <strong>{me.name || me.username}</strong>
          <span className={`ws-status ${wsStatus}`}>
            {wsStatus === 'connected' ? 'online' : 'reconnecting…'}
          </span>
        </div>
        <button className="icon-btn" title="Events" aria-label="Events" onClick={onOpenEvents}>
          <CalendarIcon size={18} />
        </button>
        <button
          className="icon-btn notif-btn"
          title="Notifications"
          aria-label={unreadNotifs ? `Notifications, ${unreadNotifs} unread` : 'Notifications'}
          onClick={onOpenNotifications}
        >
          <BellIcon size={18} />
          {unreadNotifs > 0 && (
            <span className="notif-badge" key={unreadNotifs}>{unreadNotifs > 9 ? '9+' : unreadNotifs}</span>
          )}
        </button>
        <button
          className="icon-btn theme-btn"
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          aria-pressed={theme === 'dark'}
          onClick={onToggleTheme}
        >
          {theme === 'dark' ? <SunIcon size={18} /> : <MoonIcon size={18} />}
        </button>
        <button className="icon-btn" title="Log out" aria-label="Log out" onClick={onLogout}>
          <LogOutIcon size={18} />
        </button>
      </header>

      <div className="sidebar-search">
        <SearchIcon size={16} className="sidebar-search-icon" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search or start a new chat"
          aria-label="Search users"
        />
        {searching && (
          <button className="icon-btn sidebar-search-clear" onClick={() => setQ('')} aria-label="Clear search">
            <XIcon size={14} />
          </button>
        )}
      </div>

      <div className="chat-list">
        {matchesMe && (
          <div className="chat-list-self">
            <Avatar user={me} size={40} />
            <p>apnay aap se khud baat dil mai karay 💭</p>
          </div>
        )}

        {chatMatches.map((c, i) => (
          <button
            key={c.username}
            className={`chat-item ${active === c.username ? 'active' : ''}`}
            style={{ '--i': i }}
            onClick={() => open(c)}
          >
            <Avatar user={c} size={46} online={c.online} />
            <div className="chat-item-body">
              <div className="chat-item-top">
                <span className="chat-item-name">{c.name || c.username}</span>
                <span className={`chat-item-time ${c.unread ? 'unread' : ''}`}>{timeLabel(c.last_ts)}</span>
              </div>
              <div className="chat-item-bottom">
                {typing[c.username] ? (
                  <span className="chat-item-typing">typing…</span>
                ) : (
                  <span className="chat-item-preview">
                    {c.last_sender === me.username && <Ticks status={c.last_status} />}
                    {c.last_text}
                  </span>
                )}
                {c.unread > 0 && (
                  <span className="unread-badge" key={c.unread}>{c.unread}</span>
                )}
              </div>
            </div>
          </button>
        ))}

        {searching && newPeople.length > 0 && (
          <>
            <div className="chat-list-label">Start a new chat</div>
            {newPeople.map((u, i) => (
              <button key={u.username} className="chat-item" style={{ '--i': i }} onClick={() => open(u)}>
                <Avatar user={u} size={46} online={u.online} />
                <div className="chat-item-body">
                  <div className="chat-item-top">
                    <span className="chat-item-name">{u.name || u.username}</span>
                  </div>
                  <div className="chat-item-bottom">
                    <span className="chat-item-preview">Say hi 👋</span>
                  </div>
                </div>
              </button>
            ))}
          </>
        )}

        {searching && chatMatches.length + newPeople.length === 0 && !matchesMe && (
          <div className="chat-list-empty">
            <SearchIcon size={28} />
            <p>No one called “{q.trim()}” yet</p>
          </div>
        )}

        {!searching && chats.length === 0 && (
          <div className="chat-list-empty">
            <MessageIcon size={28} />
            <p>No conversations yet.<br />Search a username to start one.</p>
          </div>
        )}
      </div>
    </aside>
  )
}
