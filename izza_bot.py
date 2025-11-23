import os
import time
import json
from decimal import Decimal

import requests
from flask import Blueprint, render_template, jsonify, request
from db import conn

from stellar_sdk import Server, Keypair, TransactionBuilder, Network, Asset

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
# TESTNET Horizon + network
# ---------------------------------------------------------
HORIZON_URL = os.getenv("HORIZON_URL", "https://api.testnet.minepi.com").strip()
NETWORK_PASSPHRASE = os.getenv("NETWORK_PASSPHRASE", "Pi Testnet").strip()
_srv = Server(horizon_url=HORIZON_URL)

# Pi Testnet base fee: 0.01 Pi = 100,000 stroops
PI_BASE_FEE_STROOPS = int(os.getenv("PI_BASE_FEE_STROOPS", "100000"))

# IZZA asset on TESTNET (for wallet IZZA balance)
IZZA_ASSET_CODE = os.getenv("IZZA_ASSET_CODE", "IZZA")
IZZA_ASSET_ISSUER = os.getenv(
    "IZZA_ASSET_ISSUER",
    "GDKS3KFAM5RBBTSYTFUEHHN7GYRPHV7A6K2BI44LL3QQKXCA6ODBCS57",
)

# ---------------------------------------------------------
# BOT wallet on TESTNET (holds bucket funds)
# ---------------------------------------------------------
# Default to your existing testnet trading-bot account
TRADING_BOT_TESTNET_DEPOSIT = "GAIXMJ22FKXXGDPQMZWR3GL24PM5UEPUCFNK4FSMJOZ3HTGPXSEQZ5AF"
BOT_WALLET_PUB = os.getenv("BOT_WALLET_PUB", TRADING_BOT_TESTNET_DEPOSIT).strip()
BOT_WALLET_SEC = os.getenv("BOT_WALLET_SEC", "").strip()

# Always force Pi SDK sandbox on templates that use it
BOT_PI_SANDBOX = "true"

# Pi Platform API base (MAINNET ONLY) – not used for testnet deposits,
# we keep it in case you later add app_to_user payouts on mainnet.
PI_PLATFORM_API_BASE = "https://api.minepi.com/v2"
PI_API_KEY = apikey


def _now() -> int:
    return int(time.time())


def _pi_headers():
    if not PI_API_KEY:
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
# Helpers: IZZA wallet balances (TESTNET)
# ---------------------------------------------------------
def _get_testnet_wallet_balances_for_username(username: str) -> tuple[str | None, float, float]:
    """
    Look up the user's IZZA wallet (user_wallets.pub) by username and
    return (pub, native PI balance on TESTNET, IZZA balance on TESTNET).

    If no wallet or account not funded, returns (None, 0.0, 0.0).
    """
    if not username:
        return None, 0.0, 0.0

    uname = username.strip().lstrip("@").lower()
    if not uname:
        return None, 0.0, 0.0

    with conn() as cx:
        row = cx.execute(
            "SELECT pub FROM user_wallets WHERE username=?",
            (uname,),
        ).fetchone()

    if not row or not row["pub"]:
        return None, 0.0, 0.0

    pub = row["pub"].strip().upper()
    if not pub:
        return None, 0.0, 0.0

    try:
        acct = _srv.accounts().account_id(pub).call()
    except Exception:
        # account not found or horizon error
        return pub, 0.0, 0.0

    pi_bal = 0.0
    izza_bal = 0.0
    for b in acct.get("balances", []):
        atype = b.get("asset_type")
        if atype == "native":
            try:
                pi_bal = float(b.get("balance", "0") or 0)
            except Exception:
                pi_bal = 0.0
        elif atype in ("credit_alphanum4", "credit_alphanum12"):
            code = b.get("asset_code")
            issuer = b.get("asset_issuer")
            if code == IZZA_ASSET_CODE and issuer == IZZA_ASSET_ISSUER:
                try:
                    izza_bal = float(b.get("balance", "0") or 0)
                except Exception:
                    izza_bal = 0.0

    return pub, pi_bal, izza_bal


def _get_testnet_pi_balance_for_username(username: str) -> tuple[str | None, float]:
    pub, pi_bal, _ = _get_testnet_wallet_balances_for_username(username)
    return pub, pi_bal


