/* mission5_halloween.plugin.js — PHASE 2
   - Draw a JACK-O’-LANTERN (1 tile) one tile EAST of the Mission 4 box:
       M4 box: door +3E, +10S
       M5 jack: door +4E, +10S
   - Shows whenever Mission 4 is complete.
   - Press B ON the jack to pick it up (adds `jack_o_lantern` to inventory) and hides it.
   - No night mission logic yet.
   - iPhone-friendly debug:
       localStorage.izzaM5Debug = '1'  -> tiny HUD + pink marker dot
       localStorage.izzaForceM5 = '1'  -> draw even if tier/meta say otherwise
       (to respawn after pickup: localStorage.removeItem('izzaJackTaken'))
*/
(function(){
  // mark as loaded (handy when looking at localStorage flags)
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

  // ---------- grid helpers (exactly like M4) ----------
  function hqDoorGrid(){
    const t = api.TILE;
    const d = api.doorSpawn || { x: api.player?.x||0, y: api.player?.y||0 };
    return { gx: Math.round(d.x/t), gy: Math.round(d.y/t) };
  }
  // M5 sits one tile EAST of the M4 box: {gx+4, gy+10}
  function jackGrid(){
    const d = hqDoorGrid();
    return { x: d.gx + 4, y: d.gy + 10 };
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

  // ---------- very small SVG jack (1 tile) ----------
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
    return `
<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
 <defs>
  <radialGradient id="g" cx="50%" cy="50%" r="60%">
    <stop offset="0%" stop-color="#ffb347"/>
    <stop offset="60%" stop-color="#ff7b00"/>
    <stop offset="100%" stop-color="#7a2f00"/>
  </radialGradient>
  <linearGradient id="stem" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#3b7a2a"/><stop offset="100%" stop-color="#1f4419"/>
  </linearGradient>
 </defs>
 <ellipse cx="100" cy="110" rx="78" ry="70" fill="url(#g)" stroke="#552200" stroke-width="6"/>
 <rect x="92" y="30" width="16" height="28" rx="6" fill="url(#stem)"/>
 <polygon points="60,90 85,110 35,110" fill="#ffd23f"/>
 <polygon points="140,90 165,110 115,110" fill="#ffd23f"/>
 <path d="M50 140 Q100 175 150 140 Q138 150 100 155 Q62 150 50 140 Z" fill="#ffd23f"/>
</svg>`;
  }
  let jackImg = null; // lazily created when we first render

  // ---------- draw jack exactly like the M4 box offsets ----------
  function drawJack(ctx, sx, sy, S){
    if (!jackImg) jackImg = svgToImage(svgJack(), api.TILE, api.TILE); // 1× tile
    if (!jackImg.complete) return; // wait for image to load
    // same center offsets used by M4: +S*0.5, +S*0.6 already applied by caller
    const w = api.TILE * (S/api.TILE); // equals S
    const h = w;
    ctx.drawImage(jackImg, sx - w/2, sy - h/2, w, h);
  }

  // ---------- render-under ----------
  function renderM5(){
    try{
      if (!api?.ready) return;

      const force = localStorage.getItem('izzaForceM5') === '1';
      const tier2 = localStorage.getItem('izzaMapTier') === '2';
      const m4done = isMission4Done();
      const taken = localStorage.getItem(JACK_TAKEN_KEY) === '1';

      ensureHudChip(`M5 ✓ loaded • tier2:${tier2} • m4:${m4done} • taken:${taken} • force:${force}`);

      if (!force){
        if (!tier2) return;
        if (!m4done) return;
        if (taken) return;
      }

      const S=api.DRAW, t=api.TILE, g=jackGrid();
      const bx=(g.x*t - api.camera.x)*(S/t) + S*0.5;
      const by=(g.y*t - api.camera.y)*(S/t) + S*0.6;

      const ctx=document.getElementById('game')?.getContext('2d'); if(!ctx) return;

      if (localStorage.getItem('izzaM5Debug') === '1'){
        ctx.save();
        ctx.beginPath(); ctx.arc(bx, by, 3.8, 0, Math.PI*2); ctx.fillStyle='#ff5577'; ctx.fill(); ctx.restore();
      }

      drawJack(ctx, bx, by, S);
    }catch{}
  }

  // ---------- B: pick up jack when standing exactly on its tile ----------
  function onB(e){
    try{
      if (!api?.ready) return;
      // obey same gates unless forced
      const force = localStorage.getItem('izzaForceM5') === '1';
      if (!force){
        if (localStorage.getItem('izzaMapTier') !== '2') return;
        if (!isMission4Done()) return;
        if (localStorage.getItem(JACK_TAKEN_KEY) === '1') return;
      }

      const t = api.TILE;
      const gx = ((api.player.x+16)/t|0), gy=((api.player.y+16)/t|0);
      const g  = jackGrid();

      if (gx === g.x && gy === g.y){
        e?.preventDefault?.(); e?.stopImmediatePropagation?.(); e?.stopPropagation?.();

        // basic confirm (no fancy UI)
        if (!window.confirm('Pick up the jack-o’-lantern?')) return;

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

  // ---------- wire up (both early and after ready) ----------
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
