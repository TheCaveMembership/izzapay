// IZZA Guns Plugin (pistol) — v1.3 with diagnostics
(function(){
  // ---- Tunables ----
  const TUNE = {
    speedFallback: 180,     // px/s if no car present
    lifeMs: 800,
    radius: 16,             // collision radius in world px
    pistolDelayMs: 170
  };

  const bullets = [];            // {x,y,vx,vy,born}
  const copHits = new WeakMap(); // pistol hit counter per cop
  let lastShotAt = 0;

  const nowMs = ()=>performance.now();
  const hasBootMsg = ()=> typeof bootMsg === 'function';

  function log(...a){ try{ console.log('[guns]', ...a); }catch{} }
  function ping(msg,color){ if(hasBootMsg()) bootMsg(msg,color); else log(msg); }

  function getInv(IZZA){ try{ return IZZA.api.getInventory(); }catch{return{};} }
  function pistolEquipped(IZZA){
    const inv = getInv(IZZA);
    return !!(inv.pistol && inv.pistol.equipped);
  }
  function ammoCount(IZZA){
    const inv = getInv(IZZA);
    return (inv.pistol && (inv.pistol.ammo|0)) || 0;
  }
  function consumePistolAmmo(IZZA){
    const inv = getInv(IZZA);
    const n = (inv.pistol && (inv.pistol.ammo|0)) || 0;
    if(n<=0) return false;
    inv.pistol.ammo = n-1;
    IZZA.api.setInventory(inv);
    return true;
  }

  // Read joystick aim; fallback to player.facing
  function aimVector(IZZA){
    const nub = document.getElementById('nub');
    if(nub){
      // Try inline styles, else computed styles
      const leftStr = nub.style.left || window.getComputedStyle(nub).left || '40px';
      const topStr  = nub.style.top  || window.getComputedStyle(nub).top  || '40px';
      const left = parseFloat(leftStr); const top = parseFloat(topStr);
      const dx = left - 40, dy = top - 40;
      const m = Math.hypot(dx,dy);
      if(m > 2) return { x: dx/m, y: dy/m };
    }
    const f = IZZA.api.player.facing;
    if(f==='left')  return {x:-1,y:0};
    if(f==='right') return {x:1,y:0};
    if(f==='up')    return {x:0,y:-1};
    return {x:0,y:1};
  }

  function bulletSpeed(IZZA){
    const cars = IZZA.api.cars;
    if(cars && cars.length) return (cars[0].spd||120) * 1.5;
    return TUNE.speedFallback;
  }

  function spawnBullet(IZZA, forceDir){
    const p = IZZA.api.player;
    const dir = forceDir || aimVector(IZZA);
    const spd = bulletSpeed(IZZA);
    const mx = p.x + 16 + dir.x*18;
    const my = p.y + 16 + dir.y*18;
    bullets.push({ x:mx, y:my, vx:dir.x*spd, vy:dir.y*spd, born:nowMs() });
  }

  const canFire = ()=> (nowMs() - lastShotAt) >= TUNE.pistolDelayMs;

  function tryFirePistol(IZZA){
    if(!canFire()) return;
    if(!pistolEquipped(IZZA)) return;
    if(!consumePistolAmmo(IZZA)){
      ping('Pistol out of ammo','#ff6b6b');
      lastShotAt = nowMs();
      return;
    }
    spawnBullet(IZZA);
    lastShotAt = nowMs();
  }

  const hit = (ax,ay,bx,by,r)=> Math.hypot(ax-bx,ay-by) <= r;

  function killCop(IZZA, c){
    const i = IZZA.api.cops.indexOf(c);
    if(i>=0) IZZA.api.cops.splice(i,1);
    IZZA.api.setWanted(IZZA.api.player.wanted - 1);

    // Drop (mirror core)
    const DROP_GRACE_MS=1000, DROP_OFFSET=18;
    const cx=c.x+16, cy=c.y+16;
    const dx=cx-IZZA.api.player.x, dy=cy-IZZA.api.player.y;
    const m=Math.hypot(dx,dy)||1, ux=dx/m, uy=dy/m;
    const pos={ x:cx+ux*DROP_OFFSET, y:cy+uy*DROP_OFFSET };
    const t=performance.now();
    IZZA.emit('cop-killed', { cop:c, x:pos.x, y:pos.y, droppedAt:t, noPickupUntil:t+DROP_GRACE_MS });
  }

  function attachInput(IZZA){
    // Capture phase FIRST to beat core's keydown handler
    const onDownCapture = (e)=>{
      const k = e.key?.toLowerCase?.();
      if(k!=='a') return;
      if(!pistolEquipped(IZZA)) return;
      // block core melee doAttack
      e.preventDefault(); e.stopImmediatePropagation(); e.stopPropagation();
      tryFirePistol(IZZA);
      log('A captured (pistol). Ammo:', ammoCount(IZZA));
    };
    const onUpCapture = (e)=>{
      const k = e.key?.toLowerCase?.();
      if(k!=='a') return;
      if(!pistolEquipped(IZZA)) return;
      e.preventDefault(); e.stopImmediatePropagation(); e.stopPropagation();
    };

    window.addEventListener('keydown', onDownCapture, {capture:true, passive:false});
    window.addEventListener('keyup',   onUpCapture,   {capture:true, passive:false});

    // Also in bubble phase as a safety net
    window.addEventListener('keydown', onDownCapture, {capture:false, passive:false});
    window.addEventListener('keyup',   onUpCapture,   {capture:false, passive:false});

    // On-screen A button
    const btnA = document.getElementById('btnA');
    if(btnA){
      const down=(ev)=>{
        if(!pistolEquipped(IZZA)) return;
        ev.preventDefault(); ev.stopImmediatePropagation(); ev.stopPropagation();
        tryFirePistol(IZZA);
        log('btnA captured (pistol). Ammo:', ammoCount(IZZA));
      };
      btnA.addEventListener('mousedown', down, {passive:false});
      btnA.addEventListener('touchstart', down, {passive:false});
      btnA.addEventListener('click', (ev)=>{
        if(!pistolEquipped(IZZA)) return;
        ev.preventDefault(); ev.stopImmediatePropagation(); ev.stopPropagation();
      }, {capture:true, passive:false});
    }

    // DEBUG: Shift+P spawns a free bullet to verify rendering/collisions
    window.addEventListener('keydown', (e)=>{
      if(e.key==='P' || e.key==='p'){
        if(e.shiftKey){
          spawnBullet(IZZA); ping('DEBUG: spawned test bullet','#49a4ff'); log('debug test bullet');
        }
      }
    });
  }

  function attachLoops(IZZA){
    // Sim
    IZZA.on('update-post', ({dtSec})=>{
      for(let i=bullets.length-1; i>=0; i--){
        const b = bullets[i];
        b.x += b.vx*dtSec;
        b.y += b.vy*dtSec;

        if(nowMs()-b.born > TUNE.lifeMs){ bullets.splice(i,1); continue; }

        // Peds: instant
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

        // Cops: 2 hits
        for(const c of IZZA.api.cops){
          if(hit(b.x,b.y, c.x+16,c.y+16, TUNE.radius)){
            const n = (copHits.get(c)||0) + 1;
            copHits.set(c,n);
            if(n>=2) killCop(IZZA,c);
            hitSomething=true; break;
          }
        }
        if(hitSomething){ bullets.splice(i,1); continue; }
      }
    });

    // Render (small black squares)
    IZZA.on('render-post', ()=>{
      const cvs = document.getElementById('game'); if(!cvs) return;
      const ctx = cvs.getContext('2d');
      const TILE=IZZA.api.TILE, DRAW=IZZA.api.DRAW, camera=IZZA.api.camera;
      const SCALE = DRAW/TILE;
      ctx.save();
      ctx.imageSmoothingEnabled=false;
      ctx.fillStyle = '#000'; // small black bullet
      for(const b of bullets){
        const sx = (b.x - camera.x) * SCALE;
        const sy = (b.y - camera.y) * SCALE;
        ctx.fillRect(sx-2, sy-2, 4, 4);
      }
      ctx.restore();
    });
  }

  // Boot
  function init(){
    if(!window.IZZA || !window.IZZA.on || !window.IZZA.api){ 
      // Wait for core
      document.addEventListener('DOMContentLoaded', init, {once:true});
      return;
    }
    window.IZZA.on('ready', ()=>{
      try{
        attachInput(window.IZZA);
        attachLoops(window.IZZA);
        ping('Guns plugin loaded', '#39cc69');
        log('plugin ready');
      }catch(e){
        console.error('[guns] init failed', e);
        ping('Guns plugin init failed: '+e.message, '#ff6b6b');
      }
    });
  }
  init();
})();
