(function(){
  // --- Build stamp so you can verify in DevTools console ---
  const BUILD = 'v2-anim-4dir';
  console.log('[IZZA PLAY]', BUILD);

  const profile = window.__IZZA_PROFILE__ || {};
  const BODY   = profile.sprite_skin || "default";
  const HAIR   = profile.hair || "short";
  const OUTFIT = profile.outfit || "street";

  // ---------- Canvas & constants ----------
  const cvs = document.getElementById('game');
  const ctx = cvs.getContext('2d');

  const TILE  = 32;                 // world tile = 32 world-pixels
  const SCALE = 3;                  // camera zoom
  const DRAW  = TILE * SCALE;       // screen pixels per tile
  const SCALE_FACTOR = DRAW / TILE; // == SCALE

  // Helpers world->screen
  const w2sX = wx => (wx - camera.x) * SCALE_FACTOR;
  const w2sY = wy => (wy - camera.y) * SCALE_FACTOR;

  // ---------- World grid ----------
  const W = 90, H = 60;

  // Regions
  const unlocked = { x0: 18, y0: 18, x1: 72, y1: 42 };      // playable
  const preview  = { x0: 10, y0: 12, x1: 80, y1: 50 };      // map-only preview
  const inRect   = (gx,gy,r)=> gx>=r.x0 && gx<=r.x1 && gy>=r.y0 && gy<=r.y1;
  const inUnlocked = (gx,gy)=> inRect(gx,gy, unlocked);

  // Hub building (10×6) near top-middle of unlocked area
  const bW=10, bH=6;
  const bX = Math.floor((unlocked.x0 + unlocked.x1)/2) - Math.floor(bW/2);
  const bY = unlocked.y0 + 5;

  // Sidewalk & road rows
  const sidewalkY = bY + bH;          // directly under building
  const roadY     = sidewalkY + 1;    // below sidewalk

  // Door centered on sidewalk
  const door = { gx: bX + Math.floor(bW/2), gy: sidewalkY };

  // ---------- Assets ----------
  function loadImg(src){
    return new Promise((res, rej)=>{
      const i=new Image(); i.onload=()=>res(i); i.onerror=rej; i.src=src;
    });
  }
  const assetRoot = "/static/game/sprites";
  const assets = {
    body:   `${assetRoot}/body/${BODY}.png`,
    hair:   `${assetRoot}/hair/${HAIR}.png`,
    outfit: `${assetRoot}/outfit/${OUTFIT}.png`,
  };

  // ---------- Player (spawn on sidewalk at door) ----------
  const player = {
    x: door.gx*TILE + (TILE/2 - 8),   // slight offset so sprite visually centers
    y: door.gy*TILE,
    vx: 0, vy: 0,
    speed: 2.0 * (TILE/16),
    wanted: 0,
    facing: 'down',        // 'down' | 'left' | 'right' | 'up'
    moving: false,
    animTime: 0,           // ms accumulator
  };

  // ---------- Animation config ----------
  // Sprite sheet layout: 4 rows (down,left,right,up) × FRAMES columns
  const DIR_INDEX = { down:0, left:1, right:2, up:3 };
  const FRAME_W = 32;
  const FRAME_H = 32;
  const WALK_FPS = 8;                  // animation speed
  const WALK_FRAME_MS = 1000 / WALK_FPS;

  // For images that might be single-frame, detect frame count at runtime
  function getFrameCols(img){
    return Math.max(1, Math.floor(img.width / FRAME_W));
  }

  // Compute frame index given anim time + move state
  function currentFrame(cols, moving, animTime){
    if (cols <= 1) return 0;
    if (!moving)   return 1 % cols;   // idle pose = middle frame if exists, else 0
    // Loop 0..cols-1 at WALK_FPS
    const idx = Math.floor(animTime / WALK_FRAME_MS) % cols;
    return idx;
  }

  // ---------- Input ----------
  const keys = Object.create(null);
  const btnA = document.getElementById('btnA');
  const btnB = document.getElementById('btnB');

  function handleB(){
    if (doorInRange()) openEnter();
    else setWanted(0);
  }

  window.addEventListener('keydown', e=>{
    const k = e.key.toLowerCase();
    keys[k] = true;
    if (k === 'b') { e.preventDefault(); handleB(); }
  }, {passive:false});

  window.addEventListener('keyup', e=>{ keys[e.key.toLowerCase()] = false; });

  btnA.addEventListener('click', ()=> setWanted(player.wanted+1));
  btnB.addEventListener('click', handleB);

  // ---------- Virtual joystick ----------
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
    setNub(t.clientX-cx,t.clientY-cy);
    e.preventDefault();
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
  const camera={x:0,y:0};
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
  const isBuilding = (gx,gy)=> gx>=bX && gx<bX+bW && gy>=bY && gy<bY+bH;
  function isSolid(gx,gy){
    if(!inUnlocked(gx,gy)) return true;   // outside unlocked = hard wall (black)
    if(isBuilding(gx,gy))  return true;   // building tiles are solid
    return false;
  }

  function tryMove(nx,ny){
    // X axis
    const cx = [
      {x:nx, y:player.y}, {x:nx+TILE-1, y:player.y},
      {x:nx, y:player.y+TILE-1}, {x:nx+TILE-1, y:player.y+TILE-1}
    ];
    if(!cx.some(c=>isSolid(Math.floor(c.x/TILE), Math.floor(c.y/TILE)))) player.x = nx;

    // Y axis
    const cy = [
      {x:player.x, y:ny}, {x:player.x+TILE-1, y:ny},
      {x:player.x, y:ny+TILE-1}, {x:player.x+TILE-1, y:ny+TILE-1}
    ];
    if(!cy.some(c=>isSolid(Math.floor(c.x/TILE), Math.floor(c.y/TILE)))) player.y = ny;
  }

  // ---------- Door UX ----------
  const promptEl = document.getElementById('prompt');
  function doorInRange(){
    const px = Math.floor((player.x + TILE/2)/TILE);
    const py = Math.floor((player.y + TILE/2)/TILE);
    return (Math.abs(px-door.gx)+Math.abs(py-door.gy))<=2; // generous for touch
  }
  function openEnter(){ document.getElementById('enterModal').style.display='flex'; }
  document.getElementById('closeEnter').addEventListener('click', ()=> document.getElementById('enterModal').style.display='none');
  document.getElementById('enterModal').addEventListener('click', (e)=>{ if(e.target.classList.contains('backdrop')) e.currentTarget.style.display='none'; });

  // ---------- Maps ----------
  const mini = document.getElementById('minimap');
  const mctx = mini.getContext('2d');
  const mapModal = document.getElementById('mapModal');
  const bigmap   = document.getElementById('bigmap');
  const bctx     = bigmap.getContext('2d');

  function drawCity(ctx2d, sx, sy){
    // Locked base is implied by clearing to black in callers

    // Preview (semi-transparent)
    ctx2d.fillStyle = 'rgba(163,176,197,.25)';
    ctx2d.fillRect(preview.x0*sx, preview.y0*sy, (preview.x1-preview.x0+1)*sx, (preview.y1-preview.y0+1)*sy);

    // Unlocked area (clear dark)
    ctx2d.fillStyle = '#1c293e';
    ctx2d.fillRect(unlocked.x0*sx, unlocked.y0*sy, (unlocked.x1-unlocked.x0+1)*sx, (unlocked.y1-unlocked.y0+1)*sy);

    // Roads (extend through preview)
    ctx2d.fillStyle = '#788292';
    ctx2d.fillRect(preview.x0*sx, roadY*sy, (preview.x1-preview.x0+1)*sx, 1.4*sy);         // horizontal
    ctx2d.fillRect(door.gx*sx, preview.y0*sy, 1.4*sx, (preview.y1-preview.y0+1)*sy);       // vertical

    // Hub building
    ctx2d.fillStyle = '#7a3a3a';
    ctx2d.fillRect(bX*sx, bY*sy, bW*sx, bH*sy);
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

  // ---------- Drawing tiles ----------
  function drawTile(gx,gy){
    const S = DRAW;
    const screenX = w2sX(gx*TILE);
    const screenY = w2sY(gy*TILE);

    // Outside unlocked → black wall
    if(!inUnlocked(gx,gy)){ ctx.fillStyle='#000'; ctx.fillRect(screenX,screenY,S,S); return; }

    // Base ground
    ctx.fillStyle = '#09371c';
    ctx.fillRect(screenX,screenY,S,S);

    // Building footprint
    if (gx>=bX && gx<bX+bW && gy>=bY && gy<bY+bH){
      ctx.fillStyle = '#4a2d2d'; ctx.fillRect(screenX,screenY,S,S);
      ctx.fillStyle = 'rgba(0,0,0,.15)'; ctx.fillRect(screenX,screenY,S,Math.floor(S*0.18));
    }

    // Sidewalk
    if (gy===sidewalkY){
      ctx.fillStyle = '#6a727b'; ctx.fillRect(screenX,screenY,S,S);
      ctx.strokeStyle = 'rgba(0,0,0,.25)'; ctx.strokeRect(screenX,screenY,S,S);
    }

    // Road with dashed center
    if (gy===roadY){
      ctx.fillStyle = '#2a2a2a'; ctx.fillRect(screenX,screenY,S,S);
      ctx.fillStyle = '#ffd23f';
      for(let i=0;i<4;i++){
        ctx.fillRect(screenX + i*(S/4) + S*0.05, screenY + S*0.48, S*0.10, S*0.04);
      }
    }

    // Door
    if (gx===door.gx && gy===door.gy){
      const near = doorInRange();
      ctx.fillStyle = near ? '#39cc69' : '#49a4ff';
      const w = Math.floor(S*0.30), h = Math.floor(S*0.72);
      ctx.fillRect(screenX + (S-w)/2, screenY + (S-h), w, h);

      if(near){
        // place prompt above the door (already screen coords)
        promptEl.style.left = (screenX + S/2) + 'px';
        promptEl.style.top  = (screenY - 8) + 'px';
        promptEl.style.display = 'block';
      }
    }
  }

  // ---------- Draw player (animated) ----------
  function drawPlayer(images, cols){
    const dirRow = DIR_INDEX[player.facing] || 0;
    const frame  = currentFrame(cols, player.moving, player.animTime);

    const sx   = frame * FRAME_W;
    const sy   = dirRow * FRAME_H;

    const dx   = w2sX(player.x);
    const dy   = w2sY(player.y);
    const S    = DRAW;

    ctx.imageSmoothingEnabled = false;
    // layer order: body -> outfit -> hair
    ctx.drawImage(images.body,   sx, sy, FRAME_W, FRAME_H, dx, dy, S, S);
    ctx.drawImage(images.outfit, sx, sy, FRAME_W, FRAME_H, dx, dy, S, S);
    ctx.drawImage(images.hair,   sx, sy, FRAME_W, FRAME_H, dx, dy, S, S);
  }

  // ---------- Update & render ----------
  function update(dt){
    promptEl.style.display='none'; // hidden unless door re-shows it

    let dx=0, dy=0;
    if(keys['arrowup']||keys['w']) dy-=1;
    if(keys['arrowdown']||keys['s']) dy+=1;
    if(keys['arrowleft']||keys['a']) dx-=1;
    if(keys['arrowright']||keys['d']) dx+=1;
    dx += vec.x; dy += vec.y;

    const mag=Math.hypot(dx,dy);
    const vx = mag ? (dx/mag)*player.speed : 0;
    const vy = mag ? (dy/mag)*player.speed : 0;

    // Facing logic (bias vertical if stronger)
    if (mag > 0.01){
      if (Math.abs(dy) >= Math.abs(dx)) {
        player.facing = dy < 0 ? 'up' : 'down';
      } else {
        player.facing = dx < 0 ? 'left' : 'right';
      }
    }

    player.moving = (mag > 0.01);

    tryMove(player.x + vx*dt, player.y + vy*dt);
    centerCamera();
  }

  function render(images, frameCols){
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
    drawPlayer(images, frameCols);

    // repaint mini-map
    drawMini();
  }

  // ---------- Boot ----------
  Promise.all([loadImg(assets.body), loadImg(assets.outfit), loadImg(assets.hair)])
    .then(([body,outfit,hair])=>{
      // Detect columns from body sheet (assume all layers match)
      const cols = getFrameCols(body);

      const imgs = { body, outfit, hair };
      centerCamera(); // center on spawn correctly with scaling
      let last = performance.now();
      function loop(now){
        const dtMs = Math.min(32, now-last); last=now;
        // advance animation time ONLY when moving (keeps idle stable)
        if (player.moving) player.animTime += dtMs;
        update(dtMs/16.6667);
        render(imgs, cols);
        requestAnimationFrame(loop);
      }
      requestAnimationFrame(loop);
    })
    .catch(err=>console.error("Sprite load failed", err));
})();
