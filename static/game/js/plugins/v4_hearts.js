// /static/game/js/plugins/v4_hearts.js
(function(){
  const BUILD = 'v4-hearts-plugin';
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

  // --- hearts model ---
  function initHearts(){
    player.maxHearts = getMaxHearts();
    player.heartSegs = getCurSegs(player.maxHearts);
    if (player.heartSegs <= 0) {
      // First time or invalid → fill up
      player.heartSegs = player.maxHearts * 3;
      setCurSegs(player.heartSegs, player.maxHearts);
    }
  }
  function healFull(){
    player.heartSegs = player.maxHearts * 3;
    setCurSegs(player.heartSegs, player.maxHearts);
  }
  function takeDamageSegs(n=1){
    player.heartSegs = Math.max(0, player.heartSegs - n);
    setCurSegs(player.heartSegs, player.maxHearts);
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

    // respawn at HQ door
    const door = findHQDoor();
    player.x = door.x; player.y = door.y;
    player.facing='down'; player.moving=false; player.animTime=0;

    healFull();
    toast('You were taken out! Lost items and 2/3 of your coins.', 4);
  }

  // find door from core constants (same logic as core used)
  function findHQDoor(){
    const TILE = api.TILE;
    // spawn used in v3: center on top sidewalk in front of HQ
    // plugin can read the camera but not world layout; we infer from current position on death
    // fallback to current position if anything is missing
    try{
      // try to snap near current X to tile center
      const gx = Math.round(player.x / TILE);
      const gy = Math.round(player.y / TILE);
      return { x: gx*TILE + (TILE/2 - 8), y: gy*TILE };
    }catch{ return { x: player.x, y: player.y }; }
  }

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

  // --- draw hearts on top-left of the game canvas ---
  function drawHearts(){
    if(!api) return;
    const ctx = document.getElementById('game').getContext('2d');
    const x0 = 12;            // padding inside the canvas
    const y0 = 16;
    const size = 16;          // pixel heart width/height (scaled look; it’s UI not world)
    const gap  = 6;

    const maxH = player.maxHearts;
    const seg  = player.heartSegs;           // 0..maxH*3

    // background clear behind hearts
    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = 'rgba(10,12,18,0.55)';
    ctx.fillRect(x0-6, y0-6, maxH*(size+gap)+6, size+12);
    ctx.restore();

    for(let i=0;i<maxH;i++){
      const segForHeart = Math.max(0, Math.min(3, seg - i*3)); // 0..3
      const x = x0 + i*(size+gap);
      drawHeart(ctx, x, y0, size, segForHeart/3);
    }
  }
  function drawHeart(ctx, x, y, s, fillRatio){
    // simple pixel-ish heart
    ctx.save();
    // empty heart outline
    ctx.strokeStyle = '#d14a4a';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, s, s);

    // filled portion (red), drained portion (grey)
    const w = Math.floor(s * fillRatio);
    if (w>0){ ctx.fillStyle = '#ff5555'; ctx.fillRect(x, y, w, s); }
    if (w<s){ ctx.fillStyle = '#3a3f4a'; ctx.fillRect(x+w, y, s-w, s); }
    ctx.restore();
  }

  // --- cop melee: 1 hit (1/3 heart) per 2s if in range ---
  function attachCopMelee(){
    let lastNow = performance.now();
    IZZA.on('update-post', ({dtSec, now})=>{
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

  // --- render hook: draw hearts last so they sit above world ---
  function attachRenderOverlay(){
    // piggyback after core's render by drawing every frame using rAF;
    // (core runs continuously; we just schedule ours too)
    function loop(){
      try{ drawHearts(); }catch(e){ /* ignore */ }
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
  }

  // init when core says ready
  if(IZZA && IZZA.on){
    IZZA.on('ready', (coreApi)=>{
      api = coreApi;
      player = api.player;
      cops   = api.cops;

      // init hearts from persistence
      initHearts();

      // refill when wanted resets from death or user action? (we only refill on death here)
      IZZA.on('wanted-changed', ({from,to})=>{
        // no-op for now; could add mechanics later
      });

      attachCopMelee();
      attachRenderOverlay();
    });
  }else{
    console.warn('v4_hearts: core hook bus not found. Did you include izza_core_v3.js first?');
  }
})();
