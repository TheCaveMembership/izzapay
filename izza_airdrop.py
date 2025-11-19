# izza_airdrop.py

import os
import time
import sqlite3
import logging
from flask import Blueprint, render_template, request, jsonify
from decimal import Decimal

log = logging.getLogger(__name__)

izza_airdrop_bp = Blueprint("izza_airdrop", __name__)

# Use same disk strategy as the rest of your app
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DISK_ROOT = os.getenv("DISK_ROOT", "/var/data")

try:
    os.makedirs(DISK_ROOT, exist_ok=True)
    db_dir = DISK_ROOT
except Exception as e:
    db_dir = BASE_DIR
    log.warning("Could not use DISK_ROOT %s, using BASE_DIR. err=%s", DISK_ROOT, e)

AIRDROP_DB_PATH = os.path.join(db_dir, "izza_airdrops.db")
log.info("Using IZZA airdrop DB at %s", AIRDROP_DB_PATH)


def _get_conn():
    return sqlite3.connect(AIRDROP_DB_PATH)


def init_airdrop_db():
    conn = _get_conn()
    cur = conn.cursor()
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS izza_airdrop_crates (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            username    TEXT NOT NULL,
            wave_tag    TEXT NOT NULL,   -- for example '2025-11-19-weekly-1'
            opened      INTEGER NOT NULL DEFAULT 0,
            created_ts  INTEGER NOT NULL,
            opened_ts   INTEGER
        )
        """
    )
    conn.commit()
    conn.close()


init_airdrop_db()


def get_unopened_crates(username: str):
    conn = _get_conn()
    cur = conn.cursor()
    cur.execute(
        "SELECT id, wave_tag, created_ts FROM izza_airdrop_crates "
        "WHERE username = ? AND opened = 0 ORDER BY created_ts ASC",
        (username,),
    )
    rows = cur.fetchall()
    conn.close()
    return [
        {"id": r[0], "wave_tag": r[1], "created_ts": r[2]}
        for r in rows
    ]


def open_crate(username: str, crate_id: int):
    """
    Marks crate as opened, returns a simple reward payload.
    Right now reward is just cosmetic text and maybe a small
    off chain number you can evolve later.
    """
    conn = _get_conn()
    cur = conn.cursor()

    cur.execute(
        "SELECT id, opened, wave_tag, created_ts FROM izza_airdrop_crates "
        "WHERE id = ? AND username = ?",
        (crate_id, username),
    )
    row = cur.fetchone()
    if not row:
        conn.close()
        raise ValueError("crate_not_found")
    if row[1]:
        conn.close()
        raise ValueError("crate_already_opened")

    now = int(time.time())
    cur.execute(
        "UPDATE izza_airdrop_crates SET opened = 1, opened_ts = ? WHERE id = ?",
        (now, crate_id),
    )
    conn.commit()
    conn.close()

    # Simple reward logic for now, you can wire this into staking, IZZA NFT, whatever later
    # You can also make this depend on wave_tag or random rolls
    reward = {
        "type": "izza_bonus",
        "amount": 1,
        "label": "1 IZZA Loot Point"
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
    # Pass through PI_APP_ID and sandbox the same way you do elsewhere
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

    crates = get_unopened_crates(username)
    has_airdrop = len(crates) > 0

    if has_airdrop:
        msg = "You have IZZA loot crates waiting, tap a crate to open it."
    else:
        msg = (
            "No IZZA loot crates detected yet, "
            "open your Pi Testnet Wallet, add the IZZA Testnet token in the token list, "
            "and you will start receiving weekly IZZA airdrops."
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
        return jsonify({"ok": False, "error": str(e)}), 400
    except Exception as e:
        log.exception("Error opening IZZA loot crate user=%s crate_id=%s", username, crate_id_int)
        return jsonify({"ok": False, "error": "server_error"}), 500
