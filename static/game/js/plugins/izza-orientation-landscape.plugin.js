/* izza-orientation-landscape.plugin.js — rotated overlay + resilient Full/Exit + (KEEP joystick) + wall-stick + upright popups */
(function(){
  const BASE_W=960, BASE_H=540, TILE=60;
  const BODY=document.body;
  const card=document.getElementById('gameCard');
  const canvas=document.getElementById('game');
  const hud=document.querySelector('.hud');
  const stickEl=document.getElementById('stick');
  const ctrls=document.querySelector('.controls');
  const mini=document.getElementById('miniWrap');
  // *** CHANGED: don't require stick/ctrls to exist to boot (prevents early exit that hides the Full button)
  if(!card||!canvas||!hud) return;

  // FIRE placement (bigger, a touch left)
  const FIRE_TILES_RIGHT = 6.0;
  const FIRE_TILES_DOWN  = 1;

  // ---------- CSS ----------
  if(!document.getElementById('izzaLandscapeCSS')){
    const css=`
      body[data-fakeland="1"]{overflow:hidden;background:#0b0f17;}

      #izzaLandStage{
        position:fixed;left:50%;top:50%;
        width:${BASE_W}px;height:${BASE_H}px;
        transform-origin:center center;z-index:15;pointer-events:none;
      }
      #izzaLandStage > *{pointer-events:auto;}
      #izzaLandStage #game{width:${BASE_W}px!important;height:${BASE_H}px!important;display:block;}

      /* HUD + ABIM row */
      #izzaLandStage .hud{position:absolute;left:12px;right:12px;top:8px;}
      #izzaLandStage .controls{position:absolute;right:14px;bottom:14px;display:flex;gap:10px;}

      /* Joystick — DO NOT CHANGE (visual only) */
      #izzaLandStage #stick{
        position:absolute;left:48px;bottom:24px;
        width:180px;height:180px;transform:none;transform-origin:center center;
      }
      #izzaLandStage #stick .base{border-radius:90px!important;}
      #izzaLandStage #stick .nub{
        left:50%!important;top:50%!important;transform:translate(-50%,-50%)!important;
        width:48px!important;height:48px!important;border-radius:24px!important;
      }

      /* ===== INVENTORY (works even if NOT adopted) ===== */
      body[data-fakeland="1"] #invPanel{
        position:fixed !important;
        left:12px !important; right:12px !important;
        top:74px !important;
        z-index:10050 !important;   /* higher than the stage */
        max-width:none !important; margin:0 !important;
        pointer-events:auto !important;
      }

      /* ===== INVENTORY PANEL (always over canvas in Full) ===== */
      #izzaLandStage #invPanel{
        position:absolute !important;
        left:12px !important; right:12px !important;
        top:74px !important;
        z-index:10040 !important; /* above game & HUD widgets */
        max-width:none !important; margin:0 !important;
      }

      /* Minimap */
      #izzaLandStage #miniWrap{position:absolute;right:12px;top:74px;display:block;}

      /* Chat row hidden in Full (OSK issues) */
      #izzaLandStage #chatBar,
      #izzaLandStage .land-chat-dock{
        position:absolute !important;
        left:12px !important; right:12px !important; bottom:8px !important;
        margin:0 !important; z-index:18 !important;
        transform:rotate(-90deg) !important;
        transform-origin:left bottom !important;
      }
      body[data-fakeland="1"] #chatBar,
      body[data-fakeland="1"] .land-chat-dock{ display:none !important; }

      /* Hearts + bell/badge (inside stage in Full) */
      #izzaLandStage #heartsHud{
        position:absolute!important;
        right:14px !important;
        top:46px !important;
        left:auto !important;
        bottom:auto !important;
        z-index:10045 !important;
      }
      #izzaLandStage #mpNotifBell{position:absolute!important;right:14px;top:20px;}
      #izzaLandStage #mpNotifBadge{position:absolute!important;right:6px;top:12px;}


      /* -------- BELL DROPDOWN: centered container (unrotated), rotated content -------- */
      #izzaLandStage #mpNotifDropdown{
        position:absolute !important;
        left:50% !important;
        top:50% !important;
        right:auto !important;
        bottom:auto !important;
        transform:translate(-50%, -50%) !important;
        max-height:300px;
        z-index:9999 !important;
        overflow:visible !important;
        pointer-events:auto !important;
        margin:0 !important;
      }
      #izzaLandStage #mpNotifDropdown > .izza-upright{
        transform:rotate(-90deg) !important;
        transform-origin:top left !important;
        writing-mode: horizontal-tb !important;
      }

      /* -------- FRIENDS POPUP: centered container (unrotated), rotated content -------- */
      #izzaLandStage #mpFriendsPopup{
        position:absolute !important;
        left:50% !important;
        top:50% !important;
        right:auto !important; bottom:auto !important;
        transform:translate(-50%, -50%) !important;
        z-index:9999 !important;
        overflow:visible !important;
        pointer-events:auto !important;
        margin:0 !important;
      }
      #izzaLandStage #mpFriendsPopup > .izza-upright{
        transform:rotate(-90deg) !important;
        transform-origin:top left !important;
        writing-mode: horizontal-tb !important;
      }

      /* Toggle button stays docked */
      #izzaLandStage #mpFriendsToggleGlobal{
        position:absolute!important;right:14px!important;bottom:72px!important;top:auto!important;left:auto!important;
      }

      /* Normalize rotated content deeply so text can’t remain vertical/absolute */
      #izzaLandStage #mpNotifDropdown > .izza-upright,
      #izzaLandStage #mpFriendsPopup > .izza-upright,
      #izzaLandStage #mpNotifDropdown > .izza-upright *,
      #izzaLandStage #mpFriendsPopup > .izza-upright *{
        rotate:0 !important;
        transform:none !important;
        writing-mode:horizontal-tb !important;
        position:static !important;
      }

      /* ---------- BACKDROP HANDLING IN ROTATED MODE ---------- */
      body[data-fakeland="1"] .backdrop{ display:none !important; }

      /* ---------- GENERIC MODALS (fallback) ---------- */
      #izzaLandStage .modal,
      #izzaLandStage [role="dialog"],
      #izzaLandStage [data-modal],
      #izzaLandStage [id$="Modal"],
      #izzaLandStage #enterModal,
      #izzaLandStage #tutorialModal,
      #izzaLandStage #shopModal,
      #izzaLandStage #hospitalModal,
      #izzaLandStage #tradeCentreModal,
      #izzaLandStage #bankModal,
      #izzaLandStage #mapModal,
      #izzaLandStage [data-pool="tutorial"],
      #izzaLandStage [data-pool="shop"],
      #izzaLandStage [data-pool="hospital"],
      #izzaLandStage [data-pool="trade-centre"],
      #izzaLandStage [data-pool="bank"]{
        position:absolute !important; left:50% !important; top:50% !important;
        transform:translate(-50%, -50%) rotate(-90deg) !important;
        transform-origin:center center !important; z-index:20 !important;
      }
/* Craft button placement inside rotated stage */
#izzaLandStage #btnCraft{
  position:absolute !important;
  right:14px !important;
  bottom:158px !important;   /* sits ABOVE the Full button (Full is ~116px) */
  z-index:10012 !important;
  transform:none !important;
}
/* CRAFTING MODAL — like enter/shop: rotate the card only */
body[data-fakeland="1"] #craftingModal{
  position:fixed !important;
  left:50% !important;
  top:50% !important;
  right:auto !important;
  bottom:auto !important;
  transform:translate(-50%, -50%) !important; /* DO NOT rotate the container */
  z-index:10055 !important;                   /* above friends/bell/fire */
  pointer-events:auto !important;
}

body[data-fakeland="1"] #craftingModal .card{
  transform: rotate(270deg) !important;
  transform-origin: center center !important;
}

/* normalize descendants so nothing stays sideways */
body[data-fakeland="1"] #craftingModal .card *{
  rotate:0 !important;
  transform:none !important;
  writing-mode:horizontal-tb !important;
}
      /* ---------- TRADE MODAL: rotate CONTENT ONLY (leave container positioning alone) ---------- */
      body[data-fakeland="1"] #tradeModal > .izza-upright{
        transform:rotate(90deg) !important;
        transform-origin:top left !important;
        writing-mode:horizontal-tb !important;
      }
      /* nudge the Trade modal up only in fake-landscape */
      body[data-fakeland="1"] #tradeModal{
        translate: 0 -14vh;
      }
      /* SHOP: rotate the card only (container/backdrop untouched) */
      body[data-fakeland="1"] #shopModal .card{
        transform: rotate(90deg) !important;
        transform-origin: center center !important;
      }
      body[data-fakeland="1"] #shopModal{ translate: 0 -0vh; }
      @supports not (translate: 0) {
        body[data-fakeland="1"] #shopModal{ transform: translateY(-6vh) !important; }
      }

      /* BANK: rotate the inner panel only (leave backdrop/positioning alone) */
      body[data-fakeland="1"] #bankUI > div{
        transform: rotate(90deg) !important;
        transform-origin: center center !important;
      }
      body[data-fakeland="1"] #bankUI > div *{
        rotate: 0 !important; transform: none !important; writing-mode: horizontal-tb !important;
      }

      /* ===== MULTIPLAYER LOBBY (scaled to fit; IN-PLACE, not adopted) ===== */
      body[data-fakeland="1"] #mpLobby{
        position:fixed !important;
        left:50% !important; 
        top:50% !important; 
        right:auto !important; 
        bottom:auto !important;
        transform:translate(-50%, -50%) rotate(90deg) scale(0.5) !important; /* adjust 0.75 → 0.7 etc */
        transform-origin:center center !important;
        z-index:10020 !important;        /* ensure above everything */
        pointer-events:auto !important;  /* accept clicks */
        touch-action:auto !important;    /* allow taps/focus */
        will-change:transform;
      }

      /* make sure children also receive events */
      body[data-fakeland="1"] #mpLobby, 
      body[data-fakeland="1"] #mpLobby *{
        pointer-events:auto !important;
      }

      /* hide any backdrop siblings that might sit under/over the lobby */
      body[data-fakeland="1"] #mpLobby ~ .backdrop,
      body[data-fakeland="1"] #mpLobby ~ .modal-backdrop,
      body[data-fakeland="1"] #mpLobby ~ .overlay,
      body[data-fakeland="1"] #mpLobby ~ [data-backdrop]{
        display:none !important;
      }

      /* Reset in normal view */
      body:not([data-fakeland="1"]) #mpLobby{
        transform:none !important;
        rotate:0deg !important;
      }
/* ===== TUTORIAL / ENTER MODAL (rotate card only) ===== */
body[data-fakeland="1"] #enterModal{
  position:fixed !important;
  left:50% !important;
  top:50% !important;
  right:auto !important;
  bottom:auto !important;
  transform:translate(-50%, -50%) !important;  /* container stays unrotated */
  z-index:10030 !important;
  pointer-events:auto !important;
}

/* rotate the inner card so text reads left→right */
body[data-fakeland="1"] #enterModal .card{
  transform: rotate(90deg) !important;
  transform-origin: center center !important;
}

/* normalize descendants so nothing keeps odd rotations */
body[data-fakeland="1"] #enterModal .card *{
  rotate: 0 !important;
  transform: none !important;
  writing-mode: horizontal-tb !important;
}
/* ===== HOSPITAL POPUP (rotate container directly) ===== */
body[data-fakeland="1"] #hospitalShop{
  position:fixed !important;
  left:50% !important;
  top:50% !important;
  right:auto !important;
  bottom:auto !important;
  transform:translate(-50%, -50%) rotate(90deg) !important;
  transform-origin:center center !important;
  z-index:10040 !important;
  pointer-events:auto !important;
}

/* normalize descendants so text/buttons are upright and clickable */
body[data-fakeland="1"] #hospitalShop *{
  rotate:0 !important;
  transform:none !important;
  writing-mode:horizontal-tb !important;
}

/* reset in normal view */
body:not([data-fakeland="1"]) #hospitalShop{
  transform:none !important;
  rotate:0deg !important;
}
      /* NORMAL VIEW: force upright, kill any inline rotate */
      body:not([data-fakeland="1"]) .modal,
      body:not([data-fakeland="1"]) [role="dialog"],
      body:not([data-fakeland="1"]) [data-modal],
      body:not([data-fakeland="1"]) [id$="Modal"],
      body:not([data-fakeland="1"]) #enterModal,
      body:not([data-fakeland="1"]) #tutorialModal,
      body:not([data-fakeland="1"]) #shopModal,
      body:not([data-fakeland="1"]) #hospitalModal,
      body:not([data-fakeland="1"]) #tradeCentreModal,
      body:not([data-fakeland="1"]) #bankModal,
      body:not([data-fakeland="1"]) #mapModal,
      body:not([data-fakeland="1"]) [data-pool="tutorial"],
      body:not([data-fakeland="1"]) [data-pool="shop"],
      body:not([data-fakeland="1"]) [data-pool="hospital"],
      body:not([data-fakeland="1"]) [data-pool="trade-centre"],
      body:not([data-fakeland="1"]) [data-pool="bank"],
      body:not([data-fakeland="1"]) #mpFriendsPopup,
      body:not([data-fakeland="1"]) #mpNotifDropdown{
        transform:none !important; rotate:0deg !important;
      }

      /* FIRE (tile-placed; scaled up) */
      #izzaLandStage #btnFire,
      #izzaLandStage #fireBtn,
      #izzaLandStage .btn-fire,
      #izzaLandStage button[data-role="fire"],
      #izzaLandStage .fire{
        position:absolute!important;transform:scale(1.35);transform-origin:center;
      }

      /* Full/Exit button */
      #izzaFullToggle{
        position:fixed;z-index:10010;
        display:inline-block; line-height:1; padding:8px 12px; border-radius:10px;
      }
      #izzaLandStage #izzaFullToggle{
        position:absolute!important;right:14px!important;bottom:116px!important;
        top:auto!important;left:auto!important;z-index:10010!important;
      }
    `;
    const tag=document.createElement('style'); tag.id='izzaLandscapeCSS'; tag.textContent=css; document.head.appendChild(tag);
  }

  // ---------- helpers ----------
  const byId = (id)=>document.getElementById(id);
  const stage=document.createElement('div'); stage.id='izzaLandStage';
  const ph={};
  const keep=(el,key)=>{ ph[key]=document.createComment('ph-'+key); el.parentNode.insertBefore(ph[key],el); stage.appendChild(el); };
  const adoptOnce=(el,key)=>{ if(!el||ph[key]) return; keep(el,key); };

  // Wrap/center/upright helper (shared) — used by notif/friends/generic; unchanged
  function centerAndUpright(container){
    const host = (typeof container==='string') ? byId(container) : container;
    if(!host) return;

    if(!stage.contains(host) && host.parentNode){
      const key = 'modal:'+ (host.id || ('@'+Date.now()));
      if(!ph[key]) keep(host, key);
    }

    let wrapper = host.querySelector(':scope > .izza-upright');
    if(!wrapper){
      wrapper = document.createElement('div');
      wrapper.className = 'izza-upright';
      while(host.firstChild){ wrapper.appendChild(host.firstChild); }
      host.appendChild(wrapper);
    }else{
      Array.from(host.childNodes).forEach(n=>{ if(n!==wrapper){ try{ wrapper.appendChild(n); }catch{} }});
    }

    host.classList.add('izza-trade-centre');

    Object.assign(host.style, {
      position:'absolute', left:'50%', top:'50%', right:'auto', bottom:'auto',
      transform:'translate(-50%, -50%)', zIndex:'9999', overflow:'visible', pointerEvents:'auto', margin:'0'
    });

    wrapper.style.writingMode = 'horizontal-tb';
    wrapper.style.transformOrigin = 'top left';
    wrapper.style.transform = 'rotate(-90deg)';

    wrapper.querySelectorAll('*').forEach(el=>{
      el.style.rotate = '0';
      el.style.transform = 'none';
      el.style.writingMode = 'horizontal-tb';
      if(getComputedStyle(el).position === 'absolute'){ el.style.position='static'; }
    });

    const cs = getComputedStyle(host);
    const visible = host.offsetParent !== null && cs.display !== 'none' && cs.visibility !== 'hidden';
    if(visible){
      const prev = wrapper.style.transform;
      wrapper.style.transform = 'none';
      const w = wrapper.scrollWidth;
      const h = wrapper.scrollHeight;
      wrapper.style.transform = prev;
      host.style.width  = h + 'px';
      host.style.height = w + 'px';
    }else{
      host.style.width = '';
      host.style.height = '';
    }
  }

  // ---------- NEW: rotate ONLY the contents of #tradeModal (no container changes) ----------
  function rotateTradeModalContents(){
    if(!BODY.hasAttribute('data-fakeland')) return;
    const host = byId('tradeModal'); if(!host) return;

    let wrapper = host.querySelector(':scope > .izza-upright');
    if(!wrapper){
      wrapper = document.createElement('div');
      wrapper.className = 'izza-upright';
      while(host.firstChild){ wrapper.appendChild(host.firstChild); }
      host.appendChild(wrapper);
    }
    wrapper.style.writingMode = 'horizontal-tb';
    wrapper.style.transformOrigin = 'top left';
    wrapper.style.transform = 'rotate(90deg)';

    wrapper.querySelectorAll('*').forEach(el=>{
      el.style.rotate = '0';
      el.style.transform = 'none';
      el.style.writingMode = 'horizontal-tb';
    });
  }

  // ---------- element-specific fixers ----------
  let fixingNotif=false, fixNotifQueued=false;
  function fixNotifDropdown(){
    if(fixingNotif){ fixNotifQueued=true; return; }
    fixingNotif=true;
    try{ centerAndUpright('mpNotifDropdown'); }catch{} finally{
      fixingNotif=false;
      if(fixNotifQueued){ fixNotifQueued=false; requestAnimationFrame(fixNotifDropdown); }
    }
  }

  let fixingFriends=false, fixFriendsQueued=false;
  function fixFriendsPopup(){
    if(fixingFriends){ fixFriendsQueued=true; return; }
    fixingFriends=true;
    try{ centerAndUpright('mpFriendsPopup'); }catch{} finally{
      fixingFriends=false;
      if(fixFriendsQueued){ fixFriendsQueued=false; requestAnimationFrame(fixFriendsPopup); }
    }
  }

  let fixingTrade=false, fixTradeQueued=false;
  function fixTradeCentrePopup(){
    if(fixingTrade){ fixTradeQueued=true; return; }
    fixingTrade=true;
    try{
      const t1 = byId('tradeCentreModal'); if(t1) centerAndUpright(t1);
      const t2 = document.querySelector('#izzaLandStage [data-pool="trade-centre"], [data-pool="trade-centre"]');
      if(t2) centerAndUpright(t2);
      rotateTradeModalContents();
    }catch{} finally{
      fixingTrade=false;
      if(fixTradeQueued){ fixTradeQueued=false; requestAnimationFrame(fixTradeCentrePopup); }
    }
  }

  // ---------- NEW: tiny 80ms scheduler to batch modal adoption + fixers ----------
  let modalFixTimer = null;
  function scheduleModalFix(){
    if(modalFixTimer) return;
    modalFixTimer = setTimeout(()=>{
      modalFixTimer = null;
      try{
        adoptModals();
      }catch{}
      try{
        fixNotifDropdown();
        fixFriendsPopup();
        fixTradeCentrePopup();
      }catch{}
    }, 80);
  }

  // Collect ALL modal / popup candidates so they counter-rotate in Full
  function adoptModals(){
    const sel = [
      '.modal','[role="dialog"]','[data-modal]','[id$="Modal"]',
      '#enterModal','#tutorialModal','#shopModal','#hospitalModal','#tradeCentreModal','#bankModal','#mapModal',
      '[data-pool="tutorial"]','[data-pool="shop"]','[data-pool="hospital"]','[data-pool="trade-centre"]','[data-pool="bank"]',
      /* (intentionally NOT adopting #mpLobby to keep it in-place) */
      '#mpFriendsPopup','#mpNotifDropdown'
    ].join(',');
    const nodes = document.querySelectorAll(sel);
    nodes.forEach((el,i)=>{
      if(stage.contains(el)) return;
      const key = el.id ? ('modal:'+el.id) : ('modal@'+i+'@'+Date.now());
      adoptOnce(el, key);
    });
  }

  function findChatDock(){
    const direct = byId('chatBar') || byId('areaChatDock') || document.querySelector('.area-chat');
    if(direct) return direct;
    const txt = document.querySelector('input[placeholder="Type…"],textarea[placeholder="Type…"],input[placeholder="Type..."],textarea[placeholder="Type..."]');
    if(txt){ const row = txt.closest('#chatBar,.area-chat,.chat,.row,div'); if(row){ row.classList.add('land-chat-dock'); return row; } }
    return null;
  }

  // ----- Full/Exit button (resilient) -----
  let fullBtn=null, active=false;

  function ensureFullButton(){
    if(!fullBtn || !document.body.contains(fullBtn)){
      fullBtn=document.createElement('button');
      fullBtn.id='izzaFullToggle'; fullBtn.className='btn'; fullBtn.type='button';
      fullBtn.textContent = active ? 'Exit' : 'Full';
      fullBtn.style.lineHeight='1';
      fullBtn.style.padding='8px 12px';
      fullBtn.style.borderRadius='10px';
      fullBtn.addEventListener('click',(e)=>{ e.preventDefault(); e.stopPropagation(); active?exit():enter(); }, {passive:false});
      document.body.appendChild(fullBtn);
    }
    fullBtn.style.display='inline-block';
    fullBtn.style.opacity='1';
    fullBtn.style.pointerEvents='auto';
    placeFullButton();
    return fullBtn;
  }

  // Place Full relative to the Map button (above & a bit left; 8px gap).
  function placeFullButton(){
    if(active){ return; }
    const mapBtn =
      document.querySelector('#btnMap, #mapBtn, button[data-role="map"], .map') ||
      Array.from(document.querySelectorAll('.controls button, .controls .btn')).find(b=>/^\s*map\s*$/i.test(b.textContent||''));
    if(!fullBtn) return;

    const doPlace = ()=>{
      if(mapBtn && mapBtn.getBoundingClientRect){
        const r = mapBtn.getBoundingClientRect();
        const w = fullBtn.offsetWidth  || 56;
        const h = fullBtn.offsetHeight || 28;

        const GAP_Y = 8, GAP_X = 6;
        let left = Math.round(r.left + r.width - w - GAP_X);
        let top  = Math.round(r.top - h - GAP_Y);

        const vw = Math.max(document.documentElement.clientWidth,  window.innerWidth || 0);
        const vh = Math.max(document.documentElement.clientHeight, window.innerHeight|| 0);
        left = Math.max(8, Math.min(left, vw - w - 8));
        top  = Math.max(8, Math.min(top,  vh - h - 8));

        fullBtn.style.position='fixed';
        fullBtn.style.left = left+'px';
        fullBtn.style.top  = top +'px';
        fullBtn.style.right=''; fullBtn.style.bottom='';
        fullBtn.style.zIndex='10010';
      }else{
        fullBtn.style.position='fixed';
        fullBtn.style.right='12px';
        fullBtn.style.bottom='72px';
        fullBtn.style.left=''; fullBtn.style.top='';
        fullBtn.style.zIndex='10010';
      }
    };

    requestAnimationFrame(()=>requestAnimationFrame(doPlace));
  }

  function keepFullVisible(){
    ensureFullButton();
    placeFullButton();
  }

  // ---------- adopt/restore ----------
  function adopt(){
    keep(card,'card'); keep(hud,'hud');
    // *** CHANGED: guard optional elements so we don't call keep() on nulls
    if (stickEl) keep(stickEl,'stick');
    if (ctrls) keep(ctrls,'ctrls');
    if(mini) keep(mini,'mini');
    const chat=findChatDock(); if(chat) adoptOnce(chat,'chat');
    ['heartsHud','mpNotifBell','mpNotifBadge','mpFriendsToggleGlobal','mpFriendsPopup'].forEach(id=>{ const n=byId(id); if(n) adoptOnce(n,id); });
    const fire=byId('btnFire')||byId('fireBtn')||document.querySelector('.btn-fire,.fire,button[data-role="fire"],#shootBtn'); if(fire) adoptOnce(fire,'btnFire');
const craftBtn = document.getElementById('btnCraft'); 
if (craftBtn) adoptOnce(craftBtn, 'btnCraft');
    // >>> NEW: adopt inventory if present (so it layers correctly within the stage)
    const inv = document.getElementById('invPanel'); if (inv) adoptOnce(inv, 'invPanel');

    // adopt Full button only in Full
    if(fullBtn && !stage.contains(fullBtn)) adoptOnce(fullBtn,'izzaFullToggle');

    // adopt any modals so they render upright (bell + friends) — lobby stays in-place
    scheduleModalFix();

    document.body.appendChild(stage);
  }
  function restore(){
    const putBack=(node,key)=>{ try{ ph[key].parentNode.insertBefore(node,ph[key]); ph[key].remove(); delete ph[key]; }catch{} };
    Object.keys(ph).forEach(k=>{
      const byKeyId = (k.startsWith('modal:')? k.slice(6): k);
      const node = byId(byKeyId) || null;
      if(node && ph[k]) putBack(node,k);
      else if(ph[k]){
        const guess = ph[k].nextSibling && ph[k].nextSibling.parentNode===stage ? ph[k].nextSibling : null;
        if(guess) putBack(guess,k);
      }
    });
    try{ stage.remove(); }catch{}
  }

  // FIRE placement + dash removal
  const tileCenter=(tx,ty)=>({ x:(BASE_W/2)+tx*TILE, y:(BASE_H/2)+ty*TILE });
  function placeFire(){
    const fire=byId('btnFire')||byId('fireBtn')||document.querySelector('#izzaLandStage .btn-fire,#izzaLandStage .fire,#izzaLandStage button[data-role="fire"],#izzaLandStage #shootBtn');
    if(!fire) return;
    const {x:cx,y:cy}=tileCenter(FIRE_TILES_RIGHT,FIRE_TILES_DOWN);
    const w=fire.offsetWidth||66, h=fire.offsetHeight||66;
    fire.style.left=(cx-w/2)+'px';
    fire.style.top =(cy-h/2)+'px';
    const sibs=Array.from(fire.parentElement?fire.parentElement.children:[]);
    const dash=sibs.find(el=>el!==fire && (el.textContent||'').trim()==='-');
    if(dash) dash.style.display='none';
  }
  function pinFriendsUI(){
    const btn=byId('mpFriendsToggleGlobal'); if(btn){ btn.style.right='14px'; btn.style.bottom='72px'; btn.style.top=''; btn.style.left=''; }
  }

  function applyLayout(){
    const vw=innerWidth, vh=innerHeight;
    const scale=Math.min(vw/BASE_H, vh/BASE_W);
    stage.style.transform=`translate(-50%,-50%) rotate(90deg) scale(${scale})`;
    canvas.style.width=BASE_W+'px'; canvas.style.height=BASE_H+'px';

    requestAnimationFrame(()=>{
      placeFire();
      pinFriendsUI();
      scheduleModalFix();
    });
  }

  // Observe DOM changes (fix dropdowns/popups whenever they appear/change)
  const mo=new MutationObserver(()=>{
    if(!active){ keepFullVisible(); }
    if(active){
      const chat=findChatDock(); if(chat && !stage.contains(chat)) adoptOnce(chat,'chat');
      ['mpFriendsToggleGlobal','mpFriendsPopup','mpNotifBell','mpNotifBadge'].forEach(id=>{
        const n=byId(id); if(n && !stage.contains(n)) adoptOnce(n,id);
      });
      const fire=byId('btnFire')||byId('fireBtn')||document.querySelector('.btn-fire,.fire,button[data-role="fire"],#shootBtn');
      if(fire && !stage.contains(fire)) adoptOnce(fire,'btnFire');
const craftBtn = document.getElementById('btnCraft');
if (craftBtn && !stage.contains(craftBtn)) adoptOnce(craftBtn,'btnCraft');
      // adopt bell/friends only; lobby stays in-place
      scheduleModalFix();

      requestAnimationFrame(()=>{ placeFire(); pinFriendsUI(); });
    }
  });

  // keep map closed when entering Full
  function closeMapsOnEnter(){
    const big=byId('mapModal'); if(big && getComputedStyle(big).display!=='none') big.style.display='none';
    if(mini){ mini.style.display='none'; }
  }
  function restoreMiniOnExit(){ if(mini){ mini.style.display=''; } }

  // ---------- Joystick correction (UNCHANGED FEEL) + wall-stick guard ----------
  let joyActive=false;
  const markOn = ()=>{ joyActive=true; };
  const markOff= ()=>{ joyActive=false; };
  // *** CHANGED: only attach listeners if stick exists
  if (stickEl){
    stickEl.addEventListener('touchstart',markOn,{passive:false});
    stickEl.addEventListener('mousedown', markOn);
  }
  window.addEventListener('touchend',  markOff, {passive:true});
  window.addEventListener('mouseup',   markOff, {passive:true});
  window.addEventListener('touchcancel',markOff,{passive:true});

  let prevX=null, prevY=null;
  function fixJoystickDelta(){
    if(!joyActive || !window.IZZA || !IZZA.api || !IZZA.api.player) { prevX=null; prevY=null; return; }
    const p = IZZA.api.player;
    if(prevX==null || prevY==null){ prevX=p.x; prevY=p.y; return; }
    const dx = p.x - prevX, dy = p.y - prevY;
    const mag = Math.abs(dx)+Math.abs(dy);

    // wall-stick guard
    const singleAxis = (Math.abs(dx) < 0.005) ^ (Math.abs(dy) < 0.005);
    if(mag < 0.005 || singleAxis){ prevX=p.x; prevY=p.y; return; }

    // Rotate -90°: (x',y') = ( y, -x )
const fx =  dy;
const fy = -dx;

// apply rotated movement
p.x = prevX + fx;
p.y = prevY + fy;

// *** NEW: fix facing to match the rotated movement (Full view only) ***
if (document.body.hasAttribute('data-fakeland')) {
  const ax = Math.abs(fx), ay = Math.abs(fy);
  if (ax > 0.0001 || ay > 0.0001) {
    if (ax > ay) {
      p.facing = (fx > 0) ? 'right' : 'left';
    } else {
      p.facing = (fy > 0) ? 'down' : 'up';
    }
  }
}

prevX = p.x; prevY = p.y;
  } // *** CHANGED: close fixJoystickDelta properly

    
    // ===== ROTATED-FULL AIM (Full-only override; guns.js stays untouched) =====
  // Single calibration knob: pick one of -90, 90, 180, or 0
  const ROT_AIM_DEG = 270;

  function _rotVecQuick(x, y, deg){
    switch(((deg % 360) + 360) % 360){
      case 0:   return {x,       y      };
      case 90:  return {x: -y,   y:  x  }; // +90° CCW
      case 180: return {x: -x,   y: -y  };
      case 270: return {x:  y,   y: -x  }; // -90° CW
      default:  return {x, y};
    }
  }

  let _origAimOwner = null;
  let _origAimKey   = null;
  let _origAimFn    = null;
  let _aimFindTimer = null;

  // Try common homes: IZZA.guns.aimVector, guns.aimVector, global aimVector
  function _findAimVector(){
  const paths = [
    ['IZZA','guns','aimVector'],
    ['guns','aimVector'],
    ['aimVector']
  ];
  for (const path of paths){
    let obj = window, parent = null, key = null;
    for (let i=0; i<path.length; i++){
      key = path[i];
      if (typeof obj[key] === 'undefined'){ obj = null; break; }
      parent = (i < path.length-1) ? obj[key] : obj; // owner of final key
      obj = obj[key];
    }
    if (typeof obj === 'function'){      // obj is the aimVector fn
      return { parent, key, fn: obj };   // owner, property name, function
    }
  }
  return null;
}

  function _installRotatedAim(){
    if (_origAimFn) return true; // already installed

    const found = _findAimVector();
    if (!found) return false;

    // Keep handles so we can restore exactly
    _origAimOwner = found.parent;
    _origAimKey   = found.key;
    _origAimFn    = found.fn;

    // New Full-only aim that mirrors guns.js behavior then rotates result
    const rotatedAim = function(...args){
      // call the real guns.js aim first
      const v = _origAimFn.apply(this, args);
      // expect {x,y}; rotate it for the rotated canvas
      if (v && typeof v.x === 'number' && typeof v.y === 'number'){
        return _rotVecQuick(v.x, v.y, ROT_AIM_DEG);
      }
      return v;
    };

    try { _origAimOwner[_origAimKey] = rotatedAim; } catch {}
    return true;
  }

  function _ensureRotatedAimSoon(){
    if (_installRotatedAim()) return;
    // guns.js may not be loaded yet; retry briefly
    if (_aimFindTimer) return;
    _aimFindTimer = setInterval(()=>{
      if (_installRotatedAim()){
        clearInterval(_aimFindTimer);
        _aimFindTimer = null;
      }
    }, 200);
  }

  function _removeRotatedAim(){
    if (_aimFindTimer){ clearInterval(_aimFindTimer); _aimFindTimer = null; }
    if (_origAimOwner && _origAimKey && _origAimFn){
      try { _origAimOwner[_origAimKey] = _origAimFn; } catch {}
    }
    _origAimOwner = _origAimKey = _origAimFn = null;
  }
  // ---------- enter / exit ----------
  let fireTick=null, joyHooked=false;
  function enter(){
    if(active) return; active=true;
    BODY.setAttribute('data-fakeland','1');
        _ensureRotatedAimSoon();   // << install Full-only aim override
    ensureFullButton(); fullBtn.textContent='Exit';
    adopt(); applyLayout();
    closeMapsOnEnter();

    try{ mo.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['style','class','id']}); }catch{}

    clearInterval(fireTick); fireTick=setInterval(placeFire,350);

    if(!joyHooked && window.IZZA && IZZA.on){
  IZZA.on('update-post', fixJoystickDelta);
  
  joyHooked = true;
}
    prevX=null; prevY=null;
  }
  function exit(){
    if(!active) return; active=false;
    BODY.removeAttribute('data-fakeland');
        _removeRotatedAim();       // << restore the original guns.js aim
    ensureFullButton(); fullBtn.textContent='Full';
    mo.disconnect(); clearInterval(fireTick); fireTick=null;
    restoreMiniOnExit();
    restore();
    stage.style.transform=''; canvas.style.width=canvas.style.height='';
    try{ location.href='https://izzapay.onrender.com/signin'; }catch{}
    setTimeout(keepFullVisible, 0);
  }

  // boot: make sure button exists & is placed in normal view
  ensureFullButton();
  keepFullVisible();

  // keep scale right + keep button placed in normal view
  const onResize=()=>{ if(active) requestAnimationFrame(()=>requestAnimationFrame(applyLayout)); else keepFullVisible(); };
  addEventListener('resize', onResize, {passive:true});
  addEventListener('orientationchange', ()=>{ setTimeout(()=>{ active?onResize():keepFullVisible(); },120); }, {passive:true});

  console.log('[IZZA land] ready');
})();
