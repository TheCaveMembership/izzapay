/* izza_ai_engine.js — AI missions + attacker spawns + dynamic SVG sprites
   Safe: attaches to IZZA bus only; no core edits.
*/
(function(){
  const MOD = 'ai-engine v2.0-hostile+medic';

  // ---------- delayed init so we never miss core ----------
  function onReady(fn){
    if (window.IZZA && IZZA.on) { fn(); return; }
    document.addEventListener('izza-core-ready', fn, { once:true });
    if (document.readyState !== 'loading') setTimeout(()=>{ if(window.IZZA&&IZZA.on) fn(); }, 1000);
  }

  onReady(function init(){
    try{
      if (!window.IZZA || !IZZA.on || !IZZA.api) return console.warn('[AI]', 'Core not ready');
      console.log('[IZZA PLUGIN]', MOD);
      toast('AI online');

      // ===== Config ===========================================================
      const CFG = {
        aiEnabled: true,
        zones: [
          { followPlayer:true, radius:7,  cooldownMs:8000,  maxAtOnce:3 },
          { followPlayer:true, radius:11, cooldownMs:14000, maxAtOnce:4 }
        ],
        pedMax: 14,
        svgSize: 32,
        dmgIntervalMs: 650,              // how often a hostile can hurt you while overlapping
        dmgPerTick: 1,                   // hearts lost per tick
        dropChance: 0.25,                // 25% chance to drop coins on kill
        dropMin: 5, dropMax: 20,
        dailyCoinCap: 250,               // max coins you can earn from these per day
        friendChance: 0.18               // spawn friendlies sometimes
      };

      // ===== Services / endpoints ============================================
      const PERSIST_BASE = (window.IZZA_PERSIST_BASE || '').replace(/\/$/,'');
      const AI_SVG_URL   = (PERSIST_BASE ? PERSIST_BASE : '') + '/api/crafting/ai_svg';
      const TILE = IZZA.api.TILE;

      // ===== Utils ============================================================
      function toast(msg){ try{ (window.bootMsg||console.log)(msg); }catch{} }
      function clamp(n,min,max){ return Math.min(max,Math.max(min,n)); }
      function rngi(a,b){ return (a + Math.floor(Math.random()*(b-a+1))); }

      function lsDaily(key){
        const d = new Date(), tag = `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`;
        const k = key+':'+tag;
        return {
          get(){ try{ return parseInt(localStorage.getItem(k)||'0',10)||0; }catch{ return 0; } },
          add(n){ try{ localStorage.setItem(k, String(this.get()+ (n|0))); }catch{} }
        };
      }
      const coinDaily = lsDaily('aiAttackerCoins');

      async function svgToImage(svg, cell=32){
        const blob = new Blob([svg], {type:'image/svg+xml'});
        const url  = URL.createObjectURL(blob);
        const img  = new Image();
        img.crossOrigin = 'anonymous';
        await new Promise((res,rej)=>{ img.onload=res; img.onerror=()=>rej(new Error('bad svg')); });
        img.src = url; URL.revokeObjectURL(url);
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

      // ===== State ============================================================
      const attackers = [];  // {x,y,spd,hp,facing,type:'hostile'|'medic', sprite, lastHitAt?, lastDmgAt?}
      const zoneState = new WeakMap();

      // detect “player attacked” (A key / mobile A)
      let recentAttackAt = 0;
      document.addEventListener('keydown', e=>{
        const k = (e.key||'').toLowerCase();
        if (k === 'a' || k === ' ') recentAttackAt = performance.now();
      }, { passive:true });
      // mobile A button
      try{
        const btnA = document.getElementById('btnA');
        btnA && btnA.addEventListener('click', ()=>{ recentAttackAt = performance.now(); }, { passive:true });
      }catch{}

      function playerGX(){ return Math.floor((IZZA.api.player.x+TILE/2)/TILE); }
      function playerGY(){ return Math.floor((IZZA.api.player.y+TILE/2)/TILE); }

      function inFollowRadius(_z){ return true; } // keep simple: zones follow player

      function randomType(){
        return (Math.random() < CFG.friendChance) ? 'medic' : 'hostile';
      }

      async function spawnAttacker(){
        const left  = Math.random()<0.5;
        const top   = Math.random()<0.5;
        const x = (left ? (IZZA.api.camera.x + 48)  : (IZZA.api.camera.x + 340));
        const y = (top  ? (IZZA.api.camera.y + 48)  : (IZZA.api.camera.y + 270));

        const type = randomType();

        const spriteKey = (type==='medic') ? 'npc_medic_v1' : ('thug_sprite_'+(1+rngi(0,2)));
        let sprite = spriteCache.get(spriteKey);
        if (sprite === undefined) {
          sprite = await aiFetchSprite(
            spriteKey,
            type==='medic'
             ? 'friendly medic bot head icon, white cross motif, soft teal glow, readable at 32px, no text'
             : 'street thug head icon, bold silhouette, cel-shaded, readable at 32px, no text, no logo'
          );
        }
        const hp = (type==='medic') ? 1 : rngi(3,5);
        const spd = (type==='medic') ? 70 : 95;

        attackers.push({ x, y, spd, hp, facing:'down', sprite, type, lastDmgAt:0 });
      }

      function updateAttackers(dtSec){
        const p = IZZA.api.player;
        attackers.forEach(a=>{
          // medic follows loosely; hostile chases
          const dx=p.x-a.x, dy=p.y-a.y, m=Math.hypot(dx,dy)||1;
          const bias = (a.type==='medic' ? 0.75 : 1.0);
          a.x += (dx/m) * a.spd * dtSec * bias;
          a.y += (dy/m) * a.spd * dtSec * bias;
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
            ctx.fillStyle = (a.type==='medic') ? '#1b8a6a' : '#7c1f1f';
            ctx.fillRect(sx+IZZA.api.DRAW*0.18, sy+IZZA.api.DRAW*0.18, IZZA.api.DRAW*0.64, IZZA.api.DRAW*0.64);
          }
        });
      }

      function overlap(a){
        const px=IZZA.api.player.x, py=IZZA.api.player.y;
        return Math.hypot(px-a.x, py-a.y) <= 22;
      }

      // Hostiles hurt you on overlap; medics heal on overlap (cooldown each)
      function applyTouchEffects(now){
        const pHP = IZZA.api.getHearts ? IZZA.api.getHearts() : (IZZA.api.player.hearts|0);
        attackers.forEach(a=>{
          if (!overlap(a)) return;

          if (a.type==='hostile'){
            if ((now - (a.lastDmgAt||0)) >= CFG.dmgIntervalMs){
              const cur = IZZA.api.getHearts ? IZZA.api.getHearts() : pHP;
              const next = clamp(cur - CFG.dmgPerTick, 0, 10);
              if (IZZA.api.setHearts) IZZA.api.setHearts(next);
              a.lastDmgAt = now;
              try{ toast('Hit!'); }catch{}
            }
          } else { // medic
            if ((now - (a.lastHealAt||0)) >= 1200){
              const cur = IZZA.api.getHearts ? IZZA.api.getHearts() : pHP;
              const next = clamp(cur + 1, 0, 10);
              if (IZZA.api.setHearts) IZZA.api.setHearts(next);
              a.lastHealAt = now;
              try{ toast('Healed +1'); }catch{}
            }
          }
        });
      }

      // Only kill when the player recently attacked
      function handlePlayerAttacks(now){
        const attackedRecently = (now - recentAttackAt) < 220; // tiny window after pressing A
        if (!attackedRecently) return;

        for(const a of [...attackers]){
          if (!overlap(a)) continue;
          if (a.type==='medic') continue;   // don’t kill medics by accident (optional)
          a.hp -= 1;
          if (a.hp<=0){
            const i = attackers.indexOf(a);
            if(i>=0) attackers.splice(i,1);

            // coin drop with cap
            if (Math.random() < CFG.dropChance){
              const already = coinDaily.get();
              if (already < CFG.dailyCoinCap){
                const amount = Math.min(CFG.dailyCoinCap - already, rngi(CFG.dropMin, CFG.dropMax));
                coinDaily.add(amount);
                IZZA.emit('loot-picked', { kind:'coins', amount });
              }
            }
          }
        }
      }

      // ===== First spawn so you SEE it ========================================
      setTimeout(()=>{ spawnAttacker(); toast('Activity nearby…'); }, 1500);

      // ===== Crowd booster (unchanged) ========================================
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

      // ===== Zone tick ========================================================
      IZZA.on('update-post', ({now})=>{
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
        applyTouchEffects(now);
        handlePlayerAttacks(now);
      });

      // ===== Draw after world so they’re visible ==============================
      IZZA.on('render-post', drawAttackers);

      // ===== (Optional) tiny dev helper to mint an SVG item ===================
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

      // ===== Local helpers ====================================================
      function toast(msg){ try{ (window.bootMsg||console.log)(msg); }catch{} }
    }catch(e){
      console.warn('[AI] init failed', e);
    }
  });
})();
