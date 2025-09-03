# mp_api.py — v1.8
# Minimal multiplayer REST on top of your existing Pi-authenticated session.
# A "player" == user with a row in game_profiles (finished character creation).

from typing import Optional, Tuple
from flask import Blueprint, jsonify, request, session
from db import conn

mp_bp = Blueprint("mp", __name__)  # game_app registers at url_prefix="/api/mp"

# ---------- auth helpers (reuse main app's short-lived token, if available) ----------
def _import_main_verifier():
    try:
        from app import verify_login_token
        return verify_login_token
    except Exception:
        return None

VERIFY_TOKEN = _import_main_verifier()

def _bearer_from_req() -> Optional[str]:
    t = request.args.get("t") or request.form.get("t")
    if t:
        return t.strip()
    auth = request.headers.get("Authorization", "")
    if auth and auth.lower().startswith("bearer "):
        return auth.split(" ", 1)[1].strip()
    return None

def _current_user_ids() -> Optional[Tuple[int, str, str]]:
    """
    Return (user_id, pi_uid, pi_username) from your users table.
    Auth is via existing cookie session or the short-lived token from your main app.
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
            "SELECT id, pi_uid, pi_username FROM users WHERE id=?", (uid,)
        ).fetchone()
        if not row:
            return None
        return int(row["id"]), row["pi_uid"], row["pi_username"]

# ---------- bootstrap (small tables we own) ----------
def _ensure_schema():
    with conn() as cx:
        cx.executescript(
            """
            CREATE TABLE IF NOT EXISTS mp_users(
              id INTEGER PRIMARY KEY,           -- users.id
              pi_uid TEXT UNIQUE,
              pi_username TEXT,
              last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS mp_friend_requests(
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              from_user INTEGER NOT NULL,   -- users.id
              to_user   INTEGER NOT NULL,   -- users.id
              status    TEXT NOT NULL DEFAULT 'pending', -- pending|accepted|rejected|cancelled
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              UNIQUE(from_user, to_user)
            );

            CREATE TABLE IF NOT EXISTS mp_invites(
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              from_user INTEGER NOT NULL,   -- users.id
              to_user   INTEGER NOT NULL,   -- users.id
              mode      TEXT,               -- br10|v1|v2|v3
              status    TEXT NOT NULL DEFAULT 'pending', -- pending|accepted|expired|cancelled
              ttl_sec   INTEGER NOT NULL DEFAULT 1800,   -- 30 min
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS mp_ranks(
              user_id INTEGER PRIMARY KEY,
              br10_w INTEGER DEFAULT 0, br10_l INTEGER DEFAULT 0,
              v1_w   INTEGER DEFAULT 0, v1_l   INTEGER DEFAULT 0,
              v2_w   INTEGER DEFAULT 0, v2_l   INTEGER DEFAULT 0,
              v3_w   INTEGER DEFAULT 0, v3_l   INTEGER DEFAULT 0
            );
            """
        )

def _touch_mp_user(user_id: int, pi_uid: str, pi_username: str):
    with conn() as cx:
        cx.execute(
            """
            INSERT INTO mp_users(id, pi_uid, pi_username, last_seen)
            VALUES(?,?,?,CURRENT_TIMESTAMP)
            ON CONFLICT(id) DO UPDATE SET
              pi_uid=excluded.pi_uid,
              pi_username=excluded.pi_username,
              last_seen=CURRENT_TIMESTAMP
            """,
            (user_id, pi_uid, pi_username),
        )

def _user_id_by_username(username: str) -> Optional[int]:
    username = (username or "").strip()
    if not username:
        return None
    with conn() as cx:
        r = cx.execute("SELECT id FROM users WHERE pi_username=?", (username,)).fetchone()
        return int(r["id"]) if r else None

def _is_friend(a: int, b: int) -> bool:
    with conn() as cx:
        r = cx.execute(
            """
            SELECT 1 FROM mp_friend_requests
             WHERE status='accepted'
               AND ((from_user=? AND to_user=?) OR (from_user=? AND to_user=?))
             LIMIT 1
            """,
            (a, b, b, a),
        ).fetchone()
        return bool(r)

def _cleanup_expired_invites():
    with conn() as cx:
        cx.executescript(
            """
            UPDATE mp_invites
               SET status='expired'
             WHERE status='pending'
               AND (strftime('%s','now') - strftime('%s', created_at)) > ttl_sec;
            """
        )

# ---------- routes (mounted by game_app at /izza-game/api/mp/*) ----------
@mp_bp.get("/me")
def mp_me():
    _ensure_schema()
    who = _current_user_ids()
    if not who:
        return jsonify({"error": "not_authenticated"}), 401
    uid, pi_uid, pi_name = who
    _touch_mp_user(uid, pi_uid, pi_name)
    return jsonify({"username": pi_name, "inviteLink": "/izza-game/auth"})

@mp_bp.get("/friends/list")
def mp_friends_list():
    _ensure_schema()
    who = _current_user_ids()
    if not who:
        return jsonify({"error": "not_authenticated"}), 401
    uid, _, _ = who
    with conn() as cx:
        rows = cx.execute(
            """
            SELECT DISTINCT u.pi_username AS username
              FROM mp_friend_requests fr
              JOIN users u ON u.id = CASE
                  WHEN fr.from_user=? THEN fr.to_user
                  ELSE fr.from_user
              END
             WHERE fr.status='accepted' AND (fr.from_user=? OR fr.to_user=?)
             ORDER BY u.pi_username COLLATE NOCASE
            """,
            (uid, uid, uid),
        ).fetchall()
    return jsonify(
        {"friends": [{"username": r["username"], "active": False, "friend": True} for r in rows]}
    )

@mp_bp.get("/friends/search")
@mp_bp.get("/players/search")  # alias; UI may call either
def mp_players_search():
    """
    Players search = users that ALSO exist in game_profiles.
    """
    _ensure_schema()
    who = _current_user_ids()
    if not who:
        return jsonify({"error": "not_authenticated"}), 401
    my_id, _, _ = who

    # FIX: Python uses .strip(), not .trim()
    q = (request.args.get("q") or "").strip()
    if len(q) < 2:
        return jsonify({"users": []})

    with conn() as cx:
        rows = cx.execute(
            """
            SELECT DISTINCT u.id AS uid, u.pi_username AS username
              FROM users u
              JOIN game_profiles gp ON gp.pi_uid = u.pi_uid
             WHERE u.pi_username LIKE ? ESCAPE '\\'
             ORDER BY u.pi_username COLLATE NOCASE
             LIMIT 15
            """,
            (f"%{q}%",),
        ).fetchall()

    out = []
    for r in rows:
        out.append(
            {
                "username": r["username"],
                "active": False,
                "friend": _is_friend(my_id, int(r["uid"])),
            }
        )
    return jsonify({"users": out})

@mp_bp.post("/friends/request")
def mp_friends_request():
    _ensure_schema()
    who = _current_user_ids()
    if not who:
        return jsonify({"error": "not_authenticated"}), 401
    me, _, _ = who
    data = request.get_json(silent=True) or {}
    to_user_name = (data.get("username") or "").strip()
    if not to_user_name:
        return jsonify({"ok": False, "error": "missing_username"}), 400
    to_id = _user_id_by_username(to_user_name)
    if not to_id:
        return jsonify({"ok": False, "error": "player_not_found"}), 404
    if to_id == me:
        return jsonify({"ok": False, "error": "cannot_friend_self"}), 400

    with conn() as cx:
        # Auto-accept if they already asked you
        pend = cx.execute(
            """
            SELECT id FROM mp_friend_requests
             WHERE from_user=? AND to_user=? AND status='pending'
            """,
            (to_id, me),
        ).fetchone()
        if pend:
            cx.execute("UPDATE mp_friend_requests SET status='accepted' WHERE id=?", (pend["id"],))
            return jsonify({"ok": True, "autoAccepted": True})

        cx.execute(
            """
            INSERT INTO mp_friend_requests(from_user, to_user, status)
            VALUES(?,?,'pending')
            ON CONFLICT(from_user, to_user)
            DO UPDATE SET status='pending', created_at=CURRENT_TIMESTAMP
            """,
            (me, to_id),
        )
    return jsonify({"ok": True})

@mp_bp.post("/friends/accept")
def mp_friends_accept():
    _ensure_schema()
    who = _current_user_ids()
    if not who:
        return jsonify({"error": "not_authenticated"}), 401
    me, _, _ = who
    data = request.get_json(silent=True) or {}
    from_name = (data.get("username") or "").strip()
    if not from_name:
        return jsonify({"ok": False, "error": "missing_username"}), 400
    from_id = _user_id_by_username(from_name)
    if not from_id:
        return jsonify({"ok": False, "error": "player_not_found"}), 404
    with conn() as cx:
        n = cx.execute(
            """
            UPDATE mp_friend_requests
               SET status='accepted'
             WHERE from_user=? AND to_user=? AND status='pending'
            """,
            (from_id, me),
        ).rowcount
    return jsonify({"ok": n > 0})

@mp_bp.post("/lobby/invite")
def mp_lobby_invite():
    _ensure_schema()
    _cleanup_expired_invites()
    who = _current_user_ids()
    if not who:
        return jsonify({"error": "not_authenticated"}), 401
    me, _, _ = who
    data = request.get_json(silent=True) or {}
    to_name = (data.get("toUsername") or "").strip()
    mode = (data.get("mode") or "").strip() or None
    ttl = int(data.get("ttlSec") or 1800)

    to_id = _user_id_by_username(to_name)
    if not to_id:
        return jsonify({"ok": False, "error": "player_not_found"}), 404
    if to_id == me:
        return jsonify({"ok": False, "error": "cannot_invite_self"}), 400
    if not _is_friend(me, to_id):
        return jsonify({"ok": False, "error": "not_friends"}), 403

    with conn() as cx:
        cx.execute(
            """
            INSERT INTO mp_invites(from_user, to_user, mode, ttl_sec, status)
            VALUES(?,?,?,?, 'pending')
            """,
            (me, to_id, mode, ttl),
        )
    return jsonify({"ok": True})

@mp_bp.get("/notifications")
def mp_notifications():
    _ensure_schema()
    _cleanup_expired_invites()
    who = _current_user_ids()
    if not who:
        return jsonify({"error": "not_authenticated"}), 401
    me, _, _ = who
    with conn() as cx:
        fr = cx.execute(
            """
            SELECT u.pi_username AS from_name
              FROM mp_friend_requests r
              JOIN users u ON u.id=r.from_user
             WHERE r.to_user=? AND r.status='pending'
             ORDER BY r.created_at DESC
            """,
            (me,),
        ).fetchall()
        inv = cx.execute(
            """
            SELECT u.pi_username AS from_name, i.mode
              FROM mp_invites i
              JOIN users u ON u.id=i.from_user
             WHERE i.to_user=? AND i.status='pending'
             ORDER BY i.created_at DESC
             LIMIT 10
            """,
            (me,),
        ).fetchall()
    return jsonify(
        {
            "requests": [{"from": r["from_name"]} for r in fr],
            "invites": [{"from": r["from_name"], "mode": r["mode"]} for r in inv],
        }
    )

@mp_bp.post("/lobby/accept")
def mp_lobby_accept():
    _ensure_schema()
    _cleanup_expired_invites()
    who = _current_user_ids()
    if not who:
        return jsonify({"error": "not_authenticated"}), 401
    me, _, _ = who
    data = request.get_json(silent=True) or {}
    from_name = (data.get("from") or "").strip()
    if not from_name:
        return jsonify({"ok": False, "error": "missing_from"}), 400
    from_id = _user_id_by_username(from_name)
    if not from_id:
        return jsonify({"ok": False, "error": "player_not_found"}), 404

    with conn() as cx:
        row = cx.execute(
            """
            SELECT id, mode FROM mp_invites
             WHERE from_user=? AND to_user=? AND status='pending'
             ORDER BY created_at DESC
             LIMIT 1
            """,
            (from_id, me),
        ).fetchone()
        if not row:
            return jsonify({"ok": False, "error": "no_pending_invite"}), 404
        cx.execute("UPDATE mp_invites SET status='accepted' WHERE id=?", (row["id"],))
    return jsonify({"ok": True, "mode": row["mode"]})

@mp_bp.post("/queue")
def mp_queue():
    _ensure_schema()
    if not _current_user_ids():
        return jsonify({"error": "not_authenticated"}), 401
    return jsonify({"ok": True})

@mp_bp.post("/dequeue")
def mp_dequeue():
    _ensure_schema()
    if not _current_user_ids():
        return jsonify({"error": "not_authenticated"}), 401
    return jsonify({"ok": True})

# ---------- compatibility stubs so game_app.py can still import these ----------
sock = None
def mp_boot(app, mount_prefix="/izza-game"):
    """No-op: WS optional. Keeping this for backward compatibility."""
    return
