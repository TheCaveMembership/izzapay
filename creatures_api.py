import os, json, time, random, sqlite3, math
from decimal import Decimal
from flask import Blueprint, request, jsonify, abort, make_response, url_for, g, session
from stellar_sdk import (
    Asset, Keypair, Claimant, ClaimPredicate, TransactionBuilder
)
from db import conn as _conn

# Shared Horizon helpers
from nft_api import (
    server, PP,
    _account_has_trustline, _change_trust, _pay_asset, _ensure_distributor_holds_one
)

try:
    from wallet_api import get_linked_secret as _get_linked_secret
except Exception:
    _get_linked_secret = lambda _pub: None

bp_creatures = Blueprint("creatures", __name__)

# ---------- config ----------
IZZA_CODE = os.getenv("IZZA_TOKEN_CODE", "IZZA").strip()
IZZA_ISS  = os.getenv("IZZA_TOKEN_ISSUER", "").strip()
CREATURE_ISSUER_G = os.getenv("NFT_ISSUER_PUBLIC", "").strip()
DISTR_S  = os.getenv("NFT_DISTR_SECRET", "").strip()
DISTR_G  = os.getenv("NFT_DISTR_PUBLIC", "").strip()

# ===== REAL LIFECYCLE MODE =====
DAY_SECS          = 86400   # 1 real day

# Egg timings (unchanged)
TEST_CRACK_START  = 30
TEST_HATCH_DONE   = 90

# Growth windows: post-hatch real days
BABY_END          = TEST_HATCH_DONE + (1 * DAY_SECS)
TEEN_END          = TEST_HATCH_DONE + (2 * DAY_SECS)
TICK_STEP_SECONDS = 3

# Hunger growth per “day” by stage
HUNGER_PER_DAY = {
    "egg":       0,
    "cracking":  0,
    "baby":     25,
    "teen":     35,
    "prime":    50,
    "dead":      0,
}

MISSED_DAYS_TO_DIE   = 3
REVIVE_DAYS_REQUIRED = 3

EGG_PRICE_IZZA = Decimal("5")

# ----- collection cap (live supply) -----
CREATURES_CAP = 1000  # IZZA CREATURES V1 circulating cap

# ---------- db helpers ----------
def _db():
    return _conn()

def _now_i() -> int:
    return int(time.time())

def _has_column(cx: sqlite3.Connection, table: str, col: str) -> bool:
    rows = cx.execute(f"PRAGMA table_info({table})").fetchall()
    for r in rows:
        name = r["name"] if isinstance(r, dict) else r[1]
        if name == col:
            return True
    return False

def _ensure_tables():
    with _db() as cx:
        cx.execute("""
        CREATE TABLE IF NOT EXISTS nft_creatures(
          id INTEGER PRIMARY KEY,
          code TEXT NOT NULL,
          issuer TEXT NOT NULL,
          owner_pub TEXT,
          egg_seed TEXT,
          palette TEXT,
          pattern TEXT,
          hatch_start INTEGER,
          last_feed_at INTEGER,
          last_hunger_at INTEGER,
          hunger INTEGER DEFAULT 0,
          stage TEXT,
          meta_version INTEGER DEFAULT 1,
          user_id INTEGER,
          revive_progress INTEGER DEFAULT 0,
          -- NEW: burn bookkeeping
          burned_at INTEGER,
          burn_tx   TEXT,
          UNIQUE(code, issuer)
        )""")
        for colstmt in [
            ("last_hunger_at",  "ALTER TABLE nft_creatures ADD COLUMN last_hunger_at INTEGER"),
            ("revive_progress", "ALTER TABLE nft_creatures ADD COLUMN revive_progress INTEGER DEFAULT 0"),
            ("burned_at",       "ALTER TABLE nft_creatures ADD COLUMN burned_at INTEGER"),
            ("burn_tx",         "ALTER TABLE nft_creatures ADD COLUMN burn_tx TEXT")
        ]:
            col, stmt = colstmt
            if not _has_column(cx, "nft_creatures", col):
                cx.execute(stmt)

        cx.execute("CREATE INDEX IF NOT EXISTS idx_creat_owner ON nft_creatures(owner_pub)")
        cx.execute("CREATE INDEX IF NOT EXISTS idx_creat_stage ON nft_creatures(stage)")
        cx.execute("CREATE INDEX IF NOT EXISTS idx_creat_user  ON nft_creatures(user_id)")
        cx.execute("CREATE INDEX IF NOT EXISTS idx_creat_burn  ON nft_creatures(burned_at)")

        cx.execute("""
        CREATE TABLE IF NOT EXISTS nft_collections(
          id INTEGER PRIMARY KEY,
          code TEXT NOT NULL,
          issuer TEXT NOT NULL,
          total_supply INTEGER,
          decimals INTEGER,
          status TEXT,
          created_at INTEGER,
          updated_at INTEGER,
          UNIQUE(code, issuer)
        )""")

# ---------- username/pub fallback ----------
def _norm_username(u: str | None) -> str | None:
    if not u: return None
    u = str(u).strip().lstrip("@").lower()
    return u or None

def _resolve_username() -> str | None:
    u = _norm_username(request.args.get("u"))
    if u: return u
    u = _norm_username(session.get("pi_username"))
    if u: return u
    uid = session.get("user_id")
    if not uid: return None
    with _db() as cx:
        row = cx.execute("SELECT pi_username FROM users WHERE id=?", (int(uid),)).fetchone()
    return _norm_username(row["pi_username"] if row else None)

def _active_pub_for_request() -> str | None:
    u = _resolve_username()
    if not u: return None
    with _db() as cx:
        row = cx.execute("SELECT pub FROM user_wallets WHERE username=?", (u,)).fetchone()
        return (row["pub"] if row and row["pub"] else None)

# ---------- lifecycle & rarity ----------
def _clamp(v, lo, hi): return max(lo, min(hi, v))

def _stage_from_elapsed(elapsed: int, hunger: int, existing_stage: str | None) -> str:
    if existing_stage == "dead":
        return "dead"
    if elapsed < TEST_CRACK_START: return "egg"
    if elapsed < TEST_HATCH_DONE:  return "cracking"
    if elapsed < BABY_END:         return "baby"
    if elapsed < TEEN_END:         return "teen"
    return "prime"

# Expanded palettes and patterns (surgical add, backwards compatible)
_PALETTES = ["gold","violet","turquoise","rose","lime","sapphire","ember","obsidian","mint",
             "amethyst","citrine","arctic","blaze","void"]
_PATTERNS = ["speckle","stripe","swirl","mosaic","metallic","chevron","grid","starfield"]

def _choose_palette(seed: str):
    s = (seed or "").lower()
    rnd = random.Random(seed)
    palettes = _PALETTES
    hinted = next((p for p in palettes if p in s), None)
    base = hinted or rnd.choice(palettes)
    pats = _PATTERNS
    pat_hint = next((p for p in pats if p in s), None)
    pattern = pat_hint or rnd.choice(pats)
    return base, pattern

