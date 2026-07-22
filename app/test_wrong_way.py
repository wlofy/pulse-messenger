"""
Stage 8, the WRONG way — run this a few times and watch it hang intermittently.

    .\.venv\Scripts\python.exe -m pytest app/test_wrong_way.py

Why it hangs: starlette's TestClient runs each websocket session on its OWN
event-loop thread. So alice's socket and bob's socket live on *different* loops.
Your `online` dict then holds two sockets belonging to two different loops, and
when alice's handler does `await push("bob", ...)` it calls `send_json` on a
socket owned by another loop — there's no reliable wakeup, so bob's
`receive_json()` blocks forever.

Real uvicorn (test_chat.py) puts every connection on ONE loop — the exact
assumption your dict design makes. Test infrastructure that changes the
concurrency model isn't testing your app; it's testing a different app.
"""
import os
import sys
from pathlib import Path

os.environ["CHAT_DB"] = str(Path(__file__).parent / "chat.wrongway.db")  # own db, not yours
sys.path.insert(0, str(Path(__file__).parent))  # so `import main` resolves
from fastapi.testclient import TestClient
import main


def test_cross_loop_push_hangs():
    client = TestClient(main.app)
    client.post("/login", json={"username": "ww_alice"})
    client.post("/login", json={"username": "ww_bob"})

    with client.websocket_connect("/ws/ww_alice") as a, \
         client.websocket_connect("/ws/ww_bob") as b:
        a.send_json({"type": "message", "to": "ww_bob", "text": "does this arrive?"})
        # bob's socket lives on a different loop than alice's handler.
        # This receive_json can block forever — that's the whole point.
        got = b.receive_json()
        assert got["text"] == "does this arrive?"


if __name__ == "__main__":
    test_cross_loop_push_hangs()
    print("passed this time (it won't always) — run it again")
