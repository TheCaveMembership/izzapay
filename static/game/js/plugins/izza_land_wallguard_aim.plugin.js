/* izza_land_wallguard_aim.plugin.js
   Full-mode (rotated) wall/corner anti-stick + aim-from-move-intent
   - Runs ONLY when <body data-fakeland="1">.
   - Listens to IZZA.on('update-post') to detect "stuck" and apply slip/push-off.
   - Overrides aim *only in Full mode* to use current/last movement intent (stick) while moving.
   - Falls back to original aim when not moving; never edits guns.js.
*/
(function(){
  if (!window.IZZA || typeof IZZA.on !== 'function') return;

  // ---------------- Tunables ----------------
  // Anti-stick
  const WALL_EPS     = 0.22;  // treat frame as "stuck" if movement (screen) smaller than this
  const AXIS_EPS     = 0.12;  // "axis nearly zero" threshold (screen space)
  const SLIP_NUDGE   = 0.35;  // slide strength along wall
  const SIDE_BONUS   = 1.4;   // extra slide on side walls (x-blocked in screen space)
  const PUSH_NORMAL  = 0.08;  // tiny push straight off wall to break pinning
  const ESCALATE_0   = 1.0;   // first stuck frame slip multiplier
  const ESCALATE_ADD = 0.5;   // add each consecutive stuck frame
  const ESCALATE_CAP = 2.0;   // cap the escalation

  // Aim override
  const INTENT_EPS   = 0.15;  // need at least this much intent magnitude to drive aim
  // NOTE: Stationary fallback aim is already correct upstream, so we will NOT rotate it here.

  // ---------------- Helpers ----------------
  // world → screen mapping for your -90° CW canvas:
  //   screen (fx, fy) = ( dy, -dx )
  function worldToScreen(dx, dy){ return { fx:  dy, fy: -dx }; }
  // screen → world inverse mapping:
  //   world (dx, dy) = ( -fy, fx )
  function screenToWorld(fx, fy){ return { dx: -fy, dy:  fx }; }

  // ---------------- State ----------------
  let prevX = null, prevY = null;
  let intentX = 0, intentY = 0; // *screen-space* unit vector pointing where the player is trying to go
  let stuckFrames = 0;

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
      // Not in Full mode: reset state and do nothing
      prevX = prevY = null;
      stuckFrames = 0;
      return;
    }
    if (!IZZA.api || !IZZA.api.player) return;
    const p = IZZA.api.player;

    // Seed
    if (prevX == null || prevY == null){
      prevX = p.x; prevY = p.y;
      return;
    }

    // The engine's world delta this frame
    const dx = p.x - prevX;
    const dy = p.y - prevY;

    // Convert to screen-space (matches what the player sees/feels)
    const { fx, fy } = worldToScreen(dx, dy);
    const amag = Math.abs(fx) + Math.abs(fy);

    const xNearZero = Math.abs(fx) < AXIS_EPS;
    const yNearZero = Math.abs(fy) < AXIS_EPS;
    const singleAxis = xNearZero ^ yNearZero;
    const stuck = (amag < WALL_EPS) || singleAxis;

    if (!stuck){
      // Track *current* intent from real motion
      rememberIntentFromScreen(fx, fy);
      stuckFrames = 0;
      prevX = p.x; prevY = p.y;
      return;
    }

    // ---- Stuck: compute slip + push-off in screen space ----
    stuckFrames++;
    const mul = Math.min(ESCALATE_0 + ESCALATE_ADD * (stuckFrames - 1), ESCALATE_CAP);

    let sfx = 0, sfy = 0;
    if (xNearZero && !yNearZero){
      // side wall: slide vertically with a bonus
      sfy = (intentY >= 0 ? 1 : -1) * SLIP_NUDGE * SIDE_BONUS * mul;
    }else if (yNearZero && !xNearZero){
      // front/back face: slide horizontally
      sfx = (intentX >= 0 ? 1 : -1) * SLIP_NUDGE * mul;
    }else{
      // corner pinch: follow last intent lightly
      sfx = intentX * SLIP_NUDGE * mul;
      sfy = intentY * SLIP_NUDGE * mul;
    }

    // tiny push straight off the wall (screen space)
    let nfx = 0, nfy = 0;
    if (xNearZero && !yNearZero){
      nfx = (intentX >= 0 ? 1 : -1) * PUSH_NORMAL;
    }else if (yNearZero && !xNearZero){
      nfy = (intentY >= 0 ? 1 : -1) * PUSH_NORMAL;
    }else{
      nfx = (intentX >= 0 ? 1 : -1) * PUSH_NORMAL * 0.7;
      nfy = (intentY >= 0 ? 1 : -1) * PUSH_NORMAL * 0.7;
    }

    const totalFx = sfx + nfx;
    const totalFy = sfy + nfy;
    const { dx: fixDx, dy: fixDy } = screenToWorld(totalFx, totalFy);

    p.x = prevX + fixDx;
    p.y = prevY + fixDy;

    // Refresh intent from what we just attempted
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
    if (_origAimFn) return true; // already installed
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

  console.log('[land-wallguard-aim] Full-mode anti-stick + aim-from-intent ready');
})();
