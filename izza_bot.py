# izza_bot.py
from flask import Blueprint, render_template, jsonify, request

izza_bot_bp = Blueprint("izza_bot", __name__)

# ---------------------------------------------------------
# HARD-CODED TESTNET TRADING-BOT DEPOSIT ACCOUNT
# (Users send TEST PI here)
# ---------------------------------------------------------
TRADING_BOT_TESTNET_DEPOSIT = "GAIXMJ22FKXXGDPQMZWR3GL24PM5UEPUCFNK4FSMJOZ3HTGPXSEQZ5AF"

# Always force Pi SDK sandbox for the bot
BOT_PI_SANDBOX = "true"


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
        PI_APP_ID=""  # bot does not require mainnet app id
    )


@izza_bot_bp.route("/api/trading/config", methods=["POST"])
def save_trading_config():
    """
    Save the user's bot settings (risk, horizon, etc.)
    """
    data = request.get_json() or {}

    risk_level        = data.get("risk_level")
    horizon_days      = data.get("time_horizon_days")
    target_value_back = data.get("target_value_back")

    # TODO: save per-user config to SQLite
    return jsonify(
        ok=True,
        risk_level=risk_level,
        time_horizon_days=horizon_days,
        target_value_back=target_value_back
    )
