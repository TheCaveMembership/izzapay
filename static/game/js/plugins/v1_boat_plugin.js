// /static/game/js/plugins/v1_boat_plugin.js
// v1.3 — proper dock/beach disembark, parked dock boats, smoother dock walking
(function(){
  const BUILD='v1.3-boat-plugin+dock-snap+parked-boats';
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
      { x0: LAKE.x0, y: LAKE.y0+4,  len: 3 },  // horizontal planks
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
  function tileIsWater(gx,gy){
    if(!api?.ready) return false;
    const {LAKE}=lakeRects(anchors(api));
    const inLake = (gx>=LAKE.x0 && gx<=LAKE.x1 && gy>=LAKE.y0 && gy<=LAKE.y1);
    if(!inLake) return false;
    // planks are NOT water (walkable)
    if(dockCells().has(gx+'|'+gy)) return false;
    return true;
  }

  // Get the nearest *land* snap target when leaving the boat:
  // - if next to any dock plank, snap to that plank tile
  // - else if next to beach edge, snap onto the beach column
  function nearestDisembarkSpot(){
    const A = anchors(api), {LAKE,BEACH_X}=lakeRects(A);
    const {gx,gy}=playerGrid();
    const docks = dockCells();

    // check 4-neighborhood for a dock plank
    const neighbors = [
      {x:gx+1,y:gy}, {x:gx-1,y:gy}, {x:gx,y:gy+1}, {x:gx,y:gy-1}
    ];
    for(const n of neighbors){
      if(docks.has(n.x+'|'+n.y)) return {x:n.x, y:n.y};
    }

    // beach snap: if water cell directly to the right of the beach, snap onto the beach
    // (beach is the entire column at BEACH_X spanning lake.y0..y1)
    const onWaterRightOfBeach = (gx===BEACH_X+1 && gy>=LAKE.y0 && gy<=LAKE.y1);
    if(onWaterRightOfBeach) return {x:BEACH_X, y:gy};

    // if we are actually *on* a plank (rare while boating, but just in case)
    if(docks.has(gx+'|'+gy)) return {x:gx,y:gy};

    return null;
  }

  // ====== boarding / leaving rules ======
  function canBoardHere(){
    if(!isTier2() || !api?.ready) return false;
    const {gx,gy}=playerGrid();
    const docks = dockCells();
    if(docks.has(gx+'|'+gy)) return true; // standing on plank
    // adjacent to a plank also counts (edge)
    if(docks.has((gx+1)+'|'+gy) || docks.has((gx-1)+'|'+gy) ||
       docks.has(gx+'|'+(gy+1)) || docks.has(gx+'|'+(gy-1))) return true;
    return false;
  }
  function tryBoard(){
    if(inBoat || !isTier2()) return false;
    if(!canBoardHere()) return false;
    inBoat = true;
    ghostBoat = { x: api.player.x, y: api.player.y };
    lastWater = { x: api.player.x, y: api.player.y };
    api.player.speed = 120; // smooth boating speed
    toast('Boarded boat');
    return true;
  }
  function tryDisembark(){
    if(!inBoat) return false;
    const spot = nearestDisembarkSpot();
    if(!spot) return false;

    // snap player *onto* the land spot (plank or beach)
    const t = api.TILE;
    api.player.x = (spot.x * t) + 1;   // slight bias inside tile
    api.player.y = (spot.y * t) + 1;

    inBoat=false; ghostBoat=null;
    api.player.speed = 90; // default walk speed
    toast('Disembarked');
    return true;
  }

  // ====== input (B) ======
  function onB(e){
    if(!api?.ready || !isTier2()) return;
    // Only handle if player is on/near dock or already in boat
    const shouldHandle = inBoat || canBoardHere();
    if(!shouldHandle) return; // let other B handlers (shop, car hijack) handle

    const acted = inBoat ? tryDisembark() : tryBoard();
    if(acted){
      if(e){ e.preventDefault?.(); e.stopPropagation?.(); e.stopImmediatePropagation?.(); }
    }
  }

  // ====== update hooks ======
  IZZA.on('update-pre', ({dtSec})=>{
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

    if(inBoat){
      if(onWater){ lastWater = {x:p.x,y:p.y}; }
      else if(lastWater){ p.x=lastWater.x; p.y=lastWater.y; } // keep boat on water only
    }else{
      if(!onWater) lastLand = {x:p.x,y:p.y};
      else if(lastLand){ p.x=lastLand.x; p.y=lastLand.y; } // keep walking off the lake
    }

    // keep ghost sprite aligned
    if(inBoat && ghostBoat){
      ghostBoat.x = p.x;
      ghostBoat.y = p.y;
    }
  });

  // ====== simple visuals: parked boats + player boat ======
  function drawParkedDockBoats(ctx){
    const {DOCKS}=lakeRects(anchors(api));
    const S=api.DRAW, t=api.TILE;
    ctx.save();
    ctx.fillStyle='#7ca7c7';
    // draw a small hull just to the RIGHT of each plank (beside the dock)
    DOCKS.forEach(d=>{
      const gx = d.x0 + d.len;       // water tile immediately to the right of plank
      const gy = d.y;
      const sx = (gx*t - api.camera.x) * (S/t);
      const sy = (gy*t - api.camera.y) * (S/t);
      ctx.fillRect(sx+S*0.18, sy+S*0.34, S*0.64, S*0.32);
    });
    ctx.restore();
  }

  IZZA.on('render-post', ()=>{
    if(!api?.ready || !isTier2()) return;
    const ctx=document.getElementById('game').getContext('2d');

    // always show parked boats by the docks
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
    // Input wiring (play nice with other B handlers)
    const btnB=document.getElementById('btnB');
    if(btnB) btnB.addEventListener('click', onB, true);  // capture so we can preempt when handled
    window.addEventListener('keydown', e=>{
      if((e.key||'').toLowerCase()==='b') onB(e);
    }, {passive:false, capture:true});
    console.log('[boat] ready', BUILD);
  });
})();
