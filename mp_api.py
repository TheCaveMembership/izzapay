# mp_api.py — friends + invites using Pi auth & DB (v1.7, 2025-09-02)
import os
from typing import Optional, Tuple
from flask import Blueprint, jsonify, request, session, current_app
from db import conn

# Mounted from game_app.py as: app.register_blueprint(mp_bp, url_prefix="/api/mp")
# Routes below use "/mp/..." so resulting paths are "/izza-game/api/mp/mp/*".
# (The client auto-falls back between "/api/mp/*" and "/api/mp/mp/*", so this is safe.)
mp_bp = Blueprint("mp", __name__)

# ---- optional WS discovery (kept for future) ----
_WS_ENABLED = False
_WS_PATH = None  # e.g. "/izza-game/api/mp/ws"

# -------------------- AUTH HELPERS --------------------
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
    if auth.lower().startswith("bearer "):
        return auth.split(" ", 1)[1].strip()
    return None

def _current_user_ids() -> Optional[Tuple[int, str, str]]:
    """
    Returns (user_id, pi_uid, pi_username) from existing `users` table.
    Works with cookie session or ?t= short-lived token using your main verifier.
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

# -------------------- DB BOOTSTRAP --------------------
def _ensure_schema():
    with conn() as cx:
        cx.executescript("""
        CREATE TABLE IF NOT EXISTS mp_users(
          id INTEGER PRIMARY KEY,        -- users.id
          pi_uid TEXT UNIQUE,
          pi_username TEXT,
          last_seen TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS mp_friend_requests(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          from_user INTEGER NOT NULL,
          to_user   INTEGER NOT NULL,
          status    TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | rejected | cancelled
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(from_user, to_user)
        );

        CREATE TABLE IF NOT EXISTS mp_invites(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          from_user INTEGER NOT NULL,
          to_user   INTEGER NOT NULL,
          mode      TEXT,
          status    TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | expired | cancelled
          ttl_sec   INTEGER NOT NULL DEFAULT 1800,   -- 30m default
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS mp_ranks(
          user_id INTEGER PRIMARY KEY,
          br10_w INTEGER DEFAULT 0, br10_l INTEGER DEFAULT 0,
          v1_w   INTEGER DEFAULT 0, v1_l   INTEGER DEFAULT 0,
          v2_w   INTEGER DEFAULT 0, v2_l   INTEGER DEFAULT 0,
          v3_w   INTEGER DEFAULT 0, v3_l   INTEGER DEFAULT 0
        );

        -- Helpful indexes
        CREATE INDEX IF NOT EXISTS idx_mp_fr_to_status   ON mp_friend_requests(to_user, status);
        CREATE INDEX IF NOT EXISTS idx_mp_fr_from_status ON mp_friend_requests(from_user, status);
        CREATE INDEX IF NOT EXISTS idx_mp_inv_to_status  ON mp_invites(to_user, status, created_at);
        CREATE INDEX IF NOT EXISTS idx_mp_inv_from_to    ON mp_invites(from_user, to_user, created_at);
        """)

def _touch_mp_user(user_id:int, pi_uid:str, pi_username:str):
    with conn() as cx:
        cx.execute("""
          INSERT INTO mp_users(id, pi_uid, pi_username, last_seen)
          VALUES(?,?,?,CURRENT_TIMESTAMP)
          ON CONFLICT(id) DO UPDATE SET
            pi_uid=excluded.pi_uid,
            pi_username=excluded.pi_username,
            last_seen=CURRENT_TIMESTAMP
        """, (user_id, pi_uid, pi_username))

def _user_id_by_username(username:str) -> Optional[int]:
    username = (username or "").strip()
    if not username:
        return None
    with conn() as cx:
        r = cx.execute("SELECT id FROM users WHERE pi_username=?", (username,)).fetchone()
        return int(r["id"]) if r else None

def _escape_like(term: str) -> str:
    # Escape '%' and '_' for LIKE; backslash is ESCAPE char
    return term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")

def _user_public(username:str, active:bool=False, friend:bool=False) -> dict:
    return {"username": username, "active": bool(active), "friend": bool(friend)}

def _cleanup_expired_invites():
    with conn() as cx:
        cx.executescript("""
        UPDATE mp_invites
           SET status='expired'
         WHERE status='pending'
           AND (strftime('%s','now') - strftime('%s', created_at)) > ttl_sec;
        """)

def _recent_active_cutoff_minutes() -> int:
    return int(os.getenv("MP_ACTIVE_MINUTES", "5"))  # "active" if seen in last N minutes

# -------------------- ROUTES --------------------
@mp_bp.get("/mp/me")
def mp_me():
    _ensure_schema()
    who = _current_user_ids()
    if not who:
        return jsonify({"error": "not_authenticated"}), 401
    uid, pi_uid, pi_name = who
    _touch_mp_user(uid, pi_uid, pi_name)

    # include ranks so the client UI can render counters
    with conn() as cx:
        r = cx.execute("""
          SELECT br10_w, br10_l, v1_w, v1_l, v2_w, v2_l, v3_w, v3_l
            FROM mp_ranks WHERE user_id=?""", (uid,)).fetchone()
    ranks = None
    if r:
        ranks = {
            "br10": {"w": r["br10_w"], "l": r["br10_l"]},
            "v1":   {"w": r["v1_w"],   "l": r["v1_l"]},
            "v2":   {"w": r["v2_w"],   "l": r["v2_l"]},
            "v3":   {"w": r["v3_w"],   "l": r["v3_l"]},
        }

    return jsonify({
        "username": pi_name,
        "inviteLink": "/izza-game/auth",
        "ws_url": _WS_PATH if _WS_ENABLED else None,
        "ranks": ranks
    })

@mp_bp.get("/mp/friends/list")
def mp_friends_list():
    _ensure_schema()
    who = _current_user_ids()
    if not who:
        return jsonify({"error": "not_authenticated"}), 401
    uid, _, _ = who
    minutes = _recent_active_cutoff_minutes()
    with conn() as cx:
        rows = cx.execute(f"""
          SELECT DISTINCT u.pi_username AS username,
                 CASE
                   WHEN mu.last_seen IS NOT NULL
                        AND (strftime('%s','now') - strftime('%s', mu.last_seen)) <= {minutes}*60
                   THEN 1 ELSE 0
                 END AS active
          FROM mp_friend_requests fr
          JOIN mp_users mu ON mu.id = CASE
              WHEN fr.from_user=? THEN fr.to_user
              ELSE fr.from_user
          END
          JOIN users u ON u.id = mu.id
          WHERE fr.status='accepted' AND (fr.from_user=? OR fr.to_user=?)
          ORDER BY u.pi_username COLLATE NOCASE
        """, (uid, uid, uid)).fetchall()
    return jsonify({"friends": [_user_public(r["username"], bool(r["active"]), True) for r in rows]})

@mp_bp.get("/mp/friends/search")
def mp_friends_search():
    """
    Search **only** users who have completed game auth (i.e., have a game_profiles row).
    """
    _ensure_schema()
    who = _current_user_ids()
    if not who:
        return jsonify({"error": "not_authenticated"}), 401
    q = (request.args.get("q") or "").strip()
    if len(q) < 2:
        return jsonify({"users": []})

    # escape LIKE wildcards to avoid weird matches
    like = f"%{_escape_like(q)}%"
    minutes = _recent_active_cutoff_minutes()

    with conn() as cx:
        rows = cx.execute(f"""
          SELECT u.id, u.pi_username AS username,
                 CASE
                   WHEN mu.last_seen IS NOT NULL
                        AND (strftime('%s','now') - strftime('%s', mu.last_seen)) <= {minutes}*60
                   THEN 1 ELSE 0
                 END AS active
            FROM users u
            JOIN game_profiles gp ON gp.pi_uid = u.pi_uid             -- must have completed auth/create
            LEFT JOIN mp_users mu ON mu.id = u.id
           WHERE u.pi_username LIKE ? ESCAPE '\\'
           ORDER BY u.pi_username COLLATE NOCASE
           LIMIT 10
        """, (like,)).fetchall()

    return jsonify({"users": [_user_public(r["username"], bool(r["active"]), False) for r in rows]})

@mp_bp.post("/mp/friends/request")
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
        return jsonify({"ok": False, "error": "user_not_found"}), 404
    if to_id == me:
        return jsonify({"ok": False, "error": "cannot_friend_self"}), 400

    with conn() as cx:
        # If they already sent me a request, accept it automatically.
        pending = cx.execute("""
          SELECT id FROM mp_friend_requests
           WHERE from_user=? AND to_user=? AND status='pending'
        """, (to_id, me)).fetchone()
        if pending:
            cx.execute("UPDATE mp_friend_requests SET status='accepted' WHERE id=?", (pending["id"],))
            return jsonify({"ok": True, "autoAccepted": True})

        # Otherwise create/refresh my outgoing request.
        cx.execute("""
          INSERT INTO mp_friend_requests(from_user, to_user, status)
          VALUES(?,?, 'pending')
          ON CONFLICT(from_user, to_user)
          DO UPDATE SET status='pending', created_at=CURRENT_TIMESTAMP
        """, (me, to_id))
    return jsonify({"ok": True})

@mp_bp.post("/mp/friends/accept")
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
        return jsonify({"ok": False, "error": "user_not_found"}), 404
    with conn() as cx:
        n = cx.execute("""
          UPDATE mp_friend_requests
             SET status='accepted'
           WHERE from_user=? AND to_user=? AND status='pending'
        """, (from_id, me)).rowcount
    return jsonify({"ok": n > 0})

@mp_bp.post("/mp/lobby/invite")
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
        return jsonify({"ok": False, "error": "user_not_found"}), 404
    if to_id == me:
        return jsonify({"ok": False, "error": "cannot_invite_self"}), 400

    with conn() as cx:
        # require friendship
        is_friend = cx.execute("""
          SELECT 1
            FROM mp_friend_requests
           WHERE status='accepted'
             AND ((from_user=? AND to_user=?) OR (from_user=? AND to_user=?))
        """, (me, to_id, to_id, me)).fetchone()
        if not is_friend:
            return jsonify({"ok": False, "error": "not_friends"}), 403

        cx.execute("""
          INSERT INTO mp_invites(from_user, to_user, mode, ttl_sec, status)
          VALUES(?,?,?,?, 'pending')
        """, (me, to_id, mode, ttl))
    return jsonify({"ok": True})

@mp_bp.post("/mp/lobby/notify")
def mp_lobby_notify():
    # Same behavior as invite; different wording for the UI.
    return mp_lobby_invite()

@mp_bp.get("/mp/notifications")
def mp_notifications():
    _ensure_schema()
    _cleanup_expired_invites()
    who = _current_user_ids()
    if not who:
        return jsonify({"error": "not_authenticated"}), 401
    me, _, _ = who
    with conn() as cx:
        fr = cx.execute("""
          SELECT u.pi_username AS from_name
            FROM mp_friend_requests r
            JOIN users u ON u.id=r.from_user
           WHERE r.to_user=? AND r.status='pending'
           ORDER BY r.created_at DESC
        """, (me,)).fetchall()

        inv = cx.execute("""
          SELECT u.pi_username AS from_name, i.mode
            FROM mp_invites i
            JOIN users u ON u.id=i.from_user
           WHERE i.to_user=? AND i.status='pending'
           ORDER BY i.created_at DESC
           LIMIT 10
        """, (me,)).fetchall()
    return jsonify({
        "requests": [{"from": r["from_name"]} for r in fr],
        "invites":  [{"from": r["from_name"], "mode": r["mode"]} for r in inv],
    })

@mp_bp.post("/mp/lobby/accept")
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
        return jsonify({"ok": False, "error": "user_not_found"}), 404

    with conn() as cx:
        row = cx.execute("""
          SELECT id, mode
            FROM mp_invites
           WHERE from_user=? AND to_user=? AND status='pending'
           ORDER BY created_at DESC
           LIMIT 1
        """, (from_id, me)).fetchone()
        if not row:
            return jsonify({"ok": False, "error": "no_pending_invite"}), 404
        cx.execute("UPDATE mp_invites SET status='accepted' WHERE id=?", (row["id"],))

    # TODO: create a match row & return matchId/players if you want the client to auto-start.
    return jsonify({"ok": True, "mode": row["mode"]})

@mp_bp.post("/mp/queue")
def mp_queue():
    _ensure_schema()
    who = _current_user_ids()
    if not who:
        return jsonify({"error": "not_authenticated"}), 401
    # TODO: insert into queue table for real matchmaking
    return jsonify({"ok": True})

@mp_bp.post("/mp/dequeue")
def mp_dequeue():
    _ensure_schema()
    who = _current_user_ids()
    if not who:
        return jsonify({"error": "not_authenticated"}), 401
    # TODO: remove from queue
    return jsonify({"ok": True})

# -------- optional Sock/WS boot (compatible with your setup) -----
sock = None

def _want_ws() -> bool:
    return os.getenv("MP_DISABLE_WS", "").lower() not in ("1", "true", "yes")

def mp_boot(app, mount_prefix="/izza-game"):
    """
    Safe to call. If flask-sock is available and not disabled, a WS route is added.
    The REST API works regardless.
    """
    app.logger.info("[mp] boot start")
    global _WS_ENABLED, _WS_PATH
    _WS_ENABLED = False
    _WS_PATH = None

    if not _want_ws():
        app.logger.warning("[mp] WS disabled via MP_DISABLE_WS; REST only.")
        return

    try:
        from flask_sock import Sock
        global sock
        sock = Sock(app)

        _WS_PATH = f"{mount_prefix}/api/mp/ws"

        @sock.route(_WS_PATH)
        def mp_ws(ws):
            # Minimal echo; later: broadcast presence, queue updates, etc.
            try:
                while True:
                    msg = ws.receive(timeout=30)
                    if msg is None:
                        break
                    ws.send(msg if isinstance(msg, str) else "ok")
            except Exception:
                pass

        _WS_ENABLED = True
        app.logger.info(f"[mp] WS enabled at {_WS_PATH}")
    except Exception as e:
        _WS_ENABLED = False
        _WS_PATH = None
        app.logger.warning(f"[mp] WS not enabled ({e!r}); REST endpoints only.")
