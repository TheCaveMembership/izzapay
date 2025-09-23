// Remote Players API — v2.0 (SOLO-aware + MP bridge + roster refresh + inventory/loadout)
// - Renders remote players in the *current world* only
// - Bridges "join-world" and "worlds-counts" directly to /izza-game/api/mp
// - Carries appearance *and* inventory/equipped info for remote players
// - Exposes IZZA.api.getInventorySnapshot() so PvP & bridges can read a clean loadout
(function(){
  const BUILD = 'v2.0-remote-players-api';
  console.log('[IZZA PLAY]', BUILD);

  // ---------- asset loaders (same behavior as core) ----------
  function loadImg(src){
    return new Promise((res)=>{ const i=new Image(); i.onload=()=>res(i); i.onerror=()=>res(null); i.src=src; });
  }
  async function loadLayer(kind, name){
    const base = '/static/game/sprites/' + kind + '/';
    const try2 = await loadImg(base + encodeURIComponent(String(name || '') + ' 2') + '.png');
    if (try2) return { img: try2, cols: Math.max(1, Math.floor(try2.width / 32)) };
    const try1 = await loadImg(base + encodeURIComponent(String(name || '')) + '.png');
    if (try1) return { img: try1, cols: Math.max(1, Math.floor(try1.width / 32)) };
    return { img: null, cols: 1 };
  }

  // ---------- anim helpers (match core) ----------
  const DIR_INDEX = { down:0, left:2, right:1, up:3 };
  const FRAME_W=32, FRAME_H=32, WALK_FPS=8, WALK_MS=1000/WALK_FPS;
  function currentFrame(cols, moving, tMs){ if(cols<=1) return 0; if(!moving) return 1%cols; return Math.floor(tMs/WALK_MS)%cols; }

  // ---------- world helpers ----------
  const getWorld = ()=> (localStorage.getItem('izzaWorldId') || 'solo');

  // ---------- read local appearance + inventory (armoury pack aware) ----------
  function readAppearanceFallback(){
    try{
      const p = (window.__IZZA_PROFILE__ || {});
      const A = p.appearance || p || {};
      return {
        sprite_skin: A.sprite_skin || p.sprite_skin || localStorage.getItem('sprite_skin') || 'default',
        hair:        A.hair        || p.hair        || localStorage.getItem('hair')        || 'short',
        outfit:      A.outfit      || p.outfit      || localStorage.getItem('outfit')      || 'street'
      };
    }catch{ return { sprite_skin:'default', hair:'short', outfit:'street' }; }
  }

  // Combines inventory from core and armoury plugin; includes “equipped” flags
  function readInventorySnapshot(){
    try{
      // Preferred: core API
      if (window.IZZA?.api?.getInventory) {
        const inv = IZZA.api.getInventory() || {};
        return normalizeInv(inv);
      }
      // Armoury pack plugin?
      if (window.ARMOURY?.getLoadout) {
        const ld = window.ARMOURY.getLoadout();
        return normalizeInv(ld);
      }
      // Legacy localStorage fallbacks (very defensive)
      const raw = JSON.parse(localStorage.getItem('izza_inventory') || '{}');
      return normalizeInv(raw);
    }catch{ return normalizeInv({}); }
  }

  // normalize to a consistent shape { pistol:{equipped:true}, uzi:{equipped:false}, ... , crafted:{ [sku]:{equipped:true} } }
  function normalizeInv(src){
    const out = {};
    function mark(key, on){
      out[key] = out[key] || {};
      if (on != null) out[key].equipped = !!on;
    }
    try{
      // common weapons
      const keys = ['pistol','uzi','grenade','bat','knuckles','hand'];
      keys.forEach(k=>{
        const node = src[k] || (src.weapons && src.weapons[k]) || {};
        if (node && (node.equipped != null)) mark(k, !!node.equipped);
      });
      // crafted items / skins / extras
      const crafted = src.crafted || src.items || src.gear || {};
      const cOut = out.crafted = {};
      Object.keys(crafted).forEach(sku=>{
        const node = crafted[sku] || {};
        cOut[sku] = { equipped: !!node.equipped, kind: node.kind || node.type || 'skin' };
      });
    }catch{}
    return out;
  }

  function equippedFromInv(inv){
    try{
      if (inv.uzi?.equipped) return 'uzi';
      if (inv.pistol?.equipped) return 'pistol';
      if (inv.grenade?.equipped) return 'grenade';
      if (inv.bat?.equipped) return 'bat';
      if (inv.knuckles?.equipped) return 'knuckles';
      return 'hand';
    }catch{ return 'hand'; }
  }

  // ---------- minimal MP HTTP bridge (for counts/world join/optional roster) ----------
  const MP_BASE = '/izza-game/api/mp';
  const TOK = (window.__IZZA_T__ || '').toString();
  const withTok = (p) => TOK ? p + (p.includes('?') ? '&' : '?') + 't=' + encodeURIComponent(TOK) : p;

  async function jget(p){ const r = await fetch(withTok(MP_BASE+p), {credentials:'include'}); try{ return await r.json(); }catch{ return {}; } }
  async function jpost(p,b){
    const r = await fetch(withTok(MP_BASE+p),{
      method:'POST', headers:{'Content-Type':'application/json'}, credentials:'include',
      body: JSON.stringify(b||{})
    });
    try{ return await r.json(); }catch{ return {}; }
  }

  // ---------- local event bus ----------
  const localListeners = Object.create(null);
  function listen(type, cb){ (localListeners[type] ||= []).push(cb); }
  function fanout(type, data){ (localListeners[type]||[]).forEach(fn=>{ try{ fn(data); }catch(e){ console.warn(e); } }); }

  // ---------- REMOTE_PLAYERS_API public object ----------
  const REMOTE_PLAYERS_API = window.REMOTE_PLAYERS_API = window.REMOTE_PLAYERS_API || {
    send(type, data){
      try{
        // Real-time transport if present (e.g., your socket bridge)
        if (window.RemotePlayers?.send) return window.RemotePlayers.send(type, data);

        // Direct REST fallbacks for world features:
        if (type === 'join-world'){
          // { world: 'solo'|'1'|'2'|'3'|'4' }
          const world = (data && data.world) || getWorld();
          return jpost('/world/join', { world }).then(res=>{
            // After join, ask for a roster refresh (via server bridge or HTTP)
            REMOTE_PLAYERS_API.send('players-get', { world });
            fanout('join-world', { ok:true, world: res.world || world });
          });
        }
        if (type === 'worlds-counts'){
          return jget('/worlds/counts').then(j=>{
            fanout('worlds-counts', j);
          });
        }
        if (type === 'players-get'){
          // optional REST if your bridge supports /players/roster; otherwise just notify the socket bridge via IZZA
          const world = String((data && data.world) || getWorld());
          // Try a server roster endpoint if available:
          jget('/players/roster?world='+encodeURIComponent(world)).then(j=>{
            if (j && j.players) {
              fanout('players-state', { ok:true, world, players: j.players });
            } else {
              // No REST roster available — nudge socket bridge on the IZZA bus
              window.IZZA?.emit?.('mp-send', { type: 'players-get', data: { world }});
            }
          }).catch(()=>{
            window.IZZA?.emit?.('mp-send', { type: 'players-get', data: { world }});
          });
          return;
        }

        // Generic bus fallback
        window.IZZA?.emit?.('mp-send', { type, data });
      }catch(e){ console.warn('[REMOTE] send fail', e); }
    },
    on(type, cb){
      try{
        if (window.RemotePlayers?.on) return window.RemotePlayers.on(type, cb);
      }catch(e){}
      listen(type, cb);
    }
  };

  // Also accept messages via the IZZA bus (e.g., from a socket bridge)
  try{
    window.IZZA?.on?.('mp-players-state', (payload)=> {
      const data = payload?.data ?? payload;
      fanout('players-state', data);
    });
    window.IZZA?.on?.('mp-player-pos', (payload)=> {
      const data = payload?.data ?? payload;
      fanout('player-pos', data);
    });
    window.IZZA?.on?.('mp-worlds-counts', (payload)=> {
      const data = payload?.data ?? payload;
      fanout('worlds-counts', data);
    });
    // Let armoury pack announce loadout changes to everyone who cares
    window.IZZA?.on?.('inventory-changed', (_,{snapshot})=>{
      const snap = snapshot || readInventorySnapshot();
      fanout('inventory-changed', { snapshot: snap });
    });
  }catch{}

  // ---------- remote players model (per current world) ----------
  const REMOTES = [];                 // drawn list
  const byName = Object.create(null); // username → rp

  function clearRemotePlayers(){
    REMOTES.splice(0, REMOTES.length);
    for (const k in byName) delete byName[k];
    try{ if (window.IZZA?.api) IZZA.api.remotePlayers = REMOTES; }catch{}
  }

  function makeRemote(opts){
    const ap = opts?.appearance || readAppearanceFallback();
    const inv = opts?.inv || {};
    const rp = {
      username: (opts && opts.username) || 'player',
      appearance: ap,
      inv: inv,
      equipped: opts?.equipped || equippedFromInv(inv),
      x: +((opts && opts.x) ?? 0),
      y: +((opts && opts.y) ?? 0),
      facing: (opts && opts.facing) || 'down',
      moving:false, animTime:0, _lastX:0, _lastY:0,
      _imgs:null, _cols:{body:1,outfit:1,hair:1}
    };
    Promise.all([
      loadLayer('body',   rp.appearance.sprite_skin || 'default'),
      loadLayer('outfit', rp.appearance.outfit      || 'street'),
      loadLayer('hair',   rp.appearance.hair        || 'short')
    ]).then(([b,o,h])=>{
      rp._imgs = { body:b.img, outfit:o.img, hair:h.img };
      rp._cols = { body:b.cols, outfit:o.cols, hair:h.cols };
    });
    return rp;
  }

  function upsertRemote(p){
    const u = String(p?.username||'').trim(); if(!u) return;
    let rp = byName[u];
    if(!rp){ rp = byName[u] = makeRemote(p); REMOTES.push(rp); }
    if (typeof p.x==='number') rp.x = p.x;
    if (typeof p.y==='number') rp.y = p.y;
    if (p.facing) rp.facing = p.facing;
    if (p.appearance) rp.appearance = p.appearance;
    if (p.inv) rp.inv = normalizeInv(p.inv);
    if (p.equipped) rp.equipped = p.equipped;
  }

  // ---------- message handlers from server/bridge ----------
  function handlePlayersState(msg){
    // { world:"N"|"solo", players:[ {username,x,y,facing,appearance,inv,equipped}, ... ] }
    const w = String((msg && msg.world) || getWorld());
    if (w !== String(getWorld())) return; // ignore other worlds
    clearRemotePlayers();
    (Array.isArray(msg?.players) ? msg.players : []).forEach(upsertRemote);
  }
  function handlePlayerPos(msg){
    // { username, x, y, facing, world?, appearance?, inv?, equipped? }
    if (!msg) return;
    if (msg.world && String(msg.world)!==String(getWorld())) return;
    upsertRemote(msg);
  }

  REMOTE_PLAYERS_API.on('players-state', handlePlayersState);
  REMOTE_PLAYERS_API.on('player-pos',    handlePlayerPos);

  // ---------- renderer (draw after core) ----------
  function installRenderer(){
    if(window.__REMOTE_RENDER_INSTALLED__) return;
    window.__REMOTE_RENDER_INSTALLED__ = true;

    IZZA.on('render-post', ({ now })=>{
      try{
        const api = IZZA.api; if(!api || !api.ready) return;
        const cvs = document.getElementById('game'); if(!cvs) return;
        const ctx = cvs.getContext('2d');
        const S=api.DRAW, scale=S/api.TILE;

        ctx.save(); ctx.imageSmoothingEnabled=false;

        for(const p of REMOTES){
          if(!p || !p._imgs) continue;

          // motion → animate
          p.moving = (Math.abs(p.x - p._lastX) + Math.abs(p.y - p._lastY)) > 0.5;
          p._lastX = p.x; p._lastY = p.y;
          if(p.moving) p.animTime = (p.animTime||0) + 16; // ~60fps cadence

          const sx=(p.x - api.camera.x)*scale, sy=(p.y - api.camera.y)*scale;
          const row = DIR_INDEX[p.facing] || 0;
          const drawLayer = (img, cols)=>{
            if(!img) return;
            const frame = currentFrame(cols, p.moving, p.animTime||0);
            ctx.drawImage(img, frame*FRAME_W, row*FRAME_H, FRAME_W, FRAME_H, sx, sy, S, S);
          };
          drawLayer(p._imgs.body,   p._cols.body);
          drawLayer(p._imgs.outfit, p._cols.outfit);
          drawLayer(p._imgs.hair,   p._cols.hair);

          // nameplate (with tiny equipped hint)
          ctx.fillStyle = 'rgba(8,12,20,.85)';
          ctx.fillRect(sx + S*0.02, sy - S*0.28, S*0.96, S*0.22);
          ctx.fillStyle = '#d9ecff'; ctx.font = (S*0.20)+'px monospace';
          ctx.textAlign='center'; ctx.textBaseline='middle';
          const hint = (p.equipped==='uzi'?' [UZI]': p.equipped==='pistol'?' [PIS]': p.equipped==='grenade'?' [GRN]': p.equipped==='bat'?' [BAT]': p.equipped==='knuckles'?' [KNU]':'');
          ctx.fillText((p.username||'Opponent') + hint, sx + S*0.50, sy - S*0.17, S*0.92);
        }

        ctx.restore();
      }catch{}
    });
  }

  // ---------- public API for core/plugins ----------
  function installPublicAPI(){
    if(!window.IZZA || !IZZA.api) return;

    if(!IZZA.api.getAppearance){
      IZZA.api.getAppearance = function(){ return readAppearanceFallback(); };
    }
    if(!IZZA.api.getInventorySnapshot){
      IZZA.api.getInventorySnapshot = function(){ return readInventorySnapshot(); };
    }

    if(!IZZA.api.addRemotePlayer){
      IZZA.api.addRemotePlayer = function(opts){
        const rp = makeRemote(opts||{});
        const u = String(rp.username||'').trim(); if(u) byName[u]=rp;
        REMOTES.push(rp);
        return rp;
      };
    }

    IZZA.api.remotePlayers = REMOTES;
    if(!IZZA.api.clearRemotePlayers){
      IZZA.api.clearRemotePlayers = clearRemotePlayers;
    }
  }

  // ---------- react to world changes ----------
  function onWorldChanged(nextWorld){
    clearRemotePlayers();
    // ask server/bridge for the roster in the new world
    try{ REMOTE_PLAYERS_API.send('players-get', { world: String(nextWorld||getWorld()) }); }catch{}
  }

  // Core broadcasts (your core emits 'world-changed' already)
  try{ IZZA?.on?.('world-changed', ({ world })=> onWorldChanged(world)); }catch{}

  // Storage events (other tabs)
  window.addEventListener('storage', (ev)=>{
    if(ev.key==='izzaWorldId'){
      const next = String(ev.newValue||'solo');
      onWorldChanged(next);
    }
  });

  // ---------- boot ----------
  function boot(){
    installPublicAPI();
    installRenderer();
    // initial roster request
    try{ REMOTE_PLAYERS_API.send('players-get', { world: getWorld() }); }catch{}
  }

  if(window.IZZA && IZZA.on){
    IZZA.on('ready', boot);
  }else if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded', boot, { once:true });
  }else{
    boot();
  }
})();
