// /static/game/js/plugins/v1_boat_plugin.js
// v1.4 — dock-walking fix, alongside-docked boats, board-from-dock, clean snap-to-dock/beach
(function(){
  const BUILD='v1.4-boat-plugin+dock-fix+side-dock+board-from-dock';
  console.log('[IZZA PLAY]', BUILD);

  const TIER_KEY='izzaMapTier';            // '1' | '2'
  const isTier2 = ()=> localStorage.getItem(TIER_KEY)==='2';

  // --- local state ---
  let api=null;
  let inBoat=false;
  let ghostBoat=null;         // tiny visual rectangle that follows player
  let lastLand=null, lastWater=null;

  // ====== geometry (mirrors the expansion) ======
  function unlockedRect(t){ return (t!=='2') ? {x0:18,y0:18,x1:72,y1:42} : {x0:10,y0:12,x1:80,y1:50}; }
  function anchors(a){
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
    const LAKE = { x0: a.un.x1-14, y0: a.un.y0+23, x1: a.un.x1, y1: a.un.y1 };
    const BEACH_X = LAKE.x0 - 1;
    const DOCKS = [
      { x0: LAKE.x0, y: LAKE.y0+4,  len: 3 },  // horizontal planks extending rightwards
      { x0: LAKE.x0, y: LAKE.y0+12, len: 4 }
    ];
    return {LAKE, BEACH_X, DOCKS};
  }

  // ====== helpers ======
  function playerGrid(){
    const t=api.TILE;
    return { gx: ((api.player.x+16)/t|0), gy: ((api.player.y+16)/t|0) };
  }
  function dockCells(){
    if(!api?.ready) return new Set();
    const A = anchors(api), {DOCKS}=lakeRects(A);
    const set=new Set();
    DOCKS.forEach(d=>{ for(let i=0;i<d.len;i++) set.add((d.x0+i)+'|'+d.y); });
    return set;
  }
  // Parked boat water cells (alongside each plank, not at the tip)
  function parkedBoatCells(){
    const res=[];
    if(!api?.ready) return res;
    const {LAKE,DOCKS}=lakeRects(anchors(api));
    DOCKS.forEach(d=>{
      const mid = d.x0 + Math.floor(d.len/2);   // middle of the plank
      // Prefer SOUTH side (gy+1). If out of lake bounds, use NORTH (gy-1).
      const south = {x: mid, y: d.y+1};
      const north = {x: mid, y: d.y-1};
      const inLake = (p)=> p.x>=LAKE.x0 && p.x<=LAKE.x1 && p.y>=LAKE.y0 && p.y<=LAKE.y1;
      const spot = inLake(south) ? south : (inLake(north) ? north : null);
      if(spot) res.push(spot);
    });
    return res;
  }
  function boatCellSet(){
    const s=new Set();
    parkedBoatCells().forEach(p=> s.add(p.x+'|'+p.y));
    return s;
  }
  function tileIsWater(gx,gy){
    if(!api?.ready) return false;
    const {LAKE}=lakeRects(anchors(api));
    const inLake = (gx>=LAKE.x0 && gx<=LAKE.x1 && gy>=LAKE.y0 && gy<=LAKE.y1);
    if(!inLake) return false;
    // planks are NOT water (walkable)
    if(dockCells().has(gx+'|'+gy)) return false;
    return true;
  }

  // ====== boarding / leaving rules ======
  function canBoardHereFromDock(){
    if(!isTier2() || !api?.ready) return false;
    const {gx,gy}=playerGrid();
    const docks=dockCells();
    if(!docks.has(gx+'|'+gy)) return false; // must be standing on a dock plank
    // must be adjacent to a parked boat water cell
    const boats = boatCellSet();
    return boats.has((gx+1)+'|'+gy) || boats.has((gx-1)+'|'+gy) ||
           boats.has(gx+'|'+(gy+1)) || boats.has(gx+'|'+(gy-1));
  }
  function tryBoard(){
    if(inBoat || !isTier2()) return false;
    if(!canBoardHereFromDock()) return false;

    // Move player into the adjacent boat water cell and start boating
    const {gx,gy}=playerGrid();
    const boats = boatCellSet();
    const candidates = [
      {x:gx+1,y:gy},{x:gx-1,y:gy},{x:gx,y:gy+1},{x:gx,y:gy-1}
    ];
    const target = candidates.find(p=> boats.has(p.x+'|'+p.y));
    if(!target) return false;

    const t=api.TILE;
    api.player.x = target.x * t + 1;
    api.player.y = target.y * t + 1;

    inBoat = true;
    ghostBoat = { x: api.player.x, y: api.player.y };
    lastWater = { x: api.player.x, y: api.player.y };
    api.player.speed = 120; // boating speed
    toast('Boarded boat');
    return true;
  }

  // Find nearest *dock or beach* spot to snap onto when disembarking.
  function nearestDisembarkSpot(){
    const A = anchors(api), {LAKE,BEACH_X}=lakeRects(A);
    const {gx,gy}=playerGrid();
    const docks = dockCells();

    // Search radius 2 (8-neighborhood plus ring) for dock tiles
    const ring = [];
    for(let r=1; r<=2; r++){
      ring.push({x:gx+r,y:gy},{x:gx-r,y:gy},{x:gx,y:gy+r},{x:gx,y:gy-r});
      ring.push({x:gx+r,y:gy+r},{x:gx-r,y:gy+r},{x:gx+r,y:gy-r},{x:gx-r,y:gy-r});
    }
    let best=null, bestD=1e9;
    for(const n of ring){
      if(docks.has(n.x+'|'+n.y)){
        const d = Math.abs(n.x-gx)+Math.abs(n.y-gy);
        if(d<bestD){ best=n; bestD=d; }
      }
    }
    if(best) return best;

    // Otherwise beach: snap horizontally onto the beach column aligned with current y
    if(gy>=LAKE.y0 && gy<=LAKE.y1) return {x:BEACH_X, y:gy};

    return null;
  }
  function tryDisembark(){
    if(!inBoat) return false;
    const spot = nearestDisembarkSpot();
    if(!spot) return false;

    const t = api.TILE;
    api.player.x = (spot.x * t) + 1;   // bias inside tile
    api.player.y = (spot.y * t) + 1;

    inBoat=false; ghostBoat=null;
    api.player.speed = 90; // default walk speed
    toast('Disembarked');
    return true;
  }

  // ====== input (B) ======
  function onB(e){
    if(!api?.ready || !isTier2()) return;

    // Boarding only from dock next to a parked boat; leaving only near dock/beach
    const acted = inBoat ? tryDisembark() : tryBoard();
    if(acted){
      if(e){ e.preventDefault?.(); e.stopPropagation?.(); e.stopImmediatePropagation?.(); }
    }
  }

  // ====== update hooks ======
  IZZA.on('update-pre', ()=>{
    if(!api?.ready || !isTier2()) return;

    // water / land clamping that doesn't touch core collision:
    const t=api.TILE, p=api.player;
    const corners = [
      {x:((p.x+1)/t)|0,  y:((p.y+1)/t)|0},
      {x:((p.x+31)/t)|0, y:((p.y+1)/t)|0},
      {x:((p.x+1)/t)|0,  y:((p.y+31)/t)|0},
      {x:((p.x+31)/t)|0, y:((p.y+31)/t)|0}
    ];
    const onWater = corners.every(c=> tileIsWater(c.x,c.y));

    // --- Dock smoothing: treat dock tiles as land so walking never jitters
    const centerGX = ((p.x+16)/t)|0, centerGY = ((p.y+16)/t)|0;
    const onDock = dockCells().has(centerGX+'|'+centerGY);

    if(inBoat){
      if(onWater){ lastWater = {x:p.x,y:p.y}; }
      else if(lastWater){ p.x=lastWater.x; p.y=lastWater.y; } // keep boat on water only
    }else{
      if(!onWater || onDock){ // onDock counts as safe land
        lastLand = {x:p.x,y:p.y};
      }else if(lastLand){
        p.x=lastLand.x; p.y=lastLand.y;   // keep walking off the lake
      }
    }

    // keep ghost sprite aligned
    if(inBoat && ghostBoat){
      ghostBoat.x = p.x;
      ghostBoat.y = p.y;
    }
  });

  // ====== visuals: parked boats alongside + player boat ======
  function drawParkedDockBoats(ctx){
    const S=api.DRAW, t=api.TILE;
    const boats = parkedBoatCells();
    if(!boats.length) return;

    ctx.save();
    ctx.fillStyle='#7ca7c7';
    boats.forEach(b=>{
      const sx = (b.x*t - api.camera.x) * (S/t);
      const sy = (b.y*t - api.camera.y) * (S/t);
      // small neutral hull
      ctx.fillRect(sx+S*0.18, sy+S*0.34, S*0.64, S*0.32);
    });
    ctx.restore();
  }

  IZZA.on('render-post', ()=>{
    if(!api?.ready || !isTier2()) return;
    const ctx=document.getElementById('game').getContext('2d');

    // always show parked boats alongside the docks
    drawParkedDockBoats(ctx);

    // show the player's boat while riding
    if(inBoat && ghostBoat){
      const S=api.DRAW, t=api.TILE;
      const sx = (ghostBoat.x - api.camera.x) * (S/t);
      const sy = (ghostBoat.y - api.camera.y) * (S/t);
      ctx.fillStyle='#7ca7c7';
      ctx.fillRect(sx+S*0.18, sy+S*0.34, S*0.64, S*0.32);
    }
  });

  // ====== boot ======
  function toast(msg, seconds=2.2){
    let h = document.getElementById('tutHint');
    if(!h){
      h = document.createElement('div');
      h.id='tutHint';
      Object.assign(h.style,{
        position:'fixed', left:'12px', top:'64px', zIndex:12,
        background:'rgba(10,12,18,.88)', border:'1px solid #394769',
        color:'#cfe0ff', padding:'8px 10px', borderRadius:'10px', fontSize:'14px'
      });
      document.body.appendChild(h);
    }
    h.textContent=msg; h.style.display='block';
    clearTimeout(h._t); h._t=setTimeout(()=>{ h.style.display='none'; }, seconds*1000);
  }

  IZZA.on('ready', (a)=>{
    api=a;
    const btnB=document.getElementById('btnB');
    if(btnB) btnB.addEventListener('click', onB, true);  // capture; we suppress only when we act
    window.addEventListener('keydown', e=>{
      if((e.key||'').toLowerCase()==='b') onB(e);
    }, {passive:false, capture:true});
    console.log('[boat] ready', BUILD);
  });
})();
