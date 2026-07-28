# Pulse Messenger

A real-time, WhatsApp-style chat app — FastAPI + WebSockets on the backend, React on
the front. Built to lean on the Python standard library: JWT auth, password hashing,
and even the Web Push encryption are hand-rolled or stdlib-backed rather than pulled
from heavy frameworks.

## Features

- **Real-time messaging** over a single WebSocket per session (auto-reconnect with backoff)
- **Delivery + read receipts**, typing indicators, and live online/offline presence
- **Message reactions** (emoji, toggle on/off)
- **Photo messages with on-device vision** — attach, paste or drop an image and an
  object detector runs *in your browser* to write a description of it. That description
  becomes the image's `alt` text, the notification body and the sidebar preview; it's
  shown in an editable field before sending, never attached silently. Tap any photo to
  open the **explainability panel**: detection boxes, a plain-language reading of the
  scene, and occlusion heatmaps showing which pixels a given detection actually depends
  on. Two detectors behind one interface — **COCO-SSD** (fast, ~6 MB) and **DETR
  ResNet-50** (more accurate, ~79 MB, WebGPU-accelerated), switchable in the panel.
  No image is ever sent to a model service — inference happens on the sender's and
  viewer's own hardware.
- **Events + RSVPs** — a month calendar with event chips shown right in the day cells,
  so you see what's on without opening anything. Click a day for detail, to RSVP, or to
  add an event on that date. Invitations reuse the existing notification + web-push
  pipeline, so an invite reaches you with the tab closed. An event is visible **only** to
  its creator and the people invited to it.
- **Pulse AI** — a floating assistant that answers plain-English questions about your
  events ("what's on next week?", "who's coming to the BBQ?"). It runs on the Claude Code
  login already on your machine, so there's **no API key and no per-token billing**.
  The model never writes SQL: it picks one of three read-only tools and the queries are
  hand-written, parameterized and scoped to you in code — see [Notes on Pulse AI](#notes-on-pulse-ai).
- **Auth** — scrypt-hashed passwords (stdlib `hashlib`) and hand-rolled **HS256 JWTs**
  (stdlib `hmac`), with a revocation denylist so logout actually works on stateless tokens
- **Notifications**
  - In-app toasts while you're looking
  - A **notification center** (bell + unread badge) that survives reloads
  - OS notifications when the tab is backgrounded
  - **Web Push** (VAPID + RFC-8291 encrypted payloads) so you're notified even with the
    site closed — VAPID keys are auto-generated and persisted on first run
- **Rate limiting** — in-process sliding window on the auth endpoints and data plane
- **Profiles** — display name, bio, avatar
- **Dark mode** — toggle in the sidebar; follows your OS on first visit and is remembered
  per device (the login itself stays per-tab, so two tabs can still be two users)

## Stack

| | |
|---|---|
| Backend | FastAPI, `sqlite3` (stdlib), WebSockets, `pywebpush` |
| Frontend | React 19, Vite |
| Auth | scrypt (hashlib) + HS256 JWT (hmac) |
| Assistant | `claude-agent-sdk` driving the local Claude Code CLI — no API key, no metered billing |
| Vision | TensorFlow.js + COCO-SSD and transformers.js + DETR ResNet-50, both lazy-loaded in the browser (nothing in the boot bundle) |

## Running it

### Backend

```bash
python -m venv .venv
.venv/Scripts/activate          # Windows;  source .venv/bin/activate on macOS/Linux
pip install -r requirements.txt
uvicorn main:app --app-dir app --port 8001 --reload
```

The server also serves the built frontend from `frontend/dist`, so once you've built
the frontend (below) the whole app is available at http://127.0.0.1:8001.

Pulse AI additionally needs the **Claude Code CLI installed and logged in** on this
machine (`claude` — the SDK ships it). Everything else runs without it; if it's missing,
`/assistant` answers `503 assistant unavailable` and the server prints a one-line warning
at boot naming the interpreter to install into. If you keep more than one virtualenv,
install `claude-agent-sdk` into the one you actually run uvicorn with.

### Frontend

```bash
cd frontend
npm install
npm run build        # outputs frontend/dist, served by the backend
# or: npm run dev    # Vite dev server with a proxy to the backend on :8000
```

## Tests

Each test spins up a real uvicorn server on its own database:

```bash
.venv/Scripts/python.exe app/test_chat.py
.venv/Scripts/python.exe app/test_ratelimit.py
.venv/Scripts/python.exe app/test_media.py
.venv/Scripts/python.exe app/test_events.py
```

`test_events.py` runs entirely offline — it calls no model, so it's safe on every build.
It checks the event scoping twice: once through the HTTP endpoints, and once by calling
the assistant's tool functions directly as a different user, which is the code path a
prompt-injected question would actually reach. Add `--live` to also exercise the real
assistant, which spends subscription usage:

```bash
.venv/Scripts/python.exe app/test_events.py --live
```

That variant asks the assistant to run a shell command and print the JWT secret out of
`main.py`, and fails if anything leaks — the sandbox is verified, not assumed.

The scene-reasoning engine is pure (boxes in, sentences out), so it needs no model
and no test runner — open the app at `/?selftest` and read the browser console, or
run it headless:

```bash
cd frontend && node -e "import('./src/vision.js').then(m => m.runSelfTest())"
```

## Notes on Pulse AI

- **No API key, and no way to run up a bill.** The assistant authenticates with the
  Claude Code subscription already logged in on this machine, so usage is covered by the
  flat subscription fee. The worst case for a runaway loop is exhausting your usage
  window, after which `/assistant` returns 503 until it resets. This is licensed for
  **personal, local use** — serving other people needs the API-key path instead
  (`HANDOFF.md` §8 has the swap, which is contained to the wrapper).
- **The model can't widen your access.** `me` comes from your JWT and is closed over by
  the tools — it is never something the model supplies — so every query is scoped before
  the model runs. A prompt-injected question can at worst ask a *wrong* question about
  your own events.
- **It also can't touch your machine.** The SDK wraps Claude Code, which normally ships
  Bash and file tools, so those are disabled outright (`tools=[]`) rather than merely
  discouraged, along with any project settings or MCP servers that could inject
  instructions. `test_events.py --live` proves it.
- **Each question is answered on its own.** The chat window keeps a transcript for you to
  read, but the server holds no conversation memory, so a follow-up like "and who's
  coming?" won't resolve against the previous answer — ask it in full.
- Answers take a few seconds: every question starts a Claude Code process. Questions are
  capped at 500 characters and 6 per minute per user.

## Notes on Web Push

- Service workers and push require a **secure context**: `https://`, or `http://localhost`
  / `http://127.0.0.1` for local dev. Deploying anywhere else needs TLS.
- Set the `VAPID_SUB` env var to a real contact (`mailto:you@example.com`) before deploying;
  it defaults to a placeholder.
- iOS Safari needs the site added to the Home Screen (PWA), iOS 16.4+. Desktop Chrome/Firefox/Edge
  and Android Chrome work directly.
