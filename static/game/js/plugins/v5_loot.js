// /static/game/js/plugins/v5_loot.js
(function(){
  const BUILD = 'v5.5-loot-drops+grace+render-post+ammo+pistol17+coinsOnPickup';
  console.log('[IZZA PLAY]', BUILD);

  // ==== tuning ====
  const PICK_RADIUS = 20;       // world px
  const LOOT_TTL    = 25_000;   // ms
  const WARN_COOLDOWN_MS = 800; // anti-spam
  const LOOT_DEBUG = true;

  // Coins: pay ONLY when the bag is picked up (no reserve/rollback).
  const RESERVE_KILL_COINS = false;

  // Pickup gates — allow pistol pickup at any time (usage is gated in core).
  const UNLOCKS = { pistol:0, grenade:6, uzi:8 };

  // ammo bookkeeping (localStorage key)
  const LS_AMMO = 'izzaAmmo';

  let api=null, player=null, TILE=32, camera=null;

  // Active loot
  const loot = []; // {kind,x,y,amount,spawnedAt,noPickupUntil,droppedAt,lastWarnAt}

  // ----- helpers -----
  const now = ()=> performance.now();
  const log = (...a)=>{ if(LOOT_DEBUG) console.log('[LOOT]', ...a); };

  function getCtx(){ const c=document.getElementById('game'); return c? c.getContext('2d') : null; }
  function w2s(wx){ return (wx - camera.x) * (api.DRAW/api.TILE); }
  function w2sY(wy){ return (wy - camera.y) * (api.DRAW/api.TILE); }

  function getAmmo(){
    try{ return JSON.parse(localStorage.getItem(LS_AMMO) || '{}') || {}; }
    catch{ return {}; }
  }
  function setAmmo(obj){
    localStorage.setItem(LS_AMMO, JSON.stringify(obj||{}));
    try{
      const inv = api && api.getInventory ? api.getInventory() : [];
      IZZA.emit('inventory-changed', { inventory: inv, ammo: obj||{} });
    }catch(e){}
  }

  // tiny pixel icons
  function drawCoinBag(ctx, sx, sy, S){
    ctx.save(); ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#8b5a2b'; ctx.fillRect(sx+S*0.30, sy+S*0.35, S*0.40, S*0.40);
    ctx.fillStyle = '#6f4320'; ctx.fillRect(sx+S*0.36, sy+S*0.28, S*0.28, S*0.16);
    ctx.fillStyle = '#ffd23f'; ctx.fillRect(sx+S*0.44, sy+S*0.48, S*0.12, S*0.12);
    ctx.restore();
  }
  function drawPistol(ctx, sx, sy, S){
    ctx.save();
    ctx.fillStyle = '#202833'; ctx.fillRect(sx+S*0.25, sy+S*0.50, S*0.42, S*0.14);
    ctx.fillRect(sx+S*0.25, sy+S*0.60, S*0.18, S*0.10);
    ctx.fillStyle = '#444c5a'; ctx.fillRect(sx+S*0.40, sy+S*0.60, S*0.10, S*0.16);
    ctx.restore();
  }
  function drawUzi(ctx, sx, sy, S){
    ctx.save();
    ctx.fillStyle = '#0b0e14';
    ctx.fillRect(sx+S*0.20, sy+S*0.46, S*0.52, S*0.14);
    ctx.fillRect(sx+S*0.56, sy+S*0.40, S*0.16, S*0.06);
    ctx.fillRect(sx+S*0.40, sy+S*0.60, S*0.10, S*0.20);
    ctx.fillRect(sx+S*0.26, sy+S*0.60, S*0.10, S*0.14);
    ctx.restore();
  }
  function drawGrenade(ctx, sx, sy, S){
    ctx.save();
    ctx.fillStyle = '#264a2b';
    ctx.fillRect(sx+S*0.40, sy+S*0.42, S*0.20, S*0.22);
    ctx.fillRect(sx+S*0.34, sy+S*0.45, S*0.32, S*0.16);
    ctx.fillStyle = '#5b7d61'; ctx.fillRect(sx+S*0.42, sy+S*0.34, S*0.16, S*0.08);
    ctx.fillStyle = '#c3c9cc'; ctx.fillRect(sx+S*0.48, sy+S*0.30, S*0.04, S*0.04);
    ctx.restore();
  }

  function drawLoot(){
    const ctx = getCtx(); if(!ctx || !api) return;
    const S = api.DRAW;
    for(const it of loot){
      const sx = w2s(it.x), sy = w2sY(it.y);
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,.35)';
      ctx.fillRect(sx+S*0.33, sy+S*0.70, S*0.34, S*0.10);
      ctx.restore();

      if(it.kind==='coins')        drawCoinBag(ctx, sx, sy, S);
      else if(it.kind==='pistol')  drawPistol(ctx, sx, sy, S);
      else if(it.kind==='uzi')     drawUzi(ctx, sx, sy, S);
      else if(it.kind==='grenade') drawGrenade(ctx, sx, sy, S);
    }
  }

  function addLoot(kind, x, y, extra){
    const it = {
      kind,
      x, y,
      amount: (extra && extra.amount) || 0,
      spawnedAt: now(),
      droppedAt: (extra && extra.droppedAt) || now(),
      noPickupUntil: (extra && extra.noPickupUntil) || 0,
      lastWarnAt: 0
    };
    loot.push(it);
    log('spawn', it);
  }

  function missionCount(){ return (api.getMissionCount && api.getMissionCount()) || 0; }

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

  // ----- hooks -----
  IZZA.on('ready', (a)=>{
    api=a; player=a.player; TILE=a.TILE; camera=a.camera;
    log('ready', {DRAW:a.DRAW, TILE:a.TILE});
    window._izza_loot = loot;
  });

  // ped loot (coin bag)
  IZZA.on('ped-killed', (e)=>{
    const t = now();
    const x = (e && e.x) || (player && player.x) || 0;
    const y = (e && e.y) || (player && player.y) || 0;
    const amount = ((e && e.coins)|0) || 25;

    addLoot('coins', x, y, {
      amount,
      droppedAt: (e && e.droppedAt) || t,
      noPickupUntil: (e && e.noPickupUntil) || t + 1000
    });

    if(RESERVE_KILL_COINS && api && api.getCoins && api.setCoins){
      const current = api.getCoins();
      api.setCoins(Math.max(0, current - amount));
    }
  });

  // cop loot (weapon)
  IZZA.on('cop-killed', (e)=>{
    const c = e && e.cop; if(!c) return;
    const t = now();
    const kind = (c.kind==='army') ? 'grenade' : (c.kind==='swat' ? 'uzi' : 'pistol');
    addLoot(kind, c.x, c.y, {
      droppedAt: (e && e.droppedAt) || t,
      noPickupUntil: (e && e.noPickupUntil) || t + 1000
    });
  });

  // process pickups & despawns
  IZZA.on('update-post', ()=>{
    if(!api) return;

    for(let i=loot.length-1;i>=0;i--){
      const it = loot[i];

      if(now() - it.spawnedAt > LOOT_TTL){ loot.splice(i,1); log('despawn (ttl)', it); continue; }
      if(now() < (it.noPickupUntil || 0)) continue;

      const dx = (player.x) - (it.x);
      const dy = (player.y) - (it.y);
      if(Math.hypot(dx,dy) > PICK_RADIUS) continue;

      if(it.kind === 'coins'){
        if(api && api.getCoins && api.setCoins){
          const after = api.getCoins() + (it.amount||0);
          api.setCoins(after);
          if((it.amount||0) > 0) toast(`+${it.amount} IC`);
        }
        loot.splice(i,1);
      }else{
        // gate pickup for uzi/grenade; pistol always allowed
        const req = UNLOCKS[it.kind] || 0;
        const mc = missionCount();
        if(mc < req){
          if(now() - (it.lastWarnAt||0) >= WARN_COOLDOWN_MS){
            toast(`Locked until mission ${req}.`);
            it.lastWarnAt = now();
          }
          continue;
        }

        // unlocked → update inventory + ammo
        let inv = api.getInventory ? new Set(api.getInventory()) : new Set();
        const ammo = getAmmo();

        if(it.kind === 'pistol'){
          const had = inv.has('pistol');
          if(!had) inv.add('pistol');
          ammo.pistol = (ammo.pistol||0) + 17;
          setAmmo(ammo);
          if(api.setInventory) api.setInventory([...inv]);
          toast(had ? `Pistol ammo +17` : `Picked up pistol (+17 rounds)`);
          IZZA.emit('inventory-changed', { inventory: [...inv], ammo });
        }else if(it.kind === 'uzi'){
          const had = inv.has('uzi');
          if(!had) inv.add('uzi');
          // ammo.uzi (future)
          setAmmo(ammo);
          if(api.setInventory) api.setInventory([...inv]);
          toast(had ? `Picked uzi` : `Picked up uzi`);
          IZZA.emit('inventory-changed', { inventory: [...inv], ammo });
        }else if(it.kind === 'grenade'){
          const had = inv.has('grenade');
          if(!had) inv.add('grenade');
          setAmmo(ammo);
          if(api.setInventory) api.setInventory([...inv]);
          toast(had ? `Picked grenade` : `Picked up grenade`);
          IZZA.emit('inventory-changed', { inventory: [...inv], ammo });
        }

        loot.splice(i,1);
      }
    }
  });

  // draw AFTER core render
  let _lastRenderLog = 0;
  IZZA.on('render-post', ()=>{
    drawLoot();
    if(LOOT_DEBUG){
      const t=now();
      if(t - _lastRenderLog > 500){ _lastRenderLog = t; log('render-post drew', loot.length, 'items'); }
    }
  });

})();
