# game_pi_checkout.py
import os, json, requests, time
from flask import Blueprint, request, jsonify, current_app, session
from dotenv import load_dotenv
from db import conn

load_dotenv()

# ---------- ENV ----------
PI_SANDBOX   = os.getenv("PI_SANDBOX", "false").lower() == "true"
PI_API_BASE  = (os.getenv("PI_PLATFORM_API_URL") or "https://api.minepi.com").rstrip("/")
PI_API_KEY   = (os.getenv("PI_PLATFORM_API_KEY") or "").strip()
APP_NAME     = os.getenv("APP_NAME", "IZZA PAY")
APP_BASE_URL = (os.getenv("APP_BASE_URL") or "https://izzapay.onrender.com").rstrip("/")
BASE_ORIGIN  = APP_BASE_URL  # left for parity; not strictly needed here

if not PI_API_KEY:
    raise RuntimeError("PI_PLATFORM_API_KEY not set for game Pi checkout")

def pi_headers():
    return {"Authorization": f"Key {PI_API_KEY}", "Content-Type": "application/json"}

# ---------- Minimal credit tables (duplicated here for isolation) ----------
def _ensure_credit_tables(cx):
    cx.executescript("""
    CREATE TABLE IF NOT EXISTS crafting_credits(
      user_id INTEGER PRIMARY KEY,
      balance INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS crafting_credit_ledger(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      delta  INTEGER NOT NULL,
      reason TEXT,
      uniq   TEXT UNIQUE,              -- idempotency key (e.g., order:<payment_id>)
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    """)

def _credit_add(cx, user_id:int, delta:int, reason:str, uniq:str|None=None):
    if delta == 0:
        return
    _ensure_credit_tables(cx)
    if uniq:
        hit = cx.execute("SELECT 1 FROM crafting_credit_ledger WHERE uniq=?", (uniq,)).fetchone()
        if hit:  # idempotent
            return
    cx.execute(
        "INSERT INTO crafting_credit_ledger(user_id, delta, reason, uniq) VALUES(?,?,?,?)",
        (user_id, delta, reason, uniq)
    )
    cx.execute("""
      INSERT INTO crafting_credits(user_id, balance) VALUES(?, ?)
      ON CONFLICT(user_id) DO UPDATE SET balance = crafting_credits.balance + excluded.balance,
                                         updated_at = CURRENT_TIMESTAMP
    """, (user_id, delta))

def _current_user():
    uid = session.get("user_id")
    if not uid:
        return None
    with conn() as cx:
        return cx.execute("SELECT id, pi_uid, pi_username FROM users WHERE id=?", (uid,)).fetchone()

def _record_pi_order(user_id:int, payment_id:str, title:str="", store:str="IZZA PAY",
                     crafted_item_id:str="", thumb_url:str=""):
    with conn() as cx:
        cx.execute("""
        CREATE TABLE IF NOT EXISTS pi_orders(
          order_id TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL,
          title TEXT,
          thumb_url TEXT,
          store TEXT,
          crafted_item_id TEXT,
          claimed INTEGER DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )""")
        cx.execute("""
          INSERT OR IGNORE INTO pi_orders(order_id, user_id, title, thumb_url, store, crafted_item_id, claimed)
          VALUES(?,?,?,?,?,?,0)
        """, (payment_id, user_id, title or "Craft Mint Credit", thumb_url or "", store or "IZZA PAY", crafted_item_id or ""))

# ---------- Pi helpers ----------
def fetch_pi_payment(payment_id: str):
    return requests.get(f"{PI_API_BASE}/v2/payments/{payment_id}", headers=pi_headers(), timeout=20)

# ---------- Blueprint ----------
pi_checkout_bp = Blueprint("game_pi_checkout", __name__)

