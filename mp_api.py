# mp_api.py — v3.0 (duel REST: poke/pull/hit • quarter-hearts • 2-hit counters • cops mirror • Bo3 rounds)
from __future__ import annotations
from typing import Optional, Tuple, Dict, Any, List
from flask import Blueprint, jsonify, request, session
from db import conn
import time

# IMPORTANT: mount under the prefix your client uses: /izza-game/api/mp
mp_bp = Blueprint("mp", __name__, url_prefix="/izza-game/api/mp")

def _import_main_verifier():
    try:
        from app import verify_login_token
        return verify_login_token
    except Exception:
        return None
VERIFY_TOKEN = _import_main_verifier()

# ---------- presence / friends / invites (unchanged-ish) ----------
_PRESENCE: Dict[int, float] = {}
_PRESENCE_TTL = 1800.0
def _mark_active(uid:int): _PRESENCE[int(uid)] = time.time()
def _is_active(uid:int)->bool:
    t=_PRESENCE.get(int(uid)); return bool(t and (time.time()-t) < _PRESENCE_TTL)

_QUEUES: Dict[str, List[int]] = {"v1": []}
_STARTS: Dict[int, Dict[str, Any]] = {}

def _username_by_id(uid: int) -> Optional[str]:
    with conn() as cx:
        r = cx.execute("SELECT pi_username FROM users WHERE id=?", (uid,)).fetchone()
        return r["pi_username"] if r else None

