// downtown_clip_safe_layout.js — cleaned Tier-2 expansion
(function () {
  const TIER_KEY = 'izzaMapTier';

  const COL = {
    road:'#2a2a2a', dash:'#ffd23f', sidewalk:'#6a727b',
    civic:'#405a85', police:'#0a2455', shop:'#203a60', park:'#2b6a7a',
    water:'#1a4668', sand:'#e0c27b', wood:'#6b4a2f', hotel:'#284b7a',
    house:'#175d2f', hoodPark:'#135c33'
  };

  const isTier2 = ()=> localStorage.getItem(TIER_KEY)==='2';

  // ===== bounds =====
  function unlockedRect(t){ 
    return (t!=='2') ? {x0:18,y0:18,x1:72,y1:42} : {x0:10,y0:12,x1:80,y1:50}; 
  }

  function anchors(api){
    const un = unlockedRect('2');
    const bW=10,bH=6;
    const bX = Math.floor((un.x0+un.x1)/2) - Math.floor(bW/2);
    const bY = un.y0 + 5;
    const hRoadY = bY + bH + 1;
    const vRoadX = Math.min(un.x1-3, bX + bW + 6);
    const shop = { w:8, h:5, x:vRoadX+2, y:hRoadY-5 };

    const HQ  = {x0:bX-1,y0:bY-1,x1:bX+bW,y1:bY+bH};
    const SH  = {x0:shop.x-1,y0:shop.y-1,x1:shop.x+shop.w,y1:shop.y+shop.h};

    return {un,bX,bY,bW,bH,hRoadY,vRoadX,shop,HQ,SH};
  }

  // ===== layout proposal =====
  function proposeDowntown(a){
    const {un,hRoadY,vRoadX} = a;
    const L=un.x0+1,R=un.x1-1,T=un.y0+1,B=un.y1-1;

    const H = [ hRoadY-6, hRoadY, hRoadY+6 ].map(y=>({y, x0:L, x1:R}));
    const V = [ vRoadX-9, vRoadX, vRoadX+9 ].map(x=>({x, y0:T, y1:B}));

    const BLD = [
      {x:vRoadX+11, y:hRoadY-9, w:6, h:4, color:COL.civic},
      {x:vRoadX+6,  y:hRoadY+2, w:4, h:3, color:COL.police},
      {x:vRoadX+8,  y:hRoadY+9, w:7, h:4, color:COL.shop},
    ];

    const PARK = { x:vRoadX-3, y:hRoadY+8, w:6, h:4 };

    return {H,V,BLD,PARK};
  }

  // ===== environment (lake/hood) =====
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
  ];
  const HOOD_PARK = { x0: HOOD.x0+22, y0: HOOD.y0+6, x1: HOOD.x0+26, y1: HOOD.y0+9 };

  const _inRect=(gx,gy,R)=> gx>=R.x0 && gx<=R.x1 && gy>=R.y0 && gy<=R.y1;
  const _isWater=(gx,gy)=> _inRect(gx,gy,LAKE);
  const _isDock=(gx,gy)=> DOCKS.some(d=> gy===d.y && gx>=d.x0 && gx<=d.x0+d.len-1);

  // ===== helpers =====
  const scl = api => api.DRAW/api.TILE;
  const w2sX=(api,wx)=>(wx-api.camera.x)*scl(api);
  const w2sY=(api,wy)=>(wy-api.camera.y)*scl(api);
  function fillTile(api,ctx,gx,gy,color){
    const S=api.DRAW, sx=w2sX(api,gx*api.TILE), sy=w2sY(api,gy*api.TILE);
    ctx.fillStyle=color; ctx.fillRect(sx,sy,S,S);
  }
  function drawHRoad(api,ctx,y,x0,x1){
    for(let x=x0;x<=x1;x++){
      fillTile(api,ctx,x,y,COL.road);
      const S=api.DRAW, sx=w2sX(api,x*api.TILE), sy=w2sY(api,y*api.TILE);
      ctx.fillStyle=COL.dash;
      for(let i=0;i<4;i++) ctx.fillRect(sx+i*(S/4)+S*0.05, sy+S*0.48, S*0.10, S*0.04);
    }
  }
  function drawVRoad(api,ctx,x,y0,y1){ for(let y=y0;y<=y1;y++) fillTile(api,ctx,x,y,COL.road); }

  // ===== solid rects =====
  function solidRects(layout){
    const rects=[...layout.BUILDINGS];
    rects.push({x:HOTEL.x0,y:HOTEL.y0,w:HOTEL.x1-HOTEL.x0+1,h:HOTEL.y1-HOTEL.y0+1});
    HOUSES.forEach(h=> rects.push({x:h.x0,y:h.y0,w:h.x1-h.x0+1,h:h.y1-h.y0+1}));
    return rects;
  }

  // ===== state =====
  let _layout=null;

  IZZA.on('render-under', ()=>{
    if(!IZZA.api?.ready || !isTier2()) return;
    const api=IZZA.api, ctx=document.getElementById('game').getContext('2d');

    const A=anchors(api);
    const P=proposeDowntown(A);

    // only keep roads not in water
    const H=P.H.filter(r=> r.y<LAKE.y0 || r.y>LAKE.y1);
    const V=P.V.filter(r=> r.x<LAKE.x0 || r.x>LAKE.x1);

    _layout={H_ROADS:H,V_ROADS:V,BUILDINGS:P.BLD,PARK:P.PARK};

    // sidewalks around roads
    H.forEach(r=>{ for(let x=r.x0;x<=r.x1;x++){ fillTile(api,ctx,x,r.y-1,COL.sidewalk); fillTile(api,ctx,x,r.y+1,COL.sidewalk);} });
    V.forEach(r=>{ for(let y=r.y0;y<=r.y1;y++){ fillTile(api,ctx,r.x-1,y,COL.sidewalk); fillTile(api,ctx,r.x+1,y,COL.sidewalk);} });

    // draw roads
    H.forEach(r=> drawHRoad(api,ctx,r.y,r.x0,r.x1));
    V.forEach(r=> drawVRoad(api,ctx,r.x,r.y0,r.y1));

    // draw buildings with sidewalk in front + collision
    _layout.BUILDINGS.forEach(b=>{
      for(let gy=b.y; gy<b.y+b.h; gy++)
        for(let gx=b.x; gx<b.x+b.w; gx++)
          fillTile(api,ctx,gx,gy,b.color);
      for(let gx=b.x; gx<b.x+b.w; gx++) fillTile(api,ctx,gx,b.y+b.h,COL.sidewalk);
    });

    // park
    const p=_layout.PARK;
    for(let gy=p.y; gy<p.y+p.h; gy++)
      for(let gx=p.x; gx<p.x+p.w; gx++) fillTile(api,ctx,gx,gy,COL.park);

    // lake + beach
    for(let gy=LAKE.y0; gy<=LAKE.y1; gy++)
      for(let gx=LAKE.x0; gx<=LAKE.x1; gx++) fillTile(api,ctx,gx,gy,COL.water);
    for(let gy=LAKE.y0; gy<=LAKE.y1; gy++) fillTile(api,ctx,BEACH_X,gy,COL.sand);

    // docks (walkable wood)
    DOCKS.forEach(d=>{ for(let gx=d.x0; gx<d.x0+d.len; gx++) fillTile(api,ctx,gx,d.y,COL.wood); });

    // hotel
    for(let gy=HOTEL.y0; gy<=HOTEL.y1; gy++)
      for(let gx=HOTEL.x0; gx<=HOTEL.x1; gx++) fillTile(api,ctx,gx,gy,COL.hotel);

    // hood
    HOOD_H.forEach(y=> drawHRoad(api,ctx,y,HOOD.x0,HOOD.x1));
    HOOD_V.forEach(x=> drawVRoad(api,ctx,x,HOOD.y0,HOOD.y1));
    for(let gy=HOOD_PARK.y0; gy<=HOOD_PARK.y1; gy++)
      for(let gx=HOOD_PARK.x0; gx<=HOOD_PARK.x1; gx++) fillTile(api,ctx,gx,gy,COL.hoodPark);
    HOUSES.forEach(h=>{ for(let gy=h.y0; gy<=h.y1; gy++) for(let gx=h.x0; gx<=h.x1; gx++) fillTile(api,ctx,gx,gy,COL.house); });
  });

  // ===== collisions =====
  IZZA.on('update-post', ()=>{
    if(!IZZA.api?.ready || !isTier2() || !_layout) return;
    const api=IZZA.api, t=api.TILE, p=api.player;
    const gx=(p.x/t)|0, gy=(p.y/t)|0;
    if(_isDock(gx,gy)) return; // allow walking on docks
    const solids=solidRects(_layout);
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

})();