@pi_checkout_bp.post("/api/pi/approve")
def pi_approve():
    """
    Stateless approve to match the crafting UI.
    Expects: { paymentId, session_id }
    """
    data = request.get_json(force=True) or {}
    payment_id = (data.get("paymentId") or "").strip()
    if not payment_id:
        return jsonify(ok=False, error="missing_paymentId"), 400

    # Just forward to Pi Platform
    r = requests.post(f"{PI_API_BASE}/v2/payments/{payment_id}/approve",
                      headers=pi_headers(), json={}, timeout=20)
    if r.status_code != 200:
        return jsonify(ok=False, error="approve_failed", status=r.status_code,
                       body=safe_json(r)), 502
    return jsonify(ok=True)

@pi_checkout_bp.post("/api/pi/complete")
def pi_complete():
    """
    Stateless completion. Validates payment, then grants 1 mint credit for 'craft-credit'.
    Body: { paymentId, txid, session_id, buyer?, shipping? }
    """
    data = request.get_json(force=True) or {}
    payment_id = (data.get("paymentId") or "").strip()
    txid       = (data.get("txid") or "").strip()
    session_id = (data.get("session_id") or "").strip()  # e.g., "craft-credit"
    buyer      = data.get("buyer") or {}
    shipping   = data.get("shipping") or {}

    if not payment_id:
        return jsonify(ok=False, error="missing_paymentId"), 400

    # 1) Fetch to confirm status / txid (best-effort in sandbox)
    try:
        r = fetch_pi_payment(payment_id)
        if r.status_code != 200 and not PI_SANDBOX:
            return jsonify(ok=False, error="fetch_failed"), 502
        if r.status_code == 200:
            pj = r.json()
            # If txid provided by client and platform has a tx, ensure they match (outside sandbox)
            plat_txid = ((pj.get("transaction") or {}).get("txid")
                         or (pj.get("transaction") or {}).get("txID")
                         or (pj.get("transaction") or {}).get("hash") or "")
            if txid and plat_txid and (txid != plat_txid) and not PI_SANDBOX:
                return jsonify(ok=False, error="txid_mismatch"), 400
    except Exception:
        if not PI_SANDBOX:
            return jsonify(ok=False, error="verify_error"), 500

    # 2) Complete on Pi Platform (may be already completed; treat 409/400 as ok-ish)
    try:
        rc = requests.post(f"{PI_API_BASE}/v2/payments/{payment_id}/complete",
                           headers=pi_headers(), json={"txid": txid} if txid else {},
                           timeout=20)
        if rc.status_code not in (200, 201):
            # If already completed or bad transition, allow when sandbox
            if not PI_SANDBOX:
                return jsonify(ok=False, error="complete_failed", status=rc.status_code,
                               body=safe_json(rc)), 502
    except Exception:
        if not PI_SANDBOX:
            return jsonify(ok=False, error="complete_exception"), 500

    # 3) Success: grant credit if we know the user
    u = _current_user()
    user_id = int(u["id"]) if u else None

    if session_id == "craft-credit" and user_id:
        # idempotency key based on payment id
        uniq = f"order:{payment_id}"
        with conn() as cx:
            _credit_add(cx, user_id, +1, reason="single-mint", uniq=uniq)
        # Also record the order for /api/crafts/feed
        _record_pi_order(user_id, payment_id, title="Craft Mint Credit", store=APP_NAME)

    return jsonify(ok=True, status="complete")

@pi_checkout_bp.get("/api/pi/status")
def pi_status():
    """Optional: Used by clients to poll payment state."""
    payment_id = (request.args.get("paymentId") or "").strip()
    if not payment_id:
        return jsonify(ok=False, error="missing_paymentId"), 400
    r = fetch_pi_payment(payment_id)
    try:
        body = r.json()
    except Exception:
        body = {"raw": r.text[:4000]}
    return jsonify(ok=(r.status_code == 200), status=r.status_code, payment=body)

# ---------- utils ----------
def safe_json(resp):
    try:
        return resp.json()
    except Exception:
        return {"text": resp.text[:4000], "status": resp.status_code}
