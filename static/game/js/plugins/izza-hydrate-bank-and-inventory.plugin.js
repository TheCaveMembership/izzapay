<script>
/* IZZA hydrate — Bank & Inventory restore (wallet+bank kept separate)
   Fixes cold-relaunch loss by:
   - Waiting for real username (not "guest")
   - Using a single absolute API base (same as saver)
*/
(function(){
  // Money ownership so other hydrators don't touch coins/bank
  window.__IZZA_MONEY_OWNER__ = 'bank-plugin';

  // ---------- API base (canonical) ----------
  const API_BASE = (function(){
    // If you set window.IZZA_PERSIST_BASE = 'https://izzagame.onrender.com' elsewhere, we honor it
    const b = (window.IZZA_PERSIST_BASE || '').replace(/\/+$/,'');
    if (b) return b + '/api';
    return 'https://izzagame.onrender.com/api';
  })();
  const SNAP = user => `${API_BASE}/state/${encodeURIComponent(user)}`;

  // ---------- small overlay ----------
  const overlay = document.createElement('div');
  Object.assign(overlay.style,{
    position:'fixed', inset:'0', background:'rgba(5,8,14,.90)',
    display:'none', alignItems:'center', justifyContent:'center',
    zIndex:99999, color:'#cfe0ff',
    fontFamily:'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
    fontSize:'15px'
  });
  overlay.innerHTML = `<div style="padding:14px 18px;border:1px solid #394769;border-radius:10px;background:#0b1120">
    Loading your items & bank…</div>`;
  document.addEventListener('DOMContentLoaded', ()=> document.body.appendChild(overlay));

  // ---------- utils ----------
  const clamp0 = n => Math.max(0, (n|0));
  const sleep  = ms => new Promise(r=>setTimeout(r,ms));
  const getLS = (k,d=null)=>{ const v=localStorage.getItem(k); return v==null?d:v; };
  const setLS = (k,v)=> localStorage.setItem(k,v);
  const getJSON = (k,d=null)=>{ try{ const v=getLS(k,null); return v==null? d : JSON.parse(v); }catch{ return d; } };
  const setJSON = (k,o)=> setLS(k, JSON.stringify(o));

  const CANON = s => (s==null?'guest':String(s)).replace(/^@+/,'').toLowerCase().replace(/[^a-z0-9-_]/g,'-');

  function resolveUserImmediate(){
    const p = (window.__IZZA_PROFILE__||{});
    const plug = (window.izzaUserKey && typeof izzaUserKey.get==='function') ? izzaUserKey.get() : '';
    const ls   = getLS('izzaUserKey','');
    return CANON(p.username || p.user || plug || ls || 'guest');
  }
  async function waitForRealUser(maxMs=10000){
    const t0 = performance.now();
    let u = resolveUserImmediate();
    while (u==='guest' && (performance.now()-t0)<maxMs){
      await sleep(100);
      u = resolveUserImmediate();
    }
    return u;
  }

  function isEmptyLike(s){
    if (!s || typeof s!=='object') return true;
    const inv = s.inventory || {};
    const invCount = Array.isArray(inv) ? inv.length : Object.keys(inv).length;
    const bank = s.bank || {};
    const bankCoins = Number(bank.coins||0);
    const bankItems = bank.items ? Object.keys(bank.items).length : 0;
    const bankAmmo  = bank.ammo  ? Object.keys(bank.ammo ).length : 0;
    const wallet = Number(s.coins||0);
    return (invCount===0 && wallet===0 && bankCoins===0 && bankItems===0 && bankAmmo===0);
  }

  function unwrapSnapshot(d){ return d && d.snapshot ? d.snapshot : d; }

  async function fetchSnapshotAuthoritative(u){
    const urls = [
      `${SNAP(u)}?prefer=lastGood`,
      `${SNAP(u)}`
    ];
    // A few historical fallbacks if your service supports offset browsing
    for (let i=0;i<6;i++) urls.push(`${SNAP(u)}?offset=${i}`);
    for (const url of urls){
      try{
        const r = await fetch(url, { credentials:'omit', cache:'no-store' });
        if (!r.ok) continue;
        const raw  = await r.json();
        const snap = unwrapSnapshot(raw);
        if (snap && !isEmptyLike(snap)) return snap;
      }catch(_){}
    }
    return null;
  }

  // ---------- money writers ----------
  function writeBankMirror(u, bank){
    const clean = bank && typeof bank==='object'
      ? { coins: clamp0(bank.coins), items: bank.items||{}, ammo: bank.ammo||{} }
      : { coins:0, items:{}, ammo:{} };
    setJSON(`izzaBank_${u}`, clean);
    try{ window.dispatchEvent(new Event('izza-bank-changed')); }catch{}
    return clean;
  }
  function writeWallet(n){
    const v = clamp0(n);
    setLS('izzaCoins', String(v));
    try{
      if (window.IZZA?.api?.setCoins) IZZA.api.setCoins(v);
      else {
        const pill = document.getElementById('coinPill');
        if (pill) pill.textContent = `Wallet: ${v} IC`;
      }
      window.dispatchEvent(new Event('izza-coins-changed'));
    }catch(_){}
    return v;
  }

  // ---------- preseed from last-good (prevents 0 HUD flash) ----------
  (function preseed(){
    const u = resolveUserImmediate();
    const lg = getJSON(`izzaBankLastGood_${u}`, null);
    if (!lg || isEmptyLike(lg)) return;
    const wallet = clamp0((lg.coins|0) - (lg.bank?.coins|0));
    writeBankMirror(u, lg.bank || {coins:0,items:{},ammo:{}});
    writeWallet(wallet);
    setLS(`izzaBootTotal_${u}`, String(wallet + clamp0(lg.bank?.coins|0)));
  })();

  // ---------- apply snapshot ----------
  function applySnapshot(snap, u){
    const wallet = clamp0((snap.coins|0) - (snap.bank?.coins|0));
    writeBankMirror(u, snap.bank || {coins:0,items:{},ammo:{}});
    writeWallet(wallet);
    setJSON('izzaInventory', snap.inventory || {});
    try{ window.dispatchEvent(new Event('izza-inventory-changed')); }catch{}
    if (typeof snap.player?.heartsSegs === 'number'){
      setLS(`izzaCurHeartSegments_${u}`, String(clamp0(snap.player.heartsSegs)));
      if (typeof window._redrawHeartsHud==='function'){ try{ window._redrawHeartsHud(); }catch{} }
    }
    setLS(`izzaBootTotal_${u}`, String(wallet + clamp0(snap.bank?.coins|0)));
  }

  // ---------- boot ----------
  async function hydrateAfterCores(){
    overlay.style.display='flex';

    // wait core ready (or 1s)
    const ready = new Promise(async (resolve)=>{
      if (window.IZZA?.api?.ready) return resolve();
      try{ (window.IZZA = window.IZZA||{}).on?.('ready', resolve); }catch{}
      await sleep(1000); resolve();
    });
    await ready;
    await sleep(250); // map/tier settle

    // wait for REAL username (not guest)
    const user = await waitForRealUser(10000);
    const u = CANON(user); // even if timed out, CANON keeps it stable

    // fetch server snapshot
    let snap = await fetchSnapshotAuthoritative(u);
    if (!snap){
      const lg = getJSON(`izzaBankLastGood_${u}`, null);
      if (lg && !isEmptyLike(lg)) snap = lg;
    }

    if (snap && !isEmptyLike(snap)){
      setJSON(`izzaBankLastGood_${u}`, snap);  // cache
      applySnapshot(snap, u);
    }else{
      console.warn('[hydrate bank] no snapshot for', u, '— leaving local values as-is');
    }

    overlay.style.display='none';
  }

  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', hydrateAfterCores, {once:true});
  }else{
    hydrateAfterCores();
  }
})();
</script>
