(function(){
  const API_BASE = (window.IZZA_PERSIST_BASE || '').replace(/\/+$/,'') || '';
  const LOG_PREFIX = '[izza-persist]';
  function log(...a){ try{ console.log(LOG_PREFIX, ...a); }catch{} }

  function uname(){
    return (IZZA?.api?.user?.username || 'guest').toString().replace(/^@+/,'').toLowerCase();
  }
  function heartsMax(){ const p=IZZA.api?.player||{}; return p.maxHearts||p.heartsMax||3; }
  function getHeartSegs(){
    // your HUD code uses localStorage('izzaCurHeartSegments') if not on player obj
    const p=IZZA.api?.player||{};
    if(typeof p.heartSegs==='number') return p.heartSegs|0;
    const max = heartsMax()*3;
    const raw = parseInt(localStorage.getItem('izzaCurHeartSegments') || String(max), 10);
    return isNaN(raw) ? max : Math.max(0, Math.min(max, raw|0));
  }

  async function loadPlayerState(){
    const u = uname();
    const url = `${API_BASE}/api/state/${encodeURIComponent(u)}`;
    log('GET', url);
    let s={};
    try{
      const r = await fetch(url, { credentials:'omit' });
      s = await r.json();
    }catch(e){
      log('GET failed (using defaults):', e);
      s = { version:1, player:{}, coins:0, inventory:{}, bank:{coins:0,items:{},ammo:{}}, timestamp:Date.now() };
    }

    // coins
    if(typeof s.coins === 'number' && IZZA.api?.setCoins) {
      IZZA.api.setCoins(s.coins|0);
      log('applied coins', s.coins|0);
    }

    // inventory
    if(IZZA.api?.setInventory && s.inventory) {
      IZZA.api.setInventory(s.inventory);
      log('applied inventory');
    }

    // bank (mirror into your localStorage-based bank so the existing bank UI keeps working)
    const bankKey = 'izzaBank_'+u;
    if(s.bank) {
      localStorage.setItem(bankKey, JSON.stringify(s.bank));
      log('applied bank payload');
    }

    // Option A — Keep HQ spawn (don’t restore position)
    // (we still save x/y periodically so you can enable restore later if desired)

    // hearts
    if(typeof s.player?.heartsSegs === 'number'){
      localStorage.setItem('izzaCurHeartSegments', String(s.player.heartsSegs|0));
      if(typeof window._redrawHeartsHud === 'function') window._redrawHeartsHud();
      log('applied heartsSegs', s.player.heartsSegs|0);
    }

    // Re-apply once on the next tick to win races with any late “new game” initializer
    setTimeout(()=>{
      try{
        if(typeof s.coins === 'number' && IZZA.api?.setCoins) IZZA.api.setCoins(s.coins|0);
        if(IZZA.api?.setInventory && s.inventory) IZZA.api.setInventory(s.inventory);
        if(typeof s.player?.heartsSegs === 'number'){
          localStorage.setItem('izzaCurHeartSegments', String(s.player.heartsSegs|0));
          if(typeof window._redrawHeartsHud === 'function') window._redrawHeartsHud();
        }
        log('re-applied state after init race');
      }catch(e){ log('re-apply failed', e); }
    }, 0);
  }

  function collectPlayerState(){
    const u = uname();
    const bankKey = 'izzaBank_'+u;
    let bank = { coins:0, items:{}, ammo:{} };
    try{ bank = JSON.parse(localStorage.getItem(bankKey) || '{"coins":0,"items":{},"ammo":{}}'); }catch{}
    const inv = (IZZA.api?.getInventory && IZZA.api.getInventory()) || {};
    const coins = (IZZA.api?.getCoins && IZZA.api.getCoins()) || 0;
    const p = IZZA.api?.player||{x:0,y:0};
    const heartsSegs = getHeartSegs();
    return {
      version: 1,
      player: { x: (p.x|0), y: (p.y|0), heartsSegs },
      coins: coins|0,
      inventory: inv,
      bank,
      timestamp: Date.now()
    };
  }

  let _saveTimer=null, _debounce=null;
  async function savePlayerState(reason='periodic'){
    const u = uname();
    const url = `${API_BASE}/api/state/${encodeURIComponent(u)}`;
    const body = collectPlayerState();
    try{
      const r = await fetch(url, {
        method: 'POST',
        headers: {'content-type':'application/json'},
        body: JSON.stringify(body),
        credentials:'omit'
      });
      log('POST', reason, r.ok ? 'ok' : `fail ${r.status}`);
    }catch(e){
      log('POST error', reason, e);
    }
  }

  function debouncedSave(reason){
    clearTimeout(_debounce);
    _debounce = setTimeout(()=> savePlayerState(reason), 250);
  }

  function scheduleAutoSave(){
    if(_saveTimer) clearInterval(_saveTimer);
    _saveTimer = setInterval(()=> savePlayerState('interval'), 5000); // every 5s
    // iOS-friendly lifecycle
    window.addEventListener('pagehide', ()=> savePlayerState('pagehide'));
    document.addEventListener('visibilitychange', ()=>{ if(document.visibilityState==='hidden') savePlayerState('visibility-hidden'); });
    window.addEventListener('beforeunload', ()=>{
      try{
        const u = uname();
        const url = `${API_BASE}/api/state/${encodeURIComponent(u)}`;
        const payload = JSON.stringify(collectPlayerState());
        if(navigator.sendBeacon){
          navigator.sendBeacon(url, payload);
          log('sendBeacon fired');
        }else{
          // best-effort sync
          fetch(url, {method:'POST', headers:{'content-type':'application/json'}, body: payload, keepalive: true});
          log('keepalive POST fired');
        }
      }catch(e){ log('beforeunload save failed', e); }
    });
  }

  // Wrap core setters so any coin/inventory change gets saved
  function installAutoSaveHooks(){
    if(!IZZA?.api) return;
    try{
      const api = IZZA.api;

      if(typeof api.setCoins === 'function' && !api.__persist_wrapped_setCoins){
        const orig = api.setCoins.bind(api);
        api.setCoins = (v)=>{ const r=orig(v); debouncedSave('setCoins'); return r; };
        api.__persist_wrapped_setCoins = true;
      }
      if(typeof api.setInventory === 'function' && !api.__persist_wrapped_setInventory){
        const orig = api.setInventory.bind(api);
        api.setInventory = (inv)=>{ const r=orig(inv); debouncedSave('setInventory'); return r; };
        api.__persist_wrapped_setInventory = true;
      }

      // If your bank UI dispatches this, we’ll save immediately
      window.addEventListener('izza-bank-changed', ()=> debouncedSave('bank-changed'));
    }catch(e){ log('install hooks failed', e); }
  }

  // Expose a manual trigger for quick tests from console
  window.izzaPersistSave = ()=> savePlayerState('manual');

  // Boot
  log('API_BASE =', API_BASE || '(same origin)');
  IZZA.on('ready', async ()=>{
    try{
      await loadPlayerState();          // pull state
      await savePlayerState('onload');  // write once so file exists
      installAutoSaveHooks();           // wrap setters
      scheduleAutoSave();               // periodic + lifecycle
      log('persistence initialized');
    }catch(e){
      log('init failed', e);
    }
  });
})();
