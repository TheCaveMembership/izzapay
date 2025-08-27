(function(){
  const BUILD = 'v2-police-npc-attack-persist-1';
  console.log('[IZZA PLAY]', BUILD);

  const profile = window.__IZZA_PROFILE__ || {};
  const BODY   = profile.sprite_skin || "default";
  const HAIR   = profile.hair || "short";
  const OUTFIT = profile.outfit || "street";

  // ---------- Canvas & constants ----------
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

  // ---------- Hub ----------
  const bW=10, bH=6;
  const bX = Math.floor((unlocked.x0 + unlocked.x1)/2) - Math.floor(bW/2);
  const bY = unlocked.y0 + 5;
  const sidewalkY = bY + bH;
  const roadY     = sidewalkY + 1;
  const door = { gx: bX + Math.floor(bW/2), gy: sidewalkY };

  // ---------- Shop ----------
  const sbW=8, sbH=5;
  const sbX = bX + 16;
  const sbY = bY + 2;
  const sSidewalkY = sbY + sbH;
  const shopDoor = { gx: sbX + Math.floor(sbW/2), gy: sSidewalkY };
  const register = { gx: shopDoor.gx, gy: sSidewalkY };

  // ---------- Assets ----------
  function loadImg(src){
    return new Promise((res, rej)=>{
      const i=new Image(); i.onload=()=>res(i); i.onerror=()=>rej(new Error('load-failed:'+src)); i.src=src;
    });
  }
  const assetRoot = "/static/game/sprites";

  // Prefer "name 2.png", fallback "name.png"
  function loadLayer(kind, name){
    const fname2 = encodeURIComponent(name + ' 2');
    const with2  = `${assetRoot}/${kind}/${fname2}.png`;
    const base   = `${assetRoot}/${kind}/${encodeURIComponent(name)}.png`;
    return loadImg(with2).then(img=>({img, used:`${name} 2.png`})).catch(()=>{
      return loadImg(base).then(img=>({img, used:`${name}.png`}));
    });
  }

  // Police sprite (single set shared by all cops). Try police 2.png then police.png.
  function loadPolice(){
    const with2 = `${assetRoot}/police/${encodeURIComponent('police 2')}.png`;
    const base  = `${assetRoot}/police/${encodeURIComponent('police')}.png`;
    return loadImg(with2).then(img=>({img, cols:Math.max(1, Math.floor(img.width/32))}))
      .catch(()=>loadImg(base).then(img=>({img, cols:Math.max(1, Math.floor(img.width/32))})))
      .catch(()=>({img:null, cols:1})); // fallback to box draw
  }

  // ---------- Persistence ----------
  const SAVE_KEY = 'izza_save_v1';
  function saveState(){
    const data = {
      coins: player.coins,
      missionsCompleted: player.missionsCompleted,
      inventory: player.inventory
    };
    try{ localStorage.setItem(SAVE_KEY, JSON.stringify(data)); }catch(e){}
  }
  function loadState(){
    try{
      const s = localStorage.getItem(SAVE_KEY);
      if(!s) return;
      const d = JSON.parse(s);
      if (typeof d.coins==='number') player.coins = d.coins;
      if (typeof d.missionsCompleted==='number') player.missionsCompleted = d.missionsCompleted;
      if (Array.isArray(d.inventory)) player.inventory = d.inventory.slice(0,100);
    }catch(e){}
  }

  // ---------- Player ----------
  const player = {
    x: door.gx*TILE + (TILE/2 - 8),
    y: door.gy*TILE,
    vx: 0, vy: 0,
    speed: 2.0 * (TILE/16),
    wanted: 0,
    facing: 'down',
    moving: false,
    animTime: 0,
    coins: 300,
    missionsCompleted: 0,
    inventory: [],
    attacking: false,
    attackCooldown: 0,     // ms
    attackRange: TILE*0.9, // Manhattan-ish range check
    attackDamage: 1
  };

  function updateCoinUI(){
    const el = document.getElementById('coins');
    if (el) el.textContent = `${player.coins} IC`;
  }

  // ---------- Animation ----------
  // Sheets are ordered: down, RIGHT, LEFT, up
  const DIR_INDEX = { down:0, left:2, right:1, up:3 };
  const FRAME_W = 32, FRAME_H = 32;
  const WALK_FPS = 8, WALK_FRAME_MS = 1000 / WALK_FPS;

  const layerCols = { body:1, outfit:1, hair:1 }; // filled after load
  function getFrameCols(img){ return Math.max(1, Math.floor(img.width / FRAME_W)); }
  function currentFrame(cols, moving, animTime){
    if (cols <= 1) return 0;
    if (!moving)   return 1 % cols;
    return Math.floor(animTime / WALK_FRAME_MS) % cols;
  }

  // ---------- Input ----------
  const keys = Object.create(null);
  const btnA = document.getElementById('btnA');
  const btnB = document.getElementById('btnB');

  function handleB(){
    if (registerInRange()) openShop();
    else if (doorInRange()) openEnter();
    else setWanted(0);
  }

  function doAttack(){
    if (player.attackCooldown > 0) return;
    player.attacking = true;
    player.attackCooldown = 300; // ms
    // attacking civilians raises wanted
    let hitAny = attackNearbyNPC();
    if (hitAny) setWanted(player.wanted + 1);
    setTimeout(()=>{ player.attacking=false; }, 120);
  }

  window.addEventListener('keydown', e=>{
    const k = e.key.toLowerCase();
    keys[k] = true;
    if (k === 'b'){ e.preventDefault(); handleB(); }
    if (k === 'a'){ e.preventDefault(); doAttack(); }
  }, {passive:false});
  window.addEventListener('keyup', e=>{ keys[e.key.toLowerCase()] = false; });

  btnA.addEventListener('click', doAttack);
  btnB.addEventListener('click', handleB);

  // Joystick
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
  function nearTile(tx,ty, radius=2){
    const px = Math.floor((player.x + TILE/2)/TILE);
    const py = Math.floor((player.y + TILE/2)/TILE);
    return (Math.abs(px-tx)+Math.abs(py-ty))<=radius;
  }
  function doorInRange(){ return nearTile(door.gx, door.gy, 2); }
  function registerInRange(){ return nearTile(register.gx, register.gy, 2); }

  function openEnter(){
    const m = document.getElementById('enterModal');
    if (!m) return;
    m.style.display='flex';
  }

  // robust close wire-up (fixes your issue)
  (function wireModals(){
    const enter = document.getElementById('enterModal');
    const closeEnter = document.getElementById('closeEnter');
    if (closeEnter){
      closeEnter.addEventListener('click', (e)=>{ e.stopPropagation(); enter.style.display='none'; });
    }
    if (enter){
      enter.addEventListener('click', (e)=>{ if(e.target.classList.contains('backdrop')) enter.style.display='none'; });
    }
    const startTut = document.getElementById('startTutorial');
    if (startTut){
      startTut.addEventListener('click', (e)=>{ e.stopPropagation(); enter.style.display='none'; startTutorialMission(); });
    }
    const shop = document.getElementById('shopModal');
    const closeShopBtn = document.getElementById('closeShop');
    if (closeShopBtn){
      closeShopBtn.addEventListener('click', (e)=>{ e.stopPropagation(); shop.style.display='none'; });
    }
    if (shop){
      shop.addEventListener('click', (e)=>{ if(e.target.classList.contains('backdrop')) shop.style.display='none'; });
    }
  })();

  // ---------- SHOP ----------
  const SHOP_ITEMS = [
    { id:'bat',       name:'Baseball Bat',     price:50,   minMissions:0,  type:'weapon' },
    { id:'knuckles',  name:'Brass Knuckles',   price:75,   minMissions:0,  type:'weapon' },
    { id:'pistol',    name:'Pistol',           price:200,  minMissions:2,  type:'weapon' },
    { id:'ak',        name:'AK-47',            price:1000, minMissions:5,  type:'weapon' },
    { id:'bazooka',   name:'Bazooka',          price:2500, minMissions:8,  type:'weapon' },
    { id:'luxfit',    name:'Luxury Outfit',    price:500,  minMissions:3,  type:'outfit' },
  ];

  function openShop(){
    const modal = document.getElementById('shopModal');
    const list  = document.getElementById('shopList');
    const note  = document.getElementById('shopNote');
    list.innerHTML = '';

    SHOP_ITEMS.forEach(item=>{
      const locked = player.missionsCompleted < item.minMissions;
      const owned  = player.inventory.includes(item.id);
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
    if (!player.inventory.includes(item.id)){
      player.coins -= item.price;
      player.inventory.push(item.id);
      updateCoinUI();
      saveState();
    }
    e.target.textContent = 'Owned';
    e.target.disabled = true;
  });

  // ---------- NPCs (civilians) ----------
  const npcs = [];
  function spawnNPC(gx,gy){
    npcs.push({
      x: gx*TILE, y: gy*TILE,
      hp: 3, alive: true,
      vx: 0, vy: 0,
      wanderTimer: 0
    });
  }
  // seed a few
  for(let i=0;i<6;i++){
    const gx = (unlocked.x0+2) + Math.floor(Math.random()*(unlocked.x1-unlocked.x0-4));
    const gy = (unlocked.y0+6) + Math.floor(Math.random()*(unlocked.y1-unlocked.y0-8));
    spawnNPC(gx,gy);
  }

  function updateNPCs(dt){
    npcs.forEach(n=>{
      if(!n.alive) return;
      n.wanderTimer -= dt;
      if (n.wanderTimer<=0){
        // pick a random small step
        const a = Math.random()*Math.PI*2;
        n.vx = Math.cos(a) * 0.8 * (TILE/16);
        n.vy = Math.sin(a) * 0.8 * (TILE/16);
        n.wanderTimer = 30 + Math.random()*60;
      }
      // try move if not into solid
      let nx = n.x + n.vx*dt, ny = n.y + n.vy*dt;
      const gx = Math.floor(nx/TILE), gy = Math.floor(ny/TILE);
      if (!isSolid(gx,gy)){ n.x = nx; n.y = ny; } else { n.vx*=-0.3; n.vy*=-0.3; }
    });
  }

  function drawNPCs(){
    npcs.forEach(n=>{
      if(!n.alive) return;
      const dx = w2sX(n.x), dy = w2sY(n.y);
      const S = DRAW;
      ctx.fillStyle = '#e6d28f';
      ctx.fillRect(dx,dy,S,S);
      // tiny eyes
      ctx.fillStyle = '#000';
      ctx.fillRect(dx+S*0.30,dy+S*0.30,S*0.08,S*0.08);
      ctx.fillRect(dx+S*0.60,dy+S*0.30,S*0.08,S*0.08);
    });
  }

  // attack nearby npc
  function attackNearbyNPC(){
    let hit=false;
    const px = player.x + TILE/2, py = player.y + TILE/2;
    npcs.forEach(n=>{
      if(!n.alive) return;
      const d = Math.abs((n.x+TILE/2)-px) + Math.abs((n.y+TILE/2)-py);
      if (d <= player.attackRange){
        n.hp -= player.attackDamage;
        hit = true;
        if (n.hp<=0){
          n.alive = false;
          const gain = 20 + Math.floor(Math.random()*25);
          player.coins += gain;
          updateCoinUI();
          saveState();
        }
      }
    });
    return hit;
  }

  // ---------- Tutorial mission ----------
  let tutorialActive = false, tutorialTarget = null;
  function startTutorialMission(){
    if (tutorialActive) return;
    tutorialActive = true;
    // spawn dummy near HQ
    tutorialTarget = { x:(door.gx+3)*TILE, y:(door.gy+1)*TILE, hp:2, alive:true };
    alert('Tutorial started: Press A near the dummy to attack!');
  }
  function updateTutorial(dt){
    if (!tutorialActive || !tutorialTarget || !tutorialTarget.alive) return;
    // draw & check hits
    // we piggyback on attackNearbyNPC logic: also check dummy
    // check attack
    if (player.attacking){
      const px = player.x + TILE/2, py = player.y + TILE/2;
      const d = Math.abs((tutorialTarget.x+TILE/2)-px) + Math.abs((tutorialTarget.y+TILE/2)-py);
      if (d <= player.attackRange){
        tutorialTarget.hp -= player.attackDamage;
        if (tutorialTarget.hp<=0){
          tutorialTarget.alive=false;
          player.missionsCompleted += 1;
          player.coins += 50;
          updateCoinUI();
          saveState();
          alert('Tutorial complete! You earned 50 IC and unlocked more shop items.');
        }
      }
    }
  }
  function drawTutorial(){
    if (!tutorialActive || !tutorialTarget || !tutorialTarget.alive) return;
    const dx = w2sX(tutorialTarget.x), dy = w2sY(tutorialTarget.y);
    const S = DRAW;
    ctx.fillStyle = '#9cf59c';
    ctx.fillRect(dx,dy,S,S);
  }

  // ---------- Maps ----------
  const mini = document.getElementById('minimap');
  const mctx = mini.getContext('2d');
  const mapModal = document.getElementById('mapModal');
  const bigmap   = document.getElementById('bigmap');
  const bctx     = bigmap.getContext('2d');

  function drawCity(ctx2d, sx, sy){
    ctx2d.fillStyle = 'rgba(163,176,197,.25)';
    ctx2d.fillRect(preview.x0*sx, preview.y0*sy, (preview.x1-preview.x0+1)*sx, (preview.y1-preview.y0+1)*sy);

    ctx2d.fillStyle = '#1c293e';
    ctx2d.fillRect(unlocked.x0*sx, unlocked.y0*sy, (unlocked.x1-unlocked.x0+1)*sx, (unlocked.y1-unlocked.y0+1)*sy);

    ctx2d.fillStyle = '#788292';
    ctx2d.fillRect(preview.x0*sx, roadY*sy, (preview.x1-preview.x0+1)*sx, 1.4*sy);
    ctx2d.fillRect(door.gx*sx,    preview.y0*sy, 1.4*sx, (preview.y1-preview.y0+1)*sy);

    // hub
    ctx2d.fillStyle = '#7a3a3a'; ctx2d.fillRect(bX*sx, bY*sy, bW*sx, bH*sy);
    // shop
    ctx2d.fillStyle = '#3a6d7a'; ctx2d.fillRect(sbX*sx, sbY*sy, sbW*sx, sbH*sy);
  }

  function drawMini(){
    const sx = mini.width / W, sy = mini.height / H;
    mctx.fillStyle = '#000'; mctx.fillRect(0,0,mini.width,mini.height);
    drawCity(mctx, sx, sy);
    mctx.fillStyle = '#35f1ff';
    mctx.fillRect((player.x/TILE)*sx-1, (player.y/TILE)*sy-1, 2, 2);
  }

  function drawBig(){
    const sx = bigmap.width / W, sy = bigmap.height / H;
    bctx.fillStyle = '#000'; bctx.fillRect(0,0,bigmap.width,bigmap.height);
    drawCity(bctx, sx, sy);
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

    ctx.fillStyle = '#09371c';
    ctx.fillRect(screenX,screenY,S,S);

    // HUB
    if (gx>=bX && gx<bX+bW && gy>=bY && gy<bY+bH){
      ctx.fillStyle = '#4a2d2d'; ctx.fillRect(screenX,screenY,S,S);
      ctx.fillStyle = 'rgba(0,0,0,.15)'; ctx.fillRect(screenX,screenY,S,Math.floor(S*0.18));
    }
    // SHOP
    if (gx>=sbX && gx<sbX+sbW && gy>=sbY && gy<sbY+sbH){
      ctx.fillStyle = '#2b4850'; ctx.fillRect(screenX,screenY,S,S);
      ctx.fillStyle = 'rgba(0,0,0,.15)'; ctx.fillRect(screenX,screenY,S,Math.floor(S*0.18));
      // "SHOP" roof label (center tile of top row)
      if (gy === sbY && gx === Math.floor(sbX + sbW/2)){
        ctx.fillStyle = '#cfe9f7';
        ctx.font = `${Math.floor(S*0.35)}px monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText('SHOP', screenX + S/2, screenY + 2);
      }
    }

    // sidewalks
    if (gy===sidewalkY || gy===sSidewalkY){
      ctx.fillStyle = '#6a727b'; ctx.fillRect(screenX,screenY,S,S);
      ctx.strokeStyle = 'rgba(0,0,0,.25)'; ctx.strokeRect(screenX,screenY,S,S);
    }

    // road with dashed center
    if (gy===roadY){
      ctx.fillStyle = '#2a2a2a'; ctx.fillRect(screenX,screenY,S,S);
      ctx.fillStyle = '#ffd23f';
      for(let i=0;i<4;i++){
        ctx.fillRect(screenX + i*(S/4) + S*0.05, screenY + S*0.48, S*0.10, S*0.04);
      }
    }

    // HUB door
    if (gx===door.gx && gy===door.gy){
      const near = doorInRange();
      ctx.fillStyle = near ? '#39cc69' : '#49a4ff';
      const w = Math.floor(S*0.30), h = Math.floor(S*0.72);
      ctx.fillRect(screenX + (S-w)/2, screenY + (S-h), w, h);
      if(near){
        promptEl.style.left = (screenX + S/2) + 'px';
        promptEl.style.top  = (screenY - 8) + 'px';
        promptEl.textContent = 'Press B to enter';
        promptEl.style.display = 'block';
      }
    }

    // SHOP register marker
    if (gx===register.gx && gy===register.gy){
      const near = registerInRange();
      ctx.fillStyle = near ? '#39cc69' : '#49a4ff';
      ctx.fillRect(screenX + S*0.40, screenY + S*0.15, S*0.20, S*0.70);
      if(near){
        promptEl.style.left = (screenX + S/2) + 'px';
        promptEl.style.top  = (screenY - 8) + 'px';
        promptEl.textContent = 'Press B to shop';
        promptEl.style.display = 'block';
      }
    }
  }

  // ---------- Draw player (animated) ----------
  function drawPlayer(images){
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

    // simple attack flash
    if (player.attacking){
      ctx.strokeStyle = 'rgba(255,255,255,.6)';
      ctx.lineWidth = 2;
      ctx.strokeRect(dx+2,dy+2,S-4,S-4);
    }
  }

  // ---------- POLICE ----------
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
      speed: 1.7 * (TILE/16),
      vx: 0, vy: 0,
      frameTime: 0
    });
  }

  function maintainCops(){
    const need = desiredCopCount();
    if (cops.length < need){
      const toAdd = need - cops.length;
      for(let i=0;i<toAdd;i++) spawnCopAt(spawnPoints[(Math.random()*spawnPoints.length)|0]);
    } else if (cops.length > need){
      cops.length = need;
    }
    if (player.wanted<=0) cops.length = 0;
  }

  // simple separation to avoid stacking
  function copSeparation(){
    const MIN = TILE*0.6, PUSH = 0.02;
    for (let i=0;i<cops.length;i++){
      for (let j=i+1;j<cops.length;j++){
        const a=cops[i], b=cops[j];
        const dx=a.x-b.x, dy=a.y-b.y, d=Math.hypot(dx,dy)||1;
        if (d<MIN){
          const ux=dx/d, uy=dy/d, amt=(MIN-d)*PUSH;
          a.x += ux*amt; a.y += uy*amt;
          b.x -= ux*amt; b.y -= uy*amt;
        }
      }
    }
  }

  let policeSheet = {img:null, cols:1};
  function updateCops(dt){
    maintainCops();
    const ptx = player.x + TILE/2, pty = player.y + TILE/2;
    cops.forEach(c=>{
      const dx = ptx - c.x, dy = pty - c.y;
      const m  = Math.hypot(dx,dy) || 1;
      const vx = dx/m * c.speed * dt;
      const vy = dy/m * c.speed * dt;

      let nx = c.x + vx, ny = c.y + vy;
      const gx = Math.floor(nx/TILE), gy = Math.floor(ny/TILE);
      if (!isSolid(gx,gy)) { c.x = nx; c.y = ny; }
    });
    copSeparation();
  }

  function drawCops(){
    cops.forEach(c=>{
      const dx = w2sX(c.x), dy = w2sY(c.y);
      const S  = DRAW;
      if (policeSheet.img){
        // draw first frame of "down" row (or animate if you add rows later)
        ctx.drawImage(policeSheet.img, 0, 0, 32, 32, dx, dy, S, S);
      }else{
        // fallback: simple blue box with visor
        ctx.fillStyle = '#5ab0ff';
        ctx.fillRect(dx, dy, S, S);
        ctx.fillStyle = '#001a33';
        ctx.fillRect(dx, dy + S*0.25, S, S*0.15);
      }
    });
  }

  // ---------- Update & render ----------
  function update(dt){
    document.getElementById('prompt').style.display='none';

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

    // cooldowns
    if (player.attackCooldown>0) player.attackCooldown = Math.max(0, player.attackCooldown - dt*16.6667);

    // systems
    updateNPCs(dt);
    updateTutorial(dt);
    updateCops(dt);
  }

  function render(images){
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
    drawTutorial();
    drawCops();
    drawPlayer(images);
    drawMini();
  }

  // ---------- Boot ----------
  Promise.all([
    loadLayer('body',   BODY),
    loadLayer('outfit', OUTFIT),
    loadLayer('hair',   HAIR),
    loadPolice()
  ])
  .then(([b,o,h,p]){
    const body=b.img, outfit=o.img, hair=h.img;
    policeSheet = p;

    layerCols.body   = getFrameCols(body);
    layerCols.outfit = getFrameCols(outfit);
    layerCols.hair   = getFrameCols(hair);

    // Load persisted progress
    loadState();
    updateCoinUI();
    setWanted(player.wanted);

    const imgs = { body, outfit, hair };
    centerCamera();

    let last = performance.now();
    function loop(now){
      const dtMs = Math.min(32, now-last); last=now;
      update(dtMs/16.6667);
      render(imgs);
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
  })
  .catch(err=>console.error("Sprite load failed", err));
})();
