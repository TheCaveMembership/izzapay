/* izza-orientation-landscape.plugin.js — rotated overlay + resilient Full/Exit + joystick fix + hide chat in Full */
(function(){
  const BASE_W=960, BASE_H=540, TILE=60;
  const BODY=document.body;
  const card=document.getElementById('gameCard');
  const canvas=document.getElementById('game');
  const hud=document.querySelector('.hud');
  const stickEl=document.getElementById('stick');
  const ctrls=document.querySelector('.controls');
  const mini=document.getElementById('miniWrap');
  if(!card||!canvas||!hud||!stickEl||!ctrls) return;

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

      /* Joystick — larger, nudged right (visual only; input corrected in code) */
      #izzaLandStage #stick{
        position:absolute;left:48px;bottom:24px;
        width:180px;height:180px;transform:none;transform-origin:center center;
      }
      #izzaLandStage #stick .base{border-radius:90px!important;}
      #izzaLandStage #stick .nub{
        left:50%!important;top:50%!important;transform:translate(-50%,-50%)!important;
        width:48px!important;height:48px!important;border-radius:24px!important;
      }

      /* Minimap preview position (we’ll hide it on enter) */
      #izzaLandStage #miniWrap{position:absolute;right:12px;top:74px;display:block;}

      /* Chat row (hidden in Full to avoid OS keyboard issues) */
      #izzaLandStage #chatBar,
      #izzaLandStage .land-chat-dock{
        position:absolute !important;
        left:12px !important; right:12px !important; bottom:8px !important;
        margin:0 !important; z-index:18 !important;
        transform:rotate(-90deg) !important;
        transform-origin:left bottom !important;
      }
      body[data-fakeland="1"] #chatBar,
      body[data-fakeland="1"] .land-chat-dock{ display:none !important; } /* hide while in Full */

      /* Hearts + bell/badge/dropdown + friends (upright inside stage) */
      #izzaLandStage #heartsHud{position:absolute!important;right:14px;top:46px;}
      #izzaLandStage #mpNotifBell{position:absolute!important;right:14px;top:12px;}
      #izzaLandStage #mpNotifBadge{position:absolute!important;right:6px;top:4px;}
      #izzaLandStage #mpNotifDropdown{
        position:absolute!important;right:10px;top:44px;max-height:300px;
        transform:rotate(-90deg)!important;transform-origin:top right!important;
      }
      #izzaLandStage #mpFriendsToggleGlobal{
        position:absolute!important;right:14px!important;bottom:72px!important;top:auto!important;left:auto!important;
      }
      #izzaLandStage #mpFriendsPopup{
        position:absolute!important;right:14px!important;bottom:116px!important;top:auto!important;left:auto!important;
        transform:rotate(-90deg)!important;transform-origin:right bottom!important;
      }

      /* FIRE (tile-placed; scaled up) */
      #izzaLandStage #btnFire,
      #izzaLandStage #fireBtn,
      #izzaLandStage .btn-fire,
      #izzaLandStage button[data-role="fire"],
      #izzaLandStage .fire{
        position:absolute!important;transform:scale(1.35);transform-origin:center;
      }

      /* Small Full/Exit button (Map-sized) */
      #izzaFullToggle{position:fixed;right:12px;bottom:72px;z-index:10010;}
      #izzaLandStage #izzaFullToggle{
        position:absolute!important;right:14px!important;bottom:116px!important;
        top:auto!important;left:auto!important;z-index:10010!important;
      }

      /* Modals upright anywhere */
      body[data-fakeland="1"] .modal{transform:none!important;}
      #izzaLandStage .modal{
        position:absolute!important;left:50%!important;top:50%!important;
        transform:translate(-50%,-50%) rotate(-90deg)!important;
        transform-origin:center center!important;z-index:20!important;
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

  // find chat bar reliably and tag with helper class if needed
  function findChatDock(){
    const direct = byId('chatBar') || byId('areaChatDock') || document.querySelector('.area-chat');
    if(direct) return direct;
    const txt = document.querySelector('input[placeholder="Type…"],textarea[placeholder="Type…"],input[placeholder="Type..."],textarea[placeholder="Type..."]');
    if(txt){ const row = txt.closest('#chatBar,.area-chat,.chat,.row,div'); if(row){ row.classList.add('land-chat-dock'); return row; } }
    return null;
  }

  // --- resilient Full/Exit button (re-create if missing) --------------------
  function ensureFullButton(){
    let btn = byId('izzaFullToggle');
    if(!btn){
      btn=document.createElement('button');
      btn.id='izzaFullToggle'; btn.className='btn'; btn.type='button';
      btn.textContent=active?'Exit':'Full';
      btn.addEventListener('click',(e)=>{ e.preventDefault(); e.stopPropagation(); active?exit():enter(); }, {passive:false});
      document.body.appendChild(btn);
    }
    Object.assign(btn.style,{position:'fixed',right:'12px',bottom:'72px',zIndex:'10010',display:'block',opacity:'1',pointerEvents:'auto'});
    return btn;
  }
  let fullBtn = ensureFullButton();

  function adopt(){
    keep(card,'card'); keep(hud,'hud'); keep(stickEl,'stick'); keep(ctrls,'ctrls'); if(mini) keep(mini,'mini');
    const chat=findChatDock(); if(chat) adoptOnce(chat,'chat');
    ['heartsHud','mpNotifBell','mpNotifBadge','mpNotifDropdown','mpFriendsToggleGlobal','mpFriendsPopup'].forEach(id=>{ const n=byId(id); if(n) adoptOnce(n,id); });
    const fire=byId('btnFire')||byId('fireBtn')||document.querySelector('.btn-fire,.fire,button[data-role="fire"]'); if(fire) adoptOnce(fire,'btnFire');
    fullBtn = ensureFullButton();
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

  // tile helpers + FIRE placement (and kill tiny dash under it)
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
    const pop=byId('mpFriendsPopup');        if(pop){ pop.style.right='14px'; pop.style.bottom='116px'; pop.style.top=''; pop.style.left=''; }
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
    const fire=byId('btnFire')||byId('fireBtn')||document.querySelector('.btn-fire,.fire,button[data-role="fire"],#shootBtn');
    if(fire && !stage.contains(fire)) adoptOnce(fire,'btnFire');
    // Button could have been removed; re-ensure
    fullBtn = ensureFullButton();
    requestAnimationFrame(()=>{ placeFire(); pinFriendsUI(); });
  });

  // keep the map closed when entering Full (both big modal + mini preview)
  function closeMapsOnEnter(){
    const big=byId('mapModal'); if(big && getComputedStyle(big).display!=='none') big.style.display='none';
    if(mini){ mini.style.display='none'; }
  }
  function restoreMiniOnExit(){ if(mini){ mini.style.display=''; } }

  // ---------- Joystick: rotate ONLY while stick is being dragged -------------
  let joyActive=false;
  const markOn = ()=>{ joyActive=true; };
  const markOff= ()=>{ joyActive=false; };
  stickEl.addEventListener('touchstart',markOn,{passive:false});
  stickEl.addEventListener('mousedown', markOn);
  window.addEventListener('touchend',  markOff, {passive:true});
  window.addEventListener('mouseup',   markOff, {passive:true});
  window.addEventListener('touchcancel',markOff,{passive:true});

  // Correct per-frame player movement by -90° when joystick is active:
  // Observed wrong mapping: right→down, left→up, up→right, down→left (≈ +90° rotation).
  // Fix: rotate the delta by -90° (x',y') = ( y, -x ) while dragging.
  let prevX=null, prevY=null;
  function fixJoystickDelta(){
    if(!joyActive || !window.IZZA || !IZZA.api || !IZZA.api.player) { prevX=null; prevY=null; return; }
    const p = IZZA.api.player;
    if(prevX==null || prevY==null){ prevX=p.x; prevY=p.y; return; }
    const dx = p.x - prevX, dy = p.y - prevY;
    // only adjust meaningful movement
    if(Math.abs(dx)+Math.abs(dy) > 0.0001){
      const fx =  dy;
      const fy = -dx;
      p.x = prevX + fx;
      p.y = prevY + fy;
    }
    prevX = p.x; prevY = p.y;
  }

  // ---------- enter / exit ----------
  let active=false, fireTick=null, joyHooked=false;
  function enter(){
    if(active) return; active=true;
    BODY.setAttribute('data-fakeland','1');
    fullBtn = ensureFullButton(); fullBtn.textContent='Exit';
    adopt(); applyLayout();
    closeMapsOnEnter();

    try{ mo.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['style','class','id']}); }catch{}

    clearInterval(fireTick); fireTick=setInterval(placeFire,350);

    // hook once into the game loop to correct joystick motion
    if(!joyHooked && window.IZZA && IZZA.on){
      IZZA.on('update-post', fixJoystickDelta);
      joyHooked = true;
    }
    prevX=null; prevY=null;
  }
  function exit(){
    if(!active) return; active=false;
    BODY.removeAttribute('data-fakeland');
    fullBtn = ensureFullButton(); fullBtn.textContent='Full';
    mo.disconnect(); clearInterval(fireTick); fireTick=null;
    restoreMiniOnExit();
    restore();
    stage.style.transform=''; canvas.style.width=canvas.style.height='';
    try{ location.href='https://izzapay.onrender.com/signin'; }catch{}
  }

  // ensure button is alive even if something nukes it
  fullBtn = ensureFullButton();

  // keep scale right
  const onResize=()=>{ if(active) requestAnimationFrame(()=>requestAnimationFrame(applyLayout)); };
  addEventListener('resize', onResize, {passive:true});
  addEventListener('orientationchange', ()=>setTimeout(onResize,120), {passive:true});

  console.log('[IZZA land] ready');
})();
