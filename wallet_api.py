from flask import Blueprint, request, jsonify, session
from time import time
from db import conn

bp = Blueprint("wallet_api", __name__)

# ---------- helpers ----------
def now_i() -> int:
    return int(time())

def _norm_username(u: str | None) -> str | None:
    if not u:
        return None
    u = str(u).strip().lstrip("@").lower()
    return u or None

def _ensure_table():
    with conn() as cx:
        cx.execute("""
          CREATE TABLE IF NOT EXISTS user_wallets(
            username   TEXT PRIMARY KEY,   -- normalized (lowercase, no @)
            pub        TEXT,               -- 56-char G...
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          )
        """)

def _resolve_username():
    """
    Username-first resolution:
      1) ?u=<username> (preferred, works without session)
      2) session['pi_username']
      3) session['user_id'] -> users.pi_username
    """
    # 1) explicit query
    u = _norm_username(request.args.get("u"))
    if u:
        return u

    # 2) session cache
    u = _norm_username(session.get("pi_username"))
    if u:
        return u

    # 3) derive from user_id (if present)
    uid = session.get("user_id")
    if not uid:
        return None
    with conn() as cx:
        row = cx.execute("SELECT pi_username FROM users WHERE id=?", (int(uid),)).fetchone()
    return _norm_username(row["pi_username"] if row else None)

def _why_no_user():
    if request.args.get("u"):
        return "bad username in ?u (empty after normalization)"
    if "pi_username" in session and not session.get("pi_username"):
        return "empty pi_username in session"
    if "user_id" not in session:
        return "no session; pass ?u=<username> or sign in"
    return "no matching user row for user_id"

# ---------- routes ----------
@bp.get("/api/wallet/active")
def wallet_active():
    """
    Read the persisted wallet for a user.
    Works with either ?u=<username> OR a signed-in session.
    """
    _ensure_table()
    u = _resolve_username()
    if not u:
        return jsonify({"pub": None, "why": _why_no_user()}), 200

    with conn() as cx:
        row = cx.execute("SELECT pub FROM user_wallets WHERE username=?", (u,)).fetchone()

    return jsonify({"pub": (row["pub"] if row else None), "username": u}), 200

@bp.post("/api/wallet/link")
def wallet_link():
    """
    Persist (or update) the user's active wallet pubkey.
    Accepts ?u=<username> or derives from session like the rest of your app.
    Body: { "pub": "G..." }
    """
    _ensure_table()
    u = _resolve_username()
    if not u:
        return jsonify({"ok": False, "error": "unauthorized", "why": _why_no_user()}), 401

    data = (request.get_json(silent=True) or {})
    pub = (data.get("pub") or "").strip().upper()

    # Basic Stellar pubkey sanity check
    if not (pub.startswith("G") and len(pub) == 56):
        return jsonify({"ok": False, "error": "bad_pub"}), 400

    ts = now_i()
    with conn() as cx:
        cx.execute("""
          INSERT INTO user_wallets(username, pub, created_at, updated_at)
          VALUES(?,?,?,?)
          ON CONFLICT(username) DO UPDATE SET
            pub=excluded.pub,
            updated_at=excluded.updated_at
        """, (u, pub, ts, ts))

    return jsonify({"ok": True, "username": u, "pub": pub}), 200
