/* fence_hq_shop.plugin.js — WEST/EAST/NORTH fence w/ stronger collision, invisible Shop-West wall, and safe respawn
   - West, East, North fences around HQ & Shop at 0.5 tile offset
   - Shop WEST side: invisible (draw skipped) but still collides
   - Beefed-up mid-run collision (adds tangent slide + larger solid band + multi-pass)
   - Stuck rescue → confirm → respawn to safe, dry sidewalk in front of HQ
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

  // ---------- Safe respawn finder (avoid water) ----------
  function isWaterTile(api, tx, ty){
    // Use engine helpers if available; otherwise assume not water
    try{
      if (api?.map?.isWaterTile) return !!api.map.isWaterTile(tx, ty);
      if (api?.isWaterTile)      return !!api.isWaterTile(tx, ty);
    }catch(e){}
    return false;
  }

  // Try several candidate points along the HQ front sidewalk line until a dry spot is found.
  function hqFrontSpawnPx(api){
    const {HQ, hRoadY} = anchors(api);
    const t = api.TILE;

    const baseY = hRoadY - 0.25;                 // sidewalk row in front of HQ
    const centerX = (HQ.x0 + HQ.x1 + 1)/2;

    // sample offsets (in tiles) from doorway center
    const offsets = [0, 0.7, -0.7, 1.4, -1.4, 2.1, -2.1];

    for(const off of offsets){
      const tx = centerX + off;
      const ty = baseY;
      if (!isWaterTile(api, Math.floor(tx), Math.floor(ty))){
        const cx = tx * t, cy = ty * t;
        return { x: Math.round(cx - 16), y: Math.round(cy - 16) };
      }
    }

    // Fallback: original center (should rarely happen)
    const cx = centerX * t, cy = baseY * t;
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
    // p: player top-left; treat center for distances
    const cx = p.x + 16, cy = p.y + 16;

    if (seg.kind === 'v'){
      const dx = cx - seg.x;
      const insideY = cy >= seg.y0 && cy <= seg.y1;
      if (!insideY) return;

      // Soft steer
      if (Math.abs(dx) < STEER_DIST){
        const dir = dx < 0 ? -1 : 1;
        p.x += (STEER_DIST - Math.abs(dx)) * 0.10 * dir;
      }
      // Hard clamp zone
      if (Math.abs(dx) < SOLID_DIST){
        // Lock outside the line
        if (dx < 0) p.x = seg.x - 16 - SOLID_DIST;
        else        p.x = seg.x - 16 + SOLID_DIST;

        // Tangent slide to avoid "sticky middle": nudge along Y
        // Push toward the nearer end to naturally slide off
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

        // Tangent slide along X to prevent sticking in the middle of the run
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
      // Skip drawing on Shop WEST fence to keep it invisible
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

  // Recompute on tier/orientation changes
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

    // Stronger collision: multi-pass + tangent slide
    for(let pass=0; pass<EXTRA_PASSES; pass++){
      for(const seg of _segs) clampAgainstSeg(p, seg);
    }

    // Rescue: if center is inside HQ/Shop rect (with margin), offer reset
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
        const spawn = hqFrontSpawnPx(api);   // guaranteed dry if engine exposes water check
        p.x = spawn.x;
        p.y = spawn.y;
      }
    }
  });
})();
/* ==== SEASONAL FENCE DECOR (non-invasive add-on) ============================================== */
(function(){
  if (!window.IZZA || typeof IZZA.on !== 'function') return;

  // ----- Season / Holiday logic -----
  function seasonTag(now=new Date()){
    const m = now.getMonth()+1, d = now.getDate(), md = m*100 + d;
    if (md >= 920 && md <= 1031) return 'halloween';     // Sep20–Oct31
    if (md >= 1201 && md <= 1226) return 'christmas';     // Dec1–Dec26
    if (m===12 || m===1 || m===2) return 'winter';
    if (m>=3 && m<=5)             return 'spring';
    if (m>=6 && m<=8)             return 'summer';
    return 'fall';
  }

  // ----- Minimal mirror of your fence geometry (read-only; DOES NOT alter fence behavior) -----
  const TIER_KEY='izzaMapTier';
  function unlockedRect(t){ return (t!=='2') ? {x0:18,y0:18,x1:72,y1:42} : {x0:10,y0:12,x1:80,y1:50}; }
  function _anchors(api){
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
  function fenceSegments(api){
    const {HQ, SH} = _anchors(api);
    const t = api.TILE;
    const segs = [];
    function addRect(rect){
      const {x0,y0,x1,y1} = rect;
      segs.push({kind:'h', x0:x0*t,        x1:(x1+1)*t, y:y0*t,      nx:0,  ny:-1}); // north
      segs.push({kind:'h', x0:x0*t,        x1:(x1+1)*t, y:(y1+1)*t,  nx:0,  ny:1});  // south
      segs.push({kind:'v', x:x0*t,         y0:y0*t,     y1:(y1+1)*t, nx:-1, ny:0});  // west
      segs.push({kind:'v', x:(x1+1)*t,     y0:y0*t,     y1:(y1+1)*t, nx:1,  ny:0});  // east
    }
    addRect(HQ); addRect(SH);
    return segs;
  }

  // ----- Overlay canvas (above game, HiDPI aware) -----
  let overlay=null, ctx=null, ro=null, dpr=1, w2s=1;
  function ensureOverlay(){
    if (overlay && ctx) return true;
    const card = document.getElementById('gameCard');
    const game = document.getElementById('game');
    if(!card||!game) return false;
    overlay = document.createElement('canvas');
    overlay.id = 'izzaFenceDecor';
    overlay.style.position = 'absolute';
    overlay.style.inset = '10px 10px 10px 10px';
    overlay.style.pointerEvents = 'none';
    overlay.style.borderRadius = getComputedStyle(game).borderRadius || '12px';
    overlay.style.zIndex = '4';
    card.appendChild(overlay);
    ctx = overlay.getContext('2d');

    const resize = ()=>{
      const rect = game.getBoundingClientRect();
      dpr = Math.max(1, Math.round(window.devicePixelRatio||1));
      overlay.width  = Math.max(1, Math.round(rect.width  * dpr));
      overlay.height = Math.max(1, Math.round(rect.height * dpr));
      overlay.style.width  = Math.round(rect.width)  + 'px';
      overlay.style.height = Math.round(rect.height) + 'px';
      draw(); // repaint after size change
    };
    ro = new ResizeObserver(resize);
    ro.observe(game);
    resize();
    return true;
  }
  function updateScalars(api){ w2s = (api.DRAW / api.TILE); }
  function toCanvasPx(api, wx, wy){
    const sx = (wx - api.camera.x) * w2s * dpr;
    const sy = (wy - api.camera.y) * w2s * dpr;
    return [sx, sy];
  }

  // ----- Vector sprites (tiny, tasteful) -----
  // Helpers
  function rrectPath(x,y,w,h,r){ const p=new Path2D(); const rr=Math.max(0,Math.min(r,Math.min(Math.abs(w),Math.abs(h))/2)); p.moveTo(x+rr,y); p.lineTo(x+w-rr,y); p.arcTo(x+w,y,x+w,y+rr,rr); p.lineTo(x+w,y+h-rr); p.arcTo(x+w,y+h,x+w-rr,y+h,rr); p.lineTo(x+rr,y+h); p.arcTo(x,y+h,x,y+h-rr,rr); p.lineTo(x,y+rr); p.arcTo(x,y,x+rr,y,rr); p.closePath(); return p; }

  function drawLeaf(px){
    const s = px/24; ctx.save(); ctx.scale(s,s);
    const P = new Path2D('M0,-18 C10,-10 12,-2 0,14 C-12,-2 -10,-10 0,-18 Z');
    ctx.fillStyle='#c96a1b'; ctx.fill(P);
    ctx.strokeStyle='rgba(0,0,0,.28)'; ctx.lineWidth=1.2; ctx.beginPath(); ctx.moveTo(0,-18); ctx.lineTo(0,14); ctx.stroke();
    ctx.restore();
  }
  function drawMush(px){
    const s = px/32; ctx.save(); ctx.scale(s,s);
    ctx.fillStyle='#c0392b'; ctx.beginPath(); ctx.ellipse(0,-6,16,10,0,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#fff'; ctx.fillRect(-6,-6,12,10);
    [ -8,0,8 ].forEach(dx=>{ ctx.beginPath(); ctx.arc(dx,-6,2.2,0,Math.PI*2); ctx.fill(); });
    ctx.restore();
  }
  function drawPumpkin(px, face){
    const s=px/28; ctx.save(); ctx.scale(s,s);
    ctx.fillStyle='#e66a00'; ctx.beginPath(); ctx.ellipse(0,0,14,10,0,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#ff8a1c'; ctx.beginPath(); ctx.ellipse(-6,0,8,10,0,0,Math.PI*2); ctx.fill(); ctx.beginPath(); ctx.ellipse(6,0,8,10,0,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#3d6b2f'; ctx.fillRect(-2,-14,4,6);
    if(face){ ctx.fillStyle='rgba(0,0,0,.88)'; ctx.beginPath(); ctx.moveTo(-8,-3); ctx.lineTo(-3,-8); ctx.lineTo(2,-3); ctx.fill(); ctx.beginPath(); ctx.moveTo(8,-3); ctx.lineTo(3,-8); ctx.lineTo(-2,-3); ctx.fill(); ctx.fillRect(-8,3,16,2); }
    ctx.restore();
  }
  function drawLight(px){
    const s=px/12; ctx.save(); ctx.scale(s,s);
    ctx.fillStyle='#ffd23f'; ctx.beginPath(); ctx.ellipse(0,0,4,6,0,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#556'; ctx.fillRect(-2,-8,4,3); ctx.beginPath(); ctx.moveTo(-3,-12); ctx.lineTo(3,-12); ctx.strokeStyle='#556'; ctx.lineWidth=1.2; ctx.stroke();
    ctx.restore();
  }
  function drawWeb(px){
    const s=px/32; ctx.save(); ctx.scale(s,s);
    ctx.strokeStyle='rgba(255,255,255,0.8)'; ctx.lineWidth=1.1;
    for(let i=0;i<6;i++){ ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(16,0); ctx.stroke(); ctx.rotate(Math.PI/3); }
    for(let r=5;r<=15;r+=4){ ctx.beginPath(); for(let i=0;i<=6;i++){ const a=i*(Math.PI/3); const nx=Math.cos(a)*r, ny=Math.sin(a)*r; if(i===0) ctx.moveTo(nx,ny); else ctx.lineTo(nx,ny);} ctx.stroke(); }
    ctx.restore();
  }
  function drawSnow(px){ const s=px/32; ctx.save(); ctx.scale(s,s); ctx.fillStyle='rgba(240,248,255,.96)'; ctx.beginPath(); ctx.ellipse(0,0,16,7,0,0,Math.PI*2); ctx.fill(); ctx.restore(); }
  function drawBlossom(px){ const s=px/20; ctx.save(); ctx.scale(s,s); ctx.fillStyle='#ffd1e8'; for(let i=0;i<5;i++){ ctx.rotate(Math.PI*2/5); ctx.beginPath(); ctx.ellipse(0,-7,3,6,0,0,Math.PI*2); ctx.fill(); } ctx.fillStyle='#ff7aa2'; ctx.beginPath(); ctx.arc(0,0,2.6,0,Math.PI*2); ctx.fill(); ctx.restore(); }
  const drawFlower = drawBlossom;

  function drawCorn(px){
    const s=px/18; ctx.save(); ctx.scale(s,s);
    ctx.strokeStyle='#6b8f3b'; ctx.lineWidth=2.2; ctx.beginPath(); ctx.moveTo(0,10); ctx.lineTo(0,-34); ctx.stroke();
    ctx.strokeStyle='#7aa041'; ctx.lineWidth=1.6;
    [[-14,-10],[14,-8],[-12,-18],[12,-20],[-10,-28]].forEach(([dx,dy])=>{ ctx.beginPath(); ctx.moveTo(0,dy); ctx.quadraticCurveTo(dx,dy-4,dx+(dx>0?-6:6),dy-2); ctx.stroke(); });
    ctx.strokeStyle='#caa64a'; ctx.lineWidth=1.4; for(let i=-2;i<=2;i++){ ctx.beginPath(); ctx.moveTo(0,-36); ctx.lineTo(i*2,-40); ctx.stroke(); }
    ctx.restore();
  }
  function drawHay(px){
    const s=px/44; ctx.save(); ctx.scale(s,s);
    const p=rrectPath(-22,-12,44,24,4);
    ctx.fillStyle='#e2c165'; ctx.strokeStyle='#b59642'; ctx.lineWidth=2; ctx.fill(p); ctx.stroke(p);
    ctx.strokeStyle='rgba(150,120,50,.6)'; ctx.lineWidth=1; for(let i=-18;i<=18;i+=6){ ctx.beginPath(); ctx.moveTo(i,-10); ctx.lineTo(i,10); ctx.stroke(); }
    ctx.strokeStyle='#8b6a2e'; ctx.lineWidth=2; ctx.beginPath(); ctx.moveTo(-22,-4); ctx.lineTo(22,-4); ctx.moveTo(-22,4); ctx.lineTo(22,4); ctx.stroke();
    ctx.restore();
  }
  function drawCornucopia(px){
    const s=px/40; ctx.save(); ctx.scale(s,s);
    ctx.fillStyle='#7a5230'; ctx.beginPath();
    ctx.moveTo(-18,6); ctx.quadraticCurveTo(-30,-2,-10,-12);
    ctx.quadraticCurveTo(10,-20,18,-8); ctx.quadraticCurveTo(10,-6,4,-6); ctx.quadraticCurveTo(-2,-4,-6,0); ctx.lineTo(-18,6); ctx.fill();
    ctx.fillStyle='rgba(0,0,0,.18)'; ctx.beginPath(); ctx.ellipse(-10,-2,8,4,0,0,Math.PI*2); ctx.fill();
    const fruit=(x,y,r,fill)=>{ ctx.fillStyle=fill; ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2); ctx.fill(); };
    fruit(-2,4,4,'#d94c4c'); fruit(6,2,3,'#f0b429'); fruit(-8,2,3,'#8dbf2f');
    ctx.fillStyle='#7e4cc9'; for(let gx=0; gx<3; gx++){ for(let gy=0; gy<2; gy++){ ctx.beginPath(); ctx.arc(10+gx*3,6+gy*3,1.6,0,Math.PI*2); ctx.fill(); } }
    ctx.restore();
  }
  function drawWreath(px){
    const s=px/36; ctx.save(); ctx.scale(s,s);
    // green ring
    ctx.fillStyle='#2f6a3a'; ctx.beginPath(); ctx.arc(0,0,16,0,Math.PI*2); ctx.arc(0,0,10,0,Math.PI*2,true); ctx.fill();
    // berries
    ctx.fillStyle='#c02626'; for(let i=0;i<8;i++){ const a=i*(Math.PI/4); ctx.beginPath(); ctx.arc(Math.cos(a)*13,Math.sin(a)*13,2,0,Math.PI*2); ctx.fill(); }
    // bow
    ctx.fillStyle='#c53030'; ctx.beginPath(); ctx.moveTo(-6,6); ctx.lineTo(0,0); ctx.lineTo(6,6); ctx.lineTo(0,10); ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  // ----- Scatter + clusters per season/holiday -----
  let CACHE=null; // { tile, tag, items:[{x,y,rot,kind,px}] }
  function ensureDecor(api){
    const tag = seasonTag();
    if (CACHE && CACHE.tile===api.TILE && CACHE.tag===tag) return;

    const segs = fenceSegments(api);
    const rs = (seed=>{ let s=0; for(let i=0;i<seed.length;i++) s=(s*131+seed.charCodeAt(i))>>>0; return ()=> (s=(1103515245*s+12345)>>>0)/0xffffffff; })(tag+'@'+api.TILE);
    const items=[];

    // place an item in world px
    const add = (x,y,kind,px,rot=0)=> items.push({x,y,kind,px,rot});

    // blanket scatter
    function scatter(seg, per100, chooser){
      const len = (seg.kind==='h') ? (seg.x1 - seg.x0) : (seg.y1 - seg.y0);
      const n   = Math.max(2, Math.floor((len/100) * per100));
      for (let i=0;i<n;i++){
        const u=rs();
        let x,y; if(seg.kind==='h'){ x=seg.x0+u*(seg.x1-seg.x0); y=seg.y; } else { x=seg.x; y=seg.y0+u*(seg.y1-seg.y0); }
        const off = 8 + rs()*6; x += seg.nx*off; y += seg.ny*off; // nudge outward from fence
        chooser(x,y);
      }
    }

    // porch cluster: hay + corn + pumpkins (or wreath/lights for Xmas)
    function cluster(x,y,nx,ny,tag){
      const jitter=a=>(a*(rs()-0.5));
      if (tag==='christmas'){
        add(x+nx*6 + jitter(4), y+ny*4 + jitter(4), 'wreath', 36, jitter(0.2));
        // string light bulbs near cluster
        for(let i=0;i<4;i++){ add(x + jitter(12), y + jitter(10), 'light', 10+rs()*4, rs()*Math.PI*2); }
        return;
      }
      // fall/halloween default
      add(x + jitter(6), y + jitter(6), 'hay',   42, jitter(0.2));
      add(x - nx*6 + jitter(4), y - ny*6 + jitter(4), 'corn', 44, Math.PI + jitter(0.2));
      add(x + nx*8 + jitter(4), y + ny*2 + jitter(3), 'pumpkin', 24+rs()*4, jitter(0.2));
      const jack = (tag==='halloween' && rs()<0.6);
      add(x + nx*3 + jitter(4), y - ny*3 + jitter(3), jack?'jack':'pumpkin', 26+rs()*6, jitter(0.2));
      if (tag==='fall' && rs()<0.5) add(x + nx*4 + jitter(4), y + ny*6 + jitter(4), 'cornucopia', 34, jitter(0.4));
      for(let i=0;i<3;i++) add(x + jitter(12), y + jitter(10), 'leaf', 14+rs()*6, rs()*Math.PI*2);
    }

    // Per-season recipes
    for(const seg of segs){
      if (tag==='halloween'){
        scatter(seg, 4.0, (x,y)=>{
          const r=rs(); if(r<0.5) add(x,y,'leaf',16+rs()*6,rs()*Math.PI*2);
          else if(r<0.7) add(x,y,'pumpkin',24+rs()*6,(rs()-0.5)*0.2);
          else if(r<0.85) add(x,y,'jack',26+rs()*8,(rs()-0.5)*0.2);
          else if(r<0.93) add(x,y,'web',22+rs()*10,rs()*Math.PI*2);
          else add(x,y,'light',12+rs()*4,rs()*Math.PI*2);
        });
      } else if (tag==='fall'){
        scatter(seg, 3.5, (x,y)=>{
          const r=rs(); if(r<0.65) add(x,y,'leaf',14+rs()*6,rs()*Math.PI*2);
          else if(r<0.82) add(x,y,'mush',18+rs()*4,(rs()-0.5)*0.5);
          else add(x,y,'pumpkin',22+rs()*6,(rs()-0.5)*0.2);
        });
      } else if (tag==='winter'){
        scatter(seg, 3.0, (x,y)=>{
          const r=rs(); if(r<0.6) add(x,y,'snow',22+rs()*8,0);
          else add(x,y,'twig',24+rs()*6,rs()*Math.PI*2);
        });
      } else if (tag==='christmas'){
        scatter(seg, 3.2, (x,y)=> add(x,y,'light',10+rs()*4, rs()*Math.PI*2));
      } else if (tag==='spring'){
        scatter(seg, 2.8, (x,y)=>{
          const r=rs(); if(r<0.8) add(x,y,'blossom',16+rs()*6,rs()*Math.PI*2);
          else add(x,y,'leaf',14+rs()*6,rs()*Math.PI*2);
        });
      } else if (tag==='summer'){
        scatter(seg, 2.5, (x,y)=>{
          const r=rs(); if(r<0.7) add(x,y,'flower',16+rs()*6,rs()*Math.PI*2);
          else add(x,y,'leaf',14+rs()*6,rs()*Math.PI*2);
        });
      }

      // three porch clusters per edge (works for all tags)
      if (seg.kind==='h'){
        const L=seg.x1-seg.x0, y=seg.y;
        cluster(seg.x0+L*0.25, y, seg.nx, seg.ny, tag);
        cluster(seg.x0+L*0.50, y, seg.nx, seg.ny, tag);
        cluster(seg.x0+L*0.75, y, seg.nx, seg.ny, tag);
      } else {
        const L=seg.y1-seg.y0, x=seg.x;
        cluster(x, seg.y0+L*0.25, seg.nx, seg.ny, tag);
        cluster(x, seg.y0+L*0.50, seg.nx, seg.ny, tag);
        cluster(x, seg.y0+L*0.75, seg.nx, seg.ny, tag);
      }
    }

    CACHE = { tile: api.TILE, tag, items };
    try{ window.IZZA_SEASONAL = { season: tag, count: items.length }; }catch(_){}
  }

  // ----- Draw switch -----
  function drawSprite(kind, px){
    switch(kind){
      case 'leaf':       drawLeaf(px); break;
      case 'mush':       drawMush(px); break;
      case 'pumpkin':    drawPumpkin(px,false); break;
      case 'jack':       drawPumpkin(px,true); break;
      case 'light':      drawLight(px); break;
      case 'web':        drawWeb(px); break;
      case 'snow':       drawSnow(px); break;
      case 'blossom':    drawBlossom(px); break;
      case 'flower':     drawFlower(px); break;
      case 'corn':       drawCorn(px); break;
      case 'hay':        drawHay(px); break;
      case 'cornucopia': drawCornucopia(px); break;
      case 'wreath':     drawWreath(px); break;
      case 'twig':       /* winter twig */ (function(px){ const s=px/24; ctx.save(); ctx.scale(s,s); ctx.strokeStyle='rgba(180,180,200,.85)'; ctx.lineWidth=1.6; ctx.beginPath(); ctx.moveTo(-8,6); ctx.lineTo(8,-6); ctx.stroke(); ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(6,4); ctx.moveTo(-2,-2); ctx.lineTo(-6,-6); ctx.stroke(); ctx.restore(); })(px); break;
    }
  }

  // ----- Frame draw -----
  function draw(){
    if (!ctx || !overlay) return;
    const api = IZZA.api; if(!api?.ready) return;
    updateScalars(api);

    ctx.setTransform(1,0,0,1,0,0);
    ctx.clearRect(0,0,overlay.width,overlay.height);

    if (!CACHE) return;
    for (const it of CACHE.items){
      const [sx, sy] = toCanvasPx(api, it.x, it.y);
      ctx.save();
      ctx.translate(sx, sy);
      if (it.rot) ctx.rotate(it.rot);
      drawSprite(it.kind, (it.px||24) * dpr);
      ctx.restore();
    }
  }

  // ----- Boot & wire-up -----
  IZZA.on('ready', api=>{
    if (!ensureOverlay()) return;
    ensureDecor(api);
    draw();
    IZZA.on('draw-post', draw);
    setInterval(()=>{ ensureDecor(api); }, 60*1000); // auto-switch when month changes
  });
})();
