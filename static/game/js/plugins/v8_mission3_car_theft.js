(function () {
  const BUILD = 'v8.5-m3-start-square+driveable+gold-exit';
  console.log('[IZZA PLAY]', BUILD);

  // ---- config
  const M3_KEY       = 'izzaMission3';         // 'ready' | 'active' | 'done'
  const START_POS_KEY= 'izzaMission3Start';    // {gx,gy}
  const EXIT_POS_KEY = 'izzaMission3Exit';     // {gx,gy}
  const CAR_SPEED    = 120;

  // start = 8 tiles LEFT of spawn
  const START_OFFSET = { dx: -8, dy: 0 };

  const GOAL_TOAST  = 'Drive into the glowing edge to escape!';
  const DONE_TOAST  = 'Mission 3 complete! Map expanded; pistols can now be equipped.';

  let api=null;
  const m3 = {
    state: localStorage.getItem(M3_KEY) || 'ready', // ready|active|done
    inCar: false,
    startGX: 0, startGY: 0,
    exitGX: 72, exitGY: 0
  };
  window._izza_m3 = m3;

  const now = ()=>performance.now();
  function toast(msg, sec=2.6){
    let h=document.getElementById('tutHint');
    if(!h){ h=document.createElement('div'); h.id='tutHint';
      Object.assign(h.style,{position:'fixed',left:'12px',top:'64px',zIndex:9,
        background:'rgba(10,12,18,.88)',border:'1px solid #394769',color:'#cfe0ff',
        padding:'8px 10px',borderRadius:'10px',fontSize:'14px'}); document.body.appendChild(h);}
    h.textContent=msg; h.style.display='block'; clearTimeout(h._t);
    h._t=setTimeout(()=>{h.style.display='none';}, sec*1000);
  }
  function pg(){ const t=api.TILE; return {gx:((api.player.x+t/2)/t|0), gy:((api.player.y+t/2)/t|0)}; }
  function manh(a,b,c,d){ return Math.abs(a-c)+Math.abs(b-d); }

  // ---- positions
  function loadStartPos(){
    if(window.__IZZA_M3_START__ && Number.isFinite(window.__IZZA_M3_START__.gx)){
      m3.startGX=window.__IZZA_M3_START__.gx|0; m3.startGY=window.__IZZA_M3_START__.gy|0;
      localStorage.setItem(START_POS_KEY, JSON.stringify({gx:m3.startGX,gy:m3.startGY})); return;
    }
    const saved = localStorage.getItem(START_POS_KEY);
    if(saved){ try{ const j=JSON.parse(saved); if(Number.isFinite(j.gx)){ m3.startGX=j.gx|0; m3.startGY=j.gy|0; return; } }catch{} }
    const t=api.TILE; const sgx=(api.doorSpawn.x/t)|0; const sgy=(api.doorSpawn.y/t)|0;
    m3.startGX = sgx + START_OFFSET.dx; m3.startGY = sgy + START_OFFSET.dy;
    localStorage.setItem(START_POS_KEY, JSON.stringify({gx:m3.startGX,gy:m3.startGY}));
  }
  function loadExitPos(){
    if(window.__IZZA_M3_EXIT__ && Number.isFinite(window.__IZZA_M3_EXIT__.gx)){
      m3.exitGX=window.__IZZA_M3_EXIT__.gx|0; m3.exitGY=window.__IZZA_M3_EXIT__.gy|0;
      localStorage.setItem(EXIT_POS_KEY, JSON.stringify({gx:m3.exitGX,gy:m3.exitGY})); return;
    }
    const saved = localStorage.getItem(EXIT_POS_KEY);
    if(saved){ try{ const j=JSON.parse(saved); if(Number.isFinite(j.gx)){ m3.exitGX=j.gx|0; m3.exitGY=j.gy|0; return; } }catch{} }
    const doorGY=((api.doorSpawn.y/api.TILE)|0);
    m3.exitGY = doorGY + 1;   // main horizontal road row
    m3.exitGX = 72;           // right edge of your current map
    localStorage.setItem(EXIT_POS_KEY, JSON.stringify({gx:m3.exitGX,gy:m3.exitGY}));
  }
  // helpers to place quickly from console:
  window._izza_m3_setStartHere = ()=>{ const {gx,gy}=pg(); m3.startGX=gx; m3.startGY=gy; localStorage.setItem(START_POS_KEY, JSON.stringify({gx,gy})); toast(`M3 start at ${gx},${gy}`); };
  window._izza_m3_setExitHere  = ()=>{ const {gx,gy}=pg(); m3.exitGX=gx;  m3.exitGY=gy;  localStorage.setItem(EXIT_POS_KEY,  JSON.stringify({gx,gy})); toast(`M3 exit at ${gx},${gy}`); };

  // ---- draw helpers
  function w2sX(wx){ return (wx - api.camera.x) * (api.DRAW/api.TILE); }
  function w2sY(wy){ return (wy - api.camera.y) * (api.DRAW/api.TILE); }

  function drawStartSquare(){
    // only when M2 is complete (>=2) and M3 not yet started/done
    if(m3.state!=='ready') return;
    const ms = (api.getMissionCount && api.getMissionCount()) || 0;
    if(ms < 2) return;

    const S=api.DRAW, t=api.TILE, sx=w2sX(m3.startGX*t), sy=w2sY(m3.startGY*t);
    const ctx=document.getElementById('game').getContext('2d');
    ctx.save();
    ctx.fillStyle='rgba(70,140,255,.75)';
    ctx.fillRect(sx+S*0.15, sy+S*0.15, S*0.70, S*0.70);
    ctx.restore();
  }

  function drawExitGlow(){
    if(m3.state!=='active' || !m3.inCar) return;
    const S=api.DRAW,t=api.TILE, sx=w2sX(m3.exitGX*t), sy=w2sY(m3.exitGY*t);
    const ctx=document.getElementById('game').getContext('2d');
    const pulse = 0.65 + 0.35 * Math.sin(now()/220);
    ctx.save();
    ctx.fillStyle=`rgba(255,208,86,${0.45+0.35*pulse})`;
    ctx.fillRect(sx+S*0.1, sy+S*0.1, S*0.8, S*0.8);
    ctx.strokeStyle='rgba(255,235,150,.9)'; ctx.lineWidth=2;
    ctx.strokeRect(sx+S*0.12, sy+S*0.12, S*0.76, S*0.76);
    ctx.restore();
  }

  function drawCarOverlay(){
    if(!m3.inCar || m3.state==='done') return;
    const ctx=document.getElementById('game').getContext('2d');
    const S=api.DRAW, sx=w2sX(api.player.x), sy=w2sY(api.player.y);
    ctx.save(); ctx.fillStyle='#c0c8d8';
    ctx.fillRect(sx+S*0.10, sy+S*0.25, S*0.80, S*0.50);
    ctx.restore();
  }

  // ---- mission logic
  function nearStart(){ const {gx,gy}=pg(); return manh(gx,gy,m3.startGX,m3.startGY)<=1; }
  function nearAnyCar(){
    if(!api.cars||!api.cars.length) return null;
    const px=api.player.x, py=api.player.y; let best=null, bd=9999;
    for(const c of api.cars){ const d=Math.hypot(px-c.x,py-c.y); if(d<34 && d<bd){best=c;bd=d;} }
    return best;
  }
  function atExit(){ const {gx,gy}=pg(); return gx===(m3.exitGX|0) && gy===(m3.exitGY|0); }

  function startM3(){
    m3.state='active'; localStorage.setItem(M3_KEY,'active');
    toast('Mission 3 started: hijack a car!');
  }
  function enterCar(){
    m3.inCar=true; api.player.speed = CAR_SPEED; toast(GOAL_TOAST,3.2);
  }
  function completeM3(){
    localStorage.setItem(M3_KEY,'done'); m3.state='done'; m3.inCar=false;
    try{
      const cur=(api.getMissionCount&&api.getMissionCount())||0;
      const next=Math.max(cur,3); localStorage.setItem('izzaMissions', String(next));
    }catch{}
    localStorage.setItem('izzaMapTier','2');
    toast(DONE_TOAST,4);
    // restore foot speed
    api.player.speed = 90;
  }

  // ---- input (B)
  function onB(){
    if(!api||!api.ready) return;

    // Start square
    if(m3.state==='ready'){
      const ms=(api.getMissionCount&&api.getMissionCount())||0;
      if(ms>=2 && nearStart()){
        startM3();
        return;
      }
    }

    // Hijack
    if(m3.state==='active' && !m3.inCar){
      const car=nearAnyCar();
      if(car){ enterCar(); return; }
    }

    // Optional: allow exit with B while testing
    // if(m3.inCar){ m3.inCar=false; api.player.speed=90; }
  }

  function bindB(){
    window.addEventListener('keydown', e=>{
      if(e.key && e.key.toLowerCase()==='b') onB();
    });
    const btn=document.getElementById('btnB'); if(btn) btn.addEventListener('click', onB);
  }

  // ---- hooks
  IZZA.on('ready', (a)=>{
    api=a;
    bindB();
    loadStartPos();
    loadExitPos();
    // if already done previously, ensure map is expanded
    if(m3.state==='done' && localStorage.getItem('izzaMapTier')!=='2'){
      localStorage.setItem('izzaMapTier','2');
    }
    console.log('[M3] ready', {state:m3.state, start:{gx:m3.startGX,gy:m3.startGY}, exit:{gx:m3.exitGX,gy:m3.exitGY}});
  });

  IZZA.on('update-post', ()=>{
    if(!api) return;
    if(m3.state!=='active') return;

    if(m3.inCar){
      api.player.speed = CAR_SPEED; // keep boosted
      if(atExit()) completeM3();
    }
  });

  IZZA.on('render-post', ()=>{
    if(!api) return;
    drawStartSquare();
    drawExitGlow();
    drawCarOverlay();
  });
})();
