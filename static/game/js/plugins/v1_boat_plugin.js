// v1_boat_plugin.js
// Boat controls for Tier-2: docks + beach + island perimeter
// - City docks + beach boarding
// - Island sand treated as land (relies on window._izzaIslandLand)
// - Uses safety_island_and_rescue.js border/rescue if present
// - Optional island snapping via window._izzaNearestDockPair when near island
(function(){
  const BUILD='v1.20-boat-core';
  console.log('[IZZA PLAY]', BUILD);

  const TIER_KEY='izzaMapTier';
  const isTier2 = ()=> (localStorage.getItem(TIER_KEY)==='2');

  // Public “are we in a boat?” flag used across files
  function setBoatFlag(on){ window._izzaBoatActive = !!on; }

  // local state
  let api=null;
  let inBoat=false;
  let ghostBoat=null;
  let lastLand=null, lastWater=null;
  let waterStrandSince = 0;   // ms when player slipped into water out of boat
  let rescueShown = false;

  // ===== geometry (match expander) =====
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
    // Must match your Map Expander’s lake
    const LAKE = { x0: a.un.x1-14, y0: a.un.y0+23, x1: a.un.x1, y1: a.un.y1 };
    const BEACH_X = LAKE.x0 - 1; // vertical city beach column
    // Docks: expander draws (x0=LAKE.x0, len 4/5 with off-by-one beach reach)
    // Keep a conservative walkable band including the plank row and one row above for snap.
    const DOCKS = [
      { x0: LAKE.x0, y: LAKE.y0+4,  len: 4 },
      { x0: LAKE.x0, y: LAKE.y0+12, len: 5 }
    ];
    return {LAKE, BEACH_X, DOCKS};
  }

  // short-hands
  const T = ()=> api.TILE;
  const centerGX = ()=> ((api.player.x+16)/T()|0);
  const centerGY = ()=> ((api.player.y+16)/T()|0);

  // City dock cells considered “boardable”
  function dockCells(){
    if(!api?.ready) return new Set();
    const {DOCKS}=lakeRects(anchors());
    const s=new Set();
    DOCKS.forEach(d=>{
      for(let i=0;i<d.len;i++){
        const gx = d.x0+i;
        // plank row + 1 tile above (visual tolerance)
        s.add(gx+'|'+(d.y));
        s.add(gx+'|'+(d.y-1));
      }
    });
    return s;
  }

  // Treat LAKE interior (minus docks and any published island land) as water
  function tileIsWater(gx,gy){
    const {LAKE}=lakeRects(anchors());
    const insideLake = (gx>=LAKE.x0 && gx<=LAKE.x1 && gy>=LAKE.y0 && gy<=LAKE.y1);
    if(!insideLake) return false;

    // island sand is NOT water (published by expander/mission/safety)
    if (window._izzaIslandLand && window._izzaIslandLand.has(gx+'|'+gy)) return false;

    // city docks are land-ish for movement
    if (dockCells().has(gx+'|'+gy)) return false;

    return true;
  }
  const isLand = (gx,gy)=> !tileIsWater(gx,gy);

  // helpers
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
  const anyCornerWater  = ()=> cornersGrid().some (c=> tileIsWater(c.x,c.y));

  const onDockCenter = ()=>{
    const gx=centerGX(), gy=centerGY();
    return dockCells().has(gx+'|'+gy);
  };

  // city dock helpers
  function parkedSpotForDock(d){
    const mid = d.x0 + Math.max(1, Math.floor(d.len/2));
    return { gx: mid, gy: d.y + 1 };
  }
  function dockByYBand(y){
    const {DOCKS}=lakeRects(anchors());
    // “near this Y” band — forgiving for mobile
    return DOCKS.find(d => Math.abs(y - d.y) <= 2) || null;
  }

  // shore check
  function isShore(gx,gy){
    if(!isLand(gx,gy)) return false;
    return tileIsWater(gx+1,gy) || tileIsWater(gx-1,gy) || tileIsWater(gx,gy+1) || tileIsWater(gx,gy-1);
  }

  // ===== Boarding rules =====
  function canBoardHere(){
    if(!api?.ready || !isTier2()) return false;
    const gx=centerGX(), gy=centerGY();
    const docks=dockCells();

    // On a dock or adjacent → OK
    if(docks.has(gx+'|'+gy)) return true;
    if(docks.has((gx+1)+'|'+gy) || docks.has((gx-1)+'|'+gy) ||
       docks.has(gx+'|'+(gy+1)) || docks.has(gx+'|'+(gy-1))) return true;

    // Or on any land tile that touches water (beach column or island sand edge)
    if(!tileIsWater(gx,gy)){
      const n=[{x:gx+1,y:gy},{x:gx-1,y:gy},{x:gx,y:gy+1},{x:gx,y:gy-1}];
      if(n.some(p=>tileIsWater(p.x,p.y))) return true;
    }
    return false;
  }

  function tryBoard(){
    if(inBoat || !isTier2() || !canBoardHere()) return false;

    // Snap to a docked “park” position if by a dock (nicer look)
    const d = dockByYBand(centerGY());
    if(d){
      const spot = parkedSpotForDock(d);
      api.player.x = (spot.gx*T()) + 1;
      api.player.y = (spot.gy*T()) + 1;
      lastWater = { x: api.player.x, y: api.player.y };
    }else{
      lastWater = { x: api.player.x, y: api.player.y };
    }

    inBoat = true;
    setBoatFlag(true);
    ghostBoat = { x: api.player.x, y: api.player.y };
    api.player.speed = 120;
    IZZA.toast?.('Boarded boat');
    return true;
  }

  // When disembarking near island, prefer island sand (uses safety helper if present)
  function nearestDisembarkSpot(){
    const gx=centerGX(), gy=centerGY();

    // 1) If safety helper exported a precise island pair and we’re close → use it
    if (typeof window._izzaNearestDockPair === 'function'){
      const pair = window._izzaNearestDockPair(gx,gy);
      if (pair){
        return { x: pair.sand.x, y: pair.sand.y, preferIsland: true };
      }
    }

    // 2) Otherwise do a small ring search. Prefer shore tiles first.
    const cand=[];
    for(let r=1; r<=3; r++){
      for(let dx=-r; dx<=r; dx++){
        cand.push({x:gx+dx, y:gy-r});
        cand.push({x:gx+dx, y:gy+r});
      }
      for(let dy=-(r-1); dy<=(r-1); dy++){
        cand.push({x:gx-r, y:gy+dy});
        cand.push({x:gx+r, y:gy+dy});
      }
    }

    const W=90, H=60;
    const inB = p=> p.x>=0 && p.x<W && p.y>=0 && p.y<H;

    // Prefer island sand if available
    const islandSet = (window._izzaIslandLand instanceof Set) ? window._izzaIslandLand : null;
    if (islandSet){
      const onIslandShore = cand.find(p=> inB(p) && islandSet.has(p.x+'|'+p.y) && isShore(p.x,p.y));
      if (onIslandShore) return { x:onIslandShore.x, y:onIslandShore.y, preferIsland:true };
      const onIslandAny = cand.find(p=> inB(p) && islandSet.has(p.x+'|'+p.y));
      if (onIslandAny) return { x:onIslandAny.x, y:onIslandAny.y, preferIsland:true };
    }

    // City shore
    const shore = cand.find(p=> inB(p) && isLand(p.x,p.y) && isShore(p.x,p.y));
    if (shore) return { x:shore.x, y:shore.y, preferIsland:false };

    // Any land
    const any = cand.find(p=> inB(p) && isLand(p.x,p.y));
    return any ? { x:any.x, y:any.y, preferIsland:false } : null;
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
    IZZA.toast?.('Disembarked');
    // reset water strand watchdog
    waterStrandSince = 0;
    rescueShown = false;
    return true;
  }

  // ===== Input (B) =====
  function onB(e){
    if(!api?.ready || !isTier2()) return;
    const shouldHandle = inBoat || canBoardHere();
    if(!shouldHandle) return; // pressing B in open water does nothing

    const acted = inBoat ? tryDisembark() : tryBoard();
    if(acted){
      e?.preventDefault?.(); e?.stopPropagation?.(); e?.stopImmediatePropagation?.();
    }
  }

  // ===== Rescue (UI-free option — use safety file modal if present) =====
  function nearestShoreTile(){
    const {LAKE,BEACH_X}=lakeRects(anchors());
    const gx=centerGX(), gy=centerGY();

    // Prefer nearest island land if published
    const islandSet = (window._izzaIslandLand instanceof Set) ? window._izzaIslandLand : null;
    if (islandSet){
      for (let r=0; r<=3; r++){
        for (let dx=-r; dx<=r; dx++){
          const x1=gx+dx, y1=gy-r, y2=gy+r;
          if (islandSet.has(x1+'|'+y1)) return {x:x1,y:y1};
          if (islandSet.has(x1+'|'+y2)) return {x:x1,y:y2};
        }
        for (let dy=-r; dy<=r; dy++){
          const y1=gy+dy, x1=gx-r, x2=gx+r;
          if (islandSet.has(x1+'|'+y1)) return {x:x1,y:y1};
          if (islandSet.has(x2+'|'+y1)) return {x:x2,y:y1};
        }
      }
    }

    // Otherwise city beach
    const y = Math.max(LAKE.y0, Math.min(gy, LAKE.y1));
    return { x: BEACH_X, y };
  }

  function doRescue(){
    const s = nearestShoreTile();
    api.player.x = (s.x*T()) + 1;
    api.player.y = (s.y*T()) + 1;
    lastLand = { x: api.player.x, y: api.player.y };
    lastWater = null;
    IZZA.toast?.('Back on shore');
  }

  // ===== Movement clamps =====
  IZZA.on('update-pre', ()=>{
    if(!api?.ready || !isTier2()) return;
    const p=api.player;

    if(inBoat){
      // boat must stay on water
      if(allCornersWater()){ lastWater={x:p.x,y:p.y}; }
      else if(lastWater){ p.x=lastWater.x; p.y=lastWater.y; }
      if(ghostBoat){ ghostBoat.x=p.x; ghostBoat.y=p.y; }
      waterStrandSince = 0;
    }else{
      // on foot: block water
      if(anyCornerWater() && !onDockCenter()){
        if(lastLand){ p.x=lastLand.x; p.y=lastLand.y; }
        if(!lastLand && allCornersWater()){ // edge case: spawned in water
          if(!waterStrandSince) waterStrandSince = performance.now();
        }else{
          waterStrandSince = 0;
        }
      }else{
        lastLand={x:p.x,y:p.y};
        waterStrandSince = 0;
      }

      // Offer silent rescue after 300ms in water out of boat (UI handled elsewhere if desired)
      if(allCornersWater()){
        if(!waterStrandSince) waterStrandSince = performance.now();
        const dt = performance.now() - waterStrandSince;
        if(dt > 300 && !rescueShown){
          rescueShown = true;
          doRescue();
          setTimeout(()=>{ rescueShown=false; }, 600);
        }
      }
    }
  });

  // extra safety after physics
  function postClamp(){
    if(!api?.ready || !isTier2()) return;
    const p=api.player;
    if(inBoat){
      if(allCornersWater()){ lastWater={x:p.x,y:p.y}; }
      else if(lastWater){ p.x=lastWater.x; p.y=lastWater.y; }
      if(ghostBoat){ ghostBoat.x=p.x; ghostBoat.y=p.y; }
    }else{
      if(anyCornerWater() && !onDockCenter()){
        if(lastLand){ p.x=lastLand.x; p.y=lastLand.y; }
      }else{
        lastLand={x:p.x,y:p.y};
      }
    }
  }
  setTimeout(()=> IZZA.on('update-post', postClamp), 0);

  // Boot-time rescue if we spawn on water out of boat
  setTimeout(()=>{
    try{
      if(!api?.ready || !isTier2()) return;
      const gx=centerGX(), gy=centerGY();
      const W=90, H=60;
      const oob = (gx<0 || gx>=W || gy<0 || gy>=H);
      const onWaterNoBoat = tileIsWater(gx,gy) && !inBoat;
      if(oob || onWaterNoBoat) doRescue();
    }catch{}
  }, 0);

  // ===== Boot =====
  IZZA.on('ready', (a)=>{
    api=a;
    // Sync with any previous state
    if (window._izzaBoatActive){ inBoat=true; }

    // B to board/disembark (capture so we can preempt others only when relevant)
    const btnB=document.getElementById('btnB');
    btnB?.addEventListener('click', onB, true);
    window.addEventListener('keydown', e=>{
      if((e.key||'').toLowerCase()==='b') onB(e);
    }, true);

    console.log('[boat] ready', BUILD);
  });
})();
