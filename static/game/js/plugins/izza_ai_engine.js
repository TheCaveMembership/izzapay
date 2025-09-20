/* izza_ai_engine.js  — AI mission + NPC/attacker spawns + SVG sprites + consume hooks
   Safe: attaches to IZZA.on(...) and IZZA.emit(...) only; no core edits.
*/
(function(){
  const MOD = 'ai-engine v1.0';
  console.log('[IZZA PLUGIN]', MOD);

  // --- Guards ---
  if(!window.IZZA || !IZZA.api || !IZZA.on){ console.warn('AI engine: Core not ready'); return; }

  // ===== Config ===============================================================
  const CFG = {
    aiEnabled: true,                 // flip to false to hard-disable AI generation
    attackerZones: [                 // relative to grid, light examples
      {x0: 26, y0: 22, x1: 35, y1: 28, cooldownMs: 20000, maxAtOnce: 2}, // near hub road
      {x0: 60, y0: 16, x1: 72, y1: 22, cooldownMs: 22000, maxAtOnce: 2}
    ],
    pedMax: 12,                      // allow a bit more crowd than core’s 6
    aiEndpoint: '/api/ai/mission',   // you can map this to your OpenAI proxy
    svgSize: 32                      // sprite cell expected by core
  };

  // Quick grid helpers
  const TILE = IZZA.api.TILE;

  // ===== SVG → <img> (canvas-safe) ===========================================
  async function svgToImage(svg, cell=32){
    const blob = new Blob([svg], {type:'image/svg+xml'});
    const url  = URL.createObjectURL(blob);
    const img  = new Image();
    img.crossOrigin = 'anonymous';
    const done = new Promise((res,rej)=>{ img.onload=()=>res(img); img.onerror=()=>rej(new Error('bad svg')); });
    img.src = url;
    const loaded = await done; URL.revokeObjectURL(url);

    // Normalize to 32×32 for draw pipeline
    const c = document.createElement('canvas'); c.width = cell; c.height = cell;
    const g = c.getContext('2d', {willReadFrequently:true}); g.imageSmoothingEnabled=false;
    g.drawImage(loaded, 0, 0, cell, cell);
    const out = new Image(); out.src = c.toDataURL('image/png');
    await new Promise(r=> out.onload=r);
    return out; // single-frame sheet compatible with drawSprite(cols=1)
  }

  // ===== AI Call (server-proxied) =============================================
  async function aiGenerate(kind, payload){
    if(!CFG.aiEnabled) return null;
    try{
      const r = await fetch(CFG.aiEndpoint, {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        credentials:'include',
        body: JSON.stringify({ kind, payload })
      });
      if(!r.ok) throw new Error('AI endpoint failed '+r.status);
      return await r.json(); // expected { svg?:string, mission?:{...}, npc?:{...}, item?:{...} }
    }catch(err){
      console.warn('AI call error', err);
      return null;
    }
  }

  // ===== Procedural mission seeds ============================================
  const missionSeeds = []; // [{id, title, step, desc, rewards, generatedSvgIMG?}]
  let lastMissionAt = 0;

  async function maybeAddProceduralMission(now){
    // Keep it chill: one every ~2–4 min, only if player has ≥3 missions done (your Tier-2 flow)
    if((now - lastMissionAt) < 120000) return;
    const done = (typeof IZZA.api.getMissionCount==='function') ? IZZA.api.getMissionCount() : 0;
    if(done < 3) return;

    // Generate prompt context from world state
    const ctx = {
      wanted: IZZA.api.player.wanted|0,
      coins:  IZZA.api.getCoins(),
      hp:     IZZA.api.getHearts(),
      time:   Date.now()
    };
    const res = await aiGenerate('mission', { context: ctx, theme: 'street-crime, heist, courier, rescue' });
    const id  = 'pm_' + Math.random().toString(36).slice(2,8);

    const mission = res && res.mission ? res.mission : {
      id,
      title: 'AI: Silent Pickup',
      step: 'go-to-cross',
      desc: 'A contact left a package near the vertical crosswalk. Retrieve it without raising Wanted above ★★.',
      rewards: { coins: 120, item: { id:'craft_ai_box', name:'Mystery Box', type:'item', count:1 } }
    };
    mission.id = mission.id || id;

    // Optional icon
    if(res && res.svg){
      try{
        mission.iconImg = await svgToImage(res.svg, CFG.svgSize);
      }catch{}
    }

    missionSeeds.push(mission);
    lastMissionAt = now;
    try{ boot('New AI mission available'); }catch{}
  }

  // Simple on-screen note
  function boot(msg){ try{ (window.bootMsg||console.log)(msg); }catch{} }

  // ===== Random attackers when entering zones =================================
  const zoneState = new Map(); // zone → {last:ms, alive:n}

  function inZone(px,py,z){
    const gx = Math.floor((px+TILE/2)/TILE), gy = Math.floor((py+TILE/2)/TILE);
    return gx>=z.x0 && gx<=z.x1 && gy>=z.y0 && gy<=z.y1;
  }
  function spawnAttacker(){
    // Use existing police sheet as a "thug" fallback if custom SVG not loaded
    const left  = Math.random()<0.5;
    const top   = Math.random()<0.5;
    const ux = (left ? IZZA.api.hRoadY : IZZA.api.vRoadX); // just to bias positions
    const x = (left ? (IZZA.api.camera.x+64) : (IZZA.api.camera.x+320));
    const y = (top ? (IZZA.api.camera.y+64)  : (IZZA.api.camera.y+260));
    // store as a light “cop-like” chaser with lower HP
    attackers.push({ x, y, spd: 85, hp: 3, facing:'down', icon:'thug' });
  }

  const attackers = []; // independent from cops[] and pedestrians[]
  function updateAttackers(dtSec){
    const p = IZZA.api.player;
    attackers.forEach(a=>{
      const dx=p.x-a.x, dy=p.y-a.y, m=Math.hypot(dx,dy)||1;
      a.x += (dx/m) * a.spd * dtSec;
      a.y += (dy/m) * a.spd * dtSec;
      if(Math.abs(dy)>=Math.abs(dx)) a.facing = dy<0?'up':'down'; else a.facing = dx<0?'left':'right';
    });
  }
  function drawAttackers(){
    const ctx = document.getElementById('game').getContext('2d');
    attackers.forEach(a=>{
      // simple colored box if no sprite
      const sx = (a.x - IZZA.api.camera.x) * (IZZA.api.DRAW/IZZA.api.TILE);
      const sy = (a.y - IZZA.api.camera.y) * (IZZA.api.DRAW/IZZA.api.TILE);
      ctx.fillStyle='#7c1f1f';
      ctx.fillRect(sx+IZZA.api.DRAW*0.18, sy+IZZA.api.DRAW*0.18, IZZA.api.DRAW*0.64, IZZA.api.DRAW*0.64);
    });
  }

  // Damage model: reuse your core’s weapon damage on collision
  function attackOverlap(a){
    const px=IZZA.api.player.x, py=IZZA.api.player.y;
    return Math.hypot(px-a.x, py-a.y) <= 22;
  }
  function handleAttackerHits(){
    // If player hits attackers using A, they’ll be processed by core collision only for peds/cops.
    // We add a parallel check here to let fists/bat/pistol work the same.
    for(const a of [...attackers]){
      if(attackOverlap(a)){
        a.hp -= 1;
        if(a.hp<=0){
          const i = attackers.indexOf(a);
          if(i>=0) attackers.splice(i,1);
          IZZA.emit('loot-picked', { kind:'coins', amount: 20 });
        }
      }
    }
  }

  // ===== Pedestrian crowd booster ============================================
  IZZA.on('update-post', ({dtSec})=>{
    // Add more pedestrians passively (you already have your own spawner)
    try{
      const peds = IZZA.api.pedestrians || [];
      if(peds.length < CFG.pedMax && Math.random()<0.03) {
        // use your existing spawn method via a synthetic event
        IZZA.emit('spawn-ped', {});
      }
    }catch{}
  });

  // ===== Zone triggers ========================================================
  IZZA.on('update-post', ({now})=>{
    try{
      const p = IZZA.api.player;
      CFG.attackerZones.forEach(z=>{
        const st = zoneState.get(z) || {last:0, alive:0};
        if(inZone(p.x,p.y,z)){
          if((now - st.last) >= (z.cooldownMs|0)){
            // only spawn if not too many alive near player
            if(attackers.length < (z.maxAtOnce|0)) spawnAttacker();
            st.last = now;
            st.alive = attackers.length;
            zoneState.set(z, st);
          }
        }
      });
    }catch(e){}
  });

  // ===== Procedural Mission lifecycle ========================================
  IZZA.on('update-post', ({now})=>{
    maybeAddProceduralMission(now);
    updateAttackers( (16/1000) ); // tiny tick; real integration happens in our pre hook too
  });

  // Minimal prompt panel for mission (non-blocking)
  function showMissionHint(){
    const m = missionSeeds[missionSeeds.length-1]; if(!m) return;
    const el = document.getElementById('tutHint'); if(!el) return;
    el.textContent = `[Mission] ${m.title} — ${m.desc}`;
    el.style.display='block';
  }

  // Rewards when near the vertical road center (example objective)
  IZZA.on('update-post', ()=>{
    const m = missionSeeds[0]; if(!m) return;
    if(m.step!=='go-to-cross') return;
    try{
      const px = Math.floor((IZZA.api.player.x+TILE/2)/TILE);
      if(px === IZZA.api.vRoadX){
        // success
        if(m.rewards){
          if(m.rewards.coins) IZZA.api.setCoins(IZZA.api.getCoins() + (m.rewards.coins|0));
          if(m.rewards.item){
            // hand off to your Armoury flow: we mirror inventory shape
            const inv = IZZA.api.getInventory() || {};
            const it  = inv[m.rewards.item.id] || Object.assign({},{count:0}, m.rewards.item);
            it.count = (it.count|0) + (m.rewards.item.count|0||1);
            inv[m.rewards.item.id] = it;
            IZZA.api.setInventory(inv);
            try{ window.dispatchEvent(new Event('izza-inventory-changed')); }catch{}
          }
        }
        missionSeeds.shift();
        boot('Mission complete!');
      }
    }catch{}
  });

  // Light render pass for attackers (under player overlays)
  IZZA.on('render-under', drawAttackers);

  // Tap into your hit loop with a tiny follow-up
  IZZA.on('update-pre', ()=>{
    handleAttackerHits();
  });

  // Surface any fresh mission text occasionally
  setInterval(showMissionHint, 12000);

  // ===== Inventory consume actions (Eat/Drink) ================================
  function wireConsumeButtons(){
    try{
      const host = document.getElementById('invPanel'); if(!host) return;
      // Add handlers for data-eat / data-drink attributes (we’ll inject them below)
      host.querySelectorAll('[data-eat]').forEach(btn=>{
        btn.addEventListener('click',()=>{
          const id = btn.getAttribute('data-eat');
          const inv = IZZA.api.getInventory()||{};
          const it  = inv[id]; if(!it || (it.count|0)<=0) return;
          inv[id].count = Math.max(0,(inv[id].count|0)-1);
          IZZA.api.setInventory(inv);

          // Apply effect: +1 heart (cap at 10 to be safe)
          const cur = IZZA.api.getHearts();
          IZZA.api.setHearts(Math.min(10, cur + (it.heal||1)));
          try{ window.dispatchEvent(new Event('izza-inventory-changed')); }catch{}
        }, {once:true});
      });

      host.querySelectorAll('[data-drink]').forEach(btn=>{
        btn.addEventListener('click',()=>{
          const id = btn.getAttribute('data-drink');
          const inv = IZZA.api.getInventory()||{};
          const it  = inv[id]; if(!it || (it.count|0)<=0) return;
          inv[id].count = Math.max(0,(inv[id].count|0)-1);
          IZZA.api.setInventory(inv);

          // Simple temp buff: reduce wanted by 1 (or add speed later)
          try{ IZZA.api.setWanted(Math.max(0, IZZA.api.player.wanted-1)); }catch{}
          try{ window.dispatchEvent(new Event('izza-inventory-changed')); }catch{}
        }, {once:true});
      });
    }catch{}
  }

  // Inject Eat/Drink buttons for items with type 'food'/'potion' right after your panel renders
  function injectConsumeButtons(){
    try{
      const host = document.getElementById('invPanel'); if(!host) return;
      const body = host.querySelector('.inv-body') || host;
      const inv  = IZZA.api.getInventory() || {};

      Object.entries(inv).forEach(([k,v])=>{
        if(!v || typeof v!=='object') return;
        // find row that includes the item name (your crafted block prints name)
        const row = Array.from(body.children).find(n=> (n.textContent||'').includes(v.name||k));
        if(!row) return;

        // avoid duplicates
        if(row.querySelector('[data-eat],[data-drink]')) return;

        if(v.type==='food'){
          const b = document.createElement('button'); b.className='ghost'; b.textContent='Eat';
          b.setAttribute('data-eat', k);
          b.style.marginLeft='8px';
          row.appendChild(b);
        }else if(v.type==='potion'){
          const b = document.createElement('button'); b.className='ghost'; b.textContent='Drink';
          b.setAttribute('data-drink', k);
          b.style.marginLeft='8px';
          row.appendChild(b);
        }
      });

      wireConsumeButtons();
    }catch(e){ console.warn('consume inject fail', e); }
  }

  // Re-run consume button injection whenever inventory panel refreshes
  window.addEventListener('izza-inventory-changed', injectConsumeButtons);
  // and after your renderInventoryPanel runs:
  IZZA.on('render-post', injectConsumeButtons);

  // ===== Public tiny API (optional) ===========================================
  IZZA.ai = IZZA.ai || {};
  IZZA.ai.generateItem = async function(prompt){
    const res = await aiGenerate('item', { prompt });
    if(!res) return null;
    const inv = IZZA.api.getInventory()||{};
    const id  = res.item?.id || ('craft_'+Math.random().toString(36).slice(2,7));
    const entry = Object.assign({count:1, iconSvg: res.svg||'', equippable:false}, res.item||{});
    inv[id] = entry;
    IZZA.api.setInventory(inv);
    try{ window.dispatchEvent(new Event('izza-inventory-changed')); }catch{}
    return id;
  };
})();
