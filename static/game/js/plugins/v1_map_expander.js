// /static/game/js/plugins/v1_map_expander.js
(function () {
  const BUILD = 'v3.0-map-expander+downtown-stitch+render-under';
  console.log('[IZZA PLAY]', BUILD);

  const MAP_TIER_KEY = 'izzaMapTier';              // '1' | '2'
  const TIER2 = { x0: 10, y0: 12, x1: 80, y1: 50 };// expanded play box
  const TIER1 = { x0: 18, y0: 18, x1: 72, y1: 42 };// original area (never overwrite)

  const COL = {
    grass : '#09371c',
    road  : '#2a2a2a',
    dash  : '#ffd23f',
    side  : '#6a727b',
    red   : '#7a3a3a',
    shop  : '#203a60',
    civic : '#405a85',
    police: '#0a2455',
    library:'#8a5a2b',
    water : '#2b6a7a'
  };

  let api = null;
  const state = { tier: localStorage.getItem(MAP_TIER_KEY) || '1' };
  const isTier2 = () => state.tier === '2';

  // ---- math helpers ----
  const scl = () => api.DRAW / api.TILE;
  const w2sX = (wx) => (wx - api.camera.x) * scl();
  const w2sY = (wy) => (wy - api.camera.y) * scl();

  function coreHRoadY(){
    const doorGY = Math.floor(api.doorSpawn.y / api.TILE);
    return doorGY + 1; // same relationship as core
  }
  function coreVRoadX(){
    const doorGX = Math.floor((api.doorSpawn.x + 8) / api.TILE);
    return doorGX + 11; // same relationship as core
  }

  // clip segments so we never draw inside Tier-1
  const clipOutsideTier1 = {
    x(x0,x1){
      const out=[];
      if (x0 <= TIER1.x0 - 1) out.push([x0, Math.min(x1, TIER1.x0 - 1)]);
      if (x1 >= TIER1.x1 + 1) out.push([Math.max(x0, TIER1.x1 + 1), x1]);
      return out;
    },
    y(y0,y1){
      const out=[];
      if (y0 <= TIER1.y0 - 1) out.push([y0, Math.min(y1, TIER1.y0 - 1)]);
      if (y1 >= TIER1.y1 + 1) out.push([Math.max(y0, TIER1.y1 + 1), y1]);
      return out;
    }
  };

  function notIntersectTier1(b){
    const bx1=b.x, by1=b.y, bx2=b.x+b.w-1, by2=b.y+b.h-1;
    const ax1=TIER1.x0, ay1=TIER1.y0, ax2=TIER1.x1, ay2=TIER1.y1;
    const sep = bx2<ax1 || bx1>ax2 || by2<ay1 || by1>ay2;
    const in2 = bx1>=TIER2.x0 && by1>=TIER2.y0 && bx2<=TIER2.x1 && by2<=TIER2.y1;
    return sep && in2;
  }

  // ---- Build the “downtown stitch” layout off the core’s road spines
  function buildLayout(){
    const HR = coreHRoadY();
    const VX = coreVRoadX();

    const rows = [HR+6, HR+12, HR+18, HR+24];                // below the main horizontal
    const cols = [VX-16, VX-8, VX, VX+10, VX+22];            // around the avenue

    const H_ROADS = rows.map(y=>({
      y,
      x0: Math.max(TIER2.x0+2, VX-24),
      x1: Math.min(TIER2.x1-2, VX+28)
    }));
    const V_ROADS = cols.map(x=>({
      x,
      y0: rows[0]-1,
      y1: rows[rows.length-1]+1
    }));

    const BUILDINGS = [
      { x: VX-14, y: rows[0]-3, w: 5, h: 3, color: COL.red    },
      { x: VX-6,  y: rows[0]-3, w: 4, h: 3, color: COL.civic  },
      { x: VX+12, y: rows[0]-3, w: 5, h: 3, color: COL.shop   },

      { x: VX-20, y: rows[1]-3, w: 6, h: 3, color: COL.shop   },
      { x: VX-2,  y: rows[1]-3, w: 4, h: 3, color: COL.police },
      { x: VX+14, y: rows[1]-3, w: 5, h: 3, color: COL.civic  },

      { x: VX-18, y: rows[2]-3, w: 5, h: 3, color: COL.civic  },
      { x: VX+2,  y: rows[2]-3, w: 4, h: 3, color: COL.shop   },
      { x: VX+20, y: rows[2]-3, w: 5, h: 3, color: COL.library},

      { x: VX-10, y: rows[3]-3, w: 4, h: 3, color: COL.shop   },
      { x: VX+10, y: rows[3]-3, w: 4, h: 3, color: COL.civic  }
    ].filter(notIntersectTier1);

    const LAKES = [{ x: Math.min(TIER2.x1-8, VX+18), y: rows[3]+2, w: 6, h: 3 }];

    return { H_ROADS, V_ROADS, BUILDINGS, LAKES, HR, VX };
  }

  // ---- tile painters (MAIN CANVAS) ----
  function fillTile(ctx, gx, gy, color){
    const sx = w2sX(gx*api.TILE), sy = w2sY(gy*api.TILE);
    const S  = api.DRAW;
    ctx.fillStyle = color;
    ctx.fillRect(sx, sy, S, S);
  }

  function drawHRoadSegment(ctx, y, x0, x1){
    for(let x=x0; x<=x1; x++){
      fillTile(ctx, x, y, COL.road);
      const sx=w2sX(x*api.TILE), sy=w2sY(y*api.TILE), S=api.DRAW;
      ctx.fillStyle = COL.dash;
      for(let i=0;i<4;i++) ctx.fillRect(sx + i*(S/4) + S*0.05, sy + S*0.48, S*0.10, S*0.04);
    }
  }
  function drawVRoadSegment(ctx, x, y0, y1){
    for(let y=y0; y<=y1; y++) fillTile(ctx, x, y, COL.road);
  }

  function drawSidewalkRow(ctx, y, x0, x1){
    for(let x=x0; x<=x1; x++) fillTile(ctx, x, y, COL.side);
  }
  function drawSidewalkCol(ctx, x, y0, y1){
    for(let y=y0; y<=y1; y++) fillTile(ctx, x, y, COL.side);
  }

  function drawBuilding(ctx, b){
    for(let gy=b.y; gy<b.y+b.h; gy++){
      for(let gx=b.x; gx<b.x+b.w; gx++) fillTile(ctx, gx, gy, b.color);
    }
    const sx=w2sX(b.x*api.TILE), sy=w2sY(b.y*api.TILE);
    ctx.fillStyle='rgba(0,0,0,.15)';
    ctx.fillRect(sx, sy, b.w*api.DRAW, Math.floor(b.h*api.DRAW*0.18));
  }
  function drawLake(ctx, r){
    const sx=w2sX(r.x*api.TILE), sy=w2sY(r.y*api.TILE);
    ctx.fillStyle = COL.water;
    ctx.fillRect(sx, sy, r.w*api.DRAW, r.h*api.DRAW);
  }

  // NOTE: This is called from the **render-under** hook, so we paint BEFORE core tiles.
  function paintMainUnder(layout){
    const ctx = document.getElementById('game').getContext('2d');

    // 1) base grass ONLY outside Tier-1
    for(let gy=TIER2.y0; gy<=TIER2.y1; gy++){
      for(let gx=TIER2.x0; gx<=TIER2.x1; gx++){
        const inT1 = gx>=TIER1.x0 && gx<=TIER1.x1 && gy>=TIER1.y0 && gy<=TIER1.y1;
        if(!inT1) fillTile(ctx, gx, gy, COL.grass);
      }
    }

    // 2) sidewalks + roads (clipped outside Tier-1)
    layout.H_ROADS.forEach(r=>{
      clipOutsideTier1.x(r.x0, r.x1).forEach(([a,b])=>{
        drawSidewalkRow(ctx, r.y-1, a, b);
        drawSidewalkRow(ctx, r.y+1, a, b);
      });
      clipOutsideTier1.x(r.x0, r.x1).forEach(([a,b])=> drawHRoadSegment(ctx, r.y, a, b));
    });

    layout.V_ROADS.forEach(r=>{
      clipOutsideTier1.y(r.y0, r.y1).forEach(([a,b])=>{
        drawSidewalkCol(ctx, r.x-1, a, b);
        drawSidewalkCol(ctx, r.x+1, a, b);
      });
      clipOutsideTier1.y(r.y0, r.y1).forEach(([a,b])=> drawVRoadSegment(ctx, r.x, a, b));
    });

    // 3) solids + lakes
    layout.BUILDINGS.forEach(b=> drawBuilding(ctx, b));
    layout.LAKES.forEach(l=> drawLake(ctx, l));
  }

  // ---- minimap / bigmap (drawn any time) ----
  function drawMini(layout){
    const mini=document.getElementById('minimap');
    const ctx = mini && mini.getContext ? mini.getContext('2d') : null;
    if(!mini||!ctx) return;
    const sx = mini.width/90, sy = mini.height/60;

    ctx.fillStyle='#8a90a0';
    layout.H_ROADS.forEach(r=> ctx.fillRect(r.x0*sx, r.y*sy, (r.x1-r.x0+1)*sx, 1*sy));
    layout.V_ROADS.forEach(r=> ctx.fillRect(r.x*sx, r.y0*sy, 1*sx, (r.y1-r.y0+1)*sy));

    layout.BUILDINGS.forEach(b=>{ ctx.fillStyle=b.color; ctx.fillRect(b.x*sx, b.y*sy, b.w*sx, b.h*sy); });
    layout.LAKES.forEach(l=>{ ctx.fillStyle='#7db7d9'; ctx.fillRect(l.x*sx, l.y*sy, l.w*sx, l.h*sy); });
  }

  function drawBig(layout){
    const big=document.getElementById('bigmap');
    const ctx = big && big.getContext ? big.getContext('2d') : null;
    if(!big||!ctx) return;
    const sx = big.width/90, sy = big.height/60;

    ctx.fillStyle='#8a90a0';
    layout.H_ROADS.forEach(r=> ctx.fillRect(r.x0*sx, r.y*sy, (r.x1-r.x0+1)*sx, 1.2*sy));
    layout.V_ROADS.forEach(r=> ctx.fillRect(r.x*sx, r.y0*sy, 1.2*sx, (r.y1-r.y0+1)*sy));

    layout.BUILDINGS.forEach(b=>{ ctx.fillStyle=b.color; ctx.fillRect(b.x*sx, b.y*sy, b.w*sx, b.h*sy); });
    layout.LAKES.forEach(l=>{ ctx.fillStyle='#7db7d9'; ctx.fillRect(l.x*sx, l.y*sy, l.w*sx, l.h*sy); });
  }

  // ---- collisions for new buildings only ----
  function pushOutOfDowntown(layout){
    const t=api.TILE, px=api.player.x, py=api.player.y;
    const gx=(px/t)|0, gy=(py/t)|0;
    for(const b of layout.BUILDINGS){
      if(gx>=b.x && gx<b.x+b.w && gy>=b.y && gy<b.y+b.h){
        const dxL=Math.abs(px-b.x*t);
        const dxR=Math.abs((b.x+b.w)*t-px);
        const dyT=Math.abs(py-b.y*t);
        const dyB=Math.abs((b.y+b.h)*t-py);
        const m=Math.min(dxL,dxR,dyT,dyB);
        if(m===dxL) api.player.x=(b.x-0.01)*t;
        else if(m===dxR) api.player.x=(b.x+b.w+0.01)*t;
        else if(m===dyT) api.player.y=(b.y-0.01)*t;
        else api.player.y=(b.y+b.h+0.01)*t;
        break;
      }
    }
  }

  // ---- widen camera to Tier 2 ----
  function widenCameraClamp(){
    if(widenCameraClamp._done) return;
    widenCameraClamp._done = true;
    IZZA.on('update-post', ()=>{
      if(!isTier2()) return;
      const visW = document.getElementById('game').width  / scl();
      const visH = document.getElementById('game').height / scl();
      const maxX = (TIER2.x1+1)*api.TILE - visW;
      const maxY = (TIER2.y1+1)*api.TILE - visH;
      api.camera.x = Math.max(TIER2.x0*api.TILE, Math.min(api.camera.x, maxX));
      api.camera.y = Math.max(TIER2.y0*api.TILE, Math.min(api.camera.y, maxY));
    });
  }

  // ---- hooks ----
  let layout=null;

  IZZA.on('ready', (a)=>{
    api=a;
    state.tier = localStorage.getItem(MAP_TIER_KEY) || '1';
    if(isTier2()){
      widenCameraClamp();
      layout = buildLayout();
    }

    // paint big map when modal opens
    const mapModal = document.getElementById('mapModal');
    if(mapModal){
      const obs = new MutationObserver(()=>{ if(mapModal.style.display==='flex' && layout) drawBig(layout); });
      obs.observe(mapModal, { attributes:true, attributeFilter:['style'] });
    }
  });

  // main drawing happens BEFORE core via your new hook
  IZZA.on('render-under', ()=>{
    if(!isTier2()) return;
    if(!layout) layout = buildLayout();
    paintMainUnder(layout);
  });

  // after core updates: collisions + minimap
  IZZA.on('update-post', ()=>{
    const cur = localStorage.getItem(MAP_TIER_KEY) || '1';
    if(cur !== state.tier){
      state.tier = cur;
      if(isTier2()){
        widenCameraClamp();
        layout = buildLayout();
      }
    }
    if(isTier2() && layout) pushOutOfDowntown(layout);
  });

  IZZA.on('render-post', ()=>{
    if(!isTier2()) return;
    if(!layout) layout = buildLayout();
    drawMini(layout);
  });
})();
