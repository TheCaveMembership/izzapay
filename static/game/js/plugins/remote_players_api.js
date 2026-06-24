// Remote Players API — v3.2 NODE MP
// Worlds 1–4 now talk to the Node persistence service multiplayer routes.
// SOLO = no remote players, missions enabled.
// Worlds 1–4 = remote players visible, missions hidden.

(function(){
  if (window.__IZZA_REMOTE_PLAYERS_V32_NODE__) return;
  window.__IZZA_REMOTE_PLAYERS_V32_NODE__ = true;

  const BUILD = 'v3.2-node-remote-players';
  console.log('[IZZA PLAY]', BUILD);

  const NODE_BASE_RAW =
    window.__MP_NODE_BASE__ ||
    window.__IZZA_NODE_MP_BASE__ ||
    window.__IZZA_PERSIST_BASE__ ||
    '';

  const MP_BASE = NODE_BASE_RAW
    ? String(NODE_BASE_RAW).replace(/\/$/, '') + '/api/mp'
    : (window.__MP_BASE__ || '/izza-game/api/mp');

  try{
    window.__MP_BASE__ = MP_BASE;
  }catch{}

  function readUsername(){
    try{
      const p = window.__IZZA_PROFILE__ || {};
      const a = p.appearance || {};
      let u =
        p.username ||
        p.pi_username ||
        a.username ||
        '';

      if(!u){
        const raw = localStorage.getItem('piAuthUser');
        if(raw){
          try{
            const j = JSON.parse(raw);
            u = j.username || j.pi_username || j.user || '';
          }catch{}
        }
      }

      if(!u && window.izzaUserKey?.get) u = window.izzaUserKey.get();

      return String(u || 'guest').trim().replace(/^@+/, '').toLowerCase();
    }catch{
      return 'guest';
    }
  }

  const TOK = (window.__IZZA_T__ || window.__PI_LOGIN_TOKEN__ || localStorage.getItem('izzaLoginToken') || '').toString();
  const USER = readUsername();

  function withAuth(p){
    let out = p;
    const add = (k,v)=>{
      if(!v) return;
      out += (out.includes('?') ? '&' : '?') + encodeURIComponent(k) + '=' + encodeURIComponent(v);
    };
    add('u', USER);
    add('t', TOK);
    return out;
  }

  function authBody(b){
    const body = Object.assign({}, b || {});
    if(USER && !body.u) body.u = USER;
    if(TOK && !body.t) body.t = TOK;
    return body;
  }

  function authHeaders(){
    const h = {'Content-Type':'application/json'};
    if(USER) h['X-IZZA-User'] = USER;
    if(TOK){
      h['X-IZZA-Token'] = TOK;
      h['Authorization'] = 'Bearer ' + TOK;
    }
    return h;
  }

  async function jget(p){
    const url = withAuth(MP_BASE + p);
    const r = await fetch(url, {
      credentials:'include',
      headers:authHeaders()
    });
    if(!r.ok){
      const txt = await r.text().catch(()=>'');
      throw new Error(`${r.status} ${r.statusText} ${txt.slice(0,160)}`);
    }
    return r.json();
  }

  async function jpost(p,b){
    const url = withAuth(MP_BASE + p);
    const r = await fetch(url, {
      method:'POST',
      credentials:'include',
      headers:authHeaders(),
      body:JSON.stringify(authBody(b))
    });
    if(!r.ok){
      const txt = await r.text().catch(()=>'');
      throw new Error(`${r.status} ${r.statusText} ${txt.slice(0,160)}`);
    }
    return r.json();
  }

  function clientLog(event, data){
    try{
      console.log('[REMOTE NODE DEBUG]', event, data || {});
      fetch(withAuth(MP_BASE + '/client-log'), {
        method:'POST',
        credentials:'include',
        headers:authHeaders(),
        body:JSON.stringify(authBody({
          event,
          build:BUILD,
          world:getWorld(),
          data:data || {},
          href:location.href,
          ts:Date.now()
        }))
      }).catch(()=>{});
    }catch{}
  }

  const getWorld = () => localStorage.getItem('izzaWorldId') || 'solo';
  const isMPWorld = () => getWorld() !== 'solo';

  function readAppearance(){
    try{
      const p = window.__IZZA_PROFILE__ || {};
      const a = p.appearance || p || {};
      return {
        username: USER || p.username || 'guest',
        body_type: a.body_type || 'male',
        sprite_skin: a.sprite_skin || 'default',
        skin_tone: a.skin_tone || 'light',
        outfit: a.outfit || 'street',
        hair: a.hair || 'short',
        hair_color: a.hair_color || 'black',
        female_outfit_color: a.female_outfit_color || 'blue'
      };
    }catch{
      return {
        username:USER || 'guest',
        body_type:'male',
        sprite_skin:'default',
        skin_tone:'light',
        outfit:'street',
        hair:'short',
        hair_color:'black',
        female_outfit_color:'blue'
      };
    }
  }

  function readInventory(){
    try{
      if(typeof IZZA?.api?.getInventory === 'function') return IZZA.api.getInventory() || {};
    }catch{}
    return {};
  }

  const REMOTES = [];
  const byName = Object.create(null);

  function clearRemotePlayers(){
    REMOTES.splice(0, REMOTES.length);
    for(const k in byName) delete byName[k];
    try{ IZZA.api.remotePlayers = REMOTES; }catch{}
  }

  const FRAME_W = 32, FRAME_H = 32, ROWS = 4;
  const DIR_INDEX = { down:0, right:1, left:2, up:3 };

  function loadImg(src){
    return new Promise(res=>{
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => res(null);
      i.src = src;
    });
  }

  async function loadLayer(kind, name){
    const base = '/static/game/sprites/' + kind + '/';
    const two = await loadImg(base + encodeURIComponent(name + ' 2') + '.png');
    if(two) return { img:two, cols:Math.max(1, Math.floor(two.width / FRAME_W)) };

    const one = await loadImg(base + encodeURIComponent(name) + '.png');
    if(one) return { img:one, cols:Math.max(1, Math.floor(one.width / FRAME_W)) };

    return { img:null, cols:1 };
  }

  const LAYER_ORDER = ['body','legs','arms','outfit','hair','vest','helm','hat','weapon'];

  function invToLayers(inv, ap){
    const layers = [];
    const bodyName = ap.body_type === 'female' ? `${ap.sprite_skin}__female_wide` : ap.sprite_skin;

    layers.push({ kind:'body', name:bodyName || 'default' });
    if(ap.body_type !== 'female') layers.push({ kind:'outfit', name:ap.outfit || 'street' });
    layers.push({ kind:'hair', name:ap.hair || 'short' });

    const slotMap = { head:'helm', chest:'vest', legs:'legs', arms:'arms', hat:'hat' };

    Object.keys(inv || {}).forEach(id=>{
      const e = inv[id];
      if(!e || typeof e !== 'object') return;

      const equipped = !!(e.equipped || e.equip || (e.equippedCount|0) > 0);
      if(!equipped) return;

      const slot = String(e.slot || '').toLowerCase();
      const kind = slotMap[slot] || (
        /helmet|helm/i.test(id) ? 'helm' :
        /vest|chest/i.test(id) ? 'vest' :
        /legs|pants/i.test(id) ? 'legs' :
        /arms|sleeve/i.test(id) ? 'arms' :
        /hat|crown/i.test(id) ? 'hat' : null
      );

      if(!kind) return;

      let name = String(id).replace(/([a-z])([A-Z])/g,'$1_$2').toLowerCase();
      name = name.replace(/helmet|_helmet/g,'_helm').replace(/_chest/g,'_vest');

      if(/cardboard/.test(name) || /pumpkin/.test(name)){
        const set = /cardboard/.test(name) ? 'cardboard' : 'pumpkin';
        const part = kind === 'helm' ? 'helm' : kind;
        name = `${set}_${part}`;
      }

      layers.push({ kind, name });
    });

    layers.sort((a,b)=> LAYER_ORDER.indexOf(a.kind) - LAYER_ORDER.indexOf(b.kind));
    return layers;
  }

  function makeSkinKey(ap, inv){
    try{
      const eq = [];
      Object.keys(inv || {}).forEach(k=>{
        const e = inv[k];
        if(e && e.slot && (e.equipped || e.equip || (e.equippedCount|0)>0)) eq.push(e.slot + ':' + k);
      });
      eq.sort();
      return JSON.stringify({
        body: `${ap.body_type}|${ap.sprite_skin}|${ap.skin_tone}|${ap.female_outfit_color}`,
        hair: `${ap.hair}|${ap.hair_color}`,
        outfit: ap.outfit,
        eq
      });
    }catch{
      return 'default';
    }
  }

  const SKIN_CACHE = Object.create(null);

  async function buildComposite(ap, inv){
    const layers = invToLayers(inv, ap);
    const loaded = await Promise.all(layers.map(l=>loadLayer(l.kind, l.name)));
    const cols = Math.max(1, ...loaded.map(x=>x?.cols || 1));

    const c = document.createElement('canvas');
    c.width = cols * FRAME_W;
    c.height = ROWS * FRAME_H;

    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;

    for(let row=0; row<ROWS; row++){
      for(let col=0; col<cols; col++){
        for(let i=0; i<loaded.length; i++){
          const lay = loaded[i];
          if(!lay || !lay.img) continue;
          const srcCol = Math.min(col, (lay.cols || 1) - 1);
          g.drawImage(lay.img, srcCol*FRAME_W, row*FRAME_H, FRAME_W, FRAME_H, col*FRAME_W, row*FRAME_H, FRAME_W, FRAME_H);
        }
      }
    }

    return { img:c, cols };
  }

  function getComposite(ap, inv){
    const key = makeSkinKey(ap, inv);
    if(SKIN_CACHE[key]) return Promise.resolve(SKIN_CACHE[key]);

    const ph = SKIN_CACHE[key] = { img:null, cols:1, pending:true };
    buildComposite(ap, inv).then(c=>{
      SKIN_CACHE[key] = c;
    }).catch(()=>{}).finally(()=>{
      ph.pending = false;
    });

    return Promise.resolve(ph);
  }

  const BUFFER_MS = 120;
  const PREDICT_MS = 120;
  const STALE_MS = 9000;
  const MAX_SNAP = 64;

  function pushSnap(rp, x, y, facing){
    const t = Date.now();
    const b = rp.buf;
    const last = b[b.length - 1];

    if(last){
      const dt = Math.max(1, t - last.t);
      rp.vx = (x - last.x) / dt;
      rp.vy = (y - last.y) / dt;
    }

    b.push({ t, x, y, facing });
    if(b.length > MAX_SNAP) b.splice(0, b.length - MAX_SNAP);
    rp.lastPacket = t;
  }

  function sampleBuffered(rp, now){
    const target = now - BUFFER_MS;
    const b = rp.buf;

    if(!b.length) return { x:rp.x, y:rp.y, facing:rp.facing };

    let i = b.length - 1;
    while(i > 0 && b[i-1].t > target) i--;

    const a = b[Math.max(0, i-1)];
    const c = b[i];

    if(!a || !c) return { x:c?.x ?? rp.x, y:c?.y ?? rp.y, facing:c?.facing ?? rp.facing };

    if(c.t >= target && a.t <= target && c.t !== a.t){
      const amt = Math.max(0, Math.min(1, (target - a.t) / (c.t - a.t)));
      return {
        x: a.x + (c.x - a.x) * amt,
        y: a.y + (c.y - a.y) * amt,
        facing: amt > 0.5 ? c.facing : a.facing
      };
    }

    const newest = b[b.length - 1];
    const lateBy = target - newest.t;

    if(lateBy > 0 && lateBy <= PREDICT_MS){
      return {
        x: newest.x + (rp.vx || 0) * lateBy,
        y: newest.y + (rp.vy || 0) * lateBy,
        facing: newest.facing
      };
    }

    return { x:newest.x, y:newest.y, facing:newest.facing };
  }

  function makeRemote(p){
    const rp = {
      username:p.username || 'player',
      ap:p.appearance || readAppearance(),
      inv:p.inv || {},
      x:+(p.x || 0),
      y:+(p.y || 0),
      facing:p.facing || 'down',
      buf:[],
      lastPacket:0,
      vx:0,
      vy:0,
      composite:{img:null, cols:1},
      compositeKey:'',
      lastGoodComposite:null
    };

    rp.compositeKey = makeSkinKey(rp.ap, rp.inv);
    getComposite(rp.ap, rp.inv).then(c=>{
      rp.composite = c;
      if(c && c.img) rp.lastGoodComposite = c;
    });

    pushSnap(rp, rp.x, rp.y, rp.facing);
    return rp;
  }

  function upsertRemote(p){
    const u = String(p?.username || '').trim();
    if(!u || u.toLowerCase() === USER.toLowerCase()) return;

    let rp = byName[u];
    if(!rp){
      rp = byName[u] = makeRemote(p);
      REMOTES.push(rp);
    }

    if(typeof p.x === 'number' || typeof p.y === 'number'){
      const x = p.x ?? rp.x;
      const y = p.y ?? rp.y;
      const facing = p.facing || rp.facing;
      pushSnap(rp, x, y, facing);
      rp.x = x;
      rp.y = y;
      rp.facing = facing;
    }

    if(p.appearance) rp.ap = p.appearance;
    if(p.inv) rp.inv = p.inv;

    const key = makeSkinKey(rp.ap, rp.inv);
    if(key !== rp.compositeKey){
      rp.compositeKey = key;
      getComposite(rp.ap, rp.inv).then(c=>{
        rp.composite = c;
        if(c && c.img) rp.lastGoodComposite = c;
      });
    }
  }

  function pruneStale(now){
    for(let i=REMOTES.length-1; i>=0; i--){
      const rp = REMOTES[i];
      if(now - (rp.lastPacket || 0) > STALE_MS){
        REMOTES.splice(i,1);
        delete byName[rp.username];
      }
    }
  }

  function installRenderer(){
    if(window.__IZZA_REMOTE_RENDER_INSTALLED__) return;
    window.__IZZA_REMOTE_RENDER_INSTALLED__ = true;

    IZZA.on('render-post', ({now})=>{
      try{
        const api = IZZA.api;
        if(!api || !api.ready || !isMPWorld()) return;

        pruneStale(Date.now());

        const cvs = document.getElementById('game');
        if(!cvs) return;

        const ctx = cvs.getContext('2d');
        const S = api.DRAW;
        const scale = S / api.TILE;

        ctx.save();
        ctx.imageSmoothingEnabled = false;

        for(const p of REMOTES){
          const snap = sampleBuffered(p, Date.now());
          const sx = (snap.x - api.camera.x) * scale;
          const sy = (snap.y - api.camera.y) * scale;
          const row = DIR_INDEX[snap.facing] || 0;

          const comp = (p.composite && p.composite.img) ? p.composite : p.lastGoodComposite;

          if(comp && comp.img){
            const cols = Math.max(1, comp.cols|0);
            const frame = Math.floor(now / 120) % cols;
            ctx.drawImage(comp.img, frame*FRAME_W, row*FRAME_H, FRAME_W, FRAME_H, sx, sy, S, S);
          }else{
            ctx.fillStyle = 'rgba(60,90,150,.85)';
            ctx.fillRect(sx, sy, S, S);
          }

          ctx.fillStyle = 'rgba(8,12,20,.85)';
          ctx.fillRect(sx + S*.02, sy - S*.28, S*.96, S*.22);
          ctx.fillStyle = '#d9ecff';
          ctx.font = (S*.20) + 'px monospace';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(p.username || 'Player', sx + S*.5, sy - S*.17, S*.92);
        }

        ctx.restore();
      }catch(e){
        clientLog('render-error', { message:e.message });
      }
    });
  }

  function setMultiplayerMode(on){
    try{
      IZZA?.api?.setMultiplayerMode?.(!!on);
      document.querySelectorAll('[data-ui="mission-hud"], #missionHud, .mission-hud, .mission-prompt, [data-ui="mission-prompt"]')
        .forEach(n=> n.style.display = on ? 'none' : '');
      window.dispatchEvent(new CustomEvent('izza-missions-toggle', { detail:{ enabled:!on }}));
    }catch{}
  }

  let posT = null;
  let rosterT = null;
  let heartbeatT = null;
  let lastSent = {x:null,y:null,facing:null};
  let joinedWorld = null;

  const RATE = {
    posMs: 80,
    rosterMs: 140,
    heartbeatMs: 2500
  };

  async function joinWorld(world){
    world = String(world || getWorld() || 'solo');
    if(world === 'solo') return {ok:true, world:'solo'};

    const r = await jpost('/world/join', {
      world,
      worldId:world,
      appearance:readAppearance(),
      inv:readInventory()
    });

    if(r && r.ok){
      joinedWorld = world;
      clientLog('node-join-ok', { world, counts:r.counts || null });
    }

    return r;
  }

  async function sendHeartbeat(){
    if(!isMPWorld()) return;
    try{
      const world = getWorld();
      if(joinedWorld !== world) await joinWorld(world);

      const me = IZZA?.api?.player || {x:0,y:0,facing:'down'};
      await jpost('/world/heartbeat', {
        world,
        worldId:world,
        x:me.x|0,
        y:me.y|0,
        facing:me.facing || 'down',
        appearance:readAppearance(),
        inv:readInventory()
      });
    }catch(e){
      clientLog('heartbeat-failed', { message:e.message });
    }
  }

  async function sendPos(){
    if(!isMPWorld()) return;
    try{
      const world = getWorld();
      if(joinedWorld !== world) await joinWorld(world);

      const me = IZZA?.api?.player || {x:0,y:0,facing:'down'};
      const x = me.x|0, y = me.y|0, facing = me.facing || 'down';

      if(lastSent.x === x && lastSent.y === y && lastSent.facing === facing) return;
      lastSent = {x,y,facing};

      await jpost('/world/pos', {world, worldId:world, x,y,facing});
    }catch(e){
      clientLog('pos-failed', { message:e.message });
    }
  }

  async function pullRoster(){
    if(!isMPWorld()) return;
    try{
      const world = getWorld();
      if(joinedWorld !== world) await joinWorld(world);

      const r = await jget('/world/roster?world=' + encodeURIComponent(world));
      if(r && r.ok){
        if(Array.isArray(r.players)) r.players.forEach(upsertRemote);
      }
    }catch(e){
      clientLog('roster-failed', { message:e.message });
    }
  }

  function armTimers(){
    disarmTimers();
    if(!isMPWorld()) return;

    posT = setInterval(sendPos, RATE.posMs);
    heartbeatT = setInterval(sendHeartbeat, RATE.heartbeatMs);
    rosterT = setInterval(pullRoster, RATE.rosterMs);

    joinWorld(getWorld()).catch(e=>clientLog('initial-join-failed', {message:e.message}));
    sendHeartbeat();
    pullRoster();
  }

  function disarmTimers(){
    if(posT){ clearInterval(posT); posT = null; }
    if(heartbeatT){ clearInterval(heartbeatT); heartbeatT = null; }
    if(rosterT){ clearInterval(rosterT); rosterT = null; }
  }

  function onWorldChanged(world){
    const next = String(world || getWorld() || 'solo');
    clearRemotePlayers();
    joinedWorld = null;
    lastSent = {x:null,y:null,facing:null};

    if(next === 'solo'){
      disarmTimers();
      setMultiplayerMode(false);
      try{ jpost('/presence/offline', {}).catch(()=>{}); }catch{}
      return;
    }

    setMultiplayerMode(true);
    armTimers();
  }

  const localListeners = Object.create(null);
  function listen(type, cb){ (localListeners[type] ||= []).push(cb); }
  function fanout(type, data){ (localListeners[type] || []).forEach(fn=>{ try{ fn(data); }catch{} }); }

  window.REMOTE_PLAYERS_API = {
    send(type, data){
      if(type === 'join-world'){
        const world = String(data?.world || data?.worldId || '1');
        joinWorld(world)
          .then(()=>onWorldChanged(world))
          .catch(e=>clientLog('api-join-world-failed', {world, message:e.message}));
      }else if(type === 'worlds-counts'){
        jget('/worlds/counts').then(j=>fanout('worlds-counts', j || {})).catch(e=>clientLog('counts-failed', {message:e.message}));
      }else if(type === 'players-get'){
        pullRoster();
      }
    },
    on(type, cb){ listen(type, cb); }
  };

  function wireLoadoutPushOnce(){
    if(wireLoadoutPushOnce.done) return;
    wireLoadoutPushOnce.done = true;

    const bump = ()=> sendHeartbeat();

    ['izza-inventory-changed','inventory-changed','armor-equipped','gear-crafted','armor-crafted']
      .forEach(ev=>{
        try{ IZZA?.on?.(ev, bump); }catch{}
        try{ window.addEventListener(ev, bump); }catch{}
      });

    window.addEventListener('storage', e=>{
      if(e.key === 'izzaInventory') bump();
    });
  }

  window.addEventListener('storage', ev=>{
    if(ev.key === 'izzaWorldId') onWorldChanged(ev.newValue || 'solo');
  });

  window.addEventListener('izza-world-changed', e=>{
    onWorldChanged(e?.detail?.world || getWorld());
  });

  try{
    IZZA?.on?.('world-changed', e=> onWorldChanged(e?.world || getWorld()));
  }catch{}

  window.addEventListener('beforeunload', ()=>{
    try{
      if(isMPWorld()) navigator.sendBeacon?.(withAuth(MP_BASE + '/presence/offline'), JSON.stringify(authBody({})));
    }catch{}
  });

  function installPublicAPI(){
    if(!window.IZZA || !IZZA.api) return;
    IZZA.api.remotePlayers = REMOTES;
    IZZA.api.clearRemotePlayers = clearRemotePlayers;
    if(!IZZA.api.getAppearance) IZZA.api.getAppearance = readAppearance;
    if(!IZZA.api.getInventorySnapshot) IZZA.api.getInventorySnapshot = readInventory;
  }

  function boot(){
    installPublicAPI();
    installRenderer();
    wireLoadoutPushOnce();
    clientLog('boot', { MP_BASE, USER, hasToken:!!TOK, world:getWorld() });
    onWorldChanged(getWorld());
  }

  if(window.IZZA && IZZA.on) IZZA.on('ready', boot);
  else if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, {once:true});
  else boot();
})();
