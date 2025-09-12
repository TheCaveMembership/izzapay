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

  // ====== visuals (luxury speedboat) ======
let prevBoatDraw = null;
let lastWakeAt = 0;

// Build paths procedurally (broad support, no SVG ctor needed)
function makeHullPath(){
  const p = new Path2D();
  // Outer hull profile (top view, pointed bow)
  p.moveTo(6,38);
  p.quadraticCurveTo(22,16,50,10);  // port sweep up to bow
  p.quadraticCurveTo(78,16,94,38);  // starboard sweep down
  p.quadraticCurveTo(78,60,50,66);  // starboard aft round
  p.quadraticCurveTo(22,60,6,38);   // port aft round back to start
  p.closePath();
  return p;
}
function makeDeckInset(){
  const p = new Path2D();
  p.moveTo(16,38);
  p.quadraticCurveTo(30,22,50,18);
  p.quadraticCurveTo(70,22,84,38);
  p.quadraticCurveTo(70,55,50,58);
  p.quadraticCurveTo(30,55,16,38);
  p.closePath();
  return p;
}
function makeWindshield(){
  const p = new Path2D();
  p.moveTo(32,28);
  p.quadraticCurveTo(50,20,68,28);
  p.lineTo(66,32);
  p.quadraticCurveTo(50,25,34,32);
  p.closePath();
  return p;
}
function makeStripe(){
  const p = new Path2D();
  p.moveTo(48,14); p.lineTo(52,14);
  p.lineTo(78,22); p.lineTo(74,24);
  p.lineTo(48,16); p.closePath();
  return p;
}
function makeMotorCap(){
  const p = new Path2D();
  p.moveTo(40,60);
  p.quadraticCurveTo(50,64,60,60);
  p.quadraticCurveTo(50,62,40,60);
  p.closePath();
  return p;
}

const HULL_PATH      = makeHullPath();
const DECK_INSET     = makeDeckInset();
const WINDSHIELD     = makeWindshield();
const STRIPE         = makeStripe();
const MOTOR_CAP      = makeMotorCap();

function drawLuxuryBoat(ctx, sx, sy, size, moving){
  // size ~ tile screen px; path space is ~100x76
  ctx.save();

  // Gentle bob so parked boats feel alive
  const t = performance.now() * 0.001;
  const bob = Math.sin(t * 2.4) * (moving ? 0.8 : 1.2);
  ctx.translate(sx, sy + bob);

  const scale = size / 72;         // tuned visually against your tile
  ctx.scale(scale, scale);
  ctx.translate(-50, -38);         // center the ~100x76 model on (sx,sy)

  // Soft shadow
  ctx.save();
  ctx.translate(2, 5);
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.filter = 'blur(1.2px)';
  ctx.fill(HULL_PATH);
  ctx.restore();
  ctx.filter = 'none';

  // Hull gradient (deep paint)
  const hullGrad = ctx.createLinearGradient(20,12,80,62);
  hullGrad.addColorStop(0.0, '#263238');  // near-black blue gray
  hullGrad.addColorStop(0.5, '#37474F');
  hullGrad.addColorStop(1.0, '#212121');

  ctx.fillStyle = hullGrad;
  ctx.fill(HULL_PATH);
  ctx.lineWidth = 1.8;
  ctx.strokeStyle = 'rgba(255,255,255,0.08)'; // subtle clear-coat highlight
  ctx.stroke(HULL_PATH);

  // Deck inset (lighter, premium)
  const deckGrad = ctx.createLinearGradient(28,22,72,56);
  deckGrad.addColorStop(0.0, '#8D6E63');   // warm luxury brown
  deckGrad.addColorStop(1.0, '#5D4037');
  ctx.fillStyle = deckGrad;
  ctx.fill(DECK_INSET);

  // Chrome rim around deck inset
  ctx.lineWidth = 2.2;
  ctx.strokeStyle = '#B0BEC5';
  ctx.stroke(DECK_INSET);

  // Racing stripe (accent)
  ctx.fillStyle = '#E53935'; // red
  ctx.fill(STRIPE);
  ctx.globalAlpha = 0.65;
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(49,15,1.8,9);
  ctx.globalAlpha = 1;

  // Tinted windshield with chrome trim
  const glassGrad = ctx.createLinearGradient(34,24,66,32);
  glassGrad.addColorStop(0.0, 'rgba(180,220,255,0.55)');
  glassGrad.addColorStop(1.0, 'rgba(70,120,160,0.85)');
  ctx.fillStyle = glassGrad;
  ctx.fill(WINDSHIELD);
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = '#CFD8DC';
  ctx.stroke(WINDSHIELD);

  // Motor cap / rear detail
  const capGrad = ctx.createLinearGradient(40,58,60,64);
  capGrad.addColorStop(0.0, '#424242');
  capGrad.addColorStop(1.0, '#616161');
  ctx.fillStyle = capGrad;
  ctx.fill(MOTOR_CAP);

  // Micro highlights to sell shape
  ctx.globalAlpha = 0.14;
  ctx.fillStyle = '#FFFFFF';
  ctx.beginPath();
  ctx.ellipse(50, 20, 24, 6, 0, 0, Math.PI*2);
  ctx.fill();
  ctx.globalAlpha = 1;

  ctx.restore();
}

