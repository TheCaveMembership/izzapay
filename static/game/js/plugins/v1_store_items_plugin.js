// v1_store_items_plugin.js — extend shop stock + icon repair + BUY/SELL tabs + search + inventory pricebook
(function(){
  const BUILD = 'v1-store-items+stock-extender+icon-fix-7+buy-sell+search+pricebook+scroll-fix';
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
    if(isDataUrl(svg)) return svg;
    if(/^\s*</.test(svg)) return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
    return svg;
  }
  function iconImgHTMLFromAny(svgOrData, w=24, h=24){
    const src = svgToDataURL(svgOrData||'');
    return `<img src="${src}" width="${w}" height="${h}" alt="" decoding="async" style="image-rendering:pixelated;display:block">`;
  }

  // ---------- tiny SVGs (UI icons only) ----------
  function svgIcon(id, w=24, h=24){
    if(id==='bat')      return `<svg viewBox="0 0 64 64" width="${w}" height="${h}"><rect x="22" y="8" width="8" height="40" fill="#8b5a2b"/><rect x="20" y="48" width="12" height="8" fill="#6f4320"/></svg>`;
    if(id==='knuckles') return `<svg viewBox="0 0 64 64" width="${w}" height="${h}"><circle cx="20" cy="28" r="6" stroke="#cfcfcf" fill="none" stroke-width="4"/><circle cx="32" cy="28" r="6" stroke="#cfcfcf" fill="none" stroke-width="4"/><circle cx="44" cy="28" r="6" stroke="#cfcfcf" fill="none" stroke-width="4"/><rect x="16" y="34" width="32" height="8" fill="#cfcfcf"/></svg>`;
    if(id==='pistol')   return `<svg viewBox="0 0 64 64" width="${w}" height="${h}"><rect x="14" y="26" width="30" height="8" fill="#202833"/><rect x="22" y="34" width="8" height="12" fill="#444c5a"/></svg>`;
    if(id==='uzi')      return `<svg viewBox="0 0 64 64" width="${w}" height="${h}"><rect x="12" y="28" width="34" height="8" fill="#0b0e14"/><rect x="36" y="22" width="12" height="6" fill="#0b0e14"/><rect x="30" y="36" width="6" height="12" fill="#0b0e14"/><rect x="18" y="36" width="6" height="10" fill="#0b0e14"/></svg>`;
    if(id==='grenade')  return `<svg viewBox="0 0 64 64" width="${w}" height="${h}"><rect x="28" y="22" width="8" height="5" fill="#5b7d61"/><rect x="31" y="19" width="2" height="2" fill="#c3c9cc"/><rect x="26" y="27" width="12" height="14" fill="#264a2b"/></svg>`;
    if(id==='pistol_ammo') return `<svg viewBox="0 0 64 64" width="${w}" height="${h}"><rect x="28" y="18" width="8" height="28" fill="#c9a24c"/><rect x="28" y="44" width="8" height="6" fill="#6f5a1d"/></svg>`;
    return '';
  }
  function svgIconArmorGeneric(slot, w=24, h=24){
    const base='#2a2f3f', shade='#121826';
    const body = slot==='head'
      ? `<rect x="6" y="3" width="12" height="10" rx="3" fill="${base}"/><rect x="6" y="11" width="12" height="3" fill="${shade}"/>`
      : slot==='chest'
      ? `<rect x="5" y="6" width="14" height="12" rx="2" fill="${base}"/><rect x="6" y="12" width="12" height="3" fill="${shade}"/>`
      : slot==='legs'
      ? `<rect x="7" y="6" width="4" height="12" fill="${base}"/><rect x="13" y="6" width="4" height="12" fill="${base}"/><rect x="7" y="14" width="10" height="2" fill="${shade}"/>`
      : `<rect x="4" y="8" width="5" height="8" rx="2" fill="${base}"/><rect x="15" y="8" width="5" height="8" rx="2" fill="${base}"/>`;
    return `<svg viewBox="0 0 24 24" width="${w}" height="${h}"><rect x="2" y="2" width="20" height="20" rx="4" fill="#0e1524"/>${body}</svg>`;
  }

  // legacy name→id
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
  function normSlot(s){
    const v=(s||'').toLowerCase();
    if(v==='helmet' || v==='head') return 'head';
    if(v==='vest'   || v==='chest'|| v==='body') return 'chest';
    if(v==='arms'   || /arm|glove|gaunt/.test(v)) return 'arms';
    return 'legs';
  }

  // ---------- BUY/SELL TABS + SEARCH UI (+ SCROLL FIX) ----------
  let tabsWired = false, shopObs = null;
  function ensureTabs(){
    const modal = document.getElementById('shopModal');
    if(!modal) return;
    const host  = modal.querySelector('#shopList');
    if(!host || host.dataset.tabs==='1') return;

    const card = modal.querySelector('.card');
    if(!card) return;

    // SCROLL/STYLES — the important bits are flex column + min-height:0 for lists
    if(!document.getElementById('shop-tabs-css')){
      const css = document.createElement('style');
      css.id = 'shop-tabs-css';
      css.textContent = `
      #shopModal{align-items:center;justify-content:center}
      #shopModal .card{display:flex;flex-direction:column;max-height:min(90vh,720px);width:min(92vw,560px)}
      #shopTabs{display:flex;gap:6px;margin:0 0 8px;flex:0 0 auto}
      #shopTabs .tab{flex:0 0 auto;padding:6px 10px;border-radius:10px;border:1px solid #2a3550;background:#162134;color:#cfe0ff;font-weight:700;cursor:pointer}
      #shopTabs .tab.on{background:#1f6feb;border-color:#2f6feb;color:#fff}
      #shopSearch{width:100%;margin:0 0 8px;padding:8px 12px;border-radius:12px;border:1px solid #2a3550;background:#0e1524;color:#cfe0ff;font-weight:650;flex:0 0 auto}
      .shop-list{flex:1 1 auto;min-height:0} /* <- THIS UNLOCKS SCROLLING */
      .shop-scroll{overflow:auto;display:flex;flex-direction:column;gap:8px;padding-right:4px;-webkit-overflow-scrolling:touch}
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

    // lists (NOTE: no fixed max-height here; flex handles it)
    const buyList  = document.createElement('div'); buyList.id='shopBuyList';  buyList.className='shop-list shop-scroll';
    const sellList = document.createElement('div'); sellList.id='shopSellList'; sellList.className='shop-list shop-scroll'; sellList.style.display='none';

    // move Core rows into BUY list
    while(host.firstChild) buyList.appendChild(host.firstChild);
    host.dataset.tabs='1';
    host.replaceChildren();

    // slot UI
    card.insertBefore(tabs, card.children[1] || card.firstChild);
    card.insertBefore(search, tabs.nextSibling);
    card.insertBefore(buyList, search.nextSibling);
    card.insertBefore(sellList, buyList.nextSibling);

    // Fallback sizing (in case parent constraints fight us): compute available height
    function sizeLists(){
      // ensure the card never overflows viewport; compute list room
      const rect = card.getBoundingClientRect();
      const maxCard = Math.min(window.innerHeight*0.9, 720);
      card.style.maxHeight = maxCard+'px';
      // let flex do most work; but if something upstream prevents flex, set an explicit max
      const used = (tabs.offsetHeight||0) + (search.offsetHeight||0) + 24; // +padding
      const avail = Math.max(240, maxCard - used);
      buyList.style.maxHeight  = avail+'px';
      sellList.style.maxHeight = avail+'px';
    }
    sizeLists();
    window.addEventListener('resize', sizeLists);

    // Observe future DOM changes (Core may inject rows later); keep icons healthy
    if(!shopObs){
      shopObs = new MutationObserver(()=> { repairMissingIcons(); });
      shopObs.observe(card, { childList:true, subtree:true });
    }

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
        sizeLists();
      }, true);

      // live search
      search.addEventListener('input', ()=>{
        const q=search.value.trim();
        const buying = card.querySelector('#shopTabs .tab.on')?.dataset.tab!=='sell';
        if(buying){ filterBuyList(q); } else { renderSellList(q); }
      });

      // keep SELL synced if inventory changes while modal is open
      window.addEventListener('izza-inventory-changed', ()=>{
        const selling = card.querySelector('#shopTabs .tab.on')?.dataset.tab==='sell';
        if(selling) renderSellList(search.value.trim());
        repairMissingIcons();
      });
    }
  }

  // filter for existing BUY rows
  function filterBuyList(q){
    const list = document.getElementById('shopBuyList') || document.getElementById('shopList');
    if(!list) return;
    const needle = q.toLowerCase();
    list.querySelectorAll('.shop-item').forEach(row=>{
      const txt = (row.textContent||'').toLowerCase();
      row.style.display = (!needle || txt.includes(needle)) ? '' : 'none';
    });
  }

  // ---------- BUY rows ----------
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

    if(it.id==='uzi'){
      const cur = inv.uzi || { owned:true, ammo:0, equipped:false, type:'weapon', name:'Uzi' };
      cur.owned = true; cur.ammo = (cur.ammo|0) + 50;
      cur.name='Uzi'; cur.type='weapon';
      cur.iconSvg = cur.iconSvg || svgToDataURL(svgIcon('uzi',24,24));
      inv.uzi = cur;
      IZZA.emit?.('toast', {text:'Purchased Uzi (+50 ammo)'}); pb['uzi'] = { lastPaid: it.price, name:'Uzi' };

    }else if(it.id==='grenade'){
      const cur = inv.grenade || { count:0, name:'Grenade', type:'consumable' };
      cur.count = (cur.count|0) + 1;
      cur.type='consumable';
      cur.iconSvg = cur.iconSvg || svgToDataURL(svgIcon('grenade',24,24));
      inv.grenade = cur;
      IZZA.emit?.('toast', {text:'Purchased Grenade'}); pb['grenade'] = { lastPaid: it.price, name:'Grenade' };

    }else if(it.id==='pistol_ammo'){
      const cur = inv.pistol || { owned:true, ammo:0, equipped:false, name:'Pistol', type:'weapon' };
      cur.owned = true; cur.ammo = (cur.ammo|0) + 17;
      cur.name = cur.name || 'Pistol'; cur.type='weapon';
      cur.iconSvg = cur.iconSvg || svgToDataURL(svgIcon('pistol',24,24));
      inv.pistol = cur;
      IZZA.emit?.('toast', {text:'Purchased Pistol Ammo (+17)'});

    } else {
      const key = it.invKey || it.id;
      const pretty = it.name || key;

      function addArmorPiece(slotGuess){
        const slot = normSlot(it.slot||slotGuess||pretty);
        const entry = inv[key] || { count:0 };
        entry.count = (entry.count|0) + 1;
        entry.name  = pretty;
        entry.type  = 'armor';
        entry.slot  = slot;
        entry.equippable = true;
        entry.iconSvg = entry.iconSvg || it.iconSvg || svgToDataURL(svgIconArmorGeneric(slot,24,24));
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

  function iconForInv(key, entry){
    if(entry?.iconSvg){
      return iconImgHTMLFromAny(entry.iconSvg, 24, 24);
    }
    if(entry?.type==='armor'){
      const slot = normSlot(entry.slot||'');
      return iconImgHTMLFromAny(svgIconArmorGeneric(slot,24,24),24,24);
    }
    const id = guessLegacyIdFromName(entry?.name || key) ||
               ({pistol:'pistol', uzi:'uzi', grenade:'grenade', bat:'bat', knuckles:'knuckles'}[key] || '');
    if(id) return iconImgHTMLFromAny(svgIcon(id,24,24), 24, 24);
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
      if(/jack_o_lantern|pumpkin_piece/i.test(key)) return;

      const pretty = e.name || key;
      if(needle && !pretty.toLowerCase().includes(needle)) return;

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
        renderSellList(needle);
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

  // ---------- Icon repair (BUY & SELL) ----------
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
          const id = guessLegacyIdFromName(pretty);
          const html = (iconHolder.innerHTML||'').trim();

          const looksBroken = !html || html==='?' || /⭐/.test(html) ||
                              /^"&/.test(html) || /^&quot;/.test(html) ||
                              /^" width=/.test(html) ||
                              (!html.includes('<img') && !html.includes('<svg'));
          if(looksBroken && id){
            iconHolder.innerHTML = iconImgHTMLFromAny(svgIcon(id,24,24));
          }
        });
      });
    }catch(e){
      console.warn('[store extender] icon repair failed:', e);
    }
  }

  // ---------- Stock patcher ----------
  function patchShopStock(){
    try{
      if(!api) return;

      const modal = document.getElementById('shopModal');
      if(!modal) return;

      const open = (modal.style.display === 'flex') || (getComputedStyle(modal).display === 'flex');
      if(!open) return;

      ensureTabs();

      const buyList = document.getElementById('shopBuyList') || document.getElementById('shopList');
      if(!buyList) return;

      if(!buyList.querySelector('[data-store-ext]')){
        const missions = (api.getMissionCount && api.getMissionCount()) || 0;
        if(missions >= 3){
          addShopRow(buyList, { id:'uzi',          name:'Uzi (w/ +50 ammo)',       price:350, sub:'Compact SMG. +50 ammo.' });
          addShopRow(buyList, { id:'pistol_ammo',  name:'Pistol Ammo (17 rounds)', price:60,  sub:'Magazine refuel for pistol.' });
          addShopRow(buyList, { id:'grenade',      name:'Grenade',                 price:120, sub:'Area blast. One-time use.' });
        }
      }

      repairMissingIcons();
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
