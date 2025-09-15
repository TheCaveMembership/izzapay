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
    // 1) Primary: api.getMissionCount if your core exposes it
    if (window.IZZA?.api?.getMissionCount) return IZZA.api.getMissionCount()|0;

    // 2) Fallback: inventory meta
    const meta = window.IZZA?.api?.inventory?.getMeta?.('missionsCompleted');
    if (Number.isFinite(meta)) return meta|0;

    // 3) Legacy fallback: localStorage key
    const raw = localStorage.getItem('izzaMissions');
    return raw ? (parseInt(raw,10)||0) : 0;
  }catch{
    return 0;
  }
}
  function readHeartsSegs(){
    const u=userKey();
    const a = localStorage.getItem('izzaCurHeartSegments_'+u);
    const b = localStorage.getItem('izzaCurHeartSegments');
    const raw = (a??b);
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
    // capture the full mission state object (core v3)
const missionState = IZZA?.api?.getMissionState
    ? IZZA.api.getMissionState()
    : (JSON.parse(localStorage.getItem('izzaMissionState')||'{}'));

    // WALLET ONLY lives in snapshot.coins
      return {
    version: 1,
    player: { x: pos.x|0, y: pos.y|0, heartsSegs },
    coins: onHand|0,
    missions: missions|0,
    missionState: missionState || {},
    inventory: inv || {},
    bank: bank || { coins:0, items:{}, ammo:{} },
    timestamp: Date.now()
  };
} // end buildSnapshot
  // “blank” means: wallet 0 AND bank empty AND inventory empty AND no heartsKnown
  // “blank” means: ... (we don't want this anymore)
  // ---- hydrate missions from server + keep all counters in sync
function applyServerMissions(seed){
  try{
    if (!seed) return;

    // 1) Apply the structured missionState
    const ms = seed.missionState && typeof seed.missionState === 'object' ? seed.missionState : {};
    if (Object.keys(ms).length){
      if (IZZA?.api?.setMissionState){
        IZZA.api.setMissionState(ms);
      } else if (window.setMissionEntry){
        for (const [id, state] of Object.entries(ms)){
          try{ setMissionEntry(id, state); }catch{}
        }
      } else {
        localStorage.setItem('izzaMissionState', JSON.stringify(ms));
      }
    }

    // 2) Figure out the numeric "missions completed" count
    let count = Number(seed.missions)|0;
    if (!count){
      // fallback: infer from missionState
      try{
        count = Object.values(ms)
          .filter(v => v === true || v === 'done' || v?.done === true || v?.status === 'done')
          .length | 0;
      }catch{ count = 0; }
    }

    // 3) Push to both the meta and the legacy localStorage key
    try{ IZZA?.api?.inventory?.setMeta?.('missionsCompleted', count); }catch{}
    try{ localStorage.setItem('izzaMissions', String(count)); }catch{}

    // 4) Convenience flags (so M4/M5 scripts “see” past completions on fresh load)
    try{ if (count >= 4) localStorage.setItem('izzaMission4_done','1'); }catch{}
    try{ if (count >= 5) localStorage.setItem('izzaMission5_done','1'); }catch{}

    // 5) Nudge any listeners and the saver
    try{ IZZA.emit?.('missions-updated', { hydrated:true, completed: count }); }catch{}
    try{ window.dispatchEvent(new Event('izza-missions-changed')); }catch{}

    console.log('[persist] missions hydrated →', { count, msKeys:Object.keys(ms).length });
  }catch(e){
    console.warn('[persist] applyServerMissions failed', e);
  }
}
  // ---- hydrate inventory/coins/bank/hearts/position from server
