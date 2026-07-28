import { useEffect, useRef, useState } from 'react'
import { api } from './api.js'
import { SendIcon, SparklesIcon, XIcon } from './icons.jsx'

// Pulse AI — floating assistant docked bottom-right of the app, above the composer. The
// transcript is local to this widget: every question is answered on its own, so
// closing the window (or a reload) starts a fresh conversation rather than
// pretending to a memory the server doesn't keep.
export default function Assistant() {
  const [open, setOpen] = useState(false)
  const [turns, setTurns] = useState([])   // {who: 'me' | 'bot', text}
  const [q, setQ] = useState('')
  const [pending, setPending] = useState(false)
  const input = useRef(null)
  const log = useRef(null)

  useEffect(() => { if (open) input.current?.focus() }, [open])

  // keep the newest turn in view, including the "Thinking…" placeholder
  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight
  }, [turns, pending, open])

  useEffect(() => {
    if (!open) return
    const onKey = (e) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const ask = (e) => {
    e.preventDefault()
    const question = q.trim()
    if (!question || pending) return
    setTurns((t) => [...t, { who: 'me', text: question }])
    setQ('')
    setPending(true)
    api.ask(question)
      .then((r) => setTurns((t) => [...t, { who: 'bot', text: r.answer }]))
      .catch((err) => setTurns((t) => [...t, { who: 'bot', text: err.message, error: true }]))
      .finally(() => setPending(false))
  }

  return (
    <div className="assistant">
      {open && (
        <section className="assistant-win" role="dialog" aria-label="Pulse AI">
          <header className="assistant-head">
            <SparklesIcon size={15} />
            <strong>Pulse AI</strong>
          </header>

          <div className="assistant-log" ref={log}>
            {turns.length === 0 && !pending && (
              <div className="assistant-hint">
                <p>Ask Pulse AI about your events.</p>
                <span>“what's on next week?” · “who's coming to the BBQ?”</span>
              </div>
            )}
            {/* model-generated text, rendered as a JSX string so React escapes it — never HTML */}
            {turns.map((t, i) => (
              <div key={i} className={`assistant-msg ${t.who}${t.error ? ' error' : ''}`}>{t.text}</div>
            ))}
            {pending && (
              <div className="assistant-msg bot thinking" aria-live="polite">
                <span /><span /><span />
              </div>
            )}
          </div>

          <form className="assistant-input" onSubmit={ask}>
            <input
              ref={input}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              maxLength={500}
              placeholder="Type here…"
              aria-label="Ask Pulse AI"
            />
            <button type="submit" className="icon-btn" disabled={pending || !q.trim()} aria-label="Send">
              <SendIcon size={17} />
            </button>
          </form>
        </section>
      )}

      <button
        className={`assistant-fab${open ? ' open' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? 'Close Pulse AI' : 'Ask Pulse AI'}
        aria-expanded={open}
        title={open ? 'Close Pulse AI' : 'Ask Pulse AI'}
      >
        {open ? <XIcon size={19} /> : <SparklesIcon size={20} />}
      </button>
    </div>
  )
}
