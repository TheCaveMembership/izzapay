// v1_boat_plugin.js — boats & boarding as a standalone plugin (Tier-2 only)
(function(){
  const BUILD = 'v1-boat-plugin+tier2';
  if(window._IZZA_BOATS_ACTIVE) return; // avoid duplicates if expansion also does boats
  window._IZZA_BOATS_ACTIVE = true;
  console.log('[IZZA PLAY]', BUILD);

  const TIER_KEY='izzaMapTier';
  const isTier2 = ()=> localStorage.getItem(TIER_KEY)==='2';

  let api=null;

  // --- geometry mirrored from expansion (not imported, re-computed here)
  function unlockedRect(t){ return (t!=='2') ? {x0:18,y0:18,x1:72,y1:42} : {x0:10,y0:12,x1:80,y1:50}; }
  function anchors(){
    const t = localStorage.getItem(TIER_KEY)||'1';
    const un = unlockedRect(t);
    const bW=10,bH=6;
    const bX = Math.floor((un.x0+un.x1)/2) - Math.floor(bW/2);
    const bY = un.y0 + 5;
    const hRoadY=bY+bH+1;
    const vRoadX=Math.min(un.x1-3, bX+bW+6);
    return {un,hRoadY,vRoadX};
  }
  function lakeRects(a){
    const LAKE = { x0:a.un.x1-14, y0:a.un.y0+23, x1:a.un.x1, y1:a.un.y1 };
    const DOCKS= [
      { x0: LAKE.x0, y: LAKE.y0+4,  len: 3 },
      { x0: LAKE.x0, y: LAKE.y0+12, len: 4 }
    ];
    const BEACH_X = LAKE.x0-1;
    return {LAKE,DOCKS,BEACH_X};
  }

  // --- state
  const swimmers=[];        // ambient boats looping the lake
  let   riding=false;       // player in a boat?
  let   ride=null;          // visual overlay position
  let   lastLand=null, lastWater=null;

  // helpers
  function dockCells(){
    const A=anchors(), {DOCKS}=lakeRects(A);
    const set=new Set();
    DOCKS.forEach(d=>{ for(let i=0;i<d.len;i++) set.add((d.x0+i)+'|'+d.y); });
    return set;
  }
  function isWater(gx,gy){
    const A=anchors(), {LAKE}=lakeRects(A);
    if(gx<LAKE.x0||gx>LAKE.x1||gy<LAKE.y0||gy>LAKE.y1) return false;
    return !dockCells().has(gx+'|'+gy);
  }
  function canBoardHere(){
    const t=api.TILE, gx=((api.player.x+16)/t|0), gy=((api.player.y+16)/t|0);
    const docks = dockCells();
    if(docks.has(gx+'|'+gy)) return true;
    if(docks.has((gx+1)+'|'+gy) || docks.has((gx-1)+'|'+gy) || docks.has(gx+'|'+(gy+1)) || docks.has(gx+'|'+(gy-1))) return true;
    return false;
  }
  function uiBusy(){
    // don’t hijack B when UI is up
    const any = ['enterModal','shopModal','hospitalShop','invPanel','mapModal']
      .map(id=>document.getElementById(id))
      .some(el=> el && el.style.display && el.style.display!=='none');
    return any;
  }

  // ambient swimmers
  function spawnSwimmers(){
    if(!isTier2() || swimmers.length) return;
    const A=anchors(), {LAKE}=lakeRects(A);
    const pad = {x0:LAKE.x0+2,y0:LAKE.y0+2,x1:LAKE.x1-2,y1:LAKE.y1-2};
    function makeLoop(x,y,s,clockwise=true){
      const r=pad;
      const path = clockwise
        ? [{x:r.x0,y:r.y0},{x:r.x1,y:r.y0},{x:r.x1,y:r.y1},{x:r.x0,y:r.y1}]
        : [{x:r.x1,y:r.y1},{x:r.x0,y:r.y1},{x:r.x0,y:r.y0},{x:r.x1,y:r.y0}];
      return {x,y,s,i:0,path};
    }
    swimmers.push(makeLoop(pad.x0, pad.y0, 52, true));
    swimmers.push(makeLoop(pad.x0+1, pad.y1-1, 55, false));
  }

  function board(){
    if(riding || !isTier2() || uiBusy()) return;
    if(!canBoardHere()) return;
    riding=true;
    ride={x:0,y:0};
    api.player.speed=120;
    lastWater={x:api.player.x,y:api.player.y};
    IZZA.emit?.('toast',{text:'Boarded boat'});
  }
  function disembark(){
    if(!riding) return;
    const t=api.TILE, gx=((api.player.x+16)/t|0), gy=((api.player.y+16)/t|0);
    const {LAKE,BEACH_X}=lakeRects(anchors());
    const onDock = dockCells().has(gx+'|'+gy);
    const onBeach = (gx===BEACH_X && gy>=LAKE.y0 && gy<=LAKE.y1);
    if(onDock || onBeach){
      riding=false; ride=null;
      api.player.speed=90;
      IZZA.emit?.('toast',{text:'Disembarked'});
    }
  }

  function onB(){
    if(!isTier2() || uiBusy()) return;
    if(riding) disembark(); else board();
  }

  // movement clamps (keep boats on water / walkers off water)
  IZZA.on('update-pre', ({dtSec})=>{
    if(!api?.ready || !isTier2()) return;

    // update ambient boats
    const A=anchors(), {LAKE}=lakeRects(A);
    swimmers.forEach(b=>{
      const tgt=b.path[b.i], dx=tgt.x-b.x, dy=tgt.y-b.y, m=Math.hypot(dx,dy)||1, step=b.s*dtSec/32;
      if(m<=step){ b.x=tgt.x; b.y=tgt.y; b.i=(b.i+1)%b.path.length; }
      else{ b.x += (dx/m)*step; b.y += (dy/m)*step; }
      b.x=Math.max(LAKE.x0+1, Math.min(LAKE.x1-1, b.x));
      b.y=Math.max(LAKE.y0+1, Math.min(LAKE.y1-1, b.y));
    });

    const p=api.player, t=api.TILE;
    const corners = [
      {x:((p.x+1)/t)|0,  y:((p.y+1)/t)|0},
      {x:((p.x+31)/t)|0, y:((p.y+1)/t)|0},
      {x:((p.x+1)/t)|0,  y:((p.y+31)/t)|0},
      {x:((p.x+31)/t)|0, y:((p.y+31)/t)|0}
    ];
    const onWater = corners.every(c=> isWater(c.x,c.y));
    if(riding){
      if(onWater){ lastWater={x:p.x,y:p.y}; }
      else if(lastWater){ p.x=lastWater.x; p.y=lastWater.y; }
    }else{
      if(!onWater) lastLand={x:p.x,y:p.y};
      else if(lastLand){ p.x=lastLand.x; p.y=lastLand.y; }
    }

    if(riding && ride){
      ride.x = ((p.x/t)|0);
      ride.y = ((p.y/t)|0);
    }
  });

  // draw overlays
  IZZA.on('render-post', ()=>{
    if(!api?.ready || !isTier2()) return;
    const ctx=document.getElementById('game').getContext('2d');
    const S=api.DRAW, t=api.TILE;

    // ambient boats
    ctx.fillStyle='#7ca7c7';
    swimmers.forEach(b=>{
      const sx=(b.x*t - api.camera.x)*(S/t);
      const sy=(b.y*t - api.camera.y)*(S/t);
      ctx.fillRect(sx+S*0.18, sy+S*0.34, S*0.64, S*0.32);
    });

    // player boat
    if(riding && ride){
      const gx=ride.x, gy=ride.y;
      const sx=(gx*t - api.camera.x)*(S/t);
      const sy=(gy*t - api.camera.y)*(S/t);
      ctx.fillStyle='#7ca7c7';
      ctx.fillRect(sx+S*0.18, sy+S*0.34, S*0.64, S*0.32);
    }
  });

  IZZA.on('ready', (a)=>{
    api=a;
    spawnSwimmers();
    const btnB=document.getElementById('btnB');
    window.addEventListener('keydown', e=>{ if((e.key||'').toLowerCase()==='b') onB(); }, {passive:true});
    btnB && btnB.addEventListener('click', onB);
  });
})();
