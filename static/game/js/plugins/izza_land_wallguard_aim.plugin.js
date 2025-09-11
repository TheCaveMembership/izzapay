/* izza_land_wallguard_aim.plugin.js
   Full-mode (rotated) wall/corner anti-stick + aim-from-move-intent
   - ACTIVATES only when <body data-fakeland="1"> is present
   - Cleanly deactivates (and restores aim) when leaving Full
*/
(function(){
  if (!window.IZZA || typeof IZZA.on !== 'function') return;

  // ---------------- TUNABLES (safe to tweak) ----------------
  // Detect "stuck" and axis-block:
  const WALL_EPS         = 0.22; // screen-delta below this → stuck
  const AXIS_EPS         = 0.18; // larger = more likely to treat an axis as blocked

  // Slip strengths:
  const SLIP_NUDGE       = 0.42; // base slide along the open axis
  const SIDE_BONUS       = 1.9;  // extra help specifically for *side* walls (x blocked in screen space)

  // Small push straight off the wall (limits drift risk):
  const PUSH_NORMAL      = 0.06; // smaller push to avoid creep

  // Stuck escalation & caps:
  const ESCALATE_0       = 1.0;
  const ESCALATE_ADD     = 0.5;
  const ESCALATE_CAP     = 2.0;

  // Episode safety caps (bound total correction so we don’t slide through):
  const INTENT_EPS       = 0.15; // require this much stick intent to correct
  const MAX_STUCK_FRAMES = 10;   // only try to resolve for up to N frames
  const PUSH_FRAMES_MAX  = 2;    // only push for first N stuck frames
  const MAX_SLIP_PER_LOCK= 1.20; // max total slip (screen units) per stuck episode

  // ---------------- Helpers ----------------
  const isFull = ()=> document.body && document.body.hasAttribute('data-fakeland');

  // world → screen mapping for -90° CW canvas:
  function worldToScreen(dx, dy){ return { fx:  dy, fy: -dx }; }
  // screen → world inverse:
  function screenToWorld(fx, fy){ return { dx: -fy, dy:  fx }; }

  // ---------------- State ----------------
  let prevX = null, prevY = null;
  let intentX = 0, intentY = 0; // screen-space unit vector of last movement intent
  let stuckFrames = 0;

  // episode-local accumulators (screen space)
  let epSlipFx = 0, epSlipFy = 0;
  let epPushFramesLeft = 0;

  // aim override handles
  let _origAimOwner = null, _origAimKey = null, _origAimFn = null, _aimTimer = null;
  let _aimInstalled = false;

  function resetEpisode(){
    epSlipFx = 0; epSlipFy = 0;
    epPushFramesLeft = PUSH_FRAMES_MAX;
    stuckFrames = 0;
  }

  function rememberIntentFromScreen(fx, fy){
    const m = Math.hypot(fx, fy);
    if (m > INTENT_EPS){
      intentX = fx / m;
      intentY = fy / m;
    }
  }

  // ---------------- Per-frame handler (NO-OP in Normal) ----------------
  function onFrame(){
    if (!isFull()){
      // Absolute no-op in Normal: do not touch player, aim, or intent; clear seeds.
      prevX = prevY = null;
      resetEpisode();
      return;
    }
    if (!IZZA.api || !IZZA.api.player) return;
    const p = IZZA.api.player;

    // Seed
    if (prevX == null || prevY == null){
      prevX = p.x; prevY = p.y;
      resetEpisode();
      return;
    }

    // Engine world delta this frame
    const dx = p.x - prevX;
    const dy = p.y - prevY;

    // Convert to screen-space to match player’s perspective
    const { fx, fy } = worldToScreen(dx, dy);
    const amag = Math.abs(fx) + Math.abs(fy);

    // Current stick intent magnitude (screen space) from last known intent
    const intentMag = Math.hypot(intentX, intentY);

    const xNearZero = Math.abs(fx) < AXIS_EPS;
    const yNearZero = Math.abs(fy) < AXIS_EPS;
    const singleAxis = xNearZero ^ yNearZero;
    const stuck = (amag < WALL_EPS) || singleAxis;

    if (!stuck){
      // Normal motion → track fresh intent and clear episode
      rememberIntentFromScreen(fx, fy);
      prevX = p.x; prevY = p.y;
      resetEpisode();
      return;
    }

    // ===== Stuck handling (Full mode only) =====
    // Only correct if player is actively trying to move
    if (intentMag <= INTENT_EPS){
      prevX = p.x; prevY = p.y;
      resetEpisode();
      return;
    }

    // Stop after too many consecutive stuck frames in one episode
    if (stuckFrames >= MAX_STUCK_FRAMES){
      prevX = p.x; prevY = p.y;
      return;
    }

    // Cap total slip distance per stuck episode (screen space)
    const usedSlip = Math.hypot(epSlipFx, epSlipFy);
    if (usedSlip >= MAX_SLIP_PER_LOCK){
      prevX = p.x; prevY = p.y;
      return;
    }

    // Progress episode
    if (stuckFrames === 0){
      epSlipFx = 0; epSlipFy = 0;
      epPushFramesLeft = PUSH_FRAMES_MAX;
    }
    stuckFrames++;
    const mul = Math.min(ESCALATE_0 + ESCALATE_ADD * (stuckFrames - 1), ESCALATE_CAP);

    // Base slip along face/corner (screen space)
    let sfx = 0, sfy = 0;
    if (xNearZero && !yNearZero){
      // side wall → slide vertically, boosted
      sfy = (intentY >= 0 ? 1 : -1) * SLIP_NUDGE * SIDE_BONUS * mul;
    } else if (yNearZero && !xNearZero){
      // front/back face → slide horizontally
      sfx = (intentX >= 0 ? 1 : -1) * SLIP_NUDGE * mul;
    } else {
      // corner → follow last intent lightly
      sfx = intentX * SLIP_NUDGE * mul;
      sfy = intentY * SLIP_NUDGE * mul;
    }

    // Tiny push normal to wall, only for first few stuck frames
    let nfx = 0, nfy = 0;
    if (epPushFramesLeft > 0){
      if (xNearZero && !yNearZero){
        nfx = (intentX >= 0 ? 1 : -1) * PUSH_NORMAL;        // horizontal normal (screen x)
      } else if (yNearZero && !xNearZero){
        nfy = (intentY >= 0 ? 1 : -1) * PUSH_NORMAL;        // vertical normal (screen y)
      } else {
        nfx = (intentX >= 0 ? 1 : -1) * PUSH_NORMAL * 0.7;  // corner → small diagonals
        nfy = (intentY >= 0 ? 1 : -1) * PUSH_NORMAL * 0.7;
      }
      epPushFramesLeft--;
    }

    // Sum in screen space
    let totalFx = sfx + nfx;
    let totalFy = sfy + nfy;

    // Clamp this frame’s slip so episode total won’t exceed MAX_SLIP_PER_LOCK
    const remaining = Math.max(0, MAX_SLIP_PER_LOCK - Math.hypot(epSlipFx, epSlipFy));
    const stepMag = Math.hypot(totalFx, totalFy) || 1;
    if (stepMag > remaining){
      totalFx *= (remaining / stepMag);
      totalFy *= (remaining / stepMag);
    }

    // Convert back to world space and apply
    const { dx: fixDx, dy: fixDy } = screenToWorld(totalFx, totalFy);
    p.x = prevX + fixDx;
    p.y = prevY + fixDy;

    // Accumulate and refresh intent from what we just attempted
    epSlipFx += totalFx;
    epSlipFy += totalFy;
    rememberIntentFromScreen(totalFx, totalFy);

    prevX = p.x; prevY = p.y;
  }

  // ---------------- Aim override (install ONLY in Full, uninstall in Normal) ----------------
  function findAimVector(){
    const paths = [
      ['IZZA','guns','aimVector'],
      ['guns','aimVector'],
      ['aimVector']
    ];
    for (const path of paths){
      let obj = window, parent = null, key = null;
      for (let i=0;i<path.length;i++){
        key = path[i];
        if (typeof obj[key] === 'undefined'){ obj = null; break; }
        parent = (i < path.length-1) ? obj[key] : obj;
        obj = obj[key];
      }
      if (typeof obj === 'function') return { parent, key, fn: obj };
    }
    return null;
  }

  function installAimOverride(){
    if (_aimInstalled) return true;
    const found = findAimVector();
    if (!found) return false;

    _origAimOwner = found.parent;
    _origAimKey   = found.key;
    _origAimFn    = found.fn;

    const override = function(...args){
      // Only change behavior in Full (rotated) mode
      if (!isFull()){
        return _origAimFn.apply(this, args);
      }

      // Use current/last movement intent while moving (screen→world)
      const im = Math.hypot(intentX, intentY);
      if (im > INTENT_EPS){
        const { dx, dy } = screenToWorld(intentX, intentY);
        const m = Math.hypot(dx, dy) || 1;
        return { x: dx / m, y: dy / m };
      }

      // Stationary: upstream aim is already correct — pass it through unchanged
      return _origAimFn.apply(this, args);
    };

    try { _origAimOwner[_origAimKey] = override; _aimInstalled = true; } catch {}
    return _aimInstalled;
  }

  function uninstallAimOverride(){
    if (_aimInstalled && _origAimOwner && _origAimKey && _origAimFn){
      try { _origAimOwner[_origAimKey] = _origAimFn; } catch {}
    }
    _aimInstalled = false;
    _origAimOwner = _origAimKey = _origAimFn = null;
  }

  // Try installing aim override (in case Full is already active at load)
  function ensureAimForMode(){
    if (isFull()){
      if (!_aimInstalled){
        // Retry until guns.js is ready
        if (!_aimTimer){
          _aimTimer = setInterval(()=>{
            if (installAimOverride()){
              clearInterval(_aimTimer); _aimTimer = null;
            }
          }, 200);
        }
      }
    } else {
      if (_aimTimer){ clearInterval(_aimTimer); _aimTimer = null; }
      uninstallAimOverride();
    }
  }

  // Initial hook: per-frame (safe even in Normal due to hard guard)
  IZZA.on('update-post', onFrame);

  // Watch body attribute changes to install/uninstall aim override exactly at mode switch
  const mo = new MutationObserver(ensureAimForMode);
  mo.observe(document.body, { attributes:true, attributeFilter:['data-fakeland'] });

  // Also run once at startup
  ensureAimForMode();

  console.log('[land-wallguard-aim] Activated; Normal mode fully no-op, Full mode guarded.');
})();
