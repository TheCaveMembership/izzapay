# game_app.py
import os
import json  # <-- ADDED
from datetime import timedelta
from flask import Flask, render_template, session, request, redirect, url_for, jsonify
from dotenv import load_dotenv
from db import conn
import requests  # <-- ADDED for LibreTranslate proxy
import time
import uuid  # <-- ADD THIS

load_dotenv()

# ----------------- CREATE APP -----------------
# Standalone Flask app for the game (mounted at /izza-game via wsgi.py)
app = Flask(__name__, template_folder="templates", static_folder="static")

# ---- IMPORTANT: share the EXACT same secret & cookie settings as main app ----
_shared_secret = None
try:
    from app import app as main_app  # ensure wsgi.py imports app.py first
    _shared_secret = main_app.secret_key
except Exception:
    _shared_secret = os.getenv("FLASK_SECRET")

if not _shared_secret:
    raise RuntimeError("Shared session secret missing. Set FLASK_SECRET so app.py and game_app.py match.")

app.secret_key = _shared_secret
app.config.update(
    SESSION_COOKIE_NAME="izzapay_session",
    SESSION_COOKIE_SAMESITE="None",
    SESSION_COOKIE_SECURE=True,
    SESSION_COOKIE_HTTPONLY=True,
    PERMANENT_SESSION_LIFETIME=timedelta(days=7),
)

# ----------------- ENV FLAGS -----------------
PI_SANDBOX = os.getenv("PI_SANDBOX", "false").lower() == "true"
LIBRE_EP = (os.getenv("LIBRE_EP") or "https://izzatranslate.onrender.com").rstrip("/")  # <-- CHANGED: provide safe default

# ----------------- TOKEN VERIFY / ADMIN CHECK (reuse main app) -----------------
try:
    from app import verify_login_token, is_admin_name  # same fns as in app.py
except Exception:
    verify_login_token = None  # guarded below

    def is_admin_name(_):  # fallback if import fails
        return False


def _get_bearer_token_from_request() -> str | None:
    """Query ?t= or form t= or Authorization: Bearer <token>."""
    t = request.args.get("t") or request.form.get("t")
    if t:
        return t.strip()
    auth = request.headers.get("Authorization", "")
    if auth and auth.lower().startswith("bearer "):
        return auth.split(" ", 1)[1].strip()
    return None


# ---------- ensure a valid ?t= logs the user into this Flask app ----------
@app.before_request
def _hydrate_session_from_token():
    """
    If a short-lived token (?t= or Authorization: Bearer) is present and valid,
    persist it into this app's session so /api/mp/* sees an authenticated cookie.
    """
    if "user_id" not in session:
        tok = _get_bearer_token_from_request()
        if tok and verify_login_token:
            uid = verify_login_token(tok)
            if uid:
                session["user_id"] = uid


# -------------------- helpers --------------------
def current_user_row():
    """
    Return the users table row for the logged-in user_id,
    or resolve from short-lived token (same flow as main app).
    """
    uid = session.get("user_id")
    if not uid:
        tok = _get_bearer_token_from_request()
        if tok and verify_login_token:
            uid = verify_login_token(tok)
    if not uid:
        return None
    with conn() as cx:
        row = cx.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        return row


def _is_admin(urow) -> bool:
    """True if user row reflects admin/owner role or admin username (e.g., CamMac)."""
    if not urow:
        return False
    try:
        role = urow["role"]
    except Exception:
        role = None
    try:
        uname = urow["pi_username"]
    except Exception:
        uname = None
    if str(role).lower() in ("admin", "owner"):
        return True
    try:
        return bool(is_admin_name(uname))
    except Exception:
        return False


def require_login_redirect():
    """Redirect to /signin if not logged in (cookie) AND no valid token."""
    if "user_id" in session:
        return None
    tok = _get_bearer_token_from_request()
    if tok and verify_login_token and verify_login_token(tok):
        return None
    return redirect("/signin")


def _ensure_game_profiles_columns():
    """
    Ensure the appearance TEXT column exists (for JSON blob of extended creator fields).
    Does not alter or remove any existing columns.
    """
    with conn() as cx:
        cx.executescript(
            """
        CREATE TABLE IF NOT EXISTS game_profiles(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          pi_uid TEXT UNIQUE NOT NULL,
          username TEXT,
          sprite_skin TEXT,
          hair TEXT,
          outfit TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        """
        )
        # Check existing columns
        cols = [r[1] for r in cx.execute("PRAGMA table_info(game_profiles)").fetchall()]
        if "appearance" not in cols:
            cx.execute("ALTER TABLE game_profiles ADD COLUMN appearance TEXT")  # JSON blob


