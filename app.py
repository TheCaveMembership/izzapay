import os, json, uuid, time, hmac, base64, hashlib
from decimal import Decimal, ROUND_HALF_UP
from datetime import timedelta
from urllib.parse import urlparse
from flask import Flask, request, render_template, redirect, session, abort, Response
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
        # --- merchants patches ---
        mcols = {r["name"] for r in cx.execute("PRAGMA table_info(merchants)")}
        if "pi_wallet_address" not in mcols:
            try:
                cx.execute("ALTER TABLE merchants ADD COLUMN pi_wallet_address TEXT")
                log("[schema] added merchants.pi_wallet_address")
            except Exception as e:
                log("[schema] add merchants.pi_wallet_address failed:", repr(e))
        if "pi_handle" not in mcols:
            try:
                cx.execute("ALTER TABLE merchants ADD COLUMN pi_handle TEXT")
                log("[schema] added merchants.pi_handle")
            except Exception as e:
                log("[schema] add merchants.pi_handle failed:", repr(e))
        if "colorway" not in mcols:
            try:
                cx.execute("ALTER TABLE merchants ADD COLUMN colorway TEXT")
                log("[schema] added merchants.colorway")
            except Exception as e:
                log("[schema] add merchants.colorway failed:", repr(e))

        # --- carts & cart_items (create if missing) ---
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

        # --- sessions patches ---
        scols = {r["name"] for r in cx.execute("PRAGMA table_info(sessions)")}
        if "pi_payment_id" not in scols:
            try:
                cx.execute("ALTER TABLE sessions ADD COLUMN pi_payment_id TEXT")
                log("[schema] added sessions.pi_payment_id")
            except Exception as e:
                log("[schema] add sessions.pi_payment_id failed:", repr(e))
        if "cart_id" not in scols:
            try:
                cx.execute("ALTER TABLE sessions ADD COLUMN cart_id TEXT")
                log("[schema] added sessions.cart_id")
            except Exception as e:
                log("[schema] add sessions.cart_id failed:", repr(e))
        if "line_items_json" not in scols:
            try:
                cx.execute("ALTER TABLE sessions ADD COLUMN line_items_json TEXT")
                log("[schema] added sessions.line_items_json")
            except Exception as e:
                log("[schema] add sessions.line_items_json failed:", repr(e))
        if "user_id" not in scols:
            try:
                cx.execute("ALTER TABLE sessions ADD COLUMN user_id INTEGER")
                log("[schema] added sessions.user_id")
            except Exception as e:
                log("[schema] add sessions.user_id failed:", repr(e))

        # --- orders patches ---
        ocols = {r["name"] for r in cx.execute("PRAGMA table_info(orders)")}
        if "buyer_user_id" not in ocols:
            try:
                cx.execute("ALTER TABLE orders ADD COLUMN buyer_user_id INTEGER")
                log("[schema] added orders.buyer_user_id")
            except Exception as e:
                log("[schema] add orders.buyer_user_id failed:", repr(e))

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

