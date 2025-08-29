// /static/game/js/plugins/v1_map_expander.js
(function () {
  const BUILD = 'v3.0-map-expander+south-district+underlay-hook+minimap+bigmap+solid';
  console.log('[IZZA PLAY]', BUILD);

  const MAP_TIER_KEY = 'izzaMapTier';        // '1' | '2'

  // Core tier-1 rectangle (don’t overwrite this area)
  const BASE = { x0:18, y0:18, x1:72, y1:42 };

  // Tier-2 full bounds used by camera/minimap in your core
  const TIER2 = { x0:10, y0:12, x1:80, y1:50 };

  // Bottom-middle constraint: only draw **south** of tier-1
  const SOUTH_ONLY = (gx, gy) => gy > BASE.y1;

  // Palette matched to core
  const COL = {
    grass:    '#09371c',
    road:     '#2a2a2a',
    dash:     '#ffd23f',
    sidewalk: '#6a727b',
    red:      '#7a3a3a',  // big block
    shop:     '#203a60',
    civic:    '#405a85',
    police:   '#0a2455',
    library:  '#8a5a2b',
    water:    '#2b6a7a'
  };

  let api = null;
  const state = { tier: localStorage.getItem(MAP_TIER_KEY) || '1' };
  const isTier2 = () => state.tier === '2';

  // ---------- South district layout (grid coords) ----------
  // All Y values are > BASE.y1 (42) so we never overlap tier-1.
  const SOUTH = {
    // horizontal spines
    H_ROADS: [
      { y: 46, x0: 20, x1: 70 },
      { y: 50, x0: 22, x1: 68 },  // lower avenue
      { y: 54, x0: 26, x1: 66 }   // southern belt
    ],
    // north-south connectors (aligned under existing verticals where sensible)
    V_ROADS: [
      { x: 28, y0: 44, y1: 58 },
      { x: 40, y0: 44, y1: 58 },
      { x: 52, y0: 44, y1: 58 },
      { x: 64, y0: 44, y1: 58 }
    ],
    // SOLID buildings (never placed on road tiles)
    BUILDINGS: [
      { x: 30, y: 47, w: 3, h: 2, color: COL.shop },     // shops near 46
      { x: 44, y: 47, w: 4, h: 3, color: COL.red },      // large red block
      { x: 58, y: 47, w: 4, h: 3, color: COL.civic },    // blue civic
      { x: 34, y: 51, w: 3, h: 2, color: COL.shop },     // mid-row
      { x: 48, y: 51, w: 3, h: 2, color: COL.civic },    // mid-blue
      { x: 37, y: 55, w: 3, h: 2, color: COL.library },  // library south
      { x: 61, y: 55, w: 3, h: 2, color: COL.police }    // police south-east
    ],
    // small park/lake south-east
    LAKES: [ { x: 66, y: 56, w: 3, h: 2 } ]
  };

  // ---------- helpers ----------
  const scl = () => api.DRAW / api.TILE;
  const w2sX = (wx) => (wx - api.camera.x) * scl();
  const w2sY = (wy) => (wy - api.camera.y) * scl();

  function fillTile(ctx, gx, gy, color) {
    if (!SOUTH_ONLY(gx, gy)) return;
    const sx = w2sX(gx * api.TILE), sy = w2sY(gy * api.TILE);
    const S = api.DRAW;
    ctx.fillStyle = color;
    ctx.fillRect(sx, sy, S, S);
  }

  function drawHRoad(ctx, y, x0, x1) {
    for (let x = x0; x <= x1; x++) {
      if (!SOUTH_ONLY(x, y)) continue;
      fillTile(ctx, x, y, COL.road);
      const sx = w2sX(x * api.TILE), sy = w2sY(y * api.TILE), S = api.DRAW;
      ctx.fillStyle = COL.dash;
      for (let i = 0; i < 4; i++) {
        ctx.fillRect(sx + i * (S / 4) + S * 0.05, sy + S * 0.48, S * 0.10, S * 0.04);
      }
    }
  }
  function drawVRoad(ctx, x, y0, y1) {
    if (!SOUTH_ONLY(x, y0)) return;
    for (let y = y0; y <= y1; y++) fillTile(ctx, x, y, COL.road);
  }
  function drawSidewalkRow(ctx, y, x0, x1) {
    for (let x = x0; x <= x1; x++) if (SOUTH_ONLY(x, y)) fillTile(ctx, x, y, COL.sidewalk);
  }
  function drawSidewalkCol(ctx, x, y0, y1) {
    if (!SOUTH_ONLY(x, y0)) return;
    for (let y = y0; y <= y1; y++) fillTile(ctx, x, y, COL.sidewalk);
  }
  function drawBuilding(ctx, b) {
    if (!SOUTH_ONLY(b.x, b.y)) return;
    for (let gy = b.y; gy < b.y + b.h; gy++) {
      for (let gx = b.x; gx < b.x + b.w; gx++) fillTile(ctx, gx, gy, b.color);
    }
    // subtle top shade to match core buildings
    const sx = w2sX(b.x * api.TILE), sy = w2sY(b.y * api.TILE);
    ctx.fillStyle = 'rgba(0,0,0,.15)';
    ctx.fillRect(sx, sy, b.w * api.DRAW, Math.floor(b.h * api.DRAW * 0.18));
  }
  function drawLake(ctx, r) {
    if (!SOUTH_ONLY(r.x, r.y)) return;
    ctx.fillStyle = COL.water;
    ctx.fillRect(w2sX(r.x * api.TILE), w2sY(r.y * api.TILE), r.w * api.DRAW, r.h * api.DRAW);
  }

  // Camera widen (uses your core’s Tier2 bounds)
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

  // Soft collisions for new (south) buildings
  function pushOutOfSolids() {
    if (!isTier2()) return;
    const t = api.TILE;
    const px = api.player.x, py = api.player.y;
    const gx = (px / t) | 0, gy = (py / t) | 0;

    for (const b of SOUTH.BUILDINGS) {
      if (!SOUTH_ONLY(b.x, b.y)) continue;
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

  // ---------- Paint on the main canvas (between tiles and sprites) ----------
  // Uses the new core hook 'render-under'
  function drawMainOverlay() {
    if (!isTier2()) return;
    const ctx = document.getElementById('game').getContext('2d');

    // base grass for south district (keeps core look)
    for (let gy = Math.max(TIER2.y0, BASE.y1 + 1); gy <= TIER2.y1; gy++) {
      for (let gx = TIER2.x0; gx <= TIER2.x1; gx++) {
        if (SOUTH_ONLY(gx, gy)) fillTile(ctx, gx, gy, COL.grass);
      }
    }

    // sidewalks
    SOUTH.H_ROADS.forEach(r => {
      drawSidewalkRow(ctx, r.y - 1, r.x0, r.x1);
      drawSidewalkRow(ctx, r.y + 1, r.x0, r.x1);
    });
    SOUTH.V_ROADS.forEach(r => {
      drawSidewalkCol(ctx, r.x - 1, r.y0, r.y1);
      drawSidewalkCol(ctx, r.x + 1, r.y0, r.y1);
    });

    // roads
    SOUTH.H_ROADS.forEach(r => drawHRoad(ctx, r.y, r.x0, r.x1));
    SOUTH.V_ROADS.forEach(r => drawVRoad(ctx, r.x, r.y0, r.y1));

    // buildings & lake
    SOUTH.BUILDINGS.forEach(b => drawBuilding(ctx, b));
    SOUTH.LAKES.forEach(l => drawLake(ctx, l));
  }

  // ---------- Minimap & big map overlays (match what we draw) ----------
  function drawMiniOverlay() {
    if (!isTier2()) return;
    const mini = document.getElementById('minimap');
    const ctx = mini && mini.getContext ? mini.getContext('2d') : null;
    if (!mini || !ctx) return;
    const sx = mini.width / 90, sy = mini.height / 60;

    ctx.save();
    ctx.fillStyle = '#8a90a0';
    SOUTH.H_ROADS.forEach(r => ctx.fillRect(r.x0 * sx, r.y * sy, (r.x1 - r.x0 + 1) * sx, 1 * sy));
    SOUTH.V_ROADS.forEach(r => ctx.fillRect(r.x * sx, r.y0 * sy, 1 * sx, (r.y1 - r.y0 + 1) * sy));

    SOUTH.BUILDINGS.forEach(b => {
      ctx.fillStyle = b.color;
      ctx.fillRect(b.x * sx, b.y * sy, b.w * sx, b.h * sy);
    });

    SOUTH.LAKES.forEach(l => {
      ctx.fillStyle = '#7db7d9';
      ctx.fillRect(l.x * sx, l.y * sy, l.w * sx, l.h * sy);
    });
    ctx.restore();
  }

  function drawBigOverlay() {
    if (!isTier2()) return;
    const big = document.getElementById('bigmap');
    const ctx = big && big.getContext ? big.getContext('2d') : null;
    if (!big || !ctx) return;
    const sx = big.width / 90, sy = big.height / 60;

    ctx.save();
    ctx.fillStyle = '#8a90a0';
    SOUTH.H_ROADS.forEach(r => ctx.fillRect(r.x0 * sx, r.y * sy, (r.x1 - r.x0 + 1) * sx, 1.2 * sy));
    SOUTH.V_ROADS.forEach(r => ctx.fillRect(r.x * sx, r.y0 * sy, 1.2 * sx, (r.y1 - r.y0 + 1) * sy));

    SOUTH.BUILDINGS.forEach(b => {
      ctx.fillStyle = b.color;
      ctx.fillRect(b.x * sx, b.y * sy, b.w * sx, b.h * sy);
    });

    SOUTH.LAKES.forEach(l => {
      ctx.fillStyle = '#7db7d9';
      ctx.fillRect(l.x * sx, l.y * sy, l.w * sx, l.h * sy);
    });
    ctx.restore();
  }

  // ---------- Hooks ----------
  IZZA.on('ready', (a) => {
    api = a;
    state.tier = localStorage.getItem(MAP_TIER_KEY) || '1';
    if (isTier2()) widenCameraClampIfNeeded();

    // draw big map when modal opens
    const mapModal = document.getElementById('mapModal');
    if (mapModal) {
      const obs = new MutationObserver(() => {
        if (mapModal.style.display === 'flex') drawBigOverlay();
      });
      obs.observe(mapModal, { attributes: true, attributeFilter: ['style'] });
    }
  });

  // Keep tier synced and apply collisions
  IZZA.on('update-post', () => {
    const cur = localStorage.getItem(MAP_TIER_KEY) || '1';
    if (cur !== state.tier) {
      state.tier = cur;
      if (isTier2()) widenCameraClampIfNeeded();
    }
    if (isTier2()) pushOutOfSolids();
  });

  // 🔑 Paint **between tiles and sprites** using the new core hook
  IZZA.on('render-under', () => {
    if (!isTier2()) return;
    drawMainOverlay();
  });

  // Keep minimap updated each frame (it’s cheap)
  IZZA.on('render-post', () => {
    if (!isTier2()) return;
    drawMiniOverlay();
  });
})();
