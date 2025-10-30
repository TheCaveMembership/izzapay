# staking.py
import os, re, time, logging
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
    if s is None:
        return None
    return s.strip().replace("\n", "").replace("\r", "")

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

# Validate keys early
_env_problems = []
if not StrKey.is_valid_ed25519_public_key(ISSUER_PUB or ""):
    _env_problems.append("ISSUER_PUB invalid")
if not StrKey.is_valid_ed25519_public_key(DISTR_PUB or ""):
    _env_problems.append("DISTR_PUB invalid")
try:
    Keypair.from_secret(DISTR_SECRET or "")
except Exception:
    _env_problems.append("DISTR_SECRET invalid")
if _env_problems:
    raise RuntimeError("staking env invalid: " + ", ".join(_env_problems))

server = Server(HORIZON_URL)

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

def _compute_unlock_unix_from_predicate(pred_obj) -> int | None:
    try:
        not_obj = pred_obj.get("not") or {}
        abs_before = not_obj.get("abs_before")
        return int(abs_before) if abs_before is not None else None
    except Exception:
        return None

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

# ----------------------------- preview/build stake -----------------------

@bp_stake.route("/api/stake/preview", methods=["POST"])
def preview():
    j = request.get_json(force=True) or {}
    try:
        amt  = Decimal(str(j.get("amount", "0")))
        days = _clamp_days(int(j.get("lock_days", 0)))
    except (InvalidOperation, ValueError, TypeError):
        abort(400, "bad params")

    if amt <= 0:
        abort(400, "bad params")

    apr = _apr_for_lock(days)
    reward = _reward_for(amt, days)
    if reward <= 0:
        abort(400, "amount too small; reward rounds to 0")

    unlock_unix = int(time.time()) + days * 86400
    return jsonify({"ok": True, "apr": str(apr), "reward": _q7(reward), "unlock_unix": unlock_unix, "days": days})

@bp_stake.route("/api/stake/build", methods=["POST"])
def build_stake_tx():
    """
    ONE tx, TWO ops:
      1) user's IZZA -> claimable balance (principal)
      2) distributor's IZZA -> claimable balance (reward)
    Server pre-signs with distributor so the user adds their signature and submits.
    """
    j = request.get_json(force=True) or {}
    user_pub = _clean(j.get("pub") or "")
    try:
        amt  = Decimal(str(j.get("amount", "0")))
        days = _clamp_days(int(j.get("lock_days", 0)))
    except (InvalidOperation, ValueError, TypeError):
        abort(400, "bad params")

    if not (user_pub and user_pub.startswith("G")) or amt <= 0:
        abort(400, "bad params")

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
# CHANGED: vote stakes DO NOT mint an IZZA reward now; they only lock principal for 180d.

@bp_stake.route("/api/vote/stake", methods=["POST"])
def build_vote_stake_tx():
    """
    Stake tokens as votes for a proposal.
    Uses fixed 180d lock so all vote rounds align, and tags memo with 'vote:<proposal>'.
    Vote stakes DO NOT earn IZZA tokens at stake time; rewards are a future % of ad revenue
    if the voted game wins the round (set/distributed later).
    """
    j = request.get_json(force=True) or {}
    user_pub = _clean(j.get("pub") or "")
    proposal = _clean(j.get("proposal") or "")
    try:
        amt = Decimal(str(j.get("amount", "0")))
    except (InvalidOperation, ValueError, TypeError):
        abort(400, "bad amount")

    if not (user_pub and user_pub.startswith("G")) or amt <= 0:
        abort(400, "bad params")

    days = 180  # fixed for vote rounds

    # Preflight: user has IZZA principal
    try:
        if not _has_trust_and_bal(user_pub, amt):
            abort(400, "user lacks IZZA balance or trustline")
    except sx.NotFoundError:
        abort(400, "user account not found on network")

    unlock_unix = int(time.time()) + days * 86400
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

    # principal votes (user funds) — reward is NOT created now
    txb.append_create_claimable_balance_op(
        asset=_izza_asset(), amount=_q7(amt), claimants=[claimant], source=user_pub
    )

    # tag tx for later identification of vote round & proposal
    memo_txt = f"vote:{proposal or 'arcade'}"
    if len(memo_txt.encode("utf-8")) > 28:
        memo_txt = "vote"

    tx = txb.set_timeout(180).add_text_memo(memo_txt).build()

    try:
        # Optional: distributor signs too if you want a consistent signature pattern
        tx.sign(Keypair.from_secret(DISTR_SECRET))
    except Exception:
        abort(500, "bad DISTR_SECRET")

    return jsonify({
        "ok": True,
        "xdr": tx.to_xdr(),
        "network_passphrase": NET_PASSPHRASE,
        "unlock_unix": unlock_unix,
        "days": days,
        "proposal": proposal,
        # for UI: show this as “Amount / Share”; percentage is assigned later at payout
        "note": "Vote stake locks principal for 180d. Reward is a future % of ad revenue if your game wins."
    })

