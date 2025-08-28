// /static/game/js/plugins/v5_loot.js
(function(){
  const BUILD = 'v5.8-loot-pistol-always-pickup+equip-gated';
  console.log('[IZZA PLAY]', BUILD);

  const PICK_RADIUS = 20;
  const LOOT_TTL = 25_000;
  const WARN_COOLDOWN_MS = 800;
  const LOOT_DEBUG = false;

  // Keep locks for higher-tier drops, but pistol should be pickup-able at any time
  const UNLOCKS = { pistol:3, grenade:6, uzi:8 };

  let api=null, player=null, TILE=32, camera=null;
  const loot = [];

  const now = ()=> performance.now();
  const log = (...a)=>{ if(LOOT_DEBUG) console.log('[LOOT]', ...a); };

  function getCtx(){ const c=document.getElementById('game'); return c? c.getContext('2d') : null; }
  function w2s(wx){ return (wx - camera.x) * (api.DRAW/api.TILE); }
  function w2sY(wy){ return (wy - camera.y) * (api.DRAW/api.TILE); }

  function drawCoinBag(ctx, sx, sy, S){
    ctx.save(); ctx.imageSmoothingEnabled=false;
    ctx.fillStyle='#8b5a2b'; ctx.fillRect(sx+S*0.30, sy+S*0.35, S*0.40, S*0.40);
    ctx.fillStyle='#6f4320'; ctx.fillRect(sx+S*0.36, sy+S*0.28, S*0.28, S*0.16);
    ctx.fillStyle='#ffd23f'; ctx.fillRect(sx+S*0.44, sy+S*0.48, S*0.12, S*0.12);
    ctx.restore();
  }
  function drawPistol(ctx, sx, sy, S){
    ctx.save();
    ctx.fillStyle='#202833'; ctx.fillRect(sx+S*0.25, sy+S*0.50, S*0.42, S*0.14);
    ctx.fillRect(sx+S*0.25, sy+S*0.60, S*0.18, S*0.10);
    ctx.fillStyle='#444c5a'; ctx.fillRect(sx+S*0.40, sy+S*0.60, S*0.10, S*0.16);
    ctx.restore();
  }
  function drawUzi(ctx, sx, sy, S){
    ctx.save();
    ctx.fillStyle='#0b0e14';
    ctx.fillRect(sx+S*0.20, sy+S*0.46, S*0.52, S*0.14);
    ctx.fillRect(sx+S*0.56, sy+S*0.40, S*0.16, S*0.06);
    ctx.fillRect(sx+S*0.40, sy+S*0.60, S*0.10, S*0.20);
    ctx.fillRect(sx+S*0.26, sy+S*0.60, S*0.10, S*0.14);
    ctx.restore();
  }
  function drawGrenade(ctx, sx, sy, S){
    ctx.save();
    ctx.fillStyle='#264a2b';
    ctx.fillRect(sx+S*0.40, sy+S*0.42, S*0.20, S*0.22);
    ctx.fillRect(sx+S*0.34, sy+S*0.45, S*0.32, S*0.16);
    ctx.fillStyle='#5b7d61'; ctx.fillRect(sx+S*0.42, sy+S*0.34, S*0.16, S*0.08);
    ctx.fillStyle='#c3c9cc'; ctx.fillRect(sx+S*0.48, sy+S*0.30, S*0.04, S*0.04);
    ctx.restore();
  }

  function drawLoot(){
    const ctx = getCtx(); if(!ctx||!api) return;
    const S = api.DRAW;
    for(const it of loot){
      const sx = w2s(it.x), sy = w2sY(it.y);
      ctx.save(); ctx.fillStyle='rgba(0,0,0,.35)'; ctx.fillRect(sx+S*0.33, sy+S*0.70, S*0.34, S*0.10); ctx.restore();
      if(it.kind==='coins') drawCoinBag(ctx, sx, sy, S);
      else if(it.kind==='pistol') drawPistol(ctx, sx, sy, S);
      else if(it.kind==='uzi') drawUzi(ctx, sx, sy, S);
      else if(it.kind==='grenade') drawGrenade(ctx, sx, sy, S);
    }
  }

  function addLoot(kind, x, y, extra){
    loot.push({
      kind, x, y,
      amount: (extra&&extra.amount)||0,
      spawnedAt: now(),
      droppedAt: (extra&&extra.droppedAt)||now(),
      noPickupUntil: (extra&&extra.noPickupUntil)||0,
      lastWarnAt: 0
    });
  }

  const missionCount = ()=> (api.getMissionCount && api.getMissionCount()) || 0;

  function toast(msg, seconds=2.4){
    let h = document.getElementById('tutHint');
    if(!h){
      h = document.createElement('div');
      h.id='tutHint';
      Object.assign(h.style,{
        position:'fixed', left:'12px', top:'64px', zIndex:7,
        background:'rgba(10,12,18,.85)', border:'1px solid #394769',
        color:'#cfe0ff', padding:'8px 10px', borderRadius:'10px', fontSize:'14px'
      });
      document.body.appendChild(h);
    }
    h.textContent = msg; h.style.display='block';
    setTimeout(()=>{ h.style.display='none'; }, seconds*1000);
  }

  IZZA.on('ready', (a)=>{
    api=a; player=a.player; TILE=a.TILE; camera=a.camera;
    window._izza_loot = loot;
  });

  // Ped → coin bag (no reservation)
  IZZA.on('ped-killed', (e)=>{
    const t = now();
    addLoot('coins',
      (e&&e.x) || player.x,
      (e&&e.y) || player.y,
      { amount: ((e&&e.coins)|0)||25, droppedAt:(e&&e.droppedAt)||t, noPickupUntil:(e&&e.noPickupUntil)||t+1000 }
    );
  });

  // Cop → weapon drop
  IZZA.on('cop-killed', (e)=>{
    const c = e && e.cop; if(!c) return;
    const t = now();
    const kind = c.kind==='army' ? 'grenade' : c.kind==='swat' ? 'uzi' : 'pistol';
    addLoot(kind, c.x, c.y, { droppedAt:(e&&e.droppedAt)||t, noPickupUntil:(e&&e.noPickupUntil)||t+1000 });
  });

  // Pickups & TTL
  IZZA.on('update-post', ()=>{
    if(!api) return;

    for(let i=loot.length-1;i>=0;i--){
      const it = loot[i];

      if(now() - it.spawnedAt > LOOT_TTL){ loot.splice(i,1); continue; }
      if(now() < (it.noPickupUntil||0)) continue;

      const dx = (player.x) - (it.x);
      const dy = (player.y) - (it.y);
      if(Math.hypot(dx,dy) > PICK_RADIUS) continue;

      if(it.kind === 'coins'){
        const after = api.getCoins() + (it.amount||0);
        api.setCoins(after);
        if((it.amount||0)>0) toast(`+${it.amount} IC`);
        loot.splice(i,1);
        continue;
      }

      // --------- Mission lock: skip for pistols (pickup ALWAYS allowed) ----------
      const requiresLock = (it.kind !== 'pistol');
      if(requiresLock){
        const req = UNLOCKS[it.kind] || 0;
        const mc = missionCount();
        if(mc < req){
          if(now() - (it.lastWarnAt||0) >= WARN_COOLDOWN_MS){
            toast(`Locked until mission ${req}.`);
            it.lastWarnAt = now();
          }
          continue;
        }
      }

      // --------- Write into core inventory object ---------
      if(!api.getInventory || !api.setInventory){ loot.splice(i,1); continue; }
      const inv = api.getInventory() || {};

      if(it.kind === 'pistol'){
        const pistol = inv.pistol || { owned:false, ammo:0, equipped:false };
        const hadBefore = pistol.owned || (pistol.ammo|0)>0;
        pistol.owned = true;
        pistol.ammo = (pistol.ammo|0) + 17;     // every pickup +17
        inv.pistol = pistol;
        api.setInventory(inv);
        toast(hadBefore ? `Pistol ammo +17` : `Picked up pistol (+17 rounds)`);
        IZZA.emit('inventory-changed', { inventory: inv });
      }else if(it.kind === 'uzi'){
        inv.uzi = inv.uzi || { owned:false, ammo:0, equipped:false };
        const hadBefore = inv.uzi.owned || (inv.uzi.ammo|0)>0;
        inv.uzi.owned = true;
        inv.uzi.ammo = (inv.uzi.ammo|0) + 30;
        api.setInventory(inv);
        toast(hadBefore ? `Uzi ammo +30` : `Picked up Uzi (+30 rounds)`);
        IZZA.emit('inventory-changed', { inventory: inv });
      }else if(it.kind === 'grenade'){
        inv.grenade = inv.grenade || { count:0 };
        inv.grenade.count = (inv.grenade.count|0) + 1;
        api.setInventory(inv);
        toast(`Grenade +1`);
        IZZA.emit('inventory-changed', { inventory: inv });
      }

      loot.splice(i,1);
    }
  });

  IZZA.on('render-post', drawLoot);
})();
