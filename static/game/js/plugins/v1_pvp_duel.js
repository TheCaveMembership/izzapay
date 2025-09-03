// PvP Duel bootstrap — v1.3
// - HTTP-only mini sync (no websockets)
// - Opponent rendered as their actual character (from /render/profile)
// - Opposite-edge safe spawns: never water/buildings when APIs are available
(function(){
  const BUILD='v1.3-pvp-duel-http-sync+exact-render';
  console.log('[IZZA PLAY]', BUILD);

  const MP_BASE = (window.__MP_BASE__ || '/izza-game/api/mp');
  const TOK     = (window.__IZZA_T__  || '').toString();
  const withTok = (p)=> TOK ? p + (p.includes('?')?'&':'?') + 't=' + encodeURIComponent(TOK) : p;

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

  const norm = (s)=> (s||'').toString().trim().replace(/^@+/,'').toLowerCase();
  function randFromHash(str, salt){
    let h = 2166136261 >>> 0;
    const s = (str + '|' + (salt||'')).toString();
    for(let i=0;i<s.length;i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    h ^= h << 13; h ^= h >>> 17; h ^= h << 5;
    return ((h>>>0) % 100000) / 100000;
  }

  function unlockedRect(tier){
    return (tier==='2') ? { x0:10, y0:12, x1:80, y1:50 }
                        : { x0:18, y0:18, x1:72, y1:42 };
  }

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
    const t = tileInfo(api, gx, gy);
    const type = (t && (t.type||t.kind||t.name||'')).toString().toLowerCase();
    if(type){
      if(type.includes('water')||type.includes('river')||type.includes('sea')) return false;
      if(type.includes('building')||type.includes('wall')||type.includes('house')) return false;
      if(type.includes('tree')||type.includes('rock')) return false;
      return (type.includes('grass')||type.includes('road')||type.includes('street')||type.includes('sidewalk')||type.includes('pavement')||type.includes('path'));
    }
    return true; // fallback
  }
  function findSafeTile(api, gx, gy, dirx, diry, steps=12){
    let x=gx, y=gy;
    for(let i=0;i<=steps;i++){
      if(isWalkable(api, x, y)) return {gx:x, gy:y};
      x += dirx; y += diry;
    }
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

  function chooseAxis(matchId){ return randFromHash(String(matchId),'axis') >= 0.5; }
  function sideAssignment(matchId, players){
    const a = norm(players[0]?.username);
    const b = norm(players[1]?.username);
    const sorted = [a,b].sort();
    const flip = randFromHash(String(matchId),'flip') >= 0.5;
    const leftTop = flip ? sorted[1] : sorted[0];
    const rightBottom = flip ? sorted[0] : sorted[1];
    return { leftTop, rightBottom };
  }
  function edgeSpawn(api, tier, axisTopBottom, isLeftOrTop, matchId){
    const un = unlockedRect(tier);
    const t  = api.TILE;
    const marginEdge=10, marginSearch=8;

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

  // ---- opponent render support ----
  let OPP = { userId:null, username:null, profile:null, state:null };
  async function loadOpponentProfile(username, userId){
    try{
      const qs = userId ? ('?userId='+encodeURIComponent(userId)) : ('?username='+encodeURIComponent(username));
      const r = await jget('/render/profile'+qs);
      if(r && r.ok){
        OPP.userId = r.userId || userId || null;
        OPP.profile = r.profile || null;
      }
    }catch(e){ console.warn('render profile fetch failed', e); }
  }

  function drawOpponent(ctx, api, wx, wy){
    if(!OPP.profile){
      // tiny fallback marker while profile loads
      ctx.fillStyle='rgba(255,70,70,0.9)';
      ctx.beginPath();
      ctx.arc(wx + api.TILE*0.25, wy + api.TILE*0.25, Math.max(6, api.TILE*0.20), 0, Math.PI*2);
      ctx.fill();
      return;
    }
    // Try common render hooks your engine may expose
    if(api.renderAvatar){
      api.renderAvatar(ctx, wx, wy, OPP.profile);
      return;
    }
    if(api.drawAvatar){
      api.drawAvatar(ctx, wx, wy, OPP.profile);
      return;
    }
    if(api.avatars?.draw){
      api.avatars.draw(ctx, wx, wy, OPP.profile);
      return;
    }
    // last resort – still show something:
    ctx.fillStyle='rgba(255,70,70,0.9)';
    ctx.fillRect(wx, wy, api.TILE*0.5, api.TILE*0.8);
  }

  // ---- HTTP-only mini sync (10 Hz)
  let SYNC = { timer:null, lastRecv:0, remote:{} };
  async function httpJoin(match){ try{ await jpost('/match/join', {matchId:match.matchId, mode:match.mode, players:(match.players||[]).map(p=>p.id)}); }catch{} }
  async function httpLeave(match){ try{ await jpost('/match/leave', {matchId:match.matchId}); }catch{} }
  async function httpPush(match, api){
    try{
      await jpost('/match/state', {
        matchId: match.matchId,
        mode: match.mode,
        players: (match.players||[]).map(p=>p.id),
        state: { x: api.player.x|0, y: api.player.y|0, facing: api.player.facing||'down', anim: api.player.anim||'idle' }
      });
    }catch{}
  }
  async function httpPull(match){
    try{
      const r = await jget('/match/others?matchId='+encodeURIComponent(match.matchId)+'&since='+encodeURIComponent(SYNC.lastRecv||0));
      if(r && r.states && r.states.length){
        const newest = r.states.reduce((a,b)=> (a.ts||0) > (b.ts||0) ? a : b);
        SYNC.remote = newest;
        SYNC.lastRecv = r.now || Date.now()/1000;
      }
    }catch{}
  }
  function startSync(match){
    const api = IZZA.api;
    if(SYNC.timer) clearInterval(SYNC.timer);
    httpJoin(match);
    SYNC.timer = setInterval(async ()=>{
      await httpPush(match, api);
      await httpPull(match);
    }, 100); // 10 Hz
  }
  function stopSync(match){
    if(SYNC.timer){ clearInterval(SYNC.timer); SYNC.timer=null; }
    httpLeave(match);
    SYNC.remote = {}; SYNC.lastRecv=0;
  }

  function w2sX(api,wx){ return (wx - api.camera.x)*(api.DRAW/api.TILE); }
  function w2sY(api,wy){ return (wy - api.camera.y)*(api.DRAW/api.TILE); }

  IZZA.on('render-post', ()=>{
    const api = IZZA.api;
    if(!api?.ready) return;
    const r = SYNC.remote;
    if(!r || r.x==null || r.y==null) return;
    const ctx = document.getElementById('game')?.getContext('2d');
    if(!ctx) return;
    ctx.save();
    drawOpponent(ctx, api, r.x, r.y);
    ctx.restore();
  });

  function showCountdown(n=3){
    let host = document.getElementById('pvpCountdown');
    if(!host){
      host = document.createElement('div');
      host.id='pvpCountdown';
      Object.assign(host.style,{position:'fixed', inset:'0', display:'flex', alignItems:'center', justifyContent:'center', zIndex:30, pointerEvents:'none', fontFamily:'system-ui,Arial,sans-serif'});
      document.body.appendChild(host);
    }
    const label = document.createElement('div');
    Object.assign(label.style,{background:'rgba(6,10,18,.6)', color:'#cfe0ff', border:'1px solid #2a3550', padding:'16px 22px', borderRadius:'14px', fontSize:'28px', fontWeight:'800'});
    host.innerHTML=''; host.appendChild(label);
    let cur=n; label.textContent='Ready…';
    setTimeout(function tick(){ if(cur>0){ label.textContent=String(cur); cur--; setTimeout(tick,800);} else { label.textContent='GO!'; setTimeout(()=>host.remove(),600);} }, 500);
  }

  // ---------- main ----------
  IZZA.on('mp-start', async ({mode, matchId, players})=>{
    try{
      const api = IZZA.api;
      if(!api?.ready || !players || players.length<2) return;
      if(mode!=='v1') return;

      const tier = localStorage.getItem('izzaMapTier') || '2';
      const axisTB = (randFromHash(String(matchId),'axis') >= 0.5);
      const assign = (function(){
        const a = norm(players[0]?.username), b = norm(players[1]?.username);
        const sorted=[a,b].sort(); const flip = randFromHash(String(matchId),'flip')>=0.5;
        return { leftTop: (flip?sorted[1]:sorted[0]), rightBottom: (flip?sorted[0]:sorted[1]) };
      })();
      const meU = norm(api.user?.username || 'player');
      const amLeftOrTop = (meU === assign.leftTop);
      const spawn = edgeSpawn(api, tier, axisTB, amLeftOrTop, matchId);

      // Self place
      api.player.x = spawn.x; api.player.y = spawn.y; api.player.facing = spawn.facing || 'down';
      api.setWanted?.(0);
      if(api.camera){ api.camera.x = Math.max(0, api.player.x - api.DRAW/2); api.camera.y = Math.max(0, api.player.y - api.DRAW/2); }

      // Figure opponent & load appearance
      const opp = players.find(p=> norm(p.username)!==meU);
      if(opp){ OPP.username = opp.username; await loadOpponentProfile(opp.username, opp.id); }

      // Start HTTP sync
      startSync({mode, matchId, players});

      IZZA.emit?.('toast', {text:`1v1 vs ${opp?.username || 'opponent'} — good luck!`});
      showCountdown(3);

      window.__IZZA_DUEL = { active:true, mode, matchId };
    }catch(e){ console.warn('[PvP duel] failed', e); }
  });

  IZZA.on?.('mp-end', ()=>{
    const m = window.__IZZA_DUEL;
    if(m?.active){ stopSync({matchId:m.matchId}); }
    window.__IZZA_DUEL = { active:false };
  });

})();
