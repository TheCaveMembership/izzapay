/**
 * IZZA Multiplayer Client — v1.6.2
 * - Shield only if modal is actually visible (with short retry)
 * - Auto-unstick: if shield exists but modal isn’t visible, remove it
 * - Everything else unchanged (typing guard, friends, search, queue)
 */
(function(){
  const BUILD='v1.6.2-mp-client+shield-safe';
  console.log('[IZZA PLAY]', BUILD);

  const CFG = {
    base: (window.__MP_BASE__ || '/izza-game/api/mp'),
    ws:   (window.__MP_WS__   || '/izza-game/api/mp/ws'),
    searchDebounceMs: 250,
    notifPollMs: 5000,
    minChars: 2
  };

  let ws=null, wsReady=false, reconnectT=null, lastQueueMode=null;
  let me=null, friends=[], lobby=null, ui={};
  let notifTimer=null;

  let lobbyOpen=false, shield=null, hudEls=[], hudCssPrev=[];
  const $  = (s,r=document)=> r.querySelector(s);

  async function jget(p){ const r=await fetch(CFG.base+p,{credentials:'include'}); if(!r.ok) throw new Error(`${r.status} ${r.statusText}`); return r.json(); }
  async function jpost(p,b){ const r=await fetch(CFG.base+p,{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify(b||{})}); if(!r.ok) throw new Error(`${r.status} ${r.statusText}`); return r.json(); }
  const debounced=(fn,ms)=>{ let t=null,a=null; return (...args)=>{a=args; clearTimeout(t); t=setTimeout(()=>fn(...a),ms);}};

  async function loadMe(){ me = await jget('/me'); return me; }
  async function loadFriends(){ const res=await jget('/friends/list'); friends=res.friends||[]; return friends; }
  async function searchFriends(q){ const res=await jget('/friends/search?q='+encodeURIComponent(q||'')); return res.users||[]; }
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
      try{ await jpost('/lobby/invite',{toUsername:u.username}); (window.IZZA&&IZZA.emit)?IZZA.emit('toast',{text:'Invite sent to '+u.username}):console.log('Invite sent'); }catch(e){ (window.IZZA&&IZZA.emit)?IZZA.emit('toast',{text:'Invite failed: '+e.message}):console.warn(e); }
    });
    row.querySelector('button[data-join]')?.addEventListener('click', async ()=>{
      try{ await jpost('/lobby/invite',{toUsername:u.username}); (window.IZZA&&IZZA.emit)?IZZA.emit('toast',{text:'Lobby invite sent to '+u.username}):console.log('Lobby invite sent'); }catch(e){ (window.IZZA&&IZZA.emit)?IZZA.emit('toast',{text:'Invite failed: '+e.message}):console.warn(e); }
    });
    return row;
  }
  function paintFriends(list){ const host=$('#mpFriends',lobby); if(!host) return; host.innerHTML=''; list.forEach(u=> host.appendChild(makeRow(u))); }
  function repaintFriends(){ const q=$('#mpSearch',lobby)?.value?.trim().toLowerCase()||''; const filtered = q ? friends.filter(x=>x.username.toLowerCase().includes(q)) : friends; paintFriends(filtered); }
  function updatePresence(user, active){ const f=friends.find(x=>x.username===user); if(f){ f.active=!!active; if(lobby && lobby.style.display!=='none') repaintFriends(); } }

  async function enqueue(mode){
    try{
      lastQueueMode=mode;
      const nice= mode==='br10'?'Battle Royale (10)': mode==='v1'?'1v1': mode==='v2'?'2v2':'3v3';
      if(ui.queueMsg) ui.queueMsg.textContent=`Queued for ${nice}… (waiting for match)`;
      await jpost('/queue',{mode});
    }catch(e){ if(ui.queueMsg) ui.queueMsg.textContent=''; (window.IZZA&&IZZA.emit)?IZZA.emit('toast',{text:'Queue error: '+e.message}):console.warn(e); }
  }
  async function dequeue(){ try{ await jpost('/dequeue'); }catch{} if(ui.queueMsg) ui.queueMsg.textContent=''; lastQueueMode=null; }

  function connectWS(){
    try{
      const proto = location.protocol==='https:'?'wss:':'ws:'; const url = proto+'//'+location.host+CFG.ws;
      ws=new WebSocket(url);
    }catch(e){ console.warn('WS failed', e); return; }
    ws.addEventListener('open', ()=>{ wsReady=true; });
    ws.addEventListener('close', ()=>{ wsReady=false; ws=null; if(reconnectT) clearTimeout(reconnectT); reconnectT=setTimeout(connectWS,1500); });
    ws.addEventListener('message',(evt)=>{
      let msg=null; try{ msg=JSON.parse(evt.data);}catch{}
      if(!msg) return;
      if(msg.type==='presence'){ updatePresence(msg.user, !!msg.active); }
      else if(msg.type==='queue.update' && ui.queueMsg){
        const nice= msg.mode==='br10'?'Battle Royale (10)': msg.mode==='v1'?'1v1': msg.mode==='v2'?'2v2':'3v3';
        const eta= msg.estMs!=null?` ~${Math.ceil(msg.estMs/1000)}s`:''; ui.queueMsg.textContent=`Queued for ${nice}… (${msg.pos||1} in line${eta})`;
      }else if(msg.type==='match.found'){
        if(ui.queueMsg) ui.queueMsg.textContent=''; if(lobby) lobby.style.display='none';
        window.IZZA?.emit?.('mp-start',{mode:msg.mode,matchId:msg.matchId,players:msg.players}); (window.IZZA&&IZZA.emit)?IZZA.emit('toast',{text:'Match found! Starting…'}):console.log('Match found');
      }else if(msg.type==='match.result'){ if(msg.newRanks){ me=me||{}; me.ranks=msg.newRanks; paintRanks(); } }
    });
  }

  // typing guard (unchanged)
  function isLobbyEditor(el){ if(!el) return false; const inLobby = !!(el.closest && el.closest('#mpLobby')); return inLobby && (el.tagName==='INPUT' || el.tagName==='TEXTAREA' || el.isContentEditable); }
  function guardKeyEvent(e){ if(!isLobbyEditor(e.target)) return; const k=(e.key||'').toLowerCase(); if(k==='i'||k==='b'||k==='a'){ e.stopImmediatePropagation(); e.stopPropagation(); } }
  ['keydown','keypress','keyup'].forEach(type=> window.addEventListener(type, guardKeyEvent, {capture:true, passive:false}));

  // shield helpers
  function keyIsABI(e){ const k=(e.key||'').toLowerCase(); return k==='a'||k==='b'||k==='i'; }
  function swallow(e){ e.stopImmediatePropagation(); e.stopPropagation(); e.preventDefault?.(); }

  function installShield(){
    if(lobbyOpen) return; lobbyOpen=true;

    // disable HUD buttons + swallow
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

    // global ABI kill switch
    installShield._key = (ev)=>{ if(lobbyOpen && keyIsABI(ev)) swallow(ev); };
    ['keydown','keypress','keyup'].forEach(t=> window.addEventListener(t, installShield._key, {capture:true}));

    // transparent overlay to grab stray taps
    shield=document.createElement('div');
    Object.assign(shield.style,{position:'fixed', inset:'0', zIndex:1002, background:'transparent', touchAction:'none'});
    document.body.appendChild(shield);

    // safety: if modal somehow not visible, auto-remove after a moment
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

  // only install shield if modal is visible; retry briefly
  function tryShieldOnce(){
    const node=document.getElementById('mpLobby');
    const visible = !!(node && node.style.display && node.style.display!=='none');
    if(visible) installShield();
  }

  // wire to building events
  if(window.IZZA && IZZA.on){
    IZZA.on('ui-modal-open',  function(e){
      if(e && e.id==='mpLobby'){
        // check now, then check next frame (paint), then a short retry
        tryShieldOnce();
        requestAnimationFrame(tryShieldOnce);
        setTimeout(tryShieldOnce, 80);
      }
    });
    IZZA.on('ui-modal-close', function(e){ if(e && e.id==='mpLobby') removeShield(); });
    IZZA.on('mp-start',       function(){ removeShield(); });
  }

  function mountLobby(host){
    lobby = host || document.getElementById('mpLobby');
    if(!lobby) return;
    ui.queueMsg = lobby.querySelector('#mpQueueMsg');

    lobby.querySelectorAll('.mp-btn').forEach(btn=> btn.onclick=()=> enqueue(btn.getAttribute('data-mode')));
    lobby.querySelector('#mpClose')?.addEventListener('click', ()=>{ if(lastQueueMode) dequeue(); });

    lobby.querySelector('#mpCopyLink')?.addEventListener('click', async ()=>{
      try{
        const res = await jget('/me');
        const link = (res && res.inviteLink) || (location.origin + '/izza-game/auth?src=invite&from=' + encodeURIComponent(res.username||'player'));
        await navigator.clipboard.writeText(link);
        (window.IZZA&&IZZA.emit)?IZZA.emit('toast',{text:'Invite link copied'}):console.log('Invite link copied');
      }catch(e){
        const fallback = location.origin + '/izza-game/auth';
        (window.IZZA&&IZZA.emit)?IZZA.emit('toast',{text:'Copy failed; showing link…'}):console.warn('Copy failed');
        prompt('Copy this invite link:', fallback);
      }
    });

    const search = lobby.querySelector('#mpSearch');
    if(search){
      const run = debounced(async ()=>{
        const q = (search.value||'').trim();
        if(!q){ paintFriends(friends); return; }
        try{
          const list = await searchFriends(q);
          paintFriends(list.map(u=>({username:u.username, active:!!u.active})));
          if(!list.length){
            // friendly "player not found" fallback row:
            const host = lobby.querySelector('#mpFriends');
            if(host){
              const none=document.createElement('div');
              none.className='friend';
              none.innerHTML = `
                <div>
                  <div>${q}</div>
                  <div class="meta">Player not found — invite to join IZZA GAME?</div>
                </div>
                <button class="mp-small">Copy Invite</button>`;
              none.querySelector('button')?.addEventListener('click', async ()=>{
                const link = location.origin + '/izza-game/auth?src=invite&from=' + encodeURIComponent(me?.username||'player');
                try{ await navigator.clipboard.writeText(link); (window.IZZA&&IZZA.emit)?IZZA.emit('toast',{text:'Invite link copied'}):0; }
                catch{ prompt('Copy link:', link); }
              });
              host.appendChild(none);
            }
          }
        }catch{}
      }, CFG.searchDebounceMs);
      search.oninput = run;
      search.addEventListener('focus', ()=>{ window.__IZZA_TYPING_IN_LOBBY = true; });
      search.addEventListener('blur',  ()=>{ window.__IZZA_TYPING_IN_LOBBY = false; });
    }

    paintRanks(); paintFriends(friends);
  }

  // observe visibility to mount once shown
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
      connectWS();

      const pull=async()=>{ try{ await jget('/notifications'); }catch{} };
      pull(); notifTimer=setInterval(pull, CFG.notifPollMs);

      const h=document.getElementById('mpLobby');
      if(h && h.style.display && h.style.display!=='none') mountLobby(h);

      console.log('[MP] client ready', {user:me?.username, friends:friends.length, ws:!!ws});
    }catch(e){
      console.error('MP client start failed', e);
      (window.IZZA&&IZZA.emit)?IZZA.emit('toast',{text:'Multiplayer unavailable: '+e.message}):0;
    }
  }
  if(document.readyState==='complete' || document.readyState==='interactive') start();
  else addEventListener('DOMContentLoaded', start, {once:true});
})();