function drawWake(ctx, sx, sy, size, dirHintX, dirHintY){
  // Simple V-wake behind the boat when moving; no rotation dependency
  const s = size;
  ctx.save();
  ctx.globalAlpha = 0.25;

  // Offset wake slightly opposite to travel direction
  const ox = -Math.sign(dirHintX||0) * s*0.12;
  const oy = -Math.sign(dirHintY||1) * s*0.20; // default assume forward = down

  ctx.translate(sx + ox, sy + oy);

  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.beginPath();
  ctx.moveTo(-s*0.05,  s*0.10);
  ctx.quadraticCurveTo(-s*0.30, s*0.35, -s*0.02, s*0.60);
  ctx.quadraticCurveTo( 0,      s*0.55,  s*0.02, s*0.60);
  ctx.quadraticCurveTo( s*0.30, s*0.35,  s*0.05, s*0.10);
  ctx.closePath();
  ctx.fill();

  // trailing ripples
  ctx.globalAlpha = 0.18;
  ctx.beginPath();
  ctx.ellipse(0, s*0.70, s*0.35, s*0.10, 0, 0, Math.PI*2);
  ctx.fill();

  ctx.restore();
}

function drawParkedDockBoats(ctx){
  const {DOCKS}=lakeRects(anchors(api));
  const S=api.DRAW, t=T();

  DOCKS.forEach(d=>{
    if(inBoat && claimedDockId===d.y) return; // hide the boat we took
    const spot = parkedSpotForDock(d);        // SOUTH (under plank)
    const sx = (spot.gx*t - api.camera.x) * (S/t) + S*0.50;
    const sy = (spot.gy*t - api.camera.y) * (S/t) + S*0.62;
    drawLuxuryBoat(ctx, sx, sy, S*0.92, /*moving*/ false);
  });
}

IZZA.on('render-post', ()=>{
  if(!api?.ready || !isTier2()) return;
  const ctx=document.getElementById('game').getContext('2d');

  // parked boats
  drawParkedDockBoats(ctx);

  // the player’s boat ghost
  if(inBoat && ghostBoat){
    const S=api.DRAW, t=T();
    const sx=(ghostBoat.x - api.camera.x)*(S/t) + S*0.50;
    const sy=(ghostBoat.y - api.camera.y)*(S/t) + S*0.62;

    // wake if moving enough
    let moving=false, dx=0, dy=0;
    if(prevBoatDraw){
      dx = sx - prevBoatDraw.x;
      dy = sy - prevBoatDraw.y;
      const dist = Math.hypot(dx,dy);
      moving = dist > 0.6; // screen px threshold
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
