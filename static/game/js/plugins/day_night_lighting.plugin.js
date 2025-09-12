/* day_night_lighting.plugin.js — consentless day/night with stronger night levels (HiDPI-safe)
   - No prompts. Uses local time + month table.
   - Two levels:
       twilight (~±45min from dusk/dawn): subtle but visible
       definite night: clearly darker, still playable
   - Draws on its own overlay canvas (z-index 3), below seasonal decals (z-index 4).
*/
(function(){
  if (!window.IZZA || typeof IZZA.on !== 'function') return;

  // Approx civil dawn/dusk by month (local time, mid-latitudes)
  const DAWN_DUSK_BY_MONTH = [
    [7.5,17.0],[7.0,18.0],[6.5,19.0],[6.0,20.0],
    [5.0,21.0],[4.8,21.5],[5.2,21.0],[5.8,20.2],
    [6.5,19.2],[7.0,18.0],[7.2,17.2],[7.6,16.6]
  ];

  // Tunables (raise if you want darker)
  const TWILIGHT_TINT  = 0.18; // base blue wash alpha during twilight
  const TWILIGHT_VIGN  = 0.24; // vignette edge alpha during twilight
  const NIGHT_TINT     = 0.28; // base blue wash alpha during definite night
  const NIGHT_VIGN     = 0.40; // vignette edge alpha during definite night

  const STATE = { isNight:false, nightLevel:0, tintA:0, vigA:0 };

  function recompute(){
    const now = new Date();
    const m   = now.getMonth();
    const h   = now.getHours() + now.getMinutes()/60;
    const [dawn, dusk] = DAWN_DUSK_BY_MONTH[m];
    const TW = 0.75; // ~45 minutes either side

    let level = 0; // 0 = day, 0.5 = twilight, 1 = definite night
    if (h < dawn - TW || h >= dusk + TW) level = 1;
    else if (h < dawn || h >= dusk)      level = 0.5;

    STATE.isNight = level > 0;
    STATE.nightLevel = level;
    STATE.tintA = (level === 1 ? NIGHT_TINT : level === 0.5 ? TWILIGHT_TINT : 0);
    STATE.vigA  = (level === 1 ? NIGHT_VIGN : level === 0.5 ? TWILIGHT_VIGN : 0);
  }

  Object.defineProperty(window, 'IZZA_LIGHT', { value: STATE, writable:false });

  // Dedicated overlay canvas below decals
  let overlay=null, ctx=null, ro=null, dpr=1;
  function ensureOverlay(){
    if (overlay && ctx) return true;
    const card = document.getElementById('gameCard');
    const game = document.getElementById('game');
    if (!card || !game) return false;

    overlay = document.createElement('canvas');
    overlay.id = 'izzaNightOverlay';
    overlay.style.position = 'absolute';
    overlay.style.inset = '10px 10px 10px 10px'; // match #game padding
    overlay.style.pointerEvents = 'none';
    overlay.style.borderRadius = getComputedStyle(game).borderRadius || '12px';
    overlay.style.zIndex = '3'; // UNDER seasonal (which uses z-index 4)
    card.appendChild(overlay);
    ctx = overlay.getContext('2d');

    const resize = ()=>{
      const rect = game.getBoundingClientRect();
      dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
      overlay.width  = Math.max(1, Math.round(rect.width  * dpr));
      overlay.height = Math.max(1, Math.round(rect.height * dpr));
      overlay.style.width  = Math.round(rect.width)  + 'px';
      overlay.style.height = Math.round(rect.height) + 'px';
      draw();
    };
    ro = new ResizeObserver(resize);
    ro.observe(game);
    resize();
    return true;
  }

  function draw(){
    if (!ctx || !overlay) return;
    const w = overlay.width, h = overlay.height;
    ctx.setTransform(1,0,0,1,0,0);
    ctx.clearRect(0,0,w,h);
    if (!STATE.isNight) return;

    // Blue wash
    ctx.globalAlpha = STATE.tintA;
    ctx.fillStyle = 'rgba(10,14,35,1)'; // deep blue
    ctx.fillRect(0,0,w,h);
    ctx.globalAlpha = 1;

    // Vignette
    const g = ctx.createRadialGradient(
      w*0.5, h*0.5, Math.min(w,h)*0.22,
      w*0.5, h*0.5, Math.max(w,h)*0.82
    );
    g.addColorStop(0,'rgba(0,0,0,0)');
    g.addColorStop(1,`rgba(0,0,0,${STATE.vigA})`);
    ctx.fillStyle = g;
    ctx.fillRect(0,0,w,h);
  }

  IZZA.on('ready', ()=>{
    if (!ensureOverlay()) return;
    recompute(); draw();
    // Update every minute and after each game draw (so it feels live)
    setInterval(()=>{ recompute(); draw(); }, 60*1000);
    IZZA.on('draw-post', draw);

    // quick console hint for verification
    console.log('[LIGHT]', { isNight: STATE.isNight, level: STATE.nightLevel, tint: STATE.tintA, vign: STATE.vigA });
  });
})();
