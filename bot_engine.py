# bot_engine.py
#
# IZZA BOT trading engine.
#
# Responsibilities:
#   - Load active buckets + available PI "cash" per bucket
#   - Scan Pi Testnet markets via bot_markets.scan_markets_vs_pi
#   - Build buy / sell decisions based on bucket risk profile:
#       * Low   = mostly trend + microstructure, low vol
#       * Med   = balanced mix
#       * High  = heavy vol + microstructure, aggressive
#   - Execute trades using bot_trader.market_buy / market_sell
#   - Maintain per-bucket:
#       * cash in PI (bot_bucket_allocations.amount)
#       * positions per token (bot_positions)
#   - Log all trades into bot_trades
#
# How to run once (manual):
#     python bot_engine.py
#
# How to run in a loop (manual):
#   - BOT_LOOP_MODE=true
#   - BOT_LOOP_SLEEP_SECS=60
#   - python bot_engine.py
#
# How it runs in production (Render):
#   - gunicorn imports wsgi.py
#   - wsgi.py calls start_bot_in_background()
#   - bot runs in ONE background thread inside the gunicorn worker
#
# TESTNET only.

import os
import time
import json
import threading
from dataclasses import dataclass
from typing import Dict, Any, List, Tuple, Optional

from decimal import Decimal

from db import conn
from bot_markets import scan_markets_vs_pi
from bot_trader import (
    market_buy,
    market_sell,
    get_bot_token_balance,
    cancel_blocked_buy_offers,
)

# ---------------------------------------------------------------------
# Basic config
# ---------------------------------------------------------------------

LOOP_MODE = os.getenv("BOT_LOOP_MODE", "false").lower() == "true"
LOOP_SLEEP_SECS = int(os.getenv("BOT_LOOP_SLEEP_SECS", "60"))

# Minimum PI to use per trade
MIN_TRADE_PI = float(os.getenv("BOT_MIN_TRADE_PI", "0.1"))

# Safety caps
MAX_TRADES_PER_RUN = int(os.getenv("BOT_MAX_TRADES_PER_RUN", "20"))
MAX_BUYS_PER_BUCKET = int(os.getenv("BOT_MAX_BUYS_PER_BUCKET", "5"))
MAX_SELLS_PER_BUCKET = int(os.getenv("BOT_MAX_SELLS_PER_BUCKET", "5"))

# Take profit / stop loss by risk
RISK_TP_SL = {
    "low": {
        "take_profit_pct": 5.0,
        "stop_loss_pct": -5.0,
    },
    "medium": {
        "take_profit_pct": 10.0,
        "stop_loss_pct": -8.0,
    },
    "high": {
        "take_profit_pct": 20.0,
        "stop_loss_pct": -15.0,
    },
}

# Strategy blending per risk level
RISK_WEIGHTS = {
    "low": {
        "max_tokens": 2,
        "per_run_fraction": 0.10,
        "max_per_token_fraction": 0.30,
        "trend_weight": 0.6,
        "micro_weight": 0.4,
        "vol_weight": 0.0,
        "max_spread_pct": 5.0,
    },
    "medium": {
        "max_tokens": 6,
        "per_run_fraction": 0.20,
        "max_per_token_fraction": 0.40,
        "trend_weight": 0.4,
        "micro_weight": 0.3,
        "vol_weight": 0.3,
        "max_spread_pct": 12.0,
    },
    "high": {
        "max_tokens": 10,
        "per_run_fraction": 0.35,
        "max_per_token_fraction": 0.60,
        "trend_weight": 0.15,
        "micro_weight": 0.30,
        "vol_weight": 0.55,
        "max_spread_pct": 30.0,
    },
}

# Tokens the bot should never buy (hard blocklist).
# We can still SELL these if we already hold them.
BLOCKED_BUY_CODES = {
    "Archimedes",
    "AYB",
    "DTCNY",
    "DATONG",
    "DTUSD",
}

# Max drawdown protection (what your UI is describing)
# Based on *net deposits* into a bucket (sum deposits - sum withdrawals).
MAX_DRAWDOWN_PCT_BY_RISK = {
    "low": 30.0,     # tweak if you ever expose a true "low" bucket
    "medium": 30.0,  # matches "~30%" copy in the UI
    "high": 45.0,    # matches "~45%" copy in the UI
}

