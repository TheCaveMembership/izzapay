import os
import time
import json
import requests

from flask import Blueprint, render_template, jsonify, request
from db import conn

# NEW: Horizon client for reading TESTNET balances
from stellar_sdk import Server

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
# (Users send TEST PI here)  -- NO LONGER USED FOR DEPOSITS
# ---------------------------------------------------------
TRADING_BOT_TESTNET_DEPOSIT = "GAIXMJ22FKXXGDPQMZWR3GL24PM5UEPUCFNK4FSMJOZ3HTGPXSEQZ5AF"

# Always force Pi SDK sandbox for the bot (no longer required on UI,
# but we keep it in case templates still reference it)
BOT_PI_SANDBOX = "true"

# Pi Platform API base (MAINNET ONLY)
# NOTE: For the trading bot we are NO LONGER using user_to_app payments
# at all, because the app is registered on mainnet and there is no
# separate "testnet" payment flow. Bot deposits come from the user's
# IZZA testnet wallet instead.
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


# ---------------------------------------------------------
# TESTNET HORIZON CLIENT (for IZZA wallets)
# ---------------------------------------------------------
HORIZON_URL = os.getenv("HORIZON_URL", "https://api.testnet.minepi.com").strip()
_srv = Server(horizon_url=HORIZON_URL)


def _get_testnet_pi_balance_for_username(username: str) -> tuple[str | None, float]:
    """
    Look up the user's IZZA wallet (user_wallets.pub) by username and
    return (pub, native PI balance on TESTNET).

    If no wallet or account not funded, returns (None, 0.0).
    """
    if not username:
        return None, 0.0

    uname = username.strip().lstrip("@").lower()
    if not uname:
        return None, 0.0

    with conn() as cx:
        row = cx.execute(
            "SELECT pub FROM user_wallets WHERE username=?",
            (uname,),
        ).fetchone()

    if not row or not row["pub"]:
        return None, 0.0

    pub = row["pub"].strip().upper()
    if not pub:
        return None, 0.0

    try:
        acct = _srv.accounts().account_id(pub).call()
    except Exception:
        # account not found or horizon error
        return pub, 0.0

    bal = 0.0
    for b in acct.get("balances", []):
        if b.get("asset_type") == "native":
            try:
                bal = float(b.get("balance", "0") or 0)
            except Exception:
                bal = 0.0
            break

    return pub, bal


def _get_or_create_bot_account(username: str, wallet_pub: str | None = None) -> int:
    """
    Ensure there is a bot_accounts row for this username.
    wallet_pub is optional here; we can learn it later from IZZA wallet linkage.
    Returns account_id.
    """
    if not username:
        raise ValueError("username required")

    username_norm = username.strip().lstrip("@").lower()
    wallet_pub = wallet_pub or ""
    ts = _now()

    with conn() as cx:
        row = cx.execute(
            "SELECT id, wallet_pub FROM bot_accounts WHERE username = ?",
            (username_norm,),
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
            (username_norm, wallet_pub, ts, ts),
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

    IMPORTANT:
    We NO LONGER show a Pi SDK deposit flow here, because the app is
    registered on MAINNET and there is no separate 'testnet' user_to_app
    payment flow. Instead, users must:
      1) Create / link their IZZA TESTNET wallet (token showcase flow).
      2) Deposit TEST PI into that wallet from their Pi testnet wallet.
      3) The bot reads that testnet PI balance directly via Horizon.

    The bot.html template should be updated so that the 'deposit' card is
    replaced with:
      - A button that links to your IZZA wallet page
        (token-auth -> token_showcase).
      - A short explanation that the bot will use the IZZA wallet's
        TEST PI balance as available capital.
    """
    return render_template(
        "bot.html",
        PI_SANDBOX=BOT_PI_SANDBOX,
    )


@izza_bot_bp.route("/bot/profile", methods=["GET"])
def bot_profile_page():
    """
    Main profile page:
    - shows total deposited / available (from IZZA TESTNET wallet)
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
        # wallet_pub is learned later from IZZA wallet linkage / Horizon
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
            "username": username.strip().lstrip("@").lower(),
            "risk_level": risk_level,
            "time_horizon_days": horizon_days,
            "target_value_back": target_value_back,
            "objective": objective,
            "volatility": volatility,
        },
    )


# ----------------------------------------------------------------------
# Deposit flow (Pi payments → bot_deposits)  -- DISABLED
# ----------------------------------------------------------------------
@izza_bot_bp.route("/api/trading/deposit/approve", methods=["POST"])
def approve_bot_deposit():
    """
    OLD: Called from Pi JS onReadyForServerApproval(paymentId).

    For the TESTNET trading bot we have DISABLED Pi SDK deposits because
    your IZZA app is registered on MAINNET and user_to_app payments
    cannot be forced onto testnet.

    New flow:
      - Users create / link an IZZA TESTNET wallet (token_showcase.html).
      - They deposit TEST PI into that wallet from their Pi TESTNET wallet.
      - The bot reads that balance directly via Horizon.

    This endpoint now always returns an error so that any stray calls
    from older front-end code fail clearly.
    """
    return jsonify(
        ok=False,
        error="Pi SDK deposit flow is disabled for IZZA BOT. Deposit TEST PI to your IZZA wallet instead.",
    ), 400


