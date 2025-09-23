# mp_api.py — v3.3 (world-aware queues + smoother PvP pull timing)
# Keeps: friends, invites, best-of-3 duels, tracer sharing, mirrored cops, equipped-weapon mirroring, /duel/selfdown
# Adds:
#   - /world/join  (POST)    -> { ok:true }
#   - /worlds/counts (GET)   -> { counts: {"1":N1,"2":N2,"3":N3,"4":N4} }
#   - World-scoped v1 queues and duel rooms
#   - Pull payload timing hints: serverNow, lastUpdate for me/opponent

from typing import Optional, Tuple, Dict, Any, List
from flask import Blueprint, jsonify, request, session
from db import conn
import time

mp_bp = Blueprint("mp", __name__)

# ---- auth bridge -------------------------------------------------------------

def _import_main_verifier():
    try:
        from app import verify_login_token
        return verify_login_token
    except Exception:
        return None
VERIFY_TOKEN = _import_main_verifier()

def _bearer_from_req():
    t = request.args.get("t") or request.form.get("t")
    if t: return t.strip()
    auth = request.headers.get("Authorization","")
    if auth.lower().startswith("bearer "): return auth.split(" ",1)[1].strip()
    return None

def _current_user_ids() -> Optional[Tuple[int, str, str]]:
    uid = session.get("user_id")
    if not uid:
        tok = _bearer_from_req()
        if tok and VERIFY_TOKEN:
            uid = VERIFY_TOKEN(tok)
    if not uid: return None
    with conn() as cx:
        row = cx.execute("SELECT id, pi_uid, pi_username FROM users WHERE id=?", (uid,)).fetchone()
        if not row: return None
        return int(row["id"]), row["pi_uid"], row["pi_username"]

# ---- presence / helpers ------------------------------------------------------

_PRESENCE: Dict[int, float] = {}
_PRESENCE_TTL = 1800.0
def _mark_active(uid:int): _PRESENCE[int(uid)] = time.time()
def _is_active(uid:int)->bool:
    t=_PRESENCE.get(int(uid)); return bool(t and (time.time()-t) < _PRESENCE_TTL)

def _username_by_id(uid: int) -> Optional[str]:
    with conn() as cx:
        r = cx.execute("SELECT pi_username FROM users WHERE id=?", (uid,)).fetchone()
        return r["pi_username"] if r else None

# ---- Worlds (memory, in-proc) -----------------------------------------------
# Backward-friendly defaults: world '1' unless a user POSTs /world/join.
_WORLDS = ("1","2","3","4")
_WORLD_OF: Dict[int, str] = {}                 # uid -> worldId
_WORLD_MEMBERS: Dict[str, set] = {w:set() for w in _WORLDS}

def _coerce_world(w: Any) -> str:
    s = str(w or "1").strip()
    return s if s in _WORLDS else "1"

def _set_world(uid:int, world:str):
    world = _coerce_world(world)
    # remove from all first
    for w in _WORLDS:
        _WORLD_MEMBERS[w].discard(uid)
    _WORLD_OF[uid] = world
    _WORLD_MEMBERS[world].add(uid)

def _user_world(uid:int) -> str:
    return _WORLD_OF.get(uid, "1")

def _counts_by_world() -> Dict[str,int]:
    return {w: len(_WORLD_MEMBERS[w]) for w in _WORLDS}

# ---- minimal schema (friends/invites/rank) ----------------------------------

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
    username=(username or "").strip()
    if not username: return None
    want=username.lstrip("@").lower()
    with conn() as cx:
        r=cx.execute("SELECT id FROM users WHERE LOWER(REPLACE(pi_username,'@',''))=?", (want,)).fetchone()
        return int(r["id"]) if r else None

def _is_friend(a:int,b:int)->bool:
    with conn() as cx:
        r=cx.execute("""SELECT 1 FROM mp_friend_requests
                        WHERE status='accepted'
                          AND ((from_user=? AND to_user=?) OR (from_user=? AND to_user=?))
                        LIMIT 1""",(a,b,b,a)).fetchone()
        return bool(r)

# ---- simple mm queues (per world) -------------------------------------------

