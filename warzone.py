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
import json
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

from stellar_sdk import Asset, Keypair, Server, TransactionBuilder

# Keep import for compatibility, but Warzone payments now use direct stellar_sdk send.
# Reuse the same helpers you use in IZZA CREATURES
try:
    from nft_api import _pay_asset  # noqa: F401
except Exception:
    _pay_asset = None

warzone_bp = Blueprint("warzone_bp", __name__, url_prefix="/warzone")


# ----------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------

def _now_i() -> int:
    return int(time())


def _require_user_id():
    """
    Legacy: session-only.
    Kept to avoid breaking anything that might rely on it.
    """
    uid = session.get("user_id")
    if not uid:
        return None
    try:
        return int(uid)
    except (TypeError, ValueError):
        return None


def _norm_username(u):
    if not u:
        return None
    u = str(u).strip().lstrip("@").lower()
    return u or None


def _resolve_username():
    """
    Match your proven wallet API resolution order:
      1) ?u=<username>
      2) session['pi_username'] (or session fallbacks)
      3) session['user_id'] -> users.pi_username
    """
    # 1) explicit query
    u = _norm_username(request.args.get("u"))
    if u:
        return u

    # 2) session cache
    for k in ("pi_username", "username", "pi_handle"):
        u = _norm_username(session.get(k))
        if u:
            return u

    # 3) derive from user_id
    uid = session.get("user_id")
    if not uid:
        return None
    try:
        uid_i = int(uid)
    except (TypeError, ValueError):
        return None

    with conn() as cx:
        row = cx.execute(
            "SELECT COALESCE(pi_username, username) AS u FROM users WHERE id=?",
            (uid_i,),
        ).fetchone()
    return _norm_username(row["u"] if row else None)


def _require_user_id_or_u():
    """
    Warzone auth fix:
    If session user_id is missing (common in Pi Browser when you land deep-linked),
    allow Warzone endpoints to resolve the user via ?u= or session pi_username,
    then hydrate session['user_id'] so everything downstream (inventory, etc.) works.
    """
    uid = _require_user_id()
    if uid:
        return uid

    u = _resolve_username()
    if not u:
        return None

    with conn() as cx:
        row = cx.execute(
            """
            SELECT id
            FROM users
            WHERE lower(COALESCE(pi_username,'')) = ?
               OR lower(COALESCE(username,''))    = ?
            LIMIT 1
            """,
            (u, u),
        ).fetchone()

    if not row:
        return None

    try:
        uid_i = int(row["id"])
    except Exception:
        return None

    session["user_id"] = uid_i
    return uid_i


# ---------- Pi Testnet Horizon + network ----------

PI_HORIZON_URL = os.getenv("PI_HORIZON_URL", "https://api.testnet.minepi.com").strip()
NETWORK_PASSPHRASE = os.getenv("NETWORK_PASSPHRASE", "Pi Testnet").strip()

# Pi Testnet base fee (0.01 Pi = 100,000 stroops)
PI_BASE_FEE_STROOPS = int(os.getenv("PI_BASE_FEE_STROOPS", "100000"))

_srv = Server(horizon_url=PI_HORIZON_URL)

_STROOP_QUANTUM = Decimal("0.0000001")


def _to_stellar_amount(value) -> str:
    """
    Convert numeric -> Horizon-safe amount string with <= 7 decimals.
    Avoids float noise and scientific notation.
    """
    d = Decimal(str(value))
    if d <= 0:
        raise ValueError("amount must be positive")
    dq = d.quantize(_STROOP_QUANTUM, rounding=ROUND_HALF_UP)
    if dq <= 0:
        raise ValueError("amount too small to send (minimum 0.0000001)")
    return format(dq, "f")


# ---------- IZZA token + shop payment config ----------

IZZA_CODE = os.getenv("IZZA_TOKEN_CODE", "IZZA").strip()

# Make issuer robust, so Warzone doesn't silently break if you used a different env name elsewhere
IZZA_ISSUER = (
    os.getenv("IZZA_TOKEN_ISSUER")
    or os.getenv("IZZA_ASSET_ISSUER")
    or os.getenv("IZZA_ISSUER")
    or ""
).strip()

# Where the IZZA payment goes
WZ_SHOP_DEST = (
    os.getenv("WZ_SHOP_DEST")
    or os.getenv("NFT_DISTR_PUBLIC", "").strip()
)


def _izza_payment_config_ok() -> bool:
    return bool(IZZA_CODE and IZZA_ISSUER and WZ_SHOP_DEST)


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
    return d.quantize(_STROOP_QUANTUM, rounding=ROUND_HALF_UP)


def _verify_tx_succeeded(tx_hash: str) -> tuple[bool, str]:
    """
    Confirm the tx exists and succeeded on Pi Testnet Horizon.
    Returns (ok, detail).
    """
    if not tx_hash:
        return False, "missing_tx_hash"
    try:
        tx = _srv.transactions().transaction(tx_hash).call()
        if not tx:
            return False, "tx_not_found"
        if tx.get("successful") is True:
            return True, "ok"
        return False, "tx_not_successful"
    except Exception as e:
        return False, f"horizon_check_failed:{e}"


