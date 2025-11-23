# bot_trader.py
#
# Handles:
#   - ensure trustlines automatically
#   - place sell offers
#   - place buy offers
#   - cancel offers
#   - simple market_buy / market_sell helpers
#   - manage open-offer count to avoid op_too_many_subentries
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
    ChangeTrust,
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

_AMOUNT_QUANT = Decimal("0.0000001")  # 7 dp


def _to_amount_str(value: float) -> str:
    d = Decimal(str(value))
    d_q = d.quantize(_AMOUNT_QUANT, rounding=ROUND_DOWN)
    return str(d_q)


def _to_price_str(value: float) -> str:
    d = Decimal(str(value))
    d_q = d.quantize(_AMOUNT_QUANT, rounding=ROUND_DOWN)
    return str(d_q)


def _load_bot_account():
    return _srv.load_account(kp_bot.public_key)


# ------------------------------------------------------------------
# Trustline Management
# ------------------------------------------------------------------

def ensure_trustline(token_code: str, token_issuer: str, limit: str = "1000000000"):
    """
    Ensures the BOT wallet has a trustline to the asset.
    If not, creates it automatically.
    """
    asset = Asset(token_code, token_issuer)

    acct = _srv.accounts().account_id(BOT_PUB).call()

    # Check existing balances
    for bal in acct.get("balances", []):
        if bal.get("asset_type") in ("credit_alphanum4", "credit_alphanum12"):
            if bal.get("asset_code") == token_code and bal.get("asset_issuer") == token_issuer:
                return  # already trusted

    # Create trustline
    account = _load_bot_account()

    op = ChangeTrust(
        asset=asset,
        limit=limit
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
    resp = _srv.submit_transaction(tx)

    print(f"[BOT] Trustline created for {token_code}")
    return resp


# ------------------------------------------------------------------
# Balance helper (for safe sells)
# ------------------------------------------------------------------

def get_bot_token_balance(token_code: str, token_issuer: str) -> float:
    """
    Return the BOT wallet's actual on-chain balance for a given asset.
    Used by the engine to ensure sells never exceed wallet holdings.
    """
    acct = _srv.accounts().account_id(BOT_PUB).call()
    for bal in acct.get("balances", []):
        if bal.get("asset_type") in ("credit_alphanum4", "credit_alphanum12"):
            if bal.get("asset_code") == token_code and bal.get("asset_issuer") == token_issuer:
                try:
                    return float(bal.get("balance") or 0.0)
                except Exception:
                    return 0.0
    return 0.0


# ------------------------------------------------------------------
# Offer / subentry helpers
# ------------------------------------------------------------------

def _asset_from_offer_side(side: dict) -> Asset:
    """
    Convert offer["selling"] or offer["buying"] into a stellar_sdk.Asset.
    """
    a_type = side.get("asset_type")
    if a_type == "native":
        return Asset.native()
    return Asset(side.get("asset_code"), side.get("asset_issuer"))


def get_open_offers(limit: int = 200) -> list[dict]:
    """
    Fetch current open offers for the BOT wallet (up to `limit`).
    Oldest first (order=asc).
    """
    resp = (
        _srv.offers()
        .for_seller(BOT_PUB)
        .limit(limit)
        .order("asc")
        .call()
    )
    records = (resp.get("_embedded") or {}).get("records") or []
    return records


def trim_offers_if_too_many(max_offers: int) -> int:
    """
    If the bot has more than `max_offers` open offers, cancel the oldest ones
    until we're back under the cap. Returns the number of offers cancelled.

    This is how the engine "understands" Stellar's subentry / offer limits:
    it actively cleans up stale open orders before submitting new ones.
    """
    if max_offers <= 0:
        return 0

    offers = get_open_offers(limit=200)
    count = len(offers)
    if count <= max_offers:
        return 0

    to_remove = count - max_offers
    removed = 0

    for off in offers[:to_remove]:
        try:
            offer_id = int(off.get("id"))
        except Exception:
            continue

        selling_info = off.get("selling") or {}
        buying_info = off.get("buying") or {}
        selling_asset = _asset_from_offer_side(selling_info)
        buying_asset = _asset_from_offer_side(buying_info)

        try:
            cancel_offer(offer_id=offer_id, selling_asset=selling_asset, buying_asset=buying_asset)
            removed += 1
            print(f"[BOT] Cancelled stale offer id={offer_id} to free subentries.")
        except Exception as e:
            print(f"[BOT] Failed to cancel offer id={offer_id}: {e}")

    return removed


# ------------------------------------------------------------------
# Sell Offers
# ------------------------------------------------------------------

def place_sell_offer(selling_asset: Asset, buying_asset: Asset, amount: float, price: float) -> dict:
    account = _load_bot_account()

    op = ManageSellOffer(
        selling=selling_asset,
        buying=buying_asset,
        amount=_to_amount_str(amount),
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


# ------------------------------------------------------------------
# Buy Offers
# ------------------------------------------------------------------

def place_buy_offer(buying_asset: Asset, selling_asset: Asset, buy_amount: float, price: float) -> dict:
    account = _load_bot_account()

    op = ManageBuyOffer(
        buying=buying_asset,
        selling=selling_asset,
        amount=_to_amount_str(buy_amount),  # correct keyword
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


# ------------------------------------------------------------------
# Cancel offer
# ------------------------------------------------------------------

def cancel_offer(offer_id: int, selling_asset: Asset, buying_asset: Asset) -> dict:
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


# ------------------------------------------------------------------
# Market BUY
# ------------------------------------------------------------------

def market_buy(token_code: str, token_issuer: str, max_cost_pi: float, best_price: float) -> dict:
    if best_price <= 0:
        raise ValueError("best_price must be positive")

    # Ensure trustline first
    ensure_trustline(token_code, token_issuer)

    token = Asset(token_code, token_issuer)
    pi = Asset.native()

    buy_amount = float(max_cost_pi) / float(best_price)

    return place_buy_offer(
        buying_asset=token,
        selling_asset=pi,
        buy_amount=buy_amount,
        price=best_price,
    )


# ------------------------------------------------------------------
# Market SELL
# ------------------------------------------------------------------

def market_sell(token_code: str, token_issuer: str, token_amount: float, best_bid: float) -> dict:
    if best_bid <= 0:
        raise ValueError("best_bid must be positive")

    # Ensure trustline exists so balance tracking works
    ensure_trustline(token_code, token_issuer)

    token = Asset(token_code, token_issuer)
    pi = Asset.native()

    return place_sell_offer(
        selling_asset=token,
        buying_asset=pi,
        amount=token_amount,
        price=best_bid,
    )
