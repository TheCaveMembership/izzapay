<!-- /static/game/js/plugins/izza-sync-state.plugin.js -->
<script>
(function(){
  const API_ORIGIN = 'https://izzagame.onrender.com';    // persist service base
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

  // Never save/restore meaningless snapshots
  function isMeaningfulSnapshot(s){
    if(!s || typeof s!=='object') return false;
    const invNonEmpty  = s.inventory && Object.keys(s.inventory).length>0;
    const bankNonEmpty = s.bank && (
      (s.bank.coins|0) > 0 ||
      (s.bank.items && Object.keys(s.bank.items).length>0) ||
      (s.bank.ammo  && Object.keys(s.bank.ammo).length>0)
    );
    const walletCoins  = (s.coins|0) > 0;                 // <- wallet only
    const heartsKnown  = s.player && (s.player.heartsSegs!=null);
    return invNonEmpty || bankNonEmpty || walletCoins || heartsKnown;
  }

  // Resolve current user (same canon as diagnostics)
  function resolveUser(){
    const p = (window.__IZZA_PROFILE__) || {};
    const fromPlugin = (window.izzaUserKey && typeof izzaUserKey.get==='function') ? izzaUserKey.get() : null;
    const fromLS     = getLS('izzaUserKey', null);
    return encodeUser(p.username || p.user || fromPlugin || fromLS || 'guest');
  }

  // ---------- Build snapshot (wallet + bank kept separate; NO total) ----------
  function buildSnapshot(USER){
    const LS_BANK_KEY   = `izzaBank_${USER}`;
    const LS_HEARTS_KEY = `izzaCurHeartSegments_${USER}`;

    // Bank blob produced by the bank UI/plugin (coins/items/ammo)
    const bank = getLSJSON(LS_BANK_KEY, { coins:0, items:{}, ammo:{} });

    // WALLET: strictly read wallet coins (never fall back to bank)
    const walletCoins = (()=>{
      // Prefer core API if available to also update HUD in one place elsewhere
      if (window.IZZA?.api?.getCoins) {
        try { return (window.IZZA.api.getCoins()|0); } catch {}
      }
      const direct = parseInt(getLS('izzaCoins'), 10);
      return Number.isFinite(direct) && direct>=0 ? (direct|0) : 0;
    })();

    // Inventory map
    const inventory = getLSJSON('izzaInventory', {});

    // Player + hearts (optional)
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
      coins: walletCoins|0,         // <- WALLET ONLY
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
    try{
      if(navigator.sendBeacon && navigator.sendBeacon(url, body)){
        console.log('[sync-state] beacon ok');
        return;
      }
    }catch(e){}
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

  // ---------- Apply snapshot (wallet from coins; bank from bank; no cross-talk) ----------
  function applySnapshot(USER, snap){
    if(!isMeaningfulSnapshot(snap)) {
      console.log('[sync-state] server snapshot not meaningful, ignoring', snap);
      return false;
    }

    const LS_BANK_KEY   = `izzaBank_${USER}`;
    const LS_HEARTS_KEY = `izzaCurHeartSegments_${USER}`;

    // WALLET: set from snap.coins ONLY
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

    // BANK: set from snap.bank ONLY (never mirror to wallet)
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

    // Hearts (optional)
    if(snap.player && snap.player.heartsSegs!=null){
      setLS(LS_HEARTS_KEY, String(snap.player.heartsSegs|0));
      if(typeof window._redrawHeartsHud === 'function'){
        try{ window._redrawHeartsHud(); }catch{}
      }
    }

    return true;
  }

  // Debounced saver
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

    // wait for core to expose IZZA.api
    let tries=0;
    while(!(window.IZZA && window.IZZA.api && window.IZZA.api.ready) && tries<200){
      await sleep(25); tries++;
    }

    const USER = resolveUser();
    console.log('[sync-state] user=', USER);

    // ---------- LATE RESTORE ----------
    await sleep(1200);  // settle after ready
    await sleep(1500);  // extra settle

    const serverSnap = await fetchSnapshot(USER);
    if(serverSnap) applySnapshot(USER, serverSnap);

    // ---------- LIVE SAVE ----------
    const saveSoon = makeDebouncedSaver(USER, 1200);

    // Save when bank / inventory / coins change
    window.addEventListener('izza-bank-changed', saveSoon);
    window.addEventListener('izza-inventory-changed', saveSoon);
    window.addEventListener('izza-coins-changed', saveSoon);

    // Also opportunistically save during gameplay
    if(window.IZZA && IZZA.on){
      IZZA.on('update-post', ()=>{ saveSoon(); });
    }

    // Save on hide/unload
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

    // Initial save if LS already has content
    const initial = buildSnapshot(USER);
    if(isMeaningfulSnapshot(initial)) pushSnapshot(USER, initial);
  })();
})();
</script>
