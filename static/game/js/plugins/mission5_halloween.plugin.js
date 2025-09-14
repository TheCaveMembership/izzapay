/* mission5_halloween.plugin.js
   IZZA Mission 5 — “Night of the Lantern”
   - Spawns a Jack-o’-lantern when missionsCompleted ≥ 4
   - JACK location: HQ door +8E, −3N (see IZZA core/expander door grid)
   - [B] on JACK -> add to inventory, start 5-min night mission, spawn 3 pumpkins
   - [B] on a pumpkin -> +1 pumpkin_piece
   - Werewolf spawns every 30s while player is moving at night
   - Craft Pumpkin Armour (4 pcs) in Armoury with 1 jack + 3 pumpkins
*/
(function(){
  // ====== Safety glue ======
  if (!window.IZZA) window.IZZA = {};
  if (typeof IZZA.on !== 'function') IZZA.on = function(){};
  if (typeof IZZA.emit !== 'function') IZZA.emit = function(){};

  let api = null;               // hydrated by IZZA.on('ready')
  let TILE = 32;                // will be replaced by api.TILE
  const DRAW_TO_TILE = ()=> (api?.DRAW||TILE) / (api?.TILE||TILE);

  // ====== Small helpers (LS + inventory) ======
  function _lsGet(k, d){ try{ const v=localStorage.getItem(k); return v==null?d:v; }catch{ return d; } }
  function _lsSet(k, v){ try{ localStorage.setItem(k, v); }catch{} }

  function _getInv(){
    try{
      if (IZZA?.api?.getInventory) return JSON.parse(JSON.stringify(IZZA.api.getInventory()||{}));
      const raw = localStorage.getItem('izzaInventory'); return raw? JSON.parse(raw) : {};
    }catch{ return {}; }
  }
  function _setInv(inv){
    try{
      if (IZZA?.api?.setInventory) IZZA.api.setInventory(inv);
      else localStorage.setItem('izzaInventory', JSON.stringify(inv||{}));
      try{ window.dispatchEvent(new Event('izza-inventory-changed')); }catch{}
    }catch{}
  }
  function _inc(inv, key, n=1, extra={}){
    const cur = inv[key] || { count:0 };
    cur.count = (cur.count|0) + n;
    Object.assign(cur, extra);
    inv[key] = cur;
  }
  function _dec(inv, key, n=1){
    const cur = inv[key]; if(!cur) return;
    cur.count = Math.max(0, (cur.count|0)-n);
    if ((cur.count|0) <= 0) delete inv[key];
  }

  function missionsCompleted(){
    try{
      if (IZZA?.api?.inventory?.getMeta) {
        const m = IZZA.api.inventory.getMeta('missionsCompleted')|0;
        if (m) return m;
      }
    }catch{}
    return parseInt(_lsGet('izzaMissions','0'),10) || 0;
  }
  function setMissions(n){
    const cur = missionsCompleted();
    if (n>cur){
      try{ IZZA.api?.inventory?.setMeta?.('missionsCompleted', n); }catch{}
      _lsSet('izzaMissions', String(n));
      try{ IZZA.emit('missions-updated', {completed:n}); }catch{}
    }
  }

  // ====== Positioning (HQ door anchor from core/expander) ======
  function doorGrid(){
    const t = api?.TILE || TILE;
    const d = api?.doorSpawn || {x: api?.player?.x||0, y: api?.player?.y||0};
    return { gx: Math.round(d.x/t), gy: Math.round(d.y/t) };
  }
  // JACK is +8E, -3N from HQ door
  function jackGrid(){
    const d = doorGrid();
    return { x: d.gx + 8, y: d.gy - 3 };
  }
  // pumpkins (same three spots we used earlier)
  function pumpkinTiles(){
    const d = doorGrid();
    const p1={ tx:d.gx-15, ty:d.gy+10 };
    const p2={ tx:p1.tx-20, ty:p1.ty+13 };
    const p3={ tx:d.gx+8,  ty:d.gy-13 };
    return [p1,p2,p3];
  }

  // ====== World→Screen ======
  function w2s(wx, wy){
    const S = api?.DRAW || (TILE*3), T=api?.TILE||TILE, k=S/T;
    return { sx:(wx - (api?.camera?.x||0))*k, sy:(wy - (api?.camera?.y||0))*k };
  }

  // ====== Tiny art factory (inline SVG → <img>) ======
  const _imgCache = new Map();
  function svgToImg(svg, pxW, pxH){
    const key=svg+'|'+pxW+'x'+pxH;
    if(_imgCache.has(key)) return _imgCache.get(key);
    const url='data:image/svg+xml;utf8,'+encodeURIComponent(svg);
    const img=new Image(); img.width=pxW; img.height=pxH; img.src=url;
    _imgCache.set(key,img);
    return img;
  }

  // JACK art — larger, sketchy carved face + faint halo
  function svgJack(){
    return `
<svg viewBox="0 0 220 220" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="g" cx="50%" cy="55%" r="62%">
      <stop offset="0%" stop-color="#ffcc66"/><stop offset="55%" stop-color="#ff8a00"/><stop offset="100%" stop-color="#5a2200"/>
    </radialGradient>
    <radialGradient id="halo" cx="50%" cy="50%" r="70%">
      <stop offset="0%" stop-color="rgba(255,210,90,0.55)"/><stop offset="100%" stop-color="rgba(255,210,90,0)"/>
    </radialGradient>
    <linearGradient id="stem" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#347a2a"/><stop offset="100%" stop-color="#1a3f19"/></linearGradient>
    <filter id="rough"><feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="1" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="1.5"/></filter>
  </defs>
  <circle cx="110" cy="112" r="95" fill="url(#halo)"/>
  <ellipse cx="110" cy="118" rx="82" ry="72" fill="url(#g)" stroke="#3b1800" stroke-width="7" filter="url(#rough)"/>
  <rect x="102" y="34" width="18" height="28" rx="6" fill="url(#stem)"/>
  <!-- Sketchy face (white-ish fill for “carved glow”) -->
  <path d="M56 100  84 118  36 118Z" fill="#ffe9a6"/>
  <path d="M164 100 192 118 144 118Z" fill="#ffe9a6"/>
  <path d="M58 150 Q110 186 162 150 Q150 160 110 166 Q70 160 58 150Z" fill="#ffe9a6"/>
  <!-- scratch lines -->
  <g stroke="#3b1c00" stroke-width="2" opacity=".65">
    <path d="M40 120 Q60 104 80 120"/>
    <path d="M140 120 Q160 104 180 120"/>
    <path d="M70 165 Q110 176 150 165"/>
  </g>
</svg>`;
  }

  // Pumpkin piece art (box-sized footprint)
  function svgPumpkinPiece(){
    return `
<svg viewBox="0 0 44 44" xmlns="http://www.w3.org/2000/svg">
  <defs><linearGradient id="pp" x1="0" x2="1"><stop offset="0" stop-color="#ffb347"/><stop offset="1" stop-color="#ff7b00"/></linearGradient></defs>
  <rect x="8" y="10" width="28" height="20" rx="4" fill="url(#pp)" stroke="#7a2f00" stroke-width="2"/>
  <rect x="20.5" y="5" width="3" height="7" rx="1.5" fill="#2c5e22"/>
</svg>`;
  }

  // ====== State ======
  let jack = { placed:false, gx:0, gy:0, img:null };
  let pumpkins = []; // {tx,ty,collected:false,img}
  let missionActive=false, missionStart=0, M5_MS = 5*60*1000;
  let nightOn=false, werewolfNext=0, lastPos=null;
  let haTimer=null;

  // ====== Placement ======
  function ensureJack(){
    if (jack.placed) return;
    const g = jackGrid();
    jack.gx = g.x; jack.gy = g.y;
    jack.img = svgToImg(svgJack(), Math.round((api?.DRAW||96)*1.2), Math.round((api?.DRAW||96)*1.2)); // ~1.2× tile
    jack.placed = true;
    // Joker “HA HA HA” overlay ping (every ~2.5s)
    if (!haTimer) {
      haTimer = setInterval(()=>{ try{ showHaHa(); IZZA.emit('sfx',{kind:'jack-HA',vol:0.7}); }catch{} }, 2500);
    }
  }
  function clearJack(){
    jack.placed=false; jack.img=null;
    if (haTimer){ clearInterval(haTimer); haTimer=null; }
    removeHaHa();
  }
  function ensureJackIfM4(){
    if ((missionsCompleted()|0) >= 4) ensureJack();
  }

  // ====== Pumpkin field ======
  function placePumpkins(){
    pumpkins.length=0;
    for(const t of pumpkinTiles()){
      pumpkins.push({ tx:t.tx, ty:t.ty, collected:false, img: svgToImg(svgPumpkinPiece(), Math.round((api?.DRAW||96)*0.68), Math.round((api?.DRAW||96)*0.68)) });
    }
  }
  function clearPumpkins(){ pumpkins.length=0; }

  // ====== Night overlay ======
  function setNight(on){
    if (on===nightOn) return;
    nightOn = on;
    const id='m5-night';
    let el=document.getElementById(id);
    if (on){
      if(!el){
        el=document.createElement('div');
        el.id=id;
        el.style.cssText='position:absolute;inset:0;pointer-events:none;z-index:6000;mix-blend-mode:multiply;' +
                         'background:radial-gradient(ellipse at 50% 45%, rgba(0,0,0,.25) 0%, rgba(0,0,0,.85) 72%);';
        (document.getElementById('gameCard')||document.body).appendChild(el);
        const blue=document.createElement('div');
        blue.style.cssText='position:absolute;inset:0;pointer-events:none;mix-blend-mode:screen;background:rgba(30,50,120,.18)';
        el.appendChild(blue);
        const grain=document.createElement('div');
        grain.style.cssText='position:absolute;inset:0;background:repeating-linear-gradient(0deg,rgba(255,255,255,.04),rgba(255,255,255,.04) 1px,transparent 1px,transparent 2px);opacity:.25';
        el.appendChild(grain);
      }
    } else {
      el?.remove();
    }
  }

  // ====== Spooky modal on pickup ======
  function showSpookyIntro(){
    const id='m5-spook';
    if (document.getElementById(id)) return;
    const wrap=document.createElement('div');
    wrap.id=id;
    wrap.style.cssText='position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.66);z-index:7000;';
    wrap.innerHTML = `
      <div style="position:relative;width:min(620px,92vw);padding:18px;border-radius:14px;border:1px solid #2e364a;
                  background:linear-gradient(135deg,#0b101a,#121a2a 45%,#0c141f); color:#e9f1ff; box-shadow:0 20px 60px rgba(0,0,0,.7)">
        <div style="position:absolute;inset:-60px -60px auto auto;opacity:.12;filter:blur(18px);
                    background:radial-gradient(circle at 70% 30%,#ffd23f,transparent 40%),radial-gradient(circle at 30% 70%,#22d3ee,transparent 45%)"></div>
        <div style="font-weight:900;font-size:22px;letter-spacing:.6px;margin-bottom:6px">IZZA CITY — NIGHTFALL</div>
        <div style="opacity:.95;line-height:1.5">
          You picked up the <b>Jack-o’-lantern</b>. The streets feel dangerous. Collect <b>3 pumpkins</b> and craft <b>Pumpkin Armour</b> at the Armoury.
        </div>
        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:12px">
          <button id="m5Go" style="background:#1f6feb;color:#fff;border:0;border-radius:10px;padding:10px 14px;font-weight:900;cursor:pointer">Let’s Go</button>
        </div>
        <div id="m5HaStream" style="position:absolute;left:8px;right:8px;top:-10px;height:0;pointer-events:none;"></div>
      </div>`;
    document.body.appendChild(wrap);
    wrap.querySelector('#m5Go').addEventListener('click', ()=>wrap.remove(), {capture:true});
    // Start HA loop immediately inside modal too
    showHaHa();
  }
  function showHaHa(){
    const host = document.getElementById('m5HaStream') || document.body;
    const el = document.createElement('div');
    const x = Math.round(10 + Math.random()*80);
    const s = 0.9 + Math.random()*0.6;
    el.textContent = 'HA HA HA';
    el.style.cssText = `
      position:absolute; left:${x}%; top:-8px; transform:scale(${s}) translateX(-50%);
      color:#fff; font-weight:900; letter-spacing:1.5px; text-shadow:0 0 10px rgba(255,255,255,.6), 0 0 22px rgba(255,255,255,.35);
      filter:drop-shadow(0 2px 0 rgba(0,0,0,.6)); mix-blend-mode:screen; opacity:.95;
      font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial;`;
    host.appendChild(el);
    // float up & fade
    let y = 0, a = 1;
    (function tick(){
      y += 1.4; a -= 0.02;
      el.style.top = (y-8)+'px'; el.style.opacity = String(Math.max(0,a));
      if (a>0) requestAnimationFrame(tick); else el.remove();
    })();
  }
  function removeHaHa(){
    try{ document.querySelectorAll('#m5HaStream div').forEach(n=>n.remove()); }catch{}
  }

  // ====== Render under ======
  function renderUnder(){
    try{
      if (!api?.ready) return;
      if (localStorage.getItem('izzaMapTier') !== '2') return;

      const ctx=document.getElementById('game')?.getContext('2d'); if(!ctx) return;
      const t=api.TILE, S=api.DRAW, k=S/t;

      // JACK
      if ((missionsCompleted()|0)>=4 && jack.placed && jack.img && jack.img.complete){
        const wx = jack.gx * t, wy = jack.gy * t;
        const {sx,sy} = w2s(wx,wy);
        const w = Math.round(S*1.2), h=w; // ~1.2× tile
        ctx.drawImage(jack.img, sx + S*0.5 - w/2, sy + S*0.58 - h/2, w, h);
      }

      // pumpkins
      for(const p of pumpkins){
        if(p.collected || !p.img || !p.img.complete) continue;
        const wx = p.tx * t, wy = p.ty * t;
        const {sx,sy} = w2s(wx,wy);
        const w = Math.round(S*0.68), h=w; // box-sized
        ctx.drawImage(p.img, sx + S*0.5 - w/2, sy + S*0.58 - h/2, w, h);
      }
    }catch{}
  }

  // ====== Input (B) ======
  function isOnGrid(gx,gy){
    const t=api?.TILE||TILE;
    const px=((api?.player?.x||0)+16)/t|0, py=((api?.player?.y||0)+16)/t|0;
    return (px===gx && py===gy);
  }
  function onPressB(e){
    if(!api?.ready) return;

    // 1) JACK pickup
    if ((missionsCompleted()|0)>=4 && jack.placed && isOnGrid(jack.gx, jack.gy)){
      e?.preventDefault?.(); e?.stopImmediatePropagation?.(); e?.stopPropagation?.();

      // add JACK to inventory
      const inv=_getInv();
      _inc(inv,'jack_o_lantern',1,{name:'Jack-o’-lantern'});
      _setInv(inv);

      // start mission
      missionActive=true; missionStart=performance.now(); werewolfNext=missionStart+500;
      setNight(true);
      ensureJack(); // safety before clearing
      clearJack();
      placePumpkins();
      showSpookyIntro();
      IZZA.toast?.('Mission 5: Night of the Lantern');
      return;
    }

    // 2) Pumpkin pickup
    for(const p of pumpkins){
      if(!p.collected && isOnGrid(p.tx,p.ty)){
        e?.preventDefault?.(); e?.stopImmediatePropagation?.(); e?.stopPropagation?.();
        p.collected=true;
        const inv=_getInv(); _inc(inv,'pumpkin_piece',1,{name:'Pumpkin Piece'}); _setInv(inv);
        IZZA.toast?.('+1 Pumpkin');
        return;
      }
    }
  }
  function wireB(){
    document.getElementById('btnB')?.addEventListener('click', onPressB, true);
    window.addEventListener('keydown', e=>{ if((e.key||'').toLowerCase()==='b') onPressB(e); }, true);
  }

  // ====== Werewolf loop ======
  function isMoving(){
    const p={x:api?.player?.x||0, y:api?.player?.y||0};
    if(!lastPos){ lastPos=p; return false; }
    const d=Math.hypot(p.x-lastPos.x,p.y-lastPos.y); lastPos=p;
    return d > ((api?.TILE||TILE)*0.35);
  }
  function spawnWerewolf(){
    try{ IZZA.emit('npc-spawn',{kind:'werewolf', host:'mission5'}); }catch{}
    try{ IZZA.emit('sfx',{kind:'werewolf-spawn',vol:0.9}); }catch{}
  }

  // ====== Crafting (at Armoury) ======
  function playerInArmoury(){
    if(api?.inZone) return api.inZone('armoury')===true;
    const d = window.__IZZA_ARMOURY__?.door;
    if(!d) return false;
    const me={x:(api?.player?.x||0)/(api?.TILE||TILE)|0, y:(api?.player?.y||0)/(api?.TILE||TILE)|0};
    return (Math.abs(me.x-d.x)+Math.abs(me.y-d.y))<=1;
  }

  function craftIfReady(){
    if(!missionActive) return false;
    if(!playerInArmoury()) return false;

    const inv=_getInv();
    const haveJack = (inv.jack_o_lantern?.count|0) > 0;
    const pcs = (inv.pumpkin_piece?.count|0) | 0;
    if(!haveJack || pcs<3) return false;

    _dec(inv,'jack_o_lantern',1);
    _dec(inv,'pumpkin_piece',3);

    // add pumpkin armour (equip UI relies on slot fields)
    _inc(inv,'armor_pumpkin_helm',1,{name:'Pumpkin Helm', slot:'head'});
    _inc(inv,'armor_pumpkin_vest',1,{name:'Pumpkin Vest', slot:'chest'});
    _inc(inv,'armor_pumpkin_arms',1,{name:'Pumpkin Arms', slot:'arms'});
    _inc(inv,'armor_pumpkin_legs',1,{name:'Pumpkin Legs', slot:'legs', meta:{ speed:0.28 }});
    inv._pumpkinSet = { setDR:0.20 }; // set bonus meta for your UI/logic

    _setInv(inv);

    missionActive=false; setNight(false); clearPumpkins();
    setMissions(5);
    try{ IZZA.emit('mission-complete',{id:5,name:'Night of the Lantern'}); }catch{}
    try{ IZZA.toast?.('Crafted Pumpkin Armour (4 pcs)!'); }catch{}
    return true;
  }

  // ====== Ticks ======
  function onUpdatePost({ now }){
    if (missionActive){
      if ((now - missionStart) > M5_MS){
        missionActive=false; setNight(false); clearPumpkins();
        IZZA.toast?.('Mission 5 failed — time expired.');
        setTimeout(ensureJackIfM4, 600);
      }
      if (now >= werewolfNext){
        if (isMoving()) spawnWerewolf();
        werewolfNext = now + 30000;
      }
      craftIfReady();
    }
  }

  // ====== Wire up ======
  IZZA.on('ready', ({ api:__api })=>{
    api = __api||api||{};
    TILE = api?.TILE || TILE;

    IZZA.on('render-under', renderUnder);
    IZZA.on('update-post', onUpdatePost);

    wireB();
    setTimeout(ensureJackIfM4, 0);
  });

  window.addEventListener('izza-inventory-changed', ()=> setTimeout(ensureJackIfM4, 0));

  IZZA.on('resume', ()=> ensureJackIfM4());
  IZZA.on('shutdown', ()=>{ clearJack(); clearPumpkins(); setNight(false); });

})();