# ----------------- ORDERS PAGE -----------------
@app.get("/orders")
def orders_page():
    # If there is a t= token, accept it
    tok = get_bearer_token_from_request()
    if tok:
        uid = verify_login_token(tok)
        if uid:
            try:
                session["user_id"] = uid
                session.permanent = True
            except Exception:
                pass

    u = current_user_row()
    if not u:
        # Not signed in -> show the one-button Pi auth page
        return render_template("my_orders.html", mode="auth", sandbox=PI_SANDBOX)

    # Signed in -> build the lists
    with conn() as cx:
        # If they own a store, fetch it once
        merchant = cx.execute(
            "SELECT * FROM merchants WHERE owner_user_id=?", (u["id"],)
        ).fetchone()

        # PURCHASES:
        # 1) Normal path: orders that already have buyer_user_id = current user
        # 2) Fallback path: join to sessions on matching tx hash where sessions.user_id = current user
        purchases = cx.execute(
            """
            SELECT o.id, o.qty, o.status, o.pi_amount, o.pi_tx_hash,
                   i.title AS item_title,
                   m.business_name AS m_name
            FROM orders o
            LEFT JOIN items     i ON i.id = o.item_id
            JOIN merchants m ON m.id = o.merchant_id
            LEFT JOIN sessions s ON s.pi_tx_hash = o.pi_tx_hash
            WHERE (o.buyer_user_id = ?)
               OR (s.user_id = ?)
            ORDER BY o.id DESC
            LIMIT 200
            """,
            (u["id"], u["id"])
        ).fetchall()

        # SALES (only if they have a merchant)
        if merchant:
            sales = cx.execute(
                """
                SELECT o.id, o.qty, o.status, o.pi_amount, o.pi_merchant_net,
                       i.title AS item_title
                FROM orders o
                JOIN items i ON i.id = o.item_id
                WHERE o.merchant_id = ?
                ORDER BY o.id DESC
                LIMIT 200
                """,
                (merchant["id"],)
            ).fetchall()
        else:
            sales = []

    return render_template(
        "my_orders.html",
        mode="list",
        user=u,
        purchases=purchases,
        merchant=merchant,
        sales=sales,
    )

@app.get("/api/my-orders")
def api_my_orders():
    """
    Returns the signed-in user's purchases and sales.
    Purchases:
      - Prefer orders where orders.buyer_user_id = uid
      - Also include orders whose pi_tx_hash matches a session whose user_id = uid (legacy)
    Sales:
      - Orders where the merchant's owner_user_id = uid
    """
    u = current_user_row()
    if not u:
        return {"ok": False, "error": "auth_required"}, 401
    uid = int(u["id"])

    try:
        with conn() as cx:
            # ---- Purchases (two sources unioned)
            purchases = cx.execute(
                """
                SELECT o.id, o.item_id, o.qty, o.pi_amount AS amount, o.status, o.pi_tx_hash,
                       i.title, m.business_name AS store
                FROM orders o
                LEFT JOIN items i      ON i.id = o.item_id
                JOIN merchants m  ON m.id = o.merchant_id
                WHERE o.buyer_user_id = ?
                ORDER BY o.id DESC
                LIMIT 100
                """,
                (uid,),
            ).fetchall()

            # legacy/backup: orders linked by tx -> sessions.user_id
            legacy = cx.execute(
                """
                SELECT o.id, o.item_id, o.qty, o.pi_amount AS amount, o.status, o.pi_tx_hash,
                       i.title, m.business_name AS store
                FROM orders o
                LEFT JOIN items i      ON i.id = o.item_id
                JOIN merchants m  ON m.id = o.merchant_id
                JOIN sessions s   ON s.pi_tx_hash = o.pi_tx_hash
                WHERE s.user_id = ?
                  AND (o.buyer_user_id IS NULL OR o.buyer_user_id = 0)
                ORDER BY o.id DESC
                LIMIT 100
                """,
                (uid,),
            ).fetchall()

            # de-dup: if any overlap, keep unique by id
            seen = set()
            purchases_rows = []
            for r in list(purchases) + list(legacy):
                if r["id"] in seen:
                    continue
                seen.add(r["id"])
                purchases_rows.append(dict(r))

            # ---- Sales (orders where I own the merchant)
            sales = cx.execute(
                """
                SELECT o.id, o.item_id, o.qty, o.pi_amount AS amount, o.status, o.pi_tx_hash,
                       i.title, m.business_name AS store
                FROM orders o
                JOIN items i      ON i.id = o.item_id
                JOIN merchants m  ON m.id = o.merchant_id
                WHERE m.owner_user_id = ?
                ORDER BY o.id DESC
                LIMIT 100
                """,
                (uid,),
            ).fetchall()

        return {
            "ok": True,
            "user": {"id": uid, "username": u["pi_username"]},
            "purchases": purchases_rows,
            "sales": [dict(r) for r in sales],
        }, 200

    except Exception as e:
        log("/api/my-orders error:", repr(e))
        return {"ok": False, "error": "server_error"}, 500500  # (kept as-is)

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
        # Accept either JSON (XHR) or form post (classic redirect flow)
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

        # Verify with Pi
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

        # Session + short-lived bearer
        try:
            session["user_id"] = row["id"]
            session.permanent = True
        except Exception:
            pass

        tok = mint_login_token(row["id"])

        # NEW: allow custom landing (e.g. /orders)
        next_path = request.args.get("next") or "/dashboard"
        if not next_path.startswith("/"):
            next_path = "/dashboard"
        target = f"{next_path}?t={tok}"

        # Form-post flow -> redirect
        if not request.is_json:
            return redirect(target)

        # JSON/XHR flow -> return token so caller can hit APIs
        return {"ok": True, "redirect": target, "token": tok}, 200

    except Exception as e:
        log("auth_exchange error:", repr(e))
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
        colorway=m["colorway"]
    )

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
        m = cx.execute("SELECT * FROM merchants WHERE id=?", (cart["merchant_id"],)).fetchone()  # fixed tuple
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

    # Calculate total and snapshot line items
    total = sum(float(r["pi_price"]) * r["qty"] for r in rows)
    sid = uuid.uuid4().hex
    line_items = json.dumps([
        {"item_id": int(r["id"]), "qty": int(r["qty"]), "price": float(r["pi_price"])}
        for r in rows
    ])

    # Save checkout session with attached user_id
    with conn() as cx:
        cx.execute(
            """INSERT INTO sessions(
                   id, merchant_id, item_id, qty, expected_pi, state,
                   created_at, cart_id, line_items_json, user_id
               )
               VALUES(?,?,?,?,?,?,?,?,?,?)""",
            (
                sid, m["id"], None, 1, float(total), "initiated",
                int(time.time()), cid, line_items, u["id"]
            )
        )

    # Minimal product-like object for checkout page
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
    )

