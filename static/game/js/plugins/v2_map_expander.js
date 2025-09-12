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

  // Docks extend one tile onto the beach (start at BEACH_X), keeping their old water reach.
  const DOCKS = [
    { x0: BEACH_X, y: LAKE.y0+4,  len: 4 },
    { x0: BEACH_X, y: LAKE.y0+12, len: 5 }
  ];

  // Hotel pulled back behind sidewalk + lot
  const hotelTopY = LAKE.y0 - 5; // 1 sidewalk + 3 lot + 1 buffer
  const HOTEL  = { x0: LAKE.x0+3, y0: hotelTopY, x1: LAKE.x0+9, y1: hotelTopY+3 };
  const LOT    = { x0: HOTEL.x0,  y0: HOTEL.y1+1, x1: HOTEL.x1,  y1: HOTEL.y1+3 };

  return { LAKE, BEACH_X, DOCKS, HOTEL, LOT };
}

// ===== Island helpers (TOP LEVEL) =====
function islandSpec(a){
  const { LAKE } = lakeRects(a);
  const w=5, h=4;
  const x1 = LAKE.x1 - 1, x0 = x1 - (w-1);
  const yMid = (LAKE.y0 + LAKE.y1) >> 1;
  const y0 = yMid - (h>>1), y1 = y0 + h - 1;
  const ISLAND   = { x0: Math.max(LAKE.x0,x0), y0: Math.max(LAKE.y0,y0), x1, y1: Math.min(LAKE.y1,y1) };
  const BX = ISLAND.x0 + Math.floor((w-2)/2);
  const BY = ISLAND.y0 + Math.floor((h-1)/2);
  const BUILDING = { x0: BX, y0: BY, x1: BX+1, y1: BY };
  const DOOR     = { x: BX, y: BY+1 };
  return { ISLAND, BUILDING, DOOR };
}

// Publish a Set of "gx|gy" for island land so physics/boat treat it as land
function publishIslandLandFromExpander(a){
  if ((localStorage.getItem('izzaMapTier') || '1') !== '2') { window._izzaIslandLand = null; return; }
  const { ISLAND } = islandSpec(a);
  const land = new Set();
  for (let y = ISLAND.y0; y <= ISLAND.y1; y++){
    for (let x = ISLAND.x0; x <= ISLAND.x1; x++){
      land.add(x + '|' + y);
    }
  }
  window._izzaIslandLand = land;
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
// ---- Geometry helpers ----
const rectW = R => (R.x1 - R.x0 + 1);
const rectH = R => (R.y1 - R.y0 + 1);
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
  // city docks
  DOCKS.forEach(d=>{ for(let i=0;i<d.len;i++) set.add((d.x0+i)+'|'+d.y); });
  // island dock (water half)
  if (window.__IZZA_ISLAND_DOCK__?.water){
    const w = window.__IZZA_ISLAND_DOCK__.water;
    set.add(w.x+'|'+w.y);
  }
  return set;
}

  // ---------- HOSPITAL ----------
let _layout=null, _hospital=null, _hospitalDoor=null, _shopOpen=false;

// === Hearts/coins helpers wired to your existing plugins ===
const HEARTS_LS_KEY = 'izzaCurHeartSegments';
function _heartsMax(){ const p=IZZA.api?.player||{}; return p.maxHearts||p.heartsMax||3; }
function _getSegs(){
  const max = _heartsMax() * 3;

  // Read saved value FIRST
  const raw = localStorage.getItem(HEARTS_LS_KEY);
  if (raw != null && raw !== '') {
    const seg = Math.max(0, Math.min(max, parseInt(raw, 10) || 0));
    // Mirror to player so anything reading player sees the same number
    const p = IZZA.api?.player || {};
    p.heartSegs = seg;
    return seg;
  }

  // Fallback: if no LS yet, use whatever the engine has
  const p = IZZA.api?.player || {};
  if (typeof p.heartSegs === 'number') {
    return Math.max(0, Math.min(max, p.heartSegs|0));
  }

  // Default: full
  return max;
}

// NEW: keep per-user mirrors/snapshot in sync whenever hearts change
function _commitHeartsSnapshot(seg){
  try{
    const u = (IZZA?.api?.user?.username || 'guest')
                .toString().replace(/^@+/, '').toLowerCase();

    // namespaced LS (some parts of your stack read this)
    localStorage.setItem(`${HEARTS_LS_KEY}_${u}`, String(seg));

    // update the "lastGood" snapshot used by hydrate
    const lgKey = `izzaBankLastGood_${u}`;
    let lg = {};
    try { lg = JSON.parse(localStorage.getItem(lgKey) || '{}') || {}; } catch {}
    lg.player = lg.player || {};

    // write both: correct key (singular) and compat duplicate
    lg.player.heartSegs  = seg;
    lg.player.heartsSegs = seg;

    localStorage.setItem(lgKey, JSON.stringify(lg));
  } catch {}
}

function _setSegs(v){
  const p=IZZA.api?.player||{};
  const max = _heartsMax()*3;
  const seg = Math.max(0, Math.min(max, v|0));
  p.heartSegs = seg;
  localStorage.setItem(HEARTS_LS_KEY, String(seg));

  _commitHeartsSnapshot(seg);                 // <-- ensure persistence across reloads
  _redrawHeartsHud();
  try { window.dispatchEvent(new Event('izza-hearts-changed')); } catch {}
}

// ---- keep hydrate snapshot in sync so reloads don't revert hearts ----
try {
  const u = (IZZA?.api?.user?.username || 'guest')
              .toString().replace(/^@+/, '').toLowerCase();
  const segs = _getSegs() | 0;

  // namespaced LS (some parts of your stack read this)
  localStorage.setItem(`${HEARTS_LS_KEY}_${u}`, String(segs));

  // update the "lastGood" snapshot used by hydrate
  const lgKey = `izzaBankLastGood_${u}`;
  let lg = {};
  try { lg = JSON.parse(localStorage.getItem(lgKey) || '{}') || {}; } catch {}
  lg.player = lg.player || {};
  // write both keys here too (seed path)
  lg.player.heartSegs  = segs;   // corrected field
  lg.player.heartsSegs = segs;   // backward-compat
  localStorage.setItem(lgKey, JSON.stringify(lg));
} catch {}

function _syncHeartsFromStorageToPlayer(){
  // Just mirror LS → player once; no listeners/tickers in here
  try {
    const seg = _getSegs();                 // LS-first
    const p = IZZA.api?.player || {};
    if ((p.heartSegs|0) !== (seg|0)) {
      p.heartSegs = seg;
      _redrawHeartsHud?.();
    }
  } catch {}
}

// ---- moved OUTSIDE the function (singletons) ----

// Throttle for the ongoing guard
let _heartsGuardLastFix = 0;
const HEARTS_GUARD_COOLDOWN_MS = 250; // at most 4 fixes/sec

// Short boot enforcement window (beats late initializers)
const HEARTS_ENFORCE_MS = 2000;
let _heartsEnforceUntil = 0;

