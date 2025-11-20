import os
import time
import random
import sqlite3
import logging
from decimal import Decimal

from flask import Blueprint, render_template, request, jsonify

import requests
from stellar_sdk import Server, Keypair, Asset, TransactionBuilder
from stellar_sdk.exceptions import NotFoundError

# Use same app DB as the rest of IZZA
import db as app_db

izza_airdrop_bp = Blueprint("izza_airdrop", __name__)
log = logging.getLogger("izza_airdrop")

# -------------------------------------------------------------------
# DB HELPER (shared DB via db.py)
# -------------------------------------------------------------------
def cx():
    return app_db.conn()

# -------------------------------------------------------------------
# STELLAR + IZZA TOKEN CONFIG
# -------------------------------------------------------------------
HORIZON = os.getenv("HORIZON_URL", "https://api.testnet.minepi.com")
NETWORK = os.getenv("NETWORK_PASSPHRASE", "Pi Testnet")

ASSET_CODE   = os.getenv("ASSET_CODE", "IZZA")
ISSUER_PUB   = os.getenv("ISSUER_PUB")
DISTR_PUB    = os.getenv("DISTR_PUB")
DISTR_SECRET = os.getenv("DISTR_SECRET")

# Pi Platform API (same style as 67 app)
PI_API_KEY      = os.getenv("PI_PLATFORM_API_KEY")
PI_PLATFORM_URL = os.getenv("PI_PLATFORM_URL", "https://api.minepi.com")

# Optional: limit to a single wave tag (same as mint_izza AIRDROP_TAG)
AIRDROP_TAG = os.getenv("AIRDROP_TAG", "").strip()  # e.g. "test1"

server   = Server(HORIZON)
asset_izza = Asset(ASSET_CODE, ISSUER_PUB)
dist_kp  = Keypair.from_secret(DISTR_SECRET)


# -------------------------------------------------------------------
# INIT TABLES
# -------------------------------------------------------------------
def init_tables():
    with cx() as conn:
        # Airdrop log (shared with mint_izza.py)
        conn.execute("""
        CREATE TABLE IF NOT EXISTS izza_airdrops(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          wallet_pub TEXT NOT NULL,
          tag TEXT,
          amount TEXT,
          tx_hash TEXT,
          created_at INTEGER,
          UNIQUE(wallet_pub,tag)
        );
        """)

        # Crates, keyed primarily by wallet_pub (username cosmetic)
        conn.execute("""
        CREATE TABLE IF NOT EXISTS izza_crates(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT NOT NULL,
          wave_tag TEXT,
          opened INTEGER NOT NULL DEFAULT 0,
          wallet_pub TEXT,
          reward_amount TEXT,
          rarity TEXT,
          created_ts INTEGER,
          opened_ts INTEGER
        );
        """)

init_tables()


# -------------------------------------------------------------------
# PAYMENT: DISTRIBUTOR → USER PI TESTNET WALLET (IZZA)
# -------------------------------------------------------------------
def send_izza_tokens(dest_pub: str, amount_izza: int | Decimal):
    """Send IZZA from distributor to the user's Pi Testnet wallet."""
    try:
        # Check trustline
        acct = server.accounts().account_id(dest_pub).call()
        balances = acct.get("balances", [])
        has_tl = any(
            b.get("asset_code") == ASSET_CODE
            and b.get("asset_issuer") == ISSUER_PUB
            for b in balances
        )
        if not has_tl:
            return False, "No IZZA trustline in this Pi Testnet Wallet."

        amount_str = str(Decimal(amount_izza))

        distr_acct = server.load_account(DISTR_PUB)
        base_fee = server.fetch_base_fee()

        tx = (
            TransactionBuilder(
                source_account=distr_acct,
                network_passphrase=NETWORK,
                base_fee=base_fee,
            )
            .append_payment_op(
                destination=dest_pub,
                amount=amount_str,
                asset=asset_izza
            )
            .set_timeout(120)
            .build()
        )
        tx.sign(dist_kp)
        resp = server.submit_transaction(tx)
        return True, resp.get("hash", "")
    except Exception as e:
        log.exception("send_izza_tokens error dest=%s amount=%s", dest_pub, amount_izza)
        return False, str(e)


# -------------------------------------------------------------------
# RARITY TABLE (5–25 IZZA)
# -------------------------------------------------------------------
def roll_reward():
    roll = random.randint(1, 100)
    if roll <= 70:
        return 5, "common"
    elif roll <= 90:
        return 10, "uncommon"
    elif roll <= 99:
        return 18, "rare"
    else:
        return 25, "legendary"


