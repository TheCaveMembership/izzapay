// PvP Duel Client — v6.1
// - Real opponent sprite via remote_players_api.js (kept)
// - Far-apart spawns (A/B roles), unique per player & per round (kept)
// - Countdown fires once; add 5s preload hold before countdown; block firing until GO
// - Hearts HUD bridge (kept)
// - Hitscan + tracers clamp at impact (no pass-through look) (kept)
// - MIRRORED COPS: draw as real sprites (police/swat/military) instead of capsules
// - Cleanup: remove remote sprite on match end, bounce to lobby (kept, hardened)
(function(){
  const BUILD='v6.1-duel-client';
  console.log('[IZZA PLAY]', BUILD);

  const BASE = (window.__MP_BASE__ || '/izza-game/api/mp');
  const TOK  = (window.__IZZA_T__ || '').toString();
  const withTok = (p)=> TOK ? p + (p.includes('?')?'&':'?') + 't=' + encodeURIComponent(TOK) : p;
  const norm = (s)=> (s||'').toString().replace(/^@+/,'').toLowerCase();

  async function $post(p,b){ try{ const r=await fetch(withTok(BASE+p),{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify(b||{})}); return r.ok? r.json():null; }catch{ return null; } }
  async function $get(p){ try{ const r=await fetch(withTok(BASE+p),{credentials:'include'}); return r.ok? r.json():null; }catch{ return null; } }

  // ---------- RNG helpers ----------
  function hash32(str){ let h=2166136261>>>0; const s=String(str); for(let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,16777619);} h^=h<<13; h^=h>>>17; h^=h<<5; return (h>>>0); }
  function hash01str(str){ return (hash32(String(str)) % 100000) / 100000; }

  // ---------- map helpers (match core) ----------
  function unlockedRect(tier){ return (tier==='2') ? { x0:10, y0:12, x1:80, y1:50 } : { x0:18, y0:18, x1:72, y1:42 }; }

  function buildSpawnCandidates(api){
    const t=api.TILE;
    const tier = localStorage.getItem('izzaMapTier') || '2';
    const un   = unlockedRect(tier);
    const hRoadY = api.hRoadY, vRoadX = api.vRoadX;
    const sidewalkTopY = hRoadY - 1, sidewalkBotY = hRoadY + 1;
    const leftX  = vRoadX - 1, rightX = vRoadX + 1;

    function linspace(a,b,n){ const out=[]; const span=(b-a)/(n-1); for(let i=0;i<n;i++) out.push(Math.round(a+i*span)); return out; }
    const nPts = 10;
    const gxTop = linspace(un.x0+3, un.x1-3, nPts);
    const gxBot = linspace(un.x0+3, un.x1-3, nPts);
    const gyL   = linspace(un.y0+3, un.y1-3, nPts);
    const gyR   = linspace(un.y0+3, un.y1-3, nPts);

    const cand = [];
    gxTop.forEach(gx=> cand.push({ x: gx*t, y: sidewalkTopY*t, facing:'down' , band:'top',    key:`T${gx}` }));
    gxBot.forEach(gx=> cand.push({ x: gx*t, y: sidewalkBotY*t, facing:'up'   , band:'bot',    key:`B${gx}` }));
    gyL.forEach(gy => cand.push({ x: leftX*t,  y: gy*t,        facing:'right', band:'left',   key:`L${gy}` }));
    gyR.forEach(gy => cand.push({ x: rightX*t, y: gy*t,        facing:'left' , band:'right',  key:`R${gy}` }));
    return cand;
  }

  function computeRoundSpawns(api, matchId, roundNum, sortedUsernames){
    const cand = buildSpawnCandidates(api);
    const seed = `${matchId}|r${roundNum}|${sortedUsernames[0]}|${sortedUsernames[1]}`;
    const idx1 = Math.floor(hash01str(seed+'|p1') * cand.length);
    const s1 = cand[idx1];
    // second = farthest manhattan from s1
    let best=s1, bestD=-1;
    for(let i=0;i<cand.length;i++){
      const s2=cand[i];
      const d = Math.abs(s2.x - s1.x) + Math.abs(s2.y - s1.y);
      if(d>bestD){ bestD=d; best=s2; }
    }
    const A = {...s1};
    const B = {...best};
    if(A.band===B.band){
      if(A.band==='top')   B.facing='up';
      if(A.band==='bot')   B.facing='down';
      if(A.band==='left')  B.facing='left';
      if(A.band==='right') B.facing='right';
    }
    return { A, B };
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
      if(i===Math.floor((seg-1)/3) && seg<=3){ wrap.className='heart-blink'; } // low-life blink on the last heart
      const svg=document.createElementNS(svgNS,'svg'); svg.setAttribute('viewBox','0 0 24 22'); svg.setAttribute('width','24'); svg.setAttribute('height','22');
      const base=document.createElementNS(svgNS,'path'); base.setAttribute('d',HEART_PATH); base.setAttribute('fill','#3a3f4a');
      const clip=document.createElementNS(svgNS,'clipPath'); const clipId='hclip_'+Math.random().toString(36).slice(2); clip.setAttribute('id',clipId);
      const rect=document.createElementNS(svgNS,'rect'); rect.setAttribute('x','0'); rect.setAttribute('y','0'); rect.setAttribute('width', String(24*Math.max(0,Math.min(1,ratio)))); rect.setAttribute('height','22');
      clip.appendChild(rect);
      const red=document.createElementNS(svgNS,'path'); red.setAttribute('d',HEART_PATH); red.setAttribute('fill','#ff5555'); red.setAttribute('clip-path',`url(#${clipId})`);
      svg.appendChild(base); svg.appendChild(clip); svg.appendChild(red); wrap.appendChild(svg); hud.appendChild(wrap);
    }
    // inject blink CSS once
    if(!document.getElementById('heartBlinkCSS')){
      const st=document.createElement('style'); st.id='heartBlinkCSS';
      st.textContent=`@keyframes heartBlink{0%,100%{filter:drop-shadow(0 0 0 rgba(255,90,90,.0))}50%{filter:drop-shadow(0 0 10px rgba(255,90,90,.9))}}
      #heartsHud .heart-blink{animation:heartBlink .6s infinite}`;
      document.head.appendChild(st);
    }
  }

  // ---------- minimap opp dot ----------
  function updateMinimapDot(oppX, oppY){
    const mini = document.getElementById('minimap'); if(!mini) return;
    const ctx = mini.getContext('2d'); if(!ctx) return;
    const tier = localStorage.getItem('izzaMapTier') || '2';
    const un = unlockedRect(tier);
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
    let host=document.getElementById('duelBannerHost');
    if(!host){
      host=document.createElement('div'); host.id='duelBannerHost';
      Object.assign(host.style,{position:'absolute',inset:'0',display:'block',zIndex:31,pointerEvents:'none'});
      cvs.parentElement.style.position = cvs.parentElement.style.position || 'relative';
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

  // ---------- NPC sheet loading for mirrored cops ----------
  const NPC_SRC = {
    police:   '/static/game/sprites/izza_police_sheet.png',
    swat:     '/static/game/sprites/izza_swat_sheet.png',
    military: '/static/game/sprites/izza_military_sheet.png'
  };
  const NPC_SHEETS = {}; // kind -> {img, cols}
  function loadImg(src){ return new Promise((res,rej)=>{ const i=new Image(); i.onload=()=>res(i); i.onerror=()=>rej(new Error('load:'+src)); i.src=src; }); }
  async function ensureNpc(kind){
    if(NPC_SHEETS[kind]) return NPC_SHEETS[kind];
    const img = await loadImg(NPC_SRC[kind]).catch(()=>null);
    if(img){ NPC_SHEETS[kind] = { img, cols: Math.max(1, Math.floor(img.width/32)) }; }
    return NPC_SHEETS[kind] || null;
  }
  const DIR_INDEX = { down:0, left:2, right:1, up:3 };
  function drawSprite(ctx, pack, facing, dx,dy, S){
    if(!pack||!pack.img) return;
    const row = DIR_INDEX[facing]||0;
    const FRAME_W=32, FRAME_H=32;
    ctx.imageSmoothingEnabled=false;
    // idle frame = column 0
    ctx.drawImage(pack.img, 0, row*FRAME_H, FRAME_W, FRAME_H, dx,dy, S,S);
  }

  // ---------- duel state ----------
  let DUEL = {
    mid:null, mode:'v1',
    meName:'', oppName:'',
    oppSprite:null, opp:{x:0,y:0,facing:'down'},
    pollMs:125, timer:null, flip:false,
    myHP:null,
    oppCops:[],
    lastRoundNum:0,
    usernames:['',''],
    meIsA:false,
    effects:[],
    started:false,
    hooksInstalled:false,
    canFire:false // blocked until GO
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

    if(j.opponent){
      DUEL.oppName = j.opponent.username || DUEL.oppName || 'Opponent';
      DUEL.opp.x = (j.opponent.x|0); DUEL.opp.y=(j.opponent.y|0); DUEL.opp.facing=j.opponent.facing||'down';
      if(!DUEL.oppSprite && IZZA.api.addRemotePlayer){
        DUEL.oppSprite = IZZA.api.addRemotePlayer({ username: DUEL.oppName, appearance: j.opponent.appearance || {} });
      }
      if(DUEL.oppSprite){ DUEL.oppSprite.x=DUEL.opp.x; DUEL.oppSprite.y=DUEL.opp.y; DUEL.oppSprite.facing=DUEL.opp.facing; }
    }

    if(j.me && typeof j.me.hp === 'number'){
      DUEL.myHP = j.me.hp;
      saveSegmentsFromHP(DUEL.myHP);
      drawHeartsDOM(DUEL.myHP);
    }

    DUEL.oppCops = Array.isArray(j.opponentCops) ? j.opponentCops.slice(0,6) : [];

    if(j.round){
      const rn = j.round.number|0;
      if(rn !== (DUEL.lastRoundNum|0)){
        DUEL.lastRoundNum = rn;
        DUEL.myHP = 4;
        saveSegmentsFromHP(DUEL.myHP);
        drawHeartsDOM(DUEL.myHP);
        const spAll = computeRoundSpawns(IZZA.api, String(DUEL.mid), rn, DUEL.usernames);
        const mySpot = DUEL.meIsA ? spAll.A : spAll.B;
        const oppSpot= DUEL.meIsA ? spAll.B : spAll.A;
        IZZA.api.player.x = mySpot.x; IZZA.api.player.y = mySpot.y; IZZA.api.player.facing = mySpot.facing || 'down';
        DUEL.opp.x = oppSpot.x; DUEL.opp.y = oppSpot.y; DUEL.opp.facing = oppSpot.facing || 'up';
        showBanner(`Round ${rn} — FIGHT!`, 'round');
        // re-arm firing only after the GO banner of this round (handled by countdown in begin)
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
    // remove remote sprite if the engine exposes remover
    try{
      if(DUEL.oppSprite && IZZA.api.removeRemotePlayer){ IZZA.api.removeRemotePlayer(DUEL.oppSprite); }
    }catch{}
    DUEL.mid=null; DUEL.oppCops.length=0; DUEL.oppSprite=null; DUEL.effects.length=0;
    DUEL.started=false; DUEL.hooksInstalled=false; DUEL.lastRoundNum=0; DUEL.canFire=false;
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
      const missLen = Math.min(Math.max(along, 60), maxDist);
      return {hit:false, hitPoint:{x:me.x+dir.x*missLen, y:me.y+dir.y*missLen}};
    }
    const perp = Math.abs(vx*dir.y - vy*dir.x) / Math.hypot(dir.x,dir.y);
    const radius = (kind==='uzi'||kind==='pistol') ? 18
                 : (kind==='grenade' ? 36 : 24);
    const hit = perp <= radius;
    const impact = hit ? { x: opp.x - dir.x*2, y: opp.y - dir.y*2 }
                       : { x: me.x + dir.x*Math.min(dist, maxDist), y: me.y + dir.y*Math.min(dist, maxDist) };
    return {hit, hitPoint: impact};
  }

  function addTracer(from, to, life=110){
    DUEL.effects.push({ kind:'tracer', x1:from.x, y1:from.y, x2:to.x, y2:to.y, t:0, life });
  }
  function addSpark(at, life=140){
    DUEL.effects.push({ kind:'spark', x:at.x, y:at.y, t:0, life });
  }

  function sendHit(kind){
    if(!DUEL.mid || !DUEL.canFire) return;
    $post('/duel/hit', { matchId: DUEL.mid, kind });
  }

  // ---------- controls (fire/melee) ----------
  function installHitHooks(){
    if(DUEL.hooksInstalled) return;
    DUEL.hooksInstalled = true;

    const fire=document.getElementById('btnFire');
    if(fire && !fire.__duelHooked){
      fire.__duelHooked=true;
      let uziTimer=null;
      const down=()=>{
        if(!DUEL.mid || !DUEL.canFire) return;
        const k=equippedKind();
        const me=meCenter();

        if(k==='uzi'){
          const r=hitscan('uzi'); addTracer(me, r.hitPoint); if(r.hit){ addSpark(r.hitPoint); sendHit('uzi'); }
          if(!uziTimer) uziTimer=setInterval(()=>{ if(!DUEL.canFire) return; const r2=hitscan('uzi'); const m2=meCenter(); addTracer(m2, r2.hitPoint); if(r2.hit){ addSpark(r2.hitPoint); sendHit('uzi'); } }, 105);
        }else if(k==='pistol'){
          const r=hitscan('pistol'); addTracer(me, r.hitPoint); if(r.hit){ addSpark(r.hitPoint); sendHit('pistol'); }
        }else if(k==='grenade'){
          setTimeout(()=>{ if(!DUEL.canFire) return; const r=hitscan('grenade'); if(r.hit){ addSpark(r.hitPoint, 220); sendHit('grenade'); } }, 900);
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
        if(!DUEL.mid || !DUEL.canFire) return;
        const k=equippedKind();
        if(k==='bat'){ if(meleeInRange()){ addSpark(oppCenter()); sendHit('bat'); } }
        else if(k==='knuckles'){ if(meleeInRange()){ addSpark(oppCenter()); sendHit('knuckles'); } }
        else { if(meleeInRange()){ addSpark(oppCenter()); sendHit('hand'); } }
      }, {passive:true});
    }

    window.addEventListener('keydown', (e)=>{
      if((e.key||'').toLowerCase()!=='a') return;
      if(!DUEL.mid || !DUEL.canFire) return;
      const k=equippedKind();
      if(k==='bat' && meleeInRange()){ addSpark(oppCenter()); sendHit('bat'); }
      else if(k==='knuckles' && meleeInRange()){ addSpark(oppCenter()); sendHit('knuckles'); }
      else if(k!=='pistol' && k!=='uzi' && k!=='grenade' && meleeInRange()){ addSpark(oppCenter()); sendHit('hand'); }
    }, {capture:true, passive:true});
  }

  function meleeInRange(){
    const m=meCenter(), o=oppCenter();
    return Math.hypot(m.x-o.x, m.y-o.y) <= 24;
  }

  // ---------- begin (with 5s preload hold + single start guard) ----------
  async function resolveMeUsername(){
    const j = await $get('/me');
    if(j && j.username) return j.username;
    return (IZZA?.api?.user?.username) || (window.__MP_LAST_ME && window.__MP_LAST_ME.username) || '';
  }

  function onceSceneReady(cb){
    let tries=0;
    (function wait(){
      if(IZZA?.api?.ready){ cb(); return; }
      if(tries++>60){ cb(); return; }
      setTimeout(wait, 50);
    })();
  }

  async function begin(payload){
    if(DUEL.started){ return; }
    const {mode, matchId, players} = payload||{};
    if(mode!=='v1' || !Array.isArray(players) || players.length<2) return;

    try{ IZZA.emit?.('ui-modal-close',{id:'mpLobby'}); }catch{}
    try{ const m=document.getElementById('mpLobby'); if(m) m.style.display='none'; }catch{}

    const meServerName = await resolveMeUsername();
    const pA = players[0]?.username || '';
    const pB = players[1]?.username || '';
    const pAL = norm(pA), pBL = norm(pB), meL = norm(meServerName);

    DUEL.meIsA = (meL && (meL===pAL || meL===pBL)) ? (meL===pAL) : (hash32(TOK||('mid:'+matchId)) & 1)!==0;
    const sorted = [pA,pB].map(norm).sort();
    DUEL.usernames = sorted;
    const oppName = (meL===pAL) ? (pB||'Opponent') : (pA||'Opponent');
    DUEL.oppName = oppName;

    const spAll = computeRoundSpawns(IZZA.api, String(matchId), 1, sorted);
    const mySpot = DUEL.meIsA ? spAll.A : spAll.B;
    const oppSpot= DUEL.meIsA ? spAll.B : spAll.A;

    onceSceneReady(()=>{
      IZZA.api.player.x = mySpot.x; IZZA.api.player.y = mySpot.y; IZZA.api.player.facing = mySpot.facing || 'down';
      IZZA.api.setWanted?.(0);
      DUEL.opp.x = oppSpot.x; DUEL.opp.y = oppSpot.y; DUEL.opp.facing = oppSpot.facing || 'up';

      DUEL.myHP = 4; saveSegmentsFromHP(DUEL.myHP); drawHeartsDOM(DUEL.myHP);

      DUEL.mid = String(matchId); DUEL.mode = mode; DUEL.started = true; DUEL.lastRoundNum = 1;
      DUEL.canFire = false; // block until GO
      window.__IZZA_DUEL = { active:true, mode, matchId };
      startPolling();
      setTimeout(installHitHooks, 60);

      // 5s preload hold, THEN countdown, THEN unlock fire at GO
      const cvs=document.getElementById('game');
      if(cvs){
        let hold=document.getElementById('duelHold');
        if(!hold){
          hold=document.createElement('div'); hold.id='duelHold';
          Object.assign(hold.style,{position:'absolute',inset:'0',display:'flex',alignItems:'center',justifyContent:'center',zIndex:30,pointerEvents:'none'});
          cvs.parentElement.style.position = cvs.parentElement.style.position || 'relative';
          cvs.parentElement.appendChild(hold);
        }
        hold.innerHTML='<div style="background:rgba(6,10,18,.65);border:1px solid #2a3550;border-radius:14px;color:#cfe0ff;font-weight:800;font-family:system-ui,Arial,sans-serif;padding:12px 18px">Preparing match…</div>';
        setTimeout(()=>{ hold.remove(); showCountdown(3, ()=>{ DUEL.canFire = true; showBanner(`1v1 vs ${oppName}`, 'round'); }); }, 5000);
      }else{
        // fallback if canvas not found
        setTimeout(()=> showCountdown(3, ()=>{ DUEL.canFire = true; showBanner(`1v1 vs ${oppName}`, 'round'); }), 5000);
      }
    });
  }

  function showCountdown(n=3, onGo){
    const cvs=document.getElementById('game'); if(!cvs) return;
    let host=document.getElementById('pvpCountdown');
    if(!host){
      host=document.createElement('div'); host.id='pvpCountdown';
      Object.assign(host.style,{position:'absolute',inset:'0',display:'flex',alignItems:'center',justifyContent:'center',zIndex:30,pointerEvents:'none',fontFamily:'system-ui,Arial,sans-serif'});
      cvs.parentElement.style.position = cvs.parentElement.style.position || 'relative';
      cvs.parentElement.appendChild(host);
    }
    const rect=cvs.getBoundingClientRect();
    const label=document.createElement('div');
    Object.assign(label.style,{position:'fixed',left:(rect.left+rect.width/2-60)+'px',top:(rect.top+rect.height/2-34)+'px',
      background:'rgba(6,10,18,.6)',color:'#cfe0ff',border:'1px solid #2a3550',padding:'12px 18px',borderRadius:'14px',fontSize:'28px',fontWeight:'800',textShadow:'0 2px 6px rgba(0,0,0,.4)'});
    host.innerHTML=''; host.appendChild(label);
    let cur=n; label.textContent='Ready…'; setTimeout(function tick(){
      if(cur>0){ label.textContent=String(cur--); setTimeout(tick,800);} else { label.textContent='GO!'; setTimeout(()=>{ host.remove(); onGo&&onGo(); },650);}
    },500);
  }

  // ---------- render: minimap + mirrored cops (as sprites) + effects ----------
  IZZA.on?.('render-post', ({dtSec})=>{
    try{
      if(!DUEL.mid) return;
      updateMinimapDot(DUEL.opp.x, DUEL.opp.y);

      // MIRRORED COPS as sprites
      if(DUEL.oppCops && DUEL.oppCops.length){
        const api=IZZA.api, cvs=document.getElementById('game'); if(!cvs) return;
        const ctx=cvs.getContext('2d'); const S=api.DRAW, scale=S/api.TILE;
        ctx.save(); ctx.imageSmoothingEnabled=false;
        for(const c of DUEL.oppCops){
          const sx=(c.x - api.camera.x)*scale, sy=(c.y - api.camera.y)*scale;
          const kind=(c.kind==='army')?'military':(c.kind||'police');
          const pack = NPC_SHEETS[kind];
          if(pack && pack.img){
            drawSprite(ctx, pack, c.facing||'down', sx, sy, S);
          }else{
            // lazy-load once and draw a colored box for this frame
            ensureNpc(kind);
            ctx.fillStyle = kind==='military' ? '#3e8a3e' : kind==='swat' ? '#0a0a0a' : '#0a2455';
            ctx.fillRect(sx+S*0.18, sy+S*0.18, S*0.64, S*0.64);
          }
        }
        ctx.restore();
      }

      // effects (tracers/sparks)
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
  IZZA.on?.('mp-start', (payload)=> { if(!DUEL.started) begin(payload); });
  IZZA.on?.('mp-end',   ()=> cleanupDuel());
})();