# Sell wall logic
# If wall_value_pi > SELL_WALL_FRACTION * bucket_cash -> skip that market
SELL_WALL_FRACTION = float(os.getenv("BOT_SELL_WALL_FRACTION", "0.4"))
# Boost in scoring for tokens where we CAN break the wall
WALL_BREAK_SCORE_BOOST = float(os.getenv("BOT_WALL_BREAK_SCORE_BOOST", "3.0"))
# Fallback quick-sell markup if we don't know the next ask (percent)
QUICK_SELL_FALLBACK_PCT = float(os.getenv("BOT_QUICK_SELL_FALLBACK_PCT", "2.0"))


def _now() -> int:
    return int(time.time())


# ---------------------------------------------------------------------
# Dataclasses
# ---------------------------------------------------------------------

@dataclass
class Bucket:
    id: int
    account_id: int
    username: str
    risk_level: str
    objective: str
    volatility: str
    time_horizon_days: int
    cash_pi: float


@dataclass
class MarketInfo:
    code: str
    issuer: str
    best_bid: float
    best_ask: float
    mid_price: float
    spread_pct: float
    bid_liq: float
    ask_liq: float
    depth_imbalance: float
    total_liq: float
    num_bid_levels: int
    num_ask_levels: int
    # Optional extended orderbook info (if available)
    top_ask_amount: float = 0.0    # size of top-of-book ask (tokens)
    next_ask_price: float = 0.0    # price of next ask level above best_ask
    wall_value_pi: float = 0.0     # estimated PI value of the top sell wall
    wall_break_candidate: bool = False  # whether this wall is breakable by a bucket


@dataclass
class Position:
    bucket_id: int
    code: str
    issuer: str
    quantity: float
    avg_price_pi: float


# ---------------------------------------------------------------------
# Background thread state (for running inside gunicorn)
# ---------------------------------------------------------------------

_engine_thread: Optional[threading.Thread] = None
_engine_running: bool = False
_engine_lock = threading.Lock()


# ---------------------------------------------------------------------
# Schema helpers
# ---------------------------------------------------------------------

def ensure_bot_tables():
    with conn() as cx:
        cx.execute("""
        CREATE TABLE IF NOT EXISTS bot_trades(
          id INTEGER PRIMARY KEY,
          bucket_id INTEGER NOT NULL,
          account_id INTEGER NOT NULL,
          code TEXT NOT NULL,
          issuer TEXT NOT NULL,
          side TEXT NOT NULL,
          price_pi REAL NOT NULL,
          amount_token REAL NOT NULL,
          amount_pi REAL NOT NULL,
          mid_price REAL,
          spread_pct REAL,
          depth_imbalance REAL,
          strategy_tag TEXT,
          risk_level TEXT,
          created_at INTEGER,
          tx_hash TEXT,
          raw_json TEXT
        );
        """)
        cx.execute("""
        CREATE INDEX IF NOT EXISTS idx_bot_trades_bucket_ts
          ON bot_trades(bucket_id, created_at);
        """)

        cx.execute("""
        CREATE TABLE IF NOT EXISTS bot_positions(
          id INTEGER PRIMARY KEY,
          bucket_id INTEGER NOT NULL,
          code TEXT NOT NULL,
          issuer TEXT NOT NULL,
          quantity REAL NOT NULL,
          avg_price_pi REAL NOT NULL,
          created_at INTEGER,
          updated_at INTEGER,
          UNIQUE(bucket_id, code, issuer)
        );
        """)
        cx.execute("""
        CREATE INDEX IF NOT EXISTS idx_bot_positions_bucket
          ON bot_positions(bucket_id);
        """)


# ---------------------------------------------------------------------
# Load active buckets + positions
# ---------------------------------------------------------------------

def load_active_buckets() -> List[Bucket]:
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
              IFNULL(alloc.amount, 0) AS cash_pi
            FROM bot_buckets b
            JOIN bot_accounts a ON a.id = b.account_id
            LEFT JOIN bot_bucket_allocations alloc
              ON alloc.bucket_id = b.id
             AND alloc.account_id = b.account_id
            WHERE (b.status IS NULL OR b.status = 'active')
              AND IFNULL(alloc.amount, 0) > 0
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
                cash_pi=float(r["cash_pi"] or 0.0),
            )
        )
    return buckets


def load_positions_for_bucket(bucket_id: int) -> Dict[Tuple[str, str], Position]:
    pos: Dict[Tuple[str, str], Position] = {}
    with conn() as cx:
        rows = cx.execute(
            """
            SELECT bucket_id, code, issuer, quantity, avg_price_pi
              FROM bot_positions
             WHERE bucket_id = ?
            """,
            (bucket_id,),
        ).fetchall()

    for r in rows:
        key = (r["code"], r["issuer"])
        pos[key] = Position(
            bucket_id=r["bucket_id"],
            code=r["code"],
            issuer=r["issuer"],
            quantity=float(r["quantity"] or 0.0),
            avg_price_pi=float(r["avg_price_pi"] or 0.0),
        )
    return pos


