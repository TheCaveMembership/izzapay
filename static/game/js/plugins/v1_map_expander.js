// downtown_clip_safe_layout.js — Tier-2 expansion (clip-safe; sidewalks everywhere; never repaint Tier-1)
(function () {
  const TIER_KEY = 'izzaMapTier';

  // -------- Palette -------
  const COL = {
    grass:'#09371c',
    road:'#2a2a2a', dash:'#ffd23f', sidewalk:'#6a727b',
    civic:'#405a85', police:'#0a2455', shop:'#203a60',
    park:'#2b6a7a',
    water:'#1a4668', sand:'#e0c27b', wood:'#6b4a2f',
    hotel:'#7a4e2f',
    house:'#7b6a42',
    hoodPark:'#135c33',
    lot:'#474747',
    hospital:'#b94a48',
    doorBlue:'#5aa0ff',
    doorGreen:'#35d27a'
  };
  const isTier2 = ()=> localStorage.getItem(TIER_KEY)==='2';

  // ---------- Core anchors ----------
  function unlockedRect(t){ return (t!=='2') ? {x0:18,y0:18,x1:72,y1:42} : {x0:10,y0:12,x1:80,y1:50}; }
  function anchors(api){
    const tier = localStorage.getItem(TIER_KEY)||'1';
    const un = unlockedRect(tier);

    const bW=10,bH=6;
    const bX = Math.floor((un.x0+un.x1)/2) - Math.floor(bW/2);
    const bY = un.y0 + 5;

    const hRoadY       = bY + bH + 1;
    const sidewalkTopY = hRoadY - 1;
    const sidewalkBotY = hRoadY + 1;

    // Original Tier-1 vertical (keep)
    const vRoadX         = Math.min(un.x1-3, bX + bW + 6);
    const vSidewalkLeftX = vRoadX - 1;
    const vSidewalkRightX= vRoadX + 1;

    const shop = { w:8, h:5, x:vSidewalkRightX+1, y: sidewalkTopY-5 };
    const door = { gx: bX + Math.floor(bW/2), gy: sidewalkTopY };
    const register  = { gx: vSidewalkRightX, gy: sidewalkTopY };

    const HQ  = {x0:bX, y0:bY, x1:bX+bW-1, y1:bY+bH-1};
    const SH  = {x0:shop.x, y0:shop.y, x1:shop.x+shop.w-1, y1:shop.y+shop.h-1};

    return {un,bX,bY,bW,bH,hRoadY,sidewalkTopY,sidewalkBotY,vRoadX,vSidewalkLeftX,vSidewalkRightX,shop,HQ,SH,door,register};
  }

  // ---------- Lakefront ----------
  function lakeRects(a){
    const LAKE = { x0: a.un.x1-14, y0: a.un.y0+23, x1: a.un.x1, y1: a.un.y1 };
    const BEACH_X = LAKE.x0 - 1;
    const DOCKS = [
      { x0: LAKE.x0, y: LAKE.y0+4,  len: 3 },
      { x0: LAKE.x0, y: LAKE.y0+12, len: 4 }
    ];
    // Hotel pulled back behind sidewalk + lot
    const hotelTopY = LAKE.y0 - 5; // 1 sidewalk + 3 lot + 1 buffer
    const HOTEL  = { x0: LAKE.x0+3, y0: hotelTopY, x1: LAKE.x0+9, y1: hotelTopY+3 };
    const LOT    = { x0: HOTEL.x0,  y0: HOTEL.y1+1, x1: HOTEL.x1,  y1: HOTEL.y1+3 };

    return {LAKE, BEACH_X, DOCKS, HOTEL, LOT};
  }

  // ---------- Bottom-left neighborhood ----------
  function hoodRects(a){
    const HOOD   = { x0:a.un.x0+2, y0:a.un.y1-8, x1:a.un.x0+26, y1:a.un.y1-0 };
    const HOOD_H = [ HOOD.y0+2, HOOD.y0+6 ];
    const HOOD_V = [ HOOD.x0+8, HOOD.x0+16 ];
    const HOUSES = [
      {x0:HOOD.x0+3, y0:HOOD.y0+4, x1:HOOD.x0+5, y1:HOOD.y0+5},
      {x0:HOOD.x0+11,y0:HOOD.y0+4, x1:HOOD.x0+13,y1:HOOD.y0+5},
      {x0:HOOD.x0+19,y0:HOOD.y0+4, x1:HOOD.x0+21,y1:HOOD.y0+5},
      {x0:HOOD.x0+5, y0:HOOD.y0+9, x1:HOOD.x0+7, y1:HOOD.y0+10},
      {x0:HOOD.x0+13,y0:HOOD.y0+9, x1:HOOD.x0+15,y1:HOOD.y0+10}
    ];
    const HOOD_PARK = { x0: HOOD.x0+22, y0: HOOD.y0+6, x1: HOOD.x0+26, y1: HOOD.y0+9 };
    return {HOOD, HOOD_H, HOOD_V, HOUSES, HOOD_PARK};
  }

  // ---------- Helpers ----------
  const _inRect=(gx,gy,R)=> gx>=R.x0 && gx<=R.x1 && gy>=R.y0 && gy<=R.y1;
  const scl = api => api.DRAW/api.TILE;
  const w2sX=(api,wx)=>(wx-api.camera.x)*scl(api);
  const w2sY=(api,wy)=>(wy-api.camera.y)*scl(api);
  function fillTile(api,ctx,gx,gy,color){
    const S=api.DRAW, sx=w2sX(api,gx*api.TILE), sy=w2sY(api,gy*api.TILE);
    ctx.fillStyle=color; ctx.fillRect(sx,sy,S,S);
  }

  // ---------- Protect the original Tier-1 tiles ----------
  function isOriginalTile(gx,gy,a){
    if (_inRect(gx,gy,{x0:a.HQ.x0-1,y0:a.HQ.y0-1,x1:a.HQ.x1+1,y1:a.HQ.y1+1})) return true;
    if (_inRect(gx,gy,{x0:a.SH.x0-1,y0:a.SH.y0-1,x1:a.SH.x1+1,y1:a.SH.y1+1})) return true;
    if (gy===a.hRoadY || gy===a.sidewalkTopY || gy===a.sidewalkBotY) return true;
    if (gx===a.vRoadX || gx===a.vSidewalkLeftX || gx===a.vSidewalkRightX) return true;
    return false;
  }

  // ---------- Road plan ----------
  function desiredRoadGrid(a){
    const H = [ a.hRoadY - 10, a.hRoadY, a.hRoadY + 6 ];
    const V = [ a.vRoadX - 12, a.vRoadX + 10 ];
    return {H, V};
  }

  // Clip helpers
  function clipHRow(y, x0, x1, forbiddenRects){
    let parts=[{y, x0, x1}];
    forbiddenRects.forEach(R=>{
      parts = parts.flatMap(p=>{
        if(p.y<R.y0||p.y>R.y1||p.x1<R.x0||p.x0>R.x1) return [p];
        const out=[];
        if(p.x0 < R.x0) out.push({y:p.y, x0:p.x0, x1:R.x0-1});
        if(p.x1 > R.x1) out.push({y:p.y, x0:R.x1+1, x1:p.x1});
        return out;
      });
    });
    return parts.filter(p=>p.x1>=p.x0);
  }
  function clipVCol(x, y0, y1, forbiddenRects){
    let parts=[{x, y0, y1}];
    forbiddenRects.forEach(R=>{
      parts = parts.flatMap(p=>{
        if(p.x<R.x0||p.x>R.x1||p.y1<R.y0||p.y0>R.y1) return [p];
        const out=[];
        if(p.y0 < R.y0) out.push({x:p.x, y0:p.y0, y1:R.y0-1});
        if(p.y1 > R.y1) out.push({x:p.x, y0:R.y1+1, y1:p.y1});
        return out;
      });
    });
    return parts.filter(p=>p.y1>=p.y0);
  }

  // Dead-end shavers
  function shaveDeadEndsH(seg, forbidden){
    const near = (x,y)=> forbidden.some(R=> x===R.x0-1 && y>=R.y0 && y<=R.y1 || x===R.x1+1 && y>=R.y0 && y<=R.y1 );
    if(seg.x0<seg.x1){
      if(near(seg.x0,seg.y)) seg.x0++;
      if(near(seg.x1,seg.y)) seg.x1--;
    }
    return (seg.x0<=seg.x1)? seg : null;
  }
  function shaveDeadEndsV(seg, forbidden){
    const near = (x,y)=> forbidden.some(R=> y===R.y0-1 && x>=R.x0 && x<=R.x1 || y===R.y1+1 && x>=R.x0 && x<=R.x1 );
    if(seg.y0<seg.y1){
      if(near(seg.x,seg.y0)) seg.y0++;
      if(near(seg.x,seg.y1)) seg.y1--;
    }
    return (seg.y0<=seg.y1)? seg : null;
  }

  // Small util so yellow dashes appear on H roads only
  function drawHRoad(api,ctx,y,x0,x1){
    for(let x=x0;x<=x1;x++){
      fillTile(api,ctx,x,y,COL.road);
      const S=api.DRAW, sx=w2sX(api,x*api.TILE), sy=w2sY(api,y*api.TILE);
      ctx.fillStyle=COL.dash;
      for(let i=0;i<4;i++) ctx.fillRect(sx+i*(S/4)+S*0.05, sy+S*0.48, S*0.10, S*0.04);
    }
  }
  function drawVRoad(api,ctx,x,y0,y1){ for(let y=y0;y<=y1;y++) fillTile(api,ctx,x,y,COL.road); }

  // ---------- Lake helpers for collisions / overlay ----------
  // (kept: NO boat logic here)
  function dockCells(){
    const api=IZZA.api, A=anchors(api), {DOCKS}=lakeRects(A);
    const set=new Set();
    DOCKS.forEach(d=>{ for(let i=0;i<d.len;i++) set.add((d.x0+i)+'|'+d.y); });
    return set;
  }

  // ---------- HOSPITAL ----------
  let _layout=null, _hospital=null, _hospitalDoor=null, _shopOpen=false;

  // === Hearts/coins helpers wired to your existing plugins ===
  const HEARTS_LS_KEY = 'izzaCurHeartSegments';
  function _heartsMax(){ const p=IZZA.api?.player||{}; return p.maxHearts||p.heartsMax||3; }
  function _getSegs(){
    const p=IZZA.api?.player||{};
    if(typeof p.heartSegs==='number') return p.heartSegs|0;
    const max = _heartsMax()*3;
    const raw = parseInt(localStorage.getItem(HEARTS_LS_KEY) || String(max), 10);
    return Math.max(0, Math.min(max, isNaN(raw)? max : raw));
  }
  function _setSegs(v){
    const p=IZZA.api?.player||{};
    const max = _heartsMax()*3;
    const seg = Math.max(0, Math.min(max, v|0));
    p.heartSegs = seg;
    localStorage.setItem(HEARTS_LS_KEY, String(seg));
    _redrawHeartsHud();
  }
  function _redrawHeartsHud(){
    const hud = document.getElementById('heartsHud'); if(!hud) return;
    const maxH=_heartsMax(), seg=_getSegs();
    const PATH='M12 21c-.5-.5-4.9-3.7-7.2-6C3 13.2 2 11.6 2 9.7 2 7.2 4 5 6.6 5c1.6 0 3 .8 3.8 2.1C11.2 5.8 12.6 5 14.2 5 16.8 5 19 7.2 19 9.7c0 1.9-1 3.5-2.8 5.3-2.3 2.3-6.7 5.5-7.2 6Z';
    const NS='http://www.w3.org/2000/svg';
    hud.innerHTML='';
    for(let i=0;i<maxH;i++){
      const s=Math.max(0,Math.min(3,seg - i*3)), ratio=s/3;
      const svg=document.createElementNS(NS,'svg');
      svg.setAttribute('viewBox','0 0 24 22'); svg.setAttribute('width','24'); svg.setAttribute('height','22');
      const base=document.createElementNS(NS,'path'); base.setAttribute('d',PATH); base.setAttribute('fill','#3a3f4a'); svg.appendChild(base);
      const cid='hclip_'+Math.random().toString(36).slice(2);
      const clip=document.createElementNS(NS,'clipPath'); clip.setAttribute('id',cid);
      const r=document.createElementNS(NS,'rect'); r.setAttribute('x','0'); r.setAttribute('y','0'); r.setAttribute('width',String(24*Math.max(0,Math.min(1,ratio)))); r.setAttribute('height','22');
      clip.appendChild(r); svg.appendChild(clip);
      const red=document.createElementNS(NS,'path'); red.setAttribute('d',PATH); red.setAttribute('fill','#ff5555'); red.setAttribute('clip-path',`url(#${cid})`);
      svg.appendChild(red);
      const wrap=document.createElement('div'); wrap.style.width='24px'; wrap.style.height='22px'; wrap.appendChild(svg); hud.appendChild(wrap);
    }
  }

  // Create a simple popup the first time we need it
  function ensureShopUI(){
    if(document.getElementById('hospitalShop')) return;
    const d=document.createElement('div');
    d.id='hospitalShop';
    d.style.cssText='position:absolute;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.45);z-index:50;';
    d.innerHTML =
      `<div style="min-width:260px;background:#111b29;border:1px solid #2b3b57;border-radius:10px;padding:14px;color:#e7eef7;box-shadow:0 10px 30px rgba(0,0,0,.5)">
         <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
           <strong style="font-size:16px">Hospital</strong>
           <button id="hsClose" style="background:#263447;color:#cfe3ff;border:0;border-radius:6px;padding:6px 10px;cursor:pointer">Close</button>
         </div>
         <div id="hsCoins" style="opacity:.85;margin-bottom:8px"></div>
         <button id="hsBuy" style="width:100%;padding:10px;border:0;border-radius:8px;background:#1f6feb;color:#fff;font-weight:600;cursor:pointer">
           ❤️ Heart Refill — 100 IC
         </button>
       </div>`;
    document.body.appendChild(d);
    d.querySelector('#hsClose').onclick = ()=> hospitalClose();
    d.querySelector('#hsBuy').onclick   = ()=> hospitalBuy();
  }
  function hospitalOpen(){
    ensureShopUI();
    const api=IZZA.api; if(!api?.ready) return;
    document.getElementById('hsCoins').textContent = `Coins: ${api.getCoins()} IC`;
    document.getElementById('hospitalShop').style.display='flex';
    _shopOpen=true;
  }
  function hospitalClose(){
    const el=document.getElementById('hospitalShop'); if(el) el.style.display='none';
    _shopOpen=false;
  }
  function hospitalBuy(){
    const api=IZZA.api; if(!api?.ready) return;

    const coins = api.getCoins();
    if(coins < 100){ alert('Not enough IZZA Coins'); return; }

    const maxSegs = _heartsMax()*3;
    const curSegs = _getSegs();
    if(curSegs >= maxSegs){ alert('Hearts are already full'); return; }

    // top off current heart first, else add a full heart (3 segs)
    const remInCurrent = curSegs % 3;                 // 0..2
    const topOff = remInCurrent===0 ? 0 : (3-remInCurrent); // 0,1,2
    const gain = topOff>0 ? topOff : Math.min(3, maxSegs - curSegs);

    api.setCoins(coins - 100);
    _setSegs(curSegs + gain);

    IZZA.toast?.(topOff>0 ? 'Heart topped up!' : '+1 heart!');
    // refresh display
    const hc=document.getElementById('hsCoins'); if(hc) hc.textContent=`Coins: ${api.getCoins()} IC`;
  }

  // ---------- INPUT: Button B opens the hospital (boat toggle removed) ----------
  function onPressB(e){
    const api=IZZA.api; if(!api?.ready) return;

    if(_hospitalDoor){
      const t=api.TILE, gx=((api.player.x+16)/t|0), gy=((api.player.y+16)/t|0);
      const near = Math.abs(gx-_hospitalDoor.x)<=1 && Math.abs(gy-_hospitalDoor.y)<=1;
      if(near){
        if(e){ e.preventDefault?.(); e.stopImmediatePropagation?.(); e.stopPropagation?.(); }
        hospitalOpen();
      }
    }
  }
  // capture-phase so we can preempt other B handlers when near the door
  document.getElementById('btnB')?.addEventListener('click', onPressB, true);
  window.addEventListener('keydown', e=>{ if(e.key.toLowerCase()==='b') onPressB(e); }, true);

  // ---------- RENDER UNDER ----------
  IZZA.on('render-under', ()=>{
    if(!IZZA.api?.ready || !isTier2()) return;
    const api=IZZA.api, ctx=document.getElementById('game').getContext('2d');
    const A = anchors(api);
    const {LAKE, BEACH_X, DOCKS, HOTEL, LOT} = lakeRects(A);
    const {HOOD, HOOD_H, HOOD_V, HOUSES, HOOD_PARK} = hoodRects(A);

    // Forbidden areas for MAIN road plan
    const FORBID = [
      {x0:LAKE.x0,y0:LAKE.y0,x1:LAKE.x1,y1:LAKE.y1},
      {x0:A.HQ.x0-1,y0:A.HQ.y0-1,x1:A.HQ.x1+1,y1:A.HQ.y1+1},
      {x0:A.SH.x0-1,y0:A.SH.y0-1,x1:A.SH.x1+1,y1:A.SH.y1+1}
    ];

    const {H,V} = desiredRoadGrid(A);

    // Build road lists (then shave near HQ/Shop)
    let H_ROADS = [];
    let V_ROADS = [];
    H.forEach(y=>{
      const segs = clipHRow(y, A.un.x0, A.un.x1, FORBID);
      segs.forEach(s=>{
        const shaved = shaveDeadEndsH({y:s.y,x0:s.x0,x1:s.x1}, FORBID);
        if(shaved) H_ROADS.push(shaved);
      });
    });
    V.forEach(x=>{
      const segs = clipVCol(x, A.un.y0, A.un.y1, FORBID);
      segs.forEach(s=>{
        const shaved = shaveDeadEndsV({x:s.x,y0:s.y0,y1:s.y1}, FORBID);
        if(shaved) V_ROADS.push(shaved);
      });
    });

    // Sets for intersection logic
    const H_ROWS_ALL = new Set([...H_ROADS.map(r=>r.y), ...HOOD_H]);
    const V_COLS_ALL = new Set([...V_ROADS.map(r=>r.x), ...HOOD_V]);
    const isTier1Y = y => (y===A.hRoadY || y===A.sidewalkTopY || y===A.sidewalkBotY);

    // --- Sidewalks (draw before roads). Intersections FIX:
    const markSW = new Set();
    const seen = (gx,gy)=>{ const k=gx+'|'+gy; if(markSW.has(k)) return true; markSW.add(k); return false; };

    // H-road sidewalks
    H_ROADS.forEach(r=>{
      for(let x=r.x0;x<=r.x1;x++){
        if(!V_COLS_ALL.has(x)){ if(!isOriginalTile(x, r.y-1, A)) if(!seen(x,r.y-1)) fillTile(api,ctx,x,r.y-1,COL.sidewalk); }
        if(!V_COLS_ALL.has(x)){ if(!isOriginalTile(x, r.y+1, A)) if(!seen(x,r.y+1)) fillTile(api,ctx,x,r.y+1,COL.sidewalk); }
      }
    });

    // V-road sidewalks (skip at H rows and Tier-1 rows)
    V_ROADS.forEach(r=>{
      for(let y=r.y0;y<=r.y1;y++){
        if(H_ROWS_ALL.has(y) || isTier1Y(y)) continue;
        if(!isOriginalTile(r.x-1, y, A)) if(!seen(r.x-1,y)) fillTile(api,ctx,r.x-1,y,COL.sidewalk);
        if(!isOriginalTile(r.x+1, y, A)) if(!seen(r.x+1,y)) fillTile(api,ctx,r.x+1,y,COL.sidewalk);
      }
    });

    // Roads
    H_ROADS.forEach(r=>{
      for(let x=r.x0;x<=r.x1;x++){ if(!isOriginalTile(x, r.y, A)) fillTile(api,ctx,x,r.y,COL.road); }
      drawHRoad(api,ctx,r.y,r.x0,r.x1);
    });
    V_ROADS.forEach(r=>{
      for(let y=r.y0;y<=r.y1;y++){ if(!isOriginalTile(r.x, y, A)) fillTile(api,ctx,r.x,y,COL.road); }
      drawVRoad(api,ctx,r.x,r.y0,r.y1);
    });

    // --- Downtown small buildings (front-of-HQ removal kept)
    const REMOVE_RECT_4226 = {x0:42,y0:26,x1:44,y1:27};
    const BUILDINGS = [
      {x:A.vRoadX+11, y:A.hRoadY-9, w:6, h:3, color:COL.civic},
      {x:A.vRoadX+8,  y:A.hRoadY+9, w:7, h:4, color:COL.shop},
      {x:A.vRoadX-14, y:A.hRoadY+2, w:3, h:2, color:COL.shop},
      {x:A.vRoadX-6,  y:A.hRoadY-2, w:3, h:2, color:COL.shop}
    ].filter(b=>{
      for(let gx=b.x; gx<b.x+b.w; gx++)
        for(let gy=b.y; gy<b.y+b.h; gy++)
          if (_inRect(gx,gy,LAKE) || isOriginalTile(gx,gy,A) || _inRect(gx,gy,REMOVE_RECT_4226)) return false;
      return true;
    });
    BUILDINGS.forEach(b=>{
      for(let gy=b.y; gy<b.y+b.h; gy++)
        for(let gx=b.x; gx<b.x+b.w; gx++)
          if(!_inRect(gx,gy,LAKE) && !isOriginalTile(gx,gy,A)) fillTile(api,ctx,gx,gy,b.color);
      const sx=w2sX(api,b.x*api.TILE), sy=w2sY(api,b.y*api.TILE);
      ctx.fillStyle='rgba(0,0,0,.15)'; ctx.fillRect(sx,sy, b.w*api.DRAW, Math.floor(b.h*api.DRAW*0.18));
    });

    // --- Hotel block
    for(let gx=LOT.x0; gx<=LOT.x1; gx++) fillTile(api,ctx,gx,LOT.y0-1,COL.sidewalk);
    for(let gy=LOT.y0; gy<=LOT.y1; gy++)
      for(let gx=LOT.x0; gx<=LOT.x1; gx++) fillTile(api,ctx,gx,gy,COL.lot);
    for(let gy=HOTEL.y0; gy<=HOTEL.y1; gy++)
      for(let gx=HOTEL.x0; gx<=HOTEL.x1; gx++) fillTile(api,ctx,gx,gy,COL.hotel);

    // --- Neighborhood roads (reach edges; avoid hood park)
    HOOD_H.forEach(y=>{
      for(let x=A.un.x0; x<=A.un.x1; x++){
        if(!V_COLS_ALL.has(x)){ fillTile(api,ctx,x,y-1,COL.sidewalk); }
        if(!V_COLS_ALL.has(x)){ fillTile(api,ctx,x,y+1,COL.sidewalk); }
      }
    });
    HOOD_V.forEach(x=>{
      for(let y=A.un.y0; y<=A.un.y1; y++){
        if(new Set(HOOD_H).has(y)) continue;
        fillTile(api,ctx,x-1,y,COL.sidewalk);
        fillTile(api,ctx,x+1,y,COL.sidewalk);
      }
    });
    HOOD_H.forEach(y=>{
      const segs = clipHRow(y, A.un.x0, A.un.x1, [HOOD_PARK]);
      segs.forEach(s=> drawHRoad(api,ctx,y, s.x0, s.x1));
    });
    HOOD_V.forEach(x=>{
      const segs = clipVCol(x, A.un.y0, A.un.y1, [HOOD_PARK]);
      segs.forEach(s=> drawVRoad(api,ctx,x, s.y0, s.y1));
    });

    // hood park
    for(let gy=HOOD_PARK.y0; gy<=HOOD_PARK.y1; gy++)
      for(let gx=HOOD_PARK.x0; gx<=HOOD_PARK.x1; gx++) fillTile(api,ctx,gx,gy,COL.hoodPark);

    // houses (behind sidewalks)
    HOUSES.forEach(h=>{
      for(let gy=h.y0; gy<=h.y1; gy++)
        for(let gx=h.x0; gx<=h.x1; gx++) fillTile(api,ctx,gx,gy,COL.house);
    });

    // --- Lake / beach / docks
    for(let gy=LAKE.y0; gy<=LAKE.y1; gy++)
      for(let gx=LAKE.x0; gx<=LAKE.x1; gx++) fillTile(api,ctx,gx,gy,COL.water);
    for(let gy=LAKE.y0; gy<=LAKE.y1; gy++) fillTile(api,ctx,BEACH_X,gy,COL.sand);
    ctx.fillStyle=COL.wood;
    DOCKS.forEach(d=>{
      const S=api.DRAW, sx=w2sX(api,d.x0*api.TILE), sy=w2sY(api,d.y*api.TILE);
      ctx.fillRect(sx,sy, d.len*S, S);
    });

    // ====== MANUAL PATCHES & HOSPITAL ======
    const set = (x,y,color)=> fillTile(api,ctx,x,y,color);
    const lineH = (x0,x1,y,color)=>{ for(let x=x0; x<=x1; x++) set(x,y,color); };
    const rect = (x0,y0,x1,y1,color)=>{ for(let y=y0;y<=y1;y++) for(let x=x0;x<=x1;x++) set(x,y,color); };

    // Your prior patches (kept)
    set(44,15,COL.sidewalk);
    [15,16,17].forEach(x=> set(x,46,COL.house));
    [23,24,25].forEach(x=> set(x,46,COL.house));
    [31,32,33].forEach(x=> set(x,46,COL.house));
    [49,47,45,43].forEach(y=> set(56,y,COL.road));
    lineH(69,76,31,COL.sidewalk); lineH(69,76,30,COL.road);
    lineH(66,72,15,COL.sidewalk); set(67,16,COL.house); set(67,17,COL.house);
    rect(42,26,44,27,COL.grass);
    set(43,26,COL.sidewalk); set(43,27,COL.sidewalk); set(44,26,COL.road); set(44,27,COL.road);
    set(27,24,COL.road); set(29,24,COL.road);
    set(65,34,COL.sidewalk); set(66,34,COL.road); set(67,34,COL.sidewalk);
    [ {x:29,y:14},{x:27,y:14},{x:21,y:14},{x:19,y:14},
      {x:21,y:24},{x:19,y:24},{x:19,y:30},{x:21,y:30},{x:27,y:30},{x:29,y:30}
    ].forEach(p=> set(p.x,p.y,COL.road));

    // Hospital building near (34,37)
    _hospital = { x0:32, y0:36, x1:36, y1:39, color:COL.hospital };
    _hospitalDoor = { x:34, y:35 };
    for(let gy=_hospital.y0; gy<=_hospital.y1; gy++)
      for(let gx=_hospital.x0; gx<=_hospital.x1; gx++) fillTile(api,ctx,gx,gy,_hospital.color);

    // Door tile: blue by default; turns green if player within 1 tile
    const t=api.TILE, pgx=((api.player.x+16)/t|0), pgy=((api.player.y+16)/t|0);
    const nearDoor = Math.abs(pgx-_hospitalDoor.x)<=1 && Math.abs(pgy-_hospitalDoor.y)<=1;
    set(_hospitalDoor.x, _hospitalDoor.y, nearDoor ? COL.doorGreen : COL.doorBlue);

    _layout = {
      H_ROADS, V_ROADS, BUILDINGS, HOTEL, LOT, LAKE, HOOD, HOUSES, HOOD_PARK,
      patches:{
        solidSingles: [{x:67,y:16},{x:67,y:17}],
        solidHouses:  [{x0:15,y0:46,x1:17,y1:46},{x0:23,y0:46,x1:25,y1:46},{x0:31,y0:46,x1:33,y1:46}],
        removedBuilding: {x0:42,y0:26,x1:44,y1:27},
        walkableOverride: [{x0:69,y0:31,x1:76,y1:31}]
      }
    };
  });

  // ---------- Collisions & movement ----------
  function rectW (r){ return r.x1-r.x0+1; }
  function rectH (r){ return r.y1-r.y0+1; }

  IZZA.on('update-pre', ()=>{
    if(!IZZA.api?.ready || !isTier2()) return;
    const api=IZZA.api;

    // cars bounce off new buildings
    if(_layout){
      api.cars.forEach(c=>{
        const t=api.TILE, cgx=(c.x/t)|0, cgy=(c.y/t)|0;
        const hitB = _layout.BUILDINGS?.some(b=> cgx>=b.x && cgx<b.x+b.w && cgy>=b.y && cgy<b.y+b.h);
        const hitH = cgx>=_layout.HOTEL.x0 && cgx<=_layout.HOTEL.x1 && cgy>=_layout.HOTEL.y0 && cgy<=_layout.HOTEL.y1;
        if(hitB||hitH){ c.dir*=-1; c.x += c.dir*4; }
      });
    }
  });

  IZZA.on('update-post', ()=>{
    if(!IZZA.api?.ready || !isTier2() || !_layout) return;
    const api=IZZA.api, t=api.TILE, p=api.player;
    const gx=(p.x/t)|0, gy=(p.y/t)|0;

    const solids = [];
    _layout.BUILDINGS?.forEach(b=> solids.push({x:b.x,y:b.y,w:b.w,h:b.h}));
    solids.push({x:_layout.HOTEL.x0,y:_layout.HOTEL.y0,w:rectW(_layout.HOTEL),h:rectH(_layout.HOTEL)});
    _layout.HOUSES.forEach(h=> solids.push({x:h.x0,y:h.y0,w:rectW(h),h:rectH(h)}));

    // Hospital solid
    if(_hospital){ solids.push({x:_hospital.x0,y:_hospital.y0,w:rectW(_hospital),h:rectH(_hospital)}); }

    // Manual solid house strips + singles
    (_layout.patches?.solidHouses||[]).forEach(r=> solids.push({x:r.x0,y:r.y0,w:rectW(r),h:rectH(r)}));
    (_layout.patches?.solidSingles||[]).forEach(c=> solids.push({x:c.x,y:c.y,w:1,h:1}));

    // Water is solid except beach & planks — BUT skip this while boating
const LAKE=_layout.LAKE, BEACH_X=lakeRects(anchors(api)).BEACH_X;
const waterIsSolid = (x,y)=>{
  if(!_inRect(x,y,LAKE)) return false;
  if(x===BEACH_X) return false;
  if(dockCells().has(x+'|'+y)) return false;
  return true;
};

if (!window._izzaBoatActive) {             // <— add this guard
  if (waterIsSolid(gx,gy)) {
    solids.push({x:LAKE.x0,y:LAKE.y0,w:rectW(LAKE),h:rectH(LAKE)});
  }
}

    // Exclude walkable override areas (e.g., sidewalk 69..76,31)
    const overrides = _layout.patches?.walkableOverride || [];
    const isOverridden = (x,y)=> overrides.some(r=> x>=r.x0 && x<=r.x1 && y>=r.y0 && y<=r.y1);

    // Simple AABB resolve
    for(const b of solids){
      if(isOverridden(gx,gy)) break;
      if(gx>=b.x && gx<b.x+b.w && gy>=b.y && gy<b.y+b.h){
        const dxL=Math.abs(p.x-b.x*t), dxR=Math.abs((b.x+b.w)*t-p.x);
        const dyT=Math.abs(p.y-b.y*t), dyB=Math.abs((b.y+b.h)*t-p.y);
        const m=Math.min(dxL,dxR,dyT,dyB);
        if(m===dxL) p.x=(b.x-0.01)*t;
        else if(m===dxR) p.x=(b.x+b.w+0.01)*t;
        else if(m===dyT) p.y=(b.y-0.01)*t;
        else             p.y=(b.y+b.h+0.01)*t;
        break;
      }
    }
  });

  // ---------- Hospital interaction (A still heals if you stand on the door)
  function tryHospitalHeal(){
    const api=IZZA.api; if(!_hospital || !_hospitalDoor || !api?.ready) return;
    const t=api.TILE, gx=((api.player.x+16)/t|0), gy=((api.player.y+16)/t|0);
    if(gx!==_hospitalDoor.x || gy!==_hospitalDoor.y) return;

    const coins = api.getCoins();
    const maxSegs = _heartsMax()*3;
    const curSegs = _getSegs();

    if(curSegs >= maxSegs) { IZZA.toast?.('Hearts are full!'); return; }
    if(coins < 100) { IZZA.toast?.('Not enough IZZA Coins'); return; }

    const remInCurrent = curSegs % 3;
    const topOff = remInCurrent===0 ? 0 : (3-remInCurrent);
    const gain = topOff>0 ? topOff : Math.min(3, maxSegs - curSegs);

    api.setCoins(coins - 100);
    _setSegs(curSegs + gain);
    IZZA.toast?.(topOff>0 ? 'Heart topped up!' : '+1 heart for 100 IC');
  }
  const btnA = document.getElementById('btnA');
  btnA?.addEventListener('click', tryHospitalHeal);
  window.addEventListener('keydown', e=>{ if(e.key.toLowerCase()==='a') tryHospitalHeal(); });

  // ---------- Minimap / Bigmap overlay ----------
  function paintOverlay(id){
    if(!_layout) return;
    const c=document.getElementById(id); if(!c) return;
    const ctx=c.getContext('2d');
    const sx=c.width/90, sy=c.height/60;

    const api = IZZA.api;
    const A   = anchors(api);
    const {LAKE, BEACH_X, HOTEL, LOT} = lakeRects(A);
    const {HOOD, HOOD_H, HOOD_V, HOUSES, HOOD_PARK} = hoodRects(A);

    // ---- Recompute the same road grid used in render-under so overlays always match ----
    const FORBID = [
      {x0:LAKE.x0,y0:LAKE.y0,x1:LAKE.x1,y1:LAKE.y1},
      {x0:A.HQ.x0-1,y0:A.HQ.y0-1,x1:A.HQ.x1+1,y1:A.HQ.y1+1},
      {x0:A.SH.x0-1,y0:A.SH.y0-1,x1:A.SH.x1+1,y1:A.SH.y1+1}
    ];
    const {H,V} = (function desiredRoadGrid(a){
      const H = [ a.hRoadY - 10, a.hRoadY, a.hRoadY + 6 ];
      const V = [ a.vRoadX - 12, a.vRoadX + 10 ];
      return {H,V};
    })(A);

    let H_ROADS = [];
    let V_ROADS = [];
    H.forEach(y=>{
      const segs = clipHRow(y, A.un.x0, A.un.x1, FORBID);
      segs.forEach(s=>{
        const shaved = shaveDeadEndsH({y:s.y,x0:s.x0,x1:s.x1}, FORBID);
        if(shaved) H_ROADS.push(shaved);
      });
    });
    V.forEach(x=>{
      const segs = clipVCol(x, A.un.y0, A.un.y1, FORBID);
      segs.forEach(s=>{
        const shaved = shaveDeadEndsV({x:s.x,y0:s.y0,y1:s.y1}, FORBID);
        if(shaved) V_ROADS.push(shaved);
      });
    });

    const H_ROWS_ALL = new Set([...H_ROADS.map(r=>r.y), ...HOOD_H]);
    const V_COLS_ALL = new Set([...V_ROADS.map(r=>r.x), ...HOOD_V]);
    const isTier1Y = y => (y===A.hRoadY || y===A.sidewalkTopY || y===A.sidewalkBotY);

    // ---- Draw order: water & blocks → sidewalks → roads → buildings → patches/POIs ----

    // Lake + beach + lot + hotel footprints
    ctx.fillStyle = COL.water;
    ctx.fillRect(LAKE.x0*sx, LAKE.y0*sy, (LAKE.x1-LAKE.x0+1)*sx, (LAKE.y1-LAKE.y0+1)*sy);
    ctx.fillStyle = COL.sand;
    ctx.fillRect(BEACH_X*sx, LAKE.y0*sy, 1*sx, (LAKE.y1-LAKE.y0+1)*sy);
    ctx.fillStyle = COL.lot;
    ctx.fillRect(LOT.x0*sx, LOT.y0*sy, (LOT.x1-LOT.x0+1)*sx, (LOT.y1-LOT.y0+1)*sy);
    ctx.fillStyle = COL.hotel;
    ctx.fillRect(HOTEL.x0*sx, HOTEL.y0*sy, (HOTEL.x1-HOTEL.x0+1)*sx, (HOTEL.y1-HOTEL.y0+1)*sy);

    // Hood park & houses
    ctx.fillStyle = COL.hoodPark;
    ctx.fillRect(HOOD_PARK.x0*sx, HOOD_PARK.y0*sy, (HOOD_PARK.x1-HOOD_PARK.x0+1)*sx, (HOOD_PARK.y1-HOOD_PARK.y0+1)*sy);
    ctx.fillStyle = COL.house;
    HOUSES.forEach(h=> ctx.fillRect(h.x0*sx,h.y0*sy,(h.x1-h.x0+1)*sx,(h.y1-h.y0+1)*sy));

    // ---- Sidewalks around the new road grid (matches render-under logic) ----
    // H-road sidewalks
    ctx.fillStyle = '#a1a6b0'; // sidewalk tint for overlay
    H_ROADS.forEach(r=>{
      for(let x=r.x0;x<=r.x1;x++){
        if(!V_COLS_ALL.has(x)){
          if(!isOriginalTile(x, r.y-1, A))
            ctx.fillRect(x*sx, (r.y-1)*sy, 1*sx, 1*sy);
          if(!V_COLS_ALL.has(x) && !isOriginalTile(x, r.y+1, A))
            ctx.fillRect(x*sx, (r.y+1)*sy, 1*sx, 1*sy);
        }
      }
    });

    // V-road sidewalks (skip where H roads live and Tier-1 rows)
    V_ROADS.forEach(r=>{
      for(let y=r.y0;y<=r.y1;y++){
        if(H_ROWS_ALL.has(y) || isTier1Y(y)) continue;
        if(!isOriginalTile(r.x-1, y, A)) ctx.fillRect((r.x-1)*sx, y*sy, 1*sx, 1*sy);
        if(!isOriginalTile(r.x+1, y, A)) ctx.fillRect((r.x+1)*sx, y*sy, 1*sx, 1*sy);
      }
    });

    // ---- Roads (overlay tint)
    ctx.fillStyle = '#8a90a0';
    H_ROADS.forEach(r=> ctx.fillRect(r.x0*sx, r.y*sy, (r.x1-r.x0+1)*sx, 1.2*sy));
    V_ROADS.forEach(r=> ctx.fillRect(r.x*sx, r.y0*sy, 1.2*sx, (r.y1-r.y0+1)*sy));
    // Hood roads
    HOOD_H.forEach(y=>{
      const segs = clipHRow(y, A.un.x0, A.un.x1, [HOOD_PARK]);
      segs.forEach(s=> ctx.fillRect(s.x0*sx, y*sy, (s.x1-s.x0+1)*sx, 1.2*sy));
    });
    HOOD_V.forEach(x=>{
      const segs = clipVCol(x, A.un.y0, A.un.y1, [HOOD_PARK]);
      segs.forEach(s=> ctx.fillRect(x*sx, s.y0*sy, 1.2*sx, (s.y1-s.y0+1)*sy));
    });

    // ---- Buildings (downtown blocks)
    ctx.fillStyle = '#6f87b3';
    (_layout.BUILDINGS||[]).forEach(b=> ctx.fillRect(b.x*sx,b.y*sy,b.w*sx,b.h*sy));

    // ---- Hospital building
    if(_hospital){
      ctx.fillStyle = COL.hospital;
      ctx.fillRect(_hospital.x0*sx,_hospital.y0*sy,( (_hospital.x1-_hospital.x0+1) )*sx,( (_hospital.y1-_hospital.y0+1) )*sy);
    }

    // ---- Docks (planks)
    ctx.fillStyle = COL.wood;
    lakeRects(A).DOCKS.forEach(d=>{
      ctx.fillRect(d.x0*sx, d.y*sy, d.len*sx, 1*sy);
    });

    // ---- Notable manual patches you already had (kept so the overlay matches)
    ctx.fillStyle='#8a90a0'; // roads
    [
      {x:27,y:24},{x:29,y:24},
      {x:29,y:14},{x:27,y:14},{x:21,y:14},{x:19,y:14},
      {x:21,y:24},{x:19,y:24},{x:19,y:30},{x:21,y:30},{x:27,y:30},{x:29,y:30},
      {x:44,y:26},{x:44,y:27},{x:56,y:49},{x:56,y:47},{x:56,y:45},{x:56,y:43},
      {x:66,y:34}
    ].forEach(p=> ctx.fillRect(p.x*sx,p.y*sy,1*sx,1.2*sy));
    // long strips
    ctx.fillRect(69*sx,30*sy,(76-69+1)*sx,1.2*sy);

    // sidewalk-highlight strips
    ctx.fillStyle='#a1a6b0';
    ctx.fillRect(69*sx,31*sy,(76-69+1)*sx,1.2*sy);
    ctx.fillRect(66*sx,15*sy,(72-66+1)*sx,1.2*sy);
    [ {x:44,y:15},{x:43,y:26},{x:43,y:27},{x:65,y:34},{x:67,y:34} ]
      .forEach(p=> ctx.fillRect(p.x*sx,p.y*sy,1*sx,1.2*sy));
  }
  IZZA.on('render-post', ()=>{ if(isTier2()){ paintOverlay('minimap'); paintOverlay('bigmap'); } });

})();
