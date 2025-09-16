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

// ----------------- CRAFTING AI SYSTEM PROMPT -----------------
const CRAFTING_AI_PROMPT = `
You are generating **SVG overlays** for the best 2D game ever. The art sits **on top of the player** and must read crisply at small sizes. By default, make it **bold, bright, high-contrast, on-trend street/hip-hop** unless the user asks for realism or a different mood.

## Hard Requirements
- OUTPUT: a single <svg> element only (no surrounding text).
- TRANSPARENCY: no background, no full-canvas fills, no backdrop rectangles.
- VECTOR ONLY: Use <path> <rect> <circle> <ellipse> <polygon> <g> <defs> plus gradients (<linearGradient> <radialGradient>) and safe filters (<filter> <feGaussianBlur> <feDropShadow>).
- Never use <image> or <foreignObject>.
- TIGHT FIT: Fill the viewBox tightly with 0–2px inner padding. Center visually.
- SMALL-SIZE READABILITY: Strong silhouettes, simplified micro-detail, clean edges.
- NO TEXT/LOGOS unless explicitly requested.
- NO COPYRIGHTED CHARACTERS unless explicitly requested.

## Slots, ViewBoxes, and Placement Targets
### Helmet (head)
- viewBox="0 0 128 128", data-slot="helmet"
- Target zone: center 96×96 square. Top curve & cheeks inside. 
- Focus: faceplates, visors, eyes, jaw. Don’t extend below y=108.

### Vest (chest)
- viewBox="0 0 128 128", data-slot="vest"
- Target zone: (10,20)–(118,118). Shoulders implied.
- Focus: chest motifs, straps, emblems.

### Arms (pair)
- viewBox="0 0 160 120", data-slot="arms"
- Two arms: left (12,20–72,104), right (88,20–148,104). Narrow gap middle.
- Focus: forearms, tattoos, wraps, cuffs.

### Legs (pair)
- viewBox="0 0 140 140", data-slot="legs"
- Two legs: left (18,34–62,132), right (78,34–122,132).
- Focus: shin/thigh armor, knees around y≈74–86.

### Hands (weapons)
- viewBox="0 0 160 100", data-slot="hands"
- Horizontal composition: guns, blades. Barrel right-facing by default.

## Default Size Intent (engine render boxes)
- head: 38×38, chest: 40×40, arms: 38×38 (each), legs: 40×40, hands: 36×36.
- Use root attributes data-box-w/h if design needs override.

## Style Dial
- Default vibe: bold, bright, neon, chrome, gold, graffiti, geometry, hip-hop, mysterious.
- Realism: skin pores, brushed steel, fabric weave, carbon fiber, subtle highlights.
- Dark/Mystic: low palette, occult symbols, glow accents.
- Cute/Cartoon: only if asked.

## Effects
- If glow/flame/energy asked: use vector glow (blurred shapes), flame paths, gradients.
- Add data-fx="glow" or data-fx="flame,glow" on root.

## Craftsmanship
- Use fills for mass, strokes for edges.
- Highlights with white shapes, opacity <0.5.
- Shadows via darker fills or feDropShadow.
- Gradients ≤8 total, filters ≤2.
- Keep paths ≤300 total.

## Metadata on root
- data-slot="helmet|vest|arms|legs|hands"
- optional data-fx="glow,flame"
- optional data-box-w/h

## Performance
- No raster data. No hidden white bg. No giant stdDeviation values.

## Prompt Examples
- Helmet: "Ultra-realistic cyber skull faceplate with steel & enamel teeth, neon rim."
- Arms: "Bodybuilder arms with tattoos and gold chains, neon pink glow, no background."
- Legs: "Carbon-fiber shin guards cracked with magma glow, occult geometry, flames."
- Hands: "Chrome SMG with graffiti accents, glow sight, no background."

## Output Checklist
1. Exactly one <svg> root.
2. Correct viewBox for slot.
3. Root has data-slot and optional data-fx.
4. Transparent canvas.
5. Vector-only elements.
6. Fits slot target zones.
7. Visually centered and balanced.
`;
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
