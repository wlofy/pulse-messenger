import sqlite3
import os
import time
import hashlib
import hmac
import json
import base64
import secrets
import asyncio
from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Header, Depends, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from pywebpush import webpush, WebPushException
from py_vapid import Vapid


app = FastAPI()
DB_PATH = os.environ.get("CHAT_DB") or (Path(__file__).parent / "chat.db")
db = sqlite3.connect(DB_PATH, check_same_thread=False)
db.row_factory = sqlite3.Row
db.executescript("""
CREATE TABLE IF NOT EXISTS users(
    username TEXT PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS messages(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender TEXT NOT NULL,
    recipient TEXT NOT NULL,
    text TEXT NOT NULL,
    ts REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'sent'  -- sent -> delivered -> read
);
CREATE TABLE IF NOT EXISTS reactions(
   message_id INTEGER NOT NULL,
   username TEXT NOT NULL,
   emoji TEXT NOT NULL,
   PRIMARY KEY (message_id, username)
);
CREATE TABLE IF NOT EXISTS revoked(
   jti TEXT PRIMARY KEY,       -- jti of a logged-out JWT; the price JWT charges for revocation
   exp REAL NOT NULL           -- prune once past this, the denylist stays bounded
);
CREATE TABLE IF NOT EXISTS notifications(
   id INTEGER PRIMARY KEY AUTOINCREMENT,
   username TEXT NOT NULL,      -- who this notification is FOR
   kind TEXT NOT NULL,          -- 'message' | 'reaction'
   actor TEXT NOT NULL,         -- who caused it
   body TEXT NOT NULL,          -- preview text
   ts REAL NOT NULL,
   read INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(username, id);
CREATE TABLE IF NOT EXISTS push_subs(
   username TEXT NOT NULL,
   endpoint TEXT NOT NULL,      -- the push service URL; unique per browser/device
   sub_json TEXT NOT NULL,      -- full PushSubscription, fed straight to pywebpush
   PRIMARY KEY (username, endpoint)
);
""")
# repair a `reactions` table left by an earlier broken draft: CREATE TABLE IF NOT
# EXISTS never fixes an existing table, so a malformed one persists silently. It
# holds only derived data (emoji), so dropping and rebuilding it is lossless.
if "message_id" not in [r[1] for r in db.execute("PRAGMA table_info(reactions)")]:
    db.execute("DROP TABLE IF EXISTS reactions")
    db.execute("""CREATE TABLE reactions(
        message_id INTEGER NOT NULL,
        username TEXT NOT NULL,
        emoji TEXT NOT NULL,
        PRIMARY KEY (message_id, username)
    )""")
    db.commit()

# password is added as a nullable column so the ALTER works on an existing db;
# signup always writes it, and login rejects any row where it's still NULL.
for col in ("avatar", "name", "bio", "password"):
    try:
        db.execute(f"ALTER TABLE users ADD COLUMN {col} TEXT")
    except sqlite3.OperationalError:
        pass
db.commit()


# --- Auth: scrypt-hashed passwords (stdlib), opaque bearer tokens in the db ---

def hash_password(password: str, salt: bytes | None = None) -> str:
    salt = salt or os.urandom(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1)
    return salt.hex() + "$" + digest.hex()   # store salt WITH the digest


def verify_password(password: str, stored: str) -> bool:
    salt_hex, digest_hex = stored.split("$")
    digest = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt_hex), n=2**14, r=8, p=1)
    return secrets.compare_digest(digest.hex(), digest_hex)   # constant-time, never ==


# --- JWT (HS256, hand-rolled on stdlib hmac — no dependency, same spirit as scrypt) ---
# A JWT is three base64url parts: header.payload.signature. The signature is an
# HMAC over "header.payload" with a server secret; anyone can READ the payload,
# nobody can forge it without the secret.
JWT_TTL = 7 * 24 * 3600  # tokens live one week, then the client is bounced to login


