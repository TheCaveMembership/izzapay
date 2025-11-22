# izza_bot.py
import time
from flask import Blueprint, render_template, jsonify, request
from db import conn

izza_bot_bp = Blueprint("izza_bot", __name__)

# ---------------------------------------------------------
# HARD-CODED TESTNET TRADING-BOT DEPOSIT ACCOUNT
# (Users send TEST PI here)
# ---------------------------------------------------------
TRADING_BOT_TESTNET_DEPOSIT = "GAIXMJ22FKXXGDPQMZWR3GL24PM5UEPUCFNK4FSMJOZ3HTGPXSEQZ5AF"

# Always force Pi SDK sandbox for the bot
BOT_PI_SANDBOX = "true"


def _now() -> int:
    return int(time.time())


def _get_or_create_bot_account(username: str, wallet_pub: str) -> int:
    """
    Ensure there is a bot_accounts row for (username, wallet_pub).
    Returns account_id.
    """
    if not username:
        raise ValueError("username required")
    if not wallet_pub:
        raise ValueError("wallet_pub required")

    with conn() as cx:
        row = cx.execute(
            "SELECT id FROM bot_accounts WHERE username = ? AND wallet_pub = ?",
            (username, wallet_pub),
        ).fetchone()
        if row:
            return row["id"]

        ts = _now()
        cur = cx.execute(
            """
            INSERT INTO bot_accounts (username, wallet_pub, created_at, updated_at)
            VALUES (?, ?, ?, ?)
            """,
            (username, wallet_pub, ts, ts),
        )
        return cur.lastrowid


def _upsert_default_bucket(account_id: int,
                           name: str,
                           objective: str,
                           risk_level: str,
                           volatility: str,
                           time_horizon_days: int,
                           target_value_back: float) -> int:
    """
    For now we treat everything as a single 'default' bucket per account.
    Later we can extend this to multiple named buckets via a new API.
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


def _validate_profile(time_horizon_days: int,
                      risk_level: str,
                      objective: str,
                      volatility: str):
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

    # Map impossible combos
    # 1) Short-term + low volatility + max growth is unrealistic
    if time_horizon_days <= 3 and objective == "max_growth" and volatility == "low":
        return False, (
            "Short-term, low-volatility cannot target maximum growth. "
            "Increase your time horizon or allow more volatility."
        )

    # 2) Low risk but high volatility makes no sense
    if risk_level == "low" and volatility == "high":
        return False, (
            "Low risk with high volatility is not supported. "
            "Either raise your risk level or lower volatility."
        )

    # 3) Low risk but objective is 'max_growth'
    if risk_level == "low" and objective == "max_growth":
        return False, (
            "Maximum growth objectives require at least medium risk. "
            "Increase your risk level or pick a balanced objective."
        )

    # Basic sanity: long horizon but 'ultra_safe' with 'high' risk (if ever added)
    # could be enforced here later.

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
        PI_APP_ID="",  # bot does not require mainnet app id
    )


@izza_bot_bp.route("/api/trading/config", methods=["POST"])
def save_trading_config():
    """
    Save the user's 'default' trading bucket profile.

    Front-end JSON:
      {
        "username": "CamMac",
        "wallet_pub": "G.....",
        "risk_level": "medium",
        "time_horizon_days": 10,
        "target_value_back": 0.85,
        "objective": "balanced",         # optional
        "volatility": "medium"           # optional
      }

    For now we just persist this as a single bucket row per account.
    Later you can add a UI for multiple named buckets that hit
    a new /api/trading/buckets endpoint.
    """
    data = request.get_json() or {}

    username           = (data.get("username") or "").strip()
    wallet_pub         = (data.get("wallet_pub") or "").strip()
    risk_level         = (data.get("risk_level") or "medium").lower()
    horizon_days       = data.get("time_horizon_days") or 10
    target_value_back  = float(data.get("target_value_back") or 0.85)
    objective          = (data.get("objective") or "balanced").lower()
    volatility         = (data.get("volatility") or risk_level).lower()

    # Basic presence checks
    if not username:
        return jsonify(ok=False, error="Missing username from request.")
    if not wallet_pub or not wallet_pub.startswith("G"):
        return jsonify(ok=False, error="Missing or invalid wallet_pub.")

    try:
        horizon_days = int(horizon_days)
    except Exception:
        return jsonify(ok=False, error="Time horizon must be an integer number of days.")

    ok, msg = _validate_profile(horizon_days, risk_level, objective, volatility)
    if not ok:
        # 200 with ok:false so front-end can show message without breaking
        return jsonify(ok=False, error=msg)

    try:
        account_id = _get_or_create_bot_account(username, wallet_pub)
        bucket_id  = _upsert_default_bucket(
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
            "wallet_pub": wallet_pub,
            "risk_level": risk_level,
            "time_horizon_days": horizon_days,
            "target_value_back": target_value_back,
            "objective": objective,
            "volatility": volatility,
        },
    )


@izza_bot_bp.route("/api/trading/buckets", methods=["GET"])
def list_buckets():
    """
    Optional helper endpoint for future UI.

    GET /api/trading/buckets?username=...&wallet_pub=...

    Returns all buckets for that IZZA BOT account.
    """
    username   = (request.args.get("username") or "").strip()
    wallet_pub = (request.args.get("wallet_pub") or "").strip()

    if not username or not wallet_pub:
        return jsonify(ok=False, error="username and wallet_pub are required")

    with conn() as cx:
        acct = cx.execute(
            "SELECT id FROM bot_accounts WHERE username = ? AND wallet_pub = ?",
            (username, wallet_pub),
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
