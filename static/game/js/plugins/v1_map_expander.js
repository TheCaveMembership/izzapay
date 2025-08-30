// downtown_clip_safe_layout.js
(function () {
  const TIER_KEY = 'izzaMapTier';

  // colors
  const COL = {
    road:'#2a2a2a', dash:'#ffd23f', sidewalk:'#6a727b',
    civic:'#405a85', police:'#0a2455', shop:'#203a60', park:'#2b6a7a'
  };

  // ---------- core-aligned anchors ----------
  function unlockedRect(t){ return (t!=='2') ? {x0:18,y0:18,x1:72,y1:42} : {x0:10,y0:12,x1:80,y1:50}; }
  function anchors(api){
    const tier = localStorage.getItem(TIER_KEY)||'1';
    const un = unlockedRect(tier);

    // original HQ/shop from core math
    const bW=10,bH=6;
    const bX = Math.floor((un.x0+un.x1)/2) - Math.floor(bW/2);
    const bY = un.y0 + 5;

    const hRoadY       = bY + bH + 1;
    const sidewalkTopY = hRoadY - 1;

    const vRoadX         = Math.min(un.x1-3, bX + bW + 6);
    const vSidewalkRightX= vRoadX + 1;

    const shop = { w:8, h:5, x:vSidewalkRightX+1, y: sidewalkTopY-5 };

    // “no paint” (with 1-tile buffer so nothing touches)
    const BUFF=1;
    const HQ  = {x0:bX-BUFF, y0:bY-BUFF, x1:bX+bW-1+BUFF, y1:bY+bH-1+BUFF};
    const SH  = {x0:shop.x-BUFF, y0:shop.y-BUFF, x1:shop.x+shop.w-1+BUFF, y1:shop.y+shop.h-1+BUFF};

    // door/register tiles to keep clear
    const door = { gx: bX + Math.floor(bW/2), gy: sidewalkTopY };
    const register = { gx: vSidewalkRightX, gy: sidewalkTopY };

    return {tier,un,bX,bY,bW,bH,hRoadY,vRoadX,shop,HQ,SH,door,register};
  }

  // ---------- SIMPLE grid proposal (no overlap yet) ----------
  function proposeDowntown(a){
    const {un,hRoadY,vRoadX} = a;
    const L = un.x0+2, R = un.x1-2, T = un.y0+2, B = un.y1-2;

    const H=[], V[];

    // main east–west + two above, three below (spaced 5 tiles)
    const above = [hRoadY-5, hRoadY-10].filter(y=>y>=T);
    const below = [hRoadY+5, hRoadY+10, hRoadY+15].filter(y=>y<=B);
    [ ...above, hRoadY, ...below ].forEach(y => H.push({ y, x0:L, x1:R }));

    // main north–south + two left, two right (spaced 8 tiles)
    const left  = [vRoadX-8, vRoadX-16].filter(x=>x>=L);
    const right = [vRoadX+8, vRoadX+16].filter(x=>x<=R);
    [ ...left, vRoadX, ...right ].forEach(x => V.push({ x, y0:T, y1:B }));

    return {H,V,BLD:[],PARK:null};
  }

  // ---------- clipping helpers ----------
  function overlapsRect(x0,y0,x1,y1,R){ return !(x1<R.x0 || x0>R.x1 || y1<R.y0 || y0>R.y1); }
  function clipHSegment(seg, forbiddenRects){
    let parts = [{y:seg.y, x0:seg.x0, x1:seg.x1}];
    forbiddenRects.forEach(R=>{
      parts = parts.flatMap(p=>{
        if(p.y<R.y0 || p.y>R.y1 || p.x1<R.x0 || p.x0>R.x1) return [p];
        const res=[];
        if(p.x0 < R.x0) res.push({y:p.y, x0:p.x0, x1:Math.max(p.x0, R.x0-1)});
        if(p.x1 > R.x1) res.push({y:p.y, x0:Math.min(p.x1, R.x1+1), x1:p.x1});
        return res;
      });
    });
    return parts.filter(p=>p.x1>=p.x0);
  }
  function clipVSegment(seg, forbiddenRects){
    let parts = [{x:seg.x, y0:seg.y0, y1:seg.y1}];
    forbiddenRects.forEach(R=>{
      parts = parts.flatMap(p=>{
        if(p.x<R.x0 || p.x>R.x1 || p.y1<R.y0 || p.y0>R.y1) return [p];
        const res=[];
        if(p.y0 < R.y0) res.push({x:p.x, y0:p.y0, y1:Math.max(p.y0, R.y0-1)});
        if(p.y1 > R.y1) res.push({x:p.x, y0:Math.min(p.y1, R.y1+1), y1:p.y1});
        return res;
      });
    });
    return parts.filter(p=>p.y1>=p.y0);
  }
  function inflate(rect, d){ return {x0:rect.x0-d, y0:rect.y0-d, x1:rect.x1+d, y1:rect.y1+d}; }

  // ---------- safe layout (roads clipped, buildings placed only inside blocks) ----------
  function makeSafeLayout(a){
    const P = proposeDowntown(a);

    const NO_ROAD = [
      inflate(a.HQ,0), inflate(a.SH,0),
      inflate({x0:a.door.gx,y0:a.door.gy,x1:a.door.gx,y1:a.door.gy},1),
      inflate({x0:a.register.gx,y0:a.register.gy,x1:a.register.gx,y1:a.register.gy},1)
    ];

    const H = P.H.flatMap(seg => clipHSegment(seg, NO_ROAD));
    const V = P.V.flatMap(seg => clipVSegment(seg, NO_ROAD));

    // Build block rectangles (between streets, sidewalks clear)
    function blocksFromGrid(H,V){
      const ys = [...new Set(H.map(h=>h.y))].sort((a,b)=>a-b);
      const xs = [...new Set(V.map(v=>v.x))].sort((a,b)=>a-b);
      const blocks=[];
      for(let yi=0; yi<ys.length-1; yi++){
        const top=ys[yi]+1, bot=ys[yi+1]-1; if(bot<top) continue;
        for(let xi=0; xi<xs.length-1; xi++){
          const left=xs[xi]+1, right=xs[xi+1]-1; if(right<left) continue;
          blocks.push({x:left, y:top, w:right-left+1, h:bot-top+1});
        }
      }
      return blocks;
    }
    const blocks = blocksFromGrid(H,V).filter(b=>{
      const hitHQ = !(b.x+b.w-1 < a.HQ.x0 || b.x > a.HQ.x1 || b.y+b.h-1 < a.HQ.y0 || b.y > a.HQ.y1);
      const hitSH = !(b.x+b.w-1 < a.SH.x0 || b.x > a.SH.x1 || b.y+b.h-1 < a.SH.y0 || b.y > a.SH.y1);
      return !hitHQ && !hitSH;
    });

    function placeInBlock(b, w, h, color){
      const x = Math.round(b.x + (b.w - w)/2);
      const y = Math.round(b.y + (b.h - h)/2);
      return {x, y, w, h, color};
    }

    // choose a small, clean set of buildings
    const BLD=[];
    if(blocks.length){
      const core = {x:a.vRoadX, y:a.hRoadY};
      const byCore = [...blocks].sort((b1,b2)=>{
        const c1={x:b1.x+b1.w/2, y:b1.y+b1.h/2};
        const c2={x:b2.x+b2.w/2, y:b2.y+b2.h/2};
        return (Math.abs(c1.x-core.x)+Math.abs(c1.y-core.y)) - (Math.abs(c2.x-core.x)+Math.abs(c2.y-core.y));
      });

      const se = byCore.find(b=> (b.x+b.w/2)>=core.x && (b.y+b.h/2)>=core.y ) || byCore[0];
      BLD.push(placeInBlock(se, Math.max(5, Math.floor(se.w*0.7)), Math.max(3, Math.floor(se.h*0.6)), COL.shop));

      const east = byCore.find(b=> (b.x+b.w/2)>core.x && Math.abs((b.y+b.h/2)-core.y)<=6 ) || byCore[1];
      if(east) BLD.push(placeInBlock(east, 4, 3, COL.police));

      const northBlocks = byCore.filter(b=> (b.y+b.h/2)<core.y).slice(0,2);
      northBlocks.forEach(b=> BLD.push(placeInBlock(b, 5, 3, COL.civic)));

      byCore.slice(3,7).forEach(b=> BLD.push(placeInBlock(b, 3, 2, COL.civic)));

      const parkBlock = [...byCore].reverse().find(b=> b.w>=6 && b.h>=4) || byCore[0];
      var PARK = { x:parkBlock.x, y:parkBlock.y, w:Math.min(parkBlock.w, 9), h:Math.min(parkBlock.h, 5) };
    } else {
      var PARK = null;
    }

    return {H_ROADS:H, V_ROADS:V, BUILDINGS:BLD, PARK};
  }

  // ---------- drawing helpers ----------
  const scl = api => api.DRAW/api.TILE;
  const w2sX=(api,wx)=>(wx-api.camera.x)*scl(api);
  const w2sY=(api,wy)=>(wy-api.camera.y)*scl(api);
  function fillTile(api,ctx,gx,gy,color){
    const S=api.DRAW, sx=w2sX(api,gx*api.TILE), sy=w2sY(api,gy*api.TILE);
    ctx.fillStyle=color; ctx.fillRect(sx,sy,S,S);
  }
  function drawHRoad(api,ctx,y,x0,x1){
    for(let x=x0;x<=x1;x++){
      fillTile(api,ctx,x,y,COL.road);
      const S=api.DRAW, sx=w2sX(api,x*api.TILE), sy=w2sY(api,y*api.TILE);
      ctx.fillStyle=COL.dash;
      for(let i=0;i<4;i++) ctx.fillRect(sx+i*(S/4)+S*0.05, sy+S*0.48, S*0.10, S*0.04);
    }
  }
  function drawVRoad(api,ctx,x,y0,y1){ for(let y=y0;y<=y1;y++) fillTile(api,ctx,x,y,COL.road); }

  // ---------- paint UNDER player/NPC (but above grass) ----------
  IZZA.on('render-under', ()=>{
    if(!IZZA.api||!IZZA.api.ready) return;
    if(localStorage.getItem(TIER_KEY)!=='2') return;

    const api=IZZA.api;
    const a=anchors(api);
    const L=makeSafeLayout(a);
    const ctx=document.getElementById('game').getContext('2d');

    // sidewalks first
    L.H_ROADS.forEach(r=>{
      for(let x=r.x0;x<=r.x1;x++){
        fillTile(api,ctx,x,r.y-1,COL.sidewalk);
        fillTile(api,ctx,x,r.y+1,COL.sidewalk);
      }
    });
    L.V_ROADS.forEach(r=>{
      for(let y=r.y0;y<=r.y1;y++){
        fillTile(api,ctx,r.x-1,y,COL.sidewalk);
        fillTile(api,ctx,r.x+1,y,COL.sidewalk);
      }
    });

    // roads
    L.H_ROADS.forEach(r=> drawHRoad(api,ctx,r.y,r.x0,r.x1));
    L.V_ROADS.forEach(r=> drawVRoad(api,ctx,r.x,r.y0,r.y1));

    // buildings
    L.BUILDINGS.forEach(b=>{
      for(let gy=b.y; gy<b.y+b.h; gy++)
        for(let gx=b.x; gx<b.x+b.w; gx++)
          fillTile(api,ctx,gx,gy,b.color);
      const sx=w2sX(api,b.x*api.TILE), sy=w2sY(api,b.y*api.TILE);
      ctx.fillStyle='rgba(0,0,0,.15)';
      ctx.fillRect(sx,sy, b.w*api.DRAW, Math.floor(b.h*api.DRAW*0.18));
    });

    if(L.PARK){
      const p=L.PARK, sx=w2sX(api,p.x*api.TILE), sy=w2sY(api,p.y*api.TILE);
      ctx.fillStyle=COL.park; ctx.fillRect(sx,sy, p.w*api.DRAW, p.h*api.DRAW);
    }

    // stash for collision + minimap
    window.__DT_LAYOUT__ = {L};
  });

  // ---------- light collision only against NEW buildings ----------
  function softCollide(){
    const api=IZZA.api; const pack=window.__DT_LAYOUT__; if(!api||!pack) return;
    const {L}=pack; const t=api.TILE; const px=api.player.x, py=api.player.y;
    const gx=(px/t)|0, gy=(py/t)|0;
    for(const b of L.BUILDINGS){
      if(gx>=b.x && gx<b.x+b.w && gy>=b.y && gy<b.y+b.h){
        const dxL=Math.abs(px-b.x*t), dxR=Math.abs((b.x+b.w)*t-px);
        const dyT=Math.abs(py-b.y*t), dyB=Math.abs((b.y+b.h)*t-py);
        const m=Math.min(dxL,dxR,dyT,dyB);
        if(m===dxL) api.player.x=(b.x-0.01)*t;
        else if(m===dxR) api.player.x=(b.x+b.w+0.01)*t;
        else if(m===dyT) api.player.y=(b.y-0.01)*t;
        else             api.player.y=(b.y+b.h+0.01)*t;
        break;
      }
    }
  }
  IZZA.on('update-post', ()=>{ if(localStorage.getItem(TIER_KEY)==='2') softCollide(); });

  // ---------- minimap/bigmap painting AFTER core ----------
  function paintMapCanvas(id){
    const pack=window.__DT_LAYOUT__; if(!pack) return;
    const {L}=pack;
    const c=document.getElementById(id); if(!c) return;
    const ctx=c.getContext('2d');
    const sx=c.width/90, sy=c.height/60;

    ctx.save();
    // roads
    ctx.fillStyle='#8a90a0';
    L.H_ROADS.forEach(r=> ctx.fillRect(r.x0*sx, r.y*sy, (r.x1-r.x0+1)*sx, 1.2*sy));
    L.V_ROADS.forEach(r=> ctx.fillRect(r.x*sx, r.y0*sy, 1.2*sx, (r.y1-r.y0+1)*sy));
    // buildings
    L.BUILDINGS.forEach(b=>{ ctx.fillStyle='#6f87b3'; ctx.fillRect(b.x*sx,b.y*sy,b.w*sx,b.h*sy); });
    // park
    if(L.PARK){ const p=L.PARK; ctx.fillStyle='#7db7d9'; ctx.fillRect(p.x*sx,p.y*sy,p.w*sx,p.h*sy); }
    ctx.restore();
  }
  IZZA.on('render-post', ()=>{
    if(localStorage.getItem(TIER_KEY)!=='2') return;
    paintMapCanvas('minimap');
    paintMapCanvas('bigmap');
  });
})();

