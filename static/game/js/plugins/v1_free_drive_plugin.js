(function(){
  const BUILD='v1.18-free-drive+delegate-chasing+correct-sprite-layer+tanks-10s-after-5star+rocket-fullheart+cool-reenter';
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

  // Tanks
  let tanks = [];   // [{x,y,hp,parts:[{dx,dy,w,h}],fireCd}]
  const TANK_BUILD_STARS = 5;
  const TANK_BUILD_HOLD_MS = 10000;     // ⬅️ tank after holding 5★ for 10s
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

  const REINFORCE_EVERY_MS = 30000;
  let lastReinforceAt = 0;

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
        if (!api[k]) api[k] = [];
        api[k].length = 0;
        if (pursuerSnap[k]){
          pursuerSnap[k].forEach(u=> api[k].push(Object.assign({}, u)));
        }
      });
    }catch{}
  }

  function armGuard(reason){
    const isCarCrime = (reason==='enter-traffic');
    guardWanted = (api.player?.wanted|0) || 0;
    guardUntil = now() + 900;
    spawnLockUntil = isCarCrime ? 0 : (guardUntil + 400);
    restorePursuers();
    setTimeout(restorePursuers, 0);
  }

  // Sync session with pursuit presence (no star writes here)
  function syncWantedWithPursuit(){
    if(!api?.player) return;
    const n = pursuerCount();
    if(n===0){
      if(hijackTag) hijackTag = null;
      lastCarCrimeAt = 0;
      fiveStarSince = 0;
      nextTankAt = 0;
      destroyAllTanks();
    }
  }

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
    IZZA.emit?.('toast',{text:`Car hijacked! (${kind}) Press B again to park.`});

    lastCarCrimeAt = now();
    hijackTag = hijackTag || ('hot_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2));
    IZZA.emit('crime', {kind:'hijack'});

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
    IZZA.emit?.('toast',{text:'Back in your car. Press B to park.'});

    hijackTag = entry.car.hijackTag || hijackTag || null;

    armGuard('enter-parked');
  }

  function parkHereAndStartTimer(){
    const px = api.player.x, py = api.player.y;
    const kind = (car && car.kind) || 'sedan';
    const p = { x:px, y:py, kind, timeoutId:null };

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
    driving=false; car=null;
    if(savedWalk!=null){ api.player.speed=savedWalk; savedWalk=null; }
    IZZA.emit?.('toast',{text:'Parked. It’ll stay ~5 min.'});

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

    // Running over a cop
    for(let i=api.cops.length-1; i>=0; i--){
      const c = api.cops[i];
      const d = Math.hypot(px - c.x, py - c.y);
      if(d <= CAR_HIT_RADIUS){
        api.cops.splice(i,1);
        const pos = _dropPos(c.x + api.TILE/2, c.y + api.TILE/2);
        IZZA.emit('cop-killed', {
          cop: c,
          x: pos.x, y: pos.y,
          droppedAt: now(),
          noPickupUntil: now() + DROP_GRACE_MS
        });
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
    // optional escort
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
      const dx = px - t.x, dy = py - t.y;
      const m = Math.hypot(dx,dy)||1;
      t.x += (dx/m) * (TANK_SPEED * dt);
      t.y += (dy/m) * (TANK_SPEED * dt);

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
      const d = Math.hypot(px - r.x, py - r.y);
      if (d <= ROCKET_RADIUS + 12){
        IZZA.emit?.('player-hit', {by:'rocket', dmg:3});
        rockets.splice(i,1);
        continue;
      }
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
      const camo = ['#2f4f2f','#3a5f3a','#507a50','#2b402b','#476b47'];
      t.parts.forEach((p,idx)=>{
        ctx.fillStyle = camo[idx % camo.length];
        ctx.fillRect(sx + p.dx, sy + p.dy, p.w, p.h);
      });
      ctx.fillStyle='#2b402b';
      ctx.fillRect(sx-18, sy-14, 36, 28);
      const dx = (api.player.x - t.x);
      const dy = (api.player.y - t.y);
      const a = Math.atan2(dy,dx);
      ctx.translate(sx,sy);
      ctx.rotate(a);
      ctx.fillStyle='#1f301f';
      ctx.fillRect(14,-4,40,8);
      ctx.restore();
    }

    rockets.forEach(r=>{
      const rx=(r.x - api.camera.x)*(S/api.TILE);
      const ry=(r.y - api.camera.y)*(S/api.TILE);
      ctx.fillStyle='#ffcc66';
      ctx.beginPath(); ctx.arc(rx,ry,4,0,Math.PI*2); ctx.fill();
    });
  }

  IZZA.on?.('pursuit-spawn-request', (e)=>{
    if (now() <= spawnLockUntil || now() <= suppressAllSpawnsUntil){
      if (e) e.cancel = true;
      restorePursuers();
    }
  });

  function clearAllPursuitAndWanted(){
    try{
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

      lastCarCrimeAt = 0;
      pursuerSnap   = null;

      driving = false;
      car = null;
      if (api?.player && savedWalk != null) { api.player.speed = savedWalk; }
      savedWalk = null;

      guardUntil = 0; guardWanted = 0;
      spawnLockUntil = now() + 1200;
      suppressAllSpawnsUntil = now() + 1500;

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

  IZZA.on('update-post', ()=>{
    if(!api?.ready) return;

    // 5★ logic: first tank after 10s at 5★, then more every 30s
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
    const dt = Math.min(0.05, (api.dt||0.016));
    updateTanks(dt);
    updateRockets(dt);

    if(driving && car){
      car.x=api.player.x; car.y=api.player.y;
      handleVehicularHits();
    }

    lastReinforceAt = 0;
    syncWantedWithPursuit();
  });

  IZZA.on('render-post', (payload)=>{
    if(!api?.ready) return;
    const ctx = (payload && payload.ctx) || document.getElementById('game').getContext('2d');
    const S   = (payload && payload.S)   || api.DRAW;

    for(const p of parked){
      drawVehicleSprite(ctx, S, p.kind || 'sedan', p.x, p.y);
    }
    if(driving && car){
      drawVehicleSprite(ctx, S, car.kind || 'sedan', car.x, car.y);
    }

    drawTanks(ctx, S);
  });
})();
