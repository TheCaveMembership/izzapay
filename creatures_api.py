# creatures_api.py
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

# Test timeline: 1 day = 60 seconds
DAY_SECS          = 60
TEST_CRACK_START  = 1 * DAY_SECS // 4   # 15s
TEST_HATCH_DONE   = 1 * DAY_SECS // 2   # 30s
TEST_TEENAGE      = 1 * DAY_SECS        # 60s
TEST_PRIME        = 1 * DAY_SECS + 30   # 90s total “life” until prime
TICK_STEP_SECONDS = 3

# Hunger growth per “day” (percent of bar per day) by stage
HUNGER_PER_DAY = {
    "egg":       0,
    "cracking":  0,
    "baby":     25,
    "teen":     35,
    "prime":    50,
    "dead":      0,
}

# Death after 3 missed days of feeding; revival requires 3 consecutive daily feeds
MISSED_DAYS_TO_DIE   = 3
REVIVE_DAYS_REQUIRED = 3

EGG_PRICE_IZZA = Decimal("5")

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
          UNIQUE(code, issuer)
        )""")
        for colstmt in [
            ("last_hunger_at",  "ALTER TABLE nft_creatures ADD COLUMN last_hunger_at INTEGER"),
            ("revive_progress", "ALTER TABLE nft_creatures ADD COLUMN revive_progress INTEGER DEFAULT 0")
        ]:
            col, stmt = colstmt
            if not _has_column(cx, "nft_creatures", col):
                cx.execute(stmt)
        cx.execute("CREATE INDEX IF NOT EXISTS idx_creat_owner ON nft_creatures(owner_pub)")
        cx.execute("CREATE INDEX IF NOT EXISTS idx_creat_stage ON nft_creatures(stage)")
        cx.execute("CREATE INDEX IF NOT EXISTS idx_creat_user  ON nft_creatures(user_id)")
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

# ---------- lifecycle helpers ----------
def _clamp(v, lo, hi): return max(lo, min(hi, v))

def _stage_from_elapsed(elapsed: int, hunger: int, existing_stage: str | None) -> str:
    if existing_stage == "dead":
        return "dead"
    if elapsed < TEST_CRACK_START: return "egg"
    if elapsed < TEST_HATCH_DONE:  return "cracking"
    if elapsed < TEST_TEENAGE:     return "baby"
    if elapsed < TEST_PRIME:       return "teen"
    return "prime"

def _choose_palette(seed: str):
    rnd = random.Random(seed)
    return rnd.choice(["gold","violet","turquoise","rose","lime"]), rnd.choice(["speckle","stripe","swirl","mosaic","metallic"])

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

# ---------- state compute ----------
def _compute_state_dict(code: str) -> dict:
    # Demo egg supports ?skin for the preview
    if code.upper() == "EGGDEMO":
        skin = (request.args.get("skin") or "demo").strip()
        base, pat = _choose_palette(skin)
        return {
            "code":"EGGDEMO","issuer":CREATURE_ISSUER_G or "GDEMOISS","owner_pub":None,
            "elapsed":0,"tick_seconds":TICK_STEP_SECONDS,"hunger":0,"stage":"egg",
            "palette":base,"pattern":pat,"hatch_start":_now_i()
        }

    _ensure_tables()
    with _db() as cx:
        r = cx.execute("SELECT * FROM nft_creatures WHERE code=? AND issuer=?",
                       (code, CREATURE_ISSUER_G)).fetchone()
    if not r:
        abort(404, "not_found")

    hunger, stage, last_feed_at, last_hunger_at, revive_progress = _apply_hunger_progress(r)
    if (hunger != int(r["hunger"] or 0)) or (stage != (r["stage"] or "")) or (last_hunger_at != int(r["last_hunger_at"] or 0)):
        _persist_progress_if_changed(r["code"], hunger, stage, last_feed_at, last_hunger_at, revive_progress)

    return {
        "code":r["code"],"issuer":r["issuer"],"owner_pub":r["owner_pub"],
        "elapsed":max(0, _now_i() - int(r["hatch_start"] or _now_i())),
        "tick_seconds":TICK_STEP_SECONDS,"hunger":int(hunger),
        "stage":stage,"palette":r["palette"],"pattern":r["pattern"],
        "hatch_start":int(r["hatch_start"] or _now_i())
    }

def _svg_headers(resp):
    resp.headers["Content-Type"] = "image/svg+xml"
    resp.headers["Cache-Control"] = "no-store, max-age=0"
    resp.headers["X-Content-Type-Options"] = "nosniff"
    return resp

# ---------- API ----------
@bp_creatures.post("/api/creatures/quote")
def creatures_quote():
    return jsonify({"ok": True, "price_izza": str(EGG_PRICE_IZZA), "tick_seconds": TICK_STEP_SECONDS, "day_seconds": DAY_SECS})

@bp_creatures.post("/api/creatures/mint")
def creatures_mint():
    _ensure_tables()
    j = request.get_json(silent=True) or {}
    buyer_pub = (j.get("buyer_pub") or "").strip()
    buyer_sec = (j.get("buyer_sec") or "").strip()
    # NEW: optional client-selected skin to sync shuffle->mint
    client_skin = (j.get("skin") or "").strip()

    if not buyer_pub or not buyer_sec:
        abort(400, "wallet_required")

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

    # If client provided a skin, use it to pick palette/pattern (sync with preview)
    seed = client_skin if client_skin else f"{code}:{ts}"
    base, pat = _choose_palette(seed)
    uid = getattr(g, "user_id", None)

    with _db() as cx:
        cx.execute("""
          INSERT INTO nft_creatures(code, issuer, owner_pub, egg_seed, palette, pattern,
                                    hatch_start, last_feed_at, last_hunger_at, hunger, stage, meta_version, user_id, revive_progress)
          VALUES(?,?,?,?,?,?, ?,?,?,?,?,1,?, 0)
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
              WHERE user_id=? OR (user_id IS NULL AND owner_pub IS NOT NULL AND owner_pub IN (
                SELECT pub FROM user_wallets WHERE username IN (
                  SELECT pi_username FROM users WHERE id=?
                )
              ))
              ORDER BY id DESC LIMIT 200
            """, (uid, uid)).fetchall()
        else:
            active_pub = _active_pub_for_request()
            if active_pub:
                rows = cx.execute("""
                  SELECT code, issuer, owner_pub, stage, palette, pattern, hatch_start
                  FROM nft_creatures
                  WHERE owner_pub=?
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
            "SELECT hunger, stage, last_feed_at, last_hunger_at, revive_progress, hatch_start FROM nft_creatures WHERE code=? AND issuer=?",
            (code, CREATURE_ISSUER_G)
        ).fetchone()
        if not row:
            abort(404, "not_found")

        hunger, stage, last_feed_at, last_hunger_at, revive_progress = _apply_hunger_progress(row)

        if stage == "dead":
            last_feed = int(last_feed_at or row["hatch_start"] or now)
            days_since_last = (now - last_feed) / float(DAY_SECS)
            if days_since_last >= 1.0:
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

    # colors
    bg = {
        "gold":"#130e00","violet":"#0e061a","turquoise":"#02151a","rose":"#1a0710","lime":"#0c1a06"
    }.get(base, "#0b0b10")
    glow = {
        "gold":"#ffcd60","violet":"#b784ff","turquoise":"#48d4ff","rose":"#ff7aa2","lime":"#89ff7a"
    }.get(base, "#b784ff")
    body = {
        "gold":"#ffe39a","violet":"#d7c0ff","turquoise":"#7fe6ff","rose":"#ffb6c8","lime":"#b4ffaf"
    }.get(base, "#e8f1ff")

    # NEW: contrasting ink just for pattern strokes/fills
    def _pattern_contrast(b):
        return {
            "gold":      "#48d4ff",  # turquoise
            "violet":    "#89ff7a",  # lime
            "turquoise": "#ff7aa2",  # rose
            "rose":      "#48d4ff",  # turquoise
            "lime":      "#b784ff",  # violet
        }.get(b, "#e8f1ff")
    pcol = _pattern_contrast(base)

    # scale by stage
    if stage == "egg":       egg_scale = "1.0"
    elif stage == "cracking": egg_scale = "1.02"
    elif stage == "baby":     egg_scale = "0.9"
    elif stage == "teen":     egg_scale = "1.0"
    elif stage == "prime":    egg_scale = "1.06"
    else:                     egg_scale = "1.0"

    # wither masks only when starving in prime (not when dead)
    wither = "1" if ((elapsed >= TEST_PRIME and hunger >= 90) and stage != "dead") else "0"

    rnd = random.Random(st["code"])
    crown  = (rnd.randint(1,3) == 1)
    flames = (rnd.randint(1,4) == 1)
    lasers = (rnd.randint(1,5) == 1)

    # Pattern fragments (use pcol instead of glow)
    pattern_svg = ""
    if pattern == "speckle":
        dots = []
        rnd2 = random.Random(st["code"] + ":p0")
        for _ in range(20):
            x = rnd2.randint(-60, 60); y = rnd2.randint(-40, 40); r = rnd2.randint(2,4)
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
        for _ in range(18):
            x = rnd3.randint(-70, 50); y = rnd3.randint(-40, 30); w = rnd3.randint(8,16); h = rnd3.randint(8,14)
            tiles.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="{pcol}" opacity=".18"/>')
        pattern_svg = "\n".join(tiles)
    elif pattern == "metallic":
        pattern_svg = '<ellipse rx="95" ry="70" fill="url(#metal)"/>'

    crown_svg = ''
    if crown and stage in ('baby','teen','prime'):
        crown_svg = f'''
          <g transform="translate(0,-110)">
            <polygon points="-28,0 0,-20 28,0 18,0 0,-10 -18,0" fill="{glow}" stroke="#000" stroke-width="3"/>
          </g>'''

    flames_svg = ''
    if flames and stage in ('teen','prime'):
        flames_svg = f'''
          <g opacity=".8">
            <path d="M-70,80 C-60,40,-40,10,-20,-10 C-10,10,-5,30,0,50 C10,30,30,5,50,-10 C60,10,70,40,80,80 Z" fill="{glow}">
              <animate attributeName="opacity" values="0.5;1;0.5" dur="1.2s" repeatCount="indefinite"/>
            </path>
          </g>'''

    lasers_svg = ''
    if lasers and stage in ('teen','prime'):
        lasers_svg = f'''
          <g stroke="#ff3355" stroke-width="5" opacity=".85">
            <line x1="-18" y1="-8" x2="-180" y2="-120">
              <animate attributeName="opacity" values="0.2;1;0.2" dur="0.9s" repeatCount="indefinite"/>
            </line>
            <line x1="18" y1="-8" x2="180" y2="-120">
              <animate attributeName="opacity" values="0.2;1;0.2" dur="0.9s" repeatCount="indefinite"/>
            </line>
          </g>'''

    show_hunger = (stage in ('baby','teen','prime'))

    # Shuffle-preview only: hide bg/status when &nobg=1 on EGGDEMO (already added earlier)
    hide_bg = (str(code).upper() == "EGGDEMO") and (str(request.args.get("nobg", "")).lower() not in ("", "0", "false", "no"))
    bg_rect = "" if hide_bg else f'<rect width="512" height="512" fill="{bg}"/>'
    glow_circ = "" if hide_bg else f'<circle cx="256" cy="360" r="160" fill="url(#g0)" opacity=".14" filter="url(#soft)"/>'
    status_block = "" if hide_bg else f'''
  <g font-family="ui-monospace, Menlo, monospace" font-size="14" fill="#fff" opacity=".95">
    <text x="16" y="28">Stage: {stage}</text>
    <text x="16" y="48" opacity="{ '1' if show_hunger else '0'}">Hunger: {hunger}%</text>
    <text x="16" y="68">Tick: {TICK_STEP_SECONDS}s  •  1d={DAY_SECS}s</text>
  </g>'''

    svg = f"""<svg viewBox="0 0 512 512"
  xmlns="http://www.w3.org/2000/svg"
  xmlns:xlink="http://www.w3.org/1999/xlink" width="512" height="512">
  <defs>
    <radialGradient id="g0"><stop offset="0" stop-color="{glow}"/><stop offset="1" stop-color="{bg}"/></radialGradient>
    <linearGradient id="egg"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="{glow}"/></linearGradient>
    <linearGradient id="metal"><stop offset="0" stop-color="#fff" stop-opacity=".8"/><stop offset="1" stop-color="{body}" stop-opacity=".9"/></linearGradient>
    <filter id="soft"><feGaussianBlur stdDeviation="6"/></filter>
  </defs>
  {bg_rect}
  {glow_circ}
  <g transform="translate(256,300) scale({egg_scale})">
    <ellipse rx="120" ry="160" fill="url(#egg)" opacity="{ '1' if stage in ('egg','cracking') else '0'}"/>
    <path d="M-60,0 L-20,-20 L0,10 L20,-15 L60,5" stroke="#2a2a2a" stroke-width="4" fill="none"
          opacity="{ '0.85' if stage=='cracking' else '0'}"/>
    <g opacity="{ '1' if stage in ('baby','teen','prime','dead') else '0'}">
      <ellipse rx="95" ry="70" fill="{body}" opacity=".95"/>
      {pattern_svg}
      {"".join([
        '<g opacity="1">' if stage != "dead" else '<g opacity="0">'
      ])}
        <circle cx="-18" cy="-8" r="6" fill="#180d00"/>
        <circle cx="18" cy="-8" r="6" fill="#180d00"/>
      </g>
      {crown_svg}
      {flames_svg}
      {lasers_svg}
    </g>
    <rect x="-160" y="-200" width="320" height="360" fill="#000" opacity="{wither}"/>
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
