<!-- /static/game/js/plugins/izza-orientation-landscape.plugin.js -->
(function(){
  const BASE_W = 960, BASE_H = 540;
  const BODY = document.body;
  const card = document.getElementById('gameCard');
  const canvas = document.getElementById('game');
  const mini = document.getElementById('miniWrap');
  const log = (...a)=>console.log('[IZZA landscape]', ...a);

  // Inject CSS overrides once
  (function injectCSS(){
    if (document.getElementById('izzaLandscapeCSS')) return;
    const css = `
      body[data-orient="landscape"] { overflow:hidden; }
      body[data-orient="landscape"] #gameCard{
        position:fixed; left:50%; top:50%;
        transform:translate(-50%,-50%);
        background:transparent; border:none; padding:0; margin:0; z-index:1;
      }
      /* IMPORTANT: cancel width:100%/height:auto while in landscape */
      body[data-orient="landscape"] #game{
        width:${BASE_W}px !important;
        height:${BASE_H}px !important;
        display:block; image-rendering:pixelated;
        transform-origin: top left;
        background:#000;
      }
      body[data-orient="landscape"] .hud{ z-index:5; }
      body[data-orient="landscape"] .controls{
        position:fixed; right:14px; bottom:14px; flex-direction:column; gap:10px; z-index:6;
      }
      body[data-orient="landscape"] .stick{
        position:fixed; left:14px; bottom:14px; transform:scale(1.1); transform-origin: bottom left; z-index:6;
      }
      body[data-orient="landscape"] .mini{
        position:fixed; right:12px; top:74px; bottom:auto; display:block; z-index:4;
      }
      body[data-orient="landscape"] .btn{ padding:9px 10px; font-size:13px; }
    `;
    const tag = document.createElement('style');
    tag.id = 'izzaLandscapeCSS';
    tag.textContent = css;
    document.head.appendChild(tag);
  })();

  function isLandscape(){ return window.innerWidth > window.innerHeight; }

  function applyStageSize(){
    if (!canvas || !card) return;
    const landscape = isLandscape();
    BODY.setAttribute('data-orient', landscape ? 'landscape' : 'portrait');

    if (!landscape){
      // Reset for portrait
      canvas.style.transform = '';
      card.style.width = '';
      card.style.height = '';
      return;
    }

    // Ensure intrinsic size (defeats #game { width:100% } rule)
    canvas.style.width  = BASE_W + 'px';
    canvas.style.height = BASE_H + 'px';

    // Compute best-fit scale
    const vw = window.innerWidth, vh = window.innerHeight;
    const scale = Math.min(vw / BASE_W, vh / BASE_H);

    card.style.width = BASE_W + 'px';
    card.style.height = BASE_H + 'px';
    canvas.style.transform = `scale(${scale})`;

    if (mini) mini.style.display = 'block';
  }

  // Run now and on changes (with a tiny debounce/raf)
  let rafId = 0;
  const schedule = () => { cancelAnimationFrame(rafId); rafId = requestAnimationFrame(applyStageSize); };

  // Core events
  window.addEventListener('resize', schedule, { passive:true });
  window.addEventListener('orientationchange', ()=>{
    schedule();
    // run again after chrome/url bars settle
    setTimeout(schedule, 250);
    setTimeout(schedule, 700);
  }, { passive:true });

  // Screen Orientation API (some webviews fire only this)
  try {
    if (screen.orientation) {
      screen.orientation.addEventListener('change', ()=>{
        schedule();
        setTimeout(schedule, 250);
      }, { passive:true });
    }
  } catch {}

  // MatchMedia fallback (very reliable)
  try {
    const mm = window.matchMedia('(orientation: landscape)');
    mm.addEventListener ? mm.addEventListener('change', schedule) : mm.addListener(schedule);
  } catch {}

  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', schedule, { once:true });
  } else {
    schedule();
  }

  log('plugin loaded');
})();
