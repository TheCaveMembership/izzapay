/* mission5_halloween.plugin.js — Minimal
   Goal: ONLY show a 1-tile jack-o’-lantern when Mission 4 is complete.
   - M4 complete if ANY is true:
       • inventory meta missionsCompleted >= 4
       • localStorage izzaMissions >= 4
       • localStorage izzaMission4_done === '1' (set by M4 file)
   - Placement: EXACTLY one tile west of the M4 cardboard box.
     Box: {gx+3, gy+10} → Jack: {gx+2, gy+10}
   - Draw style/offsets match Mission 4 box (+S*0.5, +S*0.6).
*/
(function(){
  if (!window.IZZA) window.IZZA = {};
  if (typeof IZZA.on !== 'function') IZZA.on = function(){};
  if (typeof IZZA.emit !== 'function') IZZA.emit = function(){};

  let api = null;
  let TILE = 60;

  // ---------- Helpers ----------
  function _lsGet(k, d){ try{ const v = localStorage.getItem(k); return v==null? d : v; }catch{ return d; } }
  function _missions(){ return parseInt(_lsGet('izzaMissions', '0'), 10) || 0; }

  function missionsCompletedMeta(){
    try{
      if (IZZA?.api?.inventory?.getMeta){
        const m = IZZA.api.inventory.getMeta('missionsCompleted');
        const n = (m|0);
        if (Number.isFinite(n)) return n;
      }
    }catch{}
    return _missions();
  }

  function isM4Complete(){
    try { if ((missionsCompletedMeta()|0) >= 4) return true; }catch{}
    try { if ((_missions()|0) >= 4) return true; }catch{}
    try { if (localStorage.getItem('izzaMission4_done') === '1') return true; }catch{}
    return false;
  }

  // ---------- Positioning (MATCH Mission 4 logic) ----------
  function hqDoorGrid(){
    const t = api?.TILE || TILE;
    const d = api?.doorSpawn || { x: api?.player?.x||0, y: api?.player?.y||0 };
    return { gx: Math.round(d.x/t), gy: Math.round(d.y/t) };
  }
  // Box: {gx+3, gy+10} → Jack one tile WEST: {gx+2, gy+10}
  function jackGrid(){
    const d = hqDoorGrid();
    return { x: d.gx + 2, y: d.gy + 10 };
  }

  // ---------- Screen math (MATCH M4) ----------
  function worldToScreen(wx, wy){
    const S = api?.DRAW || TILE, T = api?.TILE || TILE;
    const sx = (wx - (api?.camera?.x||0)) * (S/T);
    const sy = (wy - (api?.camera?.y||0)) * (S/T);
    return { sx, sy };
  }

  // ---------- Simple SVG -> Image (iOS-safe) ----------
  const _imgCache = new Map();
  function svgToImage(svg, pxW, pxH){
    const key=svg+'|'+pxW+'x'+pxH;
    if(_imgCache.has(key)) return _imgCache.get(key);
    const url='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg);
    const img=new Image(); img.width=pxW; img.height=pxH;
    img._ready=false; img.onload=()=>{ img._ready=true; try{ img.decode?.(); }catch{} };
    img.src=url;
    _imgCache.set(key, img);
    return img;
  }

  // ---------- Simple jack art (1 tile) ----------
  function svgJack(){
    return `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <radialGradient id="g" cx="50%" cy="50%" r="60%">
      <stop offset="0%" stop-color="#ffb347"/>
      <stop offset="60%" stop-color="#ff7b00"/>
      <stop offset="100%" stop-color="#7a2f00"/>
    </radialGradient>
  </defs>
  <ellipse cx="32" cy="36" rx="24" ry="20" fill="url(#g)" stroke="#552200" stroke-width="3"/>
  <rect x="29" y="14" width="6" height="8" rx="2" fill="#2c5e22"/>
  <polygon points="22,28 28,32 16,32" fill="#ffd23f"/>
  <polygon points="42,28 48,32 36,32" fill="#ffd23f"/>
  <path d="M18 44 Q32 52 46 44 Q42 46 32 48 Q22 46 18 44 Z" fill="#ffd23f"/>
</svg>`;
  }

  let jackImg = null;

  // ---------- Render ----------
  function renderUnder(){
    try{
      if (!api?.ready) return;
      // Match M4 visibility gate
      if (localStorage.getItem('izzaMapTier') !== '2') return;
      if (!isM4Complete()) return;

      const ctx=document.getElementById('game')?.getContext('2d'); if(!ctx) return;
      const S=api.DRAW, t=api.TILE||TILE;

      // lazy-create image
      if (!jackImg) jackImg = svgToImage(svgJack(), t*1.0, t*1.0);

      const g = jackGrid();
      const wx = g.x * t, wy = g.y * t;
      const scr = worldToScreen(wx, wy);

      // EXACT same offsets as the cardboard box draw: +S*0.5, +S*0.6
      const sx = scr.sx + S*0.5;
      const sy = scr.sy + S*0.6;

      const w = (t*1.0)*(S/t), h = w; // 1× tile
      try{ ctx.drawImage(jackImg, sx - w/2, sy - h/2, w, h); }catch{}
    }catch{}
  }

  // ---------- Wire up ----------
  IZZA.on('ready', ({ api:__api })=>{
    api = __api||api||{};
    TILE = api?.TILE || TILE;
    IZZA.on('render-under', renderUnder);
  });

  // Also paint if the game resumes and the art didn't render yet
  IZZA.on?.('resume', ()=>{ /* no-op; renderUnder will run each frame */ });

})();
