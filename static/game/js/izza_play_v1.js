(function(){
  const profile = window.__IZZA_PROFILE__ || {};
  const BODY   = profile.sprite_skin || "default";
  const HAIR   = profile.hair || "short";
  const OUTFIT = profile.outfit || "street";

  // ---------- Canvas & constants ----------
  const cvs = document.getElementById('game');
  const ctx = cvs.getContext('2d');
  const TILE = 32;
  const SCALE = 3;          // camera zoom
  const DRAW  = TILE * SCALE;

  // ---------- World grid ----------
  const W = 90, H = 60;

  // Regions:
  // - unlocked: fully playable
  // - preview: semi-transparent on the map only (NOT playable)
  // - locked: fully black on the map (NOT playable)
  const unlocked = { x0: 18, y0: 18, x1: 72, y1: 42 };
  const preview  = { x0: 10, y0: 12, x1: 80, y1: 50 }; // visible on maps, blocked in world
  function inRect(gx,gy, r){ return gx>=r.x0 && gx<=r.x1 && gy>=r.y0 && gy<=r.y1; }
  function inUnlocked(gx,gy){ return inRect(gx,gy, unlocked); }

  // Building (10×6) placed near top-middle of unlocked area
  const bW=10, bH=6;
  const bX = Math.floor((unlocked.x0 + unlocked.x1)/2) - Math.floor(bW/2);
  const bY = unlocked.y0 + 5;

  // Sidewalk & road rows relative to building
  const sidewalkY = bY + bH;       // directly under building
  const roadY     = sidewalkY + 1; // below sidewalk

  // Door is on sidewalk under building center
  const door = { gx: bX + Math.floor(bW/2), gy: sidewalkY };

  // ---------- Assets ----------
  function loadImg(src){ return new Promise((res, rej)=>{ const i=new Image(); i.onload=()=>res(i); i.onerror=rej; i.src=src; }); }
  const assetRoot = "/static/game/sprites";
  const assets = {
    body:   `${assetRoot}/body/${BODY}.png`,
    hair:   `${assetRoot}/hair/${HAIR}.png`,
    outfit: `${assetRoot}/outfit/${OUTFIT}.png`,
  };

  // ---------- Player (spawn on sidewalk, centered at door) ----------
  const player = {
    x: door.gx * TILE + (TILE/2 - 8),  // slight nudge so sprite looks centered
    y: (door.gy) * TILE,
    vx: 0, vy: 0,
    speed: 2.0 * (TILE/16),
    wanted: 0
  };

  // ---------- Input ----------
  const keys = Object.create(null);
  const btnA = document.getElementById('btnA');
  const btnB = document.getElementById('btnB');

  function handleB(){
    if(doorInRange()){ openEnter(); }
    else { setWanted(0); }
  }

  window.addEventListener('keydown', e=>{
    const k = e.key.toLowerCase();
    keys[k] = true;
    if(k==='b') handleB();
  }, {passive:true});
  window.addEventListener('keyup', e=>{ keys[e.key.toLowerCase()] = false; }, {passive:true});
  btnA.addEventListener('click', ()=> setWanted(player.wanted+1));
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
  function startDrag(){ dragging=true; baseRect=stick.getBoundingClientRect(); }
  function moveDrag(e){
    if(!dragging) return;
    const t=e.touches?e.touches[0]:e;
    const cx=baseRect.left+baseRect.width/2, cy=baseRect.top+baseRect.height/2;
    setNub(t.clientX-cx,t.clientY-cy);
  }
  function endDrag(){ dragging=false; resetNub(); }
  stick.addEventListener('touchstart',startDrag,{passive:true});
  stick.addEventListener('touchmove', moveDrag, {passive:true});
  stick.addEventListener('touchend',  endDrag,  {passive:true});
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
    camera.x = player.x - cvs.width/2;
    camera.y = player.y - cvs.height/2;
    const maxX = (unlocked.x1+1)*TILE - cvs.width;
    const maxY = (unlocked.y1+1)*TILE - cvs.height;
    camera.x = Math.max(unlocked.x0*TILE, Math.min(camera.x, maxX));
    camera.y = Math.max(unlocked.y0*TILE, Math.min(camera.y, maxY));
  }

  // ---------- Collision helpers ----------
  function isBuilding(gx,gy){ return gx>=bX && gx<bX+bW && gy>=bY && gy<bY+bH; }
  function isSolid(gx,gy){
    // Anything outside unlocked is solid (black)
    if(!inUnlocked(gx,gy)) return true;
    // Building tiles solid
    if(isBuilding(gx,gy))  return true;
    return false;
  }

  function tryMove(nx,ny){
    // AABB corner checks
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

  // ---------- Door UX ----------
  const promptEl = document.getElementById('prompt');
  function doorInRange(){
    const px = Math.floor((player.x + TILE/2)/TILE);
    const py = Math.floor((player.y + TILE/2)/TILE);
    // generous diamond radius (works great for touch)
    return (Math.abs(px-door.gx)+Math.abs(py-door.gy))<=2;
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

  function drawMini(){
    const sx = mini.width / W, sy = mini.height / H;

    // locked base (black)
    mctx.fillStyle = '#000'; mctx.fillRect(0,0,mini.width,mini.height);
    // preview area (see-through)
    mctx.fillStyle = 'rgba(163,176,197,.25)';
    mctx.fillRect(preview.x0*sx, preview.y0*sy, (preview.x1-preview.x0+1)*sx, (preview.y1-preview.y0+1)*sy);
    // unlocked area (clear dark)
    mctx.fillStyle = '#1c293e';
    mctx.fillRect(unlocked.x0*sx, unlocked.y0*sy, (unlocked.x1-unlocked.x0+1)*sx, (unlocked.y1-unlocked.y0+1)*sy);

    // building
    mctx.fillStyle = '#7a3a3a'; mctx.fillRect(bX*sx, bY*sy, bW*sx, bH*sy);
    // roads
    mctx.fillStyle = '#788292';
    mctx.fillRect(unlocked.x0*sx, roadY*sy, (unlocked.x1-unlocked.x0+1)*sx, 1.4*sy);
    mctx.fillRect(door.gx*sx, unlocked.y0*sy, 1.4*sx, (unlocked.y1-unlocked.y0+1)*sy);
    // player dot
    mctx.fillStyle = '#35f1ff'; mctx.fillRect((player.x/TILE)*sx-1, (player.y/TILE)*sy-1, 2, 2);
  }

  function drawBig(){
    const sx = bigmap.width / W, sy = bigmap.height / H;

    bctx.fillStyle = '#000'; bctx.fillRect(0,0,bigmap.width,bigmap.height);
    bctx.fillStyle = 'rgba(163,176,197,.25)';
    bctx.fillRect(preview.x0*sx, preview.y0*sy, (preview.x1-preview.x0+1)*sx, (preview.y1-preview.y0+1)*sy);
    bctx.fillStyle = '#1c293e';
    bctx.fillRect(unlocked.x0*sx, unlocked.y0*sy, (unlocked.x1-unlocked.x0+1)*sx, (unlocked.y1-unlocked.y0+1)*sy);
    bctx.fillStyle = '#7a3a3a'; bctx.fillRect(bX*sx, bY*sy, bW*sx, bH*sy);
    bctx.fillStyle = '#788292';
    bctx.fillRect(unlocked.x0*sx, roadY*sy, (unlocked.x1-unlocked.x0+1)*sx, 1.6*sy);
    bctx.fillRect(door.gx*sx, unlocked.y0*sy, 1.6*sx, (unlocked.y1-unlocked.y0+1)*sy);
    bctx.fillStyle = '#35f1ff'; bctx.fillRect((player.x/TILE)*sx-1.5,(player.y/TILE)*sy-1.5,3,3);
  }

  document.getElementById('miniWrap').addEventListener('click', ()=>{ drawBig(); mapModal.style.display='flex'; });
  document.getElementById('closeMap').addEventListener('click', ()=> mapModal.style.display='none');
  mapModal.addEventListener('click', (e)=>{ if(e.target.classList.contains('backdrop')) mapModal.style.display='none'; });

  // ---------- Drawing ----------
  function drawTile(gx,gy,screenX,screenY){
    const S = DRAW;

    // Outside unlocked → draw black and bail (solid wall)
    if(!inUnlocked(gx,gy)){ ctx.fillStyle='#000'; ctx.fillRect(screenX,screenY,S,S); return; }

    // Base ground (grass)
    ctx.fillStyle = '#09371c';
    ctx.fillRect(screenX,screenY,S,S);

    // Building footprint
    if(gx>=bX && gx<bX+bW && gy>=bY && gy<bY+bH){
      ctx.fillStyle = '#4a2d2d'; ctx.fillRect(screenX,screenY,S,S);
      ctx.fillStyle = 'rgba(0,0,0,.15)'; ctx.fillRect(screenX,screenY,S,Math.floor(S*0.18));
    }

    // Sidewalk
    if(gy===sidewalkY){
      ctx.fillStyle = '#6a727b'; ctx.fillRect(screenX,screenY,S,S);
      ctx.strokeStyle = 'rgba(0,0,0,.25)'; ctx.strokeRect(screenX,screenY,S,S);
    }

    // Road with dotted center
    if(gy===roadY){
      ctx.fillStyle = '#2a2a2a'; ctx.fillRect(screenX,screenY,S,S);
      ctx.fillStyle = '#ffd23f';
      // dashed line
      for(let i=0;i<4;i++){
        ctx.fillRect(screenX + i*(S/4) + S*0.05, screenY + S*0.48, S*0.10, S*0.04);
      }
    }

    // Door (on sidewalk)
    if(gx===door.gx && gy===door.gy){
      const near = doorInRange();
      ctx.fillStyle = near ? '#39cc69' : '#49a4ff';
      const w = Math.floor(S*0.30), h = Math.floor(S*0.72);
      ctx.fillRect(screenX + (S-w)/2, screenY + (S-h), w, h);

      // prompt
      if(near){
        const prompt = document.getElementById('prompt');
        prompt.style.left = (screenX + S/2) + 'px';
        prompt.style.top  = (screenY - 8) + 'px';
        prompt.style.display = 'block';
      }
    }
  }

  function drawPlayer(images){
    const S = DRAW, sx = Math.floor(player.x - camera.x), sy = Math.floor(player.y - camera.y);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(images.body,   0,0,TILE,TILE, sx, sy, S, S);
    ctx.drawImage(images.outfit, 0,0,TILE,TILE, sx, sy, S, S);
    ctx.drawImage(images.hair,   0,0,TILE,TILE, sx, sy, S, S);
  }

  // ---------- Update & render ----------
  function update(dt){
    // hide prompt each tick unless door redraw shows it
    document.getElementById('prompt').style.display='none';

    let dx=0, dy=0;
    if(keys['arrowup']||keys['w']) dy-=1;
    if(keys['arrowdown']||keys['s']) dy+=1;
    if(keys['arrowleft']||keys['a']) dx-=1;
    if(keys['arrowright']||keys['d']) dx+=1;
    dx+=vec.x; dy+=vec.y;

    const mag=Math.hypot(dx,dy);
    const vx = mag? (dx/mag)*player.speed : 0;
    const vy = mag? (dy/mag)*player.speed : 0;

    tryMove(player.x + vx*dt, player.y + vy*dt);
    centerCamera();
  }

  function render(images){
    ctx.fillStyle='#000'; ctx.fillRect(0,0,cvs.width,cvs.height);

    const S = DRAW;
    const tilesX = Math.ceil(cvs.width / S) + 2;
    const tilesY = Math.ceil(cvs.height / S) + 2;
    const startX = Math.max(0, Math.floor(camera.x / TILE));
    const startY = Math.max(0, Math.floor(camera.y / TILE));

    for(let y=0;y<tilesY;y++){
      for(let x=0;x<tilesX;x++){
        const gx = startX + x, gy = startY + y;
        if(gx>=0 && gx<W && gy>=0 && gy<H){
          const screenX = (gx*TILE - camera.x) * (S/TILE);
          const screenY = (gy*TILE - camera.y) * (S/TILE);
          drawTile(gx,gy,screenX,screenY);
        }
      }
    }
    drawPlayer(images);

    // repaint mini-map
    drawMini();
  }

  Promise.all([loadImg(assets.body), loadImg(assets.outfit), loadImg(assets.hair)]).then(([body,outfit,hair])=>{
    const imgs = { body, outfit, hair };
    let last = performance.now();
    function loop(now){
      const dt = Math.min(32, now-last); last=now;
      update(dt/16.6667);
      render(imgs);
      requestAnimationFrame(loop);
    }
    centerCamera();
    requestAnimationFrame(loop);
  }).catch(err=>console.error("Sprite load failed", err));
})();
