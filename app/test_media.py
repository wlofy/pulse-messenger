r"""
Photo messages: upload, access control, and the WebSocket attachment path.

    .\.venv\Scripts\python.exe app\test_media.py
    .\.venv\Scripts\python.exe -m pytest app\test_media.py

Same shape as test_chat.py — its own db, its own port, every recv time-bounded.
The interesting cases here are the ones that are easy to get wrong and silent
when you do: an <img> can't send an auth header, and a media id is a bearer
capability the moment it leaks.
"""
import os
import sys
import json
import time
import base64
import threading
from pathlib import Path

import httpx
import uvicorn
from websockets.sync.client import connect

TEST_DB = Path(__file__).parent / "chat.media.test.db"
os.environ["CHAT_DB"] = str(TEST_DB)
os.environ["RL_DISABLED"] = "1"
if TEST_DB.exists():
    os.remove(TEST_DB)

sys.path.insert(0, str(Path(__file__).parent))
import main  # noqa: E402 — must come AFTER setting CHAT_DB

PORT = 8124
BASE = f"http://127.0.0.1:{PORT}"
WS = f"ws://127.0.0.1:{PORT}"

_server = uvicorn.Server(uvicorn.Config(main.app, port=PORT, log_level="error"))
threading.Thread(target=_server.run, daemon=True).start()
while not _server.started:
    time.sleep(0.05)

# smallest real png that decodes — 1x1, transparent
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)
DATA_URL = "data:image/png;base64," + base64.b64encode(PNG).decode()


def test_upload_validation():
    token = _signup("uma", "secret1")
    h = {"Authorization": f"Bearer {token}"}

    assert httpx.post(f"{BASE}/media", json=_body(DATA_URL)).status_code == 401  # no token

    # a data URL that isn't an image type we accept
    bad = "data:text/html;base64," + base64.b64encode(b"<script>").decode()
    assert httpx.post(f"{BASE}/media", json=_body(bad), headers=h).status_code == 400
    # not a data URL at all
    assert httpx.post(f"{BASE}/media", json=_body("https://example.com/x.png"), headers=h).status_code == 400
    # right header, unparseable payload
    assert httpx.post(f"{BASE}/media", json=_body("data:image/png;base64,!!!!"), headers=h).status_code == 400
    # over the 4 MB ceiling
    huge = "data:image/png;base64," + base64.b64encode(b"\0" * (main.MAX_MEDIA_BYTES + 1)).decode()
    assert httpx.post(f"{BASE}/media", json=_body(huge), headers=h).status_code == 413
    # nonsense dimensions
    assert httpx.post(f"{BASE}/media", json={"data": DATA_URL, "width": 0, "height": 1},
                      headers=h).status_code == 400

    r = httpx.post(f"{BASE}/media", json=_body(DATA_URL), headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["id"] and r.json()["width"] == 1


def test_media_access_control():
    dt = _signup("dave", "secret2")
    et = _signup("erin", "secret3")   # uninvolved third party
    mid = _upload(dt)

    # an <img src> sends no headers, so the token has to be allowed in the query string
    assert httpx.get(f"{BASE}/media/{mid}").status_code == 401
    r = httpx.get(f"{BASE}/media/{mid}?token={dt}")
    assert r.status_code == 200 and r.content == PNG
    assert r.headers["content-type"] == "image/png"

    # a stranger gets 404, not 403 — a 403 would confirm the id is real
    assert httpx.get(f"{BASE}/media/{mid}?token={et}").status_code == 404
    assert httpx.get(f"{BASE}/media/nosuchid?token={dt}").status_code == 404


def test_photo_message_round_trip():
    ft = _signup("finn", "secret4")
    gt = _signup("gwen", "secret5")
    mid = _upload(ft)
    alt = "2 people and a dog"

    with connect(f"{WS}/ws?token={ft}") as f, connect(f"{WS}/ws?token={gt}") as g:
        _recv(f)  # gwen's presence frame

        f.send(json.dumps({"type": "message", "to": "gwen", "media_id": mid, "alt": alt, "text": ""}))
        landed = _recv(g)
        assert landed["media_id"] == mid and landed["alt"] == alt
        # dimensions ride along so the bubble can reserve space before the photo loads
        assert landed["media_w"] == 1 and landed["media_h"] == 1
        echo = _recv(f)
        assert echo["media_id"] == mid and echo["id"] == landed["id"]

        # the recipient can now fetch bytes she never had the id for before
        assert httpx.get(f"{BASE}/media/{mid}?token={gt}").content == PNG

        # ...but she still can't RE-SEND finn's upload as her own
        g.send(json.dumps({"type": "message", "to": "finn", "media_id": mid, "text": ""}))
        g.send(json.dumps({"type": "message", "to": "finn", "text": "did that work?"}))
        # if the stolen attach had been accepted, this would be the photo, not the text
        assert _recv(f)["text"] == "did that work?"

        # an empty message with no photo is not a message
        g.send(json.dumps({"type": "message", "to": "finn", "text": "   "}))
        g.send(json.dumps({"type": "message", "to": "finn", "text": "still here"}))
        assert _recv(f)["text"] == "still here"

    fh = {"Authorization": f"Bearer {ft}"}
    hist = httpx.get(f"{BASE}/messages", params={"other": "gwen"}, headers=fh).json()
    photo = next(m for m in hist if m["media_id"])
    assert photo["alt"] == alt and photo["text"] == ""
    assert photo["media_w"] == 1 and photo["media_h"] == 1   # via the LEFT JOIN
    assert all(m["media_w"] is None for m in hist if not m["media_id"])

    # the sidebar preview falls back to the description — a text channel can't show a photo
    chats = httpx.get(f"{BASE}/chats", headers=fh).json()
    assert main.preview("", mid, alt) == f"📷 {alt}"
    assert main.preview("", mid, None) == "📷 Photo"
    assert main.preview("hello", None, None) == "hello"
    assert any(c["username"] == "gwen" for c in chats)


def _body(data):
    return {"data": data, "width": 1, "height": 1}


def _upload(token):
    r = httpx.post(f"{BASE}/media", json=_body(DATA_URL), headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _signup(username, password):
    r = httpx.post(f"{BASE}/signup", json={"username": username, "password": password})
    assert r.status_code == 200, r.text
    return r.json()["token"]


def _recv(ws):
    return json.loads(ws.recv(timeout=5))


if __name__ == "__main__":
    test_upload_validation()
    test_media_access_control()
    test_photo_message_round_trip()
    print("OK - upload validation, access control and photo round-trip passed.")