def _load_or_create_secret() -> bytes:
    """The secret must be STABLE across restarts, or every existing token dies on
    reload (the old opaque-token design stored tokens in the db and got this free).
    Prefer JWT_SECRET from the env (needed if you ever run >1 instance); otherwise
    generate once and persist it in the db so sessions survive a --reload restart."""
    env = os.environ.get("JWT_SECRET")
    if env:
        return env.encode()
    db.execute("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)")
    row = db.execute("SELECT value FROM meta WHERE key = 'jwt_secret'").fetchone()
    if row:
        return row["value"].encode()
    secret = secrets.token_hex(32)
    db.execute("INSERT INTO meta(key, value) VALUES ('jwt_secret', ?)", (secret,))
    db.commit()
    return secret.encode()


JWT_SECRET = _load_or_create_secret()


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _b64url_decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))  # restore stripped padding


def _sign(segments: str) -> str:
    return _b64url(hmac.new(JWT_SECRET, segments.encode(), hashlib.sha256).digest())


def issue_token(username: str) -> str:
    now = int(time.time())
    payload = {"sub": username, "iat": now, "exp": now + JWT_TTL, "jti": secrets.token_hex(8)}
    header = {"alg": "HS256", "typ": "JWT"}
    dump = lambda d: _b64url(json.dumps(d, separators=(",", ":")).encode())
    segments = f"{dump(header)}.{dump(payload)}"
    return f"{segments}.{_sign(segments)}"


def decode_token(token: str) -> dict | None:
    """Return the payload if the signature is valid and the token isn't expired, else None."""
    try:
        h_b64, p_b64, sig = token.split(".")
    except ValueError:
        return None
    if not secrets.compare_digest(sig, _sign(f"{h_b64}.{p_b64}")):
        return None  # forged or tampered — constant-time compare
    try:
        payload = json.loads(_b64url_decode(p_b64))
    except (ValueError, json.JSONDecodeError):
        return None
    if payload.get("exp", 0) < time.time():
        return None  # expired
    return payload


def user_for_token(token: str) -> str | None:
    payload = decode_token(token)
    if not payload:
        return None
    if db.execute("SELECT 1 FROM revoked WHERE jti = ?", (payload.get("jti"),)).fetchone():
        return None  # token was logged out
    return payload.get("sub")


def current_user(authorization: str = Header(default="")) -> str:
    """FastAPI dependency: every protected endpoint gets `me` from the bearer token."""
    user = user_for_token(authorization.removeprefix("Bearer ").strip())
    if not user:
        raise HTTPException(401, "not logged in")
    return user


# --- Web Push (VAPID + RFC-8291 encrypted payloads, via pywebpush) ----------
# Unlike the WebSocket (open-tab only), web push is delivered by the browser's
# push service, so it reaches the user with the site CLOSED. We hand an encrypted
# blob to that service; it wakes the user's service worker, which shows the OS
# notification. VAPID (an EC P-256 keypair) is how the service knows it's us.
VAPID_SUB = os.environ.get("VAPID_SUB", "mailto:admin@example.com")  # a contact for the push service


def _load_or_create_vapid() -> tuple[str, str]:
    """Same trick as the JWT secret: generate the keypair once and persist the
    private key, so existing browser subscriptions keep working across restarts.
    Returns (private_key_PEM, public_key_b64url) — the public half is the
    `applicationServerKey` the browser subscribes with."""
    db.execute("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)")
    row = db.execute("SELECT value FROM meta WHERE key = 'vapid_private'").fetchone()
    if row:
        priv = serialization.load_pem_private_key(row["value"].encode(), password=None)
    else:
        priv = ec.generate_private_key(ec.SECP256R1())
        pem = priv.private_bytes(serialization.Encoding.PEM,
                                 serialization.PrivateFormat.PKCS8,
                                 serialization.NoEncryption()).decode()
        db.execute("INSERT INTO meta(key, value) VALUES ('vapid_private', ?)", (pem,))
        db.commit()
    priv_pem = priv.private_bytes(serialization.Encoding.PEM,
                                  serialization.PrivateFormat.PKCS8,
                                  serialization.NoEncryption()).decode()
    raw_pub = priv.public_key().public_bytes(serialization.Encoding.X962,
                                              serialization.PublicFormat.UncompressedPoint)
    return priv_pem, _b64url(raw_pub)


VAPID_PRIVATE_PEM, VAPID_PUBLIC = _load_or_create_vapid()
VAPID = Vapid.from_pem(VAPID_PRIVATE_PEM.encode())  # the object pywebpush signs with


