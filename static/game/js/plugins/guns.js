// IZZA Guns — v5.0 (point-blank, higher fire button, live ammo patch, cops spawn, + GRENADES)
(function(){
  // ---- tunables / layout ----
  const TUNE = {
    speedFallback: 180,
    lifeMs: 900,
    hitRadius: 16,
    pistolDelayMs: 170,
    uziIntervalMs: 90,
    FIRE_W: 66, FIRE_H: 66,
    ABOVE_STICK_Y: -160,  // higher than before
    MIN_TOP: 10, RIGHT_MARGIN: 12
  };

  const POINT_BLANK_R = 24; // extra radius for close-quarters shots

  // --- Grenades (NEW) ---
  const GRENADE = {
    key: 'g',             // desktop key to throw
    BTN_W: 44, BTN_H: 44, // mobile button
    fuseMs: 900,          // time until detonation
    throwSpeed: 240,      // px/s
    blastR: 72,           // damage radius
    maxBounces: 1         // light bounce then stop
  };

  const bullets = [];
  const copHits = new WeakMap();
  let lastPistolAt = 0, uziTimer = null;
  let fireBtn=null, ammoPill=null, visInterval=null, placeInterval=null;

  // Grenade state
  const grenades = [];   // {x,y,vx,vy,born,stopped,bounces}
  const blasts   = [];   // {x,y,at,lifeMs}
  let grenadeBtn=null;

  const now = ()=>performance.now();
  const apiReady = ()=> !!(window.IZZA && IZZA.api && IZZA.api.ready);
  const SCALE = ()=> IZZA.api.DRAW / IZZA.api.TILE;
  const w2s = (x,y)=>({ sx:(x-IZZA.api.camera.x)*SCALE(), sy:(y-IZZA.api.camera.y)*SCALE() });
  const distLE = (ax,ay,bx,by,r)=> Math.hypot(ax-bx, ay-by) <= r;

  // ---------- inventory helpers ----------
  function readInv(){
    try{
      if(apiReady()) return IZZA.api.getInventory() || {};
      const raw=localStorage.getItem('izzaInventory'); return raw? JSON.parse(raw) : {};
    }catch{ return {}; }
  }
  function writeInv(inv){
    try{
      if(apiReady()) IZZA.api.setInventory(inv);
      else localStorage.setItem('izzaInventory', JSON.stringify(inv));
    }catch{}
  }
  const pistolEquipped = ()=> !!(readInv().pistol && readInv().pistol.equipped);
  const uziEquipped    = ()=> !!(readInv().uzi && readInv().uzi.equipped);
  const equippedKind   = ()=> uziEquipped()? 'uzi' : (pistolEquipped()? 'pistol' : null);
  function ammoFor(kind){ const s=readInv()[kind]; return (s && (s.ammo|0)) || 0; }

  function takeAmmo(kind){
    const inv = readInv(); const slot = inv[kind]; if(!slot) return false;
    const n = (slot.ammo|0); if(n<=0) return false;
    slot.ammo = n-1; writeInv(inv);
    updateAmmoHUD(); patchInventoryAmmo(kind, slot.ammo); // live update when inv panel is open
    return true;
  }

  // Patch the open inventory panel’s “Ammo: N” text without relying on core internals
  function patchInventoryAmmo(kind, value){
    try{
      const host = document.getElementById('invPanel');
      if(!host || host.style.display==='none') return;
      const label = (kind==='uzi' ? 'Uzi' : (kind==='grenade'?'Grenades':'Pistol'));
      const rows = host.querySelectorAll('.inv-item');
      rows.forEach(row=>{
        if(row.textContent.includes(label) && row.textContent.includes('Ammo:')){
          const metas = row.querySelectorAll('div');
          metas.forEach(m=>{
            if(m.textContent.includes('Ammo:')){
              m.textContent = m.textContent.replace(/Ammo:\s*\d+/, `Ammo: ${value}`);
            }
          });
        }
      });
    }catch{}
  }

  // ---------- aim + bullet ----------
  function aimVector(){
    const nub=document.getElementById('nub');
    if(nub){
      const cs=getComputedStyle(nub);
      const left=parseFloat(nub.style.left||cs.left||'40'); const top=parseFloat(nub.style.top||cs.top||'40');
      const dx=left-40, dy=top-40, m=Math.hypot(dx,dy);
      if(m>2) return {x:dx/m, y:dy/m};
    }
    const f = apiReady() ? IZZA.api.player.facing : 'down';
    if(f==='left') return {x:-1,y:0};
    if(f==='right')return {x:1,y:0};
    if(f==='up')   return {x:0,y:-1};
    return {x:0,y:1};
  }
  function bulletSpeed(){
    if(apiReady()){
      const cars=IZZA.api.cars; if(cars && cars.length) return (cars[0].spd||120)*1.5;
    }
    return TUNE.speedFallback;
  }

  // ---------- cops: mirror maintainCops behavior ----------
  function spawnCop(kind){
    const cvs=document.getElementById('game'); if(!cvs) return;
    const S=SCALE(), cam=IZZA.api.camera, t=IZZA.api.TILE;
    const viewW = cvs.width / S, viewH = cvs.height / S;
    const edges = [
      { x: cam.x - 3*t,                 y: cam.y + Math.random()*viewH }, // left
      { x: cam.x + viewW + 3*t,         y: cam.y + Math.random()*viewH }, // right
      { x: cam.x + Math.random()*viewW, y: cam.y - 3*t },                 // top
      { x: cam.x + Math.random()*viewW, y: cam.y + viewH + 3*t }          // bottom
    ];
    const pos = edges[(Math.random()*edges.length)|0];

    const spd = kind==='army' ? 95 : kind==='swat' ? 90 : 80;
    const hp  = kind==='army' ? 6  : kind==='swat' ? 5  : 4;
    IZZA.api.cops.push({
      x: pos.x, y: pos.y, spd, hp, kind,
      reinforceAt: performance.now() + 30000,
      facing: 'down'
    });
  }
  function ensureCops(){
    const want = IZZA.api.player.wanted|0;
    let cur = IZZA.api.cops.length|0;
    while(cur < want){
      let kind='police';
      if(want>=5) kind='army';
      else if(want>=4) kind='swat';
      spawnCop(kind); cur++;
    }
    while(cur > want){ IZZA.api.cops.pop(); cur--; }
  }

  // When *we* change wanted (e.g., by shooting a ped), we mirror maintainCops()
  function bumpWanted(){
    IZZA.api.setWanted((IZZA.api.player.wanted|0)+1);
    ensureCops();
  }

  // ---------- point-blank impact ----------
  function applyImpactAt(x, y){
    // Cops first (two hits to eliminate)
    for(const c of IZZA.api.cops){
      if(Math.hypot(x-(c.x+16), y-(c.y+16)) <= POINT_BLANK_R){
        const n=(copHits.get(c)||0)+1; copHits.set(c,n);
        if(n>=2){
          const idx=IZZA.api.cops.indexOf(c); if(idx>=0) IZZA.api.cops.splice(idx,1);
          IZZA.api.setWanted((IZZA.api.player.wanted|0)-1);
          ensureCops();
          // Drop (copy of core)
          const DROP_GRACE_MS=1000, DROP_OFFSET=18;
          const cx=c.x+16, cy=c.y+16;
          const dx=cx-IZZA.api.player.x, dy=cy-IZZA.api.player.y;
          const m=Math.hypot(dx,dy)||1, ux=dx/m, uy=dy/m;
          const pos={ x:cx+ux*DROP_OFFSET, y:cy+uy*DROP_OFFSET };
          const t=performance.now();
          IZZA.emit('cop-killed',{cop:c,x:pos.x,y:pos.y,droppedAt:t,noPickupUntil:t+DROP_GRACE_MS});
        }
        return true;
      }
    }
    // Peds next (instant)
    for(const p of IZZA.api.pedestrians){
      if(p.state==='blink') continue;
      if(Math.hypot(x-(p.x+16), y-(p.y+16)) <= POINT_BLANK_R){
        p.state='blink'; p.blinkT=0.3;
        if((IZZA.api.player.wanted|0) < 5){ bumpWanted(); }
        return true;
      }
    }
    return false;
  }

  // ---------- projectile spawn OR point-blank ----------
  function spawnBulletOrPointBlank(){
    const p=IZZA.api.player, dir=aimVector();
    const playerCX = p.x+16, playerCY = p.y+16;

    // 1) Point-blank check at player's center
    if(applyImpactAt(playerCX, playerCY)){
      return false; // impact consumed the shot
    }

    // 2) Otherwise spawn a projectile from the muzzle
    const spd=bulletSpeed();
    bullets.push({
      x: playerCX + dir.x*18,
      y: playerCY + dir.y*18,
      vx: dir.x*spd,
      vy: dir.y*spd,
      born: now()
    });
    return true;
  }

  // ---------- firing ----------
  function firePistol(){
    const t=now();
    if(t-lastPistolAt < TUNE.pistolDelayMs) return;
    if(!pistolEquipped()) return;
    if(!takeAmmo('pistol')){ lastPistolAt=t; return; }
    spawnBulletOrPointBlank(); lastPistolAt=t;
  }
  function uziStart(){
    if(uziTimer || !uziEquipped()) return;
    if(!takeAmmo('uzi')) return;
    spawnBulletOrPointBlank();
    uziTimer=setInterval(()=>{
      if(!uziEquipped()){ uziStop(); return; }
      if(!takeAmmo('uzi')){ uziStop(); return; }
      spawnBulletOrPointBlank();
    }, TUNE.uziIntervalMs);
  }
  function uziStop(){ if(uziTimer){ clearInterval(uziTimer); uziTimer=null; } }

  // ================== GRENADES (NEW) ==================
  function grenadeCount(){
    const s=readInv().grenade; return (s && (s.ammo|0)) || 0;
  }
  function takeGrenade(){
    const inv=readInv(); const s=inv.grenade; if(!s) return false;
    const n=(s.ammo|0); if(n<=0) return false;
    s.ammo=n-1; writeInv(inv);
    patchInventoryAmmo('grenade', s.ammo);
    return true;
  }
  function throwGrenade(){
    if(grenadeCount()<=0) return;
    if(!takeGrenade()) return;

    const p=IZZA.api.player, dir=aimVector();
    const cx=p.x+16, cy=p.y+16;
    grenades.push({
      x: cx + dir.x*14,
      y: cy + dir.y*14,
      vx: dir.x*GRENADE.throwSpeed,
      vy: dir.y*GRENADE.throwSpeed,
      born: now(),
      stopped:false,
      bounces:0
    });
    IZZA.emit?.('grenade-thrown', {});
  }

  function explodeAt(x,y){
    blasts.push({x, y, at: now(), lifeMs: 350});
    // Damage peds
    for(let i=IZZA.api.pedestrians.length-1; i>=0; i--){
      const p=IZZA.api.pedestrians[i];
      const d=Math.hypot((p.x+16)-x, (p.y+16)-y);
      if(d<=GRENADE.blastR){
        IZZA.api.pedestrians.splice(i,1);
        if((IZZA.api.player.wanted|0) < 5){ bumpWanted(); }
      }
    }
    // Damage cops (remove, drop, and reduce wanted by 1 to mirror gun logic)
    for(let i=IZZA.api.cops.length-1; i>=0; i--){
      const c=IZZA.api.cops[i];
      const d=Math.hypot((c.x+16)-x, (c.y+16)-y);
      if(d<=GRENADE.blastR){
        IZZA.api.cops.splice(i,1);
        IZZA.api.setWanted((IZZA.api.player.wanted|0)-1);
        ensureCops();
        // Drop like core
        const DROP_GRACE_MS=1000, DROP_OFFSET=18;
        const cx=c.x+16, cy=c.y+16;
        const dx=cx-IZZA.api.player.x, dy=cy-IZZA.api.player.y;
        const m=Math.hypot(dx,dy)||1, ux=dx/m, uy=dy/m;
        const pos={ x:cx+ux*DROP_OFFSET, y:cy+uy*DROP_OFFSET };
        const t=performance.now();
        IZZA.emit('cop-killed',{cop:c,x:pos.x,y:pos.y,droppedAt:t,noPickupUntil:t+DROP_GRACE_MS});
      }
    }
  }

  function updateGrenades(dt){
    // motion + fuse
    for(let i=grenades.length-1;i>=0;i--){
      const g=grenades[i];
      if(!g.stopped){
        g.x += g.vx*dt;
        g.y += g.vy*dt;

        // simple ground friction
        g.vx *= 0.96;
        g.vy *= 0.96;

        // very light “bounce” on map boundaries (camera edges are fine stand-ins)
        const cam=IZZA.api.camera, t=IZZA.api.TILE, S=IZZA.api.DRAW;
        const minX = cam.x - 2*t, maxX = cam.x + (document.getElementById('game').width * t / S) + 2*t;
        const minY = cam.y - 2*t, maxY = cam.y + (document.getElementById('game').height* t / S) + 2*t;
        if(g.x < minX || g.x > maxX){ g.vx = -g.vx*0.5; g.bounces++; }
        if(g.y < minY || g.y > maxY){ g.vy = -g.vy*0.5; g.bounces++; }
        if(g.bounces > GRENADE.maxBounces || (Math.abs(g.vx)+Math.abs(g.vy)) < 12){ g.stopped=true; }
      }
      if(now() - g.born >= GRENADE.fuseMs){
        grenades.splice(i,1);
        explodeAt(g.x, g.y);
      }
    }

    // clean blasts
    for(let i=blasts.length-1;i>=0;i--){
      if(now() - blasts[i].at > blasts[i].lifeMs){ blasts.splice(i,1); }
    }
  }

  // ---------- UI: fire button (higher) + ammo pill ----------
  function ensureFireBtn(){
    if(fireBtn) return fireBtn;
    fireBtn=document.createElement('button');
    fireBtn.id='btnFire'; fireBtn.type='button'; fireBtn.textContent='FIRE';
    Object.assign(fireBtn.style,{
      position:'fixed',zIndex:1000,width:TUNE.FIRE_W+'px',height:TUNE.FIRE_H+'px',borderRadius:'50%',
      background:'#1f2a3f',color:'#cfe0ff',border:'2px solid #2a3550',fontWeight:'700',
      letterSpacing:'1px',boxShadow:'0 2px 10px rgba(0,0,0,.35)',touchAction:'none',
      display:'block',opacity:'1'
    });
    document.body.appendChild(fireBtn);

    ammoPill=document.createElement('div');
    Object.assign(ammoPill.style,{
      position:'fixed',zIndex:1000,minWidth:'36px',padding:'4px 7px',borderRadius:'10px',
      background:'#101827',color:'#cfe0ff',border:'1px solid #2a3550',textAlign:'center',fontSize:'12px'
    });
    document.body.appendChild(ammoPill);

    const down=(ev)=>{ ev.preventDefault(); ev.stopPropagation(); const k=equippedKind(); if(!k) return; if(k==='uzi') uziStart(); else firePistol(); };
    const up  =(ev)=>{ ev.preventDefault(); ev.stopPropagation(); uziStop(); };
    fireBtn.addEventListener('touchstart', down, {passive:false});
    fireBtn.addEventListener('pointerdown',down, {passive:false});
    fireBtn.addEventListener('mousedown',  down, {passive:false});
    fireBtn.addEventListener('touchend',   up,   {passive:false});
    fireBtn.addEventListener('pointerup',  up,   {passive:false});
    fireBtn.addEventListener('mouseup',    up,   {passive:false});
    fireBtn.addEventListener('touchcancel',up,   {passive:false});

    positionFire();
    addEventListener('resize', positionFire);
    addEventListener('orientationchange', positionFire);
    if(placeInterval) clearInterval(placeInterval);
    placeInterval=setInterval(positionFire, 1000);

    // --- Grenade button (mobile) ---
    grenadeBtn = document.createElement('button');
    grenadeBtn.id='btnGrenade';
    grenadeBtn.textContent='G';
    Object.assign(grenadeBtn.style,{
      position:'fixed', zIndex:1000, width:GRENADE.BTN_W+'px', height:GRENADE.BTN_H+'px',
      right:(TUNE.RIGHT_MARGIN+TUNE.FIRE_W+16)+'px',
      top:'10px',
      borderRadius:'8px', background:'#2a1f1f', color:'#ffd4d4',
      border:'2px solid #553333', fontWeight:'800', boxShadow:'0 2px 10px rgba(0,0,0,.35)', touchAction:'none'
    });
    grenadeBtn.addEventListener('click', (e)=>{ e.preventDefault(); e.stopPropagation(); throwGrenade(); }, {passive:false});
    document.body.appendChild(grenadeBtn);

    return fireBtn;
  }
  function positionFire(){
    if(!fireBtn) return;
    const stick=document.getElementById('stick');
    const vw=innerWidth, vh=innerHeight;
    let left = vw - (TUNE.FIRE_W + TUNE.RIGHT_MARGIN);
    let top  = Math.max(TUNE.MIN_TOP, Math.round(vh*0.22)); // a bit higher baseline
    if(stick){
      const r=stick.getBoundingClientRect();
      left = Math.min(vw - (TUNE.FIRE_W + TUNE.RIGHT_MARGIN), r.right + 10);
      top  = Math.max(
        TUNE.MIN_TOP,
        Math.min( r.top + TUNE.ABOVE_STICK_Y, vh - (TUNE.FIRE_H + 10) )
      );
    }
    fireBtn.style.left = left+'px';
    fireBtn.style.top  = top +'px';
    if(ammoPill){
      ammoPill.style.left = (left + TUNE.FIRE_W/2 - 22)+'px';
      ammoPill.style.top  = (top + TUNE.FIRE_H + 6)+'px';
    }
    if(grenadeBtn){
      grenadeBtn.style.left = (left - GRENADE.BTN_W - 12)+'px';
      grenadeBtn.style.top  = (top + TUNE.FIRE_H + 6)+'px';
    }
  }
  function updateAmmoHUD(){
    if(!ammoPill) return;
    const ek=equippedKind();
    const g = grenadeCount();
    ammoPill.textContent = (ek ? (ek==='uzi'?'Uzi ':'Pstl ') + ammoFor(ek) : '—') + `  |  G:${g}`;
    ammoPill.style.opacity = '1';
  }
  function syncFireBtn(){
    ensureFireBtn();
    const ek=equippedKind();
    fireBtn.disabled=!ek;
    fireBtn.style.opacity = ek ? '1' : '0.55';
    updateAmmoHUD();
  }

  // ---------- key capture (desktop) ----------
  function attachKeyCapture(){
    const onDownCapture = (e)=>{
      const k=(e.key||'').toLowerCase();
      if(k==='a'){
        const ek=equippedKind();
        if(!ek) return;
        e.preventDefault(); e.stopImmediatePropagation(); e.stopPropagation();
        if(ek==='uzi'){ if(!uziTimer) uziStart(); } else { firePistol(); }
      }else if(k===GRENADE.key){
        e.preventDefault(); e.stopImmediatePropagation(); e.stopPropagation();
        throwGrenade();
      }
    };
    const onUpCapture = (e)=>{
      const k=(e.key||'').toLowerCase();
      if(k==='a'){
        if(uziTimer) uziStop();
        e.preventDefault(); e.stopImmediatePropagation(); e.stopPropagation();
      }
    };
    // capture first so core's melee doesn't trigger
    window.addEventListener('keydown', onDownCapture, {capture:true, passive:false});
    window.addEventListener('keyup',   onUpCapture,   {capture:true, passive:false});
  }

  // ---------- hooks ----------
  function attachHooks(){
    // Keep button/hud in sync
    if(visInterval) clearInterval(visInterval);
    visInterval=setInterval(syncFireBtn, 700);

    // Track external wanted changes
    IZZA.on('wanted-changed', ()=> ensureCops());

    // Sim update
    IZZA.on('update-post', ({dtSec})=>{
      // position/sync UI (lightweight)
      syncFireBtn();

      // bullets
      for(let i=bullets.length-1;i>=0;i--){
        const b=bullets[i];
        b.x+=b.vx*dtSec; b.y+=b.vy*dtSec;
        if(now()-b.born > TUNE.lifeMs){ bullets.splice(i,1); continue; }

        let hitSomething=false;

        // Peds: instant + raise wanted (and spawn units)
        for(const p of IZZA.api.pedestrians){
          if(p.state==='blink') continue;
          if(distLE(b.x,b.y,p.x+16,p.y+16,TUNE.hitRadius)){
            p.state='blink'; p.blinkT=0.3;
            if((IZZA.api.player.wanted|0) < 5){ bumpWanted(); }
            hitSomething=true; break;
          }
        }
        if(hitSomething){ bullets.splice(i,1); continue; }

        // Cops: 2 hits
        for(const c of IZZA.api.cops){
          if(distLE(b.x,b.y,c.x+16,c.y+16,TUNE.hitRadius)){
            const n=(copHits.get(c)||0)+1; copHits.set(c,n);
            if(n>=2){
              const idx=IZZA.api.cops.indexOf(c); if(idx>=0) IZZA.api.cops.splice(idx,1);
              IZZA.api.setWanted((IZZA.api.player.wanted|0)-1);
              ensureCops();
              // Drop (copy of core behavior)
              const DROP_GRACE_MS=1000, DROP_OFFSET=18;
              const cx=c.x+16, cy=c.y+16;
              const dx=cx-IZZA.api.player.x, dy=cy-IZZA.api.player.y;
              const m=Math.hypot(dx,dy)||1, ux=dx/m, uy=dy/m;
              const pos={ x:cx+ux*DROP_OFFSET, y:cy+uy*DROP_OFFSET };
              const t=performance.now();
              IZZA.emit('cop-killed',{cop:c,x:pos.x,y:pos.y,droppedAt:t,noPickupUntil:t+DROP_GRACE_MS});
            }
            hitSomething=true; break;
          }
        }
        if(hitSomething){ bullets.splice(i,1); continue; }
      }

      // grenades
      updateGrenades(dtSec);
    });

    // Render: small black bullet squares + grenade sprites + blast
    IZZA.on('render-post', ()=>{
      const cvs=document.getElementById('game'); if(!cvs) return;
      const ctx=cvs.getContext('2d'); ctx.save();
      ctx.imageSmoothingEnabled=false;

      // bullets
      ctx.fillStyle='#000';
      for(const b of bullets){
        const {sx,sy}=w2s(b.x,b.y);
        ctx.fillRect(sx-2, sy-2, 4, 4);
      }

      // grenades
      ctx.fillStyle='#444';
      grenades.forEach(g=>{
        const {sx,sy}=w2s(g.x,g.y);
        ctx.beginPath(); ctx.arc(sx, sy, 4, 0, Math.PI*2); ctx.fill();
      });

      // blasts
      blasts.forEach(ex=>{
        const age = now()-ex.at;
        const a = Math.max(0, 1 - age/ex.lifeMs);
        ctx.strokeStyle=`rgba(255,210,63,${a})`;
        ctx.lineWidth=6*a;
        const {sx,sy}=w2s(ex.x,ex.y);
        ctx.beginPath(); ctx.arc(sx, sy, GRENADE.blastR*SCALE(), 0, Math.PI*2); ctx.stroke();
      });

      ctx.restore();
    });

    // Desktop key support
    attachKeyCapture();
  }

  // ---------- boot ----------
  function start(){
    ensureFireBtn(); syncFireBtn();
    const tryAttach=()=>{ if(apiReady()){ attachHooks(); clearInterval(poller); } };
    const poller=setInterval(tryAttach, 80);
    if(window.IZZA && IZZA.on) IZZA.on('ready', tryAttach);
  }

  if(document.readyState==='complete' || document.readyState==='interactive'){
    start();
  }else{
    document.addEventListener('DOMContentLoaded', start, {once:true});
  }
})();
