import os
import time
import random
import sqlite3
import logging
from decimal import Decimal

from flask import Blueprint, render_template, request, jsonify

from stellar_sdk import Server, Keypair, Asset, TransactionBuilder
from stellar_sdk.exceptions import NotFoundError

izza_airdrop_bp = Blueprint("izza_airdrop", __name__)
log = logging.getLogger("izza_airdrop")

# -------------------------------------------------------------------
# DB LOCATION
# -------------------------------------------------------------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DISK_ROOT = os.getenv("DISK_ROOT", "/var/data")

try:
    os.makedirs(DISK_ROOT, exist_ok=True)
    db_dir = DISK_ROOT
except:
    db_dir = BASE_DIR

AIRDROP_DB = os.path.join(db_dir, "izza_airdrops.db")


def cx():
    return sqlite3.connect(AIRDROP_DB)


# -------------------------------------------------------------------
# STELLAR + IZZA TOKEN CONFIG
# -------------------------------------------------------------------
HORIZON = os.getenv("HORIZON_URL", "https://api.testnet.minepi.com")
NETWORK = os.getenv("NETWORK_PASSPHRASE", "Pi Testnet")

ASSET_CODE = os.getenv("ASSET_CODE", "IZZA")
ISSUER_PUB = os.getenv("ISSUER_PUB")
DISTR_PUB = os.getenv("DISTR_PUB")
DISTR_SECRET = os.getenv("DISTR_SECRET")

server = Server(HORIZON)
asset_izza = Asset(ASSET_CODE, ISSUER_PUB)
dist_kp = Keypair.from_secret(DISTR_SECRET)


# -------------------------------------------------------------------
# INIT TABLES
# -------------------------------------------------------------------
def init_tables():
    with cx() as conn:
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
    roll = random.randint(1,100)
    if roll <= 70:
        return 5, "common"
    elif roll <= 90:
        return 10, "uncommon"
    elif roll <= 99:
        return 18, "rare"
    else:
        return 25, "legendary"


# -------------------------------------------------------------------
# PAGE
# -------------------------------------------------------------------
@izza_airdrop_bp.route("/izza-airdrop")
def izza_airdrop_page():
    return render_template(
        "izza_airdrop.html",
        PI_APP_ID=os.getenv("PI_APP_ID",""),
        PI_SANDBOX="true" if os.getenv("PI_SANDBOX","true")=="true" else "false"
    )


# -------------------------------------------------------------------
# PROFILE ENDPOINT
# -------------------------------------------------------------------
@izza_airdrop_bp.get("/api/izza_airdrop/profile")
def api_profile():
    username = request.args.get("username")
    if not username:
        return jsonify({"ok":False,"message":"No username"}),400

    with cx() as conn:
        crates = conn.execute(
            "SELECT id,wave_tag FROM izza_crates WHERE username=? AND opened=0 ORDER BY id ASC",
            (username,)
        ).fetchall()

    return jsonify({
        "ok":True,
        "username":username,
        "crates":[{"id":r[0],"wave_tag":r[1]} for r in crates],
        "message":"Tap your IZZA loot crate to reveal your reward."
    })


# -------------------------------------------------------------------
# OPEN CRATE (REAL IZZA PAYOUT)
# -------------------------------------------------------------------
@izza_airdrop_bp.post("/api/izza_airdrop/open")
def api_open():
    data = request.get_json(force=True) or {}
    username = data.get("username")
    crate_id = data.get("crate_id")

    if not username:
        return jsonify({"ok":False,"error":"missing_username"}),400
    if not crate_id:
        return jsonify({"ok":False,"error":"missing_crate_id"}),400

    with cx() as conn:
        row = conn.execute(
            "SELECT id,opened,wallet_pub FROM izza_crates WHERE id=? AND username=?",
            (crate_id,username)
        ).fetchone()

        if not row:
            return jsonify({"ok":False,"error":"crate_not_found"}),400

        _id, opened, wallet_pub = row
        if opened:
            return jsonify({"ok":False,"error":"crate_already_opened"}),400

        # roll reward
        amount, rarity = roll_reward()

        # pay it
        ok, info = send_izza_tokens(wallet_pub, amount)
        if not ok:
            return jsonify({"ok":False,"error":info}),400

        now = int(time.time())
        conn.execute(
            "UPDATE izza_crates SET opened=1,opened_ts=?,reward_amount=?,rarity=? WHERE id=?",
            (now, str(amount), rarity, crate_id)
        )

    return jsonify({
        "ok":True,
        "crate_id":crate_id,
        "reward_amount":amount,
        "rarity":rarity
    })
