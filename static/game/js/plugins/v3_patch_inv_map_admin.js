// /static/game/js/plugins/v3_patch_inv_map_admin.js
(function(){
  const BUILD = 'v3.patch.inv-map-admin+uzi-grenade+m2-marker+fixes';
  console.log('[IZZA PATCH]', BUILD);

  // ---------- tiny helpers ----------
  function toast(msg, seconds=2.2){
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
    h.textContent = msg; h.style.display='block';
    clearTimeout(h._t); h._t=setTimeout(()=>{h.style.display='none';}, seconds*1000);
  }
  function waitForIZZA(){
    return new Promise(resolve=>{
      if(window.IZZA && IZZA.api){ return resolve(IZZA.api); }
      const done = ()=> resolve(IZZA.api || {});
      const iv = setInterval(()=>{ if(window.IZZA && IZZA.api){ clearInterval(iv); done(); } }, 30);
      const tryHook = setInterval(()=>{ try{ if(IZZA && IZZA.on){ clearInterval(tryHook); IZZA.on('ready', a=>resolve(a)); } }catch{} }, 30);
      setTimeout(()=>{ clearInterval(iv); clearInterval(tryHook); done(); }, 5000);
    });
  }

  // ---------- inv ↔ map exclusivity ----------
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
    if(btnMap)   btnMap.addEventListener('click', ()=>{ inv.style.display='none'; });
    if(miniWrap) miniWrap.addEventListener('click', ()=>{ inv.style.display='none'; });
  }

  // ---------- Uzi/Grenade rows (augment only; no equip logic yet) ----------
  function missionsOKToUse_local(id, getMissionCount){
    const m = (getMissionCount && getMissionCount()) || 0;
    if(id==='pistol')  return m>=3;
    if(id==='grenade') return m>=6;
    if(id==='uzi')     return m>=8;
    return true;
  }
  function ensureUziGrenadeRows(api){
    const host = document.getElementById('invPanel'); if(!host || host.style.display==='none') return;
    const body = host.querySelector('.inv-body'); if(!body) return;

    body.querySelectorAll('.inv-item.patch-row').forEach(n=>n.remove());
    const inv = (api.getInventory && api.getInventory()) || {};
    const mOK = id => missionsOKToUse_local(id, api.getMissionCount);

    function rowHTML(id, label, meta){
      const lock = mOK(id) ? '' :
        `<span style="margin-left:8px; font-size:12px; opacity:.8">Locked until mission ${id==='grenade'?6:id==='uzi'?8:3}</span>`;
      const icon = id==='uzi'
        ? '<svg viewBox="0 0 64 64" width="28" height="28"><rect x="12" y="28" width="34" height="8" fill="#0b0e14"/><rect x="36" y="22" width="8" height="6" fill="#0b0e14"/><rect x="30" y="36" width="6" height="12" fill="#0b0e14"/></svg>'
        : '<svg viewBox="0 0 64 64" width="28" height="28"><rect x="26" y="22" width="12" height="18" fill="#264a2b"/><rect x="22" y="26" width="20" height="10" fill="#5b7d61"/></svg>';
      return `
        <div class="inv-item patch-row" style="display:flex;align-items:center;gap:10px;padding:14px;background:#0f1522;border:1px solid #2a3550;border-radius:10px">
          <div style="width:28px;height:28px">${icon}</div>
          <div style="font-weight:600">${label}</div>
          ${lock}
          <div style="margin-left:12px;opacity:.85;font-size:12px">${meta}</div>
        </div>`;
    }

    const rows=[];
    if(inv.uzi && (inv.uzi.owned || (inv.uzi.ammo|0)>0)){
      rows.push(rowHTML('uzi','Uzi', `Ammo: ${inv.uzi.ammo|0 || 0} | Unlock: mission 8`));
    }
    if(inv.grenade && (inv.grenade.count|0)>0){
      rows.push(rowHTML('grenade','Grenade', `Count: ${inv.grenade.count|0} | Unlock: mission 6`));
    }
    if(rows.length){
      const frag=document.createElement('div'); frag.innerHTML=rows.join('');
      while(frag.firstChild) body.appendChild(frag.firstChild);
    }
  }
  function watchInventoryOpenToAugment(api){
    const host = document.getElementById('invPanel'); if(!host) return;
    const mo = new MutationObserver(()=>{ if(host.style.display!=='none') ensureUziGrenadeRows(api); });
    mo.observe(host, { attributes:true, attributeFilter:['style'] });
    if(window.IZZA && IZZA.on){
      IZZA.on('inventory-changed', ()=>{ if(host.style.display!=='none') ensureUziGrenadeRows(api); });
    }
  }

  // ---------- admin buttons ----------
  function installAdminButtons(api){
    if(!/CamMac/i.test((window.__IZZA_PROFILE__ && window.__IZZA_PROFILE__.username) || '')) return;

    function pill(label, onclick){
      const b=document.createElement('button');
      b.textContent=label;
      Object.assign(b.style,{
        position:'fixed', top:'54px', background:'#1b2437', color:'#cfe0ff',
        border:'1px solid #394769', padding:'6px 10px', borderRadius:'10px',
        zIndex:9999, opacity:.92
      });
      b.onclick=onclick;
      return b;
    }

    const p1=pill('Dev: Reset → M1', ()=>{
      try{
        localStorage.removeItem('izzaMission1');
        localStorage.setItem('izzaMissions','1');
        toast('Missions set to 1 (M1 complete).');
      }catch(e){ console.error(e); }
    });
    p1.style.left='160px';

    const p2=pill('Dev: Full Reset', ()=>{
      try{
        localStorage.removeItem('izzaMission1');
        localStorage.removeItem('izzaMissions');
        localStorage.removeItem('izzaInventory');
        localStorage.setItem('izzaCoins','50');
        toast('All progress cleared. Coins set to 50.');
        api.setCoins && api.setCoins(50);
      }catch(e){ console.error(e); }
    });
    p2.style.left='300px';

    const p3=pill('+300 IC', ()=>{
      try{
        const n=(api.getCoins&&api.getCoins())||0;
        api.setCoins && api.setCoins(n+300);
        toast('+300 IC');
      }catch(e){ console.error(e); }
    });
    p3.style.left='430px';

    document.body.appendChild(p1);
    document.body.appendChild(p2);
    document.body.appendChild(p3);
  }

  // ---------- Mission-2 marker overlay ----------
  function addM2MarkerOverlay(api){
    if(!window.IZZA || !IZZA.on) return;

    // Re-derive the same cashier tile as core uses
    const unlocked={x0:18,y0:18,x1:72,y1:42};
    const bW=10,bH=6;
    const bX = Math.floor((unlocked.x0+unlocked.x1)/2) - Math.floor(bW/2);
    const bY = unlocked.y0 + 5;
    const hRoadY       = bY + bH + 1;
    const sidewalkTopY = hRoadY - 1;
    const vRoadX       = Math.min(unlocked.x1-3, bX + bW + 6);
    const vSidewalkRightX = vRoadX + 1;
    const regGX = vSidewalkRightX, regGY = sidewalkTopY;

    const TILE=api.TILE, DRAW=api.DRAW, cam=api.camera;

    function nearRegister(px,py){
      const gx = Math.floor((px + TILE/2)/TILE);
      const gy = Math.floor((py + TILE/2)/TILE);
      return (Math.abs(gx-regGX)+Math.abs(gy-regGY))<=1;
    }

    function hidePrompt(){
      const p=document.getElementById('m2Prompt');
      if(p) p.style.display='none';
    }

    IZZA.on('render-post', ()=>{
      try{
        const mc=(api.getMissionCount&&api.getMissionCount())||0;
        if(mc!==1){ hidePrompt(); return; }

        const cvs=document.getElementById('game'); if(!cvs) return;
        const ctx=cvs.getContext('2d'); if(!ctx) return;

        const sx=(regGX*TILE - cam.x) * (DRAW/TILE);
        const sy=(regGY*TILE - cam.y) * (DRAW/TILE);

        // pulse
        const t=performance.now()*0.004;
        const a=0.45 + 0.3*(0.5 + 0.5*Math.sin(t));

        // glow + border to make it obvious on mobile
        ctx.save();
        ctx.fillStyle=`rgba(80,160,255,${a*0.6})`;
        ctx.fillRect(sx+DRAW*0.18, sy+DRAW*0.18, DRAW*0.64, DRAW*0.64);
        ctx.lineWidth=3;
        ctx.strokeStyle=`rgba(136,168,255,${Math.min(1,a+0.2)})`;
        ctx.strokeRect(sx+DRAW*0.18, sy+DRAW*0.18, DRAW*0.64, DRAW*0.64);
        ctx.restore();

        // proximity prompt
        if(nearRegister(api.player.x, api.player.y)){
          let prompt=document.getElementById('m2Prompt');
          if(!prompt){
            prompt=document.createElement('div');
            prompt.id='m2Prompt';
            Object.assign(prompt.style,{
              position:'absolute', transform:'translate(-50%,-120%)',
              padding:'4px 8px', fontSize:'12px',
              background:'#0b0f17', border:'1px solid #263042',
              borderRadius:'8px', pointerEvents:'none', zIndex:3
            });
            const card=document.getElementById('gameCard');
            card && card.appendChild(prompt);
          }
          prompt.textContent='Press B: Mission 2';
          prompt.style.left = (sx + DRAW/2) + 'px';
          prompt.style.top  = (sy) + 'px';
          prompt.style.display='block';
        }else{
          hidePrompt();
        }
      }catch(e){ console.error('[M2 marker]', e); }
    });

    // Also hide prompt when inventory or map opens
    const inv=document.getElementById('invPanel');
    const mapModal=document.getElementById('mapModal');
    if(inv){
      new MutationObserver(()=>{ if(inv.style.display!=='none') hidePrompt(); })
        .observe(inv,{attributes:true,attributeFilter:['style']});
    }
    if(mapModal){
      new MutationObserver(()=>{ if(mapModal.style.display!=='none') hidePrompt(); })
        .observe(mapModal,{attributes:true,attributeFilter:['style']});
    }
  }

  // ---------- boot ----------
  (async function boot(){
    const api = await waitForIZZA();
    enforceInvMapExclusivity();
    watchInventoryOpenToAugment(api);
    installAdminButtons(api);
    addM2MarkerOverlay(api);
  })();

})();
