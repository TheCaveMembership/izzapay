# friends_api.py
import time, sqlite3
from typing import Optional
from flask import Blueprint, request, jsonify, abort, session
from db import conn as _conn

bp = Blueprint("friends", __name__)

# ---------- db helpers ----------
def _db(): return _conn()
def _now() -> int: return int(time.time())

def _norm_username(u: Optional[str]) -> Optional[str]:
    if not u: return None
    u = str(u).strip().lstrip("@").lower()
    return u or None

def _current_user() -> Optional[str]:
    # prefer explicit ?u=, fall back to session
    u = _norm_username(request.args.get("u"))
    if u: return u
    u = _norm_username(session.get("pi_username"))
    return u

def _ensure_social_tables():
    with _db() as cx:
        cx.execute("""
        CREATE TABLE IF NOT EXISTS friend_requests(
          id INTEGER PRIMARY KEY,
          from_user TEXT NOT NULL,
          to_user   TEXT NOT NULL,
          status    TEXT NOT NULL DEFAULT 'pending',  -- pending|accepted|declined|cancelled|auto_accepted
          created_at INTEGER NOT NULL,
          decided_at INTEGER,
          UNIQUE(from_user, to_user) ON CONFLICT IGNORE
        )""")
        cx.execute("CREATE INDEX IF NOT EXISTS idx_fr_to   ON friend_requests(to_user)")
        cx.execute("CREATE INDEX IF NOT EXISTS idx_fr_from ON friend_requests(from_user)")
        cx.execute("""
        CREATE TABLE IF NOT EXISTS friendships(
          id INTEGER PRIMARY KEY,
          u1 TEXT NOT NULL,
          u2 TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          UNIQUE(u1,u2) ON CONFLICT IGNORE
        )""")
        cx.execute("CREATE INDEX IF NOT EXISTS idx_fs_u1 ON friendships(u1)")
        cx.execute("CREATE INDEX IF NOT EXISTS idx_fs_u2 ON friendships(u2)")
        cx.execute("""
        CREATE TABLE IF NOT EXISTS battle_requests(
          id INTEGER PRIMARY KEY,
          from_user TEXT NOT NULL,
          to_user   TEXT NOT NULL,
          creature_code TEXT NOT NULL,   -- sender's chosen creature
          status    TEXT NOT NULL DEFAULT 'pending',  -- pending|accepted|declined|cancelled
          created_at INTEGER NOT NULL,
          decided_at INTEGER
        )""")
        cx.execute("CREATE INDEX IF NOT EXISTS idx_br_to   ON battle_requests(to_user)")
        cx.execute("CREATE INDEX IF NOT EXISTS idx_br_from ON battle_requests(from_user)")
        cx.commit()

def _ensure_users_index():
    with _db() as cx:
        # Users table is pre-existing in your project
        cx.execute("CREATE INDEX IF NOT EXISTS idx_users_pi_username ON users(pi_username)")
        cx.commit()

def _are_friends(a: str, b: str) -> bool:
    u1, u2 = sorted([a, b])
    with _db() as cx:
        r = cx.execute("SELECT 1 FROM friendships WHERE u1=? AND u2=? LIMIT 1", (u1, u2)).fetchone()
    return bool(r)

def _make_friends(a: str, b: str):
    u1, u2 = sorted([a, b])
    with _db() as cx:
        cx.execute("INSERT OR IGNORE INTO friendships(u1,u2,created_at) VALUES(?,?,?)", (u1, u2, _now()))
        cx.commit()

# ---------- search ----------
@bp.get("/api/friends/search")
def friends_search():
    _ensure_social_tables(); _ensure_users_index()
    q = (request.args.get("q") or "").strip().lower()
    if len(q) < 1:
        return jsonify({"items": []})
    me = _current_user()
    like = f"%{q}%"
    with _db() as cx:
        rows = cx.execute(
            """
            SELECT DISTINCT LOWER(pi_username) AS u
            FROM users
            WHERE pi_username IS NOT NULL AND pi_username != '' AND LOWER(pi_username) LIKE ?
            ORDER BY u LIMIT 30
            """, (like,)
        ).fetchall()
    items = [r["u"] if isinstance(r, dict) else r[0] for r in rows]
    if me:
        items = [u for u in items if u != me]
    return jsonify({"items": items})

