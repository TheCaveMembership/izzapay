# wallet_api.py
from flask import Blueprint, request, jsonify, session
from time import time
from db import conn

bp = Blueprint("wallet_api", __name__)

def now_i():
    return int(time())

def current_username():
    # Fast path: already cached
    u = session.get("pi_username")
    if u:
        return u

    # Your auth flow sets only user_id; resolve username and cache it
    uid = session.get("user_id")
    if not uid:
        return None

    with conn() as cx:
        row = cx.execute("SELECT pi_username FROM users WHERE id = ?", (int(uid),)).fetchone()
    if row and row["pi_username"]:
        session["pi_username"] = row["pi_username"]
        return row["pi_username"]
    return None

@bp.get("/api/wallet/active")
def wallet_active():
    u = current_username()
    if not u:
        return jsonify({"pub": None}), 200

    with conn() as cx:
        row = cx.execute("SELECT pub FROM user_wallets WHERE username = ?", (u,)).fetchone()
    return jsonify({"pub": (row["pub"] if row else None)}), 200

@bp.post("/api/wallet/link")
def wallet_link():
    u = current_username()
    if not u:
        return ("unauthorized", 401)

    data = (request.get_json(silent=True) or {})
    pub = (data.get("pub") or "").strip()

    if not pub or not pub.startswith("G") or len(pub) != 56:
        return ("bad pub", 400)

    ts = now_i()
    with conn() as cx:
        # upsert
        got = cx.execute("SELECT 1 FROM user_wallets WHERE username = ?", (u,)).fetchone()
        if got:
            cx.execute(
                "UPDATE user_wallets SET pub = ?, updated_at = ? WHERE username = ?",
                (pub, ts, u),
            )
        else:
            cx.execute(
                "INSERT INTO user_wallets (username, pub, created_at, updated_at) VALUES (?, ?, ?, ?)",
                (u, pub, ts, ts),
            )

    return jsonify({"ok": True})
