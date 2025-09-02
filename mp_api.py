# mp_api.py
# Flask Blueprint + WebSocket for IZZA Multiplayer
# - SQLite on Render disk (separate file from your main DB)
# - Search only returns Pi-authed players who have "played"
# - Friends: request/accept
# - Lobby invites with 30min TTL + notifications
# - Presence via WS; basic matchmaking for v1 (1v1)
#
# Requires: flask, flask_sock
# Add to game_app:   from mp_api import mp_bp, sock, mp_boot
#                    app.register_blueprint(mp_bp, url_prefix="/api/mp")
#                    mp_boot(app)   # make sure DB exists
#
# In auth exchange handler (on successful Pi auth) call:
#   ensure_player(username, played=True)
#
# NOTE: compact but production-safe for your needs.

import os, sqlite3, time, json, secrets
from flask import Blueprint, request, session, jsonify
from flask_sock import Sock
from threading import Lock

# -------- DB PATH (Render disk) --------
# Separate file from your main app DB. Overridable via env.
DB_PATH = os.environ.get("MP_DB_PATH") or os.path.join(
    os.environ.get("DATA_DIR", "/var/data"),
    "izza_mp.sqlite3"
)

mp_bp = Blueprint("mp", __name__)
sock  = Sock()  # attach in mp_boot()

_db_lock = Lock()

# -------- DB helpers --------
def db():
    # autocreate directory
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    con = sqlite3.connect(DB_PATH, check_same_thread=False)
    con.row_factory = sqlite3.Row
    return con

def qx(sql, args=()):
    with _db_lock:
        con=db()
        try:
            cur = con.execute(sql, args)
            con.commit()
            return cur
        finally:
            con.close()

def ensure_schema():
    qx("""
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS mp_players(
      username   TEXT PRIMARY KEY,
      has_played INTEGER DEFAULT 0,
      last_seen  INTEGER
    );
    CREATE TABLE IF NOT EXISTS mp_friends(
      user_a TEXT,
      user_b TEXT,
      status TEXT CHECK(status IN('pending','accepted')),
      created_at INTEGER,
      PRIMARY KEY(user_a,user_b)
    );
    CREATE TABLE IF NOT EXISTS mp_invites(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_user TEXT,
      to_user   TEXT,
      mode      TEXT,
      lobby_id  TEXT,
      sent_at   INTEGER,
      expires_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS mp_queue(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT,
      mode     TEXT,
      queued_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS mp_ranks(
      username TEXT,
      mode     TEXT,
      wins INTEGER DEFAULT 0,
      losses INTEGER DEFAULT 0,
      PRIMARY KEY(username,mode)
    );
    """)
    return True

def ensure_player(username, played=False):
    now=int(time.time())
    qx("INSERT OR IGNORE INTO mp_players(username,has_played,last_seen) VALUES (?,?,?)",
       (username, 1 if played else 0, now))
    if played:
        qx("UPDATE mp_players SET has_played=1,last_seen=? WHERE username=?",(now,username))
    return True

# expose for your auth handler if you want to mark "played"
def mp_boot(app):
    ensure_schema()
    sock.init_app(app)

# -------- auth/session helper --------
def cur_user():
    # Your main app sets session["pi_username"] in /auth/exchange
    u = session.get("pi_username")
    if not u: 
        return None
    # mark presence heartbeat
    try:
        ensure_player(u, played=True)
    except Exception:
        pass
    return u

def require_user():
    u = cur_user()
    if not u: 
        return None, (jsonify({"error":"unauthorized"}), 401)
    return u, None

# -------- in-memory presence + sockets --------
CLIENTS = {}  # username -> websocket
CLIENTS_LOCK = Lock()

def ws_send(user, msg):
    with CLIENTS_LOCK:
        ws = CLIENTS.get(user)
    if not ws: return False
    try:
        ws.send(json.dumps(msg))
        return True
    except Exception:
        return False

def broadcast(msg):
    dead=[]
    with CLIENTS_LOCK:
        for u,ws in CLIENTS.items():
            try: ws.send(json.dumps(msg))
            except: dead.append(u)
        for u in dead:
            CLIENTS.pop(u, None)

def user_active(user):
    # active if WS connected or last_seen within last 120s
    with CLIENTS_LOCK:
        if user in CLIENTS: 
            return True
    row = qx("SELECT last_seen FROM mp_players WHERE username=?",(user,)).fetchone()
    if not row: return False
    return (int(time.time()) - int(row["last_seen"] or 0)) <= 120

def mark_seen(user):
    qx("UPDATE mp_players SET last_seen=? WHERE username=?", (int(time.time()), user))

# -------- helpers --------
def ranks_for(user):
    rows = qx("SELECT mode,wins,losses FROM mp_ranks WHERE username=?", (user,)).fetchall()
    r = { "br10": {"w":0,"l":0}, "v1":{"w":0,"l":0}, "v2":{"w":0,"l":0}, "v3":{"w":0,"l":0} }
    for row in rows:
        r[row["mode"]] = {"w":row["wins"], "l":row["losses"]}
    return r

