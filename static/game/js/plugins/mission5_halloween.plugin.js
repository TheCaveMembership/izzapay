/* mission5_halloween.plugin.js — PHASE 2 (big jack, 1-tile footprint)
   - Shows a JACK-O’-LANTERN when Mission 4 is complete.
   - Placement: HQ DOOR +8E, +3N  (east positive, north is negative Y => gy-3)
   - Visual size: **3× the cardboard box** but stays centered on the same 1 tile.
   - Press **B** ON that tile to pick up (adds `jack_o_lantern` to inventory, stacked).
   - Simple animated glow + flicker + slight jiggle. iPhone safe.
   - Debug:
       localStorage.izzaM5Debug = '1'  -> tiny HUD + pink marker dot
       localStorage.izzaForceM5 = '1'  -> draw even if tier/meta say otherwise
       (to respawn after pickup: localStorage.removeItem('izzaJackTaken'))
*/
(function(){
  // mark as loaded (handy for quick checks)
  window.__M5_LOADED__ = true;

  if (!window.IZZA) window.IZZA = {};
  if (typeof IZZA.on !== 'function') IZZA.on = function(){};
  if (typeof IZZA.emit !== 'function') IZZA.emit = function(){};

  let api = null;

  const JACK_TAKEN_KEY = 'izzaJackTaken';

  // ---------- robust Mission 4 completion checks ----------
  function _lsGet(k, d){ try{ const v=localStorage.getItem(k); return v==null? d : v; }catch{ return d; } }
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

  // ---------- grid helpers ----------
  function hqDoorGrid(){
    const t = api.TILE;
    const d = api.doorSpawn || { x: api.player?.x||0, y: api.player?.y||0 };
    return { gx: Math.round(d.x/t), gy: Math.round(d.y/t) };
  }
  // Placement: +8E, +3N (north is gy - 3)
  function jackGrid(){
    const d = hqDoorGrid();
    return { x: d.gx + 8, y: d.gy - 3 };
  }

  // ---------- world→screen (same math as M4) ----------
  function worldToScreen(wx, wy){
    const S = api.DRAW, T = api.TILE;
    const sx = (wx - api.camera.x) * (S/T);
    const sy = (wy - api.camera.y) * (S/T);
    return { sx, sy };
  }

  // ---------- tiny HUD chip + marker (toggle with izzaM5Debug='1') ----------
  function ensureHudChip(text){
    if (localStorage.getItem('izzaM5Debug') !== '1') return;
    let el = document.getElementById('m5DebugChip');
    if (!el){
      el = document.createElement('div');
      el.id = 'm5DebugChip';
      el.style.cssText = 'position:fixed;left:10px;top:64px;z-index:9999;padding:4px 8px;border-radius:8px;' +
                         'background:#1a2340;color:#cfe0ff;border:1px solid #2a3550;font:12px/1.2 monospace';
      document.body.appendChild(el);
    }
    el.textContent = text;
  }

  // ---------- jack art (simple SVG, cached) ----------
  const _imgCache = new Map();
  function svgToImage(svg, pxW, pxH){
    const key = svg+'|'+pxW+'x'+pxH;
    if (_imgCache.has(key)) return _imgCache.get(key);
    const url='data:image/svg+xml;utf8,'+encodeURIComponent(svg);
    const img=new Image(); img.width=pxW; img.height=pxH; img.src=url;
    _imgCache.set(key, img);
    return img;
  }
  function svgJack(){
    // simple shape with inner “fire” gradient; no heavy filters
    return `
<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
 <defs>
  <radialGradient id="g" cx="50%" cy="50%" r="60%">
    <stop offset="0%" stop-color="#ffd88a"/>
    <stop offset="55%" stop-color="#ff9c2a"/>
    <stop offset="100%" stop-color="#7a2f00"/>
  </radialGradient>
  <linearGradient id="stem" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#3b7a2a"/><stop offset="100%" stop-color="#1f4419"/>
  </linearGradient>
 </defs>
 <ellipse cx="100" cy="110" rx="78" ry="70" fill="url(#g)" stroke="#552200" stroke-width="6"/>
 <rect x="92" y="30" width="16" height="28" rx="6" fill="url(#stem)"/>
 <!-- simple face cuts -->
 <polygon points="60,90 85,110 35,110" fill="#1b0f00"/>
 <polygon points="140,90 165,110 115,110" fill="#1b0f00"/>
 <path d="M45 140 Q100 172 155 140 Q140 150 100 155 Q60 150 45 140 Z" fill="#1b0f00"/>
</svg>`;
  }
  let jackImg = null; // created lazily

  // ---------- draw jack (BIG: 3× tile) ----------
  function drawJack(ctx, sx, sy, S, flicker){
    if (!jackImg) jackImg = svgToImage(svgJack(), api.TILE*3, api.TILE*3);
    if (!jackImg.complete) return;

    // jiggle a few pixels; glow strength flickers slightly
    const jig = Math.sin(performance.now()*0.007) * (S*0.01);   // ~1% of S
    const glow = 0.17 + 0.06*Math.sin(performance.now()*0.018 + flicker);

    const w = (api.TILE*3) * (S/api.TILE); // **3× tile size**, still centered
    const h = w;

    // soft glow ring behind
    ctx.save();
    const grd = ctx.createRadialGradient(sx, sy, w*0.05, sx, sy, w*0.55);
    grd.addColorStop(0, `rgba(255,175,64,${0.35+glow})`);
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = grd;
    ctx.beginPath(); ctx.arc(sx, sy, w*0.55, 0, Math.PI*2); ctx.fill();
    ctx.restore();

    // the pumpkin itself
    ctx.drawImage(jackImg, sx - w/2 + jig, sy - h/2 - jig*0.6, w, h);

    // tiny inner flicker dot
    ctx.save();
    ctx.globalAlpha = 0.55 + 0.35*Math.sin(performance.now()*0.02 + flicker);
    ctx.fillStyle = '#ffd34d';
    ctx.beginPath(); ctx.arc(sx, sy + h*0.02, Math.max(2, w*0.02), 0, Math.PI*2); ctx.fill();
    ctx.restore();
  }

  // ---------- render-under ----------
  function renderM5(){
    try{
      if (!api?.ready) return;

      const force = localStorage.getItem('izzaForceM5') === '1';
      const tier2 = localStorage.getItem('izzaMapTier') === '2';
      const m4done = isMission4Done();
      const taken = localStorage.getItem(JACK_TAKEN_KEY) === '1';

      ensureHudChip(`M5 ✓ • tier2:${tier2} • m4:${m4done} • taken:${taken} • force:${force}`);

      if (!force){
        if (!tier2) return;
        if (!m4done) return;
        if (taken) return;
      }

      const S=api.DRAW, t=api.TILE, g=jackGrid();
      // same “center offsets” used by M4 box: +S*0.5, +S*0.6
      const sx=(g.x*t - api.camera.x)*(S/t) + S*0.5;
      const sy=(g.y*t - api.camera.y)*(S/t) + S*0.6;

      const ctx=document.getElementById('game')?.getContext('2d'); if(!ctx) return;

      if (localStorage.getItem('izzaM5Debug') === '1'){
        ctx.save();
        ctx.beginPath(); ctx.arc(sx, sy, 4, 0, Math.PI*2); ctx.fillStyle='#ff5599'; ctx.fill(); ctx.restore();
      }

      drawJack(ctx, sx, sy, S, (g.x*37 + g.y*19) % Math.PI);
    }catch{}
  }

  // ---------- B: pick up jack when standing exactly on its tile (1-tile footprint) ----------
  function onB(e){
    try{
      if (!api?.ready) return;
      const force = localStorage.getItem('izzaForceM5') === '1';
      if (!force){
        if (localStorage.getItem('izzaMapTier') !== '2') return;
        if (!isMission4Done()) return;
        if (localStorage.getItem(JACK_TAKEN_KEY) === '1') return;
      }

      const t = api.TILE;
      const gx = ((api.player.x+16)/t|0), gy=((api.player.y+16)/t|0);
      const g  = jackGrid();

      // **Important**: pickup is by tile equality, not visual size.
      if (gx === g.x && gy === g.y){
        e?.preventDefault?.(); e?.stopImmediatePropagation?.(); e?.stopPropagation?.();

        // lightweight, custom confirm
        if (!window.confirm('Take the jack-o’-lantern?')) return;

        // +1 jack_o_lantern (stack)
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

        try{ localStorage.setItem(JACK_TAKEN_KEY, '1'); }catch{}
        IZZA.toast?.('Jack-o’-Lantern added to Inventory');
      }
    }catch{}
  }

  // ---------- wire up ----------
  try { IZZA.on('render-under', renderM5); } catch {}
  IZZA.on?.('ready', (a)=>{
    api = a;
    IZZA.on?.('render-under', renderM5);
    document.getElementById('btnB')?.addEventListener('click', onB, true);
    window.addEventListener('keydown', e=>{ if((e.key||'').toLowerCase()==='b') onB(e); }, true);
  });

  // Re-render if inventory/meta flips
  window.addEventListener('izza-inventory-changed', ()=>{ try{ IZZA.emit?.('render-under'); }catch{} });

})();
