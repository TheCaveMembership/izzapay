// v2.1 — Mission 4: Island Armoury + Cardboard Box + Beach Docking (no island dock)
// Draw island in render-under so it appears above water (map) but below entities.
// Publishes island land tiles (window._izzaIslandLand) during update-pre.
(function(){
  const BUILD='v2.1-m4-armoury';
  console.log('[IZZA PLAY]', BUILD);

  let api=null;
  const LS_KEYS = { mission4:'izzaMission4', armour:'izzaArmour' };
  const BOX_TAKEN_KEY = 'izzaBoxTaken';

  // ===== geometry =====
  function unlockedRect(t){ return (t!=='2')?{x0:18,y0:18,x1:72,y1:42}:{x0:10,y0:12,x1:80,y1:50}; }
  function anchors(){
    const tier=(localStorage.getItem('izzaMapTier')||'1');
    return { un: unlockedRect(tier) };
  }
  function lakeRects(a){
    const LAKE={ x0:a.un.x1-14, y0:a.un.y0+23, x1:a.un.x1, y1:a.un.y1 };
    return { LAKE };
  }

  // ===== island (5×4) at far east edge, building 1×2 (west tile has the door) =====
  function islandSpec(){
    const a=anchors(); const {LAKE}=lakeRects(a);
    const w=5, h=4;
    const x1 = LAKE.x1 - 1;            // hug east edge (leave 1 tile margin)
    const x0 = x1 - (w-1);
    const yMid = (LAKE.y0 + LAKE.y1) >> 1;
    const y0 = yMid - (h>>1);
    const y1 = y0 + h - 1;
    const ISLAND = { x0:Math.max(LAKE.x0,x0), y0:Math.max(LAKE.y0,y0), x1, y1:Math.min(LAKE.y1,y1) };

    // Building: 2 tiles wide × 1 tile tall, centered; west tile has the door
    const BX = ISLAND.x0 + Math.floor((w-2)/2);
    const BY = ISLAND.y0 + Math.floor((h-1)/2);
    const BUILDING = { x0:BX, y0:BY, x1:BX+1, y1:BY };

    // Door grid: one tile south of the WEST building tile (press B here)
    const DOOR_GRID = { x: BX, y: BY+1 };

    return { ISLAND, BUILDING, DOOR_GRID };
  }

  // Publish island land for boat plugin (beach docking)
  function publishIslandLand(){
    if(localStorage.getItem('izzaMapTier')!=='2'){ window._izzaIslandLand=null; return; }
    const {ISLAND}=islandSpec();
    const land=new Set();
    for(let y=ISLAND.y0;y<=ISLAND.y1;y++){
      for(let x=ISLAND.x0;x<=ISLAND.x1;x++){
        land.add(x+'|'+y);
      }
    }
    window._izzaIslandLand = land; // NOT water for the boat plugin
  }

  // Keep the land set fresh before physics each frame, and once at boot
  IZZA.on('update-pre', publishIslandLand);
  IZZA.on('ready', ()=> publishIslandLand());

  // ===== HQ door → cardboard box position =====
  function hqDoorGrid(){ const t=api.TILE, d=api.doorSpawn; return { gx:Math.round(d.x/t), gy:Math.round(d.y/t) }; }
  function cardboardBoxGrid(){ const d=hqDoorGrid(); return { x:d.gx+3, y:d.gy+10 }; }

  // ===== inventory helpers (mirror core) =====
  function getInv(){ try{ return api.getInventory()||{}; }catch{return {};}}
  function setInv(inv){
    try{
      api.setInventory(inv);
      if(typeof window.renderInventoryPanel==='function') window.renderInventoryPanel();
      window.dispatchEvent(new Event('izza-inventory-changed'));
    }catch{}
  }
  function addCount(inv,key,n){
    inv[key]=inv[key]||{count:0};
    inv[key].count=(inv[key].count|0)+n;
    if(inv[key].count<=0) delete inv[key];
  }

  // ===== mission/armour state =====
  function getM4(){ return localStorage.getItem(LS_KEYS.mission4)||'not-started'; }
  function setM4(v){ localStorage.setItem(LS_KEYS.mission4, v); }
  function getArmour(){ try{ return JSON.parse(localStorage.getItem(LS_KEYS.armour)||'null'); }catch{return null;} }
  function setArmour(o){ localStorage.setItem(LS_KEYS.armour, JSON.stringify(o||null)); window.dispatchEvent(new Event('izza-armour-changed')); }

  // ===== dialogs =====
  function showBoxYesNo(onYes){
    const m=document.createElement('div');
    m.className='modal'; m.style.display='flex';
    m.innerHTML=`
      <div class="backdrop"></div>
      <div class="card" style="min-width:300px;max-width:520px">
        <h3>📦</h3>
        <div style="line-height:1.5">
          <i>This cardboard box could come in handy for crafting something…</i><br>
          Have you ever taken a <b>boat ride</b>?<br><br>
          <b>Take the cardboard box?</b>
        </div>
        <div class="row" style="margin-top:10px;gap:8px">
          <button class="ghost" id="yes">Yes</button>
          <button class="ghost" id="no">No</button>
        </div>
      </div>`;
    document.body.appendChild(m);
    const close=()=>m.remove();
    m.querySelector('.backdrop').addEventListener('click', close, {passive:true});
    m.querySelector('#no').addEventListener('click', close, {passive:true});
    m.querySelector('#yes').addEventListener('click', ()=>{ try{ onYes?.(); }finally{ close(); } }, {passive:true});
  }

  // ===== visuals =====
  function draw3DBox(ctx, sx, sy, S){
    ctx.save();
    ctx.translate(sx, sy);
    ctx.scale((S*0.68)/44, (S*0.68)/44);
    ctx.translate(-22, -22);
    // soft shadow
    ctx.fillStyle='rgba(0,0,0,0.18)'; ctx.beginPath(); ctx.ellipse(22,28,14,6,0,0,Math.PI*2); ctx.fill();
    // body
    const body = new Path2D('M6,18 L22,10 L38,18 L38,34 L22,42 L6,34 Z');
    ctx.fillStyle='#b98c4a'; ctx.fill(body);
    ctx.strokeStyle='#7d5f2e'; ctx.lineWidth=1.3; ctx.stroke(body);
    // flaps
    const flapL = new Path2D('M6,18 L22,26 L22,10 Z');
    const flapR = new Path2D('M38,18 L22,26 L22,10 Z');
    ctx.fillStyle='#cfa162'; ctx.fill(flapL); ctx.fill(flapR); ctx.stroke(flapL); ctx.stroke(flapR);
    // tape
    ctx.fillStyle='#e9dfb1'; ctx.fillRect(21,10,2,16);
    ctx.restore();
  }

  function drawPalm(ctx, sx, sy, S){
    ctx.save();
    ctx.translate(sx, sy);
    ctx.scale(S/32, S/32);

    // trunk shadow
    ctx.fillStyle='rgba(0,0,0,0.15)';
    ctx.beginPath(); ctx.ellipse(14,28,7,3,0,0,Math.PI*2); ctx.fill();

    // trunk (arched)
    ctx.lineWidth=4;
    ctx.strokeStyle='#8B5A2B';
    ctx.beginPath();
    ctx.moveTo(14,28);
    ctx.bezierCurveTo(16,24,18,18,20,8);
    ctx.stroke();

    // trunk rings
    ctx.lineWidth=1.4; ctx.strokeStyle='rgba(255,255,255,0.18)';
    for(let y=24;y>=10;y-=2.2){
      ctx.beginPath();
      ctx.moveTo(13,y);
      ctx.lineTo(18,y-1.2);
      ctx.stroke();
    }

    // coconuts
    ctx.fillStyle='#5C3A1D';
    ctx.beginPath(); ctx.arc(22,10,2.2,0,Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(20,11.2,2.0,0,Math.PI*2); ctx.fill();

    // fronds
    function frond(ax,ay,bx,by,cx,cy){
      ctx.beginPath();
      ctx.moveTo(ax,ay);
      ctx.quadraticCurveTo(bx,by,cx,cy);
      ctx.quadraticCurveTo(bx,by,ax,ay);
      ctx.closePath();
      const g = ctx.createLinearGradient(ax,ay,cx,cy);
      g.addColorStop(0,'#2E8B57'); g.addColorStop(1,'#1E6B40');
      ctx.fillStyle=g; ctx.fill();
      ctx.strokeStyle='rgba(0,0,0,0.2)'; ctx.lineWidth=0.8; ctx.stroke();
    }
    frond(20,8,   6,0,    2,12);
    frond(20,8,   12,-3,  24,2);
    frond(20,8,   28,0,   36,12);
    frond(20,8,   30,12,  30,22);
    frond(20,8,   10,12,  10,22);
    ctx.restore();
  }

  function drawIsland(ctx){
    if(localStorage.getItem('izzaMapTier')!=='2') return;
    const S=api.DRAW, t=api.TILE;
    const {ISLAND, BUILDING, DOOR_GRID}=islandSpec();
    const sx=(x)=> (x*t - api.camera.x)*(S/t);
    const sy=(y)=> (y*t - api.camera.y)*(S/t);

    ctx.save();
    // sand patch (5×4 tiles)
    ctx.fillStyle='#d8c399';
    ctx.fillRect(sx(ISLAND.x0), sy(ISLAND.y0), (ISLAND.x1-ISLAND.x0+1)*S, (ISLAND.y1-ISLAND.y0+1)*S);

    // building 2×1
    ctx.fillStyle='#6f87b3';
    ctx.fillRect(sx(BUILDING.x0), sy(BUILDING.y0), (BUILDING.x1-BUILDING.x0+1)*S, (BUILDING.y1-BUILDING.y0+1)*S);

    // door: small brown inset on the south face; glow gold if near
    const near = isPlayerNearGrid(DOOR_GRID.x, DOOR_GRID.y, 1.0);
    const doorW = S*0.45, doorH = S*0.55;
    const doorX = sx(DOOR_GRID.x) + (S-doorW)/2;
    const doorY = sy(BUILDING.y1) + S - doorH;
    ctx.fillStyle = near ? '#d4a01e' : '#6e4a1e';
    ctx.fillRect(doorX, doorY, doorW, doorH);

    // palm tree in NW corner of island
    drawPalm(ctx, sx(ISLAND.x0)+S*0.7, sy(ISLAND.y0)+S*1.9, S);

    // cardboard box near HQ (only if not already taken)
    const taken = localStorage.getItem(BOX_TAKEN_KEY) === '1';
    if(!taken){
      const b=cardboardBoxGrid();
      const bx=(b.x*t - api.camera.x)*(S/t) + S*0.5;
      const by=(b.y*t - api.camera.y)*(S/t) + S*0.6;
      draw3DBox(ctx, bx, by, S);
    }

    ctx.restore();
  }

  function isPlayerNearGrid(gx,gy,maxDistTiles){
    const t=api.TILE, px=((api.player.x+16)/t)|0, py=((api.player.y+16)/t)|0;
    return Math.hypot(px-gx, py-gy) <= (maxDistTiles||1);
  }

  // ===== building collision =====
  function buildingSolid(){
    if(!api?.ready) return null;
    if(localStorage.getItem('izzaMapTier')!=='2') return null;
    const {BUILDING}=islandSpec();
    return { x:BUILDING.x0, y:BUILDING.y0, w:(BUILDING.x1-BUILDING.x0+1), h:(BUILDING.y1-BUILDING.y0+1) };
  }

  // ===== hooks =====
  // Draw island between map tiles and entities so it’s above water but below the player.
  IZZA.on('render-under', ()=>{
    if(!api?.ready) return;
    const ctx=document.getElementById('game').getContext('2d');
    drawIsland(ctx);
  });

  IZZA.on('update-post', ()=>{
    if(!api?.ready) return;
    // Keep the building solid
    const b=buildingSolid();
    if(b){
      const p=api.player, t=api.TILE, gx=((p.x+16)/t|0), gy=((p.y+16)/t|0);
      if(gx>=b.x && gx<b.x+b.w && gy>=b.y && gy<b.y+b.h){
        p.y = (b.y + b.h + 0.01)*t;
      }
    }
  });

  // ===== B actions =====
  function onB(e){
    if(!api?.ready) return;
    const t=api.TILE, gx=((api.player.x+16)/t|0), gy=((api.player.y+16)/t|0);

    // Box pickup
    const box=cardboardBoxGrid();
    const boxStillThere = localStorage.getItem(BOX_TAKEN_KEY) !== '1';
    if(boxStillThere && gx===box.x && gy===box.y){
      e?.preventDefault?.(); e?.stopPropagation?.(); e?.stopImmediatePropagation?.();
      if(getM4()==='not-started') setM4('started');
      showBoxYesNo(()=>{
        const inv=getInv();
        addCount(inv,'cardboard_box',1);
        setInv(inv);
        localStorage.setItem(BOX_TAKEN_KEY, '1');
        IZZA.toast?.('Cardboard Box added to Inventory');
      });
      return;
    }

    // Armoury door
    const {DOOR_GRID}=islandSpec();
    if(localStorage.getItem('izzaMapTier')==='2' && gx===DOOR_GRID.x && gy===DOOR_GRID.y){
      e?.preventDefault?.(); e?.stopPropagation?.(); e?.stopImmediatePropagation?.();
      const m=document.createElement('div');
      m.className='modal'; m.style.display='flex';
      m.innerHTML=`
        <div class="backdrop"></div>
        <div class="card" style="min-width:300px;max-width:520px">
          <h3>🛡️ Armoury</h3>
          <div style="line-height:1.5">
            Welcome to the <b>Armoury</b>! Here you can craft armour to reduce your opponents’ attacks on you.
          </div>
        </div>`;
      document.body.appendChild(m);
      m.querySelector('.backdrop').addEventListener('click',()=>m.remove(),{passive:true});
      return;
    }
  }

  // ===== boot =====
  IZZA.on('ready', (a)=>{
    api=a;
    const btnB=document.getElementById('btnB'); btnB?.addEventListener('click', onB, true);
    window.addEventListener('keydown', e=>{ if((e.key||'').toLowerCase()==='b') onB(e); }, {passive:false, capture:true});
    console.log('[mission4] ready', BUILD);
  });
})();
