/* izza-orientation-landscape.plugin.js
   Fake-landscape for Pi Browser: rotate & scale a shared stage container
   so the canvas AND on-screen controls rotate together (no core changes).
*/
(function(){
  const BASE_W = 960, BASE_H = 540; // game logical size
  const BODY   = document.body;

  // === Choose a container that wraps the play area + HUD ===
  const STAGE_SELECTOR = '.wrap'; // <— change if your outer container uses a different selector
  const STAGE = document.querySelector(STAGE_SELECTOR) || document.getElementById('gameCard') || document.body;

  const card   = document.getElementById('gameCard');
  const canvas = document.getElementById('game');
  const mini   = document.getElementById('miniWrap');

  if (!STAGE || !canvas){ console.warn('[IZZA landscape] stage or #game missing'); return; }

  // ---------- CSS (once) ----------
  (function injectCSS(){
    if (document.getElementById('izzaLandscapeCSS')) return;
    const css = `
      /* Use full viewport while in fake landscape */
      body[data-fakeland="1"]{
        overflow:hidden;
        background:#0b0f17;
        padding: env(safe-area-inset-top) env(safe-area-inset-right)
                 env(safe-area-inset-bottom) env(safe-area-inset-left);
      }

      /* The stage gets rotated+scaled */
      ${STAGE_SELECTOR}{
        transform-origin: 50% 50%;
        will-change: transform;
      }
      body[data-fakeland="1"] ${STAGE_SELECTOR}{
        position:fixed; left:50%; top:50%;
        width:${BASE_W}px; height:${BASE_H}px; /* lock logical size */
        margin:0!important; padding:0!important; max-width:none!important;
        background:transparent!important; border:0!important; border-radius:0!important;
        z-index:3;
      }

      /* Keep the canvas at its intrinsic logical size */
      body[data-fakeland="1"] #game{
        width:${BASE_W}px !important;
        height:${BASE_H}px !important;
        display:block; image-rendering:pixelated; border-radius:0; background:#000;
      }
      /* If you keep a card wrapper, don’t let it add chrome */
      body[data-fakeland="1"] #gameCard{
        background:transparent!important; border:0!important; padding:0!important; margin:0!important; border-radius:0!important;
      }

      /* ---- control placements in fake-landscape ---- */

      /* Joystick bottom-left */
      body[data-fakeland="1"] #stick,
      body[data-fakeland="1"] .stick{
        position:fixed; left:14px; bottom:14px; right:auto; top:auto;
        transform:scale(1.1); transform-origin: bottom left; z-index:7;
      }

      /* Column of A / B / I / Map on the right edge */
      body[data-fakeland="1"] .controls{
        position:fixed; right:14px; bottom:14px;
        display:flex; flex-direction:column; gap:12px; z-index:7;
      }

      /* FIRE button centered lower third */
      body[data-fakeland="1"] #btnFire,
      body[data-fakeland="1"] .fire{
        position:fixed; left:50%; bottom:20%;
        transform:translateX(-50%); z-index:7;
      }

      /* Chat/type row along the bottom, full width */
      body[data-fakeland="1"] #chatRow,
      body[data-fakeland="1"] .chat-row,
      body[data-fakeland="1"] .composer{
        position:fixed;
        left:env(safe-area-inset-left);
        right:env(safe-area-inset-right);
        bottom:0; z-index:8;
      }

      /* Friends button just above chat on right */
      body[data-fakeland="1"] #friendsBtn,
      body[data-fakeland="1"] .friends{
        position:fixed; right:18px; bottom:64px; z-index:7;
      }

      /* Hearts + stars top-right */
      body[data-fakeland="1"] #heartsHud,
      body[data-fakeland="1"] #stars,
      body[data-fakeland="1"] .hud-right{
        position:fixed; right:16px; top:16px; z-index:6;
      }

      /* Minimap (if you want it visible in this mode) */
      body[data-fakeland="1"] .mini{
        position:fixed; right:12px; top:74px; bottom:auto; display:block; z-index:5;
      }

      /* CTA */
      .izzaland-cta{
        position:fixed; left:50%; bottom:18px; transform:translateX(-50%);
        padding:10px 14px; border-radius:10px;
        background:rgba(0,0,0,.65); color:#fff; font:600 14px/1.1 system-ui,-apple-system,Segoe UI,Roboto,Arial;
        z-index:9999; backdrop-filter:saturate(140%) blur(6px);
      }
      .izzaland-cta.hide{ display:none; }
    `;
    const tag = document.createElement('style'); tag.id='izzaLandscapeCSS'; tag.textContent = css;
    document.head.appendChild(tag);
  })();

  // ---------- rotate & scale the STAGE (includes canvas + HUD) ----------
  function fitLandscape(){
    const vw = window.innerWidth, vh = window.innerHeight;

    // After 90° CW rotation, visual width uses BASE_H, visual height uses BASE_W.
    const scale = Math.min(vw / BASE_H, vh / BASE_W);

    // Ensure known logical size so scaling is deterministic
    STAGE.style.width  = BASE_W + 'px';
    STAGE.style.height = BASE_H + 'px';

    // Rotate the whole stage (canvas + controls) so input space matches visuals
    STAGE.style.transform = `translate(-50%, -50%) rotate(90deg) scale(${scale})`;

    BODY.setAttribute('data-fakeland','1');
    if (mini) mini.style.display = 'block';
  }

  function clearLandscape(){
    BODY.removeAttribute('data-fakeland');
    STAGE.style.transform = '';
    STAGE.style.width  = '';
    STAGE.style.height = '';
  }

  // ---------- CTA button ----------
  const cta = document.createElement('button');
  cta.className = 'izzaland-cta';
  cta.type = 'button';
  cta.textContent = 'Rotate to landscape for best play';
  document.body.appendChild(cta);

  let active = false;
  const enter = ()=>{ active = true;  cta.classList.add('hide'); fitLandscape(); };
  const exit  = ()=>{ active = false; cta.classList.remove('hide'); clearLandscape(); };

  cta.addEventListener('click', enter, { passive:true });

  // ---------- keep scale correct on viewport changes ----------
  function onResize(){
    if (!active) return;
    requestAnimationFrame(()=> requestAnimationFrame(fitLandscape)); // let URL bars settle
  }
  window.addEventListener('resize', onResize, { passive:true });
  window.addEventListener('orientationchange', ()=> setTimeout(onResize,120), { passive:true });

  // Ready
  console.log('[IZZA landscape] plugin mounted, stage =', STAGE);
})();
