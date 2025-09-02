// IZZA Guns Plugin (pistol, iOS-safe) — v1.4
(function(){
  const TUNE = { speedFallback: 180, lifeMs: 800, radius: 16, pistolDelayMs: 170 };

  const bullets = [];
  const copHits = new WeakMap();
  let lastShotAt = 0;

  const nowMs = ()=>performance.now();
  const hit = (ax,ay,bx,by,r)=> Math.hypot(ax-bx, ay-by) <= r;
  const ping = (m,c)=> { try{ if(typeof bootMsg==='function') bootMsg(m,c); else console.log('[guns]',m);}catch{} };

  function inv(IZZA){ try{ return IZZA.api.getInventory(); }catch{return{};} }
  function pistolEquipped(IZZA){ const v=inv(IZZA); return !!(v.pistol && v.pistol.equipped); }
  function ammoCount(IZZA){ const v=inv(IZZA); return (v.pistol && (v.pistol.ammo|0)) || 0; }
  function consumeAmmo(IZZA){
    const v = inv(IZZA);
    const n = (v.pistol && (v.pistol.ammo|0)) || 0;
    if(n<=0) return false;
    v.pistol.ammo = n-1; IZZA.api.setInventory(v); return true;
  }

  // Read joystick aim from the nub; fallback to facing
  function aimVector(IZZA){
    const nub = document.getElementById('nub');
    if(nub){
      const cs = window.getComputedStyle(nub);
      const left = parseFloat(nub.style.left || cs.left || '40');
      const top  = parseFloat(nub.style.top  || cs.top  || '40');
      const dx = left - 40, dy = top - 40;
      const m = Math.hypot(dx,dy);
      if(m>2) return {x:dx/m, y:dy/m};
    }
    const f = IZZA.api.player.facing;
    if(f==='left')  return {x:-1,y:0};
    if(f==='right') return {x:1,y:0};
    if(f==='up')    return {x:0,y:-1};
    return {x:0,y:1};
  }

  function bulletSpeed(IZZA){
    const cars = IZZA.api.cars;
    return (cars && cars.length ? (cars[0].spd||120)*1.5 : TUNE.speedFallback);
  }

  function spawnBullet(IZZA){
    const p = IZZA.api.player;
    const dir = aimVector(IZZA);
    const spd = bulletSpeed(IZZA);
    const mx = p.x + 16 + dir.x*18;
    const my = p.y + 16 + dir.y*18;
    bullets.push({ x:mx, y:my, vx:dir.x*spd, vy:dir.y*spd, born:nowMs() });
  }

  const canFire = ()=> (nowMs() - lastShotAt) >= TUNE.pistolDelayMs;
  function fireOnce(IZZA){
    if(!canFire()) return;
    if(!pistolEquipped(IZZA)) return;
    if(!consumeAmmo(IZZA)){ ping('Pistol out of ammo', '#ff6b6b'); lastShotAt = nowMs(); return; }
    spawnBullet(IZZA);
    lastShotAt = nowMs();
  }

  function attachInput(IZZA){
    // 1) KEYBOARD (desktop): capture before core
    const kDown = (e)=>{
      const k = e.key?.toLowerCase?.();
      if(k!=='a') return;
      if(!pistolEquipped(IZZA)) return;
      e.preventDefault(); e.stopImmediatePropagation(); e.stopPropagation();
      fireOnce(IZZA);
    };
    window.addEventListener('keydown', kDown, {capture:true, passive:false});
    window.addEventListener('keydown', kDown, {capture:false, passive:false});

    // 2) iOS/Touch: document-level CAPTURE on touchstart & click, only when target is #btnA
    const interceptBtnA = (ev)=>{
      const t = ev.target;
      if(!t) return;
      // tap tolerance: allow children inside the button
      const btn = t.closest ? t.closest('#btnA') : null;
      if(!btn) return;
      if(!pistolEquipped(IZZA)) return;

      // stop the core's btnA.click → doAttack()
      ev.preventDefault(); ev.stopImmediatePropagation(); ev.stopPropagation();
      fireOnce(IZZA);
    };
    // Important: touchstart MUST be non-passive to be allowed to preventDefault on iOS
    document.addEventListener('touchstart', interceptBtnA, {capture:true, passive:false});
    document.addEventListener('click',      interceptBtnA, {capture:true, passive:false});
  }

  function attachLoops(IZZA){
    // Physics + collisions
    IZZA.on('update-post', ({dtSec})=>{
      for(let i=bullets.length-1; i>=0; i--){
        const b = bullets[i];
        b.x += b.vx*dtSec; b.y += b.vy*dtSec;
        if(nowMs()-b.born > TUNE.lifeMs){ bullets.splice(i,1); continue; }

        // Pedestrians: instant elimination
        let hitSomething=false;
        for(const p of IZZA.api.pedestrians){
          if(p.state==='blink') continue;
          if(hit(b.x,b.y, p.x+16,p.y+16, TUNE.radius)){
            p.state='blink'; p.blinkT=0.3;
            if(IZZA.api.player.wanted < 5){ IZZA.api.setWanted(IZZA.api.player.wanted + 1); }
            hitSomething=true; break;
          }
        }
        if(hitSomething){ bullets.splice(i,1); continue; }

        // Cops: two pistol hits
        for(const c of IZZA.api.cops){
          if(hit(b.x,b.y, c.x+16,c.y+16, TUNE.radius)){
            const n = (copHits.get(c)||0)+1; copHits.set(c,n);
            if(n>=2){
              const idx = IZZA.api.cops.indexOf(c);
              if(idx>=0) IZZA.api.cops.splice(idx,1);
              IZZA.api.setWanted(IZZA.api.player.wanted - 1);

              // drop mirror
              const DROP_GRACE_MS=1000, DROP_OFFSET=18;
              const cx=c.x+16, cy=c.y+16, dx=cx-IZZA.api.player.x, dy=cy-IZZA.api.player.y;
              const m=Math.hypot(dx,dy)||1, ux=dx/m, uy=dy/m;
              const pos={ x:cx+ux*DROP_OFFSET, y:cy+uy*DROP_OFFSET };
              const t=performance.now();
              IZZA.emit('cop-killed', { cop:c, x:pos.x, y:pos.y, droppedAt:t, noPickupUntil:t+DROP_GRACE_MS });
            }
            hitSomething=true; break;
          }
        }
        if(hitSomething){ bullets.splice(i,1); continue; }
      }
    });

    // Render bullets (small black squares)
    IZZA.on('render-post', ()=>{
      const cvs = document.getElementById('game'); if(!cvs) return;
      const ctx = cvs.getContext('2d');
      const TILE=IZZA.api.TILE, DRAW=IZZA.api.DRAW, camera=IZZA.api.camera, SCALE = DRAW/TILE;
      ctx.save(); ctx.imageSmoothingEnabled=false; ctx.fillStyle='#000';
      for(const b of bullets){
        const sx=(b.x-camera.x)*SCALE, sy=(b.y-camera.y)*SCALE;
        ctx.fillRect(sx-2, sy-2, 4, 4);
      }
      ctx.restore();
    });
  }

  function boot(){
    if(!window.IZZA || !window.IZZA.on){ 
      document.addEventListener('DOMContentLoaded', boot, {once:true});
      return;
    }
    window.IZZA.on('ready', ()=>{
      try{
        attachInput(window.IZZA);
        attachLoops(window.IZZA);
        ping('Guns plugin loaded', '#39cc69');
      }catch(e){
        console.error('[guns] init failed', e);
        ping('Guns plugin init failed: '+e.message, '#ff6b6b');
      }
    });
  }
  boot();
})();
