/* izza_land_wallguard_aim.plugin.js
   Full-mode (rotated) wall/corner anti-stick + aim-from-move-intent
   - Runs ONLY when <body data-fakeland="1">.
   - Stronger side-wall handling + soft repulsion margin to avoid edge pinning.
   - Uses stick intent to aim while moving; stationary aim passes through unchanged.
*/
(function(){
  if (!window.IZZA || typeof IZZA.on !== 'function') return;

  // ---------------- TUNABLES (safe to tweak) ----------------
  // Detect "stuck" and axis-block (screen space, because the canvas is rotated -90°):
  const WALL_EPS         = 0.22; // screen-delta below this → stuck
  const AXIS_EPS         = 0.24; // ↑ was 0.18 → treat “axis nearly zero” more aggressively

  // Slip strengths (slide along the unblocked axis):
  const SLIP_NUDGE       = 0.48; // ↑ was 0.42
  const SIDE_BONUS       = 2.30; // ↑ was 1.9 (extra for *side* walls where screen-x is blocked)

  // Small push straight off the wall (limits drift risk):
  const PUSH_NORMAL      = 0.05; // ↓ was 0.06; a hair softer

  // Stuck escalation & caps:
  const ESCALATE_0       = 1.0;
  const ESCALATE_ADD     = 0.45;
  const ESCALATE_CAP     = 1.9;

  // Episode safety caps (bound total correction so we don’t slide through solids):
  const INTENT_EPS       = 0.15;  // require this much stick intent to correct
  const MAX_STUCK_FRAMES = 12;    // ↑ allow a bit more time to find a slide
  const PUSH_FRAMES_MAX  = 2;     // only push for first N stuck frames
  const MAX_SLIP_PER_LOCK= 1.15;  // total slip cap per stuck episode (screen units)

  // Soft “invisible margin” (repulsion) when you keep pressing into the face:
  // This behaves like a half-tile buffer without editing map data.
  const REPULSE_AFTER_FRAMES = 3;   // start repelling after this many stuck frames in a row
  const REPULSE_STRENGTH     = 0.18; // per-frame repulsion along the wall normal (screen units)
  const REPULSE_DECAY        = 0.92; // repulsion decays each frame once you stop being stuck

  // ---------------- Helpers ----------------
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

  // soft repulsion accumulator (screen space)
  let repulseFx = 0, repulseFy = 0;

  function resetEpisode(){
    epSlipFx = 0; epSlipFy = 0;
    epPushFramesLeft = PUSH_FRAMES_MAX;
    stuckFrames = 0;
    // let repulsion decay naturally; don't hard reset so it eases out
  }

  function rememberIntentFromScreen(fx, fy){
    const m = Math.hypot(fx, fy);
    if (m > INTENT_EPS){
      intentX = fx / m;
      intentY = fy / m;
    }
  }

  // ---------------- Anti-stick + intent tracking (per frame) ----------------
  function onFrame(){
    if (!document.body.hasAttribute('data-fakeland')) {
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

    // Current stick intent magnitude (screen space)
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

      // decay repulsion gently so you don’t ping-pong
      repulseFx *= REPULSE_DECAY;
      repulseFy *= REPULSE_DECAY;
      return;
    }

    // ===== Stuck handling (Full mode) =====
    // Hard guards to prevent drift through geometry:
    if (intentMag <= INTENT_EPS){
      // No active intent → do nothing special
      prevX = p.x; prevY = p.y;
      resetEpisode();
      repulseFx *= REPULSE_DECAY;
      repulseFy *= REPULSE_DECAY;
      return;
    }

    if (stuckFrames >= MAX_STUCK_FRAMES){
      prevX = p.x; prevY = p.y;
      repulseFx *= REPULSE_DECAY;
      repulseFy *= REPULSE_DECAY;
      return;
    }

    const usedSlip = Math.hypot(epSlipFx, epSlipFy);
    if (usedSlip >= MAX_SLIP_PER_LOCK){
      prevX = p.x; prevY = p.y;
      repulseFx *= REPULSE_DECAY;
      repulseFy *= REPULSE_DECAY;
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
        // horizontal normal (screen x)
        nfx = (intentX >= 0 ? 1 : -1) * PUSH_NORMAL;
      } else if (yNearZero && !xNearZero){
        // vertical normal (screen y)
        nfy = (intentY >= 0 ? 1 : -1) * PUSH_NORMAL;
      } else {
        // corner → small diagonals
        nfx = (intentX >= 0 ? 1 : -1) * PUSH_NORMAL * 0.7;
        nfy = (intentY >= 0 ? 1 : -1) * PUSH_NORMAL * 0.7;
      }
      epPushFramesLeft--;
    }

    // Soft repulsion “margin” if you keep pressing into the face:
    // Adds a constant small push *away from the wall* once you’ve been stuck for a few frames.
    if (stuckFrames >= REPULSE_AFTER_FRAMES){
      if (xNearZero && !yNearZero){
        // screen-x is blocked → push in ±x away from the face
        repulseFx += (intentX >= 0 ? -REPULSE_STRENGTH : REPULSE_STRENGTH);
      } else if (yNearZero && !xNearZero){
        // screen-y is blocked → push in ±y away from the face
        repulseFy += (intentY >= 0 ? -REPULSE_STRENGTH : REPULSE_STRENGTH);
      } else {
        // corner → small diagonal repulse opposite of intent
        repulseFx += (intentX >= 0 ? -REPULSE_STRENGTH*0.7 : REPULSE_STRENGTH*0.7);
        repulseFy += (intentY >= 0 ? -REPULSE_STRENGTH*0.7 : REPULSE_STRENGTH*0.7);
      }
    } else {
      // ramp-in: slight pre-repulse helps separate before full repulse starts
      repulseFx *= REPULSE_DECAY;
      repulseFy *= REPULSE_DECAY;
    }

    // Sum in screen space
    let totalFx = sfx + nfx + repulseFx;
    let totalFy = sfy + nfy + repulseFy;

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

    // Accumulate episode slip and refresh intent from what we just attempted
    epSlipFx += totalFx;
    epSlipFy += totalFy;
    rememberIntentFromScreen(totalFx, totalFy);

    prevX = p.x; prevY = p.y;
  }

  IZZA.on('update-post', onFrame);

  // ---------------- Aim override (Full mode only) ----------------
  let _origAimOwner = null, _origAimKey = null, _origAimFn = null, _aimTimer = null;

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
    if (_origAimFn) return true;
    const found = findAimVector();
    if (!found) return false;

    _origAimOwner = found.parent;
    _origAimKey   = found.key;
    _origAimFn    = found.fn;

    const override = function(...args){
      const v = _origAimFn.apply(this, args);

      // Only change behavior in Full (rotated) mode
      if (!document.body.hasAttribute('data-fakeland')){
        return v;
      }

      // If we have meaningful stick/movement intent, drive aim from that (screen→world)
      const im = Math.hypot(intentX, intentY);
      if (im > INTENT_EPS){
        const { dx, dy } = screenToWorld(intentX, intentY);
        const m = Math.hypot(dx, dy) || 1;
        return { x: dx / m, y: dy / m };
      }

      // Stationary: upstream aim is already correct — pass it through unchanged
      return v;
    };

    try { _origAimOwner[_origAimKey] = override; } catch {}
    return true;
  }

  function ensureAimSoon(){
    if (installAimOverride()) return;
    if (_aimTimer) return;
    _aimTimer = setInterval(()=>{
      if (installAimOverride()){
        clearInterval(_aimTimer);
        _aimTimer = null;
      }
    }, 200);
  }

  ensureAimSoon();

  console.log('[land-wallguard-aim] Full-mode anti-stick + soft repulsion + intent-aim ready');
})();
