# mp_api.py — v2.1 (30-min presence + invites + notifications + simple v1 queue + duel sync)
from typing import Optional, Tuple, Dict, Any, List
from flask import Blueprint, jsonify, request, session
from db import conn
import time

mp_bp = Blueprint("mp", __name__)

# --- reuse main app token verifier if available ---
def _import_main_verifier():
    try:
        from app import verify_login_token
        return verify_login_token
    except Exception:
        return None
VERIFY_TOKEN = _import_main_verifier()

# ---------------- presence (in-memory) ----------------
_PRESENCE: Dict[int, float] = {}      # user_id -> last_seen_epoch_seconds
_PRESENCE_TTL = 1800.0                # 30 minutes

def _mark_active(user_id: int):
    if user_id:
        _PRESENCE[int(user_id)] = time.time()

def _is_active(user_id: int) -> bool:
    ts = _PRESENCE.get(int(user_id))
    return bool(ts and (time.time() - ts) < _PRESENCE_TTL)

# ---------------- simple in-memory queue & starts ----------------
_QUEUES: Dict[str, List[int]] = {"v1": []}   # mode -> user_id list
_STARTS: Dict[int, Dict[str, Any]] = {}      # user_id -> start payload

def _username_by_id(uid: int) -> Optional[str]:
    with conn() as cx:
        r = cx.execute("SELECT pi_username FROM users WHERE id=?", (uid,)).fetchone()
        return r["pi_username"] if r else None

def _make_start(mode: str, a: int, b: int) -> Dict[str, Any]:
    return {
        "mode": mode,
        "matchId": int(time.time() * 1000),
        "players": [
            {"id": a, "username": _username_by_id(a)},
            {"id": b, "username": _username_by_id(b)},
        ]
    }

def _try_match_v1():
    q = _QUEUES["v1"]
    if len(q) >= 2:
        a = q.pop(0)
        b = q.pop(0)
        start = _make_start("v1", a, b)
        _STARTS[a] = start
        _STARTS[b] = start

# ---------------- helpers ----------------
def _bearer_from_req():
    t = request.args.get("t") or request.form.get("t")
    if t:
        return t.strip()
    auth = request.headers.get("Authorization", "")
    if auth and auth.lower().startswith("bearer "):
        return auth.split(" ", 1)[1].strip()
    return None

