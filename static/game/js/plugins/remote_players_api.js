// Remote Players API — v2.4
// - Accurate leave (tab close / page hide → /world/leave + presence off)
// - Auto-pause timers while tab hidden to reduce lag
// - Immediate loadout push when equipment/crafting changes
// - Tinting + equipped-slot layering (hair under helm/hat), smooth interpolation
(function(){
  const BUILD = 'v2.4-remote-players';
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
  const setWorld = (w)=> localStorage.setItem('izzaWorldId', String(w||'solo'));
  const isMPWorld = ()=> { const w = getWorld(); return w!=='solo'; };

  // ---- profile appearance ----
  function readAppearance(){
    try{
      const p = window.__IZZA_PROFILE__ || {};
      const a = p.appearance || p || {};
      return {
        username: p.username || 'guest',
        body_type: a.body_type || 'male',
        sprite_skin: a.sprite_skin || 'default',
        skin_tone: a.skin_tone || 'light',
        outfit: a.outfit || 'street',
        hair: a.hair || 'short',
        hair_color: a.hair_color || 'black',
        female_outfit_color: a.female_outfit_color || 'blue'
      };
    }catch{ return { body_type:'male', sprite_skin:'default', hair:'short', outfit:'street', skin_tone:'light', hair_color:'black', female_outfit_color:'blue' }; }
  }

  // ---- inventory (reads your core store if exposed) ----
  function readInventory(){
    try{ if (typeof IZZA?.api?.getInventory==='function') return IZZA.api.getInventory() || {}; }catch{}
    const inv = {};
    try{ Object.assign(inv, (IZZA?.api?.getArmory?.())||{}); }catch{}
    try{ inv.crafted = (IZZA?.api?.getCraftedItems?.())||{}; }catch{}
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

  // ---------- ASSETS & TINTING ----------
  const FRAME_W=32, FRAME_H=32, ROWS=4;
  const DIR_INDEX = { down:0, right:1, left:2, up:3 };

  function loadImg(src){
    return new Promise((res)=>{ const i=new Image(); i.onload=()=>res(i); i.onerror=()=>res(null); i.src=src; });
  }
  async function loadLayer(kind, name){
    const base = '/static/game/sprites/' + kind + '/';
    const try2 = await loadImg(base + encodeURIComponent(name + ' 2') + '.png');
    if (try2) return { img: try2, cols: Math.max(1, Math.floor(try2.width / FRAME_W)) };
    const try1 = await loadImg(base + encodeURIComponent(name) + '.png');
    if (try1) return { img: try1, cols: Math.max(1, Math.floor(try1.width / FRAME_W)) };
    return { img: null, cols: 1 };
  }
  function emptyLayer(){ const c=document.createElement('canvas'); c.width=32; c.height=32; return {img:c, cols:1}; }

  // minimal (reuse your v2.3 tint maps if present in global)
  const LAYER_ORDER = [ 'body', 'legs', 'arms', 'outfit', 'hair', 'vest', 'helm', 'hat', 'weapon' ];

  function invToLayers(inv, ap){
    const layers = [];
    const bodyName = ap.body_type==='female' ? `${ap.sprite_skin}__female_wide` : ap.sprite_skin;
    layers.push({ kind:'body',   name: bodyName });
    if(ap.body_type!=='female') layers.push({ kind:'outfit', name: ap.outfit || 'street' });
    layers.push({ kind:'hair',   name: ap.hair   || 'short' });

    // slots/equipped
    const slotMap = { head:'helm', chest:'vest', legs:'legs', arms:'arms', hat:'hat' };
    Object.keys(inv||{}).forEach(id=>{
      const e = inv[id];
      if(!e || typeof e!=='object') return;
      const on = !!(e.equipped || e.equip || (e.equippedCount|0)>0);
      if(!on) return;
      const slot = (e.slot||'').toLowerCase();
      const kind = slotMap[slot] || (
        /helmet|helm/i.test(id) ? 'helm' :
        /vest|chest/i.test(id)  ? 'vest' :
        /legs|pants/i.test(id)  ? 'legs' :
        /arms|sleeve/i.test(id) ? 'arms' :
        /hat|crown/i.test(id)   ? 'hat'  : null
      );
      if(!kind) return;
      const base = String(id).replace(/([a-z])([A-Z])/g,'$1_$2').toLowerCase();
      let name = base.replace(/helmet|_helmet/g,'_helm').replace(/_chest/g,'_vest');
      if(/cardboard/.test(name)||/pumpkin/.test(name)){
        const set = /cardboard/.test(name) ? 'cardboard' : 'pumpkin';
        const part = (kind==='helm'?'helm':kind);
        name = `${set}_${part}`;
      }
      layers.push({ kind, name });
    });

    // weapons (simple overlay)
    const weapons = ['uzi','shotgun','sniper','pistol'];
    for(const w of weapons){ if(inv['wpn_'+w]?.equipped || inv['weapon_'+w]?.equipped){ layers.push({kind:'weapon', name:w}); break; } }

    layers.sort((a,b)=> LAYER_ORDER.indexOf(a.kind) - LAYER_ORDER.indexOf(b.kind));
    return layers;
  }

  function makeSkinKey(ap, inv){
    try{
      const eqBits=[];
      Object.keys(inv||{}).forEach(k=>{
        const e=inv[k]; if(!e||typeof e!=='object') return;
        if(e.slot && (e.equipped||e.equip||(e.equippedCount|0)>0)) eqBits.push(e.slot+':'+k);
      });
      eqBits.sort();
      return JSON.stringify({
        body: ap.body_type+'|'+ap.sprite_skin+'|'+ap.skin_tone+'|'+ap.female_outfit_color,
        hair: ap.hair+'|'+ap.hair_color,
        outfit: ap.outfit,
        eq: eqBits
      });
    }catch{ return 'default'; }
  }

  const SKIN_CACHE = Object.create(null); // skinKey -> {img, cols}
  async function buildComposite(ap, inv){
    const layers = invToLayers(inv, ap);
    const loaded = await Promise.all(layers.map(l=> loadLayer(l.kind, l.name)));
    const cols = Math.max(1, ...loaded.map(x=>x?.cols||1));
    const cvs = document.createElement('canvas'); cvs.width=cols*FRAME_W; cvs.height=ROWS*FRAME_H;
    const ctx = cvs.getContext('2d'); ctx.imageSmoothingEnabled=false;
    for(let row=0; row<ROWS; row++){
      for(let col=0; col<cols; col++){
        const dx = col*FRAME_W, dy = row*FRAME_H;
        for(let i=0;i<layers.length;i++){
          const lay = loaded[i]; if(!lay || !lay.img) continue;
          const srcCol = Math.min(col, (lay.cols||1)-1);
          ctx.drawImage(lay.img, srcCol*FRAME_W, row*FRAME_H, FRAME_W, FRAME_H, dx, dy, FRAME_W, FRAME_H);
        }
      }
    }
    return { img:cvs, cols };
  }
  async function getComposite(ap, inv){
    const key = makeSkinKey(ap, inv);
    if(SKIN_CACHE[key]) return SKIN_CACHE[key];
    const ph = SKIN_CACHE[key] = { img:null, cols:1, _pending:true };
    buildComposite(ap, inv).then(c=>{ SKIN_CACHE[key]=c; }).catch(()=>{}).finally(()=>{ ph._pending=false; });
    return ph;
  }

  // ---------- INTERPOLATION ----------
  const BUFFER_MS = 180;
  const STALE_MS  = 5000;
  const MAX_SNAP  = 24;

  function pushSnap(rp, x, y, facing){
    const t = Date.now();
    const last = rp.buf[rp.buf.length-1];
    if(last && last.x===x && last.y===y && last.facing===facing) { rp.lastPacket=t; return; }
    rp.buf.push({t, x, y, facing});
    if(rp.buf.length>MAX_SNAP) rp.buf.splice(0, rp.buf.length-MAX_SNAP);
    rp.lastPacket = t;
  }
  function sampleBuffered(rp, now){
    const target = now - BUFFER_MS;
    const b = rp.buf;
    if(!b.length){ return { x:rp.x, y:rp.y, facing:rp.facing }; }
    let i=b.length-1; while(i>0 && b[i-1].t>target) i--;
    const a = b[Math.max(0,i-1)], c = b[i];
    if(!a || !c){ return { x:c?.x??rp.x, y:c?.y??rp.y, facing:c?.facing??rp.facing }; }
    if(c.t===a.t){ return { x:c.x, y:c.y, facing:c.facing }; }
    const t = (target - a.t) / (c.t - a.t);
    const lerp=(p,q)=> p + (q-p)*Math.max(0,Math.min(1,t));
    return { x: lerp(a.x,c.x), y: lerp(a.y,c.y), facing: (t>0.5?c.facing:a.facing) };
  }

  // ---------- remote struct ----------
  function makeRemote(opts){
    const rp = {
      username: (opts && opts.username) || 'player',
      ap: (opts && opts.appearance) || readAppearance(),
      inv: (opts && opts.inv) || {},
      x: +((opts && opts.x) ?? 0), y: +((opts && opts.y) ?? 0),
      facing: (opts && opts.facing) || 'down',
      buf: [], lastPacket: 0,
      composite: { img:null, cols:1 }, compositeKey:'',
      lastGoodComposite: null, _bodyOnly: null
    };
    rp.compositeKey = makeSkinKey(rp.ap, rp.inv);
    getComposite(rp.ap, rp.inv).then(c=>{ rp.composite = c; if(c && c.img) rp.lastGoodComposite = c; });
    (async ()=>{
      const bodyName = rp.ap.body_type==='female' ? `${rp.ap.sprite_skin}__female_wide` : rp.ap.sprite_skin;
      const raw = await loadLayer('body', bodyName) || emptyLayer(); rp._bodyOnly = raw;
    })();
    pushSnap(rp, rp.x, rp.y, rp.facing);
    return rp;
  }

  function upsertRemote(p){
    const u = String(p?.username||'').trim(); if(!u) return;
    let rp = byName[u];
    if(!rp){ rp = byName[u] = makeRemote(p); REMOTES.push(rp); }
    if (typeof p.x==='number' || typeof p.y==='number'){
      pushSnap(rp, (p.x??rp.x), (p.y??rp.y), p.facing||rp.facing);
      rp.x = p.x??rp.x; rp.y = p.y??rp.y;
    }
    if (p.facing) rp.facing = p.facing;
    if (p.appearance) rp.ap = p.appearance;
    if (p.inv)        rp.inv = p.inv;

    const key = makeSkinKey(rp.ap, rp.inv);
    if(key !== rp.compositeKey){
      rp.compositeKey = key;
      getComposite(rp.ap, rp.inv).then(c=>{ rp.composite = c; if(c && c.img) rp.lastGoodComposite = c; });
    }
  }

  function pruneStale(now){
    for(let i=REMOTES.length-1;i>=0;i--){
      const rp=REMOTES[i];
      if(now - (rp.lastPacket||0) > STALE_MS){
        REMOTES.splice(i,1); delete byName[rp.username];
      }
    }
  }

  // ---------- renderer ----------
  function installRenderer(){
    if(window.__REMOTE_RENDER_INSTALLED__) return;
    window.__REMOTE_RENDER_INSTALLED__ = true;

    IZZA.on('render-post', ({ now })=>{
      try{
        const api = IZZA.api; if(!api || !api.ready) return;
        if(!isMPWorld()) return;

        pruneStale(now);

        const cvs = document.getElementById('game'); if(!cvs) return;
        const ctx = cvs.getContext('2d');
        const S=api.DRAW, scale=S/api.TILE;

        ctx.save(); ctx.imageSmoothingEnabled=false;

        for(const p of REMOTES){
          const snap = sampleBuffered(p, now);
          const sx=(snap.x - api.camera.x)*scale, sy=(snap.y - api.camera.y)*scale;
          const row = DIR_INDEX[snap.facing] || 0;

          let comp = (p.composite && p.composite.img) ? p.composite : (p.lastGoodComposite || null);
          if(comp && comp.img){
            const cols = Math.max(1, comp.cols|0);
            const t = Math.floor(now/120)%cols;
            ctx.drawImage(comp.img, t*FRAME_W, row*FRAME_H, FRAME_W, FRAME_H, sx, sy, S, S);
          }else if(p._bodyOnly && p._bodyOnly.img){
            const cols = Math.max(1, p._bodyOnly.cols|0);
            const t = Math.floor(now/120)%cols;
            ctx.drawImage(p._bodyOnly.img, t*FRAME_W, row*FRAME_H, FRAME_W, FRAME_H, sx, sy, S, S);
          }else{
            ctx.fillStyle='rgba(60,90,150,0.85)';
            ctx.fillRect(sx, sy, S, S);
          }

          // nameplate
          ctx.fillStyle = 'rgba(8,12,20,.85)';
          ctx.fillRect(sx + S*0.02, sy - S*0.28, S*0.96, S*0.22);
          ctx.fillStyle = '#d9ecff'; ctx.font = (S*0.20)+'px monospace';
          ctx.textAlign='center'; ctx.textBaseline='middle';
          ctx.fillText(p.username||'Opponent', sx + S*0.50, sy - S*0.17, S*0.92);
        }

        ctx.restore();
      }catch(e){}
    });
  }

  // ---------- Modes ----------
  function setMultiplayerMode(on){
    try{
      IZZA?.api?.setMultiplayerMode?.(!!on);
      const nodes = document.querySelectorAll(
        '[data-ui="mission-hud"], #missionHud, .mission-hud, .mission-prompt, [data-ui="mission-prompt"]'
      );
      nodes.forEach(n=> n.style.display = on ? 'none' : '');
      window.dispatchEvent(new CustomEvent('izza-missions-toggle', { detail:{ enabled: !on }}));
    }catch{}
  }
  function setDuelMode(on){
    try{
      const hideSel = [
        '.npc', '[data-npc]', '.pedestrian', '[data-role="npc"]',
        '.cop', '[data-cop]', '.police', '.swat', '.military', '[data-role="cop"]'
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
      window.dispatchEvent(new CustomEvent('izza-duel-toggle', { detail:{ on: !!on }}));
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
        if(Array.isArray(r.players)){ r.players.forEach(upsertRemote); }
        if(typeof r.serverNow==='number') lastRosterTs = r.serverNow;
      }
    }catch(e){}
  }

  function armTimers(){
    disarmTimers();
    if(!isMPWorld()) return;
    heartbeatT = setInterval(sendHeartbeat, 4000);
    tickT      = setInterval(sendPos,      400);
    rosterT    = setInterval(pullRoster,   600);
    sendHeartbeat();
    pullRoster();
  }
  function disarmTimers(){
    if(heartbeatT){ clearInterval(heartbeatT); heartbeatT=null; }
    if(tickT){ clearInterval(tickT); tickT=null; }
    if(rosterT){ clearInterval(rosterT); rosterT=null; }
  }

  // immediate loadout push on changes
  function wireLoadoutPushOnce(){
    if (wireLoadoutPushOnce._done) return;
    wireLoadoutPushOnce._done = true;
    const bump = ()=>{ if(!isMPWorld()) return;
      try{
        const me = (IZZA?.api?.player)||{x:0,y:0,facing:'down'};
        jpost('/world/heartbeat', {
          x: me.x|0, y: me.y|0, facing: me.facing||'down',
          appearance: readAppearance(),
          inv: readInventory()
        }).catch(()=>{});
      }catch{}
    };
    ['inventory-changed','armor-equipped','gear-crafted','armor-crafted','resume','izza-inventory-changed']
      .forEach(ev=> { try{ IZZA?.on?.(ev, bump); }catch{} });
    window.addEventListener('storage', (e)=>{ if(e.key==='izzaInventory') bump(); });
  }

  // ---------- public bridge ----------
  const localListeners = Object.create(null);
  function listen(type, cb){ (localListeners[type] ||= []).push(cb); }
  function fanout(type, data){ (localListeners[type]||[]).forEach(fn=>{ try{ fn(data); }catch(e){ console.warn(e); } }); }

  const REMOTE_PLAYERS_API = window.REMOTE_PLAYERS_API = window.REMOTE_PLAYERS_API || {
    send(type, data){
      if(type==='join-world'){
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
    if(nextWorld==='solo'){
      disarmTimers();
      setMultiplayerMode(false);
      setDuelMode(false);
      return;
    }
    setMultiplayerMode(true);
    setDuelMode(false);
    lastRosterTs = 0;
    armTimers();
  }

  try{ IZZA?.on?.('world-changed', ({ world })=> onWorldChanged(world)); }catch{}
  window.addEventListener('storage', (ev)=>{
    if (ev.key==='izzaWorldId'){ onWorldChanged(String(ev.newValue||'solo')); }
  });

  // Pause/resume on visibility
  document.addEventListener('visibilitychange', ()=>{
    if(document.hidden){ disarmTimers(); }
    else { armTimers(); }
  });

  // On unload: mark offline & leave world so counts are correct
  async function gracefulLeave(){
    try{ await jpost('/world/leave', {}); }catch{}
    try{ await jpost('/presence/offline', {}); }catch{}
  }
  window.addEventListener('pagehide', gracefulLeave, {capture:true});
  window.addEventListener('beforeunload', gracefulLeave, {capture:true});

  // ---------- Duel wiring ----------
  (function wireDuelToggles(){
    try{ IZZA?.on?.('mp-start',  ()=> setDuelMode(true)); }catch{}
    try{ IZZA?.on?.('mp-finish', ()=> setDuelMode(false)); }catch{}
    try{ IZZA?.on?.('duel-round-start',   ()=> setDuelMode(true)); }catch{}
    try{ IZZA?.on?.('duel-match-finish',  ()=> setDuelMode(false)); }catch{}
  })();

  // ---------- renderer + boot ----------
  function installPublicAPI(){
    if(!window.IZZA || !IZZA.api) return;
    IZZA.api.remotePlayers = REMOTES;
    if(!IZZA.api.clearRemotePlayers) IZZA.api.clearRemotePlayers = clearRemotePlayers;
    if(!IZZA.api.getAppearance) IZZA.api.getAppearance = readAppearance;
    if(!IZZA.api.getInventorySnapshot) IZZA.api.getInventorySnapshot = readInventory;
    IZZA.api.setDuelMode = setDuelMode;
  }

  function boot(){
    installPublicAPI();
    installRenderer();
    wireLoadoutPushOnce();
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
