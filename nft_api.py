# nft_api.py
import os, json, re, math, requests, logging
from decimal import Decimal, ROUND_DOWN
from flask import Blueprint, request, jsonify, abort
from stellar_sdk import (
    Server, Keypair, Asset, TransactionBuilder, exceptions as sx, StrKey
)

bp_nft = Blueprint("nft_api", __name__)
log = logging.getLogger(__name__)

# ---------- small log helpers (mask secrets safely) ----------
def _mask(k: str | None) -> str:
    if not k:
        return ""
    k = k.strip()
    if len(k) <= 8:
        return k[:1] + "…" if k else ""
    return f"{k[:4]}…{k[-4:]}"

def _isG(v: str | None) -> bool:
    try:
        return bool(v and StrKey.is_valid_ed25519_public_key(v.strip()))
    except Exception:
        return False

def _isS(v: str | None) -> bool:
    try:
        return bool(v and StrKey.is_valid_ed25519_secret_seed(v.strip()))
    except Exception:
        return False

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

def _log_env_summary():
    try:
        log.info("NFT_ENV_SUMMARY %s", json.dumps({
            "HORIZON_URL": HORIZON_URL,
            "PASSPHRASE_mode": "auto" if PASSPHRASE.lower() == "auto" else "explicit",
            "ISSUER_G_masked": _mask(ISSUER_G),
            "ISSUER_S_masked": _mask(ISSUER_S),
            "DISTR_G_masked":  _mask(DISTR_G),
            "DISTR_S_masked":  _mask(DISTR_S),
            "IZZA_CODE": IZZA_CODE,
            "IZZA_ISS_masked": _mask(IZZA_ISS),
            "valid": {
                "ISSUER_G_isG": _isG(ISSUER_G),
                "ISSUER_S_isS": _isS(ISSUER_S),
                "DISTR_G_isG":  _isG(DISTR_G),
                "DISTR_S_isS":  _isS(DISTR_S),
                "IZZA_ISS_isG": _isG(IZZA_ISS),
            }
        }))
    except Exception as e:
        log.warning("NFT_ENV_SUMMARY_LOG_FAIL %s: %s", type(e).__name__, e)

def _network_passphrase():
    if PASSPHRASE.lower() != "auto":
        return PASSPHRASE
    # detect from Horizon root (safe defaulting)
    try:
        r = requests.get(HORIZON_URL, timeout=6)
        r.raise_for_status()
        j = r.json()
        pp = j.get("network_passphrase") or "Test SDF Network ; September 2015"
        log.info("NFT_PP_DETECTED %s", pp)
        return pp
    except Exception as e:
        log.warning("NFT_PP_DETECT_FAIL %s: %s; fallback=SDFTestnet", type(e).__name__, e)
        return "Test SDF Network ; September 2015"

# log env once on import
_log_env_summary()

PP = _network_passphrase()
server = Server(HORIZON_URL)

# ---------- dynamic fee + balance helpers ----------
def _base_fee() -> int:
    """
    Use Horizon's suggested base fee with a cushion to avoid tx_insufficient_fee
    during surge pricing. Falls back safely if fetch fails.
    """
    try:
        bf = int(server.fetch_base_fee())  # stroops
        fee = max(100, bf * 5)            # 5x cushion
        log.debug("NFT_FEE_EST base=%s cushioned=%s", bf, fee)
        return fee
    except Exception as e:
        log.warning("NFT_FEE_FETCH_FAIL %s: %s; fallback=500", type(e).__name__, e)
        return 500

def _native_balance(g: str) -> str:
    """Return native balance (as string) for quick preflight logging."""
    try:
        acc = server.load_account(g)
        for b in acc.balances:
            if b.get("asset_type") == "native":
                return b.get("balance", "0")
    except Exception as e:
        log.debug("NFT_BAL_READ_FAIL %s: %s", type(e).__name__, e)
    return "0"

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
    tx = (TransactionBuilder(acc, PP, base_fee=_base_fee())
          .append_change_trust_op(asset, limit=limit)
          .set_timeout(180).build())
    tx.sign(kp)
    try:
        log.debug("NFT_TRUST_CHANGE start acct=%s asset=%s:%s limit=%s",
                  _mask(kp.public_key), asset.code, _mask(asset.issuer), limit)
        res = server.submit_transaction(tx)
        log.debug("NFT_TRUST_CHANGE ok hash=%s", (res.get("hash") if isinstance(res, dict) else ""))
        return res
    except sx.BadResponseError as e:
        # Already trusted or benign – we just proceed
        msg = str(e)
        log.warning("NFT_TRUST_CHANGE horizon_error %s", msg)
        if "op_low_reserve" in msg.lower():
            raise
        return {"ok": True}
    except Exception as e:
        log.warning("NFT_TRUST_CHANGE error %s: %s", type(e).__name__, e)
        raise

