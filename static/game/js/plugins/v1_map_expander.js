// /static/game/js/plugins/v2_downtown_district.js
(function () {
  const BUILD = 'v2.1-downtown-only+render-under+collisions+park+police+mall';
  console.log('[IZZA PLAY]', BUILD);

  // == storage / flags ==
  const MAP_TIER_KEY = 'izzaMapTier'; // '1' | '2'

  // must match core
  function computeUnlockedRect(tier){
    if(tier!=='2') return { x0:18, y0:18, x1:72, y1:42 };
    return { x0:10, y0:12, x1:80, y1:50 };
  }

  // colors that match your core palette
  const COL = {
    grass:    '#09371c',
    road:     '#2a2a2a',
    dash:     '#ffd23f',
    sidewalk: '#6a727b',
    hq:       '#4a2d2d',
    shop:     '#203a60',
    civic:    '#405a85',
    police:   '#0a2455',
    mall:     '#203a60',
    park:     '#1b5230',
    water:    '#2b6a7a',
    plaza:    '#455064'
  };

  // live api from core once ready
  let api = null;

  // recompute the SAME anchor points your core uses so our grid stitches cleanly
  function anchors(){
    const tier = localStorage.getItem(MAP_TIER_KEY) || '1';
    const un = computeUnlockedRect(tier);

    const bW=10, bH=6;
    const bX = Math.floor((un.x0+un.x1)/2) - Math.floor(bW/2);
    const bY = un.y0 + 5;

    const hRoadY       = bY + bH + 1;               // existing east-west
    const sidewalkTopY = hRoadY - 1;
    const sidewalkBotY = hRoadY + 1;

    const vRoadX         = Math.min(un.x1-3, bX + bW + 6); // existing north-south
    const vSidewalkLeftX = vRoadX - 1;
    const vSidewalkRightX= vRoadX + 1;

    return { un, hRoadY, sidewalkTopY, sidewalkBotY, vRoadX, vSidewalkLeftX, vSidewalkRightX, bX, bY, bW, bH };
  }

  // === Downtown layout ===
  // Everything is declared in GRID coords and then drawn in render-under.
  function makeDowntown(){
    const A = anchors();
    const { un, hRoadY, vRoadX } = A;

    // Streets: stitch into the existing cores:
    //   - reuse hRoadY as the "Main" east-west
    //   - reuse vRoadX as "Central" north-south
    //   - add a clean downtown grid in the SE quadrant
    const H_ROADS = [
      { y: hRoadY,     x0: un.x0+1, x1: un.x1-1 },      // extend Main fully
      { y: hRoadY+4,   x0: vRoadX-18, x1: un.x1-2 },
      { y: hRoadY+8,   x0: vRoadX-18, x1: un.x1-2 },
      { y: hRoadY+12,  x0: vRoadX-18, x1: un.x1-2 },
      { y: hRoadY+16,  x0: vRoadX-18, x1: un.x1-2 }
    ];

    const V_ROADS = [
      { x: vRoadX,     y0: un.y0+1, y1: un.y1-1 },      // extend Central fully
      { x: vRoadX+6,   y0: hRoadY+2, y1: hRoadY+18 },
      { x: vRoadX+12,  y0: hRoadY+2, y1: hRoadY+18 },
      { x: vRoadX+18,  y0: hRoadY+2, y1: hRoadY+18 },
      { x: vRoadX+24,  y0: hRoadY+2, y1: hRoadY+18 }
    ];

    // Civic places & blocks (SOLID):
    const BUILDINGS = [
      // police station (on a block at the corner grid)
      { x: vRoadX+19, y: hRoadY+3,  w: 4, h: 3, color: COL.police },

      // shopping mall (a big blue rectangle near the south edge)
      { x: vRoadX+10, y: hRoadY+14, w: 8, h: 5, color: COL.mall },

      // mixed downtown mid-rises
      { x: vRoadX-7,  y: hRoadY+4,  w: 4, h: 3, color: COL.civic },
      { x: vRoadX-1,  y: hRoadY+4,  w: 4, h: 3, color: COL.civic },
      { x: vRoadX+6,  y: hRoadY+6,  w: 3, h: 2, color: COL.civic },
      { x: vRoadX+12, y: hRoadY+6,  w: 3, h: 2, color: COL.civic },

      // plaza (visual; still solid so NPCs flow around)
      { x: vRoadX+22, y: hRoadY+10, w: 4, h: 3, color: COL.plaza }
    ];

    // Park (visual grass/water; SOLID so player skirts it via paths)
    const PARKS = [
      // a small park with a pond in the far SE
      { x: vRoadX+25, y: hRoadY+14, w: 7, h: 5, pond:{ x: vRoadX+27, y: hRoadY+16, w: 3, h: 2 } }
    ];

    return { A, H_ROADS, V_ROADS, BUILDINGS, PARKS };
  }

  // ====== tiny helpers ======
  const scl = ()=> api.DRAW / api.TILE;
  const w2sX = (wx)=> (wx - api.camera.x) * scl();
  const w2sY = (wy)=> (wy - api.camera.y) * scl();
  function fillTile(ctx, gx, gy, color){
    const sx = w2sX(gx*api.TILE), sy = w2sY(gy*api.TILE), S = api.DRAW;
    ctx.fillStyle = color; ctx.fillRect(sx, sy, S, S);
  }
  function drawHRoad(ctx, y, x0, x1){
    for(let x=x0;x<=x1;x++){
      fillTile(ctx, x, y, COL.road);
      const sx=w2sX(x*api.TILE), sy=w2sY(y*api.TILE), S=api.DRAW;
      ctx.fillStyle = COL.dash;
      for(let i=0;i<4;i++) ctx.fillRect(sx + i*(S/4) + S*0.05, sy + S*0.48, S*0.10, S*0.04);
    }
  }
  function drawVRoad(ctx, x, y0, y1){
    for(let y=y0;y<=y1;y++) fillTile(ctx, x, y, COL.road);
  }
  function drawSidewalkRow(ctx, y, x0, x1){ for(let x=x0;x<=x1;x++) fillTile(ctx, x, y, COL.sidewalk); }
  function drawSidewalkCol(ctx, x, y0, y1){ for(let y=y0;y<=y1;y++) fillTile(ctx, x, y, COL.sidewalk); }

  function drawBuilding(ctx, b){
    for(let gy=b.y; gy<b.y+b.h; gy++){
      for(let gx=b.x; gx<b.x+b.w; gx++) fillTile(ctx, gx, gy, b.color);
    }
    const sx=w2sX(b.x*api.TILE), sy=w2sY(b.y*api.TILE);
    ctx.fillStyle='rgba(0,0,0,.15)';
    ctx.fillRect(sx, sy, b.w*api.DRAW, Math.floor(b.h*api.DRAW*0.18));
  }

  function drawPark(ctx, p){
    for(let gy=p.x?0:0, y=p.y; y<p.y+p.h; y++){
      for(let x=p.x; x<p.x+p.w; x++) fillTile(ctx, x, y, COL.park);
    }
    if(p.pond){
      const sx=w2sX(p.pond.x*api.TILE), sy=w2sY(p.pond.y*api.TILE);
      ctx.fillStyle = COL.water;
      ctx.fillRect(sx, sy, p.pond.w*api.DRAW, p.pond.h*api.DRAW);
    }
  }

  // ========= collisions (SOLIDS only for new buildings/parks) =========
  function pushOutOfSolids(layout){
    const t = api.TILE;
    const px = api.player.x, py = api.player.y;
    const gx = (px/t)|0, gy=(py/t)|0;

    function nudgeFrom(rect){
      const dxL = Math.abs(px - rect.x*t);
      const dxR = Math.abs((rect.x+rect.w)*t - px);
      const dyT = Math.abs(py - rect.y*t);
      const dyB = Math.abs((rect.y+rect.h)*t - py);
      const m = Math.min(dxL,dxR,dyT,dyB);
      if(m===dxL) api.player.x = (rect.x - 0.01)*t;
      else if(m===dxR) api.player.x = (rect.x+rect.w + 0.01)*t;
      else if(m===dyT) api.player.y = (rect.y - 0.01)*t;
      else             api.player.y = (rect.y+rect.h + 0.01)*t;
    }

    for(const b of layout.BUILDINGS){
      if(gx>=b.x && gx<b.x+b.w && gy>=b.y && gy<b.y+b.h){ nudgeFrom(b); return; }
    }
    for(const p of layout.PARKS){
      const r = { x:p.x, y:p.y, w:p.w, h:p.h };
      if(gx>=r.x && gx<r.x+r.w && gy>=r.y && gy<r.y+r.h){ nudgeFrom(r); return; }
    }
  }

  // ========= painters =========
  function paintDowntown(layer){
    const ctx = layer.getContext('2d'); if(!ctx) return;
    const L = makeDowntown();

    // base grass under everything in the expanded district so gaps don’t show
    for(let gy=L.A.un.y0; gy<=L.A.un.y1; gy++)
      for(let gx=L.A.un.x0; gx<=L.A.un.x1; gx++) fillTile(ctx, gx, gy, COL.grass);

    // sidewalks first
    L.H_ROADS.forEach(r=>{ drawSidewalkRow(ctx, r.y-1, r.x0, r.x1); drawSidewalkRow(ctx, r.y+1, r.x0, r.x1); });
    L.V_ROADS.forEach(r=>{ drawSidewalkCol(ctx, r.x-1, r.y0, r.y1); drawSidewalkCol(ctx, r.x+1, r.y0, r.y1); });

    // then roads
    L.H_ROADS.forEach(r=> drawHRoad(ctx, r.y, r.x0, r.x1));
    L.V_ROADS.forEach(r=> drawVRoad(ctx, r.x, r.y0, r.y1));

    // solids
    L.PARKS.forEach(p=> drawPark(ctx, p));
    L.BUILDINGS.forEach(b=> drawBuilding(ctx, b));

    // keep collisions in sync
    pushOutOfSolids(L);
  }

  // ===== hooks =====
  IZZA.on('ready', (a)=>{
    api = a;
  });

  // draw UNDER sprites, OVER tiles
  IZZA.on('render-under', ()=>{
    if((localStorage.getItem(MAP_TIER_KEY)||'1')!=='2') return;
    const canvas = document.getElementById('game');
    paintDowntown(canvas);
  });

  IZZA.on('update-post', ()=>{
    if((localStorage.getItem(MAP_TIER_KEY)||'1')!=='2') return;
    // also run collision here to be extra safe
    pushOutOfSolids(makeDowntown());
  });
})();
