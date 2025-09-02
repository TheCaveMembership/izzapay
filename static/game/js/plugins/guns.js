// IZZA Guns (pistol) — simple + iPhone + late-ready safe
(function(){
  const TUNE = { speedFallback: 180, lifeMs: 900, radius: 16, delayMs: 170 };
  const bullets = [];
  const copHits = new WeakMap();
  let lastShotAt = 0, started = false;

  const now = ()=>performance.now();
  const distLE = (ax,ay,bx,by,r)=> Math.hypot(ax-bx, ay-by) <= r;
  const toast = (m,c)=>{ try{ if(typeof bootMsg==='function') bootMsg(m,c); }catch{} };

  function aimVector(IZZA){
    const nub = document.getElementById('nub');
    if(nub){
      const cs = getComputedStyle(nub);
      const left = parseFloat(nub.style.left || cs.left || '40');
      const top  = parseFloat(nub.style.top  || cs.top  || '40');
      const dx = left - 40, dy = top - 40, m = Math.hypot(dx,dy);
      if(m > 2) return {x:dx/m, y:dy/m};
    }
    const f = IZZA.api.player.facing;
    return f==='left'?{x:-1,y:0}:f==='right'?{x:1,y:0}:f==='up'?{x:0,y:-1}:{x:0,y:1};
  }

  function bulletSpeed(IZZA){
    const cars = IZZA.api.cars;
    return (cars && cars.length ? (cars[0].spd||120)*1.5 : TUNE.speedFallback);
  }

  function hasPistolEquipped(IZZA){
    const inv = IZZA.api.getInventory();
    return !!(inv.pistol && inv.pistol.equipped);
  }
  function takeOnePistolRound(IZZA){
    const inv = IZZA.api.getInventory();
    const n = (inv.pistol && (inv.pistol.ammo|0)) || 0;
    if(n<=0) return false;
    inv.pistol.ammo = n-1; IZZA.api.setInventory(inv); return true;
  }

  function fireOnce(IZZA){
    if(now() - lastShotAt < TUNE.delayMs) return;
    if(!hasPistolEquipped(IZZA)) return;
    if(!takeOnePistolRound(IZZA)){ toast('Pistol: no ammo','#ff6b6b'); lastShotAt = now(); return; }

    const p = IZZA.api.player;
    const dir = aimVector(IZZA);
    const spd = bulletSpeed(IZZA);
    bullets.push({ x:p.x+16+dir.x*18, y:p.y+16+dir.y*18, vx:dir.x*spd, vy:dir.y*spd, born:now() });
    lastShotAt = now();
  }

  function attachInput(IZZA){
    // Keyboard A — capture phase so we beat core's doAttack()
    const onKey = (e)=>{
      if((e.key||'').toLowerCase()!=='a') return;
      if(!hasPistolEquipped(IZZA)) return;
      e.preventDefault(); e.stopImmediatePropagation(); e.stopPropagation();
      fireOnce(IZZA);
    };
    window.addEventListener('keydown', onKey, {capture:true, passive:false});
    window.addEventListener('keydown', onKey, {capture:false, passive:false});

    // iPhone: capture touch/click/pointer on the A button and stop the core handler
    const interceptBtnA = (ev)=>{
      const t = ev.target; if(!t) return;
      const btn = t.closest && t.closest('#btnA');
      if(!btn || !hasPistolEquipped(IZZA)) return;
      ev.preventDefault(); ev.stopImmediatePropagation(); ev.stopPropagation();
      fireOnce(IZZA);
    };
    document.addEventListener('touchstart', interceptBtnA, {capture:true, passive:false});
    document.addEventListener('pointerdown',interceptBtnA, {capture:true, passive:false});
    document.addEventListener('click',      interceptBtnA, {capture:true, passive:false});
  }

  function attachLoops(IZZA){
    // Move bullets + collisions
    IZZA.on('update-post', ({dtSec})=>{
      for(let i=bullets.length-1;i>=0;i--){
        const b = bullets[i];
        b.x += b.vx*dtSec; b.y += b.vy*dtSec;
        if(now()-b.born > TUNE.lifeMs){ bullets.splice(i,1); continue; }

        let hitSomething=false;

        // Pedestrians: instant elimination
        for(const p of IZZA.api.pedestrians){
          if(p.state==='blink') continue;
          if(distLE(b.x,b.y, p.x+16,p.y+16, TUNE.radius)){
            p.state='blink'; p.blinkT=0.3;
            if(IZZA.api.player.wanted < 5) IZZA.api.setWanted(IZZA.api.player.wanted+1);
            hitSomething=true; break;
          }
        }
        if(hitSomething){ bullets.splice(i,1); continue; }

        // Cops: two pistol hits
        for(const c of IZZA.api.cops){
          if(distLE(b.x,b.y, c.x+16,c.y+16, TUNE.radius)){
            const n = (copHits.get(c)||0)+1; copHits.set(c,n);
            if(n>=2){
              const idx = IZZA.api.cops.indexOf(c);
              if(idx>=0) IZZA.api.cops.splice(idx,1);
              IZZA.api.setWanted(IZZA.api.player.wanted - 1);

              // mirror core drop behavior
              const DROP_GRACE_MS=1000, DROP_OFFSET=18;
              const cx=c.x+16, cy=c.y+16;
              const dx=cx-IZZA.api.player.x, dy=cy-IZZA.api.player.y;
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
      const TILE=IZZA.api.TILE, DRAW=IZZA.api.DRAW, camera=IZZA.api.camera, SCALE=DRAW/TILE;
      ctx.save(); ctx.imageSmoothingEnabled=false; ctx.fillStyle='#000';
      for(const b of bullets){
        const sx=(b.x-camera.x)*SCALE, sy=(b.y-camera.y)*SCALE;
        ctx.fillRect(sx-2, sy-2, 4, 4);
      }
      ctx.restore();
    });
  }

  function start(IZZA){
    if(started) return; started = true;
    attachInput(IZZA);
    attachLoops(IZZA);
    toast('Guns ready', '#39cc69');
  }

  function tryStartNow(){
    if(!window.IZZA || !window.IZZA.on) return false;
    if(window.IZZA.api && window.IZZA.api.ready){ start(window.IZZA); }
    // Also hook future ready (in case we arrived early)
    window.IZZA.on('ready', ()=> start(window.IZZA));
    return true;
  }

  // Start immediately if core is already ready; otherwise keep trying briefly.
  if(!tryStartNow()){
    document.addEventListener('DOMContentLoaded', tryStartNow, {once:true});
    let tries=0; const id=setInterval(()=>{ if(tryStartNow() || ++tries>60) clearInterval(id); }, 50);
  }
})();
