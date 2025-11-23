# bot_markets.py
#
# Helpers for discovering and analyzing Pi Testnet tokens and markets.
#
# Uses the same HORIZON_URL environment variable as the rest of your app.
# Focuses on:
#   - Listing non-native assets (tokens) with basic stats
#   - Pulling order books for token/PI pairs
#   - Deriving simple metrics: mid price, spread, depth, etc.
#
# You can call these from a script, a cron job, or from your izza_bot blueprint
# later to feed data into the DB / strategies.

import os
from decimal import Decimal
from typing import Dict, Any, List, Tuple, Optional

import requests
from stellar_sdk import Asset

HORIZON_URL = os.getenv("HORIZON_URL", "https://api.testnet.minepi.com").strip()


# ---------------------------------------------------------
# Generic Horizon helpers
# ---------------------------------------------------------

def _get(url: str, params: Dict[str, Any] | None = None) -> Dict[str, Any]:
    r = requests.get(url, params=params or {}, timeout=15)
    r.raise_for_status()
    return r.json()


def _iter_horizon_collection(
    path: str,
    params: Dict[str, Any] | None = None,
    max_records: int = 500
):
    """
    Generic iterator over a Horizon collection endpoint that uses
    _embedded.records + _links.next.href pagination.
    Stops either at max_records or when Horizon has no more pages.
    """
    base_url = HORIZON_URL.rstrip("/") + "/" + path.lstrip("/")
    params = params.copy() if params else {}

    retrieved = 0
    url = base_url

    while True:
        data = _get(url, params=params if url == base_url else None)
        records = (data.get("_embedded") or {}).get("records") or []
        for rec in records:
            yield rec
            retrieved += 1
            if retrieved >= max_records:
                return

        links = data.get("_links") or {}
        next_link = links.get("next", {}).get("href")
        if not next_link or next_link == url:
            return
        url = next_link
        # after first page, Horizon puts the cursor in the URL, no need for params


# ---------------------------------------------------------
# Asset discovery: list Pi Testnet tokens
# ---------------------------------------------------------

def list_testnet_assets(
    max_records: int = 500,
    min_num_accounts: int = 2,
    exclude_native: bool = True,
) -> List[Dict[str, Any]]:
    """
    Return a list of Pi testnet assets (tokens) with basic stats.

    Filters:
      - exclude_native: skip the native PI asset
      - min_num_accounts: require at least this many accounts holding the asset
    """
    assets: List[Dict[str, Any]] = []

    for rec in _iter_horizon_collection("assets", {"limit": 200, "order": "asc"}, max_records=max_records):
        asset_type = rec.get("asset_type")
        if exclude_native and asset_type == "native":
            continue

        code = rec.get("asset_code")
        issuer = rec.get("asset_issuer")
        num_accounts = int(rec.get("num_accounts") or 0)

        if min_num_accounts and num_accounts < min_num_accounts:
            continue

        assets.append({
            "asset_type": asset_type,
            "code": code,
            "issuer": issuer,
            "num_accounts": num_accounts,
            "amount": rec.get("amount"),
        })

    return assets


def build_asset(code: str, issuer: str) -> Asset:
    """
    Helper: build a stellar_sdk.Asset instance for a Pi Testnet token.
    """
    return Asset(code, issuer)


# ---------------------------------------------------------
# Orderbook data: token <-> PI markets
# ---------------------------------------------------------

def get_orderbook_token_vs_pi(
    token_code: str,
    token_issuer: str,
    mode: str = "token_selling_pi_buying"
) -> Dict[str, Any]:
    """
    Pull the on-chain order book between a token and native PI.

    mode:
      - 'token_selling_pi_buying'  => offers where people SELL token to BUY PI
      - 'pi_selling_token_buying'  => offers where people SELL PI to BUY token

    That basically gives you the "two sides" of a token/PI market.
    """
    token = build_asset(token_code, token_issuer)

    if mode == "token_selling_pi_buying":
        params = {
            "selling_asset_type": "credit_alphanum12" if len(token.code) > 4 else "credit_alphanum4",
            "selling_asset_code": token.code,
            "selling_asset_issuer": token.issuer,
            "buying_asset_type": "native",
        }
    elif mode == "pi_selling_token_buying":
        params = {
            "selling_asset_type": "native",
            "buying_asset_type": "credit_alphanum12" if len(token.code) > 4 else "credit_alphanum4",
            "buying_asset_code": token.code,
            "buying_asset_issuer": token.issuer,
        }
    else:
        raise ValueError("mode must be 'token_selling_pi_buying' or 'pi_selling_token_buying'")

    url = HORIZON_URL.rstrip("/") + "/order_book"
    return _get(url, params=params)


