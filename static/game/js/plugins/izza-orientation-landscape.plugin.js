/* izza-orientation-landscape.plugin.js
   Fake-landscape for Pi Browser: rotate + scale the stage (card), leave canvas intrinsic.
*/
(function(){
  const BASE_W = 960, BASE_H = 540;      // game’s logical size
  const BODY   = document.body;
  const card   = document.getElementById('gameCard');
  const canvas = document.getElementById('game');
  const mini   = document.getElementById('miniWrap');
  const log    = (...a)=>console.log('[IZZA landscape]', ...a);

  if (!card || !canvas){ console.warn('[IZZA landscape] missing #gameCard or #game'); return; }

  // ---------- CSS (once) ----------
  (function injectCSS(){
    if (document.getElementById('izzaLandscapeCSS')) return;
    const css = `
      /* Let us take the whole viewport and ignore the page chrome */
      body[data-fakeland="1"]{
        overflow:hidden;
        background:#0b0f17;
        padding: env(safe-area-inset-top) env(safe-area-inset-right)
                 env(safe-area-inset-bottom) env(safe-area-inset-left);
      }
      /* remove wrap max-width so centering works full bleed */
      body[data-fakeland="1"] .wrap{ max-width:none; padding:0; }

      /* center the stage container and make it transformable */
      #gameCard{
        will-change: transform;
        transform-origin:center center;
      }
      body[data-fakeland="1"] #gameCard{
        position:fixed; left:50%; top:50%;
        background:transparent; border:0; padding:0; margin:0;
        border-radius:0; z-index:3;
      }

      /* IMPORTANT: fix the canvas to its intrinsic stage size
         (prevents width:100% rules from other CSS messing us up) */
      body[data-fakeland="1"] #game{
        width:${BASE_W}px !important;
        height:${BASE_H}px !important;
        display:block;
        image-rendering:pixelated;
        border-radius:0;
        background:#000;
      }

      /* HUD / controls above the stage in fake-landscape */
      body[data-fakeland="1"] .hud{ z-index:6; }
      body[data-fakeland="1"] .controls{
        position:fixed; right:14px; bottom:14px;
        display:flex; flex-direction:column; gap:10px; z-index:7;
      }
      body[data-fakeland="1"] .stick{
        position:fixed; left:14px; bottom:14px;
        transform:scale(1.1); transform-origin: bottom left; z-index:7;
      }
      body[data-fakeland="1"] .mini{
        position:fixed; right:12px; top:74px; bottom:auto; display:block; z-index:5;
      }

      /* tiny CTA */
      .izzaland-cta{
        position:fixed; left:50%; bottom:18px; transform:translateX(-50%);
        padding:10px 14px; border-radius:10px;
        background:rgba(0,0,0,.65); color:#fff; font:600 14px/1.1 system-ui,-apple-system,Segoe UI,Roboto,Arial;
        z-index:9999; backdrop-filter:saturate(140%) blur(6px);
      }
      .izzaland-cta.hide{ display:none; }
    `;
    const tag = document.createElement('style');
    tag.id = 'izzaLandscapeCSS';
    tag.textContent = css;
    document.head.appendChild(tag);
  })();

  // ---------- helper: compute transforms on the CONTAINER ----------
  function fitLandscapeOnCard(){
    // viewport (CSS px). we rotate 90deg, so stage width/height swap visually.
    const vw = window.innerWidth, vh = window.innerHeight;

    // After rotation: visible width uses BASE_H, visible height uses BASE_W.
    const scale = Math.min(vw / BASE_H, vh / BASE_W);

    // Make sure the child canvas has its intrinsic size
    canvas.style.width  = BASE_W + 'px';
    canvas.style.height = BASE_H + 'px';

    // Set a known “unscaled” size on the container so scaling is deterministic
    card.style.width  = BASE_W + 'px';
    card.style.height = BASE_H + 'px';

    // Rotate the container 90deg and scale; since we fixed it at 50/50 with origin center,
    // this cleanly centers it without any extra translate math.
    card.style.transform = `translate(-50%, -50%) rotate(90deg) scale(${scale})`;

    // mode flags
    BODY.setAttribute('data-fakeland','1');
    if (mini) mini.style.display = 'block';
  }

  function clearLandscape(){
    BODY.removeAttribute('data-fakeland');

    // remove transforms/sizes so portrait layout returns to normal
    card.style.transform = '';
    card.style.width  = '';
    card.style.height = '';

    canvas.style.width  = '';
    canvas.style.height = '';
  }

  // ---------- button (no orientation API; Pi stays portrait) ----------
  const cta = document.createElement('button');
  cta.className = 'izzaland-cta';
  cta.type = 'button';
  cta.textContent = 'Rotate to landscape for best play';
  document.body.appendChild(cta);

  let active = false;
  function enter(){
    active = true;
    cta.classList.add('hide');
    fitLandscapeOnCard();
  }
  function exit(){
    active = false;
    cta.classList.remove('hide');
    clearLandscape();
  }

  cta.addEventListener('click', enter, { passive:true });

  // If the user taps Map or opens a modal, we keep it—nothing special needed.
  // You can add your own toggle to exit() if you want a “Back to portrait” control.

  // ---------- keep scale correct on viewport changes ----------
  function onResize(){
    if (!active) return;
    // after URL bars settle
    requestAnimationFrame(()=> requestAnimationFrame(fitLandscapeOnCard));
  }

  window.addEventListener('resize', onResize, { passive:true });
  window.addEventListener('orientationchange', ()=> setTimeout(onResize, 120), { passive:true });

  // run once so CTA shows
  log('plugin mounted');
})();
