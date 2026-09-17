import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { mediaUrl } from './api.js'
import Avatar from './Avatar.jsx'
import {
  ArrowLeftIcon, BellOffIcon, ImageIcon, MicIcon, PauseIcon, PlayIcon, PulseLogo, ScanEyeIcon, SendIcon,
  SmilePlusIcon, Ticks, XIcon,
} from './icons.jsx'
import { altTextFor, bestReadyEngine, detectIn, prepareImage } from './vision.js'

const QUICK_REACTIONS = ['❤️', '😂', '👍', '😮', '😢', '🔥']
const PAGE = 40 // messages rendered at once; older ones load as you scroll up
const MAX_VOICE_SECONDS = 300 // the server rejects anything longer

const fmtDuration = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

// A custom player rather than <audio controls>: MediaRecorder's webm reports an
// Infinity duration in Chrome, so the native scrubber is broken. The recorder's
// own clock (sent with the upload) is the length we trust.
function VoiceNote({ src, duration }) {
  const audio = useRef()
  const [playing, setPlaying] = useState(false)
  const [at, setAt] = useState(0)
  const total = duration || 0

  const toggle = () => {
    const a = audio.current
    if (a.paused) a.play().catch(() => setPlaying(false))
    else a.pause()
  }

  return (
    <div className="voice-note">
      <button type="button" className="voice-play" onClick={toggle}
              aria-label={playing ? 'Pause voice message' : 'Play voice message'}>
        {playing ? <PauseIcon size={15} /> : <PlayIcon size={15} />}
      </button>
      <input
        type="range"
        className="voice-seek"
        min="0"
        max={total || 1}
        step="0.1"
        value={Math.min(at, total || 1)}
        style={{ '--pct': `${total ? Math.min(at / total, 1) * 100 : 0}%` }}
        onChange={(e) => { audio.current.currentTime = +e.target.value; setAt(+e.target.value) }}
        aria-label="Seek"
        aria-valuetext={fmtDuration(at)}
      />
      <span className="voice-time">{fmtDuration(playing || at ? at : total)}</span>
      <audio
        ref={audio}
        src={src}
        preload="none"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setAt(0) }}
        onTimeUpdate={(e) => setAt(e.currentTarget.currentTime)}
      />
    </div>
  )
}

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

