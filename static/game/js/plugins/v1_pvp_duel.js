// PvP Duel bootstrap — v1.2
// - Opposite-edge spawns, deterministic & safe (no water/buildings when engine exposes checks)
// - Opponent visible (minimal render overlay)
// - Mini sync: WS (/ws/duel) with HTTP fallback (/match/*), isolated to duel
(function(){
  const BUILD='v1.2-pvp-duel-safe-spawn+mini-sync';
  console.log('[IZZA PLAY]', BUILD);

  // ---------- config ----------
  const MP_BASE = (window.__MP_BASE__ || '/izza-game/api/mp');
  const MP_WS   = (window.__MP_WS__   || '/izza-game/api/mp/ws');
  const TOK     = (window.__IZZA_T__  || '').toString();

  const withTok = (p)=> TOK ? p + (p.includes('?')?'&':'?') + 't=' + encodeURIComponent(TOK) : p;

  // ---------- tiny fetch helpers (local to this plugin) ----------
  async function jget(p){
    const r = await fetch(withTok(MP_BASE+p), {credentials:'include'});
    if(!r.ok) throw new Error(r.status+' '+r.statusText);
    return r.json();
  }
  async function jpost(p,b){
    const r = await fetch(withTok(MP_BASE+p), {method:'POST', credentials:'include', headers:{'Content-Type':'application/json'}, body:JSON.stringify(b||{})});
    if(!r.ok) throw new Error(r.status+' '+r.statusText);
    return r.json();
  }

  // ---------- name & random helpers ----------
  const normName = (s)=> (s||'').toString().trim().replace(/^@+/,'').toLowerCase();
  function randFromHash(str, salt){
    let h = 2166136261 >>> 0;
    const s = (str + '|' + (salt||'')).toString();
    for(let i=0;i<s.length;i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    h ^= h << 13; h ^= h >>> 17; h ^= h << 5;
    return ((h>>>0) % 100000) / 100000;
  }

  // ---------- safe duel region ----------
  function unlockedRect(tier){
    // mirrors your building plugin
    return (tier==='2') ? { x0:10, y0:12, x1:80, y1:50 }
                        : { x0:18, y0:18, x1:72, y1:42 };
  }

  // ---- walkability probes (best effort: uses any available API; else assumes walkable) ----
  function tileInfo(api, gx, gy){
    try{
      if(api.map?.getTile) return api.map.getTile(gx,gy);
      if(api.getTile) return api.getTile(gx,gy);
      if(api.map?.tiles) return api.map.tiles[gy]?.[gx];
    }catch(e){}
    return null;
  }
  function isWalkable(api, gx, gy){
    try{
      if (api.isWalkable) return !!api.isWalkable(gx,gy);
      if (api.map?.isWalkable) return !!api.map.isWalkable(gx,gy);
      if (api.tileIsFree) return !!api.tileIsFree(gx,gy);
    }catch(e){}
    // Heuristic on tile type if available
    const t = tileInfo(api, gx, gy);
    const type = (t && (t.type||t.kind||t.name||'')).toString().toLowerCase();
    if(type){
      if(type.includes('water')) return false;
      if(type.includes('river')) return false;
      if(type.includes('sea'))   return false;
      if(type.includes('building')||type.includes('wall')||type.includes('house')) return false;
      if(type.includes('tree')||type.includes('rock')) return false;
      // allow grass/road/sidewalk/path
      return (type.includes('grass') || type.includes('road') || type.includes('street') || type.includes('sidewalk') || type.includes('pavement') || type.includes('path'));
    }
    // Fallback if we can't read map data: assume walkable; margins below still keep us safe.
    return true;
  }

  function findSafeTile(api, gx, gy, dirx, diry, steps=12){
    let x=gx, y=gy;
    for(let i=0;i<=steps;i++){
      if(isWalkable(api, x, y)) return {gx:x, gy:y};
      x += dirx; y += diry;
    }
    // last resort: radial search inward box
    for(let r=1;r<=steps;r++){
      for(let dx=-r; dx<=r; dx++){
        for(let dy=-r; dy<=r; dy++){
          const xx=gx+dx, yy=gy+dy;
          if(isWalkable(api, xx, yy)) return {gx:xx, gy:yy};
        }
      }
    }
    return {gx, gy};
  }

  // ---------- side + axis ----------
  function chooseAxis(matchId){ return randFromHash(String(matchId),'axis') >= 0.5; }
  function sideAssignment(matchId, players){
    const a = normName(players[0]?.username);
    const b = normName(players[1]?.username);
    const sorted = [a,b].sort();
    const flip = randFromHash(String(matchId),'flip') >= 0.5;
    const leftTop = flip ? sorted[1] : sorted[0];
    const rightBottom = flip ? sorted[0] : sorted[1];
    return { leftTop, rightBottom };
  }

  function edgeSpawn(api, tier, axisTopBottom, isLeftOrTop, matchId){
    const un = unlockedRect(tier);
    const t  = api.TILE;

    // Larger margins to avoid water/impassables and ensure distinctness
    const marginEdge   = 10; // keep far off borders
    const marginSearch = 8;  // inward search budget

    if(axisTopBottom){
      const minX = un.x0 + marginEdge, maxX = un.x1 - marginEdge;
      const span = Math.max(1, maxX - minX);
      const r    = randFromHash(String(matchId), (isLeftOrTop?'top':'bottom') + '|off');
      const gx0  = Math.floor(minX + r*span);
      const gy0  = isLeftOrTop ? (un.y0 + marginEdge) : (un.y1 - marginEdge);
      const stepY = isLeftOrTop ? +1 : -1;
      const safe  = findSafeTile(api, gx0, gy0, 0, stepY, marginSearch);
      return { x: safe.gx*t, y: safe.gy*t, facing: isLeftOrTop ? 'down' : 'up' };
    }else{
      const minY = un.y0 + marginEdge, maxY = un.y1 - marginEdge;
      const span = Math.max(1, maxY - minY);
      const r    = randFromHash(String(matchId), (isLeftOrTop?'left':'right') + '|off');
      const gy0  = Math.floor(minY + r*span);
      const gx0  = isLeftOrTop ? (un.x0 + marginEdge) : (un.x1 - marginEdge);
      const stepX = isLeftOrTop ? +1 : -1;
      const safe  = findSafeTile(api, gx0, gy0, stepX, 0, marginSearch);
      return { x: safe.gx*t, y: safe.gy*t, facing: isLeftOrTop ? 'right' : 'left' };
    }
  }

  // ---------- simple HUD countdown ----------
  function showCountdown(n=3){
    let host = document.getElementById('pvpCountdown');
    if(!host){
      host = document.createElement('div');
      host.id='pvpCountdown';
      Object.assign(host.style,{
        position:'fixed', inset:'0', display:'flex', alignItems:'center', justifyContent:'center',
        zIndex: 30, pointerEvents:'none', fontFamily:'system-ui,Arial,sans-serif'
      });
      document.body.appendChild(host);
    }
    const label = document.createElement('div');
    Object.assign(label.style,{
      background:'rgba(6,10,18,.6)', color:'#cfe0ff', border:'1px solid #2a3550',
      padding:'16px 22px', borderRadius:'14px', fontSize:'28px', fontWeight:'800',
      textShadow:'0 2px 6px rgba(0,0,0,.4)'
    });
    host.innerHTML=''; host.appendChild(label);
    let cur = n; label.textContent = 'Ready…';
    setTimeout(function tick(){
      if(cur>0){ label.textContent = String(cur); cur--; setTimeout(tick, 800); }
      else { label.textContent = 'GO!'; setTimeout(()=>host.remove(), 600); }
    }, 500);
  }

  // ---------- mini sync (WS first, HTTP fallback) ----------
  let SYNC = { ws:null, timer:null, lastSent:0, lastRecv:0, remote:{} };

  function openWS(matchId){
    try{
      const proto = location.protocol==='https:'?'wss:':'ws:';
      const url = proto+'//'+location.host + withTok(MP_WS + '/duel') + '&match=' + encodeURIComponent(matchId);
      const ws = new WebSocket(url);
      ws.onopen = ()=>{
        // initial identify
        ws.send(JSON.stringify({matchId, hello:true}));
      };
      ws.onmessage = (evt)=>{
        try{
          const pkt = JSON.parse(evt.data);
          if(pkt && pkt.type==='state' && pkt.state){
            SYNC.lastRecv = Date.now()/1000;
            SYNC.remote = { ...pkt.state, ts: Date.now()/1000 };
          }
        }catch{}
      };
      ws.onclose = ()=>{ SYNC.ws=null; };
      ws.onerror = ()=>{ try{ ws.close(); }catch{}; SYNC.ws=null; };
      SYNC.ws = ws;
      return true;
    }catch(e){
      console.warn('[duel] ws open failed', e);
      return false;
    }
  }

  async function httpJoin(matchId, mode, players){
    try{ await jpost('/match/join', {matchId, mode, players}); }catch{}
  }
  async function httpLeave(matchId){
    try{ await jpost('/match/leave', {matchId}); }catch{}
  }
  async function httpPush(matchId, state, mode, players){
    try{ await jpost('/match/state', {matchId, state, mode, players}); }catch{}
  }
  async function httpPull(matchId){
    try{
      const since = SYNC.lastRecv || 0;
      const r = await jget('/match/others?matchId='+encodeURIComponent(matchId)+'&since='+encodeURIComponent(since));
      if(r && r.states && r.states.length){
        // take the newest
        const newest = r.states.reduce((a,b)=> (a.ts||0) > (b.ts||0) ? a : b);
        SYNC.remote = {...newest, ts: r.now || Date.now()/1000};
        SYNC.lastRecv = r.now || Date.now()/1000;
      }
    }catch{}
  }

  function startSync(match){
    const api = IZZA.api;
    const mode = match.mode || 'v1';
    const players = (match.players||[]).map(p=>p.id);

    // HTTP join (safe no-op if WS also in use)
    httpJoin(match.matchId, mode, players);

    // Try WS; if not available, timer loop uses HTTP
    openWS(match.matchId);

    // 10 Hz send, 10 Hz pull (pull only if no WS)
    if(SYNC.timer) clearInterval(SYNC.timer);
    SYNC.timer = setInterval(async ()=>{
      // send my state
      const state = {
        x: api.player.x|0, y: api.player.y|0,
        facing: api.player.facing||'down',
        anim: api.player.anim||'idle'
      };
      if(SYNC.ws && SYNC.ws.readyState===1){
        try{ SYNC.ws.send(JSON.stringify({matchId:match.matchId, state})); }catch{}
      }else{
        await httpPush(match.matchId, state, mode, players);
      }
      // pull if not on WS
      if(!SYNC.ws || SYNC.ws.readyState!==1){
        await httpPull(match.matchId);
      }
    }, 100); // ~10 Hz
  }

  function stopSync(matchId){
    if(SYNC.timer) { clearInterval(SYNC.timer); SYNC.timer=null; }
    if(SYNC.ws){ try{ SYNC.ws.close(); }catch{}; SYNC.ws=null; }
    httpLeave(matchId);
    SYNC.remote = {};
  }

  // ---------- render opponent (very lightweight overlay) ----------
  function worldToScreenX(api, wx){ return (wx - api.camera.x)*(api.DRAW/api.TILE); }
  function worldToScreenY(api, wy){ return (wy - api.camera.y)*(api.DRAW/api.TILE); }

  IZZA.on('render-post', ()=>{
    const api = IZZA.api;
    if(!api?.ready) return;
    const r = SYNC.remote;
    if(!r || r.x==null || r.y==null) return;
    const cx = worldToScreenX(api, r.x);
    const cy = worldToScreenY(api, r.y);
    const ctx = document.getElementById('game')?.getContext('2d');
    if(!ctx) return;
    ctx.save();
    // opponent marker (simple silhouette)
    ctx.fillStyle='rgba(255,70,70,0.9)';
    ctx.beginPath();
    ctx.arc(cx+api.TILE*0.25, cy+api.TILE*0.25, Math.max(6, api.TILE*0.20), 0, Math.PI*2);
    ctx.fill();
    ctx.restore();
  });

  // ---------- main listener ----------
  IZZA.on('mp-start', ({mode, matchId, players})=>{
    try{
      const api = IZZA.api;
      if(!api?.ready || !players || players.length<2) return;
      if(mode!=='v1') return; // this plugin handles 1v1

      const tier = localStorage.getItem('izzaMapTier') || '2';
      const axisTB = chooseAxis(matchId); // true=top/bottom, false=left/right
      const assign = sideAssignment(matchId, players);
      const meU = normName(api.user?.username || 'player');

      // deterministic opposite sides
      const amLeftOrTop = (meU === assign.leftTop);
      const spawn = edgeSpawn(api, tier, axisTB, amLeftOrTop, matchId);

      // Teleport + face
      api.player.x = spawn.x;
      api.player.y = spawn.y;
      api.player.facing = spawn.facing || 'down';
      api.setWanted?.(0);

      // Center camera near me (helps when far apart)
      if(api.camera){
        api.camera.x = Math.max(0, api.player.x - api.DRAW/2);
        api.camera.y = Math.max(0, api.player.y - api.DRAW/2);
      }

      // Start mini sync so we see each other
      startSync({mode, matchId, players});

      // HUD niceties
      const opp = players.find(p=> normName(p.username)!==meU);
      IZZA.emit?.('toast', {text:`1v1 vs ${opp?.username || 'opponent'} — good luck!`});
      showCountdown(3);

      // mark duel active
      window.__IZZA_DUEL = { active:true, mode, matchId, axisTB,
        leftTop:assign.leftTop, rightBottom:assign.rightBottom };
    }catch(e){
      console.warn('[PvP duel] failed to start', e);
    }
  });

  IZZA.on?.('mp-end', (e)=>{
    if(window.__IZZA_DUEL?.active && window.__IZZA_DUEL.matchId){
      stopSync(window.__IZZA_DUEL.matchId);
    }
    window.__IZZA_DUEL = { active:false };
  });

})();
