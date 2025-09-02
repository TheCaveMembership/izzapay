// /static/game/js/plugins/guns.js
// IZZA Guns — v3.8 (iPhone-safe; FIRE higher; ammo HUD; pistol tap / uzi hold)
(function(){
  try { window.__GUNS_READY__ = false; } catch(e) {}

  function chip(txt,bg){
    try{
      var el=document.getElementById('gunsChip');
      if(!el){
        el=document.createElement('div');
        el.id='gunsChip';
        Object.assign(el.style,{
          position:'fixed',left:'10px',top:'10px',zIndex:10000,
          background:bg||'#24324a',color:'#cfe0ff',border:'1px solid #2a3550',
          borderRadius:'10px',padding:'6px 8px',fontSize:'12px',pointerEvents:'none'
        });
        document.body.appendChild(el);
      }
      el.textContent=txt; el.style.display='block';
      clearTimeout(el._t); el._t=setTimeout(()=>{ el.style.display='none'; }, 3500);
    }catch(e){}
  }

  const TUNE = {
    speedFallback: 180,
    lifeMs: 900,
    hitRadius: 16,
    pistolDelayMs: 170,
    uziIntervalMs: 90,

    // placement / sizing
    FIRE_W: 66, FIRE_H: 66,
    ABOVE_STICK_Y: -110,   // raise FIRE above joystick by 110px
    MIN_TOP: 10, RIGHT_MARGIN: 12
  };

  const bullets=[]; const copHits=new WeakMap();
  let lastPistolAt=0, uziTimer=null, fireBtn=null, ammoPill=null;
  let placeInterval=null, visInterval=null;

  const now = ()=>performance.now();
  const apiReady = ()=> !!(window.IZZA && IZZA.api && IZZA.api.ready);
  const dLE = (ax,ay,bx,by,r)=> Math.hypot(ax-bx,ay-by) <= r;

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

  function ammoFor(kind){
    const slot = readInv()[kind]; return (slot && (slot.ammo|0)) || 0;
  }
  function takeAmmo(kind){
    const inv=readInv(); const slot=inv[kind]; if(!slot) return false;
    const n=(slot.ammo|0); if(n<=0) return false;
    slot.ammo=n-1; writeInv(inv); updateAmmoHUD(); return true;
  }

  function aimVector(){
    const nub=document.getElementById('nub');
    if(nub){
      const cs=getComputedStyle(nub);
      const left=parseFloat(nub.style.left||cs.left||'40'); const top=parseFloat(nub.style.top||cs.top||'40');
      const dx=left-40, dy=top-40, m=Math.hypot(dx,dy);
      if(m>2) return {x:dx/m, y:dy/m};
    }
    if(apiReady()){
      const f=IZZA.api.player.facing;
      if(f==='left') return {x:-1,y:0};
      if(f==='right')return {x:1,y:0};
      if(f==='up')   return {x:0,y:-1};
    }
    return {x:0,y:1};
  }

  function bulletSpeed(){
    if(apiReady()){
      const cars=IZZA.api.cars; if(cars && cars.length) return (cars[0].spd||120)*1.5;
    }
    return TUNE.speedFallback;
  }

  function spawnBullet(){
    if(!apiReady()) return;
    const p=IZZA.api.player, dir=aimVector(), spd=bulletSpeed();
    bullets.push({ x:p.x+16+dir.x*18, y:p.y+16+dir.y*18, vx:dir.x*spd, vy:dir.y*spd, born:now() });
  }

  function firePistol(){
    const t=now();
    if(t-lastPistolAt < TUNE.pistolDelayMs) return;
    if(!pistolEquipped()){ chip('Equip pistol','#394769'); lastPistolAt=t; return; }
    if(!takeAmmo('pistol')){ chip('Pistol: no ammo','#5b2a2a'); lastPistolAt=t; return; }
    spawnBullet(); lastPistolAt=t;
  }

  function uziStart(){
    if(uziTimer) return;
    if(!uziEquipped()){ chip('Equip uzi','#394769'); return; }
    if(!takeAmmo('uzi')){ chip('Uzi: no ammo','#5b2a2a'); return; }
    spawnBullet();
    uziTimer=setInterval(()=>{
      if(!uziEquipped()){ uziStop(); return; }
      if(!takeAmmo('uzi')){ chip('Uzi: no ammo','#5b2a2a'); uziStop(); return; }
      spawnBullet();
    }, TUNE.uziIntervalMs);
  }
  function uziStop(){ if(uziTimer){ clearInterval(uziTimer); uziTimer=null; } }

  // ---------- UI: FIRE button (higher) + ammo pill ----------
  function ensureFireBtn(){
    if(fireBtn) return fireBtn;
    fireBtn=document.createElement('button');
    fireBtn.id='btnFire'; fireBtn.type='button'; fireBtn.textContent='FIRE';
    Object.assign(fireBtn.style,{
      position:'fixed',zIndex:1000,width:TUNE.FIRE_W+'px',height:TUNE.FIRE_H+'px',borderRadius:'50%',
      background:'#1f2a3f',color:'#cfe0ff',border:'2px solid #2a3550',fontWeight:'700',
      letterSpacing:'1px',boxShadow:'0 2px 10px rgba(0,0,0,.35)',touchAction:'none',
      display:'block',opacity:'0.55'
    });
    document.body.appendChild(fireBtn);

    // Ammo pill under the button
    ammoPill=document.createElement('div');
    Object.assign(ammoPill.style,{
      position:'fixed',zIndex:1000,minWidth:'36px',
      padding:'4px 7px',borderRadius:'10px',
      background:'#101827',color:'#cfe0ff',border:'1px solid #2a3550',
      textAlign:'center',fontSize:'12px'
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
    let top  = Math.max(TUNE.MIN_TOP, Math.round(vh*0.28)); // default: upper-middle
    if(stick){
      const r=stick.getBoundingClientRect();
      left = Math.min(vw - (TUNE.FIRE_W + TUNE.RIGHT_MARGIN), r.right + 10);
      top  = Math.max(
        TUNE.MIN_TOP,
        Math.min( r.top + TUNE.ABOVE_STICK_Y, vh - (TUNE.FIRE_H + 10) ) // place ABOVE stick
      );
    }
    fireBtn.style.left = left+'px';
    fireBtn.style.top  = top +'px';

    if(ammoPill){
      ammoPill.style.left = (left + TUNE.FIRE_W/2 - 22)+'px';
      ammoPill.style.top  = (top + TUNE.FIRE_H + 6)+'px';
    }
  }

  function syncFireBtn(){
    ensureFireBtn();
    const ek=equippedKind();
    fireBtn.disabled=!ek;
    fireBtn.style.opacity= ek ? '1' : '0.55';
    updateAmmoHUD();
  }

  function updateAmmoHUD(){
    if(!ammoPill) return;
    const ek=equippedKind();
    if(!ek){ ammoPill.textContent='—'; ammoPill.style.opacity='0.6'; return; }
    const n=ammoFor(ek);
    ammoPill.textContent = (ek==='uzi'?'Uzi ':'Pstl ')+n;
    ammoPill.style.opacity='1';
  }

  // ---------- Hooks ----------
  function attachHooks(){
    IZZA.on('update-post', ({dtSec})=>{
      syncFireBtn();

      for(let i=bullets.length-1;i>=0;i--){
        const b=bullets[i];
        b.x+=b.vx*dtSec; b.y+=b.vy*dtSec;
        if(now()-b.born > TUNE.lifeMs){ bullets.splice(i,1); continue; }

        let didHit=false;
        // peds: 1 hit
        for(const p of IZZA.api.pedestrians){
          if(p.state==='blink') continue;
          if(dLE(b.x,b.y,p.x+16,p.y+16,TUNE.hitRadius)){
            p.state='blink'; p.blinkT=0.3;
            if(IZZA.api.player.wanted<5) IZZA.api.setWanted(IZZA.api.player.wanted+1);
            didHit=true; break;
          }
        }
        if(didHit){ bullets.splice(i,1); continue; }

        // cops: 2 hits
        for(const c of IZZA.api.cops){
          if(dLE(b.x,b.y,c.x+16,c.y+16,TUNE.hitRadius)){
            const n=(copHits.get(c)||0)+1; copHits.set(c,n);
            if(n>=2){
              const idx=IZZA.api.cops.indexOf(c); if(idx>=0) IZZA.api.cops.splice(idx,1);
              IZZA.api.setWanted(IZZA.api.player.wanted-1);
              const DROP_GRACE_MS=1000, DROP_OFFSET=18;
              const cx=c.x+16, cy=c.y+16;
              const dx=cx-IZZA.api.player.x, dy=cy-IZZA.api.player.y;
              const m=Math.hypot(dx,dy)||1, ux=dx/m, uy=dy/m;
              const pos={ x:cx+ux*DROP_OFFSET, y:cy+uy*DROP_OFFSET };
              const t=performance.now();
              IZZA.emit('cop-killed',{cop:c,x:pos.x,y:pos.y,droppedAt:t,noPickupUntil:t+DROP_GRACE_MS});
            }
            didHit=true; break;
          }
        }
        if(didHit){ bullets.splice(i,1); continue; }
      }
    });

    IZZA.on('render-post', ()=>{
      const cvs=document.getElementById('game'); if(!cvs) return;
      const ctx=cvs.getContext('2d');
      const SCALE=IZZA.api.DRAW/IZZA.api.TILE;
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
    chip('Guns plugin loaded','#1e2a42');
    ensureFireBtn(); syncFireBtn();

    if(visInterval) clearInterval(visInterval);
    visInterval=setInterval(syncFireBtn, 800);

    const tryAttach = ()=>{
      if(!apiReady()) return;
      try{
        attachHooks();
        chip('Guns ready','#274f2d');
        window.__GUNS_READY__=true;
        clearInterval(poller);
      }catch(e){
        console.error('[guns] attach failed',e);
        chip('Guns failed: '+e.message,'#5b2a2a');
        clearInterval(poller);
      }
    };
    const poller=setInterval(tryAttach, 80);
    if(window.IZZA && IZZA.on) IZZA.on('ready', tryAttach);
  }

  if(document.readyState==='complete' || document.readyState==='interactive'){
    start();
  }else{
    document.addEventListener('DOMContentLoaded', start, {once:true});
  }
})();
