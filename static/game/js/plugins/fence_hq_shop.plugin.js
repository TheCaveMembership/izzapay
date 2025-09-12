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
      out.push({ kind:'v', b:bTag, side:'W', x:(x0 - OFFSET_TILES)*t, y0:y0*t, y1:(y1+1)*t, nx:-1, ny:0 });
      // EAST
      out.push({ kind:'v', b:bTag, side:'E', x:(x1+1 + OFFSET_TILES)*t, y0:y0*t, y1:(y1+1)*t, nx:1, ny:0 });
      // NORTH (back)
      out.push({ kind:'h', b:bTag, side:'N', y:(y0 - OFFSET_TILES)*t, x0:x0*t, x1:(x1+1)*t, nx:0, ny:-1 });
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

  /* =========================
     SEASONAL DECOR ADDITIONS
     (drawn in the SAME pass, SAME ctx, SAME scale as the fence)
     ========================= */

  // -- season / rng
  function __seasonTag(now=new Date()){
    const m=now.getMonth()+1, d=now.getDate(), md=m*100+d;
    if (md>=920 && md<=1031) return 'halloween';  // Sep 20–Oct 31
    if (md>=1201 && md<=1226) return 'christmas'; // Dec 1–26
    if (m===12||m===1||m===2) return 'winter';
    if (m>=3&&m<=5) return 'spring';
    if (m>=6&&m<=8) return 'summer';
    return 'fall';
  }
  function __rng(seed){ let s=0; for(let i=0;i<seed.length;i++) s=(s*131+seed.charCodeAt(i))>>>0; return ()=> (s=(1103515245*s+12345)>>>0)/0xffffffff; }

  // -- tiny vector sprites (sizes in SCREEN PX; we compute from api.DRAW)
  function __leaf(ctx, sx, sy, size){
    const s=size/24; ctx.save(); ctx.translate(sx,sy); ctx.scale(s,s);
    const P=new Path2D('M0,-18 C10,-10 12,-2 0,14 C-12,-2 -10,-10 0,-18 Z');
    ctx.fillStyle='#c96a1b'; ctx.fill(P);
    ctx.strokeStyle='rgba(0,0,0,.28)'; ctx.lineWidth=1.2; ctx.beginPath(); ctx.moveTo(0,-18); ctx.lineTo(0,14); ctx.stroke();
    ctx.restore();
  }
  function __mush(ctx, sx, sy, size){
    const s=size/32; ctx.save(); ctx.translate(sx,sy); ctx.scale(s,s);
    ctx.fillStyle='#c0392b'; ctx.beginPath(); ctx.ellipse(0,-6,16,10,0,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#fff'; ctx.fillRect(-6,-6,12,10);
    [-8,0,8].forEach(dx=>{ ctx.beginPath(); ctx.arc(dx,-6,2.2,0,Math.PI*2); ctx.fill(); });
    ctx.restore();
  }
  function __pump(ctx, sx, sy, size, face){
    const s=size/28; ctx.save(); ctx.translate(sx,sy); ctx.scale(s,s);
    ctx.fillStyle='#e66a00'; ctx.beginPath(); ctx.ellipse(0,0,14,10,0,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#ff8a1c'; ctx.beginPath(); ctx.ellipse(-6,0,8,10,0,0,Math.PI*2); ctx.fill(); ctx.beginPath(); ctx.ellipse(6,0,8,10,0,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#3d6b2f'; ctx.fillRect(-2,-14,4,6);
    if (face){
      ctx.fillStyle='rgba(0,0,0,.88)';
      ctx.beginPath(); ctx.moveTo(-8,-3); ctx.lineTo(-3,-8); ctx.lineTo(2,-3); ctx.fill();
      ctx.beginPath(); ctx.moveTo(8,-3); ctx.lineTo(3,-8); ctx.lineTo(-2,-3); ctx.fill();
      ctx.fillRect(-8,3,16,2);
    }
    ctx.restore();
  }
  function __web(ctx, sx, sy, size){
    const s=size/32; ctx.save(); ctx.translate(sx,sy); ctx.scale(s,s);
    ctx.strokeStyle='rgba(255,255,255,0.8)'; ctx.lineWidth=1.1;
    for(let i=0;i<6;i++){ ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(16,0); ctx.stroke(); ctx.rotate(Math.PI/3); }
    for(let r=5;r<=15;r+=4){ ctx.beginPath(); for(let i=0;i<=6;i++){ const a=i*(Math.PI/3); const nx=Math.cos(a)*r, ny=Math.sin(a)*r; if(i===0) ctx.moveTo(nx,ny); else ctx.lineTo(nx,ny);} ctx.stroke(); }
    ctx.restore();
  }
  function __light(ctx, sx, sy, size){
    const s=size/12; ctx.save(); ctx.translate(sx,sy); ctx.scale(s,s);
    ctx.fillStyle='#ffd23f'; ctx.beginPath(); ctx.ellipse(0,0,4,6,0,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#556'; ctx.fillRect(-2,-8,4,3); ctx.beginPath(); ctx.moveTo(-3,-12); ctx.lineTo(3,-12); ctx.strokeStyle='#556'; ctx.lineWidth=1.2; ctx.stroke();
    ctx.restore();
  }
  function __hay(ctx, sx, sy, size){
    const s=size/44; ctx.save(); ctx.translate(sx,sy); ctx.scale(s,s);
    const r=4; const p=new Path2D(); p.moveTo(-22+r,-12); p.lineTo(22-r,-12); p.arcTo(22,-12,22,-12+r,r); p.lineTo(22,12-r); p.arcTo(22,12,22-r,12,r); p.lineTo(-22+r,12); p.arcTo(-22,12,-22,12-r,r); p.lineTo(-22,-12+r); p.arcTo(-22,-12,-22+r,-12,r); p.closePath();
    ctx.fillStyle='#e2c165'; ctx.strokeStyle='#b59642'; ctx.lineWidth=2; ctx.fill(p); ctx.stroke(p);
    ctx.strokeStyle='rgba(150,120,50,.6)'; ctx.lineWidth=1; for(let i=-18;i<=18;i+=6){ ctx.beginPath(); ctx.moveTo(i,-10); ctx.lineTo(i,10); ctx.stroke(); }
    ctx.strokeStyle='#8b6a2e'; ctx.lineWidth=2; ctx.beginPath(); ctx.moveTo(-22,-4); ctx.lineTo(22,-4); ctx.moveTo(-22,4); ctx.lineTo(22,4); ctx.stroke();
    ctx.restore();
  }
  function __corn(ctx, sx, sy, size){
    const s=size/18; ctx.save(); ctx.translate(sx,sy); ctx.scale(s,s);
    ctx.strokeStyle='#6b8f3b'; ctx.lineWidth=2.2; ctx.beginPath(); ctx.moveTo(0,10); ctx.lineTo(0,-34); ctx.stroke();
    ctx.strokeStyle='#7aa041'; ctx.lineWidth=1.6;
    [[-14,-10],[14,-8],[-12,-18],[12,-20],[-10,-28]].forEach(([dx,dy])=>{ ctx.beginPath(); ctx.moveTo(0,dy); ctx.quadraticCurveTo(dx,dy-4,dx+(dx>0?-6:6),dy-2); ctx.stroke(); });
    ctx.strokeStyle='#caa64a'; ctx.lineWidth=1.4; for(let i=-2;i<=2;i++){ ctx.beginPath(); ctx.moveTo(0,-36); ctx.lineTo(i*2,-40); ctx.stroke(); }
    ctx.restore();
  }
  function __cornu(ctx, sx, sy, size){
    const s=size/40; ctx.save(); ctx.translate(sx,sy); ctx.scale(s,s);
    ctx.fillStyle='#7a5230'; ctx.beginPath();
    ctx.moveTo(-18,6); ctx.quadraticCurveTo(-30,-2,-10,-12);
    ctx.quadraticCurveTo(10,-20,18,-8); ctx.quadraticCurveTo(10,-6,4,-6); ctx.quadraticCurveTo(-2,-4,-6,0); ctx.lineTo(-18,6); ctx.fill();
    ctx.fillStyle='rgba(0,0,0,.18)'; ctx.beginPath(); ctx.ellipse(-10,-2,8,4,0,0,Math.PI*2); ctx.fill();
    const fruit=(x,y,r,fill)=>{ ctx.fillStyle=fill; ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2); ctx.fill(); };
    fruit(-2,4,4,'#d94c4c'); fruit(6,2,3,'#f0b429'); fruit(-8,2,3,'#8dbf2f');
    ctx.fillStyle='#7e4cc9'; for(let gx=0; gx<3; gx++){ for(let gy=0; gy<2; gy++){ ctx.beginPath(); ctx.arc(10+gx*3,6+gy*3,1.6,0,Math.PI*2); ctx.fill(); } }
    ctx.restore();
  }
  function __wreath(ctx, sx, sy, size){
    const s=size/36; ctx.save(); ctx.translate(sx,sy); ctx.scale(s,s);
    ctx.fillStyle='#2f6a3a'; ctx.beginPath(); ctx.arc(0,0,16,0,Math.PI*2); ctx.arc(0,0,10,0,Math.PI*2,true); ctx.fill();
    ctx.fillStyle='#c02626'; for(let i=0;i<8;i++){ const a=i*(Math.PI/4); ctx.beginPath(); ctx.arc(Math.cos(a)*13,Math.sin(a)*13,2,0,Math.PI*2); ctx.fill(); }
    ctx.fillStyle='#c53030'; ctx.beginPath(); ctx.moveTo(-6,6); ctx.lineTo(0,0); ctx.lineTo(6,6); ctx.lineTo(0,10); ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  // draw décor for a single fence segment using the SAME ctx/scale as fence draw
  function __drawDecorForSeg(ctx, api, seg, scale){
    // Respect invisibility: if the segment was skipped for drawing, skip décor too
    if (seg.b === 'SH' && seg.side === 'W') return;

    const TILE = api.TILE;
    const tag  = __seasonTag();
    const rs   = __rng(tag + (seg.kind==='h'?'H':'V') + (seg.x0||seg.x) + (seg.y0||seg.y));
    const nx   = seg.nx||0, ny=seg.ny||0;

    const len = (seg.kind==='h') ? (seg.x1 - seg.x0) : (seg.y1 - seg.y0);
    if (len <= 0) return;

    // outward offset from fence in world px
    const off = 0.18 * TILE;

    // density per 100 world px (kept modest)
    const per100 = (tag==='halloween') ? 0.45 :
                   (tag==='fall')      ? 0.38 :
                   (tag==='christmas') ? 0.35 :
                   (tag==='winter')    ? 0.30 :
                   (tag==='spring')    ? 0.32 : 0.28;
    const count = Math.max(1, Math.floor((len/100) * per100));

    // size baseline (screen px): derived from api.DRAW so it matches tile rendering
    const leafPX = Math.max(10, 0.22 * api.DRAW);
    const mushPX = Math.max(12, 0.26 * api.DRAW);
    const pumpPX = Math.max(14, 0.30 * api.DRAW);

    // scatter
    for(let i=0;i<count;i++){
      const u = rs();
      let wx, wy;
      if (seg.kind==='h'){ wx = seg.x0 + u*(seg.x1-seg.x0); wy = seg.y; }
      else               { wx = seg.x;  wy = seg.y0 + u*(seg.y1-seg.y0); }

      wx += nx * off; wy += ny * off;

      const sx = (wx - api.camera.x) * scale;
      const sy = (wy - api.camera.y) * scale;

      const r = rs();
      if (tag==='halloween'){
        if      (r < 0.50) __leaf(ctx, sx, sy, leafPX);
        else if (r < 0.72) __pump(ctx, sx, sy, pumpPX, false);
        else if (r < 0.88) __pump(ctx, sx, sy, pumpPX*1.05, true);
        else if (r < 0.95) __web(ctx,  sx, sy, 0.42*api.DRAW);
        else               __light(ctx,sx, sy, 0.20*api.DRAW);
      } else if (tag==='fall'){
        if      (r < 0.65) __leaf(ctx, sx, sy, leafPX);
        else if (r < 0.82) __mush(ctx, sx, sy, mushPX);
        else               __pump(ctx, sx, sy, pumpPX, false);
      } else if (tag==='winter'){
        if (r < 0.6){
          // tiny snow puff
          ctx.fillStyle='rgba(240,248,255,.96)';
          const w=0.34*api.DRAW, h=0.16*api.DRAW;
          ctx.beginPath(); ctx.ellipse(sx, sy, w*0.5, h*0.5, 0, 0, Math.PI*2); ctx.fill();
        } else {
          // twig
          ctx.strokeStyle='rgba(180,180,200,.85)'; ctx.lineWidth=1;
          ctx.beginPath(); ctx.moveTo(sx-6,sy+4); ctx.lineTo(sx+6,sy-4); ctx.stroke();
        }
      } else if (tag==='christmas'){
        if (r < 0.25) __wreath(ctx, sx, sy, 0.44*api.DRAW);
        else          __light(ctx,  sx, sy, 0.18*api.DRAW);
      } else if (tag==='spring'){
        // blossom
        ctx.save(); ctx.fillStyle='#ffd1e8';
        const petals=5, rad=0.18*api.DRAW;
        for(let k=0;k<petals;k++){
          const a=k*(2*Math.PI/petals);
          ctx.beginPath(); ctx.ellipse(sx+Math.cos(a)*5, sy+Math.sin(a)*5, rad*0.16, rad*0.28, a, 0, Math.PI*2); ctx.fill();
        }
        ctx.fillStyle='#ff7aa2'; ctx.beginPath(); ctx.arc(sx,sy,rad*0.12,0,Math.PI*2); ctx.fill(); ctx.restore();
      } else { // summer
        if (r < 0.6){
          // little flower
          ctx.save(); const rad=0.16*api.DRAW; ctx.fillStyle='#ffe48a';
          for(let k=0;k<6;k++){ const a=k*(Math.PI/3); ctx.beginPath(); ctx.ellipse(sx+Math.cos(a)*4.5, sy+Math.sin(a)*4.5, rad*0.14, rad*0.24, a, 0, Math.PI*2); ctx.fill(); }
          ctx.fillStyle='#ff9a00'; ctx.beginPath(); ctx.arc(sx,sy,rad*0.10,0,Math.PI*2); ctx.fill(); ctx.restore();
        } else {
          __leaf(ctx, sx, sy, leafPX*0.9);
        }
      }
    }

    // porch clusters (skip in winter for clean look)
    if (tag==='winter') return;

    function cluster(atU){
      let wx, wy;
      if (seg.kind==='h'){ wx = seg.x0 + atU*(seg.x1-seg.x0); wy = seg.y; }
      else               { wx = seg.x;  wy = seg.y0 + atU*(seg.y1-seg.y0); }
      wx += nx * (off + 0.25*TILE);
      wy += ny * (off + 0.25*TILE);

      const sx = (wx - api.camera.x) * scale;
      const sy = (wy - api.camera.y) * scale;

      const jx = (rs()-0.5), jy=(rs()-0.5);

      if (tag==='christmas'){
        __wreath(ctx, sx, sy, 0.48*api.DRAW);
        for(let i=0;i<3;i++){ __light(ctx, sx + jx*0.40*api.DRAW, sy + jy*0.30*api.DRAW, 0.18*api.DRAW); }
        return;
      }

      // fall / halloween clusters
      __hay (ctx, sx + jx*0.12*api.DRAW, sy + jy*0.10*api.DRAW, 0.64*api.DRAW);
      __corn(ctx, sx - nx*0.10*api.DRAW + jx*0.08*api.DRAW, sy - ny*0.10*api.DRAW + jy*0.08*api.DRAW, 0.68*api.DRAW);
      __pump(ctx, sx + nx*0.12*api.DRAW + jx*0.10*api.DRAW, sy + ny*0.02*api.DRAW + jy*0.06*api.DRAW, 0.48*api.DRAW, false);
      const jack = (tag==='halloween' && rs()<0.6);
      __pump(ctx, sx + nx*0.04*api.DRAW + jx*0.08*api.DRAW, sy - ny*0.04*api.DRAW + jy*0.06*api.DRAW, 0.52*api.DRAW, jack);
      if (tag==='fall' && rs()<0.5) __cornu(ctx, sx + nx*0.06*api.DRAW + jx*0.08*api.DRAW, sy + ny*0.08*api.DRAW + jy*0.08*api.DRAW, 0.54*api.DRAW);

      // leaf sprinkle at base
      for(let i=0;i<3;i++) __leaf(ctx, sx + (rs()-0.5)*0.28*api.DRAW, sy + (rs()-0.5)*0.22*api.DRAW, 0.22*api.DRAW);
    }
    cluster(0.20); cluster(0.50); cluster(0.80);
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

      // NEW: draw seasonal decorations for THIS segment with the SAME ctx/scale
      __drawDecorForSeg(ctx, api, seg, scale);
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
