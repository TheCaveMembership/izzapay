from flask import (
    Blueprint,
    render_template,
    session,
    redirect,
    request,
    current_app,
    jsonify,
)
from time import time
from db import conn

import os
from decimal import Decimal, InvalidOperation

from stellar_sdk import Asset

# Reuse the same helpers you use in IZZA CREATURES
from nft_api import _change_trust, _pay_asset

warzone_bp = Blueprint("warzone_bp", __name__, url_prefix="/warzone")


# ----------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------


def _require_user_id():
    """
    Session-based user_id if present and valid, else None.
    """
    uid = session.get("user_id")
    if not uid:
        return None
    try:
        return int(uid)
    except (TypeError, ValueError):
        return None


def _now_i() -> int:
    return int(time())


def _strip_at(s: str | None) -> str:
    return (s or "").strip().lstrip("@").strip()


def _resolve_uid_from_username(u_raw: str | None) -> int | None:
    """
    Resolve a user_id from a username/pi_username/pi_uid string.
    This lets purchase/equip work WITHOUT session auth, using ?u=...
    """
    u = _strip_at(u_raw)
    if not u:
        return None

    # Also try lowercase match for safety
    u_l = u.lower()

    with conn() as cx:
        row = cx.execute(
            """
            SELECT id
            FROM users
            WHERE lower(username) = ?
               OR lower(pi_username) = ?
               OR lower(pi_uid) = ?
            LIMIT 1
            """,
            (u_l, u_l, u_l),
        ).fetchone()

    if not row:
        return None
    try:
        return int(row["id"])
    except Exception:
        return None


def _get_uid_for_inventory() -> int | None:
    """
    Preferred: session user_id.
    Fallback: ?u= (or JSON body "u") to resolve user id for inventory writes.
    """
    uid = _require_user_id()
    if uid:
        return uid

    u_qs = request.args.get("u")
    if u_qs:
        return _resolve_uid_from_username(u_qs)

    data = request.get_json(silent=True) or {}
    u_body = data.get("u")
    if u_body:
        return _resolve_uid_from_username(u_body)

    return None


# ---------- IZZA token + shop payment config ----------

IZZA_CODE = os.getenv("IZZA_TOKEN_CODE", "IZZA").strip()
IZZA_ISSUER = os.getenv("IZZA_TOKEN_ISSUER", "").strip()

# Where the IZZA payment goes – default to same distributor public you use elsewhere
WZ_SHOP_DEST = (os.getenv("WZ_SHOP_DEST") or os.getenv("NFT_DISTR_PUBLIC", "").strip())


def _parse_izza_amount(raw) -> Decimal | None:
    """
    Normalize an amount to a Stellar-friendly Decimal with 7 decimals.
    Returns None if invalid or <= 0.
    """
    try:
        d = Decimal(str(raw))
    except (InvalidOperation, TypeError, ValueError):
        return None
    if d <= 0:
        return None
    return d.quantize(Decimal("0.0000001"))


def _izza_payment_config_ok() -> bool:
    return bool(IZZA_CODE and IZZA_ISSUER and WZ_SHOP_DEST and len(IZZA_ISSUER) > 0)


# ---------- WAR ZONE SHOP: schema + seed ----------


def _ensure_shop_schema(cx):
    cx.executescript(
        """
        CREATE TABLE IF NOT EXISTS warzone_shop_items(
          id INTEGER PRIMARY KEY,
          slot TEXT NOT NULL,              -- 'weapons' | 'skins'
          sku  TEXT NOT NULL UNIQUE,
          name TEXT,
          description TEXT,
          price_izza REAL NOT NULL DEFAULT 0,
          starting INTEGER NOT NULL DEFAULT 0,
          sort_order INTEGER NOT NULL DEFAULT 0,
          active INTEGER NOT NULL DEFAULT 1
        );

        CREATE TABLE IF NOT EXISTS warzone_inventory(
          id INTEGER PRIMARY KEY,
          user_id INTEGER NOT NULL,
          slot TEXT NOT NULL,              -- 'weapons' | 'skins'
          sku TEXT NOT NULL,
          equipped INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          UNIQUE(user_id, slot, sku),
          FOREIGN KEY(user_id) REFERENCES users(id)
        );

        -- Invites table (safe-create if you haven't added it elsewhere yet)
        CREATE TABLE IF NOT EXISTS warzone_invites(
          id INTEGER PRIMARY KEY,
          from_user_id INTEGER NOT NULL,
          to_user_id INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          created_at INTEGER NOT NULL,
          UNIQUE(from_user_id, to_user_id, status)
        );
        """
    )


