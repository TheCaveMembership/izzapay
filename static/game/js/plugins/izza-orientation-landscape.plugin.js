<!-- /static/game/js/plugins/izza-orientation-landscape.plugin.js -->
(function(){
  const BASE_W = 960, BASE_H = 540;     // canvas intrinsic size
  const BODY   = document.body;
  const CARD   = document.getElementById('gameCard');
  const CANVAS = document.getElementById('game');
  const HUD    = document.querySelector('.hud');
  const MINI   = document.getElementById('miniWrap');

  const log = (...a)=>console.log('[IZZA landscape]', ...a);
  if (!CANVAS || !CARD){ console.warn('[IZZA landscape] missing #game or #gameCard'); return; }

  // ---------- utils ----------
  function vpW(){ return (window.visualViewport && window.visualViewport.width)  || window.innerWidth; }
  function vpH(){ return (window.visualViewport && window.visualViewport.height) || window.innerHeight; }
  function isLandscape(){
    try { if (screen.orientation?.type?.startsWith('landscape')) return true; } catch {}
    try { if (matchMedia('(orientation: landscape)').matches) return true; } catch {}
    return vpW() > vpH();
  }
  function hudHeight(){
    try{ const r = HUD?.getBoundingClientRect(); return r ? Math.ceil(r.height) : 0; }catch{ return 0; }
  }
  function clearCanvasStyle(){
    CANVAS.style.transform = '';
    CANVAS.style.width  = BASE_W + 'px';
    CANVAS.style.height = BASE_H + 'px';
  }

  // ---------- CSS (override author rules & position layers) ----------
  (function injectCSS(){
    if (document.getElementById('izzaLandscapeCSS')) return;
    const css = `
      /* Kill width:100% / height:auto while we control layout */
      #game{ display:block; background:#000; width:${BASE_W}px !important; height:${BASE_H}px !important; image-rendering:pixelated; }

      /* Use full viewport and safe areas when rotated or faking */
      body[data-orient="landscape"], body[data-fakeland="1"]{
        overflow:hidden;
        padding: env(safe-area-inset-top) env(safe-area-inset-right)
                 env(safe-area-inset-bottom) env(safe-area-inset-left);
      }

      /* Let the stage float above page chrome */
      body[data-orient="landscape"] .wrap,
      body[data-fakeland="1"] .wrap{ max-width:none; padding:0; }

      /* The card is just a full-viewport host; no borders/radius */
      body[data-orient="landscape"] #gameCard,
      body[data-fakeland="1"] #gameCard{
        position:fixed; inset:0; background:transparent; border:0; padding:0; margin:0; border-radius:0; z-index:1;
      }

      /* We position the canvas with transforms; origin is top-left */
      body[data-orient="landscape"] #game,
      body[data-fakeland="1"] #game{ transform-origin: top left; border-radius:0 !important; }

      /* HUD pinned to top; keeps hearts/buttons where users expect */
      body[data-orient="landscape"] .hud,
      body[data-fakeland="1"] .hud{ position:fixed; left:0; right:0; top:0; z-index:7; }

      /* Controls & stick stay overlayed where they already are (fixed) */
      body[data-orient="landscape"] .controls,
      body[data-fakeland="1"] .controls{ position:fixed; right:14px; bottom:14px; z-index:6; display:flex; flex-direction:column; gap:10px; }
      body[data-orient="landscape"] .stick,
      body[data-fakeland="1"] .stick{ position:fixed; left:14px; bottom:14px; z-index:6; transform:scale(1.1); transform-origin: bottom left; }

      /* Minimap pinned near the top-right of the play area */
      body[data-orient="landscape"] .mini,
      body[data-fakeland="1"] .mini{ position:fixed; right:12px; top:74px; z-index:4; display:block !important; }

      /* CTA button for portrait */
      .izzaland-cta{
        position:fixed; left:50%; bottom:18px; transform:translateX(-50%);
        padding:10px 14px; border-radius:10px; z-index:9999;
        background:rgba(0,0,0,.65); color:#fff; font:600 14px/1 system-ui, -apple-system, Segoe UI, Roboto, Arial;
        backdrop-filter: blur(6px) saturate(140%);
      }
      .izzaland-cta.hide{ display:none; }
    `;
    const tag = document.createElement('style');
    tag.id = 'izzaLandscapeCSS';
    tag.textContent = css;
    document.head.appendChild(tag);
  })();

  // ---------- layouts ----------
  function layoutRealLandscape(){
    clearCanvasStyle();
    const vw = vpW(), vh = vpH();
    const topPad = hudHeight() + 8;           // sit just under HUD
    const availH = Math.max(0, vh - topPad);  // height available for the canvas

    const scale = Math.min(vw / BASE_W, availH / BASE_H);

    const visualW = BASE_W * scale;
    const tx = Math.round((vw - visualW) / 2);  // center horizontally
    const ty = Math.round(topPad);              // anchor under HUD

    CANVAS.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;

    BODY.setAttribute('data-orient', 'landscape');
    BODY.removeAttribute('data-fakeland');
    cta.classList.add('hide');
    if (MINI) MINI.style.display = 'block';
  }

  function layoutFakeLandscape(){
    clearCanvasStyle();
    const vw = vpW(), vh = vpH();
    const topPad = hudHeight() + 8;
    const availH = Math.max(0, vh - topPad);

    // After 90° rotation: logical W maps to height, H to width
    const scale = Math.min(availH / BASE_W, vw / BASE_H);
    const rotatedW = BASE_H * scale;                 // visual width on screen
    const tx = Math.round((vw - rotatedW) / 2);      // center horizontally
    const ty = Math.round(topPad);                   // anchor under HUD

    CANVAS.style.transform = `translate(${tx}px, ${ty}px) rotate(90deg) scale(${scale})`;

    BODY.setAttribute('data-fakeland', '1');
    BODY.removeAttribute('data-orient');
    cta.classList.add('hide');
    if (MINI) MINI.style.display = 'block';
  }

  function resetPortrait(){
    clearCanvasStyle();
    BODY.removeAttribute('data-orient');
    BODY.removeAttribute('data-fakeland');
    cta.classList.remove('hide');
  }

  // ---------- try to lock, else fake ----------
  async function tryLockLandscape(){
    const el = document.documentElement;
    try { if (el.requestFullscreen) await el.requestFullscreen(); } catch {}
    try {
      if (screen.orientation?.lock) {
        await screen.orientation.lock('landscape');
        return true;
      }
    } catch(e){ log('orientation lock failed', e?.name || e); }
    return false;
  }

  async function startFlow(){
    const locked = await tryLockLandscape();

    // Give bars a moment to animate; use multiple checkpoints
    const checkpoints = [120, 350, 800];
    for (const t of checkpoints){
      await new Promise(r => setTimeout(r, t));
      if (isLandscape()){ layoutRealLandscape(); return; }
    }
    // Host still portrait → clean fake
    layoutFakeLandscape();
  }

  // ---------- CTA ----------
  const cta = document.createElement('button');
  cta.className = 'izzaland-cta';
  cta.type = 'button';
  cta.textContent = 'Rotate to landscape for best play';
  document.body.appendChild(cta);
  cta.addEventListener('click', startFlow, { passive:true });

  // ---------- reactive relayout ----------
  let rafId = 0;
  const schedule = ()=>{ cancelAnimationFrame(rafId); rafId = requestAnimationFrame(apply); };

  function apply(){
    // Always recompute using visualViewport to avoid drift while bars hide/show
    if (BODY.hasAttribute('data-fakeland')){
      layoutFakeLandscape();             // keep fake mode stable on any resize
      return;
    }
    if (isLandscape()){
      layoutRealLandscape();
    } else {
      resetPortrait();
    }
  }

  window.addEventListener('resize', schedule, { passive:true });
  window.addEventListener('orientationchange', ()=>{ setTimeout(schedule,100); setTimeout(schedule,600); }, { passive:true });
  try { screen.orientation?.addEventListener('change', ()=> setTimeout(schedule,60), { passive:true }); } catch {}
  try {
    const mm = matchMedia('(orientation: landscape)');
    mm && (mm.addEventListener ? mm.addEventListener('change', schedule) : mm.addListener(schedule));
  } catch {}

  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', schedule, { once:true });
  } else {
    schedule();
  }

  log('plugin ready (centered, top-anchored; uses visualViewport; fake fallback)');
})();
