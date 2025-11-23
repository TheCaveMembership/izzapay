# bot_trader.py
#
# Handles:
#   - place sell offers
#   - place buy offers
#   - cancel offers
#   - simple market_buy / market_sell helpers
#
# All on Pi Testnet using your BOT_WALLET_* env vars.

import os
from decimal import Decimal, ROUND_DOWN

from stellar_sdk import (
    Server,
    Keypair,
    Asset,
    TransactionBuilder,
    ManageSellOffer,
    ManageBuyOffer,
)

HORIZON_URL = os.getenv("HORIZON_URL", "https://api.testnet.minepi.com").strip()
NETWORK_PASSPHRASE = os.getenv("NETWORK_PASSPHRASE", "Pi Testnet").strip()
BASE_FEE = int(os.getenv("PI_BASE_FEE_STROOPS", "100000"))

_srv = Server(horizon_url=HORIZON_URL)

BOT_PUB = os.getenv("BOT_WALLET_PUB", "").strip()
BOT_SEC = os.getenv("BOT_WALLET_SEC", "").strip()

if not BOT_PUB or not BOT_SEC:
    raise RuntimeError("BOT_WALLET_PUB and BOT_WALLET_SEC must be set in env.")

kp_bot = Keypair.from_secret(BOT_SEC)

# ------------------------------------------------------------------
# Helpers for Horizon-compatible decimals (max 7 decimal places)
# ------------------------------------------------------------------

_AMOUNT_QUANT = Decimal("0.0000001")  # 7 decimal places


def _to_amount_str(value: float) -> str:
    """
    Convert a float to a Horizon-compatible amount string
    with at most 7 digits after the decimal, rounded DOWN.
    """
    d = Decimal(str(value))
    d_q = d.quantize(_AMOUNT_QUANT, rounding=ROUND_DOWN)
    return str(d_q)


def _to_price_str(value: float) -> str:
    """
    Price helper. Not strictly required to be 7dp, but we keep it
    consistent and safe.
    """
    d = Decimal(str(value))
    d_q = d.quantize(_AMOUNT_QUANT, rounding=ROUND_DOWN)
    return str(d_q)


def _load_bot_account():
    return _srv.load_account(kp_bot.public_key)


def place_sell_offer(
    selling_asset: Asset,
    buying_asset: Asset,
    amount: float,
    price: float,
) -> dict:
    """
    Create a sell offer:
      Sell 'selling_asset' amount X, receive 'buying_asset'
      price = buying / selling
    """
    account = _load_bot_account()

    op = ManageSellOffer(
        selling=selling_asset,
        buying=buying_asset,
        amount=_to_amount_str(amount),
        price=_to_price_str(price),
        offer_id=0,  # create new
    )

    tx = (
        TransactionBuilder(
            source_account=account,
            network_passphrase=NETWORK_PASSPHRASE,
            base_fee=BASE_FEE,
        )
        .append_operation(op)
        .set_timeout(300)
        .build()
    )
    tx.sign(kp_bot)
    return _srv.submit_transaction(tx)


def place_buy_offer(
    buying_asset: Asset,
    selling_asset: Asset,
    buy_amount: float,
    price: float,
) -> dict:
    """
    Create a buy offer:
      Buy 'buying_asset' amount X, pay with 'selling_asset'
      price = cost per unit of buying_asset
    """
    account = _load_bot_account()

    op = ManageBuyOffer(
        buying=buying_asset,
        selling=selling_asset,
        amount=_to_amount_str(buy_amount),  # SDK uses 'amount' in this version
        price=_to_price_str(price),
        offer_id=0,
    )

    tx = (
        TransactionBuilder(
            source_account=account,
            network_passphrase=NETWORK_PASSPHRASE,
            base_fee=BASE_FEE,
        )
        .append_operation(op)
        .set_timeout(300)
        .build()
    )
    tx.sign(kp_bot)
    return _srv.submit_transaction(tx)


def cancel_offer(offer_id: int, selling_asset: Asset, buying_asset: Asset) -> dict:
    """
    Cancel an existing offer:
      Set amount=0 and any dummy price.
    """
    account = _load_bot_account()

    op = ManageSellOffer(
        selling=selling_asset,
        buying=buying_asset,
        amount="0",
        price="1",
        offer_id=int(offer_id),
    )

    tx = (
        TransactionBuilder(
            source_account=account,
            network_passphrase=NETWORK_PASSPHRASE,
            base_fee=BASE_FEE,
        )
        .append_operation(op)
        .set_timeout(300)
        .build()
    )
    tx.sign(kp_bot)
    return _srv.submit_transaction(tx)


def market_buy(token_code: str, token_issuer: str, max_cost_pi: float, best_price: float) -> dict:
    """
    "Market" buy by placing a buy offer at the best ask price.

    max_cost_pi = how much PI you are willing to spend
    best_price  = PI per token
    """
    token = Asset(token_code, token_issuer)
    pi = Asset.native()

    if best_price <= 0:
        raise ValueError("best_price must be positive")

    buy_amount = float(max_cost_pi) / float(best_price)
    return place_buy_offer(
        buying_asset=token,
        selling_asset=pi,
        buy_amount=buy_amount,
        price=best_price,
    )


def market_sell(token_code: str, token_issuer: str, token_amount: float, best_bid: float) -> dict:
    """
    "Market" sell by placing a sell offer at the best bid price.
    """
    token = Asset(token_code, token_issuer)
    pi = Asset.native()

    if best_bid <= 0:
        raise ValueError("best_bid must be positive")

    return place_sell_offer(
        selling_asset=token,
        buying_asset=pi,
        amount=token_amount,
        price=best_bid,
    )
