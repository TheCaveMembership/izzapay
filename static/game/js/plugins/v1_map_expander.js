// /static/game/js/plugins/v1_map_expander.js
(function () {
  const BUILD = 'v1.3-map-expander+tier2-district+minimap+bigmap+solid-buildings';
  console.log('[IZZA PLAY]', BUILD);

  // === Flags / bounds ===
  const MAP_TIER_KEY = 'izzaMapTier'; // '1' | '2'
  const TIER2 = { x0: 10, y0: 12, x1: 80, y1: 50 }; // your “bigger” box

  let api = null;
  const state = { tier: localStorage.getItem(MAP_TIER_KEY) || '1' };

  const isTier2 = () => state.tier === '2';

  // === Helpers ===
  const SCL = () => api.DRAW / api.TILE;
  const w2sX = (wx) => (wx - api.camera.x) * SCL();
  const w2sY = (wy) => (wy - api.camera.y) * SCL();

  // === District 2 layout (keeps your palette) ===
  // Roads are lines (centered), buildings are simple grid-aligned boxes.
  // Everything is expressed in GRID coords so it scales naturally.
  const roads = [
    // main horizontals
    { a: [14, 20], b: [76, 20] },
    { a: [14, 36], b: [76, 36] },
    // vertical spines
    { a: [28, 14], b: [28, 44] },
    { a: [52, 14], b: [52, 44] },
    // little connector + cul-de-sacs
    { a: [18, 20], b: [22, 20] },
    { a: [22, 20], b: [22, 24] },
    { a: [60, 20], b: [64, 20] },
    // bottom meander
    { a: [16, 44], b: [34, 44] },
    { a: [34, 44], b: [56, 44] },
    { a: [56, 44], b: [72, 44] }
  ];

  // Buildings (all solid)
  const buildings = [
    // HQ-ish red block
    { x: 41, y: 22, w: 4, h: 3, color: '#7a3a3a' },
    // blue civic
    { x: 55, y: 24, w: 4, h: 3, color: '#405a85' },
    { x: 36, y: 38, w: 3, h: 2, color: '#405a85' },
    // shop row
    { x: 20, y: 28, w: 2, h: 2, color: '#203a60' },
    { x: 24, y: 28, w: 2, h: 2, color: '#203a60' },
    { x: 28, y: 28, w: 2, h: 2, color: '#203a60' },
    // library (orange)
    { x: 64, y: 45, w: 4, h: 3, color: '#8a5a2b' },
    // police station (dark blue)
    { x: 48, y: 18, w: 3, h: 2, color: '#0a2455' },
    // toy shop (light blue)
    { x: 58, y: 34, w: 3, h: 2, color: '#4d7bd1' }
  ];

  // Soft lake shape (visual only)
  const lake = { cx: 66, cy: 43, rx: 1.6, ry: 1.1, color: '#2b6a7a' };

  // === Camera widening (don’t touch core) ===
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

  // === Collision for new buildings (push the player out) ===
  function pushOutOfSolids() {
    if (!isTier2()) return;
    const t = api.TILE;
    const px = api.player.x, py = api.player.y;
    const gx = (px / t) | 0, gy = (py / t) | 0;

    for (const b of buildings) {
      if (gx >= b.x && gx < b.x + b.w && gy >= b.y && gy < b.y + b.h) {
        // push to the nearest edge
        const cx = Math.min(Math.max(px, b.x * t), (b.x + b.w) * t);
        const cy = Math.min(Math.max(py, b.y * t), (b.y + b.h) * t);
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

  // === Painters (main canvas, minimap, big map) ===
  function drawRoadStroke(ctx, gx1, gy1, gx2, gy2, width) {
    const t = api.TILE;
    ctx.beginPath();
    ctx.moveTo(w2sX(gx1 * t + t / 2), w2sY(gy1 * t + t / 2));
    ctx.lineTo(w2sX(gx2 * t + t / 2), w2sY(gy2 * t + t / 2));
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#6a727b'; // matches your sidewalks/streets tone
    ctx.stroke();
  }

  function drawMainOverlay() {
    if (!isTier2()) return;
    const ctx = document.getElementById('game').getContext('2d');
    ctx.save();

    // roads (thicker so they read like your streets)
    const w = Math.max(3, api.DRAW * 0.35);
    roads.forEach(r => drawRoadStroke(ctx, r.a[0], r.a[1], r.b[0], r.b[1], w));

    // lake
    ctx.fillStyle = lake.color;
    ctx.beginPath();
    ctx.ellipse(
      w2sX(lake.cx * api.TILE),
      w2sY(lake.cy * api.TILE),
      api.DRAW * lake.rx,
      api.DRAW * lake.ry,
      0, 0, Math.PI * 2
    );
    ctx.fill();

    // buildings (exactly the same block look you already use)
    for (const b of buildings) {
      const sx = w2sX(b.x * api.TILE), sy = w2sY(b.y * api.TILE);
      const W = b.w * api.DRAW, H = b.h * api.DRAW;
      ctx.fillStyle = b.color;
      ctx.fillRect(sx, sy, W, H);
      ctx.fillStyle = 'rgba(0,0,0,.08)'; // subtle top shading like your HQ/Shop
      ctx.fillRect(sx, sy, W, Math.floor(H * 0.18));
    }

    ctx.restore();
  }

  function drawMiniOverlay() {
    if (!isTier2()) return;
    const mini = document.getElementById('minimap');
    const mctx = mini && mini.getContext ? mini.getContext('2d') : null;
    if (!mini || !mctx) return;
    const sx = mini.width / 90, sy = mini.height / 60;

    const line = (a, b) => {
      mctx.beginPath();
      mctx.moveTo(a[0] * sx, a[1] * sy);
      mctx.lineTo(b[0] * sx, b[1] * sy);
      mctx.lineWidth = Math.max(1, sx * 0.9);
      mctx.strokeStyle = '#8a90a0';
      mctx.stroke();
    };
    roads.forEach(r => line(r.a, r.b));

    // buildings
    buildings.forEach(b => {
      mctx.fillStyle = b.color;
      mctx.fillRect(b.x * sx, b.y * sy, b.w * sx, b.h * sy);
    });

    // lake
    mctx.fillStyle = '#7db7d9';
    mctx.beginPath();
    mctx.ellipse(66 * sx, 43 * sy, 1.6 * sx * 3, 1.1 * sy * 3, 0, 0, Math.PI * 2); // scaled visually
    mctx.fill();
  }

  function drawBigOverlay() {
    if (!isTier2()) return;
    const big = document.getElementById('bigmap');
    const bctx = big && big.getContext ? big.getContext('2d') : null;
    if (!big || !bctx) return;

    const sx = big.width / 90, sy = big.height / 60;

    const line = (a, b) => {
      bctx.beginPath();
      bctx.moveTo(a[0] * sx, a[1] * sy);
      bctx.lineTo(b[0] * sx, b[1] * sy);
      bctx.lineWidth = Math.max(2, sx * 1.2);
      bctx.strokeStyle = '#8a90a0';
      bctx.stroke();
    };
    roads.forEach(r => line(r.a, r.b));

    buildings.forEach(b => {
      bctx.fillStyle = b.color;
      bctx.fillRect(b.x * sx, b.y * sy, b.w * sx, b.h * sy);
    });

    bctx.fillStyle = '#7db7d9';
    bctx.beginPath();
    bctx.ellipse(66 * sx, 43 * sy, 1.6 * sx * 6, 1.1 * sy * 6, 0, 0, Math.PI * 2);
    bctx.fill();
  }

  // === Hooks ===
  IZZA.on('ready', (a) => {
    api = a;

    // If M3 already flipped the flag, adopt it now
    state.tier = localStorage.getItem(MAP_TIER_KEY) || '1';
    if (isTier2()) widenCameraClampIfNeeded();

    // Re-check the tier continuously (when M3 completes it flips mid-session)
    IZZA.on('update-post', () => {
      const cur = localStorage.getItem(MAP_TIER_KEY) || '1';
      if (cur !== state.tier) {
        state.tier = cur;
        if (isTier2()) widenCameraClampIfNeeded();
      }
      if (isTier2()) pushOutOfSolids();
    });

    // When the big map is open, paint the overlay there too
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
    // big map overlay is drawn when the modal opens (and will be redrawn again by the observer)
  });
})();
