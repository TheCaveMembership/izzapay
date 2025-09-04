// server/api-state.js (router)
// Persistence API for IZZA — per-user JSON snapshot ring with empty-snapshot protection.

import { Router } from 'express';
import fs from 'fs/promises';
import path from 'path';

const api = Router();

// ---- config ----
const ROOT = '/var/data/izza/players';
const MAX_SNAPSHOTS = parseInt(process.env.IZZA_MAX_SNAPS || '10', 10);

// ---- fs helpers ----
async function ensureDir() {
  await fs.mkdir(ROOT, { recursive: true });
}
function safeUser(user) {
  return String(user || 'guest').toLowerCase().replace(/[^a-z0-9-_]/g, '-');
}
function fileFor(user) {
  return path.join(ROOT, `${safeUser(user)}.json`);
}
async function readUserFile(user) {
  try {
    const f = fileFor(user);
    const raw = await fs.readFile(f, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
async function writeUserFile(user, data) {
  const f = fileFor(user);
  await fs.writeFile(f, JSON.stringify(data, null, 2), 'utf8');
}

// ---- domain helpers ----
// What we consider an “empty-like” snapshot that should NOT become the new latest.
function isEmptyLike(snap) {
  if (!snap || typeof snap !== 'object') return true;
  const coins = Number(snap.coins || 0);
  const bankCoins = Number((snap.bank && snap.bank.coins) || 0);
  const inv = snap.inventory || {};
  const hasInv = Array.isArray(inv)
    ? inv.length > 0
    : Object.keys(inv).length > 0;
  const bankItems = snap.bank && snap.bank.items ? Object.keys(snap.bank.items).length : 0;
  const bankAmmo = snap.bank && snap.bank.ammo ? Object.keys(snap.bank.ammo).length : 0;

  // Treat as empty if no coins anywhere AND inventory/bank are empty.
  if (coins === 0 && bankCoins === 0 && !hasInv && bankItems === 0 && bankAmmo === 0) return true;

  // Accept any snapshot that shows meaningful progress
  return false;
}

function normalizeSnapshot(incoming) {
  const now = Date.now();
  const v = { ...(incoming || {}) };

  // Strongly type/shape the snapshot
  v.version = 1;
  v.timestamp = typeof v.timestamp === 'number' ? v.timestamp : now;

  if (!v.player || typeof v.player !== 'object') v.player = {};
  if (typeof v.player.x !== 'number') v.player.x = 0;
  if (typeof v.player.y !== 'number') v.player.y = 0;
  if (typeof v.player.heartsSegs !== 'number' && v.player.heartsSegs !== null) v.player.heartsSegs = null;

  if (typeof v.coins !== 'number') v.coins = 0;

  if (!v.inventory || typeof v.inventory !== 'object') v.inventory = {};

  if (!v.bank || typeof v.bank !== 'object') v.bank = {};
  if (typeof v.bank.coins !== 'number') v.bank.coins = 0;
  if (!v.bank.items || typeof v.bank.items !== 'object') v.bank.items = {};
  if (!v.bank.ammo || typeof v.bank.ammo !== 'object') v.bank.ammo = {};

  return v;
}

function latestValidSnapshot(fileDoc) {
  if (!fileDoc || !Array.isArray(fileDoc.snapshots)) return null;
  for (let i = fileDoc.snapshots.length - 1; i >= 0; i--) {
    const s = fileDoc.snapshots[i];
    if (!isEmptyLike(s)) return s;
  }
  return null;
}

function nthFromEnd(fileDoc, n /* 0=latest,1=prev,... */, { requireValid = true } = {}) {
  if (!fileDoc || !Array.isArray(fileDoc.snapshots) || fileDoc.snapshots.length === 0) return null;
  let idx = fileDoc.snapshots.length - 1 - n;
  while (idx >= 0) {
    const s = fileDoc.snapshots[idx];
    if (!requireValid || !isEmptyLike(s)) return s;
    idx--;
  }
  return null;
}

// ---- routes ----

// GET /api/state/:user
// Options:
//   ?offset=N     -> 0=latest (default), 1=previous, etc. (valid-only)
//   ?raw=1        -> return entire file {version, snapshots: [...]}
//   ?allowEmpty=1 -> when fetching a specific offset, allow empty-like
api.get('/state/:user', async (req, res) => {
  await ensureDir();
  const user = req.params.user;
  const raw = req.query.raw === '1';
  const offset = Math.max(0, parseInt(req.query.offset || '0', 10));
  const allowEmpty = req.query.allowEmpty === '1';

  const doc = await readUserFile(user);

  if (raw) {
    return res.json(doc || { version: 2, snapshots: [] });
  }

  let snap;
  if (offset === 0) {
    snap = latestValidSnapshot(doc) || null;
  } else {
    snap = nthFromEnd(doc, offset, { requireValid: !allowEmpty }) || null;
  }

  if (!snap) {
    // No valid snapshots yet. Return a clear empty payload + flags.
    return res.json({
      ok: true,
      empty: true,
      snapshot: {
        version: 1,
        player: { x: 0, y: 0, heartsSegs: null },
        coins: 0,
        inventory: {},
        bank: { coins: 0, items: {}, ammo: {} },
        timestamp: Date.now()
      }
    });
  }

  return res.json({
    ok: true,
    empty: false,
    snapshot: snap
  });
});

// GET /api/state/:user/snapshots
// Returns { total, snapshots: [ {timestamp, emptyLike, ...minimal}, ... ] }
// Use this endpoint for debugging/diagnostics UIs.
api.get('/state/:user/snapshots', async (req, res) => {
  await ensureDir();
  const user = req.params.user;
  const doc = await readUserFile(user);
  const snaps = (doc && Array.isArray(doc.snapshots)) ? doc.snapshots : [];
  const compact = snaps.map(s => ({
    timestamp: s.timestamp,
    emptyLike: isEmptyLike(s),
    coins: s.coins|0,
    bankCoins: (s.bank && s.bank.coins)|0,
    invKeys: Array.isArray(s.inventory) ? s.inventory.length : Object.keys(s.inventory||{}).length
  }));
  res.json({ ok: true, total: snaps.length, snapshots: compact });
});

// POST /api/state/:user
// Accepts a snapshot, normalizes it, and appends it **only if not empty-like**.
// Returns the snapshot actually stored and whether it was ignored.
api.post('/state/:user', async (req, res) => {
  await ensureDir();
  const user = req.params.user;

  // Accept JSON object or JSON string (sendBeacon)
  let incoming = req.body || {};
  if (typeof incoming === 'string') {
    try { incoming = JSON.parse(incoming); } catch { incoming = {}; }
  }

  const snap = normalizeSnapshot(incoming);
  const empty = isEmptyLike(snap);

  const doc = (await readUserFile(user)) || { version: 2, snapshots: [] };

  if (empty) {
    // Do not store, but still report ok so client doesn't panic.
    return res.json({ ok: true, stored: false, reason: 'empty-like-ignored', snapshot: snap });
  }

  // De-dupe identical latest (same content except timestamp)
  const last = doc.snapshots[doc.snapshots.length - 1];
  const sameAsLast =
    last &&
    last.coins === snap.coins &&
    JSON.stringify(last.inventory || {}) === JSON.stringify(snap.inventory || {}) &&
    JSON.stringify(last.bank || {}) === JSON.stringify(snap.bank || {}) &&
    JSON.stringify(last.player || {}) === JSON.stringify(snap.player || {});

  if (!sameAsLast) {
    doc.snapshots.push(snap);
    if (doc.snapshots.length > MAX_SNAPSHOTS) {
      doc.snapshots = doc.snapshots.slice(doc.snapshots.length - MAX_SNAPSHOTS);
    }
    await writeUserFile(user, doc);
    return res.json({ ok: true, stored: true, snapshot: snap, total: doc.snapshots.length });
  } else {
    // Same snapshot state as latest — update timestamp only?
    // We'll still push to keep a time trail, but cap by MAX_SNAPSHOTS anyway.
    doc.snapshots.push(snap);
    if (doc.snapshots.length > MAX_SNAPSHOTS) {
      doc.snapshots = doc.snapshots.slice(doc.snapshots.length - MAX_SNAPSHOTS);
    }
    await writeUserFile(user, doc);
    return res.json({ ok: true, stored: true, dedupLike: true, snapshot: snap, total: doc.snapshots.length });
  }
});

export default api;