# ---------- friend requests ----------
@bp.post("/api/friends/request")
def friends_request():
    _ensure_social_tables()
    me = _current_user()
    if not me: abort(401, "auth_required")
    j = request.get_json(silent=True) or {}
    to_user = _norm_username(j.get("to_user"))
    if not to_user or to_user == me:
        abort(400, "invalid_target")

    # Already friends?
    if _are_friends(me, to_user):
        return jsonify({"ok": True, "already_friends": True})

    now = _now()
    with _db() as cx:
        # If they already sent me a pending request, auto-accept both ways
        rev = cx.execute("""SELECT id FROM friend_requests
                            WHERE from_user=? AND to_user=? AND status='pending'""",
                         (to_user, me)).fetchone()
        if rev:
            cx.execute("UPDATE friend_requests SET status='accepted', decided_at=? WHERE id=?", (now, rev["id"] if isinstance(rev, dict) else rev[0]))
            _make_friends(me, to_user)
            cx.commit()
            return jsonify({"ok": True, "auto_accepted": True})

        # Otherwise create my outgoing request if none exists
        cx.execute("""INSERT OR IGNORE INTO friend_requests(from_user,to_user,status,created_at)
                      VALUES(?,?, 'pending', ?)""", (me, to_user, now))
        cx.commit()
    return jsonify({"ok": True})

@bp.get("/api/friends/inbox")
def friends_inbox():
    _ensure_social_tables()
    me = _current_user()
    if not me: abort(401, "auth_required")
    with _db() as cx:
        rows = cx.execute("""SELECT id, from_user, created_at FROM friend_requests
                             WHERE to_user=? AND status='pending' ORDER BY created_at DESC LIMIT 100""", (me,)).fetchall()
    items = [dict(r) for r in rows]
    return jsonify({"items": items})

@bp.get("/api/friends/outbox")
def friends_outbox():
    _ensure_social_tables()
    me = _current_user()
    if not me: abort(401, "auth_required")
    with _db() as cx:
        rows = cx.execute("""SELECT id, to_user, created_at, status FROM friend_requests
                             WHERE from_user=? AND status='pending' ORDER BY created_at DESC LIMIT 100""", (me,)).fetchall()
    items = [dict(r) for r in rows]
    return jsonify({"items": items})

@bp.post("/api/friends/act")
def friends_act():
    _ensure_social_tables()
    me = _current_user()
    if not me: abort(401, "auth_required")
    j = request.get_json(silent=True) or {}
    req_id = int(j.get("id") or 0)
    action = (j.get("action") or "").strip().lower()  # accept|decline|cancel
    if req_id <= 0 or action not in ("accept","decline","cancel"):
        abort(400, "bad_request")

    with _db() as cx:
        req = cx.execute("SELECT id, from_user, to_user, status FROM friend_requests WHERE id=?", (req_id,)).fetchone()
        if not req: abort(404, "not_found")
        from_user = req["from_user"] if isinstance(req, dict) else req[1]
        to_user   = req["to_user"]   if isinstance(req, dict) else req[2]
        status    = req["status"]    if isinstance(req, dict) else req[3]

        # perms
        if action in ("accept","decline") and to_user != me: abort(403)
        if action == "cancel" and from_user != me: abort(403)
        if status != "pending": return jsonify({"ok": True, "noop": True})

        if action == "accept":
            cx.execute("UPDATE friend_requests SET status='accepted', decided_at=? WHERE id=?", (_now(), req_id))
            _make_friends(from_user, to_user)
        elif action == "decline":
            cx.execute("UPDATE friend_requests SET status='declined', decided_at=? WHERE id=?", (_now(), req_id))
        else:  # cancel
            cx.execute("UPDATE friend_requests SET status='cancelled', decided_at=? WHERE id=?", (_now(), req_id))
        cx.commit()
    return jsonify({"ok": True})