# ---------------------------------------------------------------------
# Markets normalization (orderbook-only)
# ---------------------------------------------------------------------

def normalize_markets(raw_markets: List[Dict[str, Any]]) -> Dict[Tuple[str, str], MarketInfo]:
    markets: Dict[Tuple[str, str], MarketInfo] = {}

    for m in raw_markets:
        code = m.get("code")
        issuer = m.get("issuer")
        if not code or not issuer:
            continue

        ob_token = m.get("orderbook_sell_token") or {}
        ob_pi = m.get("orderbook_sell_pi") or {}

        # Prices and spreads strictly from orderbook
        best_bid = ob_pi.get("best_bid_price") or ob_token.get("best_bid_price")
        best_ask = ob_pi.get("best_ask_price") or ob_token.get("best_ask_price")
        mid_price = ob_pi.get("mid_price") or ob_token.get("mid_price")
        spread_pct = ob_pi.get("spread_pct") or ob_token.get("spread_pct")

        bid_liq = ob_pi.get("total_bid_liquidity") or ob_token.get("total_bid_liquidity") or 0.0
        ask_liq = ob_pi.get("total_ask_liquidity") or ob_token.get("total_ask_liquidity") or 0.0
        num_bid_levels = ob_pi.get("num_bid_levels") or ob_token.get("num_bid_levels") or 0
        num_ask_levels = ob_pi.get("num_ask_levels") or ob_token.get("num_ask_levels") or 0

        try:
            best_bid_f = float(best_bid or 0.0)
            best_ask_f = float(best_ask or 0.0)
            mid_f = float(mid_price or 0.0)
            spread_f = float(spread_pct or 0.0)
            bid_liq_f = float(bid_liq or 0.0)
            ask_liq_f = float(ask_liq or 0.0)
            nb = int(num_bid_levels or 0)
            na = int(num_ask_levels or 0)
        except Exception:
            continue

        # Try to pull full ladder info if present (Horizon style asks array)
        top_ask_amount_f = 0.0
        next_ask_price_f = 0.0

        raw_asks = None
        for key_name in ("asks", "ask_levels", "sell_levels", "ask_book"):
            v = ob_pi.get(key_name) or ob_token.get(key_name)
            if isinstance(v, list) and v:
                raw_asks = v
                break

        if isinstance(raw_asks, list) and raw_asks:
            first = raw_asks[0] or {}
            try:
                top_ask_amount_f = float(
                    first.get("amount")
                    or first.get("qty")
                    or first.get("quantity")
                    or first.get("balance")
                    or 0.0
                )
            except Exception:
                top_ask_amount_f = 0.0

            if len(raw_asks) > 1:
                second = raw_asks[1] or {}
                try:
                    next_ask_price_f = float(second.get("price") or 0.0)
                except Exception:
                    next_ask_price_f = 0.0

        total_liq = bid_liq_f + ask_liq_f
        if total_liq <= 0:
            depth_imbalance = 0.0
        else:
            depth_imbalance = (bid_liq_f - ask_liq_f) / total_liq

        markets[(code, issuer)] = MarketInfo(
            code=code,
            issuer=issuer,
            best_bid=best_bid_f,
            best_ask=best_ask_f,
            mid_price=mid_f,
            spread_pct=spread_f,
            bid_liq=bid_liq_f,
            ask_liq=ask_liq_f,
            depth_imbalance=depth_imbalance,
            total_liq=total_liq,
            num_bid_levels=nb,
            num_ask_levels=na,
            top_ask_amount=top_ask_amount_f,
            next_ask_price=next_ask_price_f,
        )

    return markets


# ---------------------------------------------------------------------
# Trade + position bookkeeping
# ---------------------------------------------------------------------

