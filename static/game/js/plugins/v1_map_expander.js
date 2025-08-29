// /static/game/js/plugins/v1_map_expander.js
(function () {
  const BUILD = 'v2.6-map-expander+downtown-stitch+render-post-under-sprites';
  console.log('[IZZA PLAY]', BUILD);

  const MAP_TIER_KEY = 'izzaMapTier';   // '1' | '2'
  const TIER2 = { x0: 10, y0: 12, x1: 80, y1: 50 };

  // Palette matched to core
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

  let api = null;
  const state = { tier: localStorage.getItem(MAP_TIER_KEY) || '1' };
  const isTier2 = () => state.tier === '2';

  // ---- Helpers
  const scl = () => api.DRAW / api.TILE;
  const w2sX = (wx) => (wx - api.camera.x) * scl();
  const w2sY = (wy) => (wy - api.camera.y) * scl();

  function fillTile(ctx, gx, gy, color) {
    const sx = w2sX(gx * api.TILE), sy = w2sY(gy * api.TILE);
    ctx.fillStyle = color;
    ctx.fillRect(sx, sy, api.DRAW, api.DRAW);
  }
  function drawHRoad(ctx, y, x0, x1) {
    for (let x = x0; x <= x1; x++) {
      fillTile(ctx, x, y, COL.road);
      // lane dashes (same look as core)
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
    // subtle top shade
    const sx = w2sX(b.x * api.TILE), sy = w2sY(b.y * api.TILE);
    ctx.fillStyle = 'rgba(0,0,0,.15)';
    ctx.fillRect(sx, sy, b.w * api.DRAW, Math.floor(b.h * api.DRAW * 0.18));
  }
  function drawLake(ctx, r) {
    const sx = w2sX(r.x * api.TILE), sy = w2sY(r.y * api.TILE);
    ctx.fillStyle = COL.water;
    ctx.fillRect(sx, sy, r.w * api.DRAW, r.h * api.DRAW);
  }

  // ---- Downtown layout (stitched to core’s main cross)
  // Alignment notes (based on your core):
  // - Core’s main horizontal road row is hRoadY; vertical avenue is vRoadX.
  // - We extend from the middle downward to make a tidy downtown.
  const LAYOUT = {
    H_ROADS: [
      // stitch: carry the main horizontal across the whole preview
      { y: null, x0: 14, x1: 76 }, // y is filled at runtime with core's hRoadY

      // downtown grid below the stitch (denser)
      // rows: hRoadY+6, +10, +14, +18 (within TIER2)
      { yOff: 6,  x0: 18, x1: 74 },
      { yOff: 10, x0: 18, x1: 74 },
      { yOff: 14, x0: 18, x1: 74 },
      { yOff: 18, x0: 18, x1: 74 }
    ],
    V_ROADS: [
      // stitch: carry the main vertical avenue
      { x: null, y0: 12, y1: 50 }, // x filled at runtime with core's vRoadX

      // downtown north-souths (avoid the avenue and shop/HQ area)
      // columns around the avenue: -16, -8, +8, +16, +24 from vRoadX
      { xOff: -16, y0: null, y1: null },
      { xOff:  -8, y0: null, y1: null },
      { xOff:   8, y0: null, y1: null },
      { xOff:  16, y0: null, y1: null },
      { xOff:  24, y0: null, y1: null }
    ],
    BUILDINGS: [
      // larger blocks sprinkled around the grid (kept clear of roads)
      { x: 50, y: null, w: 4, h: 3, color: COL.civic, yOff: 7 },   // NE civic
      { x: 40, y: null, w: 4, h: 3, color: COL.red,   yOff: 7 },   // NE red
      { x: 58, y: null, w: 4, h: 3, color: COL.police, yOff: 17 }, // SE police
      { x: 34, y: null, w: 3, h: 2, color: COL.civic, yOff: 17 },  // SE civic
      { x: 22, y: null, w: 3, h: 2, color: COL.shop,   yOff: 11 }, // mid shops
      { x: 28, y: null, w: 3, h: 2, color: COL.shop,   yOff: 11 },
      { x: 64, y: null, w: 4, h: 3, color: COL.library, yOff: 21 } // far SE
    ],
    LAKES: [ { x: 66, y: 43, w: 6, h: 3 } ]
  };

  // Fill runtime fields that depend on core positions (hRoadY, vRoadX)
  function materializeLayout() {
    const out = { H_ROADS: [], V_ROADS: [], BUILDINGS: [], LAKES: LAYOUT.LAKES.slice() };
    const hRow = api ? (api.hRoadY || (api.doorSpawn ? Math.floor(api.doorSpawn.y / api.TILE) + 1 : 30)) : 30;
    const vAve = api ? (api.vRoadX || 45) : 45;

    // H roads
    LAYOUT.H_ROADS.forEach(r=>{
      const y = (r.y!=null) ? r.y : (r.yOff!=null ? hRow + r.yOff : hRow);
      out.H_ROADS.push({ y, x0: r.x0, x1: r.x1 });
    });
    // V roads
    LAYOUT.V_ROADS.forEach(r=>{
      const x = (r.x!=null) ? r.x : (vAve + (r.xOff||0));
      const y0 = TIER2.y0, y1 = TIER2.y1;
      out.V_ROADS.push({ x, y0, y1 });
    });
    // Buildings
    LAYOUT.BUILDINGS.forEach(b=>{
      const y = (b.y!=null) ? b.y : (hRow + (b.yOff||0));
      out.BUILDINGS.push({ x:b.x, y, w:b.w, h:b.h, color:b.color });
    });
    return out;
  }

  // ---- Collision: keep player out of NEW buildings
  function pushOutOfSolids(layout) {
    if (!isTier2()) return;
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

  // ---- Painters
  function paintMain(ctx, layout) {
    // draw *after* core tiles, but *under* sprites
    ctx.save();
    ctx.globalCompositeOperation = 'destination-over';

    // base grass for the district (keeps look coherent)
    for (let gy = TIER2.y0; gy <= TIER2.y1; gy++) {
      for (let gx = TIER2.x0; gx <= TIER2.x1; gx++) fillTile(ctx, gx, gy, COL.grass);
    }

    // sidewalks
    layout.H_ROADS.forEach(r => {
      drawSidewalkRow(ctx, r.y - 1, r.x0, r.x1);
      drawSidewalkRow(ctx, r.y + 1, r.x0, r.x1);
    });
    layout.V_ROADS.forEach(r => {
      drawSidewalkCol(ctx, r.x - 1, r.y0, r.y1);
      drawSidewalkCol(ctx, r.x + 1, r.y0, r.y1);
    });

    // roads
    layout.H_ROADS.forEach(r => drawHRoad(ctx, r.y, r.x0, r.x1));
    layout.V_ROADS.forEach(r => drawVRoad(ctx, r.x, r.y0, r.y1));

    // buildings + lake(s)
    layout.BUILDINGS.forEach(b => drawBuilding(ctx, b));
    (layout.LAKES || []).forEach(l => drawLake(ctx, l));

    ctx.restore();
  }

  function paintMini(layout) {
    const mini = document.getElementById('minimap');
    const ctx = mini && mini.getContext ? mini.getContext('2d') : null;
    if (!mini || !ctx) return;
    const sx = mini.width / 90, sy = mini.height / 60;

    ctx.save();
    ctx.fillStyle = '#8a90a0';
    layout.H_ROADS.forEach(r => ctx.fillRect(r.x0 * sx, r.y * sy, (r.x1 - r.x0 + 1) * sx, 1 * sy));
    layout.V_ROADS.forEach(r => ctx.fillRect(r.x * sx, r.y0 * sy, 1 * sx, (r.y1 - r.y0 + 1) * sy));

    layout.BUILDINGS.forEach(b => {
      ctx.fillStyle = b.color;
      ctx.fillRect(b.x * sx, b.y * sy, b.w * sx, b.h * sy);
    });

    (layout.LAKES || []).forEach(l => {
      ctx.fillStyle = '#7db7d9';
      ctx.fillRect(l.x * sx, l.y * sy, l.w * sx, l.h * sy);
    });
    ctx.restore();
  }

  function paintBig(layout) {
    const big = document.getElementById('bigmap');
    const ctx = big && big.getContext ? big.getContext('2d') : null;
    if (!big || !ctx) return;
    const sx = big.width / 90, sy = big.height / 60;

    ctx.save();
    ctx.fillStyle = '#8a90a0';
    layout.H_ROADS.forEach(r => ctx.fillRect(r.x0 * sx, r.y * sy, (r.x1 - r.x0 + 1) * sx, 1.2 * sy));
    layout.V_ROADS.forEach(r => ctx.fillRect(r.x * sx, r.y0 * sy, 1.2 * sx, (r.y1 - r.y0 + 1) * sy));

    layout.BUILDINGS.forEach(b => {
      ctx.fillStyle = b.color;
      ctx.fillRect(b.x * sx, b.y * sy, b.w * sx, b.h * sy);
    });

    (layout.LAKES || []).forEach(l => {
      ctx.fillStyle = '#7db7d9';
      ctx.fillRect(l.x * sx, l.y * sy, l.w * sx, l.h * sy);
    });
    ctx.restore();
  }

  // ---- Hooks
  IZZA.on('ready', (a) => {
    api = a;
    state.tier = localStorage.getItem(MAP_TIER_KEY) || '1';

    // when big map opens, repaint overlay there too
    const mapModal = document.getElementById('mapModal');
    if (mapModal) {
      const obs = new MutationObserver(() => {
        if (mapModal.style.display === 'flex' && isTier2()) paintBig(materializeLayout());
      });
      obs.observe(mapModal, { attributes: true, attributeFilter: ['style'] });
    }
  });

  // keep tier up-to-date & collisions
  IZZA.on('update-post', () => {
    const t = localStorage.getItem(MAP_TIER_KEY) || '1';
    if (t !== state.tier) state.tier = t;
    if (!isTier2()) return;
    pushOutOfSolids(materializeLayout());
  });

  // IMPORTANT: draw AFTER core render, but under sprites via destination-over
  IZZA.on('render-post', () => {
    if (!isTier2()) return;
    const ctx = document.getElementById('game').getContext('2d');
    const layout = materializeLayout();
    paintMain(ctx, layout);
    paintMini(layout);
  });

})();
