// Remote Players API — v1.2 (world-aware + MP bridge + roster refresh)
(function(){
  const BUILD = 'v1.2-remote-players-api';
  console.log('[IZZA PLAY]', BUILD);

  // ---------- asset loaders (same behavior as core) ----------
  function loadImg(src){
    return new Promise((res)=>{ const i=new Image(); i.onload=()=>res(i); i.onerror=()=>res(null); i.src=src; });
  }
  async function loadLayer(kind, name){
    const base = '/static/game/sprites/' + kind + '/';
    const try2 = await loadImg(base + encodeURIComponent(name + ' 2') + '.png');
    if (try2) return { img: try2, cols: Math.max(1, Math.floor(try2.width / 32)) };
    const try1 = await loadImg(base + encodeURIComponent(name) + '.png');
    if (try1) return { img: try1, cols: Math.max(1, Math.floor(try1.width / 32)) };
    return { img: null, cols: 1 };
  }

  // ---------- anim helpers (match core) ----------
  const DIR_INDEX = { down:0, left:2, right:1, up:3 };
  const FRAME_W=32, FRAME_H=32, WALK_FPS=8, WALK_MS=1000/WALK_FPS;
  function currentFrame(cols, moving, tMs){ if(cols<=1) return 0; if(!moving) return 1%cols; return Math.floor(tMs/WALK_MS)%cols; }

  // ---------- world helpers ----------
  const getWorld = ()=> (localStorage.getItem('izzaWorldId') || '1');

  // ---------- minimal MP bridge ----------
  const localListeners = Object.create(null);
  function listen(type, cb){ (localListeners[type] ||= []).push(cb); }
  function fanout(type, data){ (localListeners[type]||[]).forEach(fn=>{ try{ fn(data); }catch(e){ console.warn(e); } }); }

  // Public bridge used by other plugins (and your Worlds plugin)
  const REMOTE_PLAYERS_API = window.REMOTE_PLAYERS_API = window.REMOTE_PLAYERS_API || {
    send(type, data){
      try{
        // Prefer a real transport if present
        if (window.RemotePlayers?.send) return window.RemotePlayers.send(type, data);
        // Otherwise emit to IZZA bus; your server bridge should mirror this out
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
  }catch{}

  // ---------- remote players model (per current world) ----------
  const REMOTES = [];                 // drawn list
  const byName = Object.create(null); // username → rp

  function clearRemotePlayers(){
    REMOTES.splice(0, REMOTES.length);
    for (const k in byName) delete byName[k];
    try{ if (window.IZZA?.api) IZZA.api.remotePlayers = REMOTES; }catch{}
  }

  function readAppearanceFallback(){
    try{
      const p = window.__IZZA_PROFILE__ || {};
      return {
        sprite_skin: p.sprite_skin || localStorage.getItem('sprite_skin') || 'default',
        hair:        p.hair        || localStorage.getItem('hair')        || 'short',
        outfit:      p.outfit      || localStorage.getItem('outfit')      || 'street'
      };
    }catch{ return { sprite_skin:'default', hair:'short', outfit:'street' }; }
  }

  function makeRemote(opts){
    const rp = {
      username: (opts && opts.username) || 'player',
      appearance: (opts && opts.appearance) || readAppearanceFallback(),
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
    if (p.appearance) rp.appearance = p.appearance; // (sprites update lazily on first load)
  }

  // ---------- message handlers from server/bridge ----------
  function handlePlayersState(msg){
    // { world:"N", players:[ {username,x,y,facing,appearance}, ... ] }
    const w = String((msg && msg.world) || getWorld());
    if (w !== String(getWorld())) return; // ignore other worlds
    clearRemotePlayers();
    (Array.isArray(msg?.players) ? msg.players : []).forEach(upsertRemote);
  }
  function handlePlayerPos(msg){
    // { username, x, y, facing, world? }
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

          // nameplate
          ctx.fillStyle = 'rgba(8,12,20,.85)';
          ctx.fillRect(sx + S*0.02, sy - S*0.28, S*0.96, S*0.22);
          ctx.fillStyle = '#d9ecff'; ctx.font = (S*0.20)+'px monospace';
          ctx.textAlign='center'; ctx.textBaseline='middle';
          ctx.fillText(p.username||'Opponent', sx + S*0.50, sy - S*0.17, S*0.92);
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
      const next = String(ev.newValue||'1');
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