def _current_user_ids() -> Optional[Tuple[int, str, str]]:
    """
    Returns (user_id, pi_uid, pi_username) or None.
    Accepts the izzapay short-lived login token (?t= / Bearer).
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
    want = username.lstrip("@").lower()
    with conn() as cx:
        r = cx.execute(
            "SELECT id FROM users WHERE LOWER(REPLACE(pi_username,'@',''))=?",
            (want,)
        ).fetchone()
        return int(r["id"]) if r else None

def _is_friend(a: int, b: int) -> bool:
    with conn() as cx:
        r = cx.execute(
            """
            SELECT 1
            FROM mp_friend_requests
            WHERE status='accepted'
              AND ((from_user=? AND to_user=?) OR (from_user=? AND to_user=?))
            LIMIT 1
            """,
            (a, b, b, a),
        ).fetchone()
        return bool(r)

# ---------------- minimal duel sync (REST polling) ----------------
# matchId -> {
#   "players": { uid: {"x":float,"y":float,"facing":str,"hp":int,"ts":float,"skin":str} },
#   "ttl": float
# }
_DUELS: Dict[str, Dict[str, Any]] = {}
_DUEL_TTL = 60.0  # seconds of inactivity before cleanup

def _clean_duels():
    now = time.time()
    dead = []
    for mid, obj in _DUELS.items():
        ts = max([p.get("ts",0) for p in obj.get("players",{}).values()] or [0])
        if (now - ts) > _DUEL_TTL:
            dead.append(mid)
    for mid in dead:
        _DUELS.pop(mid, None)

@mp_bp.post("/duel/poke")
def mp_duel_poke():
    """
    Upserts my realtime state into the duel.
    Body: {"matchId": "...", "x": number, "y": number, "facing": "up|down|left|right", "hp": int, "skin": str}
    """
    who = _current_user_ids()
    if not who:
        return jsonify({"error":"not_authenticated"}), 401
    uid, _, _ = who
    data = request.get_json(silent=True) or {}
    mid = str(data.get("matchId") or "").strip()
    if not mid:
        return jsonify({"ok": False, "error": "no_match"}), 400
    _clean_duels()
    d = _DUELS.setdefault(mid, {"players": {}})
    d["players"][uid] = {
        "x": float(data.get("x") or 0.0),
        "y": float(data.get("y") or 0.0),
        "facing": str(data.get("facing") or "down"),
        "hp": int(data.get("hp") or 5),
        "skin": (data.get("skin") or ""),
        "ts": time.time(),
    }
    return jsonify({"ok": True})

@mp_bp.get("/duel/pull")
def mp_duel_pull():
    """
    Returns opponent snapshot.
    Query: ?matchId=...
    """
    who = _current_user_ids()
    if not who:
        return jsonify({"error":"not_authenticated"}), 401
    uid, _, _ = who
    mid = str((request.args.get("matchId") or "").strip())
    if not mid:
        return jsonify({"ok": False, "error": "no_match"}), 400
    _clean_duels()
    d = _DUELS.get(mid) or {"players": {}}
    opp = None
    for k, v in d["players"].items():
        if int(k) != int(uid):
            opp = {"userId": int(k), **v}
            break
    return jsonify({"ok": True, "opponent": opp})
# -----------------------------------------------------------------

# ---------------- endpoints ----------------

@mp_bp.get("/echo")
def mp_echo():
    who = _current_user_ids()
    if who:
        _mark_active(who[0])
    return jsonify({
        "ok": True,
        "q": request.args.get("q"),
        "session_user_id": session.get("user_id"),
        "has_auth_header": bool(request.headers.get("Authorization")),
        "authed": bool(who),
        "who": {"id": who[0], "pi_uid": who[1], "username": who[2]} if who else None,
    })

@mp_bp.get("/me")
def mp_me():
    _ensure_schema()
    who = _current_user_ids()
    if not who:
        return jsonify({"error": "not_authenticated"}), 401
    uid, _, name = who
    _mark_active(uid)
    return jsonify({"username": name, "active": True, "inviteLink": "/izza-game/auth"})

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
            SELECT DISTINCT
                   CASE WHEN fr.from_user=? THEN fr.to_user ELSE fr.from_user END AS fid,
                   u.pi_username AS username
            FROM mp_friend_requests fr
            JOIN users u ON u.id = CASE
                                     WHEN fr.from_user=? THEN fr.to_user
                                     ELSE fr.from_user
                                   END
            WHERE fr.status='accepted'
              AND (fr.from_user=? OR fr.to_user=?)
            ORDER BY u.pi_username COLLATE NOCASE
            """,
            (uid, uid, uid, uid),
        ).fetchall()
    return jsonify({"friends": [
        {"username": r["username"], "active": _is_active(int(r["fid"])), "friend": True}
        for r in rows
    ]})

@mp_bp.get("/players/search")
@mp_bp.get("/friends/search")
def mp_players_search():
    _ensure_schema()
    who = _current_user_ids()
    if not who:
        return jsonify({"error": "not_authenticated"}), 401
    my_id, _, _ = who

    raw_q = (request.args.get("q") or "").strip()
    if len(raw_q) < 2:
        return jsonify({"users": []})

    q = raw_q.lstrip("@").lower()
    like = f"%{q}%"

    with conn() as cx:
        rows = cx.execute(
            """
            SELECT DISTINCT
                   u.id           AS uid,
                   u.pi_username  AS username
            FROM users u
            JOIN game_profiles gp ON gp.pi_uid = u.pi_uid
            WHERE LOWER(REPLACE(u.pi_username,'@','')) LIKE ?
            ORDER BY u.pi_username COLLATE NOCASE
            LIMIT 15
            """,
            (like,),
        ).fetchall()

    users = [{
        "username": r["username"],
        "active": _is_active(int(r["uid"])),
        "friend": _is_friend(my_id, int(r["uid"]))
    } for r in rows]

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
    with conn() as cx:
        cx.execute(
            "INSERT INTO mp_invites(from_user,to_user,mode,ttl_sec,status) VALUES(?,?,?,?, 'pending')",
            (me, to_id, (data.get('mode') or 'v1'), int(data.get('ttlSec') or 1800)),
        )
    return jsonify({"ok": True})

@mp_bp.post("/lobby/accept")
def mp_lobby_accept():
    _ensure_schema()
    who = _current_user_ids()
    if not who:
        return jsonify({"error": "not_authenticated"}), 401
    uid, _, _ = who
    data = (request.get_json(silent=True) or {})
    inv_id = int(data.get("inviteId") or 0)
    if not inv_id:
        return jsonify({"ok": False, "error": "bad_invite"}), 400
    with conn() as cx:
        inv = cx.execute("SELECT * FROM mp_invites WHERE id=? AND to_user=? AND status='pending'", (inv_id, uid)).fetchone()
        if not inv:
            return jsonify({"ok": False, "error": "invite_not_found"}), 404
        cx.execute("UPDATE mp_invites SET status='accepted' WHERE id=?", (inv_id,))
    start = _make_start(inv["mode"] or "v1", int(inv["from_user"]), int(inv["to_user"]))
    _STARTS[int(inv["from_user"])] = start
    _STARTS[int(inv["to_user"])]   = start
    # initialize duel container so /duel/poke doesn't race
    _DUELS[str(start["matchId"])] = {"players": {}}
    return jsonify({"ok": True, "start": start})

