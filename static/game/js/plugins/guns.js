// IZZA Guns — v6.0 (creator weapons + melee swing, preserves v5.3 behavior)
// pistols + uzi + grenades + creator guns/melee, resilient FIRE/HUD, cops balance

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

    // creator guns defaults (when not specified on the item)
    creatorGun: {
      fireIntervalMs: 170,   // like pistol by default
      bulletSpeedMul: 1.0,   // 1.0 => same as bulletSpeed()
      ammoPerBuy: 60
    },

    // grenades
    grenadeThrowSpd: 210,
    grenadeFuseMs: 900,
    grenadeBlastR: 64,
    grenadeShockMs: 220,

    // melee
    meleeSwingMs: 220,
    meleeArcDeg: 80,
    meleeRange: 36
  };
  const POINT_BLANK_R = 24;
  const DROP_GRACE_MS = 1000;
  const DROP_OFFSET   = 18;

  const bullets  = []; // {x,y,vx,vy,born}
  const grenades = []; // {x,y,vx,vy,born}
  const blasts   = []; // {x,y,born}
    const copHits  = new WeakMap();

  // FX buffer for short-lived hit visuals (only for crafted creator guns)
  const fxEvents = []; // {x,y,type,born}
  

  // creator guns + legacy pistols/uzis
  let lastPistolAt = 0, uziTimer = null;
  let creatorAutoTimer = null;
  let lastCreatorShotAt = 0;

  // melee swing state
  let meleeSwinging = false, meleeSwingBorn = 0;

  let fireBtn=null, ammoPill=null, visInterval=null, placeInterval=null, hidePoller=null;

  const now = ()=>performance.now();
  const apiReady = ()=> !!(window.IZZA && IZZA.api && IZZA.api.ready);
  const SCALE = ()=> IZZA.api.DRAW / IZZA.api.TILE;
  const w2s = (x,y)=>({ sx:(x-IZZA.api.camera.x)*SCALE(), sy:(y-IZZA.api.camera.y)*SCALE() });
  const distLE = (ax,ay,bx,by,r)=> Math.hypot(ax-bx, ay-by) <= r;
  const clamp = (v, lo, hi)=> Math.max(lo, Math.min(hi, v));

// --- tracer style tuning (intensity + colors) ---
const TRACER = {
  fire: {
    tailMul: 0.06, count: 5, coreR: 3.2, glowR: 7.5, baseA: 0.75,
    colors: {
      glow0: 'rgba(255,180,60,',  // inner glow
      glow1: 'rgba(255,120,40,',  // mid glow
      core:  'rgba(255,210,120,', // hot core
      streak:'rgba(255,140,60,'   // short head streak
    }
  },
  neon: {
    tailMul: 0.055, count: 5, coreR: 3.0, glowR: 7.2, baseA: 0.70,
    colors: {
      glow0: 'rgba(140,255,240,',
      glow1: 'rgba( 80,255,220,',
      core:  'rgba(200,255,255,',
      streak:'rgba(120,255,230,'
    }
  },
  spark: {
    tailMul: 0.045, count: 4, coreR: 2.4, glowR: 5.8, baseA: 0.65,
    colors: {
      glow0: 'rgba(240,240,255,',
      glow1: 'rgba(200,210,255,',
      core:  'rgba(255,255,255,',
      streak:'rgba(220,230,255,'
    }
  },
  ice: {
    tailMul: 0.055, count: 5, coreR: 3.0, glowR: 7.0, baseA: 0.70,
    colors: {
      glow0: 'rgba(200,235,255,',
      glow1: 'rgba(160,220,255,',
      core:  'rgba(255,255,255,',
      streak:'rgba(170,220,255,'
    }
  },
  acid: {
    tailMul: 0.055, count: 5, coreR: 3.0, glowR: 7.0, baseA: 0.72,
    colors: {
      glow0: 'rgba(170,255,120,',
      glow1: 'rgba(110,255, 90,',
      core:  'rgba(230,255,170,',
      streak:'rgba(150,255,110,'
    }
  }
};
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

  // legacy flags
  const pistolEquipped = ()=> !!(readInv().pistol && readInv().pistol.equipped);
  const uziEquipped    = ()=> !!(readInv().uzi && readInv().uzi.equipped);
  const grenadeEquipped= ()=> !!(readInv().grenade && readInv().grenade.equipped);

  // ---- NEW: creator weapon detection ---------------------------------------
  function firstEquippedCreatorGun(){
    const inv = readInv();
    for (const k in inv){
      const it = inv[k];
      if(!it || !it.equipped) continue;
      if(it.type==='weapon' && (it.subtype==='gun' || it.gun===true)){
        // normalize defaults
        it.ammo = (it.ammo|0);
        it.fireIntervalMs = clamp(parseInt(it.fireIntervalMs||TUNE.creatorGun.fireIntervalMs,10)||TUNE.creatorGun.fireIntervalMs, 60, 800);
        it.bulletSpeedMul = Math.max(0.4, Math.min(2.2, Number(it.bulletSpeedMul||TUNE.creatorGun.bulletSpeedMul)));
        return {key:k, it};
      }
    }
    return null;
  }
  function meleeEquippedItem(){
  const inv = readInv();
  const isBasicMelee = (k, it)=>{
    const name = (it && (it.name||it.title||k)||'').toLowerCase();
    // expand as needed (bat, knuckles out of the box)
    return /(bat|knuckle|brass knuckle)/i.test(name);
  };
  for (const k in inv){
    const it = inv[k];
    if(!it || !it.equipped) continue;
    if(it.type==='weapon' && (it.subtype==='melee' || it.melee===true || isBasicMelee(k,it))){
      return {key:k, it};
    }
  }
  return null;
}

    const equippedKind = ()=> {
    const cg = firstEquippedCreatorGun(); if(cg) return 'creatorGun';  // move creatorGun first
    if (uziEquipped()) return 'uzi';
    if (pistolEquipped()) return 'pistol';
    if (grenadeEquipped()) return 'grenade';
    const m = meleeEquippedItem(); if(m) return 'melee';
    return null;
  };

  /* ==== APPLY CRAFTED WEAPON STATS (additive) ==== */
