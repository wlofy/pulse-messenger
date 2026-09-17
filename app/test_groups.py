r"""
Contacts, group chats and voice messages, end to end over a real server.

    .\.venv\Scripts\python.exe app\test_groups.py
"""
import base64
import json
import os
import sys
import time
import threading
from pathlib import Path

import httpx
import uvicorn
from websockets.sync.client import connect

TEST_DB = Path(__file__).parent / "chat.groups.test.db"
os.environ["CHAT_DB"] = str(TEST_DB)
os.environ["RL_DISABLED"] = "1"
if TEST_DB.exists():
    os.remove(TEST_DB)

sys.path.insert(0, str(Path(__file__).parent))
import main  # noqa: E402

PORT = 8129
BASE = f"http://127.0.0.1:{PORT}"
WS = f"ws://127.0.0.1:{PORT}"

_server = uvicorn.Server(uvicorn.Config(main.app, port=PORT, log_level="error"))
threading.Thread(target=_server.run, daemon=True).start()
while not _server.started:
    time.sleep(0.05)

# not a playable file — the server stores bytes, it never decodes audio
VOICE = "data:audio/webm;codecs=opus;base64," + base64.b64encode(b"\x1aE\xdf\xa3 fake opus").decode()


def _signup(name):
    r = httpx.post(f"{BASE}/signup", json={"username": name, "password": "secret1"})
    assert r.status_code == 200, r.text
    tok = r.json()["token"]
    return {"Authorization": f"Bearer {tok}"}, tok


def _recv(ws, timeout=5):
    return json.loads(ws.recv(timeout=timeout))


def _recv_type(ws, kind):
    """Skip presence/group frames until the one we're waiting for."""
    while True:
        ev = _recv(ws)
        if ev["type"] == kind:
            return ev


def _silent(ws):
    try:
        ws.recv(timeout=0.5)
        return False
    except TimeoutError:
        return True


def _dm(token, to, text):
    with connect(f"{WS}/ws?token={token}") as w:
        w.send(json.dumps({"type": "message", "to": to, "text": text}))
        _recv_type(w, "message")


