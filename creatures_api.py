# creatures_api.py
import os, json, time, math, random
from datetime import datetime, timezone
from decimal import Decimal
from flask import Blueprint, request, jsonify, abort, Response, make_response, url_for
from stellar_sdk import Asset
from db import conn as _db
from nft_api import server, PP, _account_has_trustline, _change_trust, _pay_asset, _ensure_distributor_holds_one
from stellar_sdk import Keypair, Asset

bp_creatures = Blueprint("creatures", __name__)

# ---------- config ----------
IZZA_CODE = os.getenv("IZZA_TOKEN_CODE", "IZZA").strip()
IZZA_ISS  = os.getenv("IZZA_TOKEN_ISSUER", "").strip()
CREATURE_ISSUER_G = os.getenv("NFT_ISSUER_PUBLIC", "").strip()  # same issuer as your other NFTs
DISTR_S  = os.getenv("NFT_DISTR_SECRET", "").strip()
DISTR_G  = os.getenv("NFT_DISTR_PUBLIC", "").strip()
HOME_DOMAIN = os.getenv("NFT_HOME_DOMAIN", "izzapay.onrender.com").strip()

# test cycle knobs
TEST_TOTAL_SECONDS = 180           # full life in 3 minutes
TEST_CRACK_START   = 30            # seconds, cracks begin
TEST_HATCH_DONE    = 60            # seconds, baby visible
TEST_TEENAGE       = 120           # seconds
TEST_PRIME         = 180           # seconds
TICK_STEP_SECONDS  = 3             # update hint for clients

EGG_PRICE_IZZA = Decimal("5")      # 5 IZZA per egg

# ---------- db helpers ----------
def _db():
    return _db()

def _now_i(): return int(time.time())

def _ensure_tables():
    with _db() as cx:
        cx.execute("""
        CREATE TABLE IF NOT EXISTS nft_creatures(
          id INTEGER PRIMARY KEY,
          code TEXT NOT NULL,         -- asset code on-chain
          issuer TEXT NOT NULL,       -- CREATURE_ISSUER_G
          owner_pub TEXT,             -- filled after claim
          egg_seed TEXT,              -- RNG seed for visuals
          palette TEXT,               -- serialized colorway
          pattern TEXT,               -- pattern id
          hatch_start INTEGER,        -- unix, when egg was minted
          last_feed_at INTEGER,       -- unix
          hunger INTEGER DEFAULT 0,   -- 0..100
          stage TEXT,                 -- egg, cracking, baby, teen, prime, elder, wither
          meta_version INTEGER DEFAULT 1,
          UNIQUE(code, issuer)
        )""")
        cx.execute("CREATE INDEX IF NOT EXISTS idx_creat_owner ON nft_creatures(owner_pub)")
        cx.execute("CREATE INDEX IF NOT EXISTS idx_creat_stage ON nft_creatures(stage)")

# ---------- small utils ----------
def _stage_from_elapsed(elapsed, hunger):
    # hunger only affects wither display, not timeline for this test
    if elapsed < TEST_CRACK_START: return "egg"
    if elapsed < TEST_HATCH_DONE:  return "cracking"
    if elapsed < TEST_TEENAGE:     return "baby"
    if elapsed < TEST_PRIME:       return "teen"
    if elapsed >= TEST_PRIME:      return "prime"

def _elapsed_since(t0):
    return max(0, _now_i() - int(t0 or 0))

def _clamp(v, lo, hi): return max(lo, min(hi, v))

def _choose_palette(seed):
    # quick deterministic palette from seed
    rnd = random.Random(seed)
    base = rnd.choice(["gold","violet","turquoise","rose","lime"])
    pat  = rnd.choice(["speckle","stripe","swirl","mosaic","metallic"])
    return base, pat

# ---------- API: quote for an egg ----------
@bp_creatures.post("/api/creatures/quote")
def creatures_quote():
    return jsonify({"ok": True, "price_izza": str(EGG_PRICE_IZZA), "tick_seconds": TICK_STEP_SECONDS})

