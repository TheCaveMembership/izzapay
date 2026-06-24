# mp_api.py — v3.4.1
# Adds world presence cleanup routes:
#   POST /world/leave
#   POST /presence/offline

from typing import Optional, Tuple, Dict, Any, List
from flask import Blueprint, jsonify, request, session
from db import conn
import time

mp_bp = Blueprint("mp", __name__)

def _import_main_verifier():
    try:
        from app import verify_login_token
        return verify_login_token
    except Exception:
        return None

VERIFY_TOKEN = _import_main_verifier()

def _bearer_from_req():
    t = request.args.get("t") or request.form.get("t")
    if t:
        return t.strip()
    auth = request.headers.get("Authorization", "")
    if auth.lower().startswith("bearer "):
        return auth.split(" ", 1)[1].strip()
    return None

def _current_user_ids() -> Optional[Tuple[int, str, str]]:
    uid = session.get("user_id")
    if not uid:
        tok = _bearer_from_req()
        if tok and VERIFY_TOKEN:
            uid = VERIFY_TOKEN(tok)
    if not uid:
        return None
    with conn() as cx:
        row = cx.execute("SELECT id, pi_uid, pi_username FROM users WHERE id=?", (uid,)).fetchone()
        if not row:
            return None
        return int(row["id"]), row["pi_uid"], row["pi_username"]

def _username_by_id(uid: int) -> Optional[str]:
    with conn() as cx:
        r = cx.execute("SELECT pi_username FROM users WHERE id=?", (uid,)).fetchone()
        return r["pi_username"] if r else None

_WORLDS = ("1", "2", "3", "4")
_WORLD_OF: Dict[int, str] = {}
_WORLD_MEMBERS: Dict[str, set] = {w: set() for w in _WORLDS}
_PRES_TTL = 30.0
_WORLD_STATE: Dict[str, Dict[int, Dict[str, Any]]] = {w: {} for w in _WORLDS}

def _coerce_world(w: Any) -> str:
    s = str(w or "1").strip()
    return s if s in _WORLDS else "1"

def _set_world(uid: int, world: str):
    world = _coerce_world(world)
    for w in _WORLDS:
        _WORLD_MEMBERS[w].discard(uid)
    _WORLD_OF[uid] = world
    _WORLD_MEMBERS[world].add(uid)

def _user_world(uid: int) -> str:
    return _WORLD_OF.get(uid, "1")

def _counts_by_world() -> Dict[str, int]:
    return {w: len(_WORLD_MEMBERS[w]) for w in _WORLDS}

def _sweep_presence():
    now = time.time()
    for w, umap in _WORLD_STATE.items():
        dead = [uid for uid, st in umap.items() if (now - float(st.get("last", 0))) > _PRES_TTL]
        for uid in dead:
            umap.pop(uid, None)
            _WORLD_MEMBERS[w].discard(uid)

def _presence_for(uid: int) -> Dict[str, Any]:
    w = _user_world(uid)
    st = _WORLD_STATE.get(w, {}).get(int(uid))
    last = float(st.get("last", 0.0)) if st else 0.0
    active = bool(st) and (time.time() - last) <= _PRES_TTL
    return {"active": bool(active), "lastSeen": int(last * 1000) if last else 0, "world": w}

def _ensure_schema():
    with conn() as cx:
        cx.executescript("""
        CREATE TABLE IF NOT EXISTS mp_friend_requests(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          from_user INTEGER NOT NULL,
          to_user INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(from_user, to_user)
        );
        CREATE TABLE IF NOT EXISTS mp_invites(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          from_user INTEGER NOT NULL,
          to_user INTEGER NOT NULL,
          mode TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          ttl_sec INTEGER NOT NULL DEFAULT 1800,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS mp_ranks(
          user_id INTEGER PRIMARY KEY,
          br10_w INTEGER DEFAULT 0, br10_l INTEGER DEFAULT 0,
          v1_w INTEGER DEFAULT 0, v1_l INTEGER DEFAULT 0,
          v2_w INTEGER DEFAULT 0, v2_l INTEGER DEFAULT 0,
          v3_w INTEGER DEFAULT 0, v3_l INTEGER DEFAULT 0
        );
        """)

