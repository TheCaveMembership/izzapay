// /static/game/js/plugins/v1_map_expander.js
(function () {
  const BUILD = 'v1.6-map-expander+ios-place-at-player+top-left-ui';
  console.log('[IZZA PLAY]', BUILD);

  // ===== Flags / bounds =====
  const MAP_TIER_KEY = 'izzaMapTier';             // '1' | '2'
  const TIER2 = { x0: 10, y0: 12, x1: 80, y1: 50 };

  // persist editor state
  const LS_ROADS = 'izzaD2Roads';
  const LS_BLDGS = 'izzaD2Buildings';

  let api = null;
  const state = {
    tier: localStorage.getItem(MAP_TIER_KEY) || '1',
    roads: json(LS_ROADS, []),                    // [{a:[gx,gy], b:[gx,gy]}]
    bldgs: json(LS_BLDGS, []),                    // [{x,y,w,h,color}]
    liveDirty: true,
    _lastRoad: null,
  };

  // ---------- utils ----------
  function json(k, d){ try { return JSON.parse(localStorage.getItem(k)||'')||d; } catch { return d; } }
  function save(k, v){ localStorage.setItem(k, JSON.stringify(v)); }

  const isTier2 = () => state.tier === '2';
  const SCALE = () => api.DRAW / api.TILE;
  const w2sX = (wx) => (wx - api.camera.x) * SCALE();
  const w2sY = (wy) => (wy - api.camera.y) * SCALE();

  function flash(msg){
    let h=document.getElementById('tutHint');
    if(!h){ h=document.createElement('div'); h.id='tutHint';
      Object.assign(h.style,{position:'fixed',left:'12px',top:'64px',zIndex:20,
        background:'rgba(7,12,22,.85)',border:'1px solid #2f3b58',color:'#cfe0ff',
        borderRadius:'10px',padding:'8px 10px',fontSize:'14px'}); document.body.appendChild(h);
    }
    h.textContent=msg; h.style.display='block'; clearTimeout(h._t); h._t=setTimeout(()=>h.style.display='none',1400);
  }

  // ---------- camera widening ----------
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

  // ---------- collisions (solid buildings) ----------
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

  // ---------- painters ----------
  function drawRoadStroke(ctx, gx1,gy1, gx2,gy2, widthPx){
    const t=api.TILE;
    ctx.beginPath();
    ctx.moveTo(w2sX(gx1*t + t/2), w2sY(gy1*t + t/2));
    ctx.lineTo(w2sX(gx2*t + t/2), w2sY(gy2*t + t/2));
    ctx.lineWidth = widthPx;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#6a727b';                // your street/sidewalk tone
    ctx.stroke();
  }

  function drawMainOverlay(){
    if(!isTier2()) return;
    const ctx = document.getElementById('game').getContext('2d');
    ctx.save();
    const w = Math.max(3, api.DRAW * 0.35);
    state.roads.forEach(r => drawRoadStroke(ctx, r.a[0], r.a[1], r.b[0], r.b[1], w));
    for(const b of state.bldgs){
      const sx=w2sX(b.x*api.TILE), sy=w2sY(b.y*api.TILE);
      const W=b.w*api.DRAW, H=b.h*api.DRAW;
      ctx.fillStyle = b.color || '#203a60';     // same building palette
      ctx.fillRect(sx, sy, W, H);
      ctx.fillStyle = 'rgba(0,0,0,.08)';        // subtle top shade
      ctx.fillRect(sx, sy, W, Math.floor(H*0.18));
    }
    ctx.restore();
  }

  function drawMiniOverlay(){
    const mini=document.getElementById('minimap'); if(!mini) return;
    const mctx=mini.getContext('2d');
    const sx=mini.width/90, sy=mini.height/60;
    mctx.save();
    mctx.strokeStyle='#8a90a0';
    mctx.lineWidth=Math.max(1, sx*0.9);
    for(const r of state.roads){
      mctx.beginPath();
      mctx.moveTo(r.a[0]*sx, r.a[1]*sy);
      mctx.lineTo(r.b[0]*sx, r.b[1]*sy);
      mctx.stroke();
    }
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

  // ---------- editor UI (top-left; away from joystick) ----------
  function mkBtn(id,label,leftPx,topPx){
    const b=document.createElement('button');
    b.id=id; b.textContent=label;
    Object.assign(b.style,{
      position:'fixed', left:leftPx+'px', top:topPx+'px', zIndex:19,
      padding:'6px 10px', fontSize:'12px'
    });
    document.body.appendChild(b);
    return b;
  }

  function ensureEditor(){
    if(!isTier2()) return;
    if(ensureEditor._done) return;
    ensureEditor._done = true;

    // Top-left column
    const roadBtn   = mkBtn('d2Road','Road (@Player)',      14, 110);
    const bldgBtn   = mkBtn('d2Bldg','Building (@Player)',  14, 142);
    const eraseBtn  = mkBtn('d2Erase','Erase Mode',         14, 174);
    const saveBtn   = mkBtn('d2Save','Save',                14, 206);
    const clearBtn  = mkBtn('d2Clear','Clear',              14, 238);
    const exitBtn   = mkBtn('d2Exit','Hide UI',             14, 270);

    // place helpers using the **player tile** (so you never have to tap the canvas)
    function playerTile(){
      const t=api.TILE;
      return { gx: Math.floor((api.player.x + t/2)/t),
               gy: Math.floor((api.player.y + t/2)/t) };
    }

    roadBtn.onclick = ()=>{
      const {gx,gy}=playerTile();
      // create a 3-tile horizontal road centered on player
      state.roads.push({a:[gx-1,gy], b:[gx+1,gy]});
      state._lastRoad=null;
      markDirty(true);
      flash('Road placed at player');
    };

    bldgBtn.onclick = ()=>{
      const {gx,gy}=playerTile();
      // 2x2 building with default color (you can move later by Erase + re-place)
      state.bldgs.push({x:gx, y:gy, w:2, h:2, color:'#203a60'});
      markDirty(true);
      flash('Building placed at player');
    };

    let eraseMode=false;
    eraseBtn.onclick = ()=>{
      eraseMode=!eraseMode;
      eraseBtn.style.opacity = eraseMode? '1' : '0.75';
      flash(eraseMode ? 'Erase: tap a tile' : 'Erase off');
    };

    saveBtn.onclick = ()=>{
      save(LS_ROADS, state.roads); save(LS_BLDGS, state.bldgs);
      flash('Saved');
    };

    clearBtn.onclick = ()=>{
      if(confirm('Clear all Tier-2 roads/buildings?')){
        state.roads.length=0; state.bldgs.length=0;
        save(LS_ROADS, state.roads); save(LS_BLDGS, state.bldgs);
        markDirty(true);
      }
    };

    exitBtn.onclick = ()=>{
      [roadBtn,bldgBtn,eraseBtn,saveBtn,clearBtn,exitBtn].forEach(b=> b.remove());
      ensureEditor._done=false;
    };

    // Optional: tap the **canvas** to place/erase too (fixed for iOS)
    const cvs=document.getElementById('game');
    cvs.style.touchAction='none';
    const place = (e)=>{
      if(!isTier2()) return;
      let x=e.clientX, y=e.clientY;
      if(e.touches && e.touches[0]){ x=e.touches[0].clientX; y=e.touches[0].clientY; }
      const r=cvs.getBoundingClientRect();
      const sx=x-r.left, sy=y-r.top;
      const wx = api.camera.x + sx / SCALE();
      const wy = api.camera.y + sy / SCALE();
      const gx=Math.floor(wx/api.TILE), gy=Math.floor(wy/api.TILE);

      if(eraseMode){ eraseAt(gx,gy); markDirty(true); e.preventDefault(); return; }

      // add a short segment; second tap on same row/col will extend
      const last=state._lastRoad;
      if(last && (last.gy===gy || last.gx===gx)){
        state.roads.push({a:[last.gx,last.gy], b:[gx,gy]});
        state._lastRoad=null;
      }else{
        state._lastRoad={gx,gy};
        state.roads.push({a:[gx,gy], b:[gx+1,gy]});
      }
      markDirty(true);
      e.preventDefault();
    };
    cvs.addEventListener('pointerdown', place, {passive:false});
    cvs.addEventListener('touchstart',  place, {passive:false});
  }

  function eraseAt(gx,gy){
    const bi = state.bldgs.findIndex(b=> gx>=b.x && gx<b.x+b.w && gy>=b.y && gy<b.y+b.h);
    if(bi>=0){ state.bldgs.splice(bi,1); return; }
    const hit = (r)=>{
      const ax=r.a[0], ay=r.a[1], bx=r.b[0], by=r.b[1];
      if(ay===by && ay===gy && (gx>=Math.min(ax,bx)&&gx<=Math.max(ax,bx))) return true;
      if(ax===bx && ax===gx && (gy>=Math.min(ay,by)&&gy<=Math.max(ay,by))) return true;
      return false;
    };
    const ri = state.roads.findIndex(hit);
    if(ri>=0) state.roads.splice(ri,1);
  }

  function markDirty(repaintNow){
    state.liveDirty=true;
    if(repaintNow){
      drawMainOverlay();
      drawMiniOverlay();
      drawBigOverlayIfOpen();
    }
  }

  // ---------- hooks ----------
  IZZA.on('ready', (a)=>{
    api=a;
    state.tier = localStorage.getItem(MAP_TIER_KEY)||'1';
    if(isTier2()){ widenCameraClampIfNeeded(); ensureEditor(); }

    // re-check tier during play
    IZZA.on('update-post', ()=>{
      const cur = localStorage.getItem(MAP_TIER_KEY)||'1';
      if(cur!==state.tier){
        state.tier=cur;
        if(isTier2()){ widenCameraClampIfNeeded(); ensureEditor(); markDirty(true); }
      }
      if(isTier2()) pushOutOfSolids();
    });

    // paint big map whenever modal opens
    const mapModal=document.getElementById('mapModal');
    if(mapModal){
      const obs=new MutationObserver(()=>{ if(mapModal.style.display==='flex') drawBigOverlayIfOpen(); });
      obs.observe(mapModal,{attributes:true,attributeFilter:['style']});
    }
  });

  IZZA.on('render-post', ()=>{
    if(!isTier2()) return;
    if(state.liveDirty){ state.liveDirty=false; drawMiniOverlay(); }
    drawMainOverlay();
    drawBigOverlayIfOpen();
  });
})();
