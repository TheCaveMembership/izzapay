// Simple persistence API for IZZA — stores per-user JSON on disk
// Mount your Render disk at /var/data
import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import cors from 'cors';
import morgan from 'morgan';

const app = express();

// --- middleware ---
app.use(cors());
// accept normal JSON and also text/plain (what Safari sendBeacon often uses)
app.use(express.json({ limit: '1mb' }));
app.use(express.text({ type: ['text/plain', 'application/octet-stream'], limit: '1mb' }));
app.use(morgan('combined'));

const ROOT = '/var/data/izza/players';
async function ensureDir() { await fs.mkdir(ROOT, { recursive: true }); }

function fileFor(user) {
  // sanitize to [a-z0-9-_]
  const safe = String(user || 'guest').toLowerCase().replace(/[^a-z0-9-_]/g, '-');
  return path.join(ROOT, `${safe}.json`);
}

app.get('/api/state/:user', async (req, res) => {
  try {
    await ensureDir();
    const f = fileFor(req.params.user);
    const data = JSON.parse(await fs.readFile(f, 'utf8'));
    res.json(data);
  } catch (e) {
    // not found => return empty default state
    res.json({
      version: 1,
      player: { x: 0, y: 0, heartsSegs: null },
      coins: 0,
      inventory: {},
      bank: { coins: 0, items: {}, ammo: {} },
      timestamp: Date.now()
    });
  }
});

app.post('/api/state/:user', async (req, res) => {
  try {
    await ensureDir();
    const f = fileFor(req.params.user);

    // accept JSON from fetch() and JSON string from sendBeacon()
    let payload = req.body || {};
    if (typeof payload === 'string') {
      try { payload = JSON.parse(payload); } catch { payload = {}; }
    }

    payload.version = 1;
    payload.timestamp = Date.now();

    await fs.writeFile(f, JSON.stringify(payload, null, 2), 'utf8');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// tiny health check
app.get('/healthz', (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`IZZA persistence on ${PORT}`));