function craftedGunTuning(){
  const cg = firstEquippedCreatorGun(); if(!cg) return null;
  const it = cg.it;
  return {
    // interval override (ms)
    fireIntervalMs: clamp(parseInt(it.fireIntervalMs||TUNE.creatorGun.fireIntervalMs,10)||TUNE.creatorGun.fireIntervalMs, 60, 800),
    // bullet speed multiplier
    bulletSpeedMul: Math.max(0.4, Math.min(2.2, Number(it.bulletSpeedMul||1.0))),
    // crit & damage boost
    critChance: Math.max(0, Math.min(0.5, Number(it.critChance||0))),       // up to 50% hard cap
    dmgMult:    Math.max(0.5, Math.min(3.0, Number(it.dmgMult||1.0)))
  };
}
  function creatorGunIsAuto(){
  const cg = firstEquippedCreatorGun(); if(!cg) return false;
  const it = cg.it || {};
  return !!(it.auto || it.autoFire || String(it.fireMode||'').toLowerCase()==='auto');
}
  // ---- creator melee tuning (reads optional item fields) ----
function craftedMeleeTuning(){
  const m = meleeEquippedItem(); if(!m) return null;
  const it = m.it || {};
  return {
    swingMs:   Math.max(120, Math.min(800, parseInt(it.swingMs,10)      || TUNE.meleeSwingMs)),
    arcDeg:    Math.max(40,  Math.min(160, parseFloat(it.swingArcDeg)   || TUNE.meleeArcDeg)),
    range:     Math.max(20,  Math.min(72,  parseFloat(it.swingRange)    || TUNE.meleeRange)),
    dmgMult:   Math.max(0.5, Math.min(3.0, Number(it.dmgMult || 1.0))),
    critChance:Math.max(0.0, Math.min(0.5, Number(it.critChance || 0.0)))
  };
}

function computeMeleeDamageBase(){
  let dmg = 1; // legacy baseline segment
  const tune = craftedMeleeTuning();
  if (tune){
    dmg *= tune.dmgMult;
    if (Math.random() < tune.critChance) dmg *= 1.8;
  }
  return Math.max(0.5, Math.min(5, dmg));
}

/* Replace usages where creatorGun fires to respect interval + speed */
function creatorGunIntervalMs(){
  const tune = craftedGunTuning();
  return tune ? tune.fireIntervalMs : TUNE.creatorGun.fireIntervalMs;
}
function creatorGunSpeedMul(){
  const tune = craftedGunTuning();
  return tune ? tune.bulletSpeedMul : TUNE.creatorGun.bulletSpeedMul;
}
  // ---- tracer style chosen in Crafting UI for the equipped creator gun ----
