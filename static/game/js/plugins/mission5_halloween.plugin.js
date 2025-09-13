/* mission5_halloween.plugin.js
   IZZA Mission 5 — “Night of the Lantern”
   - Spawns jack-o’-lantern when missionsCompleted == 4 (listens to M4 completion)
   - Places jack-o’-lantern at HQ door +3E (exactly 1× tile)
   - Interact with [B] to start a 5m night mission; pumpkins spawn at exact offsets
   - Werewolf spawns every 30s while moving at night; A to fight
   - Craft Pumpkin Armour (4 pieces) from 1 jack-o’-lantern + 3 pumpkin pieces
   - Set bonus: 20% damage reduction; Legs grant fast run (near car speed)
   - All art as inline SVG rasterized to canvas
*/
(function(){
  if (!window.IZZA) window.IZZA = {};
  if (typeof IZZA.on !== 'function') IZZA.on = function(){};
  if (typeof IZZA.emit !== 'function') IZZA.emit = function(){};

  let api = null;
  let TILE = 60;

  // Early hooks (safety if 'ready' is late)
  try { IZZA.on('render-under', renderUnder); IZZA.on('update-post', onUpdatePost); } catch {}

  // When Mission 4 completes, place the jack if missionsCompleted == 4
  try {
    IZZA.on('mission-complete', p => { if ((p?.id|0) === 4) setTimeout(()=>{ if (missionsIsFour()) ensureJack(); }, 0); });
  } catch {}
  window.addEventListener('mission-complete', e => {
    const id = (e?.detail?.id|0) || 0;
    if (id === 4) setTimeout(()=>{ if (missionsIsFour()) ensureJack(); }, 0);
  });

  // If we load into a save that's already showing 4, ensure the jack exists
  setTimeout(()=>{ if (missionsIsFour()) ensureJack(); }, 0);

  // ---------- Core helpers ----------
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

  // Prefer inventory meta, fall back to localStorage
  function missionsCompletedMeta(){
    try{
      if (IZZA?.api?.inventory?.getMeta){
        const m = IZZA.api.inventory.getMeta('missionsCompleted');
        const n = (m|0);
        if (Number.isFinite(n)) return n;
      }
    }catch{}
    return _missions();
  }
  function missionsIsFour(){ return missionsCompletedMeta() === 4; }

  // ---------- HQ door grid (same logic as Mission 4) ----------
  function hqDoorGrid(){
    const t = api?.TILE || TILE;
    const d = api?.doorSpawn || { x: api?.player?.x||0, y: api?.player?.y||0 };
    return { gx: Math.round(d.x/t), gy: Math.round(d.y/t) };
  }
  function jackLanternGrid(){
    const d = hqDoorGrid();
    // EXACTLY +3 tiles East of the door (sidewalk), no N/S change
    return { x: d.gx + 3, y: d.gy };
  }

  // ---------- world→screen ----------
  function worldToScreen(wx, wy){
    const S = api?.DRAW || TILE, T = api?.TILE || TILE;
    const sx = (wx - (api?.camera?.x||0)) * (S/T);
    const sy = (wy - (api?.camera?.y||0)) * (S/T);
    return { sx, sy };
  }

  // ---------- tiny agent popup ----------
  function agentPopup(title, body, t=2000){
    if (api?.UI?.popup) { api.UI.popup({ style:'agent', title, body, timeout:t }); return; }
    const el=document.createElement('div');
    el.style.cssText='position:absolute;left:50%;top:18%;transform:translateX(-50%);background:rgba(10,12,20,.92);color:#b6ffec;padding:14px 18px;border:2px solid #36f;border-radius:8px;font-family:monospace;z-index:9999';
    el.innerHTML=`<div style="font-weight:800">${title}</div><div>${body||''}</div>`;
    (document.getElementById('gameCard')||document.body).appendChild(el);
    setTimeout(()=>{ el.remove(); }, t);
  }

  // ---------- SVG cache ----------
  const _imgCache = new Map();
  function svgToImage(svg, pxW, pxH){
    const key=svg+'|'+pxW+'x'+pxH;
    if(_imgCache.has(key)) return _imgCache.get(key);
    const url='data:image/svg+xml;utf8,'+encodeURIComponent(svg);
    const img=new Image(); img.width=pxW; img.height=pxH; img.src=url;
    _imgCache.set(key, img);
    return img;
  }

  // ---------- Art ----------
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
  let jackGrid=null, jackImg=null, jackPlaced=false;
  let pumpkins = []; // [{tx,ty, collected:false, img}]
  let mission5Active=false, mission5Start=0, M5_MS=5*60*1000;
  let nightOn=false, werewolfNext=0, lastPos=null;

  // ---------- Placement (M4-style grid logic; 1× tile JACK) ----------
  function ensureJack(){
    if (jackPlaced) return;
    jackGrid = jackLanternGrid();
    // SIZE CHANGE: 1× tile (was 3×)
    jackImg  = svgToImage(svgJack(), TILE*1.0, TILE*1.0);
    jackPlaced=true;
    if(!ensureJack._t){ ensureJack._t=setInterval(()=>{ try{ IZZA.emit('sfx',{kind:'jack-HA',vol:0.6}); }catch{} }, 2500); }
  }
  function clearJack(){
    if(ensureJack._t){ clearInterval(ensureJack._t); ensureJack._t=null; }
    jackPlaced=false; jackGrid=null; jackImg=null;
  }

  function computePumpkinTiles(){
    const d=hqDoorGrid();
    const p1={ tx:d.gx-15, ty:d.gy+10 };
    const p2={ tx:p1.tx-20, ty:p1.ty+13 };
    const p3={ tx:d.gx+8,  ty:d.gy-13 };
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

  // ---------- Render (camera-relative; M4-style; Tier 2 gate) ----------
  function renderUnder(){
    try{
      if (!api?.ready) return;
      if (localStorage.getItem('izzaMapTier') !== '2') return;

      const ctx=document.getElementById('game')?.getContext('2d'); if(!ctx) return;
      const S=api.DRAW, t=api.TILE||TILE;

      // draw jack only when missionsCompleted == 4
      if (missionsIsFour() && jackPlaced && jackGrid && jackImg && jackImg.complete){
        // center like M4’s box (+S*0.5, +S*0.6)
        const wx = jackGrid.x * t, wy = jackGrid.y * t;
        const scr = worldToScreen(wx, wy);
        const sx = scr.sx + S*0.5;
        const sy = scr.sy + S*0.6;

        ctx.save();
        // SIZE: 1× tile
        const w = (t*1.0)*(S/t), h = w;
        ctx.drawImage(jackImg, sx - w/2, sy - h/2, w, h);
        ctx.restore();
      }

      // pumpkins
      if (pumpkins.length){
        for(const p of pumpkins){
          if(p.collected || !p.img || !p.img.complete) continue;
          const wx = p.tx * t, wy = p.ty * t;
          const scr = worldToScreen(wx, wy);
          const sx = scr.sx + S*0.5;
          const sy = scr.sy + S*0.58;
          const w = (t*1.6)*(S/t), h = w;
          ctx.save();
          ctx.drawImage(p.img, sx - w/2, sy - h/2, w, h);
          ctx.restore();
        }
      }
    }catch{}
  }

  // ---------- Input (B) ----------
  function isNearGrid(gx,gy, rPx){
    const t=api?.TILE||TILE;
    const px = (api?.player?.x||0)+16, py=(api?.player?.y||0)+16;
    const cx = gx*t + t/2, cy = gy*t + t/2;
    return Math.hypot(px-cx, py-cy) <= (rPx||t*0.9);
  }

  function onB(e){
    if(!api?.ready) return;

    // on jack → show intro (only when visible state is correct)
    if (missionsIsFour() && jackPlaced && jackGrid && isNearGrid(jackGrid.x, jackGrid.y, (api?.TILE||TILE)*0.9)){
      e?.preventDefault?.(); e?.stopImmediatePropagation?.(); e?.stopPropagation?.();
      showNightIntro();
      return;
    }

    // on pumpkin → collect
    for(const p of pumpkins){
      if(!p.collected && isNearGrid(p.tx, p.ty, (api?.TILE||TILE)*0.9)){
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

  // ---------- Werewolf ----------
  function isMoving(){
    const p={x:api?.player?.x||0, y:api?.player?.y||0};
    if(!lastPos){ lastPos=p; return false; }
    const d=Math.hypot(p.x-lastPos.x,p.y-lastPos.y); lastPos=p; return d>((api?.TILE||TILE)*0.35);
  }
  function spawnWerewolf(){
    try{ IZZA.emit('npc-spawn',{kind:'werewolf', host:'mission5'}); }catch{}
    try{ IZZA.emit('sfx',{kind:'werewolf-spawn',vol:0.9}); }catch{}
  }

  // ---------- Crafting: Pumpkin Armour ----------
  function playerInArmoury(){
    if(api?.inZone) return api.inZone('armoury')===true;
    const d = window.__IZZA_ARMOURY__?.door;
    if(!d) return false;
    const me={x:(api?.player?.x||0)/(api?.TILE||TILE)|0, y:(api?.player?.y||0)/(api?.TILE||TILE)|0};
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

    _inc(inv,'pumpkinHelmet',1);
    _inc(inv,'pumpkinVest',1);
    _inc(inv,'pumpkinArms',1);
    _inc(inv,'pumpkinLegs',1);
    inv.pumpkinLegs.meta = { speed: 0.28 };
    inv._pumpkinSetMeta   = { setDR: 0.20 };

    _setInv(inv);
    IZZA.toast?.('Crafted Pumpkin Armour (4 pcs) — set bonus active');

    mission5Active=false; setNight(false); clearPumpkins();
    _setMissions(5);
    agentPopup('Mission Completed', 'You’ve completed mission 5.');
    try{ IZZA.emit('mission-complete',{id:5,name:'Night of the Lantern'}); }catch{}

    return true;
  }

  // ---------- M4 completion assist (if needed) ----------
  function hasCardboardSet(inv){
    return (inv.cardboardHelmet?.count|0)>0 &&
           (inv.cardboardVest?.count|0)>0 &&
           (inv.cardboardArms?.count|0)>0 &&
           (inv.cardboardLegs?.count|0)>0;
  }
  function maybeFinishM4AndPlaceJack(){
    const inv=_getInv();
    if (missionsIsFour()){ ensureJack(); return; }
    if (_missions() >= 4){ ensureJack(); return; }
    if (!hasCardboardSet(inv)) return;

    const ui=document.getElementById('armouryUI');
    const doPopupAndBump=()=>{
      _setMissions(4);
      agentPopup('Mission Completed', 'You’ve completed mission 4.');
      try{ IZZA.emit('mission-complete',{id:4,name:'Armoury: Cardboard'}); }catch{}
      if (missionsIsFour() || _missions()===4) ensureJack();
    };
    if (ui && window.getComputedStyle(ui).display!=='none'){
      const once=()=>{ ui.removeEventListener('click', onClose, true); window.removeEventListener('keydown', onEsc, true); doPopupAndBump(); };
      const onClose=(e)=>{ const btn=e.target && e.target.closest('#armouryClose'); if(btn){ e.preventDefault(); setTimeout(once, 0); } };
      const onEsc=(e)=>{ if((e.key||'').toLowerCase()==='escape'){ setTimeout(once, 0); } };
      ui.addEventListener('click', onClose, true);
      window.addEventListener('keydown', onEsc, true);
    } else {
      doPopupAndBump();
    }
  }

  // ---------- Wiring ----------
  IZZA.on('ready', ({ api:__api })=>{
    api = __api||api||{};
    TILE = api?.TILE || TILE;

    IZZA.on('render-under', renderUnder);
    IZZA.on('update-post', onUpdatePost);

    wireB();

    // initial M4 check (handles “I crafted cardboard long ago”)
    setTimeout(maybeFinishM4AndPlaceJack, 50);
  });

  // Also catch generic inventory change (e.g., crafting via other flows)
  window.addEventListener('izza-inventory-changed', ()=> setTimeout(maybeFinishM4AndPlaceJack, 0));

  // Update tick
  function onUpdatePost({ now }){
    if (mission5Active){
      if ((now - mission5Start) > M5_MS){
        mission5Active=false; setNight(false); clearPumpkins();
        IZZA.toast?.('Mission 5 failed — time expired.');
        setTimeout(()=>{ if (missionsIsFour()) ensureJack(); }, 800);
      }
      if (now >= werewolfNext){
        if (isMoving()) spawnWerewolf();
        werewolfNext = now + 30000;
      }
      tryCraftPumpkin();
    }
  }

  // Clean up
  IZZA.on('shutdown', ()=>{ clearJack(); clearPumpkins(); setNight(false); });

})();