# -------------------------------------------------------------------
# HORIZON HELPERS
# -------------------------------------------------------------------
def get_tx_source_account(txid: str) -> str | None:
    """
    Look up a transaction on Horizon and return the source_account
    (for a user→app payment, this is the user's Pi testnet wallet_pub).
    """
    try:
        url = f"{HORIZON}/transactions/{txid}"
        r = requests.get(url, timeout=15)
        r.raise_for_status()
        data = r.json()
        return data.get("source_account")
    except Exception as e:
        log.exception("get_tx_source_account failed txid=%s error=%s", txid, e)
        return None


# -------------------------------------------------------------------
# PAGE ROUTES
# -------------------------------------------------------------------

# MAIN route
@izza_airdrop_bp.route("/izza-airdrop")
def izza_airdrop_page():
    return render_template(
        "izza_airdrop.html",
        PI_APP_ID=os.getenv("PI_APP_ID", ""),
        PI_SANDBOX="true" if os.getenv("PI_SANDBOX", "true") == "true" else "false"
    )


# alias route so /airdrop works
@izza_airdrop_bp.route("/airdrop")
def airdrop_alias():
    return render_template(
        "izza_airdrop.html",
        PI_APP_ID=os.getenv("PI_APP_ID", ""),
        PI_SANDBOX="true" if os.getenv("PI_SANDBOX", "true") == "true" else "false"
    )


# -------------------------------------------------------------------
# PROFILE ENDPOINT – crates by wallet_pub
# -------------------------------------------------------------------
@izza_airdrop_bp.get("/api/izza_airdrop/profile")
def api_profile():
    wallet_pub = request.args.get("wallet_pub")
    if not wallet_pub:
        return jsonify({"ok": False, "message": "No wallet_pub"}), 400

    with cx() as conn:
        crates = conn.execute(
            "SELECT id, wave_tag FROM izza_crates "
            "WHERE wallet_pub = ? AND opened = 0 "
            "ORDER BY id ASC",
            (wallet_pub,)
        ).fetchall()

    return jsonify({
        "ok": True,
        "wallet_pub": wallet_pub,
        "crates": [{"id": r[0], "wave_tag": r[1]} for r in crates],
        "message": (
            "Tap your IZZA loot crate to reveal your reward."
            if crates else "No unopened crates for this wallet yet."
        )
    })


# -------------------------------------------------------------------
# ACTIVATE – 0 Pi payment to capture wallet_pub and grant crate
# -------------------------------------------------------------------
@izza_airdrop_bp.post("/api/izza_airdrop/activate/approve")
def api_airdrop_activate_approve():
    data = request.get_json(force=True) or {}
    payment_id = data.get("paymentId")
    username   = data.get("username") or ""

    if not payment_id:
        return jsonify({"ok": False, "error": "missing_payment_id"}), 400

    if not PI_API_KEY:
        log.warning("PI_API_KEY missing, activation approve running in dry mode")
        return jsonify({"ok": True, "dry": True})

    try:
        resp = requests.post(
            f"{PI_PLATFORM_URL}/v2/payments/{payment_id}/approve",
            headers={"Authorization": f"Key {PI_API_KEY}"},
            timeout=15
        )
        resp.raise_for_status()
        return jsonify({"ok": True})
    except Exception as e:
        log.exception("IZZA airdrop activate approve error payment_id=%s user=%s err=%s",
                      payment_id, username, e)
        return jsonify({"ok": False, "error": "approve_failed"}), 500