// Accepts either a flat string (it.tracer / it.skin) or nested {fx:{tracer}}.
function selectedCreatorFX(){
  const cg = firstEquippedCreatorGun(); 
  if(!cg) return null;

  // pull value in priority: fx.tracer -> fx.skin -> tracer -> skin
  let v = (cg.it && cg.it.fx && (cg.it.fx.tracer || cg.it.fx.skin)) 
          || cg.it.tracer 
          || cg.it.skin 
          || '';

  const raw = String(v).toLowerCase();

  // Map Crafting UI presets -> internal render styles
  // presets you use in UI: comet, ember, prism, stardust
  if (/(ember|fire|flame)/.test(raw))         return 'fire';   // ember → fire
  if (/(prism|neon|glow)/.test(raw))          return 'neon';   // prism → neon
  if (/(stardust|spark|electric|zap)/.test(raw)) return 'spark';  // stardust → spark
  if (/ice|frost/.test(raw))                  return 'ice';
  if (/acid|toxic|poison/.test(raw))          return 'acid';
  if (/comet/.test(raw))                      return 'spark';  // choose spark-ish look for comet

  return null; // no FX
}
/* Hook into your bullet spawn to include damage payload */
function computeBulletDamageBase(){
  const kind = equippedKind();
  let dmg = 1; // 1 segment baseline per bullet hit (your existing default)
  if(kind==='creatorGun'){
    const tune = craftedGunTuning()||{};
    dmg *= (tune.dmgMult||1.0);
    // crit?
    if(Math.random() < (tune.critChance||0)){
      dmg *= 1.8; // crit multiplier
    }
  }
  return Math.max(0.5, Math.min(5, dmg));
}

/* Wherever you register a hit on NPC/PvP, use computeBulletDamageBase() to decide how many segments to subtract.
   Example (pseudo inside applyImpactAt or collision loop):
   const segments = Math.max(1, Math.round(computeBulletDamageBase()));
   IZZA.emit('apply-seg-damage', { segs: segments, source:'bullet' }); 
*/

