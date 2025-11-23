# bot_trader.py
#
# Handles:
#   - ensure trustlines automatically
#   - manage open offers
#   - place sell offers
#   - place buy offers
#   - cancel offers
#   - cancel open BUY offers for blocked tokens
#   - simple market_buy / market_sell helpers
#
# All on Pi Testnet using your BOT_WALLET_* env vars.

import os
from decimal import Decimal, ROUND_DOWN
from typing import List, Dict, Any

import requests
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
# Helpers for Horizon compatible decimals (max 7 decimal places)
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
# Trustline management
# ------------------------------------------------------------------

def ensure_trustline(token_code: str, token_issuer: str, limit: str = "1000000000"):
    """
    Ensure the BOT wallet has a trustline to the asset.
    If not, create it automatically.
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
    Return the BOT wallet actual on chain balance for a given asset.
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
# Open offers helpers  (for subentry limit control)
# ------------------------------------------------------------------

def _list_bot_offers(max_records: int = 1000) -> List[Dict[str, Any]]:
    """
    Fetch all open offers for the bot wallet via Horizon.
    Used so we can understand and manage subentry limits.
    """
    offers: List[Dict[str, Any]] = []
    url = HORIZON_URL.rstrip("/") + "/offers"
    params = {
        "seller": BOT_PUB,
        "limit": 200,
        "order": "asc",
    }

    while True:
        r = requests.get(url, params=params, timeout=15)
        r.raise_for_status()
        data = r.json()
        recs = (data.get("_embedded") or {}).get("records") or []
        offers.extend(recs)

        if len(offers) >= max_records:
            break

        links = data.get("_links") or {}
        next_href = links.get("next", {}).get("href")
        if not next_href or next_href == url:
            break
        url = next_href
        params = None  # cursor is already encoded in next_href

    return offers


def prune_bot_offers(
    max_offers: int = 900,
    target_keep: int = 750,
) -> int:
    """
    If the bot wallet has too many open offers, cancel a batch of the
    smallest and oldest ones to free subentries.

    Returns the number of offers cancelled.
    """
    offers = _list_bot_offers(max_records=2000)
    count = len(offers)
    if count <= max_offers:
        return 0

    # Cancel up to count - target_keep offers, smallest size first.
    # That naturally clears lots of tiny dust orders created by past trading.
    to_cancel = max(0, count - target_keep)
    offers_sorted = sorted(
        offers,
        key=lambda o: (
            float(o.get("amount") or "0"),
            int(o.get("last_modified_ledger") or 0),
        ),
    )

    cancelled = 0
    for offer in offers_sorted[:to_cancel]:
        selling = offer.get("selling") or {}
        buying = offer.get("buying") or {}

        # Build selling asset
        s_type = selling.get("asset_type")
        if s_type == "native":
            selling_asset = Asset.native()
        else:
            selling_asset = Asset(
                selling.get("asset_code"),
                selling.get("asset_issuer"),
            )

        # Build buying asset
        b_type = buying.get("asset_type")
        if b_type == "native":
            buying_asset = Asset.native()
        else:
            buying_asset = Asset(
                buying.get("asset_code"),
                buying.get("asset_issuer"),
            )

        offer_id = int(offer.get("id"))

        try:
            print(
                f"[BOT] Cancelling offer id={offer_id} "
                f"amount={offer.get('amount')} selling={selling} buying={buying}"
            )
            cancel_offer(offer_id, selling_asset, buying_asset)
            cancelled += 1
        except Exception as e:
            print(f"[BOT] Error cancelling offer {offer_id}: {e}")

    print(
        f"[BOT] prune_bot_offers: had={count}, cancelled={cancelled}, "
        f"target_keep={target_keep}"
    )
    return cancelled


def ensure_offer_capacity(
    min_free_slots: int = 20,
    max_offers: int = 950,
):
    """
    Make sure the bot account has room for new offers.
    If we are close to the subentry cap, prune before submitting.
    """
    offers = _list_bot_offers(max_records=2000)
    count = len(offers)
    if count >= max_offers - min_free_slots:
        print(
            f"[BOT] Offer count={count} close to limit, pruning before new trade..."
        )
        prune_bot_offers(max_offers=max_offers, target_keep=max_offers - 80)


# ------------------------------------------------------------------
# Cancel BUY offers for blocked tokens
# ------------------------------------------------------------------

def cancel_blocked_buy_offers(block_codes: List[str]) -> int:
    """
    Cancel any open BUY offers where the bot is buying one of the
    blocked token codes using native PI.
    This is used when we decide to permanently stop buying certain
    stablecoins / Datong tokens.
    """
    if not block_codes:
        return 0

    codes_set = {c.upper() for c in block_codes if c}
    offers = _list_bot_offers(max_records=2000)

    cancelled = 0
    for offer in offers:
        buying = offer.get("buying") or {}
        selling = offer.get("selling") or {}

        code = buying.get("asset_code")
        if not code or code.upper() not in codes_set:
            continue

        # We only care about BUY offers where we are selling native PI
        if selling.get("asset_type") != "native":
            continue

        # Build selling asset
        s_type = selling.get("asset_type")
        if s_type == "native":
            selling_asset = Asset.native()
        else:
            selling_asset = Asset(
                selling.get("asset_code"),
                selling.get("asset_issuer"),
            )

        # Build buying asset
        b_type = buying.get("asset_type")
        if b_type == "native":
            buying_asset = Asset.native()
        else:
            buying_asset = Asset(
                buying.get("asset_code"),
                buying.get("asset_issuer"),
            )

        offer_id = int(offer.get("id") or 0)

        try:
            print(
                f"[BOT] Cancelling BLOCKED BUY offer id={offer_id} "
                f"code={code} selling={selling} buying={buying}"
            )
            cancel_offer(offer_id, selling_asset, buying_asset)
            cancelled += 1
        except Exception as e:
            print(f"[BOT] Error cancelling blocked BUY offer {offer_id} ({code}): {e}")

    if cancelled:
        print(
            f"[BOT] cancel_blocked_buy_offers: cancelled {cancelled} "
            f"open BUY offers for {sorted(codes_set)}"
        )
    return cancelled


# ------------------------------------------------------------------
# Sell offers
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
# Buy offers
# ------------------------------------------------------------------

def place_buy_offer(buying_asset: Asset, selling_asset: Asset, buy_amount: float, price: float) -> dict:
    account = _load_bot_account()

    op = ManageBuyOffer(
        buying=buying_asset,
        selling=selling_asset,
        amount=_to_amount_str(buy_amount),
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
# Market BUY (orderbook-only: use best ask / current market price)
# ------------------------------------------------------------------

def market_buy(token_code: str, token_issuer: str, max_cost_pi: float, best_price: float) -> dict:
    """
    Place a BUY limited at the current best ask / market price.
    We always price off the orderbook, never LP.
    """
    if best_price <= 0:
        raise ValueError("best_price must be positive")

    # Control subentries first
    ensure_offer_capacity()

    # Ensure trustline
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
# Market SELL (used also for quick wall-break limit sells)
# ------------------------------------------------------------------

def market_sell(token_code: str, token_issuer: str, token_amount: float, best_bid: float) -> dict:
    """
    Place a SELL limited at the given price.
    Normally this is the current best bid (orderbook market price),
    but the engine can also pass a higher target price when it wants
    to scalp after breaking a wall.
    """
    if best_bid <= 0:
        raise ValueError("best_bid must be positive")

    # Control subentries first
    ensure_offer_capacity()

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
