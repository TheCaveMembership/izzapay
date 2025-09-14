/* mission5_halloween.plugin.js — Mission 5 (evil jack, HA-smoke, night run)
   - JACK shows at HQ +8E, +3N when M4 is complete and not yet taken.
   - Press B on JACK → spooky accept UI → +1 jack to inventory, start 5m night, spawn pumpkins.
   - 3 pumpkin pieces (two original, third moved to +8E, +7N). Werewolf spawns every 30s while moving.
   - Timer HUD during mission. Armoury popup renders OVER night dimmer. On timeout: jack respawns.
   - Craft in armoury with 1 jack + 3 pieces; grants 4 pumpkin armour pieces with set DR and legs speed.
   - HA “smoke” floats from mouth every ~2.5s (4× larger text).
   - Debug: localStorage.izzaM5Debug='1' (HUD chip), localStorage.izzaForceM5='1' (force show)
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

  // ---- Canonical inventory adders + one-time alias cleanup (prevents double-counting)
  function _addOne(inv, canonicalKey, displayName){
    inv[canonicalKey] = inv[canonicalKey] || { count: 0, name: displayName || canonicalKey };
    inv[canonicalKey].count = (inv[canonicalKey].count|0) + 1;
  }
  (function _aliasCleanupOnce(){
    const inv = invRead();
    // Merge pumpkin alias -> canonical
    if (inv.pumpkin) {
      inv.pumpkin_piece = inv.pumpkin_piece || { count: 0, name: 'Pumpkin' };
      inv.pumpkin_piece.count = (inv.pumpkin_piece.count|0) + (inv.pumpkin.count|0);
      delete inv.pumpkin;
    }
    // Merge jack alias -> canonical
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
  // JACK at +8E, +3N
  function jackGrid(){ const d=hqDoorGrid(); return { x:d.gx+8, y:d.gy-3 }; }

  // pumpkins: keep 2 as-is; move #3 to +8E +7N
  function computePumpkinTiles(){
    const d=hqDoorGrid();
    const p1={ tx:d.gx-15, ty:d.gy+10 };
    const p2={ tx:p1.tx-20, ty:p1.ty+13 };
    const p3={ tx:d.gx+8,  ty:d.gy-7 }; // updated location
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

  // ---------------- pumpkins ----------------
  function placePumpkins(){
    pumpkins.length=0;
    const tiles=computePumpkinTiles();
    for(const t of tiles){
      pumpkins.push({ tx:t.tx, ty:t.ty, collected:false, img: svgToImage(svgPumpkinSmall(), api?.TILE||60, api?.TILE||60) });
    }
  }
  function clearPumpkins(){ pumpkins.length=0; }

  // ---------------- night overlay (z-index below armoury UI) ----------------
  function setNight(on){
    if(on===nightOn) return;
    nightOn=on;
    const id='m5-night-overlay';
    let el=document.getElementById(id);
    if(on){
      if(!el){
        el=document.createElement('div');
        el.id=id;
        // LOWER z-index so Armoury UI sits on top (core armoury typically >3000)
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

  // ---------------- render ----------------
  function renderM5(){
    try{
      if (!api?.ready) return;
      const force = localStorage.getItem('izzaForceM5') === '1';
      const tier2 = localStorage.getItem('izzaMapTier') === '2';
      const m4done = isMission4Done();
      const taken = localStorage.getItem(JACK_TAKEN_KEY) === '1';

      hud(`M5 • tier2:${tier2} • m4:${m4done} • taken:${taken} • active:${mission5Active} • pumpkins:${pumpkins.length} • night:${nightOn}`);

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

      // pumpkins (during mission)
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

      // smoke glyphs
      updateHA();
      drawHA(ctx);
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

    // JACK tile → spooky accept dialog → take + start mission
    if ((!taken || force) && (!mission5Active || force) && (gx===g.x && gy===g.y)){
      if (force || (tierOK && isMission4Done())){
        e?.preventDefault?.(); e?.stopImmediatePropagation?.(); e?.stopPropagation?.();
        showSpookyChoice(()=> {
          const inv = invRead();
          // ONLY canonical key (prevents double counting)
          _addOne(inv, 'jack_o_lantern', 'Jack-o’-Lantern');
          invWrite(inv);
          try{ localStorage.setItem(JACK_TAKEN_KEY, '1'); }catch{}
          IZZA.toast?.('Jack-o’-Lantern added to Inventory');
          startNightMission();
        });
        return;
      }
    }

    // pumpkin collection → ONLY canonical key
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
    // Try to (re)register the craft action in Armoury
    registerPumpkinArmourRecipeUI();
  }

  function playerInArmoury(){
    if(api?.inZone) return api.inZone('armoury')===true;
    const d = window.__IZZA_ARMOURY__?.door;
    if(!d) return false;
    const me={x:(api?.player?.x||0)/(api?.TILE||60)|0, y:(api?.player?.y||0)/(api?.TILE||60)|0};
    return (Math.abs(me.x-d.x)+Math.abs(me.y-d.y))<=1;
  }

  function tryCraftPumpkin(){
    const inv=invRead();
    const haveJack = (inv.jack_o_lantern?.count|0) > 0; // canonical only
    const pumpkinsC = (inv.pumpkin_piece?.count|0);      // canonical only
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

  function finishMission5(){
    mission5Active=false; setNight(false); clearPumpkins(); clearTimer();
    _setMissions(5);
    try{ IZZA?.api?.inventory?.setMeta?.('missionsCompleted', 5); }catch{}
    try{ IZZA.emit('missions-updated',{completed:5}); }catch{}
    try{ IZZA.emit('mission-complete',{id:5,name:'Night of the Lantern'}); }catch{}
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
  function spawnWerewolf(){
    try{ IZZA.emit('npc-spawn',{kind:'werewolf', host:'mission5'}); }catch{}
    try{ IZZA.emit('sfx',{kind:'werewolf-spawn',vol:0.9}); }catch{}
  }

  // ---------------- Armoury craft UI (register + fallback injector) ---------
  function registerPumpkinArmourRecipeUI(){
    // If an Armoury API exists, register like the cardboard recipe does:
    try{
      if (IZZA?.api?.armoury?.registerRecipe){
        IZZA.api.armoury.registerRecipe({
          id: 'pumpkin_set',
          label: 'Craft Pumpkin Armour',
          needs: [{id:'jack_o_lantern',count:1},{id:'pumpkin_piece',count:3}],
          gives: [{id:'pumpkinHelmet',count:1},{id:'pumpkinVest',count:1},{id:'pumpkinArms',count:1},{id:'pumpkinLegs',count:1}],
          onCraft: ()=>tryCraftPumpkin()
        });
        return;
      }
    }catch{}

    

  // ---------------- update ----------------
  function onUpdate({ now }){
    if (mission5Active){
      if ((now - mission5Start) > M5_MS){
        mission5Active=false; setNight(false); clearPumpkins(); clearTimer();
        try{ localStorage.removeItem(JACK_TAKEN_KEY); }catch{} // respawn jack on fail
        IZZA.toast?.('Mission 5 failed — time expired.');
      }
      if (now >= werewolfNext){
        if (isMoving()) spawnWerewolf();
        werewolfNext = now + 30000;
      }
      updateTimer(now);

      // If player opens armoury during mission, make sure craft option shows
      registerPumpkinArmourRecipeUI();
    }
  }

  // ---------------- wire up ----------------
  try { IZZA.on('render-under', renderM5); } catch {}
  try { IZZA.on('update-post', onUpdate); } catch {}
  IZZA.on?.('ready', (a)=>{
    api = a;
    IZZA.on?.('render-under', renderM5);
    IZZA.on?.('update-post', onUpdate);
    wireB();
    // Pre-register craft button in case player runs to armoury immediately
    registerPumpkinArmourRecipeUI();
  });
  window.addEventListener('izza-inventory-changed', ()=>{ try{ IZZA.emit?.('render-under'); }catch{} });
  IZZA.on?.('shutdown', ()=>{ clearTimer(); setNight(false); });

})();
