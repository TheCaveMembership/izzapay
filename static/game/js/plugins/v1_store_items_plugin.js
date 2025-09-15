// v1_store_items_plugin.js — stock extender + icon repair + BUY/SELL + search + pricebook
// + Inventory panel extender for ALL armor pieces (no Core edits)
(function(){
  const BUILD = 'v1.1.5-store-items+inv-ext-armor (owned-or-count>0 inventory visibility)';
  console.log('[IZZA PLAY]', BUILD);

  let api = null;

  // ---------- helpers ----------
  const PRICE_BOOK_KEY = 'izzaPriceBook';
  const readPriceBook = () => { try{ return JSON.parse(localStorage.getItem(PRICE_BOOK_KEY)||'{}'); }catch{ return {}; } };
  const writePriceBook = (pb)=>{ try{ localStorage.setItem(PRICE_BOOK_KEY, JSON.stringify(pb||{})); }catch{} };

  const isDataUrl = s => typeof s==='string' && /^data:image\/svg\+xml/i.test(s);
  function svgToDataURL(svg){
    if(!svg) return '';
    if(isDataUrl(svg)) return svg;
    if(/^\s*</.test(svg)) return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
    return svg;
  }
  function iconImgHTMLFromAny(svgOrData, w=24, h=24){
    if(!svgOrData) return '';
    const s = String(svgOrData).trim();
    if (/^</.test(s)) return s; // inline <svg> markup → inject directly
    return `<img src="${s}" width="${w}" height="${h}" alt="" decoding="async" style="image-rendering:pixelated;display:block">`;
  }

  // tiny UI icons (NOT overlays)
  function svgIcon(id, w=24, h=24){
    if(id==='bat')         return `<svg viewBox="0 0 64 64" width="${w}" height="${h}"><rect x="22" y="8" width="8" height="40" fill="#8b5a2b"/><rect x="20" y="48" width="12" height="8" fill="#6f4320"/></svg>`;
    if(id==='knuckles')    return `<svg viewBox="0 0 64 64" width="${w}" height="${h}"><circle cx="20" cy="28" r="6" stroke="#cfcfcf" fill="none" stroke-width="4"/><circle cx="32" cy="28" r="6" stroke="#cfcfcf" fill="none" stroke-width="4"/><circle cx="44" cy="28" r="6" stroke="#cfcfcf" fill="none" stroke-width="4"/><rect x="16" y="34" width="32" height="8" fill="#cfcfcf"/></svg>`;
    if(id==='pistol')      return `<svg viewBox="0 0 64 64" width="${w}" height="${h}"><rect x="14" y="26" width="30" height="8" fill="#202833"/><rect x="22" y="34" width="8" height="12" fill="#444c5a"/></svg>`;
    if(id==='uzi')         return `<svg viewBox="0 0 64 64" width="${w}" height="${h}"><rect x="12" y="28" width="34" height="8" fill="#0b0e14"/><rect x="36" y="22" width="12" height="6" fill="#0b0e14"/><rect x="30" y="36" width="6" height="12" fill="#0b0e14"/><rect x="18" y="36" width="6" height="10" fill="#0b0e14"/></svg>`;
    if(id==='grenade')     return `<svg viewBox="0 0 64 64" width="${w}" height="${h}"><rect x="28" y="22" width="8" height="5" fill="#5b7d61"/><rect x="31" y="19" width="2" height="2" fill="#c3c9cc"/><rect x="26" y="27" width="12" height="14" fill="#264a2b"/></svg>`;
    if(id==='pistol_ammo') return `<svg viewBox="0 0 64 64" width="${w}" height="${h}"><rect x="28" y="18" width="8" height="28" fill="#c9a24c"/><rect x="28" y="44" width="8" height="6" fill="#6f5a1d"/></svg>`;
    return '';
  }

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

  // ---------- BUY/SELL TABS + SEARCH UI ----------
  let tabsWired = false;
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
      #shopTabs{display:flex;gap:6px;margin:0 0 8px}
      #shopTabs .tab{flex:0 0 auto;padding:6px 10px;border-radius:10px;border:1px solid #2a3550;background:#162134;color:#cfe0ff;font-weight:700;cursor:pointer}
      #shopTabs .tab.on{background:#1f6feb;border-color:#2f6feb;color:#fff}
      #shopSearch{width:100%;margin:0 0 8px;padding:8px 12px;border-radius:12px;border:1px solid #2a3550;background:#0e1524;color:#cfe0ff;font-weight:650}
      .shop-scroll{max-height:min(60vh,520px);overflow:auto;display:flex;flex-direction:column;gap:8px;padding-right:4px}
      .shop-item{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px;background:#0f1522;border:1px solid #2a3550;border-radius:10px}
      .shop-item .buy,.shop-item .sell{background:#1f2a3f;color:#cfe0ff;border:1px solid #2a3550;border-radius:8px;padding:6px 10px}
      .shop-note{opacity:.8;font-size:12px;margin-top:6px}`;
      document.head.appendChild(css);
    }

    const tabs = document.createElement('div');
    tabs.id='shopTabs';
    tabs.innerHTML = `<button class="tab on" data-tab="buy">Buy</button><button class="tab" data-tab="sell">Sell</button>`;

    const search = document.createElement('input');
    search.id='shopSearch';
    search.placeholder='Search shop & inventory…';
    search.autocomplete='off';

    const buyList  = document.createElement('div'); buyList.id='shopBuyList';  buyList.className='shop-list shop-scroll';
    const sellList = document.createElement('div'); sellList.id='shopSellList'; sellList.className='shop-list shop-scroll'; sellList.style.display='none';

    while(host.firstChild) buyList.appendChild(host.firstChild);
    host.dataset.tabs='1';
    host.replaceChildren();

    card.insertBefore(tabs, card.children[1] || card.firstChild);
    card.insertBefore(search, tabs.nextSibling);
    card.insertBefore(buyList, search.nextSibling);
    card.insertBefore(sellList, buyList.nextSibling);

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

      search.addEventListener('input', ()=>{
        const q=search.value.trim();
        const buying = card.querySelector('#shopTabs .tab.on')?.dataset.tab!=='sell';
        if(buying){ filterBuyList(q); } else { renderSellList(q); }
      });
    }
  }

  function filterBuyList(q){
    const list = document.getElementById('shopBuyList') || document.getElementById('shopList');
    if(!list) return;
    const needle = (q||'').toLowerCase();
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
      const cur = inv.uzi || { owned:true, ammo:0, equipped:false };
      cur.owned = true; cur.ammo = (cur.ammo|0) + 50;
      cur.name='Uzi'; cur.iconSvg = cur.iconSvg || svgIcon('uzi',24,24);
      inv.uzi = cur; IZZA.emit?.('toast',{text:'Purchased Uzi (+50 ammo)'}); pb['uzi']={lastPaid:it.price,name:'Uzi'};
    }else if(it.id==='grenade'){
      const cur = inv.grenade || { count:0, name:'Grenade' };
      cur.count = (cur.count|0) + 1;
      cur.iconSvg = cur.iconSvg || svgIcon('grenade',24,24);
      inv.grenade = cur; IZZA.emit?.('toast',{text:'Purchased Grenade'}); pb['grenade']={lastPaid:it.price,name:'Grenade'};
    }else if(it.id==='pistol_ammo'){
      const cur = inv.pistol || { owned:true, ammo:0, equipped:false };
      cur.owned = true; cur.ammo = (cur.ammo|0) + 17;
      cur.name = cur.name || 'Pistol';
      cur.iconSvg = cur.iconSvg || svgIcon('pistol',24,24);
      inv.pistol = cur; IZZA.emit?.('toast',{text:'Purchased Pistol Ammo (+17)'});
    } else if (it.id==='bat') {
      const cur = inv.bat || { count:0, hitsLeftOnCurrent:0, equipped:false, name:'Baseball Bat' };
      cur.count += 1;
      if (cur.hitsLeftOnCurrent<=0) cur.hitsLeftOnCurrent = 20; // matches core
      cur.iconSvg = cur.iconSvg || svgIcon('bat',24,24);
      inv.bat = cur; IZZA.emit?.('toast',{text:'Purchased Baseball Bat'}); pb['bat']={lastPaid:it.price,name:'Baseball Bat'};
    } else if (it.id==='knuckles') {
      const cur = inv.knuckles || { count:0, hitsLeftOnCurrent:0, equipped:false, name:'Brass Knuckles' };
      cur.count += 1;
      if (cur.hitsLeftOnCurrent<=0) cur.hitsLeftOnCurrent = 50; // matches core
      cur.iconSvg = cur.iconSvg || svgIcon('knuckles',24,24);
      inv.knuckles = cur; IZZA.emit?.('toast',{text:'Purchased Brass Knuckles'}); pb['knuckles']={lastPaid:it.price,name:'Brass Knuckles'};
    } else {
      // Generic (armour + misc)
      const key = it.invKey || it.id;
      const pretty = it.name || key;

      function addArmorPiece(slotGuess){
        const valid = new Set(['helmet','vest','arms','legs','head','chest']);
        let slot = (it.slot||slotGuess||'').toLowerCase();
        if(!valid.has(slot)){
          slot = (/helmet|head/i.test(pretty)?'head' :
                  /vest|chest|body/i.test(pretty)?'chest' :
                  /arms|glove|gaunt/i.test(pretty)?'arms' : 'legs');
        }
        const entry = inv[key] || { count:0 };
        entry.count = (entry.count|0) + 1;
        entry.name  = pretty;
        entry.type  = 'armor';
        entry.slot  = slot==='helmet'?'head':(slot==='vest'?'chest':slot);
        entry.equippable = true;

        // Preserve raw iconSvg string (inline or data URL) if provided
        if (typeof entry.iconSvg !== 'string' || !entry.iconSvg) {
          if (typeof it.iconSvg === 'string' && it.iconSvg.trim()) {
            entry.iconSvg = it.iconSvg.trim();
          }
        }

        inv[key] = entry;
        pb[key] = { lastPaid: it.price, name: pretty };
        IZZA.emit?.('toast', {text:`Purchased ${pretty}`});
      }

      let handled=false;
      if(it.type==='armor' || it.slot){ addArmorPiece(it.slot||''); handled=true; }
      else if(typeof key === 'string' && key.startsWith('armor:')){
        const parts = key.split(':'); const piece = parts[2]||'';
        addArmorPiece(piece); handled=true;
      } else if (/\b(helmet|vest|arms|legs|head|chest)\b/i.test(pretty)) {
        addArmorPiece(''); handled=true;
      }

      if(!handled){
        const e = inv[key] || { count:0, name:pretty };
        e.count = (e.count|0) + 1;
        if (typeof e.iconSvg !== 'string' || !e.iconSvg) {
          if (typeof it.iconSvg === 'string' && it.iconSvg.trim()) {
            e.iconSvg = it.iconSvg.trim();
          }
        }
        inv[key] = e;
        pb[key] = { lastPaid: it.price, name: pretty };
        IZZA.emit?.('toast', {text:`Purchased ${pretty}`});
      }
    }

    api.setInventory && api.setInventory(inv);
    writePriceBook(pb);

    try{
      if(typeof window.renderInventoryPanel==='function'){ window.renderInventoryPanel(); }
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

  // Render inventory icons: inline <svg> OR data URL (as <img>)
  function iconForInv(key, entry){
    const raw = (entry && typeof entry.iconSvg === 'string') ? entry.iconSvg.trim() : '';
    if (raw){
      return iconImgHTMLFromAny(raw, 24, 24);
    }

    // Non-armour (weapons/consumables) keep their tiny icons when possible
    if (window.svgIcon) {
      const prettyId = (entry?.name || key || '').toLowerCase();
      const idGuess =
        /knuckle/.test(prettyId) ? 'knuckles' :
        /\bbat\b/.test(prettyId) ? 'bat' :
        /\buzi\b/.test(prettyId) ? 'uzi' :
        (/\bpistol\b/.test(prettyId) && !/ammo/.test(prettyId)) ? 'pistol' :
        /\bgrenade\b/.test(prettyId) ? 'grenade' : '';
      if (idGuess) return window.svgIcon(idGuess, 24, 24);
    }

    const id = guessLegacyIdFromName(entry?.name || key);
    if (id) return svgIcon(id,24,24);
    return '';
  }

  function renderSellList(qText){
    const modal = document.getElementById('shopModal'); if(!modal) return;
    const list = modal.querySelector('#shopSellList'); if(!list) return;

    let inv={}; try{ inv=api.getInventory? api.getInventory():{}; }catch{}
    const needle = (qText||'').toLowerCase();
    list.replaceChildren();

    Object.keys(inv).forEach(key=>{
      const e = inv[key]; if(!e) return;
      const count = (e.count|0) + (e.owned?1:0);
      if(count<=0) return;
      if(/jack_o_lantern|pumpkin_piece/i.test(key)) return;

      const pretty = e.name || key;
      if(needle && !pretty.toLowerCase().includes(needle)) return;

      const price  = getSellPrice(key);
      const row = document.createElement('div'); row.className='shop-item';
      const meta = document.createElement('div'); meta.className='meta';
      meta.innerHTML = `
        <div style="display:flex; align-items:center; gap:8px">
          <div data-icon>${iconForInv(key,e)}</div>
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
      row.appendChild(meta); row.appendChild(btn); list.appendChild(row);
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
        if(typeof inv[key].count==='number' && inv[key].count>0){
          inv[key].count -= 1;
          if(inv[key].count<=0 && !inv[key].owned) delete inv[key];
        } else if(inv[key].owned){
          inv[key].owned = false;
          if(!inv[key].count && !inv[key].equipped) delete inv[key];
        } else {
          delete inv[key];
        }
      }

      api.setInventory && api.setInventory(inv);
      writePriceBook(pb);

      const coins = api.getCoins ? api.getCoins() : (api.player?.coins|0);
      api.setCoins(coins + price);

      IZZA.toast?.(`Sold for ${price} IC`);
      try { if(typeof window.renderInventoryPanel==='function') window.renderInventoryPanel(); } catch{}
      try { window.dispatchEvent(new Event('izza-inventory-changed')); } catch {}
      try { window.dispatchEvent(new Event('izza-coins-changed')); } catch {}
    }catch(e){ console.warn('[shop] sell failed', e); }
  }

  // ---------- Legacy icon repair (BUY & SELL) ----------
  function repairMissingIconsIn(node){
    try{
      node.querySelectorAll('.meta').forEach(meta=>{
        const iconHolder = meta.querySelector('[data-icon]') || meta.querySelector(':scope > div:first-child');
        const nameEl     = meta.querySelector('.name');
        if(!iconHolder || !nameEl) return;

        const pretty = (nameEl.textContent||'').trim();
        const id = guessLegacyIdFromName(pretty);
        const html = (iconHolder.innerHTML||'').trim();

        // BROAD: replace if the holder doesn't already contain an <svg> or <img> or data: URL
        const looksBroken = !/(<svg|<img|data:image\/svg\+xml)/i.test(html);
        if(looksBroken && id){
          iconHolder.innerHTML = svgIcon(id,24,24);
        }
      });
    }catch(e){ console.warn('[store extender] icon repair failed:', e); }
  }

  function repairMissingIcons(){
    const modal = document.getElementById('shopModal'); if(!modal) return;
    const open = (modal.style.display === 'flex') || (getComputedStyle(modal).display === 'flex'); if(!open) return;
    const lists = [
      modal.querySelector('#shopBuyList') || document.getElementById('shopList'),
      modal.querySelector('#shopSellList')
    ].filter(Boolean);
    lists.forEach(repairMissingIconsIn);
  }

  // ---------- Stock patcher (BUY list) ----------
  function patchShopStock(){
    try{
      if(!api) return;
      const modal = document.getElementById('shopModal'); if(!modal) return;
      const open = (modal.style.display === 'flex') || (getComputedStyle(modal).display === 'flex'); if(!open) return;

      ensureTabs();

      const buyList = document.getElementById('shopBuyList') || document.getElementById('shopList');
      if(!buyList) return;

      if(!buyList.querySelector('[data-store-ext]')){
        // NEW: Bat & Knuckles from plugin (always visible)
        addShopRow(buyList, { id:'bat',       name:'Baseball Bat',   price:150, sub:'Heavy hits, light weight.' });
        addShopRow(buyList, { id:'knuckles',  name:'Brass Knuckles', price:200, sub:'Classic melee. Crowd pleaser.' });

        const missions = (api.getMissionCount && api.getMissionCount()) || 0;
        if(missions >= 3){
          addShopRow(buyList, { id:'uzi',          name:'Uzi (w/ +50 ammo)',       price:350, sub:'Compact SMG. +50 ammo.' });
          addShopRow(buyList, { id:'pistol_ammo',  name:'Pistol Ammo (17 rounds)', price:60,  sub:'Magazine refuel for pistol.' });
          addShopRow(buyList, { id:'grenade',      name:'Grenade',                 price:120, sub:'Area blast. One-time use.' });
        }
      }

      repairMissingIcons();
      const q=(document.getElementById('shopSearch')?.value||'').trim();
      if(q) filterBuyList(q);
    }catch(e){ console.warn('[store extender] patch failed:', e); }
  }

  // ---------- Inventory panel EXTENDER (no core edits) ----------
  let invPatched = false;
  function armorKeysAlreadyRendered(host){
    const keys=new Set();
    host.querySelectorAll('[data-armor-on],[data-armor-off]').forEach(btn=>{
      const id = btn.getAttribute('data-armor-on') || btn.getAttribute('data-armor-off');
      if(id) keys.add(id);
    });
    return keys;
  }

  function injectDynamicArmorRows(){
    const host = document.getElementById('invPanel'); if(!host) return;
    const body = host.querySelector('.inv-body'); if(!body) return;

    // remove our previous injection (if any)
    body.querySelectorAll('[data-dynarmor="1"]').forEach(n=>n.remove());

    let inv={}; try{ inv = api.getInventory? api.getInventory() : {}; }catch{}
    const already = armorKeysAlreadyRendered(body);

    // gather dynamic armor items
    const items = Object.entries(inv)
      .filter(([k,v])=> v && v.type==='armor' && (((v.count|0) + (v.owned?1:0))>0) && !already.has(k));

    if(!items.length) return;

    // ensure an "Armor" section header exists
    const hasHeader = Array.from(body.children).some(n=>/Armor/i.test(n.textContent||'') && n.tagName==='DIV' && n.style?.opacity);
    if(!hasHeader){
      const h = document.createElement('div');
      h.setAttribute('data-dynarmor','1');
      h.style.cssText='margin-top:2px;margin-bottom:-4px;opacity:.75;font-size:12px;padding-left:4px';
      h.textContent='Armor';
      body.appendChild(h);
    }

    // create rows
    items.forEach(([key,e])=>{
      const equipped = !!e.equipped;
      const slot = (e.slot||'').toLowerCase();
      const row = document.createElement('div');
      row.setAttribute('data-dynarmor','1');
      row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;background:#101626;border:1px solid #2a3550;border-radius:12px;padding:10px';

      const raw = (typeof e.iconSvg==='string' && e.iconSvg.trim()) || '';
      const iconHtml = iconImgHTMLFromAny(raw, 24, 24);

      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px">
          <div data-icon>${iconHtml}</div>
          <div>
            <div class="name">${e.name||key}</div>
            <div class="sub" style="opacity:.85">Count: ${(e.count|0)} · Slot: ${slot||'–'}${equipped?' · <b>Equipped</b>':''}</div>
          </div>
        </div>`;

      const btn = document.createElement('button');
      btn.className='ghost';
      btn.setAttribute(equipped ? 'data-armor-off' : 'data-armor-on', key);
      btn.setAttribute('data-slot', slot);
      btn.textContent = equipped ? 'Unequip' : 'Equip';

      row.appendChild(meta); row.appendChild(btn);
      body.appendChild(row);
    });

    // wire buttons like Core does
    body.querySelectorAll('[data-armor-on]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const id = btn.getAttribute('data-armor-on');
        const slot = btn.getAttribute('data-slot')||'';
        try{ window.setArmorEquipped(id, slot, true); }catch{}
        try{ if(typeof window.renderInventoryPanel==='function') window.renderInventoryPanel(); }catch{}
      }, {once:true});
    });
    body.querySelectorAll('[data-armor-off]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const id = btn.getAttribute('data-armor-off');
        const slot = btn.getAttribute('data-slot')||'';
        try{ window.setArmorEquipped(id, slot, false); }catch{}
        try{ if(typeof window.renderInventoryPanel==='function') window.renderInventoryPanel(); }catch{}
      }, {once:true});
    });

    // repair any missing icons inside inventory too
    repairMissingIconsIn(body);
  }

  function patchInventoryRendererOnce(){
    if(invPatched) return;
    if(typeof window.renderInventoryPanel!=='function') return; // wait until Core defines it
    invPatched = true;
    const orig = window.renderInventoryPanel;
    window.renderInventoryPanel = function(){
      try{ orig(); }catch(e){ console.warn('[inv-ext] core render failed?', e); }
      try{ injectDynamicArmorRows(); }catch(e){ console.warn('[inv-ext] inject failed', e); }
    };
    // render once on patch
    try{ window.renderInventoryPanel(); }catch{}
  }

  // ---------- boot ----------
  IZZA.on('ready', a=>{ api=a; });
  IZZA.on('render-post', ()=>{
    patchShopStock();
    patchInventoryRendererOnce();  // keep trying until core defined it
  });

  // keep inventory in sync on changes (buy/sell/craft/etc.)
  window.addEventListener('izza-inventory-changed', ()=>{
    try{ if(typeof window.renderInventoryPanel==='function') window.renderInventoryPanel(); }catch{}
  });
})();
