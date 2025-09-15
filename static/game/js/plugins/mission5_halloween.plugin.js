Understood. I’ve made only the two requested changes:
	1.	Mission fails on player death (night ends, timer clears, JACK reappears).
	2.	Wolf behavior/appearance: runs normally with a 1-second bi-pedal “giant mouth” attack every ~3 seconds when near the player; single glowing eye; animated legs; real damage applied during the attack.

Here’s the full file with just those adjustments:

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

  // ---------------- NEW werewolf (run cycle, one glowing eye; bi-pedal attack with giant mouth) ----------------
  function svgWerewolfRunFrame(ahead){ // ahead: -1 / +1 leg offset
    // simplified silhouette with slight leg offsets for a “run” cycle
    const legShift = ahead * 4;
    return `
<svg viewBox="0 0 160 120" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="eye" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#ff3b3b"/><stop offset="100%" stop-color="#5a0000"/>
    </radialGradient>
  </defs>
  <g fill="#0b0b0b" stroke="#060606" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round">
    <!-- long low body with ragged fur -->
    <path d="M16,86 C28,66 40,56 62,52 C88,48 110,50 140,58 C144,70 130,82 102,88 C72,94 44,92 24,90 Z"/>
    <!-- head + ear -->
    <path d="M118,54 C128,48 140,46 148,48 C152,52 150,58 142,62 L130,64 C126,60 122,58 118,56 Z"/>
    <path d="M120,46 L128,36 L136,46"/>
    <!-- legs (front/back offset) -->
    <path d="M58,88 C56,100 50,110 48,116 L40,116 C42,108 42,100 40,90 Z" transform="translate(${legShift},0)"/>
    <path d="M92,88 C92,100 86,110 84,116 L76,116 C78,108 78,100 76,90 Z" transform="translate(${-legShift},0)"/>
    <path d="M126,82 C128,94 124,106 122,114 L114,114 C116,106 116,96 114,86 Z" />
    <path d="M28,88 C22,98 20,108 18,114 L10,114 C14,104 16,94 16,86 Z" />
  </g>
  <!-- single eye -->
  <ellipse cx="126" cy="58" rx="6" ry="4.4" fill="url(#eye)"/>
</svg>`;
  }
  function svgWerewolfAttack(){ // standing bi-pedal with huge mouth
    return `
<svg viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="eye" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#ff3b3b"/><stop offset="100%" stop-color="#5a0000"/>
    </radialGradient>
  </defs>
  <g fill="#0b0b0b" stroke="#060606" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round">
    <!-- torso standing -->
    <path d="M72,48 C84,34 112,34 124,52 C134,68 132,98 120,116 C108,134 88,140 74,126 C60,112 54,80 60,64 Z"/>
    <!-- legs -->
    <path d="M84,116 C84,132 78,146 76,152 L66,152 C70,140 70,128 68,114 Z"/>
    <path d="M112,114 C116,130 112,146 110,152 L100,152 C102,140 102,126 100,112 Z"/>
    <!-- arms up -->
    <path d="M68,76 L54,60 L48,68 L64,90"/>
    <path d="M122,76 L138,58 L146,66 L126,92"/>
  </g>
  <!-- one glowing eye -->
  <ellipse cx="112" cy="64" rx="6.2" ry="4.6" fill="url(#eye)"/>
  <!-- ENORMOUS mouth (nearly full body) -->
  <g>
    <path d="M60,78 C86,94 116,94 138,78
             C135,110 86,132 62,110 Z"
          fill="#160000" stroke="#3a0000" stroke-width="2"/>
    <!-- teeth -->
    <g fill="#e6e6e6" stroke="#6a0000" stroke-width="1">
      <path d="M70,86 L74,96 L78,86 Z"/>
      <path d="M82,88 L86,100 L90,88 Z"/>
      <path d="M94,90 L98,102 L102,90 Z"/>
      <path d="M106,88 L110,100 L114,88 Z"/>
      <path d="M118,86 L122,96 L126,86 Z"/>
    </g>
  </g>
</svg>`;
  }

  let wolfRunImgA=null, wolfRunImgB=null, wolfAttackImg=null;
  function ensureWolfImgs(){
    if (!wolfRunImgA) wolfRunImgA = svgToImage(svgWerewolfRunFrame(-1), (api?.TILE||60)*1.3, (api?.TILE||60)*1.0);
    if (!wolfRunImgB) wolfRunImgB = svgToImage(svgWerewolfRunFrame(+1), (api?.TILE||60)*1.3, (api?.TILE||60)*1.0);
    if (!wolfAttackImg) wolfAttackImg = svgToImage(svgWerewolfAttack(), (api?.TILE||60)*1.4, (api?.TILE||60)*1.4);
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

  // ---------------- wolves (run cycle + timed 1s attack windows) ----------------
  function spawnWerewolf(){
    ensureWolfImgs();
    const p = api?.player||{x:0,y:0};
    const off = (api?.TILE||60) * (2.2 + Math.random()*1.3);
    const ang = Math.random()*Math.PI*2;
    const x = p.x + Math.cos(ang)*off;
    const y = p.y + Math.sin(ang)*off;
    const now = performance.now ? performance.now() : Date.now();
    WOLVES.push({
      x, y, vx:0, vy:0, age:0,
      life: 12000 + ((Math.random()*2500)|0),
      mode: 'run',                // 'run' (default) -> 'attack' for 1s windows
      runPhase: Math.random()*1.0, // 0..1 loop for legs
      attackMouth: 0,             // 0..1
      damageTick: 0,              // applies during attack
      nextAttackAt: now + 1500 + (Math.random()*1200|0), // first window
      attackEndAt: 0
    });
  }

  // damage helper: integrate with hearts system + fallback
  function wolfDamagePlayer(amountSegs){
    try { IZZA.emit?.('player-hit', { by:'werewolf', dmg: amountSegs }); } catch {}
    try { IZZA.emit?.('player-damage', { source:'werewolf', amount: amountSegs }); } catch {}
    try { IZZA.api?.player?.damage?.(amountSegs); } catch {}
    try{
      const k='izzaHearts'; const cur=parseFloat(localStorage.getItem(k)||'0')||0;
      if (cur>0){ localStorage.setItem(k, String(Math.max(0, cur-amountSegs))); IZZA.emit?.('hearts-updated',{hearts:Math.max(0,cur-amountSegs)}); }
    }catch{}
  }

  function updateWolves(dt){
    const p = api?.player||{x:0,y:0};
    const now = performance.now ? performance.now() : Date.now();
    for (let i=WOLVES.length-1;i>=0;i--){
      const w=WOLVES[i];
      w.age += dt;

      // seek vector
      const dx = p.x - w.x, dy = p.y - w.y;
      const d  = Math.hypot(dx,dy)||1;
      const ux = dx/d, uy = dy/d;

      // speeds (no vertical bobbing)
      const baseSp = 0.085;
      const atkSp  = 0.060;

      // determine mode based on range + timed attack windows
      const inRange = d < (api?.TILE||60)*1.2;
      if (w.mode === 'run'){
        // enter attack only if inRange AND its 1s window is open
        if (inRange && now >= w.nextAttackAt){
          w.mode = 'attack';
          w.attackMouth = 0;
          w.damageTick = 0;
          w.attackEndAt = now + 1000;         // attack lasts 1 second
        }
      }else if (w.mode === 'attack'){
        if (now >= w.attackEndAt){
          w.mode = 'run';
          w.attackMouth = 0;
          w.nextAttackAt = now + 3000;        // next attack window in ~3s
        }
      }

      // movement + anim
      if (w.mode==='run'){
        w.vx = w.vx*0.90 + ux*baseSp;
        w.vy = w.vy*0.90 + uy*baseSp;
        w.runPhase = (w.runPhase + (dt*0.0035)) % 1; // swap run frames
      }else{ // attack
        w.vx = w.vx*0.90 + ux*atkSp;
        w.vy = w.vy*0.90 + uy*atkSp;
        w.attackMouth = Math.min(1, w.attackMouth + dt*0.0035); // open fast
        w.damageTick += dt;
        // deal damage only during attack, about 1 seg per 500ms (2 seg/s)
        if (w.damageTick > 500){
          w.damageTick = 0;
          if (inRange) wolfDamagePlayer(1);
        }
      }

      // advance position
      w.x += w.vx * dt;
      w.y += w.vy * dt;

      // drip “drool” while moving/attacking (subtle trail)
      if ((w.age|0) % 220 < 16) {
        HA_LIST.push({x:w.x, y:w.y+8, vx:(Math.random()*0.05-0.025), vy:0.06, age:0, life:500});
      }

      // lifetime expiry
      if (w.age > w.life) WOLVES.splice(i,1);
    }

    // drool update
    for (let i=HA_LIST.length-1;i>=0;i--){
      const p0=HA_LIST[i]; p0.age+=dt; p0.x+=p0.vx*dt; p0.y+=p0.vy*dt; p0.vy+=0.0004*dt;
      if (p0.age>p0.life) HA_LIST.splice(i,1);
    }
  }

  function drawWolves(ctx){
    if (!WOLVES.length && !HA.length) return;
    const S=api.DRAW, T=api.TILE, px=S/T;
    for (const w of WOLVES){
      const sx=(w.x - api.camera.x)*px;
      const sy=(w.y - api.camera.y)*px;

      // shadow
      ctx.save();
      ctx.globalAlpha = 0.32;
      ctx.beginPath(); ctx.ellipse(sx, sy+14, 14, 6, 0, 0, Math.PI*2); ctx.fillStyle='#000'; ctx.fill();
      ctx.restore();

      if (w.mode==='run'){
        const frame = (w.runPhase < 0.5 ? wolfRunImgA : wolfRunImgB);
        if (frame?.complete){
          ctx.drawImage(frame, sx-44, sy-50);
        }
      }else{
        if (wolfAttackImg?.complete){
          // mouth scale as it opens
          const m = 1 + 0.22*w.attackMouth;
          ctx.save();
          ctx.translate(sx, sy-8);
          ctx.scale(m, m);
          ctx.drawImage(wolfAttackImg, -50, -70);
          ctx.restore();
        }
      }

      // single eye glow (no back dots)
      ctx.save();
      ctx.globalCompositeOperation='lighter';
      const flick = 0.55 + 0.30*Math.abs(Math.sin(performance.now()*0.012));
      ctx.globalAlpha = flick;
      ctx.fillStyle='rgba(255,45,45,0.95)';
      const ex = w.mode==='run' ? sx+18 : sx+14;
      const ey = w.mode==='run' ? sy-10 : sy-22;
      ctx.beginPath(); ctx.arc(ex, ey, 4.8, 0, Math.PI*2); ctx.fill();
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