def log_trade(
    bucket: Bucket,
    side: str,
    market: MarketInfo,
    amount_token: float,
    price_pi: float,
    strategy_tag: str,
    tx_resp: Optional[Dict[str, Any]] = None,
):
    ts = _now()
    amount_pi = float(amount_token) * float(price_pi)
    tx_hash = None
    raw_json = None
    if tx_resp:
        tx_hash = tx_resp.get("hash")
        try:
            raw_json = json.dumps(tx_resp)
        except Exception:
            raw_json = None

    with conn() as cx:
        cx.execute(
            """
            INSERT INTO bot_trades(
              bucket_id, account_id, code, issuer, side,
              price_pi, amount_token, amount_pi,
              mid_price, spread_pct, depth_imbalance,
              strategy_tag, risk_level,
              created_at, tx_hash, raw_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                bucket.id,
                bucket.account_id,
                market.code,
                market.issuer,
                side,
                float(price_pi),
                float(amount_token),
                float(amount_pi),
                float(market.mid_price or 0.0),
                float(market.spread_pct or 0.0),
                float(market.depth_imbalance or 0.0),
                strategy_tag,
                bucket.risk_level,
                ts,
                tx_hash,
                raw_json,
            ),
        )


def update_cash_for_bucket(bucket_id: int, delta_pi: float):
    ts = _now()
    with conn() as cx:
        row = cx.execute(
            """
            SELECT id, amount
              FROM bot_bucket_allocations
             WHERE bucket_id = ?
            """,
            (bucket_id,),
        ).fetchone()
        if not row:
            return

        current = float(row["amount"] or 0.0)
        new_amt = current + float(delta_pi)
        if new_amt < 0:
            new_amt = 0.0

        cx.execute(
            """
            UPDATE bot_bucket_allocations
               SET amount = ?, updated_at = ?
             WHERE id = ?
            """,
            (new_amt, ts, row["id"]),
        )


def upsert_position(bucket_id: int, market: MarketInfo, delta_qty: float, trade_price_pi: float):
    ts = _now()
    code = market.code
    issuer = market.issuer
    delta_qty = float(delta_qty)
    trade_price_pi = float(trade_price_pi)

    if abs(delta_qty) < 1e-12:
        return

    with conn() as cx:
        row = cx.execute(
            """
            SELECT id, quantity, avg_price_pi
              FROM bot_positions
             WHERE bucket_id = ? AND code = ? AND issuer = ?
            """,
            (bucket_id, code, issuer),
        ).fetchone()

        if not row:
            if delta_qty <= 0:
                return
            cx.execute(
                """
                INSERT INTO bot_positions(
                  bucket_id, code, issuer, quantity, avg_price_pi,
                  created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    bucket_id,
                    code,
                    issuer,
                    delta_qty,
                    trade_price_pi,
                    ts,
                    ts,
                ),
            )
            return

        pos_id = row["id"]
        current_qty = float(row["quantity"] or 0.0)
        current_avg = float(row["avg_price_pi"] or 0.0)

        new_qty = current_qty + delta_qty

        if new_qty <= 1e-12:
            cx.execute(
                "DELETE FROM bot_positions WHERE id = ?",
                (pos_id,),
            )
            return

        if delta_qty > 0 and trade_price_pi > 0:
            total_cost = current_qty * current_avg + delta_qty * trade_price_pi
            new_avg = total_cost / new_qty
        else:
            new_avg = current_avg

        cx.execute(
            """
            UPDATE bot_positions
               SET quantity = ?, avg_price_pi = ?, updated_at = ?
             WHERE id = ?
            """,
            (new_qty, new_avg, ts, pos_id),
        )


# ---------------------------------------------------------------------
# Drawdown helpers
# ---------------------------------------------------------------------

def get_planned_max_drawdown_pct(bucket: Bucket) -> Optional[float]:
    risk = (bucket.risk_level or "medium").lower()
    return MAX_DRAWDOWN_PCT_BY_RISK.get(risk)


def get_bucket_net_deposit_pi(bucket_id: int) -> float:
    """
    Net deposits for this bucket across *all time*:

        net_deposit = sum(deposits) - sum(withdrawals)

    Assumes you have a bot_bucket_transfers table with:
      - bucket_id
      - direction ('deposit' or 'withdraw')
      - amount (PI)
    If your table/column names differ, adjust this query.
    """
    with conn() as cx:
        row = cx.execute(
            """
            SELECT
              IFNULL(SUM(CASE WHEN direction = 'deposit'  THEN amount ELSE 0 END), 0) AS total_deposits,
              IFNULL(SUM(CASE WHEN direction = 'withdraw' THEN amount ELSE 0 END), 0) AS total_withdraws
            FROM bot_bucket_transfers
            WHERE bucket_id = ?
            """,
            (bucket_id,),
        ).fetchone()

    if not row:
        return 0.0

    total_deposits = float(row["total_deposits"] or 0.0)
    total_withdraws = float(row["total_withdraws"] or 0.0)
    net = total_deposits - total_withdraws
    return max(net, 0.0)


# ---------------------------------------------------------------------
# Strategy scoring
# ---------------------------------------------------------------------