@app.get("/checkout/<link_id>")
def checkout(link_id):
    # Load item + merchant
    with conn() as cx:
        i = cx.execute("""
           SELECT items.*, 
                  merchants.business_name, 
                  merchants.logo_url, 
                  merchants.id          AS mid,
                  merchants.colorway    AS colorway
           FROM items 
           JOIN merchants ON merchants.id = items.merchant_id
           WHERE link_id=? AND active=1
        """, (link_id,)).fetchone()
    if not i:
        abort(404)

    # Quantity & availability checks
    qty = max(1, int(request.args.get("qty", "1")))
    if i["stock_qty"] <= 0 and not i["allow_backorder"]:
        return render_template("checkout.html", sold_out=True, i=i, colorway=i["colorway"])

    # Build a new session for this checkout
    sid = uuid.uuid4().hex
    expected = float(i["pi_price"]) * qty

    # Snapshot the one line so fulfillment/emails use the same unified path
    line_items = json.dumps([{
        "item_id": int(i["id"]),
        "qty": int(qty),
        "price": float(i["pi_price"]),
    }])

    # NEW: attach the currently signed-in user to this session (for "My Orders")
    u = current_user_row()
    uid = (u["id"] if u else None)

    with conn() as cx:
        cx.execute(
            """INSERT INTO sessions(
                   id, merchant_id, item_id, qty, expected_pi, state,
                   created_at, line_items_json, user_id
               )
               VALUES(?,?,?,?,?,?,?, ?, ?)""",
            (
                sid, i["mid"], i["id"], qty, expected, "initiated",
                int(time.time()), line_items, uid
            )
        )

    # Render the Pi checkout page
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
            return {"ok": False, "error": "approve_failed", "status": r.status_code, "body": r.text}, 502
        with conn() as cx:
            cx.execute("UPDATE sessions SET pi_payment_id=?, state=? WHERE id=?",
                       (payment_id, "approved", session_id))
        return {"ok": True}
    except Exception as e:
        log("pi_approve error:", repr(e))
        return {"ok": False, "error": "server_error"}, 500