/* Also replace creator gun cadence to use creatorGunIntervalMs() */
  
  function ammoFor(kind){
    const inv = readInv();
    if(kind==='grenade'){
      const g=inv.grenade; return (g && (g.count|0)) || 0;
    }
    if(kind==='creatorGun'){
      const cg=firstEquippedCreatorGun(); return cg ? (cg.it.ammo|0) : 0;
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
    if(kind==='creatorGun'){
      const cg = firstEquippedCreatorGun(); if(!cg) return false;
      const slot = inv[cg.key]; const n=(slot.ammo|0); if(n<=0) return false;
      slot.ammo = n-1; writeInv(inv); updateAmmoHUD(); patchInventoryAmmo('creatorGun', slot.ammo, cg.key);
      return true;
    }
    const slot = inv[kind]; if(!slot) return false;
    const n = (slot.ammo|0); if(n<=0) return false;
    slot.ammo = n-1; writeInv(inv);
    updateAmmoHUD(); patchInventoryAmmo(kind, slot.ammo);
    return true;
  }
function drawTracerTrail(ctx, styleKey, sx, sy, vx, vy, lifeRatio){
  const cfg = TRACER[styleKey]; if(!cfg) return;

  const aBase = cfg.baseA * lifeRatio;
  const prevOp = ctx.globalCompositeOperation;
  ctx.globalCompositeOperation = 'lighter';

  for (let k = 0; k < cfg.count; k++) {
    const fall = (k + 1);
    const fx = sx - vx * (cfg.tailMul * fall);
    const fy = sy - vy * (cfg.tailMul * fall);

    // fade down the tail; keep head orbs hotter
    const tailT  = 1 - (k / cfg.count);
    const localA = aBase * (0.35 + 0.65 * tailT);

    // outer glow
    const g = ctx.createRadialGradient(fx, fy, 0, fx, fy, cfg.glowR);
    g.addColorStop(0.00, `${cfg.colors.glow0}${0.55 * localA})`);
    g.addColorStop(0.60, `${cfg.colors.glow1}${0.35 * localA})`);
    g.addColorStop(1.00, `rgba(0,0,0,0)`);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(fx, fy, cfg.glowR, 0, Math.PI * 2); ctx.fill();

    // hot core
    ctx.fillStyle = `${cfg.colors.core}${0.90 * localA})`;
    ctx.beginPath(); ctx.arc(fx, fy, cfg.coreR, 0, Math.PI * 2); ctx.fill();

    // OPTIONAL per-style accents:
    if (styleKey === 'spark') {
      // tiny star flecks
      const sA = 0.7 * localA;
      ctx.fillStyle = `rgba(255,255,255,${sA})`;
      const ang = (k * 1.9) + performance.now() * 0.006;
      const dx = Math.cos(ang) * (2 + 1.5 * tailT);
      const dy = Math.sin(ang) * (2 + 1.5 * tailT);
      ctx.fillRect(fx + dx, fy + dy, 1.5, 1.5);
    } else if (styleKey === 'ice') {
      // faint icy shard streak
      ctx.strokeStyle = `rgba(220,240,255,${0.5 * localA})`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(fx, fy);
      ctx.lineTo(fx - vx * 0.01 * tailT, fy - vy * 0.01 * tailT);
      ctx.stroke();
    } else if (styleKey === 'acid') {
      // bubbly dots
      ctx.fillStyle = `rgba(200,255,140,${0.45 * localA})`;
      ctx.beginPath(); ctx.arc(fx, fy, 1.6 + 1.0 * (1 - tailT), 0, Math.PI * 2); ctx.fill();
    }
  }

  // short head streak
  ctx.strokeStyle = `${cfg.colors.streak}${0.55 * aBase})`;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.lineTo(sx - vx * (cfg.tailMul * 0.7), sy - vy * (cfg.tailMul * 0.7));
  ctx.stroke();

  ctx.globalCompositeOperation = prevOp;
}
  // patchers (keep legacy behavior, extend for creator gun where possible)
  function patchInventoryAmmo(kind, value, keyOpt){
    try{
      const host = document.getElementById('invPanel');
      if(!host || host.style.display==='none') return;

      if(kind==='creatorGun'){
        // try to find row by key or by "Gun" text
        let row = null;
        if(keyOpt){
          row = [...host.querySelectorAll('.inv-item')].find(r => r.textContent.includes(keyOpt));
        }
        row = row || [...host.querySelectorAll('.inv-item')].find(r => /Gun/i.test(r.textContent) && /Ammo:/i.test(r.textContent));
        if(!row) return;
        row.querySelectorAll('div').forEach(m=>{
          if(/Ammo:\s*\d+/.test(m.textContent)){
            m.textContent = m.textContent.replace(/Ammo:\s*\d+/, `Ammo: ${value}`);
          }
        });
        return;
      }

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
        if(i.grenade.equipped){ if(i.pistol) i.pistol.equipped=false; if(i.uzi) i.uzi.equipped=false; }
        writeInv(i);
        btn.textContent = i.grenade.equipped ? 'Unequip' : 'Equip';
        syncFireBtn();
      };
    }catch{}
  }

  // ---------- aim + projectile / grenade / melee ----------
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
    // ---------- projectile / grenade spawn ----------
  function spawnBulletOrPointBlank(speedMul=1.0, style=null){
    const p=IZZA.api.player, dir=aimVector();
    const playerCX = p.x+16, playerCY = p.y+16;

    // POINT-BLANK check (e.g., melee-distance bullet)
    if(applyImpactAt(playerCX, playerCY)){
      // only emit FX if this bullet came from a crafted creator gun with a style
      if(style){
        fxEvents.push({x:playerCX, y:playerCY, type: style+'Hit', born: now()});
      }
      return false;
    }

    const spd=bulletSpeed()*speedMul;
    bullets.push({
      x: playerCX + dir.x*18,
      y: playerCY + dir.y*18,
      vx: dir.x*spd,
      vy: dir.y*spd,
      born: now(),
      // style is ONLY set for creator guns with a selected tracer; pistols/uzi pass null
      style: style
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

  // ---------- firing ----------
  function firePistol(){
  const t=now();
  if(t-lastPistolAt < TUNE.pistolDelayMs) return;
  if(!pistolEquipped()) return;
  if(!takeAmmo('pistol')){ lastPistolAt=t; return; }
  const spawned = spawnBulletOrPointBlank();
  if (!spawned){
    const inv = readInv(); if (inv.pistol){ inv.pistol.ammo = (inv.pistol.ammo|0)+1; writeInv(inv); updateAmmoHUD(); }
  }
  lastPistolAt=t;
}
  function uziStart(){
  if(uziTimer || !uziEquipped()) return;
  if(!takeAmmo('uzi')) return;
  const spawned = spawnBulletOrPointBlank();
  if (!spawned){ /* no projectile (point-blank), refund 1 ammo */
    const inv = readInv(); if (inv.uzi){ inv.uzi.ammo = (inv.uzi.ammo|0)+1; writeInv(inv); updateAmmoHUD(); }
    return;
  }
  uziTimer = setInterval(()=>{
  if(!uziEquipped()){ uziStop(); return; }
  if(!takeAmmo('uzi')){ uziStop(); return; }
  const spawned = spawnBulletOrPointBlank();
  if (!spawned){
    const inv = readInv();
    if (inv.uzi){ inv.uzi.ammo = (inv.uzi.ammo|0) + 1; writeInv(inv); updateAmmoHUD(); }
  }
}, TUNE.uziIntervalMs);
}
  function uziStop(){ if(uziTimer){ clearInterval(uziTimer); uziTimer=null; } }
function creatorAutoStart(){
  if (creatorAutoTimer) return;
  const cg = firstEquippedCreatorGun(); if(!cg) return;

  const step = ()=>{
    // stop if unequipped / no ammo
    const cur = firstEquippedCreatorGun(); 
    if (!cur) { creatorAutoStop(); return; }
    if (!takeAmmo('creatorGun')) { creatorAutoStop(); return; }

    const style = selectedCreatorFX();
    const mul   = Number(cur.it.bulletSpeedMul || 1.0);
    const spawned = spawnBulletOrPointBlank(mul, style);
    if (!spawned){
      // refund 1 since we consumed but didn’t spawn
      const inv = readInv();
      const slot = inv[cur.key];
      if (slot){
        slot.ammo = (slot.ammo|0) + 1;
        writeInv(inv);
        updateAmmoHUD();
        patchInventoryAmmo('creatorGun', slot.ammo, cur.key);
      }
    }
  };

  // fire immediately, then continue on interval
  step();
  const interval = Math.max(60, (cg.it.fireIntervalMs|0) || TUNE.creatorGun.fireIntervalMs);
  creatorAutoTimer = setInterval(step, interval);
}
function creatorAutoStop(){
  if (creatorAutoTimer){ clearInterval(creatorAutoTimer); creatorAutoTimer=null; }
}
  // ---- NEW: creator gun one-shot (uses item fireIntervalMs + bulletSpeedMul)
    // ---- NEW: creator gun one-shot (uses item fireIntervalMs + bulletSpeedMul)
  function fireCreatorGun(){
    const t=now();
    const cg = firstEquippedCreatorGun(); if(!cg) return;
    if(t - lastCreatorShotAt < (cg.it.fireIntervalMs|0)) return;
    if(!takeAmmo('creatorGun')){ lastCreatorShotAt = t; return; }

    const style = selectedCreatorFX();
const spawned = spawnBulletOrPointBlank(Number(cg.it.bulletSpeedMul||1.0), style);
if (!spawned){
  const inv = readInv();
  const slot = inv[cg.key];
  if (slot){ slot.ammo = (slot.ammo|0) + 1; writeInv(inv); updateAmmoHUD(); patchInventoryAmmo('creatorGun', slot.ammo, cg.key); }
}
lastCreatorShotAt = t;
  }

  // ---- NEW: melee swing (no ammo) ------------------------------------------
  function startMeleeSwing(){
  const t = now();
  const tune = craftedMeleeTuning();
  const swingMs = tune ? tune.swingMs : TUNE.meleeSwingMs;
  // simple gate so you can’t swing faster than duration
  if (t - meleeSwingBorn < swingMs * 0.9) return;
  meleeSwinging = true;
  meleeSwingBorn = t;
}

function meleeSwingActive(){
  if(!meleeSwinging) return false;
  const tune = craftedMeleeTuning();
  const swingMs = tune ? tune.swingMs : TUNE.meleeSwingMs;
  if(now() - meleeSwingBorn > swingMs){ meleeSwinging=false; return false; }
  return true;
}
  function applyMeleeArcHits(){
  const p=IZZA.api.player, dir=aimVector();
  const cx=p.x+16, cy=p.y+16;

  const tune = craftedMeleeTuning();
  const maxR = tune ? tune.range : TUNE.meleeRange;
  const arcDeg = tune ? tune.arcDeg : TUNE.meleeArcDeg;
  const cosThresh = Math.cos((arcDeg*Math.PI/180)/2);

  const test = (tx,ty)=>{
    const dx=tx-cx, dy=ty-cy, r=Math.hypot(dx,dy); if(r>maxR) return false;
    const ux=dx/(r||1), uy=dy/(r||1);
    return (ux*dir.x + uy*dir.y) >= cosThresh;
  };

  let any=false;
  const segs = Math.max(1, Math.round(computeMeleeDamageBase())); // tuned segments

  // cops
  for(let j=IZZA.api.cops.length-1;j>=0;j--){
    const c=IZZA.api.cops[j];
    if(test(c.x+16, c.y+16)){
      const n=(copHits.get(c)||0)+segs; copHits.set(c,n);
      if(n>=2){
        const idx=IZZA.api.cops.indexOf(c); if(idx>=0) IZZA.api.cops.splice(idx,1);
        IZZA.api.setWanted((IZZA.api.player.wanted|0)-1);
        ensureCops(); dropFromCop(c);
      }
      any=true;
    }
  }

  // pedestrians
  for(const p2 of IZZA.api.pedestrians){
    if(p2.state==='blink') continue;
    if(test(p2.x+16, p2.y+16)){
      p2.state='blink'; p2.blinkT=0.3;
      if((IZZA.api.player.wanted|0) < 5) bumpWanted();
      any=true;
    }
  }

  return any;
}
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
      else if (k==='creatorGun'){ 
  if (creatorGunIsAuto()) creatorAutoStart();
  else fireCreatorGun();
}
      else if(k==='melee'){ startMeleeSwing(); }
    };
    const up  =(ev)=>{ ev.preventDefault(); ev.stopPropagation(); uziStop(); creatorAutoStop();   
    /* melee one-shot */ };
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
    if(ek==='melee'){ ammoPill.textContent='Melee'; ammoPill.style.opacity='1'; return; }
    const n=ammoFor(ek);
    let label = ek==='uzi'?'Uzi ': ek==='pistol'?'Pstl ': ek==='grenade'?'Grnd ':'Gun ';
    ammoPill.textContent = label + n;
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
      if (ek==='uzi') {
  if(!uziTimer) uziStart();
} else if (ek==='pistol') {
  firePistol();
} else if (ek==='grenade') {
  throwGrenade();
} else if (ek==='creatorGun') {
  if (creatorGunIsAuto()) creatorAutoStart();
  else fireCreatorGun();
} else if (ek==='melee') {
  startMeleeSwing();
}
    };
    const onUpCapture = (e)=>{
      const k=(e.key||'').toLowerCase(); if(k!=='a') return;
      if(uziTimer) uziStop();
      creatorAutoStop(); 
      e.preventDefault(); e.stopImmediatePropagation(); e.stopPropagation();
    };
    window.addEventListener('keydown', onDownCapture, {capture:true, passive:false});
    window.addEventListener('keyup',   onUpCapture,   {capture:true, passive:false});
  }
