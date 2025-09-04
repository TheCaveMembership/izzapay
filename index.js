// index.js — IZZA persistence service (rotation + LastGood + CORS + healthz)
// Node 18+ (CommonJS)

const path    = require('path');
const fs      = require('fs').promises;
const express = require('express');
const morgan  = require('morgan');
const cors    = require('cors');

const app = express();

// ---------- storage config ----------
const ROOT = process.env.DATA_DIR || '/var/data/izza/players';
const HISTORY_DEPTH = 5;

async function ensureDir() { await fs.mkdir(ROOT, { recursive: true }); }
function normUser(u){ return String(u||'').trim().toLowerCase().replace(/[^a-z0-9_\-\.]/g,''); }

function filePath(base, suffix){ return path.join(ROOT, `${base}${suffix||''}.json`); }

async function readJSON(file){
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; }
}
async function writeJSON(file, obj){
  await fs.writeFile(file, JSON.stringify(obj, null, 2), 'utf8');
}

function isPlainObject(o){ return !!o && typeof o==='object' && !Array.isArray(o); }
function isEmptySnapshot(snap){
  if(!isPlainObject(snap)) return true;
  if(snap.version !== 1) return false; // future versions: treat as non-empty
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
  // .(HISTORY_DEPTH-1) -> .HISTORY_DEPTH
  for(let i=HISTORY_DEPTH-1;i>=1;i--){
    const src=filePath(base, `.${i}`), dst=filePath(base, `.${i+1}`);
    try{ await fs.rename(src,dst); }catch{}
  }
  // current -> .1
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

// ---------- middleware ----------
app.use(cors());
app.use(morgan('combined'));
// accept normal JSON and also text/plain (Safari sendBeacon)
app.use(express.json({ limit:'1mb' }));
app.use(express.text({ type: ['text/plain','application/octet-stream'], limit:'1mb' }));

// ---------- routes ----------
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
      // do NOT overwrite lastGood on empty saves
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

const PORT = process.env.PORT || 10000;
app.listen(PORT, ()=> console.log(`IZZA persistence on ${PORT}`));
