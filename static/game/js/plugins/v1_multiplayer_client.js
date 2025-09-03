/**
 * IZZA Multiplayer Client — v1.6.6
 * IMPORTANT: appends short-lived token (?t=…) to ALL MP requests.
 */
(function(){
  const BUILD='v1.6.6-mp-client+tokened';
  console.log('[IZZA PLAY]', BUILD);

  const TOK = (window.__IZZA_T__ || '').toString();
  const CFG = {
    base: (window.__MP_BASE__ || '/izza-game/api/mp'),
    ws:   (window.__MP_WS__   || '/izza-game/api/mp/ws'),
    searchDebounceMs: 250,
  };

  // ---- helpers
  const $  = (s,r=document)=> r.querySelector(s);
  const toast = (t)=> (window.IZZA&&IZZA.emit)?IZZA.emit('toast',{text:t}):console.log('[TOAST]',t);
  const withTok = (path)=>{
    if(!TOK) return path; // still works if you happen to have a cookie
    return path + (path.includes('?') ? '&' : '?') + 't=' + encodeURIComponent(TOK);
  };

  let ws=null, reconnectT=null, lastQueueMode=null;
  let me=null, friends=[], lobby=null, ui={};
  let notifTimer=null;

  // ---- network (always include token)
  async function jget(p){
    const r = await fetch(withTok(CFG.base+p), {credentials:'include'});
    if(!r.ok){
      if(r.status===401) toast('Sign-in required. Open Auth in top-left and refresh.');
      throw new Error(`${r.status} ${r.statusText}`);
    }
    return r.json();
  }
  async function jpost(p,b){
    const r = await fetch(withTok(CFG.base+p),{
      method:'POST',
      credentials:'include',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(b||{})
    });
    if(!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.json();
  }
  const debounced=(fn,ms)=>{ let t=null,a=null; return (...args)=>{a=args; clearTimeout(t); t=setTimeout(()=>fn(...a),ms);}};

  async function loadMe(){ me = await jget('/me'); return me; }
  async function loadFriends(){ const res=await jget('/friends/list'); friends=res.friends||[]; return friends; }
  async function searchPlayers(q){ const res=await jget('/players/search?q='+encodeURIComponent(q||'')); return res.users||[]; }

  // ---- ranks paint (no change)
  async function refreshRanks(){ try{ const r=await jget('/ranks'); if(r&&r.ranks) me.ranks=r.ranks; paintRanks(); }catch{} }
  function paintRanks(){
    if(!lobby || !me || !me.ranks) return;
    const set=(id,key)=>{ const el=$(id,lobby); if(!el) return; const r=me.ranks[key]||{w:0,l:0}; const sp=el.querySelector('span'); if(sp) sp.textContent=`${r.w}W / ${r.l}L`; };
    set('#r-br10','br10'); set('#r-v1','v1'); set('#r-v2','v2'); set('#r-v3','v3');
  }

  // ---- rows + paint
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

  // ---- queue
  async function enqueue(mode){
    try{
      lastQueueMode=mode;
      const nice= mode==='br10'?'Battle Royale (10)': mode==='v1'?'1v1': mode==='v2'?'2v2':'3v3';
      if(ui.queueMsg) ui.queueMsg.textContent=`Queued for ${nice}… (waiting for match)`;
      await jpost('/queue',{mode});
    }catch(e){ if(ui.queueMsg) ui.queueMsg.textContent=''; toast('Queue error: '+e.message); }
  }
  async function dequeue(){ try{ await jpost('/dequeue'); }catch{} if(ui.queueMsg) ui.queueMsg.textContent=''; lastQueueMode=null; }

  // ---- websocket (token on querystring so the server can verify)
  function connectWS(){
    try{
      const proto = location.protocol==='https:'?'wss:':'ws:';
      let url = proto+'//'+location.host+CFG.ws;
      if(TOK) url += (url.includes('?')?'&':'?') + 't=' + encodeURIComponent(TOK);
      ws=new WebSocket(url);
    }catch(e){ console.warn('WS failed', e); return; }
    ws.addEventListener('close', ()=>{ ws=null; if(reconnectT) clearTimeout(reconnectT); reconnectT=setTimeout(connectWS,1500); });
    ws.addEventListener('message',(evt)=>{
      let msg=null; try{ msg=JSON.parse(evt.data);}catch{}
      if(!msg) return;
      if(msg.type==='match.found'){
        if(ui.queueMsg) ui.queueMsg.textContent=''; if(lobby) lobby.style.display='none';
        window.IZZA?.emit?.('mp-start',msg); toast('Match found! Starting…');
      }
    });
  }

  // ---- lobby mount + search wiring
  function mountLobby(host){
    lobby = host || document.getElementById('mpLobby');
    if(!lobby) return;
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

    const doSearch = async (immediate=false)=>{
      const q=(ui.search?.value||'').trim();
      if(!q){
        paintFriends(friends);
        ui.searchStatus && (ui.searchStatus.textContent='Type a name and press Search or Return');
        return;
      }
      if(!immediate && q.length<2){ ui.searchStatus && (ui.searchStatus.textContent='Type at least 2 characters'); return; }
      ui.searchStatus && (ui.searchStatus.textContent='Searching…');
      try{
        const list = await searchPlayers(q);
        const host = lobby.querySelector('#mpFriends');
        host.innerHTML='';
        list.forEach(u=> host.appendChild(makeRow(u)));
        ui.searchStatus && (ui.searchStatus.textContent = list.length ? `Found ${list.length} result${list.length===1?'':'s'}` : 'No players found');
        if(!list.length){
          const none=document.createElement('div');
          none.className='friend';
          none.innerHTML=`
            <div>
              <div>${q}</div>
              <div class="meta">Player not found — Invite user to join IZZA GAME</div>
            </div>
            <button class="mp-small">Copy Invite</button>`;
          none.querySelector('button')?.addEventListener('click', async ()=>{
            const res = await jget('/me').catch(()=>({username:'player'}));
            const link = location.origin + '/izza-game/auth?src=invite&from=' + encodeURIComponent(res.username||'player');
            try{ await navigator.clipboard.writeText(link); toast('Invite link copied'); }
            catch{ prompt('Copy link:', link); }
          });
          host.appendChild(none);
        }
      }catch(err){
        ui.searchStatus && (ui.searchStatus.textContent=`Search failed: ${err.message}`);
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
  }

  const obs = new MutationObserver(()=>{
    const h=document.getElementById('mpLobby'); if(!h) return;
    const visible = h.style.display && h.style.display!=='none';
    if(visible) mountLobby(h);
  });
  const root=document.body||document.documentElement;
  if(root) obs.observe(root,{subtree:true, attributes:true, childList:true, attributeFilter:['style']});

  async function start(){
    try{
      await loadMe();        // now authed because ?t=… is attached
      await loadFriends();
      refreshRanks();
      connectWS();

      const pull=async()=>{ try{ await jget('/notifications'); }catch{} };
      pull(); notifTimer=setInterval(pull, 5000);

      const h=document.getElementById('mpLobby');
      if(h && h.style.display && h.style.display!=='none') mountLobby(h);

      console.log('[MP] client ready', {user:me?.username, friends:friends.length});
    }catch(e){
      console.error('MP client start failed', e);
      toast('Multiplayer unavailable: '+e.message);
    }
  }
  if(document.readyState==='complete' || document.readyState==='interactive') start();
  else addEventListener('DOMContentLoaded', start, {once:true});
})();
