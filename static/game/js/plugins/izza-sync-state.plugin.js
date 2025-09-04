// /static/game/js/plugins/izza-sync-state.plugin.js
(function(){
  const API_ORIGIN = 'https://izzagame.onrender.com';    // <- your persist service base
  const SNAP_PATH  = user => `${API_ORIGIN}/api/state/${encodeUser(user)}`;

  // ---------- utils ----------
  function encodeUser(u){ return String(u||'guest').toLowerCase().replace(/[^a-z0-9-_]/g,'-'); }
  function now(){ return Date.now(); }
  function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
  function safeJSON(s, fb){ try{ return JSON.parse(s); }catch{ return fb; } }
  function getLS(k, fb){ const v = localStorage.getItem(k); return v==null? fb : v; }
  function getLSJSON(k, fb){ return safeJSON(getLS(k, null), fb); }
  function setLS(k, v){ localStorage.setItem(k, v); }
  function setLSJSON(k, o){ setLS(k, JSON.stringify(o)); }

  // Guards so we never write an "empty" snapshot that wipes progress
  function isMeaningfulSnapshot(s){
    if(!s || typeof s!=='object') return false;
    const invNonEmpty = s.inventory && Object.keys(s.inventory).length>0;
    const bankNonEmpty = s.bank && (
      (s.bank.coins|0) > 0 ||
      (s.bank.items && Object.keys(s.bank.items).length>0) ||
      (s.bank.ammo  && Object.keys(s.bank.ammo).length>0)
    );
    const coins = (s.coins|0) > 0;
    const heartsKnown = s.player && (s.player.heartsSegs!=null);
    return invNonEmpty || bankNonEmpty || coins || heartsKnown;
  }

  // Resolve current user like diagnostics/userkey does
  function resolveUser(){
    const p = (window.__IZZA_PROFILE__) || {};
    const fromPlugin = (window.izzaUserKey && typeof izzaUserKey.get==='function') ? izzaUserKey.get() : null;
    const fromLS     = getLS('izzaUserKey', null);
    return encodeUser(p.username || p.user || fromPlugin || fromLS || 'guest');
  }

  // Compose a snapshot from current game + localStorage
  function buildSnapshot(USER){
    const LS_BANK_KEY   = `izzaBank_${USER}`;
    const LS_HEARTS_KEY = `izzaCurHeartSegments_${USER}`;

    // Bank blob produced by your bank plugin (coins/items/ammo)
    const bank = getLSJSON(LS_BANK_KEY, { coins:0, items:{}, ammo:{} });

    // Coins mirror some cores expect
    const coinsMirror = (() => {
      const direct = parseInt(getLS('izzaCoins'), 10);
      if(Number.isFinite(direct) && direct>=0) return direct|0;
      return bank.coins|0;
    })();

    // Inventory shape (object map is fine; some older cores like an array/list, but we keep full map here)
    const inventory = getLSJSON('izzaInventory', {});

    // Player + hearts from core v3 + LS
    const api = (window.IZZA && window.IZZA.api) || {};
    const player = api.player || { x:0, y:0 };
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
      coins: coinsMirror|0,
      inventory,
      bank,
      timestamp: now()
    };
  }

  // Push snapshot to server (prefers sendBeacon)
  function pushSnapshot(USER, snapshot){
    if(!isMeaningfulSnapshot(snapshot)) {
      console.log('[sync-state] skip save (not meaningful)', snapshot);
      return;
    }
    const url  = SNAP_PATH(USER);
    const body = JSON.stringify(snapshot);
    // Try sendBeacon first (works well on Pi Browser/iOS)
    try{
      if(navigator.sendBeacon && navigator.sendBeacon(url, body)){
        console.log('[sync-state] beacon ok');
        return;
      }
    }catch(e){}
    // Fallback to fetch
    fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body })
      .then(()=>console.log('[sync-state] fetch ok'))
      .catch(err=>console.warn('[sync-state] save failed', err));
  }

  // Pull snapshot from server
  async function fetchSnapshot(USER){
    const url = SNAP_PATH(USER) + `?t=${now()}`;
    try{
      const res = await fetch(url, { credentials:'omit', cache:'no-store' });
      if(!res.ok) throw new Error(res.status+'');
      return await res.json();
    }catch(e){
      console.warn('[sync-state] fetch snapshot failed', e);
      return null;
    }
  }

  // Apply a server snapshot back into the game’s LS & notifiers (bank+inventory+coins only)
  function applySnapshot(USER, snap){
    if(!isMeaningfulSnapshot(snap)) {
      console.log('[sync-state] server snapshot not meaningful, ignoring', snap);
      return false;
    }

    const LS_BANK_KEY   = `izzaBank_${USER}`;
    const LS_HEARTS_KEY = `izzaCurHeartSegments_${USER}`;

    // Bank
    if(snap.bank && typeof snap.bank==='object'){
      setLSJSON(LS_BANK_KEY, {
        coins: snap.bank.coins|0,
        items: snap.bank.items || {},
        ammo:  snap.bank.ammo  || {}
      });
      // Mirror coin pill keys various cores read
      setLS('izzaCoins', String((snap.bank.coins|0)));
    }

    // Coins mirror (top-level coins) if it’s higher than bank coins (keep the best)
    if((snap.coins|0) > (parseInt(getLS('izzaCoins')||'0',10)|0)){
      setLS('izzaCoins', String(snap.coins|0));
    }

    // Inventory map
    if(snap.inventory && typeof snap.inventory==='object'){
      setLSJSON('izzaInventory', snap.inventory);
    }

    // Hearts (optional)
    if(snap.player && snap.player.heartsSegs!=null){
      setLS(LS_HEARTS_KEY, String(snap.player.heartsSegs|0));
      // let any HUD know to redraw if they exposed the hook
      if(typeof window._redrawHeartsHud === 'function'){
        try{ window._redrawHeartsHud(); }catch{}
      }
    }

    // Notify any listeners (cores/plugins) that bank/inv changed
    try{ window.dispatchEvent(new Event('izza-bank-changed')); }catch{}
    return true;
  }

  // Debounced saver: collect quick changes and save at most every N ms
  function makeDebouncedSaver(USER, intervalMs){
    let timer=null, lastQueued=null;
    return function queue(){
      lastQueued = buildSnapshot(USER);
      if(timer) return;
      timer = setTimeout(()=>{
        const snap = lastQueued;
        timer=null; lastQueued=null;
        pushSnapshot(USER, snap);
      }, intervalMs);
    };
  }

  // ========= boot wiring =========
  (async function boot(){
    // wait for LS/userkey plugin if present
    try{ if (window.izzaLS && typeof izzaLS.ready === 'function') await izzaLS.ready(); }catch{}

    // wait for core v3 (or v2) to expose IZZA.api
    let tries=0;
    while(!(window.IZZA && window.IZZA.api && window.IZZA.api.ready) && tries<200){
      await sleep(25); tries++;
    }

    const USER = resolveUser();
    console.log('[sync-state] user=', USER);

    // ---------- LATE RESTORE ----------
    // Give time for map expansion / tier refresh / initial core reflows
    // You said “even later”—so we use a generous staged wait.
    await sleep(1200);       // first settle
    await sleep(1500);       // extra settle (total ~2.7s after ready)

    // Pull the server snapshot and apply iff meaningful (never apply an empty one)
    const serverSnap = await fetchSnapshot(USER);
    if(serverSnap) applySnapshot(USER, serverSnap);

    // ---------- LIVE SAVE ----------
    const saveSoon = makeDebouncedSaver(USER, 1200);

    // Save when bank or inventory changes
    window.addEventListener('izza-bank-changed', saveSoon);

    // Also opportunistically save every few seconds during gameplay
    if(window.IZZA && IZZA.on){
      IZZA.on('update-post', ()=>{
        // throttle via debounce
        saveSoon();
      });
    }

    // Save when page is hidden / unloaded
    document.addEventListener('visibilitychange', ()=>{
      if(document.visibilityState==='hidden'){
        const snap = buildSnapshot(USER);
        pushSnapshot(USER, snap);
      }
    });
    window.addEventListener('pagehide', ()=>{
      const snap = buildSnapshot(USER);
      pushSnapshot(USER, snap);
    });

    // Initial save (only if meaningful), in case you started with a populated LS but no file yet
    const initial = buildSnapshot(USER);
    if(isMeaningfulSnapshot(initial)) pushSnapshot(USER, initial);
  })();
})();
