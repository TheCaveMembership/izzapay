# creatures_api.py
import os, json, time, random
from decimal import Decimal
from flask import Blueprint, request, jsonify, abort, make_response, url_for
from stellar_sdk import (
    Asset, Keypair, TransactionBuilder, Claimant, ClaimPredicate
)
from db import conn as _conn
from nft_api import (
    server, PP,
    _account_has_trustline, _change_trust, _pay_asset, _ensure_distributor_holds_one
)

bp_creatures = Blueprint("creatures", __name__)

# ---------- config ----------
IZZA_CODE = os.getenv("IZZA_TOKEN_CODE", "IZZA").strip()
IZZA_ISS  = os.getenv("IZZA_TOKEN_ISSUER", "").strip()
CREATURE_ISSUER_G = os.getenv("NFT_ISSUER_PUBLIC", "").strip()  # same issuer as other NFTs
DISTR_S  = os.getenv("NFT_DISTR_SECRET", "").strip()
DISTR_G  = os.getenv("NFT_DISTR_PUBLIC", "").strip()
HOME_DOMAIN = os.getenv("NFT_HOME_DOMAIN", "izzapay.onrender.com").strip()

# fast test cycle knobs (3 minutes total)
TEST_TOTAL_SECONDS = 180
TEST_CRACK_START   = 30     # seconds
TEST_HATCH_DONE    = 60
TEST_TEENAGE       = 120
TEST_PRIME         = 180
TICK_STEP_SECONDS  = 3

EGG_PRICE_IZZA = Decimal("5")  # 5 IZZA per egg

# ---------- db helpers ----------
def _db():
    return _conn()