# ----------------------------- classify/list claimables -------------------

def _classify_record(r: dict):
    """Return kind + unlock + claimable_now for UI."""
    kind = "reward" if (r.get("sponsor") == DISTR_PUB) else "principal"
    unlock_unix = None
    claimable_now = None
    try:
        cl = (r.get("claimants") or [])[0]
        unlock_unix = _compute_unlock_unix_from_predicate(cl.get("predicate") or {})
        if unlock_unix is not None:
            claimable_now = int(time.time()) >= int(unlock_unix)
    except Exception:
        pass

    return {
        "id": r.get("id"),
        "amount": r.get("amount"),
        "sponsor": r.get("sponsor"),
        "kind": kind,
        "claimants": r.get("claimants"),
        "last_modified_time": r.get("last_modified_time"),
        "unlock_unix": unlock_unix,
        "claimable_now": claimable_now
    }

@bp_stake.route("/api/stake/claimables", methods=["GET"])
def list_claimables():
    """List claimable balances (principal and reward). Returns empty list on Horizon 400s.
       Adds derived flag 'is_vote' so UI can display vote stakes as % of future revenue."""
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
        return jsonify({"ok": True, "records": []})
    except Exception as e:
        log.warning("claimables fetch error: %s", e)
        return jsonify({"ok": True, "records": []})

    out = [_classify_record(rec) for rec in records]

    # ---- Derive vote vs regular groupings (no DB required) ----
    # We group by unlock_unix and look for a distributor-funded reward sibling.
    # If a group has ONLY a principal (no DISTR_PUB reward), we flag it as vote-like.
    groups = {}
    for rec in out:
        u = rec.get("unlock_unix")
        if u is None:
            continue
        g = groups.setdefault(u, {"has_principal": False, "has_reward": False})
        if rec.get("kind") == "principal":
            g["has_principal"] = True
        elif rec.get("kind") == "reward":
            g["has_reward"] = True

    # annotate each record with is_vote for UI (gold styling, % share display)
    for rec in out:
        u = rec.get("unlock_unix")
        g = groups.get(u) or {}
        # Vote stake ≈ principal-only group (no distributor reward minted at stake time)
        rec["is_vote"] = bool(g.get("has_principal") and not g.get("has_reward"))

    return jsonify({"ok": True, "records": out})

# ----------------------------- build claim(s) -----------------------------

@bp_stake.route("/api/stake/build-claim", methods=["POST"])
def build_claim_tx():
    """Build a single ClaimClaimableBalance tx."""
    j = request.get_json(force=True) or {}
    pub   = _clean(j.get("pub") or "")
    cb_id = _clean(j.get("balance_id") or "")
    if not (pub and pub.startswith("G")):
        abort(400, "bad pub")
    if not _valid_balance_id(cb_id):
        abort(400, "bad balance_id format")

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
    """Build one tx to claim multiple balance IDs; skips invalid; errors if none valid."""
    j = request.get_json(force=True) or {}
    pub = _clean(j.get("pub") or "")
    ids = j.get("balance_ids") or []
    if not (pub and pub.startswith("G")):
        abort(400, "bad pub")
    if not isinstance(ids, list) or not ids:
        abort(400, "no balance_ids provided")

    valid_ids = [s for s in ((_clean(str(x)) or "") for x in ids) if _valid_balance_id(s)]
    if not valid_ids:
        abort(400, "no valid balance_ids")

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