def _resolve_next_from_request(default_play="/izza-game/play"):
    """
    Decide where to send the player after create/skip.
    Priority:
      1) explicit ?next=... (or form next)
      2) ?dest=minigames → /izza-game/minigames
      3) default to main play route
    """
    next_url = (request.args.get("next") or request.form.get("next") or "").strip()
    if next_url:
        return next_url
    dest = (request.args.get("dest") or request.form.get("dest") or "").strip().lower()
    if dest == "minigames":
        return "/izza-game/minigames"
    return default_play


def _get_profile(user_id=None):
    """
    Fetch the saved base character in the SAME way as /play.
    Returns dict with keys used by the creation/minigame front-end,
    or None if not created yet.
    """
    urow = current_user_row()
    if not urow:
        return None

    _ensure_game_profiles_columns()
    pi_uid = urow["pi_uid"]
    with conn() as cx:
        row = cx.execute(
            "SELECT sprite_skin, hair, outfit, appearance FROM game_profiles WHERE pi_uid=?",
            (pi_uid,),
        ).fetchone()

    if not row:
        return None

    appearance = {}
    try:
        if row["appearance"]:
            appearance = json.loads(row["appearance"]) or {}
    except Exception:
        appearance = {}

    # Fallbacks so older rows still work
    profile = {
        "sprite_skin": row["sprite_skin"] or "default",
        "hair": row["hair"] or "short",
        "outfit": row["outfit"] or "street",
        "body_type": appearance.get("body_type", "male"),
        "hair_color": appearance.get("hair_color", ""),
        "skin_tone": appearance.get("skin_tone", "light"),
        "female_outfit_color": appearance.get("female_outfit_color", "blue"),
    }
    return profile


# -------------------- routes --------------------
@app.get("/api/crafts/feed")
def crafts_feed():
    u = current_user_row()
    if not u:
        return jsonify(ok=True, creations=[], purchases_ic=[], purchases_pi=[])

    uid = u["id"]
    with conn() as cx:
        # Creations (items the player minted)
        cx.execute("""
        CREATE TABLE IF NOT EXISTS crafted_items(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          name TEXT,
          svg TEXT,
          sku TEXT,
          image TEXT,
          meta TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )""")
        rows_c = cx.execute(
            "SELECT id, name, COALESCE(sku,'') AS sku, COALESCE(image,'') AS image, COALESCE(meta,'{}') AS meta "
            "FROM crafted_items WHERE user_id=? ORDER BY id DESC LIMIT 500",
            (uid,),
        ).fetchall()
        creations = [{
            "id": r["id"],
            "name": r["name"],
            "sku": r["sku"],
            "image": r["image"],
            "meta": json.loads(r["meta"] or "{}")
        } for r in rows_c]

        # IC purchases (from your in-game shop)
        cx.execute("""
        CREATE TABLE IF NOT EXISTS ic_orders(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          title TEXT,
          svg TEXT,
          part TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )""")
        rows_ic = cx.execute(
            "SELECT id, COALESCE(title,'') AS title, COALESCE(svg,'') AS svg, COALESCE(part,'') AS part "
            "FROM ic_orders WHERE user_id=? ORDER BY id DESC LIMIT 500",
            (uid,),
        ).fetchall()
        purchases_ic = [{
            "id": r["id"],
            "title": r["title"],
            "svg": r["svg"],
            "part": r["part"]
        } for r in rows_ic]

        # Pi purchases (from your Pi checkout bridge; keep 'claimed' flag)
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
        rows_pi = cx.execute(
            "SELECT order_id, COALESCE(title,'') AS title, COALESCE(thumb_url,'') AS thumb_url, "
            "COALESCE(store,'') AS store, COALESCE(crafted_item_id,'') AS crafted_item_id, "
            "COALESCE(claimed,0) AS claimed "
            "FROM pi_orders WHERE user_id=? ORDER BY created_at DESC LIMIT 500",
            (uid,),
        ).fetchall()
        purchases_pi = [{
            "order_id": r["order_id"],
            "title": r["title"],
            "thumb_url": r["thumb_url"],
            "store": r["store"],
            "crafted_item_id": r["crafted_item_id"],
            "claimed": bool(r["claimed"])
        } for r in rows_pi]

    return jsonify(ok=True, creations=creations, purchases_ic=purchases_ic, purchases_pi=purchases_pi)


