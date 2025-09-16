// index.js — IZZA persistence service (ESM)
// - Stores per-user snapshots under /var/data/izza/players
// - Keeps history (last 5) and a .lastgood.json that never gets overwritten by empty saves
// - Endpoints:
//     GET  /healthz
//     GET  /api/state/:username
//     GET  /api/state/:username?prefer=lastGood
//     POST /api/state/:username
//     POST /api/crafting/ai_svg          <-- ADDED (real AI SVG endpoint)

import express from 'express';
import morgan from 'morgan';
import cors from 'cors';
import { promises as fs } from 'fs';
import path from 'path';

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
// ADDED: Real AI SVG endpoint
// ---------------------------------------------------------------------------

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';         // set this!
const SVG_MODEL_ID   = process.env.SVG_MODEL_ID   || 'gpt-4.1-mini'; // pick your model

function sanitizeSVG(svg) {
  try {
    const max = 200_000;
    let t = String(svg || '').trim();
    if (!t) return '';
    if (t.length > max) t = t.slice(0, max);

    // Disallow dangerous constructs & external links
    if (/(<!DOCTYPE|<script|\son\w+=|<iframe|<foreignObject)/i.test(t)) return '';
    if (/\b(xlink:href|href)\s*=\s*['"](?!#)/i.test(t)) return ''; // external

    // Must be a single <svg>…</svg>
    if (!/^<svg\b[^>]*>[\s\S]*<\/svg>\s*$/i.test(t)) return '';

    // Normalize: ensure viewBox + preserveAspectRatio
    if (!/viewBox=/.test(t)) {
      t = t.replace(/<svg\b([^>]*)>/i,
        (m, attrs)=> `<svg ${attrs} viewBox="0 0 128 128" preserveAspectRatio="xMidYMid meet">`);
    }

    // Strip headers/metadata
    t = t
      .replace(/<\?xml[\s\S]*?\?>/gi, '')
      .replace(/<!DOCTYPE[^>]*>/gi, '')
      .replace(/<metadata[\s\S]*?<\/metadata>/gi, '')
      .replace(/\s+xmlns:xlink="[^"]*"/i, '');

    return t;
  } catch {
    return '';
  }
}

app.post('/api/crafting/ai_svg', async (req, res) => {
  try {
    const body = (typeof req.body === 'string') ? JSON.parse(req.body) : req.body || {};
    const prompt = String(body.prompt || '').trim().slice(0, 600);
    const meta = body.meta || {};
    const part = String(meta.part || 'helmet').slice(0, 16);
    const name = String(meta.name || '').slice(0, 64);

    if (!prompt) return res.status(400).json({ ok:false, reason:'empty-prompt' });
    if (!OPENAI_API_KEY) return res.status(503).json({ ok:false, reason:'no-api-key' });

    const system = [
      'You are an SVG generator for a 128x128 icon canvas.',
      'Return ONLY a single <svg> element. No prose, no code fences.',
      'Constraints:',
      '- viewBox="0 0 128 128", preserveAspectRatio="xMidYMid meet".',
      '- No <script>, no event handlers, no foreignObject, no external href.',
      '- Keep it reasonably small (<8KB).',
      '- Make the silhouette and composition reflect the prompt and part.',
      '- Prefer geometric shapes, paths, gradients (<defs>), light filters.',
      '- Vary shapes via rotation and layered overlays.',
      '- Icon should still read at ~28px.',
    ].join('\n');

    const user = [
      `Item part: ${part}`,
      name ? `Item name: ${name}` : '',
      `Prompt: ${prompt}`,
      'Output: a single <svg>…</svg> that fits the brief.'
    ].filter(Boolean).join('\n');

    // If you’re on Node ≤16, replace with:
    // import fetch from 'node-fetch'; and use that here.
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${OPENAI_API_KEY}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: SVG_MODEL_ID,
        temperature: 0.95,
        max_tokens: 1600,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ]
      })
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(()=> '');
      return res.status(502).json({ ok:false, reason:'llm-upstream', raw: txt.slice(0, 400) });
    }

    const data = await resp.json().catch(()=> ({}));
    const raw = data?.choices?.[0]?.message?.content?.trim() || '';
    const svg = sanitizeSVG(raw);
    if (!svg) return res.status(422).json({ ok:false, reason:'sanitize-fail' });

    res.json({ ok:true, svg });
  } catch (e) {
    console.error('ai_svg error', e);
    res.status(500).json({ ok:false, reason:'server-error' });
  }
});
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
