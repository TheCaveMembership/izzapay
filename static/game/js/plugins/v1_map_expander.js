<script>
(function(){
  // --- shared constants (mirror of core tier sizes) ---
  const TILE = 32;
  const tier = (localStorage.getItem('izzaMapTier')||'1');
  const unlocked = (tier==='2')
      ? {x0:10,y0:12,x1:80,y1:50}
      : {x0:18,y0:18,x1:72,y1:42};

  // === SE LAKE (big) ===
  // Large lake in the SE quadrant; stays clear of the original HQ/shop strip.
  const lake = {
    x0: Math.max(unlocked.x1 - 12, unlocked.x0+20),
    y0: Math.floor(unlocked.y0 + (unlocked.y1-unlocked.y0)*0.55),
    x1: unlocked.x1 - 1,
    y1: unlocked.y1 - 1
  };
  // 1-tile beach band on the west rim
  const beach = { x0: lake.x0-1, y0: lake.y0, x1: lake.x0-1, y1: lake.y1 };

  // Docks that extend into the water from the beach
  const docks = [
    {x0: lake.x0, y0: lake.y0+3, x1: lake.x0+3, y1: lake.y0+3},
    {x0: lake.x0, y0: lake.y0+10, x1: lake.x0+4, y1: lake.y0+10},
    {x0: lake.x0, y0: lake.y0+17, x1: lake.x0+3, y1: lake.y0+17},
  ];

  // Hotel on the north shore (on land; never on sidewalks/roads)
  const hotel = {x0: lake.x0+2, y0: lake.y0-5, x1: lake.x0+8, y1: lake.y0-1};

  // === Neighborhood (bottom-left of tier 2) ===
  // A tidy grid with small houses and one park; placed away from core’s main h/v roads.
  const hoodArea = {
    x0: unlocked.x0+2,
    y0: Math.floor(unlocked.y0 + (unlocked.y1-unlocked.y0)*0.65),
    x1: Math.min(unlocked.x0+26, unlocked.x1-30),
    y1: unlocked.y1-2
  };
  // 3 horizontal locals + 3 vertical locals form blocks
  const hoodH = [hoodArea.y0+1, hoodArea.y0+5, hoodArea.y0+9];
  const hoodV = [hoodArea.x0+6, hoodArea.x0+12, hoodArea.x0+18];
  // Houses (small 2×2 / 3×2) tucked inside blocks, no sidewalk coverage
  const houses = [
    {x0: hoodArea.x0+1, y0: hoodArea.y0+2, x1: hoodArea.x0+2, y1: hoodArea.y0+3},
    {x0: hoodArea.x0+8, y0: hoodArea.y0+2, x1: hoodArea.x0+10,y1: hoodArea.y0+3},
    {x0: hoodArea.x0+14,y0: hoodArea.y0+2, x1: hoodArea.x0+16,y1: hoodArea.y0+3},
    {x0: hoodArea.x0+2, y0: hoodArea.y0+7, x1: hoodArea.x0+4, y1: hoodArea.y0+8},
    {x0: hoodArea.x0+9, y0: hoodArea.y0+7, x1: hoodArea.x0+11,y1: hoodArea.y0+8},
    {x0: hoodArea.x0+15,y0: hoodArea.y0+7, x1: hoodArea.x0+17,y1: hoodArea.y0+8},
  ];
  // Small park (grass + darker paths)
  const park = {x0: hoodArea.x0+19, y0: hoodArea.y0+5, x1: hoodArea.x0+24, y1: hoodArea.y0+9};

  // ===== helpers =====
  const inRect = (gx,gy,r) => gx>=r.x0 && gx<=r.x1 && gy>=r.y0 && gy<=r.y1;
  function anyRectHit(gx,gy, list){ return list.some(r=>inRect(gx,gy,r)); }

  // ====== Boats ======
  const boats = [];      // moving NPC boats on the lake
  const dockBoats = [];  // idle boats at docks the player can use
  let towingBoat = null; // the one towing the wakeboarder
  const WAKE_LEN = 2.2;  // tiles behind boat

  function makeLoopBoat(x,y, speed, clockwise=true){
    // Rectangular loop path around the lake with margins
    const m=1, L={x0:lake.x0+m,y0:lake.y0+m,x1:lake.x1-m,y1:lake.y1-m};
    const path = clockwise
      ? [{x:L.x0,y:L.y0},{x:L.x1,y:L.y0},{x:L.x1,y:L.y1},{x:L.x0,y:L.y1}]
      : [{x:L.x1,y:L.y1},{x:L.x0,y:L.y1},{x:L.x0,y:L.y0},{x:L.x1,y:L.y0}];
    return {x,y, speed, i:0, path};
  }
  function makeDockBoat(dock){
    const x = dock.x0+((dock.x1-dock.x0)>>1);
    const y = dock.y0;
    return {x,y, speed: 120, taken:false};
  }

  function spawnBoats(){
    if(boats.length) return;
    boats.push(makeLoopBoat(lake.x0+2, lake.y0+2, 55, true));
    boats.push(makeLoopBoat(lake.x1-2, lake.y1-2, 60, false));
    towingBoat = makeLoopBoat(lake.x0+3, lake.y1-3, 50, true);
    boats.push(towingBoat);

    docks.forEach(d=> dockBoats.push(makeDockBoat(d)));
  }

  // ===== player <-> boat mount state =====
  let inBoat = false;
  let ridingBoat = null;
  let lastSafe = null;

  function playerGX(){ return Math.floor((IZZA.api.player.x+TILE/2)/TILE); }
  function playerGY(){ return Math.floor((IZZA.api.player.y+TILE/2)/TILE); }

  function tileIsWater(gx,gy){ return inRect(gx,gy,lake); }
  function tileIsBeach(gx,gy){ return inRect(gx,gy,beach); }
  function tileIsDock(gx,gy){ return anyRectHit(gx,gy,docks); }
  function tileIsBuilding(gx,gy){ return inRect(gx,gy,hotel) || anyRectHit(gx,gy,houses) || inRect(gx,gy,park); }
  function tileBlocksWalk(gx,gy){
    // forbid water unless in boat; buildings & docks block always
    if(tileIsDock(gx,gy) || tileIsBuilding(gx,gy)) return true;
    if(tileIsWater(gx,gy) && !inBoat) return true;
    return false;
  }

  // Try mount/dismount from boats
  function tryEnterBoat(){
    if(inBoat) return; // already riding
    const px = playerGX(), py = playerGY();
    // must be standing on a DOCK tile
    if(!tileIsDock(px,py)) return;
    // find closest idle dock boat
    let best=null, bd=9999;
    for(const b of dockBoats){
      if(b.taken) continue;
      const d = Math.hypot(b.x-px, b.y-py);
      if(d<bd){ bd=d; best=b; }
    }
    if(best && bd<=2.0){
      ridingBoat = best; best.taken=true;
      inBoat = true;
      IZZA.api.player.speed = 120; // faster on water
    }
  }
  function tryLeaveBoat(){
    if(!inBoat) return;
    const px = playerGX(), py = playerGY();
    // Only allow leaving on dock or beach
    if(tileIsDock(px,py) || tileIsBeach(px,py)){
      inBoat = false;
      if(ridingBoat){ ridingBoat.taken=false; ridingBoat.x = px; ridingBoat.y = py; }
      ridingBoat = null;
      IZZA.api.player.speed = 90;
    }
  }

  // === input: support keyboard B and on-screen B ===
  window.addEventListener('keydown', e=>{
    if(e.key && e.key.toLowerCase()==='b'){
      if(inBoat) tryLeaveBoat(); else tryEnterBoat();
    }
  }, false);
  const btnB = document.getElementById('btnB');
  if(btnB) btnB.addEventListener('click', ()=>{ if(inBoat) tryLeaveBoat(); else tryEnterBoat(); });

  // ===== hooks =====
  IZZA.on('ready', ()=>{
    spawnBoats();
  });

  // keep the player out of blocked tiles without touching core’s isSolid
  IZZA.on('update-pre', ({dtSec})=>{
    const p = IZZA.api.player;
    const gx = playerGX(), gy = playerGY();

    // remember last safe ground tile (not water/building/dock)
    if(!tileBlocksWalk(gx,gy)){
      lastSafe = {x:p.x, y:p.y, gx, gy};
    }else{
      // if illegal and we weren't in a boat, snap back
      if(!inBoat && lastSafe){
        p.x = lastSafe.x; p.y = lastSafe.y;
      }
    }

    // move NPC boats
    for(const b of boats){
      const tgt = b.path[b.i];
      const dx = (tgt.x*1.0 - b.x), dy=(tgt.y*1.0 - b.y);
      const m = Math.hypot(dx,dy)||1;
      const step = b.speed * dtSec / TILE;
      if(m <= step){
        b.x = tgt.x; b.y = tgt.y;
        b.i = (b.i+1) % b.path.length;
      }else{
        b.x += (dx/m)*step; b.y += (dy/m)*step;
      }
    }

    // riding: boat follows player position (we let player drive anywhere on water)
    if(inBoat && ridingBoat){
      ridingBoat.x = (IZZA.api.player.x / TILE);
      ridingBoat.y = (IZZA.api.player.y / TILE);
    }
  });

  // ----- DRAW “under” (terrain, roads, docks, buildings, boats) -----
  IZZA.on('render-under', ()=>{
    const ctx = document.getElementById('game').getContext('2d');
    const S = IZZA.api.DRAW;

    function w2sX(wx){ return (wx-IZZA.api.camera.x) * (S/TILE); }
    function w2sY(wy){ return (wy-IZZA.api.camera.y) * (S/TILE); }
    function drawTile(gx,gy, color){
      const x=w2sX(gx*TILE), y=w2sY(gy*TILE);
      ctx.fillStyle=color; ctx.fillRect(x,y,S,S);
    }

    // water
    for(let gy=lake.y0; gy<=lake.y1; gy++){
      for(let gx=lake.x0; gx<=lake.x1; gx++){
        drawTile(gx,gy, '#1a4668');
      }
    }
    // beach
    for(let gy=beach.y0; gy<=beach.y1; gy++) drawTile(beach.x0, gy, '#e0c27b');

    // docks (wood)
    docks.forEach(d=>{
      for(let gx=d.x0; gx<=d.x1; gx++) for(let gy=d.y0; gy<=d.y1; gy++)
        drawTile(gx,gy, '#6b4a2f');
    });

    // hotel (blue)
    for(let gx=hotel.x0; gx<=hotel.x1; gx++) for(let gy=hotel.y0; gy<=hotel.y1; gy++)
      drawTile(gx,gy, '#284b7a');

    // neighborhood local roads (light sidewalks + dark road centers)
    // H roads
    hoodH.forEach(y=>{
      for(let gx=hoodArea.x0; gx<=hoodArea.x1; gx++) drawTile(gx, y, '#747d86'); // sidewalk row
      for(let gx=hoodArea.x0; gx<=hoodArea.x1; gx++) drawTile(gx, y+1, '#2b2b2b'); // road row
    });
    // V roads
    hoodV.forEach(x=>{
      for(let gy=hoodArea.y0; gy<=hoodArea.y1; gy++) drawTile(x, gy, '#747d86'); // sidewalk col
      for(let gy=hoodArea.y0; gy<=hoodArea.y1; gy++) drawTile(x+1, gy, '#2b2b2b'); // road col
    });

    // park (grass with simple path)
    for(let gx=park.x0; gx<=park.x1; gx++) for(let gy=park.y0; gy<=park.y1; gy++)
      drawTile(gx,gy, '#135c33');
    for(let gx=park.x0; gx<=park.x1; gx++) drawTile(gx, Math.floor((park.y0+park.y1)/2), '#7a6f53');

    // houses (dark green plots)
    houses.forEach(h=>{
      for(let gx=h.x0; gx<=h.x1; gx++) for(let gy=h.y0; gy<=h.y1; gy++)
        drawTile(gx,gy, '#175d2f');
    });

    // boats (under the player so they look like he stands IN them)
    function drawBoatAt(gx,gy){
      const x=w2sX(gx*TILE), y=w2sY(gy*TILE);
      ctx.fillStyle='#7ca7c7';
      ctx.fillRect(x+S*0.2, y+S*0.35, S*0.6, S*0.3);
    }
    boats.forEach(b=> drawBoatAt(b.x, b.y));
    dockBoats.forEach(b=>{ if(!b.taken) drawBoatAt(b.x, b.y); else drawBoatAt(b.x, b.y); });

    // wakeboarder (small teal square) trailing the towing boat
    if(towingBoat){
      const next = towingBoat.path[towingBoat.i];
      const vx = (next.x - towingBoat.x), vy = (next.y - towingBoat.y);
      const m = Math.hypot(vx,vy)||1;
      const wx = towingBoat.x - (vx/m)*WAKE_LEN;
      const wy = towingBoat.y - (vy/m)*WAKE_LEN;
      const px = w2sX(wx*TILE), py=w2sY(wy*TILE);
      ctx.fillStyle='#23d3c6';
      const S2 = IZZA.api.DRAW*0.35;
      ctx.fillRect(px+S*0.325, py+S*0.325, S2, S2);
    }
  });

  // ----- minimap overlay (after core draws it) -----
  IZZA.on('render-post', ()=>{
    const mini = document.getElementById('minimap');
    if(!mini) return;
    const mctx = mini.getContext('2d');
    const sx = mini.width/90, sy = mini.height/60;

    // water
    mctx.fillStyle='#1a4668';
    mctx.fillRect(lake.x0*sx, lake.y0*sy, (lake.x1-lake.x0+1)*sx, (lake.y1-lake.y0+1)*sy);
    // beach
    mctx.fillStyle='#e0c27b';
    mctx.fillRect(beach.x0*sx, beach.y0*sy, 1*sx, (beach.y1-beach.y0+1)*sy);
    // docks
    mctx.fillStyle='#6b4a2f';
    docks.forEach(d=> mctx.fillRect(d.x0*sx, d.y0*sy, (d.x1-d.x0+1)*sx, (d.y1-d.y0+1)*sy));
    // hotel
    mctx.fillStyle='#284b7a';
    mctx.fillRect(hotel.x0*sx, hotel.y0*sy, (hotel.x1-hotel.x0+1)*sx, (hotel.y1-hotel.y0+1)*sy);
    // neighborhood roads (light)
    mctx.fillStyle='#8a95a3';
    hoodH.forEach(y=> mctx.fillRect(hoodArea.x0*sx, y*sy, (hoodArea.x1-hoodArea.x0+1)*sx, sy*1.6));
    hoodV.forEach(x=> mctx.fillRect(x*sx, hoodArea.y0*sy, sx*1.6, (hoodArea.y1-hoodArea.y0+1)*sy));
    // park + houses
    mctx.fillStyle='#135c33';
    mctx.fillRect(park.x0*sx, park.y0*sy, (park.x1-park.x0+1)*sx, (park.y1-park.y0+1)*sy);
    mctx.fillStyle='#5f91a5';
    houses.forEach(h=> mctx.fillRect(h.x0*sx, h.y0*sy, (h.x1-h.x0+1)*sx, (h.y1-h.y0+1)*sy));
  });
})();
</script>
