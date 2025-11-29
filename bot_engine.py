# bot_engine.py
#
# IZZA BOT trading engine.
#
# Responsibilities:
#   - Load active buckets + available PI "cash" per bucket
#   - Scan Pi Testnet markets via bot_markets.scan_markets_vs_pi
#   - Build buy / sell decisions based on bucket risk profile
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
#   - In production we now typically run:
#       ./start.sh
#     where start.sh launches gunicorn and then, after a delay, python bot_engine.py
#
# TESTNET only.

import os
import time
import json
import threading
from dataclasses import dataclass
from typing import Dict, Any, List, Tuple, Optional

from decimal import Decimal, ROUND_HALF_UP  # <- extended import

from db import conn
from bot_markets import scan_markets_vs_pi
from bot_trader import (
  market_buy,
  market_sell,
  get_bot_token_balance,
  cancel_blocked_buy_offers,
  would_cross_self_sell,
  would_cross_self_buy,
  cancel_blocking_buy_offers_for_pair,
)

# ---------------------------------------------------------------------
# Basic config
# ---------------------------------------------------------------------

LOOP_MODE = os.getenv("BOT_LOOP_MODE", "false").lower() == "true"
LOOP_SLEEP_SECS = int(os.getenv("BOT_LOOP_SLEEP_SECS", "60"))

# Global liquidation switch: when true we sell everything and skip buys
LIQUIDATE_ALL = os.getenv("BOT_LIQUIDATE_ALL", "false").lower() == "true"

# Minimum PI value for a trade
MIN_TRADE_PI = float(os.getenv("BOT_MIN_TRADE_PI", "0.00001"))

# Minimum token size we are willing to send in a SELL op
MIN_TOKEN_SIZE = float(os.getenv("BOT_MIN_TOKEN_SIZE", "0.0000001"))

# Price band for BUY side: ignore insane priced tokens
# (tuned: only buy tokens between 0.05 and 100 test Pi)
MIN_BUY_PRICE = float(os.getenv("BOT_MIN_BUY_PRICE", "0.05"))
MAX_BUY_PRICE = float(os.getenv("BOT_MAX_BUY_PRICE", "100.0"))

# Safety caps
MAX_TRADES_PER_RUN = int(os.getenv("BOT_MAX_TRADES_PER_RUN", "20"))
MAX_BUYS_PER_BUCKET = int(os.getenv("BOT_MAX_BUYS_PER_BUCKET", "5"))
MAX_SELLS_PER_BUCKET = int(os.getenv("BOT_MAX_SELLS_PER_BUCKET", "5"))

# How many assets to ask bot_markets for (Horizon / DEX markets).
# This is the *global* scan limit; set via env if you want.
MAX_ASSETS_SCAN = int(os.getenv("BOT_MAX_ASSETS_SCAN", "2000"))

# Take profit thresholds by risk.
# IMPORTANT:
#   - The bot NEVER auto-sells at a loss.
#   - There is NO automatic stop-loss in normal mode.
#   - Losses can only be realized by manual user actions or manual liquidation.
RISK_TP_SL = {
  "low": {
    # was 3.0 – now tighter, takes profit earlier
    "take_profit_pct": 1.5,
    "stop_loss_pct": 0.0,  # unused, no auto stop-loss
  },
  "medium": {
    # was 2.0 – now tighter
    "take_profit_pct": 1.0,
    "stop_loss_pct": 0.0,  # unused, no auto stop-loss
  },
  "high": {
    # was 1.0 – now tighter
    "take_profit_pct": 0.7,
    "stop_loss_pct": 0.0,  # unused, no auto stop-loss
  },
}

# Strategy blending per risk level
# These mostly control the fallback / non-wall trades after wall-breaking.
RISK_WEIGHTS = {
  "low": {
    "max_tokens": 1000,
    "per_run_fraction": 0.25,
    "max_per_token_fraction": 0.50,
    "trend_weight": 0.6,
    "micro_weight": 0.4,
    "vol_weight": 0.0,
    "max_spread_pct": 40.0,   # was 30.0
  },
  "medium": {
    "max_tokens": 1000,
    "per_run_fraction": 0.50,
    "max_per_token_fraction": 0.80,
    "trend_weight": 0.4,
    "micro_weight": 0.3,
    "vol_weight": 0.3,
    "max_spread_pct": 150.0,  # was 100.0
  },
  "high": {
    "max_tokens": 1000,
    "per_run_fraction": 0.90,
    "max_per_token_fraction": 1.00,
    "trend_weight": 0.15,
    "micro_weight": 0.30,
    "vol_weight": 0.55,
    "max_spread_pct": 200.0,  # was 150.0
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

# Max drawdown protection (UI shows these values)
# Based on *net deposits* into a bucket (sum deposits - sum withdrawals).
MAX_DRAWDOWN_PCT_BY_RISK = {
  "low": 15.0,     # up to ~15% drawdown on low
  "medium": 30.0,  # up to ~30% drawdown on medium
  "high": 45.0,    # up to ~45% drawdown on high
}

# Sell wall logic
# If wall_value_pi > SELL_WALL_FRACTION * bucket_cash -> skip that market
SELL_WALL_FRACTION = float(os.getenv("BOT_SELL_WALL_FRACTION", "0.4"))
# Boost in scoring for tokens where we CAN break the wall
WALL_BREAK_SCORE_BOOST = float(os.getenv("BOT_WALL_BREAK_SCORE_BOOST", "3.0"))
# Fallback quick-sell markup if we don't know the next ask (percent)
QUICK_SELL_FALLBACK_PCT = float(os.getenv("BOT_QUICK_SELL_FALLBACK_PCT", "2.0"))

# Maximum size at the *lowest* sell price we are willing to buy into.
# Example: skip DORIS if lowest ask has 985,910 DORIS on that level.
MAX_TOP_ASK_TOKENS = float(os.getenv("BOT_MAX_TOP_ASK_TOKENS", "5000.0"))

# Hard minimum total liquidity for a market (in PI). Filters out tiny pools.
MIN_TOTAL_LIQUIDITY_PI = float(os.getenv("BOT_MIN_TOTAL_LIQUIDITY_PI", "5000.0"))

# Hard cap on how much PI we ever spend in a single trade.
MAX_PI_PER_TRADE = float(os.getenv("BOT_MAX_PI_PER_TRADE", "200.0"))

# Pause duration (seconds) after a manual bucket liquidation
LIQUIDATE_PAUSE_SECS = int(os.getenv("BOT_LIQUIDATE_PAUSE_SECS", "60"))


def _now() -> int:
  return int(time.time())


# ---------------------------------------------------------------------
# PI amount helper: clamp to 7 decimals (stroop precision)
# ---------------------------------------------------------------------

_PI_QUANTUM = Decimal("0.0000001")

def quantize_pi(value: float) -> float:
  """
  Clamp a PI amount to at most 7 decimal places using Decimal,
  removing float noise like 0.0013799999998753698.

  Always returns a normal float with <= 7 decimal precision.
  """
  d = Decimal(str(value))
  dq = d.quantize(_PI_QUANTUM, rounding=ROUND_HALF_UP)
  return float(dq)


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
  paused_until: int = 0   # if > now, bucket is temporarily paused from trading


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
  top_ask_amount: float = 0.0    # size of top-of-book ask (tokens, lowest sell)
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
        IFNULL(alloc.amount, 0) AS cash_pi,
        IFNULL(b.paused_until, 0) AS paused_until
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
        paused_until=int(r["paused_until"] or 0),
      )
    )
  return buckets


