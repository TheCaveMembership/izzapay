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
    Return the BOT wallet available balance for a given asset.
    This subtracts selling_liabilities so we never try to sell
    tokens already locked in open sell offers.
    """
    acct = _srv.accounts().account_id(BOT_PUB).call()
    for bal in acct.get("balances", []):
        if bal.get("asset_type") in ("credit_alphanum4", "credit_alphanum12"):
            if bal.get("asset_code") == token_code and bal.get("asset_issuer") == token_issuer:
                try:
                    balance = float(bal.get("balance") or 0.0)
                except Exception:
                    return 0.0
                try:
                    selling_liab = float(bal.get("selling_liabilities") or 0.0)
                except Exception:
                    selling_liab = 0.0
                available = balance - selling_liab
                if available < 0:
                    available = 0.0
                return available
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

    IMPORTANT:
      - Never cancel offers involving IZZA (either side), so the
        distributor's IZZA sell ladder stays intact.
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

        # ------------------------------------------------------------------
        # HARD PROTECT: never cancel offers involving IZZA
        # (this keeps the IZZA sell ladder intact on the distributor wallet)
        # ------------------------------------------------------------------
        sell_code = selling.get("asset_code")
        buy_code = buying.get("asset_code")
        if (sell_code and sell_code.upper() == "IZZA") or (buy_code and buy_code.upper() == "IZZA"):
            # skip this offer, do not cancel
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
# Self cross protection
# ------------------------------------------------------------------

def would_cross_self_sell(token_code: str, token_issuer: str, new_price: float) -> bool:
    """
    Return True if a new SELL offer on (token, PI) at new_price
    would cross any of our own existing BUY offers on the same pair.
    """
    try:
        new_price_f = float(new_price)
    except Exception:
        return False

    offers = _list_bot_offers(max_records=1000)
    best_own_buy = None

    for offer in offers:
        selling = offer.get("selling") or {}
        buying = offer.get("buying") or {}

        # Our own BUY offers for this pair are: selling native PI, buying this token
        if selling.get("asset_type") != "native":
            continue
        if buying.get("asset_code") != token_code or buying.get("asset_issuer") != token_issuer:
            continue

        try:
            p = float(offer.get("price") or "0")
        except Exception:
            continue

        if best_own_buy is None or p > best_own_buy:
            best_own_buy = p

    if best_own_buy is None:
        return False

    return new_price_f <= best_own_buy + 1e-12


def would_cross_self_buy(token_code: str, token_issuer: str, new_price: float) -> bool:
    """
    Return True if a new BUY offer on (token, PI) at new_price
    would cross any of our own existing SELL offers on the same pair.
    """
    try:
        new_price_f = float(new_price)
    except Exception:
        return False

    offers = _list_bot_offers(max_records=1000)
    best_own_sell = None

    for offer in offers:
        selling = offer.get("selling") or {}
        buying = offer.get("buying") or {}

        # Our own SELL offers for this pair are: selling this token, buying native PI
        if buying.get("asset_type") != "native":
            continue
        if selling.get("asset_code") != token_code or selling.get("asset_issuer") != token_issuer:
            continue

        try:
            p = float(offer.get("price") or "0")
        except Exception:
            continue

        if best_own_sell is None or p < best_own_sell:
            best_own_sell = p

    if best_own_sell is None:
        return False

    return new_price_f >= best_own_sell - 1e-12


def cancel_blocking_buy_offers_for_pair(
    token_code: str,
    token_issuer: str,
    min_price: float,
) -> int:
    """
    Cancel any open BUY offers on (token, PI) for this wallet where:
      - selling native PI
      - buying (token_code, token_issuer)
      - offer price >= min_price

    Used by the engine when a profitable SELL would otherwise
    cross our own BUY offer; we tear down those BUYs first so we
    can realize gains.
    """
    try:
        min_price_f = float(min_price)
    except Exception:
        return 0

    offers = _list_bot_offers(max_records=1000)
    cancelled = 0

    for offer in offers:
        selling = offer.get("selling") or {}
        buying = offer.get("buying") or {}

        # Must be: selling native PI, buying this token
        if selling.get("asset_type") != "native":
            continue
        if buying.get("asset_code") != token_code or buying.get("asset_issuer") != token_issuer:
            continue

        try:
            p = float(offer.get("price") or "0")
        except Exception:
            continue

        # Only cancel BUYs that are at or above the SELL price
        if p + 1e-12 < min_price_f:
            continue

        # Build selling asset (native PI)
        s_type = selling.get("asset_type")
        if s_type == "native":
            selling_asset = Asset.native()
        else:
            selling_asset = Asset(
                selling.get("asset_code"),
                selling.get("asset_issuer"),
            )

        # Build buying asset (the token)
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
                f"[BOT] Cancelling blocking BUY offer id={offer_id} "
                f"code={token_code} price={p} selling={selling} buying={buying}"
            )
            cancel_offer(offer_id, selling_asset, buying_asset)
            cancelled += 1
        except Exception as e:
            print(f"[BOT] Error cancelling blocking BUY offer {offer_id} ({token_code}): {e}")

    if cancelled:
        print(
            f"[BOT] cancel_blocking_buy_offers_for_pair: cancelled {cancelled} "
            f"BUY offers for {token_code} at/above {min_price_f}"
        )
    return cancelled


# ------------------------------------------------------------------
# Cancel BUY offers for blocked tokens
# ------------------------------------------------------------------

def cancel_blocked_buy_offers(block_codes: List[str]) -> int:
    """
    Cancel any open offers (BUY or SELL) where either side's asset_code
    is in block_codes, while still protecting IZZA ladder offers.

    Used for:
      - permanently blocked tokens (e.g., Datong / stables),
      - per-bucket liquidation, where we want no open offers remaining
        for that bucket's traded asset codes.
    """
    if not block_codes:
        return 0

    codes_set = {c.upper() for c in block_codes if c}
    offers = _list_bot_offers(max_records=2000)

    cancelled = 0
    for offer in offers:
        buying = offer.get("buying") or {}
        selling = offer.get("selling") or {}

        sell_code = selling.get("asset_code")
        buy_code = buying.get("asset_code")

        # Does this offer touch any of the blocked codes?
        touches_block = (
            (sell_code and sell_code.upper() in codes_set) or
            (buy_code and buy_code.upper() in codes_set)
        )
        if not touches_block:
            continue

        # HARD PROTECT: never cancel offers involving IZZA
        if (sell_code and sell_code.upper() == "IZZA") or (buy_code and buy_code.upper() == "IZZA"):
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
                f"[BOT] Cancelling BLOCKED offer id={offer_id} "
                f"sell_code={sell_code} buy_code={buy_code} "
                f"selling={selling} buying={buying}"
            )
            cancel_offer(offer_id, selling_asset, buying_asset)
            cancelled += 1
        except Exception as e:
            print(f"[BOT] Error cancelling blocked offer {offer_id} (sell={sell_code}, buy={buy_code}): {e}")

    if cancelled:
        print(
            f"[BOT] cancel_blocked_buy_offers: cancelled {cancelled} "
            f"open offers (buy/sell) for {sorted(codes_set)}"
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