function unEquipAllWeapons(){
  const inv = readInv(); if(!inv) return;
  // legacy slots
  if(inv.pistol)  inv.pistol.equipped  = false;
  if(inv.uzi)     inv.uzi.equipped     = false;
  if(inv.grenade) inv.grenade.equipped = false;
  // creator guns + melee items
  for (const k in inv){
    const it = inv[k];
    if(!it) continue;
    if(it.type==='weapon'){
      it.equipped = false;
    }
  }
  writeInv(inv);
}

function ensureUseHandsButton(){
  try{
    const host = document.getElementById('invPanel');
    if(!host || host.style.display==='none') return;

    // find an existing "Use Hands" button OR row; adapt if your DOM differs
    // Option 1: explicit id
    let btn = host.querySelector('#useHands');
    // Option 2: fallback by label
    if(!btn){
      btn = [...host.querySelectorAll('button, .pill, .btn')].find(b => /use\s*hands/i.test(b.textContent||''));
    }
    if(!btn) return;

    if(!btn._izzaBound){
      btn._izzaBound = true;
      btn.addEventListener('click', (e)=>{
        e.preventDefault(); e.stopPropagation();
        unEquipAllWeapons();
        syncFireBtn(); // refresh FIRE state/label
      }, {passive:false});
    }
  }catch{}
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
  if(now()-b.born > TUNE.lifeMs){ bullets.splice(i,1); continue; }

  let hit=false, hitX=0, hitY=0;

  // pedestrians
  for(const p of IZZA.api.pedestrians){
    if(p.state==='blink') continue;
    if(distLE(b.x,b.y,p.x+16,p.y+16,TUNE.hitRadius)){
      p.state='blink'; p.blinkT=0.3;
      if((IZZA.api.player.wanted|0) < 5){ bumpWanted(); }
      hit=true; hitX=p.x+16; hitY=p.y+16;
      break;
    }
  }
  if(hit){
    if(b.style){ fxEvents.push({x:hitX, y:hitY, type:b.style+'Hit', born:now()}); }
    bullets.splice(i,1); continue;
  }

  // cops
  for(const c of IZZA.api.cops){
    if(distLE(b.x,b.y,c.x+16,c.y+16,TUNE.hitRadius)){
      const n=(copHits.get(c)||0)+1; copHits.set(c,n);
      if(n>=2){
        const idx=IZZA.api.cops.indexOf(c); if(idx>=0) IZZA.api.cops.splice(idx,1);
        IZZA.api.setWanted((IZZA.api.player.wanted|0)-1);
        ensureCops(); dropFromCop(c);
      }
      hit=true; hitX=c.x+16; hitY=c.y+16;
      break;
    }
  }
  if(hit){
    if(b.style){ fxEvents.push({x:hitX, y:hitY, type:b.style+'Hit', born:now()}); }
    bullets.splice(i,1); continue;
  }
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

      // melee swing window
      if(meleeSwingActive()){
        applyMeleeArcHits();
      }

      // blasts decay
      for(let i=blasts.length-1;i>=0;i--){
        if(now()-blasts[i].born > TUNE.grenadeShockMs) blasts.splice(i,1);
      }
    });