# ---------------------------------------------------------
# Helpers: BOT account + buckets
# ---------------------------------------------------------
def _get_or_create_bot_account(username: str, wallet_pub: str | None = None) -> int:
    """
    Ensure there is a bot_accounts row for this username.
    wallet_pub is optional; we can populate/update it later.
    Returns account_id.
    """
    if not username:
        raise ValueError("username required")

    username_norm = username.strip().lstrip("@").lower()
    wallet_pub = (wallet_pub or "").strip()
    ts = _now()

    with conn() as cx:
        row = cx.execute(
            "SELECT id, wallet_pub FROM bot_accounts WHERE username = ?",
            (username_norm,),
        ).fetchone()

        if row:
            acct_id = row["id"]
            existing_pub = (row["wallet_pub"] or "").strip()
            if wallet_pub and existing_pub != wallet_pub:
                cx.execute(
                    "UPDATE bot_accounts SET wallet_pub = ?, updated_at = ? WHERE id = ?",
                    (wallet_pub, ts, acct_id),
                )
            return acct_id

        cur = cx.execute(
            """
            INSERT INTO bot_accounts (username, wallet_pub, total_deposited,
                                      total_withdrawn, created_at, updated_at)
            VALUES (?, ?, 0, 0, ?, ?)
            """,
            (username_norm, wallet_pub or "", ts, ts),
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
    Default "base" bucket for an account.
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
    Simple sanity checks for bucket profiles.
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

    if time_horizon_days <= 3 and objective == "max_growth" and volatility == "low":
        return False, (
            "Short-term, low-volatility cannot target maximum growth. "
            "Increase your time horizon or allow more volatility."
        )

    if risk_level == "low" and volatility == "high":
        return False, (
            "Low risk with high volatility is not supported. "
            "Either raise your risk level or lower volatility."
        )

    if risk_level == "low" and objective == "max_growth":
        return False, (
            "Maximum growth objectives require at least medium risk. "
            "Increase your risk level or pick a balanced objective."
        )

    return True, None


def _risk_floor_for_level(risk_level: str) -> float:
    """
    Internal downside floor derived from risk level.
    Interpreted as: bot should not allow bucket value to fall below this
    fraction of the initial deposit for that bucket.

    low    => keep >= 85%  (max ~15% loss)
    medium => keep >= 70%  (max ~30% loss)
    high   => keep >= 55%  (max ~45% loss)
    """
    rl = (risk_level or "medium").lower()
    if rl == "low":
        return 0.85
    if rl == "high":
        return 0.55
    return 0.70  # medium


# ---------------------------------------------------------
# Stellar helpers: send native payments on TESTNET
# ---------------------------------------------------------
def _send_native_payment(from_secret: str, to_pub: str, amount: float, memo_text: str = "") -> dict:
    """
    Sends native test Pi from from_secret to to_pub on TESTNET.
    Returns Horizon submit_transaction JSON.
    """
    if amount <= 0:
        raise ValueError("amount must be positive")
    if not from_secret or not to_pub:
        raise ValueError("Missing from_secret or to_pub")

    kp = Keypair.from_secret(from_secret)
    from_pub = kp.public_key

    account = _srv.load_account(from_pub)
    builder = TransactionBuilder(
        source_account=account,
        network_passphrase=NETWORK_PASSPHRASE,
        base_fee=PI_BASE_FEE_STROOPS,
    )

    builder.append_payment_op(
        destination=to_pub,
        amount=str(Decimal(str(amount))),
        asset=Asset.native()
    )

    if memo_text:
        builder.add_text_memo(memo_text[:28])

    # Set a timeout to satisfy Horizon best practices and avoid warnings
    tx = builder.set_timeout(300).build()
    tx.sign(kp)
    resp = _srv.submit_transaction(tx)
    return resp


# ----------------------------------------------------------------------
# PAGES
# ----------------------------------------------------------------------
@izza_bot_bp.route("/bot", methods=["GET"])
def bot_home():
    """
    IZZA BOT onboarding page.
    """
    return render_template(
        "bot.html",
        PI_SANDBOX=BOT_PI_SANDBOX,
    )


@izza_bot_bp.route("/bot/profile", methods=["GET"])
def bot_profile_page():
    """
    Main profile page:
    - shows wallet balances (IZZA testnet wallet)
    - shows buckets + their REAL balances
    - allows per-bucket deposits/withdrawals
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
        "objective": "balanced",   # optional
        "volatility": "medium"     # optional
      }

    target_value_back is NOT provided by the user; it is derived from risk_level.
    """
    data = request.get_json() or {}

    username     = (data.get("username") or "").strip()
    risk_level   = (data.get("risk_level") or "medium").lower()
    horizon_days = data.get("time_horizon_days") or 10
    objective    = (data.get("objective") or "balanced").lower()
    volatility   = (data.get("volatility") or risk_level).lower()

    if not username:
        return jsonify(ok=False, error="Missing username from request.")

    try:
        horizon_days = int(horizon_days)
    except Exception:
        return jsonify(ok=False, error="Time horizon must be an integer number of days.")

    ok, msg = _validate_profile(horizon_days, risk_level, objective, volatility)
    if not ok:
        return jsonify(ok=False, error=msg)

    # Internal downside floor from risk, not user input
    target_value_back = _risk_floor_for_level(risk_level)

    try:
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
# OLD Pi SDK deposit endpoints (now disabled)
# ----------------------------------------------------------------------
@izza_bot_bp.route("/api/trading/deposit/approve", methods=["POST"])
def approve_bot_deposit():
    return jsonify(
        ok=False,
        error="Pi SDK deposit flow is disabled for IZZA BOT. Deposit TEST PI to your IZZA wallet instead.",
    ), 400


@izza_bot_bp.route("/api/trading/deposit/complete", methods=["POST"])
def complete_bot_deposit():
    return jsonify(
        ok=False,
        error="Pi SDK deposit completion is disabled. IZZA BOT uses your IZZA TESTNET wallet balance instead.",
    ), 400


# ----------------------------------------------------------------------
# Summary: wallet + buckets
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
          wallet_pub,        # IZZA TESTNET wallet pub
          pi_balance,        # wallet native test Pi (from Horizon)
          izza_balance,      # wallet IZZA balance (from Horizon)
          total_deposited,   # lifetime deposits from wallet -> bot
          total_withdrawn    # lifetime withdrawals from bot -> wallet
        },
        buckets: [
          { id, name, risk_level, objective, volatility,
            time_horizon_days, target_value_back,
            balance }         # REAL Pi sitting in this bucket on the bot
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

    # Wallet balances ALWAYS come from IZZA wallet on testnet
    wallet_pub, pi_balance, izza_balance = _get_testnet_wallet_balances_for_username(uname)

    if not acct:
        # No bot account yet: just return wallet + no buckets
        return jsonify(
            ok=True,
            account={
                "username": uname,
                "wallet_pub": wallet_pub or "",
                "pi_balance": pi_balance,
                "izza_balance": izza_balance,
                "total_deposited": 0.0,
                "total_withdrawn": 0.0,
            },
            buckets=[],
        )

    account_id = acct["id"]
    total_deposited = float(acct["total_deposited"] or 0)
    total_withdrawn = float(acct["total_withdrawn"] or 0)

    # Sync wallet_pub in bot_accounts if we discovered it
    if wallet_pub:
        with conn() as cx:
            cx.execute(
                "UPDATE bot_accounts SET wallet_pub = ?, updated_at = ? WHERE id = ?",
                (wallet_pub, _now(), account_id),
            )

    with conn() as cx:
        rows = cx.execute(
            """
            SELECT b.id, b.name, b.objective, b.risk_level, b.volatility,
                   b.time_horizon_days, b.target_value_back,
                   IFNULL(a.amount, 0) AS balance
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
    for r in rows:
        buckets.append({
            "id": r["id"],
            "name": r["name"],
            "objective": r["objective"],
            "risk_level": r["risk_level"],
            "volatility": r["volatility"],
            "time_horizon_days": r["time_horizon_days"],
            "target_value_back": r["target_value_back"],
            "balance": float(r["balance"] or 0),
        })

    return jsonify(
        ok=True,
        account={
            "username": uname,
            "wallet_pub": wallet_pub or (acct["wallet_pub"] or ""),
            "pi_balance": pi_balance,
            "izza_balance": izza_balance,
            "total_deposited": total_deposited,
            "total_withdrawn": total_withdrawn,
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
        "objective": "max_growth",
        "volatility": "high"
      }

    target_value_back is derived from risk_level internally.
    """
    data = request.get_json() or {}

    username     = (data.get("username") or "").strip()
    name         = (data.get("name") or "").strip()
    risk_level   = (data.get("risk_level") or "medium").lower()
    horizon_days = data.get("time_horizon_days") or 10
    objective    = (data.get("objective") or "balanced").lower()
    volatility   = (data.get("volatility") or risk_level).lower()

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

    # Internal downside floor from risk
    target_value_back = _risk_floor_for_level(risk_level)

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
            "balance": 0.0,
        },
    )


