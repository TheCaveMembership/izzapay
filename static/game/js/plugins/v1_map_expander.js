// /static/game/js/plugins/v1_map_expander.js
(function () {
  const BUILD = 'v2.4-map-expander+downtown-stitch+paint-after+minimap+bigmap+collisions';
  console.log('[IZZA PLAY]', BUILD);

  // ---- flags / storage
  const MAP_TIER_KEY = 'izzaMapTier';            // '1' | '2'
  const TIER2 = { x0: 10, y0: 12, x1: 80, y1: 50 }; // expanded play box (core already recognizes this)
  const BASE  = { x0: 18, y0: 18, x1: 72, y1: 42 }; // Tier-1 area drawn by core

  let api = null;
  const state = { tier: localStorage.getItem(MAP_TIER_KEY) || '1' };
  const isTier2 = () => state.tier === '2';

  // ---- helpers
  const scl = () => api.DRAW / api.TILE;
  const w2sX = (wx) => (wx - api.camera.x) * scl();
  const w2sY = (wy) => (wy - api.camera.y) * scl();
  const inRect  = (gx,gy,r)=> gx>=r.x0 && gx<=r.x1 && gy>=r.y0 && gy<=r.y1;

  // ---- colors (match core)
  const COL = {
    grass:    '#09371c',
    road:     '#2a2a2a',
    dash:     '#ffd23f',
    sidewalk: '#6a727b',
    red:      '#7a3a3a',
    civic:    '#405a85',
    police:   '#0a2455',
    library:  '#8a5a2b',
    shop:     '#203a60',
    water:    '#2b6a7a'
  };

  // =========================================================
  // Downtown layout (stitched bottom-middle) — all GRID coords
  // =========================================================
  // Horizontal bands (denser “inner city”)
  const H_ROADS = [
    { y: 38, x0: 18, x1: 76 },
    { y: 42, x0: 18, x1: 76 },
    { y: 46, x0: 18, x1: 76 },
    { y: 49, x0: 18, x1: 76 }  // near bottom; stays inside TIER2
  ];
  // Verticals that align with existing v-road & add new spines
  const V_ROADS = [
    { x: 28, y0: 36, y1: 50 },
    { x: 38, y0: 36, y1: 50 },
    { x: 52, y0: 36, y1: 50 }, // lines up with your existing right-side spine feel
    { x: 66, y0: 36, y1: 50 }
  ];
  // Buildings — kept off roads/sidewalks
  const BUILDINGS = [
    { x: 32, y: 39, w: 6,  h: 3, color: COL.red },     // red block
    { x: 57, y: 39, w: 6,  h: 3, color: COL.civic },   // big blue
    { x: 43, y: 45, w: 4,  h: 3, color: COL.civic },   // blue south
    { x: 24, y: 45, w: 3,  h: 2, color: COL.shop },    // shops row
    { x: 28, y: 45, w: 3,  h: 2, color: COL.shop },
    { x: 36, y: 47, w: 3,  h: 2, color: COL.shop },
    { x: 70, y: 47, w: 5,  h: 3, color: COL.library }, // library
    { x: 50, y: 37, w: 3,  h: 2, color: COL.police }   // police (upper edge)
  ];
  // Optional little pond/park
  const LAKES = [ { x: 63, y: 48, w: 5, h: 2 } ];

  // ---------------------------------------------------------
  // Camera widening without touching core clamp
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

  // ---------------------------------------------------------
  // Collisions: push player out of NEW buildings only
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
        const m = Math.min(dxL, dxR, dyT, dyB);
        if (m === dxL) api.player.x = (b.x - 0.01) * t;
        else if (m === dxR) api.player.x = (b.x + b.w + 0.01) * t;
        else if (m === dyT) api.player.y = (b.y - 0.01) * t;
        else api.player.y = (b.y + b.h + 0.01) * t;
        break;
      }
    }
  }

  // ---------------------------------------------------------
  // Painting helpers (TILES, after the core)
  function fillTile(ctx, gx, gy, color) {
    // Don’t repaint over the Tier-1 base; only paint new territory
    if (inRect(gx, gy, BASE)) return;
    const sx = w2sX(gx * api.TILE), sy = w2sY(gy * api.TILE);
    const S = api.DRAW;
    ctx.fillStyle = color;
    ctx.fillRect(sx, sy, S, S);
  }

  function drawSidewalkRow(ctx, y, x0, x1) {
    for (let x = x0; x <= x1; x++) fillTile(ctx, x, y, COL.sidewalk);
  }
  function drawSidewalkCol(ctx, x, y0, y1) {
    for (let y = y0; y <= y1; y++) fillTile(ctx, x, y, COL.sidewalk);
  }

  function drawHRoad(ctx, y, x0, x1) {
    for (let x = x0; x <= x1; x++) {
      fillTile(ctx, x, y, COL.road);
      // lane dashes
      const sx = w2sX(x * api.TILE), sy = w2sY(y * api.TILE), S = api.DRAW;
      ctx.fillStyle = COL.dash;
      for (let i = 0; i < 4; i++) {
        ctx.fillRect(sx + i * (S/4) + S * 0.05, sy + S * 0.48, S * 0.10, S * 0.04);
      }
    }
  }
  function drawVRoad(ctx, x, y0, y1) {
    for (let y = y0; y <= y1; y++) fillTile(ctx, x, y, COL.road);
  }

  function drawBuilding(ctx, b) {
    for (let gy = b.y; gy < b.y + b.h; gy++) {
      for (let gx = b.x; gx < b.x + b.w; gx++) fillTile(ctx, gx, gy, b.color);
    }
    // top shade band
    const sx = w2sX(b.x * api.TILE), sy = w2sY(b.y * api.TILE);
    ctx.fillStyle = 'rgba(0,0,0,.15)';
    ctx.fillRect(sx, sy, b.w * api.DRAW, Math.floor(b.h * api.DRAW * 0.18));
  }
  function drawLake(ctx, r) {
    for (let gy = r.y; gy < r.y + r.h; gy++) {
      for (let gx = r.x; gx < r.x + r.w; gx++) fillTile(ctx, gx, gy, COL.water);
    }
  }

  // ---------------------------------------------------------
  // MAIN canvas painter (runs AFTER core)
  function drawMainOverlay() {
    if (!isTier2()) return;
    const ctx = document.getElementById('game').getContext('2d');
    ctx.save();
    ctx.globalCompositeOperation = 'source-over'; // ⬅ paint on top so it’s visible

    // base grass for new territory only
    for (let gy = TIER2.y0; gy <= TIER2.y1; gy++) {
      for (let gx = TIER2.x0; gx <= TIER2.x1; gx++) {
        if (!inRect(gx, gy, BASE)) fillTile(ctx, gx, gy, COL.grass);
      }
    }

    // sidewalks around each road (±1)
    H_ROADS.forEach(r => { drawSidewalkRow(ctx, r.y - 1, r.x0, r.x1); drawSidewalkRow(ctx, r.y + 1, r.x0, r.x1); });
    V_ROADS.forEach(r => { drawSidewalkCol(ctx, r.x - 1, r.y0, r.y1); drawSidewalkCol(ctx, r.x + 1, r.y0, r.y1); });

    // roads themselves
    H_ROADS.forEach(r => drawHRoad(ctx, r.y, r.x0, r.x1));
    V_ROADS.forEach(r => drawVRoad(ctx, r.x, r.y0, r.y1));

    // buildings & lake(s)
    BUILDINGS.forEach(b => drawBuilding(ctx, b));
    LAKES.forEach(l => drawLake(ctx, l));

    ctx.restore();
  }

  // ---------------------------------------------------------
  // Minimap & big map overlays (simple rectangles/lines)
  function drawMiniOverlay() {
    if (!isTier2()) return;
    const mini = document.getElementById('minimap');
    const ctx = mini && mini.getContext ? mini.getContext('2d') : null;
    if (!mini || !ctx) return;
    const sx = mini.width / 90, sy = mini.height / 60;

    ctx.save();
    ctx.fillStyle = '#8a90a0';
    H_ROADS.forEach(r => ctx.fillRect(r.x0 * sx, r.y * sy, (r.x1 - r.x0 + 1) * sx, 1 * sy));
    V_ROADS.forEach(r => ctx.fillRect(r.x * sx, r.y0 * sy, 1 * sx, (r.y1 - r.y0 + 1) * sy));

    BUILDINGS.forEach(b => { ctx.fillStyle = b.color; ctx.fillRect(b.x*sx, b.y*sy, b.w*sx, b.h*sy); });
    LAKES.forEach(l => { ctx.fillStyle = '#7db7d9'; ctx.fillRect(l.x*sx, l.y*sy, l.w*sx, l.h*sy); });
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
    H_ROADS.forEach(r => ctx.fillRect(r.x0 * sx, r.y * sy, (r.x1 - r.x0 + 1) * sx, 1.2 * sy));
    V_ROADS.forEach(r => ctx.fillRect(r.x * sx, r.y0 * sy, 1.2 * sx, (r.y1 - r.y0 + 1) * sy));
    BUILDINGS.forEach(b => { ctx.fillStyle = b.color; ctx.fillRect(b.x*sx, b.y*sy, b.w*sx, b.h*sy); });
    LAKES.forEach(l => { ctx.fillStyle = '#7db7d9'; ctx.fillRect(l.x*sx, l.y*sy, l.w*sx, l.h*sy); });
    ctx.restore();
  }

  // ---------------------------------------------------------
  // Hooks
  IZZA.on('ready', (a) => {
    api = a;

    state.tier = localStorage.getItem(MAP_TIER_KEY) || '1';
    if (isTier2()) widenCameraClampIfNeeded();

    // re-draw big map when modal opens
    const mapModal = document.getElementById('mapModal');
    if (mapModal) {
      const obs = new MutationObserver(() => {
        if (mapModal.style.display === 'flex') drawBigOverlay();
      });
      obs.observe(mapModal, { attributes: true, attributeFilter: ['style'] });
    }
  });

  // keep tier current and apply collisions
  IZZA.on('update-post', () => {
    const cur = localStorage.getItem(MAP_TIER_KEY) || '1';
    if (cur !== state.tier) {
      state.tier = cur;
      if (isTier2()) widenCameraClampIfNeeded();
    }
    if (isTier2()) pushOutOfSolids();
  });

  // paint overlays every frame so main canvas & minimap stay in sync
  IZZA.on('render-post', () => {
    if (!isTier2()) return;
    drawMainOverlay();   // <— AFTER the core draw, so the new tiles are visible
    drawMiniOverlay();
  });
})();
