// safety_island_and_rescue.js
// - Blocks the unwanted "B → city dock" warp when on/near island land
// - Auto-teleports the player to HQ door if stuck/off-bounds/invisible
(function(){
  const TIER_KEY = 'izzaMapTier';

  function unlockedRect(t){ return (t!=='2') ? {x0:18,y0:18,x1:72,y1:42} : {x0:10,y0:12,x1:80,y1:50}; }
  function anchors(api){
    const tier = localStorage.getItem(TIER_KEY)||'1';
    const un = unlockedRect(tier);
    const bW=10,bH=6;
    const bX = Math.floor((un.x0+un.x1)/2) - Math.floor(bW/2);
    const bY = un.y0 + 5;
    const hRoadY       = bY + bH + 1;
    const sidewalkTopY = hRoadY - 1;
    const vRoadX       = Math.min(un.x1-3, bX + bW + 6);
    const door = { gx: bX + Math.floor(bW/2), gy: sidewalkTopY }; // HQ door (Tier-1)
    return {un, door, vRoadX, hRoadY, sidewalkTopY};
  }

  // --- Helper: get player grid coords quickly
  function pg(api){
    const t=api.TILE;
    return {
      gx: ((api.player.x+16)/t|0),
      gy: ((api.player.y+16)/t|0)
    };
  }

  // --- 1) Stop the “B at island sometimes → city dock” mis-detection
  // We capture B before other listeners. If you’re standing on island tiles
  // (or adjacent), we swallow the event so no city-dock warp handler can run.
  function nearIslandLand(api){
    try{
      if(!window._izzaIslandLand) return false;
      const {gx,gy} = pg(api);
      if (window._izzaIslandLand.has(gx+'|'+gy)) return true;
      // also treat 4-neighborhood as "near island"
      return (
        window._izzaIslandLand.has((gx-1)+'|'+gy) ||
        window._izzaIslandLand.has((gx+1)+'|'+gy) ||
        window._izzaIslandLand.has(gx+'|'+(gy-1)) ||
        window._izzaIslandLand.has(gx+'|'+(gy+1))
      );
    }catch{ return false; }
  }

  function swallowBIfOnIsland(e){
    try{
      const api = IZZA?.api;
      if(!api?.ready) return;
      if(nearIslandLand(api)){
        // If some other plugin relies on B here, DO NOT run it; we only block
        // the accidental city-dock handler by killing the event fully.
        e?.preventDefault?.();
        e?.stopImmediatePropagation?.();
        e?.stopPropagation?.();
      }
    }catch{}
  }

  // capture-phase → we beat everyone else
  document.getElementById('btnB')?.addEventListener('click', swallowBIfOnIsland, true);
  window.addEventListener('keydown', e=>{
    if ((e.key||'').toLowerCase()==='b') swallowBIfOnIsland(e);
  }, true);

  // --- 2) Auto-rescue if player gets stuck/invisible/under-map

  // Config is conservative; tweak if needed.
  const CHECK_MS        = 400;   // watchdog cadence
  const STUCK_SECONDS   = 4.5;   // how long with no real movement → rescue
  const MIN_MOVE_TILES  = 0.20;  // anything less is “not moving”
  const OFF_BOUNDS_PAD  = 2;     // small pad outside unlocked rect counts off-bounds

  // We track last *safe* spot (on-screen, in-bounds). If we go off-bounds or
  // don’t move for STUCK_SECONDS we teleport to HQ door (in front of it).
  let _lastPos   = { x:0, y:0, gx:0, gy:0, t:0 };
  let _lastSafe  = null;

  function now(){ return performance.now?.() || Date.now(); }

  function inWorldBounds(a, gx, gy){
    return gx >= (a.un.x0 - OFF_BOUNDS_PAD) &&
           gx <= (a.un.x1 + OFF_BOUNDS_PAD) &&
           gy >= (a.un.y0 - OFF_BOUNDS_PAD) &&
           gy <= (a.un.y1 + OFF_BOUNDS_PAD);
  }

  function distanceTiles(ax, ay, bx, by, tile){
    const dx = (ax - bx) / tile;
    const dy = (ay - by) / tile;
    return Math.hypot(dx, dy);
  }

  function closeOverlays(){
    // Best-effort: close common UIs that could be trapping input/visibility
    ['hospitalShop','bankUI','bigmapWrap','tradeModal'].forEach(id=>{
      const el = document.getElementById(id);
      if (el && el.style) el.style.display = 'none';
    });
    IZZA.inputBlocked = false;
  }

  function teleportToHQ(){
    try{
      const api = IZZA.api; if(!api?.ready) return;
      const A = anchors(api);
      const t = api.TILE;

      // South of the HQ door so you’re on the sidewalk, not *inside* the door
      const tx = (A.door.gx)*t;
      const ty = (A.door.gy+1)*t - 1;

      // Exit boat if somehow active
      if (window._izzaBoatActive) window._izzaBoatActive = false;

      // Restore player + camera; engine will reconcile camera on next tick anyway
      api.player.x = tx;
      api.player.y = ty;

      closeOverlays();

      // Toast + event hook for analytics if you want
      IZZA.toast?.('Oops, you got stuck — teleported to HQ!');
      try { window.dispatchEvent(new Event('izza-rescued')); } catch {}
    }catch(e){ console.warn('[rescue] teleport failed', e); }
  }

  function watchdog(){
    try{
      const api = IZZA?.api; if(!api?.ready) return;
      const t = api.TILE, A = anchors(api);
      const {gx,gy} = pg(api);

      // record lastSafe whenever squarely in world bounds
      if (inWorldBounds(A, gx, gy)){
        _lastSafe = { x: api.player.x, y: api.player.y, gx, gy, t: now() };
      }

      // Disappeared / NaN guard
      if (!isFinite(api.player.x) || !isFinite(api.player.y)){
        teleportToHQ(); return;
      }

      // Walked under map / off-bounds (common when collisions fail)
      if (!inWorldBounds(A, gx, gy)){
        teleportToHQ(); return;
      }

      // Invisible heuristic: DOM sprite hidden or tiny alpha (best effort)
      const sprite = document.getElementById('playerSprite') || document.querySelector('[data-player-sprite]');
      if (sprite && (sprite.style?.display==='none' || sprite.style?.visibility==='hidden' || Number(sprite.style?.opacity||'1') < 0.1)){
        teleportToHQ(); return;
      }

      // Not moving for a while (but input isn’t blocked by our UIs)
      const dTiles = distanceTiles(api.player.x, api.player.y, _lastPos.x, _lastPos.y, t);
      const dt = now() - _lastPos.t;
      const stale = (dTiles < MIN_MOVE_TILES) && (dt >= STUCK_SECONDS*1000);

      // If they’re “stale” or previously flagged bad, rescue
      if (stale){
        teleportToHQ(); return;
      }

      // advance lastPos
      _lastPos = { x: api.player.x, y: api.player.y, gx, gy, t: now() };

    }catch(e){ /* keep going next tick */ }
  }

  // Seed baselines fast after boot
  setTimeout(()=>{ try{
    if(!IZZA?.api?.ready) return;
    const {gx,gy} = pg(IZZA.api);
    _lastPos = { x: IZZA.api.player.x, y: IZZA.api.player.y, gx, gy, t: now() };
    _lastSafe = { x: IZZA.api.player.x, y: IZZA.api.player.y, gx, gy, t: now() };
  }catch{} }, 0);

  // Run watchdog on a timer (decoupled from render/update cadence)
  setInterval(watchdog, CHECK_MS);

  // Optional: expose manual rescue for QA
  window.IZZA_RESCUE = teleportToHQ;
})();
