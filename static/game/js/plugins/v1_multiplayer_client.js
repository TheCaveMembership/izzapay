/**
 * IZZA Multiplayer Client — v1.5 (game_app paths)
 * - Friends: request / accept
 * - Lobby invites with 30-min notification window
 * - Auto-poll notifications every 5s
 * - Safe WS boot (non-blocking; uses server-advertised ws_url if provided)
 * - Hotkey guard while typing (I/B/A won't trigger)
 * - Fallback search (works even if server search not live yet)
 * - Path auto-fallback: supports /izza-game/api/mp/{...} AND /izza-game/api/mp/mp/{...}
 */
(function(){
  const BUILD='v1.5-mp-client+gameapp-paths';
  console.log('[IZZA PLAY]', BUILD);

  const CFG = {
    base: (window.__MP_BASE__ || '/izza-game/api/mp'),
    // prefix is appended between base and endpoint; will switch to '/mp' automatically if server uses nested routes
    prefix: '',
    altPrefix: '/mp',
    ws:   (window.__MP_WS__   || '/izza-game/api/mp/ws'),
    searchDebounceMs: 250,
    minChars: 2,
    notifTTLsec: 1800,  // 30 minutes
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

  // -------- UTIL --------
  const $  = (sel,root=document)=> root.querySelector(sel);
  const $$ = (sel,root=document)=> Array.from(root.querySelectorAll(sel));
  const toast = (t)=> (window.IZZA && IZZA.emit) ? IZZA.emit('toast',{text:t}) : console.log('[TOAST]',t);

  async function _fetchJSON(url, init){
    const r = await fetch(url, init);
    // We treat 404 specially for path auto-fallback
    return { ok: r.ok, status: r.status, json: r.ok ? await r.json() : null };
  }

  function _mkUrl(path){ return CFG.base + CFG.prefix + path; }
  function _mkAlt(path){ return CFG.base + CFG.altPrefix + path; }

  async function jget(path){
    // try current prefix
    let res = await _fetchJSON(_mkUrl(path), {credentials:'include'});
    if(res.ok) return res.json;
    if(res.status === 404 && CFG.prefix !== CFG.altPrefix){
      // try alt once, then switch permanently
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
      // fallback try
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
  async function loadMe(){
    me = await jget('/me');   // if this 404s with new backend, we auto-switch to '/mp/me'
    return me;
  }
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
    try{
      await jpost('/friends/request', { username });
      toast('Friend request sent to '+username);
    }catch(e){ toast('Could not send request: '+e.message); }
  }
  async function acceptFriend(username){
    try{
      await jpost('/friends/accept', { username });
      toast('You are now friends with '+username);
      await loadFriends();
      repaintFriendsArea();
    }catch(e){ toast('Could not accept: '+e.message); }
  }

  // -------- LOBBY INVITES --------
  async function inviteToLobby(username){
    try{
      const res = await jpost('/lobby/invite', { toUsername: username });
      if(res && res.ok){
        toast('Lobby invite sent to '+username);
        return;
      }
      const reason = (res && (res.reason || res.error)) || 'unavailable';
      let msg = 'Your friend cannot join right now.';
      if(reason==='in_game')  msg = 'Your friend is currently in a game.';
      if(reason==='offline')  msg = 'Your friend is offline.';
      if(reason==='ended')    msg = 'Your friend ended their session.';
      if(reason==='not_friends') msg = 'You must be friends before inviting to a lobby.';
      showConfirm(`${msg}\n\nSend them a notification to join your lobby now?`, async ()=>{
        try{
          await jpost('/lobby/notify', { toUsername: username, ttlSec: CFG.notifTTLsec });
          toast('Notification queued for '+username);
        }catch(e){ toast('Could not queue notification: '+e.message); }
      });
    }catch(e){
      toast('Invite failed: '+e.message);
    }
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
  function showConfirm(text, onYes){
    showBanner(text.replace(/\n/g,'<br>'), onYes, ()=>{});
  }
  async function pullNotifications(){
    try{
      const res = await jget('/notifications');
      const invites  = res.invites  || [];
      const requests = res.requests || [];
      requests.forEach(r=>{
        showBanner(
          `Friend request from <b>${r.from}</b>`,
          ()=> acceptFriend(r.from),
          ()=>{}
        );
      });
      invites.forEach(inv=>{
        showBanner(
          `<b>${inv.from}</b> invited you to their lobby${inv.mode?` (${prettyMode(inv.mode)})`:''}. Join?`,
          async ()=>{
            try{
              const ok = await jpost('/lobby/accept', { from: inv.from });
              if(ok && ok.mode){
                // If your game reacts to mp-start, we can emit here later.
                toast('Joining lobby…');
              }else{
                toast('Accepted invite');
              }
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
    const reqBtn = row.querySelector('[data-request]');
    if(reqBtn){ reqBtn.addEventListener('click', ()=> sendFriendRequest(username)); }
    const invBtn = row.querySelector('[data-invite]');
    if(invBtn){ invBtn.addEventListener('click', ()=> inviteToLobby(username)); }
    const lobbyBtn = row.querySelector('[data-lobby]');
    if(lobbyBtn){ lobbyBtn.addEventListener('click', ()=> inviteToLobby(username)); }
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
    none.className='meta'; none.style.opacity='0.8';
    none.style.marginBottom='8px';
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
      // finalPath can be an absolute path ("/izza-game/api/mp/ws"); build full URL
      const url = finalPath.startsWith('ws') ? finalPath : (proto + '//' + location.host + finalPath);
      ws = new WebSocket(url);
    }catch(e){ console.warn('WS failed to construct', e); return; }

    ws.addEventListener('open', ()=>{ wsReady=true; });
    ws.addEventListener('close', ()=>{
      wsReady=false; ws=null;
      if(reconnectT) clearTimeout(reconnectT);
      // Reconnect politely; if server doesn’t have WS, this won’t keep the UI from working.
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

  async function maybeConnectWS(){
    // Try quickly; if it throws, we just proceed with REST-only.
    try{ connectWS(me?.ws_url); }catch(e){ /* ignore */ }
  }

  // -------- HOTKEY GUARD (typing) --------
  function hotkeyGuard(e){
    const t=e.target;
    const insideLobby = !!(t && t.closest && t.closest('#mpLobby'));
    const isEditor = insideLobby && (t.tagName==='INPUT' || t.tagName==='TEXTAREA' || t.isContentEditable);
    if(!isEditor) return;
    const k=(e.key||'').toLowerCase();
    if(k==='i' || k==='b' || k==='a'){
      e.stopImmediatePropagation();
      e.stopPropagation();
    }
  }

  // -------- LOBBY WIRING --------
  function mountLobby(host){
    if(mounted) return; // guard to prevent duplicate wire-up causing freezes
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
      await loadMe();               // may flip CFG.prefix if backend uses /mp/*
      await loadFriends();
      refreshRanks();

      // Try WS—but never block. If server advertised ws_url, connectWS will use it.
      await maybeConnectWS();

      bootObserver();
      window.addEventListener('keydown', hotkeyGuard, {capture:true, passive:false});

      // Poll notifications regularly so invites show up without reload
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

  if(document.readyState==='complete' || document.readyState==='interactive'){
    start();
  }else{
    addEventListener('DOMContentLoaded', start, {once:true});
  }
})();
