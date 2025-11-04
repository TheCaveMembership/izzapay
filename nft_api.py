# nft_api.py
import os, json, re, math, requests
from decimal import Decimal, ROUND_DOWN
from flask import Blueprint, request, jsonify, abort
from stellar_sdk import (
    Server, Keypair, Asset, TransactionBuilder, exceptions as sx
)

bp_nft = Blueprint("nft_api", __name__)

# ---------- env ----------
HORIZON_URL = os.getenv("NFT_HORIZON_URL", "https://api.testnet.minepi.com").strip()
PASSPHRASE = os.getenv("NFT_NETWORK_PASSPHRASE", "auto").strip()

ISSUER_S = os.getenv("NFT_ISSUER_SECRET", "").strip()
ISSUER_G = os.getenv("NFT_ISSUER_PUBLIC", "").strip()
DISTR_S  = os.getenv("NFT_DISTR_SECRET", "").strip()
DISTR_G  = os.getenv("NFT_DISTR_PUBLIC", "").strip()

HOME_DOMAIN = os.getenv("NFT_HOME_DOMAIN", "").strip()

IZZA_CODE = os.getenv("IZZA_TOKEN_CODE", "IZZA").strip()
IZZA_ISS  = os.getenv("IZZA_TOKEN_ISSUER", "").strip()

if not (ISSUER_S and ISSUER_G and DISTR_S and DISTR_G):
    raise RuntimeError("Missing NFT issuer/distributor env vars")
if not IZZA_ISS:
    raise RuntimeError("Missing IZZA_TOKEN_ISSUER env var")

def _network_passphrase():
    if PASSPHRASE.lower() != "auto":
        return PASSPHRASE
    # detect from Horizon root (safe defaulting)
    try:
        r = requests.get(HORIZON_URL, timeout=6)
        r.raise_for_status()
        j = r.json()
        return j.get("network_passphrase") or "Test SDF Network ; September 2015"
    except Exception:
        return "Test SDF Network ; September 2015"

PP = _network_passphrase()
server = Server(HORIZON_URL)

# ---------- pricing ----------
PRICE_SINGLE = Decimal("0.1")   # 0.1 IZZA testnet token per single NFT
# Simple bulk tiers: size >= threshold → per-unit
TIERS = [
    (1,   Decimal("0.1000")),
    (10,  Decimal("0.0950")),
    (25,  Decimal("0.0900")),
    (50,  Decimal("0.0850")),
    (100, Decimal("0.0800")),
]
def per_unit(n:int)->Decimal:
    p = TIERS[0][1]
    for m, price in TIERS:
        if n >= m: p = price
    return p

# ---------- helpers ----------
def _dec(n): return Decimal(str(n))
def _load(g): return server.load_account(g)

def _mint_code(prefix="NFT", suffix=""):
    base = f"{prefix}{suffix}".upper()
    return re.sub(r"[^A-Z0-9]", "", base)[:12] or "NFTX"

def _change_trust(secret: str, asset: Asset, limit="1"):
    kp = Keypair.from_secret(secret)
    acc = _load(kp.public_key)
    tx = (TransactionBuilder(acc, PP, base_fee=100)
          .append_change_trust_op(asset, limit=limit)
          .set_timeout(180).build())
    tx.sign(kp)
    try:
        return server.submit_transaction(tx)
    except sx.BadResponseError as e:
        # Already trusted or benign – we just proceed
        if "op_low_reserve" in str(e).lower():
            raise
        return {"ok": True}

def _pay_asset(secret_from: str, to_g: str, amount: str, asset: Asset, memo=None):
    kp = Keypair.from_secret(secret_from)
    acc = _load(kp.public_key)
    tb = TransactionBuilder(acc, PP, base_fee=100).append_payment_op(
        destination=to_g, amount=str(amount), asset=asset
    )
    if memo:
        tb = tb.add_text_memo(memo[:28])
    tx = tb.set_timeout(180).build()
    tx.sign(kp)
    return server.submit_transaction(tx)

def _require(b, msg="bad_request"):
    if not b: abort(400, msg)

