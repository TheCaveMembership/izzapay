// IZZA Guns (mobile FIRE button) — v3.0
(function(){
  // ---------- Tunables ----------
  const TUNE = {
    speedFallback: 180,   // px/s if we can't read a car speed
    lifeMs: 900,          // bullet lifetime
    radius: 16,           // hit radius (world px)
    pistolDelayMs: 170,   // pistol tap cadence
    uziIntervalMs: 90     // uzi auto-fire while held
  };

  // ---------- State ----------
  const bullets = [];              // {x,y,vx,vy,born}
  const copHits = new WeakMap();   // per-cop hit counter
  let lastPistolAt = 0;
  let uziTimer = null;
  let fireBtn = null;
  let visTicker = null;
  let placeTicker = null;

  // ---------- Helpers ----------
  const now = ()=>performance.now();
  const closeLE = (ax,ay,bx,by,r)=> Math.hypot(ax-bx, ay-by) <= r;
  const apiReady = ()=> !!(window.IZZA && IZZA.api && IZZA.api.ready);
  const toast = (m,c)=>{ try{ if(typeof bootMsg==='function') bootMsg(m,c); }catch{} };

  function readInventory(){
    try{
      if(apiReady()) return IZZA.api.getInventory() || {};
      const raw = localStorage.getItem('izzaInventory');
      return raw ? JSON.parse(raw) : {};
    }catch{ return {}; }
  }
  function writeInventory(inv){
    try{
      if(apiReady()) IZZA.api.setInventory(inv);
      else localStorage.setItem('izzaInventory', JSON.stringify(inv));
    }catch{}
  }

  function pistolEquipped(){ const inv = readInventory(); return !!(inv.pistol && inv.pistol.equipped); }
  function uziEquipped(){    const inv = readInventory(); return !!(inv.uzi    && inv.uzi.equipped); }
  function anyGunOwned(){
    const inv = readInventory();
    return !!((inv.pistol && inv.pistol.owned) || (inv.uzi && inv.uzi.owned));
  }
  function equippedKind(){ return uziEquipped() ? 'uzi' : (pistolEquipped() ? 'pistol' : null); }

  function takeAmmo(kind){
    const inv = readInventory();
    const slot = inv[kind]; if(!slot) return false;
    const n = (slot.ammo|0); if(n<=0) return false;
    slot.ammo = n-1; writeInventory(inv); return true;
  }

  // Aim: use joystick vector if displaced; else player facing
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
    if(!apiReady()) return;
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

  // ---------- Shooting ----------
  function firePistol(){
    const t = now();
    if(t - lastPistolAt < TUNE.pistolDelayMs) return;
    if(!pistolEquipped()){ toast('Equip the pistol first', '#49a4ff'); lastPistolAt=t; return; }
    if(!takeAmmo('pistol')){ toast('Pistol: no ammo', '#ff6b6b'); lastPistolAt=t; return; }
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
  function uziStop(){ if(uziTimer){ clearInterval(uziTimer); uziTimer = null; } }

  // ---------- FIRE button (always visible, disabled if no gun equipped) ----------
  function placeFireButton(){
    if(!fireBtn) return;
    const stick = document.getElementById('stick');
    const vw = window.innerWidth, vh = window.innerHeight;
    let left = vw - 88;
    let top  = vh - 200;

    if(stick){
      const r = stick.getBoundingClientRect();
      // place to the top-right of the stick, vertically centered on it
      left = Math.min(vw - 76, r.right + 10);
      top  = Math.max(10, r.top + (r.height/2 - 33));
    }
    fireBtn.style.left = left + 'px';
    fireBtn.style.top  = top  + 'px';
    fireBtn.style.bottom = ''; // force top positioning
  }

  function ensureFireButton(){
    if(fireBtn) return fireBtn;
    fireBtn = document.createElement('button');
    fireBtn.id = 'btnFire';
    fireBtn.type = 'button';
    fireBtn.textContent = 'FIRE';
    Object.assign(fireBtn.style, {
      position:'fixed', zIndex: 999,   // on top of other UI
      width:'66px', height:'66px', borderRadius:'50%',
      background:'#1f2a3f', color:'#cfe0ff',
      border:'2px solid #2a3550', fontWeight:'700', letterSpacing:'1px',
      boxShadow:'0 2px 10px rgba(0,0,0,.35)',
      display:'block', touchAction:'none', opacity:'0.55'
    });
    document.body.appendChild(fireBtn);

    // Inputs (tap = pistol, hold = uzi)
    const down = (ev)=>{
      ev.preventDefault(); ev.stopPropagation();
      const kind = equippedKind();
      if(!kind) return;
      if(kind==='uzi') uziStart(); else firePistol();
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

    placeFireButton();
    window.addEventListener('resize', placeFireButton);
    window.addEventListener('orientationchange', placeFireButton);
    placeTicker = setInterval(placeFireButton, 800); // nudge occasionally
    return fireBtn;
  }

  function syncButtonState(){
    ensureFireButton();
    // visible ALWAYS, but enabled only when a gun is equipped
    const ek = equippedKind();
    fireBtn.disabled = !ek;
    fireBtn.style.opacity = ek ? '1' : '0.55';
  }

  // ---------- Hooks ----------
  function attachHooks(){
    // Move bullets + collisions + keep button state synced
    IZZA.on('update-post', ({dtSec})=>{
      syncButtonState();

      for(let i=bullets.length-1; i>=0; i--){
        const b = bullets[i];
        b.x += b.vx*dtSec; b.y += b.vy*dtSec;
        if(now() - b.born > TUNE.lifeMs){ bullets.splice(i,1); continue; }

        let hit = false;

        // Pedestrians: instant eliminate
        for(const p of IZZA.api.pedestrians){
          if(p.state==='blink') continue;
          if(closeLE(b.x,b.y, p.x+16,p.y+16, TUNE.radius)){
            p.state='blink'; p.blinkT=0.3;
            if(IZZA.api.player.wanted < 5) IZZA.api.setWanted(IZZA.api.player.wanted + 1);
            hit = true; break;
          }
        }
        if(hit){ bullets.splice(i,1); continue; }

        // Cops: 2 hits
        for(const c of IZZA.api.cops){
          if(closeLE(b.x,b.y, c.x+16,c.y+16, TUNE.radius)){
            const n=(copHits.get(c)||0)+1; copHits.set(c,n);
            if(n>=2){
              const idx = IZZA.api.cops.indexOf(c); if(idx>=0) IZZA.api.cops.splice(idx,1);
              IZZA.api.setWanted(IZZA.api.player.wanted - 1);

              // mirror core's drop event
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

    // Render bullets
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

  // ---------- Boot ----------
  function start(){
    ensureFireButton();
    // keep the button responsive even before IZZA is ready
    if(!visTicker) visTicker = setInterval(syncButtonState, 600);

    // attach to core when ready
    const tryAttach = ()=>{
      if(!apiReady()) return;
      try{
        attachHooks();
        toast('Guns ready', '#39cc69');
        clearInterval(attPoll);
      }catch(e){
        console.error('[guns] attach failed', e);
        toast('Guns failed: '+e.message, '#ff6b6b');
        clearInterval(attPoll);
      }
    };
    const attPoll = setInterval(tryAttach, 80);
    if(window.IZZA && IZZA.on) IZZA.on('ready', tryAttach);
  }

  if(document.readyState === 'complete' || document.readyState === 'interactive'){
    start();
  }else{
    document.addEventListener('DOMContentLoaded', start, {once:true});
  }
})();
