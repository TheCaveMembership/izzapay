/**
 * IZZA Multiplayer Client — v1.7.2
 * - Best-of-3 round coordinator (first to 2)
 * - Single authoritative winner (no “both lose”)
 * - FIX: round lifecycle state machine + watchdog to avoid freezes
 * - FIX: hard reset between matches; no double wiring; idempotent handlers
 */
(function(){
  const BUILD='v1.7.2-mp-client+bo3+state+watchdog';
  console.log('[IZZA PLAY]', BUILD);

  const CFG = {
    base: (window.__MP_BASE__ || '/izza-game/api/mp'),
    ws:   (window.__MP_WS__   || '/izza-game/api/mp/ws'),
    searchDebounceMs: 250,
  };
  const MATCH_CFG = {
    roundsToWin: 2,          // best of 3
    roundWatchdogMs: 8000,   // if a round is "in play" too long without an end event, nudge
    betweenWatchdogMs: 5000, // if we reported a round end but no start of next, nudge
  };

  // --- helpers / fetch ---
  const TOK = (window.__IZZA_T__ || '').toString();
  const withTok = (p) => TOK ? p + (p.includes('?') ? '&' : '?') + 't=' + encodeURIComponent(TOK) : p;

  async function jget(p){
    const r = await fetch(withTok(CFG.base+p), {credentials:'include'});
    if(!r.ok){
      if(r.status===401) toast('Sign-in expired. Reopen Auth and try again.');
      throw new Error(`${r.status} ${r.statusText}`);
    }
    return r.json();
  }
  async function jpost(p,b){
    const r = await fetch(withTok(CFG.base+p),{
      method:'POST', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(b||{})
    });
    if(!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.json();
  }
  const debounced=(fn,ms)=>{ let t=null,a=null; return (...args)=>{a=args; clearTimeout(t); t=setTimeout(()=>fn(...a),ms);}};

  let ws=null, wsReady=false, reconnectT=null, lastQueueMode=null;
  let me=null, friends=[], lobby=null, ui={};
  let notifTimer=null;

  let lobbyOpen=false, shield=null, hudEls=[], hudCssPrev=[];
  const $  = (s,r=document)=> r.querySelector(s);
  const toast = (t)=> (window.IZZA&&IZZA.emit)?IZZA.emit('toast',{text:t}):console.log('[TOAST]',t);

  async function loadMe(){ me = await jget('/me'); return me; }
  async function loadFriends(){ const res=await jget('/friends/list'); friends=res.friends||[]; return friends; }
  async function searchPlayers(q){ const res=await jget('/players/search?q='+encodeURIComponent(q||'')); return res.users||[]; }

  async function refreshRanks(){ try{ const r=await jget('/ranks'); if(r&&r.ranks) me.ranks=r.ranks; paintRanks(); }catch{} }
  function paintRanks(){
    if(!lobby || !me || !me.ranks) return;
    const set=(id,key)=>{ const el=$(id,lobby); if(!el) return; const r=me.ranks[key]||{w:0,l:0}; const sp=el.querySelector('span'); if(sp) sp.textContent=`${r.w}W / ${r.l}L`; };
    set('#r-br10','br10'); set('#r-v1','v1'); set('#r-v2','v2'); set('#r-v3','v3');
  }

  function makeRow(u){
    const row=document.createElement('div');
    row.className='friend';
    row.innerHTML=`
      <div>
        <div>${u.username}</div>
        <div class="meta ${u.active?'active':'offline'}">${u.active?'Active':'Offline'}</div>
      </div>
      <div style="display:flex; gap:8px">
        <button class="mp-small" data-invite="${u.username}">Invite</button>
        ${u.active?`<button class="mp-small outline" data-join="${u.username}">Invite to Lobby</button>`:''}
      </div>`;
    row.querySelector('button[data-invite]')?.addEventListener('click', async ()=>{
      try{ await jpost('/lobby/invite',{toUsername:u.username}); toast('Invite sent to '+u.username); }catch(e){ toast('Invite failed: '+e.message); }
    });
    row.querySelector('button[data-join]')?.addEventListener('click', async ()=>{
      try{ await jpost('/lobby/invite',{toUsername:u.username}); toast('Lobby invite sent to '+u.username); }catch(e){ toast('Invite failed: '+e.message); }
    });
    return row;
  }
  function paintFriends(list){
    const host=$('#mpFriends',lobby); if(!host) return;
    host.innerHTML='';
    (list||[]).forEach(u=> host.appendChild(makeRow(u)));
  }
  function repaintFriends(){
    const q=$('#mpSearch',lobby)?.value?.trim().toLowerCase()||'';
    const filtered = q ? friends.filter(x=> (x.username||'').toLowerCase().includes(q)) : friends;
    paintFriends(filtered);
  }
  function updatePresence(user, active){ const f=friends.find(x=>x.username===user); if(f){ f.active=!!active; if(lobby && lobby.style.display!=='none') repaintFriends(); } }

  // ==== MATCH / ROUNDS — state machine + watchdogs ===========================
  // match states: 'idle' | 'in_round' | 'between' | 'finished'
  let match = null; // { id, mode, players[], myName, oppName, myWins, oppWins, state, fence, tWatch, lastChange }

  function clearWatch(){
    if(match && match.tWatch){ clearTimeout(match.tWatch); match.tWatch=null; }
  }

  function armWatch(ms, label){
    clearWatch();
    if(!match) return;
    match.tWatch = setTimeout(async()=>{
      if(!match || match.finished) return;
      try{
        if(match.state==='in_round'){
          // Nudge server: round looks stuck, ask status
          await jpost('/match/ping',{matchId:match.id, phase:'in_round', since:match.lastChange||0});
        }else if(match.state==='between'){
          // Ask to start the next round if it hasn't yet
          await jpost('/match/next',{matchId:match.id});
        }
      }catch{}
      // re-arm lightly to avoid spam
      armWatch(ms, label);
    }, ms);
  }

  function setState(s){
    if(!match) return;
    match.state = s;
    match.lastChange = Date.now();
    if(s==='in_round')      armWatch(MATCH_CFG.roundWatchdogMs,'in');
    else if(s==='between')  armWatch(MATCH_CFG.betweenWatchdogMs,'between');
    else                    clearWatch();
  }

  function hardResetMatch(){
    clearWatch();
    match = null;
  }

  function initMatch(payload){
    hardResetMatch();
    const players = payload?.players || [];
    const myName  = me?.username || 'me';
    const oppName = players.find(p=>p!==myName) || (players[0]||'opponent');
    match = {
      id: payload?.matchId || payload?.id || ('m_'+Math.random().toString(36).slice(2)),
      mode: payload?.mode || 'v1',
      players, myName, oppName,
      myWins:0, oppWins:0,
      roundsToWin: MATCH_CFG.roundsToWin,
      finished:false,
      fence: Object.create(null),
      state:'between',
      tWatch:null,
      lastChange:Date.now()
    };
    // Tell duel plugin how many wins we play to.
    IZZA?.emit?.('duel-config', { roundsToWin: MATCH_CFG.roundsToWin, matchId: match.id });
  }

  // Round started (from duel plugin or server)
  function onRoundStart(data){
    if(!match || match.finished) return;
    // Avoid regressing state if multiple signals arrive
    if(match.state !== 'in_round'){
      setState('in_round');
    }
  }

  // Round ended (from duel plugin or server)
  function onRoundEnd(data){
    if(!match || match.finished) return;
    // idempotency for round IDs
    const rid = (data && data.roundId) || ('r_'+Date.now());
    if(match.fence[rid]) return;
    match.fence[rid]=1;

    // Accept either winner name or winnerIsMe
    const iWon = data?.winnerIsMe===true || (data?.winner && data.winner===match.myName);
    if(iWon) match.myWins++; else match.oppWins++;

    IZZA.emit?.('toast', {text:`Round • ${match.myName}: ${match.myWins} — ${match.oppName}: ${match.oppWins}`});

    // Report (best-effort) & go to BETWEEN state
    (async()=>{ try{
      await jpost('/match/round',{matchId:match.id, roundId:rid, winner: iWon?match.myName:match.oppName, myWins:match.myWins, oppWins:match.oppWins});
    }catch{} })();

    if(match.myWins>=match.roundsToWin || match.oppWins>=match.roundsToWin){
      finishMatch(iWon?match.myName:match.oppName, 'local');
    }else{
      setState('between');
      // polite nudge to server to start next round (does nothing if server already will)
      (async()=>{ try{ await jpost('/match/next',{matchId:match.id}); }catch{} })();
    }
  }

  // Single finish path (now also bumps local W/L + refreshes from server)
  function finishMatch(winnerName, source){
    if(!match || match.finished) return;
    match.finished = true;
    setState('finished');

    const loserName = (winnerName===match.myName) ? match.oppName : match.myName;

    // Notify the rest of the app
    IZZA.emit?.('mp-finish', { matchId:match.id, winner:winnerName, loser:loserName, myWins:match.myWins, oppWins:match.oppWins });

    // Optimistically bump local ranks so the UI reflects the result immediately
    try{
      const modeKey = match.mode || 'v1';
      me = me || {};
      me.ranks = me.ranks || {};
      me.ranks[modeKey] = me.ranks[modeKey] || { w:0, l:0 };
      if (winnerName === (me.username || match.myName)) {
        me.ranks[modeKey].w++;
      } else {
        me.ranks[modeKey].l++;
      }
      paintRanks();
    }catch(e){}

    // Report to server (authoritative) then refresh ranks to sync
    (async()=>{
      try{ await jpost('/match/finish',{matchId:match.id, winner:winnerName}); }catch{}
      try{ await refreshRanks(); }catch{}
    })();

    const msg = (winnerName===match.myName) ? 'You won the match!' : `${winnerName} won the match`;
    toast(msg);
  }

  // Wire duel hooks exactly once
  (function wireDuelHooksOnce(){
    if(!window.IZZA) return;
    if(wireDuelHooksOnce._wired) return;
    wireDuelHooksOnce._wired = true;

    IZZA.on?.('ready', function(){
      // Start / end signals from duel plugin
      IZZA.on?.('duel-round-start', (_,_payload)=> onRoundStart(_payload||{}));
      IZZA.on?.('duel-round-end',   (_,_payload)=> onRoundEnd(_payload||{}));
      IZZA.on?.('duel-match-finish',(_,_payload)=>{ if(_payload && _payload.winner) finishMatch(_payload.winner, 'duel'); });

      // In case match was queued before IZZA ready
      if(window.__MP_START_PENDING){
        const p = window.__MP_START_PENDING; delete window.__MP_START_PENDING;
        startMatch(p);
      }
    });
  })();
  // ==========================================================================

  // ---- match start helper (robust) ----
  function startMatch(payload){
    try{
      ui.queueMsg && (ui.queueMsg.textContent='');
      lobby && (lobby.style.display='none');

      initMatch(payload);

      const startPayload = Object.assign({}, payload, { roundsToWin: MATCH_CFG.roundsToWin, matchId: match.id });
      if(window.IZZA && typeof IZZA.emit==='function'){
        IZZA.emit('mp-start', startPayload);
      }else{
        window.__MP_START_PENDING = startPayload;
      }
      toast('Match starting…');

      // We begin between rounds; duel plugin should emit the first duel-round-start soon.
      setState('between');
      // Nudge server just in case
      (async()=>{ try{ await jpost('/match/next',{matchId:match.id}); }catch{} })();
    }catch(e){
      console.warn('startMatch failed', e);
      window.__MP_START_PENDING = payload;
    }
  }

  async function enqueue(mode){
    try{
      lastQueueMode=mode;
      const nice= mode==='br10'?'Battle Royale (10)': mode==='v1'?'1v1': mode==='v2'?'2v2':'3v3';
      ui.queueMsg && (ui.queueMsg.textContent=`Queued for ${nice}… (waiting for match)`);
      const res = await jpost('/queue',{mode});
      if(res && res.start){ startMatch(res.start); }
    }catch(e){ ui.queueMsg && (ui.queueMsg.textContent=''); toast('Queue error: '+e.message); }
  }
  async function dequeue(){ try{ await jpost('/dequeue'); }catch{} ui.queueMsg && (ui.queueMsg.textContent=''); lastQueueMode=null; }

  // --- WS (now also listens for round/finish authority) ---
  function connectWS(){
    try{
      const proto = location.protocol==='https:'?'wss:':'ws:'; const url = proto+'//'+location.host+CFG.ws;
      ws=new WebSocket(url);
    }catch(e){ return; }
    ws.addEventListener('open', ()=>{ wsReady=true; });
    ws.addEventListener('close', ()=>{ wsReady=false; ws=null; if(reconnectT) clearTimeout(reconnectT); reconnectT=setTimeout(connectWS,1500); });
    ws.addEventListener('message',(evt)=>{
      let msg=null; try{ msg=JSON.parse(evt.data);}catch{}
      if(!msg) return;

      if(msg.type==='presence'){
        updatePresence(msg.user, !!msg.active);

      }else if(msg.type==='queue.update' && ui.queueMsg){
        const nice= msg.mode==='br10'?'Battle Royale (10)': msg.mode==='v1'?'1v1': msg.mode==='v2'?'2v2':'3v3';
        const eta= msg.estMs!=null?` ~${Math.ceil(msg.estMs/1000)}s`:''; ui.queueMsg.textContent=`Queued for ${nice}… (${msg.pos||1} in line${eta})`;

      }else if(msg.type==='match.found'){
        startMatch({mode:msg.mode,matchId:msg.matchId,players:msg.players});

      }else if(msg.type==='match.round.start'){
        onRoundStart(msg); // authoritative start

      }else if(msg.type==='match.round'){
        // authoritative round result
        if(!match || match.finished) return;
        if(msg.matchId && match.id !== msg.matchId) return;
        const w = msg.winner;
        onRoundEnd({ roundId: msg.roundId || ('ws_'+Date.now()), winner: w });

      }else if(msg.type==='match.finish'){
        if(msg.matchId && match && match.id!==msg.matchId) return;
        if(msg.winner) finishMatch(msg.winner, 'server');
      }
    });
  }

  // --- typing shield (unchanged) ---
  function isLobbyEditor(el){ if(!el) return false; const inLobby = !!(el.closest && el.closest('#mpLobby')); return inLobby && (el.tagName==='INPUT' || el.tagName==='TEXTAREA' || el.isContentEditable); }
  function guardKeyEvent(e){ if(!isLobbyEditor(e.target)) return; const k=(e.key||'').toLowerCase(); if(k==='i'||k==='b'||k==='a'){ e.stopImmediatePropagation(); e.stopPropagation(); } }
  ['keydown','keypress','keyup'].forEach(type=> window.addEventListener(type, guardKeyEvent, {capture:true, passive:false}));
  function keyIsABI(e){ const k=(e.key||'').toLowerCase(); return k==='a'||k==='b'||k==='i'; }
  function swallow(e){ e.stopImmediatePropagation(); e.stopPropagation(); e.preventDefault?.(); }

  function installShield(){
    if(lobbyOpen) return; lobbyOpen=true;
    hudEls=['#btnA','#btnB','#btnI'].map(id=>document.querySelector(id)).filter(Boolean);
    hudCssPrev = hudEls.map(el=>el.getAttribute('style')||'');
    hudEls.forEach(el=>{
      el.style.pointerEvents='none'; el.style.opacity='0';
      const swallowClick = (e)=> lobbyOpen && swallow(e);
      el.addEventListener('click', swallowClick, true);
      el.addEventListener('touchstart', swallowClick, true);
      el.addEventListener('pointerdown', swallowClick, true);
      el.__mp_swallow = swallowClick;
    });
    installShield._key = (ev)=>{ if(lobbyOpen && keyIsABI(ev)) swallow(ev); };
    ['keydown','keypress','keyup'].forEach(t=> window.addEventListener(t, installShield._key, {capture:true}));
    shield=document.createElement('div');
    Object.assign(shield.style,{position:'fixed', inset:'0', zIndex:1002, background:'transparent', touchAction:'none'});
    document.body.appendChild(shield);
    setTimeout(function(){
      const node=document.getElementById('mpLobby');
      const visible = !!(node && node.style.display && node.style.display!=='none');
      if(!visible) removeShield();
    }, 350);
  }
  function removeShield(){
    if(!lobbyOpen) return; lobbyOpen=false;
    if(installShield._key){ ['keydown','keypress','keyup'].forEach(t=> window.removeEventListener(t, installShield._key, {capture:true})); installShield._key=null; }
    hudEls.forEach((el,i)=>{
      if(!el) return;
      el.setAttribute('style', hudCssPrev[i]||'');
      if(el.__mp_swallow){
        el.removeEventListener('click', el.__mp_swallow, true);
        el.removeEventListener('touchstart', el.__mp_swallow, true);
        el.removeEventListener('pointerdown', el.__mp_swallow, true);
        delete el.__mp_swallow;
      }
    });
    hudEls=[]; hudCssPrev=[];
    if(shield && shield.parentNode) shield.parentNode.removeChild(shield);
    shield=null;
  }
  function tryShieldOnce(){
    const node=document.getElementById('mpLobby');
    const visible = !!(node && node.style.display && node.style.display!=='none');
    if(visible) installShield();
  }
  if(window.IZZA && IZZA.on){
    IZZA.on('ui-modal-open',  function(e){
      if(e && e.id==='mpLobby'){
        tryShieldOnce();
        requestAnimationFrame(tryShieldOnce);
        setTimeout(tryShieldOnce, 80);
        setTimeout(()=> { $('#mpSearch')?.focus(); }, 120);
      }
    });
    IZZA.on('ui-modal-close', function(e){ if(e && e.id==='mpLobby') removeShield(); });

    // If a match payload was stashed before IZZA was ready, start it now (safety, though we also wire inside hooks).
    IZZA.on('ready', function(){
      if(window.__MP_START_PENDING){
        const p = window.__MP_START_PENDING; delete window.__MP_START_PENDING;
        startMatch(p);
      }
    });
  }

  // ---------- SEARCH state ----------
  let searchRunId = 0;

  function mountLobby(host){
    lobby = host || document.getElementById('mpLobby');
    if(!lobby) return;
    if(lobby.dataset.mpMounted === '1') return;
    lobby.dataset.mpMounted = '1';

    ui.queueMsg     = lobby.querySelector('#mpQueueMsg');
    ui.search       = lobby.querySelector('#mpSearch');
    ui.searchBtn    = lobby.querySelector('#mpSearchBtn');
    ui.searchStatus = lobby.querySelector('#mpSearchStatus');

    lobby.querySelectorAll('.mp-btn').forEach(btn=> btn.onclick=()=> enqueue(btn.getAttribute('data-mode')));
    lobby.querySelector('#mpClose')?.addEventListener('click', ()=>{ if(lastQueueMode) dequeue(); });

    lobby.querySelector('#mpCopyLink')?.addEventListener('click', async ()=>{
      try{
        const res = await jget('/me');
        const link = (res && res.inviteLink) || (location.origin + '/izza-game/auth?src=invite&from=' + encodeURIComponent(res.username||'player'));
        await navigator.clipboard.writeText(link);
        toast('Invite link copied');
      }catch(e){
        const fallback = location.origin + '/izza-game/auth';
        toast('Copy failed; showing link…'); prompt('Copy this invite link:', fallback);
      }
    });

    // SEARCH
    const doSearch = async (immediate=false)=>{
      const q=(ui.search?.value||'').trim();
      const thisRun = ++searchRunId;
      const setStatus = (txt)=>{ if(searchRunId===thisRun && ui.searchStatus) ui.searchStatus.textContent = txt; };
      const enableBtn = ()=>{ if(ui.searchBtn) ui.searchBtn.disabled=false; };
      const disableBtn= ()=>{ if(ui.searchBtn) ui.searchBtn.disabled=true; };

      if(!q){
        disableBtn(); paintFriends(friends); setStatus('Type a name and press Search or Return'); enableBtn(); return;
      }
      if(!immediate && q.length<2){ setStatus('Type at least 2 characters'); return; }

      disableBtn(); setStatus('Searching…');
      try{
        const list = await searchPlayers(q);
        if(searchRunId !== thisRun) return;
        paintFriends((list||[]).map(u=>({username:u.username, active:!!u.active})));
        setStatus((list&&list.length)?`Found ${list.length} result${list.length===1?'':'s'}`:'No players found');
        if(!list || !list.length){
          const host = lobby.querySelector('#mpFriends');
          if(host){
            const none=document.createElement('div');
            none.className='friend';
            none.innerHTML=`
              <div>
                <div>${q}</div>
                <div class="meta">Player not found — Invite user to join IZZA GAME</div>
              </div>
              <button class="mp-small">Copy Invite</button>`;
            none.querySelector('button')?.addEventListener('click', async ()=>{
              const link = location.origin + '/izza-game/auth?src=invite&from=' + encodeURIComponent(me?.username||'player');
              try{ await navigator.clipboard.writeText(link); toast('Invite link copied'); }
              catch{ prompt('Copy link:', link); }
            });
            host.appendChild(none);
          }
        }
      }catch(err){
        if(searchRunId === thisRun) setStatus(`Search failed: ${err.message}`);
      }finally{
        if(searchRunId === thisRun) enableBtn();
      }
    };

    const debouncedSearch = debounced(()=>doSearch(false), CFG.searchDebounceMs);
    ui.search?.addEventListener('input',  debouncedSearch);
    ui.search?.addEventListener('change', debouncedSearch);
    ui.search?.addEventListener('paste',  debouncedSearch);
    ui.search?.addEventListener('keydown', (e)=>{
      if((e.key||'').toLowerCase()==='enter'){ e.preventDefault(); doSearch(true); }
    });
    ui.searchBtn?.addEventListener('click', ()=> doSearch(true));

    paintRanks(); paintFriends(friends);
  }

  const obs = new MutationObserver(function(){
    const h=document.getElementById('mpLobby'); if(!h) return;
    const visible = h.style.display && h.style.display!=='none';
    if(visible) mountLobby(h);
  });
  (function bootObserver(){
    const root=document.body||document.documentElement;
    if(root) obs.observe(root,{subtree:true, attributes:true, childList:true, attributeFilter:['style']});
  })();

  async function start(){
    try{
      await loadMe(); await loadFriends(); refreshRanks();

      // presence refresher
      setInterval(async () => { try { await jget('/me'); } catch{} }, 20000);

      // notifications poll
      const pull=async()=>{
        try{
          const n = await jget('/notifications');
          if(n && n.start){ startMatch(n.start); return; }
          if(n && n.round){
            // optional polling channel
            if(n.round.type==='start') onRoundStart(n.round);
            else onRoundEnd({ roundId:n.round.roundId, winner:n.round.winner });
          }
          if(n && n.finish && (!match || !n.finish.matchId || n.finish.matchId===match.id)){
            if(n.finish.winner) finishMatch(n.finish.winner, 'server');
          }
          if(n && Array.isArray(n.invites) && n.invites.length){
            const inv = n.invites[0];
            if(pull._lastInviteId !== inv.id){
              pull._lastInviteId = inv.id;
              const ok = confirm(`${inv.from} invited you${inv.mode?` (${inv.mode})`:''}. Accept?`);
              if(ok){
                const r = await jpost('/lobby/accept',{inviteId:inv.id});
                if(r && r.start) startMatch(r.start);
              }else{
                try{ await jpost('/lobby/decline',{inviteId:inv.id}); }catch{}
              }
            }
          }
        }catch{}
      };
      pull(); notifTimer=setInterval(pull, 5000);

      connectWS();

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
