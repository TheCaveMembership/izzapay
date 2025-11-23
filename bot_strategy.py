# bot_strategy.py
#
# Builds and executes trades for all IZZA BOT buckets according to
# Option B:
#   - Low: PI + top-2 liquidity tokens, defensive
#   - Medium: more tokens, breakout-ish
#   - High: aggressive, trending tokens
#
# This is meant to be run as a backend job (cron / worker).
# It reads bucket balances from the DB, scans markets, and submits offers
# using bot_trader.* helpers.

import os
import time
from dataclasses import dataclass
from typing import List, Dict, Any

from decimal import Decimal

from stellar_sdk import Asset

from db import conn
from bot_markets import scan_markets_vs_pi  # you already have this module
from bot_trader import market_buy, market_sell

HORIZON_URL = os.getenv("HORIZON_URL", "https://api.testnet.minepi.com").strip()


@dataclass
class Bucket:
    id: int
    account_id: int
    username: str
    risk_level: str
    objective: str
    volatility: str
    time_horizon_days: int
    balance: float


@dataclass
class TradeInstruction:
    bucket_id: int
    username: str
    action: str  # "buy" or "sell"
    code: str
    issuer: str
    amount_pi: float | None = None   # for buys (budget)
    amount_token: float | None = None  # for sells
    reason: str = ""


# ---------------------------------------------------------
# Load buckets + balances
# ---------------------------------------------------------

def load_active_buckets() -> List[Bucket]:
    """
    Load all buckets that currently have a positive balance and are active.
    """
    buckets: List[Bucket] = []
    with conn() as cx:
        rows = cx.execute(
            """
            SELECT
              b.id AS bucket_id,
              b.account_id,
              a.username,
              b.risk_level,
              b.objective,
              b.volatility,
              b.time_horizon_days,
              IFNULL(alloc.amount, 0) AS balance
            FROM bot_buckets b
            JOIN bot_accounts a ON a.id = b.account_id
            LEFT JOIN bot_bucket_allocations alloc
              ON alloc.bucket_id = b.id
             AND alloc.account_id = b.account_id
            WHERE IFNULL(alloc.amount, 0) > 0
              AND (b.status IS NULL OR b.status = 'active')
            ORDER BY a.username, b.id
            """
        ).fetchall()

    for r in rows:
        buckets.append(
            Bucket(
                id=r["bucket_id"],
                account_id=r["account_id"],
                username=r["username"],
                risk_level=(r["risk_level"] or "medium").lower(),
                objective=(r["objective"] or "balanced").lower(),
                volatility=(r["volatility"] or "medium").lower(),
                time_horizon_days=int(r["time_horizon_days"] or 10),
                balance=float(r["balance"] or 0),
            )
        )
    return buckets


# ---------------------------------------------------------
# Option-B configs per risk level
# ---------------------------------------------------------

def risk_config(risk_level: str) -> Dict[str, Any]:
    rl = (risk_level or "medium").lower()

    if rl == "low":
        return {
            "name": "low",
            "max_tokens": 2,
            "min_pool_pi": 30.0,
            "max_spread_pct": 5.0,
            "min_volume_24h_pi": 20.0,
            "token_budget_fraction": 0.20,   # up to 20% of bucket per selected token
            "overall_token_fraction": 0.60,  # keep ~40% in PI
        }
    if rl == "high":
        return {
            "name": "high",
            "max_tokens": 10,
            "min_pool_pi": 3.0,
            "max_spread_pct": 20.0,
            "min_volume_24h_pi": 5.0,
            "token_budget_fraction": 0.35,   # up to 35% of bucket per token
            "overall_token_fraction": 1.00,  # can go fully into tokens
        }
    # medium
    return {
        "name": "medium",
        "max_tokens": 6,
        "min_pool_pi": 10.0,
        "max_spread_pct": 10.0,
        "min_volume_24h_pi": 10.0,
        "token_budget_fraction": 0.25,     # up to 25% of bucket per token
        "overall_token_fraction": 0.80,    # keep ~20% in PI
    }


# ---------------------------------------------------------
# Build trade list for ONE bucket
# ---------------------------------------------------------

