// PvP Duel Client — v4.2
// - Round banners (centered, animated), match banners
// - Per-round different safe spawns
// - Tracer + impact spark + tiny flinch when a shot connects
// - Real opponent sprites via remote_players_api.js
// - Red minimap dot
// - Hearts HUD bridge (syncs with v4_hearts.js)
// - Mirror cops (visual only)
// - Best-of-3 flow, return to lobby on match end
(function(){
  const BUILD='v4.2-duel-client';
  console.log('[IZZA PLAY]', BUILD);

  // -------- net helpers
  const BASE = (window.__MP_BASE__ || '/izza-game/api/mp');
  const TOK  = (window.__IZZA_T__ || '').toString();
  const withTok = (p)=> TOK ? p + (p.includes('?')?'&':'?') + 't=' + encodeURIComponent(TOK) : p;
  async function $post(p,b){ try{ const r=await fetch(withTok(BASE+p),{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify(b||{})}); return r.ok? r.json():null; }catch{ return null; } }
  async function $get(p){ try{ const r=await fetch(withTok(BASE+p),{credentials:'include'}); return r.ok? r.json():null; }catch{ return null; } }

  // -------- small utils
  const norm=(s)=> (s||'').toString().replace(/^@+/,'').toLowerCase();
  const hash01=(str,salt)=>{ let h=2166136261>>>0, s=(String(str)+'|'+(salt||'')); for(let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,16777619);} h^=h<<13; h^=h>>>17; h^=h<<5; return ((h>>>0)%100000)/100000; };
  const unlockedRect=(tier)=> (tier==='2') ? { x0:10, y0:12, x1:80, y1:50 } : { x0:18, y0:18, x1:72, y1:42 };

  // -------- round banners (center of canvas)
  function roundBanner(txt, theme='info', sec=1.8){
    const cvs=document.getElementById('game'); if(!cvs) return;
    let el=document.getElementById('roundBanner');
    if(!el){
      el=document.createElement('div'); el.id='roundBanner';
      Object.assign(el.style,{
        position:'fixed', zIndex:50, inset:'0', display:'flex', alignItems:'center', justifyContent:'center',
        pointerEvents:'none'
      });
      document.body.appendChild(el);
    }
    const card=document.createElement('div');
    const color = theme==='win' ? '#48e27b' : theme==='lose' ? '#ff6b6b' : theme==='final' ? '#ffd23f' : '#7fb2ff';
    Object.assign(card.style,{
      padding:'14px 18px', border:'1px solid #2a3550', borderRadius:'14px',
      background:'linear-gradient(180deg, rgba(6,10,18,.96), rgba(6,10,18,.85))',
      color:'#cfe0ff', fontFamily:'system-ui,Arial,sans-serif', fontSize:'22px', fontWeight:'900',
      textShadow:'0 2px 8px rgba(0,0,0,.5)', boxShadow:'0 8px 28px rgba(0,0,0,.5)',
      transform:'scale(.92)', opacity:'0',
      outline:`2px solid ${color}`, outlineOffset:'3px'
    });
    card.textContent=txt;
    el.innerHTML=''; el.appendChild(card);
    // entrance
    requestAnimationFrame(()=>{
      card.style.transition='transform .18s ease-out, opacity .18s ease-out';
      card.style.transform='scale(1)';
      card.style.opacity='1';
    });
    // exit
    setTimeout(()=>{
      card.style.transition='transform .22s ease-in, opacity .22s ease-in';
      card.style.transform='scale(.94)';
      card.style.opacity='0';
      setTimeout(()=>{ if(el) el.innerHTML=''; }, 240);
    }, sec*1000);
  }

  // -------- spawn logic (varied per round)
  function chooseAxis(seed){ return hash01(seed,'axis') >= 0.5; }
  function sideAssignment(seed, players){
    const a = norm(players[0]?.username), b = norm(players[1]?.username);
    const sorted=[a,b].sort(); const flip = hash01(seed,'flip') >= 0.5;
    return { leftTop: (flip?sorted[1]:sorted[0]), rightBottom: (flip?sorted[0]:sorted[1]) };
  }
  // picks different lanes each round by salting with round number
  function sidewalkSpawns(api, matchId, roundNum, amLeftTop){
    const tier = localStorage.getItem('izzaMapTier') || '2';
    const un   = unlockedRect(tier);
    const t    = api.TILE;
    const hRoadY = api.hRoadY, vRoadX = api.vRoadX;
    const sidewalkTopY = hRoadY - 1, sidewalkBotY = hRoadY + 1;
    const leftX  = vRoadX - 1, rightX = vRoadX + 1;

    const axisTB = chooseAxis(String(matchId));
    function randSpan(a,b, salt){
      const span = Math.max(1, (b-a));
      const r = hash01(String(matchId)+'#r'+roundNum, salt);
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

  // -------- inventory helpers
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

  // -------- hearts bridge
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

  // -------- minimap opp dot
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

  // -------- duel state
  let DUEL = {
    mid:null, mode:'v1',
    meName:'', oppName:'',
    oppSprite:null, opp:{x:0,y:0,facing:'down'},
    pollMs:125, timer:null, flip:false,
    myHP:null,
    lastRoundNum:1, myScore:0, oppScore:0,
    amLeftTop:false,
    // visuals
    tracers:[], impacts:[], flinchT:0,
    // cops mirror
    oppCops:[]
  };

  // -------- tracers & impacts (to avoid “bullets passing through” look)
  function meCenter(){ const p=IZZA.api.player; return { x:(p.x|0)+16, y:(p.y|0)+16 }; }
  function oppCenter(){ return { x:(DUEL.opp.x|0)+16, y:(DUEL.opp.y|0)+16 }; }
  function addTracer(x0,y0,x1,y1){
    DUEL.tracers.push({x0,y0,x1,y1, t:0, life:120}); // ms
    if(DUEL.tracers.length>12) DUEL.tracers.shift();
  }
  function addImpact(x,y){
    DUEL.impacts.push({x,y, t:0, life:180});
    if(DUEL.impacts.length>10) DUEL.impacts.shift();
    DUEL.flinchT = 90; // ms tiny flinch wobble
  }

  // -------- polling
  function startPolling(){ stopPolling(); DUEL.timer = setInterval(()=>{ if(DUEL.flip) poke(); else pull(); DUEL.flip=!DUEL.flip; }, DUEL.pollMs); }
  function stopPolling(){ if(DUEL.timer){ clearInterval(DUEL.timer); DUEL.timer=null; } }

  function copyMyCops(){
    try{
      const cops = IZZA.api.cops||[];
      const me=IZZA.api.player;
      return [...cops].sort((a,b)=> (Math.hypot(a.x-me.x,a.y-me.y) - Math.hypot(b.x-me.x,b.y-me.y))).slice(0,5)
        .map(c=>({ x:Math.round(c.x), y:Math.round(c.y), kind:c.kind||'police', facing:c.facing||'down' }));
    }catch{ return []; }
  }

  async function poke(){
    const api=IZZA.api; if(!api?.ready || !DUEL.mid) return;
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

    // Opponent state
    if(j.opponent){
      DUEL.oppName = j.opponent.username || DUEL.oppName || 'Opponent';
      DUEL.opp.x = (j.opponent.x|0); DUEL.opp.y=(j.opponent.y|0); DUEL.opp.facing=j.opponent.facing||'down';
      if(!DUEL.oppSprite && IZZA.api.addRemotePlayer){
        DUEL.oppSprite = IZZA.api.addRemotePlayer({ username: DUEL.oppName, appearance: j.opponent.appearance || {} });
      }
      if(DUEL.oppSprite){ DUEL.oppSprite.x=DUEL.opp.x; DUEL.oppSprite.y=DUEL.opp.y; DUEL.oppSprite.facing=DUEL.opp.facing; }
    }

    // My HP -> hearts HUD
    if(j.me && typeof j.me.hp === 'number'){
      DUEL.myHP = j.me.hp; saveSegmentsFromHP(DUEL.myHP); drawHeartsDOM(DUEL.myHP);
    }

    // Mirror cops
    DUEL.oppCops = Array.isArray(j.opponentCops) ? j.opponentCops.slice(0,6) : [];

    // Score + round flow
    if(j.score){ DUEL.myScore=(j.score.me|0); DUEL.oppScore=(j.score.opponent|0); }

    if(j.round){
      // round change -> respawn both sides (different lane each round)
      const rn = j.round.number|0;
      if(rn > (DUEL.lastRoundNum|0)){
        DUEL.lastRoundNum = rn;
        const api=IZZA.api;
        const sp = sidewalkSpawns(api, DUEL.mid, rn, DUEL.amLeftTop);
        api.player.x = sp.me.x; api.player.y=sp.me.y; api.player.facing=sp.me.facing;
        // reset my hearts locally (server is source of truth)
        DUEL.myHP = maxHearts(); saveSegmentsFromHP(DUEL.myHP); drawHeartsDOM(DUEL.myHP);
        roundBanner(`Round ${rn}`, rn===3 ? 'final':'info', 1.6);
      }
      // feedback win/lose for the just-finished round
      if(j.round.justEnded && j.round.lastWinner){
        if(j.round.lastWinner==='me') roundBanner(`You WON Round ${j.round.lastNumber||((DUEL.lastRoundNum-1)|0)}`, 'win', 1.8);
        else roundBanner(`You LOST Round ${j.round.lastNumber||((DUEL.lastRoundNum-1)|0)}`, 'lose', 1.8);
      }
      if(j.round.matchOver){
        const won = (j.round.winner==='me');
        roundBanner(won ? 'MATCH OVER — YOU WIN' : 'MATCH OVER — YOU LOSE', won?'win':'lose', 2.2);
        // bounce to MP lobby building w/ lobby open
        setTimeout(()=>{
          const api=IZZA.api;
          if(api?.doorSpawn){ api.player.x=api.doorSpawn.x; api.player.y=api.doorSpawn.y; api.player.facing='down'; }
          try{
            window.__IZZA_DUEL={active:false};
            const lobby=document.getElementById('mpLobby'); if(lobby){ lobby.style.display='flex'; }
            // also tell the rest of UI we’re done
            IZZA.emit?.('mp-end',{});
          }catch{}
          cleanupDuel();
        }, 1200);
        return;
      }
    }
  }

  // -------- hitscan + visuals
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

  function hitscan(kind){
    const me = meCenter(), dir=aimVector(), opp=oppCenter();
    const vx=opp.x-me.x, vy=opp.y-me.y;
    const dist = Math.hypot(vx,vy);
    const maxDist = (kind==='grenade'? 220 : 240);
    if(dist > maxDist) return false;
    const along = (vx*dir.x + vy*dir.y); if(along <= 0) return false;
    const perp = Math.abs(vx*dir.y - vy*dir.x) / Math.hypot(dir.x,dir.y);
    const radius = (kind==='uzi'||kind==='pistol') ? 18 : (kind==='grenade' ? 36 : 24);
    return perp <= radius;
  }

  function sendHit(kind, withEffects=true){
    if(!DUEL.mid) return;
    // visuals (local) so shots never look like they pass through
    if(withEffects){
      const m=meCenter(), o=oppCenter();
      addTracer(m.x,m.y,o.x,o.y);
      if(kind==='pistol' || kind==='uzi' || kind==='grenade'){ addImpact(o.x,o.y); }
    }
    $post('/duel/hit', { matchId: DUEL.mid, kind });
  }

  // hook inputs
  function installHitHooks(){
    const fire=document.getElementById('btnFire');
    if(fire && !fire.__duelHooked){
      fire.__duelHooked=true;
      let uziTimer=null;
      const down=()=>{
        if(!DUEL.mid) return;
        const k=equippedKind();
        if(k==='uzi'){
          if(hitscan('uzi')) sendHit('uzi');
          if(!uziTimer) uziTimer=setInterval(()=>{ if(hitscan('uzi')) sendHit('uzi'); }, 105);
        }else if(k==='pistol'){
          if(hitscan('pistol')) sendHit('pistol');
          setTimeout(()=>{ if(hitscan('pistol')) sendHit('pistol'); }, 85);
        }else if(k==='grenade'){
          setTimeout(()=>{ if(hitscan('grenade')) sendHit('grenade'); }, 900);
        }else if(k==='bat'){
          if(Math.hypot( (meCenter().x-oppCenter().x), (meCenter().y-oppCenter().y) )<=24) sendHit('bat', false);
        }else if(k==='knuckles'){
          if(Math.hypot( (meCenter().x-oppCenter().x), (meCenter().y-oppCenter().y) )<=24) sendHit('knuckles', false);
        }else{
          if(Math.hypot( (meCenter().x-oppCenter().x), (meCenter().y-oppCenter().y) )<=24) sendHit('hand', false);
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
        const inRange = Math.hypot( (meCenter().x-oppCenter().x), (meCenter().y-oppCenter().y) )<=24;
        if(k==='bat' && inRange) sendHit('bat', false);
        else if(k==='knuckles' && inRange) sendHit('knuckles', false);
        else if(inRange) sendHit('hand', false);
      }, {passive:true});
    }
  }

  // -------- begin / cleanup
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
    DUEL.amLeftTop = (norm(myName) === assign.leftTop);

    // Round 1 spawn
    const sp = sidewalkSpawns(api, String(matchId), 1, DUEL.amLeftTop);
    api.player.x = sp.me.x; api.player.y = sp.me.y; api.player.facing = sp.me.facing || 'down';
    api.setWanted?.(0);

    DUEL.oppName = oppName; DUEL.opp.x = sp.opp.x; DUEL.opp.y = sp.opp.y; DUEL.opp.facing = sp.opp.facing || 'up';
    DUEL.myHP = maxHearts(); saveSegmentsFromHP(DUEL.myHP); drawHeartsDOM(DUEL.myHP);

    // go
    DUEL.lastRoundNum = 1; DUEL.myScore = DUEL.oppScore = 0;
    window.__IZZA_DUEL = { active:true, mode, matchId };
    DUEL.mid = String(matchId);
    DUEL.meName = myName || api.user?.username || 'me';
    startPolling(); setTimeout(installHitHooks, 40);
    showCountdown(3);
    roundBanner('Round 1', 'info', 1.6);
  }

  function cleanupDuel(){
    stopPolling();
    DUEL.mid=null; DUEL.oppCops.length=0; DUEL.oppSprite=null;
    DUEL.tracers.length=0; DUEL.impacts.length=0; DUEL.flinchT=0;
    window.__IZZA_DUEL = { active:false };
  }

  function showCountdown(n=3){
    let host=document.getElementById('pvpCountdown');
    if(!host){
      host=document.createElement('div'); host.id='pvpCountdown';
      Object.assign(host.style,{position:'fixed',inset:'0',display:'flex',alignItems:'center',justifyContent:'center',zIndex:40,pointerEvents:'none',fontFamily:'system-ui,Arial,sans-serif'});
      document.body.appendChild(host);
    }
    const label=document.createElement('div');
    Object.assign(label.style,{background:'rgba(6,10,18,.6)',color:'#cfe0ff',border:'1px solid #2a3550',padding:'16px 22px',borderRadius:'14px',fontSize:'28px',fontWeight:'800',textShadow:'0 2px 6px rgba(0,0,0,.4)'});
    host.innerHTML=''; host.appendChild(label);
    let cur=n; label.textContent='Ready…'; setTimeout(function tick(){ if(cur>0){ label.textContent=String(cur--); setTimeout(tick,800);} else { label.textContent='GO!'; setTimeout(()=>host.remove(),650);} },500);
  }

  // -------- render: minimap + cops + tracer/impacts + flinch
  IZZA.on?.('render-post', ({dtSec})=>{
    try{
      if(!DUEL.mid) return;

      updateMinimapDot(DUEL.opp.x, DUEL.opp.y);

      const api=IZZA.api, cvs=document.getElementById('game'); if(!cvs) return;
      const ctx=cvs.getContext('2d'); const S=api.DRAW, scale=S/api.TILE;
      ctx.save(); ctx.imageSmoothingEnabled=false;

      // mirror cops
      if(DUEL.oppCops && DUEL.oppCops.length){
        for(const c of DUEL.oppCops){
          const sx=(c.x - api.camera.x)*scale, sy=(c.y - api.camera.y)*scale;
          ctx.fillStyle = c.kind==='army' ? '#3e8a3e' : c.kind==='swat' ? '#0a0a0a' : '#0a2455';
          ctx.fillRect(sx+S*0.18, sy+S*0.18, S*0.64, S*0.64);
        }
      }

      // tracers
      const nowPerf=performance.now();
      DUEL.tracers = DUEL.tracers.filter(t=> (t.t += (dtSec*1000)) < t.life);
      ctx.globalAlpha=0.75;
      for(const tr of DUEL.tracers){
        const a = 1 - (tr.t/tr.life);
        ctx.globalAlpha = Math.max(0, Math.min(.85, a));
        ctx.beginPath();
        ctx.moveTo((tr.x0 - api.camera.x)*scale, (tr.y0 - api.camera.y)*scale);
        ctx.lineTo((tr.x1 - api.camera.x)*scale, (tr.y1 - api.camera.y)*scale);
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#bfe8ff';
        ctx.stroke();
      }
      ctx.globalAlpha=1;

      // impacts
      DUEL.impacts = DUEL.impacts.filter(i=> (i.t += (dtSec*1000)) < i.life);
      for(const im of DUEL.impacts){
        const a = 1 - (im.t/im.life);
        const rad = 6 + 10*(1-a);
        const sx=(im.x - api.camera.x)*scale, sy=(im.y - api.camera.y)*scale;
        ctx.beginPath(); ctx.arc(sx,sy, rad, 0, Math.PI*2);
        ctx.fillStyle='rgba(255,240,180,0.65)'; ctx.fill();
        ctx.beginPath(); ctx.arc(sx,sy, Math.max(1,rad*0.45), 0, Math.PI*2);
        ctx.fillStyle='rgba(255,110,90,0.75)'; ctx.fill();
      }

      // flinch wobble on opponent sprite ONLY visuallly (no physics)
      if(DUEL.flinchT>0){
        DUEL.flinchT -= dtSec*1000;
        if(DUEL.oppSprite){
          const amt = Math.sin(nowPerf*0.06)*1.4;
          DUEL.oppSprite.__flinchDX = amt;
          DUEL.oppSprite.__flinchDY = -Math.abs(amt)*0.3;
        }
      }else if(DUEL.oppSprite){
        DUEL.oppSprite.__flinchDX = 0; DUEL.oppSprite.__flinchDY = 0;
      }

      ctx.restore();
    }catch{}
  });

  // -------- ready hooks
  function withReadyUser(fn, payload, tries=0){
    const api=IZZA.api, uname=api?.user?.username || window.__MP_LAST_ME?.username;
    if(api?.ready && uname){ fn(payload, api, uname); return; }
    if(tries>40){ fn(payload, api||{}, uname||''); return; }
    setTimeout(()=> withReadyUser(fn, payload, tries+1), 50);
  }
  IZZA.on?.('mp-start', (payload)=> withReadyUser(begin, payload));
  IZZA.on?.('mp-end', ()=> cleanupDuel());
})();
