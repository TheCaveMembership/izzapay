/* mission5_halloween.plugin.js
   IZZA Mission 5 — “Night of the Lantern”
   Integrates with: izza_core_v3.js + v2_map_expander.js

   Highlights:
   - Auto-detects Mission 4 complete (Cardboard set = 4 pieces) by watching inventory changes,
     sets missions to 4 once, shows agent-style popup, then places the lantern.
   - Uses core v3 inputs: capture key B / btnB (like Mission 4).
   - All world props (lantern, pumpkins, werewolves) are SVGs that re-position each frame vs camera.
   - Pumpkin Armour is a 4-piece set; craft by pressing A while the Armoury modal is open.

   How to extend later:
   - Add next missions by cloning ArmourRecipes and reusing the same entry points.
*/
(function(){
  if (!window.IZZA || typeof IZZA.on !== 'function') return;

  // -------------------- Core handles --------------------
  let api=null;
  let TILE=60;       // world tile (from core)
  let DRAW=60;       // screen px per tile (from core)
  let camera={x:0,y:0};
  const NS='mission5-halloween';

  // -------------------- Armour recipe registry (reusable) --------------------
  // Each future mission: add a new key with needs/grants.
  const ArmourRecipes = {
    pumpkin: {
      // inventory keys from your expander’s patterns (simple count-based entries)
      needs: { jack_o_lantern:1, pumpkin_piece:3 },
      grants: [
        { id:'pumpkinHelmet', label:'Pumpkin Helmet', slot:'head',  dr:0.05 },
        { id:'pumpkinVest',   label:'Pumpkin Vest',   slot:'chest', dr:0.08 },
        { id:'pumpkinArms',   label:'Pumpkin Arms',   slot:'arms',  dr:0.02 },
        { id:'pumpkinLegs',   label:'Pumpkin Legs',   slot:'legs',  dr:0.05, speed:0.28 } // near-car speed feel
      ],
      totalDR: 0.20,
      craftedToast: 'Crafted Pumpkin Set: Helmet, Vest, Legs, Arms'
    }
  };

  // -------------------- Local storage keys & helpers --------------------
  const LS = {
    missions: 'izzaMissions',
    inv:      'izzaInventory',
    m4done:   'izzaMission4_done',
  };
  function getMissions(){ return parseInt(localStorage.getItem(LS.missions)||'0',10) || 0; }
  function setMissions(n){ localStorage.setItem(LS.missions, String(Math.max(n, getMissions()))); }
  function readInv(){ try{ return JSON.parse(localStorage.getItem(LS.inv)||'{}') || {}; }catch{ return {}; } }
  function writeInv(v){
    localStorage.setItem(LS.inv, JSON.stringify(v||{}));
    try{ window.dispatchEvent(new Event('izza-inventory-changed')); }catch{}
  }
  function ensureItem(inv, id, label){
    if (!inv[id]) inv[id] = { count:0, label: label||id };
  }
  function addCount(inv, id, n, label){
    ensureItem(inv,id,label); inv[id].count = (inv[id].count|0) + n; if (inv[id].count<=0) delete inv[id];
  }
  function hasCount(inv, id, n){ return (inv[id]?.count|0) >= n; }

  // -------------------- Camera mapping (world->screen) --------------------
  function worldToScreen(wx, wy){
    // Same pattern you used in Mission 4 fireworks
    const sx = (wx - camera.x) * (DRAW / TILE);
    const sy = (wy - camera.y) * (DRAW / TILE);
    return { sx, sy };
  }

  // -------------------- Minimal agent popup --------------------
  function agentPopup(title, body){
    const el=document.createElement('div');
    el.style.cssText='position:absolute;left:50%;top:18%;transform:translateX(-50%);'+
      'background:rgba(10,12,20,0.92);color:#b6ffec;padding:14px 18px;border:2px solid #36f;'+
      'border-radius:8px;font-family:monospace;z-index:9999';
    el.innerHTML = `<strong>${title}</strong><div>${body}</div>`;
    (document.getElementById('gameCard')||document.body).appendChild(el);
    setTimeout(()=>el.remove(), 2000);
  }

  // -------------------- SVG assets --------------------
  function svgJackLantern(){ return `
<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
 <defs>
   <radialGradient id="g" cx="50%" cy="50%" r="60%">
     <stop offset="0%" stop-color="#ffb347"/><stop offset="60%" stop-color="#ff7b00"/><stop offset="100%" stop-color="#792900"/>
   </radialGradient>
   <linearGradient id="stem" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#3b7a2a"/><stop offset="100%" stop-color="#1f4419"/></linearGradient>
   <filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
 </defs>
 <ellipse cx="100" cy="110" rx="78" ry="70" fill="url(#g)" stroke="#552200" stroke-width="6"/>
 <rect x="92" y="30" width="16" height="28" rx="6" fill="url(#stem)"/>
 <polygon points="60,90 85,110 35,110" fill="#ffd23f" filter="url(#glow)"/>
 <polygon points="140,90 165,110 115,110" fill="#ffd23f" filter="url(#glow)"/>
 <path d="M45 140 Q100 175 155 140 Q140 150 100 155 Q60 150 45 140 Z" fill="#ffd23f" filter="url(#glow)"/>
 <g id="haha" opacity="0.95"><text x="100" y="80" text-anchor="middle" font-size="22" fill="#ffd23f" style="font-family:'Joker',monospace;">HA HA HA</text></g>
 <animate xlink:href="#haha" attributeName="transform" type="translate" from="0,0" to="0,-40" dur="2.4s" repeatCount="indefinite"/>
</svg>`;}
  function svgPumpkinSmall(){ return `
<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg">
 <defs><radialGradient id="gp" cx="50%" cy="50%" r="60%"><stop offset="0%" stop-color="#ffb347"/><stop offset="60%" stop-color="#ff7b00"/><stop offset="100%" stop-color="#7a2f00"/></radialGradient></defs>
 <ellipse cx="40" cy="44" rx="28" ry="24" fill="url(#gp)" stroke="#552200" stroke-width="4"/>
 <rect x="35" y="18" width="8" height="10" rx="3" fill="#2c5e22"/>
</svg>`;}
  function svgWerewolf(){ return `
<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg">
 <defs><linearGradient id="fur" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#4c4c4c"/><stop offset="100%" stop-color="#1f1f1f"/></linearGradient></defs>
 <circle cx="60" cy="60" r="40" fill="url(#fur)"/>
 <polygon points="30,30 45,20 38,42" fill="#2a2a2a"/><polygon points="90,30 75,20 82,42" fill="#2a2a2a"/>
 <circle cx="45" cy="60" r="6" fill="#ffd23f"/><circle cx="75" cy="60" r="6" fill="#ffd23f"/>
 <path d="M38 82 Q60 70 82 82" stroke="#ffd23f" stroke-width="4" fill="none"/>
</svg>`;}
  function svgPumpkinArmorIcon(){ return `
<svg viewBox="0 0 200 160" xmlns="http://www.w3.org/2000/svg">
 <rect x="15" y="20" width="170" height="120" rx="10" fill="#1a1329" stroke="#6c3cff" stroke-width="4"/>
 <g transform="translate(22,12) scale(0.85)">
  <path d="M30 90 L60 40 L140 40 L170 90 L140 110 L60 110 Z" fill="#ff7b00" stroke="#3b1b00" stroke-width="6"/>
  <circle cx="70" cy="78" r="10" fill="#b97fff"/><circle cx="130" cy="78" r="10" fill="#b97fff"/>
  <rect x="92" y="84" width="16" height="6" rx="3" fill="#b97fff"/>
  <polygon points="30,88 12,76 30,70" fill="#b97fff"/><polygon points="170,88 188,76 170,70" fill="#b97fff"/>
  <polygon points="98,28 102,10 106,28" fill="#b97fff"/>
 </g>
</svg>`;}

  // -------------------- Overlay world-sprite helper --------------------
  // We keep DOM nodes and re-position them in render-under each frame.
  const sprites = new Map(); // id -> {node, wx, wy, w, h, svg}
  function ensureSprite(id, svg, wx, wy, w, h){
    let s = sprites.get(id);
    if (!s){
      const host=document.createElement('div');
      host.id=id;
      Object.assign(host.style,{
        position:'absolute', pointerEvents:'none', zIndex: '5500',
        width: w+'px', height: h+'px'
      });
      (document.getElementById('gameCard')||document.body).appendChild(host);
      host.innerHTML = svg;
      s = { node:host, wx, wy, w, h, svg };
      sprites.set(id, s);
    } else {
      s.wx=wx; s.wy=wy; s.w=w; s.h=h;
      if (s.svg!==svg){ s.node.innerHTML = svg; s.svg = svg; }
      s.node.style.width=w+'px'; s.node.style.height=h+'px';
    }
    // position now
    const {sx,sy}=worldToScreen(wx,wy);
    s.node.style.left = (sx - w/2) + 'px';
    s.node.style.top  = (sy - h/2) + 'px';
    return s;
  }
  function removeSprite(id){
    const s=sprites.get(id); if(!s) return;
    s.node.remove(); sprites.delete(id);
  }
  IZZA.on('render-under', ()=>{
    // update positions as camera moves
    sprites.forEach(s=>{
      const {sx,sy}=worldToScreen(s.wx, s.wy);
      s.node.style.left = (sx - s.w/2) + 'px';
      s.node.style.top  = (sy - s.h/2) + 'px';
    });
  });

  // -------------------- Night overlay --------------------
  let nightOn=false;
  function setNight(on){
    if (on===nightOn) return; nightOn=on;
    if (on){
      addOverlay('m5-night','radial-gradient(ellipse at 50% 45%, rgba(0,0,0,0.25) 0%, rgba(0,0,0,0.8) 70%)',5000,false);
      addOverlay('m5-night-blue','rgba(30,60,120,0.15)',5001,true);
    }else{
      ['m5-night','m5-night-blue'].forEach(id=>document.getElementById(id)?.remove());
    }
  }
  function addOverlay(id, bg, z, isFlat){
    let d=document.getElementById(id);
    if(!d){ d=document.createElement('div'); d.id=id; (document.getElementById('gameCard')||document.body).appendChild(d); }
    Object.assign(d.style,{ position:'absolute', inset:0, pointerEvents:'none', zIndex:String(z) });
    d.style.background = bg; d.style.mixBlendMode = isFlat ? 'screen' : 'multiply';
  }

  // -------------------- Mission state --------------------
  let jackPlaced=false, jackId='m5_jack', jackTile=null;
  let pumpkinsPlaced=false;
  const pumpkinIds=['m5_p1','m5_p2','m5_p3'];
  const pumpkinTiles=[];
  let mission5Active=false, mission5Start=0;
  const MISSION_MS=5*60*1000;

  let werewolfNext=0;           // timestamp ms
  const WEREWOLF_COOLDOWN=30*1000;
  let lastMove={x:0,y:0};

  function playerPos(){ return api?.player ? {x:api.player.x,y:api.player.y} : {x:0,y:0}; }
  function playerMoving(){
    const p=playerPos(); const dx=Math.abs(p.x-lastMove.x), dy=Math.abs(p.y-lastMove.y);
    lastMove=p; return (dx+dy) > (TILE*0.35);
  }

  // -------------------- Jack placement & pumpkins --------------------
  function getHQDoorTile(){
    // core exposes doorSpawn in world px
    if (api?.doorSpawn){ return { tx: Math.round(api.doorSpawn.x/TILE), ty: Math.round(api.doorSpawn.y/TILE) }; }
    return { tx:100, ty:100 };
  }
  function tileCenter(tx,ty){ return { x:(tx+0.5)*TILE, y:(ty+0.5)*TILE }; }

  function placeJack(){
    if(jackPlaced) return;
    const hq=getHQDoorTile();
    jackTile = { tx: hq.tx + 5, ty: hq.ty - 4 };
    const p = tileCenter(jackTile.tx, jackTile.ty);
    ensureSprite(jackId, svgJackLantern(), p.x, p.y, TILE*3.0, TILE*3.0);
    jackPlaced = true;

    // audio ping hook (optional)
    if(!placeJack._lol){
      placeJack._lol = setInterval(()=>{ try{ IZZA.emit('sfx',{kind:'jack-HA',vol:0.6}); }catch{} }, 2500);
    }
  }
  function removeJack(){ if(!jackPlaced) return; removeSprite(jackId); jackPlaced=false; if(placeJack._lol){ clearInterval(placeJack._lol); placeJack._lol=null; } }

  function computePumpkinTiles(){
    pumpkinTiles.length=0;
    const hq=getHQDoorTile();
    const p1={ tx: hq.tx - 15, ty: hq.ty + 10 };
    const p2={ tx: p1.tx - 20, ty: p1.ty + 13 };
    const p3={ tx: hq.tx + 8,  ty: hq.ty - 13 };
    pumpkinTiles.push(p1,p2,p3);
  }
  function placePumpkins(){
    if (pumpkinsPlaced) return;
    computePumpkinTiles();
    for (let i=0;i<3;i++){
      const t=pumpkinTiles[i]; const p=tileCenter(t.tx,t.ty);
      ensureSprite(pumpkinIds[i], svgPumpkinSmall(), p.x, p.y, TILE*1.6, TILE*1.6);
    }
    pumpkinsPlaced=true;
  }
  function removePumpkins(){ if(!pumpkinsPlaced) return; pumpkinIds.forEach(removeSprite); pumpkinsPlaced=false; }

  // -------------------- Werewolves --------------------
  function spawnWerewolf(){
    const where=playerPos();
    const id=`m5_w_${Date.now()%1e7}`;
    ensureSprite(id, svgWerewolf(), where.x, where.y, TILE*2.0, TILE*2.0);
    // simple despawn in ~30s; no AI pathing hooks in core, so keep spooky pressure
    setTimeout(()=>removeSprite(id), 30000);
    try{ IZZA.emit('sfx',{kind:'werewolf-spawn',vol:0.8}); }catch{}
  }
  IZZA.on('update-post', ({now})=>{
    // keep camera handles fresh for transforms
    if (api){ camera = api.camera||camera; DRAW = api.DRAW||DRAW; TILE = api.TILE||TILE; }

    if (!mission5Active || !nightOn) return;
    if (now >= werewolfNext){
      if (playerMoving()) spawnWerewolf();
      werewolfNext = now + WEREWOLF_COOLDOWN;
    }
    // mission timer
    if ((now - mission5Start) > MISSION_MS){
      mission5Active=false; setNight(false); removePumpkins();
      try{ IZZA.toast?.('Mission 5 failed — time expired.'); }catch{}
      setTimeout(placeJack, 800);
    }
  });

  // -------------------- Interaction (Mission 4 style B-capture) --------------------
  function onB(e){
    // Jack interaction
    if (jackPlaced && jackTile){
      const p=playerPos(); const jack=tileCenter(jackTile.tx, jackTile.ty);
      const near = Math.hypot(p.x-jack.x, p.y-jack.y) <= TILE*1.1;
      if (near){
        e?.preventDefault?.(); e?.stopImmediatePropagation?.(); e?.stopPropagation?.();
        showNightIntro();
        return;
      }
    }
    // Pumpkin collect
    if (pumpkinsPlaced){
      const p=playerPos();
      for (let i=0;i<3;i++){
        const id=pumpkinIds[i]; const t=pumpkinTiles[i]; if (!t) continue;
        const c=tileCenter(t.tx, t.ty);
        const near = Math.hypot(p.x-c.x, p.y-c.y) <= TILE*1.1;
        if (near){
          e?.preventDefault?.(); e?.stopImmediatePropagation?.(); e?.stopPropagation?.();
          // collect
          const inv=readInv(); addCount(inv,'pumpkin_piece',1,'Pumpkin Piece'); writeInv(inv);
          try{ IZZA.toast?.('+1 Pumpkin'); }catch{}
          removeSprite(id);
          // move far away to avoid re-collect
          pumpkinTiles[i] = null;
          break;
        }
      }
    }
    // else: let core handle door/shop etc.
  }
  // Capture listeners (like Mission 4)
  document.getElementById('btnB')?.addEventListener('click', onB, true);
  window.addEventListener('keydown', e=>{ if((e.key||'').toLowerCase()==='b') onB(e); }, true);

  // -------------------- Spooky modal --------------------
  function showNightIntro(){
    // simple 2-button modal (Mission 4 confirm style)
    const wrap=document.createElement('div');
    wrap.style.cssText='position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);z-index:10000;';
    const card=document.createElement('div');
    card.style.cssText='min-width:320px;max-width:560px;padding:18px;border-radius:14px;border:2px solid #6a4c1e;'+
      'box-shadow:0 16px 44px rgba(0,0,0,.6), inset 0 0 40px rgba(255,215,64,.15);background:#0b0f1a;color:#cfe3ff;';
    card.innerHTML = `
      <div style="font-size:22px;font-weight:900;letter-spacing:1px;margin-bottom:8px;color:#ffd23f;transform:skewX(-2deg)">WELCOME TO IZZA CITY AT NIGHT</div>
      <div style="opacity:.92;margin-bottom:14px">Avoid the riff raft at night around these parts. Collect all 3 pumpkins within 5 minutes and bring them to the armoury to craft Pumpkin Armour!</div>
      <div style="display:flex;gap:10px;justify-content:flex-end">
        <button id="m5Leave" style="background:#263447;color:#cfe3ff;border:0;border-radius:8px;padding:8px 12px;font-weight:800;cursor:pointer">Leave it</button>
        <button id="m5Take"  style="background:#1f6feb;color:#fff;border:0;border-radius:10px;padding:10px 14px;font-weight:900;cursor:pointer">Take Jack-o’-Lantern</button>
      </div>`;
    wrap.appendChild(card); (document.getElementById('gameCard')||document.body).appendChild(wrap);

    document.getElementById('m5Leave').onclick = ()=> wrap.remove();
    document.getElementById('m5Take').onclick  = ()=>{
      // start mission 5
      const inv=readInv(); addCount(inv,'jack_o_lantern',1,'Jack-o’-Lantern'); writeInv(inv);
      try{ IZZA.emit('celebrate',{style:'spray-skull'}); }catch{}
      setNight(true);
      mission5Active=true; mission5Start=performance.now();
      removeJack(); placePumpkins();
      werewolfNext = mission5Start + 500;
      try{ IZZA.toast?.('Mission 5: Collect 3 pumpkins & craft Pumpkin Armour (press A in Armoury)'); }catch{}
      wrap.remove();
    };
  }

  // -------------------- Crafting (press A while Armoury UI is open) --------------------
  function armouryOpen(){ return document.getElementById('armouryUI')?.style.display === 'flex'; }
  function tryCraftPumpkin(){
    if (!mission5Active) return false;
    if (!armouryOpen())  return false;

    const inv=readInv();
    const need=ArmourRecipes.pumpkin.needs;
    if (!hasCount(inv,'jack_o_lantern',need.jack_o_lantern) || !hasCount(inv,'pumpkin_piece',need.pumpkin_piece)) return false;

    // consume
    addCount(inv,'jack_o_lantern',-1);
    addCount(inv,'pumpkin_piece',-3);

    // grant pieces
    ArmourRecipes.pumpkin.grants.forEach(g=>{
      addCount(inv, g.id, 1, g.label);
    });
    writeInv(inv);

    // Maintain your global armor DR store (same mechanism as expander uses)
    try{
      const dr = ArmourRecipes.pumpkin.totalDR;
      localStorage.setItem((function _armorKey(){
        const u = (window.__IZZA_PROFILE__?.username||'guest').toString().replace(/^@+/,'').toLowerCase();
        return 'izzaArmor_'+u;
      })(), JSON.stringify({ type:'Pumpkin', dr }));
      if (api?.player){ api.player.armorDR = dr; api.player.armorType = 'Pumpkin'; }
    }catch{}

    // celebration + popup
    try{ IZZA.toast?.(ArmourRecipes.pumpkin.craftedToast); }catch{}
    (function popup(){
      const el=document.createElement('div');
      el.style.cssText='position:absolute;left:50%;top:18%;transform:translateX(-50%);background:rgba(10,12,20,0.92);color:#b6ffec;padding:14px 18px;border:2px solid #36f;border-radius:8px;font-family:monospace;z-index:9999';
      el.innerHTML='<strong>Pumpkin Armour Crafted!</strong><div>20% damage reduction. Legs move fast!</div>';
      (document.getElementById('gameCard')||document.body).appendChild(el);
      setTimeout(()=>el.remove(),2200);
    })();

    // complete mission 5
    mission5Active=false; setNight(false); removePumpkins();
    setMissions(5); agentPopup('Mission Completed','You’ve completed mission 5.');
    return true;
  }

  function onA(e){
    if (armouryOpen()){
      const done = tryCraftPumpkin();
      if (done){ e?.preventDefault?.(); e?.stopImmediatePropagation?.(); e?.stopPropagation?.(); }
    }
    // otherwise let core A = attack
  }
  document.getElementById('btnA')?.addEventListener('click', onA, true);
  window.addEventListener('keydown', e=>{ if((e.key||'').toLowerCase()==='a') onA(e); }, true);

  // -------------------- Mission 4 detection (no Mission 4 edits required) --------------------
  // Your expander’s Armoury craft button adds: cardboardHelmet, cardboardVest, cardboardLegs, cardboardArms
  function hasCardboardSet(inv){
    return (inv.cardboardHelmet?.count|0)>0 && (inv.cardboardVest?.count|0)>0 &&
           (inv.cardboardLegs?.count|0)>0   && (inv.cardboardArms?.count|0)>0;
  }
  function tryCompleteMission4(){
    if (localStorage.getItem(LS.m4done)==='1') return;
    const inv=readInv();
    if (hasCardboardSet(inv)){
      localStorage.setItem(LS.m4done,'1');
      // bump missions from 3 → 4 (or ensure ≥4)
      setMissions(4);
      agentPopup('Mission Completed','You’ve completed mission 4.');
      // place lantern now
      placeJack();
    }
  }
  // Run this when Armoury crafting happens, and also on resume
  window.addEventListener('izza-inventory-changed', tryCompleteMission4);

  // -------------------- Boot & resume --------------------
  IZZA.on('ready', (a)=>{
    api=a||{}; TILE=api.TILE||TILE; DRAW=api.DRAW||DRAW; camera=api.camera||camera;
    // If the player already has ≥4 missions on resume, put the lantern down
    if (getMissions()>=4) placeJack();
  });

  IZZA.on('render-under', ()=>{ /* positions are updated each frame via sprites map */ });

  IZZA.on('shutdown', ()=>{
    removeJack(); removePumpkins(); setNight(false);
    sprites.forEach((_,id)=>removeSprite(id));
  });
})();
