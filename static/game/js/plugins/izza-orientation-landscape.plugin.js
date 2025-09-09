<!-- /static/game/js/plugins/izza-orientation-landscape.plugin.js -->
(function(){
  const BASE_W = 960, BASE_H = 540;        // intrinsic canvas size
  const BODY   = document.body;
  const canvas = document.getElementById('game');
  const mini   = document.getElementById('miniWrap');
  const HUD    = document.querySelector('.hud');
  const log = (...a)=>console.log('[IZZA landscape]', ...a);

  if (!canvas){ console.warn('[IZZA landscape] #game canvas not found'); return; }

  // ---------- helpers ----------
  function isLandscape(){
    try { if (screen.orientation?.type?.startsWith('landscape')) return true; } catch{}
    try { if (matchMedia('(orientation: landscape)').matches) return true; } catch{}
    return window.innerWidth > window.innerHeight;
  }
  function hudHeight(){
    try{ const r = HUD?.getBoundingClientRect(); return r ? Math.ceil(r.height) : 0; }catch{ return 0; }
  }

  // ---------- CSS (top-anchored stage) ----------
  (function injectCSS(){
    if (document.getElementById('izzaLandscapeCSS')) return;
    const css = `
      #game { display:block; background:#000; }

      /* Use whole screen & account for safe areas when rotated or faking */
      body[data-orient="landscape"], body[data-fakeland="1"]{
        overflow:hidden;
        padding: env(safe-area-inset-top) env(safe-area-inset-right)
                 env(safe-area-inset-bottom) env(safe-area-inset-left);
      }

      /* Remove wrapper/card chrome so the stage can sit flush at the top */
      body[data-orient="landscape"] .wrap,
      body[data-fakeland="1"] .wrap { max-width:none; padding:0; }

      body[data-orient="landscape"] #gameCard,
      body[data-fakeland="1"] #gameCard{
        position:fixed; left:0; top:0; right:0; bottom:0;  /* full viewport host */
        background:transparent; border:0; padding:0; margin:0; border-radius:0; z-index:1;
      }

      /* We'll translate the canvas itself (top-anchored) */
      body[data-orient="landscape"] #game,
      body[data-fakeland="1"] #game{
        width:${BASE_W}px !important;
        height:${BASE_H}px !important;
        transform-origin: top left;
        image-rendering: pixelated;
        border-radius:0;
      }

      /* Keep HUD pinned to the very top */
      body[data-orient="landscape"] .hud,
      body[data-fakeland="1"] .hud{ position:fixed; left:0; right:0; top:0; z-index:7; }

      /* Controls layout (overlay, Game Boy style) */
      body[data-orient="landscape"] .controls,
      body[data-fakeland="1"] .controls{
        position:fixed; right:14px; bottom:14px; z-index:6;
        display:flex; flex-direction:column; gap:10px;
      }
      body[data-orient="landscape"] .stick,
      body[data-fakeland="1"] .stick{
        position:fixed; left:14px; bottom:14px; z-index:6;
        transform:scale(1.1); transform-origin: bottom left;
      }
      body[data-orient="landscape"] .mini,
      body[data-fakeland="1"] .mini{
        position:fixed; right:12px; top:74px; bottom:auto; z-index:4; display:block;
      }

      /* CTA shown only in portrait */
      .izzaland-cta{
        position:fixed; left:50%; bottom:18px; transform:translateX(-50%);
        padding:10px 14px; border-radius:10px;
        background:rgba(0,0,0,.65); color:#fff; font:600 14px/1.1 system-ui, -apple-system, Segoe UI, Roboto, Arial;
        z-index:9999; backdrop-filter:saturate(140%) blur(6px);
      }
      .izzaland-cta.hide{ display:none; }
    `;
    const tag = document.createElement('style');
    tag.id = 'izzaLandscapeCSS';
    tag.textContent = css;
    document.head.appendChild(tag);
  })();

  // ---------- layout (top-anchored) ----------
  function layoutLandscapeTop(){
    const vw = window.innerWidth, vh = window.innerHeight;
    const topPad = hudHeight() + 8; // keep a little breathing room under HUD
    const availH = Math.max(0, vh - topPad);

    // scale to fit width & available height under HUD
    const scale = Math.min(vw / BASE_W, availH / BASE_H);

    // center horizontally, anchor to top (under HUD)
    const visualW = BASE_W * scale;
    const tx = (vw - visualW) / 2;
    const ty = topPad;

    canvas.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;

    BODY.setAttribute('data-orient', 'landscape');
    BODY.removeAttribute('data-fakeland');
    cta.classList.add('hide');
    if (mini) mini.style.display = 'block';
  }

  function layoutFakeLandscapeTop(){
    // For portrait-locked hosts: rotate + scale + position under HUD
    const vw = window.innerWidth, vh = window.innerHeight;
    const topPad = hudHeight() + 8;
    const availH = Math.max(0, vh - topPad);

    // After 90deg rotate, logical W maps to height, H to width
    const scale = Math.min(availH / BASE_W, vw / BASE_H);
    const rotatedW = BASE_H * scale;  // visual width on screen
    const tx = (vw - rotatedW) / 2;   // center horizontally
    const ty = topPad;                // anchor under HUD

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

  // ---------- CTA (try real landscape; if refused, clean fake-landscape) ----------
  const cta = document.createElement('button');
  cta.className = 'izzaland-cta';
  cta.type = 'button';
  cta.textContent = 'Rotate to landscape for best play';
  document.body.appendChild(cta);

  async function tryLockLandscape(){
    const el = document.documentElement;
    try { if (el.requestFullscreen) await el.requestFullscreen(); } catch{}
    try {
      if (screen.orientation?.lock) {
        await screen.orientation.lock('landscape');
        return true;
      }
    } catch(_){}
    return false;
  }

  async function attemptLandscapeFlow(){
    const locked = await tryLockLandscape();
    const checks = [120, 350, 800];
    for (const t of checks){
      await new Promise(r => setTimeout(r, t));
      if (isLandscape()){ layoutLandscapeTop(); return; }
    }
    // Host still portrait → fake it cleanly, top-anchored
    layoutFakeLandscapeTop();
  }
  cta.addEventListener('click', attemptLandscapeFlow, { passive:true });

  // ---------- reactive layout ----------
  let rafId = 0;
  const schedule = ()=>{ cancelAnimationFrame(rafId); rafId = requestAnimationFrame(apply); };
  function apply(){
    if (isLandscape()){
      layoutLandscapeTop();
    } else if (!BODY.hasAttribute('data-fakeland')) {
      // If we aren't in fake mode, return to portrait layout
      resetPortrait();
    } else {
      // In fake mode, recompute on size changes to keep it tidy
      layoutFakeLandscapeTop();
    }
  }

  window.addEventListener('resize', schedule, { passive:true });
  window.addEventListener('orientationchange', ()=>{ setTimeout(schedule,100); setTimeout(schedule,600); }, { passive:true });
  try { screen.orientation?.addEventListener('change', ()=> setTimeout(schedule,60), { passive:true }); } catch{}
  try {
    const mm = matchMedia('(orientation: landscape)');
    mm && (mm.addEventListener ? mm.addEventListener('change', schedule) : mm.addListener(schedule));
  } catch{}

  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', schedule, { once:true });
  } else {
    schedule();
  }

  log('plugin ready (top-anchored, real+fake landscape)');
})();