_QUEUES: Dict[str, Dict[str, List[int]]] = {
    "v1": { w:[] for w in _WORLDS }
}
_STARTS: Dict[int, Dict[str, Any]] = {}  # per-user "start" payloads

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

def _try_match_v1(world:str):
    q=_QUEUES["v1"][world]
    if len(q)>=2:
        a=q.pop(0); b=q.pop(0)
        start=_make_start("v1", a, b, world)
        _STARTS[a]=start; _STARTS[b]=start
        _DUELS[start["matchId"]] = _new_room("v1", a, b, world)

# ---- API: worlds -------------------------------------------------------------

@mp_bp.post("/world/join")
def mp_world_join():
    _ensure_schema()
    who=_current_user_ids()
    if not who: return jsonify({"error":"not_authenticated"}), 401
    uid,_,_=who
    data=(request.get_json(silent=True) or {})
    world = _coerce_world(data.get("worldId") or data.get("world") or request.args.get("world") or "1")
    _set_world(uid, world)
    _mark_active(uid)
    return jsonify({"ok":True,"world":world})

@mp_bp.get("/worlds/counts")
def mp_world_counts():
    # public-ish; no auth required for a simple count
    return jsonify({"ok":True, "counts": _counts_by_world()})

# ---- API: me/friends/search/lobby -------------------------------------------

@mp_bp.get("/me")
def mp_me():
    _ensure_schema()
    who=_current_user_ids()
    if not who: return jsonify({"error":"not_authenticated"}), 401
    uid,_,name=who; _mark_active(uid)
    # if user never set world, default to '1' & mark
    if uid not in _WORLD_OF: _set_world(uid, "1")
    return jsonify({"username":name,"active":True,"world":_user_world(uid),"inviteLink":"/izza-game/auth"})

@mp_bp.get("/friends/list")
def mp_friends_list():
    _ensure_schema()
    who=_current_user_ids()
    if not who: return jsonify({"error":"not_authenticated"}), 401
    uid,_,_=who
    with conn() as cx:
        rows=cx.execute("""
            SELECT DISTINCT
                   CASE WHEN fr.from_user=? THEN fr.to_user ELSE fr.from_user END AS fid,
                   u.pi_username AS username
            FROM mp_friend_requests fr
            JOIN users u ON u.id = CASE WHEN fr.from_user=? THEN fr.to_user ELSE fr.from_user END
            WHERE fr.status='accepted' AND (fr.from_user=? OR fr.to_user=?)
            ORDER BY u.pi_username COLLATE NOCASE
        """,(uid,uid,uid,uid)).fetchall()
    friends=[{"username":r["username"],"active":_is_active(int(r["fid"])), "friend":True} for r in rows]
    return jsonify({"friends":friends})

@mp_bp.get("/players/search")
@mp_bp.get("/friends/search")
def mp_players_search():
    _ensure_schema()
    who=_current_user_ids()
    if not who: return jsonify({"error":"not_authenticated"}), 401
    my_id,_,_=who
    raw_q=(request.args.get("q") or "").strip()
    if len(raw_q)<2: return jsonify({"users":[]})
    q=raw_q.lstrip("@").lower(); like=f"%{q}%"
    with conn() as cx:
        rows=cx.execute("""
            SELECT DISTINCT u.id AS uid, u.pi_username AS username
            FROM users u
            JOIN game_profiles gp ON gp.pi_uid=u.pi_uid
            WHERE LOWER(REPLACE(u.pi_username,'@','')) LIKE ?
            ORDER BY u.pi_username COLLATE NOCASE
            LIMIT 15
        """,(like,)).fetchall()
    users=[{"username":r["username"],"active":_is_active(int(r["uid"])),"friend":_is_friend(my_id,int(r["uid"]))} for r in rows]
    return jsonify({"users":users})

# ---- Friends: request / accept / decline ------------------------------------

