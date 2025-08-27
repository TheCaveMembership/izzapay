(function(){
  const BUILD = 'v2-police+shop+npc+tutorial+persist-1';
  console.log('[IZZA PLAY]', BUILD);

  // ---------- Profile / assets ----------
  const profile = window.__IZZA_PROFILE__ || {};
  const BODY   = profile.sprite_skin || "default";
  const HAIR   = profile.hair || "short";
  const OUTFIT = profile.outfit || "street";

  const cvs = document.getElementById('game');
  const ctx = cvs.getContext('2d');

  const TILE  = 32;
  const SCALE = 3;
  const DRAW  = TILE * SCALE;
  const SCALE_FACTOR = DRAW / TILE;

  const camera = {x:0,y:0};
  const w2sX = wx => (wx - camera.x) * SCALE_FACTOR;
  const w2sY = wy => (wy - camera.y) * SCALE_FACTOR;

  // ---------- World ----------
  const W = 90, H = 60;
  const unlocked = { x0: 18, y0: 18, x1: 72, y1: 42 };
  const preview  = { x0: 10, y0: 12, x1: 80, y1: 50 };
  const inRect   = (gx,gy,r)=> gx>=r.x0 && gx<=r.x1 && gy>=r.y0 && gy<=r.y1;
  const inUnlocked = (gx,gy)=> inRect(gx,gy, unlocked);

  // Hub
  const bW=10, bH=6;
  const bX = Math.floor((unlocked.x0 + unlocked.x1)/2) - Math.floor(bW/2);
  const bY = unlocked.y0 + 5;
  const sidewalkY = bY + bH;
  const roadY     = sidewalkY + 1;
  const door = { gx: bX + Math.floor(bW/2), gy: sidewalkY };

  // Shop (with register on sidewalk)
  const sbW=8, sbH=5;
  const sbX = bX + 16;
  const sbY = bY + 2;
  const sSidewalkY = sbY + sbH;
  const shopDoor   = { gx: sbX + Math.floor(sbW/2), gy: sSidewalkY };
  const register   = { gx: shopDoor.gx, gy: sSidewalkY };

  // ---------- Asset helpers ----------
  function loadImg(src){
    return new Promise((res, rej)=>{
      const i=new Image();
      i.onload = ()=>res(i);
      i.onerror= ()=>rej(new Error('load-failed:'+src));
      i.src = src;
    });
  }
  const assetRoot = "/static/game/sprites";

  // Prefer "name 2.png" (animated), fallback to "name.png".
  function loadLayer(kind, name){
    const fname2 = encodeURIComponent(name + ' 2');
    const with2  = `${assetRoot}/${kind}/${fname2}.png`;
    const base   = `${assetRoot}/${kind}/${encodeURIComponent(name)}.png`;
    return loadImg(with2).then(img=>({img, used:`${name} 2.png`}))
      .catch(()=> loadImg(base).then(img=>({img, used:`${name}.png`})));
  }

  // Police sprite (optional): /static/game/sprites/police/police 2.png
  let policeImg = null, policeCols = 1;
  const POLICE_FRAME_W = 32, POLICE_FRAME_H = 32;

  function tryLoadPolice(){
    const p2 = `${assetRoot}/police/${encodeURIComponent('police 2')}.png`;
    const p1 = `${assetRoot}/police/police.png`;
    return loadImg(p2).then(img=>{ policeImg=img; policeCols=Math.max(1, Math.floor(img.width/POLICE_FRAME_W)); })
      .catch(()=> loadImg(p1).then(img=>{ policeImg=img; policeCols=Math.max(1, Math.floor(img.width/POLICE_FRAME_W)); }))
      .catch(()=>{}); // fallback to box draw
  }

  // ---------- Player ----------
  const player = {
    x: door.gx*TILE + (TILE/2 - 8),
    y: door.gy*TILE,
    vx: 0, vy: 0,
    speed: 2.0 * (TILE/16),
    wanted: 0,
    facing: 'down',  // down,left,right,up
    moving: false,
    animTime: 0,
    coins: 300,
    missionsCompleted: 0,
    inventory: [],
    attackCooldown: 0
  };

  // ---------- Persistence ----------
  const SAVE_KEY = 'izza_save_v1';
  function saveGame(){
    const data = {
      coins: player.coins,
      missionsCompleted: player.missionsCompleted,
      inventory: player.inventory,
      body: BODY, hair: HAIR, outfit: OUTFIT
    };
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(data)); } catch(e){}
  }
  function loadGame(){
    try{
      const raw = localStorage.getItem(SAVE_KEY);
      if(!raw) return;
      const s = JSON.parse(raw);
      if (typeof s.coins === 'number') player.coins = s.coins;
      if (typeof s.missionsCompleted === 'number') player.missionsCompleted = s.missionsCompleted;
      if (Array.isArray(s.inventory)) player.inventory = s.inventory.slice(0, 200);
    } catch(e){}
  }
  loadGame();

  // (Optional server hook later)
  // POST /api/save -> write JSON to /var/data/<user_id>.json
  // Call saveGame() as now, and also fire fetch('/api/save', {method:'POST', body: JSON.stringify(data)})

  // HUD coin pill updater
  function updateCoinUI(){
    const el = document.getElementById('coins');
    if (el) el.textContent = `${player.coins} IC`;
  }

  // ---------- Animation ----------
  // Your sheets are ordered: down, RIGHT, LEFT, up
  const DIR_INDEX = { down:0, left:2, right:1, up:3 };
  const FRAME_W = 32, FRAME_H = 32;
  const WALK_FPS = 8, WALK_FRAME_MS = 1000 / WALK_FPS;

  const layerCols = { body:1, outfit:1, hair:1 };

  function getFrameCols(img){ return Math.max(1, Math.floor(img.width / FRAME_W)); }
  function currentFrame(cols, moving, animTime){
    if (cols <= 1) return 0;
    if (!moving)   return 1 % cols;
    return Math.floor(animTime / WALK_FRAME_MS) % cols;
  }

  // ---------- Input ----------
  const keys = Object.create(null);
  const btnA = document.getElementById('btnA'); // attack
  const btnB = document.getElementById('btnB'); // interact

  function attack(){
    if (player.attackCooldown > 0) return;
    player.attackCooldown = 18; // ~0.3s at 60fps
    // hit any NPC within 1 tile (diamond radius 1) in facing dir bias
    const hits = npcs.filter(n=> !n.dead && taxiDist(n.gx, n.gy, gridX(player.x), gridY(player.y)) <= 1);
    if (hits.length){
      hits.forEach(n=>{
        n.dead = true;
        player.coins += 20;
        player.wanted = Math.min(5, player.wanted + 1);
      });
      updateCoinUI();
      saveGame();
    }
  }

  function handleB(){
    if (registerInRange()) openShop();
    else if (doorInRange()) openHQ();
    else setWanted(0);
  }

  window.addEventListener('keydown', e=>{
    const k = e.key.toLowerCase();
    keys[k] = true;
    if (k === 'b'){ e.preventDefault(); handleB(); }
    if (k === 'a'){ e.preventDefault(); attack(); }
  }, {passive:false});
  window.addEventListener('keyup', e=>{ keys[e.key.toLowerCase()] = false; });

  btnA.addEventListener('click', attack);
  btnB.addEventListener('click', handleB);

  // ---------- Joystick ----------
  const stick = document.getElementById('stick');
  const nub   = document.getElementById('nub');
  let dragging=false, baseRect=null, vec={x:0,y:0};

  function setNub(dx,dy){
    const r=40, m=Math.hypot(dx,dy)||1, c=Math.min(m,r), ux=dx/m, uy=dy/m;
    nub.style.left=(40+ux*c)+'px'; nub.style.top=(40+uy*c)+'px';
    vec.x=(c/r)*ux; vec.y=(c/r)*uy;
  }
  function resetNub(){ nub.style.left='40px'; nub.style.top='40px'; vec.x=0; vec.y=0; }
  function startDrag(e){ dragging=true; baseRect=stick.getBoundingClientRect(); e.preventDefault(); }
  function moveDrag(e){
    if(!dragging) return;
    const t=e.touches?e.touches[0]:e;
    const cx=baseRect.left+baseRect.width/2, cy=baseRect.top+baseRect.height/2;
    setNub(t.clientX-cx,t.clientY-cy); e.preventDefault();
  }
  function endDrag(e){ dragging=false; resetNub(); if(e) e.preventDefault(); }
  stick.addEventListener('touchstart',startDrag,{passive:false});
  stick.addEventListener('touchmove', moveDrag, {passive:false});
  stick.addEventListener('touchend',  endDrag,  {passive:false});
  stick.addEventListener('mousedown', startDrag);
  window.addEventListener('mousemove',moveDrag);
  window.addEventListener('mouseup',  endDrag);

  // ---------- HUD ----------
  function setWanted(n){
    player.wanted = Math.max(0, Math.min(5, n|0));
    document.querySelectorAll('#stars .star').forEach((s,i)=> s.className='star' + (i<player.wanted?' on':'') );
    saveGame();
  }

  // ---------- Camera ----------
  function centerCamera(){
    const visW = cvs.width  / SCALE_FACTOR;
    const visH = cvs.height / SCALE_FACTOR;
    camera.x = player.x - visW/2;
    camera.y = player.y - visH/2;
    const maxX = (unlocked.x1+1)*TILE - visW;
    const maxY = (unlocked.y1+1)*TILE - visH;
    camera.x = Math.max(unlocked.x0*TILE, Math.min(camera.x, maxX));
    camera.y = Math.max(unlocked.y0*TILE, Math.min(camera.y, maxY));
  }

  // ---------- Collision ----------
  const isBuilding = (gx,gy)=> {
    const hub = gx>=bX && gx<bX+bW && gy>=bY && gy<bY+bH;
    const shop= gx>=sbX && gx<sbX+sbW && gy>=sbY && gy<sbY+sbH;
    return hub || shop;
  };
  function isSolid(gx,gy){
    if(!inUnlocked(gx,gy)) return true;
    if(isBuilding(gx,gy))  return true;
    return false;
  }
  function tryMove(nx,ny){
    const cx = [
      {x:nx, y:player.y}, {x:nx+TILE-1, y:player.y},
      {x:nx, y:player.y+TILE-1}, {x:nx+TILE-1, y:player.y+TILE-1}
    ];
    if(!cx.some(c=>isSolid(Math.floor(c.x/TILE), Math.floor(c.y/TILE)))) player.x = nx;

    const cy = [
      {x:player.x, y:ny}, {x:player.x+TILE-1, y:ny},
      {x:player.x, y:ny+TILE-1}, {x:player.x+TILE-1, y:ny+TILE-1}
    ];
    if(!cy.some(c=>isSolid(Math.floor(c.x/TILE), Math.floor(c.y/TILE)))) player.y = ny;
  }

  // ---------- Door / Register ----------
  const promptEl = document.getElementById('prompt');
  function gridX(px){ return Math.floor((px + TILE/2)/TILE); }
  function gridY(py){ return Math.floor((py + TILE/2)/TILE); }
  function taxiDist(ax,ay,bx,by){ return Math.abs(ax-bx)+Math.abs(ay-by); }
  function nearTile(tx,ty, radius=2){ return taxiDist(gridX(player.x), gridY(player.y), tx, ty) <= radius; }
  function doorInRange(){ return nearTile(door.gx, door.gy, 2); }
  function registerInRange(){ return nearTile(register.gx, register.gy, 2); }

  function openHQ(){
    const modal = document.getElementById('enterModal');
    if (!modal) return;
    modal.style.display='flex';
  }

  // fix: ensure close buttons always work (no propagation issues)
  const closeEnterBtn = document.getElementById('closeEnter');
  if (closeEnterBtn){
    closeEnterBtn.addEventListener('click', (e)=>{ e.stopPropagation(); document.getElementById('enterModal').style.display='none'; });
  }
  const enterModal = document.getElementById('enterModal');
  if (enterModal){
    enterModal.addEventListener('click', (e)=>{ if(e.target.classList.contains('backdrop')) e.currentTarget.style.display='none'; });
  }

  // ---------- Tutorial mission ----------
  const startTutBtn = document.getElementById('startTutorial');
  if (startTutBtn){
    startTutBtn.addEventListener('click', (e)=>{
      e.stopPropagation();
      document.getElementById('enterModal').style.display='none';
      startTutorialMission();
    });
  }

  let tutorial = { active:false, target:null }; // target is a dummy NPC
  function startTutorialMission(){
    tutorial.active = true;
    // spawn a dummy target near the hub sidewalk
    tutorial.target = { gx: door.gx+2, gy: sidewalkY, dead:false, color:'#ffe066' };
  }
  function checkTutorialProgress(){
    if (!tutorial.active || !tutorial.target) return;
    if (tutorial.target.dead){
      tutorial.active = false;
      player.missionsCompleted += 1;
      saveGame();
      updateShopNote();
      // small toast
      console.log('Tutorial complete! Missions:', player.missionsCompleted);
      alert('Tutorial complete! (+1 mission)');
    }
  }

  // ---------- NPCs ----------
  const npcs = [];
  function spawnNPC(){
    // somewhere on the sidewalk/road strip to keep it simple
    const gx = unlocked.x0 + 2 + ((Math.random() * (unlocked.x1 - unlocked.x0 - 4))|0);
    const gy = Math.random() < 0.6 ? sidewalkY : roadY;
    npcs.push({
      gx, gy, dead:false,
      t: 0,
      color:'#c9b0ff'
    });
  }
  for(let i=0;i<8;i++) spawnNPC();

  function updateNPCs(dt){
    npcs.forEach(n=>{
      if (n.dead) return;
      n.t -= dt;
      if (n.t <= 0){
        // random move one tile horizontally mostly, avoid buildings/locked
        const dir = (Math.random()<0.5)? -1 : 1;
        const nx = n.gx + dir, ny = n.gy;
        if (!isSolid(nx, ny)) { n.gx = nx; n.gy = ny; }
        n.t = 15 + Math.random()*30;
      }
    });
  }
  function drawNPCs(){
    npcs.forEach(n=>{
      if (n.dead) return;
      const dx = w2sX(n.gx*TILE), dy = w2sY(n.gy*TILE);
      ctx.fillStyle = n.color;
      ctx.fillRect(dx, dy, DRAW, DRAW);
    });

    if (tutorial.active && tutorial.target && !tutorial.target.dead){
      const t = tutorial.target;
      const dx = w2sX(t.gx*TILE), dy = w2sY(t.gy*TILE);
      ctx.fillStyle = t.color;
      ctx.fillRect(dx, dy, DRAW, DRAW);
      // label
      ctx.fillStyle = '#000';
      ctx.fillRect(dx+DRAW*0.25, dy+DRAW*0.1, DRAW*0.5, DRAW*0.18);
      ctx.fillStyle = '#fff';
      ctx.font = `${Math.floor(DRAW*0.14)}px monospace`;
      ctx.textAlign='center'; ctx.textBaseline='top';
      ctx.fillText('TUTOR', dx+DRAW*0.5, dy+DRAW*0.12);
    }
  }

  // ---------- SHOP ----------
  const SHOP_ITEMS = [
    { id:'bat',       name:'Baseball Bat',     price:50,   minMissions:0,  type:'weapon' },
    { id:'knuckles',  name:'Brass Knuckles',   price:75,   minMissions:0,  type:'weapon' },
    { id:'pistol',    name:'Pistol',           price:200,  minMissions:2,  type:'weapon' },
    { id:'ak',        name:'AK-47',            price:1000, minMissions:5,  type:'weapon' },
    { id:'bazooka',   name:'Bazooka',          price:2500, minMissions:8,  type:'weapon' },
    { id:'luxfit',    name:'Luxury Outfit',    price:500,  minMissions:3,  type:'outfit' },
  ];

  function itemOwned(id){ return player.inventory.includes(id); }

  function openShop(){
    const modal = document.getElementById('shopModal');
    const list  = document.getElementById('shopList');
    const note  = document.getElementById('shopNote');
    list.innerHTML = '';

    SHOP_ITEMS.forEach(item=>{
      const locked = player.missionsCompleted < item.minMissions;
      const owned  = itemOwned(item.id);
      const li = document.createElement('div');
      li.className = 'shop-item';
      li.innerHTML = `
        <div class="meta">
          <div class="name">${item.name}</div>
          <div class="sub">${item.price} IC ${locked ? `&middot; unlocks after ${item.minMissions} missions` : ''}</div>
        </div>
        <button class="buy" ${locked||owned?'disabled':''} data-id="${item.id}">${owned?'Owned':'Buy'}</button>
      `;
      list.appendChild(li);
    });

    note.textContent = `Missions completed: ${player.missionsCompleted}`;
    updateCoinUI();
    modal.style.display='flex';
  }

  function updateShopNote(){
    const note  = document.getElementById('shopNote');
    if (note) note.textContent = `Missions completed: ${player.missionsCompleted}`;
  }

  // Buy handling
  document.addEventListener('click', (e)=>{
    if (!e.target.classList.contains('buy')) return;
    const id = e.target.getAttribute('data-id');
    const item = SHOP_ITEMS.find(i=>i.id===id);
    if (!item) return;

    if (player.missionsCompleted < item.minMissions){
      alert(`Locked. Complete ${item.minMissions} missions to unlock.`);
      return;
    }
    if (player.coins < item.price){
      alert('Not enough IZZA Coin.');
      return;
    }
    player.coins -= item.price;
    player.inventory.push(item.id);
    updateCoinUI();
    saveGame();
    e.target.textContent = 'Owned';
    e.target.disabled = true;
  });

  // Close shop (ensure it always closes)
  const closeShopBtn = document.getElementById('closeShop');
  if (closeShopBtn){
    closeShopBtn.addEventListener('click', (e)=>{
      e.stopPropagation();
      document.getElementById('shopModal').style.display='none';
    });
    document.getElementById('shopModal').addEventListener('click', (e)=>{
      if(e.target.classList.contains('backdrop')) e.currentTarget.style.display='none';
    });
  }

  // ---------- Maps ----------
  const mini = document.getElementById('minimap');
  const mctx = mini.getContext('2d');
  const mapModal = document.getElementById('mapModal');
  const bigmap   = document.getElementById('bigmap');
  const bctx     = bigmap.getContext('2d');

  function drawCity(ctx2d, sx, sy){
    // preview
    ctx2d.fillStyle = 'rgba(163,176,197,.25)';
    ctx2d.fillRect(preview.x0*sx, preview.y0*sy, (preview.x1-preview.x0+1)*sx, (preview.y1-preview.y0+1)*sy);

    // unlocked
    ctx2d.fillStyle = '#1c293e';
    ctx2d.fillRect(unlocked.x0*sx, unlocked.y0*sy, (unlocked.x1-unlocked.x0+1)*sx, (unlocked.y1-unlocked.y0+1)*sy);

    // roads
    ctx2d.fillStyle = '#788292';
    ctx2d.fillRect(preview.x0*sx, roadY*sy, (preview.x1-preview.x0+1)*sx, 1.4*sy);
    ctx2d.fillRect(door.gx*sx, preview.y0*sy, 1.4*sx, (preview.y1-preview.y0+1)*sy);

    // hub
    ctx2d.fillStyle = '#7a3a3a';
    ctx2d.fillRect(bX*sx, bY*sy, bW*sx, bH*sy);

    // shop
    ctx2d.fillStyle = '#3a6d7a';
    ctx2d.fillRect(sbX*sx, sbY*sy, sbW*sx, sbH*sy);
  }

  function drawMini(){
    const sx = mini.width / W, sy = mini.height / H;
    mctx.fillStyle = '#000'; mctx.fillRect(0,0,mini.width,mini.height);
    drawCity(mctx, sx, sy);
    // Player
    mctx.fillStyle = '#35f1ff';
    mctx.fillRect((player.x/TILE)*sx-1, (player.y/TILE)*sy-1, 2, 2);
  }

  function drawBig(){
    const sx = bigmap.width / W, sy = bigmap.height / H;
    bctx.fillStyle = '#000'; bctx.fillRect(0,0,bigmap.width,bigmap.height);
    drawCity(bctx, sx, sy);
    // Player
    bctx.fillStyle = '#35f1ff';
    bctx.fillRect((player.x/TILE)*sx-1.5,(player.y/TILE)*sy-1.5,3,3);
  }

  document.getElementById('miniWrap').addEventListener('click', ()=>{ drawBig(); mapModal.style.display='flex'; });
  document.getElementById('closeMap').addEventListener('click', ()=> mapModal.style.display='none');
  mapModal.addEventListener('click', (e)=>{ if(e.target.classList.contains('backdrop')) mapModal.style.display='none'; });

  // ---------- Tiles ----------
  function drawTile(gx,gy){
    const S = DRAW;
    const screenX = w2sX(gx*TILE);
    const screenY = w2sY(gy*TILE);

    if(!inUnlocked(gx,gy)){ ctx.fillStyle='#000'; ctx.fillRect(screenX,screenY,S,S); return; }

    // ground
    ctx.fillStyle = '#09371c';
    ctx.fillRect(screenX,screenY,S,S);

    // hub
    if (gx>=bX && gx<bX+bW && gy>=bY && gy<bY+bH){
      ctx.fillStyle = '#4a2d2d'; ctx.fillRect(screenX,screenY,S,S);
      ctx.fillStyle = 'rgba(0,0,0,.15)'; ctx.fillRect(screenX,screenY,S,Math.floor(S*0.18));
    }
    // shop
    if (gx>=sbX && gx<sbX+sbW && gy>=sbY && gy<sbY+sbH){
      ctx.fillStyle = '#2b4850'; ctx.fillRect(screenX,screenY,S,S);
      ctx.fillStyle = 'rgba(0,0,0,.15)'; ctx.fillRect(screenX,screenY,S,Math.floor(S*0.18));
      if (gy === sbY){
        ctx.fillStyle = '#cfe9f7';
        ctx.font = `${Math.floor(S*0.35)}px monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        if (gx === Math.floor(sbX + sbW/2)){
          ctx.fillText('SHOP', screenX + S/2, screenY + 2);
        }
      }
    }

    // sidewalks
    if (gy===sidewalkY || gy===sSidewalkY){
      ctx.fillStyle = '#6a727b'; ctx.fillRect(screenX,screenY,S,S);
      ctx.strokeStyle = 'rgba(0,0,0,.25)'; ctx.strokeRect(screenX,screenY,S,S);
    }

    // road
    if (gy===roadY){
      ctx.fillStyle = '#2a2a2a'; ctx.fillRect(screenX,screenY,S,S);
      ctx.fillStyle = '#ffd23f';
      for(let i=0;i<4;i++){
        ctx.fillRect(screenX + i*(S/4) + S*0.05, screenY + S*0.48, S*0.10, S*0.04);
      }
    }

    // hub door
    if (gx===door.gx && gy===door.gy){
      const near = doorInRange();
      ctx.fillStyle = near ? '#39cc69' : '#49a4ff';
      const w = Math.floor(S*0.30), h = Math.floor(S*0.72);
      ctx.fillRect(screenX + (S-w)/2, screenY + (S-h), w, h);
      if(near){
        promptEl.textContent = 'Press B to enter';
        promptEl.style.left = (screenX + S/2) + 'px';
        promptEl.style.top  = (screenY - 8) + 'px';
        promptEl.style.display = 'block';
      }
    }

    // shop register prompt
    if (gx===register.gx && gy===register.gy){
      const near = registerInRange();
      ctx.fillStyle = near ? '#39cc69' : '#49a4ff';
      ctx.fillRect(screenX + S*0.40, screenY + S*0.15, S*0.20, S*0.70);
      if(near){
        promptEl.textContent = 'Press B to shop';
        promptEl.style.left = (screenX + S/2) + 'px';
        promptEl.style.top  = (screenY - 8) + 'px';
        promptEl.style.display = 'block';
      }
    }
  }

  // ---------- Draw player (animated) ----------
  const images = { body:null, outfit:null, hair:null };
  function drawPlayer(){
    const dirRow = DIR_INDEX[player.facing] || 0;

    const bodyCols   = layerCols.body;
    const outfitCols = layerCols.outfit;
    const hairCols   = layerCols.hair;

    const frameBody   = currentFrame(bodyCols,   player.moving, player.animTime);
    const frameOutfit = outfitCols > 1 ? currentFrame(outfitCols, player.moving, player.animTime) : 0;
    const frameHair   = hairCols > 1   ? currentFrame(hairCols,   player.moving, player.animTime) : 0;

    const sxBody   = frameBody   * FRAME_W;
    const sxOutfit = frameOutfit * FRAME_W;
    const sxHair   = frameHair   * FRAME_W;

    const sy = dirRow * FRAME_H;
    const dx = w2sX(player.x), dy = w2sY(player.y);
    const S  = DRAW;

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(images.body,   sxBody,   sy, FRAME_W, FRAME_H, dx, dy, S, S);
    ctx.drawImage(images.outfit, sxOutfit, sy, FRAME_W, FRAME_H, dx, dy, S, S);
    ctx.drawImage(images.hair,   sxHair,   sy, FRAME_W, FRAME_H, dx, dy, S, S);

    // attack swing hint
    if (player.attackCooldown > 0){
      ctx.strokeStyle = 'rgba(255,255,255,.7)';
      ctx.lineWidth = Math.max(1, S*0.05);
      ctx.beginPath();
      const cx = dx + S/2, cy = dy + S/2;
      const r  = S*0.55;
      let a0=0,a1=0;
      if (player.facing==='up'){ a0=-Math.PI*0.9; a1=-Math.PI*0.1; }
      if (player.facing==='down'){ a0=Math.PI*0.1; a1=Math.PI*0.9; }
      if (player.facing==='left'){ a0=Math.PI*0.6; a1=Math.PI*1.4; }
      if (player.facing==='right'){ a0=-Math.PI*0.4; a1=Math.PI*0.4; }
      ctx.arc(cx,cy,r,a0,a1);
      ctx.stroke();
    }
  }

  // ---------- POLICE (with separation + sprite) ----------
  const cops = [];
  const spawnPoints = [
    {gx: unlocked.x0+1, gy: sidewalkY},
    {gx: unlocked.x1-1, gy: sidewalkY},
    {gx: door.gx,       gy: unlocked.y0+1},
    {gx: door.gx,       gy: unlocked.y1-1},
  ];

  function desiredCopCount(){
    if (player.wanted <= 0) return 0;
    return Math.min(8, 1 + player.wanted * 2);
  }

  function spawnCopAt(sp){
    cops.push({
      x: sp.gx*TILE, y: sp.gy*TILE,
      speed: 1.65 * (TILE/16),
      anim: 0
    });
  }

  function maintainCops(){
    const need = desiredCopCount();
    if (cops.length < need){
      for(let i=0;i<need - cops.length;i++){
        spawnCopAt(spawnPoints[(Math.random()*spawnPoints.length)|0]);
      }
    } else if (cops.length > need){
      cops.length = need;
    }
    if (player.wanted<=0) cops.length = 0;
  }

  function updateCops(dt){
    maintainCops();
    const ptx = player.x + TILE/2, pty = player.y + TILE/2;

    // move toward player
    cops.forEach(c=>{
      const dx = ptx - c.x, dy = pty - c.y;
      const m  = Math.hypot(dx,dy) || 1;
      const vx = dx/m * c.speed * dt;
      const vy = dy/m * c.speed * dt;

      let nx = c.x + vx, ny = c.y + vy;
      const gx = Math.floor(nx/TILE), gy = Math.floor(ny/TILE);
      if (!isSolid(gx,gy)) { c.x = nx; c.y = ny; }

      c.anim += dt*0.5;
    });

    // simple separation to avoid stacking
    const minDist = TILE*0.75;
    for(let i=0;i<cops.length;i++){
      for(let j=i+1;j<cops.length;j++){
        const a=cops[i], b=cops[j];
        const dx=a.x-b.x, dy=a.y-b.y;
        const d=Math.hypot(dx,dy);
        if (d>0 && d<minDist){
          const push=(minDist-d)/2;
          const ux=dx/d, uy=dy/d;
          a.x += ux*push; a.y += uy*push;
          b.x -= ux*push; b.y -= uy*push;
        }
      }
    }
  }

  function drawCops(){
    for(const c of cops){
      const dx = w2sX(c.x), dy = w2sY(c.y);
      if (policeImg){
        // animate horizontally if multiple cols
        const frame = policeCols>1 ? Math.floor(c.anim*8)%policeCols : 0;
        ctx.drawImage(policeImg, frame*POLICE_FRAME_W, 0, POLICE_FRAME_W, POLICE_FRAME_H, dx, dy, DRAW, DRAW);
      } else {
        // fallback box + hat
        ctx.fillStyle = '#0d2b4d'; // navy
        ctx.fillRect(dx, dy, DRAW, DRAW);
        ctx.fillStyle = '#07203a';
        ctx.fillRect(dx, dy, DRAW, DRAW*0.25); // hat band
        ctx.fillStyle = '#c8d9ff';
        ctx.fillRect(dx+DRAW*0.25, dy+DRAW*0.22, DRAW*0.5, DRAW*0.08); // visor stripe
      }
    }
  }

  // ---------- Update & render ----------
  function update(dt){
    document.getElementById('prompt').style.display='none';
    if (player.attackCooldown>0) player.attackCooldown--;

    let dx=0, dy=0;
    if(keys['arrowup']||keys['w']) dy-=1;
    if(keys['arrowdown']||keys['s']) dy+=1;
    if(keys['arrowleft']||keys['a']) dx-=1;
    if(keys['arrowright']||keys['d']) dx+=1;
    dx += vec.x; dy += vec.y;

    const mag=Math.hypot(dx,dy);
    const vx = mag ? (dx/mag)*player.speed : 0;
    const vy = mag ? (dy/mag)*player.speed : 0;

    if (mag > 0.01){
      if (Math.abs(dy) >= Math.abs(dx)) player.facing = dy < 0 ? 'up' : 'down';
      else                              player.facing = dx < 0 ? 'left' : 'right';
    }
    player.moving = (mag > 0.01);

    tryMove(player.x + vx*dt, player.y + vy*dt);
    centerCamera();
    if (player.moving) player.animTime += (dt * 16.6667);

    // NPCs and tutorial
    updateNPCs(dt);
    if (tutorial.active && tutorial.target && !tutorial.target.dead){
      // if player attacks near tutorial target, mark dead
      if (player.attackCooldown === 17){ // just triggered
        if (taxiDist(tutorial.target.gx, tutorial.target.gy, gridX(player.x), gridY(player.y)) <= 1){
          tutorial.target.dead = true;
        }
      }
    }
    checkTutorialProgress();

    // cops
    updateCops(dt);
  }

  function render(){
    ctx.fillStyle='#000'; ctx.fillRect(0,0,cvs.width,cvs.height);

    const tilesX = Math.ceil(cvs.width  / DRAW) + 2;
    const tilesY = Math.ceil(cvs.height / DRAW) + 2;
    const startX = Math.max(0, Math.floor(camera.x / TILE));
    const startY = Math.max(0, Math.floor(camera.y / TILE));

    for(let y=0;y<tilesY;y++){
      for(let x=0;x<tilesX;x++){
        const gx = startX + x, gy = startY + y;
        if(gx>=0 && gx<W && gy>=0 && gy<H) drawTile(gx,gy);
      }
    }
    drawNPCs();
    drawCops();
    drawPlayer();
    drawMini();
  }

  // ---------- Boot ----------
  Promise.all([
    loadLayer('body',   BODY),
    loadLayer('outfit', OUTFIT),
    loadLayer('hair',   HAIR),
    tryLoadPolice().catch(()=>{})
  ])
  .then(([b,o,h])=>{
    images.body=b.img; images.outfit=o.img; images.hair=h.img;
    layerCols.body   = getFrameCols(images.body);
    layerCols.outfit = getFrameCols(images.outfit);
    layerCols.hair   = getFrameCols(images.hair);

    updateCoinUI(); setWanted(player.wanted);
    centerCamera();

    let last = performance.now();
    function loop(now){
      const dtMs = Math.min(32, now-last); last=now;
      update(dtMs/16.6667);
      render();
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
  })
  .catch(err=>console.error("Sprite load failed", err));

})();
