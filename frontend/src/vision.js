/* ============================================================================
   Local object detection + explainability, ported from the Sightline prototype.

   Nothing here touches the network except the one-time model download, and no
   image ever leaves the device: detection runs in this tab, on this hardware.
   What DOES leave the device is the short description `altTextFor` produces —
   the sender attaches it to the message on purpose, and can edit or clear it
   first. That split is the whole privacy story, so keep it:

     altTextFor()   facts only (inventory + scene guess). Sent and stored.
     explainScene() the full narration, INCLUDING hedged intent hypotheses.
                    Rendered on demand, in the viewer, for the person looking.
                    Never auto-attached to a message.

   The engine contract is one line: detect(canvas, minScore) -> [{class, score,
   bbox:[x,y,w,h]}] in canvas pixels. Everything below consumes only that, so
   swapping in another detector is a single entry in ENGINES.
   ========================================================================= */

// ---------- engines ----------
export const ENGINES = {
  fast: {
    name: 'COCO-SSD',
    grid: 8,          // occlusion resolution: cheap model, afford 64 passes
    minScore: 0.5,
    async load() {
      // Dynamic import, always — tfjs is ~1 MB of JS and the weights another 6 MB.
      // Static imports would put all of that in the boot bundle of a chat app that
      // most sessions never attach a photo to.
      const tf = await import('@tensorflow/tfjs')
      await tf.ready()
      const cocoSsd = await import('@tensorflow-models/coco-ssd')
      const m = await cocoSsd.load()
      return async (canvas, minScore = 0.5) =>
        (await m.detect(canvas, 20, minScore))
          .map((d) => ({ class: d.class, score: d.score, bbox: d.bbox }))
    },
  },
  accurate: {
    name: 'DETR ResNet-50',
    grid: 4,            // 16 occlusion passes: DETR costs ~2-4s each, 64 would be minutes
    minScore: 0.7,      // set-based (no NMS), emits 100 queries — 0.5 is noisy
    async load(onProgress) {
      // transformers.js is heavy and pulls the 79 MB model weights; keep it behind
      // the same dynamic import as tfjs so neither touches the boot bundle.
      const { pipeline, RawImage } = await import('@huggingface/transformers')
      // fp16 on WebGPU, q8 on the wasm fallback. Measured in the prototype: q8+WebGPU
      // was ~46s/image (int8 isn't GPU-accelerated); fp16+WebGPU is ~3-4s. The wasm
      // path is far slower but keeps the feature working without WebGPU.
      let pipe
      try {
        pipe = await pipeline('object-detection', 'Xenova/detr-resnet-50',
          { dtype: 'fp16', device: 'webgpu', progress_callback: onProgress })
      } catch (e) {
        console.warn('WebGPU unavailable for DETR, falling back to wasm:', e)
        pipe = await pipeline('object-detection', 'Xenova/detr-resnet-50',
          { dtype: 'q8', device: 'wasm', progress_callback: onProgress })
      }
      // Default preprocessing upscales every image to shortest-edge 800 — the dominant
      // cost — regardless of the size handed in. 600 buys ~30% speed at negligible loss.
      pipe.processor.image_processor.size = { shortest_edge: 600, longest_edge: 1000 }
      return async (canvas, minScore = 0.7) => {
        const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height)
        const raw = new RawImage(d.data, canvas.width, canvas.height, 4).rgb()
        const out = await pipe(raw, { threshold: minScore, percentage: false })
        // DETR gives corner boxes; the rest of the app speaks [x, y, w, h]
        return out.map((o) => ({
          class: o.label,
          score: o.score,
          bbox: [o.box.xmin, o.box.ymin, o.box.xmax - o.box.xmin, o.box.ymax - o.box.ymin],
        }))
      }
    },
  },
}

const loaded = {}
const loading = {}

/**
 * Load (and cache) an engine. Concurrent callers share one download, so the first
 * caller's onProgress wins — fine, since they're all waiting on the same bytes.
 * onProgress receives transformers.js's {status, progress, file, …} events; the
 * only ones with a numeric `progress` are the weight downloads.
 */
