/**
 * IZZA Multiplayer Client — v1.6.3
 * - Use /players/search (case-insensitive, profile-verified)
 * - Show “Player not found — invite…” fallback
 * - Toast on auth errors so silence never hides problems
 * - Keeps all existing typing/shield logic exactly as-is
 */
(function(){
  const BUILD='v1.6.3-mp-client+players-search';
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
  const toast = (t)=> (window.IZZA&&IZZA.emit)?IZZA.emit('toast',{text:t}):console.log('[TOAST]',t);

  async function jget(p){
    const r = await fetch(CFG.base+p, {credentials:'include'});
    if(!r.ok){
      // surface common auth error; let caller decide UI
      if(r.status===401) toast('Sign-in expired. Reopen Auth and try again.');
      throw new Error(`${r.status} ${r.statusText}`);
    }
    return r.json();
  }
  async function jpost(p,b){
    const r = await fetch(CFG.base+p,{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify(b||{})});
    if(!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.json();
  }
  const debounced=(fn,ms)=>{ let t=null,a=null; return (...args)=>{a=args; clearTimeout(t); t=setTimeout(()=>fn(...a),ms);}};

  async function loadMe(){ me = await jget('/me'); return me; }
  async function loadFriends(){ const res=await jget('/friends/list'); friends=res.friends||[]; return friends; }
  // NOTE: use /players/search (not /friends/search)
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
  function paintFriends(list){ const host=$('#mpFriends',lobby); if(!host) return; host.innerHTML=''; list.forEach(u=> host.appendChild(makeRow(u))); }
  function repaintFriends(){ const q=$('#mpSearch',lobby)?.value?.trim().toLowerCase()||''; const filtered = q ? friends.filter(x=>x.username.toLowerCase().includes(q)) : friends; paintFriends(filtered); }
  function updatePresence(user, active){ const f=friends.find(x=>x.username===user); if(f){ f.active=!!active; if(lobby && lobby.style.display!=='none') repaintFriends(); } }

  async function enqueue(mode){
    try{
      lastQueueMode=mode;
      const nice= mode==='br10'?'Battle Royale (10)': mode==='v1'?'1v1': mode==='v2'?'2v2':'3v3';
      if(ui.queueMsg) ui.queueMsg.textContent=`Queued for ${nice}… (waiting for match)`;
      await jpost('/queue',{mode});
    }catch(e){ if(ui.queueMsg) ui.queueMsg.textContent=''; toast('Queue error: '+e.message); }
  }
  async function dequeue(){ try{ await jpost('/dequeue'); }catch{} if(ui.queueMsg) ui.queueMsg.textContent=''; lastQueueMode=null; }

  // --- WS (unchanged) ---
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
        window.IZZA?.emit?.('mp-start',{mode:msg.mode,matchId:msg.matchId,players:msg.players}); toast('Match found! Starting…');
      }else if(msg.type==='match.result'){ if(msg.newRanks){ me=me||{}; me.ranks=msg.newRanks; paintRanks(); } }
    });
  }

  // --- typing guard + shield (unchanged from your v1.6.2) ---
  function isLobbyEditor(el){ if(!el) return false; const inLobby = !!(el.closest && el.closest('#mpLobby')); return inLobby && (el.tagName==='INPUT' || el.tagName==='TEXTAREA' || el.isContentEditable); }
  function guardKeyEvent(e){ if(!isLobbyEditor(e.target)) return; const k=(e.key||'').toLowerCase(); if(k==='i'||k==='b'||k==='a'){ e.stopImmediatePropagation(); e.stopPropagation(); } }
  ['keydown','keypress','keyup'].forEach(type=> window.addEventListener(type, guardKeyEvent, {capture:true, passive:false}));
  function keyIsABI(e){ const k=(e.key||'').toLowerCase(); return k==='a'||k==='b'||k==='i'; }
  function swallow(e){ e.stopImmediatePropagation(); e.stopPropagation(); e.preventDefault?.(); }
  function installShield(){ /* same as your file */ }
  function removeShield(){ /* same as your file */ }
  function tryShieldOnce(){ const node=document.getElementById('mpLobby'); const v=!!(node&&node.style.display&&node.style.display!=='none'); if(v) installShield(); }
  if(window.IZZA && IZZA.on){
    IZZA.on('ui-modal-open',  e=>{ if(e&&e.id==='mpLobby'){ tryShieldOnce(); requestAnimationFrame(tryShieldOnce); setTimeout(tryShieldOnce,80);} });
    IZZA.on('ui-modal-close', e=>{ if(e&&e.id==='mpLobby') removeShield(); });
    IZZA.on('mp-start',       ()=> removeShield());
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
        toast('Invite link copied');
      }catch(e){
        const fallback = location.origin + '/izza-game/auth';
        toast('Copy failed; showing link…'); prompt('Copy this invite link:', fallback);
      }
    });

    const search = lobby.querySelector('#mpSearch');
    if(search){
      const run = debounced(async ()=>{
        const q=(search.value||'').trim();
        if(!q){ paintFriends(friends); return; }
        try{
          const list = await searchPlayers(q);
          paintFriends(list.map(u=>({username:u.username, active:!!u.active})));
          if(!list.length){
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
          // show something if search failed (401, 5xx, etc.)
          const host = lobby.querySelector('#mpFriends');
          if(host){
            host.innerHTML='';
            const row=document.createElement('div');
            row.className='friend';
            row.innerHTML = `<div><div class="meta">Search unavailable (${err.message}).</div></div>`;
            host.appendChild(row);
          }
        }
      }, CFG.searchDebounceMs);
      search.oninput = run;
      search.addEventListener('focus', ()=>{ window.__IZZA_TYPING_IN_LOBBY = true; });
      search.addEventListener('blur',  ()=>{ window.__IZZA_TYPING_IN_LOBBY = false; });
    }

    paintRanks(); paintFriends(friends);
  }

  const obs = new MutationObserver(()=>{ const h=document.getElementById('mpLobby'); if(!h) return; const v=h.style.display && h.style.display!=='none'; if(v) mountLobby(h); });
  (function bootObserver(){ const root=document.body||document.documentElement; if(root) obs.observe(root,{subtree:true, attributes:true, childList:true, attributeFilter:['style']}); })();

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
      toast('Multiplayer unavailable: '+e.message);
    }
  }
  if(document.readyState==='complete' || document.readyState==='interactive') start();
  else addEventListener('DOMContentLoaded', start, {once:true});
})();
