// /static/game/plugins/izza-hydrate-core-save.plugin.js
(function(){
  // ---- tiny overlay while we restore (only shown during actual writes) ----
  const overlay = document.createElement('div');
  Object.assign(overlay.style,{
    position:'fixed', inset:'0', background:'rgba(5,8,14,.85)', display:'none',
    alignItems:'center', justifyContent:'center', zIndex: 99999, color:'#cfe0ff',
    fontFamily:'system-ui, -apple-system, Segoe UI, Roboto, sans-serif', fontSize:'15px'
  });
  overlay.innerHTML = `<div style="padding:14px 18px;border:1px solid #394769;border-radius:10px;background:#0b1120">
    Loading your game…</div>`;
  document.addEventListener('DOMContentLoaded', ()=> document.body.appendChild(overlay));

  // ---- helpers ----
  const safeParse = (s,f)=>{ try{ return JSON.parse(s); }catch{ return f; } };
  const get      = (k,f)=>{ const v=localStorage.getItem(k); return v==null?f:v; };
  const getJSON  = (k,f)=> safeParse(get(k,null), f);
  const set      = (k,v)=> localStorage.setItem(k, v);
  const setJSON  = (k,o)=> set(k, JSON.stringify(o));
  const raf = () => new Promise(r=> requestAnimationFrame(()=> r()));

  // Resolve user key same way Diagnostics shows it
  function getUserKey(){
    const p = (window.__IZZA_PROFILE__)||{};
    const fromPlugin = (window.izzaUserKey && typeof izzaUserKey.get==='function') ? izzaUserKey.get() : null;
    return (p.username || p.user || fromPlugin || get('izzaUserKey') || 'guest').toLowerCase();
  }

  // ---- wait until cores are booted *and* the map expansion/refresh is settled ----
  async function waitUntilAfterBootAndMapRefresh(timeoutMs=8000){
    const t0 = performance.now();

    // A) Prefer Core v3 'ready'
    let readyPromise = null;
    if (window.IZZA && typeof window.IZZA.on === 'function') {
      readyPromise = new Promise(resolve=>{
        let fired=false;
        window.IZZA.on('ready', ()=>{
          if (fired) return; fired=true;
          // give HUD a couple frames
          (async()=>{ await raf(); await raf(); resolve(); })();
        });
      });
    }

    // B) Fallback for Core v1/v2: wait a few frames
    const framesFallback = (async()=>{ await raf(); await raf(); await raf(); })();

    await Promise.race([
      (readyPromise || framesFallback),
      new Promise(r=> setTimeout(r, 1200)) // guard: don’t block if nothing fires
    ]);

    // C) Now wait for "map tier" to become stable across several frames.
    //    (your expander sets izzaMapTier and triggers a refresh; we wait until it stops changing)
    let lastTier = localStorage.getItem('izzaMapTier') || '1';
    let stableFrames = 0;

    // If we have the IZZA render cycle, sample on render-post; otherwise sample per RAF.
    const useIzza = !!(window.IZZA && typeof window.IZZA.on === 'function');
    const done = new Promise(resolve=>{
      if (useIzza) {
        const handler = ()=>{
          const cur = localStorage.getItem('izzaMapTier') || '1';
          if (cur === lastTier) { stableFrames++; } else { lastTier = cur; stableFrames = 0; }
          if (stableFrames >= 6) { resolve(); } // ~6 frames of stability
        };
        window.IZZA.on('render-post', handler);
      } else {
        (async function pollRAF(){
          for(;;){
            await raf();
            const cur = localStorage.getItem('izzaMapTier') || '1';
            if (cur === lastTier) { stableFrames++; } else { lastTier = cur; stableFrames = 0; }
            if (stableFrames >= 6) break;
          }
          resolve();
        })();
      }
    });

    // Hard overall timeout so we never hang
    await Promise.race([done, new Promise(r=> setTimeout(r, Math.max(1500, timeoutMs - (performance.now()-t0))))]);

    // one more frame to let any last UI reflow finish
    await raf();
  }

  async function hydrate(){
    // Give the LS/userkey plugin a chance to init (no-op if it doesn’t exist)
    try{ if (window.izzaLS && typeof izzaLS.ready === 'function') await izzaLS.ready(); }catch{}

    const USER      = getUserKey();
    const BANK_KEY  = `izzaBank_${USER}`;                // {coins, items:{}, ammo:{}}
    const HEART_KEY = `izzaCurHeartSegments_${USER}`;    // optional, if you track hearts
    const bank      = getJSON(BANK_KEY, { coins:0, items:{}, ammo:{} });
    const missions  = parseInt(get('izzaMissions') || '0', 10) || 0;
    const inventory = Object.keys(bank.items || {});

    // Only show the overlay while we actually write/notify
    overlay.style.display = 'flex';

    // --- Write legacy/core keys so all cores see the same state ---
    setJSON('izza_save_v1', {
      coins: bank.coins|0,
      missionsCompleted: missions,
      inventory
    });
    set('izzaCoins', String(bank.coins|0));
    // leave HEART_KEY alone unless you already persist it elsewhere

    // If Core v3 is present, push coins through API for instant HUD update
    try{
      if (window.IZZA && window.IZZA.api && typeof window.IZZA.api.setCoins === 'function') {
        window.IZZA.api.setCoins(bank.coins|0);
      }
    }catch{}

    // Let any HUD/plugin listening re-read
    try{ window.dispatchEvent(new Event('izza-bank-changed')); }catch{}

    console.log('[IZZA hydrate] user=%s bank=%o', USER, bank);

    // small grace to avoid flicker on very low-end devices
    setTimeout(()=>{ overlay.style.display = 'none'; }, 200);
  }

  (async function boot(){
    try{
      await waitUntilAfterBootAndMapRefresh();  // <<< key change: wait until map expansion & refresh settle
      await hydrate();
    }catch(err){
      console.error('[IZZA hydrate] error', err);
      try{ overlay.style.display='none'; }catch{}
    }
  })();
})();
