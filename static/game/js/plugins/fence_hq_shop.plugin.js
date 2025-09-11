/* fence_hq_shop.plugin.js — half-tile perimeter fence with soft steer + hard stop
   - Places fence along EAST side and SOUTH/back of HQ and Shop, 0.5 tile away
   - Light pre-contact steering so players slide off instead of “bonk”
   - No changes to other files; pure drop-in
*/
(function(){
  if (!window.IZZA || typeof IZZA.on !== 'function') return;

  // ---- Tunables (safe) ----
  const FENCE_COLOR   = '#2a3b4f';
  const POST_COLOR    = '#8fa4c3';
  const POST_SPACING  = 1;     // tiles between little posts (visual only)
  const STEER_DIST    = 10;    // px: start nudging away before “collision”
  const SOLID_DIST    = 4;     // px: cannot cross (acts like wall)
  const OFFSET_TILES  = 0.5;   // fence placed this far away from building bounds

  // Recreate the same anchor math your map uses, so we never go out of sync.
  const TIER_KEY='izzaMapTier';
  function unlockedRect(t){ return (t!=='2') ? {x0:18,y0:18,x1:72,y1:42} : {x0:10,y0:12,x1:80,y1:50}; }
  function anchors(api){
    const tier = localStorage.getItem(TIER_KEY)||'1';
    const un = unlockedRect(tier);
    const bW=10,bH=6;
    const bX = Math.floor((un.x0+un.x1)/2) - Math.floor(bW/2);
    const bY = un.y0 + 5;

    const hRoadY       = bY + bH + 1;
    const sidewalkTopY = hRoadY - 1;
    const vRoadX       = Math.min(un.x1-3, bX + bW + 6);

    const shop = { w:8, h:5, x:vRoadX+2, y: sidewalkTopY-5 };  // matches your layout math
    const HQ   = { x0:bX, y0:bY, x1:bX+bW-1, y1:bY+bH-1 };
    const SH   = { x0:shop.x, y0:shop.y, x1:shop.x+shop.w-1, y1:shop.y+shop.h-1 };

    return { HQ, SH, un, hRoadY, sidewalkTopY, vRoadX };
  }

  // Build fence line segments (in world pixels), half-tile outside the east & south edges.
  function buildFenceSegments(api){
    const A = anchors(api), t=api.TILE;
    const out = [];

    function addRectEastSouth(rect){
      const {x0,y0,x1,y1} = rect;
      const eastX  = (x1+1 + OFFSET_TILES) * t;                  // vertical line
      const southY = (y1+1 + OFFSET_TILES) * t;                  // horizontal line
      const yTop   = y0 * t, yBot = (y1+1) * t;
      const xLeft  = x0 * t, xRight = (x1+1) * t;

      // EAST side
      out.push({ kind:'v', x:eastX, y0:yTop, y1:yBot });

      // SOUTH/back
      out.push({ kind:'h', y:southY, x0:xLeft, x1:xRight });
    }

    addRectEastSouth(A.HQ);
    addRectEastSouth(A.SH);
    return out;
  }

  // --- Soft-steer + hard-stop against a single segment ---
  function resolveAgainstFence(p, seg){
    // p: {x,y} player position in world px (top-left). We'll use center for nicer feel.
    const px = p.x + 16, py = p.y + 16;

    if (seg.kind === 'v'){
      const dx = px - seg.x;                // >0 means player is to the right of fence
      const withinY = py >= seg.y0 && py <= seg.y1;
      if (!withinY) return;

      if (Math.abs(dx) < STEER_DIST){
        // nudge away
        const dir = dx < 0 ? -1 : 1;        // approaching from left → dir=-1, right → +1
        p.x += (STEER_DIST - Math.abs(dx)) * 0.06 * dir;
      }
      if (Math.abs(dx) < SOLID_DIST){
        // clamp to solid boundary
        if (dx < 0){ p.x = seg.x - 16 - SOLID_DIST; }    // left side
        else        { p.x = seg.x - 16 + SOLID_DIST; }   // right side (keeps us outside)
      }
    } else {
      // horizontal fence
      const dy = py - seg.y;
      const withinX = px >= seg.x0 && px <= seg.x1;
      if (!withinX) return;

      if (Math.abs(dy) < STEER_DIST){
        const dir = dy < 0 ? -1 : 1;        // approaching from above → dir=-1, below → +1
        p.y += (STEER_DIST - Math.abs(dy)) * 0.06 * dir;
      }
      if (Math.abs(dy) < SOLID_DIST){
        if (dy < 0){ p.y = seg.y - 16 - SOLID_DIST; }
        else        { p.y = seg.y - 16 + SOLID_DIST; }
      }
    }
  }

  // Cache per frame
  let _segs = null, _lastTileSize = 0;

  // Draw little posts so it “looks” fenced, under the player/roads (subtle)
  function drawFence(api){
    const c = document.getElementById('game'); if(!c) return;
    const ctx = c.getContext('2d');
    const S   = api.DRAW, scale = S/api.TILE;

    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = FENCE_COLOR;

    _segs.forEach(seg=>{
      if (seg.kind==='v'){
        // thin vertical strip
        const sx = (seg.x - api.camera.x) * scale;
        const sy = (seg.y0 - api.camera.y) * scale;
        const h  = (seg.y1 - seg.y0) * scale;
        ctx.fillRect(Math.floor(sx-1), Math.floor(sy), 2, Math.ceil(h));

        // posts
        ctx.fillStyle = POST_COLOR;
        const postStep = api.TILE * POST_SPACING;
        for(let y=seg.y0; y<=seg.y1; y+=postStep){
          const py = (y - api.camera.y) * scale;
          ctx.fillRect(Math.floor(sx-2), Math.floor(py-2), 4, 4);
        }
        ctx.fillStyle = FENCE_COLOR;
      } else {
        // thin horizontal strip
        const sx = (seg.x0 - api.camera.x) * scale;
        const sy = (seg.y  - api.camera.y) * scale;
        const w  = (seg.x1 - seg.x0) * scale;
        ctx.fillRect(Math.floor(sx), Math.floor(sy-1), Math.ceil(w), 2);

        // posts
        ctx.fillStyle = POST_COLOR;
        const postStep = api.TILE * POST_SPACING;
        for(let x=seg.x0; x<=seg.x1; x+=postStep){
          const px = (x - api.camera.x) * scale;
          ctx.fillRect(Math.floor(px-2), Math.floor(sy-2), 4, 4);
        }
        ctx.fillStyle = FENCE_COLOR;
      }
    });

    ctx.restore();
  }

  // Rebuild segments whenever tile size changes (orientation/zoom changes)
  function ensureSegments(api){
    if (!_segs || _lastTileSize !== api.TILE){
      _segs = buildFenceSegments(api);
      _lastTileSize = api.TILE|0;
    }
  }

  // --- Wire up: draw below actors, steer/collide after movement ---
  IZZA.on('render-under', ()=>{
    const api = IZZA.api; if(!api?.ready) return;
    ensureSegments(api);
    drawFence(api);
  });

  IZZA.on('update-post', ()=>{
    const api = IZZA.api; if(!api?.ready || !_segs) return;
    const p = api.player; if(!p) return;
    for(const seg of _segs){ resolveAgainstFence(p, seg); }
  });
})();