def _seed_shop_if_empty(cx):
    cur = cx.execute("SELECT COUNT(*) AS c FROM warzone_shop_items")
    row = cur.fetchone()
    if row and row["c"]:
        return

    weapons = [
        {
            "slot": "weapons",
            "sku": "wz_basic_pistol",
            "name": "Basic Pistol",
            "description": "Standard-issue sidearm. You always deploy with this for free.",
            "price": 0,
            "starting": 1,
            "order": 0,
        },
        {
            "slot": "weapons",
            "sku": "wz_cityrunner_smg",
            "name": "Cityrunner SMG",
            "description": "High-rate SMG tuned for close-quarters street fights.",
            "price": 5,
            "starting": 0,
            "order": 10,
        },
        {
            "slot": "weapons",
            "sku": "wz_neon_marksman",
            "name": "Neon Marksman",
            "description": "Burst rifle with a glowing IZZA reticle and tight recoil.",
            "price": 5,
            "starting": 0,
            "order": 20,
        },
        {
            "slot": "weapons",
            "sku": "wz_skyline_sniper",
            "name": "Skyline Sniper",
            "description": "Long-range bolt-action tuned for rooftop control.",
            "price": 15,
            "starting": 0,
            "order": 30,
        },
        {
            "slot": "weapons",
            "sku": "wz_pulse_rifle",
            "name": "Pulse Rifle",
            "description": "Experimental IZZA tech that fires charged plasma rounds.",
            "price": 15,
            "starting": 0,
            "order": 40,
        },
    ]

    skins = [
        {
            "slot": "skins",
            "sku": "wz_basic_soldier",
            "name": "Basic IZZA Soldier",
            "description": "Standard operator kit in dark IZZA city camo.",
            "price": 0,
            "starting": 1,
            "order": 0,
        },
        {
            "slot": "skins",
            "sku": "wz_neon_edge",
            "name": "Neon Edge",
            "description": "Black armor with cyan edge lights and subtle neon trims.",
            "price": 5,
            "starting": 0,
            "order": 10,
        },
        {
            "slot": "skins",
            "sku": "wz_urban_shadow",
            "name": "Urban Shadow",
            "description": "Stealth trench and face mask tuned for city outskirts.",
            "price": 5,
            "starting": 0,
            "order": 20,
        },
        {
            "slot": "skins",
            "sku": "wz_cinder_camo",
            "name": "Cinder Camo",
            "description": "Burnt orange and charcoal pattern inspired by IZZA tokens.",
            "price": 15,
            "starting": 0,
            "order": 30,
        },
        {
            "slot": "skins",
            "sku": "wz_glow_legend",
            "name": "Glow Legend",
            "description": "Premium holo-vest with animated neon highlights.",
            "price": 15,
            "starting": 0,
            "order": 40,
        },
    ]

    for it in weapons + skins:
        cx.execute(
            """
            INSERT OR IGNORE INTO warzone_shop_items
              (slot, sku, name, description, price_izza, starting, sort_order, active)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1)
            """,
            (
                it["slot"],
                it["sku"],
                it["name"],
                it["description"],
                it["price"],
                it["starting"],
                it["order"],
            ),
        )


# ----------------------------------------------------------------------
# Auth / lobby
# ----------------------------------------------------------------------


@warzone_bp.get("/auth")
def warzone_auth():
    sandbox = current_app.config.get("PI_SANDBOX", False)
    return render_template("warzone_auth.html", sandbox=sandbox)


@warzone_bp.get("/")
def warzone_lobby():
    if "user_id" not in session:
        qs = request.query_string.decode("utf-8")
        base = "/warzone/auth"
        return redirect(f"{base}?{qs}" if qs else base)

    try:
        uid = int(session.get("user_id"))
    except (TypeError, ValueError):
        uid = None

    db_name = None
    if uid is not None:
        with conn() as cx:
            row = cx.execute(
                """
                SELECT COALESCE(username, pi_username, pi_uid) AS name
                FROM users
                WHERE id = ?
                """,
                (uid,),
            ).fetchone()
            if row and row["name"]:
                db_name = row["name"]

    display_name = (
        db_name
        or session.get("username")
        or session.get("pi_username")
        or session.get("pi_handle")
        or (f"User #{uid}" if uid is not None else "Operator")
    )

    player = {
        "id": uid,
        "username": display_name,
        "starter": session.get("warzone_starter") or "soldier_m",
    }

    map_image_url = "/assets/warzone-map-izzacity.jpg"

    return render_template(
        "warzone_lobby.html",
        player=player,
        map_image_url=map_image_url,
        PI_SANDBOX=current_app.config.get("PI_SANDBOX", False),
    )


