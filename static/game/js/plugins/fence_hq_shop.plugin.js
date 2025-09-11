/* fence_hq_shop.plugin.js — WEST/EAST/NORTH fence w/ stronger collision, invisible Shop-West wall, and safe respawn
   - West, East, North fences around HQ & Shop at 0.5 tile offset
   - Shop WEST side: invisible (draw skipped) but still collides
   - Beefed-up mid-run collision (adds tangent slide + larger solid band + multi-pass)
   - Stuck rescue → confirm → respawn to HQ door
*/
(function(){
  if (!window.IZZA || typeof IZZA.on !== 'function') return;

  // ---------- Tunables ----------
  const OFFSET_TILES          = 0.5;   // fence offset from building
  const STEER_DIST            = 16;    // pre-contact nudge zone (px)
  const SOLID_DIST            = 16;    // hard boundary half-thickness (px) — stronger
  const EXTRA_PASSES          = 3;     // multiple clamps to defeat tunneling
  const TANGENT_PUSH          = 2.0;   // px of along-fence slide when hitting dead-on

  // “stuck inside building” detection and rescue
  const STUCK_MARGIN_TILES    = 0.3;
  const PROMPT_COOLDOWN_MS    = 6000;

  // Wood look (kept)
  const WOOD_RAIL   = '#7b5323';
  const WOOD_POST   = '#a8763e';
  const WOOD_GRAIN  = '#5f401b';
  const RAIL_THICK  = 3;   // px
  const POST_SIZE   = 6;   // px
  const POST_SPACING_TILES = 1.0;

  // ---------- Geometry anchors (mirrors your map math) ----------
  const TIER_KEY='izzaMapTier';
  function unlockedRect(t){ return (t!=='2') ? {x0:18,y0:18,x1:72,y1:42} : {x0:10,y0:12,x1:80,y1:50}; }
  function anchors(api){
    const tier = localStorage.getItem(TIER_KEY)||'1';
    const un = unlockedRect(tier);

    const bW=10, bH=6;
    const bX = Math.floor((un.x0+un.x1)/2) - Math.floor(bW/2);
    const bY = un.y0 + 5;

    const hRoadY       = bY + bH + 1;     // road in front (south) of HQ
    const sidewalkTopY = hRoadY - 1;
    const vRoadX       = Math.min(un.x1-3, bX + bW + 6);

    const shop = { w:8, h:5, x:vRoadX+2, y: sidewalkTopY-5 };
    const HQ   = { x0:bX, y0:bY, x1:bX+bW-1, y1:bY+bH-1 };
    const SH   = { x0:shop.x, y0:shop.y, x1:shop.x+shop.w-1, y1:shop.y+shop.h-1 };

    return { HQ, SH, hRoadY };
  }

  // ---------- Safe respawn finder (HQ door only) ----------
  function isWaterTile(api, tx, ty){
    try{
      if (api?.map?.isWaterTile) return !!api.map.isWaterTile(tx, ty);
      if (api?.isWaterTile)      return !!api.isWaterTile(tx, ty);
    }catch(e){}
    return false;
  }

  function hqFrontSpawnPx(api){
    const {HQ} = anchors(api);
    const t = api.TILE;

    // Door at the middle of the HQ south wall
    const doorTx = (HQ.x0 + HQ.x1 + 1) / 2;
    const doorTy = HQ.y1 + 0.50; // just outside the south wall, on the doorway

    // Prefer exact door
    if (!isWaterTile(api, Math.floor(doorTx), Math.floor(doorTy))) {
      const cx = doorTx * t, cy = doorTy * t;
      return { x: Math.round(cx - 16), y: Math.round(cy - 16) };
    }

    // Final fallback: door center anyway
    const cx = doorTx * t, cy = doorTy * t;
    return { x: Math.round(cx - 16), y: Math.round(cy - 16) };
  }

  // ---------- Fence segments (world px), tagged to allow “invisible” draw skip ----------
  function buildFenceSegments(api){
    const {HQ, SH} = anchors(api);
    const t = api.TILE;
    const out = [];

    function addRectWestEastNorth(rect, bTag){
      const {x0,y0,x1,y1} = rect;

      // WEST
      out.push({ kind:'v', b:bTag, side:'W', x:(x0 - OFFSET_TILES)*t, y0:y0*t, y1:(y1+1)*t });
      // EAST
      out.push({ kind:'v', b:bTag, side:'E', x:(x1+1 + OFFSET_TILES)*t, y0:y0*t, y1:(y1+1)*t });
      // NORTH (back)
      out.push({ kind:'h', b:bTag, side:'N', y:(y0 - OFFSET_TILES)*t, x0:x0*t, x1:(x1+1)*t });
    }

    addRectWestEastNorth(HQ, 'HQ');
    addRectWestEastNorth(SH, 'SH');   // Shop

    return out;
  }

  // ---------- Collision helpers (stronger mid-run behavior) ----------
  function clampAgainstSeg(p, seg){
    const cx = p.x + 16, cy = p.y + 16;

    if (seg.kind === 'v'){
      const dx = cx - seg.x;
      const insideY = cy >= seg.y0 && cy <= seg.y1;
      if (!insideY) return;

      if (Math.abs(dx) < STEER_DIST){
        const dir = dx < 0 ? -1 : 1;
        p.x += (STEER_DIST - Math.abs(dx)) * 0.10 * dir;
      }
      if (Math.abs(dx) < SOLID_DIST){
        if (dx < 0) p.x = seg.x - 16 - SOLID_DIST;
        else        p.x = seg.x - 16 + SOLID_DIST;

        const midY = (seg.y0 + seg.y1)/2;
        const sign = (cy < midY) ? -1 : 1;
        p.y += TANGENT_PUSH * sign;
      }
    } else {
      const dy = cy - seg.y;
      const insideX = cx >= seg.x0 && cx <= seg.x1;
      if (!insideX) return;

      if (Math.abs(dy) < STEER_DIST){
        const dir = dy < 0 ? -1 : 1;
        p.y += (STEER_DIST - Math.abs(dy)) * 0.10 * dir;
      }
      if (Math.abs(dy) < SOLID_DIST){
        if (dy < 0) p.y = seg.y - 16 - SOLID_DIST;
        else        p.y = seg.y - 16 + SOLID_DIST;

        const midX = (seg.x0 + seg.x1)/2;
        const sign = (cx < midX) ? -1 : 1;
        p.x += TANGENT_PUSH * sign;
      }
    }
  }

  function inflateRectPx(rectTiles, t, marginTiles){
    const m = marginTiles * t;
    return {
      x0: rectTiles.x0*t - m,
      y0: rectTiles.y0*t - m,
      x1: (rectTiles.x1+1)*t + m,
      y1: (rectTiles.y1+1)*t + m
    };
  }

  function pointInRect(px, py, r){
    return px >= r.x0 && px <= r.x1 && py >= r.y0 && py <= r.y1;
  }

  // ---------- Draw (wood fence) ----------
  function drawFence(api, segs){
    if (!segs) return;
    const c = document.getElementById('game'); if(!c) return;
    const ctx = c.getContext('2d');
    const scale = api.DRAW / api.TILE;
    const postStep = api.TILE * POST_SPACING_TILES;

    ctx.save();
    ctx.globalAlpha = 0.95;

    segs.forEach(seg=>{
      if (seg.b === 'SH' && seg.side === 'W') return;

      if (seg.kind === 'v'){
        const sx = (seg.x - api.camera.x) * scale;
        const sy = (seg.y0 - api.camera.y) * scale;
        const h  = (seg.y1 - seg.y0) * scale;

        ctx.fillStyle = WOOD_RAIL;
        ctx.fillRect(Math.floor(sx - RAIL_THICK/2), Math.floor(sy), RAIL_THICK, Math.ceil(h));

        ctx.fillStyle = WOOD_GRAIN;
        for(let y=seg.y0 + api.TILE*0.25; y<seg.y1; y+=api.TILE*0.75){
          const gy = (y - api.camera.y) * scale;
          ctx.fillRect(Math.floor(sx - 1), Math.floor(gy), 2, 1);
        }

        ctx.fillStyle = WOOD_POST;
        for(let y=seg.y0; y<=seg.y1; y+=postStep){
          const py = (y - api.camera.y) * scale;
          ctx.fillRect(Math.floor(sx - POST_SIZE/2), Math.floor(py - POST_SIZE/2), POST_SIZE, POST_SIZE);
        }
      } else {
        const sx = (seg.x0 - api.camera.x) * scale;
        const sy = (seg.y  - api.camera.y) * scale;
        const w  = (seg.x1 - seg.x0) * scale;

        ctx.fillStyle = WOOD_RAIL;
        ctx.fillRect(Math.floor(sx), Math.floor(sy - RAIL_THICK/2), Math.ceil(w), RAIL_THICK);

        ctx.fillStyle = WOOD_GRAIN;
        for(let x=seg.x0 + api.TILE*0.25; x<seg.x1; x+=api.TILE*0.75){
          const gx = (x - api.camera.x) * scale;
          ctx.fillRect(Math.floor(gx), Math.floor(sy - 1), 1, 2);
        }

        ctx.fillStyle = WOOD_POST;
        for(let x=seg.x0; x<=seg.x1; x+=postStep){
          const px = (x - api.camera.x) * scale;
          ctx.fillRect(Math.floor(px - POST_SIZE/2), Math.floor(sy - POST_SIZE/2), POST_SIZE, POST_SIZE);
        }
      }
    });

    ctx.restore();
  }

  // ---------- State / wiring ----------
  let _segs = null, _lastTile = 0, _lastPromptAt = 0;

  function ensureSegments(api){
    if (!_segs || _lastTile !== (api.TILE|0)){
      _segs = buildFenceSegments(api);
      _lastTile = api.TILE|0;
    }
  }

  IZZA.on('map-tier-changed', ()=>{ _segs = null; });
  IZZA.on('orientation-changed', ()=>{ _segs = null; });

  IZZA.on('render-under', ()=>{
    const api = IZZA.api; if(!api?.ready) return;
    ensureSegments(api);
    drawFence(api, _segs);
  });

  IZZA.on('update-post', ()=>{
    const api = IZZA.api; if(!api?.ready || !_segs) return;
    const p = api.player; if(!p) return;

    for(let pass=0; pass<EXTRA_PASSES; pass++){
      for(const seg of _segs) clampAgainstSeg(p, seg);
    }

    const {HQ, SH} = anchors(api);
    const t = api.TILE;
    const hqPx = inflateRectPx(HQ, t, STUCK_MARGIN_TILES);
    const shPx = inflateRectPx(SH, t, STUCK_MARGIN_TILES);

    const cx = p.x + 16, cy = p.y + 16;
    const now = performance.now();

    if ((pointInRect(cx, cy, hqPx) || pointInRect(cx, cy, shPx)) &&
        (now - _lastPromptAt) > PROMPT_COOLDOWN_MS){
      _lastPromptAt = now;
      if (window.confirm('You look stuck. Reset spawn to the front of HQ?')){
        const spawn = hqFrontSpawnPx(api);
        p.x = spawn.x;
        p.y = spawn.y;
      }
    }
  });
})();
