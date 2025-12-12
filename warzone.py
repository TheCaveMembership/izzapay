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

from stellar_sdk import Asset, Keypair, Server

# Reuse the same helpers you use in IZZA CREATURES
from nft_api import _pay_asset

warzone_bp = Blueprint("warzone_bp", __name__, url_prefix="/warzone")


# ----------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------


def _require_user_id():
    uid = session.get("user_id")
    if not uid:
        return None
    try:
        return int(uid)
    except (TypeError, ValueError):
        return None


def _now_i() -> int:
    return int(time())


# ---------- IZZA token + shop payment config ----------

IZZA_CODE = os.getenv("IZZA_TOKEN_CODE", "IZZA").strip()
IZZA_ISSUER = os.getenv("IZZA_TOKEN_ISSUER", "").strip()

# Where the IZZA payment goes
WZ_SHOP_DEST = (
    os.getenv("WZ_SHOP_DEST")
    or os.getenv("NFT_DISTR_PUBLIC", "").strip()
)

# Pi Testnet Horizon
PI_HORIZON_URL = os.getenv("PI_HORIZON_URL", "https://api.testnet.minepi.com").strip()


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
    return bool(
        IZZA_CODE
        and IZZA_ISSUER
        and WZ_SHOP_DEST
        and len(IZZA_ISSUER) > 0
    )


def _get_active_wallet_pub_for_user(cx, user_id: int) -> str:
    """
    Fetch the active wallet pub for this user from your wallet system.
    This assumes you already have /api/wallet/active working and persisting.

    We try a few likely table names to stay compatible with your existing setup.
    """
    candidates = [
        # table, pub column, user column
        ("wallets", "pub", "user_id"),
        ("user_wallets", "pub", "user_id"),
        ("izza_wallets", "pub", "user_id"),
        ("wallet_links", "pub", "user_id"),
        ("wallet_active", "pub", "user_id"),
    ]

    for table, pub_col, user_col in candidates:
        try:
            row = cx.execute(
                f"""
                SELECT {pub_col} AS pub
                FROM {table}
                WHERE {user_col} = ?
                ORDER BY id DESC
                LIMIT 1
                """,
                (user_id,),
            ).fetchone()
            if row and row["pub"]:
                return str(row["pub"]).strip().upper()
        except Exception:
            continue

    return ""


def _verify_tx_succeeded(tx_hash: str) -> tuple[bool, str]:
    """
    Confirm the tx exists and succeeded on Pi Testnet Horizon.
    Returns (ok, detail).
    """
    if not tx_hash:
        return False, "missing_tx_hash"
    try:
        srv = Server(horizon_url=PI_HORIZON_URL)
        tx = srv.transactions().transaction(tx_hash).call()
        if not tx:
            return False, "tx_not_found"
        if tx.get("successful") is True:
            return True, "ok"
        return False, "tx_not_successful"
    except Exception as e:
        return False, f"horizon_check_failed:{e}"


# ---------- WAR ZONE SHOP: schema + seed ----------


def _ensure_shop_schema(cx):
    cx.executescript(
        """
        CREATE TABLE IF NOT EXISTS warzone_shop_items(
          id INTEGER PRIMARY KEY,
          slot TEXT NOT NULL,
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
          slot TEXT NOT NULL,
          sku TEXT NOT NULL,
          equipped INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          UNIQUE(user_id, slot, sku),
          FOREIGN KEY(user_id) REFERENCES users(id)
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
            WHERE (username    LIKE ? OR pi_username LIKE ?)
              AND id != ?
            ORDER BY username COLLATE NOCASE
            LIMIT 20
            """,
            (like, like, uid),
        ).fetchall()

    results = [
        {"id": r["id"], "username": r["username"] or f"User #{r['id']}"}
        for r in rows
    ]
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
        equipped = bool(r["equipped"]) or (
            starting and not any(i.get("equipped") for i in items)
        )
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
    uid = _require_user_id()
    if not uid:
        return jsonify({"error": "auth_required"}), 401

    if not _izza_payment_config_ok():
        return jsonify({"error": "shop_config_invalid"}), 500

    data = request.get_json(silent=True) or {}
    slot = (data.get("slot") or "").strip().lower()
    sku = (data.get("sku") or "").strip()

    try:
        price_izza_client = float(data.get("price_izza") or 0)
    except (TypeError, ValueError):
        price_izza_client = 0.0

    buyer_pub = (data.get("buyer_pub") or "").strip().upper()
    buyer_sec = (data.get("buyer_sec") or "").strip().upper()

    if slot not in ("weapons", "skins") or not sku:
        return jsonify({"error": "bad_request"}), 400

    if not (buyer_pub.startswith("G") and len(buyer_pub) == 56):
        return jsonify({"error": "buyer_pub_missing"}), 400

    if not (buyer_sec and buyer_sec.startswith("S") and len(buyer_sec) == 56):
        return jsonify({"error": "buyer_sec_missing"}), 400

    # Verify sec matches pub, prevents “fake spend” and wrong key usage
    try:
        kp = Keypair.from_secret(buyer_sec)
        derived_pub = kp.public_key
        if derived_pub != buyer_pub:
            return jsonify({"error": "buyer_key_mismatch"}), 400
    except Exception:
        return jsonify({"error": "buyer_key_invalid"}), 400

    with conn() as cx:
        _ensure_shop_schema(cx)
        _seed_shop_if_empty(cx)

        # Verify buyer_pub is the active wallet for this user
        active_pub = _get_active_wallet_pub_for_user(cx, uid)
        if active_pub and active_pub != buyer_pub:
            return jsonify({"error": "wallet_not_active_for_user"}), 403

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
                return jsonify(
                    {"error": "price_mismatch", "price_izza": float(db_price)}
                ), 400

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

    # Execute payment
    try:
        tx_hash = _pay_asset(
            buyer_sec,
            WZ_SHOP_DEST,
            izza_asset,
            amount_str,
            f"WZ,{slot},{sku}",
        )
    except Exception as e:
        return jsonify({"error": "payment_failed", "detail": str(e)}), 502

    # Confirm on horizon that it actually succeeded
    ok_tx, tx_detail = _verify_tx_succeeded(tx_hash)
    if not ok_tx:
        return jsonify({"error": "payment_not_confirmed", "detail": tx_detail, "tx": tx_hash}), 502

    now_ts = _now_i()
    with conn() as cx:
        _ensure_shop_schema(cx)

        # Record ownership
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
    uid = _require_user_id()
    if not uid:
        return jsonify({"error": "auth_required"}), 401

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


@warzone_bp.get("/test-soldier")
def warzone_test_soldier():
    return render_template("warzone_soldier_test.html")
