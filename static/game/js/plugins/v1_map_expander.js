// /static/game/js/plugins/v1_map_expander.js
(function(){
  const BUILD = 'v1.0-map-expander+tier2-curvy';
  console.log('[IZZA PLAY]', BUILD);

  const MAP_TIER_KEY = 'izzaMapTier';            // '1' | '2' | ...
  const SUGG_KEY     = 'izzaUnlockedSuggested';  // {x0,y0,x1,y1} for the core to adopt
  const TIER_SEEN    = 'izzaTierSeenToast';

  // Base (your tier-1) and Tier-2 target rects (grid coords)
  const BASE = { x0:18, y0:18, x1:72, y1:42 };               // current playable
  const D2   = { x0:BASE.x1+1, y0:BASE.y0-6, x1:BASE.x1+26, y1:BASE.y1+6 }; // new district to the east

  let api=null;

  // ===== helpers =====
  const w2sX = (wx)=> (wx - api.camera.x) * (api.DRAW/api.TILE);
  const w2sY = (wy)=> (wy - api.camera.y) * (api.DRAW/api.TILE);
  const S    = ()=> api.DRAW, T=()=> api.TILE;

  function rect(ctx,gx,gy,w,h,fill){
    ctx.fillStyle=fill;
    ctx.fillRect(w2sX(gx*T()), w2sY(gy*T()), w*S(), h*S());
  }
  function roadH(ctx, x0,y,w){
    rect(ctx,x0,y,w,1,'#2a2a2a');
    // dashed center line
    for(let i=0;i<w;i++){ rect(ctx,x0+i, y+0.48, 0.25, 0.04, '#ffd23f'); }
  }
  function roadV(ctx, x,y0,h){
    rect(ctx,x,y0,1,h,'#2a2a2a');
  }
  function lot(ctx, gx,gy,w,h){ rect(ctx,gx,gy,w,h,'#09371c'); }
  function box(ctx,gx,gy,w,h,color){ rect(ctx,gx,gy,w,h,color); rect(ctx,gx,gy,w,h,'rgba(0,0,0,.08)'); }

  // Publish suggested “unlocked” bounds for the core to adopt after expansion
  function publishBoundsForTier2(){
    const b = {
      x0: Math.min(BASE.x0, D2.x0),
      y0: Math.min(BASE.y0, D2.y0),
      x1: Math.max(BASE.x1, D2.x1),
      y1: Math.max(BASE.y1, D2.y1)
    };
    localStorage.setItem(SUGG_KEY, JSON.stringify(b));
    window._izza_suggested_unlocked = b;
  }

  function toastOnceTier2(){
    if(localStorage.getItem(TIER_SEEN)==='2') return;
    let h = document.getElementById('tutHint');
    if(!h){
      h = document.createElement('div');
      h.id='tutHint';
      Object.assign(h.style,{
        position:'fixed', left:'12px', top:'64px', zIndex:14,
        background:'rgba(10,12,18,.88)', border:'1px solid #394769',
        color:'#cfe0ff', padding:'8px 10px', borderRadius:'10px', fontSize:'14px'
      });
      document.body.appendChild(h);
    }
    h.textContent = 'New District unlocked! Explore the city — pistols are now equip-able.';
    h.style.display='block';
    setTimeout(()=>{ h.style.display='none'; }, 2600);
    localStorage.setItem(TIER_SEEN,'2');
  }

  // ====== Tier 2 drawing (curvy “city-rug” style) ======
  function drawTier2(ctx){
    // base grass
    lot(ctx, D2.x0, D2.y0, (D2.x1-D2.x0+1), (D2.y1-D2.y0+1));

    // outer loop (approx curves with segments)
    roadH(ctx, D2.x0+1, D2.y0+2, (D2.x1-D2.x0-2));          // top
    roadH(ctx, D2.x0+1, D2.y1-2, (D2.x1-D2.x0-2));          // bottom
    roadV(ctx, D2.x0+2, D2.y0+3, (D2.y1-D2.y0-5));          // left “curve”
    roadV(ctx, D2.x1-2, D2.y0+1, (D2.y1-D2.y0-2));          // right “curve”

    // inner plaza loop
    roadH(ctx, D2.x0+6, D2.y0+8, 11);
    roadV(ctx, D2.x0+6, D2.y0+6, 6);
    roadV(ctx, D2.x0+16, D2.y0+6, 6);

    // lake loop
    box(ctx, D2.x1-8, D2.y1-8, 6, 4, '#2b6a7a'); // water
    roadH(ctx, D2.x1-10, D2.y1-5, 9);

    // little building blocks (toy-town colors)
    box(ctx, D2.x0+7,  D2.y0+3,  3,2, '#aa3232'); // fire
    box(ctx, D2.x0+11, D2.y0+3,  3,2, '#4d7bd1'); // police
    box(ctx, D2.x0+15, D2.y0+3,  3,2, '#e0a82a'); // repair
    box(ctx, D2.x0+6,  D2.y0+10, 3,2, '#c95aa9'); // shops
    box(ctx, D2.x0+12, D2.y0+11, 3,2, '#ffcf5a'); // homes
    box(ctx, D2.x1-6,  D2.y0+6,  3,2, '#6bbf59'); // park
    box(ctx, D2.x1-6,  D2.y1-6,  3,2, '#d66a3a'); // library
  }

  // ===== hooks =====
  IZZA.on('ready', (a)=>{
    api=a;
    if(localStorage.getItem(MAP_TIER_KEY)==='2'){
      publishBoundsForTier2();
      toastOnceTier2();
    }
  });

  IZZA.on('render-post', ()=>{
    if(!api) return;
    if(localStorage.getItem(MAP_TIER_KEY)!=='2') return;

    const ctx = document.getElementById('game').getContext('2d');
    ctx.save();
    drawTier2(ctx);
    ctx.restore();
  });
})();
