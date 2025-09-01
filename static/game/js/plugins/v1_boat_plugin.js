// v1.9 — boats beside dock (east), board-to-water snap, hide boarded boat,
//         full-lake boating (right of beach), smooth dock walking via 4-corner
//         tests, and (gx,gy) position marker.
(function(){
  const BUILD='v1.9-boat-plugin+east-park+corner-tests';
  console.log('[IZZA PLAY]', BUILD);

  const TIER_KEY='izzaMapTier';
  const isTier2 = ()=> localStorage.getItem(TIER_KEY)==='2';

  // debug label toggle
  window._izzaShowPos = (window._izzaShowPos!==false);

  // expose current boat state so the layout can skip water solids while boating
  function setBoatFlag(on){ window._izzaBoatActive = !!on; }

  // --- local state ---
  let api=null;
  let inBoat=false;
  let ghostBoat=null;           // visual hull following the player while riding
  let lastLand=null, lastWater=null;
  let claimedDockId=null;       // y (row) of the dock we boarded from (to hide its parked boat)

  // ====== geometry (mirrors the expansion) ======
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
    const LAKE = { x0: a.un.x1-14, y0: a.un.y0+23, x1: a.un.x1, y1: a.un.y1 };
    const BEACH_X = LAKE.x0 - 1;                // vertical beach column
    const DOCKS = [
      { x0: LAKE.x0, y: LAKE.y0+4,  len: 3 },   // planks extend EAST (→)
      { x0: LAKE.x0, y: LAKE.y0+12, len: 4 }
    ];
    return {LAKE, BEACH_X, DOCKS};
  }

  // ====== helpers ======
  const T = ()=> api.TILE;
  const centerGX = ()=> ((api.player.x+16)/T()|0);
  const centerGY = ()=> ((api.player.y+16)/T()|0);
  const playerGrid = ()=> ({gx:centerGX(), gy:centerGY()});

  function dockCells(){
    if(!api?.ready) return new Set();
    const {DOCKS}=lakeRects(anchors(api));
    const s=new Set();
    DOCKS.forEach(d=>{ for(let i=0;i<d.len;i++) s.add((d.x0+i)+'|'+d.y); });
    return s;
  }

  // "Auto cover everything to the right of the beach" as water,
  // except dock planks themselves.
  function tileIsWater(gx,gy){
    const a=anchors(api);
    const {BEACH_X}=lakeRects(a);
    if(gx<=BEACH_X) return false;
    if(gy<a.un.y0 || gy>a.un.y1) return false;
    if(dockCells().has(gx+'|'+gy)) return false; // planks are walkable land
    return true;
  }

  // 4-corner helpers for stable edge behavior
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

  // parked boat spot: immediately EAST (right) of the dock’s tip
  function parkedSpotForDock(d){ return { gx: d.x0 + d.len, gy: d.y }; }
  function dockByY(y){
    const {DOCKS}=lakeRects(anchors(api));
    return DOCKS.find(d=> d.y===y) || null;
  }

  // Which dock are we on/adjacent to? (returns its row Y as the ID)
  function nearestDockIdToPlayer(){
    const {gx,gy}=playerGrid();
    const {DOCKS}=lakeRects(anchors(api));
    for(const d of DOCKS){
      const tipX = d.x0 + d.len - 1;
      // on any plank tile
      if(gy===d.y && gx>=d.x0 && gx<=tipX) return d.y;
      // adjacent horizontally to plank strip
      if(gy===d.y && (gx===d.x0-1 || gx===tipX+1)) return d.y;
      // adjacent vertically above/below the plank strip
      if((gy===d.y-1 || gy===d.y+1) && gx>=d.x0 && gx<=tipX) return d.y;
    }
    return null;
  }

  // Best land tile to snap to when leaving the boat
  function nearestDisembarkSpot(){
    const a=anchors(api), {BEACH_X}=lakeRects(a);
    const gx=centerGX(), gy=centerGY();
    const docks=dockCells();

    // prefer adjacent plank (N,E,S,W)
    const n=[{x:gx+1,y:gy},{x:gx-1,y:gy},{x:gx,y:gy+1},{x:gx,y:gy-1}];
    for(const p of n) if(docks.has(p.x+'|'+p.y)) return p;

    // if right beside beach, snap onto beach column
    if(gx===BEACH_X+1 && gy>=a.un.y0 && gy<=a.un.y1) return {x:BEACH_X, y:gy};

    // if already on plank somehow
    if(docks.has(gx+'|'+gy)) return {x:gx,y:gy};

    return null;
  }

  // ====== boarding / leaving ======
  function canBoardHere(){
    if(!isTier2() || !api?.ready) return false;
    const {gx,gy}=playerGrid();
    const docks=dockCells();
    if(docks.has(gx+'|'+gy)) return true; // on plank
    // adjacent to any plank
    return docks.has((gx+1)+'|'+gy) || docks.has((gx-1)+'|'+gy) ||
           docks.has(gx+'|'+(gy+1)) || docks.has(gx+'|'+(gy-1));
  }

  function tryBoard(){
    if(inBoat || !isTier2() || !canBoardHere()) return false;

    // snap onto the water tile just EAST of the dock tip before boating
    const dockId = nearestDockIdToPlayer();
    if(dockId!=null){
      const d = dockByY(dockId);
      if(d){
        const spot = parkedSpotForDock(d);   // water just right of the tip
        api.player.x = (spot.gx*T()) + 1;
        api.player.y = (spot.gy*T()) + 1;
        lastWater = { x: api.player.x, y: api.player.y };
      }
      claimedDockId = dockId;                // hide this dock’s parked boat
    }else{
      claimedDockId = null;
      lastWater = { x: api.player.x, y: api.player.y };
    }

    inBoat = true;
    setBoatFlag(true);
    ghostBoat = { x: api.player.x, y: api.player.y };
    api.player.speed = 120;                  // boating speed
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
    api.player.speed = 90;                   // walk speed
    claimedDockId=null;                      // show parked boats again
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

  // ====== movement clamps (using 4-corner tests) ======
  IZZA.on('update-pre', ()=>{
    if(!api?.ready || !isTier2()) return;
    const p=api.player;

    if(inBoat){
      if(allCornersWater()){ lastWater={x:p.x,y:p.y}; }
      else if(lastWater){ p.x=lastWater.x; p.y=lastWater.y; } // keep boat fully on water
      if(ghostBoat){ ghostBoat.x=p.x; ghostBoat.y=p.y; }
    }else{
      // consider it "on open water" ONLY if all corners are water
      if(allCornersWater()){ lastLand={x:p.x,y:p.y}; }
      else if(lastLand){ p.x=lastLand.x; p.y=lastLand.y; }     // allow full dock walking
    }
  });

  // run AFTER other plugins to avoid being pushed back to shore
  function postClamp(){
    if(!api?.ready || !isTier2() || !inBoat) return;
    const p=api.player;
    if(allCornersWater()){ lastWater={x:p.x,y:p.y}; }
    else if(lastWater){ p.x=lastWater.x; p.y=lastWater.y; }
    if(ghostBoat){ ghostBoat.x=p.x; ghostBoat.y=p.y; }
  }
  setTimeout(()=> IZZA.on('update-post', postClamp), 0);

  // ====== visuals ======
  function drawParkedDockBoats(ctx){
    const {DOCKS}=lakeRects(anchors(api));
    const S=api.DRAW, t=T();

    ctx.save();
    ctx.fillStyle='#7ca7c7';
    DOCKS.forEach(d=>{
      if(inBoat && claimedDockId===d.y) return; // hide the boat we took
      const spot = parkedSpotForDock(d);        // EAST (beside the tip)
      const sx = (spot.gx*t - api.camera.x) * (S/t);
      const sy = (spot.gy*t - api.camera.y) * (S/t);
      ctx.fillRect(sx+S*0.18, sy+S*0.34, S*0.64, S*0.32);
    });
    ctx.restore();
  }

  function drawPlayerPosMarker(ctx){
    if(!window._izzaShowPos) return;
    const S=api.DRAW, t=T();
    const gx=centerGX(), gy=centerGY();
    const sx=(gx*t - api.camera.x)*(S/t);
    const sy=(gy*t - api.camera.y)*(S/t);

    ctx.save();
    ctx.fillStyle='rgba(80,220,255,0.25)';
    ctx.fillRect(sx+2, sy+2, S-4, S-4);
    ctx.font='12px monospace';
    ctx.fillStyle='#aef';
    ctx.strokeStyle='rgba(0,0,0,0.6)';
    ctx.lineWidth=3;
    const label=`${gx},${gy}`;
    ctx.strokeText(label, sx+S*0.10, sy-6);
    ctx.fillText(label,   sx+S*0.10, sy-6);
    ctx.restore();
  }

  IZZA.on('render-post', ()=>{
    if(!api?.ready || !isTier2()) return;
    const ctx=document.getElementById('game').getContext('2d');
    drawParkedDockBoats(ctx);

    if(inBoat && ghostBoat){
      const S=api.DRAW, t=T();
      const sx=(ghostBoat.x - api.camera.x)*(S/t);
      const sy=(ghostBoat.y - api.camera.y)*(S/t);
      ctx.fillStyle='#7ca7c7';
      ctx.fillRect(sx+S*0.18, sy+S*0.34, S*0.64, S*0.32);
    }

    drawPlayerPosMarker(ctx);
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