def load_bucket_by_id(bucket_id: int) -> Optional[Bucket]:
  """
  Load a single bucket (even if it has zero cash) for per-bucket operations.
  """
  with conn() as cx:
    r = cx.execute(
      """
      SELECT
        b.id AS bucket_id,
        b.account_id,
        a.username,
        b.risk_level,
        b.objective,
        b.volatility,
        b.time_horizon_days,
        IFNULL(alloc.amount, 0) AS cash_pi,
        IFNULL(b.paused_until, 0) AS paused_until
      FROM bot_buckets b
      JOIN bot_accounts a ON a.id = b.account_id
      LEFT JOIN bot_bucket_allocations alloc
        ON alloc.bucket_id = b.id
       AND alloc.account_id = b.account_id
      WHERE b.id = ?
      """,
      (bucket_id,),
    ).fetchone()

  if not r:
    return None

  return Bucket(
    id=r["bucket_id"],
    account_id=r["account_id"],
    username=r["username"],
    risk_level=(r["risk_level"] or "medium").lower(),
    objective=(r["objective"] or "balanced").lower(),
    volatility=(r["volatility"] or "medium").lower(),
    time_horizon_days=int(r["time_horizon_days"] or 10),
    cash_pi=float(r["cash_pi"] or 0.0),
    paused_until=int(r["paused_until"] or 0),
  )


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
  """
  Normalize raw market data into PI-per-token prices.

  Instead of blindly trusting orderbook_sell_token, we choose whichever
  book (token_selling or pi_selling) actually has a usable price /
  liquidity, so the bot sees the same markets the Pi Wallet does.
  """
  markets: Dict[Tuple[str, str], MarketInfo] = {}

  def _book_score(ob: Dict[str, Any]) -> float:
    """
    Higher score = more usable book.
    We reward non-zero prices and total liquidity.
    """
    if not ob:
      return 0.0
    mid = ob.get("mid_price") or 0.0
    best_bid = ob.get("best_bid_price") or 0.0
    best_ask = ob.get("best_ask_price") or 0.0
    bid_liq = ob.get("total_bid_liquidity") or 0.0
    ask_liq = ob.get("total_ask_liquidity") or 0.0
    total_liq = float(bid_liq) + float(ask_liq)
    has_price = any([
      float(mid or 0.0) > 0,
      float(best_bid or 0.0) > 0,
      float(best_ask or 0.0) > 0,
    ])
    if not has_price or total_liq <= 0:
      return 0.0
    return total_liq

  for m in raw_markets:
    code = m.get("code")
    issuer = m.get("issuer")
    if not code or not issuer:
      continue

    ob_token = m.get("orderbook_sell_token") or {}
    ob_pi    = m.get("orderbook_sell_pi") or {}

    # Decide which orientation to use for prices.
    score_token = _book_score(ob_token)
    score_pi    = _book_score(ob_pi)

    if score_token == 0.0 and score_pi == 0.0:
      # No usable book in either direction
      continue

    if score_pi > score_token:
      price_ob = ob_pi
      other_ob = ob_token
    else:
      price_ob = ob_token
      other_ob = ob_pi

    # Prices and spreads strictly from the chosen orderbook
    best_bid = price_ob.get("best_bid_price")
    best_ask = price_ob.get("best_ask_price")
    mid_price = price_ob.get("mid_price")
    spread_pct = price_ob.get("spread_pct")

    # Liquidity details – prefer from same book, fall back to the other if needed
    bid_liq = (
      price_ob.get("total_bid_liquidity")
      or other_ob.get("total_bid_liquidity")
      or 0.0
    )
    ask_liq = (
      price_ob.get("total_ask_liquidity")
      or other_ob.get("total_ask_liquidity")
      or 0.0
    )
    num_bid_levels = (
      price_ob.get("num_bid_levels")
      or other_ob.get("num_bid_levels")
      or 0
    )
    num_ask_levels = (
      price_ob.get("num_ask_levels")
      or other_ob.get("num_ask_levels")
      or 0
    )

    try:
      best_bid_f = float(best_bid or 0.0)
      best_ask_f = float(best_ask or 0.0)
      mid_f = float(mid_price or 0.0)
      # spread can legitimately be "unknown" – keep that as None
      spread_f = float(spread_pct) if spread_pct is not None else None
      bid_liq_f = float(bid_liq or 0.0)
      ask_liq_f = float(ask_liq or 0.0)
      nb = int(num_bid_levels or 0)
      na = int(num_ask_levels or 0)
    except Exception:
      continue

    # Asks ladder (for wall size etc.)
    top_ask_amount_f = 0.0
    next_ask_price_f = 0.0

    raw_asks = None
    for key_name in ("asks", "ask_levels", "sell_levels", "ask_book"):
      v = price_ob.get(key_name) or other_ob.get(key_name)
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
      spread_pct=spread_f if spread_f is not None else 0.0,
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

    # Clamp bucket cash to 7 decimal places to remove float noise
    new_amt = quantize_pi(new_amt)

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
# Drawdown + deposit / performance helpers
# ---------------------------------------------------------------------

