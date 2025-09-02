/**
 * IZZA Multiplayer Client — v1.1
 * - Server-backed friends & search via Pi-auth session
 * - Prevent game hotkeys (I, B, A) while typing in lobby inputs
 * - Queue + presence + ranks wiring
 *
 * Expected backend:
 *   GET  /api/mp/me
 *   GET  /api/mp/friends/list
 *   GET  /api/mp/friends/search?q=
 *   POST /api/mp/invite               { toUsername }
 *   POST /api/mp/queue                { mode:'br10'|'v1'|'v2'|'v3' }
 *   POST /api/mp/dequeue
 *   GET  /api/mp/ranks
 *   WS   /api/mp/ws
 */
(function(){
  const BUILD='v1.1-mp-client+hotkey-guard';
  console.log('[IZZA PLAY]', BUILD);

  const CFG = {
    base: '/api/mp',
    ws:   '/api/mp/ws',
    searchDebounceMs: 250
  };

  let ws=null, wsReady=false, reconnectT=null, lastQueueMode=null;
  let me=null;          // {username, ranks}
  let friends=[];       // [{username,active}]
  let lobby=null;       // #mpLobby
  let ui = {};          // cached nodes

  const $  = (sel,root=document)=> root.querySelector(sel);
  const $$ = (sel,root=document)=> Array.from(root.querySelectorAll(sel));
  const toast = (t)=> (window.IZZA && IZZA.emit) ? IZZA.emit('toast',{text:t}) : console.log('[TOAST]',t);

  async function jget(path){
    const r = await fetch(CFG.base+path, {credentials:'include'});
    if(!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.json();
  }
  async function jpost(path, body){
    const r = await fetch(CFG.base+path, {
      method:'POST', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify(body||{})
    });
    if(!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.json();
  }
  function debounced(fn, ms){
    let t=null, lastArgs=null;
    return function(...args){
      lastArgs=args; clearTimeout(t);
      t=setTimeout(()=>fn.apply(this,lastArgs), ms);
    };
  }

  // ---------- DATA ----------
  async function loadMe(){ me = await jget('/me'); return me; }
  async function loadFriends(){
    const res = await jget('/friends/list');
    friends = res.friends || [];
    return friends;
  }
  async function searchFriends(q){
    // Server should only return users who have Pi-authed & played before.
    const res = await jget('/friends/search?q='+encodeURIComponent(q||''));
    return res.users || [];
  }

  // ---------- RANKS ----------
  async function refreshRanks(){
    try{
      const res = await jget('/ranks');
      if(res && res.ranks) me.ranks = res.ranks;
      paintRanks();
    }catch(e){ /* non-fatal */ }
  }
  function paintRanks(){
    if(!lobby || !me || !me.ranks) return;
    const set = (id,key)=>{
      const el = $(id,lobby);
      if(!el) return;
      const r = me.ranks[key] || {w:0,l:0};
      const span = $('span', el);
      if(span) span.textContent = `${r.w}W / ${r.l}L`;
    };
    set('#r-br10','br10'); set('#r-v1','v1'); set('#r-v2','v2'); set('#r-v3','v3');
  }

  // ---------- FRIENDS UI ----------
  function paintFriends(list){
    if(!lobby) return;
    const host = $('#mpFriends', lobby);
    if(!host) return;
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
          ${fr.active ? `<button class="mp-small outline" data-join="${fr.username}">Invite to Lobby</button>` : ''}
        </div>
      `;
      $('button[data-invite]',row).addEventListener('click', async ()=>{
        try{ await jpost('/invite', { toUsername: fr.username }); toast('Invite sent to '+fr.username); }
        catch(e){ toast('Invite failed: '+e.message); }
      });
      const joinBtn = $('button[data-join]',row);
      if(joinBtn){
        joinBtn.addEventListener('click', async ()=>{
          try{ await jpost('/invite', { toUsername: fr.username }); toast('Lobby invite sent to '+fr.username); }
          catch(e){ toast('Invite failed: '+e.message); }
        });
      }
      host.appendChild(row);
    });
  }

  function updatePresence(user, active){
    const f = friends.find(x=>x.username===user);
    if(f){ f.active = !!active; }
    if(lobby && lobby.style.display!=='none'){
      const q = $('#mpSearch', lobby)?.value || '';
      const filtered = q ? friends.filter(x=>x.username.toLowerCase().includes(q.toLowerCase())) : friends;
      paintFriends(filtered);
    }
  }

  // ---------- QUEUE ----------
  async function enqueue(mode){
    try{
      lastQueueMode = mode;
      const nice = mode==='br10'?'Battle Royale (10)': mode==='v1'?'1v1': mode==='v2'?'2v2':'3v3';
      if(ui.queueMsg) ui.queueMsg.textContent = `Queued for ${nice}… (waiting for match)`;
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

  // ---------- SOCKET ----------
  function connectWS(){
    try{
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = proto + '//' + location.host + CFG.ws;
      ws = new WebSocket(url);
    }catch(e){
      console.warn('WS failed', e);
      return;
    }

    ws.addEventListener('open', ()=>{ wsReady=true; });
    ws.addEventListener('close', ()=>{
      wsReady=false; ws=null;
      if(reconnectT) clearTimeout(reconnectT);
      reconnectT=setTimeout(connectWS, 1500);
    });
    ws.addEventListener('message', (evt)=>{
      let msg=null; try{ msg=JSON.parse(evt.data); }catch{}
      if(!msg) return;

      if(msg.type==='presence'){
        updatePresence(msg.user, !!msg.active);

      }else if(msg.type==='queue.update' && ui.queueMsg){
        const nice = msg.mode==='br10'?'Battle Royale (10)': msg.mode==='v1'?'1v1': msg.mode==='v2'?'2v2':'3v3';
        const eta = msg.estMs!=null ? ` ~${Math.ceil(msg.estMs/1000)}s` : '';
        ui.queueMsg.textContent = `Queued for ${nice}… (${msg.pos||1} in line${eta})`;

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

  // ---------- HOTKEY GUARD (typing) ----------
  function hotkeyGuard(e){
    // Only stop bubbling when typing inside the lobby (inputs/textareas/contentEditable).
    const target = e.target;
    const insideLobby = !!(target && target.closest && target.closest('#mpLobby'));
    const isEditor = insideLobby && (
      target.tagName==='INPUT' ||
      target.tagName==='TEXTAREA' ||
      target.isContentEditable
    );
    if(!isEditor) return;

    const k = (e.key||'').toLowerCase();
    if(k==='i' || k==='b' || k==='a'){
      // Do NOT preventDefault (so the letter still types). Just stop it reaching game hotkeys.
      e.stopImmediatePropagation();
      e.stopPropagation();
      // Leave default alone.
    }
  }

  // ---------- LOBBY WIRING ----------
  function mountLobby(host){
    lobby = host || document.getElementById('mpLobby');
    if(!lobby) return;

    ui.queueMsg = $('#mpQueueMsg', lobby);

    $$('.mp-btn', lobby).forEach(btn=>{
      btn.onclick = ()=> enqueue(btn.getAttribute('data-mode'));
    });

    $('#mpClose', lobby)?.addEventListener('click', ()=>{ if(lastQueueMode) dequeue(); });

    $('#mpCopyLink', lobby)?.addEventListener('click', async ()=>{
      try{
        const res = await jget('/me');
        const link = (res && res.inviteLink) || (location.origin + '/auth.html?src=invite&from=' + encodeURIComponent(res.username||'player'));
        await navigator.clipboard.writeText(link);
        toast('Invite link copied');
      }catch(e){
        toast('Copy failed; showing link…');
        const link = location.origin + '/auth.html';
        prompt('Copy this invite link:', link);
      }
    });

    const search = $('#mpSearch', lobby);
    if(search){
      const run = debounced(async ()=>{
        const q = search.value.trim();
        if(!q){ paintFriends(friends); return; }
        try{
          const list = await searchFriends(q);
          // list entries are {username, active, friend?}; only show those our backend says exist
          paintFriends(list.map(u=>({username:u.username, active:!!u.active})));
        }catch(e){ /* ignore */ }
      }, CFG.searchDebounceMs);
      search.oninput = run;
    }

    paintRanks();
    paintFriends(friends);
  }

  // Observe when #mpLobby becomes visible to (re)mount
  const obs = new MutationObserver(()=>{
    const h = document.getElementById('mpLobby');
    if(!h) return;
    const visible = h.style.display && h.style.display!=='none';
    if(visible) mountLobby(h);
  });
  function bootObserver(){
    const root = document.body || document.documentElement;
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

      // Global capture to guard hotkeys while typing in lobby inputs
      window.addEventListener('keydown', hotkeyGuard, {capture:true, passive:false});

      const h=document.getElementById('mpLobby');
      if(h && h.style.display && h.style.display!=='none') mountLobby(h);
      console.log('[MP] client ready', {user:me?.username, friends:friends.length});
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
