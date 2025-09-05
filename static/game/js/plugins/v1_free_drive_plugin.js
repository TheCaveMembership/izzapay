// v1_free_drive_plugin.js — free car hijack + parking with 5-min despawn
(function(){
  const BUILD='v1.7-free-drive+parking+vehicular-hits+vehicleSprites+larger+cop-persist';
  console.log('[IZZA PLAY]', BUILD);

  const M3_KEY='izzaMission3';
  const HIJACK_RADIUS = 22;
  const CAR_SPEED     = 120;
  const PARK_MS       = 5*60*1000;

  const CAR_HIT_RADIUS= 24;
  const DROP_GRACE_MS = 1000;
  const DROP_OFFSET   = 18;

  // Slightly larger visual scale for vehicles
  const VEH_DRAW_SCALE = 1.15;

  let api=null;
  let driving=false, car=null, savedWalk=null;  // car: {x,y,kind}

  // parked cars registry
  const parked = []; // {x,y,kind,timeoutId}

  // ---- shared sprite loader ----
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

  // Allow B even with inventory/map; only block true modals
  function uiReallyBusy(){
    const ids = ['enterModal', 'shopModal', 'hospitalShop'];
    return ids
      .map(id=>document.getElementById(id))
      .some(el=> el && el.style.display && el.style.display!=='none');
  }

  function distance(ax,ay,bx,by){ return Math.hypot(ax-bx, ay-by); }
  function _dropPos(vx,vy){
    const dx = vx - api.player.x, dy = vy - api.player.y;
    const m  = Math.hypot(dx,dy) || 1;
    return { x: vx + (dx/m)*DROP_OFFSET, y: vy + (dy/m)*DROP_OFFSET };
  }

  // ---------- COPS: keep pressure after exiting vehicles ----------
  function spawnCop(kind){
    try{
      const cvs=document.getElementById('game'); if(!cvs) return;
      const S=api.DRAW, t=api.TILE, cam=api.camera;
      const viewW = cvs.width  / (S/t);
      const viewH = cvs.height / (S/t);
      const edges = [
        { x: cam.x - 3*t,                 y: cam.y + Math.random()*viewH },
        { x: cam.x + viewW + 3*t,         y: cam.y + Math.random()*viewH },
        { x: cam.x + Math.random()*viewW, y: cam.y - 3*t },
        { x: cam.x + Math.random()*viewW, y: cam.y + viewH + 3*t }
      ];
      const pos = edges[(Math.random()*edges.length)|0];
      const spd = kind==='army' ? 95 : kind==='swat' ? 90 : 80;
      const hp  = kind==='army' ? 6  : kind==='swat' ? 5  : 4;
      (api.cops||[]).push({ x: pos.x, y: pos.y, spd, hp, kind, reinforceAt: performance.now()+30000, facing:'down' });
    }catch{}
  }
  function ensureCops(){
    try{
      const want = api.player.wanted|0;
      let cur = (api.cops&&api.cops.length)|0;
      while(cur < want){
        let kind='police';
        if(want>=5) kind='army';
        else if(want>=4) kind='swat';
        spawnCop(kind); cur++;
      }
      while(cur > want){ api.cops.pop(); cur--; }
    }catch{}
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
      const d = distance(api.player.x,api.player.y,p.x,p.y);
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

    const kind = fromCar.kind || pickRandomKind();
    car={x:api.player.x,y:api.player.y, kind};
    driving=true;
    if(savedWalk==null) savedWalk=api.player.speed;
    api.player.speed=CAR_SPEED;
    IZZA.emit?.('toast',{text:`Car hijacked! (${kind}) Press B again to park.`});

    // keep any active pursuit active
    ensureCops();
  }
  function startDrivingFromParked(entry){
    clearTimeout(entry.car.timeoutId);
    parked.splice(entry.idx,1);

    car={x:api.player.x,y:api.player.y, kind: entry.car.kind || 'sedan'};
    driving=true;
    if(savedWalk==null) savedWalk=api.player.speed;
    api.player.speed=CAR_SPEED;
    IZZA.emit?.('toast',{text:'Back in your car. Press B to park.'});

    ensureCops();
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
    parkHereAndStartTimer();
    driving=false; car=null;
    if(savedWalk!=null){ api.player.speed=savedWalk; savedWalk=null; }
    IZZA.emit?.('toast',{text:'Parked. It’ll stay ~5 min.'});

    // CRUCIAL: if wanted > 0, keep the cops active after exiting
    ensureCops();
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
    const now = performance.now();

    for(let i=api.pedestrians.length-1; i>=0; i--){
      const p = api.pedestrians[i];
      const d = Math.hypot(px - p.x, py - p.y);
      if(d <= CAR_HIT_RADIUS){
        api.pedestrians.splice(i,1);
        const pos = _dropPos(p.x + api.TILE/2, p.y + api.TILE/2);
        IZZA.emit('ped-killed', {
          coins: 25,
          x: pos.x, y: pos.y,
          droppedAt: now,
          noPickupUntil: now + DROP_GRACE_MS
        });
        api.setWanted(Math.min(5, (api.player.wanted|0) + 1));
        ensureCops(); // keep cops engaged after the hit
      }
    }

    for(let i=api.cops.length-1; i>=0; i--){
      const c = api.cops[i];
      const d = Math.hypot(px - c.x, py - c.y);
      if(d <= CAR_HIT_RADIUS){
        api.cops.splice(i,1);
        const pos = _dropPos(c.x + api.TILE/2, c.y + api.TILE/2);
        IZZA.emit('cop-killed', {
          cop: c,
          x: pos.x, y: pos.y,
          droppedAt: now,
          noPickupUntil: now + DROP_GRACE_MS
        });
        api.setWanted(Math.max(0, (api.player.wanted|0) - 1));
        ensureCops(); // re-balance remaining cops to current wanted
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

  IZZA.on('ready', (a)=>{
    api=a;
    ensureVehicleSheets(); // load once and cache globally
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

    // parked cars
    parked.forEach(p=>{
      drawVehicleSprite(p.kind || 'sedan', p.x, p.y);
    });

    // current car
    if(driving && car){
      drawVehicleSprite(car.kind || 'sedan', car.x, car.y);
    }
  });
})();
