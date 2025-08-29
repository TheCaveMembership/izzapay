// /static/game/js/plugins/v1_map_expander.js
(function () {
  const BUILD = 'v2.1-map-expander+bg-canvas+minimap+bigmap+collisions';
  console.log('[IZZA PLAY]', BUILD);

  // ===== Flags / storage =====
  const MAP_TIER_KEY = 'izzaMapTier'; // '1' | '2'

  // Tier-2 bounds (expanded eastward)
  const TIER2 = { x0: 10, y0: 12, x1: 80, y1: 50 };

  // Palette that matches the core renderer
  const COL = {
    grass:    '#09371c',
    road:     '#2a2a2a',
    dash:     '#ffd23f',
    sidewalk: '#6a727b',
    red:      '#7a3a3a',  // large block (HQ-style)
    shop:     '#203a60',  // small shops
    civic:    '#405a85',  // civic/blue
    police:   '#0a2455',
    library:  '#8a5a2b',
    water:    '#2b6a7a'
  };

  let api = null;
  const state = { tier: localStorage.getItem(MAP_TIER_KEY) || '1' };

  // ===== Single Tier-2 layout (inner-city vibe, denser grid) =====
  // Expressed entirely in grid coords (tiles).
  const LAYOUT = {
    // roads
    H_ROADS: [
      { y: 20, x0: 14, x1: 76 }, // main north spine
      { y: 28, x0: 18, x1: 72 }, // mid top
      { y: 36, x0: 14, x1: 76 }, // main south spine
      { y: 44, x0: 16, x1: 72 }  // southern
    ],
    V_ROADS: [
      { x: 22, y0: 18, y1: 44 }, // west cross
      { x: 28, y0: 14, y1: 44 }, // long cross
      { x: 40, y0: 18, y1: 44 }, // city center
      { x: 52, y0: 14, y1: 44 }, // to police block
      { x: 70, y0: 18, y1: 44 }  // far east cross
    ],

    // buildings (solid)
    BUILDINGS: [
      // central red block
      { x: 41, y: 22, w: 4, h: 3, color: COL.red },

      // blue civic pair
      { x: 55, y: 24, w: 4, h: 3, color: COL.civic },
      { x: 36, y: 38, w: 3, h: 2, color: COL.civic },

      // shop row along mid strip
      { x: 20, y: 29, w: 2, h: 2, color: COL.shop },
      { x: 24, y: 29, w: 2, h: 2, color: COL.shop },
      { x: 28, y: 29, w: 2, h: 2, color: COL.shop },

      // library in SE
      { x: 64, y: 45, w: 4, h: 3, color: COL.library },

      // police near NE
      { x: 48, y: 18, w: 3, h: 2, color: COL.police }
    ],

    // visual lake
    LAKES: [ { x: 66, y: 43, w: 5, h: 3 } ]
  };

  // ===== Helpers =====
  const isTier2 = () => state.tier === '2';
  const scl = () => api.DRAW / api.TILE;
  const w2sX = (wx) => (wx - api.camera.x) * scl();
  const w2sY = (wy) => (wy - api.camera.y) * scl();

  function fillTile(ctx, gx, gy, color) {
    const sx = w2sX(gx * api.TILE), sy = w2sY(gy * api.TILE);
    const S = api.DRAW;
    ctx.fillStyle = color;
    ctx.fillRect(sx, sy, S, S);
  }

  // Roads drawn tile-by-tile to match the base look (with dashes on horizontals)
  function drawHRoad(ctx, y, x0, x1) {
    for (let x = x0; x <= x1; x++) {
      fillTile(ctx, x, y, COL.road);
      const sx = w2sX(x * api.TILE), sy = w2sY(y * api.TILE), S = api.DRAW;
      ctx.fillStyle = COL.dash;
      for (let i = 0; i < 4; i++) {
        ctx.fillRect(sx + i * (S / 4) + S * 0.05, sy + S * 0.48, S * 0.10, S * 0.04);
      }
    }
  }
  function drawVRoad(ctx, x, y0, y1) {
    for (let y = y0; y <= y1; y++) fillTile(ctx, x, y, COL.road);
  }
  function drawSidewalkRow(ctx, y, x0, x1) {
    for (let x = x0; x <= x1; x++) fillTile(ctx, x, y, COL.sidewalk);
  }
  function drawSidewalkCol(ctx, x, y0, y1) {
    for (let y = y0; y <= y1; y++) fillTile(ctx, x, y, COL.sidewalk);
  }
  function drawBuilding(ctx, b) {
    for (let gy = b.y; gy < b.y + b.h; gy++) {
      for (let gx = b.x; gx < b.x + b.w; gx++) fillTile(ctx, gx, gy, b.color);
    }
    // subtle top shade (same HQ/Shop vibe)
    const sx = w2sX(b.x * api.TILE), sy = w2sY(b.y * api.TILE);
    ctx.fillStyle = 'rgba(0,0,0,.15)';
    ctx.fillRect(sx, sy, b.w * api.DRAW, Math.floor(b.h * api.DRAW * 0.18));
  }
  function drawLake(ctx, r) {
    ctx.fillStyle = COL.water;
    ctx.fillRect(w2sX(r.x * api.TILE), w2sY(r.y * api.TILE), r.w * api.DRAW, r.h * api.DRAW);
  }

  // ===== Background canvas (sits behind #game) =====
  let bg=null, bgctx=null;
  function ensureBGCanvas(){
    if(bg && bgctx) return bgctx;
    const game = document.getElementById('game');
    if(!game) return null;
    bg = document.createElement('canvas');
    bg.id = 'mapBg';
    Object.assign(bg.style, {
      position: 'absolute',
      inset: '0',
      zIndex: (parseInt(game.style.zIndex||'0',10) - 1) || -1,
      pointerEvents: 'none'
    });
    game.parentElement.insertBefore(bg, game); // directly behind
    bg.width = game.width; bg.height = game.height;
    bgctx = bg.getContext('2d');
    return bgctx;
  }
  function syncBGSize(){
    const game = document.getElementById('game');
    if(!game || !bg) return;
    if(bg.width!==game.width || bg.height!==game.height){
      bg.width = game.width; bg.height = game.height;
    }
  }

  // ===== Camera widening (no core changes) =====
  function widenCameraClampIfNeeded() {
    if (!isTier2() || widenCameraClampIfNeeded._done) return;
    widenCameraClampIfNeeded._done = true;
    IZZA.on('update-post', () => {
      const visW = document.getElementById('game').width  / scl();
      const visH = document.getElementById('game').height / scl();
      const maxX = (TIER2.x1 + 1) * api.TILE - visW;
      const maxY = (TIER2.y1 + 1) * api.TILE - visH;
      api.camera.x = Math.max(TIER2.x0 * api.TILE, Math.min(api.camera.x, maxX));
      api.camera.y = Math.max(TIER2.y0 * api.TILE, Math.min(api.camera.y, maxY));
    });
  }

  // ===== Solid collisions for new buildings =====
  function pushOutOfSolids() {
    if (!isTier2()) return;
    const t = api.TILE;
    const px = api.player.x, py = api.player.y;
    const gx = (px / t) | 0, gy = (py / t) | 0;

    for (const b of LAYOUT.BUILDINGS) {
      if (gx >= b.x && gx < b.x + b.w && gy >= b.y && gy < b.y + b.h) {
        const dxL = Math.abs(px - b.x * t);
        const dxR = Math.abs((b.x + b.w) * t - px);
        const dyT = Math.abs(py - b.y * t);
        const dyB = Math.abs((b.y + b.h) * t - py);
        const m = Math.min(dxL, dxR, dyT, dyB);
        if (m === dxL) api.player.x = (b.x - 0.01) * t;
        else if (m === dxR) api.player.x = (b.x + b.w + 0.01) * t;
        else if (m === dyT) api.player.y = (b.y - 0.01) * t;
        else api.player.y = (b.y + b.h + 0.01) * t;
        break;
      }
    }
  }

  // ===== Paint: main (to bg), minimap, bigmap =====
  function drawMainOverlay() {
    if (!isTier2()) return;
    const ctx = ensureBGCanvas();
    if(!ctx) return;

    syncBGSize();
    ctx.clearRect(0,0,bg.width,bg.height);

    // base grass for new district
    for (let gy = TIER2.y0; gy <= TIER2.y1; gy++) {
      for (let gx = TIER2.x0; gx <= TIER2.x1; gx++) fillTile(ctx, gx, gy, COL.grass);
    }

    // sidewalks around roads (±1 tile)
    LAYOUT.H_ROADS.forEach(r => {
      drawSidewalkRow(ctx, r.y - 1, r.x0, r.x1);
      drawSidewalkRow(ctx, r.y + 1, r.x0, r.x1);
    });
    LAYOUT.V_ROADS.forEach(r => {
      drawSidewalkCol(ctx, r.x - 1, r.y0, r.y1);
      drawSidewalkCol(ctx, r.x + 1, r.y0, r.y1);
    });

    // roads
    LAYOUT.H_ROADS.forEach(r => drawHRoad(ctx, r.y, r.x0, r.x1));
    LAYOUT.V_ROADS.forEach(r => drawVRoad(ctx, r.x, r.y0, r.y1));

    // buildings and lake(s)
    LAYOUT.BUILDINGS.forEach(b => drawBuilding(ctx, b));
    LAYOUT.LAKES.forEach(l => drawLake(ctx, l));
  }

  function drawMiniOverlay() {
    if (!isTier2()) return;
    const mini = document.getElementById('minimap');
    const ctx = mini && mini.getContext ? mini.getContext('2d') : null;
    if (!mini || !ctx) return;

    const sx = mini.width / 90, sy = mini.height / 60;

    // roads
    ctx.save();
    ctx.fillStyle = '#8a90a0';
    LAYOUT.H_ROADS.forEach(r => ctx.fillRect(r.x0 * sx, r.y * sy, (r.x1 - r.x0 + 1) * sx, 1 * sy));
    LAYOUT.V_ROADS.forEach(r => ctx.fillRect(r.x * sx, r.y0 * sy, 1 * sx, (r.y1 - r.y0 + 1) * sy));
    ctx.restore();

    // buildings
    LAYOUT.BUILDINGS.forEach(b => {
      ctx.fillStyle = b.color;
      ctx.fillRect(b.x * sx, b.y * sy, b.w * sx, b.h * sy);
    });

    // lake
    LAYOUT.LAKES.forEach(l => {
      ctx.fillStyle = '#7db7d9';
      ctx.fillRect(l.x * sx, l.y * sy, l.w * sx, l.h * sy);
    });
  }

  function drawBigOverlay() {
    if (!isTier2()) return;
    const big = document.getElementById('bigmap');
    const ctx = big && big.getContext ? big.getContext('2d') : null;
    if (!big || !ctx) return;

    const sx = big.width / 90, sy = big.height / 60;

    ctx.save();
    ctx.fillStyle = '#8a90a0';
    LAYOUT.H_ROADS.forEach(r => ctx.fillRect(r.x0 * sx, r.y * sy, (r.x1 - r.x0 + 1) * sx, 1.2 * sy));
    LAYOUT.V_ROADS.forEach(r => ctx.fillRect(r.x * sx, r.y0 * sy, 1.2 * sx, (r.y1 - r.y0 + 1) * sy));

    LAYOUT.BUILDINGS.forEach(b => {
      ctx.fillStyle = b.color;
      ctx.fillRect(b.x * sx, b.y * sy, b.w * sx, b.h * sy);
    });

    LAYOUT.LAKES.forEach(l => {
      ctx.fillStyle = '#7db7d9';
      ctx.fillRect(l.x * sx, l.y * sy, l.w * sx, l.h * sy);
    });
    ctx.restore();
  }

  // ===== Hooks =====
  IZZA.on('ready', (a) => {
    api = a;

    // adopt tier and widen camera if already unlocked
    state.tier = localStorage.getItem(MAP_TIER_KEY) || '1';
    if (isTier2()) widenCameraClampIfNeeded();

    // draw big map overlay whenever the modal opens
    const mapModal = document.getElementById('mapModal');
    if (mapModal) {
      const obs = new MutationObserver(() => {
        if (mapModal.style.display === 'flex') drawBigOverlay();
      });
      obs.observe(mapModal, { attributes: true, attributeFilter: ['style'] });
    }
  });

  IZZA.on('update-post', () => {
    const cur = localStorage.getItem(MAP_TIER_KEY) || '1';
    if (cur !== state.tier) {
      state.tier = cur;
      if (isTier2()) widenCameraClampIfNeeded();
    }
    if (isTier2()) pushOutOfSolids();
  });

  // paint every frame: background (main) + minimap
  IZZA.on('render-post', () => {
    if (!isTier2()) return;
    drawMainOverlay();
    drawMiniOverlay();
  });
})();
