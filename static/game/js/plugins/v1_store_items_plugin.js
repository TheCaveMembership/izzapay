// v1_store_items_plugin.js — extend shop stock + icon repair + TABS + SELLBACK
(function(){
  const BUILD = 'v1-store-items+stock-extender+icon-fix-2+tabs-sell-v3';
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

  // --- Inventory helpers (compatible with your core / localStorage fallback) ---
  function getAPI(){ return window.IZZA && IZZA.api || null; }
  function readInv(){
    try{
      const a=getAPI();
      if(a?.getInventory) return JSON.parse(JSON.stringify(a.getInventory()||{}));
      const raw=localStorage.getItem('izzaInventory'); return raw? JSON.parse(raw):{};
    }catch{ return {}; }
  }
  function writeInv(inv){
    try{
      const a=getAPI();
      if(a?.setInventory) a.setInventory(inv);
      else localStorage.setItem('izzaInventory', JSON.stringify(inv));
      window.dispatchEvent(new Event('izza-inventory-changed'));
    }catch{}
  }
  function getCoins(){ try{ return getAPI()?.getCoins?.() ?? 0; }catch{ return 0; } }
  function setCoins(v){ try{ getAPI()?.setCoins?.(v|0); window.dispatchEvent(new Event('izza-coins-changed')); }catch{} }

  // =======================
  // UI UPGRADE: Tabs + Scroll + Sellback
  // =======================
  function injectOnceCSS(){
    if(document.getElementById('shopTabsCSS')) return;
    const css = document.createElement('style');
    css.id = 'shopTabsCSS';
    css.textContent = `
      /* Tabs */
      #shopModal .shop-tabs{ display:flex; gap:8px; margin:6px 0 10px; }
      #shopModal .shop-tabs .tab{
        background:#121a2a; color:#cfe0ff; border:1px solid #2a3550; border-radius:10px;
        padding:6px 10px; font-size:13px; cursor:pointer;
      }
      #shopModal .shop-tabs .tab.on{ background:#1e2a45; border-color:#516399; }

      /* Two panes */
      #shopModal .shop-panes{ position:relative; }
      #shopModal .pane{ display:none; }
      #shopModal .pane.on{ display:block; }

      /* Scrollable lists tuned for hundreds of items */
      #shopModal .pane-scroll{
        max-height: min(56vh, 520px);
        overflow:auto;
        padding-right:4px;
        scroll-behavior: smooth;
      }
      #shopModal .pane-scroll::-webkit-scrollbar{ width:10px; }
      #shopModal .pane-scroll::-webkit-scrollbar-thumb{ background:#293553; border-radius:10px; }
      #shopModal .pane-scroll::-webkit-scrollbar-track{ background:#0e1422; }

      /* Mall-meets-medieval vibe */
      #shopModal .card{
        background:
          radial-gradient(1000px 300px at 10% 0%, rgba(255,220,80,.08), transparent 60%),
          radial-gradient(800px 250px at 90% 0%, rgba(120,160,255,.06), transparent 60%),
          #121827;
        border-image: linear-gradient(180deg,#2a3550,#394b78) 1;
      }
      #shopModal .shop-item{
        backdrop-filter:saturate(1.1);
        transition: transform .08s ease, box-shadow .08s ease;
      }
      #shopModal .shop-item:hover{
        transform: translateY(-1px);
        box-shadow: 0 2px 0 rgba(0,0,0,.25), 0 0 0 1px rgba(120,160,255,.15) inset;
      }
    `;
    document.head.appendChild(css);
  }

  function ensureTabbedUI(){
    const modal = document.getElementById('shopModal'); if(!modal) return null;
    const card  = modal.querySelector('.card'); if(!card) return null;
    if(card.dataset.tabbed==='1') {
      // already built this open state
      return {
        buyList: document.getElementById('shopBuyList') || document.getElementById('shopList'),
        sellList: document.getElementById('shopSellList')
      };
    }

    injectOnceCSS();

    const title = card.querySelector('h3') || card.firstElementChild;
    const tabbar = document.createElement('div');
    tabbar.className='shop-tabs';
    tabbar.innerHTML = `
      <button class="tab on" data-tab="buy">Buy</button>
      <button class="tab" data-tab="sell">Sell</button>
    `;
    title.insertAdjacentElement('afterend', tabbar);

    // panes
    const panes = document.createElement('div');
    panes.className = 'shop-panes';
    panes.innerHTML = `
      <div id="shopBuyPane" class="pane on"><div id="shopBuyList" class="pane-scroll"></div></div>
      <div id="shopSellPane" class="pane"><div id="shopSellList" class="pane-scroll"></div></div>
    `;
    const note = card.querySelector('.shop-note') || card.querySelector('.row');
    card.insertBefore(panes, note);

    // move existing #shopList content into Buy pane (keep original buy handlers)
    const oldList = card.querySelector('#shopList');
    const buyList = document.getElementById('shopBuyList');
    if(oldList){
      Array.from(oldList.children).forEach(ch=> buyList.appendChild(ch));
      oldList.remove();
    }

    // tab switch
    tabbar.addEventListener('click', ev=>{
      const btn = ev.target && ev.target.closest('.tab'); if(!btn) return;
      const tab = btn.dataset.tab;
      tabbar.querySelectorAll('.tab').forEach(b=> b.classList.toggle('on', b===btn));
      document.getElementById('shopBuyPane').classList.toggle('on', tab==='buy');
      document.getElementById('shopSellPane').classList.toggle('on', tab==='sell');
    }, {passive:true});

    card.dataset.tabbed='1';
    return { buyList, sellList: document.getElementById('shopSellList') };
  }

  // Build a price map from Buy pane
  function scrapePriceMap(){
    const map = {};
    const card = document.getElementById('shopModal')?.querySelector('.card'); if(!card) return map;
    const scope = document.getElementById('shopBuyList') || card;
    scope.querySelectorAll('.shop-item button.buy').forEach(btn=>{
      const price = parseInt((btn.textContent||'').replace(/[^\d]/g,''),10) || 0;
      const row   = btn.closest('.shop-item');
      const key   = btn.getAttribute('data-buy') || row?.getAttribute('data-key') || null;
      if(!key || !price) return;
      map[key] = price;
    });
    return map;
  }

  function collectSellables(inv, priceMap){
    const out = [];
    Object.keys(inv||{}).forEach(k=>{
      const e = inv[k]; if(!e) return;
      // ignore wallet-like keys
      if(/^coins?$|^money$|^wallet$|^bank$/i.test(k)) return;
      const count = (typeof e.count==='number') ? e.count : (e.owned===true ? 1 : 0);
      if(count<=0) return;
      const basePrice = (typeof e.purchasePrice==='number' && e.purchasePrice>0) ? e.purchasePrice : (priceMap[k]||0);
      if(basePrice<=0) return;
      const sellPrice = Math.max(1, Math.floor(basePrice * 0.4));
      out.push({ key:k, name:(e.name||k), count, sellPrice, equipped: !!(e.equipped||e.equip) });
    });
    out.sort((a,b)=> (a.equipped===b.equipped? a.name.localeCompare(b.name) : (a.equipped?1:-1)));
    return out;
  }

  function buildSellPane(){
    const { sellList } = ensureTabbedUI() || {};
    if(!sellList) return;
    sellList.innerHTML = '';
    const inv = readInv();
    const priceMap = scrapePriceMap();
    const items = collectSellables(inv, priceMap);
    items.forEach(it=>{
      const row = document.createElement('div');
      row.className='shop-item';
      row.setAttribute('data-sell-row', it.key);
      row.innerHTML = `
        <div class="meta">
          <div class="name">${it.name}${it.equipped? ' <span style="opacity:.7">(equipped)</span>':''}</div>
          <div class="sub">Qty: ${it.count} • Sell for ${it.sellPrice} IC</div>
        </div>
        <button class="buy" data-sell="${it.key}" ${it.equipped?'disabled':''}>+ ${it.sellPrice} IC</button>
      `;
      sellList.appendChild(row);
    });
  }

  // Decrement one unit from an inventory entry (stacked or owned)
  function decOne(inv, key){
    const e = inv[key]; if(!e) return;
    if(typeof e.count==='number'){ e.count = Math.max(0, e.count-1); }
    else if(e.owned){ e.owned = false; }
    if(e.count===0 || e.owned===false){
      e.equipped = false; e.equip = false; e.equippedCount = 0;
    }
  }

  // =======================
  // Original: Append an item row to #shopList (kept) — now tags row/button with key for sellback
  // =======================
  function addShopRow(list, it){
    // If the tabs were built, ensure we add into Buy list instead
    const buyList = document.getElementById('shopBuyList');
    if(buyList) list = buyList;

    const row = document.createElement('div');
    row.className='shop-item';
    row.setAttribute('data-store-ext','1');
    if(it.id) row.setAttribute('data-key', it.id); // NEW: key for sellback mapping

    // (UNCHANGED) inline SVGs
    function svgIcon(id, w=24, h=24){
      if(id==='bat')      return `<svg viewBox="0 0 64 64" width="${w}" height="${h}"><rect x="22" y="8" width="8" height="40" fill="#8b5a2b"/><rect x="20" y="48" width="12" height="8" fill="#6f4320"/></svg>`;
      if(id==='knuckles') return `<svg viewBox="0 0 64 64" width="${w}" height="${h}"><circle cx="20" cy="28" r="6" stroke="#cfcfcf" fill="none" stroke-width="4"/><circle cx="32" cy="28" r="6" stroke="#cfcfcf" fill="none" stroke-width="4"/><circle cx="44" cy="28" r="6" stroke="#cfcfcf" fill="none" stroke-width="4"/><rect x="16" y="34" width="32" height="8" fill="#cfcfcf"/></svg>`;
      if(id==='pistol')   return `<svg viewBox="0 0 64 64" width="${w}" height="${h}"><rect x="14" y="26" width="30" height="8" fill="#202833"/><rect x="22" y="34" width="8" height="12" fill="#444c5a"/></svg>`;
      if(id==='uzi')      return `<svg viewBox="0 0 64 64" width="${w}" height="${h}"><rect x="12" y="28" width="34" height="8" fill="#0b0e14"/><rect x="36" y="22" width="12" height="6" fill="#0b0e14"/><rect x="30" y="36" width="6" height="12" fill="#0b0e14"/><rect x="18" y="36" width="6" height="10" fill="#0b0e14"/></svg>`;
      if(id==='grenade')  return `<svg viewBox="0 0 64 64" width="${w}" height="${h}"><rect x="28" y="22" width="8" height="5" fill="#5b7d61"/><rect x="31" y="19" width="2" height="2" fill="#c3c9cc"/><rect x="26" y="27" width="12" height="14" fill="#264a2b"/></svg>`;
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
          ${it.sub? `<div class="sub" style="opacity:.85">${it.sub}</div>`:''}
        </div>
      </div>`;

    const btn = document.createElement('button');
    btn.className='buy';
    btn.textContent = `${it.price} IC`; // price pill
    if(it.id) btn.setAttribute('data-buy', it.id); // NEW: tag for sellback mapping
    btn.addEventListener('click', ()=>{
      const coins = api.getCoins ? api.getCoins() : (api.player?.coins|0);
      if(coins < it.price){ alert('Not enough coins'); return; }
      api.setCoins(coins - it.price);

      const inv = api.getInventory ? api.getInventory() : {};
      if(it.id==='uzi'){
        const cur = inv.uzi || { owned:true, ammo:0, equipped:false };
        cur.owned = true; cur.ammo = (cur.ammo|0) + 50;
        cur.purchasePrice = it.price; // remember last paid price for sellback
        inv.uzi = cur;
        api.setInventory && api.setInventory(inv);
        IZZA.emit?.('toast', {text:'Purchased Uzi (+50 ammo)'});
      }else if(it.id==='grenade'){
        const cur = inv.grenade || { count:0 };
        cur.count = (cur.count|0) + 1;
        cur.purchasePrice = it.price;
        inv.grenade = cur;
        api.setInventory && api.setInventory(inv);
        IZZA.emit?.('toast', {text:'Purchased Grenade'});
      }else if(it.id==='pistol_ammo'){
        const cur = inv.pistol || { owned:true, ammo:0, equipped:false };
        cur.owned = true; cur.ammo = (cur.ammo|0) + 17;
        // ammo typically not sellable; keep price for reference anyway
        cur.purchasePrice = it.price;
        inv.pistol = cur;
        api.setInventory && api.setInventory(inv);
        IZZA.emit?.('toast', {text:'Purchased Pistol Ammo (+17)'});
      }

      try{
        const host = document.getElementById('invPanel');
        if(host && host.style.display!=='none' && typeof window.renderInventoryPanel==='function'){
          window.renderInventoryPanel();
        }
      }catch{}

      // keep Sell tab in sync after buying
      setTimeout(buildSellPane, 0);
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

      const list = document.getElementById('shopBuyList') || document.getElementById('shopList');
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

  // Build Sell-button delegation (one-time)
  let sellDelegated = false;
  function armSellDelegation(){
    if(sellDelegated) return;
    const modal = document.getElementById('shopModal'); if(!modal) return;
    modal.addEventListener('click', function(ev){
      const btn = ev.target && ev.target.closest('button.buy[data-sell]');
      if(!btn) return;
      ev.preventDefault(); ev.stopPropagation();
      const key = btn.getAttribute('data-sell');
      const inv = readInv();
      const equipped = !!(inv[key]?.equipped || inv[key]?.equip);
      if(equipped){ if(window.IZZA?.toast) IZZA.toast('Unequip first'); return; }

      const sellPrice = parseInt((btn.textContent||'').replace(/[^\d]/g,''),10) || 0;
      if(sellPrice<=0) return;

      setCoins((getCoins()|0) + sellPrice);
      decOne(inv, key);
      writeInv(inv);

      // refresh sell pane
      buildSellPane();
      if(window.IZZA?.toast) IZZA.toast(`Sold ${key} for ${sellPrice} IC`);
    }, true);

    // keep Sell pane synced with external inventory changes (e.g., other plugins)
    window.addEventListener('izza-inventory-changed', ()=>{
      const modal = document.getElementById('shopModal');
      if(!modal) return;
      const open = (modal.style.display === 'flex') || (getComputedStyle(modal).display === 'flex');
      if(open) buildSellPane();
    });

    sellDelegated = true;
  }

  // =======================
  // Main patcher (runs when modal visible)
  // =======================
  function patchShopStock(){
    try{
      if(!api) return;

      const modal = document.getElementById('shopModal');
      if(!modal) return;

      const open = (modal.style.display === 'flex') || (getComputedStyle(modal).display === 'flex');
      if(!open) return;

      // Build/ensure enhanced UI
      const panes = ensureTabbedUI();

      // Choose correct list to append rows into
      const list = document.getElementById('shopBuyList') || document.getElementById('shopList');
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

      // Build the Sell pane now that prices are known
      buildSellPane();
      armSellDelegation();
    }catch(e){
      console.warn('[store extender] patch failed:', e);
    }
  }

  IZZA.on('ready', a=>{ api=a; });
  IZZA.on('render-post', patchShopStock);
})();