export function loadEngine(key = 'fast', onProgress) {
  if (loaded[key]) return Promise.resolve(loaded[key])
  if (!loading[key]) {
    loading[key] = ENGINES[key].load(onProgress)
      .then(async (detect) => {
        // Warm up on a tiny canvas. The first real inference otherwise pays for
        // shader/kernel compilation (seconds on DETR) and would be misreported as
        // the model's steady-state speed, throwing off every occlusion ETA.
        const warm = document.createElement('canvas')
        warm.width = warm.height = 64
        warm.getContext('2d').fillRect(0, 0, 64, 64)
        await detect(warm, 0.99).catch(() => {})
        loaded[key] = detect
        return detect
      })
      .catch((e) => { delete loading[key]; throw e })   // let a failed load be retried
  }
  return loading[key]
}

export const isEngineReady = (key = 'fast') => !!loaded[key]

/** For the compose-time description: use the best detector ALREADY in memory, never
 *  triggering a download. Once the viewer has pulled DETR, sent alt text gets its
 *  quality for free; until then the light model keeps sending instant. */
export const bestReadyEngine = () => (isEngineReady('accurate') ? 'accurate' : 'fast')

/** Draw an image into a canvas at NATURAL size. Every box coordinate below is in
 *  these pixels. Detecting on a rendered <img> instead returns boxes in its CSS
 *  size, and mixing the two silently misplaces every box. */
export function toCanvas(image) {
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth || image.width
  canvas.height = image.naturalHeight || image.height
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height)
  return canvas
}

/**
 * Decode a picked/pasted/dropped file and downscale it for sending. Returns the
 * canvas the detector reads AND the data URL the uploader posts, so the photo is
 * decoded exactly once. Re-encodes to JPEG, which drops transparency — fine for
 * photographs, and it keeps a phone camera's 8 MB original under the upload cap.
 */
export function prepareImage(file, maxDim = 1600) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(url)
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height))
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(img.width * scale)
      canvas.height = Math.round(img.height * scale)
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
      resolve({
        canvas,
        dataUrl: canvas.toDataURL('image/jpeg', 0.82),
        width: canvas.width,
        height: canvas.height,
      })
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('That file is not a readable image'))
    }
    img.src = url
  })
}

export async function detectIn(canvas, key = 'fast') {
  const detect = await loadEngine(key)
  return detect(canvas, ENGINES[key].minScore)
}

// ---------- box rendering ----------
// High-chroma palette: distinguishes classes at a glance, and every colour here
// stays legible against both dark and bright photography once cased in black.
const BOX_COLORS = ['#FFC700', '#00E5FF', '#FF5CA8', '#8CFF3D', '#FF8A3D', '#C9A3FF']

/** Assign per image, in order of first appearance. Hashing the class name looked
 *  tidier but collides — 'person' and 'kite' landed on the same green. */
export function assignColors(preds) {
  const map = new Map()
  ;[...new Set(preds.map((p) => p.class))]
    .forEach((c, i) => map.set(c, BOX_COLORS[i % BOX_COLORS.length]))
  return map
}

export function drawBoxes(canvas, predictions, colors, highlight = null) {
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  const scale = Math.max(1, canvas.width / 500)
  ctx.font = `800 ${12 * scale}px Outfit, system-ui, sans-serif`
  ctx.lineJoin = 'round'
  predictions.forEach((p, i) => {
    const [x, y, w, h] = p.bbox
    const col = colors.get(p.class) || BOX_COLORS[0]
    ctx.globalAlpha = highlight == null || highlight === i ? 1 : 0.25
    // Black casing first, then the colour on top. A plain black box vanishes
    // against dark photos and a bright one vanishes against light ones; the
    // pair never does.
    ctx.strokeStyle = '#000'; ctx.lineWidth = 6 * scale; ctx.strokeRect(x, y, w, h)
    ctx.strokeStyle = col;    ctx.lineWidth = 3 * scale; ctx.strokeRect(x, y, w, h)

    const label = `${p.class} ${(p.score * 100).toFixed(0)}%`
    const tw = ctx.measureText(label).width + 10 * scale
    // Skip labels far wider than their box — dense scenes turn into an unreadable
    // ribbon otherwise, and the panel already lists every detection.
    if (tw > w * 1.6) return
    const ly = Math.max(0, y - 18 * scale)
    ctx.fillStyle = col
    ctx.fillRect(x, ly, tw, 18 * scale)
    ctx.strokeStyle = '#000'; ctx.lineWidth = 2.5 * scale
    ctx.strokeRect(x, ly, tw, 18 * scale)
    ctx.fillStyle = '#000'
    ctx.fillText(label, x + 5 * scale, ly + 13 * scale)
  })
  ctx.globalAlpha = 1
}

// ---------- heuristic scene reasoning ----------
const POS_ROWS = ['upper', 'middle', 'lower']
const POS_COLS = ['left', 'center', 'right']

