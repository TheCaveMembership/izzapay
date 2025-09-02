// v1_free_drive_plugin.js — free car hijack + parking with 5-min despawn
(function(){
  const BUILD='v1.2-free-drive+parking+vehicular-hits';
  console.log('[IZZA PLAY]', BUILD);

  const M3_KEY='izzaMission3';           // 'done' when mission 3 finished
  const HIJACK_RADIUS = 22;              // match your mission plugin
  const CAR_SPEED     = 120;
  const PARK_MS       = 5*60*1000;       // 5 minutes

  // vehicular-hit knobs (match Mission 3)
  const CAR_HIT_RADIUS= 24;
  const DROP_GRACE_MS = 1000;
  const DROP_OFFSET   = 18;

  let api=null;
  let driving=false, car=null, savedWalk=null;

  // simple parked-car registry
  const parked = []; // {x,y,timeoutId}

  function m3Done(){
    try{
      if(localStorage.getItem(M3_KEY)==='done') return true;
      const ms = (api.getMissionCount&&api.getMissionCount())||0;
      return ms>=3;
    }catch{ return false; }
  }
  function uiBusy(){
    const any = ['enterModal','shopModal','hospitalShop','invPanel','mapModal']
      .map(id=>document.getElementById(id))
      .some(el=> el && el.style.display && el.style.display!=='none');
    return any;
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
    // remove the traffic car
    const idx=(api.cars||[]).indexOf(fromCar);
    if(idx>=0) api.cars.splice(idx,1);

    // optional: eject driver as a pedestrian
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

    car={x:api.player.x,y:api.player.y};
    driving=true;
    if(savedWalk==null) savedWalk=api.player.speed;
    api.player.speed=CAR_SPEED;
    IZZA.emit?.('toast',{text:'Car hijacked! Press B again to park.'});
  }
  function startDrivingFromParked(entry){
    // cancel despawn and remove from registry
    clearTimeout(entry.car.timeoutId);
    parked.splice(entry.idx,1);

    car={x:api.player.x,y:api.player.y};
    driving=true;
    if(savedWalk==null) savedWalk=api.player.speed;
    api.player.speed=CAR_SPEED;
    IZZA.emit?.('toast',{text:'Back in your car. Press B to park.'});
  }

  function parkHereAndStartTimer(){
    const px = api.player.x, py = api.player.y;
    const p = { x:px, y:py, timeoutId:null };
    p.timeoutId = setTimeout(()=>{
      // despawn parked car after 5 min and return one to traffic
      const i = parked.indexOf(p);
      if(i>=0) parked.splice(i,1);
      (api.cars||[]).push({ x:px, y:py, dir:(Math.random()<0.5?-1:1), spd:120 });
    }, PARK_MS);
    parked.push(p);
  }

  function stopDrivingAndPark(){
    if(!driving) return;
    // leave a parked car where we stopped
    parkHereAndStartTimer();
    driving=false; car=null;
    if(savedWalk!=null){ api.player.speed=savedWalk; savedWalk=null; }
    IZZA.emit?.('toast',{text:'Parked. It’ll stay ~5 min.'});
  }

  function onB(){
    if(!api?.ready || !m3Done() || uiBusy()) return;

    if(driving){ stopDrivingAndPark(); return; }

    // try nearest parked car first; else traffic car
    const p = nearestParkedCar();
    if(p){ startDrivingFromParked(p); return; }

    const c=nearestTrafficCar();
    if(c){ startDrivingFromTraffic(c); }
  }

  // ---- vehicular hits during free-drive ----
  function handleVehicularHits(){
    if(!driving) return;

    const px = api.player.x, py = api.player.y;
    const now = performance.now();

    // pedestrians: eliminate + coin drop + wanted +1
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
        const w = Math.min(5, (api.player.wanted|0) + 1);
        api.setWanted(w);
      }
    }

    // cops: eliminate + loot + wanted -1
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
        const w = Math.max(0, (api.player.wanted|0) - 1);
        api.setWanted(w);
      }
    }
  }

  IZZA.on('ready', (a)=>{
    api=a;
    const btnB=document.getElementById('btnB');
    window.addEventListener('keydown', e=>{ if((e.key||'').toLowerCase()==='b') onB(); }, {passive:true});
    btnB && btnB.addEventListener('click', onB);
  });

  // keep overlay car aligned + simple draw + vehicular hits
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

    // draw parked cars
    ctx.save();
    ctx.fillStyle='#b8c2d6';
    parked.forEach(p=>{
      const sx=w2sX(p.x), sy=w2sY(p.y);
      ctx.fillRect(sx+S*0.10, sy+S*0.25, S*0.80, S*0.50);
    });
    ctx.restore();

    // draw current car
    if(driving && car){
      const sx=w2sX(car.x), sy=w2sY(car.y);
      ctx.fillStyle='#c0c8d8';
      ctx.fillRect(sx+S*0.10, sy+S*0.25, S*0.80, S*0.50);
    }
  });
})();
