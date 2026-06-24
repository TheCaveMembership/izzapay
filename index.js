// index.js — IZZA persistence service (ESM)
// Node persistence + REST MP + Socket.IO MP

import express from 'express';
import morgan from 'morgan';
import cors from 'cors';
import { promises as fs } from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import crypto from 'crypto';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';

const ROOT = process.env.DATA_DIR || '/var/data/izza/players';
const HISTORY_DEPTH = 5;

async function ensureDir() { await fs.mkdir(ROOT, { recursive: true }); }
function normUser(u){ return String(u||'').trim().toLowerCase().replace(/^@+/,'').replace(/[^a-z0-9_\-\.]/g,''); }
function filePath(base, suffix=''){ return path.join(ROOT, `${base}${suffix}.json`); }

async function readJSON(file){ try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; } }
async function writeJSON(file, obj){ await fs.writeFile(file, JSON.stringify(obj, null, 2), 'utf8'); }

function isPlainObject(o){ return !!o && typeof o==='object' && !Array.isArray(o); }

function isEmptySnapshot(snap){
  if(!isPlainObject(snap)) return true;
  if(snap.version !== 1) return false;
  const coins = (snap.coins|0) || 0;
  const invEmpty = !isPlainObject(snap.inventory) || Object.keys(snap.inventory).length===0;
  const b = isPlainObject(snap.bank) ? snap.bank : {};
  const bCoins = (b.coins|0) || 0;
  const bEmpty = bCoins===0 &&
    (!isPlainObject(b.items) || Object.keys(b.items).length===0) &&
    (!isPlainObject(b.ammo) || Object.keys(b.ammo).length===0);
  return coins===0 && invEmpty && bEmpty;
}

async function rotateHistory(base){
  for(let i=HISTORY_DEPTH-1;i>=1;i--){
    try{ await fs.rename(filePath(base, `.${i}`), filePath(base, `.${i+1}`)); }catch{}
  }
  try{ await fs.rename(filePath(base,''), filePath(base,'.1')); }catch{}
}

async function readBest(base, preferLastGood){
  const lastGood = await readJSON(filePath(base, '.lastgood'));
  const latest = await readJSON(filePath(base, ''));
  if(preferLastGood && lastGood) return lastGood;
  if(latest && !isEmptySnapshot(latest)) return latest;
  if(lastGood) return lastGood;
  for(let i=1;i<=HISTORY_DEPTH;i++){
    const h = await readJSON(filePath(base, `.${i}`));
    if(h && !isEmptySnapshot(h)) return h;
  }
  return latest || lastGood || null;
}

const app = express();
const httpServer = createServer(app);

const allowedOrigins = ['https://izzapay.onrender.com'];

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
app.options('*', cors({ origin: allowedOrigins, credentials: true }));
app.use(morgan('combined'));
app.use(express.json({ limit:'1mb' }));
app.use(express.text({ type: ['text/plain','application/octet-stream'], limit:'1mb' }));

app.get('/healthz', (_req,res)=> res.json({ ok:true, socket:true }));

const io = new SocketIOServer(httpServer, {
  cors: {
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST']
  },
  transports: ['websocket', 'polling']
});

// ---------------------------------------------------------------------------
// MULTIPLAYER NODE BACKEND
// ---------------------------------------------------------------------------

const MP_WORLDS = ['1','2','3','4'];
const MP_TTL_MS = parseInt(process.env.MP_TTL_MS || '12000', 10);
const MP_MAX_PLAYERS_PER_WORLD = parseInt(process.env.MP_MAX_PLAYERS_PER_WORLD || '250', 10);

const mpState = {
  userWorld: new Map(),
  worlds: new Map(MP_WORLDS.map(w => [w, new Map()])),
  sockets: new Map()
};

function mpRoom(world){ return `mp:world:${world}`; }

function mpCoerceWorld(w){
  const s = String(w || '1').trim();
  return MP_WORLDS.includes(s) ? s : '1';
}