const _meleeImgCache = new Map();

function _svgToImg(svg){
  if(!svg) return null;
  if(_meleeImgCache.has(svg)) return _meleeImgCache.get(svg);
  const img = new Image(); img.decoding='async';
  img.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
  _meleeImgCache.set(svg, img);
  return img;
}

function _meleeProgress(){
  const tune = craftedMeleeTuning();
  const ms = tune ? tune.swingMs : TUNE.meleeSwingMs;
  return Math.max(0, Math.min(1, (now() - meleeSwingBorn)/ms));
}

// Optional: style name chosen in crafting UI, e.g. fx.swing, swing, skin
function selectedMeleeFX(){
  const m = meleeEquippedItem(); if(!m) return null;
  const it = m.it || {};
  let v = (it.fx && (it.fx.swing || it.fx.tracer || it.fx.skin)) || it.swing || it.skin || '';
  const raw = String(v).toLowerCase();
  if (/(ember|fire|flame)/.test(raw))            return 'fire';
  if (/(prism|neon|glow)/.test(raw))             return 'neon';
  if (/(stardust|spark|electric|zap)/.test(raw)) return 'spark';
  if (/ice|frost/.test(raw))                     return 'ice';
  if (/acid|toxic|poison/.test(raw))             return 'acid';
  return null;
}

