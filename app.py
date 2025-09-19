import os, json, uuid, time, hmac, base64, hashlib
from decimal import Decimal, ROUND_HALF_UP
from datetime import timedelta, datetime
from urllib.parse import urlparse
import shutil
import requests
import mimetypes
from io import BytesIO
from PIL import Image
from werkzeug.utils import secure_filename
from flask import (
    Flask, request, render_template, render_template_string,
    redirect, session, abort, Response, Blueprint, jsonify
)
from dotenv import load_dotenv
from emailer import send_email
from payments import split_amounts

# ---- DB bootstrap ------------------------------------------------------------
try:
    from db import init_db, conn, ensure_schema
except ImportError:
    from db import init_db, conn
    def ensure_schema():
        with conn() as cx:
            # merchants patches
            cols = {r["name"] for r in cx.execute("PRAGMA table_info(merchants)")}
            if "pi_wallet_address" not in cols:
                cx.execute("ALTER TABLE merchants ADD COLUMN pi_wallet_address TEXT")
            if "pi_handle" not in cols:
                cx.execute("ALTER TABLE merchants ADD COLUMN pi_handle TEXT")
            if "colorway" not in cols:
                cx.execute("ALTER TABLE merchants ADD COLUMN colorway TEXT")

            # carts & cart_items
            cx.execute("""
                CREATE TABLE IF NOT EXISTS carts(
                  id TEXT PRIMARY KEY,
                  merchant_id INTEGER NOT NULL,
                  created_at INTEGER NOT NULL
                )
            """)
            cx.execute("""
                CREATE TABLE IF NOT EXISTS cart_items(
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  cart_id TEXT NOT NULL,
                  item_id INTEGER NOT NULL,
                  qty INTEGER NOT NULL
                )
            """)
            # One-per-payment idempotency for memo-based grants (prevents duplicate +1s)
with conn() as cx:
    cx.execute("""
      CREATE TABLE IF NOT EXISTS crafting_credit_grants_payments(
        payment_id TEXT PRIMARY KEY,
        user_id    INTEGER NOT NULL,
        granted_at INTEGER NOT NULL
      )
    """)

# Create the “already-claimed” ledger once on boot (not inside other functions)
with conn() as cx:
    cx.execute("""
      CREATE TABLE IF NOT EXISTS crafting_credit_claims(
        order_id   INTEGER PRIMARY KEY,   -- 1 row per order, prevents duplicates
        user_id    INTEGER NOT NULL,
        claimed_at INTEGER NOT NULL
      )
    """)

# ----------------- ENV -----------------
load_dotenv()
PI_SANDBOX    = os.getenv("PI_SANDBOX", "false").lower() == "true"
PI_API_BASE   = os.getenv("PI_PLATFORM_API_URL", "https://api.minepi.com")
PI_API_KEY    = os.getenv("PI_PLATFORM_API_KEY", "")
APP_NAME      = os.getenv("APP_NAME", "IZZA PAY")
APP_BASE_URL  = os.getenv("APP_BASE_URL", "https://izzapay.onrender.com").rstrip("/")
BASE_ORIGIN   = APP_BASE_URL
DEFAULT_ADMIN_EMAIL = os.getenv("DEFAULT_ADMIN_EMAIL", "info@izzapay.shop")
LIBRE_EP      = os.getenv("LIBRE_EP", "https://izzatranslate.onrender.com").rstrip("/")

# ⚠️ Single-use crafting credit identifier.
# This MUST equal the product’s items.link_id (the bit in /checkout/<link_id>)
SINGLE_CREDIT_LINK_ID = "d0b811e8"

try:
    PI_USD_RATE = float(os.getenv("PI_USD_RATE", "0").strip())
except Exception:
    PI_USD_RATE = 0.0

# ----------------- APP -----------------
app = Flask(__name__)