@app.post("/api/collectibles/claim")
def collectibles_claim():
    u = current_user_row()
    if not u:
        return jsonify(ok=False, error="not_logged_in"), 401

    data = request.get_json(force=True) or {}
    order_id = str(data.get("id") or "").strip()
    if not order_id:
        return jsonify(ok=False, error="missing_id"), 400

    with conn() as cx:
        row = cx.execute(
            "SELECT order_id, user_id, COALESCE(claimed,0) AS claimed, COALESCE(crafted_item_id,'') AS crafted_item_id "
            "FROM pi_orders WHERE order_id=?", (order_id,)
        ).fetchone()
        if not row or int(row["user_id"]) != int(u["id"]):
            return jsonify(ok=False, error="not_found"), 404
        if int(row["claimed"]):
            return jsonify(ok=True, already=True)

        # Mark claimed
        cx.execute("UPDATE pi_orders SET claimed=1 WHERE order_id=?", (order_id,))

        # OPTIONAL: add to inventory
        cx.execute("""
        CREATE TABLE IF NOT EXISTS player_inventory(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          item_ref TEXT,    -- could be crafted_item_id or a SKU
          source TEXT,      -- 'pi'
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )""")
        item_ref = row["crafted_item_id"] or order_id
        cx.execute(
            "INSERT INTO player_inventory(user_id, item_ref, source) VALUES(?,?,?)",
            (u["id"], item_ref, "pi")
        )

    return jsonify(ok=True)


@app.get("/crafts")
def crafts_page():
    """Serve the CRAFTS UI (your existing templates/game/crafts.html)."""
    t = _get_bearer_token_from_request()
    return render_template("game/crafts.html", t=t)


@app.route("/auth")
def game_auth():
    """
    Landing page for IZZA GAME authentication.
    Renders templates/game/auth.html. The page uses Pi SDK and posts to /auth/exchange
    in the main app with next=/izza-game/create (or /izza-game/create?dest=minigames).
    """
    return render_template("game/auth.html", sandbox=PI_SANDBOX)


@app.route("/create", methods=["GET", "POST"])
def game_create():
    """
    Character creation. Admins (e.g., CamMac) always see this screen to test art/choices.
    Normal users: if a profile exists, skip to the requested destination (next/dest) or /play.
    """
    need = require_login_redirect()
    if need:
        return need

    # Keep token (if any) for redirects
    t = _get_bearer_token_from_request()

    # Who is this?
    urow = current_user_row()
    if not urow:
        return redirect("/signin")

    pi_uid = urow["pi_uid"]
    pi_username = urow["pi_username"]
    admin = _is_admin(urow)

    # Ensure schema
    _ensure_game_profiles_columns()

    # Where to go after create/skip
    next_url = _resolve_next_from_request(default_play=url_for("game_play"))

    if request.method == "POST":
        # Legacy fields (unchanged)
        sprite = request.form.get("sprite_skin", "default")
        hair = request.form.get("hair", "short")
        outfit = request.form.get("outfit", "street")

        # Extended fields (unchanged)
        body_type = request.form.get("body_type", "male")
        hair_color = request.form.get("hair_color", "").strip()
        skin_tone = request.form.get("skin_tone", "light")
        female_outfit_color = request.form.get("female_outfit_color", "blue")

        appearance = {
            "body_type": body_type,
            "sprite_skin": sprite,
            "hair": hair,
            "hair_color": hair_color,
            "outfit": outfit,
            "skin_tone": skin_tone,
            "female_outfit_color": female_outfit_color,
        }

        with conn() as cx:
            cx.execute(
                """
              INSERT INTO game_profiles(pi_uid, username, sprite_skin, hair, outfit, appearance)
              VALUES(?,?,?,?,?,?)
              ON CONFLICT(pi_uid) DO UPDATE SET
                username=excluded.username,
                sprite_skin=excluded.sprite_skin,
                hair=excluded.hair,
                outfit=excluded.outfit,
                appearance=excluded.appearance
            """,
                (pi_uid, pi_username, sprite, hair, outfit, json.dumps(appearance)),
            )

        # After save → go to intended destination
        if t:
            sep = "&" if "?" in next_url else "?"
            return redirect(f"{next_url}{sep}t={t}")
        return redirect(next_url)

    # If profile already exists:
    with conn() as cx:
        row = cx.execute("SELECT 1 FROM game_profiles WHERE pi_uid=?", (pi_uid,)).fetchone()

    # Admins always re-create unless they explicitly add ?skip=1
    if row and admin and request.args.get("skip") != "1":
        # Fall-through: render create screen for admin testing
        return render_template("game/create_character.html", t=t)

    # Normal users: skip to intended destination if profile exists
    if row:
        if t:
            sep = "&" if "?" in next_url else "?"
            return redirect(f"{next_url}{sep}t={t}")
        return redirect(next_url)

    # New user: render creation form
    return render_template("game/create_character.html", t=t)


