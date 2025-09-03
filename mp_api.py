# mp_api.py — v1.8 (adds /echo and /debug/auth to verify Pi auth -> API)

from typing import Optional, Tuple
from flask import Blueprint, jsonify, request, session
from db import conn

mp_bp = Blueprint("mp", __name__)

def _import_main_verifier():
    try:
        from app import verify_login_token
        return verify_login_token
    except Exception:
        return None
VERIFY_TOKEN = _import_main_verifier()

def _bearer_from_req() -> Optional[str]:
    # ?t= or form t= wins; else Authorization: Bearer
    t = request.args.get("t") or request.form.get("t")
    if t:
        return t.strip()
    auth = request.headers.get("Authorization", "")
    if auth and auth.lower().startswith("bearer "):
        return auth.split(" ", 1)[1].strip()
    return None

def _current_user_ids() -> Optional[Tuple[int, str, str]]:
    """
    Returns (user_id, pi_uid, pi_username) if authenticated by either:
      - session["user_id"] (shared-secret cookie), or
      - VERIFY_TOKEN(bearer 't') short-lived token
    """
    uid = session.get("user_id")
    if not uid:
        tok = _bearer_from_req()
        if tok and VERIFY_TOKEN:
            uid = VERIFY_TOKEN(tok)
    if not uid:
        return None
    with conn() as cx:
        row = cx.execute(
            "SELECT id, pi_uid, pi_username FROM users WHERE id=?",
            (uid,)
        ).fetchone()
        if not row:
            return None
        return int(row["id"]), row["pi_uid"], row["pi_username"]

def _ensure_schema():
    with conn() as cx:
        cx.executescript("""
        CREATE TABLE IF NOT EXISTS mp_friend_requests(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          from_user INTEGER NOT NULL,
          to_user   INTEGER NOT NULL,
          status    TEXT NOT NULL DEFAULT 'pending',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(from_user, to_user)
        );
        CREATE TABLE IF NOT EXISTS mp_invites(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          from_user INTEGER NOT NULL,
          to_user   INTEGER NOT NULL,
          mode      TEXT,
          status    TEXT NOT NULL DEFAULT 'pending',
          ttl_sec   INTEGER NOT NULL DEFAULT 1800,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS mp_ranks(
          user_id INTEGER PRIMARY KEY,
          br10_w INTEGER DEFAULT 0, br10_l INTEGER DEFAULT 0,
          v1_w   INTEGER DEFAULT 0, v1_l   INTEGER DEFAULT 0,
          v2_w   INTEGER DEFAULT 0, v2_l   INTEGER DEFAULT 0,
          v3_w   INTEGER DEFAULT 0, v3_l   INTEGER DEFAULT 0
        );
        """)

def _user_id_by_username(username: str):
    username = (username or "").strip()
    if not username:
        return None
    with conn() as cx:
        r = cx.execute(
            "SELECT id FROM users WHERE pi_username=?",
            (username,)
        ).fetchone()
        return int(r["id"]) if r else None

def _is_friend(a: int, b: int) -> bool:
    with conn() as cx:
        r = cx.execute(
            """
            SELECT 1
              FROM mp_friend_requests
             WHERE status='accepted'
               AND (
                 (from_user=? AND to_user=?)
                 OR (from_user=? AND to_user=?)
               )
             LIMIT 1
            """,
            (a, b, b, a)
        ).fetchone()
        return bool(r)

# ------------------- DEBUG/VERIFY ENDPOINTS -------------------

@mp_bp.get("/echo")
def mp_echo():
    """
    Quick sanity check from device:
    /izza-game/api/mp/echo
    /izza-game/api/mp/echo?t=<token>
    """
    _ensure_schema()
    tok = _bearer_from_req()
    who = _current_user_ids()
    return jsonify({
        "ok": True,
        "has_auth_header": bool(tok),
        "session_user_id": session.get("user_id"),
        "authed": bool(who),
        "who": {
            "user_id": who[0] if who else None,
            "pi_uid":   who[1] if who else None,
            "username": who[2] if who else None,
        }
    })

