# nft_api.py
import os, json, re, math, requests, logging, time, sqlite3
from decimal import Decimal, ROUND_DOWN
from flask import Blueprint, request, jsonify, abort
from stellar_sdk import (
    Server, Keypair, Asset, TransactionBuilder, exceptions as sx, StrKey
)

# ---- optional DB glue (reuse your sqlite connection helper if present)
try:
    from db import conn as _db_conn  # preferred
except Exception:
    _db_conn = None

def _db():
    if _db_conn is not None:
        return _db_conn()
    # ultra-safe fallback if db.conn isn't importable
    db_path = os.getenv("SQLITE_DB_PATH", "/var/data/izzapay/app.sqlite")
    cx = sqlite3.connect(db_path, check_same_thread=False)
    cx.row_factory = sqlite3.Row
    cx.execute("PRAGMA foreign_keys=ON;")
    return cx

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

def _sanitize(s: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", (s or "").upper())

def _mint_code_single(prefix="NFT", suffix=""):
    base = f"{_sanitize(prefix)}{_sanitize(suffix)}"
    return (base[:12] or "NFTX")

def _mint_code_collection(prefix="NFT", tag="", idx=1):
    """
    Ensure uniqueness under 12 chars by reserving 3 for the index.
    """
    p = _sanitize(prefix)
    t = _sanitize(tag)
    # reserve 3 for idx
    room = max(0, 12 - len(p) - 3)
    t_cut = t[:room] if room > 0 else ""
    return f"{p}{t_cut}{idx:03d}"[:12]

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

def _account_has_trustline(pub_g: str, asset: Asset) -> bool:
    """Check if an account already has a trustline to the given asset."""
    try:
        acc = server.load_account(pub_g)
        code, issuer = asset.code, asset.issuer
        for b in acc.balances:
            if b.get("asset_code") == code and b.get("asset_issuer") == issuer:
                return True
        return False
    except Exception:
        return False

# --------------------- Pending NFT claims: tiny queue ---------------------

# Table is created in db.ensure_schema(); keep an idempotent fallback here.
def _ensure_pending_table():
    try:
        with _db() as cx:
            cx.execute("""
              CREATE TABLE IF NOT EXISTS nft_pending_claims(
                id INTEGER PRIMARY KEY,
                order_id INTEGER,              -- optional link to orders.id
                buyer_user_id INTEGER,         -- optional link to users.id
                buyer_username TEXT,           -- cached username for convenience
                buyer_pub TEXT NOT NULL,       -- G... wallet to deliver into
                issuer TEXT NOT NULL,          -- issuer G... (defaults to NFT_ISSUER_PUBLIC)
                assets_json TEXT NOT NULL,     -- ["ASSET001", "ASSET002", ...]
                status TEXT NOT NULL DEFAULT 'pending',  -- pending | claimed | canceled
                created_at INTEGER NOT NULL,
                claimed_at INTEGER,
                UNIQUE(order_id)               -- one row per order if you pass it
              );
            """)
    except Exception:
        pass

_ensure_pending_table()

def _username_to_user_id(username: str | None) -> int | None:
    if not username: return None
    try:
        with _db() as cx:
            cur = cx.execute("SELECT id FROM users WHERE lower(pi_username)=lower(?)", (username.strip(),))
            row = cur.fetchone()
            return int(row["id"]) if row else None
    except Exception:
        return None

@bp_nft.route("/api/nft/queue_claim", methods=["POST"])
def queue_claim():
    """
    Internal helper you can call right after a successful checkout for an NFT product.
    Body:
      {
        "order_id": 123,                  # optional but recommended
        "buyer_username": "cam",          # optional; will be resolved to user_id if exists
        "buyer_pub": "G...",              # REQUIRED
        "issuer": "G...",                 # optional; defaults to NFT_ISSUER_PUBLIC
        "assets": ["NFTABC001", ...]      # REQUIRED, non-empty
      }
    """
    j = request.get_json(silent=True) or {}
    order_id = j.get("order_id")
    buyer_username = (j.get("buyer_username") or "").strip() or None
    buyer_pub = (j.get("buyer_pub") or "").strip()
    issuer = (j.get("issuer") or ISSUER_G).strip()
    assets = list(j.get("assets") or [])

    _require(buyer_pub and assets, "buyer_pub_and_assets_required")
    if not _isG(buyer_pub): abort(400, "buyer_pub_invalid")
    if not _isG(issuer): issuer = ISSUER_G

    buyer_user_id = _username_to_user_id(buyer_username)

    _ensure_pending_table()
    try:
        with _db() as cx:
            cx.execute("""
              INSERT OR IGNORE INTO nft_pending_claims
              (order_id, buyer_user_id, buyer_username, buyer_pub, issuer, assets_json, status, created_at)
              VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
            """, (
                int(order_id) if order_id else None,
                int(buyer_user_id) if buyer_user_id else None,
                buyer_username,
                buyer_pub,
                issuer,
                json.dumps(assets),
                int(time.time())
            ))
            cx.commit()
    except Exception as e:
        abort(500, f"queue_fail: {e}")

    return jsonify({"ok": True})

@bp_nft.route("/api/nft/pending", methods=["GET"])
def list_pending():
    """
    List pending NFT claims for UI. Query by ?u=username or ?pub=G...
    """
    u = (request.args.get("u") or "").strip()
    pub = (request.args.get("pub") or "").strip()

    _ensure_pending_table()
    rows = []
    try:
        with _db() as cx:
            if pub and _isG(pub):
                cur = cx.execute("""
                  SELECT * FROM nft_pending_claims
                  WHERE buyer_pub=? AND status='pending'
                  ORDER BY created_at ASC
                """, (pub,))
            elif u:
                cur = cx.execute("""
                  SELECT * FROM nft_pending_claims
                  WHERE lower(buyer_username)=lower(?) AND status='pending'
                  ORDER BY created_at ASC
                """, (u,))
            else:
                abort(400, "provide u or pub")
            rows = [dict(r) for r in cur.fetchall()]
    except Exception as e:
        abort(500, f"list_fail: {e}")

    # Normalize for UI
    out = []
    for r in rows:
        assets = []
        try:
            assets = json.loads(r.get("assets_json") or "[]")
        except Exception:
            assets = []
        out.append({
            "id": r["id"],
            "order_id": r["order_id"],
            "buyer_username": r["buyer_username"],
            "buyer_pub": r["buyer_pub"],
            "issuer": r["issuer"],
            "assets": assets,
            "status": r["status"],
            "created_at": r["created_at"],
            "kind": "nft",                       # so UI can tag these in the same list
            "contract_id": f"nft|{r['id']}",     # unique like the stake group ids
        })
    return jsonify({"ok": True, "pending": out})

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
      "collection_tag": "ABC",      # optional suffix/stable tag for a set
      "royalty_bp": 0               # optional creator royalty in basis points (0..1000); ignored on-chain here
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

    # Ensure distributor trusts IZZA before fee collection (idempotent).
    try:
        _change_trust(DISTR_S, izza, limit="100000000")  # harmless if already exists
    except Exception as e:
        log.warning("NFT_DISTR_TRUST_IZZA_FAIL %s: %s", type(e).__name__, e)

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
        if kind == "collection":
            code = _mint_code_collection(prefix, tag, i + 1)
        else:
            code = _mint_code_single(prefix, tag)
        asset = Asset(code, iss_kp.public_key)
        try:
            log.debug("NFT_TRUST_DISTR start asset=%s:%s", code, _mask(iss_kp.public_key))
            _change_trust(DISTR_S, asset, limit="1")
            log.debug("NFT_TRUST_DISTR ok asset=%s", code)
        except Exception as e:
            log.error("NFT_TRUST_DISTR fail asset=%s %s: %s", code, type(e).__name__, e)
            abort(400, f"mint_trust_failed: {code}: {e}")

        iss_acc = _load(iss_kp.public_key)
        # FIX: correct argument order for append_payment_op (destination, amount, asset)
        tx = (TransactionBuilder(iss_acc, PP, base_fee=_base_fee())
              .append_payment_op(destination=DISTR_G, amount="1", asset=asset)
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
      "issuer": "G..."   # optional, defaults to NFT_ISSUER_PUBLIC
      "pending_id": 123  # optional; if provided and delivery succeeds, marks claimed
    }
    """
    j = request.get_json(silent=True) or {}
    buyer = (j.get("buyer_pub") or "").strip()
    assets = list(j.get("assets") or [])
    issuer_g = (j.get("issuer") or ISSUER_G).strip()
    pending_id = j.get("pending_id")
    _require(buyer and assets, "buyer_and_assets_required")

    log.info("NFT_CLAIM_REQ buyer=%s count=%s issuer=%s", _mask(buyer), len(assets), _mask(issuer_g))

    for code in assets:
        asset = Asset(code, issuer_g)

        # FIX: do NOT try to create buyer trustline using distributor secret.
        # Instead, verify buyer already trusts; if not, return crisp error.
        if not _account_has_trustline(buyer, asset):
            abort(400, f"buyer_missing_trustline:{code}")

        # send to buyer
        try:
            _pay_asset(DISTR_S, buyer, "1", asset, memo="IZZA NFT")
        except Exception as e:
            log.error("NFT_CLAIM_DELIVER_FAIL asset=%s %s: %s", code, type(e).__name__, e)
            abort(400, f"deliver_failed: {code}: {e}")

    # Mark pending row as claimed if provided
    if pending_id:
        try:
            with _db() as cx:
                cx.execute(
                    "UPDATE nft_pending_claims SET status='claimed', claimed_at=? WHERE id=?",
                    (int(time.time()), int(pending_id))
                )
                cx.commit()
        except Exception as e:
            log.warning("NFT_PENDING_MARK_FAIL id=%s err=%s", pending_id, e)

    log.info("NFT_CLAIM_OK buyer=%s delivered=%s", _mask(buyer), len(assets))
    return jsonify({"ok": True, "delivered": len(assets)})
