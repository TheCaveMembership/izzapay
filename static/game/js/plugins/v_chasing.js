// /static/game/js/plugins/v_chasing.js
(function(){
  const BUILD = 'v1.0-chasing-plugin';
  console.log('[IZZA CHASING]', BUILD);

  // Signal to core/other plugins to disable any internal chasing logic.
  window.__IZZA_CHASING_PLUGIN_ACTIVE = true;

  // Tunables
  const MAX_STARS = 5;
  const REINFORCE_MS = { 3: 20000, 4: 10000, 5: 10000 };
  const ZERO_LOCK_MS = 1500;       // suppress phantom 1★ rebound after clear
  const SPAWN_GRACE_MS = 250;      // grace to let maintainCops() spawn before we clear stars

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

  function updateCops(dtSec){
    const stars = api.player.wanted|0;

    // If there are no chasers but stars > 0, allow a short grace for spawns before clearing.
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

    // Chase
    for(const c of api.cops){
      const dx = api.player.x - c.x, dy = api.player.y - c.y;
      const m = Math.hypot(dx,dy) || 1;
      c.x += (dx/m) * c.spd * dtSec;
      c.y += (dy/m) * c.spd * dtSec;
      if(Math.abs(dy) >= Math.abs(dx)) c.facing = dy < 0 ? 'up' : 'down';
      else                              c.facing = dx < 0 ? 'left' : 'right';
    }

    // Reinforce toward +1 star every interval at 3★+
    const now = performance.now();
    if (reinforceAt && now >= reinforceAt){
      const cur = api.player.wanted|0;
      if (cur >= 3){
        const next = Math.min(MAX_STARS, cur + 1);
        if (next > cur) safeSetWanted(next);
        reinforceAt = performance.now() + (REINFORCE_MS[next] || 20000);
      } else {
        // If we’re <3★, kill any stale timer
        reinforceAt = 0;
      }
    }
  }

  // --- Event wiring ---
  IZZA.on('ready', (a)=>{
    api = a;
    // expose unlocked rect if not provided (compat)
    if(!api.unlocked){
      api.unlocked = api.unlocked || { x0:18, y0:18, x1:72, y1:42 };
    }
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
    // Remove reference if still present (defensive)
    const i = api.cops.indexOf(cop);
    if(i>=0) api.cops.splice(i,1);

    if(api.cops.length===0){
      // Clear completely when last chaser drops.
      safeSetWanted(0);
      zeroLockUntil = performance.now() + ZERO_LOCK_MS;
    }else{
      // Drop 1 star per cop kill (never below number of remaining chasers)
      const next = Math.max(api.cops.length, (api.player.wanted|0) - 1);
      safeSetWanted(next);
    }
  });

  // Optional: respond to crimes emitted by other modules (vehicle hijack, vehicular hits, etc.)
  IZZA.on('crime', (evt)=>{
    if(!api || !evt || !evt.kind) return;

    switch(evt.kind){
      case 'hijack': {
        // Immediate 2★ on hijack; cap chasers to 2
        safeSetWanted(2);
        maintainCops();
        break;
      }
      case 'vehicular-ped': {
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
    // Start or stop reinforcement timer
    if((to|0)>=3) reinforceAt = performance.now() + (REINFORCE_MS[to|0] || 20000);
    else reinforceAt = 0;
  });

  // Reset internal timers/state on death/respawn (defensive vs stale timers)
  ;['player-death','player-died','player-respawn','respawn'].forEach(ev=>{
    IZZA.on(ev, ()=>{
      reinforceAt = 0;
      zeroLockUntil = 0;
      lastWantedChangeAt = performance.now();
    });
  });
})();
