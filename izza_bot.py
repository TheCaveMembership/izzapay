import time
import json
import requests

from flask import Blueprint, render_template, jsonify, request
from db import conn
from variables import apikey  # Pi Platform API key

izza_bot_bp = Blueprint("izza_bot", __name__)

# ---------------------------------------------------------
# HARD-CODED TESTNET TRADING-BOT DEPOSIT ACCOUNT
# (Users send TEST PI here)
# ---------------------------------------------------------
TRADING_BOT_TESTNET_DEPOSIT = "GAIXMJ22FKXXGDPQMZWR3GL24PM5UEPUCFNK4FSMJOZ3HTGPXSEQZ5AF"

# Always force Pi SDK sandbox for the bot
BOT_PI_SANDBOX = "true"

# Pi Platform API base
PI_PLATFORM_API_BASE = "https://api.minepi.com/v2"
PI_API_KEY = apikey


def _now() -> int:
    return int(time.time())


def _pi_headers():
    return {
        "Authorization": f"Key {PI_API_KEY}",
        "Content-Type": "application/json",
    }


def _pi_get_payment(payment_id: str) -> dict:
    r = requests.get(
        f"{PI_PLATFORM_API_BASE}/payments/{payment_id}",
        headers=_pi_headers(),
        timeout=15,
    )
    r.raise_for_status()
    return r.json()


def _pi_approve_payment(payment_id: str) -> dict:
    r = requests.post(
        f"{PI_PLATFORM_API_BASE}/payments/{payment_id}/approve",
        headers=_pi_headers(),
        timeout=15,
    )
    r.raise_for_status()
    return r.json()


def _pi_complete_payment(payment_id: str, txid: str) -> dict:
    r = requests.post(
        f"{PI_PLATFORM_API_BASE}/payments/{payment_id}/complete",
        headers=_pi_headers(),
        json={"txid": txid},
        timeout=15,
    )
    r.raise_for_status()
    return r.json()


def _get_or_create_bot_account(username: str, wallet_pub: str | None = None) -> int:
    """
    Ensure there is a bot_accounts row for this username.
    wallet_pub is optional here; we can learn it later from PaymentDTO.
    Returns account_id.
    """
    if not username:
        raise ValueError("username required")

    wallet_pub = wallet_pub or ""
    ts = _now()

    with conn() as cx:
        row = cx.execute(
            "SELECT id, wallet_pub FROM bot_accounts WHERE username = ?",
            (username,),
        ).fetchone()

        if row:
            acct_id = row["id"]
            existing_pub = row["wallet_pub"] or ""
            if wallet_pub and existing_pub != wallet_pub:
                cx.execute(
                    "UPDATE bot_accounts SET wallet_pub = ?, updated_at = ? WHERE id = ?",
                    (wallet_pub, ts, acct_id),
                )
            return acct_id

        cur = cx.execute(
            """
            INSERT INTO bot_accounts (username, wallet_pub, created_at, updated_at)
            VALUES (?, ?, ?, ?)
            """,
            (username, wallet_pub, ts, ts),
        )
        return cur.lastrowid


def _upsert_default_bucket(
    account_id: int,
    name: str,
    objective: str,
    risk_level: str,
    volatility: str,
    time_horizon_days: int,
    target_value_back: float,
) -> int:
    """
    For now we treat everything as a single 'default' bucket per account.
    """
    ts = _now()
    with conn() as cx:
        row = cx.execute(
            """
            SELECT id FROM bot_buckets
            WHERE account_id = ? AND name = ?
            """,
            (account_id, name),
        ).fetchone()

        if row:
            bucket_id = row["id"]
            cx.execute(
                """
                UPDATE bot_buckets
                   SET objective = ?,
                       risk_level = ?,
                       volatility = ?,
                       time_horizon_days = ?,
                       target_value_back = ?,
                       status = 'active',
                       updated_at = ?
                 WHERE id = ?
                """,
                (
                    objective,
                    risk_level,
                    volatility,
                    time_horizon_days,
                    target_value_back,
                    ts,
                    bucket_id,
                ),
            )
            return bucket_id

        cur = cx.execute(
            """
            INSERT INTO bot_buckets (
                account_id, name, objective, risk_level, volatility,
                time_horizon_days, target_value_back, status,
                created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
            """,
            (
                account_id,
                name,
                objective,
                risk_level,
                volatility,
                time_horizon_days,
                target_value_back,
                ts,
                ts,
            ),
        )
        return cur.lastrowid


