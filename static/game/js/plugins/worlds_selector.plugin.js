// worlds_selector.plugin.js — Worlds switcher + remote players + 1v1 invite (client-only)
// Safe: no changes to existing code; uses event bus if present (RemotePlayers/IZZA).
(function(){
  const BUILD='worlds-selector/v1.1';
  console.log('[IZZA PLAY]', BUILD);

  // ---- MP adapter (works with your existing buses) ----
  const MP = {
    send(type, data){
      try{
        if (window.REMOTE_PLAYERS_API?.send) return REMOTE_PLAYERS_API.send(type, data);
        if (window.RemotePlayers?.send)      return RemotePlayers.send(type, data);
        if (window.IZZA?.emit)               return IZZA.emit('mp-send', {type, data});
      }catch(e){ console.warn('[WORLDS] send fail', e); }
    },
    on(type, cb){
      try{
        if (window.REMOTE_PLAYERS_API?.on) return REMOTE_PLAYERS_API.on(type, cb);
        if (window.RemotePlayers?.on)      return RemotePlayers.on(type, cb);
        if (window.IZZA?.on)               return IZZA.on('mp-'+type, (_,{data})=>cb(data));
      }catch(e){ console.warn('[WORLDS] on fail', e); }
    },
    joinWorld(worldId){
      // inform server/bus we’re switching rooms
      MP.send('join-world', { world: String(worldId) });
    },
    askCounts(){
      MP.send('worlds-counts', {}); // server/bus should reply with {counts:{1:n,2:n,3:n,4:n}}
    }
  };

  // ---- World state ----
  function getWorld(){ return localStorage.getItem('izzaWorldId') || '1'; }
  function setWorld(id){ localStorage.setItem('izzaWorldId', String(id||'1')); }

  // ---- UI: add "Worlds" button beneath Friends (or next to it if not stacked) ----
  function ensureWorldsButton(){
    const bar = document.getElementById('gameCard')?.parentElement || document.body;
    if (!bar) return;

    // Try to position near "Friends" if we can find it
    const friendsBtn = document.querySelector('#btnFriends,[data-ui="btn-friends"],button:contains("Friends")');

    if (document.getElementById('btnWorlds')) return;

    const btn = document.createElement('button');
    btn.id = 'btnWorlds';
    btn.textContent = 'Worlds';
    Object.assign(btn.style, {
      background:'#1a2540', color:'#cfe0ff', border:'1px solid #2a3550',
      borderRadius:'8px', padding:'8px 10px', marginLeft:'6px', fontWeight:'700', zIndex:7
    });

    if (friendsBtn && friendsBtn.parentElement){
      friendsBtn.parentElement.appendChild(btn);
    } else {
      // fallback: under the chat bar / HUD
      (document.getElementById('chatBar') || bar).appendChild(btn);
    }
    btn.addEventListener('click', openWorldsModal, {passive:true});
  }

  // ---- Worlds modal ----
  let counts = {1:0,2:0,3:0,4:0}, pollTimer=null;
  function openWorldsModal(){
    const cur = getWorld();
    const hostId='worldsModal';
    let m = document.getElementById(hostId);
    if(!m){
      m = document.createElement('div'); m.id=hostId;
      Object.assign(m.style, {position:'fixed', inset:'0', display:'flex', alignItems:'center', justifyContent:'center', zIndex:60, background:'rgba(0,0,0,.45)'});
      m.innerHTML = `
        <div style="background:#0b0f17;border:1px solid #2a3550;border-radius:14px;padding:14px 16px;color:#dbe6ff;min-width:280px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
            <div style="font-weight:800">Choose World</div>
            <button id="worldsClose" style="background:#1a2540;color:#cfe0ff;border:1px solid #2a3550;border-radius:8px;padding:4px 8px">Close</button>
          </div>
          <div id="worldGrid" style="display:grid;grid-template-columns:1fr 1fr;gap:10px"></div>
          <div style="opacity:.8;font-size:12px;margin-top:8px">You are in <b>World ${cur}</b>. Players shown are active now.</div>
        </div>`;
      document.body.appendChild(m);
      m.querySelector('#worldsClose').onclick = ()=> closeWorldsModal();
    }
    renderWorldCards(); m.style.display='flex';

    // start counts polling while open
    if(!pollTimer){ pollTimer = setInterval(()=> MP.askCounts(), 3000); }
    MP.askCounts();
  }
  function closeWorldsModal(){
    const m = document.getElementById('worldsModal'); if(m) m.style.display='none';
    if(pollTimer){ clearInterval(pollTimer); pollTimer=null; }
  }
  function renderWorldCards(){
    const grid = document.getElementById('worldGrid'); if(!grid) return;
    const cur = getWorld();
    grid.innerHTML='';
    [1,2,3,4].forEach(n=>{
      const card = document.createElement('button');
      card.setAttribute('data-world', String(n));
      const selected = (String(n)===String(cur));
      card.innerHTML = `
        <div style="font-weight:800">WORLD ${n}</div>
        <div style="opacity:.85;font-size:12px;margin-top:4px">Players: <b>${counts[n]||0}</b></div>
        ${selected? '<div style="margin-top:6px;font-size:12px;opacity:.85">Current</div>':''}
      `;
      Object.assign(card.style, {
        textAlign:'left', background: selected?'#1f2d4f':'#0e1626',
        color:'#cfe0ff', border:'1px solid #2a3550', borderRadius:'10px',
        padding:'10px 12px'
      });
      card.onclick = ()=> switchWorld(String(n));
      grid.appendChild(card);
    });
  }

  // ---- Switch world (client-only; your MP hub/server should segregate rooms by world) ----
  function switchWorld(newWorld){
    const old = getWorld();
    if(String(old)===String(newWorld)){ closeWorldsModal(); return; }
    setWorld(newWorld);
    MP.joinWorld(newWorld);
    // reset / redraw remote players via your core API if exposed
    try{ IZZA?.api?.clearRemotePlayers?.(); }catch{}
    try{ IZZA?.toast?.(`Joined World ${newWorld}`); }catch{}
    closeWorldsModal();

    // inform chat plugin so it scopes to world
    try{ window.dispatchEvent(new Event('izza-world-changed')); }catch{}
  }

  // ---- Receive live counts from bus ----
  MP.on('worlds-counts', (payload)=>{
    if(payload && payload.counts){
      counts = Object.assign({1:0,2:0,3:0,4:0}, payload.counts);
      renderWorldCards();
    }
  });

  // ---- Proximity 1v1 invite with “B” ----
  // Requirements:
  //  • Your MP layer must expose the list of visible remote players (or fire mp-players event)
  //  • We’ll request a duel invite handshake and, when both “Ready”, emit mp-start (your Duel client already listens)
  let NEAR = null;
  function nearestPlayerWithin(px,py,maxDist=42){
    const list = (IZZA?.api?.remotePlayers)||[];
    let best=null, bestD=maxDist+1;
    for(const p of list){
      const d = Math.hypot((p.x|0)-(px|0),(p.y|0)-(py|0));
      if(d<bestD){ best=p; bestD=d; }
    }
    return bestD<=maxDist? best : null;
  }

  function showDuelSheet(target){
    const id='duelMiniSheet';
    let m=document.getElementById(id);
    if(!m){
      m=document.createElement('div'); m.id=id;
      Object.assign(m.style,{position:'fixed',left:'50%',top:'50%',transform:'translate(-50%,-50%)',
        background:'#0b0f17',border:'1px solid #2a3550',borderRadius:'12px',padding:'12px',zIndex:58,color:'#e4efff',minWidth:'260px'});
      m.innerHTML=`
        <div style="font-weight:800;margin-bottom:6px">1v1 Duel</div>
        <div id="duelTarget" style="opacity:.85;margin-bottom:8px"></div>
        <div style="display:flex;gap:8px">
          <button id="duelReady" style="flex:1;background:#2ea043;color:#fff;border:0;border-radius:8px;padding:8px 10px;font-weight:800">Ready</button>
          <button id="duelCancel" style="background:#1a2540;color:#cfe0ff;border:1px solid #2a3550;border-radius:8px;padding:8px 10px">Cancel</button>
        </div>`;
      document.body.appendChild(m);
      m.querySelector('#duelCancel').onclick = ()=> m.remove();
      m.querySelector('#duelReady').onclick = ()=> {
        MP.send('duel-invite', { to: target.username, world: getWorld() });
        m.querySelector('#duelReady').disabled = true;
        m.querySelector('#duelReady').textContent = 'Waiting…';
      };
    }
    m.querySelector('#duelTarget').textContent = `Challenging @${target.username}`;
  }

  // When both sides agree, server should broadcast a duel-start payload.
  // We then emit the standard event your PvP client already handles.
  MP.on('duel-start', (payload)=>{
    // payload: { matchId, players:[{username}, {username}], roundsToWin? }
    try{ IZZA?.emit?.('mp-start', Object.assign({mode:'v1'}, payload)); }catch{}
  });

  // Invite pop (from other player)
  MP.on('duel-invite', (m)=>{
    if(!m || String(m.world)!==String(getWorld())) return;
    const id='duelIncoming';
    let d=document.getElementById(id);
    if(!d){
      d=document.createElement('div'); d.id=id;
      Object.assign(d.style,{position:'fixed',left:'50%',top:'50%',transform:'translate(-50%,-50%)',
        background:'#0b0f17',border:'1px solid #2a3550',borderRadius:'12px',padding:'12px',zIndex:58,color:'#e4efff',minWidth:'260px'});
      d.innerHTML=`
        <div style="font-weight:800;margin-bottom:6px">Incoming 1v1</div>
        <div style="opacity:.85;margin-bottom:8px">from @<span id="duelFrom"></span></div>
        <div style="display:flex;gap:8px">
          <button id="duelAccept" style="flex:1;background:#2ea043;color:#fff;border:0;border-radius:8px;padding:8px 10px;font-weight:800">Accept</button>
          <button id="duelDecline" style="background:#1a2540;color:#cfe0ff;border:1px solid #2a3550;border-radius:8px;padding:8px 10px">Decline</button>
        </div>`;
      document.body.appendChild(d);
      d.querySelector('#duelDecline').onclick = ()=> d.remove();
      d.querySelector('#duelAccept').onclick = ()=>{
        MP.send('duel-accept', { from: m.from, world: getWorld() }); d.remove();
      };
    }
    d.querySelector('#duelFrom').textContent = m.from || 'player';
  });

  // Key “B” → open mini 1v1 sheet if near a player
  window.addEventListener('keydown', (e)=>{
    if((e.key||'').toLowerCase()!=='b') return;
    try{
      if(!IZZA?.api?.ready) return;
      const me = IZZA.api.player || {x:0,y:0};
      const near = nearestPlayerWithin(me.x, me.y, 38);
      if(near){ NEAR=near; showDuelSheet(near); }
    }catch{}
  }, {capture:true, passive:true});

  // ---- Boot: join last world & add button when DOM/IZZA ready ----
  function boot(){
    ensureWorldsButton();
    MP.joinWorld(getWorld());
  }
  if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded', boot, {once:true});
  }else{
    boot();
  }
})();
