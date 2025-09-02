// /static/game/plugins/guns.js
// IZZA Guns — v4.2 (cops spawn on wanted change + live ammo update in opened inventory)
(function(){
  // ---- tunables / layout ----
  const TUNE = {
    speedFallback: 180,
    lifeMs: 900,
    hitRadius: 16,
    pistolDelayMs: 170,
    uziIntervalMs: 90,
    FIRE_W: 66, FIRE_H: 66,
    ABOVE_STICK_Y: -110, MIN_TOP: 10, RIGHT_MARGIN: 12
  };

  const bullets = [];
  const copHits = new WeakMap();
  let lastPistolAt = 0, uziTimer = null;
  let fireBtn=null, ammoPill=null, visInterval=null, placeInterval=null;

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
      // Find the row that mentions the weapon name and has an "Ammo:" snippet
      const label = (kind==='uzi' ? 'Uzi' : 'Pistol');
      const rows = host.querySelectorAll('.inv-item');
      rows.forEach(row=>{
        if(row.textContent.includes(label) && row.textContent.includes('Ammo:')){
          // find the small meta div and replace number after "Ammo:"
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
  function spawnBullet(){
    const p=IZZA.api.player, dir=aimVector(), spd=bulletSpeed();
    bullets.push({ x:p.x+16+dir.x*18, y:p.y+16+dir.y*18, vx:dir.x*spd, vy:dir.y*spd, born:now() });
  }

  // ---------- firing ----------
  function firePistol(){
    const t=now();
    if(t-lastPistolAt < TUNE.pistolDelayMs) return;
    if(!pistolEquipped()) return;
    if(!takeAmmo('pistol')){ lastPistolAt=t; return; }
    spawnBullet(); lastPistolAt=t;
  }
  function uziStart(){
    if(uziTimer || !uziEquipped()) return;
    if(!takeAmmo('uzi')) return;
    spawnBullet();
    uziTimer=setInterval(()=>{
      if(!uziEquipped()){ uziStop(); return; }
      if(!takeAmmo('uzi')){ uziStop(); return; }
      spawnBullet();
    }, TUNE.uziIntervalMs);
  }
  function uziStop(){ if(uziTimer){ clearInterval(uziTimer); uziTimer=null; } }

  // ---------- cops: mirror maintainCops behavior ----------
  function spawnCop(kind){
    // spawn just off current camera edges so they walk in naturally
    const cvs=document.getElementById('game'); if(!cvs) return;
    const S=SCALE(), cam=IZZA.api.camera, t=IZZA.api.TILE;
    const viewW = cvs.width / S, viewH = cvs.height / S;
    const edges = [
      { x: cam.x - 3*t,               y: cam.y + Math.random()*viewH }, // left
      { x: cam.x + viewW + 3*t,       y: cam.y + Math.random()*viewH }, // right
      { x: cam.x + Math.random()*viewW, y: cam.y - 3*t },               // top
      { x: cam.x + Math.random()*viewW, y: cam.y + viewH + 3*t }        // bottom
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
    return fireBtn;
  }
  function positionFire(){
    if(!fireBtn) return;
    const stick=document.getElementById('stick');
    const vw=innerWidth, vh=innerHeight;
    let left = vw - (TUNE.FIRE_W + TUNE.RIGHT_MARGIN);
    let top  = Math.max(TUNE.MIN_TOP, Math.round(vh*0.28));
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
  }
  function updateAmmoHUD(){
    if(!ammoPill) return;
    const ek=equippedKind();
    if(!ek){ ammoPill.textContent='—'; ammoPill.style.opacity='0.6'; return; }
    const n=ammoFor(ek);
    ammoPill.textContent = (ek==='uzi'?'Uzi ':'Pstl ')+n;
    ammoPill.style.opacity='1';
  }
  function syncFireBtn(){
    ensureFireBtn();
    const ek=equippedKind();
    fireBtn.disabled=!ek;
    fireBtn.style.opacity = ek ? '1' : '0.55';
    updateAmmoHUD();
  }

  // ---------- hooks ----------
  function attachHooks(){
    // Keep button/hud in sync
    if(visInterval) clearInterval(visInterval);
    visInterval=setInterval(syncFireBtn, 700);

    // If someone else changes wanted, we still mirror cop count
    IZZA.on('wanted-changed', ()=> ensureCops());

    // Sim update
    IZZA.on('update-post', ({dtSec})=>{
      // position/sync UI (low-cost)
      syncFireBtn();

      for(let i=bullets.length-1;i>=0;i--){
        const b=bullets[i];
        b.x+=b.vx*dtSec; b.y+=b.vy*dtSec;
        if(now()-b.born > TUNE.lifeMs){ bullets.splice(i,1); continue; }

        let hitSomething=false;

        // Peds: 1 hit + raise wanted (and spawn units)
        for(const p of IZZA.api.pedestrians){
          if(p.state==='blink') continue;
          if(distLE(b.x,b.y,p.x+16,p.y+16,TUNE.hitRadius)){
            p.state='blink'; p.blinkT=0.3;
            if((IZZA.api.player.wanted|0) < 5){ bumpWanted(); } // ensures cops appear
            hitSomething=true; break;
          }
        }
        if(hitSomething){ bullets.splice(i,1); continue; }

        // Cops: need 2 hits to eliminate
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
    });

    // Render: small black squares
    IZZA.on('render-post', ()=>{
      const cvs=document.getElementById('game'); if(!cvs) return;
      const ctx=cvs.getContext('2d'); ctx.save();
      ctx.imageSmoothingEnabled=false; ctx.fillStyle='#000';
      for(const b of bullets){
        const {sx,sy}=w2s(b.x,b.y);
        ctx.fillRect(sx-2, sy-2, 4, 4);
      }
      ctx.restore();
    });
  }

  // ---------- boot ----------
  function start(){
    ensureFireBtn(); syncFireBtn();
    // wait for core, then attach
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