async def send_web_push(user: str, actor: str, body: str):
    """Fan a notification out to every browser this user registered. pywebpush is
    blocking (it does the ECDH encryption + HTTP POST), so run it off the event
    loop. Prune any subscription the push service reports as gone (404/410)."""
    subs = db.execute("SELECT endpoint, sub_json FROM push_subs WHERE username = ?", (user,)).fetchall()
    for row in subs:
        try:
            await asyncio.to_thread(
                webpush,
                subscription_info=json.loads(row["sub_json"]),
                data=json.dumps({"title": actor, "body": body, "actor": actor}),
                vapid_private_key=VAPID,
                vapid_claims={"sub": VAPID_SUB},   # fresh dict each call — pywebpush mutates it
                timeout=10,
            )
        except WebPushException as e:
            if getattr(e.response, "status_code", None) in (404, 410):
                db.execute("DELETE FROM push_subs WHERE endpoint = ?", (row["endpoint"],))
                db.commit()
        except Exception:
            pass  # a transient push-service hiccup shouldn't break message delivery


# --- Rate limiting: in-process sliding window (single-worker, like `online`) ---
# Keyed per (scope, caller). Multiple uvicorn workers would each keep their own
# window — shared limits need Redis, the same ceiling the realtime dict hits.
_RL_DISABLED = os.environ.get("RL_DISABLED") == "1"  # tests flip this off
_rl_hits: dict[tuple, list[float]] = {}


def rate_limit(max_calls: int, window: float, scope: str, by: str = "ip"):
    """Dependency factory: at most `max_calls` per `window` seconds per caller."""
    def dep(request: Request):
        if _RL_DISABLED:
            return
        # pre-auth endpoints key by IP; authed ones key by the bearer token (per-user)
        who = (request.headers.get("authorization", "") if by == "token"
               else (request.client.host if request.client else "?"))
        key = (scope, who)
        now = time.time()
        hits = _rl_hits.setdefault(key, [])
        cutoff = now - window
        while hits and hits[0] < cutoff:  # drop timestamps that fell out of the window
            hits.pop(0)
        if len(hits) >= max_calls:
            retry = int(hits[0] + window - now) + 1
            raise HTTPException(429, "too many requests", headers={"Retry-After": str(retry)})
        hits.append(now)
    return dep


# strict on the brute-forceable front door, generous on the data plane the UI polls
login_limit = rate_limit(5, 60, "login")
signup_limit = rate_limit(5, 60, "signup")
exists_limit = rate_limit(60, 60, "exists")
api_limit = rate_limit(300, 60, "api", by="token")

def profile_row(username : str):
    row = db.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
    if not row:
        raise HTTPException(404, "no such user")
    return {"username": row["username"], "avatar": row["avatar"],
            "name":row["name"], "bio": row["bio"]}




class Credentials(BaseModel):
    username: str
    password: str
    avatar: str | None = None  # only used by signup


@app.get("/exists/{username}", dependencies=[Depends(exists_limit)])
def exists(username: str):
    """Live availability check for the signup form — stays PUBLIC (used before login)."""
    row = db.execute("SELECT 1 FROM users WHERE username = ?", (username.strip(),)).fetchone()
    return {"taken": row is not None}


@app.post("/signup", dependencies=[Depends(signup_limit)])
def signup(body: Credentials):
    name = body.username.strip()
    if not name or len(name) > 24:
        raise HTTPException(400, "username must be 1-24 characters")
    if len(body.password) < 6:
        raise HTTPException(400, "password must be at least 6 characters")
    if body.avatar and len(body.avatar) > 200_000:
        raise HTTPException(413, "avatar too large")
    if db.execute("SELECT 1 FROM users WHERE username = ?", (name,)).fetchone():
        raise HTTPException(409, "username already taken")
    db.execute("INSERT INTO users(username, password, avatar) VALUES (?, ?, ?)",
               (name, hash_password(body.password), body.avatar))
    db.commit()
    return {**profile_row(name), "token": issue_token(name)}


@app.post("/login", dependencies=[Depends(login_limit)])
def login(body: Credentials):
    row = db.execute("SELECT * FROM users WHERE username = ?", (body.username.strip(),)).fetchone()
    # same 401 for unknown user AND wrong password — never leak which half was wrong
    if not row or not row["password"] or not verify_password(body.password, row["password"]):
        raise HTTPException(401, "invalid username or password")
    return {**profile_row(row["username"]), "token": issue_token(row["username"])}