export function positionOf(bbox, W, H) {
  const cx = bbox[0] + bbox[2] / 2
  const cy = bbox[1] + bbox[3] / 2
  const r = POS_ROWS[Math.min(2, Math.floor((cy / H) * 3))]
  const c = POS_COLS[Math.min(2, Math.floor((cx / W) * 3))]
  return r === 'middle' && c === 'center' ? 'center of the frame' : `${r} ${c}`
}

export function distanceOf(bbox, W, H) {
  const pct = ((bbox[2] * bbox[3]) / (W * H)) * 100
  if (pct > 30) return 'very close to the camera'
  if (pct > 8) return 'at medium distance'
  return 'far in the background'
}

export function confidenceOf(score) {
  if (score >= 0.8) return 'confident'
  if (score >= 0.6) return 'fairly sure'
  return 'uncertain — treat with skepticism'
}

export function iou(a, b) {
  const x1 = Math.max(a[0], b[0])
  const y1 = Math.max(a[1], b[1])
  const x2 = Math.min(a[0] + a[2], b[0] + b[2])
  const y2 = Math.min(a[1] + a[3], b[1] + b[3])
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
  return inter / (a[2] * a[3] + b[2] * b[3] - inter)
}

export function relation(a, b, W, H) {
  const i = iou(a.bbox, b.bbox)
  const [ax, ay, aw, ah] = a.bbox
  const [bx, by, bw, bh] = b.bbox
  const ix = Math.max(0, Math.min(ax + aw, bx + bw) - Math.max(ax, bx))
  const iy = Math.max(0, Math.min(ay + ah, by + bh) - Math.max(ay, by))
  const inter = ix * iy
  const smaller = Math.min(aw * ah, bw * bh)
  if (inter / smaller > 0.85) return 'contains'   // intersection covers most of the smaller box
  if (i > 0.15) return 'overlaps'
  // "on top of": horizontal overlap + a's bottom near b's top region
  const hOverlap = ix / Math.min(aw, bw)
  if (hOverlap > 0.4 && Math.abs(ay + ah - by) < H * 0.08) return 'rests_on'
  const d = Math.hypot(ax + aw / 2 - bx - bw / 2, ay + ah / 2 - by - bh / 2)
  if (d < Math.hypot(W, H) * 0.2) return 'near'
  return null
}

// [classA, classB, requiredRelation, sentence]
const INTERACTIONS = [
  ['person', 'bicycle', 'overlaps', 'a person appears to be riding or walking a bicycle'],
  ['person', 'motorcycle', 'overlaps', 'a person appears to be on a motorcycle'],
  ['person', 'horse', 'overlaps', 'a person appears to be riding a horse'],
  ['person', 'skateboard', 'overlaps', 'a person appears to be skateboarding'],
  ['person', 'surfboard', 'overlaps', 'a person appears to be surfing'],
  ['person', 'laptop', 'near', 'someone seems to be working at a computer'],
  ['person', 'cell phone', 'overlaps', 'someone appears to be holding a phone'],
  ['person', 'umbrella', 'near', 'someone is carrying an umbrella'],
  ['person', 'sports ball', 'near', 'people appear to be playing with a ball'],
  ['person', 'dog', 'near', 'a person is together with a dog'],
  ['person', 'tie', 'overlaps', 'someone is formally dressed (wearing a tie)'],
  ['cup', 'dining table', 'rests_on', 'a cup sits on the dining table'],
  ['bowl', 'dining table', 'rests_on', 'a bowl sits on the dining table'],
  ['cat', 'couch', 'overlaps', 'a cat is lounging on the couch'],
  ['dog', 'couch', 'overlaps', 'a dog is lounging on the couch'],
  ['chair', 'dining table', 'near', 'chairs are arranged around a table'],
]

