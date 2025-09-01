// /static/game/js/plugins/v1_boat_plugin.js
// v1.5 — walkable planks (center test), full-lake boating (center + post fix),
//         parked boats BESIDE docks (south/middle), claim/hide while ridden,
//         player position marker (gx,gy)
(function(){
  const BUILD='v1.5-boat-plugin+dock-side+center-guards+pos-marker';
  console.log('[IZZA PLAY]', BUILD);

  const TIER_KEY='izzaMapTier';
  const isTier2 = ()=> localStorage.getItem(TIER_KEY)==='2';

  // debug: show player grid marker (can toggle at runtime: window._izzaShowPos=false)
  window._izzaShowPos = (window._izzaShowPos!==false);

  // --- local state ---
  let api=null;
  let inBoat=false;
  let ghostBoat=null;             // simple hull that follows player while boating
  let lastLand=null, lastWater=null;
  let claimedDockKey=null;        // plank key we boarded from, to hide its parked boat

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
      { x0: LAKE.x0, y: LAKE.y0+4,  len: 3 },   // planks extend RIGHT from the left lake edge
      { x0: LAKE.x0, y: LAKE.y0+12, len: 4 }
    ];
    return {LAKE, BEACH_X, DOCKS};
  }

  // ====== helpers ======
  const T = ()=> api.TILE;
  function playerGrid(){ const t=T(); return { gx: ((api.player.x+16)/t|0), gy: ((api.player.y+16)/t|0) }; }
  function centerGX(){ return ((api.player.x+16)/T()|0); }
  function centerGY(){ return ((api.player.y+16)/T()|0); }

  function dockCells(){
    if(!api?.ready) return new Set();
    const {DOCKS}=lakeRects(anchors(api));
    const set=new Set();
    DOCKS.forEach(d=>{ for(let i=0;i<d.len;i++) set.add((d.x0+i)+'|'+d.y); });
    return set;
  }

  // classifies WATER tiles only (dock planks are NOT water)
  function tileIsWater(gx,gy){
    if(!api?.ready) return false;
    const {LAKE}=lakeRects(anchors(api));
    if(!(gx>=LAKE.x0 && gx<=LAKE.x1 && gy>=LAKE.y0 && gy<=LAKE.y1)) return false;
    if(dockCells().has(gx+'|'+gy)) return false;
    return true;
  }

  // parked spot BESIDE a dock (south of the middle plank)
  function parkedSpotForDock(d){
    const mid = d.x0 + Math.max(1, Math.floor(d.len/2)); // 2nd or middle plank tile
    return { gx: mid, gy: d.y+1 };                       // south side (water)
  }

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
    if(docks.has(gx+'|'+gy)) return true; // standing on plank
    return !!nearestAdjacentPlank(gx,gy); // right beside a plank
  }

  function tryBoard(){
    if(inBoat || !isTier2() || !canBoardHere()) return false;

    // claim the plank we boarded at so its parked boat hides while riding
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

  // prefer a dock plank next to us; else beach column if we’re right of it
  function nearestDisembarkSpot(){
    const {LAKE,BEACH_X}=lakeRects(anchors(api));
    const gx=centerGX(), gy=centerGY();

    const adjPlank = nearestAdjacentPlank(gx,gy);
    if(adjPlank) return adjPlank;

    if(gx===BEACH_X+1 && gy>=LAKE.y0 && gy<=LAKE.y1) return {x:BEACH_X, y:gy};

    const docks=dockCells();
    if(docks.has(gx+'|'+gy)) return {x:gx,y:gy};

    return null;
  }

  function tryDisembark(){
    if(!inBoat) return false;
    const spot = nearestDisembarkSpot();
    if(!spot) return false;

    const t=T();
    api.player.x = (spot.x*t)+1;
    api.player.y = (spot.y*t)+1;

    inBoat=false;
    ghostBoat=null;
    api.player.speed = 90;

    // if we returned to the same plank, unclaim so the boat reappears
    const landedKey = spot.x+'|'+spot.y;
    if(landedKey===claimedDockKey) claimedDockKey=null;

    toast('Disembarked');
    return true;
  }

  // ====== input (B) ======
  function onB(e){
    if(!api?.ready || !isTier2()) return;
    const shouldHandle = inBoat || canBoardHere();
    if(!shouldHandle) return;

    const acted = inBoat ? tryDisembark() : tryBoard();
    if(acted){
      e?.preventDefault?.(); e?.stopPropagation?.(); e?.stopImmediatePropagation?.();
    }
  }

  // ====== movement clamps ======
  // 1) update-pre: classification by **center tile** (prevents dock jitter)
  IZZA.on('update-pre', ()=>{
    if(!api?.ready || !isTier2()) return;
    const p=api.player;

    if(inBoat){
      const cx=centerGX(), cy=centerGY();
      const onWater = tileIsWater(cx,cy);
      if(onWater){ lastWater={x:p.x,y:p.y}; }
      else if(lastWater){ p.x=lastWater.x; p.y=lastWater.y; }
      if(ghostBoat){ ghostBoat.x=p.x; ghostBoat.y=p.y; }
    }else{
      // on foot: center must NOT be water (planks & beach are fine)
      const cx=centerGX(), cy=centerGY();
      if(!tileIsWater(cx,cy)){ lastLand={x:p.x,y:p.y}; }
      else if(lastLand){ p.x=lastLand.x; p.y=lastLand.y; }
    }
  });

  // 2) update-post: re-assert boating clamp AFTER other plugins’ collision pushes
  IZZA.on('update-post', ()=>{
    if(!api?.ready || !isTier2() || !inBoat) return;
    const p=api.player;
    const cx=centerGX(), cy=centerGY();
    const onWater = tileIsWater(cx,cy);
    if(onWater){ lastWater={x:p.x,y:p.y}; }
    else if(lastWater){ p.x=lastWater.x; p.y=lastWater.y; }
    if(ghostBoat){ ghostBoat.x=p.x; ghostBoat.y=p.y; }
  });

  // ====== visuals ======
  function drawParkedDockBoats(ctx){
    const {DOCKS}=lakeRects(anchors(api));
    const S=api.DRAW, t=T();

    ctx.save();
    ctx.fillStyle='#7ca7c7';
    DOCKS.forEach(d=>{
      // hide the parked boat if we claimed the plank used for boarding
      const midPlank = { x: d.x0 + Math.max(1, Math.floor(d.len/2)), y: d.y };
      const midKey   = midPlank.x+'|'+midPlank.y';
      if(inBoat && claimedDockKey===midKey) return;

      // parked boat is on the SOUTH side of the middle plank (beside, not at the tip)
      const spot = parkedSpotForDock(d);
      const sx = (spot.gx*t - api.camera.x) * (S/t);
      const sy = (spot.gy*t - api.camera.y) * (S/t);
      ctx.fillRect(sx+S*0.18, sy+S*0.34, S*0.64, S*0.32);
    });
    ctx.restore();
  }

  function drawPlayerPosMarker(ctx){
    if(!window._izzaShowPos) return;
    const S=api.DRAW, t=T();
    const gx=centerGX(), gy=centerGY();

    // tile highlight
    const sx = (gx*t - api.camera.x) * (S/t);
    const sy = (gy*t - api.camera.y) * (S/t);
    ctx.save();
    ctx.fillStyle='rgba(80,220,255,0.25)';
    ctx.fillRect(sx+2, sy+2, S-4, S-4);

    // text label above the player
    ctx.font = '12px monospace';
    ctx.fillStyle='#aef';
    ctx.strokeStyle='rgba(0,0,0,0.6)';
    ctx.lineWidth=3;
    const label = `${gx},${gy}`;
    const tx = sx + S*0.1, ty = sy - 6;
    ctx.strokeText(label, tx, ty);
    ctx.fillText(label, tx, ty);
    ctx.restore();
  }

  IZZA.on('render-post', ()=>{
    if(!api?.ready || !isTier2()) return;
    const ctx=document.getElementById('game').getContext('2d');

    drawParkedDockBoats(ctx);

    // rider boat
    if(inBoat && ghostBoat){
      const S=api.DRAW, t=T();
      const sx = (ghostBoat.x - api.camera.x) * (S/t);
      const sy = (ghostBoat.y - api.camera.y) * (S/t);
      ctx.fillStyle='#7ca7c7';
      ctx.fillRect(sx+S*0.18, sy+S*0.34, S*0.64, S*0.32);
    }

    drawPlayerPosMarker(ctx);
  });

  // ====== boot ======
  function toast(msg, seconds=1.8){
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
    if(btnB) btnB.addEventListener('click', onB, true);
    window.addEventListener('keydown', e=>{
      if((e.key||'').toLowerCase()==='b') onB(e);
    }, {passive:false, capture:true});
    console.log('[boat] ready', BUILD);
  });
})();
