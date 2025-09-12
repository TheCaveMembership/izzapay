/* day_night_lighting.plugin.js
   Consentless lighting using local clock (no prompts).
   Two levels: twilight = gentle dim, definite night = moderate dim (never too dark).
   Draws on its own overlay canvas above #game so it can’t be overdrawn.
*/
(function(){
  if (!window.IZZA || typeof IZZA.on !== 'function') return;

  // Approx civil dawn/dusk by month, local time (mid-latitudes)
  const DAWN_DUSK_BY_MONTH = [
    [7.5,17.0],[7.0,18.0],[6.5,19.0],[6.0,20.0],
    [5.0,21.0],[4.8,21.5],[5.2,21.0],[5.8,20.2],
    [6.5,19.2],[7.0,18.0],[7.2,17.2],[7.6,16.6]
  ];

  const STATE = { isNight:false, nightLevel:0, tintA:0, vigA:0 };

  function seasonIntensity(m){
    if (m===11 || m===0) return 1.0;   // Dec, Jan a touch darker
    if (m===5  || m===6) return 0.75;  // Jun, Jul a touch lighter
    return 0.9;
  }

  function recompute(){
    const now = new Date();
    const m   = now.getMonth();
    const h   = now.getHours() + now.getMinutes()/60;
    const [dawn, dusk] = DAWN_DUSK_BY_MONTH[m];
    const TW = 0.75; // ~45 minutes of twilight

    let level = 0;
    if (h < dawn - TW || h >= dusk + TW) level = 1.0;   // definite night
    else if (h < dawn || h >= dusk)      level = 0.45;  // twilight
    STATE.isNight = level > 0;

    const scaled = level * seasonIntensity(m);
    STATE.tintA  = Math.min(0.12 + 0.12*scaled, 0.22);  // gentle wash
    STATE.vigA   = Math.min(0.16 + 0.14*scaled, 0.30);  // soft vignette
    STATE.nightLevel = level;
  }

  Object.defineProperty(window, 'IZZA_LIGHT', { value: STATE, writable:false });

  // Dedicated overlay canvas above the game
  let overlay=null, ctx=null, ro=null;
  function ensureOverlay(){
    if (overlay && ctx) return true;
    const card = document.getElementById('gameCard');
    const game = document.getElementById('game');
    if (!card || !game) return false;

    overlay = document.createElement('canvas');
    overlay.id = 'izzaNightOverlay';
    overlay.style.position = 'absolute';
    overlay.style.inset = '10px 10px 10px 10px'; // match padding inside #gameCard
    overlay.style.pointerEvents = 'none';
    overlay.style.borderRadius = getComputedStyle(game).borderRadius || '12px';
    overlay.style.zIndex = '3';
    card.appendChild(overlay);

    ctx = overlay.getContext('2d');

    const resize = ()=>{
      const rect = game.getBoundingClientRect();
      overlay.width  = Math.max(1, Math.round(game.width  || rect.width));
      overlay.height = Math.max(1, Math.round(game.height || rect.height));
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
    ctx.clearRect(0,0,w,h);
    if (!STATE.isNight) return;

    // blue wash
    ctx.globalAlpha = STATE.tintA;
    ctx.fillStyle = 'rgba(10,14,35,1)';
    ctx.fillRect(0,0,w,h);
    ctx.globalAlpha = 1;

    // vignette
    const g = ctx.createRadialGradient(
      w*0.5,h*0.5, Math.min(w,h)*0.2,
      w*0.5,h*0.5, Math.max(w,h)*0.8
    );
    g.addColorStop(0,'rgba(0,0,0,0)');
    g.addColorStop(1,`rgba(0,0,0,${STATE.vigA})`);
    ctx.fillStyle = g;
    ctx.fillRect(0,0,w,h);
  }

  // Wire up
  IZZA.on('ready', ()=>{
    if (!ensureOverlay()) return;
    recompute(); draw();
    setInterval(()=>{ recompute(); draw(); }, 60*1000);
    IZZA.on('draw-post', draw);
  });
})();
