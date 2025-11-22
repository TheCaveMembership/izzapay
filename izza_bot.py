import os
import time
import json
import requests

from flask import Blueprint, render_template, jsonify, request
from db import conn

# Pi Platform API key: prefer variables.apikey if module is present,
# otherwise fall back to environment variables so Render can boot.
try:
    from variables import apikey  # Pi Platform API key
except ModuleNotFoundError:
    apikey = (
        os.environ.get("APIKEY")
        or os.environ.get("PI_API_KEY")
        or ""
    )

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
    if not PI_API_KEY:
        # Hard fail if key missing so you notice it during testing
        raise RuntimeError("Pi Platform API key not configured (set APIKEY or PI_API_KEY)")
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
    For now we treat this as the 'Default Bot Bucket' per account.
    Other buckets will be created via _create_bucket().
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


def _create_bucket(
    account_id: int,
    name: str,
    objective: str,
    risk_level: str,
    volatility: str,
    time_horizon_days: int,
    target_value_back: float,
) -> int:
    """
    Always inserts a new bucket row for this account.
    """
    ts = _now()
    with conn() as cx:
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


# ----------------------------------------------------------------------
# PAGES
# ----------------------------------------------------------------------
@izza_bot_bp.route("/bot", methods=["GET"])
def bot_home():
    """
    Serves the IZZA BOT onboarding page.
    User sets their initial default profile and can make deposits.

    For repeat users, you can link them directly to /bot/profile from your home.
    """
    return render_template(
        "bot.html",
        TRADER_DEPOSIT_PUB=TRADING_BOT_TESTNET_DEPOSIT,
        PI_SANDBOX=BOT_PI_SANDBOX,
        PI_APP_ID="",  # bot does not require mainnet app id here
    )