def _pay_asset(secret_from: str, to_g: str, amount: str, asset: Asset, memo=None):
    kp = Keypair.from_secret(secret_from)
    acc = _load(kp.public_key)
    fee_bid = _base_fee()
    log.debug(
        "NFT_PAY precheck from=%s from_native=%s fee_bid=%s to=%s amt=%s asset=%s:%s memo=%s",
        _mask(kp.public_key), _native_balance(kp.public_key), fee_bid, _mask(to_g),
        amount, asset.code, _mask(asset.issuer), memo or ""
    )
    tb = TransactionBuilder(acc, PP, base_fee=fee_bid).append_payment_op(
        destination=to_g, amount=str(amount), asset=asset
    )
    if memo:
        tb = tb.add_text_memo(memo[:28])
    tx = tb.set_timeout(180).build()
    tx.sign(kp)
    log.debug("NFT_PAY start from=%s to=%s amt=%s asset=%s:%s memo=%s",
              _mask(kp.public_key), _mask(to_g), amount, asset.code, _mask(asset.issuer), memo or "")
    res = server.submit_transaction(tx)
    log.debug("NFT_PAY ok hash=%s", (res.get("hash") if isinstance(res, dict) else ""))
    return res

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

    log.info("NFT_MINT_REQ kind=%s size=%s prefix=%s tag=%s creator_pub=%s "
             "env_IZZA=%s:%s env_ISSUER_G=%s env_DISTR_G=%s",
             kind, size, prefix, tag, _mask(creator_pub),
             IZZA_CODE, _mask(IZZA_ISS), _mask(ISSUER_G), _mask(DISTR_G))

    _require(creator_pub and creator_sec, "creator_wallet_required")

    # explicit creator key validation for crisp errors
    if not _isG(creator_pub):
        abort(400, "creator_pub_invalid")
    if not _isS(creator_sec):
        abort(400, "creator_sec_invalid")

    # Validate env public keys once more in the hot path (log only)
    if not _isG(IZZA_ISS):
        log.error("NFT_ENV_BAD IZZA_TOKEN_ISSUER invalid G… value: %s", _mask(IZZA_ISS))
    if not _isG(ISSUER_G):
        log.error("NFT_ENV_BAD NFT_ISSUER_PUBLIC invalid G… value: %s", _mask(ISSUER_G))
    if not _isG(DISTR_G):
        log.error("NFT_ENV_BAD NFT_DISTR_PUBLIC invalid G… value: %s", _mask(DISTR_G))
    if not _isS(ISSUER_S):
        log.error("NFT_ENV_BAD NFT_ISSUER_SECRET invalid S… value: %s", _mask(ISSUER_S))
    if not _isS(DISTR_S):
        log.error("NFT_ENV_BAD NFT_DISTR_SECRET invalid S… value: %s", _mask(DISTR_S))

    unit = PRICE_SINGLE if kind == "single" else per_unit(size)
    total = (unit * size).quantize(Decimal("0.000001"), rounding=ROUND_DOWN)

    izza = Asset(IZZA_CODE, IZZA_ISS)

    # 1) fee charge: creator -> distributor in IZZA
    try:
        log.info("NFT_FEE_CHARGE start total=%s asset=%s:%s to=%s",
                 str(total), IZZA_CODE, _mask(IZZA_ISS), _mask(DISTR_G))
        _pay_asset(creator_sec, DISTR_G, str(total), izza, memo="IZZA NFT FEE")
        log.info("NFT_FEE_CHARGE ok total=%s", str(total))
    except Exception as e:
        log.error("NFT_FEE_CHARGE fail %s: %s", type(e).__name__, e)
        abort(400, f"fee_payment_failed: {e}")

    # 2) mint NFT assets to distributor (1 unit each)
    iss_kp = Keypair.from_secret(ISSUER_S)
    minted = []
    for i in range(size):
        code = _mint_code(prefix, f"{tag}{i+1:03d}" if kind == "collection" else f"{tag}")
        asset = Asset(code, iss_kp.public_key)
        try:
            log.debug("NFT_TRUST_DISTR start asset=%s:%s", code, _mask(iss_kp.public_key))
            _change_trust(DISTR_S, asset, limit="1")
            log.debug("NFT_TRUST_DISTR ok asset=%s", code)
        except Exception as e:
            log.error("NFT_TRUST_DISTR fail asset=%s %s: %s", code, type(e).__name__, e)
            abort(400, f"mint_trust_failed: {code}: {e}")

        iss_acc = _load(iss_kp.public_key)
        tx = (TransactionBuilder(iss_acc, PP, base_fee=_base_fee())
              .append_payment_op(DISTR_G, asset, "1")  # <-- swapped order: (destination, asset, amount)
              .set_timeout(180).build())
        tx.sign(iss_kp)
        try:
            log.debug("NFT_ISSUE start asset=%s to=%s", code, _mask(DISTR_G))
            server.submit_transaction(tx)
            log.debug("NFT_ISSUE ok asset=%s", code)
        except Exception as e:
            log.error("NFT_ISSUE fail asset=%s %s: %s", code, type(e).__name__, e)
            abort(400, f"mint_issue_failed: {code}: {e}")
        minted.append(code)

    log.info("NFT_MINT_OK size=%s total_fee=%s first_asset=%s", size, str(total), minted[0] if minted else "")
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

    log.info("NFT_CLAIM_REQ buyer=%s count=%s issuer=%s", _mask(buyer), len(assets), _mask(issuer_g))

    for code in assets:
        asset = Asset(code, issuer_g)
        # ensure buyer trustline (via distributor op)
        try:
            _change_trust(DISTR_S, asset, limit="1")  # distributor trusts already, but harmless
        except Exception as e:
            log.error("NFT_CLAIM_TRUST_FAIL asset=%s %s: %s", code, type(e).__name__, e)
            abort(400, f"deliver_trust_failed: {code}: {e}")
        # send to buyer
        try:
            _pay_asset(DISTR_S, buyer, "1", asset, memo="IZZA NFT")
        except Exception as e:
            log.error("NFT_CLAIM_DELIVER_FAIL asset=%s %s: %s", code, type(e).__name__, e)
            abort(400, f"deliver_failed: {code}: {e}")

    log.info("NFT_CLAIM_OK buyer=%s delivered=%s", _mask(buyer), len(assets))
    return jsonify({"ok": True, "delivered": len(assets)})