def _validate_profile(
    time_horizon_days: int,
    risk_level: str,
    objective: str,
    volatility: str,
):
    """
    Enforce simple logical rules so combinations make sense.
    Returns (ok: bool, error_message_or_None).
    """
    if time_horizon_days is None or time_horizon_days <= 0:
        return False, "Time horizon must be at least 1 day."

    risk_level = (risk_level or "").lower()
    objective = (objective or "").lower()
    volatility = (volatility or "").lower()

    if risk_level not in ("low", "medium", "high"):
        return False, "Risk level must be low, medium, or high."

    if volatility not in ("low", "medium", "high"):
        return False, "Volatility preference must be low, medium, or high."

    # Short-term + low volatility + max growth is unrealistic
    if time_horizon_days <= 3 and objective == "max_growth" and volatility == "low":
        return False, (
            "Short-term, low-volatility cannot target maximum growth. "
            "Increase your time horizon or allow more volatility."
        )

    # Low risk but high volatility makes no sense
    if risk_level == "low" and volatility == "high":
        return False, (
            "Low risk with high volatility is not supported. "
            "Either raise your risk level or lower volatility."
        )

    # Low risk but objective is 'max_growth'
    if risk_level == "low" and objective == "max_growth":
        return False, (
            "Maximum growth objectives require at least medium risk. "
            "Increase your risk level or pick a balanced objective."
        )

    return True, None


@izza_bot_bp.route("/bot", methods=["GET"])
def bot_home():
    """
    Serves the IZZA BOT page.
    Always sandbox=true.
    Always uses TESTNET deposit address.
    """
    return render_template(
        "bot.html",
        TRADER_DEPOSIT_PUB=TRADING_BOT_TESTNET_DEPOSIT,
        PI_SANDBOX=BOT_PI_SANDBOX,
        PI_APP_ID="",  # bot does not require mainnet app id here
    )


# ----------------------------------------------------------------------
# Save default trading config (bucket profile)
# ----------------------------------------------------------------------
@izza_bot_bp.route("/api/trading/config", methods=["POST"])
def save_trading_config():
    """
    Save the user's 'default' trading bucket profile.

    Front-end JSON:
      {
        "username": "CamMac",
        "risk_level": "medium",
        "time_horizon_days": 10,
        "target_value_back": 0.85,
        "objective": "balanced",   # optional
        "volatility": "medium"     # optional
      }
    """
    data = request.get_json() or {}

    username          = (data.get("username") or "").strip()
    risk_level        = (data.get("risk_level") or "medium").lower()
    horizon_days      = data.get("time_horizon_days") or 10
    target_value_back = float(data.get("target_value_back") or 0.85)
    objective         = (data.get("objective") or "balanced").lower()
    volatility        = (data.get("volatility") or risk_level).lower()

    if not username:
        return jsonify(ok=False, error="Missing username from request.")

    try:
        horizon_days = int(horizon_days)
    except Exception:
        return jsonify(ok=False, error="Time horizon must be an integer number of days.")

    ok, msg = _validate_profile(horizon_days, risk_level, objective, volatility)
    if not ok:
        return jsonify(ok=False, error=msg)

    try:
        # wallet_pub is learned later from payments; we only key by username here
        account_id = _get_or_create_bot_account(username, wallet_pub=None)
        bucket_id = _upsert_default_bucket(
            account_id=account_id,
            name="Default Bot Bucket",
            objective=objective,
            risk_level=risk_level,
            volatility=volatility,
            time_horizon_days=horizon_days,
            target_value_back=target_value_back,
        )
    except Exception as e:
        return jsonify(ok=False, error=f"Database error saving settings: {e}")

    return jsonify(
        ok=True,
        bucket_id=bucket_id,
        profile={
            "username": username,
            "risk_level": risk_level,
            "time_horizon_days": horizon_days,
            "target_value_back": target_value_back,
            "objective": objective,
            "volatility": volatility,
        },
    )


# ----------------------------------------------------------------------
# Deposit flow (Pi payments → bot_deposits)
# ----------------------------------------------------------------------
@izza_bot_bp.route("/api/trading/deposit/approve", methods=["POST"])
def approve_bot_deposit():
    """
    Called from Pi JS onReadyForServerApproval(paymentId).

    We:
      - fetch the PaymentDTO
      - verify it's a user_to_app testnet payment to the bot account
      - approve it via Pi Platform API
    """
    data = request.get_json() or {}
    payment_id = (data.get("paymentId") or "").strip()
    if not payment_id:
        return jsonify(ok=False, error="paymentId missing")

    try:
        payment = _pi_get_payment(payment_id)
    except Exception as e:
        return jsonify(ok=False, error=f"Error fetching payment: {e}")

    try:
        to_addr = payment.get("to_address") or payment.get("to") or ""
        direction = payment.get("direction") or ""
        metadata = payment.get("metadata") or {}
        kind = metadata.get("kind")

        if direction != "user_to_app":
            return jsonify(ok=False, error="Payment must be user_to_app.")
        if TRADING_BOT_TESTNET_DEPOSIT and to_addr != TRADING_BOT_TESTNET_DEPOSIT:
            return jsonify(ok=False, error="Payment is not to IZZA BOT deposit account.")
        if kind != "bot_deposit":
            return jsonify(ok=False, error="Payment metadata.kind must be 'bot_deposit'.")
    except Exception as e:
        return jsonify(ok=False, error=f"Invalid payment structure: {e}")

    try:
        _pi_approve_payment(payment_id)
    except Exception as e:
        return jsonify(ok=False, error=f"Error approving payment: {e}")

    return jsonify(ok=True)


