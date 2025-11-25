import os
import time
import json
from decimal import Decimal

import requests
from flask import Blueprint, render_template, jsonify, request
from db import conn

from stellar_sdk import Server, Keypair, TransactionBuilder, Network, Asset
from bot_engine import (
    compute_bucket_realized_perf_pct,
    liquidate_bucket_to_cash,  # <-- new helper import
)

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

# ---------------------------------------------------------
# Short-term trading fee: 24h window + 1 test Pi fee
# ---------------------------------------------------------
SHORT_TERM_WINDOW_SECS = 24 * 3600
SHORT_TERM_WITHDRAW_FEE = 1.0  # test Pi


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
# Summary: wallet + buckets + realized performance
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
            balance,          # REAL Pi sitting in this bucket on the bot
            perf_pct          # optional realized PnL % based on realized sells
          }
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

    # Fetch buckets and precompute simple buy/sell sums in case we need a fallback
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
               AND (b.status IS NULL OR b.status = 'active')
             ORDER BY b.id ASC
            """,
            (account_id,),
        ).fetchall()

        bucket_ids = [r["id"] for r in rows]
        perf_map = {}
        if bucket_ids:
            placeholders = ",".join("?" for _ in bucket_ids)
            # Case insensitive BUY / SELL so old rows with 'BUY' / 'SELL' still count
            perf_rows = cx.execute(
                f"""
                SELECT
                  bucket_id,
                  SUM(CASE WHEN LOWER(side) = 'buy'  THEN amount_pi ELSE 0 END) AS buy_pi,
                  SUM(CASE WHEN LOWER(side) = 'sell' THEN amount_pi ELSE 0 END) AS sell_pi
                FROM bot_trades
                WHERE bucket_id IN ({placeholders})
                GROUP BY bucket_id
                """,
                bucket_ids,
            ).fetchall()
            for pr in perf_rows:
                perf_map[pr["bucket_id"]] = {
                    "buy_pi": float(pr["buy_pi"] or 0.0),
                    "sell_pi": float(pr["sell_pi"] or 0.0),
                }

    buckets = []
    for r in rows:
        # Primary: use shared engine helper so UI matches bot_engine logic
        perf_pct = compute_bucket_realized_perf_pct(r["id"])

        # Fallback: if helper returns None but we clearly have sell volume,
        # compute a simple realized PnL from buy/sell sums so old data
        # (with mixed-case 'side') still shows performance instead of
        # "awaiting first trade sell".
        if perf_pct is None:
            perf_row = perf_map.get(r["id"])
            if perf_row:
                buy_pi = perf_row["buy_pi"]
                sell_pi = perf_row["sell_pi"]
                if sell_pi > 0 and buy_pi > 0 and abs(buy_pi) > 1e-9:
                    realized_pnl = sell_pi - buy_pi
                    perf_pct = 100.0 * realized_pnl / buy_pi

        b = {
            "id": r["id"],
            "name": r["name"],
            "objective": r["objective"],
            "risk_level": r["risk_level"],
            "volatility": r["volatility"],
            "time_horizon_days": r["time_horizon_days"],
            "target_value_back": r["target_value_back"],
            "balance": float(r["balance"] or 0),
        }
        if perf_pct is not None:
            b["perf_pct"] = perf_pct
        buckets.append(b)

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
      - (optional) check BOT wallet balance >= payout_amount
      - send native payment from BOT_WALLET_SEC -> user wallet
      - decrement bot_bucket_allocations.amount by requested amount
      - increment bot_accounts.total_withdrawn by requested amount
      - insert bot_withdrawals row (status='sent')
      - if withdrawal occurs within 24h of last bucket change,
        apply 1.0 test Pi fee (user receives amount - 1.0)
    """
    data = request.get_json() or {}
    username = (data.get("username") or "").strip()
    bucket_id = data.get("bucket_id")
    amount = data.get("amount")

    # small tolerance for float dust, so withdrawing the displayed balance works
    EPS = 1e-7

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

        # current bucket balance (+ last updated_at for short-term fee)
        alloc_row = cx.execute(
            """
            SELECT id, amount, updated_at FROM bot_bucket_allocations
             WHERE account_id = ? AND bucket_id = ?
            """,
            (account_id, bucket_id),
        ).fetchone()
        if not alloc_row:
            return jsonify(ok=False, error="This bucket has no funds to withdraw.")

        current_balance = float(alloc_row["amount"] or 0)

        # allow for tiny rounding difference when user withdraws "everything"
        if amount > current_balance:
            if amount - current_balance <= EPS:
                amount = current_balance
            else:
                return jsonify(ok=False, error="Requested amount exceeds bucket balance.")

        last_change_ts = int(alloc_row["updated_at"] or 0)

    # Decide if short-term fee applies (within 24h of last bucket change)
    fee = 0.0
    short_term_fee_applied = False
    if last_change_ts and (ts - last_change_ts) < SHORT_TERM_WINDOW_SECS:
        # Only apply fee if amount is large enough
        if amount <= SHORT_TERM_WITHDRAW_FEE + 1e-8:
            return jsonify(
                ok=False,
                error=(
                    f"Short-term withdrawal fee of {SHORT_TERM_WITHDRAW_FEE:.4f} test Pi "
                    "applies within 24 hours of your last bucket change. "
                    "Please withdraw a larger amount or wait until 24 hours have passed."
                ),
            )
        fee = SHORT_TERM_WITHDRAW_FEE
        short_term_fee_applied = True

    payout_amount = amount - fee

    # (Optional) check BOT wallet has enough balance to send payout_amount
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
        if bot_bal < payout_amount - 1e-8:
            return jsonify(ok=False, error="Bot wallet does not have enough test Pi for this withdrawal.")
    except Exception as e:
        return jsonify(ok=False, error=f"Could not load bot wallet from Horizon: {e}")

    # Execute payment: BOT -> user (only payout_amount; fee stays in bot wallet)
    try:
        tx_resp = _send_native_payment(
            from_secret=BOT_WALLET_SEC,
            to_pub=wallet_pub,
            amount=payout_amount,
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
        if amount > current_balance + EPS:
            return jsonify(ok=False, error="Requested amount exceeds bucket balance (race condition).")

        # Bucket balance is reduced by the full requested amount (fee is a cost of using the bucket)
        new_balance = max(0.0, current_balance - amount)
        cx.execute(
            """
            UPDATE bot_bucket_allocations
               SET amount = ?, updated_at = ?
             WHERE id = ?
            """,
            (new_balance, ts, alloc_row["id"]),
        )

        # total_withdrawn tracks requested amount (how much the user pulled from the bot system)
        new_total_withdrawn = total_withdrawn + amount
        cx.execute(
            """
            UPDATE bot_accounts
               SET total_withdrawn = ?, updated_at = ?
             WHERE id = ?
            """,
            (new_total_withdrawn, ts, account_id),
        )

        # Store payout and fee info inside raw_json for audit
        audit_payload = {
            "requested_amount": amount,
            "payout_amount": payout_amount,
            "short_term_fee_applied": short_term_fee_applied,
            "fee_amount": fee,
            "tx": tx_resp,
        }

        cx.execute(
            """
            INSERT INTO bot_withdrawals(
              account_id, amount, status, dest_pub, created_at, txid, raw_json
            )
            VALUES (?, ?, 'sent', ?, ?, ?, ?)
            """,
            (
                account_id,
                payout_amount,  # amount that actually left the bot wallet
                wallet_pub,
                ts,
                tx_hash,
                json.dumps(audit_payload),
            ),
        )

    return jsonify(
        ok=True,
        tx_hash=tx_hash,
        bucket_id=bucket_id,
        new_balance=new_balance,
        new_total_withdrawn=new_total_withdrawn,
        short_term_fee_applied=short_term_fee_applied,
        fee_amount=fee,
        payout_amount=payout_amount,
    )


# ----------------------------------------------------------------------
# NEW: Per-bucket liquidation (turn all positions into PI, no withdrawal)
# ----------------------------------------------------------------------
@izza_bot_bp.route("/api/trading/bucket/liquidate", methods=["POST"])
def bucket_liquidate():
    """
    POST JSON:
      {
        "username": "CamMac",
        "bucket_id": 1
      }

    Behavior:
      - Validates bucket belongs to this user and is not deleted.
      - Sells ALL positions for this bucket at current best bids (one-shot),
        using the same engine logic as LIQUIDATE_ALL, but scoped to THIS bucket only.
      - Leaves resulting PI as bucket cash in bot_bucket_allocations.
      - Does NOT withdraw or delete the bucket.
      - Returns the new cash balance (test Pi) and an optional perf_pct.

    Frontend flow:
      - User hits "Close bucket" button →
      - Call this endpoint to flatten to PI and get resulting balance + PnL →
      - Show confirmation:
          "Withdraw X PI and close bucket?"
      - If user confirms YES → call /api/trading/bucket/close
      - If NO → bucket remains active with new cash, bot will start over.
    """
    data = request.get_json() or {}
    username = (data.get("username") or "").strip()
    bucket_id = data.get("bucket_id")

    if not username:
        return jsonify(ok=False, error="username is required")

    try:
        bucket_id = int(bucket_id)
    except Exception:
        return jsonify(ok=False, error="bucket_id must be integer")

    uname = username.strip().lstrip("@").lower()

    with conn() as cx:
        acct_row = cx.execute(
            """
            SELECT id
              FROM bot_accounts
             WHERE username = ?
            """,
            (uname,),
        ).fetchone()
        if not acct_row:
            return jsonify(ok=False, error="Bot account not found for user.")

        account_id = acct_row["id"]

        b_row = cx.execute(
            """
            SELECT id, account_id, status
              FROM bot_buckets
             WHERE id = ?
            """,
            (bucket_id,),
        ).fetchone()
        if not b_row or b_row["account_id"] != account_id:
            return jsonify(ok=False, error="Bucket not found for this user.")

        if (b_row["status"] or "").lower() == "deleted":
            return jsonify(ok=False, error="This bucket is already deleted.")

    # Perform per-bucket liquidation of positions into PI
    try:
        cash_after = float(liquidate_bucket_to_cash(bucket_id) or 0.0)
    except Exception as e:
        return jsonify(ok=False, error=f"Error liquidating bucket positions: {e}")

    # Optional realized performance % (same helper used in summary)
    perf_pct = compute_bucket_realized_perf_pct(bucket_id)

    # Simple fallback for perf_pct (same style as summary, but per-bucket)
    if perf_pct is None:
        with conn() as cx:
            row = cx.execute(
                """
                SELECT
                  SUM(CASE WHEN LOWER(side) = 'buy'  THEN amount_pi ELSE 0 END) AS buy_pi,
                  SUM(CASE WHEN LOWER(side) = 'sell' THEN amount_pi ELSE 0 END) AS sell_pi
                FROM bot_trades
                WHERE bucket_id = ?
                """,
                (bucket_id,),
            ).fetchone()
        if row:
            buy_pi = float(row["buy_pi"] or 0.0)
            sell_pi = float(row["sell_pi"] or 0.0)
            if sell_pi > 0 and buy_pi > 0 and abs(buy_pi) > 1e-9:
                realized_pnl = sell_pi - buy_pi
                perf_pct = 100.0 * realized_pnl / buy_pi

    return jsonify(
        ok=True,
        bucket_id=bucket_id,
        cash_after=cash_after,
        perf_pct=perf_pct,
    )


# ----------------------------------------------------------------------
# NEW: Close a bucket – withdraw all PI to user's wallet and delete bucket
# ----------------------------------------------------------------------
@izza_bot_bp.route("/api/trading/bucket/close", methods=["POST"])
def bucket_close():
    """
    POST JSON:
      {
        "username": "CamMac",
        "bucket_id": 1
      }

    Behavior:
      - Assumes positions have already been liquidated to PI via
        /api/trading/bucket/liquidate (but will still work if called alone).
      - Reads the current bucket cash balance from bot_bucket_allocations.
      - Sends ALL that test Pi from BOT_WALLET_SEC to the user's IZZA wallet.
      - Sets bucket allocation amount to 0.
      - Increments bot_accounts.total_withdrawn by that amount.
      - Inserts a bot_withdrawals row.
      - Marks the bucket status='deleted'.

    No short-term fee is applied here – this is an explicit "close bucket"
    action after the user sees the liquidation result.
    """
    data = request.get_json() or {}
    username = (data.get("username") or "").strip()
    bucket_id = data.get("bucket_id")

    if not username:
        return jsonify(ok=False, error="username is required")

    try:
        bucket_id = int(bucket_id)
    except Exception:
        return jsonify(ok=False, error="bucket_id must be integer")

    if not BOT_WALLET_PUB or not BOT_WALLET_SEC:
        return jsonify(ok=False, error="BOT wallet not fully configured on server.")

    uname = username.strip().lstrip("@").lower()
    ts = _now()

    # Resolve user's IZZA wallet pub
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
        total_withdrawn = float(acct_row["total_withdrawn"] or 0.0)

        b_row = cx.execute(
            """
            SELECT id, account_id, status
              FROM bot_buckets
             WHERE id = ?
            """,
            (bucket_id,),
        ).fetchone()
        if not b_row or b_row["account_id"] != account_id:
            return jsonify(ok=False, error="Bucket not found for this user.")

        # Read current bucket balance
        alloc_row = cx.execute(
            """
            SELECT id, amount
              FROM bot_bucket_allocations
             WHERE account_id = ? AND bucket_id = ?
            """,
            (account_id, bucket_id),
        ).fetchone()

        if not alloc_row:
            current_balance = 0.0
            alloc_id = None
        else:
            current_balance = float(alloc_row["amount"] or 0.0)
            alloc_id = alloc_row["id"]

    # If no balance, just mark bucket deleted and return
    if current_balance <= 0:
        with conn() as cx:
            cx.execute(
                """
                UPDATE bot_buckets
                   SET status = 'deleted', updated_at = ?
                 WHERE id = ?
                """,
                (ts, bucket_id),
            )
        return jsonify(
            ok=True,
            bucket_id=bucket_id,
            withdrawn_amount=0.0,
            tx_hash=None,
        )

    # Check BOT wallet has enough PI to pay out this bucket's cash
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
        if bot_bal < current_balance - 1e-8:
            return jsonify(ok=False, error="Bot wallet does not have enough test Pi to close this bucket.")
    except Exception as e:
        return jsonify(ok=False, error=f"Could not load bot wallet from Horizon: {e}")

    # Execute payment: BOT -> user for the full bucket balance (no fee here)
    try:
        tx_resp = _send_native_payment(
            from_secret=BOT_WALLET_SEC,
            to_pub=wallet_pub,
            amount=current_balance,
            memo_text=f"IZZA BOT close bucket {bucket_id}",
        )
        tx_hash = tx_resp.get("hash")
    except Exception as e:
        return jsonify(ok=False, error=f"Network error submitting close-bucket transaction: {e}")

    # Update DB: zero allocation, increment total_withdrawn, add withdrawal log, delete bucket
    with conn() as cx:
        # Refresh account total_withdrawn
        acct_row = cx.execute(
            """
            SELECT id, total_withdrawn
              FROM bot_accounts
             WHERE id = ?
            """,
            (account_id,),
        ).fetchone()
        if acct_row:
            total_withdrawn = float(acct_row["total_withdrawn"] or 0.0)
        new_total_withdrawn = total_withdrawn + current_balance

        # Zero the allocation if it exists
        if alloc_id is not None:
            cx.execute(
                """
                UPDATE bot_bucket_allocations
                   SET amount = 0, updated_at = ?
                 WHERE id = ?
                """,
                (ts, alloc_id),
            )

        # Update account totals
        cx.execute(
            """
            UPDATE bot_accounts
               SET total_withdrawn = ?, updated_at = ?
             WHERE id = ?
            """,
            (new_total_withdrawn, ts, account_id),
        )

        # Log withdrawal
        audit_payload = {
            "requested_amount": current_balance,
            "payout_amount": current_balance,
            "short_term_fee_applied": False,
            "fee_amount": 0.0,
            "tx": tx_resp,
            "close_bucket": True,
        }

        cx.execute(
            """
            INSERT INTO bot_withdrawals(
              account_id, amount, status, dest_pub, created_at, txid, raw_json
            )
            VALUES (?, ?, 'sent', ?, ?, ?, ?)
            """,
            (
                account_id,
                current_balance,
                wallet_pub,
                ts,
                tx_hash,
                json.dumps(audit_payload),
            ),
        )

        # Mark bucket deleted
        cx.execute(
            """
            UPDATE bot_buckets
               SET status = 'deleted', updated_at = ?
             WHERE id = ?
            """,
            (ts, bucket_id),
        )

    return jsonify(
        ok=True,
        bucket_id=bucket_id,
        withdrawn_amount=current_balance,
        tx_hash=tx_hash,
    )


# ----------------------------------------------------------------------
# OLD: Delete a bucket with dust / fee rules
# (kept for compatibility – your frontend should now prefer
#  /api/trading/bucket/liquidate + /api/trading/bucket/close instead)
# ----------------------------------------------------------------------
@izza_bot_bp.route("/api/trading/bucket/delete", methods=["POST"])
def bucket_delete():
    """
    POST JSON:
      {
        "username": "CamMac",
        "bucket_id": 1
      }

    Legacy behavior:
      - Allows deleting a bucket only when its allocation is zero or below 1 test Pi,
        with specific dust/fee semantics.
      - Does NOT withdraw funds – used before the new close-bucket flow existed.

    Your new flow should:
      - Use /api/trading/bucket/liquidate to flatten to PI
      - Then /api/trading/bucket/close to withdraw + delete

    This route is left as-is so any old calls don't explode, but you
    can stop using it in the frontend.
    """
    data = request.get_json() or {}
    username = (data.get("username") or "").strip()
    bucket_id = data.get("bucket_id")

    if not username:
        return jsonify(ok=False, error="username is required")

    try:
        bucket_id = int(bucket_id)
    except Exception:
        return jsonify(ok=False, error="bucket_id must be integer")

    uname = username.strip().lstrip("@").lower()
    ts = _now()
    EPS = 1e-7

    with conn() as cx:
        acct_row = cx.execute(
            """
            SELECT id
              FROM bot_accounts
             WHERE username = ?
            """,
            (uname,),
        ).fetchone()

        if not acct_row:
            return jsonify(ok=False, error="Bot account not found for user.")

        account_id = acct_row["id"]

        # bucket must belong to this account
        b_row = cx.execute(
            """
            SELECT id, account_id, status
              FROM bot_buckets
             WHERE id = ?
            """,
            (bucket_id,),
        ).fetchone()

        if not b_row or b_row["account_id"] != account_id:
            return jsonify(ok=False, error="Bucket not found for this user.")

        # check allocation amount
        alloc_row = cx.execute(
            """
            SELECT id, amount
              FROM bot_bucket_allocations
             WHERE account_id = ? AND bucket_id = ?
            """,
            (account_id, bucket_id),
        ).fetchone()

        mode = "zero"
        abandoned_balance = 0.0
        fee_amount = 0.0

        if alloc_row:
            balance = float(alloc_row["amount"] or 0.0)

            if balance > EPS:
                # dust delete: 0 < balance < 1 test Pi
                if balance < SHORT_TERM_WITHDRAW_FEE - EPS:
                    mode = "dust"
                    abandoned_balance = balance
                # fee delete: balance is basically exactly 1 test Pi
                elif abs(balance - SHORT_TERM_WITHDRAW_FEE) <= 1e-6:
                    mode = "fee"
                    fee_amount = SHORT_TERM_WITHDRAW_FEE
                else:
                    # More than 1 test Pi – user must withdraw first
                    return jsonify(
                        ok=False,
                        error=(
                            "Bucket still has more than 1 test Pi. "
                            "Withdraw funds down to 1.0000000 test Pi or less before deleting. "
                            "You can then either abandon less than 1 test Pi "
                            "(which will stay in the IZZA BOT wallet forever) "
                            "or leave exactly 1.0000000 test Pi as a short-term trading fee "
                            "when deleting."
                        ),
                    )

            # ensure allocation amount is zeroed for clarity (funds stay in bot wallet)
            cx.execute(
                """
                UPDATE bot_bucket_allocations
                   SET amount = 0, updated_at = ?
                 WHERE id = ?
                """,
                (ts, alloc_row["id"]),
            )

        # mark bucket as deleted
        cx.execute(
            """
            UPDATE bot_buckets
               SET status = 'deleted', updated_at = ?
             WHERE id = ?
            """,
            (ts, bucket_id),
        )

    return jsonify(
        ok=True,
        bucket_id=bucket_id,
        mode=mode,
        abandoned_balance=abandoned_balance,
        fee_amount=fee_amount,
    )


# ----------------------------------------------------------------------
# NEW: Direct withdrawal from IZZA wallet to ANY Pi Testnet pubkey
# ----------------------------------------------------------------------
@izza_bot_bp.route("/api/trading/wallet/withdraw", methods=["POST"])
def wallet_direct_withdraw():
    """
    POST JSON:
      {
        "username": "CamMac",
        "amount": 5.0,
        "dest_pub": "G....",   # any Pi Testnet public key
        "secret": "S..."       # IZZA wallet secret (in this browser only)
      }

    Flow:
      - verify secret matches stored IZZA wallet pub for username
      - validate dest_pub as a public key
      - horizon check: wallet has >= amount
      - send native payment from IZZA wallet -> dest_pub
      - no DB changes (this is a pure wallet-level withdrawal)
    """
    data = request.get_json() or {}
    username = (data.get("username") or "").strip()
    amount = data.get("amount")
    dest_pub = (data.get("dest_pub") or "").strip()
    secret = (data.get("secret") or "").strip()

    if not username:
        return jsonify(ok=False, error="username is required")
    if not secret:
        return jsonify(ok=False, error="Missing wallet secret.")
    if not dest_pub:
        return jsonify(ok=False, error="Destination public key is required.")

    try:
        amount = float(amount)
    except Exception:
        return jsonify(ok=False, error="amount must be numeric")
    if amount <= 0:
        return jsonify(ok=False, error="amount must be positive")

    # Validate dest_pub looks like a Stellar/Pi public key
    try:
        Keypair.from_public_key(dest_pub)
    except Exception:
        return jsonify(ok=False, error="Destination public key is invalid.")

    uname = username.strip().lstrip("@").lower()

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
        return jsonify(ok=False, error="Insufficient PI balance in IZZA wallet for this withdrawal.")

    # Execute payment wallet -> dest_pub
    try:
        tx_resp = _send_native_payment(
            from_secret=secret,
            to_pub=dest_pub,
            amount=amount,
            memo_text="IZZA BOT wallet withdraw",
        )
        tx_hash = tx_resp.get("hash")
    except Exception as e:
        return jsonify(ok=False, error=f"Network error submitting wallet withdrawal: {e}")

    return jsonify(
        ok=True,
        tx_hash=tx_hash,
        dest_pub=dest_pub,
        amount=amount,
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


# ----------------------------------------------------------------------
# NEW: Option C – list recent trades for this user
# ----------------------------------------------------------------------
@izza_bot_bp.route("/api/trading/trades", methods=["GET"])
def list_trades():
    """
    GET /api/trading/trades?username=...&limit=50

    Returns the most recent trades across all buckets for this user.
    Only reads from bot_trades + joins with bot_buckets + bot_accounts.
    """
    username = (request.args.get("username") or "").strip()
    limit = request.args.get("limit", "50").strip() or "50"

    if not username:
        return jsonify(ok=False, error="username is required")

    try:
        limit_i = int(limit)
    except Exception:
        limit_i = 50
    if limit_i <= 0:
        limit_i = 50
    if limit_i > 200:
        limit_i = 200

    uname = username.strip().lstrip("@").lower()

    with conn() as cx:
        acct = cx.execute(
            "SELECT id FROM bot_accounts WHERE username = ?",
            (uname,),
        ).fetchone()
        if not acct:
            return jsonify(ok=True, trades=[])

        rows = cx.execute(
            """
            SELECT
              t.id,
              t.bucket_id,
              b.name AS bucket_name,
              t.code,
              t.issuer,
              t.side,
              t.price_pi,
              t.amount_token,
              t.amount_pi,
              t.strategy_tag,
              t.risk_level,
              t.created_at,
              t.tx_hash
            FROM bot_trades t
            JOIN bot_buckets b
              ON b.id = t.bucket_id
            JOIN bot_accounts a
              ON a.id = b.account_id
           WHERE a.id = ?
           ORDER BY t.id DESC
           LIMIT ?
            """,
            (acct["id"], limit_i),
        ).fetchall()

    trades = []
    for r in rows:
        ts = int(r["created_at"] or 0)
        created_at_human = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(ts)) if ts else ""
        trades.append(
            {
                "id": r["id"],
                "bucket_id": r["bucket_id"],
                "bucket_name": r["bucket_name"],
                "code": r["code"],
                "issuer": r["issuer"],
                "side": r["side"],
                "price_pi": float(r["price_pi"] or 0.0),
                "amount_token": float(r["amount_token"] or 0.0),
                "amount_pi": float(r["amount_pi"] or 0.0),
                "strategy_tag": r["strategy_tag"],
                "risk_level": r["risk_level"],
                "created_at": ts,
                "created_at_human": created_at_human,
                "tx_hash": r["tx_hash"],
            }
        )

    return jsonify(ok=True, trades=trades)