# ---------- API: mint egg using 5 IZZA, reusing distributor and issuer ----------
@bp_creatures.post("/api/creatures/mint")
def creatures_mint():
    """
    Body:
    {
      "buyer_pub": "G...",
      "buyer_sec": "S..."      # locally saved S, same as your current flow
    }
    Steps:
      1) charge 5 IZZA from buyer to distributor
      2) mint 1 unit of new asset code to distributor
      3) insert row in nft_creatures with hatch_start=now
      4) return asset code, issuer and advice to claim via your standard claim flow
    """
    _ensure_tables()
    j = request.get_json(silent=True) or {}
    buyer_pub = (j.get("buyer_pub") or "").strip()
    buyer_sec = (j.get("buyer_sec") or "").strip()
    if not buyer_pub or not buyer_sec:
        abort(400, "wallet_required")

    izza = Asset(IZZA_CODE, IZZA_ISS)
    # trustline on distributor for IZZA
    try:
        _change_trust(DISTR_S, izza, limit="100000000")
    except Exception:
        pass

    # charge fee
    try:
        _pay_asset(buyer_sec, DISTR_G, str(EGG_PRICE_IZZA), izza, memo="IZZA CREATURE EGG")
    except Exception as e:
        abort(400, f"fee_payment_failed: {e}")

    # create new egg asset code, deterministic short code
    ts = _now_i()
    short = hex(ts)[2:].upper()[-6:]                      # time stub
    suffix = random.choice(["A","B","C","D","E","F","G"]) # tiny variety
    code = f"EGG{short}{suffix}"[:12]

    asset = Asset(code, CREATURE_ISSUER_G)
    try:
        _ensure_distributor_holds_one(asset)
    except Exception as e:
        abort(400, f"mint_failed:{e}")

    # seed, palette, pattern
    seed = f"{code}:{ts}"
    base, pat = _choose_palette(seed)

    with _db() as cx:
        cx.execute("""
          INSERT INTO nft_creatures(code, issuer, owner_pub, egg_seed, palette, pattern, hatch_start, last_feed_at, hunger, stage, meta_version)
          VALUES(?,?,?,?,?,?,?,?,?,?,1)
        """, (code, CREATURE_ISSUER_G, None, seed, base, pat, ts, ts, 0, "egg"))
        cx.execute("""
          INSERT INTO nft_collections(code, issuer, total_supply, decimals, status, created_at, updated_at)
          VALUES(?,?,?,?, 'draft', ?, ?)
          ON CONFLICT(code, issuer) DO UPDATE SET updated_at=excluded.updated_at
        """, (code, CREATURE_ISSUER_G, 1, 0, ts, ts))
        cx.commit()

    # return asset identity, your existing claim page will deliver it to the wallet
    return jsonify({"ok": True, "asset": {"code": code, "issuer": CREATURE_ISSUER_G}, "hatch_start": ts})

# ---------- API: called by your existing claim step to record owner_pub ----------
@bp_creatures.post("/api/creatures/mark-owned")
def creatures_mark_owned():
    """
    Body: { "code":"EGGXXXX", "owner_pub":"G..." }
    Called right after your /api/nft/claim succeeds, so we can attach owner.
    Non-fatal if the row is missing.
    """
    j = request.get_json(silent=True) or {}
    code = (j.get("code") or "").strip()
    owner = (j.get("owner_pub") or "").strip()
    if not code or not owner:
        abort(400, "code_and_owner_required")
    _ensure_tables()
    with _db() as cx:
        cx.execute("UPDATE nft_creatures SET owner_pub=? WHERE code=? AND issuer=?", (owner, code, CREATURE_ISSUER_G))
        cx.commit()
    return jsonify({"ok": True})

# ---------- API: feed current owner’s creature, no extra signature gate for this page ----------
@bp_creatures.post("/api/creatures/feed")
def creatures_feed():
    """
    Body: { "code":"EGG...", "owner_pub":"G..." }
    For now we accept the owner_pub from the IZZA Creatures page session, no additional signing.
    Effect: lower hunger, bump last_feed_at
    """
    j = request.get_json(silent=True) or {}
    code = (j.get("code") or "").strip()
    owner = (j.get("owner_pub") or "").strip()
    if not code or not owner:
        abort(400, "code_and_owner_required")

    _ensure_tables()
    with _db() as cx:
        row = cx.execute("SELECT hatch_start, last_feed_at, hunger FROM nft_creatures WHERE code=? AND issuer=?",
                         (code, CREATURE_ISSUER_G)).fetchone()
        if not row: abort(404, "not_found")

        hunger = int(row["hunger"])
        # feeding reduces hunger by 30, min 0
        hunger = _clamp(hunger - 30, 0, 100)
        now = _now_i()
        cx.execute("UPDATE nft_creatures SET hunger=?, last_feed_at=? WHERE code=? AND issuer=?",
                   (hunger, now, code, CREATURE_ISSUER_G))
        cx.commit()

    return jsonify({"ok": True, "hunger": hunger})

