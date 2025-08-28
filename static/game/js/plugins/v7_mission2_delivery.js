// /static/game/js/plugins/v7_mission2_delivery.js
(function(){
  const BUILD = 'v7.4-mission2-delivery+shop-inject+carry-visual+tester-reset';
  console.log('[IZZA PLAY]', BUILD);

  // ---------- Config ----------
  const DURATION_MS = 30_000;                 // 30 seconds
  const START_KEY   = 'izzaMission2';         // 'ready' | 'active' | 'done'
  const POS_KEY     = 'izzaMission2Pos';      // JSON: {gx,gy}
  const POS_VER_KEY = 'izzaMission2PosVer';   // bump to force new default to apply
  const POS_VERSION = '3';                    // ← bumped
  const BUBBLE_ID   = 'm2TimerBubble';

  // ✅ New default: 12 tiles LEFT and 12 tiles UP from outdoor spawn
  const DEFAULT_OFFSET_TILES = { dx: -12, dy: -12 };

  // ---------- Locals ----------
  let api = null;
  let mission = {
    state: localStorage.getItem(START_KEY) || 'ready', // ready | active | done
    goalGX: 0, goalGY: 0,           // grid position of blue square
    endAt: 0,                       // ms (performance.now)
    carrying: false                 // holding the package?
  };

  // expose for quick tuning in console
  window._izza_m2 = mission;

  // ---------- Small utilities ----------
  const now = ()=> performance.now();

  function toast(msg, seconds=2.8){
    let h = document.getElementById('tutHint');
    if(!h){
      h = document.createElement('div');
      h.id='tutHint';
      Object.assign(h.style,{
        position:'fixed', left:'12px', top:'64px', zIndex:9,
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

  function manhattan(px,py, qx,qy){ return Math.abs(px-qx) + Math.abs(py-qy); }

  function playerGrid(){
    const t = api.TILE;
    return {
      gx: Math.floor((api.player.x + t/2) / t),
      gy: Math.floor((api.player.y + t/2) / t)
    };
  }

  // ---------- Timer bubble ----------
  function ensureTimerBubble(){
    let b = document.getElementById(BUBBLE_ID);
    if(!b){
      b = document.createElement('div');
      b.id=BUBBLE_ID;
      Object.assign(b.style,{
        position:'fixed', right:'18px', top:'98px', zIndex:8,
        background:'rgba(7,12,22,.85)', color:'#cfe0ff',
        border:'1px solid #2f3b58', borderRadius:'18px',
        padding:'6px 10px', fontSize:'12px', minWidth:'42px',
        textAlign:'center', pointerEvents:'none'
      });
      document.body.appendChild(b);
    }
    return b;
  }
  function showTimer(msLeft){
    const el = ensureTimerBubble();
    el.textContent = (msLeft/1000).toFixed(1)+'s';
    el.style.display='block';
  }
  function hideTimer(){
    const el = document.getElementById(BUBBLE_ID);
    if(el) el.style.display='none';
  }

  // ---------- Modal ----------
  function missionModal(onStart){
    let host = document.getElementById('m2Modal');
    if(!host){
      host = document.createElement('div');
      host.id='m2Modal';
      host.className='backdrop';
      Object.assign(host.style,{
        position:'fixed', inset:'0', display:'flex', alignItems:'center', justifyContent:'center',
        background:'rgba(0,0,0,.35)', zIndex:10
      });
      host.innerHTML = `
        <div style="background:#0f1625;border:1px solid #2a3550;border-radius:12px; padding:14px 16px; width:min(92vw,420px)">
          <div style="font-weight:700; font-size:16px; margin-bottom:6px">Mission 2</div>
          <div style="opacity:.9; line-height:1.45">
            Go pick up a <b>Package</b> from the shop and bring it back here.<br>
            <b>You have 30 seconds.</b>
          </div>
          <div style="display:flex; gap:8px; justify-content:flex-end; margin-top:12px">
            <button id="m2Cancel" class="ghost">Cancel</button>
            <button id="m2Start">Start</button>
          </div>
        </div>`;
      document.body.appendChild(host);
      host.addEventListener('click', e=>{ if(e.target===host) host.style.display='none'; });
      host.querySelector('#m2Cancel').addEventListener('click', ()=> host.style.display='none');
      host.querySelector('#m2Start').addEventListener('click', ()=>{
        host.style.display='none';
        onStart && onStart();
      });
    }
    host.style.display='flex';
  }

  // ---------- Shop injection ----------
  function svgPackage(w=24,h=24){
    return `<svg viewBox="0 0 64 64" width="${w}" height="${h}">
      <rect x="16" y="20" width="32" height="28" rx="3" ry="3" fill="#6b7da5"/>
      <rect x="16" y="20" width="32" height="10" fill="#8aa0cf"/>
      <rect x="30" y="20" width="4" height="28" fill="#d9e2ff"/>
    </svg>`;
  }

  function injectPackageItem(){
    if(mission.state!=='active' || mission.carrying) return;
    const list = document.getElementById('shopList');
    if(!list) return;

    if(list.querySelector('[data-m2-package]')) return;

    const row = document.createElement('div');
    row.className='shop-item';
    row.setAttribute('data-m2-package','1');
    row.innerHTML = `
      <div class="meta">
        <div style="display:flex; align-items:center; gap:8px">
          <div>${svgPackage()}</div>
          <div>
            <div class="name">Package</div>
            <div class="sub">FREE</div>
          </div>
        </div>
      </div>
      <button class="buy">Take</button>
    `;
    row.querySelector('.buy').addEventListener('click', ()=>{
      mission.carrying = true;
      toast('Picked up Package');
      const sm = document.getElementById('shopModal');
      if(sm) sm.style.display='none';
    });

    list.insertBefore(row, list.firstChild || null);
  }

  const shopObs = new MutationObserver(()=>{
    const sm = document.getElementById('shopModal');
    if(!sm) return;
    const visible = sm.style.display==='flex' || sm.style.display==='block';
    if(visible) setTimeout(injectPackageItem, 0);
  });

  // ---------- Drawing ----------
  function w2sX(wx){ return (wx - api.camera.x) * (api.DRAW/api.TILE); }
  function w2sY(wy){ return (wy - api.camera.y) * (api.DRAW/api.TILE); }

  function drawGoal(){
    if(mission.state==='done') return;
    const gx = mission.goalGX, gy = mission.goalGY, t=api.TILE;
    const sx = w2sX(gx*t), sy = w2sY(gy*t);
    const S  = api.DRAW;
    const ctx = document.getElementById('game').getContext('2d');
    ctx.save();
    ctx.fillStyle = 'rgba(70,140,255,.75)';
    ctx.fillRect(sx + S*0.15, sy + S*0.15, S*0.70, S*0.70);
    ctx.restore();
  }

  function drawCarry(){
    if(!mission.carrying) return;
    const S = api.DRAW;
    const px = w2sX(api.player.x), py = w2sY(api.player.y);
    const ctx = document.getElementById('game').getContext('2d');
    ctx.save();
    ctx.fillStyle = '#6b7da5';
    if(api.player.facing==='down'){
      ctx.fillRect(px + S*0.52, py + S*0.60, S*0.24, S*0.20);
    }else if(api.player.facing==='up'){
      ctx.fillRect(px + S*0.22, py + S*0.24, S*0.24, S*0.20);
    }else if(api.player.facing==='left'){
      ctx.fillRect(px + S*0.16, py + S*0.56, S*0.24, S*0.20);
    }else{
      ctx.fillRect(px + S*0.60, py + S*0.56, S*0.24, S*0.20);
    }
    ctx.restore();
  }

  // ---------- Positioning ----------
  function loadGoalPosition(){
    // 1) explicit override (wins)
    if(window.__IZZA_M2_POS__ && Number.isFinite(window.__IZZA_M2_POS__.gx)){
      mission.goalGX = window.__IZZA_M2_POS__.gx|0;
      mission.goalGY = window.__IZZA_M2_POS__.gy|0;
      localStorage.setItem(POS_KEY, JSON.stringify({gx:mission.goalGX, gy:mission.goalGY}));
      localStorage.setItem(POS_VER_KEY, POS_VERSION);
      return;
    }
    // 2) saved AND matches this file's version
    const savedVer = localStorage.getItem(POS_VER_KEY);
    const saved = localStorage.getItem(POS_KEY);
    if(saved && savedVer === POS_VERSION){
      try{
        const j = JSON.parse(saved);
        if(Number.isFinite(j.gx) && Number.isFinite(j.gy)){
          mission.goalGX=j.gx|0; mission.goalGY=j.gy|0;
          return;
        }
      }catch{}
    }
    // 3) default relative to door spawn
    const t = api.TILE;
    const doorGX = Math.floor((api.doorSpawn.x + 8)/t);
    const doorGY = Math.floor(api.doorSpawn.y/t);
    mission.goalGX = doorGX + DEFAULT_OFFSET_TILES.dx;
    mission.goalGY = doorGY + DEFAULT_OFFSET_TILES.dy;
    localStorage.setItem(POS_KEY, JSON.stringify({gx:mission.goalGX, gy:mission.goalGY}));
    localStorage.setItem(POS_VER_KEY, POS_VERSION);
  }

  // Console helpers
  window._izza_m2_setAtPlayer = function(){
    const {gx,gy} = playerGrid();
    mission.goalGX = gx; mission.goalGY = gy;
    localStorage.setItem(POS_KEY, JSON.stringify({gx,gy}));
    localStorage.setItem(POS_VER_KEY, POS_VERSION);
    toast(`Mission 2 anchor set to ${gx},${gy}`);
  };
  window._izza_m2_resetPos = function(){
    localStorage.removeItem(POS_KEY);
    localStorage.setItem(POS_VER_KEY, POS_VERSION);
    loadGoalPosition();
    toast('Mission 2 anchor reset to default.');
  };

  // ---------- Mission state helpers ----------
  function getMissionCount(){ return (api && api.getMissionCount) ? api.getMissionCount() : 0; }
  function setMission2Done(){
    localStorage.setItem(START_KEY, 'done');
    mission.state = 'done';
    try{
      const cur = getMissionCount();
      const next = Math.max(cur, 2);
      localStorage.setItem('izzaMissions', String(next));
    }catch{}
  }

  function startMission(){
    mission.state   = 'active';
    mission.carrying= false;
    mission.endAt   = now() + DURATION_MS;
    localStorage.setItem(START_KEY, 'active');
    showTimer(mission.endAt - now());
    toast('Mission 2 started! Get the Package at the shop.');
  }

  function failMission(){
    mission.state   = 'ready';
    mission.carrying= false;
    mission.endAt   = 0;
    localStorage.setItem(START_KEY, 'ready');
    hideTimer();
    toast('Time up! Mission failed.');
  }

  function completeMission(){
    setMission2Done();
    mission.carrying=false;
    mission.endAt=0;
    hideTimer();
    toast('Mission 2 complete!');
  }

  // ---------- Input: B key / button ----------
  function nearGoal(){
    const {gx,gy} = playerGrid();
    return manhattan(gx,gy, mission.goalGX, mission.goalGY) <= 1;
  }

  function onB(){
    if(mission.state==='done') return;

    if(nearGoal()){
      if(mission.state==='ready'){
        if(getMissionCount() < 1){ toast('Finish the tutorial first.'); return; }
        missionModal(startMission);
        return;
      }
      if(mission.state==='active' && mission.carrying){
        if(now() <= mission.endAt) completeMission();
        else failMission();
        return;
      }
    }
  }

  function bindB(){
    window.addEventListener('keydown', (e)=>{
      if(e.key && e.key.toLowerCase()==='b'){ onB(); }
    });
    const btnB = document.getElementById('btnB');
    if(btnB){ btnB.addEventListener('click', onB); }
  }

  // ---------- Testing button (temporary) ----------
  function ensureResetButton(){
    let btn = document.getElementById('m2ResetBtn');
    if(btn) return btn;
    btn = document.createElement('button');
    btn.id = 'm2ResetBtn';
    btn.textContent = 'M2 Reset';
    Object.assign(btn.style,{
      position:'fixed', right:'18px', top:'138px', zIndex:9,
      background:'#1a2336', color:'#cfe0ff', border:'1px solid #33415f',
      borderRadius:'10px', padding:'6px 10px', fontSize:'12px'
    });
    btn.addEventListener('click', ()=>{
      // reset to default position & mission state ready
      localStorage.removeItem(POS_KEY);
      localStorage.setItem(POS_VER_KEY, POS_VERSION);
      loadGoalPosition();
      mission.state='ready';
      mission.carrying=false;
      mission.endAt=0;
      localStorage.setItem(START_KEY,'ready');
      hideTimer();
      toast(`Mission 2 reset. Goal: ${mission.goalGX},${mission.goalGY}`);
    });
    document.body.appendChild(btn);
    return btn;
  }

  // ---------- Hook into game ----------
  IZZA.on('ready', (a)=>{
    api = a;

    loadGoalPosition();

    const root = document.body || document.documentElement;
    shopObs.observe(root, { attributes:true, childList:true, subtree:true });

    bindB();

    // Testing reset button (remove later if desired)
    ensureResetButton();

    if(mission.state==='done'){ hideTimer(); }

    console.log('[M2] ready', {
      state: mission.state, goal: {gx:mission.goalGX, gy:mission.goalGY}
    });
  });

  // Update countdown
  IZZA.on('update-post', ()=>{
    if(mission.state!=='active') return;
    const left = mission.endAt - now();
    if(left <= 0){ failMission(); return; }
    showTimer(left);
  });

  // Draw overlays after core renders
  IZZA.on('render-post', ()=>{
    if(mission.state!=='done') drawGoal();
    drawCarry();
  });

})();
