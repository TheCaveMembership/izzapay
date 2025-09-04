(function(){
  // ---------------- overlay (only while applying) ----------------
  const overlay = document.createElement('div');
  Object.assign(overlay.style,{
    position:'fixed', inset:'0', background:'rgba(5,8,14,.85)', display:'none',
    alignItems:'center', justifyContent:'center', zIndex: 99999, color:'#cfe0ff',
    fontFamily:'system-ui,-apple-system,Segoe UI,Roboto,sans-serif', fontSize:'15px'
  });
  overlay.innerHTML = `<div style="padding:14px 18px;border:1px solid #394769;border-radius:10px;background:#0b1120">
    Loading your game…</div>`;
  document.addEventListener('DOMContentLoaded', ()=> document.body.appendChild(overlay));

  // ---------------- utils ----------------
  const safeParse=(s,f)=>{ try{ return JSON.parse(s); }catch{ return f; } };
  const get=(k,f)=>{ const v=localStorage.getItem(k); return v==null?f:v; };
  const getJSON=(k,f)=> safeParse(get(k,null), f);
  const set=(k,v)=> localStorage.setItem(k,v);
  const setJSON=(k,o)=> set(k, JSON.stringify(o));
  const raf=()=> new Promise(r=> requestAnimationFrame(()=>r()));

  function now(){ return Date.now(); }
  function ts(obj){ return (obj && typeof obj.ts==='number') ? obj.ts : 0; }
  function isEmptyBank(b){
    if(!b || typeof b!=='object') return true;
    const coins = (b.coins|0);
    const items = b.items && typeof b.items==='object' ? Object.keys(b.items).length : 0;
    const ammo  = b.ammo  && typeof b.ammo ==='object' ? Object.keys(b.ammo ).length : 0;
    return (coins<=0) && items===0 && ammo===0;
  }

  function getUserKey(){
    const p = (window.__IZZA_PROFILE__)||{};
    const fromPlugin = (window.izzaUserKey && typeof izzaUserKey.get==='function') ? izzaUserKey.get() : null;
    return (p.username || p.user || fromPlugin || get('izzaUserKey') || 'guest').toLowerCase();
  }

  // ---------------- boot + map + quiet gate ----------------
  async function waitUntilReallySettled(){
    // 1) wait for core boot (pref v3 'ready')
    let readyPromise = null;
    if (window.IZZA && typeof window.IZZA.on==='function'){
      readyPromise = new Promise(resolve=>{
        let fired=false;
        window.IZZA.on('ready', ()=>{ if(fired) return; fired=true; (async()=>{ await raf(); await raf(); resolve(); })(); });
      });
    }
    const framesFallback = (async()=>{ await raf(); await raf(); await raf(); })();
    await Promise.race([readyPromise || framesFallback, new Promise(r=> setTimeout(r, 1500))]);

    // 2) wait for map tier to stop changing
    let lastTier = localStorage.getItem('izzaMapTier') || '1';
    let stableFrames = 0;
    const wantStableFrames = 10; // be extra safe
    const sample = ()=> {
      const cur = localStorage.getItem('izzaMapTier') || '1';
      if (cur===lastTier) stableFrames++; else { lastTier=cur; stableFrames=0; }
      return stableFrames>=wantStableFrames;
    };
    if (window.IZZA && typeof window.IZZA.on==='function'){
      await new Promise(resolve=>{
        const handler = ()=> { if (sample()) resolve(); };
        window.IZZA.on('render-post', handler);
      });
    } else {
      for(;;){ await raf(); if(sample()) break; }
    }

    // 3) long quiet window: bank key not changing for QUIET_MS
    const QUIET_MS = 2000;     // <- wait longer
    const MAX_WAIT = 12000;    // hard cap
    const start = performance.now();
    const user = getUserKey();
    const BANK_KEY = `izzaBank_${user}`;
    let lastRaw = get(BANK_KEY, '');
    let quietStart = performance.now();

    while (performance.now() - start < MAX_WAIT){
      await raf();
      const curRaw = get(BANK_KEY, '');
      if (curRaw === lastRaw){
        if (performance.now() - quietStart >= QUIET_MS) break; // stable long enough
      } else {
        lastRaw = curRaw;
        quietStart = performance.now(); // reset quiet timer
      }
    }

    // one extra frame for layout
    await raf();
  }

  // ---------------- choose LAST GOOD snapshot ----------------
  function pickBestBank(USER){
    const CUR   = getJSON(`izzaBank_${USER}`,              null);
    const PREV  = getJSON(`izzaBank_${USER}__prev`,        null);
    const LG    = getJSON(`izzaBankLastGood_${USER}`,      null);

    // prefer the newest non-empty snapshot
    const candidates = [CUR, PREV, LG].filter(Boolean)
      .filter(b=> !isEmptyBank(b))
      .sort((a,b)=> ts(b) - ts(a));
    if (candidates.length) return candidates[0];

    // as a last resort, if CUR has structure but empty, refuse to hydrate
    return null;
  }

  // ---------------- persist "lastGood" defensively ----------------
  function stashLastGood(USER, bank){
    try{
      if (!isEmptyBank(bank)){
        const withTs = Object.assign({ ts: now() }, bank);
        setJSON(`izzaBankLastGood_${USER}`, withTs);
      }
    }catch{}
  }

  // Also record a lastGood on navigation away (helps future boots)
  window.addEventListener('beforeunload', ()=>{
    try{
      const USER = getUserKey();
      const cur = getJSON(`izzaBank_${USER}`, null);
      if (cur && !isEmptyBank(cur)) stashLastGood(USER, cur);
    }catch{}
  });

  // ---------------- hydrate ----------------
  async function hydrate(){
    // wait for LS wrapper/userkey if present
    try{ if (window.izzaLS && typeof izzaLS.ready==='function') await izzaLS.ready(); }catch{}

    const USER = getUserKey();

    // pick best non-empty snapshot (current -> prev -> lastGood)
    const bank = pickBestBank(USER);
    if (!bank){
      console.warn('[IZZA hydrate] No non-empty bank snapshot available; skipping hydration.');
      return; // IMPORTANT: do not write blank legacy keys
    }

    overlay.style.display = 'flex';

    const missions = parseInt(get('izzaMissions') || '0', 10) || 0;
    const inventory = Object.keys(bank.items || {});

    // write legacy keys for cores that read them
    setJSON('izza_save_v1', {
      coins: bank.coins|0,
      missionsCompleted: missions,
      inventory
    });
    set('izzaCoins', String(bank.coins|0));

    // live push to Core v3 HUD if available
    try{
      if (window.IZZA && window.IZZA.api && typeof window.IZZA.api.setCoins==='function'){
        window.IZZA.api.setCoins(bank.coins|0);
      }
    }catch{}

    // notify listeners
    try{ window.dispatchEvent(new Event('izza-bank-changed')); }catch{}

    // remember this as lastGood to help next boot
    stashLastGood(USER, bank);

    console.log('[IZZA hydrate] applied bank snapshot', bank);

    setTimeout(()=>{ overlay.style.display = 'none'; }, 220);
  }

  // ---------------- boot flow ----------------
  (async function boot(){
    try{
      await waitUntilReallySettled();  // wait longer + quiet window
      await hydrate();
    }catch(err){
      console.error('[IZZA hydrate] error', err);
      try{ overlay.style.display='none'; }catch{}
    }
  })();
})();