@app.post("/logout")
def logout(me: str = Depends(current_user), authorization: str = Header(default="")):
    payload = decode_token(authorization.removeprefix("Bearer ").strip())
    if payload:  # add this token's jti to the denylist; stateless tokens can't just be deleted
        db.execute("INSERT OR IGNORE INTO revoked(jti, exp) VALUES (?, ?)",
                   (payload["jti"], payload["exp"]))
        db.execute("DELETE FROM revoked WHERE exp < ?", (time.time(),))  # sweep expired
        db.commit()
    return {"ok": True}

@app.get("/notifications", dependencies=[Depends(api_limit)])
def list_notifications(me: str = Depends(current_user)):
    """The pane's history: my 50 most recent notifications, newest first."""
    rows = db.execute(
        "SELECT * FROM notifications WHERE username = ? ORDER BY id DESC LIMIT 50", (me,)
    ).fetchall()
    return [dict(r) for r in rows]


@app.post("/notifications/read", dependencies=[Depends(api_limit)])
def read_notifications(me: str = Depends(current_user)):
    """Clear the unread badge — called when the pane is opened."""
    db.execute("UPDATE notifications SET read = 1 WHERE username = ? AND read = 0", (me,))
    db.commit()
    return {"ok": True}


@app.post("/notifications/clear", dependencies=[Depends(api_limit)])
def clear_notifications(me: str = Depends(current_user)):
    db.execute("DELETE FROM notifications WHERE username = ?", (me,))
    db.commit()
    return {"ok": True}


class PushSubscription(BaseModel):
    endpoint: str
    keys: dict          # {"p256dh": ..., "auth": ...} — the browser's encryption keys


@app.get("/push/key")
def push_key():
    """The VAPID public key the browser needs to subscribe. Public by design."""
    return {"key": VAPID_PUBLIC}


@app.post("/push/subscribe", dependencies=[Depends(api_limit)])
def push_subscribe(sub: PushSubscription, me: str = Depends(current_user)):
    db.execute("INSERT OR REPLACE INTO push_subs(username, endpoint, sub_json) VALUES (?,?,?)",
               (me, sub.endpoint, sub.model_dump_json()))
    db.commit()
    return {"ok": True}


@app.post("/push/unsubscribe", dependencies=[Depends(api_limit)])
def push_unsubscribe(sub: PushSubscription, me: str = Depends(current_user)):
    db.execute("DELETE FROM push_subs WHERE username = ? AND endpoint = ?", (me, sub.endpoint))
    db.commit()
    return {"ok": True}


@app.get("/users", dependencies=[Depends(api_limit)])
def users(q: str = "", me: str = Depends(current_user)):
    rows = db.execute(
        """
        SELECT u.username, u.avatar, u.name,
        (SELECT COUNT(*) FROM messages m
        WHERE m.sender = u.username
        AND m.recipient = ?
        AND m.status != 'read') AS unread
        FROM users u
        WHERE u.username != ?
        AND (u.username LIKE '%' || ? || '%' OR u.name LIKE '%' || ? || '%')
        ORDER BY u.username

        """,
        (me,me, q, q),
    ).fetchall()
    return [
        {"username": r["username"], "avatar" : r["avatar"], "name": r["name"],  "unread": r["unread"], "online": r["username"] in online}
        for r in rows
    ]

@app.get("/messages", dependencies=[Depends(api_limit)])
def messages(other: str, me: str = Depends(current_user)):
    rows = db.execute(
        """
        SELECT * FROM messages
        WHERE (sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?)
        ORDER BY id
        """,
        (me, other, other, me),
    ).fetchall()
    msgs = [dict(r) for r in rows]
    if msgs:
        ids = [m["id"] for m in msgs]
        marks = ",".join("?" * len(ids))
        by_msg: dict[int, list] = {}
        for r in db.execute(f"SELECT * FROM reactions WHERE message_id IN ({marks})", ids):
            by_msg.setdefault(r["message_id"], []).append({"emoji": r["emoji"], "by": r["username"]})
        for m in msgs:
            m["reactions"] = by_msg.get(m["id"], [])
    return msgs