@mp_bp.post("/friends/request")
def mp_friends_request():
    _ensure_schema()
    who = _current_user_ids()
    if not who: return jsonify({"error":"not_authenticated"}), 401
    me,_,_ = who

    data = (request.get_json(silent=True) or {})
    to_name = (data.get("toUsername") or data.get("username") or "").strip()
    to_id = _user_id_by_username(to_name)
    if not to_id: return jsonify({"ok":False, "error":"player_not_found"}), 404
    if to_id == me: return jsonify({"ok":False, "error":"cannot_friend_self"}), 400

    with conn() as cx:
        if _is_friend(me, to_id):
            return jsonify({"ok": True, "already":"friends"})
        try:
            cx.execute("""INSERT INTO mp_friend_requests(from_user,to_user,status)
                          VALUES(?,?, 'pending')""", (me, to_id))
        except Exception:
            cx.execute("""UPDATE mp_friend_requests
                          SET status='pending'
                          WHERE ((from_user=? AND to_user=?) OR (from_user=? AND to_user=?))
                            AND status!='accepted'""", (me, to_id, to_id, me))
    return jsonify({"ok": True})

@mp_bp.post("/friends/accept")
def mp_friends_accept():
    _ensure_schema()
    who = _current_user_ids()
    if not who: return jsonify({"error":"not_authenticated"}), 401
    me,_,_ = who

    data = (request.get_json(silent=True) or {})
    req_id = data.get("requestId")
    from_name = (data.get("from") or data.get("username") or "").strip()

    with conn() as cx:
        if req_id:
            row = cx.execute("""SELECT * FROM mp_friend_requests
                                WHERE id=? AND to_user=? AND status='pending'""",
                             (int(req_id), me)).fetchone()
        else:
            from_id = _user_id_by_username(from_name)
            row = None
            if from_id:
                row = cx.execute("""SELECT * FROM mp_friend_requests
                                    WHERE from_user=? AND to_user=? AND status='pending'""",
                                 (from_id, me)).fetchone()
        if not row:
            return jsonify({"ok":False, "error":"request_not_found"}), 404

        cx.execute("UPDATE mp_friend_requests SET status='accepted' WHERE id=?", (row["id"],))

    return jsonify({"ok": True})

@mp_bp.post("/friends/decline")
def mp_friends_decline():
    _ensure_schema()
    who = _current_user_ids()
    if not who: return jsonify({"error":"not_authenticated"}), 401
    me,_,_ = who

    data = (request.get_json(silent=True) or {})
    req_id = data.get("requestId")
    from_name = (data.get("from") or data.get("username") or "").strip()

    with conn() as cx:
        if req_id:
            row = cx.execute("""SELECT * FROM mp_friend_requests
                                WHERE id=? AND to_user=? AND status='pending'""",
                             (int(req_id), me)).fetchone()
        else:
            from_id = _user_id_by_username(from_name)
            row = None
            if from_id:
                row = cx.execute("""SELECT * FROM mp_friend_requests
                                    WHERE from_user=? AND to_user=? AND status='pending'""",
                                 (from_id, me)).fetchone()
        if not row:
            return jsonify({"ok":False, "error":"request_not_found"}), 404

        cx.execute("UPDATE mp_friend_requests SET status='declined' WHERE id=?", (row["id"],))

    return jsonify({"ok": True})

# ---- Lobby / invites ---------------------------------------------------------

@mp_bp.post("/lobby/invite")
def mp_lobby_invite():
    _ensure_schema()
    who=_current_user_ids()
    if not who: return jsonify({"error":"not_authenticated"}), 401
    me,_,_=who
    to=( (request.get_json(silent=True) or {}).get("toUsername") or "" ).strip()
    to_id=_user_id_by_username(to)
    if not to_id: return jsonify({"ok":False,"error":"player_not_found"}),404
    if to_id==me: return jsonify({"ok":False,"error":"cannot_invite_self"}),400
    with conn() as cx:
        cx.execute("INSERT INTO mp_invites(from_user,to_user,mode,ttl_sec,status) VALUES(?,?,?,?, 'pending')",
                   (me, to_id, 'v1', 1800))
    return jsonify({"ok":True})

