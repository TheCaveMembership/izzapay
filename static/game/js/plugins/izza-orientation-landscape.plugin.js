<!-- /static/game/js/plugins/izza-orientation-landscape.plugin.js -->
(function(){
  const BASE_W = 960, BASE_H = 540;
  const BODY   = document.body;
  const CARD   = document.getElementById('gameCard');
  const CANVAS = document.getElementById('game');
  const HUD    = document.querySelector('.hud');
  const STICK  = document.getElementById('stick');
  const CTRLS  = document.querySelector('.controls');
  const MINI   = document.getElementById('miniWrap');
  if (!CARD || !CANVAS){ console.warn('[IZZA landscape] missing #gameCard/#game'); return; }

  // --- state: do nothing in portrait until user taps CTA
  let ACTIVE = false;

  const log = (...a)=>console.log('[IZZA landscape]', ...a);
  const vpW = ()=> (window.visualViewport?.width  || window.innerWidth);
  const vpH = ()=> (window.visualViewport?.height || window.innerHeight);
  const isLandscape = ()=>{
    try{ if (screen.orientation?.type?.startsWith('landscape')) return true; }catch{}
    try{ if (matchMedia('(orientation: landscape)').matches) return true; }catch{}
    return vpW() > vpH();
  };
  const hudH = ()=> Math.ceil(HUD?.getBoundingClientRect()?.height || 0);

  // ---------- CSS (scoped ONLY to active landscape modes) ----------
  (function injectCSS(){
    if (document.getElementById('izzaLandscapeCSS')) return;
    const css = `
      /* Nothing is overridden in portrait. All rules are gated by data-* flags. */

      /* Use full viewport and safe areas when rotated or faking */
      body[data-orient="landscape"], body[data-fakeland="1"]{ overflow:hidden; }

      /* Remove wrapper constraints so the stage can float */
      body[data-orient="landscape"] .wrap,
      body[data-fakeland="1"] .wrap{ max-width:none; padding:0; }

      /* Card becomes our full-viewport host only in landscape modes */
      body[data-orient="landscape"] #gameCard,
      body[data-fakeland="1"] #gameCard{
        position:fixed; inset:0; background:transparent; border:0; padding:0; margin:0; border-radius:0; z-index:1;
      }

      /* We control the canvas size ONLY in landscape modes */
      body[data-orient="landscape"] #game,
      body[data-fakeland="1"] #game{
        display:block; background:#000; image-rendering:pixelated;
        width:${BASE_W}px !important; height:${BASE_H}px !important;  /* portrait keeps your 100%/auto */
        transform-origin: top left; border-radius:0 !important;
      }

      /* HUD pinned at the top in landscape, unchanged in portrait */
      body[data-orient="landscape"] .hud,
      body[data-fakeland="1"] .hud{
        position:fixed; left:0; right:0; top:0; z-index:7;
      }

      /* Bottom dock (created only when ACTIVE) */
      #gameDock{
        position:fixed; left:0; right:0; bottom:0; z-index:6;
        background:rgba(10,12,18,.86); border-top:1px solid #2a3550;
        display:flex; align-items:center; justify-content:space-between; gap:12px; padding:10px 12px;
      }
      #gameDock .dock-left, #gameDock .dock-center, #gameDock .dock-right{ display:flex; align-items:center; gap:10px; }
      #gameDock .dock-center{ flex:1; justify-content:center; min-width:120px; }

      /* Move existing UI into the dock (only when the dock exists) */
      #gameDock #stick{ position:static !important; transform:none !important; width:120px; height:120px; }
      #gameDock .controls{ position:static !important; display:flex !important; flex-direction:column !important; gap:8px !important; }
      #gameDock .fire-wrap{ display:flex; flex-direction:column; align-items:center; gap:6px; }

      /* Minimap pinned near top-right in landscape */
      body[data-orient="landscape"] .mini,
      body[data-fakeland="1"] .mini{
        position:fixed !important; right:12px; top:74px; z-index:5; display:block !important;
      }

      /* CTA shown only in portrait (we toggle it) */
      .izzaland-cta{
        position:fixed; left:50%; bottom:18px; transform:translateX(-50%);
        padding:10px 14px; border-radius:10px; z-index:9999;
        background:rgba(0,0,0,.65); color:#fff; font:600 14px/1 system-ui,-apple-system,Segoe UI,Roboto,Arial;
        backdrop-filter: blur(6px) saturate(140%);
      }
      .izzaland-cta.hide{ display:none; }
    `;
    const tag = document.createElement('style');
    tag.id = 'izzaLandscapeCSS';
    tag.textContent = css;
    document.head.appendChild(tag);
  })();

  // ---------- helpers ----------
  function ensureDock(dockH){
    let dock = document.getElementById('gameDock');
    if (!dock){
      dock = document.createElement('div');
      dock.id = 'gameDock';
      dock.innerHTML = `
        <div class="dock-left"></div>
        <div class="dock-center"></div>
        <div class="dock-right"></div>`;
      document.body.appendChild(dock);
    }
    dock.style.height = dockH + 'px';
    return dock;
  }
  function moveUIIntoDock(dock){
    const left   = dock.querySelector('.dock-left');
    const center = dock.querySelector('.dock-center');
    const right  = dock.querySelector('.dock-right');

    if (STICK && STICK.parentNode !== left) left.appendChild(STICK);

    // Put FIRE (if found) in the center
    let fireBtn = Array.from(document.querySelectorAll('.controls .btn, .controls button'))
      .find(b => (b.textContent||'').trim().toLowerCase()==='fire');
    if (fireBtn){
      let wrap = center.querySelector('.fire-wrap');
      if (!wrap){ wrap = document.createElement('div'); wrap.className='fire-wrap'; center.appendChild(wrap); }
      if (fireBtn.parentNode !== wrap) wrap.appendChild(fireBtn);
    }
    if (CTRLS && CTRLS.parentNode !== right) right.appendChild(CTRLS);
  }
  function computeDockHeight(){
    const stickH = STICK?.getBoundingClientRect()?.height || 0;
    const btnsH  = CTRLS?.getBoundingClientRect()?.height || 0;
    return Math.max(120, Math.ceil(Math.max(stickH, btnsH) + 20));
  }
  function clearCanvas(){
    // When leaving landscape, restore portrait defaults
    CANVAS.style.transform = '';
    // width/height are scoped in CSS, so no need to set here for portrait
  }

  // ---------- layouts (run ONLY when ACTIVE) ----------
  function layoutReal(){
    if (!ACTIVE) return;
    clearCanvas();
    const vw = vpW(), vh = vpH();
    const top = hudH() + 8;
    const dockH = computeDockHeight();
    const dock  = ensureDock(dockH);
    moveUIIntoDock(dock);

    const availH = Math.max(0, vh - top - dockH);
    const scale = Math.min(vw / BASE_W, availH / BASE_H);

    const visualW = BASE_W * scale;
    const tx = Math.round((vw - visualW)/2);
    const ty = Math.round(top);

    CANVAS.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;

    BODY.setAttribute('data-orient','landscape');
    BODY.removeAttribute('data-fakeland');
    if (MINI) MINI.style.display='block';
  }

  function layoutFake(){
    if (!ACTIVE) return;
    clearCanvas();
    const vw = vpW(), vh = vpH();
    const top = hudH() + 8;
    const dockH = computeDockHeight();
    const dock  = ensureDock(dockH);
    moveUIIntoDock(dock);

    const availH = Math.max(0, vh - top - dockH);
    const scale = Math.min(availH / BASE_W, vw / BASE_H);
    const rotatedW = BASE_H * scale;
    const tx = Math.round((vw - rotatedW)/2);
    const ty = Math.round(top);

    CANVAS.style.transform = `translate(${tx}px, ${ty}px) rotate(90deg) scale(${scale})`;

    BODY.setAttribute('data-fakeland','1');
    BODY.removeAttribute('data-orient');
    if (MINI) MINI.style.display='block';
  }

  function resetPortrait(){
    clearCanvas();
    BODY.removeAttribute('data-orient');
    BODY.removeAttribute('data-fakeland');
    const dock = document.getElementById('gameDock');
    if (dock) dock.remove();
    cta.classList.remove('hide');
  }

  async function tryLock(){
    const el = document.documentElement;
    try{ if (el.requestFullscreen) await el.requestFullscreen(); }catch{}
    try{
      if (screen.orientation?.lock){ await screen.orientation.lock('landscape'); return true; }
    }catch(e){ log('lock failed', e?.name||e); }
    return false;
  }

  async function start(){
    ACTIVE = true;            // arm the plugin
    cta.classList.add('hide');
    const locked = await tryLock();
    // checkpoints to let URL bars settle
    const times=[120,350,800];
    for (const t of times){
      await new Promise(r=>setTimeout(r,t));
      if (isLandscape()){ layoutReal(); return; }
    }
    layoutFake();
  }

  // CTA button (portrait only)
  const cta = document.createElement('button');
  cta.className = 'izzaland-cta';
  cta.type = 'button';
  cta.textContent = 'Rotate to landscape for best play';
  document.body.appendChild(cta);
  cta.addEventListener('click', start, {passive:true});

  // Relayout (only if ACTIVE)
  let raf = 0;
  const schedule = ()=>{ cancelAnimationFrame(raf); raf = requestAnimationFrame(apply); };
  function apply(){
    if (!ACTIVE){ resetPortrait(); return; }
    if (BODY.hasAttribute('data-fakeland')) { layoutFake(); return; }
    if (isLandscape()) layoutReal(); else layoutFake();
  }

  window.addEventListener('resize', schedule, {passive:true});
  window.addEventListener('orientationchange', ()=>{ setTimeout(schedule,100); setTimeout(schedule,600); }, {passive:true});
  try{ screen.orientation?.addEventListener('change', ()=> setTimeout(schedule,60), {passive:true}); }catch{}
  try{
    const mm = matchMedia('(orientation: landscape)');
    mm && (mm.addEventListener ? mm.addEventListener('change', schedule) : mm.addListener(schedule));
  }catch{}

  // On initial load: NOT ACTIVE → leave portrait exactly as-is
  log('plugin ready (idle until user taps rotate CTA)');
})();
