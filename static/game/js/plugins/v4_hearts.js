// /static/game/js/plugins/v4_hearts.js
(function(){
  const BUILD = 'v4-hearts-plugin-1.1-dom-hud';
  console.log('[IZZA PLAY]', BUILD);

  // persistent keys (reuse same namespace as core)
  const LS = {
    maxHearts:  'izzaMaxHearts',
    curSegs:    'izzaCurHeartSegments',
    inventory:  'izzaInventory'
  };

  // local mirror; we attach onto core's player once core is ready
  let api=null, player=null, cops=null;

  // --- persistence helpers ---
  const getMaxHearts = ()=> Math.max(1, parseInt(localStorage.getItem(LS.maxHearts)||'3',10));
  const setMaxHearts = n => localStorage.setItem(LS.maxHearts, String(Math.max(1,n|0)));
  const getCurSegs = maxH => {
    const def = maxH*3;
    const raw = parseInt(localStorage.getItem(LS.curSegs)||String(def),10);
    return Math.max(0, Math.min(def, raw));
  };
  const setCurSegs = (seg, maxH)=> {
    localStorage.setItem(LS.curSegs, String(Math.max(0, Math.min((maxH||getMaxHearts())*3, seg|0))));
  };
  const loseAllItems = ()=> localStorage.setItem(LS.inventory, '[]');

  // --- tiny toast for feedback (reuses style from v3 if present) ---
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

  // --- DOM HUD (hearts under the stars) ---
  let hudWrap=null, styleEl=null;
  function ensureHUD(){
    // styles for the DOM hearts
    if(!styleEl){
      styleEl = document.createElement('style');
      styleEl.textContent = `
        .izza-hearts-hud{
          position:fixed;
          right:12px;
          /* top is computed to sit under .hud */
          z-index:8;
          background:rgba(10,12,18,.75);
          border:1px solid #263042;
          border-radius:12px;
          padding:6px 8px;
          display:flex; gap:8px; align-items:center;
          box-shadow:0 4px 10px rgba(0,0,0,.25);
        }
        .izza-hearts-hud .label{
          font-size:12px; opacity:.85; margin-right:2px;
        }
        .izza-hearts-row{ display:flex; gap:6px; }
        .izza-heart{
          width:20px; height:16px;
          border:2px solid #d14a4a;
          border-radius:4px;
          box-sizing:border-box;
          background:
            linear-gradient(90deg,
              #ff5555 0%,
              #ff5555 var(--fill, 100%),
              #3a3f4a var(--fill, 100%),
              #3a3f4a 100%);
        }
      `;
      document.head.appendChild(styleEl);
    }
    if(!hudWrap){
      hudWrap = document.createElement('div');
      hudWrap.className = 'izza-hearts-hud';
      hudWrap.id = 'izzaHeartsHUD';
      const row = document.createElement('div');
      row.className = 'izza-hearts-row';
      hudWrap.appendChild(row);
      document.body.appendChild(hudWrap);
      positionHUD();
      window.addEventListener('resize', positionHUD);
      window.addEventListener('scroll', positionHUD, {passive:true});
    }
  }
  function positionHUD(){
    const hud = document.querySelector('.hud');
    const rect = hud ? hud.getBoundingClientRect() : {bottom:0};
    // place our hearts box ~8px under the sticky .hud
    const topPx = Math.max(0, rect.bottom + 2);
    if(hudWrap) hudWrap.style.top = `${topPx}px`;
  }
  function renderHeartsHUD(){
    if(!hudWrap) return;
    const row = hudWrap.querySelector('.izza-hearts-row');
    const maxH = player.maxHearts || 3;
    const seg  = (player.heartSegs==null) ? (maxH*3) : player.heartSegs;

    // build hearts html
    row.innerHTML = '';
    for(let i=0;i<maxH;i++){
      const segForHeart = Math.max(0, Math.min(3, seg - i*3)); // 0..3
      const pct = Math.round((segForHeart/3)*100);
      const h = document.createElement('div');
      h.className = 'izza-heart';
      h.style.setProperty('--fill', pct + '%');
      row.appendChild(h);
    }
  }

  // --- hearts model ---
  function initHearts(){
    player.maxHearts = getMaxHearts();
    player.heartSegs = getCurSegs(player.maxHearts);
    if (player.heartSegs <= 0) {
      player.heartSegs = player.maxHearts * 3;
      setCurSegs(player.heartSegs, player.maxHearts);
    }
    ensureHUD();
    renderHeartsHUD();
  }
  function healFull(){
    player.heartSegs = player.maxHearts * 3;
    setCurSegs(player.heartSegs, player.maxHearts);
    renderHeartsHUD();
  }
  function takeDamageSegs(n=1){
    player.heartSegs = Math.max(0, player.heartSegs - n);
    setCurSegs(player.heartSegs, player.maxHearts);
    renderHeartsHUD();
    if (player.heartSegs <= 0) onDeath();
  }

  // --- death / respawn penalties ---
  function onDeath(){
    // lose 2/3 coins (keep 1/3)
    const keep = Math.floor(api.getCoins() / 3);
    api.setCoins(keep);
    // lose purchased items
    loseAllItems();
    // reset wanted + despawn cops
    api.setWanted(0);
    cops.length = 0;

    // respawn at HQ door (use core-provided spawn when available)
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
      const gx = Math.round(player.x / TILE);
      const gy = Math.round(player.y / TILE);
      return { x: gx*TILE + (TILE/2 - 8), y: gy*TILE };
    }catch{ return { x: player.x, y: player.y }; }
  }

  // --- cop melee: 1 hit (1/3 heart) per 2s if in range ---
  function attachCopMelee(){
    IZZA.on('update-post', ({now})=>{
      if(!api) return;
      const atkRange = 26;
      const cd = 2000; // ms
      for(const c of cops){
        c._nextAtk ??= now;
        const dist = Math.hypot(player.x - c.x, player.y - c.y);
        if (dist <= atkRange && now >= c._nextAtk){
          takeDamageSegs(1);
          c._nextAtk = now + cd;
        }
      }
    });
  }

  // --- re-render on wanted changes (optional future hooks) ---
  function attachHUDRefresh(){
    IZZA.on('wanted-changed', ()=> renderHeartsHUD());
    // light throttle re-render so hearts keep up even if LS changed elsewhere
    let last=0;
    IZZA.on('update-post', ({now})=>{
      if(now-last>250){ last=now; renderHeartsHUD(); }
    });
  }

  // init when core says ready
  if(window.IZZA && IZZA.on){
    IZZA.on('ready', (coreApi)=>{
      api = coreApi;
      player = api.player;
      cops   = api.cops;

      initHearts();
      attachCopMelee();
      attachHUDRefresh();
      positionHUD();
    });
  }else{
    console.warn('v4_hearts: core hook bus not found. Did you include izza_core_v3.js first?');
  }
})();