def test_groups_contacts_and_voice():
    ph, pt = _signup("pia")
    qh, qt = _signup("quin")
    rh, rt = _signup("rex")
    sh, st = _signup("sol")    # never a contact of anyone

    # --- contacts: a DM only counts once it's answered ----------------------
    _dm(pt, "quin", "hi quin")
    contacts = lambda h: [c["username"] for c in httpx.get(f"{BASE}/contacts", headers=h).json()]
    assert contacts(ph) == [] and contacts(qh) == []
    _dm(qt, "pia", "hi pia")
    assert contacts(ph) == ["quin"] and contacts(qh) == ["pia"]
    _dm(pt, "rex", "hi rex")
    _dm(rt, "pia", "yo")
    assert contacts(ph) == ["quin", "rex"]

    # --- create: validation --------------------------------------------------
    make = lambda h, body: httpx.post(f"{BASE}/groups", json=body, headers=h)
    assert make(ph, {"name": " ", "members": ["quin"]}).status_code == 400
    assert make(ph, {"name": "x", "members": []}).status_code == 400
    assert make(ph, {"name": "x", "members": ["pia"]}).status_code == 400      # only yourself
    assert make(ph, {"name": "x", "members": ["sol"]}).status_code == 400      # not a contact
    assert make(qh, {"name": "x", "members": ["rex"]}).status_code == 400      # pia's contact, not quin's

    g = make(ph, {"name": "Trip", "members": ["quin"]}).json()
    gid = g["group_id"]
    assert g["members"] == ["pia", "quin"] and g["name"] == "Trip"
    chat = next(c for c in httpx.get(f"{BASE}/chats", headers=qh).json() if c.get("group_id") == gid)
    assert chat["name"] == "Trip" and chat["unread"] == 0

    # --- messaging: fan-out, non-members can't send or read ----------------
    with connect(f"{WS}/ws?token={pt}") as p, connect(f"{WS}/ws?token={qt}") as q, \
            connect(f"{WS}/ws?token={st}") as s:
        p.send(json.dumps({"type": "message", "group": gid, "text": "first", "client_id": "c1"}))
        got = _recv_type(q, "message")
        assert got["group_id"] == gid and got["text"] == "first" and got["recipient"] == ""
        echo = _recv_type(p, "message")
        assert echo["client_id"] == "c1" and echo["id"] == got["id"]

        s.send(json.dumps({"type": "message", "group": gid, "text": "intruder"}))
        s.send(json.dumps({"type": "reaction", "message_id": got["id"], "emoji": "🔥"}))
        assert _silent(q), "a non-member reached the group"

        q.send(json.dumps({"type": "reaction", "message_id": got["id"], "emoji": "❤️"}))
        assert _recv_type(p, "reaction")["group_id"] == gid

    assert httpx.get(f"{BASE}/messages", params={"group": gid}, headers=sh).status_code == 404
    hist = httpx.get(f"{BASE}/messages", params={"group": gid}, headers=qh).json()
    assert [m["text"] for m in hist] == ["first"] and hist[0]["reactions"][0]["emoji"] == "❤️"
    # a group message never shows up as a DM with anybody
    assert all(c.get("username") != "" for c in httpx.get(f"{BASE}/chats", headers=ph).json())

    # unread, then cleared by a read event
    unread = lambda h: next(c for c in httpx.get(f"{BASE}/chats", headers=h).json()
                            if c.get("group_id") == gid)["unread"]
    assert unread(qh) == 1 and unread(ph) == 0
    with connect(f"{WS}/ws?token={qt}") as q:
        q.send(json.dumps({"type": "read", "group": gid}))
        time.sleep(0.2)
    assert unread(qh) == 0

    # --- adding: only your own contacts; no history from before you joined --
    add = lambda h, who: httpx.post(f"{BASE}/groups/{gid}/members", json={"username": who}, headers=h)
    assert add(qh, "rex").status_code == 400       # rex isn't quin's contact
    assert add(sh, "rex").status_code == 404       # sol isn't a member
    assert add(ph, "quin").status_code == 409
    assert add(ph, "rex").status_code == 200
    assert httpx.get(f"{BASE}/messages", params={"group": gid}, headers=rh).json() == []
    assert unread(rh) == 0

    # --- voice note: validated upload, shared with members only -------------
    up = lambda body: httpx.post(f"{BASE}/media", json=body, headers=rh)
    assert up({"data": VOICE}).status_code == 400                        # no duration
    assert up({"data": VOICE, "duration": 0}).status_code == 400
    assert up({"data": VOICE, "duration": main.MAX_VOICE_SECONDS + 60}).status_code == 400
    r = up({"data": VOICE, "duration": 3.5})
    assert r.status_code == 200 and r.json()["mime"] == "audio/webm", r.text
    vid = r.json()["id"]

    with connect(f"{WS}/ws?token={rt}") as rw, connect(f"{WS}/ws?token={pt}") as p:
        rw.send(json.dumps({"type": "message", "group": gid, "media_id": vid, "text": ""}))
        got = _recv_type(p, "message")
        assert got["media_mime"] == "audio/webm" and got["media_duration"] == 3.5

    assert httpx.get(f"{BASE}/media/{vid}?token={qt}").status_code == 200   # a member
    assert httpx.get(f"{BASE}/media/{vid}?token={st}").status_code == 404   # an outsider
    last = next(c for c in httpx.get(f"{BASE}/chats", headers=qh).json() if c.get("group_id") == gid)
    assert last["last_text"] == "🎤 Voice message" and last["last_sender"] == "rex"

    # voice notes in a DM too
    with connect(f"{WS}/ws?token={pt}") as p:
        vid2 = httpx.post(f"{BASE}/media", json={"data": VOICE, "duration": 1}, headers=ph).json()["id"]
        p.send(json.dumps({"type": "message", "to": "quin", "media_id": vid2, "text": ""}))
        assert _recv_type(p, "message")["media_duration"] == 1
    dm = httpx.get(f"{BASE}/messages", params={"other": "pia"}, headers=qh).json()
    assert dm[-1]["media_mime"] == "audio/webm"

    # --- events: contacts only -----------------------------------------------
    ev = lambda invitees: httpx.post(f"{BASE}/events", headers=ph, json={
        "title": "t", "event_date": time.time() + 3600, "invitees": invitees})
    assert ev(["sol"]).status_code == 400
    assert ev(["quin", "rex"]).status_code == 200

    # --- leaving -------------------------------------------------------------
    with connect(f"{WS}/ws?token={pt}") as p:
        assert httpx.post(f"{BASE}/groups/{gid}/leave", headers=qh).status_code == 200
        assert _recv_type(p, "groups")["group_id"] == gid
    assert httpx.post(f"{BASE}/groups/{gid}/leave", headers=qh).status_code == 404
    assert not any(c.get("group_id") == gid for c in httpx.get(f"{BASE}/chats", headers=qh).json())
    assert httpx.get(f"{BASE}/messages", params={"group": gid}, headers=qh).status_code == 404
    assert httpx.get(f"{BASE}/chats", headers=ph).json()  # still fine for those who stayed
    assert next(c for c in httpx.get(f"{BASE}/chats", headers=ph).json()
                if c.get("group_id") == gid)["members"] == ["pia", "rex"]


if __name__ == "__main__":
    test_groups_contacts_and_voice()
    print("OK — contacts, groups and voice messages passed.")
