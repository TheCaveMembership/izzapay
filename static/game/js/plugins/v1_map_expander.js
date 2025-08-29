// /static/game/js/plugins/v1_map_expander.js
(function () {
  const BUILD = 'v2.3-map-expander+downtown+source-over+collisions';
  console.log('[IZZA PLAY]', BUILD);

  const MAP_TIER_KEY = 'izzaMapTier'; // '1' | '2'
  const TIER2 = { x0: 10, y0: 12, x1: 80, y1: 50 };

  // palette that matches core
  const COL = {
    grass:    '#09371c',
    road:     '#2a2a2a',
    dash:     '#ffd23f',
    sidewalk: '#6a727b',
    red:      '#7a3a3a',
    civic:    '#405a85',
    shop:     '#203a60',
    police:   '#0a2455',
    library:  '#8a5a2b'
  };

  let api = null;
  const state = { tier: localStorage.getItem(MAP_TIER_KEY) || '1' };
  const isTier2 = () => state.tier === '2';

  // ===== helpers
  const scl = () => api.DRAW / api.TILE;
  const w2sX = (wx) => (wx - api.camera.x) * scl();
  const w2sY = (wy) => (wy - api.camera.y) * scl();
  function fillTile(ctx, gx, gy, color) {
    const sx = w2sX(gx * api.TILE), sy = w2sY(gy * api.TILE);
    const S = api.DRAW;
    ctx.fillStyle = color;
    ctx.fillRect(sx, sy, S, S);
  }

  // ===== Downtown layout (center/south area) =====
  // We stitch to the core’s main cross. If core exposed api.hRoadY/api.vRoadX we use that;
  // otherwise we fall back to a centered cross inside TIER2.
  function makeDowntownLayout() {
    const vX = (api.vRoadX != null) ? api.vRoadX : 46; // fallback column
    const hY = (api.hRoadY != null) ? api.hRoadY : 28; // fallback row

    // grid rows/cols for dense downtown south of the main east-west road
    const southTop = hY + 4;            // first downtown row under main road
    const southRows = [southTop, southTop + 4, southTop + 8, southTop + 12];
    const spineCols = [vX - 10, vX, vX + 10, vX + 20]; // a few north-south spines

    const H_ROADS = [
      // stitch: extend your main E–W all the way across tier-2 (ensures a clean join)
      { y: hY, x0: TIER2.x0 + 2, x1: TIER2.x1 - 2 },
      // downtown rows
      ...southRows.map(y => ({ y, x0: vX - 14, x1: vX + 26 }))
    ];

    const V_ROADS = [
      // stitch: extend your main N–S all the way across tier-2
      { x: vX, y0: TIER2.y0 + 2, y1: TIER2.y1 - 2 },
      // downtown spines
      ...spineCols.map(x => ({ x, y0: southTop - 2, y1: southTop + 14 }))
    ];

    // buildings live in the rectangles between roads; simple blocks that don’t cross roads
    const BUILDINGS = [
      // north features along the main cross (visible landmark blocks)
      { x: vX - 6,  y: hY - 6,  w: 6, h: 4, color: COL.red    },
      { x: vX + 10, y: hY - 6,  w: 6, h: 4, color: COL.civic  },

      // downtown blocks (small/medium)
      { x: vX - 13, y: southTop + 1,  w: 4, h: 3, color: COL.shop   },
      { x: vX - 7,  y: southTop + 1,  w: 5, h: 3, color: COL.civic  },
      { x: vX + 1,  y: southTop + 1,  w: 4, h: 3, color: COL.shop   },
      { x: vX + 7,  y: southTop + 1,  w: 4, h: 3, color: COL.shop   },
      { x: vX + 13, y: southTop + 1,  w: 6, h: 3, color: COL.civic  },

      { x: vX - 11, y: southTop + 5,  w: 5, h: 3, color: COL.civic  },
      { x: vX - 2,  y: southTop + 5,  w: 4, h: 3, color: COL.shop   },
      { x: vX + 6,  y: southTop + 5,  w: 5, h: 3, color: COL.shop   },
      { x: vX + 14, y: southTop + 5,  w: 6, h: 3, color: COL.civic  },

      { x: vX - 13, y: southTop + 9,  w: 4, h: 3, color: COL.shop   },
      { x: vX - 6,  y: southTop + 9,  w: 4, h: 3, color: COL.shop   },
      { x: vX + 2,  y: southTop + 9,  w: 6, h: 3, color: COL.civic  },
      { x: vX + 11, y: southTop + 9,  w: 4, h: 3, color: COL.shop   },
      { x: vX + 17, y: southTop + 9,  w: 5, h: 3, color: COL.library},

      // police station tucked near a corner
      { x: vX + 22, y: southTop + 12, w: 3, h: 2, color: COL.police }
    ];

    return { H_ROADS, V_ROADS, BUILDINGS, hY, vX };
  }

  let LAYOUT = null;

  // ===== collisions against the new buildings
  function pushOutOfSolids() {
    if (!isTier2() || !LAYOUT) return;
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

  // ===== camera clamp inside tier-2
  function widenCameraClampIfNeeded() {
    if (!isTier2() || widenCameraClampIfNeeded._done) return;
    widenCameraClampIfNeeded._done = true;
    IZZA.on('update-post', () => {
      const visW = document.getElementById('game').width / scl();
      const visH = document.getElementById('game').height / scl();
      const maxX = (TIER2.x1 + 1) * api.TILE - visW;
      const maxY = (TIER2.y1 + 1) * api.TILE - visH;
      api.camera.x = Math.max(TIER2.x0 * api.TILE, Math.min(api.camera.x, maxX));
      api.camera.y = Math.max(TIER2.y0 * api.TILE, Math.min(api.camera.y, maxY));
    });
  }

  // ===== painters (MAIN CANVAS) — IMPORTANT: draw with source-over
  function drawHRoad(ctx, y, x0, x1) {
    for (let x = x0; x <= x1; x++) {
      fillTile(ctx, x, y, COL.road);
      // lane dashes (match core)
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
    for (let gy = b.y; gy < b.y + b.h; gy++)
      for (let gx = b.x; gx < b.x + b.w; gx++)
        fillTile(ctx, gx, gy, b.color);
    // top shade
    const sx = w2sX(b.x * api.TILE), sy = w2sY(b.y * api.TILE);
    ctx.fillStyle = 'rgba(0,0,0,.15)';
    ctx.fillRect(sx, sy, b.w * api.DRAW, Math.floor(b.h * api.DRAW * 0.18));
  }

  function drawMainOverlay() {
    if (!isTier2() || !LAYOUT) return;
    const ctx = document.getElementById('game').getContext('2d');
    ctx.save();
    // ✅ draw normally (over grass), still under sprites because we draw before cars/peds/player
    ctx.globalCompositeOperation = 'source-over';

    // sidewalks around every road (±1 tile)
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

    // buildings (solid)
    LAYOUT.BUILDINGS.forEach(b => drawBuilding(ctx, b));

    ctx.restore();
  }

  // ===== minimap / bigmap (unchanged style)
  function drawMiniOverlay() {
    if (!isTier2() || !LAYOUT) return;
    const mini = document.getElementById('minimap');
    const mctx = mini && mini.getContext ? mini.getContext('2d') : null;
    if (!mini || !mctx) return;

    const sx = mini.width / 90, sy = mini.height / 60;

    mctx.fillStyle = '#8a90a0';
    LAYOUT.H_ROADS.forEach(r => mctx.fillRect(r.x0 * sx, r.y * sy, (r.x1 - r.x0 + 1) * sx, 1 * sy));
    LAYOUT.V_ROADS.forEach(r => mctx.fillRect(r.x * sx, r.y0 * sy, 1 * sx, (r.y1 - r.y0 + 1) * sy));

    LAYOUT.BUILDINGS.forEach(b => {
      mctx.fillStyle = b.color;
      mctx.fillRect(b.x * sx, b.y * sy, b.w * sx, b.h * sy);
    });
  }
  function drawBigOverlay() {
    if (!isTier2() || !LAYOUT) return;
    const big = document.getElementById('bigmap');
    const bctx = big && big.getContext ? big.getContext('2d') : null;
    if (!big || !bctx) return;

    const sx = big.width / 90, sy = big.height / 60;

    bctx.fillStyle = '#8a90a0';
    LAYOUT.H_ROADS.forEach(r => bctx.fillRect(r.x0 * sx, r.y * sy, (r.x1 - r.x0 + 1) * sx, 1.2 * sy));
    LAYOUT.V_ROADS.forEach(r => bctx.fillRect(r.x * sx, r.y0 * sy, 1.2 * sx, (r.y1 - r.y0 + 1) * sy));

    LAYOUT.BUILDINGS.forEach(b => {
      bctx.fillStyle = b.color;
      bctx.fillRect(b.x * sx, b.y * sy, b.w * sx, b.h * sy);
    });
  }

  // ===== hooks
  IZZA.on('ready', (a) => {
    api = a;
    state.tier = localStorage.getItem(MAP_TIER_KEY) || '1';
    if (isTier2()) {
      widenCameraClampIfNeeded();
      LAYOUT = makeDowntownLayout();
    }

    // redraw big map when opened
    const mapModal = document.getElementById('mapModal');
    if (mapModal) {
      const obs = new MutationObserver(() => {
        if (mapModal.style.display === 'flex') drawBigOverlay();
      });
      obs.observe(mapModal, { attributes: true, attributeFilter: ['style'] });
    }
  });

  IZZA.on('update-post', () => {
    const curTier = localStorage.getItem(MAP_TIER_KEY) || '1';
    if (curTier !== state.tier) {
      state.tier = curTier;
      if (isTier2()) {
        widenCameraClampIfNeeded();
        LAYOUT = makeDowntownLayout();
      }
    }
    if (isTier2()) pushOutOfSolids();
  });

  // ⬅️ draw right after core tiles; our paint will cover grass but remain under sprites
  IZZA.on('render-post', () => {
    if (!isTier2()) return;
    drawMainOverlay();
    drawMiniOverlay();
  });
})();
