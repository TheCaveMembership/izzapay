(function(){
  // Prevent double-binding if this plugin hot-reloads
  if (window.__IZZA_CHASING_BOUND) return;
  window.__IZZA_CHASING_BOUND = true;

  const BUILD = 'v1.3-chasing-plugin+10s-escalation+lb-submit-t-u';
  console.log('[IZZA CHASING]', BUILD);

  // Signal to core/other plugins to disable any internal chasing logic.
  window.__IZZA_CHASING_PLUGIN_ACTIVE = true;

  // Tunables
  const MAX_STARS = 5;
  const REINFORCE_MS = { 3: 20000, 4: 10000, 5: 10000 }; // legacy drip (3★+) kept
  const ZERO_LOCK_MS = 1500;       // suppress phantom 1★ rebound after clear
  const SPAWN_GRACE_MS = 300;      // grace to let maintainCops() spawn before we clear stars

  // Chaser speed tuning (px/sec-ish; multiplied by dtSec)
  // For testing: make SWAT/Military same speed as police
  const TUNE = {
    policeSpd: 55,
    swatSpd:   55,
    armySpd:   55
  };

  let api = null;
  let reinforceAt = 0;
  let zeroLockUntil = 0;
  let lastWantedChangeAt = 0;

  // ---- “hijack session” 10s-escalation state ----
  // Timeline (relative to hijack start):
  //  t=0s:   1★ + spawn police
  //  t=10s:  2★ + spawn police
  //  t=20s:  3★ + spawn police
  //  t=30s:  4★ + spawn SWAT
  //  t=40s:  5★ + spawn Army   (tank handled by free-drive after 10s at 5★)
  const HIJACK_STEPS = [
    { at:  0,     stars: 1, kind: 'police' },
    { at: 10000,  stars: 2, kind: 'police' },
    { at: 20000,  stars: 3, kind: 'police' },
    { at: 30000,  stars: 4, kind: 'swat'   },
    { at: 40000,  stars: 5, kind: 'army'   },
  ];
  let hijackStartAt = 0;
  let hijackStepIdx = 0;

  function resetHijackTimeline(){
    hijackStartAt = 0;
    hijackStepIdx = 0;
  }

  // --- helpers ---------------------------------------------------------------
  function ensureArrays(){
    api.cops = api.cops || [];
  }

  // Cop stats
  function copSpeed(kind){
    return kind==='army' ? TUNE.armySpd
         : kind==='swat' ? TUNE.swatSpd
         :                 TUNE.policeSpd;
  }
  function copHP(kind){ return kind==='army'?6 : kind==='swat'?5 : 4; }

  function kindForStars(stars){
    if(stars>=4) return 'army';
    if(stars>=3) return 'swat';
    return 'police';
  }

  function spawnCop(kind){
    ensureArrays();
    // spawn at map edge corners
    const left = Math.random()<0.5;
    const top  = Math.random()<0.5;
    const gx = left ? api.unlocked.x0 : api.unlocked.x1;
    const gy = top  ? api.unlocked.y0 : api.unlocked.y1;
    const TILE = api.TILE;
    api.cops.push({
      x: gx*TILE, y: gy*TILE,
      spd: copSpeed(kind), hp: copHP(kind), kind,
      facing:'down'
    });
  }

  function maintainCops(){
    ensureArrays();
    const target = api.player.wanted|0;
    if (target<=0){
      api.cops.length = 0;
      return;
    }
    // We no longer “upgrade” existing cops to higher tiers; new spawns only.
    // So just pad/trim count by current tier without mutating existing ones.
    const k = kindForStars(target);
    while(api.cops.length > target) api.cops.pop();
    while(api.cops.length < target) spawnCop(k);
    // DO NOT mutate c.kind here — keeps existing units as-is.
  }

  function safeSetWanted(n){
    const prev = api.player.wanted|0;
    const now = performance.now();
    if(prev===0 && n===1 && now < zeroLockUntil) return; // swallow phantom 1★
    const clamped = Math.max(0, Math.min(MAX_STARS, n|0));
    if (clamped !== prev){
      api.setWanted(clamped);
      lastWantedChangeAt = now;
      // (Re)start reinforcement timer when escalating into 3★+
      if (clamped>=3){
        reinforceAt = now + (REINFORCE_MS[clamped] || 20000);
      } else {
        reinforceAt = 0;
      }
      maintainCops();
    }
  }

  // Drive 10s hijack timeline
  function tickHijackTimeline(){
    if (!hijackStartAt) return;
    const now = performance.now();

    // If player wiped all cops, pause the timeline until at least one exists.
    ensureArrays();
    if (api.cops.length === 0 && (api.player.wanted|0) > 0) return;

    while (hijackStepIdx < HIJACK_STEPS.length && now - hijackStartAt >= HIJACK_STEPS[hijackStepIdx].at){
      const step = HIJACK_STEPS[hijackStepIdx];

      // Only ever escalate upward
      const cur = api.player.wanted|0;
      if (step.stars > cur){
        safeSetWanted(step.stars);
      }
      // Spawn one extra of the step's tier to make the ramp visible
      spawnCop(step.kind);
      // Maintain to match total == stars (keeps tidy if extras existed)
      maintainCops();

      hijackStepIdx++;
    }
  }

  function updateCops(dtSec){
    const stars = api.player.wanted|0;

    // If there are no chasers but stars > 0, allow a short grace for spawns before clearing.
    ensureArrays();
    if(!api.cops.length){
      if(stars!==0){
        const now = performance.now();
        if (now - lastWantedChangeAt <= SPAWN_GRACE_MS){
          maintainCops(); // try to spawn immediately
          return;         // skip clearing this frame
        }
        // Past the grace window and still no cops? Then clear safely.
        safeSetWanted(0);
        zeroLockUntil = now + ZERO_LOCK_MS;
      }
      return;
    }

    // Chase movement
    for(const c of api.cops){
      const dx = api.player.x - c.x, dy = api.player.y - c.y;
      const m = Math.hypot(dx,dy) || 1;
      c.x += (dx/m) * c.spd * dtSec;
      c.y += (dy/m) * c.spd * dtSec;
      if(Math.abs(dy) >= Math.abs(dx)) c.facing = dy < 0 ? 'up' : 'down';
      else                              c.facing = dx < 0 ? 'left' : 'right';
    }

    // Run the 10s hijack escalation
    tickHijackTimeline();

    // Legacy reinforcement toward +1 star every interval at 3★+ (kept)
    const now = performance.now();
    if (reinforceAt && now >= reinforceAt){
      const cur = api.player.wanted|0;
      if (cur >= 3){
        const next = Math.min(MAX_STARS, cur + 1);
        if (next > cur) safeSetWanted(next);
        reinforceAt = performance.now() + (REINFORCE_MS[next] || 20000);
      } else {
        reinforceAt = 0;
      }
    }
  }

  // --- Event wiring ----------------------------------------------------------
  IZZA.on('ready', (a)=>{
    api = a;
    if(!api.unlocked){
      api.unlocked = api.unlocked || { x0:18, y0:18, x1:72, y1:42 };
    }
    ensureArrays();

    // If core started with any cops, clear them so we are authoritative
    api.cops.length = 0;

    // If there are existing stars, sync chasers to that count
    maintainCops();
    console.log('[CHASING] ready; stars=', api.player.wanted);
  });

  // Drive the chasing loop
  IZZA.on('update-post', ({dtSec})=>{
    if(!api) return;
    updateCops(dtSec||0.016);
  });

  // Normalize cop kills from anywhere
  IZZA.on('cop-killed', ({cop})=>{
    if(!api) return;
    ensureArrays();
    // Remove reference if still present (defensive)
    const i = api.cops.indexOf(cop);
    if(i>=0) api.cops.splice(i,1);

    if(api.cops.length===0){
      // Clear completely when last chaser drops.
      safeSetWanted(0);
      zeroLockUntil = performance.now() + ZERO_LOCK_MS;
      // Pause hijack timeline if everything got wiped
      resetHijackTimeline();
    }else{
      // Drop 1 star per cop kill (never below number of remaining chasers)
      const next = Math.max(api.cops.length, (api.player.wanted|0) - 1);
      safeSetWanted(next);
    }
  });

  // Respond to crimes emitted by other modules (vehicle hijack, vehicular hits, etc.)
  IZZA.on('crime', (evt)=>{
    if(!api || !evt || !evt.kind) return;

    switch(evt.kind){
      case 'hijack': {
        // Start 10s timeline fresh
        hijackStartAt = performance.now();
        hijackStepIdx = 0;

        // Apply step0 immediately: 1★ + spawn police
        const s0 = HIJACK_STEPS[0];
        safeSetWanted(s0.stars);
        spawnCop(s0.kind);
        maintainCops();
        break;
      }
      case 'vehicular-ped': {
        // Small instant bump for hits while driving
        safeSetWanted((api.player.wanted|0) + 1);
        break;
      }
      case 'vehicular-cop-kill': {
        // pre-emptive downshift (cop-killed hook will also run)
        safeSetWanted(Math.max(0, (api.player.wanted|0) - 1));
        break;
      }
      case 'gunshot': {
        const cur = api.player.wanted|0;
        safeSetWanted(Math.min(MAX_STARS, cur===0 ? 1 : cur));
        break;
      }
      default: break;
    }
  });

  // If someone else changes stars, just match chaser count; no tier morphing.
  IZZA.on('wanted-changed', ({to})=>{
    if(!api) return;
    maintainCops();
    lastWantedChangeAt = performance.now();
    if((to|0)>=3) reinforceAt = performance.now() + (REINFORCE_MS[to|0] || 20000);
    else reinforceAt = 0;
  });

  // Reset internal timers/state on death/respawn
  ;['player-death','player-died','player-respawn','respawn'].forEach(ev=>{
    IZZA.on(ev, ()=>{
      reinforceAt = 0;
      zeroLockUntil = 0;
      lastWantedChangeAt = performance.now();
      ensureArrays();
      resetHijackTimeline();
      if (api && api.cops) api.cops.length = 0;
      if (api && api.player) api.setWanted(0);
    });
  });

  // --- Longest Police Chase timer + leaderboard submit -----------------------
  (function(){
    if (window.__IZZA_POLICE_CHASE_TIMER_BOUND) return;
    window.__IZZA_POLICE_CHASE_TIMER_BOUND = true;

    const LB_GAME_KEY = 'city_chase';        // <- leaderboard "game" id
    const SHOW_RESULT_MS = 4500;             // how long to show the big result banner
    const MIN_RECORD_MS = 1500;              // ignore micro “blips” shorter than this
    const ROUND_MODE = 'seconds';            // 'seconds' or 'ms' (score units you want)

    // ---- HUD elements (created on demand) -----------------------------------
    let timerEl = null, bannerEl = null, rafId = 0;

    function mkTimerHud(){
  if (timerEl) return timerEl;
  const el = document.createElement('div');
  el.id = 'izzaChaseTimer';
  Object.assign(el.style, {
    position:'fixed',
    left:'50%',
    transform:'translateX(-50%)',
    // sit just above the chat input
    bottom:'calc(var(--chat-input-height, 64px) + 12px + env(safe-area-inset-bottom))',
    zIndex:10050,
    padding:'4px 10px',
    borderRadius:'10px',
    background:'rgba(0,0,0,.55)',
    border:'1px solid rgba(255,255,255,.35)',
    color:'#fff',
    font:'600 13px/1.2 system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial',
    letterSpacing:'0.3px',
    textShadow:'0 1px 2px rgba(0,0,0,.6)',
    display:'none',
    pointerEvents:'none' // don’t block taps
  });
  el.textContent = 'POLICE CHASE — 0.0s';
  document.body.appendChild(el);
  timerEl = el;
  return el;
}

function mkResultBanner(){
  if (bannerEl) return bannerEl;
  const el = document.createElement('div');
  el.id = 'izzaChaseResult';
  Object.assign(el.style, {
    position:'fixed',
    left:'50%',
    transform:'translateX(-50%)',
    // also sit just above the chat input
    bottom:'calc(var(--chat-input-height, 64px) + 12px + env(safe-area-inset-bottom))',
    zIndex:10060,
    padding:'10px 12px',              // ~half the old padding
    borderRadius:'12px',
    background:'linear-gradient(135deg, #07f 0%, #6f0 50%, #ff0 100%)',
    boxShadow:'0 10px 28px rgba(0,0,0,.40)',
    color:'#0a0a0a',
    font:'800 13px/1.2 system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial',
    letterSpacing:'0.4px',
    textAlign:'center',
    display:'none',
    border:'2px solid rgba(255,255,255,.85)',
    pointerEvents:'none',
    maxWidth:'min(86vw, 520px)'
  });
  el.innerHTML = `
    <div style="font-size:11px; font-weight:800; opacity:.85; margin-bottom:4px; text-transform:uppercase;">
      IZZA CITY
    </div>
    <div style="font-size:13px; font-weight:900; text-transform:uppercase;">
      Police Chase <span style="white-space:nowrap;">TIME</span>:
    </div>
    <div id="izzaChaseResultTime" style="font-size:16px; font-weight:1000; margin-top:4px;">
      0.0s
    </div>
  `;
  document.body.appendChild(el);
  bannerEl = el;
  return el;
}

    // ---- Timer state ---------------------------------------------------------
    let chasing = false;
    let startAt = 0;

    function fmt(ms){
      if (ROUND_MODE === 'ms') return `${ms|0} ms`;
      return `${(ms/1000).toFixed(1)}s`;
    }
    function scoreFromMs(ms){
      return ROUND_MODE === 'ms' ? (ms|0) : Math.round(ms/1000);
    }

    function startChase(){
      if (chasing) return;
      chasing = true;
      startAt = performance.now();

      const hud = mkTimerHud();
      hud.style.display = 'block';
      tickHud();
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(tickHud);
    }

    function tickHud(){
      if (!chasing) return;
      const now = performance.now();
      const ms = now - startAt;
      if (timerEl){
        timerEl.textContent = `POLICE CHASE — ${fmt(ms)}`;
      }
      rafId = requestAnimationFrame(tickHud);
    }

    // ---- Leaderboard submit helper (carries t & u, falls back to direct POST) ----
    async function submitLeaderboard({game, score, ts, reason}){
      // 1) Preferred: app-provided submitter (if present)
      try{
        if (window.IZZA_LEADERBOARD && typeof IZZA_LEADERBOARD.submit === 'function'){
          await IZZA_LEADERBOARD.submit({ game, score, reason, ts });
          return;
        }
      }catch(_){/* fall through to direct */ }

      // 2) Direct POST to persist service
      try{
        const base = (window.IZZA_PERSIST_BASE || 'https://izzagame.onrender.com');
        const url  = new URL('/izza-game/api/leaderboard/submit', base);

        const T = (localStorage.getItem('izzaTokenT') || '').trim();
        const U = ((localStorage.getItem('izzaUserU') || '')).toLowerCase().replace(/^@+/, '');
        if (T) url.searchParams.set('t', T);
        if (U) url.searchParams.set('u', U);

        const headers = { 'content-type':'application/json' };
        try{
          const bearer = localStorage.getItem('izzaBearer') || '';
          if (bearer) headers['authorization'] = 'Bearer ' + bearer;
        }catch(_){}

        const body = { game, score: (score|0), user: U || undefined, ts: (ts|0) };
        await fetch(url.toString(), {
          method:'POST',
          credentials:'include',
          headers,
          body: JSON.stringify(body)
        });
      }catch(e){
        console.warn('[chase] direct leaderboard POST failed', e);
      }
    }

    async function endChase(reason){
      if (!chasing) return;
      chasing = false;
      cancelAnimationFrame(rafId);
      rafId = 0;

      const elapsed = Math.max(0, performance.now() - startAt);
      if (timerEl) timerEl.style.display = 'none';
      if (elapsed < MIN_RECORD_MS) return;

      const banner = mkResultBanner();
      const timeEl = banner.querySelector('#izzaChaseResultTime');
      if (timeEl) timeEl.textContent = fmt(elapsed);
      banner.style.display = 'block';
      setTimeout(()=>{ banner.style.display = 'none'; }, SHOW_RESULT_MS);

      // Submit score with token/user and second-based timestamp
      try{
        await submitLeaderboard({
          game: LB_GAME_KEY,
          score: scoreFromMs(elapsed),
          reason,
          ts: Math.floor(Date.now()/1000) // seconds
        });
      }catch(e){
        console.warn('[chase] leaderboard submit failed', e);
      }

      try{ (window.IZZA?.toast||window.IZZA_PERSIST?.toast||(()=>{}))(`Chase saved: ${fmt(elapsed)}`); }catch(_){}
    }

    // ---- Wiring to existing events -------------------------------------
    IZZA.on('wanted-changed', ({from, to})=>{
      const f = Number(from|0), t = Number(to|0);
      if (!chasing && f===0 && t>0) startChase();
      if (chasing && t===0) endChase('cleared');
    });

    ['player-death','player-died','respawn','player-respawn'].forEach(ev=>{
      IZZA.on(ev, ()=>{ if (chasing) endChase('death'); });
    });

    IZZA.on('ready', (api)=>{
      const w = Number(api?.player?.wanted|0);
      if (w>0) startChase();
    });
  })();

})(); // <— closes the outer chasing plugin IIFE
