<script>
/* IZZA Persist v2 — posts/loads per-user state to your Node service
   Requires: window.IZZA_PERSIST_BASE (e.g. https://izzagame.onrender.com)
   Reads the same LS keys shown in Diagnostics so the snapshot matches your UI.
*/
(function(){
  const BASE = (window.IZZA_PERSIST_BASE || '').replace(/\/+$/,''); // no trailing slash
  if (!BASE) { console.warn('[persist] IZZA_PERSIST_BASE missing'); return; }

  // ---------- resolve user key exactly like Diagnostics ----------
  function userKey(){
    try{
      const p = (window.__IZZA_PROFILE__||{});
      const fromPi = (p.username || p.user || '').toString();
      const fromLS  = (localStorage.getItem('piAuthUser')||'');
      let u = fromPi;
      if(!u && fromLS){ try{ u = (JSON.parse(fromLS)||{}).username || ''; }catch{} }
      if(!u && window.izzaUserKey && izzaUserKey.get) u = izzaUserKey.get();
      if(!u) u = 'guest';
      u = u.toString().trim().replace(/^@+/,'').toLowerCase();
      return u;
    }catch{ return 'guest'; }
  }

  // ---------- build snapshot from your live/LS data ----------
  function readBank(u){
    try{
      const raw = localStorage.getItem('izzaBank_'+u);
      if(!raw) return { coins:0, items:{}, ammo:{} };
      const j = JSON.parse(raw);
      return {
        coins: (j.coins|0)||0,
        items: j.items || {},
        ammo:  j.ammo  || {}
      };
    }catch{ return { coins:0, items:{}, ammo:{} }; }
  }
  function readInventory(){
    // prefer the core getter if present, else the legacy LS blob
    try{
      if (window.IZZA?.api?.getInventory) return JSON.parse(JSON.stringify(IZZA.api.getInventory()||{}));
      const raw = localStorage.getItem('izzaInventory'); return raw? JSON.parse(raw) : {};
    }catch{ return {}; }
  }
  function readCoins(){
    try{
      if (window.IZZA?.api?.getCoins) return IZZA.api.getCoins()|0;
      const raw = localStorage.getItem('izzaCoins'); return raw? (parseInt(raw,10)||0) : 0;
    }catch{ return 0; }
  }
  function readHeartsSegs(){
    // hearts plugin stores segments in izzaCurHeartSegments or izzaCurHeartSegments_<user>
    const u = userKey();
    const kUser = 'izzaCurHeartSegments_'+u;
    const raw = localStorage.getItem(kUser) ?? localStorage.getItem('izzaCurHeartSegments');
    if (raw==null) return null;
    const v = parseInt(raw,10);
    return Number.isFinite(v) ? Math.max(0, v|0) : null;
  }
  function readPlayerXY(){
    // take last known position from core v3 if available; else mission pos; else 0,0
    try{
      if (window.IZZA?.api?.player) {
        const p = IZZA.api.player;
        if (Number.isFinite(p.x) && Number.isFinite(p.y)) return { x:p.x|0, y:p.y|0 };
      }
    }catch{}
    try{
      const p3 = JSON.parse(localStorage.getItem('izzaMission3Pos')||'{}');
      if (Number.isFinite(p3.x) && Number.isFinite(p3.y)) return { x:p3.x|0, y:p3.y|0 };
    }catch{}
    return { x:0, y:0 };
  }

  function buildSnapshot(){
    const u = userKey();
    const bank = readBank(u);
    const inv  = readInventory();
    const coins= readCoins();
    const heartsSegs = readHeartsSegs();
    const pos = readPlayerXY();

    return {
      version: 1,
      player: { x: pos.x|0, y: pos.y|0, heartsSegs: heartsSegs },
      coins: coins|0,
      inventory: inv || {},
      bank: bank || { coins:0, items:{}, ammo:{} },
      timestamp: Date.now()
    };
  }

  // ---------- “blank” guard & shallow sanity ----------
  function looksEmpty(s){
    const bankEmpty = !s.bank || (((s.bank.coins|0)===0) && !Object.keys(s.bank.items||{}).length && !Object.keys(s.bank.ammo||{}).length);
    const invEmpty  = !s.inventory || !Object.keys(s.inventory).length;
    const coinsZero = (s.coins|0)===0;
    // allow non-zero hearts to still count as non-empty state
    return bankEmpty && invEmpty && coinsZero;
  }

  // ---------- client API ----------
  const Persist = {
    get url(){ return BASE; },
    user: userKey,
    async load(){
      const u = userKey();
      try{
        const r = await fetch(`${BASE}/api/state/${encodeURIComponent(u)}`, { credentials:'omit' });
        const j = await r.json();
        return { ok:true, data:j };
      }catch(e){
        console.warn('[persist] load failed', e);
        return { ok:false, error:String(e) };
      }
    },
    async save(snapshot){
      const u = userKey();
      const body = JSON.stringify(snapshot||buildSnapshot());
      try{
        const r = await fetch(`${BASE}/api/state/${encodeURIComponent(u)}`, {
          method:'POST',
          headers:{ 'content-type':'application/json' },
          body,
          keepalive:true,   // so it can run during unload on Safari
          credentials:'omit'
        });
        const j = await r.json().catch(()=>({}));
        return { ok: !!j?.ok, resp:j };
      }catch(e){
        console.warn('[persist] save failed', e);
        return { ok:false, error:String(e) };
      }
    }
  };
  window.IZZA_PERSIST = Persist;

  // ---------- boot logic ----------
  let _serverSeed = null;        // what the server already has
  let _loaded = false;
  let _firstSaveArmed = false;

  // 1) Load the server snapshot once.
  (async function init(){
    const res = await Persist.load();
    if (res.ok) _serverSeed = res.data;
    _loaded = true;

    // If server has a *non-empty* snapshot, do NOT let any blank local pass overwrite it.
    if (_serverSeed && !looksEmpty(_serverSeed)) {
      console.log('[persist] server has snapshot; will refuse blank overwrites');
    } else {
      console.log('[persist] server empty; waiting for non-blank local save');
    }

    // arm a delayed first save after map tier reloads finish
    // (map expander + mission3 may reload once; give them time)
    setTimeout(()=>{ _firstSaveArmed = true; tryKickSave('first-delay'); }, 3500);
  })();

  // 2) Throttled “save now if non-blank” helper
  let _saveBusy = false, _saveNeeds = false, _lastOkSnap = null;
  async function tryKickSave(reason){
    if(!_loaded || !_firstSaveArmed) return;
    const snap = buildSnapshot();
    // hard guard: if server already non-empty, never push a blank
    if (_serverSeed && !looksEmpty(_serverSeed) && looksEmpty(snap)) {
      console.log('[persist] skip blank due to server non-empty (',reason,')');
      return;
    }
    // also skip if still blank with no server data yet
    if (looksEmpty(snap)) {
      console.log('[persist] skip blank (',reason,')');
      return;
    }
    _lastOkSnap = snap; // remember last good locally

    if (_saveBusy) { _saveNeeds = true; return; }
    _saveBusy = true;
    const r = await Persist.save(snap);
    _saveBusy = false;
    if (!r.ok && _saveNeeds) { _saveNeeds=false; tryKickSave('retry'); }
  }

  // 3) Wire to your existing events (plus periodic)
  window.addEventListener('izza-bank-changed', ()=> tryKickSave('bank-changed'));
  window.addEventListener('izza-coins-changed',()=> tryKickSave('coins-changed'));
  window.addEventListener('izza-inventory-changed',()=> tryKickSave('inv-changed'));

  // guns.js could emit its own — we’ll also poll
  setInterval(()=> tryKickSave('periodic'), 15000);

  // 4) Before-unload save (Safari/PI keepalive friendly)
  window.addEventListener('pagehide', ()=> {
    const snap = _lastOkSnap || buildSnapshot();
    if (!looksEmpty(snap)) navigator.sendBeacon &&
      navigator.sendBeacon(`${BASE}/api/state/${encodeURIComponent(userKey())}`,
                           new Blob([JSON.stringify(snap)], {type:'application/json'}));
  });

})();
</script>
