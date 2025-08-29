// /static/game/js/plugins/v1_map_expander.js
(function () {
  const BUILD = 'v1.5-map-expander+editor-ios-pointer+left-ui+instant-paint';
  console.log('[IZZA PLAY]', BUILD);

  // ===== Flags / bounds =====
  const MAP_TIER_KEY = 'izzaMapTier';  // '1' | '2'
  const TIER2 = { x0: 10, y0: 12, x1: 80, y1: 50 };

  // persist editor state
  const LS_ROADS = 'izzaD2Roads';
  const LS_BLDGS = 'izzaD2Buildings';

  let api = null;
  const state = {
    tier: localStorage.getItem(MAP_TIER_KEY) || '1',
    roads: loadJSON(LS_ROADS, []),           // [{a:[gx,gy], b:[gx,gy]}]
    bldgs: loadJSON(LS_BLDGS, []),           // [{x,y,w,h,color}]
    mode: 'road',                            // 'road' | 'bldg' | 'erase'
    liveDirty: true,                         // force first repaint
    _lastRoad: null
  };

  // ===== utils =====
  function loadJSON(k, fallback){ try{ return JSON.parse(localStorage.getItem(k)||'')||fallback; }catch{ return fallback; } }
  function saveJSON(k, v){ localStorage.setItem(k, JSON.stringify(v)); }
  const isTier2 = () => state.tier === '2';

  const SCALE = ()=> api.DRAW / api.TILE;
  const w2sX = (wx)=> (wx - api.camera.x) * SCALE();
  const w2sY = (wy)=> (wy - api.camera.y) * SCALE();

  // ===== camera widening (non-invasive) =====
  function widenCameraClampIfNeeded(){
    if (!isTier2() || widenCameraClampIfNeeded._done) return;
    widenCameraClampIfNeeded._done = true;
    IZZA.on('update-post', ()=>{
      const visW = document.getElementById('game').width / SCALE();
      const visH = document.getElementById('game').height / SCALE();
      const maxX = (TIER2.x1+1)*api.TILE - visW;
      const maxY = (TIER2.y1+1)*api.TILE - visH;
      api.camera.x = Math.max(TIER2.x0*api.TILE, Math.min(api.camera.x, maxX));
      api.camera.y = Math.max(TIER2.y0*api.TILE, Math.min(api.camera.y, maxY));
    });
  }

  // ===== collisions for buildings (immediate) =====
  function pushOutOfSolids(){
    if (!isTier2()) return;
    const t=api.TILE, px=api.player.x, py=api.player.y;
    const gx=(px/t|0), gy=(py/t|0);
    for(const b of state.bldgs){
      if(gx>=b.x && gx<b.x+b.w && gy>=b.y && gy<b.y+b.h){
        const dxL = Math.abs(px - b.x*t);
        const dxR = Math.abs((b.x+b.w)*t - px);
        const dyT = Math.abs(py - b.y*t);
        const dyB = Math.abs((b.y+b.h)*t - py);
        const m = Math.min(dxL,dxR,dyT,dyB);
        if(m===dxL) api.player.x = (b.x-0.01)*t;
        else if(m===dxR) api.player.x = (b.x+b.w+0.01)*t;
        else if(m===dyT) api.player.y = (b.y-0.01)*t;
        else api.player.y = (b.y+b.h+0.01)*t;
        break;
      }
    }
  }

  // ===== painters =====
  function drawRoadStroke(ctx, gx1,gy1, gx2,gy2, widthPx){
    const t=api.TILE;
    ctx.beginPath();
    ctx.moveTo(w2sX(gx1*t + t/2), w2sY(gy1*t + t/2));
    ctx.lineTo(w2sX(gx2*t + t/2), w2sY(gy2*t + t/2));
    ctx.lineWidth = widthPx;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#6a727b';       // matches your street/sidewalk tone
    ctx.stroke();
  }

  function drawMainOverlay(){
    if(!isTier2()) return;
    const ctx = document.getElementById('game').getContext('2d');
    ctx.save();

    // roads (slightly wider than 1 tile so they read like yours)
    const w = Math.max(3, api.DRAW * 0.35);
    state.roads.forEach(r => drawRoadStroke(ctx, r.a[0], r.a[1], r.b[0], r.b[1], w));

    // buildings (same block style as HQ/Shop)
    for(const b of state.bldgs){
      const sx=w2sX(b.x*api.TILE), sy=w2sY(b.y*api.TILE);
      const W=b.w*api.DRAW, H=b.h*api.DRAW;
      ctx.fillStyle = b.color || '#203a60';
      ctx.fillRect(sx, sy, W, H);
      ctx.fillStyle = 'rgba(0,0,0,.08)';
      ctx.fillRect(sx, sy, W, Math.floor(H*0.18));
    }

    ctx.restore();
  }

  function drawMiniOverlay(){
    const mini=document.getElementById('minimap'); if(!mini) return;
    const mctx=mini.getContext('2d');
    const sx=mini.width/90, sy=mini.height/60;
    // roads
    mctx.save();
    mctx.strokeStyle='#8a90a0';
    mctx.lineWidth=Math.max(1, sx*0.9);
    for(const r of state.roads){
      mctx.beginPath();
      mctx.moveTo(r.a[0]*sx, r.a[1]*sy);
      mctx.lineTo(r.b[0]*sx, r.b[1]*sy);
      mctx.stroke();
    }
    // buildings
    for(const b of state.bldgs){
      mctx.fillStyle=b.color||'#203a60';
      mctx.fillRect(b.x*sx, b.y*sy, b.w*sx, b.h*sy);
    }
    mctx.restore();
  }

  function drawBigOverlayIfOpen(){
    const big=document.getElementById('bigmap'); const modal=document.getElementById('mapModal');
    if(!big||!modal||modal.style.display!=='flex') return;
    const bctx=big.getContext('2d');
    const sx=big.width/90, sy=big.height/60;
    bctx.save();
    bctx.strokeStyle='#8a90a0'; bctx.lineWidth=Math.max(2, sx*1.2);
    for(const r of state.roads){
      bctx.beginPath();
      bctx.moveTo(r.a[0]*sx, r.a[1]*sy);
      bctx.lineTo(r.b[0]*sx, r.b[1]*sy);
      bctx.stroke();
    }
    for(const b of state.bldgs){
      bctx.fillStyle=b.color||'#203a60';
      bctx.fillRect(b.x*sx, b.y*sy, b.w*sx, b.h*sy);
    }
    bctx.restore();
  }

  // ===== editor UI (left side so it doesn't cover A/B/Map) =====
  function mkBtn(id,label,leftPx,bottomPx){
    const b=document.createElement('button');
    b.id=id; b.textContent=label;
    Object.assign(b.style,{
      position:'fixed', left:leftPx+'px', bottom:bottomPx+'px', zIndex:15,
      padding:'6px 10px', fontSize:'12px'
    });
    document.body.appendChild(b);
    return b;
  }

  function ensureEditor(){
    if(!isTier2()) return;
    if(ensureEditor._done) return;
    ensureEditor._done = true;

    // stack above the joystick (bottom-left)
    const roadBtn   = mkBtn('d2Road','Road',     18, 190);
    const bldgBtn   = mkBtn('d2Bldg','Building', 18, 158);
    const eraseBtn  = mkBtn('d2Erase','Erase',   18, 126);
    const saveBtn   = mkBtn('d2Save','Save',     18,  94);
    const clearBtn  = mkBtn('d2Clear','Clear',   18,  62);
    const exitBtn   = mkBtn('d2Exit','Hide UI',  18,  30);

    function setMode(m){
      state.mode = m;
      [roadBtn,bldgBtn,eraseBtn].forEach(b=> b.style.opacity= (b.id==='d2'+m[0].toUpperCase()+m.slice(1)?'1':'0.7'));
    }
    setMode('road');

    roadBtn.onclick = ()=> setMode('road');
    bldgBtn.onclick = ()=> setMode('bldg');
    eraseBtn.onclick= ()=> setMode('erase');
    saveBtn.onclick = ()=>{ saveJSON(LS_ROADS, state.roads); saveJSON(LS_BLDGS, state.bldgs); flash('Saved'); };
    clearBtn.onclick= ()=>{
      if(confirm('Clear all Tier-2 roads/buildings?')){
        state.roads.length=0; state.bldgs.length=0;
        saveJSON(LS_ROADS, state.roads); saveJSON(LS_BLDGS, state.bldgs);
        markDirty(true);
      }
    };
    exitBtn.onclick = ()=> {
      [roadBtn,bldgBtn,eraseBtn,saveBtn,clearBtn,exitBtn].forEach(b=> b.remove());
      ensureEditor._done=false;
    };

    // place by tapping the main canvas — use pointer events for iOS
    const cvs=document.getElementById('game');

    // make sure browser doesn't treat touches as scroll/zoom
    cvs.style.touchAction = 'none';

    const placeHandler = (e)=>{
      if(!isTier2()) return;
      // support pointer and touch
      let clientX = e.clientX, clientY = e.clientY;
      if(e.touches && e.touches[0]){ clientX=e.touches[0].clientX; clientY=e.touches[0].clientY; }
      const rect=cvs.getBoundingClientRect();
      const sx=clientX-rect.left, sy=clientY-rect.top;
      const wx = api.camera.x + sx / SCALE();
      const wy = api.camera.y + sy / SCALE();
      const gx = Math.floor(wx / api.TILE);
      const gy = Math.floor(wy / api.TILE);

      if(state.mode==='erase'){ eraseAt(gx,gy); e.preventDefault(); return; }

      if(state.mode==='bldg'){
        state.bldgs.push({x:gx, y:gy, w:2, h:2, color:'#203a60'});
        markDirty(true);
        e.preventDefault();
        return;
      }

      // road mode
      const last = state._lastRoad;
      if(last && (last.gy===gy || last.gx===gx)){
        const a=[last.gx,last.gy], b=[gx,gy];
        state.roads.push({a,b});
        state._lastRoad=null;
      }else{
        state._lastRoad = {gx,gy};
        state.roads.push({a:[gx,gy], b:[gx+1,gy]}); // tiny default segment
      }
      markDirty(true);
      e.preventDefault();
    };

    // Pointer-first; fall back to touchstart for older Safari
    cvs.addEventListener('pointerdown', placeHandler, {passive:false});
    cvs.addEventListener('touchstart',  placeHandler, {passive:false});
  }

  function eraseAt(gx,gy){
    // remove any building covering this cell
    const bi = state.bldgs.findIndex(b=> gx>=b.x && gx<b.x+b.w && gy>=b.y && gy<b.y+b.h);
    if(bi>=0){ state.bldgs.splice(bi,1); markDirty(true); return; }
    // remove road whose center passes close to this cell
    const hit = (r)=>{
      const ax=r.a[0], ay=r.a[1], bx=r.b[0], by=r.b[1];
      if(ay===by && ay===gy && (gx>=Math.min(ax,bx)&&gx<=Math.max(ax,bx))) return true;
      if(ax===bx && ax===gx && (gy>=Math.min(ay,by)&&gy<=Math.max(ay,by))) return true;
      return false;
    };
    const ri = state.roads.findIndex(hit);
    if(ri>=0){ state.roads.splice(ri,1); markDirty(true); }
  }

  function flash(msg){
    let h=document.getElementById('tutHint');
    if(!h){ h=document.createElement('div'); h.id='tutHint';
      Object.assign(h.style,{position:'fixed',left:'12px',top:'64px',zIndex:16,
        background:'rgba(7,12,22,.85)',border:'1px solid #2f3b58',color:'#cfe0ff',
        borderRadius:'10px',padding:'8px 10px',fontSize:'14px'}); document.body.appendChild(h);
    }
    h.textContent=msg; h.style.display='block'; clearTimeout(h._t); h._t=setTimeout(()=>h.style.display='none',1600);
  }

  function markDirty(repaintNow){
    state.liveDirty = true;
    if(repaintNow){
      drawMainOverlay();
      drawMiniOverlay();
      drawBigOverlayIfOpen();
    }
  }

  // ===== hooks =====
  IZZA.on('ready', (a)=>{
    api=a;
    state.tier = localStorage.getItem(MAP_TIER_KEY)||'1';
    if(isTier2()){ widenCameraClampIfNeeded(); ensureEditor(); }

    // Watch for flag flips during play
    IZZA.on('update-post', ()=>{
      const cur = localStorage.getItem(MAP_TIER_KEY)||'1';
      if(cur!==state.tier){
        state.tier=cur;
        if(isTier2()){ widenCameraClampIfNeeded(); ensureEditor(); markDirty(true); }
      }
      if(isTier2()) pushOutOfSolids();
    });

    // Redraw big map whenever opened
    const mapModal=document.getElementById('mapModal');
    if(mapModal){
      const obs=new MutationObserver(()=>{ if(mapModal.style.display==='flex') drawBigOverlayIfOpen(); });
      obs.observe(mapModal,{attributes:true,attributeFilter:['style']});
    }
  });

  IZZA.on('render-post', ()=>{
    if(!isTier2()) return;
    if(state.liveDirty){
      state.liveDirty=false;
      drawMiniOverlay();
    }
    drawMainOverlay();
    drawBigOverlayIfOpen();
  });
})();