@izza_bot_bp.route("/api/trading/deposit/complete", methods=["POST"])
def complete_bot_deposit():
    """
    OLD: Called from Pi JS onReadyForServerCompletion(paymentId, txid).

    This is no longer used now that deposits are based on IZZA TESTNET
    wallet balances. We keep the endpoint only so old front-ends do not
    crash, but it returns an error.
    """
    return jsonify(
        ok=False,
        error="Pi SDK deposit completion is disabled. IZZA BOT uses your IZZA TESTNET wallet balance instead.",
    ), 400


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
          username,
          total_deposited,       # derived from IZZA TESTNET wallet PI balance
          total_withdrawn,       # still tracked in DB if you wire payouts later
          net_deposit,           # = total_deposited - total_withdrawn
          wallet_pub,            # IZZA TESTNET wallet pub
          available_unallocated, # net_deposit - bucket allocations
          pi_balance             # alias of total_deposited for clarity
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

    uname = username.strip().lstrip("@").lower()

    with conn() as cx:
        acct = cx.execute(
            """
            SELECT id, username, wallet_pub,
                   total_deposited, total_withdrawn
              FROM bot_accounts
             WHERE username = ?
            """,
            (uname,),
        ).fetchone()

        # If no bot account yet, we still want to surface the wallet
        # and a zero balance.
        if not acct:
            # Try to discover IZZA wallet
            wallet_pub, pi_balance = _get_testnet_pi_balance_for_username(uname)
            return jsonify(
                ok=True,
                account={
                    "username": uname,
                    "wallet_pub": wallet_pub or "",
                    "total_deposited": pi_balance,
                    "total_withdrawn": 0.0,
                    "net_deposit": pi_balance,
                    "available_unallocated": pi_balance,
                    "pi_balance": pi_balance,
                },
                buckets=[],
            )

        account_id = acct["id"]

    # Refresh wallet + balance from IZZA wallet linkage
    wallet_pub, pi_balance = _get_testnet_pi_balance_for_username(uname)

    # We continue to track total_withdrawn in DB (for when you implement
    # real payouts later). For now it's safe to treat total_deposited as
    # the LIVE testnet PI balance.
    with conn() as cx:
        acct2 = cx.execute(
            """
            SELECT total_withdrawn
              FROM bot_accounts
             WHERE id = ?
            """,
            (account_id,),
        ).fetchone()

        total_withdrawn = float(acct2["total_withdrawn"] or 0) if acct2 else 0.0

        # Keep bot_accounts.wallet_pub in sync if we discovered it
        if wallet_pub:
            cx.execute(
                "UPDATE bot_accounts SET wallet_pub = ?, updated_at = ? WHERE id = ?",
                (wallet_pub, _now(), account_id),
            )

        # Buckets + allocations as before
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

    total_deposited = pi_balance
    net_deposit = max(0.0, total_deposited - total_withdrawn)

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
            "username": uname,
            "wallet_pub": wallet_pub or "",
            "total_deposited": total_deposited,
            "total_withdrawn": total_withdrawn,
            "net_deposit": net_deposit,
            "available_unallocated": available_unallocated,
            "pi_balance": total_deposited,
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
    do not exceed net_deposit (derived from IZZA wallet balance).
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

    uname = username.strip().lstrip("@").lower()
    ts = _now()

    # Live PI balance from IZZA wallet
    wallet_pub, pi_balance = _get_testnet_pi_balance_for_username(uname)

    with conn() as cx:
        acct = cx.execute(
            "SELECT id, total_withdrawn FROM bot_accounts WHERE username = ?",
            (uname,),
        ).fetchone()
        if not acct:
            return jsonify(ok=False, error="Bot account not found for user.")

        account_id = acct["id"]
        total_withdrawn = float(acct["total_withdrawn"] or 0)
        net_deposit = max(0.0, pi_balance - total_withdrawn)

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
                error="Allocation exceeds your available net deposits (IZZA wallet balance). Reduce amount or free other buckets.",
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
                """
                ,
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
      - derive net_deposit from IZZA TESTNET wallet balance minus any
        total_withdrawn recorded so far
      - verify amount <= available_unallocated
      - insert bot_withdrawals row with status 'requested'
      - actual payout logic can be done later by a script that
        sends app_to_user payment from the bot account (on TESTNET).
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

    uname = username.strip().lstrip("@").lower()
    ts = _now()

    # Live PI balance from IZZA wallet
    wallet_pub, pi_balance = _get_testnet_pi_balance_for_username(uname)

    with conn() as cx:
        acct = cx.execute(
            """
            SELECT id, wallet_pub, total_withdrawn
              FROM bot_accounts
             WHERE username = ?
            """,
            (uname,),
        ).fetchone()
        if not acct:
            return jsonify(ok=False, error="Bot account not found for user.")

        account_id = acct["id"]
        total_withdrawn = float(acct["total_withdrawn"] or 0)
        net_deposit = max(0.0, pi_balance - total_withdrawn)

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
            (account_id, wallet_pub or acct["wallet_pub"], ts),
        )

    return jsonify(
        ok=True,
        available_unallocated=available_unallocated - amount,
        note="Withdrawal request recorded. A TESTNET payout script can send this amount later.",
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

    uname = username.strip().lstrip("@").lower()

    with conn() as cx:
        acct = cx.execute(
            "SELECT id FROM bot_accounts WHERE username = ?",
            (uname,),
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