// ===== ADD-ONS: lake, boats, beach/hotel, neighborhood =====

// Only do this for tier 2
function isTier2(){ return localStorage.getItem('izzaMapTier')==='2'; }

// ---- layout knobs (tweak safely) ----
const LAKE = { x0: 66, y0: 35, x1: 82, y1: 51 };     // bigger SE lake
const BEACH_X = LAKE.x0 - 1;                         // 1-tile sand strip on west shore
const DOCKS = [
  { x0: LAKE.x0, y: LAKE.y0+3,  len: 3 },
  { x0: LAKE.x0, y: LAKE.y0+10, len: 4 },
  { x0: LAKE.x0, y: LAKE.y0+17, len: 3 },
];
const HOTEL = { x0: LAKE.x0+2, y0: LAKE.y0-5, x1: LAKE.x0+8, y1: LAKE.y0-1 };

// Bottom-left neighborhood inside tier-2
const HOOD = { x0: 12, y0: 42, x1: 34, y1: 50 };
const HOOD_H = [ HOOD.y0+1, HOOD.y0+5, HOOD.y0+9 ];
const HOOD_V = [ HOOD.x0+6, HOOD.x0+12, HOOD.x0+18 ];
const HOUSES = [
  {x0:HOOD.x0+1,y0:HOOD.y0+2,x1:HOOD.x0+2,y1:HOOD.y0+3},
  {x0:HOOD.x0+8,y0:HOOD.y0+2,x1:HOOD.x0+10,y1:HOOD.y0+3},
  {x0:HOOD.x0+14,y0:HOOD.y0+2,x1:HOOD.x0+16,y1:HOOD.y0+3},
  {x0:HOOD.x0+2,y0:HOOD.y0+7,x1:HOOD.x0+4,y1:HOOD.y0+8},
  {x0:HOOD.x0+9,y0:HOOD.y0+7,x1:HOOD.x0+11,y1:HOOD.y0+8},
  {x0:HOOD.x0+15,y0:HOOD.y0+7,x1:HOOD.x0+17,y1:HOOD.y0+8},
];
const HOOD_PARK = { x0: HOOD.x0+19, y0: HOOD.y0+5, x1: HOOD.x0+24, y1: HOOD.y0+9 };

