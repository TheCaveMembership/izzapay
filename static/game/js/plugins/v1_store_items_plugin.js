// v1_store_items_plugin.js — extend shop stock + icon repair + BUY/SELL tabs + inventory pricebook + search
(function(){
  const BUILD = 'v1-store-items+stock-extender+icon-fix-5+buy-sell+pricebook+search';
  console.log('[IZZA PLAY]', BUILD);

  let api = null;

  // ---------- helpers ----------
  const PRICE_BOOK_KEY = 'izzaPriceBook';   // { invKey: { lastPaid:number, name:string } }
  function readPriceBook(){
    try{ return JSON.parse(localStorage.getItem(PRICE_BOOK_KEY)||'{}'); }catch{ return {}; }
  }
  function writePriceBook(pb){ try{ localStorage.setItem(PRICE_BOOK_KEY, JSON.stringify(pb||{})); }catch{} }

  function svgToDataURL(svg){ return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg); }
  function iconImgHTML(svg, w=24, h=24){
    const src = svgToDataURL(svg);
    return `<img src="${src}" width="${w}" height="${h}" alt="" decoding="async" style="image-rendering:pixelated;display:block">`;
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

  // ---------- BUY/SELL TABS + SEARCH (non-invasive; wraps existing #shopList) ----------
  let tabsWired = false;
  let currentFilter = ''; // search text

  function ensureTabs(){
    const modal = document.getElementById('shopModal');
    if(!modal) return;
    const host  = modal.querySelector('#shopList');
    if(!host || host.dataset.tabs==='1') return;

    const card = modal.querySelector('.card');
    if(!card) return;

    if(!document.getElementById('shop-tabs-css')){
      const css = document.createElement('style');
      css.id = 'shop-tabs-css';
      css.textContent = `
      #shopTabs{display:flex;gap:6px;margin:0 0 8px;align-items:center}
      #shopTabs .tab{flex:0 0 auto;padding:6px 10px;border-radius:10px;border:1px solid #2a3550;background:#162134;color:#cfe0ff;font-weight:700;cursor:pointer}
      #shopTabs .tab.on{background:#1f6feb;border-color:#2f6feb;color:#fff}
      #shopSearch{flex:1 1 auto;margin-left:auto}
      #shopSearch input{width:100%;padding:6px 10px;border-radius:10px;border:1px solid #2a3550;background:#0e1728;color:#cfe0ff;font-weight:700}
      .shop-scroll{max-height:min(60vh,520px);overflow:auto;display:flex;flex-direction:column;gap:8px;padding-right:4px}
      .shop-item{ display:flex; align-items:center; justify-content:space-between; gap:10px; padding:10px; background:#0f1522; border:1px solid #2a3550; border-radius:10px; }
      .shop-item .buy, .shop-item .sell { background:#1f2a3f; color:#cfe0ff; border:1px solid #2a3550; border-radius:8px; padding:6px 10px; cursor:pointer }
      .shop-note{opacity:.8;font-size:12px;margin-top:6px}
      `;
      document.head.appendChild(css);
    }

    // tabs + search
    const tabs = document.createElement('div');
    tabs.id='shopTabs';
    tabs.innerHTML = `
      <button class="tab on" data-tab="buy">Buy</button>
      <button class="tab" data-tab="sell">Sell</button>
      <div id="shopSearch" title="Search items">
        <input type="text" id="shopSearchInput" placeholder="Search shop & inventory...">
      </div>`;

    // lists
    const buyList = document.createElement('div');
    buyList.id = 'shopBuyList';
    buyList.className = 'shop-list shop-scroll';

    const sellList = document.createElement('div');
    sellList.id = 'shopSellList';
    sellList.className = 'shop-list shop-scroll';
    sellList.style.display='none';

    // move existing children to buyList
    while(host.firstChild) buyList.appendChild(host.firstChild);
    host.dataset.tabs='1';
    host.replaceChildren(); // clear original

    // slot in our UI
    card.insertBefore(tabs, card.children[1] || card.firstChild);
    card.insertBefore(buyList, tabs.nextSibling);
    card.insertBefore(sellList, buyList.nextSibling);

    // wire tab switches
    if(!tabsWired){
      tabsWired = true;
      card.addEventListener('click', (ev)=>{
        const b=ev.target && ev.target.closest('#shopTabs .tab');
        if(!b) return;
        const mode=b.getAttribute('data-tab');
        card.querySelectorAll('#shopTabs .tab').forEach(t=>t.classList.toggle('on', t===b));
        buyList.style.display = (mode==='buy')?'':'none';
        sellList.style.display = (mode==='sell')?'':'none';
        if(mode==='sell') renderSellList(); else filterBuyList();
      }, true);

      // search (debounced)
      const input = tabs.querySelector('#shopSearchInput');
      let tm=null;
      input.addEventListener('input', ()=>{
        currentFilter = (input.value||'').trim().toLowerCase();
        clearTimeout(tm);
        tm = setTimeout(()=>{
          const sellVisible = sellList.style.display !== 'none';
          if(sellVisible) renderSellList(); else filterBuyList();
        }, 90);
      });
    }
  }

  // Filter BUY list by currentFilter (text in name/sub)
  function filterBuyList(){
    const list = document.getElementById('shopBuyList');
    if(!list) return;
    const q = currentFilter;
    if(!q){
      Array.from(list.children).forEach(ch=> ch.style.display='');
      return;
    }
    Array.from(list.children).forEach(ch=>{
      if(!ch.classList || !ch.classList.contains('shop-item')) return;
      const meta = ch.querySelector('.meta');
      const t = (meta?.textContent||'').toLowerCase();
      ch.style.display = t.includes(q) ? '' : 'none';
    });
  }

  // ---------- BUY rows (keeps your existing behavior) ----------
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
    btn.textContent = `${it.price} IC`;
    btn.addEventListener('click', ()=>buyItem(it));

    row.appendChild(meta);
    row.appendChild(btn);
    list.appendChild(row);
  }

  function buyItem(it){
    const coins = api.getCoins ? api.getCoins() : (api.player?.coins|0);
    if(coins < it.price){ alert('Not enough coins'); return; }
    api.setCoins(coins - it.price);

    const inv = api.getInventory ? api.getInventory() : {};
    const pb  = readPriceBook();

    // Known items
    if(it.id==='uzi'){
      const cur = inv.uzi || { owned:true, ammo:0, equipped:false };
      cur.owned = true; cur.ammo = (cur.ammo|0) + 50;
      cur.name='Uzi'; cur.iconSvg = cur.iconSvg || svgToDataURL(svgIcon('uzi',24,24));
      inv.uzi = cur;
      IZZA.emit?.('toast', {text:'Purchased Uzi (+50 ammo)'});
      pb['uzi'] = { lastPaid: it.price, name:'Uzi' };

    }else if(it.id==='grenade'){
      const cur = inv.grenade || { count:0, name:'Grenade' };
      cur.count = (cur.count|0) + 1;
      cur.iconSvg = cur.iconSvg || svgToDataURL(svgIcon('grenade',24,24));
      inv.grenade = cur;
      IZZA.emit?.('toast', {text:'Purchased Grenade'});
      pb['grenade'] = { lastPaid: it.price, name:'Grenade' };

    }else if(it.id==='pistol_ammo'){
      // ensure pistol renders with icon/name
      const cur = inv.pistol || { owned:true, ammo:0, equipped:false };
      cur.owned = true; cur.ammo = (cur.ammo|0) + 17;
      cur.name = cur.name || 'Pistol';
      cur.iconSvg = cur.iconSvg || svgToDataURL(svgIcon('pistol',24,24));
      inv.pistol = cur;
      IZZA.emit?.('toast', {text:'Purchased Pistol Ammo (+17)'});
      // ammo not price-booked for selling

    } else {
      // Generic purchase: supports armour + misc
      const key = it.invKey || it.id;
      const pretty = it.name || key;

      function addArmorPiece(slotGuess){
        const valid = new Set(['helmet','vest','arms','legs','head','chest']); // accept both slot vocab
        const slotIn = (it.slot||slotGuess||'').toLowerCase();
        let slot = valid.has(slotIn) ? slotIn :
          (/helmet|head/i.test(pretty)?'head' :
           /vest|chest|body/i.test(pretty)?'chest' :
           /arms|glove|gaunt/i.test(pretty)?'arms' : 'legs');

        const entry = inv[key] || { count:0 };
        entry.count = (entry.count|0) + 1;
        entry.name  = pretty;
        entry.type  = 'armor';
        entry.slot  = slot;
        entry.equippable = true;
        entry.iconSvg = entry.iconSvg || it.iconSvg || svgToDataURL(svgIcon(it.id,24,24));
        inv[key] = entry;

        pb[key] = { lastPaid: it.price, name: pretty }; // remember price for sell tab
        IZZA.emit?.('toast', {text:`Purchased ${pretty}`});
      }

      let handled=false;
      if(it.type==='armor' || it.slot){ addArmorPiece(it.slot||''); handled=true; }
      else if(typeof key === 'string' && key.startsWith('armor:')){
        const parts = key.split(':'); const piece = parts[2]||'';
        addArmorPiece(piece); handled=true;
      }
      if(!handled){
        const e = inv[key] || { count:0, name:pretty };
        e.count = (e.count|0) + 1;
        e.iconSvg = e.iconSvg || it.iconSvg || '';
        inv[key] = e;
        pb[key] = { lastPaid: it.price, name: pretty };
        IZZA.emit?.('toast', {text:`Purchased ${pretty}`});
      }
    }

    api.setInventory && api.setInventory(inv);
    writePriceBook(pb);

    // refresh inventory pane if open + announce
    try{
      const host = document.getElementById('invPanel');
      if(host && host.style.display!=='none' && typeof window.renderInventoryPanel==='function'){
        window.renderInventoryPanel();
      }
    }catch{}
    try { window.dispatchEvent(new Event('izza-inventory-changed')); } catch {}
    try { window.dispatchEvent(new Event('izza-coins-changed')); } catch {}
  }

  // ---------- SELL tab ----------
  function getSellPrice(key){
    const pb = readPriceBook();
    const last = pb[key]?.lastPaid;
    const base = (typeof last === 'number' && last>0) ? last : 25;
    return Math.max(1, Math.ceil(base * 0.40));
  }

  function renderSellList(){
    const modal = document.getElementById('shopModal');
    if(!modal) return;
    const list = modal.querySelector('#shopSellList');
    if(!list) return;

    // build from current inventory
    let inv = {};
    try{ inv = api.getInventory ? api.getInventory() : {}; }catch{}

    list.replaceChildren();

    // collect to array for stable filtering/sorting
    const rows = [];
    Object.keys(inv).forEach(key=>{
      const e = inv[key];
      if(!e) return;
      const count = (e.count|0) + (e.owned?1:0);
      if(count<=0) return;

      // forbid selling mission-critical items
      if(/jack_o_lantern|pumpkin_piece/i.test(key)) return;

      const pretty = e.name || key;
      const price  = getSellPrice(key);

      // text filter
      const q = currentFilter;
      if(q){
        const blob = `${pretty} ${key}`.toLowerCase();
        if(!blob.includes(q)) return;
      }

      rows.push({key, e, pretty, price, count});
    });

    if(!rows.length){
      const empty = document.createElement('div');
      empty.className='shop-note';
      empty.textContent = 'No sellable items.';
      list.appendChild(empty);
      return;
    }

    const frag = document.createDocumentFragment();
    rows.forEach(({key, e, pretty, price, count})=>{
      const row = document.createElement('div'); row.className='shop-item';
      const meta = document.createElement('div'); meta.className='meta';
      const icon = e.iconSvg ? `<img src="${e.iconSvg}" width="24" height="24" style="image-rendering:pixelated;display:block">` : '';
      meta.innerHTML = `
        <div style="display:flex; align-items:center; gap:8px">
          <div>${icon}</div>
          <div>
            <div class="name">${pretty}</div>
            <div class="sub" style="opacity:.85">You own: ${count}</div>
          </div>
        </div>`;

      const btn = document.createElement('button');
      btn.className='sell';
      btn.textContent = `Sell ${price} IC`;
      btn.addEventListener('click', ()=>{
        doSell(key, e, price);
        renderSellList(); // refresh list counts after sale
      });

      row.appendChild(meta);
      row.appendChild(btn);
      frag.appendChild(row);
    });
    list.appendChild(frag);
  }

  function doSell(key, entry, price){
    try{
      const inv = api.getInventory ? api.getInventory() : {};
      const pb  = readPriceBook();

      // reduce inventory
      if(inv[key]){
        if (typeof inv[key].count === 'number' && inv[key].count>0){
          inv[key].count -= 1;
          if(inv[key].count<=0 && !inv[key].owned && !inv[key].equipped) delete inv[key];
        }else if(inv[key].owned){
          inv[key].owned = false;
          if(!inv[key].count && !inv[key].equipped) delete inv[key];
        }else{
          delete inv[key];
        }
      }

      api.setInventory && api.setInventory(inv);
      writePriceBook(pb);

      // give coins
      const coins = api.getCoins ? api.getCoins() : (api.player?.coins|0);
      api.setCoins(coins + price);

      IZZA.toast?.(`Sold for ${price} IC`);
      try { window.dispatchEvent(new Event('izza-inventory-changed')); } catch {}
      try { window.dispatchEvent(new Event('izza-coins-changed')); } catch {}
    }catch(e){ console.warn('[shop] sell failed', e); }
  }

  // ---------- Repair icons for legacy rows ----------
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
        if(!isBat && !isKnuckles && !currentName){
          const html = (iconHolder.innerHTML||'').toLowerCase();
          if(html.includes('#8b5a2b') || html.includes('#6f4320')) isBat = true;
          else if(html.includes('#cfcfcf') && html.includes('<circle')) isKnuckles = true;
        }
        if(isBat){
          const html = (iconHolder.innerHTML||'').trim();
          if(!html || html.includes('⭐') || (!html.includes('<svg') && !html.includes('<img'))){
            iconHolder.innerHTML = iconImgHTML(svgIcon('bat',24,24));
          }
          if(!currentName) nameEl.textContent = 'Baseball Bat';
        }else if(isKnuckles){
          const html = (iconHolder.innerHTML||'').trim();
          if(!html || html.includes('⭐') || (!html.includes('<svg') && !html.includes('<img'))){
            iconHolder.innerHTML = iconImgHTML(svgIcon('knuckles',24,24));
          }
          if(!currentName) nameEl.textContent = 'Brass Knuckles';
        }
      });
    }catch(e){
      console.warn('[store extender] icon repair failed:', e);
    }
  }

  // ---------- Stock patcher (BUY list) ----------
  function patchShopStock(){
    try{
      if(!api) return;

      const modal = document.getElementById('shopModal');
      if(!modal) return;

      const open = (modal.style.display === 'flex') ||
                   (getComputedStyle(modal).display === 'flex');
      if(!open) return;

      ensureTabs();

      const buyList = document.getElementById('shopBuyList') || document.getElementById('shopList');
      if(!buyList) return;

      // Extend stock (only once per open)
      if(!buyList.querySelector('[data-store-ext]')){
        const missions = (api.getMissionCount && api.getMissionCount()) || 0;
        if(missions >= 3){
          addShopRow(buyList, { id:'uzi',          name:'Uzi (w/ +50 ammo)',       price:350, sub:'Compact SMG. +50 ammo.' });
          addShopRow(buyList, { id:'pistol_ammo',  name:'Pistol Ammo (17 rounds)', price:60,  sub:'Magazine refuel for pistol.' });
          addShopRow(buyList, { id:'grenade',      name:'Grenade',                 price:120, sub:'Area blast. One-time use.' });
        }
      }

      repairMissingIcons();
      filterBuyList(); // apply current search instantly
    }catch(e){
      console.warn('[store extender] patch failed:', e);
    }
  }

  // ---------- boot ----------
  IZZA.on('ready', a=>{ api=a; });
  IZZA.on('render-post', patchShopStock);

})();
