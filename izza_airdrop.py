# izza_airdrop.py

import os
import time
import logging
import random
from decimal import Decimal

from flask import Blueprint, render_template, request, jsonify

from stellar_sdk import Server, Keypair, TransactionBuilder, Asset
from stellar_sdk.exceptions import NotFoundError

import db as app_db

log = logging.getLogger(__name__)

izza_airdrop_bp = Blueprint("izza_airdrop", __name__)

# ====== ENV / HORIZON CONFIG (reuse same env as your IZZA scripts) ======

HORIZON_URL        = os.getenv("HORIZON_URL", "")
NETWORK_PASSPHRASE = os.getenv("NETWORK_PASSPHRASE", "")
ASSET_CODE         = os.getenv("ASSET_CODE", "IZZA")
ISSUER_PUB         = os.getenv("ISSUER_PUB", "")
DISTR_PUB          = os.getenv("DISTR_PUB", "")
DISTR_SECRET       = os.getenv("DISTR_SECRET", "")

# If any of these are missing, on-chain payouts will fail – we log but don't crash import
if not all([HORIZON_URL, NETWORK_PASSPHRASE, ISSUER_PUB, DISTR_PUB, DISTR_SECRET]):
    log.warning("IZZA airdrop payout env vars incomplete; crate rewards will not send on-chain.")

_server = Server(HORIZON_URL) if HORIZON_URL else None
_asset  = Asset(ASSET_CODE, ISSUER_PUB) if ISSUER_PUB else None


def _get_base_fee() -> int:
    try:
        if not _server:
            return 100_000
        suggested = _server.fetch_base_fee()
    except Exception:
        suggested = 100
    return max(int(suggested * 20), 10_000)


def _ensure_airdrop_tables():
    """
    Ensure izza_airdrops + izza_airdrop_claims exist in the main app DB.

    izza_airdrops is also created by your CLI script; schema must match.
    """
    with app_db.conn() as cx:
        cx.execute(
            """
            CREATE TABLE IF NOT EXISTS izza_airdrops(
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              wallet_pub TEXT NOT NULL,
              tag TEXT,
              amount TEXT,
              tx_hash TEXT,
              created_at INTEGER,
              UNIQUE(wallet_pub, tag)
            );
            """
        )
        cx.execute(
            """
            CREATE TABLE IF NOT EXISTS izza_airdrop_claims(
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              airdrop_id INTEGER NOT NULL,
              username   TEXT NOT NULL,
              reward_amount   TEXT,
              reward_tx_hash  TEXT,
              opened_ts INTEGER NOT NULL,
              UNIQUE(airdrop_id, username)
            );
            """
        )


_ensure_airdrop_tables()


def _lookup_wallet_for_username(username: str):
    """
    Map Pi username -> IZZA wallet pubkey via user_wallets table.
    """
    if not username:
        return None
    with app_db.conn() as cx:
        row = cx.execute(
            "SELECT pub FROM user_wallets WHERE username = ?",
            (username,),
        ).fetchone()
        if not row:
            return None
        return row["pub"] if isinstance(row, dict) or hasattr(row, "keys") else row[0]


def get_unopened_crates(username: str):
    """
    Unopened crates = izza_airdrops rows for that wallet_pub
    that do not yet have a claim by this username.
    """
    wallet_pub = _lookup_wallet_for_username(username)
    if not wallet_pub:
        return []

    with app_db.conn() as cx:
        rows = cx.execute(
            """
            SELECT a.id, a.tag, a.created_at
            FROM izza_airdrops a
            LEFT JOIN izza_airdrop_claims c
              ON c.airdrop_id = a.id
             AND c.username   = ?
            WHERE a.wallet_pub = ?
              AND c.id IS NULL
            ORDER BY a.created_at ASC;
            """,
            (username, wallet_pub),
        ).fetchall()

    crates = []
    for r in rows:
        tag = r["tag"] if hasattr(r, "keys") else r[1]
        created_ts = r["created_at"] if hasattr(r, "keys") else r[2]
        crates.append(
            {
                "id": r["id"] if hasattr(r, "keys") else r[0],
                "wave_tag": tag or "IZZA wave",
                "created_ts": created_ts,
            }
        )
    return crates


