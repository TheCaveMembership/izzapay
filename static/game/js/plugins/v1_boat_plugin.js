// v1.16 — Tier-2 boats beside dock (south), board-to-water snap, hide boarded boat,
//          clamp boating to lake rect, forbid walking on water in Tier 2,
//          docks are logically 3 tiles thick (y, y-1, y-2) to allow walking,
//          SVG boat rendering via Path2D.
(function(){
  const BUILD='v1.16-boat-plugin+tier2+svg';
  console.log('[IZZA PLAY]', BUILD);

  const TIER_KEY='izzaMapTier';
  const isTier2 = ()=> (localStorage.getItem(TIER_KEY)==='2');

  // Let layout/colliders know when we’re boating (your expander/layout can skip solids then)
  function setBoatFlag(on){ window._izzaBoatActive = !!on; }

  // --- local state ---
  let api=null;
  let inBoat=false;
  let ghostBoat=null;     // visual boat that follows player while inBoat
  let lastLand=null, lastWater=null;
  let claimedDockId=null; // which dock’s parked boat to hide after boarding

  // ====== geometry, anchored to the same unlock rect as your expander ======
  function unlockedRect(t){ return (t!=='2') ? {x0:18,y0:18,x1:72,y1:42} : {x0:10,y0:12,x1:80,y1:50}; }
  function anchors(a){
    const tier=localStorage.getItem(TIER_KEY)||'1';
    const un=unlockedRect(tier);
    const bW=10,bH=6;
    const bX = Math.floor((un.x0+un.x1)/2) - Math.floor(bW/2);
    const bY = un.y0 + 5;
    const hRoadY       = bY + bH + 1;
    const sidewalkTopY = hRoadY - 1;
    const vRoadX       = Math.min(un.x1-3, bX + bW + 6);
    return {un,bX,bY,bW,bH,hRoadY,sidewalkTopY,vRoadX};
  }
  function lakeRects(a){
    // Match your Tier-2 expander’s lake placement
    const LAKE = { x0: a.un.x1-14, y0: a.un.y0+23, x1: a.un.x1, y1: a.un.y1 };
    const BEACH_X = LAKE.x0 - 1; // vertical beach column
    const DOCKS = [
      { x0: LAKE.x0, y: LAKE.y0+4,  len: 3 },  // planks extend EAST (→)
      { x0: LAKE.x0, y: LAKE.y0+12, len: 4 }
    ];
    return {LAKE, BEACH_X, DOCKS};
  }

  // ====== helpers ======
  const T = ()=> api.TILE;
  const centerGX = ()=> ((api.player.x+16)/T()|0);
  const centerGY = ()=> ((api.player.y+16)/T()|0);
  const playerGrid = ()=> ({gx:centerGX(), gy:centerGY()});

  // Make the dock logically 3 tiles thick: y, y-1, y-2 (north of plank).
  // We intentionally DO NOT include y+1 (south) so the parked-boat tile stays water.
  function dockCells(){
    if(!api?.ready) return new Set();
    const {DOCKS}=lakeRects(anchors(api));
    const s=new Set();
    DOCKS.forEach(d=>{
      for(let i=0;i<d.len;i++){
        const gx = d.x0+i;
        s.add(gx+'|'+(d.y));      // plank row
        s.add(gx+'|'+(d.y-1));    // widen north
        s.add(gx+'|'+(d.y-2));    // widen north again (3-wide)
      }
    });
    return s;
  }

  // WATER is ONLY inside the LAKE rectangle; planks (incl. widened rows) are NOT water.
  function tileIsWater(gx,gy){
    const a=anchors(api);
    const {LAKE}=lakeRects(a);
    const insideLake = (gx>=LAKE.x0 && gx<=LAKE.x1 && gy>=LAKE.y0 && gy<=LAKE.y1);
    if(!insideLake) return false;
    if(dockCells().has(gx+'|'+gy)) return false;
    return true;
  }

  // 4-corner helpers
  function cornersGrid(){
    const t=T(), p=api.player;
    return [
      {x:((p.x+1)/t)|0,  y:((p.y+1)/t)|0},
      {x:((p.x+31)/t)|0, y:((p.y+1)/t)|0},
      {x:((p.x+1)/t)|0,  y:((p.y+31)/t)|0},
      {x:((p.x+31)/t)|0, y:((p.y+31)/t)|0}
    ];
  }
  function allCornersWater(){ return cornersGrid().every(c=> tileIsWater(c.x,c.y)); }
  function anyCornerWater(){  return cornersGrid().some(c => tileIsWater(c.x,c.y)); }
  function centerOnDock(){
    const {gx,gy}=playerGrid();
    return dockCells().has(gx+'|'+gy);
  }

  // ====== parked-boat spot: SOUTH of the dock, centered on planks ======
  function parkedSpotForDock(d){
    const mid = d.x0 + Math.max(1, Math.floor(d.len/2));
    return { gx: mid, gy: d.y + 1 }; // stays water (we didn’t add y+1 to dockCells)
  }

  function dockByYBand(y){
    const {DOCKS}=lakeRects(anchors(api));
    // Consider a small vertical band so widened rows still resolve to this dock
    return DOCKS.find(d => Math.abs(y - d.y) <= 2) || null;
  }

  // Best land tile to snap to when leaving the boat
  function nearestDisembarkSpot(){
    const a=anchors(api), {LAKE,BEACH_X}=lakeRects(a);
    const gx=centerGX(), gy=centerGY();
    const docks=dockCells();

    // prefer adjacent dock (N,E,S,W)
    const n=[{x:gx+1,y:gy},{x:gx-1,y:gy},{x:gx,y:gy+1},{x:gx,y:gy-1}];
    for(const p of n) if(docks.has(p.x+'|'+p.y)) return p;

    // if right beside beach (only where sand exists), snap onto beach column
    if(gx===BEACH_X+1 && gy>=LAKE.y0 && gy<=LAKE.y1) return {x:BEACH_X, y:gy};

    // if already on dock somehow
    if(docks.has(gx+'|'+gy)) return {x:gx,y:gy};

    return null;
  }

  // ====== boarding / leaving ======
  function canBoardHere(){
    if(!api?.ready || !isTier2()) return false; // boats only exist in Tier 2 (lake exists only in T2)
    const {gx,gy}=playerGrid();
    const docks=dockCells();
    if(docks.has(gx+'|'+gy)) return true; // on dock
    return docks.has((gx+1)+'|'+gy) || docks.has((gx-1)+'|'+gy) ||
           docks.has(gx+'|'+(gy+1)) || docks.has(gx+'|'+(gy-1));
  }

  function tryBoard(){
    if(inBoat || !isTier2() || !canBoardHere()) return false;

    // Snap to the water tile SOUTH of the dock (the parked spot) before boating
    const d = dockByYBand(centerGY());
    if(d){
      const spot = parkedSpotForDock(d);
      api.player.x = (spot.gx*T()) + 1;
      api.player.y = (spot.gy*T()) + 1;
      lastWater = { x: api.player.x, y: api.player.y };
      claimedDockId = d.y; // hide this dock’s parked boat
    }else{
      claimedDockId = null;
      lastWater = { x: api.player.x, y: api.player.y };
    }

    inBoat = true;
    setBoatFlag(true);
    ghostBoat = { x: api.player.x, y: api.player.y };
    api.player.speed = 120;
    IZZA.toast?.('Boarded boat');
    return true;
  }

  function tryDisembark(){
    if(!inBoat) return false;
    const spot = nearestDisembarkSpot();
    if(!spot) return false;

    api.player.x = (spot.x*T()) + 1;
    api.player.y = (spot.y*T()) + 1;

    inBoat=false;
    setBoatFlag(false);
    ghostBoat=null;
    api.player.speed = 90;
    claimedDockId=null;
    IZZA.toast?.('Disembarked');
    return true;
  }

  // ====== input (B) ======
  function onB(e){
    if(!api?.ready || !isTier2()) return;
    const shouldHandle = inBoat || canBoardHere();
    if(!shouldHandle) return;

    const acted = inBoat ? tryDisembark() : tryBoard();
    if(acted){
      e?.preventDefault?.(); e?.stopPropagation?.(); e?.stopImmediatePropagation?.();
    }
  }

  // ====== movement clamps ======
  IZZA.on('update-pre', ()=>{
    if(!api?.ready || !isTier2()) return;
    const p=api.player;

    if(inBoat){
      if(allCornersWater()){ lastWater={x:p.x,y:p.y}; }
      else if(lastWater){ p.x=lastWater.x; p.y=lastWater.y; }
      if(ghostBoat){ ghostBoat.x=p.x; ghostBoat.y=p.y; }
    }else{
      // Block water unless you're centered on any of the widened dock tiles
      if(anyCornerWater() && !centerOnDock()){
        if(lastLand){ p.x=lastLand.x; p.y=lastLand.y; }
      }else{
        lastLand={x:p.x,y:p.y};
      }
    }
  });

  // Also clamp in update-post for extra safety with other plugins
  function postClamp(){
    if(!api?.ready || !isTier2()) return;
    const p=api.player;
    if(inBoat){
      if(allCornersWater()){ lastWater={x:p.x,y:p.y}; }
      else if(lastWater){ p.x=lastWater.x; p.y=lastWater.y; }
      if(ghostBoat){ ghostBoat.x=p.x; ghostBoat.y=p.y; }
    }else{
      if(anyCornerWater() && !centerOnDock()){
        if(lastLand){ p.x=lastLand.x; p.y=lastLand.y; }
      }else{
        lastLand={x:p.x,y:p.y};
      }
    }
  }
  setTimeout(()=> IZZA.on('update-post', postClamp), 0);

  // ====== visuals ======
  // SVG boat path (simple skiff with bow). Drawn with Path2D on canvas.
  // Coordinates normalized in a ~100x60 box and scaled to tile size.
  const BOAT_PATH_D = "M5,40 L25,18 L75,18 L95,40 L75,58 L25,58 Z M25,18 L35,8 L65,8 L75,18 Z";
  let BOAT_PATH = null;

  function ensureBoatPath(){
    if (!BOAT_PATH) {
      try {
        BOAT_PATH = new Path2D(BOAT_PATH_D);
      } catch (e) {
        // Fallback: construct path via Canvas commands if Path2D SVG ctor not supported
        const p = new Path2D();
        p.moveTo(5,40); p.lineTo(25,18); p.lineTo(75,18); p.lineTo(95,40); p.lineTo(75,58); p.lineTo(25,58); p.closePath();
        p.moveTo(25,18); p.lineTo(35,8); p.lineTo(65,8); p.lineTo(75,18); p.closePath();
        BOAT_PATH = p;
      }
    }
  }

  function drawBoat(ctx, sx, sy, size){
    // size ~ tile in screen px
    ensureBoatPath();
    ctx.save();
    ctx.translate(sx, sy);
    const scale = size / 64; // nice scale relative to tile
    ctx.scale(scale, scale);
    ctx.translate(-32, -32); // center path
    // Hull
    ctx.fillStyle = '#6b4a2f';
    ctx.fill(BOAT_PATH);
    // Rim / outline
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.stroke(BOAT_PATH);
    // Deck highlight
    ctx.globalAlpha = 0.2;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(20,22,60,10);
    ctx.restore();
  }

  function drawParkedDockBoats(ctx){
    const {DOCKS}=lakeRects(anchors(api));
    const S=api.DRAW, t=T();

    DOCKS.forEach(d=>{
      if(inBoat && claimedDockId===d.y) return; // hide the boat we took
      const spot = parkedSpotForDock(d);        // SOUTH (under plank)
      const sx = (spot.gx*t - api.camera.x) * (S/t) + S*0.5;
      const sy = (spot.gy*t - api.camera.y) * (S/t) + S*0.62;
      drawBoat(ctx, sx, sy, S*0.90);
    });
  }

  IZZA.on('render-post', ()=>{
    if(!api?.ready || !isTier2()) return;
    const ctx=document.getElementById('game').getContext('2d');
    drawParkedDockBoats(ctx);

    if(inBoat && ghostBoat){
      const S=api.DRAW, t=T();
      const sx=(ghostBoat.x - api.camera.x)*(S/t) + S*0.5;
      const sy=(ghostBoat.y - api.camera.y)*(S/t) + S*0.62;
      drawBoat(ctx, sx, sy, S*0.90);
    }
  });

  // ====== boot ======
  IZZA.on('ready', (a)=>{
    api=a;
    const btnB=document.getElementById('btnB'); btnB?.addEventListener('click', onB, true);
    window.addEventListener('keydown', e=>{ if((e.key||'').toLowerCase()==='b') onB(e); }, {passive:false, capture:true});
    setBoatFlag(false);
    console.log('[boat] ready', BUILD);
  });
})();