def _user_id_by_username(username: str):
    username = (username or "").strip()
    if not username:
        return None
    want = username.lstrip("@").lower()
    with conn() as cx:
        r = cx.execute(
            "SELECT id FROM users WHERE LOWER(REPLACE(pi_username,'@',''))=?",
            (want,)
        ).fetchone()
        return int(r["id"]) if r else None

def _is_friend(a: int, b: int) -> bool:
    with conn() as cx:
        r = cx.execute("""
            SELECT 1 FROM mp_friend_requests
            WHERE status='accepted'
              AND ((from_user=? AND to_user=?) OR (from_user=? AND to_user=?))
            LIMIT 1
        """, (a, b, b, a)).fetchone()
        return bool(r)

_QUEUES: Dict[str, Dict[str, List[int]]] = {"v1": {w: [] for w in _WORLDS}}
_STARTS: Dict[int, Dict[str, Any]] = {}
_DUELS: Dict[str, Dict[str, Any]] = {}

def _make_start(mode: str, a: int, b: int, world: str) -> Dict[str, Any]:
    return {
        "mode": mode,
        "world": world,
        "matchId": str(int(time.time() * 1000)),
        "players": [
            {"id": a, "username": _username_by_id(a)},
            {"id": b, "username": _username_by_id(b)},
        ]
    }

def _try_match_v1(world: str):
    q = _QUEUES["v1"][world]
    if len(q) >= 2:
        a = q.pop(0)
        b = q.pop(0)
        start = _make_start("v1", a, b, world)
        _STARTS[a] = start
        _STARTS[b] = start
        _DUELS[start["matchId"]] = _new_room("v1", a, b, world)

@mp_bp.post("/world/join")
def mp_world_join():
    _ensure_schema()
    who = _current_user_ids()
    if not who:
        return jsonify({"error": "not_authenticated"}), 401
    uid, _, _ = who
    data = request.get_json(silent=True) or {}
    world = _coerce_world(data.get("worldId") or data.get("world") or request.args.get("world") or "1")
    _set_world(uid, world)
    return jsonify({"ok": True, "world": world})

@mp_bp.get("/worlds/counts")
def mp_world_counts():
    _sweep_presence()
    return jsonify({"ok": True, "counts": _counts_by_world()})

@mp_bp.post("/world/heartbeat")
def mp_world_heartbeat():
    who = _current_user_ids()
    if not who:
        return jsonify({"error": "not_authenticated"}), 401
    uid, _, _ = who
    data = request.get_json(silent=True) or {}
    world = _user_world(uid)

    state = _WORLD_STATE[world].get(uid, {})
    state.update({
        "x": float(data.get("x") or state.get("x") or 0.0),
        "y": float(data.get("y") or state.get("y") or 0.0),
        "facing": data.get("facing") or state.get("facing") or "down",
        "appearance": data.get("appearance") or state.get("appearance") or {},
        "inv": data.get("inv") or state.get("inv") or {},
        "last": time.time(),
        "username": _username_by_id(uid) or state.get("username") or "player"
    })

    _WORLD_STATE[world][uid] = state
    _WORLD_MEMBERS[world].add(uid)
    _sweep_presence()
    return jsonify({"ok": True, "world": world, "now": time.time()})

