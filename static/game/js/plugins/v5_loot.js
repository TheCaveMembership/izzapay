// /static/game/js/plugins/v5_loot.js
(function(){
  const BUILD = 'v5-loot-drops';
  console.log('[IZZA PLAY]', BUILD);

  // configurable pickup radii / lifetime
  const PICK_RADIUS = 20;            // pixels (world space, not scaled)
  const LOOT_TTL    = 25_000;        // ms; auto-despawn

  // unlock gates (by total missions completed)
  const UNLOCKS = {
    pistol:   3,
    grenade:  6,
    uzi:      8
  };

  // local refs we fill when core emits 'ready'
  let api=null, player=null, TILE=32, camera=null;

  // active loot items in world coordinates
  // kind: 'coins' | 'pistol' | 'uzi' | 'grenade'
  // x,y are top-left player-anchor (same convention as core player.x/y)
  const loot = []; // {kind,x,y,amount?,spawnedAt:number}

  // ----- helpers -----
  const now = ()=> performance.now();

  // draw small pixel icons directly on the game canvas
  function getCtx(){
    const c = document.getElementById('game');
    return c ? c.getContext('2d') : null;
  }
  function w2s(wx){ return (wx - camera.x) * (api.DRAW/api.TILE); }
  function w2sY(wy){ return (wy - camera.y) * (api.DRAW/api.TILE); }

  function drawCoinBag(ctx, sx, sy, S){
    // tiny sack
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#8b5a2b'; // bag
    ctx.fillRect(sx+S*0.30, sy+S*0.35, S*0.40, S*0.40);
    ctx.fillStyle = '#6f4320';
    ctx.fillRect(sx+S*0.36, sy+S*0.28, S*0.28, S*0.16);
    ctx.fillStyle = '#ffd23f'; // coin glint
    ctx.fillRect(sx+S*0.44, sy+S*0.48, S*0.12, S*0.12);
    ctx.restore();
  }
  function drawPistol(ctx, sx, sy, S){
    ctx.save();
    ctx.fillStyle = '#202833';
    ctx.fillRect(sx+S*0.25, sy+S*0.50, S*0.42, S*0.14);    // slide
    ctx.fillRect(sx+S*0.25, sy+S*0.60, S*0.18, S*0.10);    // frame
    ctx.fillStyle = '#444c5a';
    ctx.fillRect(sx+S*0.40, sy+S*0.60, S*0.10, S*0.16);    // grip
    ctx.restore();
  }
  function drawUzi(ctx, sx, sy, S){
    ctx.save();
    ctx.fillStyle = '#0b0e14';
    ctx.fillRect(sx+S*0.20, sy+S*0.46, S*0.52, S*0.14);    // body
    ctx.fillRect(sx+S*0.56, sy+S*0.40, S*0.16, S*0.06);    // barrel
    ctx.fillRect(sx+S*0.40, sy+S*0.60, S*0.10, S*0.20);    // mag
    ctx.fillRect(sx+S*0.26, sy+S*0.60, S*0.10, S*0.14);    // grip
    ctx.restore();
  }
  function drawGrenade(ctx, sx, sy, S){
    ctx.save();
    ctx.fillStyle = '#264a2b'; // body
    ctx.fillRect(sx+S*0.40, sy+S*0.42, S*0.20, S*0.22);
    ctx.fillRect(sx+S*0.34, sy+S*0.45, S*0.32, S*0.16);
    ctx.fillStyle = '#5b7d61'; // lever
    ctx.fillRect(sx+S*0.42, sy+S*0.34, S*0.16, S*0.08);
    ctx.fillStyle = '#c3c9cc'; // pin
    ctx.fillRect(sx+S*0.48, sy+S*0.30, S*0.04, S*0.04);
    ctx.restore();
  }

  function drawLoot(){
    const ctx = getCtx(); if(!ctx || !api) return;
    const S = api.DRAW; // sprite draw size (32*scale)
    for(const it of loot){
      const sx = w2s(it.x), sy = w2sY(it.y);
      // subtle shadow
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,.35)';
      ctx.fillRect(sx+S*0.33, sy+S*0.70, S*0.34, S*0.10);
      ctx.restore();

      if(it.kind==='coins')   drawCoinBag(ctx, sx, sy, S);
      else if(it.kind==='pistol')  drawPistol(ctx, sx, sy, S);
      else if(it.kind==='uzi')     drawUzi(ctx, sx, sy, S);
      else if(it.kind==='grenade') drawGrenade(ctx, sx, sy, S);
    }
  }

  function addLoot(kind, x, y, extra){
    loot.push({
      kind,
      x, y,
      amount: extra && extra.amount || 0,
      spawnedAt: now()
    });
  }

  function removeLoot(it){
    const i = loot.indexOf(it);
    if(i>=0) loot.splice(i,1);
  }

  function missionCount(){
    return (api.getMissionCount && api.getMissionCount()) || 0;
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

  // ----- hooks -----
  // when core is ready, capture API
  IZZA.on('ready', (a)=>{
    api=a; player=a.player; TILE=a.TILE; camera=a.camera;
  });

  // spawn coin bag where the ped was eliminated
  IZZA.on('ped-killed', (e)=>{
    // requires core to send e.x/e.y; if not present, fall back to player position
    const x = (e && e.x) || (player && player.x) || 0;
    const y = (e && e.y) || (player && player.y) || 0;
    addLoot('coins', x, y, { amount: (e && e.coins)|0 || 25 });
  });

  // spawn weapon from cop type
  IZZA.on('cop-killed', (e)=>{
    const c = e && e.cop;
    if(!c) return;
    const kind = (c.kind==='army') ? 'grenade' : (c.kind==='swat' ? 'uzi' : 'pistol');
    addLoot(kind, c.x, c.y);
  });

  // update tick – process pickups & despawns ONLY (no drawing here)
IZZA.on('update-post', ({dtSec})=>{
  if(!api) return;

  for(let i=loot.length-1;i>=0;i--){
    const it = loot[i];

    // lifetime
    if(now() - it.spawnedAt > LOOT_TTL){ loot.splice(i,1); continue; }

    // 1s grace period support (if provided by core)
    if (now() < (it.noPickupUntil || 0)) continue;

    // proximity
    const dx = (player.x) - (it.x);
    const dy = (player.y) - (it.y);
    if(Math.hypot(dx,dy) <= PICK_RADIUS){
      if(it.kind==='coins'){
        api.setCoins( api.getCoins() + (it.amount||0) );
        toast(`+${it.amount||0} IC`);
        loot.splice(i,1);
      }else{
        const req = UNLOCKS[it.kind] || 0;
        if(((api.getMissionCount && api.getMissionCount())||0) < req){
          toast(`Locked until mission ${req}.`);
        }else{
          let inv = api.getInventory ? new Set(api.getInventory()) : new Set();
          inv.add(it.kind);
          if(api.setInventory) api.setInventory([...inv]);
          toast(`Picked up ${it.kind}.`);
          loot.splice(i,1);
        }
      }
    }
  }
});

// draw AFTER core render so it doesn't get wiped
IZZA.on('render-post', ()=>{
  drawLoot();
});
