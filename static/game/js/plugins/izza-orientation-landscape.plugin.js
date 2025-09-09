/* izza-orientation-landscape.plugin.js
   One rotated+scaled overlay; tiny Full/Exit above Map. Touch nothing else. */
(function () {
  const BASE_W = 960, BASE_H = 540;                 // canvas intrinsic
  const TILE   = 60;                                 // 16×9 → 60px tiles
  const BODY   = document.body;

  // core nodes
  const card   = document.getElementById('gameCard');
  const canvas = document.getElementById('game');
  const hud    = document.querySelector('.hud');
  const stick  = document.getElementById('stick');
  const ctrls  = document.querySelector('.controls');
  const mini   = document.getElementById('miniWrap');
  if (!card || !canvas || !hud || !stick || !ctrls) return;

  // Fire placement (from screen center)
  const FIRE_TILES_RIGHT = 7;
  const FIRE_TILES_DOWN  = 1;

  // ---------- CSS ----------
  (function injectCSS(){
    if (document.getElementById('izzaLandscapeCSS')) return;
    const css = `
      body[data-fakeland="1"]{ overflow:hidden; background:#0b0f17; }

      /* Rotated stage containing ONLY play-layer things */
      #izzaLandStage{
        position:fixed; left:50%; top:50%;
        width:${BASE_W}px; height:${BASE_H}px;
        transform-origin:center center;
        z-index:15; pointer-events:none;
      }
      #izzaLandStage > *{ pointer-events:auto; }

      /* keep canvas intrinsic size */
      #izzaLandStage #game{
        width:${BASE_W}px !important; height:${BASE_H}px !important; display:block;
      }

      /* HUD, ABIM row */
      #izzaLandStage .hud{ position:absolute; left:12px; right:12px; top:8px; }
      #izzaLandStage .controls{ position:absolute; right:14px; bottom:14px; display:flex; gap:10px; }

      /* Joystick — larger, nudged right, axes corrected */
      #izzaLandStage #stick{
        position:absolute; left:48px; bottom:24px;
        width:170px; height:170px;
        transform:rotate(-90deg);                 /* cancels stage +90 so up=up */
        transform-origin:center center;
      }
      #izzaLandStage #stick .base{ border-radius:85px !important; }
      #izzaLandStage #stick .nub{
        left:50% !important; top:50% !important;
        transform:translate(-50%,-50%) !important;
        width:46px !important; height:46px !important; border-radius:23px !important;
      }

      /* Minimap */
      #izzaLandStage #miniWrap{ position:absolute; right:12px; top:74px; display:block; }

      /* Chat row — docked bottom, upright */
      #izzaLandStage .land-chat-dock{
        position:absolute !important; left:12px; right:12px; bottom:8px;
        transform:rotate(-90deg); transform-origin:left bottom;
      }

      /* Hearts inside stage (right side) */
      #izzaLandStage #heartsHud{ position:absolute !important; right:14px; top:46px; }

      /* Bell + badge + dropdown inside stage; upright */
      #izzaLandStage #mpNotifBell{ position:absolute !important; right:14px; top:12px; }
      #izzaLandStage #mpNotifBadge{ position:absolute !important; right:6px; top:4px; }
      #izzaLandStage #mpNotifDropdown{
        position:absolute !important; right:10px; top:44px; max-height:300px;
        transform:rotate(-90deg); transform-origin:top right;
      }

      /* Friends: toggle pinned; popup just above it; upright */
      #izzaLandStage #mpFriendsToggleGlobal{
        position:absolute !important; right:14px !important; bottom:72px !important;
        top:auto !important; left:auto !important;
      }
      #izzaLandStage #mpFriendsPopup{
        position:absolute !important; right:14px !important; bottom:116px !important;
        top:auto !important; left:auto !important;
        transform:rotate(-90deg); transform-origin:right bottom;
      }

      /* FIRE — we place by tiles in JS */
      #izzaLandStage #btnFire,
      #izzaLandStage .btn-fire,
      #izzaLandStage #fireBtn,
      #izzaLandStage button[data-role="fire"],
      #izzaLandStage .fire{ position:absolute !important; }

      /* Full/Exit — small, above Map */
      #izzaFullToggle{ position:fixed; right:12px; bottom:72px; z-index:8; }
      #izzaLandStage #izzaFullToggle{
        position:absolute !important; right:14px !important; bottom:116px !important;
        top:auto !important; left:auto !important;
      }

      /* Modals should be upright no matter what */
      body[data-fakeland="1"] .modal{ transform:none !important; }
      #izzaLandStage .modal{               /* if some code inserts into stage, counter-rotate */
        position:absolute !important; left:50% !important; top:50% !important;
        transform:translate(-50%,-50%) rotate(-90deg) !important;
        transform-origin:center center !important;
        z-index:20 !important;
      }
    `;
    const tag=document.createElement('style'); tag.id='izzaLandscapeCSS'; tag.textContent=css;
    document.head.appendChild(tag);
  })();

  // ---------- helpers ----------
  const byId = (id)=> document.getElementById(id);

  // Find the chat row reliably (plugin names vary)
  function findChatDock(){
    // explicit ids/classes first
    let n = byId('chatBar') || byId('areaChatDock') || document.querySelector('.area-chat');
    if (n) return n;
    // otherwise: find an input with placeholder "Type..." and take its nearest row
    const txt = document.querySelector('input[placeholder="Type..."], textarea[placeholder="Type..."]');
    if (txt){
      const row = txt.closest('.area-chat, .chat, .row, div');
      if (row) { row.classList.add('land-chat-dock'); return row; }
    }
    return null;
  }

  // ---------- rotated stage + placeholders ----------
  const stage = document.createElement('div'); stage.id='izzaLandStage';
  const ph = {}; // comment placeholders so we can restore cleanly
  function keepPlace(el, key){ ph[key]=document.createComment('ph-'+key); el.parentNode.insertBefore(ph[key], el); stage.appendChild(el); }

  // Small Full/Exit toggle (Map-sized)
  const fullBtn = document.createElement('button');
  fullBtn.id = 'izzaFullToggle'; fullBtn.className = 'btn'; fullBtn.type = 'button';
  fullBtn.textContent = 'Full'; document.body.appendChild(fullBtn);

  function adoptOnce(el, key){ if(!el || ph[key]) return; keepPlace(el, key); }

  function adopt(){
    keepPlace(card,'card'); keepPlace(hud,'hud'); keepPlace(stick,'stick'); keepPlace(ctrls,'ctrls'); if (mini) keepPlace(mini,'mini');

    // optional things we also want inside the stage
    const chat = findChatDock();                     if (chat)  adoptOnce(chat,'chat');
    const hearts = byId('heartsHud');                if (hearts) adoptOnce(hearts,'hearts');
    const bell   = byId('mpNotifBell');              if (bell)  adoptOnce(bell,'mpNotifBell');
    const badge  = byId('mpNotifBadge');             if (badge) adoptOnce(badge,'mpNotifBadge');
    const drop   = byId('mpNotifDropdown');          if (drop)  adoptOnce(drop,'mpNotifDropdown');
    const frBtn  = byId('mpFriendsToggleGlobal');    if (frBtn) adoptOnce(frBtn,'mpFriendsToggleGlobal');
    const frPop  = byId('mpFriendsPopup');           if (frPop) adoptOnce(frPop,'mpFriendsPopup');
    const fire   = (byId('btnFire') || byId('fireBtn') || document.querySelector('.btn-fire, .fire, button[data-role="fire"]'));
    if (fire) adoptOnce(fire, 'btnFire');

    // our toggle itself should also live inside when active
    adoptOnce(fullBtn, 'izzaFullToggle');

    document.body.appendChild(stage);
  }

  function restore(){
    const putBack=(node,key)=>{ try{ ph[key].parentNode.insertBefore(node, ph[key]); ph[key].remove(); delete ph[key]; }catch{} };
    ['card','hud','stick','ctrls','mini','chat','hearts','mpNotifBell','mpNotifBadge','mpNotifDropdown','mpFriendsToggleGlobal','mpFriendsPopup','btnFire','izzaFullToggle']
      .forEach(k=>{ const node = (k==='btnFire') ? (byId('btnFire')||byId('fireBtn')||document.querySelector('.btn-fire, .fire, button[data-role="fire"]')) : byId(k); if(node && ph[k]) putBack(node,k); });
    try{ stage.remove(); }catch{}
  }

  // ---------- layout ----------
  function tileCenter(tx, ty){ return { x:(BASE_W/2)+(tx*TILE), y:(BASE_H/2)+(ty*TILE) }; }

  function placeFire(){
    const fire = byId('btnFire') || byId('fireBtn') || document.querySelector('#izzaLandStage .btn-fire, #izzaLandStage .fire, #izzaLandStage button[data-role="fire"]');
    if(!fire) return;
    const {x:cx, y:cy} = tileCenter(FIRE_TILES_RIGHT, FIRE_TILES_DOWN);
    const w = fire.offsetWidth || 66, h = fire.offsetHeight || 66;
    fire.style.left = (cx - w/2) + 'px';
    fire.style.top  = (cy - h/2) + 'px';

    // hide the tiny dash below it if present
    const maybeDash = fire.parentElement && Array.from(fire.parentElement.children).find(el=> el!==fire && (el.textContent||'').trim()==='-');
    if(maybeDash){ maybeDash.style.display='none'; }
  }

  function pinFriendsUI(){
    const btn = byId('mpFriendsToggleGlobal'); if(btn){ btn.style.right='14px'; btn.style.bottom='72px'; btn.style.top=''; btn.style.left=''; }
    const pop = byId('mpFriendsPopup');        if(pop){ pop.style.right='14px'; pop.style.bottom='116px'; pop.style.top=''; pop.style.left=''; }
  }

  function applyLayout(){
    const vw=innerWidth, vh=innerHeight;
    const scale = Math.min(vw/BASE_H, vh/BASE_W);
    stage.style.transform = `translate(-50%, -50%) rotate(90deg) scale(${scale})`;

    // keep canvas intrinsic
    canvas.style.width = BASE_W+'px';
    canvas.style.height= BASE_H+'px';

    requestAnimationFrame(()=>{ placeFire(); pinFriendsUI(); });
  }

  // ---------- observer (adopt late-mounted nodes like chat/friends popup) ----------
  const mo = new MutationObserver(()=>{
    if(!active) return;
    const chat = findChatDock(); if(chat && !stage.contains(chat)) adoptOnce(chat,'chat');
    ['mpFriendsToggleGlobal','mpFriendsPopup','mpNotifBell','mpNotifBadge','mpNotifDropdown'].forEach(id=>{
      const n = byId(id); if(n && !stage.contains(n)) adoptOnce(n, id);
    });
    const fire = byId('btnFire') || byId('fireBtn') || document.querySelector('.btn-fire, .fire, button[data-role="fire"]');
    if(fire && !stage.contains(fire)) adoptOnce(fire,'btnFire');
    requestAnimationFrame(()=>{ placeFire(); pinFriendsUI(); });
  });

  // ---------- enter/exit ----------
  let active=false, fireTick=null;

  function enter(){
    if(active) return; active=true;
    BODY.setAttribute('data-fakeland','1');
    fullBtn.textContent = 'Exit';
    adopt(); applyLayout();
    try{ mo.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['style','class','id']}); }catch{}
    if(fireTick) clearInterval(fireTick);
    fireTick = setInterval(placeFire, 350);
  }

  function exit(){
    if(!active) return; active=false;
    BODY.removeAttribute('data-fakeland');
    fullBtn.textContent = 'Full';
    mo.disconnect(); if(fireTick) clearInterval(fireTick); fireTick=null;
    restore();
    stage.style.transform=''; canvas.style.width=canvas.style.height='';
  }

  // ---------- Full/Exit toggle ----------
  fullBtn.addEventListener('click', function(e){ e.preventDefault(); if(active) exit(); else enter(); }, {passive:false});

  // ---------- keep scale right ----------
  const onResize=()=>{ if(active) requestAnimationFrame(()=>requestAnimationFrame(applyLayout)); };
  addEventListener('resize', onResize, {passive:true});
  addEventListener('orientationchange', ()=> setTimeout(onResize,120), {passive:true});

  console.log('[IZZA land] ready');
})();
