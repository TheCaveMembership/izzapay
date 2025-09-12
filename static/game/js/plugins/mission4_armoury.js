// v2.4 — Mission 4 Armoury (logic/UI only; expander owns visuals)
// - Fix: B on cardboard box works (capture listeners remain)
// - Fix: Always-available re-embark from island sand-dock tile
// - Keep: One-shot "next B anywhere on sand" after first Armoury open
// - Fix: Republish island land each frame to avoid north-edge slipping
(function(){
  const BUILD='v2.4-m4-armoury-logic';
  console.log('[IZZA PLAY]', BUILD);

  let api=null;

  // ---- Keys / flags ----
  const LS_KEYS = { mission4:'izzaMission4', armour:'izzaArmour' };
  const BOX_TAKEN_KEY = 'izzaBoxTaken';
  const RETURN_TO_BOAT_FLAG = 'izzaM4ReturnToBoatNextB'; // one-shot embark after first door use

  // IMPORTANT: Do NOT set window.__IZZA_ARMOURY__.owner here.
  // The map-expander paints the island and exports rect/door/dock.

  // ===== geometry (mirror expander math) =====
  function unlockedRect(t){ return (t!=='2')?{x0:18,y0:18,x1:72,y1:42}:{x0:10,y0:12,x1:80,y1:50}; }
  function anchors(){
    const tier=(localStorage.getItem('izzaMapTier')||'1');
    return { un: unlockedRect(tier) };
  }
  function lakeRects(a){
    const LAKE={ x0:a.un.x1-14, y0:a.un.y0+23, x1:a.un.x1, y1:a.un.y1 };
    return { LAKE };
  }
  function islandSpec(){
    const a=anchors(); const {LAKE}=lakeRects(a);
    const w=5, h=4;
    const x1 = LAKE.x1 - 1;
    const x0 = x1 - (w-1);
    const yMid = (LAKE.y0 + LAKE.y1) >> 1;
    const y0 = yMid - (h>>1);
    const y1 = y0 + h - 1;
    const ISLAND = { x0:Math.max(LAKE.x0,x0), y0:Math.max(LAKE.y0,y0), x1, y1:Math.min(LAKE.y1,y1) };

    // NOTE: expander now renders the “building” as a **single door tile** at (BX,BY+1)
    const BX = ISLAND.x0 + Math.floor((w-1)/2); // center X
    const BY = ISLAND.y0 + Math.floor((h-1)/2) - 1; // building sits one tile north of door
    const BUILDING = { x0:BX, y0:BY, x1:BX, y1:BY }; // single tile (for solidity if needed)
    const DOOR_GRID = { x: BX, y: BY+1 };            // the door tile (the one you press B on)

    // Island dock (logic only; visuals hidden in expander)
    const dockY = (ISLAND.y0 + ISLAND.y1) >> 1;
    const ISLAND_DOCK = {
      water: { x: ISLAND.x0 - 1, y: dockY },  // water tile
      sand:  { x: ISLAND.x0,     y: dockY }   // sand tile (stand here to re-embark)
    };

    return { ISLAND, BUILDING, DOOR_GRID, ISLAND_DOCK };
  }

  // ===== publish island "land" set (pre-physics every tick) =====
  function publishIslandLand(){
    if(localStorage.getItem('izzaMapTier')!=='2'){ window._izzaIslandLand=null; return; }
    const {ISLAND}=islandSpec();
    const land=new Set();
    for(let y=ISLAND.y0;y<=ISLAND.y1;y++)
      for(let x=ISLAND.x0;x<=ISLAND.x1;x++)
        land.add(x+'|'+y);
    window._izzaIslandLand = land;
  }
  IZZA.on('update-pre', publishIslandLand);
  IZZA.on('ready', publishIslandLand);

  // ===== HQ door → cardboard box position =====
  function hqDoorGrid(){ const t=api.TILE, d=api.doorSpawn; return { gx:Math.round(d.x/t), gy:Math.round(d.y/t) }; }
  function cardboardBoxGrid(){ const d=hqDoorGrid(); return { x:d.gx+3, y:d.gy+10 }; }

  // ===== inventory helpers =====
  function getInv(){ try{ return api.getInventory()||{}; }catch{return {};}}
  function setInv(inv){
    try{
      api.setInventory(inv);
      if(typeof window.renderInventoryPanel==='function') window.renderInventoryPanel();
      window.dispatchEvent(new Event('izza-inventory-changed'));
    }catch{}
  }
  function addCount(inv,key,n){
    inv[key]=inv[key]||{count:0};
    inv[key].count=(inv[key].count|0)+n;
    if(inv[key].count<=0) delete inv[key];
  }

  // ===== mission/armour state =====
  function getM4(){ return localStorage.getItem(LS_KEYS.mission4)||'not-started'; }
  function setM4(v){ localStorage.setItem(LS_KEYS.mission4, v); }
  function getArmour(){ try{ return JSON.parse(localStorage.getItem(LS_KEYS.armour)||'null'); }catch{return null;} }
  function setArmour(o){ localStorage.setItem(LS_KEYS.armour, JSON.stringify(o||null)); window.dispatchEvent(new Event('izza-armour-changed')); }

  // ===== fallback Armoury dialog (if your main UI isn’t present) =====
  function openArmouryFallback(){
    const m=document.createElement('div');
    m.className='modal'; m.style.display='flex';
    m.innerHTML=`
      <div class="backdrop"></div>
      <div class="card" style="min-width:300px;max-width:520px">
        <h3>🛡️ Armoury</h3>
        <div style="line-height:1.5">
          Welcome to the <b>Armoury</b>! Here you can craft armour to reduce your opponents’ attacks on you.
        </div>
        <div class="row" style="margin-top:10px;gap:8px">
          <button class="ghost" id="ok">OK</button>
        </div>
      </div>`;
    document.body.appendChild(m);
    const close=()=>m.remove();
    m.querySelector('.backdrop').addEventListener('click', close, {passive:true});
    m.querySelector('#ok').addEventListener('click', close, {passive:true});
  }

  // ===== tiny helper: draw the cardboard box sprite (visual only) =====
  function draw3DBox(ctx, sx, sy, S){
    ctx.save();
    ctx.translate(sx, sy);
    ctx.scale((S*0.68)/44, (S*0.68)/44);
    ctx.translate(-22, -22);
    // soft shadow
    ctx.fillStyle='rgba(0,0,0,0.18)'; ctx.beginPath(); ctx.ellipse(22,28,14,6,0,0,Math.PI*2); ctx.fill();
    // body
    const body = new Path2D('M6,18 L22,10 L38,18 L38,34 L22,42 L6,34 Z');
    ctx.fillStyle='#b98c4a'; ctx.fill(body);
    ctx.strokeStyle='#7d5f2e'; ctx.lineWidth=1.3; ctx.stroke(body);
    // flaps
    const flapL = new Path2D('M6,18 L22,26 L22,10 Z');
    const flapR = new Path2D('M38,18 L22,26 L22,10 Z');
    ctx.fillStyle='#cfa162'; ctx.fill(flapL); ctx.fill(flapR); ctx.stroke(flapL); ctx.stroke(flapR);
    // tape
    ctx.fillStyle='#e9dfb1'; ctx.fillRect(21,10,2,16);
    ctx.restore();
  }

  // ===== render-under: only draw the box near HQ (island visuals = expander) =====
  function renderBoxOnly(){
    if(!api?.ready) return;
    if(localStorage.getItem('izzaMapTier')!=='2') return;
    if(localStorage.getItem(BOX_TAKEN_KEY) === '1') return;

    const S=api.DRAW, t=api.TILE, b=cardboardBoxGrid();
    const bx=(b.x*t - api.camera.x)*(S/t) + S*0.5;
    const by=(b.y*t - api.camera.y)*(S/t) + S*0.6;
    const ctx=document.getElementById('game').getContext('2d');
    draw3DBox(ctx, bx, by, S);
  }
  IZZA.on('render-under', renderBoxOnly);

  // ===== boat hook =====
  function requestBoatEmbarkFromIsland(){
    try{ window.dispatchEvent(new CustomEvent('izza-boat-request',{detail:{action:'embark-from-island'}})); }catch{}
    try{ window._izzaBoat?.embarkFromLand?.('island'); }catch{}
    try{ IZZA.boat?.embarkFromLand?.('island'); }catch{}
  }
// ---- box prompt shim (so B always works even if your main UI isn't loaded) ----
function showBoxYesNo(fn){
  if (typeof window.showBoxYesNo === 'function') return window.showBoxYesNo(fn);
  // fallback prompt
  if (window.confirm?.('Pick up the Cardboard Box?')) fn?.();
}
  // ===== B actions =====
  function onB(e){
  if (!api?.ready) return;

  const t  = api.TILE;
  const gx = ((api.player.x+16)/t|0);
  const gy = ((api.player.y+16)/t|0);

  // Pull the island geometry & perimeter dock published by the expander
  const ISLAND = window.__IZZA_ARMOURY__?.island || null;
  const DOCK   = window.__IZZA_ISLAND_DOCK__   || null;
  const DOOR   = window.__IZZA_ARMOURY__?.door || null;

  // --- helpers for array/single compat ----
  const toArr = v => (!v ? [] : Array.isArray(v) ? v : (typeof v.x==='number' && typeof v.y==='number') ? [v] : []);
  const dockSand  = toArr(DOCK?.sand);
  const dockWater = toArr(DOCK?.water);
  const key = (x,y)=> x+'|'+y;
  const sandSet  = new Set(dockSand.map(p=>key(p.x,p.y)));
  const waterSet = new Set(dockWater.map(p=>key(p.x,p.y)));

  const isOnAnySandDock  = sandSet.has(key(gx,gy));
  const isOnAnyWaterDock = waterSet.has(key(gx,gy));
  const adjToAnyWaterDock =
    dockWater.some(p => Math.abs(gx - p.x) + Math.abs(gy - p.y) === 1);

  function snapPlayerToNearestDockWater(){
    let best = null, bestD = 1e9;
    const px = api.player.x/t, py = api.player.y/t;
    (dockWater.length ? dockWater : (ISLAND ? [{x:ISLAND.x0-1,y:((ISLAND.y0+ISLAND.y1)>>1)}] : []))
      .forEach(p=>{
        const dx = (p.x - px), dy = (p.y - py);
        const d2 = dx*dx + dy*dy;
        if(d2 < bestD){ bestD = d2; best = p; }
      });
    if (best){
      api.player.x = best.x*t + 4;   // small bias keeps us clearly in that tile
      api.player.y = best.y*t + 4;
    }
  }

  // (A) Embark anywhere along the island edge (on sand, on water, or 4-way adjacent to water)
  if (DOCK && (isOnAnySandDock || isOnAnyWaterDock || adjToAnyWaterDock)) {
    e?.preventDefault?.(); e?.stopImmediatePropagation?.(); e?.stopPropagation?.();
    snapPlayerToNearestDockWater();              // guaranteed boat spawns on water
    localStorage.removeItem(RETURN_TO_BOAT_FLAG);
    requestBoatEmbarkFromIsland();
    return;
  }

  // (B) One-shot safety: after first armoury open, next B anywhere on ISLAND sand → embark
  if (ISLAND && localStorage.getItem(RETURN_TO_BOAT_FLAG) === '1'){
    const onIslandSand =
      gx >= ISLAND.x0 && gx <= ISLAND.x1 &&
      gy >= ISLAND.y0 && gy <= ISLAND.y1;
    if (onIslandSand){
      e?.preventDefault?.(); e?.stopImmediatePropagation?.(); e?.stopPropagation?.();
      snapPlayerToNearestDockWater();
      localStorage.removeItem(RETURN_TO_BOAT_FLAG);
      requestBoatEmbarkFromIsland();
      return;
    }
  }

  // (C) Cardboard box pickup (unchanged)
  const box = cardboardBoxGrid();
  const boxStillThere = localStorage.getItem(BOX_TAKEN_KEY) !== '1';
  if (boxStillThere && gx === box.x && gy === box.y){
    e?.preventDefault?.(); e?.stopImmediatePropagation?.(); e?.stopPropagation?.();
    if (getM4() === 'not-started') setM4('started');
    showBoxYesNo(()=>{
      const inv = getInv();
      addCount(inv, 'cardboard_box', 1);
      setInv(inv);
      localStorage.setItem(BOX_TAKEN_KEY, '1');
      IZZA.toast?.('Cardboard Box added to Inventory');
    });
    return;
  }

  // (D) Armoury door open
  if (localStorage.getItem('izzaMapTier') === '2' && DOOR && gx === DOOR.x && gy === DOOR.y){
    e?.preventDefault?.(); e?.stopImmediatePropagation?.(); e?.stopPropagation?.();
    if (typeof window.openArmoury === 'function') window.openArmoury();
    else openArmouryFallback();
    localStorage.setItem(RETURN_TO_BOAT_FLAG, '1');
    return;
  }
}
  // ===== boot =====
  IZZA.on('ready', (a)=>{
    api=a;
    const btnB=document.getElementById('btnB');
    btnB?.addEventListener('click', onB, true);                         // capture
    window.addEventListener('keydown', e=>{ if((e.key||'').toLowerCase()==='b') onB(e); }, true); // capture
    console.log('[mission4] ready', BUILD);
  });
})();
