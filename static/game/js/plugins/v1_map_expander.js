// downtown_clip_safe_layout.js — Tier-2 expansion with realistic rules
(function () {
  const TIER_KEY = 'izzaMapTier';

  // ===== Palette =====
  const COL = {
    grass:'#09371c',
    road:'#2a2a2a', dash:'#ffd23f', sidewalk:'#6a727b',
    civic:'#405a85', police:'#0a2455', shop:'#203a60', park:'#2b6a7a',
    water:'#1a4668', sand:'#e0c27b', wood:'#6b4a2f', hotel:'#284b7a',
    house:'#175d2f', hoodPark:'#135c33'
  };

  const isTier2 = ()=> localStorage.getItem(TIER_KEY)==='2';

  // ===== Core anchors (match your core’s math) =====
  function unlockedRect(t){ return (t!=='2') ? {x0:18,y0:18,x1:72,y1:42} : {x0:10,y0:12,x1:80,y1:50}; }
  function anchors(api){
    const tier = localStorage.getItem(TIER_KEY)||'1';
    const un = unlockedRect(tier);

    // HQ / shop derived the same way your core does
    const bW=10,bH=6;
    const bX = Math.floor((un.x0+un.x1)/2) - Math.floor(bW/2);
    const bY = un.y0 + 5;

    const hRoadY       = bY + bH + 1;
    const sidewalkTopY = hRoadY - 1;

    const vRoadX         = Math.min(un.x1-3, bX + bW + 6);
    const vSidewalkRightX= vRoadX + 1;

    const shop = { w:8, h:5, x:vSidewalkRightX+1, y: sidewalkTopY-5 };

    // “no paint” (with 1-tile buffer)
    const BUFF=1;
    const HQ  = {x0:bX-BUFF, y0:bY-BUFF, x1:bX+bW-1+BUFF, y1:bY+bH-1+BUFF};
    const SH  = {x0:shop.x-BUFF, y0:shop.y-BUFF, x1:shop.x+shop.w-1+BUFF, y1:shop.y+shop.h-1+BUFF};

    // door/register tiles (keep clear)
    const door      = { gx: bX + Math.floor(bW/2), gy: sidewalkTopY };
    const register  = { gx: vSidewalkRightX, gy: sidewalkTopY };

    return {un,bX,bY,bW,bH,hRoadY,vRoadX,shop,HQ,SH,door,register};
  }

  // ===== Utility =====
  const inflate=(r,d)=>({x0:r.x0-d,y0:r.y0-d,x1:r.x1+d,y1:r.y1+d});
  const rectW = r => r.x1-r.x0+1;
  const rectH = r => r.y1-r.y0+1;
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));

  // Simple overlap test
  function overlaps(a,b){
    return !(a.x1<b.x0 || a.x0>b.x1 || a.y1<b.y0 || a.y0>b.y1);
  }

  // Tile helpers (screen-space)
  const scl = api => api.DRAW/api.TILE;
  const w2sX=(api,wx)=>(wx-api.camera.x)*scl(api);
  const w2sY=(api,wy)=>(wy-api.camera.y)*scl(api);
  function fillTile(api,ctx,gx,gy,color){
    const S=api.DRAW, sx=w2sX(api,gx*api.TILE), sy=w2sY(api,gy*api.TILE);
    ctx.fillStyle=color; ctx.fillRect(sx,sy,S,S);
  }

  // ===== Fixed lakefront & neighborhood (zones) =====
  // Keep within Tier-2 bounds
  const LAKE   = { x0:67, y0:35, x1:81, y1:49 };
  const BEACH_X= LAKE.x0 - 1;
  const DOCKS  = [
    { x0: LAKE.x0, y: LAKE.y0+4,  len: 3 },
    { x0: LAKE.x0, y: LAKE.y0+12, len: 4 },
  ];
  const HOTEL  = { x0: LAKE.x0+2, y0: LAKE.y0-5, x1: LAKE.x0+8, y1: LAKE.y0-1 };

  const HOOD   = { x0:12, y0:42, x1:34, y1:50 };
  const HOOD_H = [ HOOD.y0+2, HOOD.y0+6 ];
  const HOOD_V = [ HOOD.x0+8, HOOD.x0+16 ];
  const HOUSES = [
    {x0:HOOD.x0+2,y0:HOOD.y0+3,x1:HOOD.x0+4,y1:HOOD.y0+4},
    {x0:HOOD.x0+10,y0:HOOD.y0+3,x1:HOOD.x0+12,y1:HOOD.y0+4},
    {x0:HOOD.x0+18,y0:HOOD.y0+3,x1:HOOD.x0+20,y1:HOOD.y0+4},
    {x0:HOOD.x0+4,y0:HOOD.y0+8,x1:HOOD.x0+6,y1:HOOD.y0+9},
    {x0:HOOD.x0+12,y0:HOOD.y0+8,x1:HOOD.x0+14,y1:HOOD.y0+9}
  ];
  const HOOD_PARK = { x0: HOOD.x0+22, y0: HOOD.y0+6, x1: HOOD.x0+26, y1: HOOD.y0+9 };

  const _inRect=(gx,gy,R)=> gx>=R.x0 && gx<=R.x1 && gy>=R.y0 && gy<=R.y1;
  const _isDock=(gx,gy)=> DOCKS.some(d=> gy===d.y && gx>=d.x0 && gx<=d.x0+d.len-1);
  // Important: docks are NOT water, so you can walk on them
  const _isWater=(gx,gy)=> _inRect(gx,gy,LAKE) && !_isDock(gx,gy);

  // ===== Road proposal with realism rules =====
  function proposeDowntown(a){
    const {un,hRoadY,vRoadX} = a;
    const L=un.x0+1,R=un.x1-1,T=un.y0+1,B=un.y1-1;

    // Grid (compact downtown core)
    const Hcand = [ hRoadY-6, hRoadY, hRoadY+6 ]
      .map(y=>({y, x0:L, x1:R}));
    const Vcand = [ vRoadX-9, vRoadX, vRoadX+9 ]
      .map(x=>({x, y0:T, y1:B}));

    // Buildings inside the blocks (don’t touch roads later; we’ll buffer sidewalks)
    const BLD = [
      {x:vRoadX+11, y:hRoadY-9, w:6, h:3, color:COL.civic, kind:'civic'},
      {x:vRoadX+6,  y:hRoadY+2, w:4, h:3, color:COL.police, kind:'police'},
      {x:vRoadX+8,  y:hRoadY+9, w:7, h:4, color:COL.shop,   kind:'mall'},
      {x:vRoadX-14, y:hRoadY+2, w:3, h:2, color:COL.shop,   kind:'shop'},
      {x:vRoadX-6,  y:hRoadY-2, w:3, h:2, color:COL.shop,   kind:'shop'}
    ];

    // Park in an interior block
    const PARK = { x:vRoadX-3, y:hRoadY+8, w:6, h:4 };

    return {H:Hcand,V:Vcand,BLD,PARK};
  }

  // Clip a horizontal road against forbidden rectangles
  function clipH(seg, forbidden){
    let parts=[{y:seg.y,x0:seg.x0,x1:seg.x1}];
    forbidden.forEach(R=>{
      parts=parts.flatMap(p=>{
        if(p.y<R.y0||p.y>R.y1||p.x1<R.x0||p.x0>R.x1) return [p];
        const out=[];
        if(p.x0<R.x0) out.push({y:p.y,x0:p.x0,x1:Math.max(p.x0,R.x0-1)});
        if(p.x1>R.x1) out.push({y:p.y,x0:Math.min(p.x1,R.x1+1),x1:p.x1});
        return out;
      });
    });
    return parts.filter(p=>p.x1>=p.x0);
  }
  // Clip a vertical road against forbidden rectangles
  function clipV(seg, forbidden){
    let parts=[{x:seg.x,y0:seg.y0,y1:seg.y1}];
    forbidden.forEach(R=>{
      parts=parts.flatMap(p=>{
        if(p.x<R.x0||p.x>R.x1||p.y1<R.y0||p.y0>R.y1) return [p];
        const out=[];
        if(p.y0<R.y0) out.push({x:p.x,y0:p.y0,y1:Math.max(p.y0,R.y0-1)});
        if(p.y1>R.y1) out.push({x:p.x,y0:Math.min(p.y1,R.y1+1),y1:p.y1});
        return out;
      });
    });
    return parts.filter(p=>p.y1>=p.y0);
  }

  // Determine nearest side of a building to any road (for "front sidewalk")
  function frontageSide(b, H, V){
    // distance to nearest horizontal centerline and vertical centerline
    function distToH(y){ // building bottom outside is y=b.y+b.h (one row below)
      const cy = y;
      let best=1e9;
      H.forEach(r=>{ best=Math.min(best, Math.abs(cy - r.y)); });
      return best;
    }
    function distToV(x){
      const cx = x;
      let best=1e9;
      V.forEach(c=>{ best=Math.min(best, Math.abs(cx - c.x)); });
      return best;
    }
    const dTop    = distToH(b.y-1);
    const dBottom = distToH(b.y + b.h);
    const dLeft   = distToV(b.x-1);
    const dRight  = distToV(b.x + b.w);

    const entries = [
      {side:'top',d:dTop},
      {side:'bottom',d:dBottom},
      {side:'left',d:dLeft},
      {side:'right',d:dRight}
    ].sort((a,b)=>a.d-b.d);
    return entries[0].side;
  }

  // Make sidewalks around buildings (ring) and guaranteed 1-row frontage sidewalk
  function sidewalksForBuildings(b, H, V){
    const ring=[];
    // 1-tile ring (buffer) all around
    for(let x=b.x-1; x<=b.x+b.w; x++){ ring.push({x, y:b.y-1}); ring.push({x, y:b.y+b.h}); }
    for(let y=b.y-1; y<=b.y+b.h; y++){ ring.push({x:b.x-1, y}); ring.push({x:b.x+b.w, y}); }

    const side = frontageSide(b,H,V);
    const front=[];
    if(side==='top'){
      for(let x=b.x; x<b.x+b.w; x++) front.push({x, y:b.y-1});
    }else if(side==='bottom'){
      for(let x=b.x; x<b.x+b.w; x++) front.push({x, y:b.y+b.h});
    }else if(side==='left'){
      for(let y=b.y; y<b.y+b.h; y++) front.push({x:b.x-1, y});
    }else{ // right
      for(let y=b.y; y<b.y+b.h; y++) front.push({x:b.x+b.w, y});
    }
    return {ring,front,side};
  }

  // ===== Convert proposal → safe layout with realism filters =====
  function makeSafeLayout(a){
    const P = proposeDowntown(a);

    // 1) Never run roads through HQ, Shop, their doors, or **Lake area**
    const NO_ROAD = [
      inflate(a.HQ,0), inflate(a.SH,0),
      inflate({x0:a.door.gx,y0:a.door.gy,x1:a.door.gx,y1:a.door.gy},1),
      inflate({x0:a.register.gx,y0:a.register.gy,x1:a.register.gx,y1:a.register.gy},1),
      inflate(LAKE,0) // << keep roads out of water
    ];

    // Place buildings first but keep them away from HQ/Shop by 1 tile
    const keep1=inflate(a.HQ,1), keep2=inflate(a.SH,1);
    const BUILDINGS = P.BLD.filter(b=>{
      const R={x0:b.x,y0:b.y,x1:b.x+b.w-1,y1:b.y+b.h-1};
      if(overlaps(R, keep1) || overlaps(R, keep2)) return false;
      if(overlaps(R, inflate(LAKE,0))) return false; // no buildings in lake
      return true;
    });

    // 2) Clip roads against NO_ROAD + building boxes (so roads never end in a wall)
    const forbidForRoads = NO_ROAD.concat(BUILDINGS.map(b=>({x0:b.x,y0:b.y,x1:b.x+b.w-1,y1:b.y+b.h-1})));
    const H = P.H.flatMap(s=>clipH(s, forbidForRoads));
    const V = P.V.flatMap(s=>clipV(s, forbidForRoads));

    // 3) Generate per-building sidewalk ring + frontage sidewalks (dedup later)
    const B_SIDES = BUILDINGS.map(b=> sidewalksForBuildings(b,H,V));

    return {H_ROADS:H, V_ROADS:V, BUILDINGS, PARK:P.PARK, B_SIDES};
  }

  // ===== Drawing helpers for roads =====
  function drawHRoad(api,ctx,y,x0,x1){
    for(let x=x0;x<=x1;x++){
      fillTile(api,ctx,x,y,COL.road);
      const S=api.DRAW, sx=w2sX(api,x*api.TILE), sy=w2sY(api,y*api.TILE);
      ctx.fillStyle=COL.dash;
      for(let i=0;i<4;i++) ctx.fillRect(sx+i*(S/4)+S*0.05, sy+S*0.48, S*0.10, S*0.04);
    }
  }
  function drawVRoad(api,ctx,x,y0,y1){
    for(let y=y0;y<=y1;y++) fillTile(api,ctx,x,y,COL.road);
  }

  // ===== RENDER UNDER =====
  let _layout=null;

  IZZA.on('render-under', ()=>{
    if(!IZZA.api?.ready || !isTier2()) return;
    const api=IZZA.api;
    const ctx=document.getElementById('game').getContext('2d');

    // Compute layout each frame (cheap; keeps in sync with camera & hooks)
    const A=anchors(api);
    _layout = makeSafeLayout(A);

    // 1) Sidewalks flanking every road tile
    _layout.H_ROADS.forEach(r=>{
      for(let x=r.x0;x<=r.x1;x++){
        fillTile(api,ctx,x,r.y-1,COL.sidewalk);
        fillTile(api,ctx,x,r.y+1,COL.sidewalk);
      }
    });
    _layout.V_ROADS.forEach(r=>{
      for(let y=r.y0;y<=r.y1;y++){
        fillTile(api,ctx,r.x-1,y,COL.sidewalk);
        fillTile(api,ctx,r.x+1,y,COL.sidewalk);
      }
    });

    // 2) Downtown roads
    _layout.H_ROADS.forEach(r=> drawHRoad(api,ctx,r.y,r.x0,r.x1));
    _layout.V_ROADS.forEach(r=> drawVRoad(api,ctx,r.x,r.y0,r.y1));

    // 3) Building sidewalk buffers + frontage
    const seenSW = new Set();
    const mark = (gx,gy)=>{
      const key=gx+'|'+gy; if(seenSW.has(key)) return false; seenSW.add(key); return true;
    };
    _layout.B_SIDES.forEach(s=>{
      s.ring.forEach(p=>{ if(!_isWater(p.x,p.y) && mark(p.x,p.y)) fillTile(api,ctx,p.x,p.y,COL.sidewalk); });
      s.front.forEach(p=>{ if(!_isWater(p.x,p.y) && mark(p.x,p.y)) fillTile(api,ctx,p.x,p.y,COL.sidewalk); });
    });

    // 4) Buildings (on grass only, never on roads/sidewalks/water)
    // --- keep these where they already are ---
const onSidewalkOrRoad = (gx,gy)=>{
  if(_layout.H_ROADS.some(r=> gy===r.y || gy===r.y-1 || gy===r.y+1)) return true;
  if(_layout.V_ROADS.some(r=> gx===r.x || gx===r.x-1 || gx===r.x+1)) return true;
  return false;
};

// 5) Park (downtown) — CLIPPED so it never paints over roads/sidewalks/water
if(_layout.PARK){
  const p=_layout.PARK;
  for(let gy=p.y; gy<p.y+p.h; gy++){
    for(let gx=p.x; gx<p.x+p.w; gx++){
      if(!_isWater(gx,gy) && !onSidewalkOrRoad(gx,gy)){
        fillTile(api,ctx,gx,gy,COL.park);
      }
    }
  }
}
    _layout.BUILDINGS.forEach(b=>{
      for(let gy=b.y; gy<b.y+b.h; gy++)
        for(let gx=b.x; gx<b.x+b.w; gx++)
          if(!_isWater(gx,gy) && !onSidewalkOrRoad(gx,gy)) fillTile(api,ctx,gx,gy,b.color);
      // roof shade
      const sx=w2sX(api,b.x*api.TILE), sy=w2sY(api,b.y*api.TILE);
      ctx.fillStyle='rgba(0,0,0,.15)';
      ctx.fillRect(sx,sy, b.w*api.DRAW, Math.floor(b.h*api.DRAW*0.18));
    });

    // 5) Park (downtown)
    if(_layout.PARK){
      const p=_layout.PARK;
      for(let gy=p.y; gy<p.y+p.h; gy++)
        for(let gx=p.x; gx<p.x+p.w; gx++)
          if(!_isWater(gx,gy)) fillTile(api,ctx,gx,gy,COL.park);
    }

    // 6) Lake
    for(let gy=LAKE.y0; gy<=LAKE.y1; gy++)
      for(let gx=LAKE.x0; gx<=LAKE.x1; gx++)
        if(!_isDock(gx,gy)) fillTile(api,ctx,gx,gy,COL.water);

    // 7) Beach strip
    for(let gy=LAKE.y0; gy<=LAKE.y1; gy++) fillTile(api,ctx,BEACH_X,gy,COL.sand);

    // 8) Docks (WALKABLE ground on water edge)
    ctx.fillStyle=COL.wood;
    DOCKS.forEach(d=>{
      const S=api.DRAW, sx=w2sX(api,d.x0*api.TILE), sy=w2sY(api,d.y*api.TILE);
      ctx.fillRect(sx,sy, d.len*S, S);
    });

    // 9) Hotel (place above beach; has its own collision later)
    for(let gy=HOTEL.y0; gy<=HOTEL.y1; gy++)
      for(let gx=HOTEL.x0; gx<=HOTEL.x1; gx++)
        fillTile(api,ctx,gx,gy,COL.hotel);

    // 10) Neighborhood: roads + sidewalks
    HOOD_H.forEach(y=>{
      for(let x=HOOD.x0; x<=HOOD.x1; x++){
        fillTile(api,ctx,x,y-1,COL.sidewalk);
        fillTile(api,ctx,x,y+1,COL.sidewalk);
      }
    });
    HOOD_V.forEach(x=>{
      for(let y=HOOD.y0; y<=HOOD.y1; y++){
        fillTile(api,ctx,x-1,y,COL.sidewalk);
        fillTile(api,ctx,x+1,y,COL.sidewalk);
      }
    });
    HOOD_H.forEach(y=> drawHRoad(api,ctx,y,HOOD.x0,HOOD.x1));
    HOOD_V.forEach(x=> drawVRoad(api,ctx,x,HOOD.y0,HOOD.y1));

    // 11) Hood park
    for(let gy=HOOD_PARK.y0; gy<=HOOD_PARK.y1; gy++)
      for(let gx=HOOD_PARK.x0; gx<=HOOD_PARK.x1; gx++)
        fillTile(api,ctx,gx,gy,COL.hoodPark);

    // 12) Houses
    HOUSES.forEach(h=>{
      for(let gy=h.y0; gy<=h.y1; gy++)
        for(let gx=h.x0; gx<=h.x1; gx++)
          fillTile(api,ctx,gx,gy,COL.house);
    });
  });

  // ===== Collision & movement integrations =====
  function solidRects(layout){
    const rects = [];
    // New downtown buildings
    layout.BUILDINGS.forEach(b=> rects.push({x:b.x,y:b.y,w:b.w,h:b.h}));
    // Hotel + houses
    rects.push({x:HOTEL.x0,y:HOTEL.y0,w:rectW(HOTEL),h:rectH(HOTEL)});
    HOUSES.forEach(h=> rects.push({x:h.x0,y:h.y0,w:rectW(h),h:rectH(h)}));
    return rects;
  }

  // Keep cars off new buildings; player collides with solids
  IZZA.on('update-pre', ({dtSec})=>{
    if(!IZZA.api?.ready || !isTier2()) return;
    const api=IZZA.api, p=api.player, t=api.TILE;

    // Water guard: allow walking on docks and beach; block only true water
    const gx=((p.x+16)/t)|0, gy=((p.y+16)/t)|0;
    if(!_isWater(gx,gy)) _lastLand = {x:p.x,y:p.y};
    else if(!_inBoat && _lastLand){ p.x=_lastLand.x; p.y=_lastLand.y; }

    // Cars bounce if hitting any building
    if(_layout){
      api.cars.forEach(c=>{
        const cgx=(c.x/t)|0, cgy=(c.y/t)|0;
        const hit = _layout.BUILDINGS.some(b=> cgx>=b.x && cgx<b.x+b.w && cgy>=b.y && cgy<b.y+b.h);
        if(hit){ c.dir*=-1; c.x += c.dir*4; }
      });
    }

    if(_inBoat && _ride){ _ride.x = p.x/32; _ride.y = p.y/32; }
  });

  IZZA.on('update-post', ()=>{
    if(!IZZA.api?.ready || !isTier2() || !_layout) return;
    const api=IZZA.api, t=api.TILE, p=api.player;
    const gx=(p.x/t)|0, gy=(p.y/t)|0;

    // Unified solids: all new buildings (downtown + hotel + houses)
    const solids = solidRects(_layout);
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

  // ===== Boats (NPC + player boating) =====
  const _boats=[], _dockBoats=[]; let _towBoat=null, _inBoat=false, _ride=null, _lastLand=null;

  function spawnBoats(){
    if(!isTier2() || _boats.length) return;
    const L={x0:LAKE.x0+2,y0:LAKE.y0+2,x1:LAKE.x1-2,y1:LAKE.y1-2};
    const loop=(x,y,s,clockwise=true)=>{
      const path = clockwise
        ? [{x:L.x0,y:L.y0},{x:L.x1,y:L.y0},{x:L.x1,y:L.y1},{x:L.x0,y:L.y1}]
        : [{x:L.x1,y:L.y1},{x:L.x0,y:L.y1},{x:L.x0,y:L.y0},{x:L.x1,y:L.y0}];
      // nudge left-edge waypoints off dock rows
      const dockYs = new Set(DOCKS.map(d=>d.y));
      path.forEach(pt=>{ if(pt.x===L.x0 && dockYs.has(pt.y)) pt.y += 1; });
      return {x,y,s,i:0,path};
    };
    _boats.push(loop(L.x0, L.y0, 55, true));
    _towBoat = loop(L.x0+1, L.y1-1, 52, true); _boats.push(_towBoat);
    DOCKS.forEach(d=> _dockBoats.push({x:d.x0+Math.floor(d.len/2), y:d.y, s:120, taken:false}));
  }
  IZZA.on('ready', spawnBoats);

  IZZA.on('update-pre', ({dtSec})=>{
    if(!IZZA.api?.ready || !isTier2()) return;
    // move boats
    _boats.forEach(b=>{
      const tgt=b.path[b.i], dx=tgt.x-b.x, dy=tgt.y-b.y, m=Math.hypot(dx,dy)||1, step=b.s*dtSec/32;
      if(m<=step){ b.x=tgt.x; b.y=tgt.y; b.i=(b.i+1)%b.path.length; }
      else{ b.x += (dx/m)*step; b.y += (dy/m)*step; }
    });
  });

  function _enterBoat(){
    if(_inBoat || !isTier2()) return;
    const p=IZZA.api.player, t=IZZA.api.TILE, gx=((p.x+16)/t)|0, gy=((p.y+16)/t)|0;
    if(!_isDock(gx,gy)) return;
    let best=null,bd=9e9;
    _dockBoats.forEach(b=>{ if(b.taken) return; const d=Math.hypot(b.x-gx,b.y-gy); if(d<bd){bd=d; best=b;} });
    if(best && bd<=2){ best.taken=true; _ride=best; _inBoat=true; IZZA.api.player.speed=120; }
  }
  function _leaveBoat(){
    if(!_inBoat) return;
    const p=IZZA.api.player, t=IZZA.api.TILE, gx=((p.x+16)/t)|0, gy=((p.y+16)/t)|0;
    if(_isDock(gx,gy) || gx===BEACH_X){ _ride.taken=false; _ride=null; _inBoat=false; IZZA.api.player.speed=90; }
  }
  document.getElementById('btnB')?.addEventListener('click', ()=>{ _inBoat? _leaveBoat() : _enterBoat(); });
  window.addEventListener('keydown', e=>{ if(e.key.toLowerCase()==='b'){ _inBoat? _leaveBoat() : _enterBoat(); } });

  // draw boats & wakeboarder under sprites
  IZZA.on('render-under', ()=>{
    if(!IZZA.api?.ready || !isTier2()) return;
    const api=IZZA.api, ctx=document.getElementById('game').getContext('2d');
    const S=api.DRAW, t=api.TILE, f=S/t;
    const sx=gx=> (gx*t - api.camera.x)*f, sy=gy=> (gy*t - api.camera.y)*f;
    const drawBoat=(gx,gy)=>{ ctx.fillStyle='#7ca7c7'; ctx.fillRect(sx(gx)+S*0.2, sy(gy)+S*0.35, S*0.6, S*0.3); };
    _boats.forEach(b=> drawBoat(b.x,b.y));
    _dockBoats.forEach(b=> drawBoat(b.x,b.y));
    if(_towBoat){
      const tgt=_towBoat.path[_towBoat.i], vx=tgt.x-_towBoat.x, vy=tgt.y-_towBoat.y, m=Math.hypot(vx,vy)||1;
      const wx=_towBoat.x - (vx/m)*2.2, wy=_towBoat.y - (vy/m)*2.2;
      // rope
      ctx.strokeStyle = '#dfe9ef'; ctx.lineWidth = Math.max(1, S*0.04);
      ctx.beginPath(); ctx.moveTo(sx(_towBoat.x)+S*0.5, sy(_towBoat.y)+S*0.5);
      ctx.lineTo(sx(wx)+S*0.5,       sy(wy)+S*0.5); ctx.stroke();
      // wakeboarder
      ctx.fillStyle='#23d3c6'; ctx.fillRect(sx(wx)+S*0.33, sy(wy)+S*0.33, S*0.34, S*0.34);
    }
  });

  // ===== Minimap / bigmap overlay after core draws =====
  function paintOverlay(id){
    if(!_layout) return;
    const c=document.getElementById(id); if(!c) return;
    const ctx=c.getContext('2d');
    const sx=c.width/90, sy=c.height/60;

    // grid
    ctx.fillStyle='#8a90a0';
    _layout.H_ROADS.forEach(r=> ctx.fillRect(r.x0*sx, r.y*sy, (r.x1-r.x0+1)*sx, 1.2*sy));
    _layout.V_ROADS.forEach(r=> ctx.fillRect(r.x*sx, r.y0*sy, 1.2*sx, (r.y1-r.y0+1)*sy));

    // buildings
    ctx.fillStyle='#6f87b3';
    _layout.BUILDINGS.forEach(b=> ctx.fillRect(b.x*sx,b.y*sy,b.w*sx,b.h*sy));

    // park
    if(_layout.PARK){
      const p=_layout.PARK;
      ctx.fillStyle='#7db7d9'; ctx.fillRect(p.x*sx,p.y*sy,p.w*sx,p.h*sy);
    }

    // lake / beach / docks / hotel
    ctx.fillStyle=COL.water;
    ctx.fillRect(LAKE.x0*sx,LAKE.y0*sy,(LAKE.x1-LAKE.x0+1)*sx,(LAKE.y1-LAKE.y0+1)*sy);
    ctx.fillStyle=COL.sand; ctx.fillRect(BEACH_X*sx, LAKE.y0*sy, 1*sx, (LAKE.y1-LAKE.y0+1)*sy);
    ctx.fillStyle=COL.wood; DOCKS.forEach(d=> ctx.fillRect(d.x0*sx, d.y*sy, d.len*sx, 1*sy));
    ctx.fillStyle=COL.hotel; ctx.fillRect(HOTEL.x0*sx,HOTEL.y0*sy,(HOTEL.x1-HOTEL.x0+1)*sx,(HOTEL.y1-HOTEL.y0+1)*sy);

    // neighborhood
    ctx.fillStyle='#8a95a3';
    HOOD_H.forEach(y=> ctx.fillRect(HOOD.x0*sx, y*sy, (HOOD.x1-HOOD.x0+1)*sx, 1.4*sy));
    HOOD_V.forEach(x=> ctx.fillRect(x*sx, HOOD.y0*sy, 1.4*sx, (HOOD.y1-HOOD.y0+1)*sy));
    ctx.fillStyle=COL.hoodPark; ctx.fillRect(HOOD_PARK.x0*sx,HOOD_PARK.y0*sy,(HOOD_PARK.x1-HOOD_PARK.x0+1)*sx,(HOOD_PARK.y1-HOOD_PARK.y0+1)*sy);

    // houses
    ctx.fillStyle='#5f91a5'; HOUSES.forEach(h=> ctx.fillRect(h.x0*sx,h.y0*sy,(h.x1-h.x0+1)*sx,(h.y1-h.y0+1)*sy));
  }

  IZZA.on('render-post', ()=>{
    if(!isTier2()) return;
    paintOverlay('minimap');
    paintOverlay('bigmap');
  });

})();