function mpDecodeTokenUser(tok){
  try{
    const first = String(tok || '').split('.')[0] || '';
    const decoded = JSON.parse(Buffer.from(first, 'base64url').toString('utf8'));
    return normUser(decoded.username || decoded.user || decoded.pi_username || decoded.handle || '');
  }catch{
    return '';
  }
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
  let u = normUser(
    req.query?.u ||
    req.query?.user ||
    req.query?.username ||
    req.query?.pi_username ||
    body.u ||
    body.user ||
    body.username ||
    body.pi_username ||
    body?.appearance?.username ||
    req.headers['x-izza-user'] ||
    req.headers['x-pi-username'] ||
    ''
  );
  if(!u) u = mpDecodeTokenUser(mpTokenFromReq(req));
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

function mpUserFromSocket(socket){
  const q = socket.handshake.query || {};
  const h = socket.handshake.headers || {};
  const auth = socket.handshake.auth || {};

  const token =
    q.t ||
    auth.t ||
    auth.token ||
    h['x-izza-token'] ||
    String(h.authorization || '').replace(/^bearer\s+/i, '');

  let username = normUser(
    q.u ||
    q.user ||
    q.username ||
    q.pi_username ||
    auth.u ||
    auth.user ||
    auth.username ||
    auth.pi_username ||
    h['x-izza-user'] ||
    h['x-pi-username'] ||
    ''
  );

  if(!username) username = mpDecodeTokenUser(token);

  return { username, token:String(token || '') };
}

function mpSweep(){
  const now = Date.now();

  for(const world of MP_WORLDS){
    const map = mpState.worlds.get(world);
    for(const [username, st] of map.entries()){
      if(now - Number(st.last || 0) > MP_TTL_MS){
        map.delete(username);
        if(mpState.userWorld.get(username) === world) mpState.userWorld.delete(username);
        io.to(mpRoom(world)).emit('mp:player-left', { username, world, reason:'ttl' });
      }
    }
  }
}

function mpCounts(){
  mpSweep();
  const out = {};
  for(const world of MP_WORLDS) out[world] = mpState.worlds.get(world).size;
  return out;
}

function mpSetWorld(username, world){
  world = mpCoerceWorld(world);

  for(const w of MP_WORLDS) mpState.worlds.get(w).delete(username);
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

function mpPlayerPayload(st){
  return {
    id:st.username,
    username:st.username,
    x:Number(st.x || 0),
    y:Number(st.y || 0),
    facing:st.facing || 'down',
    appearance:st.appearance || {},
    inv:st.inv || {},
    lastUpdate:Number(st.last || Date.now()) / 1000
  };
}

function mpRosterFor(username, since=0){
  mpSweep();
  const world = mpGetWorld(username);
  const sinceMs = since > 9999999999 ? since : since * 1000;
  const players = [];

  for(const [u, st] of mpState.worlds.get(world).entries()){
    if(u === username) continue;
    const last = Number(st.last || 0);
    if(sinceMs && last <= sinceMs) continue;
    players.push(mpPlayerPayload(st));
  }

  return { world, players };
}

const mpPaths = p => [`/api/mp${p}`, `/izza-game/api/mp${p}`];

app.post(mpPaths('/client-log'), (req,res)=>{
  const body = isPlainObject(req.body) ? req.body : {};
  console.log('[MP CLIENT]', JSON.stringify({
    event:body.event || 'client-log',
    world:body.world || '',
    data:body.data || {},
    href:body.href || '',
    ts:body.ts || Date.now()
  }).slice(0, 3000));
  res.json({ ok:true });
});

app.post(mpPaths('/world/client-log'), (req,res)=>{
  const body = isPlainObject(req.body) ? req.body : {};
  console.log('[MP CLIENT WORLD]', JSON.stringify({
    event:body.event || 'client-log',
    world:body.world || '',
    data:body.data || {},
    href:body.href || '',
    ts:body.ts || Date.now()
  }).slice(0, 3000));
  res.json({ ok:true });
});

app.post(mpPaths('/world/join'), (req,res)=>{
  const who = mpRequireUser(req,res);
  if(!who) return;

  const body = isPlainObject(req.body) ? req.body : {};
  const world = mpCoerceWorld(body.worldId || body.world || req.query.worldId || req.query.world || '1');

  mpSweep();

  const count = mpState.worlds.get(world).size;
  const alreadyHere = mpGetWorld(who.username) === world;
  if(!alreadyHere && count >= MP_MAX_PLAYERS_PER_WORLD){
    return res.status(429).json({ ok:false, error:'world_full', world, max:MP_MAX_PLAYERS_PER_WORLD });
  }

  mpSetWorld(who.username, world);
  const st = mpUpdatePlayer(who.username, world, body);

  io.to(mpRoom(world)).emit('mp:player-joined', mpPlayerPayload(st));
  io.emit('mp:counts', { ok:true, counts:mpCounts(), serverNow:Date.now()/1000 });

  console.log('[MP] join', { username:who.username, world, hasToken:!!who.token, counts:mpCounts() });

  res.set('Cache-Control','no-store');
  res.json({ ok:true, world, username:who.username, counts:mpCounts(), ttlMs:MP_TTL_MS, socket:true });
});

app.get(mpPaths('/worlds/counts'), (_req,res)=>{
  res.set('Cache-Control','no-store');
  res.json({ ok:true, counts:mpCounts(), serverNow:Date.now()/1000, socket:true });
});

app.post(mpPaths('/world/heartbeat'), (req,res)=>{
  const who = mpRequireUser(req,res);
  if(!who) return;

  const body = isPlainObject(req.body) ? req.body : {};
  const world = mpGetWorld(who.username);
  const st = mpUpdatePlayer(who.username, world, body);

  io.to(mpRoom(world)).emit('mp:player', mpPlayerPayload(st));
  mpSweep();

  res.set('Cache-Control','no-store');
  res.json({ ok:true, world, username:who.username, now:Date.now()/1000, player:mpPlayerPayload(st) });
});

app.post(mpPaths('/world/pos'), (req,res)=>{
  const who = mpRequireUser(req,res);
  if(!who) return;

  const body = isPlainObject(req.body) ? req.body : {};
  const world = mpGetWorld(who.username);
  const st = mpUpdatePlayer(who.username, world, { x:body.x, y:body.y, facing:body.facing });

  io.to(mpRoom(world)).emit('mp:player', mpPlayerPayload(st));

  res.set('Cache-Control','no-store');
  res.json({ ok:true, world, now:Date.now()/1000 });
});

app.get(mpPaths('/world/roster'), (req,res)=>{
  const who = mpRequireUser(req,res);
  if(!who) return;

  const { world, players } = mpRosterFor(who.username, Number(req.query.since || 0));

  res.set('Cache-Control','no-store');
  res.json({ ok:true, world, players, serverNow:Date.now()/1000, counts:mpCounts(), socket:true });
});

app.post(mpPaths('/world/leave'), (req,res)=>{
  const who = mpRequireUser(req,res);
  if(!who) return res.json({ ok:true });

  const oldWorld = mpGetWorld(who.username);
  for(const world of MP_WORLDS) mpState.worlds.get(world).delete(who.username);
  mpState.userWorld.delete(who.username);

  io.to(mpRoom(oldWorld)).emit('mp:player-left', { username:who.username, world:oldWorld, reason:'leave' });
  io.emit('mp:counts', { ok:true, counts:mpCounts(), serverNow:Date.now()/1000 });

  console.log('[MP] leave', { username:who.username });
  res.json({ ok:true });
});

app.post(mpPaths('/presence/offline'), (req,res)=>{
  const who = mpRequireUser(req,res);
  if(!who) return res.json({ ok:true });

  const oldWorld = mpGetWorld(who.username);
  for(const world of MP_WORLDS) mpState.worlds.get(world).delete(who.username);
  mpState.userWorld.delete(who.username);

  io.to(mpRoom(oldWorld)).emit('mp:player-left', { username:who.username, world:oldWorld, reason:'offline' });
  io.emit('mp:counts', { ok:true, counts:mpCounts(), serverNow:Date.now()/1000 });

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
    inviteLink:'/izza-game/auth',
    socket:true
  });
});
// ---------------------------------------------------------------------------
// LIVE VIDEO AUCTION SOCKET BACKEND
// ---------------------------------------------------------------------------

