import os, json, uuid, time
from decimal import Decimal
from datetime import timedelta
from flask import Flask, request, render_template, redirect, session, abort, Response
from dotenv import load_dotenv

from db import init_db, conn
from emailer import send_email
from payments import verify_pi_tx, send_pi_payout, split_amounts

load_dotenv()

# Minimal env sanity log (won't print secrets)
if os.getenv("PI_PLATFORM_API_KEY"):
    print("[IZZA PAY] PI_PLATFORM_API_KEY detected (masked).")
else:
    print("[IZZA PAY] WARNING: PI_PLATFORM_API_KEY is not set.")

app = Flask(__name__)

# --- Secret key ---
_secret = os.getenv("FLASK_SECRET")
if not _secret:
    _secret = os.urandom(32)  # fallback so the app boots
    print("[WARN] FLASK_SECRET not set; generated a temporary secret (sessions reset on redeploy).")
app.secret_key = _secret

# --- Session cookie tuned for Pi sandbox wrapper (third-party/iframe context) ---
app.config.update(
    SESSION_COOKIE_NAME="izzapay_session",
    SESSION_COOKIE_SAMESITE="None",  # allow third-party context
    SESSION_COOKIE_SECURE=True,      # required with SameSite=None
    SESSION_COOKIE_HTTPONLY=True,
    PERMANENT_SESSION_LIFETIME=timedelta(days=7),  # keep users signed in for a week
)

APP_BASE_URL = os.getenv("APP_BASE_URL", "http://localhost:5000")
APP_NAME = os.getenv("APP_NAME", "IZZA PAY")

# Initialize DB
init_db()

# -------------------------
# Helpers
# -------------------------
def current_user_row():
    """Return sqlite3.Row for the logged-in user, or None."""
    uid = session.get("user_id")
    if not uid:
        return None
    with conn() as cx:
        return cx.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()

def require_user():
    """Return a redirect Response to /signin if not logged in, else the user Row."""
    uid = session.get("user_id")
    if not uid:
        return redirect("/signin")
    with conn() as cx:
        row = cx.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    if not row:
        session.clear()
        return redirect("/signin")
    return row

def require_merchant_owner(slug):
    """Return (Response, None) if redirect; else (user_row, merchant_row)."""
    u = require_user()
    if isinstance(u, Response):
        return u, None
    with conn() as cx:
        m = cx.execute("SELECT * FROM merchants WHERE slug=?", (slug,)).fetchone()
    if not m:
        abort(404)
    if m["owner_user_id"] != u["id"]:
        abort(403)
    return u, m

# -------------------------
# Debug helper (optional; remove later)
# -------------------------
@app.get("/whoami")
def whoami():
    uid = session.get("user_id")
    return {"logged_in": bool(uid), "user_id": uid}, 200

# -------------------------
# Public
# -------------------------
@app.get("/")
def home():
    # Redirect root to the Pi sign-in page (helpful for sandbox)
    return redirect("/signin")

@app.get("/signin")
def signin():
    # allow force-refresh of auth/session with /signin?fresh=1
    if request.args.get("fresh") == "1":
        session.clear()
    # Pi-only auth page (no email/password)
    return render_template("pi_signin.html", app_base=APP_BASE_URL)

@app.post("/logout")
def logout():
    session.clear()
    return redirect("/signin")

# Exchange Pi auth payload for a server session
# Accept BOTH: JSON (XHR) and form POST (top-level) — we'll prefer redirect on success.
@app.post("/auth/exchange")
def auth_exchange():
    """
    Front-end sends either:
      - JSON body: { user: {uid, username}, accessToken: "..." }   (XHR)
      - or form field 'payload' = same JSON string                 (top-level form POST)
    TODO (production): verify accessToken with Pi Platform on server side.
    """
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
        uid = user.get("uid")
        username = user.get("username")

        if not uid or not username:
            # If this was a top-level form POST, send the user back to /signin with error.
            if not request.is_json:
                return redirect("/signin?fresh=1")
            return {"ok": False, "error": "invalid_payload"}, 400

        # TODO: verify accessToken via Pi Platform API here (server side)

        with conn() as cx:
            row = cx.execute("SELECT * FROM users WHERE pi_uid=?", (uid,)).fetchone()
            if not row:
                cx.execute("""INSERT INTO users(pi_uid, pi_username, role, created_at)
                              VALUES(?, ?, 'buyer', ?)""",
                           (uid, username, int(time.time())))
                row = cx.execute("SELECT * FROM users WHERE pi_uid=?", (uid,)).fetchone()
        session["user_id"] = row["id"]
        session.permanent = True  # use PERMANENT_SESSION_LIFETIME

        # If it was a top-level form POST, do a server-side redirect (best for cookies).
        if not request.is_json:
            return redirect("/dashboard")
        # For XHR callers, return JSON and let the client redirect.
        return {"ok": True, "redirect": "/dashboard"}

    except Exception as e:
        print("auth_exchange error:", repr(e))
        if not request.is_json:
            return redirect("/signin?fresh=1")
        return {"ok": False, "error": "server_error"}, 500

