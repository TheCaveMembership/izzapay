<!-- /static/game/js/plugins/izza-hydrate-core-save.plugin.js -->
<script>
(function(){
  const overlay=document.createElement('div');
  Object.assign(overlay.style,{position:'fixed',inset:'0',background:'rgba(5,8,14,.86)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:99999,color:'#cfe0ff',fontFamily:'system-ui,-apple-system,Segoe UI,Roboto,sans-serif',fontSize:'15px'});
  overlay.innerHTML=`<div style="padding:14px 18px;border:1px solid #394769;border-radius:10px;background:#0b1120">Restoring your game…</div>`;
  const addOverlay=()=>{ if(!overlay.isConnected) document.body.appendChild(overlay); };
  const removeOverlay=()=>{ if(overlay.isConnected) overlay.remove(); };

  const getLS=(k,fb=null)=>{ const v=localStorage.getItem(k); return v==null?fb:v; };
  const setLS=(k,v)=>localStorage.setItem(k,v);
  const safe=(s,fb)=>{ try{ return JSON.parse(s); }catch{ return fb; } };
  const getJSON=(k,fb=null)=> safe(getLS(k,null),fb);
  const setJSON=(k,o)=> setLS(k, JSON.stringify(o));
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const waitFrames=(n=1)=>new Promise(res=>{ let left=n; (function tick(){ if(--left<=0) res(); else requestAnimationFrame(tick); })() });

  function isEmptySnapshot(s){
    if(!s || typeof s!=='object') return true;
    if(s.version!==1) return false;
    const wallet=(s.coins|0)||0;
    const invEmpty=!s.inventory || Object.keys(s.inventory).length===0;
    const bank=s.bank||{};
    const bankCoins=(bank.coins|0)||0;
    const bankEmpty=bankCoins===0 && (!bank.items || Object.keys(bank.items).length===0) && (!bank.ammo || Object.keys(bank.ammo).length===0);
    return wallet===0 && invEmpty && bankEmpty;
  }

  function rawUser(){
    const p=(window.__IZZA_PROFILE__)||{};
    const plug=(window.izzaUserKey && typeof izzaUserKey.get==='function') ? izzaUserKey.get() : null;
    return (p.username || p.user || plug || getLS('izzaUserKey') || 'guest').toLowerCase();
  }
  // NEW
  async function waitForUser(maxMs=10000){
    const start=Date.now();
    let u=rawUser();
    while ((!u || u==='guest') && (Date.now()-start)<maxMs){
      await sleep(100);
      u=rawUser();
    }
    return u || 'guest';
  }

  async function fetchSnapshot(u){
    const base=(window.__IZZA_API_BASE__) || '/api';
    let r=await fetch(`${base}/state/${encodeURIComponent(u)}?prefer=lastGood`,{cache:'no-store'});
    if(r.ok){ const js=await r.json(); if(!isEmptySnapshot(js)) return js; }
    r=await fetch(`${base}/state/${encodeURIComponent(u)}`,{cache:'no-store'});
    if(r.ok){ const js=await r.json(); if(!isEmptySnapshot(js)) return js; }
    return null;
  }

  function applySnapshot(snap, USER){
    // Always store last good
    setJSON(`izzaBankLastGood_${USER}`, snap);

    // MONEY: skip if bank-plugin owns it (it does)
    if (window.__IZZA_MONEY_OWNER__ !== 'bank-plugin'){
      const wallet=(snap.coins|0)||0;
      const bank  =(snap.bank && (snap.bank.coins|0))||0;
      setJSON(`izzaBank_${USER}`, {
        coins: bank,
        items: (snap.bank && snap.bank.items) || {},
        ammo:  (snap.bank && snap.bank.ammo ) || {}
      });
      setLS('izzaCoins', String(wallet));
      try{ window.dispatchEvent(new Event('izza-bank-changed')); }catch{}
      try{ window.dispatchEvent(new Event('izza-coins-changed')); }catch{}
      if (window.IZZA?.api?.setCoins){ try{ IZZA.api.setCoins(wallet); }catch{} }
    }

    // Legacy + missions
    const invList=Object.keys(snap.inventory||{});
    const missions=(snap.missions|0) || (snap.missionsCompleted|0) || (parseInt(getLS('izzaMissions')||'0',10)||0);
    setJSON('izza_save_v1',{ coins: parseInt(getLS('izzaCoins')||'0',10)||0, missionsCompleted: missions, inventory: invList });
    setLS('izzaMissions', String(missions));

    // Hearts
    if (snap.player && typeof snap.player.heartsSegs==='number'){
      setLS(`izzaCurHeartSegments_${USER}`, String(snap.player.heartsSegs|0));
      if (typeof window._redrawHeartsHud==='function'){ try{ window._redrawHeartsHud(); }catch{} }
    }

    // Position
    if (window.IZZA?.api?.player && snap.player){
      const p=IZZA.api.player;
      if (typeof snap.player.x==='number') p.x=snap.player.x;
      if (typeof snap.player.y==='number') p.y=snap.player.y;
      try{ IZZA.api.camera.x=p.x-200; IZZA.api.camera.y=p.y-120; }catch{}
    }
  }

  async function boot(){
    addOverlay();

    // Wait core or 1s
    await Promise.race([
      new Promise(res=>{ try{ (window.IZZA=window.IZZA||{}).on?.('ready', res); }catch{} }),
      sleep(1000)
    ]);
    await waitFrames(6);
    await sleep(450);

    // NEW: wait for non-guest user
    const USER = await waitForUser(10000);

    let snap = await fetchSnapshot(USER);
    if(!snap){
      const localLG=getJSON(`izzaBankLastGood_${USER}`, null);
      if(localLG && !isEmptySnapshot(localLG)) snap=localLG;
    }

    if (snap && !isEmptySnapshot(snap)) applySnapshot(snap, USER);

    await waitFrames(2);
    removeOverlay();
  }

  if (document.readyState==='loading') document.addEventListener('DOMContentLoaded', boot, {once:true});
  else boot();
})();
</script>