function applyServerCore(seed){
  try{
    if (!seed) return;

    // INVENTORY
    if (seed.inventory && typeof seed.inventory === 'object'){
      try{
        if (IZZA?.api?.setInventory) IZZA.api.setInventory(seed.inventory);
        else localStorage.setItem('izzaInventory', JSON.stringify(seed.inventory));
        try{ window.dispatchEvent(new Event('izza-inventory-changed')); }catch{}
      }catch(e){ console.warn('[persist] inv hydrate failed', e); }
    }

    // WALLET COINS (on-hand)
    if (Number.isFinite(seed.coins)){
      try{
        if (IZZA?.api?.setCoins) IZZA.api.setCoins(seed.coins|0);
        else localStorage.setItem('izzaCoins', String(seed.coins|0));
        try{ window.dispatchEvent(new Event('izza-coins-changed')); }catch{}
      }catch(e){ console.warn('[persist] coins hydrate failed', e); }
    }

    // BANK (per-user key)
    if (seed.bank && typeof seed.bank === 'object'){
      try{
        const u = userKey();
        localStorage.setItem('izzaBank_'+u, JSON.stringify({
          coins: (seed.bank.coins|0)||0,
          items: seed.bank.items||{},
          ammo:  seed.bank.ammo||{}
        }));
        try{ window.dispatchEvent(new Event('izza-bank-changed')); }catch{}
      }catch(e){ console.warn('[persist] bank hydrate failed', e); }
    }

    // HEARTS (segments)
    if (seed.player && seed.player.heartsSegs!=null){
      try{
        const u = userKey();
        localStorage.setItem('izzaCurHeartSegments_'+u, String(seed.player.heartsSegs|0));
        try{ window.dispatchEvent(new Event('izza-hearts-changed')); }catch{}
      }catch(e){ console.warn('[persist] hearts hydrate failed', e); }
    }

    // PLAYER POSITION (best-effort)
    if (seed.player && Number.isFinite(seed.player.x) && Number.isFinite(seed.player.y)){
      try{
        if (IZZA?.api?.teleport) {
          IZZA.api.teleport(seed.player.x|0, seed.player.y|0);
        } else {
          // legacy hint some plugins read
          localStorage.setItem('izzaMission3Pos', JSON.stringify({x:seed.player.x|0, y:seed.player.y|0}));
        }
      }catch(e){ console.warn('[persist] pos hydrate failed', e); }
    }

    console.log('[persist] core hydrated');
  }catch(e){
    console.warn('[persist] applyServerCore failed', e);
  }
}
function looksEmpty(_s){
  // We no longer block any snapshot as "blank".
  // Even 0 coins / empty inv / only missionState should still save.
  return false;
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
  IZZA.on('ready', ()=>{
    ready = true;
    try { applyServerMissions(serverSeed); } catch(e){ console.warn(e); }
    try { applyServerCore(serverSeed); }      catch(e){ console.warn(e); } // <-- ADD
    armOnce();
    tryKick('post-hydrate');
  });
} else {
  setTimeout(()=>{
    ready = true;
    try { applyServerMissions(serverSeed); } catch(e){ console.warn(e); }
    try { applyServerCore(serverSeed); }      catch(e){ console.warn(e); } // <-- ADD
    armOnce();
    tryKick('post-hydrate-fallback');
  }, 2500);
}
// also give ample grace after any tier reloads
setTimeout(()=>{ armOnce(); }, 7000);
  (async function init(){
  const res = await Persist.load();
  if (res.ok) serverSeed = res.data;
  loaded = true;

  if (serverSeed) {
    console.log('[persist] seed fetched', serverSeed);
  }

  if (serverSeed && !looksEmpty(serverSeed)) {
    console.log('[persist] server has non-empty snapshot; blank overwrites disabled');
  } else {
    console.log('[persist] server empty or missing; waiting for first non-blank local save');
  }
    // If the core is already ready by the time load completes, hydrate now too.
if (ready) {
  try { applyServerMissions(serverSeed); } catch(e){ console.warn(e); }
  try { applyServerCore(serverSeed); }      catch(e){ console.warn(e); } // <-- ADD
  armOnce();
  tryKick('post-hydrate-init');
}
})();

  async function tryKick(reason){
    if(!loaded || !armed || !ready) return;

    const snap = buildSnapshot();
    // never push blank over a non-empty server
    if (serverSeed && !looksEmpty(serverSeed) && looksEmpty(snap)) {
      console.log('[persist] skip blank (server already has data)', reason); return;
    }
    // if still blank, just wait
    if (looksEmpty(snap)) { console.log('[persist] still blank', reason); return; }

    lastGood = snap;

    if (saveBusy){ needLater=true; return; }
    saveBusy=true;
    const r = await Persist.save(snap);
    saveBusy=false;

    if (r.ok) {
      console.log('[persist] saved', reason, snap);
      serverSeed = snap; // from now on, blank overwrites are blocked
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
  window.addEventListener('izza-hearts-changed',   ()=> tryKick('hearts'));  // <-- listens if your hearts plugin emits
// Persist when missions change
window.addEventListener('izza-missions-changed', ()=> tryKick('missions'));
if (window.IZZA?.on) {
  // If your mission plugins also emit on the IZZA bus
  IZZA.on('missions-updated', ()=> tryKick('missions'));
}
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
