# izza_airdrop.py

import os
import time
import random
import logging
from decimal import Decimal

from flask import Blueprint, render_template, request, jsonify

import db as app_db  # your main app DB module

log = logging.getLogger(__name__)

izza_airdrop_bp = Blueprint("izza_airdrop", __name__)


# -------------------------------------------------------------------
# DB helpers – use SAME DB as rest of app, and same izza_airdrops
# table the airdrop script writes into.
# -------------------------------------------------------------------

def init_airdrop_table():
    """
    Ensure izza_airdrops exists and has a claimed_at column.
    This matches what your airdrop script uses, with an extra
    claimed_at for loot crate redemption.
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
              claimed_at INTEGER,
              UNIQUE(wallet_pub, tag)
            );
            """
        )
        # If table already existed without claimed_at, this safely no-ops
        try:
            cx.execute("ALTER TABLE izza_airdrops ADD COLUMN claimed_at INTEGER")
        except Exception:
            pass


def get_unopened_crates_for_wallet(wallet_pub: str):
    """
    Treat each unclaimed izza_airdrops row as 1 IZZA loot crate.
    """
    if not wallet_pub:
        return []

    with app_db.conn() as cx:
        rows = cx.execute(
            """
            SELECT id, tag, created_at, amount
            FROM izza_airdrops
            WHERE wallet_pub = ?
              AND (claimed_at IS NULL OR claimed_at = 0)
            ORDER BY created_at ASC, id ASC
            """,
            (wallet_pub,),
        ).fetchall()

    crates = []
    for r in rows:
        crates.append(
            {
                "id": r["id"],
                "wave_tag": r["tag"] or "",
                "created_ts": r["created_at"] or 0,
                "amount": r["amount"] or "0",
            }
        )
    return crates


def open_crate_for_wallet(wallet_pub: str, crate_id: int):
    """
    Mark the crate (izza_airdrops row) as claimed and return
    a random reward payload. The actual on-chain payout can be
    wired using wallet_pub and reward_amount.
    """
    if not wallet_pub:
        raise ValueError("missing_wallet_pub")

    with app_db.conn() as cx:
        row = cx.execute(
            """
            SELECT id, wallet_pub, tag, amount, created_at, claimed_at
            FROM izza_airdrops
            WHERE id = ?
              AND wallet_pub = ?
            """,
            (crate_id, wallet_pub),
        ).fetchone()

        if not row:
            raise ValueError("crate_not_found")

        if row["claimed_at"]:
            raise ValueError("crate_already_opened")

        now_ts = int(time.time())

        # Mark as claimed
        cx.execute(
            "UPDATE izza_airdrops SET claimed_at = ? WHERE id = ?",
            (now_ts, crate_id),
        )

    # Random reward between 5 and 25 IZZA (whole tokens for now)
    reward_amount_int = random.randint(5, 25)
    reward_amount = Decimal(reward_amount_int)

    # TODO: wire this into your existing IZZA payment logic:
    #   send reward_amount IZZA from distributor to wallet_pub
    # For now, we just return the payload; you already have
    # code elsewhere that knows how to submit payments.

    reward = {
        "type": "IZZA",
        "amount": str(reward_amount),  # "5", "12", etc
        "label": f"{reward_amount_int} IZZA",
        "wallet_pub": wallet_pub,
    }
    rarity = "common"  # you can evolve this later

    return {
        "crate_id": crate_id,
        "wallet_pub": wallet_pub,
        "reward": reward,
        "rarity": rarity,
    }


# Initialise table on import
init_airdrop_table()


# -------------------------------------------------------------------
# Routes
# -------------------------------------------------------------------

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
    Front end calls this after Pi auth with username + wallet_pub.
    We ONLY trust wallet_pub for airdrop eligibility.
    """
    username = (request.args.get("username") or "").strip()
    wallet_pub = (request.args.get("wallet_pub") or "").strip()

    # Guest view – no wallet, no crates.
    if not wallet_pub:
        return jsonify(
            {
                "ok": True,
                "username": username or "guest",
                "wallet_pub": None,
                "has_airdrop": False,
                "crates": [],
                "message": (
                    "Sign in with Pi so we can read your Pi Testnet wallet "
                    "and check for IZZA airdrops."
                ),
            }
        )

    crates = get_unopened_crates_for_wallet(wallet_pub)
    has_airdrop = len(crates) > 0

    if has_airdrop:
        msg = (
            "Your Pi Testnet wallet has IZZA airdrops recorded. "
            "Tap a loot crate to reveal your reward."
        )
    else:
        msg = (
            "No unopened IZZA loot crates detected for this Pi Testnet wallet yet. "
            "Make sure you have the IZZA Testnet token added in your Pi Testnet Wallet, "
            "then watch for future airdrops."
        )

    return jsonify(
        {
            "ok": True,
            "username": username or "guest",
            "wallet_pub": wallet_pub,
            "has_airdrop": has_airdrop,
            "crates": [
                {
                    "id": c["id"],
                    "wave_tag": c["wave_tag"],
                    "created_ts": c["created_ts"],
                }
                for c in crates
            ],
            "message": msg,
        }
    )


@izza_airdrop_bp.post("/api/izza_airdrop/open")
def api_izza_airdrop_open():
    data = request.get_json(force=True) or {}
    username = (data.get("username") or "").strip()
    wallet_pub = (data.get("wallet_pub") or "").strip()
    crate_id = data.get("crate_id")

    if not wallet_pub:
        return jsonify({"ok": False, "error": "missing_wallet_pub"}), 400

    if not crate_id:
        return jsonify({"ok": False, "error": "missing_crate_id"}), 400

    try:
        crate_id_int = int(crate_id)
    except Exception:
        return jsonify({"ok": False, "error": "invalid_crate_id"}), 400

    try:
        result = open_crate_for_wallet(wallet_pub, crate_id_int)
        # You can log username for analytics, but wallet_pub is the source of truth.
        log.info(
            "IZZA loot crate opened user=%s wallet=%s crate_id=%s reward=%s",
            username or "unknown",
            wallet_pub,
            crate_id_int,
            result.get("reward"),
        )
        return jsonify({"ok": True, **result})
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    except Exception as e:
        log.exception(
            "Error opening IZZA loot crate username=%s wallet=%s crate_id=%s",
            username,
            wallet_pub,
            crate_id_int,
        )
        return jsonify({"ok": False, "error": "server_error"}), 500
