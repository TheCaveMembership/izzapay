(function(){
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
    const wallet = (s.coins|0)||0;             // WALLET
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

  // ---- derive money (coins = wallet; bank.coins = bank) ----
  function deriveMoneyFields(snap){
    const onHand = (snap && (snap.coins|0)) || 0;                 // WALLET
    const bank   = (snap && snap.bank && (snap.bank.coins|0)) || 0; // BANK
    return { onHand, bank };
  }

  // ===== quick pre-seed (only if bank plugin is NOT present) =====
  (function preseedEarly(){
    if (window.__IZZA_MONEY_OWNER__ === 'bank-plugin') return; // money handled by bank plugin
    const USER = userName();
    const localLG = getLSJSON(`izzaBankLastGood_${USER}`, null);
    if (localLG && !isEmptySnapshot(localLG)) {
      const money = deriveMoneyFields(localLG);
      setLS('izzaCoins', String(money.onHand));
      setLSJSON(`izzaBank_${USER}`, {
        coins: money.bank,
        items: (localLG.bank && localLG.bank.items) || {},
        ammo:  (localLG.bank && localLG.bank.ammo)  || {}
      });
    }
  })();

  // ===== apply snapshot to the running cores =====
  function applySnapshot(snap, USER){
    setLSJSON(`izzaBankLastGood_${USER}`, snap);

    if (window.__IZZA_MONEY_OWNER__ !== 'bank-plugin'){
      const money = deriveMoneyFields(snap);
      setLSJSON(`izzaBank_${USER}`, {
        coins: money.bank,
        items: (snap.bank && snap.bank.items) || {},
        ammo:  (snap.bank && snap.bank.ammo)  || {}
      });
      setLS('izzaCoins', String(money.onHand));
      if (window.IZZA?.api?.setCoins) {
        try { IZZA.api.setCoins(money.onHand); } catch(e){ console.warn('[hydrate coins] setCoins failed', e); }
      } else {
        try {
          const pill = document.getElementById('coinPill');
          if(pill) pill.textContent = `Wallet: ${money.onHand} IC`;
        } catch(e){}
      }
      try { window.dispatchEvent(new Event('izza-bank-changed')); } catch {}
      try { window.dispatchEvent(new Event('izza-coins-changed')); } catch {}
    }

    // Legacy keys / Core v2 compatibility
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
    // 1) Wait for cores to be ready (or 1s)
    const waitReady = new Promise(async (resolve)=>{
      if (window.IZZA?.api?.ready) return resolve();
      try { (window.IZZA = window.IZZA || {}).on?.('ready', resolve); } catch {}
      await sleep(1000);
      resolve();
    });
    await waitReady;

    // 2) Let frames settle
    await waitFrames(6);
    await sleep(450);

    const USER = userName();

    // 3) Fetch server snapshot
    let snap = null;
    try { snap = await fetchSnapshot(USER); } catch {}
    if (!snap) {
      const localLG = getLSJSON(`izzaBankLastGood_${USER}`, null);
      if (localLG && !isEmptySnapshot(localLG)) snap = localLG;
    }

    if (!snap || isEmptySnapshot(snap)) {
      console.warn('[hydrate] No valid snapshot found; skipping apply');
      return;
    }

    // 4) Apply
    applySnapshot(snap, USER);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', hydrateAfterGameSettles, { once:true });
  } else {
    hydrateAfterGameSettles();
  }
})();
