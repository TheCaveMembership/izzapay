// armour_packs_plugin.js — Self-contained armour shop + overlays + equip rules
// Adds 10 shop sets (40 items), data-driven, no edits to existing files.
// Works with current inventory & equips, and draws on top of the player.
(function(){
  const BUILD = 'armour-packs-plugin/v1.4-crafted-weapons+pricebook';
  console.log('[IZZA PLAY]', BUILD);

  let api = null;

  // ---------- Pending crafted items for shop (NEW) ----------
  const _pendingCraftShopAdds = []; // rows to inject when shop opens

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
  function _writePriceBookLastPaid(key, price){
    try{
      const PB_KEY='izzaPriceBook';
      const pb = JSON.parse(localStorage.getItem(PB_KEY)||'{}');
      pb[key] = { lastPaid: price|0 };
      localStorage.setItem(PB_KEY, JSON.stringify(pb));
    }catch{}
  }

  // ---- Data model for sets (easy to extend) ----
  const SETS = [
    { id:'bronze_street',   name:'Bronze Street',   price:50,  colors:{ base:'#b07a43', shade:'#6a4826', trim:'#2a2a2a', glow:'#ff4a2a' }, tags:{melee:true} },
    { id:'iron_hustle',     name:'Iron Hustle',     price:80,  colors:{ base:'#8d949b', shade:'#595f67', trim:'#1f1f1f', glow:'#ff5e2a' }, tags:{melee:true,tank:true} },
    { id:'steel_block',     name:'Steel Block',     price:120, colors:{ base:'#b9c5cf', shade:'#7b8893', trim:'#222c39', glow:'#ff6a3a' }, tags:{melee:true} },
    { id:'cobalt_crew',     name:'Cobalt Crew',     price:180, colors:{ base:'#315caa', shade:'#213c74', trim:'#101b33', glow:'#3dd1ff' }, tags:{hybrid:true} },
    { id:'obsidian_syndicate', name:'Obsidian Syndicate', price:250, colors:{ base:'#242427', shade:'#0f0f12', trim:'#5d5d65', glow:'#ff3d3d' }, tags:{tank:true} },
    { id:'serpent_scale',   name:'Serpent Scale',   price:350, colors:{ base:'#3e8d60', shade:'#2b5f42', trim:'#0e1f17', glow:'#7cff48' }, tags:{ranged:true} },
    { id:'neon_mystic',     name:'Neon Mystic',     price:500, colors:{ base:'#5b3cff', shade:'#2c1f7a', trim:'#0e072e', glow:'#cfa7ff' }, tags:{magic:true} },
    { id:'phantom_drip',    name:'Phantom Drip',    price:650, colors:{ base:'#6a6f88', shade:'#3a3e54', trim:'#131420', glow:'#8be7ff' }, tags:{hybrid:true} },
    { id:'apex_titan',      name:'Apex Titan',      price:800, colors:{ base:'#d4d7db', shade:'#7d838c', trim:'#2a3038', glow:'#ffd866' }, tags:{tank:true} },
    { id:'royal_savage',    name:'Royal Savage',    price:1000,colors:{ base:'#d6a740', shade:'#8c6a1f', trim:'#2e220c', glow:'#ffe17a' }, tags:{hybrid:true, prestige:true} }
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
      const coins = api?.getCoins ? api.getCoins() : 0;
      if(coins < price){ alert('Not enough IZZA Coins'); return; }
      api?.setCoins && api.setCoins(coins - price);

      // grant/ensure in inventory (INLINE SVG + INCREMENTAL COUNT)
      const inv = _invRead();
      const invKey = id;
      const inlineSvg = svgIconArmor(set, piece);
      inv[invKey] = inv[invKey] || { count:0, name, type:'armor', slot:piece.slot, equippable:true, iconSvg:inlineSvg };
      inv[invKey].count = (inv[invKey].count|0) + 1;
      if (!inv[invKey].iconSvg) inv[invKey].iconSvg = inlineSvg;
      _invWrite(inv);

      try{
        const host = document.getElementById('invPanel');
        if(host && host.style.display!=='none' && typeof window.renderInventoryPanel==='function'){
          window.renderInventoryPanel();
        }
      }catch{}

      IZZA?.toast?.(`Purchased ${name}`);
      try { window.dispatchEvent(new Event('izza-coins-changed')); } catch {}
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
      // replace with this
const open = getComputedStyle(modal).display !== 'none';
      if(!open) return;

      const list = document.getElementById('shopBuyList') || document.getElementById('shopList');
      if(!list) return;

      if(!list.querySelector('[data-armor-pack]')){
        SETS.forEach(set=>{
          PIECES.forEach(piece=> addShopArmorRow(list, set, piece));
        });
      }

      // (NEW) Flush any pending crafted items into the shop
      if (_pendingCraftShopAdds.length){
        _pendingCraftShopAdds.splice(0).forEach(add=>{
          if (!list.querySelector(`[data-craft-item="${add.key}"]`)){
            const row = document.createElement('div'); row.className='shop-item'; row.dataset.craftItem = add.key;
            row.setAttribute('data-store-ext','1');
            const meta = document.createElement('div'); meta.className='meta';
            meta.innerHTML = `
              <div style="display:flex; align-items:center; gap:8px">
                <div data-icon="1">${add.svg}</div>
                <div>
                  <div class="name">${add.name}</div>
                  <div class="sub" style="opacity:.85">Custom · ${add.slot}</div>
                </div>
              </div>`;
            const btn = document.createElement('button'); btn.className='buy'; btn.textContent = `${add.price} IC`;
            btn.addEventListener('click', ()=>{
              try{
                const coins = IZZA?.api?.getCoins ? IZZA.api.getCoins() : (IZZA?.api?.player?.coins|0);
                if ((coins|0) < add.price){ alert('Not enough IZZA Coins'); return; }
                IZZA?.api?.setCoins && IZZA.api.setCoins((coins|0) - add.price);

                // --- Add to buyer's inventory ---
                const inv2 = _invRead();
                inv2[add.key] = inv2[add.key] || { count:0, name:add.name, type:add.type, slot:add.slot, equippable:true, iconSvg:add.svg };
                // normalize subtype for weapons so guns.js treats correctly
                if (add.type==='weapon'){
                  if (!inv2[add.key].subtype) inv2[add.key].subtype = (add.part==='melee'||add.slot==='hands'&&/melee/i.test(add.name)) ? 'melee' : 'gun';
                  if (inv2[add.key].subtype==='gun'){
                    // starter ammo for new guns
                    if (typeof inv2[add.key].ammo!=='number' || inv2[add.key].ammo<0) inv2[add.key].ammo = 60;
                  }
                }
                if (inv2[add.key].count!=null){ inv2[add.key].count = (inv2[add.key].count|0) + 1; } else { inv2[add.key].owned = true; }
                _invWrite(inv2);

                // --- Record lastPaid so Sell tab shows 40% (not 10 IC default) ---
                _writePriceBookLastPaid(add.key, add.price);

                try { if(typeof window.renderInventoryPanel==='function') window.renderInventoryPanel(); } catch{}
                IZZA?.toast?.(`Purchased ${add.name}`);
                try { window.dispatchEvent(new Event('izza-coins-changed')); } catch {}
              }catch(e){ console.warn('[craft shop] buy failed', e); }
            });
            row.appendChild(meta); row.appendChild(btn); list.appendChild(row);
          }
        });
      }
    }catch(e){ console.warn('[armour-packs] shop patch failed', e); }
  }

  // ---- Equip normalization ----
  function normalizeEquipSlots(){
    const inv = _invRead(); let changed=false;
    // include hands (weapons) but DO NOT touch arms (armour)
    const slots = { head:null, chest:null, legs:null, arms:null, hands:null };

    Object.keys(inv).forEach(k=>{
      const it = inv[k];
      if(!it || !it.slot) return;
      if(_isEquipped(it)){
        const s = it.slot;
        if(!slots[s]) slots[s] = k;
        else { _setEquipped(it,false); changed=true; }
      }
    });

    if(changed) _invWrite(inv);
  }

  // ---- Migration: normalize any legacy armour entries *every time* inventory changes
function migrateArmorPackItems(){
  const inv = _invRead(); let changed = false;

  const setIds = new Set(SETS.map(s => s.id));

  function pieceSlotFromKey(k){
    if(/_helmet$/.test(k)) return 'head';
    if(/_vest$/.test(k))   return 'chest';
    if(/_legs$/.test(k))   return 'legs';
    if(/_arms$/.test(k))   return 'arms';
    return null;
  }
  function nameFromKey(k){
    const sid = k.replace(/_(helmet|vest|legs|arms)$/,'');
    const set = SETS.find(s=> s.id===sid);
    const piece = /helmet$/.test(k)?'Helmet': /vest$/.test(k)?'Vest': /legs$/.test(k)?'Legs':'Arms';
    return set ? `${set.name} ${piece}` : k.replace(/_/g,' ');
  }
  function inlineSvgForKey(k){
    const sid = k.replace(/_(helmet|vest|legs|arms)$/,'');
    const set = SETS.find(s=> s.id===sid);
    const pieceKey = /helmet$/.test(k)?'helmet': /vest$/.test(k)?'vest': /legs$/.test(k)?'legs':'arms';
    return set ? svgIconArmor(set, { key:pieceKey, pretty:'' }) : '';
  }

  Object.keys(inv).forEach(k=>{
    const it = inv[k];
    if(!it || typeof it !== 'object') return;

    // Only touch our armour-pack pieces
    const sid = k.split('_').slice(0,-1).join('_');
    if(!setIds.has(sid)) return;

    const slot = pieceSlotFromKey(k);
    if(slot && !it.slot){ it.slot = slot; changed = true; }

    if(it.type !== 'armor'){ it.type = 'armor'; changed = true; }
    if(it.equippable !== true){ it.equippable = true; changed = true; }
    if(!it.name){ it.name = nameFromKey(k); changed = true; }

    // Convert legacy owned:true to count:1 (and ensure numeric count)
    if(typeof it.count !== 'number' || it.count < 0){
      it.count = (it.owned === true ? 1 : (it.count|0));
      delete it.owned;
      changed = true;
    }

    // Ensure we have a sane-size inline SVG
    const raw = (typeof it.iconSvg === 'string' ? it.iconSvg : '').trim();
    if(!raw){
      it.iconSvg = inlineSvgForKey(k);
      changed = true;
    }
  });

  if(changed) _invWrite(inv);
}

  // ---- Overlays (draw over player) ----
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

  function mkHelmetPath(c){ return function(ctx){
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
      ctx.fillStyle=c.trim; ctx.fillRect(-8,10,7,2); ctx.fillRect(1,10,7,2);

      if(!withFlames) return;
      const p=IZZA.api.player||{}, moving=!!p.moving, t=((p.animTime||0)*0.02);
      const target = moving?1:0; mkLegsPath._a = (mkLegsPath._a||0) + (target-(mkLegsPath._a||0))*0.18;
      if((mkLegsPath._a||0) < 0.02) return;

      const power=0.8+0.18*Math.sin(t*18);
      ctx.save(); ctx.globalAlpha *= (mkLegsPath._a||0);
      [-5,5].forEach(fx=>{
        ctx.save(); ctx.translate(fx,13.2); ctx.scale(0.65, power);
        const g=ctx.createLinearGradient(0,-7,0,6);
        g.addColorStop(0,"#fff1a6"); g.addColorStop(0.3,"#ffd24a"); g.addColorStop(0.65,c.glow); g.addColorStop(1,"rgba(220,80,0,0.85)");
        ctx.fillStyle=g; ctx.fill(FL); ctx.restore();
      });
      ctx.restore();
    };
  }

  function drawEquippedArmour(){
    if(!api?.ready) return;
    const inv=_invRead();
    const ctx=document.getElementById('game')?.getContext('2d'); if(!ctx) return;

    const p=api.player, px=p.x, py=p.y, f=p.facing||'down';
    const facingShift = { down:{x:0,y:0}, up:{x:0,y:-1}, left:{x:-1.5,y:0}, right:{x:1.5,y:0} }[f];
    const HELMET={ scale:2.80, ox:(facingShift.x)*0.05, oy:-12 - (f==='up'?2:0) };
    const VEST  ={ scale:2.40, ox:facingShift.x,         oy: 3 };
    const ARMS  ={ scale:2.60, ox:facingShift.x*0.3,     oy: 2 };
    const LEGS  ={ scale:2.45, ox:facingShift.x*0.2,     oy:10 };

    function pieceFor(slot){
      for(const k in inv){
        const it=inv[k]; if(!it || !it.slot) continue;
        if(_isEquipped(it) && it.slot===slot && it.type==='armor') return {key:k, it};
      }
      return null;
    }
    function setColorsFromKey(k){
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

    // NOTE: crafted weapons (type:'weapon', slot:'hands') are **not** drawn here.
    // They should be picked up by your existing weapon/gun system in guns.js.
  }

  // ---- Speed bump for the “royal_savage” legs (top-tier flair) ----
  (function speedBoostTopTier(){
    let base=null;
    IZZA?.on?.('update-post', ()=>{
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

  // === Crafted-item hook (UPDATED) =========================================
  (function(){
    function partToSlotAndType(part){
      const p = String(part||'').toLowerCase();
      if (p==='helmet') return { slot:'head',  type:'armor',  subtype:null };
      if (p==='vest')   return { slot:'chest', type:'armor',  subtype:null };
      if (p==='legs')   return { slot:'legs',  type:'armor',  subtype:null };
      if (p==='arms')   return { slot:'arms',  type:'armor',  subtype:null };
      if (p==='gun')    return { slot:'hands', type:'weapon', subtype:'gun'   };
      if (p==='melee')  return { slot:'hands', type:'weapon', subtype:'melee' };
      return { slot:'chest', type:'armor', subtype:null };
    }
    function makeKey(name){
      const base = (String(name||'untitled').toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'')||'item');
      return `craft_${base}_${Date.now()}`;
    }
    function ensureSvgWrap(svg){
      const inner = String(svg||'').trim();
      // Force inventory-safe size
      if (/<svg/i.test(inner)) {
        return inner.replace(
          /<svg\b([^>]*)>/i,
          (m, attrs)=> `<svg ${attrs} width="28" height="28" preserveAspectRatio="xMidYMid meet" style="display:block;max-width:100%;height:auto">`
        );
      }
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="28" height="28" preserveAspectRatio="xMidYMid meet" style="display:block;max-width:100%;height:auto">${inner}</svg>`;
    }

    window.ArmourPacks = window.ArmourPacks || {};
    window.ArmourPacks.injectCraftedItem = function(input){
      try{
        const name = String(input?.name||'Untitled').slice(0,48);
        const key  = makeKey(name);
        const map  = partToSlotAndType(input?.part);
        const slot = map.slot;
        const type = map.type;
        const subtype = map.subtype || null;
        const inlineSvg = ensureSvgWrap(input?.svg||'');
        const price = Math.max(50, Math.min(250, parseInt(input?.priceIC||'100',10)||100));
        const ff = input?.featureFlags || {};

        // ---- inventory grant (creator minted copy) ----
        const inv = _invRead();
        inv[key] = inv[key] || { count:0, name, type, slot, equippable:true, iconSvg:inlineSvg };
if (type === 'weapon') {
  // remember what the creator picked: 'gun' or 'melee'
  inv[key].weaponKind = String(input?.part||'').toLowerCase()==='gun' ? 'gun' : 'melee';
}
        inv[key].count = (inv[key].count|0) + 1;
        if (!inv[key].iconSvg) inv[key].iconSvg = inlineSvg;

        // creator copy rules:
        inv[key].nonSell = true;          // creator cannot sell their minted copy
        inv[key].listPriceIC = price;     // remember creator list price
        // optional creator gun defaults so it “just works” with guns.js
        if (type==='weapon' && subtype==='gun'){
          if (typeof inv[key].ammo!=='number') inv[key].ammo = 60;
          if (typeof inv[key].fireIntervalMs!=='number' && ff.fireRate) inv[key].fireIntervalMs = 140; // faster if chosen
          if (typeof inv[key].bulletSpeedMul!=='number' && ff.tracerFx) inv[key].bulletSpeedMul = 1.1;
        }
        _invWrite(inv);

        try { if(typeof window.renderInventoryPanel==='function') window.renderInventoryPanel(); } catch{}
        try { window.dispatchEvent(new Event('izza-inventory-changed')); } catch {}

        // ---- optional: add to shop list (BUY tab) this session ----
        const sellInShop = !!input?.sellInShop;
        if (sellInShop){
          const list = document.getElementById('shopBuyList') || document.getElementById('shopList');
          const entry = { key, name, svg:inlineSvg, price, slot, type, part:input?.part };
          if (list && !list.querySelector(`[data-craft-item="${key}"]`)){
            _pendingCraftShopAdds.push(entry); // queue then flush immediately if shop open
            tryPatchShop();
          }else{
            _pendingCraftShopAdds.push(entry);
          }
        }

        return { ok:true, id:key };
      }catch(e){
        console.warn('[ArmourPacks.injectCraftedItem] failed', e);
        return { ok:false, reason:String(e) };
      }
    };
  })();

  // ---- Safe boot/wire-up ----
function __armourPacksBoot(){
  if (!window.IZZA || typeof IZZA.on!=='function') return false;

  IZZA.on('ready', a=>{ 
    api = a; 
    migrateArmorPackItems();       // fix existing saves at boot
    normalizeEquipSlots();
  });

  IZZA.on('render-post', tryPatchShop);
  IZZA.on('render-post', drawEquippedArmour);

  // Re-run migration whenever inventory changes (covers legacy items you buy/open later)
  window.addEventListener('izza-inventory-changed', ()=>{
    migrateArmorPackItems();
    normalizeEquipSlots();
  });

  // Keep equip state sane
  IZZA.on('update-post', normalizeEquipSlots);
  return true;
}
if (!__armourPacksBoot()){
  document.addEventListener('izza-core-ready', __armourPacksBoot, { once:true });
  let tries = 12;
  const t = setInterval(()=>{
    if (__armourPacksBoot()) clearInterval(t);
    if (--tries <= 0) clearInterval(t);
  }, 150);
}