def _send_izza_reward(wallet_pub: str, amount_izza: str) -> str:
    """
    Send IZZA from DISTR_PUB to wallet_pub on Pi Testnet.

    Returns tx hash if successful, raises on failure.
    """
    if not all([_server, _asset, NETWORK_PASSPHRASE, DISTR_SECRET]):
        raise RuntimeError("izza_payout_env_incomplete")

    distr_kp = Keypair.from_secret(DISTR_SECRET)
    distr_acct = _server.load_account(distr_kp.public_key)
    base_fee = _get_base_fee()

    amt_dec = Decimal(amount_izza)
    if amt_dec <= 0:
        raise ValueError("reward_amount_invalid")

    tx = (
        TransactionBuilder(
            source_account=distr_acct,
            network_passphrase=NETWORK_PASSPHRASE,
            base_fee=base_fee,
        )
        .append_payment_op(
            destination=wallet_pub,
            amount=str(amt_dec),
            asset=_asset,
        )
        .set_timeout(180)
        .build()
    )
    tx.sign(distr_kp)
    resp = _server.submit_transaction(tx)
    tx_hash = resp.get("hash")
    log.info("IZZA loot crate payout sent wallet=%s amount=%s hash=%s", wallet_pub, amt_dec, tx_hash)
    return tx_hash or ""


def open_crate(username: str, crate_id: int):
    """
    Verify crate belongs to username's IZZA wallet, mark claimed,
    send 5–25 IZZA, and return reward payload.
    """
    if not username:
        raise ValueError("invalid_username")

    wallet_pub = _lookup_wallet_for_username(username)
    if not wallet_pub:
        raise ValueError("wallet_not_linked")

    now_ts = int(time.time())

    # Pick random reward between 5 and 25 IZZA (whole tokens)
    reward_int = random.randint(5, 25)
    reward_dec = Decimal(reward_int)
    reward_str = f"{reward_dec:.7f}"  # 7 decimal places for Stellar-style assets

    # First, claim this crate atomically in DB (so it can't be double-opened)
    with app_db.conn() as cx:
        row = cx.execute(
            """
            SELECT a.id, a.wallet_pub, a.tag, a.amount, a.tx_hash, a.created_at
            FROM izza_airdrops a
            LEFT JOIN izza_airdrop_claims c
              ON c.airdrop_id = a.id
             AND c.username   = ?
            WHERE a.id = ?
              AND a.wallet_pub = ?
              AND c.id IS NULL
            """,
            (username, crate_id, wallet_pub),
        ).fetchone()

        if not row:
            # Either crate doesn't exist, wallet doesn't match,
            # or it has already been claimed.
            raise ValueError("crate_not_found_or_claimed")

        # Reserve this crate for this username
        cx.execute(
            """
            INSERT INTO izza_airdrop_claims(airdrop_id, username, reward_amount, opened_ts)
            VALUES (?,?,?,?)
            """,
            (crate_id, username, reward_str, now_ts),
        )

    # Now send on-chain reward
    try:
        tx_hash = _send_izza_reward(wallet_pub, reward_str)
    except Exception as e:
        log.exception("Error sending IZZA loot payout username=%s crate_id=%s", username, crate_id)
        # We already reserved the crate; we do NOT want to allow re-open,
        # but we can record failure in the claim record.
        tx_hash = ""

        with app_db.conn() as cx:
            cx.execute(
                """
                UPDATE izza_airdrop_claims
                   SET reward_tx_hash = ?
                 WHERE airdrop_id = ? AND username = ?
                """,
                (f"ERROR:{e}", crate_id, username),
            )
        raise

    # Update claim record with tx hash
    with app_db.conn() as cx:
        cx.execute(
            """
            UPDATE izza_airdrop_claims
               SET reward_tx_hash = ?
             WHERE airdrop_id = ? AND username = ?
            """,
            (tx_hash, crate_id, username),
        )

    reward = {
        "type": "IZZA",
        "amount": str(reward_dec),
        "label": f"{reward_int} IZZA airdrop reward",
        "tx_hash": tx_hash,
    }
    rarity = "common"

    return {
        "crate_id": crate_id,
        "reward": reward,
        "rarity": rarity,
    }


