// v1_store_items_plugin.js — extend shop stock + icon repair (bat/knuckles) + armour add + pistol icon fix
(function(){
  const BUILD = 'v1-store-items+stock-extender+icon-fix-3+armor-generic+inv-icons';
  console.log('[IZZA PLAY]', BUILD);

  let api = null;

  // --- tiny helpers to produce data-URL images for SVGs (avoids inline-SVG stripping) ---
  function svgToDataURL(svg){
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
  }
  function iconImgHTML(svg, w=24, h=24){
    const src = svgToDataURL(svg);
    return `<img src="${src}" width="${w}" height="${h}" alt="" decoding="async" style="image-rendering:pixelated;display:block">`;
  }
  function svgBat(w=24,h=24){
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${w}" height="${h}">
      <rect x="22" y="8" width="8" height="40" fill="#8b5a2b"/>
      <rect x="20" y="48" width="12" height="8" fill="#6f4320"/>
    </svg>`;
  }
  function svgKnuckles(w=24,h=24){
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${w}" height="${h}">
      <circle cx="20" cy="28" r="6" stroke="#cfcfcf" fill="none" stroke-width="4"/>
      <circle cx="32" cy="28" r="6" stroke="#cfcfcf" fill="none" stroke-width="4"/>
      <circle cx="44" cy="28" r="6" stroke="#cfcfcf" fill="none" stroke-width="4"/>
      <rect x="16" y="34" width="32" height="8" fill="#cfcfcf"/>
    </svg>`;
  }

  // (UNCHANGED) inline SVGs used for shop icons and as fallbacks for inventory icons
  function svgIcon(id, w=24, h=24){
    if(id==='bat')      return `<svg viewBox="0 0 64 64" width="${w}" height="${h}"><rect x="22" y="8" width="8" height="40" fill="#8b5a2b"/><rect x="20" y="48" width="12" height="8" fill="#6f4320"/></svg>`;
    if(id==='knuckles') return `<svg viewBox="0 0 64 64" width="${w}" height="${h}"><circle cx="20" cy="28" r="6" stroke="#cfcfcf" fill="none" stroke-width="4"/><circle cx="32" cy="28" r="6" stroke="#cfcfcf" fill="none" stroke-width="4"/><circle cx="44" cy="28" r="6" stroke="#cfcfcf" fill="none" stroke-width="4"/><rect x="16" y="34" width="32" height="8" fill="#cfcfcf"/></svg>`;
    if(id==='pistol')   return `<svg viewBox="0 0 64 64" width="${w}" height="${h}"><rect x="14" y="26" width="30" height="8" fill="#202833"/><rect x="22" y="34" width="8" height="12" fill="#444c5a"/></svg>`;
    if(id==='uzi')      return `<svg viewBox="0 0 64 64" width="${w}" height="${h}"><rect x="12" y="28" width="34" height="8" fill="#0b0e14"/><rect x="36" y="22" width="12" height="6" fill="#0b0e14"/><rect x="30" y="36" width="6" height="12" fill="#0b0e14"/><rect x="18" y="36" width="6" height="10" fill="#0b0e14"/></svg>`;
    if(id==='grenade')  return `<svg viewBox="0 0 64 64" width="${w}" height="${h}"><rect x="28" y="22" width="8" height="5" fill="#5b7d61"/><rect x="31" y="19" width="2" height="2" fill="#c3c9cc"/><rect x="26" y="27" width="12" height="14" fill="#264a2b"/></svg>`;
    if(id==='pistol_ammo') return `<svg viewBox="0 0 64 64" width="${w}" height="${h}"><rect x="28" y="18" width="8" height="28" fill="#c9a24c"/><rect x="28" y="44" width="8" height="6" fill="#6f5a1d"/></svg>`;
    return '';
  }

  // Append an item row to the existing #shopList (keeps the same visual style)
  function addShopRow(list, it){
    const row = document.createElement('div');
    row.className='shop-item';
    row.setAttribute('data-store-ext','1');

    const meta = document.createElement('div');
    meta.className='meta';
    meta.innerHTML = `
      <div style="display:flex; align-items:center; gap:8px">
        <div>${svgIcon(it.id)}</div>
        <div>
          <div class="name">${it.name}</div>
          ${it.sub? `<div class="sub" style="opacity:.85">${it.sub}</div>`:''}
        </div>
      </div>`;

    const btn = document.createElement('button');
    btn.className='buy';
    btn.textContent = `${it.price} IC`; // price pill
    btn.addEventListener('click', ()=>{
      const coins = api.getCoins ? api.getCoins() : (api.player?.coins|0);
      if(coins < it.price){ alert('Not enough coins'); return; }
      api.setCoins(coins - it.price);

      const inv = api.getInventory ? api.getInventory() : {};

      // --- Known items (unchanged) ---
      if(it.id==='uzi'){
        const cur = inv.uzi || { owned:true, ammo:0, equipped:false };
        cur.owned = true; cur.ammo = (cur.ammo|0) + 50;
        // ensure metadata for inventory icon
        cur.name = cur.name || 'Uzi';
        cur.iconSvg = cur.iconSvg || svgToDataURL(svgIcon('uzi', 24,24));
        inv.uzi = cur;
        api.setInventory && api.setInventory(inv);
        IZZA.emit?.('toast', {text:'Purchased Uzi (+50 ammo)'});
      }else if(it.id==='grenade'){
        const cur = inv.grenade || { count:0 };
        cur.count = (cur.count|0) + 1;
        cur.name = cur.name || 'Grenade';
        cur.iconSvg = cur.iconSvg || svgToDataURL(svgIcon('grenade',24,24));
        inv.grenade = cur;
        api.setInventory && api.setInventory(inv);
        IZZA.emit?.('toast', {text:'Purchased Grenade'});
      }else if(it.id==='pistol_ammo'){
        // ammo goes into the pistol entry; ensure pistol meta so it renders with an icon
        const cur = inv.pistol || { owned:true, ammo:0, equipped:false };
        cur.owned = true; cur.ammo = (cur.ammo|0) + 17;
        // FIX: make sure pistol has a visible icon/name in inventory
        cur.name = cur.name || 'Pistol';
        cur.iconSvg = cur.iconSvg || svgToDataURL(svgIcon('pistol',24,24));
        inv.pistol = cur;
        api.setInventory && api.setInventory(inv);
        IZZA.emit?.('toast', {text:'Purchased Pistol Ammo (+17)'});
      } else {
        // --- Generic purchase (NEW) ---
        // Support armour and any other shop-injected item.
        // Accepts:
        //  - it.type === 'armor' (preferred, from your armour plugin)
        //  - or id like "armor:setName:piece" (helmet|vest|arms|legs)
        //  - or falls back to stackable {count}
        const key = it.invKey || it.id;
        const pretty = it.name || key;

        // helper: write an armour piece entry
        function addArmorPiece(slotGuess){
          const slot = (it.slot || slotGuess || '').toLowerCase();
          const valid = new Set(['helmet','vest','arms','legs']);
          const resolvedSlot = valid.has(slot) ? slot :
            (/helmet|head/i.test(pretty)?'helmet' :
             /vest|chest|body/i.test(pretty)?'vest' :
             /arms|glove|gaunt/i.test(pretty)?'arms' :
             /legs|greave|boot/i.test(pretty)?'legs' : 'vest');

          const entry = inv[key] || { count:0 };
          entry.count = (entry.count|0) + 1;
          entry.name  = pretty;
          entry.type  = 'armor';
          entry.slot  = resolvedSlot;
          entry.equippable = true;
          // Prefer iconSvg provided by the armour plugin; else use the shop icon as fallback
          if (!entry.iconSvg){
            entry.iconSvg = it.iconSvg || svgToDataURL(svgIcon(it.id,24,24));
          }
          inv[key] = entry;
          api.setInventory && api.setInventory(inv);
          IZZA.emit?.('toast', {text:`Purchased ${pretty}`});
        }

        // Try to detect armour shape
        let handled = false;
        if (it && (it.type === 'armor' || it.slot)) {
          addArmorPiece(it.slot||'');
          handled = true;
        } else if (typeof key === 'string' && key.startsWith('armor:')){
          // parse armor:set:piece
          const parts = key.split(':'); // ['armor','set','piece']
          const piece = parts[2]||'';
          addArmorPiece(piece);
          handled = true;
        }

        if (!handled){
          // default: stackable (keeps legacy behavior for misc items)
          const e = inv[key] || { count:0, name:pretty };
          e.count = (e.count|0) + 1;
          e.name = e.name || pretty;
          inv[key] = e;
          api.setInventory && api.setInventory(inv);
          IZZA.emit?.('toast', {text:`Purchased ${pretty}`});
        }
      }

      try{
        const host = document.getElementById('invPanel');
        if(host && host.style.display!=='none' && typeof window.renderInventoryPanel==='function'){
          window.renderInventoryPanel();
        }
      }catch{}
      try { window.dispatchEvent(new Event('izza-inventory-changed')); } catch {}
    });

    row.appendChild(meta);
    row.appendChild(btn);
    list.appendChild(row);
  }

  // --- Repair icons & missing names for core-provided rows (NO SVG LOGIC CHANGED) ---
  function repairMissingIcons(){
    try{
      const modal = document.getElementById('shopModal');
      if(!modal) return;
      const open = (modal.style.display === 'flex') || (getComputedStyle(modal).display === 'flex');
      if(!open) return;

      const list = document.getElementById('shopList');
      if(!list) return;

      list.querySelectorAll('.shop-item .meta').forEach(meta=>{
        const iconHolder = meta.querySelector(':scope > div:first-child');
        const nameEl     = meta.querySelector('.name');
        if(!iconHolder || !nameEl) return;

        const currentName = (nameEl.textContent||'').trim();
        let name = currentName.toLowerCase();
        let isBat = /\bbaseball\s*bat\b/i.test(name) || /\bbat\b/i.test(name);
        let isKnuckles = /\bbrass\s*knuckles\b/i.test(name) || /\bknuckles\b/i.test(name);

        // If name is empty, infer from icon markup (non-invasive; still not touching the SVGs)
        if(!isBat && !isKnuckles && !currentName){
          const html = (iconHolder.innerHTML||'').toLowerCase();
          if(html.includes('#8b5a2b') || html.includes('#6f4320')) isBat = true;            // bat colors
          else if(html.includes('#cfcfcf') && html.includes('<circle')) isKnuckles = true;  // knuckles look
        }

        if(isBat){
          const html = (iconHolder.innerHTML||'').trim();
          if(!html || html.includes('⭐') || (!html.includes('<svg') && !html.includes('<img'))){
            iconHolder.innerHTML = iconImgHTML(svgBat());
          }
          if(!currentName) nameEl.textContent = 'Baseball Bat';
        }else if(isKnuckles){
          const html = (iconHolder.innerHTML||'').trim();
          if(!html || html.includes('⭐') || (!html.includes('<svg') && !html.includes('<img'))){
            iconHolder.innerHTML = iconImgHTML(svgKnuckles());
          }
          if(!currentName) nameEl.textContent = 'Brass Knuckles';
        }
      });
    }catch(e){
      console.warn('[store extender] icon repair failed:', e);
    }
  }

  function patchShopStock(){
    try{
      if(!api) return;

      const modal = document.getElementById('shopModal');
      if(!modal) return;

      const open = (modal.style.display === 'flex') ||
                   (getComputedStyle(modal).display === 'flex');
      if(!open) return;

      const list = document.getElementById('shopList');
      if(!list) return;

      // Extend stock (only once per open)
      if(!list.querySelector('[data-store-ext]')){
        const missions = (api.getMissionCount && api.getMissionCount()) || 0;
        if(missions >= 3){
          // NOTE: removed the "Unlocked at mission 3" subtitle for Uzi (per request)
          addShopRow(list, { id:'uzi',          name:'Uzi (w/ +50 ammo)',       price:350, sub:'Compact SMG. +50 ammo.' });
          addShopRow(list, { id:'pistol_ammo',  name:'Pistol Ammo (17 rounds)', price:60,  sub:'Magazine refuel for pistol.' });
          addShopRow(list, { id:'grenade',      name:'Grenade',                 price:120, sub:'Area blast. One-time use.' });
        }
      }

      // Repair icons & add missing names for core rows
      repairMissingIcons();
    }catch(e){
      console.warn('[store extender] patch failed:', e);
    }
  }

  IZZA.on('ready', a=>{ api=a; });
  IZZA.on('render-post', patchShopStock);
})();
