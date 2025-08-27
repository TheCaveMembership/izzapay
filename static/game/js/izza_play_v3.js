(function(){
  const BUILD = 'v3-npcCars-peds-combat-police-tutorial-persist';
  console.log('[IZZA PLAY]', BUILD);

  // ---------- Profile / assets ----------
  const profile = window.__IZZA_PROFILE__ || {};
  const BODY   = profile.sprite_skin || "default";
  const HAIR   = profile.hair || "short";
  const OUTFIT = profile.outfit || "street";

  // ---------- Canvas ----------
  const cvs = document.getElementById('game');
  const ctx = cvs.getContext('2d');
  const TILE  = 32, SCALE = 3, DRAW = TILE*SCALE, SCALE_FACTOR = DRAW/TILE;

  const camera = {x:0,y:0};
  const w2sX = wx => (wx - camera.x) * SCALE_FACTOR;
  const w2sY = wy => (wy - camera.y) * SCALE_FACTOR;

  // ---------- World ----------
  const W=90,H=60;
  const unlocked = { x0: 18, y0: 18, x1: 72, y1: 42 };
  const preview  = { x0: 10, y0: 12, x1: 80, y1: 50 };
  const inRect=(gx,gy,r)=> gx>=r.x0 && gx<=r.x1 && gy>=r.y0 && gy<=r.y1;
  const inUnlocked=(gx,gy)=> inRect(gx,gy,unlocked);

  // Hub
  const bW=10,bH=6;
  const bX = Math.floor((unlocked.x0 + unlocked.x1)/2) - Math.floor(bW/2);
  const bY = unlocked.y0 + 5;
  const sidewalkY = bY + bH;        // hub sidewalk
  const roadY     = sidewalkY + 1;  // hub road

  // Shop (simple)
  const sbW=8,sbH=5, sbX=bX+16, sbY=bY+2, sSidewalkY=sbY+sbH;
  const shopDoor={ gx: sbX + Math.floor(sbW/2), gy: sSidewalkY };
  const register={ gx: shopDoor.gx, gy: sSidewalkY };

  // Hub door
  const door = { gx: bX + Math.floor(bW/2), gy: sidewalkY };

  // Intersection (vertical at door, horizontal at road)
  const intersection = { gx: door.gx, gy: roadY };

  // ---------- Assets ----------
  function loadImg(src){ return new Promise((res,rej)=>{ const i=new Image(); i.onload=()=>res(i); i.onerror=()=>rej(new Error('load:'+src)); i.src=src; }); }
  const assetRoot = "/static/game/sprites";
  function loadLayer(kind,name){
    const with2  = `${assetRoot}/${kind}/${encodeURIComponent(name+' 2')}.png`;
    const base   = `${assetRoot}/${kind}/${encodeURIComponent(name)}.png`;
    return loadImg(with2).then(img=>({img,used:`${name} 2.png`}))
      .catch(()=>loadImg(base).then(img=>({img,used:`${name}.png`})));
  }

  // Police / SWAT / Military (optional sheets)
  let policeImg=null, swatImg=null, armyImg=null;
  let policeCols=1, swatCols=1, armyCols=1;
  const ENFORCE_W=32, ENFORCE_H=32;
  function tryLoad(pathBase){
    const p2 = `${assetRoot}/${pathBase}/${encodeURIComponent(pathBase.split('/').pop()+' 2')}.png`;
    const p1 = `${assetRoot}/${pathBase}/${pathBase.split('/').pop()}.png`;
    return loadImg(p2).catch(()=>loadImg(p1));
  }
  function tryLoadForces(){
    return Promise.allSettled([
      tryLoad('police/police').then(img=>{ policeImg=img; policeCols=Math.max(1,Math.floor(img.width/ENFORCE_W)); }),
      tryLoad('police/swat').then(img=>{ swatImg=img; swatCols=Math.max(1,Math.floor(img.width/ENFORCE_W)); }),
      tryLoad('police/army').then(img=>{ armyImg=img; armyCols=Math.max(1,Math.floor(img.width/ENFORCE_W)); })
    ]).catch(()=>{});
  }

  // ---------- Player ----------
  const player = {
    x: door.gx*TILE + (TILE/2 - 8),
    y: door.gy*TILE,
    speed: 2.0*(TILE/16),
    facing: 'down',
    moving: false,
    animTime: 0,
    wanted: 0,
    coins: 300,
    missionsCompleted: 0,
    inventory: [],
    attackCooldown: 0
  };

  // ---------- Persistence ----------
  const SAVE_KEY='izza_save_v1';
  function saveGame(){
    try{
      localStorage.setItem(SAVE_KEY, JSON.stringify({
        coins:player.coins,
        missionsCompleted:player.missionsCompleted,
        inventory:player.inventory
      }));
    }catch(e){}
  }
  function loadGame(){
    try{
      const s=JSON.parse(localStorage.getItem(SAVE_KEY)||'null');
      if(!s) return;
      if(typeof s.coins==='number') player.coins=s.coins;
      if(typeof s.missionsCompleted==='number') player.missionsCompleted=s.missionsCompleted;
      if(Array.isArray(s.inventory)) player.inventory=s.inventory.slice(0,200);
    }catch(e){}
  }
  loadGame();

  // HUD helpers
  function updateCoinUI(){ const el=document.getElementById('coins'); if(el) el.textContent = `${player.coins} IC`; }
  function setWanted(n){
    player.wanted = Math.max(0, Math.min(5, n|0));
    document.querySelectorAll('#stars .star').forEach((s,i)=> s.className='star' + (i<player.wanted?' on':'') );
    saveGame();
  }

  // ---------- Animation (player) ----------
  // Sheet rows order: down, RIGHT, LEFT, up
  const DIR_INDEX = { down:0, left:2, right:1, up:3 };
  const FRAME_W=32, FRAME_H=32, WALK_FPS=8, WALK_MS=1000/WALK_FPS;
  const layerCols={ body:1,outfit:1,hair:1 };
  function getCols(img){ return Math.max(1, Math.floor(img.width/FRAME_W)); }
  function currentFrame(cols,moving,t){ if(cols<=1) return 0; if(!moving) return 1%cols; return Math.floor(t/WALK_MS)%cols; }

  // ---------- Input ----------
  const keys=Object.create(null);
  const btnA=document.getElementById('btnA'); // attack
  const btnB=document.getElementById('btnB'); // interact
  window.addEventListener('keydown',e=>{
    const k=e.key.toLowerCase(); keys[k]=true;
    if(k==='b'){ e.preventDefault(); handleB(); }
    if(k==='a'){ e.preventDefault(); attack(); }
  },{passive:false});
  window.addEventListener('keyup',e=>{ keys[e.key.toLowerCase()]=false; });
  btnA.addEventListener('click', attack);
  btnB.addEventListener('click', handleB);

  // Joystick
  const stick=document.getElementById('stick'), nub=document.getElementById('nub');
  let dragging=false, baseRect=null, vec={x:0,y:0};
  function setNub(dx,dy){ const r=40,m=Math.hypot(dx,dy)||1,c=Math.min(m,r),ux=dx/m,uy=dy/m; nub.style.left=(40+ux*c)+'px'; nub.style.top=(40+uy*c)+'px'; vec.x=(c/r)*ux; vec.y=(c/r)*uy; }
  function resetNub(){ nub.style.left='40px'; nub.style.top='40px'; vec.x=0; vec.y=0; }
  function startDrag(e){ dragging=true; baseRect=stick.getBoundingClientRect(); e.preventDefault(); }
  function moveDrag(e){ if(!dragging)return; const t=e.touches?e.touches[0]:e; const cx=baseRect.left+baseRect.width/2, cy=baseRect.top+baseRect.height/2; setNub(t.clientX-cx,t.clientY-cy); e.preventDefault(); }
  function endDrag(e){ dragging=false; resetNub(); if(e) e.preventDefault(); }
  stick.addEventListener('touchstart',startDrag,{passive:false});
  stick.addEventListener('touchmove',moveDrag,{passive:false});
  stick.addEventListener('touchend',endDrag,{passive:false});
  stick.addEventListener('mousedown',startDrag);
  window.addEventListener('mousemove',moveDrag);
  window.addEventListener('mouseup',endDrag);

  // ---------- Utility ----------
  function gridX(px){ return Math.floor((px + TILE/2)/TILE); }
  function gridY(py){ return Math.floor((py + TILE/2)/TILE); }
  function taxi(ax,ay,bx,by){ return Math.abs(ax-bx)+Math.abs(ay-by); }
  function nearTile(tx,ty,r=2){ return taxi(gridX(player.x),gridY(player.y),tx,ty) <= r; }

  // ---------- Doors / Prompts ----------
  const promptEl=document.getElementById('prompt');
  function doorInRange(){ return nearTile(door.gx,door.gy,2); }
  function registerInRange(){ return nearTile(register.gx,register.gy,2); }

  function openHQ(){ document.getElementById('enterModal').style.display='flex'; }
  (function wireHQClose(){
    const close=document.getElementById('closeEnter');
    const modal=document.getElementById('enterModal');
    if(close) close.addEventListener('click',(e)=>{ e.stopPropagation(); modal.style.display='none'; });
    if(modal) modal.addEventListener('click',(e)=>{ if(e.target.classList.contains('backdrop')) modal.style.display='none'; });
  })();

  // Tutorial flow
  const startTut=document.getElementById('startTutorial');
  let tutorial={ active:false, phase:0, target:null, cop:null, timer:0 };
  if(startTut) startTut.addEventListener('click',(e)=>{
    e.stopPropagation();
    document.getElementById('enterModal').style.display='none';
    tutorial.active=true; tutorial.phase=1; // 1: hit ped, 2: eliminate cop in 30s
    tutorial.target = spawnPedNear(door.gx+2, sidewalkY);
    showToast('Tutorial: Press A to hit the pedestrian (3 hits to knock down, then 1 to finish).');
  });

  function handleB(){
    if (registerInRange()) openShop();
    else if (doorInRange()) openHQ();
    else setWanted(0);
  }

  // ---------- Shop ----------
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
    const modal=document.getElementById('shopModal');
    const list =document.getElementById('shopList');
    const note =document.getElementById('shopNote');
    list.innerHTML='';

    SHOP_ITEMS.forEach(item=>{
      const locked = player.missionsCompleted < item.minMissions;
      const owned  = itemOwned(item.id);
      const li=document.createElement('div');
      li.className='shop-item';
      li.innerHTML=`
        <div class="meta">
          <div class="name">${item.name}</div>
          <div class="sub">${item.price} IC ${locked?`· unlocks after ${item.minMissions} missions`:''}</div>
        </div>
        <button class="buy" ${locked||owned?'disabled':''} data-id="${item.id}">${owned?'Owned':'Buy'}</button>
      `;
      list.appendChild(li);
    });
    note.textContent = `Missions completed: ${player.missionsCompleted}`;
    updateCoinUI();
    modal.style.display='flex';
  }
  document.addEventListener('click',(e)=>{
    if (!e.target.classList.contains('buy')) return;
    const id=e.target.getAttribute('data-id');
    const item=SHOP_ITEMS.find(i=>i.id===id); if(!item) return;
    if (player.missionsCompleted < item.minMissions){ alert(`Locked. Complete ${item.minMissions} missions.`); return; }
    if (player.coins < item.price){ alert('Not enough IZZA Coin.'); return; }
    player.coins -= item.price;
    if (!itemOwned(item.id)) player.inventory.push(item.id);
    saveGame(); updateCoinUI();
    e.target.textContent='Owned'; e.target.disabled=true;
  });
  (function wireShopClose(){
    const btn=document.getElementById('closeShop'), modal=document.getElementById('shopModal');
    if(btn) btn.addEventListener('click',(e)=>{ e.stopPropagation(); modal.style.display='none'; updateCoinUI(); });
    if(modal) modal.addEventListener('click',(e)=>{ if(e.target.classList.contains('backdrop')){ modal.style.display='none'; updateCoinUI(); }});
  })();

  // ---------- Tiles ----------
  function isBuilding(gx,gy){
    const hub = gx>=bX && gx<bX+bW && gy>=bY && gy<bY+bH;
    const shop= gx>=sbX && gx<sbX+sbW && gy>=sbY && gy<sbY+sbH;
    return hub || shop;
  }
  function isSolid(gx,gy){ if(!inUnlocked(gx,gy)) return true; if(isBuilding(gx,gy)) return true; return false; }

  function drawTile(gx,gy){
    const S=DRAW, x=w2sX(gx*TILE), y=w2sY(gy*TILE);
    if(!inUnlocked(gx,gy)){ ctx.fillStyle='#000'; ctx.fillRect(x,y,S,S); return; }
    ctx.fillStyle='#09371c'; ctx.fillRect(x,y,S,S);

    // hub
    if(gx>=bX && gx<bX+bW && gy>=bY && gy<bY+bH){
      ctx.fillStyle='#4a2d2d'; ctx.fillRect(x,y,S,S);
      ctx.fillStyle='rgba(0,0,0,.15)'; ctx.fillRect(x,y,S,Math.floor(S*0.18));
    }
    // shop
    if(gx>=sbX && gx<sbX+sbW && gy>=sbY && gy<sbY+sbH){
      ctx.fillStyle='#2b4850'; ctx.fillRect(x,y,S,S);
      ctx.fillStyle='rgba(0,0,0,.15)'; ctx.fillRect(x,y,S,Math.floor(S*0.18));
      if (gy===sbY){
        ctx.fillStyle='#cfe9f7';
        ctx.font=`${Math.floor(S*0.35)}px monospace`;
        ctx.textAlign='center'; ctx.textBaseline='top';
        if (gx===Math.floor(sbX+sbW/2)){ ctx.fillText('SHOP', x+S/2, y+2); }
      }
    }

    // sidewalks
    if(gy===sidewalkY || gy===sSidewalkY){
      ctx.fillStyle='#6a727b'; ctx.fillRect(x,y,S,S);
      ctx.strokeStyle='rgba(0,0,0,.25)'; ctx.strokeRect(x,y,S,S);
    }
    // road + center line
    if(gy===roadY){
      ctx.fillStyle='#2a2a2a'; ctx.fillRect(x,y,S,S);
      ctx.fillStyle='#ffd23f'; for(let i=0;i<4;i++){ ctx.fillRect(x + i*(S/4) + S*0.05, y+S*0.48, S*0.10, S*0.04); }
    }

    // hub door prompt
    if (gx===door.gx && gy===door.gy){
      const near=doorInRange();
      ctx.fillStyle=near?'#39cc69':'#49a4ff';
      const w=Math.floor(S*0.30), h=Math.floor(S*0.72);
      ctx.fillRect(x + (S-w)/2, y + (S-h), w, h);
      if(near){ promptEl.textContent='Press B to enter'; promptEl.style.left=(x+S/2)+'px'; promptEl.style.top=(y-8)+'px'; promptEl.style.display='block'; }
    }
    // register prompt
    if (gx===register.gx && gy===register.gy){
      const near=registerInRange();
      ctx.fillStyle=near?'#39cc69':'#49a4ff';
      ctx.fillRect(x+S*0.40,y+S*0.15,S*0.20,S*0.70);
      if(near){ promptEl.textContent='Press B to shop'; promptEl.style.left=(x+S/2)+'px'; promptEl.style.top=(y-8)+'px'; promptEl.style.display='block'; }
    }
  }

  // ---------- Player movement ----------
  function centerCamera(){
    const visW=cvs.width/SCALE_FACTOR, visH=cvs.height/SCALE_FACTOR;
    camera.x=Math.max(unlocked.x0*TILE, Math.min(player.x - visW/2, (unlocked.x1+1)*TILE - visW));
    camera.y=Math.max(unlocked.y0*TILE, Math.min(player.y - visH/2, (unlocked.y1+1)*TILE - visH));
  }
  function tryMove(nx,ny){
    const cornersX=[{x:nx,y:player.y},{x:nx+TILE-1,y:player.y},{x:nx,y:player.y+TILE-1},{x:nx+TILE-1,y:player.y+TILE-1}];
    if(!cornersX.some(c=>isSolid(Math.floor(c.x/TILE),Math.floor(c.y/TILE)))) player.x=nx;
    const cornersY=[{x:player.x,y:ny},{x:player.x+TILE-1,y:ny},{x:player.x,y:ny+TILE-1},{x:player.x+TILE-1,y:ny+TILE-1}];
    if(!cornersY.some(c=>isSolid(Math.floor(c.x/TILE),Math.floor(c.y/TILE)))) player.y=ny;
  }

  // ---------- NPC pedestrians ----------
  const peds=[];
  function spawnPedNear(gx,gy){
    const ped={ gx, gy, hp:3, knocked:false, blink:0, dead:false, t:0, crossing:false };
    peds.push(ped); return ped;
  }
  function spawnPedRandom(){
    const gx = unlocked.x0+2+((Math.random()*(unlocked.x1-unlocked.x0-4))|0);
    const gy = Math.random()<0.6 ? sidewalkY : sSidewalkY;
    spawnPedNear(gx,gy);
  }
  for(let i=0;i<10;i++) spawnPedRandom();

  function updatePeds(dt){
    peds.forEach(p=>{
      if(p.dead) return;
      if(p.knocked){
        // waiting for finishing hit; blink timer
        p.blink = (p.blink+dt)%12;
        return;
      }
      p.t -= dt;
      if(p.t<=0){
        // 70% walk along current sidewalk; 30% cross at intersection column
        if (Math.random()<0.3){
          // try cross if on sidewalk row and near intersection gx
          if ((p.gy===sidewalkY || p.gy===sSidewalkY) && Math.abs(p.gx - intersection.gx)<=1){
            const targetRow = (p.gy===sidewalkY)? sSidewalkY : sidewalkY;
            // cross one tile toward target row if not solid
            const ny = p.gy + Math.sign(targetRow - p.gy);
            if(!isSolid(p.gx, ny)) p.gy = ny;
          }
        } else {
          const dir = (Math.random()<0.5)? -1:1;
          const nx = p.gx + dir;
          if(!isSolid(nx,p.gy)) p.gx = nx;
        }
        p.t = 10 + Math.random()*25;
      }
    });
  }
  function drawPeds(){
    peds.forEach(p=>{
      if(p.dead) return;
      const dx=w2sX(p.gx*TILE), dy=w2sY(p.gy*TILE);
      if (p.knocked){
        // knocked body darker + blink
        const vis = p.blink < 6;
        if (vis){ ctx.fillStyle='#876'; ctx.fillRect(dx, dy+DRAW*0.25, DRAW, DRAW*0.5); }
      } else {
        ctx.fillStyle='#c9b0ff';
        ctx.fillRect(dx, dy, DRAW, DRAW);
      }
    });
  }

  // ---------- NPC Cars ----------
  const cars=[];
  function spawnCar(){
    const leftToRight = Math.random()<0.5;
    const gx = leftToRight ? unlocked.x0-1 : unlocked.x1+1;
    const car = {
      x: gx*TILE, y: roadY*TILE,
      vx: (leftToRight? 1:-1) * (2.2*(TILE/16)), // a bit faster than cops
      w: DRAW, h: DRAW*0.6, color:'#8aa0b8'
    };
    cars.push(car);
  }
  let carTimer=0;
  function updateCars(dt){
    carTimer -= dt;
    if (carTimer<=0){ spawnCar(); carTimer = 90 + Math.random()*90; }
    for (let i=cars.length-1;i>=0;i--){
      const c=cars[i];
      c.x += c.vx*dt;
      const gx=Math.floor(c.x/TILE);
      if (gx < unlocked.x0-3 || gx > unlocked.x1+3) cars.splice(i,1);
    }
  }
  function drawCars(){
    cars.forEach(c=>{
      const dx=w2sX(c.x), dy=w2sY(c.y)+DRAW*0.2;
      ctx.fillStyle=c.color; ctx.fillRect(dx,dy,c.w,c.h);
      ctx.fillStyle='#ddd'; ctx.fillRect(dx+c.w*0.1, dy+c.h*0.2, c.w*0.12, c.h*0.2);
      ctx.fillRect(dx+c.w*0.78, dy+c.h*0.2, c.w*0.12, c.h*0.2);
    });
  }

  // ---------- Combat ----------
  function attack(){
    if(player.attackCooldown>0) return;
    player.attackCooldown = 18; // ~0.3s
    const pgx=gridX(player.x), pgy=gridY(player.y);

    // Try pedestrians in radius 1
    let hitSomeone=false;
    peds.forEach(p=>{
      if(p.dead) return;
      if (taxi(pgx,pgy,p.gx,p.gy) <= 1){
        hitSomeone=true;
        // hitting a human increases wanted and can spawn police (rules below)
        if (!p.knocked){
          p.hp -= 1;
          onHumanHit();
          if (p.hp<=0){ p.knocked=true; p.blink=0; }
        } else {
          // finishing blow → eliminate → reward
          p.dead=true;
          player.coins += 20;
          updateCoinUI(); saveGame();
        }
      }
    });

    // Try hitting cops in radius 1
    cops.forEach(c=>{
      if (taxi(pgx,pgy, gridX(c.x),gridY(c.y))<=1){
        c.hp -= 1; c.lastHitAt = nowMs;
        if (c.hpHitCount!==undefined) c.hpHitCount++; else c.hpHitCount=1;
        // rule: hit a cop twice -> sometimes spawn another
        if (c.hpHitCount===2 && Math.random()<0.5) maybeSpawnReinforcement();
        if (c.hp<=0){
          c.dead=true; c.reinforceCancel=true; // prevent his 30s timer from firing
          // if killed within 30s, no new cop from this one (handled by reinforceCancel)
          player.coins += 30; updateCoinUI(); saveGame();
        }
      }
    });
  }

  function onHumanHit(){
    // spawn one cop for each distinct human attack event, cap by star rules
    incWanted(1);
    spawnCopIfAllowed();
  }
  function incWanted(n){ setWanted(player.wanted + n); }

  // ---------- Police / forces ----------
  const cops=[];
  const now=()=>performance.now();
  let nowMs=now();
  const spawnPoints = [
    {gx: unlocked.x0+1, gy: sidewalkY},
    {gx: unlocked.x1-1, gy: sidewalkY},
    {gx: door.gx,       gy: unlocked.y0+1},
    {gx: door.gx,       gy: unlocked.y1-1},
  ];
  function randomSpawn(){ return spawnPoints[(Math.random()*spawnPoints.length)|0]; }

  function spawnCopIfAllowed(){
    if (player.wanted<=0) return;
    const type = (player.wanted>=5)?'army':(player.wanted>=4)?'swat':'police';
    // cap total by stars (1->2, 2->3, 3->5, 4->6, 5->8)
    const cap = [0,2,3,5,6,8][player.wanted];
    if (cops.filter(c=>!c.dead).length >= cap) return;
    const sp=randomSpawn();
    cops.push({
      x: sp.gx*TILE, y: sp.gy*TILE,
      speed: 1.65*(TILE/16),
      type,
      anim:0,
      hp: (type==='army')?5 : (type==='swat')?4 : 3,
      lastHitAt: 0,
      hpHitCount: 0,
      dead:false,
      reinforceAt: now()+30000, // 30s reinforcement if not eliminated
      reinforceCancel:false
    });
  }
  function maybeSpawnReinforcement(){
    // honor star cap
    if (cops.filter(c=>!c.dead).length >= [0,2,3,5,6,8][player.wanted]) return;
    // spawn according to wanted tier
    spawnCopIfAllowed();
  }

  function maintainForces(){
    // if wanted dropped to 0, clear
    if (player.wanted<=0) cops.length=0;
  }

  function updateCops(dt){
    maintainForces();
    const ptx=player.x + TILE/2, pty=player.y + TILE/2;
    nowMs = now();

    // move + timers
    cops.forEach(c=>{
      if (c.dead) return;
      // movement toward player
      const dx=ptx-c.x, dy=pty-c.y, m=Math.hypot(dx,dy)||1;
      const vx=dx/m * c.speed * dt, vy=dy/m * c.speed * dt;
      const nx=c.x+vx, ny=c.y+vy;
      const gx=Math.floor(nx/TILE), gy=Math.floor(ny/TILE);
      if (!isSolid(gx,gy)){ c.x=nx; c.y=ny; }
      c.anim += dt*0.5;

      // 30s reinforcement rule
      if (!c.reinforceCancel && nowMs >= c.reinforceAt){
        c.reinforceCancel=true; // fire once
        if (!c.dead) maybeSpawnReinforcement();
      }
    });

    // separation
    const minDist=TILE*0.75;
    for(let i=0;i<cops.length;i++){
      for(let j=i+1;j<cops.length;j++){
        const a=cops[i], b=cops[j];
        const dx=a.x-b.x, dy=a.y-b.y, d=Math.hypot(dx,dy);
        if(d>0 && d<minDist){
          const push=(minDist-d)/2, ux=dx/d, uy=dy/d;
          a.x += ux*push; a.y += uy*push;
          b.x -= ux*push; b.y -= uy*push;
        }
      }
    }
  }

  function drawCopSprite(c, dx, dy){
    let img=policeImg, cols=policeCols, color='#0d2b4d';
    if (c.type==='swat'){ img = swatImg||null; cols=swatImg?swatCols:1; color='#111'; }
    if (c.type==='army'){ img = armyImg||null; cols=armyImg?armyCols:1; color='#1e5b23'; }
    if (img){
      const frame = cols>1 ? Math.floor(c.anim*8)%cols : 0;
      ctx.drawImage(img, frame*ENFORCE_W, 0, ENFORCE_W, ENFORCE_H, dx, dy, DRAW, DRAW);
    }else{
      ctx.fillStyle=color; ctx.fillRect(dx,dy,DRAW,DRAW);
      // simple hat band
      ctx.fillStyle='#07203a'; ctx.fillRect(dx,dy,DRAW,DRAW*0.25);
      ctx.fillStyle='#c8d9ff'; ctx.fillRect(dx+DRAW*0.25, dy+DRAW*0.22, DRAW*0.5, DRAW*0.08);
    }
  }
  function drawCops(){
    cops.forEach(c=>{ if(c.dead) return; const dx=w2sX(c.x), dy=w2sY(c.y); drawCopSprite(c,dx,dy); });
  }

  // ---------- Player draw ----------
  const images={ body:null,outfit:null,hair:null };
  function drawPlayer(){
    const row = DIR_INDEX[player.facing]||0;
    const bCols=layerCols.body, oCols=layerCols.outfit, hCols=layerCols.hair;
    const fb=currentFrame(bCols,player.moving,player.animTime);
    const fo=oCols>1?currentFrame(oCols,player.moving,player.animTime):0;
    const fh=hCols>1?currentFrame(hCols,player.moving,player.animTime):0;
    const sy=row*FRAME_H, dx=w2sX(player.x), dy=w2sY(player.y), S=DRAW;
    ctx.imageSmoothingEnabled=false;
    ctx.drawImage(images.body, fb*FRAME_W, sy, FRAME_W, FRAME_H, dx, dy, S, S);
    ctx.drawImage(images.outfit, fo*FRAME_W, sy, FRAME_W, FRAME_H, dx, dy, S, S);
    ctx.drawImage(images.hair, fh*FRAME_W, sy, FRAME_W, FRAME_H, dx, dy, S, S);

    if (player.attackCooldown>0){
      ctx.strokeStyle='rgba(255,255,255,.7)';
      ctx.lineWidth=Math.max(1,S*0.05);
      ctx.beginPath();
      const cx=dx+S/2, cy=dy+S/2, r=S*0.55;
      let a0=0,a1=0;
      if (player.facing==='up'){ a0=-Math.PI*0.9; a1=-Math.PI*0.1; }
      if (player.facing==='down'){ a0=Math.PI*0.1; a1=Math.PI*0.9; }
      if (player.facing==='left'){ a0=Math.PI*0.6; a1=Math.PI*1.4; }
      if (player.facing==='right'){ a0=-Math.PI*0.4; a1=Math.PI*0.4; }
      ctx.arc(cx,cy,r,a0,a1); ctx.stroke();
    }
  }

  // ---------- Maps ----------
  const mini=document.getElementById('minimap'); const mctx=mini.getContext('2d');
  const mapModal=document.getElementById('mapModal'); const bigmap=document.getElementById('bigmap'); const bctx=bigmap.getContext('2d');
  function drawCity(ctx2d, sx, sy){
    ctx2d.fillStyle='rgba(163,176,197,.25)'; ctx2d.fillRect(preview.x0*sx, preview.y0*sy, (preview.x1-preview.x0+1)*sx, (preview.y1-preview.y0+1)*sy);
    ctx2d.fillStyle='#1c293e'; ctx2d.fillRect(unlocked.x0*sx, unlocked.y0*sy, (unlocked.x1-unlocked.x0+1)*sx, (unlocked.y1-unlocked.y0+1)*sy);
    ctx2d.fillStyle='#788292'; ctx2d.fillRect(preview.x0*sx, roadY*sy,(preview.x1-preview.x0+1)*sx,1.4*sy); ctx2d.fillRect(door.gx*sx, preview.y0*sy,1.4*sx,(preview.y1-preview.y0+1)*sy);
    ctx2d.fillStyle='#7a3a3a'; ctx2d.fillRect(bX*sx, bY*sy, bW*sx, bH*sy);
    ctx2d.fillStyle='#3a6d7a'; ctx2d.fillRect(sbX*sx, sbY*sy, sbW*sx, sbH*sy);
  }
  function drawMini(){ const sx=mini.width/W, sy=mini.height/H; mctx.fillStyle='#000'; mctx.fillRect(0,0,mini.width,mini.height); drawCity(mctx,sx,sy); mctx.fillStyle='#35f1ff'; mctx.fillRect((player.x/TILE)*sx-1,(player.y/TILE)*sy-1,2,2); }
  function drawBig(){ const sx=bigmap.width/W, sy=bigmap.height/H; bctx.fillStyle='#000'; bctx.fillRect(0,0,bigmap.width,bigmap.height); drawCity(bctx,sx,sy); bctx.fillStyle='#35f1ff'; bctx.fillRect((player.x/TILE)*sx-1.5,(player.y/TILE)*sy-1.5,3,3); }
  document.getElementById('miniWrap').addEventListener('click',()=>{ drawBig(); mapModal.style.display='flex'; });
  document.getElementById('closeMap').addEventListener('click',()=> mapModal.style.display='none');
  mapModal.addEventListener('click',(e)=>{ if(e.target.classList.contains('backdrop')) mapModal.style.display='none'; });

  // ---------- Update / Render ----------
  function update(dt){
    document.getElementById('prompt').style.display='none';
    if (player.attackCooldown>0) player.attackCooldown--;

    // movement
    let dx=0, dy=0;
    if(keys['arrowup']||keys['w']) dy-=1;
    if(keys['arrowdown']||keys['s']) dy+=1;
    if(keys['arrowleft']||keys['a']) dx-=1; // (A is also attack on keydown; this is for arrows)
    if(keys['arrowright']||keys['d']) dx+=1;
    dx+=vec.x; dy+=vec.y;
    const mag=Math.hypot(dx,dy);
    const vx = mag ? (dx/mag)*player.speed : 0;
    const vy = mag ? (dy/mag)*player.speed : 0;
    if (mag>0.01){
      if (Math.abs(dy)>=Math.abs(dx)) player.facing = dy<0?'up':'down';
      else                             player.facing = dx<0?'left':'right';
    }
    player.moving = mag>0.01;
    tryMove(player.x+vx*dt, player.y+vy*dt);
    centerCamera();
    if (player.moving) player.animTime += (dt*16.6667);

    // NPCs
    updatePeds(dt);
    updateCars(dt);

    // tutorial progress
    if (tutorial.active){
      if (tutorial.phase===1){
        // if tutorial target knocked or dead → spawn the cop and move to phase 2
        if (tutorial.target && (tutorial.target.knocked || tutorial.target.dead)){
          tutorial.phase=2;
          incWanted(1);
          spawnCopIfAllowed();
          tutorial.cop = cops.find(c=>!c.dead) || null;
          tutorial.timer = 30*60; // 30s in 60fps ticks
          showToast('Oh no! Eliminate the cop within 30 seconds or more will arrive!');
        }
      } else if (tutorial.phase===2){
        if (tutorial.cop && tutorial.cop.dead){
          tutorial.active=false;
          player.missionsCompleted += 1;
          saveGame();
          showToast('Tutorial complete! (+1 mission)');
        } else {
          if (tutorial.timer>0) tutorial.timer--;
          if (tutorial.timer===0){
            maybeSpawnReinforcement(); // failed → reinforcement
            tutorial.timer = -1; // fire once
          }
        }
      }
    }

    // Cops
    updateCops(dt);
  }

  function render(){
    ctx.fillStyle='#000'; ctx.fillRect(0,0,cvs.width,cvs.height);
    const tilesX=Math.ceil(cvs.width/DRAW)+2, tilesY=Math.ceil(cvs.height/DRAW)+2;
    const startX=Math.max(0,Math.floor(camera.x/TILE));
    const startY=Math.max(0,Math.floor(camera.y/TILE));
    for(let y=0;y<tilesY;y++){
      for(let x=0;x<tilesX;x++){
        const gx=startX+x, gy=startY+y;
        if(gx>=0 && gx<W && gy>=0 && gy<H) drawTile(gx,gy);
      }
    }
    drawCars();
    drawPeds();
    drawCops();
    drawPlayer();
    drawMini();
  }

  // ---------- Toasts ----------
  let toastT=0, toastMsg='';
  function showToast(msg){ toastMsg=msg; toastT=180; } // ~3s
  (function drawToastLoop(){
    const draw=()=>{
      if (toastT>0){
        const w=cvs.width, pad=12;
        ctx.save();
        ctx.font='16px Arial';
        const m=toastMsg;
        const tw = ctx.measureText(m).width + pad*2;
        const x = (w-tw)/2, y = cvs.height - 40;
        ctx.fillStyle='rgba(0,0,0,.65)'; ctx.fillRect(x,y,tw,28);
        ctx.strokeStyle='rgba(255,255,255,.15)'; ctx.strokeRect(x,y,tw,28);
        ctx.fillStyle='#fff'; ctx.textAlign='center'; ctx.textBaseline='middle';
        ctx.fillText(m, x+tw/2, y+14);
        ctx.restore();
        toastT--;
      }
      requestAnimationFrame(draw);
    };
    requestAnimationFrame(draw);
  })();

  // ---------- Boot ----------
  Promise.all([
    loadLayer('body',BODY),
    loadLayer('outfit',OUTFIT),
    loadLayer('hair',HAIR),
    tryLoadForces().catch(()=>{})
  ]).then(([b,o,h])=>{
    images.body=b.img; images.outfit=o.img; images.hair=h.img;
    layerCols.body=getCols(images.body); layerCols.outfit=getCols(images.outfit); layerCols.hair=getCols(images.hair);
    updateCoinUI(); setWanted(player.wanted); centerCamera();

    let last=performance.now();
    function loop(now){
      const dtMs=Math.min(32, now-last); last=now;
      update(dtMs/16.6667);
      render();
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
  }).catch(err=>console.error('Sprite load failed',err));
})();
