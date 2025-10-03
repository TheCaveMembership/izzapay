// index.js — IZZA persistence service (ESM)
// - Stores per-user snapshots under /var/data/izza/players
// - Keeps history (last 5) and a .lastgood.json that never gets overwritten by empty saves
// - Endpoints:
//     GET  /healthz
//     GET  /api/state/:username
//     GET  /api/state/:username?prefer=lastGood
//     POST /api/state/:username
//     POST /api/crafting/ai_svg          <-- ADDED (real AI SVG endpoint)
//     GET  /api/crafting/ai_info         <-- model/key check

import express from 'express';
import morgan from 'morgan';
import cors from 'cors';
import { promises as fs } from 'fs';
import path from 'path';
import fetch from 'node-fetch';             // <--- ADD THIS LINE

// ---------- storage config ----------
const ROOT = process.env.DATA_DIR || '/var/data/izza/players';
const HISTORY_DEPTH = 5;

async function ensureDir() { await fs.mkdir(ROOT, { recursive: true }); }
function normUser(u){ return String(u||'').trim().toLowerCase().replace(/[^a-z0-9_\-\.]/g,''); }
function filePath(base, suffix=''){ return path.join(ROOT, `${base}${suffix}.json`); }

async function readJSON(file){
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; }
}
async function writeJSON(file, obj){
  await fs.writeFile(file, JSON.stringify(obj, null, 2), 'utf8');
}

function isPlainObject(o){ return !!o && typeof o==='object' && !Array.isArray(o); }
function isEmptySnapshot(snap){
  if(!isPlainObject(snap)) return true;
  if(snap.version !== 1) return false; // unknown future versions: treat as non-empty
  const coins    = (snap.coins|0) || 0;
  const invEmpty = !isPlainObject(snap.inventory) || Object.keys(snap.inventory).length===0;
  const b        = isPlainObject(snap.bank) ? snap.bank : {};
  const bCoins   = (b.coins|0) || 0;
  const bEmpty   = bCoins===0 &&
                   (!isPlainObject(b.items) || Object.keys(b.items).length===0) &&
                   (!isPlainObject(b.ammo)  || Object.keys(b.ammo ).length===0);
  return (coins===0 && invEmpty && bEmpty);
}

async function rotateHistory(base){
  for(let i=HISTORY_DEPTH-1;i>=1;i--){
    const src=filePath(base, `.${i}`);
    const dst=filePath(base, `.${i+1}`);
    try{ await fs.rename(src,dst); }catch{}
  }
  try{ await fs.rename(filePath(base,''), filePath(base,'.1')); }catch{}
}

async function readBest(base, preferLastGood){
  const lastGood = await readJSON(filePath(base, '.lastgood'));
  const latest   = await readJSON(filePath(base, ''));
  if(preferLastGood && lastGood) return lastGood;
  if(latest && !isEmptySnapshot(latest)) return latest;
  if(lastGood) return lastGood;
  for(let i=1;i<=HISTORY_DEPTH;i++){
    const h = await readJSON(filePath(base, `.${i}`));
    if(h && !isEmptySnapshot(h)) return h;
  }
  return latest || lastGood || null;
}

// ---------- app ----------
const app = express();

const allowedOrigins = [
  'https://izzapay.onrender.com',     // Pi app + game origin
  // 'http://localhost:3000',          // add your local dev origins if needed
  // 'http://127.0.0.1:3000',
];

