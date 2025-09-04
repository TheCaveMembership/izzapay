# mp_api.py — v2.7
# - /duel/poke, /duel/pull, /duel/hit with rounds (Bo3), cops mirror, appearance snapshot
# - Updates mp_ranks (v1_w / v1_l) on match end
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

_PRESENCE: Dict[int, float] = {}
_PRESENCE_TTL = 1800.0
def _mark_active(uid:int): _PRESENCE[int(uid)] = time.time()
def _is_active(uid:int)->bool:
    t=_PRESENCE.get(int(uid)); return bool(t and (time.time()-t) < _PRESENCE_TTL)

_QUEUES: Dict[str, List[int]] = {"v1": []}
_STARTS: Dict[int, Dict[str, Any]] = {}

# _DUELS structure
# matchId -> {
#   "mode":"v1",
#   "players":[uidA,uidB],
#   "snapshots":{uid:{username,appearance}},
#   "state":{uid:{x,y,facing,hp,inv,t,cops}},
#   "qhp":{uid:int_quarters},   # server tracks quarters 0..(4*max?), default 16 (4 hearts)
#   "score":{uidA:int, uidB:int},
#   "round":{"number":1, "active":True, "last_end_ts":0.0, "last_winner":None, "last_number":0},
#   "over":False, "winner":None
# }
_DUELS: Dict[str, Dict[str, Any]] = {}

def _username_by_id(uid: int) -> Optional[str]:
    with conn() as cx:
        r = cx.execute("SELECT pi_username FROM users WHERE id=?", (uid,)).fetchone()
        return r["pi_username"] if r else None

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

def _make_start(mode: str, a: int, b: int) -> Dict[str, Any]:
    mid = str(int(time.time() * 1000))
    _DUELS[mid] = {
        "mode": mode, "players":[a,b],
        "snapshots":{}, "state":{},
        "qhp":{a:16, b:16},     # 4 hearts x4 quarters
        "score":{a:0, b:0},
        "round":{"number":1, "active":True, "last_end_ts":0.0, "last_winner":None, "last_number":0},
        "over":False, "winner":None
    }
    return {
        "mode": mode,
        "matchId": mid,
        "players": [
            {"id": a, "username": _username_by_id(a)},
            {"id": b, "username": _username_by_id(b)},
        ]
    }

def _try_match_v1():
    q=_QUEUES["v1"]
    if len(q)>=2:
        a=q.pop(0); b=q.pop(0)
        start=_make_start("v1", a, b)
        _STARTS[a]=start; _STARTS[b]=start

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

# -------- basic endpoints (trimmed to ones we use)
@mp_bp.get("/me")
def mp_me():
    _ensure_schema()
    who=_current_user_ids()
    if not who: return jsonify({"error":"not_authenticated"}), 401
    uid,_,name=who; _mark_active(uid)
    return jsonify({"username":name,"active":True,"inviteLink":"/izza-game/auth"})

@mp_bp.post("/queue")
def mp_queue():
    _ensure_schema()
    who=_current_user_ids()
    if not who: return jsonify({"error":"not_authenticated"}), 401
    uid,_,_=who
    _mark_active(uid)
    data=(request.get_json(silent=True) or {})
    mode=(data.get("mode") or "v1").lower()
    if mode=="v1":
        if uid not in _QUEUES["v1"]:
            _QUEUES["v1"].append(uid)
        _try_match_v1()
        start=_STARTS.pop(uid, None)
        if start:
            return jsonify({"ok":True,"start":start})
        return jsonify({"ok":True,"queued":True})
    return jsonify({"ok":True,"queued":True})

@mp_bp.post("/dequeue")
def mp_dequeue():
    who=_current_user_ids()
    if not who: return jsonify({"error":"not_authenticated"}), 401
    uid,_,_=who
    for m in _QUEUES:
        if uid in _QUEUES[m]: _QUEUES[m].remove(uid)
    return jsonify({"ok":True})

# -------- Duel helpers
def _get_room(mid:str): return _DUELS.get(str(mid))

def _opponent(room:Dict[str,Any], uid:int)->int:
    a,b=room["players"]; return a if uid==b else b

def _end_round(room:Dict[str,Any], winner_uid:int):
    # update score
    for uid in room["players"]:
        if uid==winner_uid: room["score"][uid] += 1
    # mark round end
    r=room["round"]
    r["active"]=False
    r["last_end_ts"]=time.time()
    r["last_winner"]=winner_uid
    r["last_number"]=r.get("number",1)
    # best of 3 -> first to 2
    if room["score"][winner_uid] >= 2:
        room["over"]=True; room["winner"]=winner_uid
        return
    # else schedule next round: bump number, reactivate, reset HP quarters
    r["number"] = int(r.get("number",1)) + 1
    r["active"]=True
    # reset qhp (4 hearts => 16 quarters)
    for uid in room["players"]:
        room["qhp"][uid] = 16
        st = room["state"].setdefault(uid, {})
        st["hp"] = 4