class ProfileUpdate(BaseModel):
    name: str | None = None
    bio: str | None = None
    avatar: str | None = None

@app.post("/profile", dependencies=[Depends(api_limit)])
def update_profile(body: ProfileUpdate, me: str = Depends(current_user)):
    if body.avatar and len(body.avatar) > 200_000:
        raise HTTPException(413, "avatar too large")
    if body.name is not None and len(body.name) >40:
        raise HTTPException(400, "name too long")
    if body.bio is not None and len(body.bio) > 300:
        raise HTTPException(400, "bio is too long")
    for field in ("name", "bio", "avatar"):
        value = getattr(body, field)
        if value is not None:
            db.execute(f"UPDATE users SET {field} = ? WHERE username = ?", (value.strip() or None, me))
    db.commit()
    return profile_row(me)


@app.get("/chats", dependencies=[Depends(api_limit)])
def chats(me: str = Depends(current_user)):
    """The sidebar dock: everyone I have history with, newest conversation first"""
    partners = [r[0] for r in db.execute(
        """SELECT DISTINCT CASE WHEN sender = ? THEN recipient ELSE sender END
           FROM messages WHERE sender = ? OR recipient = ?""", (me, me, me))]
    out = []
    for p in partners:
        last = db.execute(
            """SELECT * FROM messages
               WHERE (sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?)
               ORDER BY id DESC LIMIT 1""", (me, p, p, me)).fetchone()
        unread = db.execute(
            "SELECT COUNT(*) FROM messages WHERE sender = ? AND recipient = ? AND status != 'read'",
            (p, me)).fetchone()[0]
        user = db.execute("SELECT avatar, name FROM users WHERE username = ?", (p,)).fetchone()
        out.append({
            "username": p, "avatar": user["avatar"] if user else None,
            "name": user["name"] if user else None, "online": p in online,
            "unread": unread, "last_text": last["text"], "last_ts": last["ts"],
            "last_sender": last["sender"], "last_status": last["status"],
        })
    out.sort(key=lambda c: c["last_ts"], reverse=True)
    return out


@app.get("/profile/{username}", dependencies=[Depends(api_limit)])
def get_profile(username: str, me: str = Depends(current_user)):
    return {**profile_row(username), "online": username in online}




# --- the wire protocol -------------------------------------------------
#
# client -> server                      server -> client
# {"type":"message","to","text"}        {"type":"message", id, sender,
#                                        recipient, text, ts, status}
#                                       (echo of your own send, same shape)
#                                       {"type":"delivered","by":user}
#                                       (bulk: everything I sent them landed)
# {"type":"read","from":user}           {"type":"read","by":user}
# {"type":"typing","to":user}           {"type":"typing","from":user}
#                                       {"type":"presence","user","online"}
#
# The bottom two are *ephemeral*: forwarded to whoever's connected right now,
# never written to the db. If nobody's there to see it, dropping it is correct.
#
# One dict, no locks: uvicorn runs a single event loop, so every connection
# lives on it and nothing here is ever concurrent. Two workers would break
# this — that's the Redis pub/sub upgrade path.
online: dict[str, WebSocket] = {}


async def push(user: str, payload: dict):
    """Send an event to a user if they're connected. Silently drops if offline."""
    ws = online.get(user)
    if ws:
        await ws.send_json(payload)


async def broadcast_presence(user: str, is_online: bool):
    """Tell everyone else that `user` just came online or went offline."""
    # snapshot with list() — the dict can change while we await mid-loop
    for name, ws in list(online.items()):
        if name != user:
            await ws.send_json({"type": "presence", "user": user, "online": is_online})


async def notify(user: str, kind: str, actor: str, body: str):
    """Record something the user missed while away, then try to reach them off-tab
    via web push. Skipped entirely when they're connected: a live socket means they
    already saw it (as a message + toast), so it isn't a "missed" notification."""
    if user in online:
        return
    body = body[:200]
    db.execute(
        "INSERT INTO notifications(username, kind, actor, body, ts) VALUES (?,?,?,?,?)",
        (user, kind, actor, body, time.time()),
    )
    db.commit()
    await send_web_push(user, actor, body)   # their browser can wake even with the tab closed


