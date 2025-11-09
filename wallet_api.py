from flask import Blueprint, request, jsonify, session
from time import time
from db import conn

# >>> NEW: minimal imports for balances + env
import os
from stellar_sdk import Server
# <<<

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
    """
    Ensure the user_wallets table exists and is upgraded to the latest schema.
    - username TEXT PRIMARY KEY (normalized)
    - pub      TEXT (G...)
    - secret   TEXT (S...) optional
    - revealed INTEGER (optional 'shown once' flag; default 0)
    - created_at / updated_at INTEGER (unix seconds)
    """
    with conn() as cx:
        # Create if missing (base shape)
        cx.execute("""
          CREATE TABLE IF NOT EXISTS user_wallets(
            username   TEXT PRIMARY KEY,
            pub        TEXT,
            secret     TEXT,
            revealed   INTEGER DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          )
        """)

        # If table existed previously without these columns, upgrade in place.
        # SQLite lacks "ADD COLUMN IF NOT EXISTS", so we try/except each.
        try:
            cx.execute("ALTER TABLE user_wallets ADD COLUMN secret TEXT")
        except Exception:
            pass
        try:
            cx.execute("ALTER TABLE user_wallets ADD COLUMN revealed INTEGER DEFAULT 0")
        except Exception:
            pass

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
        row = cx.execute(
            "SELECT pub, secret FROM user_wallets WHERE username=?",
            (u,)
        ).fetchone()

    return jsonify({
        "pub": (row["pub"] if row else None),
        "secret": (row["secret"] if row else None),
        "username": u
    }), 200

@bp.post("/api/wallet/link")
def wallet_link():
    """
    Persist (or update) the user's active wallet keys.
    Accepts ?u=<username> or derives from session like the rest of your app.
    Body: { "pub": "G...", "secret": "S..."? }
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

    secret = (data.get("secret") or "").strip()
    if secret and not (secret.startswith("S") and len(secret) == 56):
        return jsonify({"ok": False, "error": "bad_secret"}), 400

    ts = now_i()
    with conn() as cx:
        cx.execute("""
          INSERT INTO user_wallets(username, pub, secret, created_at, updated_at)
          VALUES(?,?,?,?,?)
          ON CONFLICT(username) DO UPDATE SET
            pub=excluded.pub,
            secret=COALESCE(excluded.secret, user_wallets.secret),
            updated_at=excluded.updated_at
        """, (u, pub, (secret or None), ts, ts))

    return jsonify({"ok": True, "username": u, "pub": pub}), 200


# =========================
# NEW: helpers + endpoints
# =========================

# Horizon client and env for balances
HORIZON_URL = os.getenv("HORIZON_URL", "https://api.testnet.minepi.com").strip()
IZZA_CODE   = os.getenv("IZZA_TOKEN_CODE", "IZZA").strip()
IZZA_ISS    = os.getenv("IZZA_TOKEN_ISSUER", "").strip()
_srv = Server(horizon_url=HORIZON_URL)

def get_linked_secret(pub: str | None):
    """
    Return the stored S-key for a given public key if present and well-formed.
    Used by creatures API to attempt direct delivery.
    """
    if not pub:
        return None
    with conn() as cx:
        row = cx.execute("SELECT secret FROM user_wallets WHERE pub=?", (pub.strip().upper(),)).fetchone()
    sec = (row["secret"] if row else None)
    if sec and sec.startswith("S") and len(sec) == 56:
        return sec
    return None

@bp.get("/api/wallet/balances")
def wallet_balances():
    """
    Returns { pi: '123.456', izza: '7.0000000' } for the resolved user.
    Works with ?u=<username> or session.
    """
    _ensure_table()
    u = _resolve_username()
    if not u:
        return jsonify({"pi": None, "izza": None, "why": _why_no_user()}), 200

    with conn() as cx:
        row = cx.execute("SELECT pub FROM user_wallets WHERE username=?", (u,)).fetchone()
    pub = row["pub"] if row else None
    if not pub:
        return jsonify({"pi": None, "izza": None, "why": "no active wallet set"}), 200

    try:
        acct = _srv.accounts().account_id(pub).call()
    except Exception:
        return jsonify({"pi": None, "izza": None, "why": "account not found"}), 200

    pi = "0"
    izza = "0"
    for b in acct.get("balances", []):
        if b.get("asset_type") == "native":
            pi = b.get("balance", "0")
        elif b.get("asset_code") == IZZA_CODE and b.get("asset_issuer") == IZZA_ISS:
            izza = b.get("balance", "0")

    return jsonify({"pi": pi, "izza": izza}), 200
