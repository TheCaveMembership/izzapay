<!-- /static/game/js/plugins/izza-orientation-landscape.plugin.js -->
(function(){
  const BASE_W = 960, BASE_H = 540; // your game’s logical size
  const BODY = document.body;
  const card   = document.getElementById('gameCard') || document.body;
  const canvas = document.getElementById('game');
  const mini   = document.getElementById('miniWrap');
  const log = (...a)=>console.log('[IZZA landscape]', ...a);

  if (!canvas){ console.warn('[IZZA landscape] #game canvas not found'); return; }

  // CSS
  (function injectCSS(){
    if (document.getElementById('izzaLandscapeCSS')) return;
    const tag = document.createElement('style'); tag.id='izzaLandscapeCSS';
    tag.textContent = `
      /* Base reset for our stage */
      #game { display:block; background:#000; }

      /* Landscape layout */
      body[data-orient="landscape"] #gameCard{
        position:fixed; left:50%; top:50%;
        transform:translate(-50%,-50%);
        background:transparent; border:0; padding:0; margin:0; z-index:1;
      }
      body[data-orient="landscape"] #game{
        width:${BASE_W}px!important; height:${BASE_H}px!important;
        transform-origin: top left;
        image-rendering: pixelated;
      }

      /* Fake landscape when device is portrait and we cannot lock */
      body[data-fakeland="1"] #gameCard{
        position:fixed; left:50%; top:50%;
        transform:translate(-50%,-50%);
        z-index:1;
      }
      body[data-fakeland="1"] #game{
        /* rotate the canvas 90deg, then scale to fit */
        transform-origin: top left;
      }

      /* Overlay button that appears only in portrait */
      .izzaland-cta{
        position:fixed; left:50%; bottom:18px; transform:translateX(-50%);
        padding:10px 14px; border-radius:10px;
        background:rgba(0,0,0,.65); color:#fff; font:600 14px/1.1 system-ui, -apple-system, Segoe UI, Roboto, Arial;
        z-index:9999; backdrop-filter:saturate(140%) blur(6px);
      }
      .izzaland-cta.hide{ display:none; }

      /* Keep HUD and controls above */
      body[data-orient="landscape"] .hud{ z-index:5; }
      body[data-orient="landscape"] .controls{
        position:fixed; right:14px; bottom:14px; display:flex; flex-direction:column; gap:10px; z-index:6;
      }
      body[data-orient="landscape"] .stick{
        position:fixed; left:14px; bottom:14px; transform:scale(1.1); transform-origin: bottom left; z-index:6;
      }
      body[data-orient="landscape"] .mini{
        position:fixed; right:12px; top:74px; bottom:auto; display:block; z-index:4;
      }
    `;
    document.head.appendChild(tag);
  })();

  // Helper state
  const isLandscape = ()=> window.innerWidth > window.innerHeight;

  // Create CTA once
  const cta = document.createElement('button');
  cta.className = 'izzaland-cta';
  cta.type = 'button';
  cta.textContent = 'Rotate to landscape for best play';
  document.body.appendChild(cta);

  async function tryLockLandscape(){
    // Must run on user gesture, and often must be in fullscreen
    const el = document.documentElement;
    try {
      if (el.requestFullscreen) await el.requestFullscreen();
    } catch(e){ /* ignore */ }

    try {
      if (screen.orientation && screen.orientation.lock) {
        await screen.orientation.lock('landscape');
        log('orientation locked to landscape');
        return true;
      }
    } catch(e){
      log('orientation lock failed', e && e.name);
    }
    return false;
  }

  function layoutLandscapeScale(){
    // True landscape layout, scale to fit
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
    // Rotate canvas 90deg and scale, used only when device is stuck in portrait
    // Work in CSS pixels to compute fit
    const vw = window.innerWidth, vh = window.innerHeight;

    // After rotation, canvas width maps to viewport height, and height maps to viewport width
    const scale = Math.min(vh / BASE_W, vw / BASE_H);

    canvas.style.width  = BASE_W + 'px';
    canvas.style.height = BASE_H + 'px';

    // Rotate around top-left, then translate so the rotated canvas centers nicely
    const rotatedW = BASE_H * scale; // because rotated, visual width = BASE_H
    const rotatedH = BASE_W * scale; // visual height = BASE_W
    const tx = (vw - rotatedW) / 2;
    const ty = (vh - rotatedH) / 2;

    canvas.style.transform = `translate(${tx}px, ${ty}px) rotate(90deg) scale(${scale})`;

    BODY.removeAttribute('data-orient');
    BODY.setAttribute('data-fakeland','1');
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

  // Main relayout
  let rafId = 0;
  function schedule(){ cancelAnimationFrame(rafId); rafId = requestAnimationFrame(apply); }

  function apply(){
    if (isLandscape()){
      layoutLandscapeScale();
    } else {
      // If we managed to lock earlier, some webviews still report portrait during bar animations,
      // so recheck a moment later too
      setTimeout(()=>{
        if (isLandscape()) layoutLandscapeScale();
        else resetPortrait();
      }, 50);
    }
  }

  // CTA click handler
  cta.addEventListener('click', async ()=>{
    const locked = await tryLockLandscape();
    // Give the browser a moment to reflow after bars hide
    setTimeout(()=>{
      if (isLandscape() || locked){
        layoutLandscapeScale();
      } else {
        // Fall back to fake landscape
        layoutFakeLandscape();
      }
    }, 120);
  }, { passive:true });

  // Orientation and resize listeners
  window.addEventListener('resize', schedule, { passive:true });
  window.addEventListener('orientationchange', ()=>{ setTimeout(schedule, 100); setTimeout(schedule, 600); }, { passive:true });
  try {
    if (screen.orientation){
      screen.orientation.addEventListener('change', ()=> setTimeout(schedule, 60), { passive:true });
    }
  } catch{}

  try {
    const mm = window.matchMedia('(orientation: landscape)');
    if (mm && mm.addEventListener) mm.addEventListener('change', schedule);
    else if (mm && mm.addListener) mm.addListener(schedule);
  } catch{}

  // First run
  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', schedule, { once:true });
  } else {
    schedule();
  }

  log('plugin ready');
})();
