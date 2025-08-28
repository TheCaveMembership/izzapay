// /static/game/js/plugins/v1_map_expander.js
(function(){
  const BUILD = 'v1.1-map-expander+tier2-curves';
  console.log('[IZZA PLAY]', BUILD);

  const MAP_TIER_KEY='izzaMapTier';       // '1' | '2' | ...
  const TIER2 = { x0:10, y0:12, x1:80, y1:50 }; // bigger view (matches your sketch proportions)

  let api=null;
  const expander = { tier: localStorage.getItem(MAP_TIER_KEY)||'1' };

  // --- helpers ---
  function setTier(t){ expander.tier=t; localStorage.setItem(MAP_TIER_KEY,String(t)); }
  function isTier2(){ return (expander.tier==='2'); }

  // Monkey-patch camera clamp to allow roaming in Tier 2 without touching your core.
  function widenCameraClamp(){
    if(!isTier2() || widenCameraClamp._done) return;
    widenCameraClamp._done = true;

    // Extend camera bounds by gently offsetting while clamping every frame.
    IZZA.on('update-pre', ()=>{
      // no-op hook to ensure our patch runs each frame if needed
    });

    // Add a soft post-clamp to keep camera inside Tier2 box
    IZZA.on('update-post', ()=>{
      const visW = document.getElementById('game').width  / (api.DRAW/api.TILE);
      const visH = document.getElementById('game').height / (api.DRAW/api.TILE);
      const maxX = (TIER2.x1+1)*api.TILE - visW;
      const maxY = (TIER2.y1+1)*api.TILE - visH;
      api.camera.x = Math.max(TIER2.x0*api.TILE, Math.min(api.camera.x, maxX));
      api.camera.y = Math.max(TIER2.y0*api.TILE, Math.min(api.camera.y, maxY));
    });
  }

  // Allow walking/driving in Tier 2 by soft-blocking only *outside* Tier 2.
  // We can't replace core collision directly, but we can prevent the hard clamp feel by nudging the player back inside.
  function softBounds(){
    if(!isTier2()) return;
    const t=api.TILE;
    const gx=(api.player.x/t|0), gy=(api.player.y/t|0);
    if(gx<TIER2.x0) api.player.x = (TIER2.x0+0.01)*t;
    if(gx>TIER2.x1) api.player.x = (TIER2.x1-0.01)*t;
    if(gy<TIER2.y0) api.player.y = (TIER2.y0+0.01)*t;
    if(gy>TIER2.y1) api.player.y = (TIER2.y1-0.01)*t;
  }

  // --- Painter: curved roads & buildings (overlay only; keeps your existing tile render) ---
  function w2sX(wx){ return (wx-api.camera.x)*(api.DRAW/api.TILE); }
  function w2sY(wy){ return (wy-api.camera.y)*(api.DRAW/api.TILE); }

  // Simple city painter driven by a few bezier/line segments
  function drawTier2Overlay(){
    if(!isTier2()) return;

    const ctx=document.getElementById('game').getContext('2d');
    const S=api.DRAW, t=api.TILE;

    // Roads
    ctx.save();
    ctx.lineWidth = Math.max(3, S*0.20);
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(180,190,205,0.9)';

    function line(gx1,gy1,gx2,gy2){
      ctx.beginPath();
      ctx.moveTo(w2sX(gx1*t+16), w2sY(gy1*t+16));
      ctx.lineTo(w2sX(gx2*t+16), w2sY(gy2*t+16));
      ctx.stroke();
    }
    function quad(gx1,gy1,gcx,gcy,gx2,gy2){
      ctx.beginPath();
      ctx.moveTo(w2sX(gx1*t+16), w2sY(gy1*t+16));
      ctx.quadraticCurveTo(w2sX(gcx*t+16), w2sY(gcy*t+16), w2sX(gx2*t+16), w2sY(gy2*t+16));
      ctx.stroke();
    }

    // Main horizontal spines
    line(14,20, 76,20);
    line(14,36, 76,36);

    // Vertical spines
    line(28,14, 28,44);
    line(52,14, 52,44);

    // Curved loop bottom-left
    quad(28,36, 30,40, 34,40);
    quad(34,40, 26,46, 18,44);
    quad(18,44, 16,44, 16,40);

    // Curved lake road bottom-right
    quad(56,40, 64,44, 72,44);
    quad(72,44, 76,42, 76,38);

    // Top ring
    quad(16,14, 20,12, 28,12);
    line(28,12, 60,12);
    quad(60,12, 72,12, 74,18);

    // Short cul-de-sacs
    line(18,20, 22,20);
    line(22,20, 22,24);
    line(60,20, 64,20);

    ctx.restore();

    // Buildings (simple colored blocks; sizes chosen to match your mock)
    function rect(gx,gy,w,h,color){
      const sx=w2sX(gx*t), sy=w2sY(gy*t);
      ctx.fillStyle=color;
      ctx.fillRect(sx+S*0.10, sy+S*0.10, S*(w-0.20), S*(h-0.20));
    }
    // HQ-ish red block
    rect(42,22, 3,2, '#a44a4a');
    // Blue civic buildings
    rect(56,24, 3,2, '#416aa5');
    rect(36,38, 3,2, '#416aa5');
    // Small shops row
    rect(20,28, 1.6,1.6, '#c9cbd3');
    rect(24,28, 1.6,1.6, '#c9cbd3');
    rect(28,28, 1.6,1.6, '#c9cbd3');
    // Park pond suggestion
    ctx.save();
    ctx.fillStyle='#7db7d9';
    ctx.beginPath();
    ctx.ellipse(w2sX(66*t), w2sY(43*t), S*1.6, S*1.1, 0, 0, Math.PI*2);
    ctx.fill();
    ctx.restore();
  }

  // --- Hooks ---
  IZZA.on('ready',(a)=>{
    api=a;
    // If Mission 3 already flipped the flag, move to Tier 2 now
    expander.tier = localStorage.getItem(MAP_TIER_KEY)||'1';
    if(isTier2()){ widenCameraClamp(); }

    // Watch for tier flips during play (e.g., when M3 completes)
    const mo = new MutationObserver(()=>{ /* cheap wake-up */ });
    mo.observe(document.body||document.documentElement,{subtree:true,childList:true});

    console.log('[MAP EXPANDER] ready; tier =', expander.tier);
  });

  IZZA.on('update-post', ()=>{
    if(localStorage.getItem(MAP_TIER_KEY)!==expander.tier){
      expander.tier = localStorage.getItem(MAP_TIER_KEY)||'1';
      if(isTier2()){ widenCameraClamp(); }
    }
    if(isTier2()) softBounds();
  });

  IZZA.on('render-post', ()=>{
    if(isTier2()) drawTier2Overlay();
  });

})();