# ----------------------------------------------------------------------
# War Zone API: friend search + lobby invites
# ----------------------------------------------------------------------


@warzone_bp.get("/api/search")
def warzone_search_players():
    uid = _require_user_id()
    if not uid:
        return jsonify({"error": "auth_required"}), 401

    q = (request.args.get("q") or "").strip()
    if not q:
        return jsonify({"results": []})

    like = f"%{q}%"
    with conn() as cx:
        rows = cx.execute(
            """
            SELECT id,
                   COALESCE(username, pi_username) AS username
            FROM users
            WHERE (username LIKE ? OR pi_username LIKE ?)
              AND id != ?
            ORDER BY username COLLATE NOCASE
            LIMIT 20
            """,
            (like, like, uid),
        ).fetchall()

    results = [{"id": r["id"], "username": r["username"] or f"User #{r['id']}"} for r in rows]
    return jsonify({"results": results})


@warzone_bp.post("/api/invite")
def warzone_invite_player():
    uid = _require_user_id()
    if not uid:
        return jsonify({"error": "auth_required"}), 401

    data = request.get_json(silent=True) or {}
    try:
        target_id = int(data.get("target_id") or 0)
    except (TypeError, ValueError):
        target_id = 0

    if not target_id or target_id == uid:
        return jsonify({"error": "invalid_target"}), 400

    now_ts = _now_i()
    with conn() as cx:
        _ensure_shop_schema(cx)
        cx.execute(
            """
            INSERT OR IGNORE INTO warzone_invites
              (from_user_id, to_user_id, status, created_at)
            VALUES (?, ?, 'pending', ?)
            """,
            (uid, target_id, now_ts),
        )

    return jsonify({"ok": True})


# ----------------------------------------------------------------------
# War Zone Armory / Shop (weapons + skins)
# ----------------------------------------------------------------------


@warzone_bp.get("/api/shop")
def warzone_shop():
    uid = _require_user_id()
    inv_uid = uid if uid is not None else -1

    slot = (request.args.get("slot") or "weapons").strip().lower()
    if slot not in ("weapons", "skins"):
        return jsonify({"error": "bad_slot"}), 400

    with conn() as cx:
        _ensure_shop_schema(cx)
        _seed_shop_if_empty(cx)

        rows = cx.execute(
            """
            SELECT i.slot,
                   i.sku,
                   i.name,
                   i.description,
                   i.price_izza,
                   i.starting,
                   COALESCE(inv.equipped, 0) AS equipped,
                   CASE WHEN inv.id IS NOT NULL THEN 1 ELSE 0 END AS owned
            FROM warzone_shop_items AS i
            LEFT JOIN warzone_inventory AS inv
              ON inv.user_id = ?
             AND inv.slot    = i.slot
             AND inv.sku     = i.sku
            WHERE i.slot = ?
              AND i.active = 1
            ORDER BY i.starting DESC, i.sort_order ASC, i.id ASC
            """,
            (inv_uid, slot),
        ).fetchall()

    items = []
    for r in rows:
        starting = bool(r["starting"])
        owned = bool(r["owned"]) or starting
        equipped = bool(r["equipped"]) or (starting and not any(i.get("equipped") for i in items))
        items.append(
            {
                "slot": r["slot"],
                "sku": r["sku"],
                "name": r["name"],
                "description": r["description"],
                "price_izza": float(r["price_izza"] or 0),
                "starting": starting,
                "owned": owned,
                "equipped": equipped,
            }
        )

    return jsonify({"items": items})


