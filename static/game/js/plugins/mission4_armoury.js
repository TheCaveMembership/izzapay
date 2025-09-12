// v2.5 — Mission 4 Armoury (logic/UI only; expander owns visuals)
// - Robust island docking: supports single-tile or full-perimeter docks
// - Geometry fallback: docks at closest island edge if arrays missing or out of range
// - Snap radius widened (<=3) so B works even if slightly off-tile
// - Keeps box pickup + armoury door + one-shot embark
// - Republish island land to avoid edge slipping
(function(){
  const BUILD='v2.5-m4-armoury-logic';
  console.log('[IZZA PLAY]', BUILD);

  let api=null;

  // ---- Keys / flags ----
  const LS_KEYS = { mission4:'izzaMission4', armour:'izzaArmour' };
  const BOX_TAKEN_KEY = 'izzaBoxTaken';
  const RETURN_TO_BOAT_FLAG = 'izzaM4ReturnToBoatNextB'; // one-shot embark after first door use

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

    // single-tile "building" north of the door
    const BX = ISLAND.x0 + Math.floor((w-1)/2);
    const BY = ISLAND.y0 + Math.floor((h-1)/2) - 1;
    const BUILDING = { x0:BX, y0:BY, x1:BX, y1:BY };
    const DOOR_GRID = { x: BX, y: BY+1 };

    // legacy single dock (kept for compatibility)
    const dockY = (ISLAND.y0 + ISLAND.y1) >> 1;
    const ISLAND_DOCK = {
      water: { x: ISLAND.x0 - 1, y: dockY },
      sand:  { x: ISLAND.x0,     y: dockY }
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

  // ===== fallback Armoury dialog =====
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
    ctx.fillStyle='rgba(0,0,0,0.18)'; ctx.beginPath(); ctx.ellipse(22,28,14,6,0,0,Math.PI*2); ctx.fill();
    const body = new Path2D('M6,18 L22,10 L38,18 L38,34 L22,42 L6,34 Z');
    ctx.fillStyle='#b98c4a'; ctx.fill(body);
    ctx.strokeStyle='#7d5f2e'; ctx.lineWidth=1.3; ctx.stroke(body);
    const flapL = new Path2D('M6,18 L22,26 L22,10 Z');
    const flapR = new Path2D('M38,18 L22,26 L22,10 Z');
    ctx.fillStyle='#cfa162'; ctx.fill(flapL); ctx.fill(flapR); ctx.stroke(flapL); ctx.stroke(flapR);
    ctx.fillStyle='#e9dfb1'; ctx.fillRect(21,10,2,16);
    ctx.restore();
  }

  // ===== render-under: only draw the box near HQ =====
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

  // ---- boat request helpers (explicit positions) ----
  function requestBoatEmbarkFromIsland(at){
    // at = { water:{x,y}, sand:{x,y} }
    try{ window.dispatchEvent(new CustomEvent('izza-boat-request',{detail:{action:'embark-from-island', at}})); }catch{}
    try{ window._izzaBoat?.embarkFromLand?.('island', at); }catch{}
    try{ IZZA.boat?.embarkFromLand?.('island', at); }catch{}
  }
  function requestBoatDisembarkToIsland(at){
    // at = { water:{x,y}, land:{x,y} }
    try{ window.dispatchEvent(new CustomEvent('izza-boat-request',{detail:{action:'disembark-to-island', at}})); }catch{}
    try{ window._izzaBoat?.disembarkToLand?.('island', at); }catch{}
    try{ IZZA.boat?.disembarkToLand?.('island', at); }catch{}
  }

  // ---- dock normalization + geometry fallback ----
  function _normalizeIslandDock(D){
    if (!D) return null;
    const toArr = v => Array.isArray(v)
      ? v
      : (v && typeof v.x==='number' && typeof v.y==='number') ? [v] : [];
    return { water: toArr(D.water), sand: toArr(D.sand) };
  }
  function _inRect(x,y,R){ return x>=R.x0 && x<=R.x1 && y>=R.y0 && y<=R.y1; }
  function _sandBesideWater(w, ISLAND){
    const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
    for (const [dx,dy] of dirs){
      const sx = w.x+dx, sy = w.y+dy;
      if (_inRect(sx,sy,ISLAND)) return {x:sx,y:sy};
    }
    return null;
  }
  function _waterBesideSand(s, ISLAND){
    const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
    for (const [dx,dy] of dirs){
      const wx = s.x+dx, wy = s.y+dy;
      if (!_inRect(wx,wy,ISLAND)) return {x:wx,y:wy};
    }
    return null;
  }
  function _manhattan(ax,ay,bx,by){ return Math.abs(ax-bx)+Math.abs(ay-by); }

  // Build best water<->sand pair near (gx,gy) using:
  //   1) Provided dock arrays (if any), within snapRadius
  //   2) Pure geometry to the closest island edge (fallback)
  function _bestIslandEdgePair(gx,gy){
    const ISLAND = window.__IZZA_ARMOURY__?.island;
    if (!ISLAND) return null;

    const RAW = window.__IZZA_ISLAND_DOCK__;
    const DOCK = _normalizeIslandDock(RAW) || {water:[], sand:[]};
    const snapRadius = 3;

    let best = null;

    // 1) Try published water tiles → sand
    for(const w of (DOCK.water||[])){
      const d = _manhattan(gx,gy,w.x,w.y);
      if (d <= snapRadius){
        const s = _sandBesideWater(w, ISLAND);
        if (s){
          if (!best || d < best.d) best = { water:w, sand:s, d };
        }
      }
    }
    // 2) Try published sand tiles → water
    for(const s of (DOCK.sand||[])){
      const d = _manhattan(gx,gy,s.x,s.y);
      if (d <= snapRadius){
        const w = _waterBesideSand(s, ISLAND);
        if (w){
          if (!best || d < best.d) best = { water:w, sand:s, d };
        }
      }
    }

    // 3) Geometry fallback to nearest edge (if nothing matched)
    if (!best){
      // clamp player to island rectangle (extended by 1 to include the water ring)
      const cx = Math.min(ISLAND.x1+1, Math.max(ISLAND.x0-1, gx));
      const cy = Math.min(ISLAND.y1+1, Math.max(ISLAND.y0-1, gy));

      // Compute four edge candidates and pick closest
      const candidates = [
        // left edge
        { water:{x:ISLAND.x0-1, y:Math.min(ISLAND.y1, Math.max(ISLAND.y0, cy))},
          sand :{x:ISLAND.x0,   y:Math.min(ISLAND.y1, Math.max(ISLAND.y0, cy))} },
        // right edge
        { water:{x:ISLAND.x1+1, y:Math.min(ISLAND.y1, Math.max(ISLAND.y0, cy))},
          sand :{x:ISLAND.x1,   y:Math.min(ISLAND.y1, Math.max(ISLAND.y0, cy))} },
        // top edge
        { water:{x:Math.min(ISLAND.x1, Math.max(ISLAND.x0, cx)), y:ISLAND.y0-1},
          sand :{x:Math.min(ISLAND.x1, Math.max(ISLAND.x0, cx)), y:ISLAND.y0} },
        // bottom edge
        { water:{x:Math.min(ISLAND.x1, Math.max(ISLAND.x0, cx)), y:ISLAND.y1+1},
          sand :{x:Math.min(ISLAND.x1, Math.max(ISLAND.x0, cx)), y:ISLAND.y1} }
      ];
      for (const c of candidates){
        const d = Math.min(
          _manhattan(gx,gy,c.water.x,c.water.y),
          _manhattan(gx,gy,c.sand.x ,c.sand.y )
        );
        if (!best || d < best.d) best = { ...c, d };
      }
    }

    return best && { water:best.water, sand:best.sand } || null;
  }

  // ===== B actions (embark/disembark + box + armoury) =====
  function onB(e){
    if (!api?.ready) return;

    const t  = api.TILE;
    const gx = ((api.player.x+16)/t|0);
    const gy = ((api.player.y+16)/t|0);

    const ISLAND = window.__IZZA_ARMOURY__?.island || null;
    const DOOR   = window.__IZZA_ARMOURY__?.door   || null;

    // ---------- Island boat logic ----------
    if (ISLAND){
      const pair = _bestIslandEdgePair(gx,gy);

      if (window._izzaBoatActive){
        // Boating → disembark onto island edge; boat stays in adjacent water
        if (pair){
          e?.preventDefault?.(); e?.stopImmediatePropagation?.(); e?.stopPropagation?.();
          requestBoatDisembarkToIsland({ water:pair.water, land:pair.sand });
          return;
        }
      } else {
        // On foot → embark back into boat from island edge sand
        if (pair && gx===pair.sand.x && gy===pair.sand.y){
          e?.preventDefault?.(); e?.stopImmediatePropagation?.(); e?.stopPropagation?.();
          localStorage.removeItem(RETURN_TO_BOAT_FLAG);
          requestBoatEmbarkFromIsland({ water:pair.water, sand:pair.sand });
          return;
        }

        // One-shot: anywhere on island sand after first armoury open
        if (localStorage.getItem(RETURN_TO_BOAT_FLAG) === '1'){
          const onIslandSand = gx>=ISLAND.x0 && gx<=ISLAND.x1 && gy>=ISLAND.y0 && gy<=ISLAND.y1;
          if (onIslandSand){
            const p2 = _bestIslandEdgePair(gx,gy); // use same robust finder
            if (p2){
              e?.preventDefault?.(); e?.stopImmediatePropagation?.(); e?.stopPropagation?.();
              localStorage.removeItem(RETURN_TO_BOAT_FLAG);
              requestBoatEmbarkFromIsland({ water:p2.water, sand:p2.sand });
              return;
            }
          }
        }
      }
    }

    // ---------- Cardboard box pickup ----------
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

    // ---------- Armoury door ----------
    if (localStorage.getItem('izzaMapTier') === '2' && DOOR && gx === DOOR.x && gy === DOOR.y){
      e?.preventDefault?.(); e?.stopImmediatePropagation?.(); e?.stopPropagation?.();
      if (typeof window.openArmoury === 'function') window.openArmoury();
      else openArmouryFallback();
      localStorage.setItem(RETURN_TO_BOAT_FLAG, '1'); // arm one-shot embark for next B
      return;
    }
  }

  // ===== publish island "land" set (authoritative: prefer expander rect) =====
  function publishIslandLandAuthoritative(){
    if(localStorage.getItem('izzaMapTier')!=='2'){ window._izzaIslandLand=null; return; }
    const ISLAND = window.__IZZA_ARMOURY__?.island || islandSpec().ISLAND;
    const land=new Set();
    for(let y=ISLAND.y0;y<=ISLAND.y1;y++)
      for(let x=ISLAND.x0;x<=ISLAND.x1;x++)
        land.add(x+'|'+y);
    window._izzaIslandLand = land;
  }

  // ===== boot =====
  IZZA.on('ready', (a)=>{
    api=a;
    const btnB=document.getElementById('btnB');
    btnB?.addEventListener('click', onB, true);                         // capture
    window.addEventListener('keydown', e=>{ if((e.key||'').toLowerCase()==='b') onB(e); }, true); // capture
    // keep island land in sync
    publishIslandLandAuthoritative();
    IZZA.on?.('update-pre', publishIslandLandAuthoritative);
    console.log('[mission4] ready', BUILD);
  });
})();