def _bump_rank(uid:int, col:str):
    with conn() as cx:
        cx.execute("INSERT OR IGNORE INTO mp_ranks(user_id) VALUES(?)",(uid,))
        cx.execute(f"UPDATE mp_ranks SET {col}={col}+1 WHERE user_id=?",(uid,))

# -------- Duel REST
@mp_bp.post("/duel/poke")
def mp_duel_poke():
    who=_current_user_ids()
    if not who: return jsonify({"error":"not_authenticated"}), 401
    uid,_,uname=who
    data=(request.get_json(silent=True) or {})
    mid=str(data.get("matchId") or "")
    room=_get_room(mid)
    if not room or uid not in room.get("players",[]): return jsonify({"ok":False,"error":"no_room"}),404

    # store state
    st = room["state"].get(uid, {})
    st.update({
        "x": float(data.get("x") or 0.0),
        "y": float(data.get("y") or 0.0),
        "facing": data.get("facing") or "down",
        "hp": float(data.get("hp") or 4.0),
        "inv": data.get("inv") or {},
        "cops": data.get("cops") or [],
        "t": time.time()
    })
    room["state"][uid]=st

    # snapshot minimal identity/appearance
    snap = room["snapshots"].get(uid, {})
    snap.setdefault("username", uname)
    if data.get("appearance"): snap["appearance"]=data["appearance"]
    room["snapshots"][uid]=snap

    return jsonify({"ok":True})

@mp_bp.get("/duel/pull")
def mp_duel_pull():
    who=_current_user_ids()
    if not who: return jsonify({"error":"not_authenticated"}), 401
    uid,_,_=who
    mid=request.args.get("matchId","")
    room=_get_room(mid)
    if not room or uid not in room.get("players",[]): return jsonify({"ok":False,"error":"no_room"}),404
    opp=_opponent(room, uid)

    os=room["state"].get(opp); ss=room["snapshots"].get(opp,{})
    my=room["state"].get(uid) or {}
    oppCops=(os or {}).get("cops") or []

    payload={
        "ok":True,
        "me":{"hp": float((room["qhp"].get(uid,16))/4.0)},
        "score":{"me": room["score"].get(uid,0), "opponent": room["score"].get(opp,0)},
        "round":{
            "number": room["round"].get("number",1),
            "active": room["round"].get("active",True),
            "matchOver": room.get("over",False),
            "winner": ("me" if room.get("winner")==uid else "opponent" if room.get("winner")==opp else None),
            "justEnded": (room["round"].get("last_number",0)>0 and room["round"].get("last_number")==room["round"].get("number")-1 and not room.get("over",False)),
            "lastWinner": ("me" if room["round"].get("last_winner")==uid else "opponent" if room["round"].get("last_winner")==opp else None),
            "lastNumber": room["round"].get("last_number",0)
        },
        "opponentCops": oppCops
    }

    if os:
        payload["opponent"]={
            "username": ss.get("username") or _username_by_id(opp) or "Opponent",
            "appearance": ss.get("appearance") or {},
            "x": os.get("x",0.0), "y": os.get("y",0.0), "facing": os.get("facing","down"),
            "hp": float((room["qhp"].get(opp,16))/4.0),
            "inv": os.get("inv",{})
        }
    else:
        payload["opponent"]=None

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
    if room.get("over"): return jsonify({"ok":True,"done":True})

    opp=_opponent(room, uid)
    # ignore hits if round not active
    if not room["round"].get("active",True):
        return jsonify({"ok":True,"inactiveRound":True})

    # damage per hit (quarters)
    if kind in ("pistol","uzi","bullet"): delta = 1         # 1/4 heart
    elif kind=="grenade":                  delta = 4         # 1 heart
    elif kind in ("bat","knucks","knuckles"): delta = 2     # 1/2 heart
    elif kind in ("hand","melee"):         delta = 1         # 1/4 heart
    else:                                  delta = 1

    qhp = room["qhp"].get(opp,16)
    qhp = max(0, qhp - int(delta))
    room["qhp"][opp]=qhp
    # mirror float hp into state for convenience
    st = room["state"].setdefault(opp, {})
    st["hp"] = float(qhp/4.0)

    # if opponent down -> end round / maybe match
    if qhp<=0:
      _end_round(room, winner_uid=uid)
      if room.get("over"):
        # update ranks
        _bump_rank(uid, 'v1_w'); _bump_rank(opp, 'v1_l')

    return jsonify({"ok":True,"opponentHp": float(st["hp"]), "round": room["round"], "score": {
        "me": room["score"].get(uid,0), "opponent": room["score"].get(opp,0)
    }})
