/* mission5_halloween.plugin.js — Mission 5 (evil jack, HA-smoke, night run) — refreshed
   - JACK shows at HQ +8E, +3N when M4 is complete and not yet taken.
   - Accept → +1 jack to inventory, start 5m night, spawn pumpkins.
   - Werewolf now SELF-RENDERED in render-post (always above map); creepy sketch look w/ eye glow.
   - Timer HUD during mission. Armoury popup renders OVER night dimmer.
   - Craft in armoury with 1 jack + 3 pieces; grants 4 pumpkin armour pieces with set DR and legs speed.
   - On craft: Mission 5 marked complete (UI bumps), night off, timer cleared, unlock signal for Mission 6.
   - HA “smoke” floats from mouth every ~2.5s.
   - Debug: localStorage.izzaM5Debug='1', localStorage.izzaForceM5='1'
*/
(function(){
  window.__M5_LOADED__ = true;
  if (!window.IZZA) window.IZZA = {};
  if (typeof IZZA.on !== 'function') IZZA.on = function(){};
  if (typeof IZZA.emit !== 'function') IZZA.emit = function(){};

  let api = null;

  const JACK_TAKEN_KEY = 'izzaJackTaken';
  const M5_MS = 5 * 60 * 1000;

  // ---------------- state ----------------
  let nightOn=false, mission5Active=false, mission5Start=0, werewolfNext=0, lastPos=null;
  const pumpkins = []; // {tx,ty,collected,img}
  const HA = [];       // smoke glyphs {x,y,vx,vy,age,life,rot}
  const WOLVES = [];   // self-rendered wolves [{x,y,vx,vy,age,life,phase}]
  let jackImg = null, timerEl = null;

  // ---------------- helpers ----------------
  function _lsGet(k, d){ try{ const v=localStorage.getItem(k); return v==null? d : v; }catch{ return d; } }
  function _lsSet(k, v){ try{ localStorage.setItem(k, v); }catch{} }
  function _missions(){ return parseInt(_lsGet('izzaMissions','0'),10) || 0; }
  function _setMissions(n){ const cur=_missions(); if(n>cur) _lsSet('izzaMissions', String(n)); }
  function missionsCompletedMeta(){
    try{ const n = IZZA?.api?.inventory?.getMeta?.('missionsCompleted')|0; if(Number.isFinite(n)) return n; }catch{}
    return _missions();
  }
  function isMission4Done(){
    try{ if ((missionsCompletedMeta()|0) >= 4) return true; }catch{}
    try{ if ((_missions()|0) >= 4) return true; }catch{}
    try{ if (localStorage.getItem('izzaMission4_done') === '1') return true; }catch{}
    return false;
  }

  function invRead(){
    try{
      if (IZZA?.api?.getInventory) return JSON.parse(JSON.stringify(IZZA.api.getInventory()||{}));
      const raw = localStorage.getItem('izzaInventory'); return raw? JSON.parse(raw) : {};
    }catch{ return {}; }
  }
  function _bcastInvChanged(){
    try{ IZZA.emit?.('inventory-changed'); }catch{}
    try{ window.dispatchEvent(new Event('izza-inventory-changed')); }catch{}
  }
  function invWrite(inv){
    try{
      if (IZZA?.api?.setInventory) IZZA.api.setInventory(inv);
      else localStorage.setItem('izzaInventory', JSON.stringify(inv||{}));
    }catch{}
    _bcastInvChanged();
  }
  function invInc(inv, key, n=1){
    inv[key]=inv[key]||{count:0};
    inv[key].count=(inv[key].count|0)+n;
    return inv;
  }
  function invDec(inv, key, n=1){
    if(!inv[key]) return inv;
    inv[key].count=Math.max(0,(inv[key].count|0)-n);
    if(inv[key].count<=0) delete inv[key];
    return inv;
  }

  // ---- Canonical inventory adders + one-time alias cleanup
  function _addOne(inv, canonicalKey, displayName){
    inv[canonicalKey] = inv[canonicalKey] || { count: 0, name: displayName || canonicalKey };
    inv[canonicalKey].count = (inv[canonicalKey].count|0) + 1;
  }
  (function _aliasCleanupOnce(){
    const inv = invRead();
    if (inv.pumpkin) {
      inv.pumpkin_piece = inv.pumpkin_piece || { count: 0, name: 'Pumpkin' };
      inv.pumpkin_piece.count = (inv.pumpkin_piece.count|0) + (inv.pumpkin.count|0);
      delete inv.pumpkin;
    }
    if (inv.jacklantern) {
      inv.jack_o_lantern = inv.jack_o_lantern || { count: 0, name: 'Jack-o’-Lantern' };
      inv.jack_o_lantern.count = (inv.jack_o_lantern.count|0) + (inv.jacklantern.count|0);
      delete inv.jacklantern;
    }
    invWrite(inv);
  })();

  // ---------------- grid ----------------
  function hqDoorGrid(){
    const t = api?.TILE || 32;
    const d = api?.doorSpawn || { x: api?.player?.x||0, y: api?.player?.y||0 };
    return { gx: Math.round(d.x/t), gy: Math.round(d.y/t) };
  }
  function jackGrid(){ const d=hqDoorGrid(); return { x:d.gx+8, y:d.gy-3 }; }

  function computePumpkinTiles(){
    const d=hqDoorGrid();
    const p1={ tx:d.gx-15, ty:d.gy+10 };
    const p2={ tx:p1.tx-20, ty:p1.ty+13 };
    const p3={ tx:d.gx+8,  ty:d.gy-7 };
    return [p1,p2,p3];
  }

  // ---------------- screen math ----------------
  function worldToScreen(wx, wy){
    const S = api.DRAW, T = api.TILE;
    const sx = (wx - api.camera.x) * (S/T);
    const sy = (wy - api.camera.y) * (S/T);
    return { sx, sy };
  }

  // ---------------- debug HUD ----------------
  function hud(text){
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

  // ---------------- art ----------------
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
    <stop offset="0%" stop-color="#ffe39d"/>
    <stop offset="55%" stop-color="#ff9820"/>
    <stop offset="100%" stop-color="#5a1e00"/>
  </radialGradient>
  <linearGradient id="stem" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#2f6a22"/><stop offset="100%" stop-color="#173715"/>
  </linearGradient>
 </defs>
 <ellipse cx="100" cy="110" rx="78" ry="70" fill="url(#g)" stroke="#3a1400" stroke-width="8"/>
 <rect x="92" y="30" width="16" height="28" rx="5" fill="url(#stem)"/>
 <polygon points="48,98 88,86 72,116 48,110" fill="#120800"/>
 <polygon points="112,86 152,98 152,110 128,116" fill="#120800"/>
 <path d="M38 138 Q100 170 162 138 L154 146 L138 142 L124 150 L108 142 L94 152 L78 142 L64 150 L50 142 Z" fill="#120800"/>
</svg>`;
  }
  const JACK_MULT = 1.5;

  function svgPumpkinSmall(){
    return `
<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg">
 <defs><radialGradient id="gp" cx="50%" cy="50%" r="60%">
   <stop offset="0%" stop-color="#ffcf7a"/><stop offset="60%" stop-color="#ff8412"/><stop offset="100%" stop-color="#6a2500"/></radialGradient></defs>
 <ellipse cx="40" cy="44" rx="28" ry="24" fill="url(#gp)" stroke="#572200" stroke-width="4"/>
 <rect x="35" y="18" width="8" height="10" rx="3" fill="#2c5e22"/>
</svg>`;
  }

  // Sketchy haunted werewolf (inked outlines, glowing eyes)
  function svgWerewolf(){
    return `
<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg">
 <defs>
  <filter id="fuzz"><feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="1" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="1"/></filter>
  <radialGradient id="eye" cx="50%" cy="50%" r="50%">
    <stop offset="0%" stop-color="#ff3d3d"/><stop offset="100%" stop-color="#5a0000"/>
  </radialGradient>
 </defs>
 <g filter="url(#fuzz)" stroke="#0b0b0b" stroke-width="3" fill="#161616">
  <path d="M16,78 Q6,60 18,46 Q12,34 24,26 Q40,10 60,16 Q80,10 96,26 Q108,34 102,46 Q114,60 104,78 Q86,92 60,100 Q34,92 16,78 Z" />
  <path d="M32,42 Q38,30 50,30 Q40,36 38,48" fill="none"/>
  <path d="M88,42 Q82,30 70,30 Q80,36 82,48" fill="none"/>
  <path d="M30,74 Q60,66 90,74" fill="none"/>
 </g>
 <g>
  <ellipse cx="46" cy="54" rx="7" ry="5" fill="url(#eye)"/>
  <ellipse cx="74" cy="54" rx="7" ry="5" fill="url(#eye)"/>
 </g>
</svg>`;
  }

  // ---------------- pumpkins ----------------
  function placePumpkins(){
    pumpkins.length=0;
    const tiles=computePumpkinTiles();
    for(const t of tiles){
      pumpkins.push({ tx:t.tx, ty:t.ty, collected:false, img: svgToImage(svgPumpkinSmall(), api?.TILE||60, api?.TILE||60) });
    }
  }
  function clearPumpkins(){ pumpkins.length=0; }

  // ---------------- night overlay ----------------
  function setNight(on){
    if(on===nightOn) return;
    nightOn=on;
    const id='m5-night-overlay';
    let el=document.getElementById(id);
    if(on){
      if(!el){
        el=document.createElement('div');
        el.id=id;
        el.style.cssText='position:absolute;inset:0;pointer-events:none;background:radial-gradient(ellipse at 50% 45%, rgba(0,0,0,.28) 0%, rgba(0,0,0,.86) 70%);mix-blend-mode:multiply;z-index:1200';
        (document.getElementById('gameCard')||document.body).appendChild(el);
        const blue=document.createElement('div');
        blue.id=id+'-b';
        blue.style.cssText='position:absolute;inset:0;pointer-events:none;background:rgba(24,48,110,.12);mix-blend-mode:screen;z-index:1201';
        el.appendChild(blue);
      }
    }else{ el?.remove(); }
  }

  // ---------------- HA smoke ----------------
  let lastHa = 0;
  function spawnHA(sx, sy){
    const t = performance.now();
    if (t - lastHa < 2400) return;
    lastHa = t;
    for (let i=0;i<3;i++){
      HA.push({
        x: sx + (i*4), y: sy - (i*2),
        vx: 0.22 + Math.random()*0.15,
        vy: -0.35 - Math.random()*0.18,
        age: 0, life: 90 + (Math.random()*20|0),
        rot: (Math.random()*0.6 - 0.3)
      });
    }
  }
  function updateHA(){ for(let i=HA.length-1;i>=0;i--){ const h=HA[i]; h.age++; h.x+=h.vx; h.y+=h.vy; h.vx*=0.985; h.vy-=0.002; if(h.age>h.life) HA.splice(i,1);} }
  function drawHA(ctx){
    ctx.save();
    for(const h of HA){
      const k = h.age/h.life;
      ctx.globalAlpha = Math.max(0, 0.75 - k);
      ctx.translate(h.x, h.y);
      ctx.rotate(h.rot * k);
      ctx.font = `${(48 + 20*(1-k))|0}px monospace`;
      ctx.fillStyle = `rgba(255,255,255,${0.9 - k*0.8})`;
      ctx.fillText('HA', 0, 0);
      ctx.setTransform(1,0,0,1,0,0);
    }
    ctx.restore();
  }

  // ---------------- spooky choice ----------------
  function showSpookyChoice(onAccept){
    if (IZZA?.api?.UI?.choice){
      IZZA.api.UI.choice({
        spooky:true,
        title:'WELCOME TO IZZA CITY AT NIGHT',
        body:'Take the jack-o’-lantern to begin a 5-minute night run. Collect 3 pumpkins and craft Pumpkin Armour.',
        options:[{id:'go',label:'Take Jack-o’-Lantern'},{id:'no',label:'Leave'}],
        onChoose:(id)=>{ if(id==='go') onAccept?.(); }
      });
      return;
    }
    const wrap=document.createElement('div');
    wrap.style.cssText='position:absolute;inset:0;display:flex;align-items:center;justify-content:center;z-index:9000;background:rgba(0,0,0,.6)';
    const card=document.createElement('div');
    card.style.cssText='min-width:300px;max-width:560px;padding:16px;border-radius:14px;background:linear-gradient(180deg,#0b0f1a,#0b0f1a 60%,#07101e);color:#cfe0ff;border:1px solid #2a3550;box-shadow:0 18px 44px rgba(0,0,0,.6)';
    card.innerHTML='<div style="font-weight:900;font-size:18px;margin-bottom:6px">WELCOME TO IZZA CITY AT NIGHT</div><div style="opacity:.9;margin-bottom:10px">Take the jack-o’-lantern to begin a 5-minute night run. Collect 3 pumpkins and craft Pumpkin Armour.</div>';
    const row=document.createElement('div'); row.style.cssText='display:flex;gap:8px;justify-content:flex-end';
    const bNo=document.createElement('button'); bNo.textContent='Leave'; bNo.style.cssText='padding:8px 12px;border-radius:8px;border:0;background:#263447;color:#cfe3ff;font-weight:800;cursor:pointer';
    const bGo=document.createElement('button'); bGo.textContent='Take Jack-o’-Lantern'; bGo.style.cssText='padding:10px 14px;border-radius:10px;border:0;background:#1f6feb;color:#fff;font-weight:900;cursor:pointer';
    row.appendChild(bNo); row.appendChild(bGo); card.appendChild(row); wrap.appendChild(card); (document.getElementById('gameCard')||document.body).appendChild(wrap);
    bNo.onclick=()=>wrap.remove();
    bGo.onclick=()=>{ try{ onAccept?.(); }finally{ wrap.remove(); } };
  }

  // ---------------- timer HUD ----------------
  function ensureTimer(){
    if (timerEl) return;
    timerEl = document.createElement('div');
    timerEl.id = 'm5Timer';
    timerEl.style.cssText = 'position:absolute;right:14px;top:8px;z-index:6000;padding:6px 10px;border-radius:10px;border:1px solid #2a3550;background:rgba(10,12,20,.85);color:#cfe0ff;font:700 14px/1.2 system-ui,Segoe UI,Arial';
    (document.getElementById('gameCard')||document.body).appendChild(timerEl);
  }
  function updateTimer(now){
    if (!mission5Active || !timerEl) return;
    const left = Math.max(0, M5_MS - (now - mission5Start));
    const mm = Math.floor(left/60000);
    const ss = Math.floor((left%60000)/1000);
    timerEl.textContent = `⏳ ${mm}:${ss<10?'0':''}${ss}`;
  }
  function clearTimer(){ timerEl?.remove(); timerEl=null; }

  // ---------------- WEREWOLF (self-rendered) ----------------
  let wolfImg = null;
  function ensureWolfImg(){
    if (!wolfImg) wolfImg = svgToImage(svgWerewolf(), (api?.TILE||60)*1.6, (api?.TILE||60)*1.6);
  }
  function spawnWerewolf(){
    ensureWolfImg();
    const p = api?.player||{x:0,y:0};
    // spawn slightly off-screen so it "enters" the play area
    const off = (api?.TILE||60) * (2.5 + Math.random()*1.5);
    const ang = Math.random()*Math.PI*2;
    const x = p.x + Math.cos(ang)*off;
    const y = p.y + Math.sin(ang)*off;
    WOLVES.push({ x, y, vx:0, vy:0, age:0, life: 14000 + ((Math.random()*3000)|0), phase: Math.random()*1000 });
  }
  function updateWolves(dt){
    const p = api?.player||{x:0,y:0};
    for (let i=WOLVES.length-1;i>=0;i--){
      const w=WOLVES[i];
      w.age += dt;
      const k = Math.min(1, w.age/1200);
      const sp = 0.045 + 0.035*Math.sin((w.phase+w.age)*0.002); // shambling
      const dx = p.x - w.x, dy = p.y - w.y;
      const d  = Math.hypot(dx,dy)||1;
      const ux = dx/d, uy = dy/d;
      w.vx = w.vx*0.92 + ux*sp*k;
      w.vy = w.vy*0.92 + uy*sp*k;
      w.x += w.vx * dt;
      w.y += w.vy * dt;
      if (w.age > w.life) WOLVES.splice(i,1);
    }
  }
  function drawWolves(ctx){
    if (!WOLVES.length) return;
    const S=api.DRAW, T=api.TILE;
    const px = S/T, py = S/T;
    const tnow = performance.now();
    for (const w of WOLVES){
      const sx=(w.x - api.camera.x)*px;
      const sy=(w.y - api.camera.y)*py;
      const s  = 1 + 0.04*Math.sin((w.phase+tnow)*0.006);
      const flick = 0.35 + 0.3*Math.abs(Math.sin((w.phase+tnow)*0.01));
      if (wolfImg?.complete){
        // shadow
        ctx.save();
        ctx.globalAlpha = 0.35;
        ctx.beginPath(); ctx.ellipse(sx, sy+18, 18, 7, 0, 0, Math.PI*2); ctx.fillStyle='#000'; ctx.fill();
        ctx.restore();

        // body
        ctx.save();
        ctx.translate(sx, sy);
        ctx.scale(s, s);
        ctx.drawImage(wolfImg, -48, -56);
        ctx.restore();

        // eye glow (overdraw)
        ctx.save();
        ctx.globalCompositeOperation='lighter';
        ctx.globalAlpha = flick;
        ctx.fillStyle = 'rgba(255,45,45,0.8)';
        ctx.beginPath(); ctx.arc(sx-12, sy-6, 5.5, 0, Math.PI*2); ctx.fill();
        ctx.beginPath(); ctx.arc(sx+12, sy-6, 5.5, 0, Math.PI*2); ctx.fill();
        ctx.restore();
      }
    }
  }

  // ---------------- render ----------------
  function renderM5Under(){ // map-level bits
    try{
      if (!api?.ready) return;
      const force = localStorage.getItem('izzaForceM5') === '1';
      const tier2 = localStorage.getItem('izzaMapTier') === '2';
      const m4done = isMission4Done();
      const taken = localStorage.getItem(JACK_TAKEN_KEY) === '1';

      hud(`M5 • active:${mission5Active} • night:${nightOn} • pumpkins:${pumpkins.length} • wolves:${WOLVES.length}`);

      const S=api.DRAW, t=api.TILE;
      const ctx=document.getElementById('game')?.getContext('2d'); if(!ctx) return;

      // Draw JACK when allowed
      if ((!mission5Active || force) && (!taken || force) && ((tier2 && m4done) || force)){
        const g=jackGrid();
        const sx=(g.x*t - api.camera.x)*(S/t) + S*0.5;
        const sy=(g.y*t - api.camera.y)*(S/t) + S*0.6;

        if (!jackImg) jackImg = svgToImage(svgJack(), (api.TILE*JACK_MULT)|0, (api.TILE*JACK_MULT)|0);
        if (jackImg.complete){
          const jig = Math.sin(performance.now()*0.007) * (S*0.007);
          const w = (api.TILE*JACK_MULT) * (S/api.TILE);
          const h = w;

          // glow
          ctx.save();
          const grd = ctx.createRadialGradient(sx, sy, w*0.05, sx, sy, w*0.55);
          grd.addColorStop(0, `rgba(255,190,70,${0.35 + 0.08*Math.sin(performance.now()*0.02)})`);
          grd.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.globalCompositeOperation='lighter';
          ctx.fillStyle=grd; ctx.beginPath(); ctx.arc(sx, sy, w*0.55, 0, Math.PI*2); ctx.fill();
          ctx.restore();

          // pumpkin body + HA smoke from mouth
          ctx.drawImage(jackImg, sx - w/2 + jig, sy - h/2 - jig*0.6, w, h);
          spawnHA(sx + w*0.05, sy + h*0.1);
        }
      }

      // pumpkins
      if (pumpkins.length){
        for(const p of pumpkins){
          if(p.collected || !p.img || !p.img.complete) continue;
          const wx = p.tx * t, wy = p.ty * t;
          const scr = worldToScreen(wx, wy);
          const px = scr.sx + S*0.5;
          const py = scr.sy + S*0.58;
          const w  = (t*1.0)*(S/t), h = w;
          ctx.drawImage(p.img, px - w/2, py - h/2, w, h);
        }
      }

      // smoke glyphs (underlay)
      updateHA();
      drawHA(ctx);
    }catch{}
  }

  function renderM5Over(){ // overlays above map/player
    try{
      if (!api?.ready) return;
      const ctx=document.getElementById('game')?.getContext('2d'); if(!ctx) return;
      drawWolves(ctx);
    }catch{}
  }

  // ---------------- input ----------------
  function isNearGrid(gx,gy, rPx){
    const t=api?.TILE||60;
    const px = (api?.player?.x||0)+16, py=(api?.player?.y||0)+16;
    const cx = gx*t + t/2, cy = gy*t + t/2;
    return Math.hypot(px-cx, py-cy) <= (rPx||t*0.9);
  }

  function onB(e){
    if(!api?.ready) return;

    const tierOK = localStorage.getItem('izzaMapTier') === '2';
    const force = localStorage.getItem('izzaForceM5') === '1';
    const taken = localStorage.getItem(JACK_TAKEN_KEY) === '1';

    const t = api.TILE;
    const gx = ((api.player.x+16)/t|0), gy=((api.player.y+16)/t|0);
    const g  = jackGrid();

    // JACK tile → spooky accept dialog
    if ((!taken || force) && (!mission5Active || force) && (gx===g.x && gy===g.y)){
      if (force || (tierOK && isMission4Done())){
        e?.preventDefault?.(); e?.stopImmediatePropagation?.(); e?.stopPropagation?.();
        showSpookyChoice(()=> {
          const inv = invRead();
          _addOne(inv, 'jack_o_lantern', 'Jack-o’-Lantern');
          invWrite(inv);
          try{ localStorage.setItem(JACK_TAKEN_KEY, '1'); }catch{}
          IZZA.toast?.('Jack-o’-Lantern added to Inventory');
          startNightMission();
        });
        return;
      }
    }

    // collect pumpkins
    for(const p of pumpkins){
      if(!p.collected && isNearGrid(p.tx, p.ty, (api?.TILE||60)*0.85)){
        p.collected=true;
        const inv=invRead();
        _addOne(inv, 'pumpkin_piece', 'Pumpkin');
        invWrite(inv);
        IZZA.toast?.('+1 Pumpkin');
        return;
      }
    }
  }

  function wireB(){
    document.getElementById('btnB')?.addEventListener('click', onB, true);
    window.addEventListener('keydown', e=>{ if((e.key||'').toLowerCase()==='b') onB(e); }, true);
  }

  // ---------------- mission flow ----------------
  function startNightMission(){
    setNight(true);
    mission5Active=true;
    mission5Start=performance.now();
    werewolfNext=mission5Start+500;
    placePumpkins();
    ensureTimer();
    try{ IZZA.emit('celebrate',{style:'spray-skull'}); }catch{}
    IZZA.toast?.('Night Mission started — collect 3 pumpkins, then craft Pumpkin Armour!');
  }

  function tryCraftPumpkin(){
    const inv=invRead();
    const haveJack = (inv.jack_o_lantern?.count|0) > 0;
    const pumpkinsC = (inv.pumpkin_piece?.count|0);
    if(!haveJack || pumpkinsC<3) return false;

    invDec(inv,'jack_o_lantern',1);
    invDec(inv,'pumpkin_piece',3);

    invInc(inv,'pumpkinHelmet',1);
    invInc(inv,'pumpkinVest',1);
    invInc(inv,'pumpkinArms',1);
    invInc(inv,'pumpkinLegs',1);
    inv.pumpkinLegs.meta = { speed: 0.28 };
    inv._pumpkinSetMeta   = { setDR: 0.20 };
    invWrite(inv);

    finishMission5();
    return true;
  }

  // Ensure mission UI/HUD flips to 5 immediately + unlock M6
  function bumpMission5UI(){
    _setMissions(5);
    try{ IZZA?.api?.inventory?.setMeta?.('missionsCompleted', 5); }catch{}
    try{ localStorage.setItem('izzaMission5_done','1'); }catch{}
    // nudge common HUD/indicators if present
    try{ IZZA.emit('missions-updated',{completed:5}); }catch{}
    try{ IZZA.emit('mission-complete',{id:5,name:'Night of the Lantern'}); }catch{}
    try{ window.dispatchEvent(new Event('izza-missions-changed')); }catch{}
    try{ if (typeof window.updateStars==='function') window.updateStars(5); }catch{}
    try{ if (IZZA?.api?.UI?.refresh) IZZA.api.UI.refresh(); }catch{}
  }

  // Clean unlock signal for Mission 6 (what to look for)
  function unlockMission6(){
    try{ localStorage.setItem('izzaMission6_unlocked','1'); }catch{}
    try{ IZZA.emit('mission-available',{id:6,name:'Mission 6'}); }catch{}
    try{ IZZA.emit('m6-unlocked'); }catch{}
  }

  function finishMission5(){
    mission5Active=false;
    setNight(false);
    clearPumpkins();
    clearTimer();
    WOLVES.length = 0; // clear any remaining wolves

    bumpMission5UI();
    unlockMission6();

    try{
      IZZA?.api?.UI?.popup?.({style:'agent',title:'Mission Completed',body:'Pumpkin Armour crafted. Set bonus active!',timeout:2200});
    }catch{
      const el=document.createElement('div');
      el.style.cssText='position:absolute;left:50%;top:18%;transform:translateX(-50%);background:rgba(10,12,20,.92);color:#b6ffec;padding:14px 18px;border:2px solid #36f;border-radius:8px;font-family:monospace;z-index:9999';
      el.innerHTML='<strong>Mission Completed</strong><div>Pumpkin Armour crafted. Set bonus active!</div>';
      (document.getElementById('gameCard')||document.body).appendChild(el);
      setTimeout(()=>el.remove(),2000);
    }
  }

  function isMoving(){
    const p={x:api?.player?.x||0, y:api?.player?.y||0};
    if(!lastPos){ lastPos=p; return false; }
    const d=Math.hypot(p.x-lastPos.x,p.y-lastPos.y); lastPos=p; return d>((api?.TILE||60)*0.35);
  }

  // ---------------- update ----------------
  let _lastTick = performance.now();
  function onUpdate({ now }){
    const dt = Math.max(16, now - (_lastTick||now));
    _lastTick = now;

    if (mission5Active){
      if ((now - mission5Start) > M5_MS){
        mission5Active=false; setNight(false); clearPumpkins(); clearTimer(); WOLVES.length=0;
        try{ localStorage.removeItem(JACK_TAKEN_KEY); }catch{}
        IZZA.toast?.('Mission 5 failed — time expired.');
      }
      if (now >= werewolfNext){
        if (isMoving()) spawnWerewolf();   // spawn only if you’re moving to keep tension
        werewolfNext = now + 30000;        // every ~30s window
      }
      updateTimer(now);
    }

    // update wolves regardless so they fade out nicely after mission ends
    updateWolves(dt*0.06); // scale to game movement speeds
  }

  // ---------------- Armoury recipe registration ----------------
  // NOTE: leave registration to your Armoury plugin; M5 no longer injects DOM buttons.

  // ---------------- wire up ----------------
  try { IZZA.on('render-under', renderM5Under); } catch {}
  try { IZZA.on('render-post', renderM5Over); } catch {}
  try { IZZA.on('update-post', onUpdate); } catch {}

  IZZA.on?.('ready', (a)=>{
    api = a;
    IZZA.on?.('render-under', renderM5Under);
    IZZA.on?.('render-post',  renderM5Over);
    IZZA.on?.('update-post',  onUpdate);
    wireB();
  });

  // Optional: if your inventory system toggles things that should end M5, check here
  function onInvChangeCheckM5(){
    if (!mission5Active) return;
    // (kept simple — crafting path already calls finishMission5)
  }
  window.addEventListener('izza-inventory-changed', ()=>{
    try{ IZZA.emit?.('render-under'); }catch{}
    onInvChangeCheckM5();
  });

  IZZA.on?.('shutdown', ()=>{ clearTimer(); setNight(false); WOLVES.length=0; });

})();