// ---- helpers already in this file (fillTile/drawHRoad/drawVRoad/w2sX/w2sY/COL)

// ---- water/dock tests ----
const _inRect=(gx,gy,R)=> gx>=R.x0 && gx<=R.x1 && gy>=R.y0 && gy<=R.y1;
const _isWater=(gx,gy)=> _inRect(gx,gy,LAKE);
const _isDock=(gx,gy)=> DOCKS.some(d=> gy===d.y && gx>=d.x0 && gx<=d.x0+d.len-1);

// ---- draw new content UNDER sprites ----
IZZA.on('render-under', ()=>{
  if(!isTier2() || !IZZA.api?.ready) return;
  const api = IZZA.api;
  const ctx = document.getElementById('game').getContext('2d');

  // Lake
  for(let gy=LAKE.y0; gy<=LAKE.y1; gy++)
    for(let gx=LAKE.x0; gx<=LAKE.x1; gx++)
      fillTile(api,ctx,gx,gy,'#1a4668');

  // Beach (1-tile wide)
  for(let gy=LAKE.y0; gy<=LAKE.y1; gy++) fillTile(api,ctx,BEACH_X,gy,'#e0c27b');

  // Docks
  ctx.fillStyle='#6b4a2f';
  DOCKS.forEach(d=>{
    const S=api.DRAW, sx=w2sX(api,d.x0*api.TILE), sy=w2sY(api,d.y*api.TILE);
    ctx.fillRect(sx,sy, d.len*S, S);
  });

  // Hotel
  for(let gy=HOTEL.y0; gy<=HOTEL.y1; gy++)
    for(let gx=HOTEL.x0; gx<=HOTEL.x1; gx++)
      fillTile(api,ctx,gx,gy,'#284b7a');

  // Neighborhood sidewalks and roads
  HOOD_H.forEach(y=>{
    for(let x=HOOD.x0; x<=HOOD.x1; x++){
      fillTile(api,ctx,x,y-1,'#6a727b');
      fillTile(api,ctx,x,y+1,'#6a727b');
    }
  });
  HOOD_V.forEach(x=>{
    for(let y=HOOD.y0; y<=HOOD.y1; y++){
      fillTile(api,ctx,x-1,y,'#6a727b');
      fillTile(api,ctx,x+1,y,'#6a727b');
    }
  });
  HOOD_H.forEach(y=> drawHRoad(api,ctx,y,HOOD.x0,HOOD.x1));
  HOOD_V.forEach(x=> drawVRoad(api,ctx,x,HOOD.y0,HOOD.y1));

  // Park
  for(let gy=HOOD_PARK.y0; gy<=HOOD_PARK.y1; gy++)
    for(let gx=HOOD_PARK.x0; gx<=HOOD_PARK.x1; gx++)
      fillTile(api,ctx,gx,gy,'#135c33');

  // Houses
  HOUSES.forEach(h=>{
    for(let gy=h.y0; gy<=h.y1; gy++)
      for(let gx=h.x0; gx<=h.x1; gx++)
        fillTile(api,ctx,gx,gy,'#175d2f');
  });
});