def _apply_hunger_progress(row: sqlite3.Row) -> tuple[int, str, int, int, int]:
    now = _now_i()
    hatch_start = int(row["hatch_start"] or now)
    last_feed_at = int(row["last_feed_at"] or hatch_start)
    last_hunger_at = int(row["last_hunger_at"] or hatch_start)
    hunger = int(row["hunger"] or 0)
    stage_current = (row["stage"] or "egg")
    revive_progress = int(row["revive_progress"] or 0)

    elapsed_total = max(0, now - hatch_start)
    stage = _stage_from_elapsed(elapsed_total, hunger, stage_current)

    if stage == "dead":
        return hunger, "dead", last_feed_at, last_hunger_at, revive_progress

    delta = max(0, now - last_hunger_at)
    days = delta / float(DAY_SECS)
    inc = HUNGER_PER_DAY.get(stage, 0) * days
    hunger = _clamp(int(round(hunger + inc)), 0, 100)
    last_hunger_at = now

    missed_secs = max(0, now - last_feed_at)
    if missed_secs >= MISSED_DAYS_TO_DIE * DAY_SECS:
        stage = "dead"

    return hunger, stage, last_feed_at, last_hunger_at, revive_progress

def _persist_progress_if_changed(code: str, hunger: int, stage: str, last_feed_at: int, last_hunger_at: int, revive_progress: int):
    with _db() as cx:
        cx.execute("""UPDATE nft_creatures
                      SET hunger=?, stage=?, last_feed_at=?, last_hunger_at=?, revive_progress=?
                      WHERE code=? AND issuer=?""",
                   (hunger, stage, last_feed_at, last_hunger_at, revive_progress, code, CREATURE_ISSUER_G))
        cx.commit()

# ---------- rarity & combat math ----------
def _rarity_from(code_seed: str, hint: str = "") -> str:
    """
    Current per-mint odds (unchanged):
      legendary 1%
      epic      4%  (cumulative 5%)
      rare      9%  (cumulative 14%)
      uncommon 22%  (cumulative 36%)
      common    64%  (else)
    """
    h = (hint or "").lower()
    if "leg" in h: return "legendary"
    if "ep"  in h: return "epic"
    if "rare" in h: return "rare"
    if "un" in h: return "uncommon"
    if "com" in h: return "common"
    r = random.Random(code_seed + ":rar").random()
    if r < 0.01:  return "legendary"
    if r < 0.05:  return "epic"
    if r < 0.14:  return "rare"
    if r < 0.36:  return "uncommon"
    return "common"

def _stage_multiplier(stage: str) -> float:
    return {
        "egg": 0.2,
        "cracking": 0.3,
        "baby": 0.6,
        "teen": 0.85,
        "prime": 1.0,
        "dead": 0.0
    }.get(stage, 1.0)

def _care_factor(now_i: int, last_feed_at: int) -> float:
    delta = max(0, now_i - int(last_feed_at or now_i))
    days = delta / float(DAY_SECS)
    if days <= 1.0:  return 1.0
    if days <= 2.0:  return 0.8
    return 0.6

def _hunger_mod(hunger: int) -> float:
    return max(0.5, 1.0 - (int(hunger or 0) / 120.0))

def _rarity_bases(rarity: str) -> tuple[int, int]:
    table = {
        "common":    (6,  10),
        "uncommon":  (8,  12),
        "rare":      (10, 14),
        "epic":      (12, 16),
        "legendary": (14, 18),
    }
    return table.get(rarity, (8, 12))

def _rarity_cap_boost(rarity: str) -> int:
    table = {
        "common":    0,
        "uncommon":  4,
        "rare":      8,
        "epic":      12,
        "legendary": 16,
    }
    return table.get(rarity, 0)

def _compute_stats_dict(st_row_like: dict, last_feed_at: int, rarity: str) -> dict:
    code   = st_row_like["code"]
    stage  = st_row_like["stage"]
    hunger = int(st_row_like["hunger"] or 0)
    elapsed = int(st_row_like["elapsed"] or 0)
    now_i = _now_i()

    lo, hi = _rarity_bases(rarity)
    rnd = random.Random(code + ":stats")
    base_atk = rnd.randint(lo, hi)
    base_def = rnd.randint(lo, hi)

    age_days = elapsed / float(DAY_SECS)
    growth = min(age_days / 5.0, 1.0)

    cap_bonus = _rarity_cap_boost(rarity)
    atk_raw_max = base_atk + int(round((base_atk + cap_bonus) * 0.8))
    def_raw_max = base_def + int(round((base_def + cap_bonus) * 0.8))

    atk_grown = base_atk + int(round((atk_raw_max - base_atk) * growth))
    def_grown = base_def + int(round((def_raw_max - base_def) * growth))

    s_mult = _stage_multiplier(stage)
    c_mult = _care_factor(now_i, last_feed_at)
    h_mult = _hunger_mod(hunger)

    atk = int(math.floor(atk_grown * s_mult * c_mult * h_mult))
    dfn = int(math.floor(def_grown * s_mult * c_mult * h_mult))

    atk = int(_clamp(atk, 0, 99))
    dfn = int(_clamp(dfn, 0, 99))
    return {"attack": atk, "defense": dfn}

# ---------- state compute ----------
def _compute_state_dict(code: str) -> dict:
    # Demo egg supports ?skin for the preview
    if code.upper() == "EGGDEMO":
        skin = (request.args.get("skin") or "demo").strip()
        base, pat = _choose_palette(skin)
        rarity = _rarity_from("EGGDEMO", skin)
        st = {
            "code":"EGGDEMO","issuer":CREATURE_ISSUER_G or "GDEMOISS","owner_pub":None,
            "elapsed":0,"tick_seconds":TICK_STEP_SECONDS,"hunger":0,"stage":"egg",
            "palette":base,"pattern":pat,"hatch_start":_now_i(), "rarity": rarity
        }
        stats = _compute_stats_dict(st, last_feed_at=_now_i(), rarity=rarity)
        st.update(stats)
        return st

    _ensure_tables()
    with _db() as cx:
        r = cx.execute("SELECT * FROM nft_creatures WHERE code=? AND issuer=?",
                       (code, CREATURE_ISSUER_G)).fetchone()
    if not r:
        abort(404, "not_found")

    hunger, stage, last_feed_at, last_hunger_at, revive_progress = _apply_hunger_progress(r)
    if (hunger != int(r["hunger"] or 0)) or (stage != (r["stage"] or "")) or (last_hunger_at != int(r["last_hunger_at"] or 0)):
        _persist_progress_if_changed(r["code"], hunger, stage, last_feed_at, last_hunger_at, revive_progress)

    st = {
        "code":r["code"],"issuer":r["issuer"],"owner_pub":r["owner_pub"],
        "elapsed":max(0, _now_i() - int(r["hatch_start"] or _now_i())),
        "tick_seconds":TICK_STEP_SECONDS,"hunger":int(hunger),
        "stage":stage,"palette":r["palette"],"pattern":r["pattern"],
        "hatch_start":int(r["hatch_start"] or _now_i())
    }

    skin_hint = (r["egg_seed"] or "").strip()
    rarity = _rarity_from(st["code"], skin_hint)
    st["rarity"] = rarity

    stats = _compute_stats_dict(st, last_feed_at, rarity)
    st.update(stats)

    return st

def _svg_headers(resp):
    resp.headers["Content-Type"] = "image/svg+xml"
    resp.headers["Cache-Control"] = "no-store, max-age=0"
    resp.headers["X-Content-Type-Options"] = "nosniff"
    return resp

