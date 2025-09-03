/**
 * IZZA Multiplayer Client — v1.6 (input-shield while lobby open)
 * - Friends: request / accept
 * - Lobby invites with 30-min notification window
 * - Auto-poll notifications every 5s
 * - Safe WS boot (non-blocking; uses server-advertised ws_url if provided)
 * - Hard input shield: blocks A/B/I keys + HUD button events while lobby open
 * - Fallback search (works even if server search not live yet)
 * - Path auto-fallback: supports /izza-game/api/mp/{...} AND /izza-game/api/mp/mp/{...}
 */
(function(){
  const BUILD='v1.6-mp-client+input-shield';
  console.log('[IZZA PLAY]', BUILD);

  const CFG = {
    base: (window.__MP_BASE__ || '/izza-game/api/mp'),
    prefix: '',
    altPrefix: '/mp',
    ws:   (window.__MP_WS__   || '/izza-game/api/mp/ws'),
    searchDebounceMs: 250,
    minChars: 2,
    notifTTLsec: 1800,
    notifPollMs: 5000
  };

  // -------- STATE --------
  let ws=null, wsReady=false, reconnectT=null, lastQueueMode=null;
  let me=null;                // {username, ranks, inviteLink, ws_url?}
  let friends=[];             // [{username,active,friend:true}]
  let lobby=null;
  let ui = {};
  let notifHost=null;
  let mounted=false;
  let notifTimer=null;

  // Input shield state (shared with building plugin via events)
  let lobbyOpen=false;
  let shield=null;
  let hudEls=[];
  let hudCssPrev=[];

  // -------- UTIL --------
  const $  = (sel,root=document)=> root.querySelector(sel);
  const $$ = (sel,root=document)=> Array.from(root.querySelectorAll(sel));
  const toast = (t)=> (window.IZZA && IZZA.emit) ? IZZA.emit('toast',{text:t}) : console.log('[TOAST]',t);

  async function _fetchJSON(url, init){
    const r = await fetch(url, init);
    return { ok: r.ok, status: r.status, json: r.ok ? await r.json() : null };
  }
  function _mkUrl(path){ return CFG.base + CFG.prefix + path; }
  function _mkAlt(path){ return CFG.base + CFG.altPrefix + path; }

  async function jget(path){
    let res = await _fetchJSON(_mkUrl(path), {credentials:'include'});
    if(res.ok) return res.json;
    if(res.status === 404 && CFG.prefix !== CFG.altPrefix){
      const res2 = await _fetchJSON(_mkAlt(path), {credentials:'include'});
      if(res2.ok){ CFG.prefix = CFG.altPrefix; return res2.json; }
    }
    throw new Error(`${res.status || '???'} GET ${path}`);
  }
  async function jpost(path, body){
    let res = await _fetchJSON(_mkUrl(path), {
      method:'POST', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify(body||{})
    });
    if(res.ok) return res.json;
    if(res.status === 404 && CFG.prefix !== CFG.altPrefix){
      const res2 = await _fetchJSON(_mkAlt(path), {
        method:'POST', credentials:'include',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify(body||{})
      });
      if(res2.ok){ CFG.prefix = CFG.altPrefix; return res2.json; }
    }
    throw new Error(`${res.status || '???'} POST ${path}`);
  }
  function debounced(fn, ms){
    let t=null, lastArgs=null;
    return function(...args){ lastArgs=args; clearTimeout(t); t=setTimeout(()=>fn.apply(this,lastArgs), ms); };
  }

  // -------- DATA --------
  async function loadMe(){ me = await jget('/me'); return me; }
  async function loadFriends(){
    const res = await jget('/friends/list');
    friends = (res.friends||[]).map(f=>({username:f.username, active:!!f.active, friend:true}));
    return friends;
  }
  async function searchFriendsServer(q){
    const res = await jget('/friends/search?q='+encodeURIComponent(q||''));
    return res.users || [];
  }
  async function refreshRanks(){
    try{ const res = await jget('/ranks'); if(res && res.ranks) me.ranks = res.ranks; paintRanks(); }
    catch(e){ /* ignore */ }
  }

  // -------- FRIEND ACTIONS --------
  async function sendFriendRequest(username){
    try{ await jpost('/friends/request', { username }); toast('Friend request sent to '+username); }
    catch(e){ toast('Could not send request: '+e.message); }
  }
  async function acceptFriend(username){
    try{
      await jpost('/friends/accept', { username });
      toast('You are now friends with '+username);
      await loadFriends(); repaintFriendsArea();
    }catch(e){ toast('Could not accept: '+e.message); }
  }

  // -------- LOBBY INVITES --------
  async function inviteToLobby(username){
    try{
      const res = await jpost('/lobby/invite', { toUsername: username });
      if(res && res.ok){ toast('Lobby invite sent to '+username); return; }
      const reason = (res && (res.reason || res.error)) || 'unavailable';
      let msg = 'Your friend cannot join right now.';
      if(reason==='in_game')  msg = 'Your friend is currently in a game.';
      if(reason==='offline')  msg = 'Your friend is offline.';
      if(reason==='ended')    msg = 'Your friend ended their session.';
      if(reason==='not_friends') msg = 'You must be friends before inviting to a lobby.';
      showConfirm(`${msg}\n\nSend them a notification to join your lobby now?`, async ()=>{
        try{ await jpost('/lobby/notify', { toUsername: username, ttlSec: CFG.notifTTLsec }); toast('Notification queued for '+username); }
        catch(e){ toast('Could not queue notification: '+e.message); }
      });
    }catch(e){ toast('Invite failed: '+e.message); }
  }

  // -------- NOTIFICATIONS UI --------
  function ensureNotifHost(){
    if(notifHost) return notifHost;
    notifHost=document.createElement('div');
    Object.assign(notifHost.style,{
      position:'fixed', right:'12px', top:'12px', zIndex: 1001,
      display:'flex', flexDirection:'column', gap:'8px'
    });
    document.body.appendChild(notifHost);
    return notifHost;
  }
  function showBanner(html, onAccept, onDismiss){
    const host=ensureNotifHost();
    const card=document.createElement('div');
    card.style.cssText='background:#0f1625;border:1px solid #2a3550;border-radius:12px;color:#cfe0ff;padding:10px 12px;min-width:260px;max-width:80vw;box-shadow:0 4px 16px rgba(0,0,0,.35)';
    card.innerHTML = `
      <div style="font-weight:700;margin-bottom:6px">Notification</div>
      <div style="opacity:.9;line-height:1.35;margin-bottom:10px">${html}</div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        ${onDismiss?'<button class="mp-small ghost">Dismiss</button>':''}
        ${onAccept?'<button class="mp-small">Accept</button>':''}
      </div>`;
    const btns=card.querySelectorAll('button');
    if(onDismiss) btns[0].onclick=()=>{ card.remove(); onDismiss(); };
    if(onAccept)  btns[btns.length-1].onclick=()=>{ card.remove(); onAccept(); };
    host.appendChild(card);
  }
  function showConfirm(text, onYes){ showBanner(text.replace(/\n/g,'<br>'), onYes, ()=>{}); }
  async function pullNotifications(){
    try{
      const res = await jget('/notifications');
      const invites  = res.invites  || [];
      const requests = res.requests || [];
      requests.forEach(r=> showBanner(`Friend request from <b>${r.from}</b>`, ()=> acceptFriend(r.from), ()=>{}));
      invites.forEach(inv=>{
        showBanner(
          `<b>${inv.from}</b> invited you to their lobby${inv.mode?` (${prettyMode(inv.mode)})`:''}. Join?`,
          async ()=>{
            try{
              const ok = await jpost('/lobby/accept', { from: inv.from });
              toast(ok && ok.mode ? 'Joining lobby…' : 'Accepted invite');
            }catch(e){ toast('Could not join: '+e.message); }
          },
          ()=>{}
        );
      });
    }catch(e){ /* non-fatal */ }
  }

  // -------- RENDER HELPERS --------
  function prettyMode(mode){
    return mode==='br10'?'Battle Royale (10)': mode==='v1'?'1v1': mode==='v2'?'2v2':'3v3';
  }
  function paintRanks(){
    if(!lobby || !me || !me.ranks) return;
    const set = (id,key)=>{
      const el = $(id,lobby); if(!el) return;
      const r = me.ranks[key] || {w:0,l:0};
      const span = $('span', el); if(span) span.textContent = `${r.w}W / ${r.l}L`;
    };
    set('#r-br10','br10'); set('#r-v1','v1'); set('#r-v2','v2'); set('#r-v3','v3');
  }

  function makeRow(username, active, friend){
    const row=document.createElement('div');
    row.className='friend';
    row.innerHTML = `
      <div>
        <div>${username}</div>
        <div class="meta ${active?'active':'offline'}">${active?'Active':'Offline'}</div>
      </div>
      <div style="display:flex; gap:8px">
        ${friend
          ? `<button class="mp-small" data-invite="${username}">Invite to Lobby</button>`
          : `<button class="mp-small" data-request="${username}">Add Friend</button>`}
        ${active ? `<button class="mp-small outline" data-lobby="${username}">Invite Now</button>` : ''}
      </div>
    `;
    row.querySelector('[data-request]')?.addEventListener('click', ()=> sendFriendRequest(username));
    row.querySelector('[data-invite]')?.addEventListener('click', ()=> inviteToLobby(username));
    row.querySelector('[data-lobby]')?.addEventListener('click', ()=> inviteToLobby(username));
    return row;
  }

  function paintFriends(list){
    if(!lobby) return;
    const host = $('#mpFriends', lobby);
    if(!host) return;
    host.innerHTML='';
    if(!list.length){
      const empty=document.createElement('div');
      empty.className='meta'; empty.style.opacity='0.8';
      empty.textContent='No friends yet. Search a Pi username above or share your invite link.';
      host.appendChild(empty); return;
    }
    list.forEach(fr=> host.appendChild(makeRow(fr.username, !!fr.active, !!fr.friend)));
  }

  function paintSearchResults(q, results, usedFallback=false){
    const host = $('#mpFriends', lobby);
    if(!host) return;
    host.innerHTML='';
    if(results.length){
      results.forEach(u=> host.appendChild(makeRow(u.username, !!u.active, !!u.friend)));
      if(usedFallback){
        const note=document.createElement('div');
        note.className='meta'; note.style.opacity='0.8';
        note.textContent='(Showing local/fallback results.)';
        host.appendChild(note);
      }
      return;
    }
    const none=document.createElement('div');
    none.className='meta'; none.style.opacity='0.8'; none.style.marginBottom='8px';
    none.textContent='No results.';
    host.appendChild(none);
    if(q && q.length>=CFG.minChars){
      const row=document.createElement('div');
      row.className='friend';
      row.innerHTML = `
        <div>
          <div>${q}</div>
          <div class="meta">Not found — send a friend request?</div>
        </div>
        <button class="mp-small" data-request="${q}">Add Friend</button>
      `;
      row.querySelector('button').addEventListener('click', ()=> sendFriendRequest(q));
      host.appendChild(row);
    }
  }

  function repaintFriendsArea(){
    const search = $('#mpSearch', lobby);
    if(search && search.value.trim().length >= CFG.minChars){
      search.dispatchEvent(new Event('input'));
    }else{
      paintFriends(friends);
    }
  }

  // -------- PRESENCE / QUEUE --------
  function updatePresence(user, active){
    const f = friends.find(x=>x.username===user);
    if(f){ f.active = !!active; repaintFriendsArea(); }
  }

  async function enqueue(mode){
    try{
      lastQueueMode = mode;
      if(ui.queueMsg) ui.queueMsg.textContent = `Queued for ${prettyMode(mode)}… (waiting for match)`;
      await jpost('/queue', { mode });
    }catch(e){
      if(ui.queueMsg) ui.queueMsg.textContent = '';
      toast('Queue error: '+e.message);
    }
  }
  async function dequeue(){
    try{ await jpost('/dequeue'); }catch(e){ /* ignore */ }
    if(ui.queueMsg) ui.queueMsg.textContent = '';
    lastQueueMode=null;
  }

  // -------- SOCKET --------
  function connectWS(urlOverride){
    let finalPath = urlOverride || me?.ws_url || CFG.ws;
    try{
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = finalPath.startsWith('ws') ? finalPath : (proto + '//' + location.host + finalPath);
      ws = new WebSocket(url);
    }catch(e){ console.warn('WS failed to construct', e); return; }

    ws.addEventListener('open', ()=>{ wsReady=true; });
    ws.addEventListener('close', ()=>{
      wsReady=false; ws=null;
      if(reconnectT) clearTimeout(reconnectT);
      reconnectT=setTimeout(()=>connectWS(urlOverride), 2500);
    });
    ws.addEventListener('message', (evt)=>{
      let msg=null; try{ msg=JSON.parse(evt.data); }catch{}
      if(!msg) return;

      if(msg.type==='presence'){
        updatePresence(msg.user, !!msg.active);

      }else if(msg.type==='notify.request'){
        showBanner(`Friend request from <b>${msg.from}</b>`, ()=> acceptFriend(msg.from), ()=>{});

      }else if(msg.type==='notify.invite'){
        showBanner(
          `<b>${msg.from}</b> invited you to their lobby${msg.mode?` (${prettyMode(msg.mode)})`:''}. Join?`,
          async ()=>{
            try{ await jpost('/lobby/accept', { from: msg.from }); toast('Joining lobby…'); }
            catch(e){ toast('Could not join: '+e.message); }
          },
          ()=>{}
        );

      }else if(msg.type==='queue.update' && ui.queueMsg){
        const eta = msg.estMs!=null ? ` ~${Math.ceil(msg.estMs/1000)}s` : '';
        ui.queueMsg.textContent = `Queued for ${prettyMode(msg.mode)}… (${msg.pos||1} in line${eta})`;

      }else if(msg.type==='match.found'){
        if(ui.queueMsg) ui.queueMsg.textContent = '';
        if(lobby){ lobby.style.display='none'; }
        window.IZZA?.emit?.('mp-start', { mode: msg.mode, matchId: msg.matchId, players: msg.players });
        toast('Match found! Starting…');

      }else if(msg.type==='match.result'){
        if(msg.newRanks){ me = me || {}; me.ranks = msg.newRanks; paintRanks(); }
      }
    });
  }
  async function maybeConnectWS(){ try{ connectWS(me?.ws_url); }catch(e){} }

  // -------- HARD INPUT SHIELD --------
  function keyIsABI(e){
    const k=(e.key||'').toLowerCase();
    return k==='a' || k==='b' || k==='i';
  }
  function swallow(e){
    e.stopImmediatePropagation(); e.stopPropagation(); e.preventDefault?.();
  }
  function installShield(){
    if(lobbyOpen) return;
    lobbyOpen=true;

    // 1) Global keyboard shield (keydown/keypress/keyup)
    const keyHandler = (ev)=>{ if(lobbyOpen && keyIsABI(ev)) swallow(ev); };
    ['keydown','keypress','keyup'].forEach(type=>{
      window.addEventListener(type, keyHandler, {capture:true});
    });
    // keep a ref so we can remove later
    installShield._keyHandler = keyHandler;

    // 2) HUD buttons shield
    hudEls = ['#btnA','#btnB','#btnI'].map(id=>document.querySelector(id)).filter(Boolean);
    hudCssPrev = hudEls.map(el=>el.getAttribute('style')||'');
    hudEls.forEach(el=>{
      // disable interactions
      el.style.pointerEvents='none';
      el.style.opacity='0';         // keep them truly invisible
      // swallow any stray captured events
      const swallowClick = (e)=> lobbyOpen && swallow(e);
      el.addEventListener('click', swallowClick, true);
      el.addEventListener('touchstart', swallowClick, true);
      el.addEventListener('pointerdown', swallowClick, true);
      // stash handler for removal
      el.__mp_swallow = swallowClick;
    });

    // 3) Full-page overlay to intercept any stray taps
    shield = document.createElement('div');
    Object.assign(shield.style, {
      position:'fixed', inset:'0', zIndex: 1002, // above game canvas/HUD, below our modal card (1003+ in building)
      background:'transparent',
      touchAction:'none'
    });
    // But don't block inside the lobby card (it has higher z-index)
    document.body.appendChild(shield);
  }
  function removeShield(){
    if(!lobbyOpen) return;
    lobbyOpen=false;

    // keys
    if(installShield._keyHandler){
      ['keydown','keypress','keyup'].forEach(type=>{
        window.removeEventListener(type, installShield._keyHandler, {capture:true});
      });
      installShield._keyHandler=null;
    }
    // hud
    hudEls.forEach((el,i)=>{
      if(!el) return;
      // restore style
      el.setAttribute('style', hudCssPrev[i]||'');
      if(el.__mp_swallow){
        el.removeEventListener('click', el.__mp_swallow, true);
        el.removeEventListener('touchstart', el.__mp_swallow, true);
        el.removeEventListener('pointerdown', el.__mp_swallow, true);
        delete el.__mp_swallow;
      }
    });
    hudEls=[]; hudCssPrev=[];

    // overlay
    if(shield && shield.parentNode) shield.parentNode.removeChild(shield);
    shield=null;
  }

  // Listen for modal open/close from the building plugin
  (function wireModalBus(){
    // If your core emits custom events, we hook them; otherwise the building plugin does.
    if(window.IZZA && IZZA.on){
      IZZA.on('ui-modal-open', (e)=>{ if(e?.id==='mpLobby') installShield(); });
      IZZA.on('ui-modal-close', (e)=>{ if(e?.id==='mpLobby') removeShield(); });
      IZZA.on('mp-start', ()=> removeShield()); // starting a duel also clears shield
    }
  })();

  // -------- LOBBY WIRING --------
  function mountLobby(host){
    if(mounted) return;
    lobby = host || document.getElementById('mpLobby');
    if(!lobby) return;
    mounted = true;

    ui.queueMsg = $('#mpQueueMsg', lobby);

    $$('.mp-btn', lobby).forEach(btn=>{
      btn.onclick = ()=> enqueue(btn.getAttribute('data-mode'));
    });

    $('#mpClose', lobby)?.addEventListener('click', ()=>{ if(lastQueueMode) dequeue(); });

    $('#mpCopyLink', lobby)?.addEventListener('click', async ()=>{
      try{
        const res = await jget('/me');
        const link = (res && res.inviteLink)
          || (location.origin + '/izza-game/auth?src=invite&from=' + encodeURIComponent(res.username||'player'));
        await navigator.clipboard.writeText(link);
        toast('Invite link copied');
      }catch(e){
        const link = location.origin + '/izza-game/auth';
        toast('Copy failed; showing link…');
        prompt('Copy this invite link:', link);
      }
    });

    const search = $('#mpSearch', lobby);
    if(search){
      const run = debounced(async ()=>{
        const q = search.value.trim();
        if(q.length < CFG.minChars){ paintFriends(friends); return; }

        const host = $('#mpFriends', lobby);
        if(host){ host.innerHTML = `<div class="meta" style="opacity:.8">Searching “${q}”…</div>`; }

        try{
          const list = await searchFriendsServer(q);
          if(Array.isArray(list) && list.length){
            paintSearchResults(q, list.map(u=>({username:u.username, active:!!u.active, friend:!!u.friend})));
            return;
          }
          const local = friends.filter(x=> x.username.toLowerCase().includes(q.toLowerCase()));
          paintSearchResults(q, local, /*usedFallback*/ true);
        }catch(e){
          const local = friends.filter(x=> x.username.toLowerCase().includes(q.toLowerCase()));
          paintSearchResults(q, local, /*usedFallback*/ true);
        }
      }, CFG.searchDebounceMs);
      search.oninput = run;
    }

    paintRanks();
    paintFriends(friends);
  }

  let obs=null;
  function bootObserver(){
    if(obs) return;
    obs = new MutationObserver(()=>{
      const h = document.getElementById('mpLobby');
      if(!h) return;
      const visible = h.style.display && h.style.display!=='none';
      if(visible) mountLobby(h);
    });
    const root = document.body || document.documentElement;
    if(root) obs.observe(root, {subtree:true, attributes:true, childList:true, attributeFilter:['style']});
  }

  // -------- BOOT --------
  async function start(){
    try{
      await loadMe(); await loadFriends(); refreshRanks();
      await maybeConnectWS();
      bootObserver();

      // Poll notifications
      pullNotifications();
      if(!notifTimer) notifTimer = setInterval(pullNotifications, CFG.notifPollMs);

      const h=document.getElementById('mpLobby');
      if(h && h.style.display && h.style.display!=='none') mountLobby(h);

      console.log('[MP] client ready', {user:me?.username, friends:friends.length, ws:!!ws});
    }catch(e){
      console.error('MP client start failed', e);
      toast('Multiplayer unavailable: '+e.message);
    }
  }
  if(document.readyState==='complete' || document.readyState==='interactive') start();
  else addEventListener('DOMContentLoaded', start, {once:true});
})();
