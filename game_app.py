# game_app.py
import os
from datetime import timedelta
from flask import Flask, render_template, session, request, redirect, url_for
from dotenv import load_dotenv
from db import conn

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

# ----------------- TOKEN VERIFY (reuse main app) -----------------
try:
    from app import verify_login_token  # same signature as in app.py
except Exception:
    verify_login_token = None  # guarded below

def _get_bearer_token_from_request() -> str | None:
    """Query ?t= or form t= or Authorization: Bearer <token>."""
    t = request.args.get("t") or request.form.get("t")
    if t: return t.strip()
    auth = request.headers.get("Authorization", "")
    if auth and auth.lower().startswith("bearer "):
        return auth.split(" ", 1)[1].strip()
    return None

# -------------------- helpers --------------------
def current_user_row():
    """
    Return the users table row for the logged-in user_id, or resolve from short-lived token.
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
    First-time character creation. If a profile already exists for this Pi user,
    skip straight to /play.
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

    # Bootstrap the game_profiles table
    with conn() as cx:
        cx.executescript("""
        CREATE TABLE IF NOT EXISTS game_profiles(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          pi_uid TEXT UNIQUE NOT NULL,
          username TEXT,
          sprite_skin TEXT,
          hair TEXT,
          outfit TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        """)

    if request.method == "POST":
        sprite = request.form.get("sprite_skin", "default")
        hair   = request.form.get("hair", "short")
        outfit = request.form.get("outfit", "street")
        with conn() as cx:
            cx.execute("""
              INSERT INTO game_profiles(pi_uid, username, sprite_skin, hair, outfit)
              VALUES(?,?,?,?,?)
              ON CONFLICT(pi_uid) DO UPDATE SET
                username=excluded.username,
                sprite_skin=excluded.sprite_skin,
                hair=excluded.hair,
                outfit=excluded.outfit
            """, (pi_uid, pi_username, sprite, hair, outfit))

        # After save -> go play (preserve token if present)
        if t:
            return redirect(f"{url_for('game_play')}?t={t}")
        return redirect(url_for("game_play"))

    # If profile already exists, skip to play (preserve token)
    with conn() as cx:
        row = cx.execute("SELECT 1 FROM game_profiles WHERE pi_uid=?", (pi_uid,)).fetchone()
    if row:
        if t:
            return redirect(f"{url_for('game_play')}?t={t}")
        return redirect(url_for("game_play"))

    # Render creation form (pass token into template so the form includes it on POST)
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
            (pi_uid,)
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
