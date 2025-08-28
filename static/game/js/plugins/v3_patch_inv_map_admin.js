// /static/game/js/plugins/v3_patch_inv_map_admin.js
(function(){
  const BUILD = 'v3.patch.inv-map-admin+uzi-grenade-rows.v2';
  console.log('[IZZA PATCH]', BUILD);

  // ---------- tiny toast ----------
  function toast(msg, seconds=2.2){
    try{
      let h = document.getElementById('tutHint');
      if(!h){
        h=document.createElement('div');
        h.id='tutHint';
        Object.assign(h.style,{
          position:'fixed', left:'12px', top:'64px', zIndex:9999,
          background:'rgba(10,12,18,.85)', border:'1px solid #394769',
          color:'#cfe0ff', padding:'8px 10px', borderRadius:'10px', fontSize:'14px'
        });
        document.body.appendChild(h);
      }
      h.textContent=msg; h.style.display='block';
      clearTimeout(h._t); h._t=setTimeout(()=>{h.style.display='none';}, seconds*1000);
    }catch(_e){}
  }

  // ---------- IZZA wait ----------
  function waitForIZZA(){
    return new Promise(resolve=>{
      if(window.IZZA && IZZA.api){ resolve(IZZA.api); return; }
      const done = ()=> resolve((window.IZZA && IZZA.api) || {});
      const watch = setInterval(()=>{
        if(window.IZZA && (IZZA.api||IZZA.on)){ clearInterval(watch); done(); }
      }, 50);
      setTimeout(()=>{ clearInterval(watch); done(); }, 5000);
      try{ if(window.IZZA && IZZA.on){ IZZA.on('ready', api=>resolve(api)); } }catch(_e){}
    });
  }

  // ---------- inventory/map exclusivity ----------
  function enforceInvMapExclusivity(){
    const inv = document.getElementById('invPanel');
    const miniWrap = document.getElementById('miniWrap');
    const mapModal = document.getElementById('mapModal');
    const btnMap   = document.getElementById('btnMap');
    if(!inv) return;

    const mo = new MutationObserver(()=>{
      const open = inv.style.display!=='none';
      if(open){
        if(miniWrap) miniWrap.style.display='none';
        if(mapModal) mapModal.style.display='none';
      }
    });
    mo.observe(inv, { attributes:true, attributeFilter:['style'] });

    if(btnMap)   btnMap.addEventListener('click',   ()=>{ inv.style.display='none'; });
    if(miniWrap) miniWrap.addEventListener('click', ()=>{ inv.style.display='none'; });
  }

  // ---------- uzi/grenade rows (read-only display) ----------
  function missionsOKToUse_local(id, getMissionCount){
    const m = (getMissionCount && getMissionCount()) || 0;
    if(id==='pistol')  return m>=3;
    if(id==='grenade') return m>=6;
    if(id==='uzi')     return m>=8;
    return true;
  }

  function ensureUziGrenadeRows(api){
    const host = document.getElementById('invPanel');
    if(!host || host.style.display==='none') return;
    const body = host.querySelector('.inv-body'); if(!body) return;

    // clear old patch rows
    body.querySelectorAll('.inv-item.patch-row').forEach(n=>n.remove());

    const inv = (api.getInventory && api.getInventory()) || {};
    const ok  = (id)=> missionsOKToUse_local(id, api.getMissionCount);

    const rowHTML = (id, label, meta)=>`
      <div class="inv-item patch-row" style="display:flex;align-items:center;gap:10px;padding:14px;background:#0f1522;border:1px solid #2a3550;border-radius:10px">
        <div style="width:28px;height:28px">${id==='uzi'
          ? '<svg viewBox="0 0 64 64" width="28" height="28"><rect x="12" y="28" width="34" height="8" fill="#0b0e14"/><rect x="36" y="22" width="8" height="6" fill="#0b0e14"/><rect x="30" y="36" width="6" height="12" fill="#0b0e14"/></svg>'
          : '<svg viewBox="0 0 64 64" width="28" height="28"><rect x="26" y="22" width="12" height="18" fill="#264a2b"/><rect x="22" y="26" width="20" height="10" fill="#5b7d61"/></svg>'
        }</div>
        <div style="font-weight:600">${label}</div>
        ${ok(id) ? '' : `<span style="margin-left:8px; font-size:12px; opacity:.8">Locked until mission ${id==='grenade'?6:id==='uzi'?8:3}</span>`}
        <div style="margin-left:12px;opacity:.85;font-size:12px">${meta}</div>
      </div>`;

    const rows = [];
    if(inv.uzi && (inv.uzi.owned || (inv.uzi.ammo|0)>0)){
      rows.push(rowHTML('uzi','Uzi', `Ammo: ${inv.uzi.ammo|0 || 0} | Unlock: mission 8`));
    }
    if(inv.grenade && (inv.grenade.count|0)>0){
      rows.push(rowHTML('grenade','Grenade', `Count: ${inv.grenade.count|0} | Unlock: mission 6`));
    }

    if(rows.length){
      const frag = document.createElement('div'); frag.innerHTML = rows.join('');
      while(frag.firstChild) body.appendChild(frag.firstChild);
    }
  }

  function watchInventoryOpenToAugment(api){
    const host = document.getElementById('invPanel'); if(!host) return;
    const mo = new MutationObserver(()=>{ if(host.style.display!=='none') ensureUziGrenadeRows(api); });
    mo.observe(host, { attributes:true, attributeFilter:['style'] });
  }

  function wireInventoryRefreshOnLoot(api){
    if(!window.IZZA || !IZZA.on) return;
    IZZA.on('inventory-changed', ()=>{
      const inv = document.getElementById('invPanel');
      if(inv && inv.style.display!=='none') ensureUziGrenadeRows(api);
    });
  }

  // ---------- ADMIN: show button if CamMac OR ?admin=1 OR localStorage flag ----------
  function isAdmin(){
    try{
      const byQuery = /[?&]admin=1(?:&|$)/i.test(location.search);
      const prof = (window.__IZZA_PROFILE__ || {});
      const byName = !!(prof && typeof prof.username==='string' && /^cammac$/i.test(prof.username));
      const byLS = localStorage.getItem('izzaAdmin') === '1';
      if(byQuery) localStorage.setItem('izzaAdmin','1'); // persist
      return byQuery || byName || byLS;
    }catch(_e){ return false; }
  }

  function addAdminButtons(api){
    if(!isAdmin()) return;

    const wrap = document.createElement('div');
    Object.assign(wrap.style,{
      position:'fixed', right:'8px', top:'48px', zIndex:9999, display:'flex', gap:'6px'
    });

    function mkBtn(label, onclick){
      const b=document.createElement('button');
      b.textContent=label;
      Object.assign(b.style,{
        background:'#1b2437', color:'#cfe0ff', border:'1px solid #394769',
        padding:'6px 10px', borderRadius:'8px', opacity:.9
      });
      b.onclick = onclick;
      return b;
    }

    // Reset to Mission 1 (keep tutorial done)
    const bM1 = mkBtn('Dev: Reset → M1', ()=>{
      try{
        localStorage.setItem('izzaMission1','done'); // keep tutorial unlocked
        localStorage.setItem('izzaMissions','1');     // missions completed = 1
        localStorage.removeItem('izzaMission2');      // if any legacy flag existed
        toast('Dev: Missions set to 1 (tutorial done).');
      }catch(_e){}
    });

    // Full reset (everything fresh)
    const bFresh = mkBtn('Dev: Full Reset', ()=>{
      try{
        localStorage.removeItem('izzaMission1');
        localStorage.removeItem('izzaMissions');
        localStorage.removeItem('izzaMission2');
        localStorage.removeItem('izzaInventory');
        // (Optional) coins back to 0
        localStorage.setItem('izzaCoins','0');
        toast('Dev: Full reset complete.');
      }catch(_e){}
    });

    // Coins helper (quick buy testing)
    const bCoins = mkBtn('+300 IC', ()=>{
      try{
        const n = parseInt(localStorage.getItem('izzaCoins')||'0',10);
        localStorage.setItem('izzaCoins', String(n+300));
        if(api && api.setCoins && api.getCoins) api.setCoins(api.getCoins()+300);
        toast('Dev: +300 coins.');
      }catch(_e){}
    });

    wrap.appendChild(bM1);
    wrap.appendChild(bFresh);
    wrap.appendChild(bCoins);
    document.body.appendChild(wrap);
  }

  // ---------- boot ----------
  (async function boot(){
    const api = await waitForIZZA();
    enforceInvMapExclusivity();
    watchInventoryOpenToAugment(api);
    wireInventoryRefreshOnLoot(api);
    addAdminButtons(api);
  })();

})();
