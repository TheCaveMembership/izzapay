// /static/game/js/plugins/v8_mission3_car_theft.js
(function(){
  const BUILD = 'v9.0-mission3-car-theft+vehicular-hits+vehicleSprites+larger';
  console.log('[IZZA PLAY]', BUILD);

  const M2_KEY       = 'izzaMission2';
  const M3_KEY       = 'izzaMission3';
  const POS_KEY      = 'izzaMission3Pos';
  const POS_VER_KEY  = 'izzaMission3PosVer';
  const POS_VERSION  = '1';
  const MAP_TIER_KEY = 'izzaMapTier';

  const DEFAULT_OFFSET_TILES = { dx: -8, dy: 0 };

  const HIJACK_RADIUS = 22;
  const CAR_SPEED     = 120;
  const CAR_HIT_RADIUS= 24;
  const DROP_GRACE_MS = 1000;
  const DROP_OFFSET   = 18;

  // Slightly larger visual scale for vehicles (centered)
  const VEH_DRAW_SCALE = 1.15; // 15% bigger than 32×32 tile draw

  const PARK_MS = 5*60*1000;
  const _m3Parked = []; // {x,y,kind,timeoutId}

  // ---- vehicle sprite loader (shared cache) ----
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

  let api = null;
  const m3 = {
    state: localStorage.getItem(M3_KEY) || 'ready',
    gx: 0, gy: 0,
    driving: false,
    car: null,            // {x,y,kind}
    _savedWalkSpeed: null
  };

  function toast(msg, seconds=2.4){
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
    return { gx: Math.floor((api.player.x + t/2)/t), gy: Math.floor((api.player.y + t/2)/t) };
  }
  function _dropPos(vx,vy){
    const dx = vx - api.player.x, dy = vy - api.player.y;
    const m  = Math.hypot(dx,dy) || 1;
    return { x: vx + (dx/m)*DROP_OFFSET, y: vy + (dy/m)*DROP_OFFSET };
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
    const t=api.TILE;
    const doorGX = Math.floor((api.doorSpawn.x + 8)/t);
    const doorGY = Math.floor(api.doorSpawn.y/t);
    m3.gx = doorGX + DEFAULT_OFFSET_TILES.dx;
    m3.gy = doorGY + DEFAULT_OFFSET_TILES.dy;
    localStorage.setItem(POS_KEY, JSON.stringify({gx:m3.gx, gy:m3.gy}));
    localStorage.setItem(POS_VER_KEY, POS_VERSION);
  }
  window._izza_m3_here = function(){
    const {gx,gy}=playerGrid();
    m3.gx=gx; m3.gy=gy;
    localStorage.setItem(POS_KEY, JSON.stringify({gx,gy}));
    localStorage.setItem(POS_VER_KEY, POS_VERSION);
    toast(`Mission 3 start set to ${gx},${gy}`);
  };

  // ---------- UI ----------
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
            Then drive into the <b>glowing gold edge</b>.
          </div>
          <div style="display:flex; gap:8px; justify-content:flex-end; margin-top:12px">
            <button id="m3Cancel" class="ghost">Cancel</button>
            <button id="m3Start">Start</button>
          </div>
          <div style="opacity:.7; font-size:12px; margin-top:6px">
            Drive with the joystick (or WASD/Arrows). Same controls, just faster.
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

  // ---------- Geometry ----------
  function unlockedRectTier1(){ return { x0:18, y0:18, x1:72, y1:42 }; }
  function roadGyTier1(){
    const u = unlockedRectTier1();
    const bW=10, bH=6;
    const bX = Math.floor((u.x0+u.x1)/2) - Math.floor(bW/2);
    const bY = u.y0 + 5;
    return bY + bH + 1;
  }
  function goalRectTier1(){
    const u = unlockedRectTier1();
    const gy = roadGyTier1();
    return { x0: u.x1-1, x1: u.x1, gy };
  }

  // ---------- Drawing helpers ----------
  function w2sX(wx){ return (wx - api.camera.x) * (api.DRAW/api.TILE); }
  function w2sY(wy){ return (wy - api.camera.y) * (api.DRAW/api.TILE); }
  function drawVehicleSprite(kind, wx, wy){
    const ctx=document.getElementById('game').getContext('2d');
    const sheets = (window.VEHICLE_SHEETS||{});
    const S=api.DRAW;
    const sx=w2sX(wx), sy=w2sY(wy);

    // upscale a bit and center the sprite
    const dS = S*VEH_DRAW_SCALE;
    const off = (dS - S)/2;

    if(sheets[kind] && sheets[kind].img){
      ctx.save();
      ctx.imageSmoothingEnabled=false;
      ctx.drawImage(sheets[kind].img, 0,0,32,32, sx-off, sy-off, dS, dS);
      ctx.restore();
    }else{
      // fallback rect also scaled
      ctx.fillStyle='#c0c8d8';
      ctx.fillRect(sx + S*0.10 - off, sy + S*0.25 - off, S*0.80*VEH_DRAW_SCALE, S*0.50*VEH_DRAW_SCALE);
    }
  }

  function drawStartSquare(){
    if(m3.state==='done') return;
    if(localStorage.getItem(M2_KEY)!=='done') return;
    const t=api.TILE;
    const sx=w2sX(m3.gx*t), sy=w2sY(m3.gy*t);
    const S=api.DRAW, ctx=document.getElementById('game').getContext('2d');
    ctx.save();
    ctx.fillStyle='rgba(0,190,255,.80)';
    ctx.fillRect(sx+S*0.15, sy+S*0.15, S*0.70, S*0.70);
    ctx.restore();
  }
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
    drawVehicleSprite(m3.car.kind || 'sedan', m3.car.x, m3.car.y);
  }

  // ---------- Mission helpers ----------
  function setM3State(s){ m3.state=s; localStorage.setItem(M3_KEY, s); }

  function _parkCarAt(x,y,kind){
    const entry = { x, y, kind: kind||'sedan', timeoutId: null };
    entry.timeoutId = setTimeout(()=>{
      const idx = _m3Parked.indexOf(entry);
      if(idx>=0) _m3Parked.splice(idx,1);
      (api.cars||[]).push({ x, y, dir:(Math.random()<0.5?-1:1), spd:120, kind: entry.kind });
    }, PARK_MS);
    _m3Parked.push(entry);
  }

  function completeM3(){
    setM3State('done');

    if(m3.driving){
      _parkCarAt(api.player.x, api.player.y, m3.car && m3.car.kind);
    }
    m3.driving=false; m3.car=null;
    if(m3._savedWalkSpeed!=null){ api.player.speed = m3._savedWalkSpeed; m3._savedWalkSpeed=null; }

    try{
      const cur = (api.getMissionCount && api.getMissionCount()) || 0;
      localStorage.setItem('izzaMissions', String(Math.max(cur,3)));
    }catch{}

    localStorage.setItem(MAP_TIER_KEY, '2');
    localStorage.setItem('izzaMapLayoutBuild', 'clip_safe_v2');
    setTimeout(()=> {
      if(!window.__IZZA_SUPPRESS_TIER2_RELOAD){
        location.reload();
      }
    }, 80);

    toast('Mission 3 complete! New district unlocked & pistols enabled.');
  }

  function startDriving(fromCar){
    const idx = (api.cars||[]).indexOf(fromCar);
    if(idx>=0) api.cars.splice(idx,1);

    // eject driver
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

    // keep exact kind the player hijacked; fallback random if traffic lacked kind
    const hijackKind = fromCar.kind || pickRandomKind();
    m3.car  = { x: api.player.x, y: api.player.y, kind: hijackKind };
    m3.driving = true;
    setM3State('active');

    if(m3._savedWalkSpeed==null) m3._savedWalkSpeed = api.player.speed;
    api.player.speed = CAR_SPEED;

    // NEW: lock to exactly 2★ on hijack and cap active chasers to 2 for a short grace period
    m3._hijackGraceUntil = performance.now() + 1200;
    while ((api.cops||[]).length > 2) api.cops.pop();

    toast(`You hijacked a ${hijackKind}! Drive to the glowing edge.`);
  }
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
  function onB(e){
    if(localStorage.getItem(M2_KEY)!=='done') return;
    if(m3.state==='done') return;

    if(m3.state==='ready' && nearStart()){
      startModal(()=>{ setM3State('active'); toast('Find a car and press B to hijack it.'); });
      return;
    }
    if(m3.state==='active' && !m3.driving){
      const c=nearestCar();
      if(c){ startDriving(c); }
      else if(nearStart()){ setM3State('ready'); toast('Mission 3 cancelled.'); }
    }
  }

  // Vehicular impact logic
  function handleVehicularHits(){
    if(!m3.driving) return;
    const px = api.player.x, py = api.player.y;
    const now = performance.now();

    let pedKills = 0;
    let copKills = 0;

    // pedestrians
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
        pedKills++;
      }
    }
    // cops
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
        copKills++;
      }
    }

    // Wanted logic (batched & grace-protected)
    if (pedKills > 0) {
      if (!(m3._hijackGraceUntil && now < m3._hijackGraceUntil)) {
        // at most +1★ per update frame
        api.setWanted(Math.min(5, (api.player.wanted|0) + 1));
      }
    }
    if (copKills > 0) {
      const next = Math.max(0, (api.player.wanted|0) - copKills);
      // if no chasers remain and stars should be 0, force a clean reset
      if ((api.cops||[]).length === 0 && next === 0) {
        }
    }
  }

  function updateDriving(){
    if(!m3.driving || !m3.car) return;
    m3.car.x = api.player.x;
    m3.car.y = api.player.y;

    handleVehicularHits();

    const g = goalRectTier1();
    const t = api.TILE;
    const gx = Math.floor(api.player.x/t);
    const gy = Math.floor(api.player.y/t);
    if (gy===g.gy && gx>=g.x0 && gx<=g.x1){
      completeM3();
    }
  }

  // ---------- Hooks ----------
  IZZA.on('ready', (a)=>{
    api=a;
    ensureVehicleSheets(); // fire & forget

    // ===== TEST MODE: force Mission 3 complete & Tier 2 unlocked =====
    try {
      localStorage.setItem(M2_KEY, 'done');            // ensure M2 done as well
      localStorage.setItem(M3_KEY, 'done');            // mark Mission 3 complete
      localStorage.setItem(MAP_TIER_KEY, '2');         // unlock Tier 2
      localStorage.setItem('izzaMissions', '3');       // mission count gate
      localStorage.setItem('izzaMapLayoutBuild', 'clip_safe_v2'); // match tier 2 layout
      m3.state = 'done';                                // reflect in-memory state immediately
      console.log('[M3] TEST MODE: forced mission complete + tier 2 unlocked');

      // Ensure the expanded map actually loads (one-time soft reload)
      // Prevent loops via a session marker.
      if (!window.__IZZA_SUPPRESS_TIER2_RELOAD) {
        const k='__izzaTier2Applied';
        if (!sessionStorage.getItem(k)) {
          sessionStorage.setItem(k,'1');
          setTimeout(()=>{ location.reload(); }, 60);
        }
      }
    } catch(e) {
      console.warn('[M3] test mode flagging failed', e);
    }
    // ===== /TEST MODE =====

    loadPos();

    // capture-phase so B works even with inventory/map open
    window.addEventListener('keydown', e=>{ if((e.key||'').toLowerCase()==='b') onB(e); }, {capture:true, passive:true});
    const btnB=document.getElementById('btnB'); if(btnB) btnB.addEventListener('click', onB, true);

    console.log('[M3] ready', { state:m3.state, start:{gx:m3.gx, gy:m3.gy} });
  });
  IZZA.on('update-post', ()=>{ if(m3.driving) updateDriving(); });
  IZZA.on('render-post', ()=>{
    drawStartSquare();
    drawEdgeGoal();
    drawCarOverlay();

    // draw any parked car left at mission finish (with sprites)
    if(_m3Parked.length){
      _m3Parked.forEach(p=>{
        drawVehicleSprite(p.kind || 'sedan', p.x, p.y);
      });
    }
  });

})();
