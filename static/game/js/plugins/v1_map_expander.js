// /static/game/js/plugins/v1_map_expander.js
(function () {
  const BUILD = 'v1.6-map-expander+tier2-grid-roads+buildings+behind+mini+big+collide';
  console.log('[IZZA PLAY]', BUILD);

  // ─────────────────────────────────────────────────────────────────────────────
  // HOW TO EDIT (fastest way to add content)
  // 1) Add / change roads by pushing segments into H_ROADS (horizontal) or
  //    V_ROADS (vertical). Each road gets automatic sidewalks exactly like core.
  // 2) Add / change buildings by editing BUILDINGS. These are SOLID (collision).
  // 3) Tier 2 becomes active when localStorage['izzaMapTier'] === '2' (set by M3).
  // ─────────────────────────────────────────────────────────────────────────────

  // === Flags & bounds ===
  const MAP_TIER_KEY = 'izzaMapTier';      // '1' | '2'
  const TIER2 = { x0: 10, y0: 12, x1: 80, y1: 50 }; // big box you wanted

  let api = null;
  const state = { tier: localStorage.getItem(MAP_TIER_KEY) || '1' };
  const isTier2 = () => state.tier === '2';

  // === LAYOUT (edit these) =====================================================
  // Roads are whole-tile straight strips expressed in GRID coords.
  // Each horizontal road uses the same art as your main road:
  //   - sidewalks: y-1 and y+1   - asphalt: y   - dashed yellow center line
  const H_ROADS = [
    // y, x0..x1
    { y: 20, x0: 14, x1: 76 },
    { y: 36, x0: 14, x1: 76 },
    { y: 44, x0: 16, x1: 72 }, // bottom “ring”
  ];

  // Vertical roads: same art as your core vertical strip (asphalt only),
  // with matching sidewalks to the left/right.
  const V_ROADS = [
    // x, y0..y1
    { x: 28, y0: 14, y1: 44 },
    { x: 52, y0: 14, y1: 44 },
    { x: 76, y0: 18, y1: 45 }, // right edge column to “frame” district
  ];

  // Optional short stubs / connectors (also rendered as full roads):
  const H_STUBS = [
    { y: 20, x0: 18, x1: 22 },
    { y: 20, x0: 60, x1: 64 },
  ];
  const V_STUBS = [
    { x: 22, y0: 20, y1: 24 },
  ];

  // Buildings: SOLID rectangles using the same blocky shading the core uses.
  // Add more by copying a line and changing x,y,w,h,color.
  const BUILDINGS = [
    { x: 20, y: 28, w: 2, h: 2, color: '#203a60' }, // small shops
    { x: 24, y: 28, w: 2, h: 2, color: '#203a60' },
    { x: 28, y: 28, w: 2, h: 2, color: '#203a60' },

    { x: 41, y: 22, w: 4, h: 3, color: '#7a3a3a' }, // big red block (civic)
    { x: 55, y: 24, w: 4, h: 3, color: '#405a85' }, // blue civic
    { x: 36, y: 38, w: 3, h: 2, color: '#405a85' }, // blue office

    { x: 48, y: 18, w: 3, h: 2, color: '#0a2455' }, // police station
    { x: 64, y: 45, w: 4, h: 3, color: '#8a5a2b' }, // library / venue
  ];

  // === Helpers ================================================================
  const SCL = () => api.DRAW / api.TILE;
  const w2sX = (wx) => (wx - api.camera.x) * SCL();
  const w2sY = (wy) => (wy - api.camera.y) * SCL();

  // Colors & per-tile painter matching your core style
  const COL = {
    grass: '#09371c',
    road:  '#2a2a2a',
    side:  '#6a727b',
    dash:  '#ffd23f'
  };

  function fillTile(ctx, gx, gy, color) {
    const S = api.DRAW;
    ctx.fillStyle = color;
    ctx.fillRect(w2sX(gx * api.TILE), w2sY(gy * api.TILE), S, S);
  }

  function drawHRoad(ctx, y, x0, x1) {
    // sidewalks
    for (let x = x0; x <= x1; x++) {
      fillTile(ctx, x, y - 1, COL.side);
      fillTile(ctx, x, y + 1, COL.side);
    }
    // asphalt
    for (let x = x0; x <= x1; x++) fillTile(ctx, x, y, COL.road);

    // dashed center line (same rhythm as core)
    const S = api.DRAW, t = api.TILE;
    ctx.fillStyle = COL.dash;
    for (let x = x0; x <= x1; x++) {
      const sx = w2sX(x * t), sy = w2sY(y * t);
      for (let i = 0; i < 4; i++) {
        ctx.fillRect(sx + i * (S / 4) + S * 0.05, sy + S * 0.48, S * 0.10, S * 0.04);
      }
    }
  }

  function drawVRoad(ctx, x, y0, y1) {
    // sidewalks
    for (let y = y0; y <= y1; y++) {
      fillTile(ctx, x - 1, y, COL.side);
      fillTile(ctx, x + 1, y, COL.side);
    }
    // asphalt
    for (let y = y0; y <= y1; y++) fillTile(ctx, x, y, COL.road);
  }

  function drawBuilding(ctx, b) {
    const S = api.DRAW, t = api.TILE;
    const sx = w2sX(b.x * t), sy = w2sY(b.y * t);
    const W = b.w * S, H = b.h * S;
    ctx.fillStyle = b.color;
    ctx.fillRect(sx, sy, W, H);
    // subtle top shading to match HQ/Shop tiles
    ctx.fillStyle = 'rgba(0,0,0,.15)';
    ctx.fillRect(sx, sy, W, Math.floor(H * 0.18));
  }

  // === Camera widening (don’t touch your core) ================================
  function widenCameraClampIfNeeded() {
    if (!isTier2() || widenCameraClampIfNeeded._done) return;
    widenCameraClampIfNeeded._done = true;

    IZZA.on('update-post', () => {
      const visW = document.getElementById('game').width / SCL();
      const visH = document.getElementById('game').height / SCL();
      const maxX = (TIER2.x1 + 1) * api.TILE - visW;
      const maxY = (TIER2.y1 + 1) * api.TILE - visH;
      api.camera.x = Math.max(TIER2.x0 * api.TILE, Math.min(api.camera.x, maxX));
      api.camera.y = Math.max(TIER2.y0 * api.TILE, Math.min(api.camera.y, maxY));
    });
  }

  // === Collision for NEW buildings (push the player out) ======================
  function pushOutOfSolids() {
    if (!isTier2()) return;
    const t = api.TILE;
    const px = api.player.x, py = api.player.y;
    const gx = (px / t) | 0, gy = (py / t) | 0;

    for (const b of BUILDINGS) {
      if (gx >= b.x && gx < b.x + b.w && gy >= b.y && gy < b.y + b.h) {
        // push to nearest edge
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

  // === Painters ===============================================================
  // Main canvas overlay — draws BEHIND the core so sprites/tiles stay on top.
  function drawMainOverlay() {
    if (!isTier2()) return;
    const ctx = document.getElementById('game').getContext('2d');
    ctx.save();
    ctx.globalCompositeOperation = 'destination-over';

    // make sure the new district isn't black outside your base tiles
    for (let gy = TIER2.y0; gy <= TIER2.y1; gy++) {
      for (let gx = TIER2.x0; gx <= TIER2.x1; gx++) fillTile(ctx, gx, gy, COL.grass);
    }

    // roads (full-tile style to match core)
    H_ROADS.forEach(r => drawHRoad(ctx, r.y, r.x0, r.x1));
    V_ROADS.forEach(r => drawVRoad(ctx, r.x, r.y0, r.y1));
    H_STUBS.forEach(r => drawHRoad(ctx, r.y, r.x0, r.x1));
    V_STUBS.forEach(r => drawVRoad(ctx, r.x, r.y0, r.y1));

    // buildings (solid)
    BUILDINGS.forEach(b => drawBuilding(ctx, b));

    ctx.restore();
  }

  // Minimap overlay (simple lines/blocks so it matches what you see)
  function drawMiniOverlay() {
    if (!isTier2()) return;
    const mini = document.getElementById('minimap');
    if (!mini) return;
    const mctx = mini.getContext('2d');
    const sx = mini.width / 90, sy = mini.height / 60;

    mctx.save();
    mctx.lineCap = 'butt';
    mctx.strokeStyle = '#8a90a0';
    mctx.lineWidth = Math.max(1, sx * 0.9);

    const line = (x1, y1, x2, y2) => {
      mctx.beginPath();
      mctx.moveTo(x1 * sx, y1 * sy);
      mctx.lineTo(x2 * sx, y2 * sy);
      mctx.stroke();
    };

    H_ROADS.forEach(r => line(r.x0, r.y, r.x1, r.y));
    V_ROADS.forEach(r => line(r.x, r.y0, r.y1));
    H_STUBS.forEach(r => line(r.x0, r.y, r.x1, r.y));
    V_STUBS.forEach(r => line(r.x, r.y0, r.y1));

    BUILDINGS.forEach(b => {
      mctx.fillStyle = b.color;
      mctx.fillRect(b.x * sx, b.y * sy, b.w * sx, b.h * sy);
    });
    mctx.restore();
  }

  // Big map overlay (draw when modal is open)
  function drawBigOverlay() {
    if (!isTier2()) return;
    const big = document.getElementById('bigmap');
    if (!big) return;
    const bctx = big.getContext('2d');
    const sx = big.width / 90, sy = big.height / 60;

    bctx.save();
    bctx.lineCap = 'butt';
    bctx.strokeStyle = '#8a90a0';
    bctx.lineWidth = Math.max(2, sx * 1.2);

    const line = (x1, y1, x2, y2) => {
      bctx.beginPath();
      bctx.moveTo(x1 * sx, y1 * sy);
      bctx.lineTo(x2 * sx, y2 * sy);
      bctx.stroke();
    };

    H_ROADS.forEach(r => line(r.x0, r.y, r.x1, r.y));
    V_ROADS.forEach(r => line(r.x, r.y0, r.y1));
    H_STUBS.forEach(r => line(r.x0, r.y, r.x1, r.y));
    V_STUBS.forEach(r => line(r.x, r.y0, r.y1));

    BUILDINGS.forEach(b => {
      bctx.fillStyle = b.color;
      bctx.fillRect(b.x * sx, b.y * sy, b.w * sx, b.h * sy);
    });

    bctx.restore();
  }

  // === Hooks ==================================================================
  IZZA.on('ready', (a) => {
    api = a;

    // pick up current tier (M3 sets this)
    state.tier = localStorage.getItem(MAP_TIER_KEY) || '1';
    if (isTier2()) widenCameraClampIfNeeded();

    // watch for tier flips during the session
    IZZA.on('update-post', () => {
      const cur = localStorage.getItem(MAP_TIER_KEY) || '1';
      if (cur !== state.tier) {
        state.tier = cur;
        if (isTier2()) widenCameraClampIfNeeded();
      }
      if (isTier2()) pushOutOfSolids();
    });

    // repaint big map overlay any time the modal is visible
    const mapModal = document.getElementById('mapModal');
    if (mapModal) {
      const obs = new MutationObserver(() => {
        if (mapModal.style.display === 'flex') drawBigOverlay();
      });
      obs.observe(mapModal, { attributes: true, attributeFilter: ['style'] });
    }
  });

  // Draw every frame (so main view & minimap always match)
  IZZA.on('render-post', () => {
    if (!isTier2()) return;
    drawMainOverlay();  // destination-over keeps sprites on top
    drawMiniOverlay();
  });
})();