# ---------- API ----------
@bp_nft.route("/api/nft/quote", methods=["POST"])
def quote():
    j = request.get_json(silent=True) or {}
    kind = (j.get("kind") or "single").strip()
    size = 1 if kind == "single" else max(1, int(j.get("size") or 1))
    unit = PRICE_SINGLE if kind == "single" else per_unit(size)
    total = (unit * size).quantize(Decimal("0.000001"), rounding=ROUND_DOWN)
    return jsonify({"ok": True, "kind": kind, "size": size, "per_unit": str(unit), "total": str(total)})

@bp_nft.route("/api/nft/mint", methods=["POST"])
def mint():
    """
    Creator flow:
    body {
      "creator_pub": "G...",        // creator wallet G (display)
      "creator_sec": "S...",        // creator S (saved locally in wallet + sent here only if you trust server)
      "kind": "single"|"collection",
      "size": 1|10|25...,           // collection size if kind=collection
      "prefix": "NFT",              // optional asset code prefix
      "collection_tag": "ABC"       // optional suffix/stable tag for a set
    }
    Steps:
     1) charge fee in IZZA (creator -> distributor)
     2) for each unit, create new asset code and issue 1 unit to distributor
     3) return list of asset codes to store with the listing
    """
    j = request.get_json(silent=True) or {}
    creator_pub = (j.get("creator_pub") or "").strip()
    creator_sec = (j.get("creator_sec") or "").strip()
    kind = (j.get("kind") or "single").strip()
    size = 1 if kind == "single" else max(1, int(j.get("size") or 1))
    prefix = (j.get("prefix") or "NFT").strip()
    tag = (j.get("collection_tag") or "").strip()

    _require(creator_pub and creator_sec, "creator_wallet_required")

    unit = PRICE_SINGLE if kind == "single" else per_unit(size)
    total = (unit * size).quantize(Decimal("0.000001"), rounding=ROUND_DOWN)

    izza = Asset(IZZA_CODE, IZZA_ISS)

    # 1) fee charge: creator -> distributor in IZZA
    try:
        _pay_asset(creator_sec, DISTR_G, str(total), izza, memo="IZZA NFT FEE")
    except Exception as e:
        abort(400, f"fee_payment_failed: {e}")

    # 2) mint NFT assets to distributor (1 unit each)
    iss_kp = Keypair.from_secret(ISSUER_S)
    minted = []
    for i in range(size):
        code = _mint_code(prefix, f"{tag}{i+1:03d}" if kind == "collection" else f"{tag}")
        asset = Asset(code, iss_kp.public_key)
        # distributor trustline
        _change_trust(DISTR_S, asset, limit="1")
        # issue 1 unit to distributor
        iss_acc = _load(iss_kp.public_key)
        tx = (TransactionBuilder(iss_acc, PP, base_fee=100)
              .append_payment_op(DISTR_G, "1", asset)
              .set_timeout(180).build())
        tx.sign(iss_kp)
        try:
            server.submit_transaction(tx)
        except Exception as e:
            abort(400, f"mint_issue_failed: {code}: {e}")
        minted.append(code)

    return jsonify({"ok": True, "assets": minted, "size": size, "total_fee": str(total)})

@bp_nft.route("/api/nft/claim", methods=["POST"])
def claim():
    """
    Buyer fulfillment after store purchase:
    body {
      "buyer_pub": "G...",
      "assets": ["NFTABC001","NFTABC002", ...],
      "issuer": "G..."   // optional, defaults to NFT_ISSUER_PUBLIC
    }
    """
    j = request.get_json(silent=True) or {}
    buyer = (j.get("buyer_pub") or "").strip()
    assets = list(j.get("assets") or [])
    issuer_g = (j.get("issuer") or ISSUER_G).strip()
    _require(buyer and assets, "buyer_and_assets_required")

    for code in assets:
        asset = Asset(code, issuer_g)
        # ensure buyer trustline (via distributor op)
        _change_trust(DISTR_S, asset, limit="1")  # distributor trusts already, but harmless
        # send to buyer
        # buyer must also trust the asset; we let Horizon auto fail if not.
        try:
            _pay_asset(DISTR_S, buyer, "1", asset, memo="IZZA NFT")
        except Exception as e:
            abort(400, f"deliver_failed: {code}: {e}")

    return jsonify({"ok": True, "delivered": len(assets)})
