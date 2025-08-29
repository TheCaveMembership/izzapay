// /static/game/js/plugins/v1_map_expander.js
(function () {
  const BUILD = 'v1.4-map-expander+tier2-tiles+sidewalks+dashes+solid-buildings';
  console.log('[IZZA PLAY]', BUILD);

  const MAP_TIER_KEY = 'izzaMapTier';       // '1' | '2'
  const TIER2 = { x0: 10, y0: 12, x1: 80, y1: 50 }; // expanded box (east + a bit north/south)

  // === Core palette (copied from your core) ===
  const COL = {
    grass:     '#09371c',
    sidewalk:  '#6a727b',
    road:      '#2a2a2a',
    dash:      '#ffd23f',
    bHQ:       '#4a2d2d',
    bShop:     '#203a60',
    shade:     'rgba(0,0,0,.15)', // top lip on buildings
    miniRoad:  '#788292',         // your minimap road tone
    miniLake:  '#7db7d9'
  };

  let api = null;
  const state = { tier: localStorage.getItem(MAP_TIER_KEY) || '1' };
  const isTier2 = () => state.tier === '2';

  // === District-2 BLUEPRINT (grid units) ===
  // Horizontal roads (with sidewalks above/below), each entry: {y, x0, x1}
  const H_ROADS = [
    { y: 20, x0: 14, x1: 76 },
    { y: 36, x0: 14, x1: 76 },
    { y: 44, x0: 16, x1: 72 } // lower connector
  ];

  // Vertical roads (with sidewalks left/right), each: {x, y0, y1}
  const V_ROADS = [
    { x: 28, y0: 14, y1: 44 },
    { x: 52, y0: 14, y1: 44 }
  ];

  // Short connectors / stubs (feel like your cul-de-sacs)
  const H_STUBS = [
    { y: 20, x0: 18, x1: 22 },
    { y: 20, x0: 60, x1: 64 }
  ];
  const V_STUBS = [
    { x: 22, y0: 20, y1: 24 }
  ];

  // Buildings (solid) — use same “block w/ top shade” look
  const BUILDINGS = [
    { x: 41, y: 22, w: 4, h: 3, color: '#4a2d2d' }, // red block (HQ-ish)
    { x: 55, y: 24, w: 4, h: 3, color: '#203a60' }, // blue civic
    { x: 36, y: 38, w: 3, h: 2, color: '#203a60' }, // small blue
    { x: 20, y: 28, w: 2, h: 2, color: '#203a60' },
    { x: 24, y: 28, w: 2, h: 2, color: '#203a60' },
    { x: 28, y: 28, w: 2, h: 2, color: '#203a60' },
    { x: 64, y: 45, w: 4, h: 3, color: '#8a5a2b' }, // library
    { x: 48, y: 18, w: 3, h: 2, color: '#0a2455' }, // police
    { x: 58, y: 34, w: 3, h: 2, color: '#4d7bd1' }  // toy shop
  ];

  // Small lake (visual)
  const LAKE = { gx: 66, gy: 43, w: 3, h: 2 };

  // === Helpers ===
  const SCL = () => api.DRAW / api.TILE;
  const w2sX = (wx) => (wx - api.camera.x) * SCL();
  const w2sY = (wy) => (wy - api.camera.y) * SCL();

  // ==== CAMERA widen without touching core
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

  // ==== COLLISION for new buildings (4-corner like core)
  function pushOutOfNewBuildings() {
    if (!isTier2()) return;
    const t = api.TILE;

    const px0 = api.player.x, py0 = api.player.y;
    const px1 = px0 + t - 1,   py1 = py0 + t - 1;

    for (const b of BUILDINGS) {
      const bx0 = b.x * t, by0 = b.y * t;
      const bx1 = (b.x + b.w) * t, by1 = (b.y + b.h) * t;

      const overlapX = Math.max(0, Math.min(px1, bx1) - Math.max(px0, bx0));
      const overlapY = Math.max(0, Math.min(py1, by1) - Math.max(py0, by0));
      if (overlapX > 0 && overlapY > 0) {
        // resolve along the shallow axis
        if (overlapX < overlapY) {
          // move left or right
          if (px0 + px1 < bx0 + bx1) {
            api.player.x = bx0 - t;               // push left
          } else {
            api.player.x = bx1 + 1;               // push right
          }
        } else {
          // move up or down
          if (py0 + py1 < by0 + by1) {
            api.player.y = by0 - t;               // push up
          } else {
            api.player.y = by1 + 1;               // push down
          }
        }
        break;
      }
    }
  }

  // ==== TILE-ACCURATE PAINTER (matches core look)
  function fillTile(ctx, gx, gy, color) {
    const S = api.DRAW, t = api.TILE;
    const sx = w2sX(gx * t), sy = w2sY(gy * t);
    ctx.fillStyle = color;
    ctx.fillRect(sx, sy, S, S);
  }
  function drawHRoad(ctx, y, x0, x1) {
    for (let x = x0; x <= x1; x++) fillTile(ctx, x, y, COL.road);
    // dashed yellow center (like core hRoad)
    const S = api.DRAW, t = api.TILE;
    ctx.fillStyle = COL.dash;
    for (let x = x0; x <= x1; x++) {
      const sx = w2sX(x * t);
      const sy = w2sY(y * t);
      for (let i = 0; i < 4; i++) {
        ctx.fillRect(sx + i * (S / 4) + S * 0.05, sy + S * 0.48, S * 0.10, S * 0.04);
      }
    }
    // sidewalks above/below
    for (let x = x0; x <= x1; x++) {
      fillTile(ctx, x, y - 1, COL.sidewalk);
      fillTile(ctx, x, y + 1, COL.sidewalk);
    }
  }
  function drawVRoad(ctx, x, y0, y1) {
    for (let y = y0; y <= y1; y++) fillTile(ctx, x, y, COL.road);
    // sidewalks left/right
    for (let y = y0; y <= y1; y++) {
      fillTile(ctx, x - 1, y, COL.sidewalk);
      fillTile(ctx, x + 1, y, COL.sidewalk);
    }
  }
  function drawBuilding(ctx, b) {
    const S = api.DRAW, t = api.TILE;
    const sx = w2sX(b.x * t), sy = w2sY(b.y * t);
    ctx.fillStyle = b.color; ctx.fillRect(sx, sy, b.w * S, b.h * S);
    ctx.fillStyle = COL.shade; ctx.fillRect(sx, sy, b.w * S, Math.floor(b.h * S * 0.18));
  }
  function drawLake(ctx) {
    // soft rectangle “pond” like a big blue building (keeps style simple)
    for (let y = 0; y < LAKE.h; y++) {
      for (let x = 0; x < LAKE.w; x++) {
        fillTile(ctx, LAKE.gx + x, LAKE.gy + y, '#2b6a7a');
      }
    }
  }

  // Main canvas overlay
  function drawMainOverlay() {
    if (!isTier2()) return;
    const ctx = document.getElementById('game').getContext('2d');
    ctx.save();
    // paint grass base for new area so roads/sidewalks are visible if base is locked look
    for (let gy = TIER2.y0; gy <= TIER2.y1; gy++) {
      for (let gx = TIER2.x0; gx <= TIER2.x1; gx++) fillTile(ctx, gx, gy, COL.grass);
    }
    // roads
    H_ROADS.forEach(r => drawHRoad(ctx, r.y, r.x0, r.x1));
    V_ROADS.forEach(r => drawVRoad(ctx, r.x, r.y0, r.y1));
    H_STUBS.forEach(r => drawHRoad(ctx, r.y, r.x0, r.x1));
    V_STUBS.forEach(r => drawVRoad(ctx, r.x, r.y0, r.y1));
    // buildings + lake
    BUILDINGS.forEach(b => drawBuilding(ctx, b));
    drawLake(ctx);
    ctx.restore();
  }

  // Minimap/Big map overlays (use your map colors)
  function drawMiniOverlay() {
    if (!isTier2()) return;
    const mini = document.getElementById('minimap'); if (!mini) return;
    const mctx = mini.getContext('2d');
    const sx = mini.width / 90, sy = mini.height / 60;

    // base unlocked
    mctx.fillStyle = 'rgba(163,176,197,.25)'; mctx.fillRect(TIER2.x0*sx, TIER2.y0*sy, (TIER2.x1-TIER2.x0+1)*sx, (TIER2.y1-TIER2.y0+1)*sy);

    // roads (as 1-tile bands)
    mctx.fillStyle = COL.miniRoad;
    H_ROADS.concat(H_STUBS).forEach(r => mctx.fillRect(r.x0*sx, r.y*sy, (r.x1-r.x0+1)*sx, 1.4*sy));
    V_ROADS.concat(V_STUBS).forEach(r => mctx.fillRect(r.x*sx, r.y0*sy, 1.4*sx, (r.y1-r.y0+1)*sy));

    // buildings
    BUILDINGS.forEach(b => { mctx.fillStyle = b.color; mctx.fillRect(b.x*sx, b.y*sy, b.w*sx, b.h*sy); });

    // lake
    mctx.fillStyle = COL.miniLake;
    mctx.fillRect(LAKE.gx*sx, LAKE.gy*sy, LAKE.w*sx, LAKE.h*sy);
  }

  function drawBigOverlay() {
    if (!isTier2()) return;
    const big = document.getElementById('bigmap'); if (!big) return;
    const bctx = big.getContext('2d');
    const sx = big.width / 90, sy = big.height / 60;

    // base unlocked
    bctx.fillStyle = 'rgba(163,176,197,.25)'; bctx.fillRect(TIER2.x0*sx, TIER2.y0*sy, (TIER2.x1-TIER2.x0+1)*sx, (TIER2.y1-TIER2.y0+1)*sy);

    // roads
    bctx.fillStyle = COL.miniRoad;
    H_ROADS.concat(H_STUBS).forEach(r => bctx.fillRect(r.x0*sx, r.y*sy, (r.x1-r.x0+1)*sx, 1.6*sy));
    V_ROADS.concat(V_STUBS).forEach(r => bctx.fillRect(r.x*sx, r.y0*sy, 1.6*sx, (r.y1-r.y0+1)*sy));

    // buildings
    BUILDINGS.forEach(b => { bctx.fillStyle = b.color; bctx.fillRect(b.x*sx, b.y*sy, b.w*sx, b.h*sy); });

    // lake
    bctx.fillStyle = COL.miniLake;
    bctx.fillRect(LAKE.gx*sx, LAKE.gy*sy, LAKE.w*sx, LAKE.h*sy);
  }

  // === Hooks ===
  IZZA.on('ready', (a) => {
    api = a;

    state.tier = localStorage.getItem(MAP_TIER_KEY) || '1';
    if (isTier2()) widenCameraClampIfNeeded();

    // watch for tier flips while playing (Mission 3 completes)
    IZZA.on('update-post', () => {
      const cur = localStorage.getItem(MAP_TIER_KEY) || '1';
      if (cur !== state.tier) {
        state.tier = cur;
        if (isTier2()) widenCameraClampIfNeeded();
      }
      if (isTier2()) pushOutOfNewBuildings();
    });

    // redraw big map when opened
    const mapModal = document.getElementById('mapModal');
    if (mapModal) {
      const obs = new MutationObserver(() => {
        if (mapModal.style.display === 'flex') drawBigOverlay();
      });
      obs.observe(mapModal, { attributes: true, attributeFilter: ['style'] });
    }
  });

  // Paint overlays every frame so canvas & minimap stay in sync
  IZZA.on('render-post', () => {
    if (!isTier2()) return;
    drawMainOverlay();
    drawMiniOverlay();
  });
})();
