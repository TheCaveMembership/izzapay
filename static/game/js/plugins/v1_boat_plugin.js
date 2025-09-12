// v1.18 — Boat plugin: beach docking (island + city), 1/2-tile proximity snap,
//          island sand treated as land, rescue if stranded in water.
(function(){
  const BUILD='v1.18-boat-plugin+tier2+svg+dockless-island+rescue';
  console.log('[IZZA PLAY]', BUILD);

  const TIER_KEY='izzaMapTier';
  const isTier2 = ()=> (localStorage.getItem(TIER_KEY)==='2');

  function setBoatFlag(on){ window._izzaBoatActive = !!on; }

  // --- local state ---
  let api=null;
  let inBoat=false;
  let ghostBoat=null;
  let lastLand=null, lastWater=null;
  let claimedDockId=null;
  let waterStrandSince = 0;   // ms timestamp when we noticed being in water out of boat
  let rescueShown = false;    // gate rescue dialog

  // ====== geometry ======
  function unlockedRect(t){ return (t!=='2') ? {x0:18,y0:18,x1:72,y1:42} : {x0:10,y0:12,x1:80,y1:50}; }
  function anchors(){
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
    // City lake placement
    const LAKE = { x0: a.un.x1-14, y0: a.un.y0+23, x1: a.un.x1, y1: a.un.y1 };
    const BEACH_X = LAKE.x0 - 1; // vertical beach column (city side)
    const DOCKS = [
      { x0: LAKE.x0, y: LAKE.y0+4,  len: 3 },
      { x0: LAKE.x0, y: LAKE.y0+12, len: 4 }
    ];
    return {LAKE, BEACH_X, DOCKS};
  }

  const T = ()=> api.TILE;
  const centerGX = ()=> ((api.player.x+16)/T()|0);
  const centerGY = ()=> ((api.player.y+16)/T()|0);

  function dockCells(){
    if(!api?.ready) return new Set();
    const {DOCKS}=lakeRects(anchors());
    const s=new Set();
    DOCKS.forEach(d=>{
      for(let i=0;i<d.len;i++){
        const gx = d.x0+i;
        s.add(gx+'|'+(d.y));
        s.add(gx+'|'+(d.y-1));
        s.add(gx+'|'+(d.y-2));
      }
    });
    return s;
  }

  // Treat only LAKE interior (minus docks and any published island land) as water
  function tileIsWater(gx,gy){
    const {LAKE}=lakeRects(anchors());
    const insideLake = (gx>=LAKE.x0 && gx<=LAKE.x1 && gy>=LAKE.y0 && gy<=LAKE.y1);
    if(!insideLake) return false;

    // island land is NOT water (published by mission plugin)
    if (window._izzaIslandLand && window._izzaIslandLand.has(gx+'|'+gy)) return false;

    // city docks (including widened rows) are not water for movement checks
    if (dockCells().has(gx+'|'+gy)) return false;

    return true;
  }
  const isLand = (gx,gy)=> !tileIsWater(gx,gy);

  // corners
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
    const gx=centerGX(), gy=centerGY();
    return dockCells().has(gx+'|'+gy);
  }

  // city parked spot helper
  function parkedSpotForDock(d){
    const mid = d.x0 + Math.max(1, Math.floor(d.len/2));
    return { gx: mid, gy: d.y + 1 };
  }
  function dockByYBand(y){
    const {DOCKS}=lakeRects(anchors());
    return DOCKS.find(d => Math.abs(y - d.y) <= 2) || null;
  }

  // === NEW: generalized land-adjacent search for disembarking ===
  function nearestDisembarkSpot(halfTileSnap=true){
    const {LAKE,BEACH_X}=lakeRects(anchors());
    const gx=centerGX(), gy=centerGY();

    // 1) direct neighbors (N/E/S/W) that are land
    const primary = [{x:gx+1,y:gy},{x:gx-1,y:gy},{x:gx,y:gy+1},{x:gx,y:gy-1}];
    for(const p of primary){ if(isLand(p.x,p.y)) return p; }

    // 2) diagonals as a fallback (close enough to count as 1/2-tile proximity)
    const diag = [{x:gx+1,y:gy+1},{x:gx+1,y:gy-1},{x:gx-1,y:gy+1},{x:gx-1,y:gy-1}];
    for(const p of diag){ if(isLand(p.x,p.y)) return p; }

    // 3) explicit city beach snap if right beside water at beach column
    if(gx===BEACH_X+1 && gy>=LAKE.y0 && gy<=LAKE.y1) return {x:BEACH_X, y:gy};

    if(!halfTileSnap) return null;

    // 4) 1/2-tile proximity: look in a 2-tile Chebyshev ring for the closest land
    let best=null, bestD=1e9;
    for(let dy=-2; dy<=2; dy++){
      for(let dx=-2; dx<=2; dx++){
        if(dx===0 && dy===0) continue;
        const x=gx+dx, y=gy+dy;
        if(isLand(x,y)){
          const d = Math.max(Math.abs(dx), Math.abs(dy)); // Chebyshev
          if(d < bestD){ bestD=d; best={x,y}; }
        }
      }
    }
    return best; // might be null
  }

  // ====== boarding / leaving ======
  function canBoardHere(){
    if(!api?.ready || !isTier2()) return false;
    const gx=centerGX(), gy=centerGY();
    const docks=dockCells();

    // On a dock or adjacent to one → OK
    if(docks.has(gx+'|'+gy)) return true;
    if(docks.has((gx+1)+'|'+gy) || docks.has((gx-1)+'|'+gy) ||
       docks.has(gx+'|'+(gy+1)) || docks.has(gx+'|'+(gy-1))) return true;

    // NEW: also allow boarding from any land next to lake water (beach edge or island sand)
    // (standing on land and touching water)
    if(!tileIsWater(gx,gy)){ // on land
      const n=[{x:gx+1,y:gy},{x:gx-1,y:gy},{x:gx,y:gy+1},{x:gx,y:gy-1}];
      if(n.some(p=>tileIsWater(p.x,p.y))) return true;
    }
    return false;
  }

  function tryBoard(){
    if(inBoat || !isTier2() || !canBoardHere()) return false;

    // If by a city dock, snap to the standard parked spot first
    const d = dockByYBand(centerGY());
    if(d){
      const spot = parkedSpotForDock(d);
      api.player.x = (spot.gx*T()) + 1;
      api.player.y = (spot.gy*T()) + 1;
      lastWater = { x: api.player.x, y: api.player.y };
      claimedDockId = d.y;
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
    // NEW: allow disembark against island sand or city beach/dock, with 1/2-tile snap
    const spot = nearestDisembarkSpot(/*halfTileSnap=*/true);
    if(!spot) return false;

    api.player.x = (spot.x*T()) + 1;
    api.player.y = (spot.y*T()) + 1;

    inBoat=false;
    setBoatFlag(false);
    ghostBoat=null;
    api.player.speed = 90;
    claimedDockId=null;
    IZZA.toast?.('Disembarked');
    // reset water strand watchdog
    waterStrandSince = 0;
    rescueShown = false;
    return true;
  }

  // ====== input (B) ======
  function onB(e){
    if(!api?.ready || !isTier2()) return;
    const shouldHandle = inBoat || canBoardHere();
    if(!shouldHandle) return; // pressing B in open water does nothing (by design)

    const acted = inBoat ? tryDisembark() : tryBoard();
    if(acted){
      e?.preventDefault?.(); e?.stopPropagation?.(); e?.stopImmediatePropagation?.();
    }
  }

  // ====== RESCUE if stranded in water out of boat ======
  function showRescue(cb){
    if(rescueShown) return;
    rescueShown = true;
    const m=document.createElement('div');
    m.className='modal'; m.style.display='flex';
    m.innerHTML=`
      <div class="backdrop"></div>
      <div class="card" style="min-width:280px;max-width:520px">
        <h3>💦 Oops!</h3>
        <div style="line-height:1.5">
          You’ve fallen into the water. Click OK to be brought back to shore.
        </div>
        <div class="row" style="margin-top:10px"><button class="ghost" id="ok">OK</button></div>
      </div>`;
    document.body.appendChild(m);
    const close=()=>{ m.remove(); };
    m.querySelector('.backdrop').addEventListener('click', close, {passive:true});
    m.querySelector('#ok').addEventListener('click', ()=>{ try{ cb?.(); }finally{ close(); } }, {passive:true});
  }
  function rescueToShore(){
    const {LAKE,BEACH_X}=lakeRects(anchors());
    let gy = centerGY();
    gy = Math.max(LAKE.y0, Math.min(LAKE.y1, gy));
    // Prefer city beach column
    api.player.x = (BEACH_X*T()) + 1;
    api.player.y = (gy*T()) + 1;
    lastLand = { x: api.player.x, y: api.player.y };
    lastWater = null;
    IZZA.toast?.('Back on shore');
  }

  // ====== movement clamps ======
  IZZA.on('update-pre', ()=>{
    if(!api?.ready || !isTier2()) return;
    const p=api.player;

    if(inBoat){
      if(allCornersWater()){ lastWater={x:p.x,y:p.y}; }
      else if(lastWater){ p.x=lastWater.x; p.y=lastWater.y; }
      if(ghostBoat){ ghostBoat.x=p.x; ghostBoat.y=p.y; }
      // when boating, no rescue timer
      waterStrandSince = 0;
    }else{
      // Land walking: block water
      if(anyCornerWater() && !centerOnDock()){
        if(lastLand){ p.x=lastLand.x; p.y=lastLand.y; }
        // Start/continue watchdog if somehow stuck in water (no valid lastLand)
        if(!lastLand && allCornersWater()){
          if(!waterStrandSince) waterStrandSince = performance.now();
        }else{
          waterStrandSince = 0;
        }
      }else{
        lastLand={x:p.x,y:p.y};
        waterStrandSince = 0;
      }

      // If really in water out of boat for >300ms, offer rescue
      if(!inBoat && allCornersWater()){
        if(!waterStrandSince) waterStrandSince = performance.now();
        const dt = performance.now() - waterStrandSince;
        if(dt > 300 && !rescueShown){
          showRescue(rescueToShore);
        }
      }
    }
  });

  // Also clamp in update-post for extra safety
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

  // ====== visuals (unchanged) ======
  let prevBoatDraw = null;
  let lastWakeAt = 0;
  function makeHullPath(){ const p=new Path2D(); p.moveTo(6,38); p.quadraticCurveTo(22,16,50,10); p.quadraticCurveTo(78,16,94,38); p.quadraticCurveTo(78,60,50,66); p.quadraticCurveTo(22,60,6,38); p.closePath(); return p; }
  function makeDeckInset(){ const p=new Path2D(); p.moveTo(16,38); p.quadraticCurveTo(30,22,50,18); p.quadraticCurveTo(70,22,84,38); p.quadraticCurveTo(70,55,50,58); p.quadraticCurveTo(30,55,16,38); p.closePath(); return p; }
  function makeWindshield(){ const p=new Path2D(); p.moveTo(32,28); p.quadraticCurveTo(50,20,68,28); p.lineTo(66,32); p.quadraticCurveTo(50,25,34,32); p.closePath(); return p; }
  function makeStripe(){ const p=new Path2D(); p.moveTo(48,14); p.lineTo(52,14); p.lineTo(78,22); p.lineTo(74,24); p.lineTo(48,16); p.closePath(); return p; }
  function makeMotorCap(){ const p=new Path2D(); p.moveTo(40,60); p.quadraticCurveTo(50,64,60,60); p.quadraticCurveTo(50,62,40,60); p.closePath(); return p; }
  const HULL_PATH=makeHullPath(), DECK_INSET=makeDeckInset(), WINDSHIELD=makeWindshield(), STRIPE=makeStripe(), MOTOR_CAP=makeMotorCap();

  function drawLuxuryBoat(ctx, sx, sy, size, moving){
    ctx.save();
    const t = performance.now() * 0.001;
    const bob = Math.sin(t * 2.4) * (moving ? 0.8 : 1.2);
    ctx.translate(sx, sy + bob);
    const scale = size / 72; ctx.scale(scale, scale); ctx.translate(-50, -38);

    ctx.save(); ctx.translate(2, 5); ctx.fillStyle='rgba(0,0,0,0.18)'; ctx.filter='blur(1.2px)'; ctx.fill(HULL_PATH); ctx.restore(); ctx.filter='none';

    const hullGrad = ctx.createLinearGradient(20,12,80,62);
    hullGrad.addColorStop(0.0, '#263238'); hullGrad.addColorStop(0.5, '#37474F'); hullGrad.addColorStop(1.0, '#212121');
    ctx.fillStyle = hullGrad; ctx.fill(HULL_PATH);
    ctx.lineWidth = 1.8; ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.stroke(HULL_PATH);

    const deckGrad = ctx.createLinearGradient(28,22,72,56);
    deckGrad.addColorStop(0.0, '#8D6E63'); deckGrad.addColorStop(1.0, '#5D4037');
    ctx.fillStyle = deckGrad; ctx.fill(DECK_INSET);

    ctx.lineWidth = 2.2; ctx.strokeStyle = '#B0BEC5'; ctx.stroke(DECK_INSET);

    ctx.fillStyle = '#E53935'; ctx.fill(STRIPE);
    ctx.globalAlpha = 0.65; ctx.fillStyle = '#FFFFFF'; ctx.fillRect(49,15,1.8,9); ctx.globalAlpha = 1;

    const glassGrad = ctx.createLinearGradient(34,24,66,32);
    glassGrad.addColorStop(0.0, 'rgba(180,220,255,0.55)'); glassGrad.addColorStop(1.0, 'rgba(70,120,160,0.85)');
    ctx.fillStyle = glassGrad; ctx.fill(WINDSHIELD);
    ctx.lineWidth = 1.4; ctx.strokeStyle = '#CFD8DC'; ctx.stroke(WINDSHIELD);

    const capGrad = ctx.createLinearGradient(40,58,60,64);
    capGrad.addColorStop(0.0, '#424242'); capGrad.addColorStop(1.0, '#616161');
    ctx.fillStyle = capGrad; ctx.fill(MOTOR_CAP);

    ctx.globalAlpha = 0.14; ctx.fillStyle = '#FFFFFF'; ctx.beginPath(); ctx.ellipse(50, 20, 24, 6, 0, 0, Math.PI*2); ctx.fill(); ctx.globalAlpha = 1;
    ctx.restore();
  }

  function drawWake(ctx, sx, sy, size, dx, dy){
    const s = size;
    ctx.save();
    ctx.globalAlpha = 0.25;
    const ox = -Math.sign(dx||0) * s*0.12;
    const oy = -Math.sign(dy||1) * s*0.20;
    ctx.translate(sx + ox, sy + oy);
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.beginPath();
    ctx.moveTo(-s*0.05,  s*0.10);
    ctx.quadraticCurveTo(-s*0.30, s*0.35, -s*0.02, s*0.60);
    ctx.quadraticCurveTo( 0,      s*0.55,  s*0.02, s*0.60);
    ctx.quadraticCurveTo( s*0.30, s*0.35,  s*0.05, s*0.10);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 0.18;
    ctx.beginPath();
    ctx.ellipse(0, s*0.70, s*0.35, s*0.10, 0, 0, Math.PI*2);
    ctx.fill();
    ctx.restore();
  }

  function drawParkedDockBoats(ctx){
    const {DOCKS}=lakeRects(anchors());
    const S=api.DRAW, t=T();
    DOCKS.forEach(d=>{
      if(inBoat && claimedDockId===d.y) return;
      const spot = parkedSpotForDock(d);
      const sx = (spot.gx*t - api.camera.x) * (S/t) + S*0.50;
      const sy = (spot.gy*t - api.camera.y) * (S/t) + S*0.62;
      drawLuxuryBoat(ctx, sx, sy, S*0.92, false);
    });
  }

  IZZA.on('render-post', ()=>{
    if(!api?.ready || !isTier2()) return;
    const ctx=document.getElementById('game').getContext('2d');

    drawParkedDockBoats(ctx);

    if(inBoat && ghostBoat){
      const S=api.DRAW, t=T();
      const sx=(ghostBoat.x - api.camera.x)*(S/t) + S*0.50;
      const sy=(ghostBoat.y - api.camera.y)*(S/t) + S*0.62;

      let moving=false, dx=0, dy=0;
      if(prevBoatDraw){
        dx = sx - prevBoatDraw.x;
        dy = sy - prevBoatDraw.y;
        const dist = Math.hypot(dx,dy);
        moving = dist > 0.6;
      }
      if(moving && performance.now() - lastWakeAt > 30){
        drawWake(ctx, sx, sy, S*0.92, dx, dy);
        lastWakeAt = performance.now();
      }

      drawLuxuryBoat(ctx, sx, sy, S*0.92, moving);
      prevBoatDraw = {x:sx, y:sy};
    } else {
      prevBoatDraw = null;
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