def _now_i() -> int:
    return int(time.time())

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
          UNIQUE(code, issuer)
        )""")
        cx.execute("CREATE INDEX IF NOT EXISTS idx_creat_owner ON nft_creatures(owner_pub)")
        cx.execute("CREATE INDEX IF NOT EXISTS idx_creat_stage ON nft_creatures(stage)")

# ---------- small utils ----------
def _clamp(v, lo, hi): return max(lo, min(hi, v))

def _stage_from_elapsed(elapsed: int, _hunger: int) -> str:
    if elapsed < TEST_CRACK_START: return "egg"
    if elapsed < TEST_HATCH_DONE:  return "cracking"
    if elapsed < TEST_TEENAGE:     return "baby"
    if elapsed < TEST_PRIME:       return "teen"
    return "prime"

def _choose_palette(seed: str):
    rnd = random.Random(seed)
    base = rnd.choice(["gold","violet","turquoise","rose","lime"])
    pat  = rnd.choice(["speckle","stripe","swirl","mosaic","metallic"])
    return base, pat

def _compute_state_dict(code: str) -> dict:
    _ensure_tables()
    with _db() as cx:
        r = cx.execute(
            "SELECT * FROM nft_creatures WHERE code=? AND issuer=?",
            (code, CREATURE_ISSUER_G)
        ).fetchone()
    if not r:
        abort(404, "not_found")

    hatch_start = int(r["hatch_start"] or 0)
    elapsed = max(0, _now_i() - hatch_start)

    # simple hunger growth for test mode: +1 every ~5s (approx), capped
    hunger_base = int(r["hunger"] or 0)
    hunger = _clamp(hunger_base + max(0, elapsed // 5), 0, 100)

    stage = _stage_from_elapsed(elapsed, hunger)

    return {
        "code": r["code"],
        "issuer": r["issuer"],
        "owner_pub": r["owner_pub"],
        "elapsed": elapsed,
        "tick_seconds": TICK_STEP_SECONDS,
        "hunger": int(hunger),
        "stage": stage,
        "palette": r["palette"],
        "pattern": r["pattern"],
        "hatch_start": hatch_start,
    }

# ---------- helpers: create claimable balance ----------
def _create_cb_to_owner(asset: Asset, owner_pub: str):
    """
    Creates a claimable balance of 1 unit for owner_pub from distributor.
    Open predicate (claim anytime). Returns tx hash on success.
    """
    dist = server.load_account(DISTR_G)
    tx = (
        TransactionBuilder(
            source_account=dist,
            network_passphrase=PP,
            base_fee=200_000
        )
        .append_create_claimable_balance_op(
            asset=asset,
            amount="1",
            claimants=[Claimant(owner_pub, ClaimPredicate.unconditional())]
        )
        .set_timeout(300)
        .build()
    )
    tx.sign(Keypair.from_secret(DISTR_S))
    resp = server.submit_transaction(tx)
    return resp.get("hash")

# ---------- API: quote ----------
@bp_creatures.post("/api/creatures/quote")
def creatures_quote():
    return jsonify({"ok": True, "price_izza": str(EGG_PRICE_IZZA), "tick_seconds": TICK_STEP_SECONDS})

# ---------- API: latest minted (optionally by owner) ----------
@bp_creatures.get("/api/creatures/latest")
def creatures_latest():
    _ensure_tables()
    owner = (request.args.get("owner_pub") or "").strip().upper()
    with _db() as cx:
        if owner and owner.startswith("G") and len(owner) >= 10:
            r = cx.execute(
                "SELECT code,issuer,hatch_start FROM nft_creatures WHERE owner_pub=? ORDER BY hatch_start DESC LIMIT 1",
                (owner,)
            ).fetchone()
        else:
            r = cx.execute(
                "SELECT code,issuer,hatch_start FROM nft_creatures ORDER BY hatch_start DESC LIMIT 1"
            ).fetchone()
    return jsonify({"ok": True, "latest": dict(r) if r else None})

# ---------- API: list by owner (for 'My Creatures') ----------
@bp_creatures.get("/api/creatures/list")
def creatures_list():
    _ensure_tables()
    owner = (request.args.get("owner_pub") or "").strip().upper()
    if not owner:
        abort(400, "owner_pub_required")
    with _db() as cx:
        rows = cx.execute(
            "SELECT code, issuer, hatch_start FROM nft_creatures WHERE owner_pub=? ORDER BY hatch_start DESC",
            (owner,)
        ).fetchall()
    items = [{"code": r["code"], "issuer": r["issuer"], "hatch_start": r["hatch_start"]} for r in rows]
    return jsonify({"ok": True, "items": items})

# ---------- API: mint egg (pay 5 IZZA) ----------
@bp_creatures.post("/api/creatures/mint")
def creatures_mint():
    """
    Body: { "buyer_pub":"G...", "buyer_sec":"S..." }
    Steps:
      1) charge 5 IZZA from buyer to distributor
      2) mint 1 unit of new asset code to distributor
      3) insert nft_creatures row with hatch_start=now
      4) return asset identity (claim via standard flow)
    """
    _ensure_tables()
    j = request.get_json(silent=True) or {}
    buyer_pub = (j.get("buyer_pub") or "").strip()
    buyer_sec = (j.get("buyer_sec") or "").strip()
    if not buyer_pub or not buyer_sec:
        abort(400, "wallet_required")

    izza = Asset(IZZA_CODE, IZZA_ISS)

    # Distributor IZZA trustline (idempotent)
    try:
        _change_trust(DISTR_S, izza, limit="100000000")
    except Exception:
        pass

    # charge fee
    try:
        _pay_asset(buyer_sec, DISTR_G, str(EGG_PRICE_IZZA), izza, memo="IZZA CREATURE EGG")
    except Exception as e:
        abort(400, f"fee_payment_failed: {e}")

    # new egg asset code
    ts = _now_i()
    short = hex(ts)[2:].upper()[-6:]
    suffix = random.choice(["A","B","C","D","E","F","G"])
    code = f"EGG{short}{suffix}"[:12]

    asset = Asset(code, CREATURE_ISSUER_G)
    try:
        _ensure_distributor_holds_one(asset)
    except Exception as e:
        abort(400, f"mint_failed:{e}")

    seed = f"{code}:{ts}"
    base, pat = _choose_palette(seed)

    with _db() as cx:
        cx.execute("""
          INSERT INTO nft_creatures(code, issuer, owner_pub, egg_seed, palette, pattern,
                                    hatch_start, last_feed_at, hunger, stage, meta_version)
          VALUES(?,?,?,?,?,?,?,?,?,?,1)
        """, (code, CREATURE_ISSUER_G, None, seed, base, pat, ts, ts, 0, "egg"))
        # upsert collection shell for DB coherence
        cx.execute("""
          INSERT INTO nft_collections(code, issuer, total_supply, decimals, status, created_at, updated_at)
          VALUES(?,?,?,?, 'draft', ?, ?)
          ON CONFLICT(code, issuer) DO UPDATE SET updated_at=excluded.updated_at
        """, (code, CREATURE_ISSUER_G, 1, 0, ts, ts))
        cx.commit()

    return jsonify({"ok": True, "asset": {"code": code, "issuer": CREATURE_ISSUER_G}, "hatch_start": ts})

# ---------- API: auto-claim (create claimable balance + mark owner) ----------
@bp_creatures.post("/api/creatures/auto-claim")
def creatures_auto_claim():
    """
    Body: { "code":"EGG...", "owner_pub":"G..." }
    Creates a claimable balance (1 unit) to owner for the egg asset, and records owner in DB.
    Wallet UI will pick it up in 'Claims' automatically.
    """
    j = request.get_json(silent=True) or {}
    code = (j.get("code") or "").strip()
    owner_pub = (j.get("owner_pub") or "").strip().upper()
    if not code or not owner_pub:
        abort(400, "code_and_owner_required")

    asset = Asset(code, CREATURE_ISSUER_G)
    try:
        cb_hash = _create_cb_to_owner(asset, owner_pub)
    except Exception as e:
        abort(400, f"create_cb_failed:{e}")

    _ensure_tables()
    with _db() as cx:
        cx.execute(
            "UPDATE nft_creatures SET owner_pub=? WHERE code=? AND issuer=?",
            (owner_pub, code, CREATURE_ISSUER_G)
        )
        cx.commit()

    return jsonify({"ok": True, "tx": cb_hash})

# ---------- API: record owner (manual fallback) ----------
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
            "UPDATE nft_creatures SET owner_pub=? WHERE code=? AND issuer=?",
            (owner, code, CREATURE_ISSUER_G)
        )
        cx.commit()
    return jsonify({"ok": True})

# ---------- API: feed ----------
@bp_creatures.post("/api/creatures/feed")
def creatures_feed():
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
        hunger = int(row["hunger"] or 0)
        hunger = _clamp(hunger - 30, 0, 100)
        now = _now_i()
        cx.execute(
            "UPDATE nft_creatures SET hunger=?, last_feed_at=? WHERE code=? AND issuer=?",
            (hunger, now, code, CREATURE_ISSUER_G)
        )
        cx.commit()

    return jsonify({"ok": True, "hunger": hunger})

# ---------- API: state JSON ----------
@bp_creatures.get("/api/creatures/state/<code>.json")
def creatures_state(code):
    st = _compute_state_dict(code)
    resp = make_response(json.dumps(st), 200)
    resp.headers["Content-Type"] = "application/json; charset=utf-8"
    resp.headers["Cache-Control"] = "no-store"
    return resp

# ---------- Metadata JSON ----------
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

# ---------- Dynamic SVG renderer (supports EGGDEMO previews) ----------
@bp_creatures.get("/nftsvg/<code>.svg")
def creature_svg(code):
    # Demo previews for the carousel
    if code.upper() == "EGGDEMO":
        # vary the look by ?skin=#
        try:
            skin = int(request.args.get("skin", "0"))
        except Exception:
            skin = 0
        palettes = [
            ("#130e00", "#ffcd60"),
            ("#0e061a", "#b784ff"),
            ("#02151a", "#48d4ff"),
            ("#1a0710", "#ff7aa2"),
            ("#0c1a06", "#89ff7a"),
        ]
        bg, glow = palettes[skin % len(palettes)]
        svg = f"""<svg viewBox="0 0 320 160" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="g"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="{glow}"/></linearGradient>
  </defs>
  <rect width="320" height="160" fill="{bg}"/>
  <g transform="translate(80,80)">
    <ellipse rx="46" ry="62" fill="url(#g)"/>
    <path d="M-30,6 L-10,-6 L0,10 L12,-8 L30,4" stroke="#2a2a2a" stroke-width="3" fill="none" opacity=".85"/>
  </g>
