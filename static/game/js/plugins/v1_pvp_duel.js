// PvP Duel bootstrap — v1.3
// - Opposite-edges safe spawn (inside Tier-2 rectangle)
// - Case-insensitive side assignment (never same spot)
// - REST polling sync: both players visible and moving in real time
(function(){
  const BUILD='v1.3-pvp-duel-rest-sync';
  console.log('[IZZA PLAY]', BUILD);

  const norm = (s)=> (s||'').toString().replace(/^@+/,'').toLowerCase();

  function randFromHash(str, salt){
    let h = 2166136261 >>> 0;
    const s = (String(str) + '|' + (salt||''));
    for(let i=0;i<s.length;i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    h ^= h << 13; h ^= h >>> 17; h ^= h << 5;
    return ((h>>>0) % 100000) / 100000;
  }

  function unlockedRect(tier){
    return (tier==='2') ? { x0:10, y0:12, x1:80, y1:50 }
                        : { x0:18, y0:18, x1:72, y1:42 };
  }

  function safeLaneForAxis(un, axisTopBottom){
    const margin = 3;
    if(axisTopBottom){
      return { yTop:un.y0+margin, yBottom:un.y1-margin, xMin:un.x0+margin, xMax:un.x1-margin };
    }else{
      return { xLeft:un.x0+margin, xRight:un.x1-margin, yMin:un.y0+margin, yMax:un.y1-margin };
    }
  }

  function chooseAxis(matchId){ return randFromHash(matchId,'axis') >= 0.5; }

  function sideAssignment(matchId, players){
    const a = norm(players[0]?.username);
    const b = norm(players[1]?.username);
    const sorted = [a,b].sort();
    const flip = randFromHash(matchId,'flip') >= 0.5;
    return { leftTop: (flip?sorted[1]:sorted[0]), rightBottom: (flip?sorted[0]:sorted[1]) };
  }

  function edgeSpawn(api, tier, axisTopBottom, isLeftOrTop, matchId){
    const un = unlockedRect(tier);
    const lane = safeLaneForAxis(un, axisTopBottom);
    const t  = api.TILE;

    if(axisTopBottom){
      const span = Math.max(1, lane.xMax - lane.xMin);
      const r    = randFromHash(matchId, (isLeftOrTop?'top':'bottom') + '|off');
      const gx   = Math.floor(lane.xMin + r*span);
      const gy   = isLeftOrTop ? lane.yTop : lane.yBottom;
      return { x: gx*t, y: gy*t, facing: isLeftOrTop ? 'down' : 'up' };
    }else{
      const span = Math.max(1, lane.yMax - lane.yMin);
      const r    = randFromHash(matchId, (isLeftOrTop?'left':'right') + '|off');
      const gy   = Math.floor(lane.yMin + r*span);
      const gx   = isLeftOrTop ? lane.xLeft : lane.xRight;
      return { x: gx*t, y: gy*t, facing: isLeftOrTop ? 'right' : 'left' };
    }
  }

  // opponent snapshot (synced via REST)
  const OPP = { active:false, name:'', x:0, y:0, facing:'down', hp:5, lastTs:0 };

  function drawOpponent(api){
    if(!OPP.active) return;
    const ctx = document.getElementById('game').getContext('2d');
    const S = api.DRAW;
    const sx = (OPP.x - api.camera.x) * (S/api.TILE);
    const sy = (OPP.y - api.camera.y) * (S/api.TILE);

    ctx.save();
    ctx.imageSmoothingEnabled=false;

    // simple player-like sprite (distinct color)
    ctx.fillStyle = '#48d3ff';
    ctx.fillRect(sx + S*0.18, sy + S*0.08, S*0.64, S*0.78);

    // name label
    ctx.fillStyle = 'rgba(8,12,20,.85)';
    ctx.fillRect(sx + S*0.06, sy - S*0.28, S*0.88, S*0.22);
    ctx.fillStyle = '#d9ecff';
    ctx.font = (S*0.20)+'px monospace';
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText(OPP.name||'Opponent', sx + S*0.50, sy - S*0.17, S*0.82);

    ctx.restore();
  }

  function showCountdown(n=3){
    let host = document.getElementById('pvpCountdown');
    if(!host){
      host = document.createElement('div');
      host.id='pvpCountdown';
      Object.assign(host.style,{position:'fixed', inset:'0', display:'flex', alignItems:'center', justifyContent:'center', zIndex:30, pointerEvents:'none', fontFamily:'system-ui,Arial,sans-serif'});
      document.body.appendChild(host);
    }
    const label = document.createElement('div');
    Object.assign(label.style,{background:'rgba(6,10,18,.6)', color:'#cfe0ff', border:'1px solid #2a3550', padding:'16px 22px', borderRadius:'14px', fontSize:'28px', fontWeight:'800', textShadow:'0 2px 6px rgba(0,0,0,.4)'});
    host.innerHTML=''; host.appendChild(label);
    let cur=n; label.textContent='Ready…'; setTimeout(function tick(){ if(cur>0){ label.textContent=String(cur--); setTimeout(tick,800);} else { label.textContent='GO!'; setTimeout(()=>host.remove(),600);} },500);
  }

  // ---- REST sync loop (no websockets) ----
  let SYNC = { timer:null, matchId:null, meName:'', pollMs:125 };

  async function poke(api){
    try{
      await fetch(withTok('/duel/poke'),{
        method:'POST', credentials:'include',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          matchId: SYNC.matchId,
          x: api.player.x, y: api.player.y,
          facing: api.player.facing||'down',
          hp: api.player.hp||5,
          // (optional) skin: api.user?.skin
        })
      });
    }catch{}
  }
  async function pull(){
    try{
      const r = await fetch(withTok('/duel/pull?matchId='+encodeURIComponent(SYNC.matchId)), {credentials:'include'});
      if(!r.ok) return;
      const j = await r.json();
      if(j && j.opponent){
        OPP.active = true;
        OPP.x = j.opponent.x; OPP.y = j.opponent.y;
        OPP.facing = j.opponent.facing||'down';
        OPP.hp = j.opponent.hp||5;
      }
    }catch{}
  }
  function startSyncLoop(api){
    if(SYNC.timer) clearInterval(SYNC.timer);
    // run poke and pull staggered to reduce contention
    let flip=false;
    SYNC.timer = setInterval(async ()=>{
      if(!SYNC.matchId) return;
      if(flip){ await poke(api); } else { await pull(); }
      flip = !flip;
    }, SYNC.pollMs);
  }
  function stopSyncLoop(){ if(SYNC.timer){ clearInterval(SYNC.timer); SYNC.timer=null; } }

  // helper to pass token on local calls (reuses mp client global pattern)
  function withTok(p){
    const base = (window.__MP_BASE__ || '/izza-game/api/mp');
    const TOK  = (window.__IZZA_T__ || '').toString();
    const url  = base + p;
    return TOK ? url + (url.includes('?')?'&':'?') + 't=' + encodeURIComponent(TOK) : url;
  }

  function beginDuel(payload){
    try{
      const {mode, matchId, players} = payload || {};
      if(mode!=='v1' || !Array.isArray(players) || players.length<2) return;
      const api = IZZA.api;
      if(!api?.ready) return;

      const tier = localStorage.getItem('izzaMapTier') || '2';
      const axisTB = chooseAxis(String(matchId));
      const assign = sideAssignment(String(matchId), players);
      const meU = norm(api.user?.username);
      const amLeftOrTop = (meU === assign.leftTop);

      const mySpawn  = edgeSpawn(api, tier, axisTB, amLeftOrTop, String(matchId));
      const oppSpawn = edgeSpawn(api, tier, axisTB, !amLeftOrTop, String(matchId));

      // Teleport me into the shared map (Tier 2 already unlocked)
      api.player.x = mySpawn.x;
      api.player.y = mySpawn.y;
      api.player.facing = mySpawn.facing || 'down';
      api.setWanted?.(0);

      // Seed opponent position immediately so they are visible even before first pull
      const oppName = players.find(p => norm(p.username)!==meU)?.username || 'Opponent';
      OPP.active = true; OPP.name = oppName;
      OPP.x = oppSpawn.x; OPP.y = oppSpawn.y; OPP.facing = oppSpawn.facing || 'up';

      window.__IZZA_DUEL = { active:true, mode, matchId, axisTB, leftTop:assign.leftTop, rightBottom:assign.rightBottom };

      // Start REST sync loop
      SYNC.matchId = String(matchId);
      SYNC.meName  = api.user?.username || 'player';
      startSyncLoop(api);

      showCountdown(3);
      IZZA.emit?.('toast',{text:`1v1 vs ${oppName} — good luck!`});
    }catch(e){
      console.warn('[PvP duel] failed to start', e);
    }
  }

  IZZA.on?.('mp-start', beginDuel);
  IZZA.on?.('mp-end', ()=>{ OPP.active=false; stopSyncLoop(); window.__IZZA_DUEL={active:false}; });

  IZZA.on?.('render-post', ()=>{ try{ const api=IZZA.api; if(api?.ready) drawOpponent(api);}catch{} });

  // In case the start payload was queued before this plugin loaded
  if(window.__MP_START_PENDING){ const p=window.__MP_START_PENDING; delete window.__MP_START_PENDING; beginDuel(p); }
})();