def _send_izza_payment(from_secret: str, to_pub: str, amount: Decimal, memo_text: str = "") -> str:
    """
    Sends IZZA from from_secret -> to_pub on Pi Testnet. Returns tx hash.
    """
    if not from_secret or not to_pub:
        raise ValueError("Missing from_secret or to_pub")

    amt = _to_stellar_amount(amount)

    kp = Keypair.from_secret(from_secret)
    from_pub = kp.public_key

    account = _srv.load_account(from_pub)

    izza_asset = Asset(IZZA_CODE, IZZA_ISSUER)

    builder = TransactionBuilder(
        source_account=account,
        network_passphrase=NETWORK_PASSPHRASE,
        base_fee=PI_BASE_FEE_STROOPS,
    )

    builder.append_payment_op(
        destination=to_pub,
        amount=amt,
        asset=izza_asset,
    )

    if memo_text:
        builder.add_text_memo(memo_text[:28])

    tx = builder.set_timeout(300).build()
    tx.sign(kp)
    resp = _srv.submit_transaction(tx)
    tx_hash = resp.get("hash") or ""
    if not tx_hash:
        raise RuntimeError("submit_transaction returned no hash")
    return tx_hash


def _get_usernames_for_user_id(cx, user_id: int) -> list[str]:
    """
    Return possible username keys used in your wallet system.
    Your proven system usually stores wallets in user_wallets keyed by username.
    """
    names: list[str] = []
    try:
        row = cx.execute(
            """
            SELECT
              COALESCE(username, '')    AS username,
              COALESCE(pi_username, '') AS pi_username,
              COALESCE(pi_uid, '')      AS pi_uid
            FROM users
            WHERE id = ?
            """,
            (user_id,),
        ).fetchone()
        if row:
            for k in ("username", "pi_username", "pi_uid"):
                v = (row[k] or "").strip()
                if v:
                    names.append(v)
    except Exception:
        pass

    # Also consider session values
    for k in ("username", "pi_username", "pi_handle"):
        v = (session.get(k) or "").strip()
        if v:
            names.append(v)

    # normalize
    out = []
    seen = set()
    for v in names:
        norm = v.strip().lstrip("@").lower()
        if norm and norm not in seen:
            seen.add(norm)
            out.append(norm)
    return out


def _get_linked_wallet_pub_for_user(cx, user_id: int) -> str:
    """
    Find the user's linked IZZA wallet pub.
    Prefers your proven table: user_wallets keyed by username.
    Falls back to a few user_id based tables if present.
    """
    # 1) Try user_wallets by username (matches your working IZZA BOT backend)
    for uname in _get_usernames_for_user_id(cx, user_id):
        try:
            row = cx.execute(
                "SELECT pub FROM user_wallets WHERE username = ?",
                (uname,),
            ).fetchone()
            if row and row["pub"]:
                return str(row["pub"]).strip().upper()
        except Exception:
            continue

    # 2) Fallback: try user_id keyed tables (if your deployment has them)
    candidates = [
        ("wallets", "pub", "user_id"),
        ("user_wallets", "pub", "user_id"),   # if schema differs on this env
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
    # Keep existing behavior: require a real session user_id to enter the lobby
    # (prevents breaking anything currently working)
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
    uid = _require_user_id_or_u()
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
    uid = _require_user_id_or_u()
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
    # Allow shop read to work with either session OR ?u= (same as wallet endpoints)
    uid = _require_user_id_or_u()
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
    uid = _require_user_id_or_u()
    if not uid:
        return jsonify({"error": "auth_required"}), 401

    if not _izza_payment_config_ok():
        return jsonify(
            {"error": "shop_config_invalid", "detail": "Missing IZZA issuer or shop dest on server."}
        ), 500

    data = request.get_json(silent=True) or {}
    slot = (data.get("slot") or "").strip().lower()
    sku = (data.get("sku") or "").strip()

    try:
        price_izza_client = float(data.get("price_izza") or 0)
    except (TypeError, ValueError):
        price_izza_client = 0.0

    buyer_pub = (data.get("buyer_pub") or "").strip().upper()
    buyer_sec = (data.get("buyer_sec") or "").strip()

    if slot not in ("weapons", "skins") or not sku:
        return jsonify({"error": "bad_request"}), 400

    if not (buyer_pub.startswith("G") and len(buyer_pub) == 56):
        return jsonify({"error": "buyer_pub_missing"}), 400

    if not (buyer_sec and buyer_sec.startswith("S") and len(buyer_sec) == 56):
        return jsonify({"error": "buyer_sec_missing"}), 400

    # Verify sec matches pub
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

        # Verify buyer_pub matches the user's linked IZZA wallet (proven pattern)
        linked_pub = _get_linked_wallet_pub_for_user(cx, uid)
        if linked_pub and linked_pub != buyer_pub:
            return jsonify({"error": "wallet_not_linked_for_user"}), 403

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

    # Execute IZZA payment (direct testnet stellar_sdk send)
    try:
        tx_hash = _send_izza_payment(
            from_secret=buyer_sec,
            to_pub=WZ_SHOP_DEST,
            amount=db_price,
            memo_text=f"WZ,{slot},{sku}",
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
    uid = _require_user_id_or_u()
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