@app.get("/dashboard")
def dashboard():
    u = require_user()
    if isinstance(u, Response):
        return u
    with conn() as cx:
        m = cx.execute("SELECT * FROM merchants WHERE owner_user_id=?", (u["id"],)).fetchone()
    return redirect("/merchant/setup" if not m else f"/merchant/{m['slug']}/items")

# -------------------------
# Merchant setup
# -------------------------
@app.get("/merchant/setup")
def merchant_setup_form():
    u = require_user()
    if isinstance(u, Response):
        return u
    with conn() as cx:
        m = cx.execute("SELECT * FROM merchants WHERE owner_user_id=?", (u["id"]),).fetchone()
    if m:
        return redirect(f"/merchant/{m['slug']}/items")
    return render_template("merchant_items.html", setup_mode=True, m=None, items=[],
                           app_base=APP_BASE_URL)

@app.post("/merchant/setup")
def merchant_setup():
    u = require_user()
    if isinstance(u, Response):
        return u
    data = request.form
    slug = (data.get("slug") or uuid.uuid4().hex[:6]).lower()
    business_name = data.get("business_name") or f"{u['pi_username']}'s Shop"
    pi_wallet = data.get("pi_wallet") or "@merchant"
    logo_url = data.get("logo_url") or "https://via.placeholder.com/160x40?text=Logo"
    theme_mode = data.get("theme_mode", "dark")
    reply_to_email = (data.get("reply_to_email") or "").strip()

    with conn() as cx:
        exists = cx.execute("SELECT 1 FROM merchants WHERE slug=?", (slug,)).fetchone()
        if exists:
            return render_template("merchant_items.html", setup_mode=True, m=None, items=[],
                                   app_base=APP_BASE_URL, error="Slug already taken.")
        cx.execute("""INSERT INTO merchants(owner_user_id, slug, business_name, logo_url,
                      theme_mode, reply_to_email, pi_wallet)
                      VALUES(?,?,?,?,?,?,?)""",
                   (u["id"], slug, business_name, logo_url, theme_mode, reply_to_email, pi_wallet))
    return redirect(f"/merchant/{slug}/items")

# -------------------------
# Merchant item management
# -------------------------
@app.get("/merchant/<slug>/items")
def merchant_items(slug):
    u, m = require_merchant_owner(slug)
    if isinstance(u, Response):
        return u
    with conn() as cx:
        items = cx.execute("SELECT * FROM items WHERE merchant_id=? ORDER BY id DESC",
                           (m["id"],)).fetchall()
    return render_template("merchant_items.html", setup_mode=False, m=m, items=items,
                           app_base=APP_BASE_URL)

@app.post("/merchant/<slug>/items/new")
def merchant_new_item(slug):
    u, m = require_merchant_owner(slug)
    if isinstance(u, Response):
        return u
    data = request.form
    link_id = uuid.uuid4().hex[:8]
    with conn() as cx:
        cx.execute("""INSERT INTO items(merchant_id, link_id, title, sku, image_url, pi_price,
                      stock_qty, allow_backorder, active)
                      VALUES(?,?,?,?,?,?,?,?,1)""",
                   (m["id"], link_id, data.get("title"), data.get("sku"),
                    data.get("image_url"), float(data.get("pi_price", "0")),
                    int(data.get("stock_qty", "0")), int(bool(data.get("allow_backorder")))))
    return redirect(f"/merchant/{slug}/items")

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
    return render_template("merchant_orders.html", m=m, orders=orders)

@app.post("/merchant/<slug>/orders/update")
def merchant_orders_update(slug):
    u, m = require_merchant_owner(slug)
    if isinstance(u, Response):
        return u
    order_id = int(request.form.get("order_id"))
    status = request.form.get("status")
    tracking_carrier = request.form.get("tracking_carrier")
    tracking_number = request.form.get("tracking_number")
    tracking_url = request.form.get("tracking_url")
    with conn() as cx:
        o = cx.execute("SELECT * FROM orders WHERE id=? AND merchant_id=?",
                       (order_id, m["id"])).fetchone()
        if not o:
            abort(404)
        cx.execute("""UPDATE orders SET status=?, tracking_carrier=?, tracking_number=?,
                      tracking_url=? WHERE id=?""",
                   (status or o["status"], tracking_carrier, tracking_number,
                    tracking_url, order_id))

    # Tracking email
    if (status or o["status"]) == "shipped" and o["buyer_email"]:
        body = f"<p>Your {m['business_name']} order has shipped.</p>"
        if tracking_number:
            link = tracking_url or "#"
            body += f"<p><strong>Tracking:</strong> {tracking_carrier} {tracking_number} — " \
                    f"<a href='{link}'>track package</a></p>"
        send_email(o["buyer_email"], f"Your {m['business_name']} order is on the way", body)

    return redirect(f"/merchant/{slug}/orders")

