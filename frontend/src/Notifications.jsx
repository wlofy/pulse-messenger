import { useEffect, useState } from 'react'
import { enablePush } from './api.js'
import Avatar from './Avatar.jsx'
import { BellIcon, MessageIcon, SmilePlusIcon, TrashIcon, XIcon } from './icons.jsx'

// "3m", "2h", "Tue", "Mar 4" — compact age of a notification.
function ago(ts) {
  const s = Math.max(0, Date.now() / 1000 - ts)
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  const d = new Date(ts * 1000)
  if (s < 7 * 86400) return d.toLocaleDateString([], { weekday: 'short' })
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

// A slide-in panel listing everything that happened to me — the offline-safe
// counterpart to the transient toasts, backed by the server so it survives reloads.
export default function Notifications({ items, onClose, onOpenChat, onClear }) {
  const supported =
    typeof Notification !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window
  const [perm, setPerm] = useState(supported ? Notification.permission : 'unsupported')
  // Whether THIS browser actually has a push subscription — the real gate. Granting
  // OS permission isn't enough; the offer stays until we're genuinely subscribed.
  const [subscribed, setSubscribed] = useState(null) // null = still checking
  const [pushErr, setPushErr] = useState('')

  const turnOn = () => {
    setPushErr('')
    enablePush().then((p) => {
      setPerm(p)
      setSubscribed(p === 'granted')
    }).catch((e) => setPushErr(e.message))
  }

  // On open, ask the service worker whether a subscription already exists.
  useEffect(() => {
    if (!supported) return setSubscribed(false)
    navigator.serviceWorker
      .getRegistration()
      .then((reg) => (reg ? reg.pushManager.getSubscription() : null))
      .then((sub) => setSubscribed(!!sub))
      .catch(() => setSubscribed(false))
  }, [supported])

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="overlay" onClick={onClose}>
      <div
        className="notif-panel"
        role="dialog"
        aria-label="Notifications"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="notif-head">
          <h2>Notifications</h2>
          {items.length > 0 && (
            <button className="icon-btn" title="Clear all" aria-label="Clear all" onClick={onClear}>
              <TrashIcon size={17} />
            </button>
          )}
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <XIcon size={16} />
          </button>
        </header>

        {/* Offer the button whenever we're supported, not blocked, and not yet
            subscribed — regardless of whether OS permission was already granted. */}
        {supported && perm !== 'denied' && subscribed === false && (
          <button className="notif-enable" onClick={turnOn}>
            <BellIcon size={16} />
            Turn on push alerts to hear about these even when this tab is closed
          </button>
        )}
        {perm === 'denied' && (
          <p className="notif-error">
            Notifications are blocked. Enable them in your browser's site settings, then reload.
          </p>
        )}
        {pushErr && <p className="notif-error">{pushErr}</p>}

        <div className="notif-list">
          {items.length === 0 ? (
            <div className="notif-empty">
              <BellIcon size={30} />
              <p>Nothing yet.<br />Messages and reactions you get will show up here.</p>
            </div>
          ) : (
            items.map((n) => (
              <button
                key={n.id}
                className={`notif-item ${n.read ? '' : 'unread'}`}
                onClick={() => onOpenChat(n.actor)}
              >
                <Avatar user={{ username: n.actor }} size={40} />
                <div className="notif-item-body">
                  <div className="notif-item-top">
                    <span className="notif-item-actor">
                      {n.kind === 'reaction' ? <SmilePlusIcon size={13} /> : <MessageIcon size={13} />}
                      {n.actor}
                    </span>
                    <span className="notif-item-time">{ago(n.ts)}</span>
                  </div>
                  <span className="notif-item-text">
                    {n.kind === 'reaction' ? `reacted ${n.body}` : n.body}
                  </span>
                </div>
                {!n.read && <span className="notif-dot-unread" />}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
