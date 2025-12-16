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
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

from stellar_sdk import Asset, Keypair, Server, TransactionBuilder


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
    u = _norm_username(request.args.get("u"))
    if u:
        return u

    for k in ("pi_username", "username", "pi_handle"):
        u = _norm_username(session.get(k))
        if u:
            return u

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

IZZA_ASSET_CODE = (
    os.getenv("IZZA_ASSET_CODE")
    or os.getenv("IZZA_TOKEN_CODE")
    or os.getenv("IZZA_CODE")
    or "IZZA"
).strip()

IZZA_ASSET_ISSUER = (
    os.getenv("IZZA_ASSET_ISSUER")
    or os.getenv("IZZA_TOKEN_ISSUER")
    or os.getenv("IZZA_ISSUER")
    or "GDKS3KFAM5RBBTSYTFUEHHN7GYRPHV7A6K2BI44LL3QQKXCA6ODBCS57"
).strip()

WZ_SHOP_DEST = (
    os.getenv("WZ_SHOP_DEST")
    or os.getenv("BOT_WALLET_PUB")
    or os.getenv("NFT_DISTR_PUBLIC", "")
).strip()


def _izza_payment_config_ok() -> bool:
    return bool(IZZA_ASSET_CODE and IZZA_ASSET_ISSUER and WZ_SHOP_DEST)


def _parse_izza_amount(raw):
    try:
        d = Decimal(str(raw))
    except (InvalidOperation, TypeError, ValueError):
        return None
    if d <= 0:
        return None
    return d.quantize(_STROOP_QUANTUM, rounding=ROUND_HALF_UP)


def _send_izza_payment(from_secret: str, to_pub: str, amount: Decimal, memo_text: str = "") -> str:
    if not from_secret or not to_pub:
        raise ValueError("Missing from_secret or to_pub")

    amt = _to_stellar_amount(amount)

    kp = Keypair.from_secret(from_secret)
    from_pub = kp.public_key

    account = _srv.load_account(from_pub)
    izza_asset = Asset(IZZA_ASSET_CODE, IZZA_ASSET_ISSUER)

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


# ----------------------------------------------------------------------
# Wallet link helpers
# ----------------------------------------------------------------------

def _linked_wallet_pub_for_username(uname: str) -> str:
    """
    Source of truth, same as bot bucket:
      user_wallets.pub keyed by username (lowercase)
    """
    if not uname:
        return ""
    u = uname.strip().lstrip("@").lower()
    if not u:
        return ""
    try:
        with conn() as cx:
            row = cx.execute(
                "SELECT pub FROM user_wallets WHERE username = ?",
                (u,),
            ).fetchone()
        if row and row["pub"]:
            return str(row["pub"]).strip().upper()
    except Exception:
        return ""
    return ""


# ----------------------------------------------------------------------
# WAR ZONE SHOP: schema + seed
# ----------------------------------------------------------------------

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
    row = cx.execute("SELECT COUNT(*) AS c FROM warzone_shop_items").fetchone()
    if row and row["c"]:
        return

    weapons = [
        {"slot": "weapons", "sku": "wz_basic_pistol", "name": "Basic Pistol",
         "description": "Standard-issue sidearm. You always deploy with this for free.",
         "price": 0, "starting": 1, "order": 0},
        {"slot": "weapons", "sku": "wz_cityrunner_smg", "name": "Cityrunner SMG",
         "description": "High-rate SMG tuned for close-quarters street fights.",
         "price": 100, "starting": 0, "order": 10},
        {"slot": "weapons", "sku": "wz_neon_marksman", "name": "Neon Marksman",
         "description": "Burst rifle with a glowing IZZA reticle and tight recoil.",
         "price": 150, "starting": 0, "order": 20},
        {"slot": "weapons", "sku": "wz_skyline_sniper", "name": "Skyline Sniper",
         "description": "Long-range bolt-action tuned for rooftop control.",
         "price": 150, "starting": 0, "order": 30},
        {"slot": "weapons", "sku": "wz_pulse_rifle", "name": "Pulse Rifle",
         "description": "Experimental IZZA tech that fires charged plasma rounds.",
         "price": 200, "starting": 0, "order": 40},
    ]

    skins = [
        {"slot": "skins", "sku": "wz_basic_soldier", "name": "Basic IZZA Soldier",
         "description": "Standard operator kit in dark IZZA city camo.",
         "price": 0, "starting": 1, "order": 0},
        {"slot": "skins", "sku": "wz_neon_edge", "name": "Neon Edge",
         "description": "Black armor with cyan edge lights and subtle neon trims.",
         "price": 50, "starting": 0, "order": 10},
        {"slot": "skins", "sku": "wz_urban_shadow", "name": "Urban Shadow",
         "description": "Stealth trench and face mask tuned for city outskirts.",
         "price": 150, "starting": 0, "order": 20},
        {"slot": "skins", "sku": "wz_cinder_camo", "name": "Cinder Camo",
         "description": "Burnt orange and charcoal pattern inspired by IZZA tokens.",
         "price": 200, "starting": 0, "order": 30},
        {"slot": "skins", "sku": "wz_glow_legend", "name": "Glow Legend",
         "description": "Premium holo-vest with animated neon highlights.",
         "price": 500, "starting": 0, "order": 40},
    ]

    for it in weapons + skins:
        cx.execute(
            """
            INSERT OR IGNORE INTO warzone_shop_items
              (slot, sku, name, description, price_izza, starting, sort_order, active)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1)
            """,
            (it["slot"], it["sku"], it["name"], it["description"], it["price"], it["starting"], it["order"]),
        )


