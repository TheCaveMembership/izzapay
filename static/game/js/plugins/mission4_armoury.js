// v1.3 — Mission 4: Island Armoury + Cardboard Box (persistent item)
// - Cardboard Box persists in inventory (mirror + merge safeguard)
// - Box pickup asks Yes/No before adding to inventory
// - SVG island (land) centered in lake, with building + door interaction
// - Exposes island cells to boat plugin so boats cannot drive onto the island
// - Light damage-reduction shim (uses 'izza-player-hit' if your combat emits it)
(function(){
  const BUILD='v1.3-mission4-armoury';
  console.log('[IZZA PLAY]', BUILD);

  let api=null;

  // ---- localStorage keys
  const LS_KEYS = {
    mission4: 'izzaMission4',          // 'not-started' | 'started' | 'crafted'
    armour:   'izzaArmour',            // { type:'cardboard', reduction:Number }
    invMirror:'izzaM4_invMirror'       // { cardboard_box:{count:number,name:string,icon?:string} }
  };

  // ===== geometry helpers (mirror boat plugin) =====
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
  function islandSpec(){
    const a=anchors(api); const {LAKE}=lakeRects(a);
    const w=6, h=4; // tile size of island
    const gx = Math.floor((LAKE.x0+LAKE.x1)/2 - w/2);
    const gy = Math.floor((LAKE.y0+LAKE.y1)/2 - h/2);
    const ISLAND = { x0:gx, y0:gy, x1:gx+w-1, y1:gy+h-1 };

    // building 3×2, centered, door 1 tile SOUTH of building edge
    const BX=ISLAND.x0 + Math.floor((w-3)/2);
    const BY=ISLAND.y0 + Math.floor((h-2)/2);
    const BUILDING = { x0:BX, y0:BY, x1:BX+2, y1:BY+1 };
    const DOOR = { x: BX+1, y: BUILDING.y1+1 };
    return {ISLAND, BUILDING, DOOR};
  }

  // ===== HQ door → cardboard box spawn (Tier 1 & 2) =====
  function hqDoorGrid(){
    const t=api.TILE, d=api.doorSpawn;
    return { gx:Math.round(d.x/t), gy:Math.round(d.y/t) };
  }
  function cardboardBoxGrid(){
    const d=hqDoorGrid();
    return { x: d.gx + 3, y: d.gy + 10 }; // 3E, 10S from HQ door
  }

  // ===== Inventory helpers (with mirror for persistence) =====
  function readMirror(){
    try{ return JSON.parse(localStorage.getItem(LS_KEYS.invMirror)||'{}'); }catch{return {};}
  }
  function writeMirror(obj){
    localStorage.setItem(LS_KEYS.invMirror, JSON.stringify(obj||{}));
  }
  function readInv(){
    try{ return JSON.parse(JSON.stringify(api.getInventory()||{})); }catch{return {};}
  }
  function writeInv(inv){
    try{ api.setInventory(inv); window.dispatchEvent(new Event('izza-inventory-changed')); }catch{}
  }
  function addInvCount(inv, key, n, label='Cardboard Box'){
    // in-engine inventory
    inv[key]=inv[key]||{count:0, name:label};
    if(typeof inv[key].count!=='number') inv[key].count=0;
    inv[key].count+=n;
    if(inv[key].count<=0) delete inv[key];

    // mirror (persists even if UI normalizes unknown items)
    const m=readMirror();
    m[key]=m[key]||{count:0, name:label};
    m[key].count = (m[key].count||0) + n;
    if(m[key].count<=0) delete m[key];
    writeMirror(m);
  }

  // Merge mirror into engine inventory (runs on ready & whenever inventory opens)
  function ensureMirrorMergedIntoInventory(){
    const inv=readInv();
    const mirror=readMirror();
    let changed=false;
    Object.keys(mirror).forEach(k=>{
      const want=mirror[k]?.count|0;
      const have=inv[k]?.count|0;
      if(want>have){
        inv[k]=inv[k]||{count:0, name:mirror[k].name||k};
        inv[k].count=want;
        changed=true;
      }
    });
    if(changed) writeInv(inv);
  }

  // ===== Mission & armour state =====
  function getM4(){ return localStorage.getItem(LS_KEYS.mission4)||'not-started'; }
  function setM4(v){ localStorage.setItem(LS_KEYS.mission4, v); }
  function getArmour(){ try{ return JSON.parse(localStorage.getItem(LS_KEYS.armour)||'null'); }catch{return null;} }
  function setArmour(obj){ localStorage.setItem(LS_KEYS.armour, JSON.stringify(obj||null)); window.dispatchEvent(new Event('izza-armour-changed')); }

  // ===== Simple dialog =====
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

  // ===== Armoury UI =====
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
    ensureMirrorMergedIntoInventory();
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

    // Only recipe #1: Cardboard Box Armour
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

      setArmour({ type:'cardboard', reduction:0.06 }); // slight but noticeable
      setM4('crafted');
      IZZA.toast?.('Crafted Cardboard Box Armour!');
      openArmoury(); // refresh
    }, {passive:true});
  }

  // ===== Inventory helper card =====
  window.addEventListener('izza-inventory-changed', ()=>{
    ensureMirrorMergedIntoInventory();
    const host=document.getElementById('invPanel');
    if(!host || host.style.display==='none') return;
    if(!host.querySelector('[data-crafting-note]')){
      const div=document.createElement('div');
      div.setAttribute('data-crafting-note','1');
      div.style.cssText='margin-top:8px;padding:8px;border:1px dashed #2a3550;border-radius:10px;background:#0b1322;color:#cfe0ff';
      const body=host.querySelector('.inv-body'); if(body) body.append(div);
    }
    const inv=readInv();
    const boxCount=inv.cardboard_box?.count|0;
    host.querySelector('[data-crafting-note]').innerHTML = `
      <div style="font-weight:700;margin-bottom:6px">Crafting</div>
      <div style="opacity:.9">Bring items to the <b>Armoury</b> (island) to craft armour.</div>
      <div style="margin-top:4px;opacity:.9">You have: ${boxCount}× Cardboard Box</div>`;
  });

  // ===== B-key interactions: Box pickup (Yes/No) & Armoury door =====
  function onB(e){
    if(!api?.ready) return;
    const t=api.TILE;
    const gx=((api.player.x+16)/t|0), gy=((api.player.y+16)/t|0);

    // 1) Cardboard box (Yes/No)
    const box=cardboardBoxGrid();
    if(gx===box.x && gy===box.y){
      if(getM4()==='not-started') setM4('started');

      const m=document.createElement('div');
      m.className='modal'; m.style.display='flex';
      m.innerHTML = `
        <div class="backdrop"></div>
        <div class="card" style="min-width:300px;max-width:520px">
          <h3>📦 Cardboard Box</h3>
          <div style="line-height:1.5;margin-bottom:10px">
            <i>This cardboard box could come in handy for crafting something…</i><br>
            Have you ever taken a <b>boat ride</b>?<br><br>
            <b>Take this cardboard box with you?</b>
          </div>
          <div class="row" style="gap:8px">
            <button class="ghost" id="m4No">No</button>
            <button class="ghost" id="m4Yes">Yes</button>
          </div>
        </div>`;
      document.body.appendChild(m);
      const close=()=>m.remove();
      m.querySelector('.backdrop').addEventListener('click', close, {passive:true});
      m.querySelector('#m4No').addEventListener('click', ()=>{ IZZA.toast?.('Left the box for now'); close(); }, {passive:true});
      m.querySelector('#m4Yes').addEventListener('click', ()=>{
        const inv=readInv(); addInvCount(inv,'cardboard_box',1); writeInv(inv);
        IZZA.toast?.('Picked up a Cardboard Box');
        close();
      }, {passive:true});

      e?.preventDefault?.(); e?.stopPropagation?.(); e?.stopImmediatePropagation?.();
      return;
    }

    // 2) Armoury door
    const {DOOR}=islandSpec();
    if(localStorage.getItem('izzaMapTier')==='2' && gx===DOOR.x && gy===DOOR.y){
      showDialog([`Welcome to the <b>Armoury</b>!`,
        `Here you can craft armour to reduce your opponents’ attacks on you.`]);
      setTimeout(openArmoury, 0);
      e?.preventDefault?.(); e?.stopPropagation?.(); e?.stopImmediatePropagation?.();
      return;
    }
  }

  // ===== “Solids” for building; island is walkable land =====
  function addIslandSolids(){
    if(!api?.ready) return [];
    if(localStorage.getItem('izzaMapTier')!=='2') return [];
    const {BUILDING}=islandSpec();
    return [{x:BUILDING.x0,y:BUILDING.y0,w:(BUILDING.x1-BUILDING.x0+1),h:(BUILDING.y1-BUILDING.y0+1)}];
  }

  // Publish island cells so the boat plugin treats them as land (not water)
  function publishIslandCells(){
    if(localStorage.getItem('izzaMapTier')!=='2') { window._izzaIslandCells = null; return; }
    const {ISLAND}=islandSpec();
    const s=new Set();
    for(let y=ISLAND.y0; y<=ISLAND.y1; y++){
      for(let x=ISLAND.x0; x<=ISLAND.x1; x++){
        s.add(x+'|'+y);
      }
    }
    window._izzaIslandCells = s;
  }

  // ===== Rendering: island + building + smaller 3D box =====
  function drawSVGBox(ctx, sx, sy, S){
    ctx.save();
    ctx.translate(sx, sy);
    ctx.scale(S/44, S/44);
    ctx.translate(-22, -22);

    ctx.fillStyle='rgba(0,0,0,0.18)';
    ctx.beginPath(); ctx.ellipse(22,28,14,6,0,0,Math.PI*2); ctx.fill();

    const body = new Path2D('M6,18 L22,10 L38,18 L38,34 L22,42 L6,34 Z');
    ctx.fillStyle='#b98c4a'; ctx.fill(body);
    ctx.strokeStyle='#7d5f2e'; ctx.lineWidth=1.3; ctx.stroke(body);

    const flapL = new Path2D('M6,18 L22,26 L22,10 Z');
    const flapR = new Path2D('M38,18 L22,26 L22,10 Z');
    ctx.fillStyle='#cfa162'; ctx.fill(flapL); ctx.fill(flapR); ctx.stroke(flapL); ctx.stroke(flapR);

    ctx.fillStyle='#e9dfb1';
    ctx.beginPath(); ctx.moveTo(21,10); ctx.lineTo(23,10); ctx.lineTo(23,26); ctx.lineTo(21,26); ctx.closePath(); ctx.fill();

    ctx.strokeStyle='#5c4524'; ctx.lineWidth=1.1;
    ctx.beginPath(); ctx.moveTo(14,30); ctx.lineTo(18,26); ctx.moveTo(30,30); ctx.lineTo(26,26); ctx.stroke();

    ctx.restore();
  }

  function drawIsland(ctx){
    if(localStorage.getItem('izzaMapTier')!=='2') return;
    const S=api.DRAW, t=api.TILE;
    const {ISLAND, BUILDING}=islandSpec();
    const sx=(x)=> (x*t - api.camera.x)*(S/t), sy=(y)=> (y*t - api.camera.y)*(S/t);

    ctx.save();

    // sand island (rounded rect so it reads clearly as land)
    const px = sx(ISLAND.x0), py = sy(ISLAND.y0);
    const pw = (ISLAND.x1-ISLAND.x0+1)*(S/t), ph=(ISLAND.y1-ISLAND.y0+1)*(S/t);
    const r = Math.min(S*0.08, pw*0.12, ph*0.12);

    ctx.fillStyle='#d8c399';
    ctx.beginPath();
    ctx.moveTo(px+r,py);
    ctx.arcTo(px+pw,py,px+pw,py+ph,r);
    ctx.arcTo(px+pw,py+ph,px,py+ph,r);
    ctx.arcTo(px,py+ph,px,py,r);
    ctx.arcTo(px,py,px+pw,py,r);
    ctx.closePath();
    ctx.fill();

    // building block on island
    ctx.fillStyle='#6f87b3';
    ctx.fillRect(sx(BUILDING.x0), sy(BUILDING.y0),
                 (BUILDING.x1-BUILDING.x0+1)*(S/t), (BUILDING.y1-BUILDING.y0+1)*(S/t));

    // cardboard box near HQ (draw every frame is fine)
    const box=cardboardBoxGrid();
    const bsx = (box.x*t - api.camera.x)*(S/t) + S*0.5;
    const bsy = (box.y*t - api.camera.y)*(S/t) + S*0.58;
    drawSVGBox(ctx, bsx, bsy, S*0.78);

    ctx.restore();
  }

  // ===== Hooks =====
  IZZA.on('render-post', ()=>{
    if(!api?.ready) return;
    publishIslandCells(); // ensure boat plugin sees latest island cells
    drawIsland(document.getElementById('game').getContext('2d'));
  });

  IZZA.on('update-post', ()=>{
    if(!api?.ready) return;
    const solids = addIslandSolids();
    if(!solids.length) return;
    const p=api.player, t=api.TILE, gx=((p.x+16)/t|0), gy=((p.y+16)/t|0);
    solids.forEach(b=>{
      if(gx>=b.x && gx<b.x+b.w && gy>=b.y && gy<b.y+b.h){
        p.y = (b.y + b.h + 0.01)*t; // nudge out
      }
    });
  });

  // Damage reduction shim (slight but noticeable for cardboard)
  window.addEventListener('izza-player-hit', (ev)=>{
    try{
      const a=getArmour(); if(!a) return;
      if(typeof ev.detail?.damage === 'number'){
        const red = Math.max(0, Math.min(0.9, a.reduction||0.06));
        ev.detail.damage = Math.max(0, ev.detail.damage * (1 - red));
      }
    }catch{}
  });

  // B interactions
  function onB(e){
    if(!api?.ready) return;
    const t=api.TILE;
    const gx=((api.player.x+16)/t|0), gy=((api.player.y+16)/t|0);

    const box=cardboardBoxGrid();
    if(gx===box.x && gy===box.y){
      if(getM4()==='not-started') setM4('started');
      const m=document.createElement('div');
      m.className='modal'; m.style.display='flex';
      m.innerHTML = `
        <div class="backdrop"></div>
        <div class="card" style="min-width:300px;max-width:520px">
          <h3>📦 Cardboard Box</h3>
          <div style="line-height:1.5;margin-bottom:10px">
            <i>This cardboard box could come in handy for crafting something…</i><br>
            Have you ever taken a <b>boat ride</b>?<br><br>
            <b>Take this cardboard box with you?</b>
          </div>
          <div class="row" style="gap:8px">
            <button class="ghost" id="m4No">No</button>
            <button class="ghost" id="m4Yes">Yes</button>
          </div>
        </div>`;
      document.body.appendChild(m);
      const close=()=>m.remove();
      m.querySelector('.backdrop').addEventListener('click', close, {passive:true});
      m.querySelector('#m4No').addEventListener('click', ()=>{ IZZA.toast?.('Left the box for now'); close(); }, {passive:true});
      m.querySelector('#m4Yes').addEventListener('click', ()=>{
        const inv=readInv(); addInvCount(inv,'cardboard_box',1); writeInv(inv);
        IZZA.toast?.('Picked up a Cardboard Box');
        close();
      }, {passive:true});

      e?.preventDefault?.(); e?.stopPropagation?.(); e?.stopImmediatePropagation?.();
      return;
    }

    const {DOOR}=islandSpec();
    if(localStorage.getItem('izzaMapTier')==='2' && gx===DOOR.x && gy===DOOR.y){
      showDialog([`Welcome to the <b>Armoury</b>!`,
        `Here you can craft armour to reduce your opponents’ attacks on you.`]);
      setTimeout(openArmoury, 0);
      e?.preventDefault?.(); e?.stopPropagation?.(); e?.stopImmediatePropagation?.();
      return;
    }
  }

  // Boot
  IZZA.on('ready', (a)=>{
    api=a;
    ensureMirrorMergedIntoInventory(); // make sure items persist immediately
    const btnB=document.getElementById('btnB'); btnB?.addEventListener('click', onB, true);
    window.addEventListener('keydown', e=>{ if((e.key||'').toLowerCase()==='b') onB(e); }, {passive:false, capture:true});
    console.log('[mission4] ready', BUILD);
  });
})();