@mp_bp.post("/lobby/decline")
def mp_lobby_decline():
    _ensure_schema()
    who = _current_user_ids()
    if not who:
        return jsonify({"error": "not_authenticated"}), 401
    uid, _, _ = who
    data = (request.get_json(silent=True) or {})
    inv_id = int(data.get("inviteId") or 0)
    if not inv_id:
        return jsonify({"ok": False, "error": "bad_invite"}), 400
    with conn() as cx:
        inv = cx.execute("SELECT * FROM mp_invites WHERE id=? AND to_user=? AND status='pending'", (inv_id, uid)).fetchone()
        if not inv:
            return jsonify({"ok": False, "error": "invite_not_found"}), 404
        cx.execute("UPDATE mp_invites SET status='declined' WHERE id=?", (inv_id,))
    return jsonify({"ok": True})

@mp_bp.get("/notifications")
def mp_notifications():
    _ensure_schema()
    who = _current_user_ids()
    if not who:
        return jsonify({"error": "not_authenticated"}), 401
    uid, _, _ = who
    _mark_active(uid)

    start = _STARTS.pop(uid, None)

    with conn() as cx:
        rows = cx.execute(
            """
            SELECT i.id, u.pi_username AS from_username, i.mode
            FROM mp_invites i
            JOIN users u ON u.id = i.from_user
            WHERE i.to_user=? AND i.status='pending'
            ORDER BY i.created_at DESC LIMIT 5
            """,
            (uid,)
        ).fetchall()

    invites = [{"id": r["id"], "from": r["from_username"], "mode": r["mode"] or "v1"} for r in rows]
    return jsonify({"invites": invites, "start": start})

@mp_bp.post("/queue")
def mp_queue():
    _ensure_schema()
    who = _current_user_ids()
    if not who:
        return jsonify({"error": "not_authenticated"}), 401
    uid, _, _ = who
    _mark_active(uid)
    data = (request.get_json(silent=True) or {})
    mode = (data.get("mode") or "v1").lower()

    if mode == "v1":
        if uid not in _QUEUES["v1"]:
            _QUEUES["v1"].append(uid)
        _try_match_v1()
        start = _STARTS.pop(uid, None)
        if start:
            _DUELS[str(start["matchId"])] = {"players": {}}
            return jsonify({"ok": True, "start": start})
        return jsonify({"ok": True, "queued": True})
    return jsonify({"ok": True, "queued": True})

@mp_bp.post("/dequeue")
def mp_dequeue():
    who = _current_user_ids()
    if not who:
        return jsonify({"error":"not_authenticated"}), 401
    uid, _, _ = who
    for m in _QUEUES:
        if uid in _QUEUES[m]:
            _QUEUES[m].remove(uid)
    return jsonify({"ok": True})

# ---- OPTIONAL DEBUG ----
@mp_bp.get("/debug/status")
def mp_debug_status():
    who = _current_user_ids()
    if not who:
        return jsonify({"authed": False}), 401
    uid, pi_uid, uname = who
    _mark_active(uid)
    with conn() as cx:
        has_profile = bool(cx.execute(
            "SELECT 1 FROM game_profiles WHERE pi_uid=? LIMIT 1", (pi_uid,)
        ).fetchone())
        total_users = cx.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"]
    return jsonify({
        "authed": True,
        "user": {"id": uid, "username": uname, "pi_uid": pi_uid, "has_profile": has_profile, "active": True},
        "total_users": total_users
    })

@mp_bp.get("/debug/search")
def mp_debug_search():
    q = (request.args.get("q") or "").strip()
    norm = q.lstrip("@").lower()
    like = f"%{norm}%"
    with conn() as cx:
        rows = cx.execute(
            """
            SELECT u.id AS uid,
                   u.pi_username AS username,
                   (SELECT 1 FROM game_profiles gp WHERE gp.pi_uid=u.pi_uid LIMIT 1) AS has_profile
            FROM users u
            WHERE LOWER(REPLACE(u.pi_username,'@','')) LIKE ?
            ORDER BY u.pi_username COLLATE NOCASE
            LIMIT 20
            """,
            (like,),
        ).fetchall()
    return jsonify({
        "q": q, "norm": norm,
        "results": [{
            "username": r["username"],
            "has_profile": bool(r["has_profile"]),
            "active": _is_active(int(r["uid"]))
        } for r in rows]
    })
