r"""
Block + mute, end to end over a real server and real sockets.

    .\.venv\Scripts\python.exe app\test_block.py
"""
import json
import os
import sys
import time
import threading
from pathlib import Path

import httpx
import uvicorn
from websockets.sync.client import connect

TEST_DB = Path(__file__).parent / "chat.block.test.db"
os.environ["CHAT_DB"] = str(TEST_DB)
os.environ["RL_DISABLED"] = "1"
if TEST_DB.exists():
    os.remove(TEST_DB)

sys.path.insert(0, str(Path(__file__).parent))
import main  # noqa: E402

PORT = 8128
BASE = f"http://127.0.0.1:{PORT}"
WS = f"ws://127.0.0.1:{PORT}"

_server = uvicorn.Server(uvicorn.Config(main.app, port=PORT, log_level="error"))
threading.Thread(target=_server.run, daemon=True).start()
while not _server.started:
    time.sleep(0.05)


def _signup(name):
    r = httpx.post(f"{BASE}/signup", json={"username": name, "password": "secret1"})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}, r.json()["token"]


def _recv(ws, timeout=5):
    return json.loads(ws.recv(timeout=timeout))


def _silent(ws):
    """True if nothing arrives within a short window."""
    try:
        ws.recv(timeout=0.5)
        return False
    except TimeoutError:
        return True


def test_block_and_mute():
    ah, at = _signup("alice")
    bh, bt = _signup("bob")

    # validation
    assert httpx.post(f"{BASE}/users/alice/block", json={"on": True}, headers=ah).status_code == 400
    assert httpx.post(f"{BASE}/users/ghost/block", json={"on": True}, headers=ah).status_code == 404
    assert httpx.post(f"{BASE}/users/bob/nuke", json={"on": True}, headers=ah).status_code == 404

    # --- mute: messages still arrive, notifications don't -------------------
    r = httpx.post(f"{BASE}/users/alice/mute", json={"on": True}, headers=bh)
    assert r.json() == {"blocked": False, "muted": True}
    with connect(f"{WS}/ws?token={at}") as a:   # bob is OFFLINE, so notify() would fire
        a.send(json.dumps({"type": "message", "to": "bob", "text": "muted hi"}))
        assert _recv(a)["status"] == "sent"
    assert httpx.get(f"{BASE}/notifications", headers=bh).json() == []
    assert [m["text"] for m in httpx.get(f"{BASE}/messages?other=alice", headers=bh).json()] == ["muted hi"]
    with connect(f"{WS}/ws?token={bt}") as b:   # bob replies: now they're contacts
        b.send(json.dumps({"type": "message", "to": "alice", "text": "hey back"}))
        _recv(b)
    assert [c["username"] for c in httpx.get(f"{BASE}/contacts", headers=ah).json()] == ["bob"]
    chat = next(c for c in httpx.get(f"{BASE}/chats", headers=bh).json() if c["username"] == "alice")
    assert chat["muted"] and not chat["blocked"]
    httpx.post(f"{BASE}/users/alice/mute", json={"on": False}, headers=bh)

    # --- block: bob blocks alice, both online ------------------------------
    r = httpx.post(f"{BASE}/users/alice/block", json={"on": True}, headers=bh)
    assert r.json() == {"blocked": True, "muted": False}
    with connect(f"{WS}/ws?token={bt}") as b:
        with connect(f"{WS}/ws?token={at}") as a:
            assert _silent(b), "bob saw alice come online despite blocking her"
            assert httpx.get(f"{BASE}/profile/bob", headers=ah).json()["online"] is False

            a.send(json.dumps({"type": "typing", "to": "bob"}))
            a.send(json.dumps({"type": "message", "to": "bob", "text": "blocked hi"}))
            echo = _recv(a)
            assert echo["text"] == "blocked hi" and echo["status"] == "sent"   # one tick, forever
            assert _silent(b), "bob received something from a user he blocked"

            # bob can't message alice while she's blocked
            b.send(json.dumps({"type": "message", "to": "alice", "text": "nope"}))
            assert _silent(b) and _silent(a)

    assert [m["text"] for m in httpx.get(f"{BASE}/messages?other=alice", headers=bh).json()] == ["muted hi", "hey back"]
    assert httpx.get(f"{BASE}/contacts", headers=ah).json() == []   # a block ends the contact
    assert "blocked hi" in [m["text"] for m in httpx.get(f"{BASE}/messages?other=bob", headers=ah).json()]
    assert httpx.get(f"{BASE}/notifications", headers=bh).json() == []

    # alice can't pull bob into an event
    ev = httpx.post(f"{BASE}/events", json={"title": "party", "event_date": time.time() + 3600,
                                             "invitees": ["bob"]}, headers=ah).json()
    assert ev["attendees"] == []

    # unblocking restores delivery, but messages sent during the block stay hidden
    httpx.post(f"{BASE}/users/alice/block", json={"on": False}, headers=bh)
    with connect(f"{WS}/ws?token={bt}") as b, connect(f"{WS}/ws?token={at}") as a:
        a.send(json.dumps({"type": "message", "to": "bob", "text": "after"}))
        # alice's presence is visible again, and the held-back receipt for "hey back" lands
        frames = [_recv(b), _recv(b), _recv(b)]
        assert {f["type"] for f in frames} == {"delivered", "presence", "message"}, frames
        assert next(f for f in frames if f["type"] == "message")["text"] == "after"
    texts = [m["text"] for m in httpx.get(f"{BASE}/messages?other=alice", headers=bh).json()]
    assert texts == ["muted hi", "hey back", "after"], texts


if __name__ == "__main__":
    test_block_and_mute()
    print("OK — block + mute passed.")
