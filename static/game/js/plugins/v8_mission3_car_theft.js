// /static/game/js/plugins/v8_mission3_car_theft.js
(function(){
  const BUILD = 'v8.1-mission3-car-theft+joystick+solid-buildings+edge-indicator';
  console.log('[IZZA PLAY]', BUILD);

  // ---------- Keys / storage ----------
  const M2_KEY         = 'izzaMission2';           // 'ready' | 'active' | 'done'
  const M3_KEY         = 'izzaMission3';           // 'ready' | 'active' | 'done'
  const POS_KEY        = 'izzaMission3Pos';        // {gx,gy}
  const POS_VER_KEY    = 'izzaMission3PosVer';
  const POS_VERSION    = '1';
  const MAP_TIER_KEY   = 'izzaMapTier';            // '1' | '2' (core expands map when set to '2')

  // Start location: 8 tiles LEFT of outside spawn (HQ door)
  const DEFAULT_OFFSET_TILES = { dx: -8, dy: 0 };

  // ---- “Exit” indicator (where you drive off the map to finish)
  // Default is the **east edge** mid-height. Override with:
  //   window.__IZZA_M3_EXIT__ = { side:'east'|'west'|'north'|'south', gyOffset:0 }  // for N/S
  //   or { side:'east', gy: 30 }  // absolute grid row on east/west
  //   or localStorage.setItem('izzaMission3Exit', JSON.stringify(...))
  const EXIT_LS_KEY = 'izzaMission3Exit';
  const DEFAULT_EXIT = { side:'east' };

  // Gameplay knobs
  const HIJACK_RADIUS = 22;      // px world distance to a car to allow B hijack
  const CAR_SPEED     = 120;     // px/s while you drive (match NPC cars)
  const TURN_RATE     = 3.3;     // radians/s (steering)
  const EDGE_PAD_TILES= 1;       // how far beyond bounds counts as "off map"
  const EXIT_WIDTH_TILES = 6;    // width of the glowing corridor on the chosen edge

  // Locals populated on ready
  let api=null;
  const m3 = {
    state: localStorage.getItem(M3_KEY) || 'ready',   // 'ready' | 'active' | 'done'
    gx:0, gy:0,                 // start square grid
    driving:false,
    // our controlled car entity
    car: null,                  // {x,y,dirRad,spd}
  };

  // ---------- Utilities ----------
  const now = ()=> performance.now();

  function toast(msg, seconds=2.8){
    let h = document.getElementById('tutHint');
    if(!h){
      h = document.createElement('div');
      h.id='tutHint';
      Object.assign(h.style,{
        position:'fixed', left:'12px', top:'64px', zIndex:12,
        background:'rgba(10,12,18,.88)', border:'1px solid #394769',
        color:'#cfe0ff', padding:'8px 10px', borderRadius:'10px', fontSize:'14px',
        maxWidth:'70vw'
      });
      document.body.appendChild(h);
    }
    h.textContent = msg; h.style.display='block';
    clearTimeout(h._t);
    h._t = setTimeout(()=>{ h.style.display='none'; }, seconds*1000);
  }

  function playerGrid(){
    const t=api.TILE;
    return {
      gx: Math.floor((api.player.x + t/2)/t),
      gy: Math.floor((api.player.y + t/2)/t)
    };
  }

  // ---------- Positioning ----------
  function loadPos(){
    // saved & version
    const ver = localStorage.getItem(POS_VER_KEY);
    const saved = localStorage.getItem(POS_KEY);
    if(saved && ver===POS_VERSION){
      try{
        const j=JSON.parse(saved);
        if(Number.isFinite(j.gx) && Number.isFinite(j.gy)){ m3.gx=j.gx|0; m3.gy=j.gy|0; return; }
      }catch{}
    }
    // default relative to doorSpawn
    const t=api.TILE;
    const doorGX = Math.floor((api.doorSpawn.x + 8)/t);
    const doorGY = Math.floor(api.doorSpawn.y/t);
    m3.gx = doorGX + DEFAULT_OFFSET_TILES.dx;
    m3.gy = doorGY + DEFAULT_OFFSET_TILES.dy;
    localStorage.setItem(POS_KEY, JSON.stringify({gx:m3.gx, gy:m3.gy}));
    localStorage.setItem(POS_VER_KEY, POS_VERSION);
  }

  // Tiny dev helper in console if you want to tweak quickly
  window._izza_m3_here = function(){
    const {gx,gy}=playerGrid();
    m3.gx=gx; m3.gy=gy;
    localStorage.setItem(POS_KEY, JSON.stringify({gx,gy}));
    localStorage.setItem(POS_VER_KEY, POS_VERSION);
    toast(`Mission 3 start set to ${gx},${gy}`);
  };

  // ---------- UI: start modal ----------
  function startModal(onStart){
    let host=document.getElementById('m3Modal');
    if(!host){
      host=document.createElement('div');
      host.id='m3Modal';
      host.className='backdrop';
      Object.assign(host.style,{
        position:'fixed', inset:'0', display:'flex', alignItems:'center', justifyContent:'center',
        background:'rgba(0,0,0,.35)', zIndex:13
      });
      host.innerHTML = `
        <div style="background:#0f1625;border:1px solid #2a3550;border-radius:12px; padding:14px 16px; width:min(92vw,420px)">
          <div style="font-weight:700; font-size:16px; margin-bottom:6px">Mission 3</div>
          <div style="opacity:.9; line-height:1.45">
            Steal a <b>car</b>: walk up to a passing car and press <b>B</b>.<br>
            Then <b>drive to the glowing edge</b> to escape the district.
          </div>
          <div style="display:flex; gap:8px; justify-content:flex-end; margin-top:12px">
            <button id="m3Cancel" class="ghost">Cancel</button>
            <button id="m3Start">Start</button>
          </div>
          <div style="opacity:.7; font-size:12px; margin-top:6px">
            Controls: Joystick or Arrows / WASD to steer & move.
          </div>
        </div>`;
      document.body.appendChild(host);
      host.addEventListener('click', e=>{ if(e.target===host) host.style.display='none'; });
      host.querySelector('#m3Cancel').addEventListener('click', ()=> host.style.display='none');
      host.querySelector('#m3Start').addEventListener('click', ()=>{
        host.style.display='none'; onStart && onStart();
      });
    }
    host.style.display='flex';
  }

  // ---------- Drawing ----------
  function w2sX(wx){ return (wx - api.camera.x) * (api.DRAW/api.TILE); }
  function w2sY(wy){ return (wy - api.camera.y) * (api.DRAW/api.TILE); }

  function drawStartSquare(){
    if(m3.state==='done') return;
    if(localStorage.getItem(M2_KEY)!=='done') return; // only after M2
    const t=api.TILE;
    const sx=w2sX(m3.gx*t), sy=w2sY(m3.gy*t);
    const S=api.DRAW;
    const ctx=document.getElementById('game').getContext('2d');
    ctx.save();
    ctx.fillStyle='rgba(0,190,255,.80)';
    ctx.fillRect(sx+S*0.15, sy+S*0.15, S*0.70, S*0.70);
    ctx.restore();
  }

  function drawCarOverlay(){
    if(!m3.driving || !m3.car) return;
    const ctx=document.getElementById('game').getContext('2d');
    const S=api.DRAW;
    const sx=w2sX(m3.car.x), sy=w2sY(m3.car.y);

    ctx.save();
    ctx.translate(sx+S*0.5, sy+S*0.5);
    ctx.rotate(m3.car.dirRad||0);
    ctx.fillStyle='#c0c8d8';
    ctx.fillRect(-S*0.40, -S*0.22, S*0.80, S*0.44);
    ctx.restore();
  }

  // ---- Edge indicator (glowing portal stripe)
  let exitCfg = null;
  function loadExitCfg(){
    try{
      exitCfg = window.__IZZA_M3_EXIT__ || JSON.parse(localStorage.getItem(EXIT_LS_KEY)||'null') || DEFAULT_EXIT;
    }catch{ exitCfg = DEFAULT_EXIT; }
  }
  function currentBounds(){
    // Matches core tier-1 defaults; good enough for the “escape” logic.
    // (Core expands to tier-2 after completion.)
    return { x0:18, y0:18, x1:72, y1:42 };
  }
  function drawExitGlow(){
    if(m3.state==='done') return;
    const b = currentBounds();
    const S = api.DRAW, t = api.TILE;
    const ctx=document.getElementById('game').getContext('2d');
    const pulse = (Math.sin(performance.now()/300)+1)/2; // 0..1
    ctx.save();
    ctx.globalAlpha = 0.35 + 0.35*pulse;
    ctx.fillStyle = '#49a4ff';

    if(exitCfg.side==='east'){
      const gy = Number.isFinite(exitCfg.gy) ? exitCfg.gy : Math.floor((b.y0+b.y1)/2);
      const sx = w2sX((b.x1+1)*t);
      const sy = w2sY((gy-Math.floor(EXIT_WIDTH_TILES/2))*t);
      ctx.fillRect(sx, sy, S*0.6, EXIT_WIDTH_TILES*t*(S/t));
    }else if(exitCfg.side==='west'){
      const gy = Number.isFinite(exitCfg.gy) ? exitCfg.gy : Math.floor((b.y0+b.y1)/2);
      const sx = w2sX((b.x0-1)*t) - S*0.6;
      const sy = w2sY((gy-Math.floor(EXIT_WIDTH_TILES/2))*t);
      ctx.fillRect(sx, sy, S*0.6, EXIT_WIDTH_TILES*t*(S/t));
    }else if(exitCfg.side==='north'){
      const gxMid = Math.floor((b.x0+b.x1)/2);
      const sy = w2sY((b.y0-1)*t) - S*0.6;
      const sx = w2sX((gxMid-Math.floor(EXIT_WIDTH_TILES/2))*t);
      ctx.fillRect(sx, sy, EXIT_WIDTH_TILES*t*(S/t), S*0.6);
    }else{ // south
      const gxMid = Math.floor((b.x0+b.x1)/2);
      const sy = w2sY((b.y1+1)*t);
      const sx = w2sX((gxMid-Math.floor(EXIT_WIDTH_TILES/2))*t);
      ctx.fillRect(sx, sy, EXIT_WIDTH_TILES*t*(S/t), S*0.6);
    }
    ctx.restore();
  }

  // ---------- Mission helpers ----------
  function setM3State(s){ m3.state=s; localStorage.setItem(M3_KEY, s); }
  function completeM3(){
    setM3State('done');
    m3.driving=false; m3.car=null;
    // Unlock pistols (mission count >= 3)
    try{
      const cur = (api.getMissionCount && api.getMissionCount()) || 0;
      localStorage.setItem('izzaMissions', String(Math.max(cur,3)));
    }catch{}
    // Flag for core to expand the map later
    localStorage.setItem(MAP_TIER_KEY, '2');
    toast('Mission 3 complete! Map expanded & pistols unlocked.');
  }

  // ---------- Input handling (keys + joystick) ----------
  const key = Object.create(null);

  // Joystick sampler → maps the same mobile stick to car controls while driving
  let joy = {x:0,y:0};
  function bindJoystick(){
    const stick = document.getElementById('stick');
    if(!stick) return;

    const r=40; // matches core
    function sample(e){
      const t=e.touches?e.touches[0]:e;
      const rect=stick.getBoundingClientRect();
      const cx=rect.left+rect.width/2, cy=rect.top+rect.height/2;
      const dx=t.clientX-cx, dy=t.clientY-cy;
      const m=Math.hypot(dx,dy)||1;
      const c=Math.min(m,r);
      joy.x=(c/r)*(dx/m);
      joy.y=(c/r)*(dy/m);
    }
    function clear(){ joy.x=0; joy.y=0; }

    stick.addEventListener('touchstart', e=>{ if(m3.driving){ sample(e); e.preventDefault(); } }, {passive:false});
    stick.addEventListener('touchmove',  e=>{ if(m3.driving){ sample(e); e.preventDefault(); } }, {passive:false});
    stick.addEventListener('touchend',   e=>{ if(m3.driving){ clear(); e.preventDefault(); } }, {passive:false});
    // mouse (for desktop testing)
    stick.addEventListener('mousedown',  e=>{ if(m3.driving){ sample(e); }});
    window.addEventListener('mousemove', e=>{ if(m3.driving && e.buttons&1){ sample(e); }});
    window.addEventListener('mouseup',   e=>{ if(m3.driving){ clear(); }});
  }

  function bindKeys(){
    window.addEventListener('keydown', e=>{
      const k=(e.key||'').toLowerCase();
      if(k==='arrowleft' || k==='a')  key.left=true;
      if(k==='arrowright'|| k==='d')  key.right=true;
      if(k==='arrowup'   || k==='w')  key.up=true;
      if(k==='arrowdown' || k==='s')  key.down=true;
      if(k==='b') onB();
    });
    window.addEventListener('keyup', e=>{
      const k=(e.key||'').toLowerCase();
      if(k==='arrowleft' || k==='a')  key.left=false;
      if(k==='arrowright'|| k==='d')  key.right=false;
      if(k==='arrowup'   || k==='w')  key.up=false;
      if(k==='arrowdown' || k==='s')  key.down=false;
    });
    const btnB=document.getElementById('btnB');
    if(btnB) btnB.addEventListener('click', onB);

    bindJoystick();
  }

  function nearStart(){
    const {gx,gy}=playerGrid();
    return (Math.abs(gx-m3.gx)+Math.abs(gy-m3.gy))<=1;
  }

  function nearestCar(){
    let best=null, bestD=1e9;
    for(const c of api.cars||[]){
      const d = Math.hypot((api.player.x - c.x),(api.player.y - c.y));
      if(d<bestD){ best=c; bestD=d; }
    }
    return best && bestD<=HIJACK_RADIUS ? best : null;
  }

  function startDriving(fromCar){
    // remove that car from core traffic
    const idx = (api.cars||[]).indexOf(fromCar);
    if(idx>=0) api.cars.splice(idx,1);

    // spawn a “driver” pedestrian that walks away
    try{
      const skins=['ped_m','ped_f','ped_m_dark','ped_f_dark'];
      const skin=skins[(Math.random()*skins.length)|0];
      (api.pedestrians||[]).push({
        x: fromCar.x, y: fromCar.y,
        mode:'vert', dir: (Math.random()<0.5?-1:1), spd:40,
        hp:4, state:'walk', crossSide:'top', vertX: Math.floor(fromCar.x/api.TILE),
        blinkT:0, skin, facing:'down', moving:true
      });
    }catch{}

    m3.car = {
      x: fromCar.x, y: fromCar.y,
      dirRad: (fromCar.dir<0 ? Math.PI : 0), // core cars go left/right; map to angle
      spd: CAR_SPEED
    };
    m3.driving = true;
    setM3State('active');
    toast('You hijacked a car! Drive to the glowing edge.');
  }

  function stopDriving(){
    m3.driving=false; m3.car=null;
  }

  function onB(){
    // Gate: only show/start M3 after M2 is done
    if(localStorage.getItem(M2_KEY)!=='done') return;

    if(m3.state==='done') return;

    // At start square → open start modal
    if(m3.state==='ready' && nearStart()){
      startModal(()=>{ setM3State('active'); toast('Find a car and press B to hijack it.'); });
      return;
    }

    // Active and near a car → hijack
    if(m3.state==='active' && !m3.driving){
      const c=nearestCar();
      if(c){ startDriving(c); }
      else if(nearStart()){
        // allow cancel/reset at the square
        setM3State('ready'); toast('Mission 3 cancelled.');
      }
      return;
    }
  }

  // ---------- Solid building collisions ----------
  // Reconstruct the **HQ** & **Shop** rectangles from known layout.
  // This matches the core’s constants (bW=10,bH=6, shop w=8,h=5).
  function buildingRects(){
    const t = api.TILE;
    const doorGX = Math.floor((api.doorSpawn.x + 8)/t);
    const doorGY = Math.floor(api.doorSpawn.y/t);
    const bW=10, bH=6;

    const bX = doorGX - Math.floor(bW/2);
    const bY = doorGY - bH; // top of HQ

    // Sidewalk row at doorGY, vertical road at about bX+bW+6
    const vRoadX = bX + bW + 6;
    const vSidewalkRightX = vRoadX + 1;

    const shop = { x: vSidewalkRightX + 1, y: doorGY - 5, w: 8, h: 5 };

    return [
      { x:bX, y:bY, w:bW, h:bH }, // HQ
      shop
    ];
  }

  function collidesBuildings(nx, ny){
    // treat the car as a point near its center for simple blocking
    const t = api.TILE;
    const gx = Math.floor((nx + t/2)/t);
    const gy = Math.floor((ny + t/2)/t);
    for(const r of buildingRects()){
      if(gx>=r.x && gx<r.x+r.w && gy>=r.y && gy<r.y+r.h) return true;
    }
    return false;
  }

  // ---------- Update driving ----------
  function updateDriving(dt){
    if(!m3.driving || !m3.car) return;

    // steering from keys + joystick
    const turnAxis = ((key.left?-1:0) + (key.right?1:0)) + (joy.x||0); // joystick x adds to steering
    const thrustAxis = ((key.up?1:0) + (key.down?-0.6:0)) + (-(joy.y||0)); // up is negative y on stick

    m3.car.dirRad += clamp(turnAxis, -1, 1) * TURN_RATE * dt;

    const v = m3.car.spd * clamp(thrustAxis, -1, 1);
    const vx = Math.cos(m3.car.dirRad) * v * dt;
    const vy = Math.sin(m3.car.dirRad) * v * dt;

    const nx = m3.car.x + vx;
    const ny = m3.car.y + vy;

    // BLOCK buildings; allow everything else (including black area)
    if(!collidesBuildings(nx, ny)){
      m3.car.x = nx;
      m3.car.y = ny;
    }

    // Snap player to car so camera follows, etc.
    api.player.x = m3.car.x;
    api.player.y = m3.car.y;

    // Escape detection: crossing the chosen edge **within** the glowing corridor
    const b = currentBounds();
    const t = api.TILE;
    const gx = Math.floor(m3.car.x/t);
    const gy = Math.floor(m3.car.y/t);

    let inCorridor=false, off=false;

    if(exitCfg.side==='east'){
      const gyMid = Number.isFinite(exitCfg.gy) ? exitCfg.gy : Math.floor((b.y0+b.y1)/2);
      inCorridor = gy>=gyMid-Math.floor(EXIT_WIDTH_TILES/2) && gy<=gyMid+Math.floor(EXIT_WIDTH_TILES/2);
      off = gx > b.x1 + EDGE_PAD_TILES;
    }else if(exitCfg.side==='west'){
      const gyMid = Number.isFinite(exitCfg.gy) ? exitCfg.gy : Math.floor((b.y0+b.y1)/2);
      inCorridor = gy>=gyMid-Math.floor(EXIT_WIDTH_TILES/2) && gy<=gyMid+Math.floor(EXIT_WIDTH_TILES/2);
      off = gx < b.x0 - EDGE_PAD_TILES;
    }else if(exitCfg.side==='north'){
      const gxMid = Number.isFinite(exitCfg.gx) ? exitCfg.gx : Math.floor((b.x0+b.x1)/2);
      inCorridor = gx>=gxMid-Math.floor(EXIT_WIDTH_TILES/2) && gx<=gxMid+Math.floor(EXIT_WIDTH_TILES/2);
      off = gy < b.y0 - EDGE_PAD_TILES;
    }else{ // south
      const gxMid = Number.isFinite(exitCfg.gx) ? exitCfg.gx : Math.floor((b.x0+b.x1)/2);
      inCorridor = gx>=gxMid-Math.floor(EXIT_WIDTH_TILES/2) && gx<=gxMid+Math.floor(EXIT_WIDTH_TILES/2);
      off = gy > b.y1 + EDGE_PAD_TILES;
    }

    if(inCorridor && off){
      completeM3();
      stopDriving();
    }
  }

  // helpers
  function clamp(n,min,max){ return Math.max(min, Math.min(max, n)); }

  // ---------- Hooks ----------
  IZZA.on('ready', (a)=>{
    api=a;
    loadPos();
    loadExitCfg();
    bindKeys();

    console.log('[M3] ready', { state:m3.state, start:{gx:m3.gx, gy:m3.gy}, exit:exitCfg });
  });

  IZZA.on('update-post', ({dtSec})=>{
    if(m3.driving) updateDriving(dtSec||0);
  });

  IZZA.on('render-post', ()=>{
    // Show start square only after M2 done
    drawStartSquare();
    // Show the glowing exit while M3 is available (ready/active)
    if(localStorage.getItem(M2_KEY)==='done' && m3.state!=='done') drawExitGlow();
    // Draw the car you’re driving (so it renders above sprites)
    drawCarOverlay();
  });

})();