@app.post("/api/pi/complete")
def pi_complete():
    data = request.get_json(force=True)
    log("[pi_complete] payload:", data)  # debug log
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
            return {"ok": False, "error": "complete_failed", "status": r.status_code, "body": r.text}, 502
    except Exception as e:
        log("pi_complete call error:", repr(e))
        return {"ok": False, "error": "server_error"}, 500
    with conn() as cx:
        s = cx.execute("SELECT * FROM sessions WHERE id=?", (session_id,)).fetchone()
    if not s or s["state"] not in ("initiated", "approved"):
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

# ---- ONE unified emailer for 1+ orders (single OR cart) --------------------
DEFAULT_ADMIN_EMAIL = os.getenv("DEFAULT_ADMIN_EMAIL", "info@izzapay.shop")

def send_order_emails_unified(order_ids):
    """
    Consolidated email for multi-item carts (also works for single).
    Returns True if at least one email was attempted (buyer or merchant), else False.
    """
    attempted_any = False
    try:
        if not order_ids:
            log("[mail][unified] no order_ids")
            return False
        ids = order_ids if isinstance(order_ids, (list, tuple)) else [order_ids]
        ids = [int(x) for x in ids]

        with conn() as cx:
            placeholders = ",".join("?" for _ in ids)
            q = f"""
                SELECT
                    o.*,
                    i.title          AS item_title,
                    i.sku            AS item_sku,
                    m.business_name  AS m_name,
                    m.reply_to_email AS m_email
                FROM orders o
                JOIN items     i ON i.id = o.item_id
                JOIN merchants m ON m.id = o.merchant_id
                WHERE o.id IN ({placeholders})
                ORDER BY o.id ASC
            """
            rows = cx.execute(q, ids).fetchall()

        if not rows:
            log("[mail][unified] query returned 0 rows for ids:", ids)
            return False

        multi = len(rows) > 1

        m_name        = rows[0]["m_name"]
        merchant_mail = (rows[0]["m_email"] or "").strip() or DEFAULT_ADMIN_EMAIL
        buyer_email   = (rows[0]["buyer_email"] or "").strip()
        buyer_name    = (rows[0]["buyer_name"] or "").strip()

        try:
            shipping_raw = rows[0]["shipping_json"]
            shipping = json.loads(shipping_raw) if shipping_raw else {}
        except Exception:
            shipping = {}

        total_gross = 0.0
        total_fee   = 0.0
        total_net   = 0.0
        line_html   = []

        for r in rows:
            title = r["item_title"] or "Item"
            qty   = int(r["qty"] or 1)
            gross = float(r["pi_amount"] or 0.0)
            fee   = float(r["pi_fee"] or 0.0)
            net   = float(r["pi_merchant_net"] or 0.0)

            total_gross += gross
            total_fee   += fee
            total_net   += net

            line_html.append(
                f"<tr>"
                f"<td style='padding:6px 8px'>{title}</td>"
                f"<td style='padding:6px 8px; text-align:right'>{qty}</td>"
                f"<td style='padding:6px 8px; text-align:right'>{gross:.7f} π</td>"
                f"</tr>"
            )

        items_table = (
            "<table style='border-collapse:collapse; width:100%; max-width:560px'>"
            "<thead>"
            "<tr>"
            "<th style='text-align:left; padding:6px 8px'>Item</th>"
            "<th style='text-align:right; padding:6px 8px'>Qty</th>"
            "<th style='text-align:right; padding:6px 8px'>Line Total</th>"
            "</tr>"
            "</thead>"
            "<tbody>" + "".join(line_html) + "</tbody>"
            "<tfoot>"
            f"<tr><td></td><td style='padding:6px 8px; text-align:right'><strong>Total</strong></td>"
            f"<td style='padding:6px 8px; text-align:right'><strong>{total_gross:.7f} π</strong></td></tr>"
            "</tfoot>"
            "</table>"
        )

        ship_parts = []
        if isinstance(shipping, dict):
            for k in ["name","email","phone","address","address2","city","state","postal_code","country"]:
                v = (shipping.get(k) or "").strip()
                if v:
                    ship_parts.append(f"<div><strong>{k.replace('_',' ').title()}:</strong> {v}</div>")
        shipping_html = "<h3 style='margin:16px 0 6px'>Shipping</h3>" + "".join(ship_parts) if ship_parts else ""

        item_count_suffix = f" [{len(rows)} items]" if multi else ""
        subj_buyer    = f"Your order at {m_name} is confirmed{item_count_suffix}"
        subj_merchant = f"New Pi order at {m_name} ({total_gross:.7f} π){item_count_suffix}"

        log(f"[mail][unified] rows={len(rows)} gross={total_gross:.7f} buyer={buyer_email or '—'} merchant={merchant_mail or '—'}")

        # Buyer email (optional)
        if buyer_email:
            try:
                send_email(
                    buyer_email,
                    subj_buyer,
                    f"""
                        <h2>Thanks for your order!</h2>
                        <p><strong>Store:</strong> {m_name}</p>
                        {items_table}
                        <p style="margin-top:12px">
                          You’ll receive updates from the merchant if anything changes.
                        </p>
                    """,
                    reply_to=merchant_mail
                )
                attempted_any = True
                log("[mail][unified] buyer email SENT ->", buyer_email)
            except Exception as e:
                log("[mail][unified] buyer email FAILED:", repr(e))
        else:
            log("[mail][unified] buyer email SKIPPED (no buyer_email)")

        # Merchant email (always attempt)
        try:
            send_email(
                merchant_mail,
                subj_merchant,
                f"""
                    <h2>You received a new {"multi-item" if multi else "single-item"} order</h2>
                    {items_table}
                    <p style="margin:10px 0 0">
                      <small>Fees total: {total_fee:.7f} π • Net total: {total_net:.7f} π</small>
                    </p>
                    <h3 style="margin:16px 0 6px">Buyer</h3>
                    <div>{buyer_name or '—'} ({buyer_email or '—'})</div>
                    {shipping_html}
                    <p style="margin-top:10px"><small>TX: {rows[0]['pi_tx_hash'] or '—'}</small></p>
                """
            )
            attempted_any = True
            log("[mail][unified] merchant email SENT ->", merchant_mail)
        except Exception as e:
            log("[mail][unified] merchant email FAILED:", repr(e))

    except Exception as e:
        log("[mail][unified] send_order_emails_unified error:", repr(e))
        return attempted_any

    return attempted_any