// CORS that allows credentials (needed because the client now sends credentials:'include')
app.use(cors({
  origin(origin, cb) {
    // allow same-origin / server-to-server / curl (no Origin header) OR your allowlist
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error('CORS: origin not allowed'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// make caches/proxies vary per Origin
app.use((req, res, next) => { res.header('Vary', 'Origin'); next(); });

// Preflight handler (so OPTIONS succeeds with the same policy)
app.options('*', cors({
  origin(origin, cb) {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error('CORS: origin not allowed'));
  },
  credentials: true
}));

app.use(morgan('combined'));

// accept JSON and Safari/Pi sendBeacon text payloads
app.use(express.json({ limit:'1mb' }));
app.use(express.text({ type: ['text/plain','application/octet-stream'], limit:'1mb' }));

app.get('/healthz', (_req,res)=> res.json({ ok:true }));

app.get('/api/state/:username', async (req,res)=>{
  try{
    await ensureDir();
    const user = normUser(req.params.username);
    if(!user) return res.status(400).json({ error:'bad-username' });

    const preferLastGood = req.query.prefer === 'lastGood';
    const best = await readBest(user, preferLastGood);

    if(!best) return res.status(404).json({ error:'not-found' });
    res.set('Cache-Control','no-store');
    res.json(best);
  }catch(e){
    console.error('GET state error', e);
    res.status(500).json({ error:'server-error' });
  }
});

app.post('/api/state/:username', async (req,res)=>{
  try{
    await ensureDir();
    const user = normUser(req.params.username);
    if(!user) return res.status(400).json({ error:'bad-username' });

    let incoming = req.body;
    if(typeof incoming === 'string'){
      try{ incoming = JSON.parse(incoming); }catch{ incoming = {}; }
    }
    if(!isPlainObject(incoming)) return res.status(400).json({ error:'invalid-json' });

    const stamped = { ...incoming, timestamp: Date.now(), version: 1 };

    if(isEmptySnapshot(stamped)){
      // don’t overwrite lastGood on empty saves
      return res.status(202).json({ ok:true, ignored:true, reason:'empty-snapshot' });
    }

    await rotateHistory(user);
    await writeJSON(filePath(user,''), stamped);
    await writeJSON(filePath(user,'.lastgood'), stamped);
    res.json({ ok:true });
  }catch(e){
    console.error('POST state error', e);
    res.status(500).json({ error:'server-error' });
  }
});

// ---------------- LEADERBOARD (file-backed) ----------------
const LB_ROOT = process.env.LB_DIR || '/var/data/izza/leaderboards';
async function ensureLbDir(){ await fs.mkdir(LB_ROOT, { recursive: true }); }
function lbFile(game){ return path.join(LB_ROOT, `${game}.json`); }

async function readLB(game){
  await ensureLbDir();
  try { return JSON.parse(await fs.readFile(lbFile(game), 'utf8')); } catch { return []; }
}
async function writeLB(game, rows){
  await ensureLbDir();
  await fs.writeFile(lbFile(game), JSON.stringify(rows, null, 2), 'utf8');
}

function normGame(g){
  return String(g||'').toLowerCase().replace(/[^a-z0-9_\-\.]/g,'');
}
function sinceForPeriod(period){
  const now = Date.now();
  if (period === 'day')   return now - 24*60*60*1000;
  if (period === 'week')  return now - 7*24*60*60*1000;
  if (period === 'month') return now - 30*24*60*60*1000;
  return 0; // 'all'
}
function rankify(rows){
  // sort desc by score, then asc ts for determinism
  rows.sort((a,b)=> b.score - a.score || a.ts - b.ts);
  let lastScore = null, rank = 0, i = 0;
  for (const r of rows){
    i++;
    if (r.score !== lastScore){ rank = i; lastScore = r.score; }
    r.rank = rank;
  }
  return rows;
}

// POST /izza-game/api/leaderboard/submit
// body: { game:'jetman'|'race'|'basketball', score:Number, user?:string, ts?:Number }
app.post(['/izza-game/api/leaderboard/submit','/api/leaderboard/submit'], async (req,res)=>{
  try{
    let body = req.body;
    if (typeof body === 'string'){ try{ body = JSON.parse(body); }catch{ body = {}; } }

    const game  = normGame(body.game || 'unknown');
    const user0 = (body.user || req.query.u || '').toString().trim().toLowerCase();
    const user  = user0.replace(/^@+/,'').replace(/[^a-z0-9_\-\.]/g,'') || 'guest';
    const score = Number(body.score) | 0;
    const ts    = Number(body.ts) || Date.now();

    if (!game || !Number.isFinite(score) || score < 0){
      return res.status(400).json({ ok:false, error:'bad-input' });
    }

    const rows = await readLB(game);

    // keep the user's best score; replace only if higher
    const idx = rows.findIndex(r => r.user === user);
    if (idx >= 0){
      if (score > (rows[idx].score|0)){
        rows[idx] = { user, score, ts };
      } else {
        // keep existing best
      }
    } else {
      rows.push({ user, score, ts });
    }

    // keep last 500 (after sort)
    const top = rankify(rows).slice(0, 500);
    await writeLB(game, top);

    res.json({ ok:true, saved:{ user, game, score } });
  } catch(e){
    console.error('LB submit error', e);
    res.status(500).json({ ok:false, error:'server-error' });
  }
});

// GET /izza-game/api/leaderboard?game=jetman&limit=100&period=all|day|week|month&around=<user>
app.get(['/izza-game/api/leaderboard','/api/leaderboard'], async (req,res)=>{
  try{
    const game   = normGame(req.query.game || 'all');
    const limit  = Math.min( Math.max(parseInt(req.query.limit||'100',10)||100, 1), 200);
    const around = (req.query.around || '').toString().trim().toLowerCase().replace(/^@+/, '');
    const period = (req.query.period || 'all').toString().toLowerCase();

    const since  = sinceForPeriod(period);

    // helper to load and filter one board
    async function loadBoard(g){
      let rows = await readLB(g);
      if (since) rows = rows.filter(r => Number(r.ts||0) >= since);
      return rankify(rows);
    }

    if (game !== 'all'){
      const ranked = await loadBoard(game);
      if (around){
        const i = ranked.findIndex(r => r.user === around);
        if (i === -1){
          return res.json({ ok:true, game, rows: ranked.slice(0, limit) });
        }
        const half = Math.max(5, Math.floor(limit/2));
        const start = Math.max(0, i - half);
        const end   = Math.min(ranked.length, start + limit);
        return res.json({ ok:true, game, rows: ranked.slice(start, end) });
      }
      return res.json({ ok:true, game, rows: ranked.slice(0, limit) });
    }

    // 'all' → combine best-per-user across known games
    // You can expand this list if you add more games.
    const games = ['jetman','race','basketball','city_chase'];
    const mapsByUser = new Map(); // user -> best score across games

    for (const g of games){
      const ranked = await loadBoard(g);
      for (const r of ranked){
        const cur = mapsByUser.get(r.user);
        if (!cur || r.score > cur.score){
          mapsByUser.set(r.user, { user:r.user, score:r.score, ts:r.ts, game:g });
        }
      }
    }

    const combined = rankify(Array.from(mapsByUser.values()));
    if (around){
      const i = combined.findIndex(r => r.user === around);
      const half = Math.max(5, Math.floor(limit/2));
      const start = i === -1 ? 0 : Math.max(0, i - half);
      const end   = Math.min(combined.length, start + limit);
      return res.json({ ok:true, game:'all', rows: combined.slice(start, end) });
    }
    res.json({ ok:true, game:'all', rows: combined.slice(0, limit) });
  } catch(e){
    console.error('LB get error', e);
    res.status(500).json({ ok:false, error:'server-error' });
  }
});

// ---------------------------------------------------------------------------
// ADDED: Real AI SVG endpoint  (WITH OPTIONAL ANIMATION + PAYWALL)
// ---------------------------------------------------------------------------

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const SVG_MODEL_ID   = process.env.SVG_MODEL_ID   || 'gpt-4.1-mini';

// Animation add-on price (client can show/charge this; server only strips/keeps anim)
const ANIM_PRICE_IC  = parseInt(process.env.ANIM_PRICE_IC || '150', 10);

// Tight SVG sanitizer — keeps only safe, inline <svg>
function sanitizeSVG(svg) {
  try {
    const max = 200_000;
    let t = String(svg || '').trim();
    if (!t) return '';
    if (t.length > max) t = t.slice(0, max);
    if (/(<!DOCTYPE|<script|\son\w+=|<iframe|<foreignObject)/i.test(t)) return '';
    if (/\b(xlink:href|href)\s*=\s*['"](?!#)/i.test(t)) return '';
    if (!/^<svg\b[^>]*>[\s\S]*<\/svg>\s*$/i.test(t)) return '';
    // strip cruft, keep viewBox if present
    t = t
      .replace(/<\?xml[\s\S]*?\?>/gi, '')
      .replace(/<!DOCTYPE[^>]*>/gi, '')
      .replace(/<metadata[\s\S]*?<\/metadata>/gi, '')
      .replace(/\s+xmlns:xlink="[^"]*"/i, '');
    return t;
  } catch { return ''; }
}

// Remove animation if creator hasn’t paid yet
function stripAnimations(svg) {
  let t = String(svg || '');
  // Remove SMIL animation elements
  t = t.replace(/<\s*animate(?:Transform|Motion)?\b[^>]*>(?:[\s\S]*?<\/\s*animate(?:Transform|Motion)?\s*>|)/gi, '');
  // Remove CSS keyframes blocks
  t = t.replace(/@keyframes[\s\S]*?}\s*}/gi, '');
  // Remove animation-* CSS properties (basic strip; keeps other styles)
  t = t.replace(/animation\s*:[^;"]*;?/gi, '')
       .replace(/animation-(name|duration|timing-function|delay|iteration-count|direction|fill-mode|play-state)\s*:[^;"]*;?/gi, '');
  // Remove data-anim flags if present
  t = t.replace(/\sdata-anim="[^"]*"/gi, '');
  return t;
}

// ----------------- MAXED SYSTEM PROMPT (NO sizing changes) -----------------
const SYSTEM_PROMPT = `
You generate SVG overlays for IZZA. Convert the player's text into an original, safe, vector-only overlay.

OUTPUT (strict):
• Return ONE <svg> element, transparent background. No prose/comments.
• Vector only: <path>, <rect>, <circle>, <polygon>, <g>, <defs>, <linearGradient>, <radialGradient>, <filter> with <feGaussianBlur>/<feDropShadow>. Optional <style>.
• No <image>, no bitmaps, no <foreignObject>, no external href, no event handlers.

COMPOSITION & FIT:
• Fit art tightly (0–2px padding). Center visually. Must read at ~28px inventory size.
• Layer order: base → occlusion shadows → specular highlights → edge accents → optional glow/FX.
• Arms/legs are two distinct sides; hands (weapons) are horizontal. Never draw full-canvas backgrounds.

SLOTS (unchanged):
- helmet: viewBox="0 0 128 128"
- vest:   viewBox="0 0 128 128"
- arms:   viewBox="0 0 160 120"
- legs:   viewBox="0 0 140 140"
- hands:  viewBox="0 0 160 100"

STYLE ROUTER:
• REALISTIC → **real materials**: brushed/polished metals (steel, gold, brass, titanium), glass & gemstones, leather grains, woods, carbon/kevlar weaves, fabric weaves, ceramic glaze. Soft ambient occlusion, controlled specular, micro-bevels. Thin/clean outlines only (avoid >1.4), no flat emoji icons.
• CARTOON / ANIME → bold silhouettes & confident outlines, 2–3 tone cel shading, speed lines/energy streaks allowed. Must still have light/dark separation (avoid single flat fills).
• STYLIZED → neon luxury street: punchy shapes, precise highlights, tasteful glow stacks and occult/tech motifs.

REFERENCE HANDLING (broad but safe):
• Understand slang, memes, games, anime, cartoons, and TV. **Evoke** the vibe with original, legally distinct motifs. Avoid exact logos/wordmarks, title typography, or 1:1 character copies. No real-person likenesses; use generic archetypes.
• Currency / “dead presidents” → banknote engraving cues: guilloché curves, micro-hatching, oval bust frame, security flourishes in green/black; use a **generic** bust or symbols (no real identities).
• Network/era vibes (Cartoon Network/Nick/Disney/YTV/Family Channel) → channel-era *feel* via shapes/color language and cel shading—not exact characters.

ARMOUR vs APPAREL INTENT:
• If the text clearly asks apparel (gloves, scarf, bandana, hat, sunglasses, crown, tiara), render apparel; **do not** add armor plates.
• If materials imply armor (steel/plate/chain/kevlar/ceramic/titanium/gold), render armor with those materials; apparel bits may be accents.
• Examples:
  – “arms with red gloves” → forearms + red gloves (no armor).
  – “arms of steel and gold with red gloves” → armored forearms (two sides) in steel+gold, red glove accents.
  – “pirate hat” on helmet → a pirate hat silhouette, face area open.

FACE POLICY (helmet slot):
• If the user says open face / no mask / hat → leave face area open; **never** output a blank featureless face.
• If a mask/visor is requested → include readable eye/visor/mouth cues (cutouts, slits, glow), not a blank slab.
• Default when ambiguous → avoid blank faces: hint eyes/visor cutouts or keep face open.

MATERIAL / TEXTURE LIBRARY (invoke when mentioned or implied):
• Metals: brushed steel, gunmetal, anodized aluminum, polished/rose gold, brass, copper, titanium. Radial/linear specular streaks; micro-bevels; light edge wear.
• Stones & gems: diamond facet star glints, emerald/sapphire/ruby/jade, marble veins, granite speckle.
• Composites/ceramics: carbon-fiber weave, kevlar weave, ceramic glaze micro-speckle.
• Fabrics/leather: denim twill, canvas, knit ribbing, quilted padding, leather grain & stitching, suede nap, velvet sheen, satin highlight.
• Natural: wood growth rings, bark texture, water caustics, ice crystal facets, flame stacks (core→mid→blur), smoke wisps, sand/dust, aurora/galaxy gradients, clouds/sky bands, grass blades.

FASHION / SUBCULTURE CUES (if referenced):
• Streetwear/hip-hop/trap/drill: baggy drape, oversized cuffs, gold chains, iced stones, grills, graffiti tags (generic).
• Classic “gangster/mafia”: pinstripes, fedora-like hat, playing-card/chip motifs; noir palette with tasteful gold.
• Emo/goth/punk: skinny cuts, straps/studs, safety pins, torn hems, heavy liner shapes.
• Hipster/casual: beanie, round glasses, flannel checks, denim, earthy tones.
• High-fashion/couture: glossy piping, metallic trims, tasteful monogram-like repeats (generic), satin/velvet sheen.
• Kawaii/rainbow/unicorn: pastel gradients, sparkles, hearts/stars, clouds, rainbow arcs; soft outlines.
• Grunge/nightmare/horror: distressed textures, cracked enamel, drips, barbed contours, thorn silhouettes, gothic filigree.

ANIME / GAME VIBES (evoke, don’t copy):
• One Piece → adventurous pirate motifs, straw-hat nods, bold cel shading.
• Pokémon → cute rounded chibi energy, elemental icons; legally distinct.
• Dragon Ball / DBZ → spiky energy auras, speed lines, hard cel shadows, rim lights.
• Tactical shooters (CoD-like) → matte polymers, rails, cerakote tan/black, realistic wear.
• Stealth-tech (MGS-like) → subdued palettes, crisp specular on industrial panels.
• Hero shooters (Overwatch/Valorant-like) → stylized hard surfaces, saturated accents, decals (generic).
• Fantasy/Soulslike/Zelda-like → engraved metals, leather straps, gem inlays, mystic glyphs (generic).
• Halo/Destiny-like → armored alloys with emissive seams, clean bevels.
• Fortnite-like → chunky playful shapes, clean bevels, bold contrast.

ACCESSORIES / PATTERNS / COLORS (when asked):
• Accessories: crowns/tiaras, headbands, bandanas, scarves, goggles/sunglasses (aviator, square, round), earrings, nose rings, chains, pendants, nails, makeup/face paint (abstract).
• Patterns: woodland/desert/urban camo (generic), tiger/cheetah print, plaid, tartan, pinstripe, argyle, checkerboard, tie-dye swirl, geometric repeats, guilloché.
• Palettes: neon, pastel, monochrome, earth-tones, metallics, iridescent/oil-slick, color-shift “anodized”.

ANIMATION (if allowed for this item):
• Use at most 1–2 lightweight loops via <animate>/<animateTransform> or CSS @keyframes; silhouette must look complete if paused. No JS.

METADATA ON ROOT:
• data-slot="helmet|vest|arms|legs|hands"
• If FX used, data-fx="glow,flame,energy,smoke,water,ice"
• If any animation present, data-anim="1"

CHECKLIST (self-verify before emitting):
• Correct slot viewBox, transparent background, no full-bleed rects.
• Arms/legs are two sides; hands are horizontal.
• Realistic = believable materials; Cartoon = anime/cel shading; Stylized = neon luxury street.
• Helmet face is NEVER blank; obey “open face” vs “mask/visor” intent.
`;

// === INSERT A: goes right after const SYSTEM_PROMPT = `...`; ===

// Broad, safe “evoke” lexicons (no logos/likenesses). Each adds a short hint when matched.
const REFERENCE_LEXICON = [
  { re:/\b(one\s*piece|luffy|straw\s*hat)\b/i, add:'Adventure-pirate anime vibe: open-face hat, bold cel-shading; legally distinct.' },
  { re:/\b(pok[eé]mon|pikachu|pika)\b/i,       add:'Cute chibi energy, rounded forms, electric icons; legally distinct.' },
  { re:/\b(dragon\s*ball|dbz|super\s*saiyan)\b/i, add:'Spiky energy aura, speed lines, hard cel-shadows.' },
  { re:/\b(call\s*of\s*duty|cod)\b/i,          add:'Tactical polymers, rails, matte cerakote tan/black, realistic wear.' },
  { re:/\b(metal\s*gear|mgs)\b/i,              add:'Industrial stealth-tech: subdued palette, crisp panel specular.' },
  { re:/\b(overwatch|valorant)\b/i,            add:'Stylized hard-surface bevels, saturated accents, generic decals.' },
  { re:/\b(zelda|souls|soulslike)\b/i,         add:'Engraved metals, leather straps, gem inlays, mystic glyphs.' },
  { re:/\b(halo|destiny)\b/i,                  add:'Armored alloys with emissive seams and clean bevels.' },
  { re:/\b(fortnite)\b/i,                      add:'Chunky playful shapes, bold contrast, clean bevels.' },

  // Money / engraving vibe (generic, no real faces)
  { re:/\b(dead\s*president|banknote|bill|money|cash|currency)\b/i,
    add:'Banknote engraving vibe: guilloché curves, micro-hatching, oval bust frame, security flourishes in green/black; use a generic bust (no real likeness).' },

  // Streetwear / culture (safe, non-logo)
  { re:/\bstreetwear|hip\s*hop|trap|drill\b/i,
    add:'Baggy drape, oversized cuffs, gold chain silhouettes, iced stone glints, generic graffiti drips (no text).' },

  // “Gangster/mafia” as fashion vibe (no people/brands)
  { re:/\b(gangster|mafia|noir)\b/i,
    add:'Pinstripes, fedora-like hat cues, playing-card/chip motifs; noir palette with tasteful gold.' },

  // Emo/goth/punk etc.
  { re:/\b(emo|goth|punk|metalhead)\b/i,
    add:'Skinny cuts, straps/studs, safety pins, torn hems, heavy liner shapes.' },

  // Kawaii / rainbow / unicorn
  { re:/\b(kawaii|unicorn|rainbow|sparkle)\b/i,
    add:'Pastel gradients, hearts/stars, cloud puffs, gentle sparkles.' },

  // Cannabis-only (safe stylization)
  { re:/\b(weed|cannabis|marijuana|ganja|kush|indica|sativa|hemp|420)\b/i,
    add:'Cannabis styling: 5–7 pointed leaf silhouettes, hemp-rope braid accents, soft smoke wisps, neon grow-glow; motifs stylized/generic.' },
];

const PATTERN_LEXICON = [
  { re:/\bcamo|camouflage\b/i,       add:'Generic woodland/desert/urban camo blocks; no military insignia.' },
  { re:/\btartan|plaid|flannel\b/i,  add:'Balanced tartan/plaid repeats with subtle fabric weave.' },
  { re:/\bpin\s*stripe|pinstripe\b/i,add:'Fine pinstripes with soft specular on peaks.' },
  { re:/\bargyle\b/i,                add:'Diamond argyle tiling with thin separators.' },
  { re:/\bcheetah|tiger|leopard\b/i, add:'Animal print, tasteful scaling and edge softening.' },
  { re:/\bchecker(board)?\b/i,       add:'High-contrast checkers with slight motion skew.' },
  { re:/\btie[-\s]?dye\b/i,          add:'Spiral tie-dye gradient bands.' },
  { re:/\bguilloch[eé]\b/i,          add:'Banknote guilloché wave curves and rosettes.' },
  { re:/\bhoundstooth\b/i,           add:'Sharp houndstooth tessellation, small scale.' },
  { re:/\bhex(agon)?\b/i,            add:'Hex tiling with micro-bevels, sci-fi panel vibe.' },
];

const COLOR_LEXICON = [
  { re:/\b(emerald|jade|forest)\b/i, add:'Green ramp (deep→emerald→mint) with gemstone/leafy cues.' },
  { re:/\b(cobalt|royal|navy)\b/i,   add:'Blue ramp (navy→cobalt→sky) with cool rim lights.' },
  { re:/\b(crimson|scarlet|ruby)\b/i,add:'Rich red ramp with ruby glints.' },
  { re:/\b(amber|saffron|goldenrod)\b/i, add:'Warm yellow-orange metallic option.' },
  { re:/\b(lilac|lavender|amethyst)\b/i, add:'Soft violet ramp with delicate sheen.' },
  { re:/\b(teal|turquoise|aqua)\b/i, add:'Blue-green ramp with watery caustic highlights.' },
  { re:/\b(burgundy|maroon|wine)\b/i,add:'Deep red-violet with velvet glow.' },
  { re:/\b(steel|gunmetal|slate)\b/i,add:'Cool gray ramp; brushed/stone specular cues.' },
  { re:/\bpastel\s*rainbow\b/i,      add:'Soft multi-stop rainbow (rose→peach→lemon→mint→sky→lilac).' },
  { re:/\bneon\s*rainbow\b/i,        add:'High-sat rainbow with glow stacks at edges.' },
];
// ----------------- EXTRA STREET / CANNABIS-ONLY + COLOR/PATTERN EXPANSIONS -----------------

REFERENCE_LEXICON.push(
  // Street life (clean, non-violent cues)
  { re:/\bstreet\s?life|block|hood|urban\b/i,
    add:'Urban texture cues: concrete speckle, brick-line suggestions, street sign silhouettes, reflective paint striping, generic tags (no words).' },
  { re:/\bgraffiti|tag(ging)?|throw[- ]?up|stencil\b/i,
    add:'Graffiti vibe: fat-cap drips, bubble throw shapes, stencil cutouts, spray mist haloes—no readable words or logos.' },
  { re:/\bboombox|cassette|mixtape|turntable|vinyl\b/i,
    add:'Retro audio nods: cassette/record icon shapes, equalizer bars, speaker cones, needle arm silhouettes (generic).' },
  { re:/\blowrider|custom\b/i,
    add:'Candy-paint pinstripes, metallic flake sheen, chrome trims with star glints (generic vehicle cues only).' },
  { re:/\bbodega|corner\s*store\b/i,
    add:'Awning stripes, neon OPEN-style glow, shelf stripe hints—no brand names, no text.' },

  // Cannabis / weed ONLY (no other drugs; keep it tasteful & stylized)
  { re:/\b(weed|cannabis|marijuana|mary\s*jane|ganja|kush|indica|sativa|hemp|420)\b/i,
    add:'Cannabis styling: 5–7 pointed leaf silhouettes with vein hints, hemp-rope braid details, grinder/water-drop glass cues, earthy greens; optional smoke wisps and neon “grow” glow. No paraphernalia realism; keep motifs abstract/stylized.' },
  { re:/\bleaf\b/i,
    add:'Leaf motifs: layered leaflets with midrib veins, slight gloss on edges, dewdrop specular highlights if “fresh” is implied.' },
  { re:/\bsmoke|cloud|puff\b/i,
    add:'Soft smoke wisps built from layered translucent paths and light blur; avoid heavy opacity.' },
  { re:/\bgrow|hydro|buds?\b/i,
    add:'Bud/flower abstraction: clustered teardrop scales with tiny sparkle glints; keep shapes generic and readable at small size.' },
);

PATTERN_LEXICON.push(
  // More patterns
  { re:/\bpaisley\b/i,             add:'Paisley droplets and curlicues in layered repeats; fine line accents.' },
  { re:/\bfloral|flowers?\b/i,     add:'Stylized petals/leaves in repeat; lightweight outlines and soft gradients.' },
  { re:/\bmoir[eé]\b/i,            add:'Moire wave interference lines; thin balanced strokes, avoid shimmer artifacts.' },
  { re:/\bchevron\b/i,             add:'Zigzag chevrons in even rhythm with highlight edges.' },
  { re:/\bhoundstooth\b/i,         add:'Houndstooth tessellation; keep scale small and crisp.' },
  { re:/\bpolka\s*dots?\b/i,       add:'Evenly spaced dots with subtle volumetric shading (not flat).' },
  { re:/\bhex(agon(al)?)?\b/i,     add:'Hex grid/tiling with subtle bevels; sci-fi panel vibe.' },
  { re:/\bscale(s)?|fish\s*scale\b/i, add:'Overlapped scale pattern with edge specular; gradient from top to bottom.' },
  { re:/\bcloud\s*pattern\b/i,     add:'Soft cloud bands in parallax curves; gentle vertical gradient.' },
  { re:/\bstarry|galaxy|nebula\b/i,add:'Star speckle fields, nebula swirl gradients, tiny cross-spark flares.' },
  { re:/\bchecker\s*racing|racing\s*flag\b/i, add:'High-contrast checkers with motion skew; subtle tire-rub streaks.' },
);

COLOR_LEXICON.push(
  // Much wider palette references
  { re:/\b(navy|royal|cobalt)\s*blue\b/i, add:'deep to mid blue ramp with cool rim lights.' },
  { re:/\b(emerald|forest|mint)\s*green\b/i, add:'green ramp (forest→emerald→mint) with gemstone or leafy cues.' },
  { re:/\b(crimson|scarlet|ruby)\b/i,    add:'rich red ramp with subtle specular; ruby glints if gem-like.' },
  { re:/\b(magenta|fuchsia|hot\s*pink)\b/i, add:'bold magenta/fuchsia with neon bloom option.' },
  { re:/\b(amber|saffron|goldenrod)\b/i, add:'warm yellow-orange with metallic edge options.' },
  { re:/\b(lilac|lavender|amethyst)\b/i, add:'soft violet ramp with delicate sheen; amethyst if gem-like.' },
  { re:/\b(teal|turquoise|aqua)\b/i,     add:'blue-green ramp, coastal vibe, optional caustic highlights.' },
  { re:/\b(rose|blush|salmon)\b/i,       add:'rosy pinks with satin highlights.' },
  { re:/\b(olive|khaki|tan|beige)\b/i,   add:'earth neutrals with fabric/leather options.' },
  { re:/\b(burgundy|maroon|wine)\b/i,    add:'deep red-violets with velvet glow.' },
  { re:/\b(steel|gunmetal|slate)\b/i,    add:'cool gray ramp with brushed/stone specular cues.' },
  { re:/\bpastel\s*rainbow\b/i,          add:'soft multi-stop gradient (rose→peach→lemon→mint→sky→lilac).' },
  { re:/\bneon\s*rainbow\b/i,            add:'high-saturation gradient with glow stacks on edges.' },
);

// Build short additive hints based on user text
function expandWithLexicons(txt){
  if (!txt) return '';
  const adds = [];
  for (const x of REFERENCE_LEXICON) if (x.re.test(txt)) adds.push(x.add);
  for (const x of PATTERN_LEXICON)   if (x.re.test(txt)) adds.push(x.add);
  for (const x of COLOR_LEXICON)     if (x.re.test(txt)) adds.push(x.add);
  // Make a compact bullet list the model can follow (no layout/sizing info)
  return adds.length ? 'HINTS:\n• ' + adds.join('\n• ') : '';
}

// --- Helpers: style detection & scoring heuristics ---
function detectStyleFromPrompt(prompt, explicit) {
  // explicit UI choice (Realistic vs Cartoon / Stylized) always wins
  if (explicit && /^(realistic|cartoon|stylized)$/i.test(explicit)) {
    return explicit.toLowerCase();
  }
  const p = (prompt||'').toLowerCase();

  // Anime / shōnen / game-art cues
  const animeOrGame =
    /(anime|manga|shōnen|shonen|cel[-\s]?shade|chibi|one\s*piece|luffy|pokemon|pokémon|pikachu|dragon\s*ball|dbz|naruto|ghibli|persona|zelda|genshin|overwatch|valorant|street\s*fighter|fortnite)/i.test(p) ||
    /(call\s*of\s*duty|cod|metal\s*gear|mgs|gta|grand\s*theft\s*auto)/i.test(p);

  // Real-material / natural-element cues
  const realMaterials =
    /(photo|photoreal|realistic|pbr|physically\s*based|steel|iron|gold|silver|chrome|aluminum|copper|brass|leather|denim|cotton|wool|velvet|wood|oak|mahogany|marble|granite|stone|concrete|diamond|gem|crystal|glass|rust|patina|mud|water|flame|fire|smoke|sky|cloud|grass|sand|snow|ice)/i.test(p);

  if (animeOrGame && !realMaterials) return 'cartoon';
  if (realMaterials && !animeOrGame) return 'realistic';
  // Default to realistic if materials dominate words; otherwise anime cartoon.
  return realMaterials ? 'realistic' : 'cartoon';
}

function scoreSvgQuality(s, mode) {
  if (!s) return -1;
  const t = s.toLowerCase();
  let score = 0;
  const count = (re)=> (t.match(re)||[]).length;

  const lin = count(/<lineargradient/g), rad = count(/<radialgradient/g), fil = count(/<filter/g);
  const pathCount = count(/<path/g);
  const strokeThick = count(/stroke-width="(?:3(\.\d+)?|[4-9]\d*(\.\d+)?)"/g);

  if (mode === 'realistic' || mode === 'stylized') {
    score += lin*3 + rad*3 + fil*2 + pathCount*1;
    if (mode === 'realistic') score -= strokeThick*3; // avoid very thick toon lines in realism
  } else { // cartoon (anime)
    score += pathCount*2 + (lin+rad)*1 + fil*1;
  }
  return score;
}

app.post('/api/crafting/ai_svg', async (req, res) => {
  try {
    const body       = (typeof req.body === 'string') ? JSON.parse(req.body) : (req.body || {});
    const prompt     = String(body.prompt || '').trim().slice(0, 700);
    const meta       = body.meta || {};
    const partIn     = String(meta.part || 'helmet').toLowerCase().slice(0, 16);
    const name       = String(meta.name || '').slice(0, 64);
    const wantAnim   = !!meta.animate;
    const animPaid   = !!meta.animationPaid;
        const styleParam = (meta.style || 'auto').toLowerCase(); // 'auto'|'realistic'|'cartoon'|'stylized'
    const style      = detectStyleFromPrompt(prompt, styleParam === 'auto' ? '' : styleParam);

    // Add lexicon-based hint expansion RIGHT AFTER style detection
    const lexHints   = expandWithLexicons(prompt);

    if (!prompt) return res.status(400).json({ ok:false, reason:'empty-prompt' });
    if (!OPENAI_API_KEY) return res.status(503).json({ ok:false, reason:'no-api-key' });

    // Slot table (unchanged)
    const SLOT = {
      helmet: { vb:'0 0 128 128', box:{w:38,h:38} },
      vest:   { vb:'0 0 128 128', box:{w:40,h:40} },
      arms:   { vb:'0 0 160 120', box:{w:38,h:38} },
      legs:   { vb:'0 0 140 140', box:{w:40,h:40} },
      hands:  { vb:'0 0 160 100', box:{w:36,h:36} },
    };
    const part = SLOT[partIn] ? partIn : 'helmet';
    const { vb, box } = SLOT[part];
    const ORIENT_RIGHT_HINT =
  part === 'hands'
    ? 'ORIENTATION: For hands/guns, draw the weapon facing RIGHT — barrel/muzzle on the right (+X), stock/grip on the left. Keep the root <svg> unrotated and unflipped; internal symmetry is fine.'
    : '';

    const animHint = wantAnim ? `
ANIMATION (if used):
• Keep to 1–2 lightweight loops via <animate>/<animateTransform> or CSS @keyframes in <style>.
• Subtle pulses, glow breaths, gentle flame lick. No JS. Static silhouette must look complete if paused.
` : '';

    const modeHint =
      style === 'realistic' ? `STYLE: REALISTIC — depict **actual real materials/natural elements** with believable PBR-like shading using vectors (base+AO+specular+edge wear). Avoid thick toon outlines (>1.4).`
    : style === 'cartoon'   ? `STYLE: ANIME/SHŌNEN — bold clean outlines, cel-shading, crisp highlights, readable silhouettes. If a specific anime/game is named (One Piece, Pokémon, DBZ, CoD, MGS, GTA), echo its visual vibe (no logos/text).`
                             : `STYLE: STYLIZED — luxury-street neon with occult vibe; bold but layered with highlights and glow stacks.`;

    // Build user message lines
    const userLines = [
  `Part: ${part}`,
  name ? `Name: ${name}` : null,
  `Prompt: ${prompt}`,
  lexHints,
  `Use viewBox="${vb}". Fit composition tightly for ~${box.w}×${box.h} overlay.`,
  `Arms/legs must be left+right, not a single blob. Hands (weapons) must be horizontal.`,
  ORIENT_RIGHT_HINT,
  modeHint,
  animHint
];

    // Helmet face rule (avoid blank faces when ambiguous)
    if (
      part === 'helmet' &&
      !/\b(eye|visor|mask|mouth|smile|grin|teeth|goggles|glasses|open\s*face|hat|bandana|scarf)\b/i.test(prompt)
    ) {
      userLines.push('Helmet face should not be blank; include an open-face area or subtle visor/eye cutouts.');
    }

    const userMsg = userLines.filter(Boolean).join('\n');

    // Sampling temps by style
    const temperature = style === 'realistic' ? 0.45
                      : style === 'cartoon'   ? 0.9
                                              : 0.7;

    // BIG settings you chose
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'authorization': `Bearer ${OPENAI_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: SVG_MODEL_ID,
        temperature,
        max_tokens: 2500,
        n: 8,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user',   content: userMsg }
        ]
      })
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(()=> '');
      console.error('[ai_svg] upstream error', resp.status, txt.slice(0, 500));
      return res.status(502).json({ ok:false, reason:'llm-upstream', raw: txt.slice(0, 400) });
    }

    const data = await resp.json().catch(()=> ({}));
    const candidates = (data?.choices || []).map(c => (c?.message?.content||'').trim()).filter(Boolean);
    if (!candidates.length) return res.status(502).json({ ok:false, reason:'no-candidate' });

    // choose best per style heuristic
    let best = candidates[0], bestScore = scoreSvgQuality(best, style);
    for (let i=1;i<candidates.length;i++){
      const sc = scoreSvgQuality(candidates[i], style);
      if (sc > bestScore) { best = candidates[i]; bestScore = sc; }
    }

    let svg = sanitizeSVG(best);
    if (!svg) {
      console.error('[ai_svg] sanitize fail; len=', best.length);
      return res.status(422).json({ ok:false, reason:'sanitize-fail' });
    }

    let animationStripped = false;
    if (wantAnim && !animPaid) {
      const stripped = stripAnimations(svg);
      if (stripped !== svg) animationStripped = true;
      svg = stripped;
    }

    res.json({
      ok: true,
      svg,
      style,
      animated: wantAnim && animPaid,
      animationStripped,
      priceIC: ANIM_PRICE_IC
    });
  } catch (e) {
    console.error('ai_svg error', e);
    res.status(500).json({ ok:false, reason:'server-error' });
  }
});
// ---------------------------------------------------------------------------
// CRAFTED ITEMS STORAGE (per-user)
// Files live alongside snapshots as <user>.crafted.json
// GET  /api/crafting/mine?u=<username>
// POST /api/crafting/mine?u=<username>   body: { name, category, part, svg, sku?, image? }
// GET  /api/crafting/mine/meta?u=<username>   -> [{id,name,image,sku}]
// ---------------------------------------------------------------------------

function craftedPath(user){ return filePath(user, '.crafted'); }
function isSafeUser(u){ return !!normUser(u); }

function sanitizeSvgTight(svg){
  try{
    let t = String(svg||'').trim();
    if(!t) return '';
    if(t.length > 200_000) t = t.slice(0,200_000);
    if(!/^<svg\b[^>]*>[\s\S]*<\/svg>\s*$/i.test(t)) return '';
    if (/(<!DOCTYPE|<script|\son\w+=|<iframe|<foreignObject)/i.test(t)) return '';
    if (/\b(xlink:href|href)\s*=\s*['"](?!#)/i.test(t)) return '';
    // strip background styles on root (optional)
    t = t.replace(/(<svg\b[^>]*\sstyle\s*=\s*["'][^"']*)\bbackground(?:-color)?\s*:[^;"']+;?/i, (_,pre)=>pre);
    return t;
  }catch{ return ''; }
}

async function readCrafted(user){
  const j = await readJSON(craftedPath(user));
  if(Array.isArray(j)) return j;
  return [];
}

async function writeCrafted(user, list){
  await writeJSON(craftedPath(user), Array.isArray(list) ? list : []);
}

// --- GET full objects (includes svg) ---
app.get('/api/crafting/mine', async (req,res)=>{
  try{
    const u = normUser(req.query.u||'');
    if(!isSafeUser(u)) return res.status(400).json({ ok:false, reason:'missing-user' });
    await ensureDir();
    const rows = await readCrafted(u);
    res.set('Cache-Control','no-store');
    res.json({ ok:true, items: rows.slice(-500) });
  }catch(e){
    console.error('GET /api/crafting/mine', e);
    res.status(500).json({ ok:false, reason:'server-error' });
  }
});

// --- Slim meta list for merchant dropdown (no svg for speed) ---
app.get('/api/crafting/mine/meta', async (req,res)=>{
  try{
    const u = normUser(req.query.u||'');
    if(!isSafeUser(u)) return res.status(400).json({ ok:false, reason:'missing-user' });
    await ensureDir();
    const rows = await readCrafted(u);
    const out = rows.map(r=>({
      id:  r.id,
      name: r.name,
      image: r.image || '',
      sku: r.sku || ''
    }));
    res.set('Cache-Control','no-store');
    res.json({ ok:true, items: out });
  }catch(e){
    console.error('GET /api/crafting/mine/meta', e);
    res.status(500).json({ ok:false, reason:'server-error' });
  }
});

// --- POST to append one crafted item ---
import crypto from 'crypto';
function newId(){ return crypto.randomBytes(8).toString('hex'); }

app.post('/api/crafting/mine', async (req,res)=>{
  try{
    const u = normUser(req.query.u||'');
    if(!isSafeUser(u)) return res.status(400).json({ ok:false, reason:'missing-user' });
    await ensureDir();

    let body = req.body;
    if(typeof body === 'string'){
      try{ body = JSON.parse(body); }catch{ body = {}; }
    }
    const name = String(body.name||'').slice(0,64).trim();
    const category = String(body.category||'armour').slice(0,24);
    const part = String(body.part||'helmet').slice(0,16);
    const sku  = String(body.sku||'').slice(0,32);
    const image = String(body.image||'').slice(0,256);
    const svgRaw = body.svg || '';

    if(!name || !svgRaw) return res.status(400).json({ ok:false, reason:'missing-fields' });

    const svg = sanitizeSvgTight(svgRaw);
    if(!svg) return res.status(422).json({ ok:false, reason:'bad-svg' });

    const rows = await readCrafted(u);
    const id = newId();
    rows.push({
      id, name, category, part, svg,
      sku, image,
      created_at: Date.now()
    });

    // keep last 500
    const limited = rows.slice(-500);
    await writeCrafted(u, limited);

    res.json({ ok:true, id });
  }catch(e){
    console.error('POST /api/crafting/mine', e);
    res.status(500).json({ ok:false, reason:'server-error' });
  }
});
// ----------------- end patch -----------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, ()=> console.log(`IZZA persistence on ${PORT} (root=${ROOT})`));
