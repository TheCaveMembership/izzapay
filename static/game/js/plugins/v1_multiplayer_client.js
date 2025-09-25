/**
 * IZZA Multiplayer Client — v1.9.0 ULTRA
 * - Keeps ALL friends & notifications features intact (global bell, popup, requests).
 * - Auto-switch SOLO → WORLD 1 before any PvP (queue, accept, invite).
 * - Sends appearance + inventory snapshot at match start (mirrors local loadout).
 * - Tighter round watchdogs + idempotent lifecycle (no freezes/double wiring).
 * - WS fast-path supported (if server emits events); REST remains the source of truth.
 * - Positions Friends UI under chat; hides FIRE while open (unchanged behavior).
 */
(function(){
  const BUILD='v1.9.0-mp-ultra+duels+friends+notifs';
  console.log('[IZZA PLAY]', BUILD);

  const CFG = {
    base: (window.__MP_BASE__ || '/izza-game/api/mp'),
    ws:   (window.__MP_WS__   || '/izza-game/api/mp/ws'),
    searchDebounceMs: 250,
    meRefreshMs: 20000,
    notifPollMs: 5000
  };
  const MATCH_CFG = {
    roundsToWin: 2,          // best of 3
    roundWatchdogMs: 6000,   // tighter than 1.7.2 (8s) for snappier nudges
    betweenWatchdogMs: 3500  // tighter than 1.7.2 (5s)
  };

  // === overlay z-indexes (ensure we sit above lobby/shield) ==================
  const Z = { shield:1002, lobby:1003, bell:1011, drop:1012 };

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

  // SOLO/world helpers
  const getWorld = ()=> localStorage.getItem('izzaWorldId') || 'solo';
  const isSolo = ()=> String(getWorld()||'solo').toLowerCase()==='solo';
  function joinWorld(w){
    try{
      (window.REMOTE_PLAYERS_API && REMOTE_PLAYERS_API.send('join-world', {world:String(w||'1')})) || null;
      localStorage.setItem('izzaWorldId', String(w||'1'));
      window.dispatchEvent(new CustomEvent('world-changed', { detail:{ world:String(w||'1') }}));
    }catch{}
  }
  async function ensureWorldForPvP(){
    if(isSolo()){
      joinWorld('1');
      await new Promise(r=>setTimeout(r,250));
      return true;
    }
    return false;
  }

  let ws=null, wsReady=false, reconnectT=null, lastQueueMode=null;
  let me=null, friends=[], lobby=null, ui={};
  let notifTimer=null;

  // notifications state
  let notifications = { unread: 0, items: [] }; // {id,type:'friend'|'battle', from, mode?}

  let lobbyOpen=false, shield=null, hudEls=[], hudCssPrev=[];
  const $  = (s,r=document)=> r.querySelector(s);
  const toast = (t)=> (window.IZZA&&IZZA.emit)?IZZA.emit('toast',{text:t}):console.log('[TOAST]',t);

  async function loadMe(){ me = await jget('/me'); return me; }
  async function loadFriends(){
    const res=await jget('/friends/list');
    friends=res.friends||[];
    return friends;
  }
  async function searchPlayers(q){ const res=await jget('/players/search?q='+encodeURIComponent(q||'')); return res.users||[]; }

  async function refreshRanks(){ try{ const r=await jget('/ranks'); if(r&&r.ranks) me.ranks=r.ranks; paintRanks(); }catch{} }
  function paintRanks(){
    if(!lobby || !me || !me.ranks) return;
    const set=(id,key)=>{ const el=$(id,lobby); if(!el) return; const r=me.ranks[key]||{w:0,l:0}; const sp=el.querySelector('span'); if(sp) sp.textContent=`${r.w}W / ${r.l}L`; };
    set('#r-br10','br10'); set('#r-v1','v1'); set('#r-v2','v2'); set('#r-v3','v3');
  }

  const isFriend = (name)=> !!friends.find(f=> (f.username||'').toLowerCase() === (name||'').toLowerCase());

  // === Appearance/Inventory snapshot (for mirror-accurate duel start) =======
  function getAppearance(){ try{ return (window.IZZA?.api?.getAppearance?.()) || {}; }catch{ return {}; } }
  function getInventorySnapshot(){
    try{
      if(IZZA?.api?.getInventorySnapshot) return IZZA.api.getInventorySnapshot();
      const merged={};
      try{ Object.assign(merged, (IZZA?.api?.getInventory?.())||{}); }catch{}
      try{ Object.assign(merged, (IZZA?.api?.getArmory?.())||{}); }catch{}
      try{ merged.crafted = (IZZA?.api?.getCraftedItems?.())||{}; }catch{}
      return merged;
    }catch{ return {}; }
  }

  // === UI BUILDERS ===========================================================
  function makeRow(u){
    const row=document.createElement('div');
    row.className='friend';
    const alreadyFriend = isFriend(u.username);
    const activeLabel   = u.active ? 'Active' : 'Offline';

    row.innerHTML=`
      <div>
        <div>${u.username}</div>
        <div class="meta ${u.active?'active':'offline'}">${activeLabel}</div>
      </div>
      <div style="display:flex; gap:8px; align-items:center">
        <button class="mp-small" data-invite="${u.username}">Invite</button>
        ${u.active?`<button class="mp-small outline" data-join="${u.username}">Invite to Lobby</button>`:''}
        ${alreadyFriend ? '' : `<button class="mp-small ghost" data-add="${u.username}">Add Friend</button>`}
      </div>`;

    async function invite(username){
      if(await ensureWorldForPvP()) await new Promise(r=>setTimeout(r,150));
      try{ await jpost('/lobby/invite',{toUsername:username, mode:'v1'}); toast('Invite sent to '+username); }
      catch(e){ toast('Invite failed: '+e.message); }
    }

    row.querySelector('button[data-invite]')?.addEventListener('click', ()=> invite(u.username));
    row.querySelector('button[data-join]')?.addEventListener('click', ()=> invite(u.username));
    row.querySelector('button[data-add]')?.addEventListener('click', async ()=>{
      try{
        await jpost('/friends/request',{ toUsername:u.username, username:u.username });
        toast('Friend request sent to '+u.username);
        const b=row.querySelector('button[data-add]'); if(b){ b.disabled=true; b.textContent='Requested'; }
      }catch(e){ toast('Friend request failed: '+e.message); }
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
  function updatePresence(user, active){
    const f=friends.find(x=>x.username===user);
    if(f){ f.active=!!active; if(lobby && lobby.style.display!=='none') repaintFriends(); }
  }

  // ==== MATCH / ROUNDS — state machine + watchdogs ===========================
  let match = null; // { id, mode, players[], myName, oppName, myWins, oppWins, state, fence, tWatch, lastChange }

  function clearWatch(){
    if(match && match.tWatch){ clearTimeout(match.tWatch); match.tWatch=null; }
  }
  function armWatch(ms){
    clearWatch();
    if(!match) return;
    match.tWatch = setTimeout(async()=>{
      if(!match || match.finished) return;
      try{
        if(match.state==='in_round'){
          await jpost('/match/ping',{matchId:match.id, phase:'in_round', since:match.lastChange||0});
        }else if(match.state==='between'){
          await jpost('/match/next',{matchId:match.id});
        }
      }catch{}
      armWatch(ms);
    }, ms);
  }
  function setState(s){
    if(!match) return;
    match.state = s;
    match.lastChange = Date.now();
    if(s==='in_round')      armWatch(MATCH_CFG.roundWatchdogMs);
    else if(s==='between')  armWatch(MATCH_CFG.betweenWatchdogMs);
    else                    clearWatch();
  }
  function hardResetMatch(){ clearWatch(); match = null; }

  function initMatch(payload){
    hardResetMatch();
    const names = (payload?.players||[]).map(p=>p.username||p);
    const myName  = me?.username || 'me';
    const oppName = names.find(n=>n!==myName) || (names[0]||'opponent');
    match = {
      id: payload?.matchId || payload?.id || ('m_'+Math.random().toString(36).slice(2)),
      mode: payload?.mode || 'v1',
      players: names, myName, oppName,
      myWins:0, oppWins:0,
      roundsToWin: MATCH_CFG.roundsToWin,
      finished:false,
      fence: Object.create(null),
      state:'between',
      tWatch:null,
      lastChange:Date.now()
    };

    try{
      // Send full visuals so both sides render identically from frame 0
      IZZA?.emit?.('duel-config', {
        roundsToWin: match.roundsToWin,
        matchId: match.id,
        appearance: getAppearance(),
        inventory:  getInventorySnapshot()
      });
    }catch{}
  }

  function onRoundStart(_d){ if(!match || match.finished) return; if(match.state!=='in_round'){ setState('in_round'); } }
  function onRoundEnd(data){
    if(!match || match.finished) return;
    const rid = (data && data.roundId) || ('r_'+Date.now());
    if(match.fence[rid]) return;
    match.fence[rid]=1;

    const iWon = data?.winnerIsMe===true || (data?.winner && data.winner===match.myName);
    if(iWon) match.myWins++; else match.oppWins++;

    IZZA.emit?.('toast', {text:`Round • ${match.myName}: ${match.myWins} — ${match.oppName}: ${match.oppWins}`});

    (async()=>{ try{
      await jpost('/match/round',{matchId:match.id, roundId:rid, winner: iWon?match.myName:match.oppName, myWins:match.myWins, oppWins:match.oppWins});
    }catch{} })();

    if(match.myWins>=match.roundsToWin || match.oppWins>=match.roundsToWin){
      finishMatch(iWon?match.myName:match.oppName);
    }else{
      setState('between');
      (async()=>{ try{ await jpost('/match/next',{matchId:match.id}); }catch{} })();
    }
  }

  function finishMatch(winnerName){
    if(!match || match.finished) return;
    match.finished = true;
    setState('finished');

    const modeKey = match.mode || 'v1';
    me = me || {};
    me.ranks = me.ranks || {};
    me.ranks[modeKey] = me.ranks[modeKey] || { w:0, l:0 };
    if (winnerName === (me.username || match.myName)) me.ranks[modeKey].w++; else me.ranks[modeKey].l++;
    paintRanks();

    (async()=>{
      try{ await jpost('/match/finish',{matchId:match.id, winner:winnerName}); }catch{}
      try{ await refreshRanks(); }catch{}
    })();

    toast(winnerName===match.myName ? 'You won the match!' : `${winnerName} won the match`);
  }

  (function wireDuelHooksOnce(){
    if(!window.IZZA) return;
    if(wireDuelHooksOnce._wired) return;
    wireDuelHooksOnce._wired = true;

    IZZA.on?.('ready', function(){
      IZZA.on?.('duel-round-start', (_,_p)=> onRoundStart(_p||{}));
      IZZA.on?.('duel-round-end',   (_,_p)=> onRoundEnd(_p||{}));
      IZZA.on?.('duel-match-finish',(_,_p)=>{ if(_p && _p.winner) finishMatch(_p.winner); });

      if(window.__MP_START_PENDING){
        const p = window.__MP_START_PENDING; delete window.__MP_START_PENDING;
        startMatch(p);
      }
    });
  })();

  function startMatch(payload){
    (async ()=>{
      try{
        // Ensure we’re not in SOLO before starting; retry quickly once
        if(await ensureWorldForPvP()) await new Promise(r=>setTimeout(r,150));

        ui.queueMsg && (ui.queueMsg.textContent='');
        lobby && (lobby.style.display='none');
        initMatch(payload);

        const startPayload = {
          ...payload,
          roundsToWin: match.roundsToWin,
          matchId: match.id,
          appearance: getAppearance(),
          inventory:  getInventorySnapshot()
        };

        if(window.IZZA && typeof IZZA.emit==='function'){
          IZZA.emit('mp-start', startPayload);
        }else{
          window.__MP_START_PENDING = startPayload;
        }
        toast('Match starting…');

        setState('between');
        try{ await jpost('/match/next',{matchId:match.id}); }catch{}
      }catch(e){
        console.warn('startMatch failed', e);
        window.__MP_START_PENDING = payload;
      }
    })();
  }

  async function enqueue(mode){
    try{
      if(await ensureWorldForPvP()) await new Promise(r=>setTimeout(r,150));
      lastQueueMode=mode;
      const nice= mode==='br10'?'Battle Royale (10)': mode==='v1'?'1v1': mode==='v2'?'2v2':'3v3';
      ui.queueMsg && (ui.queueMsg.textContent=`Queued for ${nice}… (waiting for match)`);
      const res = await jpost('/queue',{mode});
      if(res && res.start){ startMatch(res.start); }
    }catch(e){
      ui.queueMsg && (ui.queueMsg.textContent='');
      toast('Queue error: '+e.message);
    }
  }
  async function dequeue(){ try{ await jpost('/dequeue'); }catch{} ui.queueMsg && (ui.queueMsg.textContent=''); lastQueueMode=null; }

  // --- WS (friends/queue/duel/requests fast-path; REST remains baseline) -----
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
        onRoundStart(msg);

      }else if(msg.type==='match.round'){
        if(!match || match.finished) return;
        if(msg.matchId && match.id !== msg.matchId) return;
        onRoundEnd({ roundId: msg.roundId || ('ws_'+Date.now()), winner: msg.winner });

      }else if(msg.type==='match.finish'){
        if(!match || (msg.matchId && match.id!==msg.matchId)) return;
        if(msg.winner) finishMatch(msg.winner);

      }else if(msg.type==='friend.request'){
        addNotification({ id: msg.id || ('fr_'+Date.now()), type:'friend', from: msg.from });

      }else if(msg.type==='invite'){
        addNotification({ id: msg.id || ('inv_'+Date.now()), type:'battle', from: msg.from, mode: msg.mode });
      }
    });
  }

  // --- typing shield (unchanged visuals/behavior) ----------------------------
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
    Object.assign(shield.style,{position:'fixed', inset:'0', zIndex:Z.shield, background:'transparent', touchAction:'none'});
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

    if(window.__MP_START_PENDING){
      const p = window.__MP_START_PENDING; delete window.__MP_START_PENDING;
      startMatch(p);
    }
  }

  // ---------- SEARCH state ----------
  let searchRunId = 0;

  // ===== GLOBAL notification bell & dropdown (fixed overlays) ================
  function ensureBellOverlay(){
    if(ui.notifBell && ui.notifBadge && ui.notifDropdown) return;

    // bell (smaller & moved down so it doesn't sit beside hearts)
    const bell = document.createElement('button');
    bell.id = 'mpNotifBell';
    bell.title = 'Notifications';
    bell.textContent = '🔔';
    Object.assign(bell.style, {
      position:'fixed', right:'14px', top:'56px', zIndex:Z.bell,
      width:'28px', height:'28px', borderRadius:'16px',
      background:'#162134', color:'#cfe0ff',
      border:'1px solid #2a3550', display:'flex', alignItems:'center', justifyContent:'center',
      boxShadow:'0 2px 8px rgba(0,0,0,.25)'
    });
    bell.addEventListener('click', toggleNotifDropdown);
    document.body.appendChild(bell);

    // badge (aligned with smaller bell)
    const badge = document.createElement('span');
    badge.id='mpNotifBadge';
    Object.assign(badge.style, {
      position:'fixed', right:'6px', top:'48px', zIndex:Z.drop,
      minWidth:'14px', height:'14px', borderRadius:'7px',
      background:'#e11d48', color:'#fff', fontSize:'10px',
      display:'none', alignItems:'center', justifyContent:'center',
      padding:'0 4px', lineHeight:'14px'
    });
    document.body.appendChild(badge);

    // dropdown (follows new bell y)
    const dd = document.createElement('div');
    dd.id='mpNotifDropdown';
    Object.assign(dd.style, {
      position:'fixed', right:'10px', top:'90px', zIndex:Z.drop,
      background:'#0f1522', color:'#e8eef7',
      border:'1px solid #2a3550', borderRadius:'12px',
      minWidth:'280px', maxWidth:'92vw', maxHeight:'300px', overflow:'auto',
      display:'none', boxShadow:'0 10px 24px rgba(0,0,0,.45)'
    });
    document.body.appendChild(dd);

    ui.notifBell = bell; ui.notifBadge = badge; ui.notifDropdown = dd;
  }

  // ===== Utility: find chat bar rect (Type/Send/EN) & position friends UI ===
  function findChatBarRect(){
    const txt = document.querySelector('input[placeholder="Type..."], textarea[placeholder="Type..."]');
    if(txt) return txt.getBoundingClientRect();
    const send = Array.from(document.querySelectorAll('button')).find(b=> (b.textContent||'').trim()==='Send');
    if(send) return send.getBoundingClientRect();
    const en = Array.from(document.querySelectorAll('button,div')).find(b=> (b.textContent||'').trim()==='EN');
    if(en) return en.getBoundingClientRect();
    return null;
  }
  function positionFriendsUI(){
    const r = findChatBarRect();
    if(!r){ return; }
    const gapBtn = 8, gapPop = 12;
    const btnTop = Math.round(window.scrollY + r.bottom + gapBtn);
    if(ui.friendsToggle){
      ui.friendsToggle.style.top = btnTop+'px';
      ui.friendsToggle.style.right = '14px';
      ui.friendsToggle.style.bottom = '';
    }
    if(ui.friendsPopup){
      const popTop = Math.round(window.scrollY + r.bottom + gapPop);
      ui.friendsPopup.style.top = popTop + 'px';
      ui.friendsPopup.style.right = '14px';
      ui.friendsPopup.style.bottom = '';
      const remaining = Math.max(120, window.innerHeight - (popTop - window.scrollY) - 16);
      ui.friendsPopup.style.maxHeight = remaining + 'px';
    }
  }
  window.addEventListener('resize', positionFriendsUI);

  // ===== GLOBAL friends button (always visible; sits under Send/EN) =========
  function ensureFriendsButtonOverlay(){
    if(ui.friendsToggle && ui.friendsToggle._global) return;
    const btn = document.createElement('button');
    btn.id='mpFriendsToggleGlobal';
    btn.title='Friends';
    btn.textContent='Friends';
    Object.assign(btn.style, {
      position:'fixed',
      right:'14px',
      top:'0px',   // positioned by positionFriendsUI()
      zIndex:Z.bell,
      height:'34px', padding:'0 12px', borderRadius:'18px',
      background:'#162134', color:'#cfe0ff',
      border:'1px solid #2a3550', display:'flex', alignItems:'center', justifyContent:'center',
      boxShadow:'0 2px 8px rgba(0,0,0,.25)'
    });
    btn.addEventListener('click', toggleFriendsPopup);
    document.body.appendChild(btn);
    ui.friendsToggle = btn; ui.friendsToggle._global = true;
    setTimeout(positionFriendsUI, 0);
  }

  // ===== Notifications (UI + state) =========================================
  function renderNotifDropdown(){
    if(!ui.notifDropdown) return;
    const host = ui.notifDropdown; host.innerHTML = '';
    const header = document.createElement('div'); header.textContent='Notifications';
    header.style.cssText='padding:10px 12px;font-weight:700;border-bottom:1px solid #24324e';
    host.appendChild(header);
    if(!notifications.items.length){ const empty=document.createElement('div'); empty.style.cssText='padding:10px; opacity:.8;'; empty.textContent='No notifications'; host.appendChild(empty); return; }
    notifications.items.forEach(n=>{
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:8px; padding:10px 12px; border-bottom:1px solid #18233a;';
      const label = document.createElement('div'); label.style.cssText='font-size:13px; line-height:1.3;';
      if(n.type==='friend'){
        label.textContent = `${n.from} sent you a friend request`;
        const actions = document.createElement('div'); actions.style.cssText='display:flex; gap:6px;';
        const accept=document.createElement('button'); accept.className='mp-small'; accept.textContent='Accept';
        accept.addEventListener('click', async ()=>{
          try{
            await jpost('/friends/accept', { requestId:n.id, from:n.from, username:n.from });
            toast('Friend added: '+n.from);
            try{ await loadFriends(); repaintFriends(); }catch{}
            removeNotification(n.id);
          }catch(e){ toast('Accept failed: '+e.message); }
        });
        const decline=document.createElement('button'); decline.className='mp-small ghost'; decline.textContent='Decline';
        decline.addEventListener('click', async ()=>{ try{ await jpost('/friends/decline', { requestId:n.id, from:n.from, username:n.from }); }catch{} removeNotification(n.id); });
        actions.appendChild(accept); actions.appendChild(decline); row.appendChild(label); row.appendChild(actions);
      }else if(n.type==='battle'){
        label.textContent = `${n.from} invited you${n.mode?(' ('+n.mode+')'):''}`;
        const actions = document.createElement('div'); actions.style.cssText='display:flex; gap:6px;';
        const accept=document.createElement('button'); accept.className='mp-small'; accept.textContent='Accept';
        accept.addEventListener('click', async ()=>{
          try{
            if(await ensureWorldForPvP()) await new Promise(r=>setTimeout(r,150));
            const r = await jpost('/lobby/accept',{ inviteId:n.id, from:n.from });
            removeNotification(n.id);
            if(r && r.start) startMatch(r.start);
          }catch(e){ toast('Accept failed: '+e.message); }
        });
        const decline=document.createElement('button'); decline.className='mp-small ghost'; decline.textContent='Decline';
        decline.addEventListener('click', async ()=>{ try{ await jpost('/lobby/decline',{ inviteId:n.id, from:n.from }); }catch{} removeNotification(n.id); });
        actions.appendChild(accept); actions.appendChild(decline); row.appendChild(label); row.appendChild(actions);
      }else{
        label.textContent = 'Notification'; row.appendChild(label);
      }
      host.appendChild(row);
    });
  }
  function setUnread(n){
    notifications.unread = Math.max(0, n|0);
    ensureBellOverlay();
    if(notifications.unread>0){
      ui.notifBadge.style.display='flex'; ui.notifBadge.textContent = String(notifications.unread);
      ui.notifBell.style.background = '#2b1720'; ui.notifBell.style.borderColor = '#7d223a'; ui.notifBell.style.color = '#ffd7df';
    }else{
      ui.notifBadge.style.display='none'; ui.notifBell.style.background = '#162134'; ui.notifBell.style.borderColor = '#2a3550'; ui.notifBell.style.color = '#cfe0ff';
    }
  }
  function addNotification(n){
    notifications.items.unshift(n);
    setUnread(notifications.unread+1);
    if(ui.notifDropdown && ui.notifDropdown.style.display!=='none'){ renderNotifDropdown(); markAllNotificationsRead(); }
  }
  function removeNotification(id){
    notifications.items = notifications.items.filter(x=>x.id!==id);
    renderNotifDropdown();
  }
  function markAllNotificationsRead(){ setUnread(0); }
  function toggleNotifDropdown(){
    ensureBellOverlay();
    const dd = document.getElementById('mpNotifDropdown'); if(!dd) return;
    const vis = (dd.style.display!=='none');
    dd.style.display = vis ? 'none' : 'block';
    if(!vis){ renderNotifDropdown(); markAllNotificationsRead(); }
  }

  function ensureNotifUI(){
    ensureBellOverlay();
    ensureFriendsButtonOverlay();
    if(lobby){
      const label = $('#mpFriendsLabel', lobby);
      if(label) label.textContent = 'Search All Players';
      if(ui.searchStatus && !ui.searchStatus._relabelled){
        ui.searchStatus.textContent = 'Search All Players — type a name and press Search or Return';
        ui.searchStatus._relabelled = true;
      }
      const old = lobby.querySelector('#mpFriendsToggle'); if(old){ old.remove(); }
    }
  }

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
        disableBtn(); paintFriends(friends); setStatus('Search All Players — type a name and press Search or Return'); enableBtn(); return;
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

    ensureNotifUI();

    paintRanks(); paintFriends(friends);
  }

  // Observe lobby visibility to mount once it opens
  const obs = new MutationObserver(function(){
    const h=document.getElementById('mpLobby'); if(!h) return;
    const visible = h.style.display && h.style.display!=='none';
    if(visible) mountLobby(h);
  });
  (function bootObserver(){
    const root=document.body||document.documentElement;
    if(root) obs.observe(root,{subtree:true, attributes:true, childList:true, attributeFilter:['style']});
  })();

  // ---- Notifications poll ---------------------------------------------------
  async function pullNotifications(){
    try{
      const n = await jget('/notifications');

      // duel lifecycle
      if(n && n.start){ startMatch(n.start); return; }
      if(n && n.round){
        if(n.round.type==='start') onRoundStart(n.round);
        else onRoundEnd({ roundId:n.round.roundId, winner:n.round.winner });
      }
      if(n && n.finish && (!match || !n.finish.matchId || n.finish.matchId===match.id)){
        if(n.finish && n.finish.winner) finishMatch(n.finish.winner);
      }

      // battle invites
      if(n && Array.isArray(n.invites) && n.invites.length){
        const inv = n.invites[0];
        if(pullNotifications._lastInviteId !== inv.id){
          pullNotifications._lastInviteId = inv.id;
          addNotification({ id:inv.id, type:'battle', from:inv.from, mode:inv.mode });
        }
      }

      // friend requests (any shape)
      const reqs = (n && (n.friendRequests || n.requests)) || (n && n.friend ? [n.friend] : []);
      if(Array.isArray(reqs)){
        reqs.forEach(fr=>{
          const id = fr.id || fr.requestId || ('fr_'+(fr.from||'')+'_'+Date.now());
          if(!notifications.items.find(x=>x.id===id)){
            addNotification({ id, type:'friend', from: fr.from || fr.username || 'player' });
          }
        });
      }
    }catch{}
  }

  // --- STARTUP ---------------------------------------------------------------
  async function start(){
    try{
      await loadMe(); await loadFriends(); refreshRanks();

      // Overlays
      ensureBellOverlay();
      ensureFriendsButtonOverlay();

      // presence refresher (kept same cadence; not user-visible animation)
      setInterval(async () => { try { await jget('/me'); } catch{} }, CFG.meRefreshMs);

      // notifications poll
      pullNotifications();
      notifTimer=setInterval(pullNotifications, CFG.notifPollMs);

      connectWS();

      const h=document.getElementById('mpLobby');
      if(h && h.style.display && h.style.display!=='none') mountLobby(h);

      setTimeout(positionFriendsUI, 250);

      console.log('[MP] client ready', {user:me?.username, friends:friends.length, ws:!!ws});
    }catch(e){
      console.error('MP client start failed', e);
      toast('Multiplayer unavailable: '+e.message);
    }
  }
  if(document.readyState==='complete' || document.readyState==='interactive') start();
  else addEventListener('DOMContentLoaded', start, {once:true});

  // === SOLO error helpers for other modules to surface nicely ================
  window.addEventListener('mp-error', (e)=>{
    const payload = e && e.detail;
    if(!payload) return;
    if(payload.error === 'in_solo_world' || payload.error === 'solo_world'){
      toast('PvP is not available in SOLO. Picking WORLD 1 for you…');
      joinWorld('1');
    }
    if(payload.error === 'wrong_world'){
      joinWorld(String(payload.world||'1'));
      toast('Switching to WORLD '+(payload.world||'1')+'…');
    }
  });

})();
