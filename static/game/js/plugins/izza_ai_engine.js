/* izza_ai_engine.js  — AI mission + NPC/attacker spawns + SVG sprites + consume hooks
   Safe: attaches to IZZA.on(...) and IZZA.emit(...) only; no core edits.
*/
(function(){
  const MOD = 'ai-engine v1.1-hot';
  console.log('[IZZA PLUGIN]', MOD);

  // --- Guards ---
  if(!window.IZZA || !IZZA.api || !IZZA.on){ console.warn('AI engine: Core not ready'); return; }

  // ===== Config (HOT START) ===================================================
  const CFG = {
    aiEnabled: true,

    // MOVING “follow player” zone so you always encounter action
    attackerZones: [
      { followPlayer:true, radius:7, cooldownMs:9000, maxAtOnce:3 },  // frequent
      { followPlayer:true, radius:11, cooldownMs:15000, maxAtOnce:4 } // outer ring
    ],

    pedMax: 14, // slight boost over core

    // Endpoints:
    // - aiMissionEndpoint: optional (if present you’ll get AI-written mission text)
    // - aiSvgEndpoint: REQUIRED for dynamic SVG sprites (uses your server’s SVG endpoint)
    aiMissionEndpoint: '/api/ai/mission',     // ok if missing; we use fallback mission
    aiSvgEndpoint:     '/api/crafting/ai_svg',// this is your real SVG generator

    svgSize: 32 // sprite cell expected by core
  };

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
    return out;
  }

  // ===== AI Calls =============================================================
  async function aiFetchMission(payload){
    if(!CFG.aiEnabled || !CFG.aiMissionEndpoint) return null;
    try{
      const r = await fetch(CFG.aiMissionEndpoint, {
        method:'POST', headers:{'Content-Type':'application/json'},
        credentials:'include', body: JSON.stringify({ kind:'mission', payload })
      });
      if(!r.ok) throw 0;
      return await r.json();
    }catch{ return null; }
  }

  // Generate a small, readable 32×32 sprite via your SVG endpoint.
  // We request in “cartoon/anime” style so outlines read at tiny size.
  const spriteCache = new Map(); // key -> HTMLImageElement
  async function aiFetchSprite(key, prompt){
    if(spriteCache.has(key)) return spriteCache.get(key);
    try{
      const r = await fetch(CFG.aiSvgEndpoint, {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        credentials:'include',
        body: JSON.stringify({
          prompt,
          meta: {
            name: key,
            part: 'helmet',      // any slot is fine; we just want a 1:1 icon
            style: 'cartoon',    // crisp outlines for 32px readability
            animate: false
          }
        })
      });
      if(!r.ok) throw 0;
      const j = await r.json();
      const svg = j && j.ok && typeof j.svg === 'string' ? j.svg : '';
      if(!svg) throw 0;
      const img = await svgToImage(svg, CFG.svgSize);
      spriteCache.set(key, img);
      return img;
    }catch{
      spriteCache.set(key, null);
      return null;
    }
  }

  // ===== Procedural mission seeds ============================================
  const missionSeeds = []; // [{id, title, step, desc, rewards, iconImg?}]
  let lastMissionAt = 0;

  async function maybeAddProceduralMission(now){
    // HOT: every ~15–25s (randomized), regardless of prior mission count
    const minGap = 15000 + Math.floor(Math.random()*10000);
    if((now - lastMissionAt) < minGap) return;

    const ctx = {
      wanted: IZZA.api.player.wanted|0,
      coins:  IZZA.api.getCoins(),
      hp:     IZZA.api.getHearts(),
      time:   Date.now()
    };

    let mission = null;
    const res = await aiFetchMission({ context: ctx, theme: 'street-crime, courier, rescue, heist-lite' });
    if (res && res.mission) mission = res.mission;

    const id  = 'pm_' + Math.random().toString(36).slice(2,8);
    if(!mission){
      mission = {
        id,
        title: 'AI: Silent Pickup',
        step: 'go-to-cross',
        desc: 'A contact left a package near the vertical crosswalk. Retrieve it without raising Wanted above ★★.',
        rewards: { coins: 120, item: { id:'craft_ai_box', name:'Mystery Box', type:'item', count:1 } }
      };
    }
    mission.id = mission.id || id;

    // Optional AI icon (small decorative)
    try{
      const img = await aiFetchSprite('mission_icon_pkg',
        'tiny parcel icon, bold outline, cel-shaded, readable at 32px');
      if(img) mission.iconImg = img;
    }catch{}

    missionSeeds.push(mission);
    lastMissionAt = now;
    boot('New AI mission available');
  }

  // Simple on-screen note
  function boot(msg){ try{ (window.bootMsg||console.log)(msg); }catch{} }

  // ===== Random attackers that FOLLOW PLAYER =================================
  const zoneState = new Map(); // zone → {last:ms}
  const attackers = [];        // independent from cops[] and pedestrians[]

  function inFollowRadius(px, py, z){
    const gx = Math.floor((px+TILE/2)/TILE), gy = Math.floor((py+TILE/2)/TILE);
    const cx = Math.floor((IZZA.api.player.x+TILE/2)/TILE);
    const cy = Math.floor((IZZA.api.player.y+TILE/2)/TILE);
    return (Math.abs(gx - cx) + Math.abs(gy - cy)) <= (z.radius|0);
  }

  function inZone(px,py,z){
    if (z.followPlayer) return inFollowRadius(px,py,z);
    const gx = Math.floor((px+TILE/2)/TILE), gy = Math.floor((py+TILE/2)/TILE);
    return gx>=z.x0 && gx<=z.x1 && gy>=z.y0 && gy<=z.y1;
  }

  async function spawnAttacker(){
    // position around camera edges so they “enter” the scene
    const left  = Math.random()<0.5;
    const top   = Math.random()<0.5;
    const x = (left ? (IZZA.api.camera.x + 48)  : (IZZA.api.camera.x + 340));
    const y = (top  ? (IZZA.api.camera.y + 48)  : (IZZA.api.camera.y + 270));

    // lazy-generate sprite (once) and reuse
    const spriteKey = 'thug_sprite_v1';
    let sprite = spriteCache.get(spriteKey);
    if (sprite === undefined) {
      sprite = await aiFetchSprite(
        spriteKey,
        'street thug head icon, bold silhouette, cel-shading, no text, no logo, original'
      );
    }

    attackers.push({ x, y, spd: 95, hp: 3, facing:'down', sprite });
  }

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
    const cvs = document.getElementById('game');
    if(!cvs) return;
    const ctx = cvs.getContext('2d');
    attackers.forEach(a=>{
      const sx = (a.x - IZZA.api.camera.x) * (IZZA.api.DRAW/IZZA.api.TILE);
      const sy = (a.y - IZZA.api.camera.y) * (IZZA.api.DRAW/IZZA.api.TILE);
      if (a.sprite) {
        // center the 32×32
        const s = IZZA.api.DRAW*0.72;
        ctx.drawImage(a.sprite, sx + IZZA.api.DRAW*0.14, sy + IZZA.api.DRAW*0.14, s, s);
      } else {
        // fallback: red square until sprite loads
        ctx.fillStyle='#7c1f1f';
        ctx.fillRect(sx+IZZA.api.DRAW*0.18, sy+IZZA.api.DRAW*0.18, IZZA.api.DRAW*0.64, IZZA.api.DRAW*0.64);
      }
    });
  }

  function attackOverlap(a){
    const px=IZZA.api.player.x, py=IZZA.api.player.y;
    return Math.hypot(px-a.x, py-a.y) <= 22;
  }
  function handleAttackerHits(){
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
  IZZA.on('update-post', ()=>{
    try{
      const peds = IZZA.api.pedestrians || [];
      if(peds.length < CFG.pedMax && Math.random()<0.06) {
        IZZA.emit('spawn-ped', {});
      } else if (peds.length < CFG.pedMax) {
        // fallback if core doesn’t listen to spawn-ped
        try { IZZA.api.spawnPed && IZZA.api.spawnPed(); } catch {}
      }
    }catch{}
  });

  // ===== Zone triggers (moving) ==============================================
  IZZA.on('update-post', ({now})=>{
    try{
      const p = IZZA.api.player;
      CFG.attackerZones.forEach(z=>{
        const st = zoneState.get(z) || {last:0};
        // treat the player's current tile as the zone's “probe”
        if(inZone(p.x,p.y,z)){
          if((now - st.last) >= (z.cooldownMs|0)){
            // keep it lively but bounded
            const alive = attackers.length;
            if(alive < (z.maxAtOnce|0)) spawnAttacker();
            st.last = now;
            zoneState.set(z, st);
          }
        }
      });
    }catch(e){}
  });

  // ===== Procedural Mission lifecycle ========================================
  IZZA.on('update-post', ({now})=>{
    maybeAddProceduralMission(now);
    updateAttackers( (16/1000) );
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
        if(m.rewards){
          if(m.rewards.coins) IZZA.api.setCoins(IZZA.api.getCoins() + (m.rewards.coins|0));
          if(m.rewards.item){
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
  IZZA.on('update-pre', ()=>{ handleAttackerHits(); });

  // Surface any fresh mission text occasionally
  setInterval(showMissionHint, 9000);

  // ===== Inventory consume actions (Eat/Drink) ================================
  function wireConsumeButtons(){
    try{
      const host = document.getElementById('invPanel'); if(!host) return;
      host.querySelectorAll('[data-eat]').forEach(btn=>{
        btn.addEventListener('click',()=>{
          const id = btn.getAttribute('data-eat');
          const inv = IZZA.api.getInventory()||{};
          const it  = inv[id]; if(!it || (it.count|0)<=0) return;
          inv[id].count = Math.max(0,(inv[id].count|0)-1);
          IZZA.api.setInventory(inv);
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
          try{ IZZA.api.setWanted(Math.max(0, IZZA.api.player.wanted-1)); }catch{}
          try{ window.dispatchEvent(new Event('izza-inventory-changed')); }catch{}
        }, {once:true});
      });
    }catch{}
  }

  function injectConsumeButtons(){
    try{
      const host = document.getElementById('invPanel'); if(!host) return;
      const body = host.querySelector('.inv-body') || host;
      const inv  = IZZA.api.getInventory() || {};
      Object.entries(inv).forEach(([k,v])=>{
        if(!v || typeof v!=='object') return;
        const row = Array.from(body.children).find(n=> (n.textContent||'').includes(v.name||k));
        if(!row) return;
        if(row.querySelector('[data-eat],[data-drink]')) return;
        if(v.type==='food'){
          const b = document.createElement('button'); b.className='ghost'; b.textContent='Eat';
          b.setAttribute('data-eat', k); b.style.marginLeft='8px'; row.appendChild(b);
        }else if(v.type==='potion'){
          const b = document.createElement('button'); b.className='ghost'; b.textContent='Drink';
          b.setAttribute('data-drink', k); b.style.marginLeft='8px'; row.appendChild(b);
        }
      });
      wireConsumeButtons();
    }catch(e){ console.warn('consume inject fail', e); }
  }
  window.addEventListener('izza-inventory-changed', injectConsumeButtons);
  IZZA.on('render-post', injectConsumeButtons);

  // ===== Public tiny API for ad-hoc item gen (kept) ===========================
  IZZA.ai = IZZA.ai || {};
  IZZA.ai.generateItem = async function(prompt){
    // NOTE: not used by players; handy for dev commands if you need it.
    try{
      const r = await fetch(CFG.aiSvgEndpoint,{
        method:'POST', headers:{'Content-Type':'application/json'}, credentials:'include',
        body: JSON.stringify({ prompt, meta:{ part:'helmet', style:'cartoon' } })
      });
      const j = await r.json().catch(()=>null);
      const svg = j && j.ok ? j.svg : '';
      const inv = IZZA.api.getInventory()||{};
      const id  = 'craft_'+Math.random().toString(36).slice(2,7);
      inv[id] = { name:'AI Item', type:'item', count:1, iconSvg:svg, equippable:false };
      IZZA.api.setInventory(inv);
      try{ window.dispatchEvent(new Event('izza-inventory-changed')); }catch{}
      return id;
    }catch{ return null; }
  };
})();
