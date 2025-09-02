(function(){
  const BULLET = { speed: 380, radius: 10, lifeMs: 900, pistolDelayMs: 220, uziDelayMs: 85 };

  const bullets = [];
  let holdA = false;
  let lastShotAt = 0;
  let btnADown = false;

  const nowMs = ()=> performance.now();
  function equippedWeapon(inv){
    if(inv.uzi && inv.uzi.equipped) return 'uzi';
    if(inv.pistol && inv.pistol.equipped) return 'pistol';
    return 'other';
  }
  function consumeAmmo(IZZA, inv, kind){
    if(kind==='pistol'){
      const n = (inv.pistol.ammo|0); if(n<=0) return false;
      inv.pistol.ammo = n-1; IZZA.api.setInventory(inv); return true;
    }
    if(kind==='uzi'){
      const n = (inv.uzi.ammo|0); if(n<=0) return false;
      inv.uzi.ammo = n-1; IZZA.api.setInventory(inv); return true;
    }
    return false;
  }
  function spawnBullet(IZZA){
    const p = IZZA.api.player;
    let dx=0, dy=0;
    if(p.facing==='left') dx=-1; else if(p.facing==='right') dx=1; else if(p.facing==='up') dy=-1; else dy=1;
    const muzzleX = p.x + 16 + dx*18;
    const muzzleY = p.y + 16 + dy*18;
    bullets.push({ x:muzzleX, y:muzzleY, vx:dx*BULLET.speed, vy:dy*BULLET.speed, born: nowMs(), fromFacing: p.facing });
  }
  const hit = (ax,ay,bx,by,r)=> Math.hypot(ax-bx, ay-by) <= r;

  function killCop(IZZA, c){
    const idx = IZZA.api.cops.indexOf(c);
    if(idx>=0) IZZA.api.cops.splice(idx,1);
    IZZA.api.setWanted(IZZA.api.player.wanted - 1);

    const DROP_GRACE_MS = 1000, DROP_OFFSET=18;
    const centerX = c.x + 16, centerY = c.y + 16;
    const dx = centerX - IZZA.api.player.x, dy = centerY - IZZA.api.player.y;
    const m = Math.hypot(dx,dy)||1, ux=dx/m, uy=dy/m;
    const pos = { x:centerX + ux*DROP_OFFSET, y:centerY + uy*DROP_OFFSET };
    const tnow = performance.now();
    IZZA.emit('cop-killed', { cop:c, x:pos.x, y:pos.y, droppedAt:tnow, noPickupUntil: tnow+DROP_GRACE_MS });
  }
  function hitPed(IZZA, p, dmg){
    if(p.state==='walk' || p.state==='downed'){
      p.hp -= dmg;
      if(p.hp<=0){
        p.state='blink'; p.blinkT=0.6;
        if(IZZA.api.player.wanted < 5){ IZZA.api.setWanted(IZZA.api.player.wanted + 1); }
      }else{
        p.state='downed';
        if(IZZA.api.player.wanted===0){ IZZA.api.setWanted(1); }
      }
    }
  }

  function drawBullets(IZZA){
    const ctx = document.getElementById('game').getContext('2d');
    const TILE=IZZA.api.TILE, DRAW=IZZA.api.DRAW, camera=IZZA.api.camera;
    const SCALE = DRAW/TILE;
    ctx.save();
    ctx.imageSmoothingEnabled=false;
    ctx.fillStyle = '#ffd23f';
    for(const b of bullets){
      const sx = (b.x - camera.x) * SCALE;
      const sy = (b.y - camera.y) * SCALE;
      ctx.fillRect(sx-3, sy-3, 6, 6);
    }
    ctx.restore();
  }

  function canFire(kind){
    const gap = (kind==='uzi') ? BULLET.uziDelayMs : BULLET.pistolDelayMs;
    return (nowMs() - lastShotAt) >= gap;
  }
  function tryFireOnce(IZZA, kind){
    if(!canFire(kind)) return;
    const inv = IZZA.api.getInventory();
    if(!consumeAmmo(IZZA, inv, kind)){
      const host = document.getElementById('tutHint');
      const msg  = (kind==='uzi'?'Uzi':'Pistol')+' is out of ammo';
      if(host){ host.textContent=msg; host.style.display='block'; }
      lastShotAt = nowMs();
      return;
    }
    spawnBullet(IZZA);
    lastShotAt = nowMs();
  }

  function attachInput(IZZA){
    window.addEventListener('keydown', (e)=>{
      const k = e.key?.toLowerCase?.(); if(k!=='a') return;
      const kind = equippedWeapon(IZZA.api.getInventory()); if(kind==='other') return;
      e.preventDefault(); e.stopImmediatePropagation(); e.stopPropagation();
      if(kind==='pistol') tryFireOnce(IZZA,'pistol'); else holdA = true;
    }, {capture:true, passive:false});

    window.addEventListener('keyup', (e)=>{
      const k = e.key?.toLowerCase?.(); if(k!=='a') return;
      const kind = equippedWeapon(IZZA.api.getInventory()); if(kind==='other') return;
      e.preventDefault(); e.stopImmediatePropagation(); e.stopPropagation();
      holdA = false;
    }, {capture:true, passive:false});

    const btnA = document.getElementById('btnA');
    if(btnA){
      const down = (ev)=>{
        const kind = equippedWeapon(IZZA.api.getInventory()); if(kind==='other') return;
        ev.preventDefault(); ev.stopImmediatePropagation(); ev.stopPropagation();
        btnADown = true;
        if(kind==='pistol') tryFireOnce(IZZA,'pistol'); else holdA = true;
      };
      const up = (ev)=>{
        const kind = equippedWeapon(IZZA.api.getInventory()); if(kind==='other') return;
        ev.preventDefault(); ev.stopImmediatePropagation(); ev.stopPropagation();
        btnADown = false; holdA = false;
      };
      btnA.addEventListener('mousedown', down, {passive:false});
      btnA.addEventListener('touchstart', down, {passive:false});
      window.addEventListener('mouseup', up, {passive:false});
      window.addEventListener('touchend', up, {passive:false});
      btnA.addEventListener('click', (ev)=>{
        const kind = equippedWeapon(IZZA.api.getInventory()); if(kind==='other') return;
        ev.preventDefault(); ev.stopImmediatePropagation(); ev.stopPropagation();
      }, {capture:true, passive:false});
    }
  }

  function attachLoops(IZZA){
    IZZA.on('update-post', ({dtSec})=>{
      if(holdA && equippedWeapon(IZZA.api.getInventory())==='uzi') tryFireOnce(IZZA,'uzi');

      for(let i=bullets.length-1; i>=0; i--){
        const b = bullets[i];
        b.x += b.vx * dtSec;
        b.y += b.vy * dtSec;

        if(nowMs() - b.born > BULLET.lifeMs){ bullets.splice(i,1); continue; }

        let hitSomething=false;
        for(const p of IZZA.api.pedestrians){
          if(p.state==='blink') continue;
          if(hit(b.x,b.y, p.x+16,p.y+16, BULLET.radius)){
            hitPed(IZZA, p, 3); hitSomething=true; break;
          }
        }
        if(hitSomething){ bullets.splice(i,1); continue; }

        for(const c of IZZA.api.cops){
          if(hit(b.x,b.y, c.x+16,c.y+16, BULLET.radius)){
            c.hp -= 3;
            if(c.hp<=0) killCop(IZZA, c);
            hitSomething=true; break;
          }
        }
        if(hitSomething){ bullets.splice(i,1); continue; }
      }
    });

    IZZA.on('render-post', ()=> drawBullets(IZZA));
  }

  if(window.IZZA && window.IZZA.on){
    window.IZZA.on('ready', ()=>{
      try{
        attachInput(window.IZZA);
        attachLoops(window.IZZA);
        console.log('[IZZA PLUGIN] guns online');
      }catch(e){ console.error('[guns plugin] init failed', e); }
    });
  }
})();
