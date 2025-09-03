# mp_api.py — v2.3 (30-min presence + invites + notifications + simple v1 queue + duel REST sync + PvP damage + robot)
from typing import Optional, Tuple, Dict, Any, List
from flask import Blueprint, jsonify, request, session
from db import conn
import time
import math
import random

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
    if uid == -1:
        return "robot"
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
        _seed_duel_from_start(start)

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
    """
    Case/at-symbol insensitive resolver: 'CamMac' == '@CamMac'
    """
    username = (username or "").strip()
    if not username:
        return None
    want = username.lstrip("@").lower()
    if want in ("robot", "bot", "testbot"):
        return -1  # special robot id
    with conn() as cx:
        r = cx.execute(
            "SELECT id FROM users WHERE LOWER(REPLACE(pi_username,'@',''))=?",
            (want,)
        ).fetchone()
        return int(r["id"]) if r else None

def _is_friend(a: int, b: int) -> bool:
    if a == -1 or b == -1:
        return True  # allow robot without friendship
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

# ---------------- DUEL STATE (REST sync; no websockets) ----------------
# Hearts model: 4.0 hearts total (so 0.25 = quarter)
_DUELS: Dict[str, Dict[str, Any]] = {}  # matchId -> {mode, created, players:{uid:{x,y,facing,hp,hits_melee,inv,username,is_bot}}}

_PVP_DAMAGE = {
    "pistol": 0.25,
    "uzi":    0.25,
    "grenade":1.00,
    # melee below handled with counters (every 2 hits)
}

def _seed_duel_from_start(start: Dict[str, Any]):
    mid = str(start["matchId"])
    players = {}
    for p in start["players"]:
        uid = int(p["id"])
        players[uid] = {
            "x": 0.0, "y": 0.0, "facing": "down",
            "hp": 4.0,                   # 4 hearts
            "hits_melee": 0,             # for 1/4 per 2 hits (hand)
            "hits_bat":   0,             # 1/2 per 2 hits (bat)
            "hits_knucks":0,             # 1/2 per 2 hits (knucks)
            "inv": {},                   # equipped snapshot if client sends
            "username": _username_by_id(uid),
            "is_bot": (uid == -1)
        }
    _DUELS[mid] = {"mode": start["mode"], "created": time.time(), "players": players}

def _duel_for_user(uid: int) -> Optional[Dict[str, Any]]:
    # find duel for this user (linear scan is fine for test)
    for mid, d in _DUELS.items():
        if uid in d["players"]:
            return d
    return None

# Robot simple brain (wanders + sometimes fires)
def _tick_robot(mid: str):
    d = _DUELS.get(mid)
    if not d:
        return
    for uid, st in list(d["players"].items()):
        if not st.get("is_bot"):
            continue
        # wander inside a safe box (Tier 2 default)
        speed = 60.0  # px/sec
        dt = 0.12
        ang = random.random() * math.tau
        st["x"] += math.cos(ang) * speed * dt
        st["y"] += math.sin(ang) * speed * dt
        st["facing"] = random.choice(["up","down","left","right"])
        # 10% chance to "fire" a pistol -> apply damage if close enough (2 tiles)
        others = [k for k in d["players"].keys() if k != uid]
        if others and random.random() < 0.10:
            tgt = d["players"][others[0]]
            if (abs(tgt["x"] - st["x"])**2 + abs(tgt["y"] - st["y"])**2) ** 0.5 < 64.0:
                tgt["hp"] = max(0.0, tgt["hp"] - _PVP_DAMAGE["pistol"])

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
    users = []
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
    for r in rows:
        users.append({
            "username": r["username"],
            "active": _is_active(int(r["uid"])),
            "friend": _is_friend(my_id, int(r["uid"]))
        })
    # add robot to search if it matches
    if "robot".startswith(q):
        users.append({"username": "robot", "active": True, "friend": True})
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
    if to_id is None:
        return jsonify({"ok": False, "error": "player_not_found"}), 404
    if to_id == me:
        return jsonify({"ok": False, "error": "cannot_invite_self"}), 400
    if to_id != -1 and not _is_friend(me, to_id):
        # allow testing: not enforcing friendship strictly
        pass
    # insert or auto-accept for robot
    if to_id == -1:
        start = _make_start("v1", me, -1)
        _STARTS[me] = start
        _STARTS[-1] = start
        _seed_duel_from_start(start)
        return jsonify({"ok": True, "robot": True})
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
    _seed_duel_from_start(start)
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

