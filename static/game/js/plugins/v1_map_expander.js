// downtown_full_unlock_fix.js
(function () {
  const MAP_TIER_KEY = 'izzaMapTier';
  const COL = {
    road:'#2a2a2a', dash:'#ffd23f', sidewalk:'#6a727b',
    civic:'#405a85', police:'#0a2455', shop:'#203a60', park:'#2b6a7a'
  };

  function unlockedRect(t){ return (t!=='2') ? {x0:18,y0:18,x1:72,y1:42} : {x0:10,y0:12,x1:80,y1:50}; }

  function anchors(api){
    const tier = localStorage.getItem(MAP_TIER_KEY)||'1';
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

    // shop (same as core)
    const shop = { w:8, h:5, x:vSidewalkRightX+1, y: sidewalkTopY-5 };

    return {tier,un,bX,bY,bW,bH,hRoadY,sidewalkTopY,sidewalkBotY,vRoadX,vSidewalkLeftX,vSidewalkRightX,shop};
  }

  function makeDowntown(a){
    const {un,hRoadY,vRoadX} = a;
    const L=un.x0+1,R=un.x1-1,T=un.y0+1,B=un.y1-1;

    const H=[], V=[], BLD=[];
    const addBox=(x,y,w,h,color)=>BLD.push({x,y,w,h,color});

    H.push({y:hRoadY,x0:L,x1:R});
    for(let y=hRoadY-8; y>=T; y-=4) H.push({y,x0:L,x1:R});
    for(let y=hRoadY+4; y<=B; y+=4) H.push({y,x0:L,x1:R});

    V.push({x:vRoadX,y0:T,y1:B});
    for(let x=vRoadX-12; x>=L; x-=6) V.push({x,y0:T,y1:B});
    for(let x=vRoadX+6;  x<=R; x+=6) V.push({x,y0:T,y1:B});

    addBox(vRoadX+8,  hRoadY-9, 5,3, COL.civic);
    addBox(vRoadX+15, hRoadY-9, 4,3, COL.civic);
    addBox(vRoadX+13, hRoadY+5, 4,3, COL.police);
    addBox(vRoadX+4,  hRoadY+13, 8,5, COL.shop);
    [[vRoadX-7,hRoadY+5],[vRoadX-1,hRoadY+5],[vRoadX+6,hRoadY+7],[vRoadX+18,hRoadY+11],[vRoadX-6,hRoadY+13],[vRoadX+20,hRoadY-1]]
      .forEach(([x,y])=>addBox(x,y,3,2,COL.civic));

    const PARK={x:R-11,y:B-7,w:9,h:5};
    return {H_ROADS:H, V_ROADS:V, BUILDINGS:BLD, PARK};
  }

  // helpers
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

  // skip painting over original HQ/shop
  function makeSkip(a){
    const HQ = {x0:a.bX, y0:a.bY, x1:a.bX+a.bW-1, y1:a.bY+a.bH-1};
    const SH = {x0:a.shop.x, y0:a.shop.y, x1:a.shop.x+a.shop.w-1, y1:a.shop.y+a.shop.h-1};
    return (gx,gy)=> (gx>=HQ.x0&&gx<=HQ.x1&&gy>=HQ.y0&&gy<=HQ.y1) ||
                     (gx>=SH.x0&&gx<=SH.x1&&gy>=SH.y0&&gy<=SH.y1);
  }

  // -------- UNDERLAY DRAW (no base fill; respect old area) --------
  IZZA.on('render-under', ()=>{
    if(!IZZA.api||!IZZA.api.ready) return;
    const tier=localStorage.getItem(MAP_TIER_KEY)||'1';
    if(tier!=='2') return;

    const api=IZZA.api;
    const a=anchors(api);
    const L=makeDowntown(a);
    const skip=makeSkip(a);
    const ctx=document.getElementById('game').getContext('2d');

    // sidewalks first
    L.H_ROADS.forEach(r=>{
      for(let x=r.x0;x<=r.x1;x++){
        if(!skip(x,r.y-1)) fillTile(api,ctx,x,r.y-1,COL.sidewalk);
        if(!skip(x,r.y+1)) fillTile(api,ctx,x,r.y+1,COL.sidewalk);
      }
    });
    L.V_ROADS.forEach(r=>{
      for(let y=r.y0;y<=r.y1;y++){
        if(!skip(r.x-1,y)) fillTile(api,ctx,r.x-1,y,COL.sidewalk);
        if(!skip(r.x+1,y)) fillTile(api,ctx,r.x+1,y,COL.sidewalk);
      }
    });

    // roads (don’t paint if it would cover HQ/shop)
    L.H_ROADS.forEach(r=> drawHRoad(api,ctx,r.y,r.x0,r.x1));
    L.V_ROADS.forEach(r=> drawVRoad(api,ctx,r.x,r.y0,r.y1));

    // buildings (skip HQ/shop tiles)
    L.BUILDINGS.forEach(b=>{
      for(let gy=b.y; gy<b.y+b.h; gy++)
        for(let gx=b.x; gx<b.x+b.w; gx++)
          if(!skip(gx,gy)) fillTile(api,ctx,gx,gy,b.color);
      const sx=w2sX(api,b.x*api.TILE), sy=w2sY(api,b.y*api.TILE);
      ctx.fillStyle='rgba(0,0,0,.15)';
      ctx.fillRect(sx,sy, b.w*api.DRAW, Math.floor(b.h*api.DRAW*0.18));
    });

    if(L.PARK){
      const p=L.PARK, sx=w2sX(api,p.x*api.TILE), sy=w2sY(api,p.y*api.TILE);
      ctx.fillStyle=COL.park; ctx.fillRect(sx,sy, p.w*api.DRAW, p.h*api.DRAW);
    }

    window.__DT_LAYOUT__ = {L,a};
  });

  // soft-collide against only NEW buildings
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
  IZZA.on('update-post', ()=>{ if(localStorage.getItem(MAP_TIER_KEY)==='2') softCollide(); });

  // draw overlay on mini/big map AFTER core
  function paintMapCanvas(id){
    const pack=window.__DT_LAYOUT__; if(!pack) return;
    const {L}=pack;
    const c=document.getElementById(id); if(!c) return;
    const ctx=c.getContext('2d');
    const sx=c.width/90, sy=c.height/60;

    // roads
    ctx.fillStyle='#8a90a0';
    L.H_ROADS.forEach(r=> ctx.fillRect(r.x0*sx, r.y*sy, (r.x1-r.x0+1)*sx, 1.2*sy));
    L.V_ROADS.forEach(r=> ctx.fillRect(r.x*sx, r.y0*sy, 1.2*sx, (r.y1-r.y0+1)*sy));
    // buildings
    L.BUILDINGS.forEach(b=>{ ctx.fillStyle='#6f87b3'; ctx.fillRect(b.x*sx,b.y*sy,b.w*sx,b.h*sy); });
    // park
    if(L.PARK){ const p=L.PARK; ctx.fillStyle='#7db7d9'; ctx.fillRect(p.x*sx,p.y*sy,p.w*sx,p.h*sy); }
  }
  IZZA.on('render-post', ()=>{
    if(localStorage.getItem(MAP_TIER_KEY)!=='2') return;
    paintMapCanvas('minimap');
    paintMapCanvas('bigmap');
  });
})();
