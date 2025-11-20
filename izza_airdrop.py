import os
import time
import random
import sqlite3
import logging
from decimal import Decimal

from flask import Blueprint, render_template, request, jsonify

from stellar_sdk import Server, Keypair, Asset, TransactionBuilder

# Use same app DB as the rest of IZZA
import db as app_db

izza_airdrop_bp = Blueprint("izza_airdrop", __name__)
log = logging.getLogger("izza_airdrop")

# -------------------------------------------------------------------
# DB HELPER
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

# Optional, limit to a single wave tag (same as mint_izza AIRDROP_TAG)
AIRDROP_TAG = os.getenv("AIRDROP_TAG", "").strip()

server     = Server(HORIZON)
asset_izza = Asset(ASSET_CODE, ISSUER_PUB)
dist_kp    = Keypair.from_secret(DISTR_SECRET)

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

        # Crates, keyed primarily by wallet_pub
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
# PAYMENT, DISTRIBUTOR → USER PI TESTNET WALLET (IZZA)
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
# HELPER, ENSURE CRATE FOR WALLET
# -------------------------------------------------------------------
def ensure_crate_for_wallet(wallet_pub: str):
    """
    Mirror the old activate_complete logic, but without a Pi payment.

    When a wallet is checked, if there is an izza_airdrops row for it
    and no unopened crate yet for the wave, create one crate.
    """
    if not wallet_pub:
        return

    now = int(time.time())
    with cx() as conn:
        # Does this wallet have any recorded airdrop
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
            # No airdrop for this wallet, nothing to create
            return

        _amount, tag = row
        wave_tag = tag or (AIRDROP_TAG or "airdrop")

        # Does an unopened crate already exist for this wallet and wave
        existing = conn.execute(
            "SELECT id FROM izza_crates "
            "WHERE wallet_pub = ? AND wave_tag = ? AND opened = 0",
            (wallet_pub, wave_tag)
        ).fetchone()

        if existing:
            return

        conn.execute(
            "INSERT INTO izza_crates "
            "(username, wave_tag, opened, wallet_pub, reward_amount, rarity, created_ts, opened_ts) "
            "VALUES (?,?,?,?,?,?,?,?)",
            ("airdrop", wave_tag, 0, wallet_pub, None, None, now, None)
        )
        conn.commit()

# -------------------------------------------------------------------
# PAGE ROUTES
# -------------------------------------------------------------------
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
    return izza_airdrop_page()

# -------------------------------------------------------------------
# OPTIONAL LOG, SET WALLET FOR USER, SAME IDEA AS 67 /api/set_wallet
# -------------------------------------------------------------------
@izza_airdrop_bp.post("/api/izza_airdrop/set_wallet")
def api_set_wallet():
    data = request.get_json(force=True) or {}
    username   = data.get("username") or "guest"
    wallet_pub = (data.get("wallet_pub") or "").strip()

    if not wallet_pub.startswith("G") or len(wallet_pub) < 20:
        return jsonify({"ok": False, "error": "invalid_wallet"}), 400

    # For now we just log it, crate creation is handled in profile by wallet_pub
    log.info("IZZA airdrop set_wallet user=%s wallet_pub=%s", username, wallet_pub)
    return jsonify({"ok": True, "wallet_pub": wallet_pub})

# -------------------------------------------------------------------
# PROFILE ENDPOINT, crates by wallet_pub
# -------------------------------------------------------------------
@izza_airdrop_bp.get("/api/izza_airdrop/profile")
def api_profile():
    wallet_pub = request.args.get("wallet_pub")
    if not wallet_pub:
        return jsonify({"ok": False, "message": "No wallet_pub"}), 400

    # Make sure this wallet gets a crate if it has an airdrop
    ensure_crate_for_wallet(wallet_pub)

    with cx() as conn:
        crates = conn.execute(
            "SELECT id, wave_tag FROM izza_crates "
            "WHERE wallet_pub = ? AND opened = 0 "
            "ORDER BY id ASC",
            (wallet_pub,)
        ).fetchall()

        # Also check if the wallet has any airdrop at all
        if AIRDROP_TAG:
            drop = conn.execute(
                "SELECT id FROM izza_airdrops WHERE wallet_pub = ? AND tag = ?",
                (wallet_pub, AIRDROP_TAG)
            ).fetchone()
        else:
            drop = conn.execute(
                "SELECT id FROM izza_airdrops WHERE wallet_pub = ? LIMIT 1",
                (wallet_pub,)
            ).fetchone()

    if not drop:
        return jsonify({
            "ok": True,
            "wallet_pub": wallet_pub,
            "crates": [],
            "message": "This Pi Testnet wallet has no IZZA airdrop for this campaign."
        })

    message = (
        "Tap your IZZA loot crate to reveal your reward."
        if crates else "This wallet received an IZZA airdrop, crate already opened."
    )

    return jsonify({
        "ok": True,
        "wallet_pub": wallet_pub,
        "crates": [{"id": r[0], "wave_tag": r[1]} for r in crates],
        "message": message
    })

# -------------------------------------------------------------------
# OPEN CRATE, REAL IZZA PAYOUT
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

        if wallet_in and wallet_pub and wallet_in != wallet_pub:
            return jsonify({"ok": False, "error": "wallet_mismatch"}), 400

        if opened:
            return jsonify({"ok": False, "error": "crate_already_opened"}), 400

        amount, rarity = roll_reward()

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
        conn.commit()

    return jsonify({
        "ok": True,
        "crate_id": crate_id,
        "reward_amount": amount,
        "rarity": rarity
    })
