import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import Avatar from './Avatar.jsx'
import { ArrowLeftIcon, MessageIcon, SendIcon, SmilePlusIcon, Ticks } from './icons.jsx'

const QUICK_REACTIONS = ['❤️', '😂', '👍', '😮', '😢', '🔥']
const PAGE = 40 // messages rendered at once; older ones load as you scroll up

const fmtTime = (ts) =>
  new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

function dayLabel(ts) {
  const d = new Date(ts * 1000)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return 'Today'
  if (d.toDateString() === new Date(now - 864e5).toDateString()) return 'Yesterday'
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
}

function TypingDots() {
  return (
    <span className="typing-dots" aria-label="typing">
      <span /><span /><span />
    </span>
  )
}

function Bubble({ msg, mine, tail, picker, onPickerToggle, onReact }) {
  return (
    <div className={`row ${mine ? 'mine' : 'theirs'} ${tail ? 'tail' : ''} ${msg.reactions.length ? 'has-reactions' : ''}`}>
      <div className="bubble-wrap">
        <button
          className="react-btn icon-btn"
          aria-label="React to message"
          onClick={(e) => { e.stopPropagation(); onPickerToggle(msg.id) }}
        >
          <SmilePlusIcon size={16} />
        </button>

        <div className="bubble">
          <span className="bubble-text">{msg.text}</span>
          <span className="bubble-meta">
            {fmtTime(msg.ts)}
            {mine && <Ticks status={msg.status} />}
          </span>

          {msg.reactions.length > 0 && (
            <div className="reaction-chips">
              {msg.reactions.map((r) => (
                <span className="reaction-chip" key={r.by} title={r.by}>{r.emoji}</span>
              ))}
            </div>
          )}
        </div>

        {picker && (
          <div className="reaction-picker" onClick={(e) => e.stopPropagation()}>
            {QUICK_REACTIONS.map((emoji, i) => (
              <button
                key={emoji}
                style={{ '--i': i }}
                className="reaction-option"
                onClick={() => onReact(msg.id, emoji)}
                aria-label={`React ${emoji}`}
              >
                {emoji}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default function Chat({ me, user, messages, isTyping, onSend, onTyping, onReact, onOpenProfile, onBack }) {
  const [draft, setDraft] = useState('')
  const [picker, setPicker] = useState(null) // message id with open reaction picker
  const [visible, setVisible] = useState(PAGE) // how many trailing messages we render
  const scrollRef = useRef()
  const lastTypingSent = useRef(0)
  const inputRef = useRef()
  const keepScroll = useRef(null) // scrollHeight snapshot, set only when loading older

  // Pin to bottom on new messages / typing bubble; instant on chat switch.
  const count = messages.length
  useLayoutEffect(() => {
    if (keepScroll.current != null) return // a "load earlier" render owns the scroll
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [user?.username, count, isTyping])

  // After revealing older messages, hold the viewport on the same message instead
  // of jumping — the content above grew, so offset scrollTop by that growth.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && keepScroll.current != null) {
      el.scrollTop = el.scrollHeight - keepScroll.current
      keepScroll.current = null
    }
  }, [visible])

  const onScroll = () => {
    const el = scrollRef.current
    if (el && el.scrollTop < 80 && visible < count) {
      keepScroll.current = el.scrollHeight
      setVisible((v) => Math.min(v + PAGE, count))
    }
  }

  useEffect(() => {
    setDraft('')
    setPicker(null)
    setVisible(PAGE) // fresh window per conversation
    inputRef.current?.focus()
  }, [user?.username])

  // Any click outside closes the reaction picker.
  useEffect(() => {
    if (picker == null) return
    const close = () => setPicker(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [picker])

  if (!user) {
    return (
      <main className="chat chat-empty">
        <div className="chat-empty-inner">
          <span className="chat-empty-logo"><MessageIcon size={40} /></span>
          <h2>Pulse</h2>
          <p>Pick a conversation, or search a username to start one.</p>
        </div>
      </main>
    )
  }

  const submit = (e) => {
    e.preventDefault()
    const text = draft.trim()
    if (!text) return
    onSend(text)
    setDraft('')
    inputRef.current?.focus()
  }

  const handleTyping = (value) => {
    setDraft(value)
    const now = Date.now()
    if (value && now - lastTypingSent.current > 1200) {
      lastTypingSent.current = now
      onTyping()
    }
  }

  return (
    <main className="chat">
      <header className="chat-header">
        <button className="icon-btn chat-back" onClick={onBack} aria-label="Back to chats">
          <ArrowLeftIcon size={20} />
        </button>
        <button
          className="avatar-btn"
          onClick={() => onOpenProfile(user.username)}
          aria-label={`View ${user.username}'s profile`}
          title="View profile"
        >
          <Avatar user={user} size={40} online={user.online ?? false} />
        </button>
        <div className="chat-header-info">
          <strong>{user.name || user.username}</strong>
          <span className={`chat-header-sub ${isTyping ? 'typing' : user.online ? 'online' : ''}`}>
            {isTyping ? (<>typing<TypingDots /></>) : user.online ? 'online' : 'offline'}
          </span>
        </div>
      </header>

      <div className="messages" ref={scrollRef} onScroll={onScroll}>
        <div className="messages-inner">
          {visible < count && (
            <div className="load-earlier">Scroll up for earlier messages…</div>
          )}
          {messages.slice(-visible).map((m, i, shown) => {
            const prev = shown[i - 1]
            const next = shown[i + 1]
            const mine = m.sender === me.username
            const newDay = !prev || dayLabel(prev.ts) !== dayLabel(m.ts)
            const tail = !next || next.sender !== m.sender || next.ts - m.ts > 180
            return (
              <div key={m.client_id || m.id}>
                {newDay && (
                  <div className="day-sep"><span>{dayLabel(m.ts)}</span></div>
                )}
                <Bubble
                  msg={m}
                  mine={mine}
                  tail={tail}
                  picker={picker === m.id}
                  onPickerToggle={(id) => setPicker(picker === id ? null : id)}
                  onReact={(id, emoji) => { setPicker(null); onReact(id, emoji) }}
                />
              </div>
            )
          })}

          {isTyping && (
            <div className="row theirs tail typing-row">
              <div className="bubble typing-bubble"><TypingDots /></div>
            </div>
          )}
        </div>
      </div>

      <form className="composer" onSubmit={submit}>
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => handleTyping(e.target.value)}
          placeholder="Type a message"
          aria-label="Message"
          maxLength={2000}
        />
        <button className="send-btn" disabled={!draft.trim()} aria-label="Send">
          <SendIcon size={19} />
        </button>
      </form>
    </main>
  )
}