# ---------- helpers for stats and cap ----------
def _current_circulating_supply(cx: sqlite3.Connection) -> int:
    row = cx.execute(
        "SELECT COUNT(1) AS n FROM nft_creatures WHERE issuer=? AND COALESCE(burned_at,0)=0",
        (CREATURE_ISSUER_G,)
    ).fetchone()
    return int(row["n"] if row and "n" in row.keys() else 0)

def _rarity_for_row(row: sqlite3.Row) -> str:
    return _rarity_from(row["code"], (row["egg_seed"] or ""))

# ---------- API (existing endpoints) ----------
@bp_creatures.post("/api/creatures/quote")
def creatures_quote():
    return jsonify({"ok": True, "price_izza": str(EGG_PRICE_IZZA), "tick_seconds": TICK_STEP_SECONDS, "day_seconds": DAY_SECS})

@bp_creatures.post("/api/creatures/mint")
def creatures_mint():
    _ensure_tables()
    j = request.get_json(silent=True) or {}
    buyer_pub = (j.get("buyer_pub") or "").strip()
    buyer_sec = (j.get("buyer_sec") or "").strip()
    client_skin = (j.get("skin") or "").strip()

    if not buyer_pub or not buyer_sec:
        abort(400, "wallet_required")

    # Enforce circulating cap (live supply = unburned)
    with _db() as cx:
        live_supply = _current_circulating_supply(cx)
        if live_supply >= CREATURES_CAP:
            abort(400, "supply_cap_reached")

    izza = Asset(IZZA_CODE, IZZA_ISS)
    try:
        _change_trust(DISTR_S, izza, limit="100000000")
    except Exception:
        pass
    try:
        _pay_asset(buyer_sec, DISTR_G, str(EGG_PRICE_IZZA), izza, memo="IZZA CREATURE EGG")
    except Exception as e:
        abort(400, f"fee_payment_failed:{e}")

    ts = _now_i()
    short = hex(ts)[2:].upper()[-6:]
    suffix = random.choice(list("ABCDEFG"))
    code = f"EGG{short}{suffix}"[:12]

    asset = Asset(code, CREATURE_ISSUER_G)
    try:
        _ensure_distributor_holds_one(asset)
    except Exception as e:
        abort(400, f"mint_failed:{e}")

    seed = client_skin if client_skin else f"{code}:{ts}"
    base, pat = _choose_palette(seed)
    uid = getattr(g, "user_id", None)

    with _db() as cx:
        cx.execute("""
          INSERT INTO nft_creatures(code, issuer, owner_pub, egg_seed, palette, pattern,
                                    hatch_start, last_feed_at, last_hunger_at, hunger, stage, meta_version, user_id, revive_progress, burned_at, burn_tx)
          VALUES(?,?,?,?,?,?, ?,?,?,?,?,1,?, 0, NULL, NULL)
        """, (code, CREATURE_ISSUER_G, None, seed, base, pat, ts, ts, ts, 0, "egg", uid))
        cx.execute("""
          INSERT INTO nft_collections(code, issuer, total_supply, decimals, status, created_at, updated_at)
          VALUES(?,?,?,?, 'draft', ?, ?)
          ON CONFLICT(code, issuer) DO UPDATE SET updated_at=excluded.updated_at
        """, (code, CREATURE_ISSUER_G, 1, 0, ts, ts))
        cx.commit()

    return jsonify({"ok": True, "asset": {"code": code, "issuer": CREATURE_ISSUER_G}, "hatch_start": ts})

@bp_creatures.get("/api/creatures/latest")
def creatures_latest():
    _ensure_tables()
    uid = getattr(g, "user_id", None)
    with _db() as cx:
        r = cx.execute("""
          SELECT code, issuer, owner_pub, stage, palette, pattern, hatch_start
          FROM nft_creatures
          WHERE (? IS NULL) OR user_id IS NULL OR user_id=?
          ORDER BY id DESC LIMIT 1
        """, (uid, uid)).fetchone()
    return jsonify({"latest": dict(r) if r else None})

@bp_creatures.get("/api/creatures/mine")
def creatures_mine():
    _ensure_tables()
    uid = getattr(g, "user_id", None)
    with _db() as cx:
        if uid is not None:
            rows = cx.execute("""
              SELECT code, issuer, owner_pub, stage, palette, pattern, hatch_start
              FROM nft_creatures
              WHERE (burned_at IS NULL) AND (
                user_id=? OR (user_id IS NULL AND owner_pub IS NOT NULL AND owner_pub IN (
                  SELECT pub FROM user_wallets WHERE username IN (
                    SELECT pi_username FROM users WHERE id=?
                  )
                ))
              )
              ORDER BY id DESC LIMIT 200
            """, (uid, uid)).fetchall()
        else:
            active_pub = _active_pub_for_request()
            if active_pub:
                rows = cx.execute("""
                  SELECT code, issuer, owner_pub, stage, palette, pattern, hatch_start
                  FROM nft_creatures
                  WHERE owner_pub=? AND burned_at IS NULL
                  ORDER BY id DESC LIMIT 200
                """, (active_pub,)).fetchall()
            else:
                rows = []
    return jsonify({"items": [dict(r) for r in rows]})

@bp_creatures.post("/api/creatures/mark-owned")
def creatures_mark_owned():
    j = request.get_json(silent=True) or {}
    code = (j.get("code") or "").strip()
    owner = (j.get("owner_pub") or "").strip()
    if not code or not owner:
        abort(400, "code_and_owner_required")
    _ensure_tables()
    with _db() as cx:
        cx.execute(
            "UPDATE nft_creatures SET owner_pub=?, user_id=COALESCE(user_id, ?) WHERE code=? AND issuer=?",
            (owner, getattr(g, "user_id", None), code, CREATURE_ISSUER_G)
        )
        cx.commit()
    return jsonify({"ok": True})

@bp_creatures.post("/api/creatures/auto-claim")
def creatures_auto_claim():
    j = request.get_json(silent=True) or {}
    code = (j.get("code") or "").strip().upper()
    owner_pub = (j.get("owner_pub") or "").strip().upper()
    if not code or not owner_pub:
        abort(400, "missing code/owner_pub")

    _ensure_tables()
    with _db() as cx:
        row = cx.execute(
            "SELECT owner_pub FROM nft_creatures WHERE code=? AND issuer=?",
            (code, CREATURE_ISSUER_G)
        ).fetchone()
    if not row:
        abort(404, "unknown_code")
    if row["owner_pub"]:
        return jsonify({"ok": True, "code": code, "note": "already owned"})

    asset = Asset(code, CREATURE_ISSUER_G)
    delivered = False
    try:
        owner_sec = _get_linked_secret(owner_pub)
    except Exception:
        owner_sec = None

    if owner_sec:
        try:
            if not _account_has_trustline(owner_pub, asset):
                _change_trust(owner_sec, asset, limit="1")
            _pay_asset(DISTR_S, owner_pub, "1", asset, memo=f"IZZA CREATURE {code}")
            delivered = True
        except Exception:
            delivered = False

    tx_hash = None
    if not delivered:
        base_fee = server.fetch_base_fee()
        dist_acct = server.load_account(DISTR_G)
        claimant = Claimant(destination=owner_pub, predicate=ClaimPredicate.predicate_unconditional())
        tx = (
            TransactionBuilder(
                source_account=dist_acct,
                network_passphrase=PP,
                base_fee=base_fee,
            )
            .append_create_claimable_balance_op(asset=asset, amount="1", claimants=[claimant])
            .set_timeout(120)
            .build()
        )
        tx.sign(Keypair.from_secret(DISTR_S))
        resp = server.submit_transaction(tx)
        tx_hash = resp.get("hash")

    with _db() as cx:
        cx.execute(
            "UPDATE nft_creatures SET owner_pub=?, user_id=COALESCE(user_id, ?) WHERE code=? AND issuer=?",
            (owner_pub, getattr(g, "user_id", None), code, CREATURE_ISSUER_G)
        )
        cx.commit()

    if delivered:
        return jsonify({"ok": True, "code": code, "delivered": True})
    return jsonify({"ok": True, "code": code, "hash": tx_hash, "note": "claim_created"})

