import { useCallback, useEffect, useRef, useState } from 'react'
import { mediaUrl } from './api.js'
import { ScanEyeIcon, XIcon } from './icons.jsx'
import {
  ENGINES, assignColors, detectIn, drawBoxes, drawHeatmap, explainScene,
  heatmapCaption, isEngineReady, loadEngine, runOcclusion, toCanvas,
} from './vision.js'

const DET_LIST_MAX = 20   // the list is for picking something to explain, not for inventory

/**
 * Tap a photo in a chat and this opens: the detector's boxes, a plain-language
 * reading of the scene, and — on demand — an occlusion heatmap showing which
 * pixels a given detection actually depends on.
 *
 * Everything runs in this tab on the viewer's own hardware. The sender's device
 * did its own pass to produce the description attached to the message; this is a
 * fresh, independent analysis for whoever is looking.
 */
// Default to the heavier, more accurate detector: this panel is the on-demand
// "look closer" surface, exactly where waiting on a bigger model is worth it.
const DEFAULT_ENGINE = 'accurate'

export default function ImageViewer({ message, title, onClose }) {
  const [engineKey, setEngineKey] = useState(DEFAULT_ENGINE)
  const [phase, setPhase] = useState('loading')   // loading | model | detecting | ready | error
  const [error, setError] = useState('')
  const [predictions, setPredictions] = useState([])
  const [inferenceMs, setInferenceMs] = useState(0)
  const [heat, setHeat] = useState(null)          // {result, target}
  const [progress, setProgress] = useState(null)  // {done, total, eta, label}
  const [download, setDownload] = useState(null)  // model download %, null when idle
  const [hover, setHover] = useState(null)        // detection index to spotlight

  const imgRef = useRef(null)
  const boxRef = useRef(null)
  const heatRef = useRef(null)
  const srcRef = useRef(null)      // natural-size canvas: the ONLY coordinate space
  const colorsRef = useRef(new Map())
  const cancelRef = useRef(false)
  const aliveRef = useRef(true)

  const url = mediaUrl(message.media_id)
  const engine = ENGINES[engineKey]

  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false; cancelRef.current = true }
  }, [])

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // The image is same-origin, so the canvas stays untainted and readable.
  const analyze = useCallback(async () => {
    const img = imgRef.current
    if (!img?.naturalWidth) return
    setError('')
    setHeat(null)
    try {
      // Detect on a canvas at NATURAL size, never on the rendered <img>: the
      // element is CSS-scaled inside the panel, and boxes measured against that
      // would be silently wrong everywhere.
      srcRef.current = toCanvas(img)
      const { width: W, height: H } = srcRef.current
      for (const c of [boxRef.current, heatRef.current]) {
        c.width = W; c.height = H
        c.getContext('2d').clearRect(0, 0, W, H)
      }

      if (!isEngineReady(engineKey)) {
        setPhase('model')
        // transformers.js fires a progress event per weight file; surface the
        // largest in-flight percentage so the 79 MB DETR download has a real bar.
        await loadEngine(engineKey, (p) => {
          if (aliveRef.current && p.status === 'progress' && p.progress != null) {
            setDownload(Math.round(p.progress))
          }
        })
        if (aliveRef.current) setDownload(null)
      }
      if (!aliveRef.current) return
      setPhase('detecting')
      const t0 = performance.now()
      const preds = await detectIn(srcRef.current, engineKey)
      if (!aliveRef.current) return
      setInferenceMs(performance.now() - t0)
      colorsRef.current = assignColors(preds)
      setPredictions(preds)
      drawBoxes(boxRef.current, preds, colorsRef.current)
      setPhase('ready')
    } catch (e) {
      if (!aliveRef.current) return
      console.warn('detection failed', e)
      setDownload(null)
      setError(e?.message || 'The detector could not be loaded.')
      setPhase('error')
    }
  }, [engineKey])

  // Re-run when the engine is switched (the image is already decoded).
  const didMount = useRef(false)
  useEffect(() => {
    if (!didMount.current) { didMount.current = true; return }
    if (!progress) analyze()   // don't yank the detector out from under a running occlusion
  }, [engineKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // Re-draw when the spotlight changes so hovering a row dims the other boxes.
  useEffect(() => {
    if (phase === 'ready' && boxRef.current) {
      drawBoxes(boxRef.current, predictions, colorsRef.current, hover)
    }
  }, [hover, phase, predictions])

  const explainOne = async (index) => {
    if (progress) return
    cancelRef.current = false
    setHeat(null)
    heatRef.current.getContext('2d').clearRect(0, 0, heatRef.current.width, heatRef.current.height)
    const target = predictions[index]
    setProgress({ done: 0, total: engine.grid ** 2, eta: null, label: target.class })
    try {
      const detect = await loadEngine(engineKey)
      const result = await runOcclusion({
        detect,
        srcCanvas: srcRef.current,
        target,
        grid: engine.grid,
        shouldCancel: () => cancelRef.current,
        onProgress: (p) => aliveRef.current && setProgress({ ...p, label: target.class }),
      })
      if (!aliveRef.current) return
      if (result) {
        drawHeatmap(heatRef.current, result, target)
        setHeat({ result, target })
      }
    } catch (e) {
      if (aliveRef.current) setError(e?.message || 'The explanation run failed.')
    } finally {
      if (aliveRef.current) setProgress(null)
    }
  }

  const clearHeat = () => {
    setHeat(null)
    heatRef.current?.getContext('2d').clearRect(0, 0, heatRef.current.width, heatRef.current.height)
  }

  const busy = phase === 'loading' || phase === 'model' || phase === 'detecting'
  const busyLabel = {
    loading: 'Loading photo…',
    model: download != null
      ? `Downloading ${engine.name} — ${download}%`
      : `Loading ${engine.name} (once per session)…`,
    detecting: `Analyzing with ${engine.name}…`,
  }[phase]

  // Sorted for the list but carrying the original index — explainOne indexes into
  // `predictions`, and re-sorting without this quietly explains the wrong object.
  const ranked = predictions.map((p, i) => ({ p, i })).sort((a, b) => b.p.score - a.p.score)
  const occlusionSecs = Math.round((inferenceMs * engine.grid ** 2) / 1000)

  return (
    <div className="overlay" onClick={onClose}>
      <div className="viewer" role="dialog" aria-label="Photo details" onClick={(e) => e.stopPropagation()}>
        <header className="viewer-head">
          <h2>{title}</h2>
          {/* Switch detectors. Disabled mid-run so we never swap the model out from
              under a detection or an occlusion pass. */}
          <div className="viewer-engines" role="group" aria-label="Detector">
            {Object.entries(ENGINES).map(([key, e]) => (
              <button
                key={key}
                className={`viewer-engine ${engineKey === key ? 'on' : ''}`}
                disabled={busy || !!progress}
                onClick={() => setEngineKey(key)}
                title={`${e.name} — ${key === 'fast' ? 'fast, lighter' : 'slower, more accurate'}`}
              >
                {key === 'fast' ? 'Fast' : 'Accurate'}
              </button>
            ))}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <XIcon size={16} />
          </button>
        </header>

        <div className="viewer-body">
          <div className="viewer-frame">
            <img
              ref={imgRef}
              src={url}
              alt={message.alt || 'Shared photo'}
              onLoad={analyze}
              onError={() => { setError('This photo could not be loaded.'); setPhase('error') }}
            />
            <canvas ref={boxRef} className="viewer-layer" aria-hidden="true" />
            <canvas ref={heatRef} className="viewer-layer" aria-hidden="true" />
            {busy && (
              <div className="viewer-scrim">
                {phase === 'model' && download != null ? (
                  <div className="viewer-dlbar"><i style={{ width: `${download}%` }} /></div>
                ) : (
                  <div className="scanner"><i /></div>
                )}
                <p>{busyLabel}</p>
                {phase === 'model' && engineKey === 'accurate' && (
                  <p className="viewer-scrim-sub">DETR ResNet-50 is ~79 MB, downloaded once and cached by your browser.</p>
                )}
              </div>
            )}
          </div>

          <div className="viewer-panel">
            {phase === 'error' && <p className="viewer-error">{error}</p>}

            {phase === 'ready' && (
              <>
                <p className="viewer-status">
                  {engine.name} · {inferenceMs.toFixed(0)} ms · ran on your device
                </p>

                {/* Locally generated from a fixed model vocabulary — no user-supplied
                    text reaches this markup. */}
                <div
                  className="viewer-narration"
                  dangerouslySetInnerHTML={{
                    __html: explainScene(predictions, srcRef.current.width, srcRef.current.height)
                      .map((l) => (/^<(h3|div)/.test(l) ? l : `<p>${l}</p>`))
                      .join(''),
                  }}
                />

                {predictions.length > 0 && (
                  <>
                    <p className="viewer-hint">
                      See <em>which pixels</em> a detection relies on — {engine.grid ** 2} occlusion
                      passes, roughly {occlusionSecs}s each:
                    </p>
                    {ranked.slice(0, DET_LIST_MAX).map(({ p, i }) => (
                      <div
                        className="viewer-det"
                        key={i}
                        onMouseEnter={() => setHover(i)}
                        onMouseLeave={() => setHover(null)}
                      >
                        <span>
                          <i className="viewer-swatch" style={{ background: colorsRef.current.get(p.class) }} />
                          {p.class} · {(p.score * 100).toFixed(0)}%
                        </span>
                        <button
                          className="viewer-explain"
                          disabled={!!progress}
                          onClick={() => explainOne(i)}
                        >
                          <ScanEyeIcon size={14} />
                          Explain
                        </button>
                      </div>
                    ))}
                    {ranked.length > DET_LIST_MAX && (
                      <p className="viewer-more">
                        + {ranked.length - DET_LIST_MAX} more below{' '}
                        {(ranked[DET_LIST_MAX].p.score * 100).toFixed(0)}% (all are drawn on the photo).
                      </p>
                    )}
                  </>
                )}
              </>
            )}

            {progress && (
              <div className="viewer-progress">
                <div className="viewer-progress-label">
                  <span>
                    Explaining “{progress.label}”
                    {progress.eta > 0 && progress.done < progress.total && ` · ~${progress.eta}s left`}
                  </span>
                  <span>{progress.done}/{progress.total}</span>
                </div>
                <div className="viewer-bar">
                  <i style={{ width: `${(progress.done / progress.total) * 100}%` }} />
                </div>
                <button className="viewer-cancel" onClick={() => { cancelRef.current = true }}>
                  Cancel
                </button>
              </div>
            )}

            {heat && (
              <div className="viewer-heat">
                <p>{heatmapCaption(heat.result, heat.target)}</p>
                <button className="viewer-cancel" onClick={clearHeat}>Clear heatmap</button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