@mp_bp.post("/lobby/accept")
def mp_lobby_accept():
    _ensure_schema()
    who=_current_user_ids()
    if not who: return jsonify({"error":"not_authenticated"}), 401
    uid,_,_=who
    data=(request.get_json(silent=True) or {})
    inv_id=int(data.get("inviteId") or 0)
    if not inv_id: return jsonify({"ok":False,"error":"bad_invite"}),400
    with conn() as cx:
        inv=cx.execute("SELECT * FROM mp_invites WHERE id=? AND to_user=? AND status='pending'", (inv_id,uid)).fetchone()
        if not inv: return jsonify({"ok":False,"error":"invite_not_found"}),404
        cx.execute("UPDATE mp_invites SET status='accepted' WHERE id=?", (inv_id,))
    # Start match in current world of inviter (both should be there to see each other)
    inviter = int(inv["from_user"])
    world = _user_world(inviter)
    start=_make_start(inv["mode"] or "v1", inviter, int(inv["to_user"]), world)
    _STARTS[int(inv["from_user"])]=start
    _STARTS[int(inv["to_user"])]=start
    _DUELS[start["matchId"]] = _new_room(start["mode"], inviter, int(inv["to_user"]), world)
    return jsonify({"ok":True,"start":start})

@mp_bp.post("/lobby/decline")
def mp_lobby_decline():
    _ensure_schema()
    who=_current_user_ids()
    if not who: return jsonify({"error":"not_authenticated"}), 401
    uid,_,_=who
    data=(request.get_json(silent=True) or {})
    inv_id=int(data.get("inviteId") or 0)
    if not inv_id: return jsonify({"ok":False,"error":"bad_invite"}),400
    with conn() as cx:
        inv=cx.execute("SELECT * FROM mp_invites WHERE id=? AND to_user=? AND status='pending'", (inv_id,uid)).fetchone()
        if not inv: return jsonify({"ok":False,"error":"invite_not_found"}),404
        cx.execute("UPDATE mp_invites SET status='declined' WHERE id=?", (inv_id,))
    return jsonify({"ok":True})

@mp_bp.get("/notifications")
def mp_notifications():
    _ensure_schema()
    who=_current_user_ids()
    if not who: return jsonify({"error":"not_authenticated"}), 401
    uid,_,_=who
    _mark_active(uid)
    if uid not in _WORLD_OF: _set_world(uid, "1")
    start=_STARTS.pop(uid, None)
    with conn() as cx:
        rows=cx.execute("""
            SELECT i.id, u.pi_username AS from_username, i.mode
            FROM mp_invites i
            JOIN users u ON u.id = i.from_user
            WHERE i.to_user=? AND i.status='pending'
            ORDER BY i.created_at DESC LIMIT 5
        """,(uid,)).fetchall()
        fr_rows=cx.execute("""
            SELECT fr.id, u.pi_username AS from_username
            FROM mp_friend_requests fr
            JOIN users u ON u.id = fr.from_user
            WHERE fr.to_user=? AND fr.status='pending'
            ORDER BY fr.created_at DESC LIMIT 10
        """,(uid,)).fetchall()
    invites=[{"id":r["id"],"from":r["from_username"],"mode":r["mode"] or "v1"} for r in rows]
    friend_requests=[{"id":r["id"],"from":r["from_username"]} for r in fr_rows]
    return jsonify({"invites":invites, "friendRequests": friend_requests, "start":start, "world": _user_world(uid)})

# ---- Queue / dequeue (per world) --------------------------------------------

@mp_bp.post("/queue")
def mp_queue():
    _ensure_schema()
    who=_current_user_ids()
    if not who: return jsonify({"error":"not_authenticated"}), 401
    uid,_,_=who
    _mark_active(uid)
    if uid not in _WORLD_OF: _set_world(uid, "1")
    world = _user_world(uid)
    data=(request.get_json(silent=True) or {})
    mode=(data.get("mode") or "v1").lower()
    if mode=="v1":
        q = _QUEUES["v1"][world]
        if uid not in q: q.append(uid)
        _try_match_v1(world)
        start=_STARTS.pop(uid, None)
        if start:
            # ensure room created for this start (safety if caller jumped the gun)
            _DUELS[start["matchId"]] = _new_room(start["mode"], start["players"][0]["id"], start["players"][1]["id"], world)
            return jsonify({"ok":True,"start":start})
        return jsonify({"ok":True,"queued":True,"world":world})
    return jsonify({"ok":True,"queued":True,"world":world})

