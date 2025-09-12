/* seasonal_decals.plugin.js — vector sprites on overlay (camera + HiDPI fixed)
   Seasons:
     - Halloween (Sep20–Oct31): leaves, webs, lights, pumpkins + jack faces
     - Fall (Sep–Nov otherwise): leaves, mushrooms, plain pumpkins
     - Winter (Dec–Feb): lights, snow, twigs
     - Spring (Mar–May): blossoms, fresh leaves
     - Summer (Jun–Aug): flowers, leaves
   Uses the same HQ/Shop geometry math as the fence plugin so items hug those fences. */
(function(){
  if (!window.IZZA || typeof IZZA.on !== 'function') return;

  // --- season pick (north hemisphere + Halloween window) ---
  function pickSeason(now=new Date()){
    const m = now.getMonth()+1, d = now.getDate();
    const md = m*100 + d;
    if (md >= 920 && md <= 1031) return 'halloween';
    if (m===12 || m===1 || m===2) return 'winter';
    if (m>=3 && m<=5) return 'spring';
    if (m>=6 && m<=8) return 'summer';
    return 'fall';
  }

  // --- geometry (aligned with fence plugin) ---
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
  function fenceRuns(api){
    const {HQ, SH} = anchors(api);
    const t = api.TILE;
    const out = [];
    function addRectWestEastNorth(rect){
      const {x0,y0,x1,y1} = rect;
      out.push({ kind:'v', x:x0*t,     y0:y0*t,     y1:(y1+1)*t });
      out.push({ kind:'v', x:(x1+1)*t, y0:y0*t,     y1:(y1+1)*t });
      out.push({ kind:'h', y:y0*t,     x0:x0*t,     x1:(x1+1)*t });
    }
    addRectWestEastNorth(HQ);
    addRectWestEastNorth(SH);
    return out;
  }

  // --- overlay canvas (HiDPI-aware) ---
  let overlay=null, ctx=null, ro=null, dpr=1;
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
    overlay.style.zIndex = '4'; // above lighting overlay
    card.appendChild(overlay);
    ctx = overlay.getContext('2d');

    const resize = ()=>{
      const rect = game.getBoundingClientRect();
      dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
      overlay.width  = Math.max(1, Math.round(rect.width  * dpr));
      overlay.height = Math.max(1, Math.round(rect.height * dpr));
      overlay.style.width  = Math.round(rect.width)  + 'px';
      overlay.style.height = Math.round(rect.height) + 'px';
      drawAll(); // redraw
    };
    ro = new ResizeObserver(resize);
    ro.observe(game); resize();
    return true;
  }

  // --- deterministic scatter ---
  function rng(seed){ let s=0; for(let i=0;i<seed.length;i++) s=(s*131+seed.charCodeAt(i))>>>0; return ()=> (s=(1103515245*s+12345)>>>0)/0xffffffff; }

  let CACHE=null; // { tile, season, points:[...] }
  function ensureScatter(api){
    const season = pickSeason();
    if (CACHE && CACHE.tile===api.TILE && CACHE.season===season) return;

    const rs = rng(season+'@'+api.TILE);
    const runs = fenceRuns(api);

    const D = {
      halloween: { per100: 7, kinds:['jack','pumpkin','leaf','leaf','web','light'] },
      fall:      { per100: 5, kinds:['leaf','leaf','leaf','mush','pumpkin'] },
      winter:    { per100: 5, kinds:['light','snow','snow','twig'] },
      spring:    { per100: 4, kinds:['blossom','blossom','leaf'] },
      summer:    { per100: 3, kinds:['flower','leaf'] }
    }[season];

    const points=[];
    function add(x,y,kind){ points.push({x,y,kind,rot:rs()*Math.PI*2,scale:0.85+rs()*0.5}); }

    runs.forEach(seg=>{
      const len = (seg.kind==='h') ? (seg.x1 - seg.x0) : (seg.y1 - seg.y0);
      const n   = Math.max(2, Math.floor((len/100) * D.per100)); // at least 2 per segment
      for(let i=0;i<n;i++){
        const u = rs();
        let x,y;
        if (seg.kind==='h'){ x = seg.x0 + u*(seg.x1-seg.x0); y = seg.y - 10 + rs()*22; }
        else               { x = seg.x  - 10 + rs()*22;      y = seg.y0 + u*(seg.y1-seg.y0); }
        add(x,y, D.kinds[Math.floor(rs()*D.kinds.length)]);
      }
    });

    CACHE = { tile: api.TILE, season, points };
    window.IZZA_SEASONAL = { season, count: points.length };
    console.log('[SEASONAL]', season, 'points:', points.length);
  }

  // --- night helpers (optional) ---
  const isNight  = ()=> !!(window.IZZA_LIGHT && window.IZZA_LIGHT.isNight);
  const nightAmt = ()=> (window.IZZA_LIGHT?.nightLevel || 0);

  // ======== VECTOR SPRITES (Path2D) ========
  const P_LEAF = new Path2D('M0,-18 C10,-10 12,-2 0,14 C-12,-2 -10,-10 0,-18 Z');
  function drawLeaf(){
    ctx.fillStyle = isNight()? '#e07b2a' : '#c96a1b';
    ctx.fill(P_LEAF);
    ctx.strokeStyle='rgba(0,0,0,.28)'; ctx.lineWidth=1.2; ctx.beginPath();
    ctx.moveTo(0,-18); ctx.lineTo(0,14); ctx.stroke();
  }

  const P_MUSH_CAP  = new Path2D('M-16,-6 a16,10 0 1,0 32,0 a16,10 0 1,0 -32,0');
  const P_MUSH_STEM = new Path2D('M-6,-6 h12 v10 h-12 z');
  function drawMush(){
    ctx.fillStyle='#c0392b'; ctx.fill(P_MUSH_CAP);
    ctx.fillStyle='#fff'; ctx.fill(P_MUSH_STEM);
    [ -8, 0, 8 ].forEach(dx=>{ ctx.beginPath(); ctx.arc(dx,-6,2.2,0,Math.PI*2); ctx.fill(); });
  }

  const P_PUMP_CORE = new Path2D('M-14,0 a14,10 0 1,0 28,0 a14,10 0 1,0 -28,0');
  const P_PUMP_L    = new Path2D('M-12,0 a8,10 0 1,0 16,0 a8,10 0 1,0 -16,0');
  const P_PUMP_R    = new Path2D('M-4,0 a8,10 0 1,0 16,0 a8,10 0 1,0 -16,0');
  function drawPumpkin(face){
    ctx.fillStyle='#e66a00'; ctx.fill(P_PUMP_CORE);
    ctx.fillStyle='#ff8a1c'; ctx.fill(P_PUMP_L); ctx.fill(P_PUMP_R);
    ctx.fillStyle='#3d6b2f'; ctx.fillRect(-2,-14,4,6);
    if (face){
      ctx.fillStyle='rgba(0,0,0,0.88)';
      const eyeL = new Path2D('M-8,-3 L-3,-8 L2,-3 Z');
      const eyeR = new Path2D('M8,-3 L3,-8 L-2,-3 Z');
      const mouth= new Path2D('M-8,3 h16 v2 h-16 z');
      ctx.fill(eyeL); ctx.fill(eyeR); ctx.fill(mouth);
    }
    if (isNight()){
      const glow = 0.45 + 0.35*nightAmt();
      const g = ctx.createRadialGradient(0,0,0, 0,0,26);
      g.addColorStop(0, `rgba(255,170,40,${0.40*glow})`);
      g.addColorStop(1, 'rgba(255,170,40,0)');
      const prev = ctx.globalCompositeOperation;
      ctx.globalCompositeOperation='lighter';
      ctx.fillStyle=g; ctx.beginPath(); ctx.arc(0,0,26,0,Math.PI*2); ctx.fill();
      ctx.globalCompositeOperation=prev;
    }
  }

  const P_LIGHT = new Path2D('M0,-8 v-4 m -3,0 h6 M -4,0 a4,6 0 1,0 8,0 a4,6 0 1,0 -8,0');
  function drawLight(){
    if (isNight()){
      const glow = 0.5 + 0.5*nightAmt();
      const g = ctx.createRadialGradient(0,0,0, 0,0,28);
      g.addColorStop(0, `rgba(255,210,63,${0.55*glow})`);
      g.addColorStop(1, 'rgba(255,210,63,0)');
      ctx.fillStyle=g; ctx.beginPath(); ctx.arc(0,0,28,0,Math.PI*2); ctx.fill();
    }
    ctx.fillStyle='#ffd23f'; ctx.fill(P_LIGHT);
    ctx.strokeStyle='#556'; ctx.lineWidth=1.4; ctx.beginPath(); ctx.moveTo(-3,-12); ctx.lineTo(3,-12); ctx.stroke();
  }

  function drawSnow(){
    ctx.fillStyle='rgba(240,248,255,.96)';
    ctx.beginPath(); ctx.ellipse(0,0,16,7,0,0,Math.PI*2); ctx.fill();
  }

  function drawBlossom(){
    ctx.fillStyle='#ffd1e8';
    for(let i=0;i<5;i++){ ctx.rotate(Math.PI*2/5); ctx.beginPath(); ctx.ellipse(0,-7,3,6,0,0,Math.PI*2); ctx.fill(); }
    ctx.fillStyle='#ff7aa2'; ctx.beginPath(); ctx.arc(0,0,2.6,0,Math.PI*2); ctx.fill();
  }
  const drawFlower = drawBlossom;

  function drawWeb(){
    ctx.strokeStyle='rgba(255,255,255,0.8)'; ctx.lineWidth=1.2;
    for(let i=0;i<6;i++){ ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(16,0); ctx.stroke(); ctx.rotate(Math.PI/3); }
    for(let r=5;r<=15;r+=4){ ctx.beginPath(); for(let i=0;i<=6;i++){ const a=i*(Math.PI/3); const nx=Math.cos(a)*r, ny=Math.sin(a)*r; if(i===0) ctx.moveTo(nx,ny); else ctx.lineTo(nx,ny);} ctx.stroke(); }
  }

  function drawTwig(){
    ctx.strokeStyle='rgba(180,180,200,.85)'; ctx.lineWidth=1.6;
    ctx.beginPath(); ctx.moveTo(-8,6); ctx.lineTo(8,-6); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(6,4); ctx.moveTo(-2,-2); ctx.lineTo(-6,-6); ctx.stroke();
  }

  // --- master draw (with camera transform + HiDPI) ---
  function drawAll(){
    if (!ctx || !overlay || !CACHE) return;
    const api = IZZA.api; if(!api?.ready) return;

    // Clear
    ctx.setTransform(1,0,0,1,0,0);
    ctx.clearRect(0,0,overlay.width,overlay.height);

    // World → screen transform:
    // scale = (screen px per world px). api.DRAW is screen px per tile, api.TILE is world px per tile
    const scale = (api.DRAW / api.TILE) * dpr;

    // Camera translation in screen px
    ctx.setTransform(scale, 0, 0, scale, -api.camera.x*scale, -api.camera.y*scale);

    for (const p of CACHE.points){
      const {x,y,scale:s,rot:r,kind} = p;

      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(r);
      ctx.scale(s, s);

      switch(kind){
        case 'leaf':    drawLeaf(); break;
        case 'mush':    drawMush(); break;
        case 'pumpkin': drawPumpkin(false); break;
        case 'jack':    drawPumpkin(true); break;
        case 'light':   drawLight(); break;
        case 'snow':    drawSnow(); break;
        case 'blossom': drawBlossom(); break;
        case 'flower':  drawFlower(); break;
        case 'web':     drawWeb(); break;
        case 'twig':    drawTwig(); break;
      }
      ctx.restore();
    }

    // Reset transform so future clears are safe
    ctx.setTransform(1,0,0,1,0,0);
  }

  // --- boot ---
  IZZA.on('ready', api=>{
    if (!ensureOverlay()) return;
    ensureScatter(api);
    drawAll();

    // repaint after each frame so glow follows night level / camera movement
    IZZA.on('draw-post', drawAll);

    // re-check scatter periodically (tile scale/season changes)
    setInterval(()=>{ ensureScatter(api); }, 60*1000);
  });
})();