def compute_score(m: MarketInfo, risk_cfg: Dict[str, Any]) -> float:
    """
    Blend components:
      trend      positive depth_imbalance
      micro      abs(depth_imbalance) * total_liq / (spread+1)
      vol        spread
    """
    tw = risk_cfg["trend_weight"]
    mw = risk_cfg["micro_weight"]
    vw = risk_cfg["vol_weight"]

    trend = max(0.0, m.depth_imbalance)
    micro = abs(m.depth_imbalance) * (m.total_liq ** 0.5) / (1.0 + max(0.0, m.spread_pct))
    vol = min(m.spread_pct / 10.0, 5.0)

    return tw * trend + mw * micro + vw * vol


# ---------------------------------------------------------------------
# Sell logic
# ---------------------------------------------------------------------

def plan_sells_for_bucket(
    bucket: Bucket,
    positions: Dict[Tuple[str, str], Position],
    markets: Dict[Tuple[str, str], MarketInfo],
) -> List[Tuple[Position, MarketInfo, float]]:
    if not positions:
        return []

    cfg = RISK_TP_SL.get(bucket.risk_level, RISK_TP_SL["medium"])
    tp = cfg["take_profit_pct"]
    sl = cfg["stop_loss_pct"]

    planned: List[Tuple[Position, MarketInfo, float]] = []

    for key, pos in positions.items():
        market = markets.get(key)
        if not market or market.mid_price <= 0 or pos.quantity <= 0:
            continue

        pnl_pct = (market.mid_price - pos.avg_price_pi) / pos.avg_price_pi * 100.0

        # Raise floor or rotate by trimming half at TP or SL
        if pnl_pct >= tp or pnl_pct <= sl:
            amount_to_sell = pos.quantity * 0.5
            if amount_to_sell * market.mid_price < MIN_TRADE_PI:
                continue
            planned.append((pos, market, amount_to_sell))

    return planned[:MAX_SELLS_PER_BUCKET]


def execute_sells_for_bucket(
    bucket: Bucket,
    plans: List[Tuple[Position, MarketInfo, float]],
) -> int:
    executed = 0
    for pos, market, amount_to_sell in plans:
        if executed >= MAX_SELLS_PER_BUCKET:
            break

        best_bid = market.best_bid
        if best_bid <= 0:
            continue

        wallet_qty = get_bot_token_balance(market.code, market.issuer)
        if wallet_qty <= 0:
            print(
                f"[SELL] skip bucket={bucket.id} user=@{bucket.username} "
                f"{market.code} wallet balance is 0"
            )
            continue

        if amount_to_sell > wallet_qty:
            print(
                f"[SELL] clamp bucket={bucket.id} user=@{bucket.username} "
                f"{market.code} planned={amount_to_sell:.6f}, wallet={wallet_qty:.6f}"
            )
            amount_to_sell = wallet_qty

        if amount_to_sell * best_bid < MIN_TRADE_PI:
            continue

        try:
            print(
                f"[SELL] bucket={bucket.id} user=@{bucket.username} "
                f"{amount_to_sell:.6f} {market.code} @ {best_bid:.6f} PI"
            )
            resp = market_sell(
                token_code=market.code,
                token_issuer=market.issuer,
                token_amount=amount_to_sell,
                best_bid=best_bid,
            )
            upsert_position(bucket.id, market, delta_qty=-amount_to_sell, trade_price_pi=best_bid)
            cash_delta = amount_to_sell * best_bid
            update_cash_for_bucket(bucket.id, delta_pi=cash_delta)
            log_trade(
                bucket=bucket,
                side="sell",
                market=market,
                amount_token=amount_to_sell,
                price_pi=best_bid,
                strategy_tag="tp_sl",
                tx_resp=resp,
            )
            executed += 1
        except Exception as e:
            print(f"[ERROR] sell failed for {market.code} in bucket {bucket.id}: {e}")

    return executed


# ---------------------------------------------------------------------
# Buy logic (with sell-wall detection + wall-break preference)
# ---------------------------------------------------------------------

