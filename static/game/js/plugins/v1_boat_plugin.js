// /static/game/js/plugins/v1_boat_plugin.js
// v1.5 — full-water traversal (post-collision clamp) + hide taken dock boat
(function(){
  const BUILD='v1.5-boat-plugin+post-clamp+hide-docked';
  console.log('[IZZA PLAY]', BUILD);

  const TIER_KEY='izzaMapTier';                  // '1' | '2'
  const isTier2 = ()=> localStorage.getItem(TIER_KEY)==='2';

  // --- local state ---
  let api=null;
  let inBoat=false;
  let ghostBoat=null;         // simple visual that follows player
  let lastLand=null, lastWater=null;
  let takenBoat=null;         // {x,y} water cell of the dock boat we took (hidden while riding)

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
  // parked boats are alongside each plank (prefer south side when in lake)
  function parkedBoatCells(){
    const res=[];
    if(!api?.ready) return res;
    const {LAKE,DOCKS}=lakeRects(anchors(api));
    const inLake = p => p.x>=LAKE.x0 && p.x<=LAKE.x1 && p.y>=LAKE.y0 && p.y<=LAKE.y1;
    DOCKS.forEach(d=>{
      const mid = d.x0 + Math.floor(d.len/2);
      const south = {x: mid, y: d.y+1};
      const north = {x: mid, y: d.y-1};
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

  // ====== boarding / leaving ======
  function canBoardHereFromDock(){
    if(!isTier2() || !api?.ready) return false;
    const {gx,gy}=playerGrid();
    const docks=dockCells();
    if(!docks.has(gx+'|'+gy)) return false; // must stand on a plank
    const boats = boatCellSet();
    return boats.has((gx+1)+'|'+gy) || boats.has((gx-1)+'|'+gy) ||
           boats.has(gx+'|'+(gy+1)) || boats.has(gx+'|'+(gy-1));
  }

  function tryBoard(){
    if(inBoat || !isTier2()) return false;
    if(!canBoardHereFromDock()) return false;

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
    takenBoat = { x: target.x, y: target.y };     // hide this parked boat while riding
    api.player.speed = 120; // boating speed
    toast('Boarded boat');
    return true;
  }

  // nearest snap spot on land for disembark (dock wins; else beach)
  function nearestDisembarkSpot(){
    const A = anchors(api), {LAKE,BEACH_X}=lakeRects(A);
    const {gx,gy}=playerGrid();
    const docks = dockCells();

    // search radius 2 for dock planks
    let best=null, bestD=1e9;
    for(let dx=-2; dx<=2; dx++){
      for(let dy=-2; dy<=2; dy++){
        if(dx===0 && dy===0) continue;
        const nx=gx+dx, ny=gy+dy;
        if(docks.has(nx+'|'+ny)){
          const d = Math.abs(dx)+Math.abs(dy);
          if(d<bestD){ best={x:nx,y:ny}; bestD=d; }
        }
      }
    }
    if(best) return best;

    // else beach column aligned with current y
    if(gy>=LAKE.y0 && gy<=LAKE.y1) return {x:BEACH_X, y:gy};
    return null;
  }

  function tryDisembark(){
    if(!inBoat) return false;
    const spot = nearestDisembarkSpot();
    if(!spot) return false;

    const t = api.TILE;
    // snap player onto land
    api.player.x = (spot.x * t) + 1;
    api.player.y = (spot.y * t) + 1;

    // re-place the boat right beside where we got off:
    if(takenBoat){
      const {LAKE,BEACH_X}=lakeRects(anchors(api));
      const inLake = p => p.x>=LAKE.x0 && p.x<=LAKE.x1 && p.y>=LAKE.y0 && p.y<=LAKE.y1;

      let park=null;
      // if on a dock, put boat in the adjacent water cell closest to previous boat cell
      const neighbors=[{x:spot.x+1,y:spot.y},{x:spot.x-1,y:spot.y},{x:spot.x,y:spot.y+1},{x:spot.x,y:spot.y-1}];
      park = neighbors
        .filter(p=> inLake(p) && tileIsWater(p.x,p.y))
        .sort((a,b)=> (Math.abs(a.x-takenBoat.x)+Math.abs(a.y-takenBoat.y)) - (Math.abs(b.x-takenBoat.x)+Math.abs(b.y-takenBoat.y)))[0] || null;

      // if we got off at the beach, default to the water tile just to the right of the beach column
      if(!park && spot.x===BEACH_X){
        const candidate={x:BEACH_X+1, y:spot.y};
        if(inLake(candidate)) park=candidate;
      }

      // update the parked boat location
      if(park) takenBoat = {x:park.x, y:park.y};
    }

    inBoat=false; ghostBoat=null;
    api.player.speed = 90; // default walk speed
    toast('Disembarked');
    return true;
  }

  // ====== input (B) ======
  function onB(e){
    if(!api?.ready || !isTier2()) return;
    const acted = inBoat ? tryDisembark() : tryBoard();
    if(acted){
      e?.preventDefault?.(); e?.stopPropagation?.(); e?.stopImmediatePropagation?.();
    }
  }

  // ====== movement / collision integration ======
  // NOTE: The map layout makes the lake solid in its own update-post. To guarantee
  // boat travel, we *also* enforce our clamp in update-post (after layout).
  IZZA.on('update-pre', ()=>{
    if(!api?.ready || !isTier2()) return;

    const t=api.TILE, p=api.player;
    const centerGX=((p.x+16)/t)|0, centerGY=((p.y+16)/t)|0;
    const onDock = dockCells().has(centerGX+'|'+centerGY);

    // record last known safe land/water (no forcing here)
    const corners = [
      {x:((p.x+1)/t)|0,  y:((p.y+1)/t)|0},
      {x:((p.x+31)/t)|0, y:((p.y+1)/t)|0},
      {x:((p.x+1)/t)|0,  y:((p.y+31)/t)|0},
      {x:((p.x+31)/t)|0, y:((p.y+31)/t)|0}
    ];
    const onWater = corners.every(c=> tileIsWater(c.x,c.y));

    if(inBoat){
      if(onWater) lastWater = {x:p.x,y:p.y};
    }else{
      if(onDock || !onWater) lastLand = {x:p.x,y:p.y};
    }
  });

  IZZA.on('update-post', ()=>{
    if(!api?.ready || !isTier2()) return;

    const t=api.TILE, p=api.player;
    // authoritative check AFTER layout collisions have run
    const corners = [
      {x:((p.x+1)/t)|0,  y:((p.y+1)/t)|0},
      {x:((p.x+31)/t)|0, y:((p.y+1)/t)|0},
      {x:((p.x+1)/t)|0,  y:((p.y+31)/t)|0},
      {x:((p.x+31)/t)|0, y:((p.y+31)/t)|0}
    ];
    const onWater = corners.every(c=> tileIsWater(c.x,c.y));

    if(inBoat){
      // if a prior collision pushed us off water, snap back to last water pos
      if(!onWater && lastWater){
        p.x=lastWater.x; p.y=lastWater.y;
      }else if(onWater){
        lastWater = {x:p.x,y:p.y};
      }
    }else{
      // keep walkers off the lake (but let them stand on docks)
      const centerGX=((p.x+16)/t)|0, centerGY=((p.y+16)/t)|0;
      const onDock = dockCells().has(centerGX+'|'+centerGY);
      if(onWater && !onDock && lastLand){
        p.x=lastLand.x; p.y=lastLand.y;
      }
    }

    // keep ghost sprite aligned
    if(inBoat && ghostBoat){
      ghostBoat.x = p.x;
      ghostBoat.y = p.y;
    }
  });

  // ====== visuals ======
  function drawParkedDockBoats(ctx){
    const S=api.DRAW, t=api.TILE;
    const boats = parkedBoatCells();
    if(!boats.length) return;

    ctx.save();
    ctx.fillStyle='#7ca7c7';
    boats.forEach(b=>{
      // hide the boat we are currently using (only while riding)
      if(inBoat && takenBoat && b.x===takenBoat.x && b.y===takenBoat.y) return;
      const sx = (b.x*t - api.camera.x) * (S/t);
      const sy = (b.y*t - api.camera.y) * (S/t);
      ctx.fillRect(sx+S*0.18, sy+S*0.34, S*0.64, S*0.32);
    });
    ctx.restore();
  }

  IZZA.on('render-post', ()=>{
    if(!api?.ready || !isTier2()) return;
    const ctx=document.getElementById('game').getContext('2d');

    // always show parked boats (except the one we're riding)
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
  function toast(msg, seconds=2.0){
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
