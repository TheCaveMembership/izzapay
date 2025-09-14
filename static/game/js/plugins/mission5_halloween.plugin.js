/* static/game/js/plugins/mission5_halloween.plugin.js
   IZZA Mission 5 — Jack-o’-Lantern (1× tile, full size, glow+jitter)
   • Placement: HQ door +8E, +3N
   • Shows when Mission 4 complete (or force flag).
   • Press B on tile → adds jack_o_lantern to inventory.
*/
(function(){
  window.__M5_LOADED__ = true;
  if (!window.IZZA) window.IZZA = {};
  if (typeof IZZA.on !== 'function') IZZA.on = function(){}; 
  if (typeof IZZA.emit !== 'function') IZZA.emit = function(){};

  let api = null;
  const TAKEN_KEY = 'izzaM5Taken';

  function _lsGet(k,d){ try{ const v=localStorage.getItem(k); return v==null? d : v; }catch{ return d; } }
  function _missions(){ return parseInt(_lsGet('izzaMissions','0'),10) || 0; }
  function missionsCompletedMeta(){
    try{ if (IZZA?.api?.inventory?.getMeta){ 
      const n = IZZA.api.inventory.getMeta('missionsCompleted')|0; 
      if (Number.isFinite(n)) return n; 
    }}catch{} 
    return _missions();
  }
  function isMission4Done(){
    return (missionsCompletedMeta() >= 4) || (_missions() >= 4) || (localStorage.getItem('izzaMission4_done')==='1');
  }

  function hqDoorGrid(){
    const t=api.TILE;
    const d=api.doorSpawn || {x:api.player?.x||0,y:api.player?.y||0};
    return {gx:Math.round(d.x/t), gy:Math.round(d.y/t)};
  }
  function jackGrid(){ const d=hqDoorGrid(); return {x:d.gx+8, y:d.gy-3}; }

  function worldToScreen(wx,wy){
    const S=api.DRAW, T=api.TILE;
    return { sx:(wx-api.camera.x)*(S/T), sy:(wy-api.camera.y)*(S/T) };
  }

  function drawPumpkin(ctx,cx,cy){
    const t=api.TILE;
    const time=performance.now()/1000;
    const jitter=Math.sin(time*3.4)*1.5;
    const pulse=(Math.sin(time*2.1)+1)/2;

    ctx.save();
    ctx.translate(cx+jitter, cy);
    ctx.scale(t/100, t/100); // now entire tile

    // glow
    const g=ctx.createRadialGradient(0,8,6,0,8,55);
    g.addColorStop(0,`rgba(255,190,80,${0.5+pulse*0.3})`);
    g.addColorStop(1,'rgba(255,190,80,0)');
    ctx.fillStyle=g;
    ctx.beginPath(); ctx.arc(0,8,55,0,Math.PI*2); ctx.fill();

    // body
    ctx.lineWidth=4;
    ctx.strokeStyle='#5a2a00';
    ctx.fillStyle='#ff7b00';
    ctx.beginPath();
    ctx.ellipse(0,8,40,32,0,0,Math.PI*2);
    ctx.fill(); ctx.stroke();

    // stem
    ctx.fillStyle='#2f6b2a'; ctx.strokeStyle='#1c3e18'; ctx.lineWidth=3;
    ctx.beginPath(); ctx.rect(-6,-18,12,12); ctx.fill(); ctx.stroke();

    // face
    ctx.fillStyle=`rgba(255,220,120,${0.8+pulse*0.2})`;
    // eyes
    ctx.beginPath(); ctx.moveTo(-16,-2); ctx.lineTo(-6,6); ctx.lineTo(-22,6); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(16,-2); ctx.lineTo(6,6); ctx.lineTo(22,6); ctx.closePath(); ctx.fill();
    // nose
    ctx.beginPath(); ctx.moveTo(-3,8); ctx.lineTo(3,8); ctx.lineTo(0,13); ctx.closePath(); ctx.fill();
    // mouth
    ctx.beginPath();
    ctx.moveTo(-22,18); ctx.lineTo(-16,22); ctx.lineTo(-10,18); ctx.lineTo(-4,22);
    ctx.lineTo(2,18); ctx.lineTo(8,22); ctx.lineTo(14,18); ctx.lineTo(20,22);
    ctx.lineTo(20,24); ctx.lineTo(-22,24); ctx.closePath(); ctx.fill();

    ctx.restore();
  }

  function renderM5(){
    try{
      if (!api?.ready) return;
      const force=localStorage.getItem('izzaForceM5')==='1';
      if (!force){
        if (localStorage.getItem('izzaMapTier')!=='2') return;
        if (!isMission4Done()) return;
        if (localStorage.getItem(TAKEN_KEY)==='1') return;
      }
      const S=api.DRAW,t=api.TILE,g=jackGrid();
      const cx=(g.x*t-api.camera.x)*(S/t)+S*0.5;
      const cy=(g.y*t-api.camera.y)*(S/t)+S*0.6;
      const ctx=document.getElementById('game')?.getContext('2d'); if(!ctx) return;
      drawPumpkin(ctx,cx,cy);
    }catch{}
  }

  function onB(e){
    try{
      if (!api?.ready) return;
      const force=localStorage.getItem('izzaForceM5')==='1';
      if (!force){
        if (localStorage.getItem('izzaMapTier')!=='2') return;
        if (!isMission4Done()) return;
        if (localStorage.getItem(TAKEN_KEY)==='1') return;
      }
      const t=api.TILE;
      const gx=((api.player.x+16)/t|0), gy=((api.player.y+16)/t|0);
      const g=jackGrid();
      if (gx===g.x && gy===g.y){
        e?.preventDefault?.(); e?.stopImmediatePropagation?.(); e?.stopPropagation?.();
        let inv={}; try{
          if (IZZA?.api?.getInventory) inv=JSON.parse(JSON.stringify(IZZA.api.getInventory()||{}));
          else inv=JSON.parse(localStorage.getItem('izzaInventory')||'{}');
        }catch{}
        inv.jack_o_lantern=inv.jack_o_lantern||{count:0};
        inv.jack_o_lantern.count=(inv.jack_o_lantern.count|0)+1;
        try{
          if (IZZA?.api?.setInventory) IZZA.api.setInventory(inv);
          else localStorage.setItem('izzaInventory', JSON.stringify(inv));
          try{ window.dispatchEvent(new Event('izza-inventory-changed')); }catch{}
        }catch{}
        try{ localStorage.setItem(TAKEN_KEY,'1'); }catch{}
        IZZA.toast?.('Jack-o’-Lantern added to Inventory');
      }
    }catch{}
  }

  IZZA.on?.('ready',(a)=>{ api=a; IZZA.on?.('render-under',renderM5);
    document.getElementById('btnB')?.addEventListener('click',onB,true);
    window.addEventListener('keydown',e=>{ if((e.key||'').toLowerCase()==='b') onB(e);},true);
  });
  try{ IZZA.on('render-under',renderM5); }catch{}
})();
