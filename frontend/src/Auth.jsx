import { useEffect, useRef, useState } from 'react'
import { api } from './api.js'
import Avatar from './Avatar.jsx'
import { CameraIcon, MessageIcon, XIcon } from './icons.jsx'

// Resize any picked image to a 128px cover-cropped JPEG data URL (~10 KB).
export function toAvatar(file) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const S = 128
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = S
      const scale = Math.max(S / img.width, S / img.height)
      const w = img.width * scale
      const h = img.height * scale
      canvas.getContext('2d').drawImage(img, (S - w) / 2, (S - h) / 2, w, h)
      URL.revokeObjectURL(img.src)
      resolve(canvas.toDataURL('image/jpeg', 0.82))
    }
    img.onerror = reject
    img.src = URL.createObjectURL(file)
  })
}

export default function Auth({ onDone }) {
  const [mode, setMode] = useState('login') // 'login' | 'signup'
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [avatar, setAvatar] = useState(null)
  const [taken, setTaken] = useState(null) // null = unknown yet
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const fileRef = useRef()

  const signup = mode === 'signup'

  // Live "is this username free?" check while signing up, debounced.
  useEffect(() => {
    setTaken(null)
    const name = username.trim()
    if (!signup || !name) return
    const timer = setTimeout(() => {
      api.exists(name).then((r) => setTaken(r.taken)).catch(() => {})
    }, 350)
    return () => clearTimeout(timer)
  }, [username, signup])

  const switchMode = (m) => {
    setMode(m)
    setError('')
  }

  const passwordOk = password.length >= 6
  const canSubmit = username.trim() && passwordOk && !busy && !(signup && taken === true)

  const submit = async (e) => {
    e.preventDefault()
    if (!canSubmit) return
    setBusy(true)
    setError('')
    try {
      const user = signup
        ? await api.signup(username.trim(), password, avatar)
        : await api.login(username.trim(), password)
      onDone(user)
    } catch (err) {
      setError(err.message === 'Failed to fetch'
        ? "Couldn't reach the server — is it running?"
        : err.message)
      setBusy(false)
    }
  }

  return (
    <div className="setup">
      <form className="setup-card" onSubmit={submit}>
        <div className="setup-brand">
          <span className="setup-logo"><MessageIcon size={26} /></span>
          <h1>Pulse</h1>
        </div>

        <div className="auth-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={!signup}
                  className={`auth-tab ${!signup ? 'active' : ''}`}
                  onClick={() => switchMode('login')}>
            Sign in
          </button>
          <button type="button" role="tab" aria-selected={signup}
                  className={`auth-tab ${signup ? 'active' : ''}`}
                  onClick={() => switchMode('signup')}>
            Create account
          </button>
        </div>

        {signup && (
          <div className="setup-avatar">
            <button
              type="button"
              className="setup-avatar-btn"
              onClick={() => fileRef.current.click()}
              aria-label="Choose profile picture"
            >
              <Avatar user={{ username: username || '?', avatar }} size={96} />
              <span className="setup-avatar-badge"><CameraIcon size={15} /></span>
            </button>
            {avatar && (
              <button type="button" className="setup-avatar-clear" onClick={() => setAvatar(null)}>
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
                if (f) setAvatar(await toAvatar(f))
                e.target.value = ''
              }}
            />
          </div>
        )}

        <label className="setup-field">
          <span>Username</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="e.g. alice"
            maxLength={24}
            autoFocus
            autoComplete="username"
            spellCheck="false"
          />
          {signup && username.trim() && taken !== null && (
            <span className={`auth-hint ${taken ? 'bad' : 'ok'}`} role="status">
              @{username.trim()} is {taken ? 'already taken' : 'available'}
            </span>
          )}
        </label>

        <label className="setup-field">
          <span>Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={signup ? 'At least 6 characters' : 'Your password'}
            autoComplete={signup ? 'new-password' : 'current-password'}
          />
          {signup && password && !passwordOk && (
            <span className="auth-hint bad" role="status">at least 6 characters</span>
          )}
        </label>

        {error && <p className="setup-error" role="alert">{error}</p>}

        <button className="btn-primary" disabled={!canSubmit}>
          {busy
            ? <span className="spinner" aria-label="loading" />
            : signup ? 'Create account' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}
