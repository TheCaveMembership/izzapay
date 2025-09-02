// IZZA Guns — v3.4 (iPhone-safe, self-verifying)
(function(){
  // ---- Diagnostics: prove we loaded ----
  function showChip(txt, bg){
    try{
      var chip = document.getElementById('gunsChip');
      if(!chip){
        chip = document.createElement('div');
        chip.id='gunsChip';
        Object.assign(chip.style, {
          position:'fixed', left:'10px', top:'10px', zIndex: 10000,
          background:bg||'#24324a', color:'#cfe0ff',
          border:'1px solid #2a3550', borderRadius:'10px',
          padding:'6px 8px', fontSize:'12px', pointerEvents:'none'
        });
        document.body.appendChild(chip);
      }
      chip.textContent = txt;
      chip.style.display='block';
      clearTimeout(chip._t);
      chip._t = setTimeout(()=>{ chip.style.display='none'; }, 3500);
    }catch(e){}
  }

  const TUNE = {
    speedFallback: 180,      // px/s
    lifeMs: 900,             // bullet lifetime
    hitRadius: 16,           // world px
    pistolDelayMs: 170,
    uziIntervalMs: 90
  };

  const bullets = [];
  const copHits = new WeakMap();
  let lastPistolAt = 0;
  let uziTimer = null;
  let fireBtn = null;
  let placeTicker = null;
  let visTicker = null;

  const now = ()=>performance.now();
  const distLE = (ax,ay,bx,by,r)=> Math.hypot(ax-bx, ay-by) <= r;
  const apiReady = ()=> !!(window.IZZA && IZZA.api && IZZA.api.ready);

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

  const pistolEquipped = ()=> !!(readInventory().pistol && readInventory().pistol.equipped);
  const uziEquipped    = ()=> !!(readInventory().uzi    && readInventory().uzi.equipped);
  const equippedKind   = ()=> uziEquipped()? 'uzi' : (pistolEquipped()? 'pistol' : null);

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

  function firePistol(){
    const t = now();
    if(t - lastPistolAt < TUNE.pistolDelayMs) return;
    if(!pistolEquipped()){ showChip('Equip pistol', '#394769'); lastPistolAt=t; return; }
    if(!takeAmmo('pistol')){ showChip('Pistol: no ammo', '#5b2a2a'); lastPistolAt=t; return; }
    spawnBullet(); lastPistolAt = t;
  }

  function uziStart(){
    if(uziTimer) return;
    if(!uziEquipped()){ showChip('Equip uzi', '#394769'); return; }
    if(!takeAmmo('uzi')){ showChip('Uzi: no ammo', '#5b2a2a'); return; }
    spawnBullet();
    uziTimer = setInterval(()=>{
      if(!uziEquipped()){ uziStop(); return; }
      if(!takeAmmo('uzi')){ showChip('Uzi: no ammo', '#5b2a2a'); uziStop(); return; }
      spawnBullet();
    }, TUNE.uziIntervalMs);
  }
  function uziStop(){ if(uziTimer){ clearInterval(uziTimer); uziTimer=null; } }

  // ---------- FIRE button ----------
  function placeFireButton(){
    if(!fireBtn) return;
    const stick = document.getElementById('stick');
    const vw = window.innerWidth, vh = window.innerHeight;
    let left = vw - 88;
    let top  = vh - 200;
    if(stick){
      const r = stick.getBoundingClientRect();
      left = Math.min(vw - 76, r.right + 10);
      top  = Math.max(10, r.top + (r.height/2 - 33));
    }
    fireBtn.style.left = left + 'px';
    fireBtn.style.top  = top  + 'px';
    fireBtn.style.bottom = '';
  }

  function ensureFireButton(){
    if(fireBtn) return fireBtn;
    fireBtn = document.createElement('button');
    fireBtn.id='btnFire';
    fireBtn.type='button';
    fireBtn.textContent='FIRE';
    Object.assign(fireBtn.style, {
      position:'fixed', zIndex: 1000,
      width:'66px', height:'66px', borderRadius:'50%',
      background:'#1f2a3f', color:'#cfe0ff',
      border:'2px solid #2a3550', fontWeight:'700', letterSpacing:'1px',
      boxShadow:'0 2px 10px rgba(0,0,0,.35)', touchAction:'none',
      display:'block', opacity:'0.55'
    });
    document.body.appendChild(fireBtn);

    const down = (ev)=>{ ev.preventDefault(); ev.stopPropagation(); const k=equippedKind(); if(!k) return; if(k==='uzi') uziStart(); else firePistol(); };
    const up   = (ev)=>{ ev.preventDefault(); ev.stopPropagation(); uziStop(); };

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
    placeTicker = setInterval(placeFireButton, 800);
    return fireBtn;
  }

  function syncBtn(){
    ensureFireButton();
    const ek = equippedKind();
    fireBtn.disabled = !ek;
    fireBtn.style.opacity = ek ? '1' : '0.55';
  }

  // ---------- Hooks ----------
  function attachHooks(){
    IZZA.on('update-post', ({dtSec})=>{
      syncBtn();

      for(let i=bullets.length-1; i>=0; i--){
        const b = bullets[i];
        b.x += b.vx*dtSec; b.y += b.vy*dtSec;
        if(now() - b.born > TUNE.lifeMs){ bullets.splice(i,1); continue; }

        let hit = false;

        // pedestrians: instant
        for(const p of IZZA.api.pedestrians){
          if(p.state==='blink') continue;
          if(distLE(b.x,b.y, p.x+16,p.y+16, TUNE.hitRadius)){
            p.state='blink'; p.blinkT=0.3;
            if(IZZA.api.player.wanted < 5) IZZA.api.setWanted(IZZA.api.player.wanted + 1);
            hit = true; break;
          }
        }
        if(hit){ bullets.splice(i,1); continue; }

        // cops: 2 hits
        for(const c of IZZA.api.cops){
          if(distLE(b.x,b.y, c.x+16,c.y+16, TUNE.hitRadius)){
            const n=(copHits.get(c)||0)+1; copHits.set(c,n);
            if(n>=2){
              const idx = IZZA.api.cops.indexOf(c); if(idx>=0) IZZA.api.cops.splice(idx,1);
              IZZA.api.setWanted(IZZA.api.player.wanted - 1);
              // loot drop (mirrors core)
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

  // ---------- Boot (works pre/post core) ----------
  function start(){
    // always put a chip so you know the file executed
    showChip('Guns plugin loaded', '#1e2a42');

    ensureFireButton();
    syncBtn();
    if(!visTicker) visTicker = setInterval(syncBtn, 700);

    const tryAttach = ()=>{
      if(!apiReady()) return;
      try{
        attachHooks();
        showChip('Guns ready', '#274f2d');
        clearInterval(poller);
      }catch(e){
        console.error('[guns] attach failed', e);
        showChip('Guns failed: '+e.message, '#5b2a2a');
        clearInterval(poller);
      }
    };
    const poller = setInterval(tryAttach, 80);
    if(window.IZZA && IZZA.on) IZZA.on('ready', tryAttach);
  }

  if(document.readyState === 'complete' || document.readyState === 'interactive'){
    start();
  }else{
    document.addEventListener('DOMContentLoaded', start, {once:true});
  }
})();
