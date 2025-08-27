// /static/game/js/plugins/v4_hearts.js
(function () {
  const BUILD = 'v4-hearts-plugin+hud-under-stars';
  console.log('[IZZA PLAY]', BUILD);

  // --- persistence keys (reuse core namespace) ---
  const LS = {
    maxHearts:  'izzaMaxHearts',
    curSegs:    'izzaCurHeartSegments',
    inventory:  'izzaInventory'
  };

  // mirrors to core
  let api = null, player = null, cops = null;

  // ---------- persistence helpers ----------
  const getMaxHearts = () =>
    Math.max(1, parseInt(localStorage.getItem(LS.maxHearts) || '3', 10));
  const setMaxHearts = (n) =>
    localStorage.setItem(LS.maxHearts, String(Math.max(1, n | 0)));

  const getCurSegs = (maxH) => {
    const def = maxH * 3;
    const raw = parseInt(localStorage.getItem(LS.curSegs) || String(def), 10);
    return Math.max(0, Math.min(def, raw));
  };
  const setCurSegs = (seg, maxH) => {
    localStorage.setItem(
      LS.curSegs,
      String(Math.max(0, Math.min((maxH || getMaxHearts()) * 3, seg | 0)))
    );
  };
  const loseAllItems = () => localStorage.setItem(LS.inventory, '[]');

  // ---------- hearts model ----------
  function initHearts() {
    player.maxHearts = getMaxHearts();
    player.heartSegs = getCurSegs(player.maxHearts);
    if (player.heartSegs <= 0) {
      player.heartSegs = player.maxHearts * 3;
      setCurSegs(player.heartSegs, player.maxHearts);
    }
    drawDOMHearts(); // first render
    placeHeartsHud(); // first position
  }
  function healFull() {
    player.heartSegs = player.maxHearts * 3;
    setCurSegs(player.heartSegs, player.maxHearts);
    drawDOMHearts();
  }
  function takeDamageSegs(n = 1) {
    player.heartSegs = Math.max(0, player.heartSegs - n);
    setCurSegs(player.heartSegs, player.maxHearts);
    drawDOMHearts();
    if (player.heartSegs <= 0) onDeath();
  }

  // ---------- death / respawn ----------
  function onDeath() {
    const keep = Math.floor(api.getCoins() / 3); // keep 1/3
    api.setCoins(keep);
    loseAllItems();
    api.setWanted(0);
    cops.length = 0;

    const door = findHQDoor();
    player.x = door.x; player.y = door.y;
    player.facing = 'down'; player.moving = false; player.animTime = 0;

    healFull();
    toast('You were taken out! Lost items and 2/3 of your coins.', 4);
  }

  function findHQDoor() {
    if (api && api.doorSpawn) return { x: api.doorSpawn.x, y: api.doorSpawn.y };
    // fallback: snap to current tile center
    const TILE = api ? api.TILE : 32;
    try {
      const gx = Math.round(player.x / TILE);
      const gy = Math.round(player.y / TILE);
      return { x: gx * TILE + (TILE / 2 - 8), y: gy * TILE };
    } catch {
      return { x: player.x, y: player.y };
    }
  }

  // ---------- tiny toast ----------
  function toast(text, seconds = 3) {
    let h = document.getElementById('tutHint');
    if (!h) {
      h = document.createElement('div');
      h.id = 'tutHint';
      Object.assign(h.style, {
        position: 'fixed', left: '12px', top: '64px', zIndex: 7,
        background: 'rgba(10,12,18,.85)', border: '1px solid #394769',
        color: '#cfe0ff', padding: '8px 10px', borderRadius: '10px', fontSize: '14px'
      });
      document.body.appendChild(h);
    }
    h.textContent = text; h.style.display = 'block';
    setTimeout(() => { h.style.display = 'none'; }, seconds * 1000);
  }

  // ===================================================================
  //                        DOM HEARTS (under stars)
  // ===================================================================

  // Ensure the container exists
  function ensureHeartsHud() {
    let hud = document.getElementById('heartsHud');
    if (hud) return hud;

    hud = document.createElement('div');
    hud.id = 'heartsHud';
    Object.assign(hud.style, {
      position: 'absolute',
      zIndex: 6,
      display: 'flex',
      gap: '8px',
      alignItems: 'center',
      pointerEvents: 'none',   // purely visual
      // left/top are set by placeHeartsHud()
    });

    // subtle label shadow to stand out a bit
    hud.style.filter = 'drop-shadow(0 1px 0 rgba(0,0,0,.3))';
    document.body.appendChild(hud);
    return hud;
  }

  // Build the hearts based on current segments
  function drawDOMHearts() {
    const hud = ensureHeartsHud();
    if (!player) return;

    const maxH = player.maxHearts || 3;
    const seg  = player.heartSegs ?? maxH * 3;

    // clear
    hud.innerHTML = '';

    for (let i = 0; i < maxH; i++) {
      const segForHeart = Math.max(0, Math.min(3, seg - i * 3)); // 0..3

      const wrap = document.createElement('div');
      Object.assign(wrap.style, {
        position: 'relative',
        width: '22px',
        height: '20px'
      });

      // the heart itself (emoji)
      const heart = document.createElement('span');
      heart.textContent = '❤️';
      Object.assign(heart.style, {
        position: 'absolute',
        left: '0', top: '-2px',
        fontSize: '20px',
        lineHeight: '20px',
        filter: 'drop-shadow(0 1px 0 rgba(0,0,0,.25))'
      });
      wrap.appendChild(heart);

      // grey mask from the RIGHT to simulate partial drain
      if (segForHeart < 3) {
        const pctGrey = (3 - segForHeart) / 3; // 0..1
        const mask = document.createElement('div');
        Object.assign(mask.style, {
          position: 'absolute',
          top: '0px',
          right: '0px',
          width: Math.round(22 * pctGrey) + 'px',
          height: '20px',
          background: 'rgba(58,63,74,.85)',
          borderTopRightRadius: '8px',
          borderBottomRightRadius: '8px'
        });
        wrap.appendChild(mask);
      }

      hud.appendChild(wrap);
    }

    placeHeartsHud(); // ensure positioning after rebuild
  }

  // Position the hearts directly under the cop stars, responsive
  function placeHeartsHud() {
    const hud = ensureHeartsHud();
    const stars = document.getElementById('stars');
    if (!stars) return;

    const r = stars.getBoundingClientRect();
    // place just below, with a small gap; align left edges
    hud.style.left = Math.round(r.left) + 'px';
    hud.style.top  = Math.round(r.bottom + 6) + 'px';
  }

  // Reposition on resize / orientation change
  window.addEventListener('resize', placeHeartsHud, { passive: true });
  window.addEventListener('orientationchange', placeHeartsHud, { passive: true });

  // ===================================================================
  //                 Cop melee: 1 hit (1/3 heart) per 2s
  // ===================================================================
  function attachCopMelee() {
    IZZA.on('update-post', ({ now }) => {
      if (!api) return;
      const atkRange = 26;
      const cd = 2000; // ms
      for (const c of cops) {
        c._nextAtk ??= now;
        const dist = Math.hypot(player.x - c.x, player.y - c.y);
        if (dist <= atkRange && now >= c._nextAtk) {
          takeDamageSegs(1);      // 1/3 of a heart
          c._nextAtk = now + cd;  // cooldown
        }
      }
    });
  }

  // ---------- plugin boot ----------
  if (window.IZZA && IZZA.on) {
    IZZA.on('ready', (coreApi) => {
      api = coreApi;
      player = api.player;
      cops   = api.cops;

      initHearts();
      attachCopMelee();

      // if wanted level changes we don't alter hearts yet,
      // but we may want to reposition after HUD changes.
      IZZA.on('wanted-changed', placeHeartsHud);
    });
  } else {
    console.warn('v4_hearts: core hook bus not found. Include izza_core_v3.js first.');
  }
})();
