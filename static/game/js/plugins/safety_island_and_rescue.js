// v3 — island docking shim + HQ rescue
(function(){
  const TAG='[island-dock+rescue]';
  const log=(...a)=>{ try{ console.log(TAG, ...a);}catch{} };

  const getAPI = ()=> (window.IZZA && IZZA.api && IZZA.api.ready) ? IZZA.api : null;
  const gxOf = (api)=> ((api.player.x + 16)/api.TILE|0);
  const gyOf = (api)=> ((api.player.y + 16)/api.TILE|0);

  // ---------- ISLAND EDGE TEST ----------
  function nearIslandEdge(api){
    const S = window._izzaIslandLand;
    if(!S || !S.size) return null;
    const gx=gxOf(api), gy=gyOf(api);

    // if you're in water, check a 1-tile ring for land = a shoreline spot to drop onto
    let target=null;
    for(let dy=-1; dy<=1; dy++){
      for(let dx=-1; dx<=1; dx++){
        const key=(gx+dx)+'|'+(gy+dy);
        if(S.has(key)){ target = {gx:gx+dx, gy:gy+dy}; break; }
      }
      if(target) break;
    }
    return target; // null if not adjacent to island land
  }

  // ---------- B INTERCEPTOR (capture) ----------
  function onB(ev){
    const api=getAPI(); if(!api) return;
    // only care when boating
    if(!window._izzaBoatActive) return;

    const t = nearIslandEdge(api);
    if(!t) return;

    // We are boating and adjacent to island land: undock here, not at city.
    ev?.preventDefault?.(); ev?.stopImmediatePropagation?.(); ev?.stopPropagation?.();

    try{
      // place the player cleanly on the target land tile
      const T=api.TILE;
      api.player.x = t.gx * T;
      api.player.y = t.gy * T;

      // turn boat OFF (your water collision guard uses this flag)
      window._izzaBoatActive = false;

      // let anyone else know we docked locally
      try{ window.dispatchEvent(new Event('izza-boat-off')); }catch{}

      // small feedback
      if(window.IZZA?.toast) IZZA.toast('Docked at island');
      log('Docked at island @', t.gx, t.gy);
    }catch(e){ log('dock fail',e); }
  }

  function armB(){
    const btnB = document.getElementById('btnB');
    if(btnB){
      // capture so we preempt boat’s default B handler that would snap to city dock
      btnB.addEventListener('click', onB, true);
    }
    window.addEventListener('keydown', e=>{
      if((e.key||'').toLowerCase()==='b') onB(e);
    }, true);
  }

  // ---------- STUCK RESCUE WATCHER ----------
  // Teleport to HQ door if position is invalid/off-grid or motionless in a bad spot for >2s
  function hqDoor(){
    try{
      const tier = localStorage.getItem('izzaMapTier')||'1';
      const un=(tier!=='2')?{x0:18,y0:18,x1:72,y1:42}:{x0:10,y0:12,x1:80,y1:50};
      const bW=10,bH=6;
      const bX = Math.floor((un.x0+un.x1)/2)-Math.floor(bW/2);
      const bY = un.y0 + 5;
      const hRoadY = bY + bH + 1;
      return { gx: bX + Math.floor(bW/2), gy: hRoadY - 1 };
    }catch{ return {gx:45,gy:28}; }
  }
  function teleportToHQ(){
    const api=getAPI(); if(!api) return;
    const d=hqDoor(), T=api.TILE;
    api.player.x = d.gx * T;
    api.player.y = d.gy * T;
    window._izzaBoatActive = false;
    if(window.IZZA?.toast) IZZA.toast('Oops, you got stuck — back to HQ!');
    try{ window.dispatchEvent(new Event('izza-rescued')); }catch{}
    log('Rescued to HQ @', d.gx, d.gy);
  }

  let lastGood={x:0,y:0,t:0};
  const WAIT_MS=2000;

  IZZA?.on?.('update-post', ()=>{
    const api=getAPI(); if(!api) return;
    const gx=gxOf(api), gy=gyOf(api);

    // screen/world bounds (90×60 grid in your overlay painter)
    const offGrid = (gx<0 || gx>89 || gy<0 || gy>59);

    // illegal water-on-foot: if not boating and standing on water (that’s never allowed by your rules)
    const onWaterFoot = (!window._izzaBoatActive) && (function(){
      // reuse your lake bounds if available
      const L = (window.__IZZA_LAST_LAYOUT__ && window.__IZZA_LAST_LAYOUT__.LAKE) || null;
      if(!L) return false;
      const inLake = (gx>=L.x0 && gx<=L.x1 && gy>=L.y0 && gy<=L.y1);
      if(!inLake) return false;
      // island tiles are allowed (not water visually, but painted over water); treat island set as safe
      if(window._izzaIslandLand && window._izzaIslandLand.has(gx+'|'+gy)) return false;
      return true;
    })();

    // motion check (don’t trigger while actually moving)
    const px = api.player.x|0, py = api.player.y|0, now = performance.now?.()||Date.now();
    const sameSpot = (px===lastGood.x && py===lastGood.y);

    if(!offGrid && !onWaterFoot && !sameSpot){
      lastGood = {x:px, y:py, t:now};
      return;
    }

    // wait a bit in a bad state, then rescue
    const since = now - lastGood.t;
    if(since >= WAIT_MS){
      teleportToHQ();
      lastGood = {x:api.player.x|0, y:api.player.y|0, t:performance.now?.()||Date.now()};
    }
  });

  // Arm once DOM is ready enough to find B
  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', armB, {once:true});
  } else {
    armB();
  }

  log('armed');
})();
