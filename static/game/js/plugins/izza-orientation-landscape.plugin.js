/* izza-orientation-landscape.plugin.js
   Fake-landscape for Pi Browser by rotating ONE overlay that contains:
   #gameCard, .hud, #stick, .controls, #miniWrap
   No other files are changed.
*/
(function () {
  const BASE_W = 960, BASE_H = 540; // intrinsic canvas size
  const BODY    = document.body;
  const hud     = document.querySelector('.hud');
  const card    = document.getElementById('gameCard');
  const canvas  = document.getElementById('game');
  const stick   = document.getElementById('stick');
  const ctrls   = document.querySelector('.controls');
  const mini    = document.getElementById('miniWrap');

  if (!card || !canvas || !stick || !ctrls || !hud) {
    console.warn('[IZZA landscape] required nodes missing');
    return;
  }

  // --- one-time CSS ----------------------------------------------------------
  (function injectCSS () {
    if (document.getElementById('izzaLandscapeCSS')) return;
    const tag = document.createElement('style');
    tag.id = 'izzaLandscapeCSS';
    tag.textContent = `
      /* page state flag */
      body[data-fakeland="1"]{ overflow:hidden; background:#0b0f17; }

      /* overlay that we rotate+scale as a single unit */
      #izzaLandStage{
        position:fixed; left:50%; top:50%;
        width:${BASE_W}px; height:${BASE_H}px;
        transform-origin:center center;
        z-index:999; /* above normal layout, below modals */
        pointer-events:none; /* children re-enable as needed */
      }
      #izzaLandStage > *{ pointer-events:auto; }

      /* keep canvas intrinsic so scaling is deterministic */
      #izzaLandStage #game{ width:${BASE_W}px !important; height:${BASE_H}px !important; }

      /* layout inside the rotated stage */
      #izzaLandStage .hud{
        position:absolute; left:12px; right:12px; top:8px;
        background:rgba(10,12,18,.60);
        border-bottom:1px solid #263042; border-radius:10px; padding:6px 8px;
      }

      #izzaLandStage .controls{
        position:absolute; right:14px; bottom:14px;
        display:flex; flex-direction:column; gap:10px;
      }

      #izzaLandStage #stick{
        position:absolute; left:14px; bottom:14px;
        width:120px; height:120px;
      }

      #izzaLandStage #miniWrap{
        position:absolute; right:12px; top:74px;
        display:block;
      }

      /* CTA button in portrait (before entering fake-landscape) */
      .izzaland-cta{
        position:fixed; left:50%; bottom:18px; transform:translateX(-50%);
        padding:10px 14px; border-radius:10px;
        background:rgba(0,0,0,.65); color:#fff;
        font:600 14px/1.1 system-ui,-apple-system,Segoe UI,Roboto,Arial;
        z-index:1000; backdrop-filter:saturate(140%) blur(6px);
      }
      .izzaland-cta.hide{ display:none; }
    `;
    document.head.appendChild(tag);
  })();

  // --- create the stage overlay & placeholders -------------------------------
  const stage = document.createElement('div');
  stage.id = 'izzaLandStage';

  // placeholders to restore DOM on exit
  const ph = {
    hud:  document.createComment('ph-hud'),
    card: document.createComment('ph-card'),
    stick:document.createComment('ph-stick'),
    ctrls:document.createComment('ph-ctrls'),
    mini: document.createComment('ph-mini')
  };

  function moveIntoStage () {
    hud.parentNode.insertBefore(ph.hud, hud);
    card.parentNode.insertBefore(ph.card, card);
    stick.parentNode.insertBefore(ph.stick, stick);
    ctrls.parentNode.insertBefore(ph.ctrls, ctrls);
    mini.parentNode.insertBefore(ph.mini, mini);

    stage.appendChild(card);
    stage.appendChild(hud);
    stage.appendChild(stick);
    stage.appendChild(ctrls);
    stage.appendChild(mini);
    document.body.appendChild(stage);
  }

  function restoreFromStage () {
    try { ph.card.parentNode.insertBefore(card, ph.card); ph.card.remove(); } catch {}
    try { ph.hud.parentNode.insertBefore(hud, ph.hud);   ph.hud.remove(); } catch {}
    try { ph.stick.parentNode.insertBefore(stick, ph.stick); ph.stick.remove(); } catch {}
    try { ph.ctrls.parentNode.insertBefore(ctrls, ph.ctrls); ph.ctrls.remove(); } catch {}
    try { ph.mini.parentNode.insertBefore(mini, ph.mini); ph.mini.remove(); } catch {}
    try { stage.remove(); } catch {}
  }

  // --- math for fit+rotation on the overlay (not the canvas) -----------------
  function applyLayout () {
    // viewport size in CSS px
    const vw = window.innerWidth, vh = window.innerHeight;

    // After 90deg rotation, the visual width uses BASE_H and visual height uses BASE_W
    const scale = Math.min(vw / BASE_H, vh / BASE_W);

    stage.style.transform = `translate(-50%, -50%) rotate(90deg) scale(${scale})`;

    // keep child sizes deterministic
    canvas.style.width  = BASE_W + 'px';
    canvas.style.height = BASE_H + 'px';
  }

  // --- enter/exit ------------------------------------------------------------
  let active = false;

  function enterFakeLandscape () {
    if (active) return;
    active = true;

    BODY.setAttribute('data-fakeland','1');
    moveIntoStage();
    applyLayout();
    cta.classList.add('hide');
  }

  function exitFakeLandscape () {
    if (!active) return;
    active = false;

    BODY.removeAttribute('data-fakeland');
    restoreFromStage();

    // clear any transforms/sizes we applied
    stage.style.transform = '';
    canvas.style.width = canvas.style.height = '';
    cta.classList.remove('hide');
  }

  // --- CTA trigger -----------------------------------------------------------
  const cta = document.createElement('button');
  cta.className = 'izzaland-cta';
  cta.type = 'button';
  cta.textContent = 'Rotate to landscape for best play';
  document.body.appendChild(cta);

  cta.addEventListener('click', enterFakeLandscape, { passive:true });

  // --- keep scale correct when viewport changes ------------------------------
  function onResize () {
    if (!active) return;
    // double RAF to wait for browser UI bars to settle
    requestAnimationFrame(() => requestAnimationFrame(applyLayout));
  }
  window.addEventListener('resize', onResize, { passive:true });
  window.addEventListener('orientationchange', () => setTimeout(onResize, 120), { passive:true });

  console.log('[IZZA landscape] ready');
})();