@app.route("/play")
def game_play():
    """
    Main game canvas. Ensures profile exists; if not, send to /create.
    """
    need = require_login_redirect()
    if need:
        return need

    # Keep the token for any client-side calls if you want (optional)
    t = _get_bearer_token_from_request()

    urow = current_user_row()
    if not urow:
        return redirect("/signin")

    # Ensure schema (in case /create hasn't been hit since deploy)
    _ensure_game_profiles_columns()

    pi_uid = urow["pi_uid"]
    with conn() as cx:
        profile = cx.execute(
            "SELECT pi_uid, username, sprite_skin, hair, outfit, appearance FROM game_profiles WHERE pi_uid=?",
            (pi_uid,),
        ).fetchone()

    if not profile:
        # No profile yet → back to create (preserve token)
        if t:
            return redirect(f"{url_for('game_create')}?t={t}")
        return redirect(url_for("game_create"))

    # Build the profile dict + appearance (JSON) for the front-end
    # JS reads: window.__IZZA_PROFILE__ or .appearance
    appearance = {}
    try:
        if profile[5]:
            appearance = json.loads(profile[5]) or {}
    except Exception:
        appearance = {}

    # Fallbacks so older rows still work (tinting code will use appearance if present)
    if not appearance:
        appearance = {
            "sprite_skin": profile[2] or "default",
            "hair": profile[3] or "short",
            "outfit": profile[4] or "street",
            # defaults the JS already expects:
            "body_type": "male",
            "hair_color": "",
            "skin_tone": "light",
            "female_outfit_color": "blue",
        }

    # NOTE: Mirror extended fields to top-level too.
    # The on-canvas JS does `const AP = profile.appearance || profile || {};`
    # so exposing hair_color (etc.) at top-level removes any ambiguity.
    profile_dict = dict(
        pi_uid=profile[0],
        username=profile[1],
        sprite_skin=profile[2],
        hair=profile[3],
        outfit=profile[4],
        appearance=appearance,  # <-- IMPORTANT for tinting & female body sheet
        body_type=appearance.get("body_type", "male"),
        hair_color=appearance.get("hair_color", ""),
        skin_tone=appearance.get("skin_tone", "light"),
        female_outfit_color=appearance.get("female_outfit_color", "blue"),
    )

    user_ctx = {"username": urow["pi_username"], "id": urow["id"]}

    return render_template("game/play.html", profile=profile_dict, user=user_ctx, t=t)


# =========================
# Mini Game Arena routes
# =========================

# Use the same app object (no blueprint change)
APP = app  # If you later mount under a blueprint, swap this to your BP.

def _append_t(url_str: str) -> str:
    """Carry a short-lived token through redirects if present."""
    t = _get_bearer_token_from_request()
    if t:
        sep = "&" if ("?" in url_str) else "?"
        return f"{url_str}{sep}t={t}"
    return url_str

def _is_logged_in():
    return bool(current_user_row())

def _login_redirect(next_path="/izza-game/minigames"):
    # Ensure the 'next' we hand to /auth preserves ?t= if present
    next_with_t = _append_t(next_path)
    return redirect(url_for('game_auth') + f"?next={next_with_t}")

def _get_current_user_id():
    u = current_user_row()
    return u and u.get("id")


# ---- HTML page: arena picker ----
@APP.get("/minigames")
def minigames_page():
    # 1) must be logged in (same behavior as your other game routes)
    if not _is_logged_in():
        return _login_redirect(next_path="/izza-game/minigames")

    # 2) must have a saved base character; else push through character creation
    prof = _get_profile()
    if not prof:
        # Preserve token so the subsequent /create -> next -> minigames keeps the session
        return redirect(_append_t(url_for('game_create') + "?next=/izza-game/minigames"))

    # 3) render arena (balances optional; default to zero)
    coins = 0
    crafting = 0
    try:
        # If you store balances, you can fetch them here based on current user id
        pass
    except Exception:
        pass

    return render_template("game/minigames.html", coins=coins, crafting=crafting)
# ---- Dynamic minigame loader ----
@APP.route("/minigames/<name>")
def minigame(name):
    """
    Serve a specific minigame HTML template from templates/game/minigames/<name>.html
    Example: /izza-game/minigames/basketball → templates/game/minigames/basketball.html
    """
    try:
        return render_template(f"game/minigames/{name}.html")
    except Exception:
        return "<h2>Mini-game not found</h2>", 404

# ---- JSON: character (used by arena/minigames page boot) ----
@APP.get("/api/character")
def api_character_me():
    if not _is_logged_in():
        return jsonify({"ok": False, "error": "not_logged_in"}), 401
    prof = _get_profile()
    if not prof:
        return jsonify({"ok": True, "hasCharacter": False}), 200
    # Keep the same field names your creation page uses:
    out = {
        "body_type": prof.get("body_type"),
        "skin_tone": prof.get("skin_tone"),
        "sprite_skin": prof.get("sprite_skin"),
        "outfit": prof.get("outfit"),
        "hair": prof.get("hair"),
        "hair_color": prof.get("hair_color"),
        "female_outfit_color": prof.get("female_outfit_color"),
    }
    return jsonify({"ok": True, "hasCharacter": True, **out})