def plan_buys_for_bucket(
    bucket: Bucket,
    markets: Dict[Tuple[str, str], MarketInfo],
) -> List[Tuple[MarketInfo, float]]:
    """
    Decide which markets to buy for this bucket.
    Returns list of (market, pi_budget_for_this_buy).
    """
    risk = bucket.risk_level if bucket.risk_level in RISK_WEIGHTS else "medium"
    cfg = RISK_WEIGHTS[risk]

    if bucket.cash_pi <= MIN_TRADE_PI:
        return []

    per_run_budget = bucket.cash_pi * cfg["per_run_fraction"]
    if per_run_budget <= MIN_TRADE_PI:
        if bucket.cash_pi >= MIN_TRADE_PI:
            per_run_budget = min(bucket.cash_pi, MAX_TRADES_PER_RUN * MIN_TRADE_PI)
        else:
            return []

    max_per_token = bucket.cash_pi * cfg["max_per_token_fraction"]
    max_spread = cfg["max_spread_pct"]

    scored: List[Tuple[float, MarketInfo]] = []

    for key, m in markets.items():
        # Never BUY blocked tokens (we can still SELL them)
        if m.code in BLOCKED_BUY_CODES:
            continue

        # Orderbook sanity
        if m.best_ask <= 0 or m.mid_price <= 0:
            continue
        if m.spread_pct <= 0 or m.spread_pct > max_spread:
            continue
        if m.total_liq <= 0:
            continue

        # --- Sell wall detection relative to this bucket ---
        # Try top-of-book amount if we have it, otherwise approximate
        wall_qty_tokens = m.top_ask_amount if m.top_ask_amount > 0 else 0.0
        if wall_qty_tokens <= 0 and m.ask_liq > 0:
            # Fallback: approximate a top wall as average per level
            denom = m.num_ask_levels or 1
            wall_qty_tokens = m.ask_liq / float(denom)

        wall_value_pi = float(wall_qty_tokens) * float(m.best_ask)
        m.wall_value_pi = wall_value_pi
        m.wall_break_candidate = False

        if bucket.cash_pi > 0 and wall_value_pi > 0:
            wall_ratio = wall_value_pi / bucket.cash_pi

            # If wall is too big vs this bucket's firepower, skip entirely
            if wall_ratio > SELL_WALL_FRACTION:
                # Example: bucket has 1000 PI and wall is 600+ PI -> not worth touching
                continue

            # If the wall is reasonably sized, and at least MIN_TRADE_PI, mark as breakable
            if wall_ratio <= SELL_WALL_FRACTION and wall_value_pi >= MIN_TRADE_PI:
                m.wall_break_candidate = True

        # Normal strategy score
        score = compute_score(m, cfg)
        if score <= 0:
            continue

        # Prefer non "DT" style tokens, but still allow them if we haven't blocked them
        if m.code.startswith("DT"):
            score *= 0.2
        else:
            score *= 1.2

        # Strongly prefer markets where we can actually break the wall
        if m.wall_break_candidate:
            score *= WALL_BREAK_SCORE_BOOST

        scored.append((score, m))

    if not scored:
        return []

    scored.sort(key=lambda x: x[0], reverse=True)

    max_tokens = cfg["max_tokens"]
    scored = scored[:max_tokens]

    remaining_budget = per_run_budget
    planned: List[Tuple[MarketInfo, float]] = []

    for _, m in scored:
        if remaining_budget < MIN_TRADE_PI:
            break

        per_token_budget = min(
            max_per_token,
            remaining_budget / max(1, (max_tokens - len(planned))),
        )

        if per_token_budget < MIN_TRADE_PI:
            continue

        planned.append((m, per_token_budget))
        remaining_budget -= per_token_budget

        if len(planned) >= MAX_BUYS_PER_BUCKET:
            break

    return planned


