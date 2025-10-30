# staking.py

import os, re, time, logging, sqlite3, threading
from datetime import datetime, timezone
from decimal import Decimal, ROUND_DOWN, InvalidOperation
from flask import Blueprint, request, jsonify, abort
import requests
from stellar_sdk import (
    Server, Keypair, Asset, TransactionBuilder,
    Claimant, ClaimPredicate, StrKey, exceptions as sx
)

bp_stake = Blueprint("stake", __name__)
log = logging.getLogger(__name__)

# ---------------------------- env helpers ---------------------------------

def _clean(s: str | None) -> str | None:
    if s is None: return None
    return s.strip().replace("\n","").replace("\r","")

def _getenv(name: str, default: str | None = None, required: bool = False) -> str | None:
    v = os.getenv(name, default)
    v = _clean(v) if isinstance(v, str) else v
    if required and not v:
        raise RuntimeError(f"Missing required env var: {name}")
    return v

HORIZON_URL    = _getenv("HORIZON_URL", "https://api.testnet.minepi.com", required=True)
NET_PASSPHRASE = _getenv("NETWORK_PASSPHRASE", "Pi Testnet", required=True)

ASSET_CODE   = _getenv("ASSET_CODE", "IZZA") or "IZZA"
ISSUER_PUB   = _getenv("ISSUER_PUB", required=True)
DISTR_PUB    = _getenv("DISTR_PUB", required=True)
DISTR_SECRET = _getenv("DISTR_SECRET", required=True)

VOTE_ROUND_LENGTH_DAYS = int(_getenv("VOTE_ROUND_LENGTH_DAYS", "180") or "180")
VOTE_ROUND_END_ENV     = _getenv("VOTE_ROUND_END", None)

# % of ad revenue allocated to voters of the winning game (for display/preview)
AD_REVENUE_POOL_PCT = Decimal(_getenv("AD_REVENUE_POOL_PCT", "0.25") or "0.25")

# Early voter max bonus (linear → 0 at deadline). 0.30 = up to +30% weight.
EARLY_BONUS_MAX = Decimal(_getenv("EARLY_BONUS_MAX", "0.30") or "0.30")

# Validate keys early
_env_problems = []
if not StrKey.is_valid_ed25519_public_key(ISSUER_PUB or ""): _env_problems.append("ISSUER_PUB invalid")
if not StrKey.is_valid_ed25519_public_key(DISTR_PUB  or ""): _env_problems.append("DISTR_PUB invalid")
try: Keypair.from_secret(DISTR_SECRET or "")
except Exception: _env_problems.append("DISTR_SECRET invalid")
if _env_problems: raise RuntimeError("staking env invalid: " + ", ".join(_env_problems))

server = Server(HORIZON_URL)

# ------------------------- vote-intent mini store -------------------------

_SQLITE_PATH = _getenv("SQLITE_DB_PATH", "/var/data/izzapay/app.sqlite") or "/var/data/izzapay/app.sqlite"
_vote_lock = threading.Lock()

def _vote_cx():
    cx = sqlite3.connect(_SQLITE_PATH, check_same_thread=False)
    cx.execute("""CREATE TABLE IF NOT EXISTS vote_intents(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      round_end INTEGER NOT NULL,
      proposal   TEXT NOT NULL,
      pub        TEXT NOT NULL,
      amount7    TEXT NOT NULL,
      weight7    TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )""")
    # Backfill safety: older tables may lack weight7
    try:
        cx.execute("ALTER TABLE vote_intents ADD COLUMN weight7 TEXT")
    except Exception:
        pass  # already exists or SQLite variant without IF NOT EXISTS
    return cx

def _vote_add(round_end, proposal, pub, amount7, weight7):
    with _vote_lock:
        cx = _vote_cx()
        cx.execute(
            "INSERT INTO vote_intents(round_end,proposal,pub,amount7,weight7,created_at) VALUES(?,?,?,?,?,?)",
            (int(round_end), proposal, pub, str(amount7), str(weight7), int(time.time()))
        )
        cx.commit(); cx.close()

def _vote_total_weight(round_end, proposal) -> Decimal:
    # Sum weight7, fallback to amount7 if weight7 is NULL (legacy rows)
    with _vote_lock:
        cx = _vote_cx()
        cur = cx.execute(
            "SELECT COALESCE(SUM(CAST(COALESCE(weight7,amount7) AS REAL)),0) "
            "FROM vote_intents WHERE round_end=? AND proposal=?",
            (int(round_end), proposal)
        )
        total = cur.fetchone()[0]
        cx.close()
        return Decimal(str(total or 0))

