(function(){
  const BUILD = 'v8.0-mission3-car-theft+drive+edge-complete';
  console.log('[IZZA PLAY]', BUILD);

  // ---------- Keys / storage ----------
  const M2_KEY         = 'izzaMission2';           // 'ready' | 'active' | 'done'
  const M3_KEY         = 'izzaMission3';           // 'ready' | 'active' | 'done'
  const POS_KEY        = 'izzaMission3Pos';        // {gx,gy}
  const POS_VER_KEY    = 'izzaMission3PosVer';
  const POS_VERSION    = '1';                      // bump if default pos changes
  const MAP_TIER_KEY   = 'izzaMapTier';            // '1' | '2' (hook for core to expand map)
  const TIMER_ID       = 'm3HudHint';

  // Start location: 8 tiles LEFT of outside spawn (HQ door)
  const DEFAULT_OFFSET_TILES = { dx: -8, dy: 0 };

  // Gameplay knobs
  const HIJACK_RADIUS = 22;      // px (world) distance to a car to allow B hijack
  const CAR_SPEED     = 160;     // px/s while you drive
  const TURN_RATE     = 3.3;     // radians/s (steering)
  const EDGE_PAD_TILES= 1;       // how far past unlocked before we count success

  // Locals populated on ready
  let api=null;
  const m3 = {
    state: localStorage.getItem(M3_KEY) || 'ready',   // 'ready' | 'active' | 'done'
    gx:0, gy:0,                 // start square grid
    driving:false,
    // our controlled car entity (separate from core cars[] once hijacked)
    car: null,                  // {x,y,dirRad,spd}
    steer: {left:false, right:false, fwd:false, back:false}
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
            Then <b>drive to the edge of the map</b> (into the black area).
          </div>
          <div style="display:flex; gap:8px; justify-content:flex-end; margin-top:12px">
            <button id="m3Cancel" class="ghost">Cancel</button>
            <button id="m3Start">Start</button>
          </div>
          <div style="opacity:.7; font-size:12px; margin-top:6px">
            Controls while driving: Arrows / WASD to steer & move.
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

  // ---------- Input handling ----------
  const key = Object.create(null);
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
    toast('You hijacked a car! Drive to the map edge.');
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

  // ---------- Update driving ----------
  function updateDriving(dt){
    if(!m3.driving || !m3.car) return;

    // steering from keys
    const turn = (key.left?-1:0) + (key.right?1:0);
    const thrust = (key.up?1:0) + (key.down?-0.6:0); // light reverse

    m3.car.dirRad += turn * TURN_RATE * dt;

    const v = m3.car.spd * thrust;
    const vx = Math.cos(m3.car.dirRad) * v * dt;
    const vy = Math.sin(m3.car.dirRad) * v * dt;

    // Move car freely (ignore collisions/unlocked while driving)
    m3.car.x += vx;
    m3.car.y += vy;

    // Snap player to car so camera follows, etc.
    api.player.x = m3.car.x;
    api.player.y = m3.car.y;

    // Check if we've crossed beyond unlocked rect to “black”
    // We can infer the current unlocked bounds from camera and map constants
    // but the core keeps the real rect internally. Approximate using door spawn + known area:
    // Instead, detect using the in-bounds test visible from tiles:
    const t = api.TILE;
    const gx = Math.floor(m3.car.x/t), gy=Math.floor(m3.car.y/t);

    // We approximate the current play area by looking at where grass is drawn (camera clamp),
    // but since we can't read it directly, use a heuristic: if camera clamped near its min/max,
    // stepping farther by EDGE_PAD_TILES tiles counts as off-map.
    // Better: re-use the "unlocked" you used when placing m2/m3. We'll store it once:
    if(!updateDriving.bounds){
      // save bounds from the core’s clamp result via camera behavior:
      // doorSpawn is definitely inside; sample outward
      updateDriving.bounds = { x0: 18, y0: 18, x1: 72, y1: 42 }; // matches current core defaults
    }
    const b=updateDriving.bounds;
    const off = (gx < b.x0-EDGE_PAD_TILES) || (gx > b.x1+EDGE_PAD_TILES) ||
                (gy < b.y0-EDGE_PAD_TILES) || (gy > b.y1+EDGE_PAD_TILES);
    if(off){
      completeM3();
      stopDriving();
    }
  }

  // ---------- Hooks ----------
  IZZA.on('ready', (a)=>{
    api=a;
    loadPos();
    bindKeys();

    // If M2 just finished and M3 is still untouched, mark as ready.
    if(localStorage.getItem(M2_KEY)==='done' && m3.state==='ready'){
      // ensure visible square appears
      // (position already computed)
    }

    console.log('[M3] ready', { state:m3.state, start:{gx:m3.gx, gy:m3.gy} });
  });

  IZZA.on('update-post', ({dtSec})=>{
    if(m3.driving) updateDriving(dtSec||0);
  });

  IZZA.on('render-post', ()=>{
    // Show start square only after M2 done
    drawStartSquare();
    // Draw the car you’re driving (so it renders above sprites)
    drawCarOverlay();
  });

})();
