// downtown_clip_safe_layout.js — Tier-2 expansion (roads to edges, no N intersection behind HQ,
// hotel setback, non-green houses)
(function () {
  const TIER_KEY = 'izzaMapTier';

  // ---------- Palette ----------
  const COL = {
    grass:'#09371c',
    road:'#2a2a2a', dash:'#ffd23f', sidewalk:'#6a727b',
    civic:'#6a5f4b',        // red/brick-ish civic
    shop:'#6b4a2f',         // neutral brown shop
    park:'#1f6a3a',
    hoodPark:'#135c33',
    water:'#1a4668', sand:'#e0c27b', wood:'#6b4a2f',
    hotel:'#7b4f2a',        // NOT blue
    house:'#8a6a3d',        // NOT green (distinct from grass)
    window:'#b7c8ff'
  };
  const isTier2 = ()=> localStorage.getItem(TIER_KEY)==='2';

  // ---------- Core anchors (mirror core.js) ----------
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
    const HQ   = {x0:bX, y0:bY, x1:bX+bW-1, y1:bY+bH-1};
    const SH   = {x0:shop.x, y0:shop.y, x1:shop.x+shop.w-1, y1:shop.y+shop.h-1};

    return {un,bX,bY,bW,bH,hRoadY,sidewalkTopY,sidewalkBotY,vRoadX,vSidewalkLeftX,vSidewalkRightX,shop,HQ,SH};
  }

  // ---------- Lakefront ----------
  const LAKE   = { x0:67, y0:35, x1:81, y1:49 };
  const BEACH_X= LAKE.x0 - 1;
  const DOCKS  = [
    { x0: LAKE.x0, y: LAKE.y0+4,  len: 3 },
    { x0: LAKE.x0, y: LAKE.y0+12, len: 4 },
  ];

  // Hotel: placed with a 1-tile sidewalk buffer from the east vertical road
  function HOTEL(a){
    const x0 = (a.vRoadX + 12);      // road at vRoadX+10, sidewalk at +11, hotel starts at +12
    const y0 = a.hRoadY + 4;
    const w = 7, h = 5;
    return { x0, y0, x1:x0+w-1, y1:y0+h-1 };
  }

  // ---------- Neighborhood (bottom-left) ----------
  const HOOD   = { x0:12, y0:42, x1:34, y1:50 };
  const HOOD_H = [ HOOD.y0+2, HOOD.y0+6 ];      // 44, 48
  const HOOD_V = [ HOOD.x0+8, HOOD.x0+16 ];     // 20, 28
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

  const w2s=(api,gx,gy)=>[(gx*api.TILE - api.camera.x)*(api.DRAW/api.TILE),
                          (gy*api.TILE - api.camera.y)*(api.DRAW/api.TILE)];
  function fillTile(api,ctx,gx,gy,color){
    const [sx,sy]=w2s(api,gx,gy), S=api.DRAW;
    ctx.fillStyle=color; ctx.fillRect(sx,sy,S,S);
  }
  function inUnlocked(gx,gy,a){ return _inRect(gx,gy,a.un); }

  // ---------- Tier-1 protection ----------
  function isOriginalTile(gx,gy,a){
    if (_inRect(gx,gy,{x0:a.HQ.x0-1,y0:a.HQ.y0-1,x1:a.HQ.x1+1,y1:a.HQ.y1+1})) return true;
    if (_inRect(gx,gy,{x0:a.SH.x0-1,y0:a.SH.y0-1,x1:a.SH.x1+1,y1:a.SH.y1+1})) return true;
    if (gy===a.hRoadY || gy===a.sidewalkTopY || gy===a.sidewalkBotY) return true;
    if (gx===a.vRoadX || gx===a.vSidewalkLeftX || gx===a.vSidewalkRightX) return true;
    return false;
  }

  // ---------- Grid (match your mock) ----------
  // Roads now extend to the unlocked edge. Center vertical does NOT extend upward in Tier-2.
  function desiredRoadGrid(a){
    const H = [
      a.hRoadY - 10,     // top
      a.hRoadY,          // main
      a.hRoadY + 6,      // mid-lower
      HOOD_H[0],         // neighborhood rows extended across
      HOOD_H[1]
    ];
    // Columns: two new left columns, one west-of-center, and the center (downward only)
    const Vfull = [ HOOD_V[0], HOOD_V[1], a.vRoadX - 9 ];
    const Vdown = { x:a.vRoadX, y0:a.hRoadY+1, y1:a.un.y1 }; // no intersection above HQ
    return { H, Vfull, Vdown };
  }

  // ---------- Draw helpers ----------
  function drawHRoad(api,ctx,y,x0,x1){
    for(let x=x0;x<=x1;x++){
      fillTile(api,ctx,x,y,COL.road);
      const [sx,sy]=w2s(api,x,y), S=api.DRAW;
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

    // Rideable boat spawns in water just past each dock tip
    DOCKS.forEach(d=>{
      const gx = Math.min(LAKE.x1-1, d.x0 + d.len);
      _dockBoats.push({x:gx, y:d.y, s:120, taken:false});
    });
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
    const HOTEL_R = HOTEL(A);

    // Forbidden zones (Tier-1 boxes & lake)
    const FORBID = [
      {x0:LAKE.x0,y0:LAKE.y0,x1:LAKE.x1,y1:LAKE.y1},
      {x0:A.HQ.x0-1,y0:A.HQ.y0-1,x1:A.HQ.x1+1,y1:A.HQ.y1+1},
      {x0:A.SH.x0-1,y0:A.SH.y0-1,x1:A.SH.x1+1,y1:A.SH.y1+1}
    ];

    const {H,Vfull,Vdown} = desiredRoadGrid(A);

    // Build road lists; roads extend to the **edge** of unlocked rect
    const H_ROADS = [];
    const V_ROADS = [];

    H.forEach(y=>{
      let x0=A.un.x0, x1=A.un.x1;
      // clip against forbid rects (lake / HQ rings / shop ring)
      [{x0,y0:A.un.y0,x1,y1:A.un.y1}, ...FORBID].forEach(R=>{
        // cut away forbidden spans on this row
        if(y>=R.y0 && y<=R.y1){
          if(R.x0<=x0 && R.x1>=x0) x0 = Math.min(Math.max(x0, R.x1+1), A.un.x1);
          if(R.x0<=x1 && R.x1>=x1) x1 = Math.max(Math.min(x1, R.x0-1), A.un.x0);
        }
      });
      if(x1>=x0) H_ROADS.push({y, x0, x1});
    });

    // Full-height verticals first
    Vfull.forEach(x=>{
      let y0=A.un.y0, y1=A.un.y1;
      if(y1>=y0) V_ROADS.push({x, y0, y1});
    });
    // Center vertical only **downward** from the main row (removes the “behind HQ” intersection)
    V_ROADS.push({x:Vdown.x, y0:Vdown.y0, y1:Vdown.y1});

    // Sidewalks for every new road (only within unlocked area & not Tier-1)
    const markSW = new Set();
    const seen = (gx,gy)=>{ const k=gx+'|'+gy; if(markSW.has(k)) return true; markSW.add(k); return false; };
    H_ROADS.forEach(r=>{
      for(let x=r.x0;x<=r.x1;x++){
        if(inUnlocked(x,r.y-1,A) && !isOriginalTile(x, r.y-1, A) && !seen(x,r.y-1)) fillTile(api,ctx,x,r.y-1,COL.sidewalk);
        if(inUnlocked(x,r.y+1,A) && !isOriginalTile(x, r.y+1, A) && !seen(x,r.y+1)) fillTile(api,ctx,x,r.y+1,COL.sidewalk);
      }
    });
    V_ROADS.forEach(r=>{
      for(let y=r.y0;y<=r.y1;y++){
        if(inUnlocked(r.x-1,y,A) && !isOriginalTile(r.x-1, y, A) && !seen(r.x-1,y)) fillTile(api,ctx,r.x-1,y,COL.sidewalk);
        if(inUnlocked(r.x+1,y,A) && !isOriginalTile(r.x+1, y, A) && !seen(r.x+1,y)) fillTile(api,ctx,r.x+1,y,COL.sidewalk);
      }
    });

    // Draw roads
    H_ROADS.forEach(r=> drawHRoad(api,ctx,r.y,r.x0,r.x1));
    V_ROADS.forEach(r=> drawVRoad(api,ctx,r.x,r.y0,r.y1));

    // Buffers so buildings never touch curbs
    const roadBuffers = [];
    H_ROADS.forEach(r=> roadBuffers.push({x0:r.x0, x1:r.x1, y0:r.y-1, y1:r.y+1}));
    V_ROADS.forEach(r=> roadBuffers.push({x0:r.x-1, x1:r.x+1, y0:r.y0, y1:r.y1}));
    const overlaps = (A,B)=> !(A.x1 < B.x0 || A.x0 > B.x1 || A.y1 < B.y0 || A.y0 > B.y1);

    // Downtown buildings
    function proposeBuildings(a){
      // central civic block
      const civic = { x:a.vRoadX-4, y:a.hRoadY-8, w:6, h:3, color:COL.civic, windows:false };
      // small shop to the right of center
      const smallShop = { x:a.vRoadX+2, y:a.hRoadY-1, w:3, h:2, color:COL.shop, windows:true };
      return [civic, smallShop];
    }
    const BUILDINGS = proposeBuildings(A).filter(b=>{
      const R={x0:b.x,y0:b.y,x1:b.x+b.w-1,y1:b.y+b.h-1};
      if (overlaps(R, {x0:LAKE.x0,y0:LAKE.y0,x1:LAKE.x1,y1:LAKE.y1})) return false;
      if (overlaps(R, {x0:A.HQ.x0-1,y0:A.HQ.y0-1,x1:A.HQ.x1+1,y1:A.HQ.y1+1})) return false;
      if (overlaps(R, {x0:A.SH.x0-1,y0:A.SH.y0-1,x1:A.SH.x1+1,y1:A.SH.y1+1})) return false;
      if (roadBuffers.some(buf=> overlaps(R, buf))) return false;
      for(let gx=R.x0; gx<=R.x1; gx++)
        for(let gy=R.y0; gy<=R.y1; gy++)
          if (isOriginalTile(gx,gy,A)) return false;
      return true;
    });

    // Buildings (fill + roof shade + windows)
    BUILDINGS.forEach(b=>{
      for(let gy=b.y; gy<b.y+b.h; gy++)
        for(let gx=b.x; gx<b.x+b.w; gx++)
          if(!isOriginalTile(gx,gy,A)) fillTile(api,ctx,gx,gy,b.color);
      const [sx,sy]=w2s(api,b.x,b.y), S=api.DRAW;
      ctx.fillStyle='rgba(0,0,0,.15)';
      ctx.fillRect(sx,sy, b.w*S, Math.floor(b.h*S*0.18));
      if(b.windows){
        ctx.fillStyle=COL.window;
        ctx.fillRect(sx+S*0.15, sy+S*0.40, S*(b.w-0.30), S*0.20);
      }
    });

    // Lake / beach / docks
    for(let gy=LAKE.y0; gy<=LAKE.y1; gy++)
      for(let gx=LAKE.x0; gx<=LAKE.x1; gx++)
        if(!_isDock(gx,gy)) fillTile(api,ctx,gx,gy,COL.water);
    for(let gy=LAKE.y0; gy<=LAKE.y1; gy++) fillTile(api,ctx,BEACH_X,gy,COL.sand);
    ctx.fillStyle=COL.wood; DOCKS.forEach(d=>{
      const [sx,sy]=w2s(api,d.x0,d.y), S=api.DRAW;
      ctx.fillRect(sx,sy, d.len*S, S);
    });

    // Hotel with 1-tile sidewalk buffer already satisfied by placement
    for(let gy=HOTEL_R.y0; gy<=HOTEL_R.y1; gy++)
      for(let gx=HOTEL_R.x0; gx<=HOTEL_R.x1; gx++)
        fillTile(api,ctx,gx,gy,COL.hotel);

    // Neighborhood (roads + sidewalks + houses not green)
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

    _layout = { H_ROADS, V_ROADS, BUILDINGS, HOTEL_R };
  });

  // ---------- Collisions ----------
  function rectW (r){ return r.x1-r.x0+1; }
  function rectH (r){ return r.y1-r.y0+1; }
  IZZA.on('update-post', ()=>{
    if(!IZZA.api?.ready || !isTier2() || !_layout) return;
    const api=IZZA.api, t=api.TILE, p=api.player;
    const gx=(p.x/t)|0, gy=(p.y/t)|0;

    const solids = [];
    _layout.BUILDINGS?.forEach(b=> solids.push({x:b.x,y:b.y,w:b.w,h:b.h}));
    const H=HOTEL(anchors(api));
    solids.push({x:H.x0,y:H.y0,w:rectW(H),h:rectH(H)});
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

  // ---------- Map overlays ----------
  function paintOverlay(id){
    if(!_layout) return;
    const c=document.getElementById(id); if(!c) return;
    const ctx=c.getContext('2d');
    const sx=c.width/90, sy=c.height/60;

    ctx.fillStyle='#8a90a0';
    _layout.H_ROADS.forEach(r=> ctx.fillRect(r.x0*sx, r.y*sy, (r.x1-r.x0+1)*sx, 1.2*sy));
    _layout.V_ROADS.forEach(r=> ctx.fillRect(r.x*sx, r.y0*sy, 1.2*sx, (r.y1-r.y0+1)*sy));

    ctx.fillStyle='#a8a29e';
    _layout.BUILDINGS?.forEach(b=> ctx.fillRect(b.x*sx,b.y*sy,b.w*sx,b.h*sy));

    // lake + beach + docks + hotel
    ctx.fillStyle=COL.water;
    ctx.fillRect(LAKE.x0*sx,LAKE.y0*sy,(LAKE.x1-LAKE.x0+1)*sx,(LAKE.y1-LAKE.y0+1)*sy);
    ctx.fillStyle=COL.sand; ctx.fillRect(BEACH_X*sx, LAKE.y0*sy, 1*sx, (LAKE.y1-LAKE.y0+1)*sy);
    ctx.fillStyle=COL.wood; DOCKS.forEach(d=> ctx.fillRect(d.x0*sx, d.y*sy, d.len*sx, 1*sy));
    const H=HOTEL(anchors(IZZA.api)); ctx.fillStyle=COL.hotel;
    ctx.fillRect(H.x0*sx,H.y0*sy,(H.x1-H.x0+1)*sx,(H.y1-H.y0+1)*sy);

    // neighborhood
    ctx.fillStyle='#8a95a3';
    HOOD_H.forEach(y=> ctx.fillRect(HOOD.x0*sx, y*sy, (HOOD.x1-HOOD.x0+1)*sx, 1.4*sy));
    HOOD_V.forEach(x=> ctx.fillRect(x*sx, HOOD.y0*sy, 1.4*sx, (HOOD.y1-HOOD.y0+1)*sy));
    ctx.fillStyle=COL.hoodPark; ctx.fillRect(HOOD_PARK.x0*sx,HOOD_PARK.y0*sy,(HOOD_PARK.x1-HOOD_PARK.x0+1)*sx,(HOOD_PARK.y1-HOOD_PARK.y0+1)*sy);
    ctx.fillStyle=COL.house; HOUSES.forEach(h=> ctx.fillRect(h.x0*sx,h.y0*sy,(h.x1-h.x0+1)*sx,(h.y1-h.y0+1)*sy));
  }
  IZZA.on('render-post', ()=>{ if(isTier2()){ paintOverlay('minimap'); paintOverlay('bigmap'); } });

})();
