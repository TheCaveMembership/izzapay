// v1.20 — Boat plugin (visible boat + forgiving island re-embark)
// - Draws the boat sprite (render-over) so you’re never on an invisible boat.
// - City docks & beach: unchanged (press B on/next to the dock or beach).
// - Island: press B ANYWHERE on island sand to re-embark; snaps to nearest edge water.
// - Keeps “rescue if stranded in water” and Tier-2 gating.
// - Plays nice with map expander’s perimeter-dock handler (it only preempts on exact edge).

(function(){
  const BUILD='v1.20-boat-plugin';
  console.log('[IZZA PLAY]', BUILD);

  const TIER_KEY = 'izzaMapTier';
  const isTier2 = ()=> (localStorage.getItem(TIER_KEY) === '2');

  // ---------- State ----------
  let api = null;
  let inBoat = false;
  let ghostBoat = null;      // renders wake at previous boat pos
  let lastLand = null;       // last safe land position
  let lastWater = null;      // last valid water position when boating
  let claimedDockId = null;  // which dock row we snapped to at board time
  let waterStrandSince = 0;  // ms timestamp when stuck in water out-of-boat
  let rescueShown = false;

  function setBoatFlag(on){ window._izzaBoatActive = !!on; }

  // ---------- Geometry ----------
  function unlockedRect(t){ return (t!=='2') ? {x0:18,y0:18,x1:72,y1:42} : {x0:10,y0:12,x1:80,y1:50}; }
  function anchors(){
    const tier=localStorage.getItem(TIER_KEY)||'1';
    const un=unlockedRect(tier);
    const bW=10,bH=6;
    const bX = Math.floor((un.x0+un.x1)/2) - Math.floor(bW/2);
    const bY = un.y0 + 5;
    const hRoadY       = bY + bH + 1;
    const sidewalkTopY = hRoadY - 1;
    const vRoadX       = Math.min(un.x1-3, bX + bW + 6);
    return {un,bX,bY,bW,bH,hRoadY,sidewalkTopY,vRoadX};
  }
  function lakeRects(a){
    // Match v2_map_expander geometry
    const LAKE = { x0:a.un.x1-14, y0:a.un.y0+23, x1:a.un.x1, y1:a.un.y1 };
    const BEACH_X = LAKE.x0 - 1; // vertical beach strip on city side
    // NOTE: city docks extend one tile onto the beach in the expander.
    // Using conservative lengths here – docking works by proximity rings anyway.
    const DOCKS = [
      { x0: LAKE.x0, y: LAKE.y0+4,  len: 4 },
      { x0: LAKE.x0, y: LAKE.y0+12, len: 5 }
    ];
    return {LAKE, BEACH_X, DOCKS};
  }

  const T        = ()=> api.TILE;
  const centerGX = ()=> ((api.player.x+16)/T()|0);
  const centerGY = ()=> ((api.player.y+16)/T()|0);

  // Published by expander/mission: Set of "x|y" for island sand tiles
  const islandSet = ()=> (window._izzaIslandLand instanceof Set ? window._izzaIslandLand : new Set());
  const onIsland  = (gx,gy)=> islandSet().has(gx+'|'+gy);

  function dockCells(){
    if(!api?.ready) return new Set();
    const {DOCKS}=lakeRects(anchors());
    const s = new Set();
    DOCKS.forEach(d=>{
      for(let i=0;i<d.len;i++){
        const gx=d.x0+i;
        // allow standing ON the planks and immediately above/below to count as dock area
        s.add(gx+'|'+(d.y));
        s.add(gx+'|'+(d.y-1));
        s.add(gx+'|'+(d.y+1));
      }
    });
    return s;
  }

  // Only the inside of LAKE (minus docks + island land + beach) is water
  function tileIsWater(gx,gy){
    const {LAKE,BEACH_X} = lakeRects(anchors());
    const inside = (gx>=LAKE.x0 && gx<=LAKE.x1 && gy>=LAKE.y0 && gy<=LAKE.y1);
    if(!inside) return false;
    // Island sand is land:
    if (islandSet().has(gx+'|'+gy)) return false;
    // City docks are land for movement:
    if (dockCells().has(gx+'|'+gy)) return false;
    // City beach column is land:
    if (gx === BEACH_X) return false;
    return true;
  }
  const isLand = (gx,gy)=> !tileIsWater(gx,gy);

  function isShore(gx,gy){
    if(!isLand(gx,gy)) return false;
    return tileIsWater(gx+1,gy) || tileIsWater(gx-1,gy) || tileIsWater(gx,gy+1) || tileIsWater(gx,gy-1);
  }

  function dockByYBand(y){
    const {DOCKS}=lakeRects(anchors());
    return DOCKS.find(d => Math.abs(y - d.y) <= 2) || null;
  }
  function parkedSpotForDock(d){
    const mid = d.x0 + Math.max(1, Math.floor(d.len/2));
    return { gx: mid, gy: d.y + 1 }; // one tile “below” the pier
  }

  // Manhattan distance to a rect (0 when inside)
  function distToRect(gx,gy,R){
    const cx = (gx < R.x0) ? R.x0 : (gx > R.x1 ? R.x1 : gx);
    const cy = (gy < R.y0) ? R.y0 : (gy > R.y1 ? R.y1 : gy);
    return Math.abs(gx-cx)+Math.abs(gy-cy);
  }

  // Build nearest sand<->water pair on the island perimeter near (gx,gy)
  function bestIslandEdgePair(gx,gy){
    // If expander exported a full perimeter, use it; else fall back to geometry
    const ISLAND = window.__IZZA_ARMOURY__?.island;
    if (!ISLAND) return null;

    const RAW   = window.__IZZA_ISLAND_DOCK__;
    const toArr = v => Array.isArray(v) ? v : (v && typeof v.x==='number' && typeof v.y==='number' ? [v] : []);
    const DOCK  = RAW ? { water: toArr(RAW.water), sand: toArr(RAW.sand) } : { water:[], sand:[] };

    let best = null;
    const cand = [];

    // from published rings
    DOCK.water.forEach(w=>{
      // find the matching adjacent sand on the island
      const n = [[1,0],[-1,0],[0,1],[0,-1]];
      for(const [dx,dy] of n){
        const sx=w.x+dx, sy=w.y+dy;
        if (sx>=ISLAND.x0 && sx<=ISLAND.x1 && sy>=ISLAND.y0 && sy<=ISLAND.y1){
          cand.push({ water:{x:w.x,y:w.y}, sand:{x:sx,y:sy} });
          break;
        }
      }
    });
    DOCK.sand.forEach(s=>{
      const n = [[1,0],[-1,0],[0,1],[0,-1]];
      for(const [dx,dy] of n){
        const wx=s.x+dx, wy=s.y+dy;
        if (wx<ISLAND.x0 || wx>ISLAND.x1 || wy<ISLAND.y0 || wy>ISLAND.y1){
          cand.push({ water:{x:wx,y:wy}, sand:{x:s.x,y:s.y} });
          break;
        }
      }
    });

    // geometry fallback around the clamped projection
    if (cand.length === 0){
      const cx = Math.min(ISLAND.x1+1, Math.max(ISLAND.x0-1, gx));
      const cy = Math.min(ISLAND.y1+1, Math.max(ISLAND.y0-1, gy));
      cand.push(
        { water:{x:ISLAND.x0-1, y:Math.min(ISLAND.y1, Math.max(ISLAND.y0, cy))},
          sand :{x:ISLAND.x0,   y:Math.min(ISLAND.y1, Math.max(ISLAND.y0, cy))} },
        { water:{x:ISLAND.x1+1, y:Math.min(ISLAND.y1, Math.max(ISLAND.y0, cy))},
          sand :{x:ISLAND.x1,   y:Math.min(ISLAND.y1, Math.max(ISLAND.y0, cy))} },
        { water:{x:Math.min(ISLAND.x1, Math.max(ISLAND.x0, cx)), y:ISLAND.y0-1},
          sand :{x:Math.min(ISLAND.x1, Math.max(ISLAND.x0, cx)), y:ISLAND.y0} },
        { water:{x:Math.min(ISLAND.x1, Math.max(ISLAND.x0, cx)), y:ISLAND.y1+1},
          sand :{x:Math.min(ISLAND.x1, Math.max(ISLAND.x0, cx)), y:ISLAND.y1} }
      );
    }

    for(const p of cand){
      const d = Math.min(
        Math.abs(gx-p.water.x)+Math.abs(gy-p.water.y),
        Math.abs(gx-p.sand.x )+Math.abs(gy-p.sand.y )
      );
      if(!best || d < best.d) best = { ...p, d };
    }
    return best ? { water:best.water, sand:best.sand } : null;
  }

  // ---------- Boarding / Leaving ----------
  function centerOnDock(){
    const gx=centerGX(), gy=centerGY();
    return dockCells().has(gx+'|'+gy);
  }
  function canBoardHere(){
    if(!api?.ready || !isTier2()) return false;
    const gx=centerGX(), gy=centerGY();
    const docks=dockCells();

    // On/adjacent to dock → OK
    if(docks.has(gx+'|'+gy)) return true;
    if(docks.has((gx+1)+'|'+gy) || docks.has((gx-1)+'|'+gy) ||
       docks.has(gx+'|'+(gy+1)) || docks.has(gx+'|'+(gy-1))) return true;

    // On shore land (beach or island edge) → OK
    if(!tileIsWater(gx,gy)){
      const n=[{x:gx+1,y:gy},{x:gx-1,y:gy},{x:gx,y:gy+1},{x:gx,y:gy-1}];
      if(n.some(p=>tileIsWater(p.x,p.y))) return true;
    }
    return false;
  }

  function tryBoard(){
    if(inBoat || !isTier2()) return false;

    // Special: if standing anywhere on island sand, snap to nearest edge water and board there
    const pgx=centerGX(), pgy=centerGY();
    if (onIsland(pgx,pgy)){
      const pair = bestIslandEdgePair(pgx,pgy);
      if (pair){
        api.player.x = (pair.water.x*T()) + 1;
        api.player.y = (pair.water.y*T()) + 1;
        lastWater = { x: api.player.x, y: api.player.y };
        claimedDockId = null;
        inBoat = true;
        setBoatFlag(true);
        ghostBoat = { x: api.player.x, y: api.player.y };
        api.player.speed = 120;
        IZZA.toast?.('Boarded boat');
        return true;
      }
    }

    // Normal: boarding from city dock/shore
    if(!canBoardHere()) return false;

    const d = dockByYBand(centerGY());
    if(d){
      const spot = parkedSpotForDock(d);
      api.player.x = (spot.gx*T()) + 1;
      api.player.y = (spot.gy*T()) + 1;
      lastWater = { x: api.player.x, y: api.player.y };
      claimedDockId = d.y;
    }else{
      claimedDockId = null;
      lastWater = { x: api.player.x, y: api.player.y };
    }

    inBoat = true;
    setBoatFlag(true);
    ghostBoat = { x: api.player.x, y: api.player.y };
    api.player.speed = 120;
    IZZA.toast?.('Boarded boat');
    return true;
  }

  function nearestDisembarkSpot(){
    const gx=centerGX(), gy=centerGY();
    const {LAKE,BEACH_X}=lakeRects(anchors());

    // 1) Snap to beach column if hugging it
    if(gx >= BEACH_X-1 && gx <= BEACH_X+1 && gy >= LAKE.y0-1 && gy <= LAKE.y1+1){
      return { x: BEACH_X, y: Math.max(LAKE.y0, Math.min(gy, LAKE.y1)) };
    }

    // 2) Prefer island edge if close to island
    for(let r=1; r<=4; r++){
      for(let dy=-r; dy<=r; dy++){
        for(let dx=-r; dx<=r; dx++){
          const x=gx+dx, y=gy+dy;
          if (isLand(x,y) && isShore(x,y) && onIsland(x,y)) return {x,y};
        }
      }
    }

    // 3) Otherwise any shoreline tile in expanding ring
    for(let r=1; r<=4; r++){
      for(let dy=-r; dy<=r; dy++){
        for(let dx=-r; dx<=r; dx++){
          const x=gx+dx, y=gy+dy;
          if (isLand(x,y) && isShore(x,y)) return {x,y};
        }
      }
    }
    return null;
  }

  function tryDisembark(){
    if(!inBoat) return false;
    const spot = nearestDisembarkSpot();
    if(!spot) return false;

    const W=90, H=60;
    const gx = Math.max(0, Math.min(W-1, spot.x));
    const gy = Math.max(0, Math.min(H-1, spot.y));

    api.player.x = (gx*T()) + 1;
    api.player.y = (gy*T()) + 1;

    inBoat=false;
    setBoatFlag(false);
    ghostBoat=null;
    api.player.speed = 90;
    claimedDockId=null;
    IZZA.toast?.('Disembarked');
    // reset water strand watchdog
    waterStrandSince = 0;
    rescueShown = false;
    return true;
  }

  // ---------- Input (B) ----------
  function onB(e){
    if(!api?.ready || !isTier2()) return;
    const acted = inBoat ? tryDisembark() : tryBoard();
    if(acted){
      e?.preventDefault?.(); e?.stopPropagation?.(); e?.stopImmediatePropagation?.();
    }
  }

  // ---------- Rescue if stranded in water out of boat ----------
  function showRescue(cb){
    if(rescueShown) return;
    rescueShown = true;
    const m=document.createElement('div');
    m.className='modal'; m.style.display='flex';
    m.innerHTML=`
      <div class="backdrop"></div>
      <div class="card" style="min-width:280px;max-width:520px">
        <h3>💦 Oops!</h3>
        <div style="line-height:1.5">You’ve fallen into the water. Click OK to be brought back to shore.</div>
        <div class="row" style="margin-top:10px"><button class="ghost" id="ok">OK</button></div>
      </div>`;
    document.body.appendChild(m);
    const close=()=> m.remove();
    m.querySelector('.backdrop').addEventListener('click', close, {passive:true});
    m.querySelector('#ok').addEventListener('click', ()=>{ try{ cb?.(); }finally{ close(); } }, {passive:true});
  }
  function nearestShoreTile(){
    const {LAKE,BEACH_X}=lakeRects(anchors());
    const gx=centerGX(), gy=centerGY();

    // Prefer nearest island sand in small radius
    const isl = islandSet();
    if (isl.size){
      for(let r=0; r<=3; r++){
        for(let dx=-r; dx<=r; dx++){
          const x1=gx+dx, y1=gy-r, y2=gy+r;
          if (isl.has(x1+'|'+y1)) return {x:x1,y:y1};
          if (isl.has(x1+'|'+y2)) return {x:x1,y:y2};
        }
        for(let dy=-r; dy<=r; dy++){
          const y1=gy+dy, x1=gx-r, x2=gx+r;
          if (isl.has(x1+'|'+y1)) return {x:x1,y:y1};
          if (isl.has(x2+'|'+y1)) return {x:x2,y:y1};
        }
      }
    }

    // Otherwise city beach
    const y = Math.max(LAKE.y0, Math.min(gy, LAKE.y1));
    return { x: BEACH_X, y };
  }
  function rescueToShore(){
    const s = nearestShoreTile();
    api.player.x = (s.x*T()) + 1;
    api.player.y = (s.y*T()) + 1;
    lastLand = { x: api.player.x, y: api.player.y };
    lastWater = null;
    IZZA.toast?.('Back on shore');
  }

  // ---------- Movement clamps ----------
  function cornersGrid(){
    const t=T(), p=api.player;
    return [
      {x:((p.x+1)/t)|0,  y:((p.y+1)/t)|0},
      {x:((p.x+31)/t)|0, y:((p.y+1)/t)|0},
      {x:((p.x+1)/t)|0,  y:((p.y+31)/t)|0},
      {x:((p.x+31)/t)|0, y:((p.y+31)/t)|0}
    ];
  }
  const allCornersWater = ()=> cornersGrid().every(c=> tileIsWater(c.x,c.y));
  const anyCornerWater  = ()=> cornersGrid().some(c => tileIsWater(c.x,c.y));

  IZZA.on('update-pre', ()=>{
    if(!api?.ready || !isTier2()) return;
    const p=api.player;

    if(inBoat){
      if(allCornersWater()){ lastWater={x:p.x,y:p.y}; }
      else if(lastWater){ p.x=lastWater.x; p.y=lastWater.y; }
      if(ghostBoat){ ghostBoat.x=p.x; ghostBoat.y=p.y; }
      waterStrandSince = 0; // boating → no rescue timer
    }else{
      // Land walking: block water
      if(anyCornerWater() && !centerOnDock()){
        if(lastLand){ p.x=lastLand.x; p.y=lastLand.y; }
        if(!lastLand && allCornersWater()){
          if(!waterStrandSince) waterStrandSince = performance.now();
        }else{
          waterStrandSince = 0;
        }
      }else{
        lastLand={x:p.x,y:p.y};
        waterStrandSince = 0;
      }

      // If in water out of boat for >300ms, offer rescue
      if(allCornersWater()){
        if(!waterStrandSince) waterStrandSince = performance.now();
        const dt = performance.now() - waterStrandSince;
        if(dt > 300 && !rescueShown){
          showRescue(rescueToShore);
        }
      }
    }
  });

  // Extra safety clamp
  IZZA.on('update-post', ()=>{
    if(!api?.ready || !isTier2()) return;
    const p=api.player;
    if(inBoat){
      if(allCornersWater()){ lastWater={x:p.x,y:p.y}; }
      else if(lastWater){ p.x=lastWater.x; p.y=lastWater.y; }
      if(ghostBoat){ ghostBoat.x=p.x; ghostBoat.y=p.y; }
    }else{
      if(anyCornerWater() && !centerOnDock()){
        if(lastLand){ p.x=lastLand.x; p.y=lastLand.y; }
      }else{
        lastLand={x:p.x,y:p.y};
      }
    }
  });

  // Boot-time rescue if spawn is bad
  setTimeout(()=>{
    try{
      if(!api?.ready || !isTier2()) return;
      const gx=centerGX(), gy=centerGY();
      const W=90, H=60;
      const oob = (gx<0 || gx>=W || gy<0 || gy>=H);
      const onWaterNoBoat = tileIsWater(gx,gy) && !inBoat;
      if(oob || onWaterNoBoat){
        showRescue(rescueToShore);
      }
    }catch{}
  }, 0);

  // ---------- Visuals (boat sprite + tiny wake) ----------
  let lastWakeAt = 0;

  function makeHullPath(){
    const p=new Path2D();
    p.moveTo(6,38);  p.quadraticCurveTo(22,16,50,10);
    p.quadraticCurveTo(78,16,94,38); p.quadraticCurveTo(78,60,50,66);
    p.quadraticCurveTo(22,60,6,38);  p.closePath();
    return p;
  }
  function makeDeckInset(){
    const p=new Path2D();
    p.moveTo(16,38); p.quadraticCurveTo(30,22,50,18);
    p.quadraticCurveTo(70,22,84,38); p.quadraticCurveTo(70,55,50,58);
    p.quadraticCurveTo(30,55,16,38); p.closePath();
    return p;
  }
  function makeWindshield(){
    const p=new Path2D();
    p.moveTo(32,28); p.quadraticCurveTo(50,20,68,28); p.lineTo(66,32);
    p.quadraticCurveTo(50,26,34,32); p.closePath();
    return p;
  }

  const hullPath = makeHullPath();
  const deckPath = makeDeckInset();
  const windPath = makeWindshield();

  function drawBoat(){
    if(!api?.ready || !isTier2()) return;
    if(!inBoat) return;

    const ctx = document.getElementById('game')?.getContext('2d');
    if(!ctx) return;

    const S = api.DRAW;
    const t = api.TILE;

    // Boat screen position (player center-aligned)
    const sx = (api.player.x - api.camera.x) * (S/t);
    const sy = (api.player.y - api.camera.y) * (S/t);

    ctx.save();
    ctx.translate(sx + S*0.5, sy + S*0.5);
    ctx.scale(S/64, S/64); // normalize to ~64px width
    ctx.translate(-50, -38); // center around our 100x76-ish vector

    // subtle wake
    const now = performance.now?.() || Date.now();
    if (ghostBoat && now - lastWakeAt > 90){
      lastWakeAt = now;
      ctx.save();
      ctx.globalAlpha = 0.25;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.ellipse(50, 60, 20, 6, 0, 0, Math.PI*2);
      ctx.fill();
      ctx.restore();
    }

    // hull
    ctx.fillStyle = '#3c4c6e';
    ctx.strokeStyle = '#1f2b45';
    ctx.lineWidth = 2.2;
    ctx.fill(hullPath);
    ctx.stroke(hullPath);

    // deck
    ctx.fillStyle = '#d9d2c3';
    ctx.fill(deckPath);
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 1.4;
    ctx.stroke(deckPath);

    // windshield
    ctx.fillStyle = 'rgba(210,235,255,0.7)';
    ctx.fill(windPath);
    ctx.strokeStyle = 'rgba(80,110,150,0.6)';
    ctx.lineWidth = 1.2;
    ctx.stroke(windPath);

    ctx.restore();
  }

  // ---------- Boot ----------
  IZZA.on?.('ready', (a)=>{
    api=a;

    // Input (capture so we can preempt default when we actually act)
    document.getElementById('btnB')?.addEventListener('click', onB, true);
    window.addEventListener('keydown', e=>{ if((e.key||'').toLowerCase()==='b') onB(e); }, true);

    // Visible boat sprite
    IZZA.on?.('render-over', drawBoat);
  });
})();
