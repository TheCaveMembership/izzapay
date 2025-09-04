// PvP Duel Client — v3.7
// - Keeps existing features intact.
// - NEW: Tracer POST + render opponent tracers.
// - NEW: Uses round.countdownAt to start countdown exactly once.
// - NEW: Announces opponent weapon; mirrors as before.
// - NOTE: Hearts separation is handled by v4_hearts.js (updated) sending DUEL hearts to /duel/poke.
(function(){
  const BUILD='v3.7-duel-client';
  console.log('[IZZA PLAY]', BUILD);

  const BASE = (window.__MP_BASE__ || '/izza-game/api/mp');
  const TOK  = (window.__IZZA_T__ || '').toString();
  const withTok = (p)=> TOK ? p + (p.includes('?')?'&':'?') + 't=' + encodeURIComponent(TOK) : p;
  const norm = (s)=> (s||'').toString().replace(/^@+/,'').toLowerCase();

  async function $post(p,b){ try{ const r=await fetch(withTok(BASE+p),{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify(b||{})}); return r.ok? r.json():null; }catch{ return null; } }
  async function $get(p){ try{ const r=await fetch(withTok(BASE+p),{credentials:'include'}); return r.ok? r.json():null; }catch{ return null; } }

  // ---- unlocked + sidewalks (match core) ----
  function unlockedRect(tier){ return (tier==='2') ? { x0:10, y0:12, x1:80, y1:50 } : { x0:18, y0:18, x1:72, y1:42 }; }
  function hash01(str,salt){ let h=2166136261>>>0, s=(String(str)+'|'+(salt||'')); for(let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,16777619); } h^=h<<13; h^=h>>>17; h^=h<<5; return ((h>>>0)%100000)/100000; }
  function chooseAxis(seed){ return hash01(seed,'axis') >= 0.5; }
  function sideAssignment(seed, players){ const a = norm(players[0]?.username), b = norm(players[1]?.username); const sorted = [a,b].sort(); const flip = hash01(seed,'flip') >= 0.5; return { leftTop: (flip?sorted[1]:sorted[0]), rightBottom: (flip?sorted[0]:sorted[1]) }; }

  function sidewalkSpawns(api, matchId, roundNum, amLeftTop){
    const tier = localStorage.getItem('izzaMapTier') || '2';
    const un   = unlockedRect(tier);
    const t    = api.TILE;
    const hRoadY = api.hRoadY, vRoadX = api.vRoadX;
    const sidewalkTopY = hRoadY - 1, sidewalkBotY = hRoadY + 1;
    const leftX  = vRoadX - 1, rightX = vRoadX + 1;

    const axisTB = chooseAxis(String(matchId)+'|r'+roundNum);
    function randSpan(a,b, salt){
      const span = Math.max(1, (b-a));
      const r = hash01(String(matchId)+'|r'+roundNum, salt);
      return a + Math.floor(r*span);
    }
    if(axisTB){
      const gxTop = randSpan(un.x0+3, un.x1-3, amLeftTop?'topA':'topB');
      const gxBot = randSpan(un.x0+3, un.x1-3, amLeftTop?'botB':'botA');
      const me  = amLeftTop ? { x: gxTop*t, y: sidewalkTopY*t, facing:'down' } : { x: gxBot*t, y: sidewalkBotY*t, facing:'up' };
      const opp = amLeftTop ? { x: gxBot*t, y: sidewalkBotY*t, facing:'up' }   : { x: gxTop*t, y: sidewalkTopY*t, facing:'down' };
      return { me, opp };
    }else{
      const gyL = randSpan(un.y0+3, un.y1-3, amLeftTop?'leftA':'leftB');
      const gyR = randSpan(un.y0+3, un.y1-3, amLeftTop?'rightB':'rightA');
      const me  = amLeftTop ? { x: leftX*t,  y: gyL*t, facing:'right' } : { x: rightX*t, y: gyR*t, facing:'left' };
      const opp = amLeftTop ? { x: rightX*t, y: gyR*t, facing:'left' }  : { x: leftX*t,  y: gyL*t, facing:'right' };
      return { me, opp };
    }
  }

  // ---- inv / equipped ----
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

  // ---- minimap opp dot ----
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

  // ---- duel state ----
  let DUEL = {
    mid:null, mode:'v1',
    meName:'', oppName:'',
    oppSprite:null, opp:{x:0,y:0,facing:'down',weapon:'hand'},
    pollMs:125, timer:null, flip:false,
    myHP:null,
    oppCops:[],
    countdownScheduled:false
  };

  // ---- polling ----
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
    // myHP is DUEL hearts; v4_hearts will call IZZA.emit('duel-hearts-changed',hp)
    const body = {
      matchId: DUEL.mid,
      x: api.player.x, y: api.player.y, facing: api.player.facing || 'down',
      hp: DUEL.myHP==null ? maxHearts() : DUEL.myHP,
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
      DUEL.opp.x = j.opponent.x|0; DUEL.opp.y=j.opponent.y|0; DUEL.opp.facing=j.opponent.facing||'down';
      DUEL.opp.weapon = j.opponent.weapon || 'hand';
      if(!DUEL.oppSprite && IZZA.api.addRemotePlayer){
        DUEL.oppSprite = IZZA.api.addRemotePlayer({ username: DUEL.oppName, appearance: j.opponent.appearance || {} });
      }
      if(DUEL.oppSprite){ DUEL.oppSprite.x=DUEL.opp.x; DUEL.oppSprite.y=DUEL.opp.y; DUEL.oppSprite.facing=DUEL.opp.facing; IZZA.api.setRemoteHeldWeapon?.(DUEL.oppSprite, DUEL.opp.weapon); }
    }

    if(j.me && typeof j.me.hp === 'number'){
      DUEL.myHP = j.me.hp;
      drawHeartsDOM(DUEL.myHP);
    }

    // schedule countdown once using server-provided timestamp
    if(j.round && !DUEL.countdownScheduled){
      const at = (j.round.countdownAt||0)*1000;
      if(at>0){
        DUEL.countdownScheduled = true;
        const wait = Math.max(0, at - Date.now());
        setTimeout(()=> showCountdown(3), wait);
      }
    }

    // mirror opponent's cops (render in render-post via real sprites handled by hearts plugin update)
    DUEL.oppCops = Array.isArray(j.opponentCops) ? j.opponentCops.slice(0,6) : [];

    // draw opponent tracers delivered since last pull
    if(Array.isArray(j.traces) && j.traces.length){
      for(const e of j.traces) queueTrace(e);
    }

    if(j.round && j.round.ended && j.round.matchOver){
      IZZA.emit?.('toast',{text:(j.round.wins && j.round.wins[DUEL.meUid] ? 'You won the match!' : 'You lost the match.')});
      cleanupDuel();
      IZZA.emit?.('mp-end',{reason:'match_over'});
    }else if(j.round && j.round.newRound){
      // (server no longer sets newRound boolean; clients rely on countdownAt)
    }
  }

  function cleanupDuel(){
    stopPolling();
    DUEL.mid=null; DUEL.oppCops.length=0; DUEL.countdownScheduled=false;
    window.__IZZA_DUEL = { active:false };
  }

  // ---- Hearts HUD bridge ----
  const HEART_PATH = 'M12 21c-.5-.5-4.9-3.7-7.2-6C3 13.2 2 11.6 2 9.7 2 7.2 4 5 6.6 5c1.6 0 3 .8 3.8 2.1C11.2 5.8 12.6 5 14.2 5 16.8 5 19 7.2 19 9.7c0 1.9-1 3.5-2.8 5.3-2.3 2.3-6.7 5.5-7.2 6Z';
  function maxHearts(){ return Math.max(1, parseInt(localStorage.getItem('izzaMaxHearts') || '3', 10)); }
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
      if(i===Math.floor((seg-1)/3) && seg>0 && seg%3===1){
        // last heart blinking hint when low
        wrap.style.animation = 'blinkHeart .6s infinite';
        const st = document.getElementById('duelHeartStyle') || (()=>{ const s=document.createElement('style'); s.id='duelHeartStyle'; s.textContent='@keyframes blinkHeart{0%{opacity:1}50%{opacity:.55}100%{opacity:1}}'; document.head.appendChild(s); return s; })();
      }
    }
  }

  // Keep DUEL.myHP in sync when hearts plugin updates duel hearts
  IZZA.on?.('duel-hearts-changed', (hp)=>{ DUEL.myHP = hp; });

  // ---- HIT DETECTION + TRACERS ---------------------------------------------
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
  function meCenter(){ const p=IZZA.api.player; return { x:(p.x|0)+16, y:(p.y|0)+16 }; }
  function oppCenter(){ return { x:(DUEL.opp.x|0)+16, y:(DUEL.opp.y|0)+16 }; }

  function hitscan(kind){
    const me = meCenter(), dir=aimVector(), opp=oppCenter();
    const vx=opp.x-me.x, vy=opp.y-me.y;
    const dist = Math.hypot(vx,vy);
    const maxDist = (kind==='grenade'? 180 : 200);
    if(dist > maxDist) return false;
    const along = (vx*dir.x + vy*dir.y);
    if(along <= 0) return false;
    const perp = Math.abs(vx*dir.y - vy*dir.x) / Math.hypot(dir.x,dir.y);
    const radius = (kind==='uzi'||kind==='pistol') ? 20 : (kind==='grenade' ? 38 : 26);
    return perp <= radius;
  }

  // tracer buffer + renderer
  const TR = { items:[] };
  function queueTrace(e){
    TR.items.push({ t: performance.now(), kind:e.kind||'pistol', x1:e.x1|0, y1:e.y1|0, x2:e.x2|0, y2:e.y2|0 });
    if(TR.items.length>64) TR.items = TR.items.slice(-64);
  }
  function fireTracer(kind){
    const me=meCenter(), dir=aimVector();
    const L = 200;
    const end = { x: me.x + dir.x*L, y: me.y + dir.y*L };
    // local draw immediately (snappy)
    queueTrace({kind, x1:me.x, y1:me.y, x2:end.x, y2:end.y});
    // notify server so opponent sees it
    if(DUEL.mid) $post('/duel/trace', { matchId: DUEL.mid, kind, x1: me.x, y1: me.y, x2: end.x, y2: end.y });
  }

  function renderTraces(){
    if(!TR.items.length) return;
    const api=IZZA.api, cvs=document.getElementById('game'); if(!cvs) return;
    const ctx=cvs.getContext('2d'); const S=api.DRAW, scale=S/api.TILE;
    const now=performance.now();
    ctx.save();
    ctx.globalCompositeOperation='lighter';
    for(const e of TR.items){
      const age = (now - e.t);
      if(age>260) continue;
      const alpha = Math.max(0, 1 - age/260);
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = 'rgba(255,240,160,0.9)';
      ctx.lineWidth = 2;
      const x1=(e.x1 - api.camera.x)*scale, y1=(e.y1 - api.camera.y)*scale;
      const x2=(e.x2 - api.camera.x)*scale, y2=(e.y2 - api.camera.y)*scale;
      ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke();
      // spark at end
      ctx.fillStyle='rgba(255,200,120,0.9)';
      ctx.beginPath(); ctx.arc(x2,y2, 3, 0, Math.PI*2); ctx.fill();
    }
    ctx.restore();
    // drop fully faded
    TR.items = TR.items.filter(e=> (now-e.t) <= 260);
  }

  function sendHit(kind){
    if(!DUEL.mid) return;
    $post('/duel/hit', { matchId: DUEL.mid, kind });
  }

  function installHitHooks(){
    const fire=document.getElementById('btnFire');
    if(fire && !fire.__duelHooked){
      fire.__duelHooked=true;
      let uziTimer=null;
      const down=()=>{
        if(!DUEL.mid) return;
        const k=equippedKind();
        if(k==='uzi'){
          fireTracer('uzi');
          if(hitscan('uzi')) sendHit('uzi');
          uziTimer=setInterval(()=>{ fireTracer('uzi'); if(hitscan('uzi')) sendHit('uzi'); }, 110);
        }else if(k==='pistol'){
          fireTracer('pistol');
          if(hitscan('pistol')) sendHit('pistol');
          setTimeout(()=>{ if(hitscan('pistol')) sendHit('pistol'); }, 90);
        }else if(k==='grenade'){
          fireTracer('grenade');
          setTimeout(()=>{ if(hitscan('grenade')) sendHit('grenade'); }, 900);
        }else if(k==='bat'){
          if(hitscan('bat')) sendHit('bat');
        }else if(k==='knuckles'){
          if(hitscan('knuckles')) sendHit('knuckles');
        }else{
          if(hitscan('hand')) sendHit('hand');
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

    window.addEventListener('keydown', (e)=>{
      if((e.key||'').toLowerCase()!=='a') return;
      if(!DUEL.mid) return;
      const k=equippedKind();
      if(k==='bat' && hitscan('bat')) sendHit('bat');
      else if(k==='knuckles' && hitscan('knuckles')) sendHit('knuckles');
      else if(k!=='pistol' && k!=='uzi' && k!=='grenade' && hitscan('hand')) sendHit('hand');
    }, {capture:true, passive:true});
  }

  // ---- begin/cleanup ----
  function begin(payload, apiArg, myName){
    const {mode, matchId, players} = payload||{};
    if(mode!=='v1' || !Array.isArray(players) || players.length<2) return;
    const api = apiArg || IZZA.api; if(!api?.ready) return;

    try{ IZZA.emit?.('ui-modal-close',{id:'mpLobby'}); }catch{}
    try{ const m=document.getElementById('mpLobby'); if(m) m.style.display='none'; }catch{}

    const pA=players[0]?.username||'', pB=players[1]?.username||'';
    const myN=norm(myName), nA=norm(pA), nB=norm(pB);
    const oppName = (myN && (myN===nA||myN===nB)) ? ((myN===nA)?pB:pA) : (pB||pA||'Opponent');

    const assign = sideAssignment(String(matchId), [{username:pA},{username:pB}]);
    const amLeftTop = (norm(myName) === assign.leftTop);

    // temporary placeholder spawn; real per-round spawn will occur when countdownAt is received
    const sp = sidewalkSpawns(api, String(matchId), 1, amLeftTop);
    api.player.x = sp.me.x; api.player.y = sp.me.y; api.player.facing = sp.me.facing || 'down';
    api.setWanted?.(0);

    DUEL.oppName = oppName; DUEL.opp.x = sp.opp.x; DUEL.opp.y = sp.opp.y; DUEL.opp.facing = sp.opp.facing || 'up';

    window.__IZZA_DUEL = { active:true, mode, matchId };
    DUEL.mid = String(matchId);
    DUEL.meName = myName || api.user?.username || 'me';

    startPolling();
    setTimeout(installHitHooks, 40);
  }

  function showCountdown(n=3){
    let host=document.getElementById('pvpCountdown');
    if(!host){
      host=document.createElement('div'); host.id='pvpCountdown';
      Object.assign(host.style,{position:'fixed',inset:'0',display:'flex',alignItems:'center',justifyContent:'center',zIndex:30,pointerEvents:'none',fontFamily:'system-ui,Arial,sans-serif'});
      document.body.appendChild(host);
    }
    const label=document.createElement('div');
    Object.assign(label.style,{background:'linear-gradient(180deg,rgba(12,16,28,.85),rgba(10,12,18,.85))',color:'#f7fbff',border:'1px solid #2a3550',padding:'20px 28px',borderRadius:'16px',fontSize:'32px',fontWeight:'900',textShadow:'0 3px 12px rgba(0,0,0,.45)', letterSpacing:'1px'});
    host.innerHTML=''; host.appendChild(label);
    let cur=n; label.textContent='Ready…'; setTimeout(function tick(){ if(cur>0){ label.textContent=String(cur--); setTimeout(tick,800);} else { label.textContent='GO!'; setTimeout(()=>host.remove(),650);} },500);
  }

  // ---- render: minimap + tracer + opp cops capsules (sprites handled elsewhere) ----
  IZZA.on?.('render-post', ()=>{
    try{
      if(DUEL.mid){
        updateMinimapDot(DUEL.opp.x, DUEL.opp.y);
        renderTraces();
      }
    }catch{}
  });

  // ---- hooks ----
  function withReadyUser(fn, payload, tries=0){
    const api=IZZA.api, uname=api?.user?.username || window.__MP_LAST_ME?.username;
    if(api?.ready && uname){ fn(payload, api, uname); return; }
    if(tries>40){ fn(payload, api||{}, uname||''); return; }
    setTimeout(()=> withReadyUser(fn, payload, tries+1), 50);
  }

  IZZA.on?.('mp-start', (payload)=> withReadyUser(begin, payload));
  IZZA.on?.('mp-end', ()=> cleanupDuel());
})();
