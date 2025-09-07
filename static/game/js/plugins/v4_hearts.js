// /static/game/js/plugins/v4_hearts.js
(function () {
  const BUILD = 'v4.4-hearts-plugin+svg-hearts+low-blink+pvp-isolation+rocket-damage';
  console.log('[IZZA PLAY]', BUILD);

  const LS = {
    maxHearts:  'izzaMaxHearts',
    curSegs:    'izzaCurHeartSegments',
    inventory:  'izzaInventory'
  };

  let api = null, player = null, cops = null;

  // --- tiny helper to mirror to user-scoped key ---
  function canonUser(){
    try{
      const p = (window.__IZZA_PROFILE__||{});
      const plug = (window.izzaUserKey && typeof izzaUserKey?.get==='function') ? izzaUserKey.get() : '';
      const ls   = localStorage.getItem('izzaUserKey') || '';
      const u = (p.username || p.user || plug || ls || 'guest').toString().trim().replace(/^@+/,'').toLowerCase().replace(/[^a-z0-9-_]/g,'-');
      return u || 'guest';
    }catch{ return 'guest'; }
  }

  // ---------- persistence ----------
  const getMaxHearts = () => Math.max(1, parseInt(localStorage.getItem(LS.maxHearts) || '3', 10));

  const setCurSegs = (seg, maxH) => {
    const v = String(Math.max(0, Math.min((maxH||getMaxHearts())*3, seg|0)));
    localStorage.setItem(LS.curSegs, v);                                       // global
    try{ localStorage.setItem('izzaCurHeartSegments_'+canonUser(), v); }catch{} // user-scoped mirror
    try{ window.dispatchEvent(new Event('izza-hearts-changed')); }catch{}       // notify persist
  };

  const getCurSegs = (maxH) => {
    const def = maxH*3;
    const raw = parseInt(localStorage.getItem(LS.curSegs) || String(def), 10);
    return Math.max(0, Math.min(def, raw));
  };

  // inventory should be an object, not an array
  const loseAllItems = () => {
    try { localStorage.setItem(LS.inventory, '{}'); } catch {}
    try { window.dispatchEvent(new Event('izza-inventory-changed')); } catch {}
  };

  // ---------- hearts model ----------
  function initHearts(){
    // one-time migration in case older runs stored "[]"
    try{
      const invRaw = localStorage.getItem(LS.inventory);
      if (invRaw && invRaw.trim().startsWith('[')) {
        localStorage.setItem(LS.inventory, '{}');
        try { window.dispatchEvent(new Event('izza-inventory-changed')); } catch {}
      }
    }catch{}

    player.maxHearts = getMaxHearts();
    player.heartSegs = getCurSegs(player.maxHearts);
    if (player.heartSegs <= 0) {
      player.heartSegs = player.maxHearts * 3;
      setCurSegs(player.heartSegs, player.maxHearts); // (emits event + mirrors)
    }
    drawDOMHearts();  // initial draw
    placeHeartsHud(); // and position
  }

  function healFull(){
    player.heartSegs = player.maxHearts * 3;
    setCurSegs(player.heartSegs, player.maxHearts);   // (emits event + mirrors)
    drawDOMHearts();
  }

  function takeDamageSegs(n=1){
    // If a PvP duel is active, DO NOT touch normal hearts or death/respawn.
    if (window.__IZZA_DUEL && window.__IZZA_DUEL.active) {
      try { if (window.IZZA && IZZA.emit) IZZA.emit('pvp-cop-damage', { segs:n }); } catch {}
      return;
    }
    player.heartSegs = Math.max(0, player.heartSegs - n);
    setCurSegs(player.heartSegs, player.maxHearts);   // (emits event + mirrors)
    drawDOMHearts();
    if (player.heartSegs <= 0) onDeath();
  }

  // ---------- death / respawn ----------
  function onDeath(){
    const keep = Math.floor(api.getCoins() / 3); // keep 1/3
    api.setCoins(keep);
    loseAllItems();
    api.setWanted(0);
    cops.length = 0;

    const door = findHQDoor();
    player.x = door.x; player.y = door.y;
    player.facing='down'; player.moving=false; player.animTime=0;

    healFull();
    toast('You were taken out! Lost items and 2/3 of your coins.', 4);
  }

  function findHQDoor(){
    if (api && api.doorSpawn) return { x: api.doorSpawn.x, y: api.doorSpawn.y };
    const TILE = api ? api.TILE : 32;
    try{
      const gx = Math.round(player.x / TILE), gy = Math.round(player.y / TILE);
      return { x: gx*TILE + (TILE/2 - 8), y: gy*TILE };
    }catch{ return { x: player.x, y: player.y }; }
  }

  // ---------- toast ----------
  function toast(text, seconds=3){
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
    setTimeout(()=>{ h.style.display='none'; }, seconds*1000);
  }

  // ===================================================================
  //                    DOM hearts (SVG) under stars
  // ===================================================================
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function ensureHeartsHud(){
    let hud = document.getElementById('heartsHud');
    if (hud) return hud;
    hud = document.createElement('div');
    hud.id = 'heartsHud';
    Object.assign(hud.style, {
      position:'absolute',
      zIndex:6,
      display:'flex',
      gap:'10px',
      alignItems:'center',
      pointerEvents:'none',
      filter:'drop-shadow(0 1px 0 rgba(0,0,0,.35))'
    });
    document.body.appendChild(hud);
    if(!document.getElementById('heartBlinkCSS')){
      const st=document.createElement('style'); st.id='heartBlinkCSS';
      st.textContent=`@keyframes heartBlink{0%,100%{filter:drop-shadow(0 0 0 rgba(255,90,90,0))}50%{filter:drop-shadow(0 0 12px rgba(255,90,90,.95))}}
      #heartsHud .heart-blink{animation:heartBlink .6s infinite}`;
      document.head.appendChild(st);
    }
    return hud;
  }

  const HEART_PATH = 'M12 21c-.5-.5-4.9-3.7-7.2-6C3 13.2 2 11.6 2 9.7 2 7.2 4 5 6.6 5c1.6 0 3 .8 3.8 2.1C11.2 5.8 12.6 5 14.2 5 16.8 5 19 7.2 19 9.7c0 1.9-1 3.5-2.8 5.3-2.3 2.3-6.7 5.5-7.2 6Z';

  function makeHeartSVG(ratio){
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox','0 0 24 22');
    svg.setAttribute('width','24'); svg.setAttribute('height','22');
    const base = document.createElementNS(SVG_NS, 'path');
    base.setAttribute('d', HEART_PATH);
    base.setAttribute('fill', '#3a3f4a');
    svg.appendChild(base);
    const clipId = 'hclip_' + Math.random().toString(36).slice(2);
    const clip = document.createElementNS(SVG_NS, 'clipPath');
    clip.setAttribute('id', clipId);
    const clipRect = document.createElementNS(SVG_NS, 'rect');
    clipRect.setAttribute('x','0'); clipRect.setAttribute('y','0');
    clipRect.setAttribute('width', String(24 * Math.max(0, Math.min(1, ratio))));
    clipRect.setAttribute('height','22');
    clip.appendChild(clipRect);
    svg.appendChild(clip);
    const red = document.createElementNS(SVG_NS, 'path');
    red.setAttribute('d', HEART_PATH);
    red.setAttribute('fill', '#ff5555');
    red.setAttribute('clip-path', `url(#${clipId})`);
    svg.appendChild(red);
    return svg;
  }

  function drawDOMHearts(){
    const hud = ensureHeartsHud();
    if (!player) return;
    const maxH = player.maxHearts || 3;
    const seg  = player.heartSegs ?? maxH*3;
    hud.innerHTML = '';
    for (let i=0;i<maxH;i++){
      const segForHeart = Math.max(0, Math.min(3, seg - i*3));
      const ratio = segForHeart / 3;
      const wrap = document.createElement('div');
      wrap.style.width = '24px';
      wrap.style.height = '22px';
      if(seg <= 3 && i === Math.floor((seg-1)/3)) wrap.className='heart-blink';
      wrap.appendChild(makeHeartSVG(ratio));
      hud.appendChild(wrap);
    }
    placeHeartsHud();
  }

  // react to hydrator’s event (kept from your working version)
  window.addEventListener('izza-hearts-changed', ()=>{
    if (!player) return;
    const maxH = getMaxHearts();
    const def  = maxH * 3;
    const seg  = Math.max(0, Math.min(def, parseInt(localStorage.getItem('izzaCurHeartSegments') || String(def), 10)));
    player.maxHearts = maxH;
    player.heartSegs = seg;
    try { drawDOMHearts(); } catch {}
  }, { passive:true });

  function placeHeartsHud(){
    const hud   = ensureHeartsHud();
    const stars = document.getElementById('stars');
    if (!stars) return;
    const r = stars.getBoundingClientRect();
    hud.style.left = Math.round(r.left) + 'px';
    hud.style.top  = Math.round(r.bottom + 6) + 'px';
  }
  window.addEventListener('resize', placeHeartsHud, { passive:true });
  window.addEventListener('orientationchange', placeHeartsHud, { passive:true });

  // ===================================================================
  //                 Cop melee (1/3 heart per 2s in range)
  // ===================================================================
  function attachCopMelee(){
    IZZA.on('update-post', ({ now })=>{
      if (!api) return;
      const atkRange = 26, cd = 2000;
      for (const c of cops){
        c._nextAtk ??= now;
        const dist = Math.hypot(player.x - c.x, player.y - c.y);
        if (dist <= atkRange && now >= c._nextAtk){
          if (window.__IZZA_DUEL && window.__IZZA_DUEL.active) {
            try { IZZA.emit('pvp-cop-damage', { segs:1 }); } catch {}
          } else {
            takeDamageSegs(1);
          }
          c._nextAtk = now + cd;
        }
      }
    });
  }

  // ===================================================================
  //            Projectile / special hits (e.g., tank rockets)
  // ===================================================================
  function attachSpecialHitListener(){
    // free_drive tanks emit: IZZA.emit('player-hit', {by:'rocket', dmg:3})
    IZZA.on('player-hit', (e)=>{
      const dmgSegs = Math.max(1, (e && e.dmg|0) || 1); // default 1 seg; rockets use 3
      if (window.__IZZA_DUEL && window.__IZZA_DUEL.active) {
        // Keep PvP isolated from world damage
        try { IZZA.emit('pvp-cop-damage', { segs: dmgSegs }); } catch {}
        return;
      }
      takeDamageSegs(dmgSegs);
    });
  }

  // ---------- boot ----------
  if (window.IZZA && IZZA.on){
    IZZA.on('ready', (coreApi)=>{
      api = coreApi;
      player = api.player;
      cops   = api.cops;
      initHearts();
      attachCopMelee();
      attachSpecialHitListener();   // <-- add rocket/tank damage hookup
      IZZA.on('wanted-changed', placeHeartsHud);
    });
  }else{
    console.warn('v4_hearts: core hook bus not found. Include izza_core_v3.js first.');
  }
})();
