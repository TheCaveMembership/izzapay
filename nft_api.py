# nft_api.py
import os, json, re, requests, logging, time, sqlite3
from decimal import Decimal, ROUND_DOWN
from flask import Blueprint, request, jsonify, abort, session
from stellar_sdk import (
    Server, Keypair, Asset, TransactionBuilder, exceptions as sx, StrKey
)
from stellar_sdk.client.requests_client import RequestsClient

# Use app DB connection
try:
    from db import conn as _db_conn
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

def _q7(x: Decimal) -> str:
    # Stellar amounts are up to 7 decimals
    return str(x.quantize(Decimal("0.0000001"), rounding=ROUND_DOWN))

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
    raise RuntimeError("Missing NFT issuer or distributor env vars")
if not IZZA_ISS:
    raise RuntimeError("Missing IZZA_TOKEN_ISSUER env var")

# NFT units: indivisible at 1 stroop (0.0000001)
ONE_NFT_UNIT = Decimal("0.0000001")

# Canonical issuer guard
try:
    _pub_from_secret = Keypair.from_secret(ISSUER_S).public_key
except Exception:
    _pub_from_secret = None
if not _pub_from_secret or _pub_from_secret != ISSUER_G:
    raise RuntimeError(
        f"NFT issuer mismatch. NFT_ISSUER_PUBLIC={ISSUER_G} does not match secret’s public {_mask(_pub_from_secret or '')}"
    )

CANONICAL_ISSUER_G = ISSUER_G

