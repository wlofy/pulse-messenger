r"""
Rate limiting + JWT — runs with limits ENABLED (unlike test_chat.py).

    .\.venv\Scripts\python.exe app\test_ratelimit.py

Covers: login brute-force gets 429 after the window budget; a 429 carries
Retry-After; the token is a real JWT (three parts, tamper-evident); logout
revokes the jti so a stateless token stops working.
"""
import os
import sys
import time
import json
import base64
import threading
from pathlib import Path

import httpx
import uvicorn

TEST_DB = Path(__file__).parent / "chat.rl.db"
os.environ["CHAT_DB"] = str(TEST_DB)
os.environ.pop("RL_DISABLED", None)          # limits ON for this file
os.environ["JWT_SECRET"] = "test-secret-stable-across-this-run"
if TEST_DB.exists():
    os.remove(TEST_DB)

sys.path.insert(0, str(Path(__file__).parent))
import main  # noqa: E402

PORT = 8125
BASE = f"http://127.0.0.1:{PORT}"
_server = uvicorn.Server(uvicorn.Config(main.app, port=PORT, log_level="error"))
threading.Thread(target=_server.run, daemon=True).start()
while not _server.started:
    time.sleep(0.05)


def test_login_is_rate_limited():
    # login_limit is 5/60s per IP. The 6th attempt in the window must 429.
    codes = [httpx.post(f"{BASE}/login", json={"username": "nobody", "password": "x"}).status_code
             for _ in range(6)]
    assert codes[:5] == [401] * 5, codes          # wrong creds, but allowed through
    assert codes[5] == 429, codes                 # budget exhausted
    r = httpx.post(f"{BASE}/login", json={"username": "nobody", "password": "x"})
    assert r.status_code == 429 and "Retry-After" in r.headers


def test_token_is_a_real_jwt():
    tok = httpx.post(f"{BASE}/signup", json={"username": "dora", "password": "secret9"}).json()["token"]
    parts = tok.split(".")
    assert len(parts) == 3                          # header.payload.signature
    pad = lambda s: s + "=" * (-len(s) % 4)
    payload = json.loads(base64.urlsafe_b64decode(pad(parts[1])))
    assert payload["sub"] == "dora" and payload["exp"] > time.time()
    # flip one signature char -> must be rejected as tampered
    forged = f"{parts[0]}.{parts[1]}.{'A' if parts[2][0] != 'A' else 'B'}{parts[2][1:]}"
    assert main.decode_token(forged) is None


def test_logout_revokes_jwt():
    tok = httpx.post(f"{BASE}/signup", json={"username": "evan", "password": "secret9"}).json()["token"]
    ah = {"Authorization": f"Bearer {tok}"}
    assert httpx.get(f"{BASE}/users", headers=ah).status_code == 200
    assert httpx.post(f"{BASE}/logout", headers=ah).status_code == 200
    assert httpx.get(f"{BASE}/users", headers=ah).status_code == 401  # jti now denylisted


if __name__ == "__main__":
    test_token_is_a_real_jwt()
    test_logout_revokes_jwt()
    test_login_is_rate_limited()   # last: it burns the login budget for this IP
    print("OK — JWT + rate limiting verified.")
