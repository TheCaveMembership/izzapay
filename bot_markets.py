# bot_markets.py
#
# Helpers for discovering and analyzing Pi Testnet tokens and markets.
#
# Uses the same HORIZON_URL environment variable as the rest of your app.
# Focuses on:
#   - Listing non-native assets (tokens) with basic stats
#   - Pulling order books for token/PI pairs
#   - Deriving simple metrics: mid price, spread, depth, etc.

import os
from decimal import Decimal
from typing import Dict, Any, List

import requests
from stellar_sdk import Asset

HORIZON_URL = os.getenv("HORIZON_URL", "https://api.testnet.minepi.com").strip()

# Optional LP scan toggles (safe defaults: OFF)
LP_SCAN_ENABLED = os.getenv("BOT_ENABLE_LP_SCAN", "false").lower() == "true"
LP_SCAN_MAX_ASSETS = int(os.getenv("BOT_LP_SCAN_MAX_ASSETS", "200"))  # per run cap
LP_SCAN_TIMEOUT_SECS = int(os.getenv("BOT_LP_SCAN_TIMEOUT_SECS", "10"))


# ---------------------------------------------------------
# Generic Horizon helpers
# ---------------------------------------------------------

def _get(url: str, params: Dict[str, Any] | None = None, timeout: int = 15) -> Dict[str, Any]:
    r = requests.get(url, params=params or {}, timeout=timeout)
    r.raise_for_status()
    return r.json()


def _iter_horizon_collection(
    path: str,
    params: Dict[str, Any] | None = None,
    max_records: int = 500
):
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


# ---------------------------------------------------------
# Asset discovery (FIXED num_accounts handling)
# ---------------------------------------------------------

def list_testnet_assets(
    max_records: int = 2500,
    min_num_accounts: int = 2,
    exclude_native: bool = True,
) -> List[Dict[str, Any]]:
    """
    Fetch Pi Testnet token list.
    FIXED: Horizon does NOT return `num_accounts`, we must derive it from:
            accounts.authorized + accounts.unauthorized

    NOTE: We also exclude any asset whose code starts with "EGG"
          so NFT EGG assets do not get sent to the trading bot.
    """
    assets: List[Dict[str, Any]] = []

    for rec in _iter_horizon_collection("assets", {"limit": 200, "order": "asc"}, max_records=max_records):

        asset_type = rec.get("asset_type")
        if exclude_native and asset_type == "native":
            continue

        code = rec.get("asset_code")
        issuer = rec.get("asset_issuer")

        # Skip EGG* assets (IZZA NFT eggs etc.) so they never reach the bot
        if code and code.upper().startswith("EGG"):
            continue

        # FIX: derive num_accounts from `accounts` object
        accounts_info = rec.get("accounts") or {}

        if rec.get("num_accounts") is not None:
            num_accounts = int(rec.get("num_accounts") or 0)
        else:
            num_accounts = int(
                (accounts_info.get("authorized") or 0)
                + (accounts_info.get("unauthorized") or 0)
            )

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
    return Asset(code, issuer)


# ---------------------------------------------------------
# LP helpers (AMM price)
# ---------------------------------------------------------

def get_liquidity_pool_price_token_vs_pi(
    token_code: str,
    token_issuer: str,
) -> Dict[str, float] | None:
    """
    Try to find a liquidity pool for (PI, token) and derive:
      - amm_price_pi: PI per token from AMM reserves
      - amm_liquidity_pi: rough PI-side depth (2 * PI_reserve as a proxy)

    This is best-effort and only used when LP_SCAN_ENABLED is true.
    If anything fails, returns None and the caller just ignores AMM info.
    """
    try:
        # Stellar-style /liquidity_pools endpoint – Pi Testnet Horizon
        # follows the same shape.
        url = HORIZON_URL.rstrip("/") + "/liquidity_pools"
        # We request pools that contain BOTH native PI and this credit asset.
        params = {
            "reserves": f"native,{token_code}:{token_issuer}",
            "limit": 1,
        }
        data = _get(url, params=params, timeout=LP_SCAN_TIMEOUT_SECS)
        pools = (data.get("_embedded") or {}).get("records") or []
        if not pools:
            return None

        pool = pools[0]
        reserves = pool.get("reserves") or []
        if len(reserves) < 2:
            return None

        pi_reserve = None
        token_reserve = None
        for r in reserves:
            asset = r.get("asset")
            amount_str = r.get("amount") or "0"
            amt = float(amount_str)
            if asset == "native":
                pi_reserve = amt
            else:
                # asset is like "CODE:ISSUER"
                token_reserve = amt

        if not pi_reserve or not token_reserve or token_reserve <= 0:
            return None

        amm_price_pi = pi_reserve / token_reserve
        # Simple proxy for "how deep is this pool" – 2 * PI side (x + y)
        amm_liq_pi = 2.0 * pi_reserve

        return {
            "amm_price_pi": float(amm_price_pi),
            "amm_liquidity_pi": float(amm_liq_pi),
        }
    except Exception as e:
        print(f"[LP] get_liquidity_pool_price_token_vs_pi error for {token_code}:{token_issuer}: {e}")
        return None


