/* izza_ai_engine.js — AI missions + attacker spawns + dynamic SVG sprites
   Safe: attaches to IZZA bus only; no core edits.
*/
(function(){
  const MOD = 'ai-engine v1.2-hot';

  // ---------- delayed init so we never miss core ----------
  function onReady(fn){
    if (window.IZZA && IZZA.on) { fn(); return; }
    document.addEventListener('izza-core-ready', fn, { once:true });
    // also retry in case core doesn't dispatch (defensive)
    if (document.readyState !== 'loading') setTimeout(()=>{ if(window.IZZA&&IZZA.on) fn(); }, 1000);
  }

  onReady(function init(){
    try{
      if (!window.IZZA || !IZZA.on || !IZZA.api) return console.warn('[AI]', 'Core not ready');
      console.log('[IZZA PLUGIN]', MOD);
      toast('AI online');

      // ===== Config (hot) =====================================================
      const CFG = {
        aiEnabled: true,
        zones: [
          { followPlayer:true, radius:7,  cooldownMs:8000,  maxAtOnce:3 },
          { followPlayer:true, radius:11, cooldownMs:14000, maxAtOnce:4 }
        ],
        pedMax: 14,
        svgSize: 32
      };

      // Base URL for AI SVG (use same host as your persist service)
      const PERSIST_BASE = (window.IZZA_PERSIST_BASE || '').replace(/\/$/,'');
      const AI_SVG_URL   = (PERSIST_BASE ? PERSIST_BASE : '') + '/api/crafting/ai_svg';

      const TILE = IZZA.api.TILE;

      // ===== helpers ==========================================================
      function toast(msg){ try{ (window.bootMsg||console.log)(msg); }catch{} }

      async function svgToImage(svg, cell=32){
        const blob = new Blob([svg], {type:'image/svg+xml'});
        const url  = URL.createObjectURL(blob);
        const img  = new Image();
        img.crossOrigin = 'anonymous';
        await new Promise((res,rej)=>{ img.onload=res; img.onerror=()=>rej(new Error('bad svg')); });
        img.src = url;
        URL.revokeObjectURL(url);
        const c = document.createElement('canvas'); c.width = cell; c.height = cell;
        const g = c.getContext('2d', {willReadFrequently:true}); g.imageSmoothingEnabled=false;
        g.drawImage(img, 0, 0, cell, cell);
        const out = new Image(); out.src = c.toDataURL('image/png');
        await new Promise(r=> out.onload=r);
        return out;
      }

      const spriteCache = new Map();
      async function aiFetchSprite(key, prompt){
        if(spriteCache.has(key)) return spriteCache.get(key);
        try{
          const r = await fetch(AI_SVG_URL, {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            credentials:'include',
            body: JSON.stringify({
              prompt,
              meta:{ name:key, part:'helmet', style:'cartoon', animate:false }
            })
          });
          const j = await r.json().catch(()=>null);
          const svg = j && j.ok && j.svg ? j.svg : '';
          if(!svg) throw 0;
          const img = await svgToImage(svg, CFG.svgSize);
          spriteCache.set(key, img);
          return img;
        }catch{
          spriteCache.set(key, null);
          return null;
        }
      }

      // ===== attackers that follow player =====================================
      const attackers = [];
      const zoneState = new WeakMap();

      function playerGX(){ return Math.floor((IZZA.api.player.x+TILE/2)/TILE); }
      function playerGY(){ return Math.floor((IZZA.api.player.y+TILE/2)/TILE); }

      function inFollowRadius(z){
        const cx = playerGX(), cy = playerGY();
        // probe at player tile (ring check is implicit by cooldown)
        return true; // we always evaluate; radius used only to space/justify
      }

      async function spawnAttacker(){
        // enter scene from camera edge
        const left  = Math.random()<0.5;
        const top   = Math.random()<0.5;
        const x = (left ? (IZZA.api.camera.x + 48)  : (IZZA.api.camera.x + 340));
        const y = (top  ? (IZZA.api.camera.y + 48)  : (IZZA.api.camera.y + 270));

        const spriteKey = 'thug_sprite_v1';
        let sprite = spriteCache.get(spriteKey);
        if (sprite === undefined) {
          sprite = await aiFetchSprite(
            spriteKey,
            'street thug head icon, bold silhouette, cel-shaded, readable at 32px, no text, no logo'
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
        const cvs = document.getElementById('game'); if(!cvs) return;
        const ctx = cvs.getContext('2d');
        attackers.forEach(a=>{
          const sx = (a.x - IZZA.api.camera.x) * (IZZA.api.DRAW/IZZA.api.TILE);
          const sy = (a.y - IZZA.api.camera.y) * (IZZA.api.DRAW/IZZA.api.TILE);
          if (a.sprite) {
            const s = IZZA.api.DRAW*0.72;
            ctx.drawImage(a.sprite, sx + IZZA.api.DRAW*0.14, sy + IZZA.api.DRAW*0.14, s, s);
          } else {
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

      // ===== HOT: guaranteed first spawn so you SEE it ========================
      setTimeout(()=>{ spawnAttacker(); toast('Activity nearby…'); }, 3000);

      // ===== crowd booster =====================================================
      IZZA.on('update-post', ()=>{
        try{
          const peds = IZZA.api.pedestrians || [];
          if(peds.length < CFG.pedMax && Math.random()<0.06) {
            IZZA.emit('spawn-ped', {});
          } else if (peds.length < CFG.pedMax) {
            IZZA.api.spawnPed && IZZA.api.spawnPed();
          }
        }catch{}
      });

      // ===== moving zone triggers =============================================
      IZZA.on('update-post', ({now})=>{
        // follow player and spawn on cooldowns
        CFG.zones.forEach(z=>{
          if (!zoneState.has(z)) zoneState.set(z, { last:0 });
          const st = zoneState.get(z);
          if (z.followPlayer && inFollowRadius(z)) {
            if ((now - st.last) >= (z.cooldownMs|0)) {
              const alive = attackers.length;
              if (alive < (z.maxAtOnce|0)) spawnAttacker();
              st.last = now;
            }
          }
        });
        updateAttackers(16/1000);
      });

      // ===== draw OVER the world (visible) ====================================
      IZZA.on('render-post', drawAttackers);

      // tap hits
      IZZA.on('update-pre', handleAttackerHits);

      // ===== tiny “AI item” dev helper (unused by players) ====================
      IZZA.ai = IZZA.ai || {};
      IZZA.ai.generateItem = async function(prompt){
        try{
          const r = await fetch(AI_SVG_URL, {
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
    }catch(e){
      console.warn('[AI] init failed', e);
    }
  });
})();
