<!-- remote_players_api.js -->
/* Remote Players API — v1.1 (world-aware + MP bridge + roster refresh) */
(function(){
  const BUILD = 'v1.1-remote-players-api';
  console.log('[IZZA PLAY]', BUILD);

  // ----------------- util: assets loader (matches core) -----------------
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

  const DIR_INDEX = { down:0, left:2, right:1, up:3 };
  const FRAME_W=32, FRAME_H=32, WALK_FPS=8, WALK_MS=1000/WALK_FPS;
  function currentFrame(cols, moving, tMs){ if(cols<=1) return 0; if(!moving) return 1%cols; return Math.floor(tMs/WALK_MS)%cols; }

  // ----------------- world helpers -----------------
  const getWorld = ()=> (localStorage.getItem('izzaWorldId') || '1');
  const setWorld = (id)=> localStorage.setItem('izzaWorldId', String(id||'1'));

  // ----------------- MP bridge (works with your Worlds plugin) -----------------
  // We define REMOTE_PLAYERS_API with send/on, and also mirror via IZZA bus.
  const listeners = {};
  function mpEmitLocal(type, data){
    // fan out to local .on handlers
    (listeners[type]||[]).forEach(fn=>{ try{ fn(data); }catch(e){ console.warn(e); } });
    // and also emit via IZZA bus for other plugins
    try{ window.IZZA?.emit?.('mp-'+type, { type, data }); }catch{}
  }
  const REMOTE_PLAYERS_API = window.REMOTE_PLAYERS_API = window.REMOTE_PLAYERS_API || {
    send(type, data){
      // If another MP transport exists, let it handle; otherwise broadcast on the IZZA bus.
      try{
        if (window.RemotePlayers?.send) return window.RemotePlayers.send(type, data);
        // Fallback: emit to bus; your server bridge (if present) should listen to 'mp-send'
        window.IZZA?.emit?.('mp-send', { type, data });
      }catch(e){ console.warn('[REMOTE] send fail', e); }
    },
    on(type, cb){
      try{
        if (window.RemotePlayers?.on) return window.RemotePlayers.on(type, cb);
      }catch(e){}
      (listeners[type] ||= []).push(cb);
    }
  };

  // Also subscribe to IZZA bus events so server bridges can forward into us.
  // Convention used by your Worlds plugin: IZZA.on('mp-'+type, ({data})=>...)
  try{
    window.IZZA?.on?.('mp-players-state', (_payload)=>{
      const data = _payload && (_payload.data || _payload); handlePlayersState(data);
    });
    window.IZZA?.on?.('mp-player-pos', (_payload)=>{
      const data = _payload && (_payload.data || _payload); handlePlayerPos(data);
    });
    window.IZZA?.on?.('mp-worlds-counts', (_payload)=>{
      const data = _payload && (_payload.data || _payload);
      // re-emit through local bridge for any listeners
      mpEmitLocal('worlds-counts', data);
    });
  }catch{}

  // ----------------- remote players model -----------------
  const REMOTES = [];                 // live list for current world
  const byName = Object.create(null); // username -> remote

  function clearRemotePlayers(){
    REMOTES.splice(0, REMOTES.length);
    for (const k in byName) delete byName[k];
    try{ IZZA?.api && (IZZA.api.remotePlayers = REMOTES); }catch{}
  }

  function getAppearanceFallback(){
    try{
      const p = (window.__IZZA_PROFILE__ || {});
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
      appearance: (opts && opts.appearance) || getAppearanceFallback(),
      x: (opts && +opts.x) || 0,
      y: (opts && +opts.y) || 0,
      facing: (opts && opts.facing) || 'down',
      moving: false,
      _imgs:null, _cols:{body:1,outfit:1,hair:1}, animTime:0,
      _lastX:0, _lastY:0
    };
    // lazy-load sheets
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
    const u = String(p.username||'').trim();
    if(!u) return;
    let rp = byName[u];
    if(!rp){
      rp = byName[u] = makeRemote(p);
      REMOTES.push(rp);
    }
    // update fields
    if (typeof p.x==='number') rp.x = p.x;
    if (typeof p.y==='number') rp.y = p.y;
    if (p.facing) rp.facing = p.facing;
    if (p.appearance) rp.appearance = p.appearance; // (layer images update on next spawn if needed)
  }

  // ----------------- message handlers -----------------
  function handlePlayersState(msg){
    // msg: { world: "N", players: [ {username,x,y,facing,appearance}, ... ] }
    const w = String((msg && msg.world) || getWorld());
    if (w !== String(getWorld())) return; // ignore other worlds
    clearRemotePlayers();
    const list = (msg && Array.isArray(msg.players)) ? msg.players : [];
    for (const p of list) upsertRemote(p);
  }

  function handlePlayerPos(msg){
    // msg: { username, x, y, facing, world? }
    if (!msg) return;
    if (msg.world && String(msg.world) !== String(getWorld())) return;
    upsertRemote(msg);
  }

  // wire into the local REMOTE_PLAYERS_API.on for consumers who prefer it
  REMOTE_PLAYERS_API.on('players-state', handlePlayersState);
  REMOTE_PLAYERS_API.on('player-pos',    handlePlayerPos);

  // ----------------- render hook (unchanged visuals) -----------------
  function installRenderer(){
    if(window.__REMOTE_RENDER_INSTALLED__) return;
    window.__REMOTE_RENDER_INSTALLED__ = true;

    IZZA.on('render-post', ({ now })=>{
      try{
        const api=IZZA.api; if(!api || !api.ready) return;
        const cvs=document.getElementById('game'); if(!cvs) return;
        const ctx=cvs.getContext('2d');
        const S=api.DRAW, scale=S/api.TILE;

        ctx.save(); ctx.imageSmoothingEnabled=false;

        for(const p of REMOTES){
          if(!p || !p._imgs) continue;
          // motion → animate
          p.moving = (Math.abs(p.x - p._lastX) + Math.abs(p.y - p._lastY)) > 0.5;
          p._lastX = p.x; p._lastY = p.y;
          if(p.moving) p.animTime = (p.animTime||0) + 16; // ~60fps

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

  // ----------------- public API for core/plugins -----------------
  function installPublicAPI(){
    if(!window.IZZA || !IZZA.api) return;

    if(!IZZA.api.getAppearance){
      IZZA.api.getAppearance = function(){
        return getAppearanceFallback();
      };
    }

    if(!IZZA.api.addRemotePlayer){
      IZZA.api.addRemotePlayer = function(opts){
        const rp = makeRemote(opts||{});
        const u = String(rp.username||'').trim();
        if (u) byName[u] = rp;
        REMOTES.push(rp);
        return rp;
      };
    }

    // world-aware helpers for other plugins
    IZZA.api.remotePlayers = REMOTES;
    if(!IZZA.api.clearRemotePlayers){
      IZZA.api.clearRemotePlayers = clearRemotePlayers;
    }
  }

  // ----------------- world change react: clear + request fresh roster -----
  function onWorldChanged(nextWorld){
    clearRemotePlayers();
    // ask server to send the new roster for this world
    try{ REMOTE_PLAYERS_API.send('players-get', { world: String(nextWorld||getWorld()) }); }catch{}
  }

  // From core: ‘world-changed’ (already emitted in your core)
  try{ IZZA?.on?.('world-changed', ({world})=> onWorldChanged(world)); }catch{}

  // From storage (other tabs)
  window.addEventListener('storage', (ev)=>{
    if(ev.key==='izzaWorldId'){
      const next = String(ev.newValue||'1');
      onWorldChanged(next);
    }
  });

  // ----------------- boot -----------------
  function boot(){
    installPublicAPI();
    installRenderer();

    // On first load, request the roster for the current world
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
