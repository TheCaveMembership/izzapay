// server/api-state.js
// Express router that persists player snapshots with rotation + "LastGood" protection.
//
// Endpoints:
//   GET  /api/state/:username            -> latest valid snapshot (falls back to LastGood)
//   GET  /api/state/:username?prefer=lastGood -> force LastGood
//   POST /api/state/:username            -> validate + write (keeps last 5), updates LastGood iff valid & non-empty
//
// Storage layout (DATA_DIR = process.env.DATA_DIR || './var/data'):
//   <user>.json            -> latest write attempt (even if invalid is rejected, this file stays last valid)
//   <user>.1.json .. .5.json  -> rolling history (1 = newest history, 5 = oldest)
//   <user>.lastgood.json   -> last known good (non-empty) snapshot
//
// "Empty/bad" snapshot detection prevents saving sessions that reset progress to 0.

const path    = require('path');
const fs      = require('fs').promises;
const express = require('express');

const router  = express.Router();
router.use(express.json({ limit: '256kb' }));

// ---------- config ----------
const DATA_DIR = process.env.DATA_DIR || path.resolve(process.cwd(), 'var', 'data');
const HISTORY_DEPTH = 5;

// ensure data dir exists
async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

// safe helpers
async function readJSON(file) {
  try {
    const buf = await fs.readFile(file);
    return JSON.parse(buf.toString('utf8'));
  } catch (e) {
    return null;
  }
}
async function writeJSON(file, obj) {
  await fs.writeFile(file, JSON.stringify(obj, null, 2), 'utf8');
}

function normUser(u) {
  return String(u || '').trim().toLowerCase().replace(/[^a-z0-9_\-\.]/g, '');
}

function isPlainObject(o) {
  return !!o && typeof o === 'object' && !Array.isArray(o);
}

// "empty/bad" snapshot detection — tune as needed
function isEmptySnapshot(snap) {
  if (!isPlainObject(snap)) return true;
  if (snap.version !== 1) return false; // unknown future versions: treat as not-empty
  const coinsTop = (snap.coins|0) || 0;
  const invEmpty = !isPlainObject(snap.inventory) || Object.keys(snap.inventory).length === 0;
  const bankObj  = isPlainObject(snap.bank) ? snap.bank : {};
  const bankCoins = (bankObj.coins|0) || 0;
  const bankEmpty = bankCoins === 0 &&
                    (!isPlainObject(bankObj.items) || Object.keys(bankObj.items).length === 0) &&
                    (!isPlainObject(bankObj.ammo)  || Object.keys(bankObj.ammo).length  === 0);

  // treat as "empty" if nothing tangible stored
  const empty = coinsTop === 0 && invEmpty && bankEmpty;
  return empty;
}

// rotate <user>.N.json -> <user>.(N+1).json, up to HISTORY_DEPTH
async function rotateHistory(userBase) {
  for (let i = HISTORY_DEPTH - 1; i >= 1; i--) {
    const src = path.join(DATA_DIR, `${userBase}.${i}.json`);
    const dst = path.join(DATA_DIR, `${userBase}.${i+1}.json`);
    try { await fs.rename(src, dst); } catch {}
  }
  // move current -> .1
  const current = path.join(DATA_DIR, `${userBase}.json`);
  const hist1   = path.join(DATA_DIR, `${userBase}.1.json`);
  try { await fs.rename(current, hist1); } catch {}
}

// find best snapshot to serve
async function readBest(userBase, preferLastGood = false) {
  const lastGood = await readJSON(path.join(DATA_DIR, `${userBase}.lastgood.json`));
  const latest   = await readJSON(path.join(DATA_DIR, `${userBase}.json`));

  if (preferLastGood && lastGood) return lastGood;

  if (latest && !isEmptySnapshot(latest)) return latest;
  if (lastGood) return lastGood;

  // search history
  for (let i = 1; i <= HISTORY_DEPTH; i++) {
    const h = await readJSON(path.join(DATA_DIR, `${userBase}.${i}.json`));
    if (h && !isEmptySnapshot(h)) return h;
  }
  return latest || lastGood || null;
}

// ---------- routes ----------
router.get('/state/:username', async (req, res) => {
  try {
    await ensureDir();
    const user = normUser(req.params.username);
    if (!user) return res.status(400).json({ error: 'bad-username' });

    const preferLastGood = (req.query.prefer === 'lastGood');
    const best = await readBest(user, preferLastGood);

    if (!best) return res.status(404).json({ error: 'not-found' });

    // Small safety header for caches
    res.set('Cache-Control', 'no-store');
    return res.json(best);
  } catch (e) {
    console.error('GET state error', e);
    return res.status(500).json({ error: 'server-error' });
  }
});

router.post('/state/:username', async (req, res) => {
  try {
    await ensureDir();
    const user = normUser(req.params.username);
    if (!user) return res.status(400).json({ error: 'bad-username' });

    const incoming = req.body;
    if (!isPlainObject(incoming)) {
      return res.status(400).json({ error: 'invalid-json' });
    }

    // Always stamp a server-side timestamp (ms)
    const stamped = { ...incoming, timestamp: Date.now() };

    if (isEmptySnapshot(stamped)) {
      // DO NOT rotate or overwrite lastGood on empty saves
      // Optionally keep a "rejected" drop if you ever want to debug:
      // await writeJSON(path.join(DATA_DIR, `${user}.rejected-${Date.now()}.json`), stamped);
      return res.status(202).json({ ok: true, ignored: true, reason: 'empty-snapshot' });
    }

    // rotate history, then write current and update lastGood
    await rotateHistory(user);
    await writeJSON(path.join(DATA_DIR, `${user}.json`), stamped);
    await writeJSON(path.join(DATA_DIR, `${user}.lastgood.json`), stamped);

    return res.json({ ok: true });
  } catch (e) {
    console.error('POST state error', e);
    return res.status(500).json({ error: 'server-error' });
  }
});

module.exports = router;

/*
USAGE in your main server:
---------------------------------
const express = require('express');
const apiState = require('./server/api-state'); // <- this file
const app = express();

// (optional) CORS for your domain/app
app.use((req,res,next)=>{ res.set('Access-Control-Allow-Origin','*'); res.set('Access-Control-Allow-Headers','Content-Type'); if(req.method==='OPTIONS'){ return res.sendStatus(200); } next(); });

app.use('/api', apiState);

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log('Server listening on', PORT));
*/
