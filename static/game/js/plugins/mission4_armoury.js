// v1.18 — Mission 4: Island Armoury + Cardboard Box (persistent & visible)
// - Box uses your earlier 3D style (smaller), one-tap pickup (no Yes/No) w/ original dialog
// - Island 5x6 tiles, building 2x2, palm tree, shoved to east edge of the lake
// - Publishes island land cells so boats can't drive onto it, disembark works
// - Inventory added via api.getInventory/setInventory and UI refreshed like store plugin
(function(){
  const BUILD='v1.18-m4-island-edge+inv-fix';
  console.log('[IZZA PLAY]', BUILD);

  let api=null;

  // ---- state keys
  const LS_KEYS = {
    mission4: 'izzaMission4',     // 'not-started' | 'started' | 'crafted'
    armour:   'izzaArmour'        // { type:'cardboard', reduction:Number }
  };

  // ===== geometry helpers (mirror boat/map placement) =====
  function unlockedRect(t){ return (t!=='2') ? {x0:18,y0:18,x1:72,y1:42} : {x0:10,y0:12,x1:80,y1:50}; }
  function anchors(a){
    const tier=(localStorage.getItem('izzaMapTier')||'1');
    const un=unlockedRect(tier);
    const bW=10,bH=6;
    const bX=Math.floor((un.x0+un.x1)/2)-Math.floor(bW/2);
    const bY=un.y0+5;
    const hRoadY=bY+bH+1, sidewalkTopY=hRoadY-1, vRoadX=Math.min(un.x1-3,bX+bW+6);
    return {un,bX,bY,bW,bH,hRoadY,sidewalkTopY,vRoadX};
  }
  function lakeRects(a){
    const LAKE={ x0:a.un.x1-14, y0:a.un.y0+23, x1:a.un.x1, y1:a.un.y1 };
    const BEACH_X=LAKE.x0-1;
    const DOCKS=[ {x0:LAKE.x0, y:LAKE.y0+4, len:3}, {x0:LAKE.x0, y:LAKE.y0+12, len:4} ];
    return {LAKE, BEACH_X, DOCKS};
  }

  // ===== Island & building (Tier 2 only) =====
  // Requirements: island 5x6 tiles, building 2x2, at EAST edge of the map (right side of lake)
  function islandSpec(){
    const a=anchors(api); const {LAKE}=lakeRects(a);
    const w=5, h=6; // island size
    const x1 = LAKE.x1 - 1;               // hug the east edge (leave 1 tile margin to avoid off-by-one)
    const x0 = x1 - (w-1);
    const yMid = Math.floor((LAKE.y0+LAKE.y1)/2);
    const y0 = yMid - Math.floor(h/2);
    const y1 = y0 + h - 1;
    const ISLAND = { x0:Math.max(LAKE.x0, x0), y0:Math.max(LAKE.y0, y0), x1:x1, y1:Math.min(LAKE.y1, y1) };

    // building 2×2, centered on island; door 1 tile SOUTH
    const BX = ISLAND.x0 + Math.floor((w-2)/2);
    const BY = ISLAND.y0 + Math.floor((h-2)/2);
    const BUILDING = { x0:BX, y0:BY, x1:BX+1, y1:BY+1 };
    const DOOR = { x: BX+1-1+1, y: BUILDING.y1+1 }; // center of south edge; simplified: BX+1, south 1
    return {ISLAND, BUILDING, DOOR};
  }
  function isIslandTile(gx,gy){
    if(localStorage.getItem('izzaMapTier')!=='2') return false;
    const {ISLAND}=islandSpec();
    return (gx>=ISLAND.x0 && gx<=ISLAND.x1 && gy>=ISLAND.y0 && gy<=ISLAND.y1);
  }

  // Expose land override so boat plugin and walk clamps can treat as land
  window._izzaLandAt = (gx,gy)=> isIslandTile(gx,gy);

  // ===== HQ door → cardboard box position =====
  function hqDoorGrid(){
    const t=api.TILE, d=api.doorSpawn; // core provides this
    return { gx:Math.round(d.x/t), gy:Math.round(d.y/t) };
  }
  function cardboardBoxGrid(){
    const d=hqDoorGrid();
    return { x: d.gx + 3, y: d.gy + 10 }; // 3E, 10S
  }

  // ===== Inventory helpers (use the same API pattern as core/store) =====
  function getInv(){ try{ return api.getInventory() || {}; }catch{return {};}}
  function setInv(inv){
    try{
      api.setInventory(inv);
      // If inventory panel is open, refresh it just like store plugin does:
      // renderInventoryPanel() exists in core inventory UI.  (same pattern) 
      // (It’s what makes things “stick” visually after reopen.)  (see store plugin) 
      const host = document.getElementById('invPanel');
      if(host && host.style.display!=='none' && typeof window.renderInventoryPanel==='function'){
        window.renderInventoryPanel();
      }
      // also fire the generic changed event used by some extensions
      window.dispatchEvent?.(new Event('izza-inventory-changed'));
    }catch{}
  }
  function addCount(inv, key, n){
    inv[key] = inv[key] || { count:0 };
    inv[key].count = (inv[key].count|0) + n;
    if(inv[key].count<=0) delete inv[key];
  }

  // ===== Mission & armour state =====
  function getM4(){ return localStorage.getItem(LS_KEYS.mission4)||'not-started'; }
  function setM4(v){ localStorage.setItem(LS_KEYS.mission4, v); }
  function getArmour(){ try{ return JSON.parse(localStorage.getItem(LS_KEYS.armour)||'null'); }catch{return null;} }
  function setArmour(obj){ localStorage.setItem(LS_KEYS.armour, JSON.stringify(obj||null)); window.dispatchEvent(new Event('izza-armour-changed')); }

  // ===== UI helpers =====
  function dialog(lines){
    const m=document.createElement('div');
    m.className='modal'; m.style.display='flex';
    m.innerHTML=`
      <div class="backdrop"></div>
      <div class="card" style="min-width:280px;max-width:520px">
        <h3>💬</h3>
        <div style="line-height:1.5">${lines.map(l=>`<div style="margin:.35em 0">${l}</div>`).join('')}</div>
        <div class="row" style="margin-top:10px"><button class="ghost" id="ok">OK</button></div>
      </div>`;
    document.body.appendChild(m);
    const close=()=>m.remove();
    m.querySelector('.backdrop').addEventListener('click', close, {passive:true});
    m.querySelector('#ok').addEventListener('click', close, {passive:true});
  }

  function ensureArmouryModal(){
    if(document.getElementById('armouryModal')) return;
    const wrap=document.createElement('div');
    wrap.id='armouryModal';
    wrap.className='modal'; wrap.style.display='none';
    wrap.innerHTML = `
      <div class="backdrop"></div>
      <div class="card" style="min-width:320px;max-width:560px">
        <h3>🛡️ Armoury</h3>
        <div id="armouryBody" class="shop-note" style="margin-bottom:10px"></div>
        <div class="row">
          <button class="ghost" id="armouryClose">Close</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    wrap.querySelector('.backdrop').addEventListener('click', ()=>wrap.style.display='none', {passive:true});
    wrap.querySelector('#armouryClose').addEventListener('click', ()=>wrap.style.display='none', {passive:true});
  }
  function openArmoury(){
    ensureArmouryModal();
    const modal=document.getElementById('armouryModal');
    const host=document.getElementById('armouryBody');
    const inv=getInv();
    const boxCount = inv.cardboard_box?.count|0;

    const crafted = getM4()==='crafted';
    const haveArmour = !!getArmour();

    let html = `<div>Craft armour to <b>reduce incoming damage.</b></div>`;
    html += `<div style="margin-top:6px">Your items: ${boxCount}× Cardboard Box</div>`;
    html += `<div style="margin-top:10px;display:flex;gap:8px;align-items:center">`;

    // recipe 1: Cardboard Box Armour
    const canCraft = boxCount>0 && !crafted;
    html += `<button id="craftBoxArmour" ${canCraft?'':'disabled'} class="ghost">Craft: Cardboard Box Armour</button>`;
    html += `</div>`;

    if(haveArmour){
      const a=getArmour();
      html += `<div style="margin-top:10px;opacity:.9">Equipped: <b>${a.type}</b> (reduction ${(a.reduction*100)|0}%)
               </div>`;
    }

    host.innerHTML = html;
    modal.style.display='flex';

    const btn=host.querySelector('#craftBoxArmour');
    if(btn) btn.addEventListener('click', ()=>{
      const inv2=getInv();
      const c=inv2.cardboard_box?.count|0;
      if(c<=0){ IZZA.toast?.('You need a Cardboard Box'); return; }
      addCount(inv2,'cardboard_box',-1);
      setInv(inv2);
      setArmour({ type:'cardboard', reduction:0.08 });
      setM4('crafted');
      IZZA.toast?.('Crafted Cardboard Box Armour!');
      openArmoury(); // refresh
    }, {passive:true});
  }

  // ===== Inventory panel: add a "Materials" row so boxes are visible
  function refreshMaterialsRow(){
    const host=document.getElementById('invPanel');
    if(!host || host.style.display==='none') return;
    // build a small row beneath whatever core rendered
    const id='invMaterialsRow';
    host.querySelector('#'+id)?.remove();
    const inv=getInv();
    const boxCount=inv.cardboard_box?.count|0;
    const row = document.createElement('div');
    row.id = id;
    row.className='inv-item';
    row.style.cssText='margin-top:10px;display:flex;align-items:center;gap:10px;padding:14px;background:#0f1522;border:1px dashed #2a3550;border-radius:10px';
    row.innerHTML = `
      <div style="width:28px;height:28px"></div>
      <div style="font-weight:700">Materials</div>
      <div style="margin-left:12px;opacity:.85;font-size:12px">${boxCount}× Cardboard Box</div>`;
    host.append(row);
  }
  window.addEventListener('izza-inventory-changed', refreshMaterialsRow);

  // ===== B-key interactions: Box pickup (original dialog) / Armoury door
  function onB(e){
    if(!api?.ready) return;
    const t=api.TILE;
    const gx=((api.player.x+16)/t|0), gy=((api.player.y+16)/t|0);

    // 1) Cardboard box pickup
    const bx=cardboardBoxGrid();
    if(gx===bx.x && gy===bx.y){
      e?.preventDefault?.(); e?.stopPropagation?.(); e?.stopImmediatePropagation?.();

      // Add to inventory and refresh UI using the same pattern as the store plugin
      const inv=getInv();
      addCount(inv,'cardboard_box',1);
      setInv(inv); // persists & calls renderInventoryPanel if open  (store-style)  [see citations]

      if(getM4()==='not-started') setM4('started');
      dialog([
        `<i>This cardboard box could come in handy for crafting something…</i>`,
        `Have you ever taken a <b>boat ride</b>?`
      ]);
      return;
    }

    // 2) Armoury: stand on door tile and press B
    const {DOOR}=islandSpec();
    if(localStorage.getItem('izzaMapTier')==='2' && gx===DOOR.x && gy===DOOR.y){
      e?.preventDefault?.(); e?.stopPropagation?.(); e?.stopImmediatePropagation?.();
      dialog([`Welcome to the <b>Armoury</b>!`,
        `Here you can craft armour to reduce your opponents’ attacks on you.`]);
      setTimeout(openArmoury, 0);
      return;
    }
  }

  // ===== Collisions: building solid; island sand is walkable
  function buildingSolid(){
    if(!api?.ready) return null;
    if(localStorage.getItem('izzaMapTier')!=='2') return null;
    const {BUILDING}=islandSpec();
    return {x:BUILDING.x0,y:BUILDING.y0,w:(BUILDING.x1-BUILDING.x0+1),h:(BUILDING.y1-BUILDING.y0+1)};
  }

  // ===== Drawing
  // Cardboard box (the earlier “3D” one, now scaled smaller)
  function draw3DBox(ctx, sx, sy, S){
    ctx.save();
    ctx.translate(sx, sy);
    ctx.scale((S*0.78)/44, (S*0.78)/44);
    ctx.translate(-22, -22);

    // soft shadow
    ctx.fillStyle='rgba(0,0,0,0.18)';
    ctx.beginPath(); ctx.ellipse(22,28,14,6,0,0,Math.PI*2); ctx.fill();

    // body (isometric hex prism)
    const body = new Path2D('M6,18 L22,10 L38,18 L38,34 L22,42 L6,34 Z');
    ctx.fillStyle='#b98c4a'; ctx.fill(body);
    ctx.strokeStyle='#7d5f2e'; ctx.lineWidth=1.3; ctx.stroke(body);

    // top flaps
    const flapL = new Path2D('M6,18 L22,26 L22,10 Z');
    const flapR = new Path2D('M38,18 L22,26 L22,10 Z');
    ctx.fillStyle='#cfa162'; ctx.fill(flapL); ctx.fill(flapR); ctx.stroke(flapL); ctx.stroke(flapR);

    // tape
    ctx.fillStyle='#e9dfb1';
    ctx.beginPath(); ctx.moveTo(21,10); ctx.lineTo(23,10); ctx.lineTo(23,26); ctx.lineTo(21,26); ctx.closePath(); ctx.fill();

    // corrugation hint
    ctx.strokeStyle='#5c4524'; ctx.lineWidth=1.1;
    ctx.beginPath(); ctx.moveTo(14,30); ctx.lineTo(18,26); ctx.moveTo(30,30); ctx.lineTo(26,26); ctx.stroke();
    ctx.restore();
  }

  function drawPalm(ctx, sx, sy, S){
    ctx.save();
    ctx.translate(sx, sy);
    ctx.scale(S/32, S/32);
    // trunk
    ctx.strokeStyle='#8b5a2b'; ctx.lineWidth=3.0;
    ctx.beginPath();
    ctx.moveTo(16,28); ctx.bezierCurveTo(17,22, 18,18, 19,8);
    ctx.stroke();
    // leaves
    ctx.fillStyle='#2e8b57';
    const leaf = (ax,ay,bx,by,cx,cy)=>{ ctx.beginPath(); ctx.moveTo(ax,ay); ctx.quadraticCurveTo(bx,by,cx,cy); ctx.quadraticCurveTo(bx,by,ax,ay); ctx.fill(); };
    leaf(19,8,   6,4,   2,10);
    leaf(19,8,   12,2,  20,2);
    leaf(19,8,   26,4,  31,10);
    leaf(19,8,   28,10, 28,16);
    leaf(19,8,   10,10, 10,16);
    ctx.restore();
  }

  function drawIsland(ctx){
    if(localStorage.getItem('izzaMapTier')!=='2') return;
    const S=api.DRAW, t=api.TILE;
    const {ISLAND, BUILDING, DOOR}=islandSpec();
    const sx=(x)=> (x*t - api.camera.x)*(S/t);
    const sy=(y)=> (y*t - api.camera.y)*(S/t);

    ctx.save();
    // sand
    ctx.fillStyle='#d8c399';
    ctx.fillRect(sx(ISLAND.x0), sy(ISLAND.y0), (ISLAND.x1-ISLAND.x0+1)*S, (ISLAND.y1-ISLAND.y0+1)*S);

    // palm tree near NW of island
    drawPalm(ctx, sx(ISLAND.x0)+S*0.6, sy(ISLAND.y0)+S*0.8, S);

    // building block 2×2
    ctx.fillStyle='#6f87b3';
    ctx.fillRect(sx(BUILDING.x0), sy(BUILDING.y0), (BUILDING.x1-BUILDING.x0+1)*S, (BUILDING.y1-BUILDING.y0+1)*S);

    // door (one tile south)
    ctx.fillStyle='#333';
    ctx.fillRect(sx(DOOR.x), sy(DOOR.y), S, S);
    ctx.restore();

    // box near HQ (draw every frame; visible in all tiers)
    const grid=cardboardBoxGrid();
    const bx = (grid.x*t - api.camera.x)*(S/t) + S*0.5;
    const by = (grid.y*t - api.camera.y)*(S/t) + S*0.6;
    draw3DBox(ctx, bx, by, S);
  }

  // ===== Hooks
  IZZA.on('render-post', ()=>{
    if(!api?.ready) return;
    const ctx=document.getElementById('game').getContext('2d');
    drawIsland(ctx);
  });

  IZZA.on('update-post', ()=>{
    if(!api?.ready) return;
    // building solid resolve
    const b=buildingSolid();
    if(!b) return;
    const p=api.player, t=api.TILE, gx=((p.x+16)/t|0), gy=((p.y+16)/t|0);
    if(gx>=b.x && gx<b.x+b.w && gy>=b.y && gy<b.y+b.h){
      p.y = (b.y + b.h + 0.01)*t; // push down
    }
  });

  function onB(e){
    if(!api?.ready) return;
    const t=api.TILE, gx=((api.player.x+16)/t|0), gy=((api.player.y+16)/t|0);

    const box=cardboardBoxGrid();
    if(gx===box.x && gy===box.y){
      e?.preventDefault?.(); e?.stopPropagation?.(); e?.stopImmediatePropagation?.();

      const inv=getInv();
      addCount(inv,'cardboard_box',1);
      setInv(inv); // persist + UI refresh like store

      if(getM4()==='not-started') setM4('started');
      dialog([
        `<i>This cardboard box could come in handy for crafting something…</i>`,
        `Have you ever taken a <b>boat ride</b>?`
      ]);
      return;
    }

    const {DOOR}=islandSpec();
    if(localStorage.getItem('izzaMapTier')==='2' && gx===DOOR.x && gy===DOOR.y){
      e?.preventDefault?.(); e?.stopPropagation?.(); e?.stopImmediatePropagation?.();
      dialog([`Welcome to the <b>Armoury</b>!`,
        `Here you can craft armour to reduce your opponents’ attacks on you.`]);
      setTimeout(openArmoury, 0);
      return;
    }
  }

  IZZA.on('ready', (a)=>{
    api=a;
    const btnB=document.getElementById('btnB'); btnB?.addEventListener('click', onB, true);
    window.addEventListener('keydown', e=>{ if((e.key||'').toLowerCase()==='b') onB(e); }, {passive:false, capture:true});
    console.log('[mission4] ready', BUILD);
  });

  // Light DR hook for armour (works if your combat fires 'izza-player-hit')
  window.addEventListener('izza-player-hit', (ev)=>{
    try{
      const a=getArmour(); if(!a) return;
      if(typeof ev.detail?.damage==='number'){
        ev.detail.damage = Math.max(0, ev.detail.damage * (1 - (a.reduction||0)));
      }
    }catch{}
  });
})();
