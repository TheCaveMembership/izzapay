// izza-userkey-and-migration.plugin.js
(function(){
  const CANON = s => (s==null ? 'guest' : String(s)).replace(/^@+/, '').toLowerCase();

  // Expose a stable user key ASAP; update again when IZZA is ready
  window.__IZZA_USERKEY__ = CANON(window.__IZZA_PROFILE__?.username || 'guest');

  function runMigrations(){
    try{
      const ukey = window.__IZZA_USERKEY__ || 'guest';

      // 1) BANK: migrate any izzaBank_@Name → izzaBank_name (if the new one doesn't exist)
      const oldKeys = Object.keys(localStorage).filter(k => /^izzaBank_@/i.test(k));
      oldKeys.forEach(k=>{
        const raw = localStorage.getItem(k);
        const target = 'izzaBank_' + CANON(k.slice('izzaBank_'.length));
        if(raw != null && localStorage.getItem(target) == null){
          try{ localStorage.setItem(target, raw); localStorage.removeItem(k); }catch(e){}
        }
      });

      // 2) HEARTS: if you ever wrote to a generic key, copy it to per-user key
      const genericHearts = localStorage.getItem('izzaCurHeartSegments');
      const userHeartsKey = 'izzaCurHeartSegments_' + ukey;
      if(genericHearts != null && localStorage.getItem(userHeartsKey) == null){
        try{ localStorage.setItem(userHeartsKey, genericHearts); }catch(e){}
      }

      // 3) OPTIONAL: Missions/Coins generic → keep as-is (your core reads those shared keys).
      // If you later want per-user coins/missions, uncomment:
      // const coins = localStorage.getItem('izzaCoins');
      // if(coins != null && localStorage.getItem('izzaCoins_'+ukey) == null){
      //   try{ localStorage.setItem('izzaCoins_'+ukey, coins); }catch(e){}
      // }

    }catch(e){ /* non-fatal */ }
  }

  // Also update the key once core exposes IZZA.api.user
  (function waitReady(){
    if(window.IZZA?.api?.ready){
      window.__IZZA_USERKEY__ = CANON(window.IZZA.api.user?.username || 'guest');
      runMigrations();
    }else{
      window.addEventListener('izza-ready-once', runMigrations, { once:true });
      (function hookOnce(){
        if(window.IZZA){
          const un = (p)=>{ if(!hookOnce._fired){ hookOnce._fired=true; window.dispatchEvent(new Event('izza-ready-once')); } };
          window.IZZA.on?.('ready', un);
        }else{
          setTimeout(hookOnce, 40);
        }
      })();
    }
  })();
})();
