// downtown_clip_safe_layout.js — Tier-2 expansion (clip-safe; sidewalks everywhere; never repaint Tier-1)
(function () {
  const TIER_KEY = 'izzaMapTier';

  // -------- Palette (match core; tweak house/hotel colors to avoid grass/water confusion) -------
  const COL = {
    grass:'#09371c',
    road:'#2a2a2a', dash:'#ffd23f', sidewalk:'#6a727b',
    civic:'#405a85', police:'#0a2455', shop:'#203a60',
    park:'#2b6a7a',
    water:'#1a4668', sand:'#e0c27b', wood:'#6b4a2f',
    hotel:'#7a4e2f',
    house:'#7b6a42',
    hoodPark:'#135c33',
    lot:'#474747'
  };
  const isTier2 = ()=> localStorage.getItem(TIER_KEY)==='2';

  // ---------- Core anchors (same math as core.js) ----------
  function unlockedRect(t){ return (t!=='2') ? {x0:18,y0:18,x1:72,y1:42} : {x0:10,y0:12,x1:80,y1:50}; }
  function anchors(api){
    const tier = localStorage.getItem(TIER_KEY)||'1';
    const un = unlockedRect(tier);

    const bW=10,bH=6;
    const bX = Math.floor((un.x0+un.x1)/2) - Math.floor(bW/2);
    const bY = un.y0 + 5;

    const hRoadY       = bY + bH + 1;
    const sidewalkTopY = hRoadY - 1;
    const sidewalkBotY = hRoadY + 1;

    // Original Tier-1 vertical (keep); add new ones farther right/left.
    const vRoadX         = Math.min(un.x1-3, bX + bW + 6);
    const vSidewalkLeftX = vRoadX - 1;
    const vSidewalkRightX= vRoadX + 1;

    const shop = { w:8, h:5, x:vSidewalkRightX+1, y: sidewalkTopY-5 };
    const door = { gx: bX + Math.floor(bW/2), gy: sidewalkTopY };
    const register  = { gx: vSidewalkRightX, gy: sidewalkTopY };

    const HQ  = {x0:bX, y0:bY, x1:bX+bW-1, y1:bY+bH-1};
    const SH  = {x0:shop.x, y0:shop.y, x1:shop.x+shop.w-1, y1:shop.y+shop.h-1};

    return {un,bX,bY,bW,bH,hRoadY,sidewalkTopY,sidewalkBotY,vRoadX,vSidewalkLeftX,vSidewalkRightX,shop,HQ,SH,door,register};
  }

  // ---------- Lakefront (water/sand reach right+bottom edges) ----------
  function lakeRects(a){
    const LAKE = { x0: a.un.x1-14, y0: a.un.y0+23, x1: a.un.x1, y1: a.un.y1 };
    const BEACH_X = LAKE.x0 - 1;
    const DOCKS = [
      { x0: LAKE.x0, y: LAKE.y0+4,  len: 3 },
      { x0: LAKE.x0, y: LAKE.y0+12, len: 4 }
    ];
    // Hotel pulled back behind sidewalk + lot
    const hotelTopY = LAKE.y0 - 5; // 1 sidewalk + 3 lot + 1 buffer
    const HOTEL  = { x0: LAKE.x0+3, y0: hotelTopY, x1: LAKE.x0+9, y1: hotelTopY+3 };
    const LOT    = { x0: HOTEL.x0,  y0: HOTEL.y1+1, x1: HOTEL.x1,  y1: HOTEL.y1+3 };

    return {LAKE, BEACH_X, DOCKS, HOTEL, LOT};
  }

  // ---------- Bottom-left neighborhood ----------
  function hoodRects(a){
    const HOOD   = { x0:a.un.x0+2, y0:a.un.y1-8, x1:a.un.x0+26, y1:a.un.y1-0 };
    const HOOD_H = [ HOOD.y0+2, HOOD.y0+6 ];
    const HOOD_V = [ HOOD.x0+8, HOOD.x0+16 ];
    const HOUSES = [
      {x0:HOOD.x0+3, y0:HOOD.y0+4, x1:HOOD.x0+5, y1:HOOD.y0+5},
      {x0:HOOD.x0+11,y0:HOOD.y0+4, x1:HOOD.x0+13,y1:HOOD.y0+5},
      {x0:HOOD.x0+19,y0:HOOD.y0+4, x1:HOOD.x0+21,y1:HOOD.y0+5},
      {x0:HOOD.x0+5, y0:HOOD.y0+9, x1:HOOD.x0+7, y1:HOOD.y0+10},
      {x0:HOOD.x0+13,y0:HOOD.y0+9, x1:HOOD.x0+15,y1:HOOD.y0+10}
    ];
    const HOOD_PARK = { x0: HOOD.x0+22, y0: HOOD.y0+6, x1: HOOD.x0+26, y1: HOOD.y0+9 };
    return {HOOD, HOOD_H, HOOD_V, HOUSES, HOOD_PARK};
  }

  // ---------- Helpers ----------
  const _inRect=(gx,gy,R)=> gx>=R.x0 && gx<=R.x1 && gy>=R.y0 && gy<=R.y1;
  const scl = api => api.DRAW/api.TILE;
  const w2sX=(api,wx)=>(wx-api.camera.x)*scl(api);
  const w2sY=(api,wy)=>(wy-api.camera.y)*scl(api);
  function fillTile(api,ctx,gx,gy,color){
    const S=api.DRAW, sx=w2sX(api,gx*api.TILE), sy=w2sY(api,gy*api.TILE);
    ctx.fillStyle=color; ctx.fillRect(sx,sy,S,S);
  }

  // ---------- Protect the original Tier-1 tiles ----------
  function isOriginalTile(gx,gy,a){
    if (_inRect(gx,gy,{x0:a.HQ.x0-1,y0:a.HQ.y0-1,x1:a.HQ.x1+1,y1:a.HQ.y1+1})) return true;
    if (_inRect(gx,gy,{x0:a.SH.x0-1,y0:a.SH.y0-1,x1:a.SH.x1+1,y1:a.SH.y1+1})) return true;
    if (gy===a.hRoadY || gy===a.sidewalkTopY || gy===a.sidewalkBotY) return true;
    if (gx===a.vRoadX || gx===a.vSidewalkLeftX || gx===a.vSidewalkRightX) return true;
    return false;
  }

  // ---------- Road plan ----------
  function desiredRoadGrid(a){
    const H = [
      a.hRoadY - 10,     // top avenue
      a.hRoadY,          // middle (Tier-1 row; we won't repaint it, but needed for intersection logic)
      a.hRoadY + 6       // lower avenue toward lake
    ];
    const V = [
      a.vRoadX - 12,     // far-west vertical
      a.vRoadX + 10      // east vertical near lake (clear column between HQ and shop)
    ];
    return {H, V};
  }

  // Clip helpers (avoid re-painting forbidden blocks)
  function clipHRow(y, x0, x1, forbiddenRects){
    let parts=[{y, x0, x1}];
    forbiddenRects.forEach(R=>{
      parts = parts.flatMap(p=>{
        if(p.y<R.y0||p.y>R.y1||p.x1<R.x0||p.x0>R.x1) return [p];
        const out=[];
        if(p.x0 < R.x0) out.push({y:p.y, x0:p.x0, x1:R.x0-1});
        if(p.x1 > R.x1) out.push({y:p.y, x0:R.x1+1, x1:p.x1});
        return out;
      });
    });
    return parts.filter(p=>p.x1>=p.x0);
  }
  function clipVCol(x, y0, y1, forbiddenRects){
    let parts=[{x, y0, y1}];
    forbiddenRects.forEach(R=>{
      parts = parts.flatMap(p=>{
        if(p.x<R.x0||p.x>R.x1||p.y1<R.y0||p.y0>R.y1) return [p];
        const out=[];
        if(p.y0 < R.y0) out.push({x:p.x, y0:p.y0, y1:R.y0-1});
        if(p.y1 > R.y1) out.push({x:p.x, y0:R.y1+1, y1:p.y1});
        return out;
      });
    });
    return parts.filter(p=>p.y1>=p.y0);
  }

  // Pull a clipped segment back 1 tile if it would touch a forbidden rect (prevents “road into a wall”)
  function shaveDeadEndsH(seg, forbidden){
    const near = (x,y)=> forbidden.some(R=> x===R.x0-1 && y>=R.y0 && y<=R.y1 || x===R.x1+1 && y>=R.y0 && y<=R.y1 );
    if(seg.x0<seg.x1){
      if(near(seg.x0,seg.y)) seg.x0++;
      if(near(seg.x1,seg.y)) seg.x1--;
    }
    return (seg.x0<=seg.x1)? seg : null;
  }
  function shaveDeadEndsV(seg, forbidden){
    const near = (x,y)=> forbidden.some(R=> y===R.y0-1 && x>=R.x0 && x<=R.x1 || y===R.y1+1 && x>=R.x0 && x<=R.x1 );
    if(seg.y0<seg.y1){
      if(near(seg.x,seg.y0)) seg.y0++;
      if(near(seg.x,seg.y1)) seg.y1--;
    }
    return (seg.y0<=seg.y1)? seg : null;
  }

  // Small util so yellow dashes appear on H roads only
  function drawHRoad(api,ctx,y,x0,x1){
    for(let x=x0;x<=x1;x++){
      fillTile(api,ctx,x,y,COL.road);
      const S=api.DRAW, sx=w2sX(api,x*api.TILE), sy=w2sY(api,y*api.TILE);
      ctx.fillStyle=COL.dash;
      for(let i=0;i<4;i++) ctx.fillRect(sx+i*(S/4)+S*0.05, sy+S*0.48, S*0.10, S*0.04);
    }
  }
  function drawVRoad(api,ctx,x,y0,y1){ for(let y=y0;y<=y1;y++) fillTile(api,ctx,x,y,COL.road); }

  // ---------- Boats (side docking; stay off land; tow path avoids docks) ----------
  const _boats=[], _dockBoats=[]; let _towBoat=null, _inBoat=false, _ride=null, _lastLand=null;
  function spawnBoats(){
    if(!isTier2() || _boats.length) return;
    const api=IZZA.api, A=anchors(api), {LAKE, DOCKS}=lakeRects(A);
    const padRect = {x0:LAKE.x0+2,y0:LAKE.y0+2,x1:LAKE.x1-2,y1:LAKE.y1-2};

    const makeLoop=(x,y,s,clockwise=true)=>{
      const r=padRect;
      const path = clockwise
        ? [{x:r.x0,y:r.y0},{x:r.x1,y:r.y0},{x:r.x1,y:r.y1},{x:r.x0,y:r.y1}]
        : [{x:r.x1,y:r.y1},{x:r.x0,y:r.y1},{x:r.x0,y:r.y0},{x:r.x1,y:r.y0}];
      // When moving along the beach edge, nudge one tile DOWN (away from docks)
      const dockYs = new Set(DOCKS.map(d=>d.y));
      path.forEach(pt=>{ if(pt.x===r.x0 && dockYs.has(pt.y)) pt.y += 1; });
      return {x,y,s,i:0,path};
    };

    // free boat and tow boat
    _boats.push(makeLoop(padRect.x0, padRect.y0, 55, true));
    _towBoat = makeLoop(padRect.x0+1, padRect.y1-1, 52, true); _boats.push(_towBoat);

    // docked boats sit to the RIGHT SIDE of the dock planks, not on top
    DOCKS.forEach(d=> _dockBoats.push({x:d.x0+d.len, y:d.y, s:120, taken:false}));
  }
  IZZA.on('ready', spawnBoats);

  // Boat movement + keep them on water
  IZZA.on('update-pre', ({dtSec})=>{
    if(!IZZA.api?.ready || !isTier2()) return;
    const api=IZZA.api, A=anchors(api), {LAKE}=lakeRects(A);

    _boats.forEach(b=>{
      const tgt=b.path[b.i], dx=tgt.x-b.x, dy=tgt.y-b.y, m=Math.hypot(dx,dy)||1, step=b.s*dtSec/32;
      if(m<=step){ b.x=tgt.x; b.y=tgt.y; b.i=(b.i+1)%b.path.length; }
      else{ b.x += (dx/m)*step; b.y += (dy/m)*step; }
      // clamp to water
      b.x = Math.max(LAKE.x0+1, Math.min(LAKE.x1-1, b.x));
      b.y = Math.max(LAKE.y0+1, Math.min(LAKE.y1-1, b.y));
    });
  });

  // Track dock cells so docks are walkable while water is solid
  function dockCells(){
    const api=IZZA.api, A=anchors(api), {DOCKS}=lakeRects(A);
    const set=new Set();
    DOCKS.forEach(d=>{ for(let i=0;i<d.len;i++) set.add((d.x0+i)+'|'+d.y); });
    return set;
  }
  function _tileIsWater(gx,gy){
    const api=IZZA.api, A=anchors(api), {LAKE}=lakeRects(A);
    if(!_inRect(gx,gy,LAKE)) return false;
    // docks are not water for collision
    return !dockCells().has(gx+'|'+gy);
  }

  // Enter/leave boat from the SIDE of a dock
  function _enterBoat(){
    if(_inBoat || !isTier2()) return;
    const api=IZZA.api, t=api.TILE;
    const gx=((api.player.x+16)/t)|0, gy=((api.player.y+16)/t)|0;
    let best=null,bd=9e9;
    _dockBoats.forEach(b=>{ if(b.taken) return; const d=Math.hypot(b.x-gx,b.y-gy); if(d<bd){bd=d; best=b;} });
    if(best && bd<=2){ best.taken=true; _ride=best; _inBoat=true; api.player.speed=120; }
  }
  function _leaveBoat(){
    if(!_inBoat) return;
    const api=IZZA.api, t=api.TILE, gx=((api.player.x+16)/t)|0, gy=((api.player.y+16)/t)|0;
    const A=anchors(api), {LAKE, BEACH_X}=lakeRects(A);
    const onBeach = (gx===BEACH_X && gy>=LAKE.y0 && gy<=LAKE.y1);
    const onSideDock = _dockBoats.some(b=> Math.abs(b.x-gx)<=1 && Math.abs(b.y-gy)<=0);
    if(onBeach || onSideDock){ _ride.taken=false; _ride=null; _inBoat=false; api.player.speed=90; }
  }
  document.getElementById('btnB')?.addEventListener('click', ()=>{ _inBoat? _leaveBoat() : _enterBoat(); });
  window.addEventListener('keydown', e=>{ if(e.key.toLowerCase()==='b'){ _inBoat? _leaveBoat() : _enterBoat(); } });

  // ---------- RENDER UNDER ----------
  let _layout=null;
  IZZA.on('render-under', ()=>{
    if(!IZZA.api?.ready || !isTier2()) return;
    const api=IZZA.api, ctx=document.getElementById('game').getContext('2d');
    const A = anchors(api);
    const {LAKE, BEACH_X, DOCKS, HOTEL, LOT} = lakeRects(A);
    const {HOOD, HOOD_H, HOOD_V, HOUSES, HOOD_PARK} = hoodRects(A);

    // Forbidden areas for MAIN road plan
    const FORBID = [
      {x0:LAKE.x0,y0:LAKE.y0,x1:LAKE.x1,y1:LAKE.y1},
      {x0:A.HQ.x0-1,y0:A.HQ.y0-1,x1:A.HQ.x1+1,y1:A.HQ.y1+1},
      {x0:A.SH.x0-1,y0:A.SH.y0-1,x1:A.SH.x1+1,y1:A.SH.y1+1}
    ];

    const {H,V} = desiredRoadGrid(A);

    // Build road lists that reach the unlocked edges (then shave near HQ/Shop)
    let H_ROADS = [];
    let V_ROADS = [];

    H.forEach(y=>{
      const segs = clipHRow(y, A.un.x0, A.un.x1, FORBID);
      segs.forEach(s=>{
        const shaved = shaveDeadEndsH({y:s.y,x0:s.x0,x1:s.x1}, FORBID);
        if(shaved) H_ROADS.push(shaved);
      });
    });
    V.forEach(x=>{
      const segs = clipVCol(x, A.un.y0, A.un.y1, FORBID);
      segs.forEach(s=>{
        const shaved = shaveDeadEndsV({x:s.x,y0:s.y0,y1:s.y1}, FORBID);
        if(shaved) V_ROADS.push(shaved);
      });
    });

    // Sets for intersection logic
    const H_ROWS_ALL = new Set([...H_ROADS.map(r=>r.y), ...HOOD_H]);
    const V_COLS_ALL = new Set([...V_ROADS.map(r=>r.x), ...HOOD_V]);
    const isTier1Y = y => (y===A.hRoadY || y===A.sidewalkTopY || y===A.sidewalkBotY);

    // --- Sidewalks (draw before roads). Intersections FIX:
    //     Vertical-road sidewalks SKIP every horizontal road row (prevents grey bars through crossings).
    const markSW = new Set();
    const seen = (gx,gy)=>{ const k=gx+'|'+gy; if(markSW.has(k)) return true; markSW.add(k); return false; };

    // H-road sidewalks (optional skip across vertical columns to keep corners crisp)
    H_ROADS.forEach(r=>{
      for(let x=r.x0;x<=r.x1;x++){
        if(!V_COLS_ALL.has(x)){ if(!isOriginalTile(x, r.y-1, A)) if(!seen(x,r.y-1)) fillTile(api,ctx,x,r.y-1,COL.sidewalk); }
        if(!V_COLS_ALL.has(x)){ if(!isOriginalTile(x, r.y+1, A)) if(!seen(x,r.y+1)) fillTile(api,ctx,x,r.y+1,COL.sidewalk); }
      }
    });

    // V-road sidewalks (SKIP at every H-road row and Tier-1 rows)
    V_ROADS.forEach(r=>{
      for(let y=r.y0;y<=r.y1;y++){
        if(H_ROWS_ALL.has(y) || isTier1Y(y)) continue; // intersection fix
        if(!isOriginalTile(r.x-1, y, A)) if(!seen(r.x-1,y)) fillTile(api,ctx,r.x-1,y,COL.sidewalk);
        if(!isOriginalTile(r.x+1, y, A)) if(!seen(r.x+1,y)) fillTile(api,ctx,r.x+1,y,COL.sidewalk);
      }
    });

    // Roads themselves (never overdraw the Tier-1 tiles)
    H_ROADS.forEach(r=>{
      for(let x=r.x0;x<=r.x1;x++){ if(!isOriginalTile(x, r.y, A)) fillTile(api,ctx,x,r.y,COL.road); }
      drawHRoad(api,ctx,r.y,r.x0,r.x1);
    });
    V_ROADS.forEach(r=>{
      for(let y=r.y0;y<=r.y1;y++){ if(!isOriginalTile(r.x, y, A)) fillTile(api,ctx,r.x,y,COL.road); }
      drawVRoad(api,ctx,r.x,r.y0,r.y1);
    });

    // --- Downtown small buildings (shop in front of HQ removed)
    const BUILDINGS = [
      {x:A.vRoadX+11, y:A.hRoadY-9, w:6, h:3, color:COL.civic},
      // removed: {x:A.vRoadX+6,  y:A.hRoadY+2, w:4, h:3, color:COL.shop},
      {x:A.vRoadX+8,  y:A.hRoadY+9, w:7, h:4, color:COL.shop},
      {x:A.vRoadX-14, y:A.hRoadY+2, w:3, h:2, color:COL.shop},
      {x:A.vRoadX-6,  y:A.hRoadY-2, w:3, h:2, color:COL.shop}
    ].filter(b=>{
      for(let gx=b.x; gx<b.x+b.w; gx++)
        for(let gy=b.y; gy<b.y+b.h; gy++)
          if (_inRect(gx,gy,LAKE) || isOriginalTile(gx,gy,A)) return false;
      return true;
    });
    BUILDINGS.forEach(b=>{
      for(let gy=b.y; gy<b.y+b.h; gy++)
        for(let gx=b.x; gx<b.x+b.w; gx++)
          if(!_inRect(gx,gy,LAKE) && !isOriginalTile(gx,gy,A)) fillTile(api,ctx,gx,gy,b.color);
      const sx=w2sX(api,b.x*api.TILE), sy=w2sY(api,b.y*api.TILE);
      ctx.fillStyle='rgba(0,0,0,.15)'; ctx.fillRect(sx,sy, b.w*api.DRAW, Math.floor(b.h*api.DRAW*0.18));
    });

    // --- Hotel block: sidewalk + parking lot + hotel box (hotel pulled back)
    for(let gx=LOT.x0; gx<=LOT.x1; gx++) fillTile(api,ctx,gx,LOT.y0-1,COL.sidewalk);
    for(let gy=LOT.y0; gy<=LOT.y1; gy++)
      for(let gx=LOT.x0; gx<=LOT.x1; gx++) fillTile(api,ctx,gx,gy,COL.lot);
    for(let gy=HOTEL.y0; gy<=HOTEL.y1; gy++)
      for(let gx=HOTEL.x0; gx<=HOTEL.x1; gx++) fillTile(api,ctx,gx,gy,COL.hotel);

    // --- Neighborhood roads (reach edges; avoid painting through the hood park)
    // sidewalks
    HOOD_H.forEach(y=>{
      for(let x=A.un.x0; x<=A.un.x1; x++){
        if(!V_COLS_ALL.has(x)){ fillTile(api,ctx,x,y-1,COL.sidewalk); }
        if(!V_COLS_ALL.has(x)){ fillTile(api,ctx,x,y+1,COL.sidewalk); }
      }
    });
    HOOD_V.forEach(x=>{
      for(let y=A.un.y0; y<=A.un.y1; y++){
        if(H_ROWS_ALL.has(y)) continue; // same intersection fix
        fillTile(api,ctx,x-1,y,COL.sidewalk);
        fillTile(api,ctx,x+1,y,COL.sidewalk);
      }
    });
    // roads (skip through park area)
    HOOD_H.forEach(y=>{
      const segs = clipHRow(y, A.un.x0, A.un.x1, [HOOD_PARK]);
      segs.forEach(s=> drawHRoad(api,ctx,y, s.x0, s.x1));
    });
    HOOD_V.forEach(x=>{
      const segs = clipVCol(x, A.un.y0, A.un.y1, [HOOD_PARK]);
      segs.forEach(s=> drawVRoad(api,ctx,x, s.y0, s.y1));
    });

    // hood park
    for(let gy=HOOD_PARK.y0; gy<=HOOD_PARK.y1; gy++)
      for(let gx=HOOD_PARK.x0; gx<=HOOD_PARK.x1; gx++) fillTile(api,ctx,gx,gy,COL.hoodPark);

    // houses (behind sidewalks)
    HOUSES.forEach(h=>{
      for(let gy=h.y0; gy<=h.y1; gy++)
        for(let gx=h.x0; gx<=h.x1; gx++) fillTile(api,ctx,gx,gy,COL.house);
    });

    // --- Lake / beach / docks
    for(let gy=LAKE.y0; gy<=LAKE.y1; gy++)
      for(let gx=LAKE.x0; gx<=LAKE.x1; gx++) fillTile(api,ctx,gx,gy,COL.water);
    for(let gy=LAKE.y0; gy<=LAKE.y1; gy++) fillTile(api,ctx,BEACH_X,gy,COL.sand);
    ctx.fillStyle=COL.wood;
    DOCKS.forEach(d=>{
      const S=api.DRAW, sx=w2sX(api,d.x0*api.TILE), sy=w2sY(api,d.y*api.TILE);
      ctx.fillRect(sx,sy, d.len*S, S);
    });

    // --- Boats (visuals)
    const S=api.DRAW, t=api.TILE, f=S/t;
    const sx=gx=> (gx*t - api.camera.x)*f, sy=gy=> (gy*t - api.camera.y)*f;
    const drawBoat=(gx,gy)=>{ ctx.fillStyle='#7ca7c7'; ctx.fillRect(sx(gx)+S*0.2, sy(gy)+S*0.35, S*0.6, S*0.3); };
    _boats.forEach(b=> drawBoat(b.x,b.y));
    _dockBoats.forEach(b=> drawBoat(b.x,b.y));
    if(_towBoat){
      const tgt=_towBoat.path[_towBoat.i], vx=tgt.x-_towBoat.x, vy=tgt.y-_towBoat.y, m=Math.hypot(vx,vy)||1;
      const leash = 2.0;
      const wx=_towBoat.x - (vx/m)*leash, wy=_towBoat.y - (vy/m)*leash;
      ctx.strokeStyle = '#dfe9ef'; ctx.lineWidth = Math.max(1, S*0.04);
      ctx.beginPath(); ctx.moveTo(sx(_towBoat.x)+S*0.5, sy(_towBoat.y)+S*0.5);
      ctx.lineTo(sx(wx)+S*0.5,       sy(wy)+S*0.5); ctx.stroke();
      ctx.fillStyle='#23d3c6';
      ctx.fillRect(sx(wx)+S*0.33, sy(wy)+S*0.33, S*0.34, S*0.34);
    }

    _layout = { H_ROADS, V_ROADS, BUILDINGS, HOTEL, LOT, LAKE, HOOD, HOUSES, HOOD_PARK };
  });

  // ---------- Collisions & movement ----------
  function rectW (r){ return r.x1-r.x0+1; }
  function rectH (r){ return r.y1-r.y0+1; }

  IZZA.on('update-pre', ()=>{
    if(!IZZA.api?.ready || !isTier2()) return;
    const api=IZZA.api, p=api.player, t=api.TILE;
    const gx=((p.x+16)/t)|0, gy=((p.y+16)/t)|0;

    // remember last land using 4-corner water test (prevents walking onto water edges)
    const corners = [
      {x:((p.x+1)/t)|0, y:((p.y+1)/t)|0},
      {x:((p.x+31)/t)|0, y:((p.y+1)/t)|0},
      {x:((p.x+1)/t)|0, y:((p.y+31)/t)|0},
      {x:((p.x+31)/t)|0, y:((p.y+31)/t)|0}
    ];
    const onWater = corners.every(c=> _tileIsWater(c.x,c.y));
    if(!onWater) _lastLand = {x:p.x,y:p.y};
    else if(!_inBoat && _lastLand){ p.x=_lastLand.x; p.y=_lastLand.y; }

    // keep dock rider icon aligned with player when riding a boat
    if(_inBoat && _ride){ _ride.x = ((p.x/t)|0); _ride.y = ((p.y/t)|0); }

    // cars bounce off new buildings
    if(_layout){
      api.cars.forEach(c=>{
        const cgx=(c.x/t)|0, cgy=(c.y/t)|0;
        const hitB = _layout.BUILDINGS?.some(b=> cgx>=b.x && cgx<b.x+b.w && cgy>=b.y && cgy<b.y+b.h);
        const hitH = cgx>=_layout.HOTEL.x0 && cgx<=_layout.HOTEL.x1 && cgy>=_layout.HOTEL.y0 && cgy<=_layout.HOTEL.y1;
        if(hitB||hitH){ c.dir*=-1; c.x += c.dir*4; }
      });
    }
  });

  IZZA.on('update-post', ()=>{
    if(!IZZA.api?.ready || !isTier2() || !_layout) return;
    const api=IZZA.api, t=api.TILE, p=api.player;
    const gx=(p.x/t)|0, gy=(p.y/t)|0;

    const solids = [];
    // Buildings & hotel/houses
    _layout.BUILDINGS?.forEach(b=> solids.push({x:b.x,y:b.y,w:b.w,h:b.h}));
    solids.push({x:_layout.HOTEL.x0,y:_layout.HOTEL.y0,w:rectW(_layout.HOTEL),h:rectH(_layout.HOTEL)});
    _layout.HOUSES.forEach(h=> solids.push({x:h.x0,y:h.y0,w:rectW(h),h:rectH(h)}));
    // Hood park is not solid.
    // Water is solid except the beach column and dock planks
    const waterIsSolid = (x,y)=>{
      if(!_inRect(x,y,_layout.LAKE)) return false;
      if(x===lakeRects(anchors(api)).BEACH_X) return false;
      if(dockCells().has(x+'|'+y)) return false;
      return true;
    };
    if(waterIsSolid(gx,gy)) solids.push({x:_layout.LAKE.x0,y:_layout.LAKE.y0,w:rectW(_layout.LAKE),h:rectH(_layout.LAKE)});

    // Tile AABB resolve (simple push-out)
    for(const b of solids){
      if(gx>=b.x && gx<b.x+b.w && gy>=b.y && gy<b.y+b.h){
        const dxL=Math.abs(p.x-b.x*t), dxR=Math.abs((b.x+b.w)*t-p.x);
        const dyT=Math.abs(p.y-b.y*t), dyB=Math.abs((b.y+b.h)*t-p.y);
        const m=Math.min(dxL,dxR,dyT,dyB);
        if(m===dxL) p.x=(b.x-0.01)*t;
        else if(m===dxR) p.x=(b.x+b.w+0.01)*t;
        else if(m===dyT) p.y=(b.y-0.01)*t;
        else             p.y=(b.y+b.h+0.01)*t;
        break;
      }
    }
  });

  // ---------- Minimap / Bigmap overlay ----------
  function paintOverlay(id){
    if(!_layout) return;
    const c=document.getElementById(id); if(!c) return;
    const ctx=c.getContext('2d');
    const sx=c.width/90, sy=c.height/60;

    ctx.fillStyle='#8a90a0';
    _layout.H_ROADS.forEach(r=> ctx.fillRect(r.x0*sx, r.y*sy, (r.x1-r.x0+1)*sx, 1.2*sy));
    _layout.V_ROADS.forEach(r=> ctx.fillRect(r.x*sx, r.y0*sy, 1.2*sx, (r.y1-r.y0+1)*sy));

    ctx.fillStyle='#6f87b3';
    (_layout.BUILDINGS||[]).forEach(b=> ctx.fillRect(b.x*sx,b.y*sy,b.w*sx,b.h*sy));

    // lake + beach + hotel + lot
    const a=anchors(IZZA.api), {LAKE, BEACH_X, HOTEL, LOT}=lakeRects(a);
    ctx.fillStyle=COL.water;
    ctx.fillRect(LAKE.x0*sx,LAKE.y0*sy,(LAKE.x1-LAKE.x0+1)*sx,(LAKE.y1-LAKE.y0+1)*sy);
    ctx.fillStyle=COL.sand; ctx.fillRect(BEACH_X*sx, LAKE.y0*sy, 1*sx, (LAKE.y1-LAKE.y0+1)*sy);
    ctx.fillStyle=COL.lot;   ctx.fillRect(LOT.x0*sx,LOT.y0*sy,(LOT.x1-LOT.x0+1)*sx,(LOT.y1-LOT.y0+1)*sy);
    ctx.fillStyle=COL.hotel; ctx.fillRect(HOTEL.x0*sx,HOTEL.y0*sy,(HOTEL.x1-HOTEL.x0+1)*sx,(HOTEL.y1-HOTEL.y0+1)*sy);

    // hood
    const {HOOD_H, HOOD_V, HOUSES, HOOD_PARK} = hoodRects(a);
    ctx.fillStyle='#8a95a3';
    HOOD_H.forEach(y=> ctx.fillRect(a.un.x0*sx, y*sy, (a.un.x1-a.un.x0+1)*sx, 1.4*sy));
    HOOD_V.forEach(x=> ctx.fillRect(x*sx, a.un.y0*sy, 1.4*sx, (a.un.y1-a.un.y0+1)*sy));
    ctx.fillStyle=COL.hoodPark; ctx.fillRect(HOOD_PARK.x0*sx,HOOD_PARK.y0*sy,(HOOD_PARK.x1-HOOD_PARK.x0+1)*sx,(HOOD_PARK.y1-HOOD_PARK.y0+1)*sy);
    ctx.fillStyle=COL.house; HOUSES.forEach(h=> ctx.fillRect(h.x0*sx,h.y0*sy,(h.x1-h.x0+1)*sx,(h.y1-h.y0+1)*sy));
  }
  IZZA.on('render-post', ()=>{ if(isTier2()){ paintOverlay('minimap'); paintOverlay('bigmap'); } });

})();