function _startHeartsEnforceWindow(){
  try { _heartsEnforceUntil = (performance.now?.() || Date.now()) + HEARTS_ENFORCE_MS; }
  catch { _heartsEnforceUntil = Date.now() + HEARTS_ENFORCE_MS; }
}
// start enforcement as soon as this file loads
_startHeartsEnforceWindow();

// Single per-tick guard (merged guard + enforcement)
IZZA.on?.('update-post', ()=>{
  if (!IZZA?.api?.ready) return;

  const want = _getSegs()|0;           // LS-authoritative
  const p = IZZA.api.player || {};

  // Ongoing guard (throttled)
  if ((p.heartSegs|0) !== want){
    const now = performance.now?.() || Date.now();
    if (now - _heartsGuardLastFix >= HEARTS_GUARD_COOLDOWN_MS){
      p.heartSegs = want;
      _redrawHeartsHud?.();
      _heartsGuardLastFix = now;
    }
  }

  // Boot enforcement window
  const now2 = performance.now?.() || Date.now();
  if (now2 <= _heartsEnforceUntil && (p.heartSegs|0) !== want){
    p.heartSegs = want;
    _redrawHeartsHud?.();
  }
});

// Hearts changed → extend the enforcement window
window.addEventListener('izza-hearts-changed', ()=>{ _startHeartsEnforceWindow(); }, {capture:true});

// Cross-tab/devtools edits → resync LS→player once
window.addEventListener('storage', e=>{
  if (e.key === 'izzaCurHeartSegments') _syncHeartsFromStorageToPlayer();
});

// run once shortly after this script loads
setTimeout(_syncHeartsFromStorageToPlayer, 0);

// and every time hearts change (hospitalBuy already dispatches this)
window.addEventListener('izza-hearts-changed', _syncHeartsFromStorageToPlayer);

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
window._redrawHeartsHud = _redrawHeartsHud;

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
  const api = IZZA.api;
  if (!api?.ready) return;

  const coins = api.getCoins();
  if (coins < 100){ alert('Not enough IZZA Coins'); return; }

  const maxSegs = _heartsMax() * 3;
  const curSegs = _getSegs();
  if (curSegs >= maxSegs){ alert('Hearts are already full'); return; }

  // Top off current heart first; otherwise add up to a full heart (3 segs)
  const remInCurrent = curSegs % 3;                         // 0..2
  const topOff       = remInCurrent === 0 ? 0 : (3 - remInCurrent); // 0,1,2
  const gain         = topOff > 0 ? topOff : Math.min(3, maxSegs - curSegs);

  // Spend coins and apply heal
  api.setCoins(coins - 100);
  _setSegs(curSegs + gain);

  // Persist hearts immediately so they survive reloads (redundant but fine)
  try { window.dispatchEvent(new Event('izza-hearts-changed')); } catch {}

  // Feedback + refresh the modal coins line
  IZZA.toast?.(topOff > 0 ? 'Heart topped up!' : '+1 heart!');
  const hc = document.getElementById('hsCoins');
  if (hc) hc.textContent = `Coins: ${api.getCoins()} IC`;
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
// --- ISLAND (rendered after water so it is visible)
(function(){
  if ((localStorage.getItem('izzaMapTier') || '1') !== '2') return;
    // We still want visuals here because armoury file is logic-only now
    // so DO NOT early return based on owner; just proceed.
  }

  const A2 = anchors(api);
  const { LAKE } = lakeRects(A2);

  // Geometry identical to armoury file
  const w=5, h=4;
  const x1 = LAKE.x1 - 1, x0 = x1 - (w-1);
  const yMid = (LAKE.y0 + LAKE.y1) >> 1;
  const y0 = yMid - (h>>1), y1 = y0 + h - 1;
  const ISLAND   = { x0: Math.max(LAKE.x0,x0), y0: Math.max(LAKE.y0,y0), x1, y1: Math.min(LAKE.y1,y1) };

  // single-tile building: door is the tile south of the block
  const BX = ISLAND.x0 + Math.floor((w-1)/2);
  const BY = ISLAND.y0 + Math.floor((h-1)/2) - 1;
  const BUILDING = { x0:BX, y0:BY, x1:BX, y1:BY }; // single tile
  const DOOR     = { x: BX, y: BY+1 };

  // dock (functionality only; invisible here)
  const dockY = (ISLAND.y0 + ISLAND.y1) >> 1;
  const ISLAND_DOCK = {
    water: { x: ISLAND.x0 - 1, y: dockY },
    sand:  { x: ISLAND.x0,     y: dockY }
  };

  // publish land set every render so boat/collisions are in sync
  (function publishIslandLandFromExpander(){
    const land = new Set();
    for (let y = ISLAND.y0; y <= ISLAND.y1; y++)
      for (let x = ISLAND.x0; x <= ISLAND.x1; x++)
        land.add(x + '|' + y);
    window._izzaIslandLand = land;
  })();

  // SAND PAD
  for (let gy = ISLAND.y0; gy <= ISLAND.y1; gy++)
    for (let gx = ISLAND.x0; gx <= ISLAND.x1; gx++)
      fillTile(api, ctx, gx, gy, COL.sand);

  // PALM (keep the same look/placement you had earlier)
  (function drawPalmSimple(){
    const S=api.DRAW, t=api.TILE;
    const sx=(gx)=> (gx*t - api.camera.x)*(S/t);
    const sy=(gy)=> (gy*t - api.camera.y)*(S/t);
    // simple stylized palm: use your existing palm routine if you prefer
    ctx.save();
    ctx.translate(sx(ISLAND.x0)+S*0.7, sy(ISLAND.y0)+S*1.9);
    ctx.scale(S/32, S/32);
    ctx.fillStyle='rgba(0,0,0,0.15)';
    ctx.beginPath(); ctx.ellipse(14,28,7,3,0,0,Math.PI*2); ctx.fill();
    ctx.lineWidth=4; ctx.strokeStyle='#8B5A2B';
    ctx.beginPath(); ctx.moveTo(14,28); ctx.bezierCurveTo(16,24,18,18,20,8); ctx.stroke();
    ctx.lineWidth=1.4; ctx.strokeStyle='rgba(255,255,255,0.18)';
    for(let y=24;y>=10;y-=2.2){ ctx.beginPath(); ctx.moveTo(13,y); ctx.lineTo(18,y-1.2); ctx.stroke(); }
    ctx.fillStyle='#5C3A1D';
    ctx.beginPath(); ctx.arc(22,10,2.2,0,Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(20,11.2,2.0,0,Math.PI*2); ctx.fill();
    function frond(ax,ay,bx,by,cx,cy){
      ctx.beginPath();
      ctx.moveTo(ax,ay); ctx.quadraticCurveTo(bx,by,cx,cy); ctx.quadraticCurveTo(bx,by,ax,ay); ctx.closePath();
      const g = ctx.createLinearGradient(ax,ay,cx,cy);
      g.addColorStop(0,'#2E8B57'); g.addColorStop(1,'#1E6B40');
      ctx.fillStyle=g; ctx.fill();
      ctx.strokeStyle='rgba(0,0,0,0.2)'; ctx.lineWidth=0.8; ctx.stroke();
    }
    frond(20,8,6,0,2,12); frond(20,8,12,-3,24,2); frond(20,8,28,0,36,12); frond(20,8,30,12,30,22); frond(20,8,10,12,10,22);
    ctx.restore();
  })();

  // BUILDING as a **single door tile**: draw only the door tile with a small inset that glows gold when near
  const t=api.TILE, pgx=((api.player.x+16)/t|0), pgy=((api.player.y+16)/t|0);
  const near = Math.abs(pgx-DOOR.x) <= 1 && Math.abs(pgy-DOOR.y) <= 1;

  // base tile (a neutral building color)
  fillTile(api, ctx, BUILDING.x0, BUILDING.y0, '#6f87b3');

  // draw the door tile (south of building) with a smaller inset rect, bronze vs gold on proximity
  (function drawInsetDoor(){
    const S=api.DRAW;
    const sx=(DOOR.x*t - api.camera.x)*(S/t);
    const sy=((DOOR.y)*t - api.camera.y)*(S/t);
    ctx.save();
    // tile base (sand already under it; optional to tint a bit)
    // inset "door" rectangle
    const insetW = S*0.45, insetH = S*0.55;
    const dx = sx + (S-insetW)/2;
    const dy = sy + (S-insetH)/2;
    ctx.fillStyle = near ? '#d4a01e' : '#6e4a1e';
    ctx.fillRect(dx, dy, insetW, insetH);
    ctx.restore();
  })();

  // export so other systems can use exact tiles
  window.__IZZA_ARMOURY__      = { rect: BUILDING, door: DOOR, island: ISLAND };
  window.__IZZA_ISLAND_DOCK__  = ISLAND_DOCK;

  // NOTE: No visual dock drawing — invisible docks, functionality remains via __IZZA_ISLAND_DOCK__
})();
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

    // =========================
    //        BANK (UPDATED)
    // =========================
    // Position: 8 tiles north & 5 tiles east of the hospital door
    // Footprint: 3x3, gold, glows
    // Door: north side, centered (one tile above bank north row middle)
    window.__IZZA_BANK__ = window.__IZZA_BANK__ || {};

    // Compute bank rect once per page load to keep stable
    const bx0 = (_hospitalDoor.x + 5);
    const by0 = (_hospitalDoor.y - 9);
    const bankRect = { x0: bx0, y0: by0, x1: bx0 + 2, y1: by0 + 2 }; // 3x3
    const bankDoor = { x: bx0 + 1, y: by0 - 1 }; // north-middle in front

    // Persist to global holder
    __IZZA_BANK__.rect = bankRect;
    __IZZA_BANK__.door = bankDoor;

    // Draw bank with a gold glow
    const goldFill = '#e7c14a';
    const glowCol  = 'rgba(255,215,64,0.55)';
    // Glow pass: draw one big rect with shadow
    (function drawGoldBlockWithGlow(){
      const sx=w2sX(api, bankRect.x0*api.TILE);
      const sy=w2sY(api, bankRect.y0*api.TILE);
      const w = 3*api.DRAW, h = 3*api.DRAW;
      ctx.save();
      ctx.shadowColor = glowCol;
      ctx.shadowBlur  = 18;
      ctx.fillStyle   = goldFill;
      ctx.fillRect(sx, sy, w, h);
      ctx.restore();
    })();
    // Ensure tiles are gold (keeps grid look)
    for(let gy=bankRect.y0; gy<=bankRect.y1; gy++)
      for(let gx=bankRect.x0; gx<=bankRect.x1; gx++) fillTile(api,ctx,gx,gy,goldFill);

    // bank door highlight (north of building, centered)
    const nearBankDoor = Math.abs(pgx-bankDoor.x)<=1 && Math.abs(pgy-bankDoor.y)<=1;
    set(bankDoor.x, bankDoor.y, nearBankDoor ? COL.doorGreen : COL.doorBlue);
    // =========================
    // === TRADE CENTRE (small building next to HQ) ================================
