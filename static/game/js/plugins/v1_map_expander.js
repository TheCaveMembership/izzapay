// downtown_clip_safe_layout.js — Tier-2 expansion (safe clipping, no blue buildings, sidewalks everywhere)
(function () {
  const TIER_KEY = 'izzaMapTier';

  // ---------- Palette (non-blue buildings; blue only for water and explicit windows) ----------
  const COL = {
    grass:'#09371c',
    road:'#2a2a2a', dash:'#ffd23f', sidewalk:'#6a727b',
    // Building tones (neutral/brown/brick)
    civic:'#6a5f4b',     // neutral civic block
    police:'#5a3b3b',    // brick-ish police
    shop:'#6b4a2f',      // brown shop body (we’ll draw light windows on top)
    park:'#1f6a3a',      // green park (not blue)
    water:'#1a4668', sand:'#e0c27b', wood:'#6b4a2f',
    hotel:'#7b4f2a',     // terracotta/brown hotel (not blue)
    house:'#175d2f', hoodPark:'#135c33',
    window:'#b7c8ff'     // soft light-blue for window strips only
  };
  const isTier2 = ()=> localStorage.getItem(TIER_KEY)==='2';

  // ---------- Core anchors (mirror core.js calculations exactly) ----------
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

  // ---------- Lakefront ----------
  const LAKE   = { x0:67, y0:35, x1:81, y1:49 };
  const BEACH_X= LAKE.x0 - 1;
  const DOCKS  = [
    { x0: LAKE.x0, y: LAKE.y0+4,  len: 3 },
    { x0: LAKE.x0, y: LAKE.y0+12, len: 4 },
  ];
  const HOTEL  = { x0: LAKE.x0+2, y0: LAKE.y0-5, x1: LAKE.x0+8, y1: LAKE.y0-1 };

  // ---------- Neighborhood (bottom-left) ----------
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

  // ---------- Helpers ----------
  const _inRect=(gx,gy,R)=> gx>=R.x0 && gx<=R.x1 && gy>=R.y0 && gy<=R.y1;
  const _isDock=(gx,gy)=> DOCKS.some(d=> gy===d.y && gx>=d.x0 && gx<=d.x0+d.len-1);
  const _isWater=(gx,gy)=> _inRect(gx,gy,LAKE) && !_isDock(gx,gy);

  const scl = api => api.DRAW/api.TILE;
  const w2sX=(api,wx)=>(wx-api.camera.x)*scl(api);
  const w2sY=(api,wy)=>(wy-api.camera.y)*scl(api);
  function fillTile(api,ctx,gx,gy,color){
    const S=api.DRAW, sx=w2sX(api,gx*api.TILE), sy=w2sY(api,gy*api.TILE);
    ctx.fillStyle=color; ctx.fillRect(sx,sy,S,S);
  }

  // ---------- Tier-1 protection ----------
  function isOriginalTile(gx,gy,a){
    if (_inRect(gx,gy,{x0:a.HQ.x0-1,y0:a.HQ.y0-1,x1:a.HQ.x1+1,y1:a.HQ.y1+1})) return true;
    if (_inRect(gx,gy,{x0:a.SH.x0-1,y0:a.SH.y0-1,x1:a.SH.x1+1,y1:a.SH.y1+1})) return true;
    if (gy===a.hRoadY || gy===a.sidewalkTopY || gy===a.sidewalkBotY) return true;
    if (gx===a.vRoadX || gx===a.vSidewalkLeftX || gx===a.vSidewalkRightX) return true;
    return false;
  }

  // ---------- Parametric road grid (easy to tweak) ----------
  function desiredRoadGrid(a){
    const H = [
      a.hRoadY - 10,        // upper avenue
      a.hRoadY,             // aligns with Tier-1 across the new area only
      a.hRoadY + 6          // mid-lower connector toward the lake
    ];
    const V = [
      a.vRoadX - 12,        // west vertical
      a.vRoadX,             // central (only added where not Tier-1)
      a.vRoadX + 10         // east vertical near lake edge
    ];
    return {H, V};
  }

  // ---------- Seg clipping ----------
  function clipHRow(y, x0, x1, forbiddenRects){
    let parts=[{y, x0, x1}];
    forbiddenRects.forEach(R=>{
      parts = parts.flatMap(p=>{
        if(p.y<R.y0||p.y>R.y1||p.x1<R.x0||p.x0>R.x1) return [p];
        const out=[];
        if(p.x0 < R.x0) out.push({y:p.y, x0:p.x0, x1:Math.max(p.x0, R.x0-1)});
        if(p.x1 > R.x1) out.push({y:p.y, x0:Math.min(p.x1, R.x1+1), x1:p.x1});
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
        if(p.y0 < R.y0) out.push({x:p.x, y0:p.y0, y1:Math.max(p.y0, R.y0-1)});
        if(p.y1 > R.y1) out.push({x:p.x, y0:Math.min(p.y1, R.y1+1), y1:p.y1});
        return out;
      });
    });
    return parts.filter(p=>p.y1>=p.y0);
  }

  // ---------- Downtown building proposals ----------
  function proposeBuildings(a){
    // placed off the central cross; sizes kept compact; all neutral/brick/brown
    return [
      {x:a.vRoadX+11, y:a.hRoadY-9, w:6, h:3, color:COL.civic,   windows:true},
      {x:a.vRoadX+6,  y:a.hRoadY+2, w:4, h:3, color:COL.police,  windows:true},
      {x:a.vRoadX+8,  y:a.hRoadY+9, w:7, h:4, color:COL.shop,    windows:true},
      {x:a.vRoadX-14, y:a.hRoadY+2, w:3, h:2, color:COL.shop,    windows:true},
      {x:a.vRoadX-6,  y:a.hRoadY-2, w:3, h:2, color:COL.shop,    windows:true}
    ];
  }
  const PARK_DOWNTOWN = (a)=> ({ x:a.vRoadX-3, y:a.hRoadY+8, w:6, h:4 });

  // ---------- Draw helpers ----------
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

  // ---------- Boats ----------
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

  // ---------- RENDER UNDER ----------
  let _layout=null;
  IZZA.on('render-under', ()=>{
    if(!IZZA.api?.ready || !isTier2()) return;
    const api=IZZA.api, ctx=document.getElementById('game').getContext('2d');
    const A = anchors(api);

    // Forbidden zones for roads
    const FORBID = [
      {x0:LAKE.x0,y0:LAKE.y0,x1:LAKE.x1,y1:LAKE.y1},
      {x0:A.HQ.x0-1,y0:A.HQ.y0-1,x1:A.HQ.x1+1,y1:A.HQ.y1+1},
      {x0:A.SH.x0-1,y0:A.SH.y0-1,x1:A.SH.x1+1,y1:A.SH.y1+1}
    ];

    const {H,V} = desiredRoadGrid(A);

    // Build new road lists, clipped so they avoid lake and Tier-1 rings
    const H_ROADS = [];
    const V_ROADS = [];
    H.forEach(y=>{
      const segs = clipHRow(y, A.un.x0+1, A.un.x1-1, FORBID);
      segs.forEach(s=> H_ROADS.push(s));
    });
    V.forEach(x=>{
      const segs = clipVCol(x, A.un.y0+1, A.un.y1-1, FORBID);
      segs.forEach(s=> V_ROADS.push(s));
    });

    // Sidewalks for every new road (skip Tier-1 tiles)
    const markSW = new Set();
    const seen = (gx,gy)=>{ const k=gx+'|'+gy; if(markSW.has(k)) return true; markSW.add(k); return false; };
    H_ROADS.forEach(r=>{
      for(let x=r.x0;x<=r.x1;x++){
        if(!isOriginalTile(x, r.y-1, A)) if(!seen(x,r.y-1)) fillTile(api,ctx,x,r.y-1,COL.sidewalk);
        if(!isOriginalTile(x, r.y+1, A)) if(!seen(x,r.y+1)) fillTile(api,ctx,x,r.y+1,COL.sidewalk);
      }
    });
    V_ROADS.forEach(r=>{
      for(let y=r.y0;y<=r.y1;y++){
        if(!isOriginalTile(r.x-1, y, A)) if(!seen(r.x-1,y)) fillTile(api,ctx,r.x-1,y,COL.sidewalk);
        if(!isOriginalTile(r.x+1, y, A)) if(!seen(r.x+1,y)) fillTile(api,ctx,r.x+1,y,COL.sidewalk);
      }
    });

    // Draw the roads themselves
    H_ROADS.forEach(r=> drawHRoad(api,ctx,r.y,r.x0,r.x1));
    V_ROADS.forEach(r=> drawVRoad(api,ctx,r.x,r.y0,r.y1));

    // --- Compute a 1-tile buffer around all NEW roads & sidewalks to keep buildings off the curbs ---
    const roadBuffers = [];
    H_ROADS.forEach(r=>{
      roadBuffers.push({x0:r.x0, x1:r.x1, y0:r.y-1, y1:r.y+1}); // row + sidewalks
    });
    V_ROADS.forEach(r=>{
      roadBuffers.push({x0:r.x-1, x1:r.x+1, y0:r.y0, y1:r.y1}); // col + sidewalks
    });

    const overlaps = (rectA, rectB)=> !(rectA.x1 < rectB.x0 || rectA.x0 > rectB.x1 || rectA.y1 < rectB.y0 || rectA.y0 > rectB.y1);

    // Downtown buildings — filter so they never overlap roads, sidewalks, water, or Tier-1
    const BUILDINGS = proposeBuildings(A).filter(b=>{
      const R={x0:b.x,y0:b.y,x1:b.x+b.w-1,y1:b.y+b.h-1};
      // keep away from lake, HQ/Shop safety rings
      if (overlaps(R, {x0:LAKE.x0,y0:LAKE.y0,x1:LAKE.x1,y1:LAKE.y1})) return false;
      if (overlaps(R, {x0:A.HQ.x0-1,y0:A.HQ.y0-1,x1:A.HQ.x1+1,y1:A.HQ.y1+1})) return false;
      if (overlaps(R, {x0:A.SH.x0-1,y0:A.SH.y0-1,x1:A.SH.x1+1,y1:A.SH.y1+1})) return false;
      // keep 1 tile off any new road/sidewalk buffer
      if (roadBuffers.some(buf=> overlaps(R, buf))) return false;
      // don’t sit on Tier-1 road/sidewalk tiles either
      for(let gx=R.x0; gx<=R.x1; gx++)
        for(let gy=R.y0; gy<=R.y1; gy++)
          if (isOriginalTile(gx,gy,A)) return false;
      return true;
    });

    // Fill building bodies
    BUILDINGS.forEach(b=>{
      for(let gy=b.y; gy<b.y+b.h; gy++)
        for(let gx=b.x; gx<b.x+b.w; gx++)
          if(!_isWater(gx,gy) && !isOriginalTile(gx,gy,A)) fillTile(api,ctx,gx,gy,b.color);
      // subtle roof highlight
      const sx=w2sX(api,b.x*api.TILE), sy=w2sY(api,b.y*api.TILE);
      ctx.fillStyle='rgba(0,0,0,.15)';
      ctx.fillRect(sx,sy, b.w*api.DRAW, Math.floor(b.h*api.DRAW*0.18));
      // optional windows (thin strip) — safe because body isn’t blue
      if(b.windows){
        ctx.fillStyle=COL.window;
        const wx = sx + api.DRAW*0.15, ww = api.DRAW*(b.w - 0.30);
        const wy = sy + api.DRAW*0.40, wh = api.DRAW*0.20;
        ctx.fillRect(wx, wy, ww, wh);
      }
    });

    // Downtown park — clip off new roads/sidewalks/water
    const P=PARK_DOWNTOWN(A);
    for(let gy=P.y; gy<P.y+P.h; gy++)
      for(let gx=P.x; gx<P.x+P.w; gx++){
        const onNewH = H_ROADS.some(r=> gy>=r.y-1 && gy<=r.y+1 && gx>=r.x0 && gx<=r.x1);
        const onNewV = V_ROADS.some(r=> gx>=r.x-1 && gx<=r.x+1 && gy>=r.y0 && gy<=r.y1);
        if(!_isWater(gx,gy) && !onNewH && !onNewV && !isOriginalTile(gx,gy,A))
          fillTile(api,ctx,gx,gy,COL.park);
      }

    // Lake / beach / docks
    for(let gy=LAKE.y0; gy<=LAKE.y1; gy++)
      for(let gx=LAKE.x0; gx<=LAKE.x1; gx++)
        if(!_isDock(gx,gy)) fillTile(api,ctx,gx,gy,COL.water);
    for(let gy=LAKE.y0; gy<=LAKE.y1; gy++) fillTile(api,ctx,BEACH_X,gy,COL.sand);
    ctx.fillStyle=COL.wood; DOCKS.forEach(d=>{
      const S=api.DRAW, sx=w2sX(api,d.x0*api.TILE), sy=w2sY(api,d.y*api.TILE);
      ctx.fillRect(sx,sy, d.len*S, S);
    });

    // Hotel (non-blue)
    for(let gy=HOTEL.y0; gy<=HOTEL.y1; gy++)
      for(let gx=HOTEL.x0; gx<=HOTEL.x1; gx++)
        fillTile(api,ctx,gx,gy,COL.hotel);

    // Neighborhood grid
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

    for(let gy=HOOD_PARK.y0; gy<=HOOD_PARK.y1; gy++)
      for(let gx=HOOD_PARK.x0; gx<=HOOD_PARK.x1; gx++)
        fillTile(api,ctx,gx,gy,COL.hoodPark);

    HOUSES.forEach(h=>{
      for(let gy=h.y0; gy<=h.y1; gy++)
        for(let gx=h.x0; gx<=h.x1; gx++)
          fillTile(api,ctx,gx,gy,COL.house);
    });

    // Boats visual
    const S=api.DRAW, t=api.TILE, f=S/t;
    const sx=gx=> (gx*t - api.camera.x)*f, sy=gy=> (gy*t - api.camera.y)*f;
    const drawBoat=(gx,gy)=>{ ctx.fillStyle='#7ca7c7'; ctx.fillRect(sx(gx)+S*0.2, sy(gy)+S*0.35, S*0.6, S*0.3); };
    _boats.forEach(b=> drawBoat(b.x,b.y));
    _dockBoats.forEach(b=> drawBoat(b.x,b.y));
    if(_towBoat){
      const tgt=_towBoat.path[_towBoat.i], vx=tgt.x-_towBoat.x, vy=tgt.y-_towBoat.y, m=Math.hypot(vx,vy)||1;
      const wx=_towBoat.x - (vx/m)*2.2, wy=_towBoat.y - (vy/m)*2.2;
      ctx.strokeStyle = '#dfe9ef'; ctx.lineWidth = Math.max(1, S*0.04);
      ctx.beginPath(); ctx.moveTo(sx(_towBoat.x)+S*0.5, sy(_towBoat.y)+S*0.5);
      ctx.lineTo(sx(wx)+S*0.5,       sy(wy)+S*0.5); ctx.stroke();
      ctx.fillStyle='#23d3c6';
      ctx.fillRect(sx(wx)+S*0.33, sy(wy)+S*0.33, S*0.34, S*0.34);
    }

    // cache for collisions
    _layout = { H_ROADS, V_ROADS, BUILDINGS };
  });

  // ---------- Collisions & movement ----------
  function rectW (r){ return r.x1-r.x0+1; }
  function rectH (r){ return r.y1-r.y0+1; }

  IZZA.on('update-pre', ()=>{
    if(!IZZA.api?.ready || !isTier2()) return;
    const api=IZZA.api, p=api.player, t=api.TILE;
    const gx=((p.x+16)/t)|0, gy=((p.y+16)/t)|0;

    if(!_isWater(gx,gy)) _lastLand = {x:p.x,y:p.y};
    else if(!_inBoat && _lastLand){ p.x=_lastLand.x; p.y=_lastLand.y; }

    if(_layout){
      // make traffic U-turn if it enters a building cell
      api.cars.forEach(c=>{
        const cgx=(c.x/t)|0, cgy=(c.y/t)|0;
        const hit = _layout.BUILDINGS?.some(b=> cgx>=b.x && cgx<b.x+b.w && cgy>=b.y && cgy<b.y+b.h);
        if(hit){ c.dir*=-1; c.x += c.dir*4; }
      });
    }

    if(_inBoat && _ride){ _ride.x = p.x/32; _ride.y = p.y/32; }
  });

  IZZA.on('update-post', ()=>{
    if(!IZZA.api?.ready || !isTier2() || !_layout) return;
    const api=IZZA.api, t=api.TILE, p=api.player;
    const gx=(p.x/t)|0, gy=(p.y/t)|0;

    const solids = [];
    _layout.BUILDINGS?.forEach(b=> solids.push({x:b.x,y:b.y,w:b.w,h:b.h}));
    solids.push({x:HOTEL.x0,y:HOTEL.y0,w:rectW(HOTEL),h:rectH(HOTEL)});
    HOUSES.forEach(h=> solids.push({x:h.x0,y:h.y0,w:rectW(h),h:rectH(h)}));

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

    // neutral buildings on the map (not blue)
    ctx.fillStyle='#a8a29e';
    _layout.BUILDINGS?.forEach(b=> ctx.fillRect(b.x*sx,b.y*sy,b.w*sx,b.h*sy));

    // lake + beach + docks + hotel
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
    ctx.fillStyle='#5f8266'; HOUSES.forEach(h=> ctx.fillRect(h.x0*sx,h.y0*sy,(h.x1-h.x0+1)*sx,(h.y1-h.y0+1)*sy));
  }
  IZZA.on('render-post', ()=>{ if(isTier2()){ paintOverlay('minimap'); paintOverlay('bigmap'); } });

})();