// Intent layer: [subject, [any of these context classes], mode, sentence]
//   'scene'    the context class merely appears somewhere in the frame
//   'near'     subject and context are spatially related at all
//   'overlaps' their boxes actually intersect
// These are hypotheses from co-occurrence and geometry, never observations. The
// wording stays hedged on purpose, the caveat says so, and — unlike the original
// single-user demo — none of this is ever written into a message.
const INTENTS = [
  ['person', ['traffic light', 'stop sign'], 'scene', 'waiting at or moving through a controlled junction'],
  ['person', ['suitcase', 'backpack', 'handbag'], 'near', 'carrying belongings — travelling or commuting rather than staying put'],
  ['person', ['laptop', 'keyboard', 'mouse', 'book'], 'near', 'settled into focused desk work or study'],
  ['person', ['fork', 'knife', 'spoon', 'bowl', 'cup', 'wine glass', 'pizza', 'sandwich', 'cake', 'donut'], 'scene', 'part-way through a meal'],
  ['person', ['dog', 'cat'], 'near', 'out with an animal — most likely a walk or play'],
  ['person', ['sports ball', 'tennis racket', 'baseball bat', 'frisbee', 'skateboard', 'surfboard', 'skis', 'snowboard', 'kite'], 'scene', 'engaged in active recreation rather than passing through'],
  ['person', ['cell phone'], 'near', 'attention is probably on the phone rather than the surroundings'],
  ['person', ['bicycle', 'motorcycle'], 'overlaps', 'in transit rather than standing still'],
  ['person', ['chair', 'couch', 'bed'], 'overlaps', 'seated or at rest rather than moving'],
  ['person', ['umbrella'], 'near', 'sheltering — the weather is probably wet or very bright'],
  ['person', ['tie'], 'near', 'dressed formally, suggesting work or an occasion'],
  ['person', ['bench'], 'overlaps', 'pausing or waiting rather than heading somewhere'],
  ['car', ['traffic light', 'stop sign'], 'scene', 'traffic here is controlled — vehicles are likely queuing or stopping'],
  ['dog', ['frisbee', 'sports ball'], 'scene', 'the animal is probably mid-play'],
  ['bird', ['bench', 'potted plant'], 'scene', 'a park or garden setting rather than wild habitat'],
]

const SCENES = {
  'street scene': ['car', 'truck', 'bus', 'motorcycle', 'bicycle', 'traffic light', 'stop sign', 'fire hydrant', 'parking meter'],
  'dining scene': ['dining table', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'wine glass', 'bottle', 'pizza', 'sandwich', 'cake', 'donut'],
  workspace: ['laptop', 'keyboard', 'mouse', 'tv', 'book'],
  'outdoor / animal scene': ['dog', 'cat', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe', 'bird'],
  'sports scene': ['sports ball', 'tennis racket', 'baseball bat', 'baseball glove', 'skateboard', 'surfboard', 'frisbee', 'kite', 'skis', 'snowboard'],
}

const article = (w) => (/^[aeiou]/i.test(w) ? 'an' : 'a')

// A naive +'s' produces "4 persons", "2 wine glasss", "3 knifes". Harmless in a
// demo; not here, where this text is read aloud by a screen reader. Only the last
// word of a multi-word COCO class inflects ("wine glass" -> "wine glasses").
const IRREGULAR_PLURALS = {
  person: 'people', mouse: 'mice', knife: 'knives',
  sheep: 'sheep', skis: 'skis', scissors: 'scissors',
}

export function plural(cls, n) {
  if (n === 1) return cls
  const words = cls.split(' ')
  const last = words[words.length - 1]
  words[words.length - 1] = IRREGULAR_PLURALS[last]
    ?? (/(s|x|z|ch|sh)$/.test(last) ? `${last}es` : `${last}s`)
  return words.join(' ')
}

function tally(preds) {
  const counts = {}
  preds.forEach((p) => { counts[p.class] = (counts[p.class] || 0) + 1 })
  return counts
}

/** "3 cars, 2 people and a dog" — Oxford-free, reads aloud cleanly. */
function inventory(counts, joiner = 'and') {
  const parts = Object.entries(counts)
    .map(([c, n]) => (n > 1 ? `${n} ${plural(c, n)}` : `${article(c)} ${c}`))
  if (parts.length === 1) return parts[0]
  return `${parts.slice(0, -1).join(', ')} ${joiner} ${parts[parts.length - 1]}`
}

/** The description that gets attached to the message: FACTS ONLY. Plain text —
 *  it lands in an alt attribute, a push body and a sidebar preview. Returns ''
 *  when nothing was recognized: silence is better than a wrong claim about
 *  someone's photo, and the UI already says the model found nothing. */
export function altTextFor(preds) {
  if (!preds.length) return ''
  const counts = tally(preds)
  let best = null
  let bestCount = 0
  for (const [scene, labels] of Object.entries(SCENES)) {
    const n = preds.filter((p) => labels.includes(p.class)).length
    if (n > bestCount) { best = scene; bestCount = n }
  }
  const items = inventory(counts)
  return bestCount >= 2 ? `${capitalize(article(best))} ${best} with ${items}` : capitalize(items)
}

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1)