@izza_airdrop_bp.route("/izza-airdrop")
def izza_airdrop_page():
    """
    Page that your IZZA AIRDROP button should link to.
    Only does Pi authentication on the front end.
    """
    PI_APP_ID = os.getenv("PI_APP_ID", "")
    PI_SANDBOX = os.getenv("PI_SANDBOX", "true").lower() == "true"

    return render_template(
        "izza_airdrop.html",
        PI_APP_ID=PI_APP_ID,
        PI_SANDBOX="true" if PI_SANDBOX else "false",
    )


@izza_airdrop_bp.get("/api/izza_airdrop/profile")
def api_izza_airdrop_profile():
    """
    Front end calls this after Pi auth with username.
    Returns any unopened crates for that user.
    """
    username = request.args.get("username") or "guest"

    if username == "guest":
        return jsonify({
            "ok": True,
            "username": username,
            "has_airdrop": False,
            "crates": [],
            "message": (
                "Sign in with Pi to see if you have IZZA loot crates."
            ),
        })

    wallet_pub = _lookup_wallet_for_username(username)
    if not wallet_pub:
        return jsonify({
            "ok": True,
            "username": username,
            "has_airdrop": False,
            "crates": [],
            "message": (
                "No IZZA wallet linked yet. "
                "Open IZZA, connect your IZZA Testnet wallet, then return here to redeem airdrops."
            ),
        })

    crates = get_unopened_crates(username)
    has_airdrop = len(crates) > 0

    if has_airdrop:
        msg = "You have IZZA loot crates waiting, tap a crate to open it."
    else:
        msg = (
            "No IZZA loot crates detected yet. "
            "Make sure the IZZA Testnet token is added in your Pi Wallet token list "
            "to receive future IZZA airdrops."
        )

    return jsonify({
        "ok": True,
        "username": username,
        "has_airdrop": has_airdrop,
        "crates": crates,
        "message": msg,
    })


@izza_airdrop_bp.post("/api/izza_airdrop/open")
def api_izza_airdrop_open():
    data = request.get_json(force=True) or {}
    username = data.get("username") or "guest"
    crate_id = data.get("crate_id")

    if username == "guest":
        return jsonify({"ok": False, "error": "guest_cannot_open"}), 400
    if not crate_id:
        return jsonify({"ok": False, "error": "missing_crate_id"}), 400

    try:
        crate_id_int = int(crate_id)
    except Exception:
        return jsonify({"ok": False, "error": "invalid_crate_id"}), 400

    try:
        result = open_crate(username, crate_id_int)
        return jsonify({"ok": True, **result})
    except ValueError as e:
        code = str(e)
        if code in ("wallet_not_linked", "crate_not_found_or_claimed", "invalid_username"):
            return jsonify({"ok": False, "error": code}), 400
        return jsonify({"ok": False, "error": code}), 400
    except RuntimeError as e:
        # Likely env / horizon / payout config issue
        log.exception("Runtime error while opening loot crate")
        return jsonify({"ok": False, "error": str(e)}), 500
    except Exception:
        log.exception("Error opening IZZA loot crate user=%s crate_id=%s", username, crate_id_int)
        return jsonify({"ok": False, "error": "server_error"}), 500
