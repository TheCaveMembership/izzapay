(function(){
  const BUILD = 'v3.2-crossing+cops+cars+30s-getaway';
  console.log('[IZZA PLAY]', BUILD);

  // ===== Profile / assets =====
  const profile = window.__IZZA_PROFILE__ || {};
  const BODY   = profile.sprite_skin || "default";
  const HAIR   = profile.hair || "short";
  const OUTFIT = profile.outfit || "street";

  // ===== Canvas / constants =====
  const cvs = document.getElementById('game');
  const ctx = cvs.getContext('2d');
  const TILE=32, SCALE=3, DRAW=TILE*SCALE, SCALE_FACTOR=DRAW/TILE;

  const camera={x:0,y:0};
  const w2sX = wx => (wx - camera.x) * SCALE_FACTOR;
  const w2sY = wy => (wy - camera.y) * SCALE_FACTOR;

  // ===== World =====
  const W=90,H=60;
  const unlocked={x0:18,y0:18,x1:72,y1:42};
  const preview ={x0:10,y0:12,x1:80,y1:50};
  const inRect=(gx,gy,r)=> gx>=r.x0 && gx<=r.x1 && gy>=r.y0 && gy<=r.y1;
  const inUnlocked=(gx,gy)=> inRect(gx,gy,unlocked);

  // Hub
  const bW=10,bH=6;
  const bX = Math.floor((unlocked.x0+unlocked.x1)/2) - Math.floor(bW/2);
  const bY = unlocked.y0 + 5;
  const sidewalkY = bY + bH;
  const roadY     = sidewalkY + 1;
  const door = { gx: bX + Math.floor(bW/2), gy: sidewalkY };

  // Intersection (cross aligns with maps)
  const vRoadX = door.gx; // vertical road x
  const hRoadY = roadY;   // horizontal road y (under sidewalks)

  // Shop stub (kept, not wired to payments)
  const shop = { x: bX+16, y: bY+2, w:8, h:5, sidewalkY: bY+2+5, registerGX: bX+16+Math.floor(8/2) };

  // ===== Loading =====
  function loadImg(src){ return new Promise((res,rej)=>{ const i=new Image(); i.onload=()=>res(i); i.onerror=()=>rej(new Error('load:'+src)); i.src=src; }); }
  const assetRoot="/static/game/sprites";
  function loadLayer(kind,name){
    const p2=`${assetRoot}/${kind}/${encodeURIComponent(name+' 2')}.png`;
    const p1=`${assetRoot}/${kind}/${encodeURIComponent(name)}.png`;
    return loadImg(p2).then(img=>({img,cols:Math.max(1,Math.floor(img.width/32))}))
                      .catch(()=>loadImg(p1).then(img=>({img,cols:Math.max(1,Math.floor(img.width/32))})));
  }

  // ===== Player / anim =====
  const player = {
    x: door.gx*TILE + (TILE/2 - 8),
    y: door.gy*TILE,
    speed: 2.0 * (TILE/16),
    wanted: 0,
    facing: 'down', moving:false, animTime:0,
    hp: 5,
    coins: (window.__IZZA_COINS__|0) || 0
  };

  // Your sheet row order: down, RIGHT, LEFT, up
  const DIR_INDEX = { down:0, left:2, right:1, up:3 };
  const FRAME_W=32, FRAME_H=32, WALK_FPS=8, WALK_MS=1000/WALK_FPS;

  function currentFrame(cols, moving, t){ if(cols<=1) return 0; if(!moving) return 1%cols; return Math.floor(t/WALK_MS)%cols; }

  // ===== Input / UI =====
  const keys = Object.create(null);
  const btnA = document.getElementById('btnA');
  const btnB = document.getElementById('btnB');
  const promptEl = document.getElementById('prompt');

  function handleB(){
    if (doorInRange()) openEnter();
    else if (atRegister()) openShop();
    else setWanted(0);
  }

  window.addEventListener('keydown', e=>{
    const k=e.key.toLowerCase(); keys[k]=true;
    if(k==='b'){ e.preventDefault(); handleB(); }
    if(k==='a'){ e.preventDefault(); doAttack(); }
  },{passive:false});
  window.addEventListener('keyup', e=>{ keys[e.key.toLowerCase()]=false; });

  btnA.addEventListener('click', doAttack);
  btnB.addEventListener('click', handleB);

  // Virtual joystick
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
  function moveDrag(e){ if(!dragging) return; const t=e.touches?e.touches[0]:e; const cx=baseRect.left+baseRect.width/2, cy=baseRect.top+baseRect.height/2; setNub(t.clientX-cx,t.clientY-cy); e.preventDefault(); }
  function endDrag(e){ dragging=false; resetNub(); if(e) e.preventDefault(); }
  stick.addEventListener('touchstart',startDrag,{passive:false});
  stick.addEventListener('touchmove', moveDrag, {passive:false});
  stick.addEventListener('touchend',  endDrag,  {passive:false});
  stick.addEventListener('mousedown', startDrag);
  window.addEventListener('mousemove',moveDrag);
  window.addEventListener('mouseup',  endDrag);

  // ===== HUD stars & coins =====
  function setWanted(n){
    player.wanted = Math.max(0, Math.min(5, n|0));
    document.querySelectorAll('#stars .star').forEach((s,i)=> s.className='star' + (i<player.wanted?' on':'') );
  }
  function setCoins(n){
    player.coins = Math.max(0, n|0);
    const pill = document.getElementById('coinPill');
    if(pill) pill.textContent = `Coins: ${player.coins} IC`;
  }

  // ===== Camera =====
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

  // ===== Collision / tiles =====
  const isBuilding = (gx,gy)=> (gx>=bX&&gx<bX+bW&&gy>=bY&&gy<bY+bH) ||
                               (gx>=shop.x&&gx<shop.x+shop.w&&gy>=shop.y&&gy<shop.y+shop.h);
  function isSolid(gx,gy){
    if(!inUnlocked(gx,gy)) return true;
    if(isBuilding(gx,gy))  return true;
    return false;
  }
  function tryMove(nx,ny){
    // AABB vs solid tiles
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

  function doorInRange(){
    const px = Math.floor((player.x + TILE/2)/TILE);
    const py = Math.floor((player.y + TILE/2)/TILE);
    return (Math.abs(px-door.gx)+Math.abs(py-door.gy))<=2;
  }
  function atRegister(){
    const px = Math.floor((player.x + TILE/2)/TILE);
    const py = Math.floor((player.y + TILE/2)/TILE);
    return (Math.abs(px-shop.registerGX)+Math.abs(py-shop.sidewalkY))<=1;
  }

  // ===== Modals (HQ & Shop) =====
  function openEnter(){ const m=document.getElementById('enterModal'); if(!m) return; m.style.display='flex'; }
  function closeEnter(){ const m=document.getElementById('enterModal'); if(!m) return; m.style.display='none'; }
  function openShop(){ const m=document.getElementById('shopModal'); if(!m) return; m.style.display='flex'; }
  function closeShop(){ const m=document.getElementById('shopModal'); if(!m) return; m.style.display='none'; }

  // hook up buttons (with stopPropagation so clicks don’t hit backdrop)
  const ce=document.getElementById('closeEnter'); if(ce) ce.addEventListener('click', (e)=>{ e.stopPropagation(); closeEnter(); });
  const em=document.getElementById('enterModal'); if(em){
    em.addEventListener('click', (e)=>{ if(e.target.classList.contains('backdrop')) closeEnter(); });
  }
  const cs=document.getElementById('closeShop'); if(cs) cs.addEventListener('click', (e)=>{ e.stopPropagation(); closeShop(); });
  const sm=document.getElementById('shopModal'); if(sm){
    sm.addEventListener('click', (e)=>{ if(e.target.classList.contains('backdrop')) closeShop(); });
  }

  // ===== NPCs: pedestrians & cars =====
  const pedestrians=[]; // {x,y,dir,spd,hp,state,crossing}
  const cars=[];        // {x,y,dir,spd}

  function spawnPed(){
    // Start on sidewalks (left or right) and walk horizontally; cross only at intersection column
    const left = Math.random()<0.5;
    const gx = left ? unlocked.x0 : unlocked.x1;
    const dir = left ? 1 : -1;
    pedestrians.push({
      x: gx*TILE, y: sidewalkY*TILE,
      dir, spd: 0.6, hp: 4, // 3 hits to knockdown + 1 to eliminate
      state: 'walk',  // walk | downed | blink
      crossing: false, blinkT:0
    });
  }
  function spawnCar(){
    // Road lane; move left->right or right->left
    const left = Math.random()<0.5;
    const gx = left ? unlocked.x0 : unlocked.x1;
    const dir = left ? 1 : -1;
    cars.push({
      x: gx*TILE, y: hRoadY*TILE,
      dir, spd: 2.0
    });
  }

  function updatePed(p, dt){
    if(p.state==='walk'){
      // Only cross at the intersection column
      const gx = Math.floor(p.x/TILE);
      const atColumn = (gx === vRoadX);
      if(atColumn && !p.crossing){
        // step down to road, cross straight, then up to opposite sidewalk
        p.crossing = true;
      }
      if(p.crossing){
        // move vertically across the road; once across, resume horizontal walking
        const targetY = (p.y < hRoadY*TILE) ? (hRoadY*TILE + TILE) : (sidewalkY*TILE);
        const vy = (p.y < targetY) ? 1 : (p.y > targetY ? -1 : 0);
        p.y += vy * p.spd * dt;
        if(Math.abs(p.y - targetY) < 0.5){
          p.crossing = false;
        }
      } else {
        // horizontal along sidewalk rows only
        p.y = sidewalkY*TILE;
        p.x += p.dir * p.spd * dt;
        if(p.x < unlocked.x0*TILE) { p.x = unlocked.x1*TILE; }
        if(p.x > unlocked.x1*TILE) { p.x = unlocked.x0*TILE; }
      }
    } else if(p.state==='downed'){
      // stays down; next hit = eliminate -> blink
    } else if(p.state==='blink'){
      p.blinkT -= dt;
      if(p.blinkT<=0){ // remove
        const i=pedestrians.indexOf(p);
        if(i>=0) pedestrians.splice(i,1);
        // reward coins
        setCoins(player.coins + 25);
      }
    }
  }

  function updateCar(c, dt){
    c.x += c.dir * c.spd * dt;
    if(c.x < unlocked.x0*TILE) c.x = unlocked.x1*TILE;
    if(c.x > unlocked.x1*TILE) c.x = unlocked.x0*TILE;
  }

  // ===== Cops & wanted logic =====
  const cops=[]; // {x,y,spd,reinforceAt,kind,hp}
  function copSpeed(kind){ return kind==='army'?1.6 : kind==='swat'?1.5 : 1.3; }
  function copHP(kind){ return kind==='army'?6 : kind==='swat'?5 : 4; }

  function spawnCop(kind){
    // spawn near map edges
    const left = Math.random()<0.5;
    const top  = Math.random()<0.5;
    const gx = left ? unlocked.x0 : unlocked.x1;
    const gy = top  ? unlocked.y0 : unlocked.y1;
    const now = performance.now();
    cops.push({
      x: gx*TILE, y: gy*TILE,
      spd: copSpeed(kind), hp: copHP(kind),
      kind,
      reinforceAt: now + 30000 // 30s
    });
  }

  function maintainCops(){
    // ensure active count matches stars, with tiers at 4 and 5
    const needed = player.wanted;
    // Count by kind
    let cur = cops.length;
    while(cur < needed){
      let kind='police';
      if(needed>=5) kind='army';
      else if(needed>=4) kind='swat';
      spawnCop(kind);
      cur++;
    }
    while(cur > needed){
      cops.pop();
      cur--;
    }
  }

  function updateCops(dt, nowMs){
    for(const c of cops){
      // chase player
      const dx = player.x - c.x, dy = player.y - c.y;
      const m = Math.hypot(dx,dy)||1;
      c.x += (dx/m) * c.spd * dt;
      c.y += (dy/m) * c.spd * dt;

      // reinforcement if not eliminated in 30s (cap at 5)
      if(nowMs >= c.reinforceAt && player.wanted < 5){
        setWanted(player.wanted + 1);
        maintainCops();
        // push next window for this cop
        c.reinforceAt = nowMs + 30000;
      }
    }
  }

  function damageCop(c, amount){
    c.hp -= amount;
    if(c.hp <= 0){
      // remove and reduce wanted by 1
      const i=cops.indexOf(c);
      if(i>=0) cops.splice(i,1);
      setWanted(player.wanted - 1);
      // If we just cleared the LAST star and we were at 1-star, that's the “get away within 30s” path
      maintainCops();
      setCoins(player.coins + 50);
    }
  }

  // ===== Combat =====
  function hitTest(ax,ay, bx,by, radius=20){
    return Math.hypot(ax-bx, ay-by) <= radius;
  }

  function doAttack(){
    // Attack nearest pedestrian or cop in small radius
    let didHit=false;

    // Hit pedestrians
    for(const p of pedestrians){
      if(hitTest(player.x,player.y, p.x,p.y, 22)){
        didHit=true;
        if(p.state==='walk'){
          p.hp -= 1;
          if(player.wanted===0){ setWanted(1); maintainCops(); } // first aggression -> 1 star
          if(p.hp<=1){ p.state='downed'; } // after 3rd hit (hp==1) they are down
        }else if(p.state==='downed'){
          p.state='blink'; p.blinkT=600; // 0.6s blink then vanish with coins
        }
        break;
      }
    }

    // Hit cops (harder)
    if(!didHit){
      for(const c of cops){
        if(hitTest(player.x,player.y, c.x,c.y, 24)){
          // 2 quick hits can happen; damage
          damageCop(c, 1);
          didHit=true;
          break;
        }
      }
    }

    // If we hit a *new* pedestrian while already wanted, escalate by +1 (up to 5)
    if(didHit && player.wanted>0 && cops.length<player.wanted){
      // maintain already ensures at least wanted cops;
      // if we’re under, top up.
      maintainCops();
    }
  }

  // ===== Maps & drawing =====
  const mini = document.getElementById('minimap');
  const mctx = mini.getContext('2d');
  const mapModal = document.getElementById('mapModal');
  const bigmap   = document.getElementById('bigmap');
  const bctx     = bigmap.getContext('2d');

  function drawCity(ctx2d, sx, sy){
    // Preview
    ctx2d.fillStyle = 'rgba(163,176,197,.25)';
    ctx2d.fillRect(preview.x0*sx, preview.y0*sy, (preview.x1-preview.x0+1)*sx, (preview.y1-preview.y0+1)*sy);

    // Unlocked
    ctx2d.fillStyle = '#1c293e';
    ctx2d.fillRect(unlocked.x0*sx, unlocked.y0*sy, (unlocked.x1-unlocked.x0+1)*sx, (unlocked.y1-unlocked.y0+1)*sy);

    // Roads: horizontal and vertical cross (MATCHES play field)
    ctx2d.fillStyle = '#788292';
    ctx2d.fillRect(preview.x0*sx, hRoadY*sy, (preview.x1-preview.x0+1)*sx, 1.4*sy);     // horizontal
    ctx2d.fillRect(vRoadX*sx, preview.y0*sy, 1.4*sx, (preview.y1-preview.y0+1)*sy);     // vertical

    // Hub
    ctx2d.fillStyle = '#7a3a3a';
    ctx2d.fillRect(bX*sx, bY*sy, bW*sx, bH*sy);
    // Shop (roof label color)
    ctx2d.fillStyle = '#405a85';
    ctx2d.fillRect(shop.x*sx, shop.y*sy, shop.w*sx, shop.h*sy);
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
    bctx.fillStyle = '#35f1ff';
    bctx.fillRect((player.x/TILE)*sx-1.5,(player.y/TILE)*sy-1.5,3,3);
  }

  const miniWrap=document.getElementById('miniWrap');
  if(miniWrap) miniWrap.addEventListener('click', ()=>{ drawBig(); mapModal.style.display='flex'; });
  const closeMapBtn=document.getElementById('closeMap');
  if(closeMapBtn) closeMapBtn.addEventListener('click', ()=> mapModal.style.display='none');
  if(mapModal) mapModal.addEventListener('click', (e)=>{ if(e.target.classList.contains('backdrop')) mapModal.style.display='none'; });

  function drawTile(gx,gy){
    const S=DRAW, screenX=w2sX(gx*TILE), screenY=w2sY(gy*TILE);

    if(!inUnlocked(gx,gy)){ ctx.fillStyle='#000'; ctx.fillRect(screenX,screenY,S,S); return; }

    // Base ground
    ctx.fillStyle = '#09371c';
    ctx.fillRect(screenX,screenY,S,S);

    // Buildings
    if (gx>=bX && gx<bX+bW && gy>=bY && gy<bY+bH){
      ctx.fillStyle = '#4a2d2d'; ctx.fillRect(screenX,screenY,S,S);
      ctx.fillStyle = 'rgba(0,0,0,.15)'; ctx.fillRect(screenX,screenY,S,Math.floor(S*0.18));
    }
    if (gx>=shop.x && gx<shop.x+shop.w && gy>=shop.y && gy<shop.y+shop.h){
      ctx.fillStyle = '#203a60'; ctx.fillRect(screenX,screenY,S,S);
      // simple "SHOP" stripe
      ctx.fillStyle = '#88a8ff'; ctx.fillRect(screenX+S*0.15, screenY+S*0.15, S*0.7, S*0.25);
    }

    // Sidewalk rows
    if (gy===sidewalkY || gy===shop.sidewalkY){
      ctx.fillStyle = '#6a727b'; ctx.fillRect(screenX,screenY,S,S);
      ctx.strokeStyle = 'rgba(0,0,0,.25)'; ctx.strokeRect(screenX,screenY,S,S);
    }

    // Road: horizontal band and vertical column (with dashes on horizontal)
    if (gy===hRoadY){
      ctx.fillStyle = '#2a2a2a'; ctx.fillRect(screenX,screenY,S,S);
      ctx.fillStyle = '#ffd23f';
      for(let i=0;i<4;i++){
        ctx.fillRect(screenX + i*(S/4) + S*0.05, screenY + S*0.48, S*0.10, S*0.04);
      }
    }
    if (gx===vRoadX){
      ctx.fillStyle = '#2a2a2a'; ctx.fillRect(screenX,screenY,S,S);
    }

    // HQ Door
    if (gx===door.gx && gy===door.gy){
      const near = doorInRange();
      ctx.fillStyle = near ? '#39cc69' : '#49a4ff';
      const w = Math.floor(S*0.30), h = Math.floor(S*0.72);
      ctx.fillRect(screenX + (S-w)/2, screenY + (S-h), w, h);
      if(near){
        promptEl.style.left = (screenX + S/2) + 'px';
        promptEl.style.top  = (screenY - 8) + 'px';
        promptEl.style.display = 'block';
      }
    }

    // Shop register highlight
    if(gx===shop.registerGX && gy===shop.sidewalkY){
      const px=Math.floor((player.x+TILE/2)/TILE), py=Math.floor((player.y+TILE/2)/TILE);
      const near = (Math.abs(px-gx)+Math.abs(py-gy))<=1;
      ctx.fillStyle = near ? 'rgba(136,168,255,0.6)' : 'rgba(136,168,255,0.3)';
      ctx.fillRect(screenX+S*0.35, screenY+S*0.35, S*0.3, S*0.3);
    }
  }

  function drawSprite(img, cols, facing, moving, t, dx,dy){
    const row = DIR_INDEX[facing]||0;
    const frame = currentFrame(cols, moving, t);
    ctx.imageSmoothingEnabled=false;
    ctx.drawImage(img, frame*FRAME_W, row*FRAME_H, FRAME_W, FRAME_H, dx,dy, DRAW,DRAW);
  }

  // ===== Update & render =====
  function update(dt){
    promptEl.style.display='none';

    // Movement
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

    if(player.moving) player.animTime += (dt * 16.6667);

    // NPCs
    if(pedestrians.length<6 && Math.random()<0.02) spawnPed();
    if(cars.length<3 && Math.random()<0.02) spawnCar();
    pedestrians.forEach(p=>updatePed(p, dt));
    cars.forEach(c=>updateCar(c, dt));

    // Cops
    updateCops(dt, performance.now());
  }

  function render(images){
    ctx.fillStyle='#000'; ctx.fillRect(0,0,cvs.width,cvs.height);

    const tilesX = Math.ceil(cvs.width  / DRAW) + 2;
    const tilesY = Math.ceil(cvs.height / DRAW) + 2;
    const startX = Math.max(0, Math.floor(camera.x / TILE));
    const startY = Math.max(0, Math.floor(camera.y / TILE));

    for(let y=0;y<tilesY;y++){
      for(let x=0;x<tilesX;x++){
        const gx=startX+x, gy=startY+y;
        if(gx>=0&&gx<W&&gy>=0&&gy<H) drawTile(gx,gy);
      }
    }

    // draw cars (simple rectangles)
    for(const c of cars){
      const sx=w2sX(c.x), sy=w2sY(c.y);
      ctx.fillStyle='#c0c8d8';
      ctx.fillRect(sx+DRAW*0.1,sy+DRAW*0.25, DRAW*0.8, DRAW*0.5);
    }

    // draw pedestrians
    for(const p of pedestrians){
      const sx=w2sX(p.x), sy=w2sY(p.y);
      ctx.fillStyle = p.state==='downed' ? '#555' : '#9de7b1';
      ctx.fillRect(sx+DRAW*0.2, sy+DRAW*0.2, DRAW*0.6, DRAW*0.6);
    }

    // player layers
    drawSprite(images.body.img,   images.body.cols,   player.facing, player.moving, player.animTime, w2sX(player.x), w2sY(player.y));
    drawSprite(images.outfit.img, images.outfit.cols, player.facing, player.moving, player.animTime, w2sX(player.x), w2sY(player.y));
    drawSprite(images.hair.img,   images.hair.cols,   player.facing, player.moving, player.animTime, w2sX(player.x), w2sY(player.y));

    // draw cops (colored blocks per tier for now)
    for(const c of cops){
      const sx=w2sX(c.x), sy=w2sY(c.y);
      ctx.fillStyle = c.kind==='army' ? '#3e8a3e' : c.kind==='swat' ? '#000' : '#0a2455';
      ctx.fillRect(sx+DRAW*0.15, sy+DRAW*0.15, DRAW*0.7, DRAW*0.7);
    }

    drawMini();
  }

  // ===== Boot =====
  Promise.all([
    loadLayer('body',   BODY),
    loadLayer('outfit', OUTFIT),
    loadLayer('hair',   HAIR),
  ]).then(([body,outfit,hair])=>{
    const imgs={body,outfit,hair};
    setCoins(player.coins);
    centerCamera();
    let last=performance.now();
    (function loop(now){
      const dtMs=Math.min(32, now-last); last=now;
      update(dtMs);
      render(imgs);
      requestAnimationFrame(loop);
    })(last+16);
  }).catch(err=>console.error('Sprite load failed', err));
})();