def _log_env_summary():
    try:
        log.info("NFT_ENV_SUMMARY %s", json.dumps({
            "HORIZON_URL": HORIZON_URL,
            "PASSPHRASE_mode": "auto" if PASSPHRASE.lower() == "auto" else "explicit",
            "ISSUER_G_masked": _mask(ISSUER_G),
            "DISTR_G_masked":  _mask(DISTR_G),
            "IZZA_CODE": IZZA_CODE,
            "IZZA_ISS_masked": _mask(IZZA_ISS),
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
        return j.get("network_passphrase") or "Test SDF Network ; September 2015"
    except Exception:
        return "Test SDF Network ; September 2015"

_log_env_summary()
PP = _network_passphrase()

# Horizon client
_client = RequestsClient(num_retries=1, post_timeout=10)
server = Server(HORIZON_URL, client=_client)

# ---------- Horizon helpers ----------
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

def _base_fee() -> int:
    try:
        bf = int(server.fetch_base_fee())
        return max(100, bf * 5)
    except Exception:
        return 500

def _load(g): return server.load_account(g)

# ---------- pricing ----------
PRICE_SINGLE = Decimal("0.1")
TIERS = [
    (1,   Decimal("0.1000")),
    (10,  Decimal("0.0950")),
    (25,  Decimal("0.0900")),
    (50,  Decimal("0.0850")),
    (100, Decimal("0.0800"))
]
def per_unit(n:int)->Decimal:
    p = TIERS[0][1]
    for m, price in TIERS:
        if n >= m: p = price
    return p

# ---------- utils ----------
def _sanitize(s: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", (s or "").upper())

def _mint_code_single(prefix="NFT", suffix="") -> str:
    return (f"{_sanitize(prefix)}{_sanitize(suffix)}"[:12] or "NFTX")

def _mint_code_collection(prefix="NFT", tag="", idx=1) -> str:
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
        return server.submit_transaction(tx)
    except sx.BadResponseError as e:
        msg = (getattr(e, "message", "") or str(e) or "").lower()
        if "op_low_reserve" in msg: raise
        return {"ok": True}
    except Exception:
        raise

def _pay_asset(secret_from: str, to_g: str, amount: str, asset: Asset, memo=None):
    kp = Keypair.from_secret(secret_from)
    acc = _load(kp.public_key)
    tb = TransactionBuilder(acc, PP, base_fee=_base_fee()).append_payment_op(
        destination=to_g, amount=str(amount), asset=asset
    )
    if memo:
        tb = tb.add_text_memo(memo[:28])
    tx = tb.set_timeout(180).build()
    tx.sign(kp)
    return server.submit_transaction(tx)

def _require(b, msg="bad_request"):
    if not b: abort(400, msg)

def _account_has_trustline(pub_g: str, asset: Asset) -> bool:
    j = _account_json(pub_g)
    if not j: return False
    for b in j.get("balances", []):
        if b.get("asset_code") == asset.code and b.get("asset_issuer") == asset.issuer:
            return True
    return False

def _buyer_has_izza_and_trust(pub_g: str, need: Decimal) -> bool:
    """
    Check the buyer has both a trustline and at least `need` IZZA balance.
    """
    j = _account_json(pub_g)
    if not j: return False
    bal = _balance_for_asset_from_json(j, IZZA_CODE, IZZA_ISS)
    return bal >= need

# ---------- DB helpers ----------
def _ensure_collection_row(code: str, issuer: str, total_supply: int = 1, decimals: int = 0,
                           royalty_bp: int | None = None,
                           backing_template_izza: str | None = None):
    """
    Ensure nft_collections row exists and satisfies NOT NULL constraints.
    Also store default royalty_bp and backing_template_izza if provided.
    """
    now = _now_i()
    with _db() as cx:
        cx.execute("""
          INSERT INTO nft_collections(
            code, issuer, total_supply, decimals, status,
            royalty_bp, backing_template_izza,
            created_at, updated_at
          )
          VALUES(?, ?, ?, ?, 'draft', ?, ?, ?, ?)
          ON CONFLICT(code, issuer) DO UPDATE SET
            updated_at = excluded.updated_at,
            royalty_bp = CASE
              WHEN excluded.royalty_bp IS NOT NULL THEN excluded.royalty_bp
              ELSE nft_collections.royalty_bp
            END,
            backing_template_izza = CASE
              WHEN excluded.backing_template_izza IS NOT NULL THEN excluded.backing_template_izza
              ELSE nft_collections.backing_template_izza
            END
        """, (
            code, issuer,
            int(total_supply), int(decimals),
            royalty_bp, backing_template_izza,
            now, now
        ))
        cx.commit()

def _upsert_collection_and_assign(code: str, issuer: str, owner_pub: str) -> None:
    """
    Match schema: nft_collections UNIQUE(code, issuer) with NOT NULL total_supply/decimals.
    nft_tokens UNIQUE(collection_id, serial).
    We also attach initial backing info from the collection onto the token.
    """
    _ensure_collection_row(code, issuer, total_supply=1, decimals=0)
    with _db() as cx:
        row = cx.execute(
            "SELECT id, backing_template_izza, royalty_bp FROM nft_collections WHERE code=? AND issuer=?",
            (code, issuer)
        ).fetchone()
        if not row:
            raise RuntimeError(f"collection_missing_after_upsert:{code}:{issuer}")
        cid = int(row["id"])
        backing_tpl = row["backing_template_izza"]

        # Ensure token serial 1 exists and is owned by owner_pub
        cx.execute("""
          INSERT INTO nft_tokens(
            collection_id, serial, owner_wallet_pub, minted_at,
            backing_izza, backing_asset_code, backing_asset_issuer
          )
          VALUES(?, 1, ?, ?, ?, ?, ?)
          ON CONFLICT(collection_id, serial) DO UPDATE SET
            owner_wallet_pub = excluded.owner_wallet_pub,
            minted_at = excluded.minted_at
        """, (
            cid,
            owner_pub,
            _now_i(),
            backing_tpl if backing_tpl is not None else None,
            IZZA_CODE,
            IZZA_ISS
        ))
        cx.commit()

def _add_backing_for_token(code: str, issuer: str, extra_str: str | None):
    """
    Increase backing_izza for the NFT token corresponding to asset code+issuer by extra_str (in IZZA).
    This is called when a buyer attaches extra IZZA vault backing during claim.
    """
    if not extra_str:
        return
    try:
        extra = Decimal(str(extra_str).strip() or "0")
    except Exception:
        return
    if extra <= Decimal("0"):
        return

    with _db() as cx:
        row = cx.execute(
            "SELECT id FROM nft_collections WHERE code=? AND issuer=?",
            (code, issuer)
        ).fetchone()
        if not row:
            return
        cid = int(row["id"])
        tok = cx.execute(
            "SELECT backing_izza FROM nft_tokens WHERE collection_id=? AND serial=1",
            (cid,)
        ).fetchone()
        if not tok:
            return
        try:
            cur = Decimal(str(tok["backing_izza"] or "0"))
        except Exception:
            cur = Decimal("0")
        new_val = (cur + extra).quantize(Decimal("0.0000001"), rounding=ROUND_DOWN)
        cx.execute(
            "UPDATE nft_tokens SET backing_izza=? WHERE collection_id=? AND serial=1",
            (str(new_val), cid)
        )
        cx.commit()

# ---- Idempotent: make sure distributor holds exactly one unit of the asset (1 stroop) ----
def _ensure_distributor_holds_one(asset: Asset):
    """
    Ensure the distributor holds ONE_NFT_UNIT (0.0000001) of the given asset.
    This makes the NFT truly indivisible at the protocol's minimum granularity.
    """
    try:
        _change_trust(DISTR_S, asset, limit="1")
    except Exception as e:
        if "op_low_reserve" in str(e).lower():
            raise
    dj = _account_json(DISTR_G)
    bal = _balance_for_asset_from_json(dj, asset.code, asset.issuer)
    if bal >= ONE_NFT_UNIT:
        return
    need = ONE_NFT_UNIT - bal
    if need <= Decimal("0"):
        return
    amt = str(need.quantize(ONE_NFT_UNIT, rounding=ROUND_DOWN))
    iss_kp = Keypair.from_secret(ISSUER_S)
    iss_acc = _load(iss_kp.public_key)
    tx = (TransactionBuilder(iss_acc, PP, base_fee=_base_fee())
          .append_payment_op(destination=DISTR_G, amount=amt, asset=asset)
          .set_timeout(180).build())
    tx.sign(iss_kp)
    try:
        server.submit_transaction(tx)
    except sx.BadResponseError as e:
        text = ""
        try:
            text = e.response.text  # type: ignore[attr-defined]
        except Exception:
            text = str(e)
        if "op_line_full" in text:
            return
        raise
    except Exception:
        raise

# --------------------- Pending NFT claims list ---------------------
@bp_nft.route("/api/nft/pending", methods=["GET"])
def list_pending():
    u   = (request.args.get("u") or "").strip()
    pub = (request.args.get("pub") or "").strip()
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

# ---------- Quote ----------
@bp_nft.route("/api/nft/quote", methods=["POST"])
def quote():
    j = request.get_json(silent=True) or {}
    kind = (j.get("kind") or "single").strip()
    size = 1 if kind == "single" else max(1, int(j.get("size") or 1))
    unit = PRICE_SINGLE if kind == "single" else per_unit(size)
    total = (unit * size).quantize(Decimal("0.000001"), rounding=ROUND_DOWN)
    return jsonify({"ok": True, "kind": kind, "size": size, "per_unit": str(unit), "total": str(total)})

# ---------- Owned ----------
@bp_nft.get("/api/nft/owned")
def api_nft_owned():
    pub = (request.args.get("pub") or "").strip()
    if not pub:
        return jsonify({"ok": False, "error": "missing_pub"}), 400
    try:
        with _db() as cx:
            rows = cx.execute("""
                SELECT
                  nt.serial,
                  nc.code,
                  nc.issuer,
                  nt.backing_izza,
                  nt.backing_asset_code,
                  nt.backing_asset_issuer,
                  nt.metadata_json
                FROM nft_tokens nt
                JOIN nft_collections nc ON nc.id = nt.collection_id
                WHERE nt.owner_wallet_pub = ?
                ORDER BY nc.code ASC, nt.serial ASC
            """, (pub,)).fetchall()
        out = []
        for r in rows:
            # backing value as a string number
            backing_raw = r["backing_izza"]
            backing_str = "0"
            if backing_raw is not None:
                try:
                    backing_str = str(Decimal(str(backing_raw)))
                except Exception:
                    backing_str = "0"

            # optional metadata for image
            img_url = None
            meta_raw = r["metadata_json"]
            if meta_raw:
                try:
                    meta = json.loads(meta_raw)
                    # Try common keys, you can adjust if you use a different schema
                    img_url = (
                        meta.get("image_url")
                        or meta.get("image")
                        or meta.get("img")
                    )
                except Exception:
                    img_url = None

            out.append({
                "code": r["code"],
                "issuer": r["issuer"],
                "serial": r["serial"],
                "backing_izza": backing_str,
                "backing_asset_code": r["backing_asset_code"],
                "backing_asset_issuer": r["backing_asset_issuer"],
                "img_url": img_url,
            })
        return jsonify({"ok": True, "rows": out}), 200
    except Exception as e:
        log.error("NFT_OWNED_FAIL %s: %s", type(e).__name__, e)
        return jsonify({"ok": False, "error": "db_error"}), 500

# ---------- helper: active wallet from username ----------
def _active_wallet_pub_for_username(u: str | None) -> str | None:
    if not u: return None
    u = u.strip().lower()
    try:
        with _db() as cx:
            row = cx.execute(
                "SELECT pub FROM user_wallets WHERE lower(username)=?",
                (u,)
            ).fetchone()
        return row["pub"] if row else None
    except Exception:
        return None

# ---------- Mint ----------
@bp_nft.route("/api/nft/mint", methods=["POST"])
def mint():
    j = request.get_json(silent=True) or {}
    creator_pub = (j.get("creator_pub") or "").strip()
    creator_sec = (j.get("creator_sec") or "").strip()
    kind = (j.get("kind") or "single").strip()
    size = 1 if kind == "single" else max(1, int(j.get("size") or 1))
    prefix = (j.get("prefix") or "NFT").strip()
    tag = (j.get("collection_tag") or "").strip()

    _require(creator_pub and creator_sec, "creator_wallet_required")
    if not _isG(creator_pub): abort(400, "creator_pub_invalid")
    if not _isS(creator_sec): abort(400, "creator_sec_invalid")

    # Creator royalty (basis points) 0–1000
    royalty_bp = 0
    try:
        royalty_bp = int(j.get("royalty_bp") or 0)
    except Exception:
        royalty_bp = 0
    if royalty_bp < 0: royalty_bp = 0
    if royalty_bp > 1000: royalty_bp = 1000

    # Optional vault backing per NFT (in IZZA)
    try:
        backing_raw = str(j.get("backing_izza") or "0").strip()
        backing_per = Decimal(backing_raw or "0")
    except Exception:
        backing_per = Decimal("0")
    if backing_per < Decimal("0"):
        backing_per = Decimal("0")
    backing_per = backing_per.quantize(Decimal("0.0000001"), rounding=ROUND_DOWN)
    total_backing = (backing_per * size).quantize(Decimal("0.0000001"), rounding=ROUND_DOWN)

    unit = PRICE_SINGLE if kind == "single" else per_unit(size)
    total_fee = (unit * size).quantize(Decimal("0.000001"), rounding=ROUND_DOWN)

    izza = Asset(IZZA_CODE, IZZA_ISS)

    # Trustline for IZZA on distributor (fee receiver / vault)
    try:
        _change_trust(DISTR_S, izza, limit="100000000")
    except Exception as e:
        log.warning("NFT_DISTR_TRUST_IZZA_FAIL %s: %s", type(e).__name__, e)

    # Fee charge (mint fee only)
    try:
        _pay_asset(creator_sec, DISTR_G, str(total_fee), izza, memo="IZZA NFT FEE")
    except Exception as e:
        abort(400, f"fee_payment_failed: {e}")

    # Backing charge (locked value backing NFTs)
    if total_backing > Decimal("0"):
        try:
            _pay_asset(creator_sec, DISTR_G, str(total_backing), izza, memo="IZZA NFT BACKING")
        except Exception as e:
            abort(400, f"backing_payment_failed: {e}")

    # mint ONE_NFT_UNIT for each code to distributor, and ensure DB rows exist
    iss_kp = Keypair.from_secret(ISSUER_S)
    minted = []
    for i in range(size):
        code = _mint_code_collection(prefix, tag, i + 1) if kind == "collection" else _mint_code_single(prefix, tag)
        asset = Asset(code, iss_kp.public_key)
        try:
            _ensure_distributor_holds_one(asset)
        except Exception as e:
            abort(400, f"mint_trust_failed:{code}:{e}")
        # ensure collection row now to satisfy future assigns + backing + royalties
        try:
            _ensure_collection_row(
                code,
                iss_kp.public_key,
                total_supply=1,
                decimals=0,
                royalty_bp=royalty_bp,
                backing_template_izza=str(backing_per) if backing_per > Decimal("0") else None
            )
        except Exception as e:
            log.warning("NFT_DB_COLLECTION_UPSERT_FAIL code=%s err=%s", code, e)
        minted.append(code)

    return jsonify({
        "ok": True,
        "assets": minted,
        "size": size,
        "total_fee": str(total_fee),
        "backing_per": str(backing_per),
        "backing_total": str(total_backing),
        "royalty_bp": royalty_bp
    })

# ---------- Backing payment XDR ----------
@bp_nft.route("/api/nft/backing/xdr", methods=["POST"])
def backing_xdr():
    """
    Build an IZZA payment XDR for extra NFT backing from buyer → DISTR_G.

    Body:
      {
        "buyer_pub": "G...",
        "extras_izza": { "EGG115FBCG": "0.05", "NFTXYZ": "0.02", ... }
      }

    Returns:
      { ok, xdr, network_passphrase, total }
    """
    j = request.get_json(silent=True) or {}
    buyer_pub = (j.get("buyer_pub") or "").strip()
    extras = j.get("extras_izza") or {}

    if not (buyer_pub and _isG(buyer_pub)):
        abort(400, "buyer_pub_invalid")

    if not isinstance(extras, dict) or not extras:
        abort(400, "no_extras_izza")

    total = Decimal("0")
    for _, v in extras.items():
        try:
            amt = Decimal(str(v).strip() or "0")
        except Exception:
            amt = Decimal("0")
        if amt > 0:
            total += amt

    if total <= Decimal("0"):
        abort(400, "backing_amount_zero")

    # Preflight: buyer must have trust + balance
    if not _buyer_has_izza_and_trust(buyer_pub, total):
        abort(400, "buyer lacks IZZA balance or trustline")

    try:
        acct = server.load_account(buyer_pub)
    except sx.NotFoundError:
        abort(400, "buyer account not found on network")
    except Exception as e:
        abort(500, f"horizon error: {e}")

    izza = Asset(IZZA_CODE, IZZA_ISS)
    amt7 = _q7(total)

    tb = TransactionBuilder(
        source_account=acct,
        network_passphrase=PP,
        base_fee=server.fetch_base_fee()
    ).append_payment_op(
        destination=DISTR_G,
        amount=amt7,
        asset=izza
    )

    memo_txt = "NFT BACKING"
    if len(memo_txt.encode("utf-8")) > 28:
        memo_txt = "BACKING"

    tx = tb.set_timeout(180).add_text_memo(memo_txt).build()

    return jsonify({
        "ok": True,
        "xdr": tx.to_xdr(),
        "network_passphrase": PP,
        "total": amt7
    })

# ---------- Claim ----------
@bp_nft.route("/api/nft/claim", methods=["POST"])
def claim():
    """
    body {
      buyer_pub: "G...", optional if ?u is present with linked wallet
      assets:    ["NFT...", ...], required
      issuer:    ignored, canonical issuer enforced
      pending_id: optional
      extras_izza: { "NFTCODE": "0.05", ... } optional per-code extra backing (IZZA)
    }
    """
    j = request.get_json(silent=True) or {}
    u = _norm_username(request.args.get("u")) or _norm_username(session.get("pi_username"))
    buyer      = (j.get("buyer_pub") or "").strip() or (_active_wallet_pub_for_username(u) or "")
    assets     = list(j.get("assets") or [])
    issuer_g   = CANONICAL_ISSUER_G
    pending_id = j.get("pending_id")

    extras_izza = j.get("extras_izza") or {}
    if not isinstance(extras_izza, dict):
        extras_izza = {}

    _require(buyer and assets, "buyer_and_assets_required")
    if not _isG(buyer): abort(400, "buyer_pub_invalid")

    delivered = 0
    delivered_codes = []

    for code in assets:
        asset = Asset(code, issuer_g)

        if not _account_has_trustline(buyer, asset):
            abort(400, f"buyer_missing_trustline:{code}")

        _ensure_distributor_holds_one(asset)

        # On-chain delivery: send ONE_NFT_UNIT (0.0000001)
        _pay_asset(DISTR_S, buyer, str(ONE_NFT_UNIT), asset, memo="IZZA NFT")
        delivered += 1
        delivered_codes.append(code)

        # Record ownership (ensure collection row, then token with backing)
        try:
            _upsert_collection_and_assign(code=code, issuer=issuer_g, owner_pub=buyer)
        except Exception as e:
            # do not fail claim if DB write has a constraint race
            log.warning("NFT_DB_ASSIGN_FAIL code=%s err=%s", code, e)

        # If buyer supplied extra IZZA backing for this code, add it to backing_izza
        try:
            extra_val = extras_izza.get(code)
            if extra_val is not None:
                _add_backing_for_token(code=code, issuer=issuer_g, extra_str=extra_val)
        except Exception as e:
            log.warning("NFT_BACKING_UPDATE_FAIL code=%s err=%s", code, e)

    # ---------- notify creatures about ownership ----------
    try:
        for code in delivered_codes:
            try:
                requests.post(
                    url=f"{request.url_root.rstrip('/')}/api/creatures/mark-owned",
                    json={"code": code, "owner_pub": buyer},
                    timeout=3
                )
            except Exception:
                pass
    except Exception:
        pass

    # Mark pending claims as claimed
    try:
        with _db() as cx:
            changed = 0
            now = _now_i()
            if pending_id:
                cx.execute(
                    "UPDATE nft_pending_claims SET status='claimed', claimed_at=? WHERE id=?",
                    (now, int(pending_id))
                )
                changed = cx.total_changes
            else:
                # Fallback, mark any pending rows for this buyer that contain any of the delivered asset codes
                for code in delivered_codes:
                    cx.execute("""
                        UPDATE nft_pending_claims
                        SET status='claimed', claimed_at=?
                        WHERE status='pending'
                          AND buyer_pub=?
                          AND (assets_json LIKE ? OR assets_json LIKE ? OR assets_json LIKE ?)
                    """, (
                        now,
                        buyer,
                        f'%"{code}"%',
                        f'%:{code}%',
                        f'%{code}%'
                    ))
                    changed += cx.total_changes
            cx.commit()
            if changed:
                log.info("NFT_PENDING_MARKED_CLAIMED buyer=%s changed=%s", _mask(buyer), changed)
    except Exception as e:
        log.warning("NFT_PENDING_MARK_FAIL buyer=%s err=%s", _mask(buyer), e)

    return jsonify({"ok": True, "delivered": delivered, "buyer_pub": buyer, "assets": delivered_codes})
