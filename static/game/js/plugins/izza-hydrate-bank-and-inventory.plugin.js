<!-- /static/game/js/plugins/izza-hydrate-bank-and-inventory.plugin.js -->
<script>
(function(){
  window.__IZZA_MONEY_OWNER__ = 'bank-plugin';

  const overlay = document.createElement('div');
  Object.assign(overlay.style,{position:'fixed',inset:'0',background:'rgba(5,8,14,.90)',display:'none',alignItems:'center',justifyContent:'center',zIndex:99999,color:'#cfe0ff',fontFamily:'system-ui,-apple-system,Segoe UI,Roboto,sans-serif',fontSize:'15px'});
  overlay.innerHTML = `<div style="padding:14px 18px;border:1px solid #394769;border-radius:10px;background:#0b1120">Loading your items & bank…</div>`;
  document.addEventListener('DOMContentLoaded', ()=> document.body.appendChild(overlay));

  const clamp0=n=>Math.max(0,(n|0));
  const sleep =ms=>new Promise(r=>setTimeout(r,ms));
  const getLS =(k,d=null)=>{ const v=localStorage.getItem(k); return v==null?d:v; };
  const setLS =(k,v)=> localStorage.setItem(k,v);
  const getJSON=(k,d=null)=>{ try{ const v=getLS(k,null); return v==null?d:JSON.parse(v); }catch{ return d; } };
  const setJSON=(k,o)=> setLS(k, JSON.stringify(o));

  function rawUserKey(){
    const p=(window.__IZZA_PROFILE__||{});
    const plug=(window.izzaUserKey && typeof izzaUserKey.get==='function') ? izzaUserKey.get() : '';
    const fromLS=getLS('izzaUserKey')||'';
    const u=(p.username||p.user||plug||fromLS||'guest').toLowerCase();
    return u.replace(/[^a-z0-9-_]/g,'-');
  }

  // NEW: wait until we actually have a non-guest username (up to ~10s)
  async function waitForUserKey(maxMs=10000){
    const start=Date.now();
    let u=rawUserKey();
    while ((u==='guest' || !u) && (Date.now()-start)<maxMs){
      await sleep(100);
      u=rawUserKey();
    }
    return u || 'guest';
  }

  function isEmptyLike(s){
    if(!s || typeof s!=='object') return true;
    const inv = s.inventory || {};
    const invCount = Array.isArray(inv) ? inv.length : Object.keys(inv).length;
    const bank = s.bank || {};
    const bankCoins = Number(bank.coins||0);
    const bankItems = bank.items ? Object.keys(bank.items).length : 0;
    const bankAmmo  = bank.ammo  ? Object.keys(bank.ammo ).length : 0;
    const wallet = Number(s.coins||0);
    return (invCount===0 && wallet===0 && bankCoins===0 && bankItems===0 && bankAmmo===0);
  }
  const unwrap = d => (d && d.snapshot) ? d.snapshot : d;

  async function fetchSnapshotAuthoritative(u){
    const urls=[
      `/api/state/${encodeURIComponent(u)}?prefer=lastGood`,
      `/api/state/${encodeURIComponent(u)}`
    ];
    for(let i=0;i<6;i++) urls.push(`/api/state/${encodeURIComponent(u)}?offset=${i}`);
    for (const url of urls){
      try{
        const r=await fetch(url,{credentials:'omit',cache:'no-store'});
        if(!r.ok) continue;
        const snap=unwrap(await r.json());
        if(snap && !isEmptyLike(snap)) return snap;
      }catch{}
    }
    return null;
  }

  function writeBank(u, bank){
    const clean = bank && typeof bank==='object' ? {coins:clamp0(bank.coins),items:bank.items||{},ammo:bank.ammo||{}} : {coins:0,items:{},ammo:{}};
    setJSON(`izzaBank_${u}`, clean);
    try{ window.dispatchEvent(new Event('izza-bank-changed')); }catch{}
    return clean;
  }
  function writeWallet(n){
    const v=clamp0(n);
    setLS('izzaCoins', String(v));
    try{
      if (window.IZZA?.api?.setCoins) IZZA.api.setCoins(v);
      else {
        const pill=document.getElementById('coinPill');
        if(pill) pill.textContent=`Wallet: ${v} IC`;
      }
      window.dispatchEvent(new Event('izza-coins-changed'));
    }catch{}
    return v;
  }

  (function preseed(){
    // Don’t preseed under a guessed "guest" — wait for real user in main flow
    const u = rawUserKey();
    if (u==='guest') return;
    const lg = getJSON(`izzaBankLastGood_${u}`, null);
    if (!lg || isEmptyLike(lg)) return;
    writeBank(u, lg.bank || {coins:0,items:{},ammo:{}});
    writeWallet(clamp0(lg.coins||0));
  })();

  function applySnapshot(snap, u){
    writeBank(u, snap.bank || {coins:0,items:{},ammo:{}});
    writeWallet(clamp0(snap.coins||0));
    setJSON('izzaInventory', snap.inventory || {});
    try{ window.dispatchEvent(new Event('izza-inventory-changed')); }catch{}
    if (snap.player && typeof snap.player.heartsSegs==='number'){
      setLS(`izzaCurHeartSegments_${u}`, String(clamp0(snap.player.heartsSegs)));
      if (typeof window._redrawHeartsHud==='function'){ try{ window._redrawHeartsHud(); }catch{} }
    }
  }

  async function hydrateAfterCores(){
    overlay.style.display='flex';

    // Wait for core ready or 1s
    await Promise.race([
      new Promise(res=>{ try{ (window.IZZA=window.IZZA||{}).on?.('ready', res); }catch{} }),
      sleep(1000)
    ]);
    await sleep(250);

    // NEW: Wait for a non-guest username before fetching
    const u = await waitForUserKey(10000);

    let snap = await fetchSnapshotAuthoritative(u);
    if (!snap){
      const lg = getJSON(`izzaBankLastGood_${u}`, null);
      if (lg && !isEmptyLike(lg)) snap = lg;
    }

    if (snap && !isEmptyLike(snap)){
      setJSON(`izzaBankLastGood_${u}`, snap);
      applySnapshot(snap, u);
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
