// armour_packs_plugin.js — Self-contained armour shop + overlays + equip rules
// Adds 10 shop sets (40 items), data-driven, no edits to existing files.
// Works with current inventory & equips, and draws on top of the player.
//
// Requirements it uses from your world (already present in your codebase):
// - IZZA.on('ready'/'render-post'/'update-post'), IZZA.api.{getCoins,setCoins,getInventory,setInventory}
// - Shop modal DOM (#shopModal, #shopList) — same structure your store plugin uses
// - Your equip UI/buttons already toggle .equipped (or .equip / .equippedCount). We normalize conflicts here.
// - Renders like Cardboard/Pumpkin: same placement constants; minimal stylish variants per set.
// --------------------------------------------------------------------------------------------
(function(){
  const BUILD = 'armour-packs-plugin/v1';
  console.log('[IZZA PLAY]', BUILD);

  let api = null;

  // ---- Small helpers ----
  function _invRead(){
    try{
      if(IZZA?.api?.getInventory) return JSON.parse(JSON.stringify(IZZA.api.getInventory()||{}));
      const raw=localStorage.getItem('izzaInventory'); return raw? JSON.parse(raw) : {};
    }catch{ return {}; }
  }
  function _invWrite(inv){
    try{
      if(IZZA?.api?.setInventory){ IZZA.api.setInventory(inv); }
      else localStorage.setItem('izzaInventory', JSON.stringify(inv));
      try{ window.dispatchEvent(new Event('izza-inventory-changed')); }catch{}
    }catch{}
  }
  function _plural(n, one, many){ return n===1? one : many; }
  function _isEquipped(entry){
    if(!entry) return false;
    if(entry.equipped===true || entry.equip===true) return true;
    if(typeof entry.equippedCount==='number' && entry.equippedCount>0) return true;
    return false;
  }
  function _setEquipped(entry, on){
    if(!entry) return;
    entry.equipped = !!on;
    if('equip' in entry) entry.equip = !!on;
    if(typeof entry.equippedCount === 'number') entry.equippedCount = on ? 1 : 0;
  }

  // ---- Data model for sets (easy to extend) ----
  // Tier order = increasing fanciness + price (per piece)
  // Style cue: hip/urban-medieval with our “gangster/trendy/savage” twist.
  const SETS = [
    {
      id:'bronze_street',   name:'Bronze Street',   price:50,
      colors:{ base:'#b07a43', shade:'#6a4826', trim:'#2a2a2a', glow:'#ff4a2a' },
      tags:{melee:true}
    },
    {
      id:'iron_hustle',     name:'Iron Hustle',     price:80,
      colors:{ base:'#8d949b', shade:'#595f67', trim:'#1f1f1f', glow:'#ff5e2a' },
      tags:{melee:true,tank:true}
    },
    {
      id:'steel_block',     name:'Steel Block',     price:120,
      colors:{ base:'#b9c5cf', shade:'#7b8893', trim:'#222c39', glow:'#ff6a3a' },
      tags:{melee:true}
    },
    {
      id:'cobalt_crew',     name:'Cobalt Crew',     price:180,
      colors:{ base:'#315caa', shade:'#213c74', trim:'#101b33', glow:'#3dd1ff' },
      tags:{hybrid:true}
    },
    {
      id:'obsidian_syndicate', name:'Obsidian Syndicate', price:250,
      colors:{ base:'#242427', shade:'#0f0f12', trim:'#5d5d65', glow:'#ff3d3d' },
      tags:{tank:true}
    },
    {
      id:'serpent_scale',   name:'Serpent Scale',   price:350,
      colors:{ base:'#3e8d60', shade:'#2b5f42', trim:'#0e1f17', glow:'#7cff48' },
      tags:{ranged:true}
    },
    {
      id:'neon_mystic',     name:'Neon Mystic',     price:500,
      colors:{ base:'#5b3cff', shade:'#2c1f7a', trim:'#0e072e', glow:'#cfa7ff' },
      tags:{magic:true}
    },
    {
      id:'phantom_drip',    name:'Phantom Drip',    price:650,
      colors:{ base:'#6a6f88', shade:'#3a3e54', trim:'#131420', glow:'#8be7ff' },
      tags:{hybrid:true}
    },
    {
      id:'apex_titan',      name:'Apex Titan',      price:800,
      colors:{ base:'#d4d7db', shade:'#7d838c', trim:'#2a3038', glow:'#ffd866' },
      tags:{tank:true}
    },
    {
      id:'royal_savage',    name:'Royal Savage',    price:1000,
      colors:{ base:'#d6a740', shade:'#8c6a1f', trim:'#2e220c', glow:'#ffe17a' },
      tags:{hybrid:true, prestige:true}
    }
  ];

  const PIECES = [
    { slot:'head',  key:'helmet', pretty:'Helmet' },
    { slot:'chest', key:'vest',   pretty:'Vest'   },
    { slot:'legs',  key:'legs',   pretty:'Legs'   },
    { slot:'arms',  key:'arms',   pretty:'Arms'   },
  ];

  // ---- Shop glue (no change to your store file) ----
  function svgIconArmor(set, piece, w=24, h=24){
    const c=set.colors;
    // tiny 24×24 icon: simple plate + trim stripe; change shape by slot
    const body = piece.key==='helmet'
      ? `<rect x="6" y="3" width="12" height="10" rx="3" fill="${c.base}"/>
         <rect x="6" y="11" width="12" height="3" fill="${c.shade}"/>
         <circle cx="10" cy="9" r="1.5" fill="${c.glow}"/><circle cx="14" cy="9" r="1.5" fill="${c.glow}"/>`
      : piece.key==='vest'
      ? `<rect x="5" y="6" width="14" height="12" rx="2" fill="${c.base}"/>
         <rect x="6" y="12" width="12" height="3" fill="${c.shade}"/>`
      : piece.key==='legs'
      ? `<rect x="7" y="6" width="4" height="12" fill="${c.base}"/>
         <rect x="13" y="6" width="4" height="12" fill="${c.base}"/>
         <rect x="7" y="14" width="10" height="2" fill="${c.shade}"/>`
      : `<rect x="4" y="8" width="5" height="8" rx="2" fill="${c.base}"/>
         <rect x="15" y="8" width="5" height="8" rx="2" fill="${c.base}"/>
         <rect x="5" y="10" width="3" height="3" fill="${c.shade}"/><rect x="16" y="10" width="3" height="3" fill="${c.shade}"/>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${w}" height="${h}">
      <rect x="2" y="2" width="20" height="20" rx="4" fill="${c.trim}"/>
      ${body}
    </svg>`;
  }

  function addShopArmorRow(list, set, piece){
    const id = `${set.id}_${piece.key}`;
    const name = `${set.name} ${piece.pretty}`;
    const price = set.price;

    const row = document.createElement('div');
    row.className = 'shop-item';
    row.setAttribute('data-armor-pack','1');

    const meta = document.createElement('div');
    meta.className='meta';
    meta.innerHTML = `
      <div style="display:flex; align-items:center; gap:8px">
        <div>${svgIconArmor(set, piece)}</div>
        <div>
          <div class="name">${name}</div>
          <div class="sub" style="opacity:.85">Armour · ${piece.pretty}</div>
        </div>
      </div>`;

    const btn = document.createElement('button');
    btn.className='buy';
    btn.textContent = `${price} IC`;
    btn.addEventListener('click', ()=>{
      const coins = api.getCoins ? api.getCoins() : 0;
      if(coins < price){ alert('Not enough IZZA Coins'); return; }
      api.setCoins(coins - price);

      // grant/ensure in inventory
      const inv = _invRead();
      const invKey = id; // keep simple & unique
      inv[invKey] = inv[invKey] || { count:0, name, type:'armor', slot:piece.slot, equippable:true, iconSvg:svgIconArmor(set, piece) };
      inv[invKey].count = (inv[invKey].count|0) + 1;
      _invWrite(inv);

      IZZA.toast?.(`Purchased ${name}`);
    });

    row.appendChild(meta);
    row.appendChild(btn);
    list.appendChild(row);
  }

  function tryPatchShop(){
    try{
      if(!api?.ready) return;
      const modal = document.getElementById('shopModal');
      if(!modal) return;
      const open = (modal.style.display === 'flex') || (getComputedStyle(modal).display === 'flex');
      if(!open) return;
      const list = document.getElementById('shopList');
      if(!list) return;

      if(list.querySelector('[data-armor-pack]')) return; // only once per open
      // Add all sets (40 rows)
      SETS.forEach(set=>{
        PIECES.forEach(piece=> addShopArmorRow(list, set, piece));
      });
    }catch(e){ console.warn('[armour-packs] shop patch failed', e); }
  }

  // ---- Equip normalization: ensure 1 piece per slot across *all* armour items ----
  function normalizeEquipSlots(){
    const inv = _invRead(); let changed=false;
    const slots = { head:null, chest:null, legs:null, arms:null };

    // Prefer most-recently equipped in each slot (first winner keeps, rest off)
    const keys = Object.keys(inv);
    keys.forEach(k=>{
      const it = inv[k];
      if(!it || it.type!=='armor' || !it.slot) return;
      if(_isEquipped(it)){
        if(!slots[it.slot]) slots[it.slot] = k;
        else {
          _setEquipped(it,false);
          changed=true;
        }
      }
    });

    if(changed) _invWrite(inv);
  }

  // Also, if a user equips one of our pieces while another set piece is on the same slot,
  // the above guard will switch the older one off—no UI changes needed.

  // ---- Overlays (simple, tidy variants; same placement as Cardboard/Pumpkin) ----
  // Param-driven draw functions: each piece draws with set palette.
  function drawPieceWorld(ctx, px, py, scale, ox, oy, fn){
    const api=IZZA.api, S=api.DRAW, T=api.TILE;
    const sx=(px - api.camera.x)*(S/T), sy=(py - api.camera.y)*(S/T);
    ctx.save(); ctx.imageSmoothingEnabled=false;
    ctx.translate(Math.round(sx)+S*0.5, Math.round(sy)+S*0.5);
    ctx.scale(scale, scale);
    ctx.translate(ox, oy);
    fn(ctx);
    ctx.restore();
  }

  // Common shapes
  function mkHelmetPath(c){ return function(ctx){
    // dome + brow + subtle eyes
    ctx.fillStyle = c.base;
    ctx.beginPath(); ctx.moveTo(-12,2); ctx.quadraticCurveTo(0,-10,12,2); ctx.lineTo(12,7); ctx.lineTo(-12,7); ctx.closePath(); ctx.fill();
    ctx.fillStyle = c.shade; ctx.fillRect(-11,5,22,2.6);
    ctx.fillStyle = c.glow; ctx.globalAlpha=0.85;
    ctx.beginPath(); ctx.ellipse(-5.2,7.5,1.6,1.2,0,0,Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.ellipse( 5.2,7.5,1.6,1.2,0,0,Math.PI*2); ctx.fill();
    ctx.globalAlpha=1;
  };}

  function mkVestPath(c){ return function(ctx){
    ctx.fillStyle = c.base; ctx.fillRect(-12,-8,24,16);
    ctx.fillStyle = c.shade; ctx.fillRect(-10,-3,20,6);
    // tiny shoulder studs for style
    ctx.fillStyle = c.trim; ctx.fillRect(-12,-9,4,2); ctx.fillRect(8,-9,4,2);
  };}

  function mkArmsPath(c){ return function(ctx){
    ctx.fillStyle = c.base;
    ctx.fillRect(-16,-4,7,11); ctx.fillRect(9,-4,7,11);
    ctx.fillStyle = c.shade;
    ctx.fillRect(-13,-1,3,6); ctx.fillRect(12,-1,3,6);
  };}

  function mkLegsPath(c, withFlames=false){ 
    const FL = new Path2D("M0,-9 C3,-6 3,-1 0,7 C-3,-1 -3,-6 0,-9 Z");
    return function(ctx){
      ctx.fillStyle=c.base;
      ctx.fillRect(-8,0,7,14); ctx.fillRect(1,0,7,14);
      ctx.fillStyle=c.shade; ctx.fillRect(-8,4,16,3);
      // cuffs
      ctx.fillStyle=c.trim; ctx.fillRect(-8,10,7,2); ctx.fillRect(1,10,7,2);

      if(!withFlames) return;
      // modest thrusters for upper tiers
      const p=IZZA.api.player||{}, moving=!!p.moving, t=((p.animTime||0)*0.02);
      const target = moving?1:0; mkLegsPath._a = (mkLegsPath._a||0) + (target-(mkLegsPath._a||0))*0.18;
      if((mkLegsPath._a||0) < 0.02) return;

      const power=0.8+0.18*Math.sin(t*18);
      ctx.save(); ctx.globalAlpha *= mkLegsPath._a||0;
      [-5,5].forEach(fx=>{
        ctx.save(); ctx.translate(fx,13.2); ctx.scale(0.65, power);
        const g=ctx.createLinearGradient(0,-7,0,6);
        g.addColorStop(0,"#fff1a6"); g.addColorStop(0.3,"#ffd24a"); g.addColorStop(0.65,c.glow); g.addColorStop(1,"rgba(220,80,0,0.85)");
        ctx.fillStyle=g; ctx.fill(FL); ctx.restore();
      });
      ctx.restore();
    };
  }

  // Per-frame draw: render whichever armour pieces are equipped (any mix of sets)
  function drawEquippedArmour(){
    if(!api?.ready) return;
    const inv=_invRead();
    const ctx=document.getElementById('game')?.getContext('2d'); if(!ctx) return;

    // placement as cardboard
    const p=api.player, px=p.x, py=p.y, f=p.facing||'down';
    const facingShift = { down:{x:0,y:0}, up:{x:0,y:-1}, left:{x:-1.5,y:0}, right:{x:1.5,y:0} }[f];
    const HELMET={ scale:2.80, ox:(facingShift.x)*0.05, oy:-12 - (f==='up'?2:0) };
    const VEST  ={ scale:2.40, ox:facingShift.x,         oy: 3 };
    const ARMS  ={ scale:2.60, ox:facingShift.x*0.3,     oy: 2 };
    const LEGS  ={ scale:2.45, ox:facingShift.x*0.2,     oy:10 };

    // Find an equipped item for each slot and draw it with its set palette
    function pieceFor(slot){
      for(const k in inv){
        const it=inv[k]; if(!it || it.type!=='armor' || it.slot!==slot) continue;
        if(_isEquipped(it)) return {key:k, it};
      }
      return null;
    }
    function setColorsFromKey(k){
      // expect keys like "<setid>_helmet"
      const sid = (k||'').split('_').slice(0,-1).join('_');
      const s = SETS.find(x=> x.id===sid);
      return s ? s.colors : { base:'#999', shade:'#666', trim:'#222', glow:'#fff' };
    }
    const head = pieceFor('head');
    const chest= pieceFor('chest');
    const legs = pieceFor('legs');
    const arms = pieceFor('arms');

    if(legs){
      const c=setColorsFromKey(legs.key);
      const withFlames = /apex_titan|royal_savage|neon_mystic|phantom_drip/.test(legs.key);
      drawPieceWorld(ctx, px, py, LEGS.scale, LEGS.ox, LEGS.oy, mkLegsPath(c, withFlames));
    }
    if(chest){
      const c=setColorsFromKey(chest.key);
      drawPieceWorld(ctx, px, py, VEST.scale, VEST.ox, VEST.oy, mkVestPath(c));
    }
    if(arms){
      const c=setColorsFromKey(arms.key);
      drawPieceWorld(ctx, px, py, ARMS.scale, ARMS.ox, ARMS.oy, mkArmsPath(c));
    }
    if(head){
      const c=setColorsFromKey(head.key);
      drawPieceWorld(ctx, px, py, HELMET.scale, HELMET.ox, HELMET.oy, mkHelmetPath(c));
    }
  }

  // ---- Speed bump for the “royal_savage” legs (top-tier flair) ----
  (function speedBoostTopTier(){
    let base=null;
    IZZA.on?.('update-post', ()=>{
      if(!api?.ready) return;
      const inv=_invRead(), p=api.player||{};
      if(!base){ base={ speed:p.speed, moveSpeed:p.moveSpeed, maxSpeed:p.maxSpeed, maxVel:p.maxVel }; }
      const legsEquipped = Object.keys(inv).some(k=> k.endsWith('_legs') && _isEquipped(inv[k]) && k.startsWith('royal_savage'));
      const boost = 1.65;
      if(legsEquipped){
        if(typeof p.speed==='number')     p.speed     = Math.max(base.speed,     base.speed*boost);
        if(typeof p.moveSpeed==='number') p.moveSpeed = Math.max(base.moveSpeed, base.moveSpeed*boost);
        if(typeof p.maxSpeed==='number')  p.maxSpeed  = Math.max(base.maxSpeed,  base.maxSpeed*boost);
        if(typeof p.maxVel==='number')    p.maxVel    = Math.max(base.maxVel,    base.maxVel*boost);
      }else if(base){
        if(typeof p.speed==='number')     p.speed     = base.speed;
        if(typeof p.moveSpeed==='number') p.moveSpeed = base.moveSpeed;
        if(typeof p.maxSpeed==='number')  p.maxSpeed  = base.maxSpeed;
        if(typeof p.maxVel==='number')    p.maxVel    = base.maxVel;
      }
    });
  })();

  // ---- Wire up
  IZZA.on('ready', a=>{ api=a; });
  IZZA.on('render-post', tryPatchShop);
  IZZA.on('render-post', drawEquippedArmour);
  // Whenever inventory changes, ensure only one per slot is equipped
  window.addEventListener('izza-inventory-changed', normalizeEquipSlots);
  // Also run a periodic guard just in case
  IZZA.on('update-post', normalizeEquipSlots);
})();
