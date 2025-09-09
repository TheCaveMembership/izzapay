/* izza-orientation-landscape.plugin.js — rotated overlay + small Full/Exit */
(function(){
  const BASE_W=960, BASE_H=540, TILE=60;
  const BODY=document.body;

  // core nodes
  const card   = document.getElementById('gameCard');
  const canvas = document.getElementById('game');
  const hud    = document.querySelector('.hud');
  const stick  = document.getElementById('stick');
  const ctrls  = document.querySelector('.controls');
  const mini   = document.getElementById('miniWrap');
  if(!card||!canvas||!hud||!stick||!ctrls) return;

  // FIRE placement: bigger, a touch left
  const FIRE_TILES_RIGHT = 6.2;   // ← was 7
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

      /* Joystick: larger, nudged right, and keep axes correct */
      #izzaLandStage #stick{
        position:absolute;left:52px;bottom:26px;
        width:176px;height:176px;
        transform:none; /* keep raw coords; we’ll fix visuals with nub centering */
        transform-origin:center center;
      }
      #izzaLandStage #stick .base{border-radius:88px!important;}
      #izzaLandStage #stick .nub{
        left:50%!important;top:50%!important;transform:translate(-50%,-50%)!important;
        width:48px!important;height:48px!important;border-radius:24px!important;
      }

      /* Minimap (button + wrap) */
      #izzaLandStage #miniWrap{position:absolute;right:12px;top:74px;display:block;}

      /* Chat row pinned along the bottom (force class if needed) */
      #izzaLandStage #chatBar,
      #izzaLandStage .land-chat-dock{
        position:absolute!important;left:12px;right:12px;bottom:8px;
        transform:rotate(-90deg);transform-origin:left bottom;
      }

      /* Hearts + bell/badge/dropdown + friends */
      #izzaLandStage #heartsHud{position:absolute!important;right:14px;top:46px;}
      #izzaLandStage #mpNotifBell{position:absolute!important;right:14px;top:12px;}
      #izzaLandStage #mpNotifBadge{position:absolute!important;right:6px;top:4px;}
      #izzaLandStage #mpNotifDropdown{
        position:absolute!important;right:10px;top:44px;max-height:300px;
        transform:rotate(-90deg);transform-origin:top right;
      }
      #izzaLandStage #mpFriendsToggleGlobal{
        position:absolute!important;right:14px!important;bottom:72px!important;top:auto!important;left:auto!important;
      }
      #izzaLandStage #mpFriendsPopup{
        position:absolute!important;right:14px!important;bottom:116px!important;top:auto!important;left:auto!important;
        transform:rotate(-90deg);transform-origin:right bottom;
      }

      /* FIRE (placed by tiles + scaled up) */
      #izzaLandStage #btnFire,
      #izzaLandStage .btn-fire,
      #izzaLandStage #fireBtn,
      #izzaLandStage button[data-role="fire"],
      #izzaLandStage .fire{
        position:absolute!important;transform:scale(1.38);transform-origin:center;
      }

      /* Small Full/Exit button (Map-sized) — sits just above Map */
      #izzaFullToggle{
        position:fixed;right:12px;bottom:72px;z-index:10000; /* stop click-through */
        pointer-events:auto;
      }
      #izzaLandStage #izzaFullToggle{position:absolute!important;right:14px!important;bottom:116px!important;top:auto!important;left:auto!important;}

      /* Modals upright anywhere */
      body[data-fakeland="1"] .modal{transform:none!important;}
      #izzaLandStage .modal{
        position:absolute!important;left:50%!important;top:50%!important;
        transform:translate(-50%,-50%) rotate(-90deg)!important;transform-origin:center center!important;z-index:20!important;
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

  // find chat bar reliably and tag with helper class
  function findChatDock(){
    let n = byId('chatBar');
    if(!n){
      const txt = document.querySelector('input[placeholder="Type…"],textarea[placeholder="Type…"],input[placeholder="Type..."],textarea[placeholder="Type..."]');
      if(txt) n = txt.closest('#chatBar,.area-chat,.chat,.row,div');
    }
    if(n) n.classList.add('land-chat-dock'); // force our dock rules
    return n||null;
  }

  // tiny Full/Exit button
  const fullBtn=document.createElement('button');
  fullBtn.id='izzaFullToggle'; fullBtn.className='btn'; fullBtn.type='button'; fullBtn.textContent='Full';
  document.body.appendChild(fullBtn);

  function adopt(){
    keep(card,'card'); keep(hud,'hud'); keep(stick,'stick'); keep(ctrls,'ctrls'); if(mini) keep(mini,'mini');
    const chat=findChatDock(); if(chat) adoptOnce(chat,'chat');
    ['heartsHud','mpNotifBell','mpNotifBadge','mpNotifDropdown','mpFriendsToggleGlobal','mpFriendsPopup'].forEach(id=>{ const n=byId(id); if(n) adoptOnce(n,id); });
    const fire=byId('btnFire')||byId('fireBtn')||document.querySelector('.btn-fire,.fire,button[data-role="fire"]'); if(fire) adoptOnce(fire,'btnFire');
    adoptOnce(fullBtn,'izzaFullToggle');
    document.body.appendChild(stage);
  }
  function restore(){
    const putBack=(node,key)=>{ try{ ph[key].parentNode.insertBefore(node,ph[key]); ph[key].remove(); delete ph[key]; }catch{} };
    ['card','hud','stick','ctrls','mini','chat','heartsHud','mpNotifBell','mpNotifBadge','mpNotifDropdown','mpFriendsToggleGlobal','mpFriendsPopup','btnFire','izzaFullToggle']
      .forEach(k=>{
        const node=(k==='btnFire')?(byId('btnFire')||byId('fireBtn')||document.querySelector('.btn-fire,.fire,button[data-role="fire"]')):byId(k);
        if(node&&ph[k]) putBack(node,k);
      });
    try{ stage.remove(); }catch{}
  }

  // tile helpers + FIRE placement
  const tileCenter=(tx,ty)=>({ x:(BASE_W/2)+tx*TILE, y:(BASE_H/2)+ty*TILE });
  function placeFire(){
    const fire=byId('btnFire')||byId('fireBtn')||document.querySelector('#izzaLandStage .btn-fire,#izzaLandStage .fire,#izzaLandStage button[data-role="fire"]');
    if(!fire) return;
    const {x:cx,y:cy}=tileCenter(FIRE_TILES_RIGHT,FIRE_TILES_DOWN);
    const w=fire.offsetWidth||72, h=fire.offsetHeight||72;
    fire.style.left=(cx-w/2)+'px';
    fire.style.top =(cy-h/2)+'px';
    // nuke the tiny dash element if it exists under FIRE
    const sibs=Array.from(fire.parentElement?fire.parentElement.children:[]);
    const dash=sibs.find(el=>el!==fire && (el.textContent||'').trim()==='-');
    if(dash) dash.style.display='none';
  }
  function pinFriendsUI(){
    const btn=byId('mpFriendsToggleGlobal'); if(btn){ btn.style.right='14px'; btn.style.bottom='72px'; btn.style.top=''; btn.style.left=''; }
    const pop=byId('mpFriendsPopup'); if(pop){ pop.style.right='14px'; pop.style.bottom='116px'; pop.style.top=''; pop.style.left=''; }
  }

  function applyLayout(){
    const vw=innerWidth, vh=innerHeight;
    const scale=Math.min(vw/BASE_H, vh/BASE_W);
    stage.style.transform=`translate(-50%,-50%) rotate(90deg) scale(${scale})`;
    canvas.style.width=BASE_W+'px'; canvas.style.height=BASE_H+'px';
    requestAnimationFrame(()=>{ placeFire(); pinFriendsUI(); });
  }

  // observe late nodes (chat/friends/bell/fire)
  const mo=new MutationObserver(()=>{
    if(!active) return;
    const chat=findChatDock(); if(chat && !stage.contains(chat)) adoptOnce(chat,'chat');
    ['mpFriendsToggleGlobal','mpFriendsPopup','mpNotifBell','mpNotifBadge','mpNotifDropdown'].forEach(id=>{
      const n=byId(id); if(n && !stage.contains(n)) adoptOnce(n,id);
    });
    const fire=byId('btnFire')||byId('fireBtn')||document.querySelector('.btn-fire,.fire,button[data-role="fire"]');
    if(fire && !stage.contains(fire)) adoptOnce(fire,'btnFire');
    requestAnimationFrame(()=>{ placeFire(); pinFriendsUI(); });
  });

  // keep the mini map closed & avoid click-through on Map when entering Full
  function closeMini(){
    try{
      const wrap = byId('miniWrap');
      if(wrap) wrap.style.display='none';
      const modal = byId('mapModal'); // just in case
      if(modal) modal.style.display='none';
    }catch{}
  }

  // ---------- enter / exit ----------
  let active=false, fireTick=null;
  function enter(){
    if(active) return; active=true;
    BODY.setAttribute('data-fakeland','1');
    fullBtn.textContent='Exit';
    adopt(); applyLayout();
    closeMini();
    try{ mo.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['style','class','id']}); }catch{}
    clearInterval(fireTick); fireTick=setInterval(placeFire,350);
  }

  function exit(){
    // hard-redirect as requested
    window.location.href = 'https://izzapay.onrender.com/signin';
  }

  // toggle button (block any click-through)
  function stopAll(e){ e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); }
  ['click','touchstart','touchend','pointerup','pointerdown'].forEach(ev=>{
    fullBtn.addEventListener(ev, stopAll, {passive:false});
  });
  fullBtn.addEventListener('click', ()=>{ active?exit():enter(); });

  // keep scale right
  const onResize=()=>{ if(active) requestAnimationFrame(()=>requestAnimationFrame(applyLayout)); };
  addEventListener('resize', onResize, {passive:true});
  addEventListener('orientationchange', ()=>setTimeout(onResize,120), {passive:true});

  console.log('[IZZA land] ready');
})();
