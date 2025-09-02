// /static/game/plugins/guns.js
(function(){
  // --- Tunables (pistol only for now) ---
  const BULLET = {
    speedFallback: 180,      // px/sec if we can't read a car speed
    radius: 16,              // hit radius in world px (visual stays small)
    lifeMs: 800,             // lifetime
    pistolDelayMs: 170       // tap rate limiter
  };

  const bullets = [];        // {x,y,vx,vy,born}
  const copHits = new WeakMap();  // track pistol hits per cop
  let lastShotAt = 0;

  const nowMs = ()=> performance.now();

  function pistolEquipped(IZZA){
    const inv = IZZA.api.getInventory();
    return !!(inv.pistol && inv.pistol.equipped);
  }
  function consumePistolAmmo(IZZA){
    const inv = IZZA.api.getInventory();
    const n = (inv.pistol && (inv.pistol.ammo|0)) || 0;
    if(n<=0) return false;
    inv.pistol.ammo = n-1;
    IZZA.api.setInventory(inv);
    return true;
  }

  // Read joystick aim from #nub position; fall back to player.facing
  function aimVector(IZZA){
    const nub = document.getElementById('nub');
    if(nub){
      // default center is left/top = 40px (from core)
      const left = parseFloat(nub.style.left||'40');
      const top  = parseFloat(nub.style.top||'40');
      const dx = left - 40;
      const dy = top  - 40;
      const m = Math.hypot(dx,dy);
      if(m > 2){ // stick deflected
        return { x: dx/m, y: dy/m };
      }
    }
    // fallback to facing
    const f = IZZA.api.player.facing;
    if(f==='left')  return {x:-1,y:0};
    if(f==='right') return {x:1,y:0};
    if(f==='up')    return {x:0,y:-1};
    return {x:0,y:1};
  }

  function currentBulletSpeed(IZZA){
    // first car speed * 1.5 if available
    const cars = IZZA.api.cars;
    if(cars && cars.length){
      return (cars[0].spd||120) * 1.5;
    }
    return BULLET.speedFallback;
  }

  function spawnBullet(IZZA){
    const p = IZZA.api.player;
    const dir = aimVector(IZZA);
    const spd = currentBulletSpeed(IZZA);

    // muzzle slightly in front of player
    const mx = p.x + 16 + dir.x * 18;
    const my = p.y + 16 + dir.y * 18;

    bullets.push({
      x: mx, y: my,
      vx: dir.x * spd,
      vy: dir.y * spd,
      born: nowMs()
    });
  }

  function canFire(){ return (nowMs() - lastShotAt) >= BULLET.pistolDelayMs; }

  function tryFirePistol(IZZA){
    if(!canFire()) return;
    if(!consumePistolAmmo(IZZA)){
      const h=document.getElementById('tutHint');
      if(h){ h.textContent='Pistol is out of ammo'; h.style.display='block'; }
      lastShotAt = nowMs();
      return;
    }
    spawnBullet(IZZA);
    lastShotAt = nowMs();
  }

  function hit(ax,ay, bx,by, r){ return Math.hypot(ax-bx, ay-by) <= r; }

  function killCop(IZZA, c){
    const i = IZZA.api.cops.indexOf(c);
    if(i>=0) IZZA.api.cops.splice(i,1);
    IZZA.api.setWanted(IZZA.api.player.wanted - 1);

    // coin drop (mirrors core feel)
    const DROP_GRACE_MS=1000, DROP_OFFSET=18;
    const cx = c.x+16, cy = c.y+16;
    const dx = cx - IZZA.api.player.x, dy = cy - IZZA.api.player.y;
    const m = Math.hypot(dx,dy)||1, ux=dx/m, uy=dy/m;
    const pos = { x: cx + ux*DROP_OFFSET, y: cy + uy*DROP_OFFSET };
    const t = performance.now();
    IZZA.emit('cop-killed', { cop:c, x:pos.x, y:pos.y, droppedAt:t, noPickupUntil:t+DROP_GRACE_MS });
  }

  function attachInput(IZZA){
    // Keyboard A: fire pistol if equipped
    window.addEventListener('keydown', (e)=>{
      const k = e.key?.toLowerCase?.();
      if(k!=='a') return;
      if(!pistolEquipped(IZZA)) return;
      // Block core melee doAttack when pistol equipped
      e.preventDefault(); e.stopImmediatePropagation(); e.stopPropagation();
      tryFirePistol(IZZA);
    }, {capture:true, passive:false});

    window.addEventListener('keyup', (e)=>{
      const k = e.key?.toLowerCase?.();
      if(k!=='a') return;
      if(!pistolEquipped(IZZA)) return;
      e.preventDefault(); e.stopImmediatePropagation(); e.stopPropagation();
    }, {capture:true, passive:false});

    // On-screen A button
    const btnA = document.getElementById('btnA');
    if(btnA){
      const down=(ev)=>{
        if(!pistolEquipped(IZZA)) return;
        ev.preventDefault(); ev.stopImmediatePropagation(); ev.stopPropagation();
        tryFirePistol(IZZA);
      };
      btnA.addEventListener('mousedown', down, {passive:false});
      btnA.addEventListener('touchstart', down, {passive:false});
      btnA.addEventListener('click', (ev)=>{
        if(!pistolEquipped(IZZA)) return;
        ev.preventDefault(); ev.stopImmediatePropagation(); ev.stopPropagation();
      }, {capture:true, passive:false});
    }
  }

  function attachLoops(IZZA){
    // Move bullets + collisions
    IZZA.on('update-post', ({dtSec})=>{
      for(let i=bullets.length-1; i>=0; i--){
        const b = bullets[i];
        b.x += b.vx * dtSec;
        b.y += b.vy * dtSec;

        if(nowMs() - b.born > BULLET.lifeMs){ bullets.splice(i,1); continue; }

        // Pedestrians: instant elimination
        let hitSomething=false;
        for(const p of IZZA.api.pedestrians){
          if(p.state==='blink') continue;
          if(hit(b.x,b.y, p.x+16,p.y+16, BULLET.radius)){
            p.state='blink'; p.blinkT=0.3;
            if(IZZA.api.player.wanted < 5){ IZZA.api.setWanted(IZZA.api.player.wanted + 1); }
            hitSomething=true; break;
          }
        }
        if(hitSomething){ bullets.splice(i,1); continue; }

        // Cops: need 2 pistol hits
        for(const c of IZZA.api.cops){
          if(hit(b.x,b.y, c.x+16,c.y+16, BULLET.radius)){
            const n = (copHits.get(c) || 0) + 1;
            copHits.set(c, n);
            if(n >= 2){ killCop(IZZA, c); }
            hitSomething=true; break;
          }
        }
        if(hitSomething){ bullets.splice(i,1); continue; }
      }
    });

    // Render bullets: small black squares
    IZZA.on('render-post', ()=>{
      const cvs = document.getElementById('game');
      if(!cvs) return;
      const ctx = cvs.getContext('2d');
      const TILE=IZZA.api.TILE, DRAW=IZZA.api.DRAW, camera=IZZA.api.camera;
      const SCALE = DRAW/TILE;
      ctx.save();
      ctx.imageSmoothingEnabled=false;
      ctx.fillStyle = '#0b0e14';
      for(const b of bullets){
        const sx = (b.x - camera.x) * SCALE;
        const sy = (b.y - camera.y) * SCALE;
        ctx.fillRect(sx-2, sy-2, 4, 4);
      }
      ctx.restore();
    });
  }

  // Boot
  if(window.IZZA && window.IZZA.on){
    window.IZZA.on('ready', ()=>{
      try{
        attachInput(window.IZZA);
        attachLoops(window.IZZA);
        console.log('[IZZA PLUGIN] pistol online');
      }catch(e){ console.error('[guns plugin] init failed', e); }
    });
  }
})();