// ================= BOATS =================
const _boats = [];         // NPC boats
const _dockBoats = [];     // boats parked at docks (enter/exit)
let _towBoat=null;         // towing a wakeboarder
let _inBoat=false, _ride=null, _lastLand=null;

function _spawnBoats(){
  if(!isTier2() || _boats.length) return;
  const L={x0:LAKE.x0+2,y0:LAKE.y0+2,x1:LAKE.x1-2,y1:LAKE.y1-2};
  const loop=(x,y,s,clockwise=true)=>{
    const path = clockwise
      ? [{x:L.x0,y:L.y0},{x:L.x1,y:L.y0},{x:L.x1,y:L.y1},{x:L.x0,y:L.y1}]
      : [{x:L.x1,y:L.y1},{x:L.x0,y:L.y1},{x:L.x0,y:L.y0},{x:L.x1,y:L.y0}];
    return {x,y,s,i:0,path};
  };
  _boats.push(loop(L.x0, L.y0, 55, true));
  _boats.push(loop(L.x1, L.y1, 62, false));
  _towBoat = loop(L.x0+1, L.y1-1, 52, true);
  _boats.push(_towBoat);
  DOCKS.forEach(d=> _dockBoats.push({x:d.x0+Math.floor(d.len/2), y:d.y, s:120, taken:false}));
}
IZZA.on('ready', _spawnBoats);

