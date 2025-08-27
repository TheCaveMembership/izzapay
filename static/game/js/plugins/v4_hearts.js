// /static/game/js/plugins/v4_hearts.js
(function () {
  const BUILD = "v4-hearts-plugin@svgHUD";
  console.log("[IZZA PLAY]", BUILD);

  // --- persistence keys (share izza namespace) ---
  const LS = {
    maxHearts: "izzaMaxHearts",
    curSegs: "izzaCurHeartSegments",
    inventory: "izzaInventory",
  };

  // local mirrors set after core 'ready'
  let api = null, player = null, cops = null;

  // ---------- persistence helpers ----------
  const getMaxHearts = () =>
    Math.max(1, parseInt(localStorage.getItem(LS.maxHearts) || "3", 10));
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
  const loseAllItems = () => localStorage.setItem(LS.inventory, "[]");

  // ---------- hearts model ----------
  function initHearts() {
    player.maxHearts = getMaxHearts();        // number of ❤️ containers
    player.heartSegs = getCurSegs(player.maxHearts); // each heart has 3 segments
    if (player.heartSegs <= 0) {
      player.heartSegs = player.maxHearts * 3;
      setCurSegs(player.heartSegs, player.maxHearts);
    }
    ensureHUD();
    renderHeartsDOM();
  }
  function healFull() {
    player.heartSegs = player.maxHearts * 3;
    setCurSegs(player.heartSegs, player.maxHearts);
    renderHeartsDOM();
  }
  function takeDamageSegs(n = 1) {
    player.heartSegs = Math.max(0, player.heartSegs - n);
    setCurSegs(player.heartSegs, player.maxHearts);
    renderHeartsDOM();
    if (player.heartSegs <= 0) onDeath();
  }

  // ---------- death / respawn ----------
  function onDeath() {
    const keep = Math.floor(api.getCoins() / 3); // keep 1/3rd
    api.setCoins(keep);
    loseAllItems();

    api.setWanted(0);
    cops.length = 0;

    const door = findHQDoor();
    player.x = door.x;
    player.y = door.y;
    player.facing = "down";
    player.moving = false;
    player.animTime = 0;

    healFull();
    toast("You were taken out! Lost items and 2/3 of your coins.", 4);
  }

  // stable spawn: use core if exposed; otherwise snap to tile near current
  function findHQDoor() {
    if (api && api.doorSpawn) return { x: api.doorSpawn.x, y: api.doorSpawn.y };
    const TILE = api ? api.TILE : 32;
    try {
      const gx = Math.round(player.x / TILE);
      const gy = Math.round(player.y / TILE);
      return { x: gx * TILE + (TILE / 2 - 8), y: gy * TILE };
    } catch {
      return { x: player.x, y: player.y };
    }
  }

  // ---------- small toast ----------
  function toast(text, seconds = 3) {
    let h = document.getElementById("tutHint");
    if (!h) {
      h = document.createElement("div");
      h.id = "tutHint";
      Object.assign(h.style, {
        position: "fixed",
        left: "12px",
        top: "64px",
        zIndex: 7,
        background: "rgba(10,12,18,.85)",
        border: "1px solid #394769",
        color: "#cfe0ff",
        padding: "8px 10px",
        borderRadius: "10px",
        fontSize: "14px",
      });
      document.body.appendChild(h);
    }
    h.textContent = text;
    h.style.display = "block";
    setTimeout(() => {
      h.style.display = "none";
    }, seconds * 1000);
  }

  // ======================================================================
  //                          HUD HEARTS (DOM)
  // ======================================================================
  let hudWrap = null; // absolute container inside sticky .hud
  function ensureHUD() {
    if (hudWrap) return;
    const hud = document.querySelector(".hud");
    if (!hud) return;

    hud.style.position = hud.style.position || "sticky"; // already sticky in CSS
    // Create an absolute box inside the HUD, aligned under the stars on the right
    hudWrap = document.createElement("div");
    hudWrap.id = "izzaHearts";
    Object.assign(hudWrap.style, {
      position: "absolute",
      right: "12px",
      top: "calc(100% + 2px)", // small gap *below* the HUD bar
      zIndex: "6",
      display: "flex",
      gap: "6px",
      padding: "8px 10px",
      background: "rgba(10,12,18,.8)",
      border: "1px solid #2a3550",
      borderRadius: "12px",
      boxShadow: "0 2px 10px rgba(0,0,0,.25)",
    });
    // ensure the HUD itself is relatively positioned so our absolute
    // child measures from it (not the page)
    if (getComputedStyle(hud).position === "static") {
      hud.style.position = "relative";
    }
    hud.appendChild(hudWrap);

    // keep pinned under stars on orientation/resize
    window.addEventListener("resize", () => positionHUD());
    positionHUD();
  }

  function positionHUD() {
    // Because we attach inside .hud and use top: calc(100% + 2px),
    // it will naturally sit right under the bar, so nothing else needed.
  }

  // draw one SVG heart with fractional fill (0..1)
  function heartSVG(fillRatio) {
    const id = "clip_" + Math.random().toString(36).slice(2);
    const w = 22, h = 20; // compact but crisp
    const rectW = Math.max(0, Math.min(1, fillRatio)) * 24; // based on viewBox width

    return `
<svg width="${w}" height="${h}" viewBox="0 0 24 24" aria-hidden="true">
  <defs>
    <clipPath id="${id}">
      <rect x="0" y="0" width="${rectW}" height="24"></rect>
    </clipPath>
  </defs>
  <!-- empty heart (outline + grey fill) -->
  <path d="M12 21.35l-1.45-1.32C5.4 16.36 2 13.28 2 9.5 2 7 3.99 5 6.5 5c1.24 0 2.42.54 3.3 1.44L12 8.67l2.2-2.23C15.08 5.54 16.26 5 17.5 5 20.01 5 22 7 22 9.5c0 3.78-3.4 6.86-8.55 10.54L12 21.35z"
        fill="#3a3f4a" stroke="#d14a4a" stroke-width="1.5" />
  <!-- red filled portion, clipped -->
  <g clip-path="url(#${id})">
    <path d="M12 21.35l-1.45-1.32C5.4 16.36 2 13.28 2 9.5 2 7 3.99 5 6.5 5c1.24 0 2.42.54 3.3 1.44L12 8.67l2.2-2.23C15.08 5.54 16.26 5 17.5 5 20.01 5 22 7 22 9.5c0 3.78-3.4 6.86-8.55 10.54L12 21.35z"
          fill="#ff5555"/>
  </g>
</svg>`;
  }

  function renderHeartsDOM() {
    if (!hudWrap || !player) return;
    const maxH = player.maxHearts || 3;
    const seg = player.heartSegs ?? maxH * 3;

    let html = "";
    for (let i = 0; i < maxH; i++) {
      const segForHeart = Math.max(0, Math.min(3, seg - i * 3)); // 0..3
      const ratio = segForHeart / 3;
      html += heartSVG(ratio);
    }
    hudWrap.innerHTML = html;
  }

  // ======================================================================
  //                   COP MELEE (damage every 2s in range)
  // ======================================================================
  function attachCopMelee() {
    IZZA.on("update-post", ({ now }) => {
      if (!api) return;
      const atkRange = 26;
      const cd = 2000; // ms between hits per-cop
      for (const c of cops) {
        c._nextAtk ??= now;
        const dist = Math.hypot(player.x - c.x, player.y - c.y);
        if (dist <= atkRange && now >= c._nextAtk) {
          takeDamageSegs(1); // 1/3 heart
          c._nextAtk = now + cd;
        }
      }
    });
  }

  // ---------- hook into core ----------
  if (window.IZZA && IZZA.on) {
    IZZA.on("ready", (coreApi) => {
      api = coreApi;
      player = api.player;
      cops = api.cops;

      initHearts();
      attachCopMelee();

      // re-render when wanted level changes (not strictly needed, but handy)
      IZZA.on("wanted-changed", () => renderHeartsDOM());

      // also re-render when coins are changed etc., in case future perks grant hearts
      IZZA.on("ped-killed", () => renderHeartsDOM());
      IZZA.on("cop-killed", () => renderHeartsDOM());
    });
  } else {
    console.warn(
      "v4_hearts: core hook bus not found. Include izza_core_v3.js before this file."
    );
  }
})();
