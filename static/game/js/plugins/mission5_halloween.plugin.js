/* static/game/js/plugins/mission5_halloween.plugin.js
   IZZA Mission 5 — Jack-o’-Lantern (minimal, stable, 1× tile)
   • Shows ONLY when Mission 4 is complete (>=4 by any meta/LS check), Tier2 map.
   • Placement: HQ door +8E and −3N (north = up).
   • Drawn directly on canvas (no SVG/image) with inner glow + tiny jitter.
   • Press B on the tile to pick it up → +1 jack_o_lantern (stack) → hide.
   • Debug:
       localStorage.izzaM5Debug = '1'  -> HUD chip + pink dot
       localStorage.izzaForceM5 = '1'  -> ignore gates (tier/m4/taken)
       localStorage.removeItem('izzaM5Taken') -> respawn after pickup
*/
(function(){
  window.__M5_LOADED__ = true;

  if (!window.IZZA) window.IZZA = {};
  if (typeof IZZA.on !== 'function') IZZA.on = function(){};
  if (typeof IZZA.emit !== 'function') IZZA.emit = function(){};

  let api = null;
  const TAKEN_KEY = 'izzaM5Taken';

  // ---- robust Mission 4 completion checks ----
  function _lsGet(k,d){ try{ const v=localStorage.getItem(k); return v==null? d : v; }catch{ return d; } }
  function _missions(){ return parseInt(_lsGet('izzaMissions','0'),10) || 0; }
  function missionsCompletedMeta(){
    try{
      if (IZZA?.api?.inventory?.getMeta){
        const n = IZZA.api.inventory.getMeta('missionsCompleted')|0;
        if (Number.isFinite(n)) return n;
      }
    }catch{}
    return _missions();
  }
  function isMission4Done(){
    try{ if ((missionsCompletedMeta()|0) >= 4) return true; }catch{}
    try{ if ((_missions()|0) >= 4) return true; }catch{}
    try{ if (localStorage.getItem('izzaMission4_done') === '1') return true; }catch{}
    return false;
  }

  // ---- HQ door → jack tile (8E, 3N) ----
  function hqDoorGrid(){
    const t = api.TILE;
    const d = api.doorSpawn || { x: api.player?.x||0, y: api.player?.y||0 };
    return { gx: Math.round(d.x/t), gy: Math.round(d.y/t) };
  }
  function jackGrid(){
    const d = hqDoorGrid();
    return { x: d.gx + 8, y: d.gy - 3 };
  }

  // ---- world → screen (same offsets as M4) ----
  function worldToScreen(wx, wy){
    const S = api.DRAW, T = api.TILE;
    const sx = (wx - api.camera.x) * (S/T);
    const sy = (wy - api.camera.y) * (S/T);
    return { sx, sy };
  }

  // ---- debug HUD ----
  function ensureHudChip(text){
    if (localStorage.getItem('izzaM5Debug') !== '1') return;
    let el = document.getElementById('m5DebugChip');
    if (!el){
      el = document.createElement('div');
      el.id = 'm5DebugChip';
      el.style.cssText='position:fixed;left:10px;top:64px;z-index:9999;padding:4px 8px;border-radius:8px;background:#1a2340;color:#cfe0ff;border:1px solid #2a3550;font:12px/1.2 monospace';
      document.body.appendChild(el);
    }
    el.textContent = text;
  }

  // ---- draw 1× tile pumpkin (canvas; glow + jitter) ----
  function drawPumpkin(ctx, cx, cy){
    const t = api.TILE;
    const w = t;          // EXACTLY 1 tile wide
    const h = t;          // EXACTLY 1 tile tall
    const time = performance.now()/1000;
    const jitter = Math.sin(time*3.4)*1.2;   // tiny wobble (within tile)
    const pulse  = (Math.sin(time*2.1)+1)/2; // 0..1

    ctx.save();
    ctx.translate(cx + jitter, cy);
    ctx.scale(w/100, h/100);  // draw in 100×100 centered space

    // inner fire glow (pulses)
    const glowR = 50 + pulse*9;
    const g = ctx.createRadialGradient(0, 8, 6, 0, 8, glowR);
    g.addColorStop(0, `rgba(255,190,80,${0.42 + pulse*0.22})`);
    g.addColorStop(1, 'rgba(255,190,80,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 8, glowR, 0, Math.PI*2);
    ctx.fill();

    // base shadow (ground)
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.ellipse(0, 36, 22, 6, 0, 0, Math.PI*2);
    ctx.fill();
    ctx.globalAlpha = 1;

    // body
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#5a2a00';
    ctx.fillStyle = '#ff7b00';
    ctx.beginPath();
    for (let i=0;i<=32;i++){
      const th = i/32*Math.PI*2;
      const x = Math.cos(th)*34;
      const y = Math.sin(th)*28 + 8;
      if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
    }
    ctx.closePath(); ctx.fill(); ctx.stroke();

    // ribs
    ctx.globalAlpha = 0.25;
    ctx.beginPath(); ctx.moveTo(-22,-6); ctx.bezierCurveTo(-34,10,-34,22,-22,30); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-10,-8); ctx.bezierCurveTo(-16,10,-16,24,-10,32); ctx.stroke();
    ctx.beginPath(); ctx.moveTo( 10,-8); ctx.bezierCurveTo( 16,10, 16,24, 10,32); ctx.stroke();
    ctx.beginPath(); ctx.moveTo( 22,-6); ctx.bezierCurveTo( 34,10, 34,22, 22,30); ctx.stroke();
    ctx.globalAlpha = 1;

    // stem
    ctx.fillStyle = '#2f6b2a';
    ctx.strokeStyle = '#1c3e18';
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(-4,-16); ctx.lineTo(5,-16); ctx.lineTo(6,-4); ctx.lineTo(-6,-4); ctx.closePath();
    ctx.fill(); ctx.stroke();

    // face (lit)
    const eyeGlow = 0.85 + pulse*0.1;
    ctx.fillStyle = `rgba(255,220,120,${eyeGlow})`;
    // eyes
    ctx.beginPath(); ctx.moveTo(-16,-2); ctx.lineTo(-6,6); ctx.lineTo(-22,6); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo( 16,-2); ctx.lineTo( 6,6); ctx.lineTo( 22,6); ctx.closePath(); ctx.fill();
    // nose
    ctx.beginPath(); ctx.moveTo(-3,8); ctx.lineTo(3,8); ctx.lineTo(0,13); ctx.closePath(); ctx.fill();
    // mouth (jagged)
    ctx.beginPath();
    ctx.moveTo(-22,18);
    ctx.lineTo(-16,22); ctx.lineTo(-10,18); ctx.lineTo(-4,22);
    ctx.lineTo( 2,18);  ctx.lineTo( 8,22);  ctx.lineTo(14,18); ctx.lineTo(20,22);
    ctx.lineTo(20,24);  ctx.lineTo(-22,24);
    ctx.closePath(); ctx.fill();

    ctx.restore();
  }

  // ---- render-under ----
  function renderM5(){
    try{
      if (!api?.ready) return;

      const force = localStorage.getItem('izzaForceM5') === '1';
      const tier2 = localStorage.getItem('izzaMapTier') === '2';
      const m4done = isMission4Done();
      const taken = localStorage.getItem(TAKEN_KEY) === '1';

      ensureHudChip(`M5 ✓ loaded • tier2:${tier2} • m4:${m4done} • taken:${taken} • force:${force}`);

      if (!force){
        if (!tier2) return;
        if (!m4done) return;
        if (taken) return;
      }

      const S=api.DRAW, t=api.TILE, g=jackGrid();
      const cx=(g.x*t - api.camera.x)*(S/t) + S*0.5;
      const cy=(g.y*t - api.camera.y)*(S/t) + S*0.6;

      const ctx=document.getElementById('game')?.getContext('2d'); if(!ctx) return;

      if (localStorage.getItem('izzaM5Debug') === '1'){
        ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, 3.6, 0, Math.PI*2); ctx.fillStyle='#ff5599'; ctx.fill(); ctx.restore();
      }

      drawPumpkin(ctx, cx, cy);
    }catch{}
  }

  // ---- pick up with B (standing ON tile) ----
  function onB(e){
    try{
      if (!api?.ready) return;
      const force = localStorage.getItem('izzaForceM5') === '1';
      if (!force){
        if (localStorage.getItem('izzaMapTier') !== '2') return;
        if (!isMission4Done()) return;
        if (localStorage.getItem(TAKEN_KEY) === '1') return;
      }

      const t = api.TILE;
      const gx = ((api.player.x+16)/t|0), gy=((api.player.y+16)/t|0);
      const g  = jackGrid();

      if (gx === g.x && gy === g.y){
        e?.preventDefault?.(); e?.stopImmediatePropagation?.(); e?.stopPropagation?.();

        // add +1 jack_o_lantern (stack)
        let inv = {};
        try{
          if (IZZA?.api?.getInventory) inv = JSON.parse(JSON.stringify(IZZA.api.getInventory()||{}));
          else inv = JSON.parse(localStorage.getItem('izzaInventory')||'{}');
        }catch{}
        inv.jack_o_lantern = inv.jack_o_lantern || { count:0 };
        inv.jack_o_lantern.count = (inv.jack_o_lantern.count|0) + 1;
        try{
          if (IZZA?.api?.setInventory) IZZA.api.setInventory(inv);
          else localStorage.setItem('izzaInventory', JSON.stringify(inv));
          try{ window.dispatchEvent(new Event('izza-inventory-changed')); }catch{}
        }catch{}

        try{ localStorage.setItem(TAKEN_KEY, '1'); }catch{}
        IZZA.toast?.('Jack-o’-Lantern added to Inventory');
      }
    }catch{}
  }

  // ---- wiring ----
  try { IZZA.on('render-under', renderM5); } catch {}
  IZZA.on?.('ready', (a)=>{
    api = a;
    IZZA.on?.('render-under', renderM5);
    document.getElementById('btnB')?.addEventListener('click', onB, true);
    window.addEventListener('keydown', e=>{ if((e.key||'').toLowerCase()==='b') onB(e); }, true);
  });

  // Nudge re-render if inventory/meta flips
  window.addEventListener('izza-inventory-changed', ()=>{ try{ IZZA.emit?.('render-under'); }catch{} });

})();
