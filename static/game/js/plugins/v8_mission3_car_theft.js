// /static/game/js/plugins/v8_mission3_car_theft.js
(function () {
  const BUILD = 'v8.3-mission3-car-theft+drive-with-joystick+edge-complete';
  console.log('[IZZA PLAY]', BUILD);

  // --- config / LS keys ---
  const START_KEY  = 'izzaMission3';   // 'ready' | 'active' | 'done'
  const POS_KEY    = 'izzaMission3Pos';// {gx,gy} anchor of blue square (spawned after M2)
  const BUBBLE_ID  = 'm3Bubble';

  // appear 8 tiles LEFT of door (your ask)
  const DEFAULT_OFFSET = { dx: -8, dy: 0 };

  // --- locals/state ---
  let api = null;
  const m3 = {
    state: localStorage.getItem(START_KEY) || 'ready', // ready|active|done
    goal: { gx: 0, gy: 0 },
    driving: false,
    car: null,          // {w,h} pseudo-car we render while driving (we detach actual car from traffic)
  };
  window._izza_m3 = m3; // handy for debugging

  // ------------ tiny UI helpers ------------
  function toast(msg, seconds = 2.4) {
    let h = document.getElementById('tutHint');
    if (!h) {
      h = document.createElement('div');
      h.id = 'tutHint';
      Object.assign(h.style, {
        position: 'fixed', left: '12px', top: '64px', zIndex: 9,
        background: 'rgba(10,12,18,.88)', border: '1px solid #394769',
        color: '#cfe0ff', padding: '8px 10px', borderRadius: '10px', fontSize: '14px',
        maxWidth: '70vw'
      });
      document.body.appendChild(h);
    }
    h.textContent = msg; h.style.display = 'block';
    clearTimeout(h._t);
    h._t = setTimeout(() => { h.style.display = 'none'; }, seconds * 1000);
  }
  function ensureBubble() {
    let b = document.getElementById(BUBBLE_ID);
    if (!b) {
      b = document.createElement('div');
      b.id = BUBBLE_ID;
      Object.assign(b.style, {
        position: 'fixed', right: '18px', top: '98px', zIndex: 8,
        background: 'rgba(7,12,22,.85)', color: '#cfe0ff',
        border: '1px solid #2f3b58', borderRadius: '18px',
        padding: '6px 10px', fontSize: '12px', pointerEvents: 'none'
      });
      document.body.appendChild(b);
    }
    return b;
  }
  function showHintBubble(txt) { const b = ensureBubble(); b.textContent = txt; b.style.display = 'block'; }
  function hideHintBubble() { const b = document.getElementById(BUBBLE_ID); if (b) b.style.display = 'none'; }

  // ------------ grid helpers ------------
  function playerGrid() {
    const t = api.TILE;
    return {
      gx: Math.floor((api.player.x + t / 2) / t),
      gy: Math.floor((api.player.y + t / 2) / t)
    };
  }
  function manhattan(a, b, c, d) { return Math.abs(a - c) + Math.abs(b - d); }

  // ------------ mission anchor (blue square) ------------
  function loadGoal() {
    // saved
    const saved = localStorage.getItem(POS_KEY);
    if (saved) {
      try {
        const j = JSON.parse(saved);
        if (Number.isFinite(j.gx) && Number.isFinite(j.gy)) { m3.goal.gx = j.gx | 0; m3.goal.gy = j.gy | 0; return; }
      } catch { }
    }
    // default from door spawn
    const t = api.TILE, ds = api.doorSpawn;
    const doorGX = Math.floor((ds.x + 8) / t);
    const doorGY = Math.floor(ds.y / t);
    m3.goal.gx = doorGX + DEFAULT_OFFSET.dx;
    m3.goal.gy = doorGY + DEFAULT_OFFSET.dy;
    localStorage.setItem(POS_KEY, JSON.stringify(m3.goal));
  }

  // allow moving goal quickly via console (like Mission 2 tool you used)
  window._izza_m3_setAtPlayer = function () {
    const g = playerGrid();
    m3.goal = { gx: g.gx, gy: g.gy };
    localStorage.setItem(POS_KEY, JSON.stringify(m3.goal));
    toast(`Mission 3 anchor set to ${g.gx},${g.gy}`);
  };

  // ------------ drawing ------------
  function w2sX(wx) { return (wx - api.camera.x) * (api.DRAW / api.TILE); }
  function w2sY(wy) { return (wy - api.camera.y) * (api.DRAW / api.TILE); }

  function drawGoal() {
    if (m3.state === 'done') return;
    const S = api.DRAW, t = api.TILE;
    const sx = w2sX(m3.goal.gx * t), sy = w2sY(m3.goal.gy * t);
    const ctx = document.getElementById('game').getContext('2d');
    ctx.save();
    ctx.fillStyle = 'rgba(70,140,255,.75)';
    ctx.fillRect(sx + S * 0.15, sy + S * 0.15, S * 0.70, S * 0.70);
    ctx.restore();
  }

  // draw the “car” over the player while driving so it looks like you’re inside it
  function drawDrivenCar() {
    if (!m3.driving) return;
    const ctx = document.getElementById('game').getContext('2d');
    const S = api.DRAW;
    const sx = w2sX(api.player.x), sy = w2sY(api.player.y);
    ctx.save();
    ctx.fillStyle = '#c0c8d8';
    ctx.fillRect(sx + S * 0.10, sy + S * 0.25, S * 0.80, S * 0.50);
    // simple windshield hint
    ctx.fillStyle = 'rgba(255,255,255,.2)';
    ctx.fillRect(sx + S * 0.55, sy + S * 0.28, S * 0.32, S * 0.20);
    ctx.restore();
  }

  // ------------ mission state ------------
  function getMissions() { return (api && api.getMissionCount) ? api.getMissionCount() : 0; }
  function setMission3Done() {
    localStorage.setItem(START_KEY, 'done');
    m3.state = 'done';
    // bump global mission count to >=3
    try {
      const cur = getMissions();
      const next = Math.max(cur, 3);
      localStorage.setItem('izzaMissions', String(next));
    } catch { }
  }

  function startMission() {
    m3.state = 'active';
    localStorage.setItem(START_KEY, 'active');
    showHintBubble('Mission 3: Steal a car (B near a passing car). Drive it to the map edge.');
    toast('Mission 3 started!');
  }

  function completeMission() {
    m3.driving = false; m3.car = null;
    hideHintBubble();
    setMission3Done();

    // unlock bigger map & firearms equip
    localStorage.setItem('izzaMapTier', '2');
    toast('Mission 3 complete! New district unlocked. Pistols can now be equipped.', 4);
  }

  // ------------ interaction ------------
  function nearGoal() {
    const g = playerGrid();
    return manhattan(g.gx, g.gy, m3.goal.gx, m3.goal.gy) <= 1;
  }

  function takeOverNearestCar() {
    if (!api || !api.cars || !api.cars.length) return false;
    // find the closest car on screen
    let best = null, bestD = 9999;
    for (const c of api.cars) {
      const d = Math.hypot(api.player.x - c.x, api.player.y - c.y);
      if (d < bestD) { bestD = d; best = c; }
    }
    if (!best || bestD > 38) return false; // must be pretty close
    // remove from traffic; we will render a proxy car following the player
    const idx = api.cars.indexOf(best);
    if (idx >= 0) api.cars.splice(idx, 1);
    m3.driving = true;
    m3.car = { takenFrom: best };
    showHintBubble('Driving… Reach the black border to complete.');
    toast('Car hijacked!');
    return true;
  }

  // At the unlocked border?
  function atUnlockedEdge() {
    // Using the core’s unlocked rect via camera clamps is private, so derive from minimap/position:
    // Success if any neighbor tile is outside the visible unlocked area (drawn as black).
    const t = api.TILE;
    const gx = Math.floor((api.player.x + t / 2) / t);
    const gy = Math.floor((api.player.y + t / 2) / t);

    // reconstruct unlocked rect from minimap math used by core (export not provided),
    // but we can infer by testing the camera clamps; however simplest is to probe by
    // asking core to drawTile? Not available. So approximate by checking clamping to map bounds:
    // Instead, rely on player camera clamps: when close to edges, going further is blocked by collision
    // but we can detect “black neighbor” by sampling 1 tile out of bounds using the same building rules
    // exposed via solids on your current core: outside unlocked is treated solid — so look 1 tile away
    function isSolid(gx, gy) {
      // mirror your buildings: HQ + Shop solids + out-of-unlocked (solid); expose minimal from API:
      // We can’t call core’s isSolid, so treat outside the 90x60 map as solid too.
      if (gx < 0 || gy < 0 || gx >= 90 || gy >= 60) return true;
      // A cheap proxy for “outside unlocked”: use camera bounds: when the screen tries to scroll past,
      // camera clamps to unlocked rect. We can infer unlocked bounds from camera & canvas size,
      // but that varies with device. Simpler: just treat border as: gx<=api.camera.x/TILE etc. — noisy.
      // -> NEW plan: mission succeeds when the *screen* shows pure black adjacent tile under the player.
      // Implemented more simply below in render hook (see _sawBlackUnderFeet flag).
      return false;
    }
    return false;
  }

  // We’ll detect the black border in render-pass by peeking the tile under a tiny offset;
  // it’s robust because your core paints the black area first.
  let _sawBlackUnderFeet = false;

  // ------------ input hook for B ------------
  function onB() {
    if (m3.state === 'done') return;

    if (nearGoal()) {
      // Only after mission 2 is done
      if (getMissions() < 2) { toast('Complete Mission 2 first.'); return; }
      if (m3.state === 'ready') { startMission(); return; }
    }

    if (m3.state === 'active') {
      if (!m3.driving) {
        // try hijack
        takeOverNearestCar();
      }
      // If already driving and we’re touching black border, finishing will happen in update
    }
  }

  function bindB() {
    window.addEventListener('keydown', (e) => {
      if (e.key && e.key.toLowerCase() === 'b') onB();
    });
    const btn = document.getElementById('btnB');
    if (btn) btn.addEventListener('click', onB);
  }

  // ------------ hooks ------------
  IZZA.on('ready', (a) => {
    api = a;
    loadGoal();
    bindB();
    console.log('[M3] ready', { state: m3.state, goal: m3.goal });
  });

  // While driving, we let core move the player with the joystick as usual.
  // We just watch for completion (touching the black area).
  IZZA.on('update-post', () => {
    if (m3.state !== 'active') return;

    if (m3.driving) {
      showHintBubble('Driving… Reach the black border');
      if (_sawBlackUnderFeet) {
        completeMission();
      }
    }
  });

  // Draw goal + the car overlay, and detect black under feet
  IZZA.on('render-post', () => {
    if (m3.state !== 'done') drawGoal();

    // peek pixel under player to see if it’s black (map border)
    const cvs = document.getElementById('game');
    const ctx = cvs.getContext('2d');
    const px = Math.floor(w2sX(api.player.x + api.DRAW * 0.5));
    const py = Math.floor(w2sY(api.player.y + api.DRAW * 0.9)); // bottom of sprite (safer for border)
    const data = ctx.getImageData(Math.max(0, Math.min(px, cvs.width - 1)), Math.max(0, Math.min(py, cvs.height - 1)), 1, 1).data;
    _sawBlackUnderFeet = (data[0] < 6 && data[1] < 6 && data[2] < 6); // very dark

    drawDrivenCar();
  });

})();
