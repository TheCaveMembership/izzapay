# warzone.py
from flask import (
    Blueprint,
    render_template,
    session,
    redirect,
    request,
    current_app,
    jsonify,
)
from time import time
from db import conn

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

    If user is not logged in, redirect them to the War Zone auth page.
    """
    if "user_id" not in session:
        qs = request.query_string.decode("utf-8")
        base = "/warzone/auth"
        return redirect(f"{base}?{qs}" if qs else base)

    # Make sure we can treat user_id as int
    try:
        uid = int(session.get("user_id"))
    except (TypeError, ValueError):
        uid = None

    db_name = None
    if uid is not None:
        # Pull the best display name we have from the users table
        with conn() as cx:
            row = cx.execute(
                """
                SELECT COALESCE(username, pi_username, pi_uid) AS name
                FROM users
                WHERE id = ?
                """,
                (uid,),
            ).fetchone()
            if row and row["name"]:
                db_name = row["name"]

    # Fallback to session keys only if DB had nothing
    display_name = (
        db_name
        or session.get("username")
        or session.get("pi_username")
        or session.get("pi_handle")
        or f"User #{uid}"  # last resort
    )

    player = {
        "id": uid,
        "username": display_name,
        "starter": session.get("warzone_starter") or "soldier_m",
    }

    return render_template("warzone_lobby.html", player=player)


# ----------------------------------------------------------------------
# War Zone API: friend search + lobby invites
# ----------------------------------------------------------------------


def _require_user_id():
    uid = session.get("user_id")
    if not uid:
        return None
    try:
        return int(uid)
    except (TypeError, ValueError):
        return None


@warzone_bp.get("/api/search")
def warzone_search_players():
    """
    Search IZZA users by username / pi_username for War Zone friend invites.
    """
    uid = _require_user_id()
    if not uid:
        return jsonify({"error": "auth_required"}), 401

    q = (request.args.get("q") or "").strip()
    if not q:
        return jsonify({"results": []})

    like = f"%{q}%"
    with conn() as cx:
        rows = cx.execute(
            """
            SELECT id,
                   COALESCE(username, pi_username) AS username
            FROM users
            WHERE (username    LIKE ? OR pi_username LIKE ?)
              AND id != ?
            ORDER BY username COLLATE NOCASE
            LIMIT 20
            """,
            (like, like, uid),
        ).fetchall()

    results = [
        {"id": r["id"], "username": r["username"] or f"User #{r['id']}"}
        for r in rows
    ]
    return jsonify({"results": results})


@warzone_bp.post("/api/invite")
def warzone_invite_player():
    """
    Create a War Zone lobby invite into warzone_invites.
    """
    uid = _require_user_id()
    if not uid:
        return jsonify({"error": "auth_required"}), 401

    data = request.get_json(silent=True) or {}
    target_id = int(data.get("target_id") or 0)

    if not target_id or target_id == uid:
        return jsonify({"error": "invalid_target"}), 400

    now = int(time())
    with conn() as cx:
        cx.execute(
            """
            INSERT OR IGNORE INTO warzone_invites
              (from_user_id, to_user_id, status, created_at)
            VALUES (?, ?, 'pending', ?)
            """,
            (uid, target_id, now),
        )

    return jsonify({"ok": True})
