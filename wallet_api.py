from flask import Blueprint, request, jsonify, session
from time import time
from db import conn

bp = Blueprint("wallet_api", __name__)

def now_i() -> int:
    return int(time())

def _why_no_user():
    """Small helper to explain why we couldn't resolve a username (useful while integrating)."""
    if "pi_username" in session and not session.get("pi_username"):
        return "empty pi_username"
    if "user_id" not in session:
        return "no user_id in session (auth not established)"
    return "no matching user row for user_id"

def current_username():
    """
    Resolve the current username from the session (set by your Pi verify route).
    Fast path uses session['pi_username'].
    Fallback resolves via session['user_id'] -> users.pi_username and caches it.
    """
    u = session.get("pi_username")
    if u:
        return u

    uid = session.get("user_id")
    if not uid:
        return None

    with conn() as cx:
        row = cx.execute(
            "SELECT pi_username FROM users WHERE id = ?",
            (int(uid),)
        ).fetchone()

    if row and row["pi_username"]:
        session["pi_username"] = row["pi_username"]
        return row["pi_username"]

    return None

@bp.get("/api/wallet/active")
def wallet_active():
    """
    Return the active wallet pubkey for the current user.
    Relies on the browser sending the session cookie (fetch(..., credentials:'include')).
    """
    u = current_username()
    if not u:
        # 200 with null is convenient for the client (no exception handling)
        return jsonify({"pub": None, "why": _why_no_user()}), 200

    with conn() as cx:
        row = cx.execute(
            "SELECT pub FROM user_wallets WHERE username = ?",
            (u,)
        ).fetchone()

    return jsonify({"pub": (row["pub"] if row else None)}), 200

@bp.post("/api/wallet/link")
def wallet_link():
    """
    Persist (or update) the user's active wallet pubkey.
    Idempotent: calling again overwrites the previous pub for this username.
    """
    u = current_username()
    if not u:
        # 401 keeps logs clean if the client ever forgets credentials:'include'
        return jsonify({"ok": False, "error": "unauthorized", "why": _why_no_user()}), 401

    data = (request.get_json(silent=True) or {})
    pub = (data.get("pub") or "").strip().upper()

    # Basic Stellar pubkey sanity check
    if not (pub.startswith("G") and len(pub) == 56):
        return jsonify({"ok": False, "error": "bad_pub"}), 400

    ts = now_i()
    with conn() as cx:
        got = cx.execute(
            "SELECT pub FROM user_wallets WHERE username = ?",
            (u,)
        ).fetchone()

        if got:
            # If you want to forbid switching wallets, return 409 here instead of UPDATE.
            cx.execute(
                "UPDATE user_wallets SET pub = ?, updated_at = ? WHERE username = ?",
                (pub, ts, u),
            )
        else:
            cx.execute(
                "INSERT INTO user_wallets (username, pub, created_at, updated_at) VALUES (?, ?, ?, ?)",
                (u, pub, ts, ts),
            )

    return jsonify({"ok": True, "username": u, "pub": pub}), 200