@mp_bp.get("/debug/auth")
def mp_debug_auth():
    """
    Deep check to prove Pi auth is flowing into this API.
    Never returns secrets; only shows IDs and presence of related rows.
    """
    _ensure_schema()
    tok = _bearer_from_req()
    who = _current_user_ids()

    out = {
        "has_bearer_or_t": bool(tok),
        "session_user_id": session.get("user_id"),
        "authed": bool(who),
        "user": None,
        "has_profile": False
    }

    if who:
        uid, pi_uid, username = who
        out["user"] = {
            "id": uid,
            "pi_uid": pi_uid,
            "pi_username": username
        }
        with conn() as cx:
            prof = cx.execute(
                "SELECT 1 FROM game_profiles WHERE pi_uid=? LIMIT 1",
                (pi_uid,)
            ).fetchone()
        out["has_profile"] = bool(prof)

    return jsonify(out)

# ------------------- NORMAL API -------------------

@mp_bp.get("/me")
def mp_me():
    _ensure_schema()
    who = _current_user_ids()
    if not who:
        return jsonify({"error": "not_authenticated"}), 401
    _, _, name = who
    return jsonify({"username": name, "inviteLink": "/izza-game/auth"})

@mp_bp.get("/friends/list")
def mp_friends_list():
    _ensure_schema()
    who = _current_user_ids()
    if not who:
        return jsonify({"error": "not_authenticated"}), 401
    uid, _, _ = who
    with conn() as cx:
        rows = cx.execute("""
          SELECT DISTINCT u.pi_username AS username
            FROM mp_friend_requests fr
            JOIN users u ON u.id = CASE
                                    WHEN fr.from_user=? THEN fr.to_user
                                    ELSE fr.from_user
                                  END
           WHERE fr.status='accepted'
             AND (fr.from_user=? OR fr.to_user=?)
           ORDER BY u.pi_username COLLATE NOCASE
        """, (uid, uid, uid)).fetchall()
    return jsonify({
        "friends": [
            {"username": r["username"], "active": False, "friend": True}
            for r in rows
        ]
    })

@mp_bp.get("/friends/search")
@mp_bp.get("/players/search")
def mp_players_search():
    _ensure_schema()
    who = _current_user_ids()
    if not who:
        return jsonify({"error": "not_authenticated"}), 401
    my_id, _, _ = who
    q = (request.args.get("q") or "").strip()
    if len(q) < 2:
        return jsonify({"users": []})
    with conn() as cx:
        rows = cx.execute("""
          SELECT DISTINCT u.id AS uid, u.pi_username AS username
            FROM users u
            JOIN game_profiles gp ON gp.pi_uid = u.pi_uid   -- only users who created a character
           WHERE u.pi_username LIKE ? COLLATE NOCASE
           ORDER BY u.pi_username COLLATE NOCASE
           LIMIT 15
        """, (f"%{q}%",)).fetchall()
    users = [
        {"username": r["username"], "active": False, "friend": _is_friend(my_id, int(r["uid"]))}
        for r in rows
    ]
    return jsonify({"users": users})

@mp_bp.post("/lobby/invite")
def mp_lobby_invite():
    _ensure_schema()
    who = _current_user_ids()
    if not who:
        return jsonify({"error": "not_authenticated"}), 401
    me, _, _ = who
    data = (request.get_json(silent=True) or {})
    to = (data.get("toUsername") or "").strip()
    to_id = _user_id_by_username(to)
    if not to_id:
        return jsonify({"ok": False, "error": "player_not_found"}), 404
    if to_id == me:
        return jsonify({"ok": False, "error": "cannot_invite_self"}), 400
    if not _is_friend(me, to_id):
        return jsonify({"ok": False, "error": "not_friends"}), 403
    with conn() as cx:
        cx.execute(
            "INSERT INTO mp_invites(from_user,to_user,mode,ttl_sec,status) VALUES(?,?,?,?, 'pending')",
            (me, to_id, (data.get('mode') or None), int(data.get('ttlSec') or 1800))
        )
    return jsonify({"ok": True})
