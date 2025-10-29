# staking.py
import os, time
from decimal import Decimal
from flask import Blueprint, request, jsonify, abort
import requests
from stellar_sdk import (
    Server, Network, Keypair, Asset, TransactionBuilder,
    Claimant, ClaimPredicate, exceptions as sx
)

bp_stake = Blueprint("stake", __name__)

HORIZON_URL    = os.getenv("HORIZON_URL", "https://api.testnet.minepi.com")
NET_PASSPHRASE = os.getenv("NETWORK_PASSPHRASE", "Pi Testnet")

ASSET_CODE   = os.getenv("ASSET_CODE", "IZZA")
ISSUER_PUB   = os.getenv("ISSUER_PUB")    # G...
DISTR_PUB    = os.getenv("DISTR_PUB")     # G...
DISTR_SECRET = os.getenv("DISTR_SECRET")  # S...

server = Server(HORIZON_URL)

def _require_env():
    missing = [k for k,v in {
        "ISSUER_PUB": ISSUER_PUB,
        "DISTR_PUB": DISTR_PUB,
        "DISTR_SECRET": DISTR_SECRET
    }.items() if not v]
    if missing:
        abort(500, f"staking env missing: {', '.join(missing)}")

def _izza_asset() -> Asset:
    if not ISSUER_PUB:
        abort(500, "ISSUER_PUB not configured")
    return Asset(ASSET_CODE, ISSUER_PUB)

def _apr_for_lock(days:int)->Decimal:
    # 30d ≈ 5% APR, 180d ≈ 15% APR (linear bonus)
    base = Decimal("0.05")
    bonus = Decimal(days)/Decimal(180) * Decimal("0.10")
    return (base + bonus).quantize(Decimal("0.0001"))

@bp_stake.route("/api/stake/preview", methods=["POST"])
def preview():
    j = request.get_json(force=True) or {}
    try:
        amt  = Decimal(str(j.get("amount", "0")))
        days = int(j.get("lock_days", 0))
    except Exception:
        abort(400, "bad params")
    if amt <= 0 or days <= 0: abort(400, "bad params")
    apr = _apr_for_lock(days)
    reward = (amt * apr * Decimal(days)/Decimal(365)).quantize(Decimal("0.0000001"))
    unlock_unix = int(time.time()) + days*86400
    return jsonify({"ok": True, "apr": str(apr), "reward": str(reward), "unlock_unix": unlock_unix})

@bp_stake.route("/api/stake/build", methods=["POST"])
def build_stake_tx():
    """
    Builds ONE tx with TWO ops:
      1) user's IZZA -> claimable balance (source = user)
      2) distributor's IZZA reward -> claimable balance (source = DISTR_PUB)
    Server pre-signs with distributor so the user adds their signature and submits.
    """
    _require_env()
    j = request.get_json(force=True) or {}
    user_pub = (j.get("pub") or "").strip()
    try:
        amt  = Decimal(str(j.get("amount", "0")))
        days = int(j.get("lock_days", 0))
    except Exception:
        abort(400, "bad params")

    if not user_pub.startswith("G") or amt <= 0 or days <= 0:
        abort(400, "bad params")

    apr = _apr_for_lock(days)
    reward = (amt * apr * Decimal(days)/Decimal(365)).quantize(Decimal("0.0000001"))
    unlock_unix = int(time.time()) + days*86400

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

    # 1) lock user's tokens (principal)
    txb.append_create_claimable_balance_op(
        asset=_izza_asset(), amount=str(amt), claimants=[claimant], source=user_pub
    )

    # 2) reward paid by distributor (same predicate)
    txb.append_create_claimable_balance_op(
        asset=_izza_asset(), amount=str(reward), claimants=[claimant], source=DISTR_PUB
    )

    tx = txb.set_timeout(180).add_memo_text(f"stake:{days}d").build()

    # Pre-sign with distributor (required for op#2)
    try:
        tx.sign(Keypair.from_secret(DISTR_SECRET))
    except Exception:
        abort(500, "bad DISTR_SECRET")

    return jsonify({
        "ok": True,
        "xdr": tx.to_xdr(),
        "network_passphrase": NET_PASSPHRASE,
        "unlock_unix": unlock_unix,
        "reward": str(reward)
    })

def _classify_record(r: dict):
    """Return 'reward' if sponsor == DISTR_PUB else 'principal'."""
    kind = "reward" if (r.get("sponsor") == DISTR_PUB) else "principal"
    return {
        "id": r.get("id"),
        "amount": r.get("amount"),
        "sponsor": r.get("sponsor"),
        "kind": kind,
        "claimants": r.get("claimants"),
        "last_modified_time": r.get("last_modified_time")
    }

@bp_stake.route("/api/stake/claimables", methods=["GET"])
def list_claimables():
    """List claimable balances the user can claim (principal and reward)."""
    pub = request.args.get("pub","").strip()
    if not pub.startswith("G"): abort(400, "bad pub")
    if not ISSUER_PUB: abort(500, "ISSUER_PUB not configured")

    url = f"{HORIZON_URL}/claimable_balances"
    params = {
        "claimant": pub,
        "asset": f"{ASSET_CODE}:{ISSUER_PUB}",
        "order": "asc",
        "limit": 200
    }
    try:
        r = requests.get(url, params=params, timeout=15)
        r.raise_for_status()
        records = (r.json().get("_embedded", {}) or {}).get("records", []) or []
    except Exception as e:
        abort(502, f"horizon fetch failed: {e}")

    out = [_classify_record(rec) for rec in records]
    return jsonify({"ok": True, "records": out})

@bp_stake.route("/api/stake/build-claim", methods=["POST"])
def build_claim_tx():
    """Build a single ClaimClaimableBalance tx the USER signs and submits."""
    j = request.get_json(force=True) or {}
    pub   = (j.get("pub") or "").strip()
    cb_id = (j.get("balance_id") or "").strip()
    if not pub.startswith("G") or not cb_id:
        abort(400, "bad params")

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
    """Build one tx to claim multiple balance IDs."""
    j = request.get_json(force=True) or {}
    pub = (j.get("pub") or "").strip()
    ids = j.get("balance_ids") or []
    if not pub.startswith("G") or not isinstance(ids, list) or not ids:
        abort(400, "bad params")

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
    for cb_id in ids:
        cb = str(cb_id).strip()
        if cb:
            tb.append_claim_claimable_balance_op(cb)

    tx = tb.set_timeout(180).build()
    return jsonify({"ok": True, "xdr": tx.to_xdr(), "network_passphrase": NET_PASSPHRASE})