@mp_bp.post("/dequeue")
def mp_dequeue():
    who=_current_user_ids()
    if not who: return jsonify({"error":"not_authenticated"}), 401
    uid,_,_=who
    for w in _WORLDS:
        for m in _QUEUES:
            q = _QUEUES[m][w]
            if uid in q: q.remove(uid)
    return jsonify({"ok":True})

# ---- Duel state --------------------------------------------------------------

# Room layout:
# {
#   "mode":"v1", "world":"1",
#   "players":[a,b],
#   "snapshots": {uid:{username,appearance}},
#   "state": {uid:{x,y,facing,hp,inv,t}},
#   "cops":  {uid:[{x,y,kind,facing}, ...]},
#   "round": {"number":1,"bestOf":3,"wins":{a:0,b:0},"ended":False,"matchOver":False,"countdownAt":epoch(+5s)},
#   "events": {"traces":[...]}
#   "pullSince": {uid:last_ts_sent}
# }

_DUELS: Dict[str, Dict[str, Any]] = {}

def _new_room(mode:str, a:int, b:int, world:str) -> Dict[str, Any]:
    now=time.time()
    return {
        "mode": mode,
        "world": _coerce_world(world),
        "players": [int(a),int(b)],
        "snapshots": {},
        "state": {},
        "cops": {int(a):[], int(b):[]},
        "round": {"number":1, "bestOf":3, "wins":{int(a):0,int(b):0},
                  "ended":False, "matchOver":False, "countdownAt": now+5.0},
        "events": {"traces":[]},
        "pullSince": {int(a):0.0,int(b):0.0}
    }

def _get_room(mid:str):
    return _DUELS.get(str(mid))

def _other(room:Dict[str,Any], uid:int)->int:
    a,b=room["players"]; return a if uid==b else b

def _equipped_from_inv(inv:Dict[str,Any])->str:
    try:
        if inv.get("uzi",{}).get("equipped"): return "uzi"
        if inv.get("pistol",{}).get("equipped"): return "pistol"
        if inv.get("grenade",{}).get("equipped"): return "grenade"
        if inv.get("bat",{}).get("equipped"): return "bat"
        if inv.get("knuckles",{}).get("equipped"): return "knuckles"
        return "hand"
    except Exception:
        return "hand"

# ---- Duel endpoints ----------------------------------------------------------

@mp_bp.post("/duel/poke")
def mp_duel_poke():
    who=_current_user_ids()
    if not who: return jsonify({"error":"not_authenticated"}), 401
    uid,_,uname=who
    data=(request.get_json(silent=True) or {})
    mid=str(data.get("matchId") or "")
    room=_get_room(mid)
    if not room or uid not in room.get("players",[]): return jsonify({"ok":False,"error":"no_room"}),404

    # world gate: both players must be in the room's world
    if _user_world(uid) != room.get("world"):
        return jsonify({"ok":False,"error":"wrong_world","world":room.get("world")}), 409

    # live state
    st = room["state"].get(uid, {})
    x = float(data.get("x") or 0.0)
    y = float(data.get("y") or 0.0)
    hp = float(data.get("hp") or 3.0)
    st.update({
        "x": x, "y": y,
        "facing": (data.get("facing") or "down"),
        "hp": hp,
        "inv": data.get("inv") or {},
        "t": time.time()
    })
    room["state"][uid]=st

    # one-time snapshot
    snap = room["snapshots"].get(uid, {})
    snap.setdefault("username", uname)
    if data.get("appearance"):
        snap["appearance"] = data["appearance"]
    room["snapshots"][uid]=snap

    # mirror nearby cops (visual only; short list)
    cops = data.get("cops")
    if isinstance(cops, list):
        room["cops"][uid] = [
            {"x":int(c.get("x",0)), "y":int(c.get("y",0)),
             "kind": (c.get("kind") or "police"), "facing": (c.get("facing") or "down")}
            for c in cops[:6]
        ]

    return jsonify({"ok":True})

