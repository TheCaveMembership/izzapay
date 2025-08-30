// downtown_clip_safe_layout.js
(function () {
  const TIER_KEY = 'izzaMapTier';

  // colors
  const COL = {
    road:'#2a2a2a', dash:'#ffd23f', sidewalk:'#6a727b',
    civic:'#405a85', police:'#0a2455', shop:'#203a60', park:'#2b6a7a'
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

  // ---------- grid proposal (no overlap yet) ----------
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

    // sample buildings (kept away later)
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
    // returns array of {y,x0,x1} with the overlaps cut out
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
      inflate(a.HQ,0), inflate(a.SH,0),            // keep away from old blds
      inflate({x0:a.door.gx,y0:a.door.gy,x1:a.door.gx,y1:a.door.gy},1),        // door + 1 tile
      inflate({x0:a.register.gx,y0:a.register.gy,x1:a.register.gx,y1:a.register.gy},1) // register + 1
    ];

    const H = P.H.flatMap(seg => clipHSegment(seg, NO_ROAD));
    const V = P.V.flatMap(seg => clipVSegment(seg, NO_ROAD));

    // Buildings: keep at least 1-tile gap from HQ/Shop; if touching, nudge away
    const keepAway = inflate(a.HQ,1);
    const keepAway2= inflate(a.SH,1);
    const BLD = P.BLD.map(b=>{
      let bx=b.x, by=b.y;
      // nudge horizontally if overlapping
      if(overlapsRect(bx,by,bx+b.w-1,by+b.h-1, keepAway) || overlapsRect(bx,by,bx+b.w-1,by+b.h-1, keepAway2)){
        if(bx <= a.bX) bx = keepAway.x0 - b.w - 1; else bx = keepAway.x1 + 1;
        if(by <= a.bY) by = keepAway.y0 - b.h - 1; else by = keepAway.y1 + 1;
      }
      return {x:bx,y:by,w:b.w,h:b.h,color:b.color};
    });

    return {H_ROADS:H, V_ROADS:V, BUILDINGS:BLD, PARK:P.PARK};
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

  // ---------- paint UNDER player/NPC (but above grass) ----------
  IZZA.on('render-under', ()=>{
    if(!IZZA.api||!IZZA.api.ready) return;
    if(localStorage.getItem(TIER_KEY)!=='2') return;

    const api=IZZA.api;
    const a=anchors(api);
    const L=makeSafeLayout(a);
    const ctx=document.getElementById('game').getContext('2d');

    // sidewalks first (clip parallel to roads we actually draw)
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

    if(L.PARK){
      const p=L.PARK, sx=w2sX(api,p.x*api.TILE), sy=w2sY(api,p.y*api.TILE);
      ctx.fillStyle=COL.park; ctx.fillRect(sx,sy, p.w*api.DRAW, p.h*api.DRAW);
    }

    // stash for collision + minimap
    window.__DT_LAYOUT__ = {L};
  });

  // ---------- light collision only against NEW buildings ----------
  function softCollide(){
    const api=IZZA.api; const pack=window.__DT_LAYOUT__; if(!api||!pack) return;
    const {L}=pack; const t=api.TILE; const px=api.player.x, py=api.player.y;
    const gx=(px/t)|0, gy=(py/t)|0;
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
  IZZA.on('update-post', ()=>{ if(localStorage.getItem(TIER_KEY)==='2') softCollide(); });

  // ---------- minimap/bigmap painting AFTER core ----------
  function paintMapCanvas(id){
    const pack=window.__DT_LAYOUT__; if(!pack) return;
    const {L}=pack;
    const c=document.getElementById(id); if(!c) return;
    const ctx=c.getContext('2d');
    const sx=c.width/90, sy=c.height/60;

    ctx.save();
    // roads
    ctx.fillStyle='#8a90a0';
    L.H_ROADS.forEach(r=> ctx.fillRect(r.x0*sx, r.y*sy, (r.x1-r.x0+1)*sx, 1.2*sy));
    L.V_ROADS.forEach(r=> ctx.fillRect(r.x*sx, r.y0*sy, 1.2*sx, (r.y1-r.y0+1)*sy));
    // buildings
    L.BUILDINGS.forEach(b=>{ ctx.fillStyle='#6f87b3'; ctx.fillRect(b.x*sx,b.y*sy,b.w*sx,b.h*sy); });
    // park
    if(L.PARK){ const p=L.PARK; ctx.fillStyle='#7db7d9'; ctx.fillRect(p.x*sx,p.y*sy,p.w*sx,p.h*sy); }
    ctx.restore();
  }
  IZZA.on('render-post', ()=>{
    if(localStorage.getItem(TIER_KEY)!=='2') return;
    paintMapCanvas('minimap');
    paintMapCanvas('bigmap');
  });
})();
