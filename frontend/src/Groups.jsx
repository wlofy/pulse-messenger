import { useEffect, useState } from 'react'
import { api } from './api.js'
import Avatar from './Avatar.jsx'
import { PlusIcon, XIcon } from './icons.jsx'

const NO_CONTACTS = 'No contacts yet — someone becomes a contact once they reply to your message.'

function useEscape(onClose) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
}

// null while loading. The server decides who counts; the list is only a menu.
function useContacts() {
  const [contacts, setContacts] = useState(null)
  useEffect(() => { api.contacts().then(setContacts).catch(() => setContacts([])) }, [])
  return contacts
}

export function NewGroup({ onClose, onCreated }) {
  const contacts = useContacts()
  const [name, setName] = useState('')
  const [picked, setPicked] = useState([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  useEscape(onClose)

  const toggle = (u) => setPicked((p) => (p.includes(u) ? p.filter((x) => x !== u) : [...p, u]))

  const submit = async (e) => {
    e.preventDefault()
    if (!name.trim() || !picked.length || busy) return
    setBusy(true)
    setErr('')
    try {
      onCreated(await api.createGroup(name.trim(), picked))
    } catch (e2) {
      setErr(e2.message)
      setBusy(false)
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <form className="profile-card group-card" role="dialog" aria-label="New group"
            onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <button type="button" className="icon-btn profile-close" onClick={onClose} aria-label="Close">
          <XIcon size={16} />
        </button>
        <h2 className="group-title">New group</h2>
        <label className="setup-field">
          <span>Group name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60}
                 placeholder="Weekend plans" autoFocus />
        </label>
        <span className="setup-field-label">Add contacts</span>
        {contacts === null ? (
          <p className="group-note">Loading contacts…</p>
        ) : contacts.length === 0 ? (
          <p className="group-note">{NO_CONTACTS}</p>
        ) : (
          <div className="event-picker">
            {contacts.map((u) => (
              <button type="button" key={u.username}
                      className={`event-chip ${picked.includes(u.username) ? 'on' : ''}`}
                      onClick={() => toggle(u.username)} aria-pressed={picked.includes(u.username)}>
                <Avatar user={u} size={20} />
                {u.name || u.username}
              </button>
            ))}
          </div>
        )}
        {err && <p className="setup-error">{err}</p>}
        <button className="btn-primary" disabled={busy || !name.trim() || !picked.length}>
          {busy ? <span className="spinner" aria-label="creating" />
            : picked.length ? `Create group · ${picked.length + 1} people` : 'Create group'}
        </button>
      </form>
    </div>
  )
}

export function GroupInfo({ me, group, onClose, onChanged, onLeft }) {
  const contacts = useContacts()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  useEscape(onClose)

  const byName = Object.fromEntries((contacts || []).map((c) => [c.username, c]))
  const addable = (contacts || []).filter((c) => !group.members.includes(c.username))

  const run = async (fn) => {
    setBusy(true)
    setErr('')
    try { await fn() } catch (e) { setErr(e.message) }
    setBusy(false)
  }
  const add = (username) => run(async () => onChanged(await api.addGroupMember(group.group_id, username)))
  const leave = () => {
    if (!confirm(`Leave "${group.name}"? You'll stop getting its messages.`)) return
    run(async () => { await api.leaveGroup(group.group_id); onLeft() })
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="profile-card group-card" role="dialog" aria-label={`${group.name} info`}
           onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn profile-close" onClick={onClose} aria-label="Close">
          <XIcon size={16} />
        </button>
        <div className="profile-view">
          <Avatar user={{ username: group.name }} size={84} />
          <h2 className="profile-name">{group.name}</h2>
          <span className="profile-handle">{group.members.length} members</span>
        </div>

        <ul className="group-members">
          {group.members.map((m) => (
            <li key={m}>
              <Avatar user={m === me.username ? me : byName[m] || { username: m }} size={30} />
              <span>{m === me.username ? 'You' : byName[m]?.name || m}</span>
              {m === group.creator && <em>creator</em>}
            </li>
          ))}
        </ul>

        {addable.length > 0 && (
          <>
            <span className="setup-field-label">Add your contacts</span>
            <div className="event-picker">
              {addable.map((u) => (
                <button type="button" key={u.username} className="event-chip" disabled={busy}
                        onClick={() => add(u.username)} aria-label={`Add ${u.username}`}>
                  <PlusIcon size={13} />
                  {u.name || u.username}
                </button>
              ))}
            </div>
          </>
        )}
        {err && <p className="setup-error">{err}</p>}
        <button type="button" className="btn-ghost danger" disabled={busy} onClick={leave}>
          Leave group
        </button>
      </div>
    </div>
  )
}
