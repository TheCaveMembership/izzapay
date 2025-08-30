// downtown_clip_safe_layout.js — Tier-2 expansion
// Roads may enter Tier-1, but never paint over HQ/Shop/doors or the lake.
// All roads (H/V + diagonal) have sidewalks.

(function () {
  const TIER_KEY = 'izzaMapTier';

  // ===== Palette =====
  const COL = {
    grass:'#09371c',
    road:'#2a2a2a', dash:'#ffd23f', sidewalk:'#6a727b',
    civic:'#405a85', police:'#0a2455', shop:'#203a60', park:'#7db7d9',
    water:'#1a4668', sand:'#e0c27b', wood:'#6b4a2f', hotel:'#284b7a',
    house:'#175d2f', hoodPark:'#135c33'
  };
  const isTier2 = ()=> localStorage.getItem(TIER_KEY)==='2';

  // ===== Core anchors (match your core math) =====
  function unlockedRect(t){ return (t!=='2') ? {x0:18,y0:18,x1:72,y1:42} : {x0:10,y0:12,x1:80,y1:50}; }
  function anchors(api){
    const tier = localStorage.getItem(TIER_KEY)||'1';
    const un = unlockedRect(tier);

    const bW=10,bH=6;
    const bX = Math.floor((un.x0+un.x1)/2) - Math.floor(bW/2);
    const bY = un.y0 + 5;

    const hRoadY       = bY + bH + 1;
    const sidewalkTopY = hRoadY - 1;

    const vRoadX         = Math.min(un.x1-3, bX + bW + 6);
    const vSidewalkRightX= vRoadX + 1;

    const shop = { w:8, h:5, x:vSidewalkRightX+1, y: sidewalkTopY-5 };

    // keep-clear boxes (1-tile buffer)
    const BUFF=1;
    const HQ  = {x0:bX-BUFF, y0:bY-BUFF, x1:bX+bW-1+BUFF, y1:bY+bH-1+BUFF};
    const SH  = {x0:shop.x-BUFF, y0:shop.y-BUFF, x1:shop.x+shop.w-1+BUFF, y1:shop.y+shop.h-1+BUFF};

    // door/register tiles (keep clear)
    const door      = { gx: bX + Math.floor(bW/2), gy: sidewalkTopY };
    const register  = { gx: vSidewalkRightX, gy: sidewalkTopY };

    return {un,bX,bY,bW,bH,hRoadY,vRoadX,shop,HQ,SH,door,register};
  }

  // ===== Utility =====
  const scl = api => api.DRAW/api.TILE;
  const w2sX=(api,wx)=>(wx-api.camera.x)*scl(api);
  const w2sY=(api,wy)=>(wy-api.camera.y)*scl(api);
  function fillTile(api,ctx,gx,gy,color){
    const S=api.DRAW, sx=w2sX(api,gx*api.TILE), sy=w2sY(api,gy*api.TILE);
    ctx.fillStyle=color; ctx.fillRect(sx,sy,S,S);
  }
  const inflate=(r,d)=>({x0:r.x0-d,y0:r.y0-d,x1:r.x1+d,y1:r.y1+d});
  const rectW = r => r.x1-r.x0+1;
  const rectH = r => r.y1-r.y0+1;
  const overlaps=(a,b)=>!(a.x1<b.x0||a.x0>b.x1||a.y1<b.y0||a.y0>b.y1);
  const inRect=(gx,gy,R)=> gx>=R.x0&&gx<=R.x1&&gy>=R.y0&&gy<=R.y1;

  // ===== Fixed lakefront & neighborhood =====
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

  const _isDock=(gx,gy)=> DOCKS.some(d=> gy===d.y && gx>=d.x0 && gx<=d.x0+d.len-1);
  const _isWater=(gx,gy)=> inRect(gx,gy,LAKE) && !_isDock(gx,gy);

  // ===== Downtown layout to match your screenshot =====
  function proposeDowntown(a){
    const {un,hRoadY,vRoadX} = a;
    const L=un.x0+1,R=un.x1-1,T=un.y0+1,B=un.y1-1;

    const topY=hRoadY-6, midY=hRoadY, botY=hRoadY+6;
    const leftX=vRoadX-10, midX=vRoadX, rightX=vRoadX+10;

    const Hcand = [{y:topY,x0:L,x1:R},{y:midY,x0:L,x1:R},{y:botY,x0:L,x1:R}];
    const Vcand = [{x:leftX,y0:T,y1:B},{x:midX,y0:T,y1:B},{x:rightX,y0:T,y1:B}];

    // NW diagonal (road)
    const DIAG = { x0: L+3, y0: midY, x1: leftX+4, y1: topY-2 };

    // Buildings & pocket parks like the mock
    const BLD = [
      {x:midX-7, y:topY+1, w:6, h:3, color:COL.civic,  kind:'civic'},
      {x:midX+6, y:topY+2, w:4, h:3, color:COL.shop,   kind:'office'},
      {x:rightX+3, y:midY+1, w:3, h:2, color:COL.shop, kind:'annex'},
      {x:midX-2, y:midY-2, w:2, h:2, color:COL.shop,   kind:'kiosk'},
      {x:midX+2, y:midY-1, w:2, h:2, color:COL.shop,   kind:'kiosk'}
    ];
    const PARKS = [
      { x: leftX+1, y: midY-2, w:2, h:2 },
      { x: midX-9,  y: topY+1, w:2, h:2 }
    ];

    return {H:Hcand,V:Vcand,DIAG,BLD,PARKS};
  }

  // ===== Clip helpers (keep roads out of HQ/Shop doors + lake + new buildings) =====
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

  // frontage + sidewalks for buildings
  function frontageSide(b, H, V){
    function distToH(y){ let best=1e9; H.forEach(r=>{ best=Math.min(best, Math.abs(y - r.y)); }); return best; }
    function distToV(x){ let best=1e9; V.forEach(c=>{ best=Math.min(best, Math.abs(x - c.x)); }); return best; }
    return [
      {side:'top',   d:distToH(b.y-1)},
      {side:'bottom',d:distToH(b.y+b.h)},
      {side:'left',  d:distToV(b.x-1)},
      {side:'right', d:distToV(b.x+b.w)}
    ].sort((a,b)=>a.d-b.d)[0].side;
  }
  function sidewalksForBuildings(b, H, V){
    const ring=[];
    for(let x=b.x-1; x<=b.x+b.w; x++){ ring.push({x, y:b.y-1}); ring.push({x, y:b.y+b.h}); }
    for(let y=b.y-1; y<=b.y+b.h; y++){ ring.push({x:b.x-1, y}); ring.push({x:b.x+b.w, y}); }
    const side = frontageSide(b,H,V);
    const front=[];
    if(side==='top'){    for(let x=b.x; x<b.x+b.w; x++) front.push({x, y:b.y-1}); }
    if(side==='bottom'){ for(let x=b.x; x<b.x+b.w; x++) front.push({x, y:b.y+b.h}); }
    if(side==='left'){   for(let y=b.y; y<b.y+b.h; y++) front.push({x:b.x-1, y}); }
    if(side==='right'){  for(let y=b.y; y<b.y+b.h; y++) front.push({x:b.x+b.w, y}); }
    return {ring,front,side};
  }

  function makeSafeLayout(a){
    const P = proposeDowntown(a);

    const NO_ROAD = [
      inflate(a.HQ,0), inflate(a.SH,0),
      inflate({x0:a.door.gx,y0:a.door.gy,x1:a.door.gx,y1:a.door.gy},1),
      inflate({x0:a.register.gx,y0:a.register.gy,x1:a.register.gx,y1:a.register.gy},1),
      inflate(LAKE,0)
    ];

    const keep1=inflate(a.HQ,1), keep2=inflate(a.SH,1);
    const BUILDINGS = P.BLD.filter(b=>{
      const R={x0:b.x,y0:b.y,x1:b.x+b.w-1,y1:b.y+b.h-1};
      if(overlaps(R, keep1) || overlaps(R, keep2)) return false;
      if(overlaps(R, inflate(LAKE,0))) return false;
      return true;
    });

    const forbidForRoads = NO_ROAD.concat(BUILDINGS.map(b=>({x0:b.x,y0:b.y,x1:b.x+b.w-1,y1:b.y+b.h-1})));
    const H = P.H.flatMap(s=>clipH(s, forbidForRoads));
    const V = P.V.flatMap(s=>clipV(s, forbidForRoads));

    const B_SIDES = BUILDINGS.map(b=> sidewalksForBuildings(b,H,V));

    return {H_ROADS:H, V_ROADS:V, DIAG:P.DIAG, BUILDINGS, PARKS:P.PARKS, B_SIDES};
  }

  // ===== Draw roads with sidewalks (H/V + diagonal) =====
  function drawHRWithSW(api,ctx,y,x0,x1){
    for(let x=x0;x<=x1;x++){
      fillTile(api,ctx,x,y-1,COL.sidewalk);
      fillTile(api,ctx,x,y+1,COL.sidewalk);
      fillTile(api,ctx,x,y,COL.road);
      const S=api.DRAW, sx=w2sX(api,x*api.TILE), sy=w2sY(api,y*api.TILE);
      ctx.fillStyle=COL.dash;
      for(let i=0;i<4;i++) ctx.fillRect(sx+i*(S/4)+S*0.05, sy+S*0.48, S*0.10, S*0.04);
    }
  }
  function drawVRWithSW(api,ctx,x,y0,y1){
    for(let y=y0;y<=y1;y++){
      fillTile(api,ctx,x-1,y,COL.sidewalk);
      fillTile(api,ctx,x+1,y,COL.sidewalk);
      fillTile(api,ctx,x,y,COL.road);
    }
  }
  function drawDiagWithSW(api,ctx,seg){
    // Bresenham-ish walk; paint sidewalks offset perpendicularly
    const dx=seg.x1-seg.x0, dy=seg.y1-seg.y0;
    const steps=Math.max(Math.abs(dx),Math.abs(dy));
    const stepx=dx/steps, stepy=dy/steps;
    const sxi=Math.sign(dx)||1, syi=Math.sign(dy)||0;
    const px1=-syi, py1=sxi, px2=syi, py2=-sxi;

    let x=seg.x0, y=seg.y0;
    for(let i=0;i<=steps;i++){
      const gx=Math.round(x), gy=Math.round(y);
      // sidewalks first
      fillTile(api,ctx,gx+px1,gy+py1,COL.sidewalk);
      fillTile(api,ctx,gx+px2,gy+py2,COL.sidewalk);
      fillTile(api,ctx,gx,gy,COL.road);
      x+=stepx; y+=stepy;
    }
  }

  // ===== RENDER UNDER =====
  let _layout=null;

  IZZA.on('render-under', ()=>{
    if(!IZZA.api?.ready || !isTier2()) return;
    const api=IZZA.api;
    const ctx=document.getElementById('game').getContext('2d');

    const A=anchors(api);
    _layout = makeSafeLayout(A);

    // Sidewalks flanking axis-aligned roads + roads
    _layout.H_ROADS.forEach(r=> drawHRWithSW(api,ctx,r.y,r.x0,r.x1));
    _layout.V_ROADS.forEach(r=> drawVRWithSW(api,ctx,r.x,r.y0,r.y1));

    // Diagonal (with sidewalks)
    drawDiagWithSW(api,ctx,_layout.DIAG);

    // Building sidewalk buffers + frontage
    const seen = new Set();
    const mark=(gx,gy)=>{const k=gx+'|'+gy; if(seen.has(k)) return false; seen.add(k); return true;};
    _layout.B_SIDES.forEach(s=>{
      s.ring.forEach(p=>{ if(!_isWater(p.x,p.y) && mark(p.x,p.y)) fillTile(api,ctx,p.x,p.y,COL.sidewalk); });
      s.front.forEach(p=>{ if(!_isWater(p.x,p.y) && mark(p.x,p.y)) fillTile(api,ctx,p.x,p.y,COL.sidewalk); });
    });

    // helper to avoid painting over sidewalks/roads we just laid
    const onSWorRoad=(gx,gy)=>{
      if(seen.has(gx+'|'+gy)) return true;
      if(_layout.H_ROADS.some(r=> gy===r.y||gy===r.y-1||gy===r.y+1)) return true;
      if(_layout.V_ROADS.some(r=> gx===r.x||gx===r.x-1||gx===r.x+1)) return true;
      return false;
    };

    // Buildings (never on roads/sidewalks/water)
    _layout.BUILDINGS.forEach(b=>{
      for(let gy=b.y; gy<b.y+b.h; gy++)
        for(let gx=b.x; gx<b.x+b.w; gx++)
          if(!_isWater(gx,gy) && !onSWorRoad(gx,gy)) fillTile(api,ctx,gx,gy,b.color);
      // simple roof shade
      const sx=w2sX(api,b.x*api.TILE), sy=w2sY(api,b.y*api.TILE);
      ctx.fillStyle='rgba(0,0,0,.15)';
      ctx.fillRect(sx,sy, b.w*api.DRAW, Math.floor(b.h*api.DRAW*0.18));
    });

    // Pocket parks (clipped)
    _layout.PARKS.forEach(p=>{
      for(let gy=p.y; gy<p.y+p.h; gy++)
        for(let gx=p.x; gx<p.x+p.w; gx++)
          if(!_isWater(gx,gy) && !onSWorRoad(gx,gy)) fillTile(api,ctx,gx,gy,COL.park);
    });

    // Lake / beach / docks / hotel
    for(let gy=LAKE.y0; gy<=LAKE.y1; gy++)
      for(let gx=LAKE.x0; gx<=LAKE.x1; gx++)
        if(!_isDock(gx,gy)) fillTile(api,ctx,gx,gy,COL.water);
    for(let gy=LAKE.y0; gy<=LAKE.y1; gy++) fillTile(api,ctx,BEACH_X,gy,COL.sand);
    ctx.fillStyle=COL.wood;
    DOCKS.forEach(d=>{
      const S=api.DRAW, sx=w2sX(api,d.x0*api.TILE), sy=w2sY(api,d.y*api.TILE);
      ctx.fillRect(sx,sy, d.len*S, S);
    });
    for(let gy=HOTEL.y0; gy<=HOTEL.y1; gy++)
      for(let gx=HOTEL.x0; gx<=HOTEL.x1; gx++)
        fillTile(api,ctx,gx,gy,COL.hotel);

    // Neighborhood
    HOOD_H.forEach(y=>{
      for(let x=HOOD.x0; x<=HOOD.x1; x++){
        fillTile(api,ctx,x,y-1,COL.sidewalk);
        fillTile(api,ctx,x,y+1,COL.sidewalk);
      }
      for(let x=HOOD.x0; x<=HOOD.x1; x++) fillTile(api,ctx,x,y,COL.road);
    });
    HOOD_V.forEach(x=>{
      for(let y=HOOD.y0; y<=HOOD.y1; y++){
        fillTile(api,ctx,x-1,y,COL.sidewalk);
        fillTile(api,ctx,x+1,y,COL.sidewalk);
        fillTile(api,ctx,x,y,COL.road);
      }
    });
    for(let gy=HOOD_PARK.y0; gy<=HOOD_PARK.y1; gy++)
      for(let gx=HOOD_PARK.x0; gx<=HOOD_PARK.x1; gx++)
        fillTile(api,ctx,gx,gy,COL.hoodPark);
    HOUSES.forEach(h=>{
      for(let gy=h.y0; gy<=h.y1; gy++)
        for(let gx=h.x0; gx<=h.x1; gx++)
          fillTile(api,ctx,gx,gy,COL.house);
    });
  });

  // ===== Collision & movement integrations (unchanged) =====
  function solidRects(layout){
    const rects = [];
    layout.BUILDINGS.forEach(b=> rects.push({x:b.x,y:b.y,w:b.w,h:b.h}));
    rects.push({x:HOTEL.x0,y:HOTEL.y0,w:rectW(HOTEL),h:rectH(HOTEL)});
    HOUSES.forEach(h=> rects.push({x:h.x0,y:h.y0,w:rectW(h),h:rectH(h)}));
    return rects;
  }

  const _boats=[], _dockBoats=[]; let _towBoat=null, _inBoat=false, _ride=null, _lastLand=null;

  function spawnBoats(){
    if(!isTier2() || _boats.length) return;
    const L={x0:LAKE.x0+2,y0:LAKE.y0+2,x1:LAKE.x1-2,y1:LAKE.y1-2};
    const loop=(x,y,s,clockwise=true)=>{
      const path = clockwise
        ? [{x:L.x0,y:L.y0},{x:L.x1,y:L.y0},{x:L.x1,y:L.y1},{x:L.x0,y:L.y1}]
        : [{x:L.x1,y:L.y1},{x:L.x0,y:L.y1},{x:L.x0,y:L.y0},{x:L.x1,y:L.y0}];
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
    const api=IZZA.api, p=api.player, t=api.TILE;
    const gx=((p.x+16)/t)|0, gy=((p.y+16)/t)|0;

    if(!_isWater(gx,gy)) _lastLand = {x:p.x,y:p.y};
    else if(!_inBoat && _lastLand){ p.x=_lastLand.x; p.y=_lastLand.y; }

    if(_layout){
      api.cars.forEach(c=>{
        const cgx=(c.x/t)|0, cgy=(c.y/t)|0;
        const hit = _layout.BUILDINGS.some(b=> cgx>=b.x && cgx<b.x+b.w && cgy>=b.y && cgy<b.y+b.h);
        if(hit){ c.dir*=-1; c.x += c.dir*4; }
      });
    }

    if(_inBoat && _ride){ _ride.x = p.x/32; _ride.y = p.y/32; }
  });

  IZZA.on('update-pre', ({dtSec})=>{
    if(!IZZA.api?.ready || !isTier2()) return;
    _boats.forEach(b=>{
      const tgt=b.path[b.i], dx=tgt.x-b.x, dy=tgt.y-b.y, m=Math.hypot(dx,dy)||1, step=b.s*dtSec/32;
      if(m<=step){ b.x=tgt.x; b.y=tgt.y; b.i=(b.i+1)%b.path.length; }
      else{ b.x += (dx/m)*step; b.y += (dy/m)*step; }
    });
  });

  IZZA.on('update-post', ()=>{
    if(!IZZA.api?.ready || !isTier2() || !_layout) return;
    const api=IZZA.api, t=api.TILE, p=api.player;
    const gx=(p.x/t)|0, gy=(p.y/t)|0;

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

  // ===== Minimap / bigmap overlay (unchanged style) =====
  function paintOverlay(id){
    if(!_layout) return;
    const c=document.getElementById(id); if(!c) return;
    const ctx=c.getContext('2d');
    const sx=c.width/90, sy=c.height/60;

    ctx.fillStyle='#8a90a0';
    _layout.H_ROADS.forEach(r=> ctx.fillRect(r.x0*sx, r.y*sy, (r.x1-r.x0+1)*sx, 1.2*sy));
    _layout.V_ROADS.forEach(r=> ctx.fillRect(r.x*sx, r.y0*sy, 1.2*sx, (r.y1-r.y0+1)*sy));

    ctx.fillStyle='#6f87b3';
    _layout.BUILDINGS.forEach(b=> ctx.fillRect(b.x*sx,b.y*sy,b.w*sx,b.h*sy));

    ctx.fillStyle=COL.park;
    _layout.PARKS.forEach(p=> ctx.fillRect(p.x*sx,p.y*sy,p.w*sx,p.h*sy));

    ctx.fillStyle=COL.water;
    ctx.fillRect(LAKE.x0*sx,LAKE.y0*sy,(LAKE.x1-LAKE.x0+1)*sx,(LAKE.y1-LAKE.y0+1)*sy);
    ctx.fillStyle=COL.sand; ctx.fillRect(BEACH_X*sx, LAKE.y0*sy, 1*sx, (LAKE.y1-LAKE.y0+1)*sy);
    ctx.fillStyle=COL.wood; DOCKS.forEach(d=> ctx.fillRect(d.x0*sx, d.y*sy, d.len*sx, 1*sy));
    ctx.fillStyle=COL.hotel; ctx.fillRect(HOTEL.x0*sx,HOTEL.y0*sy,(HOTEL.x1-HOTEL.x0+1)*sx,(HOTEL.y1-HOTEL.y0+1)*sy);

    ctx.fillStyle='#8a95a3';
    HOOD_H.forEach(y=> ctx.fillRect(HOOD.x0*sx, y*sy, (HOOD.x1-HOOD.x0+1)*sx, 1.4*sy));
    HOOD_V.forEach(x=> ctx.fillRect(x*sx, HOOD.y0*sy, 1.4*sx, (HOOD.y1-HOOD.y0+1)*sy));
    ctx.fillStyle=COL.hoodPark; ctx.fillRect(HOOD_PARK.x0*sx,HOOD_PARK.y0*sy,(HOOD_PARK.x1-HOOD_PARK.x0+1)*sx,(HOOD_PARK.y1-HOOD_PARK.y0+1)*sy);
    ctx.fillStyle='#5f91a5'; HOUSES.forEach(h=> ctx.fillRect(h.x0*sx,h.y0*sy,(h.x1-h.x0+1)*sx,(h.y1-h.y0+1)*sy));
  }
  IZZA.on('render-post', ()=>{ if(isTier2()) { paintOverlay('minimap'); paintOverlay('bigmap'); } });

})();
