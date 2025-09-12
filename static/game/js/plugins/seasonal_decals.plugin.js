/* seasonal_decals.plugin.js — fall décor (independent, with debug)
   - Pure vector sprites (canvas/Path2D), no images, no lighting dependency.
   - Correct world→screen placement (camera & HiDPI aware).
   - Includes DEBUG guides to verify drawing + fence anchors.
*/
(function(){
  if (!window.IZZA || typeof IZZA.on !== 'function') return;

  // --- Debug switch (set false once you see stuff) ---
  let DEBUG = true;        // draws magenta fence guides + a cyan self-test cross
  const DBG = (...a)=>{ try{ if(DEBUG) console.log('[SEASONAL]', ...a);}catch{} };

  // --- Season logic (North Hemisphere + Halloween window) ---
  function pickSeason(now=new Date()){
    const m = now.getMonth()+1, d = now.getDate();
    const md = m*100 + d;
    if (md >= 920 && md <= 1031) return 'halloween';
    if (m===12 || m===1 || m===2) return 'winter';
    if (m>=3 && m<=5) return 'spring';
    if (m>=6 && m<=8) return 'summer';
    return 'fall';
  }

  // --- Fence geometry (mirrors your fence plugin) ---
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
  function fenceSegments(api){
    const {HQ, SH} = anchors(api);
    const t = api.TILE;
    const segs = [];
    function addRect(rect){
      const {x0,y0,x1,y1} = rect;
      segs.push({kind:'h', x0:x0*t, x1:(x1+1)*t, y:y0*t,      nx:0,  ny:-1}); // north
      segs.push({kind:'h', x0:x0*t, x1:(x1+1)*t, y:(y1+1)*t,  nx:0,  ny:1});  // south
      segs.push({kind:'v', x:x0*t,  y0:y0*t, y1:(y1+1)*t,     nx:-1, ny:0});  // west
      segs.push({kind:'v', x:(x1+1)*t, y0:y0*t, y1:(y1+1)*t,  nx:1,  ny:0});  // east
    }
    addRect(HQ); addRect(SH);
    return segs;
  }

  // --- Overlay canvas (HiDPI) ---
  let overlay=null, ctx=null, ro=null, dpr=1, w2s=1;
  function ensureOverlay(){
    if (overlay && ctx) return true;
    const card = document.getElementById('gameCard');
    const game = document.getElementById('game');
    if(!card||!game) return false;
    overlay = document.createElement('canvas');
    overlay.id = 'izzaSeasonOverlay';
    overlay.style.position = 'absolute';
    overlay.style.inset = '10px 10px 10px 10px';
    overlay.style.pointerEvents = 'none';
    overlay.style.borderRadius = getComputedStyle(game).borderRadius || '12px';
    overlay.style.zIndex = '4';
    card.appendChild(overlay);
    ctx = overlay.getContext('2d');
    const resize = ()=>{
      const rect = game.getBoundingClientRect();
      dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
      overlay.width  = Math.max(1, Math.round(rect.width  * dpr));
      overlay.height = Math.max(1, Math.round(rect.height * dpr));
      overlay.style.width  = Math.round(rect.width)  + 'px';
      overlay.style.height = Math.round(rect.height) + 'px';
      drawAll();
    };
    ro = new ResizeObserver(resize);
    ro.observe(game); resize();
    return true;
  }
  function updateScalars(api){ w2s = (api.DRAW / api.TILE); }
  function toCanvasPx(api, wx, wy){
    const sx = (wx - api.camera.x) * w2s * dpr;
    const sy = (wy - api.camera.y) * w2s * dpr;
    return [sx, sy];
  }

  // --- RNG ---
  function rng(seed){ let s=0; for(let i=0;i<seed.length;i++) s=(s*131+seed.charCodeAt(i))>>>0; return ()=> (s=(1103515245*s+12345)>>>0)/0xffffffff; }

  // --- Vector sprites (Path2D + primitives) ---
  // NOTE: Avoid roundRect for older engines; use manual rounded rect.
  function rrectPath(x,y,w,h,r){
    const p = new Path2D();
    const rr = Math.max(0, Math.min(r, Math.min(Math.abs(w), Math.abs(h))/2));
    p.moveTo(x+rr, y);
    p.lineTo(x+w-rr, y);
    p.arcTo(x+w, y, x+w, y+rr, rr);
    p.lineTo(x+w, y+h-rr);
    p.arcTo(x+w, y+h, x+w-rr, y+h, rr);
    p.lineTo(x+rr, y+h);
    p.arcTo(x, y+h, x, y+h-rr, rr);
    p.lineTo(x, y+rr);
    p.arcTo(x, y, x+rr, y, rr);
    p.closePath();
    return p;
  }

  const P_LEAF = new Path2D('M0,-18 C10,-10 12,-2 0,14 C-12,-2 -10,-10 0,-18 Z');
  function drawLeaf(px){
    const s = px / 24;
    ctx.save(); ctx.scale(s,s);
    ctx.fillStyle = '#c96a1b';
    ctx.fill(P_LEAF);
    ctx.strokeStyle='rgba(0,0,0,.28)'; ctx.lineWidth=1.2; ctx.beginPath();
    ctx.moveTo(0,-18); ctx.lineTo(0,14); ctx.stroke();
    ctx.restore();
  }

  function drawMush(px){
    const s = px / 32;
    ctx.save(); ctx.scale(s,s);
    ctx.fillStyle='#c0392b'; ctx.beginPath(); ctx.ellipse(0,-6,16,10,0,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#fff'; ctx.fillRect(-6,-6,12,10);
    [ -8, 0, 8 ].forEach(dx=>{ ctx.beginPath(); ctx.arc(dx,-6,2.2,0,Math.PI*2); ctx.fill(); });
    ctx.restore();
  }

  function drawPumpkin(px, face){
    const s = px / 28;
    ctx.save(); ctx.scale(s,s);
    ctx.fillStyle='#e66a00'; ctx.beginPath(); ctx.ellipse(0,0,14,10,0,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#ff8a1c'; ctx.beginPath(); ctx.ellipse(-6,0,8,10,0,0,Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(6,0,8,10,0,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#3d6b2f'; ctx.fillRect(-2,-14,4,6);
    if (face){
      ctx.fillStyle='rgba(0,0,0,0.88)';
      ctx.beginPath(); ctx.moveTo(-8,-3); ctx.lineTo(-3,-8); ctx.lineTo(2,-3); ctx.fill();
      ctx.beginPath(); ctx.moveTo(8,-3); ctx.lineTo(3,-8); ctx.lineTo(-2,-3); ctx.fill();
      ctx.fillRect(-8,3,16,2);
    }
    ctx.restore();
  }

  function drawLight(px){
    const s = px / 12;
    ctx.save(); ctx.scale(s,s);
    ctx.fillStyle='#ffd23f'; ctx.beginPath(); ctx.ellipse(0,0,4,6,0,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#556'; ctx.fillRect(-2,-8,4,3);
    ctx.beginPath(); ctx.moveTo(-3,-12); ctx.lineTo(3,-12);
    ctx.strokeStyle='#556'; ctx.lineWidth=1.2; ctx.stroke();
    ctx.restore();
  }

  function drawWeb(px){
    const s = px / 32;
    ctx.save(); ctx.scale(s,s);
    ctx.strokeStyle='rgba(255,255,255,0.8)'; ctx.lineWidth=1.1;
    for(let i=0;i<6;i++){ ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(16,0); ctx.stroke(); ctx.rotate(Math.PI/3); }
    for(let r=5;r<=15;r+=4){ ctx.beginPath(); for(let i=0;i<=6;i++){ const a=i*(Math.PI/3); const nx=Math.cos(a)*r, ny=Math.sin(a)*r; if(i===0) ctx.moveTo(nx,ny); else ctx.lineTo(nx,ny);} ctx.stroke(); }
    ctx.restore();
  }

  function drawSnow(px){
    const s = px / 32;
    ctx.save(); ctx.scale(s,s);
    ctx.fillStyle='rgba(240,248,255,.96)'; ctx.beginPath(); ctx.ellipse(0,0,16,7,0,0,Math.PI*2); ctx.fill();
    ctx.restore();
  }

  // NEW: Corn stalk, Hay bale, Cornucopia (fall vibes)
  function drawCorn(px){
    const s = px / 18;
    ctx.save(); ctx.scale(s,s);
    ctx.strokeStyle='#6b8f3b'; ctx.lineWidth=2.2; ctx.beginPath(); ctx.moveTo(0,10); ctx.lineTo(0,-34); ctx.stroke();
    ctx.strokeStyle='#7aa041'; ctx.lineWidth=1.6;
    [[-14,-10],[14,-8],[-12,-18],[12,-20],[-10,-28]].forEach(([dx,dy])=>{
      ctx.beginPath(); ctx.moveTo(0,dy); ctx.quadraticCurveTo(dx,dy-4,dx+(dx>0?-6:6),dy-2); ctx.stroke();
    });
    ctx.strokeStyle='#caa64a'; ctx.lineWidth=1.4;
    for(let i=-2;i<=2;i++){ ctx.beginPath(); ctx.moveTo(0,-36); ctx.lineTo(i*2,-40); ctx.stroke(); }
    ctx.restore();
  }

  function drawHay(px){
    const s = px / 44;
    ctx.save(); ctx.scale(s,s);
    const p = rrectPath(-22,-12,44,24,4);
    ctx.fillStyle='#e2c165'; ctx.strokeStyle='#b59642'; ctx.lineWidth=2; ctx.fill(p); ctx.stroke(p);
    ctx.strokeStyle='rgba(150,120,50,.6)'; ctx.lineWidth=1;
    for(let i=-18;i<=18;i+=6){ ctx.beginPath(); ctx.moveTo(i,-10); ctx.lineTo(i,10); ctx.stroke(); }
    ctx.strokeStyle='#8b6a2e'; ctx.lineWidth=2;
    ctx.beginPath(); ctx.moveTo(-22,-4); ctx.lineTo(22,-4); ctx.moveTo(-22,4); ctx.lineTo(22,4); ctx.stroke();
    ctx.restore();
  }

  function drawCornucopia(px){
    const s = px / 40;
    ctx.save(); ctx.scale(s,s);
    ctx.fillStyle='#7a5230';
    ctx.beginPath();
    ctx.moveTo(-18,6); ctx.quadraticCurveTo(-30,-2,-10,-12);
    ctx.quadraticCurveTo(10,-20,18,-8);
    ctx.quadraticCurveTo(10,-6,4,-6); ctx.quadraticCurveTo(-2,-4,-6,0); ctx.lineTo(-18,6); ctx.fill();
    ctx.fillStyle='rgba(0,0,0,.18)'; ctx.beginPath(); ctx.ellipse(-10,-2,8,4,0,0,Math.PI*2); ctx.fill();
    const fruit=(x,y,r,fill)=>{ ctx.fillStyle=fill; ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2); ctx.fill(); };
    fruit(-2,4,4,'#d94c4c'); fruit(6,2,3,'#f0b429'); fruit(-8,2,3,'#8dbf2f');
    ctx.fillStyle='#7e4cc9'; for(let gx=0; gx<3; gx++){ for(let gy=0; gy<2; gy++){ ctx.beginPath(); ctx.arc(10+gx*3,6+gy*3,1.6,0,Math.PI*2); ctx.fill(); } }
    ctx.restore();
  }

  // --- Item drawing switch ---
  function drawSprite(kind, px){
    switch(kind){
      case 'leaf':       drawLeaf(px); break;
      case 'mush':       drawMush(px); break;
      case 'pumpkin':    drawPumpkin(px, false); break;
      case 'jack':       drawPumpkin(px, true); break;
      case 'light':      drawLight(px); break;
      case 'web':        drawWeb(px); break;
      case 'snow':       drawSnow(px); break;
      case 'hay':        drawHay(px); break;
      case 'corn':       drawCorn(px); break;
      case 'cornucopia': drawCornucopia(px); break;
    }
  }

  // --- Scatter + clusters ---
  let CACHE=null; // { tile, season, items:[{x,y,rot,kind,px}] }
  function ensureScatter(api){
    const season = pickSeason();
    if (CACHE && CACHE.tile===api.TILE && CACHE.season===season) return;

    updateScalars(api);
    const rs = rng(season+'@'+api.TILE);
    const segs = fenceSegments(api);
    const items = [];

    function scatterAlong(seg, per100){
      const len = (seg.kind==='h') ? (seg.x1 - seg.x0) : (seg.y1 - seg.y0);
      const n   = Math.max(2, Math.floor((len/100) * per100));
      for (let i=0;i<n;i++){
        const u = rs();
        let x, y;
        if (seg.kind==='h'){ x = seg.x0 + u*(seg.x1 - seg.x0); y = seg.y; }
        else               { x = seg.x; y = seg.y0 + u*(seg.y1 - seg.y0); }
        const off = 8 + rs()*6; // outward offset from fence
        x += seg.nx * off; y += seg.ny * off;

        const roll = rs();
        if (season==='halloween'){
          if (roll < 0.50) items.push({x,y,rot:rs()*Math.PI*2,kind:'leaf',px:16+rs()*6});
          else if (roll < 0.70) items.push({x,y,rot:(rs()-0.5)*0.2,kind:'pumpkin',px:24+rs()*6});
          else if (roll < 0.85) items.push({x,y,rot:(rs()-0.5)*0.2,kind:'jack',px:26+rs()*8});
          else if (roll < 0.93) items.push({x,y,rot:rs()*Math.PI*2,kind:'web',px:22+rs()*10});
          else items.push({x,y,rot:rs()*Math.PI*2,kind:'light',px:12+rs()*4});
        } else if (season==='fall'){
          if (roll < 0.65) items.push({x,y,rot:rs()*Math.PI*2,kind:'leaf',px:14+rs()*6});
          else if (roll < 0.82) items.push({x,y,rot:(rs()-0.5)*0.5,kind:'mush',px:18+rs()*4});
          else items.push({x,y,rot:(rs()-0.5)*0.2,kind:'pumpkin',px:22+rs()*6});
        }
      }
    }

    function placeClusterAt(x, y, nx, ny){
      const base = 12; // world px outward from fence
      const bx = x + nx*base;
      const by = y + ny*base;
      const jitter = (a)=> (a * (rs()-0.5));

      // hay bale + corn stalk + pumpkins + (cornucopia sometimes)
      items.push({ x: bx + jitter(6), y: by + jitter(6),    rot: jitter(0.2), kind:'hay',        px: 42 });
      items.push({ x: bx - nx*6 + jitter(4), y: by - ny*6 + jitter(4), rot: Math.PI + jitter(0.2), kind:'corn',       px: 44 });
      items.push({ x: bx + nx*8 + jitter(4), y: by + ny*2 + jitter(3), rot: jitter(0.2), kind:'pumpkin',   px: 24 + rs()*4 });
      items.push({ x: bx + nx*3 + jitter(4), y: by - ny*3 + jitter(3), rot: jitter(0.2), kind: (season==='halloween'?'jack':'pumpkin'), px: 26 + rs()*6 });

      if (season==='fall' && rs()<0.6){
        items.push({ x: bx + nx*4 + jitter(4), y: by + ny*6 + jitter(4), rot: jitter(0.4), kind:'cornucopia', px: 34 });
      }
      for(let i=0;i<3;i++){
        items.push({ x: bx + jitter(12), y: by + jitter(10), rot: rs()*Math.PI*2, kind:'leaf', px: 14 + rs()*6 });
      }
    }

    const per100 = (season==='fall') ? 3.5 : (season==='halloween' ? 4.0 : 2.5);
    for (const seg of segs){
      scatterAlong(seg, per100);
      // three clusters per edge
      if (seg.kind==='h'){
        const L = seg.x1 - seg.x0, y = seg.y;
        placeClusterAt(seg.x0 + L*0.25, y, seg.nx, seg.ny);
        placeClusterAt(seg.x0 + L*0.50, y, seg.nx, seg.ny);
        placeClusterAt(seg.x0 + L*0.75, y, seg.nx, seg.ny);
      } else {
        const L = seg.y1 - seg.y0, x = seg.x;
        placeClusterAt(x, seg.y0 + L*0.25, seg.nx, seg.ny);
        placeClusterAt(x, seg.y0 + L*0.50, seg.nx, seg.ny);
        placeClusterAt(x, seg.y0 + L*0.75, seg.nx, seg.ny);
      }
    }

    CACHE = { tile: api.TILE, season, items };
    window.IZZA_SEASONAL = { season, count: items.length };
    DBG(season, 'items:', items.length);
  }

  // --- Draw (with debug guides) ---
  function drawDebugGuides(api){
    if (!DEBUG) return;
    // cyan self-test cross (proves overlay is visible)
    ctx.save();
    ctx.strokeStyle='cyan'; ctx.lineWidth=2;
    ctx.beginPath(); ctx.moveTo(10*dpr,10*dpr); ctx.lineTo(30*dpr,10*dpr); ctx.moveTo(10*dpr,10*dpr); ctx.lineTo(10*dpr,30*dpr); ctx.stroke();
    ctx.restore();

    // magenta fence outlines
    const segs = fenceSegments(api);
    ctx.save(); ctx.strokeStyle='magenta'; ctx.lineWidth=1.5;
    for (const seg of segs){
      const a = (seg.kind==='h')
        ? toCanvasPx(api, seg.x0, seg.y)
        : toCanvasPx(api, seg.x, seg.y0);
      const b = (seg.kind==='h')
        ? toCanvasPx(api, seg.x1, seg.y)
        : toCanvasPx(api, seg.x, seg.y1);
      ctx.beginPath(); ctx.moveTo(a[0],a[1]); ctx.lineTo(b[0],b[1]); ctx.stroke();
    }
    ctx.restore();
  }

  function drawAll(){
    if (!ctx || !overlay || !CACHE) return;
    const api = IZZA.api; if(!api?.ready) return;

    ctx.setTransform(1,0,0,1,0,0);
    ctx.clearRect(0,0,overlay.width,overlay.height);

    // Debug guides first (so décor draws over them)
    drawDebugGuides(api);

    for (const it of CACHE.items){
      const [sx, sy] = toCanvasPx(api, it.x, it.y);
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(it.rot||0);
      drawSprite(it.kind, (it.px||24) * dpr);
      ctx.restore();
    }

    // If nothing at all, show a red hint
    if (CACHE.items.length===0 && DEBUG){
      ctx.fillStyle='red'; ctx.font = `${12*dpr}px sans-serif`;
      ctx.fillText('No seasonal items generated', 40*dpr, 24*dpr);
    }
  }

  // --- Boot ---
  IZZA.on('ready', api=>{
    if (!ensureOverlay()) return;
    ensureScatter(api);
    drawAll();
    IZZA.on('draw-post', drawAll);
    setInterval(()=>{ ensureScatter(api); }, 60*1000);
  });

  // Quick keyboard toggle for debug (press F)
  document.addEventListener('keydown', e=>{
    if (e.key.toLowerCase()==='f'){
      DEBUG = !DEBUG; DBG('DEBUG =', DEBUG); drawAll();
    }
  }, {passive:true});
})();