# ---- JSON: wallet (coins + crafting) ----
@APP.get("/api/wallet")
def api_wallet_me():
    if not _is_logged_in():
        return jsonify({"ok": False, "error": "not_logged_in"}), 401
    # If you track balances in DB, return them here; default zeros
    return jsonify({"ok": True, "coins": 0, "crafting": 0})


# -------- Auto-translate injector (global) --------
I18N_SNIPPET = r"""
<script>
if(!window.__IZZA_I18N_BOOTED__){
  window.__IZZA_I18N_BOOTED__=true;

  // Same-origin proxy — main app serves /api/translate
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
    if (!raw) return; // user hasn't chosen — do nothing

    const to   = String(raw).slice(0,5);
    const from = (document.documentElement.getAttribute('lang')||'en').slice(0,5);
    if (!to || to === from) return; // nothing to translate — do nothing

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
        # Only mutate HTML pages, status 200, and only if not opted-out.
        ctype = resp.headers.get("Content-Type", "")
        if resp.status_code == 200 and "text/html" in ctype:
            body = resp.get_data(as_text=True)
            # allow opt-out by putting data-no-global-i18n="1" in the document
            if 'data-no-global-i18n="1"' not in body and "__IZZA_I18N_BOOTED__" not in body:
                lower = body.lower()
                i = lower.rfind("</body>")
                if i != -1:
                    body = body[:i] + I18N_SNIPPET + body[i:]
                    resp.set_data(body)
                    try:
                        resp.headers["Content-Length"] = str(len(body.encode("utf-8")))
                    except Exception:
                        pass
    except Exception:
        # never break the response if injection fails
        pass
    return resp
# -------- /Auto-translate injector --------

# ===== Crafting Land API (lives under /izza-game/api/crafting) =====
from flask import Blueprint, current_app

# Pi Platform env for the game app (separate from app.py; same values)
PI_API_BASE = os.getenv("PI_PLATFORM_API_URL", "https://api.minepi.com").rstrip("/")
PI_API_KEY  = os.getenv("PI_PLATFORM_API_KEY", "").strip()

def pi_headers():
    if not PI_API_KEY:
        raise RuntimeError("PI_PLATFORM_API_KEY missing for crafting Pi calls")
    return {"Authorization": f"Key {PI_API_KEY}", "Content-Type": "application/json"}

crafting_api = Blueprint("crafting_api", __name__, url_prefix="/api/crafting")

# ========= CRAFTING CREDITS: schema helpers =========
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
      uniq   TEXT UNIQUE,              -- idempotency key (e.g., order:<id>)
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    """)

def _credit_add(cx, user_id:int, delta:int, reason:str, uniq:str|None=None):
    if delta == 0:
        return
    _ensure_credit_tables(cx)
    if uniq:
        # idempotency: skip if this grant already exists
        row = cx.execute("SELECT 1 FROM crafting_credit_ledger WHERE uniq=?", (uniq,)).fetchone()
        if row:
            return
    cx.execute(
        "INSERT INTO crafting_credit_ledger(user_id, delta, reason, uniq) VALUES(?,?,?,?)",
        (user_id, delta, reason, uniq)
    )
    # upsert balance
    cx.execute("""
      INSERT INTO crafting_credits(user_id, balance) VALUES(?, ?)
      ON CONFLICT(user_id) DO UPDATE SET balance = crafting_credits.balance + excluded.balance,
                                         updated_at = CURRENT_TIMESTAMP
    """, (user_id, delta))

def _credit_get(cx, user_id:int) -> int:
    _ensure_credit_tables(cx)
    row = cx.execute("SELECT balance FROM crafting_credits WHERE user_id=?", (user_id,)).fetchone()
    return int(row["balance"]) if row and row["balance"] is not None else 0

