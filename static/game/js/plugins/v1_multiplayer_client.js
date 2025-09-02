/**
 * IZZA Multiplayer Client — v1.3
 * - Server-backed friends & search (Pi session) is kept
 * - Adds peer-to-peer matchmaking over WS: queue.enter → deterministic pair → match.start
 * - Adds WS invites: invite.send → invite.accept → match.start
 * - Strong hotkey guard (I/B/A) while typing in the lobby
 *
 * Works even if your backend only relays WS messages to all connected clients at /api/mp/ws.
 * If you already have a full matcher, this client-side one is only a fallback—server wins.
 */
(function(){
  const BUILD='v1.3-mp-client+p2p-matcher+ws-invites';
  console.log('[IZZA PLAY]', BUILD);

  const CFG = {
    base: '/api/mp',          // REST base (friends/search/ranks)
    ws:   '/api/mp/ws',       // WebSocket path (must broadcast to all clients)
    searchDebounceMs: 250,
    queueStaleMs: 6000        // consider queue entries stale after 6s of silence
  };

  // ---------- STATE ----------
  let ws=null, wsReady=false, reconnectT=null;
  let me=null;                // { username, ranks }
  let friends=[];             // [{username,active}]
  let lobby=null, ui={};      // DOM refs
  let lastQueueMode=null;

  // In-memory queues (by mode); entries = {user, ts}
  const liveQueues = { br10:new Map(), v1:new Map(), v2:new Map(), v3:new Map() };

  // ---------- UTIL ----------
  const $  = (sel,root=document)=> root.querySelector(sel);
  const $$ = (sel,root=document)=> Array.from(root.querySelectorAll(sel));
  const toast = (t)=> (window.IZZA && IZZA.emit) ? IZZA.emit('toast',{text:t}) : console.log('[TOAST]',t);
  const now = ()=> Date.now();

  async function jget(path){
    const r = await fetch(CFG.base+path, {credentials:'include'});
    if(!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.json();
  }
  function debounced(fn, ms){
    let t=null, a=null; return (...args)=>{ a=args; clearTimeout(t); t=setTimeout(()=>fn(...a),ms); };
  }
  function uuid(){ return Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2); }

  // ---------- DATA ----------
  async function loadMe(){ me = await jget('/me'); return me; }
  async function loadFriends(){ const r = await jget('/friends/list'); friends = r.friends||[]; return friends; }
  async function searchFriends(q){ const r = await jget('/friends/search?q='+encodeURIComponent(q||'')); return r.users||[]; }

  // ---------- RANKS ----------
  async function refreshRanks(){
    try{
      const r = await jget('/ranks'); if(r && r.ranks) me.ranks = r.ranks; paintRanks();
    }catch{}
  }
  function paintRanks(){
    if(!lobby || !me || !me.ranks) return;
    const set=(id,key)=>{ const el=$(id,lobby); if(!el) return; const rk=me.ranks[key]||{w:0,l:0}; const s=$('span',el); if(s) s.textContent=`${rk.w}W / ${rk.l}L`; };
    set('#r-br10','br10'); set('#r-v1','v1'); set('#r-v2','v2'); set('#r-v3','v3');
  }

  // ---------- FRIENDS UI ----------
  function paintFriends(list){
    if(!lobby) return;
    const host=$('#mpFriends',lobby); if(!host) return;
    host.innerHTML='';
    list.forEach(fr=>{
      const row=document.createElement('div');
      row.className='friend';
      row.innerHTML = `
        <div>
          <div>${fr.username}</div>
          <div class="meta ${fr.active?'active':'offline'}">${fr.active?'Active':'Offline'}</div>
        </div>
        <div style="display:flex; gap:8px">
          <button class="mp-small" data-invite="${fr.username}">Invite</button>
          ${fr.active?`<button class="mp-small outline" data-join="${fr.username}">Invite to Lobby</button>`:''}
        </div>`;
      $('button[data-invite]',row).addEventListener('click', ()=> sendWS({type:'invite.send', to:fr.username}));
      const joinBtn=$('button[data-join]',row);
      if(joinBtn) joinBtn.addEventListener('click', ()=> sendWS({type:'invite.send', to:fr.username, lobby:true}));
      host.appendChild(row);
    });
  }

  // ---------- QUEUE (client-side P2P fallback) ----------
  function pruneQueue(mode){
    const m = liveQueues[mode]; const cutoff = now()-CFG.queueStaleMs;
    for(const [user,entry] of m){ if(entry.ts<cutoff) m.delete(user); }
  }
  function enqueue(mode){
    lastQueueMode = mode;
    const nice = modeNice(mode);
    if(ui.queueMsg) ui.queueMsg.textContent = `Queued for ${nice}… (waiting for match)`;
    // broadcast our presence every 2s while queued
    sendWS({type:'queue.enter', mode});
    // also send immediately again after 500ms to speed handshakes
    setTimeout(()=> sendWS({type:'queue.enter', mode}), 500);
  }
  function dequeue(){
    if(!lastQueueMode) return;
    sendWS({type:'queue.leave', mode:lastQueueMode});
    if(ui.queueMsg) ui.queueMsg.textContent = '';
    lastQueueMode=null;
  }
  function tryPair(mode){
    pruneQueue(mode);
    const m = liveQueues[mode];
    const users = Array.from(m.keys()).sort(); // deterministic order
    if(users.length<2) return;
    const meU = me.username;
    if(!m.has(meU)) return;

    // choose the first two alphabetically to reduce race
    const a = users[0], b = users[1];
    if(a!==meU && b!==meU) return; // not our turn to pair

    // winner of tie-break (lexicographically smallest) proposes the match
    const captain = a;
    if(meU !== captain) return;

    const matchId = 'm_'+uuid();
    sendWS({ type:'match.propose', mode, matchId, players:[a,b] });
  }
  function startMatch(mode, matchId, players){
    if(ui.queueMsg) ui.queueMsg.textContent='';
    // Hide lobby and notify game to start the duel/battle
    const host=document.getElementById('mpLobby'); if(host) host.style.display='none';
    window.IZZA?.emit?.('mp-start', { mode, matchId, players });
    toast('Match found! Starting…');
  }

  // ---------- WS ----------
  function sendWS(msg){
    if(!wsReady || !ws) return;
    try{
      const envelope = Object.assign({ from: me?.username || 'player', t: Date.now() }, msg);
      ws.send(JSON.stringify(envelope));
    }catch{}
  }
  function connectWS(){
    try{
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = proto + '//' + location.host + CFG.ws;
      ws = new WebSocket(url);
    }catch(e){ console.warn('WS failed', e); return; }

    ws.addEventListener('open', ()=>{ wsReady=true; sendWS({type:'hello', username: me?.username }); });
    ws.addEventListener('close', ()=>{
      wsReady=false; ws=null;
      if(reconnectT) clearTimeout(reconnectT);
      reconnectT=setTimeout(connectWS, 1200);
    });
    ws.addEventListener('message', (evt)=>{
      let msg=null; try{ msg=JSON.parse(evt.data); }catch{}
      if(!msg || msg.from===me?.username) return; // ignore our own echoes

      // Presence → update friends activity
      if(msg.type==='presence'){ updatePresence(msg.user||msg.from, !!msg.active); return; }

      // Queue events (P2P fallback)
      if(msg.type==='queue.enter' && msg.mode){
        liveQueues[msg.mode].set(msg.from, {ts:now()});
        // if we are also queued in this mode, attempt to pair
        if(lastQueueMode===msg.mode) tryPair(msg.mode);
        return;
      }
      if(msg.type==='queue.leave' && msg.mode){
        liveQueues[msg.mode].delete(msg.from);
        return;
      }

      // Match proposals
      if(msg.type==='match.propose' && msg.players && msg.players.includes(me?.username)){
        // Accept and announce start
        sendWS({ type:'match.accept', matchId: msg.matchId, mode: msg.mode, players: msg.players });
        startMatch(msg.mode, msg.matchId, msg.players);
        return;
      }
      if(msg.type==='match.accept' && msg.players && msg.players.includes(me?.username)){
        // The peer accepted — ensure we started too (idempotent)
        startMatch(msg.mode, msg.matchId, msg.players);
        return;
      }

      // Invites
      if(msg.type==='invite.send' && msg.to===me?.username){
        // lightweight accept UI
        const who = msg.from;
        const lobbyEl = document.getElementById('mpLobby');
        if(lobbyEl) lobbyEl.style.display='flex';
        const m = $('#mpQueueMsg', lobbyEl);
        if(m) m.textContent = `${who} invited you ${msg.lobby?'to lobby':'to play'} — press “Accept” to start 1v1`;
        // Show an inline Accept button
        showInlineAccept(msg);
        return;
      }
      if(msg.type==='invite.accept' && msg.to===me?.username){
        // Start a 1v1 immediately
        const mode='v1', matchId='i_'+uuid(), players=[msg.from, msg.to];
        startMatch(mode, matchId, players);
        return;
      }
    });
  }
  function showInlineAccept(inv){
    const card = $('#mpCard'); if(!card) return;
    let bar = document.getElementById('mpInlineInvite');
    if(!bar){
      bar = document.createElement('div');
      bar.id='mpInlineInvite';
      bar.style.cssText='margin-top:10px;display:flex;gap:8px;align-items:center';
      bar.innerHTML = `<button id="mpAcceptBtn" class="mp-small">Accept</button>
                       <button id="mpDeclineBtn" class="mp-small">Decline</button>`;
      card.appendChild(bar);
      $('#mpDeclineBtn', bar).onclick = ()=> bar.remove();
      $('#mpAcceptBtn', bar).onclick  = ()=>{
        sendWS({type:'invite.accept', to: inv.from, from: me?.username});
        // Also start locally in case peer is slow
        const mode='v1', matchId='i_'+uuid(), players=[inv.from, me?.username];
        startMatch(mode, matchId, players);
      };
    }
  }

  // ---------- UI wiring ----------
  function modeNice(mode){ return mode==='br10'?'Battle Royale (10)': mode==='v1'?'1v1': mode==='v2'?'2v2':'3v3'; }

  function mountLobby(host){
    lobby = host || document.getElementById('mpLobby'); if(!lobby) return;

    ui.queueMsg = $('#mpQueueMsg', lobby);

    // Queue buttons
    $$('.mp-btn', lobby).forEach(btn=>{
      btn.onclick = ()=>{
        const mode = btn.getAttribute('data-mode');
        enqueue(mode);
        // also schedule a quick pairing attempt
        setTimeout(()=> tryPair(mode), 500);
      };
    });

    // Close button: dequeue if queued
    $('#mpClose', lobby)?.addEventListener('click', ()=> dequeue());

    // Copy invite link (server-provided if available)
    $('#mpCopyLink', lobby)?.addEventListener('click', async ()=>{
      try{
        const meRes = await jget('/me');
        const link = (meRes && meRes.inviteLink) || (location.origin + '/auth.html?src=invite&from=' + encodeURIComponent(meRes.username||'player'));
        await navigator.clipboard.writeText(link);
        toast('Invite link copied');
      }catch(e){
        const link = location.origin + '/auth.html';
        prompt('Copy this invite link:', link);
      }
    });

    // Search friends (only Pi-authed + played users are returned by backend)
    const search = $('#mpSearch', lobby);
    if(search){
      const run = debounced(async ()=>{
        const q = search.value.trim();
        if(!q){ paintFriends(friends); return; }
        try{
          const list = await searchFriends(q);
          paintFriends(list.map(u=>({username:u.username, active:!!u.active})));
        }catch{}
      }, CFG.searchDebounceMs);
      search.oninput = run;
      // mark focus (optional global flag, if other plugins care)
      search.addEventListener('focus', ()=>{ window.__IZZA_TYPING_IN_LOBBY = true; });
      search.addEventListener('blur',  ()=>{ window.__IZZA_TYPING_IN_LOBBY = false; });
    }

    paintRanks();
    paintFriends(friends);
  }

  // ---------- Presence & hotkey guard ----------
  function updatePresence(user, active){
    const f = friends.find(x=>x.username===user);
    if(f) f.active = !!active;
    if(lobby && lobby.style.display!=='none'){
      const q = $('#mpSearch', lobby)?.value || '';
      const filtered = q ? friends.filter(x=>x.username.toLowerCase().includes(q.toLowerCase())) : friends;
      paintFriends(filtered);
    }
  }

  // Strong guard: stop I/B/A from reaching game while typing in lobby inputs
  function isLobbyEditor(el){
    if(!el) return false; const inLobby = !!(el.closest && el.closest('#mpLobby')); if(!inLobby) return false;
    return el.tagName==='INPUT' || el.tagName==='TEXTAREA' || el.isContentEditable;
  }
  function guardKeyEvent(e){
    if(!isLobbyEditor(e.target)) return;
    const k=(e.key||'').toLowerCase();
    if(k==='i'||k==='b'||k==='a'){ e.stopImmediatePropagation(); e.stopPropagation(); }
  }
  window.addEventListener('keydown',  guardKeyEvent, {capture:true, passive:false});
  window.addEventListener('keypress', guardKeyEvent, {capture:true, passive:false});
  window.addEventListener('keyup',    guardKeyEvent, {capture:true, passive:false});

  // Observe when #mpLobby is shown to (re)mount wiring
  const obs = new MutationObserver(()=>{
    const h=document.getElementById('mpLobby'); if(!h) return;
    const visible = h.style.display && h.style.display!=='none';
    if(visible) mountLobby(h);
  });
  function bootObserver(){
    const root=document.body||document.documentElement;
    if(root) obs.observe(root, {subtree:true, attributes:true, childList:true, attributeFilter:['style']});
  }

  // ---------- BOOT ----------
  async function start(){
    try{
      await loadMe();
      await loadFriends();
      refreshRanks();
      connectWS();
      bootObserver();
      const h=document.getElementById('mpLobby'); if(h && h.style.display && h.style.display!=='none') mountLobby(h);
      console.log('[MP] client ready', {user:me?.username, friends:friends.length});
    }catch(e){
      console.error('MP client start failed', e);
      toast('Multiplayer unavailable: '+e.message);
    }
  }
  if(document.readyState==='complete' || document.readyState==='interactive') start();
  else addEventListener('DOMContentLoaded', start, {once:true});
})();
