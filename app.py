import os, json, uuid, time, hmac, base64, hashlib
from decimal import Decimal, ROUND_HALF_UP
from datetime import timedelta
from urllib.parse import urlparse
from flask import Flask, request, render_template, render_template_string, redirect, session, abort, Response
from dotenv import load_dotenv
import requests

# Local modules you already have
from db import init_db, conn
from emailer import send_email
from payments import split_amounts

# ----------------- ENV -----------------
load_dotenv()

PI_SANDBOX   = os.getenv("PI_SANDBOX", "false").lower() == "true"
PI_API_BASE  = os.getenv("PI_PLATFORM_API_URL", "https://api.minepi.com")
PI_API_KEY   = os.getenv("PI_PLATFORM_API_KEY", "")
APP_NAME     = os.getenv("APP_NAME", "IZZA PAY")
APP_BASE_URL = os.getenv("APP_BASE_URL", "https://izzapay.onrender.com").rstrip("/")
BASE_ORIGIN  = APP_BASE_URL
# Debug token for manual email tests (put this in your .env in production)
DEBUG_EMAIL_TOKEN = os.getenv("DEBUG_EMAIL_TOKEN", "782ba6059694b921d317b0df83db4772")

# ----------------- APP -----------------
app = Flask(__name__)
_secret = os.getenv("FLASK_SECRET") or os.urandom(32)
app.secret_key = _secret
app.config.update(
    SESSION_COOKIE_NAME="izzapay_session",
    SESSION_COOKIE_SAMESITE="None",
    SESSION_COOKIE_SECURE=True,
    SESSION_COOKIE_HTTPONLY=True,
    PERMANENT_SESSION_LIFETIME=timedelta(days=7),
)

def log(*args):
    """Flush logs so they show up immediately on Render."""
    try:
        print(*args, flush=True)
    except Exception:
        pass
    try:
        app.logger.info(" ".join(str(a) for a in args))
    except Exception:
        pass

@app.context_processor
def inject_globals():
    return {"APP_BASE_URL": APP_BASE_URL, "BASE_ORIGIN": BASE_ORIGIN, "PI_SANDBOX": PI_SANDBOX}

# ----------------- DB & SCHEMA -----------------
init_db()

def ensure_schema():
    with conn() as cx:
        # merchants extras
        cols_m = {r["name"] for r in cx.execute("PRAGMA table_info(merchants)")}
        if "pi_wallet_address" not in cols_m:
            cx.execute("ALTER TABLE merchants ADD COLUMN pi_wallet_address TEXT")
        if "pi_handle" not in cols_m:
            cx.execute("ALTER TABLE merchants ADD COLUMN pi_handle TEXT")
        if "colorway" not in cols_m:
            cx.execute("ALTER TABLE merchants ADD COLUMN colorway TEXT")

        # carts & cart_items
        cx.execute("""
        CREATE TABLE IF NOT EXISTS carts(
          id TEXT PRIMARY KEY,
          merchant_id INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        )""")
        cx.execute("""
        CREATE TABLE IF NOT EXISTS cart_items(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          cart_id TEXT NOT NULL,
          item_id INTEGER NOT NULL,
          qty INTEGER NOT NULL
        )""")

        # sessions: add pi_payment_id for tracking pending payments
        cols_s = {r["name"] for r in cx.execute("PRAGMA table_info(sessions)")}
        if "pi_payment_id" not in cols_s:
            try:
                cx.execute("ALTER TABLE sessions ADD COLUMN pi_payment_id TEXT")
            except Exception:
                pass
ensure_schema()