@bp_creatures.post("/api/creatures/feed")
def creatures_feed():
    j = request.get_json(silent=True) or {}
    code = (j.get("code") or "").strip()
    owner = (j.get("owner_pub") or "").strip()
    if not code or not owner:
        abort(400, "code_and_owner_required")
    _ensure_tables()
    now = _now_i()

    with _db() as cx:
        row = cx.execute(
            "SELECT hunger, stage, last_feed_at, last_hunger_at, revive_progress, hatch_start, burned_at FROM nft_creatures WHERE code=? AND issuer=?",
            (code, CREATURE_ISSUER_G)
        ).fetchone()
        if not row:
            abort(404, "not_found")
        if int(row["burned_at"] or 0) > 0:
            return jsonify({"ok": False, "error": "burned"})

        hunger, stage, last_feed_at, last_hunger_at, revive_progress = _apply_hunger_progress(row)

        last_feed = int(last_feed_at or row["hatch_start"] or now)
        days_since_last = (now - last_feed) / float(DAY_SECS)
        if days_since_last < 1.0:
            return jsonify({"ok": True, "hunger": hunger, "stage": stage, "note": "already_fed_today"})

        if stage == "dead":
            revive_progress += 1
            last_feed_at = now
            if revive_progress >= REVIVE_DAYS_REQUIRED:
                stage = "baby"
                hunger = 50
                revive_progress = 0
                last_feed_at = now
                last_hunger_at = now
        else:
            hunger = _clamp(hunger - 50, 0, 100)
            last_feed_at = now
            last_hunger_at = now

        cx.execute(
            "UPDATE nft_creatures SET hunger=?, stage=?, last_feed_at=?, last_hunger_at=?, revive_progress=? WHERE code=? AND issuer=?",
            (hunger, stage, last_feed_at, last_hunger_at, revive_progress, code, CREATURE_ISSUER_G)
        )
        cx.commit()

    return jsonify({"ok": True, "hunger": hunger, "stage": stage})

# ---------- NEW: burn ----------
@bp_creatures.post("/api/creatures/burn")
def creatures_burn():
    """
    Burns a creature by transferring the 1-unit NFT back to the distributor account,
    then marking the row as burned (timestamp + tx hash). We require that the caller
    is the current owner. Secret can come either from the request (owner_sec) or
    from wallet_api linkage.
    """
    j = request.get_json(silent=True) or {}
    code = (j.get("code") or "").strip().upper()
    owner_pub = (j.get("owner_pub") or "").strip().upper()
    owner_sec = (j.get("owner_sec") or "").strip()

    if not code or not owner_pub:
        abort(400, "code_and_owner_required")

    _ensure_tables()

    with _db() as cx:
        row = cx.execute(
            "SELECT owner_pub, burned_at FROM nft_creatures WHERE code=? AND issuer=?",
            (code, CREATURE_ISSUER_G)
        ).fetchone()
        if not row:
            abort(404, "not_found")
        if int(row["burned_at"] or 0) > 0:
            return jsonify({"ok": True, "note": "already_burned"})
        if (row["owner_pub"] or "").upper() != owner_pub:
            abort(403, "not_owner")

    # get secret if not provided
    if not owner_sec:
        try:
            owner_sec = _get_linked_secret(owner_pub) or ""
        except Exception:
            owner_sec = ""
    if not owner_sec:
        abort(400, "owner_secret_required")

    asset = Asset(code, CREATURE_ISSUER_G)

    # ensure trustline exists (owner should already have it)
    try:
        if not _account_has_trustline(owner_pub, asset):
            _change_trust(owner_sec, asset, limit="1")
    except Exception:
        # trustline missing and cannot add => cannot burn
        abort(400, "trustline_missing")

    # transfer back to distributor with a burn memo
    try:
        tx_resp = _pay_asset(owner_sec, DISTR_G, "1", asset, memo=f"BURN {code}")
        burn_tx = getattr(tx_resp, "get", lambda k, d=None: None)("hash") if isinstance(tx_resp, dict) else None
    except Exception as e:
        abort(400, f"burn_failed:{e}")

    with _db() as cx:
        cx.execute(
            "UPDATE nft_creatures SET burned_at=?, burn_tx=?, owner_pub=NULL, stage='dead' WHERE code=? AND issuer=?",
            (_now_i(), burn_tx, code, CREATURE_ISSUER_G)
        )
        cx.commit()

    return jsonify({"ok": True, "code": code, "burned": True, "tx": burn_tx})

# ---------- NEW: collection stats ----------
@bp_creatures.get("/api/creatures/collection-stats")
def creatures_collection_stats():
    """
    Returns:
      cap, minted_total, burned_total, circulating, remaining,
      rarity_counts (total minted by rarity), rarity_alive (unburned by rarity)
    """
    _ensure_tables()
    with _db() as cx:
        rows = cx.execute(
            "SELECT code, egg_seed, burned_at FROM nft_creatures WHERE issuer=?",
            (CREATURE_ISSUER_G,)
        ).fetchall()

    minted_total = len(rows)
    burned_total = sum(1 for r in rows if int(r["burned_at"] or 0) > 0)
    circulating = minted_total - burned_total
    remaining = max(0, CREATURES_CAP - circulating)

    rarity_counts = {"common":0,"uncommon":0,"rare":0,"epic":0,"legendary":0}
    rarity_alive  = {"common":0,"uncommon":0,"rare":0,"epic":0,"legendary":0}

    for r in rows:
        rar = _rarity_from(r["code"], r["egg_seed"] or "")
        if rar not in rarity_counts: rarity_counts[rar] = 0
        rarity_counts[rar] += 1
        if int(r["burned_at"] or 0) == 0:
            if rar not in rarity_alive: rarity_alive[rar] = 0
            rarity_alive[rar] += 1

    return jsonify({
        "ok": True,
        "cap": CREATURES_CAP,
        "minted_total": minted_total,
        "burned_total": burned_total,
        "circulating": circulating,
        "remaining": remaining,
        "rarity_counts": rarity_counts,
        "rarity_alive": rarity_alive
    })

