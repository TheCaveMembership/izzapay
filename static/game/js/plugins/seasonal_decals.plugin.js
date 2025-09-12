/* seasonal_decals.plugin.js — visible overlay + season debug
   Fall/Halloween → leaves, pumpkins, jack-o-lanterns
   Winter → lights/snow, Spring → blossoms, Summer → flowers
   Uses its own overlay canvas so it can't be hidden by other draws.
*/
(function(){
  if (!window.IZZA || typeof IZZA.on !== 'function') return;

  // --- season selection (north hemisphere + Halloween window) ---
  function pickSeason(now=new Date()){
    const m = now.getMonth()+1, d = now.getDate();
    const md = m*100 + d;
    if (md >= 920 && md <= 1031) return 'halloween';
    if (m===12 || m===1 || m===2) return 'winter';
    if (m>=3 && m<=5) return 'spring';
    if (m>=6 && m<=8) return 'summer';
    return 'fall';
  }

  // --- geometry (mirrors fence_hq_shop.plugin.js) ---
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

  // --- deterministic scatter so items don't jump every frame ---
  function rng(seed){ let s=0; for(let i=0;i<seed.length;i++) s=(s*131+seed.charCodeAt(i))>>>0; return ()=> (s=(1103515245*s+12345)>>>0)/0xffffffff; }

  // --- overlay canvas above the game ---
  let overlay=null, ctx=null, ro=null;
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
    overlay.style.zIndex = '4'; // above night tint if needed
    card.appendChild(overlay);
    ctx = overlay.getContext('2d');

    const resize = ()=>{
      const rect = game.getBoundingClientRect();
      overlay.width  = Math.max(1, Math.round(game.width  || rect.width));
      overlay.height = Math.max(1, Math.round(game.height || rect.height));
      draw(); // redraw
    };
    ro = new ResizeObserver(resize);
    ro.observe(game); resize();
    return true;
  }

  // --- cache of points per season/tile ---
  let CACHE=null; // { tile, season, points:[...] }
  function ensureScatter(api){
    const season = pickSeason();
    if (CACHE && CACHE.tile===api.TILE && CACHE.season===season) return;

    const rs = rng(season+'@'+api.TILE);
    const runs = fenceRuns(api);
    const DENSITY = {
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
      const n   = Math.max(1, Math.floor((len/100) * DENSITY.per100)); // at least 1
      for(let i=0;i<n;i++){
        const u = rs();
        let x,y;
        if (seg.kind==='h'){ x = seg.x0 + u*(seg.x1-seg.x0); y = seg.y - 10 + rs()*22; }
        else               { x = seg.x  - 10 + rs()*22;      y = seg.y0 + u*(seg.y1-seg.y0); }
        add(x,y, DENSITY.kinds[Math.floor(rs()*DENSITY.kinds.length)]);
      }
    });

    CACHE = { tile: api.TILE, season, points };
    // quick debug you can check in console
    window.IZZA_SEASONAL = { season, count: points.length };
    console.log('[SEASONAL]', season, 'points:', points.length);
  }

  // --- helpers ---
  const isNight  = ()=> !!(window.IZZA_LIGHT && window.IZZA_LIGHT.isNight);
  const nightAmt = ()=> (window.IZZA_LIGHT?.nightLevel || 0); // 0, 0.45, 1

  function drawPumpkin(ctx, x, y, s, r, face=false){
    ctx.save(); ctx.translate(x,y); ctx.rotate(r); ctx.scale(s,s);
    ctx.fillStyle = '#e66a00';
    ctx.beginPath(); ctx.ellipse(0,0,14,10,0,0,Math.PI*2); ctx.fill();
    ctx.fillStyle = '#ff8a1c';
    ctx.beginPath(); ctx.ellipse(-6,0,6,9,0,0,Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(6,0,6,9,0,0,Math.PI*2); ctx.fill();
    ctx.fillStyle = '#3d6b2f'; ctx.fillRect(-2,-12,4,6);
    if (face){
      ctx.fillStyle='rgba(0,0,0,0.85)';
      ctx.beginPath(); ctx.moveTo(-6,-2); ctx.lineTo(-2,-6); ctx.lineTo(2,-2); ctx.fill();
      ctx.beginPath(); ctx.moveTo(6,-2); ctx.lineTo(2,-6); ctx.lineTo(-2,-2); ctx.fill();
      ctx.fillRect(-4,2,8,2);
    }
    if (isNight()){
      const glow = 0.45 + 0.35*nightAmt();
      const g = ctx.createRadialGradient(0,0,0, 0,0,24);
      g.addColorStop(0, `rgba(255,170,40,${0.40*glow})`);
      g.addColorStop(1, 'rgba(255,170,40,0)');
      ctx.globalCompositeOperation='lighter';
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0,0,24,0,Math.PI*2); ctx.fill();
      ctx.globalCompositeOperation='source-over';
    }
    ctx.restore();
  }
  function drawLeaf(ctx, x, y, s, r, tint){
    const color = tint || (isNight() ? '#e07b2a' : '#c96a1b');
    ctx.save(); ctx.translate(x,y); ctx.rotate(r); ctx.scale(s,s);
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.moveTo(0,-7); ctx.quadraticCurveTo(10,-2,0,8); ctx.quadraticCurveTo(-10,-2,0,-7); ctx.fill();
    ctx.strokeStyle='rgba(0,0,0,.25)'; ctx.lineWidth=1; ctx.beginPath(); ctx.moveTo(0,-7); ctx.lineTo(0,8); ctx.stroke();
    ctx.restore();
  }
  function drawLight(ctx, x, y, s, r){
    ctx.save(); ctx.translate(x,y); ctx.rotate(r); ctx.scale(s,s);
    if (isNight()){
      const glow = 0.5 + 0.5*nightAmt();
      const g = ctx.createRadialGradient(0,0,0, 0,0,28);
      g.addColorStop(0, `rgba(255,210,63,${0.55*glow})`);
      g.addColorStop(1, 'rgba(255,210,63,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0,0,28,0,Math.PI*2); ctx.fill();
    }
    ctx.fillStyle='#ffd23f'; ctx.beginPath(); ctx.ellipse(0,0,4,6,0,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#556'; ctx.fillRect(-2,-8,4,3);
    ctx.restore();
  }
  function drawSnow(ctx, x, y, s){ ctx.save(); ctx.translate(x,y); ctx.scale(s,s); ctx.fillStyle='rgba(240,248,255,.95)'; ctx.beginPath(); ctx.ellipse(0,0,14,6,0,0,Math.PI*2); ctx.fill(); ctx.restore(); }
  function drawBlossom(ctx, x, y, s, r){ ctx.save(); ctx.translate(x,y); ctx.rotate(r); ctx.scale(s,s); ctx.fillStyle='#ffd1e8'; for(let i=0;i<5;i++){ ctx.rotate(Math.PI*2/5); ctx.beginPath(); ctx.ellipse(0,-6,3,6,0,0,Math.PI*2); ctx.fill(); } ctx.fillStyle='#ff7aa2'; ctx.beginPath(); ctx.arc(0,0,2.5,0,Math.PI*2); ctx.fill(); ctx.restore(); }
  const drawFlower = drawBlossom;

  function drawAll(){
    if (!ctx || !overlay || !CACHE) return;
    const w=overlay.width, h=overlay.height;
    ctx.clearRect(0,0,w,h);

    const pts = CACHE.points;
    for (const p of pts){
      const {x,y,scale:s,rot:r,kind} = p;
      if (kind==='leaf')     drawLeaf(ctx,x,y,s,r);
      else if (kind==='mush'){ ctx.save(); ctx.translate(x,y); ctx.scale(s,s);
        ctx.fillStyle='#c0392b'; ctx.beginPath(); ctx.ellipse(0,-6,8,6,0,0,Math.PI*2); ctx.fill();
        ctx.fillStyle='#fff';    ctx.beginPath(); ctx.arc(-4,-6,1.5,0,Math.PI*2); ctx.fill();
        ctx.beginPath(); ctx.arc(0,-6,1.2,0,Math.PI*2); ctx.fill();
        ctx.beginPath(); ctx.arc(4,-6,1.4,0,Math.PI*2); ctx.fill(); ctx.restore();
      }
      else if (kind==='light')   drawLight(ctx,x,y,s,r);
      else if (kind==='snow')    drawSnow(ctx,x,y,s);
      else if (kind==='blossom') drawBlossom(ctx,x,y,s,r);
      else if (kind==='flower')  drawFlower(ctx,x,y,s,r);
      else if (kind==='pumpkin') drawPumpkin(ctx,x,y,s,r,false);
      else if (kind==='jack')    drawPumpkin(ctx,x,y,s,r,true);
      else if (kind==='web'){ ctx.save(); ctx.translate(x,y); ctx.rotate(r); ctx.scale(s,s);
        ctx.strokeStyle='rgba(255,255,255,0.7)'; ctx.lineWidth=1;
        for(let i=0;i<6;i++){ ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(14,0); ctx.stroke(); ctx.rotate(Math.PI/3); }
        for(let r2=4;r2<=12;r2+=4){ ctx.beginPath(); for(let i=0;i<=6;i++){ const a=i*(Math.PI/3); const nx=Math.cos(a)*r2, ny=Math.sin(a)*r2; if(i===0) ctx.moveTo(nx,ny); else ctx.lineTo(nx,ny);} ctx.stroke(); }
        ctx.restore();
      }
    }
  }

  IZZA.on('ready', api=>{
    if (!ensureOverlay()) return;
    ensureScatter(api);
    drawAll();

    // repaint each frame (cheap) so glow follows night level changes
    IZZA.on('draw-post', drawAll);

    // if tile scale or season changes (e.g., next month), rebuild
    setInterval(()=>{ ensureScatter(api); }, 60*1000);
  });
})();
