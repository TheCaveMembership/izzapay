// /static/game/js/plugins/v4_hearts.js
(function(){
  const BUILD = 'v4-hearts-plugin-1.0';
  console.log('[IZZA PLAY]', BUILD);

  // --- persistence keys (reuse core namespace) ---
  const LS = {
    maxHearts:  'izzaMaxHearts',
    curSegs:    'izzaCurHeartSegments',
    inventory:  'izzaInventory'
  };

  // mirrors to core state (filled when core emits "ready")
  let api=null, player=null, cops=null;

  // ---------- persistence helpers ----------
  const getMaxHearts = ()=> Math.max(1, parseInt(localStorage.getItem(LS.maxHearts)||'3',10));
  const setMaxHearts = n => localStorage.setItem(LS.maxHearts, String(Math.max(1,n|0)));
  const getCurSegs = (maxH)=>{
    const def = maxH*3;
    const raw = parseInt(localStorage.getItem(LS.curSegs)||String(def),10);
    return Math.max(0, Math.min(def, isNaN(raw)?def:raw));
  };
  const setCurSegs = (seg, maxH)=>{
    const cap = (maxH||getMaxHearts())*3;
    localStorage.setItem(LS.curSegs, String(Math.max(0, Math.min(cap, seg|0))));
  };
  const loseAllItems = ()=> localStorage.setItem(LS.inventory, '[]');

  // ---------- hearts model ----------
  function initHearts(){
    player.maxHearts = getMaxHearts();       // count of heart containers
    player.heartSegs = getCurSegs(player.maxHearts); // segments remaining (3 per heart)
    if (player.heartSegs <= 0){
      player.heartSegs = player.maxHearts*3;
      setCurSegs(player.heartSegs, player.maxHearts);
    }
  }
  function healFull(){
    player.heartSegs = player.maxHearts*3;
    setCurSegs(player.heartSegs, player.maxHearts);
  }
  // 1 segment = one third of a heart
  function takeDamageSegs(n=1){
    player.heartSegs = Math.max(0, player.heartSegs - n);
    setCurSegs(player.heartSegs, player.maxHearts);
    if (player.heartSegs <= 0) onDeath();
  }

  // ---------- death / respawn penalties ----------
  function onDeath(){
    // lose 2/3 coins (keep 1/3)
    const keep = Math.floor(api.getCoins() / 3);
    api.setCoins(keep);

    // lose purchased items
    loseAllItems();

    // reset wanted + despawn cops
    api.setWanted(0);
    if (Array.isArray(cops)) cops.length = 0;

    // respawn near HQ door (fallback: current snapped tile)
    const spawn = findHQDoor();
    player.x = spawn.x; player.y = spawn.y;
    player.facing='down'; player.moving=false; player.animTime=0;

    healFull();
    toast('You were taken out! Lost items and 2/3 of your coins.', 4);
  }

  function findHQDoor(){
    // If core ever exposes a doorSpawn, prefer it.
    if (api && api.doorSpawn) return { x: api.doorSpawn.x, y: api.doorSpawn.y };

    // Generic safe fallback → snap to current tile center
    const TILE = api ? api.TILE : 32;
    try{
      const gx = Math.round(player.x / TILE);
      const gy = Math.round(player.y / TILE);
      return { x: gx*TILE + (TILE/2 - 8), y: gy*TILE };
    }catch{
      return { x: player.x, y: player.y };
    }
  }

  // ---------- tiny toast (reuses tutorial hint box styling) ----------
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

  // ---------- hearts overlay drawing ----------
  function drawHearts(){
    if(!api) return;
    const canvas = document.getElementById('game');
    if(!canvas) return;
    const ctx = canvas.getContext('2d');

    const x0 = 12;           // padding
    const y0 = 16;
    const size = 16;         // heart UI size
    const gap  = 6;

    const maxH = player.maxHearts || 3;
    const seg  = (player.heartSegs==null) ? (maxH*3) : player.heartSegs;

    // strip behind hearts for contrast
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

  // simple “meter” heart: outline box with red-filled portion left-to-right
  function drawHeart(ctx, x, y, s, fillRatio){
    ctx.save();
    // outline (gives a pixel-art vibe without sprite)
    ctx.strokeStyle = '#d14a4a';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, s, s);

    // filled + empty portion
    const w = Math.floor(s * Math.max(0, Math.min(1, fillRatio)));
    if (w>0){ ctx.fillStyle = '#ff5555'; ctx.fillRect(x, y, w, s); }
    if (w<s){ ctx.fillStyle = '#3a3f4a'; ctx.fillRect(x+w, y, s-w, s); }
    ctx.restore();
  }

  // ---------- cop melee: 1 segment per 2s if in range ----------
  function attachCopMelee(){
    IZZA.on('update-post', ({now})=>{
      if(!api || !Array.isArray(cops)) return;
      const atkRange = 26;
      const cd = 2000; // ms
      for(const c of cops){
        if (c._nextAtk == null) c._nextAtk = now;
        const dist = Math.hypot(player.x - c.x, player.y - c.y);
        if (dist <= atkRange && now >= c._nextAtk){
          takeDamageSegs(1);         // -1 segment (3 hits = 1 heart)
          c._nextAtk = now + cd;
        }
      }
    });
  }

  // ---------- render overlay loop (post-core render) ----------
  function attachRenderOverlay(){
    function loop(){
      try{ drawHearts(); }catch(e){ /* don’t crash the game if overlay fails */ }
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
  }

  // ---------- wire up when core is ready ----------
  if (window.IZZA && IZZA.on){
    IZZA.on('ready', (coreApi)=>{
      api    = coreApi;
      player = api.player;
      cops   = api.cops;

      initHearts();
      attachCopMelee();
      attachRenderOverlay();

      // Optional: let other plugins know hearts exist
      IZZA.hearts = {
        getMax: ()=>player.maxHearts,
        setMax: (n)=>{ setMaxHearts(n); player.maxHearts=n; healFull(); },
        healFull,
        takeDamageSegs
      };
    });
  }else{
    console.warn('v4_hearts: hook bus not found. Make sure izza_core_v3.js is loaded first.');
  }
})();