# ---------- NEW: army stats ----------
@bp_creatures.get("/api/creatures/army-stats")
def creatures_army_stats():
    """
    Sums current ATK/DEF over all un-burned creatures owned by the active wallet
    (or by ?owner_pub=). Uses the same state math as SVG/state endpoints so it
    reflects live hunger/age effects.
    """
    _ensure_tables()
    owner_pub = (request.args.get("owner_pub") or "").strip() or _active_pub_for_request()
    if not owner_pub:
        return jsonify({"ok": False, "error": "no_active_wallet"})

    with _db() as cx:
        rows = cx.execute(
            "SELECT * FROM nft_creatures WHERE owner_pub=? AND issuer=? AND burned_at IS NULL",
            (owner_pub, CREATURE_ISSUER_G)
        ).fetchall()

    total_atk = 0
    total_def = 0
    count = 0
    for r in rows:
        hunger, stage, last_feed_at, last_hunger_at, revive_progress = _apply_hunger_progress(r)
        st = {
            "code": r["code"],
            "stage": stage,
            "hunger": hunger,
            "elapsed": max(0, _now_i() - int(r["hatch_start"] or _now_i()))
        }
        rarity = _rarity_from(r["code"], r["egg_seed"] or "")
        stats = _compute_stats_dict(st, last_feed_at, rarity)
        total_atk += int(stats.get("attack", 0))
        total_def += int(stats.get("defense", 0))
        count += 1

    return jsonify({"ok": True, "owner_pub": owner_pub, "count": count, "attack": total_atk, "defense": total_def})

@bp_creatures.get("/api/creatures/state/<code>.json")
def creatures_state(code):
    st = _compute_state_dict(code)
    resp = make_response(json.dumps(st), 200)
    resp.headers["Content-Type"] = "application/json; charset=utf-8"
    resp.headers["Cache-Control"] = "no-store"
    return resp

@bp_creatures.get("/nftmeta/<code>.json")
def creatures_metadata(code):
    img_url = url_for("creatures.creature_svg", code=code, _external=True) + f"?nc={_now_i()}"
    ext_url = url_for("creatures.habitat_page", code=code, _external=True)
    meta = {
        "name": f"IZZA Creature {code}",
        "description": "A living IZZA CREATURE that hatches, grows, and battles.",
        "image": img_url,
        "external_url": ext_url,
        "attributes": [
            {"trait_type": "Collection", "value": "IZZA CREATURES"},
            {"trait_type": "Stage", "value": "dynamic"},
            {"trait_type": "Palette", "value": "dynamic"},
        ],
    }
    resp = make_response(json.dumps(meta), 200)
    resp.headers["Content-Type"] = "application/json; charset=utf-8"
    resp.headers["Cache-Control"] = "no-store"
    return resp

