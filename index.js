// index.js — IZZA persistence service (ESM)
// - Stores per-user snapshots under /var/data/izza/players
// - Keeps history (last 5) and a .lastgood.json that never gets overwritten by empty saves
// - Endpoints:
//     GET  /healthz
//     GET  /api/state/:username
//     GET  /api/state/:username?prefer=lastGood
//     POST /api/state/:username
//     POST /api/crafting/ai_svg
//     GET  /api/crafting/ai_info
//     NEW MULTIPLAYER NODE ROUTES:
//       POST /api/mp/world/join
//       GET  /api/mp/worlds/counts
//       POST /api/mp/world/heartbeat
//       POST /api/mp/world/pos
//       GET  /api/mp/world/roster
//       POST /api/mp/world/leave
//       POST /api/mp/presence/offline
//       POST /api/mp/client-log
//     Also supports /izza-game/api/mp/... aliases.

import express from 'express';
import morgan from 'morgan';
import cors from 'cors';
import { promises as fs } from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import crypto from 'crypto';

// ---------- storage config ----------
const ROOT = process.env.DATA_DIR || '/var/data/izza/players';
const HISTORY_DEPTH = 5;

async function ensureDir() { await fs.mkdir(ROOT, { recursive: true }); }
function normUser(u){ return String(u||'').trim().toLowerCase().replace(/^@+/,'').replace(/[^a-z0-9_\-\.]/g,''); }
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
  if(snap.version !== 1) return false;
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
  'https://izzapay.onrender.com',
];

