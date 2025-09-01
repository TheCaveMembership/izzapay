// v1_free_drive_plugin.js — free car hijack any time AFTER Mission 3 is completed
(function(){
  const BUILD='v1-free-drive+post-m3';
  console.log('[IZZA PLAY]', BUILD);

  const M3_KEY='izzaMission3';           // 'done' when mission 3 finished
  const HIJACK_RADIUS = 22;              // match your mission plugin
  const CAR_SPEED     = 120;

  let api=null;
  let driving=false, car=null, savedWalk=null;

  function m3Done(){
    // robust gate: either explicit 'done' or mission count >=3
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
  function nearestCar(){
    let best=null, bestD=1e9;
    for(const c of api.cars||[]){
      const d=Math.hypot(api.player.x-c.x, api.player.y-c.y);
      if(d<bestD){ best=c; bestD=d; }
    }
    return (bestD<=HIJACK_RADIUS) ? best : null;
  }
  function startDriving(fromCar){
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
    IZZA.emit?.('toast',{text:'Car hijacked! Press B again to exit.'});
  }
  function stopDriving(spawnBack=true){
    if(!driving) return;
    if(spawnBack){
      // put a traffic car back roughly where the player stopped
      api.cars.push({ x: api.player.x, y: api.player.y, dir: (Math.random()<0.5?-1:1), spd: 120 });
    }
    driving=false; car=null;
    if(savedWalk!=null){ api.player.speed=savedWalk; savedWalk=null; }
  }
  function onB(){
    if(!api?.ready || !m3Done() || uiBusy()) return;

    if(driving){ stopDriving(true); return; }

    const c=nearestCar();
    if(c){ startDriving(c); }
  }

  IZZA.on('ready', (a)=>{
    api=a;
    const btnB=document.getElementById('btnB');
    window.addEventListener('keydown', e=>{ if((e.key||'').toLowerCase()==='b') onB(); }, {passive:true});
    btnB && btnB.addEventListener('click', onB);
  });

  // keep overlay car aligned + simple draw
  IZZA.on('update-post', ()=>{
    if(!api?.ready || !driving || !car) return;
    car.x=api.player.x; car.y=api.player.y;
  });
  IZZA.on('render-post', ()=>{
    if(!api?.ready || !driving || !car) return;
    const ctx=document.getElementById('game').getContext('2d');
    const S=api.DRAW, w2sX=wx=>(wx-api.camera.x)*(S/api.TILE), w2sY=wy=>(wy-api.camera.y)*(S/api.TILE);
    const sx=w2sX(car.x), sy=w2sY(car.y);
    ctx.fillStyle='#c0c8d8';
    ctx.fillRect(sx+S*0.10, sy+S*0.25, S*0.80, S*0.50);
  });
})();
