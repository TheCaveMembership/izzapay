// v1.0 — Mission 4: Island Armoury + Cardboard Box pickup
(function(){
  const BUILD='v1.0-mission4-armoury';
  console.log('[IZZA PLAY]', BUILD);

  // ---- Local state
  let api=null;
  const LS_KEYS = {
    mission4: 'izzaMission4',          // 'not-started' | 'started' | 'crafted'
    armour:   'izzaArmour'             // { type:'cardboard', reduction:0.08 } JSON
  };

  // ==== geometry helpers (mirror boat plugin) ====
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

  // ---- Island & building placement (Tier 2 only)
  function islandSpec(){
    const a=anchors(api); const {LAKE}=lakeRects(a);
    // Centered island (sand) ~ 6x4 tiles
    const w=6, h=4;
    const gx = Math.floor((LAKE.x0+LAKE.x1)/2 - w/2);
    const gy = Math.floor((LAKE.y0+LAKE.y1)/2 - h/2);
    const ISLAND = { x0:gx, y0:gy, x1:gx+w-1, y1:gy+h-1 };

    // Small 3x2 building placed on island, door facing SOUTH in the middle
    const BX=ISLAND.x0 + Math.floor((w-3)/2);
    const BY=ISLAND.y0 + Math.floor((h-2)/2);
    const BUILDING = { x0:BX, y0:BY, x1:BX+2, y1:BY+1 };
    const DOOR = { x: BX+1, y: BUILDING.y1+1 }; // one tile south of building edge
    return {ISLAND, BUILDING, DOOR};
  }

  // ---- HQ door → cardboard box spawn (Tier 1 & 2)
  function hqDoorGrid(){
    // Core exposes a pixel spawn aligned to the HQ door; convert to grid
    // (safe to round since spawn sits at tile origin in your core)  [oai_citation:1‡izza_core_v3.js](file-service://file-UA3JsTEHcTZC3gyi66Ym73)
    const t=api.TILE, d=api.doorSpawn;
    const gx=Math.round(d.x/t), gy=Math.round(d.y/t);
    return {gx,gy};
  }
  function cardboardBoxGrid(){
    const d=hqDoorGrid();
    return { x: d.gx + 3, y: d.gy + 10 }; // 3 east, 10 south from HQ door (requested)
  }

  // ---- Inventory helpers (use the public API or LS mirror)  [oai_citation:2‡izza_core_v3.js](file-service://file-UA3JsTEHcTZC3gyi66Ym73)
  function readInv(){ try{ return JSON.parse(JSON.stringify(api.getInventory()||{})); }catch{return {};}}
  function writeInv(inv){ try{ api.setInventory(inv); window.dispatchEvent(new Event('izza-inventory-changed')); }catch{} }
  function addInvCount(inv, key, n){
    inv[key]=inv[key]||{count:0};
    if(typeof inv[key].count!=='number') inv[key].count=0;
    inv[key].count+=n;
    if(inv[key].count<=0) delete inv[key];
  }

  // ---- Mission 4 state
  function getM4(){ return localStorage.getItem(LS_KEYS.mission4)||'not-started'; }
  function setM4(v){ localStorage.setItem(LS_KEYS.mission4, v); }

  // ---- Armour state
  function getArmour(){ try{ return JSON.parse(localStorage.getItem(LS_KEYS.armour)||'null'); }catch{return null;} }
  function setArmour(obj){ localStorage.setItem(LS_KEYS.armour, JSON.stringify(obj||null)); window.dispatchEvent(new Event('izza-armour-changed')); }

  // ---- UI: tiny dialog & armoury modal
  function showDialog(lines){
    const m=document.createElement('div');
    m.className='modal'; m.style.display='flex';
    m.innerHTML = `
      <div class="backdrop"></div>
      <div class="card" style="min-width:280px;max-width:520px">
        <h3>💬</h3>
        <div style="line-height:1.5">${lines.map(l=>`<div style="margin:.35em 0">${l}</div>`).join('')}</div>
        <div class="row" style="margin-top:10px"><button class="ghost" id="dlgOk">OK</button></div>
      </div>`;
    document.body.appendChild(m);
    const close=()=>{ m.remove(); };
    m.querySelector('.backdrop').addEventListener('click', close, {passive:true});
    m.querySelector('#dlgOk').addEventListener('click', close, {passive:true});
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
    const inv=readInv();
    const boxCount = inv.cardboard_box?.count|0;

    const crafted = getM4()==='crafted';
    const haveArmour = !!getArmour();

    let html = `<div>Craft armour to <b>reduce incoming damage.</b></div>`;
    html += `<div style="margin-top:6px">Your items: ${boxCount}× Cardboard Box</div>`;
    html += `<div style="margin-top:10px;display:flex;gap:8px;align-items:center">`;

    // Only recipe #1 for now: Cardboard Box Armour
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
      const inv2=readInv();
      const c=inv2.cardboard_box?.count|0;
      if(c<=0){ IZZA.toast?.('You need a Cardboard Box'); return; }
      addInvCount(inv2,'cardboard_box',-1);
      writeInv(inv2);

      // Give armour (light DR); hook used by combat code if present
      setArmour({ type:'cardboard', reduction:0.08 });

      setM4('crafted');
      IZZA.toast?.('Crafted Cardboard Box Armour!');
      openArmoury(); // refresh
    }, {passive:true});
  }

  // ---- Inventory panel helper: show a simple "Crafting" dropdown note when open
  // (non-invasive: we don't modify the inventory renderer; we just append our note)
  window.addEventListener('izza-inventory-changed', ()=>{
    const host=document.getElementById('invPanel');
    if(!host || host.style.display==='none') return;
    if(host.querySelector('[data-crafting-note]')) return;
    const inv=readInv();
    const boxCount=inv.cardboard_box?.count|0;
    const div=document.createElement('div');
    div.setAttribute('data-crafting-note','1');
    div.style.cssText='margin-top:8px;padding:8px;border:1px dashed #2a3550;border-radius:10px;background:#0b1322;color:#cfe0ff';
    div.innerHTML = `
      <div style="font-weight:700;margin-bottom:6px">Crafting</div>
      <div style="opacity:.9">Bring items to the <b>Armoury</b> (island) to craft armour.</div>
      <div style="margin-top:4px;opacity:.9">You have: ${boxCount}× Cardboard Box</div>`;
    const body=host.querySelector('.inv-body'); if(body) body.append(div);
  });

  // ---- B-key interactions: Box pickup / Armoury door
  function onB(e){
    if(!api?.ready) return;
    const t=api.TILE;
    const gx=((api.player.x+16)/t|0), gy=((api.player.y+16)/t|0);

    // 1) Cardboard box pickup / Mission 4 start
    const box=cardboardBoxGrid();
    if(gx===box.x && gy===box.y){
      // Give box item to inventory
      const inv=readInv(); addInvCount(inv,'cardboard_box',1); writeInv(inv);
      if(getM4()==='not-started'){
        setM4('started');
        showDialog([
          `<i>This cardboard box could come in handy for crafting something…</i>`,
          `Have you ever taken a <b>boat ride</b>?`
        ]);
      }else{
        IZZA.toast?.('Picked up a Cardboard Box');
      }
      e?.preventDefault?.(); e?.stopPropagation?.(); e?.stopImmediatePropagation?.();
      return;
    }

    // 2) Armoury: stand on door tile and press B
    const {DOOR}=islandSpec();
    if(gx===DOOR.x && gy===DOOR.y){
      showDialog([`Welcome to the <b>Armoury</b>!`,
        `Here you can craft armour to reduce your opponents’ attacks on you.`]);
      // Open armoury crafting UI
      setTimeout(openArmoury, 0);
      e?.preventDefault?.(); e?.stopPropagation?.(); e?.stopImmediatePropagation?.();
      return;
    }
  }

  // ---- “Solids” for island/building (block walking into water gap & walls)
  function addIslandSolids(){
    if(!api?.ready) return [];
    const a=anchors(api); const {LAKE}=lakeRects(a);
    const {ISLAND, BUILDING}=islandSpec();
    // Only in Tier 2 (lake exists there)
    if(localStorage.getItem('izzaMapTier')!=='2') return [];

    // Island is *not* water (walkable sand), building is solid
    // We just push building rect as solid so player can walk island & enter at the door edge.
    return [{x:BUILDING.x0,y:BUILDING.y0,w:(BUILDING.x1-BUILDING.x0+1),h:(BUILDING.y1-BUILDING.y0+1)}];
  }

  // ---- Rendering (overlay): island + building + box sprite
  function drawSVGBox(ctx, sx, sy, S){
    // a cute corrugated box (top view-ish)
    ctx.save();
    ctx.translate(sx, sy);
    ctx.scale(S/32, S/32); // normalized to ~32px tile

    // shadow
    ctx.fillStyle='rgba(0,0,0,0.18)';
    ctx.beginPath(); ctx.ellipse(16,19,12,5,0,0,Math.PI*2); ctx.fill();

    // base
    const hull = new Path2D('M6,8 h20 v14 h-20 z');
    ctx.fillStyle='#b68b4c'; ctx.fill(hull);
    ctx.strokeStyle='#8a6a3a'; ctx.lineWidth=1; ctx.stroke(hull);

    // flaps
    const flapL = new Path2D('M6,8 l10,-6 l10,6 z');
    const flapR = new Path2D('M6,22 l10,6 l10,-6 z');
    ctx.fillStyle='#c99a5e'; ctx.fill(flapL); ctx.fill(flapR);
    ctx.stroke(flapL); ctx.stroke(flapR);

    // tape
    ctx.fillStyle='#e5d8a8'; ctx.fillRect(15,2,2,28);

    // logo arrows
    ctx.strokeStyle='#5c4524'; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(10,16); ctx.lineTo(14,12); ctx.moveTo(22,16); ctx.lineTo(18,12); ctx.stroke();
    ctx.restore();
  }

  function drawIsland(ctx){
    if(localStorage.getItem('izzaMapTier')!=='2') return;
    const S=api.DRAW, t=api.TILE, A=anchors(api); const {LAKE}=lakeRects(A);
    const {ISLAND, BUILDING, DOOR}=islandSpec();

    // sand
    ctx.save();
    const sx=(x)=> (x*t - api.camera.x)*(S/t), sy=(y)=> (y*t - api.camera.y)*(S/t);
    ctx.fillStyle='#d8c399';
    ctx.fillRect(sx(ISLAND.x0), sy(ISLAND.y0), (ISLAND.x1-ISLAND.x0+1)*(S/t), (ISLAND.y1-ISLAND.y0+1)*(S/t));

    // building block
    ctx.fillStyle='#6f87b3';
    ctx.fillRect(sx(BUILDING.x0), sy(BUILDING.y0), (BUILDING.x1-BUILDING.x0+1)*(S/t), (BUILDING.y1-BUILDING.y0+1)*(S/t));

    // door marker
    ctx.fillStyle='#333';
    ctx.fillRect(sx(DOOR.x), sy(DOOR.y), (S/t), (S/t));

    // cardboard box pickup near HQ
    const box=cardboardBoxGrid();
    const bsx = (box.x*t - api.camera.x)*(S/t) + S*0.5;
    const bsy = (box.y*t - api.camera.y)*(S/t) + S*0.6;
    drawSVGBox(ctx, bsx, bsy, S*0.9);
    ctx.restore();
  }

  // ---- Hook solids & render
  IZZA.on('render-post', ()=>{ if(api?.ready) drawIsland(document.getElementById('game').getContext('2d')); });

  // Add building as a solid during map resolve (non-invasive). The expander gathers solids each tick,
  // so piggyback after its push. It checks water vs solids and has guards for boating.  [oai_citation:3‡v2_map_expander.js](file-service://file-9xJzB57JiKUy5JVMT9HDsF)
  IZZA.on('update-post', ()=>{
    if(!api?.ready) return;
    const solids = addIslandSolids();
    if(!solids.length) return;
    // Push a solid by nudging the player out if overlapping (same technique as map expander does)  [oai_citation:4‡v2_map_expander.js](file-service://file-9xJzB57JiKUy5JVMT9HDsF)
    const p=api.player, t=api.TILE, gx=((p.x+16)/t|0), gy=((p.y+16)/t|0);
    solids.forEach(b=>{
      if(gx>=b.x && gx<b.x+b.w && gy>=b.y && gy<b.y+b.h){
        // move south one pixel out
        p.y = (b.y + b.h + 0.01)*t;
      }
    });
  });

  // ---- Boot
  IZZA.on('ready', (a)=>{
    api=a;
    // B interactions (coexists with boat plugin — we early-return when not on our tiles)
    const btnB=document.getElementById('btnB'); btnB?.addEventListener('click', onB, true);
    window.addEventListener('keydown', e=>{ if((e.key||'').toLowerCase()==='b') onB(e); }, {passive:false, capture:true});
    console.log('[mission4] ready');
  });

  // ---- (Optional) light damage reduction shim:
  // If your combat system dispatches a 'izza-player-hit' CustomEvent({detail:{damage}})
  // we scale it. If not present, this does nothing and is safe.
  window.addEventListener('izza-player-hit', (ev)=>{
    try{
      const a=getArmour(); if(!a) return;
      if(typeof ev.detail?.damage === 'number'){
        ev.detail.damage = Math.max(0, ev.detail.damage * (1 - (a.reduction||0)));
      }
    }catch{}
  });
})();
