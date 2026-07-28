import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api.js'
import Avatar from './Avatar.jsx'
import { ArrowLeftIcon, CheckIcon, PlusIcon, XIcon } from './icons.jsx'

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
const pad = (n) => String(n).padStart(2, '0')

// Local calendar day, not UTC — an event at 01:00 belongs to the day you'd say it does.
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const keyOfTs = (ts) => dayKey(new Date(ts * 1000))
const timeOf = (ts) => new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

// The 6x7 block a month grid needs: back to the Sunday on or before the 1st, 42 days on.
function monthCells(cursor) {
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1)
  const start = new Date(first)
  start.setDate(1 - first.getDay())
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    return d
  })
}

export default function Events({ me, onClose }) {
  const [events, setEvents] = useState(null)     // null = still loading
  const [err, setErr] = useState('')
  const [cursor, setCursor] = useState(() => new Date())
  const [selected, setSelected] = useState(() => dayKey(new Date()))
  const [composing, setComposing] = useState(false)

  const load = () => api.events().then(setEvents).catch((e) => setErr(e.message))
  useEffect(() => { load() }, [])

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // one bucket per day, so a cell render is a lookup rather than a scan
  const byDay = useMemo(() => {
    const m = new Map()
    for (const ev of events || []) {
      const k = keyOfTs(ev.event_date)
      if (!m.has(k)) m.set(k, [])
      m.get(k).push(ev)
    }
    for (const list of m.values()) list.sort((a, b) => a.event_date - b.event_date)
    return m
  }, [events])

  const cells = useMemo(() => monthCells(cursor), [cursor])
  const todayKey = dayKey(new Date())
  const dayEvents = byDay.get(selected) || []

  const step = (delta) =>
    setCursor((c) => new Date(c.getFullYear(), c.getMonth() + delta, 1))

  const goToday = () => {
    const now = new Date()
    setCursor(new Date(now.getFullYear(), now.getMonth(), 1))
    setSelected(dayKey(now))
  }

  const answer = (id, status) =>
    api.rsvp(id, status)
      .then(() => setEvents((es) => es.map((e) =>
        e.id === id
          ? { ...e, my_status: status,
              attendees: e.attendees.map((a) => (a.invitee === me.username ? { ...a, status } : a)) }
          : e)))
      .catch((e) => setErr(e.message))

  return (
    <div className="overlay" onClick={onClose}>
      <div className="events-panel" role="dialog" aria-label="Events" onClick={(e) => e.stopPropagation()}>
        <header className="cal-head">
          <button className="icon-btn" onClick={() => step(-1)} aria-label="Previous month">
            <ArrowLeftIcon size={17} />
          </button>
          <h2>{cursor.toLocaleDateString([], { month: 'long', year: 'numeric' })}</h2>
          <button className="icon-btn cal-next" onClick={() => step(1)} aria-label="Next month">
            <ArrowLeftIcon size={17} />
          </button>
          <button className="cal-today" onClick={goToday}>Today</button>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <XIcon size={16} />
          </button>
        </header>

        <div className="cal-weekdays">
          {WEEKDAYS.map((d, i) => <span key={i}>{d}</span>)}
        </div>

        <div className="cal-grid">
          {cells.map((d) => {
            const k = dayKey(d)
            const list = byDay.get(k) || []
            const outside = d.getMonth() !== cursor.getMonth()
            return (
              <button
                key={k}
                className={`cal-cell${outside ? ' outside' : ''}${k === selected ? ' selected' : ''}`}
                onClick={() => setSelected(k)}
                aria-label={`${d.toDateString()}, ${list.length} events`}
                aria-pressed={k === selected}
              >
                <span className={`cal-num${k === todayKey ? ' today' : ''}`}>{d.getDate()}</span>
                {/* the chips are the point: you see what's on without opening a day */}
                <span className="cal-chips">
                  {list.slice(0, 2).map((ev) => (
                    <span key={ev.id} className={`cal-chip ${ev.my_status}`} title={ev.title}>
                      {ev.title}
                    </span>
                  ))}
                  {list.length > 2 && <span className="cal-more">+{list.length - 2}</span>}
                </span>
              </button>
            )
          })}
        </div>

        {err && <p className="notif-error">{err}</p>}

        <div className="cal-day">
          {/* the add button lives with the open day, so it's never ambiguous which
              date you're adding to — the form below opens pre-filled with it */}
          <div className="cal-day-head">
            <h3>{selectedLabel(selected)}</h3>
            <button
              className="cal-add"
              onClick={() => { setErr(''); setComposing((c) => !c) }}
              aria-expanded={composing}
            >
              {composing ? <XIcon size={13} /> : <PlusIcon size={13} />}
              {composing ? 'Cancel' : 'Add event'}
            </button>
          </div>

          {composing && (
            <NewEvent
              key={selected}      /* re-init on day change so the date always matches */
              day={selected}
              onCancel={() => setComposing(false)}
              onCreated={() => { setComposing(false); load() }}
              onError={setErr}
            />
          )}

          {events === null ? (
            <p className="cal-day-empty">Loading…</p>
          ) : dayEvents.length === 0 ? (
            <p className="cal-day-empty">Nothing on this day.</p>
          ) : (
            dayEvents.map((ev, i) => (
              <div key={ev.id} className="event-item" style={{ '--i': i }}>
                <div className="event-top">
                  <span className="event-title">{ev.title}</span>
                  <span className={`event-tag ${ev.my_status}`}>{ev.my_status}</span>
                </div>
                <span className="event-when">
                  {timeOf(ev.event_date)}
                  {ev.creator !== me.username && ` · invited by ${ev.creator}`}
                </span>
                {ev.attendees.length > 0 && (
                  <div className="event-guests">
                    {ev.attendees.map((a) => (
                      <span key={a.invitee} className={`event-guest ${a.status}`} title={`${a.invitee} — ${a.status}`}>
                        <Avatar user={{ username: a.invitee }} size={20} />
                        {a.invitee}
                      </span>
                    ))}
                  </div>
                )}
                {/* creators hold no invitation row — there is nothing for them to answer */}
                {ev.my_status !== 'creator' && (
                  <div className="event-actions">
                    <button
                      className={`event-btn accept ${ev.my_status === 'accepted' ? 'on' : ''}`}
                      onClick={() => answer(ev.id, 'accepted')}
                    >
                      <CheckIcon size={15} /> Going
                    </button>
                    <button
                      className={`event-btn decline ${ev.my_status === 'declined' ? 'on' : ''}`}
                      onClick={() => answer(ev.id, 'declined')}
                    >
                      <XIcon size={15} /> Can't
                    </button>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

function selectedLabel(key) {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })
}

function NewEvent({ day, onCancel, onCreated, onError }) {
  // default to the day you have open, at the next whole hour
  const [title, setTitle] = useState('')
  const [when, setWhen] = useState(() => {
    const h = new Date(Date.now() + 3600e3).getHours()
    return `${day}T${pad(h)}:00`
  })
  const [people, setPeople] = useState([])
  const [picked, setPicked] = useState([])
  const [saving, setSaving] = useState(false)
  const first = useRef(null)

  useEffect(() => {
    api.users().then(setPeople).catch(() => {})
    first.current?.focus()
  }, [])

  const toggle = (username) =>
    setPicked((p) => (p.includes(username) ? p.filter((u) => u !== username) : [...p, username]))

  const submit = (e) => {
    e.preventDefault()
    const ts = new Date(when).getTime() / 1000
    if (!title.trim() || !Number.isFinite(ts)) return onError('Give the event a title and a date')
    setSaving(true)
    api.createEvent(title.trim(), ts, picked)
      .then(onCreated)
      .catch((err) => onError(err.message))
      .finally(() => setSaving(false))
  }

  return (
    <form className="event-form" onSubmit={submit}>
      <input
        ref={first}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        maxLength={100}
        placeholder="What's happening?"
        aria-label="Event title"
      />
      <input
        type="datetime-local"
        value={when}
        onChange={(e) => setWhen(e.target.value)}
        aria-label="When"
      />
      {people.length > 0 && (
        <>
          <span className="event-form-label">Invite</span>
          <div className="event-picker">
            {people.map((u) => (
              <button
                type="button"
                key={u.username}
                className={`event-chip ${picked.includes(u.username) ? 'on' : ''}`}
                onClick={() => toggle(u.username)}
                aria-pressed={picked.includes(u.username)}
              >
                <Avatar user={u} size={20} />
                {u.name || u.username}
              </button>
            ))}
          </div>
        </>
      )}
      <div className="event-form-actions">
        <button type="button" className="event-btn" onClick={onCancel}>Cancel</button>
        <button type="submit" className="event-btn primary" disabled={saving}>
          {saving ? 'Creating…' : 'Create event'}
        </button>
      </div>
    </form>
  )
}
