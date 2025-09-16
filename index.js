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

// ----------------- PLAYER-CONTROLLED STYLE SVG GEN (patch) -----------------
const SYSTEM_PROMPT = `
You generate SVG overlays for IZZA: hip hop, streetwear, neon-mystic. The PLAYER is in control:
- Style can be "realistic", "cartoon", or "stylized". If not specified, infer from the text.

OUTPUT (strict):
• Return ONLY one <svg> element. Transparent background. No prose.
• Vector only: <path>, <rect>, <circle>, <polygon>, <g>, <defs>, <linearGradient>, <radialGradient>, <filter> with <feGaussianBlur>, <feDropShadow>. Optional <style> for CSS.
• No <image>, no bitmaps, no <foreignObject>, no external href, no events.

COMPOSITION:
• Fit art tightly (0–2px padding). Center visually. Must read at ~28px.
• Use layered shading: base → occlusion shadows → specular highlights → edge accents → optional glow/FX (if asked).

SLOTS:
- helmet: viewBox="0 0 128 128" — headwear/face-plate; believable planes if realism; clear mask/visor shapes allowed.
- vest:   viewBox="0 0 128 128" — chest/torso; keep shoulders inside bounds.
- arms:   viewBox="0 0 160 120" — two separate forearm motifs (left/right). No single central blob.
- legs:   viewBox="0 0 140 140" — two balanced leg elements (thigh→shin). No single mono-shape.
- hands:  viewBox="0 0 160 100" — horizontal weapon/blade/gun layout.

ENGINE OVERLAY TARGETS (center your focal mass roughly to these crafted overlay boxes):
• head 38×38, chest 40×40, arms 38×38, legs 40×40, hands 36×36.
• World transforms approx: helmet s2.80 oy-12; vest s2.40 oy+3; arms s2.60 oy+2; legs s2.45 oy+10.

STYLE MODES (follow the chosen/ inferred mode):
• REALISTIC — believable materials (brushed/polished metal, glass, leather), soft AO shadows, controlled specular, micro-bevels. Avoid thick outlines (>1.4). Avoid flat emoji shapes.
• CARTOON — clean, confident shapes; you MAY use thicker outlines and bolder silhouettes. Still avoid flat single-fill icons: include at least light/dark separation or subtle gradient.
• STYLIZED — luxury-street neon with occult flair; bold shapes plus layered highlights and glows.

EFFECTS:
• If user asks for glow/energy/flames: build vector glow stacks (inner solid, mid translucent, outer blurred) and flame paths with blur. No bitmaps.
• If animation is present, prefer 1–2 lightweight loops via <animate>/<animateTransform> or CSS @keyframes in <style>. No JS.

METADATA ON ROOT:
• data-slot="helmet|vest|arms|legs|hands"
• If FX used, data-fx="glow,flame,energy"
• If animation present, data-anim="1"

CHECKLIST (self-verify before emitting):
• Correct slot viewBox. No full-canvas background rect.
• Arms/legs are two sides; hands (weapon) is horizontal.
`;

// --- Helpers: style detection & scoring heuristics ---
function detectStyleFromPrompt(prompt, explicit) {
  if (explicit && /^(realistic|cartoon|stylized)$/i.test(explicit)) {
    return explicit.toLowerCase();
  }
  const p = (prompt||'').toLowerCase();
  const realismHits = /(realistic|photo|photoreal|metal|chrome|glass|leather|texture|bevel|specular|raytraced|physically based|pbr)/.test(p);
  const cartoonHits = /(cartoon|anime|manga|chibi|cel|comic|flat|bold outline|toon)/.test(p);
  const stylizedHits = /(neon|glow|mystic|occult|luxury|streetwear|graffiti|vaporwave|cyberpunk)/.test(p);
  if (realismHits && !cartoonHits) return 'realistic';
  if (cartoonHits && !realismHits) return 'cartoon';
  if (stylizedHits) return 'stylized';
  // fallback vibe for IZZA
  return 'stylized';
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
    // penalize thick cartoon lines only in realistic mode
    if (mode === 'realistic') score -= strokeThick*3;
  } else { // cartoon
    // cartoon prefers strong shapes but still some layering
    score += pathCount*2 + (lin+rad)*1 + fil*1;
    // no penalty for thick lines
  }
  return score;
}