// keep player off water unless in boat + move boats
IZZA.on('update-pre', ({dtSec})=>{
  if(!isTier2() || !IZZA.api?.ready) return;
  const api=IZZA.api, p=api.player, t=api.TILE;
  const gx=((p.x+16)/t)|0, gy=((p.y+16)/t)|0;

  if(!_isWater(gx,gy)) _lastLand = {x:p.x,y:p.y};
  else if(!_inBoat && _lastLand){ p.x=_lastLand.x; p.y=_lastLand.y; }

  _boats.forEach(b=>{
    const tgt=b.path[b.i], dx=tgt.x-b.x, dy=tgt.y-b.y, m=Math.hypot(dx,dy)||1, step=b.s*dtSec/32;
    if(m<=step){ b.x=tgt.x; b.y=tgt.y; b.i=(b.i+1)%b.path.length; }
    else{ b.x += (dx/m)*step; b.y += (dy/m)*step; }
  });

  if(_inBoat && _ride){ _ride.x = p.x/32; _ride.y = p.y/32; }
});

// enter/exit boat on B while on a dock (or beach to exit)
function _enterBoat(){
  if(_inBoat || !isTier2()) return;
  const p=IZZA.api.player, t=IZZA.api.TILE, gx=((p.x+16)/t)|0, gy=((p.y+16)/t)|0;
  if(!_isDock(gx,gy)) return;
  let best=null,bd=9e9;
  _dockBoats.forEach(b=>{ if(b.taken) return; const d=Math.hypot(b.x-gx,b.y-gy); if(d<bd){bd=d; best=b;} });
  if(best && bd<=2){ best.taken=true; _ride=best; _inBoat=true; IZZA.api.player.speed=120; }
}
function _leaveBoat(){
  if(!_inBoat) return;
  const p=IZZA.api.player, t=IZZA.api.TILE, gx=((p.x+16)/t)|0, gy=((p.y+16)/t)|0;
  if(_isDock(gx,gy) || gx===BEACH_X){ _ride.taken=false; _ride=null; _inBoat=false; IZZA.api.player.speed=90; }
}
document.getElementById('btnB')?.addEventListener('click', ()=>{ _inBoat? _leaveBoat() : _enterBoat(); });
window.addEventListener('keydown', e=>{ if(e.key.toLowerCase()==='b'){ _inBoat? _leaveBoat() : _enterBoat(); } });

