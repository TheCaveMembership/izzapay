/* mission5_halloween.plugin.js
   IZZA Mission 5 — “Night of the Lantern”
   - Works with your current Core v3 + v2_map_expander, no core edits required.
   - Mirrors Mission 4 wiring: direct B/key listeners + tile checks.
   - Detects Cardboard crafting by watching the Armoury craft button + inventory change,
     then:
       (1) shows a Mission 4 completion popup (over Armoury or after it closes),
       (2) bumps localStorage izzaMissions to 4,
       (3) places the jack-o’-lantern 5E,4N of HQ door.
   - Taking the lantern starts Night Mode + 5-minute pumpkin hunt + werewolves.
   - Craft Pumpkin Armour (4 pieces) in Armoury from 1 lantern + 3 pumpkins.
   - On mission 5 completion: popup and izzaMissions++ to 5.
   - All art/FX are inline SVG; no external assets required.
*/
(function(){
  if (!window.IZZA || typeof IZZA.on !== 'function') return;

  // -------------------- local helpers --------------------
  let api = null;
  let TILE = 60;
  const NS = 'm5-halloween';

  // Core progress helpers (mirror core LS keys)   [oai_citation:3‡izza_core_v3.js](file-service://file-HfYX3Vg6mr3MPKcqtK12RA)
  const LS = { missions: 'izzaMissions', inventory:'izzaInventory' };
  function getMissionCount(){
    try{ return parseInt(localStorage.getItem(LS.missions)||'0',10)||0; }catch{ return 0; }
  }
  function setMissionCount(n){
    try{
      const cur = getMissionCount();
      if (n>cur) localStorage.setItem(LS.missions, String(n));
    }catch{}
    try{ window.dispatchEvent(new Event('izza-inventory-changed')); }catch{}
  }
  function readInv(){
    try{ return JSON.parse(localStorage.getItem(LS.inventory)||'{}'); }catch{ return {}; }
  }
  function writeInv(inv){
    try{ localStorage.setItem(LS.inventory, JSON.stringify(inv||{})); }catch{}
    try{ window.dispatchEvent(new Event('izza-inventory-changed')); }catch{}
  }
  function addCount(inv, key, n){
    const slot = inv[key] || { count:0 };
    slot.count = (slot.count|0) + n;
    if (slot.count<=0) { delete inv[key]; } else { inv[key]=slot; }
  }

  // ---- HQ door → grid coord (same logic family as your existing scripts)
  function hqDoorGrid(){
    const d = api.doorSpawn || { x: api.player?.x||0, y: api.player?.y||0 };
    return { gx: Math.round(d.x/TILE), gy: Math.round(d.y/TILE) };
  }
  function tileCenter(tx,ty){ return { x:(tx+0.5)*TILE, y:(ty+0.5)*TILE }; }

  // -------------------- SECRET AGENT POPUP (fallback UI) --------------------
  function showAgentPopup(title, body, ms){
    // If your UI framework exposes a popup, use it
    if (api && api.UI && typeof api.UI.popup === 'function'){
      api.UI.popup({ style:'agent', title, body, timeout: ms||2200 });
      return;
    }
    // Minimal fallback
    const el = document.createElement('div');
    el.className='m5-agent';
    el.innerHTML = `<div class="inner"><h3>${title}</h3><p>${body||''}</p></div>`;
    Object.assign(el.style,{position:'absolute',left:'50%',top:'18%',transform:'translateX(-50%)',
      background:'rgba(10,12,20,0.94)',color:'#b6ffec',padding:'14px 18px',border:'2px solid #36f',
      borderRadius:'10px',zIndex:99999,fontFamily:'monospace'});
    (document.getElementById('gameCard')||document.body).appendChild(el);
    setTimeout(()=>{ el.remove(); }, ms||2200);
  }

  // -------------------- SVG Art --------------------
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
     <feGaussianBlur stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
   </filter>
 </defs>
 <ellipse cx="100" cy="110" rx="78" ry="70" fill="url(#g)" stroke="#552200" stroke-width="6"/>
 <rect x="92" y="30" width="16" height="28" rx="6" fill="url(#stem)"/>
 <polygon points="60,90 85,110 35,110" fill="#ffd23f" filter="url(#glow)"/>
 <polygon points="140,90 165,110 115,110" fill="#ffd23f" filter="url(#glow)"/>
 <path d="M45 140 Q100 175 155 140 Q140 150 100 155 Q60 150 45 140 Z" fill="#ffd23f" filter="url(#glow)"/>
 <g id="haha" opacity="0.95">
   <text x="100" y="80" text-anchor="middle" font-size="22" fill="#ffd23f" style="font-family: 'Courier New', monospace;">HA HA HA</text>
 </g>
 <animate xlink:href="#haha" attributeName="transform" type="translate" from="0,0" to="0,-40" dur="2.5s" repeatCount="indefinite"/>
 <animate xlink:href="#haha" attributeName="opacity" values="0;1;0" keyTimes="0;0.08;1" dur="2.5s" repeatCount="indefinite"/>
</svg>`;
  }
  function svgPumpkinSmall(){
    return `
<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg">
 <defs><radialGradient id="gp" cx="50%" cy="50%" r="60%">
   <stop offset="0%" stop-color="#ffb347"/><stop offset="60%" stop-color="#ff7b00"/><stop offset="100%" stop-color="#7a2f00"/></radialGradient></defs>
 <ellipse cx="40" cy="44" rx="28" ry="24" fill="url(#gp)" stroke="#552200" stroke-width="4"/>
 <rect x="35" y="18" width="8" height="10" rx="3" fill="#2c5e22"/>
</svg>`;
  }
  function svgWerewolf(){
    return `
<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg">
 <defs>
  <linearGradient id="fur" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#4c4c4c"/><stop offset="100%" stop-color="#1f1f1f"/>
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
    return `
<svg viewBox="0 0 200 160" xmlns="http://www.w3.org/2000/svg">
 <rect x="15" y="20" width="170" height="120" rx="10" fill="#1a1329" stroke="#6c3cff" stroke-width="4"/>
 <g transform="translate(22,12) scale(0.85)">
  <path d="M30 90 L60 40 L140 40 L170 90 L140 110 L60 110 Z" fill="#ff7b00" stroke="#3b1b00" stroke-width="6"/>
  <circle cx="70" cy="78" r="10" fill="#b97fff"/><circle cx="130" cy="78" r="10" fill="#b97fff"/>
  <rect x="92" y="84" width="16" height="6" rx="3" fill="#b97fff"/>
  <polygon points="30,88 12,76 30,70" fill="#b97fff"/><polygon points="170,88 188,76 170,70" fill="#b97fff"/>
  <polygon points="98,28 102,10 106,28" fill="#b97fff"/>
 </g>
</svg>`;
  }

  // -------------------- simple SVG host helpers --------------------
  function addSVG(id, svg, x, y, w, h){
    // DOM fallback host pinned above canvas
    let host = document.getElementById(id);
    if (!host){
      host = document.createElement('div');
      host.id = id;
      host.style.position = 'absolute';
      host.style.pointerEvents = 'none';
      host.style.zIndex = '4500';
      (document.getElementById('gameCard') || document.body).appendChild(host);
    }
    host.innerHTML = svg;
    host.style.left = (x - w/2) + 'px';
    host.style.top  = (y - h/2) + 'px';
    host.style.width  = w + 'px';
    host.style.height = h + 'px';
    return host;
  }
  function removeSVG(id){ const n=document.getElementById(id); if(n) n.remove(); }

  // -------------------- NIGHT OVERLAY --------------------
  let nightOn=false;
  function setNight(on){
    if(on===nightOn) return; nightOn=on;
    if(on){
      const id='m5-night-vignette';
      if(!document.getElementById(id)){
        const d=document.createElement('div'); d.id=id;
        Object.assign(d.style,{position:'absolute',inset:0,pointerEvents:'none',
          background:'radial-gradient(ellipse at 50% 45%, rgba(0,0,0,0.25) 0%, rgba(0,0,0,0.82) 70%)',
          mixBlendMode:'multiply', zIndex:5000});
        (document.getElementById('gameCard')||document.body).appendChild(d);
      }
      const id2='m5-night-blue';
      if(!document.getElementById(id2)){
        const d=document.createElement('div'); d.id=id2;
        Object.assign(d.style,{position:'absolute',inset:0,pointerEvents:'none',
          background:'rgba(30,60,120,0.16)', mixBlendMode:'screen', zIndex:5001});
        (document.getElementById('gameCard')||document.body).appendChild(d);
      }
    }else{
      ['m5-night-vignette','m5-night-blue'].forEach(id=>{ const n=document.getElementById(id); if(n) n.remove(); });
    }
  }

  // -------------------- state --------------------
  let jackPlaced=false, jackTile=null;
  let pumpkinsPlaced=false;
  const pumpkinIds=['m5_p1','m5_p2','m5_p3'];
  const pumpkinTiles=[];
  let mission5Active=false, mission5Start=0;
  const MISSION_MS=5*60*1000;

  let werewolfNext=0;
  const WEREWOLF_CD=30*1000;
  let lastMove={x:0,y:0};

  // -------------------- placement --------------------
  function placeJack(){
    if(jackPlaced) return;
    const hq=hqDoorGrid();
    jackTile={ tx: hq.gx+5, ty: hq.gy-4 };
    const p=tileCenter(jackTile.tx, jackTile.ty);
    addSVG('m5_jack', svgJackLantern(), p.x, p.y, TILE*3.0, TILE*3.0);
    if(!placeJack._lol){
      placeJack._lol=setInterval(()=>{ try{ IZZA.toast?.('HA HA HA'); }catch{} }, 2500);
    }
    jackPlaced=true;
  }
  function removeJack(){
    if(!jackPlaced) return;
    removeSVG('m5_jack'); jackPlaced=false;
    if(placeJack._lol){ clearInterval(placeJack._lol); placeJack._lol=null; }
  }
  function computePumpkinTiles(){
    pumpkinTiles.length=0;
    const hq=hqDoorGrid();
    const p1={ tx:hq.gx-15, ty:hq.gy+10 };
    const p2={ tx:p1.tx-20, ty:p1.ty+13 };
    const p3={ tx:hq.gx+8,  ty:hq.gy-13 };
    pumpkinTiles.push(p1,p2,p3);
  }
  function placePumpkins(){
    if(pumpkinsPlaced) return;
    computePumpkinTiles();
    for(let i=0;i<3;i++){
      const t=pumpkinTiles[i], p=tileCenter(t.tx,t.ty);
      addSVG(pumpkinIds[i], svgPumpkinSmall(), p.x, p.y, TILE*1.6, TILE*1.6);
    }
    pumpkinsPlaced=true;
  }
  function removePumpkins(){
    if(!pumpkinsPlaced) return;
    pumpkinIds.forEach(id=>removeSVG(id));
    pumpkinsPlaced=false;
  }

  // -------------------- player motion & werewolves --------------------
  function playerPos(){ return { x:api.player?.x||0, y:api.player?.y||0 }; }
  function playerMoved(){
    const p=playerPos(); const dx=p.x-lastMove.x, dy=p.y-lastMove.y; lastMove=p; return (Math.hypot(dx,dy) > TILE*0.35);
  }
  function spawnWerewolf(){
    const p=playerPos();
    const id=`m5_w_${Date.now()%1e7}`; addSVG(id, svgWerewolf(), p.x, p.y, TILE*2.0, TILE*2.0);
    const born=performance.now();
    (function loop(){
      const now=performance.now();
      if(!nightOn || now-born>30000){ removeSVG(id); return; }
      requestAnimationFrame(loop);
    })();
  }
  function tickWerewolves(now){
    if(!mission5Active || !nightOn) return;
    if(now>=werewolfNext){
      if(playerMoved()) spawnWerewolf();
      werewolfNext=now+WEREWOLF_CD;
    }
  }

  // -------------------- interactions (B) — mirror Mission 4 style --------------------
  function playerOnTile(tx,ty){
    const t=TILE; const gx=((api.player.x+16)/t|0), gy=((api.player.y+16)/t|0);
    return (gx===tx && gy===ty);
  }
  function onPressB(e){
    if(!api?.ready) return;

    // Interact with Jack (only if placed)
    if(jackPlaced && playerOnTile(jackTile.tx, jackTile.ty)){
      e?.preventDefault?.(); e?.stopImmediatePropagation?.(); e?.stopPropagation?.();
      showNightIntro();
      return;
    }

    // Pick pumpkins
    if(pumpkinsPlaced){
      for(let i=0;i<3;i++){
        const t=pumpkinTiles[i];
        if(playerOnTile(t.tx,t.ty)){
          e?.preventDefault?.(); e?.stopImmediatePropagation?.(); e?.stopPropagation?.();
          const inv=readInv(); addCount(inv, 'pumpkin_piece', 1); writeInv(inv);
          IZZA.toast?.('+1 Pumpkin');
          removeSVG(pumpkinIds[i]);
          // move off-map so we don't re-collect
          pumpkinTiles[i]={tx:999999,ty:999999};
          break;
        }
      }
    }
  }

  // Hook like Mission 4 did (capture:true so others don't steal it) 
  function armBHooks(){
    const btn=document.getElementById('btnB');
    if(btn && !btn._m5wired){ btn.addEventListener('click', onPressB, true); btn._m5wired=true; }
    if(!onPressB._keywired){
      window.addEventListener('keydown', e=>{ if((e.key||'').toLowerCase()==='b') onPressB(e); }, true);
      onPressB._keywired=true;
    }
  }

  // -------------------- Night intro / accept --------------------
  function showNightIntro(){
    const title='WELCOME TO IZZA CITY AT NIGHT';
    const body="Avoid the riff raft at night around these parts. Collect all 3 pumpkins within 5 minutes and bring them to the armoury to craft Pumpkin Armour!";
    const take=()=> acceptNightMission();
    // If your UI has choice modal, use it; else confirm()
    if (api && api.UI && typeof api.UI.choice === 'function'){
      api.UI.choice({
        title, body, spooky:true,
        options:[{id:'take',label:'Take Jack-o’-Lantern'},{id:'leave',label:'Leave it'}],
        onChoose:(id)=>{ if(id==='take') take(); }
      });
    } else {
      if (window.confirm(`${title}\n\n${body}\n\nStart Mission 5?`)) take();
    }
  }
  function acceptNightMission(){
    const inv=readInv(); addCount(inv,'jack_o_lantern',1); writeInv(inv);
    try{ IZZA.emit('celebrate',{style:'spray-skull'}); }catch{}
    setNight(true);
    mission5Active=true; mission5Start=performance.now();
    removeJack(); placePumpkins();
    werewolfNext=mission5Start+600;
    IZZA.toast?.('Mission 5: Collect 3 pumpkins and craft Pumpkin Armour!');
  }

  // -------------------- Pumpkin Armour crafting gate --------------------
  function canCraftPumpkin(){
    const inv=readInv();
    return (inv.jack_o_lantern?.count|0)>=1 && (inv.pumpkin_piece?.count|0)>=3;
  }
  function tryCraftPumpkin(){
    if(!mission5Active) return false;
    // We allow crafting when Armoury UI is open and the player presses A (like your pattern)
    if(!canCraftPumpkin()) return false;

    const inv=readInv();
    addCount(inv,'jack_o_lantern',-1);
    addCount(inv,'pumpkin_piece',-3);
    addCount(inv,'armor_pumpkin_helm',1);
    addCount(inv,'armor_pumpkin_vest',1);
    addCount(inv,'armor_pumpkin_arms',1);
    addCount(inv,'armor_pumpkin_legs',1);
    writeInv(inv);

    // Popup with SVG icon
    const hostHasSVGPopup = (api && api.UI && typeof api.UI.popupSVG==='function');
    if(hostHasSVGPopup){
      api.UI.popupSVG({ title:'Pumpkin Armour Crafted!', svg: svgPumpkinArmorIcon(), timeout:2200 });
    }else{
      showAgentPopup('Pumpkin Armour Crafted!','Set bonus: 20% damage reduction. Legs move fast!', 2300);
    }

    // Complete mission 5
    mission5Active=false; setNight(false); removePumpkins();
    // bump missions to 5
    setMissionCount(5);
    showAgentPopup('Mission Completed', 'You’ve completed mission 5.', 2000);

    return true;
  }

  // Wire A button for crafting while in Armoury (DOM gate lives in expander).
  function onPressA(e){
    if(!api?.ready) return;
    // Only allow if Armoury UI is visible (expander shows #armouryUI)   [oai_citation:4‡v2_map_expander.js](file-service://file-XR6ySZ9Ca6A6g65i4PptiF)
    const ui=document.getElementById('armouryUI');
    const open = !!ui && window.getComputedStyle(ui).display!=='none';
    if(!open) return;
    if(tryCraftPumpkin()){
      e?.preventDefault?.(); e?.stopImmediatePropagation?.(); e?.stopPropagation?.();
    }
  }
  function armAHooks(){
    const btn=document.getElementById('btnA');
    if(btn && !btn._m5wired){ btn.addEventListener('click', onPressA, true); btn._m5wired=true; }
    if(!onPressA._keywired){
      window.addEventListener('keydown', e=>{ if((e.key||'').toLowerCase()==='a') onPressA(e); }, true);
      onPressA._keywired=true;
    }
  }

  // -------------------- Mission 4 completion detector --------------------
  let m4PendingPopup=false;   // we crafted but UI may still be open
  let m4ShownOnce=false;

  // When the user clicks the Cardboard craft button inside Armoury, the expander:
  //  - consumes 1 box, adds 4 items, writes inv, toasts — but emits no bus event.  [oai_citation:5‡v2_map_expander.js](file-service://file-XR6ySZ9Ca6A6g65i4PptiF)
  // We hook that button click, then after the frame, verify inventory contains the 4 pieces,
  // bump missions to 4, and show the popup (over Armoury or on close).
  function armM4Detector(){
    // delegate to document so we survive UI rebuilds
    if(armM4Detector._wired) return; armM4Detector._wired=true;
    document.addEventListener('click', function(ev){
      const btn = ev.target && ev.target.closest('#btnCraftCardboard');
      if(!btn) return;
      // defer to after expander mutates inventory
      setTimeout(()=>{
        const inv=readInv();
        const ok=(inv.cardboardHelmet?.count|0)>0 && (inv.cardboardVest?.count|0)>0 &&
                 (inv.cardboardLegs?.count|0)>0   && (inv.cardboardArms?.count|0)>0;
        if(!ok) return;

        // bump to 4 if needed
        if(getMissionCount() < 4) setMissionCount(4);

        // show popup now if Armoury UI is open; else queue it for after close
        const ui=document.getElementById('armouryUI');
        const open = !!ui && window.getComputedStyle(ui).display!=='none';
        const pop = ()=>{ if(!m4ShownOnce){ showAgentPopup('Mission Completed','You’ve completed mission 4.', 2000); m4ShownOnce=true; } };

        if(open){ pop(); } else { m4PendingPopup=true; }
        // place the Jack right away so the player sees it once outside
        placeJack();
      }, 0);
    }, true);

    // If the player closes Armoury and we queued the popup, show it now.  [oai_citation:6‡v2_map_expander.js](file-service://file-XR6ySZ9Ca6A6g65i4PptiF)
    const mo = new MutationObserver(()=>{
      const ui=document.getElementById('armouryUI'); if(!ui) return;
      const open = window.getComputedStyle(ui).display!=='none';
      if(!open && m4PendingPopup && !m4ShownOnce){
        m4PendingPopup=false; m4ShownOnce=true;
        showAgentPopup('Mission Completed','You’ve completed mission 4.', 2000);
      }
    });
    mo.observe(document.body, { attributes:true, subtree:true, attributeFilter:['style'] });
  }

  // -------------------- update loop hook --------------------
  IZZA.on('render-post', ({ now })=>{
    if(!api?.ready) return;
    tickWerewolves(now);
    // mission 5 timer fail
    if(mission5Active && (now - mission5Start) > MISSION_MS){
      mission5Active=false; setNight(false); removePumpkins();
      IZZA.toast?.('Mission 5 failed — time expired.');
      setTimeout(placeJack, 800);
    }
  });

  // -------------------- boot / resume --------------------
  IZZA.on('ready', (a)=>{
    api = a || {};
    TILE = api.TILE || TILE;
    armBHooks();
    armAHooks();
    armM4Detector();

    // If the player already has 4+ missions completed, ensure Jack is visible for the pickup
    if(getMissionCount()>=4) placeJack();
  });

  // Safety: if HTML loads this plugin before buttons, retry wiring
  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', ()=>{ armBHooks(); armAHooks(); }, {once:true});
  } else {
    armBHooks(); armAHooks();
  }

  // Clean shutdown
  IZZA.on('shutdown', ()=>{
    removeJack(); removePumpkins(); setNight(false);
  });
})();
