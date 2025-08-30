<script>
// downtown_clip_safe_layout + lake/boats/neighborhood (merged)
(function () {
  const TIER_KEY = 'izzaMapTier';

  // ----- colors (same base palette) -----
  const COL = {
    road:'#2a2a2a', dash:'#ffd23f', sidewalk:'#6a727b',
    civic:'#405a85', police:'#0a2455', shop:'#203a60', park:'#2b6a7a',
    water:'#1a4668', beach:'#e0c27b', dock:'#6b4a2f', hotel:'#284b7a',
    house:'#175d2f', parkGrass:'#135c33', parkPath:'#7a6f53'
  };

  // ---------- core-aligned anchors ----------
  function unlockedRect(t){ return (t!=='2') ? {x0:18,y0:18,x1:72,y1:42} : {x0:10,y0:12,x1:80,y1:50}; }
  function anchors(api){
    const tier = localStorage.getItem(TIER_KEY)||'1';
    const un = unlockedRect(tier);

    // original HQ/shop from core math
    const bW=10,bH=6;
    const bX = Math.floor((un.x0+un.x1)/2) - Math.floor(bW/2);
    const bY = un.y0 + 5;

    const hRoadY       = bY + bH + 1;
    const sidewalkTopY = hRoadY - 1;

    const vRoadX         = Math.min(un.x1-3, bX + bW + 6);
    const vSidewalkRightX= vRoadX + 1;

    const shop = { w:8, h:5, x:vSidewalkRightX+1, y: sidewalkTopY-5 };

    // “no paint” (with 1-tile buffer so nothing touches)
    const BUFF=1;
    const HQ  = {x0:bX-BUFF, y0:bY-BUFF, x1:bX+bW-1+BUFF, y1:bY+bH-1+BUFF};
    const SH  = {x0:shop.x-BUFF, y0:shop.y-BUFF, x1:shop.x+shop.w-1+BUFF, y1:shop.y+shop.h-1+BUFF};

    // door/register tiles to keep clear
    const door = { gx: bX + Math.floor(bW/2), gy: sidewalkTopY };
    const register = { gx: vSidewalkRightX, gy: sidewalkTopY };

    return {tier,un,bX,bY,bW,bH,hRoadY,vRoadX,shop,HQ,SH,door,register};
  }

  // ---------- downtown grid proposal ----------
  function proposeDowntown(a){
    const {un,hRoadY,vRoadX} = a;
    const L=un.x0+1,R=un.x1-1,T=un.y0+1,B=un.y1-1;

    const H=[], V=[], BLD=[];
    const addBox=(x,y,w,h,color)=>BLD.push({x,y,w,h,color});

    // arterials + cross streets (downtown grid)
    H.push({y:hRoadY, x0:L, x1:R});
    for(let y=hRoadY-8; y>=T; y-=4) H.push({y, x0:L, x1:R});
    for(let y=hRoadY+4; y<=B; y+=4) H.push({y, x0:L, x1:R});

    V.push({x:vRoadX, y0:T, y1:B});
    for(let x=vRoadX-12; x>=L; x-=6) V.push({x, y0:T, y1:B});
    for(let x=vRoadX+6;  x<=R; x+=6) V.push({x, y0:T, y1:B});

    // sample buildings (spread; will be nudged away from HQ/Shop later)
    addBox(vRoadX+8,  hRoadY-9, 5,3, COL.civic);
    addBox(vRoadX+15, hRoadY-9, 4,3, COL.civic);
    addBox(vRoadX+13, hRoadY+5, 4,3, COL.police);
    addBox(vRoadX+4,  hRoadY+13, 8,5, COL.shop);
    [[vRoadX-7,hRoadY+5],[vRoadX-1,hRoadY+5],[vRoadX+6,hRoadY+7],[vRoadX+18,hRoadY+11],[vRoadX-6,hRoadY+13],[vRoadX+20,hRoadY-1]]
      .forEach(([x,y])=>addBox(x,y,3,2,COL.civic));

    const PARK={x:R-11, y:B-7, w:9, h:5};

    return {H,V,BLD,PARK};
  }

  // ---------- clipping helpers ----------
  function overlapsRect(x0,y0,x1,y1,R){ return !(x1<R.x0 || x0>R.x1 || y1<R.y0 || y0>R.y1); }
  function clipHSegment(seg, forbiddenRects){
    let parts = [{y:seg.y, x0:seg.x0, x1:seg.x1}];
    forbiddenRects.forEach(R=>{
      parts = parts.flatMap(p=>{
        if(p.y<R.y0 || p.y>R.y1 || p.x1<R.x0 || p.x0>R.x1) return [p];
        const res=[];
        if(p.x0 < R.x0) res.push({y:p.y, x0:p.x0, x1:Math.max(p.x0, R.x0-1)});
        if(p.x1 > R.x1) res.push({y:p.y, x0:Math.min(p.x1, R.x1+1), x1:p.x1});
        return res;
      });
    });
    return parts.filter(p=>p.x1>=p.x0);
  }
  function clipVSegment(seg, forbiddenRects){
    let parts = [{x:seg.x, y0:seg.y0, y1:seg.y1}];
    forbiddenRects.forEach(R=>{
      parts = parts.flatMap(p=>{
        if(p.x<R.x0 || p.x>R.x1 || p.y1<R.y0 || p.y0>R.y1) return [p];
        const res=[];
        if(p.y0 < R.y0) res.push({x:p.x, y0:p.y0, y1:Math.max(p.y0, R.y0-1)});
        if(p.y1 > R.y1) res.push({x:p.x, y0:Math.min(p.y1, R.y1+1), y1:p.y1});
        return res;
      });
    });
    return parts.filter(p=>p.y1>=p.y0);
  }
  function inflate(rect, d){ return {x0:rect.x0-d, y0:rect.y0-d, x1:rect.x1+d, y1:rect.y1+d}; }

  // ---------- safe layout (roads clipped, buildings shifted if needed) ----------
  function makeSafeLayout(a){
    const P = proposeDowntown(a);

    const NO_ROAD = [
      inflate(a.HQ,0), inflate(a.SH,0),
      inflate({x0:a.door.gx,y0:a.door.gy,x1:a.door.gx,y1:a.door.gy},1),
      inflate({x0:a.register.gx,y0:a.register.gy,x1:a.register.gx,y1:a.register.gy},1)
    ];

    const H = P.H.flatMap(seg => clipHSegment(seg, NO_ROAD));
    const V = P.V.flatMap(seg => clipVSegment(seg, NO_ROAD));

    const keepAway = inflate(a.HQ,1);
    const keepAway2= inflate(a.SH,1);
    const BLD = P.BLD.map(b=>{
      let bx=b.x, by=b.y;
      if(overlapsRect(bx,by,bx+b.w-1,by+b.h-1, keepAway) || overlapsRect(bx,by,bx+b.w-1,by+b.h-1, keepAway2)){
        if(bx <= a.bX) bx = keepAway.x0 - b.w - 1; else bx = keepAway.x1 + 1;
        if(by <= a.bY) by = keepAway.y0 - b.h - 1; else by = keepAway.y1 + 1;
      }
      return {x:bx,y:by,w:b.w,h:b.h,color:b.color};
    });

    return {H_ROADS:H, V_ROADS:V, BUILDINGS:BLD, PARK:P.PARK};
  }

  // ----- lake / docks / hotel / neighborhood (new) -----
  function extraFeatures(a){
    const un=a.un;

    // big SE lake
    const lake = {
      x0: Math.max(un.x1 - 12, un.x0+20),
      y0: Math.floor(un.y0 + (un.y1-un.y0)*0.55),
      x1: un.x1 - 1,
      y1: un.y1 - 1
    };
    const beach = { x0: lake.x0-1, y0: lake.y0, x1: lake.x0-1, y1: lake.y1 };
    const docks = [
      {x0: lake.x0, y0: lake.y0+3,  x1: lake.x0+3, y1: lake.y0+3},
      {x0: lake.x0, y0: lake.y0+11, x1: lake.x0+4, y1: lake.y0+11},
      {x0: lake.x0, y0: lake.y0+18, x1: lake.x0+3, y1: lake.y0+18},
    ];
    const hotel = {x0: lake.x0+2, y0: lake.y0-5, x1: lake.x0+8, y1: lake.y0-1};

    // bottom-left neighborhood
    const hoodArea = {
      x0: un.x0+2,
      y0: Math.floor(un.y0 + (un.y1-un.y0)*0.65),
      x1: Math.min(un.x0+26, un.x1-30),
      y1: un.y1-2
    };
    const hoodH = [hoodArea.y0+1, hoodArea.y0+5, hoodArea.y0+9];
    const hoodV = [hoodArea.x0+6, hoodArea.x0+12, hoodArea.x0+18];
    const houses = [
      {x0: hoodArea.x0+1, y0: hoodArea.y0+2, x1: hoodArea.x0+2, y1: hoodArea.y0+3},
      {x0: hoodArea.x0+8, y0: hoodArea.y0+2, x1: hoodArea.x0+10,y1: hoodArea.y0+3},
      {x0: hoodArea.x0+14,y0: hoodArea.y0+2, x1: hoodArea.x0+16,y1: hoodArea.y0+3},
      {x0: hoodArea.x0+2, y0: hoodArea.y0+7, x1: hoodArea.x0+4, y1: hoodArea.y0+8},
      {x0: hoodArea.x0+9, y0: hoodArea.y0+7, x1: hoodArea.x0+11,y1: hoodArea.y0+8},
      {x0: hoodArea.x0+15,y0: hoodArea.y0+7, x1: hoodArea.x0+17,y1: hoodArea.y0+8},
    ];
    const nPark = {x0: hoodArea.x0+19, y0: hoodArea.y0+5, x1: hoodArea.x0+24, y1: hoodArea.y0+9};

    return {lake,beach,docks,hotel,hoodArea,hoodH,hoodV,houses,nPark};
  }

  // ---------- drawing helpers ----------
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

  // ====== Boats (same as earlier, but tied to this layout) ======
  const TILE=32;
  const boats=[], dockBoats=[]; let towingBoat=null; const WAKE_LEN=2.2;
  function makeLoopBoat(lake,x,y,speed,clockwise=true){
    const m=1, L={x0:lake.x0+m,y0:lake.y0+m,x1:lake.x1-m,y1:lake.y1-m};
    const path = clockwise
      ? [{x:L.x0,y:L.y0},{x:L.x1,y:L.y0},{x:L.x1,y:L.y1},{x:L.x0,y:L.y1}]
      : [{x:L.x1,y:L.y1},{x:L.x0,y:L.y1},{x:L.x0,y:L.y0},{x:L.x1,y:L.y0}];
    return {x,y,speed,i:0,path};
  }
  function makeDockBoat(dock){
    const x = dock.x0+((dock.x1-dock.x0)>>1);
    const y = dock.y0;
    return {x,y,speed:120,taken:false};
  }

  let inBoat=false, ridingBoat=null, lastSafe=null;
  const pgx=()=>Math.floor((IZZA.api.player.x+TILE/2)/TILE);
  const pgy=()=>Math.floor((IZZA.api.player.y+TILE/2)/TILE);

  function tileInRect(gx,gy,r){ return gx>=r.x0 && gx<=r.x1 && gy>=r.y0 && gy<=r.y1; }
  function anyRectHit(gx,gy, list){ return list.some(r=>tileInRect(gx,gy,r)); }

  function tryEnterBoat(extra){
    if(inBoat) return;
    const px=pgx(), py=pgy();
    if(!anyRectHit(px,py, extra.docks)) return;
    let best=null, bd=9999;
    for(const b of dockBoats){ if(b.taken) continue; const d=Math.hypot(b.x-px,b.y-py); if(d<bd){bd=d;best=b;} }
    if(best && bd<=2){ ridingBoat=best; best.taken=true; inBoat=true; IZZA.api.player.speed=120; }
  }
  function tryLeaveBoat(extra){
    if(!inBoat) return;
    const px=pgx(), py=pgy();
    if(tileInRect(px,py, extra.beach) || anyRectHit(px,py, extra.docks)){
      inBoat=false; if(ridingBoat){ ridingBoat.taken=false; ridingBoat.x=px; ridingBoat.y=py; }
      ridingBoat=null; IZZA.api.player.speed=90;
    }
  }
  window.addEventListener('keydown', e=>{
    if(e.key && e.key.toLowerCase()==='b'){
      const pack=window.__DT_LAYOUT__; if(!pack) return;
      const extra=pack.EXTRA; if(!extra) return;
      if(inBoat) tryLeaveBoat(extra); else tryEnterBoat(extra);
    }
  });
  const btnB=document.getElementById('btnB');
  if(btnB) btnB.addEventListener('click', ()=>{
    const pack=window.__DT_LAYOUT__; if(!pack) return;
    const extra=pack.EXTRA; if(!extra) return;
    if(inBoat) tryLeaveBoat(extra); else tryEnterBoat(extra);
  });

  // ---------- paint UNDER player/NPC (but above grass) ----------
  IZZA.on('render-under', ()=>{
    if(!IZZA.api||!IZZA.api.ready) return;
    if(localStorage.getItem(TIER_KEY)!=='2') return;

    const api=IZZA.api;
    const a=anchors(api);
    const L=makeSafeLayout(a);
    const ctx=document.getElementById('game').getContext('2d');

    // sidewalks first
    L.H_ROADS.forEach(r=>{
      for(let x=r.x0;x<=r.x1;x++){
        fillTile(api,ctx,x,r.y-1,COL.sidewalk);
        fillTile(api,ctx,x,r.y+1,COL.sidewalk);
      }
    });
    L.V_ROADS.forEach(r=>{
      for(let y=r.y0;y<=r.y1;y++){
        fillTile(api,ctx,r.x-1,y,COL.sidewalk);
        fillTile(api,ctx,r.x+1,y,COL.sidewalk);
      }
    });

    // roads
    L.H_ROADS.forEach(r=> drawHRoad(api,ctx,r.y,r.x0,r.x1));
    L.V_ROADS.forEach(r=> drawVRoad(api,ctx,r.x,r.y0,r.y1));

    // buildings
    L.BUILDINGS.forEach(b=>{
      for(let gy=b.y; gy<b.y+b.h; gy++)
        for(let gx=b.x; gx<b.x+b.w; gx++)
          fillTile(api,ctx,gx,gy,b.color);
      const sx=w2sX(api,b.x*api.TILE), sy=w2sY(api,b.y*api.TILE);
      ctx.fillStyle='rgba(0,0,0,.15)';
      ctx.fillRect(sx,sy, b.w*api.DRAW, Math.floor(b.h*api.DRAW*0.18));
    });

    // city park from downtown proposal
    if(L.PARK){
      const p=L.PARK, sx=w2sX(api,p.x*api.TILE), sy=w2sY(api,p.y*api.TILE);
      ctx.fillStyle=COL.park; ctx.fillRect(sx,sy, p.w*api.DRAW, p.h*api.DRAW);
    }

    // --- extra features (lake, beach, docks, hotel, neighborhood) ---
    const EXTRA = extraFeatures(a);

    // water
    for(let gy=EXTRA.lake.y0; gy<=EXTRA.lake.y1; gy++)
      for(let gx=EXTRA.lake.x0; gx<=EXTRA.lake.x1; gx++)
        fillTile(api,ctx,gx,gy,COL.water);
    // beach band
    for(let gy=EXTRA.beach.y0; gy<=EXTRA.beach.y1; gy++)
      fillTile(api,ctx,EXTRA.beach.x0,gy,COL.beach);
    // docks (wood)
    EXTRA.docks.forEach(d=>{
      for(let gx=d.x0; gx<=d.x1; gx++) for(let gy=d.y0; gy<=d.y1; gy++)
        fillTile(api,ctx,gx,gy,COL.dock);
    });
    // hotel on shore
    for(let gx=EXTRA.hotel.x0; gx<=EXTRA.hotel.x1; gx++)
      for(let gy=EXTRA.hotel.y0; gy<=EXTRA.hotel.y1; gy++)
        fillTile(api,ctx,gx,gy,COL.hotel);

    // neighborhood locals
    EXTRA.hoodH.forEach(y=>{
      for(let gx=EXTRA.hoodArea.x0; gx<=EXTRA.hoodArea.x1; gx++) fillTile(api,ctx,gx,y,   COL.sidewalk);
      for(let gx=EXTRA.hoodArea.x0; gx<=EXTRA.hoodArea.x1; gx++) fillTile(api,ctx,gx,y+1, COL.road);
    });
    EXTRA.hoodV.forEach(x=>{
      for(let gy=EXTRA.hoodArea.y0; gy<=EXTRA.hoodArea.y1; gy++) fillTile(api,ctx,x,   gy,COL.sidewalk);
      for(let gy=EXTRA.hoodArea.y0; gy<=EXTRA.hoodArea.y1; gy++) fillTile(api,ctx,x+1, gy,COL.road);
    });

    // neighborhood park + path
    for(let gx=EXTRA.nPark.x0; gx<=EXTRA.nPark.x1; gx++)
      for(let gy=EXTRA.nPark.y0; gy<=EXTRA.nPark.y1; gy++)
        fillTile(api,ctx,gx,gy,COL.parkGrass);
    for(let gx=EXTRA.nPark.x0; gx<=EXTRA.nPark.x1; gx++)
      fillTile(api,ctx,gx, Math.floor((EXTRA.nPark.y0+EXTRA.nPark.y1)/2), COL.parkPath);

    // houses
    EXTRA.houses.forEach(h=>{
      for(let gx=h.x0; gx<=h.x1; gx++) for(let gy=h.y0; gy<=h.y1; gy++)
        fillTile(api,ctx,gx,gy,COL.house);
    });

    // ----- boats (draw UNDER player) -----
    function drawBoatAt(gx,gy){
      const S=api.DRAW, x=w2sX(api,gx*api.TILE), y=w2sY(api,gy*api.TILE);
      const w=S*0.6, h=S*0.3;
      ctx.fillStyle='#7ca7c7';
      ctx.fillRect(x+S*0.2, y+S*0.35, w, h);
    }
    // ensure boats are spawned once per run
    if(!window.__DT_LAYOUT__ || !window.__DT_LAYOUT__.EXTRA){
      // seed boats on first render after tier-2
      boats.length=0; dockBoats.length=0;
      boats.push(makeLoopBoat(EXTRA.lake, EXTRA.lake.x0+2, EXTRA.lake.y0+2, 55, true));
      boats.push(makeLoopBoat(EXTRA.lake, EXTRA.lake.x1-2, EXTRA.lake.y1-2, 60, false));
      towingBoat = makeLoopBoat(EXTRA.lake, EXTRA.lake.x0+3, EXTRA.lake.y1-3, 50, true);
      boats.push(towingBoat);
      EXTRA.docks.forEach(d=> dockBoats.push(makeDockBoat(d)));
    }

    boats.forEach(b=> drawBoatAt(b.x, b.y));
    dockBoats.forEach(b=> drawBoatAt(b.x, b.y));
    // wakeboarder behind the towing boat
    if(towingBoat){
      const next = towingBoat.path[towingBoat.i];
      const vx = (next.x - towingBoat.x), vy=(next.y - towingBoat.y);
      const m = Math.hypot(vx,vy)||1;
      const wx = towingBoat.x - (vx/m)*WAKE_LEN;
      const wy = towingBoat.y - (vy/m)*WAKE_LEN;
      const px=w2sX(api, wx*api.TILE), py=w2sY(api, wy*api.TILE);
      ctx.fillStyle='#23d3c6'; const S=api.DRAW*0.35;
      ctx.fillRect(px+api.DRAW*0.325, py+api.DRAW*0.325, S, S);
    }

    // stash for collision + minimap + boat controls
    window.__DT_LAYOUT__ = {L, EXTRA};
  });

  // ---------- light collision only against NEW downtown buildings + water/dock blocking ----------
  function softCollide(){
    const api=IZZA.api; const pack=window.__DT_LAYOUT__; if(!api||!pack) return;
    const {L,EXTRA}=pack; const t=api.TILE; const px=api.player.x, py=api.player.y;
    const gx=(px/t)|0, gy=(py/t)|0;

    // block water unless in boat; block hotel/houses/park/docks always
    const inRect=(g, r)=> g.gx>=r.x0 && g.gx<=r.x1 && g.gy>=r.y0 && g.gy<=r.y1;
    const onDock = EXTRA.docks.some(r=> gx>=r.x0 && gx<=r.x1 && gy>=r.y0 && gy<=r.y1);
    const onWater= (gx>=EXTRA.lake.x0 && gx<=EXTRA.lake.x1 && gy>=EXTRA.lake.y0 && gy<=EXTRA.lake.y1);
    const inHotel= (gx>=EXTRA.hotel.x0&&gx<=EXTRA.hotel.x1&&gy>=EXTRA.hotel.y0&&gy<=EXTRA.hotel.y1);
    const inHouse= EXTRA.houses.some(h=> gx>=h.x0 && gx<=h.x1 && gy>=h.y0 && gy<=h.y1);
    const inNpark= (gx>=EXTRA.nPark.x0&&gx<=EXTRA.nPark.x1&&gy>=EXTRA.nPark.y0&&gy<=EXTRA.nPark.y1);

    const blocked = onDock || inHotel || inHouse || inNpark || (onWater && !inBoat);
    if(blocked){
      const dxL=Math.abs(px-gx*t), dxR=Math.abs((gx+1)*t-px);
      const dyT=Math.abs(py-gy*t), dyB=Math.abs((gy+1)*t-py);
      const m=Math.min(dxL,dxR,dyT,dyB);
      if(m===dxL) api.player.x=(gx-0.01)*t;
      else if(m===dxR) api.player.x=((gx+1)+0.01)*t;
      else if(m===dyT) api.player.y=(gy-0.01)*t;
      else             api.player.y=((gy+1)+0.01)*t;
      return;
    }

    // keep old “buildings only” bump
    for(const b of L.BUILDINGS){
      if(gx>=b.x && gx<b.x+b.w && gy>=b.y && gy<b.y+b.h){
        const dxL=Math.abs(px-b.x*t), dxR=Math.abs((b.x+b.w)*t-px);
        const dyT=Math.abs(py-b.y*t), dyB=Math.abs((b.y+b.h)*t-py);
        const m=Math.min(dxL,dxR,dyT,dyB);
        if(m===dxL) api.player.x=(b.x-0.01)*t;
        else if(m===dxR) api.player.x=(b.x+b.w+0.01)*t;
        else if(m===dyT) api.player.y=(b.y-0.01)*t;
        else             api.player.y=(b.y+b.h+0.01)*t;
        break;
      }
    }
  }
  IZZA.on('update-pre', ({dtSec})=>{
    if(localStorage.getItem(TIER_KEY)!=='2') return;
    // move boats
    const pack=window.__DT_LAYOUT__; if(!pack || !pack.EXTRA) return;
    boats.forEach(b=>{
      const tgt=b.path[b.i], dx=(tgt.x-b.x), dy=(tgt.y-b.y);
      const m=Math.hypot(dx,dy)||1; const step=b.speed*dtSec/32;
      if(m<=step){ b.x=tgt.x; b.y=tgt.y; b.i=(b.i+1)%b.path.length; }
      else { b.x+=(dx/m)*step; b.y+=(dy/m)*step; }
    });
    if(inBoat && ridingBoat){
      ridingBoat.x = (IZZA.api.player.x/32);
      ridingBoat.y = (IZZA.api.player.y/32);
    }
  });
  IZZA.on('update-post', ()=>{
    if(localStorage.getItem(TIER_KEY)==='2') softCollide();
  });

  // ---------- minimap/bigmap painting AFTER core ----------
  function paintMapCanvas(id){
    const pack=window.__DT_LAYOUT__; if(!pack) return;
    const {L,EXTRA}=pack;
    const c=document.getElementById(id); if(!c) return;
    const ctx=c.getContext('2d');
    const sx=c.width/90, sy=c.height/60;

    ctx.save();
    // downtown roads
    ctx.fillStyle='#8a90a0';
    L.H_ROADS.forEach(r=> ctx.fillRect(r.x0*sx, r.y*sy, (r.x1-r.x0+1)*sx, 1.2*sy));
    L.V_ROADS.forEach(r=> ctx.fillRect(r.x*sx, r.y0*sy, 1.2*sx, (r.y1-r.y0+1)*sy));
    // downtown buildings
    L.BUILDINGS.forEach(b=>{ ctx.fillStyle='#6f87b3'; ctx.fillRect(b.x*sx,b.y*sy,b.w*sx,b.h*sy); });
    if(L.PARK){ const p=L.PARK; ctx.fillStyle='#7db7d9'; ctx.fillRect(p.x*sx,p.y*sy,p.w*sx,p.h*sy); }

    // lake set
    ctx.fillStyle=COL.water;
    ctx.fillRect(EXTRA.lake.x0*sx, EXTRA.lake.y0*sy, (EXTRA.lake.x1-EXTRA.lake.x0+1)*sx, (EXTRA.lake.y1-EXTRA.lake.y0+1)*sy);
    ctx.fillStyle=COL.beach; ctx.fillRect(EXTRA.beach.x0*sx, EXTRA.beach.y0*sy, 1*sx, (EXTRA.beach.y1-EXTRA.beach.y0+1)*sy);
    ctx.fillStyle=COL.dock;  EXTRA.docks.forEach(d=> ctx.fillRect(d.x0*sx,d.y0*sy,(d.x1-d.x0+1)*sx,(d.y1-d.y0+1)*sy));
    ctx.fillStyle=COL.hotel; ctx.fillRect(EXTRA.hotel.x0*sx,EXTRA.hotel.y0*sy,(EXTRA.hotel.x1-EXTRA.hotel.x0+1)*sx,(EXTRA.hotel.y1-EXTRA.hotel.y0+1)*sy);

    // neighborhood
    ctx.fillStyle='#a7b0be';
    EXTRA.hoodH.forEach(y=> ctx.fillRect(EXTRA.hoodArea.x0*sx, y*sy, (EXTRA.hoodArea.x1-EXTRA.hoodArea.x0+1)*sx, sy*1.6));
    EXTRA.hoodV.forEach(x=> ctx.fillRect(x*sx, EXTRA.hoodArea.y0*sy, sx*1.6, (EXTRA.hoodArea.y1-EXTRA.hoodArea.y0+1)*sy));
    ctx.fillStyle=COL.parkGrass;
    ctx.fillRect(EXTRA.nPark.x0*sx,EXTRA.nPark.y0*sy,(EXTRA.nPark.x1-EXTRA.nPark.x0+1)*sx,(EXTRA.nPark.y1-EXTRA.nPark.y0+1)*sy);
    ctx.fillStyle='#5f91a5';
    EXTRA.houses.forEach(h=> ctx.fillRect(h.x0*sx,h.y0*sy,(h.x1-h.x0+1)*sx,(h.y1-h.y0+1)*sy));
    ctx.restore();
  }
  IZZA.on('render-post', ()=>{
    if(localStorage.getItem(TIER_KEY)!=='2') return;
    paintMapCanvas('minimap');
    paintMapCanvas('bigmap');
  });
})();
</script>
