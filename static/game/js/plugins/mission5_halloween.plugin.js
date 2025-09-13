/* mission5_halloween.plugin.js
   IZZA Mission 5 — “Night of the Lantern”
   - Robustly detects M4 completion by inventory (cardboard Helmet/Vest/Arms/Legs)
   - Bumps localStorage izzaMissions to 4 and shows agent popup (over/after armoury)
   - Places jack-o’-lantern at HQ door +5E, -4N (3× box size) with HA HA HA streamer
   - Interact with [B] to start a 5m night mission; pumpkins spawn at exact offsets
   - Werewolf spawns every 30s while moving at night; A to fight (hooks bus if present)
   - Craft Pumpkin Armour (4 pieces) from 1 jack-o’-lantern + 3 pumpkin pieces
   - Set bonus: 20% damage reduction; Legs grant fast run (near car speed)
   - All art authored as SVG then rasterized for canvas (keeps SVG source inline)
*/
(function(){
  if (!window.IZZA) window.IZZA = {};
  if (typeof IZZA.on !== 'function') IZZA.on = function(){};
  if (typeof IZZA.emit !== 'function') IZZA.emit = function(){};

  let api = null;
  let TILE = 60;
// --- Early hooks so M5 works even if 'ready' never fires immediately
try {
  IZZA.on('render-under', renderUnder);
  IZZA.on('update-post', onUpdatePost);
} catch {}

// When Mission 4 completes, place the jack right away (listen on both buses)
try { IZZA.on('mission-complete', p => { if ((p?.id|0) === 4) setTimeout(ensureJack, 0); }); } catch {}
window.addEventListener('mission-complete', e => {
  const id = (e?.detail?.id|0) || 0;
  if (id === 4) setTimeout(ensureJack, 0);
});

// If we load into a save that's already ≥4, ensure the jack exists
setTimeout(() => {
  const cur = parseInt(localStorage.getItem('izzaMissions') || '0', 10) || 0;
  if (cur >= 4) ensureJack();
}, 0);
  // ---------- Core helpers (align with izza_core_v3.js) ----------
  function _lsGet(k, d){ try{ const v = localStorage.getItem(k); return v==null? d : v; }catch{ return d; } }
  function _lsSet(k, v){ try{ localStorage.setItem(k, v); }catch{} }

  function _getInv(){
    try{
      if (IZZA?.api?.getInventory) return JSON.parse(JSON.stringify(IZZA.api.getInventory()||{}));
      const raw = localStorage.getItem('izzaInventory'); return raw? JSON.parse(raw) : {};
    }catch{ return {}; }
  }
  function _setInv(inv){
    try{
      if (IZZA?.api?.setInventory) IZZA.api.setInventory(inv);
      else localStorage.setItem('izzaInventory', JSON.stringify(inv||{}));
      try{ window.dispatchEvent(new Event('izza-inventory-changed')); }catch{}
    }catch{}
  }
  function _inc(inv, key, n=1){ inv[key] = inv[key]||{count:0}; inv[key].count=(inv[key].count|0)+n; return inv; }
  function _dec(inv, key, n=1){
    if(!inv[key]) return inv;
    inv[key].count = Math.max(0,(inv[key].count|0)-n);
    if((inv[key].count|0)<=0) delete inv[key];
    return inv;
  }

  function _missions(){ return parseInt(_lsGet('izzaMissions', '0'), 10) || 0; }
  function _setMissions(n){
    const cur=_missions();
    if(n>cur) _lsSet('izzaMissions', String(n));
    try{ window.dispatchEvent(new Event('izza-inventory-changed')); }catch{}
  }

  // ---------- HQ door tile (mirror mission4 approach) ----------
  function hqDoorTile(){
    try{
      if (api?.getHQDoorTile) { const t=api.getHQDoorTile(); if(t) return {tx:t.tx,ty:t.ty}; }
      if (api?.getHQDoor) { const p=api.getHQDoor(); if(p) return {tx:Math.round(p.x/TILE), ty:Math.round(p.y/TILE)}; }
    }catch{}
    const b=document.body;
    const tx=Number(b.getAttribute('data-hq-tx')), ty=Number(b.getAttribute('data-hq-ty'));
    if(Number.isFinite(tx)&&Number.isFinite(ty)) return {tx,ty};
    // last resort near player
    return { tx: ((api?.player?.x||0)/TILE|0), ty: ((api?.player?.y||0)/TILE|0) };
  }

  // ---------- world→screen (canvas) ----------
  function w2s(wx, wy){
    const S = api?.DRAW || TILE; // IZZA.api.DRAW is a px-per-tile scale
    const T = TILE;
    const sx = (wx - (api?.camera?.x||0)) * (S/T);
    const sy = (wy - (api?.camera?.y||0)) * (S/T);
    return { sx, sy };
  }
  function tileCenter(tx,ty){ return { x:(tx+0.5)*TILE, y:(ty+0.5)*TILE }; }

  // ---------- tiny agent popup ----------
  function agentPopup(title, body, t=2000){
    // use UI if present
    if (api?.UI?.popup) { api.UI.popup({ style:'agent', title, body, timeout:t }); return; }
    // fallback
    const el=document.createElement('div');
    el.style.cssText='position:absolute;left:50%;top:18%;transform:translateX(-50%);background:rgba(10,12,20,.92);color:#b6ffec;padding:14px 18px;border:2px solid #36f;border-radius:8px;font-family:monospace;z-index:9999';
    el.innerHTML=`<div style="font-weight:800">${title}</div><div>${body||''}</div>`;
    (document.getElementById('gameCard')||document.body).appendChild(el);
    setTimeout(()=>{ el.remove(); }, t);
  }

  // ---------- SVG → Image cache (so we can draw in render-under) ----------
  const _imgCache = new Map();
  function svgToImage(svg, pxW, pxH){
    const key=svg+'|'+pxW+'x'+pxH;
    if(_imgCache.has(key)) return _imgCache.get(key);
    const url='data:image/svg+xml;utf8,'+encodeURIComponent(svg);
    const img=new Image(); img.width=pxW; img.height=pxH; img.src=url;
    _imgCache.set(key, img);
    return img;
  }

  // ---------- Art (SVG) ----------
  function svgJack(){
    return `
<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
 <defs>
   <radialGradient id="g" cx="50%" cy="50%" r="60%">
     <stop offset="0%"   stop-color="#ffb347"/>
     <stop offset="60%"  stop-color="#ff7b00"/>
     <stop offset="100%" stop-color="#792900"/>
   </radialGradient>
   <linearGradient id="stem" x1="0" y1="0" x2="0" y2="1">
     <stop offset="0%" stop-color="#3b7a2a"/><stop offset="100%" stop-color="#1f4419"/>
   </linearGradient>
   <filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  </defs>
  <ellipse cx="100" cy="110" rx="78" ry="70" fill="url(#g)" stroke="#552200" stroke-width="6"/>
  <rect x="92" y="30" width="16" height="28" rx="6" fill="url(#stem)"/>
  <polygon points="60,90 85,110 35,110" fill="#ffd23f" filter="url(#glow)"/>
  <polygon points="140,90 165,110 115,110" fill="#ffd23f" filter="url(#glow)"/>
  <path d="M45 140 Q100 175 155 140 Q140 150 100 155 Q60 150 45 140 Z" fill="#ffd23f" filter="url(#glow)"/>
  <g id="haha" opacity="0.95">
    <text x="100" y="80" text-anchor="middle" font-size="22" fill="#ffd23f" style="font-family:monospace">HA HA HA</text>
  </g>
  <animate xlink:href="#haha" attributeName="transform" type="translate" from="0,0" to="0,-40" dur="2.5s" repeatCount="indefinite"/>
  <animate xlink:href="#haha" attributeName="opacity" from="0.15" to="1" dur="0.25s" begin="0s" fill="freeze"/>
</svg>`;
  }
  function svgPumpkinSmall(){
    return `
<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg">
 <defs><radialGradient id="gp" cx="50%" cy="50%" r="60%"><stop offset="0%" stop-color="#ffb347"/><stop offset="60%" stop-color="#ff7b00"/><stop offset="100%" stop-color="#7a2f00"/></radialGradient></defs>
 <ellipse cx="40" cy="44" rx="28" ry="24" fill="url(#gp)" stroke="#552200" stroke-width="4"/>
 <rect x="35" y="18" width="8" height="10" rx="3" fill="#2c5e22"/>
</svg>`;
  }

  // ---------- Mission state ----------
  let jackTile=null, jackImg=null, jackPlaced=false;
  let pumpkins = []; // [{tx,ty, collected:false, img}]
  let mission5Active=false, mission5Start=0, M5_MS=5*60*1000;
  let nightOn=false, werewolfNext=0, lastPos=null;

  // ---------- Placement ----------
  function ensureJack(){
    if (jackPlaced) return;
    const hq=hqDoorTile();
    jackTile = { tx:hq.tx+8, ty:hq.ty-2 };
    jackImg  = svgToImage(svgJack(), TILE*3.0, TILE*3.0);
    jackPlaced=true;
    // soft SFX loop hook every 2.5s (optional)
    if(!ensureJack._t){ ensureJack._t=setInterval(()=>{ try{ IZZA.emit('sfx',{kind:'jack-HA',vol:0.6}); }catch{} }, 2500); }
  }
  function clearJack(){
    if(ensureJack._t){ clearInterval(ensureJack._t); ensureJack._t=null; }
    jackPlaced=false; jackTile=null; jackImg=null;
  }

  function computePumpkinTiles(){
    const hq=hqDoorTile();
    const p1={ tx:hq.tx-15, ty:hq.ty+10 };
    const p2={ tx:p1.tx-20, ty:p1.ty+13 };
    const p3={ tx:hq.tx+8,  ty:hq.ty-13 };
    return [p1,p2,p3];
  }
  function placePumpkins(){
    pumpkins.length=0;
    const tiles=computePumpkinTiles();
    for(const t of tiles){
      pumpkins.push({ tx:t.tx, ty:t.ty, collected:false, img: svgToImage(svgPumpkinSmall(), TILE*1.6, TILE*1.6) });
    }
  }
  function clearPumpkins(){ pumpkins.length=0; }

  // ---------- Night overlay ----------
  function setNight(on){
    if(on===nightOn) return;
    nightOn=on;
    const id='m5-night-overlay';
    let el=document.getElementById(id);
    if(on){
      if(!el){
        el=document.createElement('div');
        el.id=id;
        el.style.cssText='position:absolute;inset:0;pointer-events:none;background:radial-gradient(ellipse at 50% 45%, rgba(0,0,0,.25) 0%, rgba(0,0,0,.8) 70%);mix-blend-mode:multiply;z-index:5000';
        (document.getElementById('gameCard')||document.body).appendChild(el);
        const blue=document.createElement('div');
        blue.id=id+'-b';
        blue.style.cssText='position:absolute;inset:0;pointer-events:none;background:rgba(30,60,120,.15);mix-blend-mode:screen;z-index:5001';
        el.appendChild(blue);
      }
    }else{
      el?.remove();
    }
  }

  // ---------- Render (camera-relative) ----------
  function renderUnder(){
    try{
      if (!api?.ready) return;
// draw jack/pumpkins regardless of tier (jack sits by HQ which is visible in T1)
      const ctx=document.getElementById('game')?.getContext('2d'); if(!ctx) return;
      const S=api.DRAW, T=TILE;

      // jack
      if (jackPlaced && jackTile && jackImg && jackImg.complete){
        const c=tileCenter(jackTile.tx, jackTile.ty);
        const {sx,sy}=w2s(c.x, c.y);
        ctx.save();
        ctx.translate(sx, sy + S*0.1);
        ctx.drawImage(jackImg, - (T*3.0)*(S/T)/2, - (T*3.0)*(S/T)/2, (T*3.0)*(S/T), (T*3.0)*(S/T));
        ctx.restore();
      }
      // pumpkins
      if (pumpkins.length){
        for(const p of pumpkins){
          if(p.collected || !p.img || !p.img.complete) continue;
          const c=tileCenter(p.tx, p.ty);
          const {sx,sy}=w2s(c.x, c.y);
          ctx.save();
          ctx.translate(sx, sy + S*0.08);
          ctx.drawImage(p.img, - (T*1.6)*(S/T)/2, - (T*1.6)*(S/T)/2, (T*1.6)*(S/T), (T*1.6)*(S/T));
          ctx.restore();
        }
      }
    }catch{}
  }

  // ---------- Input (B) ----------
  function isNearTile(tx,ty, rPx){
    const p=tileCenter(tx,ty);
    const me={ x: (api?.player?.x||0)+16, y: (api?.player?.y||0)+16 };
    return Math.hypot(me.x-p.x, me.y-p.y) <= (rPx||TILE*0.9);
  }

  function onB(e){
    if(!api?.ready) return;

    // on jack → show intro
    if(jackPlaced && jackTile && isNearTile(jackTile.tx, jackTile.ty, TILE*0.9)){
      e?.preventDefault?.(); e?.stopImmediatePropagation?.(); e?.stopPropagation?.();
      showNightIntro();
      return;
    }

    // on pumpkin → collect
    for(const p of pumpkins){
      if(!p.collected && isNearTile(p.tx, p.ty, TILE*0.9)){
        p.collected=true;
        const inv=_getInv();
        _inc(inv, 'pumpkin_piece', 1); _setInv(inv);
        IZZA.toast?.('+1 Pumpkin');
        return;
      }
    }
  }

  // also hook direct DOM (your core doesn’t emit button-B)
  function wireB(){
    document.getElementById('btnB')?.addEventListener('click', onB, true);
    window.addEventListener('keydown', e=>{ if((e.key||'').toLowerCase()==='b') onB(e); }, true);
  }

  // ---------- Night intro ----------
  function showNightIntro(){
    const title='WELCOME TO IZZA CITY AT NIGHT';
    const body='Avoid the riff raft at night around these parts. Collect all 3 pumpkins within 5 minutes and bring them to the armoury to craft Pumpkin Armour!';
    const take=()=>acceptNightMission();
    // use your choice UI if present
    if (api?.UI?.choice){
      api.UI.choice({
        spooky:true, title, body,
        options:[{id:'take',label:'Take Jack-o’-Lantern'},{id:'leave',label:'Leave it'}],
        onChoose:(id)=>{ if(id==='take') take(); }
      });
    } else {
      if (confirm(title+'\n\n'+body+'\n\nStart mission 5?')) take();
    }
  }

  function acceptNightMission(){
    // add lantern to inv; start night & timer; spawn pumpkins; remove jack
    const inv=_getInv();
    _inc(inv,'jack_o_lantern',1); _setInv(inv);
    try{ IZZA.emit('celebrate',{style:'spray-skull'}); }catch{}
    setNight(true);
    mission5Active=true; mission5Start=performance.now(); werewolfNext=mission5Start+500;
    ensureJack(); // ensure exists before removing in case race
    clearJack();
    placePumpkins();
    IZZA.toast?.('Mission 5 started: collect 3 pumpkins and craft Pumpkin Armour!');
  }

  // ---------- Werewolf (simple hook points) ----------
  function isMoving(){
    const p={x:api?.player?.x||0, y:api?.player?.y||0};
    if(!lastPos){ lastPos=p; return false; }
    const d=Math.hypot(p.x-lastPos.x,p.y-lastPos.y); lastPos=p; return d>(TILE*0.35);
  }
  function spawnWerewolf(){
    // if you have an NPC system, emit an event; otherwise just damage pulses
    try{ IZZA.emit('npc-spawn',{kind:'werewolf', host:'mission5'}); }catch{}
    // Optional: tiny screen shake / sfx
    try{ IZZA.emit('sfx',{kind:'werewolf-spawn',vol:0.9}); }catch{}
  }

  // ---------- Crafting: Pumpkin Armour ----------
  function playerInArmoury(){
    if(api?.inZone) return api.inZone('armoury')===true;
    // fallback: near door tile
    const d = window.__IZZA_ARMOURY__?.door;
    if(!d) return false;
    const me={x:(api?.player?.x||0)/TILE|0, y:(api?.player?.y||0)/TILE|0};
    return (Math.abs(me.x-d.x)+Math.abs(me.y-d.y))<=1;
  }

  function tryCraftPumpkin(){
    if(!mission5Active) return false;
    if(!playerInArmoury()) return false;
    const inv=_getInv();
    const haveJack = !!(inv.jack_o_lantern && (inv.jack_o_lantern.count|0)>0);
    const pumpkinsC = (inv.pumpkin_piece && (inv.pumpkin_piece.count|0)) || 0;
    if(!haveJack || pumpkinsC<3) return false;

    _dec(inv,'jack_o_lantern',1);
    _dec(inv,'pumpkin_piece',3);

    // create 4 pieces (matching your “4 pieces per set” rule)
    _inc(inv,'pumpkinHelmet',1);
    _inc(inv,'pumpkinVest',1);
    _inc(inv,'pumpkinArms',1);
    _inc(inv,'pumpkinLegs',1);
    // mark legs as speedy & set bonus meta (stored alongside if your core uses it)
    inv.pumpkinLegs.meta = { speed: 0.28 };
    inv._pumpkinSetMeta   = { setDR: 0.20 };

    _setInv(inv);
    IZZA.toast?.('Crafted Pumpkin Armour (4 pcs) — set bonus active');

    // complete mission 5
    mission5Active=false; setNight(false); clearPumpkins();
    _setMissions(5);
    agentPopup('Mission Completed', 'You’ve completed mission 5.');
    try{ IZZA.emit('mission-complete',{id:5,name:'Night of the Lantern'}); }catch{}

    return true;
  }

  // ---------- Detect Mission 4 (inventory-based) & place jack ----------
  function hasCardboardSet(inv){
    return (inv.cardboardHelmet?.count|0)>0 &&
           (inv.cardboardVest?.count|0)>0 &&
           (inv.cardboardArms?.count|0)>0 &&
           (inv.cardboardLegs?.count|0)>0;
  }

  function maybeFinishM4AndPlaceJack(){
    const inv=_getInv();
    if (_missions() >= 4){
      // already at/over 4 → ensure jack exists so player can start M5
      ensureJack();
      return;
    }
    if (!hasCardboardSet(inv)) return;

    // We want the “Mission 4 complete” popup to appear either:
    // - over the armoury UI *after* crafting, or
    // - right away if armoury UI is not open.
    const ui=document.getElementById('armouryUI');
    const doPopupAndBump=()=>{
      _setMissions(4);
      agentPopup('Mission Completed', 'You’ve completed mission 4.');
      try{ IZZA.emit('mission-complete',{id:4,name:'Armoury: Cardboard'}); }catch{}
      ensureJack();
    };

    if (ui && window.getComputedStyle(ui).display!=='none'){
      // defer until the player closes the armoury
      const once=()=>{ ui.removeEventListener('click', onClose, true); window.removeEventListener('keydown', onEsc, true); doPopupAndBump(); };
      const onClose=(e)=>{ const btn=e.target && e.target.closest('#armouryClose'); if(btn){ e.preventDefault(); setTimeout(once, 0); } };
      const onEsc=(e)=>{ if((e.key||'').toLowerCase()==='escape'){ setTimeout(once, 0); } };
      ui.addEventListener('click', onClose, true);
      window.addEventListener('keydown', onEsc, true);
    } else {
      doPopupAndBump();
    }
  }

  // Also: if user clicks the Craft button again later, we’ll still catch it
  function wireArmouryCraftButtonWatcher(){
    const mo = new MutationObserver(()=>{
      const btn = document.getElementById('btnCraftCardboard');
      if(!btn || btn._m5_wired) return;
      btn._m5_wired=true;
      btn.addEventListener('click', ()=> setTimeout(maybeFinishM4AndPlaceJack, 0), true);
    });
    mo.observe(document.body, { childList:true, subtree:true });
    // and run once in case it already exists
    setTimeout(maybeFinishM4AndPlaceJack, 300);
  }

  // ---------- Update tick ----------
  function onUpdatePost({ now }){
    // draw handled by render-under
    if (mission5Active){
      // timer expire
      if ((now - mission5Start) > M5_MS){
        mission5Active=false; setNight(false); clearPumpkins();
        IZZA.toast?.('Mission 5 failed — time expired.');
        // re-offer jack to retry
        setTimeout(ensureJack, 800);
      }
      // werewolf every 30s if moving
      if (now >= werewolfNext){
        if (isMoving()) spawnWerewolf();
        werewolfNext = now + 30000;
      }
      // opportunistic craft check while you’re in the armoury
      tryCraftPumpkin();
    }
  }

  // ---------- “extensible crafting” template for future sets ----------
  // You can call this from a future mission file:
  // registerCraftableSet({
  //   setKey: 'steel', display: 'Steel Armour', pieces: ['Helmet','Vest','Arms','Legs'],
  //   recipe: [{id:'steel_ingot', qty:8}, {id:'leather_strip', qty:2}],
  //   onEquipMeta: { setDR:0.30, legsSpeed:0.15 },
  //   missionCompleteTo: 6
  // });
  function registerCraftableSet(def){
    const { setKey, display, pieces, recipe, onEquipMeta, missionCompleteTo } = def;
    def.tryCraft = function(){
      if(!playerInArmoury()) return false;
      const inv=_getInv();
      for(const r of recipe){ if(!inv[r.id] || (inv[r.id].count|0) < r.qty) return false; }
      for(const r of recipe){ _dec(inv, r.id, r.qty); }
      for(const p of pieces){
        _inc(inv, `${setKey}${p}`, 1);
      }
      if(onEquipMeta){ inv[`_${setKey}SetMeta`] = onEquipMeta; }
      _setInv(inv);
      IZZA.toast?.(`Crafted ${display}`);
      if (missionCompleteTo){ _setMissions(missionCompleteTo); agentPopup('Mission Completed', `You’ve completed mission ${missionCompleteTo}.`); }
      return true;
    };
    return def;
  }
  // (we keep the template exposed)
  window.IZZA_M5_registerCraftableSet = registerCraftableSet;

  // ---------- Wiring ----------
  IZZA.on('ready', ({ api:__api })=>{
    api = __api||api||{};
    TILE = api?.TILE || TILE;

    // draw hooks + update loop (your core already uses these)
    IZZA.on('render-under', renderUnder);
    IZZA.on('update-post', onUpdatePost);

    wireB();
    wireArmouryCraftButtonWatcher();

    // initial M4 check (handles “I crafted cardboard long ago”)
    setTimeout(maybeFinishM4AndPlaceJack, 50);
  });

  // Also catch generic inventory change (e.g., crafting via other flows)
  window.addEventListener('izza-inventory-changed', ()=> setTimeout(maybeFinishM4AndPlaceJack, 0));

  // Fallback: if page resumes and missions >=4, ensure jack exists
  IZZA.on('resume', ()=>{ if(_missions()>=4) ensureJack(); });

  // Clean up
  IZZA.on('shutdown', ()=>{ clearJack(); clearPumpkins(); setNight(false); });

})();
