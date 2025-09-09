/* izza-orientation-landscape.plugin.js
   One rotated+scaled overlay; plus a small Full/Exit toggle above Map. */
(function () {
  const BASE_W = 960, BASE_H = 540;     // canvas intrinsic
  const BODY   = document.body;
  const card   = document.getElementById('gameCard');
  const canvas = document.getElementById('game');
  const hud    = document.querySelector('.hud');
  const stick  = document.getElementById('stick');
  const ctrls  = document.querySelector('.controls');
  const mini   = document.getElementById('miniWrap');
  if (!card || !canvas || !hud || !stick || !ctrls) return;

  // --- FIRE tile offsets (from screen center inside the stage) ---
  const TILE = 60;                 // 960×540 → 16×9 → 60px tiles
  const FIRE_TILES_RIGHT = 7;
  const FIRE_TILES_DOWN  = 1;

  // ---------- CSS (only for moved things) ----------
  (function injectCSS(){
    if (document.getElementById('izzaLandscapeCSS')) return;
    const css = `
      body[data-fakeland="1"]{ overflow:hidden; background:#0b0f17; }

      /* The rotated stage that holds the play layer */
      #izzaLandStage{
        position:fixed; left:50%; top:50%;
        width:${BASE_W}px; height:${BASE_H}px;
        transform-origin:center center;
        z-index:15; pointer-events:none;
      }
      #izzaLandStage > *{ pointer-events:auto; }

      /* keep canvas intrinsic */
      #izzaLandStage #game{ width:${BASE_W}px !important; height:${BASE_H}px !important; display:block; }

      /* HUD, ABIM row */
      #izzaLandStage .hud{ position:absolute; left:12px; right:12px; top:8px; }
      #izzaLandStage .controls{ position:absolute; right:14px; bottom:14px; display:flex; gap:10px; }

      /* Joystick: larger + counter-rotate local space so axes feel correct */
      #izzaLandStage #stick{
        position:absolute; left:14px; bottom:14px;
        width:150px; height:150px;
        transform:rotate(90deg);              /* cancels stage rotation for input */
        transform-origin:center center;
      }
      #izzaLandStage #stick .nub{
        left:50% !important; top:50% !important;
        transform:translate(-50%,-50%) !important;
        width:44px !important; height:44px !important;
      }

      /* Minimap */
      #izzaLandStage #miniWrap{ position:absolute; right:12px; top:74px; display:block; }

      /* Chat bar pinned along the bottom (upright text) */
      #izzaLandStage #chatBar{
        position:absolute !important; left:12px; right:12px; bottom:8px;
        transform:rotate(-90deg); transform-origin:left bottom;
      }

      /* Hearts; bell/badge/dropdown inside stage coords; friends upright */
      #izzaLandStage #heartsHud{ position:absolute !important; left:14px; top:54px; }
      #izzaLandStage #mpNotifBell{ position:absolute !important; right:14px; top:12px; }
      #izzaLandStage #mpNotifBadge{ position:absolute !important; right:6px;  top:4px;  }
      #izzaLandStage #mpNotifDropdown{
        position:absolute !important; right:10px; top:44px; max-height:300px;
        transform:rotate(-90deg); transform-origin:top right;
      }
      #izzaLandStage #mpFriendsToggleGlobal{
        position:absolute !important; right:14px !important; bottom:72px !important;
        top:auto !important; left:auto !important;
      }
      #izzaLandStage #mpFriendsPopup{
        position:absolute !important; right:14px !important; bottom:116px !important;
        top:auto !important; left:auto !important;
        transform:rotate(-90deg); transform-origin:right bottom;
      }

      /* FIRE button (tile-placed via JS) */
      #izzaLandStage #btnFire{ position:absolute !important; }

      /* NEW: small Full/Exit button — sits just above the Map row */
      #izzaFullToggle{
        position:fixed; right:12px; bottom:72px; z-index:8;  /* portrait */
      }
      #izzaLandStage #izzaFullToggle{
        position:absolute !important; right:14px !important; bottom:116px !important;  /* rotated */
        top:auto !important; left:auto !important;
      }
    `;
    const tag=document.createElement('style'); tag.id='izzaLandscapeCSS'; tag.textContent=css; document.head.appendChild(tag);
  })();

  // ---------- rotated stage & placeholders ----------
  const stage = document.createElement('div'); stage.id='izzaLandStage';
  const ph = {};
  const keepPlace = (el, key)=>{ ph[key]=document.createComment('ph-'+key); el.parentNode.insertBefore(ph[key], el); stage.appendChild(el); };
  const byId = (id)=> document.getElementById(id);

  // Small Full/Exit toggle (styled like your .btn)
  const fullBtn = document.createElement('button');
  fullBtn.id = 'izzaFullToggle';
  fullBtn.className = 'btn';
  fullBtn.type = 'button';
  fullBtn.textContent = 'Full';
  document.body.appendChild(fullBtn);

  function adoptOnce(el, key){
    if(!el || ph[key]) return;
    keepPlace(el, key);
  }

  function adopt(){
    keepPlace(card,'card');
    keepPlace(hud,'hud');
    keepPlace(stick,'stick');
    keepPlace(ctrls,'ctrls');
    if (mini) keepPlace(mini,'mini');

    // Hearts, bell, badge, dropdown, friends button/popup, chat, FIRE, FullToggle
    ['heartsHud','mpNotifBell','mpNotifBadge','mpNotifDropdown','mpFriendsToggleGlobal','mpFriendsPopup','chatBar','btnFire','izzaFullToggle']
      .forEach(id => { const n = byId(id); if(n) adoptOnce(n, id); });

    document.body.appendChild(stage);
  }

  function restore(){
    const putBack=(node,key)=>{ try{ ph[key].parentNode.insertBefore(node, ph[key]); ph[key].remove(); delete ph[key]; }catch{} };
    ['card','hud','stick','ctrls','mini','heartsHud','mpNotifBell','mpNotifBadge','mpNotifDropdown','mpFriendsToggleGlobal','mpFriendsPopup','chatBar','btnFire','izzaFullToggle']
      .forEach(k=>{
        const node = byId(k);
        if(node && ph[k]) putBack(node,k);
      });
    try{ stage.remove(); }catch{}
  }

  // ----- helpers that may appear later (chat bar, bell, friends popup, FIRE) -----
  const mo = new MutationObserver(()=>{
    if(!active) return;
    ['chatBar','mpNotifBell','mpNotifBadge','mpNotifDropdown','mpFriendsToggleGlobal','mpFriendsPopup','btnFire']
      .forEach(id=>{
        const n = byId(id);
        if(n && !stage.contains(n)) adoptOnce(n, id);
      });
    requestAnimationFrame(()=>{ placeFire(); fixFriendsTogglePin(); });
  });

  // ---------- layout (stage + fire) ----------
  function tileToXY(tx, ty){
    return { x:(BASE_W/2)+tx*TILE, y:(BASE_H/2)+ty*TILE };
  }
  function placeFire(){
    const fire = byId('btnFire');
    if(!fire || !stage.contains(fire)) return;
    const w = fire.offsetWidth || 66, h = fire.offsetHeight || 66;
    const {x:cx, y:cy} = tileToXY(FIRE_TILES_RIGHT, FIRE_TILES_DOWN);
    fire.style.left = (cx - w/2) + 'px';
    fire.style.top  = (cy - h/2) + 'px';
  }
  function fixFriendsTogglePin(){
    const btn = byId('mpFriendsToggleGlobal');
    if(btn){ btn.style.right='14px'; btn.style.bottom='72px'; btn.style.top=''; btn.style.left=''; }
    const pop = byId('mpFriendsPopup');
    if(pop){ pop.style.right='14px'; pop.style.bottom='116px'; pop.style.top=''; pop.style.left=''; }
  }
  function applyLayout(){
    const vw=innerWidth, vh=innerHeight;
    const scale = Math.min(vw/BASE_H, vh/BASE_W);
    stage.style.transform = `translate(-50%, -50%) rotate(90deg) scale(${scale})`;
    canvas.style.width = BASE_W+'px';
    canvas.style.height= BASE_H+'px';
    requestAnimationFrame(placeFire);
  }

  // ---------- enter/exit ----------
  let active=false, fireTick=null;
  function enter(){
    if(active) return; active=true;
    BODY.setAttribute('data-fakeland','1');
    fullBtn.textContent = 'Exit';
    adopt(); applyLayout();

    try{ mo.observe(document.body, {subtree:true, childList:true, attributes:true, attributeFilter:['style','class','id']}); }catch{}
    if(fireTick) clearInterval(fireTick);
    fireTick = setInterval(placeFire, 350);
  }
  function exit(){
    if(!active) return; active=false;
    BODY.removeAttribute('data-fakeland');
    fullBtn.textContent = 'Full';
    mo.disconnect(); if(fireTick) clearInterval(fireTick); fireTick=null;
    restore(); stage.style.transform=''; canvas.style.width=canvas.style.height='';
  }

  // Toggle wiring
  fullBtn.addEventListener('click', function(e){
    e.preventDefault();
    if(active) exit(); else enter();
  }, {passive:false});

  // ---------- keep scale right ----------
  const onResize=()=>{ if(active) requestAnimationFrame(()=>requestAnimationFrame(applyLayout)); };
  addEventListener('resize', onResize, {passive:true});
  addEventListener('orientationchange', ()=> setTimeout(onResize,120), {passive:true});

  console.log('[IZZA land] ready');
})();
