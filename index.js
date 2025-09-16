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
app.use(cors());
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

const SYSTEM_PROMPT = `
You are generating SVG for a 2D game overlay in IZZA — a hip hop, streetwear, neon-mystic vibe. Go bold and on-trend by default. Respect user realism when asked.

OUTPUT (strict):
• Return ONLY a single <svg> element. No prose, no code fences.
• Transparent background. Do NOT draw a full-canvas rect or any large background fill.
• Vector only: <path>, <rect>, <circle>, <polygon>, <g>, <defs>, <linearGradient>, <radialGradient>, <filter> with <feGaussianBlur> and <feDropShadow>.
• No <image>, no bitmaps, no <foreignObject>, no external href, no event handlers.

COMPOSITION:
• Fit artwork tightly in the viewBox with 0–2px padding. Center visually.
• Must read clearly at ~28px inventory size; use clean silhouettes and controlled detail.
• If user asks for glow/energy/flames: create layered vector glows (blurred paths) or stylized flame paths; no bitmaps.

SLOTS (select by "part"):
- helmet (head): viewBox="0 0 128 128". Face-plate/headwear. Strong facial features if prompt mentions faces.
- vest (chest): viewBox="0 0 128 128". Torso motif; keep shoulders within bounds.
- arms:        viewBox="0 0 160 120". Two forearms or paired arm motif spanning width. Avoid one central blob; honor left/right symmetry.
- legs:        viewBox="0 0 140 140". Two leg elements (thigh-to-shin). Balanced left/right.
- hands (weapon): viewBox="0 0 160 100". Horizontal weapon/blade/gun composition.

IN-GAME SIZING & PLACEMENT TARGETS (to match engine overlay draw):
• Crafted overlay boxes (px) — center your design for these:
  head 38×38, chest 40×40, arms 38×38, legs 40×40, hands 36×36.
• Engine world transforms (approx):
  helmet scale≈2.80 (ox≈0,   oy≈-12)
  vest   scale≈2.40 (ox≈0,   oy≈  3)
  arms   scale≈2.60 (ox≈0.3, oy≈  2)
  legs   scale≈2.45 (ox≈0.2, oy≈ 10)

STYLE GUIDANCE:
• Default tone: bright, creative, luxury-street “gangster” with occult/illuminati hints. Metals, glass, leather, chrome, gem glow.
• Realism on request: believable materials, subtle gradients, specular highlights, soft contact shadows via filters.
• Avoid “cartoon / chibi / flat icon” unless explicitly requested.

METADATA ON ROOT:
• Add data-slot="helmet|vest|arms|legs|hands".
• If effects used, add data-fx="glow", "flame", "energy", etc.
• If animation is present, add data-anim="1".

VALIDATION CHECKLIST (self-verify before final):
• Exactly one <svg> root; correct viewBox for the slot.
• No full-canvas background shapes.
• Artwork centered, tight fit (0–2px padding).
• Only allowed elements/filters used.
`;

// Route: AI SVG generator (animation optional)
app.post('/api/crafting/ai_svg', async (req, res) => {
  try {
    const body   = (typeof req.body === 'string') ? JSON.parse(req.body) : (req.body || {});
    const prompt = String(body.prompt || '').trim().slice(0, 700);
    const meta   = body.meta || {};
    const part   = String(meta.part || 'helmet').toLowerCase().slice(0, 16);   // helmet|vest|arms|legs|hands
    const name   = String(meta.name || '').slice(0, 64);
    const wantAnim = !!meta.animate;            // creator toggled "Add animation"
    const animPaid = !!meta.animationPaid;      // client sets true after purchase

    if (!prompt) return res.status(400).json({ ok:false, reason:'empty-prompt' });
    if (!OPENAI_API_KEY) return res.status(503).json({ ok:false, reason:'no-api-key' });

    const slotInfo = {
      helmet: { viewBox: '0 0 128 128', box: {w:38,h:38} },
      vest:   { viewBox: '0 0 128 128', box: {w:40,h:40} },
      arms:   { viewBox: '0 0 160 120', box: {w:38,h:38} },
      legs:   { viewBox: '0 0 140 140', box: {w:40,h:40} },
      hands:  { viewBox: '0 0 160 100', box: {w:36,h:36} }
    };
    const slot = slotInfo[part] ? part : 'helmet';
    const svb  = slotInfo[slot].viewBox;
    const box  = slotInfo[slot].box;

    // Extra instructions when animation is requested
    const animHint = wantAnim ? `
ANIMATION (required):
• Use lightweight, looped vector animation directly in the SVG. Prefer CSS @keyframes on groups or attributes, or SMIL <animate>/<animateTransform>.
• Keep it subtle and performant (1–2 running animations, 0.8–1.5s loops). No JS. No external refs.
• Examples: pulsing glow around edges, slow flame lick with blur, gentle rotate/slide for charms.
• Ensure the static silhouette still reads at 28px if animation is paused.
` : '';

    const userMessage = [
      `Part: ${slot}`,
      name ? `Name: ${name}` : null,
      `Prompt: ${prompt}`,
      `Use viewBox="${svb}" and center within a tight ${box.w}x${box.h} overlay box (no background).`,
      `Remember: two distinct side elements for arms/legs; horizontal layout for hands.`,
      animHint
    ].filter(Boolean).join('\n');

    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${OPENAI_API_KEY}`,
        'content-type':  'application/json'
      },
      body: JSON.stringify({
        model: SVG_MODEL_ID,
        temperature: 0.9,
        max_tokens: 1800,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user',   content: userMessage }
        ]
      })
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(()=> '');
      console.error('[ai_svg] upstream error', resp.status, txt.slice(0, 500));
      return res.status(502).json({ ok:false, reason:'llm-upstream', raw: txt.slice(0, 400) });
    }

    const data = await resp.json().catch(()=> ({}));
    const raw  = data?.choices?.[0]?.message?.content?.trim() || '';
    let svg    = sanitizeSVG(raw);
    if (!svg) {
      console.error('[ai_svg] sanitize fail; raw length=', raw.length);
      return res.status(422).json({ ok:false, reason:'sanitize-fail' });
    }

    // If animation requested but not paid, strip it and signal to the client
    let animationStripped = false;
    if (wantAnim && !animPaid) {
      const before = svg;
      const after  = stripAnimations(svg);
      if (after !== before) animationStripped = true;
      svg = after;
    }

    res.json({
      ok: true,
      svg,
      animated: wantAnim && animPaid,          // true only when allowed to keep animation
      animationStripped,                       // client can show upsell if true
      priceIC: ANIM_PRICE_IC                   // expose current add-on price to UI
    });
  } catch (e) {
    console.error('ai_svg error', e);
    res.status(500).json({ ok:false, reason:'server-error' });
  }
});
// --------------------------------------------------------------
// Show current model/key presence (for iPhone quick check)
app.get('/api/crafting/ai_info', (_req, res) => {
  res.json({
    ok: true,
    hasKey: !!OPENAI_API_KEY,
    model: SVG_MODEL_ID
  });
});

// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 10000;
app.listen(PORT, ()=> console.log(`IZZA persistence on ${PORT} (root=${ROOT})`));
