// IZZA Guns + Fire Button (mobile-friendly) — v2.0
(function(){
  // ---------- Tunables ----------
  const TUNE = {
    speedFallback: 180,   // px/s if no car present
    bulletLifeMs: 900,
    bulletRadius: 16,
    pistolDelayMs: 170,   // single-shot cooldown
    uziDelayMs: 90        // auto fire interval while held
  };

  // ---------- State ----------
  const bullets = [];              // {x,y,vx,vy,born}
  const copHits = new WeakMap();   // pistol/uzi hits per cop
  let lastPistolAt = 0;
  let uziTimer = null;

  // ---------- Utilities ----------
  const now = ()=>performance.now();
  const hitLE = (ax,ay,bx,by,r)=> Math.hypot(ax-bx, ay-by) <= r;
  const safeToast = (m,c)=>{ try{ if(typeof bootMsg==='function') bootMsg(m,c); }catch{} };

  function apiReady(){ return !!(window.IZZA && IZZA.api && IZZA.api.ready); }

  function hasGunEquipped(){
    const inv = IZZA.api.getInventory();
    return !!(
      (inv.pistol && inv.pistol.equipped) ||
      (inv.uzi    && inv.uzi.equipped)
    );
  }
  function isPistol(){
    const inv = IZZA.api.getInventory();
    return !!(inv.pistol && inv.pistol.equipped);
  }
  function isUzi(){
    const inv = IZZA.api.getInventory();
    return !!(inv.uzi && inv.uzi.equipped);
  }
  function takeAmmo(kind){
    const inv = IZZA.api.getInventory();
    const slot = inv[kind]; if(!slot) return false;
    const n = (slot.ammo|0);
    if(n<=0) return false;
    slot.ammo = n-1;
    IZZA.api.setInventory(inv);
    return true;
  }

  function aimVector(){
    // Use joystick if displaced; else use player facing
    const nub = document.getElementById('nub');
    if(nub){
      const cs = getComputedStyle(nub);
      const left = parseFloat(nub.style.left || cs.left || '40');
      const top  = parseFloat(nub.style.top  || cs.top  || '40');
      const dx = left - 40, dy = top - 40, m = Math.hypot(dx,dy);
      if(m>2) return {x:dx/m, y:dy/m};
    }
    const f = IZZA.api.player.facing;
    return f==='left'?{x:-1,y:0}:f==='right'?{x:1,y:0}:f==='up'?{x:0,y:-1}:{x:0,y:1};
  }
  function bulletSpeed(){
    const cars = IZZA.api.cars;
    return (cars && cars.length ? (cars[0].spd||120)*1.5 : TUNE.speedFallback);
  }
  function spawnBullet(){
    const p = IZZA.api.player;
    const dir = aimVector();
    const spd = bulletSpeed();
    bullets.push({
      x: p.x + 16 + dir.x*18,
      y: p.y + 16 + dir.y*18,
      vx: dir.x * spd,
      vy: dir.y * spd,
      born: now()
    });
  }

  // ---------- Shooting ----------
  function pistolFire(){
    const t = now();
    if(t - lastPistolAt < TUNE.pistolDelayMs) return;
    if(!takeAmmo('pistol')){ safeToast('Pistol: no ammo', '#ff6b6b'); lastPistolAt = t; return; }
    spawnBullet();
    lastPistolAt = t;
  }
  function uziStart(){
    if(uziTimer) return;
    // First shot immediately if ammo
    if(takeAmmo('uzi')) spawnBullet(); else { safeToast('Uzi: no ammo', '#ff6b6b'); return; }
    uziTimer = setInterval(()=>{
      if(!isUzi()){ uziStop(); return; }
      if(!takeAmmo('uzi')){ safeToast('Uzi: no ammo', '#ff6b6b'); uziStop(); return; }
      spawnBullet();
    }, TUNE.uziDelayMs);
  }
  function uziStop(){
    if(uziTimer){ clearInterval(uziTimer); uziTimer=null; }
  }

  // ---------- Fire Button UI ----------
  let fireBtn, repositionTimer;
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
      display:'none', // visible only with gun equipped
      touchAction:'none'
    });
    document.body.appendChild(fireBtn);

    // Place to the top-right of the joystick, below the canvas.
    const place = ()=>{
      const stick = document.getElementById('stick');
      if(!stick){ // fallback: right side, above other buttons
        fireBtn.style.left = (window.innerWidth - 100) + 'px';
        fireBtn.style.bottom = '140px';
        return;
      }
      const r = stick.getBoundingClientRect();
      // top-right corner of the stick, with a little offset
      const left = r.left + r.width + 10;
      const top  = r.top - 10 - 66; // 10px above stick
      // Keep on-screen
      const clampedLeft = Math.min(left, window.innerWidth - 76);
      const clampedTop  = Math.max( (document.getElementById('game')?.getBoundingClientRect().bottom || 0) + 8,
                                    Math.max(10, top) );
      fireBtn.style.left = clampedLeft + 'px';
      fireBtn.style.top  = clampedTop + 'px';
      fireBtn.style.bottom = ''; // ensure top-based position wins
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('orientationchange', place);
    repositionTimer = setInterval(place, 750); // nudge occasionally in case layout shifts

    // Input: pistol tap, uzi hold
    const down = (ev)=>{
      if(!hasGunEquipped()) return;
      ev.preventDefault(); ev.stopPropagation();
      if(isPistol()) pistolFire();
      else if(isUzi()) uziStart();
    };
    const up = (ev)=>{
      if(!hasGunEquipped()) return;
      ev.preventDefault(); ev.stopPropagation();
      if(isUzi()) uziStop();
    };

    fireBtn.addEventListener('touchstart', down, {passive:false});
    fireBtn.addEventListener('pointerdown', down, {passive:false});
    fireBtn.addEventListener('mousedown', down, {passive:false});
    fireBtn.addEventListener('touchend', up, {passive:false});
    fireBtn.addEventListener('pointerup', up, {passive:false});
    fireBtn.addEventListener('mouseup', up, {passive:false});
    fireBtn.addEventListener('touchcancel', up, {passive:false});
    return fireBtn;
  }

  function updateFireButtonVisibility(){
    const btn = ensureFireButton();
    // Show only if pistol or uzi equipped; hide otherwise
    btn.style.display = hasGunEquipped() ? 'block' : 'none';
  }

  // ---------- Game loop hooks ----------
  function attachLoops(){
    // move bullets & collisions
    IZZA.on('update-post', ({dtSec})=>{
      // keep UI visibility synced to equipment
      updateFireButtonVisibility();

      for(let i=bullets.length-1; i>=0; i--){
        const b = bullets[i];
        b.x += b.vx*dtSec; b.y += b.vy*dtSec;
        if(now() - b.born > TUNE.bulletLifeMs){ bullets.splice(i,1); continue; }

        let hitAny = false;

        // Pedestrians: instant elimination
        for(const p of IZZA.api.pedestrians){
          if(p.state==='blink') continue;
          if(hitLE(b.x,b.y, p.x+16,p.y+16, TUNE.bulletRadius)){
            p.state='blink'; p.blinkT=0.3;
            if(IZZA.api.player.wanted < 5) IZZA.api.setWanted(IZZA.api.player.wanted+1);
            hitAny=true; break;
          }
        }
        if(hitAny){ bullets.splice(i,1); continue; }

        // Cops: 2 hits
        for(const c of IZZA.api.cops){
          if(hitLE(b.x,b.y, c.x+16,c.y+16, TUNE.bulletRadius)){
            const n=(copHits.get(c)||0)+1; copHits.set(c,n);
            if(n>=2){
              // remove cop & lower wanted
              const idx = IZZA.api.cops.indexOf(c); if(idx>=0) IZZA.api.cops.splice(idx,1);
              IZZA.api.setWanted(IZZA.api.player.wanted - 1);

              // mirror your core's drop event
              const DROP_GRACE_MS=1000, DROP_OFFSET=18;
              const cx=c.x+16, cy=c.y+16;
              const dx=cx-IZZA.api.player.x, dy=cy-IZZA.api.player.y;
              const m=Math.hypot(dx,dy)||1, ux=dx/m, uy=dy/m;
              const pos={ x:cx+ux*DROP_OFFSET, y:cy+uy*DROP_OFFSET };
              const t=performance.now();
              IZZA.emit('cop-killed', { cop:c, x:pos.x, y:pos.y, droppedAt:t, noPickupUntil:t+DROP_GRACE_MS });
            }
            hitAny=true; break;
          }
        }
        if(hitAny){ bullets.splice(i,1); continue; }
      }
    });

    // render bullets
    IZZA.on('render-post', ()=>{
      const cvs = document.getElementById('game'); if(!cvs) return;
      const ctx = cvs.getContext('2d');
      const TILE=IZZA.api.TILE, DRAW=IZZA.api.DRAW, camera=IZZA.api.camera, SCALE=DRAW/TILE;
      ctx.save(); ctx.imageSmoothingEnabled=false; ctx.fillStyle='#000';
      for(const b of bullets){
        const sx=(b.x-camera.x)*SCALE, sy=(b.y-camera.y)*SCALE;
        ctx.fillRect(sx-2, sy-2, 4, 4); // small black bullet
      }
      ctx.restore();
    });
  }

  // ---------- Boot ----------
  function start(){
    try{
      ensureFireButton();
      attachLoops();
      safeToast('Fire button ready', '#39cc69');
    }catch(e){
      console.error('[guns_firebtn] init failed', e);
      safeToast('Fire button failed: '+e.message, '#ff6b6b');
    }
  }

  function waitForCore(){
    if(apiReady()){ start(); return; }
    // Try again a few times quickly, then less frequently.
    let tries = 0;
    const t = setInterval(()=>{
      if(apiReady()){ clearInterval(t); start(); }
      else if(++tries>80){ clearInterval(t); console.error('[guns_firebtn] core not ready'); }
    }, 50);
  }

  if(document.readyState === 'complete' || document.readyState === 'interactive'){
    waitForCore();
  }else{
    document.addEventListener('DOMContentLoaded', waitForCore, {once:true});
  }
})();