@bp_creatures.get("/nftsvg/<code>.svg")
def creature_svg(code):
    st = _compute_state_dict(code)
    stage   = st["stage"]
    hunger  = int(st["hunger"])
    base    = st["palette"]
    pattern = st["pattern"] or "speckle"
    elapsed = int(st["elapsed"])
    rarity  = st.get("rarity", "common")

    skin_hint = (request.args.get("skin") or "") if str(code).upper() == "EGGDEMO" else ""

    # colors (add mappings for new palettes with sensible fallbacks)
    bg = {
        "gold":"#130e00","violet":"#0e061a","turquoise":"#02151a","rose":"#1a0710","lime":"#0c1a06",
        "sapphire":"#06101e","ember":"#1a0b06","obsidian":"#0b0b10","mint":"#04130d",
        "amethyst":"#11081c","citrine":"#1c1305","arctic":"#051018","blaze":"#190803","void":"#050509"
    }.get(base, "#0b0b10")
    glow = {
        "gold":"#ffcd60","violet":"#b784ff","turquoise":"#48d4ff","rose":"#ff7aa2","lime":"#89ff7a",
        "sapphire":"#5aa8ff","ember":"#ff8a4d","obsidian":"#8a96a8","mint":"#7affc9",
        "amethyst":"#c19bff","citrine":"#ffd86b","arctic":"#7fe9ff","blaze":"#ff6a3a","void":"#c0c4d8"
    }.get(base, "#b784ff")
    body = {
        "gold":"#ffe39a","violet":"#d7c0ff","turquoise":"#7fe6ff","rose":"#ffb6c8","lime":"#b4ffaf",
        "sapphire":"#b9d9ff","ember":"#ffd2b8","obsidian":"#cfd6e4","mint":"#c5ffeb",
        "amethyst":"#e5d4ff","citrine":"#ffe9a8","arctic":"#c9f2ff","blaze":"#ffd0bd","void":"#e2e6f4"
    }.get(base, "#e8f1ff")

    def _pattern_contrast(b):
        return {
            "gold":"#48d4ff", "violet":"#89ff7a", "turquoise":"#ff7aa2", "rose":"#48d4ff", "lime":"#b784ff",
            "sapphire":"#ffcd60", "ember":"#48d4ff", "obsidian":"#7affc9", "mint":"#b784ff",
            "amethyst":"#7fe6ff","citrine":"#7aa2ff","arctic":"#ff9fd0","blaze":"#7fe6ff","void":"#7affc9"
        }.get(b, "#e8f1ff")
    pcol = _pattern_contrast(base)

    # scale by stage
    if stage == "egg":       egg_scale = "1.0"
    elif stage == "cracking": egg_scale = "1.02"
    elif stage == "baby":     egg_scale = "0.9"
    elif stage == "teen":     egg_scale = "1.0"
    elif stage == "prime":    egg_scale = "1.06"
    else:                     egg_scale = "1.0"

    # overall enlargement
    creature_zoom = 1.18
    overall_scale = f"{float(egg_scale) * creature_zoom:.3f}"

    # cosmetics
    rnd = random.Random(st["code"])
    crown  = (rnd.randint(1,3) == 1)
    flames = (rnd.randint(1,4) == 1)
    lasers = (rnd.randint(1,5) == 1)

    # pattern svg
    pattern_svg = ""
    if pattern == "speckle":
        dots = []
        rnd2 = random.Random(st["code"] + ":p0")
        for _ in range(24):
            x = rnd2.randint(-60, 60); y = rnd2.randint(-40, 40); r = rnd2.randint(2,5)
            dots.append(f'<circle cx="{x}" cy="{y}" r="{r}" fill="{pcol}" opacity=".25"/>')
        pattern_svg = "\n".join(dots)
    elif pattern == "stripe":
        pattern_svg = '<g opacity=".25" stroke="{0}" stroke-width="6">'.format(pcol) + \
                      ''.join([f'<line x1="{x}" y1="-60" x2="{x+40}" y2="60"/>' for x in range(-70,60,14)]) + '</g>'
    elif pattern == "swirl":
        pattern_svg = f'<path d="M-60,0 C-20,-40,20,-40,60,0 C20,40,-20,40,-60,0" fill="none" stroke="{pcol}" stroke-width="6" opacity=".25"/>'
    elif pattern == "mosaic":
        tiles = []
        rnd3 = random.Random(st["code"] + ":p1")
        for _ in range(20):
            x = rnd3.randint(-70, 50); y = rnd3.randint(-40, 30); w = rnd3.randint(8,16); h = rnd3.randint(8,14)
            tiles.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="{pcol}" opacity=".18"/>')
        pattern_svg = "\n".join(tiles)
    elif pattern == "metallic":
        pattern_svg = '<ellipse rx="95" ry="70" fill="url(#metal)"/>'
    elif pattern == "chevron":
        pattern_svg = f'<g opacity=".22" stroke="{pcol}" stroke-width="5">' + ''.join(
            [f'<path d="M-70,{y} L0,{y-10} L70,{y}" fill="none"/>' for y in range(-40,50,14)]
        ) + '</g>'
    elif pattern == "grid":
        pattern_svg = f'<g opacity=".18" stroke="{pcol}" stroke-width="3">' + ''.join(
            [f'<line x1="-80" y1="{y}" x2="80" y2="{y}"/>' for y in range(-50,60,12)]
        ) + ''.join(
            [f'<line x1="{x}" y1="-50" x2="{x}" y2="60"/>' for x in range(-70,80,12)]
        ) + '</g>'
    elif pattern == "starfield":
        rnds = random.Random(st["code"] + ":pS")
        stars = []
        for _ in range(26):
            x = rnds.randint(-80, 80); y = rnds.randint(-60, 60); r = rnds.choice([1,2,3])
            stars.append(f'<circle cx="{x}" cy="{y}" r="{r}" fill="{pcol}" opacity=".28"/>')
        pattern_svg = ''.join(stars)

    # mouth selection
    mr = random.Random(st["code"] + ":mouth").random()
    mouth_type = "smile"
    if mr < 0.01:
        mouth_type = "pipe"
    elif mr < 0.06:
        mouth_type = "tongue"
    elif mr < 0.13:
        mouth_type = "squiggle"

    if mouth_type == "smile":
        mouth_svg = '<path d="M-18,10 Q0,22 18,10" stroke="#180d00" stroke-width="4" fill="none"/>'
    elif mouth_type == "tongue":
        mouth_svg = (
          '<path d="M-20,6 Q0,12 20,6" stroke="#180d00" stroke-width="4" fill="none"/>'
          '<path d="M-8,6 Q0,28 8,6 Q0,18 -8,6" fill="#ff5577" opacity=".95"/>'
          '<path d="M-4,16 Q0,20 4,16" stroke="#ff7890" stroke-width="2" fill="none" opacity=".9"/>'
        )
    elif mouth_type == "squiggle":
        mouth_svg = '<path d="M-18,10 Q-9,18 0,10 Q9,2 18,10" stroke="#180d00" stroke-width="4" fill="none"/>'
    else:  # pipe
        mouth_svg = (
          '<path d="M-10,10 Q0,18 10,10" stroke="#180d00" stroke-width="4" fill="none"/>'
          '<g transform="translate(14,8)">'
          '  <rect x="6" y="-2" width="18" height="10" rx="3" fill="#6b4b2a" stroke="#2a1a0a" stroke-width="2"/>'
          '  <rect x="0" y="-1" width="10" height="6" rx="2" fill="#875b31" stroke="#2a1a0a" stroke-width="2"/>'
          '  <g opacity=".85">'
          '    <path id="smokePath" d="M24,2 C32,-6 36,-24 30,-40" fill="none" stroke="#d5d5d5" stroke-width="2" opacity="0.0"/>'
          '    <circle r="3" fill="#eaeaea">'
          '      <animateMotion dur="2.6s" repeatCount="indefinite" keyPoints="0;1" keyTimes="0;1">'
          '        <mpath xlink:href="#smokePath"/>'
          '      </animateMotion>'
          '      <animate attributeName="opacity" values="0;1;0" dur="2.6s" repeatCount="indefinite"/>'
          '    </circle>'
          '    <circle r="4" fill="#f2f2f2" opacity="0.6">'
          '      <animateMotion dur="3.2s" repeatCount="indefinite">'
          '        <mpath xlink:href="#smokePath"/>'
          '      </animateMotion>'
          '      <animate attributeName="opacity" values="0;1;0" dur="3.2s" repeatCount="indefinite"/>'
          '    </circle>'
          '    <circle r="2.5" fill="#ffffff" opacity="0.5">'
          '      <animateMotion dur="2.2s" repeatCount="indefinite">'
          '        <mpath xlink:href="#smokePath"/>'
          '      </animateMotion>'
          '      <animateTransform attributeName="transform" type="rotate" from="-10 0 0" to="10 0 0" dur="2.2s" repeatCount="indefinite"/>'
          '      <animate attributeName="opacity" values="0;1;0" dur="2.2s" repeatCount="indefinite"/>'
          '    </circle>'
          '  </g>'
          '</g>'
        )

    arms_svg = ''
    feet_svg = ''
    if stage in ('teen','prime'):
      arms_svg = (
        f'<circle cx="-72" cy="0" r="14" fill="{body}" stroke="#000" stroke-opacity=".25" stroke-width="3" />'
        f'<circle cx="72" cy="0" r="14" fill="{body}" stroke="#000" stroke-opacity=".25" stroke-width="3" />'
      )
    if stage == 'prime':
      feet_svg = (
        f'<circle cx="-36" cy="58" r="12" fill="{body}" stroke="#000" stroke-opacity=".25" stroke-width="3" />'
        f'<circle cx="36" cy="58" r="12" fill="{body}" stroke="#000" stroke-opacity=".25" stroke-width="3" />'
      )

    crown_svg = ''
    if crown and stage in ('baby','teen','prime'):
        crown_svg = f'''
          <g transform="translate(0,-110)">
            <polygon points="-28,0 0,-20 28,0 18,0 0,-10 -18,0" fill="{glow}" stroke="#000" stroke-width="3"/>
          </g>'''

        # --- FLAMES: keep base glow centered, shift & slightly shrink tongues ---
    flames_svg = ''
    if flames and stage in ('teen','prime'):
        flames_svg = f'''
          <g opacity=".95" transform="translate(0,10)">
            <!-- defs for flame gradient and fade-up mask -->
            <defs>
              <linearGradient id="flameGrad" x1="0" y1="1" x2="0" y2="0">
                <stop offset="0"   stop-color="{bg}"    stop-opacity="0"/>
                <stop offset="0.15" stop-color="{glow}"  stop-opacity="0.35"/>
                <stop offset="0.45" stop-color="{glow}"  stop-opacity="0.75"/>
                <stop offset="0.8"  stop-color="#ffffff" stop-opacity="0.95"/>
                <stop offset="1"    stop-color="#ffffff" stop-opacity="1"/>
              </linearGradient>
              <linearGradient id="fadeUp" x1="0" y1="1" x2="0" y2="0">
                <stop offset="0"   stop-color="#000"/>
                <stop offset="0.25" stop-color="#555"/>
                <stop offset="0.4" stop-color="#aaa"/>
                <stop offset="0.55" stop-color="#fff"/>
                <stop offset="1"   stop-color="#fff"/>
              </linearGradient>
              <mask id="flameFade">
                <rect x="-256" y="-256" width="512" height="512" fill="url(#fadeUp)"/>
              </mask>
              <filter id="flameBlur"><feGaussianBlur stdDeviation="1.6"/></filter>
            </defs>

            <!-- base soft glow: stays centered under the body -->
            <ellipse cx="0" cy="82" rx="96" ry="28" fill="{glow}" opacity=".22" filter="url(#flameBlur)"/>

            <!-- tongues + sparks: shifted left and slightly scaled down -->
            <g transform="translate(-22,0) scale(0.9)">
              <!-- layered tongues -->
              <g mask="url(#flameFade)">
                <path id="tongue1"
                  d="M-88,82 C-70,64 -52,38 -30,12 C-12,34 2,54 10,74 C26,50 46,22 70,-4 C90,26 104,54 110,82 Z"
                  fill="url(#flameGrad)" opacity=".75" filter="url(#flameBlur)">
                  <animate attributeName="d" dur="1.8s" repeatCount="indefinite"
                    values="
                      M-88,82 C-70,64 -52,38 -30,12 C-12,34 2,54 10,74 C26,50 46,22 70,-4 C90,26 104,54 110,82 Z;
                      M-88,82 C-72,60 -56,36 -30,10 C-8,30 4,56 14,76 C28,48 48,18 72,-6 C90,20 104,52 110,82 Z;
                      M-88,82 C-70,64 -52,38 -30,12 C-12,34 2,54 10,74 C26,50 46,22 70,-4 C90,26 104,54 110,82 Z" />
                </path>

                <path id="tongue2"
                  d="M-70,82 C-50,58 -36,30 -12,6 C6,26 16,50 22,72 C34,48 54,20 80,-8 C98,20 108,54 116,82 Z"
                  fill="url(#flameGrad)" opacity=".55" filter="url(#flameBlur)">
                  <animate attributeName="d" dur="1.6s" repeatCount="indefinite"
                    values="
                      M-70,82 C-50,58 -36,30 -12,6 C6,26 16,50 22,72 C34,48 54,20 80,-8 C98,20 108,54 116,82 Z;
                      M-70,82 C-52,56 -40,28 -10,4 C10,24 20,48 26,70 C36,46 58,18 82,-10 C98,18 110,52 116,82 Z;
                      M-70,82 C-50,58 -36,30 -12,6 C6,26 16,50 22,72 C34,48 54,20 80,-8 C98,20 108,54 116,82 Z" />
                </path>

                <path id="tongue3"
                  d="M-54,82 C-38,60 -22,34 0,10 C16,32 24,54 30,74 C42,50 62,24 86,-2 C104,22 114,54 122,82 Z"
                  fill="url(#flameGrad)" opacity=".45" filter="url(#flameBlur)">
                  <animate attributeName="d" dur="1.9s" repeatCount="indefinite"
                    values="
                      M-54,82 C-38,60 -22,34 0,10 C16,32 24,54 30,74 C42,50 62,24 86,-2 C104,22 114,54 122,82 Z;
                      M-54,82 C-40,58 -26,32 2,8 C18,30 26,52 32,72 C46,48 66,22 88,-6 C104,20 116,52 122,82 Z;
                      M-54,82 C-38,60 -22,34 0,10 C16,32 24,54 30,74 C42,50 62,24 86,-2 C104,22 114,54 122,82 Z" />
                </path>
              </g>

              <!-- rising sparks -->
              <g opacity=".9">
                <circle r="2.4" fill="#ffffff">
                  <animateMotion dur="1.2s" repeatCount="indefinite" path="M-40,80 C-36,40 -18,10 -4,-40"/>
                  <animate attributeName="opacity" values="0;1;0" dur="1.2s" repeatCount="indefinite"/>
                </circle>
                <circle r="2.0" fill="#ffffff">
                  <animateMotion dur="1.5s" repeatCount="indefinite" path="M0,82 C4,46 10,18 12,-36"/>
                  <animate attributeName="opacity" values="0;1;0" dur="1.5s" repeatCount="indefinite"/>
                </circle>
                <circle r="1.8" fill="#ffffff">
                  <animateMotion dur="1.1s" repeatCount="indefinite" path="M34,78 C28,42 18,12 6,-38"/>
                  <animate attributeName="opacity" values="0;1;0" dur="1.1s" repeatCount="indefinite"/>
                </circle>
                <circle r="1.6" fill="#ffffff">
                  <animateMotion dur="1.35s" repeatCount="indefinite" path="M-12,80 C-8,48 -2,20 4,-32"/>
                  <animate attributeName="opacity" values="0;1;0" dur="1.35s" repeatCount="indefinite"/>
                </circle>
              </g>
            </g>
          </g>'''
    lasers_svg = ''
    if lasers and stage in ('teen','prime'):
        lasers_svg = f'''
          <g stroke="#ff3355" stroke-width="5" opacity=".9">
            <line x1="-18" y1="-8" x2="-180" y2="-120">
              <animate attributeName="opacity" values="0.2;1;0.2" dur="0.8s" repeatCount="indefinite"/>
            </line>
            <line x1="18" y1="-8" x2="180" y2="-120">
              <animate attributeName="opacity" values="0.2;1;0.2" dur="0.8s" repeatCount="indefinite"/>
            </line>
          </g>'''

    # rarity layers
    shine_defs = f'''
      <symbol id="twinkle">
        <polygon points="0,-3 1.2,-1.2 3,0 1.2,1.2 0,3 -1.2,1.2 -3,0 -1.2,-1.2" />
      </symbol>
      <filter id="twkGlow"><feGaussianBlur stdDeviation="1.2"/><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      <radialGradient id="aurora" cx="50%" cy="50%" r="70%">
        <stop offset="0" stop-color="{glow}" stop-opacity=".5"/>
        <stop offset="1" stop-color="{bg}" stop-opacity="0"/>
      </radialGradient>
      <filter id="haloBlur"><feGaussianBlur stdDeviation="4"/></filter>

      <filter id="boltGlow"><feGaussianBlur stdDeviation="2"/></filter>
      <linearGradient id="boltGrad" x1="0" x2="1" y1="0" y2="0">
        <stop offset="0" stop-color="{glow}" stop-opacity="0.0"/>
        <stop offset="0.25" stop-color="{glow}" stop-opacity="0.9"/>
        <stop offset="0.75" stop-color="#ffffff" stop-opacity="1"/>
        <stop offset="1" stop-color="{glow}" stop-opacity="0.0"/>
      </linearGradient>
      <path id="boltShape" d="M0,-150 L-10,-120 L10,-120 L-8,-90 L15,-90 L-5,-55 L12,-55 L-12,-10 L8,-10"
            fill="none" stroke="url(#boltGrad)" stroke-width="6" stroke-linejoin="round" stroke-linecap="round"/>
    '''

    twinkles = ''
    if rarity in ('uncommon','rare','epic','legendary'):
        t = []
        rndt = random.Random(st["code"] + ":twk")
        base_n = 14 if rarity == 'uncommon' else 22 if rarity == 'rare' else 32 if rarity == 'epic' else 44
        for i in range(base_n):
            x = rndt.randint(-90, 90); y = rndt.randint(-70, 70)
            dur = 0.7 + (i % 6) * 0.16
            scale = 1.1 + (i % 4) * 0.3
            t.append(f'''
              <g transform="translate({x},{y}) scale({scale})">
                <use href="#twinkle" fill="#fff" opacity="0.9" filter="url(#twkGlow)">
                  <animate attributeName="opacity" values="0;1;0" dur="{dur}s" repeatCount="indefinite" />
                </use>
              </g>''')
        twinkles = ''.join(t)

    orbit_svg = ''
    if rarity in ('rare','epic','legendary'):
        orbit_svg = f'''
          <g opacity=".5">
            <circle r="130" fill="none" stroke="{glow}" stroke-width="2" opacity=".35"/>
            <g>
              <use href="#twinkle" fill="{glow}">
                <animateTransform attributeName="transform" attributeType="XML" type="rotate"
                  from="0 0 0" to="360 0 0" dur="5.2s" repeatCount="indefinite"/>
              </use>
            </g>
          </g>'''

    halo_svg = ''
    if rarity in ('epic','legendary'):
        halo_svg = f'''
          <g opacity="0.98">
            <circle r="120" fill="none" stroke="{glow}" stroke-width="7" filter="url(#haloBlur)"/>
            <circle r="120" fill="none" stroke="#ffffff" stroke-opacity=".5" stroke-width="2"/>
            <path d="M-130,0 Q0,-32 130,0" fill="none" stroke="{glow}" stroke-width="3" opacity=".95">
              <animate attributeName="opacity" values=".4;1;.4" dur="1.6s" repeatCount="indefinite"/>
            </path>
          </g>'''

    aurora_svg = ''
    if rarity in ('epic','legendary'):
        aurora_svg = f'<ellipse rx="190" ry="130" fill="url(#aurora)" opacity=".55" filter="url(#soft)"/>'

    bolt_svg = ''
    if rarity in ('legendary',):
        bolt_svg = f'''
          <g opacity="0.95">
            <use href="#boltShape" filter="url(#boltGlow)">
              <animateTransform attributeName="transform" attributeType="XML" type="rotate"
                from="0 0 0" to="360 0 0" dur="5.5s" repeatCount="indefinite"/>
            </use>
          </g>'''

    show_hunger = (stage in ('baby','teen','prime'))

    hide_bg = (str(code).upper() == "EGGDEMO") and (str(request.args.get("nobg", "")).lower() not in ("", "0", "false", "no"))
    bg_rect = "" if hide_bg else f'<rect width="512" height="512" fill="{bg}"/>'
    glow_circ = "" if hide_bg else f'<circle cx="256" cy="360" r="170" fill="url(#g0)" opacity=".18" filter="url(#soft)"/>'
    status_block = "" if hide_bg else f'''
  <g font-family="ui-monospace, Menlo, monospace" font-size="14" fill="#fff" opacity=".95">
    <text x="16" y="28">Stage: {stage} • Rarity: {rarity}</text>
    <text x="16" y="48" opacity="{ '1' if show_hunger else '0'}">Hunger: {hunger}%</text>
    <text x="16" y="68">ATK {st.get('attack',0)}  DEF {st.get('defense',0)}  •  1d={DAY_SECS}s</text>
  </g>'''

    rarity_layer_for_egg = ''
    if stage in ('egg','cracking'):
        rarity_layer_for_egg = f'''
          {twinkles}
          {orbit_svg}
          {halo_svg}
          {aurora_svg}
          {bolt_svg}
        '''

    svg = f"""<svg viewBox="0 0 512 512"
  xmlns="http://www.w3.org/2000/svg"
  xmlns:xlink="http://www.w3.org/1999/xlink" width="512" height="512">
  <defs>
    <radialGradient id="g0"><stop offset="0" stop-color="{glow}"/><stop offset="1" stop-color="{bg}"/></radialGradient>
    <linearGradient id="egg"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="{glow}"/></linearGradient>
    <linearGradient id="metal"><stop offset="0" stop-color="#fff" stop-opacity=".8"/><stop offset="1" stop-color="{body}" stop-opacity=".9"/></linearGradient>
    <filter id="soft"><feGaussianBlur stdDeviation="6"/></filter>
    {shine_defs}
  </defs>
  {bg_rect}
  {glow_circ}

  <g transform="translate(256,300) scale({overall_scale})">
    {rarity_layer_for_egg}
    <ellipse rx="120" ry="160" fill="url(#egg)" opacity="{ '1' if stage in ('egg','cracking') else '0'}"/>
    <path d="M-60,0 L-20,-20 L0,10 L20,-15 L60,5" stroke="#2a2a2a" stroke-width="4" fill="none"
          opacity="{ '0.85' if stage=='cracking' else '0'}"/>

    <g opacity="{ '1' if stage in ('baby','teen','prime','dead') else '0'}">
      <ellipse rx="95" ry="70" fill="{body}" opacity=".95"/>
      {pattern_svg}

      <!-- face -->
      {"<g opacity='1'>" if stage != "dead" else "<g opacity='0'>"}
        <circle cx="-18" cy="-8" r="6" fill="#180d00"/>
        <circle cx="18" cy="-8" r="6" fill="#180d00"/>
        {mouth_svg}
      </g>

      <!-- limbs -->
      {arms_svg}
      {feet_svg}

      <!-- cosmetics -->
      {crown_svg}
      {flames_svg}
      {lasers_svg}

      <!-- rarity aura on body -->
      {twinkles}
      {orbit_svg}
      {halo_svg}
      {aurora_svg}
      {bolt_svg}
    </g>
  </g>

  {status_block}
  <a xlink:href="{url_for('creatures.habitat_page', code=st['code'], _external=True)}">
    <rect x="0" y="0" width="512" height="512" fill="transparent"/>
  </a>
</svg>"""
    return _svg_headers(make_response(svg, 200))