# ----------------------------------------------------------------------
# Deposit into a bucket (wallet -> BOT -> bucket balance)
# ----------------------------------------------------------------------
@izza_bot_bp.route("/api/trading/bucket/deposit", methods=["POST"])
def bucket_deposit():
    """
    POST JSON:
      {
        "username": "CamMac",
        "bucket_id": 1,
        "amount": 10.0,
        "secret": "S..."   # IZZA wallet secret (in this browser only)
      }

    Flow:
      - verify secret matches the stored IZZA wallet pub for username
      - horizon check: wallet has >= amount
      - send native payment from IZZA wallet -> BOT_WALLET_PUB
      - increment bot_bucket_allocations.amount for that bucket
      - increment bot_accounts.total_deposited
      - insert bot_deposits row
    """
    data = request.get_json() or {}
    username = (data.get("username") or "").strip()
    bucket_id = data.get("bucket_id")
    amount = data.get("amount")
    secret = (data.get("secret") or "").strip()

    if not username:
        return jsonify(ok=False, error="username is required")
    if not secret:
        return jsonify(ok=False, error="Missing wallet secret (open your IZZA wallet in this browser).")

    try:
        amount = float(amount)
    except Exception:
        return jsonify(ok=False, error="amount must be numeric")
    if amount <= 0:
        return jsonify(ok=False, error="amount must be positive")

    try:
        bucket_id = int(bucket_id)
    except Exception:
        return jsonify(ok=False, error="bucket_id must be integer")

    if not BOT_WALLET_PUB:
        return jsonify(ok=False, error="BOT_WALLET_PUB not configured on server.")
    if not BOT_WALLET_SEC:
        # We don't use the bot secret for this direction, but we
        # enforce it is set so the system is fully configured
        return jsonify(ok=False, error="BOT_WALLET_SEC not configured on server.")

    uname = username.strip().lstrip("@").lower()
    ts = _now()

    # Derive public key from secret and compare against user_wallets.pub
    try:
        kp = Keypair.from_secret(secret)
    except Exception:
        return jsonify(ok=False, error="Invalid wallet secret.")

    from_pub = kp.public_key

    with conn() as cx:
        row = cx.execute(
            "SELECT pub FROM user_wallets WHERE username = ?",
            (uname,),
        ).fetchone()

    if not row or not row["pub"]:
        return jsonify(ok=False, error="No IZZA wallet linked for this username.")

    stored_pub = row["pub"].strip().upper()
    if stored_pub != from_pub:
        return jsonify(
            ok=False,
            error="Wallet secret does not match your linked IZZA wallet. Use the same browser you created the wallet with.",
        )

    # Horizon check: wallet has enough balance
    try:
        acct = _srv.accounts().account_id(from_pub).call()
    except Exception as e:
        return jsonify(ok=False, error=f"Could not load wallet account on Horizon: {e}")

    bal = 0.0
    for b in acct.get("balances", []):
        if b.get("asset_type") == "native":
            try:
                bal = float(b.get("balance", "0") or 0)
            except Exception:
                bal = 0.0
            break

    if bal < amount - 1e-8:
        return jsonify(ok=False, error="Insufficient PI balance in IZZA wallet for this deposit.")

    # Execute payment wallet -> BOT
    try:
        tx_resp = _send_native_payment(
            from_secret=secret,
            to_pub=BOT_WALLET_PUB,
            amount=amount,
            memo_text=f"IZZA BOT deposit bucket {bucket_id}",
        )
        tx_hash = tx_resp.get("hash")
    except Exception as e:
        return jsonify(ok=False, error=f"Network error submitting deposit transaction: {e}")

    # Update DB: account, bucket balance, bot_deposits, total_deposited
    with conn() as cx:
        acct_row = cx.execute(
            "SELECT id, total_deposited FROM bot_accounts WHERE username = ?",
            (uname,),
        ).fetchone()

        if not acct_row:
            account_id = _get_or_create_bot_account(uname, wallet_pub=from_pub)
            total_deposited = 0.0
        else:
            account_id = acct_row["id"]
            total_deposited = float(acct_row["total_deposited"] or 0)

        # Ensure bucket belongs to this account
        b_row = cx.execute(
            "SELECT id, account_id FROM bot_buckets WHERE id = ?",
            (bucket_id,),
        ).fetchone()
        if not b_row or b_row["account_id"] != account_id:
            return jsonify(ok=False, error="Bucket not found for this user.")

        # Current bucket balance
        alloc_row = cx.execute(
            """
            SELECT id, amount FROM bot_bucket_allocations
             WHERE account_id = ? AND bucket_id = ?
            """,
            (account_id, bucket_id),
        ).fetchone()

        if alloc_row:
            new_balance = float(alloc_row["amount"] or 0) + amount
            cx.execute(
                """
                UPDATE bot_bucket_allocations
                   SET amount = ?, updated_at = ?
                 WHERE id = ?
                """,
                (new_balance, ts, alloc_row["id"]),
            )
        else:
            new_balance = amount
            cx.execute(
                """
                INSERT INTO bot_bucket_allocations(
                  account_id, bucket_id, amount, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?)
                """,
                (account_id, bucket_id, amount, ts, ts),
            )

        # bot_deposits log
        cx.execute(
            """
            INSERT INTO bot_deposits(
              account_id, tx_hash, amount, asset_code, asset_issuer,
              status, created_at, raw_json
            )
            VALUES (?, ?, ?, ?, ?, 'confirmed', ?, ?)
            """,
            (
                account_id,
                tx_hash,
                amount,
                None,
                None,
                ts,
                json.dumps(tx_resp),
            ),
        )

        # total_deposited
        new_total_deposited = total_deposited + amount
        cx.execute(
            """
            UPDATE bot_accounts
               SET total_deposited = ?, wallet_pub = ?, updated_at = ?
             WHERE id = ?
            """,
            (new_total_deposited, from_pub, ts, account_id),
        )

    return jsonify(
        ok=True,
        tx_hash=tx_hash,
        bucket_id=bucket_id,
        new_balance=new_balance,
        new_total_deposited=new_total_deposited,
    )


