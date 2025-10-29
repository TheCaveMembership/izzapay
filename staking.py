# staking.py
import os, time, math
from decimal import Decimal
from flask import Blueprint, request, jsonify, abort
from stellar_sdk import (
    Server, Network, Keypair, Asset, TransactionBuilder,
    Claimant, ClaimPredicate
)

bp_stake = Blueprint("stake", __name__)

HORIZON_URL   = os.getenv("HORIZON_URL", "https://api.testnet.minepi.com")
NET_PASSPHRASE= os.getenv("NETWORK_PASSPHRASE", "Pi Testnet")

ASSET_CODE    = os.getenv("ASSET_CODE", "IZZA")
ISSUER_PUB    = os.getenv("ISSUER_PUB")   # GDKS3KFA...
DISTR_PUB     = os.getenv("DISTR_PUB")    # GAIXMJ22...
DISTR_SECRET  = os.getenv("DISTR_SECRET") # S...
IZZA          = Asset(ASSET_CODE, ISSUER_PUB)

server = Server(HORIZON_URL)

def _apr_for_lock(days:int)->Decimal:
    # tune this curve as you like
    # e.g. 30d=5% APR, 90d=10%, 180d=15%:
    base = Decimal("0.05")
    bonus = Decimal(days)/Decimal(180) * Decimal("0.10")
    return (base + bonus).quantize(Decimal("0.0001"))

@bp_stake.route("/api/stake/preview", methods=["POST"])
def preview():
    j = request.get_json(force=True)
    amt  = Decimal(str(j.get("amount", "0")))
    days = int(j.get("lock_days", 0))
    if amt <= 0 or days <= 0: abort(400)
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
    Server pre-signs with distributor so the user just adds their signature and submits.
    """
    j = request.get_json(force=True)
    user_pub = (j.get("pub") or "").strip()
    amt      = Decimal(str(j.get("amount", "0")))
    days     = int(j.get("lock_days", 0))
    if not user_pub.startswith("G") or amt <= 0 or days <= 0:
        abort(400, "bad params")

    # compute reward + predicate
    apr = _apr_for_lock(days)
    reward = (amt * apr * Decimal(days)/Decimal(365)).quantize(Decimal("0.0000001"))
    unlock_unix = int(time.time()) + days*86400

    pred = ClaimPredicate.predicate_not(
              ClaimPredicate.predicate_before_absolute_time(unlock_unix)
           )
    claimant = Claimant(destination=user_pub, predicate=pred)

    # load both accounts (sequence comes from the tx source: the USER)
    user_acct = server.load_account(user_pub)

    txb = TransactionBuilder(
        source_account=user_acct,
        network_passphrase=NET_PASSPHRASE,
        base_fee=server.fetch_base_fee()
    )

    # 1) lock user's tokens
    txb.append_create_claimable_balance_op(
        asset=IZZA, amount=str(amt), claimants=[claimant], source=user_pub
    )

    # 2) create reward (paid by distributor) with same predicate
    txb.append_create_claimable_balance_op(
        asset=IZZA, amount=str(reward), claimants=[claimant], source=DISTR_PUB
    )

    tx = txb.set_timeout(180).add_memo_text(f"stake:{days}d").build()

    # Pre-sign with distributor (required because op#2 has source=DISTR_PUB)
    tx.sign(Keypair.from_secret(DISTR_SECRET))

    # Return the XDR for the client to add the USER signature and submit
    return jsonify({
        "ok": True,
        "xdr": tx.to_xdr(),
        "network_passphrase": NET_PASSPHRASE,
        "unlock_unix": unlock_unix,
        "reward": str(reward)
    })

@bp_stake.route("/api/stake/claimables", methods=["GET"])
def list_claimables():
    """List claimable balances the user can claim (both principal and reward)."""
    pub = request.args.get("pub","").strip()
    if not pub.startswith("G"): abort(400)
    # Horizon filter: ?claimant=G...&asset=CODE:ISSUER
    url = f"{HORIZON_URL}/claimable_balances?claimant={pub}&asset={ASSET_CODE}:{ISSUER_PUB}&order=asc&limit=200"
    data = server._session.get(url).json()  # small helper; ok for testnet
    records = data.get("_embedded", {}).get("records", [])
    out = []
    for r in records:
        # both balances will share the same predicate; no memo on CB itself
        # distinguish by 'sponsor' (often equals source that created it)
        out.append({
            "id": r.get("id"),
            "amount": r.get("amount"),
            "sponsor": r.get("sponsor"),
            "claimants": r.get("claimants"),
            "last_modified_time": r.get("last_modified_time")
        })
    return jsonify({"ok": True, "records": out})

@bp_stake.route("/api/stake/build-claim", methods=["POST"])
def build_claim_tx():
    """Build a simple ClaimClaimableBalance tx the USER signs and submits."""
    j = request.get_json(force=True)
    pub = (j.get("pub") or "").strip()
    cb_id = (j.get("balance_id") or "").strip()
    if not pub.startswith("G") or not cb_id: abort(400)
    acct = server.load_account(pub)
    tx = TransactionBuilder(acct, server.fetch_base_fee(), network_passphrase=NET_PASSPHRASE) \
            .append_claim_claimable_balance_op(cb_id) \
            .set_timeout(180).build()
    return jsonify({"ok": True, "xdr": tx.to_xdr(), "network_passphrase": NET_PASSPHRASE})
