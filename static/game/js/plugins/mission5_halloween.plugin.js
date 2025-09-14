/* mission5_halloween.plugin.js — Minimal placement-only
   GOAL: If Mission 4 is completed, draw the SAME cardboard box art
   ONE TILE EAST of the M4 box. Nothing else.
   - M4 box:  door +3E, +10S
   - M5 box:  door +4E, +10S   (one tile east)
*/
(function(){
  // Loader flag to verify the script is present
  window.__M5_LOADED__ = true;
  try { console.log('[M5] Minimal placement file loaded'); } catch {}

  if (!window.IZZA) window.IZZA = {};
  if (typeof IZZA.on !== 'function') IZZA.on = function(){};
  if (typeof IZZA.emit !== 'function') IZZA.emit = function(){};

  let api = null;

  // ---------- Read missionsCompleted robustly ----------
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
  function isMission4Done(){
    try { if ((missionsCompletedMeta()|0) >= 4) return true; }catch{}
    try { if ((_missions()|0) >= 4) return true; }catch{}
    try { if (localStorage.getItem('izzaMission4_done') === '1') return true; }catch{}
    return false;
  }

  // ---------- HQ door grid (exactly like M4) ----------
  function hqDoorGrid(){
    const t = api.TILE;
    const d = api.doorSpawn || { x: api.player?.x||0, y: api.player?.y||0 };
    return { gx: Math.round(d.x/t), gy: Math.round(d.y/t) };
  }
  // M4: {gx+3, gy+10}; M5 (east of that): {gx+4, gy+10}
  function m5BoxGrid(){
    const d = hqDoorGrid();
    return { x: d.gx + 4, y: d.gy + 10 };
  }

  // ---------- camera/world helpers (same style as M4) ----------
  function worldToScreen(wx, wy){
    const S = api.DRAW, T = api.TILE;
    const sx = (wx - api.camera.x) * (S/T);
    const sy = (wy - api.camera.y) * (S/T);
    return { sx, sy };
  }

  // ---------- draw: exact same 3D-looking box art as M4 ----------
  function draw3DBox(ctx, sx, sy, S){
    ctx.save();
    ctx.translate(sx, sy);
    ctx.scale((S*0.68)/44, (S*0.68)/44);
    ctx.translate(-22, -22);
    ctx.fillStyle='rgba(0,0,0,0.18)'; ctx.beginPath(); ctx.ellipse(22,28,14,6,0,0,Math.PI*2); ctx.fill();
    const body = new Path2D('M6,18 L22,10 L38,18 L38,34 L22,42 L6,34 Z');
    ctx.fillStyle='#b98c4a'; ctx.fill(body);
    ctx.strokeStyle='#7d5f2e'; ctx.lineWidth=1.3; ctx.stroke(body);
    const flapL = new Path2D('M6,18 L22,26 L22,10 Z');
    const flapR = new Path2D('M38,18 L22,26 L22,10 Z');
    ctx.fillStyle='#cfa162'; ctx.fill(flapL); ctx.fill(flapR); ctx.stroke(flapL); ctx.stroke(flapR);
    ctx.fillStyle='#e9dfb1'; ctx.fillRect(21,10,2,16);
    ctx.restore();
  }

  // ---------- render-under: show box whenever M4 is done ----------
  function renderM5Box(){
    try{
      if (!api?.ready) return;
      if (localStorage.getItem('izzaMapTier') !== '2') return;   // same Tier 2 gate as M4
      if (!isMission4Done()) return;                             // <-- only condition

      const S = api.DRAW, t = api.TILE, b = m5BoxGrid();
      const bx = (b.x*t - api.camera.x)*(S/t) + S*0.5;           // exact M4 centering
      const by = (b.y*t - api.camera.y)*(S/t) + S*0.6;
      const ctx = document.getElementById('game')?.getContext('2d'); if(!ctx) return;
      draw3DBox(ctx, bx, by, S);
    }catch{}
  }

  // ---------- wire up ----------
  IZZA.on?.('ready', (a)=>{
    api = a;
    IZZA.on?.('render-under', renderM5Box);
  });

  // Also draw if inventory meta flips after load
  window.addEventListener('izza-inventory-changed', ()=>{ try{ IZZA.emit?.('render-under'); }catch{} });

})();
