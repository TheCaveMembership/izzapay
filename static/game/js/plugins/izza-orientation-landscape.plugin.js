/* izza-orientation-landscape.plugin.js — rotate content only (Bell/Friends/Trade), keep containers unrotated; landscape stage + controls */
(function(){
  const BASE_W=960, BASE_H=540, TILE=60;
  const BODY=document.body;

  const card   = document.getElementById('gameCard');
  const canvas = document.getElementById('game');
  const hud    = document.querySelector('.hud');
  const stick  = document.getElementById('stick');
  const ctrls  = document.querySelector('.controls');
  const mini   = document.getElementById('miniWrap');
  if(!card||!canvas||!hud||!stick||!ctrls) return;

  // FIRE placement (bigger, a touch left)
  const FIRE_TILES_RIGHT = 6.0;
  const FIRE_TILES_DOWN  = 1;

  // ---------- CSS (minimal; NO generic modal rotation) ----------
  if(!document.getElementById('izzaLandscapeCSS')){
    const css = `
      body[data-fakeland="1"]{overflow:hidden;background:#0b0f17;}

      #izzaLandStage{
        position:fixed;left:50%;top:50%;
        width:${BASE_W}px;height:${BASE_H}px;
        transform-origin:center center;z-index:15;pointer-events:none;
      }
      #izzaLandStage > *{pointer-events:auto;}
      #izzaLandStage #game{width:${BASE_W}px!important;height:${BASE_H}px!important;display:block;}

      /* HUD + controls */
      #izzaLandStage .hud{position:absolute;left:12px;right:12px;top:8px;}
      #izzaLandStage .controls{position:absolute;right:14px;bottom:14px;display:flex;gap:10px;}

      /* Joystick (visual only) */
      #izzaLandStage #stick{position:absolute;left:48px;bottom:24px;width:180px;height:180px;transform:none;transform-origin:center;}
      #izzaLandStage #stick .base{border-radius:90px!important;}
      #izzaLandStage #stick .nub{left:50%!important;top:50%!important;transform:translate(-50%,-50%)!important;width:48px!important;height:48px!important;border-radius:24px!important;}

      /* Minimap */
      #izzaLandStage #miniWrap{position:absolute;right:12px;top:74px;display:block;}

      /* Chat row hidden in Full (OSK issues) */
      #izzaLandStage #chatBar,
      #izzaLandStage .land-chat-dock{
        position:absolute!important;left:12px!important;right:12px!important;bottom:8px!important;
        margin:0!important;z-index:18!important;
        transform:rotate(-90deg)!important;transform-origin:left bottom!important;
      }
      body[data-fakeland="1"] #chatBar,
      body[data-fakeland="1"] .land-chat-dock{display:none!important;}

      /* Hearts + bell/badge */
      #izzaLandStage #heartsHud{position:absolute!important;right:14px;top:46px;}
      #izzaLandStage #mpNotifBell{position:absolute!important;right:14px;top:12px;}
      #izzaLandStage #mpNotifBadge{position:absolute!important;right:6px;top:4px;}

      /* Bell dropdown container: centered, unrotated */
      #izzaLandStage #mpNotifDropdown{
        position:absolute!important;left:50%!important;top:50%!important;right:auto!important;bottom:auto!important;
        transform:translate(-50%, -50%)!important;margin:0!important;z-index:9999!important;
        overflow:visible!important;pointer-events:auto!important;
      }
      /* Friends popup container: centered, unrotated */
      #izzaLandStage #mpFriendsPopup{
        position:absolute!important;left:50%!important;top:50%!important;right:auto!important;bottom:auto!important;
        transform:translate(-50%, -50%)!important;margin:0!important;z-index:9999!important;
        overflow:visible!important;pointer-events:auto!important;
      }
      /* Friends toggle stays docked */
      #izzaLandStage #mpFriendsToggleGlobal{
        position:absolute!important;right:14px!important;bottom:72px!important;top:auto!important;left:auto!important;
      }

      /* Trade Centre container: centered, unrotated (content will be rotated by JS) */
      #izzaLandStage #tradeCentreModal,
      #izzaLandStage [data-pool="trade-centre"],
      #izzaLandStage .izza-trade-centre{
        position:absolute!important;left:50%!important;top:50%!important;right:auto!important;bottom:auto!important;
        transform:translate(-50%, -50%)!important;margin:0!important;z-index:9999!important;
        overflow:visible!important;pointer-events:auto!important;
      }

      /* Backdrop was the opaque slab; hide in rotated mode */
      body[data-fakeland="1"] .backdrop{display:none!important;}

      /* FIRE (tile-placed; scaled up) */
      #izzaLandStage #btnFire,
      #izzaLandStage #fireBtn,
      #izzaLandStage .btn-fire,
      #izzaLandStage button[data-role="fire"],
      #izzaLandStage .fire{
        position:absolute!important;transform:scale(1.35);transform-origin:center;
      }

      /* Full/Exit button */
      #izzaFullToggle{position:fixed;z-index:10010;display:inline-block;line-height:1;padding:8px 12px;border-radius:10px;}
      #izzaLandStage #izzaFullToggle{position:absolute!important;right:14px!important;bottom:116px!important;top:auto!important;left:auto!important;z-index:10010!important;}
    `;
    const tag=document.createElement('style'); tag.id='izzaLandscapeCSS'; tag.textContent=css; document.head.appendChild(tag);
  }

  // ---------- helpers ----------
  const byId = (id)=>document.getElementById(id);
  const stage=document.createElement('div'); stage.id='izzaLandStage';
  const ph={}; // placeholders to restore on exit
  const keep=(el,key)=>{ ph[key]=document.createComment('ph-'+key); el.parentNode.insertBefore(ph[key],el); stage.appendChild(el); };
  const adoptOnce=(el,key)=>{ if(!el||ph[key]) return; keep(el,key); };

  /**
   * Rotate CONTENT ONLY: keep host (container) unrotated + centered.
   * If measure=true, swap host width/height to match rotated content (useful for fixed cards like Trade Centre).
   */
  function rotateContentOnly(host, {measure=false}={}){
    if(!host) return;

    // Ensure wrapper for rotated content
    let wrapper = host.querySelector(':scope > .izza-upright');
    if(!wrapper){
      wrapper = document.createElement('div');
      wrapper.className='izza-upright';
      while(host.firstChild){ wrapper.appendChild(host.firstChild); }
      host.appendChild(wrapper);
    }

    // Center host (unrotated)
    Object.assign(host.style,{
      position:'absolute',left:'50%',top:'50%',right:'auto',bottom:'auto',
      transform:'translate(-50%,-50%)',margin:'0',zIndex:'9999',
      overflow:'visible',pointerEvents:'auto'
    });

    // Counter-rotate content
    wrapper.style.transformOrigin='top left';
    wrapper.style.writingMode='horizontal-tb';
    wrapper.style.transform='rotate(-90deg)';

    // DO NOT nuke descendant transforms/positions for Bell/Friends — they need their own layouts.
    // Only measure for fixed cards if requested.
    if(measure){
      const prev = wrapper.style.transform;
      wrapper.style.transform='none';
      const w = wrapper.scrollWidth;
      const h = wrapper.scrollHeight;
      wrapper.style.transform=prev;
      // host should size to rotated content bounding box (swap)
      host.style.width  = h + 'px';
      host.style.height = w + 'px';
    }else{
      host.style.width=''; host.style.height='';
    }
  }

  // Specific fixers
  function fixNotifDropdown(){
    const el = byId('mpNotifDropdown');
    if(!el) return;
    // adopt into stage and rotate content only (NO measure)
    if(!stage.contains(el) && el.parentNode) keep(el,'mpNotifDropdown');
    rotateContentOnly(el,{measure:false});
  }

  function fixFriendsPopup(){
    const el = byId('mpFriendsPopup');
    if(!el) return;
    if(!stage.contains(el) && el.parentNode) keep(el,'mpFriendsPopup');
    rotateContentOnly(el,{measure:false});
  }

  function fixTradeCentrePopup(){
    // try multiple selectors (your build sometimes uses data-pool)
    const t1 = byId('tradeCentreModal');
    const t2 = document.querySelector('#izzaLandStage [data-pool="trade-centre"], [data-pool="trade-centre"]');
    const els = [t1,t2].filter(Boolean);
    if(els.length===0){
      // last-resort: any visible modal whose text includes "Trade Centre"
      const cand = Array.from(document.querySelectorAll('.modal,[role="dialog"],[data-modal],[id$="Modal"]'))
        .filter(el => /trade\s*centre/i.test((el.innerText||'')));
      els.push(...cand);
    }
    els.forEach(el=>{
      if(!stage.contains(el) && el.parentNode) keep(el, el.id ? ('modal:'+el.id) : ('modal@trade:'+Date.now()));
      // Trade Centre = rotate content, MEASURE to keep centered nicely
      rotateContentOnly(el,{measure:true});
      // kill any local .backdrop near it
      (el.parentNode||document).querySelectorAll('.backdrop').forEach(b=>b.style.display='none');
    });
  }

  // Collect specific UI we care about (no generic modal sweep)
  function adoptUI(){
    keep(card,'card'); keep(hud,'hud'); keep(stick,'stick'); keep(ctrls,'ctrls'); if(mini) keep(mini,'mini');

    ['heartsHud','mpNotifBell','mpNotifBadge','mpFriendsToggleGlobal'].forEach(id=>{
      const n=byId(id); if(n) adoptOnce(n,id);
    });

    const fire = byId('btnFire')||byId('fireBtn')||document.querySelector('.btn-fire,.fire,button[data-role="fire"],#shootBtn');
    if(fire) adoptOnce(fire,'btnFire');

    // Popups (only the three we lock)
    const bell = byId('mpNotifDropdown'); if(bell) adoptOnce(bell,'mpNotifDropdown');
    const fr   = byId('mpFriendsPopup');  if(fr)   adoptOnce(fr,'mpFriendsPopup');

    // Trade centre may appear later; handled by fixer + mutation observer
    requestAnimationFrame(()=>{ fixNotifDropdown(); fixFriendsPopup(); fixTradeCentrePopup(); });

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
    const dash=sibs.find(el=>el!==fire && (el.textContent||'').trim()==='-'); if(dash) dash.style.display='none';
  }
  function pinFriendsUI(){
    const btn=byId('mpFriendsToggleGlobal'); if(btn){ btn.style.right='14px'; btn.style.bottom='72px'; btn.style.top=''; btn.style.left=''; }
  }

  // Layout for rotated stage
  function applyLayout(){
    const vw=innerWidth, vh=innerHeight;
    const scale=Math.min(vw/BASE_H, vh/BASE_W);
    stage.style.transform=`translate(-50%,-50%) rotate(90deg) scale(${scale})`;
    canvas.style.width=BASE_W+'px'; canvas.style.height=BASE_H+'px';
    requestAnimationFrame(()=>{ placeFire(); pinFriendsUI(); fixNotifDropdown(); fixFriendsPopup(); fixTradeCentrePopup(); });
  }

  // Mutation observer — only touch the three popups + keep button placement
  const mo=new MutationObserver(()=>{
    if(!active){ ensureFullButton(); placeFullButton(); return; }
    // re-adopt new instances if they appear
    const bell = byId('mpNotifDropdown'); if(bell && !stage.contains(bell)) keep(bell,'mpNotifDropdown');
    const fr   = byId('mpFriendsPopup');  if(fr && !stage.contains(fr)) keep(fr,'mpFriendsPopup');
    requestAnimationFrame(()=>{ fixNotifDropdown(); fixFriendsPopup(); fixTradeCentrePopup(); placeFire(); pinFriendsUI(); });
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
  stick.addEventListener('touchstart',markOn,{passive:false});
  stick.addEventListener('mousedown', markOn);
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
    const singleAxis = (Math.abs(dx) < 0.0001) ^ (Math.abs(dy) < 0.0001);
    if(mag < 0.0001 || singleAxis){ prevX=p.x; prevY=p.y; return; }

    // Rotate -90°: (x',y') = ( y, -x )
    const fx =  dy;
    const fy = -dx;
    p.x = prevX + fx;
    p.y = prevY + fy;

    prevX = p.x; prevY = p.y;
  }

  // ---------- Full/Exit button ----------
  let fullBtn=null, active=false;
  function ensureFullButton(){
    if(!fullBtn || !document.body.contains(fullBtn)){
      fullBtn=document.createElement('button');
      fullBtn.id='izzaFullToggle'; fullBtn.className='btn'; fullBtn.type='button';
      fullBtn.textContent = active ? 'Exit' : 'Full';
      fullBtn.style.lineHeight='1'; fullBtn.style.padding='8px 12px'; fullBtn.style.borderRadius='10px';
      fullBtn.addEventListener('click',(e)=>{ e.preventDefault(); e.stopPropagation(); active?exit():enter(); }, {passive:false});
      document.body.appendChild(fullBtn);
    }
    fullBtn.style.display='inline-block'; fullBtn.style.opacity='1'; fullBtn.style.pointerEvents='auto';
    placeFullButton();
    return fullBtn;
  }
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
        fullBtn.style.position='fixed'; fullBtn.style.left=left+'px'; fullBtn.style.top=top+'px';
        fullBtn.style.right=''; fullBtn.style.bottom=''; fullBtn.style.zIndex='10010';
      }else{
        fullBtn.style.position='fixed'; fullBtn.style.right='12px'; fullBtn.style.bottom='72px';
        fullBtn.style.left=''; fullBtn.style.top=''; fullBtn.style.zIndex='10010';
      }
    };
    requestAnimationFrame(()=>requestAnimationFrame(doPlace));
  }

  // ---------- enter / exit ----------
  let fireTick=null, joyHooked=false;
  function enter(){
    if(active) return; active=true;
    BODY.setAttribute('data-fakeland','1');
    ensureFullButton(); fullBtn.textContent='Exit';
    adoptUI(); applyLayout(); closeMapsOnEnter();
    try{ mo.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['style','class','id']}); }catch{}
    clearInterval(fireTick); fireTick=setInterval(placeFire,350);
    if(!joyHooked && window.IZZA && IZZA.on){ IZZA.on('update-post', fixJoystickDelta); joyHooked = true; }
    prevX=null; prevY=null;
  }
  function exit(){
    if(!active) return; active=false;
    BODY.removeAttribute('data-fakeland');
    ensureFullButton(); fullBtn.textContent='Full';
    mo.disconnect(); clearInterval(fireTick); fireTick=null;
    restoreMiniOnExit(); restore();
    stage.style.transform=''; canvas.style.width=canvas.style.height='';
    try{ location.href='https://izzapay.onrender.com/signin'; }catch{}
    setTimeout(()=>{ ensureFullButton(); placeFullButton(); },0);
  }

  // boot
  ensureFullButton(); placeFullButton();

  // keep scale right + keep button placed in normal view
  const onResize=()=>{ if(active) requestAnimationFrame(()=>requestAnimationFrame(applyLayout)); else { ensureFullButton(); placeFullButton(); } };
  addEventListener('resize', onResize, {passive:true});
  addEventListener('orientationchange', ()=>{ setTimeout(()=>{ active?onResize():placeFullButton(); },120); }, {passive:true});

  console.log('[IZZA land] ready (rotate content only for Bell/Friends/Trade)');
})();
