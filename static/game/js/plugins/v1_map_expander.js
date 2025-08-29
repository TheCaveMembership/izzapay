// /static/game/js/plugins/v1_map_expander.js
(function () {
  const BUILD = 'v1.6-map-expander+tier2-tiles-match+minimap+bigmap+solids';
  console.log('[IZZA PLAY]', BUILD);

  // ===== Flags / bounds =====
  const MAP_TIER_KEY = 'izzaMapTier'; // '1' | '2'
  const TIER2 = { x0: 10, y0: 12, x1: 80, y1: 50 }; // enlarged play box

  let api = null;
  const state = { tier: localStorage.getItem(MAP_TIER_KEY) || '1' };
  const isTier2 = () => state.tier === '2';

  // ===== Palette (match core) =====
  const COL = {
    grass:    '#09371c',
    road:     '#2a2a2a',
    dash:     '#ffd23f',
    sidewalk: '#6a727b',
    hq:       '#4a2d2d',
    shop:     '#203a60',
  };

  // ===== District 2 content (tile-aligned) =====
  // Horizontal/Vertical road segments are inclusive ranges in grid coords.
  // These are straight segments composed of the SAME tile look as core.
  const H_ROADS = [
    { y: 20, x0: 14, x1: 76 },
    { y: 36, x0: 14, x1: 76 },
    { y: 44, x0: 16, x1: 72 },   // lower street
  ];
  const V_ROADS = [
    { x: 28, y0: 14, y1: 44 },
    { x: 52, y0: 14, y1: 44 },
  ];
  // Little stubs/connectors (still horizontal/vertical tiles)
  const H_STUBS = [
    { y: 20, x0: 18, x1: 22 },
    { y: 20, x0: 60, x1: 64 },
  ];
  const V_STUBS = [
    { x: 22, y0: 20, y1: 24 },
  ];

  // Buildings (solid)
  const BUILDINGS = [
    { x: 41, y: 22, w: 4, h: 3, color: '#7a3a3a' }, // red block
    { x: 55, y: 24, w: 4, h: 3, color: '#405a85' }, // blue civic
    { x: 36, y: 38, w: 3, h: 2, color: '#405a85' }, // blue small
    { x: 20, y: 28, w: 2, h: 2, color: '#203a60' }, // shop row
    { x: 24, y: 28, w: 2, h: 2, color: '#203a60' },
    { x: 28, y: 28, w: 2, h: 2, color: '#203a60' },
    { x: 64, y: 45, w: 4, h: 3, color: '#8a5a2b' }, // library
    { x: 48, y: 18, w: 3, h: 2, color: '#0a2455' }, // police
    { x: 58, y: 34, w: 3, h: 2, color: '#4d7bd1' }, // toy shop
  ];

  const LAKE = { x: 66, y: 43, w: 3, h: 2 }; // simple rounded rectangle style

  // ===== Helpers =====
  const SCL = () => api.DRAW / api.TILE;
  const w2sX = (wx) => (wx - api.camera.x) * SCL();
  const w2sY = (wy) => (wy - api.camera.y) * SCL();

  // Camera clamp widened for Tier 2
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

  // Soft collision for new buildings (push the player out)
  function pushOutOfSolids() {
    if (!isTier2()) return;
    const t = api.TILE;
    const px = api.player.x, py = api.player.y;
    const gx = (px / t) | 0, gy = (py / t) | 0;

    for (const b of BUILDINGS) {
      if (gx >= b.x && gx < b.x + b.w && gy >= b.y && gy < b.y + b.h) {
        const dxL = Math.abs(px - b.x * t);
        const dxR = Math.abs((b.x + b.w) * t - px);
        const dyT = Math.abs(py - b.y * t);
        const dyB = Math.abs((b.y + b.h) * t - py);
        const min = Math.min(dxL, dxR, dyT, dyB);
        if (min === dxL) api.player.x = (b.x - 0.01) * t;
        else if (min === dxR) api.player.x = (b.x + b.w + 0.01) * t;
        else if (min === dyT) api.player.y = (b.y - 0.01) * t;
        else api.player.y = (b.y + b.h + 0.01) * t;
        break;
      }
    }
  }

  // ===== Tile painters (MATCH the core look) =====
  function fillTile(ctx, gx, gy, color) {
    const S = api.DRAW, t = api.TILE;
    ctx.fillStyle = color;
    ctx.fillRect(w2sX(gx * t), w2sY(gy * t), S, S);
  }

  function drawHRoad(ctx, y, x0, x1) {
    const S = api.DRAW, t = api.TILE;
    for (let gx = x0; gx <= x1; gx++) {
      // road tile
      fillTile(ctx, gx, y, COL.road);
      // yellow dashes (same pattern as core)
      ctx.fillStyle = COL.dash;
      const sx = w2sX(gx * t), sy = w2sY(y * t);
      for (let i = 0; i < 4; i++) {
        ctx.fillRect(sx + i * (S / 4) + S * 0.05, sy + S * 0.48, S * 0.10, S * 0.04);
      }
      // sidewalks above/below this road row
      fillTile(ctx, gx, y - 1, COL.sidewalk);
      fillTile(ctx, gx, y + 1, COL.sidewalk);
    }
  }

  function drawVRoad(ctx, x, y0, y1) {
    const S = api.DRAW, t = api.TILE;
    for (let gy = y0; gy <= y1; gy++) {
      // road tile
      fillTile(ctx, x, gy, COL.road);
      // sidewalks left/right of this vertical road column
      fillTile(ctx, x - 1, gy, COL.sidewalk);
      fillTile(ctx, x + 1, gy, COL.sidewalk);
    }
  }

  function drawBuilding(ctx, b) {
    const S = api.DRAW, t = api.TILE;
    const sx = w2sX(b.x * t), sy = w2sY(b.y * t);
    const W = b.w * S, H = b.h * S;
    ctx.fillStyle = b.color;
    ctx.fillRect(sx, sy, W, H);
    ctx.fillStyle = 'rgba(0,0,0,.08)'; // same subtle top shade as core
    ctx.fillRect(sx, sy, W, Math.floor(H * 0.18));
  }

  function drawLake(ctx) {
    const S = api.DRAW, t = api.TILE;
    const sx = w2sX(LAKE.x * t), sy = w2sY(LAKE.y * t);
    ctx.fillStyle = '#2b6a7a';
    ctx.fillRect(sx, sy, LAKE.w * S, LAKE.h * S);
  }

  // ===== Main canvas painter (BEHIND sprites) =====
  function drawMainOverlay() {
    if (!isTier2()) return;
    const ctx = document.getElementById('game').getContext('2d');
    ctx.save();
    // draw behind everything the core already painted
    ctx.globalCompositeOperation = 'destination-over';

    // grass base for the whole tier2 box
    for (let gy = TIER2.y0; gy <= TIER2.y1; gy++) {
      for (let gx = TIER2.x0; gx <= TIER2.x1; gx++) fillTile(ctx, gx, gy, COL.grass);
    }

    // roads & sidewalks
    H_ROADS.forEach(r => drawHRoad(ctx, r.y, r.x0, r.x1));
    V_ROADS.forEach(r => drawVRoad(ctx, r.x, r.y0, r.y1));
    H_STUBS.forEach(r => drawHRoad(ctx, r.y, r.x0, r.x1));
    V_STUBS.forEach(r => drawVRoad(ctx, r.x, r.y0, r.y1));

    // buildings & lake
    BUILDINGS.forEach(b => drawBuilding(ctx, b));
    drawLake(ctx);

    ctx.restore();
  }

  // ===== Minimap & Big-map painters (simple versions) =====
  function drawMiniOverlay() {
    if (!isTier2()) return;
    const mini = document.getElementById('minimap');
    const mctx = mini && mini.getContext ? mini.getContext('2d') : null;
    if (!mini || !mctx) return;

    const sx = mini.width / 90, sy = mini.height / 60;

    // roads (as light gray bars)
    mctx.save();
    mctx.fillStyle = '#8a90a0';
    H_ROADS.concat(H_STUBS).forEach(r => {
      mctx.fillRect(r.x0 * sx, (r.y - 0.05) * sy, (r.x1 - r.x0 + 1) * sx, 0.5 * sy);
    });
    V_ROADS.concat(V_STUBS).forEach(r => {
      mctx.fillRect((r.x - 0.05) * sx, r.y0 * sy, 0.5 * sx, (r.y1 - r.y0 + 1) * sy);
    });

    // buildings
    BUILDINGS.forEach(b => {
      mctx.fillStyle = b.color;
      mctx.fillRect(b.x * sx, b.y * sy, b.w * sx, b.h * sy);
    });

    // lake
    mctx.fillStyle = '#7db7d9';
    mctx.fillRect(LAKE.x * sx, LAKE.y * sy, LAKE.w * sx, LAKE.h * sy);
    mctx.restore();
  }

  function drawBigOverlay() {
    if (!isTier2()) return;
    const big = document.getElementById('bigmap');
    const bctx = big && big.getContext ? big.getContext('2d') : null;
    if (!big || !bctx) return;

    const sx = big.width / 90, sy = big.height / 60;

    bctx.save();
    bctx.fillStyle = '#8a90a0';
    H_ROADS.concat(H_STUBS).forEach(r => {
      bctx.fillRect(r.x0 * sx, (r.y - 0.08) * sy, (r.x1 - r.x0 + 1) * sx, 0.6 * sy);
    });
    V_ROADS.concat(V_STUBS).forEach(r => {
      bctx.fillRect((r.x - 0.08) * sx, r.y0 * sy, 0.6 * sx, (r.y1 - r.y0 + 1) * sy);
    });

    BUILDINGS.forEach(b => {
      bctx.fillStyle = b.color;
      bctx.fillRect(b.x * sx, b.y * sy, b.w * sx, b.h * sy);
    });

    bctx.fillStyle = '#7db7d9';
    bctx.fillRect(LAKE.x * sx, LAKE.y * sy, LAKE.w * sx, LAKE.h * sy);
    bctx.restore();
  }

  // ===== Hooks =====
  IZZA.on('ready', (a) => {
    api = a;

    state.tier = localStorage.getItem(MAP_TIER_KEY) || '1';
    if (isTier2()) widenCameraClampIfNeeded();

    IZZA.on('update-post', () => {
      const cur = localStorage.getItem(MAP_TIER_KEY) || '1';
      if (cur !== state.tier) {
        state.tier = cur;
        if (isTier2()) widenCameraClampIfNeeded();
      }
      if (isTier2()) pushOutOfSolids();
    });

    // Ensure bigmap overlay repaints when opened
    const mapModal = document.getElementById('mapModal');
    if (mapModal) {
      const obs = new MutationObserver(() => {
        if (mapModal.style.display === 'flex') drawBigOverlay();
      });
      obs.observe(mapModal, { attributes: true, attributeFilter: ['style'] });
    }
  });

  // Draw on every frame so main canvas & minimap always match
  IZZA.on('render-post', () => {
    if (!isTier2()) return;
    drawMainOverlay();
    drawMiniOverlay();
  });
})();
