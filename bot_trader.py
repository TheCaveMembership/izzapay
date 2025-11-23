# bot_trader.py
#
# This file handles:
#   - place buy offers
#   - place sell offers
#   - cancel offers
#   - quote functions for token/PI trades
#
# Works on Pi Testnet using your HORIZON_URL + NETWORK_PASSPHRASE.

import os
from decimal import Decimal
from stellar_sdk import (
    Server,
    Keypair,
    Network,
    Asset,
    TransactionBuilder,
    ManageSellOffer,
    ManageBuyOffer
)

HORIZON_URL = os.getenv("HORIZON_URL", "https://api.testnet.minepi.com").strip()
NETWORK_PASSPHRASE = os.getenv("NETWORK_PASSPHRASE", "Pi Testnet").strip()
BASE_FEE = int(os.getenv("PI_BASE_FEE_STROOPS", "100000"))

_srv = Server(horizon_url=HORIZON_URL)


# ---------------------------------------------------------
# Load bot wallet keypair
# ---------------------------------------------------------
BOT_PUB = os.getenv("BOT_WALLET_PUB", "").strip()
BOT_SEC = os.getenv("BOT_WALLET_SEC", "").strip()

if not BOT_PUB or not BOT_SEC:
    raise RuntimeError("BOT wallet keys must be configured!")


kp_bot = Keypair.from_secret(BOT_SEC)



# ---------------------------------------------------------
# Offer Helpers
# ---------------------------------------------------------

def place_sell_offer(
    selling_asset: Asset,
    buying_asset: Asset,
    amount: float,
    price: float
) -> dict:
    """
    Create a sell offer:
      Sell 'selling_asset' amount X
      Receive 'buying_asset' at price (buying/selling)
    """
    account = _srv.load_account(kp_bot.public_key)

    op = ManageSellOffer(
        selling=selling_asset,
        buying=buying_asset,
        amount=str(Decimal(str(amount))),
        price=str(Decimal(str(price))),
        offer_id=0   # new offer
    )

    tx = (
        TransactionBuilder(
            source_account=account,
            network_passphrase=NETWORK_PASSPHRASE,
            base_fee=BASE_FEE
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
    price: float
) -> dict:
    """
    Create a buy offer:
      Buy 'buying_asset' amount X
      Pay with 'selling_asset'
      price = cost per buying_asset unit
    """
    account = _srv.load_account(kp_bot.public_key)

    op = ManageBuyOffer(
        buying=buying_asset,
        selling=selling_asset,
        buy_amount=str(Decimal(str(buy_amount))),
        price=str(Decimal(str(price))),
        offer_id=0
    )

    tx = (
        TransactionBuilder(
            source_account=account,
            network_passphrase=NETWORK_PASSPHRASE,
            base_fee=BASE_FEE
        )
        .append_operation(op)
        .set_timeout(300)
        .build()
    )

    tx.sign(kp_bot)
    return _srv.submit_transaction(tx)



def cancel_offer(offer_id: int, selling_asset: Asset, buying_asset: Asset) -> dict:
    """
    Cancel offer by setting amount to 0.
    """

    account = _srv.load_account(kp_bot.public_key)

    op = ManageSellOffer(
        selling=selling_asset,
        buying=buying_asset,
        amount="0",
        price="1",
        offer_id=int(offer_id)
    )

    tx = (
        TransactionBuilder(
            source_account=account,
            network_passphrase=NETWORK_PASSPHRASE,
            base_fee=BASE_FEE
        )
        .append_operation(op)
        .set_timeout(300)
        .build()
    )

    tx.sign(kp_bot)
    return _srv.submit_transaction(tx)



# ---------------------------------------------------------
# Strategy Helper: simple “market buy” using best ask
# ---------------------------------------------------------
def market_buy(token_code: str, token_issuer: str, max_cost_pi: float, best_price: float) -> dict:
    """
    Executes a market-buy style operation:
    - user wants to spend <max_cost_pi>
    - best ask price = PI per token
    - compute buy_amount = max_cost_pi / best_price
    """

    token = Asset(token_code, token_issuer)
    pi = Asset.native()

    buy_amount = float(max_cost_pi) / float(best_price)

    return place_buy_offer(
        buying_asset=token,
        selling_asset=pi,
        buy_amount=buy_amount,
        price=best_price
    )


# ---------------------------------------------------------
# Strategy Helper: simple “market sell” using best bid
# ---------------------------------------------------------
def market_sell(token_code: str, token_issuer: str, token_amount: float, best_bid: float) -> dict:
    """
    Sells token_amount of token using the best bid price.
    """

    token = Asset(token_code, token_issuer)
    pi = Asset.native()

    return place_sell_offer(
        selling_asset=token,
        buying_asset=pi,
        amount=token_amount,
        price=best_bid
    )
