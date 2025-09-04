(function(){
  const API_BASE = (window.IZZA_PERSIST_BASE || '').replace(/\/+$/,'') || '';
  const LOG_PREFIX = '[izza-persist]';
  function log(...a){ try{ console.log(LOG_PREFIX, ...a); }catch{} }

  // ---------- Username resolution (no core edits required) ----------
  // Strategy:
  // 1) window.__IZZA_PROFILE__.username (if your server injected it anywhere)
  // 2) previously cached username in localStorage
  // 3) call your existing endpoint /izza-game/api/mp/me (cookie or t= query)
  // 4) fallback to "guest" but keep retrying in the background
  const LS_USER_KEY = 'izzaLastUsername';
  let _username = null;
  let _usernameReady = null;

  function cacheUsername(u){
    try { localStorage.setItem(LS_USER_KEY, u); } catch {}
    _username = u;
    log('username =', u);
    return u;
  }

  async function fetchUsernameFromMe(){
    // Try both with and without the short-lived token if present in the URL
    const url = new URL(location.href);
    const t   = url.searchParams.get('t');
    const me  = t ? `/izza-game/api/mp/me?t=${encodeURIComponent(t)}` : `/izza-game/api/mp/me`;
    try{
      const r = await fetch(me, { credentials:'include' });
      if(!r.ok) throw new Error('status '+r.status);
      const j = await r.json();
      if(j && (j.username || j.user?.username)){
        return (j.username || j.user.username).toString().replace(/^@+/,'').toLowerCase();
      }
    }catch(e){
      log('me() failed', e);
    }
    return null;
  }

  function resolveUsername(){
    if(_usernameReady) return _usernameReady;

    _usernameReady = (async ()=>{
      // 1) inline profile (if your server put it on the page)
      const inline = (window.__IZZA_PROFILE__?.username || window.__IZZA_PROFILE__?.user?.username);
      if(inline) return cacheUsername(String(inline).replace(/^@+/,'').toLowerCase());

      // 2) cached from a previous visit
      try{
        const cached = localStorage.getItem(LS_USER_KEY);
        if(cached) return cacheUsername(cached);
      }catch{}

      // 3) ask backend
      const fromMe = await fetchUsernameFromMe();
      if(fromMe) return cacheUsername(fromMe);

      // 4) fallback + background retry
      cacheUsername('guest');
      setTimeout(async ()=>{
        const late = await fetchUsernameFromMe();
        if(late && late !== 'guest') cacheUsername(late);
      }, 2500);
      return 'guest';
    })();

    return _usernameReady;
  }

  function bankKeyFor(u){ return 'izzaBank_'+u; }

  // ---------- Hearts helpers ----------
  function heartsMax(){ const p=IZZA.api?.player||{}; return p.maxHearts||p.heartsMax||3; }
  function getHeartSegs(){
    const p=IZZA.api?.player||{};
    if(typeof p.heartSegs==='number') return p.heartSegs|0;
    const max = heartsMax()*3;
    const raw = parseInt(localStorage.getItem('izzaCurHeartSegments') || String(max), 10);
    return isNaN(raw) ? max : Math.max(0, Math.min(max, raw|0));
  }

  // ---------- Load / save ----------
  async function loadPlayerState(){
    const u = await resolveUsername();
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

    // bank (mirror into localStorage so bank UI keeps working)
    if(s.bank) {
      localStorage.setItem(bankKeyFor(u), JSON.stringify(s.bank));
      log('applied bank payload');
    }

    // hearts
    if(typeof s.player?.heartsSegs === 'number'){
      localStorage.setItem('izzaCurHeartSegments', String(s.player.heartsSegs|0));
      if(typeof window._redrawHeartsHud === 'function') window._redrawHeartsHud();
      log('applied heartsSegs', s.player.heartsSegs|0);
    }

    // re-apply once next tick to win races with any “new game” initializer
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

  function collectPlayerState(u){
    const k = bankKeyFor(u);
    let bank = { coins:0, items:{}, ammo:{} };
    try{ bank = JSON.parse(localStorage.getItem(k) || '{"coins":0,"items":{},"ammo":{}}'); }catch{}
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
    const u = _username || await resolveUsername();
    const url = `${API_BASE}/api/state/${encodeURIComponent(u)}`;
    const body = collectPlayerState(u);
    try{
      const r = await fetch(url, {
        method: 'POST',
        headers: {'content-type':'application/json'},
        body: JSON.stringify(body),
        credentials:'omit',
        keepalive: reason==='pagehide' || reason==='visibility-hidden' || reason==='beforeunload'
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

    // iOS-friendly lifecycle — use fetch keepalive (not sendBeacon) to keep JSON Content-Type
    window.addEventListener('pagehide', ()=> savePlayerState('pagehide'), { capture:true });
    document.addEventListener('visibilitychange', ()=>{ if(document.visibilityState==='hidden') savePlayerState('visibility-hidden'); }, { capture:true });
    window.addEventListener('beforeunload', ()=> savePlayerState('beforeunload'), { capture:true });
  }

  // ---------- Bank watcher ----------
  function installBankWatcher(){
    resolveUsername().then(u=>{
      const k = bankKeyFor(u);
      let last = null;
      try{ last = localStorage.getItem(k); }catch{}
      setInterval(()=>{
        let cur=null;
        try{ cur = localStorage.getItem(k); }catch{}
        if(cur!==last){
          last = cur;
          debouncedSave('bank-ls-changed');
          log('bank localStorage changed → save');
        }
      }, 400); // snappier detection
    });
  }

  // ---------- Auto-save hooks ----------
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

      // If bank UI dispatches this, we’ll save immediately too
      window.addEventListener('izza-bank-changed', ()=> debouncedSave('bank-changed'));
    }catch(e){ log('install hooks failed', e); }
  }

  // Manual trigger for console tests
  window.izzaPersistSave = ()=> savePlayerState('manual');

  // ---------- Boot ----------
  log('API_BASE =', API_BASE || '(same origin)');
  // Pre-resolve username ASAP (don’t block on ready for background cache)
  resolveUsername();

  IZZA.on('ready', async ()=>{
    try{
      await resolveUsername();          // make sure we have the real user before hitting disk
      await loadPlayerState();          // pull state
      await savePlayerState('onload');  // write once so file exists
      installAutoSaveHooks();           // wrap setters
      installBankWatcher();             // watch localStorage for bank changes
      scheduleAutoSave();               // periodic + lifecycle
      log('persistence initialized');
    }catch(e){
      log('init failed', e);
    }
  });
})();