# ---------------- DUEL SYNC + DAMAGE (REST) ----------------

@mp_bp.post("/duel/poke")
def duel_poke():
    who = _current_user_ids()
    if not who:
        return jsonify({"error": "not_authenticated"}), 401
    uid, _, uname = who
    data = (request.get_json(silent=True) or {})
    mid = str(data.get("matchId") or "")
    if not mid or mid not in _DUELS:
        return jsonify({"ok": False, "error": "no_match"}), 404
    d = _DUELS[mid]
    st = d["players"].get(uid)
    if not st:
        return jsonify({"ok": False, "error": "not_in_match"}), 400

    st["x"] = float(data.get("x") or st["x"])
    st["y"] = float(data.get("y") or st["y"])
    st["facing"] = (data.get("facing") or st["facing"])[:8]
    if "hp" in data:
        # client may send local hp for UI sync; server treats server hp as truth, but clamp to server if lower
        st["hp"] = max(0.0, min(4.0, float(st["hp"])))
    inv = data.get("inv")
    if isinstance(inv, dict):
        st["inv"] = inv
    st["username"] = uname

    # bot AI tick if any bot present
    for k, v in d["players"].items():
        if v.get("is_bot"):
            _tick_robot(mid)
            break

    return jsonify({"ok": True})

@mp_bp.get("/duel/pull")
def duel_pull():
    who = _current_user_ids()
    if not who:
        return jsonify({"error": "not_authenticated"}), 401
    uid, _, uname = who
    mid = str(request.args.get("matchId") or "")
    if not mid or mid not in _DUELS:
        return jsonify({"ok": False, "error": "no_match"}), 404
    d = _DUELS[mid]
    me = d["players"].get(uid)
    if not me:
        return jsonify({"ok": False, "error": "not_in_match"}), 400
    opp = None
    for k, v in d["players"].items():
        if k != uid:
            opp = v
            break
    if not opp:
        return jsonify({"ok": True, "done": True})

    return jsonify({
        "ok": True,
        "me": {"hp": me["hp"]},
        "opponent": {
            "username": opp["username"],
            "x": opp["x"], "y": opp["y"],
            "facing": opp["facing"],
            "hp": opp["hp"],
            "inv": opp.get("inv", {})
        }
    })

@mp_bp.post("/duel/hit")
def duel_hit():
    """
    Apply damage to the opponent. Client calls when a local action should count
    (pistol/uzi bullet connected, grenade explosion near target, or melee cadence).
    """
    who = _current_user_ids()
    if not who:
        return jsonify({"error": "not_authenticated"}), 401
    uid, _, _ = who
    data = (request.get_json(silent=True) or {})
    mid = str(data.get("matchId") or "")
    kind = (data.get("kind") or "").lower()
    if not mid or mid not in _DUELS:
        return jsonify({"ok": False, "error": "no_match"}), 404
    d = _DUELS[mid]
    if uid not in d["players"]:
        return jsonify({"ok": False, "error": "not_in_match"}), 400

    # find opponent
    opp_uid = None
    for k in d["players"].keys():
        if k != uid:
            opp_uid = k
            break
    if opp_uid is None:
        return jsonify({"ok": False})
    opp = d["players"][opp_uid]

    dmg = 0.0
    if kind in ("pistol", "uzi", "grenade"):
        dmg = _PVP_DAMAGE[kind]
    elif kind == "hand":
        d["players"][uid]["hits_melee"] = (d["players"][uid]["hits_melee"] or 0) + 1
        if d["players"][uid]["hits_melee"] % 2 == 0:
            dmg = 0.25
    elif kind == "bat":
        d["players"][uid]["hits_bat"] = (d["players"][uid]["hits_bat"] or 0) + 1
        if d["players"][uid]["hits_bat"] % 2 == 0:
            dmg = 0.50
    elif kind == "knucks":
        d["players"][uid]["hits_knucks"] = (d["players"][uid]["hits_knucks"] or 0) + 1
        if d["players"][uid]["hits_knucks"] % 2 == 0:
            dmg = 0.50

    if dmg > 0:
        opp["hp"] = max(0.0, opp["hp"] - dmg)

    return jsonify({"ok": True, "hp": opp["hp"]})

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
