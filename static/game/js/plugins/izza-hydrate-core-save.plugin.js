// /static/game/plugins/izza-hydrate-core-save.plugin.js
(function(){
  const overlay = document.createElement('div');
  Object.assign(overlay.style,{
    position:'fixed', inset:'0', background:'rgba(5,8,14,.85)', display:'none',
    alignItems:'center', justifyContent:'center', zIndex: 99999, color:'#cfe0ff',
    fontFamily:'system-ui, -apple-system, Segoe UI, Roboto, sans-serif', fontSize:'15px'
  });
  overlay.innerHTML = `<div style="padding:14px 18px;border:1px solid #394769;border-radius:10px;background:#0b1120">
    Loading your game…</div>`;
  document.addEventListener('DOMContentLoaded', ()=> document.body.appendChild(overlay));

  const raf = () => new Promise(r=> requestAnimationFrame(()=> r()));
  const safeParse = (s,f)=>{ try{ return JSON.parse(s); }catch{ return f; } };
  const get      = (k,f)=>{ const v=localStorage.getItem(k); return v==null?f:v; };
  const getJSON  = (k,f)=> safeParse(get(k,null), f);
  const set      = (k,v)=> localStorage.setItem(k, v);
  const setJSON  = (k,o)=> set(k, JSON.stringify(o));

  function getUserKey(){
    const p = (window.__IZZA_PROFILE__)||{};
    const fromPlugin = (window.izzaUserKey && typeof izzaUserKey.get==='function') ? izzaUserKey.get() : null;
    return (p.username || p.user || fromPlugin || get('izzaUserKey') || 'guest').toLowerCase();
  }

  async function waitUntilAfterBootAndMapRefresh(timeoutMs=12000){
    // Wait for core ready
    let readyPromise = null;
    if (window.IZZA && typeof window.IZZA.on === 'function') {
      readyPromise = new Promise(resolve=>{
        window.IZZA.on('ready', async ()=>{
          await raf(); await raf(); await raf(); // a few extra frames
          resolve();
        });
      });
    }
    const framesFallback = (async()=>{ await raf(); await raf(); await raf(); })();
    await Promise.race([readyPromise||framesFallback, new Promise(r=>setTimeout(r,2000))]);

    // Wait for map tier stable much longer
    let lastTier = localStorage.getItem('izzaMapTier') || '1';
    let stableFrames = 0;
    const requiredStable = 30; // ~0.5s stable @ 60fps
    const done = new Promise(resolve=>{
      (async function pollRAF(){
        for(;;){
          await raf();
          const cur = localStorage.getItem('izzaMapTier') || '1';
          if (cur === lastTier) stableFrames++;
          else { lastTier=cur; stableFrames=0; }
          if (stableFrames >= requiredStable) break;
        }
        resolve();
      })();
    });

    await Promise.race([done, new Promise(r=> setTimeout(r, timeoutMs))]);

    // Extra cushion even after stable
    await new Promise(r=> setTimeout(r, 1000));
  }

  async function hydrate(){
    const USER      = getUserKey();
    const BANK_KEY  = `izzaBank_${USER}`;
    const bank      = getJSON(BANK_KEY, { coins:0, items:{}, ammo:{} });
    const missions  = parseInt(get('izzaMissions') || '0', 10) || 0;
    const inventory = Object.keys(bank.items || {});

    overlay.style.display = 'flex';
    setJSON('izza_save_v1', {
      coins: bank.coins|0,
      missionsCompleted: missions,
      inventory
    });
    set('izzaCoins', String(bank.coins|0));

    try{
      if (window.IZZA?.api?.setCoins) window.IZZA.api.setCoins(bank.coins|0);
    }catch{}

    try{ window.dispatchEvent(new Event('izza-bank-changed')); }catch{}

    console.log('[IZZA hydrate] user=%s bank=%o', USER, bank);
    setTimeout(()=> overlay.style.display='none', 400);
  }

  (async function boot(){
    try{
      await waitUntilAfterBootAndMapRefresh();
      await hydrate();
    }catch(err){
      console.error('[IZZA hydrate] error', err);
      overlay.style.display='none';
    }
  })();
})();
