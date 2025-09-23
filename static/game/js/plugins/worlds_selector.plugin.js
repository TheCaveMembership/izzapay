// worlds_selector.plugin.js — Worlds switcher (SOLO default) + robust button mount
(function(){
  const BUILD='worlds-selector/v2.1-solo+robust-anchor';
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

  // ---- SOLO by default ----
  const getWorld = ()=> localStorage.getItem('izzaWorldId') || 'solo';
  const setWorld = id => localStorage.setItem('izzaWorldId', String(id||'solo'));

  // ---- Toggle mission/remote state ----
  function setMultiplayerMode(on){
    try{
      if (IZZA?.api) {
        IZZA.api.setMultiplayerMode?.(!!on);
        IZZA.api.clearRemotePlayers?.();
      }
      const missionHud = document.querySelector('[data-ui="mission-hud"], #missionHud, .mission-hud');
      if(missionHud) missionHud.style.display = on ? 'none' : '';
      window.dispatchEvent(new CustomEvent('izza-missions-toggle', { detail:{ enabled: !on }}));
    }catch{}
  }

  // ---- UI anchoring helpers ----
  function findGlobalFriendsBtn(){
    return document.querySelector('#mpFriendsToggleGlobal');
  }
  function findLegacyFriendsBtn(){
    const nodes = document.querySelectorAll('button,.btn,.pill,[role="button"]');
    for (const el of nodes){ if ((el.textContent||'').trim().toLowerCase()==='friends') return el; }
    return document.querySelector('#btnFriends,[data-ui="btn-friends"]');
  }
  function findChatBarRect(){
    const txt = document.querySelector('input[placeholder="Type..."], textarea[placeholder="Type..."]');
    if(txt) return txt.getBoundingClientRect();
    const send = Array.from(document.querySelectorAll('button')).find(b=> (b.textContent||'').trim()==='Send');
    if(send) return send.getBoundingClientRect();
    const en = Array.from(document.querySelectorAll('button,div')).find(b=> (b.textContent||'').trim()==='EN');
    if(en) return en.getBoundingClientRect();
    return null;
  }

  function makeWorldsBtn(){
    const btn = document.createElement('button');
    btn.id='btnWorlds'; btn.type='button'; btn.textContent='Worlds';
    btn.addEventListener('click', openWorldsModal, { passive:true });
    return btn;
  }

  function styleLike(el, ref){
    if(!ref) return;
    if (ref.className) el.className = ref.className;
    el.style.marginLeft = '8px';
  }

  // Mount beside global friends, legacy friends, or position near chat bar; finally fixed fallback
  function mountWorldsButton(){
    if (document.getElementById('btnWorlds')) return true;

    const globalFriends = findGlobalFriendsBtn();
    if (globalFriends){
      const btn = makeWorldsBtn();
      styleLike(btn, globalFriends);
      // Place just to the right of global friends button (same overlay layer)
      btn.style.position = 'fixed';
      btn.style.zIndex = String((parseInt(getComputedStyle(globalFriends).zIndex)||1011));
      // match vertical with global friends; offset to the right
      const r = globalFriends.getBoundingClientRect();
      btn.style.top = Math.round(window.scrollY + r.top) + 'px';
      btn.style.left = Math.round(window.scrollX + r.right + 8) + 'px';
      btn.style.height = (r.height||34)+'px';
      document.body.appendChild(btn);
      // keep in sync on resize/scroll
      const sync = ()=> {
        const rr = globalFriends.getBoundingClientRect();
        btn.style.top = Math.round(window.scrollY + rr.top) + 'px';
        btn.style.left = Math.round(window.scrollX + rr.right + 8) + 'px';
        btn.style.height = (rr.height||34)+'px';
      };
      window.addEventListener('resize', sync);
      window.addEventListener('scroll', sync, { passive:true });
      return true;
    }

    const legacy = findLegacyFriendsBtn();
    if (legacy){
      const btn = makeWorldsBtn();
      styleLike(btn, legacy);
      legacy.insertAdjacentElement('afterend', btn);
      return true;
    }

    const chatRect = findChatBarRect();
    if (chatRect){
      const btn = makeWorldsBtn();
      btn.style.position='fixed';
      btn.style.right='14px';
      btn.style.top = Math.round(window.scrollY + chatRect.bottom + 8) + 'px';
      btn.style.zIndex='1011';
      btn.style.height='34px';
      btn.style.padding='0 12px';
      btn.style.background='#162134';
      btn.style.color='#cfe0ff';
      btn.style.border='1px solid #2a3550';
      btn.style.borderRadius='18px';
      document.body.appendChild(btn);
      const sync = ()=>{
        const r=findChatBarRect(); if(!r) return;
        btn.style.top = Math.round(window.scrollY + r.bottom + 8) + 'px';
      };
      window.addEventListener('resize', sync);
      window.addEventListener('scroll', sync, { passive:true });
      return true;
    }

    // ultimate fallback: fixed under the bell
    const btn = makeWorldsBtn();
    Object.assign(btn.style,{
      position:'fixed', right:'14px', top:'90px', zIndex:1011,
      height:'34px', padding:'0 12px', borderRadius:'18px',
      background:'#162134', color:'#cfe0ff', border:'1px solid #2a3550',
      boxShadow:'0 2px 8px rgba(0,0,0,.25)'
    });
    document.body.appendChild(btn);
    return true;
  }

  function ensureWorldsButton(){
    if (mountWorldsButton()) return;
    // Keep watching for late-mounted UI (global friends overlay, chat bar, etc.)
    const mo = new MutationObserver(()=> { if (mountWorldsButton()) mo.disconnect(); });
    mo.observe(document.body, { childList:true, subtree:true });
  }

  // ---- Modal & switching (unchanged from your v2.0) ----
  let counts = {1:0,2:0,3:0,4:0}, pollTimer=null;
  function openWorldsModal(){
    const cur = getWorld();
    const hostId='worldsModal';
    let m = document.getElementById(hostId);
    if(!m){
      m = document.createElement('div'); m.id=hostId;
      Object.assign(m.style,{position:'fixed',inset:'0',display:'flex',alignItems:'center',justifyContent:'center',zIndex:10040,background:'rgba(0,0,0,.45)'});
      m.innerHTML = `
        <div style="background:#0b0f17;border:1px solid #2a3550;border-radius:14px;padding:14px 16px;color:#dbe6ff;min-width:280px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
            <div style="font-weight:800">Choose World</div>
            <button id="worldsClose" class="ghost" style="border-color:#2a3550">Close</button>
          </div>
          <div id="worldGrid" style="display:grid;grid-template-columns:1fr 1fr;gap:10px"></div>
          <div style="opacity:.8;font-size:12px;margin-top:8px">You are in <b>${cur.toUpperCase()}</b>.</div>
          <div style="opacity:.8;font-size:12px;margin-top:2px">SOLO = missions on, no players. Worlds 1–4 = multiplayer.</div>
        </div>`;
      document.body.appendChild(m);
      m.querySelector('#worldsClose').onclick = ()=> closeWorldsModal();
    }
    renderWorldCards();
    m.style.display='flex';
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
    // SOLO
    const solo = document.createElement('button');
    solo.innerHTML = `<div style="font-weight:800">SOLO</div><div style="opacity:.85;font-size:12px;margin-top:4px">Missions enabled</div>${cur==='solo'?'<div style="margin-top:6px;font-size:12px;opacity:.85">Current</div>':''}`;
    Object.assign(solo.style,{textAlign:'left',background:cur==='solo'?'#1f2d4f':'#0e1626',color:'#cfe0ff',border:'1px solid #2a3550',borderRadius:'10px',padding:'10px 12px'});
    solo.onclick = ()=> switchWorld('solo');
    grid.appendChild(solo);
    // Worlds 1–4
    [1,2,3,4].forEach(n=>{
      const card=document.createElement('button');
      const selected = String(n)===String(cur);
      card.innerHTML = `<div style="font-weight:800">WORLD ${n}</div><div style="opacity:.85;font-size:12px;margin-top:4px">Players: <b>${counts[n]||0}</b></div>${selected?'<div style="margin-top:6px;font-size:12px;opacity:.85">Current</div>':''}`;
      Object.assign(card.style,{textAlign:'left',background:selected?'#1f2d4f':'#0e1626',color:'#cfe0ff',border:'1px solid #2a3550',borderRadius:'10px',padding:'10px 12px'});
      card.onclick = ()=> switchWorld(String(n));
      grid.appendChild(card);
    });
  }

  function switchWorld(newWorld){
    const old = getWorld();
    if(String(old)===String(newWorld)){ closeWorldsModal(); return; }
    setWorld(newWorld);
    MP.joinWorld(newWorld);
    const isMulti = (String(newWorld)!=='solo');
    setMultiplayerMode(isMulti);
    try{ (window.toast||console.log)(isMulti?`🌍 Joined World ${newWorld}`:`🏝️ Back to SOLO world`); }catch{}
    try{ IZZA?.api?._onWorldChanged?.(String(newWorld)); }catch{}
    try{ window.dispatchEvent(new Event('izza-world-changed')); }catch{}
    closeWorldsModal();
  }

  MP.on('worlds-counts', (payload)=>{
    if(payload && payload.counts){
      counts = Object.assign({1:0,2:0,3:0,4:0}, payload.counts);
      renderWorldCards();
    }
  });

  // ---- Boot ----
  function boot(){
    if(!localStorage.getItem('izzaWorldId')) setWorld('solo');
    ensureWorldsButton();
    MP.joinWorld(getWorld());
    setMultiplayerMode(String(getWorld())!=='solo');
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', boot, {once:true});
  else boot();
})();