</svg>"""
        resp = make_response(svg, 200)
        resp.headers["Content-Type"] = "image/svg+xml"
        resp.headers["Cache-Control"] = "no-store"
        return resp

    # Live creature rendering
    st = _compute_state_dict(code)
    stage   = st["stage"]
    hunger  = int(st["hunger"])
    base    = st["palette"]
    elapsed = int(st["elapsed"])

    bg = {
        "gold":"#130e00","violet":"#0e061a","turquoise":"#02151a",
        "rose":"#1a0710","lime":"#0c1a06"
    }.get(base, "#0b0b10")
    glow = {
        "gold":"#ffcd60","violet":"#b784ff","turquoise":"#48d4ff",
        "rose":"#ff7aa2","lime":"#89ff7a"
    }.get(base, "#b784ff")

    if stage == "egg":       egg_scale = "1.0"
    elif stage == "cracking": egg_scale = "1.02"
    elif stage == "baby":     egg_scale = "0.9"
    elif stage == "teen":     egg_scale = "1.0"
    else:                     egg_scale = "1.06"

    wither = "1" if (elapsed >= TEST_PRIME and hunger >= 90) else "0"

    svg = f"""<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
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
  <g font-family="ui-monospace, Menlo" font-size="14" fill="#fff" opacity=".95">
    <text x="16" y="28">Stage: {stage}</text>
    <text x="16" y="48">Hunger: {hunger}%</text>
    <text x="16" y="68">Tick: {TICK_STEP_SECONDS}s</text>
  </g>
  <a xlink:href="{url_for('creatures.habitat_page', code=code, _external=True)}">
    <rect x="0" y="0" width="512" height="512" fill="transparent"/>
  </a>
</svg>"""
    resp = make_response(svg, 200)
    resp.headers["Content-Type"] = "image/svg+xml"
    resp.headers["Cache-Control"] = "no-store"
    return resp

# ---------- Habitat page (HTML shell) ----------
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
    const img = document.getElementById('img');
    img.src = SVG_URL + '?nc=' + Date.now();
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