@warzone_bp.post("/api/purchase")
def warzone_purchase():
    """
    NO SESSION AUTH REQUIRED.
    Inventory ownership is recorded using ?u=<pi username> (or JSON 'u').
    On-chain payment still requires buyer_sec and uses the same helpers
    you already use successfully (_change_trust + _pay_asset).
    """
    if not _izza_payment_config_ok():
        return jsonify({"error": "shop_config_invalid"}), 500

    uid = _get_uid_for_inventory()
    if not uid:
        return jsonify({"error": "user_resolve_failed"}), 400

    data = request.get_json(silent=True) or {}
    slot = (data.get("slot") or "").strip().lower()
    sku = (data.get("sku") or "").strip()

    try:
        price_izza_client = float(data.get("price_izza") or 0)
    except (TypeError, ValueError):
        price_izza_client = 0.0

    buyer_pub = (data.get("buyer_pub") or "").strip()
    buyer_sec = (data.get("buyer_sec") or "").strip()

    if slot not in ("weapons", "skins") or not sku:
        return jsonify({"error": "bad_request"}), 400

    if not (buyer_sec and buyer_sec.startswith("S") and len(buyer_sec) == 56):
        return jsonify({"error": "buyer_sec_missing"}), 400

    if buyer_pub and not (buyer_pub.startswith("G") and len(buyer_pub) == 56):
        buyer_pub = ""

    with conn() as cx:
        _ensure_shop_schema(cx)
        _seed_shop_if_empty(cx)

        item = cx.execute(
            """
            SELECT slot, sku, price_izza, starting
            FROM warzone_shop_items
            WHERE slot = ? AND sku = ? AND active = 1
            """,
            (slot, sku),
        ).fetchone()

        if not item:
            return jsonify({"error": "unknown_item"}), 400

        if item["starting"]:
            return jsonify({"error": "starter_is_free"}), 400

        db_price = _parse_izza_amount(item["price_izza"])
        if db_price is None:
            return jsonify({"error": "invalid_price_config"}), 500

        if price_izza_client:
            client_dec = _parse_izza_amount(price_izza_client)
            if not client_dec or client_dec != db_price:
                return jsonify({"error": "price_mismatch", "price_izza": float(db_price)}), 400

        owned_row = cx.execute(
            """
            SELECT id, equipped
            FROM warzone_inventory
            WHERE user_id = ? AND slot = ? AND sku = ?
            """,
            (uid, slot, sku),
        ).fetchone()
        if owned_row:
            return jsonify({"ok": True, "already_owned": True})

    amount_str = str(db_price)
    izza_asset = Asset(IZZA_CODE, IZZA_ISSUER)

    # 1) Trustline
    try:
        _change_trust(buyer_sec, IZZA_CODE, IZZA_ISSUER, None)
    except Exception as e:
        return jsonify({"error": "trustline_failed", "detail": str(e)}), 502

    # 2) Payment
    try:
        tx_hash = _pay_asset(
            buyer_sec,
            WZ_SHOP_DEST,
            izza_asset,
            amount_str,
            f"WZ-{slot}-{sku}",
        )
    except Exception as e:
        return jsonify({"error": "payment_failed", "detail": str(e)}), 502

    # 3) Record ownership
    now_ts = _now_i()
    with conn() as cx:
        _ensure_shop_schema(cx)
        cx.execute(
            """
            INSERT OR IGNORE INTO warzone_inventory
              (user_id, slot, sku, equipped, created_at)
            VALUES (?, ?, ?, 0, ?)
            """,
            (uid, slot, sku, now_ts),
        )

    return jsonify({"ok": True, "tx": tx_hash})


@warzone_bp.post("/api/equip")
def warzone_equip():
    """
    NO SESSION AUTH REQUIRED.
    Equips an item for user resolved via ?u= (or JSON 'u').
    """
    uid = _get_uid_for_inventory()
    if not uid:
        return jsonify({"error": "user_resolve_failed"}), 400

    data = request.get_json(silent=True) or {}
    slot = (data.get("slot") or "").strip().lower()
    sku = (data.get("sku") or "").strip()

    if slot not in ("weapons", "skins") or not sku:
        return jsonify({"error": "bad_request"}), 400

    now_ts = _now_i()
    with conn() as cx:
        _ensure_shop_schema(cx)
        _seed_shop_if_empty(cx)

        item = cx.execute(
            """
            SELECT slot, sku, starting
            FROM warzone_shop_items
            WHERE slot = ? AND sku = ? AND active = 1
            """,
            (slot, sku),
        ).fetchone()
        if not item:
            return jsonify({"error": "unknown_item"}), 400

        if not item["starting"]:
            owned = cx.execute(
                """
                SELECT id
                FROM warzone_inventory
                WHERE user_id = ? AND slot = ? AND sku = ?
                """,
                (uid, slot, sku),
            ).fetchone()
            if not owned:
                return jsonify({"error": "not_owned"}), 400

        cx.execute(
            """
            UPDATE warzone_inventory
               SET equipped = 0
             WHERE user_id = ? AND slot = ?
            """,
            (uid, slot),
        )

        cx.execute(
            """
            INSERT OR IGNORE INTO warzone_inventory
              (user_id, slot, sku, equipped, created_at)
            VALUES (?, ?, ?, 0, ?)
            """,
            (uid, slot, sku, now_ts),
        )
        cx.execute(
            """
            UPDATE warzone_inventory
               SET equipped = 1
             WHERE user_id = ? AND slot = ? AND sku = ?
            """,
            (uid, slot, sku),
        )

    return jsonify({"ok": True})


# ----------------------------------------------------------------------
# Soldier GLB test page (barebones)
# ----------------------------------------------------------------------


@warzone_bp.get("/test-soldier")
def warzone_test_soldier():
    return render_template("warzone_soldier_test.html")