@bp.get("/api/friends/list")
def friends_list():
    _ensure_social_tables()
    me = _current_user()
    if not me: abort(401, "auth_required")
    with _db() as cx:
        rows = cx.execute("""SELECT u1,u2 FROM friendships
                             WHERE u1=? OR u2=? ORDER BY created_at DESC LIMIT 500""", (me, me)).fetchall()
    friends = []
    for r in rows:
        u1 = r["u1"] if isinstance(r, dict) else r[0]
        u2 = r["u2"] if isinstance(r, dict) else r[1]
        friends.append(u2 if u1 == me else u1)
    # unique, preserve order
    seen, out = set(), []
    for u in friends:
        if u not in seen:
            seen.add(u); out.append(u)
    return jsonify({"items": out})

# ---------- battle requests (pre-battle scaffold) ----------
@bp.post("/api/battle/request")
def battle_request():
    _ensure_social_tables()
    me = _current_user()
    if not me: abort(401, "auth_required")
    j = request.get_json(silent=True) or {}
    to_user = _norm_username(j.get("to_user"))
    creature_code = (j.get("creature_code") or "").strip().upper()
    if not to_user or to_user == me or not creature_code:
        abort(400, "invalid_payload")
    if not _are_friends(me, to_user):
        abort(400, "not_friends")

    with _db() as cx:
        cx.execute("""INSERT INTO battle_requests(from_user,to_user,creature_code,status,created_at)
                      VALUES(?,?,?, 'pending', ?)""", (me, to_user, creature_code, _now()))
        cx.commit()
    return jsonify({"ok": True})

@bp.get("/api/battle/inbox")
def battle_inbox():
    _ensure_social_tables()
    me = _current_user()
    if not me: abort(401, "auth_required")
    with _db() as cx:
        rows = cx.execute("""SELECT id, from_user, creature_code, created_at
                             FROM battle_requests
                             WHERE to_user=? AND status='pending'
                             ORDER BY created_at DESC LIMIT 100""", (me,)).fetchall()
    return jsonify({"items": [dict(r) for r in rows]})

@bp.post("/api/battle/act")
def battle_act():
    _ensure_social_tables()
    me = _current_user()
    if not me: abort(401, "auth_required")
    j = request.get_json(silent=True) or {}
    req_id = int(j.get("id") or 0)
    action = (j.get("action") or "").strip().lower()  # accept|decline|cancel
    my_creature_code = (j.get("creature_code") or "").strip().upper()
    if req_id <= 0 or action not in ("accept","decline","cancel"):
        abort(400, "bad_request")

    with _db() as cx:
        row = cx.execute("SELECT id, from_user, to_user, status FROM battle_requests WHERE id=?", (req_id,)).fetchone()
        if not row: abort(404, "not_found")
        from_user = row["from_user"] if isinstance(row, dict) else row[1]
        to_user   = row["to_user"]   if isinstance(row, dict) else row[2]
        status    = row["status"]    if isinstance(row, dict) else row[3]

        if action in ("accept","decline") and to_user != me: abort(403)
        if action == "cancel" and from_user != me: abort(403)
        if status != "pending": return jsonify({"ok": True, "noop": True})

        if action == "accept":
            # For now, just mark accepted; your battle engine can consume this row
            if not my_creature_code:
                abort(400, "choose_creature_required")
            cx.execute("UPDATE battle_requests SET status='accepted', decided_at=? WHERE id=?", (_now(), req_id))
            # Optionally create a row in a future battle_matches table here
        elif action == "decline":
            cx.execute("UPDATE battle_requests SET status='declined', decided_at=? WHERE id=?", (_now(), req_id))
        else:
            cx.execute("UPDATE battle_requests SET status='cancelled', decided_at=? WHERE id=?", (_now(), req_id))
        cx.commit()
    return jsonify({"ok": True})

# ---------- notifications ----------
@bp.get("/api/notify/counters")
def notify_counters():
    _ensure_social_tables()
    me = _current_user()
    if not me: abort(401, "auth_required")
    with _db() as cx:
        fr = cx.execute("SELECT COUNT(*) AS c FROM friend_requests WHERE to_user=? AND status='pending'", (me,)).fetchone()
        br = cx.execute("SELECT COUNT(*) AS c FROM battle_requests WHERE to_user=? AND status='pending'", (me,)).fetchone()
    c_fr = fr["c"] if isinstance(fr, dict) else fr[0]
    c_br = br["c"] if isinstance(br, dict) else br[0]
    return jsonify({"friend_requests": int(c_fr), "battle_requests": int(c_br), "total": int(c_fr) + int(c_br)})
