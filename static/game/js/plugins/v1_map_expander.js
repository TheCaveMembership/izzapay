(function(){
  const BUILD = 'v1.4-map-expander+tier2-layout+behind-frame+aabb-solids+minimap';
  console.log('[IZZA PLAY]', BUILD);

  const MAP_TIER_KEY = 'izzaMapTier';           // '1' | '2' | ...
  const TIER1 = { x0:18, y0:18, x1:72, y1:42 };
  const TIER2 = { x0:10, y0:12, x1:80, y1:50 }; // expanded bounds

  let api=null;
  let tier = localStorage.getItem(MAP_TIER_KEY) || '1';
  let _prevSafe = { x:0, y:0 };

  // --- style (matches your core) ---
  const COL_ROAD      = '#2a2a2a';
  const COL_SIDEWALK  = '#6a727b';
  const COL_DASH      = '#ffd23f';
  const COL_BUILD_SHOP= '#203a60';
  const COL_BUILD_POL = '#0a2455';
  const COL_BUILD_GEN = '#4a2d2d';

  // layout (grid units)
  const HROADS = [
    { y:20, x0:14, x1:76, dashed:true },
    { y:36, x0:14, x1:76, dashed:true },
    { y:44, x0:56, x1:76, dashed:false }
  ];
  const VROADS = [
    { x:28, y0:14, y1:44 },
    { x:52, y0:14, y1:44 },
  ];
  const HSW = [
    { y:19, x0:14, x1:76 },
    { y:21, x0:14, x1:76 },
    { y:35, x0:14, x1:76 },
    { y:37, x0:14, x1:76 }
  ];
  const VSW = [
    { x:27, y0:14, y1:44 },
    { x:29, y0:14, y1:44 },
    { x:51, y0:14, y1:44 },
    { x:53, y0:14, y1:44 }
  ];
  const BUILDINGS = [
    { x:20, y:28, w:2, h:2, color: COL_BUILD_GEN },
    { x:24, y:28, w:2, h:2, color: COL_BUILD_GEN },
    { x:28, y:28, w:2, h:2, color: COL_BUILD_GEN },
    { x:56, y:24, w:3, h:2, color: COL_BUILD_SHOP }, // store
    { x:42, y:22, w:3, h:2, color: COL_BUILD_POL  }, // police
    { x:36, y:38, w:3, h:2, color: COL_BUILD_SHOP }
  ];
  const POND = { x:66, y:43, rx:1.6, ry:1.1 };

  // --- helpers ---
  const scale = ()=> api.DRAW / api.TILE;
  const w2sX  = wx => (wx - api.camera.x) * scale();
  const w2sY  = wy => (wy - api.camera.y) * scale();

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

  // --- solids (AABB against building tiles) ---
  function aabbHitsBuilding(px,py){
    const t=api.TILE;
    const tiles = [
      {gx: (px         /t)|0, gy: (py         /t)|0},
      {gx: ((px+t-1)   /t)|0, gy: (py         /t)|0},
      {gx: (px         /t)|0, gy: ((py+t-1)   /t)|0},
      {gx: ((px+t-1)   /t)|0, gy: ((py+t-1)   /t)|0},
    ];
    for(const {gx,gy} of tiles){
      if(gx<TIER2.x0||gx>TIER2.x1||gy<TIER2.y0||gy>TIER2.y1) continue;
      for(const b of BUILDINGS){
        if(gx>=b.x && gx<b.x+b.w && gy>=b.y && gy<b.y+b.h) return true;
      }
    }
    return false;
  }
  function enforceTier2Solids(){
    if(aabbHitsBuilding(api.player.x, api.player.y)){
      api.player.x = _prevSafe.x;
      api.player.y = _prevSafe.y;
    }
  }

  // --- painters (match core style) ---
  function drawRoadH(ctx, y, x0, x1, dashed){
    const t=api.TILE, S=api.DRAW;
    for(let gx=x0; gx<=x1; gx++){
      const sx=w2sX(gx*t), sy=w2sY(y*t);
      ctx.fillStyle = COL_ROAD;
      ctx.fillRect(sx,sy,S,S);
      if(dashed){
        ctx.fillStyle = COL_DASH;
        for(let i=0;i<4;i++){
          ctx.fillRect(sx + i*(S/4) + S*0.05, sy + S*0.48, S*0.10, S*0.04);
        }
      }
    }
  }
  function drawRoadV(ctx, x, y0, y1){
    const t=api.TILE, S=api.DRAW;
    for(let gy=y0; gy<=y1; gy++){
      const sx=w2sX(x*t), sy=w2sY(gy*t);
      ctx.fillStyle = COL_ROAD;
      ctx.fillRect(sx,sy,S,S);
    }
  }
  function drawSidewalkH(ctx, y, x0, x1){
    const t=api.TILE, S=api.DRAW;
    for(let gx=x0; gx<=x1; gx++){
      const sx=w2sX(gx*t), sy=w2sY(y*t);
      ctx.fillStyle = COL_SIDEWALK;
      ctx.fillRect(sx,sy,S,S);
      ctx.strokeStyle = 'rgba(0,0,0,.25)';
      ctx.strokeRect(sx,sy,S,S);
    }
  }
  function drawSidewalkV(ctx, x, y0, y1){
    const t=api.TILE, S=api.DRAW;
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
        ctx.fillStyle = 'rgba(0,0,0,.15)';
        ctx.fillRect(sx,sy,S,Math.floor(S*0.18));
      }
    }
  }

  function drawTier2OverlayBehind(){
    const ctx = document.getElementById('game').getContext('2d');
    ctx.save();
    // draw BEHIND the already-rendered frame so the player/NPCs stay on top
    ctx.globalCompositeOperation = 'destination-over';

    // sidewalks
    HSW.forEach(s => drawSidewalkH(ctx, s.y, s.x0, s.x1));
    VSW.forEach(s => drawSidewalkV(ctx, s.x, s.y0, s.y1));
    // roads
    HROADS.forEach(r => drawRoadH(ctx, r.y, r.x0, r.x1, !!r.dashed));
    VROADS.forEach(r => drawRoadV(ctx, r.x, r.y0, r.y1));
    // buildings
    BUILDINGS.forEach(b => drawBuilding(ctx,b));
    // pond
    const S=api.DRAW, t=api.TILE;
    ctx.fillStyle = '#7db7d9';
    ctx.beginPath();
    ctx.ellipse(w2sX(POND.x*t), w2sY(POND.y*t), S*POND.rx, S*POND.ry, 0, 0, Math.PI*2);
    ctx.fill();

    ctx.restore();
  }

  // --- minimap painter (after core draws it) ---
  function drawMiniTier2(){
    const mini = document.getElementById('minimap');
    if(!mini) return;
    const mctx = mini.getContext('2d');
    const W = 90, H = 60; // core grid
    const sx = mini.width / W, sy = mini.height / H;

    mctx.save();
    // light roads
    mctx.fillStyle = '#788292';
    // H roads
    HROADS.forEach(r=>{
      mctx.fillRect(r.x0*sx, r.y*sy, (r.x1-r.x0+1)*sx, 1.4*sy);
    });
    // V roads
    VROADS.forEach(r=>{
      mctx.fillRect(r.x*sx, r.y0*sy, 1.4*sx, (r.y1-r.y0+1)*sy);
    });

    // buildings (small blocks)
    BUILDINGS.forEach(b=>{
      mctx.fillStyle = '#405a85';
      if(b.color===COL_BUILD_POL) mctx.fillStyle='#0a2455';
      if(b.color===COL_BUILD_GEN) mctx.fillStyle='#7a3a3a';
      mctx.fillRect(b.x*sx, b.y*sy, b.w*sx, b.h*sy);
    });

    // pond hint
    mctx.fillStyle = '#5aa9de';
    mctx.beginPath();
    mctx.ellipse(POND.x*sx, POND.y*sy, 1.6*sx, 1.1*sy, 0, 0, Math.PI*2);
    mctx.fill();

    mctx.restore();
  }

  // --- hooks ---
  IZZA.on('ready', (a)=>{
    api = a;
    tier = localStorage.getItem(MAP_TIER_KEY) || '1';
    console.log('[MAP EXPANDER] ready; tier =', tier);
  });

  IZZA.on('update-pre', ()=>{
    if(!api) return;
    _prevSafe.x = api.player.x;
    _prevSafe.y = api.player.y;
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
      drawTier2OverlayBehind(); // behind player, so no “walking under” visuals
      drawMiniTier2();          // update minimap to reflect Tier 2
    }
  });
})();
