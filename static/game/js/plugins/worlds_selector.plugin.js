// worlds_selector.plugin.js — Worlds switcher (SOLO default) + robust button mount
(function(){
  const BUILD='worlds-selector/v2.4-solo+strict-backend+debug-logs';
  console.log('[IZZA PLAY]', BUILD);

  const MP_BASE = window.__MP_BASE__ || '/izza-game/api/mp';

  function clientLog(event, data){
    const payload = {
      event,
      build: BUILD,
      world: localStorage.getItem('izzaWorldId') || 'solo',
      href: location.href,
      data: data || {},
      ts: Date.now()
    };

    console.log('[WORLDS DEBUG]', payload);

    try{
      fetch(`${MP_BASE}/client-log`, {
        method:'POST',
        credentials:'include',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify(payload)
      }).catch(()=>{});
    }catch{}

    try{
      fetch(`${MP_BASE}/world/client-log`, {
        method:'POST',
        credentials:'include',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify(payload)
      }).catch(()=>{});
    }catch{}
  }

  const MP = {
    send(type, data){
      try{
        if (window.REMOTE_PLAYERS_API?.send) return REMOTE_PLAYERS_API.send(type, data);
        if (window.RemotePlayers?.send)      return RemotePlayers.send(type, data);
        if (window.IZZA?.emit)               return IZZA.emit('mp-send', {type, data});
      }catch(e){
        console.warn('[WORLDS] send fail', e);
        clientLog('mp-send-fail', { type, message:e.message });
      }
    },

    on(type, cb){
      try{
        if (window.REMOTE_PLAYERS_API?.on) return REMOTE_PLAYERS_API.on(type, cb);
        if (window.RemotePlayers?.on)      return RemotePlayers.on(type, cb);
        if (window.IZZA?.on)               return IZZA.on('mp-'+type, (payload)=>cb(payload && payload.data ? payload.data : payload));
      }catch(e){
        console.warn('[WORLDS] on fail', e);
        clientLog('mp-on-fail', { type, message:e.message });
      }
    },

    async joinWorld(worldId){
      const world = String(worldId || 'solo');

      if(world === 'solo'){
        clientLog('join-solo-local-ok', { world });
        return { ok:true, world:'solo' };
      }

      const url = `${MP_BASE}/world/join`;
      clientLog('join-start', { world, url });

      try{
        const r = await fetch(url, {
          method:'POST',
          credentials:'include',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({ world, worldId:world })
        });

        const rawText = await r.text().catch(()=>'');
        let j = {};
        try{ j = rawText ? JSON.parse(rawText) : {}; }catch{
          j = { parseError:true, rawText: rawText.slice(0,500) };
        }

        const result = Object.assign({
          ok: !!(r.ok && !j.error && j.ok !== false),
          httpOk: r.ok,
          status: r.status,
          statusText: r.statusText,
          world
        }, j);

        clientLog(result.ok ? 'join-success' : 'join-failed-response', result);
        return result;
      }catch(e){
        const result = {
          ok:false,
          world,
          error:'fetch_failed',
          message:e && e.message ? e.message : String(e)
        };
        console.warn('[WORLDS] join failed', result);
        clientLog('join-fetch-error', result);
        return result;
      }
    },

    askCounts(){
      MP.send('worlds-counts', {});
    }
  };

  const getWorld = ()=> localStorage.getItem('izzaWorldId') || 'solo';
  const setWorld = id => localStorage.setItem('izzaWorldId', String(id || 'solo'));

  function toast(text){
    try{ IZZA?.emit?.('toast', { text }); return; }catch{}
    try{ window.toast?.(text); return; }catch{}
    console.log(text);
  }

  function setMultiplayerMode(on){
    try{
      if (IZZA?.api) {
        IZZA.api.setMultiplayerMode?.(!!on);
        IZZA.api.clearRemotePlayers?.();
      }

      const missionHud = document.querySelector('[data-ui="mission-hud"], #missionHud, .mission-hud');
      if(missionHud) missionHud.style.display = on ? 'none' : '';

      window.dispatchEvent(new CustomEvent('izza-missions-toggle', {
        detail:{ enabled: !on }
      }));
    }catch(e){
      console.warn('[WORLDS] multiplayer mode toggle failed', e);
      clientLog('set-multiplayer-mode-failed', { on, message:e.message });
    }
  }

  function findGlobalFriendsBtn(){
    return document.querySelector('#mpFriendsToggleGlobal');
  }

  function findLegacyFriendsBtn(){
    const nodes = document.querySelectorAll('button,.btn,.pill,[role="button"]');
    for (const el of nodes){
      if ((el.textContent || '').trim().toLowerCase() === 'friends') return el;
    }
    return document.querySelector('#btnFriends,[data-ui="btn-friends"]');
  }

  function findChatBarRect(){
    const txt = document.querySelector('input[placeholder="Type..."], input[placeholder="Type…"], textarea[placeholder="Type..."], textarea[placeholder="Type…"]');
    if(txt) return txt.getBoundingClientRect();

    const send = Array.from(document.querySelectorAll('button')).find(b=> (b.textContent || '').trim() === 'Send');
    if(send) return send.getBoundingClientRect();

    const en = Array.from(document.querySelectorAll('button,div')).find(b=> (b.textContent || '').trim() === 'EN');
    if(en) return en.getBoundingClientRect();

    return null;
  }

  function makeWorldsBtn(){
    const btn = document.createElement('button');
    btn.id = 'btnWorlds';
    btn.type = 'button';
    btn.textContent = 'Worlds';
    btn.addEventListener('click', ()=>{
      clientLog('worlds-button-clicked', {});
      openWorldsModal();
    }, { passive:true });
    return btn;
  }

  function styleLike(el, ref){
    if(!ref) return;
    if(ref.className) el.className = ref.className;
    el.style.marginLeft = '8px';
  }

  function mountWorldsButton(){
    if(document.getElementById('btnWorlds')) return true;

    const globalFriends = findGlobalFriendsBtn();
    if(globalFriends){
      const btn = makeWorldsBtn();
      styleLike(btn, globalFriends);

      btn.style.position = 'fixed';
      btn.style.zIndex = String(parseInt(getComputedStyle(globalFriends).zIndex, 10) || 1011);

      const sync = ()=>{
        const r = globalFriends.getBoundingClientRect();
        btn.style.top = Math.round(r.top) + 'px';
        btn.style.left = Math.round(r.right + 8) + 'px';
        btn.style.height = (r.height || 34) + 'px';
      };

      document.body.appendChild(btn);
      sync();

      window.addEventListener('resize', sync);
      window.addEventListener('scroll', sync, { passive:true });
      clientLog('worlds-button-mounted-global-friends', {});
      return true;
    }

    const legacy = findLegacyFriendsBtn();
    if(legacy){
      const btn = makeWorldsBtn();
      styleLike(btn, legacy);
      legacy.insertAdjacentElement('afterend', btn);
      clientLog('worlds-button-mounted-legacy-friends', {});
      return true;
    }

    const chatRect = findChatBarRect();
    if(chatRect){
      const btn = makeWorldsBtn();

      Object.assign(btn.style,{
        position:'fixed',
        right:'14px',
        top:Math.round(chatRect.bottom + 8) + 'px',
        zIndex:'1011',
        height:'34px',
        padding:'0 12px',
        background:'#162134',
        color:'#cfe0ff',
        border:'1px solid #2a3550',
        borderRadius:'18px'
      });

      document.body.appendChild(btn);

      const sync = ()=>{
        const r = findChatBarRect();
        if(!r) return;
        btn.style.top = Math.round(r.bottom + 8) + 'px';
      };

      window.addEventListener('resize', sync);
      window.addEventListener('scroll', sync, { passive:true });
      clientLog('worlds-button-mounted-chat', {});
      return true;
    }

    const btn = makeWorldsBtn();
    Object.assign(btn.style,{
      position:'fixed',
      right:'14px',
      top:'90px',
      zIndex:1011,
      height:'34px',
      padding:'0 12px',
      borderRadius:'18px',
      background:'#162134',
      color:'#cfe0ff',
      border:'1px solid #2a3550',
      boxShadow:'0 2px 8px rgba(0,0,0,.25)'
    });

    document.body.appendChild(btn);
    clientLog('worlds-button-mounted-fallback', {});
    return true;
  }

  function ensureWorldsButton(){
    if(mountWorldsButton()) return;

    const mo = new MutationObserver(()=>{
      if(mountWorldsButton()) mo.disconnect();
    });

    mo.observe(document.body, { childList:true, subtree:true });
  }

  let counts = {1:0,2:0,3:0,4:0};
  let pollTimer = null;
  let switching = false;

  function openWorldsModal(){
    const cur = getWorld();
    let m = document.getElementById('worldsModal');

    if(!m){
      m = document.createElement('div');
      m.id = 'worldsModal';

      Object.assign(m.style,{
        position:'fixed',
        inset:'0',
        display:'flex',
        alignItems:'center',
        justifyContent:'center',
        zIndex:10040,
        background:'rgba(0,0,0,.45)'
      });

      m.innerHTML = `
        <div style="background:#0b0f17;border:1px solid #2a3550;border-radius:14px;padding:14px 16px;color:#dbe6ff;min-width:280px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
            <div style="font-weight:800">Choose World</div>
            <button id="worldsClose" class="ghost" style="border-color:#2a3550">Close</button>
          </div>
          <div id="worldGrid" style="display:grid;grid-template-columns:1fr 1fr;gap:10px"></div>
          <div id="worldCurrentText" style="opacity:.8;font-size:12px;margin-top:8px">You are in <b>${cur.toUpperCase()}</b>.</div>
          <div id="worldJoinError" style="display:none;color:#ff9b9b;font-size:12px;margin-top:8px"></div>
          <div style="opacity:.8;font-size:12px;margin-top:2px">SOLO = missions on, no players. Worlds 1–4 = multiplayer.</div>
        </div>
      `;

      document.body.appendChild(m);
      m.querySelector('#worldsClose').onclick = closeWorldsModal;
      m.addEventListener('click', e=>{ if(e.target === m) closeWorldsModal(); });
    }

    renderWorldCards();
    m.style.display = 'flex';

    if(!pollTimer) pollTimer = setInterval(()=> MP.askCounts(), 3000);
    MP.askCounts();
  }

  function closeWorldsModal(){
    const m = document.getElementById('worldsModal');
    if(m) m.style.display = 'none';

    if(pollTimer){
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function setJoinError(text){
    const el = document.getElementById('worldJoinError');
    if(!el) return;
    if(!text){
      el.style.display = 'none';
      el.textContent = '';
      return;
    }
    el.style.display = 'block';
    el.textContent = text;
  }

  function renderWorldCards(){
    const grid = document.getElementById('worldGrid');
    if(!grid) return;

    const cur = getWorld();
    const currentText = document.getElementById('worldCurrentText');
    if(currentText) currentText.innerHTML = `You are in <b>${cur.toUpperCase()}</b>.`;

    grid.innerHTML = '';

    const solo = document.createElement('button');
    solo.innerHTML = `
      <div style="font-weight:800">SOLO</div>
      <div style="opacity:.85;font-size:12px;margin-top:4px">Missions enabled</div>
      ${cur === 'solo' ? '<div style="margin-top:6px;font-size:12px;opacity:.85">Current</div>' : ''}
    `;
    Object.assign(solo.style,{
      textAlign:'left',
      background:cur === 'solo' ? '#1f2d4f' : '#0e1626',
      color:'#cfe0ff',
      border:'1px solid #2a3550',
      borderRadius:'10px',
      padding:'10px 12px',
      opacity:switching ? '.65' : '1'
    });
    solo.disabled = switching;
    solo.onclick = ()=> switchWorld('solo');
    grid.appendChild(solo);

    [1,2,3,4].forEach(n=>{
      const selected = String(n) === String(cur);
      const card = document.createElement('button');

      card.innerHTML = `
        <div style="font-weight:800">WORLD ${n}</div>
        <div style="opacity:.85;font-size:12px;margin-top:4px">Players: <b>${counts[n] || 0}</b></div>
        ${selected ? '<div style="margin-top:6px;font-size:12px;opacity:.85">Current</div>' : ''}
      `;

      Object.assign(card.style,{
        textAlign:'left',
        background:selected ? '#1f2d4f' : '#0e1626',
        color:'#cfe0ff',
        border:'1px solid #2a3550',
        borderRadius:'10px',
        padding:'10px 12px',
        opacity:switching ? '.65' : '1'
      });

      card.disabled = switching;
      card.onclick = ()=> switchWorld(String(n));
      grid.appendChild(card);
    });
  }

  async function switchWorld(newWorld){
    newWorld = String(newWorld || 'solo');

    if(switching) return;

    const old = getWorld();
    clientLog('switch-request', { old, newWorld });

    if(String(old) === String(newWorld)){
      closeWorldsModal();
      return;
    }

    switching = true;
    setJoinError('');
    renderWorldCards();

    const joinRes = await MP.joinWorld(newWorld);

    if(newWorld !== 'solo' && joinRes.ok === false){
      switching = false;
      renderWorldCards();

      const detail = joinRes.error || joinRes.message || joinRes.statusText || `HTTP ${joinRes.status || 'unknown'}`;
      const msg = `Could not join World ${newWorld}: ${detail}`;

      console.warn('[WORLDS] strict join failed, staying in old world', joinRes);
      clientLog('switch-blocked-backend-failed', { old, newWorld, joinRes });

      setJoinError(msg);
      toast(msg);
      return;
    }

    const isMulti = newWorld !== 'solo';

    setWorld(newWorld);

    try{ IZZA.api.worldId = newWorld; }catch{}

    setMultiplayerMode(isMulti);

    try{ IZZA?.api?._onWorldChanged?.(newWorld); }catch(e){
      console.warn('[WORLDS] core world change hook failed', e);
      clientLog('core-world-change-hook-failed', { newWorld, message:e.message });
    }

    try{
      IZZA?.emit?.('world-changed', { world:newWorld });
    }catch{}

    try{
      window.dispatchEvent(new CustomEvent('izza-world-changed', {
        detail:{ world:newWorld }
      }));
    }catch{}

    switching = false;
    renderWorldCards();

    clientLog('switch-success', { old, newWorld, joinRes });
    toast(isMulti ? `🌍 Joined World ${newWorld}` : '🏝️ Back to SOLO world');

    closeWorldsModal();
  }

  MP.on('worlds-counts', payload=>{
    if(payload && payload.counts){
      counts = Object.assign({1:0,2:0,3:0,4:0}, payload.counts);
      renderWorldCards();
    }
  });

  async function boot(){
    if(!localStorage.getItem('izzaWorldId')) setWorld('solo');

    ensureWorldsButton();

    const cur = getWorld();
    const isMulti = String(cur) !== 'solo';

    try{ IZZA.api.worldId = cur; }catch{}
    setMultiplayerMode(isMulti);

    clientLog('boot', { cur, isMulti });

    if(isMulti){
      const joinRes = await MP.joinWorld(cur);
      if(joinRes.ok === false){
        clientLog('boot-join-failed-resetting-solo', { cur, joinRes });
        setWorld('solo');
        try{ IZZA.api.worldId = 'solo'; }catch{}
        setMultiplayerMode(false);
        toast('World join failed on boot. Returned to SOLO.');
      }
    }
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', boot, { once:true });
  }else{
    boot();
  }
})();
