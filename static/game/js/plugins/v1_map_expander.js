// /static/game/js/plugins/v1_map_expander.js
(function () {
  const BUILD = 'v2.2-map-expander+east-only+destination-over+minimap+bigmap+solid';
  console.log('[IZZA PLAY]', BUILD);

  // ===== Flags / storage =====
  const MAP_TIER_KEY = 'izzaMapTier'; // '1' | '2'

  // Your original Tier-1 play box (don’t paint over it)
  const BASE = { x0: 18, y0: 18, x1: 72, y1: 42 };

  // Tier-2 bounds: expanded EAST (kept inside your 90×60 world used by the maps)
  const TIER2 = { x0: 10, y0: 12, x1: 90, y1: 50 };

  // Palette that matches the core renderer
  const COL = {
    grass:    '#09371c',
    road:     '#2a2a2a',
    dash:     '#ffd23f',
    sidewalk: '#6a727b',
    red:      '#7a3a3a',  // big block
    shop:     '#203a60',  // small shop
    civic:    '#405a85',  // blue civic
    police:   '#0a2455',
    library:  '#8a5a2b',
    water:    '#2b6a7a'
  };

  let api = null;
  const state = { tier: localStorage.getItem(MAP_TIER_KEY) || '1' };
  const isTier2 = () => state.tier === '2';

  // ===== Single EAST district layout (all tiles strictly > BASE.x1) =====
  // So we never draw over the existing city.
  const LAYOUT_EAST = {
    // roads (all pieces sit east of x=72)
    H_ROADS: [
      { y: 20, x0: 74, x1: 88 },
      { y: 28, x0: 74, x1: 88 },
      { y: 36, x0: 74, x1: 88 },
      { y: 44, x0: 74, x1: 88 }
    ],
    V_ROADS: [
      { x: 76, y0: 18, y1: 46 },
      { x: 82, y0: 18, y1: 46 },
      { x: 88, y0: 18, y1: 46 }
    ],

    // buildings (SOLID). All x > 72 so they never overlap Tier-1.
    BUILDINGS: [
      { x: 75, y: 22, w: 3, h: 2, color: COL.shop },     // shops NW
      { x: 79, y: 22, w: 4, h: 3, color: COL.red },      // big red
      { x: 85, y: 24, w: 4, h: 3, color: COL.civic },    // blue civic
      { x: 78, y: 32, w: 3, h: 2, color: COL.shop },     // shops mid
      { x: 84, y: 32, w: 3, h: 2, color: COL.civic },    // blue mid
      { x: 88, y: 40, w: 2, h: 2, color: COL.library },  // library SE corner
      { x: 82, y: 18, w: 3, h: 2, color: COL.police }    // police NE
    ],

    // little rectangular “lake/park” (visual only)
    LAKES: [ { x: 84, y: 45, w: 4, h: 2 } ]
  };

  // ===== helpers =====
  const scl = () => api.DRAW / api.TILE;
  const w2sX = (wx) => (wx - api.camera.x) * scl();
  const w2sY = (wy) => (wy - api.camera.y) * scl();
  const clampToEast = (gx) => gx > BASE.x1; // only render east of the original city

  function fillTile(ctx, gx, gy, color) {
    if (!clampToEast(gx)) return; // never paint on the old district
    const sx = w2sX(gx * api.TILE), sy = w2sY(gy * api.TILE);
    const S = api.DRAW;
    ctx.fillStyle = color;
    ctx.fillRect(sx, sy, S, S);
  }

  function drawHRoad(ctx, y, x0, x1) {
    for (let x = Math.max(x0, BASE.x1 + 1); x <= x1; x++) {
      fillTile(ctx, x, y, COL.road);
      const sx = w2sX(x * api.TILE), sy = w2sY(y * api.TILE), S = api.DRAW;
      ctx.fillStyle = COL.dash;
      for (let i = 0; i < 4; i++) {
        ctx.fillRect(sx + i * (S / 4) + S * 0.05, sy + S * 0.48, S * 0.10, S * 0.04);
      }
    }
  }
  function drawVRoad(ctx, x, y0, y1) {
    if (!clampToEast(x)) return;
    for (let y = y0; y <= y1; y++) fillTile(ctx, x, y, COL.road);
  }
  function drawSidewalkRow(ctx, y, x0, x1) {
    for (let x = Math.max(x0, BASE.x1 + 1); x <= x1; x++) fillTile(ctx, x, y, COL.sidewalk);
  }
  function drawSidewalkCol(ctx, x, y0, y1) {
    if (!clampToEast(x)) return;
    for (let y = y0; y <= y1; y++) fillTile(ctx, x, y, COL.sidewalk);
  }
  function drawBuilding(ctx, b) {
    if (!clampToEast(b.x)) return;
    for (let gy = b.y; gy < b.y + b.h; gy++) {
      for (let gx = b.x; gx < b.x + b.w; gx++) fillTile(ctx, gx, gy, b.color);
    }
    // subtle top shade to match HQ/Shop
    const sx = w2sX(b.x * api.TILE), sy = w2sY(b.y * api.TILE);
    ctx.fillStyle = 'rgba(0,0,0,.15)';
    ctx.fillRect(sx, sy, b.w * api.DRAW, Math.floor(b.h * api.DRAW * 0.18));
  }
  function drawLake(ctx, r) {
    if (!clampToEast(r.x)) return;
    ctx.fillStyle = COL.water;
    ctx.fillRect(w2sX(r.x * api.TILE), w2sY(r.y * api.TILE), r.w * api.DRAW, r.h * api.DRAW);
  }

  // Camera widening without touching the core clamp
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

  // Push player out of new buildings (roads/sidewalks remain passable)
  function pushOutOfSolids() {
    if (!isTier2()) return;
    const t = api.TILE;
    const px = api.player.x, py = api.player.y;
    const gx = (px / t) | 0, gy = (py / t) | 0;

    for (const b of LAYOUT_EAST.BUILDINGS) {
      if (!clampToEast(b.x)) continue;
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

  // ===== Painting (main canvas *behind* sprites, minimap, big map) =====
  function drawMainOverlay() {
    if (!isTier2()) return;
    const cvs = document.getElementById('game');
    const ctx = cvs.getContext('2d');

    ctx.save();
    // Paint on the main canvas but *behind* the base scene & sprites.
    ctx.globalCompositeOperation = 'destination-over';

    // east district grass fill (only east of BASE)
    for (let gy = TIER2.y0; gy <= TIER2.y1; gy++) {
      for (let gx = Math.max(BASE.x1 + 1, TIER2.x0); gx <= TIER2.x1; gx++) {
        fillTile(ctx, gx, gy, COL.grass);
      }
    }

    // sidewalks around roads
    LAYOUT_EAST.H_ROADS.forEach(r => {
      drawSidewalkRow(ctx, r.y - 1, r.x0, r.x1);
      drawSidewalkRow(ctx, r.y + 1, r.x0, r.x1);
    });
    LAYOUT_EAST.V_ROADS.forEach(r => {
      drawSidewalkCol(ctx, r.x - 1, r.y0, r.y1);
      drawSidewalkCol(ctx, r.x + 1, r.y0, r.y1);
    });

    // roads
    LAYOUT_EAST.H_ROADS.forEach(r => drawHRoad(ctx, r.y, r.x0, r.x1));
    LAYOUT_EAST.V_ROADS.forEach(r => drawVRoad(ctx, r.x, r.y0, r.y1));

    // buildings & lakes
    LAYOUT_EAST.BUILDINGS.forEach(b => drawBuilding(ctx, b));
    LAYOUT_EAST.LAKES.forEach(l => drawLake(ctx, l));

    ctx.restore();
  }

  function drawMiniOverlay() {
    if (!isTier2()) return;
    const mini = document.getElementById('minimap');
    const ctx = mini && mini.getContext ? mini.getContext('2d') : null;
    if (!mini || !ctx) return;

    const sx = mini.width / 90, sy = mini.height / 60;

    ctx.save();
    // roads
    ctx.fillStyle = '#8a90a0';
    LAYOUT_EAST.H_ROADS.forEach(r => {
      const x0 = Math.max(r.x0, BASE.x1 + 1);
      ctx.fillRect(x0 * sx, r.y * sy, (r.x1 - x0 + 1) * sx, 1 * sy);
    });
    LAYOUT_EAST.V_ROADS.forEach(r => {
      if (r.x <= BASE.x1) return;
      ctx.fillRect(r.x * sx, r.y0 * sy, 1 * sx, (r.y1 - r.y0 + 1) * sy);
    });

    // buildings
    LAYOUT_EAST.BUILDINGS.forEach(b => {
      if (b.x <= BASE.x1) return;
      ctx.fillStyle = b.color;
      ctx.fillRect(b.x * sx, b.y * sy, b.w * sx, b.h * sy);
    });

    // lakes
    LAYOUT_EAST.LAKES.forEach(l => {
      if (l.x <= BASE.x1) return;
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
    LAYOUT_EAST.H_ROADS.forEach(r => {
      const x0 = Math.max(r.x0, BASE.x1 + 1);
      ctx.fillRect(x0 * sx, r.y * sy, (r.x1 - x0 + 1) * sx, 1.2 * sy);
    });
    LAYOUT_EAST.V_ROADS.forEach(r => {
      if (r.x <= BASE.x1) return;
      ctx.fillRect(r.x * sx, r.y0 * sy, 1.2 * sx, (r.y1 - r.y0 + 1) * sy);
    });

    LAYOUT_EAST.BUILDINGS.forEach(b => {
      if (b.x <= BASE.x1) return;
      ctx.fillStyle = b.color;
      ctx.fillRect(b.x * sx, b.y * sy, b.w * sx, b.h * sy);
    });

    LAYOUT_EAST.LAKES.forEach(l => {
      if (l.x <= BASE.x1) return;
      ctx.fillStyle = '#7db7d9';
      ctx.fillRect(l.x * sx, l.y * sy, l.w * sx, l.h * sy);
    });
    ctx.restore();
  }

  // ===== Hooks =====
  IZZA.on('ready', (a) => {
    api = a;
    state.tier = localStorage.getItem(MAP_TIER_KEY) || '1';
    if (isTier2()) widenCameraClampIfNeeded();

    // repaint big map whenever modal opens
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

  // paint every frame on main canvas (behind sprites) and minimap
  IZZA.on('render-post', () => {
    if (!isTier2()) return;
    drawMainOverlay();
    drawMiniOverlay();
  });
})();
