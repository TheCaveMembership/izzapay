// /static/game/js/plugins/v8_mission3_car_theft.js
(function () {
  const BUILD = 'v8.4-m3-car-theft+driveable+gold-exit+map-expand';
  console.log('[IZZA PLAY]', BUILD);

  // -------- config
  const M3_KEY        = 'izzaMission3';            // 'ready' | 'active' | 'done'
  const EXIT_POS_KEY  = 'izzaMission3Exit';        // {gx,gy}
  const EXIT_GLOW_ID  = 'm3ExitGlow';
  const CAR_SPEED     = 120;                       // match core NPC car speed
  const GOAL_TOAST    = 'Drive into the glowing edge to escape!';
  const UNLOCK_TOAST  = 'Mission 3 complete! Map expanded and pistols unlocked to equip.';

  // Default exit: right edge, on the horizontal road row
  // You can override via window.__IZZA_M3_EXIT__ = {gx,gy} or LS 'izzaMission3Exit'
  function defaultExit(api) {
    const gx = api ? Math.max(api.doorSpawn.x / api.TILE | 0, 0) : 50; // not really used
    // Better default: right boundary of current unlocked area, on the main road row
    const right = Math.floor((api.camera.x + (api.DRAW / (api.DRAW / api.TILE)) * 9999) / api.TILE); // dummy
    // Use world layout from core that’s stable:
    //   unlocked.x1 is not directly exposed, but the main road gy is derivable from doorSpawn:
    // doorSpawn is on top sidewalk; core sets horizontal road at (door.gy + 1)
    const doorGy = Math.floor(api.doorSpawn.y / api.TILE);
    const hRoadY = doorGy + 1;
    // We can approximate the right edge with a generous value; collision will clamp correctly.
    return { gx: 72, gy: hRoadY };
  }

  // -------- state
  let api = null;
  const m3 = {
    state: localStorage.getItem(M3_KEY) || 'ready',   // ready | active | done
    inCar: false,
    exitGX: 0,
    exitGY: 0
  };
  window._izza_m3 = m3; // handy for debugging

  // -------- utilities
  const now = () => performance.now();
  function toast(msg, seconds = 2.8) {
    let h = document.getElementById('tutHint');
    if (!h) {
      h = document.createElement('div');
      h.id = 'tutHint';
      Object.assign(h.style, {
        position: 'fixed', left: '12px', top: '64px', zIndex: 9,
        background: 'rgba(10,12,18,.88)', border: '1px solid #394769',
        color: '#cfe0ff', padding: '8px 10px', borderRadius: '10px',
        fontSize: '14px', maxWidth: '70vw'
      });
      document.body.appendChild(h);
    }
    h.textContent = msg; h.style.display = 'block';
    clearTimeout(h._t);
    h._t = setTimeout(() => { h.style.display = 'none'; }, seconds * 1000);
  }
  function playerGrid() {
    const t = api.TILE;
    return {
      gx: Math.floor((api.player.x + t / 2) / t),
      gy: Math.floor((api.player.y + t / 2) / t)
    };
  }
  function distMan(a, b, c, d) { return Math.abs(a - c) + Math.abs(b - d); }

  // -------- exit placement
  function loadExitPos() {
    // 1) explicit runtime override
    if (window.__IZZA_M3_EXIT__
      && Number.isFinite(window.__IZZA_M3_EXIT__.gx)
      && Number.isFinite(window.__IZZA_M3_EXIT__.gy)) {
      m3.exitGX = window.__IZZA_M3_EXIT__.gx | 0;
      m3.exitGY = window.__IZZA_M3_EXIT__.gy | 0;
      localStorage.setItem(EXIT_POS_KEY, JSON.stringify({ gx: m3.exitGX, gy: m3.exitGY }));
      return;
    }
    // 2) saved
    const saved = localStorage.getItem(EXIT_POS_KEY);
    if (saved) {
      try {
        const j = JSON.parse(saved);
        if (Number.isFinite(j.gx) && Number.isFinite(j.gy)) {
          m3.exitGX = j.gx | 0;
          m3.exitGY = j.gy | 0;
          return;
        }
      } catch { }
    }
    // 3) default based on core layout
    const d = defaultExit(api);
    m3.exitGX = d.gx; m3.exitGY = d.gy;
    localStorage.setItem(EXIT_POS_KEY, JSON.stringify({ gx: m3.exitGX, gy: m3.exitGY }));
  }

  // Quick helper if you want to drop the exit where you stand:
  //   _izza_m3_setExitHere()
  window._izza_m3_setExitHere = function () {
    const { gx, gy } = playerGrid();
    m3.exitGX = gx; m3.exitGY = gy;
    localStorage.setItem(EXIT_POS_KEY, JSON.stringify({ gx, gy }));
    toast(`M3 exit set to ${gx},${gy}`);
  };

  // -------- gold glow drawing
  function w2sX(wx) { return (wx - api.camera.x) * (api.DRAW / api.TILE); }
  function w2sY(wy) { return (wy - api.camera.y) * (api.DRAW / api.TILE); }

  function drawExitGlow() {
    if (m3.state === 'done') return;
    // Show exit glow only while active & in-car (motivates the objective)
    if (!(m3.state === 'active' && m3.inCar)) return;

    const t = api.TILE, S = api.DRAW;
    const sx = w2sX(m3.exitGX * t), sy = w2sY(m3.exitGY * t);
    const ctx = document.getElementById('game').getContext('2d');

    // pulsing gold glow
    const pulse = 0.65 + 0.35 * Math.sin(now() / 220);
    ctx.save();
    ctx.fillStyle = `rgba(255, 208, 86, ${0.45 + 0.35 * pulse})`;
    ctx.fillRect(sx + S * 0.1, sy + S * 0.1, S * 0.8, S * 0.8);
    ctx.strokeStyle = `rgba(255, 235, 150, ${0.8})`;
    ctx.lineWidth = 2;
    ctx.strokeRect(sx + S * 0.12, sy + S * 0.12, S * 0.76, S * 0.76);
    ctx.restore();
  }

  // -------- hijack & driving
  function nearAnyCar() {
    if (!api.cars || !api.cars.length) return null;
    const px = api.player.x, py = api.player.y;
    let best = null, bestD = 9999;
    for (const c of api.cars) {
      const d = Math.hypot(px - c.x, py - c.y);
      if (d < 34 && d < bestD) { best = c; bestD = d; }
    }
    return best;
  }

  function startM3IfNeeded() {
    if (m3.state === 'ready') {
      m3.state = 'active';
      localStorage.setItem(M3_KEY, 'active');
      toast('Mission 3: Steal a car.');
    }
  }

  function enterCar() {
    startM3IfNeeded();
    m3.inCar = true;
    api.player.speed = CAR_SPEED;
    toast(GOAL_TOAST, 3.2);
  }

  function exitCar() {
    m3.inCar = false;
    api.player.speed = 90; // back to on-foot default
  }

  function completeM3() {
    // mark done & unlock content
    localStorage.setItem(M3_KEY, 'done');
    m3.state = 'done';
    // bump overall mission count to >=3
    try {
      const cur = (api.getMissionCount && api.getMissionCount()) || 0;
      const next = Math.max(cur, 3);
      localStorage.setItem('izzaMissions', String(next));
    } catch { }

    // Expand the map immediately so the next player step can go into black area
    localStorage.setItem('izzaMapTier', '2');

    toast(UNLOCK_TOAST, 4);
  }

  function atExitTile() {
    const { gx, gy } = playerGrid();
    return gx === (m3.exitGX | 0) && gy === (m3.exitGY | 0);
  }

  // -------- input hook (B to hijack / optionally get out)
  function onB() {
    if (m3.state === 'done') return;
    if (!api || !api.ready) return;

    const car = nearAnyCar();

    if (!m3.inCar) {
      // try to hijack a passing car
      if (car) {
        // “remove” driver: turn the car into just a visual shell (we draw the shell via core already)
        // We don’t need to mutate car physics; player movement will do the driving illusion.
        enterCar();
      }
    } else {
      // optional: allow getting out with B (kept for testing)
      // exitCar();
    }
  }

  // keyboard + mobile button
  function bindB() {
    window.addEventListener('keydown', (e) => {
      if (e.key && e.key.toLowerCase() === 'b') onB();
    });
    const btnB = document.getElementById('btnB');
    if (btnB) btnB.addEventListener('click', onB);
  }

  // -------- glue to core update/render
  IZZA.on('ready', (a) => {
    api = a;
    bindB();
    loadExitPos();

    // If player already finished M3 earlier and map isn’t expanded (e.g. new core),
    // make sure it’s expanded now.
    if (m3.state === 'done' && localStorage.getItem('izzaMapTier') !== '2') {
      localStorage.setItem('izzaMapTier', '2');
    }

    console.log('[M3] ready', { state: m3.state, inCar: m3.inCar, exit: { gx: m3.exitGX, gy: m3.exitGY } });
  });

  // Let the player “drive” while in car by simply letting core movement run
  // We only add mission logic here (detecting exit)
  IZZA.on('update-post', () => {
    if (!api) return;
    if (m3.state !== 'active') return;

    // When in car: speed is boosted; collision is still enforced by core's tryMove()
    if (m3.inCar) {
      api.player.speed = CAR_SPEED;

      // Check for success: touching the glowing border tile
      if (atExitTile()) {
        // Expand first, then mark complete so the very next step can move into new area
        completeM3();
      }
    }
  });

  // Draw exit glow + keep the “car overlay” look by drawing a box over player
  IZZA.on('render-post', () => {
    if (!api) return;

    // Exit glow
    drawExitGlow();

    // Simple “car shell” overlay above player while driving (keeps your current aesthetic)
    if (m3.inCar && m3.state !== 'done') {
      const ctx = document.getElementById('game').getContext('2d');
      const S = api.DRAW;
      const sx = w2sX(api.player.x), sy = w2sY(api.player.y);
      ctx.save();
      ctx.fillStyle = '#c0c8d8';
      ctx.fillRect(sx + S * 0.10, sy + S * 0.25, S * 0.80, S * 0.50);
      ctx.restore();
    }
  });

})();
