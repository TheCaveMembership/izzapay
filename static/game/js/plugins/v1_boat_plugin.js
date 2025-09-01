// /static/game/js/plugins/v1_boat_plugin.js
// v1.4 — full-lake boating (center test), smooth dock walking (any-corner guard),
//         claim/hide the boarded dock boat until you disembark
(function(){
  const BUILD='v1.4-boat-plugin+center-water+any-corner-land+claim-dock-boat';
  console.log('[IZZA PLAY]', BUILD);

  const TIER_KEY='izzaMapTier';
  const isTier2 = ()=> localStorage.getItem(TIER_KEY)==='2';

  // --- local state ---
  let api=null;
  let inBoat=false;
  let ghostBoat=null;             // visual follower while riding
  let lastLand=null, lastWater=null;
  let claimedDockKey=null;        // `${gx}|${gy}` plank we boarded from (to hide its parked boat)

  // ====== geometry (mirror expansion) ======
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
      { x0: LAKE.x0, y: LAKE.y0+4,  len: 3 },  // horizontal planks extending RIGHT from lake’s left edge
      { x0: LAKE.x0, y: LAKE.y0+12, len: 4 }
    ];
    return {LAKE, BEACH_X, DOCKS};
  }

  // ====== helpers ======
  function t(){ return api.TILE; }
  function playerGrid(){ const T=t(); return { gx: ((api.player.x+16)/T|0), gy: ((api.player.y+16)/T|0) }; }
  function playerCenter(){ return playerGrid(); }

  function dockCells(){
    if(!api?.ready) return new Set();
    const {DOCKS}=lakeRects(anchors(api));
    const set=new Set();
    DOCKS.forEach(d=>{ for(let i=0;i<d.len;i++) set.add((d.x0+i)+'|'+d.y); });
    return set;
  }

  // True only for WATER tiles (not planks)
  function tileIsWater(gx,gy){
    if(!api?.ready) return false;
    const {LAKE}=lakeRects(anchors(api));
    const inLake = (gx>=LAKE.x0 && gx<=LAKE.x1 && gy>=LAKE.y0 && gy<=LAKE.y1);
    if(!inLake) return false;
    if(dockCells().has(gx+'|'+gy)) return false; // planks are walkable, not water
    return true;
  }

  // nearest plank around (gx,gy) — returns {x,y} or null
  function nearestAdjacentPlank(gx,gy){
    const docks=dockCells();
    const n=[{x:gx+1,y:gy},{x:gx-1,y:gy},{x:gx,y:gy+1},{x:gx,y:gy-1}];
    for(const p of n){ if(docks.has(p.x+'|'+p.y)) return p; }
    return null;
  }

  // ====== boarding / leaving ======
  function canBoardHere(){
    if(!isTier2() || !api?.ready) return false;
    const {gx,gy}=playerGrid();
    const docks = dockCells();
    if(docks.has(gx+'|'+gy)) return true; // standing on a plank
    if(nearestAdjacentPlank(gx,gy)) return true; // right beside a plank
    return false;
  }

  function tryBoard(){
    if(inBoat || !isTier2() || !canBoardHere()) return false;

    // claim the *specific* dock plank we’re using so its parked boat hides
    const {gx,gy}=playerGrid();
    const plank = dockCells().has(gx+'|'+gy) ? {x:gx,y:gy} : nearestAdjacentPlank(gx,gy);
    claimedDockKey = plank ? (plank.x+'|'+plank.y) : null;

    inBoat = true;
    ghostBoat = { x: api.player.x, y: api.player.y };
    lastWater = { x: api.player.x, y: api.player.y };
    api.player.speed = 120; // boating speed
    toast('Boarded boat');
    return true;
  }

  // Snap to dock plank if adjacent, else snap to the beach column if right of it
  function nearestDisembarkSpot(){
    const {LAKE,BEACH_X}=lakeRects(anchors(api));
    const {gx,gy}=playerGrid();

    const adjPlank = nearestAdjacentPlank(gx,gy);
    if(adjPlank) return adjPlank;

    // beach: water cell immediately to the RIGHT of the beach column
    if(gx===BEACH_X+1 && gy>=LAKE.y0 && gy<=LAKE.y1) return {x:BEACH_X, y:gy};

    // if somehow exactly on a plank, allow that too
    const docks=dockCells();
    if(docks.has(gx+'|'+gy)) return {x:gx,y:gy};

    return null;
  }

  function tryDisembark(){
    if(!inBoat) return false;
    const spot = nearestDisembarkSpot();
    if(!spot) return false;

    const T=t();
    api.player.x = (spot.x*T) + 1;
    api.player.y = (spot.y*T) + 1;

    inBoat=false;
    ghostBoat=null;
    api.player.speed = 90; // walk speed

    // if we landed at a plank, leave the boat there (so show parked boat again)
    const landedKey = spot.x+'|'+spot.y;
    if(landedKey===claimedDockKey) claimedDockKey=null; // we returned it
    toast('Disembarked');
    return true;
  }

  // ====== input (B) ======
  function onB(e){
    if(!api?.ready || !isTier2()) return;
    const shouldHandle = inBoat || canBoardHere();
    if(!shouldHandle) return; // let other B features handle their cases

    const acted = inBoat ? tryDisembark() : tryBoard();
    if(acted){
      e?.preventDefault?.();
      e?.stopPropagation?.();
      e?.stopImmediatePropagation?.();
    }
  }

  // ====== update: new water/land rules ======
  IZZA.on('update-pre', ()=>{
    if(!api?.ready || !isTier2()) return;
    const p=api.player, T=t();

    // corners for walking guard
    const corners = [
      {x:((p.x+1)/T)|0,  y:((p.y+1)/T)|0},
      {x:((p.x+31)/T)|0, y:((p.y+1)/T)|0},
      {x:((p.x+1)/T)|0,  y:((p.y+31)/T)|0},
      {x:((p.x+31)/T)|0, y:((p.y+31)/T)|0}
    ];
    const anyCornerOnWater = corners.some(c=> tileIsWater(c.x,c.y));

    if(inBoat){
      // while boating, only the *center* needs to be water
      const {gx,gy}=playerCenter();
      const centerOnWater = tileIsWater(gx,gy);
      if(centerOnWater){
        lastWater = {x:p.x,y:p.y};
      }else if(lastWater){
        p.x = lastWater.x; p.y = lastWater.y;
      }
      // keep the ghost aligned
      if(ghostBoat){ ghostBoat.x=p.x; ghostBoat.y=p.y; }
    }else{
      // on foot: if ANY corner touches water, snap back (prevents “half-stepping” onto water)
      if(!anyCornerOnWater){
        lastLand = {x:p.x,y:p.y};
      }else if(lastLand){
        p.x = lastLand.x; p.y = lastLand.y;
      }
    }
  });

  // ====== visuals: parked boats + rider boat ======
  function drawParkedDockBoats(ctx){
    const {DOCKS}=lakeRects(anchors(api));
    const S=api.DRAW, T=t();
    ctx.save();
    ctx.fillStyle='#7ca7c7';
    DOCKS.forEach(d=>{
      for(let i=0;i<d.len;i++){} // just to show intent; boats only at the end

      const plank = { x: d.x0 + (d.len-1), y: d.y };     // last plank tile
      const plankKey = plank.x+'|'+plank.y;
      if(inBoat && plankKey===claimedDockKey) return;     // hide the one we took

      // boat sits on the first WATER tile just to the RIGHT of the last plank
      const gx = d.x0 + d.len;
      const gy = d.y;
      const sx = (gx*T - api.camera.x) * (S/T);
      const sy = (gy*T - api.camera.y) * (S/T);
      ctx.fillRect(sx+S*0.18, sy+S*0.34, S*0.64, S*0.32);
    });
    ctx.restore();
  }

  IZZA.on('render-post', ()=>{
    if(!api?.ready || !isTier2()) return;
    const ctx=document.getElementById('game').getContext('2d');

    // show parked boats (except the one we claimed)
    drawParkedDockBoats(ctx);

    // rider boat
    if(inBoat && ghostBoat){
      const S=api.DRAW, T=t();
      const sx = (ghostBoat.x - api.camera.x) * (S/T);
      const sy = (ghostBoat.y - api.camera.y) * (S/T);
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
    if(btnB) btnB.addEventListener('click', onB, true); // capture to preempt when handled
    window.addEventListener('keydown', e=>{
      if((e.key||'').toLowerCase()==='b') onB(e);
    }, {passive:false, capture:true});
    console.log('[boat] ready', BUILD);
  });
})();
