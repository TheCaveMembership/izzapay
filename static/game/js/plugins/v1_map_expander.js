// /static/game/js/plugins/v1_map_expander.js
(function () {
  const BUILD = 'v2.0-map-expander+tiles+variants+ui+minimap+bigmap+collisions';
  console.log('[IZZA PLAY]', BUILD);

  // ===== Flags / storage =====
  const MAP_TIER_KEY = 'izzaMapTier';        // '1' | '2'
  const LAYOUT_KEY   = 'izzaTier2Layout';    // 'east' | 'downtown' | 'weave'

  // Tier-2 bounds (bigger play box — matches your sketch proportions)
  const TIER2 = { x0: 10, y0: 12, x1: 80, y1: 50 };

  // Colors that match your core renderer
  const COL = {
    grass:    '#09371c',
    road:     '#2a2a2a',
    dash:     '#ffd23f',
    sidewalk: '#6a727b',
    hq:       '#4a2d2d',
    shop:     '#203a60',
    civic:    '#405a85',
    police:   '#0a2455',
    library:  '#8a5a2b',
    red:      '#7a3a3a',
    water:    '#2b6a7a'
  };

  let api = null;
  const state = {
    tier: localStorage.getItem(MAP_TIER_KEY) || '1',
    layoutId: localStorage.getItem(LAYOUT_KEY) || 'east',   // default
    liveLayoutId: null                                      // previewing
  };

  const isTier2 = () => state.tier === '2';
  const activeLayoutId = () => state.liveLayoutId || state.layoutId;

  // ======= Layouts (all in grid coords) =======
  // Each layout declares roads as tile ranges and buildings as solid blocks.
  // Sidewalks are auto-added around every road (like your core: ±1 tile).
  //
  // Notation:
  //  H_ROADS: { y, x0, x1 }  e.g. one row of road tiles from x0..x1 at row y
  //  V_ROADS: { x, y0, y1 }  e.g. one column of road tiles from y0..y1 at col x
  //  BUILDINGS: { x, y, w, h, color }
  //  LAKES: optional array of { x, y, w, h } rectangles (visual only)
  //
  // Feel free to tweak numbers — they’re all easy to read.
  const LAYOUTS = {
    // 1) EAST GRID — clean city grid with a few blocks and a park lake
    east: {
      name: 'East Grid',
      H_ROADS: [
        { y: 20, x0: 14, x1: 76 },
        { y: 28, x0: 18, x1: 44 },
        { y: 36, x0: 14, x1: 76 },
        { y: 44, x0: 16, x1: 72 }
      ],
      V_ROADS: [
        { x: 22, y0: 18, y1: 36 },
        { x: 28, y0: 14, y1: 44 },
        { x: 52, y0: 14, y1: 44 },
        { x: 70, y0: 18, y1: 44 }
      ],
      BUILDINGS: [
        { x: 41, y: 22, w: 4, h: 3, color: COL.red },      // central red
        { x: 55, y: 24, w: 4, h: 3, color: COL.civic },    // big blue
        { x: 36, y: 38, w: 3, h: 2, color: COL.civic },    // blue south
        { x: 20, y: 29, w: 2, h: 2, color: COL.shop },     // shop row
        { x: 24, y: 29, w: 2, h: 2, color: COL.shop },
        { x: 28, y: 29, w: 2, h: 2, color: COL.shop },
        { x: 64, y: 45, w: 4, h: 3, color: COL.library },  // library
        { x: 48, y: 18, w: 3, h: 2, color: COL.police }    // police
      ],
      LAKES: [ { x: 66, y: 43, w: 5, h: 3 } ]
    },

    // 2) DOWNTOWN — denser “inner city” feel; shorter blocks, tighter grid
    downtown: {
      name: 'Downtown',
      H_ROADS: [
        { y: 18, x0: 18, x1: 76 },
        { y: 24, x0: 18, x1: 76 },
        { y: 30, x0: 18, x1: 76 },
        { y: 36, x0: 18, x1: 76 },
        { y: 42, x0: 18, x1: 76 }
      ],
      V_ROADS: [
        { x: 22, y0: 16, y1: 46 },
        { x: 30, y0: 16, y1: 46 },
        { x: 38, y0: 16, y1: 46 },
        { x: 46, y0: 16, y1: 46 },
        { x: 58, y0: 16, y1: 46 },
        { x: 70, y0: 16, y1: 46 }
      ],
      BUILDINGS: [
        // broad downtown slabs
        { x: 23, y: 19, w: 6, h: 4, color: COL.red },
        { x: 31, y: 19, w: 6, h: 4, color: COL.civic },
        { x: 39, y: 19, w: 6, h: 4, color: COL.shop },
        { x: 47, y: 19, w: 10, h: 4, color: COL.red },
        { x: 59, y: 19, w: 10, h: 4, color: COL.civic },

        { x: 23, y: 25, w: 6, h: 4, color: COL.shop },
        { x: 31, y: 25, w: 6, h: 4, color: COL.civic },
        { x: 39, y: 25, w: 6, h: 4, color: COL.shop },
        { x: 47, y: 25, w: 10, h: 4, color: COL.red },
        { x: 59, y: 25, w: 10, h: 4, color: COL.civic },

        // police + library standouts
        { x: 58, y: 37, w: 4, h: 3, color: COL.police },
        { x: 66, y: 37, w: 5, h: 3, color: COL.library }
      ],
      LAKES: []
    },

    // 3) WEAVE — long east-west spines with a few loops
    weave: {
      name: 'Weave Loops',
      H_ROADS: [
        { y: 20, x0: 14, x1: 76 },
        { y: 26, x0: 14, x1: 60 },
        { y: 36, x0: 18, x1: 76 },
        { y: 44, x0: 16, x1: 72 }
      ],
      V_ROADS: [
        { x: 28, y0: 14, y1: 44 },
        { x: 42, y0: 22, y1: 46 },
        { x: 52, y0: 14, y1: 36 },
        { x: 70, y0: 18, y1: 44 }
      ],
      BUILDINGS: [
        { x: 41, y: 22, w: 4, h: 3, color: COL.red },
        { x: 22, y: 31, w: 3, h: 2, color: COL.shop },
        { x: 26, y: 31, w: 3, h: 2, color: COL.shop },
        { x: 48, y: 18, w: 3, h: 2, color: COL.police },
        { x: 55, y: 30, w: 4, h: 3, color: COL.civic },
        { x: 64, y: 45, w: 4, h: 3, color: COL.library }
      ],
      LAKES: [ { x: 62, y: 41, w: 8, h: 4 } ]
    }
  };

  // ======== Helpers / geometry ========
  const scl = () => api.DRAW / api.TILE;
  const w2sX = (wx) => (wx - api.camera.x) * scl();
  const w2sY = (wy) => (wy - api.camera.y) * scl();

  function fillTile(ctx, gx, gy, color) {
    const sx = w2sX(gx * api.TILE), sy = w2sY(gy * api.TILE);
    const S = api.DRAW;
    ctx.fillStyle = color;
    ctx.fillRect(sx, sy, S, S);
  }

  // Draw a horizontal road tile-by-tile (with lane dashes).
  function drawHRoad(ctx, y, x0, x1) {
    for (let x = x0; x <= x1; x++) {
      fillTile(ctx, x, y, COL.road);
      // lane dashes like the core: 4 small yellow rects per tile
      const sx = w2sX(x * api.TILE), sy = w2sY(y * api.TILE), S = api.DRAW;
      ctx.fillStyle = COL.dash;
      for (let i = 0; i < 4; i++) {
        ctx.fillRect(sx + i * (S / 4) + S * 0.05, sy + S * 0.48, S * 0.10, S * 0.04);
      }
    }
  }
  function drawVRoad(ctx, x, y0, y1) {
    for (let y = y0; y <= y1; y++) {
      fillTile(ctx, x, y, COL.road);
    }
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
    // subtle top shade (same style as HQ/Shop)
    const sx = w2sX(b.x * api.TILE), sy = w2sY(b.y * api.TILE);
    ctx.fillStyle = 'rgba(0,0,0,.15)';
    ctx.fillRect(sx, sy, b.w * api.DRAW, Math.floor(b.h * api.DRAW * 0.18));
  }
  function drawLake(ctx, r) {
    if (!r) return;
    ctx.fillStyle = COL.water;
    const sx = w2sX(r.x * api.TILE), sy = w2sY(r.y * api.TILE);
    ctx.fillRect(sx, sy, r.w * api.DRAW, r.h * api.DRAW);
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

  // Push player out of NEW buildings only (roads stay walk/drivable)
  function pushOutOfSolids() {
    if (!isTier2()) return;
    const layout = LAYOUTS[activeLayoutId()];
    if (!layout) return;

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

  // ======= Painting (main canvas) =======
  function drawMainOverlay() {
    if (!isTier2()) return;
    const layout = LAYOUTS[activeLayoutId()];
    if (!layout) return;
    const ctx = document.getElementById('game').getContext('2d');

    ctx.save();
    // draw BEHIND core sprites so player/cars/peds are on top
    ctx.globalCompositeOperation = 'destination-over';

    // base grass for the entire new district (keeps look consistent)
    for (let gy = TIER2.y0; gy <= TIER2.y1; gy++) {
      for (let gx = TIER2.x0; gx <= TIER2.x1; gx++) fillTile(ctx, gx, gy, COL.grass);
    }

    // sidewalks around each road (±1 tile like your core)
    layout.H_ROADS.forEach(r => {
      drawSidewalkRow(ctx, r.y - 1, r.x0, r.x1);
      drawSidewalkRow(ctx, r.y + 1, r.x0, r.x1);
    });
    layout.V_ROADS.forEach(r => {
      drawSidewalkCol(ctx, r.x - 1, r.y0, r.y1);
      drawSidewalkCol(ctx, r.x + 1, r.y0, r.y1);
    });

    // the roads themselves
    layout.H_ROADS.forEach(r => drawHRoad(ctx, r.y, r.x0, r.x1));
    layout.V_ROADS.forEach(r => drawVRoad(ctx, r.x, r.y0, r.y1));

    // buildings (solid) + lake(s)
    layout.BUILDINGS.forEach(b => drawBuilding(ctx, b));
    (layout.LAKES || []).forEach(l => drawLake(ctx, l));

    ctx.restore();
  }

  // ======= Minimap & Bigmap painters =======
  function drawMiniOverlay() {
    if (!isTier2()) return;
    const layout = LAYOUTS[activeLayoutId()];
    if (!layout) return;
    const mini = document.getElementById('minimap');
    const ctx = mini && mini.getContext ? mini.getContext('2d') : null;
    if (!mini || !ctx) return;

    const sx = mini.width / 90, sy = mini.height / 60;

    // roads
    ctx.save();
    ctx.fillStyle = '#8a90a0';
    layout.H_ROADS.forEach(r => ctx.fillRect(r.x0 * sx, r.y * sy, (r.x1 - r.x0 + 1) * sx, 1 * sy));
    layout.V_ROADS.forEach(r => ctx.fillRect(r.x * sx, r.y0 * sy, 1 * sx, (r.y1 - r.y0 + 1) * sy));
    ctx.restore();

    // buildings
    layout.BUILDINGS.forEach(b => {
      ctx.fillStyle = b.color;
      ctx.fillRect(b.x * sx, b.y * sy, b.w * sx, b.h * sy);
    });

    // lakes
    (layout.LAKES || []).forEach(l => {
      ctx.fillStyle = '#7db7d9';
      ctx.fillRect(l.x * sx, l.y * sy, l.w * sx, l.h * sy);
    });
  }

  function drawBigOverlay() {
    if (!isTier2()) return;
    const layout = LAYOUTS[activeLayoutId()];
    if (!layout) return;
    const big = document.getElementById('bigmap');
    const ctx = big && big.getContext ? big.getContext('2d') : null;
    if (!big || !ctx) return;

    const sx = big.width / 90, sy = big.height / 60;

    ctx.save();
    // roads
    ctx.fillStyle = '#8a90a0';
    layout.H_ROADS.forEach(r => ctx.fillRect(r.x0 * sx, r.y * sy, (r.x1 - r.x0 + 1) * sx, 1.2 * sy));
    layout.V_ROADS.forEach(r => ctx.fillRect(r.x * sx, r.y0 * sy, 1.2 * sx, (r.y1 - r.y0 + 1) * sy));
    // buildings
    layout.BUILDINGS.forEach(b => {
      ctx.fillStyle = b.color;
      ctx.fillRect(b.x * sx, b.y * sy, b.w * sx, b.h * sy);
    });
    // lakes
    (layout.LAKES || []).forEach(l => {
      ctx.fillStyle = '#7db7d9';
      ctx.fillRect(l.x * sx, l.y * sy, l.w * sx, l.h * sy);
    });
    ctx.restore();
  }

  // ======= Tiny UI: cycle variants + Save =======
  function ensureVariantUI() {
    if (document.getElementById('tier2LayoutUI')) return;
    const wrap = document.createElement('div');
    wrap.id = 'tier2LayoutUI';
    Object.assign(wrap.style, {
      position: 'fixed', right: '18px', bottom: '170px', zIndex: 14,
      display: 'none',
      background: 'rgba(10,12,18,.88)', border: '1px solid #2a3550',
      padding: '8px', borderRadius: '12px', color: '#cfe0ff', fontSize: '12px',
      boxShadow: '0 4px 14px rgba(0,0,0,.35)'
    });
    wrap.innerHTML = `
      <div style="display:flex; gap:6px; align-items:center">
        <button id="t2Prev" class="ghost" style="padding:6px 8px">◀</button>
        <div id="t2Label" style="min-width:110px; text-align:center"></div>
        <button id="t2Next" class="ghost" style="padding:6px 8px">▶</button>
      </div>
      <div style="margin-top:6px; display:flex; gap:6px; justify-content:space-between">
        <button id="t2Save" style="padding:6px 10px">Save</button>
        <button id="t2Close" class="ghost" style="padding:6px 10px">Close</button>
      </div>
    `;
    document.body.appendChild(wrap);

    const ids = Object.keys(LAYOUTS);
    const label = () => {
      const id = activeLayoutId();
      document.getElementById('t2Label').textContent = LAYOUTS[id].name;
    };
    const show = (on) => { wrap.style.display = on ? 'block' : 'none'; };

    function setLive(id) {
      state.liveLayoutId = id;
      label();
    }

    document.getElementById('t2Prev').addEventListener('click', () => {
      const id = activeLayoutId();
      const i = ids.indexOf(id);
      setLive(ids[(i - 1 + ids.length) % ids.length]);
    });
    document.getElementById('t2Next').addEventListener('click', () => {
      const id = activeLayoutId();
      const i = ids.indexOf(id);
      setLive(ids[(i + 1) % ids.length]);
    });
    document.getElementById('t2Save').addEventListener('click', () => {
      state.layoutId = activeLayoutId();
      state.liveLayoutId = null; // lock in
      localStorage.setItem(LAYOUT_KEY, state.layoutId);
      // tiny toast
      let h = document.getElementById('tutHint');
      if (!h) {
        h = document.createElement('div'); h.id = 'tutHint';
        Object.assign(h.style, {
          position:'fixed', left:'12px', top:'64px', zIndex:15,
          background:'rgba(10,12,18,.88)', border:'1px solid #394769',
          color:'#cfe0ff', padding:'8px 10px', borderRadius:'10px', fontSize:'14px'
        });
        document.body.appendChild(h);
      }
      h.textContent = `Saved: ${LAYOUTS[state.layoutId].name}`;
      h.style.display = 'block';
      setTimeout(()=>{ h.style.display = 'none'; }, 1600);
    });
    document.getElementById('t2Close').addEventListener('click', () => show(false));

    // expose a tiny toggle button near the minimap
    if (!document.getElementById('t2Open')) {
      const b = document.createElement('button');
      b.id = 't2Open';
      b.textContent = 'Map Options';
      Object.assign(b.style, {
        position:'fixed', right:'18px', bottom:'120px', zIndex:13,
        fontSize:'12px', padding:'6px 10px', opacity:.92
      });
      b.addEventListener('click', () => show(wrap.style.display !== 'block'));
      document.body.appendChild(b);
    }

    // show if we are already in Tier 2
    wrap.style.display = isTier2() ? 'block' : 'none';
    label();
  }

  // ======= Hooks =======
  IZZA.on('ready', (a) => {
    api = a;

    // adopt tier now, and patch camera if needed
    state.tier = localStorage.getItem(MAP_TIER_KEY) || '1';
    if (isTier2()) widenCameraClampIfNeeded();

    // UI (appears only in Tier 2)
    ensureVariantUI();

    // if map modal opens, also paint big overlay
    const mapModal = document.getElementById('mapModal');
    if (mapModal) {
      const obs = new MutationObserver(() => {
        if (mapModal.style.display === 'flex') drawBigOverlay();
      });
      obs.observe(mapModal, { attributes: true, attributeFilter: ['style'] });
    }
  });

  // keep tier/layout up to date & apply soft collisions
  IZZA.on('update-post', () => {
    const curTier = localStorage.getItem(MAP_TIER_KEY) || '1';
    if (curTier !== state.tier) {
      state.tier = curTier;
      if (isTier2()) widenCameraClampIfNeeded();
      // show UI only in Tier 2
      const ui = document.getElementById('tier2LayoutUI');
      if (ui) ui.style.display = isTier2() ? 'block' : 'none';
    }
    if (isTier2()) pushOutOfSolids();
  });

  // paint overlays every frame (main + mini); big map is painted when opened
  IZZA.on('render-post', () => {
    if (!isTier2()) return;
    drawMainOverlay();
    drawMiniOverlay();
  });
})();
