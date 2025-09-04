<!-- /static/game/js/plugins/izza-hydrate-bank-and-inventory.plugin.js -->
<script>
/*
  IZZA hydrate: Bank & Inventory mirror (glitch-free)
  - Bank coins live in: localStorage["izzaBank_<user>"] => {coins, items, ammo}
  - On-hand coins live in: localStorage["izzaCoins"] (and IZZA.api.setCoins if available)
  - This plugin NEVER derives on-hand from any "total". It only moves value between
    bank and on-hand, and emits events so autosave snaps the combined total.

  Public helpers exposed at window.izzaBankAPI:
    - getBalances() -> { bank: number, you: number }
    - deposit(n)
    - withdraw(n)
*/
(function(){
  // ---------- Utils ----------
  const log  = (...a)=> console.log('[IZZA bank+inv]', ...a);
  const warn = (...a)=> console.warn('[IZZA bank+inv]', ...a);

  function getLS(k,d=null){ const v=localStorage.getItem(k); return v==null? d : v; }
  function setLS(k,v){ localStorage.setItem(k,v); }
  function getJSON(k,d=null){ try{ const v=getLS(k,null); return v==null? d : JSON.parse(v); }catch{ return d; } }
  function setJSON(k,o){ setLS(k, JSON.stringify(o||{})); }

  function resolveUser(){
    const profile = window.__IZZA_PROFILE__ || {};
    const fromPlugin = (window.izzaUserKey && typeof izzaUserKey.get==='function') ? izzaUserKey.get() : null;
    const u = (profile.username || profile.user || fromPlugin || getLS('izzaUserKey') || 'guest')
      .toString().trim().toLowerCase().replace(/[^a-z0-9-_]/g,'-');
    return u || 'guest';
  }

  // ---------- On-hand coins (HUD) ----------
  function getOnHand(){
    // Prefer the core getter if present, but NEVER infer from totals.
    try{
      if (window.IZZA?.api?.getCoins) {
        const n = window.IZZA.api.getCoins()|0;
        // keep LS in sync too
        const ls = parseInt(getLS('izzaCoins')||'0',10)|0;
        if (ls !== n) setLS('izzaCoins', String(n));
        return Math.max(0, n);
      }
    }catch{}
    const raw = getLS('izzaCoins','0');
    return Math.max(0, parseInt(raw,10) || 0);
  }

  function setOnHand(n){
    const v = Math.max(0, n|0);
    setLS('izzaCoins', String(v));
    // Update core if available (this also refreshes the HUD pill)
    try{ if(window.IZZA?.api?.setCoins) window.IZZA.api.setCoins(v); }catch(e){ warn('setCoins failed', e); }
    // Fire change event so autosave and any UI listeners react
    try{ window.dispatchEvent(new Event('izza-coins-changed')); }catch{}
    return v;
  }

  // ---------- Bank mirror ----------
  function bankKeyFor(user){ return `izzaBank_${user}`; }
  function getBank(user){
    const b = getJSON(bankKeyFor(user), { coins:0, items:{}, ammo:{} });
    const coins = Math.max(0, (b && b.coins|0) || 0);
    return { coins, items: (b && b.items)||{}, ammo:(b && b.ammo)||{} };
  }
  function setBank(user, next){
    const clean = {
      coins: Math.max(0, (next && next.coins|0) || 0),
      items: (next && next.items)||{},
      ammo:  (next && next.ammo) ||{}
    };
    setJSON(bankKeyFor(user), clean);
    try{ window.dispatchEvent(new Event('izza-bank-changed')); }catch{}
    return clean;
  }
  function setBankCoins(user, coins){
    const b = getBank(user);
    b.coins = Math.max(0, coins|0);
    return setBank(user, b);
  }

  // ---------- Moves ----------
  function deposit(user, amount){
    const amt = Math.max(0, amount|0);
    if(!amt) return getBalances(user);

    const you  = getOnHand();
    const take = Math.min(you, amt); // can't deposit more than you hold
    if (take<=0) return getBalances(user);

    const afterYou   = setOnHand(you - take);
    const bank       = getBank(user);
    const afterBank  = setBankCoins(user, bank.coins + take);

    // Optional toast
    try{ window.IZZA?.toast?.(`Deposited ${take} IC`); }catch{}
    return { bank: afterBank.coins, you: afterYou };
  }

  function withdraw(user, amount){
    const amt = Math.max(0, amount|0);
    if(!amt) return getBalances(user);

    const bank = getBank(user);
    const take = Math.min(bank.coins, amt); // can't withdraw more than bank
    if (take<=0) return getBalances(user);

    const afterBank  = setBankCoins(user, bank.coins - take);
    const afterYou   = setOnHand(getOnHand() + take);

    // Optional toast
    try{ window.IZZA?.toast?.(`Withdrew ${take} IC`); }catch{}
    return { bank: afterBank.coins, you: afterYou };
  }

  function getBalances(user=resolveUser()){
    const bank = getBank(user);
    const you  = getOnHand();
    return { bank: bank.coins, you };
  }

  // ---------- Init guards (no mutation on load) ----------
  // Ensure both stores exist without altering values (prevents “double” effects).
  (function initMirrors(){
    const user = resolveUser();

    // Bank mirror default
    const hasBank = getJSON(bankKeyFor(user), null);
    if(!hasBank){
      setJSON(bankKeyFor(user), { coins:0, items:{}, ammo:{} });
    }

    // On-hand default (do NOT derive from totals here!)
    const hasCoins = getLS('izzaCoins', null);
    if(hasCoins==null) setLS('izzaCoins', '0');
  })();

  // ---------- Public API ----------
  window.izzaBankAPI = {
    getBalances,
    deposit: (n)=> deposit(resolveUser(), n|0),
    withdraw: (n)=> withdraw(resolveUser(), n|0),
    // direct accessors if a UI wants them:
    _getOnHand: getOnHand,
    _setOnHand: setOnHand,
    _getBank: ()=> getBank(resolveUser()),
    _setBankCoins: (n)=> setBankCoins(resolveUser(), n|0)
  };

  // ---------- Optional: keep HUD pill synced if core isn’t ready yet ----------
  // If your core already updates the pill via setCoins, this is harmless.
  function refreshCoinPill(){
    const pill = document.getElementById('coinPill');
    if(pill){
      const you = getOnHand();
      pill.textContent = `Coins: ${you} IC`;
    }
  }
  document.addEventListener('DOMContentLoaded', refreshCoinPill, {once:true});
  window.addEventListener('izza-coins-changed', refreshCoinPill);

  log('ready');
})();
</script>
