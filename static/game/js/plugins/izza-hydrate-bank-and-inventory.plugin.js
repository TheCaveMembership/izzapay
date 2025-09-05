/* IZZA hydrate — Bank & Inventory restore
   - MONEY source of truth:
     snapshot.coins        = WALLET (on-hand)
     snapshot.bank.coins   = BANK
   - No “total = wallet + bank” math anywhere here.
*/
(function(){
  // Let other plugins know money is handled here
  window.__IZZA_MONEY_OWNER__ = 'bank-plugin';

  // ---------- utils ----------
  const clamp0 = n => Math.max(0, (n|0));
  const sleep  = ms => new Promise(r=>setTimeout(r,ms));
  const getLS  = (k,d=null)=>{ const v=localStorage.getItem(k); return v==null? d : v; };
  const setLS  = (k,v)=> localStorage.setItem(k,v);
  const getJSON= (k,d=null)=>{ try{ const v=getLS(k,null); return v==null? d : JSON.parse(v); }catch{ return d; } };
  const setJSON= (k,o)=> setLS(k, JSON.stringify(o));

  function userKey(){
    const p = (window.__IZZA_PROFILE__||{});
    const plug  = (window.izzaUserKey && typeof izzaUserKey.get==='function') ? izzaUserKey.get() : '';
    const u = (p.username || p.user || plug || getLS('izzaUserKey') || 'guest').toLowerCase();
    return u.replace(/[^a-z0-9-_]/g,'-');
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
      `/api/state/${encodeURIComponent(u)}?prefer=lastGood`,
      `/api/state/${encodeURIComponent(u)}`
    ];
    for (let i=0;i<6;i++) urls.push(`/api/state/${encodeURIComponent(u)}?offset=${i}`);
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

  // ---------- money writers (direct WALLET/BANK) ----------
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
      if (window.IZZA?.api?.setCoins){
        IZZA.api.setCoins(v);
      }else{
        const pill = document.getElementById('coinPill');
        if (pill) pill.textContent = `Wallet: ${v} IC`;
      }
      window.dispatchEvent(new Event('izza-coins-changed'));
    }catch(_){}
    return v;
  }

  // ---------- PRESEED using last good (wallet = snap.coins, bank = snap.bank.coins) ----------
  (function preseed(){
    const u = userKey();
    const lg = getJSON(`izzaBankLastGood_${u}`, null);
    if (!lg || isEmptyLike(lg)) return;

    const wallet = clamp0(lg.coins||0);
    const bankC  = clamp0((lg.bank && lg.bank.coins)||0);

    writeBankMirror(u, lg.bank || {coins:0,items:{},ammo:{}});
    writeWallet(wallet);
  })();

  // ---------- apply snapshot (wallet ← coins; bank ← bank.coins) ----------
  function applySnapshot(snap, u){
    writeBankMirror(u, snap.bank || {coins:0,items:{},ammo:{}});
    writeWallet(clamp0(snap.coins||0));

    setJSON('izzaInventory', snap.inventory || {});
    try{ window.dispatchEvent(new Event('izza-inventory-changed')); }catch{}

    if (snap.player && typeof snap.player.heartsSegs==='number'){
      setLS(`izzaCurHeartSegments_${u}`, String(clamp0(snap.player.heartsSegs)));
      if (typeof window._redrawHeartsHud==='function'){ try{ window._redrawHeartsHud(); }catch(_){ } }
    }

    // cache last-good snapshot to speed next boot
    setJSON(`izzaBankLastGood_${u}`, snap);
  }

  // ---------- bank modal header (shows Bank + Wallet; no total math) ----------
  (function installBankModalHeader(){
    const u = userKey();

    function renderHeader(card){
      const bank  = getJSON(`izzaBank_${u}`, {coins:0,items:{},ammo:{}});
      const wallet= clamp0(parseInt(getLS('izzaCoins')||'0',10));
      let headerLine = card.querySelector('[data-izza-bank-header]');
      if (!headerLine){
        const title = card.querySelector('h3, h2, .card-title') || card.querySelector('div');
        headerLine = document.createElement('div');
        headerLine.setAttribute('data-izza-bank-header','1');
        headerLine.style.cssText = 'margin-top:6px;opacity:.9';
        (title||card).insertAdjacentElement('afterend', headerLine);
      }
      headerLine.textContent = `Bank: ${clamp0(bank.coins)} IC · Wallet: ${wallet} IC`;
    }

    const mo = new MutationObserver(()=>{
      const cards = Array.from(document.querySelectorAll('.modal .card'));
      const bankCard = cards.find(c => /IZZA\s*Bank/i.test(c.textContent||''));
      if (!bankCard) return;
      renderHeader(bankCard);
    });
    mo.observe(document.documentElement, { childList:true, subtree:true });
  })();

  // ---------- boot ----------
  async function hydrateAfterCores(){
    // Wait for core "ready" or 1s
    const ready = new Promise(async (resolve)=>{
      if (window.IZZA?.api?.ready) return resolve();
      try{ (window.IZZA = window.IZZA || {}).on?.('ready', resolve); }catch(_){}
      await sleep(1000); resolve();
    });
    await ready;

    await sleep(250); // let map/tier settle

    const u = userKey();
    let snap = null;
    try{ snap = await fetchSnapshotAuthoritative(u); }catch(_){}
    if (!snap || isEmptyLike(snap)) return;

    applySnapshot(snap, u);
  }

  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', hydrateAfterCores, {once:true});
  }else{
    hydrateAfterCores();
  }
})();
