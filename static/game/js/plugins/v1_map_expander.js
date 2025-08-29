// /static/game/js/plugins/v1_map_expander.js
(function () {
  const BUILD = 'v2.7-map-expander+downtown-stitch';
  console.log('[IZZA PLAY]', BUILD);

  // ---- flags / storage ----
  const MAP_TIER_KEY = 'izzaMapTier'; // '1' | '2'
  // Expanded play box (matches your core tier-2)
  const TIER2 = { x0: 10, y0: 12, x1: 80, y1: 50 };

  // Palette (match core)
  const COL = {
    grass: '#09371c',
    road: '#2a2a2a',
    dash: '#ffd23f',
    side: '#6a727b',
    red: '#7a3a3a',
    shop: '#203a60',
    civic: '#405a85',
    police: '#0a2455',
    library: '#8a5a2b',
    water: '#2b6a7a'
  };

  let api = null;
  const state = { tier: localStorage.getItem(MAP_TIER_KEY) || '1' };
  const isTier2 = () => state.tier === '2';

  // ---- helpers ----
  const scl = () => api.DRAW / api.TILE;
  const w2sX = (wx) => (wx - api.camera.x) * scl();
  const w2sY = (wy) => (wy - api.camera.y) * scl();

  // Recover core’s spine positions so we can stitch cleanly:
  // door is on the TOP sidewalk of the main horizontal road.
  function coreHRoadY() {
    const doorGY = Math.floor(api.doorSpawn.y / api.TILE);
    return doorGY + 1; // sidewalkTopY = hRoadY - 1
  }
  // Core vertical road: bX + 16 ~= doorGX + 11 (see core math)
  function coreVRoadX() {
    const doorGX = Math.floor((api.doorSpawn.x + 8) / api.TILE); // same compensation core uses
    return doorGX + 11;
  }

  // ---- Downtown layout (grid coords, derived from the core spines) ----
  function buildLayout() {
    const HR = coreHRoadY();      // existing east-west road row
    const VX = coreVRoadX();      // existing north-south avenue col

    // Put downtown below the main road and centered around the avenue.
    // Rows are spaced by 6 tiles to form neat blocks.
    const rows = [HR + 6, HR + 12, HR + 18, HR + 24];
    // Cols left & right of the core avenue
    const cols = [VX - 16, VX - 8, VX, VX + 10, VX + 22];

    // Horizontal roads (all connect into the core avenue)
    const H_ROADS = rows.map((y) => ({
      y,
      x0: Math.max(TIER2.x0 + 2, VX - 24),
      x1: Math.min(TIER2.x1 - 2, VX + 28)
    }));

    // Vertical roads span across all new rows and meet the main HR at the top
    const V_ROADS = cols.map((x) => ({
      x,
      y0: rows[0] - 1, // butt into (or 1 below) the core road row for a tidy junction
      y1: rows[rows.length - 1] + 1
    }));

    // Buildings: fill blocks between roads; no road passes through a building.
    // (w,h chosen to sit inside the blocks, leaving sidewalk ring).
    const BUILDINGS = [
      // north band
      { x: VX - 14, y: rows[0] - 3, w: 5, h: 3, color: COL.red },
      { x: VX - 6,  y: rows[0] - 3, w: 4, h: 3, color: COL.civic },
      { x: VX + 12, y: rows[0] - 3, w: 5, h: 3, color: COL.shop },

      // mid band
      { x: VX - 20, y: rows[1] - 3, w: 6, h: 3, color: COL.shop },
      { x: VX - 2,  y: rows[1] - 3, w: 4, h: 3, color: COL.police },
      { x: VX + 14, y: rows[1] - 3, w: 5, h: 3, color: COL.civic },

      // south band
      { x: VX - 18, y: rows[2] - 3, w: 5, h: 3, color: COL.civic },
      { x: VX + 2,  y: rows[2] - 3, w: 4, h: 3, color: COL.shop },
      { x: VX + 20, y: rows[2] - 3, w: 5, h: 3, color: COL.library },

      // far south scatter
      { x: VX - 10, y: rows[3] - 3, w: 4, h: 3, color: COL.shop },
      { x: VX + 10, y: rows[3] - 3, w: 4, h: 3, color: COL.civic }
    ].filter(inTier2);

    // Small water feature in the SE block (visual only)
    const LAKES = [{ x: Math.min(TIER2.x1 - 8, VX + 18), y: rows[3] + 2, w: 6, h: 3 }];

    return { H_ROADS, V_ROADS, BUILDINGS, LAKES, HR, VX };
  }

  const inTier2 = (b) =>
    b.x >= TIER2.x0 && b.y >= TIER2.y0 && b.x + (b.w || 1) <= TIER2.x1 + 1 && b.y + (b.h || 1) <= TIER2.y1 + 1;

  // ---- painters (MAIN CANVAS) ----
  function fillTile(ctx, gx, gy, color) {
    const sx = w2sX(gx * api.TILE), sy = w2sY(gy * api.TILE);
    const S = api.DRAW;
    ctx.fillStyle = color;
    ctx.fillRect(sx, sy, S, S);
  }
  function drawHRoad(ctx, y, x0, x1) {
    for (let x = x0; x <= x1; x++) {
      fillTile(ctx, x, y, COL.road);
      // lane dashes (same style as core)
      const sx = w2sX(x * api.TILE), sy = w2sY(y * api.TILE), S = api.DRAW;
      ctx.fillStyle = COL.dash;
      for (let i = 0; i < 4; i++) ctx.fillRect(sx + i * (S / 4) + S * 0.05, sy + S * 0.48, S * 0.10, S * 0.04);
    }
  }
  function drawVRoad(ctx, x, y0, y1) {
    for (let y = y0; y <= y1; y++) fillTile(ctx, x, y, COL.road);
  }
  function drawSidewalkRingForRows(ctx, y, x0, x1) {
    for (let x = x0; x <= x1; x++) {
      fillTile(ctx, x, y - 1, COL.side);
      fillTile(ctx, x, y + 1, COL.side);
    }
  }
  function drawSidewalkRingForCols(ctx, x, y0, y1) {
    for (let y = y0; y <= y1; y++) {
      fillTile(ctx, x - 1, y, COL.side);
      fillTile(ctx, x + 1, y, COL.side);
    }
  }
  function drawBuilding(ctx, b) {
    for (let gy = b.y; gy < b.y + b.h; gy++) {
      for (let gx = b.x; gx < b.x + b.w; gx++) fillTile(ctx, gx, gy, b.color);
    }
    // subtle top band like HQ/Shop
    const sx = w2sX(b.x * api.TILE), sy = w2sY(b.y * api.TILE);
    ctx.fillStyle = 'rgba(0,0,0,.15)';
    ctx.fillRect(sx, sy, b.w * api.DRAW, Math.floor(b.h * api.DRAW * 0.18));
  }
  function drawLake(ctx, r) {
    const sx = w2sX(r.x * api.TILE), sy = w2sY(r.y * api.TILE);
    ctx.fillStyle = COL.water;
    ctx.fillRect(sx, sy, r.w * api.DRAW, r.h * api.DRAW);
  }

  function drawMainOverlay(layout) {
    const ctx = document.getElementById('game').getContext('2d');
    ctx.save();

    // Paint over core tiles; we use exact tile fills, so no blending tricks.
    // 1) base grass in the Tier-2 box
    for (let gy = TIER2.y0; gy <= TIER2.y1; gy++) {
      for (let gx = TIER2.x0; gx <= TIER2.x1; gx++) fillTile(ctx, gx, gy, COL.grass);
    }

    // 2) sidewalks (±1 like core) then roads
    layout.H_ROADS.forEach((r) => drawSidewalkRingForRows(ctx, r.y, r.x0, r.x1));
    layout.V_ROADS.forEach((r) => drawSidewalkRingForCols(ctx, r.x, r.y0, r.y1));
    layout.H_ROADS.forEach((r) => drawHRoad(ctx, r.y, r.x0, r.x1));
    layout.V_ROADS.forEach((r) => drawVRoad(ctx, r.x, r.y0, r.y1));

    // 3) solids and water
    layout.BUILDINGS.forEach((b) => drawBuilding(ctx, b));
    layout.LAKES.forEach((l) => drawLake(ctx, l));

    ctx.restore();
  }

  // ---- minimap & bigmap overlays ----
  function drawMini(layout) {
    const mini = document.getElementById('minimap');
    const ctx = mini && mini.getContext ? mini.getContext('2d') : null;
    if (!mini || !ctx) return;
    const sx = mini.width / 90, sy = mini.height / 60;

    // roads
    ctx.fillStyle = '#8a90a0';
    layout.H_ROADS.forEach((r) => ctx.fillRect(r.x0 * sx, r.y * sy, (r.x1 - r.x0 + 1) * sx, 1 * sy));
    layout.V_ROADS.forEach((r) => ctx.fillRect(r.x * sx, r.y0 * sy, 1 * sx, (r.y1 - r.y0 + 1) * sy));

    // buildings
    layout.BUILDINGS.forEach((b) => {
      ctx.fillStyle = b.color;
      ctx.fillRect(b.x * sx, b.y * sy, b.w * sx, b.h * sy);
    });

    // lakes
    layout.LAKES.forEach((l) => {
      ctx.fillStyle = '#7db7d9';
      ctx.fillRect(l.x * sx, l.y * sy, l.w * sx, l.h * sy);
    });
  }

  function drawBig(layout) {
    const big = document.getElementById('bigmap');
    const ctx = big && big.getContext ? big.getContext('2d') : null;
    if (!big || !ctx) return;
    const sx = big.width / 90, sy = big.height / 60;

    ctx.fillStyle = '#8a90a0';
    layout.H_ROADS.forEach((r) => ctx.fillRect(r.x0 * sx, r.y * sy, (r.x1 - r.x0 + 1) * sx, 1.2 * sy));
    layout.V_ROADS.forEach((r) => ctx.fillRect(r.x * sx, r.y0 * sy, 1.2 * sx, (r.y1 - r.y0 + 1) * sy));

    layout.BUILDINGS.forEach((b) => {
      ctx.fillStyle = b.color;
      ctx.fillRect(b.x * sx, b.y * sy, b.w * sx, b.h * sy);
    });

    layout.LAKES.forEach((l) => {
      ctx.fillStyle = '#7db7d9';
      ctx.fillRect(l.x * sx, l.y * sy, l.w * sx, l.h * sy);
    });
  }

  // ---- collisions: push out of NEW solids only ----
  function pushOutOfDowntown(layout) {
    const t = api.TILE;
    const px = api.player.x, py = api.player.y;
    const gx = (px / t) | 0, gy = (py / t) | 0;

    for (const b of layout.BUILDINGS) {
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

  // ---- camera clamp widened to Tier 2 (no core edits) ----
  function widenCameraClamp() {
    if (widenCameraClamp._done) return;
    widenCameraClamp._done = true;
    IZZA.on('update-post', () => {
      if (!isTier2()) return;
      const visW = document.getElementById('game').width / scl();
      const visH = document.getElementById('game').height / scl();
      const maxX = (TIER2.x1 + 1) * api.TILE - visW;
      const maxY = (TIER2.y1 + 1) * api.TILE - visH;
      api.camera.x = Math.max(TIER2.x0 * api.TILE, Math.min(api.camera.x, maxX));
      api.camera.y = Math.max(TIER2.y0 * api.TILE, Math.min(api.camera.y, maxY));
    });
  }

  // ---- hooks ----
  let layout = null;

  IZZA.on('ready', (a) => {
    api = a;
    state.tier = localStorage.getItem(MAP_TIER_KEY) || '1';
    if (isTier2()) {
      widenCameraClamp();
      layout = buildLayout();
    }

    // paint big map when opened
    const mapModal = document.getElementById('mapModal');
    if (mapModal) {
      const obs = new MutationObserver(() => {
        if (mapModal.style.display === 'flex' && layout) drawBig(layout);
      });
      obs.observe(mapModal, { attributes: true, attributeFilter: ['style'] });
    }
  });

  // keep tier in sync (Mission 3 flips it)
  IZZA.on('update-post', () => {
    const cur = localStorage.getItem(MAP_TIER_KEY) || '1';
    if (cur !== state.tier) {
      state.tier = cur;
      if (isTier2()) {
        widenCameraClamp();
        layout = buildLayout();
      }
    }
    if (isTier2() && layout) pushOutOfDowntown(layout);
  });

  // draw main + minimap every frame so they always match
  IZZA.on('render-post', () => {
    if (!isTier2()) return;
    if (!layout) layout = buildLayout();
    drawMainOverlay(layout);
    drawMini(layout);
  });
})();
