/* mission5_halloween.plugin.js
   IZZA Mission 5 — “Night of the Lantern”
   - Triggers after Mission 4 (cardboard armour crafted / mission-complete:4)
   - Places a jack-o’-lantern 5 tiles east & 4 tiles north of HQ door
   - “Take Jack-o’-Lantern” starts a 5-minute pumpkin hunt at night
   - 3 pumpkins spawn at exact tile offsets; collect with [B]
   - Werewolf spawns every 30s while the player is moving (night only)
   - Craft “Pumpkin Armour” at Armoury if player holds 1 lantern + 3 pumpkins
   - Pumpkin Armour: -20% incoming damage, boosted leg speed (near car speed)
   - All art/FX are inline SVG; no external assets required
*/
(function(){
  if (!window.IZZA || typeof IZZA.on !== 'function') return;

  // -------------------- helpers & handles --------------------
  let api   = null;      // filled on 'ready'
  let TILE  = 60;        // fallback; will read from api.TILE
  let DRAW  = null;      // api.DRAW (SVG / sprite helper if present)
  const NS  = 'mission5-halloween';

  // Safe bus emit
  function emit(ev, payload){ try { IZZA.emit(ev, payload||{}); } catch(e){} }

  // Try multiple ways to read HQ door tile (game already respawns here)
  function getHQDoorTile(){
    // Preferred: api.getHQDoorTile() → {tx,ty}
    if (api && typeof api.getHQDoorTile === 'function') {
      const t = api.getHQDoorTile();
      if (t && Number.isFinite(t.tx) && Number.isFinite(t.ty)) return t;
    }
    // Fallback: api.getHQDoor() → {x,y} in world px
    if (api && typeof api.getHQDoor === 'function') {
      const p = api.getHQDoor();
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
        return { tx: Math.round(p.x / TILE), ty: Math.round(p.y / TILE) };
      }
    }
    // Fallback: body data attributes
    const b = document.body;
    const tx = Number(b.getAttribute('data-hq-tx'));
    const ty = Number(b.getAttribute('data-hq-ty'));
    if (Number.isFinite(tx) && Number.isFinite(ty)) return {tx,ty};

    // Last resort: centerish
    return { tx: 100, ty: 100 };
  }

  function tileToWorld(tx, ty){
    return { x: (tx+0.5)*TILE, y: (ty+0.5)*TILE }; // center of tile
  }

  function dist(a,b){ const dx=a.x-b.x, dy=a.y-b.y; return Math.hypot(dx,dy); }

  function playerPos(){
    if (api && api.player) return { x: api.player.x, y: api.player.y };
    if (api && typeof api.getPlayer === 'function') {
      const p = api.getPlayer();
      if (p) return {x:p.x,y:p.y};
    }
    return { x:0, y:0 };
  }

  function inArmoury(){
    if (api && typeof api.inZone === 'function') return api.inZone('armoury') === true;
    // fallback: near a known armoury anchor if provided
    if (api && typeof api.getPOI === 'function'){
      const a = api.getPOI('armoury'); if (a) return dist(playerPos(), a) < 2.2*TILE;
    }
    return false;
  }

  // --------------- inventory & recipe helpers ----------------
  function invHas(id, n){
    n = n|0; if (n<=0) return true;
    if (api && api.inventory && typeof api.inventory.count === 'function') {
      return api.inventory.count(id) >= n;
    }
    // fallback: memory cache
    return (INV_CACHE[id]||0) >= n;
  }

  function invAdd(id, n, meta){
    n = n||1;
    if (api && api.inventory && typeof api.inventory.add === 'function') {
      api.inventory.add({ id, qty:n, meta: meta||{} });
    } else {
      INV_CACHE[id] = (INV_CACHE[id]||0)+n;
      emit('inventory-add', { id, qty:n, meta: meta||{} });
    }
  }

  function invRemove(id, n){
    n = n||1;
    if (api && api.inventory && typeof api.inventory.remove === 'function') {
      api.inventory.remove({ id, qty:n });
    } else {
      INV_CACHE[id] = Math.max(0, (INV_CACHE[id]||0)-n);
      emit('inventory-remove', { id, qty:n });
    }
  }

  function missionCompletePopup(n){
    const title = `Mission Completed`;
    const body  = `You’ve completed mission ${n}.`;
    uiSecretAgentPopup(title, body);
    // bump inventory tag “missions completed” to n
    emit('missions-updated', { completed:n });
    if (api && api.inventory && typeof api.inventory.setMeta === 'function'){
      api.inventory.setMeta('missionsCompleted', n);
    }
  }

  // -------------------- SVG/FX helpers ----------------------
  function addSVG(id, svg, x, y, w, h, layer){
    // Prefer DRAW helper
    if (DRAW && typeof DRAW.addSVG === 'function') {
      return DRAW.addSVG({ id, svg, x, y, w, h, layer: layer||'world', anchor:'center' });
    }
    // DOM fallback: pin to #game overlay
    let host = document.getElementById(id);
    if (!host){
      host = document.createElement('div');
      host.id = id;
      host.style.position = 'absolute';
      host.style.pointerEvents = 'none';
      (document.getElementById('gameCard') || document.body).appendChild(host);
    }
    host.innerHTML = svg;
    host.style.left = (x - (w/2)) + 'px';
    host.style.top  = (y - (h/2)) + 'px';
    host.style.width  = w + 'px';
    host.style.height = h + 'px';
    return host;
  }
  function removeSVG(id){
    if (DRAW && typeof DRAW.remove === 'function') return DRAW.remove(id);
    const n = document.getElementById(id); if (n && n.parentNode) n.parentNode.removeChild(n);
  }

  function uiSecretAgentPopup(title, body){
    // Use existing UI popup if present
    if (api && api.UI && typeof api.UI.popup === 'function'){
      api.UI.popup({ style:'agent', title, body, timeout:2000 });
      return;
    }
    // Minimal fallback
    const el = document.createElement('div');
    el.className='m5-agent-pop';
    el.innerHTML = `<div class="inner"><h3>${title}</h3><p>${body}</p></div>`;
    Object.assign(el.style,{
      position:'absolute', left:'50%', top:'18%', transform:'translateX(-50%)',
      background:'rgba(10,12,20,0.92)', color:'#b6ffec', padding:'14px 18px',
      border:'2px solid #36f', borderRadius:'8px', fontFamily:'monospace',
      zIndex:9999
    });
    (document.getElementById('gameCard')||document.body).appendChild(el);
    setTimeout(()=>{ if(el.parentNode) el.parentNode.removeChild(el); }, 2000);
  }

  // Night overlay
  let nightOn = false;
  function setNight(on){
    if (on === nightOn) return;
    nightOn = on;
    if (on){
      // darker tint and slight vignette
      const id='m5-night';
      const host = document.getElementById(id) || (()=>{
        const d = document.createElement('div'); d.id=id;
        Object.assign(d.style,{
          position:'absolute', inset:0, pointerEvents:'none',
          background:'radial-gradient(ellipse at 50% 45%, rgba(0,0,0,0.25) 0%, rgba(0,0,0,0.8) 70%)',
          mixBlendMode:'multiply', zIndex: 5000
        });
        (document.getElementById('gameCard')||document.body).appendChild(d);
        return d;
      })();
      // blue cast layer
      const id2='m5-night-blue';
      const h2 = document.getElementById(id2) || (()=>{
        const d=document.createElement('div'); d.id=id2;
        Object.assign(d.style,{
          position:'absolute', inset:0, pointerEvents:'none',
          background:'rgba(30,60,120,0.15)', mixBlendMode:'screen', zIndex: 5001
        });
        (document.getElementById('gameCard')||document.body).appendChild(d);
        return d;
      })();
    } else {
      const n1=document.getElementById('m5-night'); if(n1&&n1.parentNode) n1.parentNode.removeChild(n1);
      const n2=document.getElementById('m5-night-blue'); if(n2&&n2.parentNode) n2.parentNode.removeChild(n2);
    }
    emit('world-night-overlay', { on });
  }

  // -------------------- Mission State -----------------------
  const INV_CACHE = {}; // fallback only
  let jackPlaced = false;
  let jackId     = 'm5_jack';
  let jackTile   = null;

  let pumpkinsPlaced = false;
  const pumpkinIds   = ['m5_p1','m5_p2','m5_p3'];
  const pumpkinTiles = []; // computed from HQ door

  let mission5Active    = false;
  let mission5StartTime = 0;      // ms
  const MISSION_MS      = 5*60*1000;

  let werewolfTimer = 0;          // next spawn ms
  const WEREWOLF_COOLDOWN = 30*1000;
  let lastMovePos = null;

  // -------------------- SVG Art ------------------------------
  function svgJackLantern(){
    return `
<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
 <defs>
   <radialGradient id="g" cx="50%" cy="50%" r="60%">
     <stop offset="0%" stop-color="#ffb347"/>
     <stop offset="60%" stop-color="#ff7b00"/>
     <stop offset="100%" stop-color="#792900"/>
   </radialGradient>
   <linearGradient id="stem" x1="0" y1="0" x2="0" y2="1">
     <stop offset="0%" stop-color="#3b7a2a"/>
     <stop offset="100%" stop-color="#1f4419"/>
   </linearGradient>
   <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
     <feGaussianBlur stdDeviation="4" result="b"/>
     <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
   </filter>
 </defs>
 <ellipse cx="100" cy="110" rx="78" ry="70" fill="url(#g)" stroke="#552200" stroke-width="6"/>
 <rect x="92" y="30" width="16" height="28" rx="6" fill="url(#stem)"/>
 <!-- face -->
 <polygon points="60,90 85,110 35,110" fill="#ffd23f" filter="url(#glow)"/>
 <polygon points="140,90 165,110 115,110" fill="#ffd23f" filter="url(#glow)"/>
 <path d="M45 140 Q100 175 155 140 Q140 150 100 155 Q60 150 45 140 Z" fill="#ffd23f" filter="url(#glow)"/>
 <!-- subtle ribbing -->
 <path d="M100 45 V175" stroke="rgba(255,200,120,0.25)" stroke-width="2"/>
 <path d="M75 50 V170" stroke="rgba(255,200,120,0.22)" stroke-width="2"/>
 <path d="M125 50 V170" stroke="rgba(255,200,120,0.22)" stroke-width="2"/>
 <!-- HA HA HA streamer -->
 <g id="haha" opacity="0.95">
   <text x="100" y="80" text-anchor="middle" font-size="22" fill="#ffd23f" style="font-family:'Joker',monospace;">
     HA HA HA
   </text>
 </g>
 <animate xlink:href="#haha" attributeName="transform" type="translate" from="0,0" to="0,-40" dur="2.4s" repeatCount="indefinite"/>
 <animate xlink:href="#haha" attributeName="opacity" from="0.0" to="1" dur="0.2s" begin="0s" fill="freeze"/>
</svg>`;
  }

  function svgPumpkinSmall(){
    return `
<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg">
 <defs>
   <radialGradient id="gp" cx="50%" cy="50%" r="60%">
     <stop offset="0%" stop-color="#ffb347"/>
     <stop offset="60%" stop-color="#ff7b00"/>
     <stop offset="100%" stop-color="#7a2f00"/>
   </radialGradient>
 </defs>
 <ellipse cx="40" cy="44" rx="28" ry="24" fill="url(#gp)" stroke="#552200" stroke-width="4"/>
 <rect x="35" y="18" width="8" height="10" rx="3" fill="#2c5e22"/>
</svg>`;
  }

  function svgWerewolf(){
    return `
<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg">
 <defs>
  <linearGradient id="fur" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#4c4c4c"/>
    <stop offset="100%" stop-color="#1f1f1f"/>
  </linearGradient>
  <filter id="shadow" x="-50%" y="-50%" width="200%" height="200%">
    <feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="#000" flood-opacity="0.7"/>
  </filter>
 </defs>
 <circle cx="60" cy="60" r="40" fill="url(#fur)" filter="url(#shadow)"/>
 <polygon points="30,30 45,20 38,42" fill="#2a2a2a"/>
 <polygon points="90,30 75,20 82,42" fill="#2a2a2a"/>
 <circle cx="45" cy="60" r="6" fill="#ffd23f"/>
 <circle cx="75" cy="60" r="6" fill="#ffd23f"/>
 <path d="M38 82 Q60 70 82 82" stroke="#ffd23f" stroke-width="4" fill="none"/>
</svg>`;
  }

  function svgPumpkinArmorIcon(){
    // used in inventory popup / craft result
    return `
<svg viewBox="0 0 200 160" xmlns="http://www.w3.org/2000/svg">
 <rect x="15" y="20" width="170" height="120" rx="10" fill="#1a1329" stroke="#6c3cff" stroke-width="4"/>
 <g transform="translate(22,12) scale(0.85)">
  <path d="M30 90 L60 40 L140 40 L170 90 L140 110 L60 110 Z"
        fill="#ff7b00" stroke="#3b1b00" stroke-width="6"/>
  <!-- skull stencils -->
  <circle cx="70" cy="78" r="10" fill="#b97fff"/>
  <circle cx="130" cy="78" r="10" fill="#b97fff"/>
  <rect x="92" y="84" width="16" height="6" rx="3" fill="#b97fff"/>
  <!-- spiked shoulders -->
  <polygon points="30,88 12,76 30,70" fill="#b97fff"/>
  <polygon points="170,88 188,76 170,70" fill="#b97fff"/>
  <!-- helm spike -->
  <polygon points="98,28 102,10 106,28" fill="#b97fff"/>
 </g>
</svg>`;
  }

  // -------------------- Placement logic ---------------------
  function placeJack(){
    if (jackPlaced) return;
    const hq = getHQDoorTile();
    jackTile = { tx: hq.tx + 5, ty: hq.ty - 4 };
    const w = TILE*3.0, h = TILE*3.0;
    const p = tileToWorld(jackTile.tx, jackTile.ty);
    addSVG(jackId, svgJackLantern(), p.x, p.y, w, h, 'world');
    jackPlaced = true;

    // laugh loop (every 2.5s)
    if (!placeJack.lolTimer){
      placeJack.lolTimer = setInterval(()=>{
        emit('sfx', { kind:'jack-HA', vol:0.6 });
      }, 2500);
    }
  }

  function removeJack(){
    if (!jackPlaced) return;
    removeSVG(jackId);
    if (placeJack.lolTimer){ clearInterval(placeJack.lolTimer); placeJack.lolTimer=null; }
    jackPlaced = false;
  }

  function computePumpkinTiles(){
    pumpkinTiles.length = 0;
    const hq = getHQDoorTile();

    // #1: 15 tiles west, 10 tiles south of HQ door
    const p1 = { tx: hq.tx - 15, ty: hq.ty + 10 };
    // #2: 13 tiles south AND 20 tiles west of the FIRST pumpkin
    const p2 = { tx: p1.tx - 20, ty: p1.ty + 13 };
    // #3: 8 tiles east, 13 tiles north of HQ door
    const p3 = { tx: hq.tx + 8, ty: hq.ty - 13 };

    pumpkinTiles.push(p1, p2, p3);
  }

  function placePumpkins(){
    if (pumpkinsPlaced) return;
    computePumpkinTiles();
    for (let i=0;i<3;i++){
      const id = pumpkinIds[i];
      const t  = pumpkinTiles[i];
      const p  = tileToWorld(t.tx, t.ty);
      addSVG(id, svgPumpkinSmall(), p.x, p.y, TILE*1.6, TILE*1.6, 'world');
    }
    pumpkinsPlaced = true;
  }

  function removePumpkins(){
    if (!pumpkinsPlaced) return;
    for (const id of pumpkinIds) removeSVG(id);
    pumpkinsPlaced = false;
  }

  // -------------------- Werewolf spawns ---------------------
  function playerIsMoving(){
    const pos = playerPos();
    if (!lastMovePos){ lastMovePos = pos; return false; }
    const d = dist(pos, lastMovePos);
    lastMovePos = pos;
    return d > 0.35*TILE; // moving at least ~1/3 tile
  }

  function spawnWerewolf(){
    // Prefer api.spawnNPC; fallback draws an SVG and emits a chase event
    const where = playerPos();
    // pop “from the ground”
    if (api && typeof api.spawnNPC === 'function'){
      api.spawnNPC({
        kind: 'werewolf',
        x: where.x + (Math.random()*TILE*2 - TILE),
        y: where.y + (Math.random()*TILE*2 - TILE),
        hostile: true,
        attackDamage: 12,
        chaseRange: TILE*10,
        onDeath: ()=> emit('loot-drop', { kind:'hide_dragon', qty:1 }) // your standard drop
      });
    } else {
      const id = `m5_w_${Date.now()%1e7}`;
      addSVG(id, svgWerewolf(), where.x, where.y, TILE*2.0, TILE*2.0, 'world');
      // Simple chase: nudge towards player, damage pulses
      const born = performance.now();
      const loop = ()=>{
        const now = performance.now();
        if (!nightOn || (now-born)>30000){ removeSVG(id); return; } // despawn after 30s
        const me = document.getElementById(id);
        if (!me) return;
        const p  = playerPos();
        const r  = me.getBoundingClientRect(); // DOM fallback; coarse
        // artificial step: just emit an attack tick if near
        if (dist(p, {x:parseFloat(me.style.left)||p.x, y:parseFloat(me.style.top)||p.y}) < TILE*1.6){
          emit('player-damage', { amount: 8, src:'werewolf' });
        }
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    }
    emit('sfx', { kind:'werewolf-spawn', vol:0.8 });
  }

  function tickWerewolf(now){
    if (!mission5Active || !nightOn) return;
    if (now >= werewolfTimer){
      if (playerIsMoving()){ spawnWerewolf(); }
      werewolfTimer = now + WEREWOLF_COOLDOWN;
    }
  }

  // -------------------- Interactions ------------------------
  function nearTile(tx,ty, radiusPx){
    const p = tileToWorld(tx,ty);
    return dist(playerPos(), p) <= (radiusPx || TILE*1.2);
  }

  function onButtonB(){
    // Interact with Jack
    if (jackPlaced && nearTile(jackTile.tx, jackTile.ty)){
      // Show mission toast with choices
      showNightIntro();
      return;
    }
    // Interact with pumpkins (collect)
    if (pumpkinsPlaced){
      for (let i=0;i<3;i++){
        const t = pumpkinTiles[i];
        if (nearTile(t.tx, t.ty, TILE*1.2)){
          const id = pumpkinIds[i];
          removeSVG(id);
          invAdd('pumpkin_piece', 1);
          emit('toast', { text:'+1 Pumpkin', kind:'loot' });
          // mark as removed so we don’t re-collect
          pumpkinTiles[i] = { tx: 99999, ty: 99999 };
          break;
        }
      }
    }
  }

  function showNightIntro(){
    // Use your UI if present
    const ok = (api && api.UI && typeof api.UI.choice === 'function');
    const title = 'WELCOME TO IZZA CITY AT NIGHT';
    const body  = "Avoid the riff raft at night around these parts. Collect all 3 pumpkins within 5 minutes and bring them to the armoury to craft Pumpkin Armour!";
    const opts  = [
      { id:'take',  label:'Take Jack-o’-Lantern' },
      { id:'leave', label:'Leave it' }
    ];
    if (ok){
      api.UI.choice({
        title,
        body,
        spooky:true,
        options: opts,
        onChoose: (id)=> (id==='take') ? acceptNightMission() : null
      });
    } else {
      // fallback simple confirm
      const take = confirm(title + "\n\n" + body + "\n\nStart Mission 5?");
      if (take) acceptNightMission();
    }
  }

  function acceptNightMission(){
    invAdd('jack_o_lantern', 1);
    emit('celebrate', { style:'spray-skull' }); // reuse your mission 4 celebration
    setNight(true);
    mission5Active    = true;
    mission5StartTime = performance.now();
    removeJack();
    placePumpkins();
    werewolfTimer = mission5StartTime + 500; // first check in 0.5s

    // Show timer HUD if available
    emit('mission-timer', { id:'m5', ms: MISSION_MS, start: mission5StartTime });

    emit('toast',{ text:'Mission 5 started: collect 3 pumpkins and craft Pumpkin Armour!', kind:'mission'});
  }

  // -------------------- Crafting hook -----------------------
  function tryCraftPumpkinArmor(){
    if (!mission5Active) return false;
    if (!inArmoury())    return false;

    if (invHas('jack_o_lantern',1) && invHas('pumpkin_piece',3)){
      // Consume and grant armour set
      invRemove('jack_o_lantern',1);
      invRemove('pumpkin_piece',3);
      invAdd('armor_pumpkin_helm',1, { dr:0.05, speed:0.0, set:'pumpkin' });
      invAdd('armor_pumpkin_chest',1, { dr:0.10, speed:0.0, set:'pumpkin' });
      invAdd('armor_pumpkin_legs',1, { dr:0.05, speed:0.28, set:'pumpkin' }); // legs give speed

      // Register stat modifiers (prefer official API if present)
      if (api && typeof api.gear === 'object' && typeof api.gear.setMeta === 'function'){
        api.gear.setMeta('pumpkin_set', { totalDR:0.20, legSpeed: 'car-like' });
      }

      // Nice popup with SVG icon
      if (api && api.UI && typeof api.UI.popupSVG === 'function'){
        api.UI.popupSVG({ title:'Pumpkin Armour Crafted!', svg: svgPumpkinArmorIcon(), timeout:2200 });
      } else {
        uiSecretAgentPopup('Pumpkin Armour Crafted!', 'Set bonus: 20% damage reduction. Legs move fast!');
      }

      // Complete mission
      mission5Active = false;
      setNight(false);
      removePumpkins();
      missionCompletePopup(5);
      emit('mission-complete', { id:5, name:'Night of the Lantern' });

      return true;
    }
    return false;
  }

  // --------------- Main wiring & lifecycle ------------------
  IZZA.on('ready', ({ api:__api })=>{
    api = __api || api || {};
    DRAW = (api && api.DRAW) ? api.DRAW : null;
    TILE = (api && api.TILE) ? api.TILE : TILE;
  });

  // Mission 4 completion triggers jack placement
  // We listen to multiple possible signals to be robust with your current code.
  IZZA.on('mission-complete', ({ id })=>{
    if (id === 4) placeJack();
  });
  IZZA.on('armor-crafted', ({ kind })=>{
    if (kind === 'cardboard') placeJack();
  });
  IZZA.on('gear-crafted', ({ kind })=>{
    if (kind === 'cardboard') placeJack();
  });

  // Interact with [B]
  IZZA.on('button-B', onButtonB);

  // Periodic update (for werewolves & mission timer expiry)
  IZZA.on('update-post', ({ now })=>{
    if (!mission5Active) return;
    tickWerewolf(now);

    // Timeout check
    if ((now - mission5StartTime) > MISSION_MS){
      mission5Active = false;
      setNight(false);
      removePumpkins();
      emit('toast', { text:'Mission 5 failed — time expired.', kind:'fail' });
      // Optionally: re-place jack to retry
      setTimeout(placeJack, 800);
    }
  });

  // Allow crafting via a generic “action” while in Armoury
  IZZA.on('button-A', ()=>{
    // If your A is attack and B is interact, we keep A for crafting *only inside* armoury
    if (tryCraftPumpkinArmor()){
      emit('sfx', { kind:'craft-complete', vol:0.9 });
    }
  });

  // Also catch armoury UI open if your code emits it
  IZZA.on('armoury-open', ()=>{ tryCraftPumpkinArmor(); });

  // Ensure jack re-places after reload if mission 4 is already complete
  IZZA.on('resume', ({ inventoryMeta })=>{
    const m = (inventoryMeta && inventoryMeta.missionsCompleted) || 0;
    if (m >= 4) placeJack();
  });

  // Clean up on unload (optional)
  IZZA.on('shutdown', ()=>{
    removeJack();
    removePumpkins();
    setNight(false);
  });

})();