# ----------------- PERSISTENT DATA ROOT -----------------
DATA_ROOT   = os.getenv("DATA_ROOT", "/var/data/izzapay")
os.makedirs(DATA_ROOT, exist_ok=True)
UPLOAD_DIR  = os.path.join(DATA_ROOT, "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)
MEDIA_PREFIX = "/media"

app.config["MAX_CONTENT_LENGTH"] = 10 * 1024 * 1024  # 10 MB
ALLOWED_EXTENSIONS = {"png", "jpg", "jpeg", "gif", "webp"}

def _normalize_ext(fmt: str) -> str:
    if not fmt: return ""
    fmt = fmt.lower()
    return "jpg" if fmt == "jpeg" else fmt

# ---- Simple SQLite snapshot backups on boot ----
def _detect_db_file() -> str | None:
    try:
        with conn() as cx:
            info = cx.execute("PRAGMA database_list").fetchone()
            return (info["file"] if info and "file" in info.keys() else None) or None
    except Exception:
        return None

def _backup_now(db_path: str, backups_dir: str) -> str | None:
    try:
        os.makedirs(backups_dir, exist_ok=True)
        ts = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
        dest = os.path.join(backups_dir, f"app-{ts}.sqlite")
        shutil.copy2(db_path, dest)
        return dest
    except Exception:
        return None

def _prune_old_backups(backups_dir: str, keep: int = 10):
    try:
        files = [f for f in os.listdir(backups_dir) if f.endswith(".sqlite")]
        files.sort(reverse=True)
        for f in files[keep:]:
            try: os.remove(os.path.join(backups_dir, f))
            except Exception: pass
    except Exception:
        pass

def setup_backups():
    backups_dir = os.path.join(os.getenv("DATA_ROOT", "/var/data/izzapay"), "backups")
    db_path = _detect_db_file()
    if db_path and os.path.exists(db_path):
        _backup_now(db_path, backups_dir)
        _prune_old_backups(backups_dir, keep=10)

# ----------------- BLUEPRINTS & HELPERS -----------------
crafting_api = Blueprint("crafting_api", __name__, url_prefix="/api/crafting")
merchant_api = Blueprint("merchant_api", __name__, url_prefix="/api/merchant")

def _ok(**kw):
    out = {"ok": True}; out.update(kw); return jsonify(out)
def _err(reason="unknown"):
    return jsonify({"ok": False, "reason": str(reason)}), 400

# === Crafting grant hook (separate concern, no schema creation here) ============
def _grant_crafting_item(to_user_id: int | None, crafted_id: str | None, qty: int):
    if not (to_user_id and crafted_id and qty > 0):
        return
    try:
        with conn() as cx:
            cx.execute("""
                CREATE TABLE IF NOT EXISTS crafting_grants(
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  user_id INTEGER NOT NULL,
                  crafted_item_id TEXT NOT NULL,
                  qty INTEGER NOT NULL,
                  created_at INTEGER NOT NULL
                )
            """)
            cx.execute(
                "INSERT INTO crafting_grants(user_id, crafted_item_id, qty, created_at) VALUES(?,?,?,?)",
                (to_user_id, str(crafted_id), int(qty), int(time.time()))
            )
    except Exception:
        pass

import json, urllib.request

SINGLE_CREDIT_LINK_ID = "d0b811e8"  # your existing constant

def _is_single_mint_item(it: dict) -> bool:
    if not it: return False
    if str(it.get("link_id", "")) == SINGLE_CREDIT_LINK_ID:  # your checkout link
        return True
    sku = (it.get("sku") or "").strip().upper()
    if sku == "IC1":
        return True
    cid = (it.get("crafted_item_id") or "").strip().lower()
    if cid in ("ic:1", "ic1"):
        return True
    return False

def _grant_game_mint_credit(username: str, amount: int, order_id: int) -> bool:
    if not (username and amount > 0):
        return False
    try:
        # same host, mounted game app
        url = (request.url_root.rstrip("/") + "/izza-game/api/crafting/credits/grant")
        payload = json.dumps({
            "username": username.lstrip("@"),
            "amount": int(amount),
            "order_id": int(order_id)
        }).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=payload,
            headers={"content-type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            j = json.loads(resp.read().decode() or "{}")
            return bool(j.get("ok"))
    except Exception:
        return False

# --------------------------- CRAFTING ROUTES ------------------------------------
@crafting_api.post("/ic/debit")
def crafting_ic_debit():
    u = current_user_row()
    if not u: return _err("auth_required")
    data = request.get_json(silent=True) or {}
    try: amt = int(data.get("amount") or 0)
    except Exception: amt = 0
    if amt <= 0: return _err("bad_amount")
    newbal = add_ic_credits(int(u["id"]), -amt)
    return _ok(debited=True, amount=amt, balance=newbal)

@crafting_api.get("/credits")
def crafting_ic_balance():
    u = current_user_row()
    if not u: return _ok(balance=0, credits=0)
    bal = get_ic_credits(int(u["id"]))
    return _ok(balance=bal, credits=bal)

@crafting_api.post("/credits/reconcile")
def crafting_ic_reconcile():
    u = current_user_row()
    if not u: return _err("auth_required")
    uid = int(u["id"])
    with conn() as cx:
        rows = cx.execute("""
            SELECT o.id, o.qty
            FROM orders o
            JOIN items i ON i.id = o.item_id
            WHERE o.buyer_user_id = ?
              AND o.status = 'paid'
              AND i.link_id = ?
              AND NOT EXISTS (
                SELECT 1 FROM crafting_credit_claims c WHERE c.order_id = o.id
              )
        """, (uid, SINGLE_CREDIT_LINK_ID)).fetchall()

        total_new = sum(int(r["qty"] or 0) for r in rows)
        if total_new > 0:
            newbal = add_ic_credits(uid, total_new)
            now = int(time.time())
            for r in rows:
                cx.execute(
                    "INSERT INTO crafting_credit_claims(order_id, user_id, claimed_at) VALUES(?,?,?)",
                    (int(r["id"]), uid, now)
                )
        else:
            newbal = get_ic_credits(uid)
    return _ok(reconciled=True, awarded=(total_new if rows else 0), credits=newbal)

@crafting_api.post("/credits/claim_order")
def crafting_ic_claim_order():
    u = current_user_row()
    if not u: return _err("auth_required")
    data = request.get_json(silent=True) or {}
    try: oid = int(data.get("order_id") or 0)
    except Exception: oid = 0
    if oid <= 0: return _err("bad_id")

    uid = int(u["id"])
    with conn() as cx:
        r = cx.execute("""
            SELECT o.id, o.qty
            FROM orders o
            JOIN items i ON i.id = o.item_id
            WHERE o.id = ? AND o.buyer_user_id = ? AND o.status='paid' AND i.link_id = ?
        """, (oid, uid, SINGLE_CREDIT_LINK_ID)).fetchone()

        if not r: return _err("not_eligible")

        dup = cx.execute("SELECT 1 FROM crafting_credit_claims WHERE order_id=?", (oid,)).fetchone()
        if dup:
            bal = get_ic_credits(uid)
            return _ok(already=True, credits=bal)

        qty = int(r["qty"] or 1)
        newbal = add_ic_credits(uid, qty)
        cx.execute(
            "INSERT INTO crafting_credit_claims(order_id, user_id, claimed_at) VALUES(?,?,?)",
            (oid, uid, int(time.time()))
        )
    return _ok(awarded=True, amount=qty, credits=newbal)

# --------------------------- MERCHANT ROUTES ------------------------------------
@merchant_api.post("/create_product_from_craft")
def create_product_from_craft():
    """
    Accepts { name, image?, price_pi?, description?, crafted_item_id? }
    Saves to session and redirects merchant to setup/items with prefill.
    """
    u = current_user_row()
    if not u:
        return jsonify(ok=False, reason="auth_required"), 401

    data = request.get_json(silent=True) or {}
    prefill = {
        "title": (data.get("name") or "Crafted Item"),
        "image_url": (data.get("image") or ""),
        "pi_price": float(data.get("price_pi") or 0) or 0.0,
        "description": (data.get("description") or "Minted from Crafting UI"),
        "crafted_item_id": (data.get("crafted_item_id") or ""),
        "fulfillment_kind": "crafting"  # lets dashboard set the crafted link
    }
    try:
        session["prefill_product"] = prefill
    except Exception:
        pass

    # If they already have a store, going to /dashboard will bounce into /merchant/<slug>/items
    return jsonify(ok=True, dashboardUrl="/merchant/setup?prefill=1")


# --------------------------- REGISTER BLUEPRINTS --------------------------------
try:
    app.register_blueprint(crafting_api)
except Exception:
    # already registered
    pass

try:
    app.register_blueprint(merchant_api)
except Exception:
    pass
    
@app.get("/api/collectibles")
def collectibles_list():
    u = current_user_row()
    if not u:
        return _ok(items=[])
    with conn() as cx:
        rows = cx.execute("""
            SELECT
              o.id            AS order_id,
              o.qty           AS qty,
              i.title         AS title,
              i.image_url     AS image_url,
              i.crafted_item_id AS crafted_item_id,
              i.fulfillment_kind AS fulfillment_kind,
              m.business_name AS store,
              m.slug          AS mslug,
              (SELECT 1 FROM collectible_claims c
                 WHERE c.order_id=o.id AND c.user_id=?
              ) AS claimed
            FROM orders o
            JOIN items i   ON i.id = o.item_id
            JOIN merchants m ON m.id = o.merchant_id
            WHERE o.status='paid'
              AND o.buyer_user_id = ?
              AND i.fulfillment_kind = 'crafting'
              AND i.crafted_item_id IS NOT NULL
            ORDER BY o.id DESC
        """, (u["id"], u["id"])).fetchall()
    out = []
    for r in rows:
        out.append({
            "id": int(r["order_id"]),
            "title": r["title"],
            "store": r["store"],
            "thumb_url": r["image_url"] or "",
            "crafted_item_id": r["crafted_item_id"],
            "claimed": bool(r["claimed"])
        })
    return _ok(items=out)

@app.post("/api/collectibles/claim")
def collectibles_claim():
    u = current_user_row()
    if not u:
        return _err("auth_required")
    data = request.get_json(silent=True) or {}
    try:
        oid = int(data.get("id") or 0)
    except Exception:
        oid = 0
    if oid <= 0:
        return _err("bad_id")

    with conn() as cx:
        r = cx.execute("""
            SELECT o.id AS oid, o.qty AS qty, o.buyer_user_id AS buyer_uid,
                   i.crafted_item_id AS crafted_id
            FROM orders o
            JOIN items i ON i.id=o.item_id
            WHERE o.id=? AND o.status='paid'
              AND i.fulfillment_kind='crafting'
              AND i.crafted_item_id IS NOT NULL
        """, (oid,)).fetchone()
        if not r:
            return _err("not_found")
        if int(r["buyer_uid"] or 0) != int(u["id"]):
            return _err("forbidden")

        # idempotent: if already claimed, just return ok
        dup = cx.execute("SELECT 1 FROM collectible_claims WHERE order_id=? AND user_id=?", (oid, u["id"])).fetchone()
        if not dup:
            cx.execute(
                "INSERT INTO collectible_claims(order_id, user_id, claimed_at) VALUES(?,?,?)",
                (oid, u["id"], int(time.time()))
            )
            # Grant into game (your existing safe stub)
            try:
                _grant_crafting_item(u["id"], r["crafted_id"], int(r["qty"] or 1))
            except Exception:
                pass

    return _ok(granted={
        "order_id": oid,
        "crafted_item_id": r["crafted_id"],
        "qty": int(r["qty"] or 1)
    })
# ================== /Crafting UI â Flask bridge ==================
@app.get(f"{MEDIA_PREFIX}/<path:filename>")
def media(filename):
    """
    Read-only serving of files saved in UPLOAD_DIR.
    Uses long cache because filenames are content-hashed.
    """
    # Tiny transparent 1x1 PNG for fallbacks
    _tiny = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAA"
        "AAC0lEQVR42mP8/x8AAwMCAO6dEpgAAAAASUVORK5CYII="
    )
    try:
        safe_base = os.path.abspath(UPLOAD_DIR)
        safe_path = os.path.abspath(os.path.normpath(os.path.join(safe_base, filename)))
        if not safe_path.startswith(safe_base) or not os.path.exists(safe_path):
            return Response(_tiny, headers={"Content-Type": "image/png", "Cache-Control": "public, max-age=86400"})
        ctype = mimetypes.guess_type(safe_path)[0] or "application/octet-stream"
        with open(safe_path, "rb") as f:
            data = f.read()
        return Response(
            data,
            headers={
                "Content-Type": ctype,
                "Cache-Control": "public, max-age=31536000, immutable"
            }
        )
    except Exception:
        return Response(_tiny, headers={"Content-Type": "image/png", "Cache-Control": "public, max-age=86400"})

# Sessions / cookies
_secret = os.getenv("FLASK_SECRET") or os.urandom(32)
app.secret_key = _secret
app.config.update(
    SESSION_COOKIE_NAME="izzapay_session",
    SESSION_COOKIE_SAMESITE="None",
    SESSION_COOKIE_SECURE=True,
    SESSION_COOKIE_HTTPONLY=True,
    PERMANENT_SESSION_LIFETIME=timedelta(days=7),
)

@app.context_processor
def inject_globals():
    return {
        "APP_BASE_URL": APP_BASE_URL,
        "BASE_ORIGIN": BASE_ORIGIN,
        "PI_SANDBOX": PI_SANDBOX,
        "PI_USD_RATE": PI_USD_RATE,
        "MEDIA_PREFIX": MEDIA_PREFIX,  # handy in templates if you ever need it
    }
# -------- Auto-translate injector (global) --------
I18N_SNIPPET = r"""
<script>
if(!window.__IZZA_I18N_BOOTED__){
  window.__IZZA_I18N_BOOTED__=true;

  // Same-origin proxy Ã¢ÂÂ main app serves /api/translate
  window.TRANSLATE_TEXT = async (text, from, to) => {
    try {
      const r = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, from, to })
      });
      const j = await r.json();
      return (j && j.ok && typeof j.text === 'string') ? j.text : text;
    } catch {
      return text;
    }
  };

  (function(){
    const LANG_KEY='izzaLang';

    // >>> ONLY RUN IF USER PICKED A LANGUAGE <<<
    const raw = localStorage.getItem(LANG_KEY);
    if (!raw) return; // user hasn't chosen Ã¢ÂÂ do nothing

    const to   = String(raw).slice(0,5);
    const from = (document.documentElement.getAttribute('lang')||'en').slice(0,5);
    if (!to || to === from) return; // nothing to translate Ã¢ÂÂ do nothing

    if (typeof window.TRANSLATE_TEXT!=='function'){ window.TRANSLATE_TEXT=async t=>t; }

    // Elements to always skip
    const SKIP_TAGS=new Set(['SCRIPT','STYLE','NOSCRIPT','CODE','PRE','TEXTAREA','INPUT','SELECT','OPTION']);

    // --- Sensitive text detectors (avoid touching keys / hashes) ---
    function isLikelyStellarPubKey(s){
      const t=s.replace(/\s+/g,'').trim();
      return /^G[A-Z2-7]{55}$/.test(t);
    }
    function isLongBase32ish(s){
      const t=s.replace(/\s+/g,'').trim();
      return /^[A-Z0-9]{30,}$/.test(t);
    }
    function isLongHexHash(s){
      const t=s.replace(/\s+/g,'').trim();
      return /^[a-fA-F0-9]{40,}$/.test(t);
    }
    function isSensitiveText(s){
      if(!s || s.length<10) return false;
      return isLikelyStellarPubKey(s) || isLongBase32ish(s) || isLongHexHash(s);
    }

    function collect(root){
      const nodes=[];
      const w=document.createTreeWalker(
        root,
        NodeFilter.SHOW_TEXT,
        { acceptNode(n){
            const p=n.parentElement;
            if(!p) return NodeFilter.FILTER_REJECT;
            if(SKIP_TAGS.has(p.tagName)) return NodeFilter.FILTER_REJECT;
            if(p.closest('[data-no-i18n="1"]')) return NodeFilter.FILTER_REJECT;

            const s=n.nodeValue;
            if(!s || !s.trim()) return NodeFilter.FILTER_REJECT;

            if(isSensitiveText(s)) return NodeFilter.FILTER_REJECT;

            return NodeFilter.FILTER_ACCEPT;
          }
        }
      );
      let n; while((n=w.nextNode())) nodes.push(n);
      return nodes;
    }

    async function translate(nodes){
      for(const n of nodes){
        try{
          const p=n.parentElement;
          if(!p || p.closest('[data-no-i18n="1"]')) continue;
          if(isSensitiveText(n.nodeValue)) continue;

          const orig=(p?.dataset?.i18nOriginal) ?? n.nodeValue;
          const out=await window.TRANSLATE_TEXT(orig,from,to);
          if(p && p.dataset && !p.dataset.i18nOriginal) p.dataset.i18nOriginal=orig;
          if(typeof out==='string' && out && out!==n.nodeValue) n.nodeValue=out;
        }catch{}
      }
    }

    async function run(){ await translate(collect(document.body)); }

    const mo=new MutationObserver(muts=>{
      const batch=[];
      for(const m of muts){
        if(m.type==='childList'){
          m.addedNodes && m.addedNodes.forEach(nd=>{
            if(nd.nodeType===1) batch.push(...collect(nd));
            else if(nd.nodeType===3) batch.push(nd);
          });
        } else if(m.type==='characterData' && m.target && m.target.nodeType===3){
          batch.push(m.target);
        }
      }
      if(batch.length) translate(batch);
    });

    function arm(){ try{ mo.observe(document.body,{childList:true,characterData:true,subtree:true}); }catch{} }

    if(document.readyState==='loading'){
      document.addEventListener('DOMContentLoaded',()=>{ run(); arm(); },{once:true});
    } else { run(); arm(); }
  })();
}
</script>
"""
@app.after_request
def _inject_i18n(resp):
    try:
        ctype = resp.headers.get("Content-Type", "")
        if resp.status_code == 200 and "text/html" in ctype:
            body = resp.get_data(as_text=True)
            # allow page-level opt-out via data-no-global-i18n="1"
            if 'data-no-global-i18n="1"' not in body and "__IZZA_I18N_BOOTED__" not in body:
                i = body.lower().rfind("</body>")
                if i != -1:
                    body = body[:i] + I18N_SNIPPET + body[i:]
                    resp.set_data(body)
                    try:
                        resp.headers["Content-Length"] = str(len(body.encode("utf-8")))
                    except Exception:
                        pass
    except Exception:
        pass
    return resp
# -------- /Auto-translate injector --------
# --- Admin ENV ---
ADMIN_PI_USERNAME = (os.getenv("ADMIN_PI_USERNAME") or "").lstrip("@").strip()
ADMIN_PI_WALLET   = (os.getenv("ADMIN_PI_WALLET") or "").strip()

def is_admin_name(username: str) -> bool:
    if not username: return False
    return username.lstrip("@").strip().lower() == ADMIN_PI_USERNAME.lower()

def require_admin():
    urow = current_user_row()
    if not urow:
        return redirect("/signin?fresh=1")

    # sqlite3.Row must be accessed like a dict (no .get)
    try:
        role = urow["role"]
    except Exception:
        role = None
    try:
        uname = urow["pi_username"]
    except Exception:
        uname = None

    if (role in ("admin", "owner")) or is_admin_name(uname):
        return urow  # return the original Row for downstream code
    abort(403)      # Block non-admins

# ----------------- DB & SCHEMA -----------------
init_db()
setup_backups()
ensure_schema()

# --- Users & merchants table patches ---
with conn() as cx:
    # users table patch for in-game credits
    u_cols = {r["name"] for r in cx.execute("PRAGMA table_info(users)")}
    if "ic_credits" not in u_cols:
        cx.execute("ALTER TABLE users ADD COLUMN ic_credits INTEGER DEFAULT 0")

    # merchants patches
    m_cols = {r["name"] for r in cx.execute("PRAGMA table_info(merchants)")}
    if "pi_wallet_address" not in m_cols:
        cx.execute("ALTER TABLE merchants ADD COLUMN pi_wallet_address TEXT")
    if "pi_handle" not in m_cols:
        cx.execute("ALTER TABLE merchants ADD COLUMN pi_handle TEXT")
    if "colorway" not in m_cols:
        cx.execute("ALTER TABLE merchants ADD COLUMN colorway TEXT")
        

# --- Carts & cart_items must ALWAYS exist (not gated on colorway) ---
with conn() as cx:
    cx.execute("""
        CREATE TABLE IF NOT EXISTS carts(
          id TEXT PRIMARY KEY,
          merchant_id INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        )
    """)
    cx.execute("""
        CREATE TABLE IF NOT EXISTS cart_items(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          cart_id TEXT NOT NULL,
          item_id INTEGER NOT NULL,
          qty INTEGER NOT NULL
        )
    """)
def _ensure_credit_codes(cx):
    cx.executescript("""
    CREATE TABLE IF NOT EXISTS mint_codes(
      code TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      used_at TIMESTAMP
    );
    """)
    # Uses your schema: (code TEXT PK, user_id INT, used INT, created_at, used_at)
import secrets, time

def _new_mint_code(cx, user_id:int=0) -> str:
    _ensure_credit_codes(cx)
    # 12 easy chars: IZZA-XXXX-XXXX
    while True:
        raw = secrets.token_hex(5).upper()    # 10 hex chars
        code = "IZZA-" + raw[:4] + "-" + raw[4:8]
        try:
            cx.execute("INSERT INTO mint_codes(code, user_id) VALUES(?,?)",
                       (code, int(user_id or 0)))
            return code
        except Exception:
            # rare collision → retry
            continue

def _consume_mint_code(cx, code:str, claimer_user_id:int=0):
    _ensure_credit_codes(cx)
    code = (code or "").strip().upper()
    row = cx.execute("SELECT code, used FROM mint_codes WHERE code=?", (code,)).fetchone()
    if not row:
        return {"ok": False, "reason": "invalid"}
    if int(row["used"] or 0) == 1:
        return {"ok": False, "reason": "used"}

    cx.execute("UPDATE mint_codes SET used=1, used_at=CURRENT_TIMESTAMP WHERE code=?", (code,))

    # Track that we granted a mint credit for this code (idempotent)
    cx.execute("""
      CREATE TABLE IF NOT EXISTS crafting_credit_grants_codes(
        code TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        granted_at INTEGER NOT NULL
      )
    """)
    cx.execute("INSERT OR IGNORE INTO crafting_credit_grants_codes(code, user_id, granted_at) VALUES(?,?,?)",
               (code, int(claimer_user_id or 0), int(time.time())))
    return {"ok": True}
with conn() as cx:
    # items table patches for crafted linkage & description
    it_cols = {r["name"] for r in cx.execute("PRAGMA table_info(items)")}
    if "description" not in it_cols:
        cx.execute("ALTER TABLE items ADD COLUMN description TEXT")
    if "fulfillment_kind" not in it_cols:
        # 'physical' (default) | 'crafting'
        cx.execute("ALTER TABLE items ADD COLUMN fulfillment_kind TEXT DEFAULT 'physical'")
    if "crafted_item_id" not in it_cols:
        # opaque string from Crafting Land (id/slug/uuid)
        cx.execute("ALTER TABLE items ADD COLUMN crafted_item_id TEXT")

    # sessions table patches (ALWAYS run; do NOT nest under crafted_item_id)
    scols = {r["name"] for r in cx.execute("PRAGMA table_info(sessions)")}
    if "pi_payment_id" not in scols:
        cx.execute("ALTER TABLE sessions ADD COLUMN pi_payment_id TEXT")
    if "cart_id" not in scols:
        cx.execute("ALTER TABLE sessions ADD COLUMN cart_id TEXT")
    if "line_items_json" not in scols:
        cx.execute("ALTER TABLE sessions ADD COLUMN line_items_json TEXT")
    if "user_id" not in scols:
        cx.execute("ALTER TABLE sessions ADD COLUMN user_id INTEGER")

    # orders table patches
    ocols = {r["name"] for r in cx.execute("PRAGMA table_info(orders)")}
    if "buyer_user_id" not in ocols:
        cx.execute("ALTER TABLE orders ADD COLUMN buyer_user_id INTEGER")

    # payout_requests throttle log (one row per request)
    cx.execute("""
        CREATE TABLE IF NOT EXISTS payout_requests(
          id INTEGER PRIMARY KEY,
          merchant_id INTEGER NOT NULL,
          requested_at INTEGER NOT NULL,
          FOREIGN KEY(merchant_id) REFERENCES merchants(id)
        )
    """)
    cx.execute("CREATE INDEX IF NOT EXISTS idx_payout_requests_merchant_time ON payout_requests(merchant_id, requested_at)")

ensure_schema()
with conn() as cx:
    cx.execute("""
        CREATE TABLE IF NOT EXISTS crafted_items(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          name TEXT NOT NULL,
          sku TEXT,
          image TEXT,
          meta_json TEXT,
          created_at INTEGER NOT NULL
        )
    """)
    cx.execute("CREATE INDEX IF NOT EXISTS idx_crafted_items_user ON crafted_items(user_id)")
# Detect if orders.created_at exists (for 30-day filters)
with conn() as cx:
    _ORDERS_COLS = {r["name"] for r in cx.execute("PRAGMA table_info(orders)")}
HAS_ORDER_CREATED_AT = ("created_at" in _ORDERS_COLS)

# ----------------- SHORT-LIVED BEARER TOKENS -----------------
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
def get_ic_credits(user_id: int) -> int:
    try:
        with conn() as cx:
            row = cx.execute("SELECT ic_credits FROM users WHERE id=?", (user_id,)).fetchone()
            return int(row["ic_credits"] or 0) if row else 0
    except Exception:
        return 0

def add_ic_credits(user_id: int, delta: int) -> int:
    """Atomically add (or subtract) credits. Clamps at 0. Returns new balance."""
    if not user_id or not isinstance(delta, int):
        return 0
    with conn() as cx:
        row = cx.execute("SELECT ic_credits FROM users WHERE id=?", (user_id,)).fetchone()
        cur = int((row["ic_credits"] if row else 0) or 0)
        new = max(0, cur + int(delta))
        cx.execute("UPDATE users SET ic_credits=? WHERE id=?", (new, user_id))
    return new

def _new_mint_code(cx, user_id:int) -> str:
    import secrets, time, sqlite3
    _ensure_credit_codes(cx)  # your existing table creator
    while True:
        # Format like IZZA-AB12-CD34-EF56 (feel free to tweak)
        code = "IZZA-" + secrets.token_hex(2).upper() + "-" + secrets.token_hex(2).upper() + "-" + secrets.token_hex(2).upper()
        try:
            cx.execute(
                "INSERT INTO mint_codes(code, user_id, used, created_at) VALUES(?,?,0,?)",
                (code, int(user_id or 0), int(time.time()))
            )
            return code
        except sqlite3.IntegrityError:
            continue  # regenerate on rare collision

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

from flask import jsonify, send_file

@app.get("/admin/export.json")
def admin_export_json():
    u = require_admin()
    if isinstance(u, Response): return u
    with conn() as cx:
        users     = [dict(r) for r in cx.execute("SELECT * FROM users").fetchall()]
        merchants = [dict(r) for r in cx.execute("SELECT * FROM merchants").fetchall()]
        items     = [dict(r) for r in cx.execute("SELECT * FROM items").fetchall()]
        orders    = [dict(r) for r in cx.execute("SELECT * FROM orders").fetchall()]
    payload = {
        "exported_at": int(time.time()),
        "users": users,
        "merchants": merchants,
        "items": items,
        "orders": orders,
        "version": 1
    }
    # Force download
    return Response(
        json.dumps(payload, separators=(",", ":")),
        headers={
            "Content-Type": "application/json",
            "Content-Disposition": "attachment; filename=izzapay-export.json"
        }
    )

@app.post("/admin/backup/db")
def admin_backup_now():
    u = require_admin()
    if isinstance(u, Response): return u
    backups_dir = os.path.join(os.getenv("DATA_ROOT", "/var/data/izzapay"), "backups")
    db_path = _detect_db_file()
    if not (db_path and os.path.exists(db_path)):
        return {"ok": False, "error": "db_not_found"}, 404
    snap = _backup_now(db_path, backups_dir)
    if not snap:
        return {"ok": False, "error": "backup_failed"}, 500
    _prune_old_backups(backups_dir, keep=10)
    # Return a link to fetch raw file (local file send)
    return {"ok": True, "snapshot": os.path.basename(snap)}

@app.get("/admin/backup/download/<name>")
def admin_backup_download(name):
    u = require_admin()
    if isinstance(u, Response): return u
    backups_dir = os.path.join(os.getenv("DATA_ROOT", "/var/data/izzapay"), "backups")
    safe = os.path.abspath(os.path.join(backups_dir, name))
    if not safe.startswith(os.path.abspath(backups_dir)) or not os.path.exists(safe):
        abort(404)
    return send_file(safe, as_attachment=True, download_name=name, mimetype="application/octet-stream")

# ----------------- EXPLORE -----------------
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
    except Exception:
        return {"ok": False, "error": "server_error"}, 500
# --- Clear/cancel any pending Pi payment for this app/session ---
@app.post("/api/pi/clear_pending")
def pi_clear_pending():
    """
    Input (JSON or form):
      - session_id: your sessions.id (recommended), OR
      - payment_id: explicit Pi payment id (fallback)
    Behavior:
      - If we know a payment id, try Pi /v2/payments/:id/cancel (best effort).
      - Regardless of upstream result, clear our local 'sessions' row (pi_payment_id NULL, state 'initiated').
    """
    try:
        data = request.get_json(silent=True) or request.form or {}
        session_id = (data.get("session_id") or "").strip()
        explicit_pid = (data.get("payment_id") or "").strip()

        pay_id = None
        if session_id:
            with conn() as cx:
                s = cx.execute("SELECT id, pi_payment_id FROM sessions WHERE id=?", (session_id,)).fetchone()
            if s and s["pi_payment_id"]:
                pay_id = s["pi_payment_id"]

        if not pay_id and explicit_pid:
            pay_id = explicit_pid

        # Best-effort cancel at Pi platform
        if pay_id:
            try:
                r = requests.post(f"{PI_API_BASE}/v2/payments/{pay_id}/cancel",
                                  headers=pi_headers(), json={}, timeout=12)
                # ignore non-200; we still clear locally
            except Exception:
                pass

        # Always clear our local session state if given
        if session_id:
            try:
                with conn() as cx:
                    cx.execute("UPDATE sessions SET pi_payment_id=NULL, state='initiated' WHERE id=?", (session_id,))
            except Exception:
                pass

        return {"ok": True, "cleared": True, "payment_id": (pay_id or None), "session_id": (session_id or None)}
    except Exception:
        return {"ok": False, "error": "server_error"}, 500
# NEW: Same-origin proxy to your LibreTranslate service
@app.post("/api/translate")
def api_translate():
    """
    Accepts JSON: { "text": "...", "from": "auto"|lang, "to": "lang" }
    Returns: { ok:true, text:"...", source, target }
    """
    try:
        data = request.get_json(force=True) or {}
        q     = (data.get("text") or data.get("q") or "").strip()
        src   = (data.get("from") or data.get("source") or "auto").strip() or "auto"
        tgt   = (data.get("to")   or data.get("target") or "en").strip()   or "en"
        if not q:
            return {"ok": False, "error": "empty_text"}, 400

        r = requests.post(
            f"{LIBRE_EP}/translate",
            json={"q": q, "source": src, "target": tgt, "format": "text"},
            timeout=15,
        )
        if r.status_code != 200:
            return {"ok": False, "error": "upstream_error", "status": r.status_code}, 502

        j = r.json()
        out = j.get("translatedText") or j.get("translated_text") or q
        return {"ok": True, "text": out, "source": src, "target": tgt}
    except Exception:
        return {"ok": False, "error": "server_error"}, 500

from urllib.parse import urlparse

def _safe_next_path(raw):
    """
    Only allow same-site relative paths, like /izza-game/create or /dashboard?tab=1.
    Disallow absolute URLs and paths without a leading slash.
    """
    if not raw or not isinstance(raw, str):
        return None
    if not raw.startswith("/"):
        return None
    parsed = urlparse(raw)
    if parsed.scheme or parsed.netloc:
        return None
    return raw


@app.post("/auth/exchange")
def auth_exchange():
    try:
        # Parse payload and, if present, a JSON 'next'
        if request.is_json:
            data = request.get_json(silent=True) or {}
        else:
            payload = request.form.get("payload", "")
            try:
                data = json.loads(payload) if payload else {}
            except Exception:
                data = {}

        # Read 'next' from any source, prefer form > query > json
        next_candidate = (
            (request.form.get("next") if not request.is_json else None)
            or request.args.get("next")
            or data.get("next")
        )
        next_path = _safe_next_path(next_candidate) or "/dashboard"

        # Validate required auth fields
        user = (data.get("user") or {})
        uid = user.get("uid") or user.get("id")
        username = user.get("username")
        token = data.get("accessToken")
        if (not uid) or (not username) or (not token):
            if not request.is_json:
                return redirect("/signin?fresh=1")
            return {"ok": False, "error": "invalid_payload"}, 400

        # Verify token with Pi
        r = requests.get(f"{PI_API_BASE}/v2/me",
                         headers={"Authorization": f"Bearer {token}"}, timeout=10)
        if r.status_code != 200:
            if not request.is_json:
                return redirect("/signin?fresh=1")
            return {"ok": False, "error": "token_invalid"}, 401

        # Upsert user
        with conn() as cx:
            row = cx.execute("SELECT * FROM users WHERE pi_uid=?", (uid,)).fetchone()
            if not row:
                cx.execute("""INSERT INTO users(pi_uid, pi_username, role, created_at)
                              VALUES(?, ?, 'buyer', ?)""",
                           (uid, username, int(time.time())))
                row = cx.execute("SELECT * FROM users WHERE pi_uid=?", (uid,)).fetchone()

        # Create session
        try:
            session["user_id"] = row["id"]
            session.permanent = True
        except Exception:
            pass

        # Mint app token and build redirect
        tok = mint_login_token(row["id"])
        separator = "&" if "?" in next_path else "?"
        target = f"{next_path}{separator}t={tok}"

        if not request.is_json:
            return redirect(target)

        return {"ok": True, "redirect": target, "token": tok}, 200

    except Exception:
        if not request.is_json:
            return redirect("/signin?fresh=1")
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

@app.get("/admin/enter")
def admin_enter():
    # Render a tiny page with a button that authenticates via Pi
    # and posts to /admin/exchange
    return render_template("admin_gate.html", sandbox=PI_SANDBOX)

@app.post("/admin/exchange")
def admin_exchange():
    """
    Accepts { payload: JSON.stringify({ accessToken, user }) } like your other flows.
    Verifies the returned Pi username equals ADMIN_PI_USERNAME; if yes, marks user admin.
    """
    try:
        if request.is_json:
            data = request.get_json(silent=True) or {}
        else:
            payload = request.form.get("payload", "")
            try: data = json.loads(payload) if payload else {}
            except Exception: data = {}

        user = (data.get("user") or {})
        username = user.get("username") or ""
        token = data.get("accessToken")
        if not username or not token:
            return redirect("/signin?fresh=1")

        # Verify token with Pi
        r = requests.get(f"{PI_API_BASE}/v2/me",
                         headers={"Authorization": f"Bearer {token}"}, timeout=10)
        if r.status_code != 200:
            return redirect("/admin/enter")

        # Must match env ADMIN_PI_USERNAME
        if not is_admin_name(username):
            return redirect("/admin/enter")

        # Ensure user exists; promote to admin
        with conn() as cx:
            row = cx.execute("SELECT * FROM users WHERE pi_username=?", (username,)).fetchone()
            if not row:
                # make one if somehow not present yet
                cx.execute("""INSERT INTO users(pi_uid, pi_username, role, created_at)
                              VALUES(?, ?, 'admin', ?)""",
                           (user.get("uid") or user.get("id"), username, int(time.time())))
                row = cx.execute("SELECT * FROM users WHERE pi_username=?", (username,)).fetchone()
            else:
                cx.execute("UPDATE users SET role='admin' WHERE id=?", (row["id"],))

        # log them in if not already
        try:
            session["user_id"] = row["id"]; session.permanent = True
        except Exception:
            pass

        return redirect("/admin")
    except Exception:
        return redirect("/admin/enter")

@app.get("/admin")
def admin_home():
    u = require_admin()
    if isinstance(u, Response):
        return u

    with conn() as cx:
        totals_row = cx.execute("""
          SELECT
            (SELECT COUNT(*) FROM users)                    AS users,
            (SELECT COUNT(*) FROM merchants)                AS merchants,
            (SELECT COUNT(*) FROM items WHERE active=1)     AS items_count,
            (SELECT COUNT(*) FROM orders)                   AS orders
        """).fetchone()

        recent_rows = cx.execute("""
          SELECT o.id, o.pi_amount, o.pi_fee, o.status,
                 m.business_name AS store, i.title AS item
          FROM orders o
          JOIN merchants m ON m.id = o.merchant_id
          JOIN items i     ON i.id = o.item_id
          ORDER BY o.id DESC
          LIMIT 20
        """).fetchall()

    totals = dict(totals_row or {})
    recent = [dict(r) for r in (recent_rows or [])]

    return render_template(
        "admin.html",
        totals=totals,
        recent=recent,
        admin_wallet=ADMIN_PI_WALLET,
        admin_username=ADMIN_PI_USERNAME
    )

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
    if isinstance(u, Response):
        return u

    data = request.form
    slug = (data.get("slug") or uuid.uuid4().hex[:6]).lower()
    business_name = data.get("business_name") or f"{u['pi_username']}'s Shop"
    logo_url = (data.get("logo_url") or "").strip()
    theme_mode = data.get("theme_mode", "dark")
    reply_to_email = (data.get("reply_to_email") or "").strip()
    pi_wallet_address = (data.get("pi_wallet_address") or "").strip()
    pi_handle = (data.get("pi_handle") or "").strip()
    colorway = (data.get("colorway") or "cw-blue").strip()

    # Validate form fields
    if not reply_to_email or "@" not in reply_to_email:
        tok = get_bearer_token_from_request()
        return render_template(
            "merchant_items.html",
            setup_mode=True,
            m=None,
            items=[],
            app_base=APP_BASE_URL,
            t=tok,
            share_base=BASE_ORIGIN,
            username=u["pi_username"],
            colorway=colorway,
            error="Enter a valid merchant email address."
        )

    if not (len(pi_wallet_address) == 56 and pi_wallet_address.startswith("G")):
        tok = get_bearer_token_from_request()
        return render_template(
            "merchant_items.html",
            setup_mode=True,
            m=None,
            items=[],
            app_base=APP_BASE_URL,
            t=tok,
            share_base=BASE_ORIGIN,
            username=u["pi_username"],
            colorway=colorway,
            error="Enter a valid Pi Wallet public key (56 chars, starts with 'G')."
        )

    # DB work must be inside the 'with' block AND properly indented
    with conn() as cx:
        # 1) slug uniqueness check
        exists = cx.execute(
            "SELECT 1 FROM merchants WHERE slug=?",
            (slug,)
        ).fetchone()

        if exists:
            tok = get_bearer_token_from_request()
            prefill = None
            # support prefill carry-over
            if request.args.get("prefill") == "1":
                prefill = session.pop("prefill_product", None)

            return render_template(
                "merchant_items.html",
                setup_mode=True,
                m=None,
                items=[],
                PREFILL=prefill,
                app_base=APP_BASE_URL,
                t=tok,
                share_base=BASE_ORIGIN,
                username=u["pi_username"],
                colorway=colorway,
                error="Slug already taken."
            )

        # 2) create the merchant
        cx.execute(
            """INSERT INTO merchants(
                   owner_user_id, slug, business_name, logo_url,
                   theme_mode, reply_to_email, pi_wallet, pi_wallet_address,
                   pi_handle, colorway
               )
               VALUES(?,?,?,?,?,?,?,?,?,?)""",
            (
                u["id"], slug, business_name, logo_url,
                theme_mode, reply_to_email, "@deprecated", pi_wallet_address,
                pi_handle, colorway
            )
        )

    # 3) redirect after successful insert
    tok = get_bearer_token_from_request()
    return redirect(f"/merchant/{slug}/items{('?t='+tok) if tok else ''}")

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
    if isinstance(u, Response):
        return u

    with conn() as cx:
        items = cx.execute(
            "SELECT * FROM items WHERE merchant_id=? AND active=1 ORDER BY id DESC",
            (m["id"],)
        ).fetchall()

    return render_template(
        "merchant_items.html",
        setup_mode=False,
        m=m,
        items=items,
        app_base=APP_BASE_URL,
        t=get_bearer_token_from_request(),
        share_base=BASE_ORIGIN,
        colorway=m["colorway"],
        username=(u["pi_username"] if u else None),
        ADMIN_PI_USERNAME=os.getenv("ADMIN_PI_USERNAME"),
    )

@app.post("/merchant/<slug>/items/new")
def merchant_new_item(slug):
    u, m = require_merchant_owner(slug)
    if isinstance(u, Response):
        return u

    data = request.form
    title        = data.get("title", "").strip()
    sku          = data.get("sku", "").strip()
    image_url    = data.get("image_url", "").strip()
    description  = data.get("description", "").strip()
    pi_price     = data.get("pi_price", "0").strip()
    stock_qty    = data.get("stock_qty", "0").strip()
    allow_backorder = 1 if data.get("allow_backorder") else 0
    crafted_item_id = data.get("crafted_item_id") or None
    fulfillment_kind = "crafting" if crafted_item_id else "physical"

    link_id = uuid.uuid4().hex[:8]

    with conn() as cx:
        cx.execute(
            """INSERT INTO items(
                 merchant_id, link_id, title, sku, image_url, description,
                 pi_price, stock_qty, allow_backorder, active,
                 fulfillment_kind, crafted_item_id
               )
               VALUES(?,?,?,?,?,?,?,?,?,1,?,?)""",
            (
                m["id"],
                link_id,
                title,
                sku,
                image_url,
                description,
                float(pi_price),
                int(stock_qty),
                int(allow_backorder),
                fulfillment_kind,
                (crafted_item_id or None),
            )
        )

    tok = data.get("t")
    return redirect(f"/merchant/{slug}/items{('?t='+tok) if tok else ''}")

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
    sku   = (data.get("sku") or "").strip()
    image_url = (data.get("image_url") or "").strip()
    description = (data.get("description") or "").strip()
    crafted_item_id = (data.get("crafted_item_id") or "").strip()

    try:
        pi_price = float((data.get("pi_price") or "").strip() or "0")
    except ValueError:
        pi_price = 0.0
    try:
        stock_qty = int((data.get("stock_qty") or "").strip() or "0")
    except ValueError:
        stock_qty = 0

    fulfillment_kind = "crafting" if crafted_item_id else "physical"

    with conn() as cx:
        it = cx.execute("SELECT * FROM items WHERE id=? AND merchant_id=?", (item_id, m["id"])).fetchone()
        if not it: abort(404)
        cx.execute(
            """UPDATE items
               SET title=?,
                   sku=?,
                   image_url=?,
                   description=?,
                   pi_price=?,
                   stock_qty=?,
                   fulfillment_kind=?,
                   crafted_item_id=?
               WHERE id=? AND merchant_id=?""",
            (title or it["title"],
             sku or it["sku"],
             image_url or (it["image_url"] or ""),
             description or (it["description"] or ""),
             (pi_price if pi_price > 0 else it["pi_price"]),
             (stock_qty if stock_qty >= 0 else it["stock_qty"]),
             fulfillment_kind,
             (crafted_item_id or None),
             item_id, m["id"])
        )

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
    if isinstance(u, Response):
        return u

    with conn() as cx:
        orders = cx.execute("""
          SELECT orders.*, items.title as item_title
          FROM orders JOIN items ON items.id=orders.item_id
          WHERE orders.merchant_id=?
          ORDER BY orders.id DESC
        """, (m["id"],)).fetchall()

    stats = _merchant_30d_stats(m["id"])

    # Read flags from query string
    payout_sent       = (request.args.get("payout") == "sent")
    payout_throttled  = (request.args.get("payout_throttled") == "1")
    payout_error      = (request.args.get("payout_error") == "1")
    try:
        throttle_minutes = int(request.args.get("throttle_minutes", "0") or 0)
    except ValueError:
        throttle_minutes = 0

    # <<< dedented return so it always runs >>>
    return render_template(
        "merchant_orders.html",
        m=m,
        orders=orders,
        stats=stats,
        colorway=m["colorway"],
        payout_sent=payout_sent,
        payout_throttled=payout_throttled,
        payout_error=payout_error,
        throttle_minutes=throttle_minutes,
        t=get_bearer_token_from_request(),
    )
# ---- DELETE STORE (archive 30 days, then redirect to /signin) ----
@app.post("/merchant/<slug>/delete")
def merchant_delete_store(slug):
    # Must be owner
    u, m = require_merchant_owner(slug)
    if isinstance(u, Response):
        return u
    if not m:
        abort(404)

    now = int(time.time())
    THIRTY_DAYS = 30 * 24 * 3600

    with conn() as cx:
        # Ensure archive table exists
        cx.execute("""
            CREATE TABLE IF NOT EXISTS deleted_merchants(
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              merchant_id INTEGER NOT NULL,
              payload_json TEXT NOT NULL,
              deleted_at INTEGER NOT NULL,
              purge_after INTEGER NOT NULL
            )
        """)

        # Snapshot live data (all inside the same transaction)
        merch = dict(m)

        items = [dict(r) for r in cx.execute(
            "SELECT * FROM items WHERE merchant_id=?", (m["id"],)
        ).fetchall()]

        orders = [dict(r) for r in cx.execute(
            "SELECT * FROM orders WHERE merchant_id=?", (m["id"],)
        ).fetchall()]

        sessions_rows = [dict(r) for r in cx.execute(
            "SELECT * FROM sessions WHERE merchant_id=?", (m["id"],)
        ).fetchall()]

        carts = [dict(r) for r in cx.execute(
            "SELECT * FROM carts WHERE merchant_id=?", (m["id"],)
        ).fetchall()]

        cart_items = []
        if carts:
            cart_ids = tuple(c["id"] for c in carts)
            placeholders = ",".join("?" for _ in cart_ids)
            cart_items = [dict(r) for r in cx.execute(
                f"SELECT * FROM cart_items WHERE cart_id IN ({placeholders})", cart_ids
            ).fetchall()]

        snapshot = {
            "merchant": merch,
            "items": items,
            "orders": orders,
            "sessions": sessions_rows,
            "carts": carts,
            "cart_items": cart_items,
        }

        # Save snapshot for 30 days
        cx.execute(
            "INSERT INTO deleted_merchants(merchant_id, payload_json, deleted_at, purge_after) VALUES(?,?,?,?)",
            (m["id"], json.dumps(snapshot, separators=(",", ":")), now, now + THIRTY_DAYS)
        )

        # --- Hard delete all live rows tied to this merchant (order matters to avoid orphans) ---
        cx.execute("DELETE FROM cart_items WHERE cart_id IN (SELECT id FROM carts WHERE merchant_id=?)", (m["id"],))
        cx.execute("DELETE FROM carts WHERE merchant_id=?", (m["id"],))
        cx.execute("DELETE FROM sessions WHERE merchant_id=?", (m["id"],))
        cx.execute("DELETE FROM items WHERE merchant_id=?", (m["id"],))
        cx.execute("DELETE FROM orders WHERE merchant_id=?", (m["id"],))
        cx.execute("DELETE FROM payout_requests WHERE merchant_id=?", (m["id"],))  # harmless if none
        cx.execute("DELETE FROM merchants WHERE id=?", (m["id"],))

        # Opportunistically purge any expired archives
        cx.execute("DELETE FROM deleted_merchants WHERE purge_after < ?", (now,))

        # Clear session
    try:
        session.clear()
    except Exception:
        pass

    # Redirect target after delete
    target = "/signin?fresh=1"

    # If request came from HTMX, instruct client to redirect
    if request.headers.get("HX-Request") == "true":
        resp = Response("", 200)
        resp.headers["HX-Redirect"] = target
        return resp

    # If it's a fetch/AJAX expecting JSON, tell client to reload/redirect
    if request.is_json or "application/json" in (request.headers.get("Accept") or ""):
        return {"ok": True, "redirect": target}, 200

    # Normal form POST â send a 303 so the browser follows with GET
    return redirect(target, code=303)

# ----------------- STOREFRONT AUTH -----------------
@app.get("/store/<slug>/signin")
def store_signin(slug):
    m = resolve_merchant_by_slug(slug)
    if not m: abort(404)
    next_url = request.args.get("next") or f"/store/{slug}"
    # Pass store name (and optional branding bits)
    return render_template(
        "store_signin.html",
        app_base=APP_BASE_URL,
        next_url=next_url,
        slug=slug,
        store_name=m["business_name"],
        logo_url=(m["logo_url"] or ""),
        colorway=(m["colorway"] or "cw-blue"),
        theme_mode=(m["theme_mode"] or "dark"),
        sandbox=PI_SANDBOX,
    )

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
            return redirect("/signin?fresh=1")
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
        except Exception:
            pass
        tok = mint_login_token(row["id"])
        join = "&" if ("?" in next_url) else "?"
        return redirect(f"{next_url}{join}t={tok}")
    except Exception:
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
    
@app.get("/voucher/<code>")
def mint_success(code):
    with conn() as cx:
        row = cx.execute("SELECT code, used, used_at FROM mint_codes WHERE code=?", (code,)).fetchone()
    status = ("invalid" if not row else ("used" if int(row["used"]) else "ok"))
    return render_template("mint_success.html", code=code, status=status), (404 if status=="invalid" else 200)


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

# ---- Pi amount rounding helpers (7 dp) ----
PI_QUANT = Decimal("0.0000001")
def qpi(x) -> float:
    """Quantize/round to 7 decimal places using Decimal; return float for storage/JSON."""
    return float(Decimal(str(x)).quantize(PI_QUANT, rounding=ROUND_HALF_UP))


@app.get("/checkout/cart/<cid>")
def checkout_cart(cid):
    u = current_user_row()
    if not u:
        return redirect("/signin?fresh=1")
    tok = get_bearer_token_from_request()

    with conn() as cx:
        cart = cx.execute("SELECT * FROM carts WHERE id=?", (cid,)).fetchone()
        if not cart:
            abort(404)

        m = cx.execute("SELECT * FROM merchants WHERE id=?", (cart["merchant_id"],)).fetchone()
        rows = cx.execute("""
            SELECT cart_items.qty, items.*
            FROM cart_items
            JOIN items ON items.id = cart_items.item_id
            WHERE cart_items.cart_id=?
        """, (cid,)).fetchall()

    if not rows:
        return redirect(f"/store/{m['slug']}{('?t='+tok) if tok else ''}?cid={cid}")

    # Use Decimal math and quantize to 7dp for cart totals
    total_dec = sum(Decimal(str(r["pi_price"])) * Decimal(str(r["qty"])) for r in rows)
    total = qpi(total_dec)

    sid = uuid.uuid4().hex
    line_items = json.dumps([
        {"item_id": int(r["id"]), "qty": int(r["qty"]), "price": float(r["pi_price"])}
        for r in rows
    ])

    with conn() as cx:  # <-- corrected indentation
        cx.execute(
            """INSERT INTO sessions(
                   id, merchant_id, item_id, qty, expected_pi, state,
                   created_at, cart_id, line_items_json, user_id,
                   pi_username, checkout_path
               )
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                sid, m["id"], None, 1, total, "initiated",
                int(time.time()), cid, line_items, u["id"],
                u["pi_username"], f"/checkout/cart/{cid}"
            )
        )

    i = {
        "business_name": m["business_name"],
        "title": "Cart total",
        "logo_url": m["logo_url"],
        "colorway": m["colorway"]
    }

    return render_template(
        "checkout.html",
        sold_out=False,
        i=i,
        qty=1,
        session_id=sid,
        expected_pi=total,
        app_base=APP_BASE_URL,
        cart_mode=True,
        colorway=m["colorway"],
        m=m,            # merchant row for font/logo/color
        rows=rows,      # full cart rows so order summary dropdown works
        slug=m["slug"], # for redirect after payment
    )


@app.get("/checkout/<link_id>")
def checkout(link_id):
    with conn() as cx:
        i = cx.execute("""
           SELECT items.*,
                  merchants.business_name,
                  merchants.logo_url,
                  merchants.id          AS mid,
                  merchants.slug        AS mslug,
                  merchants.colorway    AS colorway
           FROM items
           JOIN merchants ON merchants.id = items.merchant_id
           WHERE link_id=? AND active=1
        """, (link_id,)).fetchone()
    if not i:
        abort(404)

    qty = max(1, int(request.args.get("qty", "1")))
    if i["stock_qty"] <= 0 and not i["allow_backorder"]:
        return render_template("checkout.html", sold_out=True, i=i, colorway=i["colorway"])

    # REQUIRE app sign-in (same behavior as /checkout/cart/<cid>)
    u = current_user_row()
    if not u:
        # Send them to the store sign-in (keeps branding) and bounce back here
        next_url = f"/checkout/{link_id}?qty={qty}"
        return redirect(f"/store/{i['mslug']}/signin?next={next_url}")

    # Create a session tied to this user
    sid = uuid.uuid4().hex
    expected = qpi(Decimal(str(i["pi_price"])) * Decimal(str(qty)))

    line_items = json.dumps([{
        "item_id": int(i["id"]),
        "qty": int(qty),
        "price": float(i["pi_price"]),
    }])

    with conn() as cx:  # <-- corrected indentation
        cx.execute(
            """INSERT INTO sessions(
                   id, merchant_id, item_id, qty, expected_pi, state,
                   created_at, line_items_json, user_id,
                   pi_username, checkout_path
               )
               VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
            (
                sid, i["mid"], i["id"], qty, expected, "initiated",
                int(time.time()), line_items, u["id"],
                u["pi_username"], f"/checkout/{link_id}"
            )
        )

    return render_template(
        "checkout.html",
        sold_out=False,
        i=i,
        qty=qty,
        session_id=sid,
        expected_pi=expected,
        app_base=APP_BASE_URL,
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
            return {"ok": False, "error": "approve_failed", "status": r.status_code}, 502
        with conn() as cx:
            cx.execute("UPDATE sessions SET pi_payment_id=?, state=? WHERE id=?",
                       (payment_id, "approved", session_id))
        return {"ok": True}
    except Exception:
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
    try:
        r = requests.post(f"{PI_API_BASE}/v2/payments/{payment_id}/complete",
                          headers=pi_headers(), json={"txid": txid})
        if r.status_code != 200:
            return {"ok": False, "error": "complete_failed", "status": r.status_code}, 502
    except Exception:
        return {"ok": False, "error": "server_error"}, 500

    with conn() as cx:
        s = cx.execute("SELECT * FROM sessions WHERE id=?", (session_id,)).fetchone()
    if not s or s["state"] not in ("initiated", "approved"):
        return {"ok": False, "error": "bad_session"}, 400

    # Compare exact-at-7dp using Decimal, not float epsilon
    expected_amt = Decimal(str(s["expected_pi"])).quantize(PI_QUANT, rounding=ROUND_HALF_UP)
    try:
        r = fetch_pi_payment(payment_id)
        if r.status_code == 200:
            pdata = r.json()
            paid_amt = Decimal(str(pdata.get("amount", 0))).quantize(PI_QUANT, rounding=ROUND_HALF_UP)
            if (paid_amt != expected_amt) and not PI_SANDBOX:
                return {"ok": False, "error": "amount_mismatch"}, 400
        elif not PI_SANDBOX:
            return {"ok": False, "error": "fetch_payment_failed"}, 502
    except Exception:
        if not PI_SANDBOX:
            return {"ok": False, "error": "payment_verify_error"}, 500
    # Extract memo/description from the verified payment payload
    memo_text = ""
    try:
        meta = pdata.get("metadata") or {}
        memo_text = str(
            pdata.get("memo")
            or pdata.get("description")
            or meta.get("description")
            or meta.get("memo")
            or ""
        )
    except Exception:
        memo_text = ""
            # 🔁 Fallback: if the Pi memo mentions "IZZA GAME", grant +1 single mint credit
    # (idempotent per payment_id via crafting_credit_grants_payments)
    try:
        if memo_text:
            norm = " ".join(memo_text.split()).lower()  # collapse whitespace, case-insensitive
            if ("izza game" in norm) and (checkout_path != f"/checkout/{SINGLE_CREDIT_LINK_ID}"):
                # Resolve user id (prefer session’s user_id)
                uid = None
                try:
                    uid = int(s["user_id"]) if s["user_id"] is not None else None
                except Exception:
                    uid = None
                if not uid:
                    u_ctx = current_user_row()
                    uid = int(u_ctx["id"]) if u_ctx else None

                if uid:
                    with conn() as cx:
                        dup = cx.execute(
                            "SELECT 1 FROM crafting_credit_grants_payments WHERE payment_id=?",
                            (payment_id,)
                        ).fetchone()
                        if not dup:
                            add_ic_credits(uid, 1)  # +1 single mint credit
                            cx.execute(
                                "INSERT INTO crafting_credit_grants_payments(payment_id, user_id, granted_at) VALUES(?,?,?)",
                                (payment_id, uid, int(time.time()))
                            )
                            print(f"[pi_complete] memo-based credit granted (+1) to user_id={uid} for payment {payment_id}")
                        else:
                            print(f"[pi_complete] memo-based grant already recorded for payment {payment_id}")
            else:
                if memo_text:
                    print(f"[pi_complete] memo present but not qualifying or already handled by path: {memo_text[:80]!r}")
    except Exception as e:
        print("[pi_complete] memo-based grant failed:", e)

    return fulfill_session(s, txid, buyer, shipping)

# ----------------- FULFILLMENT + EMAIL -----------------
def fulfill_session(s, tx_hash, buyer, shipping):
    """
    - Marks session paid
    - Creates order rows per line
    - Updates stock
    - Grants in-game crafting items (fulfillment_kind == 'crafting')
    - Records SINGLE_MINT credit claims when the special product is purchased
    - Keeps existing IC credit award logic (from crafted_item_id 'ic:###' or SKU 'IC###')
    - Sends emails
    - Returns redirect JSON to the storefront success page
    """
    import uuid, json, time

    with conn() as cx:
        m = cx.execute("SELECT * FROM merchants WHERE id=?", (s["merchant_id"],)).fetchone()

    amt = float(s["expected_pi"])
    gross_total, fee_total, net_total = split_amounts(amt)
    gross_total = float(gross_total); fee_total = float(fee_total); net_total = float(net_total)

    # Buyer contact
    buyer_email = (buyer.get("email") or (shipping.get("email") if isinstance(shipping, dict) else None) or None)
    buyer_name  =  (buyer.get("name")  or (shipping.get("name")  if isinstance(shipping, dict) else None) or None)

    # --- Robust buyer_user_id resolution (prefer session, else current user) ---
    u_ctx = current_user_row()
    try:
        buyer_user_id = s["user_id"] if s.get("user_id") is not None else (u_ctx["id"] if u_ctx else None)
    except Exception:
        buyer_user_id = (u_ctx["id"] if u_ctx else None)
    # ---------------------------------------------------------------------------

    # Snapshot of line items
    try:
        lines = json.loads(s.get("line_items_json") or "[]")
    except Exception:
        lines = []

    if not lines:
        # Mark session paid even if no lines were captured
        with conn() as cx:
            cx.execute("UPDATE sessions SET state='paid', pi_tx_hash=? WHERE id=?", (tx_hash, s["id"]))
        try:
            send_email(
                (m["reply_to_email"] or DEFAULT_ADMIN_EMAIL),
                f"Order paid but no lines captured (session {s['id']})",
                "<p>The session was paid, but no line items snapshot was present.</p>"
            )
        except Exception:
            pass
        return {"ok": True, "redirect_url": f"{BASE_ORIGIN}/store/{m['slug']}?success=1"}

    # Fetch items referenced by the snapshot
    item_ids = [int(li["item_id"]) for li in lines if "item_id" in li]
    with conn() as cx:
        placeholders = ",".join("?" for _ in item_ids)
        items = cx.execute(f"SELECT * FROM items WHERE id IN ({placeholders})", item_ids).fetchall()
        by_id = {int(r["id"]): r for r in items}

    created_order_ids = []
    total_snapshot_gross = sum(float(li["price"]) * int(li.get("qty", 1)) for li in lines) or 1.0

    # Track if any SINGLE_MINT credit should be recorded per order row
    SINGLE_ID = str(SINGLE_CREDIT_LINK_ID)  # defined elsewhere in your app
    with conn() as cx:
        # Ensure credit-claims table exists (safe/no-op if already there)
        cx.execute("""
            CREATE TABLE IF NOT EXISTS crafting_credit_claims(
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              order_id INTEGER NOT NULL UNIQUE,
              user_id INTEGER NOT NULL,
              claimed_at INTEGER NOT NULL
            )
        """)

        for li in lines:
            it  = by_id.get(int(li["item_id"]))
            qty = int(li.get("qty", 1) or 1)
            snap_price = float(li["price"])
            line_gross = snap_price * qty
            # Pro-rate fee across lines
            line_fee   = float(fee_total) * (line_gross / total_snapshot_gross)
            line_net   = line_gross - line_fee

            # Stock decrement (if not backorderable)
            if it and not it["allow_backorder"]:
                cx.execute(
                    "UPDATE items SET stock_qty=? WHERE id=?",
                    (max(0, int(it["stock_qty"]) - qty), it["id"])
                )

            # === Grant in-game crafting item (normal crafting products) ===
            if it and (it["fulfillment_kind"] == "crafting") and it["crafted_item_id"]:
                try:
                    _grant_crafting_item(buyer_user_id, it["crafted_item_id"], qty)
                except Exception:
                    # do not fail checkout on grant error
                    pass

            # --- IC CREDITS: award credits for special crafted ids or SKUs ---
            try:
                awarded = 0
                # Strategy 1: crafted_item_id like "ic:<amount>" (e.g., "ic:500")
                cid = (it["crafted_item_id"] or "").strip().lower() if it else ""
                if cid.startswith("ic:"):
                    try:
                        unit = int(cid.split(":", 1)[1] or "0")
                    except Exception:
                        unit = 0
                    if unit > 0 and buyer_user_id:
                        awarded = unit * qty
                        add_ic_credits(int(buyer_user_id), awarded)

                # Strategy 2 (fallback): SKU like "IC500" or "ic_500"
                if not awarded:
                    sku = (it["sku"] or "").strip().lower() if it else ""
                    if sku.startswith("ic"):
                        import re
                        match = re.search(r"(\d+)", sku)
                        if match and buyer_user_id:
                            unit = int(match.group(1))
                            if unit > 0:
                                awarded = unit * qty
                                add_ic_credits(int(buyer_user_id), awarded)
            except Exception:
                # ignore IC credit calc errors
                pass

            # === Insert the order row ===
            buyer_token = uuid.uuid4().hex
            cur = cx.execute(
                """INSERT INTO orders(
                     merchant_id, item_id, qty,
                     buyer_email, buyer_name, shipping_json,
                     pi_amount, pi_fee, pi_merchant_net, pi_tx_hash,
                     payout_status, status, buyer_token, buyer_user_id
                   )
                   VALUES (?,?,?,?,?,?,?,?,?,?,'pending','paid',?,?)""",
                (
                    s["merchant_id"],
                    (it["id"] if it else None),
                    qty,
                    buyer_email,
                    buyer_name,
                    json.dumps(shipping),
                    float(line_gross),
                    float(line_fee),
                    float(line_net),
                    tx_hash,
                    buyer_token,
                    buyer_user_id,
                ),
            )
            order_id = cur.lastrowid
            created_order_ids.append(order_id)

            # === SINGLE In-Game Item Mint: record a *mint credit* claim (no IC coins) ===
            # Only when this line’s product is the special single-mint product.
            try:
                link_id = str(it.get("link_id") or "") if it else ""
                if link_id == SINGLE_ID and buyer_user_id:
                    # Idempotent per order_id
                    dup = cx.execute(
                        "SELECT 1 FROM crafting_credit_claims WHERE order_id=?",
                        (order_id,)
                    ).fetchone()
                    if not dup:
                        cx.execute(
                            "INSERT INTO crafting_credit_claims(order_id, user_id, claimed_at) VALUES(?,?,?)",
                            (order_id, int(buyer_user_id), int(time.time()))
                        )
            except Exception:
                # do not fail the fulfillment if credit record fails
                pass

    # --- Voucher: generate mint code for player to redeem in-game ---
    import secrets
    try:
        # link_id may not be defined if no item had it; guard implicitly
        if ('link_id' in locals()) and (link_id == SINGLE_ID) and buyer_user_id:
            with conn() as cx:
                _ensure_credit_codes(cx)
                code = secrets.token_hex(4).upper()  # 8-char voucher
                cx.execute(
                    "INSERT OR IGNORE INTO mint_codes(code, user_id) VALUES(?,?)",
                    (code, int(buyer_user_id))
                )
            # Save code in session for redirect
            session["last_mint_code"] = code
    except Exception as e:
        print("[fulfill_session] mint code generation failed:", e)

    # Mark session as paid after all lines are processed
    with conn() as cx:
        cx.execute(
            "UPDATE sessions SET state='paid', pi_tx_hash=? WHERE id=?",
            (tx_hash, s["id"])
        )

    try:
        display_rows = []
        for li in lines:
            it = by_id.get(int(li["item_id"]))
            title = (it["title"] if it else f"Item {li['item_id']}")
            qty = int(li["qty"])
            gross = float(li["price"]) * qty
            display_rows.append({"title": title, "qty": qty, "gross": gross})

        line_html = "".join(
            f"<tr><td style='padding:6px 8px'>{dr['title']}</td>"
            f"<td style='padding:6px 8px; text-align:right'>{dr['qty']}</td>"
            f"<td style='padding:6px 8px; text-align:right'>{dr['gross']:.7f} π</td></tr>"
            for dr in display_rows
        )
        items_table = (
            "<table style='border-collapse:collapse; width:100%; max-width:560px'>"
            "<thead><tr>"
            "<th style='text-align:left; padding:6px 8px'>Item</th>"
            "<th style='text-align:right; padding:6px 8px'>Qty</th>"
            "<th style='text-align:right; padding:6px 8px'>Line Total</th>"
            "</tr></thead>"
            f"<tbody>{line_html}</tbody>"
            "<tfoot>"
            f"<tr><td></td><td style='padding:6px 8px; text-align:right'><strong>Total</strong></td>"
            f"<td style='padding:6px 8px; text-align:right'><strong>{gross_total:.7f} π</strong></td></tr>"
            "</tfoot>"
            "</table>"
        )

        merchant_mail = (m["reply_to_email"] or "").strip() or DEFAULT_ADMIN_EMAIL

        shipping_html = ""
        if isinstance(shipping, dict):
            name   = (shipping.get("name") or "").strip()
            email  = (shipping.get("email") or "").strip()
            phone  = (shipping.get("phone") or "").strip()
            addr1  = (shipping.get("address") or "").strip()
            addr2  = (shipping.get("address2") or "").strip()
            city   = (shipping.get("city") or "").strip()
            state  = (shipping.get("state") or "").strip()
            postal = (shipping.get("postal_code") or "").strip()
            country= (shipping.get("country") or "").strip()
            any_shipping = any([name, email, phone, addr1, addr2, city, state, postal, country])
            if any_shipping:
                street_line = f"{addr1} #{addr2}" if addr1 and addr2 else (addr1 or (f"Unit #{addr2}" if addr2 else ""))
                locality_parts = [p for p in [city, state] if p]
                locality_line = ", ".join(locality_parts)
                if postal:
                    locality_line = (locality_line + " " if locality_line else "") + postal
                block = ["<h3 style='margin:16px 0 6px'>Shipping</h3>"]
                if name:   block.append(f"<div><strong>Name:</strong> {name}</div>")
                if email:  block.append(f"<div><strong>Email:</strong> {email}</div>")
                if phone:  block.append(f"<div><strong>Phone:</strong> {phone}</div>")
                if street_line: block.append(f"<div><strong>Address:</strong> {street_line}</div>")
                if locality_line: block.append(f"<div><strong>City/Region:</strong> {locality_line}</div>")
                if country: block.append(f"<div><strong>Country:</strong> {country}</div>")
                shipping_html = "".join(block)

        # Email subjects
        suffix = f" [{len(display_rows)} items]" if len(display_rows) > 1 else ""
        if suffix:
            subj_buyer = f"Your order at {m['business_name']} is confirmed{suffix}"
        else:
            subj_buyer = f"Your order at {m['business_name']} is confirmed"

        subj_merchant = f"New Pi order at {m['business_name']} ({gross_total:.7f} π){suffix}"

        if buyer_email:
            send_email(
                buyer_email,
                subj_buyer,
                f"""
                    <h2>Thanks for your order!</h2>
                    <p><strong>Store:</strong> {m['business_name']}</p>
                    {items_table}
                    <p style="margin-top:12px">
                      You’ll receive updates from the merchant if anything changes.
                    </p>
                """,
                reply_to=merchant_mail
            )
    except Exception:
        pass

    # --- Voucher redirect override (if a mint code was generated earlier) ---
    mint_code = session.pop("last_mint_code", None)
    if mint_code:
        redirect_url = url_for("mint_success_voucher", code=mint_code, _external=True)
        resp = jsonify({"ok": True, "redirect_url": redirect_url})
        return resp

    # ---- Redirect target (voucher-first) ----
u = current_user_row()
tok = ""
if u:
    try:
        tok = mint_login_token(u["id"])
    except Exception:
        tok = ""

join = "&" if tok else ""
default_target = f"{BASE_ORIGIN}/store/{m['slug']}?success=1{join}{('t='+tok) if tok else ''}"

# Decide where to send the buyer after success (product-based, not slug-based)
SINGLE_ID = str(SINGLE_CREDIT_LINK_ID)  # should be "d0b811e8"
grants_single_mint = False
try:
    for li in lines:
        it = by_id.get(int(li["item_id"]))
        if it and str(it.get("link_id") or "") == SINGLE_ID:
            grants_single_mint = True
            break
except Exception:
    grants_single_mint = False

# Fallback: if session captured a checkout path, also check for /checkout/<SINGLE_ID>
checkout_path = (s.get("checkout_path") or s.get("path") or s.get("checkout_url") or "").strip()
if (not grants_single_mint) and checkout_path.endswith(f"/{SINGLE_ID}"):
    grants_single_mint = True

# Voucher-first redirect when the basket grants the single-mint credit
if grants_single_mint:
    try:
        with conn() as cx:
            code = _new_mint_code(cx, int(buyer_user_id) if buyer_user_id else 0)
        redirect_url = url_for("mint_success_voucher", code=code, _external=True)
    except Exception:
        redirect_url = default_target
else:
    redirect_url = default_target

# Build response JSON
resp = jsonify({"ok": True, "redirect_url": redirect_url})

# Optional: keep the craft_credit cookie so the game UI can highlight Create→Visuals
should_flag = False
try:
    if grants_single_mint:
        should_flag = True
except Exception:
    should_flag = False

if should_flag:
    resp.set_cookie(
        "craft_credit", "1",
        max_age=15 * 60,
        secure=True,
        samesite="None",
        httponly=False,
        path="/"
    )

return resp
# Provide a concrete cancel endpoint used by /payment/error
@app.post("/payment/cancel")
def payment_cancel():
    """
    Clears local session state for a given session_id (JSON or form),
    returning ok=True whether or not the upstream cancel succeeded.
    """
    data = request.get_json(silent=True) or request.form or {}
    session_id = (data.get("session_id") or "").strip()
    if session_id:
        try:
            with conn() as cx:
                cx.execute("UPDATE sessions SET pi_payment_id=NULL, state='initiated' WHERE id=?", (session_id,))
        except Exception:
            pass
    return {"ok": True, "cleared": bool(session_id)}

@app.get("/mint/success/<code>", endpoint="mint_success_voucher")
def mint_success_voucher(code):
    # Very small inline page — you can move to a template later
    return f"""
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>IZZA Mint Credit</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Inter,sans-serif; background:#0f1522; color:#e7ecff; display:flex; min-height:100vh; align-items:center; justify-content:center;">
  <div style="background:#0b0f17; border:1px solid #2a3550; border-radius:12px; padding:16px 18px; max-width:560px; text-align:center">
    <h1 style="margin:6px 0 10px; font-size:20px">Mint Credit Code</h1>
    <p style="opacity:.85; margin:0 0 12px">Copy this code and paste it in the game's Crafting screen (Redeem Code):</p>
    <div style="font-weight:800; letter-spacing:1px; font-size:22px; background:#0f1522; border:1px solid #2a3550; border-radius:10px; padding:12px; display:inline-block">{code}</div>
    <p style="opacity:.7; font-size:12px; margin:12px 0 0">Each code is single-use.</p>
  </div>
</body>
</html>
    """

@app.post("/api/mint_codes/consume")
def mint_codes_consume():
    data = request.get_json(force=True) or {}
    code = (data.get("code") or "").strip().upper()
    if not code:
        return {"ok": False, "reason": "missing_code"}, 400

    with conn() as cx:
        _ensure_credit_codes(cx)
        row = cx.execute("SELECT code, user_id, used FROM mint_codes WHERE code=?", (code,)).fetchone()
        if not row:
            return {"ok": False, "reason": "invalid"}, 404
        if int(row["used"] or 0) == 1:
            return {"ok": False, "reason": "used"}, 409

        cx.execute("UPDATE mint_codes SET used=1, used_at=strftime('%s','now') WHERE code=?", (code,))

    return {"ok": True, "creditsAdded": 1}

@app.post("/payment/error")
def payment_error():
    """
    Same behavior as /payment/cancel. Useful to call when the client encounters
    an SDK error and wants to ensure any stuck payment is cleared.
    """
    return payment_cancel()

# ----------------- UPLOADS -----------------
def _allowed_ext(filename: str) -> bool:
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS

@app.post("/upload")
def upload():
    u = current_user_row()
    if not u:
        return {"ok": False, "error": "auth_required"}, 401
    if "file" not in request.files:
        return {"ok": False, "error": "missing_file_field"}, 400

    f = request.files["file"]
    if not f or not f.filename:
        return {"ok": False, "error": "empty_file"}, 400

    # Read file bytes once
    try:
        raw = f.read()
        if not raw:
            return {"ok": False, "error": "empty_file"}, 400
    except Exception:
        return {"ok": False, "error": "read_failed"}, 400

    from io import BytesIO
    bio = BytesIO(raw)

    # Validate & open image
    try:
        img = Image.open(bio)
        img.verify()  # quick integrity check
    except Exception:
        return {"ok": False, "error": "invalid_image"}, 400

    # Reopen for actual processing (verify() invalidates parser state)
    bio.seek(0)
    try:
        img = Image.open(bio)
    except Exception:
        return {"ok": False, "error": "reopen_failed"}, 400

    # Normalize format -> extension
    fmt = (img.format or "").upper()
    ext = "jpg" if fmt == "JPEG" else fmt.lower()
    if ext not in ALLOWED_EXTENSIONS:
        return {"ok": False, "error": "unsupported_format"}, 400

    # Correct orientation & strip EXIF by recreating the image
    try:
        from PIL import ImageOps
        img = ImageOps.exif_transpose(img)
    except Exception:
        pass

    # Downscale if too large (keeps aspect)
    MAX_DIM = 2048
    try:
        if max(img.size) > MAX_DIM:
            img.thumbnail((MAX_DIM, MAX_DIM))
    except Exception:
        pass

    # Animated GIFs: keep original bytes to preserve animation
    is_animated_gif = (fmt == "GIF" and getattr(img, "is_animated", False))
    out_bytes = None

    if is_animated_gif:
        out_bytes = raw
        ext = "gif"
    else:
        mode = img.mode
        has_alpha = ("A" in mode) or (mode in ("RGBA", "LA", "P"))
        buf = BytesIO()
        save_kwargs = {}

        if ext == "jpg":
            if has_alpha or mode not in ("RGB",):
                img = img.convert("RGB")
            save_kwargs.update(dict(quality=85, optimize=True, progressive=True))
            img.save(buf, format="JPEG", **save_kwargs)
        elif ext == "png":
            if mode == "P":
                img = img.convert("RGBA" if has_alpha else "RGB")
            save_kwargs.update(dict(optimize=True))
            img.save(buf, format="PNG", **save_kwargs)
        elif ext == "webp":
            if mode not in ("RGB", "RGBA"):
                img = img.convert("RGBA" if has_alpha else "RGB")
            save_kwargs.update(dict(quality=85, method=4))
            img.save(buf, format="WEBP", **save_kwargs)
        else:
            buf = BytesIO(raw)

        out_bytes = buf.getvalue()

    # Deterministic filename by content-hash (prevents duplicates)
    try:
        digest = hashlib.sha256(out_bytes).hexdigest()
    except Exception:
        digest = uuid.uuid4().hex

    unique_name = f"{digest[:32]}.{ext}"
    safe_name = secure_filename(unique_name)
    path = os.path.join(UPLOAD_DIR, safe_name)

    if not os.path.exists(path):
        try:
            with open(path, "wb") as out:
                out.write(out_bytes)
        except Exception:
            return {"ok": False, "error": "save_failed"}, 500

    # IMPORTANT: return a /media URL (not /static), so files persist across deploys
    url = f"{MEDIA_PREFIX}/{safe_name}"
    return {"ok": True, "url": url}, 200

# ----------------- IMAGE PROXY -----------------
_TRANSPARENT_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAA"
    "AAC0lEQVR42mP8/x8AAwMCAO6dEpgAAAAASUVORK5CYII="
)

@app.get("/uimg")
def uimg():
    src = (request.args.get("src") or "").strip()
    if not src:
        return Response(_TRANSPARENT_PNG, headers={"Content-Type": "image/png", "Cache-Control": "public, max-age=86400"})
    try:
        u = urlparse(src)
    except Exception:
        return Response(_TRANSPARENT_PNG, headers={"Content-Type": "image/png", "Cache-Control": "public, max-age=86400"})

    # Local file paths: allow /static and /media
    if not u.scheme and src.startswith(("/static/", "/media/")):
        # Map /static to the app's static folder; /media to UPLOAD_DIR
        if src.startswith("/static/"):
            base_root = app.static_folder or os.path.join(os.path.dirname(__file__), "static")
            rel_path = src[len("/static/"):]
        else:
            base_root = UPLOAD_DIR
            rel_path = src[len("/media/"):]
        safe_base = os.path.abspath(base_root)
        safe_path = os.path.abspath(os.path.normpath(os.path.join(safe_base, rel_path)))
        if not safe_path.startswith(safe_base) or not os.path.exists(safe_path):
            return Response(_TRANSPARENT_PNG, headers={"Content-Type": "image/png", "Cache-Control": "public, max-age=86400"})
        try:
            ctype = mimetypes.guess_type(safe_path)[0] or "image/png"
        except Exception:
            ctype = "image/png"
        with open(safe_path, "rb") as f:
            data = f.read()
        return Response(data, headers={"Content-Type": ctype, "Cache-Control": "public, max-age=86400"})

    # HTTPS only for external
    if u.scheme in ("http", "https"):
        if u.scheme != "https":
            # Only allow cleartext if it is our own host (defensive)
            try:
                app_host = urlparse(APP_BASE_URL).netloc
            except Exception:
                app_host = request.host
            if u.netloc != app_host:
                return Response(_TRANSPARENT_PNG, headers={"Content-Type": "image/png", "Cache-Control": "public, max-age=86400"})
        try:
            r = requests.get(src, stream=True, timeout=10, headers={"User-Agent": "izzapay-image-proxy"})
            if r.status_code != 200:
                return Response(_TRANSPARENT_PNG, headers={"Content-Type": "image/png", "Cache-Control": "public, max-age=86400"})
            ctype = r.headers.get("Content-Type", "image/png")
            data = r.content
            return Response(data, headers={"Content-Type": ctype, "Cache-Control": "public, max-age=86400"})
        except Exception:
            return Response(_TRANSPARENT_PNG, headers={"Content-Type": "image/png", "Cache-Control": "public, max-age=86400"})

    return Response(_TRANSPARENT_PNG, headers={"Content-Type": "image/png", "Cache-Control": "public, max-age=86400"})

# ----------------- POLICIES / STATIC PAGES -----------------
@app.get("/validation-key.txt")
def validation_key():
    return app.send_static_file("validation-key.txt")

@app.get("/privacy")
def privacy():
    return render_template("privacy.html")

@app.get("/terms")
def terms():
    return render_template("terms.html")

# ----------------- ORDERS PAGE (Purchases + Merchant stats) -----------------
def _merchant_30d_stats(merchant_id: int):
    """
    Returns dict with:
      gross_30, fee_30, app_fee_30 (1% of gross), net_30 (gross - fee - app_fee),
      sessions_30, usd_rate, usd_estimate (net_30 * usd_rate or None)
    Time window uses orders.created_at if available; otherwise sessions.created_at via join.
    """
    now = int(time.time())
    since = now - 30 * 24 * 3600
    gross = 0.0
    fee   = 0.0

    with conn() as cx:
        if HAS_ORDER_CREATED_AT:
            row = cx.execute(
                """
                SELECT COALESCE(SUM(pi_amount),0) AS gross,
                       COALESCE(SUM(pi_fee),0)    AS fee
                FROM orders
                WHERE merchant_id=? AND status='paid' AND created_at>=?
                """,
                (merchant_id, since)
            ).fetchone()
        else:
            # Fallback: derive time from session timestamp
            row = cx.execute(
                """
                SELECT COALESCE(SUM(o.pi_amount),0) AS gross,
                       COALESCE(SUM(o.pi_fee),0)    AS fee
                FROM orders o
                JOIN sessions s ON s.pi_tx_hash = o.pi_tx_hash
                WHERE o.merchant_id=? AND o.status='paid' AND s.created_at>=?
                """,
                (merchant_id, since)
            ).fetchone()

        gross = float(row["gross"] or 0.0)
        fee   = float(row["fee"] or 0.0)

        sess = cx.execute(
            "SELECT COUNT(*) AS n FROM sessions WHERE merchant_id=? AND created_at>=?",
            (merchant_id, since)
        ).fetchone()
        sessions_30 = int(sess["n"] or 0)

    app_fee_30 = 0.01 * gross
    net_30 = max(0.0, gross - fee - app_fee_30)

    usd_rate = PI_USD_RATE if PI_USD_RATE > 0 else None
    usd_estimate = (net_30 * usd_rate) if usd_rate else None

    return {
        "since_ts": since,
        "gross_30": gross,
        "fee_30": fee,
        "app_fee_30": app_fee_30,
        "net_30": net_30,
        "sessions_30": sessions_30,
        "usd_rate": usd_rate,
        "usd_estimate": usd_estimate,
    }

@app.get("/orders")
def orders_page():
    u = current_user_row()
    if not u:
        return render_template("my_orders.html", mode="auth", sandbox=PI_SANDBOX)

    uid = int(u["id"])

    with conn() as cx:
        purchases = cx.execute(
            """
            SELECT o.id, o.item_id, o.qty, o.pi_amount AS amount, o.status, o.pi_tx_hash,
                   i.title, m.business_name AS store
            FROM orders o
            JOIN items i      ON i.id = o.item_id
            JOIN merchants m  ON m.id = o.merchant_id
            WHERE o.buyer_user_id = ?
            ORDER BY o.id DESC
            LIMIT 100
            """,
            (uid,),
        ).fetchall()

        sales = cx.execute(
            """
            SELECT o.id, o.item_id, o.qty, o.pi_amount AS amount, o.status, o.pi_tx_hash,
                   i.title, m.business_name AS store, m.slug AS slug, m.id AS m_id,
                   m.pi_wallet_address AS wallet
            FROM orders o
            JOIN items i      ON i.id = o.item_id
            JOIN merchants m  ON m.id = o.merchant_id
            WHERE m.owner_user_id = ?
            ORDER BY o.id DESC
            LIMIT 200
            """,
            (uid,),
        ).fetchall()

        merchant = None
        stats = None
        if sales:
            merchant = {"id": sales[0]["m_id"], "business_name": sales[0]["store"], "slug": sales[0]["slug"], "wallet": sales[0]["wallet"]}
            stats = _merchant_30d_stats(merchant["id"])
        else:
            mrow = cx.execute(
                "SELECT id, business_name, slug, pi_wallet_address AS wallet FROM merchants WHERE owner_user_id=? LIMIT 1",
                (uid,),
            ).fetchone()
            if mrow:
                merchant = dict(mrow)
                stats = _merchant_30d_stats(merchant["id"])

    # NEW: mint a short-lived token so links work even if cookies are blocked
    try:
        tok = mint_login_token(uid)
    except Exception:
        tok = None

    return render_template(
        "my_orders.html",
        mode="list",
        user=u,
        purchases=[dict(r) for r in purchases],
        sales=[dict(r) for r in sales],
        merchant=merchant,
        stats=stats,
        sandbox=PI_SANDBOX,
        payout_sent=(request.args.get("payout") == "sent"),
        t=tok,   # <-- pass token
    )

# Trigger payout email (manual payout by app owner)
@app.post("/merchant/<slug>/payout")
def merchant_payout(slug):
    # Must be the owner of this merchant
    u, m = require_merchant_owner(slug)
    if isinstance(u, Response):
        return u

    # Keep bearer token across redirects (cookie-less flows)
    tok = request.form.get("t") or get_bearer_token_from_request()

    # --- 48h throttle check ---
    now = int(time.time())
    THROTTLE_SEC = 48 * 3600
    try:
        with conn() as cx:
            last = cx.execute(
                "SELECT requested_at FROM payout_requests "
                "WHERE merchant_id=? ORDER BY requested_at DESC LIMIT 1",
                (m["id"],)
            ).fetchone()
    except Exception:
        last = None

    if last:
        since = now - int(last["requested_at"])
        if since < THROTTLE_SEC:
            remain = THROTTLE_SEC - since
            mins = max(1, remain // 60)
            # Redirect back to Sales with throttle banner
            q = f"?payout_throttled=1&throttle_minutes={mins}"
            if tok: q += f"&t={tok}"
            return redirect(f"/merchant/{m['slug']}/orders{q}")

    # --- Compute last-30d stats and email details ---
    stats = _merchant_30d_stats(m["id"])
    gross_30    = float(stats["gross_30"] or 0)
    fee_30      = float(stats["fee_30"] or 0)
    app_fee_30  = float(stats["app_fee_30"] or 0)
    net_30      = float(stats["net_30"] or 0)
    wallet      = (m["pi_wallet_address"] or "").strip() or "(no wallet on file)"

    body = f"""
        <h2>Payout Request</h2>
        <p><strong>Store:</strong> {m['business_name']} (slug: {m['slug']})</p>
        <p><strong>Merchant Wallet:</strong> {wallet}</p>
        <h3>Last 30 Days</h3>
        <ul>
          <li>Gross: {gross_30:.7f} ÃÂ</li>
          <li>Pi Fee: {fee_30:.7f} ÃÂ</li>
          <li>App Fee (1%): {app_fee_30:.7f} ÃÂ</li>
          <li><strong>Net to pay:</strong> {net_30:.7f} ÃÂ</li>
        </ul>
        <p>Requested by @{u['pi_username']} (user_id {u['id']}).</p>
        <p><em>Note: Merchant UI informs payout may take up to 24 hours.</em></p>
    """.strip()

    ok = False
    try:
        ok = send_email(
            DEFAULT_ADMIN_EMAIL,
            f"[Payout] {m['business_name']} Ã¢ÂÂ {net_30:.7f} ÃÂ",
            body,
            reply_to=(m["reply_to_email"] or None),
        )
    except Exception:
        ok = False

    # Log the request only if we actually sent the email
    if ok:
        try:
            with conn() as cx:
                cx.execute(
                    "INSERT INTO payout_requests(merchant_id, requested_at) VALUES(?,?)",
                    (m["id"], now),
                )
        except Exception:
            pass

    # Redirect back to Sales with success or error flag (and preserve token)
    if ok:
        q = "?payout=sent"
    else:
        q = "?payout_error=1"
    if tok:
        q += f"&t={tok}"
    return redirect(f"/merchant/{m['slug']}/orders{q}")

# ----------------- BUYER STATUS / SUCCESS -----------------
@app.get("/o/<token>")
def buyer_status(token):
    with conn() as cx:
        o = cx.execute("SELECT * FROM orders WHERE buyer_token=?", (token,)).fetchone()
    if not o: abort(404)
    with conn() as cx:
        i = cx.execute("SELECT * FROM items WHERE id=?", (o["item_id"]),).fetchone()
        m = cx.execute("SELECT * FROM merchants WHERE id=?", (o["merchant_id"]),).fetchone()  # <-- tuple fixed
    return render_template("buyer_status.html", o=o, i=i, m=m, colorway=m["colorway"])

@app.get("/success")
def success():
    return render_template("success.html")

# ====== COLLECTIBLES — schema patch (IC purchases recorded separately) ======
with conn() as cx:
    cx.execute("""
        CREATE TABLE IF NOT EXISTS collectible_orders_ic(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          crafted_key TEXT,         -- e.g. "craft_<slug>_<ts>" from client
          title TEXT NOT NULL,
          slot TEXT,                -- head/chest/arms/legs/hands
          part TEXT,                -- helmet/vest/arms/legs/gun/melee (as provided by client)
          svg TEXT,                 -- sanitized SVG or inventory-safe icon (keep small)
          price_ic INTEGER NOT NULL,
          payment_method TEXT,      -- 'izza_coins'
          source TEXT,              -- 'game_shop' | 'crafting_ui' etc.
          created_at INTEGER NOT NULL
        )
    """)
    cx.execute("CREATE INDEX IF NOT EXISTS idx_collectible_orders_ic_user ON collectible_orders_ic(user_id)")
    cx.execute("CREATE INDEX IF NOT EXISTS idx_collectible_orders_ic_key ON collectible_orders_ic(crafted_key)")

# ====== COLLECTIBLES — record IC collectible order from the game/shop ======
@app.post("/api/orders/collectible_ic")
def api_orders_collectible_ic():
    """
    Called by the game (armour_packs_plugin.js) after an IZZA coin purchase
    so IZZA Pay can reflect it in the player's collectibles.

    JSON body (already implemented in your plugin):
      {
        crafted_key, title, slot, part, svg, price_ic, payment_method, source
      }
    """
    u = current_user_row()
    if not u:
        return {"ok": False, "error": "auth_required"}, 401

    data = request.get_json(silent=True) or {}
    title   = (data.get("title") or "").strip() or "Untitled"
    key     = (data.get("crafted_key") or "").strip() or None
    slot    = (data.get("slot") or "").strip() or None
    part    = (data.get("part") or "").strip() or None
    svg     = (data.get("svg") or "").strip() or ""   # trust front-end sanitizer; server is not re-using this SVG beyond listing
    try:
        price_ic = int(data.get("price_ic") or 0)
    except Exception:
        price_ic = 0
    paym    = (data.get("payment_method") or "izza_coins").strip()
    source  = (data.get("source") or "game_shop").strip()

    if price_ic <= 0:
        return {"ok": False, "error": "bad_amount"}, 400

    with conn() as cx:
        cx.execute("""
          INSERT INTO collectible_orders_ic(
            user_id, crafted_key, title, slot, part, svg, price_ic, payment_method, source, created_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?)
        """, (
            int(u["id"]), key, title, slot, part, svg, int(price_ic), paym, source, int(time.time())
        ))

    # Side-effect: optional grant hook (no-op if you prefer client-side inventory only)
    try:
        # If we received a crafted_key, grant 1 copy for the buyer (mirrors your Pi grant path)
        if key:
            _grant_crafting_item(int(u["id"]), key, 1)
    except Exception:
        pass

    return {"ok": True}

# ====== COLLECTIBLES — unified feed for Crafting Land UI ======
@app.get("/api/crafts/feed")
def api_crafts_feed():
    """
    Returns one payload the CRAFTS page can render.
    - creations:      items the user CREATED via crafting UI (table: crafted_items)
    - purchases_ic:   collectibles purchased with IZZA coins (table: collectible_orders_ic)
    - purchases_pi:   collectibles purchased via Pi checkout (orders joined to items)
    - claims:         map of {order_id: true} for claimed Pi collectibles
    """
    u = current_user_row()
    if not u:
        return {"ok": True, "creations": [], "purchases_ic": [], "purchases_pi": [], "claims": {}}

    uid = int(u["id"])

    # 1) My creations (from crafting UI)
    with conn() as cx:
        rows = cx.execute("""
            SELECT id, name, sku, image, meta_json, created_at
            FROM crafted_items
            WHERE user_id=?
            ORDER BY id DESC
        """, (uid,)).fetchall()
    creations = []
    for r in rows:
        try:
            meta = json.loads(r["meta_json"] or "{}") or {}
        except Exception:
            meta = {}
        creations.append({
            "id": int(r["id"]),
            "name": r["name"],
            "sku": r["sku"],
            "image": r["image"],
            "meta": meta,
            "created_at": int(r["created_at"] or 0),
        })

    # 2) IC purchases (from the new table)
    with conn() as cx:
        ic_rows = cx.execute("""
            SELECT id, crafted_key, title, slot, part, svg, price_ic, payment_method, source, created_at
            FROM collectible_orders_ic
            WHERE user_id=?
            ORDER BY id DESC
        """, (uid,)).fetchall()
    purchases_ic = [dict(r) for r in ic_rows]

    # 3) Pi collectibles (orders w/ fulfillment_kind='crafting')
    with conn() as cx:
        pi_rows = cx.execute("""
            SELECT o.id            AS order_id,
                   o.qty           AS qty,
                   i.title         AS title,
                   i.image_url     AS image_url,
                   i.crafted_item_id AS crafted_item_id,
                   i.fulfillment_kind AS fulfillment_kind,
                   m.business_name AS store,
                   m.slug          AS mslug
            FROM orders o
            JOIN items i   ON i.id = o.item_id
            JOIN merchants m ON m.id = o.merchant_id
            WHERE o.status='paid'
              AND o.buyer_user_id = ?
              AND i.fulfillment_kind = 'crafting'
              AND i.crafted_item_id IS NOT NULL
            ORDER BY o.id DESC
        """, (uid,)).fetchall()

        # 4) Claim map (which Pi collectibles have been pulled into the game already)
        claimed_rows = cx.execute("""
            SELECT order_id FROM collectible_claims WHERE user_id=?
        """, (uid,)).fetchall()

    claims = { int(r["order_id"]): True for r in claimed_rows }
    purchases_pi = [{
        "order_id": int(r["order_id"]),
        "title": r["title"],
        "store": r["store"],
        "thumb_url": r["image_url"] or "",
        "crafted_item_id": r["crafted_item_id"],
        "qty": int(r["qty"] or 1),
        "claimed": bool(claims.get(int(r["order_id"])))
    } for r in pi_rows]

    return {
        "ok": True,
        "creations": creations,
        "purchases_ic": purchases_ic,
        "purchases_pi": purchases_pi,
        "claims": claims
    }

# ====== CRAFTS PAGE (game-side page; very small server view) ======
@app.get("/izza-game/crafts")
def game_crafts_page():
    """
    Renders the CRAFTS page (game template). This DOES NOT duplicate /orders.
    It simply ships a shell that calls /api/crafts/feed on load and renders tabs:
      - CRAFTS (my creations)
      - PURCHASES (IC + Pi collectibles)
    """
    u = require_user()
    if isinstance(u, Response):  # redirected to signin if needed
        return u
    # Token helps the game template call APIs if third-party cookies are blocked
    try:
        tok = mint_login_token(int(u["id"]))
    except Exception:
        tok = None
    return render_template("crafts.html", t=tok, sandbox=PI_SANDBOX)

# =========================================================================== #
# ----------------- MAIN -----------------
if __name__ == "__main__":
    port = int(os.getenv("PORT", "5000"))
    app.run(host="0.0.0.0", port=port, debug=False)
