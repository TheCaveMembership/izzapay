# nft_api.py
import os, json, re, math, requests, logging, time, sqlite3
from decimal import Decimal, ROUND_DOWN
from flask import Blueprint, request, jsonify, abort, session
from stellar_sdk import (
    Server, Keypair, Asset, TransactionBuilder, exceptions as sx, StrKey
)
from stellar_sdk.client.requests_client import RequestsClient

# ---- optional DB glue (reuse your sqlite connection helper if present)
try:
    from db import conn as _db_conn  # preferred
except Exception:
    _db_conn = None

def _db():
    if _db_conn is not None:
        return _db_conn()
    db_path = os.getenv("SQLITE_DB_PATH", "/var/data/izzapay/app.sqlite")
    cx = sqlite3.connect(db_path, check_same_thread=False)
    cx.row_factory = sqlite3.Row
    cx.execute("PRAGMA foreign_keys=ON;")
    return cx

bp_nft = Blueprint("nft_api", __name__)
log = logging.getLogger(__name__)

# ---------- small helpers ----------
def _mask(k: str | None) -> str:
    if not k: return ""
    k = k.strip()
    if len(k) <= 8: return k[:1] + "…"
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

def _norm_username(u: str | None) -> str | None:
    if not u: return None
    u = str(u).strip().lstrip("@").lower()
    return u or None

def _now_i() -> int:
    return int(time.time())

# ---------- env ----------
HORIZON_URL = os.getenv("NFT_HORIZON_URL", "https://api.testnet.minepi.com").strip()
PASSPHRASE  = os.getenv("NFT_NETWORK_PASSPHRASE", "auto").strip()

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

# ---------- Canonical issuer guard ----------
try:
    _pub_from_secret = Keypair.from_secret(ISSUER_S).public_key
except Exception:
    _pub_from_secret = None

if not _pub_from_secret or _pub_from_secret != ISSUER_G:
    raise RuntimeError(
        f"NFT issuer mismatch: NFT_ISSUER_PUBLIC={ISSUER_G} "
        f"does not match public key of NFT_ISSUER_SECRET={_mask(_pub_from_secret or '')}"
    )

CANONICAL_ISSUER_G = ISSUER_G  # single source of truth

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
log.info("NFT_ISSUER_CANON %s", _mask(CANONICAL_ISSUER_G))

PP = _network_passphrase()

# Requests client with timeouts to prevent worker timeouts on slow Horizon
_client = RequestsClient(num_retries=1, post_timeout=10)
server = Server(HORIZON_URL, client=_client)

# ---------- Horizon account helpers ----------
def _account_json(pub_g: str) -> dict | None:
    try:
        return server.accounts().account_id(pub_g).call()
    except Exception as e:
        log.debug("ACCT_READ_FAIL %s %s: %s", _mask(pub_g), type(e).__name__, e)
        return None

def _balance_native_from_json(j: dict | None) -> str:
    if not j: return "0"
    for b in j.get("balances", []):
        if b.get("asset_type") == "native":
            return b.get("balance", "0")
    return "0"

def _balance_for_asset_from_json(j: dict | None, code: str, issuer: str) -> Decimal:
    if not j: return Decimal("0")
    for b in j.get("balances", []):
        if b.get("asset_code") == code and b.get("asset_issuer") == issuer:
            try:
                return Decimal(b.get("balance", "0"))
            except Exception:
                return Decimal("0")
    return Decimal("0")

# ---------- dynamic fee ----------
def _base_fee() -> int:
    try:
        bf = int(server.fetch_base_fee())
        fee = max(100, bf * 5)
        log.debug("NFT_FEE_EST base=%s cushioned=%s", bf, fee)
        return fee
    except Exception as e:
        log.warning("NFT_FEE_FETCH_FAIL %s: %s; fallback=500", type(e).__name__, e)
        return 500

def _native_balance(g: str) -> str:
    j = _account_json(g)
    return _balance_native_from_json(j)

# ---------- pricing ----------
PRICE_SINGLE = Decimal("0.1")
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

