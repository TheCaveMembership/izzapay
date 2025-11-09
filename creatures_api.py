# creatures_api.py
import os, json, time, random, sqlite3
from decimal import Decimal
from flask import Blueprint, request, jsonify, abort, make_response, url_for, g, session
from stellar_sdk import (
    Asset, Keypair, Server, Claimant, ClaimPredicate, TransactionBuilder, exceptions as sx
)
from db import conn as _conn

# Uses shared Horizon helpers from your nft_api module
from nft_api import (
    server, PP,  # server: Horizon Server, PP: NETWORK_PASSPHRASE
    _account_has_trustline, _change_trust, _pay_asset, _ensure_distributor_holds_one
)

# Optional: linked secret from wallet API for direct delivery
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

# Fast test lifecycles (HALVED)
TEST_TOTAL_SECONDS = 90
TEST_CRACK_START   = 15
TEST_HATCH_DONE    = 30
TEST_TEENAGE       = 60
TEST_PRIME         = 90
TICK_STEP_SECONDS  = 3  # keep tick stable for UI pacing

EGG_PRICE_IZZA = Decimal("5")  # user pays once here; delivery is free

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
          hunger INTEGER DEFAULT 0,
          stage TEXT,
          meta_version INTEGER DEFAULT 1,
          user_id INTEGER,
          UNIQUE(code, issuer)
        )""")
        # indices
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

# ---------- username/pub fallback (so "My Creatures" works without g.user_id) ----------
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
    """
    Best-effort: grab the active wallet pub from user_wallets via username/session.
    """
    u = _resolve_username()
    if not u: return None
    with _db() as cx:
        row = cx.execute("SELECT pub FROM user_wallets WHERE username=?", (u,)).fetchone()
        return (row["pub"] if row and row["pub"] else None)

# ---------- utils ----------
def _clamp(v, lo, hi): return max(lo, min(hi, v))

def _stage_from_elapsed(elapsed: int, _hunger: int) -> str:
    if elapsed < TEST_CRACK_START: return "egg"
    if elapsed < TEST_HATCH_DONE:  return "cracking"
    if elapsed < TEST_TEENAGE:     return "baby"
    if elapsed < TEST_PRIME:       return "teen"
    return "prime"

def _choose_palette(seed: str):
    rnd = random.Random(seed)
    return rnd.choice(["gold","violet","turquoise","rose","lime"]), rnd.choice(["speckle","stripe","swirl","mosaic","metallic"])

def _compute_state_dict(code: str) -> dict:
    # Demo that supports ?skin=<seed> to vary appearance (used by shuffle previews)
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

    hatch_start = int(r["hatch_start"] or 0)
    elapsed = max(0, _now_i() - hatch_start)
    hunger = _clamp(int(r["hunger"] or 0) + max(0, elapsed // 5), 0, 100)
    stage = _stage_from_elapsed(elapsed, hunger)

    return {
        "code":r["code"],"issuer":r["issuer"],"owner_pub":r["owner_pub"],
        "elapsed":elapsed,"tick_seconds":TICK_STEP_SECONDS,"hunger":int(hunger),
        "stage":stage,"palette":r["palette"],"pattern":r["pattern"],
        "hatch_start":hatch_start
    }

def _svg_headers(resp):
    resp.headers["Content-Type"] = "image/svg+xml"
    resp.headers["Cache-Control"] = "no-store, max-age=0"
    resp.headers["X-Content-Type-Options"] = "nosniff"
    return resp

# ---------- API ----------
@bp_creatures.post("/api/creatures/quote")
def creatures_quote():
    return jsonify({"ok": True, "price_izza": str(EGG_PRICE_IZZA), "tick_seconds": TICK_STEP_SECONDS})

@bp_creatures.post("/api/creatures/mint")
def creatures_mint():
    """
    Body: { buyer_pub, buyer_sec }
    1) charge 5 IZZA from buyer to distributor
    2) mint 1 unit of a new asset code to distributor
    3) insert the creature row (bind to user if available)
    """
    _ensure_tables()
    j = request.get_json(silent=True) or {}
    buyer_pub = (j.get("buyer_pub") or "").strip()
    buyer_sec = (j.get("buyer_sec") or "").strip()
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

    seed = f"{code}:{ts}"
    base, pat = _choose_palette(seed)
    uid = getattr(g, "user_id", None)

    with _db() as cx:
        cx.execute("""
          INSERT INTO nft_creatures(code, issuer, owner_pub, egg_seed, palette, pattern,
                                    hatch_start, last_feed_at, hunger, stage, meta_version, user_id)
          VALUES(?,?,?,?,?,?,?,?,?,?,1,?)
        """, (code, CREATURE_ISSUER_G, None, seed, base, pat, ts, ts, 0, "egg", uid))
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
    """
    Returns the caller's creatures. If session user_id is missing,
    falls back to active wallet pub (via user_wallets) using ?u= or session username.
    """
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
    """
    Body: { code, owner_pub }
    If we have an S-key linked for owner_pub -> ensure trustline and send 1 unit directly.
    Else -> create a claimable balance of 1.
    """
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
    """
    Decreases hunger by 30 (clamped at 0), updates last_feed_at. Owner pub is required.
    """
    j = request.get_json(silent=True) or {}
    code = (j.get("code") or "").strip()
    owner = (j.get("owner_pub") or "").strip()
    if not code or not owner:
        abort(400, "code_and_owner_required")
    _ensure_tables()
    with _db() as cx:
        row = cx.execute(
            "SELECT hunger FROM nft_creatures WHERE code=? AND issuer=?",
            (code, CREATURE_ISSUER_G)
        ).fetchone()
        if not row:
            abort(404, "not_found")
        hunger = _clamp(int(row["hunger"] or 0) - 30, 0, 100)
        now = _now_i()
        cx.execute(
            "UPDATE nft_creatures SET hunger=?, last_feed_at=? WHERE code=? AND issuer=?",
            (hunger, now, code, CREATURE_ISSUER_G)
        )
        cx.commit()
    return jsonify({"ok": True, "hunger": hunger})

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
    elapsed = int(st["elapsed"])

    bg = {
        "gold":"#130e00","violet":"#0e061a","turquoise":"#02151a","rose":"#1a0710","lime":"#0c1a06"
    }.get(base, "#0b0b10")
    glow = {
        "gold":"#ffcd60","violet":"#b784ff","turquoise":"#48d4ff","rose":"#ff7aa2","lime":"#89ff7a"
    }.get(base, "#b784ff")

    if stage == "egg":       egg_scale = "1.0"
    elif stage == "cracking": egg_scale = "1.02"
    elif stage == "baby":     egg_scale = "0.9"
    elif stage == "teen":     egg_scale = "1.0"
    else:                     egg_scale = "1.06"

    wither = "1" if (elapsed >= TEST_PRIME and hunger >= 90) else "0"

    svg = f"""<svg viewBox="0 0 512 512"
  xmlns="http://www.w3.org/2000/svg"
  xmlns:xlink="http://www.w3.org/1999/xlink" width="512" height="512">
  <defs>
    <radialGradient id="g0"><stop offset="0" stop-color="{glow}"/><stop offset="1" stop-color="{bg}"/></radialGradient>
    <linearGradient id="egg"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="{glow}"/></linearGradient>
    <filter id="soft"><feGaussianBlur stdDeviation="6"/></filter>
  </defs>
  <rect width="512" height="512" fill="{bg}"/>
  <circle cx="256" cy="360" r="160" fill="url(#g0)" opacity=".14" filter="url(#soft)"/>
  <g transform="translate(256,300) scale({egg_scale})">
    <ellipse rx="120" ry="160" fill="url(#egg)" opacity="{ '1' if stage in ('egg','cracking') else '0'}"/>
    <path d="M-60,0 L-20,-20 L0,10 L20,-15 L60,5" stroke="#2a2a2a" stroke-width="4" fill="none"
          opacity="{ '0.85' if stage=='cracking' else '0'}"/>
    <g opacity="{ '1' if stage in ('baby','teen','prime') else '0'}">
      <ellipse rx="90" ry="66" fill="{glow}" opacity=".85"/>
      <circle cx="-18" cy="-8" r="6" fill="#180d00"/>
      <circle cx="18" cy="-8" r="6" fill="#180d00"/>
    </g>
    <rect x="-160" y="-200" width="320" height="360" fill="#000" opacity="{wither}"/>
  </g>
  <g font-family="ui-monospace, Menlo, monospace" font-size="14" fill="#fff" opacity=".95">
    <text x="16" y="28">Stage: {stage}</text>
    <text x="16" y="48">Hunger: {hunger}%</text>
    <text x="16" y="68">Tick: {TICK_STEP_SECONDS}s</text>
  </g>
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
