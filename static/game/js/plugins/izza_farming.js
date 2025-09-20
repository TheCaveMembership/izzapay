/* izza_farming.js — mining & fishing spots + food/potion items (consumed via ai_engine buttons) */
(function(){
  if(!window.IZZA || !IZZA.api){ return; }

  const TILE = IZZA.api.TILE;
  const spots = [
    { kind:'mine',   gx: 24, gy: 40, cooldown: 8000, last:0 },
    { kind:'mine',   gx: 68, gy: 24, cooldown: 9000, last:0 },
    { kind:'fish',   gx: 16, gy: 18, cooldown: 7000, last:0 },
    { kind:'fish',   gx: 78, gy: 48, cooldown:10000, last:0 }
  ];

  function near(px,py, s){
    const gx = Math.floor((px+TILE/2)/TILE), gy = Math.floor((py+TILE/2)/TILE);
    return (Math.abs(gx - s.gx) + Math.abs(gy - s.gy)) <= 1;
  }

  function renderSpots(){
    const cvs = document.getElementById('game'), ctx = cvs.getContext('2d');
    spots.forEach(s=>{
      const x = (s.gx*TILE - IZZA.api.camera.x) * (IZZA.api.DRAW/TILE);
      const y = (s.gy*TILE - IZZA.api.camera.y) * (IZZA.api.DRAW/TILE);
      ctx.fillStyle = s.kind==='mine' ? '#6b4e2e' : '#1b3a6b';
      ctx.globalAlpha = 0.8;
      ctx.fillRect(x+IZZA.api.DRAW*0.25, y+IZZA.api.DRAW*0.25, IZZA.api.DRAW*0.5, IZZA.api.DRAW*0.5);
      ctx.globalAlpha = 1;
    });
  }
  IZZA.on('render-under', renderSpots);

  function giveItem(id, patch){
    const inv = IZZA.api.getInventory()||{};
    const e = inv[id] || Object.assign({count:0}, patch||{});
    e.count = (e.count|0) + 1;
    inv[id] = e;
    IZZA.api.setInventory(inv);
    try{ window.dispatchEvent(new Event('izza-inventory-changed')); }catch{}
  }

  IZZA.on('update-post', ({now})=>{
    const p = IZZA.api.player;
    spots.forEach(s=>{
      if(near(p.x,p.y,s) && (now - s.last) >= s.cooldown){
        s.last = now;
        if(s.kind==='mine'){
          // Ore + chance for potion reagent
          giveItem('craft_ore', {name:'Ore Chunk', type:'item'});
          if(Math.random()<0.35){ giveItem('craft_reagent', {name:'Bitter Root', type:'item'}); }
          try{ (window.bootMsg||console.log)('Mined ore'); }catch{}
        }else{
          // Fish (food)
          giveItem('food_fish', {name:'Fresh Fish', type:'food', heal:1, iconSvg:''});
          try{ (window.bootMsg||console.log)('Caught a fish'); }catch{}
        }
      }
    });
  });

  // Simple potion craft: 1 fish + 1 reagent → Small Tonic (potion)
  function tryCraftTonic(){
    const inv = IZZA.api.getInventory()||{};
    if((inv.food_fish?.count|0) >= 1 && (inv.craft_reagent?.count|0) >= 1){
      inv.food_fish.count -= 1;
      inv.craft_reagent.count -= 1;
      const id='potion_tonic';
      const e = inv[id] || {name:'Small Tonic', type:'potion', count:0};
      e.count = (e.count|0) + 1;
      inv[id] = e;
      IZZA.api.setInventory(inv);
      try{ window.dispatchEvent(new Event('izza-inventory-changed')); }catch{}
      try{ (window.bootMsg||console.log)('Crafted Small Tonic'); }catch{}
    }
  }

  // Auto-craft when we have both pieces (keeps it satisfying early on)
  setInterval(tryCraftTonic, 6000);
})();
