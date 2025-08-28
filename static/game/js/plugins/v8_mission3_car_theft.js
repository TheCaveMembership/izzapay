// /static/game/js/plugins/v8_mission3_car_theft.js
(function(){
  const BUILD = 'v8.4-mission3-car-theft+instant-goal';
  console.log('[IZZA PLAY]', BUILD);

  const M2_KEY='izzaMission2', M3_KEY='izzaMission3';
  const POS_KEY='izzaMission3Pos', POS_VER_KEY='izzaMission3PosVer', POS_VERSION='1';
  const MAP_TIER_KEY='izzaMapTier';

  const DEFAULT_OFFSET_TILES={dx:-8,dy:0};
  const HIJACK_RADIUS=22;
  const CAR_SPEED=120;
  const EXPAND_NUDGE_T=2;

  let api=null;
  const m3={
    state: localStorage.getItem(M3_KEY) || 'ready',
    gx:0, gy:0,
    driving:false,
    car:null,
    _savedWalkSpeed:null
  };

  function toast(msg,seconds=2.2){
    let h=document.getElementById('tutHint');
    if(!h){
      h=document.createElement('div'); h.id='tutHint';
      Object.assign(h.style,{position:'fixed',left:'12px',top:'64px',zIndex:12,
        background:'rgba(10,12,18,.88)',border:'1px solid #394769',color:'#cfe0ff',
        padding:'8px 10px',borderRadius:'10px',fontSize:'14px',maxWidth:'70vw'});
      document.body.appendChild(h);
    }
    h.textContent=msg; h.style.display='block';
    clearTimeout(h._t); h._t=setTimeout(()=>{h.style.display='none';},seconds*1000);
  }
  function playerGrid(){
    const t=api.TILE; return { gx:((api.player.x+t/2)/t|0), gy:((api.player.y+t/2)/t|0) };
  }

  function loadPos(){
    const ver=localStorage.getItem(POS_VER_KEY), saved=localStorage.getItem(POS_KEY);
    if(saved && ver===POS_VERSION){
      try{ const j=JSON.parse(saved);
        if(Number.isFinite(j.gx)&&Number.isFinite(j.gy)){ m3.gx=j.gx|0; m3.gy=j.gy|0; return; }
      }catch{}
    }
    const t=api.TILE, doorGX=((api.doorSpawn.x+8)/t|0), doorGY=(api.doorSpawn.y/t|0);
    m3.gx=doorGX+DEFAULT_OFFSET_TILES.dx; m3.gy=doorGY+DEFAULT_OFFSET_TILES.dy;
    localStorage.setItem(POS_KEY, JSON.stringify({gx:m3.gx,gy:m3.gy}));
    localStorage.setItem(POS_VER_KEY, POS_VERSION);
  }
  window._izza_m3_here=function(){
    const {gx,gy}=playerGrid(); m3.gx=gx; m3.gy=gy;
    localStorage.setItem(POS_KEY, JSON.stringify({gx,gy}));
    localStorage.setItem(POS_VER_KEY, POS_VERSION);
    toast(`Mission 3 start set to ${gx},${gy}`);
  };

  function startModal(onStart){
    let host=document.getElementById('m3Modal');
    if(!host){
      host=document.createElement('div'); host.id='m3Modal'; host.className='backdrop';
      Object.assign(host.style,{position:'fixed',inset:'0',display:'flex',alignItems:'center',justifyContent:'center',
        background:'rgba(0,0,0,.35)',zIndex:13});
      host.innerHTML=`
        <div style="background:#0f1625;border:1px solid #2a3550;border-radius:12px;padding:14px 16px;width:min(92vw,420px)">
          <div style="font-weight:700;font-size:16px;margin-bottom:6px">Mission 3</div>
          <div style="opacity:.9;line-height:1.45">
            Steal a <b>car</b> (walk to one & press <b>B</b>).<br>
            Then <b>touch the glowing edge</b> to open the city.
          </div>
          <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
            <button id="m3Cancel" class="ghost">Cancel</button>
            <button id="m3Start">Start</button>
          </div>
          <div style="opacity:.7;font-size:12px;margin-top:6px">Drive with the joystick / WASD. Same controls, just faster.</div>
        </div>`;
      document.body.appendChild(host);
      host.addEventListener('click',e=>{ if(e.target===host) host.style.display='none'; });
      host.querySelector('#m3Cancel').addEventListener('click',()=> host.style.display='none');
      host.querySelector('#m3Start').addEventListener('click',()=>{ host.style.display='none'; onStart&&onStart(); });
    }
    host.style.display='flex';
  }

  function unlockedRect(){ return {x0:18,y0:18,x1:72,y1:42}; }
  function roadGy(){
    const u=unlockedRect(); const bW=10,bH=6;
    const bX=((u.x0+u.x1)/2|0)- (bW/2|0);
    const bY=u.y0+5;
    return bY+bH+1;
  }
  function goalRectTier1(){ const u=unlockedRect(), gy=roadGy(); return {x0:u.x1-1,x1:u.x1,gy}; }

  function w2sX(wx){ return (wx-api.camera.x)*(api.DRAW/api.TILE); }
  function w2sY(wy){ return (wy-api.camera.y)*(api.DRAW/api.TILE); }
  function drawStartSquare(){
    if(m3.state==='done' || localStorage.getItem(M2_KEY)!=='done') return;
    const t=api.TILE, S=api.DRAW, ctx=document.getElementById('game').getContext('2d');
    const sx=w2sX(m3.gx*t), sy=w2sY(m3.gy*t);
    ctx.save(); ctx.fillStyle='rgba(0,190,255,.80)'; ctx.fillRect(sx+S*0.15,sy+S*0.15,S*0.70,S*0.70); ctx.restore();
  }
  function drawEdgeGoal(){
    if(m3.state==='done' || localStorage.getItem(M2_KEY)!=='done') return;
    const g=goalRectTier1(), S=api.DRAW, t=api.TILE, ctx=document.getElementById('game').getContext('2d');
    const pulse=0.45+0.25*Math.sin(performance.now()/250);
    ctx.save(); ctx.fillStyle=`rgba(255,210,63,${pulse})`;
    for(let gx=g.x0;gx<=g.x1;gx++){ const sx=w2sX(gx*t), sy=w2sY(g.gy*t); ctx.fillRect(sx+S*0.08,sy+S*0.08,S*0.84,S*0.84); }
    ctx.restore();
  }
  function drawCarOverlay(){
    if(!m3.driving||!m3.car) return;
    const ctx=document.getElementById('game').getContext('2d'), S=api.DRAW, sx=w2sX(m3.car.x), sy=w2sY(m3.car.y);
    ctx.save(); ctx.fillStyle='#c0c8d8'; ctx.fillRect(sx+S*0.10, sy+S*0.25, S*0.80, S*0.50); ctx.restore();
  }

  function setM3State(s){ m3.state=s; localStorage.setItem(M3_KEY,s); }
  function completeM3(){
    setM3State('done'); m3.driving=false; m3.car=null;
    try{ const cur=(api.getMissionCount&&api.getMissionCount())||0; localStorage.setItem('izzaMissions', String(Math.max(cur,3))); }catch{}
    localStorage.setItem(MAP_TIER_KEY,'2'); // expander plugin listens for this
    toast('Mission 3 complete! New district unlocked & pistols enabled.');
  }

  function startDriving(fromCar){
    const idx=(api.cars||[]).indexOf(fromCar); if(idx>=0) api.cars.splice(idx,1);
    try{
      const skins=['ped_m','ped_f','ped_m_dark','ped_f_dark']; const skin=skins[(Math.random()*skins.length)|0];
      (api.pedestrians||[]).push({x:fromCar.x,y:fromCar.y,mode:'vert',dir:(Math.random()<0.5?-1:1),spd:40,hp:4,state:'walk',
        crossSide:'top',vertX:(fromCar.x/api.TILE|0),blinkT:0,skin,facing:'down',moving:true});
    }catch{}
    m3.car={x:api.player.x,y:api.player.y}; m3.driving=true; setM3State('active');
    if(m3._savedWalkSpeed==null) m3._savedWalkSpeed=api.player.speed;
    api.player.speed=CAR_SPEED;
    toast('You hijacked a car! Drive to the glowing edge.');
  }
  function stopDriving(){ m3.driving=false; m3.car=null; if(m3._savedWalkSpeed!=null){ api.player.speed=m3._savedWalkSpeed; m3._savedWalkSpeed=null; } }

  function nearestCar(){
    let best=null, bestD=1e9;
    for(const c of api.cars||[]){ const d=Math.hypot(api.player.x-c.x, api.player.y-c.y); if(d<bestD){ best=c; bestD=d; } }
    return best && bestD<=HIJACK_RADIUS ? best : null;
  }
  function nearStart(){ const {gx,gy}=playerGrid(); return (Math.abs(gx-m3.gx)+Math.abs(gy-m3.gy))<=1; }

  function onB(){
    if(localStorage.getItem(M2_KEY)!=='done' || m3.state==='done') return;
    if(m3.state==='ready' && nearStart()){ startModal(()=>{ setM3State('active'); toast('Find a car and press B to hijack it.'); }); return; }
    if(m3.state==='active' && !m3.driving){
      const c=nearestCar();
      if(c) startDriving(c);
      else if(nearStart()){ setM3State('ready'); toast('Mission 3 cancelled.'); }
    }
  }

  function updateDriving(){
    if(!m3.driving||!m3.car) return;
    // visual car follows the (now fast) player
    m3.car.x=api.player.x; m3.car.y=api.player.y;

    // Instant completion when *touching* the gold stripe
    const g=goalRectTier1(), t=api.TILE;
    const gx=(api.player.x/t|0), gy=(api.player.y/t|0);
    if(gy===g.gy && gx>=g.x0 && gx<=g.x1){
      completeM3();
      api.player.x += EXPAND_NUDGE_T*t; // small push into the new district
      stopDriving();
    }
  }

  IZZA.on('ready',(a)=>{
    api=a; loadPos();
    window.addEventListener('keydown',e=>{ if((e.key||'').toLowerCase()==='b') onB(); });
    const btnB=document.getElementById('btnB'); if(btnB) btnB.addEventListener('click', onB);
    console.log('[M3] ready', {state:m3.state,start:{gx:m3.gx,gy:m3.gy}});
  });
  IZZA.on('update-post',()=>{ if(m3.driving) updateDriving(); });
  IZZA.on('render-post',()=>{ drawStartSquare(); drawEdgeGoal(); drawCarOverlay(); });
})();
