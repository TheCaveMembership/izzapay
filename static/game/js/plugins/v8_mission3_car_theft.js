// /static/game/js/plugins/v8_mission3_car_theft.js
(function(){
  const BUILD = 'v8.3-mission3-car-theft+joystick-drive+edge-goal+tier2';
  console.log('[IZZA PLAY]', BUILD);

  // ---------- Keys / storage ----------
  const M2_KEY       = 'izzaMission2';           // 'ready' | 'active' | 'done'
  const M3_KEY       = 'izzaMission3';           // 'ready' | 'active' | 'done'
  const POS_KEY      = 'izzaMission3Pos';        // {gx,gy}
  const POS_VER_KEY  = 'izzaMission3PosVer';
  const POS_VERSION  = '1';
  const MAP_TIER_KEY = 'izzaMapTier';            // '1' | '2' (core watches this)

  // Start location: 8 tiles LEFT of outside spawn (HQ door)
  const DEFAULT_OFFSET_TILES = { dx: -8, dy: 0 };

  // Gameplay knobs
  const HIJACK_RADIUS   = 22;     // px to a car to allow hijack on B
  const CAR_SPEED       = 120;    // px/s — matches NPC traffic in core
  const EXPAND_NUDGE_T  = 2;      // tiles to nudge the player into the new area when expanding

  // Locals populated on ready
  let api=null;
  const m3 = {
    state: localStorage.getItem(M3_KEY) || 'ready',   // 'ready' | 'active' | 'done'
    gx:0, gy:0,                 // start square grid
    driving:false,
    car: null,                  // visual-only car overlay
    _savedWalkSpeed: null
  };

  // track player delta each frame (so we can know push direction at edge)
  let _prevPX=0, _prevPY=0, _lastDX=0, _lastDY=0;

  // ---------- Utilities ----------
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

  // Tiny dev helper
  window._izza_m3_here = function(){
    const {gx,gy}=playerGrid();
    m3.gx=gx; m3.gy=gy;
    localStorage.setItem(POS_KEY, JSON.stringify({gx,gy}));
    localStorage.setItem(POS_VER_KEY, POS_VERSION);
    toast(`Mission 3 start set to ${gx},${gy}`);
  };

  // ---------- Start modal ----------
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
            Then <b>drive to the glowing edge</b> to open the city.
          </div>
          <div style="display:flex; gap:8px; justify-content:flex-end; margin-top:12px">
            <button id="m3Cancel" class="ghost">Cancel</button>
            <button id="m3Start">Start</button>
          </div>
          <div style="opacity:.7; font-size:12px; margin-top:6px">
            Drive with your joystick (or WASD/Arrows). Same controls, just faster.
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

  // ---------- World geometry helpers (to place the goal) ----------
  function currentTier(){ return localStorage.getItem(MAP_TIER_KEY) || '1'; }
  function unlockedRect(tier){
    return tier==='2' ? { x0:10, y0:12, x1:80, y1:50 } : { x0:18, y0:18, x1:72, y1:42 };
  }
  function roadGyForTier(tier){
    // reproduce core’s road math to sit the goal on the main horizontal road
    const u = unlockedRect(tier);
    const bW=10, bH=6;
    const bX = Math.floor((u.x0+u.x1)/2) - Math.floor(bW/2);
    const bY = u.y0 + 5;
    const hRoadY = bY + bH + 1;
    return hRoadY;
  }

  // Right-edge goal rectangle (2 tiles wide on the main road)
  function goalRectTier1(){
    const u = unlockedRect('1');
    const gy = roadGyForTier('1');
    return { x0: u.x1-1, x1: u.x1, gy };
  }

  // ---------- Drawing ----------
  function w2sX(wx){ return (wx - api.camera.x) * (api.DRAW/api.TILE); }
  function w2sY(wy){ return (wy - api.camera.y) * (api.DRAW/api.TILE); }

  function drawStartSquare(){
    if(m3.state==='done') return;
    if(localStorage.getItem(M2_KEY)!=='done') return; // only after M2
    const t=api.TILE;
    const sx=w2sX(m3.gx*t), sy=w2sY(m3.gy*t);
    const S=api.DRAW, ctx=document.getElementById('game').getContext('2d');
    ctx.save();
    ctx.fillStyle='rgba(0,190,255,.80)';
    ctx.fillRect(sx+S*0.15, sy+S*0.15, S*0.70, S*0.70);
    ctx.restore();
  }

  // Glowing right-edge indicator (where we want to expand)
  function drawEdgeGoal(){
    if(m3.state==='done') return;
    if(localStorage.getItem(M2_KEY)!=='done') return;
    const g = goalRectTier1();
    const S=api.DRAW, t=api.TILE;
    const ctx=document.getElementById('game').getContext('2d');
    const pulse = 0.45 + 0.25*Math.sin(performance.now()/250);
    ctx.save();
    ctx.fillStyle = `rgba(255,210,63,${pulse})`;
    for(let gx=g.x0; gx<=g.x1; gx++){
      const sx=w2sX(gx*t), sy=w2sY(g.gy*t);
      ctx.fillRect(sx+S*0.08, sy+S*0.08, S*0.84, S*0.84);
    }
    ctx.restore();
  }

  function drawCarOverlay(){
    if(!m3.driving || !m3.car) return;
    const ctx=document.getElementById('game').getContext('2d');
    const S=api.DRAW;
    const sx=w2sX(m3.car.x), sy=w2sY(m3.car.y);
    ctx.save();
    ctx.fillStyle='#c0c8d8';
    ctx.fillRect(sx+S*0.10, sy+S*0.25, S*0.80, S*0.50);
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
    // Ask core to expand the map
    localStorage.setItem(MAP_TIER_KEY, '2');
    toast('Mission 3 complete! New district unlocked & pistols enabled.');
  }

  function startDriving(fromCar){
    // Remove that traffic car
    const idx = (api.cars||[]).indexOf(fromCar);
    if(idx>=0) api.cars.splice(idx,1);

    // Spawn “driver” who walks away
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

    // Visual car follows the player
    m3.car = { x: api.player.x, y: api.player.y };
    m3.driving = true;
    setM3State('active');

    // Make the *player* move at car speed so joystick works & collisions stay correct
    if(m3._savedWalkSpeed==null) m3._savedWalkSpeed = api.player.speed;
    api.player.speed = CAR_SPEED;

    toast('You hijacked a car! Drive to the glowing edge.');
  }

  function stopDriving(){
    m3.driving=false; m3.car=null;
    if(m3._savedWalkSpeed!=null){ api.player.speed = m3._savedWalkSpeed; m3._savedWalkSpeed=null; }
  }

  // ---------- Input ----------
  function nearestCar(){
    let best=null, bestD=1e9;
    for(const c of api.cars||[]){
      const d = Math.hypot((api.player.x - c.x),(api.player.y - c.y));
      if(d<bestD){ best=c; bestD=d; }
    }
    return best && bestD<=HIJACK_RADIUS ? best : null;
  }

  function nearStart(){
    const {gx,gy}=playerGrid();
    return (Math.abs(gx-m3.gx)+Math.abs(gy-m3.gy))<=1;
  }

  function onB(){
    // Only after M2 done
    if(localStorage.getItem(M2_KEY)!=='done') return;
    if(m3.state==='done') return;

    if(m3.state==='ready' && nearStart()){
      startModal(()=>{ setM3State('active'); toast('Find a car and press B to hijack it.'); });
      return;
    }

    if(m3.state==='active' && !m3.driving){
      const c=nearestCar();
      if(c){ startDriving(c); }
      else if(nearStart()){
        setM3State('ready'); toast('Mission 3 cancelled.');
      }
    }
  }

  // ---------- Driving update (joystick-powered) ----------
  function updateDriving(dt){
    if(!m3.driving || !m3.car) return;

    // Car simply follows the (now-fast) player — this preserves collisions & unlocked checks.
    m3.car.x = api.player.x;
    m3.car.y = api.player.y;

    // If pushing into the glowing edge on the main road, finish + expand.
    const g = goalRectTier1();
    const t = api.TILE;
    const gx = Math.floor(api.player.x/t);
    const gy = Math.floor(api.player.y/t);

    const inGoalStripe = (gy===g.gy) && (gx>=g.x0 && gx<=g.x1);
    const pushingOutward = _lastDX > 0; // moving toward the right edge

    if(inGoalStripe && pushingOutward){
      // Expand and give a tiny nudge into the new district so it "feels" like you drove through
      completeM3();
      // small nudge right; core will widen on the next frame
      api.player.x += EXPAND_NUDGE_T * t;
      stopDriving();
    }
  }

  // ---------- Hooks ----------
  IZZA.on('ready', (a)=>{
    api=a;
    loadPos();

    // Bind B for keyboard + mobile button
    window.addEventListener('keydown', e=>{ if((e.key||'').toLowerCase()==='b') onB(); });
    const btnB=document.getElementById('btnB');
    if(btnB) btnB.addEventListener('click', onB);

    _prevPX = api.player.x;
    _prevPY = api.player.y;

    console.log('[M3] ready', { state:m3.state, start:{gx:m3.gx, gy:m3.gy} });
  });

  // capture player delta *after* core movement each tick
  IZZA.on('update-pre', ()=>{
    _prevPX = api.player.x;
    _prevPY = api.player.y;
  });

  IZZA.on('update-post', ({dtSec})=>{
    _lastDX = api.player.x - _prevPX;
    _lastDY = api.player.y - _prevPY;
    if(m3.driving) updateDriving(dtSec||0);
  });

  IZZA.on('render-post', ()=>{
    drawStartSquare();
    drawEdgeGoal();
    drawCarOverlay();
  });

})();