/** Full narration for the viewer panel. Returns HTML line strings, exactly as the
 *  prototype did — headings and the caveat arrive as block elements. */
export function explainScene(preds, W, H) {
  if (!preds.length) {
    return ['<em>Nothing recognized.</em> The model knows only the fixed COCO object vocabulary — the photo may contain none of those, or the objects may be too small or unclear.']
  }
  const lines = []

  let best = null
  let bestCount = 0
  for (const [scene, labels] of Object.entries(SCENES)) {
    const n = preds.filter((p) => labels.includes(p.class)).length
    if (n > bestCount) { best = scene; bestCount = n }
  }
  const counts = tally(preds)
  lines.push('<h3>Overview</h3>')
  lines.push(`<strong>${bestCount >= 2 ? `This looks like ${article(best)} ${best}` : 'Scene'}:</strong> the model found ${inventory(counts, 'and')}.`)

  // what the photo is "about": biggest box, tie-broken by nearness to centre
  const frameArea = W * H
  const cxF = W / 2
  const cyF = H / 2
  const areaOf = (p) => p.bbox[2] * p.bbox[3]
  const subject = [...preds].sort((a, b) => {
    const centred = (p) => -Math.hypot(p.bbox[0] + p.bbox[2] / 2 - cxF, p.bbox[1] + p.bbox[3] / 2 - cyF)
    return areaOf(b) - areaOf(a) || centred(b) - centred(a)
  })[0]
  const subjPct = (areaOf(subject) / frameArea) * 100
  const runnerUp = preds.filter((p) => p !== subject).sort((a, b) => areaOf(b) - areaOf(a))[0]
  // Only name a subject when one actually dominates. In a wide street shot every
  // box is tiny and "the car is the subject, filling under 1% of the frame" is
  // worse than saying nothing.
  if (subjPct >= 6 || (runnerUp && areaOf(subject) > areaOf(runnerUp) * 2.5)) {
    lines.push(`The <strong>${subject.class}</strong> is most likely the subject — it fills ${subjPct < 1 ? 'under 1' : subjPct.toFixed(0)}% of the frame and sits ${positionOf(subject.bbox, W, H)}.`)
  } else {
    lines.push('No single object dominates — everything sits small in the frame, so this reads as a wide establishing shot rather than a photo <em>of</em> any one thing.')
  }

  lines.push('<h3>Layout</h3>')
  const diag = Math.hypot(W, H)
  for (const [cls, n] of Object.entries(counts)) {
    if (n < 2) continue
    const group = preds.filter((p) => p.class === cls)
    let maxD = 0
    let cx = 0
    let cy = 0
    group.forEach((p) => { cx += p.bbox[0] + p.bbox[2] / 2; cy += p.bbox[1] + p.bbox[3] / 2 })
    cx /= n
    cy /= n
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = group[i].bbox
        const b = group[j].bbox
        maxD = Math.max(maxD, Math.hypot(a[0] + a[2] / 2 - b[0] - b[2] / 2, a[1] + a[3] / 2 - b[1] - b[3] / 2))
      }
    }
    lines.push(maxD < diag * 0.4
      ? `The ${n} ${plural(cls, n)} are clustered together in the ${positionOf([cx, cy, 0, 0], W, H)}.`
      : `The ${n} ${plural(cls, n)} are spread across the frame.`)
  }

  // per-object detail (top 5 by score)
  ;[...preds].sort((a, b) => b.score - a.score).slice(0, 5).forEach((p) => {
    lines.push(`The <strong>${p.class}</strong> is in the ${positionOf(p.bbox, W, H)}, ${distanceOf(p.bbox, W, H)} — the model is ${confidenceOf(p.score)} (${(p.score * 100).toFixed(0)}%).`)
  })

  // ---- activity & intent: concrete interactions first, then hedged hypotheses ----
  const activity = []
  const said = new Set()
  const top = [...preds].sort((a, b) => b.score - a.score).slice(0, 8)
  for (let i = 0; i < top.length; i++) {
    for (let j = 0; j < top.length; j++) {
      if (i === j) continue
      const rel = relation(top[i], top[j], W, H)
      if (!rel) continue
      for (const [ca, cb, req, sentence] of INTERACTIONS) {
        if (top[i].class === ca && top[j].class === cb &&
            (rel === req || (req === 'near' && rel !== null)) && !said.has(sentence)) {
          said.add(sentence)
          activity.push(`${capitalize(sentence)}.`)
        }
      }
    }
  }

  const present = new Set(preds.map((p) => p.class))
  for (const [subj, ctxList, mode, sentence] of INTENTS) {
    if (said.has(sentence)) continue
    const subjects = preds.filter((p) => p.class === subj)
    if (!subjects.length) continue
    const hit = ctxList.some((c) => {
      if (!present.has(c)) return false
      if (mode === 'scene') return true
      return preds.some((o) => o.class === c && subjects.some((s) => {
        const rel = relation(s, o, W, H)
        return mode === 'overlaps' ? rel === 'overlaps' || rel === 'contains' : rel !== null
      }))
    })
    if (!hit) continue
    said.add(sentence)
    const who = subjects.length > 1
      ? `The ${subjects.length} ${plural(subj, subjects.length)} are`
      : `The ${subj} is`
    activity.push(`${who} plausibly <strong>${sentence}</strong>.`)
  }

  const people = counts.person || 0
  if (people >= 3) {
    activity.push(`With ${people} people in frame, this reads as a group setting — a conversation, queue, or shared activity rather than individuals passing through.`)
  }

  if (activity.length) {
    lines.push('<h3>Likely activity</h3>')
    lines.push(...activity)
  }

  lines.push('<div class="vision-caveat">⚠️ <strong>How much to trust this.</strong> Everything above is derived from box geometry and which labels co-occur — the model sees no faces, no motion, and nothing outside this single photo or its fixed COCO vocabulary. Position and size are measured and reliable. <em>Activity and intent are hypotheses</em>: a person beside a bicycle may be riding it, guarding it, or simply standing near it. Treat them as leads, not observations, and never as identification.</div>')
  return lines
}