# ----------------------------------------------------------------------
# Withdraw from a bucket (BOT -> wallet -> reduce bucket balance)
# ----------------------------------------------------------------------
@izza_bot_bp.route("/api/trading/bucket/withdraw", methods=["POST"])
def bucket_withdraw():
    """
    POST JSON:
      {
        "username": "CamMac",
        "bucket_id": 1,
        "amount": 5.0
      }

    Flow:
      - ensure BOT_WALLET_SEC configured
      - look up user's IZZA wallet pub
      - ensure bucket belongs to user and has >= amount
      - (optional) check BOT wallet balance >= amount
      - send native payment from BOT_WALLET_SEC -> user wallet
      - decrement bot_bucket_allocations.amount
      - increment bot_accounts.total_withdrawn
      - insert bot_withdrawals row (status='sent')
    """
    data = request.get_json() or {}
    username = (data.get("username") or "").strip()
    bucket_id = data.get("bucket_id")
    amount = data.get("amount")

    if not username:
        return jsonify(ok=False, error="username is required")

    try:
        bucket_id = int(bucket_id)
    except Exception:
        return jsonify(ok=False, error="bucket_id must be integer")

    try:
        amount = float(amount)
    except Exception:
        return jsonify(ok=False, error="amount must be numeric")
    if amount <= 0:
        return jsonify(ok=False, error="amount must be positive")

    if not BOT_WALLET_PUB or not BOT_WALLET_SEC:
        return jsonify(ok=False, error="BOT wallet not fully configured on server.")

    uname = username.strip().lstrip("@").lower()
    ts = _now()

    # Get user's IZZA wallet pub
    wallet_pub, _, _ = _get_testnet_wallet_balances_for_username(uname)
    if not wallet_pub:
        return jsonify(ok=False, error="No IZZA wallet linked or funded for this username.")

    with conn() as cx:
        acct_row = cx.execute(
            """
            SELECT id, total_withdrawn
              FROM bot_accounts
             WHERE username = ?
            """,
            (uname,),
        ).fetchone()
        if not acct_row:
            return jsonify(ok=False, error="Bot account not found for user.")

        account_id = acct_row["id"]
        total_withdrawn = float(acct_row["total_withdrawn"] or 0)

        # bucket must belong to this account
        b_row = cx.execute(
            "SELECT id, account_id FROM bot_buckets WHERE id = ?",
            (bucket_id,),
        ).fetchone()
        if not b_row or b_row["account_id"] != account_id:
            return jsonify(ok=False, error="Bucket not found for this user.")

        # current bucket balance
        alloc_row = cx.execute(
            """
            SELECT id, amount FROM bot_bucket_allocations
             WHERE account_id = ? AND bucket_id = ?
            """,
            (account_id, bucket_id),
        ).fetchone()
        if not alloc_row:
            return jsonify(ok=False, error="This bucket has no funds to withdraw.")

        current_balance = float(alloc_row["amount"] or 0)
        if amount > current_balance + 1e-9:
            return jsonify(ok=False, error="Requested amount exceeds bucket balance.")

    # (Optional) check BOT wallet has enough balance
    try:
        bot_acct = _srv.accounts().account_id(BOT_WALLET_PUB).call()
        bot_bal = 0.0
        for b in bot_acct.get("balances", []):
            if b.get("asset_type") == "native":
                try:
                    bot_bal = float(b.get("balance", "0") or 0)
                except Exception:
                    bot_bal = 0.0
                break
        if bot_bal < amount - 1e-8:
            return jsonify(ok=False, error="Bot wallet does not have enough test Pi for this withdrawal.")
    except Exception as e:
        return jsonify(ok=False, error=f"Could not load bot wallet from Horizon: {e}")

    # Execute payment: BOT -> user
    try:
        tx_resp = _send_native_payment(
            from_secret=BOT_WALLET_SEC,
            to_pub=wallet_pub,
            amount=amount,
            memo_text=f"IZZA BOT withdraw bucket {bucket_id}",
        )
        tx_hash = tx_resp.get("hash")
    except Exception as e:
        return jsonify(ok=False, error=f"Network error submitting withdrawal transaction: {e}")

    # Update DB balances
    with conn() as cx:
        # Re-read allocation row under lock
        alloc_row = cx.execute(
            """
            SELECT id, amount FROM bot_bucket_allocations
             WHERE account_id = ? AND bucket_id = ?
            """,
            (account_id, bucket_id),
        ).fetchone()

        if not alloc_row:
            # Extremely unlikely race, but handle gracefully
            return jsonify(ok=False, error="Bucket allocation disappeared during withdrawal.")

        current_balance = float(alloc_row["amount"] or 0)
        if amount > current_balance + 1e-9:
            return jsonify(ok=False, error="Requested amount exceeds bucket balance (race condition).")

        new_balance = max(0.0, current_balance - amount)
        cx.execute(
            """
            UPDATE bot_bucket_allocations
               SET amount = ?, updated_at = ?
             WHERE id = ?
            """,
            (new_balance, ts, alloc_row["id"]),
        )

        new_total_withdrawn = total_withdrawn + amount
        cx.execute(
            """
            UPDATE bot_accounts
               SET total_withdrawn = ?, updated_at = ?
             WHERE id = ?
            """,
            (new_total_withdrawn, ts, account_id),
        )

        cx.execute(
            """
            INSERT INTO bot_withdrawals(
              account_id, amount, status, dest_pub, created_at, txid, raw_json
            )
            VALUES (?, ?, 'sent', ?, ?, ?, ?)
            """,
            (
                account_id,
                amount,
                wallet_pub,
                ts,
                tx_hash,
                json.dumps(tx_resp),
            ),
        )

    return jsonify(
        ok=True,
        tx_hash=tx_hash,
        bucket_id=bucket_id,
        new_balance=new_balance,
        new_total_withdrawn=new_total_withdrawn,
    )


# ----------------------------------------------------------------------
# Helper: list buckets (optional; for debugging / admin)
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
