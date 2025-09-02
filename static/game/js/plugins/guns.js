// IZZA Guns (fire button, iPhone-safe, late-ready tolerant) — v2.3
(function(){
  // ---- Tunables ----
  const TUNE = {
    speedFallback: 180,     // px/s if no car present
    bulletLifeMs: 900,
    hitRadius: 16,
    pistolDelayMs: 170,     // tap cadence
    uziIntervalMs: 90       // hold-to-fire cadence
  };

  // ---- State ----
  const bullets = [];            // {x,y,vx,vy,born}
  const copHits = new WeakMap(); // hit counter per cop
  let lastPistolAt = 0;
  let uziTimer = null;
  let fireBtn = null;
  let uiTicker = null;

  // ---- Small helpers ----
  const now = ()=>performance.now();
  const closeLE = (ax,ay,bx,by,r)=> Math.hypot(ax-bx, ay-by) <= r;
  const toast = (m,c)=>{ try{ if(typeof bootMsg==='function') bootMsg(m,c); }catch{} };
  const apiReady = ()=> !!(window.IZZA && IZZA.api && IZZA.api.ready);

  // Inventory reads (works with/without IZZA.api)
  function readInventory(){
    try{
      if(apiReady()) return IZZA.api.getInventory() || {};
      const raw = localStorage.getItem('izzaInventory');
      return raw ? JSON.parse(raw) : {};
    }catch{ return {}; }
  }
  function writeInventory(inv){
    try{ if(apiReady()) IZZA.api.setInventory(inv); else localStorage.setItem('izzaInventory', JSON.stringify(inv)); }catch{}
  }

  function pistolEquipped(){
    const inv = readInventory();
    return !!(inv.pistol && inv.pistol.equipped);
  }
  function uziEquipped(){
    const inv = readInventory();
    return !!(inv.uzi && inv.uzi.equipped);
  }
  function anyGunOwned(){
    const inv = readInventory();
    return !!((inv.pistol && inv.pistol.owned) || (inv.uzi && inv.uzi.owned));
  }
  function takeAmmo(kind){
    const inv = readInventory();
    const slot = inv[kind];
    if(!slot) return false;
    const n = (slot.ammo|0);
    if(n<=0) return false;
    slot.ammo = n-1;
    writeInventory(inv);
    return true;
  }

  // Aim: stick direction if moved; else player facing
  function aimVector(){
    const nub = document.getElementById('nub');
    if(nub){
      const cs = getComputedStyle(nub);
      const left = parseFloat(nub.style.left || cs.left || '40');
      const top  = parseFloat(nub.style.top  || cs.top  || '40');
      const dx = left - 40, dy = top - 40, m = Math.hypot(dx,dy);
      if(m>2) return {x:dx/m, y:dy/m};
    }
    if(apiReady()){
      const f = IZZA.api.player.facing;
      if(f==='left')  return {x:-1,y:0};
      if(f==='right') return {x:1,y:0};
      if(f==='up')    return {x:0,y:-1};
    }
    return {x:0,y:1};
  }
  function bulletSpeed(){
    if(apiReady()){
      const cars = IZZA.api.cars;
      if(cars && cars.length) return (cars[0].spd || 120) * 1.5;
    }
    return TUNE.speedFallback;
  }
  function spawnBullet(){
    if(!apiReady()) return; // wait until game objects exist
    const p = IZZA.api.player;
    const dir = aimVector();
    const spd = bulletSpeed();
    bullets.push({
      x: p.x + 16 + dir.x*18,
      y: p.y + 16 + dir.y*18,
      vx: dir.x*spd,
      vy: dir.y*spd,
      born: now()
    });
  }

  // ---- Shooting logic ----
  function firePistol(){
    const t = now();
    if(t - lastPistolAt < TUNE.pistolDelayMs) return;
    if(!pistolEquipped()){ toast('Equip the pistol first', '#49a4ff'); lastPistolAt = t; return; }
    if(!takeAmmo('pistol')){ toast('Pistol: no ammo', '#ff6b6b'); lastPistolAt = t; return; }
    spawnBullet(); lastPistolAt = t;
  }
  function uziStart(){
    if(uziTimer) return;
    if(!uziEquipped()){ toast('Equip the uzi first', '#49a4ff'); return; }
    if(!takeAmmo('uzi')){ toast('Uzi: no ammo', '#ff6b6b'); return; }
    spawnBullet();
    uziTimer = setInterval(()=>{
      if(!uziEquipped()){ uziStop(); return; }
      if(!takeAmmo('uzi')){ toast('Uzi: no ammo', '#ff6b6b'); uziStop(); return; }
      spawnBullet();
    }, TUNE.uziIntervalMs);
  }
  function uziStop(){ if(uziTimer){ clearInterval(uziTimer); uziTimer=null; } }

  // ---- Fire button UI ----
  function placeFireButton(){
    if(!fireBtn) return;
    const stick = document.getElementById('stick');
    const game  = document.getElementById('game');
    // default fallback
    let left = window.innerWidth - 90;
    let top  = (game ? game.getBoundingClientRect().bottom + 12 : window.innerHeight - 180);
    if(stick){
      const r = stick.getBoundingClientRect();
      left = Math.min(r.right + 10, window.innerWidth - 76);
      top  = Math.max((game ? game.getBoundingClientRect().bottom + 8 : 0), r.top - 10 - 66);
    }
    fireBtn.style.left = left + 'px';
    fireBtn.style.top  = top  + 'px';
    fireBtn.style.bottom = ''; // ensure top positioning
  }

  function ensureFireButton(){
    if(fireBtn) return fireBtn;
    fireBtn = document.createElement('button');
    fireBtn.id = 'btnFire';
    fireBtn.type = 'button';
    fireBtn.textContent = 'FIRE';
    Object.assign(fireBtn.style, {
      position:'fixed', zIndex:6,
      width:'66px', height:'66px', borderRadius:'50%',
      background:'#1f2a3f', color:'#cfe0ff',
      border:'2px solid #2a3550', fontWeight:'700', letterSpacing:'1px',
      boxShadow:'0 2px 10px rgba(0,0,0,.35)',
      display:'none',
      touchAction:'none'
    });
    document.body.appendChild(fireBtn);

    // Inputs
    const down = (ev)=>{
      ev.preventDefault(); ev.stopPropagation();
      if(uziEquipped()) uziStart();
      else firePistol();
    };
    const up = (ev)=>{
      ev.preventDefault(); ev.stopPropagation();
      uziStop();
    };
    fireBtn.addEventListener('touchstart', down, {passive:false});
    fireBtn.addEventListener('pointerdown',down, {passive:false});
    fireBtn.addEventListener('mousedown',  down, {passive:false});
    fireBtn.addEventListener('touchend',   up,   {passive:false});
    fireBtn.addEventListener('pointerup',  up,   {passive:false});
    fireBtn.addEventListener('mouseup',    up,   {passive:false});
    fireBtn.addEventListener('touchcancel',up,   {passive:false});

    // Keep it placed correctly
    placeFireButton();
    window.addEventListener('resize', placeFireButton);
    window.addEventListener('orientationchange', placeFireButton);
    if(!uiTicker) uiTicker = setInterval(placeFireButton, 800);

    return fireBtn;
  }

  function syncFireButton(){
    const btn = ensureFireButton();
    const owned = anyGunOwned();
    const equipped = pistolEquipped() || uziEquipped();

    // Visible if you own a gun; enabled when actually equipped
    btn.style.display = owned ? 'block' : 'none';
    btn.disabled = !equipped;
    btn.style.opacity = equipped ? '1' : '0.55';
  }

  // ---- Game hooks (or safe polling fallback) ----
  function attachHooks(){
    // Update: move bullets + collisions + visibility
    IZZA.on('update-post', ({dtSec})=>{
      syncFireButton();

      for(let i=bullets.length-1; i>=0; i--){
        const b = bullets[i];
        b.x += b.vx*dtSec; b.y += b.vy*dtSec;
        if(now() - b.born > TUNE.bulletLifeMs){ bullets.splice(i,1); continue; }

        let hit = false;

        // Pedestrians: instant
        for(const p of IZZA.api.pedestrians){
          if(p.state==='blink') continue;
          if(closeLE(b.x,b.y, p.x+16,p.y+16, TUNE.hitRadius)){
            p.state='blink'; p.blinkT=0.3;
            if(IZZA.api.player.wanted < 5) IZZA.api.setWanted(IZZA.api.player.wanted + 1);
            hit = true; break;
          }
        }
        if(hit){ bullets.splice(i,1); continue; }

        // Cops: 2 hits
        for(const c of IZZA.api.cops){
          if(closeLE(b.x,b.y, c.x+16,c.y+16, TUNE.hitRadius)){
            const n=(copHits.get(c)||0)+1; copHits.set(c,n);
            if(n>=2){
              const idx=IZZA.api.cops.indexOf(c); if(idx>=0) IZZA.api.cops.splice(idx,1);
              IZZA.api.setWanted(IZZA.api.player.wanted - 1);

              // Match your core's drop event
              const DROP_GRACE_MS=1000, DROP_OFFSET=18;
              const cx=c.x+16, cy=c.y+16;
              const dx=cx-IZZA.api.player.x, dy=cy-IZZA.api.player.y;
              const m=Math.hypot(dx,dy)||1, ux=dx/m, uy=dy/m;
              const pos={ x:cx+ux*DROP_OFFSET, y:cy+uy*DROP_OFFSET };
              const t=performance.now();
              IZZA.emit('cop-killed', { cop:c, x:pos.x, y:pos.y, droppedAt:t, noPickupUntil:t+DROP_GRACE_MS });
            }
            hit = true; break;
          }
        }
        if(hit){ bullets.splice(i,1); continue; }
      }
    });

    // Render bullets as small black squares
    IZZA.on('render-post', ()=>{
      const cvs = document.getElementById('game'); if(!cvs) return;
      const ctx = cvs.getContext('2d');
      const SCALE = IZZA.api.DRAW / IZZA.api.TILE;
      ctx.save(); ctx.imageSmoothingEnabled=false; ctx.fillStyle='#000';
      for(const b of bullets){
        const sx=(b.x-IZZA.api.camera.x)*SCALE, sy=(b.y-IZZA.api.camera.y)*SCALE;
        ctx.fillRect(sx-2, sy-2, 4, 4);
      }
      ctx.restore();
    });
  }

  // Boot sequence that works whether we load before or after core
  function startWhenReady(){
    ensureFireButton();    // create immediately so you can see it as soon as you own a gun
    syncFireButton();

    const tryStart = ()=>{
      if(!apiReady()) { syncFireButton(); return; }
      try{
        attachHooks();
        toast('Guns (fire button) loaded', '#39cc69');
        clearInterval(poller);
        // Also keep visibility in sync just in case
        uiTicker = uiTicker || setInterval(syncFireButton, 600);
      }catch(e){
        console.error('[guns] hook attach failed', e);
        toast('Guns failed: '+e.message, '#ff6b6b');
        clearInterval(poller);
      }
    };

    // if core is already ready, we’ll attach in the first tick; otherwise we poll
    const poller = setInterval(tryStart, 80);

    // subscribe to future ready events too (covers late/early)
    if(window.IZZA && IZZA.on){
      IZZA.on('ready', tryStart);
    }else{
      document.addEventListener('DOMContentLoaded', ()=>{
        if(window.IZZA && IZZA.on) IZZA.on('ready', tryStart);
      }, {once:true});
    }
  }

  if(document.readyState === 'complete' || document.readyState === 'interactive'){
    startWhenReady();
  }else{
    document.addEventListener('DOMContentLoaded', startWhenReady, {once:true});
  }
})();
