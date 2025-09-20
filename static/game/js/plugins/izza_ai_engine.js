/* izza_ai_engine.js — advanced AI: persistent attackers, melee, heals, AI SVG sprites */
(function(){
  const MOD = 'ai-engine v2.0';

  // ---------- wait for core ----------
  function onReady(fn){
    if (window.IZZA && IZZA.on) { fn(); return; }
    document.addEventListener('izza-core-ready', fn, { once:true });
    if (document.readyState !== 'loading') setTimeout(()=>{ if(window.IZZA&&IZZA.on) fn(); }, 1000);
  }

  onReady(function init(){
    if (!window.IZZA || !IZZA.on || !IZZA.api) return console.warn('[AI]', 'Core not ready');
    console.log('[IZZA PLUGIN]', MOD);

    // ===== Config =============================================================
    const CFG = {
      // spawn cadence (follows the player; we clamp with a budget so it’s not farmable)
      spawn: [
        { follow:true, cooldownMs: 4500,  maxNear: 2, radiusTiles: 8  }, // close ring
        { follow:true, cooldownMs: 8000,  maxNear: 4, radiusTiles: 14 }  // outer ring
      ],
      pedMax: 14,

      // combat
      thug: {
        hp: 3,
        spd: 95,               // px/s
        meleeRange: 18,        // px
        windupMs: 280,
        strikeCooldownMs: 900, // per-enemy
        dmgHearts: 1
      },
      playerInvulnMs: 700,     // grace after taking damage
      knockback: 20,           // px applied to player on hit

      // economy balance
      coinDropChance: 0.28,
      coinMin: 6,
      coinMax: 22,
      heartDropChance: 0.08,
      coinBudgetPerMin: 180,   // soft cap — stops farming feels

      // support (healing visitors when you’re low)
      aid: {
        enabled: true,
        wantBelowHearts: 3,
        chance: 0.14,
        spd: 70,
        heal: 1
      },

      svgSize: 32
    };

    // ===== Endpoints (AI SVG) =================================================
    const BASE = (String(window.IZZA_PERSIST_BASE||'').replace(/\/+$/,'') || '');
    const AI_SVG_URL = BASE + '/api/crafting/ai_svg';

    const TILE = IZZA.api.TILE;
    const DRAW = IZZA.api.DRAW;

    // ===== Utils ============================================================== 
    function toast(msg){ try{ (window.bootMsg||console.log)(msg); }catch{} }
    const clamp = (n,a,b)=> Math.max(a, Math.min(b,n));
    const rndInt = (a,b)=> (a + Math.floor(Math.random()*(b-a+1)));

    async function svgToImage(svg, cell=32){
      try{
        const blob = new Blob([svg], {type:'image/svg+xml'});
        const url  = URL.createObjectURL(blob);
        const img  = new Image(); img.crossOrigin='anonymous';
        await new Promise((res,rej)=>{ img.onload=res; img.onerror=()=>rej(new Error('bad svg')); });
        img.src = url; URL.revokeObjectURL(url);
        const c = document.createElement('canvas'); c.width=cell; c.height=cell;
        const g = c.getContext('2d', {willReadFrequently:true}); g.imageSmoothingEnabled=false;
        g.drawImage(img, 0, 0, cell, cell);
        const out = new Image(); out.src = c.toDataURL('image/png');
        await new Promise(r=> out.onload=r);
        return out;
      }catch{ return null; }
    }

    // cache one sprite per role
    const spriteCache = new Map();
    async function getRoleSprite(role, prompt){
      if (spriteCache.has(role)) return spriteCache.get(role);
      let img = null;
      try{
        const r = await fetch(AI_SVG_URL, {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          credentials:'include',
          body: JSON.stringify({ prompt, meta:{ name:role, part:'helmet', style:'cartoon', animate:false } })
        });
        const j = await r.json().catch(()=>null);
        if (j && j.ok && j.svg) img = await svgToImage(j.svg, CFG.svgSize);
      }catch{}
      spriteCache.set(role, img); // even if null, so we don’t thrash
      return img;
    }

    // ===== State ============================================================== 
    const attackers = []; // {x,y, vx,vy, hp, type:'thug'|'aid', sprite, state, lastStrike, windupUntil, hurtUntil}
    let lastPlayerHitAt = 0;
    let lastAttackKeyAt = 0; // A button/keyboard hit window
    let minuteCoinBudget = CFG.coinBudgetPerMin|0;
    let budgetResetAt = Date.now() + 60_000;

    // input hooks for the “attack window”
    (function hookAttackInputs(){
      const aBtn = document.getElementById('btnA');
      if (aBtn){
        ['click','touchstart','pointerdown'].forEach(ev=>
          aBtn.addEventListener(ev, ()=>{ lastAttackKeyAt = performance.now(); }, {passive:true})
        );
      }
      document.addEventListener('keydown', (e)=>{
        const k = (e.key||'').toLowerCase();
        if (k==='a') lastAttackKeyAt = performance.now();
      }, {passive:true});
      // If your guns plugin emits anything, catch it too (safe-ignored otherwise)
      try{
        IZZA.on('fire-weapon', ()=>{ lastAttackKeyAt = performance.now(); });
        IZZA.on('player-swing', ()=>{ lastAttackKeyAt = performance.now(); });
      }catch{}
    })();

    const playerGX = ()=> Math.floor((IZZA.api.player.x+TILE/2)/TILE);
    const playerGY = ()=> Math.floor((IZZA.api.player.y+TILE/2)/TILE);

    function spawnAtCameraEdge(role){
      const left  = Math.random()<0.5;
      const top   = Math.random()<0.5;
      const x = (left ? (IZZA.api.camera.x + 48)  : (IZZA.api.camera.x + 340));
      const y = (top  ? (IZZA.api.camera.y + 48)  : (IZZA.api.camera.y + 270));
      const base = (role==='aid')
        ? { hp:1, spd:CFG.aid.spd, type:'aid' }
        : { hp:CFG.thug.hp, spd:CFG.thug.spd, type:'thug', lastStrike:0, windupUntil:0, hurtUntil:0 };
      attackers.push(Object.assign({ x, y, vx:0, vy:0, sprite:null, state:'chase' }, base));
    }

    async function ensureRoleSprite(a){
      if (a.sprite!==null) return;
      if (a.type==='aid'){
        a.sprite = await getRoleSprite('aid_unit',
          'top-down helper medkit icon, readable at 32px, no text, bright teal cross, no background');
      }else{
        a.sprite = await getRoleSprite('street_thug',
          'top-down thug face icon, cel-shaded, dark hoodie, readable at 32px, no text, no bg');
      }
    }

    // ===== Update =============================================================
    function coinDrop(amount){
      if (Date.now() >= budgetResetAt){ minuteCoinBudget = CFG.coinBudgetPerMin|0; budgetResetAt = Date.now()+60_000; }
      if (minuteCoinBudget <= 0) return; // budget exhausted
      const grant = clamp(amount|0, 1, minuteCoinBudget);
      minuteCoinBudget -= grant;
      IZZA.emit('loot-picked', { kind:'coins', amount: grant });
    }

    function hurtPlayer(now, dmg, from){
      if ((now - lastPlayerHitAt) < CFG.playerInvulnMs) return;
      lastPlayerHitAt = now;
      try{
        const cur = IZZA.api.getHearts();
        IZZA.api.setHearts(Math.max(0, cur - (dmg|0)));
      }catch{}
      // small knockback away from attacker
      try{
        const dx = IZZA.api.player.x - from.x;
        const dy = IZZA.api.player.y - from.y;
        const m  = Math.hypot(dx,dy)||1;
        IZZA.api.player.x += (dx/m) * CFG.knockback;
        IZZA.api.player.y += (dy/m) * CFG.knockback;
      }catch{}
    }

    function playerIsAttacking() {
      return (performance.now() - lastAttackKeyAt) < 240; // short window
    }

    function meleeHitbox(){
      // a small arc in the facing direction — keep it simple: a circle in front
      const p  = IZZA.api.player;
      const r  = 28;
      return { x:p.x, y:p.y, r };
    }

    function updateThug(a, dt, now){
      const p = IZZA.api.player;
      const dx=p.x-a.x, dy=p.y-a.y, m=Math.hypot(dx,dy)||1;

      // chase unless winding up / staggered
      if (now > (a.hurtUntil||0) && now >= (a.windupUntil||0)){
        a.x += (dx/m) * a.spd * dt;
        a.y += (dy/m) * a.spd * dt;
        a.state = 'chase';
      }

      // enter melee
      const dist = Math.hypot(p.x-a.x, p.y-a.y);
      if (dist <= CFG.thug.meleeRange){
        // start windup if ready
        if (now >= (a.lastStrike||0) + CFG.thug.strikeCooldownMs && now < (a.windupUntil||0) === false){
          a.state = 'windup';
          a.windupUntil = now + CFG.thug.windupMs;
        }

        // complete strike
        if (a.state==='windup' && now >= a.windupUntil){
          a.state='recover';
          a.lastStrike = now;
          hurtPlayer(now, CFG.thug.dmgHearts, a);
        }
      }
    }

    function updateAid(a, dt){
      // gently approach; despawn after healing
      const p = IZZA.api.player;
      const dx=p.x-a.x, dy=p.y-a.y, m=Math.hypot(dx,dy)||1;
      a.x += (dx/m) * a.spd * dt;
      a.y += (dy/m) * a.spd * dt;

      // deliver heal on touch
      if (Math.hypot(p.x-a.x, p.y-a.y) <= 18){
        try{
          const cur = IZZA.api.getHearts();
          IZZA.api.setHearts(Math.min(10, cur + (CFG.aid.heal|0)));
        }catch{}
        // small coin thank-you (very small, not budgeted)
        if (Math.random() < 0.15) IZZA.emit('loot-picked', { kind:'coins', amount: 3 });
        // remove self
        attackers.splice(attackers.indexOf(a), 1);
      }
    }

    function updateAttackers(dt, now){
      for (const a of [...attackers]){
        if (a.type==='aid') updateAid(a, dt);
        else updateThug(a, dt, now);

        // despawn if far off-screen (keeps list tidy)
        const off = (a.x < IZZA.api.camera.x-220) || (a.x > IZZA.api.camera.x+560) ||
                    (a.y < IZZA.api.camera.y-220) || (a.y > IZZA.api.camera.y+400);
        if (off && a.type!=='aid') {
          attackers.splice(attackers.indexOf(a),1);
        }
      }
    }

    function handlePlayerStrikes(){
      if (!playerIsAttacking()) return;
      const hb = meleeHitbox();
      for (const a of [...attackers]){
        // only damage thugs
        if (a.type!=='thug') continue;
        if (Math.hypot((IZZA.api.player.x - a.x), (IZZA.api.player.y - a.y)) <= hb.r){
          a.hp -= 1;
          a.hurtUntil = performance.now() + 150; // tiny stagger
          if (a.hp <= 0){
            // reward (chance + budget)
            if (Math.random() < CFG.coinDropChance){
              coinDrop(rndInt(CFG.coinMin, CFG.coinMax));
            } else if (Math.random() < CFG.heartDropChance){
              try{
                const cur = IZZA.api.getHearts();
                IZZA.api.setHearts(Math.min(10, cur + 1));
              }catch{}
            }
            attackers.splice(attackers.indexOf(a),1);
          }
        }
      }
    }

    // ===== Spawns (follow player) =============================================
    const zoneState = new WeakMap();
    function doSpawns(now){
      // Optional helpful visitor when low
      try{
        if (CFG.aid.enabled && (IZZA.api.getHearts()|0) <= CFG.aid.wantBelowHearts){
          if (Math.random() < CFG.aid.chance) spawnAtCameraEdge('aid');
        }
      }catch{}

      CFG.spawn.forEach(z=>{
        if (!zoneState.has(z)) zoneState.set(z, { last:0 });
        const st = zoneState.get(z);
        if ((now - st.last) < z.cooldownMs) return;

        // count how many are near player already
        const px = IZZA.api.player.x, py = IZZA.api.player.y;
        const near = attackers.filter(a => a.type==='thug' && Math.hypot(a.x-px, a.y-py) <= z.radiusTiles*TILE).length;
        if (near < (z.maxNear|0)){
          spawnAtCameraEdge('thug');
          st.last = now;
        }
      });
    }

    // ===== Render ============================================================= 
    function drawAttackers(){
      const cvs = document.getElementById('game'); if (!cvs) return;
      const ctx = cvs.getContext('2d');

      attackers.forEach(a=>{
        const sx = (a.x - IZZA.api.camera.x) * (DRAW/TILE);
        const sy = (a.y - IZZA.api.camera.y) * (DRAW/TILE);
        const s  = DRAW*0.72;
        if (a.sprite){
          ctx.drawImage(a.sprite, sx + DRAW*0.14, sy + DRAW*0.14, s, s);
        } else {
          // fallback block: thug=red, aid=teal
          ctx.fillStyle = (a.type==='aid') ? '#0abfb1' : '#7c1f1f';
          ctx.fillRect(sx + DRAW*0.18, sy + DRAW*0.18, DRAW*0.64, DRAW*0.64);
        }
      });
    }

    // ===== Wiring ============================================================= 
    // first visible spawn so you notice activity, then regular cadence
    setTimeout(()=>{ spawnAtCameraEdge('thug'); toast('⚠️ Activity nearby…'); }, 1200);

    IZZA.on('update-post', ({now})=>{
      // refill sprite handles lazily (doesn’t block)
      attackers.forEach(a=>{ if (a.sprite===null) ensureRoleSprite(a); });

      doSpawns(now);
      updateAttackers(16/1000, now);
    });

    IZZA.on('render-post', drawAttackers);
    IZZA.on('update-pre', handlePlayerStrikes);

    // small ambient crowd boost (unchanged)
    IZZA.on('update-post', ()=>{
      try{
        const peds = IZZA.api.pedestrians || [];
        if (peds.length < CFG.pedMax && Math.random()<0.05) {
          IZZA.emit('spawn-ped', {});
        } else if (peds.length < CFG.pedMax) {
          IZZA.api.spawnPed && IZZA.api.spawnPed();
        }
      }catch{}
    });

    // expose tiny dev helper
    IZZA.ai = IZZA.ai || {};
    IZZA.ai.spawnThug = ()=> spawnAtCameraEdge('thug');
  });
})();
