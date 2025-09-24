// Remote Players API — v2.2
// Smooth interpolation + skinKey compositing cache + robust asset loads
// Equipped-first armor replication (incl. crafted) + no "blue box" flicker
// SOLO-aware + world presence via REST (unchanged endpoints)
// Missions hidden only in MP worlds; Duel mode hides pedestrians/cops (vehicles kept)
(function(){
  const BUILD = 'v2.2-remote-players-smooth+skinKey+equipped-first+lastgood';
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

  // ---- appearance/inventory mirror ----
  function readAppearance(){
    try{
      const p = window.__IZZA_PROFILE__ || {};
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
    const inv = {};
    try{ Object.assign(inv, (IZZA?.api?.getInventory?.())||{}); }catch{}
    try{ Object.assign(inv, (IZZA?.api?.getArmory?.())||{}); }catch{}
    try{ inv.crafted = (IZZA?.api?.getCraftedItems?.())||{}; }catch{}
    // NEW: prioritize equipped snapshot if available
    try{
      inv.equipped =
        (IZZA?.api?.inventory?.equipped?.()) ||
        (IZZA?.api?.getEquipped?.()) ||
        null; // { helm:'armor_x_helm', vest:'armor_x_vest', arms:'armor_x_arms', legs:'armor_x_legs' }
    }catch{}
    return inv;
  }

  // export a snapshot helper for other modules (e.g., MP client)
  try{ if(!IZZA.api.getInventorySnapshot){ IZZA.api.getInventorySnapshot = readInventory; } }catch{}

  // -------- remote players store ----------
  const REMOTES = [];
  const byName = Object.create(null);

  function clearRemotePlayers(){
    REMOTES.splice(0, REMOTES.length);
    for (const k in byName) delete byName[k];
    try{ if (window.IZZA?.api) IZZA.api.remotePlayers = REMOTES; }catch{}
  }

  // ---------- ASSETS & SKIN CACHE ----------
  const FRAME_W=32, FRAME_H=32, ROWS=4;
  const DIR_INDEX = { down:0, right:1, left:2, up:3 };

  // Robust loader with one retry to avoid transient misses
  function loadImg(src){
    return new Promise((res)=>{
      const tryOnce = (url, n=0)=>{
        const i=new Image();
        i.onload=()=>res(i);
        i.onerror=()=> n<1 ? setTimeout(()=>tryOnce(url, n+1), 120) : res(null);
        i.src=url;
      };
      tryOnce(src);
    });
  }

  async function loadLayer(kind, name){
    const base = '/static/game/sprites/' + kind + '/';
    const try2 = await loadImg(base + encodeURIComponent(name + ' 2') + '.png');
    if (try2) return { img: try2, cols: Math.max(1, Math.floor(try2.width / FRAME_W)) };
    const try1 = await loadImg(base + encodeURIComponent(name) + '.png');
    if (try1) return { img: try1, cols: Math.max(1, Math.floor(try1.width / FRAME_W)) };
    return { img: null, cols: 1 };
  }

  // Order: back-to-front (body first, weapon last so it sits above)
  const LAYER_ORDER = [ 'body', 'legs', 'arms', 'outfit', 'vest', 'helm', 'hat', 'hair', 'weapon' ];

  // Parse “armor_<material>_(helm|vest|arms|legs)” → {kind, name}
  function parseArmorId(id){
    const m = /^armor_([a-z0-9]+)_(helm|vest|arms|legs)$/i.exec(id);
    if(!m) return null;
    return { kind: m[2], name: `${m[1]}_${m[2]}` };
  }

  // Convert inventory (+crafted + equipped) into a list of sprite layers to stack
  function invToLayers(inv){
    const ap = readAppearance();
    const layers = [];

    const c = (k)=> (inv?.[k]?.count|0)>0;

    // Base appearance (always)
    layers.push({ kind:'body',   name:(ap.sprite_skin || 'default') });
    layers.push({ kind:'outfit', name:(ap.outfit || 'street') });
    layers.push({ kind:'hair',   name:(ap.hair   || 'short') });

    // --- NEW: prefer explicit equipped slots if present ---
    const eq = inv?.equipped || null;
    if (eq) {
      if (eq.legs) { const p=parseArmorId(eq.legs); if(p) layers.push({kind:'legs', name:p.name}); }
      if (eq.arms) { const p=parseArmorId(eq.arms); if(p) layers.push({kind:'arms', name:p.name}); }
      if (eq.vest) { const p=parseArmorId(eq.vest); if(p) layers.push({kind:'vest', name:p.name}); }
      if (eq.helm) { const p=parseArmorId(eq.helm); if(p) layers.push({kind:'helm', name:p.name}); }
    } else {
      // Fallback to counts (legacy)
      if(c('armor_cardboard_legs') || c('cardboard_legs')) layers.push({kind:'legs', name:'cardboard_legs'});
      if(c('armor_cardboard_arms') || c('cardboard_arms')) layers.push({kind:'arms', name:'cardboard_arms'});
      if(c('armor_cardboard_vest') || c('cardboard_chest'))layers.push({kind:'vest', name:'cardboard_vest'});
      if(c('armor_cardboard_helm') || c('cardboard_helm')) layers.push({kind:'helm', name:'cardboard_helm'});
    }

    // Generic armor IDs (auto-map any material set you add later)
    Object.keys(inv||{}).forEach(id=>{
      if(!c(id)) return;
      const parsed = parseArmorId(id);
      if(parsed) layers.push(parsed);
    });

    // Crafted armor / cosmetics
    Object.keys(inv?.crafted||{}).forEach(k=>{
      const val = inv.crafted[k];
      const on  = (typeof val==='object') ? ((val.count|0)>0) : !!val;
      if(!on) return;

      // crafted “armor_<material>_<part>”
      const parsed = parseArmorId(k);
      if(parsed) layers.push(parsed);

      // Named cosmetics & hats
      if(/^hat_/.test(k)) layers.push({ kind:'hat', name:k.replace(/^hat_/,'') });
      if(/^(helm|vest|arms|legs|weapon|hair|outfit)_[a-z0-9]+$/i.test(k)){
        const [kind] = k.split('_', 2);
        layers.push({ kind, name: k.slice(kind.length+1) });
      }
      if(k==='gold_crown') layers.push({ kind:'hat', name:'gold_crown' });
    });

    // Weapons (pick one — priority order)
    const weaponKeys = ['uzi','shotgun','sniper','pistol','smg','rifle'];
    for(const w of weaponKeys){
      if(c('wpn_'+w) || c('weapon_'+w) || inv?.crafted?.['weapon_'+w]){
        layers.push({ kind:'weapon', name:w }); break;
      }
    }

    // Ensure layer order
    layers.sort((a,b)=> LAYER_ORDER.indexOf(a.kind) - LAYER_ORDER.indexOf(b.kind));
    return layers;
  }

  // skinKey = deterministic hash of appearance + inventory (counts + crafted + equipped)
  function makeSkinKey(ap, inv){
    try{
      const normInv = Object.keys(inv||{}).filter(k=>k!=='crafted' && k!=='equipped').sort()
        .map(k => k+':' + ((inv[k]?.count|0)||0));

      const normCraft = Object.keys(inv?.crafted||{}).sort()
        .map(k => k+':' + (typeof inv.crafted[k]==='object' ? (inv.crafted[k].count|0) : (inv.crafted[k]?1:0)));

      const normEq = inv?.equipped ? ['helm','vest','arms','legs']
        .map(sl => sl+':' + (inv.equipped[sl]||'')).join('|') : '';

      const key = {
        body: ap?.sprite_skin||'default',
        hair: ap?.hair||'short',
        outfit: ap?.outfit||'street',
        inv: normInv,
        crafted: normCraft,
        eq: normEq
      };
      return JSON.stringify(key);
    }catch{ return 'default'; }
  }

  const SKIN_CACHE = Object.create(null); // skinKey -> {img, cols}

  async function buildComposite(skinKey, layers){
    const loaded = await Promise.all(layers.map(l=>loadLayer(l.kind, l.name)));
    const cols = Math.max(1, ...loaded.map(x=>x?.cols||1));
    const cvs = document.createElement('canvas');
    cvs.width  = cols*FRAME_W;
    cvs.height = ROWS*FRAME_H;
    const ctx = cvs.getContext('2d');
    ctx.imageSmoothingEnabled = false;

    for(let row=0; row<ROWS; row++){
      for(let col=0; col<cols; col++){
        const dx = col*FRAME_W, dy = row*FRAME_H;
        for(let i=0;i<layers.length;i++){
          const lay = loaded[i];
          if(!lay || !lay.img) continue; // skip missing layers (prevents invisibility)
          const srcCol = Math.min(col, (lay.cols||1)-1);
          ctx.drawImage(lay.img, srcCol*FRAME_W, row*FRAME_H, FRAME_W, FRAME_H, dx, dy, FRAME_W, FRAME_H);
        }
      }
    }
    SKIN_CACHE[skinKey] = { img:cvs, cols };
    return SKIN_CACHE[skinKey];
  }

  async function getComposite(ap, inv){
    const skinKey = makeSkinKey(ap, inv);
    if(SKIN_CACHE[skinKey]) return SKIN_CACHE[skinKey];
    // Build lazily; placeholder entry avoids flicker
    const ph = SKIN_CACHE[skinKey] = { img:null, cols:1, _pending:true };
    buildComposite(skinKey, invToLayers(inv))
      .then(()=>{ ph._pending=false; })
      .catch(()=>{ ph._pending=false; });
    return ph;
  }

  // ---------- INTERPOLATION BUFFER ----------
  const BUFFER_MS = 140;        // render slightly behind for smoothness
  const STALE_MS  = 5000;       // drop if no updates for this long
  const MAX_SNAP  = 24;         // keep last N snapshots per player

  function pushSnap(rp, x, y, facing){
    const t = Date.now();
    rp.buf.push({t, x, y, facing});
    if(rp.buf.length>MAX_SNAP) rp.buf.splice(0, rp.buf.length-MAX_SNAP);
    rp.lastPacket = t;
  }
  function sampleBuffered(rp, now){
    const target = now - BUFFER_MS;
    const b = rp.buf;
    if(!b.length){
      return { x:rp.x, y:rp.y, facing:rp.facing };
    }
    let i=b.length-1;
    while(i>0 && b[i-1].t>target) i--;
    const a = b[Math.max(0,i-1)];
    const c = b[i];
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
      lastGoodComposite: null,            // NEW: stable fallback once something rendered
      _bodyOnly: null                     // NEW: bare body sprite fallback
    };
    rp.compositeKey = makeSkinKey(rp.ap, rp.inv);
    getComposite(rp.ap, rp.inv).then(c=>{ rp.composite = c; if(c && c.img) rp.lastGoodComposite = c; });
    loadLayer('body', rp.ap.sprite_skin || 'default').then(b=>{ rp._bodyOnly = b; });
    pushSnap(rp, rp.x, rp.y, rp.facing); // seed
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
        if(!isMPWorld()) return; // do not render in SOLO

        pruneStale(now);

        const cvs = document.getElementById('game'); if(!cvs) return;
        const ctx = cvs.getContext('2d');
        const S=api.DRAW, scale=S/api.TILE;
        ctx.save(); ctx.imageSmoothingEnabled=false;

        for(const p of REMOTES){
          const snap = sampleBuffered(p, now);
          const sx=(snap.x - api.camera.x)*scale, sy=(snap.y - api.camera.y)*scale;
          const row = DIR_INDEX[snap.facing] || 0;

          // Prefer current composite, else last-good, else bare body, else tiny box
          let drawn = false;
          const comp = p.composite && p.composite.img ? p.composite : (p.lastGoodComposite || null);
          if(comp && comp.img){
            const cols = Math.max(1, comp.cols|0);
            const t = Math.floor(now/120)%cols; // simple walk frame
            ctx.drawImage(comp.img, t*FRAME_W, row*FRAME_H, FRAME_W, FRAME_H, sx, sy, S, S);
            drawn = true;
          }else if(p._bodyOnly && p._bodyOnly.img){
            const cols = Math.max(1, p._bodyOnly.cols|0);
            const t = Math.floor(now/120)%cols;
            ctx.drawImage(p._bodyOnly.img, t*FRAME_W, row*FRAME_H, FRAME_W, FRAME_H, sx, sy, S, S);
            drawn = true;
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
  // Multiplayer mode: missions hidden only (keep world population intact)
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

  // Duel mode: hide pedestrians & cops; KEEP vehicles visible
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
        if(Array.isArray(r.players)){
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
    tickT      = setInterval(sendPos,      400);   // keep your cadence
    rosterT    = setInterval(pullRoster,   800);   // a bit faster → steadier buffer
    sendHeartbeat();
    pullRoster();
  }
  function disarmTimers(){
    if(heartbeatT){ clearInterval(heartbeatT); heartbeatT=null; }
    if(tickT){ clearInterval(tickT); tickT=null; }
    if(rosterT){ clearInterval(rosterT); rosterT=null; }
  }

  // --- NEW: push updated loadout immediately on changes (equipped/crafted/etc)
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

    ['inventory-changed','armor-equipped','gear-crafted','armor-crafted','resume']
      .forEach(ev=> IZZA?.on?.(ev, bump));
  }

  // ---------- public bridge (for Worlds plugin, etc.) ----------
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
    if (ev.key==='izzaWorldId'){
      onWorldChanged(String(ev.newValue||'solo'));
    }
  });

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
    wireLoadoutPushOnce();   // NEW: start listening for equip/craft changes
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
