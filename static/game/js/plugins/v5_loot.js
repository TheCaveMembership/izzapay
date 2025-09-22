// /static/game/js/plugins/v5_loot.js
(function(){
  const BUILD = 'v5.8-loot:coins+pistol17+uzi50+grenade1+no-escrow';
  console.log('[IZZA PLAY]', BUILD);

  // ==== tuning ====
  const PICK_RADIUS = 20;       // world px
  const LOOT_TTL    = 25_000;   // ms
  const LOOT_DEBUG  = true;

  // Coins should ONLY go up when the bag is picked.
  // We REMOVED the old "reserve on spawn" behavior to prevent balance dips.

  let api=null, player=null, TILE=32, camera=null;

  // Active loot (world coords)
  // {kind,x,y,amount,spawnedAt,noPickupUntil,droppedAt}
  const loot = [];

  // ----- helpers -----
  const now = ()=> performance.now();
  const log = (...a)=>{ if(LOOT_DEBUG) console.log('[LOOT]', ...a); };

  function getCtx(){ const c=document.getElementById('game'); return c? c.getContext('2d') : null; }
  function w2s(wx){ return (wx - camera.x) * (api.DRAW/api.TILE); }
  function w2sY(wy){ return (wy - camera.y) * (api.DRAW/api.TILE); }

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
      // shadow
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
      noPickupUntil: (extra && extra.noPickupUntil) || 0
    };
    loot.push(it);
    log('spawn', it);
  }

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
// ---- crafted gun helpers (mirror of guns file semantics) ----
function firstEquippedCreatorGun(inv){
  if(!inv) return null;
  for(const k in inv){
    const it = inv[k];
    if(!it || !it.equipped) continue;
    if(it.type === 'weapon' && (it.subtype === 'gun' || it.gun === true)){
      // normalize ammo field
      it.ammo = (it.ammo|0);
      return { key: k, it };
    }
  }
  return null;
}

// Accept flags set by the Crafting UI:
// - it.auto === true
// - it.autoFire === true
// - it.fireMode === 'auto'
function creatorGunIsAuto(it){
  if(!it) return false;
  if(it.auto === true) return true;
  if(it.autoFire === true) return true;
  if(String(it.fireMode||'').toLowerCase() === 'auto') return true;
  return false;
}
  // ----- hooks -----
  IZZA.on('ready', (a)=>{
    api=a; player=a.player; TILE=a.TILE; camera=a.camera;
    log('ready', {DRAW:a.DRAW, TILE:a.TILE});
    window._izza_loot = loot;
  });

  // ped loot (coin bag) — spawn a coin drop; DO NOT touch balance here
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
  });

  // cop loot (weapon) — police → pistol, swat → uzi, military → grenade
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

      // TTL
      if(now() - it.spawnedAt > LOOT_TTL){ loot.splice(i,1); log('despawn (ttl)', it); continue; }

      // still in grace
      if(now() < (it.noPickupUntil || 0)) continue;

      // proximity check (player.x/y is world space top-left anchor)
      const dx = (player.x) - (it.x);
      const dy = (player.y) - (it.y);
      if(Math.hypot(dx,dy) > PICK_RADIUS) continue;

      // ----- PICKUP BEHAVIOR -----
      if(it.kind === 'coins'){
        if(api && api.getCoins && api.setCoins){
          const after = api.getCoins() + (it.amount||0);
          api.setCoins(after);
          if((it.amount||0) > 0) toast(`+${it.amount} IC`);
          log('picked coins +', it.amount||0, '=>', after);
        }
        loot.splice(i,1);
        continue;
      }

      // Weapons/consumables: ALWAYS pickable
      const inv = (api && api.getInventory) ? api.getInventory() : {};
            if(it.kind === 'pistol'){
        // If a crafted gun is equipped and NOT auto, pistol ammo goes to that crafted gun
        const cg = firstEquippedCreatorGun(inv);
        if (cg && !creatorGunIsAuto(cg.it)) {
          const slot = inv[cg.key] || (inv[cg.key] = cg.it);
          slot.ammo = (slot.ammo|0) + 17;
          if(api.setInventory) api.setInventory(inv);
          toast(`Creator gun ammo +17`);
          log('pistol pickup → crafted (semi-auto).', cg.key, 'ammo:', slot.ammo);
        } else {
          // default: pistol ammo
          const cur = inv.pistol || { owned:true, ammo:0, equipped:false };
          const had = !!inv.pistol && !!inv.pistol.owned;
          cur.owned = true;
          cur.ammo  = (cur.ammo|0) + 17;
          inv.pistol = cur;
          if(api.setInventory) api.setInventory(inv);
          toast(had ? `Pistol ammo +17` : `Picked up pistol (+17 rounds)`);
          log('picked pistol; ammo:', cur.ammo, 'ownedBefore?', had);
        }
      } else if(it.kind === 'uzi'){
        // If a crafted gun is equipped and IS auto, uzi ammo goes to that crafted gun
        const cg = firstEquippedCreatorGun(inv);
        if (cg && creatorGunIsAuto(cg.it)) {
          const slot = inv[cg.key] || (inv[cg.key] = cg.it);
          slot.ammo = (slot.ammo|0) + 50;
          if(api.setInventory) api.setInventory(inv);
          toast(`Creator gun ammo +50`);
          log('uzi pickup → crafted (auto).', cg.key, 'ammo:', slot.ammo);
        } else {
          // default: uzi ammo
          const cur = inv.uzi || { owned:true, ammo:0, equipped:false };
          const had = !!inv.uzi && !!inv.uzi.owned;
          cur.owned = true;
          cur.ammo  = (cur.ammo|0) + 50;
          inv.uzi = cur;
          if(api.setInventory) api.setInventory(inv);
          toast(had ? `Uzi ammo +50` : `Picked up Uzi (+50 rounds)`);
          log('picked uzi; ammo:', cur.ammo, 'ownedBefore?', had);
        }
      } else if(it.kind === 'grenade'){
        // Treat grenades as a stackable consumable
        const cur = inv.grenade || { count:0, equipped:false };
        cur.count = (cur.count|0) + 1;
        inv.grenade = cur;
        if(api.setInventory) api.setInventory(inv);
        toast(`Grenade +1`);
        log('picked grenade; count:', cur.count);
      }

      loot.splice(i,1);
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
