// /static/game/js/plugins/v1_map_expander.js
(function(){
  const BUILD = 'v1.3-map-expander+tier2-layout+style-match+soft-solids';
  console.log('[IZZA PLAY]', BUILD);

  // --- Flags / keys ---
  const MAP_TIER_KEY = 'izzaMapTier';           // '1' | '2' | ...
  const TIER1 = { x0:18, y0:18, x1:72, y1:42 }; // core default
  const TIER2 = { x0:10, y0:12, x1:80, y1:50 }; // expanded bounds (your sketch)

  let api=null;
  let tier = localStorage.getItem(MAP_TIER_KEY) || '1';

  const scale = ()=> api.DRAW / api.TILE;
  const w2sX  = wx => (wx - api.camera.x) * scale();
  const w2sY  = wy => (wy - api.camera.y) * scale();

  // ---------- Camera & player bounds (no core edits) ----------
  function clampCameraTier2(){
    const visW = document.getElementById('game').width  / scale();
    const visH = document.getElementById('game').height / scale();
    const maxX = (TIER2.x1+1)*api.TILE - visW;
    const maxY = (TIER2.y1+1)*api.TILE - visH;
    api.camera.x = Math.max(TIER2.x0*api.TILE, Math.min(api.camera.x, maxX));
    api.camera.y = Math.max(TIER2.y0*api.TILE, Math.min(api.camera.y, maxY));
  }
  function softClampPlayerTier2(){
    const t=api.TILE, gx=(api.player.x/t|0), gy=(api.player.y/t|0);
    if(gx<TIER2.x0) api.player.x=(TIER2.x0+0.01)*t;
    if(gx>TIER2.x1) api.player.x=(TIER2.x1-0.01)*t;
    if(gy<TIER2.y0) api.player.y=(TIER2.y0+0.01)*t;
    if(gy>TIER2.y1) api.player.y=(TIER2.y1-0.01)*t;
  }

  // ---------- Tier 2 layout (style-matched to your core) ----------
  // NOTE: these are *overlay painters* to extend what the core draws.
  // Colors taken from your core:
  const COL_ROAD      = '#2a2a2a';
  const COL_SIDEWALK  = '#6a727b';
  const COL_DASH      = '#ffd23f';
  const COL_BUILD_SHOP= '#203a60'; // shop building
  const COL_BUILD_POL = '#0a2455'; // police-ish vibe
  const COL_BUILD_GEN = '#4a2d2d'; // generic block (similar to HQ tone)
  const COL_PARK      = '#09371c'; // same grass base, path = sidewalks

  // Road segments (all in grid units)
  // hRoad: {y, x0, x1, dashed:true}, vRoad: {x, y0, y1}
  const HROADS = [
    { y: 20, x0: 14, x1: 76, dashed: true }, // top spine
    { y: 36, x0: 14, x1: 76, dashed: true }, // bottom spine
    { y: 44, x0: 56, x1: 76, dashed: false } // lake-side road
  ];
  const VROADS = [
    { x: 28, y0: 14, y1: 44 }, // left vertical
    { x: 52, y0: 14, y1: 44 }, // right vertical
  ];

  // Sidewalks that line some of the roads (thin single-tile lines)
  const HSW = [
    { y: 19, x0: 14, x1: 76 }, // above top spine
    { y: 21, x0: 14, x1: 76 },
    { y: 35, x0: 14, x1: 76 }, // above bottom spine
    { y: 37, x0: 14, x1: 76 }
  ];
  const VSW = [
    { x: 27, y0: 14, y1: 44 },
    { x: 29, y0: 14, y1: 44 },
    { x: 51, y0: 14, y1: 44 },
    { x: 53, y0: 14, y1: 44 }
  ];

  // Buildings (rectangles in grid coords; we’ll also mark them solid)
  // b: {x,y,w,h,color}
  const BUILDINGS = [
    // Shops row (small blocks)
    { x: 20, y: 28, w: 2, h: 2, color: COL_BUILD_GEN },
    { x: 24, y: 28, w: 2, h: 2, color: COL_BUILD_GEN },
    { x: 28, y: 28, w: 2, h: 2, color: COL_BUILD_GEN },

    // New STORE (bigger blue shop)
    { x: 56, y: 24, w: 3, h: 2, color: COL_BUILD_SHOP },

    // Police station (deep blue block)
    { x: 42, y: 22, w: 3, h: 2, color: COL_BUILD_POL },

    // Another civic block bottom-right
    { x: 36, y: 38, w: 3, h: 2, color: COL_BUILD_SHOP }
  ];

  // Park “pond” (visual only here; paths are sidewalks via HSW/VSW)
  const POND = { x: 66, y: 43, rx: 1.6, ry: 1.1 }; // ellipse in tile units

  // Solids: all building tiles are solid (prevent walk/drive through)
  function isInsideRectGXGY(gx,gy, r){
    return gx>=r.x && gx<r.x+r.w && gy>=r.y && gy<r.y+r.h;
  }
  function tileIsSolidTier2(gx,gy){
    // Only enforce inside Tier2 bounds
    if(!(gx>=TIER2.x0 && gx<=TIER2.x1 && gy>=TIER2.y0 && gy<=TIER2.y1)) return false;
    for(const b of BUILDINGS){ if(isInsideRectGXGY(gx,gy,b)) return true; }
    return false;
  }

  // --- painters (overlay) ---
  function drawRoadH(ctx, y, x0, x1, dashed){
    const t = api.TILE, S=api.DRAW;
    for(let gx=x0; gx<=x1; gx++){
      const sx=w2sX(gx*t), sy=w2sY(y*t);
      // road tile
      ctx.fillStyle = COL_ROAD;
      ctx.fillRect(sx,sy,S,S);
      // dashed center line to match core look
      if(dashed){
        ctx.fillStyle = COL_DASH;
        for(let i=0;i<4;i++){
          ctx.fillRect(sx + i*(S/4) + S*0.05, sy + S*0.48, S*0.10, S*0.04);
        }
      }
    }
  }
  function drawRoadV(ctx, x, y0, y1){
    const t = api.TILE, S=api.DRAW;
    for(let gy=y0; gy<=y1; gy++){
      const sx=w2sX(x*t), sy=w2sY(gy*t);
      ctx.fillStyle = COL_ROAD;
      ctx.fillRect(sx,sy,S,S);
    }
  }
  function drawSidewalkH(ctx, y, x0, x1){
    const t = api.TILE, S=api.DRAW;
    for(let gx=x0; gx<=x1; gx++){
      const sx=w2sX(gx*t), sy=w2sY(y*t);
      ctx.fillStyle = COL_SIDEWALK;
      ctx.fillRect(sx,sy,S,S);
      ctx.strokeStyle = 'rgba(0,0,0,.25)'; // same faint grid stroke
      ctx.strokeRect(sx,sy,S,S);
    }
  }
  function drawSidewalkV(ctx, x, y0, y1){
    const t = api.TILE, S=api.DRAW;
    for(let gy=y0; gy<=y1; gy++){
      const sx=w2sX(x*t), sy=w2sY(gy*t);
      ctx.fillStyle = COL_SIDEWALK;
      ctx.fillRect(sx,sy,S,S);
      ctx.strokeStyle = 'rgba(0,0,0,.25)';
      ctx.strokeRect(sx,sy,S,S);
    }
  }
  function drawBuilding(ctx, b){
    const t=api.TILE, S=api.DRAW;
    for(let gy=b.y; gy<b.y+b.h; gy++){
      for(let gx=b.x; gx<b.x+b.w; gx++){
        const sx=w2sX(gx*t), sy=w2sY(gy*t);
        ctx.fillStyle = b.color;
        ctx.fillRect(sx,sy,S,S);
        // subtle roof line (like HQ/Shop top shading)
        ctx.fillStyle = 'rgba(0,0,0,.15)';
        ctx.fillRect(sx,sy,S,Math.floor(S*0.18));
      }
    }
  }

  function drawTier2Overlay(){
    const ctx = document.getElementById('game').getContext('2d');
    ctx.save();

    // sidewalks first (under roads looks fine in your style)
    HSW.forEach(s => drawSidewalkH(ctx, s.y, s.x0, s.x1));
    VSW.forEach(s => drawSidewalkV(ctx, s.x, s.y0, s.y1));

    // roads
    HROADS.forEach(r => drawRoadH(ctx, r.y, r.x0, r.x1, !!r.dashed));
    VROADS.forEach(r => drawRoadV(ctx, r.x, r.y0, r.y1));

    // buildings
    BUILDINGS.forEach(b => drawBuilding(ctx,b));

    // pond (simple ellipse hint)
    const S=api.DRAW, t=api.TILE;
    ctx.fillStyle = '#7db7d9';
    ctx.beginPath();
    ctx.ellipse(w2sX(POND.x*t), w2sY(POND.y*t), S*POND.rx, S*POND.ry, 0, 0, Math.PI*2);
    ctx.fill();

    ctx.restore();
  }

  // ---------- Soft solids: keep player out of Tier2 buildings ----------
  let _prevSafe = { x:0, y:0 };
  IZZA.on('update-pre', ()=>{
    // Remember safe position before movement resolves
    _prevSafe.x = api ? api.player.x : 0;
    _prevSafe.y = api ? api.player.y : 0;
  });

  function enforceTier2Solids(){
    const t=api.TILE, gx=(api.player.x/t|0), gy=(api.player.y/t|0);
    if (tileIsSolidTier2(gx,gy)){
      // push back to last safe location
      api.player.x = _prevSafe.x;
      api.player.y = _prevSafe.y;
    }
  }

  // ---------- Hooks ----------
  IZZA.on('ready', (a)=>{
    api = a;
    tier = localStorage.getItem(MAP_TIER_KEY) || '1';
    console.log('[MAP EXPANDER] ready; tier =', tier);
  });

  IZZA.on('update-post', ()=>{
    const stored = localStorage.getItem(MAP_TIER_KEY) || '1';
    if (stored !== tier) tier = stored;

    if (tier === '2'){
      softClampPlayerTier2();
      clampCameraTier2();
      enforceTier2Solids();
    }
  });

  IZZA.on('render-post', ()=>{
    if (tier === '2'){
      // Only paint our additions in Tier 2; Tier 1 remains exactly as your core draws it.
      drawTier2Overlay();
    }
  });
})();