@izza_bot_bp.route("/api/trading/deposit/complete", methods=["POST"])
def complete_bot_deposit():
    """
    Called from Pi JS onReadyForServerCompletion(paymentId, txid).

    We:
      - fetch PaymentDTO again
      - complete it in Pi Platform API
      - read username, wallet pub, amount
      - create/update bot_account
      - insert bot_deposits row and bump total_deposited
    """
    data = request.get_json() or {}
    payment_id = (data.get("paymentId") or "").strip()
    txid = (data.get("txid") or "").strip()

    if not payment_id:
        return jsonify(ok=False, error="paymentId missing")
    if not txid:
        return jsonify(ok=False, error="txid missing")

    try:
        payment = _pi_get_payment(payment_id)
    except Exception as e:
        return jsonify(ok=False, error=f"Error fetching payment: {e}")

    try:
        to_addr = payment.get("to_address") or payment.get("to") or ""
        direction = payment.get("direction") or ""
        metadata = payment.get("metadata") or {}
        kind = metadata.get("kind")

        if direction != "user_to_app":
            return jsonify(ok=False, error="Payment must be user_to_app.")
        if TRADING_BOT_TESTNET_DEPOSIT and to_addr != TRADING_BOT_TESTNET_DEPOSIT:
            return jsonify(ok=False, error="Payment is not to IZZA BOT deposit account.")
        if kind != "bot_deposit":
            return jsonify(ok=False, error="Payment metadata.kind must be 'bot_deposit'.")
    except Exception as e:
        return jsonify(ok=False, error=f"Invalid payment structure: {e}")

    # Complete in Pi Platform
    try:
        _pi_complete_payment(payment_id, txid)
    except Exception as e:
        return jsonify(ok=False, error=f"Error completing payment: {e}")

    # Extract core info
    user_info = payment.get("user") or {}
    username = user_info.get("username") or ""
    amount = float(payment.get("amount") or 0)

    # Try to extract wallet pub from transaction info if Pi exposes it
    tx_info = (
        payment.get("transaction")
        or payment.get("blockchain_transaction")
        or {}
    )
    wallet_pub = (
        tx_info.get("source_account")
        or tx_info.get("from_address")
        or tx_info.get("from")
        or ""
    )

    if not username:
        return jsonify(ok=False, error="Payment does not include username.")

    ts = _now()

    try:
        # Create / update bot account
        account_id = _get_or_create_bot_account(username, wallet_pub or None)

        with conn() as cx:
            # Avoid double-crediting if complete endpoint called twice
            existing = cx.execute(
                "SELECT id FROM bot_deposits WHERE tx_hash = ?",
                (payment_id,),
            ).fetchone()
            if not existing:
                cx.execute(
                    """
                    INSERT INTO bot_deposits (
                      account_id, tx_hash, amount, asset_code,
                      asset_issuer, status, created_at, raw_json
                    )
                    VALUES (?, ?, ?, ?, ?, 'confirmed', ?, ?)
                    """,
                    (
                        account_id,
                        payment_id,
                        amount,
                        "PI",
                        None,
                        ts,
                        json.dumps(payment),
                    ),
                )

                cx.execute(
                    """
                    UPDATE bot_accounts
                       SET total_deposited = total_deposited + ?,
                           updated_at = ?
                     WHERE id = ?
                    """,
                    (amount, ts, account_id),
                )
    except Exception as e:
        return jsonify(ok=False, error=f"Database error crediting deposit: {e}")

    return jsonify(ok=True, amount=amount)


# ----------------------------------------------------------------------
# Helper: list buckets for future portfolio page
# ----------------------------------------------------------------------
@izza_bot_bp.route("/api/trading/buckets", methods=["GET"])
def list_buckets():
    """
    GET /api/trading/buckets?username=...

    Returns all buckets for that IZZA BOT account (keyed by username).
    """
    username = (request.args.get("username") or "").strip()
    if not username:
        return jsonify(ok=False, error="username is required")

    with conn() as cx:
        acct = cx.execute(
            "SELECT id FROM bot_accounts WHERE username = ?",
            (username,),
        ).fetchone()
        if not acct:
            return jsonify(ok=True, buckets=[])

        rows = cx.execute(
            """
            SELECT id, name, objective, risk_level, volatility,
                   time_horizon_days, target_value_back, status,
                   created_at, updated_at
              FROM bot_buckets
             WHERE account_id = ?
             ORDER BY id ASC
            """,
            (acct["id"],),
        ).fetchall()

    buckets = [dict(r) for r in rows]
    return jsonify(ok=True, buckets=buckets)
