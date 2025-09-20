(function(){
  const BUILD='v1.19-free-drive+hit-only-when-moving+delegate-chasing+correct-sprite-layer+tanks-slower+rocket-fullheart+cool-reenter';
  console.log('[IZZA PLAY]', BUILD);

  const M3_KEY='izzaMission3';
  const HIJACK_RADIUS = 22;
  const CAR_SPEED     = 120;
  const PARK_MS       = 5*60*1000;

  const CAR_HIT_RADIUS= 24;
  const DROP_GRACE_MS = 1000;
  const DROP_OFFSET   = 18;

  const VEH_DRAW_SCALE = 1.15;

  // NEW: threshold to count as "moving" (pixels per second)
  const CAR_HIT_SPEED_MIN = 18; // tweak if needed

  let api=null;
  let driving=false, car=null, savedWalk=null;

  // ---- speed floor wrappers (cannot be overridden by later writes) ----
const SPEED_KEYS = ['speed','moveSpeed','maxSpeed','maxVel'];
const _speedFloor = { armed:false, floor:120, bak:{}, backing:{} };

function armSpeedFloor(floor){
  try{
    const p = api && api.player; if(!p || _speedFloor.armed) return;
    _speedFloor.floor = floor|0;
    _speedFloor.bak = {};
    _speedFloor.backing = {};

    SPEED_KEYS.forEach(k=>{
      // snapshot current descriptor & value
      const desc = Object.getOwnPropertyDescriptor(p, k) || { configurable:true, enumerable:true, writable:true, value:p[k] };
      _speedFloor.bak[k] = desc;
      const initial = (typeof p[k] === 'number') ? p[k] : 0;
      _speedFloor.backing[k] = initial;

      // define floor-enforcing accessor
      Object.defineProperty(p, k, {
        configurable: true,
        enumerable: desc.enumerable !== false,
        get(){ return Math.max(_speedFloor.backing[k] || 0, (_speedFloor.armed ? _speedFloor.floor : 0)); },
        set(v){
          // keep last writer's intent, but reads are floored while armed
          _speedFloor.backing[k] = (typeof v === 'number') ? v : _speedFloor.backing[k];
        }
      });
    });

    _speedFloor.armed = true;
  }catch(e){ console.warn('[free-drive] speed floor arm failed', e); }
}

function disarmSpeedFloor(){
  try{
    const p = api && api.player; if(!p || !_speedFloor.armed) return;
    SPEED_KEYS.forEach(k=>{
      const bak = _speedFloor.bak[k];
      if(bak){
        // restore original descriptor/value safely
        try{
          Object.defineProperty(p, k, bak);
        }catch{
          // last resort: direct write
          p[k] = _speedFloor.backing[k];
        }
      }
    });
  }catch(e){ console.warn('[free-drive] speed floor disarm failed', e); }
  finally{
    _speedFloor.armed = false;
    _speedFloor.bak = {};
    _speedFloor.backing = {};
  }
}

// ultra-belt & suspenders in case defineProperty failed (old browsers etc.)
function forceSpeedNow(min){
  if(!api?.player) return;
  const p = api.player;
  if (typeof p.speed     === 'number' && p.speed     < min) p.speed     = min;
  if (typeof p.moveSpeed === 'number' && p.moveSpeed < min) p.moveSpeed = min;
  if (typeof p.maxSpeed  === 'number' && p.maxSpeed  < min) p.maxSpeed  = min;
  if (typeof p.maxVel    === 'number' && p.maxVel    < min) p.maxVel    = min;
}

  // Track movement to decide if collisions kill cops
  let prevPX=0, prevPY=0;
  let carMoving=false;

  const parked = []; // {x,y,kind,timeoutId,hijackTag?}

  // --- pursuit persistence / escalation (read-only here) ---
  const PURSUER_KEYS = ['cops','swat','military','army','helicopters','tanks'];
  let lastCarCrimeAt = 0; // updated ONLY on hijack
  const now = ()=>performance.now();

  // “Hot car” session: set when a traffic car is hijacked; cleared when all pursuers are gone.
  let hijackTag = null;

  // Snapshots of exact pursuers before transitions
  let pursuerSnap = null;
  // Guard window to block/undo wanted=0 wipes right after transitions
  let guardUntil = 0;
  let guardWanted = 0;
  let spawnLockUntil = 0; // prevents other systems from spawning for a brief period (we use this on death)

  // --- escalation helpers ---
  const MAX_WANTED = 5;
  let fiveStarSince = 0;

  // Tanks: composite “boss” units built from existing sprites, can be many
  let tanks = [];   // [{x,y,hp,parts:[{dx,dy,w,h}],fireCd}]
  const TANK_BUILD_STARS = 5;
  const TANK_BUILD_HOLD_MS = 30000;     // first tank after holding 5★ for 30s
  const TANK_RESPAWN_EVERY_MS = 30000;  // additional tanks every 30s while still 5★

  // Tanks should be a little slower than cars (about 85%)
  const TANK_SPEED = Math.round(CAR_SPEED * 0.85);
  const TANK_HP = 40;
  let nextTankAt = 0;

  // Bigger body footprint (~2x car footprint) with “digital camo”
  const TANK_PARTS = [
    {dx:-44, dy:-28, w:32, h:22}, {dx:-6,  dy:-28, w:32, h:22}, {dx:32, dy:-28, w:32, h:22},
    {dx:-44, dy:  6, w:32, h:22}, {dx:-6,  dy:  6, w:32, h:22}, {dx:32, dy:  6, w:32, h:22}
  ];

  // Rockets
  const ROCKET_SPEED = 240;
  const ROCKET_COOLDOWN_MS = 1200;
  const ROCKET_RADIUS = 10;
  let rockets = []; // {x,y,vx,vy}

  // Rolling reinforcement tracker (we no longer spawn cops here)
  const REINFORCE_EVERY_MS = 30000;
  let lastReinforceAt = 0;

  // After-death spawn suppression (defense vs other systems)
  let suppressAllSpawnsUntil = 0;

  function isArray(a){ return Array.isArray(a); }

  function pursuerCount(){
    try{
      let n=0;
      PURSUER_KEYS.forEach(k=>{
        n += (api[k]&&api[k].length)|0;
      });
      n += tanks.length;
      return n|0;
    }catch{ return tanks.length|0; }
  }

  function snapshotPursuers(){
    try{
      pursuerSnap = {};
      PURSUER_KEYS.forEach(k=>{
        const src = api[k];
        if (isArray(src) && src.length){
          pursuerSnap[k] = src.map(u=>({
            x:u.x, y:u.y, spd:u.spd, hp:u.hp, kind:u.kind||k,
            facing:u.facing||'down',
            state:u.state||'chase',
            reinforceAt: (u.reinforceAt||now()+30000)
          }));
        }
      });
    }catch{ pursuerSnap = null; }
  }

  function restorePursuers(){
    try{
      if (!pursuerSnap) return;
      PURSUER_KEYS.forEach(k=>{
        if (pursuerSnap[k]){
          if (!api[k]) api[k] = [];
          api[k].length = 0; // clear in place (preserve references)
          pursuerSnap[k].forEach(u=> api[k].push(Object.assign({}, u)));
        }
      });
    }catch{}
  }

  // NOTE: ONLY actual hijacks may force a minimum wanted level.
  // We DO NOT bump stars here anymore; chasing plugin handles escalation.
  function armGuard(reason){
    const isCarCrime = (reason==='enter-traffic'); // hijack only
    guardWanted = (api.player?.wanted|0) || 0;

    // Do NOT bump stars here; just preserve current wanted from external systems.
    guardUntil = now() + 900; // ~0.9s
    spawnLockUntil = isCarCrime ? 0 : (guardUntil + 400);

    // Keep whatever stars exist; no floors.
    restorePursuers();
    setTimeout(restorePursuers, 0);
  }

  // -------------------- REMOVED: local cop spawners ----------------------
  // (spawnCopNearPlayer, timedReinforcement) -> deleted to delegate to v_chasing.js

  // Sync session with pursuit presence (no star writes here)
  function syncWantedWithPursuit(){
    if(!api?.player) return;
    const n = pursuerCount();
    if(n===0){
      // end hot-car session
      if(hijackTag) hijackTag = null;
      lastCarCrimeAt = 0;
      fiveStarSince = 0;
      nextTankAt = 0;
      destroyAllTanks();
    }
  }

  // Guard against unwanted star wipes during transitions
  IZZA.on?.('wanted-changed', ()=>{
    if (!api) return;
    if (now() <= guardUntil){
      restorePursuers();
      setTimeout(restorePursuers, 0);
    }
    if ((api.player?.wanted|0) >= TANK_BUILD_STARS){
      if (!fiveStarSince) fiveStarSince = now();
    }else{
      fiveStarSince = 0;
      nextTankAt = 0;
      destroyAllTanks();
    }
  });

  // ---- vehicle sprite loader ----
  const VEH_KINDS = ['sedan','taxi','van','pickup','sport'];
  function ensureVehicleSheets(){
    if (window.VEHICLE_SHEETS && window.VEHICLE_SHEETS.__ready) return Promise.resolve(window.VEHICLE_SHEETS);
    window.VEHICLE_SHEETS = window.VEHICLE_SHEETS || {};
    const root = '/static/game/sprites/vehicles';
    const load = (k)=> new Promise((res)=> {
      const img = new Image();
      img.onload = ()=> res({k, ok:true, img});
      img.onerror= ()=> res({k, ok:false, img:null});
      img.src = `${root}/${k}.png`;
    });
    return Promise.all(VEH_KINDS.map(load)).then(list=>{
      list.forEach(r=>{
        if(r.ok) window.VEHICLE_SHEETS[r.k] = {img:r.img};
      });
      window.VEHICLE_SHEETS.__ready = true;
      return window.VEHICLE_SHEETS;
    });
  }
  function pickRandomKind(){
    return VEH_KINDS[(Math.random()*VEH_KINDS.length)|0] || 'sedan';
  }

  function m3Done(){
    try{
      if(localStorage.getItem(M3_KEY)==='done') return true;
      const ms = (api.getMissionCount&&api.getMissionCount())||0;
      return ms>=3;
    }catch{ return false; }
  }

  function uiReallyBusy(){
    const ids = ['enterModal', 'shopModal', 'hospitalShop'];
    return ids
      .map(id=>document.getElementById(id))
      .some(el=> el && el.style.display && el.style.display!=='none');
  }

  function _dropPos(vx,vy){
    const dx = vx - api.player.x, dy = vy - api.player.y;
    const m  = Math.hypot(dx,dy) || 1;
    return { x: vx + (dx/m)*DROP_OFFSET, y: vy + (dy/m)*DROP_OFFSET };
  }

  function nearestTrafficCar(){
    let best=null, bestD=1e9;
    for(const c of api.cars||[]){
      const d=Math.hypot(api.player.x-c.x, api.player.y-c.y);
      if(d<bestD){ best=c; bestD=d; }
    }
    return (bestD<=HIJACK_RADIUS) ? best : null;
  }
  function nearestParkedCar(){
    let best=null, bestD=1e9, bestIdx=-1;
    parked.forEach((p,i)=>{
      const d = Math.hypot(api.player.x-p.x, api.player.y-p.y);
      if(d<bestD){ best=p; bestD=d; bestIdx=i; }
    });
    return (best && bestD<=HIJACK_RADIUS) ? {car:best, idx:bestIdx} : null;
  }

  function startDrivingFromTraffic(fromCar){
    const idx=(api.cars||[]).indexOf(fromCar);
    if(idx>=0) api.cars.splice(idx,1);

    try{
      const skins=['ped_m','ped_f','ped_m_dark','ped_f_dark'];
      const skin=skins[(Math.random()*skins.length)|0];
      (api.pedestrians||[]).push({
        x: fromCar.x, y: fromCar.y,
        mode:'vert', dir: (Math.random()<0.5?-1:1), spd:40,
        hp:4, state:'walk', crossSide:'top',
        vertX: Math.floor(fromCar.x/api.TILE),
        blinkT:0, skin, facing:'down', moving:true
      });
    }catch{}

    snapshotPursuers();

    const kind = fromCar.kind || pickRandomKind();
    car={x:api.player.x,y:api.player.y, kind};
    driving=true;
    if(savedWalk==null) savedWalk=api.player.speed;
    api.player.speed=CAR_SPEED;
    armSpeedFloor(CAR_SPEED);   // make 120 un-clampable while driving
    forceSpeedNow(CAR_SPEED);   // immediate effect this frame too
    IZZA.emit?.('toast',{text:`Car hijacked! (${kind}) Press B again to park.`});

    // init movement tracker at start so the first frame isn't counted as a huge jump
    prevPX = api.player.x; prevPY = api.player.y; carMoving = false;

    // Delegate escalation to chasing plugin
    lastCarCrimeAt = now();
    hijackTag = hijackTag || ('hot_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2));
    IZZA.emit('crime', {kind:'hijack'});

    // IMPORTANT: allow spawns immediately during hijack transition
    armGuard('enter-traffic');
  }

  function startDrivingFromParked(entry){
    clearTimeout(entry.car.timeoutId);
    parked.splice(entry.idx,1);

    snapshotPursuers();

    car={x:api.player.x,y:api.player.y, kind: entry.car.kind || 'sedan'};
    driving=true;
    if(savedWalk==null) savedWalk=api.player.speed;
    api.player.speed=CAR_SPEED;
    armSpeedFloor(CAR_SPEED);   // make 120 un-clampable while driving
    forceSpeedNow(CAR_SPEED);   // immediate effect this frame too
    IZZA.emit?.('toast',{text:'Back in your car. Press B to park.'});

    // init movement tracker on re-entry
    prevPX = api.player.x; prevPY = api.player.y; carMoving = false;

    // If the parked car was the same hijacked car AND heat still existed when it was parked, carry tag.
    hijackTag = entry.car.hijackTag || hijackTag || null;

    armGuard('enter-parked'); // safe: no wanted floor on re-entry
  }

  function parkHereAndStartTimer(){
    const px = api.player.x, py = api.player.y;
    const kind = (car && car.kind) || 'sedan';
    const p = { x:px, y:py, kind, timeoutId:null };

    // only keep “hot” tag if you STILL have heat right now
    if ((api.player.wanted|0) > 0 || pursuerCount() > 0) {
      if(hijackTag) p.hijackTag = hijackTag;
    }

    p.timeoutId = setTimeout(()=>{
      const i = parked.indexOf(p);
      if(i>=0) parked.splice(i,1);
      (api.cars||[]).push({ x:px, y:py, dir:(Math.random()<0.5?-1:1), spd:120, kind });
    }, PARK_MS);
    parked.push(p);
  }

  function stopDrivingAndPark(){
  if(!driving) return;

  snapshotPursuers();

  parkHereAndStartTimer();
  driving=false; 
  car=null;

  // remove the speed-floor so walking isn’t stuck fast
  disarmSpeedFloor();

  if(savedWalk!=null){
    api.player.speed = savedWalk;
    savedWalk = null;
  }

  IZZA.emit?.('toast',{text:'Parked. It’ll stay ~5 min.'});
  carMoving = false;
  armGuard('park');
}

  function onB(e){
    if(!api?.ready || !m3Done()) return;
    if(uiReallyBusy()) return;

    if(driving){ stopDrivingAndPark(); return; }

    const p = nearestParkedCar();
    if(p){ startDrivingFromParked(p); return; }

    const c=nearestTrafficCar();
    if(c){ startDrivingFromTraffic(c); }
  }

  function handleVehicularHits(){
    if(!driving) return;

    const px = api.player.x, py = api.player.y;

    // Pedestrian hit → delegate escalation to chasing plugin
    for(let i=api.pedestrians.length-1; i>=0; i--){
      const p = api.pedestrians[i];
      const d = Math.hypot(px - p.x, py - p.y);
      if(d <= CAR_HIT_RADIUS){
        const tNow = now();
        api.pedestrians.splice(i,1);
        const pos = _dropPos(p.x + api.TILE/2, p.y + api.TILE/2);
        IZZA.emit('ped-killed', {
          coins: 25,
          x: pos.x, y: pos.y,
          droppedAt: tNow,
          noPickupUntil: tNow + DROP_GRACE_MS
        });
        IZZA.emit('crime', {kind:'vehicular-ped'});
      }
    }

    // Running over a cop: ONLY kill if the car is moving fast enough this frame.
    for(let i=api.cops.length-1; i>=0; i--){
      const c = api.cops[i];
      const d = Math.hypot(px - c.x, py - c.y);
      if(d <= CAR_HIT_RADIUS){
        if (carMoving){
          api.cops.splice(i,1);
          const pos = _dropPos(c.x + api.TILE/2, c.y + api.TILE/2);
          IZZA.emit('cop-killed', {
            cop: c,
            x: pos.x, y: pos.y,
            droppedAt: now(),
            noPickupUntil: now() + DROP_GRACE_MS
          });
        }
        // If not moving, do nothing; the cop can attack via other systems.
      }
    }
  }

  // ---------- Tanks (composite from military sprites) ----------
  function spawnTank(){
    if (now() < suppressAllSpawnsUntil) return;
    const px = api.player.x, py = api.player.y;
    const off = 340;
    const sx = px + (Math.random()<0.5?-off:off);
    const sy = py + (Math.random()<0.5?-off:off);
    tanks.push({ x:sx, y:sy, hp:TANK_HP, parts:TANK_PARTS.slice(), fireCd:0 });
    // optional escort to help sell the formation
    api.army = api.army || [];
    for(let i=0;i<2;i++){
      api.army.push({ x:sx+(Math.random()*50-25), y:sy+(Math.random()*50-25), spd:80, hp:5, state:'escort' });
    }
    IZZA.emit?.('toast',{text:'⚠️ Tank deployed!'});
  }
  function destroyAllTanks(){
    tanks.length = 0;
    rockets.length = 0;
  }
  function updateTanks(dt){
    if(!tanks.length) return;
    const px = api.player.x, py = api.player.y;
    for(let t of tanks){
      // Move toward player (slower than car)
      const dx = px - t.x, dy = py - t.y;
      const m = Math.hypot(dx,dy)||1;
      t.x += (dx/m) * (TANK_SPEED * dt);
      t.y += (dy/m) * (TANK_SPEED * dt);

      // Fire rockets
      t.fireCd -= dt*1000;
      if (t.fireCd <= 0){
        t.fireCd = ROCKET_COOLDOWN_MS;
        const rdx = px - t.x, rdy = py - t.y;
        const rm = Math.hypot(rdx,rdy)||1;
        rockets.push({
          x: t.x, y: t.y,
          vx: (rdx/rm) * ROCKET_SPEED,
          vy: (rdy/rm) * ROCKET_SPEED
        });
        IZZA.emit?.('tank-rocket-fired', {x:t.x,y:t.y});
      }
    }
  }
  function updateRockets(dt){
    if(!rockets.length) return;
    const px = api.player.x, py = api.player.y;
    for(let i=rockets.length-1;i>=0;i--){
      const r = rockets[i];
      r.x += r.vx*dt; r.y += r.vy*dt;
      // Hit player?
      const d = Math.hypot(px - r.x, py - r.y);
      if (d <= ROCKET_RADIUS + 12){ // fudge radius
        // FULL HEART = 3 segments in hearts system
        IZZA.emit?.('player-hit', {by:'rocket', dmg:3});
        rockets.splice(i,1);
        continue;
      }
      // Lifetime/Offscreen trim
      if (Math.abs(r.x-px)>1100 || Math.abs(r.y-py)>900) rockets.splice(i,1);
    }
  }

  // Draw one vehicle using the same ctx/S as the engine frame
  function drawVehicleSprite(ctx, S, kind, wx, wy){
    const sheets = (window.VEHICLE_SHEETS||{});
    const sx=(wx - api.camera.x)*(S/api.TILE);
    const sy=(wy - api.camera.y)*(S/api.TILE);

    const dS = S*VEH_DRAW_SCALE;
    const off = (dS - S)/2;

    if(sheets[kind] && sheets[kind].img){
      ctx.save();
      ctx.imageSmoothingEnabled=false;
      ctx.drawImage(sheets[kind].img, 0,0,32,32, sx-off, sy-off, dS, dS);
      ctx.restore();
    }else{
      // fallback box if sprite not loaded yet
      ctx.fillStyle='#c0c8d8';
      ctx.fillRect(sx + S*0.10 - off, sy + S*0.25 - off, S*0.80*VEH_DRAW_SCALE, S*0.50*VEH_DRAW_SCALE);
    }
  }

  function drawTanks(ctx, S){
    if(!tanks.length) return;
    for(const t of tanks){
      const sx=(t.x - api.camera.x)*(S/api.TILE);
      const sy=(t.y - api.camera.y)*(S/api.TILE);
      ctx.save();
      ctx.imageSmoothingEnabled=false;

      // Digital camo (greens)
      const camo = ['#2f4f2f','#3a5f3a','#507a50','#2b402b','#476b47'];
      // Body plates (big)
      t.parts.forEach((p,idx)=>{
        ctx.fillStyle = camo[idx % camo.length];
        ctx.fillRect(sx + p.dx, sy + p.dy, p.w, p.h);
      });
      // Turret block (bigger)
      ctx.fillStyle='#2b402b';
      ctx.fillRect(sx-18, sy-14, 36, 28);

      // Barrel pointing to player (longer)
      const dx = (api.player.x - t.x);
      const dy = (api.player.y - t.y);
      const a = Math.atan2(dy,dx);
      ctx.translate(sx,sy);
      ctx.rotate(a);
      ctx.fillStyle='#1f301f';
      ctx.fillRect(14,-4,40,8);
      ctx.restore();
    }

    // Rockets
    rockets.forEach(r=>{
      const rx=(r.x - api.camera.x)*(S/api.TILE);
      const ry=(r.y - api.camera.y)*(S/api.TILE);
      ctx.fillStyle='#ffcc66';
      ctx.beginPath(); ctx.arc(rx,ry,4,0,Math.PI*2); ctx.fill();
    });
  }

  // Intercept “fresh spawns” requests while we’re suppressing (e.g., after death)
  IZZA.on?.('pursuit-spawn-request', (e)=>{
    if (now() <= spawnLockUntil || now() <= suppressAllSpawnsUntil){
      if (e) e.cancel = true;
      restorePursuers();
    }
  });

  // --- ensure cops cleared & wanted reset on death/respawn (hard) ---
function clearAllPursuitAndWanted(){
  try{
    // ensure speed-floor is gone on death/respawn
    disarmSpeedFloor();

    // Clear in-place
    PURSUER_KEYS.forEach(k=>{
      if (!api[k]) api[k] = [];
      api[k].length = 0;
    });
    destroyAllTanks();
    if(api?.player){ api.setWanted(0); }

    hijackTag = null;
    fiveStarSince = 0;
    nextTankAt = 0;
    lastReinforceAt = 0;

    // Ensure no residual heat/snapshots can revive stars or units on respawn
    lastCarCrimeAt = 0;
    pursuerSnap   = null;

    // Force the player OUT of the vehicle on death/respawn
    driving = false;
    car = null;
    if (api?.player && savedWalk != null) { api.player.speed = savedWalk; }
    savedWalk = null;

    carMoving = false;

    // Drop all guards and block any spawn attempts for a short window
    guardUntil = 0; guardWanted = 0;
    spawnLockUntil = now() + 1200;
    suppressAllSpawnsUntil = now() + 1500;

    // Belt & suspenders: repeat clears next tick as well (still in place)
    setTimeout(()=>{
      try{
        PURSUER_KEYS.forEach(k=>{
          if (!api[k]) api[k] = [];
          api[k].length = 0;
        });
        destroyAllTanks();
        if(api?.player){ api.setWanted(0); }
      }catch{}
    }, 0);
  }catch{}
}
  IZZA.on?.('player-died', clearAllPursuitAndWanted);
  IZZA.on?.('player-death', clearAllPursuitAndWanted);
  IZZA.on?.('player-respawn', clearAllPursuitAndWanted);
  IZZA.on?.('respawn', clearAllPursuitAndWanted);

  IZZA.on('ready', (a)=>{
    api=a;
    ensureVehicleSheets();
    window.addEventListener('keydown', e=>{
      if((e.key||'').toLowerCase()==='b') onB(e);
    }, {capture:true, passive:true});
    const btnB=document.getElementById('btnB');
    btnB && btnB.addEventListener('click', onB, true);
  });

  // Use ctx/S provided by the engine so we paint on the correct layer
  IZZA.on('update-post', ()=>{
    if(!api?.ready) return;
      // While driving, enforce a minimum vehicle speed so other systems can't
  // clamp us down to walking speed. Higher boosts (e.g., special legs) still win.
  if (driving && api?.player){
    const p = api.player;
    if (typeof p.speed     === 'number' && p.speed     < CAR_SPEED) p.speed     = CAR_SPEED;
    if (typeof p.moveSpeed === 'number' && p.moveSpeed < CAR_SPEED) p.moveSpeed = CAR_SPEED;
    if (typeof p.maxSpeed  === 'number' && p.maxSpeed  < CAR_SPEED) p.maxSpeed  = CAR_SPEED;
    if (typeof p.maxVel    === 'number' && p.maxVel    < CAR_SPEED) p.maxVel    = CAR_SPEED;
  }

    // 5★ logic: first tank after 30s, then more every 30s while still 5★
    if ((api.player?.wanted|0) >= TANK_BUILD_STARS){
      const tNow = now();
      if (fiveStarSince && (tNow - fiveStarSince) >= TANK_BUILD_HOLD_MS){
        if (!nextTankAt){
          spawnTank();
          nextTankAt = tNow + TANK_RESPAWN_EVERY_MS;
        }else if (tNow >= nextTankAt){
          spawnTank();
          nextTankAt = tNow + TANK_RESPAWN_EVERY_MS;
        }
      }
    }

    // Update tanks + rockets
    const dt = Math.min(0.05, (api.dt||0.016)); // dt seconds (clamped)
    updateTanks(dt);
    updateRockets(dt);

    if(driving && car){
      // compute movement BEFORE we sync car to player
      const curx = api.player.x, cury = api.player.y;
      const dist = Math.hypot(curx - prevPX, cury - prevPY);
      const speed = dt > 0 ? (dist / dt) : 0; // px/sec
      carMoving = speed >= CAR_HIT_SPEED_MIN;
      prevPX = curx; prevPY = cury;

      // sync car to player and resolve hits
      car.x=curx; car.y=cury;
      handleVehicularHits();
    }else{
      carMoving = false;
      prevPX = api?.player?.x||0;
      prevPY = api?.player?.y||0;
    }

    // (Removed) global free-drive reinforcements; chasing plugin handles escalation.
    lastReinforceAt = 0;

    // End hot-car session when pursuers are gone; no star writes here.
    syncWantedWithPursuit();
  });

  IZZA.on('render-post', (payload)=>{
    if(!api?.ready) return;
    const ctx = (payload && payload.ctx) || document.getElementById('game').getContext('2d');
    const S   = (payload && payload.S)   || api.DRAW;

    // Parked cars
    for(const p of parked){
      drawVehicleSprite(ctx, S, p.kind || 'sedan', p.x, p.y);
    }
    // Current car
    if(driving && car){
      drawVehicleSprite(ctx, S, car.kind || 'sedan', car.x, car.y);
    }

    // Draw tanks & rockets last to sit on top
    drawTanks(ctx, S);
  });
})();
