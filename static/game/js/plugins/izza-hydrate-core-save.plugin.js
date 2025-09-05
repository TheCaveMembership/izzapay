/* IZZA hydrate — Core mirror (position/hearts/inventory legacy keys)
   - Skips MONEY if bank plugin owns it (bank-plugin writes the wallet/bank)
   - Waits for a real username
   - Uses canonical API base
   - Never applies an empty snapshot
*/
(function(){
  // ---------- API base (canonical) ----------
  const API_BASE = (function(){
    const b = (window.IZZA_PERSIST_BASE || '').replace(/\/+$/,'');
    if (b) return b + '/api';
    return 'https://izzagame.onrender.com/api';
  })();
  const SNAP = user => `${API_BASE}/state/${encodeURIComponent(user)}`;

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
  const safeParse = (s, fb)=>{ try{ return JSON.parse(s); }catch{ return fb; } };
  const getLS  = (k, fb=null)=> { const v=localStorage.getItem(k); return v==null? fb : v; };
  const setLS  = (k, v)=> localStorage.setItem(k, v);
  const getLSJSON = (k, fb=null)=> safeParse(getLS(k, null), fb);
  const setLSJSON = (k, obj)=> setLS(k, JSON.stringify(obj));
  const sleep = (ms)=> new Promise(r=>setTimeout(r,ms));
  const waitFrames = (n=1)=> new Promise(res=>{ let left=n; function tick(){ if(--left<=0) res(); else requestAnimationFrame(tick); } requestAnimationFrame(tick); });

  const CANON = s => (s==null?'guest':String(s)).replace(/^@+/,'').toLowerCase().replace(/[^a-z0-9-_]/g,'-');

  function isEmptySnapshot(s){
    if(!s || typeof s!=='object') return true;
    if (s.version !== 1) return false; // unknown versions treated as non-empty (be conservative)
    const coinsTop = (s.coins|0)||0; // wallet
    const invEmpty = !s.inventory || Object.keys(s.inventory).length===0;
    const bank = s.bank||{};
    const bankCoins = (bank.coins|0)||0;
    const bankEmpty = bankCoins===0 &&
      (!bank.items || Object.keys(bank.items).length===0) &&
      (!bank.ammo  || Object.keys(bank.ammo ).length===0);
    return coinsTop===0 && invEmpty && bankEmpty;
  }

  function resolveUserImmediate(){
    const p = (window.__IZZA_PROFILE__||{});
    const plug = (window.izzaUserKey && typeof izzaUserKey.get==='function') ? izzaUserKey.get() : '';
    const ls   = getLS('izzaUserKey','');
    return CANON(p.username || p.user || plug || ls || 'guest');
  }
  async function waitForRealUser(maxMs=12000){
    const t0 = performance.now();
    let u = resolveUserImmediate();
    while (u==='guest' && (performance.now()-t0)<maxMs){
      await sleep(120);
      u = resolveUserImmediate();
    }
    return u;
  }

  async function fetchSnapshot(u){
    const urls = [
      `${SNAP(u)}?prefer=lastGood`,
      `${SNAP(u)}`
    ];
    for (let i=0;i<4;i++) urls.push(`${SNAP(u)}?offset=${i}`);
    for (const url of urls){
      try{
        const r = await fetch(url, { cache:'no-store' });
        if (!r.ok) continue;
        const js = await r.json();
        if (!isEmptySnapshot(js)) return js;
      }catch(_){}
    }
    return null;
  }

  // ---- helper: compute stable fields (but MONEY is skipped if bank-plugin owns it)
  function deriveMoneyFields(snap){
    let total = (snap && (snap.coins|0)) || 0; // wallet in your schema
    let bank  = (snap && snap.bank && (snap.bank.coins|0)) || 0;
    if (bank > total) { bank = total; }                 // clamp impossible states
    const onHand = Math.max(0, total - bank);
    return { onHand, bank, total };
  }

  function applySnapshot(snap, USER){
    // Always cache last-good
    setLSJSON(`izzaBankLastGood_${USER}`, snap);

    // Skip MONEY if owned by bank-plugin
    if (window.__IZZA_MONEY_OWNER__ !== 'bank-plugin'){
      const money = deriveMoneyFields(snap);
      setLSJSON(`izzaBank_${USER}`, {
        coins: money.bank,
        items: (snap.bank && snap.bank.items) || {},
        ammo:  (snap.bank && snap.bank.ammo)  || {}
      });
      setLS('izzaCoins', String(money.onHand));
      try { window.dispatchEvent(new Event('izza-bank-changed')); } catch {}
      try {
        if (window.IZZA?.api?.setCoins) IZZA.api.setCoins(money.onHand);
        window.dispatchEvent(new Event('izza-coins-changed'));
      } catch {}
    }

    // Legacy mirrors for older cores / UIs
    const invList = Object.keys(snap.inventory || {});
    const missions = (snap.missions|0) || (snap.missionsCompleted|0) || (parseInt(getLS('izzaMissions')||'0',10)||0);
    setLSJSON('izza_save_v1', {
      coins: parseInt(getLS('izzaCoins')||'0',10) || 0, // whatever wallet ended up being
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
      try {
        if (window.IZZA.api.camera) {
          window.IZZA.api.camera.x = p.x - 200;
          window.IZZA.api.camera.y = p.y - 120;
        }
      } catch {}
    }
  }

  // ===== boot sequence =====
  async function hydrateAfterGameSettles(){
    addOverlay();

    // 1) Wait for cores to say ready (or 1s fallback)
    let readySeen = false;
    const waitReady = new Promise(async (resolve)=>{
      if (window.IZZA?.api?.ready) { readySeen = true; return resolve(); }
      const handler = ()=>{ readySeen = true; resolve(); };
      try { (window.IZZA = window.IZZA || {}).on?.('ready', handler); } catch {}
      await sleep(1000);
      resolve();
    });
    await waitReady;

    // 2) Let map / frames settle
    let gotTick = false;
    const onTick = ()=>{ gotTick = true; };
    try { (window.IZZA = window.IZZA || {}).on?.('update-post', onTick); } catch {}
    await waitFrames(6);
    await sleep(350);
    if (!gotTick) await waitFrames(6);

    // 3) Wait for a real username
    const USER = await waitForRealUser(12000);

    // 4) Fetch server snapshot with LastGood preference
    let snap = await fetchSnapshot(USER);
    if (!snap) {
      const localLG = getLSJSON(`izzaBankLastGood_${USER}`, null);
      if (localLG && !isEmptySnapshot(localLG)) snap = localLG;
    }

    if (!snap || isEmptySnapshot(snap)) {
      console.warn('[hydrate core] No valid snapshot found; skipping apply');
      removeOverlay();
      return;
    }

    // 5) Apply (money skipped if bank-plugin owns it)
    applySnapshot(snap, USER);

    await waitFrames(2);
    removeOverlay();
  }

  // Kick after DOM ready so overlay can mount cleanly
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', hydrateAfterGameSettles, { once:true });
  } else {
    hydrateAfterGameSettles();
  }
})()