def pretty_players(users):
    return [{"username":u,"active":user_active(u)} for u in users]

# =========================================================
#                          REST
# =========================================================

@mp_bp.get("/me")
def me():
    u,err = require_user()
    if err: return err
    # Provide a default invite link that points to game_app's /auth
    invite = f"/izza-game/auth?src=invite&from={u}"
    return jsonify({"username":u, "ranks": ranks_for(u), "inviteLink": invite})

@mp_bp.get("/friends/list")
def friends_list():
    u,err = require_user()
    if err: return err
    rows = qx("""
      SELECT CASE WHEN user_a=? THEN user_b ELSE user_a END AS friend
      FROM mp_friends
      WHERE (user_a=? OR user_b=?) AND status='accepted'
      ORDER BY friend
    """,(u,u,u)).fetchall()
    friends = [{"username":r["friend"], "active": user_active(r["friend"])} for r in rows]
    return jsonify({"friends": friends})

@mp_bp.get("/friends/search")
def friends_search():
    u,err = require_user()
    if err: return err
    q = (request.args.get("q") or "").strip().lower()
    if len(q) < 2:
        return jsonify({"users":[]})
    rows = qx("""
      SELECT username FROM mp_players
      WHERE has_played=1 AND LOWER(username) LIKE ?
      ORDER BY last_seen DESC LIMIT 25
    """,(f"%{q}%",)).fetchall()
    out=[]
    for r in rows:
        name=r["username"]
        fr = qx("""SELECT 1 FROM mp_friends 
                   WHERE ((user_a=? AND user_b=?) OR (user_a=? AND user_b=?)) AND status='accepted'""",
                   (u,name,name,u)).fetchone()
        out.append({"username":name, "active":user_active(name), "friend": bool(fr)})
    return jsonify({"users": out})

@mp_bp.post("/friends/request")
def friends_request():
    u,err = require_user()
    if err: return err
    target = (request.json or {}).get("username","").strip()
    if not target or target==u:
        return jsonify({"ok":False, "error":"bad_target"}), 400
    # dedupe ordering
    a,b = sorted([u, target])
    existing = qx("SELECT status FROM mp_friends WHERE user_a=? AND user_b=?", (a,b)).fetchone()
    now=int(time.time())
    if existing:
        # upgrade if opposite already asked
        if existing["status"]=="pending":
            qx("UPDATE mp_friends SET status='accepted', created_at=? WHERE user_a=? AND user_b=?", (now,a,b))
            return jsonify({"ok":True, "accepted":True})
        return jsonify({"ok":True})
    qx("INSERT INTO mp_friends(user_a,user_b,status,created_at) VALUES (?,?,?,?)", (a,b,"pending",now))
    # notify receiver
    ws_send(target, {"type":"notify.request","from":u,"sentAt": now})
    return jsonify({"ok":True})

@mp_bp.post("/friends/accept")
def friends_accept():
    u,err = require_user()
    if err: return err
    other = (request.json or {}).get("username","").strip()
    if not other: return jsonify({"ok":False}), 400
    a,b = sorted([u, other])
    now=int(time.time())
    qx("UPDATE mp_friends SET status='accepted', created_at=? WHERE user_a=? AND user_b=?", (now,a,b))
    return jsonify({"ok":True})

@mp_bp.get("/notifications")
def notifications():
    u,err = require_user()
    if err: return err
    now=int(time.time())
    # pending friend requests
    reqs=[]
    rows = qx("""
      SELECT user_a,user_b,status,created_at FROM mp_friends
      WHERE status='pending' AND (user_a=? OR user_b=?)
    """,(u,u)).fetchall()
    for r in rows:
        a=r["user_a"]; b=r["user_b"]
        other = b if a==u else a
        reqs.append({"from": other, "sentAt": r["created_at"]})

    # valid lobby invites
    invs=[]
    rows = qx("""SELECT from_user,mode,lobby_id,sent_at,expires_at
                 FROM mp_invites WHERE to_user=? AND expires_at>=? 
                 ORDER BY sent_at DESC""",(u, now)).fetchall()
    for r in rows:
        invs.append({"from":r["from_user"], "mode":r["mode"], "lobbyId": r["lobby_id"], "sentAt": r["sent_at"]})
    return jsonify({"requests":reqs, "invites":invs})

# ---------- Lobby invites (30 min) ----------
@mp_bp.post("/lobby/invite")
def lobby_invite():
    u,err = require_user()
    if err: return err
    to = (request.json or {}).get("toUsername","").strip()
    mode = (request.json or {}).get("mode","v1")
    if not to or to==u: return jsonify({"ok":False, "reason":"bad_target"}), 400

    # check availability
    if not user_active(to):
        return jsonify({"ok":False, "reason":"offline"})
    if user_in_game(to):
        return jsonify({"ok":False, "reason":"in_game"})

    now=int(time.time())
    ttl = now + 30*60
    lobby_id = secrets.token_hex(8)
    qx("INSERT INTO mp_invites(from_user,to_user,mode,lobby_id,sent_at,expires_at) VALUES (?,?,?,?,?,?)",
       (u,to,mode,lobby_id, now, ttl))
    ws_send(to, {"type":"notify.invite","from":u,"mode":mode,"lobbyId":lobby_id,"sentAt":now})
    return jsonify({"ok":True})

