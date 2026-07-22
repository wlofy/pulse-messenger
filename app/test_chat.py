r"""
Stage 8 test, upgraded for Stage 11 auth — one real uvicorn server, one event
loop, one story, now driven with signup + bearer tokens.

    .\.venv\Scripts\python.exe app\test_chat.py      # runs it once
    .\.venv\Scripts\python.exe -m pytest app\test_chat.py

Run it 3 times in a row: realtime bugs are flaky bugs, and one green run proves
little. Every recv has a timeout, so a bug FAILS instead of hanging.

This test owns its OWN database file (chat.test.db via the CHAT_DB env var), so
it never touches your real chat.db and never needs your --reload server stopped.
The guide's version shares chat.db and warns about the Windows file-lock; giving
the test its own db sidesteps that entirely and keeps runs reproducible.
"""
import os
import sys
import time
import threading
from pathlib import Path

import httpx
import uvicorn
from websockets.sync.client import connect

# --- fresh state per run: point main at a dedicated test db, deleted BEFORE import
TEST_DB = Path(__file__).parent / "chat.test.db"
os.environ["CHAT_DB"] = str(TEST_DB)
os.environ["RL_DISABLED"] = "1"  # this test exercises chat logic, not throttling (see test_ratelimit.py)
if TEST_DB.exists():
    os.remove(TEST_DB)

sys.path.insert(0, str(Path(__file__).parent))  # so `import main` resolves
import main  # noqa: E402 — must come AFTER setting CHAT_DB so it opens the test db

PORT = 8123
BASE = f"http://127.0.0.1:{PORT}"
WS = f"ws://127.0.0.1:{PORT}"

# --- start uvicorn in-process, on one loop, in a daemon thread
_server = uvicorn.Server(uvicorn.Config(main.app, port=PORT, log_level="error"))
threading.Thread(target=_server.run, daemon=True).start()
while not _server.started:
    time.sleep(0.05)


def test_auth_gating():
    # unknown user and wrong password get the SAME 401 (no leaking which half was wrong)
    assert httpx.post(f"{BASE}/login", json={"username": "ghost", "password": "whatever"}).status_code == 401
    # duplicate signup is a 409
    httpx.post(f"{BASE}/signup", json={"username": "carol", "password": "secret9"})
    assert httpx.post(f"{BASE}/signup", json={"username": "carol", "password": "secret9"}).status_code == 409
    # every gated endpoint is 401 without a token; /exists stays public
    assert httpx.get(f"{BASE}/users").status_code == 401
    assert httpx.get(f"{BASE}/exists/carol").status_code == 200
    # a bad WS token is rejected at the handshake (surfaces as HTTP 403)
    from websockets.exceptions import InvalidStatus
    try:
        connect(f"{WS}/ws?token=garbage")
        assert False, "bad WS token was not rejected"
    except InvalidStatus as e:
        assert e.response.status_code == 403


def test_full_story():
    at = _signup("alice", "secret1")
    bt = _signup("bob", "secret2")
    ah = {"Authorization": f"Bearer {at}"}  # alice's REST identity comes from the token now

    with connect(f"{WS}/ws?token={at}") as a:
        # 1) alice messages an OFFLINE bob -> her echo says 'sent'
        a.send('{"type":"message","to":"bob","text":"you there?"}')
        echo = _recv(a)
        assert echo["type"] == "message" and echo["status"] == "sent"
        assert echo["id"] and echo["sender"] == "alice"      # echo carries the real db id
        msg1_id = echo["id"]

        # 2) unread is a derived count — bob has one from alice (bob's own token view)
        bobs_view = httpx.get(f"{BASE}/users", headers={"Authorization": f"Bearer {bt}"}).json()
        alice_row = next(u for u in bobs_view if u["username"] == "alice")
        assert alice_row["unread"] == 1 and alice_row["online"] is True

        # 3) bob connects -> alice hears 'delivered' (bulk receipt) then 'presence'
        with connect(f"{WS}/ws?token={bt}") as b:
            frames = {_recv(a)["type"]: 1, _recv(a)["type"]: 1}
            assert "delivered" in frames and "presence" in frames

            # 4) live message bob -> alice: delivered immediately, bob gets his echo
            b.send('{"type":"message","to":"alice","text":"yep, here"}')
            to_alice = _recv(a)
            assert to_alice["type"] == "message" and to_alice["status"] == "delivered"
            bob_echo = _recv(b)
            assert bob_echo["id"] == to_alice["id"]
            msg2_id = to_alice["id"]

            # 5) typing is forwarded, never stored
            b.send('{"type":"typing","to":"alice"}')
            typ = _recv(a)
            assert typ == {"type": "typing", "from": "bob"}

            # 6) alice reads everything bob sent -> bob gets a read receipt
            a.send('{"type":"read","from":"bob"}')
            read = _recv(b)
            assert read == {"type": "read", "by": "alice"}

        # 7) bob disconnected -> alice hears presence offline
        gone = _recv(a)
        assert gone == {"type": "presence", "user": "bob", "online": False}

    # 8) statuses persisted correctly: alice's msg still 'delivered' (bob never read it),
    #    bob's msg now 'read'. Identity/other come from token + query param.
    hist = httpx.get(f"{BASE}/messages", params={"other": "bob"}, headers=ah).json()
    by_id = {m["id"]: m for m in hist}
    assert by_id[msg1_id]["status"] == "delivered"
    assert by_id[msg2_id]["status"] == "read"

    # 9) logout revokes the token — the same call is now 401
    assert httpx.post(f"{BASE}/logout", headers=ah).status_code == 200
    assert httpx.get(f"{BASE}/users", headers=ah).status_code == 401


def _signup(username, password):
    r = httpx.post(f"{BASE}/signup", json={"username": username, "password": password})
    assert r.status_code == 200, r.text
    return r.json()["token"]


def _recv(ws):
    """Always time-bounded: a realtime bug should fail loudly, not hang."""
    import json
    return json.loads(ws.recv(timeout=5))


if __name__ == "__main__":
    test_auth_gating()
    test_full_story()
    print("OK — auth gating + full story passed. Now run it twice more.")