// Draw the weapon swinging (basic for all, plus optional glow accents)
function drawMeleeWeaponSwing(ctx){
  if(!meleeSwingActive()) return;
  const m = meleeEquippedItem(); if(!m) return;
  const it = m.it || {};

  const p=IZZA.api.player, dir=aimVector();
  const center = w2s(p.x+16, p.y+16);

  const tune = craftedMeleeTuning();
  const arcDeg = tune ? tune.arcDeg : TUNE.meleeArcDeg;
  const range  = (tune ? tune.range  : TUNE.meleeRange) * SCALE();

  const prog = _meleeProgress(); // 0..1 across swing
  const baseAng = Math.atan2(dir.y, dir.x);
  const half = (arcDeg*Math.PI/180)/2;
  const theta = baseAng - half + prog * (2*half);

  const x = center.sx + Math.cos(theta)*range;
  const y = center.sy + Math.sin(theta)*range;

  const svg = it.overlaySvg || it.iconSvg;
  const img = _svgToImg(svg);

  // fallback size if no svg
  const w = (it.overlayBox && it.overlayBox.w|0) || 32;
  const h = (it.overlayBox && it.overlayBox.h|0) || 32;

  ctx.save();
  ctx.translate(Math.round(x), Math.round(y));
  ctx.rotate(theta);

  if (img && img.complete){
    try{ ctx.drawImage(img, -w/2, -h/2, w, h); }catch{}
  } else {
    // basic shape so every melee shows something
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillRect(-w/2, -h/2, w, h);
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.strokeRect(-w/2, -h/2, w, h);
  }

  ctx.restore();

  // Optional upgraded visuals layered on top (glow beads along the arc)
  const style = selectedMeleeFX();
  if(style && TRACER[style]){
    const cfg = TRACER[style];
    const a = 1 - prog; // fade toward end
    const prevOp = ctx.globalCompositeOperation;
    ctx.globalCompositeOperation = 'lighter';

    const steps = 8;
    for(let i=0;i<steps;i++){
      const t = i/(steps-1);
      const th = baseAng - half + t*(2*half);
      const px = center.sx + Math.cos(th)*range;
      const py = center.sy + Math.sin(th)*range;
      const g = ctx.createRadialGradient(px, py, 0, px, py, cfg.glowR);
      g.addColorStop(0.0, `${cfg.colors.glow0}${0.55*cfg.baseA*a})`);
      g.addColorStop(0.6, `${cfg.colors.glow1}${0.35*cfg.baseA*a})`);
      g.addColorStop(1.0, `rgba(0,0,0,0)`);
      ctx.fillStyle=g; ctx.beginPath(); ctx.arc(px,py,cfg.glowR,0,Math.PI*2); ctx.fill();
      ctx.fillStyle = `${cfg.colors.core}${0.9*cfg.baseA*a})`;
      ctx.beginPath(); ctx.arc(px,py,cfg.coreR,0,Math.PI*2); ctx.fill();
    }

    ctx.globalCompositeOperation = prevOp;
  }
}
    // Render
    IZZA.on('render-post', ()=>{
      const cvs=document.getElementById('game'); if(!cvs) return;
      const ctx=cvs.getContext('2d'); ctx.save(); ctx.imageSmoothingEnabled=false;

      // bullets
for (const b of bullets) {
  const { sx, sy } = w2s(b.x, b.y);

  // base dot (legacy look)
  ctx.fillStyle = '#000';
  ctx.fillRect(sx - 2, sy - 2, 4, 4);

  // unified multi-orb tracer per style
  if (b.style && TRACER[b.style]) {
    const age = now() - b.born;
    const lifeRatio = Math.max(0, 1 - age / TUNE.lifeMs);
    drawTracerTrail(ctx, b.style, sx, sy, b.vx, b.vy, lifeRatio);
  }
}
  
      // grenades
      ctx.fillStyle='#6fbf6f';
      for(const g of grenades){ const {sx,sy}=w2s(g.x,g.y); ctx.fillRect(sx-3, sy-3, 6, 6); }

      // grenade shock circle
      for(const bl of blasts){
        const age = now()-bl.born;
        const a = Math.max(0, 1 - age/TUNE.grenadeShockMs);
        const {sx,sy}=w2s(bl.x,bl.y);
        ctx.strokeStyle=`rgba(255,230,130,${a})`;
        ctx.lineWidth=2;
        ctx.beginPath(); ctx.arc(sx,sy, TUNE.grenadeBlastR*SCALE(), 0, Math.PI*2); ctx.stroke();
      }

      // melee swing arc (visual only)
      // melee swing (basic + optional upgraded visuals)
if(meleeSwingActive()){
  const p=IZZA.api.player, dir=aimVector();
  const center = w2s(p.x+16, p.y+16);
  const tune = craftedMeleeTuning();
  const r = (tune ? tune.range : TUNE.meleeRange)*SCALE();
  const arcDeg = tune ? tune.arcDeg : TUNE.meleeArcDeg;

  // base faint sweep for legacy feel
  ctx.strokeStyle='rgba(255,255,255,0.15)';
  ctx.lineWidth=2;
  ctx.beginPath();
  const ang = Math.atan2(dir.y, dir.x);
  const half = (arcDeg*Math.PI/180)/2;
  ctx.arc(center.sx, center.sy, r, ang-half, ang+half);
  ctx.stroke();

  // draw the actual weapon swinging + optional glow accents
  drawMeleeWeaponSwing(ctx);
}
      // --- FX Events (only triggered by creator-gun bullets with a selected tracer) ---
      for(let i=fxEvents.length-1;i>=0;i--){
        const fx = fxEvents[i];
        const age = now()-fx.born;
        if(age > 550){ fxEvents.splice(i,1); continue; } // ~0.55s linger

        const {sx,sy} = w2s(fx.x, fx.y);
        const a = Math.max(0, 1 - age/550);

        if(fx.type==='fireHit'){
          // warm glow + tiny ember ring
          ctx.fillStyle = `rgba(255,110,30,${0.55*a})`;
          ctx.beginPath(); ctx.arc(sx, sy, 9+age*0.02, 0, Math.PI*2); ctx.fill();

          ctx.strokeStyle = `rgba(255,200,60,${0.9*a})`;
          ctx.lineWidth=1.5;
          ctx.beginPath(); ctx.arc(sx, sy, 6+age*0.03, 0, Math.PI*2); ctx.stroke();
        }
        else if(fx.type==='neonHit'){
          // pulsing neon halo
          ctx.strokeStyle = `hsla(${(age*6)%360},100%,60%,${a})`;
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(sx, sy, 10+age*0.05, 0, Math.PI*2); ctx.stroke();
        }
        else if(fx.type==='sparkHit'){
          // crackly starburst
          ctx.fillStyle = `rgba(240,240,255,${a})`;
          for(let n=0;n<6;n++){
            const ang = (Math.PI*2*n/6) + age*0.02;
            const dx = Math.cos(ang)*(4+age*0.04), dy=Math.sin(ang)*(4+age*0.04);
            ctx.fillRect(sx+dx, sy+dy, 2, 2);
          }
        }
        else if(fx.type==='iceHit'){
          // frosty puff
          ctx.fillStyle = `rgba(160,220,255,${0.6*a})`;
          ctx.beginPath(); ctx.arc(sx, sy, 8+age*0.03, 0, Math.PI*2); ctx.fill();
        }
        else if(fx.type==='acidHit'){
          // splashy blot
          ctx.fillStyle = `rgba(110,255,90,${0.55*a})`;
          ctx.beginPath(); ctx.arc(sx, sy, 9+age*0.04, 0, Math.PI*2); ctx.fill();
        }
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
            setTimeout(ensureUseHandsButton, 0);
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