@izza_bot_bp.route("/bot/profile", methods=["GET"])
def bot_profile_page():
    """
    Main profile page:
    - shows total deposited / available
    - lists buckets and allocations
    - allows new bucket creation and withdrawals
    """
    return render_template(
        "bot_profile.html",
        PI_SANDBOX=BOT_PI_SANDBOX,
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
# Bucket + balance summary for profile
# ----------------------------------------------------------------------
@izza_bot_bp.route("/api/trading/summary", methods=["GET"])
def trading_summary():
    """
    GET /api/trading/summary?username=...

    Returns:
      {
        ok: true,
        account: {
          total_deposited,
          total_withdrawn,
          net_deposit,
          wallet_pub,
          available_unallocated
        },
        buckets: [
          { id, name, risk_level, objective, volatility,
            time_horizon_days, target_value_back,
            allocation }
        ]
      }
    """
    username = (request.args.get("username") or "").strip()
    if not username:
        return jsonify(ok=False, error="username is required")

    with conn() as cx:
        acct = cx.execute(
            """
            SELECT id, username, wallet_pub,
                   total_deposited, total_withdrawn
              FROM bot_accounts
             WHERE username = ?
            """,
            (username,),
        ).fetchone()

        if not acct:
            # No account yet: empty state
            return jsonify(
                ok=True,
                account={
                  "username": username,
                  "wallet_pub": "",
                  "total_deposited": 0,
                  "total_withdrawn": 0,
                  "net_deposit": 0,
                  "available_unallocated": 0,
                },
                buckets=[],
            )

        account_id = acct["id"]
        total_deposited = float(acct["total_deposited"] or 0)
        total_withdrawn = float(acct["total_withdrawn"] or 0)
        net_deposit = total_deposited - total_withdrawn

        rows = cx.execute(
            """
            SELECT b.id, b.name, b.objective, b.risk_level, b.volatility,
                   b.time_horizon_days, b.target_value_back,
                   IFNULL(a.amount, 0) AS allocation
              FROM bot_buckets b
         LEFT JOIN bot_bucket_allocations a
                ON a.bucket_id = b.id
               AND a.account_id = b.account_id
             WHERE b.account_id = ?
             ORDER BY b.id ASC
            """,
            (account_id,),
        ).fetchall()

        buckets = []
        total_alloc = 0.0
        for r in rows:
            alloc = float(r["allocation"] or 0)
            total_alloc += alloc
            buckets.append({
                "id": r["id"],
                "name": r["name"],
                "objective": r["objective"],
                "risk_level": r["risk_level"],
                "volatility": r["volatility"],
                "time_horizon_days": r["time_horizon_days"],
                "target_value_back": r["target_value_back"],
                "allocation": alloc,
            })

        available_unallocated = max(0.0, net_deposit - total_alloc)

    return jsonify(
        ok=True,
        account={
            "username": acct["username"],
            "wallet_pub": acct["wallet_pub"],
            "total_deposited": total_deposited,
            "total_withdrawn": total_withdrawn,
            "net_deposit": net_deposit,
            "available_unallocated": available_unallocated,
        },
        buckets=buckets,
    )


# ----------------------------------------------------------------------
# Create additional buckets
# ----------------------------------------------------------------------
@izza_bot_bp.route("/api/trading/bucket/create", methods=["POST"])
def create_bucket():
    """
    POST JSON:
      {
        "username": "CamMac",
        "name": "High Risk YOLO",
        "risk_level": "high",
        "time_horizon_days": 7,
        "target_value_back": 0.7,
        "objective": "max_growth",
        "volatility": "high"
      }
    """
    data = request.get_json() or {}

    username          = (data.get("username") or "").strip()
    name              = (data.get("name") or "").strip()
    risk_level        = (data.get("risk_level") or "medium").lower()
    horizon_days      = data.get("time_horizon_days") or 10
    target_value_back = float(data.get("target_value_back") or 0.85)
    objective         = (data.get("objective") or "balanced").lower()
    volatility        = (data.get("volatility") or risk_level).lower()

    if not username:
        return jsonify(ok=False, error="Missing username from request.")
    if not name:
        return jsonify(ok=False, error="Bucket name is required.")

    try:
        horizon_days = int(horizon_days)
    except Exception:
        return jsonify(ok=False, error="Time horizon must be an integer number of days.")

    ok, msg = _validate_profile(horizon_days, risk_level, objective, volatility)
    if not ok:
        return jsonify(ok=False, error=msg)

    try:
        account_id = _get_or_create_bot_account(username, wallet_pub=None)
        bucket_id = _create_bucket(
            account_id=account_id,
            name=name,
            objective=objective,
            risk_level=risk_level,
            volatility=volatility,
            time_horizon_days=horizon_days,
            target_value_back=target_value_back,
        )
    except Exception as e:
        return jsonify(ok=False, error=f"Database error creating bucket: {e}")

    return jsonify(
        ok=True,
        bucket_id=bucket_id,
        bucket={
            "id": bucket_id,
            "name": name,
            "objective": objective,
            "risk_level": risk_level,
            "volatility": volatility,
            "time_horizon_days": horizon_days,
            "target_value_back": target_value_back,
            "allocation": 0.0,
        },
    )


# ----------------------------------------------------------------------
# Set allocation for a bucket
# ----------------------------------------------------------------------
@izza_bot_bp.route("/api/trading/allocation/set", methods=["POST"])
def set_bucket_allocation():
    """
    POST JSON:
      {
        "username": "CamMac",
        "bucket_id": 1,
        "amount": 50.0
      }

    We ensure total allocations across all buckets
    do not exceed net_deposit.
    """
    data = request.get_json() or {}
    username = (data.get("username") or "").strip()
    bucket_id = data.get("bucket_id")
    amount = data.get("amount")

    if not username:
        return jsonify(ok=False, error="username is required")
    if bucket_id is None:
        return jsonify(ok=False, error="bucket_id is required")
    try:
        bucket_id = int(bucket_id)
    except Exception:
        return jsonify(ok=False, error="bucket_id must be integer")

    try:
        amount = float(amount)
    except Exception:
        return jsonify(ok=False, error="amount must be numeric")
    if amount < 0:
        return jsonify(ok=False, error="amount cannot be negative")

    ts = _now()

    with conn() as cx:
        acct = cx.execute(
            "SELECT id, total_deposited, total_withdrawn FROM bot_accounts WHERE username = ?",
            (username,),
        ).fetchone()
        if not acct:
            return jsonify(ok=False, error="Bot account not found for user.")

        account_id = acct["id"]
        net_deposit = float(acct["total_deposited"] or 0) - float(acct["total_withdrawn"] or 0)

        bucket = cx.execute(
            "SELECT id, account_id FROM bot_buckets WHERE id = ?",
            (bucket_id,),
        ).fetchone()
        if not bucket or bucket["account_id"] != account_id:
            return jsonify(ok=False, error="Bucket not found for this user.")

        # Sum allocations for other buckets
        row = cx.execute(
            """
            SELECT IFNULL(SUM(amount), 0) AS total_other
              FROM bot_bucket_allocations
             WHERE account_id = ?
               AND bucket_id != ?
            """,
            (account_id, bucket_id),
        ).fetchone()
        total_other = float(row["total_other"] or 0)

        if total_other + amount > net_deposit + 1e-9:
            return jsonify(
                ok=False,
                error="Allocation exceeds your available net deposits. Reduce amount or free other buckets.",
            )

        # Upsert allocation
        existing = cx.execute(
            """
            SELECT id FROM bot_bucket_allocations
             WHERE account_id = ? AND bucket_id = ?
            """,
            (account_id, bucket_id),
        ).fetchone()

        if existing:
            cx.execute(
                """
                UPDATE bot_bucket_allocations
                   SET amount = ?, updated_at = ?
                 WHERE id = ?
                """,
                (amount, ts, existing["id"]),
            )
        else:
            cx.execute(
                """
                INSERT INTO bot_bucket_allocations (
                  account_id, bucket_id, amount, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?)
                """,
                (account_id, bucket_id, amount, ts, ts),
            )

    return jsonify(ok=True)


# ----------------------------------------------------------------------
# Withdrawal request (UI + record only for now)
# ----------------------------------------------------------------------
@izza_bot_bp.route("/api/trading/withdraw/request", methods=["POST"])
def request_withdraw():
    """
    User requests a withdrawal of unallocated funds.

    POST JSON:
      {
        "username": "CamMac",
        "amount": 20.0
      }

    We:
      - verify amount <= available_unallocated
      - insert bot_withdrawals row with status 'requested'
      - actual payout logic can be done later by a script that
        sends app_to_user payment from the bot account.
    """
    data = request.get_json() or {}
    username = (data.get("username") or "").strip()
    amount = data.get("amount")

    if not username:
        return jsonify(ok=False, error="username is required")
    try:
        amount = float(amount)
    except Exception:
        return jsonify(ok=False, error="amount must be numeric")
    if amount <= 0:
        return jsonify(ok=False, error="amount must be positive")

    ts = _now()

    with conn() as cx:
        acct = cx.execute(
            """
            SELECT id, wallet_pub, total_deposited, total_withdrawn
              FROM bot_accounts
             WHERE username = ?
            """,
            (username,),
        ).fetchone()
        if not acct:
            return jsonify(ok=False, error="Bot account not found for user.")

        account_id = acct["id"]
        net_deposit = float(acct["total_deposited"] or 0) - float(acct["total_withdrawn"] or 0)

        row = cx.execute(
            """
            SELECT IFNULL(SUM(amount), 0) AS total_alloc
              FROM bot_bucket_allocations
             WHERE account_id = ?
            """,
            (account_id,),
        ).fetchone()
        total_alloc = float(row["total_alloc"] or 0)
        available_unallocated = max(0.0, net_deposit - total_alloc)

        if amount > available_unallocated + 1e-9:
            return jsonify(
                ok=False,
                error="Requested amount exceeds your unallocated balance. Reduce bucket allocations first.",
            )

        cx.execute(
            """
            INSERT INTO bot_withdrawals (
              account_id, amount, status, dest_pub, created_at, txid, raw_json
            )
            VALUES (?, ?, 'requested', ?, ?, NULL, NULL)
            """,
            (account_id, amount, acct["wallet_pub"], ts),
        )

    return jsonify(
        ok=True,
        available_unallocated=available_unallocated - amount,
        note="Withdrawal request recorded. A Pi testnet payout script can send this amount later.",
    )


# ----------------------------------------------------------------------
# Helper: list buckets (still available)
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
