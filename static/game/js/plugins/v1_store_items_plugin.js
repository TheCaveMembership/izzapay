// v1_store_items_plugin.js — extend shop stock + icon repair + BUY/SELL tabs + search + inventory pricebook
(function(){
  const BUILD = 'v1-store-items+stock-extender+icon-fix-6+buy-sell+search+pricebook+sell-live+armor-fallback';
  console.log('[IZZA PLAY]', BUILD);

  let api = null;

  // ---------- helpers ----------
  const PRICE_BOOK_KEY = 'izzaPriceBook';   // { invKey: { lastPaid:number, name:string } }
  function readPriceBook(){
    try{ return JSON.parse(localStorage.getItem(PRICE_BOOK_KEY)||'{}'); }catch{ return {}; }
  }
  function writePriceBook(pb){ try{ localStorage.setItem(PRICE_BOOK_KEY, JSON.stringify(pb||{})); }catch{} }

  const isDataUrl = s => typeof s==='string' && /^data:image\/svg\+xml/i.test(s);
  function svgToDataURL(svg){
    if(!svg) return '';
    if(isDataUrl(svg)) return svg;                                 // already encoded
    if(/^\s*</.test(svg)) return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg); // raw <svg>
    return svg;                                                    // URL or something else => leave
  }
  function iconImgHTMLFromAny(svgOrData, w=24, h=24){
    const src = svgToDataURL(svgOrData||'');
    return `<img src="${src}" width="${w}" height="${h}" alt="" decoding="async" style="image-rendering:pixelated;display:block">`;
  }

  // Tiny, reliable UI icons (NOT used for on-character overlays)
  function svgIcon(id, w=24, h=24){
    if(id==='bat')         return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${w}" height="${h}"><rect x="22" y="8" width="8" height="40" fill="#8b5a2b"/><rect x="20" y="48" width="12" height="8" fill="#6f4320"/></svg>`;
    if(id==='knuckles')    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${w}" height="${h}"><circle cx="20" cy="28" r="6" stroke="#cfcfcf" fill="none" stroke-width="4"/><circle cx="32" cy="28" r="6" stroke="#cfcfcf" fill="none" stroke-width="4"/><circle cx="44" cy="28" r="6" stroke="#cfcfcf" fill="none" stroke-width="4"/><rect x="16" y="34" width="32" height="8" fill="#cfcfcf"/></svg>`;
    if(id==='pistol')      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${w}" height="${h}"><rect x="14" y="26" width="30" height="8" fill="#202833"/><rect x="22" y="34" width="8" height="12" fill="#444c5a"/></svg>`;
    if(id==='uzi')         return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${w}" height="${h}"><rect x="12" y="28" width="34" height="8" fill="#0b0e14"/><rect x="36" y="22" width="12" height="6" fill="#0b0e14"/><rect x="30" y="36" width="6" height="12" fill="#0b0e14"/><rect x="18" y="36" width="6" height="10" fill="#0b0e14"/></svg>`;
    if(id==='grenade')     return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${w}" height="${h}"><rect x="28" y="22" width="8" height="5" fill="#5b7d61"/><rect x="31" y="19" width="2" height="2" fill="#c3c9cc"/><rect x="26" y="27" width="12" height="14" fill="#264a2b"/></svg>`;
    if(id==='pistol_ammo') return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${w}" height="${h}"><rect x="28" y="18" width="8" height="28" fill="#c9a24c"/><rect x="28" y="44" width="8" height="6" fill="#6f5a1d"/></svg>`;
    return '';
  }

  // quick name→id resolver for legacy rows
  function guessLegacyIdFromName(name){
    const n=(name||'').toLowerCase();
    if(/\bknuckle/.test(n)) return 'knuckles';
    if(/\bbat\b/.test(n)) return 'bat';
    if(/\buzi\b/.test(n)) return 'uzi';
    if(/\bpistol\b/.test(n) && !/ammo/.test(n)) return 'pistol';
    if(/\bgrenade\b/.test(n)) return 'grenade';
    if(/\bammo\b/.test(n)) return 'pistol_ammo';
    return '';
  }

  // Generic, guaranteed armour UI icon (used only if entry.iconSvg is missing)
  function svgArmorFallback(slot, w=24, h=24){
    const base='#2a2f3f', shade='#1a1f2b', trim='#48536d';
    if(slot==='head')  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${w}" height="${h}"><rect x="2" y="2" width="20" height="20" rx="4" fill="${trim}"/><rect x="6" y="5" width="12" height="9" rx="3" fill="${base}"/><rect x="6" y="12" width="12" height="2" fill="${shade}"/></svg>`;
    if(slot==='chest') return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${w}" height="${h}"><rect x="2" y="2" width="20" height="20" rx="4" fill="${trim}"/><rect x="5" y="6" width="14" height="12" rx="2" fill="${base}"/><rect x="6" y="12" width="12" height="3" fill="${shade}"/></svg>`;
    if(slot==='legs')  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${w}" height="${h}"><rect x="2" y="2" width="20" height="20" rx="4" fill="${trim}"/><rect x="6" y="6" width="4" height="12" fill="${base}"/><rect x="14" y="6" width="4" height="12" fill="${base}"/><rect x="6" y="14" width="12" height="2" fill="${shade}"/></svg>`;
    // arms
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${w}" height="${h}"><rect x="2" y="2" width="20" height="20" rx="4" fill="${trim}"/><rect x="4" y="8" width="5" height="8" rx="2" fill="${base}"/><rect x="15" y="8" width="5" height="8" rx="2" fill="${base}"/><rect x="5" y="10" width="3" height="3" fill="${shade}"/><rect x="16" y="10" width="3" height="3" fill="${shade}"/></svg>`;
  }

  // Normalize armour slot strings from any vocabulary → canonical
  function normalizeSlot(s){
    const x=(s||'').toLowerCase();
    if(x==='helmet' || x==='head') return 'head';
    if(x==='vest'   || x==='chest'|| x==='body') return 'chest';
    if(x==='arms'   || x==='arm'  || x==='gloves' || x==='gauntlets') return 'arms';
    return 'legs';
  }

  // ---------- BUY/SELL TABS + SEARCH UI ----------
  let tabsWired = false;
  function ensureTabs(){
    const modal = document.getElementById('shopModal');
    if(!modal) return;
    const host  = modal.querySelector('#shopList');
    if(!host || host.dataset.tabs==='1') return;

    const card = modal.querySelector('.card');
    if(!card) return;

    // styles
    if(!document.getElementById('shop-tabs-css')){
      const css = document.createElement('style');
      css.id = 'shop-tabs-css';
      css.textContent = `
      #shopTabs{display:flex;gap:6px;margin:0 0 8px}
      #shopTabs .tab{flex:0 0 auto;padding:6px 10px;border-radius:10px;border:1px solid #2a3550;background:#162134;color:#cfe0ff;font-weight:700;cursor:pointer}
      #shopTabs .tab.on{background:#1f6feb;border-color:#2f6feb;color:#fff}
      #shopSearch{width:100%;margin:0 0 8px;padding:8px 12px;border-radius:12px;border:1px solid #2a3550;background:#0e1524;color:#cfe0ff;font-weight:650}
      .shop-scroll{max-height:min(60vh,520px);overflow:auto;display:flex;flex-direction:column;gap:8px;padding-right:4px;-webkit-overflow-scrolling:touch;overscroll-behavior:contain}
      .shop-item{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px;background:#0f1522;border:1px solid #2a3550;border-radius:10px}
      .shop-item .buy, .shop-item .sell { background:#1f2a3f; color:#cfe0ff; border:1px solid #2a3550; border-radius:8px; padding:6px 10px }
      .shop-note{opacity:.8;font-size:12px;margin-top:6px}
      `;
      document.head.appendChild(css);
    }

    // tabs
    const tabs = document.createElement('div');
    tabs.id='shopTabs';
    tabs.innerHTML = `<button class="tab on" data-tab="buy">Buy</button><button class="tab" data-tab="sell">Sell</button>`;

    // search
    const search = document.createElement('input');
    search.id='shopSearch';
    search.placeholder='Search shop & inventory…';
    search.autocomplete='off';

    const buyList  = document.createElement('div'); buyList.id='shopBuyList';  buyList.className='shop-list shop-scroll';
    const sellList = document.createElement('div'); sellList.id='shopSellList'; sellList.className='shop-list shop-scroll'; sellList.style.display='none';

    // move existing children (core rows) into buyList
    while(host.firstChild) buyList.appendChild(host.firstChild);
    host.dataset.tabs='1';
    host.replaceChildren(); // clear

    // slot UI
    card.insertBefore(tabs, card.children[1] || card.firstChild);
    card.insertBefore(search, tabs.nextSibling);
    card.insertBefore(buyList, search.nextSibling);
    card.insertBefore(sellList, buyList.nextSibling);

    // Immediately heal legacy icons that core added before our plugin ran
    setTimeout(repairMissingIcons, 0);

    // wire once
    if(!tabsWired){
      tabsWired = true;

      card.addEventListener('click', (ev)=>{
        const b=ev.target && ev.target.closest('#shopTabs .tab');
        if(!b) return;
        const mode=b.getAttribute('data-tab');
        card.querySelectorAll('#shopTabs .tab').forEach(t=>t.classList.toggle('on', t===b));
        buyList.style.display = (mode==='buy')?'':'none';
        sellList.style.display = (mode==='sell')?'':'none';
        if(mode==='sell') renderSellList(search.value.trim());
        if(mode==='buy')  filterBuyList(search.value.trim());
      }, true);

      // live search
      search.addEventListener('input', ()=>{
        const q=search.value.trim();
        const buying = card.querySelector('#shopTabs .tab.on')?.dataset.tab!=='sell';
        if(buying){ filterBuyList(q); } else { renderSellList(q); }
      });

      // if inventory changes while SELL tab is visible, live refresh it
      window.addEventListener('izza-inventory-changed', ()=>{
        const mode = card.querySelector('#shopTabs .tab.on')?.dataset.tab || 'buy';
        if(mode==='sell'){ renderSellList(search.value.trim()); }
      });
    }
  }

  // filter for existing BUY rows (non-invasive)
  function filterBuyList(q){
    const list = document.getElementById('shopBuyList') || document.getElementById('shopList');
    if(!list) return;
    const needle = (q||'').toLowerCase();
    list.querySelectorAll('.shop-item').forEach(row=>{
      const txt = (row.textContent||'').toLowerCase();
      row.style.display = (!needle || txt.includes(needle)) ? '' : 'none';
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
        <div data-icon>${svgIcon(it.id)}</div>
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

    // Known items (unchanged)
    if(it.id==='uzi'){
      const cur = inv.uzi || { owned:true, ammo:0, equipped:false };
      cur.owned = true; cur.ammo = (cur.ammo|0) + 50;
      cur.name='Uzi'; cur.iconSvg = cur.iconSvg || svgToDataURL(svgIcon('uzi',24,24));
      inv.uzi = cur;
      IZZA.emit?.('toast', {text:'Purchased Uzi (+50 ammo)'}); pb['uzi'] = { lastPaid: it.price, name:'Uzi' };

    }else if(it.id==='grenade'){
      const cur = inv.grenade || { count:0, name:'Grenade' };
      cur.count = (cur.count|0) + 1;
      cur.iconSvg = cur.iconSvg || svgToDataURL(svgIcon('grenade',24,24));
      inv.grenade = cur;
      IZZA.emit?.('toast', {text:'Purchased Grenade'}); pb['grenade'] = { lastPaid: it.price, name:'Grenade' };

    }else if(it.id==='pistol_ammo'){
      const cur = inv.pistol || { owned:true, ammo:0, equipped:false };
      cur.owned = true; cur.ammo = (cur.ammo|0) + 17;
      cur.name = cur.name || 'Pistol';
      cur.iconSvg = cur.iconSvg || svgToDataURL(svgIcon('pistol',24,24));
      inv.pistol = cur;
      IZZA.emit?.('toast', {text:'Purchased Pistol Ammo (+17)'}); // no pricebook entry

    } else {
      // Generic purchase: supports armour + misc
      const key = it.invKey || it.id;
      const pretty = it.name || key;

      function addArmorPiece(slotGuess){
        let slot = normalizeSlot(it.slot||slotGuess||pretty);
        const entry = inv[key] || { count:0 };
        entry.count = (entry.count|0) + 1;
        entry.name  = pretty;
        entry.type  = 'armor';
        entry.slot  = slot;
        entry.equippable = true;
        entry.iconSvg = entry.iconSvg || it.iconSvg || svgToDataURL(svgIcon(it.id,24,24));
        inv[key] = entry;

        pb[key] = { lastPaid: it.price, name: pretty };
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

  // normalize icon source from any inventory entry
  function iconForInv(key, entry){
    // prefer entry.iconSvg (encode if raw)
    if(entry?.iconSvg){ return iconImgHTMLFromAny(entry.iconSvg, 24, 24); }
    // armour fallback if missing icon (covers Cardboard/Pumpkin/etc when created elsewhere)
    if((entry?.type||'')==='armor'){
      const slot = normalizeSlot(entry.slot||'');
      return iconImgHTMLFromAny(svgArmorFallback(slot,24,24), 24, 24);
    }
    // legacy weapons/consumables
    const id = guessLegacyIdFromName(entry?.name || key) ||
               ({pistol:'pistol', uzi:'uzi', grenade:'grenade'}[key] || '');
    if(id) return iconImgHTMLFromAny(svgIcon(id,24,24), 24, 24);
    // nothing
    return '';
  }

  function renderSellList(qText){
    const modal = document.getElementById('shopModal');
    if(!modal) return;
    const list = modal.querySelector('#shopSellList');
    if(!list) return;

    let inv = {};
    try{ inv = api.getInventory ? api.getInventory() : {}; }catch{}

    const needle = (qText||'').toLowerCase();
    list.replaceChildren();

    Object.keys(inv).forEach(key=>{
      const e = inv[key];
      if(!e) return;
      const count = (e.count|0) + (e.owned?1:0);
      if(count<=0) return;
      if(/jack_o_lantern|pumpkin_piece/i.test(key)) return; // prevent selling quest bits

      const pretty = e.name || key;
      if(needle && !(`${key} ${pretty}`.toLowerCase()).includes(needle)) return;

      const price  = getSellPrice(key);
      const row = document.createElement('div'); row.className='shop-item';
      const meta = document.createElement('div'); meta.className='meta';

      const iconHTML = iconForInv(key, e);
      meta.innerHTML = `
        <div style="display:flex; align-items:center; gap:8px">
          <div data-icon>${iconHTML}</div>
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
        renderSellList(needle); // refresh list counts
      });

      row.appendChild(meta);
      row.appendChild(btn);
      list.appendChild(row);
    });

    if(!list.children.length){
      const empty = document.createElement('div');
      empty.className='shop-note';
      empty.textContent = needle ? 'No matches.' : 'No sellable items.';
      list.appendChild(empty);
    }
  }

  function doSell(key, entry, price){
    try{
      const inv = api.getInventory ? api.getInventory() : {};
      const pb  = readPriceBook();

      if(inv[key]){
        if (typeof inv[key].count === 'number' && inv[key].count>0){
          inv[key].count -= 1;
          if(inv[key].count<=0 && !inv[key].owned) delete inv[key];
        }else if(inv[key].owned){
          inv[key].owned = false;
          if(!inv[key].count && !inv[key].equipped) delete inv[key];
        }else{
          delete inv[key];
        }
      }

      api.setInventory && api.setInventory(inv);
      writePriceBook(pb);

      const coins = api.getCoins ? api.getCoins() : (api.player?.coins|0);
      api.setCoins(coins + price);

      IZZA.toast?.(`Sold for ${price} IC`);
      try { window.dispatchEvent(new Event('izza-inventory-changed')); } catch {}
      try { window.dispatchEvent(new Event('izza-coins-changed')); } catch {}
    }catch(e){ console.warn('[shop] sell failed', e); }
  }

  // ---------- Robust icon repair for legacy rows (BUY & SELL) ----------
  function repairMissingIcons(){
    try{
      const modal = document.getElementById('shopModal');
      if(!modal) return;
      const open = (modal.style.display === 'flex') || (getComputedStyle(modal).display === 'flex');
      if(!open) return;

      const lists = [
        modal.querySelector('#shopBuyList') || document.getElementById('shopList'),
        modal.querySelector('#shopSellList')
      ].filter(Boolean);

      lists.forEach(list=>{
        list.querySelectorAll('.shop-item .meta').forEach(meta=>{
          const iconHolder = meta.querySelector('[data-icon]') || meta.querySelector(':scope > div:first-child');
          const nameEl     = meta.querySelector('.name');
          if(!iconHolder || !nameEl) return;
          const pretty = (nameEl.textContent||'').trim();
          const idByName = guessLegacyIdFromName(pretty);
          const html = (iconHolder.innerHTML||'').trim();

          // replace if: empty, placeholder star/question, or broken raw dump
          const looksBroken = !html || html==='?' || /⭐/.test(html) || /^"&/.test(html) || /^&quot;/.test(html) || /^" width=/.test(html);
          if(looksBroken){
            // 1) legacy weapons by name
            if(idByName){ iconHolder.innerHTML = iconImgHTMLFromAny(svgIcon(idByName,24,24)); return; }
            // 2) armour rows: use neutral fallback by slot if we can find it in the text
            const txt=(meta.textContent||'').toLowerCase();
            const slot = /helmet|head/.test(txt) ? 'head' :
                         /vest|chest|body/.test(txt) ? 'chest' :
                         /arms|arm|gaunt|glove/.test(txt) ? 'arms' : /legs/.test(txt) ? 'legs' : '';
            if(slot){ iconHolder.innerHTML = iconImgHTMLFromAny(svgArmorFallback(slot,24,24)); }
          }
        });
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

      const open = (modal.style.display === 'flex') || (getComputedStyle(modal).display === 'flex');
      if(!open) return;

      ensureTabs();

      // Choose the BUY list as our target
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

      // After DOM settles, heal any placeholder icons
      repairMissingIcons();
      // And apply current search filter (if user typed)
      const q = (document.getElementById('shopSearch')?.value||'').trim();
      if(q) filterBuyList(q);
    }catch(e){
      console.warn('[store extender] patch failed:', e);
    }
  }

  // ---------- boot ----------
  IZZA.on('ready', a=>{ api=a; });
  IZZA.on('render-post', patchShopStock);

})();
