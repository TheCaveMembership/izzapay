// mission6_skyline_circuit_plugin.js — Mission 6: SKYLINE CIRCUIT
// A city journey that ends at Armoury Island to craft a special set.
// Self-contained: checks player position, uses LS flags, grants components,
// and registers a dynamic Armoury recipe ("Volt Runner Set").
//
// Flow:
//   1) Start: Visit the Bank door (downtown gold block).
//   2) Checkpoint: Hotel lot walkway.
//   3) Checkpoint: Lake docks.
//   4) Finale: North-east lake edge.
//   Then: head to Armoury Island and craft the Volt Runner set from granted parts.
// --------------------------------------------------------------------------------
(function(){
  const BUILD = 'mission6/skyline-circuit/v1';
  console.log('[IZZA PLAY]', BUILD);

  const LS = {
    stage: 'izzaM6Stage',      // '0'..'done'
    given: 'izzaM6GivenParts'  // set once to avoid dupes
  };

  function _stage(){ return parseInt(localStorage.getItem(LS.stage)||'0',10)||0; }
  function _setStage(n){ localStorage.setItem(LS.stage, String(n)); try{ window.dispatchEvent(new Event('izza-missions-changed')); }catch{} }

  // --- Waypoints (grid coords, tolerant radius)
  // Using your known anchors + lakeRects for robust placement
  function _pts(){
    const api = IZZA.api; if(!api?.ready) return null;
    const A = (function anchorsLite(){
      const tier = localStorage.getItem('izzaMapTier')||'1';
      const un = (tier!=='2') ? {x0:18,y0:18,x1:72,y1:42} : {x0:10,y0:12,x1:80,y1:50};
      const bW=10,bH=6;
      const bX = Math.floor((un.x0+un.x1)/2) - Math.floor(bW/2);
      const bY = un.y0 + 5;
      const hRoadY = bY + bH + 1;
      const vRoadX = Math.min(un.x1-3, bX + bW + 6);
      const door = { gx: bX + Math.floor(bW/2), gy: hRoadY - 1 }; // HQ door
      return {un, door, hRoadY, vRoadX};
    })();

    const bankDoor = (function(){
      // from your bank placement: 5 east, 9 north from hospital door (34,35) -> (39,26)? (we rely on published __IZZA_BANK__)
      const d = window.__IZZA_BANK__?.door || {x:39,y:26};
      return d;
    })();

    // lake helper (matches your expander)
    function lakeRects(a){
      const LAKE = { x0: a.un.x1-14, y0: a.un.y0+23, x1: a.un.x1, y1: a.un.y1 };
      const BEACH_X = LAKE.x0 - 1;
      const DOCKS = [
        { x0: BEACH_X, y: LAKE.y0+4,  len: 4 },
        { x0: BEACH_X, y: LAKE.y0+12, len: 5 }
      ];
      return {LAKE, BEACH_X, DOCKS};
    }
    const {LAKE, DOCKS} = lakeRects(A);

    // checkpoints
    return {
      bank: bankDoor,                           // 1) bank
      hotelWalk: { x: LAKE.x0-3, y: LAKE.y0-6}, // 2) hotel lot area
      docks: { x: DOCKS[0].x0+2, y: DOCKS[0].y }, // 3) docks
      lakeNE: { x: LAKE.x1-1, y: LAKE.y0+1 }   // 4) NE lake rim
    };
  }

  function near(gx,gy,pt,rad=2){ return Math.abs(gx-pt.x)<=rad && Math.abs(gy-pt.y)<=rad; }

  function tickMission(){
    const api=IZZA.api; if(!api?.ready) return;
    const p=api.player, t=api.TILE, gx=((p.x+16)/t|0), gy=((p.y+16)/t|0);
    const P=_pts(); if(!P) return;
    let s=_stage();

    if(s===0 && near(gx,gy,P.bank,2)){ IZZA.toast?.('Mission 6: Skyline Circuit — Checkpoint 1 ✓'); _setStage(1); }
    else if(s===1 && near(gx,gy,P.hotelWalk,3)){ IZZA.toast?.('Checkpoint 2 ✓'); _setStage(2); }
    else if(s===2 && near(gx,gy,P.docks,2)){ IZZA.toast?.('Checkpoint 3 ✓'); _setStage(3); }
    else if(s===3 && near(gx,gy,P.lakeNE,3)){ 
      IZZA.toast?.('Final checkpoint ✓ — Head to Armoury Island to craft your reward!');
      _grantCraftPartsOnce();
      _setStage(4);
      // optional congrats popup
      try {
        const ev = new CustomEvent('mission-complete', { detail:{ id:6 }});
        window.dispatchEvent(ev);
        IZZA.emit?.('mission-complete', { id: 6 });
      } catch {}
    }
  }

  function _grantCraftPartsOnce(){
    if(localStorage.getItem(LS.given)==='1') return;
    const inv = (function(){ try{
      if(IZZA?.api?.getInventory) return JSON.parse(JSON.stringify(IZZA.api.getInventory()||{}));
      const raw=localStorage.getItem('izzaInventory'); return raw? JSON.parse(raw) : {};
    }catch{ return {}; } })();

    // Components for Volt Runner set
    inv.neon_filament = inv.neon_filament || { name:'Neon Filament', count:0 };
    inv.neon_filament.count = (inv.neon_filament.count|0) + 3;

    inv.vault_core = inv.vault_core || { name:'Vault Core', count:0 };
    inv.vault_core.count = (inv.vault_core.count|0) + 1;

    try{
      if(IZZA?.api?.setInventory) IZZA.api.setInventory(inv);
      else localStorage.setItem('izzaInventory', JSON.stringify(inv));
    }catch{}
    localStorage.setItem(LS.given, '1');
    IZZA.toast?.('Received: 3× Neon Filament, 1× Vault Core — Craft at Armoury Island');
    try{ window.dispatchEvent(new Event('izza-inventory-changed')); }catch{}
  }

  // ---- Armoury Recipe: Volt Runner (animated, eyes + leg flames)
  (function registerVoltRunner(){
    const ID='m6_volt_runner';

    function count(inv, key){ return (inv?.[key]?.count|0) || (typeof inv?.[key]==='number' ? (inv[key]|0) : 0); }
    function take(inv, key, n){
      if(!n) return;
      if(inv[key] && typeof inv[key].count==='number'){
        inv[key].count = Math.max(0, (inv[key].count|0)-n);
      }else if(typeof inv[key]==='number'){
        inv[key] = Math.max(0, (inv[key]|0)-n);
      }
    }
    function need(inv){
      return count(inv,'vault_core')>=1 && count(inv,'neon_filament')>=3;
    }
    function craft(){
      const inv = (function(){ try{
        if(IZZA?.api?.getInventory) return JSON.parse(JSON.stringify(IZZA.api.getInventory()||{}));
        const raw=localStorage.getItem('izzaInventory'); return raw? JSON.parse(raw) : {};
      }catch{ return {}; } })();

      take(inv,'vault_core',1); let need3=3;
      const f1=Math.min(need3, count(inv,'neon_filament')); if(f1){ take(inv,'neon_filament', f1); need3-=f1; }

      // Grant the 4-piece Volt Runner set (neon cyber-knight vibe)
      function ensureItem(key, pretty, slot, svg){
        inv[key]=inv[key]||{ count:0, name:pretty, type:'armor', slot, equippable:true, iconSvg:svg };
        inv[key].name=pretty; inv[key].type='armor'; inv[key].slot=slot; inv[key].equippable=true;
        if(!inv[key].iconSvg) inv[key].iconSvg=svg;
        inv[key].count=(inv[key].count|0)+1;
      }
      const c = { base:'#1b1f2e', shade:'#101423', trim:'#00e1ff', glow:'#00f0ff' };
      const icon = (slot)=>`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
        <rect x="2" y="2" width="20" height="20" rx="4" fill="${c.shade}"/>
        <rect x="3" y="3" width="18" height="18" rx="4" fill="${c.base}"/>
        <rect x="6" y="${slot==='legs'?12:10}" width="12" height="2" fill="${c.trim}"/>
      </svg>`;

      ensureItem('volt_runner_helmet','Volt Runner Helmet','head',  icon('head'));
      ensureItem('volt_runner_vest',  'Volt Runner Vest',  'chest', icon('chest'));
      ensureItem('volt_runner_legs',  'Volt Runner Legs',  'legs',  icon('legs'));
      ensureItem('volt_runner_arms',  'Volt Runner Arms',  'arms',  icon('arms'));

      try{
        if(IZZA?.api?.setInventory) IZZA.api.setInventory(inv);
        else localStorage.setItem('izzaInventory', JSON.stringify(inv));
      }catch{}
      try{ window.dispatchEvent(new Event('izza-inventory-changed')); }catch{}
      IZZA.toast?.('Crafted: Volt Runner Set');
      try{ IZZA?.emit?.('mission-complete', { id: 6 }); }catch{}
    }

    // Register dynamic recipe with your live system
    try {
      IZZA.api = IZZA.api || {}; IZZA.api.armoury = IZZA.api.armoury || {};
      IZZA.api.armoury.registerRecipe?.({
        id: ID,
        label: 'Volt Runner (Set)',
        buttonText: 'Craft from 1× Vault Core + 3× Neon Filament',
        disabledText: 'Need 1 Core + 3 Filament',
        need, craft
      });
    } catch {}
  })();

  // ---- Overlay for Volt Runner (eyes & leg jets) ----
  (function voltRunnerOverlay(){
    const c={ base:'#1b1f2e', shade:'#101423', trim:'#00e1ff', glow:'#00f0ff' };
    const FL = new Path2D("M0,-9 C3,-6 3,-1 0,7 C-3,-1 -3,-6 0,-9 Z");
    function drawPieceWorld(ctx, px, py, scale, ox, oy, fn){
      const api=IZZA.api, S=api.DRAW, T=api.TILE;
      const sx=(px- api.camera.x)*(S/T), sy=(py- api.camera.y)*(S/T);
      ctx.save(); ctx.imageSmoothingEnabled=false;
      ctx.translate(Math.round(sx)+S*0.5, Math.round(sy)+S*0.5);
      ctx.scale(scale, scale); ctx.translate(ox, oy); fn(ctx); ctx.restore();
    }
    function helm(ctx){
      ctx.fillStyle=c.base; ctx.beginPath();
      ctx.moveTo(-12,2); ctx.quadraticCurveTo(0,-11,12,2); ctx.lineTo(12,7); ctx.lineTo(-12,7); ctx.closePath(); ctx.fill();
      // visor band
      ctx.fillStyle=c.trim; ctx.fillRect(-11,5,22,2.5);
      // neon eyes pulse
      const t=(performance.now?.()||Date.now())*0.001, pulse=0.85+0.15*(0.5+0.5*Math.sin(t*2.4));
      ctx.fillStyle=c.glow; ctx.globalAlpha=0.9;
      ctx.beginPath(); ctx.ellipse(-5.2,7.5,1.6*pulse,1.1*pulse,0,0,Math.PI*2); ctx.fill();
      ctx.beginPath(); ctx.ellipse( 5.2,7.5,1.6*pulse,1.1*pulse,0,0,Math.PI*2); ctx.fill();
      ctx.globalAlpha=1;
    }
    function vest(ctx){
      ctx.fillStyle=c.base; ctx.fillRect(-12,-8,24,16);
      ctx.fillStyle=c.shade; ctx.fillRect(-10,-3,20,6);
      ctx.fillStyle=c.trim; ctx.fillRect(-3,-10,6,2);
    }
    function arms(ctx){
      ctx.fillStyle=c.base;
      ctx.fillRect(-16,-4,7,11); ctx.fillRect(9,-4,7,11);
      ctx.fillStyle=c.trim; ctx.fillRect(-13,-1,3,2); ctx.fillRect(12,-1,3,2);
    }
    function legs(ctx){
      ctx.fillStyle=c.base; ctx.fillRect(-8,0,7,14); ctx.fillRect(1,0,7,14);
      ctx.fillStyle=c.shade; ctx.fillRect(-8,4,16,3);
      // jets
      const p=IZZA.api.player||{}, moving=!!p.moving, tt=((p.animTime||0)*0.02);
      const target=moving?1:0; legs._a=(legs._a||0)+(target-(legs._a||0))*0.18;
      if((legs._a||0)<0.02) return;
      const power=0.85+0.2*Math.sin(tt*18); const gOff=0.15*Math.sin(tt*12);
      ctx.save(); ctx.globalAlpha*=legs._a||0;
      [-5,5].forEach(fx=>{
        ctx.save(); ctx.translate(fx,13.2+gOff); ctx.scale(0.7, power);
        const g=ctx.createLinearGradient(0,-7,0,6);
        g.addColorStop(0,"#e7fbff"); g.addColorStop(0.35,"#9af8ff"); g.addColorStop(0.7,c.glow); g.addColorStop(1,"rgba(0,220,255,0.85)");
        ctx.fillStyle=g; ctx.fill(FL);
        ctx.restore();
      });
      ctx.restore();
    }

    IZZA.on?.('render-post', ()=>{
      if(!IZZA?.api?.ready) return;
      const inv=(function(){ try{
        if(IZZA?.api?.getInventory) return JSON.parse(JSON.stringify(IZZA.api.getInventory()||{}));
        const raw=localStorage.getItem('izzaInventory'); return raw? JSON.parse(raw) : {};
      }catch{ return {}; } })();
      const on = key => !!(inv?.[key] && (inv[key].equipped||inv[key].equip||inv[key].equippedCount>0));
      const any = on('volt_runner_helmet')||on('volt_runner_vest')||on('volt_runner_legs')||on('volt_runner_arms');
      if(!any) return;

      const p=IZZA.api.player, px=p.x, py=p.y, f=p.facing||'down';
      const facingShift = { down:{x:0,y:0}, up:{x:0,y:-1}, left:{x:-1.5,y:0}, right:{x:1.5,y:0} }[f];
      const HELMET={ scale:2.80, ox:(facingShift.x)*0.05, oy:-12 - (f==='up'?2:0) };
      const VEST  ={ scale:2.40, ox:facingShift.x,         oy: 3 };
      const ARMS  ={ scale:2.60, ox:facingShift.x*0.3,     oy: 2 };
      const LEGS  ={ scale:2.45, ox:facingShift.x*0.2,     oy:10 };

      const ctx=document.getElementById('game')?.getContext('2d'); if(!ctx) return;

      if(on('volt_runner_legs'))   drawPieceWorld(ctx, px, py, LEGS.scale,   LEGS.ox,   LEGS.oy,   legs);
      if(on('volt_runner_vest'))   drawPieceWorld(ctx, px, py, VEST.scale,   VEST.ox,   VEST.oy,   vest);
      if(on('volt_runner_arms'))   drawPieceWorld(ctx, px, py, ARMS.scale,   ARMS.ox,   ARMS.oy,   arms);
      if(on('volt_runner_helmet')) drawPieceWorld(ctx, px, py, HELMET.scale, HELMET.ox, HELMET.oy, helm);
    });
  })();

  // ---- UI hint (tiny non-blocking helper) ----
  function showStartHintOnce(){
    if(localStorage.getItem('izzaM6HintShown')==='1') return;
    localStorage.setItem('izzaM6HintShown','1');
    IZZA.toast?.('Mission 6 started: Visit the Bank, then the hotel block, the docks, and the NE lake rim. Finish at Armoury Island!');
  }

  IZZA.on?.('ready', ()=>{ if(_stage()===0) showStartHintOnce(); });
  IZZA.on?.('update-post', tickMission);
})();