// ---------- occlusion saliency (D-RISE-lite) ----------
/**
 * Re-run detection with a grey patch sliding over the target's neighbourhood.
 * Cells whose occlusion costs the most confidence are the pixels the decision
 * actually depends on.
 *
 * @param {object}   opts.detect        engine detect(canvas, minScore)
 * @param {Canvas}   opts.srcCanvas     natural-size source
 * @param {object}   opts.target        one prediction
 * @param {number}   opts.grid          cells per side
 * @param {Function} opts.onProgress    ({done, total, eta}) — drives the bar
 * @param {Function} opts.shouldCancel  polled each pass
 * @returns null if cancelled, else {importance, grid, region, baseScore, max, median, hasSignal}
 */
export async function runOcclusion({ detect, srcCanvas, target, grid, onProgress, shouldCancel }) {
  const W = srcCanvas.width
  const H = srcCanvas.height
  // region = target box + 25% margin (context matters), clamped to the image
  const m = 0.25
  const rx = Math.max(0, target.bbox[0] - target.bbox[2] * m)
  const ry = Math.max(0, target.bbox[1] - target.bbox[3] * m)
  const rw = Math.min(W - rx, target.bbox[2] * (1 + 2 * m))
  const rh = Math.min(H - ry, target.bbox[3] * (1 + 2 * m))
  const cw = rw / grid
  const ch = rh / grid

  const off = document.createElement('canvas')
  off.width = W
  off.height = H
  const octx = off.getContext('2d')

  const total = grid * grid
  const importance = new Float32Array(total)

  // measure the unoccluded score at the same low threshold, so drops are like-for-like
  const baseDets = await detect(srcCanvas, 0.01)
  let baseScore = target.score
  for (const d of baseDets) {
    if (d.class === target.class && iou(d.bbox, target.bbox) > 0.5) baseScore = Math.max(baseScore, d.score)
  }

  const startedAt = performance.now()
  for (let cell = 0; cell < total; cell++) {
    if (shouldCancel?.()) return null
    const gx = cell % grid
    const gy = Math.floor(cell / grid)
    octx.drawImage(srcCanvas, 0, 0)
    octx.fillStyle = 'rgb(128,128,128)'
    // Occluder is 2 cells wide but strides 1 cell (overlapping windows, à la
    // Zeiler & Fergus). A patch the size of one cell barely moves a confident
    // detection — the map comes out as noise. Same pass count, far stronger signal.
    octx.fillRect(rx + (gx - 0.5) * cw, ry + (gy - 0.5) * ch, cw * 2, ch * 2)

    // minScore must be near-zero here: at the default 0.5, any occlusion that
    // drops confidence below the threshold returns nothing, so every cell reads
    // as "total loss" and the map saturates uniformly.
    const dets = await detect(off, 0.01)
    let score = 0
    for (const d of dets) {
      if (d.class === target.class && iou(d.bbox, target.bbox) > 0.3) score = Math.max(score, d.score)
    }
    importance[cell] = Math.max(0, baseScore - score)

    const done = cell + 1
    onProgress?.({
      done,
      total,
      eta: Math.round(((performance.now() - startedAt) / done) * (total - done) / 1000),
    })
    // Yield so the UI repaints. NOT tf.nextFrame() — that waits on rAF, which
    // never fires in a hidden tab and would stall the run forever.
    await new Promise((r) => setTimeout(r, 0))
  }

  const max = Math.max(...importance)
  // The signal test is RELATIVE, not absolute. A high-confidence model can sit
  // near 100% and move by ~1 point under a large occluder, yet still show 20x
  // structure between object and background. An absolute cutoff discards that.
  const sorted = [...importance].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  const hasSignal = max > 0.005 && max > 4 * Math.max(median, 2e-4)

  return { importance, grid, region: { rx, ry, cw, ch }, baseScore, max, median, hasSignal }
}

