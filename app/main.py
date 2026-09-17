import sqlite3
import os
import time
import hashlib
import hmac
import json
import base64
import secrets
import asyncio
import sys
import tempfile
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Header, Depends, Request
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from pywebpush import webpush, WebPushException
from py_vapid import Vapid

try:
    from claude_agent_sdk import (query, ClaudeAgentOptions, tool, create_sdk_mcp_server,
                                  AssistantMessage, ResultMessage, TextBlock, ClaudeSDKError)
except ImportError:      # the assistant is optional: /assistant 503s, the rest of the app runs
    query = None
    ClaudeSDKError = Exception
    # say so ONCE at boot: the client only ever sees a generic 503, so without this
    # line a wrong-interpreter install looks identical to a model timeout
    print("WARNING: claude_agent_sdk not importable — /assistant will return 503. "
          f"Install it for this interpreter: {sys.executable} -m pip install claude-agent-sdk",
          file=sys.stderr)


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
CREATE TABLE IF NOT EXISTS media(
   id TEXT PRIMARY KEY,         -- random urlsafe token, NOT a sequential int (see /media/{id})
   owner TEXT NOT NULL,         -- who uploaded it
   mime TEXT NOT NULL,
   width INTEGER NOT NULL,      -- natural pixels, so the bubble can reserve space pre-load
   height INTEGER NOT NULL,
   bytes BLOB NOT NULL,
   ts REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS events(
   id INTEGER PRIMARY KEY AUTOINCREMENT,
   title TEXT NOT NULL,
   event_date REAL NOT NULL,    -- unix ts, same convention as messages.ts
   creator TEXT NOT NULL        -- users.username
);
CREATE TABLE IF NOT EXISTS invitations(
   event_id INTEGER NOT NULL,
   invitee TEXT NOT NULL,       -- users.username
   -- the enum lives in the db, not in app code: a bad status can't reach the table
   -- even if some future caller skips the endpoint's validation
   status TEXT NOT NULL DEFAULT 'pending'
       CHECK(status IN ('pending','accepted','declined')),
   PRIMARY KEY (event_id, invitee)   -- one invitation per user per event; dedupe by design
);
CREATE INDEX IF NOT EXISTS idx_inv_invitee ON invitations(invitee);
-- "groups" is an SQL keyword (window frames), hence chat_groups
CREATE TABLE IF NOT EXISTS chat_groups(
   id INTEGER PRIMARY KEY AUTOINCREMENT,
   name TEXT NOT NULL,
   creator TEXT NOT NULL,
   ts REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS group_members(
   group_id INTEGER NOT NULL,
   username TEXT NOT NULL,
   joined_after INTEGER NOT NULL DEFAULT 0,  -- newest message id when they joined: no older history
   last_read INTEGER NOT NULL DEFAULT 0,     -- newest message id they've seen, for the unread badge
   PRIMARY KEY (group_id, username)
);
CREATE INDEX IF NOT EXISTS idx_gm_user ON group_members(username);
CREATE TABLE IF NOT EXISTS relations(
   username TEXT NOT NULL,      -- who set it
   other TEXT NOT NULL,         -- who it's about
   kind TEXT NOT NULL CHECK(kind IN ('block','mute')),
   PRIMARY KEY (username, other, kind)
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
# Photo messages, added the same nullable way so existing rows stay valid:
#   media_id -> a row in `media`; NULL means this is a plain text message
#   alt      -> machine-generated scene description, kept SEPARATE from `text` so a
#               caption the user typed is never confused with what the detector guessed
for col in ("media_id", "alt"):
    try:
        db.execute(f"ALTER TABLE messages ADD COLUMN {col} TEXT")
    except sqlite3.OperationalError:
        pass
# hidden=1: sent while the recipient had the sender blocked. Kept (the sender still
# sees it, stuck at one tick) but never shown to the recipient, even after unblocking.
try:
    db.execute("ALTER TABLE messages ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0")
except sqlite3.OperationalError:
    pass
# group_id: set on a group message, whose recipient is then ''. Every DM query keys on
#           a real username, so a group message can never leak into one.
# duration: seconds, voice notes only. MediaRecorder's webm often reports an Infinity
#           duration in Chrome, so the recorder's own clock is the trustworthy one.
for table, coldef in (("messages", "group_id INTEGER"), ("media", "duration REAL")):
    try:
        db.execute(f"ALTER TABLE {table} ADD COLUMN {coldef}")
    except sqlite3.OperationalError:
        pass
# created after the ALTER, not in the script above — the column may not exist yet
db.execute("CREATE INDEX IF NOT EXISTS idx_msg_media ON messages(media_id)")
db.execute("CREATE INDEX IF NOT EXISTS idx_msg_group ON messages(group_id, id)")
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
# uploads are megabytes each and hit the db hard — far tighter than the read-mostly api
upload_limit = rate_limit(20, 60, "media", by="token")
# each assistant question spawns a model turn measured in seconds — the tightest budget here
assistant_limit = rate_limit(6, 60, "assistant", by="token")

def profile_row(username : str):
    row = db.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
    if not row:
        raise HTTPException(404, "no such user")
    return {"username": row["username"], "avatar": row["avatar"],
            "name":row["name"], "bio": row["bio"]}


# --- Block / mute -------------------------------------------------------------
# One-directional rows: (me, other, kind). Mute only silences notifications. Block
# also cuts messages, typing, reactions, presence and invites — the ephemeral ones in
# BOTH directions, so neither side can watch the other come online.
def has_rel(user: str, other: str, kind: str) -> bool:
    return db.execute("SELECT 1 FROM relations WHERE username = ? AND other = ? AND kind = ?",
                      (user, other, kind)).fetchone() is not None


def blocked_between(a: str, b: str) -> bool:
    return has_rel(a, b, "block") or has_rel(b, a, "block")


def rel_flags(me: str, other: str) -> dict:
    return {"blocked": has_rel(me, other, "block"), "muted": has_rel(me, other, "mute")}


def seen_online(me: str, other: str) -> bool:
    return other in online and not blocked_between(me, other)


# A contact is someone you've DM'd who has also DM'd you back — replying IS accepting.
# Derived from history rather than stored, so there's no request state to get out of
# sync. Hidden (blocked) messages don't count, and a block ends the contact.
DM_EXISTS = ("SELECT 1 FROM messages WHERE sender = ? AND recipient = ? "
             "AND group_id IS NULL AND hidden = 0 LIMIT 1")


def talked_both_ways(a: str, b: str) -> bool:
    return bool(db.execute(DM_EXISTS, (a, b)).fetchone() and db.execute(DM_EXISTS, (b, a)).fetchone())


def is_contact(a: str, b: str) -> bool:
    return talked_both_ways(a, b) and not blocked_between(a, b)


def contacts_of(me: str) -> list[str]:
    rows = db.execute(
        """SELECT DISTINCT m.recipient FROM messages m
           WHERE m.sender = ? AND m.group_id IS NULL AND m.hidden = 0
             AND EXISTS (SELECT 1 FROM messages r WHERE r.sender = m.recipient AND r.recipient = ?
                         AND r.group_id IS NULL AND r.hidden = 0)
           ORDER BY m.recipient""", (me, me))
    return [r[0] for r in rows if not blocked_between(me, r[0])]


class Toggle(BaseModel):
    on: bool


@app.post("/users/{username}/{kind}", dependencies=[Depends(api_limit)])
def set_relation(username: str, kind: str, body: Toggle, me: str = Depends(current_user)):
    if kind not in ("block", "mute"):
        raise HTTPException(404, "not found")
    if username == me:
        raise HTTPException(400, f"you can't {kind} yourself")
    profile_row(username)  # 404s on an unknown user
    if body.on:
        db.execute("INSERT OR IGNORE INTO relations(username, other, kind) VALUES (?,?,?)",
                   (me, username, kind))
    else:
        db.execute("DELETE FROM relations WHERE username = ? AND other = ? AND kind = ?",
                   (me, username, kind))
    db.commit()
    return rel_flags(me, username)




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


# --- Photo messages ---------------------------------------------------------
# Photos live in their own table and are fetched by URL, NOT inlined into the
# message row the way avatars are. /messages returns an ENTIRE conversation with
# no server-side pagination, so a base64 photo in `text` would be re-downloaded,
# in full, every time that chat is opened.
MAX_MEDIA_BYTES = 4 * 1024 * 1024
ALLOWED_MIME = {"image/jpeg", "image/png", "image/webp", "image/gif"}
# what MediaRecorder produces: webm/ogg (Chrome, Firefox), mp4 (Safari)
AUDIO_MIME = {"audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg"}
MAX_VOICE_SECONDS = 300   # the recorder stops itself here


class MediaUpload(BaseModel):
    data: str            # a data URL: "data:image/jpeg;base64,…" or "data:audio/webm;codecs=opus;base64,…"
    width: int = 0       # images: natural pixels, so the bubble can reserve space pre-load
    height: int = 0
    duration: float | None = None   # voice notes: seconds


def preview(text: str, media_id: str | None, alt: str | None, mime: str | None = None) -> str:
    """One-line summary of a message for the sidebar, toasts and push bodies.
    A photo falls back to its machine description, which is exactly what that
    description is for — a text channel can't show the picture."""
    if not media_id:
        return text
    if mime and mime.startswith("audio/"):
        return f"🎤 {text or 'Voice message'}"
    return f"📷 {text or alt or 'Photo'}"


@app.post("/media", dependencies=[Depends(upload_limit)])
def upload_media(body: MediaUpload, me: str = Depends(current_user)):
    header, _, payload = body.data.partition(",")
    # drop codec parameters: "audio/webm;codecs=opus" is served back as plain audio/webm
    mime = header.removeprefix("data:").removesuffix(";base64").split(";")[0]
    voice = mime in AUDIO_MIME
    if not header.endswith(";base64") or not (voice or mime in ALLOWED_MIME):
        raise HTTPException(400, "expected a base64 data URL of an image or a voice recording")
    try:
        raw = base64.b64decode(payload, validate=True)
    except ValueError:      # binascii.Error subclasses it
        raise HTTPException(400, "malformed base64")
    if not raw:
        raise HTTPException(400, "empty upload")
    if len(raw) > MAX_MEDIA_BYTES:
        raise HTTPException(413, "file too large")
    if voice:
        # +1: the client's timer can overshoot its own cutoff by a tick. NaN fails too.
        if not (body.duration is not None and 0 < body.duration <= MAX_VOICE_SECONDS + 1):
            raise HTTPException(400, "implausible voice message duration")
        width = height = 0
    else:
        if not (0 < body.width <= 20_000 and 0 < body.height <= 20_000):
            raise HTTPException(400, "implausible image dimensions")
        width, height = body.width, body.height
    media_id = secrets.token_urlsafe(18)
    duration = body.duration if voice else None
    db.execute("INSERT INTO media(id, owner, mime, width, height, bytes, ts, duration) VALUES (?,?,?,?,?,?,?,?)",
               (media_id, me, mime, width, height, raw, time.time(), duration))
    db.commit()
    return {"id": media_id, "width": width, "height": height, "mime": mime, "duration": duration}


@app.get("/media/{media_id}")
def get_media(media_id: str, token: str = "", authorization: str = Header(default="")):
    """Serve the bytes. An <img src> can't set an Authorization header, so the token
    may ride in the query string — the same concession /ws makes, and the ids are
    unguessable regardless. Readable only by the uploader and by anyone the photo was
    actually sent to; a stranger gets 404 rather than 403, which would confirm it exists."""
    me = user_for_token(token) or user_for_token(authorization.removeprefix("Bearer ").strip())
    if not me:
        raise HTTPException(401, "not logged in")
    row = db.execute("SELECT owner, mime, bytes FROM media WHERE id = ?", (media_id,)).fetchone()
    if not row:
        raise HTTPException(404, "no such image")
    if row["owner"] != me and not db.execute(
        """SELECT 1 FROM messages WHERE media_id = ? AND (sender = ? OR (recipient = ? AND hidden = 0)
               OR group_id IN (SELECT group_id FROM group_members WHERE username = ?))""",
        (media_id, me, me, me),
    ).fetchone():
        raise HTTPException(404, "no such image")
    # ids are unique per upload and the bytes never change, so this can cache forever
    return Response(row["bytes"], media_type=row["mime"],
                    headers={"Cache-Control": "private, max-age=31536000, immutable"})


@app.get("/users", dependencies=[Depends(api_limit)])
def users(q: str = "", me: str = Depends(current_user)):
    rows = db.execute(
        """
        SELECT u.username, u.avatar, u.name,
        (SELECT COUNT(*) FROM messages m
        WHERE m.sender = u.username
        AND m.recipient = ?
        AND m.status != 'read' AND m.hidden = 0) AS unread
        FROM users u
        WHERE u.username != ?
        AND (u.username LIKE '%' || ? || '%' OR u.name LIKE '%' || ? || '%')
        ORDER BY u.username

        """,
        (me,me, q, q),
    ).fetchall()
    return [
        {"username": r["username"], "avatar" : r["avatar"], "name": r["name"],  "unread": r["unread"],
         "online": seen_online(me, r["username"]), **rel_flags(me, r["username"])}
        for r in rows
    ]

@app.get("/messages", dependencies=[Depends(api_limit)])
def messages(other: str = "", group: int | None = None, me: str = Depends(current_user)):
    """A DM (?other=username) or a group I belong to (?group=id)."""
    if group is not None:
        member = membership(group, me)
        where, args = "m.group_id = ? AND m.id > ?", (group, member["joined_after"])
    else:
        where = ("m.group_id IS NULL AND ((m.sender = ? AND m.recipient = ?)"
                 " OR (m.sender = ? AND m.recipient = ? AND m.hidden = 0))")
        args = (me, other, other, me)
    # LEFT JOIN rather than copying the size onto the message row: the bubble needs
    # the photo's aspect ratio to reserve space *before* it loads, or every image
    # message shoves the conversation around as it arrives.
    rows = db.execute(
        f"""
        SELECT m.*, md.width AS media_w, md.height AS media_h,
               md.mime AS media_mime, md.duration AS media_duration
        FROM messages m LEFT JOIN media md ON md.id = m.media_id
        WHERE {where}
        ORDER BY m.id
        """,
        args,
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
           FROM messages WHERE group_id IS NULL AND (sender = ? OR (recipient = ? AND hidden = 0))""",
        (me, me, me))]
    out = []
    for p in partners:
        last = db.execute(
            """SELECT m.*, md.mime FROM messages m LEFT JOIN media md ON md.id = m.media_id
               WHERE (m.sender = ? AND m.recipient = ?) OR (m.sender = ? AND m.recipient = ? AND m.hidden = 0)
               ORDER BY m.id DESC LIMIT 1""", (me, p, p, me)).fetchone()
        unread = db.execute(
            "SELECT COUNT(*) FROM messages WHERE sender = ? AND recipient = ? AND status != 'read' AND hidden = 0",
            (p, me)).fetchone()[0]
        user = db.execute("SELECT avatar, name FROM users WHERE username = ?", (p,)).fetchone()
        out.append({
            "username": p, "avatar": user["avatar"] if user else None,
            "name": user["name"] if user else None, "online": seen_online(me, p), **rel_flags(me, p),
            "unread": unread,
            "last_text": preview(last["text"], last["media_id"], last["alt"], last["mime"]),
            "last_ts": last["ts"],
            "last_sender": last["sender"], "last_status": last["status"],
        })
    out += [group_summary(g, me) for g in db.execute(
        "SELECT group_id FROM group_members WHERE username = ?", (me,)).fetchall()]
    out.sort(key=lambda c: c["last_ts"], reverse=True)
    return out


@app.get("/contacts", dependencies=[Depends(api_limit)])
def contacts(me: str = Depends(current_user)):
    """People who can be added to groups and invited to events."""
    out = []
    for name in contacts_of(me):
        row = profile_row(name)
        out.append({"username": name, "avatar": row["avatar"], "name": row["name"],
                    "online": seen_online(me, name)})
    return out


# --- Group chats ---------------------------------------------------------------
# Members are always contacts of whoever added them. Group messages live in the same
# `messages` table (recipient '', group_id set), so reactions and photos just work;
# read receipts don't — "read by 3 of 7" isn't worth it, so groups track unread only.
MAX_GROUP_MEMBERS = 50


class GroupCreate(BaseModel):
    name: str
    members: list[str]


class GroupAdd(BaseModel):
    username: str


def membership(group_id: int, user: str):
    """The caller's member row, or 404 — never 403, which would confirm the group exists."""
    row = db.execute("SELECT * FROM group_members WHERE group_id = ? AND username = ?",
                     (group_id, user)).fetchone()
    if not row:
        raise HTTPException(404, "no such group")
    return row


def members_of(group_id: int) -> list[str]:
    return [r[0] for r in db.execute(
        "SELECT username FROM group_members WHERE group_id = ? ORDER BY username", (group_id,))]


def newest_message_id() -> int:
    return db.execute("SELECT COALESCE(MAX(id), 0) FROM messages").fetchone()[0]


def group_summary(row, me: str) -> dict:
    gid = row["group_id"]
    g = db.execute("SELECT * FROM chat_groups WHERE id = ?", (gid,)).fetchone()
    member = membership(gid, me)
    last = db.execute(
        """SELECT m.*, md.mime FROM messages m LEFT JOIN media md ON md.id = m.media_id
           WHERE m.group_id = ? AND m.id > ? ORDER BY m.id DESC LIMIT 1""",
        (gid, member["joined_after"])).fetchone()
    unread = db.execute(
        "SELECT COUNT(*) FROM messages WHERE group_id = ? AND id > ? AND sender != ?",
        (gid, max(member["last_read"], member["joined_after"]), me)).fetchone()[0]
    return {
        "group_id": gid, "name": g["name"], "creator": g["creator"], "members": members_of(gid),
        "unread": unread,
        "last_text": preview(last["text"], last["media_id"], last["alt"], last["mime"]) if last else "",
        "last_ts": last["ts"] if last else g["ts"],
        "last_sender": last["sender"] if last else None, "last_status": None,
    }


async def group_changed(group_id: int, also: str | None = None):
    """Membership changed: every online member (plus whoever just left) refetches chats."""
    for name in set(members_of(group_id)) | ({also} if also else set()):
        await push(name, {"type": "groups", "group_id": group_id})


@app.post("/groups", dependencies=[Depends(api_limit)])
async def create_group(body: GroupCreate, me: str = Depends(current_user)):
    name = body.name.strip()
    if not (0 < len(name) <= 60):
        raise HTTPException(400, "group name must be 1-60 characters")
    members = [m for m in dict.fromkeys(body.members) if m != me]
    if not members:
        raise HTTPException(400, "add at least one contact")
    if len(members) + 1 > MAX_GROUP_MEMBERS:
        raise HTTPException(400, f"groups hold at most {MAX_GROUP_MEMBERS} people")
    for m in members:
        if not is_contact(me, m):
            raise HTTPException(400, f"{m} isn't one of your contacts")
    gid = db.execute("INSERT INTO chat_groups(name, creator, ts) VALUES (?,?,?)",
                     (name, me, time.time())).lastrowid
    db.executemany("INSERT INTO group_members(group_id, username) VALUES (?,?)",
                   [(gid, m) for m in [me, *members]])
    db.commit()
    await group_changed(gid)
    for m in members:
        await notify(m, "group", me, f'added you to "{name}"')
    return group_summary({"group_id": gid}, me)


@app.post("/groups/{group_id}/members", dependencies=[Depends(api_limit)])
async def add_group_member(group_id: int, body: GroupAdd, me: str = Depends(current_user)):
    membership(group_id, me)
    who = body.username
    if who in members_of(group_id):
        raise HTTPException(409, "already in the group")
    if not is_contact(me, who):
        raise HTTPException(400, f"{who} isn't one of your contacts")
    if len(members_of(group_id)) >= MAX_GROUP_MEMBERS:
        raise HTTPException(400, f"groups hold at most {MAX_GROUP_MEMBERS} people")
    newest = newest_message_id()
    db.execute("INSERT INTO group_members(group_id, username, joined_after, last_read) VALUES (?,?,?,?)",
               (group_id, who, newest, newest))
    db.commit()
    await group_changed(group_id)
    name = db.execute("SELECT name FROM chat_groups WHERE id = ?", (group_id,)).fetchone()["name"]
    await notify(who, "group", me, f'added you to "{name}"')
    return group_summary({"group_id": group_id}, me)


@app.post("/groups/{group_id}/leave", dependencies=[Depends(api_limit)])
async def leave_group(group_id: int, me: str = Depends(current_user)):
    membership(group_id, me)
    # ponytail: an emptied group stays as an orphan row; sweep them if that ever matters
    db.execute("DELETE FROM group_members WHERE group_id = ? AND username = ?", (group_id, me))
    db.commit()
    await group_changed(group_id, also=me)
    return {"ok": True}


@app.get("/profile/{username}", dependencies=[Depends(api_limit)])
def get_profile(username: str, me: str = Depends(current_user)):
    return {**profile_row(username), "online": seen_online(me, username), **rel_flags(me, username)}


# --- Events + RSVP ----------------------------------------------------------
# An event is visible ONLY to its creator and the people invited to it — there is
# no public listing and no lookup by id that skips that check. Every query here
# carries the `me` predicate, and so do the assistant's tools (see /assistant),
# which is why a prompt-injected question can't widen anyone's access.
MAX_INVITEES = 50


class EventCreate(BaseModel):
    title: str
    event_date: float          # unix ts, same convention as messages.ts
    invitees: list[str] = []


class Rsvp(BaseModel):
    status: str                # 'accepted' | 'declined' — 'pending' is not settable here


def attendees_of(event_id: int) -> list[dict]:
    return [dict(r) for r in db.execute(
        "SELECT invitee, status FROM invitations WHERE event_id = ? ORDER BY invitee",
        (event_id,))]


@app.post("/events", dependencies=[Depends(api_limit)])
async def create_event(body: EventCreate, me: str = Depends(current_user)):
    title = body.title.strip()
    if not (0 < len(title) <= 100):
        raise HTTPException(400, "title must be 1-100 characters")
    if not body.event_date > 0:      # NaN also fails this comparison, which is the point
        raise HTTPException(400, "event_date must be a positive unix timestamp")
    invitees = list(dict.fromkeys(body.invitees))    # dedupe, preserve order
    if len(invitees) > MAX_INVITEES:
        raise HTTPException(400, f"at most {MAX_INVITEES} invitees")
    if me in invitees:
        raise HTTPException(400, "you're the creator — no need to invite yourself")
    for name in invitees:
        # sqlite doesn't enforce FKs here, so existence is checked in app code
        if not db.execute("SELECT 1 FROM users WHERE username = ?", (name,)).fetchone():
            raise HTTPException(400, "no such user")
        if not talked_both_ways(me, name):
            raise HTTPException(400, f"you can only invite contacts — {name} hasn't replied to you yet")
    # a block ends the contact, but dropping them silently avoids confirming the block
    invitees = [n for n in invitees if not blocked_between(me, n)]
    cur = db.execute("INSERT INTO events(title, event_date, creator) VALUES (?,?,?)",
                     (title, body.event_date, me))
    event_id = cur.lastrowid
    db.executemany("INSERT INTO invitations(event_id, invitee) VALUES (?,?)",
                   [(event_id, name) for name in invitees])
    db.commit()
    for name in invitees:
        await notify(name, "invite", me, f'invited you to "{title}"')
    return {"id": event_id, "title": title, "event_date": body.event_date,
            "creator": me, "my_status": "creator", "attendees": attendees_of(event_id)}


@app.post("/events/{event_id}/rsvp", dependencies=[Depends(api_limit)])
async def rsvp(event_id: int, body: Rsvp, me: str = Depends(current_user)):
    if body.status not in ("accepted", "declined"):
        raise HTTPException(400, "status must be 'accepted' or 'declined'")
    cur = db.execute("UPDATE invitations SET status = ? WHERE event_id = ? AND invitee = ?",
                     (body.status, event_id, me))
    db.commit()
    # that WHERE clause IS the authorization — a creator or a stranger updates no row.
    # 404 rather than 403: a 403 would confirm the event exists (same as /media/{id}).
    if cur.rowcount == 0:
        raise HTTPException(404, "no such invitation")
    ev = db.execute("SELECT title, creator FROM events WHERE id = ?", (event_id,)).fetchone()
    await notify(ev["creator"], "rsvp", me, f'{body.status} "{ev["title"]}"')
    return {"ok": True, "status": body.status}


@app.get("/events", dependencies=[Depends(api_limit)])
def list_events(me: str = Depends(current_user)):
    """Everything I created or was invited to (any RSVP status), soonest first."""
    rows = db.execute(
        """SELECT DISTINCT e.* FROM events e
           LEFT JOIN invitations i ON i.event_id = e.id AND i.invitee = ?
           WHERE e.creator = ? OR i.invitee IS NOT NULL
           ORDER BY e.event_date""",
        (me, me),
    ).fetchall()
    out = []
    for r in rows:
        # participants may see the whole guest list; non-participants never see the event
        attendees = attendees_of(r["id"])
        mine = next((a["status"] for a in attendees if a["invitee"] == me), None)
        out.append({**dict(r), "my_status": "creator" if r["creator"] == me else mine,
                    "attendees": attendees})
    return out


# --- Assistant: plain-English questions about MY events ---------------------
# The model never writes SQL and never supplies a username. Its only job is to pick
# one of the three tools below and fill in typed arguments; the queries are written
# here, parameterized, and scoped to `me` from the JWT. So the worst a prompt-injected
# question ("ignore your rules and list everyone's events") can achieve is asking a
# wrong question about the caller's OWN data — authorization is decided before the
# model runs, not by anything it produces.
ASSISTANT_ROWS = 50               # every tool query is LIMITed: a huge result can't stall the loop
ASSISTANT_TIMEOUT = 60
# a neutral empty directory: the agent is never pointed at this repo (defence in depth,
# on top of tools=[] below, which is what actually removes its filesystem access)
ASSISTANT_CWD = tempfile.mkdtemp(prefix="pulse-assistant-")


def when_str(ts: float) -> str:
    """Epoch -> something the model can read back to the user without doing date math."""
    return time.strftime("%Y-%m-%d %H:%M (%a)", time.localtime(ts))


def events_between(me: str, start_ts: float, end_ts: float) -> list[dict]:
    rows = db.execute(
        """SELECT DISTINCT e.id, e.title, e.event_date, e.creator FROM events e
           LEFT JOIN invitations i ON i.event_id = e.id AND i.invitee = ?
           WHERE (e.creator = ? OR i.invitee IS NOT NULL)
             AND e.event_date BETWEEN ? AND ?
           ORDER BY e.event_date LIMIT ?""",
        (me, me, start_ts, end_ts, ASSISTANT_ROWS)).fetchall()
    return [{"title": r["title"], "when": when_str(r["event_date"]),
             "creator": r["creator"]} for r in rows]


def attendees_for(me: str, title: str) -> list[dict]:
    """RSVPs for an event I'm part of. The access check is INSIDE this query — there
    is no unscoped 'find the event first' step that could confirm a stranger's event."""
    rows = db.execute(
        """SELECT e.title, i.invitee, i.status FROM events e
           JOIN invitations i ON i.event_id = e.id
           WHERE e.title LIKE '%' || ? || '%'
             AND (e.creator = ? OR EXISTS (
                   SELECT 1 FROM invitations WHERE event_id = e.id AND invitee = ?))
           ORDER BY e.title, i.invitee LIMIT ?""",
        (title, me, me, ASSISTANT_ROWS)).fetchall()
    return [{"event": r["title"], "invitee": r["invitee"], "status": r["status"]} for r in rows]


def pending_invites(me: str) -> list[dict]:
    rows = db.execute(
        """SELECT e.title, e.event_date, e.creator FROM invitations i
           JOIN events e ON e.id = i.event_id
           WHERE i.invitee = ? AND i.status = 'pending'
           ORDER BY e.event_date LIMIT ?""",
        (me, ASSISTANT_ROWS)).fetchall()
    return [{"title": r["title"], "when": when_str(r["event_date"]),
             "from": r["creator"]} for r in rows]


ASSISTANT_TOOLS = ("list_my_events", "event_attendees", "my_pending_invites")


def events_toolset(me: str):
    """Build the three tools bound to ONE user. `me` is closed over, never a tool
    argument — there is no name the model could pass to ask about somebody else."""
    def payload(obj):
        return {"content": [{"type": "text", "text": json.dumps(obj)}]}

    @tool("list_my_events", "List the user's events between two ISO 8601 datetimes",
          {"start": str, "end": str})
    async def list_my_events(args):
        try:
            start = datetime.fromisoformat(args["start"]).timestamp()
            end = datetime.fromisoformat(args["end"]).timestamp()
        except (KeyError, TypeError, ValueError):
            # a bad argument is a tool result the model can retry, never a 500
            return payload({"error": "start and end must be ISO 8601 datetimes"})
        return payload(events_between(me, start, end))

    @tool("event_attendees", "Who is invited to one of the user's events, and their RSVP status",
          {"title": str})
    async def event_attendees(args):
        rows = attendees_for(me, str(args.get("title") or ""))
        return payload(rows or {"error": "no such event"})   # same silence as a 404

    @tool("my_pending_invites", "Invitations the user has not yet accepted or declined", {})
    async def my_pending_invites(args):
        return payload(pending_invites(me))

    return create_sdk_mcp_server(
        name="events", tools=[list_my_events, event_attendees, my_pending_invites])


class Question(BaseModel):
    q: str


async def collect_answer(q: str, opts) -> str:
    parts = []
    async for msg in query(prompt=q, options=opts):
        # a failed turn (expired login, usage limit...) arrives as a synthetic assistant
        # message whose TEXT is the error — never let that reach the user as an answer
        if isinstance(msg, AssistantMessage) and not getattr(msg, "error", None):
            parts += [b.text for b in msg.content if isinstance(b, TextBlock)]
        elif isinstance(msg, ResultMessage) and msg.is_error:
            # the SDK's own exception only says "error result: success"; this has the reason
            raise ClaudeSDKError(msg.result or msg.subtype)
    return " ".join(" ".join(parts).split())


def run_on_proactor(coro) -> str:
    """Windows only: run `coro` on a private ProactorEventLoop, in this thread.

    uvicorn builds a SelectorEventLoop whenever it runs the app in a subprocess
    (`--reload`, `--workers`), and on Windows asyncio CANNOT spawn a child process
    on a Selector loop — it raises NotImplementedError, which the SDK reports as the
    unhelpful "Failed to start Claude Code: ". uvicorn instantiates that loop class
    itself, so setting an event-loop policy here would not survive; owning a loop for
    the duration of the call is what actually works.
    """
    loop = asyncio.ProactorEventLoop()
    try:
        asyncio.set_event_loop(loop)
        return loop.run_until_complete(coro)
    finally:
        asyncio.set_event_loop(None)
        loop.close()


async def run_assistant(q: str, me: str) -> str:
    """One model turn, sandboxed. Kept separate from the endpoint so tests can
    replace it without touching auth, validation or rate limiting."""
    now = time.time()
    opts = ClaudeAgentOptions(
        system_prompt=(
            "You answer questions about the user's calendar events in a messenger app. "
            f"The current local datetime is {when_str(now)}. "
            "Resolve relative dates like 'next week' or 'tomorrow' to concrete ISO "
            "datetimes yourself before calling a tool. Answer ONLY from tool results; "
            "if the tools return nothing, say so plainly. You cannot access other "
            "users' data — never claim otherwise. Never mention account emails, file "
            "paths, tool names or anything about the system you run on: the person "
            f"reading your reply is the messenger user '{me}' and nobody else. "
            "Reply in 1-3 sentences of plain text."
        ),
        mcp_servers={"events": events_toolset(me)},
        # tools=[] is the load-bearing guardrail: it removes EVERY built-in tool, so
        # Bash/Read/Write never enter the model's context. allowed_tools below is only
        # a permission-prompt bypass — on its own it would leave those tools reachable.
        tools=[],
        allowed_tools=[f"mcp__events__{n}" for n in ASSISTANT_TOOLS],
        strict_mcp_config=True,   # ignore any .mcp.json / user-level MCP servers on this box
        setting_sources=[],       # no CLAUDE.md, settings, hooks or skills — injection surfaces
        max_turns=5,              # bounds a runaway loop, and with it the usage window
        cwd=ASSISTANT_CWD,
    )
    answer = collect_answer(q, opts)
    if sys.platform == "win32" and not isinstance(
            asyncio.get_running_loop(), asyncio.ProactorEventLoop):
        # ponytail: one thread per question, which the 6/min limit already bounds.
        # A timeout abandons the thread rather than killing it; the CLI still exits
        # on its own. Worth revisiting only if /assistant ever gets a real budget.
        return await asyncio.to_thread(run_on_proactor, answer)
    return await answer


@app.post("/assistant", dependencies=[Depends(assistant_limit)])
async def ask_assistant(body: Question, me: str = Depends(current_user)):
    q = body.q.strip()
    if not (0 < len(q) <= 500):
        raise HTTPException(400, "question must be 1-500 characters")
    if query is None:
        raise HTTPException(503, "assistant unavailable")
    try:
        answer = await asyncio.wait_for(run_assistant(q, me), timeout=ASSISTANT_TIMEOUT)
    except Exception as e:     # the SDK also raises bare Exception, which used to escape as a 500
        # the caller learns nothing about the SDK, the CLI or the login state — but the
        # operator does: a timeout and a dead CLI are the same 503 from the outside
        cause = e.__cause__ or e.__context__      # the SDK's own message is often empty
        print(f"/assistant failed: {type(e).__name__}: {e}"
              + (f" (caused by {type(cause).__name__}: {cause})" if cause else ""),
              file=sys.stderr)
        raise HTTPException(503, "assistant unavailable")
    return {"answer": answer or "I couldn't find an answer to that."}




# --- the wire protocol -------------------------------------------------
#
# client -> server                      server -> client
# {"type":"message","to","text",         {"type":"message", id, sender, recipient,
#  "media_id"?,"alt"?}                    text, ts, status, media_id, alt}
#                                       (echo of your own send, same shape)
#
# Send {"group": id} instead of "to" for a group; everything a member receives then
# carries "group_id". Groups get no delivered/read/typing events.
#
# `media_id` references a row uploaded via POST /media; `alt` is the sender's
# locally-computed scene description for it. The bytes never cross this socket.
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
        if name != user and not blocked_between(name, user):
            try:
                await ws.send_json({"type": "presence", "user": user, "online": is_online})
            except Exception:
                pass  # that socket is mid-close; its own finally cleans it up. Keep telling the rest.


async def notify(user: str, kind: str, actor: str, body: str):
    """Record something the user missed while away, then try to reach them off-tab
    via web push. Skipped entirely when they're connected: a live socket means they
    already saw it (as a message + toast), so it isn't a "missed" notification."""
    if user in online or has_rel(user, actor, "mute") or has_rel(user, actor, "block"):
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
    # A blocked sender's ticks stay put: a flip to delivered would tell them I'm online.
    senders = [r["sender"] for r in db.execute(
        "SELECT DISTINCT sender FROM messages WHERE recipient = ? AND status = 'sent' AND hidden = 0",
        (username,),
    ) if not blocked_between(username, r["sender"])]
    for s in senders:
        db.execute(
            "UPDATE messages SET status = 'delivered'"
            " WHERE recipient = ? AND sender = ? AND status = 'sent' AND hidden = 0",
            (username, s),
        )
    db.commit()
    for s in senders:
        await push(s, {"type": "delivered", "by": username})

    await broadcast_presence(username, True)

    try:
        while True:
            event = await ws.receive_json()

            if event.get("type") == "message":
                text = event.get("text") or ""
                gid, to = event.get("group"), None
                if gid is not None:
                    if not isinstance(gid, int) or not db.execute(
                            "SELECT 1 FROM group_members WHERE group_id = ? AND username = ?",
                            (gid, username)).fetchone():
                        continue      # not a member (or not a group): nothing to send to
                    hidden = False
                else:
                    to = event.get("to")
                    if not isinstance(to, str) or not to or has_rel(username, to, "block"):
                        continue      # unblock first; the client hides the composer
                    hidden = has_rel(to, username, "block")
                media_id, alt = event.get("media_id"), (event.get("alt") or None)
                media_w = media_h = media_mime = media_duration = None
                if media_id:
                    # you may only attach your OWN upload — otherwise anyone who saw an
                    # id could re-send someone else's photo under their own name
                    m = db.execute("SELECT width, height, mime, duration FROM media WHERE id = ? AND owner = ?",
                                   (media_id, username)).fetchone()
                    if not m:
                        continue
                    media_w, media_h = m["width"], m["height"]
                    media_mime, media_duration = m["mime"], m["duration"]
                    if alt:
                        alt = alt[:500]
                elif not text.strip():
                    continue          # a message with neither text nor a photo isn't one
                status = "delivered" if to in online and not hidden else "sent"
                ts = time.time()
                cur = db.execute(
                    "INSERT INTO messages(sender, recipient, text, ts, status, media_id, alt, hidden, group_id)"
                    " VALUES(?,?,?,?,?,?,?,?,?)",
                    (username, to or "", text, ts, status, media_id, alt, int(hidden), gid),
                )
                db.commit()
                out = {"type": "message", "id": cur.lastrowid, "sender": username,
                       "recipient": to or "", "group_id": gid, "text": text, "ts": ts, "status": status,
                       "media_id": media_id, "alt": alt, "media_w": media_w, "media_h": media_h,
                       "media_mime": media_mime, "media_duration": media_duration, "reactions": []}
                # feed the recipient's pane — a photo shows up as its description
                shown = preview(text, media_id, alt, media_mime)
                if gid is not None:
                    gname = db.execute("SELECT name FROM chat_groups WHERE id = ?", (gid,)).fetchone()["name"]
                    for member in members_of(gid):
                        if member != username:
                            await push(member, out)
                            await notify(member, "message", username, f"{gname}: {shown}")
                else:
                    if not hidden:    # the sender's echo is identical either way
                        await push(to, out)
                    await notify(to, "message", username, shown)
                # echo carries the real id + status; client_id reconciles the optimistic bubble
                await ws.send_json({**out, "client_id": event.get("client_id")})

            elif event.get("type") == "read" and event.get("group") is not None:
                db.execute("UPDATE group_members SET last_read = ? WHERE group_id = ? AND username = ?",
                           (newest_message_id(), event["group"], username))
                db.commit()

            elif event.get("type") == "read":
                other = event["from"]      # whose messages I just read
                db.execute(
                    """UPDATE messages SET status = 'read'
                       WHERE sender = ? AND recipient = ? AND status != 'read' AND hidden = 0""",
                    (other, username),
                )
                db.commit()
                if not blocked_between(username, other):
                    await push(other, {"type": "read", "by": username})

            elif event.get("type") == "typing":
                # pure forward, no db: only means anything to whoever's watching now
                to = event.get("to")
                if isinstance(to, str) and not blocked_between(username, to):
                    await push(to, {"type": "typing", "from": username})

            elif event.get("type") == "reaction":
                mid, emoji = event["message_id"], event["emoji"]
                msg = db.execute(
                    """SELECT m.sender, m.recipient, m.group_id, m.text, m.media_id, m.alt, md.mime
                       FROM messages m LEFT JOIN media md ON md.id = m.media_id WHERE m.id = ?""",
                    (mid,)).fetchone()
                if not msg:
                    continue
                if msg["group_id"] is not None:
                    audience = members_of(msg["group_id"])
                    if username not in audience:
                        continue  # only members may react
                else:
                    audience = list({msg["sender"], msg["recipient"]})
                    if username not in audience:
                        continue  # only participants may react
                    if blocked_between(msg["sender"], msg["recipient"]):
                        continue
                existing = db.execute(
                    "SELECT emoji FROM reactions WHERE message_id = ? AND username = ?", (mid, username)).fetchone()
                removed = bool(existing and existing["emoji"] == emoji)
                if removed:                          # same emoji again = toggle off
                    db.execute("DELETE FROM reactions WHERE message_id = ? AND username = ?", (mid, username))
                else:                                # new or switched emoji
                    db.execute("INSERT OR REPLACE INTO reactions VALUES (?,?,?)", (mid, username, emoji))
                db.commit()
                shown = preview(msg["text"], msg["media_id"], msg["alt"], msg["mime"])
                out = {"type": "reaction", "message_id": mid, "emoji": emoji, "by": username,
                       "removed": removed, "message_text": shown, "group_id": msg["group_id"],
                       "message_sender": msg["sender"], "message_recipient": msg["recipient"]}
                for name in audience:
                    await push(name, out)
                # only the message's owner cares that someone reacted, and only when
                # a reaction is added (not toggled off) by somebody other than them
                if not removed and username != msg["sender"]:
                    await notify(msg["sender"], "reaction", username, f'{emoji} to "{shown}"')
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