def build_trades_for_bucket(bucket: Bucket, markets: List[Dict[str, Any]]) -> List[TradeInstruction]:
    cfg = risk_config(bucket.risk_level)
    trades: List[TradeInstruction] = []

    if bucket.balance <= 0:
        return trades

    # Filter markets according to config
    candidates = []
    for m in markets:
        code = m.get("code")
        issuer = m.get("issuer")
        spread = float(m.get("spread_pct") or 0)
        pool_pi = float(m.get("pool_depth_pi") or 0)
        vol_pi = float(m.get("volume_24h_pi") or 0)

        # Basic filters
        if not code or not issuer:
            continue
        if pool_pi < cfg["min_pool_pi"]:
            continue
        if spread <= 0 or spread > cfg["max_spread_pct"]:
            continue
        if vol_pi < cfg["min_volume_24h_pi"]:
            continue

        candidates.append(m)

    if not candidates:
        return trades

    # Sort by 24h volume descending
    candidates.sort(key=lambda m: float(m.get("volume_24h_pi") or 0), reverse=True)

    # Limit per config
    candidates = candidates[: cfg["max_tokens"]]

    # How much of this bucket can we put into tokens total?
    overall_budget_pi = bucket.balance * cfg["overall_token_fraction"]
    if overall_budget_pi <= 0:
        return trades

    # Even split budget across chosen tokens, but cap per-token fraction
    per_token_cap = bucket.balance * cfg["token_budget_fraction"]
    max_trades = len(candidates)
    if max_trades == 0:
        return trades

    per_token_budget = min(per_token_cap, overall_budget_pi / max_trades)

    if per_token_budget <= 0:
        return trades

    for m in candidates:
        code = m["code"]
        issuer = m["issuer"]
        best_ask = float(m.get("best_ask") or 0)
        if best_ask <= 0:
            # no asks, skip for now
            continue

        trades.append(
            TradeInstruction(
                bucket_id=bucket.id,
                username=bucket.username,
                action="buy",
                code=code,
                issuer=issuer,
                amount_pi=per_token_budget,
                reason=f"{bucket.risk_level} risk bucket buy {code} using ~{per_token_budget:.4f} PI",
            )
        )

    # Option-B also would contain sells / rotations,
    # but for now we only implement buys. You can extend this later
    # by reading open offers and current holdings from the bot wallet.

    return trades


# ---------------------------------------------------------
# Build trade list for ALL buckets
# ---------------------------------------------------------

def build_trades_for_all_buckets() -> List[TradeInstruction]:
    buckets = load_active_buckets()

    # scan_markets_vs_pi should hit Horizon + liquidity pools once
    markets = scan_markets_vs_pi()
    all_trades: List[TradeInstruction] = []

    for b in buckets:
        bt = build_trades_for_bucket(b, markets)
        all_trades.extend(bt)

    return all_trades


# ---------------------------------------------------------
# Execute trades
# ---------------------------------------------------------

def execute_trades(trades: List[TradeInstruction]) -> None:
    """
    Loop through trade instructions and call bot_trader.* helpers.
    Right now we only implement "buy" for simplicity.
    """
    for t in trades:
        if t.action == "buy" and t.amount_pi and t.amount_pi > 0:
            # You may want to re-read orderbook here to get current best_ask
            # For now, assume scan_markets_vs_pi already gave you best_ask in advance
            # so you’d need to attach it to the TradeInstruction if you want precision.
            # As a simple version, we do a small re-scan per trade.
            try:
                markets = scan_markets_vs_pi()
                match = next(
                    (m for m in markets if m.get("code") == t.code and m.get("issuer") == t.issuer),
                    None,
                )
                if not match:
                    print(f"[WARN] Market {t.code} not found, skipping trade.")
                    continue

                best_ask = float(match.get("best_ask") or 0)
                if best_ask <= 0:
                    print(f"[WARN] No best_ask for {t.code}, skipping.")
                    continue

                print(
                    f"[TRADE] Bucket {t.bucket_id} ({t.username}) BUY {t.code} "
                    f"spend ~{t.amount_pi:.4f} PI @ {best_ask:.6f} PI/{t.code}"
                )
                resp = market_buy(
                    token_code=t.code,
                    token_issuer=t.issuer,
                    max_cost_pi=t.amount_pi,
                    best_price=best_ask,
                )
                print("  -> submitted:", resp.get("hash", "(no hash)"))
            except Exception as e:
                print(f"[ERROR] Failed to execute buy for {t.code}: {e}")

        elif t.action == "sell" and t.amount_token and t.amount_token > 0:
            # Skeleton for future expansion
            try:
                markets = scan_markets_vs_pi()
                match = next(
                    (m for m in markets if m.get("code") == t.code and m.get("issuer") == t.issuer),
                    None,
                )
                if not match:
                    print(f"[WARN] Market {t.code} not found for sell, skipping.")
                    continue

                best_bid = float(match.get("best_bid") or 0)
                if best_bid <= 0:
                    print(f"[WARN] No best_bid for {t.code}, skipping.")
                    continue

                print(
                    f"[TRADE] Bucket {t.bucket_id} ({t.username}) SELL {t.code} "
                    f"{t.amount_token:.4f} @ {best_bid:.6f} PI/{t.code}"
                )
                resp = market_sell(
                    token_code=t.code,
                    token_issuer=t.issuer,
                    token_amount=t.amount_token,
                    best_bid=best_bid,
                )
                print("  -> submitted:", resp.get("hash", "(no hash)"))
            except Exception as e:
                print(f"[ERROR] Failed to execute sell for {t.code}: {e}")
        else:
            print(f"[SKIP] Unknown action or zero amount for trade: {t}")


if __name__ == "__main__":
    # Simple direct run:
    #   python bot_strategy.py
    # Then wire this into a cron/worker loop as needed.
    trades = build_trades_for_all_buckets()
    print(f"Built {len(trades)} trade instructions.")
    execute_trades(trades)