@mp_bp.post("/world/pos")
def mp_world_pos():
    who = _current_user_ids()
    if not who:
        return jsonify({"error": "not_authenticated"}), 401
    uid, _, _ = who
    world = _user_world(uid)
    data = request.get_json(silent=True) or {}

    st = _WORLD_STATE[world].get(uid, {"username": _username_by_id(uid) or "player"})
    st["x"] = float(data.get("x") or st.get("x") or 0.0)
    st["y"] = float(data.get("y") or st.get("y") or 0.0)
    st["facing"] = data.get("facing") or st.get("facing") or "down"
    st["last"] = time.time()

    _WORLD_STATE[world][uid] = st
    _WORLD_MEMBERS[world].add(uid)
    return jsonify({"ok": True})

@mp_bp.get("/world/roster")
def mp_world_roster():
    who = _current_user_ids()
    if not who:
        return jsonify({"error": "not_authenticated"}), 401
    uid, _, _ = who
    world = _user_world(uid)
    since = float(request.args.get("since") or 0.0)

    _sweep_presence()
    players = []
    for pid, st in _WORLD_STATE[world].items():
        if pid == uid:
            continue
        last = float(st.get("last", 0.0))
        if since and last <= since:
            continue
        players.append({
            "id": pid,
            "username": st.get("username") or _username_by_id(pid) or "player",
            "x": float(st.get("x", 0.0)),
            "y": float(st.get("y", 0.0)),
            "facing": st.get("facing", "down"),
            "appearance": st.get("appearance") or {},
            "inv": st.get("inv") or {},
            "lastUpdate": last
        })

    return jsonify({"ok": True, "world": world, "players": players, "serverNow": time.time()})

@mp_bp.post("/world/leave")
def mp_world_leave():
    who = _current_user_ids()
    if not who:
        return jsonify({"ok": True})

    uid, _, _ = who
    for w in _WORLDS:
        _WORLD_MEMBERS[w].discard(uid)
        _WORLD_STATE[w].pop(uid, None)
    _WORLD_OF.pop(uid, None)

    return jsonify({"ok": True})

@mp_bp.post("/presence/offline")
def mp_presence_offline():
    who = _current_user_ids()
    if not who:
        return jsonify({"ok": True})

    uid, _, _ = who
    for w in _WORLDS:
        _WORLD_MEMBERS[w].discard(uid)
        _WORLD_STATE[w].pop(uid, None)
    _WORLD_OF.pop(uid, None)

    return jsonify({"ok": True})

@mp_bp.get("/me")
def mp_me():
    _ensure_schema()
    who = _current_user_ids()
    if not who:
        return jsonify({"error": "not_authenticated"}), 401
    uid, _, name = who
    p = _presence_for(uid)
    return jsonify({"username": name, **p, "inviteLink": "/izza-game/auth"})

@mp_bp.get("/friends/list")
def mp_friends_list():
    _ensure_schema()
    who = _current_user_ids()
    if not who:
        return jsonify({"error": "not_authenticated"}), 401
    uid, _, _ = who

    with conn() as cx:
        rows = cx.execute("""
            SELECT DISTINCT
                   CASE WHEN fr.from_user=? THEN fr.to_user ELSE fr.from_user END AS fid,
                   u.pi_username AS username
            FROM mp_friend_requests fr
            JOIN users u ON u.id = CASE WHEN fr.from_user=? THEN fr.to_user ELSE fr.from_user END
            WHERE fr.status='accepted' AND (fr.from_user=? OR fr.to_user=?)
            ORDER BY u.pi_username COLLATE NOCASE
        """, (uid, uid, uid, uid)).fetchall()

    friends = []
    for r in rows:
        fid = int(r["fid"])
        friends.append({"username": r["username"], **_presence_for(fid)})
    return jsonify({"friends": friends})

