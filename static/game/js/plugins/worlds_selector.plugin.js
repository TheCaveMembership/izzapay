// worlds_selector.plugin.js — Worlds switcher + remote players + 1v1 invite (client-only)
(function(){
  const BUILD='worlds-selector/v1.3';
  console.log('[IZZA PLAY]', BUILD);

  // ---- MP adapter ----
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
    joinWorld(worldId){ MP.send('join-world', { world: String(worldId) }); },
    askCounts(){ MP.send('worlds-counts', {}); }
  };

  // ---- World state ----
  const getWorld = ()=> localStorage.getItem('izzaWorldId') || '1';
  const setWorld = id => localStorage.setItem('izzaWorldId', String(id||'1'));

  // ---- Helpers: Friends button + FIRE hide/show ----
  function findFriendsEl(){
    const nodes = document.querySelectorAll('button,.btn,.pill,[role="button"]');
    for (const el of nodes){
      const t = (el.textContent||'').trim().toLowerCase();
      if (t === 'friends') return el;
    }
    return document.querySelector('#btnFriends,[data-ui="btn-friends"]');
  }

  function fireEls(){
    // common hooks + fallback by visible text "FIRE"
    const all = [
      ...document.querySelectorAll('#btnFire,[data-ui="btn-fire"],button,.btn,[role="button"]')
    ];
    return all.filter(el => ((el.textContent||'').trim().toLowerCase() === 'fire'));
  }
  function hideFire(on=true){
    const els = fireEls();
    for (const el of els){
      if (on){
        if (!el.dataset._oldDisplay) el.dataset._oldDisplay = el.style.display || '';
        el.style.display = 'none';
      } else {
        el.style.display = el.dataset._oldDisplay || '';
        delete el.dataset._oldDisplay;
      }
    }
  }

  // ---- UI: add "Worlds" button beside Friends ----
  function mountWorldsButton(){
    if (document.getElementById('btnWorlds')) return true;
    const friendsBtn = findFriendsEl();
    if (!friendsBtn) return false;

    const btn = document.createElement('button');
    btn.id = 'btnWorlds';
    btn.type = 'button';
    btn.textContent = 'Worlds';
    if (friendsBtn.className) btn.className = friendsBtn.className;
    btn.style.marginLeft = '8px';
    friendsBtn.insertAdjacentElement('afterend', btn);
    btn.addEventListener('click', openWorldsModal, { passive:true });

    console.log('[WORLDS] button mounted next to Friends');
    return true;
  }
  function ensureWorldsButton(){
    if (mountWorldsButton()) return;
    const mo = new MutationObserver(()=> { if (mountWorldsButton()) mo.disconnect(); });
    mo.observe(document.body, { childList:true, subtree:true });
  }

  // ---- Worlds modal ----
  let counts = {1:0,2:0,3:0,4:0}, pollTimer=null;
  function openWorldsModal(){
    const cur = getWorld();
    const hostId='worldsModal';
    let m = document.getElementById(hostId);
    if(!m){
      m = document.createElement('div'); m.id=hostId;
      Object.assign(m.style, {
        position:'fixed', inset:'0', display:'flex',
        alignItems:'center', justifyContent:'center',
        zIndex: 10040,                 // above fire/controls
        background:'rgba(0,0,0,.45)'
      });
      m.innerHTML = `
        <div style="background:#0b0f17;border:1px solid #2a3550;border-radius:14px;padding:14px 16px;color:#dbe6ff;min-width:280px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
            <div style="font-weight:800">Choose World</div>
            <button id="worldsClose" class="ghost" style="border-color:#2a3550">Close</button>
          </div>
          <div id="worldGrid" style="display:grid;grid-template-columns:1fr 1fr;gap:10px"></div>
          <div style="opacity:.8;font-size:12px;margin-top:8px">You are in <b>World ${cur}</b>. Players shown are active now.</div>
        </div>`;
      document.body.appendChild(m);
      m.querySelector('#worldsClose').onclick = ()=> closeWorldsModal();
    }
    renderWorldCards();
    m.style.display='flex';

    hideFire(true);                 // << hide FIRE while picker is open
    if(!pollTimer){ pollTimer = setInterval(()=> MP.askCounts(), 3000); }
    MP.askCounts();
  }
  function closeWorldsModal(){
    const m = document.getElementById('worldsModal'); if(m) m.style.display='none';
    if(pollTimer){ clearInterval(pollTimer); pollTimer=null; }
    hideFire(false);                // << show FIRE again when closed
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

  // ---- Switch world ----
  function switchWorld(newWorld){
    const old = getWorld();
    if(String(old)===String(newWorld)){ closeWorldsModal(); return; }
    setWorld(newWorld);
    MP.joinWorld(newWorld);
    try{ IZZA?.api?.clearRemotePlayers?.(); }catch{}
    try{ IZZA?.toast?.(`Joined World ${newWorld}`); }catch{}
    closeWorldsModal();            // also unhides FIRE via close handler
    try{ window.dispatchEvent(new Event('izza-world-changed')); }catch{}
  }

  // ---- Live counts ----
  MP.on('worlds-counts', (payload)=>{
    if(payload && payload.counts){
      counts = Object.assign({1:0,2:0,3:0,4:0}, payload.counts);
      renderWorldCards();
    }
  });

  // ---- 1v1 invite via "B" ----
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
        background:'#0b0f17',border:'1px solid #2a3550',borderRadius:'12px',padding:'12px',zIndex:10030,color:'#e4efff',minWidth:'260px'});
      m.innerHTML=`
        <div style="font-weight:800;margin-bottom:6px">1v1 Duel</div>
        <div id="duelTarget" style="opacity:.85;margin-bottom:8px"></div>
        <div style="display:flex;gap:8px">
          <button id="duelReady" style="flex:1;background:#2ea043;color:#fff;border:0;border-radius:8px;padding:8px 10px;font-weight:800">Ready</button>
          <button id="duelCancel" class="ghost" style="border-color:#2a3550">Cancel</button>
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
  MP.on('duel-start', (payload)=>{
    try{ IZZA?.emit?.('mp-start', Object.assign({mode:'v1'}, payload)); }catch{}
  });
  MP.on('duel-invite', (m)=>{
    if(!m || String(m.world)!==String(getWorld())) return;
    const id='duelIncoming';
    let d=document.getElementById(id);
    if(!d){
      d=document.createElement('div'); d.id=id;
      Object.assign(d.style,{position:'fixed',left:'50%',top:'50%',transform:'translate(-50%,-50%)',
        background:'#0b0f17',border:'1px solid #2a3550',borderRadius:'12px',padding:'12px',zIndex:10030,color:'#e4efff',minWidth:'260px'});
      d.innerHTML=`
        <div style="font-weight:800;margin-bottom:6px">Incoming 1v1</div>
        <div style="opacity:.85;margin-bottom:8px">from @<span id="duelFrom"></span></div>
        <div style="display:flex;gap:8px">
          <button id="duelAccept" style="flex:1;background:#2ea043;color:#fff;border:0;border-radius:8px;padding:8px 10px;font-weight:800">Accept</button>
          <button id="duelDecline" class="ghost" style="border-color:#2a3550">Decline</button>
        </div>`;
      document.body.appendChild(d);
      d.querySelector('#duelDecline').onclick = ()=> d.remove();
      d.querySelector('#duelAccept').onclick = ()=>{
        MP.send('duel-accept', { from: m.from, world: getWorld() }); d.remove();
      };
    }
    d.querySelector('#duelFrom').textContent = m.from || 'player';
  });
  window.addEventListener('keydown', (e)=>{
    if((e.key||'').toLowerCase()!=='b') return;
    try{
      if(!IZZA?.api?.ready) return;
      const me = IZZA.api.player || {x:0,y:0};
      const near = nearestPlayerWithin(me.x, me.y, 38);
      if(near){ showDuelSheet(near); }
    }catch{}
  }, {capture:true, passive:true});

  // ---- Boot ----
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