// --- Sanitizers (unchanged except we also block @import in <style>) ---
function sanitizeSVG(svg) {
  try {
    const max = 200_000;
    let t = String(svg || '').trim();
    if (!t) return '';
    if (t.length > max) t = t.slice(0, max);
    if (/(<!DOCTYPE|<script|\son\w+=|<iframe|<foreignObject)/i.test(t)) return '';
    if (/\b(xlink:href|href)\s*=\s*['"](?!#)/i.test(t)) return '';
    if (!/^<svg\b[^>]*>[\s\S]*<\/svg>\s*$/i.test(t)) return '';
    // remove @import or url() with external refs in styles
    t = t.replace(/@import[\s\S]*?;?/gi,'').replace(/url\(\s*['"]?(https?:)?\/\//gi,'url(#');
    t = t
      .replace(/<\?xml[\s\S]*?\?>/gi, '')
      .replace(/<!DOCTYPE[^>]*>/gi, '')
      .replace(/<metadata[\s\S]*?<\/metadata>/gi, '')
      .replace(/\s+xmlns:xlink="[^"]*"/i, '');
    return t;
  } catch { return ''; }
}

function stripAnimations(svg) {
  let t = String(svg || '');
  t = t.replace(/<\s*animate(?:Transform|Motion)?\b[^>]*>(?:[\s\S]*?<\/\s*animate(?:Transform|Motion)?\s*>|)/gi, '');
  t = t.replace(/@keyframes[\s\S]*?}\s*}/gi, '');
  t = t.replace(/animation\s*:[^;"]*;?/gi, '')
       .replace(/animation-(name|duration|timing-function|delay|iteration-count|direction|fill-mode|play-state)\s*:[^;"]*;?/gi, '');
  t = t.replace(/\sdata-anim="[^"]*"/gi, '');
  return t;
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

    if (!prompt) return res.status(400).json({ ok:false, reason:'empty-prompt' });
    if (!OPENAI_API_KEY) return res.status(503).json({ ok:false, reason:'no-api-key' });

    const SLOT = {
      helmet: { vb:'0 0 128 128', box:{w:38,h:38} },
      vest:   { vb:'0 0 128 128', box:{w:40,h:40} },
      arms:   { vb:'0 0 160 120', box:{w:38,h:38} },
      legs:   { vb:'0 0 140 140', box:{w:40,h:40} },
      hands:  { vb:'0 0 160 100', box:{w:36,h:36} },
    };
    const part = SLOT[partIn] ? partIn : 'helmet';
    const { vb, box } = SLOT[part];

    const animHint = wantAnim ? `
ANIMATION (if used):
• Keep to 1–2 lightweight loops via <animate>/<animateTransform> or CSS @keyframes in <style>.
• Subtle pulses, glow breaths, gentle flame lick. No JS. Static silhouette must look complete if paused.
` : '';

    const modeHint =
      style === 'realistic' ? `STYLE: REALISTIC — believable materials, soft AO, controlled specular, micro-bevels. Avoid thick outlines (>1.4) and flat emoji shapes.`
    : style === 'cartoon'   ? `STYLE: CARTOON — bold shapes with confident outlines allowed; still include light/dark separation or gradients (avoid single flat one-color icons).`
                             : `STYLE: STYLIZED — luxury-street neon with occult vibe; bold but layered with highlights and glow stacks.`;

    const userMsg = [
      `Part: ${part}`,
      name ? `Name: ${name}` : null,
      `Prompt: ${prompt}`,
      `Use viewBox="${vb}". Fit composition tightly for ~${box.w}×${box.h} overlay.`,
      `Arms/legs must be left+right, not a single blob. Hands (weapons) must be horizontal.`,
      modeHint,
      animHint
    ].filter(Boolean).join('\n');

    const temperature = style === 'realistic' ? 0.45
                      : style === 'cartoon'   ? 0.9
                                              : 0.7;

    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'authorization': `Bearer ${OPENAI_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: SVG_MODEL_ID,
        temperature,
        max_tokens: 1800,
        n: 2,
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
// ----------------- end patch -----------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, ()=> console.log(`IZZA persistence on ${PORT} (root=${ROOT})`));