function Bubble({ msg, mine, tail, author, picker, onPickerToggle, onReact, onOpenImage }) {
  // Optimistic sends carry `localUrl` — the photo or recording is on screen before
  // the upload finishes, so the bubble never shows an empty box.
  const voice = msg.media_mime?.startsWith('audio/')
  const photo = !voice && (msg.media_id || msg.localUrl)
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

        <div className={`bubble ${photo ? 'has-photo' : ''}`}>
          {author && <span className="bubble-author">{author}</span>}
          {voice && <VoiceNote src={msg.localUrl || mediaUrl(msg.media_id)} duration={msg.media_duration} />}
          {photo && (
            <button
              className="bubble-photo"
              onClick={(e) => { e.stopPropagation(); msg.media_id && onOpenImage(msg) }}
              disabled={!msg.media_id}
              title={msg.media_id ? 'See what the model sees' : 'Uploading…'}
            >
              {/* alt is the description the sender's device generated. Empty when
                  the detector recognized nothing — an empty alt is correct there,
                  and far better than narrating a guess. */}
              <img
                src={msg.localUrl || mediaUrl(msg.media_id)}
                alt={msg.alt || ''}
                style={msg.media_w ? { aspectRatio: `${msg.media_w} / ${msg.media_h}` } : undefined}
              />
              {msg.media_id && (
                <span className="bubble-photo-cue"><ScanEyeIcon size={14} /> Explain</span>
              )}
            </button>
          )}
          {msg.text && <span className="bubble-text">{msg.text}</span>}
          <span className="bubble-meta">
            {fmtTime(msg.ts)}
            {mine && (msg.status === 'failed'
              ? <span className="bubble-failed">Not sent</span>
              // groups have no delivery receipts, only the "still sending" clock
              : (!msg.group_id || msg.status === 'pending') && <Ticks status={msg.status} />)}
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

export default function Chat({ me, user, messages, isTyping, onSend, onTyping, onReact, onOpenProfile, onOpenImage,
                               onOpenGroup, onUnblock, onBack }) {
  const chatKey = user ? (user.group_id ?? user.username) : null
  const [draft, setDraft] = useState('')
  const [picker, setPicker] = useState(null) // message id with open reaction picker
  const [visible, setVisible] = useState(PAGE) // how many trailing messages we render
  const [attachment, setAttachment] = useState(null) // staged photo, pre-send
  const [dragging, setDragging] = useState(false)
  const scrollRef = useRef()
  const lastTypingSent = useRef(0)
  const inputRef = useRef()
  const fileRef = useRef()
  const keepScroll = useRef(null) // scrollHeight snapshot, set only when loading older

  // Pin to bottom on new messages / typing bubble; instant on chat switch.
  const count = messages.length
  useLayoutEffect(() => {
    if (keepScroll.current != null) return // a "load earlier" render owns the scroll
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chatKey, count, isTyping])

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
    setAttachment(null) // a staged photo belongs to the chat it was staged in
    setVisible(PAGE) // fresh window per conversation
    inputRef.current?.focus()
    return () => stopRecording(false) // a half-recorded note belongs to the chat it started in
  }, [chatKey])

  // --- voice messages ---------------------------------------------------------
  const [recording, setRecording] = useState(null) // {secs} while the mic is live
  const recorder = useRef(null)
  const canRecord = typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia

  // send=false discards. Either way the mic is released in onstop.
  function stopRecording(send) {
    const r = recorder.current
    if (!r) return
    recorder.current = null
    r.shouldSend = send
    clearInterval(r.timer)
    if (r.state !== 'inactive') r.stop()
    setRecording(null)
  }

  const startRecording = async () => {
    if (recorder.current) return
    let stream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      setAttachment({ error: 'Microphone access is blocked — allow it in your browser to send voice messages.' })
      return
    }
    // 32 kbps opus is clear for speech and keeps 5 minutes around 1.2 MB, well under the upload cap
    const r = new MediaRecorder(stream, { audioBitsPerSecond: 32000 })
    const chunks = []
    const started = Date.now()
    r.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
    r.onstop = () => {
      stream.getTracks().forEach((t) => t.stop()) // turns off the browser's recording indicator
      const duration = Math.min((Date.now() - started) / 1000, MAX_VOICE_SECONDS)
      if (!r.shouldSend || duration < 0.5) return // a stray tap, not a message
      const blob = new Blob(chunks, { type: r.mimeType || 'audio/webm' })
      const reader = new FileReader()
      reader.onload = () => onSend('', null, { dataUrl: reader.result, duration, mime: blob.type.split(';')[0] })
      reader.readAsDataURL(blob)
    }
    r.timer = setInterval(() => {
      const secs = (Date.now() - started) / 1000
      if (secs >= MAX_VOICE_SECONDS) stopRecording(true)
      else setRecording({ secs })
    }, 250)
    recorder.current = r
    setAttachment(null)
    r.start()
    setRecording({ secs: 0 })
  }

  // Stage a photo: decode and downscale it, then describe it locally. The
  // description is the ONLY thing here that will leave the device, and only
  // once the user hits send — which is why it's shown in an editable field
  // rather than attached silently.
  const attach = async (file) => {
    if (!file || !file.type.startsWith('image/')) return
    setAttachment({ decoding: true })
    let staged
    try {
      staged = await prepareImage(file)
    } catch (e) {
      setAttachment({ error: e.message })
      return
    }
    const { canvas, dataUrl, width, height } = staged
    setAttachment({ dataUrl, width, height, alt: '', describing: true })
    // Only overwrite if this is still the staged photo — the user may have
    // removed or replaced it during the (first-run: multi-second) model download.
    const ifCurrent = (fn) => setAttachment((a) => (a?.dataUrl === dataUrl ? fn(a) : a))
    try {
      const preds = await detectIn(canvas, bestReadyEngine())
      ifCurrent((a) => ({ ...a, alt: altTextFor(preds), describing: false }))
    } catch (e) {
      // Best-effort by design: a blocked CDN or an old GPU must never stop
      // someone sending a photo. They just don't get a suggested description.
      console.warn('local description unavailable', e)
      ifCurrent((a) => ({ ...a, describing: false }))
    }
  }

  const onPaste = (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'))
    if (item) { e.preventDefault(); attach(item.getAsFile()) }
  }

  const onDrop = (e) => {
    e.preventDefault()
    setDragging(false)
    const file = [...(e.dataTransfer?.files || [])].find((f) => f.type.startsWith('image/'))
    if (file) attach(file)
  }

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
          <span className="chat-empty-logo beating"><PulseLogo size={44} /></span>
          <h2 className="wordmark">Pulse <span>Messenger</span></h2>
          <p className="slogan">Conversations with a pulse.</p>
          <p>Pick a conversation, or search a username to start one.</p>
        </div>
      </main>
    )
  }

  const submit = (e) => {
    e.preventDefault()
    const text = draft.trim()
    const photo = attachment?.dataUrl ? attachment : null
    if (!text && !photo) return
    // Deliberately NOT blocked on `describing`: the first photo of a session waits
    // on a 6 MB model download, and holding someone's message hostage to that is
    // worse than sending it without a description.
    onSend(text, photo)
    setDraft('')
    setAttachment(null)
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
    <main
      className={`chat ${dragging ? 'dropping' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false) }}
      onDrop={onDrop}
    >
      <header className="chat-header">
        <button className="icon-btn chat-back" onClick={onBack} aria-label="Back to chats">
          <ArrowLeftIcon size={20} />
        </button>
        <button
          className="avatar-btn"
          onClick={() => (user.group_id ? onOpenGroup() : onOpenProfile(user.username))}
          aria-label={user.group_id ? `${user.name} group info` : `View ${user.username}'s profile`}
          title={user.group_id ? 'Group info' : 'View profile'}
        >
          {user.group_id
            ? <Avatar user={{ username: user.name }} size={40} />
            : <Avatar user={user} size={40} online={user.online ?? false} />}
        </button>
        <div className="chat-header-info">
          <strong>
            {user.name || user.username}
            {user.muted && <BellOffIcon size={13} className="muted-icon" role="img" aria-hidden={false} aria-label="muted" />}
          </strong>
          {user.group_id ? (
            <button type="button" className="chat-header-sub chat-header-members" onClick={onOpenGroup}>
              {user.members?.join(', ')}
            </button>
          ) : (
            <span className={`chat-header-sub ${isTyping ? 'typing' : user.online ? 'online' : ''}`}>
              {isTyping ? (<>typing<TypingDots /></>) : user.online ? 'online' : 'offline'}
            </span>
          )}
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
            // in a group, name whoever starts each run of messages
            const author = user.group_id && !mine && (newDay || prev.sender !== m.sender) ? m.sender : null
            return (
              <div key={m.client_id || m.id}>
                {newDay && (
                  <div className="day-sep"><span>{dayLabel(m.ts)}</span></div>
                )}
                <Bubble
                  msg={m}
                  mine={mine}
                  tail={tail}
                  author={author}
                  picker={picker === m.id}
                  onPickerToggle={(id) => setPicker(picker === id ? null : id)}
                  onReact={(id, emoji) => { setPicker(null); onReact(id, emoji) }}
                  onOpenImage={onOpenImage}
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

      {user.blocked ? (
        <div className="composer-blocked">
          <span>You blocked {user.name || user.username}. They can't message you.</span>
          <button type="button" onClick={onUnblock}>Unblock</button>
        </div>
      ) : (<>
      {attachment && (
        <div className="attach-strip">
          {attachment.error ? (
            <p className="attach-error">{attachment.error}</p>
          ) : attachment.decoding ? (
            <p className="attach-note">Opening photo…</p>
          ) : (
            <>
              <img className="attach-thumb" src={attachment.dataUrl} alt="" />
              <div className="attach-body">
                <label className="attach-label" htmlFor="attach-alt">
                  Description sent with this photo
                </label>
                <input
                  id="attach-alt"
                  className="attach-alt"
                  value={attachment.alt}
                  onChange={(e) => setAttachment((a) => ({ ...a, alt: e.target.value }))}
                  placeholder={attachment.describing ? 'Looking at your photo…' : 'Add a description (optional)'}
                  maxLength={500}
                />
                <p className="attach-note">
                  {attachment.describing
                    ? 'Recognizing objects on your device — the photo is not uploaded for this.'
                    : 'Written on your device, then sent with the photo. Edit or clear it.'}
                </p>
              </div>
            </>
          )}
          <button
            type="button"
            className="icon-btn"
            onClick={() => setAttachment(null)}
            aria-label="Remove photo"
          >
            <XIcon size={16} />
          </button>
        </div>
      )}

      <form className="composer" onSubmit={submit}>
        {recording ? (
          <>
            <button type="button" className="icon-btn" onClick={() => stopRecording(false)}
                    aria-label="Discard voice message" title="Discard">
              <XIcon size={18} />
            </button>
            <div className="rec-status" role="status">
              <span className="rec-dot" aria-hidden="true" />
              Recording {fmtDuration(recording.secs)}
            </div>
            <button type="button" className="send-btn" onClick={() => stopRecording(true)}
                    aria-label="Send voice message">
              <SendIcon size={19} />
            </button>
          </>
        ) : (<>
        <button
          type="button"
          className="icon-btn attach-btn"
          onClick={() => fileRef.current?.click()}
          aria-label="Attach a photo"
          title="Attach a photo"
        >
          <ImageIcon size={20} />
        </button>
        <input
          type="file"
          accept="image/*"
          hidden
          ref={fileRef}
          onChange={(e) => { attach(e.target.files[0]); e.target.value = '' }}
        />
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => handleTyping(e.target.value)}
          onPaste={onPaste}
          placeholder={attachment?.dataUrl ? 'Add a caption' : 'Type a message'}
          aria-label="Message"
          maxLength={2000}
        />
        {canRecord && !draft.trim() && !attachment?.dataUrl ? (
          <button type="button" className="send-btn" onClick={startRecording}
                  aria-label="Record a voice message" title="Record a voice message">
            <MicIcon size={19} />
          </button>
        ) : (
          <button className="send-btn" disabled={!draft.trim() && !attachment?.dataUrl} aria-label="Send">
            <SendIcon size={19} />
          </button>
        )}
        </>)}
      </form>
      </>)}
    </main>
  )
}
