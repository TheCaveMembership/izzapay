# game_app.py
import os
from datetime import timedelta
from flask import Flask, render_template, session, request, redirect, url_for
from dotenv import load_dotenv
from db import conn
import requests  # <-- ADDED for LibreTranslate proxy

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


# -------------------- routes --------------------
@app.route("/auth")
def game_auth():
    """
    Landing page for IZZA GAME authentication.
    Renders templates/game/auth.html. The page uses Pi SDK and posts to /auth/exchange
    in the main app with next=/izza-game/create.
    """
    return render_template("game/auth.html", sandbox=PI_SANDBOX)


@app.route("/create", methods=["GET", "POST"])
def game_create():
    """
    Character creation. Admins (e.g., CamMac) always see this screen to test art/choices.
    Normal users: if a profile exists, skip straight to /play.
    """
    need = require_login_redirect()
    if need:
        return need

    # Grab token (if any) so we can preserve it on POST and redirects
    t = _get_bearer_token_from_request()

    # Look up the IZZA PAY user record to get pi_uid + username
    urow = current_user_row()
    if not urow:
        return redirect("/signin")

    pi_uid = urow["pi_uid"]
    pi_username = urow["pi_username"]
    admin = _is_admin(urow)

    # Bootstrap the game_profiles table
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

    if request.method == "POST":
        sprite = request.form.get("sprite_skin", "default")
        hair = request.form.get("hair", "short")
        outfit = request.form.get("outfit", "street")
        with conn() as cx:
            cx.execute(
                """
              INSERT INTO game_profiles(pi_uid, username, sprite_skin, hair, outfit)
              VALUES(?,?,?,?,?)
              ON CONFLICT(pi_uid) DO UPDATE SET
                username=excluded.username,
                sprite_skin=excluded.sprite_skin,
                hair=excluded.hair,
                outfit=excluded.outfit
            """,
                (pi_uid, pi_username, sprite, hair, outfit),
            )

        # After save -> go play (preserve token if present)
        if t:
            return redirect(f"{url_for('game_play')}?t={t}")
        return redirect(url_for("game_play"))

    # If profile already exists:
    with conn() as cx:
        row = cx.execute("SELECT 1 FROM game_profiles WHERE pi_uid=?", (pi_uid,)).fetchone()

    # Admins always re-create unless they explicitly add ?skip=1
    if row and admin and request.args.get("skip") != "1":
        # Fall-through: render create screen for admin testing
        return render_template("game/create_character.html", t=t)

    # Normal users: skip to play if they already have a profile
    if row:
        if t:
            return redirect(f"{url_for('game_play')}?t={t}")
        return redirect(url_for("game_play"))

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

    pi_uid = urow["pi_uid"]
    with conn() as cx:
        profile = cx.execute(
            "SELECT pi_uid, username, sprite_skin, hair, outfit FROM game_profiles WHERE pi_uid=?",
            (pi_uid,),
        ).fetchone()

    if not profile:
        # No profile yet → back to create (preserve token)
        if t:
            return redirect(f"{url_for('game_create')}?t={t}")
        return redirect(url_for("game_create"))

    profile_dict = dict(
        pi_uid=profile[0],
        username=profile[1],
        sprite_skin=profile[2],
        hair=profile[3],
        outfit=profile[4],
    )

    user_ctx = {"username": urow["pi_username"], "id": urow["id"]}

    return render_template("game/play.html", profile=profile_dict, user=user_ctx, t=t)


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


# ----------------- Multiplayer API mounted here -----------------
from mp_api import mp_bp  # REST-only blueprint

# Public paths become /izza-game/api/mp/*
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


# ------------- ADDED: lightweight translate proxy -------------
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