# ---------------------------------------------------------
# Orderbook data
# ---------------------------------------------------------

def get_orderbook_token_vs_pi(
    token_code: str,
    token_issuer: str,
    mode: str = "token_selling_pi_buying"
) -> Dict[str, Any]:

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
        raise ValueError("Invalid orderbook mode.")

    url = HORIZON_URL.rstrip("/") + "/order_book"
    return _get(url, params=params)


def analyze_orderbook(orderbook: Dict[str, Any]) -> Dict[str, Any]:
    """
    Summarize orderbook, but ALSO keep raw bids/asks so higher-level
    logic (wall-breaking, quick scalps) can see the real ladder.

    All prices are PI per token.
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
        # NEW: pass-through raw ladders so bot_engine can see real wall sizes
        "bids": bids,
        "asks": asks,
    }


# ---------------------------------------------------------
# Market scanner
# ---------------------------------------------------------

def scan_markets_vs_pi(
    max_assets: int = 2500,
    min_num_accounts: int = 2,
    max_spread_pct: float | None = None,
):
    tokens = list_testnet_assets(
        max_records=max_assets,
        min_num_accounts=min_num_accounts,
        exclude_native=True,
    )

    results: List[Dict[str, Any]] = []

    lp_scanned = 0

    for t in tokens:
        code = t["code"]
        issuer = t["issuer"]

        try:
            ob_sell_token = get_orderbook_token_vs_pi(code, issuer, "token_selling_pi_buying")
            ob_sell_pi    = get_orderbook_token_vs_pi(code, issuer, "pi_selling_token_buying")

            stats_sell_token = analyze_orderbook(ob_sell_token)
            stats_sell_pi    = analyze_orderbook(ob_sell_pi)

        except Exception as e:
            print(f"[scan_markets_vs_pi] error for {code}:{issuer}: {e}")
            continue

        mid_price = stats_sell_token.get("mid_price") or stats_sell_pi.get("mid_price")
        approx_liq_pi = None
        if mid_price and mid_price > 0:
            approx_liq_pi = (
                (stats_sell_token.get("total_bid_liquidity") or 0) * mid_price
                + (stats_sell_pi.get("total_bid_liquidity") or 0)
            )

        spread_candidates = [
            x for x in [
                stats_sell_token.get("spread_pct"),
                stats_sell_pi.get("spread_pct")
            ] if x is not None
        ]
        max_spread = max(spread_candidates) if spread_candidates else None

        if max_spread_pct and max_spread and max_spread > max_spread_pct:
            continue

        amm_price_pi = None
        amm_liq_pi = None

        # Optional LP scan: only when enabled + under per-run cap
        if LP_SCAN_ENABLED and lp_scanned < LP_SCAN_MAX_ASSETS:
            lp_info = get_liquidity_pool_price_token_vs_pi(code, issuer)
            if lp_info:
                amm_price_pi = lp_info.get("amm_price_pi")
                amm_liq_pi = lp_info.get("amm_liquidity_pi")
            lp_scanned += 1

        results.append({
            "code": code,
            "issuer": issuer,
            "num_accounts": t["num_accounts"],
            "amount": t["amount"],
            "orderbook_sell_token": stats_sell_token,
            "orderbook_sell_pi": stats_sell_pi,
            "approx_liquidity_pi": approx_liq_pi,
            "max_spread_pct": max_spread,
            # NEW: AMM view (if available)
            "amm_price_pi": amm_price_pi,
            "amm_liquidity_pi": amm_liq_pi,
        })

    results.sort(key=lambda r: (r["approx_liquidity_pi"] or 0), reverse=True)
    return results


if __name__ == "__main__":
    markets = scan_markets_vs_pi(max_assets=100, min_num_accounts=2)
    for m in markets[:10]:
        print(
            m["code"],
            "num_accounts=", m["num_accounts"],
            "liq≈", m["approx_liquidity_pi"],
            "spread%", m["max_spread_pct"],
            "amm_price_pi=", m.get("amm_price_pi"),
            "amm_liq_pi=", m.get("amm_liquidity_pi"),
        )
