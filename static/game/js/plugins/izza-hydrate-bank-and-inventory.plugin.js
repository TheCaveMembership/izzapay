<!-- /static/game/js/plugins/izza-hydrate-bank-and-inventory.plugin.js -->
<script>
/* IZZA hydrate — Bank & Inventory restore
   - Single source of truth for MONEY (bank + wallet)
   - Fixes "double withdraw" by making 'You' = Wallet (on-hand)
   - Keeps invariant: TOTAL = wallet + bank at all times
*/
(function(){
  // Claim ownership of money so other plugins (core-save) don’t touch it
  window.__IZZA_MONEY_OWNER__ = 'bank-plugin';

  // ---------- small overlay while restoring ----------
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
  function getLS(k,d=null){ const v=localStorage.getItem(k); return v==null? d : v; }
  function setLS(k,v){ localStorage.setItem(k,v); }
  function getJSON(k,d=null){ try{ const v=getLS(k,null); return v==null? d : JSON.parse(v); }catch{ return d; } }
  function setJSON(k,o){ setLS(k, JSON.stringify(o)); }

  function userKey(){
    const p = (window.__IZZA_PROFILE__||{});
    const maybe = (p.username||p.user||'').toString();
    const plug  = (window.izzaUserKey && typeof izzaUserKey.get==='function') ? izzaUserKey.get() : '';
    const u = (maybe || plug || getLS('izzaUserKey') || 'guest').toLowerCase();
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
    const total = Number(s.coins||0);
    return (invCount===0 && total===0 && bankCoins===0 && bankItems===0 && bankAmmo===0);
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
      if (window.IZZA && IZZA.api && typeof IZZA.api.setCoins==='function'){
        IZZA.api.setCoins(v);
      }else{
        const pill = document.getElementById('coinPill');
        if (pill) pill.textContent = `Wallet: ${v} IC`;
      }
      window.dispatchEvent(new Event('izza-coins-changed'));
    }catch(_){}
    return v;
  }

  // ---------- pre-seed (fixes HUD showing 0 on first paint) ----------
  (function preseed(){
    const u = userKey();
    const lg = getJSON(`izzaBankLastGood_${u}`, null);
    if (!lg || isEmptyLike(lg)) return;

    const total  = clamp0(lg.coins||0);                 // TOTAL
    const bankC  = clamp0((lg.bank && lg.bank.coins)||0);
    const wallet = clamp0(total - bankC);               // ON-HAND

    writeBankMirror(u, lg.bank || {coins:0,items:{},ammo:{}});
    writeWallet(wallet);
    // store the boot total for reconciling inside the modal (prevents doubling)
    setLS(`izzaBootTotal_${u}`, String(wallet + bankC));
  })();

  // ---------- apply snapshot once cores are ready ----------
  function applySnapshot(snap, u){
    const total  = clamp0(snap.coins||0);
    const bankC  = clamp0((snap.bank && snap.bank.coins)||0);
    const wallet = clamp0(total - bankC);

    writeBankMirror(u, snap.bank || {coins:0,items:{},ammo:{}});
    writeWallet(wallet);
    setJSON('izzaInventory', snap.inventory || {});
    try{ window.dispatchEvent(new Event('izza-inventory-changed')); }catch{}

    if (snap.player && typeof snap.player.heartsSegs==='number'){
      setLS(`izzaCurHeartSegments_${u}`, String(clamp0(snap.player.heartsSegs)));
      if (typeof window._redrawHeartsHud==='function'){ try{ window._redrawHeartsHud(); }catch(_){ } }
    }

    // refresh boot total for the session
    setLS(`izzaBootTotal_${u}`, String(wallet + bankC));
  }

  // ---------- bank modal guard (forces 'You' == Wallet; prevents doubling) ----------
  (function installBankModalGuard(){
    const u = userKey();

    // Helper to re-render the header line with Bank + Wallet
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

      // Show Bank + Wallet in header (replaces any "You" conceptually)
      renderHeader(bankCard);

      // Capture TOTAL at open time (wallet + bank)
      const bank0   = getJSON(`izzaBank_${u}`, {coins:0,items:{},ammo:{}});
      const wallet0 = clamp0(parseInt(getLS('izzaCoins')||'0',10));
      let sessionTotal = wallet0 + clamp0(bank0.coins);
      setLS(`izzaBootTotal_${u}`, String(sessionTotal));

      // After any deposit/withdraw click, reconcile so bank+wallet === sessionTotal
      const clickHandler = ()=>{
        setTimeout(()=>{
          const bankNow   = getJSON(`izzaBank_${u}`, {coins:0,items:{},ammo:{}});
          let walletNow   = clamp0(parseInt(getLS('izzaCoins')||'0',10));
          let bankCoins   = clamp0(bankNow.coins);

          // Reconcile
          const sum = walletNow + bankCoins;
          if (sum !== sessionTotal){
            // If something legitimately changed (loot/spend), adopt new total
            if (Math.abs(sum - sessionTotal) > 0){
              sessionTotal = sum;
              setLS(`izzaBootTotal_${u}`, String(sessionTotal));
            } else {
              // Else clamp so we never exceed sessionTotal (prevents double)
              bankCoins = clamp0(sessionTotal - walletNow);
              writeBankMirror(u, {coins:bankCoins, items:bankNow.items||{}, ammo:bankNow.ammo||{}});
            }
          }

          renderHeader(bankCard);
        }, 0);
      };

      if (!bankCard.__izzaBankGuardInstalled){
        bankCard.addEventListener('click', clickHandler, true);
        bankCard.__izzaBankGuardInstalled = true;
      }
    });

    mo.observe(document.documentElement, { childList:true, subtree:true });
  })();

  // ---------- boot (wait for cores) ----------
  async function hydrateAfterCores(){
    overlay.style.display='flex';

    // Wait for core "ready" or 1s
    const ready = new Promise(async (resolve)=>{
      if (window.IZZA && window.IZZA.api && window.IZZA.api.ready) return resolve();
      const handler = ()=> resolve();
      try{ (window.IZZA = window.IZZA || {}).on?.('ready', handler); }catch(_){}
      await sleep(1000); resolve();
    });
    await ready;

    await sleep(250); // let tier/map settle

    const u = userKey();
    let snap = null;
    try{ snap = await fetchSnapshotAuthoritative(u); }catch(_){}
    if (!snap){
      const lg = getJSON(`izzaBankLastGood_${u}`, null);
      if (lg && !isEmptyLike(lg)) snap = lg;
    }

    if (!snap || isEmptyLike(snap)){
      overlay.style.display='none';
      return;
    }

    setJSON(`izzaBankLastGood_${u}`, snap);  // cache
    applySnapshot(snap, u);

    overlay.style.display='none';
  }

  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', hydrateAfterCores, {once:true});
  }else{
    hydrateAfterCores();
  }
})();
</script>