# -------------------------
# Buyer checkout
# -------------------------
@app.get("/checkout/<link_id>")
def checkout(link_id):
    with conn() as cx:
        i = cx.execute("""
           SELECT items.*, merchants.business_name, merchants.logo_url, merchants.id as mid
           FROM items JOIN merchants ON merchants.id=items.merchant_id
           WHERE link_id=? AND active=1
        """, (link_id,)).fetchone()
    if not i:
        abort(404)

    qty = max(1, int(request.args.get("qty", "1")))
    if i["stock_qty"] <= 0 and not i["allow_backorder"]:
        return render_template("checkout.html", sold_out=True, i=i)

    sid = uuid.uuid4().hex
    expected = float(i["pi_price"]) * qty
    now = int(time.time())
    with conn() as cx:
        cx.execute("""INSERT INTO sessions(id, merchant_id, item_id, qty, expected_pi, state,
                   created_at) VALUES(?,?,?,?,?,?,?)""",
                   (sid, i["mid"], i["id"], qty, expected, "initiated", now))
    return render_template(
        "checkout.html",
        sold_out=False, i=i, qty=qty, session_id=sid, expected_pi=expected, app_base=APP_BASE_URL
    )

@app.post("/api/pi/confirm")
def pi_confirm():
    data = request.get_json(force=True)
    session_id = data.get("session_id")
    tx_hash = data.get("tx_hash")
    buyer = data.get("buyer", {})
    shipping = data.get("shipping", {})

    with conn() as cx:
        s = cx.execute("SELECT * FROM sessions WHERE id=?", (session_id,)).fetchone()
    if not s or s["state"] != "initiated":
        return {"ok": False, "error": "bad_session"}, 400

    amt = Decimal(str(s["expected_pi"]))
    if not verify_pi_tx(tx_hash, amt):
        with conn() as cx:
            cx.execute("UPDATE sessions SET state='failed' WHERE id=?", (session_id,))
        return {"ok": False, "error": "verify_failed"}, 400

    gross, fee, net = split_amounts(float(amt))
    with conn() as cx:
        i = cx.execute("SELECT * FROM items WHERE id=?", (s["item_id"],)).fetchone()
        if i and not i["allow_backorder"]:
            cx.execute("UPDATE items SET stock_qty=? WHERE id=?",
                       (max(0, i["stock_qty"] - s["qty"]), i["id"]))
        m = cx.execute("SELECT * FROM merchants WHERE id=?", (s["merchant_id"]),).fetchone()
        buyer_token = uuid.uuid4().hex
        cx.execute("""INSERT INTO orders(merchant_id,item_id,qty,buyer_email,buyer_name,
                     shipping_json,pi_amount,pi_fee,pi_merchant_net,pi_tx_hash,payout_status,
                     status,buyer_token)
                     VALUES(?,?,?,?,?,?,?,?,?,?, 'pending','paid',?)""",
                   (s["merchant_id"], s["item_id"], s["qty"], buyer.get("email"),
                    buyer.get("name"), json.dumps(shipping), float(gross), float(fee),
                    float(net), tx_hash, buyer_token))
        cx.execute("UPDATE sessions SET state='paid', pi_tx_hash=? WHERE id=?",
                   (tx_hash, session_id))

    ok = send_pi_payout(m["pi_wallet"], Decimal(str(net)), f"Order via {APP_NAME}")
    with conn() as cx:
        cx.execute("UPDATE orders SET payout_status=? WHERE pi_tx_hash=?",
                   ("sent" if ok else "failed", tx_hash))

    if m["reply_to_email"]:
        try:
            send_email(
              m["reply_to_email"],
              f"New Pi order: {i['title']} x{s['qty']}",
              f"<p><strong>Gross:</strong> {gross} Pi<br>"
              f"<strong>Fee:</strong> {fee} Pi<br>"
              f"<strong>Net:</strong> {net} Pi<br>"
              f"<strong>Tx:</strong> {tx_hash}</p>"
            )
        except Exception:
            pass

    buyer_url = f"{APP_BASE_URL}/o/{buyer_token}"
    if buyer.get("email"):
        try:
            send_email(
              buyer["email"],
              f"Thanks for your order at {m['business_name']}",
              f"<p>Your order is paid in full with Pi.</p>"
              f"<p><a href='{buyer_url}'>Track your order here</a>.</p>"
            )
        except Exception:
            pass

    return {"ok": True, "buyer_status_url": buyer_url}

@app.get("/o/<token>")
def buyer_status(token):
    with conn() as cx:
        o = cx.execute("SELECT * FROM orders WHERE buyer_token=?", (token,)).fetchone()
    if not o:
        abort(404)
    with conn() as cx:
        i = cx.execute("SELECT * FROM items WHERE id=?", (o["item_id"]),).fetchone()
        m = cx.execute("SELECT * FROM merchants WHERE id=?", (o["merchant_id"]),).fetchone()
    return render_template("buyer_status.html", o=o, i=i, m=m)

@app.get("/success")
def success():
    return render_template("success.html")

# -------------------------
# Domain validation for Pi
# -------------------------
@app.get("/validation-key.txt")
def validation_key():
    # Put your key at static/validation-key.txt
    return app.send_static_file("validation-key.txt")

# -------------------------
# Policies
# -------------------------
@app.get("/privacy")
def privacy():
    return render_template("privacy.html")

@app.get("/terms")
def terms():
    return render_template("terms.html")
