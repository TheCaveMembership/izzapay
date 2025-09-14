/* mission5_halloween.plugin.js — “Show a pumpkin exactly like M4’s box”
   - Draws a pumpkin near HQ using the EXACT SAME placement & canvas math as Mission 4’s box
   - Box is at {gx+3, gy+10}; this draws at ONE TILE WEST: {gx+2, gy+10}
   - Same render-under hook, same +S*0.5 / +S*0.6 screen offsets, same izzaMapTier=='2' gate
   - No inputs, missions, inventory, or UI. Pure visual to verify placement.
*/

(function(){
  let api = null;

  // ---------- HQ door → pumpkin position (copied from M4 with x-1) ----------
  function hqDoorGrid(){
    const t = api.TILE;
    const d = api.doorSpawn || { x: api.player?.x||0, y: api.player?.y||0 };
    return { gx: Math.round(d.x/t), gy: Math.round(d.y/t) };
  }
  // M4 box: {gx+3, gy+10}. Pumpkin: one tile WEST → {gx+2, gy+10}.
  function pumpkinGrid(){
    const d = hqDoorGrid();
    return { x: d.gx + 2, y: d.gy + 10 };
  }

  // ---------- world→screen (identical to M4) ----------
  function worldToScreen(wx, wy){
    const S = api.DRAW, T = api.TILE;
    const sx = (wx - api.camera.x) * (S/T);
    const sy = (wy - api.camera.y) * (S/T);
    return { sx, sy };
  }

  // ---------- draw: simple 3D-ish pumpkin (same scale as box draw) ----------
  function drawPumpkin(ctx, sx, sy, S){
    // Match M4’s sizing approach: scale artwork relative to tile using S*0.68
    // We’ll draw in a 44x44 local space like the box function does.
    ctx.save();
    ctx.translate(sx, sy);
    ctx.scale((S*0.68)/44, (S*0.68)/44);
    ctx.translate(-22, -22);

    // shadow (match box’s ellipse)
    ctx.fillStyle='rgba(0,0,0,0.18)';
    ctx.beginPath();
    ctx.ellipse(22, 28, 14, 6, 0, 0, Math.PI*2);
    ctx.fill();

    // pumpkin body (simple segments)
    const body = new Path2D();
    // center oval
    body.addPath(new Path2D('M6,22 C6,12 38,12 38,22 C38,34 6,34 6,22 Z'));
    ctx.fillStyle='#ff8a00';
    ctx.fill(body);
    ctx.strokeStyle='#7a3d00';
    ctx.lineWidth=1.3;
    ctx.stroke(body);

    // side segments
    ctx.beginPath();
    ctx.moveTo(14,16); ctx.bezierCurveTo(10,22,10,26,14,32);
    ctx.moveTo(30,16); ctx.bezierCurveTo(34,22,34,26,30,32);
    ctx.strokeStyle='#a45200';
    ctx.stroke();

    // stem
    ctx.fillStyle='#2c5e22';
    ctx.beginPath();
    ctx.roundRect(20, 12, 4, 6, 2);
    ctx.fill();

    // face (triangle eyes + smile)
    ctx.fillStyle='#ffd23f';
    ctx.beginPath(); ctx.moveTo(14,20); ctx.lineTo(18,22); ctx.lineTo(10,22); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(30,20); ctx.lineTo(34,22); ctx.lineTo(26,22); ctx.closePath(); ctx.fill();

    ctx.beginPath();
    ctx.moveTo(12,28);
    ctx.quadraticCurveTo(22,32,32,28);
    ctx.quadraticCurveTo(22,30,12,28);
    ctx.fill();

    ctx.restore();
  }

  // ---------- render-under: show pumpkin (copied structure from M4) ----------
  function renderPumpkin(){
    try{
      if (!api?.ready) return;
      if (localStorage.getItem('izzaMapTier') !== '2') return;

      const S=api.DRAW, t=api.TILE, g=pumpkinGrid();
      const px=(g.x*t - api.camera.x)*(S/t) + S*0.5;  // EXACT offsets like M4 box
      const py=(g.y*t - api.camera.y)*(S/t) + S*0.6;
      const ctx=document.getElementById('game')?.getContext('2d'); if(!ctx) return;
      drawPumpkin(ctx, px, py, S);
    }catch{}
  }

  // ---------- hook up (same lifecycle as M4) ----------
  IZZA.on?.('ready', (a)=>{
    api = a;
    IZZA.on?.('render-under', renderPumpkin);
  });

})();
