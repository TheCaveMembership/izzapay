// /static/game/js/plugins/downtown_full_unlock.js
(function () {
  const COL = {
    grass:    '#09371c',
    road:     '#2a2a2a',
    dash:     '#ffd23f',
    sidewalk: '#6a727b',
    civic:    '#405a85',
    shop:     '#203a60',
    police:   '#0a2455',
    park:     '#2b6a7a'
  };

  const MAP_TIER_KEY = 'izzaMapTier';

  // --- mirror core’s rectangles so we cover the true playable box
  function unlockedRect(tier){
    if(tier!=='2') return { x0:18, y0:18, x1:72, y1:42 };
    return { x0:10, y0:12, x1:80, y1:50 };
  }

  // live anchors from core (recomputed so stitches line up)
  function anchors(api){
    const tier = localStorage.getItem(MAP_TIER_KEY) || '1';
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

    return { tier, un, bX,bY,bW,bH, hRoadY, sidewalkTopY, sidewalkBotY, vRoadX, vSidewalkLeftX, vSidewalkRightX };
  }

  // --- downtown grid that fills the whole Tier-2 box
  function makeDowntown(a){
    const { un, hRoadY, vRoadX } = a;

    // leave a 1-tile safety margin so we don’t draw outside the clamp
    const L = un.x0+1, R = un.x1-1, T = un.y0+1, B = un.y1-1;

    // target the **entire** rectangle, but always include the existing main roads
    const H = [];
    const V = [];

    // stitch lines (the originals), then add evenly spaced blocks across the box
    H.push({ y:hRoadY, x0:L, x1:R });

    // place parallel E-W streets every 4 tiles above and below
    for(let y=hRoadY-8; y>=T; y-=4) H.push({ y, x0:L, x1:R });
    for(let y=hRoadY+4; y<=B; y+=4) H.push({ y, x0:L, x1:R });

    V.push({ x:vRoadX, y0:T, y1:B });

    // place N-S streets every 6 tiles to the left and right
    for(let x=vRoadX-12; x>=L; x-=6) V.push({ x, y0:T, y1:B });
    for(let x=vRoadX+6;  x<=R; x+=6) V.push({ x, y0:T, y1:B });

    // buildings: avoid the HQ/Shop area (north-west of the stitch), fill blocks elsewhere
    const BLD = [];
    function addBox(x,y,w,h,color){ BLD.push({x,y,w,h,color}); }

    // civic strip near top
    addBox(vRoadX+8, hRoadY-9, 5,3, COL.civic);
    addBox(vRoadX+15, hRoadY-9, 4,3, COL.civic);

    // police + mall in the south/east
    addBox(vRoadX+13, hRoadY+5,  4,3, COL.police);
    addBox(vRoadX+4,  hRoadY+13, 8,5, COL.shop); // mall

    // scatter a few mid-rises across remaining blocks (avoid HQ band to the NW)
    const scatter = [
      [vRoadX-7, hRoadY+5], [vRoadX-1, hRoadY+5],
      [vRoadX+6, hRoadY+7], [vRoadX+18, hRoadY+11],
      [vRoadX-6, hRoadY+13],[vRoadX+20, hRoadY-1]
    ];
    scatter.forEach(([x,y])=> addBox(x,y,3,2,COL.civic));

    // park/lake in SE corner
    const PARK = { x:R-11, y:B-7, w:9, h:5 };

    return { H_ROADS:H, V_ROADS:V, BUILDINGS:BLD, PARK };
  }

  // ==== draw helpers (underlay pass) ====
  function scl(api){ return api.DRAW / api.TILE; }
  function w2sX(api,wx){ return (wx - api.camera.x) * scl(api); }
  function w2sY(api,wy){ return (wy - api.camera.y) * scl(api); }
  function fillTile(api, ctx, gx, gy, color){
    const S = api.DRAW, sx = w2sX(api,gx*api.TILE), sy = w2sY(api,gy*api.TILE);
    ctx.fillStyle = color; ctx.fillRect(sx,sy,S,S);
  }
  function drawHRoad(api, ctx, y, x0, x1){
    for(let x=x0;x<=x1;x++){
      fillTile(api,ctx,x,y,COL.road);
      const S=api.DRAW, sx=w2sX(api,x*api.TILE), sy=w2sY(api,y*api.TILE);
      ctx.fillStyle = COL.dash;
      for(let i=0;i<4;i++) ctx.fillRect(sx + i*(S/4) + S*0.05, sy + S*0.48, S*0.10, S*0.04);
    }
  }
  function drawVRoad(api, ctx, x, y0, y1){
    for(let y=y0;y<=y1;y++) fillTile(api,ctx,x,y,COL.road);
  }

  // === collisions (soft push out) for NEW buildings only ===
  function pushOutOfNewSolids(api, layout){
    if(!layout) return;
    const t = api.TILE, px=api.player.x, py=api.player.y;
    const gx=(px/t)|0, gy=(py/t)|0;

    for(const b of layout.BUILDINGS){
      if(gx>=b.x && gx<b.x+b.w && gy>=b.y && gy<b.y+b.h){
        const dxL = Math.abs(px - b.x*t);
        const dxR = Math.abs((b.x+b.w)*t - px);
        const dyT = Math.abs(py - b.y*t);
        const dyB = Math.abs((b.y+b.h)*t - py);
        const m=Math.min(dxL,dxR,dyT,dyB);
        if(m===dxL) api.player.x = (b.x-0.01)*t;
        else if(m===dxR) api.player.x = (b.x+b.w+0.01)*t;
        else if(m===dyT) api.player.y = (b.y-0.01)*t;
        else             api.player.y = (b.y+b.h+0.01)*t;
        break;
      }
    }
  }

  // ===== render hooks =====
  IZZA.on('render-under', () => {
    if(!IZZA.api || !IZZA.api.ready) return;
    const api = IZZA.api;
    const tier = localStorage.getItem(MAP_TIER_KEY) || '1';
    if(tier!=='2') return; // only after mission 3

    const ctx = document.getElementById('game').getContext('2d');
    const a = anchors(api);
    const L = makeDowntown(a);

    // draw everything UNDER sprites
    // base grass only inside the unlocked rect (no blanket over old tiles outside)
    for(let gy=a.un.y0; gy<=a.un.y1; gy++){
      for(let gx=a.un.x0; gx<=a.un.x1; gx++){
        fillTile(api, ctx, gx, gy, COL.grass);
      }
    }

    // sidewalks (±1 tile around each road)
    L.H_ROADS.forEach(r=>{
      for(let x=r.x0; x<=r.x1; x++){ fillTile(api,ctx,x,r.y-1,COL.sidewalk); fillTile(api,ctx,x,r.y+1,COL.sidewalk); }
    });
    L.V_ROADS.forEach(r=>{
      for(let y=r.y0; y<=r.y1; y++){ fillTile(api,ctx,r.x-1,y,COL.sidewalk); fillTile(api,ctx,r.x+1,y,COL.sidewalk); }
    });

    // roads
    L.H_ROADS.forEach(r=> drawHRoad(api, ctx, r.y, r.x0, r.x1));
    L.V_ROADS.forEach(r=> drawVRoad(api, ctx, r.x, r.y0, r.y1));

    // buildings
    L.BUILDINGS.forEach(b=>{
      for(let gy=b.y; gy<b.y+b.h; gy++)
        for(let gx=b.x; gx<b.x+b.w; gx++)
          fillTile(api,ctx,gx,gy,b.color);
      const sx=w2sX(api,b.x*api.TILE), sy=w2sY(api,b.y*api.TILE);
      ctx.fillStyle='rgba(0,0,0,.15)';
      ctx.fillRect(sx,sy, b.w*api.DRAW, Math.floor(b.h*api.DRAW*0.18));
    });

    // park/lake
    if(L.PARK){
      const p=L.PARK, sx=w2sX(api,p.x*api.TILE), sy=w2sY(api,p.y*api.TILE);
      ctx.fillStyle = COL.park; ctx.fillRect(sx,sy, p.w*api.DRAW, p.h*api.DRAW);
    }

    // store current layout for collisions + for minimap pass
    downtown_full_unlock._layout = L;
    downtown_full_unlock._anchors = a;
  });

  // soft collisions + minimap/bigmap overlays
  function paintMapCanvas(id){
    const c = document.getElementById(id);
    if(!c || !c.getContext) return;
    const ctx = c.getContext('2d');
    const L = downtown_full_unlock._layout;
    const a = downtown_full_unlock._anchors;
    if(!L || !a) return;

    const sx = c.width / 90, sy = c.height / 60;

    // roads
    ctx.save();
    ctx.fillStyle = '#8a90a0';
    L.H_ROADS.forEach(r=> ctx.fillRect(r.x0*sx, r.y*sy, (r.x1-r.x0+1)*sx, 1.2*sy));
    L.V_ROADS.forEach(r=> ctx.fillRect(r.x*sx, r.y0*sy, 1.2*sx, (r.y1-r.y0+1)*sy));
    // buildings
    L.BUILDINGS.forEach(b=>{ ctx.fillStyle=b.color; ctx.fillRect(b.x*sx, b.y*sy, b.w*sx, b.h*sy); });
    // park
    if(L.PARK){ const p=L.PARK; ctx.fillStyle='#7db7d9'; ctx.fillRect(p.x*sx, p.y*sy, p.w*sx, p.h*sy); }
    ctx.restore();
  }

  const downtown_full_unlock = {};
  IZZA.on('update-post', ()=>{
    if(!IZZA.api || !IZZA.api.ready) return;
    const tier = localStorage.getItem(MAP_TIER_KEY) || '1';
    if(tier!=='2') return;
    // soft collisions on new solids
    pushOutOfNewSolids(IZZA.api, downtown_full_unlock._layout);

    // keep minimap/bigmap in sync (paint over core’s base)
    paintMapCanvas('minimap');
    paintMapCanvas('bigmap');
  });

})();
