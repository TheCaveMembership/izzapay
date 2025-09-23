// Remote Players API — v1.3 (SOLO-aware + world presence via REST + mission freeze in MP)
(function(){
  const BUILD = 'v1.3-remote-players';
  console.log('[IZZA PLAY]', BUILD);

  // -------- config / helpers ----------
  const MP_BASE = (window.__MP_BASE__ || '/izza-game/api/mp');
  const TOK = (window.__IZZA_T__ || '').toString();
  const withTok = (p) => TOK ? p + (p.includes('?') ? '&' : '?') + 't=' + encodeURIComponent(TOK) : p;

  async function jget(p){
    const r = await fetch(withTok(MP_BASE+p), { credentials:'include' });
    if(!r.ok) throw new Error(`${r.status} ${r.statusText}`); return r.json();
  }
  async function jpost(p,b){
    const r = await fetch(withTok(MP_BASE+p), { method:'POST', credentials:'include', headers:{'Content-Type':'application/json'}, body:JSON.stringify(b||{}) });
    if(!r.ok) throw new Error(`${r.status} ${r.statusText}`); return r.json();
  }

  const getWorld = ()=> localStorage.getItem('izzaWorldId') || 'solo';
  const isMPWorld = ()=> { const w = getWorld(); return w!=='solo'; };

  // ---- appearance/inventory mirror (includes crafted armory if core exposes it) ----
  function readAppearance(){
    try{
      const p = window.__IZZA_PROFILE__ || {};
      // Prefer extended appearance blob if present
      return (p.appearance && Object.keys(p.appearance).length) ? p.appearance : {
        sprite_skin: p.sprite_skin || localStorage.getItem('sprite_skin') || 'default',
        hair:        p.hair        || localStorage.getItem('hair')        || 'short',
        outfit:      p.outfit      || localStorage.getItem('outfit')      || 'street',
        body_type:   p.body_type   || 'male',
        hair_color:  p.hair_color  || '',
        skin_tone:   p.skin_tone   || 'light',
        female_outfit_color: p.female_outfit_color || 'blue'
      };
    }catch{ return { sprite_skin:'default', hair:'short', outfit:'street' }; }
  }
  function readInventory(){
    // Merge base inventory + armory pack + crafted items if core exposes them
    const inv = {};
    try{
      const base = (IZZA?.api?.getInventory && IZZA.api.getInventory()) || {};
      Object.assign(inv, base);
    }catch{}
    try{
      const arm = (IZZA?.api?.getArmory && IZZA.api.getArmory()) || {};
      Object.assign(inv, arm);
    }catch{}
    try{
      const crafted = (IZZA?.api?.getCraftedItems && IZZA.api.getCraftedItems()) || {};
      // store under crafted:* or merge functional flags if any
      inv.crafted = crafted;
    }catch{}
    return inv;
  }

  // -------- remote players store ----------
  const REMOTES = [];
  const byName = Object.create(null);

  function clearRemotePlayers(){
    REMOTES.splice(0, REMOTES.length);
    for (const k in byName) delete byName[k];
    try{ if (window.IZZA?.api) IZZA.api.remotePlayers = REMOTES; }catch{}
  }

  // ---------- asset loaders (same as before) ----------
  function loadImg(src){ return new Promise((res)=>{ const i=new Image(); i.onload=()=>res(i); i.onerror=()=>res(null); i.src=src; }); }
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

  function makeRemote(opts){
    const rp = {
      username: (opts && opts.username) || 'player',
      appearance: (opts && opts.appearance) || readAppearance(),
      inv: (opts && opts.inv) || {},
      x: +((opts && opts.x) ?? 0), y: +((opts && opts.y) ?? 0),
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
    if (p.inv) rp.inv = p.inv;
  }

  // ---------- renderer ----------
  function installRenderer(){
    if(window.__REMOTE_RENDER_INSTALLED__) return;
    window.__REMOTE_RENDER_INSTALLED__ = true;

    IZZA.on('render-post', ({ now })=>{
      try{
        const api = IZZA.api; if(!api || !api.ready) return;
        if(!isMPWorld()) return; // do not render in SOLO

        const cvs = document.getElementById('game'); if(!cvs) return;
        const ctx = cvs.getContext('2d');
        const S=api.DRAW, scale=S/api.TILE;

        ctx.save(); ctx.imageSmoothingEnabled=false;

        for(const p of REMOTES){
          if(!p || !p._imgs) continue;

          p.moving = (Math.abs(p.x - p._lastX) + Math.abs(p.y - p._lastY)) > 0.5;
          p._lastX = p.x; p._lastY = p.y;
          if(p.moving) p.animTime = (p.animTime||0) + 16;

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

  // ---------- SOLO vs MP mission/NPC/vehicle toggles ----------
  function setMultiplayerMode(on){
    try{
      // Freeze mission engine if core exposes it
      IZZA?.api?.setMultiplayerMode?.(!!on);

      // Hide mission HUD + prompts
      const nodes = document.querySelectorAll('[data-ui="mission-hud"], #missionHud, .mission-hud, .mission-prompt, [data-ui="mission-prompt"]');
      nodes.forEach(n=> n.style.display = on ? 'none' : '');

      // Freeze common NPC/vehicle layers non-destructively (CSS)
      const hideSel = [
        '.npc', '[data-npc]', '.vehicle', '[data-vehicle]', '[data-role="npc"]'
      ].join(',');
      document.querySelectorAll(hideSel).forEach(n=>{
        if(on){
          if(!n.dataset._oldVis){ n.dataset._oldVis = n.style.visibility || ''; }
          n.style.visibility = 'hidden';
        }else{
          if('_oldVis' in n.dataset){ n.style.visibility = n.dataset._oldVis; delete n.dataset._oldVis; }
          else n.style.visibility = '';
        }
      });

      // App-level event for any other plugins
      window.dispatchEvent(new CustomEvent('izza-missions-toggle', { detail:{ enabled: !on }}));
    }catch{}
  }

  // ---------- REST presence poll/push ----------
  let lastRosterTs = 0;
  let tickT=null, rosterT=null, heartbeatT=null;

  async function sendHeartbeat(){
    if(!isMPWorld()) return;
    try{
      const me = (IZZA?.api?.player) || {x:0,y:0,facing:'down'};
      await jpost('/world/heartbeat', {
        x: me.x|0, y: me.y|0, facing: me.facing||'down',
        appearance: readAppearance(),
        inv: readInventory()
      });
    }catch(e){}
  }
  async function sendPos(){
    if(!isMPWorld()) return;
    try{
      const me = (IZZA?.api?.player) || {x:0,y:0,facing:'down'};
      await jpost('/world/pos', { x: me.x|0, y: me.y|0, facing: me.facing||'down' });
    }catch(e){}
  }
  async function pullRoster(){
    if(!isMPWorld()) return;
    try{
      const r = await jget('/world/roster?since=' + encodeURIComponent(lastRosterTs||0));
      if(r && r.ok){
        if(Array.isArray(r.players)){
          // Upsert partials; a full heartbeat from others carries appearance/inv
          r.players.forEach(upsertRemote);
        }
        if(typeof r.serverNow==='number') lastRosterTs = r.serverNow;
      }
    }catch(e){}
  }

  function armTimers(){
    disarmTimers();
    if(!isMPWorld()) return;
    heartbeatT = setInterval(sendHeartbeat, 4000);
    tickT      = setInterval(sendPos,      400);
    rosterT    = setInterval(pullRoster,   1500);
    // initial kicks
    sendHeartbeat();
    pullRoster();
  }
  function disarmTimers(){
    if(heartbeatT){ clearInterval(heartbeatT); heartbeatT=null; }
    if(tickT){ clearInterval(tickT); tickT=null; }
    if(rosterT){ clearInterval(rosterT); rosterT=null; }
  }

  // ---------- public bridge (for Worlds plugin, etc.) ----------
  const localListeners = Object.create(null);
  function listen(type, cb){ (localListeners[type] ||= []).push(cb); }
  function fanout(type, data){ (localListeners[type]||[]).forEach(fn=>{ try{ fn(data); }catch(e){ console.warn(e); } }); }

  const REMOTE_PLAYERS_API = window.REMOTE_PLAYERS_API = window.REMOTE_PLAYERS_API || {
    send(type, data){
      // Wire only what we support without websockets
      if(type==='join-world'){
        // data.world expected
        try{ jpost('/world/join', { world: String(data.world||'1') }); }catch{}
        onWorldChanged(String(data.world||'1'));
      }else if(type==='worlds-counts'){
        jget('/worlds/counts').then(j=> fanout('worlds-counts', j||{})).catch(()=>{});
      }else if(type==='players-get'){
        pullRoster();
      }
    },
    on(type, cb){ listen(type, cb); }
  };

  // ---------- world-change handling ----------
  function onWorldChanged(nextWorld){
    clearRemotePlayers();
    if(nextWorld==='solo'){ disarmTimers(); setMultiplayerMode(false); return; }
    setMultiplayerMode(true);
    lastRosterTs = 0;
    armTimers();
  }

  // Core or other plugins can broadcast this
  try{ IZZA?.on?.('world-changed', ({ world })=> onWorldChanged(world)); }catch{}
  window.addEventListener('storage', (ev)=>{
    if (ev.key==='izzaWorldId'){
      onWorldChanged(String(ev.newValue||'solo'));
    }
  });

  // ---------- renderer + boot ----------
  function installPublicAPI(){
    if(!window.IZZA || !IZZA.api) return;
    IZZA.api.remotePlayers = REMOTES;
    if(!IZZA.api.clearRemotePlayers) IZZA.api.clearRemotePlayers = clearRemotePlayers;
    if(!IZZA.api.getAppearance) IZZA.api.getAppearance = readAppearance;
  }

  function boot(){
    installPublicAPI();
    installRenderer();
    // SOLO or MP?
    onWorldChanged(getWorld());
  }

  if(window.IZZA && IZZA.on){
    IZZA.on('ready', boot);
  }else if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded', boot, { once:true });
  }else{
    boot();
  }
})();
