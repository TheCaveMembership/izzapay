<!-- /static/game/js/plugins/izza-hydrate-bank-and-inventory.plugin.js -->
<script>
/* IZZA hydrate — Bank & Inventory restore
   Wallet and bank are independent:
   - snapshot.coins  -> wallet (on-hand)
   - snapshot.bank.* -> bank (coins/items/ammo)
*/
(function(){
  // Mark that this plugin is the money owner so core-save hydrate won’t double-apply
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
  const getLS  = (k,d=null)=>{ const v=localStorage.getItem(k); return v==null? d : v; };
  const setLS  = (k,v)=> localStorage.setItem(k,v);
  const getJSON= (k,d=null)=>{ try{ const v=getLS(k,null); return v==null? d : JSON.parse(v); }catch{ return d; } };
  const setJSON= (k,o)=> setLS(k, JSON.stringify(o));

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

  // ---------- writers ----------
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
      } else {
        const pill = document.getElementById('coinPill');
        if (pill) pill.textContent = `Wallet: ${v} IC`;
        window.dispatchEvent(new Event('izza-coins-changed'));
      }
    }catch(_){}
    try{ window.dispatchEvent(new Event('izza-coins-changed')); }catch(_){}
    return v;
  }

  // ---------- pre-seed (optional, fast HUD) ----------
  (function preseed(){
    const u = userKey();
    const lg = getJSON(`izzaBankLastGood_${u}`, null);
    if (!lg || isEmptyLike(lg)) return;
    // wallet = lg.coins, bank = lg.bank.coins
    writeBankMirror(u, lg.bank || {coins:0,items:{},ammo:{}});
    writeWallet(clamp0(lg.coins||0));
  })();

  // ---------- apply ----------
  function applySnapshot(snap, u){
    writeBankMirror(u, snap.bank || {coins:0,items:{},ammo:{}});
    writeWallet(clamp0(snap.coins||0));
    setJSON('izzaInventory', snap.inventory || {});
    try{ window.dispatchEvent(new Event('izza-inventory-changed')); }catch{}

    if (snap.player && typeof snap.player.heartsSegs==='number'){
      setLS(`izzaCurHeartSegments_${u}`, String(clamp0(snap.player.heartsSegs)));
      if (typeof window._redrawHeartsHud==='function'){ try{ window._redrawHeartsHud(); }catch(_){ } }
    }
  }

  // ---------- bank modal helper (display only) ----------
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
      bankCard.addEventListener('click', ()=> setTimeout(()=> renderHeader(bankCard), 0), true);
    });
    mo.observe(document.documentElement, { childList:true, subtree:true });
  })();

  // ---------- boot ----------
  async function hydrateAfterCores(){
    overlay.style.display='flex';

    // Wait for core or 1s
    const ready = new Promise(async (resolve)=>{
      if (window.IZZA?.api?.ready) return resolve();
      const handler = ()=> resolve();
      try{ (window.IZZA = window.IZZA || {}).on?.('ready', handler); }catch{}
      await sleep(1000); resolve();
    });
    await ready;
    await sleep(250);

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

    setJSON(`izzaBankLastGood_${u}`, snap);
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
