/**
 * IZZA Multiplayer Client — v1.7.4
 * - Best-of-3 round coordinator (first to 2) + watchdogs
 * - Friends + invites + notifications (GLOBAL overlays; independent of lobby)
 * - SOLO world awareness: queues disabled in SOLO with friendly toasts
 * - Inventory handoff: exposes loadout via IZZA.api.getInventorySnapshot()
 * - Robust mount: bell + friends button are created at boot (even if lobby never opens)
 */
(function(){
  const BUILD='v1.7.4-mp-client+bo3+watchdogs+friends+notifs+solo+robust';
  console.log('[IZZA PLAY]', BUILD);

  const CFG = {
    base: (window.__MP_BASE__ || '/izza-game/api/mp'),
    ws:   (window.__MP_WS__   || '/izza-game/api/mp/ws'),
    searchDebounceMs: 250,
  };
  const MATCH_CFG = {
    roundsToWin: 2,          // best of 3
    roundWatchdogMs: 8000,
    betweenWatchdogMs: 5000,
  };

  // overlay z-indexes (sit above lobby/shield)
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

  // --- state ---
  let ws=null, wsReady=false, reconnectT=null, lastQueueMode=null;
  let me=null, friends=[], lobby=null, ui={};
  let notifTimer=null;

  // notifications state
  let notifications = { unread: 0, items: [] }; // {id,type:'friend'|'battle', from, mode?}

  let lobbyOpen=false, shield=null, hudEls=[], hudCssPrev=[];
  const $  = (s,r=document)=> r.querySelector(s);
  const toast = (t)=> (window.IZZA&&IZZA.emit)?IZZA.emit('toast',{text:t}):console.log('[TOAST]',t);

  // SOLO-aware helper (uses /me.world)
  const isSolo = ()=> String((me && me.world) || 'solo').toLowerCase()==='solo';

  async function loadMe(){ me = await jget('/me'); return me; }
  async function loadFriends(){ const res=await jget('/friends/list'); friends=res.friends||[]; return friends; }
  async function searchPlayers(q){ const res=await jget('/players/search?q='+encodeURIComponent(q||'')); return res.users||[]; }

  async function refreshRanks(){ try{ const r=await jget('/ranks'); if(r&&r.ranks) me.ranks=r.ranks; paintRanks(); }catch{} }
  function paintRanks(){
    if(!lobby || !me || !me.ranks) return;
    const set=(id,key)=>{ const el=$(id,lobby); if(!el) return; const r=me.ranks[key]||{w:0,l:0}; const sp=el.querySelector('span'); if(sp) sp.textContent=`${r.w}W / ${r.l}L`; };
    set('#r-br10','br10'); set('#r-v1','v1'); set('#r-v2','v2'); set('#r-v3','v3');
  }

  const isFriend = (name)=> !!friends.find(f=> (f.username||'').toLowerCase() === (name||'').toLowerCase());

  // === UI BUILDERS ===========================================================
  function makeRow(u, source='search'){
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

    row.querySelector('button[data-invite]')?.addEventListener('click', async ()=>{
      try{ await jpost('/lobby/invite',{toUsername:u.username}); toast('Invite sent to '+u.username); }
      catch(e){ toast('Invite failed: '+e.message); }
    });
    row.querySelector('button[data-join]')?.addEventListener('click', async ()=>{
      try{ await jpost('/lobby/invite',{toUsername:u.username}); toast('Lobby invite sent to '+u.username); }
      catch(e){ toast('Invite failed: '+e.message); }
    });
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
    (list||[]).forEach(u=> host.appendChild(makeRow(u, 'friends')));
  }
  function repaintFriends(){
    const q=$('#mpSearch',lobby)?.value?.trim().toLowerCase()||'';
    const filtered = q ? friends.filter(x=> (x.username||'').toLowerCase().includes(q)) : friends;
    paintFriends(filtered);
  }
  function updatePresence(user, active){ const f=friends.find(x=>x.username===user); if(f){ f.active=!!active; if(lobby && lobby.style.display!=='none') repaintFriends(); } }

  // ==== MATCH / ROUNDS — state machine + watchdogs ===========================
  let match = null; // { id, mode, players[], myName, oppName, ... }

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

  function getAppearance(){ try{ return (window.IZZA?.api?.getAppearance?.()) || {}; }catch{ return {}; } }
  function getInventorySnapshot(){
    // prefer an explicit snapshot hook if Remote Players API injected it
    try{
      if(IZZA?.api?.getInventorySnapshot) return IZZA.api.getInventorySnapshot();
      const merged = {};
      try{ Object.assign(merged, (IZZA?.api?.getInventory?.())||{}); }catch{}
      try{ Object.assign(merged, (IZZA?.api?.getArmory?.())||{}); }catch{}
      try{ merged.crafted = (IZZA?.api?.getCraftedItems?.())||{}; }catch{}
      return merged;
    }catch{ return {}; }
  }

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

    // surface config + loadout for duel client
    try{
      IZZA?.emit?.('duel-config', {
        roundsToWin: MATCH_CFG.roundsToWin,
        matchId: match.id,
        appearance: getAppearance(),
        inventory:  getInventorySnapshot()
      });
    }catch{}
  }

  function onRoundStart(_data){ if(!match || match.finished) return; if(match.state!=='in_round'){ setState('in_round'); } }

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
      finishMatch(iWon?match.myName:match.oppName, 'local');
    }else{
      setState('between');
      (async()=>{ try{ await jpost('/match/next',{matchId:match.id}); }catch{} })();
    }
  }

  function finishMatch(winnerName){
    if(!match || match.finished) return;
    match.finished = true;
    setState('finished');

    const loserName = (winnerName===match.myName) ? match.oppName : match.myName;

    IZZA.emit?.('mp-finish', { matchId:match.id, winner:winnerName, loser:loserName, myWins:match.myWins, oppWins:match.oppWins });

    try{
      const modeKey = match.mode || 'v1';
      me = me || {};
      me.ranks = me.ranks || {};
      me.ranks[modeKey] = me.ranks[modeKey] || { w:0, l:0};
      if (winnerName === (me.username || match.myName)) me.ranks[modeKey].w++; else me.ranks[modeKey].l++;
      paintRanks();
    }catch(e){}

    (async()=>{
      try{ await jpost('/match/finish',{matchId:match.id, winner:winnerName}); }catch{}
      try{ await refreshRanks(); }catch{}
    })();

    const msg = (winnerName===match.myName) ? 'You won the match!' : `${winnerName} won the match`;
    toast(msg);
  }

  // Wire duel hooks once
  (function wireDuelHooksOnce(){
    if(!window.IZZA) return;
    if(wireDuelHooksOnce._wired) return;
    wireDuelHooksOnce._wired = true;

    IZZA.on?.('ready', function(){
      IZZA.on?.('duel-round-start', (_,_payload)=> onRoundStart(_payload||{}));
      IZZA.on?.('duel-round-end',   (_,_payload)=> onRoundEnd(_payload||{}));
      IZZA.on?.('duel-match-finish',(_,_payload)=>{ if(_payload && _payload.winner) finishMatch(_payload.winner, 'duel'); });

      if(window.__MP_START_PENDING){
        const p = window.__MP_START_PENDING; delete window.__MP_START_PENDING;
        startMatch(p);
      }
    });
  })();

  function startMatch(payload){
    try{
      ui.queueMsg && (ui.queueMsg.textContent='');
      lobby && (lobby.style.display='none');

      initMatch(payload);

      const startPayload = {
        ...payload,
        roundsToWin: MATCH_CFG.roundsToWin,
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
      (async()=>{ try{ await jpost('/match/next',{matchId:match.id}); }catch{} })();
    }catch(e){
      console.warn('startMatch failed', e);
      window.__MP_START_PENDING = payload;
    }
  }

  async function enqueue(mode){
    try{
      if (isSolo()){
        toast('PvP queues are disabled in SOLO. Open WORLDS and pick WORLD 1–4.');
        return;
      }
      lastQueueMode=mode;
      const nice= mode==='br10'?'Battle Royale (10)': mode==='v1'?'1v1': mode==='v2'?'2v2':'3v3';
      ui.queueMsg && (ui.queueMsg.textContent=`Queued for ${nice}… (waiting for match)`);
      const res = await jpost('/queue',{mode});
      if(res && res.start){ startMatch(res.start); }
    }catch(e){
      ui.queueMsg && (ui.queueMsg.textContent='');
      if(String(e.message||'').includes('409')){
        toast('Switch to a multiplayer world (1–4) to queue for PvP.');
      }else{
        toast('Queue error: '+e.message);
      }
    }
  }
  async function dequeue(){ try{ await jpost('/dequeue'); }catch{} ui.queueMsg && (ui.queueMsg.textContent=''); lastQueueMode=null; }

  // --- WS ---
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
        const w = msg.winner;
        onRoundEnd({ roundId: msg.roundId || ('ws_'+Date.now()), winner: w });

      }else if(msg.type==='match.finish'){
        if(msg.matchId && match && match.id!==msg.matchId) return;
        if(msg.winner) finishMatch(msg.winner, 'server');

      // OPTIONAL: friend request via WS
      }else if(msg.type==='friend.request'){
        addNotification({ id: msg.id || ('fr_'+Date.now()), type:'friend', from: msg.from });
      }else if(msg.type==='invite'){ // battle request
        addNotification({ id: msg.id || ('inv_'+Date.now()), type:'battle', from: msg.from, mode: msg.mode });
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

    // bell (smaller & below hearts area)
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

    // badge
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

    // dropdown
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

    ui.notifBell = bell;
    ui.notifBadge = badge;
    ui.notifDropdown = dd;
  }

  // ===== GLOBAL friends button (always visible; near chat bar) ==============
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
    const gapBtn = 8;
    const gapPop = 12;
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

  function ensureFriendsButtonOverlay(){
    if(ui.friendsToggle && ui.friendsToggle._global) return;
    const btn = document.createElement('button');
    btn.id='mpFriendsToggleGlobal';
    btn.title='Friends';
    btn.textContent='Friends';
    Object.assign(btn.style, {
      position:'fixed',
      right:'14px',
      top:'0px',   // later positioned under chat bar
      zIndex:Z.bell,
      height:'34px', padding:'0 12px', borderRadius:'18px',
      background:'#162134', color:'#cfe0ff',
      border:'1px solid #2a3550', display:'flex', alignItems:'center', justifyContent:'center',
      boxShadow:'0 2px 8px rgba(0,0,0,.25)'
    });
    btn.addEventListener('click', toggleFriendsPopup);
    document.body.appendChild(btn);
    ui.friendsToggle = btn;
    ui.friendsToggle._global = true;
    setTimeout(positionFriendsUI, 0);
  }

  // ===== Friends popup (global overlay) ======================================
  function getFireButton(){
    const byCommon = document.querySelector('#btnFire, #fireBtn, #shootBtn, .btn-fire, .fire');
    if(byCommon) return byCommon;
    const all = Array.from(document.querySelectorAll('button,div,span'));
    const byText = all.find(el => /\bFIRE\b/i.test((el.textContent||'').trim()));
    if(byText) return byText.closest('button,div') || byText;
    const candidates = all
      .map(el=>[el, el.getBoundingClientRect?.()])
      .filter(([,r])=>r && r.width>50 && r.height>50 && r.bottom>window.innerHeight*0.6 && r.right>window.innerWidth*0.6)
      .sort((a,b)=> (b[1].width*b[1].height)-(a[1].width*a[1].height));
    return candidates.length? candidates[0][0] : null;
  }
  function setFireHidden(hidden){
    const fire = getFireButton(); if(!fire) return;
    const target = fire.closest('button,div') || fire;
    if(hidden){
      target.__prevVis = {display:target.style.display, opacity:target.style.opacity, pointerEvents:target.style.pointerEvents};
      target.style.opacity='0'; target.style.pointerEvents='none'; target.style.display='none';
    }else{
      if(target.__prevVis){
        target.style.display = target.__prevVis.display || '';
        target.style.opacity = target.__prevVis.opacity || '';
        target.style.pointerEvents = target.__prevVis.pointerEvents || '';
        delete target.__prevVis;
      }else{
        target.style.display='';
        target.style.opacity='';
        target.style.pointerEvents='';
      }
    }
  }

  function ensureFriendsPopup(){
    if(ui.friendsPopup) return ui.friendsPopup;
    const pop = document.createElement('div');
    pop.id='mpFriendsPopup';
    Object.assign(pop.style, {
      position:'fixed',
      right:'14px',
      top:'0px',
      zIndex:Z.drop,
      background:'#0f1522', border:'1px solid #2a3550', borderRadius:'12px',
      width:'320px', maxWidth:'92vw', maxHeight:'340px', overflow:'auto', display:'none',
      boxShadow:'0 10px 28px rgba(0,0,0,.35)'
    });
    const head = document.createElement('div');
    head.style.cssText='display:flex; align-items:center; justify-content:space-between; padding:10px 12px; border-bottom:1px solid #2a3550;';
    const ttl = document.createElement('div');
    ttl.textContent='Friends';
    ttl.style.cssText='font-weight:700';
    const x = document.createElement('button');
    x.className='mp-small ghost';
    x.textContent='Close';
    x.addEventListener('click', ()=>{ pop.style.display='none'; setFireHidden(false); });

    head.appendChild(ttl); head.appendChild(x);

    const body = document.createElement('div');
    body.id='mpFriendsListBody';
    body.style.cssText='display:flex; flex-direction:column; gap:6px; padding:10px;';

    pop.appendChild(head);
    pop.appendChild(body);
    document.body.appendChild(pop);
    ui.friendsPopup = pop;
    ui.friendsBody  = body;
    setTimeout(positionFriendsUI, 0);
    return pop;
  }
  function renderFriendsPopup(){
    ensureFriendsPopup();
    if(!ui.friendsBody) return;
    ui.friendsBody.innerHTML='';
    (friends||[]).forEach(f=>{
      const row=document.createElement('div');
      row.style.cssText='display:flex; align-items:center; justify-content:space-between; gap:8px; padding:8px; background:#0f1624; border:1px solid #2a3550; border-radius:8px;';
      const left=document.createElement('div');
      left.innerHTML = `<div>${f.username}</div><div class="meta ${f.active?'active':'offline'}" style="opacity:.8;font-size:12px">${f.active?'Active':'Offline'}</div>`;
      const right=document.createElement('div');
      right.style.cssText='display:flex; gap:6px;';
      const invite=document.createElement('button');
      invite.className='mp-small';
      invite.textContent='Invite';
      invite.addEventListener('click', async ()=>{
        try{ await jpost('/lobby/invite',{toUsername:f.username}); toast('Invite sent to '+f.username); }
        catch(e){ toast('Invite failed: '+e.message); }
      });
      right.appendChild(invite);
      if(f.active){
        const join=document.createElement('button');
        join.className='mp-small outline';
        join.textContent='Invite to Lobby';
        join.addEventListener('click', async ()=>{
          try{ await jpost('/lobby/invite',{toUsername:f.username}); toast('Lobby invite sent to '+f.username); }
          catch(e){ toast('Invite failed: '+e.message); }
        });
        right.appendChild(join);
      }
      row.appendChild(left); row.appendChild(right);
      ui.friendsBody.appendChild(row);
    });
    if(!friends || !friends.length){
      const none=document.createElement('div');
      none.style.cssText='opacity:.8; padding:10px;';
      none.textContent='No friends yet. Use "Search All Players" to add some!';
      ui.friendsBody.appendChild(none);
    }
  }
  function toggleFriendsPopup(){
    ensureFriendsPopup();
    if(!ui.friendsPopup) return;
    const vis = (ui.friendsPopup.style.display!=='none');
    ui.friendsPopup.style.display = vis ? 'none' : 'block';
    if(!vis){ renderFriendsPopup(); positionFriendsUI(); setFireHidden(true); }
    else { setFireHidden(false); }
  }

  // ===== Notifications UI helpers ===========================================
  function renderNotifDropdown(){
    if(!ui.notifDropdown) return;
    const host = ui.notifDropdown;
    host.innerHTML = '';

    const header = document.createElement('div');
    header.textContent = 'Notifications';
    header.style.cssText='padding:10px 12px;font-weight:700;border-bottom:1px solid #24324e';
    host.appendChild(header);

    if(!notifications.items.length){
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:10px; opacity:.8;';
      empty.textContent = 'No notifications';
      host.appendChild(empty);
      return;
    }

    notifications.items.forEach(n=>{
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:8px; padding:10px 12px; border-bottom:1px solid #18233a;';
      const label = document.createElement('div');
      label.style.cssText='font-size:13px; line-height:1.3;';

      if(n.type==='friend'){
        label.textContent = `${n.from} sent you a friend request`;
        const actions = document.createElement('div');
        actions.style.cssText='display:flex; gap:6px;';
        const accept = document.createElement('button');
        accept.className='mp-small';
        accept.textContent='Accept';
        accept.addEventListener('click', async ()=>{
          try{
            await jpost('/friends/accept', { requestId:n.id, from:n.from, username:n.from });
            toast('Friend added: '+n.from);
            try{ await loadFriends(); repaintFriends(); }catch{}
            removeNotification(n.id);
          }catch(e){ toast('Accept failed: '+e.message); }
        });

        const decline = document.createElement('button');
        decline.className='mp-small ghost';
        decline.textContent='Decline';
        decline.addEventListener('click', async ()=>{
          try{ await jpost('/friends/decline', { requestId:n.id, from:n.from, username:n.from }); }
          catch(e){}
          removeNotification(n.id);
        });

        actions.appendChild(accept); actions.appendChild(decline);
        row.appendChild(label); row.appendChild(actions);
      }else if(n.type==='battle'){
        label.textContent = `${n.from} invited you${n.mode?(' ('+n.mode+')'):''}`;
        const actions = document.createElement('div');
        actions.style.cssText='display:flex; gap:6px;';
        const accept = document.createElement('button');
        accept.className='mp-small';
        accept.textContent='Accept';
        accept.addEventListener('click', async ()=>{
          try{
            const r = await jpost('/lobby/accept',{ inviteId:n.id, from:n.from });
            removeNotification(n.id);
            if(r && r.start) startMatch(r.start);
          }catch(e){ toast('Accept failed: '+e.message); }
        });
        const decline = document.createElement('button');
        decline.className='mp-small ghost';
        decline.textContent='Decline';
        decline.addEventListener('click', async ()=>{
          try{ await jpost('/lobby/decline',{ inviteId:n.id, from:n.from }); }catch(e){}
          removeNotification(n.id);
        });

        actions.appendChild(accept); actions.appendChild(decline);
        row.appendChild(label); row.appendChild(actions);
      }else{
        label.textContent = 'Notification';
        row.appendChild(label);
      }

      host.appendChild(row);
    });
  }

  function setUnread(n){
    notifications.unread = Math.max(0, n|0);
    ensureBellOverlay();
    if(notifications.unread>0){
      ui.notifBadge.style.display='flex';
      ui.notifBadge.textContent = String(notifications.unread);
      ui.notifBell.style.background = '#2b1720';
      ui.notifBell.style.borderColor = '#7d223a';
      ui.notifBell.style.color = '#ffd7df';
    }else{
      ui.notifBadge.style.display='none';
      ui.notifBell.style.background = '#162134';
      ui.notifBell.style.borderColor = '#2a3550';
      ui.notifBell.style.color = '#cfe0ff';
    }
  }
  function addNotification(n){
    notifications.items.unshift(n);
    setUnread(notifications.unread+1);
    if(ui.notifDropdown && ui.notifDropdown.style.display!=='none'){
      renderNotifDropdown();
      markAllNotificationsRead();
    }
  }
  function removeNotification(id){
    notifications.items = notifications.items.filter(x=>x.id!==id);
    renderNotifDropdown();
  }
  function markAllNotificationsRead(){ setUnread(0); }
  function toggleNotifDropdown(){
    ensureBellOverlay();
    const vis = (ui.notifDropdown.style.display!=='none');
    ui.notifDropdown.style.display = vis ? 'none' : 'block';
    if(!vis){
      renderNotifDropdown();
      markAllNotificationsRead();
    }
  }

  // === Lobby mounting (rename label + wire buttons) ==========================
  function ensureNotifUI(){
    // Ensure global overlays exist (bell/badge/dropdown + friends button)
    ensureBellOverlay();
    ensureFriendsButtonOverlay();

    if(lobby){
      const label = $('#mpFriendsLabel', lobby);
      if(label) label.textContent = 'Search All Players';

      if(ui.searchStatus && !ui.searchStatus._relabelled){
        ui.searchStatus.textContent = 'Search All Players — type a name and press Search or Return';
        ui.searchStatus._relabelled = true;
      }

      // If a lobby-scoped friends toggle exists from earlier builds, remove duplication
      const old = lobby.querySelector('#mpFriendsToggle');
      if(old){ old.remove(); }
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

  // ---- Notifications poll (friend requests + battle invites + match signals)
  async function pullNotifications(){
    try{
      const n = await jget('/notifications');

      if(n && n.start){ startMatch(n.start); return; }
      if(n && n.round){
        if(n.round.type==='start') onRoundStart(n.round);
        else onRoundEnd({ roundId:n.round.roundId, winner:n.round.winner });
      }
      if(n && n.finish && (!match || !n.finish.matchId || n.finish.matchId===match.id)){
        if(n.finish && n.finish.winner) finishMatch(n.finish.winner, 'server');
      }

      // battle invites
      if(n && Array.isArray(n.invites) && n.invites.length){
        const inv = n.invites[0];
        if(pullNotifications._lastInviteId !== inv.id){
          pullNotifications._lastInviteId = inv.id;
          addNotification({ id:inv.id, type:'battle', from:inv.from, mode:inv.mode });
        }
      }

      // friend requests
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

      // Ensure global overlays exist from the start (fixes "gone now?" issue)
      ensureBellOverlay();
      ensureFriendsButtonOverlay();

      // presence refresher
      setInterval(async () => { try { await jget('/me'); } catch{} }, 20000);

      // notifications poll
      pullNotifications();
      notifTimer=setInterval(pullNotifications, 5000);

      connectWS();

      const h=document.getElementById('mpLobby');
      if(h && h.style.display && h.style.display!=='none') mountLobby(h);

      // position friends button after layout settles
      setTimeout(positionFriendsUI, 250);

      // SOLO hint
      if(isSolo()){
        console.log('[MP] In SOLO world — PvP queue disabled until user switches via WORLDS.');
      }

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
      toast('PvP is not available in SOLO. Pick WORLD 1–4 from WORLDS.');
    }
    if(payload.error === 'wrong_world'){
      toast('You’re in a different world. Open WORLDS and join '+(payload.world||'1')+'.');
    }
  });

})();