app.use(cors({
  origin(origin, cb) {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error('CORS: origin not allowed'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-IZZA-User', 'X-IZZA-Token']
}));

app.use((req, res, next) => { res.header('Vary', 'Origin'); next(); });

app.options('*', cors({
  origin(origin, cb) {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error('CORS: origin not allowed'));
  },
  credentials: true
}));

app.use(morgan('combined'));
app.use(express.json({ limit:'1mb' }));
app.use(express.text({ type: ['text/plain','application/octet-stream'], limit:'1mb' }));

app.get('/healthz', (_req,res)=> res.json({ ok:true }));

// ---------------------------------------------------------------------------
// MULTIPLAYER NODE BACKEND
// ---------------------------------------------------------------------------

const MP_WORLDS = ['1','2','3','4'];
const MP_TTL_MS = parseInt(process.env.MP_TTL_MS || '12000', 10);
const MP_MAX_PLAYERS_PER_WORLD = parseInt(process.env.MP_MAX_PLAYERS_PER_WORLD || '250', 10);

const mpState = {
  userWorld: new Map(),
  worlds: new Map(MP_WORLDS.map(w => [w, new Map()]))
};

function mpCoerceWorld(w){
  const s = String(w || '1').trim();
  return MP_WORLDS.includes(s) ? s : '1';
}

function mpTokenFromReq(req){
  const q = req.query?.t;
  if(q) return String(q).trim();

  const body = isPlainObject(req.body) ? req.body : {};
  if(body.t) return String(body.t).trim();

  const xTok = req.headers['x-izza-token'];
  if(xTok) return String(xTok).trim();

  const auth = String(req.headers.authorization || '');
  if(auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();

  return '';
}

function mpUsernameFromReq(req){
  const body = isPlainObject(req.body) ? req.body : {};

  const fromQuery =
    req.query?.u ||
    req.query?.user ||
    req.query?.username ||
    req.query?.pi_username ||
    '';

  const fromBody =
    body.u ||
    body.user ||
    body.username ||
    body.pi_username ||
    body?.appearance?.username ||
    '';

  const fromHeader =
    req.headers['x-izza-user'] ||
    req.headers['x-pi-username'] ||
    '';

  let u = normUser(fromQuery || fromBody || fromHeader);

  if(!u){
    const tok = mpTokenFromReq(req);
    try{
      const first = String(tok || '').split('.')[0] || '';
      const decoded = JSON.parse(Buffer.from(first, 'base64url').toString('utf8'));
      u = normUser(decoded.username || decoded.user || decoded.pi_username || decoded.handle || '');
    }catch{}
  }

  return u;
}

function mpRequireUser(req, res){
  const username = mpUsernameFromReq(req);
  const token = mpTokenFromReq(req);

  if(!username){
    console.warn('[MP] not_authenticated', {
      path:req.path,
      hasToken:!!token,
      query:req.query || {},
      bodyKeys:isPlainObject(req.body) ? Object.keys(req.body) : []
    });
    res.status(401).json({
      ok:false,
      error:'not_authenticated',
      reason:'missing_u',
      hint:'Pass ?u=<username>&t=<token> or JSON {u, t}.'
    });
    return null;
  }

  return { username, token };
}

function mpSweep(){
  const now = Date.now();

  for(const world of MP_WORLDS){
    const map = mpState.worlds.get(world);
    for(const [username, st] of map.entries()){
      if(now - Number(st.last || 0) > MP_TTL_MS){
        map.delete(username);
        if(mpState.userWorld.get(username) === world){
          mpState.userWorld.delete(username);
        }
      }
    }
  }
}

function mpCounts(){
  mpSweep();
  const out = {};
  for(const world of MP_WORLDS){
    out[world] = mpState.worlds.get(world).size;
  }
  return out;
}

function mpSetWorld(username, world){
  world = mpCoerceWorld(world);

  for(const w of MP_WORLDS){
    mpState.worlds.get(w).delete(username);
  }

  mpState.userWorld.set(username, world);

  const map = mpState.worlds.get(world);
  if(!map.has(username)){
    map.set(username, {
      username,
      world,
      x:0,
      y:0,
      facing:'down',
      appearance:{},
      inv:{},
      last:Date.now()
    });
  }

  return world;
}

function mpGetWorld(username){
  return mpState.userWorld.get(username) || '1';
}

function mpUpdatePlayer(username, world, patch){
  world = mpCoerceWorld(world || mpGetWorld(username));

  const map = mpState.worlds.get(world);
  const cur = map.get(username) || {
    username,
    world,
    x:0,
    y:0,
    facing:'down',
    appearance:{},
    inv:{},
    last:0
  };

  const next = {
    ...cur,
    username,
    world,
    x: Number.isFinite(Number(patch.x)) ? Number(patch.x) : Number(cur.x || 0),
    y: Number.isFinite(Number(patch.y)) ? Number(patch.y) : Number(cur.y || 0),
    facing: String(patch.facing || cur.facing || 'down').slice(0, 16),
    appearance: isPlainObject(patch.appearance) ? patch.appearance : (cur.appearance || {}),
    inv: isPlainObject(patch.inv) ? patch.inv : (cur.inv || {}),
    last: Date.now()
  };

  map.set(username, next);
  mpState.userWorld.set(username, world);
  return next;
}

const mpPaths = p => [`/api/mp${p}`, `/izza-game/api/mp${p}`];

app.post(mpPaths('/client-log'), (req,res)=>{
  try{
    const body = isPlainObject(req.body) ? req.body : {};
    console.log('[MP CLIENT]', JSON.stringify({
      event:body.event || 'client-log',
      world:body.world || '',
      data:body.data || {},
      href:body.href || '',
      ts:body.ts || Date.now()
    }).slice(0, 3000));
    res.json({ ok:true });
  }catch(e){
    console.warn('[MP CLIENT LOG ERROR]', e);
    res.json({ ok:true });
  }
});

app.post(mpPaths('/world/client-log'), (req,res)=>{
  try{
    const body = isPlainObject(req.body) ? req.body : {};
    console.log('[MP CLIENT WORLD]', JSON.stringify({
      event:body.event || 'client-log',
      world:body.world || '',
      data:body.data || {},
      href:body.href || '',
      ts:body.ts || Date.now()
    }).slice(0, 3000));
    res.json({ ok:true });
  }catch(e){
    console.warn('[MP CLIENT WORLD LOG ERROR]', e);
    res.json({ ok:true });
  }
});

app.post(mpPaths('/world/join'), (req,res)=>{
  const who = mpRequireUser(req,res);
  if(!who) return;

  const body = isPlainObject(req.body) ? req.body : {};
  const wanted = body.worldId || body.world || req.query.worldId || req.query.world || '1';
  const world = mpCoerceWorld(wanted);

  mpSweep();

  const count = mpState.worlds.get(world).size;
  const alreadyHere = mpGetWorld(who.username) === world;
  if(!alreadyHere && count >= MP_MAX_PLAYERS_PER_WORLD){
    return res.status(429).json({
      ok:false,
      error:'world_full',
      world,
      max:MP_MAX_PLAYERS_PER_WORLD
    });
  }

  mpSetWorld(who.username, world);

  console.log('[MP] join', {
    username:who.username,
    world,
    hasToken:!!who.token,
    counts:mpCounts()
  });

  res.set('Cache-Control','no-store');
  res.json({
    ok:true,
    world,
    username:who.username,
    counts:mpCounts(),
    ttlMs:MP_TTL_MS
  });
});

app.get(mpPaths('/worlds/counts'), (_req,res)=>{
  res.set('Cache-Control','no-store');
  res.json({ ok:true, counts:mpCounts(), serverNow:Date.now()/1000 });
});

app.post(mpPaths('/world/heartbeat'), (req,res)=>{
  const who = mpRequireUser(req,res);
  if(!who) return;

  const body = isPlainObject(req.body) ? req.body : {};
  const world = mpGetWorld(who.username);
  const st = mpUpdatePlayer(who.username, world, body);

  mpSweep();

  res.set('Cache-Control','no-store');
  res.json({
    ok:true,
    world,
    username:who.username,
    now:Date.now()/1000,
    player:{
      username:st.username,
      x:st.x,
      y:st.y,
      facing:st.facing,
      last:st.last
    }
  });
});

app.post(mpPaths('/world/pos'), (req,res)=>{
  const who = mpRequireUser(req,res);
  if(!who) return;

  const body = isPlainObject(req.body) ? req.body : {};
  const world = mpGetWorld(who.username);
  mpUpdatePlayer(who.username, world, {
    x:body.x,
    y:body.y,
    facing:body.facing
  });

  res.set('Cache-Control','no-store');
  res.json({ ok:true, world, now:Date.now()/1000 });
});

app.get(mpPaths('/world/roster'), (req,res)=>{
  const who = mpRequireUser(req,res);
  if(!who) return;

  mpSweep();

  const world = mpGetWorld(who.username);
  const since = Number(req.query.since || 0);
  const sinceMs = since > 9999999999 ? since : since * 1000;

  const players = [];
  const map = mpState.worlds.get(world);

  for(const [username, st] of map.entries()){
    if(username === who.username) continue;

    const last = Number(st.last || 0);
    if(sinceMs && last <= sinceMs) continue;

    players.push({
      id:username,
      username,
      x:Number(st.x || 0),
      y:Number(st.y || 0),
      facing:st.facing || 'down',
      appearance:st.appearance || {},
      inv:st.inv || {},
      lastUpdate:last / 1000
    });
  }

  res.set('Cache-Control','no-store');
  res.json({
    ok:true,
    world,
    players,
    serverNow:Date.now()/1000,
    counts:mpCounts()
  });
});

app.post(mpPaths('/world/leave'), (req,res)=>{
  const who = mpRequireUser(req,res);
  if(!who) return res.json({ ok:true });

  for(const world of MP_WORLDS){
    mpState.worlds.get(world).delete(who.username);
  }
  mpState.userWorld.delete(who.username);

  console.log('[MP] leave', { username:who.username });
  res.json({ ok:true });
});

app.post(mpPaths('/presence/offline'), (req,res)=>{
  const who = mpRequireUser(req,res);
  if(!who) return res.json({ ok:true });

  for(const world of MP_WORLDS){
    mpState.worlds.get(world).delete(who.username);
  }
  mpState.userWorld.delete(who.username);

  console.log('[MP] offline', { username:who.username });
  res.json({ ok:true });
});

app.get(mpPaths('/me'), (req,res)=>{
  const who = mpRequireUser(req,res);
  if(!who) return;

  const world = mpGetWorld(who.username);
  const st = mpState.worlds.get(world).get(who.username);
  const last = st ? Number(st.last || 0) : 0;

  res.set('Cache-Control','no-store');
  res.json({
    ok:true,
    username:who.username,
    active:!!st && Date.now() - last <= MP_TTL_MS,
    lastSeen:last,
    world,
    inviteLink:'/izza-game/auth'
  });
});

// ---------------------------------------------------------------------------
// STATE STORAGE
// ---------------------------------------------------------------------------

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

const GAME_CANON = Object.freeze({
  racing: 'race',
  race: 'race',
  jetman: 'jetman',
  basketball: 'basketball',
  puzzle: 'puzzle',
  targets: 'targets',
  runner: 'runner',
  city_chase: 'city_chase',
  all: 'all'
});
function canonGame(g){
  const k = normGame(g);
  return GAME_CANON[k] || k;
}

function canonPeriod(p){
  const x = String(p||'all').toLowerCase();
  if (x === 'alltime') return 'all';
  if (x === 'year' || x === 'annual') return 'year';
  return x;
}

function sinceForPeriod(period){
  const p = canonPeriod(period);
  const now = Date.now();
  if (p === 'day')   return now - 24*60*60*1000;
  if (p === 'week')  return now - 7*24*60*60*1000;
  if (p === 'month') return now - 30*24*60*60*1000;
  if (p === 'year')  return now - 365*24*60*60*1000;
  return 0;
}

function rankify(rows){
  rows.sort((a,b)=> b.score - a.score || a.ts - b.ts);
  let lastScore = null, rank = 0, i = 0;
  for (const r of rows){
    i++;
    if (r.score !== lastScore){ rank = i; lastScore = r.score; }
    r.rank = rank;
  }
  return rows;
}

app.post(['/izza-game/api/leaderboard/submit','/api/leaderboard/submit'], async (req,res)=>{
  try{
    let body = req.body;
    if (typeof body === 'string'){ try{ body = JSON.parse(body); }catch{ body = {}; } }

    const game  = canonGame(body.game || 'unknown');
    const user0 = (body.user || req.query.u || '').toString().trim().toLowerCase();
    const user  = user0.replace(/^@+/,'').replace(/[^a-z0-9_\-\.]/g,'') || 'guest';
    const score = Number(body.score) | 0;
    const ts    = Number(body.ts) || Date.now();

    if (!game || !Number.isFinite(score) || score < 0){
      return res.status(400).json({ ok:false, error:'bad-input' });
    }

    const rows = await readLB(game);

    const idx = rows.findIndex(r => r.user === user);
    if (idx >= 0){
      if (score > (rows[idx].score|0)){
        rows[idx] = { user, score, ts };
      }
    } else {
      rows.push({ user, score, ts });
    }

    const top = rankify(rows).slice(0, 500);
    await writeLB(game, top);

    res.json({ ok:true, saved:{ user, game, score } });
  } catch(e){
    console.error('LB submit error', e);
    res.status(500).json({ ok:false, error:'server-error' });
  }
});

app.get(['/izza-game/api/leaderboard','/api/leaderboard'], async (req,res)=>{
  try{
    const game   = canonGame(req.query.game || 'all');
    const limit  = Math.min( Math.max(parseInt(req.query.limit||'100',10)||100, 1), 200);
    const around = (req.query.around || '').toString().trim().toLowerCase().replace(/^@+/, '');
    const period = canonPeriod(req.query.period || 'all');
    const since  = sinceForPeriod(period);

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

    const games = ['jetman','race','basketball','puzzle','targets','runner','city_chase'];
    const mapsByUser = new Map();

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
// AI SVG endpoint
// ---------------------------------------------------------------------------

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const SVG_MODEL_ID   = process.env.SVG_MODEL_ID   || 'gpt-4.1';
const ANIM_PRICE_IC  = parseInt(process.env.ANIM_PRICE_IC || '150', 10);

function sanitizeSVG(svg) {
  try {
    const max = 200_000;
    let t = String(svg || '').trim();
    if (!t) return '';
    if (t.length > max) t = t.slice(0, max);
    if (/(<!DOCTYPE|<script|\son\w+=|<iframe|<foreignObject)/i.test(t)) return '';
    if (/\b(xlink:href|href)\s*=\s*['"](?!#)/i.test(t)) return '';
    if (!/^<svg\b[^>]*>[\s\S]*<\/svg>\s*$/i.test(t)) return '';
    t = t
      .replace(/<\?xml[\s\S]*?\?>/gi, '')
      .replace(/<!DOCTYPE[^>]*>/gi, '')
      .replace(/<metadata[\s\S]*?<\/metadata>/gi, '')
      .replace(/\s+xmlns:xlink="[^"]*"/i, '');
    return t;
  } catch { return ''; }
}

function stripAnimations(svg) { return String(svg || ''); }

const SYSTEM_PROMPT = `
You generate SVG overlays for IZZA. Convert the player's text into an original, safe, vector-only overlay.

OUTPUT (strict):
• Return ONE <svg> element, transparent background. No prose/comments.
• Vector only: <path>, <rect>, <circle>, <ellipse>, <polygon>, <polyline>, <g>, <defs>,
  <clipPath>, <mask>,
  <linearGradient>, <radialGradient>,
  <filter> (feGaussianBlur, feDropShadow, feColorMatrix, feBlend). Optional <style>.
• No <image>, no bitmaps, no <foreignObject>, no external href, no event handlers.

COMPOSITION & FIT:
• Fit art tightly (0–2px padding). Center visually. Must read at ~28px inventory size.
• Layer order: base → occlusion shadows → specular highlights → edge accents → optional glow/FX.
• Arms/legs are two distinct sides; hands (weapons) are horizontal. Never draw full-canvas backgrounds.
• When hair/foliage/flames are requested, build layered silhouettes (back/mid/front). Use <clipPath> for widow’s-peak hairlines, bangs, and interior cut-outs. Avoid “plain triangle crowns.”
• Infer missing context. Keep the provided slot viewBox and overlay sizing.

SLOTS (unchanged):
- helmet: viewBox="0 0 128 128"
- vest:   viewBox="0 0 128 128"
- arms:   viewBox="0 0 160 120"
- legs:   viewBox="0 0 140 140"
- hands:  viewBox="0 0 160 100"

STYLE ROUTER:
• REALISTIC → real materials, soft AO, specular, micro-bevels.
• CARTOON / ANIME → bold silhouettes, cel shading, confident outlines.
• STYLIZED → neon luxury street, precise highlights, tasteful glow stacks.

REFERENCE HANDLING:
• Evoke vibes with original legally distinct motifs. No logos, wordmarks, exact characters, or real-person likenesses.

FACE POLICY:
• Helmet face is never blank. Use open-face area or visor/eye cutouts.

QUALITY:
• Compose like a top studio concept sheet.
`;

const REFERENCE_LEXICON = [
  { re:/\b(one\s*piece|luffy|straw\s*hat)\b/i, add:'Adventure-pirate anime vibe: open-face hat, bold cel-shading; legally distinct.' },
  { re:/\b(pok[eé]mon|pokemon|pikachu|pika)\b/i, add:'Cute chibi energy, rounded forms, electric icons; legally distinct.' },
  { re:/\b(dragon\s*ball|dbz|super\s*saiyan)\b/i, add:'Spiky energy aura, speed lines, hard cel-shadows.' },
  { re:/\b(call\s*of\s*duty|cod)\b/i, add:'Tactical polymers, rails, matte cerakote tan/black, realistic wear.' },
  { re:/\b(dead\s*president|banknote|bill|money|cash|currency)\b/i, add:'Banknote engraving vibe: guilloché curves, micro-hatching, oval bust frame; generic bust.' },
];

const SPORTS_LEXICON = [
  { re:/\bhockey\b/i,  add:'Sports: hockey → mask/visor cage options, ear covers, chin strap, stick/puck cues.' },
  { re:/\bfootball\b/i,add:'Sports: football → helmet shell + facemask bars; jersey yoke.' },
  { re:/\bsoccer/i, add:'Sports: soccer → kit jersey neckline, shin guards/cleats, ball pattern.' },
  { re:/\bbasketball\b/i, add:'Sports: basketball → sleeveless jersey/neck rib, ball channel lines.' },
];

const PATTERN_LEXICON = [
  { re:/\bcamo|camouflage\b/i, add:'Generic camo blocks; no military insignia.' },
  { re:/\btartan|plaid|flannel\b/i, add:'Balanced tartan/plaid repeats with subtle fabric weave.' },
  { re:/\bchecker(board)?\b/i, add:'High-contrast checkers with slight motion skew.' },
  { re:/\btie[-\s]?dye\b/i, add:'Spiral tie-dye gradient bands.' },
];

const COLOR_LEXICON = [
  { re:/\b(emerald|jade|forest)\b/i, add:'Green ramp with gemstone/leafy cues.' },
  { re:/\b(cobalt|royal|navy)\b/i, add:'Blue ramp with cool rim lights.' },
  { re:/\b(crimson|scarlet|ruby)\b/i, add:'Rich red ramp with ruby glints.' },
  { re:/\bneon\s*rainbow\b/i, add:'High-saturation gradient with glow stacks.' },
];

function expandWithLexicons(txt){
  if (!txt) return '';
  const adds = [];
  for (const x of REFERENCE_LEXICON) if (x.re.test(txt)) adds.push(x.add);
  for (const x of SPORTS_LEXICON)    if (x.re.test(txt)) adds.push(x.add);
  for (const x of PATTERN_LEXICON)   if (x.re.test(txt)) adds.push(x.add);
  for (const x of COLOR_LEXICON)     if (x.re.test(txt)) adds.push(x.add);
  return adds.length ? 'HINTS:\n• ' + adds.join('\n• ') : '';
}

function detectStyleFromPrompt(prompt, explicit) {
  if (explicit && /^(realistic|cartoon|stylized)$/i.test(explicit)) {
    return explicit.toLowerCase();
  }
  const p = (prompt||'').toLowerCase();
  const animeOrGame =
    /(anime|manga|cel[-\s]?shade|chibi|one\s*piece|pokemon|pokémon|dragon\s*ball|dbz|naruto|zelda|overwatch|valorant|fortnite)/i.test(p);
  const realMaterials =
    /(photo|photoreal|realistic|pbr|steel|iron|gold|silver|chrome|leather|denim|wood|marble|stone|diamond|gem|crystal|glass|water|flame|fire|smoke|snow|ice)/i.test(p);
  if (animeOrGame && !realMaterials) return 'cartoon';
  if (realMaterials && !animeOrGame) return 'realistic';
  return realMaterials ? 'realistic' : 'cartoon';
}

function scoreSvgQuality(s, mode) {
  if (!s) return -1;
  const t = s.toLowerCase();
  const count = (re)=> (t.match(re)||[]).length;
  let score = 0;
  score += count(/<path\b/g)*2;
  score += count(/<lineargradient\b/g)*2;
  score += count(/<radialgradient\b/g)*2;
  score += count(/<filter\b/g);
  score += count(/<clippath\b/g)*4;
  score += count(/<mask\b/g)*4;
  if (mode === 'realistic') score -= count(/stroke-width="(?:3(\.\d+)?|[4-9]\d*(\.\d+)?)"/g)*2;
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
    const styleParam = (meta.style || 'auto').toLowerCase();
    const style      = detectStyleFromPrompt(prompt, styleParam === 'auto' ? '' : styleParam);
    const lexHints   = expandWithLexicons(prompt);

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

    const userMsg = [
      `Part: ${part}`,
      name ? `Name: ${name}` : null,
      `Prompt: ${prompt}`,
      lexHints,
      `Use viewBox="${vb}". Fit composition tightly for ~${box.w}×${box.h} overlay.`,
      part === 'hands' ? 'For hands/guns, draw the weapon facing RIGHT.' : '',
      style === 'realistic'
        ? 'STYLE: REALISTIC — believable vector materials, AO, specular, edge wear.'
        : style === 'cartoon'
          ? 'STYLE: ANIME/CARTOON — bold outlines, cel shading, readable silhouettes.'
          : 'STYLE: STYLIZED — neon luxury street with highlights and glow.',
      wantAnim ? 'ANIMATION: At most 1–2 lightweight loops. No JS.' : ''
    ].filter(Boolean).join('\n');

    const temperature = style === 'realistic' ? 0.45 : style === 'cartoon' ? 0.9 : 0.7;

    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'authorization': `Bearer ${OPENAI_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: SVG_MODEL_ID,
        temperature,
        top_p: 0.95,
        presence_penalty: 0.1,
        frequency_penalty: 0.05,
        max_tokens: 6000,
        n: 12,
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
      const kept = stripAnimations(svg);
      animationStripped = kept !== svg ? true : false;
      svg = kept;
    }

    res.json({
      ok: true,
      svg,
      style,
      animated: wantAnim,
      animationStripped,
      priceIC: ANIM_PRICE_IC
    });
  } catch (e) {
    console.error('ai_svg error', e);
    res.status(500).json({ ok:false, reason:'server-error' });
  }
});

// ---------------------------------------------------------------------------
// CRAFTED ITEMS STORAGE
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

    const limited = rows.slice(-500);
    await writeCrafted(u, limited);

    res.json({ ok:true, id });
  }catch(e){
    console.error('POST /api/crafting/mine', e);
    res.status(500).json({ ok:false, reason:'server-error' });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, ()=> console.log(`IZZA persistence on ${PORT} (root=${ROOT}) + Node MP routes ready`));