@mp_bp.get("/duel/pull")
def mp_duel_pull():
    who=_current_user_ids()
    if not who: return jsonify({"error":"not_authenticated"}), 401
    uid,_,_=who
    mid=request.args.get("matchId","")
    room=_get_room(mid)
    if not room or uid not in room.get("players",[]): return jsonify({"ok":False,"error":"no_room"}),404

    if _user_world(uid) != room.get("world"):
        return jsonify({"ok":False,"error":"wrong_world","world":room.get("world")}), 409

    opp  = _other(room, uid)
    me_state = room["state"].get(uid) or {}
    op_state = room["state"].get(opp) or {}
    op_snap  = room["snapshots"].get(opp, {})
    op_inv   = op_state.get("inv") or {}
    op_weapon= _equipped_from_inv(op_inv)

    # tracer events since last pull for THIS uid (do not resend)
    since = room["pullSince"].get(uid, 0.0)
    all_traces = room["events"]["traces"]
    new_traces = [e for e in all_traces if e.get("t",0)>since and e.get("from")!=uid]
    room["pullSince"][uid] = time.time()

    # round state
    rnd = room["round"].copy()

    payload = {
        "ok": True,
        "world": room.get("world"),
        "serverNow": time.time(),                 # NEW: for client-side lerp sync
        "opponent": None,
        "me": {
            "hp": float(me_state.get("hp", 3.0)),
            "lastUpdate": float(me_state.get("t", 0.0))  # NEW
        },
        "round": rnd,
        "opponentCops": room["cops"].get(opp, []),
        "traces": new_traces
    }

    if op_state:
        payload["opponent"] = {
            "username": op_snap.get("username") or _username_by_id(opp) or "Opponent",
            "appearance": op_snap.get("appearance") or {},
            "x": float(op_state.get("x",0.0)),
            "y": float(op_state.get("y",0.0)),
            "facing": op_state.get("facing","down"),
            "hp": float(op_state.get("hp", 3.0)),
            "inv": op_inv,
            "equipped": op_weapon,
            "lastUpdate": float(op_state.get("t",0.0))   # NEW
        }

    return jsonify(payload)

@mp_bp.post("/duel/hit")
def mp_duel_hit():
    who=_current_user_ids()
    if not who: return jsonify({"error":"not_authenticated"}), 401
    uid,_,_=who
    data=(request.get_json(silent=True) or {})
    mid=str(data.get("matchId") or "")
    kind=(data.get("kind") or "bullet").lower()
    room=_get_room(mid)
    if not room or uid not in room.get("players",[]): return jsonify({"ok":False,"error":"no_room"}),404
    if _user_world(uid) != room.get("world"):
        return jsonify({"ok":False,"error":"wrong_world","world":room.get("world")}), 409

    opp = _other(room, uid)
    os  = room["state"].get(opp) or {"hp":3.0}

    # damage in quarter segments
    def delta_quarters(k:str)->int:
        if k in ("pistol","uzi","bullet"): return 1     # 1/4 heart
        if k=="grenade": return 4                       # 1 heart
        if k in ("bat","knucks","knuckles"): return 2   # 1/2 heart
        if k in ("hand","melee"): return 1              # 1/4 heart
        return 1

    qhp = os.get("_qhp")
    if qhp is None:
        base = os.get("hp", 3.0)
        qhp  = int(round(float(base)*4))

    qhp = max(0, qhp - delta_quarters(kind))
    os["_qhp"] = qhp
    os["hp"]   = float(qhp/4.0)
    room["state"][opp] = os

    ended_now = False
    if qhp <= 0:
        ended_now = True
        _on_round_end(room, winner_uid=uid)

    return jsonify({"ok":True, "opponentHp": os["hp"], "roundEnded": ended_now, "round": room["round"]})

@mp_bp.post("/duel/trace")
def mp_duel_trace():
    """Append a short-lived tracer event so the opponent can render bullet lines."""
    who=_current_user_ids()
    if not who: return jsonify({"error":"not_authenticated"}), 401
    uid,_,_=who
    data=(request.get_json(silent=True) or {})
    mid=str(data.get("matchId") or "")
    room=_get_room(mid)
    if not room or uid not in room.get("players",[]): return jsonify({"ok":False,"error":"no_room"}),404
    if _user_world(uid) != room.get("world"):
        return jsonify({"ok":False,"error":"wrong_world","world":room.get("world")}), 409

    e = {
        "from": uid,
        "kind": (data.get("kind") or "pistol"),
        "x1": float(data.get("x1") or 0.0),
        "y1": float(data.get("y1") or 0.0),
        "x2": float(data.get("x2") or 0.0),
        "y2": float(data.get("y2") or 0.0),
        "t": time.time()
    }
    buf = room["events"]["traces"]
    buf.append(e)
    if len(buf) > 120:
        room["events"]["traces"] = buf[-120:]
    return jsonify({"ok":True})