# ----------------- URL TOKEN -----------------
TOKEN_TTL = 60 * 10
def _b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode("ascii")
def _b64url_dec(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)
def mint_login_token(user_id: int, ttl: int = TOKEN_TTL) -> str:
    payload = {"uid": user_id, "exp": int(time.time()) + ttl, "v": 1}
    body = _b64url(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    key_bytes = app.secret_key if isinstance(app.secret_key, bytes) else app.secret_key.encode("utf-8")
    sig = hmac.new(key_bytes, body.encode("utf-8"), hashlib.sha256).digest()
    return body + "." + _b64url(sig)
def verify_login_token(token: str):
    try:
        body, sig = token.split(".")
        key_bytes = app.secret_key if isinstance(app.secret_key, bytes) else app.secret_key.encode("utf-8")
        want = hmac.new(key_bytes, body.encode("utf-8"), hashlib.sha256).digest()
        if not hmac.compare_digest(_b64url(want), sig):
            return None
        payload = json.loads(_b64url_dec(body))
        if payload.get("exp", 0) < int(time.time()):
            return None
        return int(payload.get("uid"))
    except Exception:
        return None
def get_bearer_token_from_request() -> str | None:
    t = request.args.get("t") or request.form.get("t")
    if t: return t.strip()
    auth = request.headers.get("Authorization", "")
    if auth and auth.lower().startswith("bearer "):
        return auth.split(" ", 1)[1].strip()
    return None

# ----------------- HELPERS -----------------
def current_user_row():
    uid = session.get("user_id")
    if not uid:
        tok = get_bearer_token_from_request()
        if tok:
            uid = verify_login_token(tok)
    if not uid:
        return None
    with conn() as cx:
        return cx.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()

def require_user():
    row = current_user_row()
    if not row: return redirect("/signin")
    return row

def resolve_merchant_by_slug(slug):
    with conn() as cx:
        return cx.execute("SELECT * FROM merchants WHERE slug=?", (slug,)).fetchone()

def require_merchant_owner(slug):
    u = require_user()
    if isinstance(u, Response): return u, None
    m = resolve_merchant_by_slug(slug)
    if not m: abort(404)
    if m["owner_user_id"] != u["id"]: abort(403)
    return u, m

def get_or_create_cart(merchant_id, cid=None):
    with conn() as cx:
        if cid:
            c = cx.execute("SELECT * FROM carts WHERE id=? AND merchant_id=?", (cid, merchant_id)).fetchone()
            if c: return cid
        cid = uuid.uuid4().hex[:12]
        cx.execute("INSERT INTO carts(id, merchant_id, created_at) VALUES(?,?,?)",
                   (cid, merchant_id, int(time.time())))
        return cid

def pi_headers():
    if not PI_API_KEY:
        raise RuntimeError("PI_PLATFORM_API_KEY is required")
    return {"Authorization": f"Key {PI_API_KEY}", "Content-Type": "application/json"}

def fetch_pi_payment(payment_id: str):
    url = f"{PI_API_BASE}/v2/payments/{payment_id}"
    return requests.get(url, headers=pi_headers(), timeout=15)

# ----------------- DEBUG -----------------
@app.get("/whoami")
def whoami():
    row = current_user_row()
    return {"logged_in": bool(row), "user_id": (row["id"] if row else None)}, 200

def _require_debug_token():
    tok = (request.args.get("token") or request.headers.get("X-Debug-Token") or "").strip()
    if not DEBUG_EMAIL_TOKEN or tok != DEBUG_EMAIL_TOKEN:
        abort(403)

@app.get("/debug/ping")
def debug_ping():
    _require_debug_token()
    return {"ok": True, "message": "pong", "time": int(time.time())}, 200

# Cancel a stuck Pi payment (server-side) by explicit id
@app.get("/debug/cancel-payment")
def debug_cancel_payment():
    _require_debug_token()
    payment_id = (request.args.get("payment_id") or "").strip()
    if not payment_id:
        return {"ok": False, "error": "missing_payment_id"}, 400
    try:
        url = f"{PI_API_BASE}/v2/payments/{payment_id}/cancel"
        r = requests.post(url, headers=pi_headers(), json={})
        if r.status_code != 200:
            return {"ok": False, "status": r.status_code, "body": r.text}, 502
        return {"ok": True, "payment_id": payment_id}, 200
    except Exception as e:
        log("debug_cancel_payment error:", repr(e))
        return {"ok": False, "error": "server_error"}, 500

# NEW: list recent sessions that captured a payment id but are still initiated, with cancel buttons
@app.get("/debug/pending")
def debug_pending():
    _require_debug_token()
    with conn() as cx:
        rows = cx.execute("""
            SELECT s.id as session_id, s.created_at, s.expected_pi, s.pi_payment_id,
                   s.state, s.merchant_id, m.slug as m_slug, m.business_name as m_name
            FROM sessions s
            LEFT JOIN merchants m ON m.id = s.merchant_id
            WHERE s.pi_payment_id IS NOT NULL
              AND (s.state IS NULL OR s.state='initiated')
            ORDER BY s.created_at DESC
            LIMIT 100
        """).fetchall()

    # Convert to plain dicts for JSON serialization
    data = [dict(r) for r in rows]

    html = """
<!doctype html>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pending Pi Payments (Server View)</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#0b0f17;color:#e8f0ff;padding:16px}
table{width:100%;border-collapse:collapse}
td,th{padding:8px;border-bottom:1px solid #1f2a44}
small{color:#bcd0ff}
button{padding:6px 10px;border:0;border-radius:8px;background:#6e9fff;color:#0b0f17;font-weight:800;cursor:pointer}
code{background:#0f1728;padding:2px 6px;border-radius:6px}
.card{background:#0f1728;border:1px solid #1f2a44;border-radius:12px;padding:16px;max-width:1000px;margin:0 auto}
</style>
<div class="card">
  <h2>Pending (initiated) sessions with stored <code>payment_id</code></h2>
  <p><small>Use this when the Pi SDK doesn't surface the incomplete payment. Click cancel to clear the platform-side block.</small></p>
  <table>
    <thead><tr><th>When</th><th>Store</th><th>Session</th><th>Expected π</th><th>payment_id</th><th>Action</th></tr></thead>
    <tbody id="rows"></tbody>
  </table>
</div>
<script>
const data  = {{ data|tojson }};
const token = new URL(location.href).searchParams.get('token') || '';
const tbody = document.getElementById('rows');
function fmt(ts){ try{return new Date(ts*1000).toLocaleString()}catch(e){return ts} }
function tr(r){
  const id = r.session_id, pay = r.pi_payment_id || '';
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><small>${fmt(r.created_at)}</small></td>
    <td>${r.m_name || ''} <small>(${r.m_slug||''})</small></td>
    <td><code>${id}</code> <small>${r.state||''}</small></td>
    <td>${(r.expected_pi||0).toFixed ? Number(r.expected_pi).toFixed(7) : r.expected_pi}</td>
    <td><code>${pay}</code></td>
    <td><button data-pay="${pay}">Cancel</button></td>
  `;
  tr.querySelector('button').onclick = async (ev)=>{
    const pid = ev.target.getAttribute('data-pay');
    if(!pid) return;
    ev.target.disabled = true; ev.target.textContent = 'Cancelling…';
    try{
      const url = `/debug/cancel-payment?token=${encodeURIComponent(token)}&payment_id=${encodeURIComponent(pid)}`;
      const res = await fetch(url);
      const j = await res.json();
      if(j && j.ok){ ev.target.textContent = 'Cancelled ✓'; }
      else { ev.target.textContent = 'Failed'; console.log(j); }
    }catch(e){ ev.target.textContent = 'Error'; console.error(e); }
  };
  return tr;
}
if(Array.isArray(data) && data.length){
  data.forEach(r => tbody.appendChild(tr(r)));
}else{
  const tr0 = document.createElement('tr');
  tr0.innerHTML = '<td colspan="6"><small>No candidate sessions found.</small></td>';
  tbody.appendChild(tr0);
}
</script>
"""
    return render_template_string(html, data=data)

# Tiny page that finds an incomplete payment via the Pi SDK and lets you cancel it
@app.get("/debug/incomplete")
def debug_incomplete():
    _require_debug_token()
    token = (request.args.get("token") or "").strip()
    html = """
<!doctype html>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Find & Cancel Incomplete Pi Payment</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;padding:16px;background:#0b0f17;color:#e8f0ff}
  .card{background:#0f1728;border:1px solid #1f2a44;border-radius:12px;padding:16px;max-width:640px;margin:0 auto}
  button{padding:10px 14px;border:0;border-radius:10px;background:#6e9fff;color:#0b0f17;font-weight:800;cursor:pointer}
  input{width:100%;padding:10px;border:1px solid #1f2a44;border-radius:10px;background:#0b1222;color:#e8f0ff}
  .muted{color:#bcd0ff}
  .row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
</style>
<div class="card">
  <h2>Find & Cancel Incomplete Payment</h2>
  <p class="muted">Open this page <strong>in Pi Browser</strong>.</p>
  <p class="muted">Token ends with: <code id="tok"></code></p>

  <div id="status" class="muted">Loading Pi SDK…</div>

  <div id="found" style="display:none;margin-top:12px">
    <div class="row" style="align-items:flex-end">
      <div style="flex:1">
        <label class="muted">Payment ID</label>
        <input id="pid" readonly>
      </div>
      <div>
        <button id="cancelBtn">Cancel payment</button>
      </div>
    </div>
    <p class="muted" style="margin-top:8px">If cancel succeeds, you can retry checkout immediately.</p>
  </div>

  <div id="none" style="display:none;margin-top:12px">
    <p>No incomplete payment was reported by the Pi SDK.</p>
  </div>
</div>

<script src="https://sdk.minepi.com/pi-sdk.js"></script>
<script>
(function(){
  const status = document.getElementById('status');
  const found  = document.getElementById('found');
  const none   = document.getElementById('none');
  const pidEl  = document.getElementById('pid');
  const btn    = document.getElementById('cancelBtn');
  const tokEl  = document.getElementById('tok');

  function set(t){ status.textContent = t; }
  function qs(k){ return new URL(location.href).searchParams.get(k) || ''; }
  const token = qs('token');
  tokEl.textContent = token ? token.slice(-6) : '';

  async function init(){
    try{
      if(!window.Pi || !Pi.init){ set("Pi SDK not available. Open in Pi Browser."); return; }
      Pi.init({ version: "2.0" });

      let stuckId = null;
      const scopes = ['payments','username'];
      function onIncompletePaymentFound(payment){
        try{
          stuckId = (payment && (payment.identifier || payment.paymentId)) || null;
        }catch(_){}
      }

      set("Authenticating…");
      await Pi.authenticate(scopes, onIncompletePaymentFound);

      if(stuckId){
        set("Incomplete payment detected.");
        pidEl.value = stuckId;
        found.style.display = '';

        btn.onclick = async () => {
          btn.disabled = true; btn.textContent = "Cancelling…";
          try{
            const url = `/debug/cancel-payment?token=${encodeURIComponent(token)}&payment_id=${encodeURIComponent(stuckId)}`;
            const r = await fetch(url);
            const j = await r.json();
            if(j && j.ok){
              set("Cancelled. You can retry checkout now.");
            }else{
              set("Cancel failed. See server logs."); console.log(j);
            }
          }catch(e){
            set("Cancel request errored. See logs."); console.error(e);
          }finally{
            btn.disabled = false; btn.textContent = "Cancel payment";
          }
        };
      }else{
        set("No incomplete payment detected.");
        none.style.display = '';
      }
    }catch(e){
      set("Error: " + (e && e.message || e));
      console.error(e);
    }
  }
  init();
})();
</script>
"""
    return render_template_string(html)

# List most recent orders (avoid created_at; not all schemas have it)
@app.get("/debug/orders")
def debug_orders():
    _require_debug_token()
    try:
        with conn() as cx:
            rows = cx.execute(
                """SELECT id, merchant_id, item_id, qty, buyer_email, status,
                          pi_amount, pi_fee, pi_merchant_net, pi_tx_hash, buyer_token
                   FROM orders
                   ORDER BY id DESC
                   LIMIT 10"""
            ).fetchall()
        return {"ok": True, "orders": [dict(r) for r in rows]}, 200
    except Exception as e:
        print("[debug/orders] ERROR:", repr(e))
        return {"ok": False, "error": repr(e)}, 500

# Manual email trigger (POST)
@app.post("/debug/send-order-emails/<int:order_id>")
def debug_send_order_emails_post(order_id: int):
    _require_debug_token()
    try:
        print(f"[debug] manual email trigger (POST) -> order_id={order_id}")
        send_order_emails(order_id)
        print(f"[debug] manual email trigger complete -> order_id={order_id}")
        return {"ok": True, "order_id": order_id}, 200
    except Exception as e:
        print(f"[debug] manual email trigger error -> order_id={order_id} err={repr(e)}")
        return {"ok": False, "error": repr(e)}, 500

# Manual email trigger (GET) — easy from Pi Browser/Safari
@app.get("/debug/send-order-emails/<int:order_id>")
def debug_send_order_emails_get(order_id: int):
    _require_debug_token()
    try:
        print(f"[debug] manual email trigger (GET) -> order_id={order_id}")
        send_order_emails(order_id)
        print(f"[debug] manual email trigger complete -> order_id={order_id}")
        return {"ok": True, "order_id": order_id, "note": "Triggered via GET"}, 200
    except Exception as e:
        print(f"[debug] manual email trigger error (GET) -> order_id={order_id} err={repr(e)}")
        return {"ok": False, "error": repr(e)}, 500
# ----------------- END DEBUG -----------------

# ----------------- Explore (Browse stores) -----------------
@app.get("/explore")
def explore():
    q = (request.args.get("q") or "").strip()
    try:
        page = max(1, int(request.args.get("page", "1")))
    except ValueError:
        page = 1
    PAGE_SIZE = 12
    offset = (page - 1) * PAGE_SIZE

    with conn() as cx:
        if q:
            like = f"%{q}%"
            merchants = cx.execute(
                """SELECT slug, business_name, logo_url, theme_mode, colorway
                   FROM merchants
                   WHERE business_name LIKE ? OR slug LIKE ?
                   ORDER BY id DESC
                   LIMIT 50""",
                (like, like)
            ).fetchall()

            products = cx.execute(
                """SELECT items.*, 
                          merchants.slug          AS m_slug,
                          merchants.business_name AS m_name,
                          merchants.colorway      AS m_colorway,
                          merchants.theme_mode    AS m_theme
                   FROM items 
                   JOIN merchants ON merchants.id = items.merchant_id
                   WHERE items.active=1
                     AND (items.title LIKE ? OR merchants.business_name LIKE ?)
                   ORDER BY items.id DESC
                   LIMIT ? OFFSET ?""",
                (like, like, PAGE_SIZE, offset)
            ).fetchall()
        else:
            merchants = cx.execute(
                """SELECT slug, business_name, logo_url, theme_mode, colorway
                   FROM merchants
                   ORDER BY id DESC
                   LIMIT 50"""
            ).fetchall()

            products = cx.execute(
                """SELECT items.*, 
                          merchants.slug          AS m_slug,
                          merchants.business_name AS m_name,
                          merchants.colorway      AS m_colorway,
                          merchants.theme_mode    AS m_theme
                   FROM items 
                   JOIN merchants ON merchants.id = items.merchant_id
                   WHERE items.active=1
                   ORDER BY items.id DESC
                   LIMIT ? OFFSET ?""",
                (PAGE_SIZE, offset)
            ).fetchall()

    has_more_products = len(products) == PAGE_SIZE
    return render_template(
        "explore.html",
        merchants=merchants,
        products=products,
        q=q,
        page=page,
        has_more_products=has_more_products,
        app_base=APP_BASE_URL,
    )

# ----------------- GENERAL SIGN-IN -----------------
@app.get("/")
def home():
    desired = request.args.get("path")
    if desired and desired.startswith("/"): return redirect(desired)
    return redirect("/signin")

@app.get("/signin")
def signin():
    if request.args.get("fresh") == "1":
        session.clear()
    return render_template("pi_signin.html", app_base=APP_BASE_URL, sandbox=PI_SANDBOX)

@app.post("/logout")
def logout():
    session.clear()
    return redirect("/signin")

@app.post("/api/pi/me")
def pi_me():
    try:
        data = request.get_json(force=True)
        token = (data or {}).get("accessToken")
        if not token: return {"ok": False, "error": "missing_token"}, 400
        url = f"{PI_API_BASE}/v2/me"
        r = requests.get(url, headers={"Authorization": f"Bearer {token}"}, timeout=10)
        if r.status_code != 200:
            return {"ok": False, "error": "token_invalid", "status": r.status_code}, 401
        return {"ok": True, "me": r.json()}
    except Exception as e:
        log("pi_me error:", repr(e))
        return {"ok": False, "error": "server_error"}, 500

@app.post("/auth/exchange")
def auth_exchange():
    try:
        if request.is_json:
            data = request.get_json(silent=True) or {}
        else:
            payload = request.form.get("payload", "")
            try: data = json.loads(payload) if payload else {}
            except Exception: data = {}
        user = (data.get("user") or {})
        uid = user.get("uid") or user.get("id")
        username = user.get("username")
        token = data.get("accessToken")
        if not uid or not username or not token:
            if not request.is_json: return redirect("/signin?fresh=1")
            return {"ok": False, "error": "invalid_payload"}, 400
        r = requests.get(f"{PI_API_BASE}/v2/me",
                         headers={"Authorization": f"Bearer {token}"}, timeout=10)
        if r.status_code != 200:
            if not request.is_json: return redirect("/signin?fresh=1")
            return {"ok": False, "error": "token_invalid"}, 401
        with conn() as cx:
            row = cx.execute("SELECT * FROM users WHERE pi_uid=?", (uid,)).fetchone()
            if not row:
                cx.execute("""INSERT INTO users(pi_uid, pi_username, role, created_at)
                              VALUES(?, ?, 'buyer', ?)""",
                           (uid, username, int(time.time())))
                row = cx.execute("SELECT * FROM users WHERE pi_uid=?", (uid,)).fetchone()
        try:
            session["user_id"] = row["id"]; session.permanent = True
        except Exception: pass
        tok = mint_login_token(row["id"])
        target = f"/dashboard?t={tok}"
        if not request.is_json: return redirect(target)
        return {"ok": True, "redirect": target}
    except Exception as e:
        log("auth_exchange error:", repr(e))
        if not request.is_json: return redirect("/signin?fresh=1")
        return {"ok": False, "error": "server_error"}, 500

# ----------------- MERCHANT DASHBOARD -----------------
@app.get("/dashboard")
def dashboard():
    u = require_user()
    if isinstance(u, Response): return u
    with conn() as cx:
        m = cx.execute("SELECT * FROM merchants WHERE owner_user_id=?", (u["id"],)).fetchone()
    tok = get_bearer_token_from_request()
    if not m: return redirect(f"/merchant/setup{('?t='+tok) if tok else ''}")
    return redirect(f"/merchant/{m['slug']}/items{('?t='+tok) if tok else ''}")

@app.get("/merchant/setup")
def merchant_setup_form():
    u = require_user()
    if isinstance(u, Response): return u
    with conn() as cx:
        m = cx.execute("SELECT * FROM merchants WHERE owner_user_id=?", (u["id"],)).fetchone()
    if m:
        tok = get_bearer_token_from_request()
        return redirect(f"/merchant/{m['slug']}/items{('?t='+tok) if tok else ''}")
    tok = get_bearer_token_from_request()
    return render_template("merchant_items.html", setup_mode=True, m=None, items=[],
                           app_base=APP_BASE_URL, t=tok, share_base=BASE_ORIGIN,
                           username=u["pi_username"], colorway="cw-blue")

@app.post("/merchant/setup")
def merchant_setup():
    u = require_user()
    if isinstance(u, Response): return u
    data = request.form
    slug = (data.get("slug") or uuid.uuid4().hex[:6]).lower()
    business_name = data.get("business_name") or f"{u['pi_username']}'s Shop"
    logo_url = (data.get("logo_url") or "").strip()
    theme_mode = data.get("theme_mode", "dark")
    reply_to_email = (data.get("reply_to_email") or "").strip()
    pi_wallet_address = (data.get("pi_wallet_address") or "").strip()
    pi_handle = (data.get("pi_handle") or "").strip()
    colorway = (data.get("colorway") or "cw-blue").strip()

    if not reply_to_email or "@" not in reply_to_email:
        tok = get_bearer_token_from_request()
        return render_template("merchant_items.html", setup_mode=True, m=None, items=[],
                               app_base=APP_BASE_URL, t=tok, share_base=BASE_ORIGIN,
                               username=u["pi_username"], colorway=colorway,
                               error="Enter a valid merchant email address.")
    if not (len(pi_wallet_address) == 56 and pi_wallet_address.startswith("G")):
        tok = get_bearer_token_from_request()
        return render_template("merchant_items.html", setup_mode=True, m=None, items=[],
                               app_base=APP_BASE_URL, t=tok, share_base=BASE_ORIGIN,
                               username=u["pi_username"], colorway=colorway,
                               error="Enter a valid Pi Wallet public key (56 chars, starts with 'G').")

    with conn() as cx:
        exists = cx.execute("SELECT 1 FROM merchants WHERE slug=?", (slug,)).fetchone()
        if exists:
            tok = get_bearer_token_from_request()
            return render_template("merchant_items.html", setup_mode=True, m=None, items=[],
                                   app_base=APP_BASE_URL, t=tok, share_base=BASE_ORIGIN,
                                   username=u["pi_username"], colorway=colorway,
                                   error="Slug already taken.")
        cx.execute("""INSERT INTO merchants(owner_user_id, slug, business_name, logo_url,
                      theme_mode, reply_to_email, pi_wallet, pi_wallet_address, pi_handle, colorway)
                      VALUES(?,?,?,?,?,?,?,?,?,?)""",
                   (u["id"], slug, business_name, logo_url, theme_mode, reply_to_email,
                    "@deprecated", pi_wallet_address, pi_handle, colorway))
    tok = get_bearer_token_from_request()
    return redirect(f"/merchant/{slug}/items{('?t='+tok) if tok else ''}")

# NEW: allow merchant to edit settings (incl. colorway) after creation
@app.post("/merchant/<slug>/update")
def merchant_update(slug):
    u, m = require_merchant_owner(slug)
    if isinstance(u, Response): return u
    data = request.form
    fields = {
        "business_name": (data.get("business_name") or m["business_name"]).strip(),
        "logo_url": (data.get("logo_url") or m["logo_url"] or "").strip(),
        "theme_mode": data.get("theme_mode") or m["theme_mode"],
        "reply_to_email": (data.get("reply_to_email") or m["reply_to_email"] or "").strip(),
        "pi_handle": (data.get("pi_handle") or m["pi_handle"] or "").strip(),
        "pi_wallet_address": (data.get("pi_wallet_address") or m["pi_wallet_address"] or "").strip(),
        "colorway": (data.get("colorway") or m["colorway"] or "cw-blue").strip(),
    }
    with conn() as cx:
        cx.execute("""UPDATE merchants SET business_name=?, logo_url=?, theme_mode=?,
                      reply_to_email=?, pi_handle=?, pi_wallet_address=?, colorway=? WHERE id=?""",
                   (fields["business_name"], fields["logo_url"], fields["theme_mode"],
                    fields["reply_to_email"], fields["pi_handle"], fields["pi_wallet_address"],
                    fields["colorway"], m["id"]))
    tok = get_bearer_token_from_request()
    return redirect(f"/merchant/{slug}/items{('?t='+tok) if tok else ''}")

@app.get("/merchant/<slug>/items")
def merchant_items(slug):
    u, m = require_merchant_owner(slug)
    if isinstance(u, Response): return u
    with conn() as cx:
        items = cx.execute("SELECT * FROM items WHERE merchant_id=?", (m["id"],)).fetchall()
    return render_template("merchant_items.html", setup_mode=False, m=m, items=items,
                           app_base=APP_BASE_URL, t=get_bearer_token_from_request(),
                           share_base=BASE_ORIGIN, colorway=m["colorway"])

@app.post("/merchant/<slug>/items/new")
def merchant_new_item(slug):
    u, m = require_merchant_owner(slug)
    if isinstance(u, Response): return u
    data = request.form
    link_id = uuid.uuid4().hex[:8]
    with conn() as cx:
        cx.execute("""INSERT INTO items(merchant_id, link_id, title, sku, image_url, pi_price,
                      stock_qty, allow_backorder, active)
                      VALUES(?,?,?,?,?,?,?,?,1)""",
                   (m["id"], link_id, data.get("title"), data.get("sku"),
                    data.get("image_url"), float(data.get("pi_price", "0")),
                    int(data.get("stock_qty", "0")), int(bool(data.get("allow_backorder")))))
    tok = get_bearer_token_from_request()
    return redirect(f"/merchant/{slug}/items{('?t='+tok) if tok else ''}")

# ---- update & delete item endpoints ----
@app.post("/merchant/<slug>/items/update")
def merchant_update_item(slug):
    u, m = require_merchant_owner(slug)
    if isinstance(u, Response): return u
    data = request.form
    try:
        item_id = int(data.get("item_id"))
    except (TypeError, ValueError):
        abort(400)
    title = (data.get("title") or "").strip()
    sku = (data.get("sku") or "").strip()
    image_url = (data.get("image_url") or "").strip()
    try:
        pi_price = float(data.get("pi_price", "0").strip() or "0")
    except ValueError:
        pi_price = 0.0
    try:
        stock_qty = int(data.get("stock_qty", "0").strip() or "0")
    except ValueError:
        stock_qty = 0

    with conn() as cx:
        it = cx.execute("SELECT * FROM items WHERE id=? AND merchant_id=?", (item_id, m["id"])).fetchone()
        if not it: abort(404)
        cx.execute("""UPDATE items
                      SET title=?, sku=?, image_url=?, pi_price=?, stock_qty=?
                      WHERE id=? AND merchant_id=?""",
                   (title or it["title"], sku or it["sku"], image_url or it["image_url"],
                    pi_price if pi_price > 0 else it["pi_price"],
                    stock_qty if stock_qty >= 0 else it["stock_qty"],
                    item_id, m["id"]))
    tok = get_bearer_token_from_request()
    return redirect(f"/merchant/{slug}/items{('?t='+tok) if tok else ''}")

@app.post("/merchant/<slug>/items/delete")
def merchant_delete_item(slug):
    u, m = require_merchant_owner(slug)
    if isinstance(u, Response): return u
    try:
        item_id = int(request.form.get("item_id"))
    except (TypeError, ValueError):
        abort(400)
    with conn() as cx:
        it = cx.execute("SELECT * FROM items WHERE id=? AND merchant_id=?", (item_id, m["id"])).fetchone()
        if not it: abort(404)
        cx.execute("UPDATE items SET active=0 WHERE id=? AND merchant_id=?", (item_id, m["id"]))
    tok = get_bearer_token_from_request()
    return redirect(f"/merchant/{slug}/items{('?t='+tok) if tok else ''}")

@app.get("/merchant/<slug>/orders")
def merchant_orders(slug):
    u, m = require_merchant_owner(slug)
    if isinstance(u, Response): return u
    with conn() as cx:
        orders = cx.execute("""
          SELECT orders.*, items.title as item_title
          FROM orders JOIN items ON items.id=orders.item_id
          WHERE orders.merchant_id=?
          ORDER BY orders.id DESC
        """, (m["id"],)).fetchall()
    return render_template("merchant_orders.html", m=m, orders=orders, colorway=m["colorway"])

@app.post("/merchant/<slug>/orders/update")
def merchant_orders_update(slug):
    u, m = require_merchant_owner(slug)
    if isinstance(u, Response): return u
    order_id = int(request.form.get("order_id"))
    status = request.form.get("status")
    tracking_carrier = request.form.get("tracking_carrier")
    tracking_number = request.form.get("tracking_number")
    tracking_url = request.form.get("tracking_url")
    with conn() as cx:
        o = cx.execute("SELECT * FROM orders WHERE id=? AND merchant_id=?", (order_id, m["id"])).fetchone()
        if not o: abort(404)
        cx.execute("""UPDATE orders SET status=?, tracking_carrier=?, tracking_number=?,
                      tracking_url=? WHERE id=?""",
                   (status or o["status"], tracking_carrier, tracking_number, tracking_url, order_id))
    if (status or o["status"]) == "shipped" and o["buyer_email"]:
        body = f"<p>Your {m['business_name']} order has shipped.</p>"
        if tracking_number:
            link = tracking_url or "#"
            body += f"<p><strong>Tracking:</strong> {tracking_carrier} {tracking_number} — " \
                    f"<a href='{link}'>track package</a></p>"
        reply_to = (m["reply_to_email"] or "").strip() if m else None
        log(f"[mail] shipping update -> to={o['buyer_email']} reply_to={reply_to} order_id={order_id}")
        send_email(o["buyer_email"], f"Your {m['business_name']} order is on the way", body, reply_to=reply_to)
    tok = get_bearer_token_from_request()
    return redirect(f"/merchant/{slug}/orders{('?t='+tok) if tok else ''}")

# ----------------- STOREFRONT AUTH -----------------
@app.get("/store/<slug>/signin")
def store_signin(slug):
    m = resolve_merchant_by_slug(slug)
    if not m: abort(404)
    next_url = request.args.get("next") or f"/store/{slug}"
    return render_template("store_signin.html", app_base=APP_BASE_URL,
                           next_url=next_url, slug=slug, sandbox=PI_SANDBOX)

@app.post("/auth/exchange/store")
def auth_exchange_store():
    try:
        next_url = request.args.get("next") or "/"
        if request.is_json:
            data = request.get_json(silent=True) or {}
        else:
            payload = request.form.get("payload", "")
            try: data = json.loads(payload) if payload else {}
            except Exception: data = {}
        user = (data.get("user") or {})
        uid = user.get("uid") or user.get("id")
        username = user.get("username")
        token = data.get("accessToken")
        if not uid or not username or not token:
            return redirect(f"/signin?fresh=1")
        r = requests.get(f"{PI_API_BASE}/v2/me",
                         headers={"Authorization": f"Bearer {token}"}, timeout=10)
        if r.status_code != 200:
            return redirect(next_url)
        with conn() as cx:
            row = cx.execute("SELECT * FROM users WHERE pi_uid=?", (uid,)).fetchone()
            if not row:
                cx.execute("""INSERT INTO users(pi_uid, pi_username, role, created_at)
                              VALUES(?, ?, 'buyer', ?)""",
                           (uid, username, int(time.time())))
                row = cx.execute("SELECT * FROM users WHERE pi_uid=?", (uid,)).fetchone()
        try:
            session["user_id"] = row["id"]; session.permanent = True
        except Exception: pass
        tok = mint_login_token(row["id"])
        join = "&" if ("?" in next_url) else "?"
        return redirect(f"{next_url}{join}t={tok}")
    except Exception as e:
        log("auth_exchange_store error:", repr(e))
        return redirect("/signin?fresh=1")

# ----------------- STOREFRONT + CART + CHECKOUT -----------------
@app.get("/store/<slug>")
def storefront(slug):
    m = resolve_merchant_by_slug(slug)
    if not m: abort(404)
    u = current_user_row()
    if not u: return redirect(f"/store/{slug}/signin?next=/store/{slug}")
    tok = get_bearer_token_from_request()
    cid = request.args.get("cid")
    cid = get_or_create_cart(m["id"], cid)
    with conn() as cx:
        items = cx.execute(
            "SELECT * FROM items WHERE merchant_id=? AND active=1 ORDER BY id DESC",
            (m["id"],)
        ).fetchall()
        cnt = cx.execute(
            "SELECT COALESCE(SUM(qty),0) as n FROM cart_items WHERE cart_id=?",
            (cid,)
        ).fetchone()["n"]
    return render_template("store.html", m=m, items=items, cid=cid, cart_count=cnt,
                           app_base=APP_BASE_URL, username=u["pi_username"], t=tok,
                           colorway=m["colorway"])

@app.post("/store/<slug>/add")
def store_add(slug):
    m = resolve_merchant_by_slug(slug)
    if not m: abort(404)
    if not current_user_row():
        return redirect(f"/store/{slug}/signin?next=/store/{slug}")
    cid = request.args.get("cid") or request.form.get("cid")
    cid = get_or_create_cart(m["id"], cid)
    item_id = int(request.form.get("item_id"))
    qty = max(1, int(request.form.get("qty", "1")))
    with conn() as cx:
        it = cx.execute(
            "SELECT * FROM items WHERE id=? AND merchant_id=? AND active=1",
            (item_id, m["id"])
        ).fetchone()
        if not it: abort(400)
        cx.execute("INSERT INTO cart_items(cart_id, item_id, qty) VALUES(?,?,?)",
                   (cid, item_id, qty))
    tok = get_bearer_token_from_request()
    join = "&" if tok else ""
    return redirect(f"/store/{slug}?cid={cid}{(join + 't=' + tok) if tok else ''}")

@app.get("/cart/<cid>")
def cart_view(cid):
    u = current_user_row()
    if not u: return redirect("/signin?fresh=1")
    tok = get_bearer_token_from_request()
    with conn() as cx:
        cart = cx.execute("SELECT * FROM carts WHERE id=?", (cid,)).fetchone()
        if not cart: abort(404)
        m = cx.execute("SELECT * FROM merchants WHERE id=?", (cart["merchant_id"],)).fetchone()
        rows = cx.execute("""
          SELECT cart_items.id as cid, cart_items.qty, items.*
          FROM cart_items JOIN items ON items.id=cart_items.item_id
          WHERE cart_items.cart_id=?
        """, (cid,)).fetchall()
    total = sum(float(r["pi_price"]) * r["qty"] for r in rows)
    return render_template("cart.html", m=m, rows=rows, cid=cid, total=total,
                           app_base=APP_BASE_URL, t=tok, colorway=m["colorway"])

@app.post("/cart/<cid>/remove")
def cart_remove(cid):
    u = current_user_row()
    if not u: return redirect("/signin?fresh=1")
    with conn() as cx:
        cx.execute("DELETE FROM cart_items WHERE id=? AND cart_id=?",
                   (int(request.form.get("row_id")), cid))
    tok = get_bearer_token_from_request()
    return redirect(f"/cart/{cid}{('?t='+tok) if tok else ''}")

@app.get("/checkout/cart/<cid>")
def checkout_cart(cid):
    u = current_user_row()
    if not u: return redirect("/signin?fresh=1")
    tok = get_bearer_token_from_request()
    with conn() as cx:
        cart = cx.execute("SELECT * FROM carts WHERE id=?", (cid,)).fetchone()
        if not cart: abort(404)
        m = cx.execute("SELECT * FROM merchants WHERE id=?", (cart["merchant_id"],)).fetchone()
        rows = cx.execute("""
          SELECT cart_items.qty, items.*
          FROM cart_items JOIN items ON items.id=cart_items.item_id
          WHERE cart_items.cart_id=?
        """, (cid,)).fetchall()
    if not rows:
        return redirect(f"/store/{m['slug']}{('?t='+tok) if tok else ''}?cid={cid}")
    total = sum(float(r["pi_price"]) * r["qty"] for r in rows)
    sid = uuid.uuid4().hex
    with conn() as cx:
        cx.execute("""INSERT INTO sessions(id, merchant_id, item_id, qty, expected_pi, state, created_at)
                      VALUES(?,?,?,?,?,?,?)""",
                   (sid, m["id"], None, 1, float(total), "initiated", int(time.time())))
    i = {"business_name": m["business_name"], "title": "Cart total", "logo_url": m["logo_url"], "colorway": m["colorway"]}
    return render_template("checkout.html", sold_out=False, i=i, qty=1, session_id=sid,
                           expected_pi=total, app_base=APP_BASE_URL, cart_mode=True,
                           colorway=m["colorway"])

@app.get("/checkout/<link_id>")
def checkout(link_id):
    with conn() as cx:
        i = cx.execute("""
           SELECT items.*, merchants.business_name, merchants.logo_url, merchants.id as mid,
                  merchants.colorway AS colorway
           FROM items JOIN merchants ON merchants.id=items.merchant_id
           WHERE link_id=? AND active=1
        """, (link_id,)).fetchone()
    if not i: abort(404)
    qty = max(1, int(request.args.get("qty", "1")))
    if i["stock_qty"] <= 0 and not i["allow_backorder"]:
        return render_template("checkout.html", sold_out=True, i=i, colorway=i["colorway"])
    sid = uuid.uuid4().hex
    expected = float(i["pi_price"]) * qty
    with conn() as cx:
        cx.execute("""INSERT INTO sessions(id, merchant_id, item_id, qty, expected_pi, state,
                   created_at) VALUES(?,?,?,?,?,?,?)""",
                   (sid, i["mid"], i["id"], qty, expected, "initiated", int(time.time())))
    return render_template("checkout.html",
        sold_out=False, i=i, qty=qty, session_id=sid, expected_pi=expected, app_base=APP_BASE_URL,
        colorway=i["colorway"]
    )

# ----------------- PI PAYMENTS (approve/complete) -----------------
@app.post("/api/pi/approve")
def pi_approve():
    data = request.get_json(force=True)
    payment_id = data.get("paymentId")
    session_id = data.get("session_id")
    if not payment_id or not session_id:
        return {"ok": False, "error": "missing_params"}, 400
    with conn() as cx:
        s = cx.execute("SELECT * FROM sessions WHERE id=?", (session_id,)).fetchone()
    if not s: return {"ok": False, "error": "unknown_session"}, 400
    try:
        r = requests.post(f"{PI_API_BASE}/v2/payments/{payment_id}/approve",
                          headers=pi_headers(), json={})
        if r.status_code != 200:
            return {"ok": False, "error": "approve_failed", "status": r.status_code, "body": r.text}, 502
        # Store the payment id so we can later cancel it if it gets stuck
        try:
            with conn() as cx:
                cx.execute("UPDATE sessions SET pi_payment_id=? WHERE id=?", (payment_id, session_id))
        except Exception as e:
            log("pi_approve: could not store pi_payment_id:", repr(e))
        return {"ok": True}
    except Exception as e:
        log("pi_approve error:", repr(e))
        return {"ok": False, "error": "server_error"}, 500

@app.post("/api/pi/complete")
def pi_complete():
    data = request.get_json(force=True)
    payment_id = data.get("paymentId")
    session_id = data.get("session_id")
    txid       = data.get("txid") or ""
    buyer      = data.get("buyer") or {}
    shipping   = data.get("shipping") or {}
    if not payment_id or not session_id:
        return {"ok": False, "error": "missing_params"}, 400
    # (Re)store payment id for traceability
    try:
        with conn() as cx:
            cx.execute("UPDATE sessions SET pi_payment_id=? WHERE id=?", (payment_id, session_id))
    except Exception as e:
        log("pi_complete: store pi_payment_id failed:", repr(e))
    try:
        r = requests.post(f"{PI_API_BASE}/v2/payments/{payment_id}/complete",
                          headers=pi_headers(), json={"txid": txid})
        if r.status_code != 200:
            return {"ok": False, "error": "complete_failed", "status": r.status_code, "body": r.text}, 502
    except Exception as e:
        log("pi_complete call error:", repr(e))
        return {"ok": False, "error": "server_error"}, 500
    with conn() as cx:
        s = cx.execute("SELECT * FROM sessions WHERE id=?", (session_id,)).fetchone()
    if not s or s["state"] != "initiated":
        return {"ok": False, "error": "bad_session"}, 400
    expected_amt = float(Decimal(str(s["expected_pi"])).quantize(Decimal("0.0000001"), rounding=ROUND_HALF_UP))
    try:
        r = fetch_pi_payment(payment_id)
        if r.status_code == 200:
            pdata = r.json()
            paid_amt = float(pdata.get("amount", 0))
            if abs(paid_amt - expected_amt) > 1e-7 and not PI_SANDBOX:
                return {"ok": False, "error": "amount_mismatch"}, 400
        elif not PI_SANDBOX:
            return {"ok": False, "error": "fetch_payment_failed"}, 502
    except Exception as e:
        log("fetch_pi_payment error:", repr(e))
        if not PI_SANDBOX:
            return {"ok": False, "error": "payment_verify_error"}, 500

    return fulfill_session(s, txid, buyer, shipping)

# ---- Email notifications per order -----------------------------------------
def send_order_emails(order_id: int):
    """Send confirmation to buyer and notification to merchant for one order."""
    with conn() as cx:
        o = cx.execute("SELECT * FROM orders WHERE id=?", (order_id,)).fetchone()
        if not o:
            log("[mail] order not found -> id=", order_id)
            return
        i = cx.execute("SELECT * FROM items WHERE id=?", (o["item_id"],)).fetchone()
        m = cx.execute("SELECT * FROM merchants WHERE id=?", (o["merchant_id"],)).fetchone()

    merchant_email = (m["reply_to_email"] or "").strip() if m and m["reply_to_email"] else None
    merchant_name = m["business_name"] if m else "Your Merchant"

    if o["buyer_email"]:
        try:
            log(f"[mail] buyer order confirmation -> to={o['buyer_email']} reply_to={merchant_email} order_id={order_id}")
            ok = send_email(
                o["buyer_email"],
                f"Your order at {merchant_name} is confirmed",
                f"""
                    <h2>Thanks for your order!</h2>
                    <p><strong>Store:</strong> {merchant_name}</p>
                    <p><strong>Product:</strong> {(i['title'] if i else 'N/A')}</p>
                    <p><strong>Quantity:</strong> {o['qty']}</p>
                    <p><strong>Total Paid:</strong> {o['pi_amount']:.7f} π</p>
                    <p>You can check status later here:
                      <a href="{BASE_ORIGIN}/o/{o['buyer_token']}">{BASE_ORIGIN}/o/{o['buyer_token']}</a>
                    </p>
                """,
                reply_to=merchant_email
            )
            log("send_order_emails buyer ok?", ok)
        except Exception as e:
            log("buyer email fail (order_id=", order_id, "):", repr(e))

    if merchant_email:
        try:
            log(f"[mail] merchant new order notice -> to={merchant_email} order_id={order_id}")
            ok2 = send_email(
                merchant_email,
                f"New Pi order at {merchant_name} ({o['pi_amount']:.7f} π)",
                f"""
                    <h2>You received a new order</h2>
                    <p><strong>Product:</strong> {(i['title'] if i else 'N/A')}</p>
                    <p><strong>Qty:</strong> {o['qty']}</p>
                    <p><strong>Total:</strong> {o['pi_amount']:.7f} π
                       <small>(fee: {o['pi_fee']:.7f} π, net: {o['pi_merchant_net']:.7f} π)</small>
                    </p>
                    <p><strong>Buyer:</strong> {(o['buyer_name'] or '—')} ({o['buyer_email'] or '—'})</p>
                    <p>TX: {o['pi_tx_hash'] or '—'}</p>
                """
            )
            log("send_order_emails merchant ok?", ok2)
        except Exception as e:
            log("merchant email fail (order_id=", order_id, "):", repr(e))
# ---- End email notifications helper -----------------------------------------

def fulfill_session(s, tx_hash, buyer, shipping):
    with conn() as cx:
        m = cx.execute("SELECT * FROM merchants WHERE id=?", (s["merchant_id"],)).fetchone()
    amt = float(s["expected_pi"])
    gross, fee, net = split_amounts(amt)
    gross = float(gross); fee = float(fee); net = float(net)

    buyer_email = (buyer.get("email") or shipping.get("email") or None)
    buyer_name  = buyer.get("name") or shipping.get("name") or None

    if s["item_id"] is None:
        # CART checkout
        with conn() as cx:
            cart = cx.execute("SELECT c.* FROM carts c WHERE c.merchant_id=? ORDER BY created_at DESC LIMIT 1",
                              (m["id"],)).fetchone()
            rows = cx.execute("""
              SELECT cart_items.qty, items.*
              FROM cart_items JOIN items ON items.id=cart_items.item_id
              WHERE cart_items.cart_id=?
            """, (cart["id"],)).fetchall()
        with conn() as cx:
            for r in rows:
                line_gross = float(r["pi_price"]) * r["qty"]
                line_fee   = fee * (line_gross / amt) if amt > 0 else 0.0
                line_net   = line_gross - line_fee
                buyer_token = uuid.uuid4().hex
                if not r["allow_backorder"]:
                    cx.execute("UPDATE items SET stock_qty=? WHERE id=?", (max(0, r["stock_qty"] - r["qty"]), r["id"]))
                cur = cx.execute("""INSERT INTO orders(merchant_id,item_id,qty,buyer_email,buyer_name,
                             shipping_json,pi_amount,pi_fee,pi_merchant_net,pi_tx_hash,payout_status,
                             status,buyer_token)
                             VALUES(?,?,?,?,?,?,?,?,?,?, 'pending','paid',?)""",
                           (s["merchant_id"], r["id"], r["qty"], buyer_email,
                            buyer_name, json.dumps(shipping), float(line_gross), float(line_fee),
                            float(line_net), tx_hash, buyer_token))
                try:
                    log("fulfill_session -> send_order_emails (cart) id:", cur.lastrowid)
                    send_order_emails(cur.lastrowid)
                except Exception as e:
                    log("send_order_emails (cart) error:", repr(e))
            cx.execute("UPDATE sessions SET state='paid', pi_tx_hash=? WHERE id=?", (tx_hash, s["id"]))
            cx.execute("DELETE FROM cart_items WHERE cart_id=?", (cart["id"],))
    else:
        # SINGLE item checkout
        with conn() as cx:
            i = cx.execute("SELECT * FROM items WHERE id=?", (s["item_id"],)).fetchone()
            if i and not i["allow_backorder"]:
                cx.execute("UPDATE items SET stock_qty=? WHERE id=?", (max(0, i["stock_qty"] - s["qty"]), i["id"]))
            buyer_token = uuid.uuid4().hex
            cur = cx.execute("""INSERT INTO orders(merchant_id,item_id,qty,buyer_email,buyer_name,
                         shipping_json,pi_amount,pi_fee,pi_merchant_net,pi_tx_hash,payout_status,
                         status,buyer_token)
                         VALUES(?,?,?,?,?,?,?,?,?,?, 'pending','paid',?)""",
                       (s["merchant_id"], s["item_id"], s["qty"], buyer_email,
                        buyer_name, json.dumps(shipping), float(gross), float(fee),
                        float(net), tx_hash, buyer_token))
            try:
                log("fulfill_session -> send_order_emails (single) id:", cur.lastrowid)
                send_order_emails(cur.lastrowid)
            except Exception as e:
                log("send_order_emails (single) error:", repr(e))
            cx.execute("UPDATE sessions SET state='paid', pi_tx_hash=? WHERE id=?", (tx_hash, s["id"]))

    u = current_user_row()
    tok = ""
    if u:
        try: tok = mint_login_token(u["id"])
        except Exception: tok = ""
    join = "&" if tok else ""
    redirect_url = f"{BASE_ORIGIN}/store/{m['slug']}?success=1{join}{('t='+tok) if tok else ''}"
    return {"ok": True, "redirect_url": redirect_url}

# ----------------- IMAGE PROXY (resilient) -----------------
_TRANSPARENT_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAA"
    "AAC0lEQVR42mP8/x8AAwMCAO6dEpgAAAAASUVORK5CYII="
)

