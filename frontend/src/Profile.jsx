import { useEffect, useRef, useState } from 'react'
import { api } from './api.js'
import Avatar from './Avatar.jsx'
import { toAvatar } from './Auth.jsx'
import { CameraIcon, CheckIcon, XIcon } from './icons.jsx'

// Each entry names a `data-accent` value in styles.css; the swatch previews the
// two hues that theme actually paints with, so the dot IS the theme.
const ACCENTS = [
  { id: 'blue', label: 'Blue', from: '#4f6ef7', to: '#8b7cf6' },
  { id: 'violet', label: 'Violet', from: '#7c5cf7', to: '#f0abfc' },
  { id: 'emerald', label: 'Emerald', from: '#0ea47a', to: '#22d3ee' },
  { id: 'rose', label: 'Rose', from: '#e8385b', to: '#f472b6' },
  { id: 'amber', label: 'Amber', from: '#d97706', to: '#fbbf24' },
]

// view: 'me' -> edit my profile; any username -> read-only card of that user.
export default function ProfilePanel({ me, view, accent, onAccentChange, onClose, onMeChange }) {
  const mine = view === 'me'
  const [other, setOther] = useState(null) // fetched profile when viewing someone else

  const [name, setName] = useState(me.name || '')
  const [bio, setBio] = useState(me.bio || '')
  const [avatar, setAvatar] = useState(me.avatar)
  const [avatarChanged, setAvatarChanged] = useState(false)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef()

  useEffect(() => {
    if (!mine) api.profile(view).then(setOther).catch(onClose)
  }, [mine, view, onClose])

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const save = async (e) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    try {
      const updated = await api.updateProfile({
        name,
        bio,
        ...(avatarChanged ? { avatar: avatar || '' } : {}), // omitted = unchanged
      })
      onMeChange(updated)
      onClose()
    } catch {
      setBusy(false)
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div
        className="profile-card"
        role="dialog"
        aria-label={mine ? 'Edit profile' : `${view}'s profile`}
        onClick={(e) => e.stopPropagation()}
      >
        <button className="icon-btn profile-close" onClick={onClose} aria-label="Close">
          <XIcon size={16} />
        </button>

        {mine ? (
          <form className="profile-form" onSubmit={save}>
            <div className="profile-head">
              <button
                type="button"
                className="setup-avatar-btn"
                onClick={() => fileRef.current.click()}
                aria-label="Change profile picture"
              >
                <Avatar user={{ username: me.username, avatar }} size={96} />
                <span className="setup-avatar-badge"><CameraIcon size={15} /></span>
              </button>
              {avatar && (
                <button
                  type="button"
                  className="setup-avatar-clear"
                  onClick={() => { setAvatar(null); setAvatarChanged(true) }}
                >
                  <XIcon size={12} /> Remove photo
                </button>
              )}
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                hidden
                onChange={async (e) => {
                  const f = e.target.files[0]
                  if (f) { setAvatar(await toAvatar(f)); setAvatarChanged(true) }
                  e.target.value = ''
                }}
              />
              <span className="profile-handle">@{me.username}</span>
            </div>

            <label className="setup-field">
              <span>Display name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={me.username}
                maxLength={40}
                autoFocus
              />
            </label>

            <label className="setup-field">
              <span>Bio</span>
              <textarea
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                placeholder="Something about you…"
                maxLength={300}
                rows={3}
              />
              <span className="bio-count">{bio.length}/300</span>
            </label>

            <button className="btn-primary" disabled={busy}>
              {busy ? <span className="spinner" aria-label="saving" /> : 'Save'}
            </button>

            {/* outside the save flow on purpose: it applies instantly and is stored
                on this device, not on the account */}
            <div className="accent-picker" role="radiogroup" aria-label="Accent colour">
              <span className="setup-field-label">Theme colour</span>
              <div className="accent-row">
                {ACCENTS.map((a) => (
                  <button
                    type="button"
                    key={a.id}
                    role="radio"
                    aria-checked={accent === a.id}
                    aria-label={a.label}
                    title={a.label}
                    className={`accent-dot${accent === a.id ? ' on' : ''}`}
                    style={{ '--sw-from': a.from, '--sw-to': a.to }}
                    onClick={() => onAccentChange(a.id)}
                  >
                    {accent === a.id && <CheckIcon size={14} />}
                  </button>
                ))}
              </div>
            </div>
          </form>
        ) : !other ? (
          <div className="profile-loading"><span className="spinner" aria-label="loading" /></div>
        ) : (
          <div className="profile-view">
            <Avatar user={other} size={110} online={other.online} />
            <h2 className="profile-name">{other.name || other.username}</h2>
            <span className="profile-handle">
              @{other.username} · {other.online ? <em className="is-online">online</em> : 'offline'}
            </span>
            {other.bio
              ? <p className="profile-bio">{other.bio}</p>
              : <p className="profile-bio empty">No bio yet.</p>}
          </div>
        )}
      </div>
    </div>
  )
}