@mp_bp.post("/lobby/notify")
def lobby_notify():
    u,err = require_user()
    if err: return err
    to = (request.json or {}).get("toUsername","").strip()
    ttlSec = int((request.json or {}).get("ttlSec", 1800))
    if not to: return jsonify({"ok":False}), 400
    now=int(time.time())
    lobby_id = secrets.token_hex(8)
    qx("INSERT INTO mp_invites(from_user,to_user,mode,lobby_id,sent_at,expires_at) VALUES (?,?,?,?,?,?)",
       (u,to,"v1", lobby_id, now, now+ttlSec))
    ws_send(to, {"type":"notify.invite","from":u,"mode":"v1","lobbyId":lobby_id,"sentAt":now})
    return jsonify({"ok":True})

@mp_bp.post("/lobby/accept")
def lobby_accept():
    u,err = require_user()
    if err: return err
    data = request.json or {}
    frm = data.get("from")
    if not frm: return jsonify({"ok":False}), 400
    qx("DELETE FROM mp_invites WHERE to_user=? AND from_user=?", (u,frm))
    # Put both into queue 'v1' immediately; matchmaker will pop them
    now=int(time.time())
    qx("INSERT INTO mp_queue(username,mode,queued_at) VALUES (?,?,?)", (u,"v1",now))
    qx("INSERT INTO mp_queue(username,mode,queued_at) VALUES (?,?,?)", (frm,"v1",now))
    try_match("v1")
    return jsonify({"ok":True})

# ---------- Queue / Dequeue / Ranks ----------
@mp_bp.post("/queue")
def queue():
    u,err = require_user()
    if err: return err
    mode = (request.json or {}).get("mode","v1")
    now=int(time.time())
    qx("DELETE FROM mp_queue WHERE username=?", (u,))
    qx("INSERT INTO mp_queue(username,mode,queued_at) VALUES (?,?,?)", (u,mode,now))
    try_match(mode)
    return jsonify({"ok":True})

@mp_bp.post("/dequeue")
def dequeue():
    u,err = require_user()
    if err: return err
    qx("DELETE FROM mp_queue WHERE username=?", (u,))
    return jsonify({"ok":True})

@mp_bp.get("/ranks")
def ranks():
    u,err = require_user()
    if err: return err
    return jsonify({"ranks": ranks_for(u)})

# =========================================================
#                       MATCHMAKER
# =========================================================

IN_GAME = set()  # usernames currently in a match
IG_LOCK = Lock()

def user_in_game(u):
    with IG_LOCK:
        return u in IN_GAME

def set_in_game(users, on):
    with IG_LOCK:
        for u in users:
            if on: IN_GAME.add(u)
            else:  IN_GAME.discard(u)

def try_match(mode):
    # pop two from queue (FIFO)
    with _db_lock:
        con=db()
        try:
            rows = con.execute("SELECT id,username FROM mp_queue WHERE mode=? ORDER BY queued_at ASC LIMIT 2", (mode,)).fetchall()
            if len(rows) < 2:
                con.close(); return False
            ids  = [rows[0]["id"], rows[1]["id"]]
            users= [rows[0]["username"], rows[1]["username"]]
            con.execute("DELETE FROM mp_queue WHERE id IN (?,?)", (ids[0],ids[1]))
            con.commit()
        finally:
            con.close()

    # mark in-game and notify both
    set_in_game(users, True)
    match_id = secrets.token_hex(12)
    payload = {"type":"match.found","mode":mode,"matchId":match_id,
               "players":[{"username":users[0]}, {"username":users[1]}]}
    for u in users:
        ws_send(u, payload)
    return True

# =========================================================
#                        WEBSOCKETS
# =========================================================

@sock.route("/api/mp/ws")
def ws_main(ws):
    # authenticate by session cookie; Sock keeps Flask context (game_app shares cookie config)
    u = cur_user()
    if not u:
        ws.close()
        return
    # register client
    with CLIENTS_LOCK:
        CLIENTS[u] = ws
    broadcast({"type":"presence","user":u,"active":True})
    mark_seen(u)

    try:
        while True:
            msg = ws.receive()
            if msg is None:
                break
            # Optional: accept pings / update seen
            mark_seen(u)
            # Could parse client messages here if needed
    except Exception:
        pass
    finally:
        with CLIENTS_LOCK:
            CLIENTS.pop(u, None)
        set_in_game([u], False)  # clear any stale in-game flag on disconnect
        broadcast({"type":"presence","user":u,"active":False})
