/* /static/game/js/plugins/izza-orientation-landscape.plugin.js
   Fake-landscape for Pi Browser (no device rotation).
   Rotates/scales: .hud + #gameCard (#game) + .controls + #stick
   Leaves map UIs alone: #miniWrap (minimap) and #mapModal untouched.
*/
(function(){
  const BASE_W = 960, BASE_H = 540;   // your canvas logical size
  const BODY   = document.body;

  // Pieces we will rotate (ONLY these):
  const HUD    = document.querySelector('.hud');
  const CARD   = document.getElementById('gameCard');
  const CANVAS = document.getElementById('game');
  const STICK  = document.getElementById('stick');
  const CTRLS  = document.querySelector('.controls');

  if (!HUD || !CARD || !CANVAS || !STICK || !CTRLS) {
    console.warn('[IZZA land] missing a required element (hud/card/game/stick/controls)');
    return;
  }

  // We will NOT touch these (so the Map/minimap continue to behave as today):
  // const MINI = document.getElementById('miniWrap');      // minimap (left alone)
  // const MAPM = document.getElementById('mapModal');      // big map modal (left alone)

  let ACTIVE = false;

  // ---------- CSS ----------
  (function injectCSS(){
    if (document.getElementById('izzaLandCSS')) return;
    const css = `
      /* Only applies after the root exists (after CTA) */
      #izzaland-root{
        position:fixed; inset:0; z-index:9990;
        transform-origin: top left;
        pointer-events:auto;
      }
      #izzaland-layout{
        display:flex; flex-direction:column;
        width: var(--land-w, ${BASE_W}px);
        height: var(--land-h, ${BASE_H + 140}px);
        background: transparent;
      }
      #izzaland-hud{ flex:0 0 auto; }
      #izzaland-stage{
        flex:0 0 auto;
        display:flex; align-items:center; justify-content:center;
        height:${BASE_H}px;
        background:transparent;
      }
      #izzaland-dock{
        flex:0 0 auto;
        display:flex; align-items:center; justify-content:space-between; gap:12px;
        background:rgba(10,12,18,.86); border-top:1px solid #2a3550;
        padding:10px 12px;
      }
      #izzaland-dock .dock-left,
      #izzaland-dock .dock-center,
      #izzaland-dock .dock-right{ display:flex; align-items:center; gap:10px; }
      #izzaland-dock .dock-center{ flex:1; justify-content:center; min-width:120px; }

      /* Make sure the canvas uses its intrinsic size; we scale the WHOLE root */
      #izzaland-stage #game{
        width:${BASE_W}px !important; height:${BASE_H}px !important;
        display:block; image-rendering:pixelated; transform:none !important;
        background:#000; border-radius:0 !important;
      }

      /* Put your existing UI into the bottom dock (inside the rotated root) */
      #izzaland-dock #stick{ position:static !important; transform:none !important; width:120px; height:120px; }
      #izzaland-dock .controls{ position:static !important; display:flex !important; flex-direction:column !important; gap:8px !important; }

      /* CTA shown in portrait only, before user opts in */
      .izzaland-cta{
        position:fixed; left:50%; bottom:18px; transform:translateX(-50%);
        padding:10px 14px; border-radius:10px; z-index:9999;
        background:rgba(0,0,0,.65); color:#fff; font:600 14px/1 system-ui,-apple-system,Segoe UI,Roboto,Arial;
        backdrop-filter: blur(6px) saturate(140%);
      }
      .izzaland-cta.hide{ display:none; }
    `;
    const tag = document.createElement('style');
    tag.id = 'izzaLandCSS';
    tag.textContent = css;
    document.head.appendChild(tag);
  })();

  // ---------- DOM scaffold ----------
  function buildRoot(){
    let root = document.getElementById('izzaland-root');
    if (root) return root;
    root = document.createElement('div');
    root.id = 'izzaland-root';
    root.innerHTML = `
      <div id="izzaland-layout">
        <div id="izzaland-hud"></div>
        <div id="izzaland-stage"></div>
        <div id="izzaland-dock">
          <div class="dock-left"></div>
          <div class="dock-center"></div>
          <div class="dock-right"></div>
        </div>
      </div>`;
    document.body.appendChild(root);
    return root;
  }

  function moveIntoRoot(){
    const root   = buildRoot();
    const slotHUD   = root.querySelector('#izzaland-hud');
    const slotStage = root.querySelector('#izzaland-stage');
    const dock      = root.querySelector('#izzaland-dock');
    const left   = dock.querySelector('.dock-left');
    const center = dock.querySelector('.dock-center');
    const right  = dock.querySelector('.dock-right');

    if (HUD && HUD.parentNode !== slotHUD) slotHUD.appendChild(HUD);
    if (CARD && CARD.parentNode !== slotStage) slotStage.appendChild(CARD);
    if (STICK && STICK.parentNode !== left) left.appendChild(STICK);
    if (CTRLS && CTRLS.parentNode !== right) right.appendChild(CTRLS);

    // Try to place the FIRE button (if it is one of the .controls children) in the center
    const fireBtn = Array.from(CTRLS.querySelectorAll('button,.btn')).find(b => (b.textContent||'').trim().toLowerCase()==='fire');
    if (fireBtn && fireBtn.parentNode !== center) center.appendChild(fireBtn);

    return root;
  }

  function computeDockHeight(){
    const dock = document.getElementById('izzaland-dock');
    if (!dock) return 140;
    const h = Math.max(120,
      Math.ceil(Math.max(
        (STICK.getBoundingClientRect().height || 0),
        (CTRLS.getBoundingClientRect().height || 0)
      ) + 20)
    );
    dock.style.height = h + 'px';
    return h;
  }

  // ---------- Layout math (rotate whole UI 90°) ----------
  const vpW = ()=> (window.visualViewport?.width  || window.innerWidth);
  const vpH = ()=> (window.visualViewport?.height || window.innerHeight);

  function layout(){
    if (!ACTIVE) return;
    const root = moveIntoRoot();

    // Measure HUD + dock (after mounted in rotated structure)
    const hudH  = Math.ceil(document.getElementById('izzaland-hud')?.getBoundingClientRect()?.height || 0);
    const dockH = computeDockHeight();

    // Logical “landscape page” dimensions before rotation:
    const landW = BASE_W;                  // width: canvas width
    const landH = hudH + BASE_H + dockH;   // height: HUD + canvas + dock

    // Fit into portrait viewport after rotating root:
    // visual width = landH*s must fit vpW(); visual height = landW*s must fit vpH()
    const vw = vpW(), vh = vpH();
    const s  = Math.min(vw / landH, vh / landW);

    const visW = landH * s, visH = landW * s;
    const tx = Math.round((vw - visW)/2);
    const ty = Math.round((vh - visH)/2);

    const layout = document.getElementById('izzaland-layout');
    layout.style.setProperty('--land-w', landW + 'px');
    layout.style.setProperty('--land-h', landH + 'px');

    root.style.transform = `translate(${tx}px, ${ty}px) rotate(90deg) scale(${s})`;

    BODY.style.overflow = 'hidden';
  }

  // ---------- Activation (CTA) ----------
  const cta = document.createElement('button');
  cta.className = 'izzaland-cta';
  cta.type = 'button';
  cta.textContent = 'Rotate to landscape for best play';
  document.body.appendChild(cta);

  cta.addEventListener('click', ()=>{
    ACTIVE = true;
    cta.classList.add('hide');
    moveIntoRoot();
    setTimeout(layout, 80);
    setTimeout(layout, 300);
    setTimeout(layout, 800);
  }, {passive:true});

  // ---------- Keep responsive ----------
  let raf = 0;
  const schedule = ()=>{ cancelAnimationFrame(raf); raf = requestAnimationFrame(layout); };
  window.addEventListener('resize', schedule, {passive:true});
  window.addEventListener('orientationchange', ()=>{ setTimeout(schedule,100); setTimeout(schedule,600); }, {passive:true});
  try{ screen.orientation?.addEventListener('change', ()=> setTimeout(schedule,60), {passive:true}); }catch{}
})();