def send_cart_emails(m, rows, totals, buyer_email, buyer_name, shipping, tx_hash):
    """
    Send ONE consolidated email to buyer (if provided) and ONE to merchant
    for a cart checkout, listing all products and totals.
    """
    try:
        m_name        = m["business_name"]
        merchant_mail = (m["reply_to_email"] or "").strip() or DEFAULT_ADMIN_EMAIL

        # Build items table
        line_html = []
        for r in rows:
            title = r["title"] or "Item"
            qty   = int(r["qty"] or 1)
            gross = float(r["pi_price"] or 0.0) * qty
            line_html.append(
                f"<tr>"
                f"<td style='padding:6px 8px'>{title}</td>"
                f"<td style='padding:6px 8px; text-align:right'>{qty}</td>"
                f"<td style='padding:6px 8px; text-align:right'>{gross:.7f} π</td>"
                f"</tr>"
            )

        items_table = (
            "<table style='border-collapse:collapse; width:100%; max-width:560px'>"
            "<thead>"
            "<tr>"
            "<th style='text-align:left; padding:6px 8px'>Item</th>"
            "<th style='text-align:right; padding:6px 8px'>Qty</th>"
            "<th style='text-align:right; padding:6px 8px'>Line Total</th>"
            "</tr>"
            "</thead>"
            "<tbody>" + "".join(line_html) + "</tbody>"
            "<tfoot>"
            f"<tr><td></td><td style='padding:6px 8px; text-align:right'><strong>Total</strong></td>"
            f"<td style='padding:6px 8px; text-align:right'><strong>{totals['gross']:.7f} π</strong></td></tr>"
            "</tfoot>"
            "</table>"
        )

        # Shipping block
        ship_parts = []
        if isinstance(shipping, dict):
            for k in ["name","email","phone","address","address2","city","state","postal_code","country"]:
                v = (shipping.get(k) or "").strip()
                if v:
                    ship_parts.append(f"<div><strong>{k.replace('_',' ').title()}:</strong> {v}</div>")
        shipping_html = "<h3 style='margin:16px 0 6px'>Shipping</h3>" + "".join(ship_parts) if ship_parts else ""

        # Subjects
        subj_buyer    = f"Your order at {m_name} is confirmed [{len(rows)} items]"
        subj_merchant = f"New Pi order at {m_name} ({totals['gross']:.7f} π) [{len(rows)} items]"

        # Send buyer email (optional)
        if buyer_email:
            try:
                send_email(
                    buyer_email,
                    subj_buyer,
                    f"""
                        <h2>Thanks for your order!</h2>
                        <p><strong>Store:</strong> {m_name}</p>
                        {items_table}
                        <p style="margin-top:12px">
                          You’ll receive updates from the merchant if anything changes.
                        </p>
                    """,
                    reply_to=merchant_mail
                )
                log("[mail] cart buyer email SENT ->", buyer_email)
            except Exception as e:
                log("[mail] cart buyer email FAILED:", repr(e))
        else:
            log("[mail] cart buyer email SKIPPED (no buyer_email).")

        # Send merchant email (always)
        try:
            send_email(
                merchant_mail,
                subj_merchant,
                f"""
                    <h2>You received a new multi-item order (cart)</h2>
                    {items_table}
                    <p style="margin:10px 0 0">
                      <small>Estimated fee: {totals['fee']:.7f} π • Net total: {totals['net']:.7f} π</small>
                    </p>
                    <h3 style="margin:16px 0 6px">Buyer</h3>
                    <div>{buyer_name or '—'} ({buyer_email or '—'})</div>
                    {shipping_html}
                    <p style="margin-top:10px"><small>TX: {tx_hash or '—'}</small></p>
                """
            )
            log("[mail] cart merchant email SENT ->", merchant_mail)
        except Exception as e:
            log("[mail] cart merchant email FAILED:", repr(e))