def analyze_orderbook(orderbook: Dict[str, Any]) -> Dict[str, Any]:
    """
    Given a Horizon order_book JSON, compute some basic stats:
      - best_bid_price, best_bid_amount
      - best_ask_price, best_ask_amount
      - mid_price
      - spread_abs, spread_pct
      - total_bid_liquidity, total_ask_liquidity

    If one side is empty, stats will have None for mid/spread.
    """
    bids = orderbook.get("bids") or []
    asks = orderbook.get("asks") or []

    def _sum_amount(levels) -> Decimal:
        total = Decimal("0")
        for lvl in levels:
            total += Decimal(str(lvl.get("amount", "0") or "0"))
        return total

    best_bid_price = Decimal(str(bids[0]["price"]) if bids else "0")
    best_ask_price = Decimal(str(asks[0]["price"]) if asks else "0")
    best_bid_amt = Decimal(str(bids[0]["amount"]) if bids else "0")
    best_ask_amt = Decimal(str(asks[0]["amount"]) if asks else "0")

    total_bid_liq = _sum_amount(bids)
    total_ask_liq = _sum_amount(asks)

    mid_price = None
    spread_abs = None
    spread_pct = None

    if bids and asks and best_bid_price > 0 and best_ask_price > 0:
        mid_price = (best_bid_price + best_ask_price) / Decimal("2")
        spread_abs = best_ask_price - best_bid_price
        if mid_price > 0:
            spread_pct = (spread_abs / mid_price) * Decimal("100")

    def _d_or_none(x):
        return None if x is None else float(x)

    return {
        "best_bid_price": _d_or_none(best_bid_price if bids else None),
        "best_bid_amount": _d_or_none(best_bid_amt if bids else None),
        "best_ask_price": _d_or_none(best_ask_price if asks else None),
        "best_ask_amount": _d_or_none(best_ask_amt if asks else None),
        "mid_price": _d_or_none(mid_price),
        "spread_abs": _d_or_none(spread_abs),
        "spread_pct": _d_or_none(spread_pct),
        "total_bid_liquidity": float(total_bid_liq),
        "total_ask_liquidity": float(total_ask_liq),
        "num_bid_levels": len(bids),
        "num_ask_levels": len(asks),
    }


# ---------------------------------------------------------
# Example: scan all tokens vs PI and rank by liquidity / spread
# ---------------------------------------------------------

def scan_markets_vs_pi(
    max_assets: int = 200,
    min_num_accounts: int = 2,
    max_spread_pct: float | None = None,
) -> List[Dict[str, Any]]:
    """
    Convenience function:
      1. List up to max_assets Pi Testnet tokens with >= min_num_accounts holders
      2. For each token, pull token/PI orderbooks (both directions)
      3. Compute basic stats and return a list of market snapshots.

    You can then:
      - store this in your DB,
      - filter for tight-spread, high-liquidity markets,
      - drive your strategies from it.
    """
    tokens = list_testnet_assets(
        max_records=max_assets,
        min_num_accounts=min_num_accounts,
        exclude_native=True,
    )

    results: List[Dict[str, Any]] = []

    for t in tokens:
        code = t["code"]
        issuer = t["issuer"]

        try:
            ob_sell_token = get_orderbook_token_vs_pi(code, issuer, "token_selling_pi_buying")
            ob_sell_pi    = get_orderbook_token_vs_pi(code, issuer, "pi_selling_token_buying")

            stats_sell_token = analyze_orderbook(ob_sell_token)
            stats_sell_pi    = analyze_orderbook(ob_sell_pi)
        except Exception as e:
            # If any single market fetch blows up, skip this asset quietly for now
            print(f"[scan_markets_vs_pi] error for {code}:{issuer}: {e}")
            continue

        # Simple combined liquidity metric in PI terms (approx) if we have mid-price
        mid_price = stats_sell_token.get("mid_price") or stats_sell_pi.get("mid_price")
        approx_liq_pi = None
        if mid_price and mid_price > 0:
            # very rough: token-side liquidity * price + PI-side liquidity
            approx_liq_pi = (
                (stats_sell_token.get("total_bid_liquidity") or 0) * mid_price
                + (stats_sell_pi.get("total_bid_liquidity") or 0)
            )

        # choose the 'worst' spread between the two books as a simple sanity check
        spread_pct_candidates = [
            x for x in [
                stats_sell_token.get("spread_pct"),
                stats_sell_pi.get("spread_pct")
            ] if x is not None
        ]
        max_spread_for_token = max(spread_pct_candidates) if spread_pct_candidates else None

        if max_spread_pct is not None and max_spread_for_token is not None:
            if max_spread_for_token > max_spread_pct:
                # skip super-wide markets if caller wants tight markets only
                continue

        results.append({
            "code": code,
            "issuer": issuer,
            "num_accounts": t["num_accounts"],
            "amount": t["amount"],
            "orderbook_sell_token": stats_sell_token,
            "orderbook_sell_pi": stats_sell_pi,
            "approx_liquidity_pi": approx_liq_pi,
            "max_spread_pct": max_spread_for_token,
        })

    # Sort by approx_liquidity_pi desc (most liquid first)
    results.sort(key=lambda r: (r["approx_liquidity_pi"] or 0), reverse=True)
    return results


if __name__ == "__main__":
    # Quick manual test:
    # Run:  python bot_markets.py
    # to print top ~10 most liquid token/PI markets on Pi Testnet (roughly).
    markets = scan_markets_vs_pi(max_assets=100, min_num_accounts=2)
    for m in markets[:10]:
        print(
            m["code"],
            "num_accounts=", m["num_accounts"],
            "liq≈", m["approx_liquidity_pi"],
            "spread%", m["max_spread_pct"]
        )
