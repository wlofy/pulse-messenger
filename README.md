# Pulse Messenger

A real-time, WhatsApp-style chat app — FastAPI + WebSockets on the backend, React on
the front. Built to lean on the Python standard library: JWT auth, password hashing,
and even the Web Push encryption are hand-rolled or stdlib-backed rather than pulled
from heavy frameworks.

## Features

- **Real-time messaging** over a single WebSocket per session (auto-reconnect with backoff)
- **Delivery + read receipts**, typing indicators, and live online/offline presence
- **Message reactions** (emoji, toggle on/off)
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

## Stack

| | |
|---|---|
| Backend | FastAPI, `sqlite3` (stdlib), WebSockets, `pywebpush` |
| Frontend | React 19, Vite |
| Auth | scrypt (hashlib) + HS256 JWT (hmac) |

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
```

## Notes on Web Push

- Service workers and push require a **secure context**: `https://`, or `http://localhost`
  / `http://127.0.0.1` for local dev. Deploying anywhere else needs TLS.
- Set the `VAPID_SUB` env var to a real contact (`mailto:you@example.com`) before deploying;
  it defaults to a placeholder.
- iOS Safari needs the site added to the Home Screen (PWA), iOS 16.4+. Desktop Chrome/Firefox/Edge
  and Android Chrome work directly.