export function drawHeatmap(canvas, result, target) {
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  if (result?.hasSignal) {
    const { importance, grid, region: { rx, ry, cw, ch }, max } = result
    for (let cell = 0; cell < importance.length; cell++) {
      const gx = cell % grid
      const gy = Math.floor(cell / grid)
      ctx.fillStyle = `rgba(239,68,68,${((importance[cell] / max) * 0.65).toFixed(3)})`
      ctx.fillRect(rx + gx * cw, ry + gy * ch, cw, ch)
    }
  }
  ctx.lineJoin = 'round'
  ctx.strokeStyle = '#000'; ctx.lineWidth = Math.max(6, canvas.width / 150); ctx.strokeRect(...target.bbox)
  ctx.strokeStyle = '#fff'; ctx.lineWidth = Math.max(3, canvas.width / 300); ctx.strokeRect(...target.bbox)
}

export function heatmapCaption(result, target) {
  const { max, median, baseScore, hasSignal } = result
  if (!hasSignal) {
    return `No area stood out: hiding any single part of this region left the model's confidence in "${target.class}" essentially unchanged (largest drop ${(max * 100).toFixed(1)} points, evenly spread). The detection is robust — it doesn't hinge on one patch of pixels.`
  }
  const drop = max * 100
  return `Red = hiding this area lowered the model's confidence in "${target.class}" the most `
    + `(largest drop ${drop < 1 ? drop.toFixed(1) : drop.toFixed(0)} points from ${(baseScore * 100).toFixed(0)}%, `
    + `~${Math.round(max / Math.max(median, 2e-4))}× the effect of hiding background). `
    + 'These are the pixels the decision actually depends on.'
}

