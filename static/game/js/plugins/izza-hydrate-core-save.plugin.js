// /static/game/js/plugins/izza-hydrate-core-save.plugin.js
(function(){
  // ===== tiny "restoring" overlay =====
  const overlay = document.createElement('div');
  Object.assign(overlay.style,{
    position:'fixed', inset:'0', background:'rgba(5,8,14,.86)', display:'flex',
    alignItems:'center', justifyContent:'center', zIndex: 99999, color:'#cfe0ff',
    fontFamily:'system-ui, -apple-system, Segoe UI, Roboto, sans-serif', fontSize:'15px'
  });
  overlay.innerHTML = `<div style="padding:14px 18px;border:1px solid #394769;border-radius:10px;background:#0b1120">
    Restoring your game…</div>`;

  const addOverlay = ()=>{ if(!overlay.isConnected) document.body.appendChild(overlay); };
  const removeOverlay = ()=>{ if(overlay.isConnected) overlay.remove(); };

  // ===== utils =====
  function safeParse(s, fb){ try{ return JSON.parse(s); }catch{ return fb; } }
  const getLS = (k, fb=null)=> { const v=localStorage.getItem(k); return v==null? fb : v; };
  const setLS = (k, v)=> localStorage.setItem(k, v);
  const getLSJSON = (k, fb=null)=> safeParse(getLS(k, null), fb);
  const setLSJSON = (k, obj)=> setLS(k, JSON.stringify(obj));

  function waitFrames(n=1){ return new Promise(res=>{ let left=n; function tick(){ if(--left<=0) res(); else requestAnimationFrame(tick); } requestAnimationFrame(tick); }); }
  function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

  function isEmptySnapshot(s){
    if(!s || typeof s!=='object') return true;
    if (s.version !== 1) return false;
    const coinsTop = (s.coins|0)||0;
    const invEmpty = !s.inventory || Object.keys(s.inventory).length===0;
    const bank = s.bank||{};
    const bankCoins = (bank.coins|0)||0;
    const bankEmpty = bankCoins===0 &&
      (!bank.items || Object.keys(bank.items).length===0) &&
      (!bank.ammo  || Object.keys(bank.ammo ).length===0);
    return coinsTop===0 && invEmpty && bankEmpty;
  }

  function userName(){
    const p = (window.__IZZA_PROFILE__) || {};
    const fromPlugin = (window.izzaUserKey && typeof izzaUserKey.get==='function') ? izzaUserKey.get() : null;
    return (p.username || p.user || fromPlugin || getLS('izzaUserKey') || 'guest').toLowerCase();
  }

  // ===== server fetch (prefer LastGood) =====
  async function fetchSnapshot(u){
    const base = (window.__IZZA_API_BASE__) || '/api';
    // First, ask explicitly for LastGood:
    let r = await fetch(`${base}/state/${encodeURIComponent(u)}?prefer=lastGood`, { cache:'no-store' });
    if (r.ok){
      const js = await r.json();
      if (!isEmptySnapshot(js)) return js;
    }
    // Fallback: latest valid
    r = await fetch(`${base}/state/${encodeURIComponent(u)}`, { cache:'no-store' });
    if (r.ok){
      const js = await r.json();
      if (!isEmptySnapshot(js)) return js;
    }
    return null;
  }

  // ===== apply snapshot to the running cores =====
  function applySnapshot(snap, USER){
    // --- coins/bank mirrors ---
    const BANK_KEY = `izzaBank_${USER}`;
    const LASTGOOD_LS = `izzaBankLastGood_${USER}`;

    // Keep a local last-good mirror for absolute safety
    setLSJSON(LASTGOOD_LS, snap);

    // Bank (mirror for other plugins)
    setLSJSON(BANK_KEY, {
      coins: (snap.bank && (snap.bank.coins|0)) || 0,
      items: (snap.bank && snap.bank.items) || {},
      ammo:  (snap.bank && snap.bank.ammo)  || {}
    });

    // === NEW: hydrate on-hand coins from snapshot via core ===
    const coinsOnHand = (snap.coins|0) || 0;
    if (window.IZZA && IZZA.api && typeof IZZA.api.setCoins === 'function') {
      try { IZZA.api.setCoins(coinsOnHand); } catch(e){ console.warn('[hydrate coins] setCoins failed', e); }
    } else {
      // Fallback to LS + pill if core setter isn't ready yet
      try {
        setLS('izzaCoins', String(coinsOnHand));
        const pill = document.getElementById('coinPill');
        if(pill) pill.textContent = `Coins: ${coinsOnHand} IC`;
      } catch(e){}
    }
    // Let autosave & listeners react
    try { window.dispatchEvent(new Event('izza-coins-changed')); } catch {}

    // Legacy keys / Core v2
    const invList = Object.keys(snap.inventory || {});
    const missions = (snap.missions|0) || (snap.missionsCompleted|0) || (parseInt(getLS('izzaMissions')||'0',10)||0);
    setLSJSON('izza_save_v1', {
      coins: coinsOnHand,
      missionsCompleted: missions,
      inventory: invList
    });
    setLS('izzaMissions', String(missions));

    // Hearts (optional)
    if (snap.player && typeof snap.player.heartsSegs === 'number'){
      setLS(`izzaCurHeartSegments_${USER}`, String(snap.player.heartsSegs|0));
      // custom HUD hook if present
      if (typeof window._redrawHeartsHud === 'function') {
        try { window._redrawHeartsHud(); } catch {}
      }
    }

    // Position: cores read from IZZA.api or internal player; expose a gentle nudge:
    if (window.IZZA && window.IZZA.api && window.IZZA.api.player && snap.player) {
      const p = window.IZZA.api.player;
      if (typeof snap.player.x === 'number') p.x = snap.player.x;
      if (typeof snap.player.y === 'number') p.y = snap.player.y;
      if (window.IZZA.api.doorSpawn) {
        // keep camera sane after teleports
        try {
          window.IZZA.api.camera.x = p.x - 200;
          window.IZZA.api.camera.y = p.y - 120;
        } catch {}
      }
    }

    // Broadcast to any HUD/UI listeners
    try { window.dispatchEvent(new Event('izza-bank-changed')); } catch {}
  }

  // ===== boot sequence =====
  async function hydrateAfterGameSettles(){
    addOverlay();

    // 1) Wait for cores to say they're ready (Core v3 emits IZZA.emit('ready'))
    //    If not present, just wait a bit.
    let readySeen = false;
    const waitReady = new Promise(async (resolve)=>{
      if (window.IZZA && window.IZZA.api && window.IZZA.api.ready) {
        readySeen = true; return resolve();
      }
      const handler = ()=>{ readySeen = true; resolve(); };
      try {
        (window.IZZA = window.IZZA || {}).on?.('ready', handler);
      } catch {}
      // fallback: 1s
      await sleep(1000);
      resolve();
    });
    await waitReady;

    // 2) Allow the map expander / refresh to run first.
    //    We wait for a few render cycles + fixed delay so tier changes settle.
    //    Also listen for an IZZA 'update-post' tick to ensure at least a frame.
    let gotTick = false;
    const onTick = ()=>{ gotTick = true; };
    try { (window.IZZA = window.IZZA || {}).on?.('update-post', onTick); } catch {}
    await waitFrames(6);       // ~6 frames
    await sleep(450);          // settle UI / images
    if (!gotTick) await waitFrames(6);

    const USER = userName();

    // 3) Fetch server snapshot with LastGood preference
    let snap = null;
    try { snap = await fetchSnapshot(USER); } catch {}
    if (!snap) {
      // fallback to local LastGood mirror if present
      const localLG = getLSJSON(`izzaBankLastGood_${USER}`, null);
      if (localLG && !isEmptySnapshot(localLG)) snap = localLG;
    }

    if (!snap || isEmptySnapshot(snap)) {
      console.warn('[hydrate] No valid snapshot found; skipping apply');
      removeOverlay();
      return;
    }

    // 4) Apply to cores and legacy keys
    applySnapshot(snap, USER);

    // tiny grace to avoid flicker while HUD updates
    await waitFrames(2);
    removeOverlay();
  }

  // Kick it off after DOM ready so the overlay can mount cleanly
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', hydrateAfterGameSettles, { once:true });
  } else {
    hydrateAfterGameSettles();
  }
})();
