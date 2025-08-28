// /static/game/js/plugins/v6_mission2.js
(function(){
  const BUILD = 'v6.0-mission2+package+timer+blueSquare';
  console.log('[IZZA M2]', BUILD);

  // ==== local storage keys (mirror core naming) ====
  const LS = {
    missions : 'izzaMissions',
    mission1 : 'izzaMission1',
    mission2 : 'izzaMission2'
  };

  // ==== internal state ====
  let api=null, player=null, TILE=32, DRAW=96, camera=null;

  // Mission 2 runtime state (not all persisted)
  const m2 = {
    spawned: false,    // blue square placed
    gx: 0, gy: 0,      // mission square tile
    active: false,     // timer running
    startAt: 0,        // ms
    dueAt: 0,          // ms
    carrying: false,   // has the package in hands
    done: false        // completed & persisted
  };

  // ==== utils ====
  const now = ()=> performance.now();
  const getMissions = ()=> parseInt(localStorage.getItem(LS.missions) || (localStorage.getItem(LS.mission1)==='done' ? '1' : '0'), 10);
  const setMissionsAtLeast = (n)=>{
    const cur = getMissions();
    if(cur < n) localStorage.setItem(LS.missions, String(n));
  };
  const markM2Done = ()=>{
    localStorage.setItem(LS.mission2, 'done');
    setMissionsAtLeast(2);
    m2.done=true;
  };
  const m2AlreadyDone = ()=> localStorage.getItem(LS.mission2) === 'done';

  const pxToGX = (px)=> Math.floor((px + TILE/2)/TILE);
  const pxToGY = (py)=> Math.floor((py + TILE/2)/TILE);

  // screen coords
  const w2sX = (wx)=> (wx - camera.x) * (DRAW/TILE);
  const w2sY = (wy)=> (wy - camera.y) * (DRAW/TILE);

  // simple toast (reuse the same look core uses)
  function toast(msg, seconds=2.4){
    let h = document.getElementById('tutHint');
    if(!h){
      h = document.createElement('div');
      h.id='tutHint';
      Object.assign(h.style,{
        position:'fixed', left:'12px', top:'64px', zIndex:9998,
        background:'rgba(10,12,18,.85)', border:'1px solid #394769',
        color:'#cfe0ff', padding:'8px 10px', borderRadius:'10px', fontSize:'14px'
      });
      document.body.appendChild(h);
    }
    h.textContent = msg; h.style.display='block';
    clearTimeout(h._t);
    h._t = setTimeout(()=>{ h.style.display='none'; }, seconds*1000);
  }

  // ===== UI bits =====
  // Mission modal
  let m2Modal=null;
  function ensureM2Modal(){
    if(m2Modal) return m2Modal;
    const el = document.createElement('div');
    el.id='m2Modal';
    el.className='backdrop';
    Object.assign(el.style,{
      display:'none', position:'fixed', inset:0, background:'rgba(0,0,0,.55)',
      zIndex:10000, alignItems:'center', justifyContent:'center'
    });
    el.innerHTML = `
      <div style="min-width:280px;max-width:92vw;background:#121827;border:1px solid #2a3550;border-radius:12px;padding:14px">
        <div style="font-weight:700;margin-bottom:8px">Mission 2</div>
        <div style="opacity:.9;font-size:14px;line-height:1.35">
          Go pick up a <b>Package</b> from the shop and bring it back here.<br>
          <b>You have 30 seconds.</b>
        </div>
        <div style="margin-top:12px;display:flex;gap:8px;justify-content:flex-end">
          <button id="m2Cancel" class="ghost">Cancel</button>
          <button id="m2Start"  class="primary">Start</button>
        </div>
      </div>`;
    el.addEventListener('click', (e)=>{ if(e.target===el) el.style.display='none'; });
    document.body.appendChild(el);

    el.querySelector('#m2Cancel').addEventListener('click', ()=> el.style.display='none');
    el.querySelector('#m2Start').addEventListener('click', ()=>{
      el.style.display='none';
      startMission2();
    });

    m2Modal = el;
    return el;
  }

  // Timer pill
  let timerPill=null;
  function ensureTimerPill(){
    if(timerPill) return timerPill;
    const el = document.createElement('div');
    Object.assign(el.style,{
      position:'fixed', right:'12px', top:'48px', zIndex:9999,
      background:'rgba(10,12,18,.92)', border:'1px solid #394769',
      color:'#cfe0ff', padding:'6px 9px', borderRadius:'999px',
      fontSize:'12px', display:'none'
    });
    el.id='m2TimerPill';
    el.textContent = '30.0s';
    document.body.appendChild(el);
    timerPill = el;
    return el;
  }
  function updateTimerPill(){
    if(!m2.active){ if(timerPill) timerPill.style.display='none'; return; }
    const el = ensureTimerPill();
    const remaining = Math.max(0, m2.dueAt - now());
    el.textContent = (remaining/1000).toFixed(1) + 's';
    el.style.display = 'block';
  }

  // Inject "Package (FREE)" in the shop when active and not yet carrying
  let packageRowInjected=false;
  function maybeInjectPackageIntoShop(){
    if(!m2.active || m2.carrying || m2.done) return;
    const list = document.getElementById('shopList');
    const modal = document.getElementById('shopModal');
    if(!list || !modal || modal.style.display==='none') return;
    if(packageRowInjected) return;

    const row = document.createElement('div');
    row.className='shop-item';
    row.innerHTML = `
      <div class="meta">
        <div style="display:flex; align-items:center; gap:8px">
          <div>
            <svg viewBox="0 0 64 64" width="24" height="24">
              <rect x="18" y="22" width="28" height="20" fill="#b58b55"></rect>
              <rect x="18" y="20" width="28" height="6"  fill="#a17a4a"></rect>
              <rect x="30" y="18" width="4"  height="28" fill="#6a4d2e"></rect>
            </svg>
          </div>
          <div>
            <div class="name">Package</div>
            <div class="sub">FREE</div>
          </div>
        </div>
      </div>
      <button class="buy">Take</button>
    `;
    row.querySelector('.buy').addEventListener('click', ()=>{
      // pick the package
      m2.carrying = true;
      toast('Picked up the Package');
      // close the shop (same behavior as clicking backdrop)
      const sm = document.getElementById('shopModal');
      if(sm) sm.style.display='none';
    });

    list.appendChild(row);
    packageRowInjected = true;
  }

  // ==== draw the blue square and the carried package ====
  function drawBlueSquare(){
    if(!m2.spawned || m2.done) return;
    const ctx = document.getElementById('game')?.getContext('2d'); if(!ctx) return;
    const S = DRAW;
    const dx = w2sX(m2.gx*TILE);
    const dy = w2sY(m2.gy*TILE);
    ctx.save();
    ctx.fillStyle = 'rgba(64, 156, 255, 0.65)';
    ctx.fillRect(dx + S*0.15, dy + S*0.15, S*0.70, S*0.70);
    ctx.strokeStyle = 'rgba(64, 156, 255, 0.95)';
    ctx.lineWidth = Math.max(2, S*0.03);
    ctx.strokeRect(dx + S*0.15, dy + S*0.15, S*0.70, S*0.70);
    ctx.restore();
  }

  function drawCarriedPackage(){
    if(!m2.carrying || m2.done) return;
    const ctx = document.getElementById('game')?.getContext('2d'); if(!ctx) return;
    const S  = DRAW;
    const sx = w2sX(player.x);
    const sy = w2sY(player.y);
    ctx.save();
    ctx.fillStyle = '#b58b55';

    // place near the hands based on facing (simple block)
    if(player.facing==='down')      ctx.fillRect(sx + S*0.50, sy + S*0.65, S*0.22, S*0.18);
    else if(player.facing==='up')   ctx.fillRect(sx + S*0.18, sy + S*0.22, S*0.22, S*0.18);
    else if(player.facing==='left') ctx.fillRect(sx + S*0.12, sy + S*0.55, S*0.22, S*0.18);
    else                            ctx.fillRect(sx + S*0.62, sy + S*0.55, S*0.22, S*0.18);

    ctx.fillStyle = '#6a4d2e';
    ctx.fillRect(sx + S*0.02 + (player.facing==='up'?S*0.18:S*0.50),
                 sy + S*0.02 + (player.facing==='up'?S*0.22:S*0.65),
                 S*0.04, S*0.18);
    ctx.restore();
  }

  // ==== mission logic ====
  function readyToSpawnSquare(){
    // Spawn once Mission 1 is completed and Mission 2 not yet done
    return !m2.spawned && !m2.done && (localStorage.getItem(LS.mission1)==='done' || getMissions()>=1);
  }

  function spawnSquareAtPlayer(){
    m2.gx = pxToGX(player.x);
    m2.gy = pxToGY(player.y);
    m2.spawned = true;
    console.log('[M2] square spawned at', m2.gx, m2.gy);
  }

  function nearMissionSquare(){
    if(!m2.spawned || m2.done) return false;
    const px = pxToGX(player.x);
    const py = pxToGY(player.y);
    return (Math.abs(px - m2.gx) + Math.abs(py - m2.gy)) <= 1;
  }

  function openM2Dialog(){
    if(m2.done) return;
    ensureM2Modal().style.display='flex';
  }

  function startMission2(){
    m2.active = true;
    m2.carrying = false;
    m2.startAt = now();
    m2.dueAt   = m2.startAt + 30_000;
    packageRowInjected = false; // allow injection on next shop open
    toast('Mission 2 started! 30s on the clock.');
  }

  function tryDeliver(){
    if(!m2.active || !m2.carrying) return;
    if(now() <= m2.dueAt){
      toast('Mission 2 complete!');
      m2.active=false; m2.carrying=false;
      markM2Done();
    }else{
      toast('Too late! Mission failed.');
      m2.active=false; m2.carrying=false;
      // square remains; you can restart by pressing B again
    }
  }

  // Intercept B when relevant (keyboard)
  function onKeyDown(e){
    if((e.key||'').toLowerCase() !== 'b') return;
    // When near square: open/start/deliver and eat the event so core's B handler doesn't run.
    if(nearMissionSquare()){
      e.preventDefault(); e.stopImmediatePropagation();
      if(m2.active && m2.carrying){ tryDeliver(); }
      else if(!m2.active){ openM2Dialog(); }
    }else if(m2.active && m2.carrying){
      // If carrying but not at square, let core B do its normal things.
    }
  }

  // Intercept on-screen B button
  function attachBtnBInterceptor(){
    const btnB = document.getElementById('btnB');
    if(!btnB || btnB._m2Bound) return;
    btnB.addEventListener('click', (e)=>{
      if(nearMissionSquare()){
        e.preventDefault(); e.stopImmediatePropagation();
        if(m2.active && m2.carrying){ tryDeliver(); }
        else if(!m2.active){ openM2Dialog(); }
      }
    }, true); // capture to run before core's listener
    btnB._m2Bound = true;
  }

  // ==== hooks to core loop ====
  IZZA.on('ready', (a)=>{
    api=a; player=a.player; TILE=a.TILE; DRAW=a.DRAW; camera=a.camera;
    m2.done = m2AlreadyDone();
    window._izza_m2 = m2; // for quick debugging
    window.addEventListener('keydown', onKeyDown, true); // capture
    attachBtnBInterceptor();
  });

  IZZA.on('update-post', ()=>{
    if(!api) return;

    // Spawn blue square right after mission 1 completes (one-time)
    if(readyToSpawnSquare()) spawnSquareAtPlayer();

    // Handle timer expiration
    if(m2.active && now() > m2.dueAt){
      toast('Time up! Mission failed.');
      m2.active=false; m2.carrying=false;
    }

    // If shop is open and mission active, inject the Package row
    maybeInjectPackageIntoShop();

    // Keep the B-button interceptor attached (in case DOM re-renders)
    attachBtnBInterceptor();

    // Update timer UI (if active)
    updateTimerPill();
  });

  IZZA.on('render-post', ()=>{
    drawBlueSquare();
    drawCarriedPackage();
  });
})();
