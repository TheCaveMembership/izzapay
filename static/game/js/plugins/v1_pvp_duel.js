// PvP Duel Client — v4.6
// - REAL opponent sprite via remote_players_api.js (unchanged)
// - Spawn logic: per-round, far-apart, deterministic by (matchId, round, sorted usernames)
// - Red-dot minimap (unchanged)
// - Hearts HUD bridge (unchanged; updates localStorage segs)
// - Reliable hits: hitscan + melee range
// - Mobile melee: hook btnA
// - Tracers + impact sparks, and NOW pistol tracers STOP on hit (no follow-through)
// - Match flow: round banners centered, Bo3, bounce to lobby at end
(function(){
  const BUILD='v4.6-duel-client';
  console.log('[IZZA PLAY]', BUILD);

  const BASE = (window.__MP_BASE__ || '/izza-game/api/mp');
  const TOK  = (window.__IZZA_T__ || '').toString();
  const withTok = (p)=> TOK ? p + (p.includes('?')?'&':'?') + 't=' + encodeURIComponent(TOK) : p;
  const norm = (s)=> (s||'').toString().replace(/^@+/,'').toLowerCase();

  async function $post(p,b){ try{ const r=await fetch(withTok(BASE+p),{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify(b||{})}); return r.ok? r.json():null; }catch{ return null; } }
  async function $get(p){ try{ const r=await fetch(withTok(BASE+p),{credentials:'include'}); return r.ok? r.json():null; }catch{ return null; } }

  // ---------- RNG helpers ----------
  function hash32(str){
    let h=2166136261>>>0;
    for(let i=0;i<str.length;i++){ h^=str.charCodeAt(i); h=Math.imul(h,16777619); }
    h^=h<<13; h^=h>>>17; h^=h<<5;
    return (h>>>0);
  }
  function hash01(str){ return (hash32(String(str)) % 100000) / 100000; }
  function choice(arr, seed){ if(!arr.length) return null; const i = Math.floor(hash01(seed)*arr.length); return arr[i]; }

  // ---------- map helpers (match core) ----------
  function unlockedRect(tier){ return (tier==='2') ? { x0:10, y0:12, x1:80, y1:50 } : { x0:18, y0:18, x1:72, y1:42 }; }

  // Build a set of widely separated spawn candidates along sidewalks
  function buildSpawnCandidates(api){
    const t=api.TILE;
    const tier = localStorage.getItem('izzaMapTier') || '2';
    const un   = unlockedRect(tier);
    const hRoadY = api.hRoadY, vRoadX = api.vRoadX;
    const sidewalkTopY = hRoadY - 1, sidewalkBotY = hRoadY + 1;
    const leftX  = vRoadX - 1, rightX = vRoadX + 1;

    // four bands: top/bottom rows, left/right cols — sample several evenly spaced points
    function linspace(a,b,n){
      const out=[]; const span=(b-a)/(n-1);
      for(let i=0;i<n;i++) out.push(Math.round(a+i*span));
      return out;
    }
    const nPts = 10; // enough variation
    const gxTop = linspace(un.x0+3, un.x1-3, nPts);
    const gxBot = linspace(un.x0+3, un.x1-3, nPts);
    const gyL   = linspace(un.y0+3, un.y1-3, nPts);
    const gyR   = linspace(un.y0+3, un.y1-3, nPts);

    const cand = [];
    gxTop.forEach(gx=> cand.push({ x: gx*t, y: sidewalkTopY*t, facing:'down' , band:'top',  key:`T${gx}` }));
    gxBot.forEach(gx=> cand.push({ x: gx*t, y: sidewalkBotY*t, facing:'up'   , band:'bot',  key:`B${gx}` }));
    gyL.forEach(gy => cand.push({ x: leftX*t,  y: gy*t,        facing:'right', band:'left', key:`L${gy}` }));
    gyR.forEach(gy => cand.push({ x: rightX*t, y: gy*t,        facing:'left' , band:'right',key:`R${gy}` }));
    return { cand, un };
  }

  // Pick two far-apart candidates deterministically by (matchId, round, sorted usernames)
  function computeRoundSpawns(api, matchId, roundNum, usernames){
    const sorted = [...usernames].map(norm).sort(); // [A,B]
    const seedBase = `${matchId}|r${roundNum}|${sorted[0]}|${sorted[1]}`;

    const {cand, un} = buildSpawnCandidates(api);

    // pick first index anywhere
    const idx1 = Math.floor(hash01(seedBase+'|p1') * cand.length);
    const s1 = cand[idx1];

    // pick second index that maximizes Manhattan distance in grid space (greedy deterministic)
    let best = s1, bestD=-1, bestIdx=idx1;
    for(let i=0;i<cand.length;i++){
      const s2=cand[i];
      const d = Math.abs((s2.x - s1.x)) + Math.abs((s2.y - s1.y));
      if(d>bestD){ bestD=d; best=s2; bestIdx=i; }
    }

    // assign deterministic owner: A gets the lexicographically "earlier" seed slot
    // to avoid symmetry issues, flip order based on parity of hash
    const flip = (hash32(seedBase+'|flip') & 1) === 1;
    const aGets = flip ? best : s1;
    const bGets = flip ? s1   : best;

    return {
      A: aGets,
      B: bGets
    };
  }

  // ---------- inv / equipped ----------
  function readInv(){
    try{
      if(IZZA?.api?.getInventory) return IZZA.api.getInventory() || {};
      const raw=localStorage.getItem('izzaInventory'); return raw? JSON.parse(raw) : {};
    }catch{ return {}; }
  }
  function equippedKind(){
    const inv=readInv();
    if(inv?.uzi?.equipped) return 'uzi';
    if(inv?.pistol?.equipped) return 'pistol';
    if(inv?.grenade?.equipped) return 'grenade';
    if(inv?.bat?.equipped) return 'bat';
    if(inv?.knuckles?.equipped) return 'knuckles';
    return 'hand';
  }

  // ---------- hearts HUD bridge ----------
  function maxHearts(){ return Math.max(1, parseInt(localStorage.getItem('izzaMaxHearts') || '3', 10)); }
  function saveSegmentsFromHP(hpFloat){
    const seg = Math.max(0, Math.min(maxHearts()*3, Math.round((hpFloat||0)*3)));
    try{ localStorage.setItem('izzaCurHeartSegments', String(seg)); }catch{}
  }
  const HEART_PATH = 'M12 21c-.5-.5-4.9-3.7-7.2-6C3 13.2 2 11.6 2 9.7 2 7.2 4 5 6.6 5c1.6 0 3 .8 3.8 2.1C11.2 5.8 12.6 5 14.2 5 16.8 5 19 7.2 19 9.7c0 1.9-1 3.5-2.8 5.3-2.3 2.3-6.7 5.5-7.2 6Z';
  function drawHeartsDOM(heartsFloat){
    const hud = document.getElementById('heartsHud'); if(!hud) return;
    const mh = maxHearts();
    const seg = Math.max(0, Math.min(mh*3, Math.round(heartsFloat*3)));
    hud.innerHTML='';
    for(let i=0;i<mh;i++){
      const segForHeart = Math.max(0, Math.min(3, seg - i*3));
      const ratio = segForHeart / 3;
      const svgNS='http://www.w3.org/2000/svg';
      const wrap=document.createElement('div'); wrap.style.width='24px'; wrap.style.height='22px';
      const svg=document.createElementNS(svgNS,'svg'); svg.setAttribute('viewBox','0 0 24 22'); svg.setAttribute('width','24'); svg.setAttribute('height','22');
      const base=document.createElementNS(svgNS,'path'); base.setAttribute('d',HEART_PATH); base.setAttribute('fill','#3a3f4a');
      const clip=document.createElementNS(svgNS,'clipPath'); const clipId='hclip_'+Math.random().toString(36).slice(2); clip.setAttribute('id',clipId);
      const rect=document.createElementNS(svgNS,'rect'); rect.setAttribute('x','0'); rect.setAttribute('y','0'); rect.setAttribute('width', String(24*Math.max(0,Math.min(1,ratio)))); rect.setAttribute('height','22');
      clip.appendChild(rect);
      const red=document.createElementNS(svgNS,'path'); red.setAttribute('d',HEART_PATH); red.setAttribute('fill','#ff5555'); red.setAttribute('clip-path',`url(#${clipId})`);
      svg.appendChild(base); svg.appendChild(clip); svg.appendChild(red); wrap.appendChild(svg); hud.appendChild(wrap);
    }
  }

  // ---------- minimap opp dot ----------
  function unlockedRectForMini(){ return unlockedRect(localStorage.getItem('izzaMapTier') || '2'); }
  function updateMinimapDot(oppX, oppY){
    const mini = document.getElementById('minimap'); if(!mini) return;
    const ctx = mini.getContext('2d'); if(!ctx) return;
    const un = unlockedRectForMini();
    const W=90,H=60; const sx = mini.width / W, sy = mini.height / H;
    const gx = Math.floor(oppX / IZZA.api.TILE), gy = Math.floor(oppY / IZZA.api.TILE);
    const clamp=(v,a,b)=> Math.max(a, Math.min(b, v));
    const nx = clamp((gx - un.x0) / Math.max(1,(un.x1-un.x0)), 0, 1);
    const ny = clamp((gy - un.y0) / Math.max(1,(un.y1-un.y0)), 0, 1);
    ctx.fillStyle = '#ff4d4d';
    ctx.fillRect((un.x0+nx*(un.x1-un.x0))*sx-1, (un.y0+ny*(un.y1-un.y0))*sy-1, 2, 2);
  }

  // ---------- canvas banners ----------
  function showBanner(text, kind='win'){
    const cvs=document.getElementById('game'); if(!cvs) return;
    let host=document.getElementById('duelBanner');
    if(!host){
      host=document.createElement('div'); host.id='duelBanner';
      Object.assign(host.style,{
        position:'absolute', zIndex:31, left:'0', top:'0', width:'0', height:'0',
        pointerEvents:'none'
      });
      cvs.parentElement.appendChild(host);
    }
    const rect=cvs.getBoundingClientRect();
    const card=document.createElement('div');
    const bg = kind==='win' ? 'linear-gradient(135deg,#1b2a50,#254a7a)'
             : kind==='lose'? 'linear-gradient(135deg,#3b1c1c,#5a2e2e)'
             : 'linear-gradient(135deg,#1e2c2b,#335c57)';
    const border = kind==='win' ? '#64b5ff' : kind==='lose' ? '#ff7a7a' : '#9fe3c8';
    Object.assign(card.style,{
      position:'fixed',
      left:(rect.left + rect.width/2 - 170)+'px',
      top:(rect.top + rect.height/2 - 52)+'px',
      width:'340px',
      padding:'16px 20px',
      background:bg,
      border:'2px solid '+border,
      borderRadius:'14px',
      color:'#e7f2ff',
      fontWeight:'800',
      fontFamily:'system-ui,Arial,sans-serif',
      fontSize:'26px',
      textAlign:'center',
      textShadow:'0 2px 8px rgba(0,0,0,.35)',
      boxShadow:'0 12px 30px rgba(0,0,0,.35), inset 0 0 24px rgba(255,255,255,.05)',
      transform:'scale(.9)',
      opacity:'0',
      transition:'transform 200ms ease, opacity 200ms ease'
    });
    card.textContent=text;
    host.appendChild(card);
    requestAnimationFrame(()=>{ card.style.transform='scale(1)'; card.style.opacity='1'; });
    setTimeout(()=>{ card.style.transform='scale(.96)'; card.style.opacity='0'; setTimeout(()=>card.remove(),260); }, 1600);
  }

  // ---------- duel state ----------
  let DUEL = {
    mid:null, mode:'v1',
    meName:'', oppName:'',
    oppSprite:null, opp:{x:0,y:0,facing:'down'},
    pollMs:125, timer:null, flip:false,
    myHP:null,
    oppCops:[],
    lastRoundNum:1,
    myScore:0, oppScore:0,
    usernames:['',''],   // [A,B] sorted
    meIsA:false,         // mapping
    effects:[]
  };

  // ---------- polling ----------
  function startPolling(){ stopPolling(); DUEL.timer = setInterval(()=>{ if(DUEL.flip) poke(); else pull(); DUEL.flip=!DUEL.flip; }, DUEL.pollMs); }
  function stopPolling(){ if(DUEL.timer){ clearInterval(DUEL.timer); DUEL.timer=null; } }

  function copyMyCops(){
    try{
      const cops = IZZA.api.cops||[];
      const me=IZZA.api.player;
      const list = [...cops].sort((a,b)=> (Math.hypot(a.x-me.x,a.y-me.y) - Math.hypot(b.x-me.x,b.y-me.y))).slice(0,5)
        .map(c=>({ x:Math.round(c.x), y:Math.round(c.y), kind:c.kind||'police', facing:c.facing||'down' }));
      return list;
    }catch{ return []; }
  }

  async function poke(){
    const api=IZZA.api; if(!api?.ready || !DUEL.mid) return;
    const body = {
      matchId: DUEL.mid,
      x: api.player.x, y: api.player.y, facing: api.player.facing || 'down',
      hp: DUEL.myHP==null ? 4 : DUEL.myHP,
      inv: readInv(),
      appearance: (IZZA.api.getAppearance && IZZA.api.getAppearance()),
      cops: copyMyCops()
    };
    await $post('/duel/poke', body);
  }

  async function pull(){
    if(!DUEL.mid) return;
    const j = await $get('/duel/pull?matchId='+encodeURIComponent(DUEL.mid));
    if(!j || !j.ok) return;

    // Opponent state
    if(j.opponent){
      DUEL.oppName = j.opponent.username || DUEL.oppName || 'Opponent';
      DUEL.opp.x = (j.opponent.x|0); DUEL.opp.y=(j.opponent.y|0); DUEL.opp.facing=j.opponent.facing||'down';
      if(!DUEL.oppSprite && IZZA.api.addRemotePlayer){
        DUEL.oppSprite = IZZA.api.addRemotePlayer({ username: DUEL.oppName, appearance: j.opponent.appearance || {} });
      }
      if(DUEL.oppSprite){ DUEL.oppSprite.x=DUEL.opp.x; DUEL.oppSprite.y=DUEL.opp.y; DUEL.oppSprite.facing=DUEL.opp.facing; }
    }

    // My HP → hearts
    if(j.me && typeof j.me.hp === 'number'){
      DUEL.myHP = j.me.hp;
      saveSegmentsFromHP(DUEL.myHP);
      drawHeartsDOM(DUEL.myHP);
    }

    // Cops mirror
    DUEL.oppCops = Array.isArray(j.opponentCops) ? j.opponentCops.slice(0,6) : [];

    // Score
    if(j.score){
      DUEL.myScore = (j.score.me|0);
      DUEL.oppScore= (j.score.opponent|0);
    }

    // Round flow (respawn on every new number)
    if(j.round){
      const rn = j.round.number|0;
      if(rn !== (DUEL.lastRoundNum|0)){
        DUEL.lastRoundNum = rn;

        // full hearts locally
        DUEL.myHP = 4;
        saveSegmentsFromHP(DUEL.myHP);
        drawHeartsDOM(DUEL.myHP);

        // Different spawn each round (including round 1)
        const spAll = computeRoundSpawns(IZZA.api, String(DUEL.mid), rn, DUEL.usernames);
        const mySpot = DUEL.meIsA ? spAll.A : spAll.B;
        const oppSpot= DUEL.meIsA ? spAll.B : spAll.A;

        IZZA.api.player.x = mySpot.x; IZZA.api.player.y = mySpot.y; IZZA.api.player.facing = mySpot.facing || 'down';
        // pre-place opp placeholder too (in case pull is slightly behind)
        DUEL.opp.x = oppSpot.x; DUEL.opp.y = oppSpot.y; DUEL.opp.facing = oppSpot.facing || 'up';

        showBanner(`Round ${rn} — FIGHT!`, 'round');
      }
      if(j.round.justEnded){
        const iWon = j.round.winner === 'me';
        showBanner(iWon ? `You won Round ${j.round.number}` : `You lost Round ${j.round.number}`, iWon?'win':'lose');
      }
      if(j.round.matchOver){
        const iWon = j.round.winner === 'me';
        showBanner(iWon ? 'MATCH WIN!' : 'MATCH LOSS', iWon?'win':'lose');
        setTimeout(() => { bounceToLobby(); cleanupDuel(); }, 1200);
        return;
      }
    }
  }

  function bounceToLobby(){
    try{
      const ds = IZZA.api.doorSpawn;
      if(ds){ IZZA.api.player.x = ds.x; IZZA.api.player.y = ds.y; IZZA.api.player.facing='down'; }
    }catch{}
    try{
      const lobby = document.getElementById('mpLobby');
      if(lobby){ lobby.style.display='flex'; }
    }catch{}
    IZZA.emit?.('mp-end');
  }

  function cleanupDuel(){
    stopPolling();
    DUEL.mid=null; DUEL.oppCops.length=0; DUEL.oppSprite=null; DUEL.effects.length=0;
    window.__IZZA_DUEL = { active:false };
  }

  // ---------- HIT DETECTION + effects ----------
  function aimVector(){
    const nub=document.getElementById('nub');
    if(nub){
      const cs=getComputedStyle(nub);
      const left=parseFloat(nub.style.left||cs.left||'40');
      const top =parseFloat(nub.style.top ||cs.top ||'40');
      const dx=left-40, dy=top-40, m=Math.hypot(dx,dy);
      if(m>3) return {x:dx/m, y:dy/m};
    }
    const f=IZZA.api.player.facing;
    if(f==='left') return {x:-1,y:0};
    if(f==='right')return {x:1,y:0};
    if(f==='up')   return {x:0,y:-1};
    return {x:0,y:1};
  }
  function oppCenter(){ return { x:(DUEL.opp.x|0)+16, y:(DUEL.opp.y|0)+16 }; }
  function meCenter(){ const p=IZZA.api.player; return { x:(p.x|0)+16, y:(p.y|0)+16 }; }

  function hitscan(kind){
    const me = meCenter(), dir=aimVector(), opp=oppCenter();
    const vx=opp.x-me.x, vy=opp.y-me.y;
    const dist = Math.hypot(vx,vy);
    const maxDist = (kind==='grenade'? 220 : 240);

    const along = (vx*dir.x + vy*dir.y);
    if(dist > maxDist || along <= 0){
      return {hit:false, hitPoint:{x:me.x+dir.x*Math.min(maxDist, Math.max(60,along)), y:me.y+dir.y*Math.min(maxDist, Math.max(60,along))}};
    }
    const perp = Math.abs(vx*dir.y - vy*dir.x) / Math.hypot(dir.x,dir.y);
    const radius = (kind==='uzi'||kind==='pistol') ? 18
                 : (kind==='grenade' ? 36 : 24);
    const hit = perp <= radius;
    const hitPoint = hit ? opp : {x:me.x+dir.x*Math.min(dist, maxDist), y:me.y+dir.y*Math.min(dist, maxDist)};
    return {hit, hitPoint};
  }
  function meleeInRange(){
    const m=meCenter(), o=oppCenter();
    return Math.hypot(m.x-o.x, m.y-o.y) <= 24;
  }

  function addTracer(from, to, life=110){
    DUEL.effects.push({ kind:'tracer', x1:from.x, y1:from.y, x2:to.x, y2:to.y, t:0, life });
  }
  function addSpark(at, life=140){
    DUEL.effects.push({ kind:'spark', x:at.x, y:at.y, t:0, life });
  }

  function sendHit(kind){
    if(!DUEL.mid) return;
    $post('/duel/hit', { matchId: DUEL.mid, kind });
  }

  // ---------- controls (fire/melee) ----------
  function installHitHooks(){
    const fire=document.getElementById('btnFire');
    if(fire && !fire.__duelHooked){
      fire.__duelHooked=true;
      let uziTimer=null;
      const down=()=>{
        if(!DUEL.mid) return;
        const k=equippedKind();
        const me=meCenter();

        if(k==='uzi'){
          const r=hitscan('uzi'); addTracer(me, r.hitPoint); if(r.hit){ addSpark(r.hitPoint); sendHit('uzi'); }
          if(!uziTimer) uziTimer=setInterval(()=>{ const r2=hitscan('uzi'); const m2=meCenter(); addTracer(m2, r2.hitPoint); if(r2.hit){ addSpark(r2.hitPoint); sendHit('uzi'); } }, 105);
        }else if(k==='pistol'){
          // Single-shot: if we hit, DO NOT fire the follow-up tracer (prevents pass-through look)
          const r=hitscan('pistol'); addTracer(me, r.hitPoint); if(r.hit){ addSpark(r.hitPoint); sendHit('pistol'); return; }
          setTimeout(()=>{ const r2=hitscan('pistol'); const m2=meCenter(); addTracer(m2, r2.hitPoint); if(r2.hit){ addSpark(r2.hitPoint); sendHit('pistol'); } }, 85);
        }else if(k==='grenade'){
          setTimeout(()=>{ const r=hitscan('grenade'); if(r.hit){ addSpark(r.hitPoint, 220); sendHit('grenade'); } }, 900);
        }else if(k==='bat'){
          if(meleeInRange()){ addSpark(oppCenter()); sendHit('bat'); }
        }else if(k==='knuckles'){
          if(meleeInRange()){ addSpark(oppCenter()); sendHit('knuckles'); }
        }else{
          if(meleeInRange()){ addSpark(oppCenter()); sendHit('hand'); }
        }
      };
      const up=()=>{ if(uziTimer){ clearInterval(uziTimer); uziTimer=null; } };
      fire.addEventListener('pointerdown',down,{passive:true});
      fire.addEventListener('pointerup',  up,  {passive:true});
      fire.addEventListener('touchstart',down,{passive:true});
      fire.addEventListener('touchend',  up,  {passive:true});
      fire.addEventListener('mousedown', down,{passive:true});
      fire.addEventListener('mouseup',   up,  {passive:true});
    }

    const btnA=document.getElementById('btnA');
    if(btnA && !btnA.__duelHooked){
      btnA.__duelHooked = true;
      btnA.addEventListener('click', ()=>{
        if(!DUEL.mid) return;
        const k=equippedKind();
        if(k==='bat'){ if(meleeInRange()){ addSpark(oppCenter()); sendHit('bat'); } }
        else if(k==='knuckles'){ if(meleeInRange()){ addSpark(oppCenter()); sendHit('knuckles'); } }
        else { if(meleeInRange()){ addSpark(oppCenter()); sendHit('hand'); } }
      }, {passive:true});
    }

    window.addEventListener('keydown', (e)=>{
      if((e.key||'').toLowerCase()!=='a') return;
      if(!DUEL.mid) return;
      const k=equippedKind();
      if(k==='bat' && meleeInRange()){ addSpark(oppCenter()); sendHit('bat'); }
      else if(k==='knuckles' && meleeInRange()){ addSpark(oppCenter()); sendHit('knuckles'); }
      else if(k!=='pistol' && k!=='uzi' && k!=='grenade' && meleeInRange()){ addSpark(oppCenter()); sendHit('hand'); }
    }, {capture:true, passive:true});
  }

  // ---------- begin ----------
  function begin(payload, apiArg, myName){
    const {mode, matchId, players} = payload||{};
    if(mode!=='v1' || !Array.isArray(players) || players.length<2) return;
    const api = apiArg || IZZA.api; if(!api?.ready) return;

    try{ IZZA.emit?.('ui-modal-close',{id:'mpLobby'}); }catch{}
    try{ const m=document.getElementById('mpLobby'); if(m) m.style.display='none'; }catch{}

    const nameA = players[0]?.username || '';
    const nameB = players[1]?.username || '';
    const sorted = [nameA,nameB].map(norm).sort(); // [A,B]
    DUEL.usernames = sorted;
    DUEL.meIsA = (norm(myName) === sorted[0]);

    const oppName = (norm(myName)===norm(nameA)) ? (nameB||'Opponent') : (nameA||'Opponent');

    // Round 1 spawn (already different via deterministic two-point selection)
    const spAll = computeRoundSpawns(api, String(matchId), /*round*/1, sorted);
    const mySpot = DUEL.meIsA ? spAll.A : spAll.B;
    const oppSpot= DUEL.meIsA ? spAll.B : spAll.A;

    api.player.x = mySpot.x; api.player.y = mySpot.y; api.player.facing = mySpot.facing || 'down';
    api.setWanted?.(0);
    DUEL.oppName = oppName; DUEL.opp.x = oppSpot.x; DUEL.opp.y = oppSpot.y; DUEL.opp.facing = oppSpot.facing || 'up';

    DUEL.myHP = 4;
    saveSegmentsFromHP(DUEL.myHP);
    drawHeartsDOM(DUEL.myHP);

    DUEL.lastRoundNum = 1;
    DUEL.myScore = DUEL.oppScore = 0;

    window.__IZZA_DUEL = { active:true, mode, matchId };
    DUEL.mid = String(matchId);
    DUEL.meName = myName || api.user?.username || 'me';
    startPolling();
    setTimeout(installHitHooks, 40);
    showCountdown(3);
    showBanner(`1v1 vs ${oppName}`, 'round');
  }

  function showCountdown(n=3){
    let host=document.getElementById('pvpCountdown');
    const cvs=document.getElementById('game');
    if(!host){
      host=document.createElement('div'); host.id='pvpCountdown';
      Object.assign(host.style,{position:'absolute',inset:'0',display:'flex',alignItems:'center',justifyContent:'center',zIndex:30,pointerEvents:'none',fontFamily:'system-ui,Arial,sans-serif'});
      cvs.parentElement.appendChild(host);
    }
    const rect=cvs.getBoundingClientRect();
    const label=document.createElement('div');
    Object.assign(label.style,{position:'fixed',left:(rect.left+rect.width/2-60)+'px',top:(rect.top+rect.height/2-34)+'px',
      background:'rgba(6,10,18,.6)',color:'#cfe0ff',border:'1px solid #2a3550',padding:'12px 18px',borderRadius:'14px',fontSize:'28px',fontWeight:'800',textShadow:'0 2px 6px rgba(0,0,0,.4)'});
    host.innerHTML=''; host.appendChild(label);
    let cur=n; label.textContent='Ready…'; setTimeout(function tick(){ if(cur>0){ label.textContent=String(cur--); setTimeout(tick,800);} else { label.textContent='GO!'; setTimeout(()=>host.remove(),650);} },500);
  }

  // ---------- render: minimap + mirror cops + effects ----------
  IZZA.on?.('render-post', ({dtSec})=>{
    try{
      if(!DUEL.mid) return;
      updateMinimapDot(DUEL.opp.x, DUEL.opp.y);

      // mirror cops (simple capsules)
      if(DUEL.oppCops && DUEL.oppCops.length){
        const api=IZZA.api, cvs=document.getElementById('game'); if(!cvs) return;
        const ctx=cvs.getContext('2d'); const S=api.DRAW, scale=S/api.TILE;
        ctx.save(); ctx.imageSmoothingEnabled=false;
        for(const c of DUEL.oppCops){
          const sx=(c.x - api.camera.x)*scale, sy=(c.y - api.camera.y)*scale;
          ctx.fillStyle = c.kind==='army' ? '#3e8a3e' : c.kind==='swat' ? '#0a0a0a' : '#0a2455';
          ctx.fillRect(sx+S*0.18, sy+S*0.18, S*0.64, S*0.64);
        }
        ctx.restore();
      }

      // effects
      if(DUEL.effects.length){
        const api=IZZA.api, cvs=document.getElementById('game'); if(!cvs) return;
        const ctx=cvs.getContext('2d'); const scale=api.DRAW/api.TILE;
        ctx.save(); ctx.imageSmoothingEnabled=false;
        for(let i=DUEL.effects.length-1;i>=0;i--){
          const e=DUEL.effects[i]; e.t += (dtSec? dtSec*1000 : 16);
          const alpha = 1 - (e.t/e.life);
          if(alpha<=0){ DUEL.effects.splice(i,1); continue; }
          if(e.kind==='tracer'){
            ctx.globalAlpha = Math.max(.18, alpha*.9);
            ctx.strokeStyle = '#e6f1ff';
            ctx.lineWidth = 2;
            const sx1=(e.x1-IZZA.api.camera.x)*scale, sy1=(e.y1-IZZA.api.camera.y)*scale;
            const sx2=(e.x2-IZZA.api.camera.x)*scale, sy2=(e.y2-IZZA.api.camera.y)*scale;
            ctx.beginPath(); ctx.moveTo(sx1,sy1); ctx.lineTo(sx2,sy2); ctx.stroke();
          }else if(e.kind==='spark'){
            ctx.globalAlpha = alpha;
            const sx=(e.x-IZZA.api.camera.x)*scale, sy=(e.y-IZZA.api.camera.y)*scale;
            ctx.fillStyle='#ffd86b';
            ctx.beginPath(); ctx.arc(sx, sy, 6, 0, Math.PI*2); ctx.fill();
          }
        }
        ctx.restore();
      }
    }catch{}
  });

  // ---------- hooks ----------
  function withReadyUser(fn, payload, tries=0){
    const api=IZZA.api, uname=api?.user?.username || window.__MP_LAST_ME?.username;
    if(api?.ready && uname){ fn(payload, api, uname); return; }
    if(tries>40){ fn(payload, api||{}, uname||''); return; }
    setTimeout(()=> withReadyUser(fn, payload, tries+1), 50);
  }

  IZZA.on?.('mp-start', (payload)=> withReadyUser(begin, payload));
  IZZA.on?.('mp-end', ()=> cleanupDuel());
})();
