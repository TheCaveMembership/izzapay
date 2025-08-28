// /static/game/js/plugins/v3_patch_inv_map_admin.js
(function(){
  const BUILD = 'v3.patch.inv-map-admin+uzi-grenade-rows.safe';
  console.log('[IZZA PATCH]', BUILD);

  // ---------- guards ----------
  function toast(msg, seconds=2.2){
    try{
      let h = document.getElementById('tutHint');
      if(!h){
        h=document.createElement('div');
        h.id='tutHint';
        Object.assign(h.style,{
          position:'fixed', left:'12px', top:'64px', zIndex:7,
          background:'rgba(10,12,18,.85)', border:'1px solid #394769',
          color:'#cfe0ff', padding:'8px 10px', borderRadius:'10px', fontSize:'14px'
        });
        document.body.appendChild(h);
      }
      h.textContent=msg; h.style.display='block';
      clearTimeout(h._t); h._t=setTimeout(()=>{h.style.display='none';}, seconds*1000);
    }catch(_e){}
  }

  // Wait until IZZA is available, then resolve with api
  function waitForIZZA(){
    return new Promise(resolve=>{
      const done=()=> resolve(window.IZZA && IZZA.api ? IZZA.api : (window.IZZA||{}));
      if(window.IZZA && IZZA.api){ return done(); }
      const iv = setInterval(()=>{
        if(window.IZZA && (IZZA.api||IZZA.on)){ clearInterval(iv); done(); }
      }, 50);
      // also listen to “ready” if available later
      const hook = ()=>{
        try{ if(window.IZZA && IZZA.api){ resolve(IZZA.api); } }catch(_e){}
      };
      document.addEventListener('DOMContentLoaded', hook, { once:true });
      // If IZZA.hooks becomes available later, attach dynamically
      const watcher = setInterval(()=>{
        try{
          if(window.IZZA && typeof IZZA.on==='function'){
            clearInterval(watcher);
            IZZA.on('ready', api=> resolve(api));
          }
        }catch(_e){}
      }, 50);
      setTimeout(()=>{ clearInterval(iv); clearInterval(watcher); done(); }, 5000); // give up gracefully
    });
  }

  // ---------- features ----------
  function enforceInvMapExclusivity(){
    const inv = document.getElementById('invPanel');
    const miniWrap = document.getElementById('miniWrap');
    const mapModal = document.getElementById('mapModal');
    const btnMap   = document.getElementById('btnMap');
    if(!inv) return;

    // close maps when inventory opens
    const invObs = new MutationObserver(()=> {
      try{
        const open = inv.style.display!=='none';
        if(open){
          if(miniWrap) miniWrap.style.display='none';
          if(mapModal) mapModal.style.display='none';
        }
      }catch(_e){}
    });
    invObs.observe(inv, { attributes:true, attributeFilter:['style'] });

    // close inventory when user toggles map
    if(btnMap){
      btnMap.addEventListener('click', ()=>{ try{ inv.style.display='none'; }catch(_e){}; });
    }
    if(miniWrap){
      miniWrap.addEventListener('click', ()=>{ try{ inv.style.display='none'; }catch(_e){}; });
    }
  }

  function missionsOKToUse_local(id, getMissionCount){
    const m = (getMissionCount && getMissionCount()) || 0;
    if(id==='pistol')  return m>=3;
    if(id==='grenade') return m>=6;
    if(id==='uzi')     return m>=8;
    return true;
  }

  function ensureUziGrenadeRows(api){
    try{
      const host = document.getElementById('invPanel');
      if(!host || host.style.display==='none') return;
      const body = host.querySelector('.inv-body');
      if(!body) return;

      // remove previous patch rows
      body.querySelectorAll('.inv-item.patch-row').forEach(n=>n.remove());

      const inv = (api.getInventory && api.getInventory()) || {};
      const mOK = (id)=> missionsOKToUse_local(id, api.getMissionCount);

      function rowHTML(id, label, meta){
        const lock = mOK(id) ? '' :
          `<span style="margin-left:8px; font-size:12px; opacity:.8">Locked until mission ${id==='grenade'?6:id==='uzi'?8:3}</span>`;
        return `
          <div class="inv-item patch-row" style="display:flex;align-items:center;gap:10px;padding:14px;background:#0f1522;border:1px solid #2a3550;border-radius:10px">
            <div style="width:28px;height:28px">${id==='uzi'
              ? '<svg viewBox="0 0 64 64" width="28" height="28"><rect x="12" y="28" width="34" height="8" fill="#0b0e14"/><rect x="36" y="22" width="8" height="6" fill="#0b0e14"/><rect x="30" y="36" width="6" height="12" fill="#0b0e14"/></svg>'
              : '<svg viewBox="0 0 64 64" width="28" height="28"><rect x="26" y="22" width="12" height="18" fill="#264a2b"/><rect x="22" y="26" width="20" height="10" fill="#5b7d61"/></svg>'
            }</div>
            <div style="font-weight:600">${label}</div>
            ${lock}
            <div style="margin-left:12px;opacity:.85;font-size:12px">${meta}</div>
          </div>`;
      }

      const rows = [];
      if(inv.uzi && (inv.uzi.owned || (inv.uzi.ammo|0)>0)){
        rows.push(rowHTML('uzi','Uzi', `Ammo: ${inv.uzi.ammo|0 || 0} | Unlock: mission 8`));
      }
      if(inv.grenade && (inv.grenade.count|0)>0){
        rows.push(rowHTML('grenade','Grenade', `Count: ${inv.grenade.count|0} | Unlock: mission 6`));
      }
      if(rows.length){
        const frag = document.createElement('div');
        frag.innerHTML = rows.join('');
        while(frag.firstChild) body.appendChild(frag.firstChild);
      }
    }catch(_e){}
  }

  function watchInventoryOpenToAugment(api){
    const host = document.getElementById('invPanel');
    if(!host) return;
    const mo = new MutationObserver(()=> {
      try{
        if(host.style.display!=='none') ensureUziGrenadeRows(api);
      }catch(_e){}
    });
    mo.observe(host, { attributes:true, attributeFilter:['style'] });
  }

  function wireInventoryRefreshOnLoot(api){
    if(!window.IZZA || !IZZA.on) return;
    IZZA.on('inventory-changed', ()=>{
      const inv = document.getElementById('invPanel');
      if(inv && inv.style.display!=='none') ensureUziGrenadeRows(api);
    });
  }

  function addAdminReset(){
    try{
      if(!/[?&]admin=1(?:&|$)/.test(location.search)) return;
      const b=document.createElement('button');
      b.textContent='Dev: Reset M2';
      Object.assign(b.style,{
        position:'fixed', right:'8px', top:'48px', zIndex:9999,
        background:'#1b2437', color:'#cfe0ff', border:'1px solid #394769',
        padding:'6px 10px', borderRadius:'8px', opacity:.85
      });
      b.onclick = ()=>{
        try{
          localStorage.removeItem('izzaMission2');
          const n = parseInt(localStorage.getItem('izzaMissions')||'0',10);
          if(n>=2) localStorage.setItem('izzaMissions','1');
          toast('Dev: Mission 2 reset (missions=1).');
        }catch(_e){}
      };
      document.body.appendChild(b);
    }catch(_e){}
  }

  // ---------- boot ----------
  (async function boot(){
    try{
      const api = await waitForIZZA(); // safe no matter load order
      enforceInvMapExclusivity();
      watchInventoryOpenToAugment(api);
      wireInventoryRefreshOnLoot(api);
      addAdminReset();
      // (optional) Unequip button still needs api.setEquipped exposure from core
    }catch(err){
      console.error('[IZZA PATCH] boot error', err);
    }
  })();

})();
