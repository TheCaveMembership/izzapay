/* seasonal_decals.plugin.js — classy fall porch clusters (vector sprites, right-sized, right-placed)
   WHAT YOU GET IN EARLY FALL (before Sep 20):
     • Leaves sprinkled along fence lines
     • Small pumpkins + mushrooms
     • Two or three "porch clusters": hay bale + pumpkins + tall corn stalks, optional cornucopia
   HALLOWEEN WINDOW (Sep 20–Oct 31):
     • Jack-o'-lantern versions + a few webs and string lights added
   NOTES
     • Everything is SVG Path2D / canvas vectors (no assets).
     • Correct world→screen placement with camera & HiDPI handled.
     • Sizes are specified in screen pixels, then converted precisely.
*/
(function(){
  if (!window.IZZA || typeof IZZA.on !== 'function') return;

  // ---------- season pick ----------
  function pickSeason(now=new Date()){
    const m = now.getMonth()+1, d = now.getDate();
    const md = m*100 + d;
    if (md >= 920 && md <= 1031) return 'halloween';
    if (m===12 || m===1 || m===2) return 'winter';
    if (m>=3 && m<=5) return 'spring';
    if (m>=6 && m<=8) return 'summer';
    return 'fall';
  }

  // ---------- geometry (aligned with your fence plugin) ----------
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
      // NORTH edge (top fence)
      segs.push({kind:'h', x0:x0*t, x1:(x1+1)*t, y:y0*t,   nx:0, ny:-1});
      // SOUTH edge (bottom fence)
      segs.push({kind:'h', x0:x0*t, x1:(x1+1)*t, y:(y1+1)*t, nx:0, ny:1});
      // WEST edge
      segs.push({kind:'v', x:x0*t,   y0:y0*t, y1:(y1+1)*t, nx:-1, ny:0});
      // EAST edge
      segs.push({kind:'v', x:(x1+1)*t, y0:y0*t, y1:(y1+1)*t, nx:1, ny:0});
    }
    addRect(HQ);
    addRect(SH);
    return segs;
  }

  // ---------- overlay (HiDPI) ----------
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
    overlay.style.zIndex = '4'; // above lighting
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

  // world→screen scalar (CSS px per world px)
  function updateScalars(api){
    w2s = (api.DRAW / api.TILE);
  }

  // ---------- deterministic rng ----------
  function rng(seed){ let s=0; for(let i=0;i<seed.length;i++) s=(s*131+seed.charCodeAt(i))>>>0; return ()=> (s=(1103515245*s+12345)>>>0)/0xffffffff; }

  // ---------- sprite defs (natural unit widths) ----------
  // Each drawXXX is authored at a "natural width" in units. We scale to desired screen px.
  const SPRITES = {
    leaf:       { naturalW: 24, draw(){ // maple-ish
      ctx.fillStyle = isNight()? '#e07b2a' : '#c96a1b';
      ctx.beginPath();
      ctx.moveTo(0,-18); ctx.bezierCurveTo(10,-10,12,-2,0,14); ctx.bezierCurveTo(-12,-2,-10,-10,0,-18);
      ctx.fill();
      ctx.strokeStyle='rgba(0,0,0,.28)'; ctx.lineWidth=1.2; ctx.beginPath();
      ctx.moveTo(0,-18); ctx.lineTo(0,14); ctx.stroke();
    }},
    mush:       { naturalW: 32, draw(){
      // cap
      ctx.fillStyle='#c0392b'; ctx.beginPath(); ctx.ellipse(0,-6,16,10,0,0,Math.PI*2); ctx.fill();
      // stem + dots
      ctx.fillStyle='#fff'; ctx.fillRect(-6,-6,12,10);
      [ -8, 0, 8 ].forEach(dx=>{ ctx.beginPath(); ctx.arc(dx,-6,2.2,0,Math.PI*2); ctx.fill(); });
    }},
    pumpkin:    { naturalW: 28, draw(face){
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
    }},
    light:      { naturalW: 12, draw(){
      if (isNight()){
        const glow = 0.5 + 0.5*nightAmt();
        const g = ctx.createRadialGradient(0,0,0, 0,0,22);
        g.addColorStop(0, `rgba(255,210,63,${0.55*glow})`);
        g.addColorStop(1, 'rgba(255,210,63,0)');
        ctx.fillStyle=g; ctx.beginPath(); ctx.arc(0,0,22,0,Math.PI*2); ctx.fill();
      }
      ctx.fillStyle='#ffd23f'; ctx.beginPath(); ctx.ellipse(0,0,4,6,0,0,Math.PI*2); ctx.fill();
      ctx.fillStyle='#556'; ctx.fillRect(-2,-8,4,3);
      ctx.beginPath(); ctx.moveTo(-3,-12); ctx.lineTo(3,-12); ctx.strokeStyle='#556'; ctx.lineWidth=1.2; ctx.stroke();
    }},
    web:        { naturalW: 32, draw(){
      ctx.strokeStyle='rgba(255,255,255,0.8)'; ctx.lineWidth=1.1;
      for(let i=0;i<6;i++){ ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(16,0); ctx.stroke(); ctx.rotate(Math.PI/3); }
      for(let r=5;r<=15;r+=4){ ctx.beginPath(); for(let i=0;i<=6;i++){ const a=i*(Math.PI/3); const nx=Math.cos(a)*r, ny=Math.sin(a)*r; if(i===0) ctx.moveTo(nx,ny); else ctx.lineTo(nx,ny);} ctx.stroke(); }
    }},
    snow:       { naturalW: 32, draw(){ ctx.fillStyle='rgba(240,248,255,.96)'; ctx.beginPath(); ctx.ellipse(0,0,16,7,0,0,Math.PI*2); ctx.fill(); }},
    blossom:    { naturalW: 20, draw(){
      ctx.fillStyle='#ffd1e8';
      for(let i=0;i<5;i++){ ctx.rotate(Math.PI*2/5); ctx.beginPath(); ctx.ellipse(0,-7,3,6,0,0,Math.PI*2); ctx.fill(); }
      ctx.fillStyle='#ff7aa2'; ctx.beginPath(); ctx.arc(0,0,2.6,0,Math.PI*2); ctx.fill();
    }},
    // NEW — Corn stalk (tall, rustic)
    corn:       { naturalW: 18, draw(){
      ctx.strokeStyle='#6b8f3b'; ctx.lineWidth=2.2; // stalk
      ctx.beginPath(); ctx.moveTo(0,10); ctx.lineTo(0,-34); ctx.stroke();
      ctx.strokeStyle='#7aa041'; ctx.lineWidth=1.6;
      // leaves
      [[-14,-10],[14,-8],[-12,-18],[12,-20],[-10,-28]].forEach(([dx,dy])=>{
        ctx.beginPath(); ctx.moveTo(0,dy); ctx.quadraticCurveTo(dx,dy-4,dx+ (dx>0?-6:6),dy-2); ctx.stroke();
      });
      // tassel
      ctx.strokeStyle='#caa64a'; ctx.lineWidth=1.4;
      for(let i=-2;i<=2;i++){
        ctx.beginPath(); ctx.moveTo(0,-36); ctx.lineTo(i*2,-40); ctx.stroke();
      }
    }},
    // NEW — Hay bale (rectangular with twine)
    hay:        { naturalW: 44, draw(){
      ctx.fillStyle='#e2c165'; ctx.strokeStyle='#b59642'; ctx.lineWidth=2;
      ctx.beginPath(); ctx.roundRect(-22,-12,44,24,4); ctx.fill(); ctx.stroke();
      // straw texture
      ctx.strokeStyle='rgba(150,120,50,.6)'; ctx.lineWidth=1;
      for(let i=-18;i<=18;i+=6){ ctx.beginPath(); ctx.moveTo(i,-10); ctx.lineTo(i,10); ctx.stroke(); }
      // twine
      ctx.strokeStyle='#8b6a2e'; ctx.lineWidth=2;
      ctx.beginPath(); ctx.moveTo(-22,-4); ctx.lineTo(22,-4); ctx.moveTo(-22,4); ctx.lineTo(22,4); ctx.stroke();
    }},
    // NEW — Cornucopia (horn + fruits)
    cornucopia: { naturalW: 40, draw(){
      // horn
      ctx.fillStyle='#7a5230';
      ctx.beginPath();
      ctx.moveTo(-18,6); ctx.quadraticCurveTo(-30,-2,-10,-12);
      ctx.quadraticCurveTo(10,-20,18,-8);
      ctx.quadraticCurveTo(10,-6,4,-6); ctx.quadraticCurveTo(-2,-4,-6,0); ctx.lineTo(-18,6); ctx.fill();
      // rim shade
      ctx.fillStyle='rgba(0,0,0,.18)'; ctx.beginPath(); ctx.ellipse(-10,-2,8,4,0,0,Math.PI*2); ctx.fill();
      // fruit
      const fruit=(x,y,r,fill)=>{ ctx.fillStyle=fill; ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2); ctx.fill(); };
      fruit(-2,4,4,'#d94c4c'); // apple
      fruit(6,2,3,'#f0b429');  // orange gourd
      fruit(-8,2,3,'#8dbf2f'); // green
      // grape bunch
      ctx.fillStyle='#7e4cc9'; for(let gx=0; gx<3; gx++){ for(let gy=0; gy<2; gy++){ ctx.beginPath(); ctx.arc(10+gx*3,6+gy*3,1.6,0,Math.PI*2); ctx.fill(); } }
    }},
    twig:       { naturalW: 24, draw(){
      ctx.strokeStyle='rgba(180,180,200,.85)'; ctx.lineWidth=1.6;
      ctx.beginPath(); ctx.moveTo(-8,6); ctx.lineTo(8,-6); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(6,4); ctx.moveTo(-2,-2); ctx.lineTo(-6,-6); ctx.stroke();
    }},
    flower:     { naturalW: 20, draw(){ SPRITES.blossom.draw(); } }
  };

  // night helpers (optional)
  const isNight  = ()=> !!(window.IZZA_LIGHT && window.IZZA_LIGHT.isNight);
  const nightAmt = ()=> (window.IZZA_LIGHT?.nightLevel || 0);

  // ---------- scatter + "porch clusters" ----------
  let CACHE=null; // { tile, season, items:[{x,y,kind,rot,px}] }
  function ensureScatter(api){
    const season = pickSeason();
    if (CACHE && CACHE.tile===api.TILE && CACHE.season===season) return;

    updateScalars(api);
    const rs = rng(season+'@'+api.TILE);
    const segs = fenceSegments(api);
    const items = [];

    // Small scatter along edges (leaves, small pumpkins, mushrooms)
    function scatterAlong(seg, per100){
      const len = (seg.kind==='h') ? (seg.x1 - seg.x0) : (seg.y1 - seg.y0);
      const n   = Math.max(2, Math.floor((len/100) * per100));
      for (let i=0;i<n;i++){
        const u = rs();
        let x, y;
        if (seg.kind==='h'){ x = seg.x0 + u*(seg.x1 - seg.x0); y = seg.y; }
        else               { x = seg.x; y = seg.y0 + u*(seg.y1 - seg.y0); }
        // offset outward from fence using segment normal (nx,ny), ~8 world px
        const off = 8 + rs()*6;
        x += seg.nx * off; y += seg.ny * off;

        const roll = rs();
        if (season==='fall'){
          if (roll < 0.65) items.push({x,y,kind:'leaf',rot:rs()*Math.PI*2,px: 14 + rs()*6});
          else if (roll < 0.82) items.push({x,y,kind:'mush',rot:(rs()-0.5)*0.5,px: 18 + rs()*4});
          else items.push({x,y,kind:'pumpkin',rot:(rs()-0.5)*0.2,px: 22 + rs()*6});
        } else if (season==='halloween'){
          if (roll < 0.50) items.push({x,y,kind:'leaf',rot:rs()*Math.PI*2,px: 14 + rs()*6});
          else if (roll < 0.70) items.push({x,y,kind:'pumpkin',rot:(rs()-0.5)*0.2,px: 24 + rs()*8});
          else if (roll < 0.85) items.push({x,y,kind:'jack',rot:(rs()-0.5)*0.2,px: 26 + rs()*8});
          else if (roll < 0.93) items.push({x,y,kind:'web',rot:rs()*Math.PI*2,px: 22 + rs()*10});
          else items.push({x,y,kind:'light',rot:rs()*Math.PI*2,px: 12 + rs()*4});
        }
      }
    }

    // Porch clusters: place 2–3 per property — near midpoints and corners
    function placeClusterAt(x, y, nx, ny){
      // base position sits a bit off the fence into the sidewalk (outward normal)
      const baseOff = 12; // world px
      const bx = x + nx*baseOff;
      const by = y + ny*baseOff;

      const angle = Math.atan2(ny, nx); // facing outward
      const jitter = (a)=> (a * (rs()-0.5));

      // main hay bale
      items.push({ x: bx + jitter(6), y: by + jitter(6), kind:'hay', rot: angle + jitter(0.2), px: 44 });

      // tall corn stalk behind hay
      items.push({ x: bx - nx*6 + jitter(4), y: by - ny*6 + jitter(4), kind:'corn', rot: angle + Math.PI + jitter(0.2), px: 46 });

      // pumpkins around
      items.push({ x: bx + nx*8 + jitter(4), y: by + ny*2 + jitter(3), kind:'pumpkin', rot:jitter(0.2), px: 26 + rs()*4 });
      items.push({ x: bx + nx*2 + jitter(4), y: by - ny*3 + jitter(3), kind:(pickSeason().startsWith('hall')?'jack':'pumpkin'), rot:jitter(0.2), px: 28 + rs()*6 });

      // cornucopia sometimes
      if (season==='fall' && rs()<0.6){
        items.push({ x: bx + nx*4 + jitter(4), y: by + ny*6 + jitter(4), kind:'cornucopia', rot: angle + jitter(0.4), px: 34 });
      }

      // a few leaves sprinkled at the base
      for(let i=0;i<3;i++){
        items.push({ x: bx + jitter(12), y: by + jitter(10), kind:'leaf', rot: rs()*Math.PI*2, px: 14 + rs()*6 });
      }
    }

    // For each rectangle edge, scatter and set clusters at middle + near ends
    const per100 = (season==='fall') ? 3.5 : (season==='halloween' ? 4.0 : 2.5);
    for (const seg of segs){
      scatterAlong(seg, per100);

      if (seg.kind==='h'){
        const midx = (seg.x0 + seg.x1)/2, y = seg.y;
        placeClusterAt(midx, y, seg.nx, seg.ny);
        // quarter positions
        placeClusterAt(seg.x0 + (seg.x1-seg.x0)*0.25, y, seg.nx, seg.ny);
        placeClusterAt(seg.x0 + (seg.x1-seg.x0)*0.75, y, seg.nx, seg.ny);
      } else {
        const midy = (seg.y0 + seg.y1)/2, x = seg.x;
        placeClusterAt(x, midy, seg.nx, seg.ny);
        placeClusterAt(x, seg.y0 + (seg.y1-seg.y0)*0.25, seg.nx, seg.ny);
        placeClusterAt(x, seg.y0 + (seg.y1-seg.y0)*0.75, seg.nx, seg.ny);
      }
    }

    CACHE = { tile: api.TILE, season, items };
    window.IZZA_SEASONAL = { season, count: items.length };
    console.log('[SEASONAL]', season, 'items:', items.length);
  }

  // ---------- draw helpers ----------
  function drawSprite(kind, px, rot){
    const def = SPRITES[kind];
    if (!def) return;
    // scale so natural width maps to desired screen px
    const s = (px / def.naturalW);
    ctx.save();
    ctx.rotate(rot || 0);
    ctx.scale(s, s);
    if (kind==='pumpkin') def.draw(false);
    else if (kind==='jack') SPRITES.pumpkin.draw(true);
    else def.draw();
    ctx.restore();
  }

  // world → canvas pixel coordinates (with camera + dpr + w2s)
  function toCanvasPx(api, wx, wy){
    const sx = (wx - api.camera.x) * w2s * dpr;
    const sy = (wy - api.camera.y) * w2s * dpr;
    return [sx, sy];
  }

  // night integration
  const isNight  = ()=> !!(window.IZZA_LIGHT && window.IZZA_LIGHT.isNight);
  const nightAmt = ()=> (window.IZZA_LIGHT?.nightLevel || 0);

  // ---------- master draw ----------
  function drawAll(){
    if (!ctx || !overlay || !CACHE) return;
    const api = IZZA.api; if(!api?.ready) return;

    ctx.setTransform(1,0,0,1,0,0);
    ctx.clearRect(0,0,overlay.width,overlay.height);

    for (const it of CACHE.items){
      const [sx, sy] = toCanvasPx(api, it.x, it.y);
      ctx.save();
      ctx.translate(sx, sy);
      drawSprite(it.kind, it.px * dpr, it.rot||0);
      ctx.restore();
    }
  }

  // ---------- boot ----------
  IZZA.on('ready', api=>{
    if (!ensureOverlay()) return;
    ensureScatter(api);
    drawAll();
    IZZA.on('draw-post', drawAll);
    setInterval(()=>{ ensureScatter(api); }, 60*1000);
  });
})();