# ========= CRAFTING CREDITS: buckets + quotes (new) =========
def _ensure_credit_bucket_tables(cx):
    cx.executescript("""
    CREATE TABLE IF NOT EXISTS user_credit_buckets(
      user_id INTEGER NOT NULL,
      unit_value_ic INTEGER NOT NULL,   -- how much player paid per credit at issuance
      qty INTEGER NOT NULL DEFAULT 0,   -- number of credits of this grade
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(user_id, unit_value_ic)
    );

    CREATE TABLE IF NOT EXISTS craft_quotes(
      id TEXT PRIMARY KEY,              -- uuid
      user_id INTEGER NOT NULL,
      sku TEXT NOT NULL,
      qty INTEGER NOT NULL,
      price_ic INTEGER NOT NULL,        -- total IC price for this craft
      min_unit_value_ic INTEGER NOT NULL, -- floor: credit grade required (>=)
      expires_at INTEGER NOT NULL,      -- unix ms
      used_at INTEGER                   -- null until consumed
    );

    CREATE TABLE IF NOT EXISTS craft_spend_ledger(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      quote_id TEXT NOT NULL UNIQUE,
      sku TEXT NOT NULL,
      qty INTEGER NOT NULL,
      spent_ic INTEGER NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    """)

# -------- Server-owned pricebook + helpers (new) --------
# sku → (unit_price_ic, min_unit_value_ic)
_PRICEBOOK = {
    "craft:cardboard_box": (25, 1),
    "craft:pumpkin_mask":  (60, 2),
    "craft:pumpkin_set":   (180, 2),
}

def _compute_craft_price(sku: str, qty: int):
    p = _PRICEBOOK.get(sku)
    if not p:
        raise ValueError("unknown_sku")
    unit_price, min_floor = p
    return unit_price * max(1, qty), int(min_floor)

def _now_ms():
    return int(time.time() * 1000)

def _quote_ttl_ms():
    return 5 * 60 * 1000  # 5 minutes

def _new_quote_id():
    return uuid.uuid4().hex

def _json_ok(**kw):
    out = {"ok": True}
    out.update(kw)
    return jsonify(out)

def _json_err(reason="unknown"):
    return jsonify({"ok": False, "reason": str(reason)}), 400


@crafting_api.post("/ai_svg")
def crafting_ai_svg():
    """
    Optional: server-side SVG generator.
    We currently return ok:false so client falls back to its local blueprint.
    """
    return jsonify({"ok": False, "reason": "no-ai-backend"})


@crafting_api.get("/mine")
def crafting_mine():
    """
    Returns the user's crafted items for the merchant dashboard picker.
    Reads from crafted_items (same DB) filtered by logged-in user.
    """
    try:
        u = current_user_row()
        if not u:
            return _json_ok(items=[])
        with conn() as cx:
            rows = cx.execute(
                "SELECT id, name, COALESCE(sku,'') AS sku, COALESCE(image,'') AS image "
                "FROM crafted_items WHERE user_id=? ORDER BY id DESC LIMIT 500",
                (u["id"],)
            ).fetchall()
        items = [{"id": r["id"], "name": r["name"], "sku": r["sku"], "image": r["image"]} for r in rows]
        return _json_ok(items=items)
    except Exception as e:
        current_app.logger.exception("crafting_mine failed")
        return _json_err("server_error")

@crafting_api.get("/credits")
def crafting_credits_get():
    u = current_user_row()
    if not u:
        return _json_ok(balance=0, buckets=[])
    with conn() as cx:
        _ensure_credit_bucket_tables(cx)
        rows = cx.execute(
            "SELECT unit_value_ic, qty FROM user_credit_buckets WHERE user_id=? AND qty>0 ORDER BY unit_value_ic",
            (u["id"],)
        ).fetchall()
        total = sum(int(r["qty"]) for r in rows)
        buckets = [{"unit_value_ic": int(r["unit_value_ic"]), "qty": int(r["qty"])} for r in rows]
        return _json_ok(balance=total, buckets=buckets)

@crafting_api.get("/collectibles")
def crafting_collectibles_get():
    # Core v3 expects this; ok to return empty map for now.
    return _json_ok(items={})

@crafting_api.post("/quote")
def crafting_quote():
    u = current_user_row()
    if not u:
        return _json_err("not_logged_in")
    j = request.get_json(force=True) or {}
    sku = (j.get("sku") or "").strip()
    qty = int(j.get("qty") or 1)

    try:
        price_ic, floor_ic = _compute_craft_price(sku, qty)
    except ValueError:
        return _json_err("unknown_sku")

    qid = _new_quote_id()
    expires = _now_ms() + _quote_ttl_ms()

    with conn() as cx:
        _ensure_credit_bucket_tables(cx)
        cx.execute(
            "INSERT INTO craft_quotes(id, user_id, sku, qty, price_ic, min_unit_value_ic, expires_at) "
            "VALUES(?,?,?,?,?,?,?)",
            (qid, u["id"], sku, qty, price_ic, floor_ic, expires)
        )
    return _json_ok(quote_id=qid, price_ic=price_ic, min_unit_value_ic=floor_ic, expires_at=expires)


