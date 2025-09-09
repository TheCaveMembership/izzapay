/* izza-orientation-landscape.plugin.js
   One rotated+scaled overlay; no other files touched. */
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

  // ---------- CSS ----------
  (function injectCSS(){
    if (document.getElementById('izzaLandscapeCSS')) return;
    const css = `
      body[data-fakeland="1"]{ overflow:hidden; background:#0b0f17; }

      /* Rotated stage that holds the play layer */
      #izzaLandStage{
        position:fixed; left:50%; top:50%;
        width:${BASE_W}px; height:${BASE_H}px;
        transform-origin:center center;
        z-index:15; pointer-events:none;
      }
      #izzaLandStage > *{ pointer-events:auto; }

      #izzaLandStage #game{ width:${BASE_W}px !important; height:${BASE_H}px !important; display:block; }

      /* HUD inside stage */
      #izzaLandStage .hud{ position:absolute; left:12px; right:12px; top:8px; }

      /* A/B/I/Map row (you already nailed this) */
      #izzaLandStage .controls{
        position:absolute; right:14px; bottom:14px;
        display:flex; gap:10px;
      }

      /* Joystick bottom-left — IMPORTANT: no rotation (fixes axis mapping) */
      #izzaLandStage #stick{
        position:absolute; left:14px; bottom:14px;
        width:120px; height:120px;
        transform:none; /* no -90deg */
      }

      /* Minimap */
      #izzaLandStage #miniWrap{ position:absolute; right:12px; top:74px; display:block; }

      /* Chat bar docked along the bottom, upright text */
      #izzaLandStage #chatBar{
        position:absolute !important; left:12px; right:12px; bottom:8px;
        transform:rotate(-90deg); transform-origin:left bottom;
      }

      /* Hearts + bell live inside stage when active */
      #izzaLandStage #heartsHud{ position:absolute !important; right:14px; top:46px; }

      /* We’ll move bell + badge + dropdown into stage coords via JS */
      #izzaLandStage #mpNotifBell{ position:absolute !important; right:14px; top:12px; }
      #izzaLandStage #mpNotifBadge{ position:absolute !important; right:6px; top:4px; }
      #izzaLandStage #mpNotifDropdown{
        position:absolute !important; right:10px; top:44px; max-height:300px;
      }

      /* CTA */
      .izzaland-cta{ position:fixed; left:50%; bottom:18px; transform:translateX(-50%);
        padding:10px 14px; border-radius:10px; background:rgba(0,0,0,.65); color:#fff; z-index:1000; }
      .izzaland-cta.hide{ display:none; }
    `;
    const tag=document.createElement('style'); tag.id='izzaLandscapeCSS'; tag.textContent=css; document.head.appendChild(tag);
  })();

  // ---------- build rotated stage & adopt nodes ----------
  const stage = document.createElement('div'); stage.id='izzaLandStage';
  const ph = {};
  const keepPlace = (el, key)=>{ ph[key]=document.createComment('ph-'+key); el.parentNode.insertBefore(ph[key], el); stage.appendChild(el); };

  // optional helpers
  const byId = (id)=> document.getElementById(id);

  function adopt(){
    keepPlace(card,'card');
    keepPlace(hud,'hud');
    keepPlace(stick,'stick');
    keepPlace(ctrls,'ctrls');
    if (mini) keepPlace(mini,'mini');

    // chat bar from area-chat plugin
    const chatBar = byId('chatBar');           /* from v1_area_chat.plugin.js */    //  [oai_citation:3‡v1_area_chat.plugin.js](file-service://file-BXpEEHCaHN7DxGBjCF6Eba)
    if (chatBar){ keepPlace(chatBar,'chat'); }

    // hearts HUD from hearts plugin
    const hearts = byId('heartsHud');          /* created by v4_hearts.js */        //  [oai_citation:4‡v4_hearts.js](file-service://file-CZeVJRvprWh9KqNHS4N8yx)
    if (hearts){ keepPlace(hearts,'hearts'); }

    // MP bell overlays (if present)
    const bell   = byId('mpNotifBell');
    const badge  = byId('mpNotifBadge');
    const drop   = byId('mpNotifDropdown');
    if (bell)  keepPlace(bell,'bell');
    if (badge) keepPlace(badge,'badge');
    if (drop)  keepPlace(drop,'drop');

    document.body.appendChild(stage);
  }

  function restore(){
    const putBack=(node,key)=>{ try{ ph[key].parentNode.insertBefore(node, ph[key]); ph[key].remove(); }catch{} };
    putBack(card,'card'); putBack(hud,'hud'); putBack(stick,'stick'); putBack(ctrls,'ctrls');
    if (mini) putBack(mini,'mini');

    const chat = byId('chatBar');   if (chat)  putBack(chat,'chat');
    const hearts = byId('heartsHud'); if (hearts) putBack(hearts,'hearts');

    const bell=byId('mpNotifBell'); if (bell)  putBack(bell,'bell');
    const badge=byId('mpNotifBadge'); if (badge) putBack(badge,'badge');
    const drop=byId('mpNotifDropdown'); if (drop) putBack(drop,'drop');

    try{ stage.remove(); }catch{}
  }

  // ---------- layout ----------
  function applyLayout(){
    const vw=innerWidth, vh=innerHeight;
    const scale = Math.min(vw/BASE_H, vh/BASE_W);
    stage.style.transform = `translate(-50%, -50%) rotate(90deg) scale(${scale})`;

    // keep canvas intrinsic
    canvas.style.width = BASE_W+'px';
    canvas.style.height= BASE_H+'px';
  }

  // ---------- enter/exit ----------
  let active=false;
  function enter(){
    if(active) return; active=true;
    BODY.setAttribute('data-fakeland','1');
    adopt(); applyLayout(); cta.classList.add('hide');
  }
  function exit(){
    if(!active) return; active=false;
    BODY.removeAttribute('data-fakeland');
    restore(); stage.style.transform=''; canvas.style.width=canvas.style.height='';
    cta.classList.remove('hide');
  }

  // ---------- CTA ----------
  const cta=document.createElement('button'); cta.className='izzaland-cta'; cta.type='button';
  cta.textContent='Rotate to landscape for best play'; document.body.appendChild(cta);
  cta.addEventListener('click', enter, {passive:true});

  // ---------- keep scale right ----------
  const onResize=()=>{ if(active) requestAnimationFrame(()=>requestAnimationFrame(applyLayout)); };
  addEventListener('resize', onResize, {passive:true});
  addEventListener('orientationchange', ()=> setTimeout(onResize,120), {passive:true});

  console.log('[IZZA land] ready');
})();