def execute_buys_for_bucket(
    bucket: Bucket,
    plans: List[Tuple[MarketInfo, float]],
) -> int:
    executed = 0
    for market, pi_budget in plans:
        if executed >= MAX_BUYS_PER_BUCKET:
            break

        if pi_budget < MIN_TRADE_PI:
            continue

        best_ask = market.best_ask
        if best_ask <= 0:
            continue

        with conn() as cx:
            row = cx.execute(
                """
                SELECT amount
                  FROM bot_bucket_allocations
                 WHERE bucket_id = ?
                """,
                (bucket.id,),
            ).fetchone()
        current_cash = float(row["amount"] or 0.0) if row else 0.0
        if current_cash < pi_budget - 1e-8:
            continue

        amount_token = pi_budget / best_ask

        try:
            print(
                f"[BUY] bucket={bucket.id} user=@{bucket.username} "
                f"spend~{pi_budget:.6f} PI on {market.code} @ {best_ask:.6f} PI"
            )
            # Always price off the current orderbook best ask
            resp = market_buy(
                token_code=market.code,
                token_issuer=market.issuer,
                max_cost_pi=pi_budget,
                best_price=best_ask,
            )
            upsert_position(bucket.id, market, delta_qty=amount_token, trade_price_pi=best_ask)
            update_cash_for_bucket(bucket.id, delta_pi=-pi_budget)
            log_trade(
                bucket=bucket,
                side="buy",
                market=market,
                amount_token=amount_token,
                price_pi=best_ask,
                strategy_tag="blend",
                tx_resp=resp,
            )
            executed += 1

            # If this market had a breakable wall, immediately place a quick
            # SELL somewhere between the broken wall and the next ask.
            if market.wall_break_candidate:
                try:
                    if market.next_ask_price and market.next_ask_price > market.best_ask:
                        # Exact midpoint between the broken wall ask and the next ask
                        target_price = (market.best_ask + market.next_ask_price) / 2.0
                    else:
                        # Fallback: small markup over entry (orderbook-only)
                        target_price = market.best_ask * (1.0 + QUICK_SELL_FALLBACK_PCT / 100.0)

                    wallet_qty = get_bot_token_balance(market.code, market.issuer)
                    quick_qty = min(wallet_qty, amount_token)

                    if quick_qty * target_price >= MIN_TRADE_PI:
                        print(
                            f"[SCALP] bucket={bucket.id} user=@{bucket.username} "
                            f"placing quick wall-break SELL {quick_qty:.6f} {market.code} "
                            f"@ {target_price:.6f} PI"
                        )
                        # Use market_sell as a generic limit-sell at target_price.
                        # We don't log this as an executed trade here because it
                        # may partially fill; realized PnL will show up via TP/SL.
                        market_sell(
                            token_code=market.code,
                            token_issuer=market.issuer,
                            token_amount=quick_qty,
                            best_bid=target_price,
                        )
                except Exception as e:
                    print(
                        f"[SCALP] quick wall-break sell placement failed for "
                        f"{market.code} in bucket {bucket.id}: {e}"
                    )

        except Exception as e:
            print(f"[ERROR] buy failed for {market.code} in bucket {bucket.id}: {e}")

    return executed


# ---------------------------------------------------------------------
# Bucket equity estimation
# ---------------------------------------------------------------------

def estimate_bucket_equity_pi(
    bucket: Bucket,
    positions: Dict[Tuple[str, str], Position],
    markets: Dict[Tuple[str, str], MarketInfo],
) -> float:
    cash = bucket.cash_pi
    value_positions = 0.0
    for key, pos in positions.items():
        m = markets.get(key)
        if not m or m.mid_price <= 0 or pos.quantity <= 0:
            continue
        value_positions += pos.quantity * m.mid_price
    return cash + value_positions


def bucket_hit_max_drawdown(
    bucket: Bucket,
    positions: Dict[Tuple[str, str], Position],
    markets: Dict[Tuple[str, str], MarketInfo],
) -> bool:
    """
    Return True if this bucket has hit or exceeded its planned max drawdown
    based on net deposits (deposits - withdrawals).
    """
    max_dd_pct = get_planned_max_drawdown_pct(bucket)
    if max_dd_pct is None:
        return False

    net_deposit = get_bucket_net_deposit_pi(bucket.id)
    if net_deposit <= 0:
        return False

    equity = estimate_bucket_equity_pi(bucket, positions, markets)
    if equity <= 0:
        dd_pct = 100.0
    else:
        dd_pct = max(0.0, (net_deposit - equity) / net_deposit * 100.0)

    print(
        f"[DRAWDOWN] bucket={bucket.id} user=@{bucket.username} "
        f"net_deposit≈{net_deposit:.4f} PI equity≈{equity:.4f} PI "
        f"dd≈{dd_pct:.2f}% limit={max_dd_pct:.2f}%"
    )

    return dd_pct >= max_dd_pct


# ---------------------------------------------------------------------
# Main engine run
# ---------------------------------------------------------------------

