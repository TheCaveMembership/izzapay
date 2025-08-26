# game_app.py
import os
from flask import Flask, render_template, session, request, redirect, url_for
from dotenv import load_dotenv
from db import conn

load_dotenv()

# Standalone Flask app for the game (mounted at /izza-game via wsgi.py)
app = Flask(__name__, template_folder="templates", static_folder="static")
app.secret_key = os.getenv("SECRET_KEY", "dev-secret")  # must match main app
PI_SANDBOX = os.getenv("PI_SANDBOX", "false").lower() == "true"


# -------------------- helpers --------------------
def current_user_row():
    """Return the users table row for the logged-in user_id, or None."""
    uid = session.get("user_id")
    if not uid:
        return None
    with conn() as cx:
        row = cx.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        return row

def require_login_redirect():
    """Redirect to /signin if not logged in via IZZA PAY."""
    if "user_id" not in session:
        # Optional: preserve a next param back to this page
        return redirect("/signin")
    return None


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

    # Look up the IZZA PAY user record to get pi_uid + username
    urow = current_user_row()
    if not urow:
        return redirect("/signin")

    # Your users table uses columns: pi_uid, pi_username (from your /auth/exchange)
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
        return redirect(url_for("game_play"))

    # If profile already exists, skip to play
    with conn() as cx:
        row = cx.execute("SELECT 1 FROM game_profiles WHERE pi_uid=?", (pi_uid,)).fetchone()
    if row:
        return redirect(url_for("game_play"))

    # Render creation form
    return render_template("game/create_character.html")


@app.route("/play")
def game_play():
    """
    Main game canvas. Ensures profile exists; if not, send to /create.
    """
    need = require_login_redirect()
    if need:
        return need

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
        return redirect(url_for("game_create"))

    profile_dict = dict(
        pi_uid=profile[0],
        username=profile[1],
        sprite_skin=profile[2],
        hair=profile[3],
        outfit=profile[4],
    )

    # You can also pass a minimal user context (e.g., username) to the template if useful
    user_ctx = {"username": urow["pi_username"], "id": urow["id"]}

    return render_template("game/play.html", profile=profile_dict, user=user_ctx)
