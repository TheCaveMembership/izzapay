// mission4_armoury.js — Mission 4 minimal (NO shop UI)
// - Draws a cardboard box near HQ.
// - Press B ON the box to pick it up (confirm), updates inventory.
// - Does NOT add any armoury/shop items or override island docking.
// - Plays nice with v2_map_expander.js (which handles island door & docking).

(function(){
  const BOX_TAKEN_KEY  = 'izzaBoxTaken';
  const M4_KEY         = 'izzaMission4'; // 'started' / 'not-started'
  const BOX_SPENT_KEY  = 'izzaBoxSpentForCardboardSet'; // guard so we only spend once

  let api = null;

  // --- global mission enable check (Solo only) -------------------------------
  function missionsEnabled(){
    try { return !!window.__IZZA_MISSIONS_ENABLED__; } catch { return true; }
  }

  // ---------- helpers: inventory (wallet untouched) ----------
  function readInv(){
    try{
      if (IZZA?.api?.getInventory) return JSON.parse(JSON.stringify(IZZA.api.getInventory()||{}));
      const raw = localStorage.getItem('izzaInventory');
      return raw ? JSON.parse(raw) : {};
    }catch{ return {}; }
  }
  function writeInv(inv){
    try{
      if (IZZA?.api?.setInventory) IZZA.api.setInventory(inv);
      else localStorage.setItem('izzaInventory', JSON.stringify(inv));
      try { window.dispatchEvent(new Event('izza-inventory-changed')); } catch {}
    }catch{}
  }
  function addCount(inv, key, n){
    inv[key] = inv[key] || { count: 0 };
    inv[key].count = (inv[key].count|0) + n;
    if (inv[key].count <= 0) delete inv[key];
  }
  function getCount(inv, key){ return (inv?.[key]?.count|0) || 0; }

  function setM4(v){ try{ localStorage.setItem(M4_KEY, v); }catch{} }

  // ---------- HQ door → box position (freeze once so it doesn't move) ----------
  let _hqBase = null;
  function hqDoorGrid(){
    if (_hqBase) return _hqBase;
    const t = api?.TILE || 60;
    // Prefer real doorSpawn; if missing, snapshot player's current pos ONCE
    const d = (api?.doorSpawn && Number.isFinite(api.doorSpawn.x))
      ? api.doorSpawn
      : { x: api?.player?.x||0, y: api?.player?.y||0 };
    _hqBase = { gx: Math.round(d.x/t), gy: Math.round(d.y/t) };
    return _hqBase;
  }
  // same offsets as your original mission script
  function cardboardBoxGrid(){
    const d = hqDoorGrid();
    return { x: d.gx + 3, y: d.gy + 10 };
  }

  // ---------- fireworks ----------
  function worldToScreen(wx, wy){
    const S = api.DRAW, T = api.TILE;
    const sx = (wx - api.camera.x) * (S/T);
    const sy = (wy - api.camera.y) * (S/T);
    return { sx, sy };
  }

  function spawnFireworksAt(sx, sy){
    try{
      let canvas = document.createElement('canvas');
      const game = document.getElementById('game');
      canvas.width  = game.width;
      canvas.height = game.height;
      canvas.style.cssText = 'position:absolute;inset:0;margin:auto;z-index:10000;pointer-events:none;';
      canvas.id = 'm4FireworksOverlay';
      document.body.appendChild(canvas);
      const ctx = canvas.getContext('2d');

      const particles = [];
      const GOLD = ['#ffd23f','#ffcc33','#ffe680'];
      const SILV = ['#cfd8dc','#e0e0e0','#f5f7f9'];
      const NEON = ['#00e5ff','#ff00ff','#39ff14'];

      function addBurst(cx, cy, n, speed, neonBottom){
        for(let i=0;i<n;i++){
          const ang = (Math.PI*2)*(i/n) + Math.random()*0.3;
          const v   = speed*(0.7 + Math.random()*0.6);
          const topCol = Math.random() < 0.7 ? GOLD[(Math.random()*GOLD.length)|0] : SILV[(Math.random()*SILV.length)|0];
          const neonCol= NEON[(Math.random()*NEON.length)|0];
          particles.push({
            x:cx, y:cy,
            vx:Math.cos(ang)*v, vy:Math.sin(ang)*v - 0.45,
            life: 110 + (Math.random()*30|0),
            age: 0,
            r: 1.6 + Math.random()*1.4,
            colTop: topCol,
            colNeon: neonBottom ? neonCol : topCol,
          });
        }
      }
      function addSpray(cx, cy, dir, n, speed){
        for(let i=0;i<n;i++){
          const a = dir + (Math.random()-0.5)*0.4;
          const v = speed*(0.6+Math.random()*0.8);
          particles.push({
            x:cx, y:cy,
            vx:Math.cos(a)*v, vy:Math.sin(a)*v - 0.35,
            life: 90 + (Math.random()*30|0),
            age: 0,
            r: 1.2 + Math.random()*1.0,
            colTop: GOLD[(Math.random()*GOLD.length)|0],
            colNeon: NEON[(Math.random()*NEON.length)|0],
          });
        }
      }

      const skullPath = new Path2D("M16 3c-3.9 0-7 3.1-7 7v2c0 2 1 3 2 4v4c0 .6.4 1 1 1h1c.6 0 1-.4 1-1v-4c1-1 2-2 2-4V10c0-3.9-3.1-7-7-7Zm-3 10a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm6 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Z");

      addBurst(sx, sy, 80, 5.0, true);
      addBurst(sx+12, sy-8, 60, 4.4, true);
      addBurst(sx-14, sy-12, 50, 4.0, false);
      addSpray(sx, sy+6, Math.PI*0.53, 50, 5.5);
      addSpray(sx, sy+6, Math.PI*0.47 + Math.PI, 50, 5.5);

      let frame = 0;
      const maxFrames = 220;
      (function tick(){
        frame++;
        ctx.clearRect(0,0,canvas.width, canvas.height);

        ctx.save();
        const rg = ctx.createRadialGradient(sx, sy, 0, sx, sy, Math.max(canvas.width, canvas.height)*0.55);
        rg.addColorStop(0, 'rgba(255,215,64,0.28)');
        rg.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = rg; ctx.fillRect(0,0,canvas.width,canvas.height);

        ctx.globalAlpha = 0.18 + 0.10*Math.sin(frame*0.18);
        ctx.translate(sx, sy); ctx.scale(3.6, 3.6);
        ctx.fillStyle = 'rgba(200,200,220,0.55)'; ctx.fill(skullPath);
        ctx.restore();

        for (let i=particles.length-1; i>=0; i--){
          const p = particles[i];
          p.age++; if (p.age >= p.life){ particles.splice(i,1); continue; }
          p.vy += 0.055; p.vx *= 0.995; p.x  += p.vx; p.y  += p.vy;

          const k = p.age / p.life;
          const useNeon = (k > 0.65);
          const col = useNeon ? p.colNeon : p.colTop;

          if (!useNeon){
            ctx.beginPath(); ctx.arc(p.x, p.y, p.r*2.8, 0, Math.PI*2);
            ctx.fillStyle = 'rgba(255,230,120,0.24)'; ctx.fill();
          }

          ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI*2); ctx.fillStyle = col; ctx.fill();

          if ((p.age % 9) === 0){
            ctx.save(); ctx.globalAlpha = 0.4; ctx.strokeStyle = col; ctx.lineWidth = 1.2;
            ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx*2.4, p.y - p.vy*2.4); ctx.stroke(); ctx.restore();
          }
        }

        if (frame < maxFrames && particles.length){
          requestAnimationFrame(tick);
        } else {
          let fade = 0.35;
          (function fadeOut(){
            fade -= 0.03;
            if (fade <= 0){ canvas.remove(); return; }
            ctx.fillStyle = `rgba(0,0,0,0.04)`; ctx.fillRect(0,0,canvas.width,canvas.height);
            requestAnimationFrame(fadeOut);
          })();
        }
      })();
    }catch{}
  }

  // ---------- draw: simple 3D-looking box ----------
  function draw3DBox(ctx, sx, sy, S){
    ctx.save();
    ctx.translate(sx, sy);
    ctx.scale((S*0.68)/44, (S*0.68)/44);
    ctx.translate(-22, -22);
    ctx.fillStyle='rgba(0,0,0,0.18)'; ctx.beginPath(); ctx.ellipse(22,28,14,6,0,0,Math.PI*2); ctx.fill();
    const body = new Path2D('M6,18 L22,10 L38,18 L38,34 L22,42 L6,34 Z');
    ctx.fillStyle='#b98c4a'; ctx.fill(body);
    ctx.strokeStyle='#7d5f2e'; ctx.lineWidth=1.3; ctx.stroke(body);
    const flapL = new Path2D('M6,18 L22,26 L22,10 Z');
    const flapR = new Path2D('M38,18 L22,26 L22,10 Z');
    ctx.fillStyle='#cfa162'; ctx.fill(flapL); ctx.fill(flapR); ctx.stroke(flapL); ctx.stroke(flapR);
    ctx.fillStyle='#e9dfb1'; ctx.fillRect(21,10,2,16);
    ctx.restore();
  }

  // ---------- render-under: show box if not taken ----------
  function renderBox(){
    try{
      if (!api?.ready) return;
      if (!missionsEnabled()) return; // hide in MP
      if (localStorage.getItem('izzaMapTier') !== '2') return;
      if (localStorage.getItem(BOX_TAKEN_KEY) === '1') return;

      const S=api.DRAW, t=api.TILE, b=cardboardBoxGrid();
      const bx=(b.x*t - api.camera.x)*(S/t) + S*0.5;
      const by=(b.y*t - api.camera.y)*(S/t) + S*0.6;
      const ctx=document.getElementById('game')?.getContext('2d'); if(!ctx) return;
      draw3DBox(ctx, bx, by, S);
    }catch{}
  }

  // ---------- B: pick up box ONLY when standing on it ----------
  function onB(e){
    if (!api?.ready) return;
    if (!missionsEnabled()) return; // no pickup in MP
    if (localStorage.getItem('izzaMapTier') !== '2') return;
    if (localStorage.getItem(BOX_TAKEN_KEY) === '1') return;

    const t=api.TILE;
    const gx=((api.player.x+16)/t|0), gy=((api.player.y+16)/t|0);
    const box = cardboardBoxGrid();

    if (gx === box.x && gy === box.y){
      e?.preventDefault?.(); e?.stopImmediatePropagation?.(); e?.stopPropagation?.();
      confirmPickup(()=>{
        const inv = readInv();
        addCount(inv, 'cardboard_box', 1);
        writeInv(inv);
        try{
          localStorage.setItem(BOX_TAKEN_KEY, '1');
          if ((localStorage.getItem(M4_KEY)||'not-started') === 'not-started') setM4('started');
        }catch{}
        try{ IZZA.toast?.('Cardboard Box added to Inventory'); }catch{}
      });
    }
  }

  // ---------- Mission 4 completion (requires full cardboard set) ----------
  (function(){
    const M4_DONE_KEY = 'izzaMission4_done';
    const SET_IDS = [
      'armor_cardboard_helm',
      'armor_cardboard_vest',
      'armor_cardboard_arms',
      'armor_cardboard_legs'
    ];
    const ALIAS = {
      cardboard_helm:  'armor_cardboard_helm',
      cardboard_chest: 'armor_cardboard_vest',
      cardboard_arms:  'armor_cardboard_arms',
      cardboard_legs:  'armor_cardboard_legs'
    };

    function invCount(id){
      try{
        if (IZZA?.api?.inventory?.count) return IZZA.api.inventory.count(id)|0;
        const inv = JSON.parse(localStorage.getItem('izzaInventory')||'{}');
        if (inv[id]?.count) return inv[id].count|0;
        return 0;
      }catch{ return 0; }
    }

    function hasFullCardboardSet(){
      return SET_IDS.every(id=>{
        const ok = invCount(id) > 0;
        if (ok) return true;
        const alias = Object.keys(ALIAS).find(k => ALIAS[k]===id);
        return alias ? invCount(alias) > 0 : false;
      });
    }

    function mission4AgentPopup(){
      try{
        IZZA?.api?.UI?.popup?.({ style:'agent', title:'Mission Completed', body:'You’ve completed mission 4.', timeout:2000 });
        return;
      }catch{}
      const el = document.createElement('div');
      el.style.cssText = 'position:absolute;left:50%;top:18%;transform:translateX(-50%);' +
                         'background:rgba(10,12,20,0.92);color:#b6ffec;padding:14px 18px;' +
                         'border:2px solid #36f;border-radius:8px;font-family:monospace;z-index:9999';
      el.innerHTML = '<strong>Mission Completed</strong><div>You’ve completed mission 4.</div>';
      (document.getElementById('gameCard')||document.body).appendChild(el);
      setTimeout(()=>{ el.remove(); }, 2000);
    }

    function completeMission4Once(){
      if (localStorage.getItem(M4_DONE_KEY) === '1') return;
      try { localStorage.setItem(M4_DONE_KEY, '1'); } catch {}
      try { IZZA.api?.inventory?.setMeta?.('missionsCompleted', 4); } catch {}
      try {
        const prev = parseInt(localStorage.getItem('izzaMissions')||'0',10)||0;
        localStorage.setItem('izzaMissions', String(Math.max(4, prev)));
      } catch {}
      try {
        if (IZZA?.api?.setMissionEntry) {
          IZZA.api.setMissionEntry('4', { done:true, ts: Date.now() });
        } else {
          const st = JSON.parse(localStorage.getItem('izzaMissionState')||'{}');
          st['4'] = { done:true, ts: Date.now() };
          localStorage.setItem('izzaMissionState', JSON.stringify(st));
        }
      } catch(e) { console.warn('[m4] failed to set missionState', e); }
      try { IZZA.emit?.('missions-updated', { completed: 4 }); } catch {}
      try { window.dispatchEvent(new Event('izza-missions-changed')); } catch {}
      try { IZZA.emit?.('mission-complete', { id:4, name:'Armoury — Cardboard Set' }); } catch {}
      mission4AgentPopup();
    }

    function spendCardboardBoxOnceIfReady(){
      if (localStorage.getItem(BOX_SPENT_KEY) === '1') return;
      if (!hasFullCardboardSet()) return;
      const inv = readInv();
      const c = getCount(inv, 'cardboard_box') || getCount(inv, 'box_cardboard');
      if (c > 0){
        if (getCount(inv, 'cardboard_box') > 0) addCount(inv, 'cardboard_box', -1);
        else                                     addCount(inv, 'box_cardboard', -1);
        writeInv(inv);
        try{ localStorage.setItem(BOX_SPENT_KEY, '1'); }catch{}
        try{ IZZA.toast?.('Used 1 Cardboard Box to complete the set'); }catch{}
      }
    }

    function maybeCompleteM4(){
      if (hasFullCardboardSet()){
        completeMission4Once();
        spendCardboardBoxOnceIfReady();
      }
    }

    IZZA.on?.('gear-crafted',  ({kind,set})=>{
      if (kind==='cardboard'||set==='cardboard'){ maybeCompleteM4(); }
    });
    IZZA.on?.('armor-crafted', ({kind,set})=>{
      if (kind==='cardboard'||set==='cardboard'){ maybeCompleteM4(); }
    });
    IZZA.on?.('inventory-changed', ()=> maybeCompleteM4());

    IZZA.on?.('resume', ({inventoryMeta})=>{
      if ((inventoryMeta?.missionsCompleted|0) >= 4) {
        try{ localStorage.setItem(M4_DONE_KEY, '1'); }catch{}
      }
      spendCardboardBoxOnceIfReady();
    });
  })();

  // ---------- hook up ----------
  IZZA.on?.('ready', (a)=>{
    api = a;
    hqDoorGrid(); // snapshot the HQ base once so the box tile stays fixed
    IZZA.on?.('render-under', renderBox);
    document.getElementById('btnB')?.addEventListener('click', onB, true);
    window.addEventListener('keydown', e=>{ if((e.key||'').toLowerCase()==='b') onB(e); }, true);
  });

  // --- (optional) react to Solo/MP toggle to force repaint without box -------
  window.addEventListener('izza-missions-toggle', (ev)=>{
    const enabled = !!(ev?.detail?.enabled);
    if (!enabled) { try { IZZA.emit?.('render-under'); } catch {} }
  });

})();
