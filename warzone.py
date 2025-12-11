# warzone.py
from flask import Blueprint, render_template, session, redirect, request, current_app

warzone_bp = Blueprint("warzone_bp", __name__, url_prefix="/warzone")


@warzone_bp.get("/auth")
def warzone_auth():
    """
    Pi auth gate for IZZA WAR ZONE.
    Uses the same /auth/exchange handler as the rest of IZZA,
    but themed for the War Zone FPS.
    """
    sandbox = current_app.config.get("PI_SANDBOX", False)
    return render_template("warzone_auth.html", sandbox=sandbox)


@warzone_bp.get("/")
def warzone_lobby():
    """
    Main IZZA WAR ZONE lobby page.

    The lobby is where:
      - Players land after Pi auth
      - Invite friends and search players will live
      - Starter character is selected (basic man or basic woman IZZA Soldier)
      - Deploy button sends them into the rotated FPS scene later

    If user is not logged in, redirect them to the War Zone auth page.
    """
    if "user_id" not in session:
        qs = request.query_string.decode("utf-8")
        base = "/warzone/auth"
        return redirect(f"{base}?{qs}" if qs else base)

    # Simple player object from session for now
    player = {
        "id": session.get("user_id"),
        # adjust if your session key is different
        "username": session.get("username") or session.get("pi_username"),
        # starter class, we can persist this later
        "starter": session.get("warzone_starter") or "soldier_m",
    }

    # Later we can also pass:
    # - friend list
    # - party members
    # - Kenny map metadata for the drop in scene
    return render_template("warzone_lobby.html", player=player)
