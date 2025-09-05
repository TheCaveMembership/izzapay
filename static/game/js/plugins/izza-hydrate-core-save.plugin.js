<!-- /static/game/js/plugins/izza-hydrate-core-save.plugin.js -->
<script>
(function(){
  // ===== tiny overlay =====
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
    const wallet = (s.coins|0)||0;
    const invEmpty = !s.inventory || Object.keys(s.inventory).length===0;
    const bank = s.bank||{};
    const bankCoins = (bank.coins|0)||0;
    const bankEmpty = bankCoins===0 &&
      (!bank.items || Object.keys(bank.items).length===0) &&
      (!bank.ammo  || Object.keys(bank.ammo ).length===0);
    return wallet===0 && invEmpty && bankEmpty;
  }

  function userName(){
    const p = (window.__IZZA_PROFILE__) || {};
    const fromPlugin = (window.izzaUserKey && typeof izzaUserKey.get==='function') ? izzaUserKey.get() : null;
    return (p.username || p.user || fromPlugin || getLS('izzaUserKey') || 'guest').toLowerCase();
  }

  // ===== server fetch (prefer LastGood) =====
  async function fetchSnapshot(u){
    const base = (window.__IZZA_API_BASE__) || '/api';
    let r = await fetch(`${base}/state/${encodeURIComponent(u)}?prefer=lastGood`, { cache:'no-store' });
    if (r.ok){
      const js = await r.json();
      if (!isEmptySnapshot(js)) return js;
    }
    r = await fetch(`${base}/state/${encodeURIComponent(u)}`, { cache:'no-store' });
    if (r.ok){
      const js = await r.json();
      if (!isEmptySnapshot(js)) return js;
    }
    return null;
  }

  // ===== quick pre-seed if we are the money owner (we AREN’T if bank plugin loaded) =====
  (function preseedEarly(){
    if (window.__IZZA_MONEY_OWNER__ === 'bank-plugin') return;
    const USER = userName();
    const lg = getLSJSON(`izzaBankLastGood_${USER}`, null);
    if (lg && !isEmptySnapshot(lg)) {
      const wallet = (lg.coins|0) || 0;
      const bank   = (lg.bank && (lg.bank.coins|0)) || 0;
      setLS('izzaCoins', String(wallet));
      setLSJSON(`izzaBank_${USER}`, {
        coins: bank,
        items: (lg.bank && lg.bank.items) || {},
        ammo:  (lg.bank && lg.bank.ammo)  || {}
      });
    }
  })();

  // ===== apply snapshot to the running cores (skip MONEY if bank plugin owns it) =====
  function applySnapshot(snap, USER){
    // persist local last-good
    setLSJSON(`izzaBankLastGood_${USER}`, snap);

    // MONEY (wallet/bank only)
    if (window.__IZZA_MONEY_OWNER__ !== 'bank-plugin'){
      const wallet = (snap.coins|0) || 0;
      const bank   = (snap.bank && (snap.bank.coins|0)) || 0;
      setLSJSON(`izzaBank_${USER}`, {
        coins: bank,
        items: (snap.bank && snap.bank.items) || {},
        ammo:  (snap.bank && snap.bank.ammo)  || {}
      });
      setLS('izzaCoins', String(wallet));
      if (window.IZZA?.api?.setCoins) {
        try { IZZA.api.setCoins(wallet); } catch(e){ console.warn('[hydrate coins] setCoins failed', e); }
      } else {
        try {
          const pill = document.getElementById('coinPill');
          if(pill) pill.textContent = `Wallet: ${wallet} IC`;
        } catch(e){}
      }
      try { window.dispatchEvent(new Event('izza-bank-changed')); } catch {}
      try { window.dispatchEvent(new Event('izza-coins-changed')); } catch {}
    }

    // Legacy + missions
    const invList = Object.keys(snap.inventory || {});
    const missions = (snap.missions|0) || (snap.missionsCompleted|0) || (parseInt(getLS('izzaMissions')||'0',10)||0);
    setLSJSON('izza_save_v1', {
      coins: parseInt(getLS('izzaCoins')||'0',10) || 0,
      missionsCompleted: missions,
      inventory: invList
    });
    setLS('izzaMissions', String(missions));

    // Hearts
    if (snap.player && typeof snap.player.heartsSegs === 'number'){
      setLS(`izzaCurHeartSegments_${USER}`, String(snap.player.heartsSegs|0));
      if (typeof window._redrawHeartsHud === 'function') {
        try { window._redrawHeartsHud(); } catch {}
      }
    }

    // Position nudge
    if (window.IZZA?.api?.player && snap.player) {
      const p = window.IZZA.api.player;
      if (typeof snap.player.x === 'number') p.x = snap.player.x;
      if (typeof snap.player.y === 'number') p.y = snap.player.y;
      if (window.IZZA.api.doorSpawn) {
        try { window.IZZA.api.camera.x = p.x - 200; window.IZZA.api.camera.y = p.y - 120; } catch {}
      }
    }
  }

  // ===== boot sequence =====
  async function hydrateAfterGameSettles(){
    addOverlay();

    // 1) Wait for core ready (or 1s)
    let readySeen = false;
    const waitReady = new Promise(async (resolve)=>{
      if (window.IZZA?.api?.ready) { readySeen = true; return resolve(); }
      const handler = ()=>{ readySeen = true; resolve(); };
      try { (window.IZZA = window.IZZA || {}).on?.('ready', handler); } catch {}
      await sleep(1000);
      resolve();
    });
    await waitReady;

    // 2) Let first frames settle a bit
    await waitFrames(6);
    await sleep(450);

    const USER = userName();

    // 3) Fetch snapshot
    let snap = null;
    try { snap = await fetchSnapshot(USER); } catch {}
    if (!snap) {
      const localLG = getLSJSON(`izzaBankLastGood_${USER}`, null);
      if (localLG && !isEmptySnapshot(localLG)) snap = localLG;
    }

    if (!snap || isEmptySnapshot(snap)) {
      console.warn('[hydrate] No valid snapshot found; skipping apply');
      removeOverlay();
      return;
    }

    // 4) Apply
    applySnapshot(snap, USER);

    await waitFrames(2);
    removeOverlay();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', hydrateAfterGameSettles, { once:true });
  } else {
    hydrateAfterGameSettles();
  }
})();
</script>