# ----------------------------------------------------------------------
# Auth / lobby / NEW shop page
# ----------------------------------------------------------------------

@warzone_bp.get("/auth")
def warzone_auth():
    sandbox = current_app.config.get("PI_SANDBOX", False)
    return render_template("warzone_auth.html", sandbox=sandbox)


@warzone_bp.get("/")
def warzone_lobby():
    """
    FIX:
    Use the same resolver as shop/api so deep links with ?u= work.
    This prevents the lobby from loading "basic" due to missing session user_id.
    """
    uid = _require_user_id_or_u()
    if not uid:
        qs = request.query_string.decode("utf-8")
        base = "/warzone/auth"
        return redirect(f"{base}?{qs}" if qs else base)

    with conn() as cx:
        row = cx.execute(
            """
            SELECT COALESCE(username, pi_username, pi_uid) AS name
            FROM users
            WHERE id = ?
            """,
            (uid,),
        ).fetchone()

    db_name = row["name"] if row and row["name"] else None

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


@warzone_bp.get("/shop")
def warzone_shop_page():
    """
    New standalone shop page, rotated like lobby.
    Users only arrive here via lobby, but we still support deep-links with ?u=
    """
    uid = _require_user_id_or_u()
    if not uid:
        qs = request.query_string.decode("utf-8")
        base = "/warzone/auth"
        return redirect(f"{base}?{qs}" if qs else base)

    # Display name
    with conn() as cx:
        row = cx.execute(
            "SELECT COALESCE(username, pi_username, pi_uid) AS name FROM users WHERE id=?",
            (uid,),
        ).fetchone()
    display_name = (row["name"] if row and row["name"] else None) or session.get("pi_username") or session.get("username") or f"User #{uid}"

    # default tab
    tab = (request.args.get("tab") or "weapons").strip().lower()
    if tab not in ("weapons", "skins"):
        tab = "weapons"

    # keep username in the URL if present, so all API calls can include it
    u = _resolve_username() or ""
    u_qs = f"u={u}" if u else ""
    back = "/warzone/"
    if u_qs:
        back = f"/warzone/?{u_qs}"

    return render_template(
        "warzone_shop.html",
        player={"id": uid, "username": display_name},
        default_tab=tab,
        back_url=back,
        PI_SANDBOX=current_app.config.get("PI_SANDBOX", False),
    )


# ----------------------------------------------------------------------
# Redirect routes for the old lobby buttons
# ----------------------------------------------------------------------

@warzone_bp.get("/shop/skins")
def warzone_shop_skins_redirect():
    # keep ?u= if present
    qs = request.query_string.decode("utf-8")
    join = "&" if qs else ""
    return redirect(f"/warzone/shop?tab=skins{join}{qs}")


@warzone_bp.get("/shop/weapons")
def warzone_shop_weapons_redirect():
    qs = request.query_string.decode("utf-8")
    join = "&" if qs else ""
    return redirect(f"/warzone/shop?tab=weapons{join}{qs}")


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

    results = [{"id": r["id"], "username": r["username"] or f"User #{r['id']}"} for r in rows]
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
# War Zone Shop API
# ----------------------------------------------------------------------

