// izza-orientation-landscape.plugin.js
(function(){
  const BASE_W = 960, BASE_H = 540; // your canvas intrinsic size
  const BODY = document.body;
  const card = document.getElementById('gameCard');
  const canvas = document.getElementById('game');
  const controls = document.querySelector('.controls');
  const stick = document.getElementById('stick');
  const mini = document.getElementById('miniWrap');

  // Inject CSS overrides only once
  (function injectCSS(){
    if (document.getElementById('izzaLandscapeCSS')) return;
    const css = `
    /* Orientation state flag */
    body[data-orient="landscape"] { overflow:hidden; }

    /* Make gameCard a centered stage in landscape; scale is handled via JS */
    body[data-orient="landscape"] #gameCard{
      position:fixed; left:50%; top:50%;
      transform:translate(-50%,-50%);
      background:transparent; border:none; padding:0; margin:0;
      z-index:1; /* under HUD, over background */
    }
    body[data-orient="landscape"] #game{
      display:block; image-rendering:pixelated;
      transform-origin: top left; /* we apply transform:scale(s) via JS */
      background:#000;
    }

    /* HUD stays as-is; just ensure it sits above */
    body[data-orient="landscape"] .hud{ z-index:5; }

    /* Controls: stack vertically on the right */
    body[data-orient="landscape"] .controls{
      position:fixed; right:14px; bottom:14px;
      flex-direction:column; gap:10px; z-index:6;
    }
    /* Joystick: keep bottom-left, slightly larger */
    body[data-orient="landscape"] .stick{
      position:fixed; left:14px; bottom:14px; transform:scale(1.1);
      transform-origin: bottom left; z-index:6;
    }

    /* Minimap: move to top-right in landscape */
    body[data-orient="landscape"] .mini{
      position:fixed; right:12px; top:74px; bottom:auto; display:block; z-index:4;
    }

    /* Optional: shrink pill buttons a hair to free space */
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

    // Reset any transforms in portrait so the page behaves normally
    if (!landscape){
      canvas.style.transform = '';
      card.style.width = '';
      card.style.height = '';
      return;
    }

    // Compute best-fit scale for the intrinsic canvas size
    const vw = window.innerWidth, vh = window.innerHeight;
    const scale = Math.min(vw / BASE_W, vh / BASE_H);

    // Stage is the intrinsic size; we scale the canvas with CSS transform
    card.style.width = BASE_W + 'px';
    card.style.height = BASE_H + 'px';
    canvas.style.transform = `scale(${scale})`;

    // Ensure controls/minimap show in landscape
    if (mini) mini.style.display = 'block';
  }

  // Re-apply on load, resize, and orientation changes
  let rafId = null;
  function schedule(){ cancelAnimationFrame(rafId); rafId = requestAnimationFrame(applyStageSize); }
  window.addEventListener('resize', schedule, { passive:true });
  window.addEventListener('orientationchange', schedule, { passive:true });

  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', schedule, { once:true });
  } else {
    schedule();
  }
})();
