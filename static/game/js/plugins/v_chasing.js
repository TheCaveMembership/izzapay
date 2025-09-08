// /static/game/js/plugins/v_chasing.js
(function(){
  // Prevent double-binding if this plugin hot-reloads
  if (window.__IZZA_CHASING_BOUND) return;
  window.__IZZA_CHASING_BOUND = true;

  const BUILD = 'v1.2-chasing-plugin+5s-escalation';
  console.log('[IZZA CHASING]', BUILD);

  // Signal to core/other plugins to disable any internal chasing logic.
  window.__IZZA_CHASING_PLUGIN_ACTIVE = true;

  // Tunables
  const MAX_STARS = 5;
  const REINFORCE_MS = { 3: 20000, 4: 10000, 5: 10000 }; // (still used for 3★+ passive drip if needed)
  const ZERO_LOCK_MS = 1500;       // suppress phantom 1★ rebound after clear
  const SPAWN_GRACE_MS = 300;      // grace to let maintainCops() spawn before we clear stars

  // Chaser speed tuning (px/sec-ish; multiplied by dtSec)
  const TUNE = {
    policeSpd: 55,
    swatSpd:   65,
    armySpd:   72
  };

  let api = null;
  let reinforceAt = 0;
  let zeroLockUntil = 0;
  let lastWantedChangeAt = 0;

  // ---- “hijack session” 5s-escalation state (test mode you asked for) ----
  // Timeline (relative to hijack start):
  //  t=0s:   1★ + spawn police
  //  t=5s:   2★ + spawn police
  //  t=10s:  3★ + spawn police
  //  t=15s:  4★ + spawn SWAT
  //  t=20s:  5★ + spawn Army   (tanks then handled by free-drive after 30s at 5★)
  const HIJACK_STEPS = [
    { at:  0,    stars: 1, kind: 'police' },
    { at:  5000, stars: 2, kind: 'police' },
    { at: 10000, stars: 3, kind: 'police' },
    { at: 15000, stars: 4, kind: 'swat'   },
    { at: 20000, stars: 5, kind: 'army'   },
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

    // Keep number of active cops equal to current stars
    const target = api.player.wanted|0;
    if (target<=0){
      api.cops.length = 0;
      return;
    }
    // normalize kinds for current tier
    const k = kindForStars(target);
    // trim or pad
    while(api.cops.length > target) api.cops.pop();
    while(api.cops.length < target) spawnCop(k);
    // upgrade all to current tier if needed
    for(const c of api.cops){ c.kind = k; c.spd = copSpeed(k); c.hp = Math.max(c.hp|0, copHP(k)); }
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

  // Drive 5s hijack timeline
  function tickHijackTimeline(){
    if (!hijackStartAt) return;
    const now = performance.now();

    // If player wiped all cops, pause the timeline until at least one exists
    // (so “if the player hasn’t killed the cops” the timeline continues).
    ensureArrays();
    if (api.cops.length === 0 && (api.player.wanted|0) > 0) return;

    while (hijackStepIdx < HIJACK_STEPS.length && now - hijackStartAt >= HIJACK_STEPS[hijackStepIdx].at){
      const step = HIJACK_STEPS[hijackStepIdx];

      // Only ever escalate upward (don’t reduce if other systems dropped stars)
      const cur = api.player.wanted|0;
      if (step.stars > cur){
        safeSetWanted(step.stars);
      }
      // Spawn one extra of the step's tier to make the ramp visible
      spawnCop(step.kind);
      // Maintain to match total == stars (keeps things tidy if extras existed)
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

    // Run the 5s hijack escalation
    tickHijackTimeline();

    // Legacy reinforcement toward +1 star every interval at 3★+ (kept, but your 5s path will usually reach 5★ first)
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
    // expose unlocked rect if not provided (compat)
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
        // Start 5s timeline fresh
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
        // Still allow small instant bumps for hits while driving
        safeSetWanted((api.player.wanted|0) + 1);
        break;
      }
      case 'vehicular-cop-kill': {
        // already handled by cop-killed hook for star downshifts,
        // but decrement pre-emptively to feel responsive.
        safeSetWanted(Math.max(0, (api.player.wanted|0) - 1));
        break;
      }
      case 'gunshot': {
        // light heat for discharging firearms (optional)
        const cur = api.player.wanted|0;
        safeSetWanted(Math.min(MAX_STARS, cur===0 ? 1 : cur));
        break;
      }
      default: break;
    }
  });

  // If someone else changes stars (e.g., on-foot combat code),
  // we only handle the chaser count to match.
  IZZA.on('wanted-changed', ({to})=>{
    if(!api) return;
    maintainCops();
    lastWantedChangeAt = performance.now();
    // Start or stop legacy reinforcement timer
    if((to|0)>=3) reinforceAt = performance.now() + (REINFORCE_MS[to|0] || 20000);
    else reinforceAt = 0;
  });

  // Reset internal timers/state on death/respawn (defensive vs stale timers)
  ;['player-death','player-died','player-respawn','respawn'].forEach(ev=>{
    IZZA.on(ev, ()=>{
      reinforceAt = 0;
      zeroLockUntil = 0;
      lastWantedChangeAt = performance.now();
      ensureArrays();
      resetHijackTimeline();
      // Also clear any remaining cops so the next hijack is a clean ramp
      if (api && api.cops) api.cops.length = 0;
      if (api && api.player) api.setWanted(0);
    });
  });
})();
