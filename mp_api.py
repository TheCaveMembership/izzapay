# mp_api.py  — safe fallback if WS stack isn't available
import os
from flask import Blueprint, jsonify, request
from db import conn

mp_bp = Blueprint("mp", __name__, url_prefix="/api/mp")

# ---------- simple REST (always available) ----------
@mp_bp.get("/me")
def mp_me():
    # Return minimal identity; expand as you like
    return jsonify({"username": request.headers.get("X-User", "player"), "inviteLink": "/izza-game/auth"})

@mp_bp.get("/friends/list")
def mp_friends_list():
    # Demo data; replace with DB queries
    return jsonify({"friends": []})

@mp_bp.get("/friends/search")
def mp_friends_search():
    q = (request.args.get("q") or "").strip()
    return jsonify({"users": [] if len(q) < 2 else [{"username": q, "active": False, "friend": False}]})

@mp_bp.post("/friends/request")
def mp_friends_request():
    return jsonify({"ok": True})

@mp_bp.post("/friends/accept")
def mp_friends_accept():
    return jsonify({"ok": True})

@mp_bp.post("/lobby/invite")
def mp_lobby_invite():
    # Pretend invite went out; return reason codes if you want
    return jsonify({"ok": True})

@mp_bp.post("/lobby/notify")
def mp_lobby_notify():
    return jsonify({"ok": True})

@mp_bp.get("/notifications")
def mp_notifications():
    return jsonify({"invites": [], "requests": []})

@mp_bp.post("/lobby/accept")
def mp_lobby_accept():
    return jsonify({"ok": True})

@mp_bp.post("/queue")
def mp_queue():
    return jsonify({"ok": True})

@mp_bp.post("/dequeue")
def mp_dequeue():
    return jsonify({"ok": True})

@mp_bp.get("/ranks")
def mp_ranks():
    return jsonify({"ranks": {"br10": {"w": 0, "l": 0}, "v1": {"w": 0, "l": 0}, "v2": {"w": 0, "l": 0}, "v3": {"w": 0, "l": 0}}})

# ---------- optional Sock/WS ----------
sock = None

def _want_ws():
    # enable unless disabled explicitly OR worker is clearly incompatible
    if os.getenv("MP_DISABLE_WS", "").lower() in ("1", "true", "yes"):
        return False
    return True

def mp_boot(app):
    """
    Always safe to call. If eventlet/gevent + flask-sock are available and
    MP_DISABLE_WS is not set, it attaches /api/mp/ws. Otherwise it logs and skips.
    """
    app.logger.info("[mp] boot start")
    # ensure tables if you have any (no-ops here)
    # with conn() as cx: cx.executescript("/* your schema here */")

    if not _want_ws():
        app.logger.warning("[mp] WS disabled via MP_DISABLE_WS; REST only.")
        return

    try:
        from flask_sock import Sock
        global sock
        sock = Sock(app)

        @sock.route("/api/mp/ws")
        def mp_ws(ws):
            # Simple echo/ping channel; expand to your real events
            try:
                while True:
                    msg = ws.receive(timeout=30)  # simple-websocket respects eventlet/gevent
                    if msg is None:
                        break
                    ws.send(msg if isinstance(msg, str) else "ok")
            except Exception:
                pass

        app.logger.info("[mp] WS enabled at /api/mp/ws")
    except Exception as e:
        app.logger.warning(f"[mp] WS not enabled ({e!r}); REST endpoints available.")
