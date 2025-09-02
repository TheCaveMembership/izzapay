// v1_free_drive_plugin.js — free car hijack + parking with 5-min despawn
(function(){
  const BUILD='v1.4-free-drive+parking+vehicular-hits+vehicleSprites+capB';
  console.log('[IZZA PLAY]', BUILD);

  const M3_KEY='izzaMission3';
  const HIJACK_RADIUS = 22;
  const CAR_SPEED     = 120;
  const PARK_MS       = 5*60*1000;

  const CAR_HIT_RADIUS= 24;
  const DROP_GRACE_MS = 1000;
  const DROP_OFFSET   = 18;

  let api=null;
  let driving=false, car=null, savedWalk=null;  // car: {x,y,kind}

  // parked cars registry
  const parked = []; // {x,y,kind,timeoutId}

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

    car={x:api.player.x,y:api.player.y, kind: fromCar.kind || 'sedan'};
    driving=true;
    if(savedWalk==null) savedWalk=api.player.speed;
    api.player.speed=CAR_SPEED;
    IZZA.emit?.('toast',{text:'Car hijacked! Press B again to park.'});
  }
  function startDrivingFromParked(entry){
    clearTimeout(entry.car.timeoutId);
    parked.splice(entry.idx,1);

    car={x:api.player.x,y:api.player.y, kind: entry.car.kind || 'sedan'};
    driving=true;
    if(savedWalk==null) savedWalk=api.player.speed;
    api.player.speed=CAR_SPEED;
    IZZA.emit?.('toast',{text:'Back in your car. Press B to park.'});
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
      }
    }
  }

  IZZA.on('ready', (a)=>{
    api=a;
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
    const ctx=document.getElementById('game').getContext('2d');
    const S=api.DRAW, w2sX=wx=>(wx-api.camera.x)*(S/api.TILE), w2sY=wy=>(wy-api.camera.y)*(S/api.TILE);
    const sheets = (window.VEHICLE_SHEETS||{});

    // parked cars
    parked.forEach(p=>{
      const sx=w2sX(p.x), sy=w2sY(p.y);
      if(sheets[p.kind] && sheets[p.kind].img){
        ctx.imageSmoothingEnabled=false;
        ctx.drawImage(sheets[p.kind].img, 0,0,32,32, sx, sy, S, S);
      }else{
        ctx.fillStyle='#b8c2d6';
        ctx.fillRect(sx+S*0.10, sy+S*0.25, S*0.80, S*0.50);
      }
    });

    // current car
    if(driving && car){
      const sx=w2sX(car.x), sy=w2sY(car.y);
      if(sheets[car.kind] && sheets[car.kind].img){
        ctx.imageSmoothingEnabled=false;
        ctx.drawImage(sheets[car.kind].img, 0,0,32,32, sx, sy, S, S);
      }else{
        ctx.fillStyle='#c0c8d8';
        ctx.fillRect(sx+S*0.10, sy+S*0.25, S*0.80, S*0.50);
      }
    }
  });
})();
