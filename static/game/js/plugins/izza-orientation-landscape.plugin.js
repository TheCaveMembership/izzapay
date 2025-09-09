/* izza-orientation-landscape.plugin.js
   Rotated overlay + NEW landscape-only joystick/fire. Originals are hidden in landscape. */
(function () {
  const BASE_W = 960, BASE_H = 540;
  const TILE   = 60;                          // 16×9 → 60px tiles
  const BODY   = document.body;

  // must-exist nodes
  const card   = document.getElementById('gameCard');
  const canvas = document.getElementById('game');
  const hud    = document.querySelector('.hud');
  const stick  = document.getElementById('stick');       // original stick (portrait)
  const ctrls  = document.querySelector('.controls');
  const mini   = document.getElementById('miniWrap');
  if (!card || !canvas || !hud || !stick || !ctrls) return;

  // Fire placement in landscape (from screen center)
  const FIRE_TILES_RIGHT = 7;
  const FIRE_TILES_DOWN  = 1;

  // ---------- CSS ----------
  (function injectCSS(){
    if (document.getElementById('izzaLandscapeCSS')) return;
    const css = `
      body[data-fakeland="1"]{ overflow:hidden; background:#0b0f17; }

      /* Rotated stage for play layer */
      #izzaLandStage{
        position:fixed; left:50%; top:50%;
        width:${BASE_W}px; height:${BASE_H}px;
        transform-origin:center center;
        z-index:15; pointer-events:none;
      }
      #izzaLandStage > *{ pointer-events:auto; }

      #izzaLandStage #game{ width:${BASE_W}px !important; height:${BASE_H}px !important; display:block; }

      #izzaLandStage .hud{ position:absolute; left:12px; right:12px; top:8px; }
      #izzaLandStage .controls{ position:absolute; right:14px; bottom:14px; display:flex; gap:10px; }
      #izzaLandStage #miniWrap{ position:absolute; right:12px; top:74px; display:block; }

      /* Chat row bottom, upright */
      #izzaLandStage .land-chat-dock{
        position:absolute !important; left:12px; right:12px; bottom:8px;
        transform:rotate(-90deg); transform-origin:left bottom;
      }

      /* Hearts + bell */
      #izzaLandStage #heartsHud{ position:absolute !important; right:14px; top:46px; }
      #izzaLandStage #mpNotifBell{ position:absolute !important; right:14px; top:12px; }
      #izzaLandStage #mpNotifBadge{ position:absolute !important; right:6px; top:4px; }
      #izzaLandStage #mpNotifDropdown{
        position:absolute !important; right:10px; top:44px; max-height:300px;
        transform:rotate(-90deg); transform-origin:top right;
      }

      /* Friends */
      #izzaLandStage #mpFriendsToggleGlobal{
        position:absolute !important; right:14px !important; bottom:72px !important;
        top:auto !important; left:auto !important;
      }
      #izzaLandStage #mpFriendsPopup{
        position:absolute !important; right:14px !important; bottom:116px !important;
        top:auto !important; left:auto !important;
        transform:rotate(-90deg); transform-origin:right bottom;
      }

      /* NEW landscape-only joystick */
      #landStick{
        position:absolute; left:48px; bottom:24px; width:180px; height:180px;
        z-index:17; touch-action:none; pointer-events:auto;
        transform:rotate(-90deg);                    /* cancels stage +90 so axes are natural */
        transform-origin:center center;
      }
      #landStick .base{ position:absolute; inset:0; border-radius:90px; background:rgba(255,255,255,.08); border:1px solid #2a3550; }
      #landStick .nub{ position:absolute; width:48px; height:48px; border-radius:24px; left:50%; top:50%;
        transform:translate(-50%,-50%); background:#1f2a3f; border:1px solid #2a3550; }

      /* NEW landscape-only fire (kept upright visually by stage rotation) */
      #landFire{
        position:absolute; z-index:17; pointer-events:auto;
        width:72px; height:72px; border-radius:36px;
        background:#162134; color:#cfe0ff; border:1px solid #2a3550;
        display:flex; align-items:center; justify-content:center; font-weight:700; letter-spacing:.5px;
      }

      /* Full/Exit small button above Map */
      #izzaFullToggle{ position:fixed; right:12px; bottom:72px; z-index:8; }
      #izzaLandStage #izzaFullToggle{
        position:absolute !important; right:14px !important; bottom:116px !important; top:auto !important; left:auto !important;
      }

      /* Upright modals (even if accidentally inserted into stage) */
      body[data-fakeland="1"] .modal{ transform:none !important; }
      #izzaLandStage .modal{
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
  const qs  = (sel,root=document)=> root.querySelector(sel);

  function findChatDock(){
    let n = byId('chatBar') || byId('areaChatDock') || document.querySelector('.area-chat');
    if (n) return n;
    const txt = document.querySelector('input[placeholder="Type..."], textarea[placeholder="Type..."]');
    if (txt){ const row = txt.closest('.area-chat, .chat, .row, div'); if (row){ row.classList.add('land-chat-dock'); return row; } }
    return null;
  }

  // ---------- rotated stage + placeholders ----------
  const stage = document.createElement('div'); stage.id='izzaLandStage';
  const ph = {};
  function keepPlace(el, key){ ph[key]=document.createComment('ph-'+key); el.parentNode.insertBefore(ph[key], el); stage.appendChild(el); }
  function adoptOnce(el, key){ if(!el || ph[key]) return; keepPlace(el, key); }

  // Small Full/Exit above Map (uses your .btn style)
  const fullBtn = document.createElement('button');
  fullBtn.id='izzaFullToggle'; fullBtn.className='btn'; fullBtn.type='button'; fullBtn.textContent='Full';
  document.body.appendChild(fullBtn);

  // NEW: landscape-only controls
  const landStick = document.createElement('div');
  landStick.id='landStick';
  landStick.innerHTML = `<div class="base"></div><div class="nub"></div>`;
  const landNub = landStick.querySelector('.nub');

  const landFire = document.createElement('button');
  landFire.id='landFire'; landFire.type='button'; landFire.textContent='FIRE';

  // util: send synthetic key events (WASD/Arrows)
  const key = {
    down: new Set(),
    send(type, key, code){
      const e = new KeyboardEvent(type, {key, code, bubbles:true, cancelable:true});
      window.dispatchEvent(e);
    },
    press(code, keyName){
      if(!this.down.has(code)){ this.down.add(code); this.send('keydown', keyName, code); }
    },
    release(code, keyName){
      if(this.down.has(code)){ this.down.delete(code); this.send('keyup', keyName, code); }
    },
    releaseAll(){
      ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','KeyW','KeyA','KeyS','KeyD'].forEach(c=>{
        const keyName = (c.startsWith('Arrow')?c.replace('Arrow',''):c==='KeyW'?'w':c==='KeyA'?'a':c==='KeyS'?'s':'d');
        this.release(c, keyName);
      });
    }
  };

  // NEW joystick logic (simple radial with deadzone)
  (function wireLandStick(){
    let active=false, cx=0, cy=0, R=80, dead=10, vx=0, vy=0;

    function setNub(dx,dy){
      const len=Math.hypot(dx,dy);
      const cl = Math.min(len, R);
      const nx = (len? dx/len : 0)*cl;
      const ny = (len? dy/len : 0)*cl;
      landNub.style.transform = `translate(${nx}px, ${ny}px)`;
    }
    function decide(dx,dy){
      const ax=Math.abs(dx), ay=Math.abs(dy);
      const up    = dy < -dead, down = dy > dead;
      const left  = dx < -dead, right= dx > dead;

      // Release all then press the correct combination (arrows + wasd for safety)
      key.releaseAll();
      if(up){   key.press('ArrowUp','ArrowUp');   key.press('KeyW','w'); }
      if(down){ key.press('ArrowDown','ArrowDown'); key.press('KeyS','s'); }
      if(left){ key.press('ArrowLeft','ArrowLeft'); key.press('KeyA','a'); }
      if(right){key.press('ArrowRight','ArrowRight'); key.press('KeyD','d'); }
    }
    function pt(e){
      const r = landStick.getBoundingClientRect();
      const x = (e.touches? e.touches[0].clientX : e.clientX) - (r.left + r.width/2);
      const y = (e.touches? e.touches[0].clientY : e.clientY) - (r.top  + r.height/2);
      return {x,y};
    }

    function start(e){ active=true; e.preventDefault(); const p=pt(e); setNub(p.x,p.y); decide(p.x,p.y); }
    function move(e){ if(!active) return; e.preventDefault(); const p=pt(e); setNub(p.x,p.y); decide(p.x,p.y); }
    function end(){ active=false; landNub.style.transform='translate(-50%,-50%)'; key.releaseAll(); }

    landStick.addEventListener('touchstart', start, {passive:false});
    landStick.addEventListener('touchmove',  move,  {passive:false});
    landStick.addEventListener('touchend',   end,   {passive:false});
    landStick.addEventListener('pointerdown',start, {passive:false});
    landStick.addEventListener('pointermove', move, {passive:false});
    landStick.addEventListener('pointerup',   end,  {passive:false});
    landStick.addEventListener('pointercancel', end, {passive:false});
  })();

  // NEW fire logic (click original fire if found; else send “A” attack)
  function clickOriginalFire(){
    const orig =
      byId('btnFire') || byId('fireBtn') ||
      qs('.btn-fire, .fire, button[data-role="fire"]');
    if (orig && typeof orig.click === 'function') { orig.click(); return true; }
    // Fallback: “A” keypress (many builds use A for attack)
    const eDown = new KeyboardEvent('keydown',{key:'a',code:'KeyA',bubbles:true});
    const eUp   = new KeyboardEvent('keyup',{key:'a',code:'KeyA',bubbles:true});
    window.dispatchEvent(eDown); window.dispatchEvent(eUp);
    return false;
  }
  landFire.addEventListener('click', clickOriginalFire, {passive:true});
  landFire.addEventListener('touchstart', function(e){ e.preventDefault(); clickOriginalFire(); }, {passive:false});

  // tile → center px inside stage
  const tileCenter = (tx,ty)=>({ x:(BASE_W/2)+(tx*TILE), y:(BASE_H/2)+(ty*TILE) });

  // ---------- adopt + restore ----------
  function adopt(){
    keepPlace(card,'card'); keepPlace(hud,'hud'); keepPlace(stick,'stick'); keepPlace(ctrls,'ctrls'); if (mini) keepPlace(mini,'mini');

    const chat = findChatDock();                     if (chat)  adoptOnce(chat,'chat');
    const hearts = byId('heartsHud');                if (hearts) adoptOnce(hearts,'hearts');
    const bell   = byId('mpNotifBell');              if (bell)  adoptOnce(bell,'mpNotifBell');
    const badge  = byId('mpNotifBadge');             if (badge) adoptOnce(badge,'mpNotifBadge');
    const drop   = byId('mpNotifDropdown');          if (drop)  adoptOnce(drop,'mpNotifDropdown');
    const frBtn  = byId('mpFriendsToggleGlobal');    if (frBtn) adoptOnce(frBtn,'mpFriendsToggleGlobal');
    const frPop  = byId('mpFriendsPopup');           if (frPop) adoptOnce(frPop,'mpFriendsPopup');

    // put our landscape-only controls into the stage
    stage.appendChild(landStick);
    stage.appendChild(landFire);

    // and our full/exit toggle should move with stage
    adoptOnce(fullBtn,'izzaFullToggle');

    document.body.appendChild(stage);

    // hide original stick & fire while in landscape
    stick.style.display='none';
    const origFire = byId('btnFire') || byId('fireBtn') || qs('.btn-fire, .fire, button[data-role="fire"]');
    if(origFire){ origFire.__prevDisplay = origFire.style.display; origFire.style.display='none';
      // hide tiny “dash” below fire if any sibling equals "-"
      const dash = origFire.parentElement && Array.from(origFire.parentElement.children).find(el=> el!==origFire && (el.textContent||'').trim()==='-');
      if(dash){ dash.__prevDisplay = dash.style.display; dash.style.display='none'; origFire.__dash = dash; }
    }
  }

  function restore(){
    const putBack=(node,key)=>{ try{ ph[key].parentNode.insertBefore(node, ph[key]); ph[key].remove(); delete ph[key]; }catch{} };
    ['card','hud','stick','ctrls','mini','chat','hearts','mpNotifBell','mpNotifBadge','mpNotifDropdown','mpFriendsToggleGlobal','mpFriendsPopup','izzaFullToggle']
      .forEach(k=>{ const node = (k==='chat'? findChatDock() : byId(k)); if(node && ph[k]) putBack(node,k); });

    // remove our landscape-only controls
    try{ landStick.remove(); }catch{}
    try{ landFire.remove(); }catch{}
    try{ stage.remove(); }catch{}

    // unhide originals
    stick.style.display='';
    const origFire = byId('btnFire') || byId('fireBtn') || qs('.btn-fire, .fire, button[data-role="fire"]');
    if(origFire){
      origFire.style.display = (origFire.__prevDisplay || '');
      if(origFire.__dash){ origFire.__dash.style.display = (origFire.__dash.__prevDisplay || ''); delete origFire.__dash; }
      delete origFire.__prevDisplay;
    }
  }

  // ---------- layout ----------
  function placeFire(){
    const {x:cx, y:cy} = tileCenter(FIRE_TILES_RIGHT, FIRE_TILES_DOWN);
    const w = landFire.offsetWidth || 72, h = landFire.offsetHeight || 72;
    landFire.style.left = (cx - w/2) + 'px';
    landFire.style.top  = (cy - h/2) + 'px';
  }
  function applyLayout(){
    const vw=innerWidth, vh=innerHeight;
    const scale = Math.min(vw/BASE_H, vh/BASE_W);
    stage.style.transform = `translate(-50%, -50%) rotate(90deg) scale(${scale})`;
    canvas.style.width = BASE_W+'px';
    canvas.style.height= BASE_H+'px';
    requestAnimationFrame(placeFire);
  }

  // close map modal if it happens to be open
  function closeMapIfOpen(){
    const mm = byId('mapModal'); if(mm && getComputedStyle(mm).display!=='none') mm.style.display='none';
  }

  // observe late nodes (chat / friends popup / bell dropdown)
  const mo = new MutationObserver(()=>{ if(!active) return;
    const chat = findChatDock(); if(chat && !stage.contains(chat)) adoptOnce(chat,'chat');
    ['mpFriendsToggleGlobal','mpFriendsPopup','mpNotifBell','mpNotifBadge','mpNotifDropdown'].forEach(id=>{
      const n = byId(id); if(n && !stage.contains(n)) adoptOnce(n, id);
    });
    requestAnimationFrame(placeFire);
  });

  // ---------- enter / exit ----------
  let active=false;

  function enter(){
    if(active) return; active=true;
    BODY.setAttribute('data-fakeland','1');
    fullBtn.textContent='Exit';
    adopt(); closeMapIfOpen(); applyLayout();
    try{ mo.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['style','class','id']}); }catch{}
  }

  function exit(){
    if(!active) return; active=false;
    BODY.removeAttribute('data-fakeland');
    fullBtn.textContent='Full';
    mo.disconnect();
    restore();
    // clear transforms/sizes
    stage.style.transform=''; canvas.style.width=canvas.style.height='';
    // also ensure any stuck keys are released
    try{ key.releaseAll(); }catch{}
    // scroll back to top to avoid “black” gap from URL bars
    window.scrollTo(0,0);
  }

  // Full/Exit
  fullBtn.addEventListener('click', function(e){ e.preventDefault(); if(active) exit(); else enter(); }, {passive:false});

  // keep scale right
  const onResize=()=>{ if(active) requestAnimationFrame(()=>requestAnimationFrame(applyLayout)); };
  addEventListener('resize', onResize, {passive:true});
  addEventListener('orientationchange', ()=> setTimeout(onResize,120), {passive:true});

  console.log('[IZZA land] ready');
})();
