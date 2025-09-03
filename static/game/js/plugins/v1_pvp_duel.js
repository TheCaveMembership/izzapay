// PvP Duel — v2.3 (REST sync, safe spawns, real opponent render, PvP damage, minimap)
// - Uses /duel/poke + /duel/pull alternating (no websockets)
// - Sends appearance on first poke so the opponent renders correctly
(function(){
  const BUILD='v2.3-pvp-duel-rest+appearance+minimap';
  console.log('[IZZA PLAY]', BUILD);

  const BASE = (window.__MP_BASE__ || '/izza-game/api/mp');
  const TOK  = (window.__IZZA_T__ || '').toString();
  const withTok = (p)=> TOK ? p + (p.includes('?')?'&':'?') + 't=' + encodeURIComponent(TOK) : p;
  const norm = (s)=> (s||'').toString().replace(/^@+/,'').toLowerCase();

  // ----- MAP + SPAWN -----
  function unlockedRect(tier){ return (tier==='2') ? { x0:10, y0:12, x1:80, y1:50 } : { x0:18, y0:18, x1:72, y1:42 }; }
  function chooseAxis(matchId){ return hash01(matchId,'axis') >= 0.5; } // true => top/bottom, false => left/right
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
  function isWalkable(api, gx, gy){
    if(api.isWalkableTile) return !!api.isWalkableTile(gx,gy);
    if(api.tileIsBlocked)  return !api.tileIsBlocked(gx,gy);
    return true; // best-effort if engine doesn’t expose collisions
  }
  function edgeSpawn(api, tier, axisTB, leftOrTop, matchId){
    const un = unlockedRect(tier), lane=safeLane(un,axisTB), t=api.TILE;
    const tries = 40;
    if(axisTB){
      const span=Math.max(1,lane.xMax-lane.xMin), r=hash01(matchId,(leftOrTop?'top':'bottom')+'|off');
      for(let i=0;i<tries;i++){
        const jitter=((i?hash01(matchId,'jit'+i):r)), gx=(lane.xMin + Math.floor(jitter*span));
        const gy=leftOrTop?lane.yTop:lane.yBottom;
        if(isWalkable(api,gx,gy)) return { x:gx*t, y:gy*t, facing:leftOrTop?'down':'up' };
      }
    }else{
      const span=Math.max(1,lane.yMax-lane.yMin), r=hash01(matchId,(leftOrTop?'left':'right')+'|off');
      for(let i=0;i<tries;i++){
        const jitter=((i?hash01(matchId,'jitY'+i):r)), gy=(lane.yMin + Math.floor(jitter*span));
        const gx=leftOrTop?lane.xLeft:lane.xRight;
        if(isWalkable(api,gx,gy)) return { x:gx*t, y:gy*t, facing:leftOrTop?'right':'left' };
      }
    }
    // fallback center-ish
    const cgx=((un.x0+un.x1)/2)|0, cgy=((un.y0+un.y1)/2)|0;
    return { x: cgx*t, y: cgy*t, facing:'down' };
  }
  function hash01(str,salt){
    let h=2166136261>>>0, s=(String(str)+'|'+(salt||'')); for(let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,16777619); }
    h^=h<<13; h^=h>>>17; h^=h<<5; return ((h>>>0)%100000)/100000;
  }

  // ----- OPPONENT SNAPSHOT/STATE -----
  const OPP = { active:false, name:'', x:0, y:0, facing:'down', hp:4.0, inv:{}, appearance:null, _sprite:null };

  // try to render as a real character (preferred), otherwise fallback
  function ensureOppSprite(api, snap){
    if(OPP._sprite && OPP._sprite.__native) return OPP._sprite;
    if(api.addRemotePlayer){
      const rp = api.addRemotePlayer({ username: snap.username, appearance: snap.appearance||{} });
      OPP._sprite = rp; OPP._sprite.__native = true;
      return rp;
    }
    // fallback: canvas overlay (kept from v2.1 so you still see *something*)
    if(!OPP._sprite){
      OPP._sprite = { drawFallback:true };
      IZZA.on?.('render-post', drawOpponentFallback);
    }
    return OPP._sprite;
  }
  function drawOpponentFallback(){
    try{
      if(!OPP.active || !OPP._sprite?.drawFallback) return;
      const api=IZZA.api, ctx=document.getElementById('game').getContext('2d');
      const scale = api.DRAW/api.TILE;
      const sx = (OPP.x - api.camera.x) * scale;
      const sy = (OPP.y - api.camera.y) * scale;
      ctx.save(); ctx.imageSmoothingEnabled=false;

      // body proxy
      ctx.fillStyle='#4ad1ff';
      ctx.fillRect(sx + api.DRAW*0.15, sy + api.DRAW*0.05, api.DRAW*0.70, api.DRAW*0.82);

      // name
      ctx.fillStyle = 'rgba(8,12,20,.85)';
      ctx.fillRect(sx + api.DRAW*0.02, sy - api.DRAW*0.28, api.DRAW*0.96, api.DRAW*0.22);
      ctx.fillStyle = '#d9ecff'; ctx.font = (api.DRAW*0.20)+'px monospace'; ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.fillText(OPP.name||'Opponent', sx + api.DRAW*0.50, sy - api.DRAW*0.17, api.DRAW*0.92);

      // hp bar
      const w = api.DRAW*0.92, hpPct=Math.max(0,Math.min(1, OPP.hp/4.0));
      ctx.fillStyle='#2b394f'; ctx.fillRect(sx + api.DRAW*0.04, sy - api.DRAW*0.38, w, api.DRAW*0.07);
      ctx.fillStyle='#8cf08a'; ctx.fillRect(sx + api.DRAW*0.04, sy - api.DRAW*0.38, w*hpPct, api.DRAW*0.07);
      ctx.restore();
    }catch{}
  }

  // ===== MINIMAP RED DOT =====
  const MINI = { host:null, oppDot:null };
  function findMiniHost(){
    if (MINI.host && document.body.contains(MINI.host)) return MINI.host;
    const candidates=['#miniMap','#minimap','#mapMini','#hudMini','#mini','.minimap','[data-minimap]'];
    for(const sel of candidates){ const el=document.querySelector(sel); if(el){ MINI.host=el; break; } }
    if(!MINI.host){
      const box=document.createElement('div');
      Object.assign(box.style,{position:'fixed', right:'10px', top:'10px', width:'110px', height:'80px',
        background:'rgba(10,14,22,.55)', border:'1px solid #2a3550', borderRadius:'8px', zIndex:12});
      box.setAttribute('data-minimap','1'); document.body.appendChild(box); MINI.host=box;
    }
    MINI.host.style.position = MINI.host.style.position || 'relative';
    return MINI.host;
  }
  function ensureMiniDot(){
    const host=findMiniHost();
    if(!MINI.oppDot){
      const d=document.createElement('div');
      Object.assign(d.style,{position:'absolute', width:'6px', height:'6px', borderRadius:'50%',
        background:'#ff4d4d', boxShadow:'0 0 4px rgba(255,70,70,.85)', pointerEvents:'none', transform:'translate(-50%,-50%)'});
      host.appendChild(d); MINI.oppDot=d;
    }
  }
  function updateMiniDot(api){
    if(!OPP.active) return;
    ensureMiniDot();
    const host = MINI.host; if(!host) return;
    const tier = localStorage.getItem('izzaMapTier') || '2';
    const un = unlockedRect(tier);
    const rect = host.getBoundingClientRect();
    const t = api.TILE;

    const opGX = Math.floor(OPP.x / t), opGY = Math.floor(OPP.y / t);
    const clamp=(v,a,b)=> Math.max(a, Math.min(b, v));
    const spanX = (un.x1 - un.x0) || 1, spanY = (un.y1 - un.y0) || 1;
    const opNX = clamp((opGX - un.x0) / spanX, 0, 1), opNY = clamp((opGY - un.y0) / spanY, 0, 1);

    MINI.oppDot.style.left = (rect.width  * opNX) + 'px';
    MINI.oppDot.style.top  = (rect.height * opNY) + 'px';
    MINI.oppDot.style.display = 'block';
  }

  // ----- SYNC (REST alternating) -----
  let SYNC = { mid:null, timer:null, flip:false, pollMs:125, sentAppearance:false };

  async function poke(){
    const api=IZZA.api; if(!api?.ready || !SYNC.mid) return;
    const body = {
      matchId: SYNC.mid,
      x: api.player.x, y: api.player.y, facing: api.player.facing||'down',
      hp: api.player.hp||4.0,
      inv: safeInv()
    };
    // include my appearance once so opponent can render me
    if(!SYNC.sentAppearance){
      body.appearance = readAppearance();
      SYNC.sentAppearance = true;
    }
    try{
      await fetch(withTok(BASE+'/duel/poke'), {
        method:'POST', credentials:'include',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify(body)
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
        OPP.appearance = j.opponent.appearance || OPP.appearance;
        // ensure real sprite if engine supports it
        const spr = ensureOppSprite(IZZA.api, {username:OPP.name, appearance:OPP.appearance});
        if(spr && spr.__native){ spr.x=OPP.x; spr.y=OPP.y; spr.facing=OPP.facing; }
      }
    }catch{}
  }
  function startSync(){
    stopSync();
    SYNC.timer = setInterval(()=>{ if(!SYNC.mid) return; if(SYNC.flip) poke(); else pull(); SYNC.flip=!SYNC.flip; }, SYNC.pollMs);
  }
  function stopSync(){ if(SYNC.timer){ clearInterval(SYNC.timer); SYNC.timer=null; } }

  // ----- INVENTORY / APPEARANCE -----
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
      bat:     { equipped: !!inv?.bat?.equipped,     uses: inv?.bat?.uses|0 },
      knucks:  { equipped: !!inv?.knucks?.equipped,  uses: inv?.knucks?.uses|0 }
    };
  }
  function readAppearance(){
    try{
      if(IZZA?.api?.getAppearance) return IZZA.api.getAppearance() || {};
      // fallback fields; adjust to your character system if different
      return {
        skin: IZZA.api.user?.skin || 'ped_m',
        hair: IZZA.api.user?.hair || 'short',
        outfit: IZZA.api.user?.outfit || 'default'
      };
    }catch{ return {}; }
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

  // ----- DAMAGE (client → server) -----
  // Your guns/melee still run as usual; we just inform the server for PvP hearts.
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

      // ensure lobby isn’t freezing input
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

      // if engine supports native remote players, instantiate now with placeholder appearance
      ensureOppSprite(api, {username:OPP.name, appearance:OPP.appearance||{}});

      window.__IZZA_DUEL={active:true,mode,matchId,axisTB,leftTop:assign.leftTop,rightBottom:assign.rightBottom};

      SYNC.mid = String(matchId);
      SYNC.sentAppearance = false; // send mine on first poke
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
        // if native remote sprite exists, keep it synced
        if(OPP._sprite && OPP._sprite.__native){ OPP._sprite.x=OPP.x; OPP._sprite.y=OPP.y; OPP._sprite.facing=OPP.facing; }
        updateMiniDot(api);
      }
    }catch{}
  });

  IZZA.on?.('mp-start', (payload)=> withReadyUser(beginDuel, payload));
  IZZA.on?.('mp-end', ()=>{ stopSync(); OPP.active=false; if(MINI?.oppDot) MINI.oppDot.style.display='none'; window.__IZZA_DUEL={active:false}; });

  if(window.__MP_START_PENDING){ const p=window.__MP_START_PENDING; delete window.__MP_START_PENDING; withReadyUser(beginDuel, p); }
})();
