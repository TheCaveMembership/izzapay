// mission4_armoury.js — Mission 4 minimal (NO shop UI)
// - Draws a cardboard box near HQ.
// - Press B ON the box to pick it up (confirm), updates inventory.
// - Does NOT add any armoury/shop items or override island docking.
// - Plays nice with v2_map_expander.js (which handles island door & docking).

(function(){
  const BOX_TAKEN_KEY = 'izzaBoxTaken';
  const M4_KEY        = 'izzaMission4'; // 'started' / 'not-started'

  let api = null;

  // ---------- helpers: inventory (wallet untouched) ----------
  function readInv(){
    try{
      if (IZZA?.api?.getInventory) return JSON.parse(JSON.stringify(IZZA.api.getInventory()||{}));
      const raw = localStorage.getItem('izzaInventory');
      return raw ? JSON.parse(raw) : {};
    }catch{ return {}; }
  }
  function writeInv(inv){
    try{
      if (IZZA?.api?.setInventory) IZZA.api.setInventory(inv);
      else localStorage.setItem('izzaInventory', JSON.stringify(inv));
      try { window.dispatchEvent(new Event('izza-inventory-changed')); } catch {}
    }catch{}
  }
  function addCount(inv, key, n){
    inv[key] = inv[key] || { count: 0 };
    inv[key].count = (inv[key].count|0) + n;
    if (inv[key].count <= 0) delete inv[key];
  }

  function setM4(v){ try{ localStorage.setItem(M4_KEY, v); }catch{} }

  // ---------- HQ door → box position ----------
  function hqDoorGrid(){
    const t = api.TILE;
    const d = api.doorSpawn || { x: api.player?.x||0, y: api.player?.y||0 };
    return { gx: Math.round(d.x/t), gy: Math.round(d.y/t) };
  }
  // same offsets as your original mission script
  function cardboardBoxGrid(){
    const d = hqDoorGrid();
    return { x: d.gx + 3, y: d.gy + 10 };
  }

  // ---------- driftwood text texture (darker, cracked) ----------
  const _woodTex = encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" width="140" height="70">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0"   stop-color="#2f2116"/>
          <stop offset="0.5" stop-color="#4a3727"/>
          <stop offset="1"   stop-color="#1e140d"/>
        </linearGradient>
      </defs>
      <rect width="100%" height="100%" fill="url(#g)"/>
      <g opacity="0.50" stroke="#120c08" stroke-width="2" fill="none">
        <path d="M0,20 C35,8 70,26 140,12"/>
        <path d="M0,46 C28,34 80,50 140,36"/>
      </g>
      <g opacity="0.60" stroke="#160e09" stroke-width="1">
        <path d="M12,9 l8,8 M44,6 l3,10 M85,24 l9,12 M110,12 l6,10"/>
        <path d="M22,55 l6,-5 M60,40 l5,-6 M100,52 l7,-6"/>
      </g>
    </svg>
  `);

  // ---------- skull wallpaper (very faint, tiled) ----------
  const _skulls = encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" width="80" height="80">
      <g opacity="0.10" fill="#111">
        <path d="M40 18c-9 0-16 6-16 14 0 7 5 10 8 12v6h16v-6c3-2 8-5 8-12 0-8-7-14-16-14zM30 36h4v6h-4zM46 36h4v6h-4z"/>
        <rect x="18" y="58" width="44" height="6" rx="3"/>
      </g>
    </svg>
  `);

  // ---------- graffiti gold spray used in modal frame ----------
  const _graffSpray = 'radial-gradient(120px 40px at 12% 0%, rgba(255,230,120,0.25), rgba(0,0,0,0) 60%), radial-gradient(110px 50px at 100% 100%, rgba(255,210,90,0.20), rgba(0,0,0,0) 60%)';

  // ---------- CONFIRM MODAL (street vibe, skull background, dark wood text) ----------
  function ensureBoxModal(){
    if (document.getElementById('boxConfirmWrap')) return;

    const wrap = document.createElement('div');
    wrap.id = 'boxConfirmWrap';
    wrap.style.cssText =
      'position:absolute;inset:0;display:none;align-items:center;justify-content:center;z-index:120;' +
      'background:rgba(0,0,0,.55);';

    const card = document.createElement('div');
    card.style.cssText =
      'position:relative;max-width:600px;min-width:300px;padding:16px 16px 12px;border-radius:14px;' +
      'border:2px solid #7b5a2b;box-shadow:0 16px 40px rgba(0,0,0,.6), inset 0 0 35px rgba(60,30,10,.18);' +
      'background:linear-gradient(180deg,#e9c96b,#dfb951 40%,#d8b146 60%,#caa33f),' +
      `url("data:image/svg+xml,${_skulls}") repeat;` +
      'background-blend-mode:multiply,normal;' +
      'transform:rotate(-0.4deg);';

    // subtle gold/silver spray overlay
    card.style.backgroundImage = `linear-gradient(180deg,#e9c96b,#dfb951 40%,#d8b146 60%,#caa33f), url("data:image/svg+xml,${_skulls}"), ${_graffSpray}`;
    card.style.backgroundBlendMode = 'multiply,normal,screen';

    const title = document.createElement('div');
    title.textContent = 'A cardboard box?';
    title.style.cssText =
      'font-size:22px;font-weight:900;letter-spacing:1px;margin-bottom:8px;' +
      'transform:skewX(-2deg) rotate(-0.4deg);' +
      `background-image:url("data:image/svg+xml,${_woodTex}"); -webkit-background-clip:text; background-clip:text; color:transparent;` +
      'text-shadow:0 2px 0 rgba(0,0,0,0.7), 0 3px 0 rgba(0,0,0,0.55);';

    const rhyme = document.createElement('div');
    rhyme.innerHTML =
      'Hmmm… should I grab it or walk away?<br>' +
      'Feels simple, but something about this choice hits different.<br>' +
      'Could change the path, could shape what comes next. There are some boats by the docks? I wonder what they could lead to?<br><br>' +
      'Take it… or leave it.';
    rhyme.style.cssText =
      'margin:8px 0 14px;font-weight:900;line-height:1.35;' +
      `background-image:url("data:image/svg+xml,${_woodTex}"); -webkit-background-clip:text; background-clip:text; color:transparent;` +
      'text-shadow:0 2px 0 rgba(0,0,0,0.65), 0 3px 0 rgba(0,0,0,0.45);';

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;align-items:center;';

    const leaveBtn = document.createElement('button');
    leaveBtn.textContent = 'Leave it';
    leaveBtn.style.cssText =
      'background:#263447;color:#cfe3ff;border:0;border-radius:10px;padding:10px 14px;font-weight:800;cursor:pointer;';

    const takeBtn = document.createElement('button');
    takeBtn.textContent = 'Take the Box';
    takeBtn.style.cssText =
      'background:#1f6feb;color:#fff;border:0;border-radius:10px;padding:10px 14px;font-weight:900;cursor:pointer;box-shadow:0 0 18px rgba(255,215,64,.35) inset;';

    btnRow.appendChild(leaveBtn);
    btnRow.appendChild(takeBtn);

    card.appendChild(title);
    card.appendChild(rhyme);
    card.appendChild(btnRow);
    wrap.appendChild(card);
    document.body.appendChild(wrap);

    wrap.addEventListener('click', (e)=>{ if (e.target===wrap) closeBoxModal(); }, {capture:true});
    window.addEventListener('keydown', (e)=>{ if ((e.key||'').toLowerCase()==='escape') closeBoxModal(); }, true);

    // expose handlers
    wrap._leaveBtn = leaveBtn;
    wrap._takeBtn  = takeBtn;
  }

  function openBoxModal(onTake, onLeave){
    ensureBoxModal();
    const wrap = document.getElementById('boxConfirmWrap');
    wrap.style.display = 'flex';

    wrap._leaveBtn.onclick = ()=>{ closeBoxModal(); onLeave?.(); };
    wrap._takeBtn.onclick  = ()=>{ closeBoxModal(); onTake?.(); };
  }

  function closeBoxModal(){
    const wrap = document.getElementById('boxConfirmWrap');
    if (wrap) wrap.style.display = 'none';
  }

  // ---------- tiny, safe confirm wrapper ----------
  function confirmPickup(cb){
    try{
      // prefer our custom street modal
      return openBoxModal(()=> cb?.(), ()=>{ /* noop on leave */ });
    }catch{}
    if (window.confirm('Pick up the cardboard box?')) cb?.();
  }

  // ---------- draw: simple 3D-looking box ----------
  function draw3DBox(ctx, sx, sy, S){
    ctx.save();
    ctx.translate(sx, sy);
    ctx.scale((S*0.68)/44, (S*0.68)/44);
    ctx.translate(-22, -22);
    ctx.fillStyle='rgba(0,0,0,0.18)'; ctx.beginPath(); ctx.ellipse(22,28,14,6,0,0,Math.PI*2); ctx.fill();
    const body = new Path2D('M6,18 L22,10 L38,18 L38,34 L22,42 L6,34 Z');
    ctx.fillStyle='#b98c4a'; ctx.fill(body);
    ctx.strokeStyle='#7d5f2e'; ctx.lineWidth=1.3; ctx.stroke(body);
    const flapL = new Path2D('M6,18 L22,26 L22,10 Z');
    const flapR = new Path2D('M38,18 L22,26 L22,10 Z');
    ctx.fillStyle='#cfa162'; ctx.fill(flapL); ctx.fill(flapR); ctx.stroke(flapL); ctx.stroke(flapR);
    ctx.fillStyle='#e9dfb1'; ctx.fillRect(21,10,2,16);
    ctx.restore();
  }

  // ---------- render-under: show box if not taken ----------
  function renderBox(){
    try{
      if (!api?.ready) return;
      if (localStorage.getItem('izzaMapTier') !== '2') return;
      if (localStorage.getItem(BOX_TAKEN_KEY) === '1') return;

      const S=api.DRAW, t=api.TILE, b=cardboardBoxGrid();
      const bx=(b.x*t - api.camera.x)*(S/t) + S*0.5;
      const by=(b.y*t - api.camera.y)*(S/t) + S*0.6;
      const ctx=document.getElementById('game')?.getContext('2d'); if(!ctx) return;
      draw3DBox(ctx, bx, by, S);
    }catch{}
  }

  // ---------- Fireworks overlay (gold/silver + neon base) ----------
  (function(){
    let fwCanvas=null, fwCtx=null, fwActive=false, fwParticles=[];
    // doubled life compared to prior version
    const LIFE_MS = 3600;         // total show time
    const BURST_MS = 1200;        // emit period
    const GRAV = 0.0005;

    function ensureFW(){
      if (fwCanvas) return;
      fwCanvas = document.createElement('canvas');
      fwCanvas.id = 'fwOverlay';
      fwCanvas.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:140;';
      fwCanvas.width = window.innerWidth; fwCanvas.height = window.innerHeight;
      fwCtx = fwCanvas.getContext('2d');
      document.body.appendChild(fwCanvas);
      window.addEventListener('resize', ()=>{
        fwCanvas.width = window.innerWidth; fwCanvas.height = window.innerHeight;
      });
    }

    function rand(a,b){ return a + Math.random()*(b-a); }

    function burst(x, y){
      for(let i=0;i<80;i++){
        const ang = Math.random()*Math.PI*2;
        const spd = rand(0.25, 1.4);
        const neon = (Math.random()<0.18);
        fwParticles.push({
          x, y, vx: Math.cos(ang)*spd, vy: Math.sin(ang)*spd - 0.2,
          life: rand(700,1400), age:0,
          color: neon ? `hsl(${rand(170,210)},90%,60%)` : (Math.random()<0.6 ? '#ffd54d' : '#dcdfe6'),
          glow: neon ? 18 : 12
        });
      }
    }

    function neonFountain(){
      const y = fwCanvas.height - 30;
      for(let k=0;k<2;k++){
        const x = fwCanvas.width* (k?0.76:0.24);
        for(let i=0;i<22;i++){
          fwParticles.push({
            x, y, vx: rand(-0.4,0.4), vy: rand(-1.6,-0.8),
            life: rand(400,900), age:0,
            color: i%2? '#ffd54d' : '#cfd3ff', glow: 10
          });
        }
      }
    }

    function tick(dt){
      if (!fwActive) return;
      fwCtx.clearRect(0,0,fwCanvas.width,fwCanvas.height);

      // emitters
      if (performance.now()%280 < 16) neonFountain();
      if (performance.now()%420 < 16) burst(rand(fwCanvas.width*0.25, fwCanvas.width*0.75), rand(fwCanvas.height*0.15, fwCanvas.height*0.45));

      // draw
      fwParticles = fwParticles.filter(p=>{
        p.age += dt;
        p.vy += GRAV * dt;
        p.x  += p.vx * dt;
        p.y  += p.vy * dt;

        const t = 1 - (p.age/p.life);
        if (t<=0) return false;

        fwCtx.save();
        fwCtx.globalCompositeOperation = 'lighter';
        fwCtx.globalAlpha = Math.max(0, t);
        fwCtx.shadowColor = p.color;
        fwCtx.shadowBlur  = p.glow;
        fwCtx.fillStyle   = p.color;
        fwCtx.beginPath();
        fwCtx.arc(p.x, p.y, 2 + 2*(1-t), 0, Math.PI*2);
        fwCtx.fill();
        fwCtx.restore();
        return true;
      });

      requestAnimationFrame(()=> tick(16));
    }

    function startFireworks(){
      ensureFW();
      fwActive = true;
      const t0 = performance.now();
      const loop = ()=>{
        if (!fwActive) return;
        const t = performance.now()-t0;
        if (t < LIFE_MS){
          requestAnimationFrame(loop);
        }else{
          fwActive = false;
          fwCtx && fwCtx.clearRect(0,0,fwCanvas.width,fwCanvas.height);
        }
      };
      requestAnimationFrame(loop);
      requestAnimationFrame(()=> tick(16));
      // initial big bursts
      burst(fwCanvas.width*0.32, fwCanvas.height*0.28);
      burst(fwCanvas.width*0.68, fwCanvas.height*0.32);
    }

    // expose
    window.__izzaStartFireworks = startFireworks;
  })();

  // ---------- B: pick up box ONLY when standing on it ----------
  function onB(e){
    if (!api?.ready) return;
    if (localStorage.getItem('izzaMapTier') !== '2') return;
    if (localStorage.getItem(BOX_TAKEN_KEY) === '1') return;

    const t=api.TILE;
    const gx=((api.player.x+16)/t|0), gy=((api.player.y+16)/t|0);
    const box = cardboardBoxGrid();

    if (gx === box.x && gy === box.y){
      e?.preventDefault?.(); e?.stopImmediatePropagation?.(); e?.stopPropagation?.();
      confirmPickup(()=>{
        const inv = readInv();
        addCount(inv, 'cardboard_box', 1);
        writeInv(inv);
        try{
          localStorage.setItem(BOX_TAKEN_KEY, '1');
          if ((localStorage.getItem(M4_KEY)||'not-started') === 'not-started') setM4('started');
        }catch{}
        try{ IZZA.toast?.('Cardboard Box added to Inventory'); }catch{}
        // Fireworks (gold/silver with a touch of neon at base) — now lasts longer
        try{ window.__izzaStartFireworks?.(); }catch{}
      });
    }
    // else: do nothing → allow other B interactions (hospital/bank/armoury/etc.)
  }

  // ---------- hook up ----------
  IZZA.on?.('ready', (a)=>{
    api = a;
    // draw box
    IZZA.on?.('render-under', renderBox);
    // capture-phase B near box only
    document.getElementById('btnB')?.addEventListener('click', onB, true);
    window.addEventListener('keydown', e=>{ if((e.key||'').toLowerCase()==='b') onB(e); }, true);
  });

})();
