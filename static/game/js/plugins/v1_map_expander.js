// /static/game/js/plugins/v1_map_expander_editor.js
(function () {
  const BUILD = 'v1.0-map-expander+tile-editor(roads/buildings)+save+collision+minimap';
  console.log('[IZZA PLAY]', BUILD);

  // ===== Flags / bounds =====
  const MAP_TIER_KEY = 'izzaMapTier';   // '1' | '2'
  const TIER2 = { x0: 10, y0: 12, x1: 80, y1: 50 }; // expanded play box (eastward)

  // Storage for your handmade tiles
  const STORE_KEY = 'izzaD2Tiles'; // { roads:[[gx,gy],...], buildings:[[gx,gy],...] }

  // Colors that match your core style
  const COL = {
    grass:   '#09371c',
    road:    '#2a2a2a',
    dash:    '#ffd23f',
    walk:    '#6a727b',
    b_red:   '#7a3a3a',
    b_blue:  '#203a60',
    b_dark:  '#0a2455',
  };

  let api = null;
  const state = {
    tier: localStorage.getItem(MAP_TIER_KEY) || '1',
    tiles: { roads: [], buildings: [] },  // loaded on ready
    edit: { active: true, mode: 'road', cursorGX: null, cursorGY: null } // dev UI
  };

  const isTier2 = () => state.tier === '2';
  const scl = () => api.DRAW / api.TILE;
  const w2sX = (wx) => (wx - api.camera.x) * scl();
  const w2sY = (wy) => (wy - api.camera.y) * scl();

  // ---------- storage ----------
  function loadTiles() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
      if (parsed && Array.isArray(parsed.roads) && Array.isArray(parsed.buildings)) {
        state.tiles.roads = parsed.roads.map(([x,y])=>[x|0,y|0]);
        state.tiles.buildings = parsed.buildings.map(([x,y])=>[x|0,y|0]);
      }
    } catch {}
  }
  function saveTiles() {
    localStorage.setItem(STORE_KEY, JSON.stringify(state.tiles));
    toast('Layout saved');
  }

  // ---------- tiny ui toast ----------
  function toast(msg, seconds=1.8){
    let h=document.getElementById('tutHint');
    if(!h){
      h=document.createElement('div');
      h.id='tutHint';
      Object.assign(h.style,{
        position:'fixed', left:'12px', top:'64px', zIndex:20,
        background:'rgba(7,12,22,.88)', border:'1px solid #394769',
        color:'#cfe0ff', padding:'8px 10px', borderRadius:'10px', fontSize:'14px',
      });
      document.body.appendChild(h);
    }
    h.textContent=msg; h.style.display='block';
    clearTimeout(h._t); h._t=setTimeout(()=>{ h.style.display='none'; }, seconds*1000);
  }

  // ---------- editor ui ----------
  function ensureEditorUI(){
    if(document.getElementById('d2Editor')) return;

    const wrap=document.createElement('div');
    wrap.id='d2Editor';
    Object.assign(wrap.style,{
      position:'fixed', right:'14px', bottom:'116px', zIndex:19,
      display:'flex', flexDirection:'column', gap:'6px'
    });

    const btn = (id, label)=> {
      const b=document.createElement('button');
      b.id=id; b.textContent=label;
      Object.assign(b.style,{ fontSize:'12px', padding:'6px 10px', opacity:.92 });
      wrap.appendChild(b); return b;
    };

    const toggle = btn('edToggle', 'Editor: ON');
    const road   = btn('edRoad',   'Place Road');
    const bldg   = btn('edBuild',  'Place Building');
    const erase  = btn('edErase',  'Erase');
    const save   = btn('edSave',   'Save');
    const clear  = btn('edClear',  'Clear (dev)');

    toggle.addEventListener('click', ()=>{
      state.edit.active = !state.edit.active;
      toggle.textContent = 'Editor: ' + (state.edit.active?'ON':'OFF');
      toast(state.edit.active ? 'Editor enabled' : 'Editor disabled');
    });
    road.addEventListener('click', ()=>{
      state.edit.mode='road'; doPlace();
    });
    bldg.addEventListener('click', ()=>{
      state.edit.mode='building'; doPlace();
    });
    erase.addEventListener('click', doErase);
    save.addEventListener('click', saveTiles);
    clear.addEventListener('click', ()=>{
      if(confirm('Clear all placed tiles?')){
        state.tiles={roads:[],buildings:[]}; saveTiles();
      }
    });

    document.body.appendChild(wrap);
  }

  // cursor: by default, player tile; update when you tap the canvas
  function updateCursorFromPlayer(){
    const t=api.TILE;
    state.edit.cursorGX = ((api.player.x + t/2)/t)|0;
    state.edit.cursorGY = ((api.player.y + t/2)/t)|0;
  }
  function bindCanvasPick(){
    const cvs=document.getElementById('game');
    if(!cvs) return;
    cvs.addEventListener('click', (e)=>{
      const rect=cvs.getBoundingClientRect();
      const sx=e.clientX-rect.left, sy=e.clientY-rect.top;
      const wx = sx / scl() + api.camera.x;
      const wy = sy / scl() + api.camera.y;
      state.edit.cursorGX = (wx/api.TILE)|0;
      state.edit.cursorGY = (wy/api.TILE)|0;
      toast(`Target: ${state.edit.cursorGX},${state.edit.cursorGY}`, 1.0);
    });
  }

  // place / erase at cursor (or player if unset)
  function targetGX() { if(state.edit.cursorGX==null) updateCursorFromPlayer(); return state.edit.cursorGX; }
  function targetGY() { if(state.edit.cursorGY==null) updateCursorFromPlayer(); return state.edit.cursorGY; }

  function withinTier2(gx,gy){
    return gx>=TIER2.x0 && gx<=TIER2.x1 && gy>=TIER2.y0 && gy<=TIER2.y1;
  }

  function doPlace(){
    if(!state.edit.active || !isTier2()) return;
    const gx = targetGX(), gy=targetGY();
    if(!withinTier2(gx,gy)){ toast('That tile is outside Tier-2'); return; }
    if(state.edit.mode==='road'){
      if(!hasCoord(state.tiles.roads,gx,gy)) state.tiles.roads.push([gx,gy]);
      // erase building if overlapping
      removeCoord(state.tiles.buildings, gx, gy);
      toast('Road placed');
    }else if(state.edit.mode==='building'){
      if(!hasCoord(state.tiles.buildings,gx,gy)) state.tiles.buildings.push([gx,gy]);
      removeCoord(state.tiles.roads, gx, gy);
      toast('Building placed');
    }
  }
  function doErase(){
    if(!state.edit.active || !isTier2()) return;
    const gx = targetGX(), gy=targetGY();
    const r = removeCoord(state.tiles.roads, gx, gy);
    const b = removeCoord(state.tiles.buildings, gx, gy);
    toast((r||b)?'Erased':'Nothing here');
  }

  function hasCoord(arr,gx,gy){ return arr.some(p=>p[0]===gx && p[1]===gy); }
  function removeCoord(arr,gx,gy){
    const i = arr.findIndex(p=>p[0]===gx && p[1]===gy);
    if(i>=0){ arr.splice(i,1); return true; }
    return false;
  }

  // ---------- camera widen ----------
  function widenCameraClampIfNeeded() {
    if (!isTier2() || widenCameraClampIfNeeded._done) return;
    widenCameraClampIfNeeded._done = true;
    IZZA.on('update-post', () => {
      const visW = document.getElementById('game').width / scl();
      const visH = document.getElementById('game').height / scl();
      const maxX = (TIER2.x1 + 1) * api.TILE - visW;
      const maxY = (TIER2.y1 + 1) * api.TILE - visH;
      api.camera.x = Math.max(TIER2.x0 * api.TILE, Math.min(api.camera.x, maxX));
      api.camera.y = Math.max(TIER2.y0 * api.TILE, Math.min(api.camera.y, maxY));
    });
  }

  // ---------- collision for custom buildings ----------
  function pushOutOfBuildingTiles(){
    if(!isTier2()) return;
    const t=api.TILE;
    const gx=(api.player.x/t)|0, gy=(api.player.y/t)|0;
    if(!hasCoord(state.tiles.buildings, gx, gy)) return;

    // Push the player to the nearest edge of that 1x1 block
    const px=api.player.x, py=api.player.y;
    const left   = Math.abs(px - gx*t);
    const right  = Math.abs((gx+1)*t - px);
    const top    = Math.abs(py - gy*t);
    const bottom = Math.abs((gy+1)*t - py);
    const m = Math.min(left,right,top,bottom);
    if(m===left)   api.player.x = (gx - 0.01)*t;
    else if(m===right) api.player.x = (gx + 1.01)*t;
    else if(m===top)   api.player.y = (gy - 0.01)*t;
    else               api.player.y = (gy + 1.01)*t;
  }

  // ---------- painters (same look as today) ----------
  function fillTile(ctx,gx,gy,color){
    const sx = w2sX(gx*api.TILE), sy=w2sY(gy*api.TILE);
    ctx.fillStyle=color; ctx.fillRect(sx,sy, api.DRAW, api.DRAW);
  }
  function drawRoadTile(ctx,gx,gy){
    // sidewalk border feel
    fillTile(ctx,gx,gy,COL.walk);
    // street core
    const sx = w2sX(gx*api.TILE), sy=w2sY(gy*api.TILE);
    ctx.fillStyle = COL.road;
    ctx.fillRect(sx+api.DRAW*0.18, sy+api.DRAW*0.18, api.DRAW*0.64, api.DRAW*0.64);
    // little dashes like core (horizontal vibe)
    ctx.fillStyle = COL.dash;
    for(let i=0;i<4;i++){
      ctx.fillRect(sx + api.DRAW*(0.20 + i*0.20), sy + api.DRAW*0.48, api.DRAW*0.08, api.DRAW*0.04);
    }
  }
  function drawBuildingTile(ctx,gx,gy){
    const sx=w2sX(gx*api.TILE), sy=w2sY(gy*api.TILE);
    ctx.fillStyle = COL.b_blue;   // default block color (you can recolor later)
    ctx.fillRect(sx,sy, api.DRAW, api.DRAW);
    ctx.fillStyle='rgba(0,0,0,.08)';
    ctx.fillRect(sx,sy, api.DRAW, Math.floor(api.DRAW*0.18));
  }

  function drawMainOverlay(){
    if(!isTier2()) return;
    const ctx=document.getElementById('game').getContext('2d');
    ctx.save();
    // draw BEHIND sprites so player/cars/cops stay visible
    ctx.globalCompositeOperation = 'destination-over';

    // paint grass for Tier2 region so it doesn't look black
    for(let gy=TIER2.y0; gy<=TIER2.y1; gy++){
      for(let gx=TIER2.x0; gx<=TIER2.x1; gx++){
        fillTile(ctx,gx,gy,COL.grass);
      }
    }
    // custom roads
    for(const [gx,gy] of state.tiles.roads) drawRoadTile(ctx,gx,gy);
    // custom buildings (still behind sprites; solidity handled elsewhere)
    for(const [gx,gy] of state.tiles.buildings) drawBuildingTile(ctx,gx,gy);

    // show editor cursor
    if(state.edit.active){
      updateCursorFromPlayer();
      const gx=targetGX(), gy=targetGY();
      const sx=w2sX(gx*api.TILE), sy=w2sY(gy*api.TILE);
      ctx.strokeStyle='rgba(56,176,255,.85)';
      ctx.lineWidth=2;
      ctx.strokeRect(sx+2, sy+2, api.DRAW-4, api.DRAW-4);
    }

    ctx.restore();
  }

  // minimap / bigmap (super light)
  function drawMiniOverlay(){
    if(!isTier2()) return;
    const mini=document.getElementById('minimap'); if(!mini) return;
    const mctx=mini.getContext('2d'); const sx=mini.width/90, sy=mini.height/60;

    // roads
    mctx.fillStyle='#8a90a0';
    for(const [gx,gy] of state.tiles.roads)
      mctx.fillRect(gx*sx, gy*sy, 1*sx, 1*sy);

    // buildings
    mctx.fillStyle='#4c5a7a';
    for(const [gx,gy] of state.tiles.buildings)
      mctx.fillRect(gx*sx, gy*sy, 1*sx, 1*sy);
  }
  function drawBigOverlay(){
    if(!isTier2()) return;
    const big=document.getElementById('bigmap'); if(!big) return;
    const bctx=big.getContext('2d'); const sx=big.width/90, sy=big.height/60;

    bctx.fillStyle='#9aa2b5';
    for(const [gx,gy] of state.tiles.roads)
      bctx.fillRect(gx*sx, gy*sy, 1*sx, 1*sy);

    bctx.fillStyle='#5c6b8a';
    for(const [gx,gy] of state.tiles.buildings)
      bctx.fillRect(gx*sx, gy*sy, 1*sx, 1*sy);
  }

  // ---------- hooks ----------
  IZZA.on('ready', (a)=>{
    api=a;

    // tier: if M3 already completed, widen now
    state.tier = localStorage.getItem(MAP_TIER_KEY) || '1';
    if(isTier2()) widenCameraClampIfNeeded();

    loadTiles();
    ensureEditorUI();
    bindCanvasPick();

    // watch for tier change during play
    IZZA.on('update-post', ()=>{
      const cur = localStorage.getItem(MAP_TIER_KEY) || '1';
      if(cur !== state.tier){
        state.tier = cur;
        if(isTier2()) widenCameraClampIfNeeded();
      }
      if(isTier2()) pushOutOfBuildingTiles();
    });

    // also render custom layers when the big map opens
    const mapModal=document.getElementById('mapModal');
    if(mapModal){
      const obs=new MutationObserver(()=>{ if(mapModal.style.display==='flex') drawBigOverlay(); });
      obs.observe(mapModal, {attributes:true, attributeFilter:['style']});
    }
  });

  IZZA.on('render-post', ()=>{
    if(!isTier2()) return;
    drawMainOverlay();
    drawMiniOverlay();
    // big map is painted on open by the observer
  });

})();