@mp_bp.post("/duel/selfdown")
def mp_duel_selfdown():
    """Caller reports they were eliminated by world hazards during PvP; award the round to the opponent."""
    who=_current_user_ids()
    if not who: return jsonify({"error":"not_authenticated"}), 401
    uid,_,_=who
    data=(request.get_json(silent=True) or {})
    mid=str(data.get("matchId") or "")
    room=_get_room(mid)
    if not room or uid not in room.get("players",[]): return jsonify({"ok":False,"error":"no_room"}),404
    if _user_world(uid) != room.get("world"):
        return jsonify({"ok":False,"error":"wrong_world","world":room.get("world")}), 409

    opp = _other(room, uid)
    _on_round_end(room, winner_uid=opp)
    return jsonify({"ok":True, "round": room["round"]})

# ---- round helpers -----------------------------------------------------------

def _on_round_end(room:Dict[str,Any], winner_uid:int):
    rnd = room["round"]
    if rnd.get("ended") or rnd.get("matchOver"):
        return

    rnd["ended"] = True
    wins = rnd["wins"]
    wins[winner_uid] = int(wins.get(winner_uid,0)) + 1

    a,b = room["players"]
    a_w, b_w = int(wins.get(a,0)), int(wins.get(b,0))
    best = int(rnd.get("bestOf",3))
    need = best//2 + 1

    # decide match
    if a_w >= need or b_w >= need:
        rnd["matchOver"] = True
        _apply_match_result(mode=room.get("mode","v1"), a=a, b=b, a_w=a_w, b_w=b_w)
        # schedule cleanup
        room["_expireAt"] = time.time() + 15.0
        return

    # schedule next round (+5s settle)
    rnd["number"] = int(rnd.get("number",1)) + 1
    rnd["ended"] = False
    rnd["countdownAt"] = time.time() + 5.0  # both clients can wait for this

    # reset server-side hp backing; clients reset hearts visually
    for uid in (a,b):
        st = room["state"].get(uid) or {}
        st["_qhp"] = int(round(float(st.get("hp", 3.0))*4))
        room["state"][uid] = st

def _apply_match_result(mode:str, a:int, b:int, a_w:int, b_w:int):
    """Update simple W/L for v1 on mp_ranks."""
    try:
        with conn() as cx:
            cx.execute("INSERT OR IGNORE INTO mp_ranks(user_id) VALUES(?)", (a,))
            cx.execute("INSERT OR IGNORE INTO mp_ranks(user_id) VALUES(?)", (b,))
            if mode=="v1":
                if a_w > b_w:
                    cx.execute("UPDATE mp_ranks SET v1_w = COALESCE(v1_w,0)+1 WHERE user_id=?", (a,))
                    cx.execute("UPDATE mp_ranks SET v1_l = COALESCE(v1_l,0)+1 WHERE user_id=?", (b,))
                else:
                    cx.execute("UPDATE mp_ranks SET v1_w = COALESCE(v1_w,0)+1 WHERE user_id=?", (b,))
                    cx.execute("UPDATE mp_ranks SET v1_l = COALESCE(v1_l,0)+1 WHERE user_id=?", (a,))
    except Exception:
        pass

# ---- background sweeper (lazy, on each request) -----------------------------

@mp_bp.before_app_request
def _sweep_duel_rooms():
    now = time.time()
    trash = []
    for mid, room in list(_DUELS.items()):
        # drop old traces
        traces = room["events"]["traces"]
        if traces:
            room["events"]["traces"] = [e for e in traces if (now - e.get("t",now)) < 12.0]
        # expire room if flagged
        exp = room.get("_expireAt")
        if exp and now >= exp:
            trash.append(mid)
    for mid in trash:
        _DUELS.pop(mid, None)