def get_bucket_deposit_stats(bucket_id: int) -> Tuple[float, float, float]:
  """
  Return (total_deposits, total_withdraws, net_deposit) for this bucket.

  - total_deposits: all 'deposit' transfers into this bucket
  - total_withdraws: all 'withdraw' transfers out of this bucket
  - net_deposit: max(total_deposits - total_withdraws, 0)

  We use net_deposit as the denominator for BOTH:
    - planned max drawdown
    - realized performance %
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
    return 0.0, 0.0, 0.0

  total_deposits = float(row["total_deposits"] or 0.0)
  total_withdraws = float(row["total_withdraws"] or 0.0)
  net = total_deposits - total_withdraws
  if net < 0:
    net = 0.0
  return total_deposits, total_withdraws, net


def get_bucket_first_deposit_ts(bucket_id: int) -> Optional[int]:
  """
  Return the timestamp of the first deposit into this bucket, or None.

  We use this to ensure that "realized performance" for a bucket only
  considers trades that happened AFTER the bucket was actually funded.

  This prevents old experimental trades (re-using bucket ids etc) from
  leaking into a brand-new bucket's performance.
  """
  with conn() as cx:
    row = cx.execute(
      """
      SELECT MIN(created_at) AS first_ts
      FROM bot_bucket_transfers
      WHERE bucket_id = ?
      """,
      (bucket_id,),
    ).fetchone()

  if not row:
    return None

  first_ts = row["first_ts"]
  if first_ts is None:
    return None

  try:
    return int(first_ts)
  except Exception:
    return None


def get_planned_max_drawdown_pct(bucket: Bucket) -> Optional[float]:
  risk = (bucket.risk_level or "medium").lower()
  return MAX_DRAWDOWN_PCT_BY_RISK.get(risk)


def get_bucket_net_deposit_pi(bucket_id: int) -> float:
  """
  Net deposits for this bucket across *all time*:

      net_deposit = sum(deposits) - sum(withdrawals)

  This is the base we compare equity and realized PnL against.
  """
  _, _, net = get_bucket_deposit_stats(bucket_id)
  return net


def compute_bucket_realized_pnl_pi(bucket_id: int) -> float:
  """
  Compute realized PnL in PI for a bucket, using only SELL trades.

  For each asset (code, issuer) within THIS bucket:
    - Consider trades only AFTER the first deposit into this bucket.
    - Compute average buy price:
          avg_buy_price = total_buy_pi / total_buy_qty
    - Realized PnL for that asset:
          realized_asset = total_sell_pi - (total_sell_qty * avg_buy_price)

  Then sum realized_asset across all assets.

  Buys themselves do NOT move realized PnL, they just build inventory and
  update average cost. Only sells at a price higher or lower than that cost
  move realized PnL.

  Note:
    - In normal mode the bot never auto-sells at a loss, so negative
      realized PnL comes only from manual user actions or manual liquidation.
  """
  start_ts = get_bucket_first_deposit_ts(bucket_id)

  with conn() as cx:
    if start_ts is not None:
      rows = cx.execute(
        """
        SELECT code,
               issuer,
               side,
               SUM(amount_token) AS qty,
               SUM(amount_pi)    AS pi
        FROM bot_trades
        WHERE bucket_id = ?
          AND created_at >= ?
        GROUP BY code, issuer, side
        """,
        (bucket_id, start_ts),
      ).fetchall()
    else:
      # If the bucket somehow has trades but no deposit rows,
      # we still compute, but this should be rare.
      rows = cx.execute(
        """
        SELECT code,
               issuer,
               side,
               SUM(amount_token) AS qty,
               SUM(amount_pi)    AS pi
        FROM bot_trades
        WHERE bucket_id = ?
        GROUP BY code, issuer, side
        """,
        (bucket_id,),
      ).fetchall()

  per_asset: Dict[Tuple[str, str], Dict[str, float]] = {}
  for r in rows:
    key = (r["code"], r["issuer"])
    d = per_asset.setdefault(
      key,
      {"buy_qty": 0.0, "buy_pi": 0.0, "sell_qty": 0.0, "sell_pi": 0.0},
    )
    side = (r["side"] or "").lower()
    qty = float(r["qty"] or 0.0)
    pi = float(r["pi"] or 0.0)
    if side == "buy":
      d["buy_qty"] += qty
      d["buy_pi"] += pi
    elif side == "sell":
      d["sell_qty"] += qty
      d["sell_pi"] += pi

  realized = 0.0
  for key, d in per_asset.items():
    buy_qty = d["buy_qty"]
    buy_pi = d["buy_pi"]
    sell_qty = d["sell_qty"]
    sell_pi = d["sell_pi"]
    # If we never bought, or never sold, nothing to realize.
    if sell_qty <= 0 or buy_qty <= 0 or buy_pi <= 0:
      continue
    avg_buy_price = buy_pi / buy_qty          # PI per token
    cost_of_sold = sell_qty * avg_buy_price   # PI
    realized += (sell_pi - cost_of_sold)

  return realized


def compute_bucket_realized_perf_pct(bucket_id: int) -> Optional[float]:
  """
  Realized performance percent for this bucket:

      realized_perf_pct = (realized_PnL / net_deposit) * 100

  where:
    - net_deposit = total_deposits - total_withdraws for THIS bucket
    - realized_PnL is computed from THIS bucket's trades only, and only
      after the first deposit into this bucket.
  """
  total_deposits, total_withdraws, net_deposit = get_bucket_deposit_stats(bucket_id)

  # If user never really funded this bucket, or has effectively zero
  # net deposit, skip the percent to avoid crazy numbers.
  if net_deposit <= 1e-8:
    return None

  realized_pnl = compute_bucket_realized_pnl_pi(bucket_id)

  # Optional safety: in a sane, non-leveraged world, realized losses
  # should not exceed the net deposit. If they do due to rounding or
  # some edge case, clamp at -100%.
  if realized_pnl < -net_deposit:
    realized_pnl = -net_deposit

  return (realized_pnl / net_deposit) * 100.0


# ---------------------------------------------------------------------
# Cash resync helper (for manual liquidation)
# ---------------------------------------------------------------------

def resync_bucket_cash_to_equity(bucket_id: int) -> float:
  """
  After a manual liquidation (positions flat and open BUY offers
  cancelled for this bucket), we want the bucket's internal cash to
  match its equity in PI:

      equity ≈ net_deposit + realized_PnL

  This makes:
    - 'Available bucket cash' jump up to the full free amount
    - 'Active in orders / holdings' ≈ 0 after liquidation
  """
  # Net deposits
  _, _, net_deposit = get_bucket_deposit_stats(bucket_id)
  if net_deposit < 0:
    net_deposit = 0.0

  # Realized PnL from closed trades
  realized_pnl = compute_bucket_realized_pnl_pi(bucket_id)

  target_cash = net_deposit + realized_pnl
  if target_cash < 0:
    target_cash = 0.0

  # Clamp to stroop precision
  target_cash = quantize_pi(target_cash)

  ts = _now()
  with conn() as cx:
    row = cx.execute(
      "SELECT id FROM bot_bucket_allocations WHERE bucket_id = ?",
      (bucket_id,),
    ).fetchone()
    if not row:
      return 0.0
    cx.execute(
      "UPDATE bot_bucket_allocations "
      "SET amount = ?, updated_at = ? "
      "WHERE id = ?",
      (target_cash, ts, row["id"]),
    )

  return target_cash


# ---------------------------------------------------------------------
# Strategy scoring (for fallback, non-wall trades)
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
# Sell logic (aggressive scalping + liquidation mode)
# ---------------------------------------------------------------------

def plan_sells_for_bucket(
  bucket: Bucket,
  positions: Dict[Tuple[str, str], Position],
  markets: Dict[Tuple[str, str], MarketInfo],
  liquidate: bool = False,
) -> List[Tuple[Position, MarketInfo, float]]:
  """
  Normal mode:
    - If PnL >= TP% (AND PnL > 0), sell the *entire* position for that bucket.
    - The bot NEVER auto-sells at a loss or at break-even.
  Liquidation mode (LIQUIDATE_ALL=True or liquidate=True):
    - Sell ALL positions at current best_bid (subject to self-cross protections).
    - This path is considered a manual admin action and may realize losses.
  """
  if not positions:
    return []

  # Full liquidation: ignore TP in liquidation mode
  # (still respecting min sizes + self-cross protections).
  if LIQUIDATE_ALL or liquidate:
    planned: List[Tuple[Position, MarketInfo, float]] = []
    for key, pos in positions.items():
      market = markets.get(key)
      if not market or market.best_bid <= 0 or pos.quantity <= 0:
        continue
      # Skip microscopic trash that would fail on chain
      if pos.quantity * market.best_bid < MIN_TRADE_PI:
        continue
      if pos.quantity < MIN_TOKEN_SIZE:
        continue
      planned.append((pos, market, pos.quantity))
    # Largest value first
    planned.sort(key=lambda t: t[2] * t[1].best_bid, reverse=True)
    return planned

  # Normal TP-only mode (no automatic stop-loss)
  cfg = RISK_TP_SL.get(bucket.risk_level, RISK_TP_SL["medium"])
  tp = cfg["take_profit_pct"]

  planned: List[Tuple[Position, MarketInfo, float]] = []

  for key, pos in positions.items():
    market = markets.get(key)
    if not market or market.best_bid <= 0 or pos.quantity <= 0 or pos.avg_price_pi <= 0:
      continue

    pnl_pct = (market.best_bid - pos.avg_price_pi) / pos.avg_price_pi * 100.0

    # The bot never auto-sells at a loss or at break-even.
    if pnl_pct <= 0:
      continue

    # Only take profit once we cross the TP threshold.
    if pnl_pct >= tp:
      amount_to_sell = pos.quantity
      if amount_to_sell * market.best_bid < MIN_TRADE_PI:
        continue
      planned.append((pos, market, amount_to_sell))

  # Prioritize larger sales first
  planned.sort(key=lambda t: t[2] * t[1].best_bid, reverse=True)
  return planned[:MAX_SELLS_PER_BUCKET]


def execute_sells_for_bucket(
  bucket: Bucket,
  plans: List[Tuple[Position, MarketInfo, float]],
  liquidate: bool = False,
  blocked_assets: Optional[List[Dict[str, str]]] = None,
) -> int:
  """
  Execute SELL plans for this bucket.

  Normal mode:
    - All plans come from plan_sells_for_bucket in TP-only mode,
      so every automatic SELL is at a profit.
  Liquidation mode:
    - We may sell at a loss, but ONLY when:
        * LIQUIDATE_ALL env is set, or
        * liquidate=True via the explicit liquidation helper.
    - This is treated as a manual admin action, not normal bot behavior.
  """
  executed = 0
  for pos, market, amount_to_sell in plans:
    if not (LIQUIDATE_ALL or liquidate) and executed >= MAX_SELLS_PER_BUCKET:
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

    if amount_to_sell <= 0:
      continue

    # Hard guard against microscopic token sizes that would create
    # op_malformed on Horizon (like the CSK example).
    if amount_to_sell < MIN_TOKEN_SIZE:
      print(
        f"[SELL] skip bucket={bucket.id} user=@{bucket.username} "
        f"{market.code} size {amount_to_sell:.8f} below MIN_TOKEN_SIZE"
      )
      continue

    # Compute PnL % for this position (used for deciding whether to
    # tear down our own BUY wall to realize gains in normal mode).
    pnl_pct = None
    try:
      if pos.avg_price_pi > 0 and market.mid_price > 0:
        pnl_pct = (market.mid_price - pos.avg_price_pi) / pos.avg_price_pi * 100.0
    except Exception:
      pnl_pct = None

    # Avoid op_cross_self on SELL side
    try:
      if would_cross_self_sell(market.code, market.issuer, best_bid):
        # In liquidation mode we do NOT tear down ladders. We simply mark
        # this asset as blocked and skip it this pass so the API can warn
        # the user instead of wasting test Pi on failing txs.
        if LIQUIDATE_ALL or liquidate:
          print(
            f"[SELL] cannot liquidate bucket={bucket.id} user=@{bucket.username} "
            f"{market.code} @ {best_bid:.6f} PI because it would cross own BUY offer"
          )
          if blocked_assets is not None:
            blocked_assets.append({"code": market.code, "issuer": market.issuer})
          continue

        # Normal mode: we may tear down profitable BUY ladders to realize gains
        is_profit = pnl_pct is not None and pnl_pct > 0.0

        if is_profit:
          # Try to cancel blocking BUY offers on this pair at or above best_bid
          try:
            cancelled = cancel_blocking_buy_offers_for_pair(
              market.code,
              market.issuer,
              best_bid,
            )
            print(
              f"[SELL] bucket={bucket.id} user=@{bucket.username} "
              f"{market.code} cancelled {cancelled} blocking BUY offers "
              f"to realize profitable SELL"
            )
          except Exception as e:
            print(
              f"[SELL] warning: failed to cancel blocking BUY offers for "
              f"{market.code} in bucket {bucket.id}: {e}"
            )

          # Re-check self cross after cancellations, if still crossing,
          # skip to avoid Horizon op_cross_self.
          if would_cross_self_sell(market.code, market.issuer, best_bid):
            print(
              f"[SELL] skip bucket={bucket.id} user=@{bucket.username} "
              f"{market.code} price {best_bid:.6f} would still cross own BUY offer "
              f"after cancel attempt"
            )
            continue
        else:
          # Non positive PnL, do not tear down our own BUY ladder
          print(
            f"[SELL] skip bucket={bucket.id} user=@{bucket.username} "
            f"{market.code} price {best_bid:.6f} would cross own BUY offer "
            f"(PnL not positive, keeping BUY ladder)"
          )
          continue
    except Exception as e:
      print(
        f"[SELL] warning: self cross check failed for {market.code} "
        f"in bucket {bucket.id}: {e}"
      )

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
        strategy_tag="liquidate" if (LIQUIDATE_ALL or liquidate) else "tp_only",
        tx_resp=resp,
      )
      executed += 1
    except Exception as e:
      print(f"[ERROR] sell failed for {market.code} in bucket {bucket.id}: {e}")

  return executed


# ---------------------------------------------------------------------
# Buy logic (wall-break first, then aggressive fallback)
# ---------------------------------------------------------------------

def plan_buys_for_bucket(
  bucket: Bucket,
  markets: Dict[Tuple[str, str], MarketInfo],
) -> List[Tuple[MarketInfo, float]]:
  """
  Decide which markets to buy for this bucket.

  Rules:
    - Skip tokens whose *lowest* sell wall has more than MAX_TOP_ASK_TOKENS
      available (e.g. 985,910 DORIS @ 10.0).
    - FIRST PRIORITY: if bucket can break a reasonable sell wall, do it
      (buy the wall value in PI) and set up a scalp.
    - SECOND: use remaining budget on highest-score markets.
    - No micro buys if bucket can afford >= 1 full token.
  """
  if LIQUIDATE_ALL:
    # In liquidation mode we never open new positions
    return []

  risk = bucket.risk_level if bucket.risk_level in RISK_WEIGHTS else "medium"
  cfg = RISK_WEIGHTS[risk]

  if bucket.cash_pi <= MIN_TRADE_PI:
    return []

  remaining_cash = bucket.cash_pi
  max_spread = cfg["max_spread_pct"]
  max_tokens_cfg = cfg["max_tokens"]

  wall_candidates: List[Tuple[float, MarketInfo]] = []
  scored: List[Tuple[float, MarketInfo]] = []

  for key, m in markets.items():
    # Never BUY blocked tokens, we can still SELL them
    if m.code in BLOCKED_BUY_CODES:
      continue

    # Orderbook sanity:
    # - require a positive best_ask (we need something to buy)
    # - require some total liquidity
    # - only cap spread on the high side; allow 0 / None
    if m.best_ask <= 0:
      continue
    if m.total_liq <= 0:
      continue
    if (m.spread_pct is not None) and (m.spread_pct > max_spread):
      continue

    # Only consider reasonably deep markets – ignore tiny side pools
    if m.total_liq < MIN_TOTAL_LIQUIDITY_PI:
      continue

    # Ignore tokens with insane price levels on the BUY side
    # tuned: only between 0.05 and 100 test Pi
    if m.best_ask < MIN_BUY_PRICE or m.best_ask > MAX_BUY_PRICE:
      continue

    # NEW: skip tokens whose lowest sell wall is gigantic
    # (e.g. 985,910 DORIS @ 10.0).
    lowest_ask_tokens = m.top_ask_amount if m.top_ask_amount > 0 else 0.0

    # Fallback: if we don't have a clean top-of-book size, approximate it
    # from total ask liquidity / number of ask levels so MAX_TOP_ASK_TOKENS
    # still works even when the raw ladder doesn't expose an "amount" field.
    if lowest_ask_tokens <= 0 and m.ask_liq > 0 and m.num_ask_levels:
      lowest_ask_tokens = m.ask_liq / float(m.num_ask_levels)
      print(
        f"[BUY] market={m.code} inferred lowest ask size≈{lowest_ask_tokens:.6f} tokens "
        f"(top_ask_amount=0, ask_liq≈{m.ask_liq:.6f}, levels={m.num_ask_levels})"
      )
    elif lowest_ask_tokens > 0:
      # Log what we see at the top of the book when we have it directly
      print(
        f"[BUY] market={m.code} top ask size≈{lowest_ask_tokens:.6f} tokens "
        f"(top_ask_amount field)"
      )

    if lowest_ask_tokens > MAX_TOP_ASK_TOKENS:
      print(
        f"[BUY] skip bucket={bucket.id} user=@{bucket.username} "
        f"{m.code} lowest ask size {lowest_ask_tokens:.6f} > "
        f"MAX_TOP_ASK_TOKENS={MAX_TOP_ASK_TOKENS}"
      )
      continue

    # Sell wall detection relative to this bucket
    wall_qty_tokens = m.top_ask_amount if m.top_ask_amount > 0 else 0.0
    if wall_qty_tokens <= 0 and m.ask_liq > 0:
      denom = m.num_ask_levels or 1
      wall_qty_tokens = m.ask_liq / float(denom)

    wall_value_pi = float(wall_qty_tokens) * float(m.best_ask)
    m.wall_value_pi = wall_value_pi
    m.wall_break_candidate = False

    potential_edge = 0.0
    if m.next_ask_price and m.next_ask_price > m.best_ask:
      potential_edge = (m.next_ask_price - m.best_ask) / m.best_ask

    # If we can break the wall with this bucket's cash, mark as candidate
    if wall_value_pi > 0 and remaining_cash >= wall_value_pi and wall_value_pi >= MIN_TRADE_PI:
      m.wall_break_candidate = True
      wall_candidates.append((potential_edge, m))

    # Normal strategy score, fallback
    base_score = compute_score(m, cfg)
    score = base_score + max(0.0, potential_edge) * 10.0

    # Prefer non "DT" style tokens, still allow them if not blocked
    if m.code.startswith("DT"):
      score *= 0.2
    else:
      score *= 1.2

    # Strongly prefer markets where we can actually break the wall
    if m.wall_break_candidate:
      score *= WALL_BREAK_SCORE_BOOST

    scored.append((score, m))

  planned: List[Tuple[MarketInfo, float]] = []

  # Pass 1, break sell walls if possible
  wall_candidates.sort(key=lambda x: x[0], reverse=True)  # best edge first

  for edge, m in wall_candidates:
    if remaining_cash < MIN_TRADE_PI:
      break
    if len(planned) >= MAX_BUYS_PER_BUCKET:
      break

    spend = min(remaining_cash, m.wall_value_pi, MAX_PI_PER_TRADE)
    if spend < MIN_TRADE_PI:
      continue

    planned.append((m, spend))
    remaining_cash -= spend

  # Pass 2, fallback aggressive buys if we still have cash
  if len(planned) < MAX_BUYS_PER_BUCKET and remaining_cash >= MIN_TRADE_PI:
    per_run_budget = remaining_cash * cfg["per_run_fraction"]
    if per_run_budget < MIN_TRADE_PI:
      per_run_budget = remaining_cash

    max_per_token = bucket.cash_pi * cfg["max_per_token_fraction"]

    scored.sort(key=lambda x: x[0], reverse=True)
    tokens_considered = 0

    for score, m in scored:
      if tokens_considered >= max_tokens_cfg:
        break
      tokens_considered += 1

      # Skip markets already used as wall breaks
      if any(p[0].code == m.code and p[0].issuer == m.issuer for p in planned):
        continue

      if per_run_budget < MIN_TRADE_PI:
        break
      if len(planned) >= MAX_BUYS_PER_BUCKET:
        break

      token_budget = min(max_per_token, per_run_budget, MAX_PI_PER_TRADE)
      if token_budget < MIN_TRADE_PI:
        break

      planned.append((m, token_budget))
      per_run_budget -= token_budget

  return planned


def execute_buys_for_bucket(
  bucket: Bucket,
  plans: List[Tuple[MarketInfo, float]],
) -> int:
  """
  Execute planned buys with "no micro buys unless necessary".

    If pi_budget >= best_ask,
      buy floor(pi_budget / best_ask) whole tokens.
    Else,
      use pi_budget as is, true micro buy when you cannot afford one full token.
  """
  if LIQUIDATE_ALL:
    # In liquidation mode we never open new positions
    return 0

  # Log the markets the bucket is actually considering buying into
  if plans:
    summary = []
    for m, pi_budget in plans:
      summary.append(
        f"{m.code}@{m.best_ask:.6f} (liq≈{m.total_liq:.2f}, top_ask≈{m.top_ask_amount:.4f})"
      )
    print(
      f"[BUY] usable markets for bucket={bucket.id} user=@{bucket.username}: "
      + ", ".join(summary)
    )

  executed = 0
  for market, pi_budget in plans:
    if executed >= MAX_BUYS_PER_BUCKET:
      break

    if pi_budget < MIN_TRADE_PI:
      continue

    best_ask = market.best_ask
    if best_ask <= 0:
      continue

    # Avoid op_cross_self on the buy side, skip if this price would hit our own SELL offer
    try:
      if would_cross_self_buy(market.code, market.issuer, best_ask):
        print(
          f"[BUY] skip bucket={bucket.id} user=@{bucket.username} "
          f"{market.code} price {best_ask:.6f} would cross own SELL offer"
        )
        continue
    except Exception as e:
      print(
        f"[BUY] warning: self cross check failed for {market.code} "
        f"in bucket {bucket.id}: {e}"
      )

    # Refresh current cash from DB in case previous trades changed it
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
    if current_cash <= 0:
      continue

    # Clamp pi_budget to what we actually have
    pi_budget = min(pi_budget, current_cash)

    # No micro buys unless we literally cannot afford one full token
    if pi_budget >= best_ask:
      full_tokens = int(pi_budget / best_ask)
      if full_tokens <= 0:
        continue
      trade_pi_budget = full_tokens * best_ask
    else:
      # cannot afford one full token, use everything, micro buy
      trade_pi_budget = pi_budget

    if trade_pi_budget < MIN_TRADE_PI:
      continue

    amount_token = trade_pi_budget / best_ask
    # Record entry price so we can guarantee auto quick-sells are never at a loss
    entry_price = best_ask

    try:
      print(
        f"[BUY] bucket={bucket.id} user=@{bucket.username} "
        f"spend~{trade_pi_budget:.6f} PI on {market.code} @ {best_ask:.6f} PI"
      )
      # Always price off the current orderbook best ask
      resp = market_buy(
        token_code=market.code,
        token_issuer=market.issuer,
        max_cost_pi=trade_pi_budget,
        best_price=best_ask,
      )
      upsert_position(bucket.id, market, delta_qty=amount_token, trade_price_pi=best_ask)
      update_cash_for_bucket(bucket.id, delta_pi=-trade_pi_budget)
      log_trade(
        bucket=bucket,
        side="buy",
        market=market,
        amount_token=amount_token,
        price_pi=best_ask,
        strategy_tag="wall_break" if market.wall_break_candidate else "blend",
        tx_resp=resp,
      )
      executed += 1

      # If this market had a breakable wall, immediately place a quick
      # SELL just under the next ask level (for fast fills).
      if market.wall_break_candidate:
        try:
          if market.next_ask_price and market.next_ask_price > market.best_ask:
            # Place just under the next best sell offer for a quick gain
            target_price = market.next_ask_price * 0.999
          else:
            # No clear next ask level: keep it simple and skip auto quick-sell
            print(
              f"[SCALP] no clean next_ask_price for {market.code}, "
              f"skipping auto quick-sell"
            )
            continue

          # Hard guard: never place quick-sell at or below our entry price
          if target_price <= entry_price:
            print(
              f"[SCALP] skip quick wall-break SELL for {market.code} "
              f"@ {target_price:.6f} PI (target <= entry {entry_price:.6f})"
            )
            continue

          # Skip quick SELL if it would cross our own BUY offer
          if would_cross_self_sell(market.code, market.issuer, target_price):
            print(
              f"[SCALP] skip quick wall-break SELL for {market.code} "
              f"@ {target_price:.6f} PI (would cross own BUY offer)"
            )
            continue

          wallet_qty = get_bot_token_balance(market.code, market.issuer)
          quick_qty = min(wallet_qty, amount_token)

          if quick_qty * target_price >= MIN_TRADE_PI:
            print(
              f"[SCALP] bucket={bucket.id} user=@{bucket.username} "
              f"placing quick wall-break SELL {quick_qty:.6f} {market.code} "
              f"@ {target_price:.6f} PI"
            )
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
# Bucket equity estimation / drawdown
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
# Per-bucket asset discovery for liquidation
# ---------------------------------------------------------------------

def get_bucket_traded_asset_codes(bucket_id: int) -> List[str]:
  """
  Collect all asset codes this bucket has actually used, based on
  current positions and historical trades. We use this to cancel
  open BUY offers for those assets when the user presses
  'LIQUIDATE HOLDINGS & OFFERS'.
  """
  codes = set()
  with conn() as cx:
    # From current positions
    rows_pos = cx.execute(
      "SELECT DISTINCT code FROM bot_positions WHERE bucket_id = ?",
      (bucket_id,),
    ).fetchall()
    for r in rows_pos:
      code = r["code"]
      if code:
        codes.add(code)

    # From historical trades (in case we have open offers but no position)
    rows_tr = cx.execute(
      "SELECT DISTINCT code FROM bot_trades WHERE bucket_id = ?",
      (bucket_id,),
    ).fetchall()
    for r in rows_tr:
      code = r["code"]
      if code:
        codes.add(code)

  return list(codes)


# ---------------------------------------------------------------------
# Pause helper
# ---------------------------------------------------------------------

def pause_bucket(bucket_id: int, seconds: int) -> int:
  """
  Set paused_until for this bucket so the engine skips trading it
  for the given number of seconds.
  """
  now_ts = _now()
  secs = max(0, int(seconds))
  paused_until = now_ts + secs
  with conn() as cx:
    cx.execute(
      "UPDATE bot_buckets SET paused_until = ? WHERE id = ?",
      (paused_until, bucket_id),
    )
  return paused_until


# ---------------------------------------------------------------------
# Per-bucket liquidation helper (used by API)
# ---------------------------------------------------------------------

def liquidate_bucket_to_cash(bucket_id: int) -> Dict[str, Any]:
  """
  Sell all positions for a single bucket into PI, using liquidation
  semantics (ignoring TP caps, but still respecting self-cross
  protections).

  Also attempts to cancel any open BUY offers for all assets this bucket has traded, so reserved test Pi in the orderbook is released back to the wallet.

  This is considered a manual admin action. It can realize losses.

  After liquidation, we:
    - Clear all positions for this bucket from bot_positions
    - Pause this bucket for LIQUIDATE_PAUSE_SECS so the engine does
      not immediately redeploy the cash.
  """
  ensure_bot_tables()

  bucket = load_bucket_by_id(bucket_id)
  if not bucket:
    return {"cash_after": 0.0, "executed_sells": 0, "blocked_assets": [], "paused_until": 0}

  print(f"[LIQUIDATE] Starting per-bucket liquidation for bucket={bucket.id} user=@{bucket.username}")

  # First, cancel open BUY offers for any assets this bucket has
  # actually touched. This frees wallet test Pi that is still tied
  # up in the orderbook as buy_liabilities.
  asset_codes = get_bucket_traded_asset_codes(bucket_id)
  if asset_codes:
    try:
      print(
        f"[LIQUIDATE] Cancelling open BUY offers for bucket={bucket.id} "
        f"codes={sorted(asset_codes)}"
      )
      cancel_blocked_buy_offers(asset_codes)
    except Exception as e:
      print(
        f"[LIQUIDATE] Warning: failed to cancel BUY offers for bucket="
        f"{bucket.id}: {e}"
      )

  raw_markets = scan_markets_vs_pi(
    max_assets=MAX_ASSETS_SCAN,
    min_num_accounts=1,
    max_spread_pct=None,
  )
  print(f"[LIQUIDATE] scan_markets_vs_pi returned {len(raw_markets)} raw markets")

  try:
    raw_codes = sorted({str(m.get("code")) for m in raw_markets if m.get("code")})
    print(f"[LIQUIDATE] raw markets codes ({len(raw_codes)}): {', '.join(raw_codes)}")
  except Exception:
    pass

  markets = normalize_markets(raw_markets)
  print(f"[LIQUIDATE] normalize_markets produced {len(markets)} usable markets")

  if not markets:
    print("[LIQUIDATE] No markets found, skipping liquidation.")
    # Even though we could not price/sell positions, we *did* cancel
    # BUY offers above, so snap bucket cash back to equity so at least
    # reserved PI shows as free in the UI.
    new_cash = resync_bucket_cash_to_equity(bucket_id)
    paused_until = pause_bucket(bucket_id, LIQUIDATE_PAUSE_SECS)
    print(
      f"[LIQUIDATE] Bucket={bucket_id} paused until {paused_until} "
      f"(no markets found). cash≈{new_cash:.6f} PI"
    )
    return {
      "cash_after": new_cash,
      "executed_sells": 0,
      "blocked_assets": [],
      "paused_until": paused_until,
    }

  positions = load_positions_for_bucket(bucket_id)
  if not positions:
    print("[LIQUIDATE] No positions for this bucket, nothing to sell.")
    # We still cancelled BUY offers above; resync so that all PI that was
    # only reserved in orders now appears as 'Available bucket cash'.
    new_cash = resync_bucket_cash_to_equity(bucket_id)
    paused_until = pause_bucket(bucket_id, LIQUIDATE_PAUSE_SECS)
    print(
      f"[LIQUIDATE] Bucket={bucket_id} paused until {paused_until} "
      f"(no positions). cash≈{new_cash:.6f} PI"
    )
    return {
      "cash_after": new_cash,
      "executed_sells": 0,
      "blocked_assets": [],
      "paused_until": paused_until,
    }

  sell_plans = plan_sells_for_bucket(bucket, positions, markets, liquidate=True)

  blocked_assets: List[Dict[str, str]] = []
  sells_done = execute_sells_for_bucket(
    bucket,
    sell_plans,
    liquidate=True,
    blocked_assets=blocked_assets,
  )
  print(f"[LIQUIDATE] Executed {sells_done} SELLs for bucket={bucket.id}, blocked={len(blocked_assets)}")

  # After liquidation, we clear all positions for this bucket so the
  # bucket is flat from the perspective of IZZA BOT accounting.
  with conn() as cx:
    deleted = cx.execute(
      "DELETE FROM bot_positions WHERE bucket_id = ?",
      (bucket_id,),
    ).rowcount
  print(
    f"[LIQUIDATE] Cleared {deleted} remaining positions for bucket={bucket.id} "
    f"after manual liquidation."
  )

  # Snap final cash to equity = net_deposit + realized_PnL so all
  # previously reserved PI shows as free cash and active holdings go to ~0.
  new_cash = resync_bucket_cash_to_equity(bucket_id)
  print(f"[LIQUIDATE] Finished bucket={bucket.id}, cash≈{new_cash:.6f} PI")

  # Pause this bucket so the engine doesn't immediately redeploy the cash.
  paused_until = pause_bucket(bucket_id, LIQUIDATE_PAUSE_SECS)
  print(
    f"[LIQUIDATE] Bucket={bucket.id} user=@{bucket.username} "
    f"paused_until={paused_until} (≈{LIQUIDATE_PAUSE_SECS}s pause after liquidation)."
  )

  return {
    "cash_after": new_cash,
    "executed_sells": int(sells_done),
    "blocked_assets": blocked_assets,
    "paused_until": paused_until,
  }


# ---------------------------------------------------------------------
# Main engine run
# ---------------------------------------------------------------------

def run_once():
  ensure_bot_tables()

  # First, clear any legacy open BUY offers for blocked tokens
  # so we never keep feeding Datong or stablecoins.
  try:
    cancel_blocked_buy_offers(list(BLOCKED_BUY_CODES))
  except Exception as e:
    print(f"[ENGINE] Warning: cancel_blocked_buy_offers failed: {e}")

  print("[ENGINE] Scanning markets on Pi Testnet...")
  raw_markets = scan_markets_vs_pi(
    max_assets=MAX_ASSETS_SCAN,
    min_num_accounts=1,
    max_spread_pct=None,
  )
  print(f"[ENGINE] scan_markets_vs_pi returned {len(raw_markets)} raw markets")

  # Log all raw codes so we can see exactly what the scanner sees
  try:
    raw_codes = sorted({str(m.get("code")) for m in raw_markets if m.get("code")})
    print(f"[ENGINE] raw markets codes ({len(raw_codes)}): {', '.join(raw_codes)}")
  except Exception:
    pass

  markets = normalize_markets(raw_markets)
  print(f"[ENGINE] normalize_markets produced {len(markets)} usable markets")

  if markets:
    usable_codes = sorted({mi.code for mi in markets.values()})
    print(f"[ENGINE] usable markets after normalization: {', '.join(usable_codes)}")

  if not markets:
    print("[ENGINE] No markets found after normalization.")
    return

  buckets = load_active_buckets()
  if not buckets:
    print("[ENGINE] No active buckets with cash, nothing to do.")
    return

  if LIQUIDATE_ALL:
    print("[ENGINE] LIQUIDATE_ALL=true – selling all positions and skipping buys.")

  total_trades = 0
  now_ts = _now()

  for bucket in buckets:
    # Respect per-bucket pause after manual liquidation
    if bucket.paused_until and bucket.paused_until > now_ts:
      remaining = bucket.paused_until - now_ts
      print(
        f"[ENGINE] Bucket {bucket.id} (@{bucket.username}) is paused for "
        f"{remaining}s after manual liquidation, skipping this run."
      )
      continue

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

    if not LIQUIDATE_ALL and total_trades >= MAX_TRADES_PER_RUN:
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

    if LIQUIDATE_ALL:
      # In liquidation mode we never open new positions, just move to next bucket
      print(
        f"[ENGINE] Bucket {bucket.id} liquidation pass complete – "
        f"cash≈{bucket.cash_pi:.4f} PI"
      )
      continue

    # Enforce planned max drawdown, if hit, skip BUYS for this bucket.
    if bucket_hit_max_drawdown(bucket, positions, markets):
      print(
        f"[ENGINE] Bucket {bucket.id} hit planned max drawdown, "
        f"skipping new BUYS this run (SELLS still allowed, but only at profit)."
      )
      continue

    # Buys, with wall-break logic
    buy_plans = plan_buys_for_bucket(bucket, markets)
    buys_done = execute_buys_for_bucket(bucket, buy_plans)
    total_trades += buys_done
    if not LIQUIDATE_ALL and total_trades >= MAX_TRADES_PER_RUN:
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
# Background entrypoint (legacy: running inside gunicorn)
# ---------------------------------------------------------------------

def bot_loop_forever():
  """
  Continuous loop for background thread.
  Always loops, ignoring LOOP_MODE, this was originally used when the
  bot ran inside the web app process. We now generally run the bot as
  a separate process (python bot_engine.py) from start.sh.
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
  Idempotent starter for legacy mode (bot inside gunicorn process).
  Left here for compatibility; usually not used when the bot is
  launched separately via start.sh.
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