@app.get("/uimg")
def uimg():
    src = request.args.get("src", "").strip()
    if not src:
        return Response(_TRANSPARENT_PNG, headers={"Content-Type": "image/png", "Cache-Control": "public, max-age=86400"})
    try:
        u = urlparse(src)
    except Exception:
        return Response(_TRANSPARENT_PNG, headers={"Content-Type": "image/png", "Cache-Control": "public, max-age=86400"})
    if u.scheme != "https":
        return Response(_TRANSPARENT_PNG, headers={"Content-Type": "image/png", "Cache-Control": "public, max-age=86400"})
    try:
        r = requests.get(src, stream=True, timeout=10, headers={"User-Agent": "izzapay-image-proxy"})
        if r.status_code != 200:
            return Response(_TRANSPARENT_PNG, headers={"Content-Type": "image/png", "Cache-Control": "public, max-age=86400"})
        ctype = r.headers.get("Content-Type", "image/png")
        data = r.content
        return Response(data, headers={"Content-Type": ctype, "Cache-Control": "public, max-age=86400"})
    except Exception as e:
        log("uimg error:", repr(e))
        return Response(_TRANSPARENT_PNG, headers={"Content-Type": "image/png", "Cache-Control": "public, max-age=86400"})

# ----------------- POLICIES / VALIDATION -----------------
@app.get("/validation-key.txt")
def validation_key():
    return app.send_static_file("validation-key.txt")

@app.get("/privacy")
def privacy():
    return render_template("privacy.html")

@app.get("/terms")
def terms():
    return render_template("terms.html")

# ----------------- OPTIONAL BUYER STATUS -----------------
@app.get("/o/<token>")
def buyer_status(token):
    with conn() as cx:
        o = cx.execute("SELECT * FROM orders WHERE buyer_token=?", (token,)).fetchone()
    if not o: abort(404)
    with conn() as cx:
        i = cx.execute("SELECT * FROM items WHERE id=?", (o["item_id"],)).fetchone()
        m = cx.execute("SELECT * FROM merchants WHERE id=?", (o["merchant_id"],)).fetchone()
    return render_template("buyer_status.html", o=o, i=i, m=m, colorway=m["colorway"])

@app.get("/success")
def success():
    return render_template("success.html")

# ----------------- MAIN -----------------
if __name__ == "__main__":
    port = int(os.getenv("PORT", "5000"))
    app.run(host="0.0.0.0", port=port, debug=True)
