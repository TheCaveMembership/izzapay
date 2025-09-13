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
      // overlay canvas
      let canvas = document.createElement('canvas');
      canvas.width  = document.getElementById('game').width;
      canvas.height = document.getElementById('game').height;
      canvas.style.cssText = 'position:absolute;inset:0;margin:auto;z-index:250;pointer-events:none;';
      canvas.id = 'm4FireworksOverlay';
      document.body.appendChild(canvas);
      const ctx = canvas.getContext('2d');

      // particle system
      const particles = [];
      const bursts = 3; // a few layered bursts
      const GOLD = ['#ffd23f','#ffcc33','#ffe680'];
      const SILV = ['#cfd8dc','#e0e0e0','#f5f7f9'];
      const NEON = ['#00e5ff','#ff00ff','#39ff14'];

      function addBurst(cx, cy, n, speed, neonBottom){
        for(let i=0;i<n;i++){
          const ang = (Math.PI*2)*(i/n) + Math.random()*0.3;
          const v   = speed*(0.7 + Math.random()*0.6);
          // gold/silver main, neon when falling
          const topCol = Math.random() < 0.6 ? GOLD[(Math.random()*GOLD.length)|0] : SILV[(Math.random()*SILV.length)|0];
          const neonCol= NEON[(Math.random()*NEON.length)|0];
          particles.push({
            x:cx, y:cy,
            vx:Math.cos(ang)*v, vy:Math.sin(ang)*v - 0.5,
            life: 60 + (Math.random()*20|0),
            age: 0,
            r: 1.6 + Math.random()*1.4,
            colTop: topCol,
            colNeon: neonBottom ? neonCol : topCol,
          });
        }
      }

      // skewed sprays: graffiti shimmer lines
      function addSpray(cx, cy, dir, n, speed){
        for(let i=0;i<n;i++){
          const a = dir + (Math.random()-0.5)*0.4;
          const v = speed*(0.6+Math.random()*0.8);
          particles.push({
            x:cx, y:cy,
            vx:Math.cos(a)*v, vy:Math.sin(a)*v - 0.4,
            life: 45 + (Math.random()*15|0),
            age: 0,
            r: 1.2 + Math.random()*1.0,
            colTop: GOLD[(Math.random()*GOLD.length)|0],
            colNeon: NEON[(Math.random()*NEON.length)|0],
          });
        }
      }

      // subtle skull watermark pulse behind particles
      const skullPath = new Path2D("M16 3c-3.9 0-7 3.1-7 7v2c0 2 1 3 2 4v4c0 .6.4 1 1 1h1c.6 0 1-.4 1-1v-2h4v2c0 .6.4 1 1 1h1c.6 0 1-.4 1-1v-4c1-1 2-2 2-4V10c0-3.9-3.1-7-7-7Zm-3 10a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm6 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Z");

      // build bursts around source with slight offsets
      addBurst(sx, sy, 70, 5.0, true);
      addBurst(sx+10, sy-6, 50, 4.4, true);
      addBurst(sx-12, sy-10, 40, 4.0, false);
      addSpray(sx, sy+6, Math.PI*0.53, 40, 5.5);
      addSpray(sx, sy+6, Math.PI*0.47 + Math.PI, 40, 5.5);

      let frame = 0;
      const maxFrames = 110; // ~2s at 55 fps
      (function tick(){
        frame++;
        ctx.clearRect(0,0,canvas.width, canvas.height);

        // mystical backdrop (very faint radial + skull)
        ctx.save();
        const rg = ctx.createRadialGradient(sx, sy, 0, sx, sy, Math.max(canvas.width, canvas.height)*0.5);
        rg.addColorStop(0, 'rgba(255,215,64,0.18)');
        rg.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = rg;
        ctx.fillRect(0,0,canvas.width,canvas.height);

        ctx.globalAlpha = 0.08 + 0.05*Math.sin(frame*0.2);
        ctx.translate(sx, sy);
        ctx.scale(2.8, 2.8);
        ctx.fillStyle = 'rgba(190,190,200,0.35)';
        ctx.fill(skullPath);
        ctx.restore();

        // particles
        for (let i=particles.length-1; i>=0; i--){
          const p = particles[i];
          p.age++;
          if (p.age >= p.life){ particles.splice(i,1); continue; }
          // physics
          p.vy += 0.06; // gravity
          p.vx *= 0.995;
          p.x  += p.vx;
          p.y  += p.vy;

          // color shift: bright gold/silver on top half of life, neon near the end
          const k = p.age / p.life;
          const useNeon = (k > 0.6);
          const col = useNeon ? p.colNeon : p.colTop;

          // glow
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r*2.6, 0, Math.PI*2);
          ctx.fillStyle = useNeon ? 'rgba(0,0,0,0)' : 'rgba(255,230,120,0.22)';
          ctx.fill();

          // core
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r, 0, Math.PI*2);
          ctx.fillStyle = col;
          ctx.fill();

          // occasional spark line (graffiti spray feel)
          if ((p.age % 10) === 0){
            ctx.save();
            ctx.globalAlpha = 0.35;
            ctx.strokeStyle = col;
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(p.x - p.vx*2, p.y - p.vy*2);
            ctx.stroke();
            ctx.restore();
          }
        }

        if (frame < maxFrames && particles.length){
          requestAnimationFrame(tick);
        } else {
          // graceful fadeout
          let fade = 0.25;
          (function fadeOut(){
            fade -= 0.05;
            if (fade <= 0){ canvas.remove(); return; }
            ctx.fillStyle = `rgba(0,0,0,${0.05})`;
            ctx.fillRect(0,0,canvas.width,canvas.height);
            requestAnimationFrame(fadeOut);
          })();
        }
      })();
    }catch{}
  }

  // ---------- tiny, safe confirm (replaced with custom popup) ----------
  function confirmPickup(cb){
    try{
      // custom modal with graffiti/street vibe + subtle symbols
      let wrap = document.createElement('div');
      wrap.id = 'm4BoxConfirm';
      wrap.style.cssText =
        'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;' +
        'background:rgba(0,0,0,.55);z-index:240;';

      // subtle repeating skulls as background overlay (very faint)
      const skullBG = encodeURIComponent(`
        <svg xmlns="http://www.w3.org/2000/svg" width="80" height="80">
          <g opacity="0.05" fill="#cfd8dc">
            <path d="M40 10c-9 0-16 7-16 16v5c0 5 3 7 6 9v8c0 1 .8 2 2 2h2c1 0 2-.9 2-2v-4h8v4c0 1 .9 2 2 2h2c1 0 2-.9 2-2v-8c3-2 6-4 6-9v-5c0-9-7-16-16-16zM30 28a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm20 0a3 3 0 1 1 0-6 3 3 0 0 1 0 6z"/>
          </g>
        </svg>
      `);

      const card = document.createElement('div');
      card.style.cssText =
        'position:relative;min-width:320px;max-width:560px;padding:18px 16px 14px;border-radius:14px;' +
        'border:2px solid #6a4c1e;box-shadow:0 16px 44px rgba(0,0,0,.6), inset 0 0 40px rgba(255,215,64,.15);' +
        'color:#0c0a08;overflow:hidden;' +
        // layered backgrounds: graffiti spray + faint skull wallpaper
        `background:
           radial-gradient(120% 90% at -10% -10%, rgba(255,215,64,.20), rgba(0,0,0,0) 60%),
           radial-gradient(130% 80% at 110% 110%, rgba(192,192,192,.22), rgba(0,0,0,0) 60%),
           linear-gradient(135deg, #ffe7a4 0%, #ffd56a 35%, #f2b84a 60%, #e0a83f 100%),
           url("data:image/svg+xml,${skullBG}") repeat`;

      // neon underline spritz
      const spray = document.createElement('div');
      spray.style.cssText =
        'position:absolute;left:-10%;right:-10%;top:54px;height:14px;' +
        'background:linear-gradient(90deg, rgba(0,229,255,.35), rgba(255,0,255,.35), rgba(57,255,20,.35));' +
        'filter:blur(3px);transform:skewX(-12deg);opacity:.7;';
      card.appendChild(spray);

      const title = document.createElement('div');
      title.style.cssText =
        'font-size:22px;font-weight:900;letter-spacing:1px;margin-bottom:8px;' +
        'color:#1d1205;text-shadow:0 1px 0 #fff5cc, 0 2px 0 rgba(0,0,0,.12);' +
        'transform:skewX(-2deg) rotate(-0.4deg);';
      title.textContent = 'THE BOX CALLS.';

      const rhyme = document.createElement('div');
      rhyme.style.cssText = 'margin:10px 0 14px;font-weight:700;line-height:1.35;';
      rhyme.innerHTML =
        `<div style="transform:rotate(-0.4deg)">` +
        `<span style="background:linear-gradient(90deg,#ffd23f,#ffffff);-webkit-background-clip:text;background-clip:text;color:transparent;">` +
        `Cardboard crown, street-born throne — steal the hush, claim your zone.</span><br>` +
        `<span style="opacity:.9">Tap in, fade loud… or leave it lone.</span><br>` +
        `<span style="opacity:.9">Ever slide the docks, drove a boat alone?</span>` +
        `</div>`;

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
      // pulsing gold aura
      let pulse = 0;
      (function pulseBtn(){
        if (!wrap.parentNode) return;
        pulse += 0.12;
        const glow = (Math.sin(pulse)*0.5+0.5)*18 + 10;
        yesBtn.style.boxShadow = `0 0 ${glow}px ${Math.round(glow*0.06)}px rgba(255,210,63,.65)`;
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
        // fire the callback first to ensure inventory writes land
        try{ cb?.(); }catch{}
        // fireworks center roughly at the popup center, but also try to anchor near player
        try{
          const px = api.player.x + 16;
          const py = api.player.y + 16;
          const scr = worldToScreen(px, py);
          spawnFireworksAt(scr.sx, scr.sy - 10);
        }catch{
          // fallback: center of canvas
          const gc = document.getElementById('game');
          spawnFireworksAt(gc.width/2, gc.height/2);
        }
        close();
      }, {capture:true});

      return;
    }catch{}

    // super-safe fallback if DOM failed
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
