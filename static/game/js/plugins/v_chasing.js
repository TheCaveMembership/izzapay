// /static/game/js/plugins/v_chasing.js
(function(){
  // Prevent double-binding if this plugin hot-reloads
  if (window.__IZZA_CHASING_BOUND) return;
  window.__IZZA_CHASING_BOUND = true;

  const BUILD = 'v1.3-chasing-plugin+cling+5s-ramp+no-upgrade';
  console.log('[IZZA CHASING]', BUILD);

  // Signal to core/other plugins to disable any internal chasing logic.
  window.__IZZA_CHASING_PLUGIN_ACTIVE = true;

  // Tunables
  const MAX_STARS       = 5;
  const REINFORCE_MS    = { 3: 20000, 4: 10000, 5: 10000 }; // kept for legacy drip at 3★+
  const ZERO_LOCK_MS    = 1500;   // suppress phantom 1★ rebound after clear
  const SPAWN_GRACE_MS  = 300;    // allow maintainCops() a tick to spawn before clearing
  const CLING_RADIUS    = 16;     // px distance to latch/attack when player is stationary in car
  const CLING_HIT_CD_MS = 700;    // how often a clinging cop deals damage
  const MOVE_EPS        = 1.0;    // px per frame that counts as "player started moving"

  // Chaser speed tuning (px/sec-ish; multiplied by dtSec)
  // (For testing you asked SWAT & Army to be as fast as police)
  const TUNE = {
    policeSpd: 55,
    swatSpd:   55,
    armySpd:   55
  };

  let api = null;
  let reinforceAt = 0;
  let zeroLockUntil = 0;
  let lastWantedChangeAt = 0;

  // Track “in a hijacked car” + stationary detection for cling logic
  let inHijackedCar = false;
  let lastPX = NaN, lastPY = NaN;

  // ---- “hijack session” 5s-escalation timeline ----
  // t=0s:  1★ + spawn police
  // t=5s:  2★ + spawn police
  // t=10s: 3★ + spawn police
  // t=15s: 4★ + spawn SWAT
  // t=20s: 5★ + spawn Army   (tanks handled elsewhere after 30s at 5★)
  const HIJACK_STEPS = [
    { at:   0, stars: 1, kind: 'police' },
    { at:5000, stars: 2, kind: 'police' },
    { at:10000, stars: 3, kind: 'police' },
    { at:15000, stars: 4, kind: 'swat'   },
    { at:20000, stars: 5, kind: 'army'   },
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

  function copSpeed(kind){
    return (kind==='army') ? TUNE.armySpd
         : (kind==='swat') ? TUNE.swatSpd
         :                   TUNE.policeSpd;
  }
  function copHP(kind){ return kind==='army'?6 : kind==='swat'?5 : 4; }

  // For *new* spawns only (we do NOT upgrade existing units)
  function kindForStars(stars){
    if(stars>=5) return 'army';
    if(stars>=4) return 'swat';
    return 'police';
  }

  function spawnCop(kind){
    ensureArrays();
    // spawn at map edge corners
    const left = Math.random()<0.5;
    const top  = Math.random()<0.5;
    const gx   = left ? api.unlocked.x0 : api.unlocked.x1;
    const gy   = top  ? api.unlocked.y0 : api.unlocked.y1;
    const TILE = api.TILE;
    api.cops.push({
      x: gx*TILE, y: gy*TILE,
      spd: copSpeed(kind), hp: copHP(kind), kind,
      facing:'down',
      state:'chase',
      clingCd: 0
    });
  }

  // Keep total count == stars, but do NOT mutate kinds of existing cops
  function maintainCops(){
    ensureArrays();
    const target = api.player.wanted|0;
    if (target<=0){
      api.cops.length = 0;
      return;
    }
    while(api.cops.length > target) api.cops.pop();
    while(api.cops.length < target) spawnCop(kindForStars(target));
    // speeds/HP remain what they were at spawn; no “evolving” on canvas
  }

  function safeSetWanted(n){
    const prev = api.player.wanted|0;
    const now  = performance.now();
    if(prev===0 && n===1 && now < zeroLockUntil) return; // swallow phantom 1★
    const clamped = Math.max(0, Math.min(MAX_STARS, n|0));
    if (clamped !== prev){
      api.setWanted(clamped);
      lastWantedChangeAt = now;
      if (clamped>=3) reinforceAt = now + (REINFORCE_MS[clamped] || 20000);
      else            reinforceAt = 0;
      maintainCops();
    }
  }

  // 5s hijack escalation
  function tickHijackTimeline(){
    if (!hijackStartAt) return;
    const now = performance.now();

    // If ALL cops got wiped while still having stars, pause timeline until a cop exists
    ensureArrays();
    if (api.cops.length === 0 && (api.player.wanted|0) > 0) return;

    while (hijackStepIdx < HIJACK_STEPS.length && now - hijackStartAt >= HIJACK_STEPS[hijackStepIdx].at){
      const step = HIJACK_STEPS[hijackStepIdx];
      const cur = api.player.wanted|0;
      if (step.stars > cur) safeSetWanted(step.stars);
      spawnCop(step.kind);      // always a *new* unit, never upgrade
      maintainCops();           // keeps total == stars
      hijackStepIdx++;
    }
  }

  function killCop(cop){
    const i = api.cops.indexOf(cop);
    if(i>=0) api.cops.splice(i,1);
    // Let the rest of the game react (loot, etc.)
    IZZA.emit('cop-killed', {cop});
    // Star drop handled by our 'cop-killed' listener below
  }

  function updateCops(dtSec){
    ensureArrays();
    const stars = api.player.wanted|0;
    const px = api.player.x, py = api.player.y;

    // If there are no chasers but stars > 0, allow a short grace for spawns before clearing.
    if(!api.cops.length){
      if(stars!==0){
        const now = performance.now();
        if (now - lastWantedChangeAt <= SPAWN_GRACE_MS){
          maintainCops(); // try to spawn immediately
          return;
        }
        safeSetWanted(0);
        zeroLockUntil = now + ZERO_LOCK_MS;
      }
      // reset stationary tracker since we have no chasers
      lastPX = px; lastPY = py;
      return;
    }

    // Compute if player moved this frame (used by cling logic)
    const movedDist = (isNaN(lastPX)||isNaN(lastPY)) ? 0 : Math.hypot(px-lastPX, py-lastPY);
    lastPX = px; lastPY = py;
    const playerIsMoving = movedDist > MOVE_EPS;

    // Chase movement + cling / run-over behavior
    for(let i=api.cops.length-1; i>=0; i--){
      const c = api.cops[i];

      // Move toward player
      const dx = px - c.x, dy = py - c.y;
      const m  = Math.hypot(dx,dy) || 1;
      c.x += (dx/m) * c.spd * dtSec;
      c.y += (dy/m) * c.spd * dtSec;
      if(Math.abs(dy) >= Math.abs(dx)) c.facing = dy < 0 ? 'up' : 'down';
      else                              c.facing = dx < 0 ? 'left' : 'right';

      // Cling/attack if in hijacked car AND player is basically stationary
      const touching = Math.hypot(px - c.x, py - c.y) <= CLING_RADIUS;
      if (inHijackedCar && touching){
        if (!playerIsMoving){
          c.state = 'cling';
          // Attack on cooldown while clinging
          c.clingCd -= dtSec*1000;
          if (c.clingCd <= 0){
            c.clingCd = CLING_HIT_CD_MS;
            IZZA.emit('player-hit', {by:'cop-cling', dmg:1});
          }
        }else{
          // Player started moving while cop is on the car => the cop dies (run over)
          killCop(c);
          continue; // array shrank, skip to next index
        }
      }else if (c.state === 'cling'){
        c.state = 'chase';
      }
    }

    // Run the 5s hijack escalation
    tickHijackTimeline();

    // Legacy 3★+ reinforcement drip (usually overshadowed by 5s ramp)
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
      api.unlocked = { x0:18, y0:18, x1:72, y1:42 };
    }
    ensureArrays();
    api.cops.length = 0; // authoritative
    maintainCops();
    console.log('[CHASING] ready; stars=', api.player.wanted);
  });

  IZZA.on('update-post', ({dtSec})=>{
    if(!api) return;
    updateCops(dtSec||0.016);
  });

  // Normalize cop kills from anywhere
  IZZA.on('cop-killed', ({cop})=>{
    if(!api) return;
    ensureArrays();
    const i = api.cops.indexOf(cop);
    if(i>=0) api.cops.splice(i,1);

    if(api.cops.length===0){
      safeSetWanted(0);
      zeroLockUntil = performance.now() + ZERO_LOCK_MS;
      resetHijackTimeline();
    }else{
      const next = Math.max(api.cops.length, (api.player.wanted|0) - 1);
      safeSetWanted(next);
    }
  });

  // Crimes (hijack/vehicular/etc.)
  IZZA.on('crime', (evt)=>{
    if(!api || !evt || !evt.kind) return;

    switch(evt.kind){
      case 'hijack': {
        inHijackedCar = true;

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
        // light escalation from hits while driving
        safeSetWanted((api.player.wanted|0) + 1);
        break;
      }
      case 'vehicular-cop-kill': {
        // Not emitting this ourselves to avoid double star-drop;
        // kept here if something else emits it
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

  // If someone else changes stars (e.g., on-foot combat code),
  // we only handle the chaser count to match.
  IZZA.on('wanted-changed', ({to})=>{
    if(!api) return;
    maintainCops();
    lastWantedChangeAt = performance.now();
    if((to|0)>=3) reinforceAt = performance.now() + (REINFORCE_MS[to|0] || 20000);
    else          reinforceAt = 0;
    if ((to|0) === 0) inHijackedCar = false; // cool-down implies out of hot-car flow
  });

  // Reset on death/respawn (fresh session next hijack)
  ;['player-death','player-died','player-respawn','respawn'].forEach(ev=>{
    IZZA.on(ev, ()=>{
      reinforceAt = 0;
      zeroLockUntil = 0;
      lastWantedChangeAt = performance.now();
      resetHijackTimeline();
      inHijackedCar = false;
      ensureArrays();
      if (api) {
        if (api.cops) api.cops.length = 0; // do NOT replace arrays
        if (api.player) api.setWanted(0);
      }
    });
  });
})();
