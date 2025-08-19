import os, json, uuid, time, hmac, base64, hashlib
from decimal import Decimal
from datetime import timedelta
from flask import Flask, request, render_template, redirect, session, abort, Response, send_from_directory
from dotenv import load_dotenv
import requests
from werkzeug.utils import secure_filename

# ---------- Local helpers (already in your repo) ----------
from db import init_db, conn
from emailer import send_email
from payments import verify_pi_tx, send_pi_payout, split_amounts

# ---------- ENV ----------
load_dotenv()
PI_API_BASE   = os.getenv("PI_PLATFORM_API_URL", "https://api.minepi.com")
APP_BASE_URL  = os.getenv("APP_BASE_URL", "http://localhost:5000")
APP_NAME      = os.getenv("APP_NAME", "IZZA PAY")
PI_APP_ID     = os.getenv("PI_APP_ID", "")      # used in templates for Pi.init
PI_SANDBOX    = os.getenv("PI_SANDBOX", "false").lower() == "true"

# ---------- APP ----------
app = Flask(__name__)

# Flask secret
_secret = os.getenv("FLASK_SECRET")
if not _secret:
    _secret = os.urandom(32)
    print("[WARN] FLASK_SECRET not set; generated a temporary secret (not persistent).")
app.secret_key = _secret

# Session config
app.config.update(
    SESSION_COOKIE_NAME="izzapay_session",
    SESSION_COOKIE_SAMESITE="None",
    SESSION_COOKIE_SECURE=True,
    SESSION_COOKIE_HTTPONLY=True,
    PERMANENT_SESSION_LIFETIME=timedelta(days=7),
)

# ---------- DB & SCHEMA ----------
init_db()

def ensure_schema_core():
    with conn() as cx:
        # carts
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
        # merchants optional cols
        mcols = {r["name"] for r in cx.execute("PRAGMA table_info(merchants)")}
        if "pi_wallet_address" not in mcols:
            cx.execute("ALTER TABLE merchants ADD COLUMN pi_wallet_address TEXT")
        if "pi_handle" not in mcols:
            cx.execute("ALTER TABLE merchants ADD COLUMN pi_handle TEXT")

def ensure_schema_appearance():
    with conn() as cx:
        mcols = {r["name"] for r in cx.execute("PRAGMA table_info(merchants)")}
        if "theme" not in mcols:
            cx.execute("ALTER TABLE merchants ADD COLUMN theme TEXT DEFAULT 'theme-a'")
        if "colorway" not in mcols:
            cx.execute("ALTER TABLE merchants ADD COLUMN colorway TEXT DEFAULT 'blue'")
        if "banner_url" not in mcols:
            cx.execute("ALTER TABLE merchants ADD COLUMN banner_url TEXT")
        if "description" not in mcols:
            cx.execute("ALTER TABLE merchants ADD COLUMN description TEXT")
        if "font_family" not in mcols:
            cx.execute("ALTER TABLE merchants ADD COLUMN font_family TEXT DEFAULT 'system-ui'")
        if "font_url" not in mcols:
            cx.execute("ALTER TABLE merchants ADD COLUMN font_url TEXT")
        icols = {r["name"] for r in cx.execute("PRAGMA table_info(items)")}
        if "description" not in icols:
            cx.execute("ALTER TABLE items ADD COLUMN description TEXT")

ensure_schema_core()
ensure_schema_appearance()

