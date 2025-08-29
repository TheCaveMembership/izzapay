// /static/game/js/plugins/v1_map_expander.js
(function () {
  const BUILD = 'v2.4-map-expander+downtown-only+stitched+tiles+minimap+bigmap';
  console.log('[IZZA PLAY]', BUILD);

  // ===== Flags / bounds =====
  const MAP_TIER_KEY = 'izzaMapTier';              // '1' | '2'
  const BASE  = { x0:18, y0:18, x1:72, y1:42 };    // Tier-1 box in core
  const TIER2 = { x0:10, y0:12, x1:80, y1:50 };    // Expanded play area (core shows this when tier=2)

  // Palette that matches core painter
  const COL = {
    grass:    '#09371c',
    road:     '#2a2a2a',
    dash:     '#ffd23f',
    sidewalk: '#6a727b',
    red:      '#7a3a3a',  // big red slab
    civic:    '#405a85',  // blue civic blocks
    police:   '#0a2455',
    library:  '#8a5a2b',
    shop:     '#203a60',
    water:    '#2b6a7a'
  };

  let api=null;
  const state = { tier: localStorage.getItem(MAP_TIER_KEY) || '1' };
  const isTier2 = () => state.tier === '2';

  // ===== Geometry helpers (match core math so stitches align) =====
  // Core hub & main road positions (recomputed using BASE, same formulas as core)
  const bW=10, bH=6;
  const bX = Math.floor((BASE.x0+BASE.x1)/2) - Math.floor(bW/2);
  const bY = BASE.y0 + 5;
  const hRoadY = bY + bH + 1;            // main horizontal road row (== 30)
  const vRoadX = Math.min(BASE.x1-3, bX + bW + 6); // main vertical road col (== 56)
  const sTop   = hRoadY - 1, sBot = hRoadY + 1;    // sidewalks that core draws

  // We’ll place downtown **below** the main road and centered, without touching Tier-1 buildings.
  // Rows are chosen to be inside TIER2 and above its bottom.
  const DT = {
    // Stitched vertical spine: continue the Tier-1 main vertical straight down
    V_ROADS: [
      { x: vRoadX, y0: hRoadY+1, y1: TIER2.y1-2 }, // stitch ↓ from the main road
      // extra downtown verticals (balanced around the stitch)
      { x: vRoadX-14, y0: hRoadY+2, y1: TIER2.y1-4 },
      { x: vRoadX-26, y0: hRoadY+4, y1: TIER2.y1-6 },
      { x: vRoadX+12, y0: hRoadY+2, y1: TIER2.y1-6 }
    ],
    // Downtown east-west grid, starting a bit below the Tier-1 main road
    H_ROADS: [
      { y: hRoadY+4,  x0: TIER2.x0+6, x1: TIER2.x1-6 },
      { y: hRoadY+10, x0: TIER2.x0+6, x1: TIER2.x1-6 },
      { y: hRoadY+16, x0: TIER2.x0+8, x1: TIER2.x1-8 },
      { y: hRoadY+22, x0: TIER2.x0+10, x1: TIER2.x1-10 }
    ],
    // Buildings (kept off road/sidewalk lines), all inside TIER2
    BUILDINGS: [
      // central red slab just south of main road, left of the stitch
      { x: vRoadX-8,  y: hRoadY+5,  w: 6, h: 4, color: COL.red },
      // civic blues
      { x: vRoadX+2,  y: hRoadY+6,  w: 5, h: 3, color: COL.civic },
      { x: vRoadX-22, y: hRoadY+17, w: 4, h: 3, color: COL.civic },
      // shops row
      { x: vRoadX-28, y: hRoadY+11, w: 2, h: 2, color: COL.shop },
      { x: vRoadX-24, y: hRoadY+11, w: 2, h: 2, color: COL.shop },
      { x: vRoadX-20, y: hRoadY+11, w: 2, h: 2, color: COL.shop },
      // police + library anchors
      { x: vRoadX+10, y: hRoadY+3,  w: 3, h: 2, color: COL.police },
      { x: vRoadX+16, y: hRoadY+21, w: 5, h: 3, color: COL.library }
    ],
    // little rectangular pond in the southeast of the new grid
    LAKES: [{ x: vRoadX+12, y: hRoadY+18, w: 6, h: 3 }]
  };

  // ===== Helpers: coords & painters =====
  const SCL = ()=> api.DRAW / api.TILE;
  const w2sX = (wx)=> (wx - api.camera.x) * SCL();
  const w2sY = (wy)=> (wy - api.camera.y) * SCL();

  function fillTile(ctx, gx, gy, color){
    const sx=w2sX(gx*api.TILE), sy=w2sY(gy*api.TILE), S=api.DRAW;
    ctx.fillStyle=color; ctx.fillRect(sx,sy,S,S);
  }

  function drawHRoad(ctx, y, x0, x1){
    for(let x=x0; x<=x1; x++){
      fillTile(ctx,x,y,COL.road);
      const sx=w2sX(x*api.TILE), sy=w2sY(y*api.TILE), S=api.DRAW;
      ctx.fillStyle=COL.dash;
      for(let i=0;i<4;i++) ctx.fillRect(sx + i*(S/4) + S*0.05, sy + S*0.48, S*0.10, S*0.04);
    }
  }
  function drawVRoad(ctx, x, y0, y1){
    for(let y=y0; y<=y1; y++) fillTile(ctx,x,y,COL.road);
  }
  function drawSidewalkRow(ctx, y, x0, x1){ for(let x=x0; x<=x1; x++) fillTile(ctx,x,y,COL.sidewalk); }
  function drawSidewalkCol(ctx, x, y0, y1){ for(let y=y0; y<=y1; y++) fillTile(ctx,x,y,COL.sidewalk); }

  function drawBuilding(ctx, b){
    for(let gy=b.y; gy<b.y+b.h; gy++)
      for(let gx=b.x; gx<b.x+b.w; gx++) fillTile(ctx,gx,gy,b.color);
    // subtle top shade like core
    const sx=w2sX(b.x*api.TILE), sy=w2sY(b.y*api.TILE);
    ctx.fillStyle='rgba(0,0,0,.15)';
    ctx.fillRect(sx, sy, b.w*api.DRAW, Math.floor(b.h*api.DRAW*0.18));
  }

  function drawLake(ctx, r){
    const sx=w2sX(r.x*api.TILE), sy=w2sY(r.y*api.TILE);
    ctx.fillStyle=COL.water;
    ctx.fillRect(sx, sy, r.w*api.DRAW, r.h*api.DRAW);
  }

  // ===== Camera widening (don’t touch core clamp) =====
  function widenCameraClampIfNeeded(){
    if(!isTier2() || widenCameraClampIfNeeded._done) return;
    widenCameraClampIfNeeded._done = true;
    IZZA.on('update-post', ()=>{
      const visW = document.getElementById('game').width  / SCL();
      const visH = document.getElementById('game').height / SCL();
      const maxX = (TIER2.x1+1)*api.TILE - visW;
      const maxY = (TIER2.y1+1)*api.TILE - visH;
      api.camera.x = Math.max(TIER2.x0*api.TILE, Math.min(api.camera.x, maxX));
      api.camera.y = Math.max(TIER2.y0*api.TILE, Math.min(api.camera.y, maxY));
    });
  }

  // ===== Collisions for **new** buildings only (roads stay passable) =====
  function pushOutOfSolids(){
    if(!isTier2()) return;
    const t=api.TILE;
    const px=api.player.x, py=api.player.y;
    const gx=(px/t|0), gy=(py/t|0);

    for(const b of DT.BUILDINGS){
      if(gx>=b.x && gx<b.x+b.w && gy>=b.y && gy<b.y+b.h){
        const dxL=Math.abs(px - b.x*t);
        const dxR=Math.abs((b.x+b.w)*t - px);
        const dyT=Math.abs(py - b.y*t);
        const dyB=Math.abs((b.y+b.h)*t - py);
        const m=Math.min(dxL,dxR,dyT,dyB);
        if(m===dxL) api.player.x=(b.x-0.01)*t;
        else if(m===dxR) api.player.x=(b.x+b.w+0.01)*t;
        else if(m===dyT) api.player.y=(b.y-0.01)*t;
        else             api.player.y=(b.y+b.h+0.01)*t;
        break;
      }
    }
  }

  // ===== Main canvas painter (behind core tiles/sprites) =====
  function drawMainOverlay(){
    if(!isTier2()) return;
    const ctx=document.getElementById('game').getContext('2d');
    ctx.save();
    ctx.globalCompositeOperation='destination-over';

    // base grass for the new district (keeps look coherent)
    for(let gy=TIER2.y0; gy<=TIER2.y1; gy++)
      for(let gx=TIER2.x0; gx<=TIER2.x1; gx++)
        fillTile(ctx,gx,gy,COL.grass);

    // sidewalks around each new road (±1 like core)
    DT.H_ROADS.forEach(r=>{
      drawSidewalkRow(ctx, r.y-1, r.x0, r.x1);
      drawSidewalkRow(ctx, r.y+1, r.x0, r.x1);
    });
    DT.V_ROADS.forEach(r=>{
      drawSidewalkCol(ctx, r.x-1, r.y0, r.y1);
      drawSidewalkCol(ctx, r.x+1, r.y0, r.y1);
    });

    // the roads themselves
    DT.H_ROADS.forEach(r=> drawHRoad(ctx, r.y, r.x0, r.x1));
    DT.V_ROADS.forEach(r=> drawVRoad(ctx, r.x, r.y0, r.y1));

    // buildings & lake(s)
    DT.BUILDINGS.forEach(b=> drawBuilding(ctx,b));
    DT.LAKES.forEach(l=> drawLake(ctx,l));

    ctx.restore();
  }

  // ===== Minimap & Big map overlays =====
  function drawMiniOverlay(){
    if(!isTier2()) return;
    const c=document.getElementById('minimap');
    const m=c && c.getContext ? c.getContext('2d') : null;
    if(!c||!m) return;
    const sx = c.width/90, sy=c.height/60;

    // roads
    m.fillStyle='#8a90a0';
    DT.H_ROADS.forEach(r=> m.fillRect(r.x0*sx, r.y*sy, (r.x1-r.x0+1)*sx, 1*sy));
    DT.V_ROADS.forEach(r=> m.fillRect(r.x*sx, r.y0*sy, 1*sx, (r.y1-r.y0+1)*sy));
    // buildings
    DT.BUILDINGS.forEach(b=> { m.fillStyle=b.color; m.fillRect(b.x*sx,b.y*sy,b.w*sx,b.h*sy); });
    // lake
    DT.LAKES.forEach(l=> { m.fillStyle='#7db7d9'; m.fillRect(l.x*sx,l.y*sy,l.w*sx,l.h*sy); });
  }
  function drawBigOverlay(){
    if(!isTier2()) return;
    const c=document.getElementById('bigmap');
    const m=c && c.getContext ? c.getContext('2d') : null;
    if(!c||!m) return;
    const sx = c.width/90, sy=c.height/60;

    m.save();
    m.fillStyle='#8a90a0';
    DT.H_ROADS.forEach(r=> m.fillRect(r.x0*sx, r.y*sy, (r.x1-r.x0+1)*sx, 1.2*sy));
    DT.V_ROADS.forEach(r=> m.fillRect(r.x*sx, r.y0*sy, 1.2*sx, (r.y1-r.y0+1)*sy));
    DT.BUILDINGS.forEach(b=> { m.fillStyle=b.color; m.fillRect(b.x*sx,b.y*sy,b.w*sx,b.h*sy); });
    DT.LAKES.forEach(l=> { m.fillStyle='#7db7d9'; m.fillRect(l.x*sx,l.y*sy,l.w*sx,l.h*sy); });
    m.restore();
  }

  // ===== Hooks =====
  IZZA.on('ready', (a)=>{
    api=a;

    state.tier = localStorage.getItem(MAP_TIER_KEY) || '1';
    if(isTier2()) widenCameraClampIfNeeded();

    // If the big map opens, refresh its overlay too
    const mapModal=document.getElementById('mapModal');
    if(mapModal){
      const obs=new MutationObserver(()=>{
        if(mapModal.style.display==='flex') drawBigOverlay();
      });
      obs.observe(mapModal, { attributes:true, attributeFilter:['style'] });
    }
  });

  IZZA.on('update-post', ()=>{
    const cur = localStorage.getItem(MAP_TIER_KEY) || '1';
    if(cur !== state.tier){
      state.tier = cur;
      if(isTier2()) widenCameraClampIfNeeded();
    }
    if(isTier2()) pushOutOfSolids();
  });

  IZZA.on('render-post', ()=>{
    if(!isTier2()) return;
    drawMainOverlay();   // playfield
    drawMiniOverlay();   // minimap in HUD
    // big map overlay is drawn when the modal opens
  });
})();