# ---------- string helpers ----------
def _dec(n): return Decimal(str(n))
def _load(g): return server.load_account(g)
def _sanitize(s: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", (s or "").upper())

def _mint_code_single(prefix="NFT", suffix=""):
    base = f"{_sanitize(prefix)}{_sanitize(suffix)}"
    return (base[:12] or "NFTX")

def _mint_code_collection(prefix="NFT", tag="", idx=1):
    p = _sanitize(prefix)
    t = _sanitize(tag)
    room = max(0, 12 - len(p) - 3)
    t_cut = t[:room] if room > 0 else ""
    return f"{p}{t_cut}{idx:03d}"[:12]

# ---------- trust and payments ----------
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
    j = _account_json(pub_g)
    if not j: return False
    code, issuer = asset.code, asset.issuer
    for b in j.get("balances", []):
        if b.get("asset_code") == code and b.get("asset_issuer") == issuer:
            return True
    return False

# ---------- DB schema helpers for wallet ownership ----------
def _ensure_wallet_and_nft_tables():
    with _db() as cx:
        # user_wallets already managed in wallet_api, but ensure it exists here safely
        cx.execute("""
          CREATE TABLE IF NOT EXISTS user_wallets(
            username   TEXT PRIMARY KEY,
            pub        TEXT,
            secret     TEXT,
            revealed   INTEGER DEFAULT 0,
            created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
            updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
          )
        """)
        # core NFT tables used by /api/nft/owned
        cx.execute("""
          CREATE TABLE IF NOT EXISTS nft_collections(
            id INTEGER PRIMARY KEY,
            code TEXT NOT NULL UNIQUE,
            issuer TEXT NOT NULL,
            created_at INTEGER NOT NULL
          )
        """)
        cx.execute("""
          CREATE TABLE IF NOT EXISTS nft_tokens(
            id INTEGER PRIMARY KEY,
            collection_id INTEGER NOT NULL,
            serial INTEGER NOT NULL DEFAULT 1,
            owner_wallet_pub TEXT,
            minted_at INTEGER NOT NULL,
            UNIQUE(collection_id, serial),
            FOREIGN KEY(collection_id) REFERENCES nft_collections(id) ON DELETE CASCADE
          )
        """)

def _active_wallet_pub_for_username(username: str | None) -> str | None:
    if not username: return None
    with _db() as cx:
        r = cx.execute("SELECT pub FROM user_wallets WHERE username=?", (username,)).fetchone()
        return r["pub"] if r and r["pub"] else None

def _upsert_collection_and_assign(code: str, issuer: str, owner_pub: str) -> None:
    """
    Ensure collection exists, ensure token row exists, and set owner_wallet_pub.
    We default to serial=1 for single supply.
    """
    _ensure_wallet_and_nft_tables()
    with _db() as cx:
        # collection
        cx.execute("""
          INSERT INTO nft_collections(code, issuer, created_at)
          VALUES(?,?,?)
          ON CONFLICT(code) DO NOTHING
        """, (code, issuer, _now_i()))
        row = cx.execute("SELECT id FROM nft_collections WHERE code=?", (code,)).fetchone()
        if not row:
            raise RuntimeError(f"collection_missing_after_upsert:{code}")
        cid = int(row["id"])
        # token serial 1
        cx.execute("""
          INSERT INTO nft_tokens(collection_id, serial, owner_wallet_pub, minted_at)
          VALUES(?, 1, ?, ?)
          ON CONFLICT(collection_id, serial) DO UPDATE SET
            owner_wallet_pub=excluded.owner_wallet_pub
        """, (cid, owner_pub, _now_i()))
        cx.commit()

# ---- Idempotent: ensure distributor can receive & holds exactly one unit ----
def _ensure_distributor_holds_one(asset: Asset):
    try:
        _change_trust(DISTR_S, asset, limit="1")
    except Exception as e:
        msg = str(e).lower()
        if "op_low_reserve" in msg:
            raise
    dj = _account_json(DISTR_G)
    bal = _balance_for_asset_from_json(dj, asset.code, asset.issuer)
    if bal >= Decimal("1"):
        log.debug("NFT_DISTR_ALREADY_HAS_ONE asset=%s:%s bal=%s", asset.code, _mask(asset.issuer), str(bal))
        return
    need = Decimal("1") - bal
    amt = str(need.quantize(Decimal("1")))
    iss_kp = Keypair.from_secret(ISSUER_S)
    iss_acc = _load(iss_kp.public_key)
    tx = (TransactionBuilder(iss_acc, PP, base_fee=_base_fee())
          .append_payment_op(destination=DISTR_G, amount=amt, asset=asset)
          .set_timeout(180).build())
    tx.sign(iss_kp)
    try:
        log.debug("NFT_ISSUE start asset=%s to=%s amt=%s", asset.code, _mask(DISTR_G), amt)
        server.submit_transaction(tx)
        log.debug("NFT_ISSUE ok asset=%s amt=%s", asset.code, amt)
    except sx.BadResponseError as e:
        body = getattr(e, "response", None)
        text = ""
        try:
            text = body.text  # type: ignore[attr-defined]
        except Exception:
            text = str(e)
        if "op_line_full" in text or "op_line_full" in str(e):
            log.warning("NFT_ISSUE_LINE_FULL benign asset=%s", asset.code)
            return
        log.error("NFT_ENSURE_ISSUE fail asset=%s %s: %s", asset.code, type(e).__name__, e)
        raise
    except Exception as e:
        log.error("NFT_ENSURE_ISSUE fail asset=%s %s: %s", asset.code, type(e).__name__, e)
        raise

# --------------------- Pending NFT claims: tiny queue ---------------------
def _ensure_pending_table():
    try:
        with _db() as cx:
            cx.execute("""
              CREATE TABLE IF NOT EXISTS nft_pending_claims(
                id INTEGER PRIMARY KEY,
                order_id INTEGER,
                buyer_user_id INTEGER,
                buyer_username TEXT,
                buyer_pub TEXT NOT NULL,
                issuer TEXT NOT NULL,
                assets_json TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                created_at INTEGER NOT NULL,
                claimed_at INTEGER,
                UNIQUE(order_id)
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
    j = request.get_json(silent=True) or {}
    order_id       = j.get("order_id")
    buyer_username = (j.get("buyer_username") or "").strip() or None
    buyer_pub      = (j.get("buyer_pub") or "").strip()
    issuer         = CANONICAL_ISSUER_G
    assets         = list(j.get("assets") or [])
    _require(buyer_pub and assets, "buyer_pub_and_assets_required")
    if not _isG(buyer_pub): abort(400, "buyer_pub_invalid")
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
                _now_i()
            ))
            cx.commit()
    except Exception as e:
        abort(500, f"queue_fail: {e}")
    return jsonify({"ok": True})

@bp_nft.route("/api/nft/pending", methods=["GET"])
def list_pending():
    u   = (request.args.get("u") or "").strip()
    pub = (request.args.get("pub") or "").strip()
    _ensure_pending_table()
    try:
        with _db() as cx:
            if pub and _isG(pub) and u:
                cur = cx.execute("""
                  SELECT * FROM nft_pending_claims
                  WHERE status='pending'
                    AND (buyer_pub=? OR lower(buyer_username)=lower(?))
                  ORDER BY created_at ASC
                """, (pub, u))
            elif pub and _isG(pub):
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
    out = []
    for r in rows:
        try:
            assets = json.loads(r.get("assets_json") or "[]")
        except Exception:
            assets = []
        out.append({
            "id": r["id"],
            "order_id": r["order_id"],
            "buyer_username": r["buyer_username"],
            "buyer_pub": r["buyer_pub"],
            "issuer": CANONICAL_ISSUER_G,
            "assets": assets,
            "status": r["status"],
            "created_at": r["created_at"],
            "kind": "nft",
            "contract_id": f"nft|{r['id']}",
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

@bp_nft.get("/api/nft/owned")
def api_nft_owned():
    pub = (request.args.get("pub") or "").strip()
    if not pub:
        return jsonify({"ok": False, "error": "missing_pub"}), 400
    try:
        with _db() as cx:
            rows = cx.execute("""
                SELECT nt.serial, nc.code, nc.issuer
                FROM nft_tokens nt
                JOIN nft_collections nc ON nc.id = nt.collection_id
                WHERE nt.owner_wallet_pub = ?
                ORDER BY nc.code ASC, nt.serial ASC
            """, (pub,)).fetchall()
        out = [dict(code=r["code"], issuer=r["issuer"], serial=r["serial"]) for r in rows]
        return jsonify({"ok": True, "rows": out}), 200
    except Exception as e:
        log.error("NFT_OWNED_FAIL %s: %s", type(e).__name__, e)
        return jsonify({"ok": False, "error": "db_error"}), 500

@bp_nft.route("/api/nft/mint", methods=["POST"])
def mint():
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
    if not _isG(creator_pub): abort(400, "creator_pub_invalid")
    if not _isS(creator_sec): abort(400, "creator_sec_invalid")

    if not _isG(IZZA_ISS):  log.error("NFT_ENV_BAD IZZA_TOKEN_ISSUER invalid G…: %s", _mask(IZZA_ISS))
    if not _isG(ISSUER_G):  log.error("NFT_ENV_BAD NFT_ISSUER_PUBLIC invalid G…: %s", _mask(ISSUER_G))
    if not _isG(DISTR_G):   log.error("NFT_ENV_BAD NFT_DISTR_PUBLIC invalid G…: %s", _mask(DISTR_G))
    if not _isS(ISSUER_S):  log.error("NFT_ENV_BAD NFT_ISSUER_SECRET invalid S…")
    if not _isS(DISTR_S):   log.error("NFT_ENV_BAD NFT_DISTR_SECRET invalid S…")

    unit = PRICE_SINGLE if kind == "single" else per_unit(size)
    total = (unit * size).quantize(Decimal("0.000001"), rounding=ROUND_DOWN)

    izza = Asset(IZZA_CODE, IZZA_ISS)

    # distributor trust for IZZA, idempotent
    try:
        _change_trust(DISTR_S, izza, limit="100000000")
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

    # 2) mint each NFT to distributor
    iss_kp = Keypair.from_secret(ISSUER_S)
    minted = []
    for i in range(size):
        code = _mint_code_collection(prefix, tag, i + 1) if kind == "collection" else _mint_code_single(prefix, tag)
        asset = Asset(code, iss_kp.public_key)
        try:
            _ensure_distributor_holds_one(asset)
        except Exception as e:
            log.error("NFT_TRUST_OR_ISSUE fail asset=%s %s: %s", code, type(e).__name__, e)
            abort(400, f"mint_trust_failed: {code}: {e}")
        minted.append(code)

    log.info("NFT_MINT_OK size=%s total_fee=%s first_asset=%s", size, str(total), minted[0] if minted else "")
    return jsonify({"ok": True, "assets": minted, "size": size, "total_fee": str(total)})

@bp_nft.route("/api/nft/claim", methods=["POST"])
def claim():
    """
    Buyer fulfillment after store purchase:
    body {
      "buyer_pub": "G..."              optional if ?u is present and linked via /api/wallet/link
      "assets": ["NFTABC001", ...],    required
      "issuer": "G...",                ignored, canonical issuer is enforced
      "pending_id": 123                optional, will be marked claimed
    }
    Also accepts ?u=<username> to resolve wallet if buyer_pub is omitted.
    """
    j = request.get_json(silent=True) or {}
    # resolve username from query or session
    u = _norm_username(request.args.get("u")) or _norm_username(session.get("pi_username"))
    buyer      = (j.get("buyer_pub") or "").strip()
    assets     = list(j.get("assets") or [])
    issuer_g   = CANONICAL_ISSUER_G
    pending_id = j.get("pending_id")

    # auto-resolve pub from user if not provided
    if not buyer and u:
        buyer = (_active_wallet_pub_for_username(u) or "").strip()

    _require(buyer and assets, "buyer_and_assets_required")
    if not _isG(buyer): abort(400, "buyer_pub_invalid")

    req_issuer = (j.get("issuer") or "").strip()
    if req_issuer and req_issuer != issuer_g:
        log.warning("NFT_CLAIM_ISSUER_OVERRIDE_IGNORED got=%s expected=%s",
                    _mask(req_issuer), _mask(issuer_g))

    log.info("NFT_CLAIM_REQ user=%s buyer=%s count=%s issuer=%s",
             u or "", _mask(buyer), len(assets), _mask(issuer_g))

    # deliver each asset on-chain, then persist ownership in DB
    delivered = 0
    for code in assets:
        asset = Asset(code, issuer_g)

        # Verify buyer trustline
        if not _account_has_trustline(buyer, asset):
            abort(400, f"buyer_missing_trustline:{code}")

        # Ensure distributor holds 1 unit
        _ensure_distributor_holds_one(asset)

        # Deliver on-chain
        try:
            _pay_asset(DISTR_S, buyer, "1", asset, memo="IZZA NFT")
            delivered += 1
        except Exception as e:
            log.error("NFT_CLAIM_DELIVER_FAIL asset=%s %s: %s", code, type(e).__name__, e)
            abort(400, f"deliver_failed: {code}: {e}")

        # Record ownership for wallet view
        try:
            _upsert_collection_and_assign(code=code, issuer=issuer_g, owner_pub=buyer)
        except Exception as e:
            # Delivery succeeded, do not roll back, just log and continue
            log.warning("NFT_DB_ASSIGN_FAIL code=%s err=%s", code, e)

    # Mark pending row as claimed if provided
    if pending_id:
        try:
            with _db() as cx:
                cx.execute(
                    "UPDATE nft_pending_claims SET status='claimed', claimed_at=? WHERE id=?",
                    (_now_i(), int(pending_id))
                )
                cx.commit()
        except Exception as e:
            log.warning("NFT_PENDING_MARK_FAIL id=%s err=%s", pending_id, e)

    log.info("NFT_CLAIM_OK buyer=%s delivered=%s", _mask(buyer), delivered)
    return jsonify({"ok": True, "delivered": delivered, "buyer_pub": buyer})
