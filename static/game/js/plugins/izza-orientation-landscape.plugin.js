<!-- /static/game/js/plugins/izza-orientation-landscape.plugin.js -->(function(){
  const BASE_W = 960, BASE_H = 540;   // canvas logical size
  const BODY   = document.body;
  const HUD    = document.querySelector('.hud');
  const CARD   = document.getElementById('gameCard');
  const CANVAS = document.getElementById('game');
  const STICK  = document.getElementById('stick');
  const CTRLS  = document.querySelector('.controls');
  const MINI   = document.getElementById('miniWrap');

  if (!HUD || !CARD || !CANVAS){ console.warn('[IZZA land] missing HUD/#gameCard/#game'); return; }

  let ACTIVE = false; // we only modify layout after user taps CTA

  // ------------------ CSS ------------------
  (function injectCSS(){
    if (document.getElementById('izzaLandCSS')) return;
    const css = `
      /* Portrait: do not touch your normal layout */
      /* All rules below act only after we create #izzaland-root (ACTIVE) */

      #izzaland-root{
        position:fixed; inset:0; z-index:9990;    /* above game chrome */
        transform-origin: top left;               /* rotate from top-left */
        pointer-events:auto;
      }
      #izzaland-layout{
        /* "Landscape logical canvas": width = game width, height = HUD + game + dock */
        display:flex; flex-direction:column;
        width: var(--land-w, 960px);
        height: var(--land-h, 640px);
        background: transparent;
      }

      /* Slots */
      #izzaland-hud{ flex:0 0 auto; }
      #izzaland-stage{
        flex:0 0 auto;
        display:flex; align-items:center; justify-content:center;
        height: ${BASE_H}px;
        background: transparent;
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

      /* Put existing UI into dock nicely */
      #izzaland-dock #stick{ position:static !important; transform:none !important; width:120px; height:120px; }
      #izzaland-dock .controls{ position:static !important; display:flex !important; flex-direction:column !important; gap:8px !important; }

      /* Make sure canvas uses its intrinsic size (we scale the WHOLE root) */
      #izzaland-stage #game{
        width:${BASE_W}px !important; height:${BASE_H}px !important;
        display:block; image-rendering:pixelated; transform:none !important;
        border-radius:0 !important; background:#000;
      }

      /* Minimap pinned inside rotated root */
      #izzaland-root .mini{
        position:absolute !important; right:12px; top:74px; z-index:5; display:block !important;
      }

      /* CTA shown in portrait only (before activating) */
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

  // -------------- DOM scaffold for rotated layout --------------
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

  function moveIntoRotatedRoot(){
    const root   = buildRoot();
    const layout = root.querySelector('#izzaland-layout');
    const slotHUD   = root.querySelector('#izzaland-hud');
    const slotStage = root.querySelector('#izzaland-stage');
    const slotDock  = root.querySelector('#izzaland-dock');
    const left   = slotDock.querySelector('.dock-left');
    const center = slotDock.querySelector('.dock-center');
    const right  = slotDock.querySelector('.dock-right');

    // Move HUD, stage/card, dock content
    if (HUD && HUD.parentNode !== slotHUD) slotHUD.appendChild(HUD);
    if (CARD && CARD.parentNode !== slotStage) slotStage.appendChild(CARD);

    // Controls into dock
    if (STICK && STICK.parentNode !== left) left.appendChild(STICK);
    if (CTRLS && CTRLS.parentNode !== right) right.appendChild(CTRLS);

    // Try to center the FIRE button (if present)
    const fireBtn = Array.from(CTRLS?.querySelectorAll('button,.btn')||[])
      .find(b => (b.textContent||'').trim().toLowerCase()==='fire');
    if (fireBtn){
      if (fireBtn.parentNode !== center) center.appendChild(fireBtn);
    }

    // Keep minimap inside rotated world
    if (MINI && MINI.parentNode !== root) root.appendChild(MINI);

    return root;
  }

  function computeDockH(){
    const dock = document.getElementById('izzaland-dock');
    if (!dock) return 140;
    // ensure stick/controls measured in portrait logical px (we scale the root later)
    const h = Math.max(120,
      Math.ceil(Math.max(
        (STICK?.getBoundingClientRect()?.height || 0),
        (CTRLS?.getBoundingClientRect()?.height || 0)
      ) + 20)
    );
    dock.style.height = h + 'px';
    return h;
  }

  // -------------- Layout math (full UI rotated 90°) --------------
  const vpW = ()=> (window.visualViewport?.width  || window.innerWidth);
  const vpH = ()=> (window.visualViewport?.height || window.innerHeight);

  function layoutPiFake(){
    if (!ACTIVE) return;

    const root = moveIntoRotatedRoot();

    // Measure HUD & dock AFTER they’re in the rotated structure (but before scaling)
    const hudH  = Math.ceil(document.getElementById('izzaland-hud')?.getBoundingClientRect()?.height || 0);
    const dockH = computeDockH();

    // Logical "landscape page" dimensions BEFORE rotation
    const landW = BASE_W;                // width: canvas width
    const landH = hudH + BASE_H + dockH; // height: HUD + canvas + dock

    // Fit that into the portrait viewport (we rotate root by 90deg):
    // After rotation, visual width = landH*s   must fit vpW()
    //                visual height = landW*s   must fit vpH()
    const vw = vpW(), vh = vpH();
    const s  = Math.min(vw / landH, vh / landW);

    // Center it
    const visW = landH * s;
    const visH = landW * s;
    const tx = Math.round((vw - visW)/2);
    const ty = Math.round((vh - visH)/2);

    // Apply variables and transform
    const layout = document.getElementById('izzaland-layout');
    layout.style.setProperty('--land-w', landW + 'px');
    layout.style.setProperty('--land-h', landH + 'px');

    root.style.transform = `translate(${tx}px, ${ty}px) rotate(90deg) scale(${s})`;

    // Hide page scroll behind the overlay
    BODY.style.overflow = 'hidden';
  }

  function resetPortrait(){
    // If user reloads or escapes, we just leave things in default DOM
    BODY.style.overflow = '';
    const root = document.getElementById('izzaland-root');
    if (root) root.style.transform = '';
  }

  // -------------- Activation (CTA) --------------
  const cta = document.createElement('button');
  cta.className = 'izzaland-cta';
  cta.type = 'button';
  cta.textContent = 'Rotate to landscape for best play';
  document.body.appendChild(cta);

  cta.addEventListener('click', ()=>{
    ACTIVE = true;
    cta.classList.add('hide');
    // Build & place once; then lay out and keep responsive
    moveIntoRotatedRoot();
    // iOS URL bars settle rhythms
    setTimeout(layoutPiFake, 80);
    setTimeout(layoutPiFake, 300);
    setTimeout(layoutPiFake, 800);
  }, {passive:true});

  // -------------- Keep responsive --------------
  let raf = 0;
  const schedule = ()=>{ cancelAnimationFrame(raf); raf = requestAnimationFrame(()=>{ if (ACTIVE) layoutPiFake(); }); };
  window.addEventListener('resize', schedule, {passive:true});
  window.addEventListener('orientationchange', ()=>{ setTimeout(schedule,100); setTimeout(schedule,600); }, {passive:true});
  try{ screen.orientation?.addEventListener('change', ()=> setTimeout(schedule,60), {passive:true}); }catch{}

  // Initial state: idle (portrait untouched)
  // If you ever want an exit button, we can add one that calls resetPortrait().
})();