// Remote Players API — v2.0
// Smooth interpolation + skinKey compositing cache + robust asset loads
// SOLO-aware + world presence via REST (unchanged endpoints)
(function(){
  const BUILD = 'v2.0-remote-players-smooth+skinKey';
  console.log('[IZZA PLAY]', BUILD);

  // -------- config / helpers ----------
  const MP_BASE = (window.__MP_BASE__ || '/izza-game/api/mp');
  const TOK = (window.__IZZA_T__ || '').toString();
  const withTok = (p) => TOK ? p + (p.includes('?') ? '&' : '?') + 't=' + encodeURIComponent(TOK) : p;

  async function jget(p){
    const r = await fetch(withTok(MP_BASE+p), { credentials:'include' });
    if(!r.ok) throw new Error(`${r.status} ${r.statusText}`); return r.json();
  }
  async function jpost(p,b){
    const r = await fetch(withTok(MP_BASE+p), { method:'POST', credentials:'include', headers:{'Content-Type':'application/json'}, body:JSON.stringify(b||{}) });
    if(!r.ok) throw new Error(`${r.status} ${r.statusText}`); return r.json();
  }

  const getWorld = ()=> localStorage.getItem('izzaWorldId') || 'solo';
  const isMPWorld = ()=> { const w = getWorld(); return w!=='solo'; };

  // ---- appearance/inventory mirror ----
  function readAppearance(){
    try{
      const p = window.__IZZA_PROFILE__ || {};
      return (p.appearance && Object.keys(p.appearance).length) ? p.appearance : {
        sprite_skin: p.sprite_skin || localStorage.getItem('sprite_skin') || 'default',
        hair:        p.hair        || localStorage.getItem('hair')        || 'short',
        outfit:      p.outfit      || localStorage.getItem('outfit')      || 'street',
        body_type:   p.body_type   || 'male',
        hair_color:  p.hair_color  || '',
        skin_tone:   p.skin_tone   || 'light',
        female_outfit_color: p.female_outfit_color || 'blue'
      };
    }catch{ return { sprite_skin:'default', hair:'short', outfit:'street' }; }
  }
  function readInventory(){
    const inv = {};
    try{ Object.assign(inv, (IZZA?.api?.getInventory?.())||{}); }catch{}
    try{ Object.assign(inv, (IZZA?.api?.getArmory?.())||{}); }catch{}
    try{ inv.crafted = (IZZA?.api?.getCraftedItems?.())||{}; }catch{}
    return inv;
  }
  // Optional export for the MP client to snapshot
  try{
    if(!IZZA.api.getInventorySnapshot){
      IZZA.api.getInventorySnapshot = readInventory;
    }
  }catch{}

  // -------- remote players store ----------
  const REMOTES = [];
  const byName = Object.create(null);

  function clearRemotePlayers(){
    REMOTES.splice(0, REMOTES.length);
    for (const k in byName) delete byName[k];
    try{ if (window.IZZA?.api) IZZA.api.remotePlayers = REMOTES; }catch{}
  }

  // ---------- ASSETS & SKIN CACHE ----------
  const FRAME_W=32, FRAME_H=32, ROWS=4;
  const DIR_INDEX = { down:0, right:1, left:2, up:3 };

  function loadImg(src){
    return new Promise((res)=>{ const i=new Image(); i.onload=()=>res(i); i.onerror=()=>res(null); i.src=src; });
  }
  async function loadLayer(kind, name){
    const base = '/static/game/sprites/' + kind + '/';
    const try2 = await loadImg(base + encodeURIComponent(name + ' 2') + '.png');
    if (try2) return { img: try2, cols: Math.max(1, Math.floor(try2.width / FRAME_W)) };
    const try1 = await loadImg(base + encodeURIComponent(name) + '.png');
    if (try1) return { img: try1, cols: Math.max(1, Math.floor(try1.width / FRAME_W)) };
    return { img: null, cols: 1 };
  }

  // Order: back-to-front
  const LAYER_ORDER = [
    'body', 'legs', 'arms', 'outfit', 'vest', 'helm', 'hat', 'hair', 'weapon'
  ];

  // Map inventory → sprite layer names
  function invToLayers(inv){
    const layers = [];
    const c = (k)=> (inv?.[k]?.count|0)>0;

    // Base clothing always present
    layers.push({ kind:'body',   name:(readAppearance().sprite_skin || 'default') });
    layers.push({ kind:'outfit', name:(readAppearance().outfit || 'street') });
    layers.push({ kind:'hair',   name:(readAppearance().hair   || 'short') });

    // Cardboard set (support aliases)
    if(c('armor_cardboard_legs') || c('cardboard_legs')) layers.push({kind:'legs', name:'cardboard_legs'});
    if(c('armor_cardboard_arms') || c('cardboard_arms')) layers.push({kind:'arms', name:'cardboard_arms'});
    if(c('armor_cardboard_vest') || c('cardboard_chest'))layers.push({kind:'vest', name:'cardboard_vest'});
    if(c('armor_cardboard_helm') || c('cardboard_helm')) layers.push({kind:'helm', name:'cardboard_helm'});

    // Weapons (very lightweight — just one overlay if present)
    const weapons = ['uzi','shotgun','sniper','pistol'];
    for(const w of weapons){
      if(c('wpn_'+w) || c('weapon_'+w)){ layers.push({ kind:'weapon', name:w }); break; }
    }

    // Crafted cosmetics (example hooks)
    if(inv?.crafted?.gold_crown) layers.push({ kind:'hat', name:'gold_crown' });

    return layers;
  }

  // skinKey = deterministic hash of appearance + inventory
  function makeSkinKey(ap, inv){
    try{
      const key = {
        body: ap?.sprite_skin||'default',
        hair: ap?.hair||'short',
        outfit: ap?.outfit||'street',
        invKeys: Object.keys(inv||{}).sort().map(k=>k+':' + ((inv[k]?.count|0)||0)),
        crafted: Object.keys(inv?.crafted||{}).sort()
      };
      return JSON.stringify(key);
    }catch{ return 'default'; }
  }

  const SKIN_CACHE = Object.create(null); // skinKey -> {img, cols}
  async function buildComposite(skinKey, layers){
    // If any layer fails to load, skip it but still build (prevents invisibility)
    const loaded = await Promise.all(layers.map(l=>loadLayer(l.kind, l.name)));
    const cols = Math.max(1, ...loaded.map(x=>x.cols||1));
    const cvs = document.createElement('canvas');
    cvs.width  = cols*FRAME_W;
    cvs.height = ROWS*FRAME_H;
    const ctx = cvs.getContext('2d', { alpha:true, willReadFrequently:false });
    ctx.imageSmoothingEnabled = false;

    for(let row=0; row<ROWS; row++){
      for(let col=0; col<cols; col++){
        const dx = col*FRAME_W, dy = row*FRAME_H;
        for(let i=0;i<layers.length;i++){
          const lay = loaded[i];
          if(!lay || !lay.img) continue;
          const srcCol = Math.min(col, (lay.cols||1)-1);
          ctx.drawImage(lay.img, srcCol*FRAME_W, row*FRAME_H, FRAME_W, FRAME_H, dx, dy, FRAME_W, FRAME_H);
        }
      }
    }
    SKIN_CACHE[skinKey] = { img:cvs, cols };
    return SKIN_CACHE[skinKey];
  }
  async function getComposite(ap, inv){
    const skinKey = makeSkinKey(ap, inv);
    if(SKIN_CACHE[skinKey]) return SKIN_CACHE[skinKey];
    // Build lazily; return a tiny placeholder to avoid invisibility
    const ph = SKIN_CACHE[skinKey] = { img:null, cols:1, _pending:true };
    buildComposite(skinKey, invToLayers(inv)).then(()=>{ ph._pending=false; }).catch(()=>{ ph._pending=false; });
    return ph;
  }

  // ---------- INTERPOLATION BUFFER ----------
  const BUFFER_MS = 140;        // how far behind real-time we render
  const STALE_MS  = 5000;       // drop if no updates for this long
  const MAX_SNAP  = 24;         // keep last N snapshots per player

  function pushSnap(rp, x, y, facing){
    const t = Date.now();
    rp.buf.push({t, x, y, facing});
    if(rp.buf.length>MAX_SNAP) rp.buf.splice(0, rp.buf.length-MAX_SNAP);
    rp.lastPacket = t;
  }
  function sampleBuffered(rp, now){
    const target = now - BUFFER_MS;
    const b = rp.buf;
    if(!b.length){
      return { x:rp.x, y:rp.y, facing:rp.facing };
    }
    // find the two surrounding samples
    let i=b.length-1;
    while(i>0 && b[i-1].t>target) i--;
    const a = b[Math.max(0,i-1)];
    const c = b[i];
    if(!a || !c){ return { x:c?.x??rp.x, y:c?.y??rp.y, facing:c?.facing??rp.facing }; }
    if(c.t===a.t){ return { x:c.x, y:c.y, facing:c.facing }; }
    const t = (target - a.t) / (c.t - a.t);
    const lerp=(p,q)=> p + (q-p)*Math.max(0,Math.min(1,t));
    return { x: lerp(a.x,c.x), y: lerp(a.y,c.y), facing: (t>0.5?c.facing:a.facing) };
  }

  // ---------- remote struct ----------
  function makeRemote(opts){
    const rp = {
      username: (opts && opts.username) || 'player',
      ap: (opts && opts.appearance) || readAppearance(),
      inv: (opts && opts.inv) || {},
      x: +((opts && opts.x) ?? 0), y: +((opts && opts.y) ?? 0),
      facing: (opts && opts.facing) || 'down',
      buf: [], lastPacket: 0,
      composite: { img:null, cols:1 }, compositeKey:''
    };
    rp.compositeKey = makeSkinKey(rp.ap, rp.inv);
    // prime composite (async)
    getComposite(rp.ap, rp.inv).then(c=>{ rp.composite = c; });

    // seed buffer so they don’t pop in/place
    pushSnap(rp, rp.x, rp.y, rp.facing);
    return rp;
  }
  function upsertRemote(p){
    const u = String(p?.username||'').trim(); if(!u) return;
    let rp = byName[u];
    if(!rp){ rp = byName[u] = makeRemote(p); REMOTES.push(rp); }
    if (typeof p.x==='number' || typeof p.y==='number'){
      pushSnap(rp, (p.x??rp.x), (p.y??rp.y), p.facing||rp.facing);
      rp.x = p.x??rp.x; rp.y = p.y??rp.y;
    }
    if (p.facing) rp.facing = p.facing;

    // appearance / inventory changed? → refresh composite
    if (p.appearance) rp.ap = p.appearance;
    if (p.inv)        rp.inv = p.inv;
    const key = makeSkinKey(rp.ap, rp.inv);
    if(key !== rp.compositeKey){
      rp.compositeKey = key;
      getComposite(rp.ap, rp.inv).then(c=>{ rp.composite = c; });
    }
  }

  function pruneStale(now){
    for(let i=REMOTES.length-1;i>=0;i--){
      const rp=REMOTES[i];
      if(now - (rp.lastPacket||0) > STALE_MS){
        REMOTES.splice(i,1); delete byName[rp.username];
      }
    }
  }

  // ---------- renderer ----------
  function installRenderer(){
    if(window.__REMOTE_RENDER_INSTALLED__) return;
    window.__REMOTE_RENDER_INSTALLED__ = true;

    IZZA.on('render-post', ({ now })=>{
      try{
        const api = IZZA.api; if(!api || !api.ready) return;
        if(!isMPWorld()) return; // do not render in SOLO

        pruneStale(now);

        const cvs = document.getElementById('game'); if(!cvs) return;
        const ctx = cvs.getContext('2d');
        const S=api.DRAW, scale=S/api.TILE;

        ctx.save(); ctx.imageSmoothingEnabled=false;

        for(const p of REMOTES){
          const snap = sampleBuffered(p, now);
          const sx=(snap.x - api.camera.x)*scale, sy=(snap.y - api.camera.y)*scale;
          const row = DIR_INDEX[snap.facing] || 0;
          const comp = p.composite;

          // If composite is still building, show base body/outfit/hair placeholder via cache miss guard
          if(comp && comp.img){
            const cols = Math.max(1, comp.cols|0);
            const t = Math.floor(now/120)%cols; // walk-ish
            ctx.drawImage(comp.img, t*FRAME_W, row*FRAME_H, FRAME_W, FRAME_H, sx, sy, S, S);
          }else{
            // ultra cheap placeholder rectangle to avoid “invisible player” while images load
            ctx.fillStyle='rgba(80,120,200,0.85)';
            ctx.fillRect(sx, sy, S, S);
          }

          // nameplate
          ctx.fillStyle = 'rgba(8,12,20,.85)';
          ctx.fillRect(sx + S*0.02, sy - S*0.28, S*0.96, S*0.22);
          ctx.fillStyle = '#d9ecff'; ctx.font = (S*0.20)+'px monospace';
          ctx.textAlign='center'; ctx.textBaseline='middle';
          ctx.fillText(p.username||'Opponent', sx + S*0.50, sy - S*0.17, S*0.92);
        }

        ctx.restore();
      }catch(e){}
    });
  }

  // ---------- Modes ----------
  // Multiplayer mode: missions hidden only (keep world population intact)
  function setMultiplayerMode(on){
    try{
      IZZA?.api?.setMultiplayerMode?.(!!on);

      const nodes = document.querySelectorAll(
        '[data-ui="mission-hud"], #missionHud, .mission-hud, .mission-prompt, [data-ui="mission-prompt"]'
      );
      nodes.forEach(n=> n.style.display = on ? 'none' : '');

      window.dispatchEvent(new CustomEvent('izza-missions-toggle', { detail:{ enabled: !on }}));
    }catch{}
  }

  // Duel mode: hide pedestrians & cops; KEEP vehicles visible
  function setDuelMode(on){
    try{
      const hideSel = [
        '.npc', '[data-npc]', '.pedestrian', '[data-role="npc"]',
        '.cop', '[data-cop]', '.police', '.swat', '.military', '[data-role="cop"]'
      ].join(',');

      document.querySelectorAll(hideSel).forEach(n=>{
        if(on){
          if(!n.dataset._oldVis){ n.dataset._oldVis = n.style.visibility || ''; }
          n.style.visibility = 'hidden';
        }else{
          if('_oldVis' in n.dataset){ n.style.visibility = n.dataset._oldVis; delete n.dataset._oldVis; }
          else n.style.visibility = '';
        }
      });

      window.dispatchEvent(new CustomEvent('izza-duel-toggle', { detail:{ on: !!on }}));
    }catch{}
  }

  // ---------- REST presence poll/push ----------
  let lastRosterTs = 0;
  let tickT=null, rosterT=null, heartbeatT=null;

  async function sendHeartbeat(){
    if(!isMPWorld()) return;
    try{
      const me = (IZZA?.api?.player) || {x:0,y:0,facing:'down'};
      await jpost('/world/heartbeat', {
        x: me.x|0, y: me.y|0, facing: me.facing||'down',
        appearance: readAppearance(),
        inv: readInventory()
      });
    }catch(e){}
  }
  async function sendPos(){
    if(!isMPWorld()) return;
    try{
      const me = (IZZA?.api?.player) || {x:0,y:0,facing:'down'};
      await jpost('/world/pos', { x: me.x|0, y: me.y|0, facing: me.facing||'down' });
    }catch(e){}
  }
  async function pullRoster(){
    if(!isMPWorld()) return;
    try{
      const r = await jget('/world/roster?since=' + encodeURIComponent(lastRosterTs||0));
      if(r && r.ok){
        if(Array.isArray(r.players)){
          r.players.forEach(upsertRemote);
        }
        if(typeof r.serverNow==='number') lastRosterTs = r.serverNow;
      }
    }catch(e){}
  }

  function armTimers(){
    disarmTimers();
    if(!isMPWorld()) return;
    heartbeatT = setInterval(sendHeartbeat, 4000);
    tickT      = setInterval(sendPos,      400);   // keep your existing cadence
    rosterT    = setInterval(pullRoster,   800);   // a bit faster for smoother buffers
    sendHeartbeat();
    pullRoster();
  }
  function disarmTimers(){
    if(heartbeatT){ clearInterval(heartbeatT); heartbeatT=null; }
    if(tickT){ clearInterval(tickT); tickT=null; }
    if(rosterT){ clearInterval(rosterT); rosterT=null; }
  }

  // ---------- public bridge ----------
  const localListeners = Object.create(null);
  function listen(type, cb){ (localListeners[type] ||= []).push(cb); }
  function fanout(type, data){ (localListeners[type]||[]).forEach(fn=>{ try{ fn(data); }catch(e){ console.warn(e); } }); }

  const REMOTE_PLAYERS_API = window.REMOTE_PLAYERS_API = window.REMOTE_PLAYERS_API || {
    send(type, data){
      if(type==='join-world'){
        try{ jpost('/world/join', { world: String(data.world||'1') }); }catch{}
        onWorldChanged(String(data.world||'1'));
      }else if(type==='worlds-counts'){
        jget('/worlds/counts').then(j=> fanout('worlds-counts', j||{})).catch(()=>{});
      }else if(type==='players-get'){
        pullRoster();
      }
    },
    on(type, cb){ listen(type, cb); }
  };

  // ---------- world-change handling ----------
  function onWorldChanged(nextWorld){
    clearRemotePlayers();
    if(nextWorld==='solo'){
      disarmTimers();
      setMultiplayerMode(false);
      setDuelMode(false);
      return;
    }
    setMultiplayerMode(true);
    setDuelMode(false);
    lastRosterTs = 0;
    armTimers();
  }

  try{ IZZA?.on?.('world-changed', ({ world })=> onWorldChanged(world)); }catch{}
  window.addEventListener('storage', (ev)=>{
    if (ev.key==='izzaWorldId'){
      onWorldChanged(String(ev.newValue||'solo'));
    }
  });

  // ---------- Duel wiring ----------
  (function wireDuelToggles(){
    try{ IZZA?.on?.('mp-start',  ()=> setDuelMode(true)); }catch{}
    try{ IZZA?.on?.('mp-finish', ()=> setDuelMode(false)); }catch{}
    try{ IZZA?.on?.('duel-round-start',   ()=> setDuelMode(true)); }catch{}
    try{ IZZA?.on?.('duel-match-finish',  ()=> setDuelMode(false)); }catch{}
  })();

  // ---------- renderer + boot ----------
  function installPublicAPI(){
    if(!window.IZZA || !IZZA.api) return;
    IZZA.api.remotePlayers = REMOTES;
    if(!IZZA.api.clearRemotePlayers) IZZA.api.clearRemotePlayers = clearRemotePlayers;
    if(!IZZA.api.getAppearance) IZZA.api.getAppearance = readAppearance;
    // expose snapshot getter used by MP client
    if(!IZZA.api.getInventorySnapshot) IZZA.api.getInventorySnapshot = readInventory;
    IZZA.api.setDuelMode = setDuelMode;
  }

  function boot(){
    installPublicAPI();
    installRenderer();
    onWorldChanged(getWorld());
  }

  if(window.IZZA && IZZA.on){
    IZZA.on('ready', boot);
  }else if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded', boot, { once:true });
  }else{
    boot();
  }
})();