// ---------- self-check: open the app with ?selftest to run ----------
// The reasoning engine is pure (boxes in, sentences out), so it needs no model,
// no network and no test runner to check.
export function runSelfTest() {
  const ok = (cond, name) => console[cond ? 'log' : 'error'](`${cond ? 'PASS' : 'FAIL'}: ${name}`)
  const box = (x, y, w, h) => [x, y, w, h]
  const W = 1000
  const H = 1000

  ok(positionOf(box(20, 20, 50, 50), W, H) === 'upper left', 'position: upper left')
  ok(positionOf(box(475, 475, 50, 50), W, H) === 'center of the frame', 'position: center')
  ok(distanceOf(box(0, 0, 800, 800), W, H) === 'very close to the camera', 'distance: foreground')
  ok(distanceOf(box(0, 0, 50, 50), W, H) === 'far in the background', 'distance: background')
  ok(confidenceOf(0.95) === 'confident' && confidenceOf(0.5).startsWith('uncertain'), 'confidence wording')
  ok(Math.abs(iou(box(0, 0, 100, 100), box(0, 0, 100, 100)) - 1) < 1e-6, 'iou: identical = 1')
  ok(iou(box(0, 0, 100, 100), box(500, 500, 100, 100)) === 0, 'iou: disjoint = 0')

  const rider = { class: 'person', score: 0.9, bbox: box(100, 100, 100, 200) }
  const bike = { class: 'bicycle', score: 0.8, bbox: box(110, 220, 120, 100) }
  ok(relation(rider, bike, W, H) === 'overlaps', 'relation: overlapping person/bicycle')
  ok(relation(rider, { class: 'car', score: 0.7, bbox: box(900, 900, 50, 50) }, W, H) === null, 'relation: distant = none')

  const scene = explainScene([rider, bike], W, H).join(' ')
  ok(scene.includes('riding or walking a bicycle'), 'interaction sentence fires')
  ok(scene.includes('hypotheses'), 'caveat always present')
  ok(scene.includes('in transit'), 'intent fires on overlap (person + bicycle)')

  const farPhone = [{ class: 'person', score: 0.9, bbox: box(0, 0, 80, 180) },
                    { class: 'cell phone', score: 0.8, bbox: box(950, 950, 30, 40) }]
  ok(!explainScene(farPhone, W, H).join(' ').includes('attention is probably on the phone'),
    "intent mode 'near' rejects a distant context object")
  const meal = [{ class: 'person', score: 0.9, bbox: box(0, 0, 80, 180) },
                { class: 'pizza', score: 0.8, bbox: box(900, 900, 60, 60) }]
  ok(explainScene(meal, W, H).join(' ').includes('part-way through a meal'),
    "intent mode 'scene' fires on co-presence alone")

  const subj = explainScene([{ class: 'cat', score: 0.9, bbox: box(100, 100, 600, 600) },
                             { class: 'cup', score: 0.9, bbox: box(10, 10, 30, 30) }], W, H)
    .find((l) => l.includes('the subject'))
  ok(!!subj && subj.includes('cat'), 'subject picks the largest object')
  const tiny = Array.from({ length: 5 }, (_, i) => ({ class: 'car', score: 0.9, bbox: box(i * 120, 500, 40, 30) }))
  ok(explainScene(tiny, W, H).join(' ').includes('No single object dominates'), 'no subject when nothing dominates')

  const crowd = Array.from({ length: 4 }, (_, i) => ({ class: 'person', score: 0.9, bbox: box(i * 90, 100, 70, 180) }))
  ok(explainScene(crowd, W, H).join(' ').includes('group setting'), 'group intent at 3+ people')
  ok(explainScene([], W, H)[0].includes('Nothing recognized'), 'empty scene handled')
  ok(explainScene([{ class: 'elephant', score: 0.9, bbox: box(0, 0, 100, 100) }], W, H).join(' ').includes('an elephant'), 'article: an')

  const many = Array.from({ length: 3 }, (_, i) => ({ class: 'car', score: 0.9, bbox: box(100 + i * 20, 100, 60, 60) }))
  ok(explainScene(many, W, H).some((l) => l.includes('clustered together')), 'grouping: clustered')
  const spread = [box(0, 0, 60, 60), box(900, 900, 60, 60), box(0, 900, 60, 60)]
    .map((b) => ({ class: 'car', score: 0.9, bbox: b }))
  ok(explainScene(spread, W, H).some((l) => l.includes('spread across')), 'grouping: spread')

  ok(explainScene(crowd, W, H).join(' ').includes('4 people'), 'grouping: irregular plural')

  // --- alt text: the part that actually gets sent, so hold it to a tighter line ---
  const street = [{ class: 'car', score: 0.9, bbox: box(0, 0, 60, 60) },
                  { class: 'car', score: 0.9, bbox: box(80, 0, 60, 60) },
                  { class: 'traffic light', score: 0.8, bbox: box(400, 0, 20, 60) }]
  ok(altTextFor([]) === '', 'alt text: nothing recognized stays silent, never guesses')
  ok(altTextFor(street) === 'A street scene with 2 cars and a traffic light', 'alt text: scene + inventory')
  ok(altTextFor([rider, bike]) === 'A person and a bicycle', 'alt text: no scene guess under 2 matches')
  ok(altTextFor([{ class: 'cat', score: 0.9, bbox: box(0, 0, 10, 10) }]) === 'A cat', 'alt text: single object')
  ok(altTextFor(crowd) === '4 people', 'alt text: irregular plural, not "4 persons"')
  ok(plural('wine glass', 2) === 'wine glasses' && plural('knife', 2) === 'knives'
    && plural('sheep', 3) === 'sheep' && plural('bus', 2) === 'buses', 'plural: awkward COCO classes')
  // the sent description must never carry a hypothesis about what someone is DOING
  const intents = ['plausibly', 'attention is probably', 'seated or at rest', 'in transit', 'hypotheses']
  ok(intents.every((phrase) => !altTextFor([rider, bike]).includes(phrase)),
    'alt text: carries no intent hypotheses')

  console.log('self-check complete')
}