@crafting_api.post("/validate")
def crafting_validate():
    u = current_user_row()
    if not u:
        return _json_err("not_logged_in")
    qid = (request.get_json(force=True) or {}).get("quote_id")
    if not qid:
        return _json_err("missing_quote")

    with conn() as cx:
        row = cx.execute(
            "SELECT id, price_ic, min_unit_value_ic, expires_at, used_at "
            "FROM craft_quotes WHERE id=? AND user_id=?",
            (qid, u["id"])
        ).fetchone()
        if not row:
            return _json_err("not_found")
        if row["used_at"]:
            return _json_err("already_used")
        if int(row["expires_at"]) < _now_ms():
            return _json_err("expired")

        return _json_ok(
            quote_id=qid,
            price_ic=int(row["price_ic"]),
            min_unit_value_ic=int(row["min_unit_value_ic"]),
            expires_at=int(row["expires_at"])
        )


@crafting_api.post("/pay_ic")
def crafting_pay_ic():
    u = current_user_row()
    if not u:
        return _json_err("not_logged_in")
    qid = (request.get_json(force=True) or {}).get("quote_id")
    if not qid:
        return _json_err("missing_quote")

    with conn() as cx:
        _ensure_credit_bucket_tables(cx)

        # Begin transactional section
        cx.execute("BEGIN IMMEDIATE")

        q = cx.execute(
            "SELECT sku, qty, price_ic, min_unit_value_ic, expires_at, used_at "
            "FROM craft_quotes WHERE id=? AND user_id=?",
            (qid, u["id"])
        ).fetchone()
        if not q:
            cx.execute("ROLLBACK"); return _json_err("not_found")
        if q["used_at"]:
            cx.execute("ROLLBACK"); return _json_err("already_used")
        if int(q["expires_at"]) < _now_ms():
            cx.execute("ROLLBACK"); return _json_err("expired")

        need  = int(q["price_ic"])
        floor = int(q["min_unit_value_ic"])

        rows = cx.execute(
            "SELECT unit_value_ic, qty FROM user_credit_buckets "
            "WHERE user_id=? AND unit_value_ic>=? AND qty>0 "
            "ORDER BY unit_value_ic ASC",
            (u["id"], floor)
        ).fetchall()

        remaining = need
        to_update = []
        for r in rows:
            if remaining <= 0: break
            have = int(r["qty"])
            take = min(have, remaining)
            if take > 0:
                to_update.append((int(r["unit_value_ic"]), take))
                remaining -= take

        if remaining > 0:
            cx.execute("ROLLBACK")
            return _json_err("insufficient_eligible")

        # Apply deductions
        for unit_value_ic, take in to_update:
            cx.execute(
                "UPDATE user_credit_buckets SET qty = qty - ? "
                "WHERE user_id=? AND unit_value_ic=? AND qty>=?",
                (take, u["id"], unit_value_ic, take)
            )

        # Mark quote used + ledger entry
        cx.execute("UPDATE craft_quotes SET used_at=? WHERE id=?", (_now_ms(), qid))
        cx.execute(
            "INSERT INTO craft_spend_ledger(user_id, quote_id, sku, qty, spent_ic) VALUES(?,?,?,?,?)",
            (u["id"], qid, q["sku"], q["qty"], need)
        )

        cx.execute("COMMIT")
        return _json_ok(spent_ic=need, quote_id=qid)


# Create-product-from-craft helper (prefills the merchant form)
craft_prefill_bp = Blueprint("craft_prefill_bp", __name__)

@craft_prefill_bp.post("/api/merchant/create_product_from_craft")
def create_product_from_craft():
    urow = current_user_row()
    if not urow:
        return jsonify(ok=False, error="not_logged_in"), 401

    with conn() as cx:
        m = cx.execute("SELECT slug FROM merchants WHERE owner_user_id=?", (urow["id"],)).fetchone()

    if not m:
        return jsonify(ok=True, dashboardUrl="/merchant/setup"), 200

    data = request.get_json(force=True) or {}
    title = (data.get("title") or "").strip()
    description = (data.get("description") or "").strip()
    svg = (data.get("svg") or "").strip()
    crafted_meta = data.get("crafted_meta") or {}

    session["prefill_product"] = {
        "title": title[:160],
        "description": description[:500],
        "svg": svg,
        "crafted_meta": crafted_meta
    }

    return jsonify(ok=True, dashboardUrl=f"/merchant/{m['slug']}?prefill=1")


