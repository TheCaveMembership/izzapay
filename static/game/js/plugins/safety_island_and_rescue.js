// safety_island_and_rescue.js
// - Invisible collision border around island (prevents falling off edges)
// - Rescue if player ends up in invalid water
// - Dock/embark at island only when within 1 tile of perimeter

(function(){
  const RESCUE_KEY = 'izzaRescueLast'; // timestamp throttle
  let api = null;

  // ---- build island border cells ----
  function computeIslandBorder(){
    const ISLAND = window.__IZZA_ARMOURY__?.island;
    if (!ISLAND) return new Set();

    const set = new Set();
    for (let y=ISLAND.y0-1; y<=ISLAND.y1+1; y++){
      set.add((ISLAND.x0-1)+'|'+y);
      set.add((ISLAND.x1+1)+'|'+y);
    }
    for (let x=ISLAND.x0-1; x<=ISLAND.x1+1; x++){
      set.add(x+'|'+(ISLAND.y0-1));
      set.add(x+'|'+(ISLAND.y1+1));
    }
    return set;
  }

  // ---- mark border each frame ----
  function publishBorder(){
    if (localStorage.getItem('izzaMapTier')!=='2'){ window._izzaIslandBorder=null; return; }
    window._izzaIslandBorder = computeIslandBorder();
  }

  // ---- rescue logic ----
  function rescueIfNeeded(){
    if (!api?.ready) return;
    const gx=((api.player.x+16)/api.TILE|0);
    const gy=((api.player.y+16)/api.TILE|0);

    const ISLAND = window.__IZZA_ARMOURY__?.island;
    if (!ISLAND) return;

    const inside = gx>=ISLAND.x0 && gx<=ISLAND.x1 && gy>=ISLAND.y0 && gy<=ISLAND.y1;
    const border = window._izzaIslandBorder;
    if (inside || (border && border.has(gx+'|'+gy))) return;

    // player slipped into bad water → rescue to island sand
    const now = Date.now();
    const last = +(localStorage.getItem(RESCUE_KEY)||0);
    if (now - last < 2000) return; // throttle

    localStorage.setItem(RESCUE_KEY, now.toString());
    const midX = (ISLAND.x0+ISLAND.x1)>>1;
    const midY = (ISLAND.y0+ISLAND.y1)>>1;
    api.player.x = midX*api.TILE;
    api.player.y = midY*api.TILE;
    IZZA.toast?.("You were rescued back onto the island!");
  }

  // ---- override boat docking radius ----
  function nearestDockPair(gx,gy){
    const ISLAND = window.__IZZA_ARMOURY__?.island;
    const RAW    = window.__IZZA_ISLAND_DOCK__;
    if (!ISLAND || !RAW) return null;

    const toArr = v => Array.isArray(v)?v:[v];
    const waters = toArr(RAW.water);
    const sands  = toArr(RAW.sand);

    // within 1 tile only
    for (const w of waters){
      if (Math.abs(gx-w.x)+Math.abs(gy-w.y) <= 1){
        const sx = (w.x>ISLAND.x1?ISLAND.x1:w.x<ISLAND.x0?ISLAND.x0:w.x);
        const sy = (w.y>ISLAND.y1?ISLAND.y1:w.y<ISLAND.y0?ISLAND.y0:w.y);
        return { water:w, sand:{x:sx,y:sy} };
      }
    }
    for (const s of sands){
      if (Math.abs(gx-s.x)+Math.abs(gy-s.y) <= 1){
        const wx = (s.x===ISLAND.x0? s.x-1 : (s.x===ISLAND.x1? s.x+1 : s.x));
        const wy = (s.y===ISLAND.y0? s.y-1 : (s.y===ISLAND.y1? s.y+1 : s.y));
        return { water:{x:wx,y:wy}, sand:s };
      }
    }
    return null;
  }
  window._izzaNearestDockPair = nearestDockPair;

  // ---- hooks ----
  IZZA.on('ready', a=>{
    api=a;
    publishBorder();
    IZZA.on('update-pre', ()=>{
      publishBorder();
      rescueIfNeeded();
    });
  });

})();
