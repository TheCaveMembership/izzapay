/* fence_hq_shop.plugin.js — perimeter fence: WEST, EAST, and back/NORTH at half-tile offset
   Wooden look, gentle pre-contact steer, hard stop, pure drop-in.
*/
(function(){
  if (!window.IZZA || typeof IZZA.on !== 'function') return;

  // ---- Tunables ----
  const OFFSET_TILES  = 0.5;   // place fence this far off the building edges
  const STEER_DIST    = 10;    // start nudging player away before collision
  const SOLID_DIST    = 4;     // hard boundary thickness

  // Wood paint
  const WOOD_RAIL     = '#7b5323';   // dark rail
  const WOOD_POST     = '#a8763e';   // post caps
  const WOOD_GRAIN    = '#5f401b';   // subtle grain lines
  const RAIL_THICK    = 3;           // px on screen after scaling
  const POST_SIZE     = 6;           // px
  const POST_SPACING_TILES = 1.0;    // distance between posts

  // Recreate anchors to match your map math so it lines up in all tiers
  const TIER_KEY='izzaMapTier';
  function unlockedRect(t){ return (t!=='2') ? {x0:18,y0:18,x1:72,y1:42} : {x0:10,y0:12,x1:80,y1:50}; }
  function anchors(api){
    const tier = localStorage.getItem(TIER_KEY)||'1';
    const un = unlockedRect(tier);

    const bW=10, bH=6;
    const bX = Math.floor((un.x0+un.x1)/2) - Math.floor(bW/2);
    const bY = un.y0 + 5;

    const hRoadY       = bY + bH + 1;
    const sidewalkTopY = hRoadY - 1;
    const vRoadX       = Math.min(un.x1-3, bX + bW + 6);

    const shop = { w:8, h:5, x:vRoadX+2, y: sidewalkTopY-5 };
    const HQ   = { x0:bX, y0:bY, x1:bX+bW-1, y1:bY+bH-1 };
    const SH   = { x0:shop.x, y0:shop.y, x1:shop.x+shop.w-1, y1:shop.y+shop.h-1 };

    return { HQ, SH };
  }

  // Build fence segments in world pixels
  function buildFenceSegments(api){
    const {HQ, SH} = anchors(api);
    const t = api.TILE;
    const out = [];

    function addRectWestEastNorth(rect){
      const {x0,y0,x1,y1} = rect;

      // WEST vertical line
      const westX   = (x0 - OFFSET_TILES) * t;
      const yTop    = y0 * t;
      const yBot    = (y1+1) * t;
      out.push({ kind:'v', x:westX, y0:yTop, y1:yBot });

      // EAST vertical line
      const eastX   = (x1+1 + OFFSET_TILES) * t;
      out.push({ kind:'v', x:eastX, y0:yTop, y1:yBot });

      // NORTH horizontal line (back of building)
      const northY  = (y0 - OFFSET_TILES) * t;
      const xLeft   = x0 * t;
      const xRight  = (x1+1) * t;
      out.push({ kind:'h', y:northY, x0:xLeft, x1:xRight });
    }

    addRectWestEastNorth(HQ);
    addRectWestEastNorth(SH);
    return out;
  }

  // Steering and collision
  function resolveAgainstFence(p, seg){
    // use center for smoothness, assume sprite ~32x32
    const cx = p.x + 16, cy = p.y + 16;

    if (seg.kind === 'v'){
      const dx = cx - seg.x;
      const withinY = cy >= seg.y0 && cy <= seg.y1;
      if (!withinY) return;

      if (Math.abs(dx) < STEER_DIST){
        const dir = dx < 0 ? -1 : 1;
        p.x += (STEER_DIST - Math.abs(dx)) * 0.06 * dir;
      }
      if (Math.abs(dx) < SOLID_DIST){
        if (dx < 0) p.x = seg.x - 16 - SOLID_DIST;
        else        p.x = seg.x - 16 + SOLID_DIST;
      }
    } else {
      const dy = cy - seg.y;
      const withinX = cx >= seg.x0 && cx <= seg.x1;
      if (!withinX) return;

      if (Math.abs(dy) < STEER_DIST){
        const dir = dy < 0 ? -1 : 1;
        p.y += (STEER_DIST - Math.abs(dy)) * 0.06 * dir;
      }
      if (Math.abs(dy) < SOLID_DIST){
        if (dy < 0) p.y = seg.y - 16 - SOLID_DIST;
        else        p.y = seg.y - 16 + SOLID_DIST;
      }
    }
  }

  // Cache, and rebuild when needed
  let _segs = null, _lastTile = 0;
  function ensureSegments(api){
    if (!_segs || _lastTile !== api.TILE){
      _segs = buildFenceSegments(api);
      _lastTile = api.TILE|0;
    }
  }
  IZZA.on('map-tier-changed', ()=>{ _segs = null; });

  // Wooden drawing under actors
  function drawFence(api){
    if (!_segs) return;
    const c = document.getElementById('game'); if(!c) return;
    const ctx = c.getContext('2d');

    const S = api.DRAW;
    const scale = S / api.TILE;
    const postStep = api.TILE * POST_SPACING_TILES;

    ctx.save();
    ctx.globalAlpha = 0.95;

    _segs.forEach(seg=>{
      if (seg.kind === 'v'){
        const sx = (seg.x - api.camera.x) * scale;
        const sy = (seg.y0 - api.camera.y) * scale;
        const h  = (seg.y1 - seg.y0) * scale;

        // dual rails to look like wood fence
        ctx.fillStyle = WOOD_RAIL;
        ctx.fillRect(Math.floor(sx - RAIL_THICK/2), Math.floor(sy), RAIL_THICK, Math.ceil(h));

        // subtle grain ticks
        ctx.fillStyle = WOOD_GRAIN;
        for(let y=seg.y0 + api.TILE*0.25; y<seg.y1; y+=api.TILE*0.75){
          const gy = (y - api.camera.y) * scale;
          ctx.fillRect(Math.floor(sx - 1), Math.floor(gy), 2, 1);
        }

        // posts
        ctx.fillStyle = WOOD_POST;
        for(let y=seg.y0; y<=seg.y1; y+=postStep){
          const py = (y - api.camera.y) * scale;
          ctx.fillRect(Math.floor(sx - POST_SIZE/2), Math.floor(py - POST_SIZE/2), POST_SIZE, POST_SIZE);
        }
      } else {
        const sx = (seg.x0 - api.camera.x) * scale;
        const sy = (seg.y  - api.camera.y) * scale;
        const w  = (seg.x1 - seg.x0) * scale;

        // horizontal rail
        ctx.fillStyle = WOOD_RAIL;
        ctx.fillRect(Math.floor(sx), Math.floor(sy - RAIL_THICK/2), Math.ceil(w), RAIL_THICK);

        // grain ticks
        ctx.fillStyle = WOOD_GRAIN;
        for(let x=seg.x0 + api.TILE*0.25; x<seg.x1; x+=api.TILE*0.75){
          const gx = (x - api.camera.x) * scale;
          ctx.fillRect(Math.floor(gx), Math.floor(sy - 1), 1, 2);
        }

        // posts
        ctx.fillStyle = WOOD_POST;
        for(let x=seg.x0; x<=seg.x1; x+=postStep){
          const px = (x - api.camera.y) * scale; // oops, watch axis
        }
        // correct axis for posts on horizontal run
        ctx.fillStyle = WOOD_POST;
        for(let x=seg.x0; x<=seg.x1; x+=postStep){
          const px2 = (x - api.camera.x) * scale;
          ctx.fillRect(Math.floor(px2 - POST_SIZE/2), Math.floor(sy - POST_SIZE/2), POST_SIZE, POST_SIZE);
        }
      }
    });

    ctx.restore();
  }

  // Wire up
  IZZA.on('render-under', ()=>{
    const api = IZZA.api; if(!api?.ready) return;
    ensureSegments(api);
    drawFence(api);
  });

  IZZA.on('update-post', ()=>{
    const api = IZZA.api; if(!api?.ready || !_segs) return;
    const p = api.player; if(!p) return;
    for(const seg of _segs) resolveAgainstFence(p, seg);
  });
})();
