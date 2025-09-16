// IZZA Guns — v6.0 (extends v5.3 non-destructively)
// pistols + uzi + grenades  ➕ crafted guns + crafted melee (swing)
// - Works alongside armour packs; melee does NOT occupy/remove the "arms" armour slot.
// - Crafted weapons are detected in inventory entries shaped like:
//     { name, type:'weapon', subtype:'gun'|'melee', equipped:true, iconSvg?:string, ammo?:number }
//   (This is what Crafting Land should inject via ArmourPacks.injectCraftedItem for weapons.)
(function(){
  // ---- tunables / layout ----
  const TUNE = {
    speedFallback: 180,
    lifeMs: 900,
    hitRadius: 16,
    pistolDelayMs: 170,
    uziIntervalMs: 90,
    FIRE_W: 66, FIRE_H: 66,
    ABOVE_STICK_Y: -160,
    MIN_TOP: 10, RIGHT_MARGIN: 12,

    // grenades
    grenadeThrowSpd: 210,
    grenadeFuseMs: 900,
    grenadeBlastR: 64,
    grenadeShockMs: 220,

    // crafted gun defaults
    craftedGunDelayMs: 160,      // between shots (if no per-item override)
    craftedGunBulletLifeMs: 900, // same as default

    // melee
    meleeSwingMs: 240,           // duration of one swing
    meleeReach: 34,              // how far in front the hit happens
    meleeArcDeg: 85              // swing arc (visual + hit sampling)
  };

  const POINT_BLANK_R = 24;
  const DROP_GRACE_MS = 1000;
  const DROP_OFFSET   = 18;

  const bullets  = []; // {x,y,vx,vy,born}
  const grenades = []; // {x,y,vx,vy,born}
  const blasts   = []; // {x,y,born}
  const swings   = []; // {born, dir:{x,y}}  // transient melee swing FX
  const copHits  = new WeakMap();

  let lastPistolAt = 0, lastCraftGunAt = 0, uziTimer = null;
  let fireBtn=null, ammoPill=null, visInterval=null, placeInterval=null, hidePoller=null;

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
      try{ window.dispatchEvent(new Event('izza-inventory-changed')); }catch{}
    }catch{}
  }

  // vanilla weapons
  const pistolEquipped = ()=> !!(readInv().pistol && readInv().pistol.equipped);
  const uziEquipped    = ()=> !!(readInv().uzi && readInv().uzi.equipped);
  const grenadeEquipped= ()=> !!(readInv().grenade && readInv().grenade.equipped);

  // ----- crafted weapons (from Crafting Land / ArmourPacks.injectCraftedItem) -----
  function listCrafted(kind){ // kind: 'gun' | 'melee'
    const inv = readInv();
    const out=[];
    for(const k in inv){
      const it = inv[k];
      if(!it || typeof it!=='object') continue;
      // allow subtype OR kind field; be permissive
      const t = (it.type||'').toLowerCase();
      const sub = (it.subtype||it.kind||'').toLowerCase();
      if(t==='weapon' && sub===kind) out.push({key:k, it});
    }
    return out;
  }
  function equippedCrafted(kind){
    const L = listCrafted(kind);
    for(const e of L){ if(e.it.equipped) return e; }
    return null;
  }
  const craftedGunEquipped   = ()=> equippedCrafted('gun');   // {key,it} | null
  const craftedMeleeEquipped = ()=> equippedCrafted('melee'); // {key,it} | null

  const anyCraftedEquipped   = ()=> craftedGunEquipped() || craftedMeleeEquipped();

  // unified "what’s in the player’s hands"
  function equippedKind(){
    // custom crafted takes precedence over stock (your UX likely equips one at a time)
    if(craftedGunEquipped())   return 'cgun';
    if(pistolEquipped())       return 'pistol';
    if(uziEquipped())          return 'uzi';
    if(grenadeEquipped())      return 'grenade';
    if(craftedMeleeEquipped()) return 'melee';
    return null;
  }

  function ammoFor(kind){
    const inv = readInv();
    if(kind==='grenade'){
      const g=inv.grenade; return (g && (g.count|0)) || 0;
    }
    if(kind==='cgun'){
      const cg = craftedGunEquipped();
      if(!cg) return 0;
      // default “infinite” (display  ∞ ), unless a numeric ammo is present
      const a = cg.it.ammo;
      return (typeof a==='number') ? Math.max(0, a|0) : Infinity;
    }
    const s=inv[kind]; return (s && (s.ammo|0)) || 0;
  }

  function takeAmmo(kind){
    const inv = readInv();
    if(kind==='grenade'){
      inv.grenade = inv.grenade || {equipped:false,count:0};
      const n=inv.grenade.count|0; if(n<=0) return false;
      inv.grenade.count = n-1; writeInv(inv);
      updateAmmoHUD(); patchInventoryGrenadeCount(inv.grenade.count);
      return true;
    }
    if(kind==='cgun'){
      const cg = craftedGunEquipped(); if(!cg) return false;
      // if ammo undefined => infinite shots (no decrement)
      if(typeof cg.it.ammo!=='number'){ updateAmmoHUD(); return true; }
      const n=cg.it.ammo|0; if(n<=0) return false;
      cg.it.ammo = n-1; inv[cg.key]=cg.it; writeInv(inv);
      updateAmmoHUD(); patchInventoryCraftedAmmo(cg.key, cg.it.ammo);
      return true;
    }
    const slot = inv[kind]; if(!slot) return false;
    const n = (slot.ammo|0); if(n<=0) return false;
    slot.ammo = n-1; writeInv(inv);
    updateAmmoHUD(); patchInventoryAmmo(kind, slot.ammo);
    return true;
  }

  // ----- inventory label patchers (best-effort, only when panel is open) -----
  function patchInventoryAmmo(kind, value){
    try{
      const host = document.getElementById('invPanel');
      if(!host || host.style.display==='none') return;
      const label = (kind==='uzi' ? 'Uzi' : 'Pistol');
      host.querySelectorAll('.inv-item').forEach(row=>{
        if(row.textContent.includes(label) && row.textContent.includes('Ammo:')){
          row.querySelectorAll('div').forEach(m=>{
            if(/Ammo:\s*\d+/.test(m.textContent)){
              m.textContent = m.textContent.replace(/Ammo:\s*\d+/, `Ammo: ${value}`);
            }
          });
        }
      });
    }catch{}
  }
  function patchInventoryCraftedAmmo(invKey, value){
    try{
      const host = document.getElementById('invPanel');
      if(!host || host.style.display==='none') return;
      const row = [...host.querySelectorAll('.inv-item')].find(r => r.dataset?.key===invKey);
      if(!row) return;
      row.querySelectorAll('div').forEach(m=>{
        if(/Ammo:\s*\d+/.test(m.textContent)){
          m.textContent = m.textContent.replace(/Ammo:\s*\d+/, `Ammo: ${value}`);
        }
      });
    }catch{}
  }
  function patchInventoryGrenadeCount(value){
    try{
      const host = document.getElementById('invPanel');
      if(!host || host.style.display==='none') return;
      host.querySelectorAll('.inv-item').forEach(row=>{
        if(/Grenades/i.test(row.textContent) && /Count:\s*\d+/.test(row.textContent)){
          row.querySelectorAll('div').forEach(m=>{
            if(/Count:\s*\d+/.test(m.textContent)){
              m.textContent = m.textContent.replace(/Count:\s*\d+/, `Count: ${value}`);
            }
          });
        }
      });
    }catch{}
  }

  // Inject a single Equip/Unequip button for the Grenades row when the panel OPENS.
  function ensureGrenadeEquipButton(){
    try{
      const host = document.getElementById('invPanel');
      if(!host || host.style.display==='none') return;

      const row = [...host.querySelectorAll('.inv-item')].find(r => /Grenades/i.test(r.textContent));
      if(!row) return;

      let btn = row.querySelector('[data-g-equip]');
      if(!btn){
        btn = document.createElement('button');
        btn.className='pill ghost';
        btn.setAttribute('data-g-equip','1');
        btn.style.marginLeft='auto';
        row.appendChild(btn);
      }
      const inv=readInv(); inv.grenade = inv.grenade || {equipped:false,count:(inv.grenade?.count|0)};
      btn.textContent = inv.grenade.equipped ? 'Unequip' : 'Equip';
      btn.onclick = ()=>{
        const i=readInv(); i.grenade = i.grenade || {equipped:false,count:(i.grenade?.count|0)};
        i.grenade.equipped = !i.grenade.equipped;
        // equipping grenades just unequips firearms (NOT armour arms pieces)
        if(i.grenade.equipped){
          if(i.pistol) i.pistol.equipped=false;
          if(i.uzi) i.uzi.equipped=false;
          const cg = craftedGunEquipped(); if(cg) i[cg.key].equipped=false;
        }
        writeInv(i);
        btn.textContent = i.grenade.equipped ? 'Unequip' : 'Equip';
        syncFireBtn();
      };
    }catch{}
  }

  // ---------- aim + projectile / grenade ----------
  function aimVector(){
    const nub=document.getElementById('nub');
    if(nub){
      const cs=getComputedStyle(nub);
      const left=parseFloat(nub.style.left||cs.left||'40');
      const top =parseFloat(nub.style.top ||cs.top ||'40');
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

  // ---------- loot helpers ----------
  function dropFromCop(c){
    const cx=c.x+16, cy=c.y+16;
    const dx=cx-IZZA.api.player.x, dy=cy-IZZA.api.player.y;
    const m=Math.hypot(dx,dy)||1, ux=dx/m, uy=dy/m;
    const pos={ x:cx+ux*DROP_OFFSET, y:cy+uy*DROP_OFFSET };
    const t=now();
    IZZA.emit('cop-killed',{cop:c,x:pos.x,y:pos.y,droppedAt:t,noPickupUntil:t+DROP_GRACE_MS});
  }
  function dropFromPed(px,py){
    const dx=px-IZZA.api.player.x, dy=py-IZZA.api.player.y;
    const m=Math.hypot(dx,dy)||1, ux=dx/m, uy=dy/m;
    const pos={ x:px+ux*DROP_OFFSET, y:py+uy*DROP_OFFSET };
    const t=now();
    IZZA.emit('ped-killed',{coins:25,x:pos.x,y:pos.y,droppedAt:t,noPickupUntil:t+DROP_GRACE_MS});
  }

  // ---------- cops helpers ----------
  function spawnCop(kind){
    const cvs=document.getElementById('game'); if(!cvs) return;
    const S=SCALE(), cam=IZZA.api.camera, t=IZZA.api.TILE;
    const viewW = cvs.width / S, viewH = cvs.height / S;
    const edges = [
      { x: cam.x - 3*t,                 y: cam.y + Math.random()*viewH },
      { x: cam.x + viewW + 3*t,         y: cam.y + Math.random()*viewH },
      { x: cam.x + Math.random()*viewW, y: cam.y - 3*t },
      { x: cam.x + Math.random()*viewW, y: cam.y + viewH + 3*t }
    ];
    const pos = edges[(Math.random()*edges.length)|0];

    const spd = kind==='army' ? 95 : kind==='swat' ? 90 : 80;
    const hp  = kind==='army' ? 6  : kind==='swat' ? 5  : 4;
    IZZA.api.cops.push({ x: pos.x, y: pos.y, spd, hp, kind, reinforceAt: now()+30000, facing:'down' });
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
  function bumpWanted(){
    IZZA.api.setWanted((IZZA.api.player.wanted|0)+1);
    ensureCops();
  }

  // ---------- impacts ----------
  function applyImpactAt(x, y){
    for(const c of IZZA.api.cops){
      if(Math.hypot(x-(c.x+16), y-(c.y+16)) <= POINT_BLANK_R){
        const n=(copHits.get(c)||0)+1; copHits.set(c,n);
        if(n>=2){
          const idx=IZZA.api.cops.indexOf(c); if(idx>=0) IZZA.api.cops.splice(idx,1);
          IZZA.api.setWanted((IZZA.api.player.wanted|0)-1);
          ensureCops(); dropFromCop(c);
        }
        return true;
      }
    }
    for(const p of IZZA.api.pedestrians){
      if(p.state==='blink') continue;
      if(Math.hypot(x-(p.x+16), y-(p.y+16)) <= POINT_BLANK_R){
        p.state='blink'; p.blinkT=0.3;
        if((IZZA.api.player.wanted|0) < 5) bumpWanted();
        return true;
      }
    }
    return false;
  }

  // ---------- projectile / grenade spawn ----------
  function spawnBulletOrPointBlank(){
    const p=IZZA.api.player, dir=aimVector();
    const playerCX = p.x+16, playerCY = p.y+16;

    if(applyImpactAt(playerCX, playerCY)){ return false; }

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
  function throwGrenade(){
    if(!takeAmmo('grenade')) return;
    const p=IZZA.api.player, dir=aimVector();
    const playerCX = p.x+16, playerCY = p.y+16;
    grenades.push({
      x: playerCX + dir.x*12,
      y: playerCY + dir.y*12,
      vx: dir.x*TUNE.grenadeThrowSpd,
      vy: dir.y*TUNE.grenadeThrowSpd,
      born: now()
    });
  }

  // ---------- crafted gun & melee actions ----------
  function fireCraftedGun(){
    const t=now();
    const cg = craftedGunEquipped(); if(!cg) return;
    const delay = Math.max(80, cg.it.fireDelayMs|0 || TUNE.craftedGunDelayMs);
    if(t-lastCraftGunAt < delay) return;
    if(!takeAmmo('cgun')){ lastCraftGunAt=t; return; }
    spawnBulletOrPointBlank(); lastCraftGunAt=t;
  }

  function startMeleeSwing(){
    const m = craftedMeleeEquipped(); if(!m) return;
    // start a swing; damage is applied during update tick by sampling along arc
    swings.push({ born: now(), dir: aimVector() });
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

  // ---------- UI: FIRE + ammo pill ----------
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

    const down=(ev)=>{
      ev.preventDefault(); ev.stopPropagation();
      const k=equippedKind(); if(!k) return;
      if(k==='uzi'){ uziStart(); }
      else if(k==='pistol'){ firePistol(); }
      else if(k==='grenade'){ throwGrenade(); }
      else if(k==='cgun'){ fireCraftedGun(); }
      else if(k==='melee'){ startMeleeSwing(); }
    };
    const up  =(ev)=>{ ev.preventDefault(); ev.stopPropagation(); uziStop(); };
    fireBtn.addEventListener('pointerdown',down,{passive:false});
    fireBtn.addEventListener('pointerup',  up,  {passive:false});
    fireBtn.addEventListener('touchstart',down,{passive:false});
    fireBtn.addEventListener('touchend',  up,  {passive:false});
    fireBtn.addEventListener('mousedown', down,{passive:false});
    fireBtn.addEventListener('mouseup',   up,  {passive:false});

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
    let top  = Math.max(TUNE.MIN_TOP, Math.round(vh*0.22));
    if(stick){
      const r=stick.getBoundingClientRect();
      left = Math.min(vw - (TUNE.FIRE_W + TUNE.RIGHT_MARGIN), r.right + 10);
      top  = Math.max(TUNE.MIN_TOP, Math.min(r.top + TUNE.ABOVE_STICK_Y, vh - (TUNE.FIRE_H + 10)));
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
    const label = ek==='uzi'    ? 'Uzi '
                : ek==='pistol' ? 'Pstl '
                : ek==='grenade'? 'Grnd '
                : ek==='cgun'   ? 'Gun  '
                :                 'Mlee ';
    ammoPill.textContent = (n===Infinity) ? (label+'∞') : (label + n);
    ammoPill.style.opacity='1';
  }
  function syncFireBtn(){
    ensureFireBtn();
    const ek=equippedKind();
    fireBtn.disabled=!ek;
    fireBtn.style.opacity = ek ? '1' : '0.55';
    updateAmmoHUD();
  }

  // Hide FIRE when any modal/popup is visible; restore automatically.
  const POPUP_IDS = ['enterModal','shopModal','hospitalShop','invPanel','mapModal','mpLobby','m3Modal','m2Modal'];
  function anyPopupOpen(){
    return POPUP_IDS.some(id=>{
      const el=document.getElementById(id);
      return el && el.style && el.style.display && el.style.display!=='none';
    });
  }
  function startHidePoller(){
    if(hidePoller) clearInterval(hidePoller);
    hidePoller = setInterval(()=>{
      if(!fireBtn) return;
      const show = !anyPopupOpen();
      fireBtn.style.display = show ? 'block' : 'none';
      if(ammoPill) ammoPill.style.display = show ? 'block' : 'none';
    }, 150);
  }

  // ---------- key capture (desktop) ----------
  function attachKeyCapture(){
    const onDownCapture = (e)=>{
      const k=(e.key||'').toLowerCase(); if(k!=='a') return;
      if(anyPopupOpen()) return; // respect hidden state
      const ek=equippedKind(); if(!ek) return;
      e.preventDefault(); e.stopImmediatePropagation(); e.stopPropagation();
      if(ek==='uzi'){ if(!uziTimer) uziStart(); }
      else if(ek==='pistol'){ firePistol(); }
      else if(ek==='grenade'){ throwGrenade(); }
      else if(ek==='cgun'){ fireCraftedGun(); }
      else if(ek==='melee'){ startMeleeSwing(); }
    };
    const onUpCapture = (e)=>{
      const k=(e.key||'').toLowerCase(); if(k!=='a') return;
      if(uziTimer) uziStop();
      e.preventDefault(); e.stopImmediatePropagation(); e.stopPropagation();
    };
    window.addEventListener('keydown', onDownCapture, {capture:true, passive:false});
    window.addEventListener('keyup',   onUpCapture,   {capture:true, passive:false});
  }

  // ---------- hooks ----------
  function attachHooks(){
    // keep button/hud in sync
    if(visInterval) clearInterval(visInterval);
    visInterval=setInterval(()=>{ syncFireBtn(); }, 600);

    startHidePoller();

    IZZA.on('wanted-changed', ()=> ensureCops());

    IZZA.on('update-post', ({dtSec})=>{
      // bullets
      for(let i=bullets.length-1;i>=0;i--){
        const b=bullets[i];
        b.x+=b.vx*dtSec; b.y+=b.vy*dtSec;
        if(now()-b.born > (b.lifeMs||TUNE.lifeMs)){ bullets.splice(i,1); continue; }

        let hit=false;
        for(const p of IZZA.api.pedestrians){
          if(p.state==='blink') continue;
          if(distLE(b.x,b.y,p.x+16,p.y+16,TUNE.hitRadius)){
            p.state='blink'; p.blinkT=0.3; if((IZZA.api.player.wanted|0) < 5){ bumpWanted(); }
            hit=true; break;
          }
        }
        if(hit){ bullets.splice(i,1); continue; }

        for(const c of IZZA.api.cops){
          if(distLE(b.x,b.y,c.x+16,c.y+16,TUNE.hitRadius)){
            const n=(copHits.get(c)||0)+1; copHits.set(c,n);
            if(n>=2){
              const idx=IZZA.api.cops.indexOf(c); if(idx>=0) IZZA.api.cops.splice(idx,1);
              IZZA.api.setWanted((IZZA.api.player.wanted|0)-1);
              ensureCops(); dropFromCop(c);
            }
            hit=true; break;
          }
        }
        if(hit){ bullets.splice(i,1); continue; }
      }

      // grenades
      for(let i=grenades.length-1;i>=0;i--){
        const g=grenades[i];
        g.x+=g.vx*dtSec; g.y+=g.vy*dtSec;
        g.vx*=0.96; g.vy*=0.96;
        if(now()-g.born >= TUNE.grenadeFuseMs){
          blasts.push({x:g.x,y:g.y,born:now()});
          const R=TUNE.grenadeBlastR;

          // pedestrians — eliminate and DROP LOOT
          for(let j=IZZA.api.pedestrians.length-1;j>=0;j--){
            const p=IZZA.api.pedestrians[j];
            if(p.state==='blink') continue;
            if(distLE(g.x,g.y,p.x+16,p.y+16,R)){
              dropFromPed(p.x+16, p.y+16);
              IZZA.api.pedestrians.splice(j,1);
              if((IZZA.api.player.wanted|0) < 5){ bumpWanted(); }
            }
          }
          // cops/swat/army — eliminate and DROP LOOT
          for(let j=IZZA.api.cops.length-1;j>=0;j--){
            const c=IZZA.api.cops[j];
            if(distLE(g.x,g.y,c.x+16,c.y+16,R)){
              dropFromCop(c);
              IZZA.api.cops.splice(j,1);
              IZZA.api.setWanted((IZZA.api.player.wanted|0)-1);
              ensureCops();
            }
          }
          grenades.splice(i,1);
        }
      }

      // blasts decay
      for(let i=blasts.length-1;i>=0;i--){
        if(now()-blasts[i].born > TUNE.grenadeShockMs) blasts.splice(i,1);
      }

      // melee swings: apply hit samples along an arc in front of player
      for(let i=swings.length-1;i>=0;i--){
        const s = swings[i];
        const age = now()-s.born;
        if(age > TUNE.meleeSwingMs){ swings.splice(i,1); continue; }

        const p=IZZA.api.player;
        const baseAngle = Math.atan2(s.dir.y, s.dir.x);
        const prog = age / TUNE.meleeSwingMs; // 0..1
        const swingAngle = baseAngle + (prog-0.5) * (TUNE.meleeArcDeg*Math.PI/180);
        const px = p.x+16 + Math.cos(swingAngle) * TUNE.meleeReach;
        const py = p.y+16 + Math.sin(swingAngle) * TUNE.meleeReach;

        // apply impact at sample point (same damage rules as point-blank)
        applyImpactAt(px, py);
      }
    });

    // Render (keeps your existing bullet/grenade FX and shows a faint swing arc)
    IZZA.on('render-post', ()=>{
      const cvs=document.getElementById('game'); if(!cvs) return;
      const ctx=cvs.getContext('2d'); ctx.save(); ctx.imageSmoothingEnabled=false;

      ctx.fillStyle='#000';
      for(const b of bullets){ const {sx,sy}=w2s(b.x,b.y); ctx.fillRect(sx-2, sy-2, 4, 4); }

      ctx.fillStyle='#6fbf6f';
      for(const g of grenades){ const {sx,sy}=w2s(g.x,g.y); ctx.fillRect(sx-3, sy-3, 6, 6); }

      for(const bl of blasts){
        const age = now()-bl.born;
        const a = Math.max(0, 1 - age/TUNE.grenadeShockMs);
        const {sx,sy}=w2s(bl.x,bl.y);
        ctx.strokeStyle=`rgba(255,230,130,${a})`;
        ctx.lineWidth=2;
        ctx.beginPath(); ctx.arc(sx,sy, TUNE.grenadeBlastR*SCALE(), 0, Math.PI*2); ctx.stroke();
      }

      // draw melee swing arc (visual cue; does NOT touch armour overlays)
      for(const s of swings){
        const p=IZZA.api.player;
        const baseAngle = Math.atan2(s.dir.y, s.dir.x);
        const age = now()-s.born, prog=Math.min(1,age/TUNE.meleeSwingMs);
        const ang = baseAngle + (prog-0.5) * (TUNE.meleeArcDeg*Math.PI/180);
        const cx = p.x+16, cy=p.y+16;
        const {sx,sy}=w2s(cx,cy);
        ctx.strokeStyle='rgba(230,230,255,0.35)';
        ctx.lineWidth=3;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(sx + Math.cos(ang)*TUNE.meleeReach*SCALE(), sy + Math.sin(ang)*TUNE.meleeReach*SCALE());
        ctx.stroke();
      }

      ctx.restore();
    });

    // inventory open/close observer (style attribute only — avoids mutation storms)
    const host = document.getElementById('invPanel');
    if(host){
      new MutationObserver((muts)=>{
        for(const m of muts){
          if(m.attributeName==='style' && host.style.display!=='none'){
            setTimeout(ensureGrenadeEquipButton, 0);
          }
        }
      }).observe(host, {attributes:true, attributeFilter:['style']});
    }

    // desktop key
    attachKeyCapture();
  }

  // ---------- boot ----------
  function start(){
    ensureFireBtn(); syncFireBtn();
    const tryAttach=()=>{ if(apiReady()){ attachHooks(); clearInterval(poller); } };
    const poller=setInterval(tryAttach, 80);
    if(window.IZZA && IZZA.on) IZZA.on('ready', tryAttach);
  }

  if(document.readyState==='complete' || document.readyState==='interactive') start();
  else document.addEventListener('DOMContentLoaded', start, {once:true});
})();
