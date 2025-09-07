<!-- /static/game/js/plugins/v1_free_drive_plugin.js -->
(function(){
  const BUILD='v1.11.1-free-drive+pursuit-guard-PERSIST-hijackOnlyCrime';
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

  const parked = []; // {x,y,kind,timeoutId}

  // --- pursuit persistence ---
  const PURSUER_KEYS = ['cops','swat','military','army','helicopters','tanks'];
  let lastCarCrimeAt = 0; // NOTE: updated ONLY on hijack now
  const now = ()=>performance.now();

  // Snapshots of exact pursuers before transitions
  let pursuerSnap = null;
  // Guard window to block/undo wanted=0 wipes right after transitions
  let guardUntil = 0;
  let guardWanted = 0;
  let spawnLockUntil = 0; // prevents other systems from respawning “fresh” squads immediately (not used on hijack)

  function isArray(a){ return Array.isArray(a); }

  function snapshotPursuers(){
    try{
      pursuerSnap = {};
      PURSUER_KEYS.forEach(k=>{
        const src = api[k];
        if (isArray(src) && src.length){
          // shallow clone each pursuer; keep position & important fields
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

    // Keep exactly current wanted unless a car crime just happened (or very recently).
    guardWanted = (api.player?.wanted|0) || 0;
    if (isCarCrime || (now() - lastCarCrimeAt < 30000)) {
      guardWanted = Math.max(guardWanted, 1);
    }

    // short guard to defeat “clear wanted” listeners racing this transition
    guardUntil = now() + 900; // ~0.9s

    // Allow spawners to react immediately on HIJACK (we want new cops if you hijack after clearing them).
    // For non-crime transitions, keep the brief spawn lock.
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

  // If anyone tries to zero wanted during the guard window, undo it and restore the SAME pursuers.
  IZZA.on?.('wanted-changed', ()=>{
    if (!api) return;
    if (now() <= guardUntil){
      if ((api.player.wanted|0) < guardWanted){
        api.setWanted(guardWanted);
      }
      restorePursuers();
      // re-assert next tick as well (late listeners)
      setTimeout(()=>{
        if ((api.player.wanted|0) < guardWanted) api.setWanted(guardWanted);
        restorePursuers();
      }, 0);
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
    if((api.player.wanted|0)===0){ api.setWanted(1); }
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

    // NOT a crime; keep wanted as-is and allow normal spawner behavior.
    armGuard('enter-parked');
  }

  function parkHereAndStartTimer(){
    const px = api.player.x, py = api.player.y;
    const kind = (car && car.kind) || 'sedan';
    const p = { x:px, y:py, kind, timeoutId:null };
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
        // Still raise wanted for running over pedestrians,
        // BUT do NOT mark it as a "car crime" (no lastCarCrimeAt update).
        api.setWanted(Math.min(5, (api.player.wanted|0) + 1));
      }
    }

    // IMPORTANT: only remove a pursuer when we actually hit them.
    // Re-entering a car will NOT clear these arrays anymore.
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
        // Keep existing behavior here: lower wanted by 1 when a cop is eliminated by vehicle.
        api.setWanted(Math.max(0, (api.player.wanted|0) - 1));
      }
    }
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
    if(driving && car){
      car.x=api.player.x; car.y=api.player.y;
      handleVehicularHits();
    }
  });
  IZZA.on('render-post', ()=>{
    if(!api?.ready) return;
    parked.forEach(p=>{ drawVehicleSprite(p.kind || 'sedan', p.x, p.y); });
    if(driving && car){ drawVehicleSprite(car.kind || 'sedan', car.x, car.y); }
  });
})();
