(function(){
  if (!window.IZZA) return;

  // --- tiny utils ---
  const api = () => IZZA.api;
  const TILE_SAFE_OFFSET = 1; // step onto land
  const Z_HUD = 99999;

  function clampToWorld(gx, gy){
    const a = api(); if (!a) return {gx, gy};
    const maxX = (a.gridW||90) - 1, maxY = (a.gridH||60) - 1;
    if (gx < 0) gx = 0; else if (gx > maxX) gx = maxX;
    if (gy < 0) gy = 0; else if (gy > maxY) gy = maxY;
    return {gx, gy};
  }

  function gridOfPlayer(){
    const a = api(); if (!a) return {gx:0, gy:0};
    const t = a.TILE;
    return { gx: ((a.player.x+16)/t|0), gy: ((a.player.y+16)/t|0) };
  }

  function isIslandLand(gx,gy){
    const s = window._izzaIslandLand;
    return !!(s && s.has && s.has(gx+'|'+gy));
  }

  function isWater(gx,gy){
    // Prefer the same logic boat/collisions use: inside LAKE but not beach/dock or island land
    const a = api(); if (!a || !window.__IZZA_LAST_LAYOUT__?.LAKE) return false;
    const L = window.__IZZA_LAST_LAYOUT__.LAKE;
    if (gx < L.x0 || gx > L.x1 || gy < L.y0 || gy > L.y1) return false;
    if (isIslandLand(gx,gy)) return false;
    // treat docks + beach as not-water to allow walking there
    const beachX = window.__IZZA_LAST_LAYOUT__?.BEACH_X;
    if (typeof beachX === 'number' && gx === beachX) return false;
    const docks = (typeof window.dockCells === 'function') ? window.dockCells() : null;
    if (docks && docks.has(gx+'|'+gy)) return false;
    return true;
  }

  function neighbors4(gx,gy){
    return [
      {gx:gx+1,gy},{gx:gx-1,gy},{gx,gy:gy+1},{gx,gy:gy-1}
    ];
  }

  // Find a safe island tile near current pos: water cell touching island → choose the land cell, step inward
  function findIslandDockTarget(fromGX, fromGY){
    // If player is in water right next to island land, pick that land cell
    const ns = neighbors4(fromGX, fromGY);
    for (const n of ns){
      if (isIslandLand(n.gx,n.gy)){
        // step 1 more tile inward from the shoreline so we don't sit on the border
        // choose inward by repeating the same direction from water->land
        const dx = n.gx - fromGX, dy = n.gy - fromGY;
        let tx = n.gx + Math.sign(dx)*TILE_SAFE_OFFSET;
        let ty = n.gy + Math.sign(dy)*TILE_SAFE_OFFSET;
        // If both dx & dy are 0 (shouldn’t) or we’re on a corner, just stay on n
        if (dx===0 && dy===0){ tx=n.gx; ty=n.gy; }
        // Clamp inside world
        const c = clampToWorld(tx,ty);
        return c;
      }
    }
    // If player is already on land (island) but next to water, just keep current cell
    if (isIslandLand(fromGX,fromGY)) return clampToWorld(fromGX,fromGY);
    return null;
  }

  // --- Intercept B while boating near island so city fallback doesn't run ---
  function onPressBIslandFirst(ev){
    try{
      const a = api(); if (!a || !a.ready) return;
      if (!window._izzaBoatActive) return;         // only care when boating
      const {gx,gy} = gridOfPlayer();

      // Only trigger if we are in/at water *touching island land*
      if (!isWater(gx,gy)) return;
      const target = findIslandDockTarget(gx,gy);
      if (!target) return;                          // not an island edge → let core handlers run

      // We ARE at island edge: stop other handlers (prevents city fallback)
      ev?.preventDefault?.(); ev?.stopImmediatePropagation?.(); ev?.stopPropagation?.();

      // Exit boat and place on island safely
      window._izzaBoatActive = false;
      const t = a.TILE;
      a.player.x = (target.gx + 0.05) * t;
      a.player.y = (target.gy + 0.05) * t;

      // Nudge camera and let collisions settle
      a.camera.x = Math.max(0, a.player.x - a.DRAW*2);
      a.camera.y = Math.max(0, a.player.y - a.DRAW*1.5);

      // Little feedback
      IZZA.toast?.('Docked at island');
    }catch(e){ console.warn('[island-dock] failed', e); }
  }

  // Capture-phase B (keyboard + on-screen button)
  document.getElementById('btnB')?.addEventListener('click', onPressBIslandFirst, true);
  window.addEventListener('keydown', e=>{
    if ((e.key||'').toLowerCase()==='b') onPressBIslandFirst(e);
  }, true);

  // --- Stuck watchdog + rescue ---
  let lastX=NaN, lastY=NaN, stillTicks=0, rescueShown=false;
  const STILL_LIMIT = 60; // ~1s @60fps

  function ensureRescueUI(){
    if (document.getElementById('stuckRescue')) return;
    const d=document.createElement('div');
    d.id='stuckRescue';
    d.style.cssText =
      `position:fixed;inset:0;display:none;align-items:center;justify-content:center;`+
      `background:rgba(0,0,0,.55);z-index:${Z_HUD};`;
    d.innerHTML =
      `<div style="min-width:260px;background:#111b29;border:1px solid #2b3b57;border-radius:10px;padding:14px;color:#e7eef7;box-shadow:0 10px 30px rgba(0,0,0,.5)">
         <strong style="font-size:16px">Oops — you got stuck</strong>
         <div style="opacity:.9;margin:8px 0 12px">We’ll teleport you to the HQ door.</div>
         <div style="display:flex;gap:8px;justify-content:flex-end">
           <button id="stuckCancel" style="background:#263447;color:#cfe3ff;border:0;border-radius:6px;padding:6px 10px;cursor:pointer">Cancel</button>
           <button id="stuckGo" style="background:#1f6feb;color:#fff;border:0;border-radius:6px;padding:6px 10px;cursor:pointer">Teleport</button>
         </div>
       </div>`;
    document.body.appendChild(d);
    d.querySelector('#stuckCancel').onclick = ()=>{ d.style.display='none'; rescueShown=false; };
    d.querySelector('#stuckGo').onclick = ()=>{ rescueShown=false; d.style.display='none'; goHQ(); };
  }

  function goHQ(){
    try{
      const a = api(); if (!a) return;
      // Recreate anchors’ HQ door (same math used by your expander)
      const tier = localStorage.getItem('izzaMapTier')||'1';
      const un = (tier!=='2') ? {x0:18,y0:18,x1:72,y1:42} : {x0:10,y0:12,x1:80,y1:50};
      const bW=10,bH=6;
      const bX = Math.floor((un.x0+un.x1)/2) - Math.floor(bW/2);
      const bY = un.y0 + 5;
      const hRoadY = bY + bH + 1;
      const sidewalkTopY = hRoadY - 1;
      const doorGX = bX + Math.floor(bW/2);
      const doorGY = sidewalkTopY;
      const t = a.TILE;
      a.player.x = (doorGX + 0.1)*t;
      a.player.y = (doorGY + 0.1)*t;
      window._izzaBoatActive = false;
      IZZA.toast?.('Teleported to HQ');
    }catch(e){ console.warn('[rescue] failed', e); }
  }

  IZZA.on('update-post', ()=>{
    const a = api(); if (!a || !a.ready) return;

    // 1) off-canvas right/edge invisibility (camera shows nothing because player beyond world)
    const {gx,gy} = gridOfPlayer();
    const world = clampToWorld(1e9,1e9); // read max from clamp util
    const offRight = gx >= world.gx;     // gx == maxX means border
    const offBottom= gy >= world.gy;

    // 2) on water while not boating
    const onWaterOnFoot = (!window._izzaBoatActive && isWater(gx,gy));

    // 3) hasn’t moved visibly
    const px = a.player.x|0, py = a.player.y|0;
    if (px === (lastX|0) && py === (lastY|0)) stillTicks++; else stillTicks=0;
    lastX = px; lastY = py;

    const STUCK = onWaterOnFoot || offRight || offBottom || (stillTicks > STILL_LIMIT);

    if (STUCK && !rescueShown){
      ensureRescueUI();
      const el = document.getElementById('stuckRescue');
      // Make sure modal works even if the game blocked input
      const prev = IZZA.inputBlocked;
      IZZA.inputBlocked = false;
      el.style.display='flex';
      rescueShown = true;
      // restore block when closed
      const restore = ()=>{ IZZA.inputBlocked = prev; };
      el.addEventListener('click', restore, {once:true, capture:true});
    }
  });

  // Optional: expose LAKE rect so this plugin can be robust (your expander already does this in many builds)
  window.__IZZA_LAST_LAYOUT__ = window.__IZZA_LAST_LAYOUT__ || {};
})();
