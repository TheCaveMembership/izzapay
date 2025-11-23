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
# How to run once:
#     python bot_engine.py
#
# How to run in a loop (Render worker / cron style):
#   - Set env:
#       BOT_LOOP_MODE=true
#       BOT_LOOP_SLEEP_SECS=60   (or 30, etc.)
#   - Then:
#       python bot_engine.py
#
# NOTE:
#   This is TESTNET only. It assumes HORIZON_URL + NETWORK_PASSPHRASE
#   are set to Pi Testnet and that BOT_WALLET_PUB / SEC are funded.

import os
import time
import json
from dataclasses import dataclass
from typing import Dict, Any, List, Tuple, Optional

from decimal import Decimal

from db import conn
from bot_markets import scan_markets_vs_pi
from bot_trader import market_buy, market_sell, get_bot_token_balance  # <-- updated

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

# Take-profit / stop-loss by risk
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

# Strategy blending per risk level:
#   trend_weight      -> depth imbalance (upside bias)
#   micro_weight      -> orderbook depth + spread
#   vol_weight        -> spread / thin books (high vol)
RISK_WEIGHTS = {
    "low": {
        "max_tokens": 2,
        "per_run_fraction": 0.10,       # use up to 10% of current cash in new buys
        "max_per_token_fraction": 0.30, # don't put more than 30% of cash into one token
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
    cash_pi: float  # free PI currently in bucket (bot_bucket_allocations.amount)


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
    depth_imbalance: float  # (bid_liq - ask_liq) / (bid_liq + ask_liq + eps)
    total_liq: float
    num_bid_levels: int
    num_ask_levels: int


@dataclass
class Position:
    bucket_id: int
    code: str
    issuer: str
    quantity: float
    avg_price_pi: float


# ---------------------------------------------------------------------
# Schema helpers: ensure bot_trades + bot_positions exist
# ---------------------------------------------------------------------

def ensure_bot_tables():
    with conn() as cx:
        # Trades log
        cx.execute("""
        CREATE TABLE IF NOT EXISTS bot_trades(
          id INTEGER PRIMARY KEY,
          bucket_id INTEGER NOT NULL,
          account_id INTEGER NOT NULL,
          code TEXT NOT NULL,
          issuer TEXT NOT NULL,
          side TEXT NOT NULL, -- 'buy' or 'sell'
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

        # Bucket positions per token
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
    """
    Buckets with positive cash and active status.
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
# Markets normalization
# ---------------------------------------------------------------------

def normalize_markets(raw_markets: List[Dict[str, Any]]) -> Dict[Tuple[str, str], MarketInfo]:
    """
    Convert scan_markets_vs_pi output into a simpler MarketInfo mapping.
    """
    markets: Dict[Tuple[str, str], MarketInfo] = {}

    for m in raw_markets:
        code = m.get("code")
        issuer = m.get("issuer")
        if not code or not issuer:
            continue

        ob_token = m.get("orderbook_sell_token") or {}
        ob_pi = m.get("orderbook_sell_pi") or {}

        # Prefer the book where PI is the 'buying' side (pi_selling_token_buying)
        # but fall back as needed.
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
    """
    Adjust bot_bucket_allocations.amount (cash) by delta_pi.
    Positive delta_pi => increase cash (e.g. after sell).
    Negative delta_pi => decrease cash (e.g. after buy).
    """
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
            # No allocation row -> nothing to do (should not happen for active buckets)
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
    """
    Update or create a position in bot_positions.
    delta_qty > 0 for buy, < 0 for sell.
    """
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
            # New position
            if delta_qty <= 0:
                # selling from zero position doesn't make sense, ignore
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
            # Position fully (or almost fully) closed
            cx.execute(
                "DELETE FROM bot_positions WHERE id = ?",
                (pos_id,),
            )
            return

        # Update weighted average price only when size increases (i.e. net buy)
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
# Strategy scoring
# ---------------------------------------------------------------------

def compute_score(m: MarketInfo, risk_cfg: Dict[str, Any]) -> float:
    """
    Blend three components:
      - trend      -> positive depth_imbalance
      - micro      -> abs(depth_imbalance) * total_liq / (spread+1)
      - vol        -> spread (wide spreads = high vol)
    """
    tw = risk_cfg["trend_weight"]
    mw = risk_cfg["micro_weight"]
    vw = risk_cfg["vol_weight"]

    # Trend component: favor positive imbalance (more buyers than sellers)
    trend = max(0.0, m.depth_imbalance)

    # Microstructure: strong imbalance + decent liquidity + reasonably tight spread
    micro = abs(m.depth_imbalance) * (m.total_liq ** 0.5) / (1.0 + max(0.0, m.spread_pct))

    # Volatility: use normalized spread; cap to avoid extreme explosion
    vol = min(m.spread_pct / 10.0, 5.0)  # just a heuristic normalization

    return tw * trend + mw * micro + vw * vol


# ---------------------------------------------------------------------
# Sell logic (risk control, profit taking)
# ---------------------------------------------------------------------

def plan_sells_for_bucket(
    bucket: Bucket,
    positions: Dict[Tuple[str, str], Position],
    markets: Dict[Tuple[str, str], MarketInfo],
) -> List[Tuple[Position, MarketInfo, float]]:
    """
    Decide sells: [(position, market, amount_to_sell_token), ...]
    """
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

        # % gain/loss vs average cost
        pnl_pct = (market.mid_price - pos.avg_price_pi) / pos.avg_price_pi * 100.0

        # Take profit or cut loss
        if pnl_pct >= tp or pnl_pct <= sl:
            # For now: close 50% of position per trigger
            amount_to_sell = pos.quantity * 0.5
            if amount_to_sell * market.mid_price < MIN_TRADE_PI:
                # position too small to bother
                continue
            planned.append((pos, market, amount_to_sell))

    # Cap number of sells per bucket per run
    return planned[:MAX_SELLS_PER_BUCKET]


def execute_sells_for_bucket(
    bucket: Bucket,
    plans: List[Tuple[Position, MarketInfo, float]],
) -> int:
    """
    Execute the planned sells.
    Returns count of successful sells.

    Additional safety:
      - Only sell up to the BOT wallet's actual on-chain balance
        for that asset.
      - Skip sells entirely if the wallet balance is zero or the
        PI value of the sell is below MIN_TRADE_PI.
    """
    executed = 0
    for pos, market, amount_to_sell in plans:
        if executed >= MAX_SELLS_PER_BUCKET:
            break

        # Sell at best bid
        best_bid = market.best_bid
        if best_bid <= 0:
            continue

        # Check real on-chain wallet balance for this asset
        wallet_qty = get_bot_token_balance(market.code, market.issuer)
        if wallet_qty <= 0:
            # Wallet does not actually own this token, skip this sell
            print(
                f"[SELL] skip bucket={bucket.id} user=@{bucket.username} "
                f"{market.code} – wallet balance is 0"
            )
            continue

        # Clamp amount_to_sell to wallet_qty
        if amount_to_sell > wallet_qty:
            print(
                f"[SELL] clamp bucket={bucket.id} user=@{bucket.username} "
                f"{market.code} planned={amount_to_sell:.6f}, wallet={wallet_qty:.6f}"
            )
            amount_to_sell = wallet_qty

        # If after clamping the trade is too small in PI terms, skip
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
            # Update local ledgers
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
# Buy logic
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
        # If per-run budget is tiny, still allow a single min trade if enough cash
        if bucket.cash_pi >= MIN_TRADE_PI:
            per_run_budget = min(bucket.cash_pi, MAX_TRADES_PER_RUN * MIN_TRADE_PI)
        else:
            return []

    max_per_token = bucket.cash_pi * cfg["max_per_token_fraction"]
    max_spread = cfg["max_spread_pct"]

    # Score markets
    scored: List[Tuple[float, MarketInfo]] = []
    for key, m in markets.items():
        if m.best_ask <= 0 or m.mid_price <= 0:
            continue
        if m.spread_pct <= 0 or m.spread_pct > max_spread:
            continue
        if m.total_liq <= 0:
            continue

        score = compute_score(m, cfg)
        if score <= 0:
            continue
        scored.append((score, m))

    if not scored:
        return []

    # Sort by score descending
    scored.sort(key=lambda x: x[0], reverse=True)

    max_tokens = cfg["max_tokens"]
    scored = scored[:max_tokens]

    remaining_budget = per_run_budget
    planned: List[Tuple[MarketInfo, float]] = []

    for _, m in scored:
        if remaining_budget < MIN_TRADE_PI:
            break

        # Simple even split with per-token cap
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
    """
    Execute planned buys.
    Returns count of successful buys.
    """
    executed = 0
    for market, pi_budget in plans:
        if executed >= MAX_BUYS_PER_BUCKET:
            break

        if pi_budget < MIN_TRADE_PI:
            continue

        best_ask = market.best_ask
        if best_ask <= 0:
            continue

        # Check that bucket still has enough cash for this buy
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
            # Not enough cash anymore (maybe other trades used it), skip
            continue

        # Token amount to buy at this price
        amount_token = pi_budget / best_ask

        try:
            print(
                f"[BUY] bucket={bucket.id} user=@{bucket.username} "
                f"spend~{pi_budget:.6f} PI on {market.code} @ {best_ask:.6f} PI"
            )
            resp = market_buy(
                token_code=market.code,
                token_issuer=market.issuer,
                max_cost_pi=pi_budget,
                best_price=best_ask,
            )
            # Update local ledgers
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
        except Exception as e:
            print(f"[ERROR] buy failed for {market.code} in bucket {bucket.id}: {e}")

    return executed


# ---------------------------------------------------------------------
# Bucket equity estimation (for performance % later)
# ---------------------------------------------------------------------

def estimate_bucket_equity_pi(
    bucket: Bucket,
    positions: Dict[Tuple[str, str], Position],
    markets: Dict[Tuple[str, str], MarketInfo],
) -> float:
    """
    Approximate bucket "equity" in PI:
      equity ≈ cash_pi + sum(qty * mid_price)
    """
    cash = bucket.cash_pi
    value_positions = 0.0
    for key, pos in positions.items():
        m = markets.get(key)
        if not m or m.mid_price <= 0 or pos.quantity <= 0:
            continue
        value_positions += pos.quantity * m.mid_price
    return cash + value_positions


# ---------------------------------------------------------------------
# Main engine run
# ---------------------------------------------------------------------

def run_once():
    """
    One full cycle:
      - ensure tables
      - load markets
      - load buckets
      - for each bucket:
          1) plan + execute sells (risk control)
          2) plan + execute buys (new positions)
    """
    ensure_bot_tables()

    print("[ENGINE] Scanning markets on Pi Testnet...")
    raw_markets = scan_markets_vs_pi(
        max_assets=200,
        min_num_accounts=1,        # relaxed so we see more markets
        max_spread_pct=None,       # we filter again per risk
    )
    print(f"[ENGINE] scan_markets_vs_pi returned {len(raw_markets)} raw markets")

    markets = normalize_markets(raw_markets)
    print(f"[ENGINE] normalize_markets produced {len(markets)} usable markets")

    if not markets:
        print("[ENGINE] No markets found after normalization, "
              "check HORIZON_URL / network or loosen filters.")
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

        # Reload positions each run
        positions = load_positions_for_bucket(bucket.id)

        # 1) Sells (TP / SL)
        sell_plans = plan_sells_for_bucket(bucket, positions, markets)
        sells_done = execute_sells_for_bucket(bucket, sell_plans)
        total_trades += sells_done
        if total_trades >= MAX_TRADES_PER_RUN:
            print("[ENGINE] Hit MAX_TRADES_PER_RUN, stopping further trades this run.")
            break

        # Refresh bucket cash after sells
        with conn() as cx:
            row = cx.execute(
                """
                SELECT amount FROM bot_bucket_allocations
                 WHERE bucket_id = ?
                """,
                (bucket.id,),
            ).fetchone()
        bucket.cash_pi = float(row["amount"] or 0.0) if row else 0.0

        # 2) Buys
        buy_plans = plan_buys_for_bucket(bucket, markets)
        buys_done = execute_buys_for_bucket(bucket, buy_plans)
        total_trades += buys_done
        if total_trades >= MAX_TRADES_PER_RUN:
            print("[ENGINE] Hit MAX_TRADES_PER_RUN, stopping further trades this run.")
            break

    print(f"[ENGINE] Run complete. Total trades executed: {total_trades}")


def run_loop():
    """
    Loop mode: keep running with sleep in between.
    """
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


if __name__ == "__main__":
    raw = os.getenv("BOT_LOOP_MODE", "false")
    print(
        f"[ENGINE] bot_engine.py starting. "
        f"BOT_LOOP_MODE raw='{raw}' -> LOOP_MODE={LOOP_MODE}, "
        f"SLEEP={LOOP_SLEEP_SECS}"
    )
    if LOOP_MODE:
        run_loop()
    else:
        run_once()