# ---------------------------- helpers ---------------------------------

def _izza_asset() -> Asset:
    return Asset(ASSET_CODE, ISSUER_PUB)

def _clamp_days(days: int) -> int:
    try:
        d = int(days)
    except Exception:
        d = 0
    return max(1, min(180, d))

def _apr_for_lock(days: int) -> Decimal:
    """
    Linear until 180d, then flat.
    30d ≈ 5% APR, 180d ≈ 15% APR.
    """
    d = _clamp_days(days)
    base  = Decimal("0.05")
    bonus = (Decimal(d) / Decimal(180)) * Decimal("0.10")
    return (base + bonus).quantize(Decimal("0.0001"), rounding=ROUND_DOWN)

def _q7(x: Decimal) -> str:
    # Stellar amounts are up to 7 decimals
    return str(x.quantize(Decimal("0.0000001"), rounding=ROUND_DOWN))

def _reward_for(amt: Decimal, days: int) -> Decimal:
    apr = _apr_for_lock(days)
    return (amt * apr * Decimal(_clamp_days(days)) / Decimal(365)).quantize(
        Decimal("0.0000001"), rounding=ROUND_DOWN
    )

_hex64 = re.compile(r"^[0-9a-fA-F]{64}$")
def _valid_balance_id(s: str | None) -> bool:
    return bool(s) and bool(_hex64.match(s))

def _account_balances(pub: str):
    return server.accounts().account_id(pub).call().get("balances", [])

def _has_trust_and_bal(pub: str, need: Decimal) -> bool:
    for b in _account_balances(pub):
        if b.get("asset_code") == ASSET_CODE and b.get("asset_issuer") == ISSUER_PUB:
            try:
                return Decimal(b["balance"]) >= need
            except Exception:
                return False
    return False

# ---------- robust unlock-time parsing (ISO8601 or epoch, nested predicates)

def _extract_abs_before(obj):
    """Recursively find an 'abs_before' value anywhere in a predicate structure."""
    if obj is None:
        return None
    if isinstance(obj, dict):
        if "abs_before" in obj:
            return obj["abs_before"]
        for v in obj.values():  # handles {"not":{...}}, {"and":[...]}, {"or":[...]} etc.
            found = _extract_abs_before(v)
            if found is not None:
                return found
    elif isinstance(obj, list):
        for item in obj:
            found = _extract_abs_before(item)
            if found is not None:
                return found
    return None

def _to_unix(ts_val) -> int | None:
    """Convert abs_before value (epoch number or ISO8601 string) to unix seconds."""
    if ts_val is None:
        return None
    if isinstance(ts_val, (int, float)):
        return int(ts_val)
    s = str(ts_val).strip()
    if s.isdigit():  # numeric string epoch
        return int(s)
    # ISO8601 formats like 'YYYY-MM-DDTHH:MM:SSZ' or with '+00:00'
    try:
        if s.endswith("Z"):
            dt = datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        else:
            dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
        return int(dt.timestamp())
    except Exception:
        return None

def _compute_unlock_unix_from_predicate(pred_obj) -> int | None:
    """
    Robustly extract unlock time from Horizon claim predicate JSON.
    Supports:
      {"not":{"abs_before":"1738444680"}}
      {"not":{"and":[{"abs_before":"2025-11-29T01:29:36Z"}]}}
      {"not":{"abs_before":"2025-11-29T01:29:36Z"}}
    """
    try:
        root = pred_obj.get("not") if isinstance(pred_obj, dict) else None
        val = _extract_abs_before(root if root is not None else pred_obj)
        return _to_unix(val)
    except Exception as e:
        log.warning(f"unlock parse failed: {e}")
        return None

def _sanitize_amount(j) -> Decimal:
    raw = str(j.get("amount", "0"))
    safe = raw.replace(",", "").replace(" ", "")
    return Decimal(safe)

# --------------------- vote-round helpers: decreasing max days ------------

