/* izza-orientation-landscape.plugin.js
   Rotate + scale one overlay that contains the whole play layer.
   No other files touched.
*/
(function () {
  const BASE_W = 960, BASE_H = 540;              // canvas intrinsic
  const TILE   = 60;                              // 960x540 => 16x9 => 60px tiles

  // tune these without touching other files
  const FIRE_TILES_RIGHT = 7;                     // move Fire this many tiles right from center
  const FIRE_TILES_DOWN  = 1;                     // and this many tiles down from center

  // core elements that MUST exist
  const card   = document.getElementById('gameCard');
  const canvas = document.getElementById('game');
  const hud    = document.querySelector('.hud');
  const stick  = document.getElementById('stick');
  const ctrls  = document.querySelector('.controls');
  const mini   = document.getElementById('miniWrap');

  if (!card || !canvas || !hud || !stick || !ctrls) {
    console.warn('[IZZA land] required nodes missing');
    return;
  }

  // opportunistic extras (may or may not exist, we’ll adopt them if found)
  function findFriends() {
    return (
      document.querySelector('#friendsBtn') ||
      Array.from(document.querySelectorAll('button,div')).find(n => /^\s*friends\s*$/i.test(n.textContent||'')) ||
      null
    );
  }
  function findChatDock() {
    return (
      document.querySelector('.area-chat') ||
      document.querySelector('#areaChatDock') ||
      document.querySelector('[data-izza-chat]') ||
      null
    );
  }

  // ---------- CSS (once) ----------
  (function injectCSS () {
    if (document.getElementById('izzaLandscapeCSS')) return;
    const tag = document.createElement('style');
    tag.id = 'izzaLandscapeCSS';
    tag.textContent = `
      body[data-fakeland="1"]{ overflow:hidden; background:#0b0f17; }

      /* single overlay we rotate+scale; keep z below modals (modals use z:20 in your CSS) */
      #izzaLandStage{
        position:fixed; left:50%; top:50%;
        width:${BASE_W}px; height:${BASE_H}px;
        transform-origin:center center;
        z-index:15;
        pointer-events:none;
      }
      #izzaLandStage > *{ pointer-events:auto; }

      /* keep canvas intrinsic */
      #izzaLandStage #game{ width:${BASE_W}px !important; height:${BASE_H}px !important; display:block; }

      /* HUD spans the top inside the rotated stage */
      #izzaLandStage .hud{
        position:absolute; left:12px; right:12px; top:8px;
        background:rgba(10,12,18,.60); border-bottom:1px solid #263042; border-radius:10px; padding:6px 8px;
      }

      /* A/B/I/Map as a bottom row */
      #izzaLandStage .controls{
        position:absolute; right:14px; bottom:14px;
        display:flex; flex-direction:row; gap:10px;
      }

      /* Joystick bottom-left; counter-rotate so axes feel natural */
      #izzaLandStage #stick{
        position:absolute; left:14px; bottom:14px;
        width:120px; height:120px;
        transform:rotate(-90deg);
        transform-origin:center center;
      }

      /* Minimap top-right */
      #izzaLandStage #miniWrap{
        position:absolute; right:12px; top:74px;
        display:block;
      }

      /* Fire button (best-effort: we don’t own its markup; try common selectors) */
      #izzaLandStage .fire, 
      #izzaLandStage #fireBtn, 
      #izzaLandStage button[data-role="fire"]{
        position:absolute !important;
        /* left/top are set in JS each layout pass so tile offsets stay correct */
      }

      /* Friends chip (if we can find it) – float near HUD right edge */
      #izzaLandStage .friends-chip{
        position:absolute; right:14px; top:100px;
      }

      /* chat dock (if detected) pinned along the bottom edge inside the stage */
      #izzaLandStage .land-chat-dock{
        position:absolute; left:12px; right:12px; bottom:8px;
        transform:rotate(-90deg);   /* make the input read upright after stage rotation */
        transform-origin:left bottom;
      }

      /* CTA button visible before entering fake-landscape */
      .izzaland-cta{
        position:fixed; left:50%; bottom:18px; transform:translateX(-50%);
        padding:10px 14px; border-radius:10px;
        background:rgba(0,0,0,.65); color:#fff;
        font:600 14px/1.1 system-ui,-apple-system,Segoe UI,Roboto,Arial;
        z-index:1000; backdrop-filter:saturate(140%) blur(6px);
      }
      .izzaland-cta.hide{ display:none; }
    `;
    document.head.appendChild(tag);
  })();

  // ---------- stage overlay + placeholders ----------
  const stage = document.createElement('div');
  stage.id = 'izzaLandStage';

  const ph = {
    hud:   document.createComment('ph-hud'),
    card:  document.createComment('ph-card'),
    stick: document.createComment('ph-stick'),
    ctrls: document.createComment('ph-ctrls'),
    mini:  document.createComment('ph-mini'),
    friends: null,
    chat: null
  };

  let friendsEl = null;
  let chatEl    = null;

  function adoptIntoStage () {
    // required
    hud.parentNode.insertBefore(ph.hud, hud);
    card.parentNode.insertBefore(ph.card, card);
    stick.parentNode.insertBefore(ph.stick, stick);
    ctrls.parentNode.insertBefore(ph.ctrls, ctrls);
    if (mini) mini.parentNode.insertBefore(ph.mini, mini);

    stage.appendChild(card);
    stage.appendChild(hud);
    stage.appendChild(stick);
    stage.appendChild(ctrls);
    if (mini) stage.appendChild(mini);

    // optional: friends
    friendsEl = findFriends();
    if (friendsEl) {
      ph.friends = document.createComment('ph-friends');
      friendsEl.parentNode.insertBefore(ph.friends, friendsEl);
      friendsEl.classList.add('friends-chip');
      stage.appendChild(friendsEl);
    }

    // optional: chat
    chatEl = findChatDock();
    if (chatEl) {
      ph.chat = document.createComment('ph-chat');
      chatEl.parentNode.insertBefore(ph.chat, chatEl);
      chatEl.classList.add('land-chat-dock');
      stage.appendChild(chatEl);
    }

    document.body.appendChild(stage);
  }

  function restoreFromStage () {
    try { ph.card.parentNode.insertBefore(card, ph.card); ph.card.remove(); } catch {}
    try { ph.hud.parentNode.insertBefore(hud, ph.hud); ph.hud.remove(); } catch {}
    try { ph.stick.parentNode.insertBefore(stick, ph.stick); ph.stick.remove(); } catch {}
    try { ph.ctrls.parentNode.insertBefore(ctrls, ph.ctrls); ph.ctrls.remove(); } catch {}
    try { if (mini) { ph.mini.parentNode.insertBefore(mini, ph.mini); ph.mini.remove(); } } catch {}

    try { if (friendsEl && ph.friends) { ph.friends.parentNode.insertBefore(friendsEl, ph.friends); ph.friends.remove(); friendsEl.classList.remove('friends-chip'); } } catch {}
    try { if (chatEl && ph.chat) { ph.chat.parentNode.insertBefore(chatEl, ph.chat); ph.chat.remove(); chatEl.classList.remove('land-chat-dock'); } } catch {}

    try { stage.remove(); } catch {}
  }

  // ---------- layout math on the OVERLAY (not the canvas) ----------
  function applyLayout () {
    const vw = window.innerWidth, vh = window.innerHeight;
    const scale = Math.min(vw / BASE_H, vh / BASE_W);
    stage.style.transform = `translate(-50%, -50%) rotate(90deg) scale(${scale})`;

    // keep canvas intrinsic
    canvas.style.width  = BASE_W + 'px';
    canvas.style.height = BASE_H + 'px';

    // FIRE button best-effort tile placement
    const fire =
      stage.querySelector('#fireBtn') ||
      stage.querySelector('.fire') ||
      stage.querySelector('button[data-role="fire"]');
    if (fire) {
      const cx = (BASE_W / 2) + (FIRE_TILES_RIGHT * TILE);
      const cy = (BASE_H / 2) + (FIRE_TILES_DOWN  * TILE);
      fire.style.left = (cx - fire.offsetWidth / 2) + 'px';
      fire.style.top  = (cy - fire.offsetHeight / 2) + 'px';
    }
  }

  // ---------- enter / exit ----------
  let active = false;

  function enter () {
    if (active) return;
    active = true;
    document.body.setAttribute('data-fakeland','1');
    adoptIntoStage();
    applyLayout();
    cta.classList.add('hide');
  }

  function exit () {
    if (!active) return;
    active = false;
    document.body.removeAttribute('data-fakeland');
    restoreFromStage();
    stage.style.transform = '';
    canvas.style.width = canvas.style.height = '';
    cta.classList.remove('hide');
  }

  // ---------- CTA ----------
  const cta = document.createElement('button');
  cta.className = 'izzaland-cta';
  cta.type = 'button';
  cta.textContent = 'Rotate to landscape for best play';
  document.body.appendChild(cta);
  cta.addEventListener('click', enter, { passive:true });

  // ---------- keep scale right on viewport changes ----------
  function onResize () {
    if (!active) return;
    requestAnimationFrame(() => requestAnimationFrame(applyLayout));
  }
  window.addEventListener('resize', onResize, { passive:true });
  window.addEventListener('orientationchange', () => setTimeout(onResize, 120), { passive:true });

  console.log('[IZZA land] ready');
})();
