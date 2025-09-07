<!-- /static/game/js/plugins/v1_free_drive_plugin.js -->
(function(){
  const BUILD='v1.12-free-drive+pursuit-guard-PERSIST-hijackOnlyCrime+hotCar+escalation+tankBoss';
  console.log('[IZZA PLAY]', BUILD);

  const M3_KEY='izzaMission3';
  const HIJACK_RADIUS = 22;
  const CAR_SPEED     = 120;
  const PARK_MS       = 5*60*1000;

  const CAR_HIT_RADIUS= 24;
  const DROP_GRACE_MS = 1000;
  const DROP_OFFSET   = 18;

  const VEH_DRAW_SCALE = 1.15;

  let api=null;
  let driving=false, car=null, savedWalk=null;

  const parked = []; // {x,y,kind,timeoutId,hijackTag?}

  // --- pursuit persistence / escalation ---
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
  let spawnLockUntil = 0; // prevents other systems from respawning “fresh” squads (not used on hijack)

  // --- escalation helpers ---
  const MAX_WANTED = 5;
  let fiveStarSince = 0;

  // Tank boss (composite of existing sprites)
  let tankBoss = null;   // {x,y,hp,parts:[{dx,dy}],fireCd}
  const TANK_BUILD_STARS = 5;
  const TANK_BUILD_HOLD_MS = 30000;
  const TANK_SPEED = 70;
  const TANK_HP = 40;
  const TANK_PARTS = [
    {dx:-16, dy:-8}, {dx:0, dy:-8}, {dx:16, dy:-8},
    {dx:-16, dy:8},  {dx:0, dy:8},  {dx:16, dy:8}
  ];
  const ROCKET_SPEED = 240;
  const ROCKET_COOLDOWN_MS = 1400;
  const ROCKET_RADIUS = 10;
  let rockets = []; // {x,y,vx,vy}

  function isArray(a){ return Array.isArray(a); }

  function pursuerCount(){
    try{
      let n=0;
      PURSUER_KEYS.forEach(k=>{ n += (api[k]&&api[k].length)|0; });
      if (tankBoss) n += 1;
      return n|0;
    }catch{ return tankBoss?1:0; }
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
          api[k] = [];
          pursuerSnap[k].forEach(u=> api[k].push(Object.assign({}, u)));
        }
      });
    }catch{}
  }

  function armGuard(reason){
    // Only hijack (“enter-traffic”) is a car crime.
    const isCarCrime = (reason==='enter-traffic');

    // Keep current wanted; ensure >=1 only when a car crime is active/recent.
    guardWanted = (api.player?.wanted|0) || 0;
    if (isCarCrime || (now() - lastCarCrimeAt < 30000)) {
      guardWanted = Math.max(guardWanted, 1);
    }

    // short guard to defeat “clear wanted” listeners racing this transition
    guardUntil = now() + 900; // ~0.9s

    // Allow spawners immediately on HIJACK (so fresh cops can appear after you cleared them).
    // For non-crime transitions, keep brief spawn lock.
    spawnLockUntil = isCarCrime ? 0 : (guardUntil + 400);

    // immediately enforce once
    if ((api.player.wanted|0) < guardWanted) api.setWanted(guardWanted);
    restorePursuers();

    // belt & suspenders — one more tick
    setTimeout(()=>{
      if ((api.player.wanted|0) < guardWanted) api.setWanted(guardWanted);
      restorePursuers();
    }, 0);
  }

  // Request more pursuers for current wanted (use game spawner if present; otherwise fallback)
  function requestSpawnsForWanted(reason){
    const lvl = (api.player?.wanted|0) || 0;
    if (lvl<=0) return;

    if (typeof api.spawnPursuers === 'function'){
      try{ api.spawnPursuers(lvl, reason); return; }catch{}
    }
    // Fallback minimal spawner: add units near screen edges
    const base = {spd:90, hp:3, state:'chase', facing:'down'};
    const px = api.player.x, py = api.player.y;
    const randOff = ()=> (Math.random()<0.5?-1:1) * (180 + Math.random()*120);
    const spawnAt = (arr, count)=>{
      for(let i=0;i<count;i++){
        arr.push({ x:px+randOff(), y:py+randOff(), spd:base.spd, hp:base.hp, state:base.state, facing:base.facing });
      }
    };
    api.cops = api.cops || [];
    api.swat = api.swat || [];
    api.military = api.military || [];
    if (lvl===1){ spawnAt(api.cops, 2); }
    else if (lvl===2){ spawnAt(api.cops, 2); spawnAt(api.swat, 1); }
    else if (lvl===3){ spawnAt(api.cops, 2); spawnAt(api.swat, 2); }
    else if (lvl===4){ spawnAt(api.cops, 2); spawnAt(api.swat, 2); spawnAt(api.military, 1); }
    else /*5*/ { spawnAt(api.cops, 2); spawnAt(api.swat, 2); spawnAt(api.military, 2); }
  }

  // Escalate: add a star (max 5) and spawn more pursuers (never replacing current ones)
  function escalatePursuit(reason){
    const cur = (api.player?.wanted|0) || 0;
    const next = Math.min(MAX_WANTED, cur + 1);
    if (next !== cur){
      api.setWanted(next);
      // If you just hit 5, start the 5-star timer
      if (next>=TANK_BUILD_STARS && fiveStarSince===0) fiveStarSince = now();
    }
    requestSpawnsForWanted(reason);
  }

  // Wanted stars ↔ pursuers: ensure at least 1 star while chased; 0 when chase is over & no hot car.
  function syncWantedWithPursuit(){
    if(!api?.player) return;
    const n = pursuerCount();
    if(n>0){
      if((api.player.wanted|0) < 1) api.setWanted(1);
    }else{
      // If no pursuers remain, end the hot-car session and clear stars, reset 5-star timer and tank.
      if(hijackTag) hijackTag = null;
      if((api.player.wanted|0) !== 0) api.setWanted(0);
      fiveStarSince = 0;
      destroyTankBoss();
    }
  }

  // If anyone tries to zero wanted during the guard window, undo it and restore the SAME pursuers.
  IZZA.on?.('wanted-changed', ()=>{
    if (!api) return;
    if (now() <= guardUntil){
      if ((api.player.wanted|0) < guardWanted){
        api.setWanted(guardWanted);
      }
      restorePursuers();
      setTimeout(()=>{
        if ((api.player.wanted|0) < guardWanted) api.setWanted(guardWanted);
        restorePursuers();
      }, 0);
    }
    // Track 5-star timer
    if ((api.player?.wanted|0) >= TANK_BUILD_STARS){
      if (!fiveStarSince) fiveStarSince = now();
    }else{
      fiveStarSince = 0;
      destroyTankBoss();
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

    // snapshot + guard BEFORE state flips (some listeners clear wanted on vehicle enter)
    snapshotPursuers();

    const kind = fromCar.kind || pickRandomKind();
    car={x:api.player.x,y:api.player.y, kind};
    driving=true;
    if(savedWalk==null) savedWalk=api.player.speed;
    api.player.speed=CAR_SPEED;
    IZZA.emit?.('toast',{text:`Car hijacked! (${kind}) Press B again to park.`});

    // HIJACK is the ONLY car crime:
    lastCarCrimeAt = now();

    // Mark / continue hot session
    hijackTag = hijackTag || ('hot_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2));

    // Always escalate by +1 star on hijack (caps at 5)
    escalatePursuit('hijack');
    armGuard('enter-traffic'); // no spawn lock here; let new cops spawn
  }

  function startDrivingFromParked(entry){
    clearTimeout(entry.car.timeoutId);
    parked.splice(entry.idx,1);

    // snapshot + guard BEFORE state flips
    snapshotPursuers();

    car={x:api.player.x,y:api.player.y, kind: entry.car.kind || 'sedan'};
    driving=true;
    if(savedWalk==null) savedWalk=api.player.speed;
    api.player.speed=CAR_SPEED;
    IZZA.emit?.('toast',{text:'Back in your car. Press B to park.'});

    // If the parked car was the same hijacked car, carry the tag forward.
    hijackTag = entry.car.hijackTag || hijackTag || null;

    // NOT a crime; keep wanted as-is and allow normal spawner behavior.
    armGuard('enter-parked');
  }

  function parkHereAndStartTimer(){
    const px = api.player.x, py = api.player.y;
    const kind = (car && car.kind) || 'sedan';
    const p = { x:px, y:py, kind, timeoutId:null };
    // Preserve “hot car” status while pursuers still exist
    if(hijackTag) p.hijackTag = hijackTag;
    p.timeoutId = setTimeout(()=>{
      const i = parked.indexOf(p);
      if(i>=0) parked.splice(i,1);
      (api.cars||[]).push({ x:px, y:py, dir:(Math.random()<0.5?-1:1), spd:120, kind });
    }, PARK_MS);
    parked.push(p);
  }

  function stopDrivingAndPark(){
    if(!driving) return;

    // snapshot BEFORE anything tries to wipe
    snapshotPursuers();

    parkHereAndStartTimer();
    driving=false; car=null;
    if(savedWalk!=null){ api.player.speed=savedWalk; savedWalk=null; }
    IZZA.emit?.('toast',{text:'Parked. It’ll stay ~5 min.'});

    // NOT a crime; keep wanted as-is.
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
    const tNow = now();

    for(let i=api.pedestrians.length-1; i>=0; i--){
      const p = api.pedestrians[i];
      const d = Math.hypot(px - p.x, py - p.y);
      if(d <= CAR_HIT_RADIUS){
        api.pedestrians.splice(i,1);
        const pos = _dropPos(p.x + api.TILE/2, p.y + api.TILE/2);
        IZZA.emit('ped-killed', {
          coins: 25,
          x: pos.x, y: pos.y,
          droppedAt: tNow,
          noPickupUntil: tNow + DROP_GRACE_MS
        });
        // Running over pedestrians ALWAYS raises wanted and escalates pursuit.
        api.setWanted(Math.min(MAX_WANTED, (api.player.wanted|0) + 1));
        escalatePursuit('ped-hit');
      }
    }

    // Only remove a pursuer when we actually hit them.
    for(let i=api.cops.length-1; i>=0; i--){
      const c = api.cops[i];
      const d = Math.hypot(px - c.x, py - c.y);
      if(d <= CAR_HIT_RADIUS){
        api.cops.splice(i,1);
        const pos = _dropPos(c.x + api.TILE/2, c.y + api.TILE/2);
        IZZA.emit('cop-killed', {
          cop: c,
          x: pos.x, y: pos.y,
          droppedAt: tNow,
          noPickupUntil: tNow + DROP_GRACE_MS
        });
        // Lower wanted by 1 when a cop is eliminated by vehicle.
        api.setWanted(Math.max(0, (api.player.wanted|0) - 1));
      }
    }
  }

  // ---------- Tank boss (composite from military sprites) ----------
  function spawnTankBoss(){
    if (tankBoss) return;
    // Place just off-screen from player
    const px = api.player.x, py = api.player.y;
    const off = 280;
    const sx = px + (Math.random()<0.5?-off:off);
    const sy = py + (Math.random()<0.5?-off:off);
    tankBoss = { x:sx, y:sy, hp:TANK_HP, parts:TANK_PARTS.slice(), fireCd:0 };
    // Make sure at least one military unit exists to visually “sell” the fusion
    api.military = api.military || [];
    for(let i=0;i<3;i++){
      api.military.push({ x:sx+(Math.random()*40-20), y:sy+(Math.random()*40-20), spd:80, hp:5, state:'escort' });
    }
    IZZA.emit?.('toast',{text:'⚠️ Military tank deployed!'});
  }
  function destroyTankBoss(){
    tankBoss = null;
    rockets.length = 0;
  }
  function updateTankBoss(dt){
    if(!tankBoss) return;
    const px = api.player.x, py = api.player.y;
    // Move toward player
    const dx = px - tankBoss.x, dy = py - tankBoss.y;
    const m = Math.hypot(dx,dy)||1;
    const vx = (dx/m) * (TANK_SPEED * dt), vy = (dy/m) * (TANK_SPEED * dt);
    tankBoss.x += vx; tankBoss.y += vy;

    // Fire rockets
    tankBoss.fireCd -= dt*1000;
    if (tankBoss.fireCd <= 0){
      tankBoss.fireCd = ROCKET_COOLDOWN_MS;
      const rdx = px - tankBoss.x, rdy = py - tankBoss.y;
      const rm = Math.hypot(rdx,rdy)||1;
      rockets.push({
        x: tankBoss.x, y: tankBoss.y,
        vx: (rdx/rm) * ROCKET_SPEED,
        vy: (rdy/rm) * ROCKET_SPEED
      });
      IZZA.emit?.('tank-rocket-fired', {x:tankBoss.x,y:tankBoss.y});
    }

    // If tank somehow far with no stars, despawn safely handled elsewhere.
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
        IZZA.emit?.('player-hit', {by:'rocket', dmg:4});
        rockets.splice(i,1);
        continue;
      }
      // Lifetime/Offscreen trim
      if (Math.abs(r.x-px)>900 || Math.abs(r.y-py)>700) rockets.splice(i,1);
    }
  }
  function drawTankBoss(ctx, S){
    if(!tankBoss) return;
    // Draw by reusing military units as “segments”—simple rectangles if no sprite painter available.
    const sx=(tankBoss.x - api.camera.x)*(S/api.TILE);
    const sy=(tankBoss.y - api.camera.y)*(S/api.TILE);
    ctx.save();
    ctx.imageSmoothingEnabled=false;
    // Body plates (using existing style colors)
    ctx.fillStyle='#394b63';
    tankBoss.parts.forEach(p=>{
      ctx.fillRect(sx + p.dx, sy + p.dy, 18, 12);
    });
    // Turret
    ctx.fillStyle='#233044';
    ctx.fillRect(sx-8, sy-6, 16, 12);
    // Barrel pointing to player
    const dx = (api.player.x - tankBoss.x);
    const dy = (api.player.y - tankBoss.y);
    const a = Math.atan2(dy,dx);
    ctx.translate(sx,sy);
    ctx.rotate(a);
    ctx.fillStyle='#1b2636';
    ctx.fillRect(6,-2,16,4);
    ctx.restore();

    // Rockets
    rockets.forEach(r=>{
      const rx=(r.x - api.camera.x)*(S/api.TILE);
      const ry=(r.y - api.camera.y)*(S/api.TILE);
      ctx.fillStyle='#ffcc66';
      ctx.beginPath(); ctx.arc(rx,ry,4,0,Math.PI*2); ctx.fill();
    });
  }

  function drawVehicleSprite(kind, wx, wy){
    const ctx=document.getElementById('game').getContext('2d');
    const sheets = (window.VEHICLE_SHEETS||{});
    const S=api.DRAW;
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
      ctx.fillStyle='#c0c8d8';
      ctx.fillRect(sx + S*0.10 - off, sy + S*0.25 - off, S*0.80*VEH_DRAW_SCALE, S*0.50*VEH_DRAW_SCALE);
    }
  }

  // (Optional) intercept “fresh spawns” trying to repopulate during guard
  IZZA.on?.('pursuit-spawn-request', (e)=>{
    if (now() <= spawnLockUntil){
      e && (e.cancel = true);
      restorePursuers();
    }
  });

  IZZA.on('ready', (a)=>{
    api=a;
    ensureVehicleSheets();
    window.addEventListener('keydown', e=>{
      if((e.key||'').toLowerCase()==='b') onB(e);
    }, {capture:true, passive:true});
    const btnB=document.getElementById('btnB');
    btnB && btnB.addEventListener('click', onB, true);
  });

  IZZA.on('update-post', ()=>{
    if(!api?.ready) return;

    // Escalate to tank if 5-star sustained
    if ((api.player?.wanted|0) >= TANK_BUILD_STARS){
      if (fiveStarSince && (now() - fiveStarSince) >= TANK_BUILD_HOLD_MS){
        spawnTankBoss();
      }
    }

    // Update tank + rockets
    const dt = Math.min(0.05, (api.dt||0.016)); // dt seconds (clamped)
    updateTankBoss(dt);
    updateRockets(dt);

    if(driving && car){
      car.x=api.player.x; car.y=api.player.y;
      handleVehicularHits();
    }
    // Keep stars in sync and end the hot-car session once pursuers are gone.
    syncWantedWithPursuit();
  });

  IZZA.on('render-post', ()=>{
    if(!api?.ready) return;
    const ctx=document.getElementById('game').getContext('2d');
    const S=api.DRAW;

    parked.forEach(p=>{ drawVehicleSprite(p.kind || 'sedan', p.x, p.y); });
    if(driving && car){ drawVehicleSprite(car.kind || 'sedan', car.x, car.y); }

    // Draw the tank boss & rockets last to sit on top
    drawTankBoss(ctx, S);
  });
})();