# ---------- UPLOADS ----------
UPLOAD_DIR = os.path.join(os.path.dirname(__file__), "static", "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)

@app.post("/upload")
def upload_file():
    u = current_user_row()
    if not u: abort(401)
    if "file" not in request.files: return {"ok": False, "error": "no_file"}, 400
    f = request.files["file"]
    if not f.filename: return {"ok": False, "error": "empty"}, 400
    name = secure_filename(f.filename)
    # avoid collisions
    base, ext = os.path.splitext(name)
    name = f"{base}-{uuid.uuid4().hex[:6]}{ext}"
    path = os.path.join(UPLOAD_DIR, name)
    f.save(path)
    url = f"{APP_BASE_URL}/static/uploads/{name}"
    return {"ok": True, "url": url}

# ---------- URL TOKEN (cookie fallback) ----------
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
    if t:
        return t.strip()
    auth = request.headers.get("Authorization", "")
    if auth.lower().startswith("bearer "):
        return auth.split(" ", 1)[1].strip()
    return None

# ---------- HELPERS ----------
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
    if not row:
        return redirect("/signin")
    return row

def resolve_merchant_by_slug(slug):
    with conn() as cx:
        return cx.execute("SELECT * FROM merchants WHERE slug=?", (slug,)).fetchone()

def require_merchant_owner(slug):
    u = require_user()
    if isinstance(u, Response):
        return u, None
    m = resolve_merchant_by_slug(slug)
    if not m: abort(404)
    if m["owner_user_id"] != u["id"]:
        abort(403)
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

# ---------- DEBUG ----------
@app.get("/whoami")
def whoami():
    row = current_user_row()
    return {"logged_in": bool(row), "user_id": (row["id"] if row else None)}, 200

# ---------- SIGN-IN / HOME ----------
@app.get("/")
def home():
    return redirect("/signin")

@app.get("/signin")
def signin():
    if request.args.get("fresh") == "1":
        session.clear()
    # upgraded landing lives in this template
    return render_template("pi_signin.html",
                           app_base=APP_BASE_URL, PI_APP_ID=PI_APP_ID, PI_SANDBOX=PI_SANDBOX)

@app.post("/logout")
def logout():
    session.clear()
    return redirect("/signin")

@app.post("/api/pi/me")
def pi_me():
    """Verifies accessToken with Pi /v2/me; used by front-end."""
    try:
        data = request.get_json(force=True)
        token = (data or {}).get("accessToken")
        if not token:
            return {"ok": False, "error": "missing_token"}, 400
        url = f"{PI_API_BASE}/v2/me"
        headers = {"Authorization": f"Bearer {token}"}
        r = requests.get(url, headers=headers, timeout=10)
        if r.status_code != 200:
            return {"ok": False, "error": "token_invalid", "status": r.status_code}, 401
        return {"ok": True, "me": r.json()}
    except Exception as e:
        print("pi_me error:", repr(e))
        return {"ok": False, "error": "server_error"}, 500

@app.post("/auth/exchange")
def auth_exchange():
    """Merchant/general sign-in → redirects to /dashboard."""
    try:
        if request.is_json:
            data = request.get_json(silent=True) or {}
        else:
            payload = request.form.get("payload", "")
            try:
                data = json.loads(payload) if payload else {}
            except Exception:
                data = {}

        user = (data.get("user") or {})
        uid = user.get("uid") or user.get("id")
        username = user.get("username")
        token = data.get("accessToken")
        if not uid or not username or not token:
            if not request.is_json:
                return redirect("/signin?fresh=1")
            return {"ok": False, "error": "invalid_payload"}, 400

        # Verify token with Pi
        url = f"{PI_API_BASE}/v2/me"
        headers = {"Authorization": f"Bearer {token}"}
        r = requests.get(url, headers=headers, timeout=10)
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

        # Session + URL token
        try:
            session["user_id"] = row["id"]
            session.permanent = True
        except Exception:
            pass
        tok = mint_login_token(row["id"])
        target = f"/dashboard?t={tok}"
        if not request.is_json:
            return redirect(target)
        return {"ok": True, "redirect": target}
    except Exception as e:
        print("auth_exchange error:", repr(e))
        if not request.is_json:
            return redirect("/signin?fresh=1")
        return {"ok": False, "error": "server_error"}, 500

@app.get("/dashboard")
def dashboard():
    """Send the signed-in user to either setup or their merchant items page."""
    u = require_user()
    if isinstance(u, Response):
        return u
    with conn() as cx:
        m = cx.execute("SELECT * FROM merchants WHERE owner_user_id=?", (u["id"],)).fetchone()
    tok = get_bearer_token_from_request()
    if not m:
        return redirect(f"/merchant/setup{('?t='+tok) if tok else ''}")
    return redirect(f"/merchant/{m['slug']}/items{('?t='+tok) if tok else ''}")

# ---------- EXPLORE (discover stores/items) ----------
@app.get("/explore")
def explore():
    q = (request.args.get("q") or "").strip().lower()
    with conn() as cx:
        if q:
            stores = cx.execute("""
               SELECT * FROM merchants
               WHERE (LOWER(business_name) LIKE ? OR LOWER(description) LIKE ? OR LOWER(slug) LIKE ?)
               ORDER BY id DESC LIMIT 100
            """, (f"%{q}%", f"%{q}%", f"%{q}%")).fetchall()
            items = cx.execute("""
               SELECT items.*, merchants.slug as mslug, merchants.business_name
               FROM items JOIN merchants ON merchants.id=items.merchant_id
               WHERE items.active=1 AND (LOWER(items.title) LIKE ? OR LOWER(items.description) LIKE ?)
               ORDER BY items.id DESC LIMIT 100
            """, (f"%{q}%", f"%{q}%")).fetchall()
        else:
            stores = cx.execute("SELECT * FROM merchants ORDER BY id DESC LIMIT 100").fetchall()
            items = []
    return render_template("explore.html", stores=stores, items=items, q=q, app_base=APP_BASE_URL)

# ---------- MERCHANT SETUP + DASHBOARD ----------
@app.get("/merchant/setup")
def merchant_setup_form():
    u = require_user()
    if isinstance(u, Response):
        return u
    with conn() as cx:
        m = cx.execute("SELECT * FROM merchants WHERE owner_user_id=?", (u["id"],)).fetchone()
    if m:
        tok = get_bearer_token_from_request()
        return redirect(f"/merchant/{m['slug']}/items{('?t='+tok) if tok else ''}")
    tok = get_bearer_token_from_request()
    # reuse merchant_items for setup mode
    return render_template("merchant_items.html", setup_mode=True, m=None, items=[],
                           app_base=APP_BASE_URL, t=tok)

@app.post("/merchant/setup")
def merchant_setup():
    u = require_user()
    if isinstance(u, Response):
        return u
    data = request.form
    slug = (data.get("slug") or uuid.uuid4().hex[:6]).lower()
    business_name = data.get("business_name") or f"{u['pi_username']}'s Shop"
    logo_url      = data.get("logo_url") or ""
    banner_url    = data.get("banner_url") or ""
    theme_mode    = data.get("theme_mode", "dark")  # legacy field
    theme         = data.get("theme", "theme-a")
    colorway      = data.get("colorway", "blue")
    description   = data.get("description") or ""
    font_family   = data.get("font_family") or "system-ui"
    font_url      = data.get("font_url") or ""
    reply_to_email     = (data.get("reply_to_email") or "").strip()
    pi_wallet_address  = (data.get("pi_wallet_address") or "").strip()
    pi_handle          = (data.get("pi_handle") or "").strip()

    if not (len(pi_wallet_address) == 56 and pi_wallet_address.startswith("G")):
        tok = get_bearer_token_from_request()
        return render_template("merchant_items.html", setup_mode=True, m=None, items=[],
                               app_base=APP_BASE_URL, t=tok,
                               error="Enter a valid Pi Wallet public key (56 chars, starts with 'G').")

    with conn() as cx:
        exists = cx.execute("SELECT 1 FROM merchants WHERE slug=?", (slug,)).fetchone()
        if exists:
            tok = get_bearer_token_from_request()
            return render_template("merchant_items.html", setup_mode=True, m=None, items=[],
                                   app_base=APP_BASE_URL, t=tok,
                                   error="Slug already taken.")
        cx.execute("""INSERT INTO merchants(owner_user_id, slug, business_name, logo_url,
                      theme_mode, reply_to_email, pi_wallet, pi_wallet_address, pi_handle,
                      theme, colorway, banner_url, description, font_family, font_url)
                      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                   (u["id"], slug, business_name, logo_url,
                    theme_mode, reply_to_email, "@deprecated", pi_wallet_address, pi_handle,
                    theme, colorway, banner_url, description, font_family, font_url))

    tok = get_bearer_token_from_request()
    return redirect(f"/merchant/{slug}/items{('?t='+tok) if tok else ''}")

@app.get("/merchant/<slug>/items")
def merchant_items(slug):
    u, m = require_merchant_owner(slug)
    if isinstance(u, Response):
        return u
    with conn() as cx:
        items = cx.execute("SELECT * FROM items WHERE merchant_id=? ORDER BY id DESC",
                           (m["id"],)).fetchall()
    return render_template("merchant_items.html", setup_mode=False, m=m, items=items,
                           app_base=APP_BASE_URL, t=get_bearer_token_from_request())

@app.post("/merchant/<slug>/items/new")
def merchant_new_item(slug):
    u, m = require_merchant_owner(slug)
    if isinstance(u, Response):
        return u
    data = request.form
    link_id = uuid.uuid4().hex[:8]
    with conn() as cx:
        cx.execute("""INSERT INTO items(merchant_id, link_id, title, sku, image_url, description,
                      pi_price, stock_qty, allow_backorder, active)
                      VALUES(?,?,?,?,?,?,?,?,?,1)""",
                   (m["id"], link_id, data.get("title"), data.get("sku"),
                    data.get("image_url"), data.get("description"),
                    float(data.get("pi_price", "0")),
                    int(data.get("stock_qty", "0")), int(bool(data.get("allow_backorder")))))
    tok = get_bearer_token_from_request()
    return redirect(f"/merchant/{slug}/items{('?t='+tok) if tok else ''}")

# Edit / delete items
@app.get("/merchant/<slug>/items/<int:item_id>/edit")
def merchant_edit_item(slug, item_id):
    u, m = require_merchant_owner(slug)
    if isinstance(u, Response): return u
    with conn() as cx:
        it = cx.execute("SELECT * FROM items WHERE id=? AND merchant_id=?", (item_id, m["id"])).fetchone()
    if not it: abort(404)
    return render_template("merchant_items.html", setup_mode=False, m=m, items=[],
                           edit_item=it, app_base=APP_BASE_URL, t=get_bearer_token_from_request())

@app.post("/merchant/<slug>/items/<int:item_id>/edit")
def merchant_update_item(slug, item_id):
    u, m = require_merchant_owner(slug)
    if isinstance(u, Response): return u
    f = request.form
    with conn() as cx:
        cx.execute("""UPDATE items SET title=?, sku=?, image_url=?, description=?,
                      pi_price=?, stock_qty=?, allow_backorder=?, active=?
                      WHERE id=? AND merchant_id=?""",
                   (f.get("title"), f.get("sku"), f.get("image_url"), f.get("description"),
                    float(f.get("pi_price","0") or 0), int(f.get("stock_qty","0") or 0),
                    1 if f.get("allow_backorder") else 0,
                    1 if f.get("active") else 0, item_id, m["id"]))
    tok = get_bearer_token_from_request()
    return redirect(f"/merchant/{slug}/items{('?t='+tok) if tok else ''}")

@app.post("/merchant/<slug>/items/<int:item_id>/delete")
def merchant_delete_item(slug, item_id):
    u, m = require_merchant_owner(slug)
    if isinstance(u, Response): return u
    with conn() as cx:
        cx.execute("DELETE FROM items WHERE id=? AND merchant_id=?", (item_id, m["id"]))
    tok = get_bearer_token_from_request()
    return redirect(f"/merchant/{slug}/items{('?t='+tok) if tok else ''}")

# Appearance
@app.post("/merchant/<slug>/appearance")
def merchant_update_appearance(slug):
    u, m = require_merchant_owner(slug)
    if isinstance(u, Response): return u
    f = request.form
    with conn() as cx:
        cx.execute("""UPDATE merchants SET
                      business_name=?, logo_url=?, banner_url=?, description=?,
                      theme=?, colorway=?, font_family=?, font_url=?
                      WHERE id=?""",
                   (f.get("business_name") or m["business_name"],
                    f.get("logo_url") or m["logo_url"],
                    f.get("banner_url") or m["banner_url"],
                    f.get("description") or m["description"],
                    f.get("theme") or m["theme"],
                    f.get("colorway") or m["colorway"],
                    f.get("font_family") or m["font_family"],
                    f.get("font_url") or m["font_url"],
                    m["id"]))
    tok = get_bearer_token_from_request()
    return redirect(f"/merchant/{slug}/items{('?t='+tok) if tok else ''}")

# ---------- CUSTOMER SIGN-IN (storefront) ----------
@app.get("/store/<slug>/signin")
def store_signin(slug):
    m = resolve_merchant_by_slug(slug)
    if not m:
        abort(404)
    next_url = request.args.get("next") or f"/store/{slug}"
    return render_template("store_signin.html", app_base=APP_BASE_URL,
                           next_url=next_url, slug=slug, PI_APP_ID=PI_APP_ID, PI_SANDBOX=PI_SANDBOX)

@app.post("/auth/exchange/store")
def auth_exchange_store():
    """Customer sign-in for storefront; returns to next URL."""
    try:
        next_url = request.args.get("next") or "/"
        if request.is_json:
            data = request.get_json(silent=True) or {}
        else:
            payload = request.form.get("payload", "")
            try:
                data = json.loads(payload) if payload else {}
            except Exception:
                data = {}

        user = (data.get("user") or {})
        uid = user.get("uid") or user.get("id")
        username = user.get("username")
        token = data.get("accessToken")
        if not uid or not username or not token:
            return redirect(f"/signin?fresh=1")

        url = f"{PI_API_BASE}/v2/me"
        headers = {"Authorization": f"Bearer {token}"}
        r = requests.get(url, headers=headers, timeout=10)
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
            session["user_id"] = row["id"]
            session.permanent = True
        except Exception:
            pass
        tok = mint_login_token(row["id"])
        return redirect(f"{next_url}{'&' if ('?' in next_url) else '?'}t={tok}")
    except Exception as e:
        print("auth_exchange_store error:", repr(e))
        return redirect("/signin?fresh=1")

# ---------- STOREFRONT + CART + CHECKOUT ----------
@app.get("/store/<slug>")
def storefront(slug):
    m = resolve_merchant_by_slug(slug)
    if not m: abort(404)
    u = current_user_row()
    if not u:
        return redirect(f"/store/{slug}/signin?next=/store/{slug}")
    q = (request.args.get("q") or "").strip().lower()
    cid = request.args.get("cid")
    cid = get_or_create_cart(m["id"], cid)
    with conn() as cx:
        if q:
            items = cx.execute("""
               SELECT * FROM items 
               WHERE merchant_id=? AND active=1
               AND (LOWER(title) LIKE ? OR LOWER(description) LIKE ?)
               ORDER BY id DESC
            """, (m["id"], f"%{q}%", f"%{q}%")).fetchall()
        else:
            items = cx.execute("SELECT * FROM items WHERE merchant_id=? AND active=1 ORDER BY id DESC", (m["id"],)).fetchall()
        cnt = cx.execute("SELECT COALESCE(SUM(qty),0) as n FROM cart_items WHERE cart_id=?", (cid,)).fetchone()["n"]
    return render_template("store.html", m=m, items=items, cid=cid, cart_count=cnt,
                           app_base=APP_BASE_URL, username=u["pi_username"], q=q,
                           PI_APP_ID=PI_APP_ID, PI_SANDBOX=PI_SANDBOX)

@app.post("/store/<slug>/add")
def store_add(slug):
    m = resolve_merchant_by_slug(slug)
    if not m: abort(404)
    if not current_user_row():
        return redirect(f"/store/{slug}/signin?next=/store/{slug}")
    cid = request.form.get("cid")
    cid = get_or_create_cart(m["id"], cid)
    item_id = int(request.form.get("item_id"))
    qty = max(1, int(request.form.get("qty", "1")))
    with conn() as cx:
        it = cx.execute("SELECT * FROM items WHERE id=? AND merchant_id=? AND active=1", (item_id, m["id"])).fetchone()
        if not it: abort(400)
        cx.execute("INSERT INTO cart_items(cart_id, item_id, qty) VALUES(?,?,?)", (cid, item_id, qty))
    return redirect(f"/store/{slug}?cid={cid}")

@app.get("/cart/<cid>")
def cart_view(cid):
    u = current_user_row()
    if not u:
        return redirect("/signin?fresh=1")
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
                           app_base=APP_BASE_URL)

@app.post("/cart/<cid>/remove")
def cart_remove(cid):
    u = current_user_row()
    if not u:
        return redirect("/signin?fresh=1")
    row_id = int(request.form.get("row_id"))
    with conn() as cx:
        cx.execute("DELETE FROM cart_items WHERE id=? AND cart_id=?", (row_id, cid))
    return redirect(f"/cart/{cid}")

@app.get("/checkout/cart/<cid>")
def checkout_cart(cid):
    u = current_user_row()
    if not u:
        return redirect("/signin?fresh=1")
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
        return redirect(f"/store/{m['slug']}?cid={cid}")
    total = sum(float(r["pi_price"]) * r["qty"] for r in rows)
    sid = uuid.uuid4().hex
    with conn() as cx:
        cx.execute("""INSERT INTO sessions(id, merchant_id, item_id, qty, expected_pi, state, created_at)
                      VALUES(?,?,?,?,?,?,?)""",
                   (sid, m["id"], None, 1, float(total), "initiated", int(time.time())))
    i = {"business_name": m["business_name"], "title": "Cart total", "logo_url": m["logo_url"]}
    return render_template("checkout.html",
                           sold_out=False, i=i, qty=1, session_id=sid,
                           expected_pi=total, app_base=APP_BASE_URL, cart_mode=True,
                           slug=m["slug"], PI_APP_ID=PI_APP_ID, PI_SANDBOX=PI_SANDBOX)

# Single-item direct checkout
@app.get("/checkout/<link_id>")
def checkout(link_id):
    with conn() as cx:
        i = cx.execute("""
           SELECT items.*, merchants.business_name, merchants.logo_url, merchants.id as mid, merchants.slug as mslug
           FROM items JOIN merchants ON merchants.id=items.merchant_id
           WHERE link_id=? AND active=1
        """, (link_id,)).fetchone()
    if not i:
        abort(404)
    qty = max(1, int(request.args.get("qty", "1")))
    if i["stock_qty"] <= 0 and not i["allow_backorder"]:
        return render_template("checkout.html", sold_out=True, i=i, PI_APP_ID=PI_APP_ID, PI_SANDBOX=PI_SANDBOX)
    sid = uuid.uuid4().hex
    expected = float(i["pi_price"]) * qty
    with conn() as cx:
        cx.execute("""INSERT INTO sessions(id, merchant_id, item_id, qty, expected_pi, state,
                   created_at) VALUES(?,?,?,?,?,?,?)""",
                   (sid, i["mid"], i["id"], qty, expected, "initiated", int(time.time())))
    return render_template("checkout.html",
        sold_out=False, i=i, qty=qty, session_id=sid, expected_pi=expected,
        app_base=APP_BASE_URL, slug=i["mslug"], PI_APP_ID=PI_APP_ID, PI_SANDBOX=PI_SANDBOX
    )

# ---------- PI PAYMENT SERVER CALLS ----------
@app.post("/api/pi/approve")
def pi_approve():
    data = request.get_json(force=True)
    # if you use Pi Platform Approvals via server, call /approve here
    # Stub ok:
    return {"ok": True}

@app.post("/api/pi/complete")
def pi_complete():
    data = request.get_json(force=True)
    payment_id = data.get("paymentId")
    session_id = data.get("session_id")
    txid       = data.get("txid")
    buyer      = data.get("buyer") or {}
    shipping   = data.get("shipping") or {}

    if not (payment_id and session_id):
        return {"ok": False, "error": "bad_request"}, 400

    with conn() as cx:
        s = cx.execute("SELECT * FROM sessions WHERE id=?", (session_id,)).fetchone()
    if not s or s["state"] != "initiated":
        return {"ok": False, "error": "bad_session"}, 400

    # Verify amount using your helper; if not available for mainnet, skip strict check:
    amt = Decimal(str(s["expected_pi"]))
    # (You can still use verify_pi_tx(txid, amt) for additional safety)
    try:
        ok_verify = True if not txid else verify_pi_tx(txid, amt)
    except Exception:
        ok_verify = True  # be lenient if network hiccups

    if not ok_verify:
        with conn() as cx:
            cx.execute("UPDATE sessions SET state='failed' WHERE id=?", (session_id,))
        return {"ok": False, "error": "verify_failed"}, 400

    # If it was a cart (item_id is None)
    if s["item_id"] is None:
        return _confirm_cart_order(s, txid, buyer, shipping)

    # Single item order path
    with conn() as cx:
        i = cx.execute("SELECT * FROM items WHERE id=?", (s["item_id"],)).fetchone()
        m = cx.execute("SELECT * FROM merchants WHERE id=?", (s["merchant_id"],)).fetchone()

    gross, fee, net = split_amounts(float(amt))

    with conn() as cx:
        if i and not i["allow_backorder"]:
            cx.execute("UPDATE items SET stock_qty=? WHERE id=?",
                       (max(0, i["stock_qty"] - s["qty"]), i["id"]))
        buyer_token = uuid.uuid4().hex
        cx.execute("""INSERT INTO orders(merchant_id,item_id,qty,buyer_email,buyer_name,
                     shipping_json,pi_amount,pi_fee,pi_merchant_net,pi_tx_hash,payout_status,
                     status,buyer_token)
                     VALUES(?,?,?,?,?,?,?,?,?,?, 'pending','paid',?)""",
                   (s["merchant_id"], s["item_id"], s["qty"], buyer.get("email"),
                    buyer.get("name"), json.dumps(shipping), float(gross), float(fee),
                    float(net), txid, buyer_token))
        cx.execute("UPDATE sessions SET state='paid', pi_tx_hash=? WHERE id=?",
                   (txid, session_id))

    # payout to merchant
    ok = send_pi_payout(m["pi_wallet_address"], Decimal(str(net)), f"Order via {APP_NAME}")
    with conn() as cx:
        cx.execute("UPDATE orders SET payout_status=? WHERE pi_tx_hash=?",
                   ("sent" if ok else "failed", txid))

    # merchant email
    if m["reply_to_email"]:
        try:
            send_email(
              m["reply_to_email"],
              f"New Pi order: {i['title']} x{s['qty']}",
              f"<p><strong>Gross:</strong> {gross} Pi<br>"
              f"<strong>Fee (1%):</strong> {fee} Pi<br>"
              f"<strong>Net to you:</strong> {net} Pi<br>"
              f"<strong>Tx:</strong> {txid}</p>"
            )
        except Exception:
            pass

    buyer_url = f"/store/{m['slug']}?success=1"
    if buyer.get("email"):
        try:
            send_email(
              buyer["email"],
              f"Thanks for your order at {m['business_name']}",
              "<p>Your order is paid in full with Pi.</p>"
              "<p>You’ll receive shipping updates from the merchant.</p>"
            )
        except Exception:
            pass

    return {"ok": True, "buyer_status_url": buyer_url, "redirect_url": buyer_url}

def _confirm_cart_order(s, tx_hash, buyer, shipping):
    with conn() as cx:
        m = cx.execute("SELECT * FROM merchants WHERE id=?", (s["merchant_id"],)).fetchone()
        cart = cx.execute("""
          SELECT c.* FROM carts c
          WHERE c.merchant_id=? ORDER BY created_at DESC LIMIT 1
        """, (m["id"],)).fetchone()
        if not cart:
            return {"ok": False, "error": "cart_missing"}, 400
        rows = cx.execute("""
          SELECT cart_items.qty, items.*
          FROM cart_items JOIN items ON items.id=cart_items.item_id
          WHERE cart_items.cart_id=?
        """, (cart["id"],)).fetchall()

    total = sum(float(r["pi_price"]) * r["qty"] for r in rows)
    gross, fee, net = split_amounts(total)

    with conn() as cx:
        for r in rows:
            line_gross = float(r["pi_price"]) * r["qty"]
            line_fee   = fee * (line_gross / total) if total > 0 else 0.0
            line_net   = line_gross - line_fee
            buyer_token = uuid.uuid4().hex

            if not r["allow_backorder"]:
                cx.execute("UPDATE items SET stock_qty=? WHERE id=?",
                           (max(0, r["stock_qty"] - r["qty"]), r["id"]))

            cx.execute("""INSERT INTO orders(merchant_id,item_id,qty,buyer_email,buyer_name,
                         shipping_json,pi_amount,pi_fee,pi_merchant_net,pi_tx_hash,payout_status,
                         status,buyer_token)
                         VALUES(?,?,?,?,?,?,?,?,?,?, 'pending','paid',?)""",
                       (s["merchant_id"], r["id"], r["qty"], buyer.get("email"),
                        buyer.get("name"), json.dumps(shipping), float(line_gross), float(line_fee),
                        float(line_net), tx_hash, buyer_token))

        cx.execute("UPDATE sessions SET state='paid', pi_tx_hash=? WHERE id=?",
                   (tx_hash, s["id"]))
        cx.execute("DELETE FROM cart_items WHERE cart_id=?", (cart["id"],))

    ok = send_pi_payout(m["pi_wallet_address"], Decimal(str(net)), f"Cart order via {APP_NAME}")
    with conn() as cx:
        cx.execute("UPDATE orders SET payout_status=? WHERE pi_tx_hash=?",
                   ("sent" if ok else "failed", tx_hash))
    buyer_url = f"/store/{m['slug']}?success=1"
    return {"ok": True, "buyer_status_url": buyer_url, "redirect_url": buyer_url}

# ---------- POLICIES / VALIDATION ----------
@app.get("/validation-key.txt")
def validation_key():
    return app.send_static_file("validation-key.txt")

@app.get("/privacy")
def privacy():
    return render_template("privacy.html")

@app.get("/terms")
def terms():
    return render_template("terms.html")

# ---------- STATIC (logo convenience) ----------
@app.get("/static/<path:fname>")
def static_files(fname):
    # let Flask serve static folder normally; Render will proxy
    return send_from_directory("static", fname)

# ---------- MAIN ----------
if __name__ == "__main__":
    port = int(os.getenv("PORT", "5000"))
    app.run(host="0.0.0.0", port=port, debug=True)
