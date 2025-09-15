/* mission5_halloween.plugin.js — Mission 5 (evil jack, HA-smoke, night run)
   CHANGE: Night/timer/end state now trigger ONLY when the player crafts Pumpkin Armour.
           We finish either (a) on Armoury craft events OR (b) when inventory shows the full set
           after an inventory change (mirrors Mission 4’s logic).
   Kept: Werewolf (all fours, smaller/faster, one glowing red eye, drool), timer, HA smoke, M6 unlock, UI bump.
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
  const HA = [];       // smoke glyphs
  const WOLVES = [];   // [{x,y,vx,vy,age,life,mode,runPhase,attackMouth,damageTick,nextAttackAt,attackEndAt}]
  let jackImg = null, timerEl = null;

  // Congrats popup guard (so we don't double-pop)
  let _m5CongratsShown = false;

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
  function invInc(inv, key, n=1){ inv[key]=inv[key]||{count:0}; inv[key].count=(inv[key].count|0)+n; return inv; }
  function invCount(id){
    try{
      if (IZZA?.api?.inventory?.count) return IZZA.api.inventory.count(id)|0;
      const inv = JSON.parse(localStorage.getItem('izzaInventory')||'{}');
      return (inv?.[id]?.count|0) || 0;
    }catch{ return 0; }
  }

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
    return { sx: (wx - api.camera.x) * (S/T), sy: (wy - api.camera.y) * (S/T) };
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

  function svgJack(){ return `
<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
 <defs>
  <radialGradient id="g" cx="50%" cy="50%" r="60%">
    <stop offset="0%" stop-color="#ffe39d"/><stop offset="55%" stop-color="#ff9820"/><stop offset="100%" stop-color="#5a1e00"/>
  </radialGradient>
  <linearGradient id="stem" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#2f6a22"/><stop offset="100%" stop-color="#173715"/></linearGradient>
 </defs>
 <ellipse cx="100" cy="110" rx="78" ry="70" fill="url(#g)" stroke="#3a1400" stroke-width="8"/>
 <rect x="92" y="30" width="16" height="28" rx="5" fill="url(#stem)"/>
 <polygon points="48,98 88,86 72,116 48,110" fill="#120800"/>
 <polygon points="112,86 152,98 152,110 128,116" fill="#120800"/>
 <path d="M38 138 Q100 170 162 138 L154 146 L138 142 L124 150 L108 142 L94 152 L78 142 L64 150 L50 142 Z" fill="#120800"/>
</svg>`;}
  const JACK_MULT = 1.5;

  function svgPumpkinSmall(){ return `
<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg">
 <defs><radialGradient id="gp" cx="50%" cy="50%" r="60%"><stop offset="0%" stop-color="#ffcf7a"/><stop offset="60%" stop-color="#ff8412"/><stop offset="100%" stop-color="#6a2500"/></radialGradient></defs>
 <ellipse cx="40" cy="44" rx="28" ry="24" fill="url(#gp)" stroke="#572200" stroke-width="4"/><rect x="35" y="18" width="8" height="10" rx="3" fill="#2c5e22"/>
</svg>`;}

  // ---------------- WOLF ART (4-run frames + attack) ----------------
  function svgWerewolfRunFrame(shift){
    const legA = 6*shift, legB = -6*shift;
    return `
<svg viewBox="0 0 170 120" xmlns="http://www.w3.org/2000/svg">
  <defs><radialGradient id="eye" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="#ff3b3b"/><stop offset="100%" stop-color="#5a0000"/></radialGradient></defs>
  <g fill="#0b0b0b" stroke="#060606" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round">
    <path d="M14,88 C28,64 42,54 66,50 C96,46 124,50 154,60
             C154,74 136,86 106,92 C74,98 44,96 20,92 Z"/>
    <path d="M122,56 C134,48 148,46 156,48 C160,52 158,60 148,64 L134,66 C130,62 126,60 122,58 Z"/>
    <path d="M124,48 L134,36 L142,48"/>
    <path d="M44,64 L36,54 M52,62 L46,52 M60,60 L56,50 M72,58 L68,48 M84,58 L80,48 M94,60 L90,50" />
    <path d="M60,92 C56,104 50,114 48,118 L40,118 C42,108 42,100 40,90 Z" transform="translate(${legA},0)"/>
    <path d="M96,92 C94,104 90,114 88,118 L80,118 C82,110 82,100 80,92 Z" transform="translate(${legB},0)"/>
    <path d="M132,86 C134,98 130,110 128,116 L120,116 C122,108 122,98 120,88 Z" />
    <path d="M28,90 C22,100 20,110 18,116 L10,116 C14,106 16,96 16,88 Z" />
  </g>
  <!-- ONE glowing eye -->
  <ellipse cx="128" cy="60" rx="6.2" ry="4.6" fill="url(#eye)"/>
</svg>`;
  }
  function svgWerewolfAttack(){
    return `
<svg viewBox="0 0 180 180" xmlns="http://www.w3.org/2000/svg">
  <defs><radialGradient id="eye" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="#ff3b3b"/><stop offset="100%" stop-color="#5a0000"/></radialGradient></defs>
  <g fill="#0b0b0b" stroke="#060606" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round">
    <path d="M76,50 C92,32 122,34 134,58 C144,80 140,116 124,134 C110,150 86,152 72,134 C58,116 56,80 66,60 Z"/>
    <path d="M86,134 C86,150 80,164 78,170 L66,170 C70,156 70,142 68,130 Z"/>
    <path d="M118,132 C122,148 118,164 116,170 L104,170 C106,156 106,142 104,128 Z"/>
    <path d="M70,84 L50,66 L44,74 L66,98"/>
    <path d="M130,82 L154,62 L162,70 L136,102"/>
  </g>
  <ellipse cx="118" cy="70" rx="6.4" ry="4.8" fill="url(#eye)"/>
  <g id="jaw">
    <path d="M60,90 C94,112 130,112 158,90
             C154,130 94,158 64,134 Z"
          fill="#120000" stroke="#3a0000" stroke-width="2.2"/>
    <g fill="#eaeaea" stroke="#6a0000" stroke-width="1">
      <path d="M72,98 L76,112 L80,98 Z"/>
      <path d="M86,102 L90,116 L94,102 Z"/>
      <path d="M100,104 L104,120 L108,104 Z"/>
      <path d="M114,102 L118,116 L122,102 Z"/>
      <path d="M128,98 L132,110 L136,98 Z"/>
      <path d="M78,126 L82,114 L86,126 Z"/>
      <path d="M92,132 L96,118 L100,132 Z"/>
      <path d="M106,134 L110,120 L114,134 Z"/>
      <path d="M120,130 L124,116 L128,130 Z"/>
    </g>
  </g>
</svg>`;
  }

  // cache wolf frames
  let wolfRunFrames = [];
  let wolfAttackImg = null;
  function ensureWolfImgs(){
    if (!wolfRunFrames.length){
      const shifts = [-1, -0.33, 0.33, 1];
      for (const s of shifts){
        wolfRunFrames.push( svgToImage(svgWerewolfRunFrame(s), (api?.TILE||60)*1.35, (api?.TILE||60)*1.05) );
      }
    }
    if (!wolfAttackImg){
      wolfAttackImg = svgToImage(svgWerewolfAttack(), (api?.TILE||60)*1.6, (api?.TILE||60)*1.6);
    }
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
  const HA_LIST = []; // render positions
  function spawnHA(sx, sy){
    const t = performance.now();
    if (t - lastHa < 2400) return;
    lastHa = t;
    for (let i=0;i<3;i++){
      HA.push({ x: sx + (i*4), y: sy - (i*2), vx: 0.22 + Math.random()*0.15, vy: -0.35 - Math.random()*0.18, age: 0, life: 90 + (Math.random()*20|0), rot: (Math.random()*0.6 - 0.3) });
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

  // ---------------- wolves (cadenced attack windows + proper damage) ----------------
  function spawnWerewolf(){
    ensureWolfImgs();
    const p = api?.player||{x:0,y:0};
    const off = (api?.TILE||60) * (2.2 + Math.random()*1.3);
    const ang = Math.random()*Math.PI*2;
    const x = p.x + Math.cos(ang)*off;
    const y = p.y + Math.sin(ang)*off;
    const now = performance.now();
    WOLVES.push({
      x, y, vx:0, vy:0, age:0,
      life: 12000 + ((Math.random()*2500)|0),
      mode: 'run',                 // 'run' -> 'attack' (1s) -> 'run' (3s) -> repeat when near player
      runPhase: Math.random(),     // 0..1 loop
      attackMouth: 0,              // 0..1 open
      damageCd: 0,                 // ms cooldown for dmg ticks
      nextAttackAt: now + 600,     // first lunge slightly after spawn (if in range)
      attackEndAt: 0
    });
  }

  function updateWolves(dt){
    const p = api?.player||{x:0,y:0};
    const now = performance.now();
    for (let i=WOLVES.length-1;i>=0;i--){
      const w=WOLVES[i];
      w.age += dt;

      const dx = p.x - w.x, dy = p.y - w.y;
      const d  = Math.hypot(dx,dy)||1;
      const ux = dx/d, uy = dy/d;

      const baseSp = 0.09;  // quick sprint
      const atkSp  = 0.065; // slower stalk while biting
      const engageRange = (api?.TILE||60) * 1.15; // must be close to show attack window
      const biteRange   = (api?.TILE||60) * 0.95;

      // cadence: only enter attack for ~1s, then ~3s run, repeat while close
      if (w.mode === 'run'){
        if (d < engageRange && now >= (w.nextAttackAt||0)){
          w.mode = 'attack';
          w.attackEndAt = now + 1000;   // 1s attack window
          w.nextAttackAt = now + 4000;  // next lunge after 3s run (1s attack + 3s pause)
        }
      } else if (w.mode === 'attack'){
        if (now >= w.attackEndAt){
          w.mode = 'run';
        }
      }

      if (w.mode==='run'){
        w.vx = w.vx*0.90 + ux*baseSp;
        w.vy = w.vy*0.90 + uy*baseSp;
        w.runPhase = (w.runPhase + dt*0.0042) % 1;  // visible leg cycle
        // mouth relax
        w.attackMouth = Math.max(0, w.attackMouth - dt*0.003);
      }else{ // attack
        w.vx = w.vx*0.90 + ux*atkSp;
        w.vy = w.vy*0.90 + uy*atkSp;
        // snap mouth open based on remaining time fraction
        const k = 1 - Math.max(0, Math.min(1, (w.attackEndAt - now)/1000));
        w.attackMouth = Math.min(1, Math.max(w.attackMouth, k));
        // damage ticks while inside bite range
        if (d < biteRange){
          w.damageCd += dt;
          if (w.damageCd >= 400){
            w.damageCd = 0;
            try{ IZZA.emit?.('player-hit', { by: 'werewolf', dmg: 1 }); }catch{}
          }
        }else{
          w.damageCd = 0;
        }
      }

      w.x += w.vx * dt;
      w.y += w.vy * dt;

      if (w.age > w.life) WOLVES.splice(i,1);
    }
  }

  function drawGiantMouth(ctx, sx, sy, k){
    const r = 26 + 34*k; // grows huge
    ctx.save();
    ctx.globalCompositeOperation='source-over';
    ctx.beginPath(); ctx.ellipse(sx+6, sy-10, r*1.2, r*0.9, 0, 0, Math.PI*2);
    ctx.fillStyle = '#100000'; ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = '#3a0000'; ctx.stroke();

    ctx.fillStyle = '#e8e8e8'; ctx.strokeStyle='#6a0000'; ctx.lineWidth=1;
    const teeth = 11;
    for(let i=0;i<teeth;i++){
      const ang = (i/teeth)*Math.PI*2;
      const tx = sx+6 + Math.cos(ang)*(r*1.05);
      const ty = sy-10 + Math.sin(ang)*(r*0.8);
      ctx.beginPath(); ctx.moveTo(tx,ty);
      ctx.lineTo(tx + Math.cos(ang)*10, ty + Math.sin(ang)*8);
      ctx.lineTo(tx + Math.cos(ang+0.2)*6, ty + Math.sin(ang+0.2)*5);
      ctx.closePath(); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  }

  function drawWolves(ctx){
    if (!WOLVES.length && !HA.length) return;
    const S=api.DRAW, T=api.TILE, px=S/T, now=performance.now();
    for (const w of WOLVES){
      const sx=(w.x - api.camera.x)*px;
      const sy=(w.y - api.camera.y)*px;

      // shadow
      ctx.save();
      ctx.globalAlpha = 0.32;
      ctx.beginPath(); ctx.ellipse(sx, sy+14, 14, 6, 0, 0, Math.PI*2); ctx.fillStyle='#000'; ctx.fill();
      ctx.restore();

      if (w.mode==='run'){
        const idx = (w.runPhase < 0.25) ? 0 : (w.runPhase < 0.5) ? 1 : (w.runPhase < 0.75) ? 2 : 3;
        const img = wolfRunFrames[idx];
        if (img?.complete) ctx.drawImage(img, sx-48, sy-52);
      }else{
        if (wolfAttackImg?.complete){
          const m = 1.25 + 0.45*w.attackMouth; // scales up during attack
          ctx.save();
          ctx.translate(sx, sy-6);
          ctx.scale(m, m);
          ctx.drawImage(wolfAttackImg, -56, -78);
          ctx.restore();
          drawGiantMouth(ctx, sx+4, sy-6, w.attackMouth);
        }
      }

      // single glowing eye
      ctx.save();
      ctx.globalCompositeOperation='lighter';
      const flick = 0.58 + 0.32*Math.abs(Math.sin(now*0.012));
      ctx.globalAlpha = flick;
      ctx.fillStyle='rgba(255,45,45,0.95)';
      const ex = w.mode==='run' ? sx+22 : sx+18;
      const ey = w.mode==='run' ? sy-12 : sy-24;
      ctx.beginPath(); ctx.arc(ex, ey, 5, 0, Math.PI*2); ctx.fill();
      ctx.restore();
    }
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

  // ---------------- render ----------------
  function renderM5Under(){
    try{
      if (!api?.ready) return;
      const force = localStorage.getItem('izzaForceM5') === '1';
      const tier2 = localStorage.getItem('izzaMapTier') === '2';
      const m4done = isMission4Done();
      const taken = localStorage.getItem(JACK_TAKEN_KEY) === '1';

      const S=api.DRAW, t=api.TILE;
      const ctx=document.getElementById('game')?.getContext('2d'); if(!ctx) return;

      // Draw JACK
      if ((!mission5Active || force) && (!taken || force) && ((tier2 && m4done) || force)){
        const g=jackGrid();
        const sx=(g.x*t - api.camera.x)*(S/t) + S*0.5;
        const sy=(g.y*t - api.camera.y)*(S/t) + S*0.6;
        if (!jackImg) jackImg = svgToImage(svgJack(), (api.TILE*JACK_MULT)|0, (api.TILE*JACK_MULT)|0);
        if (jackImg.complete){
          const w = (api.TILE*JACK_MULT) * (S/api.TILE);
          const h = w;
          ctx.save();
          const grd = ctx.createRadialGradient(sx, sy, w*0.05, sx, sy, w*0.55);
          grd.addColorStop(0, `rgba(255,190,70,0.38)`);
          grd.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.globalCompositeOperation='lighter';
          ctx.fillStyle=grd; ctx.beginPath(); ctx.arc(sx, sy, w*0.55, 0, Math.PI*2); ctx.fill();
          ctx.restore();
          ctx.drawImage(jackImg, sx - w/2, sy - h/2, w, h);
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

      updateHA();
      drawHA(ctx);
    }catch{}
  }

  function renderM5Over(){
    try{
      if (!api?.ready) return;
      const ctx=document.getElementById('game')?.getContext('2d'); if(!ctx) return;
      drawWolves(ctx); // above map/player
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

    for(const p of pumpkins){
      if(!p.collected && isNearGrid(p.tx, p.ty, (api?.TILE||60)*0.85)){
        p.collected=true;
        const inv=invRead();
        _addOne(inv, 'pumpkin_piece', 'Pumpkin');
        invWrite(inv);
        IZZA.toast?.('+1 Pumpkin');
        // IMPORTANT: do NOT auto-craft or end here anymore.
        return;
      }
    }
  }

  function wireB(){
    document.getElementById('btnB')?.addEventListener('click', onB, true);
    window.addEventListener('keydown', e=>{ if((e.key||'').toLowerCase()==='b') onB(e); }, true);
  }

  // ---------------- spooky choice (fallback) ----------------
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
    card.style.cssText='min-width:300px;max-width:560px;padding:16px;border-radius:14px;background:#0b0f1a;color:#cfe0ff;border:1px solid #2a3550';
    card.innerHTML='<div style="font-weight:900;font-size:18px;margin-bottom:6px">WELCOME TO IZZA CITY AT NIGHT</div><div style="opacity:.9;margin-bottom:10px">Take the jack-o’-lantern to begin a 5-minute night run. Collect 3 pumpkins and craft Pumpkin Armour.</div>';
    const row=document.createElement('div'); row.style.cssText='display:flex;gap:8px;justify-content:flex-end';
    const bNo=document.createElement('button'); bNo.textContent='Leave'; bNo.style.cssText='padding:8px 12px;border-radius:8px;border:0;background:#263447;color:#cfe3ff;font-weight:800;cursor:pointer';
    const bGo=document.createElement('button'); bGo.textContent='Take Jack-o’-Lantern'; bGo.style.cssText='padding:10px 14px;border-radius:10px;border:0;background:#1f6feb;color:#fff;font-weight:900;cursor:pointer';
    row.appendChild(bNo); row.appendChild(bGo); card.appendChild(row); wrap.appendChild(card); (document.getElementById('gameCard')||document.body).appendChild(wrap);
    bNo.onclick=()=>wrap.remove();
    bGo.onclick=()=>{ try{ onAccept?.(); }finally{ wrap.remove(); } };
  }

  // ---------------- mission flow ----------------
  function startNightMission(){
    setNight(true);
    mission5Active=true;
    mission5Start=performance.now();
    werewolfNext=mission5Start+500;
    placePumpkins();
    ensureTimer();
    _m5CongratsShown = false; // reset each run
    try{ IZZA.emit('celebrate',{style:'spray-skull'}); }catch{}
    IZZA.toast?.('Night Mission started — collect 3 pumpkins, then craft Pumpkin Armour in the Armoury!');
  }

  // NOTE: No auto-crafting here. Crafting & completion come from armoury or inv checks.
  function tryCraftPumpkin(){ return false; }

  function bumpMission5UI(){
    _setMissions(5);
    try{ IZZA?.api?.inventory?.setMeta?.('missionsCompleted', 5); }catch{}
    try{ localStorage.setItem('izzaMission5_done','1'); }catch{}
    try{ IZZA.emit('missions-updated',{completed:5}); }catch{}
    try{ IZZA.emit('mission-complete',{id:5,name:'Night of the Lantern'}); }catch{}
    try{ window.dispatchEvent(new Event('izza-missions-changed')); }catch{}
  }
  function unlockMission6(){
    try{ localStorage.setItem('izzaMission6_unlocked','1'); }catch{}
    try{ IZZA.emit('mission-available',{id:6,name:'Mission 6'}); }catch{}
    try{ IZZA.emit('m6-unlocked'); }catch{}
  }

  // ---------- M5 “Congratulations” popup (same UI style you provided) ----------
  function ensureCongratsUI(){
    if (document.getElementById('missionCongrats')) return;
    const wrap = document.createElement('div');
    wrap.id = 'missionCongrats';
    wrap.style.cssText = 'position:absolute;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.55);z-index:140;';
    wrap.innerHTML =
      `<div style="min-width:280px;max-width:420px;background:#111b29;border:1px solid #2b3b57;border-radius:12px;padding:16px;color:#e7eef7;box-shadow:0 16px 44px rgba(0,0,0,.6)">
         <div style="font-weight:800;font-size:18px;margin-bottom:6px">🎉 Mission Complete!</div>
         <div id="missionCongratsBody" style="opacity:.9;margin-bottom:10px"></div>
         <button id="missionCongratsOk" style="width:100%;padding:10px;border:0;border-radius:8px;background:#1f6feb;color:#fff;font-weight:700;cursor:pointer">OK</button>
       </div>`;
    document.body.appendChild(wrap);
    wrap.querySelector('#missionCongratsOk').onclick = ()=> wrap.style.display='none';
  }
  function showCongrats(text){
    ensureCongratsUI();
    const w = document.getElementById('missionCongrats');
    const b = document.getElementById('missionCongratsBody');
    if (b) b.textContent = text;
    if (w) w.style.display = 'flex';
  }

  function finishMission5(){
    mission5Active=false;
    setNight(false);
    clearPumpkins();
    clearTimer();
    WOLVES.length = 0;

    bumpMission5UI();
    unlockMission6();

    // keep existing small completion popup too
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
    const dt = Math.max(16, now - (_lastTick||now)); _lastTick = now;

    if (mission5Active){
      // timer expiry fails mission
      if ((now - mission5Start) > M5_MS){
        mission5Active=false;
        setNight(false);
        clearPumpkins();
        clearTimer();
        WOLVES.length=0;
        try{ localStorage.removeItem(JACK_TAKEN_KEY); }catch{}
        _m5CongratsShown = false;
        IZZA.toast?.('Mission 5 failed — time expired.');
      }

      // spawn wolves periodically while player moves
      if (now >= werewolfNext){
        if (isMoving()) spawnWerewolf();
        // spawn every ~28s like before
        werewolfNext = now + 28000;
      }

      updateTimer(now);
    }

    // wolf physics/AI
    updateWolves(dt*0.06);
  }

  // ---------------- wire up ----------------
  try { IZZA.on('render-under', renderM5Under); } catch {}
  try { IZZA.on('render-post',  renderM5Over); } catch {}
  try { IZZA.on('update-post',  onUpdate); } catch {}

  IZZA.on?.('ready', (a)=>{
    api = a;
    IZZA.on?.('render-under', renderM5Under);
    IZZA.on?.('render-post',  renderM5Over);
    IZZA.on?.('update-post',  onUpdate);
    wireB();
    // (no auto-crafting on ready)
  });

  // ---------- Mission 5 completion via inventory check (like Mission 4) ----------
  const PUMPKIN_SET_IDS = [
    'pumpkinHelmet',
    'pumpkinVest',
    'pumpkinArms',
    'pumpkinLegs'
  ];
  const PUMPKIN_ALIAS = {
    pumpkin_helm: 'pumpkinHelmet',
    pumpkin_chest: 'pumpkinVest',
    pumpkin_arms: 'pumpkinArms',
    pumpkin_legs: 'pumpkinLegs'
  };

  function hasFullPumpkinSet(){
    return PUMPKIN_SET_IDS.every(id=>{
      if (invCount(id) > 0) return true;
      const alias = Object.keys(PUMPKIN_ALIAS).find(k => PUMPKIN_ALIAS[k]===id);
      return alias ? (invCount(alias) > 0) : false;
    });
  }

  function maybeFinishM5(){
    if (!mission5Active) return;
    if (hasFullPumpkinSet()){
      if (!_m5CongratsShown) showCongrats('Pumpkin Armour crafted — Mission 5 Completed!');
      _m5CongratsShown = true;
      finishMission5();
    }
  }

  // Inventory changes during the run: mirror M4 — complete once the full set exists
  window.addEventListener('izza-inventory-changed', ()=>{
    try{ IZZA.emit?.('render-under'); }catch{}
    maybeFinishM5();
  });

  // Armoury craft clicks are the preferred finish trigger (when they’re emitted):
  IZZA.on?.('gear-crafted',  ({kind,set})=>{
    if(kind==='pumpkin' || set==='pumpkin'){
      if (!_m5CongratsShown) showCongrats('Pumpkin Armour crafted — Mission 5 Completed!');
      _m5CongratsShown = true;
      finishMission5();
    }
  });
  IZZA.on?.('armor-crafted', ({kind,set})=>{
    if(kind==='pumpkin' || set==='pumpkin'){
      if (!_m5CongratsShown) showCongrats('Pumpkin Armour crafted — Mission 5 Completed!');
      _m5CongratsShown = true;
      finishMission5();
    }
  });

  // ---------- NEW: Death during mission = fail + end timer/night + respawn Jack ----------
  IZZA.on?.('player-died', ()=>{
    if (!mission5Active) return;
    mission5Active = false;
    setNight(false);
    clearPumpkins();
    clearTimer();
    WOLVES.length = 0;
    // respawn Jack so the player can try again
    try{ localStorage.removeItem(JACK_TAKEN_KEY); }catch{}
    _m5CongratsShown = false;
    IZZA.toast?.('Mission 5 failed — you were taken out!');
  });

  IZZA.on?.('shutdown', ()=>{ clearTimer(); setNight(false); WOLVES.length=0; });

})();
