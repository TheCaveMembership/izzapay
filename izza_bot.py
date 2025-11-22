# izza_bot.py
from flask import Blueprint, render_template, current_app, jsonify, request

izza_bot_bp = Blueprint("izza_bot", __name__)

@izza_bot_bp.route("/bot", methods=["GET"])
def bot_home():
    """
    Serves the IZZA BOT page.
    """
    trader_pub = current_app.config.get("TRADER_DEPOSIT_PUB") or "SET_TRADER_DEPOSIT_PUB_IN_APP_PY"
    sandbox    = bool(current_app.config.get("PI_SANDBOX", True))
    app_id     = current_app.config.get("PI_APP_ID", "")

    return render_template(
        "bot.html",                 # save your IZZA BOT HTML as templates/bot.html
        TRADER_DEPOSIT_PUB=trader_pub,
        PI_SANDBOX="true" if sandbox else "false",
        PI_APP_ID=app_id,
    )


@izza_bot_bp.route("/api/trading/config", methods=["POST"])
def save_trading_config():
    """
    Simple V1 endpoint for your front-end call:
      POST /api/trading/config
      { risk_level, time_horizon_days, target_value_back }
    For now we just accept and return ok. You can later wire this to SQLite.
    """
    data = request.get_json() or {}

    risk_level        = data.get("risk_level")
    horizon_days      = data.get("time_horizon_days")
    target_value_back = data.get("target_value_back")

    # TODO later: persist to DB keyed by Pi username / wallet
    # For now just acknowledge so the UI shows "saved"
    return jsonify(ok=True, risk_level=risk_level, time_horizon_days=horizon_days, target_value_back=target_value_back)