def _start_of_today_utc() -> int:
    now = int(time.time())
    return (now // 86400) * 86400

def _vote_round_end_unix() -> int:
    """
    If VOTE_ROUND_END is provided, use it.
    Otherwise, end = start_of_today_utc + VOTE_ROUND_LENGTH_DAYS * 86400.
    """
    env_end = _to_unix(VOTE_ROUND_END_ENV) if VOTE_ROUND_END_ENV else None
    if env_end:
        return env_end
    return _start_of_today_utc() + VOTE_ROUND_LENGTH_DAYS * 86400

def _vote_days_remaining(now_ts: int | None = None) -> int:
    """
    Ceiling days remaining until round end, minimum 1.
    """
    now_ts = int(now_ts or time.time())
    end = _vote_round_end_unix()
    secs = max(0, end - now_ts)
    days = (secs + 86400 - 1) // 86400  # ceil
    return max(1, int(days))

def _vote_boost_multiplier(days_remaining: int) -> Decimal:
    """
    Linear early bonus: 1.0 .. 1.0+EARLY_BONUS_MAX depending on remaining days.
    """
    try:
        dr = Decimal(int(days_remaining))
        mult = Decimal("1.0") + (dr / Decimal(VOTE_ROUND_LENGTH_DAYS)) * EARLY_BONUS_MAX
        return mult.quantize(Decimal("0.0001"), rounding=ROUND_DOWN)
    except Exception:
        return Decimal("1.0")

def _vote_weight_for(amount: Decimal, days_remaining: int) -> Decimal:
    return (amount * _vote_boost_multiplier(days_remaining)).quantize(
        Decimal("0.0000001"), rounding=ROUND_DOWN
    )

# ----------------------------- public rules ------------------------------

@bp_stake.route("/api/stake/rules", methods=["GET"])
def rules():
    return jsonify({
        "ok": True,
        "asset_code": ASSET_CODE,
        "issuer": ISSUER_PUB,
        "max_days": 180,
        "min_days": 1
    })

@bp_stake.route("/api/vote/rules", methods=["GET"])
def vote_rules():
    end_unix = _vote_round_end_unix()
    return jsonify({
        "ok": True,
        "round_end_unix": end_unix,
        "days_remaining": _vote_days_remaining(),
        "length_days": VOTE_ROUND_LENGTH_DAYS,
        "early_bonus_max": str((EARLY_BONUS_MAX * Decimal(100)).quantize(Decimal("0.01"))),  # percent
        "note": "Vote stakes unlock at round end. Early stakes get higher weight."
    })

# ----------------------------- preview/build stake -----------------------

@bp_stake.route("/api/stake/preview", methods=["POST"])
def preview():
    j = request.get_json(force=True) or {}
    try:
        amt  = _sanitize_amount(j)
        days = _clamp_days(int(j.get("lock_days", 0)))
    except (InvalidOperation, ValueError, TypeError):
        abort(400, "bad params: amount")
    if amt <= 0:
        abort(400, "bad params: amount <= 0")

    apr = _apr_for_lock(days)
    reward = _reward_for(amt, days)
    if reward <= 0:
        abort(400, "amount too small; reward rounds to 0")

    unlock_unix = int(time.time()) + days * 86400
    return jsonify({"ok": True, "apr": str(apr), "reward": _q7(reward), "unlock_unix": unlock_unix, "days": days})

@bp_stake.route("/api/stake/build", methods=["POST"])
def build_stake_tx():
    """
    Regular APR staking: principal + reward claimables in one tx.
    """
    j = request.get_json(force=True) or {}
    user_pub = _clean(j.get("pub") or "")
    try:
        amt  = _sanitize_amount(j)
        days = _clamp_days(int(j.get("lock_days", 0)))
    except (InvalidOperation, ValueError, TypeError):
        abort(400, "bad params: amount/lock_days")

    if not (user_pub and user_pub.startswith("G")) or amt <= 0:
        abort(400, "bad params: pub/amount")

    reward = _reward_for(amt, days)
    if reward <= 0:
        abort(400, "amount too small; reward rounds to 0")

    # Preflight
    try:
        if not _has_trust_and_bal(user_pub, amt):
            abort(400, "user lacks IZZA balance or trustline for principal")
        if not _has_trust_and_bal(DISTR_PUB, reward):
            abort(500, "distributor lacks IZZA balance for reward")
    except sx.NotFoundError:
        abort(400, "user account not found on network")

    unlock_unix = int(time.time()) + days * 86400
    pred = ClaimPredicate.predicate_not(ClaimPredicate.predicate_before_absolute_time(unlock_unix))
    claimant = Claimant(destination=user_pub, predicate=pred)

    try:
        user_acct = server.load_account(user_pub)
    except sx.NotFoundError:
        abort(400, "user account not found on network")
    except Exception as e:
        abort(500, f"horizon error: {e}")

    txb = TransactionBuilder(
        source_account=user_acct,
        network_passphrase=NET_PASSPHRASE,
        base_fee=server.fetch_base_fee()
    )

    # 1) principal from user
    txb.append_create_claimable_balance_op(
        asset=_izza_asset(), amount=_q7(amt), claimants=[claimant], source=user_pub
    )
    # 2) reward from distributor
    txb.append_create_claimable_balance_op(
        asset=_izza_asset(), amount=_q7(reward), claimants=[claimant], source=DISTR_PUB
    )

    memo_txt = f"stake:{days}d"
    if len(memo_txt.encode("utf-8")) > 28:
        memo_txt = "stake"

    tx = txb.set_timeout(180).add_text_memo(memo_txt).build()

    try:
        tx.sign(Keypair.from_secret(DISTR_SECRET))
    except Exception:
        abort(500, "bad DISTR_SECRET")

    return jsonify({
        "ok": True,
        "xdr": tx.to_xdr(),
        "network_passphrase": NET_PASSPHRASE,
        "unlock_unix": unlock_unix,
        "reward": _q7(reward),
        "days": days
    })

# ----------------------------- vote staking ------------------------------

@bp_stake.route("/api/vote/stake", methods=["POST"])
def build_vote_stake_tx():
    """
    Vote stakes: fixed unlock at round end, no reward claimable now.
    Early stakes get a higher WEIGHT used for future ad-revenue share if this proposal wins.
    """
    j = request.get_json(force=True) or {}
    try:
        log.info("VOTE_STAKE_IN %s", {k: j.get(k) for k in ("pub", "amount", "proposal")})
    except Exception:
        pass

    user_pub = _clean(j.get("pub") or "")
    proposal = _clean(j.get("proposal") or "") or "arcade"
    try:
        amt = _sanitize_amount(j)
    except (InvalidOperation, ValueError, TypeError):
        abort(400, "bad amount")

    if not (user_pub and user_pub.startswith("G")):
        abort(400, "bad params: pub")
    if amt <= 0:
        abort(400, "bad params: amount <= 0")

    # Round end + early boost
    unlock_unix = _vote_round_end_unix()
    days_remaining = _vote_days_remaining()
    if days_remaining < 1:
        abort(400, "vote round ended")

    # Preflight: user has IZZA principal available
    try:
        if not _has_trust_and_bal(user_pub, amt):
            abort(400, "user lacks IZZA balance or trustline")
    except sx.NotFoundError:
        abort(400, "user account not found on network")

    pred = ClaimPredicate.predicate_not(
        ClaimPredicate.predicate_before_absolute_time(unlock_unix)
    )
    claimant = Claimant(destination=user_pub, predicate=pred)

    try:
        user_acct = server.load_account(user_pub)
    except sx.NotFoundError:
        abort(400, "user account not found on network")
    except Exception as e:
        abort(500, f"horizon error: {e}")

    txb = TransactionBuilder(
        source_account=user_acct,
        network_passphrase=NET_PASSPHRASE,
        base_fee=server.fetch_base_fee()
    )

    # principal votes — reward is NOT created now
    txb.append_create_claimable_balance_op(
        asset=_izza_asset(), amount=_q7(amt), claimants=[claimant], source=user_pub
    )

    memo_txt = f"vote:{proposal}"
    if len(memo_txt.encode("utf-8")) > 28:
        memo_txt = "vote"

    # Build the transaction
    tx = txb.set_timeout(180).add_text_memo(memo_txt).build()

    # persist this vote (amount + computed weight) for pool math
    try:
        weight = _vote_weight_for(amt, days_remaining)
        _vote_add(unlock_unix, proposal, user_pub, _q7(amt), _q7(weight))
    except Exception as e:
        log.warning("vote intent log failed: %s", e)

    return jsonify({
        "ok": True,
        "xdr": tx.to_xdr(),
        "network_passphrase": NET_PASSPHRASE,
        "unlock_unix": unlock_unix,
        "days": int(days_remaining),
        "proposal": proposal,
        "boost_multiplier": str(_vote_boost_multiplier(days_remaining)),
        "weight_amount": _q7(_vote_weight_for(amt, days_remaining)),
        "note": "Vote stake locks principal until the vote round end. Weight includes early bonus."
    })

# ----------------------------- classify/list claimables -------------------

def _classify_record(r: dict):
    """Normalize for UI grouping."""
    # role/principal vs reward is based on sponsor
    role = "reward" if (r.get("sponsor") == DISTR_PUB) else "principal"
    unlock_unix = None
    try:
        cl = (r.get("claimants") or [])[0]
        unlock_unix = _compute_unlock_unix_from_predicate(cl.get("predicate") or {})
    except Exception:
        pass

    return {
        "id": r.get("id"),
        "amount": r.get("amount"),
        "sponsor": r.get("sponsor"),
        "role": role,                          # "principal" | "reward"
        "last_modified_time": r.get("last_modified_time"),
        "unlock_ts": unlock_unix or 0,         # unix seconds
    }

@bp_stake.route("/api/vote/preview", methods=["POST"])
def vote_preview():
    j = request.get_json(force=True) or {}
    proposal = _clean(j.get("proposal") or "")
    amt = _sanitize_amount(j)
    if not proposal or amt <= 0:
        abort(400, "bad params")

    end_unix = _vote_round_end_unix()
    days_rem = _vote_days_remaining()

    # Pool math is in WEIGHTS, not raw amounts
    your_weight = _vote_weight_for(amt, days_rem)
    pool_before_w = _vote_total_weight(end_unix, proposal)
    pool_after_w  = pool_before_w + your_weight
    share_pct     = (your_weight / pool_after_w * Decimal(100)) if pool_after_w > 0 else Decimal(100)

    return jsonify({
        "ok": True,
        "round_end_unix": int(end_unix),
        "days_remaining": days_rem,
        "boost_multiplier": str(_vote_boost_multiplier(days_rem)),
        "your_weight": _q7(your_weight),
        "pool_weight_before": str(pool_before_w),
        "pool_weight_after":  str(pool_after_w),
        "your_share_pct_if_wins": str(share_pct.quantize(Decimal("0.01"))),
        "ad_pool_pct": str((AD_REVENUE_POOL_PCT * Decimal(100)).quantize(Decimal("0.01")))
    })

@bp_stake.route("/api/stake/claimables", methods=["GET"])
def list_claimables():
    """
    List claimable balances for this asset and claimant.
    Returns: {"ok": True, "claimables": [...], "records": [...back-compat...]}
    Each item also includes:
      - role: "principal"|"reward"
      - kind: "regular"|"vote"
      - unlock_ts (unix seconds)
      - contract_id: "<unlock_ts>|<kind>|<idprefix>"
    """
    pub = _clean(request.args.get("pub", ""))
    if not (pub and pub.startswith("G")):
        abort(400, "bad pub")

    asset_param = f"{ASSET_CODE}:{ISSUER_PUB}"
    url = f"{HORIZON_URL}/claimable_balances"
    params = {"claimant": pub, "asset": asset_param, "order": "asc", "limit": 200}
    try:
        r = requests.get(url, params=params, timeout=15)
        r.raise_for_status()
        records = (r.json().get("_embedded", {}) or {}).get("records", []) or []
    except requests.HTTPError as e:
        log.warning("claimables fetch failed: %s", e)
        return jsonify({"ok": True, "claimables": [], "records": []})
    except Exception as e:
        log.warning("claimables fetch error: %s", e)
        return jsonify({"ok": True, "claimables": [], "records": []})

    norm = [_classify_record(rec) for rec in records]

    # derive vote vs regular: if an unlock bucket has principal but no reward => vote stake
    buckets = {}
    for rec in norm:
        u = rec.get("unlock_ts") or 0
        b = buckets.setdefault(u, {"has_principal": False, "has_reward": False})
        if rec["role"] == "principal":
            b["has_principal"] = True
        else:
            b["has_reward"] = True

    out = []
    for rec in norm:
        u = rec.get("unlock_ts") or 0
        b = buckets.get(u, {})
        is_vote = bool(b.get("has_principal") and not b.get("has_reward"))
        kind = "vote" if is_vote else "regular"
        rec_out = {
            **rec,
            "kind": kind,
            "contract_id": f"{int(u)}|{kind}|{rec.get('id','')[-16:]}",
        }
        out.append(rec_out)

    return jsonify({"ok": True, "claimables": out, "records": out})

# ----------------------------- build claim(s) -----------------------------

def _infer_claimant_from_balance_id(cb_id: str) -> str | None:
    """Look up a balance and return claimant G... if present."""
    try:
        url = f"{HORIZON_URL}/claimable_balances/{cb_id}"
        r = requests.get(url, timeout=15)
        r.raise_for_status()
        rec = r.json()
        cl = (rec.get("claimants") or [])[0]
        dest = (cl.get("destination") or "").strip()
        return dest if dest.startswith("G") else None
    except Exception as e:
        log.warning("infer claimant failed for %s: %s", cb_id, e)
        return None

@bp_stake.route("/api/stake/build-claim", methods=["POST"])
def build_claim_tx():
    """Build a single ClaimClaimableBalance tx."""
    j = request.get_json(force=True) or {}
    pub   = _clean(j.get("pub") or "")
    cb_id = _clean(j.get("balance_id") or "")
    if not _valid_balance_id(cb_id):
        abort(400, "bad balance_id format")

    if not (pub and pub.startswith("G")):
        # try to infer from Horizon
        pub = _infer_claimant_from_balance_id(cb_id)
        if not pub:
            abort(400, "bad pub")

    try:
        acct = server.load_account(pub)
    except sx.NotFoundError:
        abort(400, "user account not found on network")
    except Exception as e:
        abort(500, f"horizon error: {e}")

    tx = (
        TransactionBuilder(
            source_account=acct,
            network_passphrase=NET_PASSPHRASE,
            base_fee=server.fetch_base_fee()
        )
        .append_claim_claimable_balance_op(cb_id)
        .set_timeout(180)
        .build()
    )
    return jsonify({"ok": True, "xdr": tx.to_xdr(), "network_passphrase": NET_PASSPHRASE})

@bp_stake.route("/api/stake/build-claim-batch", methods=["POST"])
def build_claim_tx_batch():
    """Build one tx to claim multiple balance IDs, skips invalid, errors if none valid."""
    j = request.get_json(force=True) or {}
    pub = _clean(j.get("pub") or "")
    ids = j.get("balance_ids") or []
    if not isinstance(ids, list) or not ids:
        abort(400, "no balance_ids provided")

    valid_ids = [s for s in ((_clean(str(x)) or "") for x in ids) if _valid_balance_id(s)]
    if not valid_ids:
        abort(400, "no valid balance_ids")

    # If pub not provided, infer from first id and ensure all ids share same claimant
    if not (pub and pub.startswith("G")):
        pub = _infer_claimant_from_balance_id(valid_ids[0])
        if not pub:
            abort(400, "bad pub")
        try:
            for cb in valid_ids[1:]:
                p2 = _infer_claimant_from_balance_id(cb)
                if p2 != pub:
                    abort(400, "mixed claimants in batch")
        except Exception:
            abort(400, "claimant check failed")

    try:
        acct = server.load_account(pub)
    except sx.NotFoundError:
        abort(400, "user account not found on network")
    except Exception as e:
        abort(500, f"horizon error: {e}")

    tb = TransactionBuilder(
        source_account=acct,
        network_passphrase=NET_PASSPHRASE,
        base_fee=server.fetch_base_fee()
    )
    for cb_id in valid_ids:
        tb.append_claim_claimable_balance_op(cb_id)

    tx = tb.set_timeout(180).build()
    return jsonify({"ok": True, "xdr": tx.to_xdr(), "network_passphrase": NET_PASSPHRASE})

# ---- UI-friendly alias for batch claim

@bp_stake.route("/api/stake/claim", methods=["POST"])
def claim_batch_ui_alias():
    """
    UI alias for batch claim.
    Body: { ids: [...], pub?: "G..." }
    Returns XDR + network_passphrase.
    """
    j = request.get_json(force=True) or {}
    ids = j.get("ids") or j.get("balance_ids") or []
    pub = _clean(j.get("pub") or "")
    # Reuse the batch builder logic
    return build_claim_tx_batch.__wrapped__({  # type: ignore
        "get_json": lambda *_, **__: {"balance_ids": ids, "pub": pub}
    })

# ----------------------------- arcade proposals ---------------------------

@bp_stake.route("/api/arcade/proposals", methods=["GET"])
def arcade_proposals():
    """Static list of current arcade game proposals users can stake/vote on."""
    proposals = [
        {
            "id": "rooftop_rumble",
            "title": "Rooftop Rumble",
            "desc": "Leap across skyscrapers, dodge drones, and collect IZZA Coins in this high-speed rooftop race. Each vote powers its development.",
            "img": "/static/assets/arcade_rooftop_rumble.jpg"
        },
        {
            "id": "pizza_panic",
            "title": "Pizza Panic",
            "desc": "Dash through IZZA City traffic delivering hot pizzas before time runs out. Each stake vote funds new vehicles, upgrades, and levels.",
            "img": "/static/assets/arcade_pizza_panic.jpg"
        }
    ]
    return jsonify({"ok": True, "proposals": proposals})