// draw boats + wakeboarder under sprites
IZZA.on('render-under', ()=>{
  if(!isTier2() || !IZZA.api?.ready) return;
  const api=IZZA.api, ctx=document.getElementById('game').getContext('2d');
  const S=api.DRAW, t=api.TILE, f=S/t;
  const sx=gx=> (gx*t - api.camera.x)*f, sy=gy=> (gy*t - api.camera.y)*f;

  const drawBoat=(gx,gy)=>{
    ctx.fillStyle='#7ca7c7';
    ctx.fillRect(sx(gx)+S*0.2, sy(gy)+S*0.35, S*0.6, S*0.3);
  };
  _boats.forEach(b=> drawBoat(b.x,b.y));
  _dockBoats.forEach(b=> drawBoat(b.x,b.y));

  if(_towBoat){
    const tgt=_towBoat.path[_towBoat.i], vx=tgt.x-_towBoat.x, vy=tgt.y-_towBoat.y, m=Math.hypot(vx,vy)||1;
    const wx=_towBoat.x - (vx/m)*2.2, wy=_towBoat.y - (vy/m)*2.2;
    ctx.fillStyle='#23d3c6';
    ctx.fillRect(sx(wx)+S*0.33, sy(wy)+S*0.33, S*0.34, S*0.34);
  }
});

