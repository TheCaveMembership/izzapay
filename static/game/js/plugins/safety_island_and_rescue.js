// v1.1 — Island edge clamp + post-physics water guard (surgical, no other changes)
// Purpose:
//  - Prevent "one more step → fall under map" at island edges
//  - Do NOT change rendering or other game logic
//  - Runs as a last-line safety net after your existing physics

(function(){
  const TIER_KEY = 'izzaMapTier';
  const isTier2 = ()=> localStorage.getItem(TIER_KEY) === '2';

  // Minimal geometry mirrors (same math as expander/boat)
  function unlockedRect(t){ return (t!=='2') ? {x0:18,y0:18,x1:72,y1:42} : {x0:10,y0:12,x1:80,y1:50}; }
  function anchors(api){
    const tier = localStorage.getItem(TIER_KEY)||'1';
    return { un: unlockedRect(tier) };
  }
  function lakeRects(a){
    const LAKE  = { x0:a.un.x1-14, y0:a.un.y0+23, x1:a.un.x1, y1:a.un.y1 };
    const BEACH_X = LAKE.x0 - 1;
    return { LAKE, BEACH_X };
  }

  // City dock tiles (match boat plugin widened bands)
  function dockCells(){
    try{
      const api = IZZA.api; if(!api) return new Set();
      const {un} = anchors(api);
      const LAKE  = { x0: un.x1-14, y0: un.y0+23, x1: un.x1,   y1: un.y1 };
      const DOCKS = [ { x0: LAKE.x0, y: LAKE.y0+4, len:3 }, { x0: LAKE.x0, y: LAKE.y0+12, len:4 } ];
      const s=new Set();
      DOCKS.forEach(d=>{
        for(let i=0;i<d.len;i++){
          const gx=d.x0+i;
          s.add(gx+'|'+d.y); s.add(gx+'|'+(d.y-1)); s.add(gx+'|'+(d.y-2));
        }
      });
      return s;
    }catch{ return new Set(); }
  }

  // Water test that respects island land + docks (authoritative island from expander/mission)
  function tileIsWater(gx,gy){
    try{
      const api=IZZA.api; const {LAKE}=lakeRects(anchors(api));
      const inside = gx>=LAKE.x0 && gx<=LAKE.x1 && gy>=LAKE.y0 && gy<=LAKE.y1;
      if(!inside) return false;
      if (window._izzaIslandLand && window._izzaIslandLand.has(gx+'|'+gy)) return false; // island sand is land
      if (dockCells().has(gx+'|'+gy)) return false;                                      // city docks are walkable
      return true;
    }catch{ return false; }
  }

  function anyCornerInWater(p){
    try{
      const api=IZZA.api, t=api.TILE;
      const c = [
        {x:((p.x+1)/t)|0,  y:((p.y+1)/t)|0},
        {x:((p.x+31)/t)|0, y:((p.y+1)/t)|0},
        {x:((p.x+1)/t)|0,  y:((p.y+31)/t)|0},
        {x:((p.x+31)/t)|0, y:((p.y+31)/t)|0}
      ];
      return c.some(k => tileIsWater(k.x,k.y));
    }catch{ return false; }
  }

  // If we somehow end the frame overlapping lake water (not in boat), snap out safely.
  function rescueFromEdge(){
    if(!IZZA?.api?.ready || !isTier2()) return;
    if (window._izzaBoatActive) return; // ignore while boating

    const p = IZZA.api.player;
    if (!anyCornerInWater(p)) return;

    // Try one-tile step toward nearest island/beach tile
    const t = IZZA.api.TILE, gx=((p.x+16)/t|0), gy=((p.y+16)/t|0);
    const cand = [
      {x:gx+1,y:gy}, {x:gx-1,y:gy}, {x:gx,y:gy+1}, {x:gx,y:gy-1},
      {x:gx+1,y:gy+1}, {x:gx-1,y:gy-1}, {x:gx+1,y:gy-1}, {x:gx-1,y:gy+1}
    ];
    const ok = c => !tileIsWater(c.x,c.y);
    const to = cand.find(ok);
    if(to){
      p.x = to.x * t + 1;
      p.y = to.y * t + 1;
    }
  }

  // Run AFTER everyone else
  IZZA.on('update-post', rescueFromEdge);
})();
