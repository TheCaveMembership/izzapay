# game_pi_checkout.py
import os, time, json
from flask import Blueprint, request, jsonify
from db import conn
import requests

PI_API_BASE = os.getenv("PI_PLATFORM_API_URL", "https://api.minepi.com").rstrip("/")
PI_API_KEY  = os.getenv("PI_PLATFORM_API_KEY", "").strip()

def _pi_headers():
    if not PI_API_KEY:
        raise RuntimeError("PI_PLATFORM_API_KEY not set")
    return {"Authorization": f"Key {PI_API_KEY}", "Content-Type": "application/json"}

def _ok(**kw):  return jsonify({"ok": True, **kw})
def _err(msg, code=400): return jsonify({"ok": False, "reason": str(msg)}), code

# Minimal bookkeeping for Pi payments and credits
# - pi_craft_sessions: tracks the Pi payment lifecycle
# - crafting_mint_credits: simple balance (one row per user)
DDL = """
CREATE TABLE IF NOT EXISTS pi_craft_sessions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pi_payment_id TEXT UNIQUE,
  user_id INTEGER NOT NULL,
  amount_pi REAL NOT NULL,
  memo TEXT,
  status TEXT,            -- 'created','approved','completed'
  txid TEXT,
  created_at INTEGER,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS crafting_mint_credits(
  user_id INTEGER PRIMARY KEY,
  credits INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER
);
"""
def _ensure_schema():
    with conn() as cx: cx.executescript(DDL)

def _add_credits(user_id: int, n: int):
    n = max(0, int(n))
    if n == 0: return
    now = int(time.time())
    with conn() as cx:
        row = cx.execute("SELECT credits FROM crafting_mint_credits WHERE user_id=?", (user_id,)).fetchone()
        if row:
            cx.execute("UPDATE crafting_mint_credits SET credits=credits+?, updated_at=? WHERE user_id=?",
                       (n, now, user_id))
        else:
            cx.execute("INSERT INTO crafting_mint_credits(user_id, credits, updated_at) VALUES(?,?,?)",
                       (user_id, n, now))

def _get_credits(user_id: int) -> int:
    with conn() as cx:
        row = cx.execute("SELECT credits FROM crafting_mint_credits WHERE user_id=?", (user_id,)).fetchone()
        return int(row["credits"]) if row else 0

def _consume_credit(user_id: int, n: int = 1) -> bool:
    with conn() as cx:
        row = cx.execute("SELECT credits FROM crafting_mint_credits WHERE user_id=?", (user_id,)).fetchone()
        have = int(row["credits"]) if row else 0
        if have < n: return False
        cx.execute("UPDATE crafting_mint_credits SET credits=credits-? WHERE user_id=?", (n, user_id))
        return True

pi_checkout_bp = Blueprint("pi_checkout_bp", __name__, url_prefix="/api/crafting")

# Called by your UI BEFORE calling Pi.createPayment (optional; useful if you want a server memo)
@pi_checkout_bp.post("/pi/create")
def pi_create():
    from game_app import current_user_row  # reuse helper
    u = current_user_row()
    if not u: return _err("not_logged_in", 401)

    _ensure_schema()
    data = request.get_json(force=True) or {}
    amount = float(data.get("amount") or 0.0)
    memo   = str(data.get("memo") or "Crafting:single-mint")

    if amount <= 0: return _err("bad_amount")

    with conn() as cx:
        cx.execute(
            "INSERT INTO pi_craft_sessions(pi_payment_id, user_id, amount_pi, memo, status, created_at, updated_at) "
            "VALUES(?,?,?,?,? ,?,?)",
            (None, int(u["id"]), amount, memo, "created", int(time.time()), int(time.time()))
        )
    return _ok()

# Pi SDK callback #1
@pi_checkout_bp.post("/pi/approve")
def pi_approve():
    from game_app import current_user_row
    u = current_user_row()
    if not u: return _err("not_logged_in", 401)

    _ensure_schema()
    data = request.get_json(force=True) or {}
    pid  = str(data.get("paymentId") or "").strip()
    if not pid: return _err("missing_payment_id")

    # Verify with Pi Platform (server-to-server)
    r = requests.get(f"{PI_API_BASE}/v2/payments/{pid}", headers=_pi_headers(), timeout=20)
    if r.status_code != 200: return _err("pi_fetch_failed", 502)
    p = r.json()

    # Basic sanity: amount/memo (only if you want to enforce a fixed price)
    try_amount = float(p.get("amount") or 0)
    if try_amount <= 0: return _err("bad_amount")

    with conn() as cx:
        row = cx.execute("SELECT id FROM pi_craft_sessions WHERE pi_payment_id=?", (pid,)).fetchone()
        if not row:
            cx.execute(
                "INSERT INTO pi_craft_sessions(pi_payment_id, user_id, amount_pi, memo, status, created_at, updated_at) "
                "VALUES(?,?,?,?,? ,?,?)",
                (pid, int(u["id"]), try_amount, p.get("memo") or "", "approved", int(time.time()), int(time.time()))
            )
        else:
            cx.execute("UPDATE pi_craft_sessions SET status='approved', updated_at=? WHERE pi_payment_id=?",
                       (int(time.time()), pid))
    return _ok()

# Pi SDK callback #2
@pi_checkout_bp.post("/pi/complete")
def pi_complete():
    from game_app import current_user_row
    u = current_user_row()
    if not u: return _err("not_logged_in", 401)

    _ensure_schema()
    data = request.get_json(force=True) or {}
    pid  = str(data.get("paymentId") or "").strip()
    txid = str(data.get("txid") or "").strip()
    if not pid or not txid: return _err("missing_params")

    # Verify on-chain completion with Pi Platform (server-to-server)
    r = requests.post(f"{PI_API_BASE}/v2/payments/{pid}/complete",
                      headers=_pi_headers(),
                      json={"txid": txid, "verified": True},
                      timeout=30)
    if r.status_code not in (200, 201):  # some envs return 201
        return _err("pi_complete_failed", 502)

    # Mark as completed and grant ONE mint credit
    with conn() as cx:
        cx.execute("UPDATE pi_craft_sessions SET status='completed', txid=?, updated_at=? WHERE pi_payment_id=?",
                   (txid, int(time.time()), pid))
    _add_credits(int(u["id"]), 1)

    return _ok(granted=1)

# Simple status the UI can poll on mount
@pi_checkout_bp.get("/credits/status")
def credits_status():
    from game_app import current_user_row
    u = current_user_row()
    if not u: return _ok(credits=0)
    _ensure_schema()
    return _ok(credits=_get_credits(int(u["id"])))

# Optional: consume one credit when you actually mint
@pi_checkout_bp.post("/credits/consume")
def credits_consume():
    from game_app import current_user_row
    u = current_user_row()
    if not u: return _err("not_logged_in", 401)
    _ensure_schema()
    ok = _consume_credit(int(u["id"]), 1)
    return _ok(consumed=bool(ok))
