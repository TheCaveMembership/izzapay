/**
 * IZZA Multiplayer Client — v1.5.1 (stronger typing guard)
 * - Friends: request / accept
 * - Lobby invites + notifications (poll)
 * - Safe WS boot (non-blocking)
 * - **Typing guard:** stops I/A/B while editing inside the lobby
 * - Path auto-fallback: supports /izza-game/api/mp and /izza-game/api/mp/mp
 */
(function(){
  const BUILD='v1.5.1-mp-client+typing-guard';
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
  let me=null, friends=[], lobby=null, ui={}, notifHost=null, mounted=false, notifTimer=null;

  // -------- UTIL --------
  const $  = (sel,root=document)=> root.querySelector(sel);
  const $$ = (sel,root=document)=> Array.from(root.querySelectorAll(sel));
  const toast = (t)=> (window.IZZA && IZZA.emit) ? IZZA.emit('toast',{text:t}) : console.log('[TOAST]',t);

  async function _fetchJSON(url, init){
    const r = await fetch(url, init);
    return { ok: r.ok, status: r.status, json: r.ok ? await r.json() : null };
  }
  const _mkUrl = p => CFG.base + CFG.prefix + p;
  const _mkAlt = p => CFG.base + CFG.altPrefix + p;

  async function jget(path){
    let res = await _fetchJSON(_mkUrl(path), {credentials:'include'});
    if(res.ok) return res.json;
    if(res.status===404 && CFG.prefix!==CFG.altPrefix){
      const res2 = await _fetchJSON(_mkAlt(path), {credentials:'include'});
      if(res2.ok){ CFG.prefix=CFG.altPrefix; return res2.json; }
    }
    throw new Error(`${res.status||'???'} GET ${path}`);
  }
  async function jpost(path, body){
    let res = await _fetchJSON(_mkUrl(path), {
      method:'POST', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify(body||{})
    });
    if(res.ok) return res.json;
    if(res.status===404 && CFG.prefix!==CFG.altPrefix){
      const res2 = await _fetchJSON(_mkAlt(path), {
        method:'POST', credentials:'include',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify(body||{})
      });
      if(res2.ok){ CFG.prefix=CFG.altPrefix; return res2.json; }
    }
    throw new Error(`${res.status||'???'} POST ${path}`);
  }
  const debounced=(fn,ms)=>{ let t=null,a=null; return (...x)=>{a=x;clearTimeout(t);t=setTimeout(()=>fn.apply(null,a),ms);} };

  // -------- DATA --------
  async function loadMe(){ me = await jget('/me'); return me; }
  async function loadFriends(){
    const res = await jget('/friends/list');
    friends = (res.friends||[]).map(f=>({username:f.username, active:!!f.active, friend:true}));
    return friends;
  }
  async function searchFriendsServer(q){
    const res = await jget('/friends/search?q='+encodeURIComponent(q||'')); return res.users||[];
  }
  async function refreshRanks(){
    try{ const res = await jget('/ranks'); if(res && res.ranks){ (me||(me={})).ranks=res.ranks; paintRanks(); } }catch{}
  }

  // -------- FRIENDS / LOBBY --------
  async function sendFriendRequest(username){
    try{ await jpost('/friends/request',{username}); toast('Friend request sent to '+username); }
    catch(e){ toast('Could not send request: '+e.message); }
  }
  async function acceptFriend(username){
    try{ await jpost('/friends/accept',{username}); toast('You are now friends with '+username); await loadFriends(); repaintFriendsArea(); }
    catch(e){ toast('Could not accept: '+e.message); }
  }
  async function inviteToLobby(username){
    try{
      const res = await jpost('/lobby/invite', { toUsername: username });
      if(res && res.ok){ toast('Lobby invite sent to '+username); return; }
      const reason=(res&&(res.reason||res.error))||'unavailable';
      let msg='Your friend cannot join right now.';
      if(reason==='in_game') msg='Your friend is currently in a game.';
      if(reason==='offline') msg='Your friend is offline.';
      if(reason==='ended') msg='Your friend ended their session.';
      if(reason==='not_friends') msg='You must be friends before inviting.';
      showConfirm(`${msg}\n\nSend them a notification to join your lobby now?`, async()=>{
        try{ await jpost('/lobby/notify',{toUsername:username, ttlSec:CFG.notifTTLsec}); toast('Notification queued for '+username); }
        catch(e){ toast('Could not queue notification: '+e.message); }
      });
    }catch(e){ toast('Invite failed: '+e.message); }
  }

  // -------- NOTIFICATIONS --------
  function ensureNotifHost(){
    if(notifHost) return notifHost;
    notifHost=document.createElement('div');
    Object.assign(notifHost.style,{position:'fixed',right:'12px',top:'12px',zIndex:1001,display:'flex',flexDirection:'column',gap:'8px'});
    document.body.appendChild(notifHost); return notifHost;
  }
  function showBanner(html,onAccept,onDismiss){
    const host=ensureNotifHost();
    const card=document.createElement('div');
    card.style.cssText='background:#0f1625;border:1px solid #2a3550;border-radius:12px;color:#cfe0ff;padding:10px 12px;min-width:260px;max-width:80vw;box-shadow:0 4px 16px rgba(0,0,0,.35)';
    card.innerHTML=`<div style="font-weight:700;margin-bottom:6px">Notification</div>
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
  const showConfirm=(text,onYes)=> showBanner(text.replace(/\n/g,'<br>'), onYes, ()=>{});
  async function pullNotifications(){
    try{
      const res = await jget('/notifications');
      (res.requests||[]).forEach(r=> showBanner(`Friend request from <b>${r.from}</b>`, ()=>acceptFriend(r.from)));
      (res.invites||[]).forEach(inv=> showBanner(
        `<b>${inv.from}</b> invited you to their lobby${inv.mode?` (${prettyMode(inv.mode)})`:''}. Join?`,
        async()=>{ try{ await jpost('/lobby/accept',{from:inv.from}); toast('Joining lobby…'); }catch(e){ toast('Could not join: '+e.message);} }
      ));
    }catch{}
  }

  // -------- RENDER HELPERS --------
  const prettyMode = m => m==='br10'?'Battle Royale (10)': m==='v1'?'1v1': m==='v2'?'2v2':'3v3';
  function paintRanks(){
    if(!lobby || !me || !me.ranks) return;
    const set=(id,key)=>{ const el=$(id,lobby); if(!el) return; const r=me.ranks[key]||{w:0,l:0}; const s=$('span',el); if(s) s.textContent=`${r.w}W / ${r.l}L`; };
    set('#r-br10','br10'); set('#r-v1','v1'); set('#r-v2','v2'); set('#r-v3','v3');
  }
  function makeRow(username,active,friend){
    const row=document.createElement('div');
    row.className='friend';
    row.innerHTML=`<div><div>${username}</div><div class="meta ${active?'active':'offline'}">${active?'Active':'Offline'}</div></div>
      <div style="display:flex; gap:8px">
        ${friend?`<button class="mp-small" data-invite="${username}">Invite to Lobby</button>`:`<button class="mp-small" data-request="${username}">Add Friend</button>`}
        ${active?`<button class="mp-small outline" data-lobby="${username}">Invite Now</button>`:''}
      </div>`;
    row.querySelector('[data-request]')?.addEventListener('click', ()=> sendFriendRequest(username));
    const doInvite=()=> inviteToLobby(username);
    row.querySelector('[data-invite]')?.addEventListener('click', doInvite);
    row.querySelector('[data-lobby]')?.addEventListener('click', doInvite);
    return row;
  }
  function paintFriends(list){
    if(!lobby) return; const host=$('#mpFriends',lobby); if(!host) return;
    host.innerHTML=''; if(!list.length){ const e=document.createElement('div'); e.className='meta'; e.style.opacity='.8'; e.textContent='No friends yet. Search a Pi username above or share your invite link.'; host.appendChild(e); return; }
    list.forEach(fr=> host.appendChild(makeRow(fr.username,!!fr.active,!!fr.friend)));
  }
  function paintSearchResults(q,results,usedFallback=false){
    const host=$('#mpFriends',lobby); if(!host) return; host.innerHTML='';
    if(results.length){ results.forEach(u=> host.appendChild(makeRow(u.username,!!u.active,!!u.friend)));
      if(usedFallback){ const note=document.createElement('div'); note.className='meta'; note.style.opacity='.8'; note.textContent='(Showing local/fallback results.)'; host.appendChild(note); }
      return;
    }
    const none=document.createElement('div'); none.className='meta'; none.style.opacity='.8'; none.style.marginBottom='8px'; none.textContent='No results.'; host.appendChild(none);
    if(q && q.length>=CFG.minChars){
      const row=document.createElement('div'); row.className='friend';
      row.innerHTML=`<div><div>${q}</div><div class="meta">Not found — send a friend request?</div></div>
        <button class="mp-small" data-request="${q}">Add Friend</button>`;
      row.querySelector('button').addEventListener('click', ()=> sendFriendRequest(q)); host.appendChild(row);
    }
  }
  function repaintFriendsArea(){
    const search=$('#mpSearch',lobby);
    if(search && search.value.trim().length>=CFG.minChars){ search.dispatchEvent(new Event('input')); }
    else{ paintFriends(friends); }
  }

  // -------- PRESENCE / QUEUE --------
  const updatePresence=(user,active)=>{ const f=friends.find(x=>x.username===user); if(f){ f.active=!!active; repaintFriendsArea(); } };
  async function enqueue(mode){
    try{ lastQueueMode=mode; if(ui.queueMsg) ui.queueMsg.textContent=`Queued for ${prettyMode(mode)}… (waiting for match)`; await jpost('/queue',{mode}); }
    catch(e){ if(ui.queueMsg) ui.queueMsg.textContent=''; toast('Queue error: '+e.message); }
  }
  async function dequeue(){ try{ await jpost('/dequeue'); }catch{} if(ui.queueMsg) ui.queueMsg.textContent=''; lastQueueMode=null; }

  // -------- SOCKET --------
  function connectWS(urlOverride){
    const finalPath=urlOverride || me?.ws_url || CFG.ws;
    try{
      const proto = location.protocol==='https:' ? 'wss:' : 'ws:';
      const url = finalPath.startsWith('ws') ? finalPath : (proto+'//'+location.host+finalPath);
      ws = new WebSocket(url);
    }catch(e){ console.warn('WS failed to construct', e); return; }
    ws.addEventListener('open', ()=>{ wsReady=true; });
    ws.addEventListener('close', ()=>{
      wsReady=false; ws=null; if(reconnectT) clearTimeout(reconnectT);
      reconnectT=setTimeout(()=>connectWS(urlOverride), 2500);
    });
    ws.addEventListener('message', (evt)=>{
      let msg=null; try{ msg=JSON.parse(evt.data); }catch{}
      if(!msg) return;
      if(msg.type==='presence'){ updatePresence(msg.user, !!msg.active); }
      else if(msg.type==='notify.request'){ showBanner(`Friend request from <b>${msg.from}</b>`, ()=> acceptFriend(msg.from)); }
      else if(msg.type==='notify.invite'){
        showBanner(`<b>${msg.from}</b> invited you to their lobby${msg.mode?` (${prettyMode(msg.mode)})`:''}. Join?`,
          async()=>{ try{ await jpost('/lobby/accept',{from:msg.from}); toast('Joining lobby…'); }catch(e){ toast('Could not join: '+e.message); }});
      }else if(msg.type==='queue.update' && ui.queueMsg){
        const eta = msg.estMs!=null ? ` ~${Math.ceil(msg.estMs/1000)}s` : '';
        ui.queueMsg.textContent = `Queued for ${prettyMode(msg.mode)}… (${msg.pos||1} in line${eta})`;
      }else if(msg.type==='match.found'){
        if(ui.queueMsg) ui.queueMsg.textContent=''; if(lobby) lobby.style.display='none';
        window.IZZA?.emit?.('mp-start',{mode:msg.mode, matchId:msg.matchId, players:msg.players});
        toast('Match found! Starting…');
      }else if(msg.type==='match.result'){
        if(msg.newRanks){ (me||(me={})).ranks=msg.newRanks; paintRanks(); }
      }
    });
  }
  const maybeConnectWS=()=>{ try{ connectWS(me?.ws_url); }catch{} };

  // -------- STRONG TYPING GUARD --------
  function isTypingTarget(t){
    if(!t) return false;
    if(t.tagName==='INPUT' || t.tagName==='TEXTAREA' || t.isContentEditable) return true;
    // also treat anything inside the lobby input region as typing
    return !!t.closest?.('#mpLobby');
  }
  function stopAll(e){
    e.preventDefault?.(); e.stopPropagation?.(); e.stopImmediatePropagation?.();
    return false;
  }
  function hotkeyGuard(e){
    const t=e.target;
    if(!isTypingTarget(t)) return;
    const k=(e.key||'').toLowerCase();
    // Block the game’s global handlers while typing in the lobby
    if(k==='i' || k==='a' || k==='b') return stopAll(e);
  }

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
        const link = (res && res.inviteLink) || (location.origin + '/izza-game/auth?src=invite&from=' + encodeURIComponent(res?.username||'player'));
        await navigator.clipboard.writeText(link); toast('Invite link copied');
      }catch(e){
        const fallback = location.origin + '/izza-game/auth';
        toast('Copy failed; showing link…'); prompt('Copy this invite link:', fallback);
      }
    });

    const search = $('#mpSearch', lobby);
    if(search){
      // focus search when lobby opens so typing goes there
      setTimeout(()=> search.focus(), 0);
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
      maybeConnectWS();
      bootObserver();

      // Attach **strong** guards for all keyboard phases while typing
      ['keydown','keypress','keyup'].forEach(evt=>{
        window.addEventListener(evt, hotkeyGuard, {capture:true, passive:false});
      });

      pullNotifications(); if(!notifTimer) notifTimer=setInterval(pullNotifications, CFG.notifPollMs);

      const h=document.getElementById('mpLobby');
      if(h && h.style.display && h.style.display!=='none') mountLobby(h);

      console.log('[MP] client ready', {user:me?.username, friends:friends.length, ws:!!ws});
    }catch(e){
      console.error('MP client start failed', e);
      toast('Multiplayer unavailable: '+e.message);
    }
  }

  if(document.readyState==='complete' || document.readyState==='interactive'){ start(); }
  else{ addEventListener('DOMContentLoaded', start, {once:true}); }
})();
