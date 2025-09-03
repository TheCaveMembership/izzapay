// PvP Duel — v2.1 (REST sync, safe spawns, real opponent render, PvP damage, robot support, MINIMAP OPP DOT)
// - Draws opponent as a proper sprite in-world
// - Adds a red dot for the opponent on the minimap (updates every frame)
// - Keeps your controls unfrozen by force-closing lobby
// - REST /duel/poke & /duel/pull (~8Hz alternating) — no websockets needed
(function(){
  const BUILD='v2.1-pvp-duel-rest+minimap-opp';
  console.log('[IZZA PLAY]', BUILD);

  const BASE = (window.__MP_BASE__ || '/izza-game/api/mp');
  const TOK  = (window.__IZZA_T__ || '').toString();
  const withTok = (p)=> TOK ? p + (p.includes('?')?'&':'?') + 't=' + encodeURIComponent(TOK) : p;
  const norm = (s)=> (s||'').toString().replace(/^@+/,'').toLowerCase();

  // ----- MAP + SPAWN -----
  function unlockedRect(tier){ return (tier==='2') ? { x0:10, y0:12, x1:80, y1:50 } : { x0:18, y0:18, x1:72, y1:42 }; }
  function chooseAxis(matchId){ return hash01(matchId,'axis') >= 0.5; }
  function sideAssignment(matchId, players){
    const a = norm(players[0]?.username), b = norm(players[1]?.username);
    const sorted = [a,b].sort(); const flip = hash01(matchId,'flip') >= 0.5;
    return { leftTop: (flip?sorted[1]:sorted[0]), rightBottom: (flip?sorted[0]:sorted[1]) };
  }
  function safeLane(un, axisTB){
    const m=3; return axisTB
      ? { xMin:un.x0+m, xMax:un.x1-m, yTop:un.y0+m, yBottom:un.y1-m }
      : { yMin:un.y0+m, yMax:un.y1-m, xLeft:un.x0+m, xRight:un.x1-m };
  }
  function edgeSpawn(api, tier, axisTB, leftOrTop, matchId){
    const un = unlockedRect(tier), lane=safeLane(un,axisTB), t=api.TILE;
    if(axisTB){
      const span=Math.max(1,lane.xMax-lane.xMin), r=hash01(matchId,(leftOrTop?'top':'bottom')+'|off');
      const gx=(lane.xMin + Math.floor(r*span)), gy=leftOrTop?lane.yTop:lane.yBottom;
      return { x:gx*t, y:gy*t, facing:leftOrTop?'down':'up' };
    }else{
      const span=Math.max(1,lane.yMax-lane.yMin), r=hash01(matchId,(leftOrTop?'left':'right')+'|off');
      const gy=(lane.yMin + Math.floor(r*span)), gx=leftOrTop?lane.xLeft:lane.xRight;
      return { x:gx*t, y:gy*t, facing:leftOrTop?'right':'left' };
    }
  }
  function hash01(str,salt){
    let h=2166136261>>>0, s=(String(str)+'|'+(salt||'')); for(let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,16777619); }
    h^=h<<13; h^=h>>>17; h^=h<<5; return ((h>>>0)%100000)/100000;
  }

  // ----- OPP SNAPSHOT -----
  const OPP = { active:false, name:'', x:0, y:0, facing:'down', hp:4.0, inv:{} };

  // ----- RENDER: opponent sprite -----
  function drawOpponent(api){
    if(!OPP.active) return;
    const ctx=document.getElementById('game').getContext('2d');
    const scale = api.DRAW/api.TILE;
    const sx = (OPP.x - api.camera.x) * scale;
    const sy = (OPP.y - api.camera.y) * scale;

    ctx.save(); ctx.imageSmoothingEnabled=false;

    // Body
    ctx.fillStyle='#4ad1ff'; // teal/cyan-ish body for visibility
    ctx.fillRect(sx + api.DRAW*0.15, sy + api.DRAW*0.05, api.DRAW*0.70, api.DRAW*0.82);

    // Weapon hint
    const inv = OPP.inv || {};
    if(inv.uzi?.equipped){ ctx.fillStyle='#9ff'; ctx.fillRect(sx+api.DRAW*0.60, sy+api.DRAW*0.28, api.DRAW*0.22, api.DRAW*0.10); }
    else if(inv.pistol?.equipped){ ctx.fillStyle='#cff'; ctx.fillRect(sx+api.DRAW*0.60, sy+api.DRAW*0.28, api.DRAW*0.18, api.DRAW*0.10); }
    else if(inv.grenade?.equipped){ ctx.fillStyle='#e7f26a'; ctx.beginPath(); ctx.arc(sx+api.DRAW*0.70, sy+api.DRAW*0.34, api.DRAW*0.08, 0, Math.PI*2); ctx.fill(); }

    // Name
    ctx.fillStyle = 'rgba(8,12,20,.85)'; ctx.fillRect(sx + api.DRAW*0.02, sy - api.DRAW*0.28, api.DRAW*0.96, api.DRAW*0.22);
    ctx.fillStyle = '#d9ecff'; ctx.font = (api.DRAW*0.20)+'px monospace'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText(OPP.name||'Opponent', sx + api.DRAW*0.50, sy - api.DRAW*0.17, api.DRAW*0.92);

    // HP bar (4 hearts)
    const w = api.DRAW*0.92, hpPct=Math.max(0,Math.min(1, OPP.hp/4.0));
    ctx.fillStyle='#2b394f'; ctx.fillRect(sx + api.DRAW*0.04, sy - api.DRAW*0.38, w, api.DRAW*0.07);
    ctx.fillStyle='#8cf08a'; ctx.fillRect(sx + api.DRAW*0.04, sy - api.DRAW*0.38, w*hpPct, api.DRAW*0.07);

    ctx.restore();
  }

  // ===== MINIMAP OPPONENT DOT =====
  // We overlay a tiny absolutely-positioned dot inside your existing minimap container.
  // We attempt common ids/classes; if none found, we create a small fixed mini overlay (failsafe).
  const MINI = { host:null, oppDot:null, selfDot:null, lastHostId:'' };

  function findMiniHost(){
    if (MINI.host && document.body.contains(MINI.host)) return MINI.host;
    const candidates = [
      '#miniMap','#minimap','#mapMini','#hudMini','#mini','.minimap','[data-minimap]'
    ];
    for(const sel of candidates){
      const el = document.querySelector(sel);
      if(el){ MINI.host = el; break; }
    }
    if(!MINI.host){
      // failsafe: create a small fixed mini box (top-right)
      const box=document.createElement('div');
      Object.assign(box.style,{
        position:'fixed', right:'10px', top:'10px', width:'110px', height:'80px',
        background:'rgba(10,14,22,.55)', border:'1px solid #2a3550', borderRadius:'8px',
        zIndex:12
      });
      box.setAttribute('data-minimap','1');
      document.body.appendChild(box);
      MINI.host = box;
    }
    MINI.host.style.position = MINI.host.style.position || 'relative';
    return MINI.host;
  }

  function ensureMiniDots(){
    const host = findMiniHost();

    if(!MINI.oppDot){
      const d=document.createElement('div');
      Object.assign(d.style,{
        position:'absolute', width:'6px', height:'6px', borderRadius:'50%',
        background:'#ff4d4d', boxShadow:'0 0 4px rgba(255,70,70,.85)', pointerEvents:'none',
        transform:'translate(-50%,-50%)'
      });
      d.title='Opponent';
      host.appendChild(d); MINI.oppDot=d;
    }
    // We don’t add selfDot unless you need it; your game already draws a blue self marker.
  }

  function updateMiniDots(api){
    if(!OPP.active) return;
    ensureMiniDots();
    const host = MINI.host; if(!host) return;

    const tier = localStorage.getItem('izzaMapTier') || '2';
    const un = unlockedRect(tier);
    const rect = host.getBoundingClientRect();
    const t = api.TILE;

    // map world->grid
    const meGX = Math.floor(api.player.x / t), meGY = Math.floor(api.player.y / t);
    const opGX = Math.floor(OPP.x / t),       opGY = Math.floor(OPP.y / t);

    const clamp=(v,a,b)=> Math.max(a, Math.min(b, v));
    const spanX = (un.x1 - un.x0) || 1;
    const spanY = (un.y1 - un.y0) || 1;

    // normalized [0..1] within unlocked bounds
    const opNX = clamp((opGX - un.x0) / spanX, 0, 1);
    const opNY = clamp((opGY - un.y0) / spanY, 0, 1);

    // place dot; Y grows downward both in tiles and CSS so no flip is needed
    const left = rect.width  * opNX;
    const top  = rect.height * opNY;

    MINI.oppDot.style.left = left + 'px';
    MINI.oppDot.style.top  = top  + 'px';
    MINI.oppDot.style.display = 'block';
  }
  // ===== /MINIMAP OPPONENT DOT =====

  // ----- SYNC (no websockets) -----
  let SYNC = { mid:null, timer:null, flip:false, pollMs:125 };

  async function poke(){
    const api=IZZA.api; if(!api?.ready || !SYNC.mid) return;
    try{
      await fetch(withTok(BASE+'/duel/poke'), {
        method:'POST', credentials:'include',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          matchId: SYNC.mid,
          x: api.player.x, y: api.player.y, facing: api.player.facing||'down',
          hp: api.player.hp||4.0,
          inv: safeInv()
        })
      });
    }catch{}
  }
  async function pull(){
    if(!SYNC.mid) return;
    try{
      const r = await fetch(withTok(BASE+'/duel/pull?matchId='+encodeURIComponent(SYNC.mid)), {credentials:'include'});
      if(!r.ok) return;
      const j = await r.json();
      if(j && j.opponent){
        OPP.active = true;
        OPP.name   = j.opponent.username || OPP.name;
        OPP.x      = j.opponent.x; OPP.y = j.opponent.y;
        OPP.facing = j.opponent.facing || 'down';
        OPP.hp     = (j.opponent.hp!=null? j.opponent.hp : OPP.hp);
        OPP.inv    = j.opponent.inv || {};
      }
    }catch{}
  }
  function startSync(){
    stopSync();
    SYNC.timer = setInterval(()=>{ if(!SYNC.mid) return; if(SYNC.flip) poke(); else pull(); SYNC.flip=!SYNC.flip; }, SYNC.pollMs);
  }
  function stopSync(){ if(SYNC.timer){ clearInterval(SYNC.timer); SYNC.timer=null; } }

  // ----- INVENTORY BRIDGE -----
  function readInv(){
    try{
      if(IZZA?.api?.getInventory) return IZZA.api.getInventory() || {};
      const raw=localStorage.getItem('izzaInventory'); return raw? JSON.parse(raw) : {};
    }catch{ return {}; }
  }
  function safeInv(){
    const inv=readInv();
    return {
      pistol:  { equipped: !!inv?.pistol?.equipped,  ammo: inv?.pistol?.ammo|0 },
      uzi:     { equipped: !!inv?.uzi?.equipped,     ammo: inv?.uzi?.ammo|0 },
      grenade: { equipped: !!inv?.grenade?.equipped, count: inv?.grenade?.count|0 },
      bat:     { equipped: !!inv?.bat?.equipped },
      knucks:  { equipped: !!inv?.knucks?.equipped }
    };
  }
  function equippedKind(){
    const inv=readInv();
    if(inv?.uzi?.equipped) return 'uzi';
    if(inv?.pistol?.equipped) return 'pistol';
    if(inv?.grenade?.equipped) return 'grenade';
    if(inv?.bat?.equipped) return 'bat';
    if(inv?.knucks?.equipped) return 'knucks';
    return 'hand';
  }

  // ----- DAMAGE HOOKS -----
  let uziHitTimer=null;
  async function applyHit(kind){
    if(!SYNC.mid) return;
    try{
      await fetch(withTok(BASE+'/duel/hit'),{
        method:'POST', credentials:'include',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ matchId: SYNC.mid, kind })
      });
    }catch{}
  }
  function hookFire(){
    const fire = document.getElementById('btnFire');
    if(!fire) return;
    if(fire.__duelHooked) return; fire.__duelHooked = true;

    const onDown = ()=>{
      if(!window.__IZZA_DUEL?.active) return;
      const k = equippedKind();
      if(k==='uzi'){
        if(uziHitTimer) return;
        applyHit('uzi');
        uziHitTimer = setInterval(()=> applyHit('uzi'), 120);
      }else if(k==='grenade'){
        setTimeout(()=> applyHit('grenade'), 900); // match fuse
      }else if(k==='bat'){ applyHit('bat'); }
      else if(k==='knucks'){ applyHit('knucks'); }
      else if(k==='pistol'){ applyHit('pistol'); }
      else { applyHit('hand'); }
    };
    const onUp = ()=>{ if(uziHitTimer){ clearInterval(uziHitTimer); uziHitTimer=null; } };

    fire.addEventListener('pointerdown', onDown, {passive:true});
    fire.addEventListener('pointerup',   onUp,   {passive:true});
    fire.addEventListener('touchstart',  onDown, {passive:true});
    fire.addEventListener('touchend',    onUp,   {passive:true});
    fire.addEventListener('mousedown',   onDown, {passive:true});
    fire.addEventListener('mouseup',     onUp,   {passive:true});
  }

  // ----- START SEQUENCE -----
  function withReadyUser(fn, payload, tries=0){
    const api=IZZA.api, uname=api?.user?.username || window.__MP_LAST_ME?.username;
    if(api?.ready && uname){ fn(payload, api, uname); return; }
    if(tries>40){ fn(payload, api||{}, uname||''); return; }
    setTimeout(()=> withReadyUser(fn, payload, tries+1), 50);
  }

  function beginDuel(payload, apiArg, myName){
    try{
      const {mode, matchId, players} = payload||{};
      if(mode!=='v1' || !Array.isArray(players) || players.length<2) return;

      const api = apiArg || IZZA.api; if(!api?.ready) return;

      // close any lobby/shield that could freeze controls
      try{ IZZA.emit?.('ui-modal-close',{id:'mpLobby'}); }catch{}
      try{ const m=document.getElementById('mpLobby'); if(m) m.style.display='none'; }catch{}

      const pA=players[0]?.username||'', pB=players[1]?.username||'';
      const myN=norm(myName), nA=norm(pA), nB=norm(pB);
      const oppName = (myN && (myN===nA||myN===nB)) ? ((myN===nA)?pB:pA) : (pB||pA||'Opponent');

      const tier = localStorage.getItem('izzaMapTier') || '2';
      const axisTB = chooseAxis(String(matchId));
      const assign = sideAssignment(String(matchId), [{username:pA},{username:pB}]);
      const amLeftTop = (norm(myName) === assign.leftTop);

      const mySpawn  = edgeSpawn(api, tier, axisTB, amLeftTop, String(matchId));
      const oppSpawn = edgeSpawn(api, tier, axisTB, !amLeftTop, String(matchId));

      api.player.x = mySpawn.x; api.player.y = mySpawn.y; api.player.facing = mySpawn.facing||'down';
      api.setWanted?.(0);

      OPP.active=true; OPP.name=oppName; OPP.x=oppSpawn.x; OPP.y=oppSpawn.y; OPP.facing=oppSpawn.facing||'up'; OPP.hp=4.0; OPP.inv={};

      window.__IZZA_DUEL={active:true,mode,matchId,axisTB,leftTop:assign.leftTop,rightBottom:assign.rightBottom};

      SYNC.mid = String(matchId);
      startSync();
      setTimeout(hookFire, 50);

      showCountdown(3);
      IZZA.emit?.('toast',{text:`1v1 vs ${OPP.name} — good luck!`});
    }catch(e){ console.warn('[duel] start failed', e); }
  }

  function showCountdown(n=3){
    let host=document.getElementById('pvpCountdown');
    if(!host){
      host=document.createElement('div'); host.id='pvpCountdown';
      Object.assign(host.style,{position:'fixed',inset:'0',display:'flex',alignItems:'center',justifyContent:'center',zIndex:30,pointerEvents:'none',fontFamily:'system-ui,Arial,sans-serif'});
      document.body.appendChild(host);
    }
    const label=document.createElement('div');
    Object.assign(label.style,{background:'rgba(6,10,18,.6)',color:'#cfe0ff',border:'1px solid #2a3550',padding:'16px 22px',borderRadius:'14px',fontSize:'28px',fontWeight:'800',textShadow:'0 2px 6px rgba(0,0,0,.4)'});
    host.innerHTML=''; host.appendChild(label);
    let cur=n; label.textContent='Ready…'; setTimeout(function tick(){ if(cur>0){ label.textContent=String(cur--); setTimeout(tick,800);} else { label.textContent='GO!'; setTimeout(()=>host.remove(),600);} },500);
  }

  // ----- HOOKS -----
  IZZA.on?.('render-post', ()=>{
    try{
      const api=IZZA.api;
      if(api?.ready){
        drawOpponent(api);
        updateMiniDots(api); // <<< keep the red dot in sync every frame
      }
    }catch{}
  });

  IZZA.on?.('mp-start', (payload)=> withReadyUser(beginDuel, payload));
  IZZA.on?.('mp-end', ()=>{ stopSync(); OPP.active=false; if(MINI?.oppDot) MINI.oppDot.style.display='none'; window.__IZZA_DUEL={active:false}; });

  if(window.__MP_START_PENDING){ const p=window.__MP_START_PENDING; delete window.__MP_START_PENDING; withReadyUser(beginDuel, p); }
})();