@app.websocket("/ws")
async def chat_ws(ws: WebSocket, token: str = ""):
    # browsers can't set headers on a WS connect, so identity rides in ?token=.
    # Validate BEFORE accept() — reject the handshake outright on a bad token.
    username = user_for_token(token)
    if not username:
        await ws.close(code=4401)
        return
    await ws.accept()
    online[username] = ws

    # anything addressed to me while I was away has now arrived — tell its senders.
    # Read the senders *before* the UPDATE, or the WHERE clause matches nothing.
    senders = [r["sender"] for r in db.execute(
        "SELECT DISTINCT sender FROM messages WHERE recipient = ? AND status = 'sent'",
        (username,),
    )]
    db.execute(
        "UPDATE messages SET status = 'delivered' WHERE recipient = ? AND status = 'sent'",
        (username,),
    )
    db.commit()
    for s in senders:
        await push(s, {"type": "delivered", "by": username})

    await broadcast_presence(username, True)

    try:
        while True:
            event = await ws.receive_json()

            if event.get("type") == "message":
                to, text = event["to"], event["text"]
                status = "delivered" if to in online else "sent"
                ts = time.time()
                cur = db.execute(
                    "INSERT INTO messages(sender, recipient, text, ts, status) VALUES(?,?,?,?,?)",
                    (username, to, text, ts, status),
                )
                db.commit()
                out = {"type": "message", "id": cur.lastrowid, "sender": username,
                       "recipient": to, "text": text, "ts": ts, "status": status,
                       "reactions": []}
                await push(to, out)
                await notify(to, "message", username, text)  # feed the recipient's pane
                # echo carries the real id + status; client_id reconciles the optimistic bubble
                await ws.send_json({**out, "client_id": event.get("client_id")})

            elif event.get("type") == "read":
                other = event["from"]      # whose messages I just read
                db.execute(
                    """UPDATE messages SET status = 'read'
                       WHERE sender = ? AND recipient = ? AND status != 'read'""",
                    (other, username),
                )
                db.commit()
                await push(other, {"type": "read", "by": username})

            elif event.get("type") == "typing":
                # pure forward, no db: only means anything to whoever's watching now
                await push(event["to"], {"type": "typing", "from": username})

            elif event.get("type") == "reaction":
                mid, emoji = event["message_id"], event["emoji"]
                msg = db.execute("SELECT sender, recipient, text FROM messages WHERE id = ?", (mid,)).fetchone()
                if not msg or username not in (msg["sender"], msg["recipient"]):
                    continue  # only participants may react
                existing = db.execute(
                    "SELECT emoji FROM reactions WHERE message_id = ? AND username = ?", (mid, username)).fetchone()
                removed = bool(existing and existing["emoji"] == emoji)
                if removed:                          # same emoji again = toggle off
                    db.execute("DELETE FROM reactions WHERE message_id = ? AND username = ?", (mid, username))
                else:                                # new or switched emoji
                    db.execute("INSERT OR REPLACE INTO reactions VALUES (?,?,?)", (mid, username, emoji))
                db.commit()
                out = {"type": "reaction", "message_id": mid, "emoji": emoji, "by": username,
                       "removed": removed, "message_text": msg["text"],
                       "message_sender": msg["sender"], "message_recipient": msg["recipient"]}
                await push(msg["sender"], out)
                if msg["recipient"] != msg["sender"]:
                    await push(msg["recipient"], out)
                # only the message's owner cares that someone reacted, and only when
                # a reaction is added (not toggled off) by somebody other than them
                if not removed and username != msg["sender"]:
                    await notify(msg["sender"], "reaction", username, f'{emoji} to "{msg["text"]}"')
    except WebSocketDisconnect:
        pass
    finally:
        # only clear the slot if it's still ours — a second tab may have replaced us
        if online.get(username) is ws:
            del online[username]
            await broadcast_presence(username, False)


# --- serve the built frontend (declared last so it never shadows the API) ---
DIST = Path(__file__).parent.parent / "frontend" / "dist"
if (DIST / "assets").exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")


@app.get("/sw.js")
def service_worker():
    # Must be served from the site root (a worker only controls its own path down),
    # and NOT from /assets — so it gets its own explicit route.
    return FileResponse(DIST / "sw.js", media_type="application/javascript")


@app.get("/")
def index():
    return FileResponse(DIST / "index.html")

