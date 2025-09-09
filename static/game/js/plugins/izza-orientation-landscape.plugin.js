<!-- /static/game/js/plugins/izza-orientation-landscape.plugin.js -->
(function(){
  const BASE_W = 960, BASE_H = 540;        // canvas' intrinsic size
  const BODY   = document.body;
  const canvas = document.getElementById('game');
  const mini   = document.getElementById('miniWrap');
  const log = (...a)=>console.log('[IZZA landscape]', ...a);

  if (!canvas){ console.warn('[IZZA landscape] #game canvas not found'); return; }

  // --- Robust orientation check
  function isLandscape(){
    try {
      if (screen.orientation && typeof screen.orientation.type === 'string' &&
          screen.orientation.type.indexOf('landscape') === 0) return true;
    } catch {}
    try {
      if (window.matchMedia && window.matchMedia('(orientation: landscape)').matches) return true;
    } catch {}
    return window.innerWidth > window.innerHeight;
  }

  // --- Inject CSS (handles real landscape + clean fake-landscape) ---
  (function injectCSS(){
    if (document.getElementById('izzaLandscapeCSS')) return;
    const tag = document.createElement('style'); tag.id='izzaLandscapeCSS';
    tag.textContent = `
      /* Base */
      #game { display:block; background:#000; }

      /* Use full screen and respect safe areas when rotated or faking */
      body[data-orient="landscape"],
      body[data-fakeland="1"]{
        overflow:hidden;
        padding: env(safe-area-inset-top) env(safe-area-inset-right)
                 env(safe-area-inset-bottom) env(safe-area-inset-left);
      }

      /* Let stage go full-bleed */
      body[data-orient="landscape"] .wrap,
      body[data-fakeland="1"] .wrap { max-width:none; padding:0; }

      /* Stage host centered */
      body[data-orient="landscape"] #gameCard,
      body[data-fakeland="1"] #gameCard{
        position:fixed; left:50%; top:50%;
        transform:translate(-50%,-50%);
        background:transparent; border:0; padding:0; margin:0; z-index:1; border-radius:0;
      }

      /* Real landscape: scale canvas to fit */
      body[data-orient="landscape"] #game{
        width:${BASE_W}px !important;
        height:${BASE_H}px !important;
        transform-origin: top left;
        image-rendering: pixelated;
      }

      /* Fake landscape: canvas will be rotated+scaled via inline transform */
      body[data-fakeland="1"] #game{
        width:${BASE_W}px !important;
        height:${BASE_H}px !important;
        transform-origin: top left;
        image-rendering: pixelated;
      }

      /* HUD / controls / mini pinned sensibly in both modes */
      body[data-orient="landscape"] .hud,
      body[data-fakeland="1"] .hud { position:fixed; left:0; right:0; top:0; z-index:7; }
      body[data-orient="landscape"] .controls,
      body[data-fakeland="1"] .controls{
        position:fixed; right:14px; bottom:14px; display:flex; flex-direction:column; gap:10px; z-index:6;
      }
      body[data-orient="landscape"] .stick,
      body[data-fakeland="1"] .stick{
        position:fixed; left:14px; bottom:14px; transform:scale(1.1); transform-origin: bottom left; z-index:6;
      }
      body[data-orient="landscape"] .mini,
      body[data-fakeland="1"] .mini{
        position:fixed; right:12px; top:74px; bottom:auto; display:block; z-index:4;
      }

      /* (Optional) If your chat bar overlaps, you can hide it in fake-landscape:
         body[data-fakeland="1"] [data-chatbar], body[data-fakeland="1"] .chat { display:none !important; } */

      /* CTA shown only in portrait */
      .izzaland-cta{
        position:fixed; left:50%; bottom:18px; transform:translateX(-50%);
        padding:10px 14px; border-radius:10px;
        background:rgba(0,0,0,.65); color:#fff; font:600 14px/1.1 system-ui, -apple-system, Segoe UI, Roboto, Arial;
        z-index:9999; backdrop-filter:saturate(140%) blur(6px);
      }
      .izzaland-cta.hide{ display:none; }
    `;
    document.head.appendChild(tag);
  })();

  // --- Layout modes
  function layoutLandscapeScale(){
    const vw = window.innerWidth, vh = window.innerHeight;
    const scale = Math.min(vw / BASE_W, vh / BASE_H);

    canvas.style.width  = BASE_W + 'px';
    canvas.style.height = BASE_H + 'px';
    canvas.style.transform = `scale(${scale})`;

    BODY.setAttribute('data-orient', 'landscape');
    BODY.removeAttribute('data-fakeland');
    cta.classList.add('hide');
    if (mini) mini.style.display = 'block';
  }

  function layoutFakeLandscape(){
    // Portrait-only host: rotate + scale + center the canvas
    const vw = window.innerWidth, vh = window.innerHeight;
    const scale = Math.min(vh / BASE_W, vw / BASE_H);
    const rotatedW = BASE_H * scale;   // visual width after 90deg
    const rotatedH = BASE_W * scale;   // visual height after 90deg
    const tx = (vw - rotatedW) / 2;
    const ty = (vh - rotatedH) / 2;

    canvas.style.width  = BASE_W + 'px';
    canvas.style.height = BASE_H + 'px';
    canvas.style.transform = `translate(${tx}px, ${ty}px) rotate(90deg) scale(${scale})`;

    BODY.setAttribute('data-fakeland', '1');
    BODY.removeAttribute('data-orient');
    cta.classList.add('hide');
    if (mini) mini.style.display = 'block';
  }

  function resetPortrait(){
    canvas.style.transform = '';
    canvas.style.width  = '';
    canvas.style.height = '';
    BODY.removeAttribute('data-orient');
    BODY.removeAttribute('data-fakeland');
    cta.classList.remove('hide');
  }

  // --- CTA (try real lock; if host refuses, auto fake-landscape) ---
  const cta = document.createElement('button');
  cta.className = 'izzaland-cta';
  cta.type = 'button';
  cta.textContent = 'Rotate to landscape for best play';
  document.body.appendChild(cta);

  async function tryLockLandscape(){
    const el = document.documentElement;
    try { if (el.requestFullscreen) await el.requestFullscreen(); } catch{}
    try {
      if (screen.orientation && screen.orientation.lock) {
        await screen.orientation.lock('landscape');
        log('orientation lock requested');
        return true;
      }
    } catch(e){ log('orientation lock failed', e && e.name); }
    return false;
  }

  // Give the host a fair chance to report landscape; otherwise fall back
  async function attemptLandscapeFlow(){
    const locked = await tryLockLandscape();

    // Short grace windows for URL/status bars to animate/hide
    const checkpoints = [120, 350, 800];
    for (const t of checkpoints){
      await new Promise(r => setTimeout(r, t));
      if (isLandscape()){
        layoutLandscapeScale();
        return;
      }
    }

    // If we get here, host is stuck in portrait → clean fake-landscape
    layoutFakeLandscape();
  }

  cta.addEventListener('click', attemptLandscapeFlow, { passive:true });

  // --- Reactive layout
  let rafId = 0;
  const schedule = ()=>{ cancelAnimationFrame(rafId); rafId = requestAnimationFrame(apply); };

  function apply(){
    if (isLandscape()){
      layoutLandscapeScale();
    } else if (!BODY.hasAttribute('data-fakeland')) {
      // Only reset if we weren't faking; fake mode remains stable while host reports portrait
      resetPortrait();
    }
  }

  window.addEventListener('resize', schedule, { passive:true });
  window.addEventListener('orientationchange', ()=>{ setTimeout(schedule,100); setTimeout(schedule,600); }, { passive:true });
  try { screen.orientation && screen.orientation.addEventListener('change', ()=> setTimeout(schedule,60), { passive:true }); } catch{}
  try {
    const mm = window.matchMedia('(orientation: landscape)');
    mm && (mm.addEventListener ? mm.addEventListener('change', schedule) : mm.addListener(schedule));
  } catch{}

  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', schedule, { once:true });
  } else {
    schedule();
  }

  log('plugin ready (real landscape + clean fake fallback)');
})();
