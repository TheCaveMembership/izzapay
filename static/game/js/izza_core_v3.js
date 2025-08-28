(function(){
  const BUILD = 'v3.16-core+mapInvMutex+heldWeaponUzi+grenades';
  console.log('[IZZA PLAY]', BUILD);

  // --- lightweight hook bus ---
  const IZZA = window.IZZA = window.IZZA || {};
  IZZA._hooks = IZZA._hooks || {};
  IZZA.on   = (ev, fn)=>{ (IZZA._hooks[ev] ||= []).push(fn); };
  IZZA.emit = (ev, payload)=>{ (IZZA._hooks[ev]||[]).forEach(fn=>{ try{ fn(payload); }catch(e){ console.error(e); } }); };
  IZZA.api = {};

  // ===== tiny on-screen boot status =====
  function bootMsg(txt, color='#ffd23f'){
    let el = document.getElementById('bootMsg');
    if(!el){
      el = document.createElement('div');
      el.id='bootMsg';
      Object.assign(el.style,{
        position:'fixed', left:'12px', top:'48px', zIndex:9999,
        background:'rgba(10,12,18,.92)', border:'1px solid #394769',
        color:'#cfe0ff', padding:'6px 8px', borderRadius:'8px',
        fontSize:'12px', maxWidth:'74vw', pointerEvents:'none'
      });
      document.body.appendChild(el);
    }
    el.style.display='block';
    el.style.borderColor = color;
    el.textContent = txt;
    clearTimeout(el._t);
    el._t = setTimeout(()=>{ el.style.display='none'; }, 4500);
  }

  // ===== Profile / assets =====
  const profile = window.__IZZA_PROFILE__ || {};
  const BODY   = profile.sprite_skin || "default";
  const HAIR   = profile.hair || "short";
  const OUTFIT = profile.outfit || "street";

  // ===== Canvas / constants =====
  const cvs = document.getElementById('game');
  const ctx = cvs.getContext('2d');
  const TILE=32, SCALE=3, DRAW=TILE*SCALE, SCALE_FACTOR=DRAW/TILE;

  const camera={x:0,y:0};
  const w2sX = wx => (wx - camera.x) * SCALE_FACTOR;
  const w2sY = wy => (wy - camera.y) * SCALE_FACTOR;

  // --- loot drop behavior knobs ---
  const DROP_GRACE_MS = 1000;
  const DROP_OFFSET   = 18;
  function makeDropPos(victimCenterX, victimCenterY){
    const dx = victimCenterX - player.x;
    const dy = victimCenterY - player.y;
    const m  = Math.hypot(dx, dy) || 1;
    const ux = dx / m, uy = dy / m;
    return { x: victimCenterX + ux * DROP_OFFSET, y: victimCenterY + uy * DROP_OFFSET };
  }

  // ===== World =====
const W=90,H=60;

// Map tiers: tier "1" = current size, tier "2" = expanded after Mission 3
function computeUnlockedRect(tier){
  // tier 1 matches your current area
  if(tier!=='2') return { x0:18, y0:18, x1:72, y1:42 };
  // tier 2 opens the map outward (tweak freely)
  return { x0:10, y0:12, x1:80, y1:50 };
}
function computePreviewRect(tier){
  if(tier!=='2') return { x0:10, y0:12, x1:80, y1:50 };
  // a bit wider preview so the minimap shows more context
  return { x0:6, y0:8, x1:84, y1:54 };
}

let __mapTier = localStorage.getItem('izzaMapTier') || '1';
let unlocked  = computeUnlockedRect(__mapTier);
let preview   = computePreviewRect(__mapTier);

const inRect = (gx,gy,r)=> gx>=r.x0 && gx<=r.x1 && gy>=r.y0 && gy<=r.y1;
const inUnlocked = (gx,gy)=> inRect(gx,gy,unlocked);

// Poll for tier changes (Mission 3 plugin sets izzaMapTier to "2")
function maybeRefreshMapTier(){
  const t = localStorage.getItem('izzaMapTier') || '1';
  if(t !== __mapTier){
    __mapTier = t;
    unlocked  = computeUnlockedRect(t);
    preview   = computePreviewRect(t);
    centerCamera();
    bootMsg(t==='2' ? 'New district unlocked!' : 'Map size updated');
  }
}

  // Hub
  const bW=10,bH=6;
  const bX = Math.floor((unlocked.x0+unlocked.x1)/2) - Math.floor(bW/2);
  const bY = unlocked.y0 + 5;

  // Roads/sidewalks
  const hRoadY       = bY + bH + 1;
  const sidewalkTopY = hRoadY - 1;
  const sidewalkBotY = hRoadY + 1;

  // Vertical road to the right of HQ + sidewalks on both sides
  const vRoadX         = Math.min(unlocked.x1-3, bX + bW + 6);
  const vSidewalkLeftX = vRoadX - 1;
  const vSidewalkRightX= vRoadX + 1;

  // HQ Door centered on top sidewalk
  const door = { gx: bX + Math.floor(bW/2), gy: sidewalkTopY };

  // ===== SHOP: right of the right vertical sidewalk =====
  const shop = {
    w: 8, h: 5,
    x: vSidewalkRightX + 1,
    y: sidewalkTopY - 5,
    sidewalkY: sidewalkTopY,
    registerGX: vSidewalkRightX
  };

  // ===== Loading =====
  function loadImg(src){
    return new Promise((res,rej)=>{
      const i=new Image();
      i.onload=()=>res(i);
      i.onerror=()=>rej(new Error('load:'+src));
      i.src=src;
    });
  }
  const assetRoot="/static/game/sprites";
  function loadLayer(kind,name){
    const p2=`${assetRoot}/${kind}/${encodeURIComponent(name+' 2')}.png`;
    const p1=`${assetRoot}/${kind}/${encodeURIComponent(name)}.png`;
    return loadImg(p2).then(img=>({img,cols:Math.max(1,Math.floor(img.width/32))}))
                      .catch(()=>loadImg(p1).then(img=>({img,cols:Math.max(1,Math.floor(img.width/32))})));
  }

  // === NPC sprite sheets (32x32 frames) ===
  const NPC_SRC = {
    ped_m:       '/static/game/sprites/pedestrian_sheet.png',
    ped_f:       '/static/game/sprites/pedestrian_female_sheet.png',
    ped_m_dark:  '/static/game/sprites/pedestrian_male_dark_sheet.png',
    ped_f_dark:  '/static/game/sprites/pedestrian_female_dark_sheet.png',
    police:      '/static/game/sprites/izza_police_sheet.png',
    swat:        '/static/game/sprites/izza_swat_sheet.png',
    military:    '/static/game/sprites/izza_military_sheet.png'
  };
  let NPC_SHEETS = {};

  function loadNPCSheets(){
    const entries = Object.entries(NPC_SRC);
    return Promise.allSettled(entries.map(([,src])=> loadImg(src)))
      .then(results=>{
        const map = {}, misses=[];
        results.forEach((r,i)=>{
          const [key] = entries[i];
          if(r.status==='fulfilled'){
            const img=r.value;
            map[key] = { img, cols: Math.max(1, Math.floor(img.width/32)) };
          }else{
            misses.push(key);
          }
        });
        if(misses.length) bootMsg('Missing NPC sprites: '+misses.join(', '), '#ff6b6b');
        return map;
      });
  }

  // ===== Coins & Progress (persist) =====
  const LS = {
    coins:      'izzaCoins',
    mission1:   'izzaMission1',
    missions:   'izzaMissions',
    inventory:  'izzaInventory'
  };
  function getCoins(){
    const raw = localStorage.getItem(LS.coins);
    const n = raw==null ? 300 : (parseInt(raw,10)||0);
    return Math.max(0,n);
  }
  function setCoins(n){
    const v = Math.max(0, n|0);
    localStorage.setItem(LS.coins, String(v));
    const el = document.getElementById('coinPill') || document.querySelector('.pill.coins');
    if(el) el.textContent = `Coins: ${v} IC`;
    player.coins = v;
  }
  function getMission1Done(){ return localStorage.getItem(LS.mission1)==='done'; }
  function setMission1Done(){
    localStorage.setItem(LS.mission1,'done');
    const cur = parseInt(localStorage.getItem(LS.missions)||'0',10);
    if(cur<1) localStorage.setItem(LS.missions,'1');
  }
  function getMissionCount(){ return parseInt(localStorage.getItem(LS.missions)|| (getMission1Done()? '1':'0'), 10); }

  // ---- Inventory (object w/ counts, ammo, durability, equipped flags)
  function _migrateInventory(v){
    if (Array.isArray(v)) {
      const inv = {};
      v.forEach(k => { inv[k] = (k==='pistol' ? {owned:true, ammo:0, equipped:false} : {count:1, equipped:false}); });
      return inv;
    }
    return v && typeof v==='object' ? v : {};
  }
  function getInventory(){
    try{
      const parsed = JSON.parse(localStorage.getItem(LS.inventory) || '{}');
      return _migrateInventory(parsed);
    }catch{
      return {};
    }
  }
  function setInventory(obj){
    localStorage.setItem(LS.inventory, JSON.stringify(obj||{}));
  }

// ===== Loot pickup integration (coins, pistol, uzi, grenades) =====
// Expect your loot system to call: IZZA.emit('loot-picked', { kind:'coin'|'pistol'|'uzi'|'grenade', amount?, value?, bullets? })
IZZA.on('loot-picked', (payload)=>{
  try{
    const kind   = payload && (payload.kind || payload.type || payload.id);
    const amount = (payload && (payload.amount|0)) || 0;
    if(!kind) return;

    // Helper: refresh inventory UI if open
    const refreshInvPanel = ()=>{
      const host = document.getElementById('invPanel');
      if(host && host.style.display!=='none' && typeof renderInventoryPanel==='function'){
        renderInventoryPanel();
      }
    };

    switch(kind){
      // --- Coins ---
      case 'coin':
      case 'coins': {
        // accept amount OR value from emitter
        const delta = amount>0 ? amount : ((payload.value|0) || 0);
        if(delta>0){
          setCoins(getCoins() + delta);
          toast(`+${delta} IC`);
        }
        break;
      }

      // --- Uzi: add to inventory + ammo +50 per pickup ---
      case 'uzi': {
        const inv = getInventory();
        const cur = inv.uzi || { owned:true, ammo:0, equipped:false };
        cur.owned = true;
        cur.ammo  = (cur.ammo|0) + 50;
        inv.uzi   = cur;
        setInventory(inv);
        toast('Picked up Uzi (+50 bullets)');
        refreshInvPanel();
        break;
      }

      // --- Grenade: stack count +1 per pickup ---
      case 'grenade': {
        const inv = getInventory();
        const cur = inv.grenade || { count:0 };
        cur.count = (cur.count|0) + 1;
        inv.grenade = cur;
        setInventory(inv);
        toast('Grenade +1');
        refreshInvPanel();
        break;
      }

      // --- Pistol: add to inventory + ammo (defaults to +17) ---
      case 'pistol': {
        const inv = getInventory();
        const cur = inv.pistol || { owned:true, ammo:0, equipped:false };
        cur.owned = true;
        // If your emitter sends a custom bullet amount, use it; else default to +17 (same as shop "full mag").
        const add = (payload && (payload.bullets|0)) || 17;
        cur.ammo  = (cur.ammo|0) + add;
        inv.pistol = cur;
        setInventory(inv);
        toast(`Picked up Pistol (+${add} ammo)`);
        refreshInvPanel();
        break;
      }

      default:
        // ignore other kinds safely
        break;
    }
  }catch(err){
    console.error('[loot-picked] handler error', err);
  }
});
  
  // ===== Player / anim =====
  const player = {
    x: door.gx*TILE + (TILE/2 - 8),
    y: door.gy*TILE,
    speed: 90,
    wanted: 0,
    facing: 'down', moving:false,
    animTime: 0,
    hp: 5,
    coins: 0
  };

  // --- Equip helpers + rules ---
  let equipped = { weapon: 'fists' }; // 'fists' | 'bat' | 'knuckles' | 'pistol' | 'uzi'
  const WEAPON_RULES = {
    fists:     { damage: 1, breaks: false },
    bat:       { damage: 2, breaks: true,  hitsPerItem: 20 },
    knuckles:  { damage: 2, breaks: true,  hitsPerItem: 50 },
    pistol:    { damage: 3, breaks: false },
    uzi:       { damage: 3, breaks: false } // same as pistol for now
    // grenades are consumables with {count}, not equipped here
  };
  function missionsOKToUse(id){
    // firearms (pistol + uzi) unlock to EQUIP at >= mission 3
    if (id==='pistol' || id==='uzi') return getMissionCount() >= 3;
    return true;
  }
  function setEquippedWeapon(id){
    equipped.weapon = id;
    const inv = getInventory();
    if(inv.bat)      inv.bat.equipped      = (id === 'bat');
    if(inv.knuckles) inv.knuckles.equipped = (id === 'knuckles');
    if(inv.pistol)   inv.pistol.equipped   = (id === 'pistol');
    if(inv.uzi)      inv.uzi.equipped      = (id === 'uzi');
    setInventory(inv);
  }
  function unequipWeapon(){ setEquippedWeapon('fists'); toast('Hands ready'); }

  const DIR_INDEX = { down:0, left:2, right:1, up:3 };
  const FRAME_W=32, FRAME_H=32, WALK_FPS=8, WALK_MS=1000/WALK_FPS;
  function currentFrame(cols, moving, t){ if(cols<=1) return 0; if(!moving) return 1%cols; return Math.floor(t/WALK_MS)%cols; }

  // ===== Input / UI =====
  const keys = Object.create(null);
  const btnA = document.getElementById('btnA');
  const btnB = document.getElementById('btnB');
  const btnI = document.getElementById('btnI');
  const btnMap = document.getElementById('btnMap');
  const promptEl = document.getElementById('prompt');

  // Tutorial hint (toast)
  let tutorial = { active:false, step:'', hintT:0 };
  function showHint(text, seconds=3){
    let h = document.getElementById('tutHint');
    if(!h){
      h = document.createElement('div');
      h.id='tutHint';
      Object.assign(h.style,{
        position:'fixed', left:'12px', top:'64px', zIndex:7,
        background:'rgba(10,12,18,.85)', border:'1px solid #394769',
        color:'#cfe0ff', padding:'8px 10px', borderRadius:'10px', fontSize:'14px'
      });
      document.body.appendChild(h);
    }
    h.textContent=text; h.style.display='block';
    tutorial.hintT = seconds;
  }
  function toast(msg, seconds=2.2){ showHint(msg, seconds); }

  function handleB(){
    if (doorInRange()) openEnter();
    else if (atRegister()) openShop();
    else setWanted(0);
  }

  window.addEventListener('keydown', e=>{
    const k=e.key.toLowerCase(); keys[k]=true;
    if(k==='b'){ e.preventDefault(); handleB(); }
    if(k==='a'){ e.preventDefault(); doAttack(); }
    if(k==='i'){ e.preventDefault(); toggleInventoryPanel(); }
  },{passive:false});
  window.addEventListener('keyup', e=>{ keys[e.key.toLowerCase()]=false; });

  if(btnA) btnA.addEventListener('click', doAttack);
  if(btnB) btnB.addEventListener('click', handleB);

  // ===== Inventory ↔ Map mutual exclusion helpers =====
  const miniWrap = document.getElementById('miniWrap');
  const mapModal = document.getElementById('mapModal');
  function invOpen(){ const p=document.getElementById('invPanel'); return p && p.style.display!=='none'; }
  function closeInventory(){ const p=document.getElementById('invPanel'); if(p) p.style.display='none'; }
  function closeMapUI(){ if(mapModal) mapModal.style.display='none'; if(miniWrap) miniWrap.style.display='none'; }

  const btnIHandler = ()=> toggleInventoryPanel();
  if(btnI) btnI.addEventListener('click', btnIHandler);

  if(btnMap){
    btnMap.addEventListener('click', ()=>{
      // if inventory is open, close it first
      closeInventory();
      if(!miniWrap) return;
      // toggle minimap visibility
      const next = (miniWrap.style.display==='none' || !miniWrap.style.display) ? 'block' : 'none';
      miniWrap.style.display = next;
      if(next==='block'){ if(mapModal) mapModal.style.display='none'; }
    });
  }

  // Virtual joystick
  const stick = document.getElementById('stick');
  const nub   = document.getElementById('nub');
  let dragging=false, baseRect=null, vec={x:0,y:0};
  function setNub(dx,dy){
    const r=40, m=Math.hypot(dx,dy)||1, c=Math.min(m,r), ux=dx/m, uy=dy/m;
    if(nub){ nub.style.left=(40+ux*c)+'px'; nub.style.top=(40+uy*c)+'px'; }
    vec.x=(c/r)*ux; vec.y=(c/r)*uy;
  }
  function resetNub(){ if(nub){ nub.style.left='40px'; nub.style.top='40px'; } vec.x=0; vec.y=0; }
  function startDrag(e){ dragging=true; baseRect=stick.getBoundingClientRect(); e.preventDefault(); }
  function moveDrag(e){ if(!dragging) return; const t=e.touches?e.touches[0]:e; const cx=baseRect.left+baseRect.width/2, cy=baseRect.top+baseRect.height/2; setNub(t.clientX-cx,t.clientY-cy); e.preventDefault(); }
  function endDrag(e){ dragging=false; resetNub(); if(e) e.preventDefault(); }
  if(stick){
    stick.addEventListener('touchstart',startDrag,{passive:false});
    stick.addEventListener('touchmove', moveDrag, {passive:false});
    stick.addEventListener('touchend',  endDrag,  {passive:false});
    stick.addEventListener('mousedown', startDrag);
    window.addEventListener('mousemove',moveDrag);
    window.addEventListener('mouseup',  endDrag);
  }

  // ===== HUD =====
  function setWanted(n){
    const prev = player.wanted;
    player.wanted = Math.max(0, Math.min(5, n|0));
    document.querySelectorAll('#stars .star').forEach((s,i)=> s.className='star' + (i<player.wanted?' on':'') );
    if (player.wanted !== prev) IZZA.emit('wanted-changed', { from: prev, to: player.wanted });
  }

  // ===== Camera =====
  function centerCamera(){
    const visW = cvs.width  / SCALE_FACTOR;
    const visH = cvs.height / SCALE_FACTOR;
    camera.x = player.x - visW/2;
    camera.y = player.y - visH/2;
    const maxX = (unlocked.x1+1)*TILE - visW;
    const maxY = (unlocked.y1+1)*TILE - visH;
    camera.x = Math.max(unlocked.x0*TILE, Math.min(camera.x, maxX));
    camera.y = Math.max(unlocked.y0*TILE, Math.min(camera.y, maxY));
  }

  // ===== Collision =====
  const isHQ = (gx,gy)=> gx>=bX&&gx<bX+bW&&gy>=bY&&gy<bY+bH;
  const isShop = (gx,gy)=> gx>=shop.x&&gx<shop.x+shop.w&&gy>=shop.y&&gy<shop.y+shop.h;
  function isSolid(gx,gy){
    if(!inUnlocked(gx,gy)) return true;
    if(isHQ(gx,gy)) return true;
    if(isShop(gx,gy) && gx!==vSidewalkLeftX && gx!==vSidewalkRightX) return true;
    return false;
  }
  function tryMove(nx,ny){
    const cx = [
      {x:nx, y:player.y}, {x:nx+TILE-1, y:player.y},
      {x:nx, y:player.y+TILE-1}, {x:nx+TILE-1, y:player.y+TILE-1}
    ];
    if(!cx.some(c=>isSolid(Math.floor(c.x/TILE), Math.floor(c.y/TILE)))) player.x = nx;

    const cy = [
      {x:player.x, y:ny}, {x:player.x+TILE-1, y:ny},
      {x:player.x, y:ny+TILE-1}, {x:player.x+TILE-1, y:ny+TILE-1}
    ];
    if(!cy.some(c=>isSolid(Math.floor(c.x/TILE), Math.floor(c.y/TILE)))) player.y = ny;
  }

  function doorInRange(){
    const px = Math.floor((player.x + TILE/2)/TILE);
    const py = Math.floor((player.y + TILE/2)/TILE);
    return (Math.abs(px-door.gx)+Math.abs(py-door.gy))<=2;
  }
  function atRegister(){
    const px = Math.floor((player.x + TILE/2)/TILE);
    const py = Math.floor((player.y + TILE/2)/TILE);
    return (Math.abs(px-shop.registerGX)+Math.abs(py-shop.sidewalkY))<=1;
  }

  // ===== Modals & Tutorial hook =====
  function openEnter(){ const m=document.getElementById('enterModal'); if(m) m.style.display='flex'; }
  function closeEnter(){ const m=document.getElementById('enterModal'); if(m) m.style.display='none'; }

  // Tiny inline icons for shop/inventory
  function svgIcon(id, w=24, h=24){
    if(id==='bat') return `<svg viewBox="0 0 64 64" width="${w}" height="${h}"><rect x="22" y="8" width="8" height="40" fill="#8b5a2b"/><rect x="20" y="48" width="12" height="8" fill="#6f4320"/></svg>`;
    if(id==='knuckles') return `<svg viewBox="0 0 64 64" width="${w}" height="${h}"><circle cx="20" cy="28" r="6" stroke="#cfcfcf" fill="none" stroke-width="4"/><circle cx="32" cy="28" r="6" stroke="#cfcfcf" fill="none" stroke-width="4"/><circle cx="44" cy="28" r="6" stroke="#cfcfcf" fill="none" stroke-width="4"/><rect x="16" y="34" width="32" height="8" fill="#cfcfcf"/></svg>`;
    if(id==='pistol') return `<svg viewBox="0 0 64 64" width="${w}" height="${h}"><rect x="14" y="26" width="30" height="8" fill="#202833"/><rect x="22" y="34" width="8" height="12" fill="#444c5a"/></svg>`;
    if(id==='uzi') return `<svg viewBox="0 0 64 64" width="${w}" height="${h}"><rect x="12" y="28" width="34" height="8" fill="#0b0e14"/><rect x="36" y="22" width="12" height="6" fill="#0b0e14"/><rect x="30" y="36" width="6" height="12" fill="#0b0e14"/><rect x="18" y="36" width="6" height="10" fill="#0b0e14"/></svg>`;
    if(id==='grenade') return `<svg viewBox="0 0 64 64" width="${w}" height="${h}"><rect x="28" y="22" width="8" height="5" fill="#5b7d61"/><rect x="31" y="19" width="2" height="2" fill="#c3c9cc"/><rect x="26" y="27" width="12" height="14" fill="#264a2b"/></svg>`;
    return '';
  }

  function openShop(){
    const m=document.getElementById('shopModal'); if(!m) return;
    const list=document.getElementById('shopList');
    const note=document.getElementById('shopNote');
    if(list) list.innerHTML='';

    const done = getMission1Done();
    if(!done){
      if(note) note.textContent = "Go see IZZA GAME HQ to learn about your first mission from the boss!";
    }else{
      if(note) note.textContent = "";
      const missions = getMissionCount();
      const stock = [
        {id:'bat',       name:'Baseball Bat',     price:100, desc:'Starter melee'},
        {id:'knuckles',  name:'Brass Knuckles',   price:150, desc:'+1 damage'},
        {id:'pistol',    name:'Pistol',           price:300, desc:'Basic firearm', reqMissions:2},
      ];
      if(list){
        stock.forEach(it=>{
          if(it.reqMissions && missions < it.reqMissions) return;

          const row = document.createElement('div'); row.className='shop-item';
          const meta = document.createElement('div'); meta.className='meta';
          meta.innerHTML = `
            <div style="display:flex; align-items:center; gap:8px">
              <div>${svgIcon(it.id)}</div>
              <div>
                <div class="name">${it.name}</div>
                <div class="sub">${it.price} IC</div>
              </div>
            </div>`;

          const btn = document.createElement('button'); btn.className='buy'; btn.textContent = 'Buy';
          btn.addEventListener('click', ()=>{
            if(player.coins < it.price){ alert('Not enough coins'); return; }
            setCoins(player.coins - it.price);

            // Add to inventory (stackables + durability init)
            const inv = getInventory();
            if(it.id==='bat'){
              const cur = inv.bat || { count:0, hitsLeftOnCurrent:0, equipped:false };
              cur.count += 1;
              if(cur.hitsLeftOnCurrent<=0) cur.hitsLeftOnCurrent = WEAPON_RULES.bat.hitsPerItem;
              inv.bat = cur;
              setInventory(inv);
              toast('Purchased Baseball Bat');
            }else if(it.id==='knuckles'){
              const cur = inv.knuckles || { count:0, hitsLeftOnCurrent:0, equipped:false };
              cur.count += 1;
              if(cur.hitsLeftOnCurrent<=0) cur.hitsLeftOnCurrent = WEAPON_RULES.knuckles.hitsPerItem;
              inv.knuckles = cur;
              setInventory(inv);
              toast('Purchased Brass Knuckles');
            }else if(it.id==='pistol'){
              const cur = inv.pistol || { owned:true, ammo:0, equipped:false };
              cur.owned = true;
              cur.ammo = (cur.ammo|0) + 17; // full mag per buy
              inv.pistol = cur;
              setInventory(inv);
              toast('Purchased Pistol (+17 ammo)');
            }

            const p = document.getElementById('invPanel');
            if(p && p.style.display!=='none') renderInventoryPanel();
          });

          row.appendChild(meta); row.appendChild(btn);
          list.appendChild(row);
        });
        if(!list.children.length && note){
          note.textContent = "No items available yet. Complete more missions!";
        }
      }
    }
    m.style.display='flex';
  }
  function closeShop(){ const m=document.getElementById('shopModal'); if(m) m.style.display='none'; }

  const ce=document.getElementById('closeEnter'); if(ce) ce.addEventListener('click', (e)=>{ e.stopPropagation(); closeEnter(); });
  const em=document.getElementById('enterModal'); if(em) em.addEventListener('click', (e)=>{ if(e.target.classList.contains('backdrop')) closeEnter(); });
  const cs=document.getElementById('closeShop'); if(cs) cs.addEventListener('click', (e)=>{ e.stopPropagation(); closeShop(); });
  const sm=document.getElementById('shopModal'); if(sm) sm.addEventListener('click', (e)=>{ if(e.target.classList.contains('backdrop')) closeShop(); });

  // ✅ Start Tutorial button (restored)
  const startBtn = document.getElementById('startTutorial');
  if(startBtn){
    startBtn.addEventListener('click', (e)=>{
      e.stopPropagation();
      closeEnter();
      tutorial.active = true;
      tutorial.step   = 'hitPed';
      showHint('Tutorial: Press A to hit a pedestrian.');
    });
  }

  // ===== Inventory UI (toggle with I or the I button) =====
  function ensureInvHost(){
    let host = document.getElementById('invPanel');
    if(!host){
      const card = document.getElementById('gameCard');
      host = document.createElement('div');
      host.id = 'invPanel';
      host.style.cssText = 'max-width:1100px;margin:8px auto 0;display:none';
      if(card && card.parentNode){ card.parentNode.insertBefore(host, card.nextSibling); }
      else{ document.body.appendChild(host); }
    }
    return host;
  }
  function toggleInventoryPanel(){
    const host = ensureInvHost();
    const on = host.style.display!=='none';
    if(on){
      host.style.display = 'none';
    }else{
      // open inventory ⇒ close map UI
      closeMapUI();
      host.style.display = 'block';
      renderInventoryPanel();
    }
  }
  function renderInventoryPanel(){
    const host = ensureInvHost();
    const inv  = getInventory();
    const ms   = getMissionCount();

    function itemRow(id, label, metaHTML){
      const canUse     = missionsOKToUse(id);
      const isEquipped = (equipped.weapon===id);
      const lockHTML = canUse ? '' : `<span style="margin-left:8px; font-size:12px; opacity:.8">Locked until mission ${id==='pistol'||id==='uzi'?3:''}</span>`;
      const btnHTML = canUse
        ? (isEquipped
            ? `<button data-unequip="${id}" style="margin-left:auto">Unequip</button>`
            : `<button data-equip="${id}" style="margin-left:auto">Equip</button>`
          )
        : '';
      return `
        <div class="inv-item" style="display:flex;align-items:center;gap:10px;padding:14px;background:#0f1522;border:1px solid #2a3550;border-radius:10px">
          <div style="width:28px;height:28px">${svgIcon(id, 28, 28)}</div>
          <div style="font-weight:600">${label}</div>
          ${lockHTML}
          <div style="margin-left:12px;opacity:.85;font-size:12px">${metaHTML||''}</div>
          ${btnHTML}
        </div>`;
    }

    function readOnlyRow(id, label, metaHTML){
      return `
        <div class="inv-item" style="display:flex;align-items:center;gap:10px;padding:14px;background:#0f1522;border:1px solid #2a3550;border-radius:10px">
          <div style="width:28px;height:28px">${svgIcon(id, 28, 28)}</div>
          <div style="font-weight:600">${label}</div>
          <div style="margin-left:12px;opacity:.85;font-size:12px">${metaHTML||''}</div>
        </div>`;
    }

    const rows = [];

    // Firearms
    if(inv.pistol && (inv.pistol.owned || (inv.pistol.ammo|0)>0)){
      rows.push(itemRow('pistol','Pistol', `Ammo: ${inv.pistol.ammo|0}`));
    }
    if(inv.uzi && (inv.uzi.owned || (inv.uzi.ammo|0)>0)){
      rows.push(itemRow('uzi','Uzi', `Ammo: ${inv.uzi.ammo|0}`));
    }

    // Melee
    if(inv.bat && inv.bat.count>0){
      const cur = inv.bat.hitsLeftOnCurrent|0;
      rows.push(itemRow('bat','Baseball Bat', `Count: ${inv.bat.count} | Current: ${cur}/${WEAPON_RULES.bat.hitsPerItem}`));
    }
    if(inv.knuckles && inv.knuckles.count>0){
      const cur = inv.knuckles.hitsLeftOnCurrent|0;
      rows.push(itemRow('knuckles','Brass Knuckles', `Count: ${inv.knuckles.count} | Current: ${cur}/${WEAPON_RULES.knuckles.hitsPerItem}`));
    }

    // Consumables
    if(inv.grenade && (inv.grenade.count|0) > 0){
      rows.push(readOnlyRow('grenade','Grenades', `Count: ${inv.grenade.count|0}`));
    }

    host.innerHTML = `
      <div style="background:#121827;border:1px solid #2a3550;border-radius:14px;padding:12px">
        <div style="display:flex; align-items:center; gap:10px; margin-bottom:8px">
          <div style="font-weight:700">Inventory</div>
          <div style="opacity:.8; font-size:12px">Missions completed: ${ms}</div>
          <div style="margin-left:auto; display:flex; gap:8px; align-items:center">
            <div style="opacity:.8; font-size:12px">Equipped: ${equipped.weapon}</div>
            <button class="ghost" id="unequipHands" type="button" title="Switch to hand combat">Use Hands</button>
            <div style="opacity:.8; font-size:12px">Press I to close</div>
          </div>
        </div>
        <div class="inv-body" style="display:flex; flex-direction:column; gap:8px; max-height:268px; overflow:auto; padding-right:4px">
          ${rows.length ? rows.join('') : '<div style="opacity:.8">No items yet. Defeat enemies or buy from the shop.</div>'}
        </div>
      </div>
    `;

    // Equip / Unequip actions
    host.querySelectorAll('[data-equip]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const id = btn.getAttribute('data-equip');
        if(!missionsOKToUse(id)) return;
        setEquippedWeapon(id);
        toast(`Equipped ${id}`);
        renderInventoryPanel();
      });
    });
    host.querySelectorAll('[data-unequip]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        unequipWeapon();
        renderInventoryPanel();
      });
    });

    const hands = document.getElementById('unequipHands');
    if(hands){
      hands.addEventListener('click', ()=>{
        unequipWeapon();
        renderInventoryPanel();
      });
    }
  }

  // ===== NPCs =====
  const pedestrians=[]; // {x,y,mode,dir,spd,hp,state,crossSide,vertX,blinkT,skin,facing,moving}
  const cars=[];        // {x,y,dir,spd}
  const cops=[];        // {x,y,spd,reinforceAt,kind,hp,facing}

  function clampToUnlockedX(px){
    const min=unlocked.x0*TILE, max=unlocked.x1*TILE;
    return Math.max(min, Math.min(max, px));
  }
  function clampToUnlockedY(py){
    const min=unlocked.y0*TILE, max=unlocked.y1*TILE;
    return Math.max(min, Math.min(max, py));
  }

  function spawnPed(){
    const left = Math.random()<0.5;
    const sideTop = Math.random()<0.5;
    const yRow = sideTop ? sidewalkTopY : sidewalkBotY;
    const gx = left ? unlocked.x0 : unlocked.x1;
    const dir = left ? 1 : -1;
    const skins = ['ped_m','ped_f','ped_m_dark','ped_f_dark'];
    const skin  = skins[(Math.random()*skins.length)|0];

    pedestrians.push({
      x: gx*TILE, y: yRow*TILE,
      mode:'horiz', dir, spd: 40,
      hp: 4,
      state: 'walk',
      crossSide: sideTop?'top':'bot',
      vertX: (Math.random()<0.5 ? vSidewalkLeftX : vSidewalkRightX),
      blinkT:0,
      skin,
      facing: dir>0?'right':'left',
      moving: true
    });
  }
  function spawnCar(){
    const left = Math.random()<0.5;
    const gx = left ? unlocked.x0 : unlocked.x1;
    const dir = left ? 1 : -1;
    cars.push({ x: gx*TILE, y: hRoadY*TILE, dir, spd: 120 });
  }

  function updatePed(p, dtSec){
    if(p.state==='walk'){
      if(p.mode==='horiz'){
        p.x += p.dir * p.spd * dtSec;
        p.facing = p.dir>0 ? 'right' : 'left';
        const gx = Math.floor(p.x/TILE);
        if(gx===vRoadX){
          p.mode='crossing';
        }else{
          if(p.x <= unlocked.x0*TILE || p.x >= unlocked.x1*TILE){
            p.dir *= -1;
            p.x = clampToUnlockedX(p.x);
          }
        }
      } else if(p.mode==='crossing'){
        const targetY = (p.crossSide==='top'? sidewalkBotY : sidewalkTopY)*TILE;
        const vy = (p.y < targetY) ? 1 : (p.y > targetY ? -1 : 0);
        p.y += vy * p.spd * dtSec;
        p.facing = vy<0 ? 'up' : vy>0 ? 'down' : p.facing;
        if(Math.abs(p.y - targetY) < 0.5){
          p.y = targetY;
          p.mode = 'vert';
          p.dir  = (Math.random()<0.5 ? -1 : 1);
          p.x = p.vertX*TILE;
        }
      } else if(p.mode==='vert'){
        p.y += p.dir * p.spd * dtSec;
        p.facing = p.dir>0 ? 'down' : 'up';
        if(p.y <= unlocked.y0*TILE || p.y >= unlocked.y1*TILE){
          p.dir *= -1;
          p.y = clampToUnlockedY(p.y);
        }
      }
    } else if(p.state==='blink'){
      p.blinkT -= dtSec;
      if(p.blinkT<=0){
        const i=pedestrians.indexOf(p);
        if(i>=0) pedestrians.splice(i,1);

        // drop coins; award happens on pickup via loot plugin
        const centerX = p.x + TILE/2, centerY = p.y + TILE/2;
        const pos = makeDropPos(centerX, centerY);
        const tnow = performance.now();
        IZZA.emit('ped-killed', {
          coins: 25,
          x: pos.x, y: pos.y,
          droppedAt: tnow,
          noPickupUntil: tnow + DROP_GRACE_MS
        });

        if(tutorial.active && tutorial.step==='hitPed'){
          tutorial.step='hitCop';
          showHint('Oh no! A cop is here. Eliminate the cop within 30 seconds (press A).');
        }
      }
    }
  }
  function updateCar(c, dtSec){
    c.x += c.dir * c.spd * dtSec;
    if(c.x < unlocked.x0*TILE) c.x = unlocked.x1*TILE;
    if(c.x > unlocked.x1*TILE) c.x = unlocked.x0*TILE;
  }

  // ===== Cops & wanted =====
  function copSpeed(kind){ return kind==='army'? 95 : kind==='swat'? 90 : 80; }
  function copHP(kind){ return kind==='army'?6 : kind==='swat'?5 : 4; }
  function spawnCop(kind){
    const left = Math.random()<0.5;
    const top  = Math.random()<0.5;
    const gx = left ? unlocked.x0 : unlocked.x1;
    const gy = top  ? unlocked.y0 : unlocked.y1;
    const now = performance.now();
    cops.push({ x: gx*TILE, y: gy*TILE, spd: copSpeed(kind), hp: copHP(kind), kind, reinforceAt: now + 30000, facing:'down' });
  }
  function maintainCops(){
    const needed = player.wanted;
    let cur = cops.length;
    while(cur < needed){
      let kind='police';
      if(needed>=5) kind='army';
      else if(needed>=4) kind='swat';
      spawnCop(kind); cur++;
    }
    while(cur > needed){ cops.pop(); cur--; }
  }
  function updateCops(dtSec, nowMs){
    for(const c of cops){
      const dx = player.x - c.x, dy = player.y - c.y, m=Math.hypot(dx,dy)||1;
      c.x += (dx/m) * c.spd * dtSec;
      c.y += (dy/m) * c.spd * dtSec;
      if(Math.abs(dy) >= Math.abs(dx)) c.facing = dy < 0 ? 'up' : 'down';
      else                              c.facing = dx < 0 ? 'left' : 'right';
      if(nowMs >= c.reinforceAt && player.wanted < 5){
        setWanted(player.wanted + 1);
        maintainCops();
        c.reinforceAt = nowMs + 30000;
      }
    }
  }
  function damageCop(c, amount){
    c.hp -= amount;
    if(c.hp <= 0){
      const i=cops.indexOf(c);
      if(i>=0) cops.splice(i,1);
      setWanted(player.wanted - 1);
      maintainCops();

      const centerX = c.x + TILE/2, centerY = c.y + TILE/2;
      const pos = makeDropPos(centerX, centerY);
      const tnow = performance.now();
      IZZA.emit('cop-killed', {
        cop: c,
        x: pos.x, y: pos.y,
        droppedAt: tnow,
        noPickupUntil: tnow + DROP_GRACE_MS
      });

      if(tutorial.active && tutorial.step==='hitCop'){
        tutorial.active=false; tutorial.step='';
        setMission1Done();
        showHint('Tutorial complete! Shops now carry starter items.', 4);
      }
    }
  }

  // ===== Combat =====
  function hitTest(ax,ay, bx,by, radius=20){ return Math.hypot(ax-bx, ay-by) <= radius; }
  function weaponDamage(){
    const rules = WEAPON_RULES[equipped.weapon] || WEAPON_RULES.fists;
    return rules.damage||1;
  }
  function consumeDurabilityIfNeeded(){
    const inv = getInventory();
    if (equipped.weapon==='bat' && inv.bat && inv.bat.count>0){
      inv.bat.hitsLeftOnCurrent = Math.max(0,(inv.bat.hitsLeftOnCurrent|0)-1);
      if(inv.bat.hitsLeftOnCurrent<=0){
        inv.bat.count -= 1;
        if(inv.bat.count>0){
          inv.bat.hitsLeftOnCurrent = WEAPON_RULES.bat.hitsPerItem;
        }else{
          equipped.weapon = 'fists';
          toast('Your bat broke!');
        }
      }
      setInventory(inv);
    }else if (equipped.weapon==='knuckles' && inv.knuckles && inv.knuckles.count>0){
      inv.knuckles.hitsLeftOnCurrent = Math.max(0,(inv.knuckles.hitsLeftOnCurrent|0)-1);
      if(inv.knuckles.hitsLeftOnCurrent<=0){
        inv.knuckles.count -= 1;
        if(inv.knuckles.count>0){
          inv.knuckles.hitsLeftOnCurrent = WEAPON_RULES.knuckles.hitsPerItem;
        }else{
          equipped.weapon = 'fists';
          toast('Your knuckles broke!');
        }
      }
      setInventory(inv);
    }
  }
  function doAttack(){
    const dmg = weaponDamage();
    let didHit=false;

    for(const p of pedestrians){
      if(hitTest(player.x,player.y, p.x,p.y, 22)){
        didHit=true;
        if(p.state==='walk'){
          if(player.wanted===0){ setWanted(1); maintainCops(); }
          p.hp -= dmg;
          if((equipped.weapon==='bat' || equipped.weapon==='knuckles') && p.hp<=0){
            p.state='blink'; p.blinkT=0.6;
            if(player.wanted < 5){ setWanted(player.wanted + 1); maintainCops(); }
          }else{
            if(p.hp<=1){ p.state='downed'; }
          }
        }else if(p.state==='downed'){
          p.state='blink'; p.blinkT=0.6;
          if(player.wanted < 5){ setWanted(player.wanted + 1); maintainCops(); }
        }
        consumeDurabilityIfNeeded();
        break;
      }
    }

    if(!didHit){
      for(const c of cops){
        if(hitTest(player.x,player.y, c.x,c.y, 24)){
          damageCop(c, dmg);
          consumeDurabilityIfNeeded();
          didHit=true; break;
        }
      }
    }
  }

  // ===== Maps & drawing =====
  const mini = document.getElementById('minimap');
  const mctx = mini ? mini.getContext('2d') : null;
  const bigmap   = document.getElementById('bigmap');
  const bctx     = bigmap ? bigmap.getContext('2d') : null;

  function drawCity(ctx2d, sx, sy){
    ctx2d.fillStyle = 'rgba(163,176,197,.25)';
    ctx2d.fillRect(preview.x0*sx, preview.y0*sy, (preview.x1-preview.x0+1)*sx, (preview.y1-preview.y0+1)*sy);
    ctx2d.fillStyle = '#1c293e';
    ctx2d.fillRect(unlocked.x0*sx, unlocked.y0*sy, (unlocked.x1-unlocked.x0+1)*sx, (unlocked.y1-unlocked.y0+1)*sy);
    ctx2d.fillStyle = '#788292';
    ctx2d.fillRect(preview.x0*sx, hRoadY*sy, (preview.x1-preview.x0+1)*sx, 1.4*sy);
    ctx2d.fillRect(vRoadX*sx, preview.y0*sy, 1.4*sx, (preview.y1-preview.y0+1)*sy);
    ctx2d.fillStyle = '#7a3a3a';
    ctx2d.fillRect(bX*sx, bY*sy, bW*sx, bH*sy);
    ctx2d.fillStyle = '#405a85';
    ctx2d.fillRect(shop.x*sx, shop.y*sy, shop.w*sx, shop.h*sy);
  }
  function drawMini(){
    if(!mini||!mctx) return;
    const sx = mini.width / W, sy = mini.height / H;
    mctx.fillStyle = '#000'; mctx.fillRect(0,0,mini.width,mini.height);
    drawCity(mctx, sx, sy);
    mctx.fillStyle = '#35f1ff';
    mctx.fillRect((player.x/TILE)*sx-1, (player.y/TILE)*sy-1, 2, 2);
  }
  function drawBig(){
    if(!bigmap||!bctx) return;
    const sx = bigmap.width / W, sy = bigmap.height / H;
    bctx.fillStyle = '#000'; bctx.fillRect(0,0,bigmap.width,bigmap.height);
    drawCity(bctx, sx, sy);
    bctx.fillStyle = '#35f1ff';
    bctx.fillRect((player.x/TILE)*sx-1.5,(player.y/TILE)*sy-1.5,3,3);
  }

  if(miniWrap) miniWrap.addEventListener('click', ()=>{
    // opening big map ⇒ close inventory
    closeInventory();
    drawBig();
    if(mapModal) mapModal.style.display='flex';
  });
  const closeMapBtn=document.getElementById('closeMap');
  if(closeMapBtn) closeMapBtn.addEventListener('click', ()=> { if(mapModal) mapModal.style.display='none'; });
  if(mapModal) mapModal.addEventListener('click', (e)=>{ if(e.target.classList.contains('backdrop')) mapModal.style.display='none'; });

  function drawTile(gx,gy){
    const S=DRAW, screenX=w2sX(gx*TILE), screenY=w2sY(gy*TILE);
    if(!inUnlocked(gx,gy)){ ctx.fillStyle='#000'; ctx.fillRect(screenX,screenY,S,S); return; }

    ctx.fillStyle = '#09371c'; ctx.fillRect(screenX,screenY,S,S); // grass

    if (gx>=bX && gx<bX+bW && gy>=bY && gy<bY+bH){ // HQ
      ctx.fillStyle = '#4a2d2d'; ctx.fillRect(screenX,screenY,S,S);
      ctx.fillStyle = 'rgba(0,0,0,.15)'; ctx.fillRect(screenX,screenY,S,Math.floor(S*0.18));
    }
    if (gx>=shop.x && gx<shop.x+shop.w && gy>=shop.y && gy<shop.y+shop.h){ // Shop
      ctx.fillStyle = '#203a60'; ctx.fillRect(screenX,screenY,S,S);
      ctx.fillStyle = '#88a8ff'; ctx.fillRect(screenX+S*0.15, screenY+S*0.15, S*0.7, S*0.25);
    }

    if (gy===sidewalkTopY || gy===sidewalkBotY){
      ctx.fillStyle = '#6a727b'; ctx.fillRect(screenX,screenY,S,S);
      ctx.strokeStyle = 'rgba(0,0,0,.25)'; ctx.strokeRect(screenX,screenY,S,S);
    }
    if (gx===vSidewalkLeftX || gx===vSidewalkRightX){
      ctx.fillStyle = '#6a727b'; ctx.fillRect(screenX,screenY,S,S);
      ctx.strokeStyle = 'rgba(0,0,0,.25)'; ctx.strokeRect(screenX,screenY,S,S);
    }

    if (gy===hRoadY){
      ctx.fillStyle = '#2a2a2a'; ctx.fillRect(screenX,screenY,S,S);
      ctx.fillStyle = '#ffd23f';
      for(let i=0;i<4;i++){
        ctx.fillRect(screenX + i*(S/4) + S*0.05, screenY + S*0.48, S*0.10, S*0.04);
      }
    }
    if (gx===vRoadX){
      ctx.fillStyle = '#2a2a2a'; ctx.fillRect(screenX,screenY,S,S);
    }

    if (gx===door.gx && gy===door.gy){
      const near = doorInRange();
      ctx.fillStyle = near ? '#39cc69' : '#49a4ff';
      const w = Math.floor(S*0.30), h = Math.floor(S*0.72);
      ctx.fillRect(screenX + (S-w)/2, screenY + (S-h), w, h);
      if(near && promptEl){
        promptEl.style.left = (screenX + S/2) + 'px';
        promptEl.style.top  = (screenY - 8) + 'px';
        promptEl.style.display = 'block';
      }
    }

    if(gx===shop.registerGX && gy===shop.sidewalkY){
      const px=Math.floor((player.x+TILE/2)/TILE), py=Math.floor((player.y+TILE/2)/TILE);
      const near = (Math.abs(px-gx)+Math.abs(py-gy))<=1;
      ctx.fillStyle = near ? 'rgba(136,168,255,0.6)' : 'rgba(136,168,255,0.3)';
      ctx.fillRect(screenX+S*0.35, screenY+S*0.35, S*0.3, S*0.3);
    }
  }

  function drawSprite(img, cols, facing, moving, t, dx,dy){
    const row = DIR_INDEX[facing]||0;
    const frame = currentFrame(cols, moving, t);
    ctx.imageSmoothingEnabled=false;
    ctx.drawImage(img, frame*FRAME_W, row*FRAME_H, FRAME_W, FRAME_H, dx,dy, DRAW,DRAW);
  }

  // ===== Held-weapon overlay (pixel art) =====
  function drawHeldWeapon(){
    const sx = w2sX(player.x), sy = w2sY(player.y);
    const S  = DRAW;
    const w  = Math.floor(S*0.30), h = Math.floor(S*0.12);

    if(equipped.weapon==='bat'){
      ctx.fillStyle = '#8b5a2b';
    }else if(equipped.weapon==='knuckles'){
      ctx.fillStyle = '#cfcfcf';
    }else if(equipped.weapon==='pistol'){
      ctx.fillStyle = '#202833';
    }else if(equipped.weapon==='uzi'){
      ctx.fillStyle = '#0b0e14';
    }else{
      return; // fists: nothing to draw
    }

    if(player.facing==='down'){
      ctx.fillRect(sx + S*0.55, sy + S*0.65, w, h);
    }else if(player.facing==='up'){
      ctx.fillRect(sx + S*0.10, sy + S*0.25, w, h);
    }else if(player.facing==='left'){
      ctx.fillRect(sx + S*0.10, sy + S*0.55, w, h);
    }else{ // right
      ctx.fillRect(sx + S*0.60, sy + S*0.55, w, h);
    }
  }

  // ===== Update & render =====
  function update(dtSec, dtMs){
    if(promptEl) promptEl.style.display='none';

    maybeRefreshMapTier();
    
    IZZA.emit('update-pre', { dtSec, now: performance.now() });

    if(tutorial.hintT>0){
      tutorial.hintT -= dtSec;
      if(tutorial.hintT<=0){ const h=document.getElementById('tutHint'); if(h) h.style.display='none'; }
    }

    // Movement (keys + joystick)
    let dx=0, dy=0;
    if(keys['arrowup']||keys['w']) dy-=1;
    if(keys['arrowdown']||keys['s']) dy+=1;
    if(keys['arrowleft']||keys['a']) dx-=1;
    if(keys['arrowright']||keys['d']) dx+=1;
    dx += vec.x; dy += vec.y;

    const mag=Math.hypot(dx,dy);
    const vx = mag ? (dx/mag)*player.speed : 0;
    const vy = mag ? (dy/mag)*player.speed : 0;

    if (mag > 0.01){
      if (Math.abs(dy) >= Math.abs(dx)) player.facing = dy < 0 ? 'up' : 'down';
      else                              player.facing = dx < 0 ? 'left' : 'right';
    }
    player.moving = (mag > 0.01);

    tryMove(player.x + vx*dtSec, player.y + vy*dtSec);
    centerCamera();

    if(player.moving) player.animTime += dtMs;

    // Spawns/updates
    if(pedestrians.length<6 && Math.random()<0.02) spawnPed();
    if(cars.length<3 && Math.random()<0.02) spawnCar();
    pedestrians.forEach(p=>updatePed(p, dtSec));
    cars.forEach(c=>updateCar(c, dtSec));

    // Cops
    updateCops(dtSec, performance.now());

    IZZA.emit('update-post', { dtSec, now: performance.now() });
  }

  function render(images){
    ctx.fillStyle='#000'; ctx.fillRect(0,0,cvs.width,cvs.height);

    const tilesX = Math.ceil(cvs.width  / DRAW) + 2;
    const tilesY = Math.ceil(cvs.height / DRAW) + 2;
    const startX = Math.max(0, Math.floor(camera.x / TILE));
    const startY = Math.max(0, Math.floor(camera.y / TILE));

    for(let y=0;y<tilesY;y++){
      for(let x=0;x<tilesX;x++){
        const gx=startX+x, gy=startY+y;
        if(gx>=0&&gx<W&&gy>=0&&gy<H) drawTile(gx,gy);
      }
    }

    // cars
    for(const c of cars){
      const sx=w2sX(c.x), sy=w2sY(c.y);
      ctx.fillStyle='#c0c8d8';
      ctx.fillRect(sx+DRAW*0.1,sy+DRAW*0.25, DRAW*0.8, DRAW*0.5);
    }

    // pedestrians
    for(const p of pedestrians){
      const imgPack = NPC_SHEETS[p.skin];
      if(imgPack){
        drawSprite(imgPack.img, imgPack.cols, p.facing||'down', p.state==='walk', player.animTime, w2sX(p.x), w2sY(p.y));
      }else{
        const sx=w2sX(p.x), sy=w2sY(p.y);
        ctx.fillStyle = p.state==='downed' ? '#555' : '#9de7b1';
        ctx.fillRect(sx+DRAW*0.2, sy+DRAW*0.2, DRAW*0.6, DRAW*0.6);
      }
    }

    // player layers
    drawSprite(images.body.img,   images.body.cols,   player.facing, player.moving, player.animTime, w2sX(player.x), w2sY(player.y));
    drawSprite(images.outfit.img, images.outfit.cols, player.facing, player.moving, player.animTime, w2sX(player.x), w2sY(player.y));
    drawSprite(images.hair.img,   images.hair.cols,   player.facing, player.moving, player.animTime, w2sX(player.x), w2sY(player.y));

    // held weapon overlay
    drawHeldWeapon();

    // cops
    for(const c of cops){
      const pack = c.kind==='army' ? NPC_SHEETS.military
                 : c.kind==='swat' ? NPC_SHEETS.swat
                 :                    NPC_SHEETS.police;
      if(pack){
        drawSprite(pack.img, pack.cols, c.facing||'down', true, player.animTime, w2sX(c.x), w2sY(c.y));
      }else{
        const sx=w2sX(c.x), sy=w2sY(c.y);
        ctx.fillStyle = c.kind==='army' ? '#3e8a3e' : c.kind==='swat' ? '#000' : '#0a2455';
        ctx.fillRect(sx+DRAW*0.15, sy+DRAW*0.15, DRAW*0.7, DRAW*0.7);
      }
    }

    drawMini();
  }

  // ===== Boot =====
  Promise.all([
    loadLayer('body',   BODY),
    loadLayer('outfit', OUTFIT),
    loadLayer('hair',   HAIR),
    loadNPCSheets()
  ]).then(([body,outfit,hair,npcs])=>{
    NPC_SHEETS = npcs;
    const imgs={body,outfit,hair};

    const doorSpawn = { x: door.gx*TILE + (TILE/2 - 8), y: door.gy*TILE };
    IZZA.api = {
  player, cops, pedestrians, cars,
  setCoins, getCoins, setWanted,
  TILE, DRAW, camera,
  doorSpawn,
  // expose for plugins:
  getMissionCount,
  getInventory, setInventory,
  ready: true
};
    IZZA.emit('ready', IZZA.api);

    setCoins(getCoins());
    centerCamera();

    let last=performance.now();
    (function loop(now){
      try{
        const dtMs=Math.min(32, now-last); last=now;
        const dtSec = dtMs/1000;
        update(dtSec, dtMs);
        render(imgs);
        IZZA.emit('render-post', { now: performance.now() });
      }catch(err){
        console.error('Game loop error:', err);
        bootMsg('Game loop error: '+err.message, '#ff6b6b');
      }
      requestAnimationFrame(loop);
    })(last+16);
  }).catch(err=>{
    console.error('Sprite load failed', err);
    bootMsg('Sprite load failed: '+(err && err.message ? err.message : err), '#ff6b6b');
  });
})();
