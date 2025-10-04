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
  function readCraftingCredits(){
    try{
      // LS aliases used by the crafting UI
      const a = localStorage.getItem('izzaCrafting');
      const b = localStorage.getItem('craftingCredits');
      const c = localStorage.getItem('izzaCraftCredits');

      // Cookie (cross-subdomain mirror)
      let ck = 0;
      try{
        const m = document.cookie.split('; ').find(s => s.startsWith('izzaCrafting='));
        if (m) ck = parseInt(decodeURIComponent(m.split('=').slice(1).join('='))||'0',10) || 0;
      }catch{}

      const nums = [a,b,c].map(v => parseInt(v||'0',10) || 0);
      nums.push(ck);
      return Math.max(...nums, 0)|0;
    }catch{ return 0; }
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
      const meta = window.IZZA?.api?.inventory?.getMeta?.('missionsCompleted');
      if (Number.isFinite(meta)) return meta|0;
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
    const missionState = IZZA?.api?.getMissionState
      ? IZZA.api.getMissionState()
      : (JSON.parse(localStorage.getItem('izzaMissionState')||'{}'));

    const craftingCredits = readCraftingCredits(); // already computed

    return {
      version: 1,
      player: { x: pos.x|0, y: pos.y|0, heartsSegs },
      coins: onHand|0,
      missions: missions|0,
      missionState: missionState || {},
      inventory: inv || {},
      bank: bank || { coins:0, items:{}, ammo:{} },
      craftingCredits: craftingCredits|0,
      timestamp: Date.now()
    };
  }

  // ---- hydrate missions from server + keep all counters in sync
  function applyServerMissions(seed){
    try{
      if (!seed) return;

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

      let count = Number(seed.missions)|0;
      if (!count){
        try{
          count = Object.values(ms)
            .filter(v => v === true || v === 'done' || v?.done === true || v?.status === 'done')
            .length | 0;
        }catch{ count = 0; }
      }

      try{ IZZA?.api?.inventory?.setMeta?.('missionsCompleted', count); }catch{}
      try{ localStorage.setItem('izzaMissions', String(count)); }catch{}
      try{ if (count >= 4) localStorage.setItem('izzaMission4_done','1'); }catch{}
      try{ if (count >= 5) localStorage.setItem('izzaMission5_done','1'); }catch{}
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

      // WALLET COINS (on-hand) — take the GREATER of local vs server, then push up later if local won
      if (Number.isFinite(seed.coins)){
        try{
          const local = readCoinsOnHand()|0;
          const serverVal = seed.coins|0;
          const maxVal = Math.max(local, serverVal)|0;

          if (IZZA?.api?.setCoins) IZZA.api.setCoins(maxVal);
          else localStorage.setItem('izzaCoins', String(maxVal));

          try{ window.dispatchEvent(new Event('izza-coins-changed')); }catch{}

          // If local was higher, schedule a save to lift the server snapshot
          if (local > serverVal){
            tryKick('coins-raise');
          }
        }catch(e){ console.warn('[persist] coins hydrate failed', e); }
      }

      // BANK (per-user key) — server is source of truth (leave as-is)
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

      // CRAFTING CREDITS — GREATER of local mirrors/cookie vs server, mirror to all
      if (Number.isFinite(seed.craftingCredits)){
        try{
          const localCC = readCraftingCredits()|0;
          const serverCC = seed.craftingCredits|0;
          const n = Math.max(localCC, serverCC)|0;

          if (typeof window.setCraftingCredits === 'function'){
            window.setCraftingCredits(n);
          } else {
            localStorage.setItem('izzaCrafting',     String(n));
            localStorage.setItem('craftingCredits',  String(n));
            localStorage.setItem('izzaCraftCredits', String(n));
            // Cookie mirror (one year)
            try{
              const v = encodeURIComponent(String(n));
              const base = `izzaCrafting=${v}; Path=/; Max-Age=${60*60*24*365}; SameSite=None; Secure`;
              document.cookie = base;
              if (location.hostname.endsWith('.onrender.com')){
                document.cookie = `izzaCrafting=${v}; Path=/; Domain=.onrender.com; Max-Age=${60*60*24*365}; SameSite=None; Secure`;
              }
            }catch{}
            try{ window.dispatchEvent(new Event('izza-crafting-changed')); }catch{}
          }

          if (localCC > serverCC){
            tryKick('craft-credits-raise');
          }
        }catch(e){ console.warn('[persist] credits hydrate failed', e); }
      }

      // HEARTS (segments)
      if (seed.player && seed.player.heartsSegs != null){
        try{
          const segs = seed.player.heartsSegs|0;
          const u = userKey();
          localStorage.setItem('izzaCurHeartSegments_'+u, String(segs));
          localStorage.setItem('izzaCurHeartSegments',    String(segs));
          try{ window.dispatchEvent(new Event('izza-hearts-changed')); }catch{}
          try{ if (typeof window._redrawHeartsHud === 'function') window._redrawHeartsHud(); }catch{}
        }catch(e){ console.warn('[persist] hearts hydrate failed', e); }
      }

      // PLAYER POSITION
      if (seed.player && Number.isFinite(seed.player.x) && Number.isFinite(seed.player.y)){
        const tx = seed.player.x|0, ty = seed.player.y|0;
        try{
          if (IZZA?.api?.player) {
            IZZA.api.player.x = tx;
            IZZA.api.player.y = ty;
            try {
              if (IZZA.api.camera) {
                IZZA.api.camera.x = IZZA.api.player.x - 200;
                IZZA.api.camera.y = IZZA.api.player.y - 120;
              }
            } catch {}
          }
          if (IZZA?.api?.teleport) {
            IZZA.api.teleport(tx, ty);
          } else {
            localStorage.setItem('izzaMission3Pos', JSON.stringify({x:tx, y:ty}));
          }
        }catch(e){ console.warn('[persist] pos hydrate failed', e); }
      }

      console.log('[persist] core hydrated');
    }catch(e){
      console.warn('[persist] applyServerCore failed', e);
    }
  }

  // “blank” means: wallet 0 AND bank empty AND inventory empty AND no heartsKnown
  function looksEmpty(s){
    try{
      if (!s || typeof s!=='object') return true;
      const invEmpty  = !s.inventory || !Object.keys(s.inventory).length;
      const bankEmpty = !s.bank || (
        ((s.bank.coins|0)===0) &&
        (!s.bank.items || !Object.keys(s.bank.items).length) &&
        (!s.bank.ammo  || !Object.keys(s.bank.ammo).length)
      );
      const walletZero   = (s.coins|0)===0;
      const heartsUnknown= (s.player?.heartsSegs==null);
      const creditsZero  = (s.craftingCredits|0)===0; // <— NEW
      return walletZero && bankEmpty && invEmpty && heartsUnknown && creditsZero;
    }catch{ return true; }
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
    // ---------- Leaderboard shim (uses same endpoints mini-games/Arena expect) ----------
  function bearerHeaders(base) {
    const h = Object.assign({'content-type':'application/json'}, base||{});
    try {
      const b = localStorage.getItem('izzaBearer') || '';
      if (b) h['authorization'] = 'Bearer ' + b;
    } catch {}
    return h;
  }
  function userParamPair() {
    // keep it consistent with your username bootstrapper
    try {
      const u =
        (window.__IZZA_PROFILE__ && window.__IZZA_PROFILE__.username) ||
        (window.izzaUserKey && typeof window.izzaUserKey.get==='function' && window.izzaUserKey.get()) ||
        (localStorage.getItem('izzaUserU')||'');
      return encodeURIComponent((u||'').toString().trim().replace(/^@+/, '').toLowerCase());
    } catch { return 'guest'; }
  }
  function urlWithTU(path) {
    // helpful for same-origin calls that want t/u in the querystring
    try{
      const url = new URL(path, location.origin);
      const T = localStorage.getItem('izzaTokenT') || '';
      const U = userParamPair();
      if (T) url.searchParams.set('t', T);
      if (U) url.searchParams.set('u', U);
      return url.pathname + (url.search ? url.search : '');
    } catch { return path; }
  }

  async function postJSON(url, body, opts) {
    const res = await fetch(url, Object.assign({
      method:'POST',
      mode: 'cors',
      credentials: 'omit', // cross-origin to BASE
      headers: bearerHeaders(),
      body: JSON.stringify(body||{})
    }, opts||{}));
    let j={}; try{ j = await res.json(); }catch(_){}
    return { ok: res.ok && (!!j.ok || !j.error), status: res.status, data: j };
  }
  async function getJSON(url, opts) {
    const res = await fetch(url, Object.assign({
      method:'GET',
      mode: 'cors',
      credentials: 'omit',
      headers: bearerHeaders()
    }, opts||{}));
    let j={}; try{ j = await res.json(); }catch(_){}
    return { ok: res.ok && (!j.error), status: res.status, data: j };
  }

  // Same paths your code already tries: same-origin first, then BASE mirrors.
  const LB_ENDPOINTS = {
    submit: () => ([
      urlWithTU('/izza-game/api/leaderboard/submit'),
      `${BASE}/izza-game/api/leaderboard/submit`,
      `${BASE}/api/leaderboard/submit`
    ]),
    top: (qs) => ([
      urlWithTU(`/izza-game/api/leaderboard${qs}`),
      `${BASE}/izza-game/api/leaderboard${qs}`,
      `${BASE}/api/leaderboard${qs}`
    ])
  };

  async function tryMany(urls, fn) {
    for (const u of urls) {
      try {
        const r = await fn(u);
        if (r && r.ok) return r;
      } catch (_){ /* try next */ }
    }
    // return the last attempt (or a generic error)
    return { ok:false, status:0, data:{ error:'all endpoints failed' } };
  }

  const Leaderboard = {
    // Submit a score: { game: 'jetman'|'race'|'basketball', score:Number, hi?:Number, coinsDelta?:Number }
    async submit(payload) {
      const body = Object.assign({
        user: userParamPair(),
        ts: Date.now(),
        client: {
          dpr: (window.devicePixelRatio||1),
          w: (window.innerWidth||0)|0,
          h: (window.innerHeight||0)|0,
          ua: (navigator.userAgent||'')
        }
      }, payload||{});
      return await tryMany(LB_ENDPOINTS.submit(), (u)=>postJSON(u, body));
    },

    // Top N: default game=all, limit=100, period can be 'all','day','week','month' if your backend supports it
    async top({ game='all', limit=100, period='all' } = {}) {
      const qs = `?game=${encodeURIComponent(game)}&limit=${limit|0}&period=${encodeURIComponent(period)}`;
      return await tryMany(LB_ENDPOINTS.top(qs), (u)=>getJSON(u));
    },

    // Around a user’s rank: center on current user unless a different `user` is provided
    async around({ game='all', user, limit=25 } = {}) {
      const uu = encodeURIComponent(user || userParamPair());
      const qs = `?game=${encodeURIComponent(game)}&around=${uu}&limit=${limit|0}`;
      return await tryMany(LB_ENDPOINTS.top(qs), (u)=>getJSON(u));
    }
  };
  window.IZZA_LEADERBOARD = Leaderboard;

  // ----- boot & save orchestration -----
  let serverSeed=null, loaded=false, ready=false, armed=false;
  let saveBusy=false, needLater=false, lastGood=null;
  let freezeUntil=0; // hold off saves temporarily

  function armOnce(){ if(armed) return; armed=true; tryKick('armed'); }

  // wait for core ready
  if (window.IZZA?.on) {
    IZZA.on('ready', ()=>{
      ready = true;
      try { applyServerMissions(serverSeed); } catch(e){ console.warn(e); }
      try { applyServerCore(serverSeed); }      catch(e){ console.warn(e); }
      startEnforceFromSeed(8000); // enforce hearts/pos briefly to beat late resets
      armOnce();
      tryKick('post-hydrate');
    });
  } else {
    setTimeout(()=>{
      ready = true;
      try { applyServerMissions(serverSeed); } catch(e){ console.warn(e); }
      try { applyServerCore(serverSeed); }      catch(e){ console.warn(e); }
      armOnce();
      tryKick('post-hydrate-fallback');
    }, 2500);
  }

  // freeze saves for 5s after death + short settle after respawn
  if (window.IZZA?.on){
    IZZA.on('player-died',   ()=>{ freezeUntil = Date.now() + 5000; });
    IZZA.on('player-respawn',()=>{ freezeUntil = Math.max(freezeUntil, Date.now()+1200); });
  }

  // --- enforce hearts & position for a short window after hydrate (to beat late resets)
  let _enforceTimer = 0;
  function startEnforceFromSeed(ms=8000){
    if (_enforceTimer) { clearInterval(_enforceTimer); _enforceTimer = 0; }
    const until = Date.now() + ms;
    _enforceTimer = setInterval(()=>{
      if (Date.now() > until) { clearInterval(_enforceTimer); _enforceTimer = 0; return; }
      if (Date.now() < freezeUntil) return;

      try{
        const seed = serverSeed;
        if (!seed || !seed.player) return;

        // Hearts enforcement
        const targetH = (seed.player?.heartsSegs != null) ? (seed.player.heartsSegs|0) : null;
        if (targetH != null){
          const curH = readHeartsSegs();
          if (curH == null || (curH|0) !== targetH){
            const u = userKey();
            try{
              localStorage.setItem('izzaCurHeartSegments_'+u, String(targetH));
              localStorage.setItem('izzaCurHeartSegments',    String(targetH));
              try{ window.dispatchEvent(new Event('izza-hearts-changed')); }catch{}
              try{ if (typeof window._redrawHeartsHud === 'function') window._redrawHeartsHud(); }catch{}
            }catch(e){ console.warn('[persist] enforce hearts failed', e); }
          }
        }

        // Position enforcement
        const tx = Number.isFinite(seed.player.x) ? (seed.player.x|0) : null;
        const ty = Number.isFinite(seed.player.y) ? (seed.player.y|0) : null;
        if (tx!=null && ty!=null){
          const cur = readPlayerXY();
          if ((cur.x|0)!==tx || (cur.y|0)!==ty){
            try{
              if (IZZA?.api?.teleport) IZZA.api.teleport(tx, ty);
              else localStorage.setItem('izzaMission3Pos', JSON.stringify({x:tx, y:ty}));
            }catch(e){ console.warn('[persist] enforce pos failed', e); }
          }
        }
      }catch(e){
        console.warn('[persist] enforce loop err', e);
      }
    }, 300);
  }

  // also give ample grace after any tier reloads
  setTimeout(()=>{ armOnce(); }, 7000);

  /* ---- Legacy leaderboard POST adapter (keeps existing game code unchanged) ---- */
(function(){
  if (!window.fetch || !window.IZZA_LEADERBOARD) return;

  const ORIG_FETCH = window.fetch;

  // Heuristic: infer game id from URL/title so old pages don't need changes
  function guessGameId(){
    try{
      const p = (location.pathname || '').toLowerCase();
      if (p.includes('/minigames/basketball')) return 'basketball';
      if (p.includes('/minigames/race'))       return 'racing';
      if (p.includes('/minigames/jetman'))     return 'jetman';
      if (p.includes('/minigames/puzzle'))     return 'puzzle';
      if (p.includes('/minigames/targets'))    return 'targets';
      if (p.includes('/minigames/runner'))     return 'runner';
      // Arena modal can also submit; try reading selected tile if present
      const sel = document.querySelector('.tile[data-game] h3, [data-game].is-active, [data-game].selected');
      if (sel && sel.closest('[data-game]')) return (sel.closest('[data-game]').getAttribute('data-game')||'').toLowerCase();
      // Title fallback
      const t = (document.title||'').toLowerCase();
      if (t.includes('basketball')) return 'basketball';
      if (t.includes('driver'))     return 'racing';
      if (t.includes('jet-mon'))    return 'jetman';
      if (t.includes('puzzle'))     return 'puzzle';
      if (t.includes('target'))     return 'targets';
      if (t.includes('runner'))     return 'runner';
    }catch(_){}
    return 'unknown';
  }

  // Safely parse a JSON body (string | Blob | anything)
  async function readJsonBody(body){
    try{
      if (typeof body === 'string') return JSON.parse(body);
      if (body && typeof body.text === 'function') {
        const txt = await body.text();
        try{ return JSON.parse(txt); }catch{ return {}; }
      }
    }catch(_){}
    return {};
  }

  // We only intercept legacy POSTs to /izza-game/api/leaderboard (no /submit)
  function isLegacyLeaderboardPost(url, init){
    try{
      const u = new URL(url, location.origin);
      const isPost = String((init && init.method) || 'GET').toUpperCase() === 'POST';
      return isPost && u.pathname === '/izza-game/api/leaderboard';
    }catch(_){ return false; }
  }

  window.fetch = async function(resource, init){
    try{
      const url = typeof resource === 'string' ? resource : (resource && resource.url) || '';
      if (isLegacyLeaderboardPost(url, init)){
        const body = await readJsonBody((init||{}).body);
        const payload = {
          user:  (typeof userParamPair === 'function') ? userParamPair() : '',
          game:  body.game || guessGameId(),
          score: (body.score|0) || 0,
          // keep legacy stamps if present (server may ignore or use them)
          daily:   body.daily   || null,
          monthly: body.monthly || null,
          yearly:  body.yearly  || null,
          ts: Date.now(),
          client: {
            dpr:(window.devicePixelRatio||1),
            w:(window.innerWidth||0)|0,
            h:(window.innerHeight||0)|0,
            ua:(navigator.userAgent||'')
          }
        };

        // Pass through the unified submit shim (tries same-origin & BASE mirrors)
        const r = await window.IZZA_LEADERBOARD.submit(payload);

        // Make it look like the legacy endpoint replied OK so callers don’t break
        if (r && r.ok){
          return new Response(JSON.stringify({ ok:true, data:r.data||{} }), {
            status: 200,
            headers: { 'content-type':'application/json' }
          });
        }
        // Fall back to the original fetch if submit failed
      }
    }catch(_){ /* if anything goes wrong, fall through to original fetch */ }

    return ORIG_FETCH.apply(this, arguments);
  };
})();

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
      try { applyServerCore(serverSeed); }      catch(e){ console.warn(e); }
      startEnforceFromSeed(8000);
      armOnce();
      tryKick('post-hydrate-init');
    }
  })(); // <-- closes ONLY the inner async init IIFE

  // === keep tryKick at top level (not inside init) ===
  async function tryKick(reason){
    if (!loaded || !armed || !ready) return;

    // hold while death/respawn is stabilizing
    if (Date.now() < freezeUntil) return;

    const snap = buildSnapshot();

    // never push blank over a non-empty server
    if (serverSeed && !looksEmpty(serverSeed) && looksEmpty(snap)) {
      console.log('[persist] skip blank (server already has data)', reason);
      return;
    }
    // if still blank, just wait
    if (looksEmpty(snap)) {
      console.log('[persist] still blank', reason);
      return;
    }

    lastGood = snap;

    if (saveBusy){ needLater = true; return; }
    saveBusy = true;
    const r = await Persist.save(snap);
    saveBusy = false;

    if (r.ok) {
      console.log('[persist] saved', reason, snap);
      serverSeed = snap; // from now on, blank overwrites are blocked
      toast('Saved!');
    } else if (needLater) {
      needLater = false; tryKick('retry');
    } else {
      toast('Save failed');
    }
  }

  // ---- event-driven saves (bank/coins/inventory/hearts) ----
  window.addEventListener('izza-bank-changed',     ()=> tryKick('bank'));
  window.addEventListener('izza-coins-changed',    ()=> tryKick('coins'));
  window.addEventListener('izza-inventory-changed',()=> tryKick('inv'));
  window.addEventListener('izza-hearts-changed',   ()=> tryKick('hearts'));
  window.addEventListener('izza-missions-changed', ()=> tryKick('missions'));
  window.addEventListener('izza-crafting-changed', ()=> tryKick('craft-credits'));
  window.addEventListener('izza-credits-changed',  ()=> tryKick('craft-credits-core'));
  if (window.IZZA?.on) {
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
    // Crafting credits mirrors
    if (e && (e.key==='izzaCrafting' || e.key==='craftingCredits' || e.key==='izzaCraftCredits')){
      tryKick('craft-credits-storage');
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