@warzone_bp.get("/api/shop")
def warzone_shop():
    uid = _require_user_id_or_u()
    inv_uid = uid if uid is not None else -1

    slot = (request.args.get("slot") or "weapons").strip().lower()
    if slot not in ("weapons", "skins"):
        return jsonify({"error": "bad_slot"}), 400

    with conn() as cx:
        _ensure_shop_schema(cx)
        _seed_shop_if_empty(cx)

        # FIX:
        # Determine equipped sku for this slot, so starter can be marked equipped
        equipped_sku = None
        if inv_uid != -1:
            eq = cx.execute(
                """
                SELECT sku
                FROM warzone_inventory
                WHERE user_id = ? AND slot = ? AND equipped = 1
                LIMIT 1
                """,
                (inv_uid, slot),
            ).fetchone()
            if eq and eq["sku"]:
                equipped_sku = str(eq["sku"])

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

        if starting:
            # FIX:
            # Starter is equipped if there is no equipped item in this slot,
            # OR if the equipped sku explicitly equals the starter sku.
            if equipped_sku is None:
                equipped = True
            else:
                equipped = (equipped_sku == r["sku"])
        else:
            equipped = bool(r["equipped"])

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
            {"error": "shop_config_invalid", "detail": "Missing IZZA asset code/issuer or shop dest on server."}
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

    if not (buyer_sec and buyer_sec.startswith("S") and len(buyer_sec) == 56):
        return jsonify({"error": "buyer_sec_missing"}), 400

    try:
        kp = Keypair.from_secret(buyer_sec)
        derived_pub = kp.public_key
    except Exception:
        return jsonify({"error": "buyer_key_invalid"}), 400

    if buyer_pub:
        if not (buyer_pub.startswith("G") and len(buyer_pub) == 56):
            return jsonify({"error": "buyer_pub_invalid"}), 400
        if derived_pub != buyer_pub:
            return jsonify({"error": "buyer_key_mismatch"}), 400

    uname = _resolve_username()
    if not uname:
        return jsonify({"error": "username_required"}), 401

    linked_pub = _linked_wallet_pub_for_username(uname)
    if not linked_pub:
        return jsonify({"error": "no_linked_wallet"}), 403
    if linked_pub != derived_pub:
        return jsonify({"error": "wallet_not_linked_for_user"}), 403

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
            SELECT id
            FROM warzone_inventory
            WHERE user_id = ? AND slot = ? AND sku = ?
            """,
            (uid, slot, sku),
        ).fetchone()
        if owned_row:
            return jsonify({"ok": True, "already_owned": True, "slot": slot, "sku": sku, "owned": True})

    try:
        tx_hash = _send_izza_payment(
            from_secret=buyer_sec,
            to_pub=WZ_SHOP_DEST,
            amount=db_price,
            memo_text=f"WZ,{slot},{sku}",
        )
    except Exception as e:
        return jsonify({"error": "payment_failed", "detail": str(e)}), 502

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

    return jsonify(
        {
            "ok": True,
            "tx": tx_hash,
            "slot": slot,
            "sku": sku,
            "owned": True,
            "equipped": False,
            "price_izza": float(db_price),
        }
    )


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

        # Clear equipped for this slot
        cx.execute(
            """
            UPDATE warzone_inventory
               SET equipped = 0
             WHERE user_id = ? AND slot = ?
            """,
            (uid, slot),
        )

        # Ensure row exists (starter can be inserted too)
        cx.execute(
            """
            INSERT OR IGNORE INTO warzone_inventory
              (user_id, slot, sku, equipped, created_at)
            VALUES (?, ?, ?, 0, ?)
            """,
            (uid, slot, sku, now_ts),
        )

        # Set equipped
        cx.execute(
            """
            UPDATE warzone_inventory
               SET equipped = 1
             WHERE user_id = ? AND slot = ? AND sku = ?
            """,
            (uid, slot, sku),
        )

    return jsonify({"ok": True, "slot": slot, "sku": sku, "equipped": True})


@warzone_bp.get("/test-soldier")
def warzone_test_soldier():
    return render_template("warzone_soldier_test.html")
