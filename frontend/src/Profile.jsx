import { useEffect, useRef, useState } from 'react'
import { api } from './api.js'
import Avatar from './Avatar.jsx'
import { toAvatar } from './Auth.jsx'
import { CameraIcon, XIcon } from './icons.jsx'

// view: 'me' -> edit my profile; any username -> read-only card of that user.
export default function ProfilePanel({ me, view, onClose, onMeChange }) {
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