def _make_start(mode: str, a: int, b: int) -> Dict[str, Any]:
    return {
        "mode": mode,
        "matchId": str(int(time.time() * 1000)),
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
        _DUELS[start["matchId"]] = _new_room(start["mode"], a, b)

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

@mp_bp.get("/me")
def mp_me():
    _ensure_schema()
    who=_current_user_ids()
    if not who: return jsonify({"error":"not_authenticated"}), 401
    uid,_,name=who; _mark_active(uid)
    return jsonify({"username":name,"active":True,"inviteLink":"/izza-game/auth"})

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
    return jsonify({"friends":[{"username":r["username"],"active":_is_active(int(r["fid"])), "friend":True} for r in rows]})

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

@mp_bp.post("/lobby/invite")
def mp_lobby_invite():
    _ensure_schema()
    who=_current_user_ids()
    if not who: return jsonify({"error":"not_authenticated"}), 401
    me,_,_=who
    data=(request.get_json(silent=True) or {})
    to=(data.get("toUsername") or "").strip()
    to_id=_user_id_by_username(to)
    if not to_id: return jsonify({"ok":False,"error":"player_not_found"}),404
    if to_id==me: return jsonify({"ok":False,"error":"cannot_invite_self"}),400
    with conn() as cx:
        cx.execute("INSERT INTO mp_invites(from_user,to_user,mode,ttl_sec,status) VALUES(?,?,?,?, 'pending')",
                   (me, to_id, (data.get('mode') or 'v1'), int(data.get('ttlSec') or 1800)))
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
    start=_make_start(inv["mode"] or "v1", int(inv["from_user"]), int(inv["to_user"]))
    _STARTS[int(inv["from_user"])]=start
    _STARTS[int(inv["to_user"])]=start
    _DUELS[start["matchId"]] = _new_room(start["mode"], int(inv["from_user"]), int(inv["to_user"]))
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
    start=_STARTS.pop(uid, None)
    with conn() as cx:
        rows=cx.execute("""
            SELECT i.id, u.pi_username AS from_username, i.mode
            FROM mp_invites i
            JOIN users u ON u.id = i.from_user
            WHERE i.to_user=? AND i.status='pending'
            ORDER BY i.created_at DESC LIMIT 5
        """,(uid,)).fetchall()
    invites=[{"id":r["id"],"from":r["from_username"],"mode":r["mode"] or "v1"} for r in rows]
    return jsonify({"invites":invites, "start":start})

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
            _DUELS[start["matchId"]] = _new_room(start["mode"], start["players"][0]["id"], start["players"][1]["id"])
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

# ---------- Duel room state ----------
# matchId -> room
# room = {
#   "mode":"v1",
#   "players":[uidA,uidB],
#   "snapshots":{uid:{username,appearance}},
#   "state":{uid:{x,y,facing,hp,inv,t,cops,_qhp}},
#   "hits":{uid:{hand:int,bat:int,knuckles:int}},
#   "score":{uidA:int, uidB:int},
#   "round":1, "ended":False, "matchOver":False
# }
_DUELS: Dict[str, Dict[str, Any]] = {}

DEFAULT_FULL_HEARTS = 3.0  # full hearts at round start (your hearts plugin default)

def _new_room(mode:str, a:int, b:int)->Dict[str,Any]:
    return {
        "mode": mode,
        "players":[a,b],
        "snapshots":{},
        "state":{},
        "hits":{a:{"hand":0,"bat":0,"knuckles":0}, b:{"hand":0,"bat":0,"knuckles":0}},
        "score":{a:0,b:0},
        "round":1,
        "ended":False,
        "matchOver":False
    }

def _get_room(mid:str): return _DUELS.get(str(mid))

# ---------- Duel REST ----------

@mp_bp.post("/duel/poke")
def mp_duel_poke():
    who=_current_user_ids()
    if not who: return jsonify({"error":"not_authenticated"}), 401
    uid,_,uname=who
    data=(request.get_json(silent=True) or {})
    mid=str(data.get("matchId") or "")
    room=_get_room(mid)
    if not room or uid not in room.get("players",[]): return jsonify({"ok":False,"error":"no_room"}),404

    # store state (keep hp as float; track quarters in _qhp)
    st = room["state"].get(uid, {})
    hp_val = data.get("hp")
    if hp_val is None:
        # if no hp provided yet, assume full
        hp = float(st.get("hp", DEFAULT_FULL_HEARTS))
    else:
        hp = float(hp_val)

    st.update({
        "x": float(data.get("x") or st.get("x", 0.0)),
        "y": float(data.get("y") or st.get("y", 0.0)),
        "facing": data.get("facing") or st.get("facing", "down"),
        "hp": hp,
        "inv": data.get("inv") or st.get("inv", {}),
        "cops": data.get("cops") or st.get("cops", []),
        "t": time.time()
    })
    # initialize quarter-hp tracker if missing
    if st.get("_qhp") is None:
        st["_qhp"] = int(round(hp * 4.0))

    room["state"][uid]=st

    # snapshot (username + appearance at start)
    snap = room["snapshots"].get(uid, {})
    snap.setdefault("username", uname)
    if "appearance" in data and data["appearance"]:
        snap["appearance"]=data["appearance"]
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

    a,b=room["players"]; opp=a if uid==b else b
    ms=room["state"].get(uid) or {"hp":DEFAULT_FULL_HEARTS}
    os=room["state"].get(opp)
    ss=room["snapshots"].get(opp,{})

    # round transition (best-of-3)
    roundInfo = {"number":room["round"], "ended":room["ended"], "matchOver":room["matchOver"]}
    if room["ended"] and not room["matchOver"]:
        # decide winner by who hit 0
        me_hp  = float(ms.get("hp", DEFAULT_FULL_HEARTS))
        opp_hp = float((os or {}).get("hp", DEFAULT_FULL_HEARTS))
        winner_uid = uid if opp_hp<=0.0 and me_hp>0.0 else (opp if me_hp<=0.0 and opp_hp>0.0 else None)
        if winner_uid is not None:
            room["score"][winner_uid] += 1
        # check match over
        if room["score"][a] >= 2 or room["score"][b] >= 2:
            room["matchOver"] = True
        else:
            # next round: reset hearts to FULL for both
            for pid in (a,b):
                pst = room["state"].setdefault(pid, {})
                pst["hp"] = DEFAULT_FULL_HEARTS
                pst["_qhp"] = int(DEFAULT_FULL_HEARTS * 4)
            room["round"] += 1
            room["ended"] = False
        roundInfo = {"number":room["round"], "ended":room["ended"], "matchOver":room["matchOver"]}

    resp = {
        "ok": True,
        # Send back my own HP so each client can drive the hearts HUD.
        "me": { "hp": float(ms.get("hp", DEFAULT_FULL_HEARTS)) },
        "opponent": None,
        "opponentCops": (os or {}).get("cops", []),
        "round": roundInfo,
        "score": { 
            "me": room["score"][uid],
            "opponent": room["score"][opp]
        }
    }
    if os:
        resp["opponent"] = {
            "username": ss.get("username") or _username_by_id(opp) or "Opponent",
            "appearance": ss.get("appearance") or {},
            "x": float(os.get("x",0.0)), "y": float(os.get("y",0.0)),
            "facing": os.get("facing","down"),
            # keep float — quarter hearts allowed
            "hp": float(os.get("hp", DEFAULT_FULL_HEARTS)),
            "inv": os.get("inv",{})
        }
    return jsonify(resp)

@mp_bp.post("/duel/hit")
def mp_duel_hit():
    who=_current_user_ids()
    if not who: return jsonify({"error":"not_authenticated"}), 401
    uid,_,_=who
    data=(request.get_json(silent=True) or {})
    mid=str(data.get("matchId") or "")
    kind=(data.get("kind") or "pistol").lower()
    room=_get_room(mid)
    if not room or uid not in room.get("players",[]): return jsonify({"ok":False,"error":"no_room"}),404

    a,b=room["players"]; opp=a if uid==b else b
    os=room["state"].setdefault(opp, {"hp":DEFAULT_FULL_HEARTS, "_qhp": int(DEFAULT_FULL_HEARTS*4)})

    # ---- damage rules in QUARTERS ----
    # pistol/uz i/bullet: 1 → 1/4 heart
    # grenade:            4 → 1 full heart
    # bat/knuckles:       every 2 hits → 2 → 1/2 heart
    # hand:               every 2 hits → 1 → 1/4 heart
    delta_quarters = 0
    if kind in ("pistol","uzi","bullet"):
        delta_quarters = 1
    elif kind == "grenade":
        delta_quarters = 4
    elif kind in ("bat","knucks","knuckles"):
        h = room["hits"].setdefault(uid, {"hand":0,"bat":0,"knuckles":0})
        h["bat"] += 1
        if h["bat"] >= 2:
            delta_quarters = 2
            h["bat"] = 0
    elif kind in ("hand","melee"):
        h = room["hits"].setdefault(uid, {"hand":0,"bat":0,"knuckles":0})
        h["hand"] += 1
        if h["hand"] >= 2:
            delta_quarters = 1
            h["hand"] = 0
    elif kind in ("knucks2","bat2"):
        # optional explicit kinds from client
        delta_quarters = 2
    else:
        delta_quarters = 1

    qhp = int(os.get("_qhp", int(os.get("hp", DEFAULT_FULL_HEARTS)*4)))
    qhp = max(0, qhp - delta_quarters)
    os["_qhp"] = qhp
    os["hp"]   = float(qhp) / 4.0
    room["state"][opp] = os

    # round ended?
    if os["hp"] <= 0.0:
        room["ended"] = True

    return jsonify({"ok":True, "opponentHp": os["hp"]})