@mp_bp.get("/players/search")
@mp_bp.get("/friends/search")
def mp_players_search():
    _ensure_schema()
    who = _current_user_ids()
    if not who:
        return jsonify({"error": "not_authenticated"}), 401

    raw_q = (request.args.get("q") or "").strip()
    if len(raw_q) < 2:
        return jsonify({"users": []})

    q = raw_q.lstrip("@").lower()
    like = f"%{q}%"

    with conn() as cx:
        rows = cx.execute("""
            SELECT DISTINCT u.id AS uid, u.pi_username AS username
            FROM users u
            JOIN game_profiles gp ON gp.pi_uid=u.pi_uid
            WHERE LOWER(REPLACE(u.pi_username,'@','')) LIKE ?
            ORDER BY u.pi_username COLLATE NOCASE
            LIMIT 15
        """, (like,)).fetchall()

    users = []
    for r in rows:
        uid = int(r["uid"])
        users.append({"username": r["username"], **_presence_for(uid)})
    return jsonify({"users": users})

@mp_bp.post("/friends/request")
def mp_friends_request():
    _ensure_schema()
    who = _current_user_ids()
    if not who:
        return jsonify({"error": "not_authenticated"}), 401
    me, _, _ = who

    data = request.get_json(silent=True) or {}
    to_name = (data.get("toUsername") or data.get("username") or "").strip()
    to_id = _user_id_by_username(to_name)

    if not to_id:
        return jsonify({"ok": False, "error": "player_not_found"}), 404
    if to_id == me:
        return jsonify({"ok": False, "error": "cannot_friend_self"}), 400

    with conn() as cx:
        if _is_friend(me, to_id):
            return jsonify({"ok": True, "already": "friends"})
        try:
            cx.execute(
                "INSERT INTO mp_friend_requests(from_user,to_user,status) VALUES(?,?, 'pending')",
                (me, to_id)
            )
        except Exception:
            cx.execute("""
                UPDATE mp_friend_requests
                SET status='pending'
                WHERE ((from_user=? AND to_user=?) OR (from_user=? AND to_user=?))
                  AND status!='accepted'
            """, (me, to_id, to_id, me))

    return jsonify({"ok": True})

@mp_bp.post("/friends/accept")
def mp_friends_accept():
    _ensure_schema()
    who = _current_user_ids()
    if not who:
        return jsonify({"error": "not_authenticated"}), 401
    me, _, _ = who

    data = request.get_json(silent=True) or {}
    req_id = data.get("requestId")
    from_name = (data.get("from") or data.get("username") or "").strip()

    with conn() as cx:
        row = None
        if req_id:
            row = cx.execute(
                "SELECT * FROM mp_friend_requests WHERE id=? AND to_user=? AND status='pending'",
                (int(req_id), me)
            ).fetchone()
        else:
            from_id = _user_id_by_username(from_name)
            if from_id:
                row = cx.execute(
                    "SELECT * FROM mp_friend_requests WHERE from_user=? AND to_user=? AND status='pending'",
                    (from_id, me)
                ).fetchone()

        if not row:
            return jsonify({"ok": False, "error": "request_not_found"}), 404

        cx.execute("UPDATE mp_friend_requests SET status='accepted' WHERE id=?", (row["id"],))

    return jsonify({"ok": True})

@mp_bp.post("/friends/decline")
def mp_friends_decline():
    _ensure_schema()
    who = _current_user_ids()
    if not who:
        return jsonify({"error": "not_authenticated"}), 401
    me, _, _ = who

    data = request.get_json(silent=True) or {}
    req_id = data.get("requestId")
    from_name = (data.get("from") or data.get("username") or "").strip()

    with conn() as cx:
        row = None
        if req_id:
            row = cx.execute(
                "SELECT * FROM mp_friend_requests WHERE id=? AND to_user=? AND status='pending'",
                (int(req_id), me)
            ).fetchone()
        else:
            from_id = _user_id_by_username(from_name)
            if from_id:
                row = cx.execute(
                    "SELECT * FROM mp_friend_requests WHERE from_user=? AND to_user=? AND status='pending'",
                    (from_id, me)
                ).fetchone()

        if not row:
            return jsonify({"ok": False, "error": "request_not_found"}), 404

        cx.execute("UPDATE mp_friend_requests SET status='declined' WHERE id=?", (row["id"],))

    return jsonify({"ok": True})