@crafting_api.post("/credits/grant")
def crafting_credit_grant():
    data = request.get_json(silent=True) or {}
    username = (data.get("username") or "").strip().lstrip("@")
    amount   = int(data.get("amount") or 0)          # number of credits to grant
    unit_val = int(data.get("unit_value_ic") or 1)   # how much the player paid per credit
    order_id = data.get("order_id")
    if amount <= 0 or unit_val <= 0:
        return _json_err("bad-amount")

    with conn() as cx:
        _ensure_credit_bucket_tables(cx)

        # resolve user_id
        user_id = None
        if username:
            r = cx.execute("SELECT id FROM users WHERE lower(pi_username)=lower(?)", (username,)).fetchone()
            if r:
                user_id = int(r["id"])
        if not user_id:
            u = current_user_row()
            if u:
                user_id = int(u["id"])
        if not user_id:
            return _json_err("user-not-found")

        # idempotency using legacy ledger uniq
        uniq = f"order:{int(order_id)}" if order_id else None
        if uniq:
            row = cx.execute("SELECT 1 FROM crafting_credit_ledger WHERE uniq=?", (uniq,)).fetchone()
            if row:
                return _json_ok(granted=0)

        # legacy mirror for visibility
        _credit_add(cx, user_id, +amount, reason="single-mint", uniq=uniq)

        # bucketed grant
        cx.execute("""
          INSERT INTO user_credit_buckets(user_id, unit_value_ic, qty)
          VALUES(?,?,?)
          ON CONFLICT(user_id,unit_value_ic) DO UPDATE SET qty = qty + excluded.qty
        """, (user_id, unit_val, amount))

        return _json_ok(granted=amount, unit_value_ic=unit_val)


@crafting_api.post("/mine")
def crafting_mine_post():
    u = current_user_row()
    if not u:
        return _json_err("not_logged_in")
    j = request.get_json(force=True) or {}
    name = (j.get("name") or "").strip()[:160]
    category = (j.get("category") or "").strip()[:40]
    part = (j.get("part") or "").strip()[:20]
    svg = (j.get("svg") or "").strip()
    sku = (j.get("sku") or "").strip()[:40]
    image = (j.get("image") or "").strip()

    with conn() as cx:
        cx.execute("""
          CREATE TABLE IF NOT EXISTS crafted_items(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            name TEXT,
            svg TEXT,
            sku TEXT,
            image TEXT,
            meta TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          )
        """)
        cx.execute(
            "INSERT INTO crafted_items(user_id, name, svg, sku, image, meta) VALUES(?,?,?,?,?,?)",
            (u["id"], name, svg, sku, image, json.dumps({"category":category, "part":part}))
        )
        new_id = cx.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
        return _json_ok(id=new_id)


# Register these under the game app prefix (/izza-game/…)
app.register_blueprint(crafting_api)
app.register_blueprint(craft_prefill_bp)
# ===== /Crafting Land API =====


# ----------------- Multiplayer API mounted here -----------------
# Public paths become /izza-game/api/mp/*
from mp_api import mp_bp  # REST-only blueprint
app.register_blueprint(mp_bp, url_prefix="/api/mp")


# ---- DEBUG: route list so we can confirm mounting in Pi Browser ----
@app.get("/debug/routes")
def debug_routes():
    try:
        rules = []
        for r in app.url_map.iter_rules():
            rules.append({
                "rule": str(r),
                "endpoint": r.endpoint,
                "methods": sorted([m for m in r.methods if m not in ("HEAD","OPTIONS")])
            })
        return {"ok": True, "count": len(rules), "routes": rules}
    except Exception as e:
        return {"ok": False, "error": str(e)}, 500


# ------------- Lightweight translate proxy -------------
@app.post("/api/translate")
def game_translate_api():
    """
    Proxy to LibreTranslate (if configured).
    Request JSON: { text, from, to }
    Response JSON: { ok: True, text: "<translated or original text>" }
    - If LIBRE_EP is not set or call fails, we gracefully return the original text.
    """
    try:
        data = request.get_json(force=True) or {}
        text = (data.get("text") or "").strip()
        src  = (data.get("from") or "auto")[:5]
        dest = (data.get("to")   or "en")[:5]

        if not text:
            return {"ok": False, "error": "empty_text", "text": ""}, 400

        # If no endpoint configured, return the original text unchanged
        if not LIBRE_EP:
            return {"ok": True, "text": text}

        r = requests.post(
            f"{LIBRE_EP}/translate",
            timeout=12,
            json={
                "q": text,
                "source": ("auto" if src == "auto" else src),
                "target": dest,
                "format": "text"
            }
        )
        if r.status_code == 200:
            try:
                out = r.json().get("translatedText")
                if isinstance(out, str) and out:
                    return {"ok": True, "text": out}
            except Exception:
                pass

        # Fallback to original text on any unexpected response
        return {"ok": True, "text": text}
    except Exception:
        # Fail-open: return original text so the UI still renders
        return {"ok": True, "text": text}