// ===== cars vs buildings: keep cars out of buildings (simple nudge) =====
IZZA.on('update-post', ()=>{
  if(!isTier2() || !IZZA.api?.ready) return;
  const api=IZZA.api, layout=window.__DT_LAYOUT__; if(!layout) return;
  const t=api.TILE;
  api.cars.forEach(c=>{
    const gx=(c.x/t)|0, gy=(c.y/t)|0;
    const hit = layout.L.BUILDINGS.some(b=> gx>=b.x && gx<b.x+b.w && gy>=b.y && gy<b.y+b.h);
    if(hit){ c.dir*=-1; c.x += c.dir*4; }
  });
});

// ===== minimap paint for new features =====
(function(){
  const oldPaint = paintMapCanvas;
  paintMapCanvas = function(id){
    oldPaint(id);
    if(!isTier2()) return;
    const c=document.getElementById(id); if(!c) return;
    const ctx=c.getContext('2d'), sx=c.width/90, sy=c.height/60;

    // lake / beach / docks / hotel
    ctx.fillStyle='#1a4668';
    ctx.fillRect(LAKE.x0*sx,LAKE.y0*sy,(LAKE.x1-LAKE.x0+1)*sx,(LAKE.y1-LAKE.y0+1)*sy);
    ctx.fillStyle='#e0c27b';
    ctx.fillRect(BEACH_X*sx, LAKE.y0*sy, 1*sx, (LAKE.y1-LAKE.y0+1)*sy);
    ctx.fillStyle='#6b4a2f'; DOCKS.forEach(d=> ctx.fillRect(d.x0*sx, d.y*sy, d.len*sx, 1*sy));
    ctx.fillStyle='#284b7a'; ctx.fillRect(HOTEL.x0*sx,HOTEL.y0*sy,(HOTEL.x1-HOTEL.x0+1)*sx,(HOTEL.y1-HOTEL.y0+1)*sy);

    // neighborhood
    ctx.fillStyle='#8a95a3';
    HOOD_H.forEach(y=> ctx.fillRect(HOOD.x0*sx, y*sy, (HOOD.x1-HOOD.x0+1)*sx, 1.4*sy));
    HOOD_V.forEach(x=> ctx.fillRect(x*sx, HOOD.y0*sy, 1.4*sx, (HOOD.y1-HOOD.y0+1)*sy));
    ctx.fillStyle='#135c33'; ctx.fillRect(HOOD_PARK.x0*sx,HOOD_PARK.y0*sy,(HOOD_PARK.x1-HOOD_PARK.x0+1)*sx,(HOOD_PARK.y1-HOOD_PARK.y0+1)*sy);
    ctx.fillStyle='#5f91a5'; HOUSES.forEach(h=> ctx.fillRect(h.x0*sx,h.y0*sy,(h.x1-h.x0+1)*sx,(h.y1-h.y0+1)*sy));
  };
})();