@bp_creatures.get("/creature/<code>")
def habitat_page(code):
    state_url   = url_for("creatures.creatures_state", code=code, _external=True)
    svg_url     = url_for("creatures.creature_svg",   code=code, _external=True)
    feed_api    = url_for("creatures.creatures_feed", _external=True)
    tick_ms     = str(TICK_STEP_SECONDS * 1000)

    html = f"""<!doctype html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>IZZA Creature {code}</title>
<style>
  body{{background:#000;color:#e8f1ff;font-family:Inter,Arial,sans-serif;margin:0;text-align:center}}
  .wrap{{max-width:960px;margin:0 auto;padding:20px}}
  .btn{{display:inline-flex;align-items:center;justify-content:center;padding:12px 16px;border-radius:12px;
       border:1px solid #2a3550;color:#cfe0ff;background:#0b0f1f;cursor:pointer;font-weight:700}}
  img{{width:256px;height:256px;object-fit:contain}}
  pre{{text-align:left;background:#0b0f1f;border:1px solid #2a3550;border-radius:12px;padding:12px;overflow:auto}}
</style>
</head><body><div class="wrap">
  <h1>IZZA Creature {code}</h1>
  <img id="img" alt="creature" src="{svg_url}?nc={_now_i()}">
  <div style="margin:12px 0"><button class="btn" id="feedBtn">Feed</button></div>
  <pre id="state"></pre>
</div>
<script>
  const STATE_URL = {json.dumps(state_url)};
  const SVG_URL   = {json.dumps(svg_url)};
  const FEED_URL  = {json.dumps(feed_api)};
  async function refresh(){{
    const j = await fetch(STATE_URL).then(r=>r.json());
    document.getElementById('state').textContent = JSON.stringify(j,null,2);
    document.getElementById('img').src = SVG_URL + '?nc=' + Date.now();
  }}
  document.getElementById('feedBtn').addEventListener('click', async () => {{
    const st = await fetch(STATE_URL).then(r=>r.json());
    await fetch(FEED_URL, {{
      method:'POST',
      headers:{{'Content-Type':'application/json'}},
      body: JSON.stringify({{ code: {json.dumps(code)}, owner_pub: st.owner_pub || '' }})
    }});
    refresh();
  }});
  refresh();
  setInterval(refresh, {tick_ms});
</script>
</body></html>"""
    resp = make_response(html, 200)
    resp.headers["Cache-Control"] = "no-store"
    return resp