@izza_airdrop_bp.post("/api/izza_airdrop/activate/complete")
def api_airdrop_activate_complete():
    """
    Called from Pi SDK onReadyForServerCompletion for the 0 Pi activation payment.
    We:
      1) Complete the payment on Pi Platform.
      2) Look up tx on Horizon and grab source_account (user wallet_pub).
      3) Check izza_airdrops for that wallet_pub (and AIRDROP_TAG if set).
      4) If found, ensure a crate row exists for that wallet_pub + wave_tag.
      5) Return wallet_pub + crate_id so front-end can load profile.
    """
    data      = request.get_json(force=True) or {}
    payment_id = data.get("paymentId")
    txid       = data.get("txid")
    username   = data.get("username") or ""

    if not payment_id or not txid:
        return jsonify({"ok": False, "error": "missing_payment_fields"}), 400

    # Complete payment on Pi Platform (even though it's 0 Pi, user pays fee)
    if PI_API_KEY:
        try:
            resp = requests.post(
                f"{PI_PLATFORM_URL}/v2/payments/{payment_id}/complete",
                headers={"Authorization": f"Key {PI_API_KEY}"},
                json={"txid": txid},
                timeout=20
            )
            resp.raise_for_status()
        except Exception as e:
            log.exception("IZZA airdrop activate complete error payment_id=%s user=%s err=%s",
                          payment_id, username, e)
            return jsonify({"ok": False, "error": "complete_failed"}), 500

    # Get wallet_pub from tx on Horizon
    wallet_pub = get_tx_source_account(txid)
    if not wallet_pub:
        return jsonify({"ok": False, "error": "wallet_lookup_failed"}), 500

    now = int(time.time())

    with cx() as conn:
        # Confirm that this wallet actually received an IZZA airdrop
        if AIRDROP_TAG:
            row = conn.execute(
                "SELECT amount, tag FROM izza_airdrops "
                "WHERE wallet_pub = ? AND tag = ?",
                (wallet_pub, AIRDROP_TAG)
            ).fetchone()
        else:
            row = conn.execute(
                "SELECT amount, tag FROM izza_airdrops "
                "WHERE wallet_pub = ? ORDER BY id DESC LIMIT 1",
                (wallet_pub,)
            ).fetchone()

        if not row:
            # No airdrop recorded for this wallet
            return jsonify({
                "ok": False,
                "error": "no_airdrop_for_wallet",
                "wallet_pub": wallet_pub
            }), 200

        _amount, tag = row
        wave_tag = tag or (AIRDROP_TAG or "airdrop")

        # Ensure crate exists for this wallet + wave_tag
        existing = conn.execute(
            "SELECT id FROM izza_crates "
            "WHERE wallet_pub = ? AND wave_tag = ? AND opened = 0",
            (wallet_pub, wave_tag)
        ).fetchone()

        if existing:
            crate_id = existing[0]
        else:
            cur = conn.execute(
                "INSERT INTO izza_crates "
                "(username, wave_tag, opened, wallet_pub, reward_amount, rarity, created_ts, opened_ts) "
                "VALUES (?,?,?,?,?,?,?,?)",
                (username or "unknown", wave_tag, 0, wallet_pub, None, None, now, None)
            )
            crate_id = cur.lastrowid

    return jsonify({
        "ok": True,
        "wallet_pub": wallet_pub,
        "wave_tag": wave_tag,
        "crate_id": crate_id
    })


# -------------------------------------------------------------------
# OPEN CRATE (REAL IZZA PAYOUT)
# -------------------------------------------------------------------
@izza_airdrop_bp.post("/api/izza_airdrop/open")
def api_open():
    data      = request.get_json(force=True) or {}
    username  = data.get("username")
    crate_id  = data.get("crate_id")
    wallet_in = data.get("wallet_pub")  # optional sanity check

    if not username:
        return jsonify({"ok": False, "error": "missing_username"}), 400
    if not crate_id:
        return jsonify({"ok": False, "error": "missing_crate_id"}), 400

    with cx() as conn:
        row = conn.execute(
            "SELECT id, opened, wallet_pub FROM izza_crates WHERE id = ?",
            (crate_id,)
        ).fetchone()

        if not row:
            return jsonify({"ok": False, "error": "crate_not_found"}), 400

        _id, opened, wallet_pub = row

        # sanity check: if client sends wallet_pub, ensure it matches
        if wallet_in and wallet_pub and wallet_in != wallet_pub:
            return jsonify({"ok": False, "error": "wallet_mismatch"}), 400

        if opened:
            return jsonify({"ok": False, "error": "crate_already_opened"}), 400

        # roll reward
        amount, rarity = roll_reward()

        # pay it to the wallet_pub we captured from the activation payment
        ok, info = send_izza_tokens(wallet_pub, amount)
        if not ok:
            return jsonify({"ok": False, "error": info}), 400

        now = int(time.time())
        conn.execute(
            "UPDATE izza_crates "
            "SET opened = 1, opened_ts = ?, reward_amount = ?, rarity = ? "
            "WHERE id = ?",
            (now, str(amount), rarity, crate_id)
        )

    return jsonify({
        "ok": True,
        "crate_id": crate_id,
        "reward_amount": amount,
        "rarity": rarity
    })
