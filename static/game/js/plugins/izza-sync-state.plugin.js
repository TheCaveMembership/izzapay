// /static/game/js/plugins/izza-sync-state.plugin.js
(function(){
  const API_ORIGIN = 'https://izzagame.onrender.com';
  const SNAP_PATH  = user => `${API_ORIGIN}/api/state/${encodeUser(user)}`;

  // ---------- utils ----------
  const encodeUser = u => String(u||'guest').toLowerCase().replace(/[^a-z0-9-_]/g,'-');
  const now        = ()=> Date.now();
  const sleep      = ms => new Promise(r=>setTimeout(r, ms));
  const safeJSON   = (s, fb)=>{ try{ return JSON.parse(s); }catch{ return fb; } };
  const getLS      = (k, fb)=>{ const v=localStorage.getItem(k); return v==null? fb : v; };
  const getLSJSON  = (k, fb)=> safeJSON(getLS(k, null), fb);
  const setLS      = (k, v)=> localStorage.setItem(k, v);
  const setLSJSON  = (k, o)=> setLS(k, JSON.stringify(o));

  // Meaningful = any of: wallet>0, bank coins/items/ammo, inventory non-empty, OR hearts known
  function isMeaningfulSnapshot(s){
    if(!s || typeof s!=='object') return false;
    const invNonEmpty  = s.inventory && Object.keys(s.inventory).length>0;
    const bankNonEmpty = s.bank && (
      (s.bank.coins|0) > 0 ||
      (s.bank.items && Object.keys(s.bank.items).length>0) ||
      (s.bank.ammo  && Object.keys(s.bank.ammo).length>0)
    );
    const walletCoins  = (s.coins|0) > 0;
    const heartsKnown  = s.player && (s.player.heartsSegs!=null);
    return invNonEmpty || bankNonEmpty || walletCoins || heartsKnown;
  }

  // Resolve current user
  function resolveUser(){
    const p = (window.__IZZA_PROFILE__) || {};
    const fromPlugin = (window.izzaUserKey && typeof izzaUserKey.get==='function') ? izzaUserKey.get() : null;
    const fromLS     = getLS('izzaUserKey', null);
    return encodeUser(p.username || p.user || fromPlugin || fromLS || 'guest');
  }

  // ---------- Build snapshot (wallet & bank kept separate; NO total) ----------
  function buildSnapshot(USER){
    const LS_BANK_KEY   = `izzaBank_${USER}`;
    const LS_HEARTS_KEY = `izzaCurHeartSegments_${USER}`;

    const bank = getLSJSON(LS_BANK_KEY, { coins:0, items:{}, ammo:{} });

    // WALLET coins only
    const walletCoins = (()=>{
      if (window.IZZA?.api?.getCoins) {
        try { return (window.IZZA.api.getCoins()|0); } catch {}
      }
      const direct = parseInt(getLS('izzaCoins'), 10);
      return Number.isFinite(direct) && direct>=0 ? (direct|0) : 0;
    })();

    const inventory = getLSJSON('izzaInventory', {});
    const api       = (window.IZZA && window.IZZA.api) || {};
    const player    = api.player || { x:0, y:0 };
    const heartsSegs = (function(){
      const lsVal = getLS(LS_HEARTS_KEY, null);
      if(lsVal==null) return null;
      const n = parseInt(lsVal, 10);
      if(Number.isFinite(n)) return n|0;
      const arr = safeJSON(lsVal, null);
      if(Array.isArray(arr)) return arr.length|0;
      return null;
    })();

    return {
      version: 1,
      player: { x: player.x|0, y: player.y|0, heartsSegs },
      coins: walletCoins|0,            // WALLET ONLY
      inventory,
      bank,
      timestamp: now()
    };
  }

  // Robust POST (avoid CDN caches)
  function postJSON(url, obj){
    return fetch(url + '?t=' + Date.now(), {
      method:'POST',
      headers:{'Content-Type':'application/json', 'Cache-Control':'no-cache'},
      body: JSON.stringify(obj),
      cache:'no-store',
      credentials:'omit',
      keepalive:true
    });
  }

  // Push snapshot to server — try sendBeacon with Blob (Pi Browser friendly), else POST
  function pushSnapshot(USER, snapshot){
    if(!isMeaningfulSnapshot(snapshot)) {
      console.log('[sync-state] skip save (not meaningful)', snapshot);
      return;
    }
    const url  = SNAP_PATH(USER) + '?t=' + Date.now();
    try{
      if(navigator.sendBeacon){
        const blob = new Blob([JSON.stringify(snapshot)], { type:'application/json' });
        if(navigator.sendBeacon(url, blob)){
          console.log('[sync-state] beacon ok');
          return;
        }
      }
    }catch(e){}
    postJSON(SNAP_PATH(USER), snapshot)
      .then(()=>console.log('[sync-state] fetch ok'))
      .catch(err=>console.warn('[sync-state] save failed', err));
  }

  // Pull snapshot (bypass caches explicitly)
  async function fetchSnapshot(USER){
    const url = SNAP_PATH(USER) + `?t=${now()}`;
    try{
      const res = await fetch(url, { credentials:'omit', cache:'no-store', headers:{'Cache-Control':'no-cache'} });
      if(!res.ok) throw new Error(res.status+'');
      return await res.json();
    }catch(e){
      console.warn('[sync-state] fetch snapshot failed', e);
      return null;
    }
  }

  // Apply snapshot (wallet from coins; bank from bank; no cross-talk)
  function applySnapshot(USER, snap){
    if(!isMeaningfulSnapshot(snap)) {
      console.log('[sync-state] server snapshot not meaningful, ignoring', snap);
      return false;
    }

    const LS_BANK_KEY   = `izzaBank_${USER}`;
    const LS_HEARTS_KEY = `izzaCurHeartSegments_${USER}`;

    // WALLET
    const wallet = snap.coins|0;
    try{
      if (window.IZZA?.api?.setCoins) {
        window.IZZA.api.setCoins(wallet);
      } else {
        setLS('izzaCoins', String(wallet));
        try{ window.dispatchEvent(new Event('izza-coins-changed')); }catch{}
      }
    }catch{
      setLS('izzaCoins', String(wallet));
      try{ window.dispatchEvent(new Event('izza-coins-changed')); }catch{}
    }

    // BANK
    if(snap.bank && typeof snap.bank==='object'){
      setLSJSON(LS_BANK_KEY, {
        coins: snap.bank.coins|0,
        items: snap.bank.items || {},
        ammo:  snap.bank.ammo  || {}
      });
      try{ window.dispatchEvent(new Event('izza-bank-changed')); }catch{}
    }

    // Inventory
    if(snap.inventory && typeof snap.inventory==='object'){
      setLSJSON('izzaInventory', snap.inventory);
      try{ window.dispatchEvent(new Event('izza-inventory-changed')); }catch{}
    }

    // Hearts
    if(snap.player && snap.player.heartsSegs!=null){
      setLS(LS_HEARTS_KEY, String(snap.player.heartsSegs|0));
      if(typeof window._redrawHeartsHud === 'function'){
        try{ window._redrawHeartsHud(); }catch{}
      }
    }

    return true;
  }

  // Debounced saver + movement watcher
  function makeSmartSaver(USER, minIntervalMs){
    let timer=null, lastQueued=null;

    // Track deltas so movement triggers saves even if coins/bank unchanged
    let lastPos={x:null,y:null}, lastCoins=-1, lastBank=-1, lastInvSig='';

    function invSignature(obj){
      try{ return JSON.stringify(obj||{}); }catch{ return ''; }
    }

    function queue(){
      const snap = buildSnapshot(USER);
      const posChanged   = (snap.player?.x|0)!==lastPos.x || (snap.player?.y|0)!==lastPos.y;
      const coinsChanged = (snap.coins|0)!==lastCoins;
      const bankChanged  = (snap.bank?.coins|0)!==lastBank ||
                           Object.keys(snap.bank?.items||{}).length!==0 ||
                           Object.keys(snap.bank?.ammo ||{}).length!==0;
      const invSig       = invSignature(snap.inventory);
      const invChanged   = invSig !== lastInvSig;

      if(!(posChanged || coinsChanged || bankChanged || invChanged)){
        return;
      }

      lastPos   = { x:(snap.player?.x|0), y:(snap.player?.y|0) };
      lastCoins = (snap.coins|0);
      lastBank  = (snap.bank?.coins|0);
      lastInvSig= invSig;

      lastQueued = snap;
      if(timer) return;
      timer = setTimeout(()=>{
        const s = lastQueued; timer=null; lastQueued=null;
        pushSnapshot(USER, s);
      }, minIntervalMs);
    }

    return queue;
  }

  // ========= boot wiring =========
  (async function boot(){
    try{ if (window.izzaLS && typeof izzaLS.ready === 'function') await izzaLS.ready(); }catch{}

    // wait for core
    let tries=0;
    while(!(window.IZZA && window.IZZA.api && window.IZZA.api.ready) && tries<200){
      await sleep(25); tries++;
    }

    const USER = resolveUser();
    console.log('[sync-state] user=', USER);

    // ---------- Restore (give the map/tiers time) ----------
    await sleep(1200);
    await sleep(800);

    const serverSnap = await fetchSnapshot(USER);
    if(serverSnap) applySnapshot(USER, serverSnap);

    // ---------- LIVE SAVE ----------
    const saveSoon = makeSmartSaver(USER, 700);

    window.addEventListener('izza-bank-changed', saveSoon);
    window.addEventListener('izza-inventory-changed', saveSoon);
    window.addEventListener('izza-coins-changed', saveSoon);

    if(window.IZZA && IZZA.on){
      IZZA.on('update-post', ()=>{ saveSoon(); });
    }

    // Save on hide/unload — with Blob beacon for Pi
    function flushNow(){
      const snap = buildSnapshot(USER);
      if(!isMeaningfulSnapshot(snap)) return;
      try{
        const blob = new Blob([JSON.stringify(snap)], {type:'application/json'});
        const ok = navigator.sendBeacon(SNAP_PATH(USER) + '?t=' + Date.now(), blob);
        if(!ok) postJSON(SNAP_PATH(USER), snap);
      }catch{
        postJSON(SNAP_PATH(USER), snap);
      }
    }
    document.addEventListener('visibilitychange', ()=>{ if(document.visibilityState==='hidden') flushNow(); });
    window.addEventListener('pagehide', flushNow);

    // Initial opportunistic save (if meaningful)
    const initial = buildSnapshot(USER);
    if(isMeaningfulSnapshot(initial)) pushSnapshot(USER, initial);
  })();
})();