def fulfill_session(s, tx_hash, buyer, shipping):
    # Merchant (read-only)
    with conn() as cx:
        m = cx.execute("SELECT * FROM merchants WHERE id=?", (s["merchant_id"],)).fetchone()

    # Money split on the session total
    amt = float(s["expected_pi"])
    gross_total, fee_total, net_total = split_amounts(amt)
    gross_total = float(gross_total); fee_total = float(fee_total); net_total = float(net_total)

    # Buyer info
    buyer_email = (buyer.get("email") or (shipping.get("email") if isinstance(shipping, dict) else None) or None)
    buyer_name  = buyer.get("name")  or (shipping.get("name")  if isinstance(shipping, dict) else None) or None

    # Always read the snapshot (single or multi)
    try:
        lines = json.loads(s["line_items_json"] or "[]")
    except Exception:
        lines = []

    if not lines:
        log("[fulfill_session] ERROR: no line_items_json for session", s["id"])
        with conn() as cx:
            cx.execute("UPDATE sessions SET state='paid', pi_tx_hash=? WHERE id=?", (tx_hash, s["id"]))
        try:
            send_email(
                (m["reply_to_email"] or DEFAULT_ADMIN_EMAIL),
                f"Order paid but no lines captured (session {s['id']})",
                "<p>The session was paid, but no line items snapshot was present.</p>"
            )
        except Exception as e:
            log("[fulfill_session] notify merchant failed:", repr(e))
        return {"ok": True, "redirect_url": f"{BASE_ORIGIN}/store/{m['slug']}?success=1"}

    # Fetch item records for titles/stock using IDs from the snapshot
    item_ids = [int(li["item_id"]) for li in lines]
    with conn() as cx:
        placeholders = ",".join("?" for _ in item_ids)
        items = cx.execute(f"SELECT * FROM items WHERE id IN ({placeholders})", item_ids).fetchall()
        by_id = {int(r["id"]): r for r in items}

    created_order_ids = []
    # Proportionally allocate fee across lines by their gross share
    total_snapshot_gross = sum(float(li["price"]) * int(li["qty"]) for li in lines) or 1.0

    with conn() as cx:
        for li in lines:
            it = by_id.get(int(li["item_id"]))
            qty = int(li["qty"])
            snap_price = float(li["price"])

            # compute from snapshot so emails and totals match exactly what user saw
            line_gross = snap_price * qty
            line_fee   = float(fee_total) * (line_gross / total_snapshot_gross)
            line_net   = line_gross - line_fee

            # stock update (only if the item still exists and doesn't allow backorder)
            if it and not it["allow_backorder"]:
                cx.execute(
                    "UPDATE items SET stock_qty=? WHERE id=?",
                    (max(0, it["stock_qty"] - qty), it["id"])
                )

            buyer_token   = uuid.uuid4().hex

            # Fallback: if old session lacks user_id, try current session
            try:
                buyer_user_id = s["user_id"]
            except Exception:
                buyer_user_id = None
            if not buyer_user_id:
                u_now = current_user_row()
                buyer_user_id = (u_now["id"] if u_now else None)

            cur = cx.execute(
                """INSERT INTO orders(
                     merchant_id,
                     item_id,
                     qty,
                     buyer_email,
                     buyer_name,
                     shipping_json,
                     pi_amount,
                     pi_fee,
                     pi_merchant_net,
                     pi_tx_hash,
                     payout_status,
                     status,
                     buyer_token,
                     buyer_user_id
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

            created_order_ids.append(cur.lastrowid)

        # Mark session paid
        cx.execute("UPDATE sessions SET state='paid', pi_tx_hash=? WHERE id=?", (tx_hash, s["id"]))

    # Build & send a single consolidated email from the snapshot
    try:
        # Fetch items again for titles (already in by_id, but ensure presence)
        display_rows = []
        for li in lines:
            it = by_id.get(int(li["item_id"]))
            title = (it["title"] if it else f"Item {li['item_id']}")
            qty = int(li["qty"])
            gross = float(li["price"]) * qty
            display_rows.append({"title": title, "qty": qty, "gross": gross})

        # HTML table
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
        subj_suffix = f" [{len(display_rows)} items]" if len(display_rows) > 1 else ""
        subj_buyer    = f"Your order at {m['business_name']} is confirmed{subj_suffix}"
        subj_merchant = f"New Pi order at {m['business_name']} ({gross_total:.7f} π){subj_suffix}"

        # Buyer (optional)
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
            log("[mail][unified] buyer email SENT ->", buyer_email)
        else:
            log("[mail][unified] buyer email skipped (no buyer_email)")

        # Merchant (always)
        send_email(
            merchant_mail,
            subj_merchant,
            f"""
                <h2>You received a new order</h2>
                {items_table}
                <p style="margin:10px 0 0">
                  <small>Fees total: {fee_total:.7f} π • Net total: {net_total:.7f} π</small>
                </p>
                <h3 style="margin:16px 0 6px">Buyer</h3>
                <div>{buyer_name or '—'} ({buyer_email or '—'})</div>
                <p style="margin-top:10px"><small>TX: {tx_hash or '—'}</small></p>
            """
        )
        log("[mail][unified] merchant email SENT ->", merchant_mail)

    except Exception as e:
        log("[fulfill_session] email build/send failed:", repr(e))

    # Redirect back to store
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
        m = cx.execute("SELECT * FROM merchants WHERE id=?", (o["merchant_id"],)).fetchone()  # fixed tuple
    return render_template("buyer_status.html", o=o, i=i, m=m, colorway=m["colorway"])

@app.get("/success")
def success():
    return render_template("success.html")

# ----------------- MAIN -----------------
if __name__ == "__main__":
    port = int(os.getenv("PORT", "5000"))
    app.run(host="0.0.0.0", port=port, debug=True)