const auctionState = {
  rooms: new Map()
};

function auctionRoom(slug){
  return `auction:${String(slug || '').trim().toLowerCase()}`;
}

function getAuction(slug){
  slug = String(slug || '').trim().toLowerCase();
  if(!auctionState.rooms.has(slug)){
    auctionState.rooms.set(slug, {
      slug,
      viewers:new Map(),
      chat:[],
      currentLot:null,
      highBid:null,
      started:false,
      updatedAt:Date.now()
    });
  }
  return auctionState.rooms.get(slug);
}

function auctionViewerCount(slug){
  return getAuction(slug).viewers.size;
}

function safeAuctionSlug(v){
  return String(v || '').trim().toLowerCase().replace(/[^a-z0-9_\-]/g,'').slice(0,80);
}

function bidPayload(body, username){
  return {
    username,
    auctionSlug:safeAuctionSlug(body.auctionSlug || body.slug),
    lotId:String(body.lotId || '').trim(),
    lotTitle:String(body.lotTitle || '').trim().slice(0,120),
    bidPi:Number(body.bidPi || body.amount || 0),
    ts:Date.now()
  };
}
io.on('connection', socket=>{
  const who = mpUserFromSocket(socket);

  if(!who.username){
    console.warn('[MP SOCKET] rejected missing user', { id:socket.id });
    socket.emit('mp:error', { ok:false, error:'not_authenticated', reason:'missing_u' });
    socket.disconnect(true);
    return;
  }

  socket.data.username = who.username;
  socket.data.token = who.token;

  console.log('[MP SOCKET] connected', { id:socket.id, username:who.username, hasToken:!!who.token });

  socket.emit('mp:hello', {
    ok:true,
    username:who.username,
    counts:mpCounts(),
    ttlMs:MP_TTL_MS,
    serverNow:Date.now()/1000
  });

    // -------------------------------------------------------------------------
  // LIVE AUCTION SOCKET EVENTS
  // -------------------------------------------------------------------------

  socket.on('auction:join', payload=>{
    try{
      const body = isPlainObject(payload) ? payload : {};
      const slug = safeAuctionSlug(body.auctionSlug || body.slug);
      if(!slug){
        socket.emit('auction:error', { ok:false, error:'missing_auction_slug' });
        return;
      }

      const room = auctionRoom(slug);
      const st = getAuction(slug);

      socket.join(room);
      socket.data.auctionSlug = slug;

      st.viewers.set(socket.id, {
        username:who.username,
        joinedAt:Date.now()
      });
      st.updatedAt = Date.now();

      socket.emit('auction:joined', {
        ok:true,
        auctionSlug:slug,
        username:who.username,
        viewerCount:auctionViewerCount(slug),
        currentLot:st.currentLot,
        highBid:st.highBid,
        started:st.started,
        serverNow:Date.now()/1000
      });

      io.to(room).emit('auction:viewers', {
        ok:true,
        auctionSlug:slug,
        viewerCount:auctionViewerCount(slug)
      });
    }catch(e){
      socket.emit('auction:error', { ok:false, error:'join_failed', message:e.message });
    }
  });

  socket.on('auction:chat', payload=>{
    try{
      const body = isPlainObject(payload) ? payload : {};
      const slug = safeAuctionSlug(body.auctionSlug || body.slug || socket.data.auctionSlug);
      const msg = String(body.message || body.text || '').trim().slice(0,300);
      if(!slug || !msg) return;

      const st = getAuction(slug);
      const item = {
        username:who.username,
        message:msg,
        ts:Date.now()
      };

      st.chat.push(item);
      if(st.chat.length > 150) st.chat.splice(0, st.chat.length - 150);
      st.updatedAt = Date.now();

      io.to(auctionRoom(slug)).emit('auction:chat', {
        ok:true,
        auctionSlug:slug,
        ...item
      });
    }catch(e){
      socket.emit('auction:error', { ok:false, error:'chat_failed', message:e.message });
    }
  });

  socket.on('auction:bid', payload=>{
    try{
      const body = isPlainObject(payload) ? payload : {};
      const bid = bidPayload(body, who.username);

      if(!bid.auctionSlug || !bid.lotId || !Number.isFinite(bid.bidPi) || bid.bidPi <= 0){
        socket.emit('auction:bid-error', { ok:false, error:'bad_bid' });
        return;
      }

      const st = getAuction(bid.auctionSlug);

      if(st.highBid && String(st.highBid.lotId) === String(bid.lotId)){
        if(Number(bid.bidPi) <= Number(st.highBid.bidPi || 0)){
          socket.emit('auction:bid-error', {
            ok:false,
            error:'bid_too_low',
            currentHighBid:st.highBid
          });
          return;
        }
      }

      st.highBid = bid;
      st.updatedAt = Date.now();

      io.to(auctionRoom(bid.auctionSlug)).emit('auction:bid', {
        ok:true,
        ...bid
      });
    }catch(e){
      socket.emit('auction:bid-error', { ok:false, error:'bid_failed', message:e.message });
    }
  });

  socket.on('auction:admin:set-lot', payload=>{
    try{
      const body = isPlainObject(payload) ? payload : {};
      const slug = safeAuctionSlug(body.auctionSlug || body.slug || socket.data.auctionSlug);
      if(!slug) return;

      const st = getAuction(slug);
      st.currentLot = {
        lotId:String(body.lotId || '').trim(),
        lotNumber:body.lotNumber || '',
        title:String(body.title || '').trim().slice(0,140),
        description:String(body.description || '').trim().slice(0,500),
        imageUrl:String(body.imageUrl || body.image_url || '').trim(),
        startingBidPi:Number(body.startingBidPi || body.starting_bid_pi || 0),
        bidIncrementPi:Number(body.bidIncrementPi || body.bid_increment_pi || 0.01),
        ts:Date.now()
      };
      st.highBid = null;
      st.updatedAt = Date.now();

      io.to(auctionRoom(slug)).emit('auction:lot', {
        ok:true,
        auctionSlug:slug,
        currentLot:st.currentLot,
        highBid:null
      });
    }catch(e){
      socket.emit('auction:error', { ok:false, error:'set_lot_failed', message:e.message });
    }
  });

  socket.on('auction:admin:start', payload=>{
    const body = isPlainObject(payload) ? payload : {};
    const slug = safeAuctionSlug(body.auctionSlug || body.slug || socket.data.auctionSlug);
    if(!slug) return;

    const st = getAuction(slug);
    st.started = true;
    st.updatedAt = Date.now();

    io.to(auctionRoom(slug)).emit('auction:status', {
      ok:true,
      auctionSlug:slug,
      status:'live',
      started:true,
      serverNow:Date.now()/1000
    });
  });

  socket.on('auction:admin:end-lot', payload=>{
    const body = isPlainObject(payload) ? payload : {};
    const slug = safeAuctionSlug(body.auctionSlug || body.slug || socket.data.auctionSlug);
    if(!slug) return;

    const st = getAuction(slug);
    const winner = st.highBid || null;

    io.to(auctionRoom(slug)).emit('auction:lot-ended', {
      ok:true,
      auctionSlug:slug,
      currentLot:st.currentLot,
      winner,
      serverNow:Date.now()/1000
    });

    st.currentLot = null;
    st.highBid = null;
    st.updatedAt = Date.now();
  });

  socket.on('mp:join', payload=>{
    try{
      const body = isPlainObject(payload) ? payload : {};
      const world = mpCoerceWorld(body.worldId || body.world || '1');

      mpSweep();

      const count = mpState.worlds.get(world).size;
      const alreadyHere = mpGetWorld(who.username) === world;
      if(!alreadyHere && count >= MP_MAX_PLAYERS_PER_WORLD){
        socket.emit('mp:join-error', { ok:false, error:'world_full', world, max:MP_MAX_PLAYERS_PER_WORLD });
        return;
      }

      for(const w of MP_WORLDS) socket.leave(mpRoom(w));
      socket.join(mpRoom(world));

      mpSetWorld(who.username, world);
      const st = mpUpdatePlayer(who.username, world, body);

      socket.emit('mp:joined', {
        ok:true,
        world,
        username:who.username,
        counts:mpCounts(),
        roster:mpRosterFor(who.username).players,
        serverNow:Date.now()/1000
      });

      socket.to(mpRoom(world)).emit('mp:player-joined', mpPlayerPayload(st));
      io.emit('mp:counts', { ok:true, counts:mpCounts(), serverNow:Date.now()/1000 });
    }catch(e){
      socket.emit('mp:error', { ok:false, error:'join_failed', message:e.message });
    }
  });

  socket.on('mp:pos', payload=>{
    try{
      const body = isPlainObject(payload) ? payload : {};
      const world = mpGetWorld(who.username);
      const st = mpUpdatePlayer(who.username, world, {
        x:body.x,
        y:body.y,
        facing:body.facing
      });

      socket.to(mpRoom(world)).emit('mp:player', mpPlayerPayload(st));
    }catch(e){
      socket.emit('mp:error', { ok:false, error:'pos_failed', message:e.message });
    }
  });

  socket.on('mp:heartbeat', payload=>{
    try{
      const body = isPlainObject(payload) ? payload : {};
      const world = mpGetWorld(who.username);
      const st = mpUpdatePlayer(who.username, world, body);
      socket.to(mpRoom(world)).emit('mp:player', mpPlayerPayload(st));
      socket.emit('mp:heartbeat-ok', { ok:true, world, serverNow:Date.now()/1000 });
    }catch(e){
      socket.emit('mp:error', { ok:false, error:'heartbeat_failed', message:e.message });
    }
  });

  socket.on('mp:roster', ()=>{
    try{
      const { world, players } = mpRosterFor(who.username);
      socket.emit('mp:roster', { ok:true, world, players, serverNow:Date.now()/1000 });
    }catch(e){
      socket.emit('mp:error', { ok:false, error:'roster_failed', message:e.message });
    }
  });

  socket.on('mp:leave', ()=>{
    const oldWorld = mpGetWorld(who.username);
    for(const world of MP_WORLDS){
      mpState.worlds.get(world).delete(who.username);
      socket.leave(mpRoom(world));
    }
    mpState.userWorld.delete(who.username);
    socket.to(mpRoom(oldWorld)).emit('mp:player-left', { username:who.username, world:oldWorld, reason:'leave' });
    io.emit('mp:counts', { ok:true, counts:mpCounts(), serverNow:Date.now()/1000 });
  });

  socket.on('disconnect', reason=>{
    const auctionSlug = socket.data.auctionSlug;
if(auctionSlug){
  const st = getAuction(auctionSlug);

  st.viewers.delete(socket.id);

  io.to(auctionRoom(auctionSlug)).emit('auction:viewers', {
    ok:true,
    auctionSlug,
    viewerCount:auctionViewerCount(auctionSlug)
  });
}
    const oldWorld = mpGetWorld(who.username);
    for(const world of MP_WORLDS) mpState.worlds.get(world).delete(who.username);
    mpState.userWorld.delete(who.username);
    mpState.sockets.delete(who.username);
    socket.to(mpRoom(oldWorld)).emit('mp:player-left', { username:who.username, world:oldWorld, reason });
    io.emit('mp:counts', { ok:true, counts:mpCounts(), serverNow:Date.now()/1000 });
    console.log('[MP SOCKET] disconnected', { username:who.username, reason });
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
    const best = await readBest(user, req.query.prefer === 'lastGood');
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

// ---------------- LEADERBOARD ----------------

const LB_ROOT = process.env.LB_DIR || '/var/data/izza/leaderboards';
async function ensureLbDir(){ await fs.mkdir(LB_ROOT, { recursive: true }); }
function lbFile(game){ return path.join(LB_ROOT, `${game}.json`); }
async function readLB(game){ await ensureLbDir(); try { return JSON.parse(await fs.readFile(lbFile(game), 'utf8')); } catch { return []; } }
async function writeLB(game, rows){ await ensureLbDir(); await fs.writeFile(lbFile(game), JSON.stringify(rows, null, 2), 'utf8'); }
function normGame(g){ return String(g||'').toLowerCase().replace(/[^a-z0-9_\-\.]/g,''); }

const GAME_CANON = Object.freeze({
  racing:'race', race:'race', jetman:'jetman', basketball:'basketball',
  puzzle:'puzzle', targets:'targets', runner:'runner', city_chase:'city_chase', all:'all'
});

function canonGame(g){ return GAME_CANON[normGame(g)] || normGame(g); }
function canonPeriod(p){ const x=String(p||'all').toLowerCase(); return x==='alltime'?'all':(x==='year'||x==='annual'?'year':x); }

function sinceForPeriod(period){
  const p = canonPeriod(period), now = Date.now();
  if(p==='day') return now - 24*60*60*1000;
  if(p==='week') return now - 7*24*60*60*1000;
  if(p==='month') return now - 30*24*60*60*1000;
  if(p==='year') return now - 365*24*60*60*1000;
  return 0;
}

function rankify(rows){
  rows.sort((a,b)=> b.score - a.score || a.ts - b.ts);
  let lastScore=null, rank=0, i=0;
  for(const r of rows){ i++; if(r.score!==lastScore){ rank=i; lastScore=r.score; } r.rank=rank; }
  return rows;
}

app.post(['/izza-game/api/leaderboard/submit','/api/leaderboard/submit'], async (req,res)=>{
  try{
    let body = req.body;
    if(typeof body === 'string'){ try{ body = JSON.parse(body); }catch{ body = {}; } }

    const game = canonGame(body.game || 'unknown');
    const user = String(body.user || req.query.u || '').trim().toLowerCase().replace(/^@+/,'').replace(/[^a-z0-9_\-\.]/g,'') || 'guest';
    const score = Number(body.score) | 0;
    const ts = Number(body.ts) || Date.now();

    if(!game || !Number.isFinite(score) || score < 0) return res.status(400).json({ ok:false, error:'bad-input' });

    const rows = await readLB(game);
    const idx = rows.findIndex(r => r.user === user);
    if(idx >= 0){
      if(score > (rows[idx].score|0)) rows[idx] = { user, score, ts };
    }else{
      rows.push({ user, score, ts });
    }

    const top = rankify(rows).slice(0, 500);
    await writeLB(game, top);
    res.json({ ok:true, saved:{ user, game, score } });
  }catch(e){
    console.error('LB submit error', e);
    res.status(500).json({ ok:false, error:'server-error' });
  }
});

app.get(['/izza-game/api/leaderboard','/api/leaderboard'], async (req,res)=>{
  try{
    const game = canonGame(req.query.game || 'all');
    const limit = Math.min(Math.max(parseInt(req.query.limit||'100',10)||100, 1), 200);
    const around = String(req.query.around || '').trim().toLowerCase().replace(/^@+/, '');
    const since = sinceForPeriod(req.query.period || 'all');

    async function loadBoard(g){
      let rows = await readLB(g);
      if(since) rows = rows.filter(r => Number(r.ts||0) >= since);
      return rankify(rows);
    }

    if(game !== 'all'){
      const ranked = await loadBoard(game);
      if(around){
        const i = ranked.findIndex(r => r.user === around);
        const half = Math.max(5, Math.floor(limit/2));
        const start = i === -1 ? 0 : Math.max(0, i-half);
        return res.json({ ok:true, game, rows: ranked.slice(start, start+limit) });
      }
      return res.json({ ok:true, game, rows: ranked.slice(0, limit) });
    }

    const games = ['jetman','race','basketball','puzzle','targets','runner','city_chase'];
    const mapsByUser = new Map();

    for(const g of games){
      const ranked = await loadBoard(g);
      for(const r of ranked){
        const cur = mapsByUser.get(r.user);
        if(!cur || r.score > cur.score) mapsByUser.set(r.user, { user:r.user, score:r.score, ts:r.ts, game:g });
      }
    }

    const combined = rankify(Array.from(mapsByUser.values()));
    res.json({ ok:true, game:'all', rows: combined.slice(0, limit) });
  }catch(e){
    console.error('LB get error', e);
    res.status(500).json({ ok:false, error:'server-error' });
  }
});

// ---------------------------------------------------------------------------
// AI SVG endpoint
// ---------------------------------------------------------------------------

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const SVG_MODEL_ID = process.env.SVG_MODEL_ID || 'gpt-4.1';
const ANIM_PRICE_IC = parseInt(process.env.ANIM_PRICE_IC || '150', 10);

function sanitizeSVG(svg) {
  try {
    let t = String(svg || '').trim();
    if (!t) return '';
    if (t.length > 200000) t = t.slice(0, 200000);
    if (/(<!DOCTYPE|<script|\son\w+=|<iframe|<foreignObject)/i.test(t)) return '';
    if (/\b(xlink:href|href)\s*=\s*['"](?!#)/i.test(t)) return '';
    if (!/^<svg\b[^>]*>[\s\S]*<\/svg>\s*$/i.test(t)) return '';
    return t.replace(/<\?xml[\s\S]*?\?>/gi,'').replace(/<!DOCTYPE[^>]*>/gi,'').replace(/<metadata[\s\S]*?<\/metadata>/gi,'').replace(/\s+xmlns:xlink="[^"]*"/i,'');
  } catch { return ''; }
}

function stripAnimations(svg) { return String(svg || ''); }

const SYSTEM_PROMPT = `
You generate SVG overlays for IZZA. Return ONE safe vector-only <svg>, transparent background, no prose.
Use only safe SVG vector elements. No image, no foreignObject, no external href, no scripts.
Fit tightly. Helmet face is never blank. Hands/weapons face right.
`;

function expandWithLexicons(txt){ return ''; }

function detectStyleFromPrompt(prompt, explicit) {
  if (explicit && /^(realistic|cartoon|stylized)$/i.test(explicit)) return explicit.toLowerCase();
  const p = (prompt||'').toLowerCase();
  const anime = /(anime|manga|pokemon|dragon\s*ball|dbz|naruto|zelda|fortnite)/i.test(p);
  const real = /(realistic|steel|gold|silver|leather|wood|stone|diamond|glass|water|fire|ice)/i.test(p);
  if(anime && !real) return 'cartoon';
  if(real && !anime) return 'realistic';
  return real ? 'realistic' : 'cartoon';
}

function scoreSvgQuality(s, mode) {
  if (!s) return -1;
  const t = s.toLowerCase();
  const count = re => (t.match(re)||[]).length;
  let score = count(/<path\b/g)*2 + count(/<lineargradient\b/g)*2 + count(/<radialgradient\b/g)*2 + count(/<filter\b/g) + count(/<clippath\b/g)*4 + count(/<mask\b/g)*4;
  if(mode === 'realistic') score -= count(/stroke-width="(?:3(\.\d+)?|[4-9]\d*(\.\d+)?)"/g)*2;
  return score;
}

app.post('/api/crafting/ai_svg', async (req, res) => {
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const prompt = String(body.prompt || '').trim().slice(0, 700);
    const meta = body.meta || {};
    const partIn = String(meta.part || 'helmet').toLowerCase().slice(0, 16);
    const name = String(meta.name || '').slice(0, 64);
    const wantAnim = !!meta.animate;
    const animPaid = !!meta.animationPaid;
    const style = detectStyleFromPrompt(prompt, (meta.style || 'auto').toLowerCase() === 'auto' ? '' : meta.style);

    if (!prompt) return res.status(400).json({ ok:false, reason:'empty-prompt' });
    if (!OPENAI_API_KEY) return res.status(503).json({ ok:false, reason:'no-api-key' });

    const SLOT = {
      helmet:{ vb:'0 0 128 128', box:{w:38,h:38} },
      vest:{ vb:'0 0 128 128', box:{w:40,h:40} },
      arms:{ vb:'0 0 160 120', box:{w:38,h:38} },
      legs:{ vb:'0 0 140 140', box:{w:40,h:40} },
      hands:{ vb:'0 0 160 100', box:{w:36,h:36} }
    };

    const part = SLOT[partIn] ? partIn : 'helmet';
    const { vb, box } = SLOT[part];

    const userMsg = [
      `Part: ${part}`,
      name ? `Name: ${name}` : null,
      `Prompt: ${prompt}`,
      expandWithLexicons(prompt),
      `Use viewBox="${vb}". Fit composition tightly for ~${box.w}×${box.h} overlay.`,
      part === 'hands' ? 'For hands/guns, draw the weapon facing RIGHT.' : '',
      `STYLE: ${style}`,
      wantAnim ? 'ANIMATION: At most 1–2 lightweight loops. No JS.' : ''
    ].filter(Boolean).join('\n');

    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method:'POST',
      headers:{ authorization:`Bearer ${OPENAI_API_KEY}`, 'content-type':'application/json' },
      body:JSON.stringify({
        model:SVG_MODEL_ID,
        temperature: style === 'realistic' ? 0.45 : style === 'cartoon' ? 0.9 : 0.7,
        top_p:0.95,
        max_tokens:6000,
        n:12,
        messages:[
          { role:'system', content:SYSTEM_PROMPT },
          { role:'user', content:userMsg }
        ]
      })
    });

    if(!resp.ok){
      const txt = await resp.text().catch(()=> '');
      console.error('[ai_svg] upstream error', resp.status, txt.slice(0,500));
      return res.status(502).json({ ok:false, reason:'llm-upstream', raw:txt.slice(0,400) });
    }

    const data = await resp.json().catch(()=> ({}));
    const candidates = (data?.choices || []).map(c => (c?.message?.content || '').trim()).filter(Boolean);
    if(!candidates.length) return res.status(502).json({ ok:false, reason:'no-candidate' });

    let best = candidates[0], bestScore = scoreSvgQuality(best, style);
    for(let i=1;i<candidates.length;i++){
      const sc = scoreSvgQuality(candidates[i], style);
      if(sc > bestScore){ best = candidates[i]; bestScore = sc; }
    }

    let svg = sanitizeSVG(best);
    if(!svg) return res.status(422).json({ ok:false, reason:'sanitize-fail' });

    let animationStripped = false;
    if(wantAnim && !animPaid){
      const kept = stripAnimations(svg);
      animationStripped = kept !== svg;
      svg = kept;
    }

    res.json({ ok:true, svg, style, animated:wantAnim, animationStripped, priceIC:ANIM_PRICE_IC });
  }catch(e){
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
    if(t.length > 200000) t = t.slice(0,200000);
    if(!/^<svg\b[^>]*>[\s\S]*<\/svg>\s*$/i.test(t)) return '';
    if(/(<!DOCTYPE|<script|\son\w+=|<iframe|<foreignObject)/i.test(t)) return '';
    if(/\b(xlink:href|href)\s*=\s*['"](?!#)/i.test(t)) return '';
    return t.replace(/(<svg\b[^>]*\sstyle\s*=\s*["'][^"']*)\bbackground(?:-color)?\s*:[^;"']+;?/i, (_,pre)=>pre);
  }catch{ return ''; }
}

async function readCrafted(user){ const j = await readJSON(craftedPath(user)); return Array.isArray(j) ? j : []; }
async function writeCrafted(user, list){ await writeJSON(craftedPath(user), Array.isArray(list) ? list : []); }

app.get('/api/crafting/mine', async (req,res)=>{
  try{
    const u = normUser(req.query.u||'');
    if(!isSafeUser(u)) return res.status(400).json({ ok:false, reason:'missing-user' });
    await ensureDir();
    const rows = await readCrafted(u);
    res.set('Cache-Control','no-store');
    res.json({ ok:true, items:rows.slice(-500) });
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
    res.set('Cache-Control','no-store');
    res.json({ ok:true, items:rows.map(r=>({ id:r.id, name:r.name, image:r.image || '', sku:r.sku || '' })) });
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
    if(typeof body === 'string'){ try{ body = JSON.parse(body); }catch{ body = {}; } }

    const name = String(body.name||'').slice(0,64).trim();
    const category = String(body.category||'armour').slice(0,24);
    const part = String(body.part||'helmet').slice(0,16);
    const sku = String(body.sku||'').slice(0,32);
    const image = String(body.image||'').slice(0,256);
    const svg = sanitizeSvgTight(body.svg || '');

    if(!name || !svg) return res.status(400).json({ ok:false, reason:'missing-fields' });

    const rows = await readCrafted(u);
    const id = newId();
    rows.push({ id, name, category, part, svg, sku, image, created_at:Date.now() });

    await writeCrafted(u, rows.slice(-500));
    res.json({ ok:true, id });
  }catch(e){
    console.error('POST /api/crafting/mine', e);
    res.status(500).json({ ok:false, reason:'server-error' });
  }
});

const PORT = process.env.PORT || 10000;
httpServer.listen(PORT, ()=> console.log(`IZZA persistence on ${PORT} (root=${ROOT}) + REST MP + Socket.IO ready`));