def run_once():
    ensure_bot_tables()

    # First, clear any legacy open BUY offers for blocked tokens
    # so we never keep feeding Datong / stablecoins.
    try:
        cancel_blocked_buy_offers(list(BLOCKED_BUY_CODES))
    except Exception as e:
        print(f"[ENGINE] Warning: cancel_blocked_buy_offers failed: {e}")

    print("[ENGINE] Scanning markets on Pi Testnet...")
    raw_markets = scan_markets_vs_pi(
        max_assets=200,
        min_num_accounts=1,
        max_spread_pct=None,
    )
    print(f"[ENGINE] scan_markets_vs_pi returned {len(raw_markets)} raw markets")

    markets = normalize_markets(raw_markets)
    print(f"[ENGINE] normalize_markets produced {len(markets)} usable markets")

    if not markets:
        print("[ENGINE] No markets found after normalization.")
        return

    buckets = load_active_buckets()
    if not buckets:
        print("[ENGINE] No active buckets with cash, nothing to do.")
        return

    total_trades = 0

    for bucket in buckets:
        risk = bucket.risk_level if bucket.risk_level in RISK_WEIGHTS else "medium"
        print(
            f"[ENGINE] Bucket {bucket.id} (@{bucket.username}) "
            f"risk={risk} cash≈{bucket.cash_pi:.4f} PI"
        )

        # Load positions once at the start of the loop
        positions = load_positions_for_bucket(bucket.id)

        # Sells first, this both raises floors and frees cash.
        sell_plans = plan_sells_for_bucket(bucket, positions, markets)
        sells_done = execute_sells_for_bucket(bucket, sell_plans)
        total_trades += sells_done
        if total_trades >= MAX_TRADES_PER_RUN:
            print("[ENGINE] Hit MAX_TRADES_PER_RUN, stopping further trades this run.")
            break

        # Refresh positions (after sells) and cash from DB
        positions = load_positions_for_bucket(bucket.id)
        with conn() as cx:
            row = cx.execute(
                """
                SELECT amount FROM bot_bucket_allocations
                 WHERE bucket_id = ?
                """,
                (bucket.id,),
            ).fetchone()
        bucket.cash_pi = float(row["amount"] or 0.0) if row else 0.0

        # Enforce planned max drawdown: if hit, skip BUYS for this bucket.
        if bucket_hit_max_drawdown(bucket, positions, markets):
            print(
                f"[ENGINE] Bucket {bucket.id} hit planned max drawdown; "
                f"skipping new BUYS this run (SELLS still allowed)."
            )
            continue

        # Buys (with sell wall logic)
        buy_plans = plan_buys_for_bucket(bucket, markets)
        buys_done = execute_buys_for_bucket(bucket, buy_plans)
        total_trades += buys_done
        if total_trades >= MAX_TRADES_PER_RUN:
            print("[ENGINE] Hit MAX_TRADES_PER_RUN, stopping further trades this run.")
            break

    print(f"[ENGINE] Run complete. Total trades executed: {total_trades}")


def run_loop():
    print(
        f"[ENGINE] Starting loop mode. LOOP_MODE={LOOP_MODE}, "
        f"SLEEP={LOOP_SLEEP_SECS}s"
    )
    iteration = 0
    while True:
        iteration += 1
        print(f"[ENGINE] Loop iteration {iteration} at ts={_now()}")
        try:
            run_once()
        except Exception as e:
            print(f"[ENGINE] ERROR in run_once: {e!r}")
        print(f"[ENGINE] Sleeping {LOOP_SLEEP_SECS}s before next iteration...")
        time.sleep(LOOP_SLEEP_SECS)


# ---------------------------------------------------------------------
# Background entrypoint for gunicorn (single process)
# ---------------------------------------------------------------------

def bot_loop_forever():
    """
    Continuous loop for background thread.
    Always loops, ignoring LOOP_MODE – this is what we want in production.
    """
    print(
        f"[ENGINE] Background trading loop started inside app process. "
        f"SLEEP={LOOP_SLEEP_SECS}s"
    )
    iteration = 0
    while True:
        iteration += 1
        print(f"[ENGINE] [BG] iteration {iteration} at ts={_now()}")
        try:
            run_once()
        except Exception as e:
            print(f"[ENGINE] [BG] ERROR in run_once: {e!r}")
        print(f"[ENGINE] [BG] sleeping {LOOP_SLEEP_SECS}s...")
        time.sleep(LOOP_SLEEP_SECS)


def start_bot_in_background():
    """
    Idempotent starter. Safe to call on import.
    Called from wsgi.py so the bot runs in the same process as gunicorn.
    """
    global _engine_thread, _engine_running
    with _engine_lock:
        if _engine_running:
            # Already started in this process
            return
        t = threading.Thread(target=bot_loop_forever, daemon=True)
        _engine_thread = t
        _engine_running = True
        t.start()
        print("[ENGINE] start_bot_in_background(): thread launched")


# ---------------------------------------------------------------------
# CLI entrypoint (manual runs)
# ---------------------------------------------------------------------

if __name__ == "__main__":
    raw = os.getenv("BOT_LOOP_MODE", "false")
    print(
        f"[ENGINE] bot_engine.py starting (CLI). "
        f"BOT_LOOP_MODE raw='{raw}' -> LOOP_MODE={LOOP_MODE}, "
        f"SLEEP={LOOP_SLEEP_SECS}"
    )
    if LOOP_MODE:
        run_loop()
    else:
        run_once()
