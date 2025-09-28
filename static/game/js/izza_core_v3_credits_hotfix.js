/* IZZA Core v3 Crafting Credits Hotfix
   Load this AFTER izza_core_v3.js.
   It ensures server credits sync to the in-game "Crafting Credits" wallet
   and stays in localStorage per-user, without touching coins.
*/
(function(){
  try{
    const ready = ()=> (window.IZZA && IZZA.api && IZZA.api.ready);
    function onReady(fn){
      if(ready()) return fn();
      const t = setInterval(()=>{ if(ready()){ clearInterval(t); fn(); } }, 50);
    }
    onReady(function(){
      // 1) One-shot pull from server → Crafting Credits (NOT coins)
      try{
        fetch('/api/crafting/credits', {credentials:'include'})
          .then(r=>r.json())
          .then(j=>{
            if(j && j.ok && typeof j.balance==='number' && IZZA.api && typeof IZZA.api.setCraftingCredits==='function'){
              IZZA.api.setCraftingCredits(j.balance|0);
            }
          })
          .catch(()=>{});
      }catch{}

      // 2) Keep pill up to date if other tabs change the LS store
      try{
        window.addEventListener('storage', (ev)=>{
          if (ev && ev.key === 'izzaCraftingCredits' && IZZA.api && typeof IZZA.api.getCraftingCredits==='function'){
            // Touch setter to re-render pills if any UI listens for the change event
            var v = IZZA.api.getCraftingCredits();
            IZZA.api.setCraftingCredits(v|0);
          }
        });
      }catch{}
    });
  }catch(e){ console.warn('credits hotfix init failed', e); }
})();