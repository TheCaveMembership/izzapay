/* IZZA Persist v2.4.2 — coins = WALLET (on-hand), bank saved separately; missions + hearts */
(function(){
  const BASE = (window.IZZA_PERSIST_BASE || '').replace(/\/+$/,'');
  if (!BASE) { console.warn('[persist] IZZA_PERSIST_BASE missing'); return; }

  // ----- user key same way Diagnostics resolves it -----
  function userKey(){
    try{
      const p = (window.__IZZA_PROFILE__||{});
      let u = (p.username || p.user || '').toString();
      if(!u){
        const raw = localStorage.getItem('piAuthUser');
        if(raw){ try{ u=(JSON.parse(raw)||{}).username||''; }catch{} }
      }
      if(!u && window.izzaUserKey?.get) u = izzaUserKey.get();
      if(!u) u='guest';
      return u.toString().trim().replace(/^@+/,'').toLowerCase();
    }catch{ return 'guest'; }
  }

  // ----- readers (match your Diagnostics/keys) -----
  function readBank(u){
    try{
      const raw = localStorage.getItem('izzaBank_'+u);
      if(!raw) return { coins:0, items:{}, ammo:{} };
      const j = JSON.parse(raw);
      return { coins:(j.coins|0)||0, items:j.items||{}, ammo:j.ammo||{} };
    }catch{ return { coins:0, items:{}, ammo:{} }; }
  }
  function readInventory(){
    try{
      if (window.IZZA?.api?.getInventory) return JSON.parse(JSON.stringify(IZZA.api.getInventory()||{}));
      const raw = localStorage.getItem('izzaInventory'); return raw? JSON.parse(raw) : {};
    }catch{ return {}; }
  }
  function readCoinsOnHand(){
    try{
      if (window.IZZA?.api?.getCoins) return IZZA.api.getCoins()|0;
      const raw = localStorage.getItem('izzaCoins'); return raw? (parseInt(raw,10)||0) : 0;
    }catch{ return 0; }
  }
  function readMissions(){
    try{
      if (window.IZZA?.api?.getMissionCount) return IZZA.api.getMissionCount()|0;
      const raw = localStorage.getItem('izzaMissions'); return raw? (parseInt(raw,10)||0) : 0;
    }catch{ return 0; }
  }
  function readHeartsSegs(){
    const u=userKey();
    const a = localStorage.getItem('izzaCurHeartSegments_'+u);
    const b = localStorage.getItem('izzaCurHeartSegments');
    // Prefer the live/global key if present; otherwise fall back to user-scoped
    const raw = (b!=null ? b : a);
    if (raw==null) return null;
    const v = parseInt(raw,10);
    return Number.isFinite(v) ? Math.max(0, v|0) : null;
  }
  function readPlayerXY(){
    try{
      const p = IZZA?.api?.player;
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return {x:p.x|0, y:p.y|0};
    }catch{}
    try{
      const j = JSON.parse(localStorage.getItem('izzaMission3Pos')||'{}');
      if (Number.isFinite(j.x) && Number.isFinite(j.y)) return {x:j.x|0, y:j.y|0};
    }catch{}
    return {x:0,y:0};
  }

  // ---------- snapshot builder ----------
  function buildSnapshot(){
    const u      = userKey();
    const bank   = readBank(u);
    const inv    = readInventory();
    const onHand = readCoinsOnHand();
    const pos    = readPlayerXY();
    const heartsSegs = readHeartsSegs();
    const missions   = readMissions();

    // WALLET ONLY lives in snapshot.coins
    return {
      version: 1,
      player: { x: pos.x|0, y: pos.y|0, heartsSegs },
      coins: onHand|0,                    // WALLET ONLY
      missions: missions|0,
      inventory: inv || {},
      bank: bank || { coins:0, items:{}, ammo:{} },
      timestamp: Date.now()
    };
  }

  // “blank” means: wallet 0 AND bank empty AND inventory empty AND no heartsKnown
  function looksEmpty(s){
    const bankEmpty = !s.bank || (((s.bank.coins|0)===0) && !Object.keys(s.bank.items||{}).length && !Object.keys(s.bank.ammo||{}).length);
    const invEmpty  = !s.inventory || !Object.keys(s.inventory).length;
    const coinsZero = (s.coins|0)===0; // s.coins is WALLET
    const heartsKnown = !!(s.player && s.player.heartsSegs!=null);   // hearts-only is meaningful
    return bankEmpty && invEmpty && coinsZero && !heartsKnown;
  }

  const Persist = {
    async load(){
      const u=userKey();
      try{
        const r = await fetch(`${BASE}/api/state/${encodeURIComponent(u)}`, {credentials:'omit'});
        const j = await r.json();
        return {ok:true, data:j};
      }catch(e){ console.warn('[persist] load failed', e); return {ok:false, error:String(e)}; }
    },
    async save(snap){
      const u=userKey();
      try{
        const r = await fetch(`${BASE}/api/state/${encodeURIComponent(u)}`, {
          method:'POST',
          headers:{'content-type':'application/json'},
          body: JSON.stringify(snap||buildSnapshot()),
          keepalive:true, credentials:'omit'
        });
        const j = await r.json().catch(()=>({}));
        return {ok: !!j?.ok, resp:j};
      }catch(e){ console.warn('[persist] save failed', e); return {ok:false, error:String(e)}; }
    }
  };
  window.IZZA_PERSIST = Persist;

  // ----- boot & save orchestration -----
  let serverSeed=null, loaded=false, ready=false, armed=false;
  let saveBusy=false, needLater=false, lastGood=null;

  function armOnce(){ if(armed) return; armed=true; tryKick('armed'); }

  // wait for core ready
  if (window.IZZA?.on) {
    IZZA.on('ready', ()=>{ ready=true; armOnce(); });
  } else {
    setTimeout(()=>{ ready=true; armOnce(); }, 2500);
  }
  setTimeout(()=>{ armOnce(); }, 7000);

  (async function init(){
    const res = await Persist.load();
    if(res.ok) serverSeed = res.data;
    loaded=true;
    if (serverSeed && !looksEmpty(serverSeed)) {
      console.log('[persist] server has non-empty snapshot; blank overwrites disabled');
    } else {
      console.log('[persist] server empty or missing; waiting for first non-blank local save');
    }
  })();

  async function tryKick(reason){
    if(!loaded || !armed || !ready) return;

    const snap = buildSnapshot();
    if (serverSeed && !looksEmpty(serverSeed) && looksEmpty(snap)) {
      console.log('[persist] skip blank (server already has data)', reason); return;
    }
    if (looksEmpty(snap)) { console.log('[persist] still blank', reason); return; }

    lastGood = snap;

    if (saveBusy){ needLater=true; return; }
    saveBusy=true;
    const r = await Persist.save(snap);
    saveBusy=false;

    if (r.ok) {
      console.log('[persist] saved', reason, snap);
      serverSeed = snap;
      toast('Saved!');
    } else if (needLater) {
      needLater=false; tryKick('retry');
    } else {
      toast('Save failed');
    }
  }

  // ---- event-driven saves (bank/coins/inventory/hearts) ----
  window.addEventListener('izza-bank-changed',     ()=> tryKick('bank'));
  window.addEventListener('izza-coins-changed',    ()=> tryKick('coins'));
  window.addEventListener('izza-inventory-changed',()=> tryKick('inv'));
  window.addEventListener('izza-hearts-changed',   ()=> tryKick('hearts'));

  // ---- hearts watcher (works even if no event is emitted) ----
  let _lastHearts = readHeartsSegs();
  setInterval(()=>{
    const cur = readHeartsSegs();
    if (cur!=null && cur !== _lastHearts){
      _lastHearts = cur;
      tryKick('hearts-watch');
    }
  }, 2000);

  // Also react if another tab changes the hearts LS key
  window.addEventListener('storage', (e)=>{
    const u=userKey();
    if (e && (e.key===`izzaCurHeartSegments_${u}` || e.key==='izzaCurHeartSegments')){
      _lastHearts = readHeartsSegs();
      tryKick('hearts-storage');
    }
  });

  // periodic poll remains
  setInterval(()=> tryKick('poll'), 5000);

  // before close (Safari/Pi)
  window.addEventListener('pagehide', ()=>{
    const snap = lastGood || buildSnapshot();
    if (!looksEmpty(snap) && navigator.sendBeacon) {
      navigator.sendBeacon(
        `${BASE}/api/state/${encodeURIComponent(userKey())}`,
        new Blob([JSON.stringify(snap)], {type:'application/json'})
      );
    }
  });

  // manual helper for you while testing
  window._izzaForceSave = ()=> { armed=true; ready=true; loaded=true; tryKick('manual'); };

  // ---------- tiny toast ----------
  function toast(msg, ms=1400){
    if (window.IZZA?.toast) { IZZA.toast(msg); return; }
    let h = document.getElementById('persistToast');
    if(!h){
      h = document.createElement('div');
      h.id='persistToast';
      Object.assign(h.style,{
        position:'fixed', right:'12px', top:'72px', zIndex:10000,
        background:'rgba(10,12,18,.88)', border:'1px solid #394769',
        color:'#cfe0ff', padding:'8px 10px', borderRadius:'10px', fontSize:'14px'
      });
      document.body.appendChild(h);
    }
    h.textContent = msg; h.style.display='block';
    clearTimeout(h._t);
    h._t = setTimeout(()=>{ h.style.display='none'; }, ms);
  }
})();