# ---------- API: state JSON for a creature (used by metadata and SVG) ----------
@bp_creatures.get("/api/creatures/state/<code>.json")
def creatures_state(code):
    _ensure_tables()
    with _db() as cx:
        r = cx.execute("SELECT * FROM nft_creatures WHERE code=? AND issuer=?", (code, CREATURE_ISSUER_G)).fetchone()
    if not r:
        abort(404, "not_found")

    # compute live stage and hunger decay
    hatch_start = int(r["hatch_start"])
    elapsed = _elapsed_since(hatch_start)
    # hunger increases by 12 per minute in test mode, roughly every 5 seconds add 1
    # and if not fed for 3 minutes straight, we will mark wither in the SVG, not in DB
    hunger = int(r["hunger"]) + max(0, int((elapsed // 5)))
    hunger = _clamp(hunger, 0, 100)
    stage = _stage_from_elapsed(elapsed, hunger)

    return jsonify({
        "code": r["code"], "issuer": r["issuer"],
        "owner_pub": r["owner_pub"],
        "elapsed": elapsed,
        "tick_seconds": TICK_STEP_SECONDS,
        "hunger": hunger,
        "stage": stage,
        "palette": r["palette"],
        "pattern": r["pattern"],
        "hatch_start": hatch_start
    })

# ---------- Metadata JSON ----------
@bp_creatures.get("/nftmeta/<code>.json")
def creatures_metadata(code):
    # standard NFT metadata pointing to live SVG and habitat
    meta = {
      "name": f"IZZA Creature {code}",
      "description": "A living IZZA CREATURE that hatches, grows, and battles.",
      "image": url_for("creatures.creature_svg", code=code, _external=True) + f"?nc={_now_i()}",
      "external_url": url_for("creatures.habitat_page", code=code, _external=True),
      "attributes": [
        {"trait_type":"Collection","value":"IZZA CREATURES"},
        {"trait_type":"Stage","value":"dynamic"},
        {"trait_type":"Palette","value":"dynamic"},
      ]
    }
    resp = make_response(json.dumps(meta), 200)
    resp.headers["Content-Type"] = "application/json; charset=utf-8"
    resp.headers["Cache-Control"] = "no-store"
    return resp

# ---------- Dynamic SVG renderer ----------
@bp_creatures.get("/nftsvg/<code>.svg")
def creature_svg(code):
    _ensure_tables()
    # read state JSON directly
    st = creatures_state(code).json
    stage = st["stage"]; hunger = int(st["hunger"])
    base = st["palette"]; pattern = st["pattern"]
    elapsed = st["elapsed"]

    # visual knobs
    bg = {"gold":"#130e00","violet":"#0e061a","turquoise":"#02151a","rose":"#1a0710","lime":"#0c1a06"}.get(base,"#0b0b10")
    glow = {"gold":"#ffcd60","violet":"#b784ff","turquoise":"#48d4ff","rose":"#ff7aa2","lime":"#89ff7a"}.get(base,"#b784ff")
    crack_alpha = "0" if stage in ("egg","baby","teen","prime") else "0.3"
    egg_scale = "1.0"
    if stage == "egg": egg_scale = "1.0"
    elif stage == "cracking": egg_scale = "1.02"
    elif stage == "baby": egg_scale = "0.9"
    elif stage == "teen": egg_scale = "1.0"
    elif stage == "prime": egg_scale = "1.06"

    wither = "1" if (elapsed >= TEST_PRIME and hunger >= 90) else "0"

    svg = f"""<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="g0"><stop offset="0" stop-color="{glow}"/><stop offset="1" stop-color="{bg}"/></radialGradient>
    <linearGradient id="egg"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="{glow}"/></linearGradient>
    <filter id="soft"><feGaussianBlur stdDeviation="6"/></filter>
  </defs>
  <rect width="512" height="512" fill="{bg}"/>
  <!-- ambient glow -->
  <circle cx="256" cy="360" r="160" fill="url(#g0)" opacity=".14" filter="url(#soft)"/>
  <!-- egg or creature blob -->
  <g transform="translate(256,300) scale({egg_scale})">
    <!-- egg shell -->
    <ellipse rx="120" ry="160" fill="url(#egg)" opacity="{ '1' if stage in ('egg','cracking') else '0'}"/>
    <!-- crack overlay -->
    <path d="M-60,0 L-20,-20 L0,10 L20,-15 L60,5" stroke="#2a2a2a" stroke-width="4" fill="none" opacity="{ '0.85' if stage=='cracking' else '0'}"/>
    <!-- baby body -->
    <g opacity="{ '1' if stage in ('baby','teen','prime') else '0'}">
      <ellipse rx="90" ry="66" fill="{glow}" opacity=".85"/>
      <circle cx="-18" cy="-8" r="6" fill="#180d00"/>
      <circle cx="18" cy="-8" r="6" fill="#180d00"/>
    </g>
    <!-- wither veil -->
    <rect x="-160" y="-200" width="320" height="360" fill="#000" opacity="{wither}"/>
  </g>

  <!-- HUD -->
  <g font-family="ui-monospace, Menlo" font-size="14" fill="#fff" opacity=".95">
    <text x="16" y="28">Stage: {stage}</text>
    <text x="16" y="48">Hunger: {hunger}%</text>
    <text x="16" y="68">Tick: {TICK_STEP_SECONDS}s</text>
  </g>

  <!-- Tap area to open habitat -->
  <a xlink:href="{url_for('creatures.habitat_page', code=code, _external=True)}">
    <rect x="0" y="0" width="512" height="512" fill="transparent"/>
  </a>
</svg>"""
    resp = make_response(svg, 200)
    resp.headers["Content-Type"] = "image/svg+xml"
    resp.headers["Cache-Control"] = "no-store"
    return resp

# ---------- Habitat page route (HTML shell) ----------
@bp_creatures.get("/creature/<code>")
def habitat_page(code):
    # simple shell, the main page file will fetch state and show feed button
    html = f"""<!doctype html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>IZZA Creature {code}</title>
<style>
  body{{background:#000;color:#e8f1ff;font-family:Inter,Arial,sans-serif;margin:0;text-align:center}}
  .wrap{{max-width:960px;margin:0 auto;padding:20px}}
  .btn{{display:inline-flex;align-items:center;justify-content:center;padding:12px 16px;border-radius:12px;
       border:1px solid #2a3550;color:#cfe0ff;background:#0b0f1f;cursor:pointer;font-weight:700}}
  img{{width:256px;height:256px;object-fit:contain}}
</style>
</head><body><div class="wrap">
  <h1>IZZA Creature {code}</h1>
  <img id="img" alt="creature" src="{url_for('creatures.creature_svg', code=code, _external=True)}?nc={_now_i()}">
  <div style="margin:12px 0"><button class="btn" id="feedBtn">Feed</button></div>
  <pre id="state" style="text-align:left;background:#0b0f1f;border:1px solid #2a3550;border-radius:12px;padding:12px;overflow:auto"></pre>
</div>
<script>
  const code = {json.dumps(code)};
  async function refresh(){
    const j = await fetch({json.dumps(url_for('creatures.creatures_state', code='__CODE__', _external=True)).replace('__CODE__', code)}).then(r=>r.json());
    document.getElementById('state').textContent = JSON.stringify(j,null,2);
    const img = document.getElementById('img'); img.src = img.src.split('?')[0] + '?nc=' + Date.now();
  }
  document.getElementById('feedBtn').addEventListener('click', async ()=>{
    // we read owner_pub from your wallet API or page session, for demo use state owner_pub
    const st = await fetch({json.dumps(url_for('creatures.creatures_state', code='__CODE__', _external=True)).replace('__CODE__', code)}).then(r=>r.json());
    await fetch({json.dumps(url_for('creatures.creatures_feed', _external=True))}, {{
      method:'POST', headers:{{'Content-Type':'application/json'}},
      body: JSON.stringify({{ code, owner_pub: st.owner_pub || '' }})
    }});
    refresh();
  });
  refresh(); setInterval(refresh, {TICK_STEP_SECONDS*1000});
</script>
</body></html>"""
    resp = make_response(html, 200)
    resp.headers["Cache-Control"] = "no-store"
    return resp
