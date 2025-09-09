<!-- /static/game/js/plugins/izza-orientation-landscape.plugin.js -->
(function(){
  const BASE_W = 960, BASE_H = 540;        // your canvas' intrinsic size
  const BODY   = document.body;
  const canvas = document.getElementById('game');
  const mini   = document.getElementById('miniWrap');
  const log = (...a)=>console.log('[IZZA landscape]', ...a);

  if (!canvas){ console.warn('[IZZA landscape] #game canvas not found'); return; }

  // --- Inject CSS (landscape only; no fake-landscape styling) ---
  (function injectCSS(){
    if (document.getElementById('izzaLandscapeCSS')) return;
    const tag = document.createElement('style'); tag.id='izzaLandscapeCSS';
    tag.textContent = `
      /* Base reset */
      #game { display:block; background:#000; }

      /* Use the whole screen in real landscape */
      body[data-orient="landscape"]{
        overflow:hidden;
        padding: env(safe-area-inset-top) env(safe-area-inset-right)
                 env(safe-area-inset-bottom) env(safe-area-inset-left);
      }

      /* Remove wrapper constraints so stage can center full-bleed */
      body[data-orient="landscape"] .wrap { max-width:none; padding:0; }

      /* Card becomes a centered stage host in landscape */
      body[data-orient="landscape"] #gameCard{
        position:fixed; left:50%; top:50%;
        transform:translate(-50%,-50%);
        background:transparent; border:0; padding:0; margin:0; z-index:1;
        border-radius:0;
      }

      /* Scale canvas to fit viewport while preserving aspect */
      body[data-orient="landscape"] #game{
        width:${BASE_W}px !important;
        height:${BASE_H}px !important;
        transform-origin: top left;
        image-rendering: pixelated;
        border-radius:0;
      }

      /* HUD/controls/minimap pinned sensibly in landscape */
      body[data-orient="landscape"] .hud{ position:fixed; left:0; right:0; top:0; z-index:7; }
      body[data-orient="landscape"] .controls{
        position:fixed; right:14px; bottom:14px; display:flex; flex-direction:column; gap:10px; z-index:6;
      }
      body[data-orient="landscape"] .stick{
        position:fixed; left:14px; bottom:14px; transform:scale(1.1); transform-origin: bottom left; z-index:6;
      }
      body[data-orient="landscape"] .mini{
        position:fixed; right:12px; top:74px; bottom:auto; display:block; z-index:4;
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
    document.head.appendChild(tag);
  })();

  const isLandscape = ()=> window.innerWidth > window.innerHeight;

  // CTA (tap to try fullscreen+lock; if not, tell user to rotate)
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
        log('orientation locked to landscape');
        return true;
      }
    } catch(e){ log('orientation lock failed', e && e.name); }
    return false;
  }

  function layoutLandscapeScale(){
    const vw = window.innerWidth, vh = window.innerHeight;
    const scale = Math.min(vw / BASE_W, vh / BASE_H);

    canvas.style.width  = BASE_W + 'px';
    canvas.style.height = BASE_H + 'px';
    canvas.style.transform = `scale(${scale})`;

    BODY.setAttribute('data-orient', 'landscape');
    cta.classList.add('hide');
    if (mini) mini.style.display = 'block';
  }

  function resetPortrait(){
    canvas.style.transform = '';
    canvas.style.width  = '';
    canvas.style.height = '';
    BODY.removeAttribute('data-orient');
    cta.classList.remove('hide');
  }

  // Apply current layout
  let rafId = 0;
  const schedule = ()=>{ cancelAnimationFrame(rafId); rafId = requestAnimationFrame(apply); };

  function apply(){
    if (isLandscape()){
      layoutLandscapeScale();
    } else {
      // give iOS bars a moment to settle
      setTimeout(()=>{ isLandscape() ? layoutLandscapeScale() : resetPortrait(); }, 50);
    }
  }

  // On tap: try to lock; if not, ask user to rotate device
  cta.addEventListener('click', async ()=>{
    const locked = await tryLockLandscape();
    setTimeout(()=>{
      if (isLandscape()) {
        layoutLandscapeScale();
      } else if (locked) {
        // some webviews report portrait briefly; recheck shortly
        setTimeout(()=>{ if (isLandscape()) layoutLandscapeScale(); }, 250);
      } else {
        alert('Please rotate your phone to landscape for the best view.');
      }
    }, 120);
  }, { passive:true });

  // Listeners
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

  log('plugin ready (no fake-landscape)');
})();
