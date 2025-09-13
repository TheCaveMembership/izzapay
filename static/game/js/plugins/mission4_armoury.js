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

  // ---------- fireworks: gold/silver with neon bottoms ----------
  function worldToScreen(wx, wy){
    const S = api.DRAW, T = api.TILE;
    const sx = (wx - api.camera.x) * (S/T);
    const sy = (wy - api.camera.y) * (S/T);
    return { sx, sy };
  }

  function spawnFireworksAt(sx, sy){
    try{
      // overlay canvas (raise z-index to beat floating chips)
      let canvas = document.createElement('canvas');
      const game = document.getElementById('game');
      canvas.width  = game.width;
      canvas.height = game.height;
      canvas.style.cssText = 'position:absolute;inset:0;margin:auto;z-index:10000;pointer-events:none;';
      canvas.id = 'm4FireworksOverlay';
      document.body.appendChild(canvas);
      const ctx = canvas.getContext('2d');

      // particle system (life × ~1.8 for longer, plus longer run window)
      const particles = [];
      const bursts = 3;
      const GOLD = ['#ffd23f','#ffcc33','#ffe680'];
      const SILV = ['#cfd8dc','#e0e0e0','#f5f7f9'];
      const NEON = ['#00e5ff','#ff00ff','#39ff14'];

      function addBurst(cx, cy, n, speed, neonBottom){
        for(let i=0;i<n;i++){
          const ang = (Math.PI*2)*(i/n) + Math.random()*0.3;
          const v   = speed*(0.7 + Math.random()*0.6);
          const topCol = Math.random() < 0.7 ? GOLD[(Math.random()*GOLD.length)|0] : SILV[(Math.random()*SILV.length)|0];
          const neonCol= NEON[(Math.random()*NEON.length)|0];
          particles.push({
            x:cx, y:cy,
            vx:Math.cos(ang)*v, vy:Math.sin(ang)*v - 0.45,
            life: 110 + (Math.random()*30|0),   // ↑ was ~60–80
            age: 0,
            r: 1.6 + Math.random()*1.4,
            colTop: topCol,
            colNeon: neonBottom ? neonCol : topCol,
          });
        }
      }
      function addSpray(cx, cy, dir, n, speed){
        for(let i=0;i<n;i++){
          const a = dir + (Math.random()-0.5)*0.4;
          const v = speed*(0.6+Math.random()*0.8);
          particles.push({
            x:cx, y:cy,
            vx:Math.cos(a)*v, vy:Math.sin(a)*v - 0.35,
            life: 90 + (Math.random()*30|0),    // ↑ was ~45–60
            age: 0,
            r: 1.2 + Math.random()*1.0,
            colTop: GOLD[(Math.random()*GOLD.length)|0],
            colNeon: NEON[(Math.random()*NEON.length)|0],
          });
        }
      }

      // stronger pulsing skull watermark behind particles
      const skullPath = new Path2D("M16 3c-3.9 0-7 3.1-7 7v2c0 2 1 3 2 4v4c0 .6.4 1 1 1h1c.6 0 1-.4 1-1v-2h4v2c0 .6.4 1 1 1h1c.6 0 1-.4 1-1v-4c1-1 2-2 2-4V10c0-3.9-3.1-7-7-7Zm-3 10a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm6 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Z");

      addBurst(sx, sy, 80, 5.0, true);
      addBurst(sx+12, sy-8, 60, 4.4, true);
      addBurst(sx-14, sy-12, 50, 4.0, false);
      addSpray(sx, sy+6, Math.PI*0.53, 50, 5.5);
      addSpray(sx, sy+6, Math.PI*0.47 + Math.PI, 50, 5.5);

      let frame = 0;
      const maxFrames = 220; // ↑ doubled (~4s at ~55–60fps)
      (function tick(){
        frame++;
        ctx.clearRect(0,0,canvas.width, canvas.height);

        // mystical backdrop (more visible)
        ctx.save();
        const rg = ctx.createRadialGradient(sx, sy, 0, sx, sy, Math.max(canvas.width, canvas.height)*0.55);
        rg.addColorStop(0, 'rgba(255,215,64,0.28)');  // ↑ from 0.18
        rg.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = rg;
        ctx.fillRect(0,0,canvas.width,canvas.height);

        // pulsing skull behind the burst (brighter & bigger)
        ctx.globalAlpha = 0.18 + 0.10*Math.sin(frame*0.18);
        ctx.translate(sx, sy);
        ctx.scale(3.6, 3.6);                        // ↑ scale
        ctx.fillStyle = 'rgba(200,200,220,0.55)';   // ↑ opacity
        ctx.fill(skullPath);
        ctx.restore();

        // particles
        for (let i=particles.length-1; i>=0; i--){
          const p = particles[i];
          p.age++;
          if (p.age >= p.life){ particles.splice(i,1); continue; }
          p.vy += 0.055;
          p.vx *= 0.995;
          p.x  += p.vx;
          p.y  += p.vy;

          const k = p.age / p.life;
          const useNeon = (k > 0.65); // neon later in life
          const col = useNeon ? p.colNeon : p.colTop;

          // gold glow (keep mostly gold/silver look)
          if (!useNeon){
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.r*2.8, 0, Math.PI*2);
            ctx.fillStyle = 'rgba(255,230,120,0.24)';
            ctx.fill();
          }

          // core
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r, 0, Math.PI*2);
          ctx.fillStyle = col;
          ctx.fill();

          // graffiti spark line
          if ((p.age % 9) === 0){
            ctx.save();
            ctx.globalAlpha = 0.4;
            ctx.strokeStyle = col;
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(p.x - p.vx*2.4, p.y - p.vy*2.4);
            ctx.stroke();
            ctx.restore();
          }
        }

        if (frame < maxFrames && particles.length){
          requestAnimationFrame(tick);
        } else {
          // slower fade
          let fade = 0.35;
          (function fadeOut(){
            fade -= 0.03;
            if (fade <= 0){ canvas.remove(); return; }
            ctx.fillStyle = `rgba(0,0,0,0.04)`;
            ctx.fillRect(0,0,canvas.width,canvas.height);
            requestAnimationFrame(fadeOut);
          })();
        }
      })();
    }catch{}
  }

  // ---------- tiny, safe confirm (custom popup with wood title; darker navy body) ----------
  function confirmPickup(cb){
    try{
      // wood grain SVG data-uri for title text fill (dark driftwood)
      const woodTex = encodeURIComponent(`
        <svg xmlns="http://www.w3.org/2000/svg" width="120" height="60">
          <defs>
            <linearGradient id="g" x1="0" x2="1">
              <stop offset="0" stop-color="#3b2a1a"/>
              <stop offset="0.5" stop-color="#5a4330"/>
              <stop offset="1" stop-color="#2a1a10"/>
            </linearGradient>
          </defs>
          <rect width="100%" height="100%" fill="url(#g)"/>
          <g opacity="0.45" stroke="#1a110b" stroke-width="2" fill="none">
            <path d="M0,18 C30,8 60,26 120,14"/>
            <path d="M0,42 C25,30 70,48 120,34"/>
            <path d="M10,10 L20,20 M40,5 L44,15 M80,25 L92,40"/>
          </g>
        </svg>
      `);

      // subtle repeating skull wallpaper (more visible)
      const skullBG = encodeURIComponent(`
        <svg xmlns="http://www.w3.org/2000/svg" width="80" height="80">
          <g opacity="0.12" fill="#cfd8dc">
            <path d="M40 10c-9 0-16 7-16 16v5c0 5 3 7 6 9v8c0 1 .8 2 2 2h2c1 0 2-.9 2-2v-4h8v4c0 1 .9 2 2 2h2c1 0 2-.9 2-2v-8c3-2 6-4 6-9v-5c0-9-7-16-16-16zM30 28a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm20 0a3 3 0 1 1 0-6 3 3 0 0 1 0 6z"/>
          </g>
        </svg>
      `);

      let wrap = document.createElement('div');
      wrap.id = 'm4BoxConfirm';
      wrap.style.cssText =
        'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;' +
        'background:rgba(0,0,0,.55);z-index:10000;';

      const card = document.createElement('div');
      card.style.cssText =
        'position:relative;min-width:320px;max-width:560px;padding:18px 16px 14px;border-radius:14px;' +
        'border:2px solid #6a4c1e;box-shadow:0 16px 44px rgba(0,0,0,.6), inset 0 0 40px rgba(255,215,64,.15);' +
        'color:#0c0a08;overflow:hidden;' +
        `background:
           radial-gradient(120% 90% at -10% -10%, rgba(255,215,64,.20), rgba(0,0,0,0) 60%),
           radial-gradient(130% 80% at 110% 110%, rgba(192,192,192,.22), rgba(0,0,0,0) 60%),
           linear-gradient(135deg, #ffe7a4 0%, #ffd56a 35%, #f2b84a 60%, #e0a83f 100%),
           url("data:image/svg+xml,${skullBG}") repeat`;

      const spray = document.createElement('div');
      spray.style.cssText =
        'position:absolute;left:-10%;right:-10%;top:54px;height:14px;' +
        'background:linear-gradient(90deg, rgba(0,229,255,.35), rgba(255,0,255,.35), rgba(57,255,20,.35));' +
        'filter:blur(3px);transform:skewX(-12deg);opacity:.7;';
      card.appendChild(spray);

      // ---- Title (dark wood grain) ----
      const title = document.createElement('div');
      title.style.cssText =
        'font-size:22px;font-weight:900;letter-spacing:1px;margin-bottom:8px;' +
        'transform:skewX(-2deg) rotate(-0.4deg);' +
        `background-image:url("data:image/svg+xml,${woodTex}"); -webkit-background-clip:text; background-clip:text; color:transparent;` +
        'text-shadow:0 1px 0 rgba(0,0,0,0.65), 0 2px 0 rgba(0,0,0,0.45);';
      title.textContent = 'A cardboard box?';

      // ---- Body (navy, darker; stands out more) ----
      const rhyme = document.createElement('div');
      rhyme.style.cssText =
        'margin:10px 0 14px;font-weight:900;line-height:1.35;' +
        'color:#0b1935;' + // dark navy
        'text-shadow:0 1px 0 rgba(255,255,255,0.06), 0 2px 0 rgba(0,0,0,0.45);';
      rhyme.innerHTML =
        `<div style="transform:rotate(-0.4deg)">
          Hmmm… should I grab it or walk away?<br>
          Feels simple, but something about this choice hits different.<br>
          Could change the path, could shape what comes next. There are some boats by the docks? I wonder what they could lead to?<br><br>
          <strong>Take it… or leave it.</strong>
        </div>`;

      const btnRow = document.createElement('div');
      btnRow.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;align-items:center;';

      const noBtn = document.createElement('button');
      noBtn.textContent = 'Leave it';
      noBtn.style.cssText =
        'background:#263447;color:#cfe3ff;border:0;border-radius:8px;padding:8px 12px;font-weight:800;cursor:pointer;';

      const yesBtn = document.createElement('button');
      yesBtn.textContent = 'Take the Box';
      yesBtn.style.cssText =
        'background:#1f6feb;color:#fff;border:0;border-radius:10px;padding:10px 14px;font-weight:900;cursor:pointer;' +
        'box-shadow:0 0 0 0 rgba(255,210,63,.0);';
      let pulse = 0;
      (function pulseBtn(){
        if (!wrap.parentNode) return;
        pulse += 0.12;
        const glow = (Math.sin(pulse)*0.5+0.5)*18 + 12;
        yesBtn.style.boxShadow = `0 0 ${glow}px ${Math.round(glow*0.06)}px rgba(255,210,63,.7)`;
        requestAnimationFrame(pulseBtn);
      })();

      btnRow.appendChild(noBtn);
      btnRow.appendChild(yesBtn);

      card.appendChild(title);
      card.appendChild(rhyme);
      card.appendChild(btnRow);
      wrap.appendChild(card);
      document.body.appendChild(wrap);

      function close(){ wrap.remove(); }

      noBtn.addEventListener('click', close, {capture:true});
      wrap.addEventListener('click', (e)=>{ if(e.target===wrap) close(); }, {capture:true});
      window.addEventListener('keydown', (e)=>{ if((e.key||'').toLowerCase()==='escape') close(); }, {capture:true});

      yesBtn.addEventListener('click', ()=>{
        try{ cb?.(); }catch{}
        try{
          const px = api.player.x + 16;
          const py = api.player.y + 16;
          const scr = worldToScreen(px, py);
          spawnFireworksAt(scr.sx, scr.sy - 10);
        }catch{
          const gc = document.getElementById('game');
          spawnFireworksAt(gc.width/2, gc.height/2);
        }
        close();
      }, {capture:true});

      return;
    }catch{}

    // fallback confirm
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
      });
    }
    // else let other B handlers run
  }

  // ---------- hook up ----------
  IZZA.on?.('ready', (a)=>{
    api = a;
    IZZA.on?.('render-under', renderBox);
    document.getElementById('btnB')?.addEventListener('click', onB, true);
    window.addEventListener('keydown', e=>{ if((e.key||'').toLowerCase()==='b') onB(e); }, true);
  });

})();