(function addTradeCentre(){
  try{
    const api = IZZA.api;
    if (!api) return;
    const A = (function anchors(){
      const tier = localStorage.getItem('izzaMapTier')||'1';
      const un = (tier!=='2') ? {x0:18,y0:18,x1:72,y1:42} : {x0:10,y0:12,x1:80,y1:50};
      const bW=10,bH=6;
      const bX = Math.floor((un.x0+un.x1)/2) - Math.floor(bW/2);
      const bY = un.y0 + 5;
      const hRoadY       = bY + bH + 1;
      const sidewalkTopY = hRoadY - 1;
      const vRoadX       = Math.min(un.x1-3, bX + bW + 6);
      const door = { gx: bX + Math.floor(bW/2), gy: sidewalkTopY }; // HQ door
      return {un, door, vRoadX, hRoadY, sidewalkTopY};
    })();

    // Pos: 8 east, 4 south of the HQ door
    const tx0 = A.door.gx + 5;
    const ty0 = A.door.gy + 3;
    const TRADE_RECT = { x0: tx0, y0: ty0, x1: tx0+2, y1: ty0+2 }; // 3x3
    const TRADE_DOOR = { x: tx0+1, y: ty0-1 };                     // north-side door

    // Draw building (teal)
    const ctx = document.getElementById('game').getContext('2d');
    const fillTile = (gx,gy,col)=>{
      const S=api.DRAW, sx=(gx*api.TILE - api.camera.x)*(S/api.TILE), sy=(gy*api.TILE - api.camera.y)*(S/api.TILE);
      ctx.fillStyle = col; ctx.fillRect(sx,sy,S,S);
    };
    for(let gy=TRADE_RECT.y0; gy<=TRADE_RECT.y1; gy++)
      for(let gx=TRADE_RECT.x0; gx<=TRADE_RECT.x1; gx++)
        fillTile(gx,gy,'#13b5a3'); // teal box
    // glowing header band
    (function(){
      const S=api.DRAW, sx=(TRADE_RECT.x0*api.TILE - api.camera.x)*(S/api.TILE), sy=(TRADE_RECT.y0*api.TILE - api.camera.y)*(S/api.TILE);
      ctx.save(); ctx.shadowColor='rgba(19,181,163,.7)'; ctx.shadowBlur=16; ctx.fillStyle='#0fead4';
      ctx.fillRect(sx, sy, 3*S, Math.floor(S*0.22)); ctx.restore();
    })();
    // Door highlight (blue/green)
    const t=api.TILE, pgx=((api.player.x+16)/t|0), pgy=((api.player.y+16)/t|0);
    const nearDoor = Math.abs(pgx-TRADE_DOOR.x)<=1 && Math.abs(pgy-TRADE_DOOR.y)<=1;
    fillTile(TRADE_DOOR.x, TRADE_DOOR.y, nearDoor ? '#35d27a' : '#5aa0ff');

    // Export so other plugins can use it; add to collisions later
    window.__IZZA_TRADE__ = { rect: TRADE_RECT, door: TRADE_DOOR };

    // Hook B near door → open modal
    function _onPressTradeB(e){
      if (!window.__IZZA_TRADE__ || !IZZA?.api?.ready) return;
      const t=IZZA.api.TILE, gx=((IZZA.api.player.x+16)/t|0), gy=((IZZA.api.player.y+16)/t|0);
      const d=window.__IZZA_TRADE__.door;
      const near = Math.abs(gx-d.x)<=1 && Math.abs(gy-d.y)<=1;
      if(!near) return;
      e?.preventDefault?.(); e?.stopImmediatePropagation?.(); e?.stopPropagation?.();
      const m=document.getElementById('tradeModal'); if(m){ m.style.display='flex'; }
    }
    document.getElementById('btnB')?.addEventListener('click', _onPressTradeB, true);
    window.addEventListener('keydown', e=>{ if((e.key||'').toLowerCase()==='b') _onPressTradeB(e); }, true);

    // Collisions (this part stays)
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

      // BANK solid
      if(window.__IZZA_BANK__?.rect){
        const B = window.__IZZA_BANK__.rect;
        solids.push({x:B.x0,y:B.y0,w:rectW(B),h:rectH(B)});
      }

      // ARMOURY solid (island)
      if (window.__IZZA_ARMOURY__?.rect){
        const R = window.__IZZA_ARMOURY__.rect;
        solids.push({ x:R.x0, y:R.y0, w:(R.x1-R.x0+1), h:(R.y1-R.y0+1) });
      }

      // Manual solids
      (_layout.patches?.solidHouses||[]).forEach(r=> solids.push({x:r.x0,y:r.y0,w:rectW(r),h:rectH(r)}));
      (_layout.patches?.solidSingles||[]).forEach(c=> solids.push({x:c.x,y:c.y,w:1,h:1}));

      // Water (solid unless beach/docks/island land; and only when not boating)
      const LAKE=_layout.LAKE, BEACH_X=lakeRects(anchors(api)).BEACH_X;
      const waterIsSolid = (x,y)=>{
        if(!_inRect(x,y,LAKE)) return false;
        if (window._izzaIslandLand && window._izzaIslandLand.has(x+'|'+y)) return false;
        if(x===BEACH_X) return false;
        if(dockCells().has(x+'|'+y)) return false;
        return true;
      };
      if (!window._izzaBoatActive) {
        if (waterIsSolid(gx,gy)) {
          solids.push({x:LAKE.x0,y:LAKE.y0,w:rectW(LAKE),h:rectH(LAKE)});
        }
      }

      // Walkable overrides
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

  }catch(e){ /* swallow */ }
})();
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
IZZA.on('update-pre', ()=>{
  if(!IZZA.api?.ready || !isTier2()) return;

  // publish island land set for physics/boat every tick
  publishIslandLandFromExpander(anchors(IZZA.api));   // <-- add this line

  const api = IZZA.api;
  // cars bounce off new buildings …

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
  // downtown buildings
  _layout.BUILDINGS?.forEach(b=> solids.push({x:b.x,y:b.y,w:b.w,h:b.h}));
  solids.push({x:_layout.HOTEL.x0,y:_layout.HOTEL.y0,w:(_layout.HOTEL.x1-_layout.HOTEL.x0+1),h:(_layout.HOTEL.y1-_layout.HOTEL.y0+1)});
  _layout.HOUSES.forEach(h=> solids.push({x:h.x0,y:h.y0,w:(h.x1-h.x0+1),h:(h.y1-h.y0+1)}));

  // hospital
  if(_hospital){ solids.push({x:_hospital.x0,y:_hospital.y0,w:(_hospital.x1-_hospital.x0+1),h:(_hospital.y1-_hospital.y0+1)}); }

  // bank
  if(window.__IZZA_BANK__?.rect){
    const B = window.__IZZA_BANK__.rect;
    solids.push({x:B.x0,y:B.y0,w:(B.x1-B.x0+1),h:(B.y1-B.y0+1)});
  }

  // armoury (island)
  if (window.__IZZA_ARMOURY__?.rect){
    const R = window.__IZZA_ARMOURY__.rect;
    solids.push({ x:R.x0, y:R.y0, w:(R.x1-R.x0+1), h:(R.y1-R.y0+1) });
  }

  // manual solids
  (_layout.patches?.solidHouses||[]).forEach(r=> solids.push({x:r.x0,y:r.y0,w:(r.x1-r.x0+1),h:(r.y1-r.y0+1)}));
  (_layout.patches?.solidSingles||[]).forEach(c=> solids.push({x:c.x,y:c.y,w:1,h:1}));

  // water (solid unless beach/docks/island land; and only when not boating)
  const LAKE=_layout.LAKE, BEACH_X=lakeRects(anchors(api)).BEACH_X;
  const waterIsSolid = (x,y)=>{
    if(!_inRect(x,y,LAKE)) return false;
    if (window._izzaIslandLand && window._izzaIslandLand.has(x+'|'+y)) return false; // island sand is land
    if(x===BEACH_X) return false;                      // beach strip
    if(dockCells().has(x+'|'+y)) return false;         // docks (incl. island dock water tile)
    return true;
  };
  if (!window._izzaBoatActive) {
    if (waterIsSolid(gx,gy)) {
      solids.push({x:LAKE.x0,y:LAKE.y0,w:(LAKE.x1-LAKE.x0+1),h:(LAKE.y1-LAKE.y0+1)});
    }
  }

  // walkable overrides
  const overrides = _layout.patches?.walkableOverride || [];
  const isOverridden = (x,y)=> overrides.some(r=> x>=r.x0 && x<=r.x1 && y>=r.y0 && y<=r.y1);

  // simple AABB resolve
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

  // ===============================
  //           BANK UI (kept, plus hide fire button while open/closed)
  // ===============================

  // Per-user persistent key
  function _bankKey(){
    const u = (IZZA?.api?.user?.username || 'guest').toString().replace(/^@+/,'').toLowerCase();
    return 'izzaBank_'+u;
  }
  function _readBank(){
    try{
      const raw = localStorage.getItem(_bankKey());
      if(!raw) return { coins:0, items:{}, ammo:{} };
      const j = JSON.parse(raw);
      return { coins: j.coins|0 || 0, items: j.items||{}, ammo: j.ammo||{} };
    }catch{ return { coins:0, items:{}, ammo:{} }; }
  }
  function _writeBank(b){
  try{
    localStorage.setItem(_bankKey(), JSON.stringify(b));
    window.dispatchEvent(new Event('izza-bank-changed'));
  }catch{}
}

  function _readInv(){
    try{
      if(IZZA?.api?.getInventory) return JSON.parse(JSON.stringify(IZZA.api.getInventory()||{}));
      const raw=localStorage.getItem('izzaInventory'); return raw? JSON.parse(raw) : {};
    }catch{ return {}; }
  }
  function _writeInv(inv){
    try{
      if(IZZA?.api?.setInventory){ IZZA.api.setInventory(inv); }
      else localStorage.setItem('izzaInventory', JSON.stringify(inv));
    }catch{}
  }

  /* --- NEW: minimal guard to fix the “wallet cloned from bank on reload” state --- */
  function _maybeFixBootDuplication() {
    try {
      const u = (IZZA?.api?.user?.username || 'guest').toString().replace(/^@+/,'').toLowerCase();
      const lgRaw = localStorage.getItem(`izzaBankLastGood_${u}`);
      if (!lgRaw) return;
      const lg = JSON.parse(lgRaw) || {};
      const walletSnap = (lg.coins|0) || 0;                              // your on-hand per your semantics
      const bankSnap   = (lg.bank && (lg.bank.coins|0)) || 0;

      const bankNowObj = JSON.parse(localStorage.getItem(`izzaBank_${u}`) || '{"coins":0}');
      const bankNow    = (bankNowObj.coins|0) || 0;
      const walletNow  = parseInt(localStorage.getItem('izzaCoins') || '0', 10) || 0;

      // Glitch: last session had ALL in bank, but after reload both "You" and "Bank"
      // show the bank amount (wallet got cloned from bank).
      if (walletSnap === 0 && bankSnap > 0 && walletNow === bankNow && walletNow === bankSnap) {
        // restore authoritative split from snapshot
        localStorage.setItem('izzaCoins', String(walletSnap)); // 0
        localStorage.setItem(`izzaBank_${u}`, JSON.stringify({
          coins: bankSnap, items: (lg.bank?.items||{}), ammo: (lg.bank?.ammo||{})
        }));
        try { if (IZZA?.api?.setCoins) IZZA.api.setCoins(walletSnap); } catch {}
        try { window.dispatchEvent(new Event('izza-coins-changed')); } catch {}
        try { window.dispatchEvent(new Event('izza-bank-changed')); } catch {}
      }
    } catch {}
  }
  /* ------------------------------------------------------------------------------ */

  function _ensureBankUI(){
    if(document.getElementById('bankUI')) return;
    const wrap=document.createElement('div');
    wrap.id='bankUI';
    wrap.style.cssText='position:absolute;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.48);z-index:60;';
    wrap.innerHTML = `
      <div style="min-width:320px;max-width:560px;background:#0f1624;border:1px solid #2b3b57;border-radius:12px;padding:14px 14px 10px;color:#e7eef7;box-shadow:0 14px 38px rgba(0,0,0,.55)">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <strong style="font-size:16px">🏦 IZZA Bank</strong>
          <div style="display:flex;gap:8px;align-items:center">
            <span id="bankCoinsView" style="opacity:.85"></span>
            <button id="bankClose" style="background:#263447;color:#cfe3ff;border:0;border-radius:6px;padding:6px 10px;cursor:pointer">Close</button>
          </div>
        </div>
        <div style="margin:6px 0 10px;opacity:.9">Click here to deposit IZZA Coins &amp; Items.</div>
        <div style="display:flex;gap:8px;margin-bottom:10px">
          <button id="bankTabDeposit"  style="flex:1;padding:8px;border:0;border-radius:8px;background:#1f6feb;color:#fff;font-weight:700;cursor:pointer">Deposit</button>
          <button id="bankTabWithdraw" style="flex:1;padding:8px;border:0;border-radius:8px;background:#2b3b57;color:#cfe3ff;font-weight:700;cursor:pointer">Withdraw</button>
        </div>
        <div id="bankBody"></div>
      </div>`;
    document.body.appendChild(wrap);
    wrap.querySelector('#bankClose').onclick = ()=> _bankClose();
    wrap.querySelector('#bankTabDeposit').onclick  = ()=> _drawDeposit();
    wrap.querySelector('#bankTabWithdraw').onclick = ()=> _drawWithdraw();
  }

  function _setFireVisible(v){
    const f=document.getElementById('btnFire');
    if(f){ f.style.visibility = v ? 'visible' : 'hidden'; }
  }

  function _bankOpen(){
    _ensureBankUI();

    // NEW: heal duplicated wallet/bank before drawing UI (no other behavior changed)
    _maybeFixBootDuplication();

    document.getElementById('bankUI').style.display='flex';
    _setFireVisible(false); // HIDE fire button while bank is open
    _updateBankCoinsView();
    _drawDeposit();
  }
  function _bankClose(){
    const el=document.getElementById('bankUI'); if(el) el.style.display='none';
    _setFireVisible(true);  // SHOW fire button when bank closes
  }
  function _updateBankCoinsView(){
    const api=IZZA.api; const bank=_readBank();
    document.getElementById('bankCoinsView').textContent = `Bank: ${bank.coins|0} IC · You: ${api.getCoins()} IC`;
  }

  function _drawDeposit(){
    const host=document.getElementById('bankBody'); if(!host) return;
    const api=IZZA.api, bank=_readBank(), inv=_readInv();

    const coinPart = `
      <div style="background:#111b29;border:1px solid #2b3b57;border-radius:10px;padding:10px;margin-bottom:10px">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
          <div><strong>Deposit Coins</strong><div style="opacity:.7;font-size:12px">Move IZZA Coins into your safe.</div></div>
          <div>
            <input id="bankDepCoinsAmt" type="number" min="0" max="${api.getCoins()}" value="${Math.min(100, api.getCoins())}" style="width:90px;background:#0c1422;border:1px solid #2b3b57;border-radius:6px;color:#cfe3ff;padding:4px 6px">
            <button id="bankDepCoinsBtn" style="margin-left:6px;background:#1f6feb;color:#fff;border:0;border-radius:6px;padding:6px 10px;cursor:pointer">Deposit</button>
          </div>
        </div>
      </div>`;

    // Build item list (stackables + weapon ammo)
    function itemRow(label, hint, btnId, disabled){
      return `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;border-bottom:1px solid #19243a">
          <div><strong>${label}</strong><div style="opacity:.7;font-size:12px">${hint||''}</div></div>
          <button id="${btnId}" ${disabled?'disabled':''} style="background:${disabled?'#243248':'#2ea043'};color:#fff;border:0;border-radius:6px;padding:6px 10px;cursor:${disabled?'default':'pointer'}">${disabled?'—':'Deposit 1'}</button>
        </div>`;
    }

    // Detect stackables by .count
    const stackables = [];
    Object.keys(inv||{}).forEach(k=>{
      const v=inv[k];
      if(v && typeof v==='object' && typeof v.count==='number' && v.count>0){
        stackables.push({key:k, count:v.count});
      }
    });

    // Ammo rows for pistol/uzi
    const ammoRows = [];
    if(inv?.pistol?.ammo>0){
      ammoRows.push({ key:'pistol', ammo: inv.pistol.ammo|0 });
    }
    if(inv?.uzi?.ammo>0){
      ammoRows.push({ key:'uzi', ammo: inv.uzi.ammo|0 });
    }

    let list = `<div style="background:#0c1422;border:1px solid #22314b;border-radius:10px;overflow:hidden">`;
    if(stackables.length===0 && ammoRows.length===0){
      list += `<div style="padding:12px;opacity:.75">No depositable items in your inventory right now.</div>`;
    }else{
      stackables.forEach(s=>{
        list += itemRow(`${s.key} ×${s.count}`, `Click to move 1 to bank.`, `dep_item_${s.key}`, false);
      });
      ammoRows.forEach(a=>{
        list += `
          <div style="padding:10px;border-bottom:1px solid #19243a">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <div><strong>${a.key} ammo</strong><div style="opacity:.7;font-size:12px">You have ${a.ammo} rounds</div></div>
              <div>
                <input id="dep_${a.key}_amt" type="number" min="1" max="${a.ammo}" value="${Math.min(10,a.ammo)}" style="width:80px;background:#0c1422;border:1px solid #2b3b57;border-radius:6px;color:#cfe3ff;padding:4px 6px">
                <button id="dep_${a.key}_btn" style="margin-left:6px;background:#2ea043;color:#fff;border:0;border-radius:6px;padding:6px 10px;cursor:pointer">Deposit Ammo</button>
              </div>
            </div>
          </div>`;
      });
    }
    list += `</div>`;

    host.innerHTML = coinPart + list;

    // wire coin deposit
    host.querySelector('#bankDepCoinsBtn')?.addEventListener('click', ()=>{
      const amt = Math.max(0, Math.min(api.getCoins(), parseInt(host.querySelector('#bankDepCoinsAmt').value||'0',10)));
      if(amt>0){
        api.setCoins(api.getCoins()-amt);
        bank.coins = (bank.coins|0) + amt;
        _writeBank(bank);
        _updateBankCoinsView();
        host.querySelector('#bankDepCoinsAmt').max = api.getCoins();
      }
    });

    // wire stackables deposit (1 each click)
    stackables.forEach(s=>{
      host.querySelector(`#dep_item_${s.key}`)?.addEventListener('click', ()=>{
        const inv2=_readInv(), bank2=_readBank();
        if(inv2?.[s.key]?.count>0){
          inv2[s.key].count -= 1;
          if(inv2[s.key].count<=0){ inv2[s.key].count=0; }
          bank2.items[s.key] = (bank2.items[s.key]|0) + 1;
          _writeInv(inv2); _writeBank(bank2);
          _drawDeposit(); // refresh view counts
        }
      });
    });

    
    // wire ammo deposit
    ammoRows.forEach(a=>{
      host.querySelector(`#dep_${a.key}_btn`)?.addEventListener('click', ()=>{
        const n = Math.max(1, Math.min((_readInv()?.[a.key]?.ammo|0), parseInt(host.querySelector(`#dep_${a.key}_amt`).value||'1',10)));
        if(n>0){
          const inv2=_readInv(), bank2=_readBank();
          inv2[a.key].ammo = (inv2[a.key].ammo|0)-n; if(inv2[a.key].ammo<0) inv2[a.key].ammo=0;
          bank2.ammo[a.key] = (bank2.ammo[a.key]|0)+n;
          _writeInv(inv2); _writeBank(bank2);
          _drawDeposit();
        }
      });
    });
  }
  
  function _drawWithdraw(){
    const host=document.getElementById('bankBody'); if(!host) return;
    const api=IZZA.api, bank=_readBank(), inv=_readInv();

    const coinPart = `
      <div style="background:#111b29;border:1px solid #2b3b57;border-radius:10px;padding:10px;margin-bottom:10px">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
          <div><strong>Withdraw Coins</strong><div style="opacity:.7;font-size:12px">Move IZZA Coins back to your wallet.</div></div>
          <div>
            <input id="bankWCoinsAmt" type="number" min="0" max="${bank.coins|0}" value="${Math.min(100, bank.coins|0)}" style="width:90px;background:#0c1422;border:1px solid #2b3b57;border-radius:6px;color:#cfe3ff;padding:4px 6px">
            <button id="bankWCoinsBtn" style="margin-left:6px;background:#2ea043;color:#fff;border:0;border-radius:6px;padding:6px 10px;cursor:pointer">Withdraw</button>
          </div>
        </div>
      </div>`;

    // Items listing
    const entries = [];
    Object.keys(bank.items||{}).forEach(k=>{
      const c=bank.items[k]|0;
      if(c>0) entries.push({type:'item', key:k, count:c});
    });
    Object.keys(bank.ammo||{}).forEach(k=>{
      const a=bank.ammo[k]|0;
      if(a>0) entries.push({type:'ammo', key:k, ammo:a});
    });

    let list = `<div style="background:#0c1422;border:1px solid #22314b;border-radius:10px;overflow:hidden">`;
    if(entries.length===0){
      list += `<div style="padding:12px;opacity:.75">Your bank is empty.</div>`;
    }else{
      entries.forEach(e=>{
        if(e.type==='item'){
          list += `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;border-bottom:1px solid #19243a">
              <div><strong>${e.key}</strong><div style="opacity:.7;font-size:12px">In bank: ${e.count}</div></div>
              <button id="w_item_${e.key}" style="background:#1f6feb;color:#fff;border:0;border-radius:6px;padding:6px 10px;cursor:pointer">Withdraw 1</button>
            </div>`;
        }else{
          list += `
            <div style="padding:10px;border-bottom:1px solid #19243a">
              <div style="display:flex;justify-content:space-between;align-items:center">
                <div><strong>${e.key} ammo</strong><div style="opacity:.7;font-size:12px">In bank: ${e.ammo}</div></div>
                <div>
                  <input id="w_${e.key}_amt" type="number" min="1" max="${e.ammo}" value="${Math.min(10,e.ammo)}" style="width:80px;background:#0c1422;border:1px solid #2b3b57;border-radius:6px;color:#cfe3ff;padding:4px 6px">
                  <button id="w_${e.key}_btn" style="margin-left:6px;background:#1f6feb;color:#fff;border:0;border-radius:6px;padding:6px 10px;cursor:pointer">Withdraw</button>
                </div>
              </div>
            </div>`;
        }
      });
    }
    list += `</div>`;
    host.innerHTML = coinPart + list;

    // wire coin withdraw
    host.querySelector('#bankWCoinsBtn')?.addEventListener('click', ()=>{
      const b=_readBank();
      const amt = Math.max(0, Math.min(b.coins|0, parseInt(host.querySelector('#bankWCoinsAmt').value||'0',10)));
      if(amt>0){
        b.coins = (b.coins|0)-amt; if(b.coins<0)b.coins=0;
        _writeBank(b);
        api.setCoins(api.getCoins()+amt);
        _updateBankCoinsView();
        _drawWithdraw();
      }
    });

    // wire item withdraws
    entries.filter(e=>e.type==='item').forEach(e=>{
      host.querySelector(`#w_item_${e.key}`)?.addEventListener('click', ()=>{
        const b=_readBank(), inv2=_readInv();
        if((b.items[e.key]|0)>0){
          b.items[e.key]-=1; if(b.items[e.key]<0)b.items[e.key]=0;
          inv2[e.key] = inv2[e.key]||{count:0};
          if(typeof inv2[e.key].count!=='number') inv2[e.key].count=0;
          inv2[e.key].count += 1;
          _writeBank(b); _writeInv(inv2);
          _drawWithdraw();
        }
      });
    });

    // wire ammo withdraws
    entries.filter(e=>e.type==='ammo').forEach(e=>{
      host.querySelector(`#w_${e.key}_btn`)?.addEventListener('click', ()=>{
        const b=_readBank(), inv2=_readInv();
        const n = Math.max(1, Math.min((b.ammo[e.key]|0), parseInt(host.querySelector(`#w_${e.key}_amt`).value||'1',10)));
        if(n>0){
          b.ammo[e.key] = (b.ammo[e.key]|0)-n; if(b.ammo[e.key]<0)b.ammo[e.key]=0;
          inv2[e.key] = inv2[e.key]||{};
          inv2[e.key].ammo = (inv2[e.key].ammo|0)+n;
          _writeBank(b); _writeInv(inv2);
          _drawWithdraw();
        }
      });
    });
  }

  // --------- BANK input: press B near bank door ----------
  function _onPressBankB(e){
    const api=IZZA.api; if(!api?.ready) return;
    const B = window.__IZZA_BANK__?.door; if(!B) return;
    const t=api.TILE, gx=((api.player.x+16)/t|0), gy=((api.player.y+16)/t|0);
    const near = Math.abs(gx-B.x)<=1 && Math.abs(gy-B.y)<=1;
    if(!near) return;
    if(e){ e.preventDefault?.(); e.stopImmediatePropagation?.(); e.stopPropagation?.(); }
    _bankOpen();
  }
  document.getElementById('btnB')?.addEventListener('click', _onPressBankB, true);
  window.addEventListener('keydown', e=>{ if(e.key.toLowerCase()==='b') _onPressBankB(e); }, true);
// ---------- ARMOURY UI ----------
function _ensureArmouryUI(){
  if (document.getElementById('armouryUI')) return;
  const wrap=document.createElement('div');
  wrap.id='armouryUI';
  wrap.style.cssText='position:absolute;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.45);z-index:70;';
  wrap.innerHTML = `
    <div style="min-width:300px;background:#0f1624;border:1px solid #2b3b57;border-radius:12px;padding:14px;color:#e7eef7;box-shadow:0 14px 38px rgba(0,0,0,.55)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <strong>🔧 Armoury</strong>
        <button id="armouryClose" style="background:#263447;color:#cfe3ff;border:0;border-radius:6px;padding:6px 10px;cursor:pointer">Close</button>
      </div>
      <div style="opacity:.85;margin-bottom:8px">(stub) Buy ammo &amp; upgrades here.</div>
      <button id="armouryOk" style="width:100%;padding:10px;border:0;border-radius:8px;background:#1f6feb;color:#fff;font-weight:700;cursor:pointer">OK</button>
    </div>`;
  document.body.appendChild(wrap);
  wrap.querySelector('#armouryClose').onclick = ()=> _armouryClose();
  wrap.querySelector('#armouryOk').onclick    = ()=> _armouryClose();
}
function _armouryOpen(){ _ensureArmouryUI(); document.getElementById('armouryUI').style.display='flex'; }
function _armouryClose(){ const el=document.getElementById('armouryUI'); if(el) el.style.display='none'; }

// Press B near the island armoury door → open modal
function _onPressArmouryB(e){
  const d = window.__IZZA_ARMOURY__?.door; if(!d || !IZZA?.api?.ready) return;
  const t=IZZA.api.TILE, gx=((IZZA.api.player.x+16)/t|0), gy=((IZZA.api.player.y+16)/t|0);
  const near = Math.abs(gx-d.x)<=1 && Math.abs(gy-d.y)<=1;
  if(!near) return;
  e?.preventDefault?.(); e?.stopImmediatePropagation?.(); e?.stopPropagation?.();
  _armouryOpen();
}
document.getElementById('btnB')?.addEventListener('click', _onPressArmouryB, true);
window.addEventListener('keydown', e=>{ if((e.key||'').toLowerCase()==='b') _onPressArmouryB(e); }, true);
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

  // Sidewalks around the new road grid (matches render-under logic)
  ctx.fillStyle = '#a1a6b0';
  H_ROADS.forEach(r=>{
    for(let x=r.x0;x<=r.x1;x++){
      if(!V_COLS_ALL.has(x)){
        if(!isOriginalTile(x, r.y-1, A)) ctx.fillRect(x*sx, (r.y-1)*sy, 1*sx, 1*sy);
        if(!isOriginalTile(x, r.y+1, A)) ctx.fillRect(x*sx, (r.y+1)*sy, 1*sx, 1*sy);
      }
    }
  });
  V_ROADS.forEach(r=>{
    for(let y=r.y0;y<=r.y1;y++){
      if(H_ROWS_ALL.has(y) || isTier1Y(y)) continue;
      if(!isOriginalTile(r.x-1, y, A)) ctx.fillRect((r.x-1)*sx, y*sy, 1*sx, 1*sy);
      if(!isOriginalTile(r.x+1, y, A)) ctx.fillRect((r.x+1)*sx, y*sy, 1*sx, 1*sy);
    }
  });

  // Roads
  ctx.fillStyle = '#8a90a0';
  H_ROADS.forEach(r=> ctx.fillRect(r.x0*sx, r.y*sy, (r.x1-r.x0+1)*sx, 1.2*sy));
  V_ROADS.forEach(r=> ctx.fillRect(r.x*sx, r.y0*sy, 1.2*sx, (r.y1-r.y0+1)*sy));

  // Hood grid
  HOOD_H.forEach(y=>{
    const segs = clipHRow(y, A.un.x0, A.un.x1, [HOOD_PARK]);
    segs.forEach(s=> ctx.fillRect(s.x0*sx, y*sy, (s.x1-s.x0+1)*sx, 1.2*sy));
  });
  HOOD_V.forEach(x=>{
    const segs = clipVCol(x, A.un.y0, A.un.y1, [HOOD_PARK]);
    segs.forEach(s=> ctx.fillRect(x*sx, s.y0*sy, 1.2*sx, (s.y1-s.y0+1)*sy));
  });

  // Downtown blocks
  ctx.fillStyle = '#6f87b3';
  (_layout.BUILDINGS||[]).forEach(b=> ctx.fillRect(b.x*sx,b.y*sy,b.w*sx,b.h*sy));

  // Hospital
  if(_hospital){
    ctx.fillStyle = COL.hospital;
    ctx.fillRect(_hospital.x0*sx,_hospital.y0*sy,( (_hospital.x1-_hospital.x0+1) )*sx,( (_hospital.y1-_hospital.y0+1) )*sy);
  }

  // BANK
  if(window.__IZZA_BANK__?.rect){
    const B = window.__IZZA_BANK__.rect;
    ctx.fillStyle = '#e7c14a';
    ctx.fillRect(B.x0*sx,B.y0*sy,(B.x1-B.x0+1)*sx,(B.y1-B.y0+1)*sy);
  }

  // Tier-1 HQ & Shop
  ctx.fillStyle = COL.civic;
  ctx.fillRect(A.HQ.x0*sx, A.HQ.y0*sy, (A.HQ.x1 - A.HQ.x0 + 1)*sx, (A.HQ.y1 - A.HQ.y0 + 1)*sy);
  ctx.fillStyle = COL.shop;
  ctx.fillRect(A.SH.x0*sx, A.SH.y0*sy, (A.SH.x1 - A.SH.x0 + 1)*sx, (A.SH.y1 - A.SH.y0 + 1)*sy);

  // Docks
  ctx.fillStyle = COL.wood;
  lakeRects(A).DOCKS.forEach(d=>{
    ctx.fillRect(d.x0*sx, d.y*sy, d.len*sx, 1*sy);
  });

  // Manual patches
  ctx.fillStyle='#8a90a0';
  [
    {x:27,y:24},{x:29,y:24},
    {x:29,y:14},{x:27,y:14},{x:21,y:14},{x:19,y:14},
    {x:21,y:24},{x:19,y:24},{x:19,y:30},{x:21,y:30},{x:27,y:30},{x:29,y:30},
    {x:44,y:26},{x:44,y:27},{x:56,y:49},{x:56,y:47},{x:56,y:45},{x:56,y:43},
    {x:66,y:34}
  ].forEach(p=> ctx.fillRect(p.x*sx,p.y*sy,1*sx,1.2*sy));
  ctx.fillRect(69*sx,30*sy,(76-69+1)*sx,1.2*sy);

  ctx.fillStyle='#a1a6b0';
  ctx.fillRect(69*sx,31*sy,(76-69+1)*sx,1.2*sy);
  ctx.fillRect(66*sx,15*sy,(72-66+1)*sx,1.2*sy);
  [ {x:44,y:15},{x:43,y:26},{x:43,y:27},{x:65,y:34},{x:67,y:34} ]
    .forEach(p=> ctx.fillRect(p.x*sx,p.y*sy,1*sx,1.2*sy));
}

// Make painter available to other modules (e.g., bigmap overlay)
window.__izzaPaintOverlay = paintOverlay;

// Repaint ONLY the minimap each frame; bigmap is handled by the overlay IIFE when open
IZZA.on('render-post', ()=>{
  if (isTier2()){
    paintOverlay('minimap');
  }
});

// ===== Bigmap overlay: open on minimap tap, close on tap/Esc, block input safely =====
(function initBigmapOverlay(){
  let bigOpen = false;
  let prevInputBlocked = false;

  function ensureBigmapUI(){
    if (document.getElementById('bigmapWrap')) return;

    const wrap = document.createElement('div');
    wrap.id = 'bigmapWrap';
    wrap.style.cssText =
      'position:absolute;inset:0;display:none;align-items:center;justify-content:center;' +
      'background:rgba(0,0,0,.55);z-index:120;';
    wrap.style.touchAction = 'none';

    const closeBtn = document.createElement('button');
    closeBtn.id = 'bigmapClose';
    closeBtn.textContent = 'Close ✕';
    closeBtn.style.cssText =
      'position:absolute;top:10px;right:12px;background:#263447;color:#cfe3ff;' +
      'border:0;border-radius:8px;padding:8px 12px;font-weight:700;cursor:pointer;z-index:2;';
    wrap.appendChild(closeBtn);

    const c = document.createElement('canvas');
    c.id = 'bigmap';
    const W = Math.min(window.innerWidth * 0.9, 900);
    const H = Math.min(window.innerHeight * 0.8, 600);
    c.width  = 900;
    c.height = 600;
    c.style.width  = Math.round(W) + 'px';
    c.style.height = Math.round(H) + 'px';
    c.style.background = '#0b1220';
    c.style.borderRadius = '14px';
    c.style.boxShadow = '0 14px 44px rgba(0,0,0,.6)';

    const hint = document.createElement('div');
    hint.textContent = 'Tap anywhere or press Esc to close';
    hint.style.cssText = 'margin-top:10px;color:#cfe3ff;opacity:.8;font-size:12px';

    const inner = document.createElement('div');
    inner.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:8px';
    inner.appendChild(c); inner.appendChild(hint);

    wrap.appendChild(inner);
    document.body.appendChild(wrap);

    const closeOnDown = e => { e.preventDefault(); e.stopImmediatePropagation(); closeBigmap(); };
    closeBtn.addEventListener('pointerdown', closeOnDown, {capture:true});
    closeBtn.addEventListener('touchstart',  closeOnDown, {capture:true, passive:false});
    wrap.addEventListener('pointerdown', closeOnDown, {capture:true});
    wrap.addEventListener('touchstart',  closeOnDown, {capture:true, passive:false});

    window.addEventListener('keydown', e=>{
      if (!bigOpen) return;
      if ((e.key||'').toLowerCase()==='escape') { e.preventDefault(); closeBigmap(); }
    }, true);
  }

  function openBigmap(ev){
    if (ev){ ev.preventDefault?.(); ev.stopImmediatePropagation?.(); ev.stopPropagation?.(); }
    if (!IZZA?.api?.ready) return;
    ensureBigmapUI();

    prevInputBlocked = !!IZZA.inputBlocked;
    IZZA.inputBlocked = true;

    const wrap = document.getElementById('bigmapWrap');
    wrap.style.display = 'flex';
    bigOpen = true;

    // Paint once on open
    window.__izzaPaintOverlay && window.__izzaPaintOverlay('bigmap');

    document.getElementById('btnMap')?.setAttribute('disabled','true');
    const stick = document.getElementById('stickZone');
    if (stick && stick.style) stick.style.visibility = 'hidden';
  }

  function closeBigmap(){
    if (!bigOpen) return;
    const wrap = document.getElementById('bigmapWrap');
    if (wrap) wrap.style.display = 'none';
    bigOpen = false;

    IZZA.inputBlocked = prevInputBlocked ? true : false;

    const stick = document.getElementById('stickZone');
    if (stick && stick.style) stick.style.visibility = 'visible';
    document.getElementById('btnMap')?.removeAttribute('disabled');
  }

  // Hook minimap tap → openBigmap
  const mini = document.getElementById('minimap');
  if (mini){
    const openAndStop = e => { openBigmap(e); };
    ['pointerdown','touchstart','click'].forEach(evt=>{
      mini.addEventListener(evt, openAndStop, {capture:true, passive: evt==='touchstart' ? false : undefined});
    });
  }

  // While open, keep the bigmap canvas fresh each frame
  IZZA.on('render-post', ()=>{
    if (bigOpen) {
      window.__izzaPaintOverlay && window.__izzaPaintOverlay('bigmap');
    }
  });
})();
})();
