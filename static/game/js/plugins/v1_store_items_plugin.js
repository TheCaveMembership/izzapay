// v1_store_items_plugin.js — extend shop stock without touching core openShop()
// + resilient icon fix for Bat & Brass Knuckles when core falls back to ⭐️
(function(){
  const BUILD = 'v1-store-items+stock-extender+icon-patch';
  console.log('[IZZA PLAY]', BUILD);

  let api=null;

  // Append an item row to the existing #shopList (keeps the same visual style)
  function addShopRow(list, it){
    const row = document.createElement('div');
    row.className='shop-item';
    row.setAttribute('data-store-ext','1'); // marker so we don’t duplicate on re-open

    // icon: your inline SVGs (unchanged from the working original)
    function svgIcon(id, w=24, h=24){
      if(id==='bat')         return `<svg viewBox="0 0 64 64" width="${w}" height="${h}"><rect x="22" y="8" width="8" height="40" fill="#8b5a2b"/><rect x="20" y="48" width="12" height="8" fill="#6f4320"/></svg>`;
      if(id==='knuckles')    return `<svg viewBox="0 0 64 64" width="${w}" height="${h}"><circle cx="20" cy="28" r="6" stroke="#cfcfcf" fill="none" stroke-width="4"/><circle cx="32" cy="28" r="6" stroke="#cfcfcf" fill="none" stroke-width="4"/><circle cx="44" cy="28" r="6" stroke="#cfcfcf" fill="none" stroke-width="4"/><rect x="16" y="34" width="32" height="8" fill="#cfcfcf"/></svg>`;
      if(id==='pistol')      return `<svg viewBox="0 0 64 64" width="${w}" height="${h}"><rect x="14" y="26" width="30" height="8" fill="#202833"/><rect x="22" y="34" width="8" height="12" fill="#444c5a"/></svg>`;
      if(id==='uzi')         return `<svg viewBox="0 0 64 64" width="${w}" height="${h}"><rect x="12" y="28" width="34" height="8" fill="#0b0e14"/><rect x="36" y="22" width="12" height="6" fill="#0b0e14"/><rect x="30" y="36" width="6" height="12" fill="#0b0e14"/><rect x="18" y="36" width="6" height="10" fill="#0b0e14"/></svg>`;
      if(id==='grenade')     return `<svg viewBox="0 0 64 64" width="${w}" height="${h}"><rect x="28" y="22" width="8" height="5" fill="#5b7d61"/><rect x="31" y="19" width="2" height="2" fill="#c3c9cc"/><rect x="26" y="27" width="12" height="14" fill="#264a2b"/></svg>`;
      if(id==='pistol_ammo') return `<svg viewBox="0 0 64 64" width="${w}" height="${h}"><rect x="28" y="18" width="8" height="28" fill="#c9a24c"/><rect x="28" y="44" width="8" height="6" fill="#6f5a1d"/></svg>`;
      return '';
    }

    const meta = document.createElement('div');
    meta.className='meta';
    meta.innerHTML = `
      <div style="display:flex; align-items:center; gap:8px">
        <div>${svgIcon(it.id)}</div>
        <div>
          <div class="name">${it.name}</div>
          <div class="sub">${it.price} IC</div>
          ${it.sub? `<div class="sub" style="opacity:.85">${it.sub}</div>`:''}
        </div>
      </div>`;

    const btn = document.createElement('button');
    btn.className='buy';
    btn.textContent='Buy';
    btn.addEventListener('click', ()=>{
      const coins = api.getCoins ? api.getCoins() : (api.player?.coins|0);
      if(coins < it.price){ alert('Not enough coins'); return; }
      api.setCoins(coins - it.price);

      // mutate inventory using your core helpers
      const inv = api.getInventory ? api.getInventory() : {};
      if(it.id==='uzi'){
        const cur = inv.uzi || { owned:true, ammo:0, equipped:false };
        cur.owned = true; cur.ammo = (cur.ammo|0) + 50;
        inv.uzi = cur;
        api.setInventory && api.setInventory(inv);
        IZZA.emit?.('toast', {text:'Purchased Uzi (+50 ammo)'}); // non-blocking
      }else if(it.id==='grenade'){
        const cur = inv.grenade || { count:0 };
        cur.count = (cur.count|0) + 1;
        inv.grenade = cur;
        api.setInventory && api.setInventory(inv);
        IZZA.emit?.('toast', {text:'Purchased Grenade'});
      }else if(it.id==='pistol_ammo'){
        const cur = inv.pistol || { owned:true, ammo:0, equipped:false };
        cur.owned = true; cur.ammo = (cur.ammo|0) + 17;
        inv.pistol = cur;
        api.setInventory && api.setInventory(inv);
        IZZA.emit?.('toast', {text:'Purchased Pistol Ammo (+17)'});
      }

      // live-refresh inventory panel if it’s open
      try{
        const host = document.getElementById('invPanel');
        if(host && host.style.display!=='none' && typeof window.renderInventoryPanel==='function'){
          window.renderInventoryPanel();
        }
      }catch{}
    });

    row.appendChild(meta);
    row.appendChild(btn);
    list.appendChild(row);
  }

  // --- Robustly replace core's ⭐️ fallback with your SVGs for Bat/Knuckles ---
  function fixCoreItemIcons(){
    const list = document.getElementById('shopList');
    if(!list) return;

    // Only touch rows rendered by core (no data-store-ext marker)
    const rows = list.querySelectorAll('.shop-item:not([data-store-ext]):not([data-icon-fixed])');
    rows.forEach(row=>{
      try{
        const nameEl = row.querySelector('.meta .name');
        if(!nameEl) return;
        const label = (nameEl.textContent || '').trim().toLowerCase();

        // map visible names
        let svg = '';
        if(label === 'brass knuckles' || label === 'knuckles'){
          svg = `<svg viewBox="0 0 64 64" width="24" height="24"><circle cx="20" cy="28" r="6" stroke="#cfcfcf" fill="none" stroke-width="4"/><circle cx="32" cy="28" r="6" stroke="#cfcfcf" fill="none" stroke-width="4"/><circle cx="44" cy="28" r="6" stroke="#cfcfcf" fill="none" stroke-width="4"/><rect x="16" y="34" width="32" height="8" fill="#cfcfcf"/></svg>`;
        }else if(label === 'bat' || label === 'baseball bat'){
          svg = `<svg viewBox="0 0 64 64" width="24" height="24"><rect x="22" y="8" width="8" height="40" fill="#8b5a2b"/><rect x="20" y="48" width="12" height="8" fill="#6f4320"/></svg>`;
        }else{
          return; // not one we need to fix
        }

        // find the flex container inside .meta (where core put emoji + text)
        const meta = row.querySelector('.meta');
        const flex = meta && meta.firstElementChild; // the <div style="display:flex;…">
        if(!flex) return;

        // If first child looks like an emoji-only node, remove it.
        // (covers either a text node or an element that only contains short emoji text)
        const first = flex.firstChild;
        if(first){
          if(first.nodeType === 3){ // text node
            const t = first.textContent.trim();
            if(t.length <= 3) flex.removeChild(first);
          }else if(first.nodeType === 1){ // element
            const txt = first.textContent && first.textContent.trim();
            if(txt && txt.length <= 3) flex.removeChild(first);
          }
        }

        // Insert our icon as the first element
        const iconWrap = document.createElement('div');
        iconWrap.innerHTML = svg;
        flex.insertBefore(iconWrap, flex.firstChild);

        row.setAttribute('data-icon-fixed','1'); // idempotent on future frames
      }catch(_){}
    });
  }

  function patchShopStock(){
    const modal = document.getElementById('shopModal');
    if(!modal) return;

    // Only run when open; use computed style too (some cores toggle classes)
    const open = (modal.style.display === 'flex') ||
                 (getComputedStyle(modal).display === 'flex');
    if(!open) return;

    // Always fix core icons for this open
    fixCoreItemIcons();

    const list = document.getElementById('shopList');
    if(!list || list.querySelector('[data-store-ext]')) return; // already extended this open

    // Gate extra stock by missions (same as your original)
    const missions = (api.getMissionCount && api.getMissionCount()) || 0;
    if(missions >= 3){
      addShopRow(list, { id:'uzi',          name:'Uzi (w/ +50 ammo)',     price:350, sub:'Unlocked at mission 3' });
      addShopRow(list, { id:'pistol_ammo',  name:'Pistol Ammo (full mag)', price:60 });
      addShopRow(list, { id:'grenade',      name:'Grenade',                price:120 });
    }
  }

  IZZA.on('ready', a=>{ api=a; });
  // When the shop opens (core sets display='flex'), we detect & append rows.
  // We also re-run icon fix on every render-post while open (cheap & safe).
  IZZA.on('render-post', patchShopStock);
})();
