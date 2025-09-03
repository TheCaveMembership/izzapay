<script>
// PvP Duel bootstrap — v1.1 (distinct + safe spawns)
(function(){
  const BUILD='v1.1-pvp-duel-opposite-edges-safe';
  console.log('[IZZA PLAY]', BUILD);

  // ---- helpers ----
  const normName = (s)=> (s||'').toString().trim().replace(/^@+/,'').toLowerCase();

  function randFromHash(str, salt){
    let h = 2166136261 >>> 0;
    const s = (str + '|' + (salt||'')).toString();
    for(let i=0;i<s.length;i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    h ^= h << 13; h ^= h >>> 17; h ^= h << 5;
    return ((h>>>0) % 100000) / 100000;
  }

  function unlockedRect(tier){
    // same regions you already use; duel prefers tier 2 when available
    return (tier==='2') ? { x0:10, y0:12, x1:80, y1:50 }
                        : { x0:18, y0:18, x1:72, y1:42 };
  }

  function chooseAxis(matchId){
    // 50/50 Top/Bottom vs Left/Right, deterministic per match
    return randFromHash(matchId,'axis') >= 0.5;
  }

  function sideAssignment(matchId, players){
    // Normalize names so both clients make the same decision
    const a = normName(players[0]?.username);
    const b = normName(players[1]?.username);
    const sorted = [a,b].sort();             // baseline order
    const flip = randFromHash(matchId,'flip') >= 0.5;
    const leftTop = flip ? sorted[1] : sorted[0];
    const rightBottom = flip ? sorted[0] : sorted[1];
    return { leftTop, rightBottom };
  }

  // Best-effort walkability check (works if engine exposes one; otherwise returns true)
  function isWalkable(api, gx, gy){
    // Try a few possible hooks the core might expose; fall back to true.
    try{
      if (api.isWalkable) return !!api.isWalkable(gx,gy);
      if (api.map?.isWalkable) return !!api.map.isWalkable(gx,gy);
      if (api.map?.walkable) return !!api.map.walkable(gx,gy);
      if (api.tileIsFree) return !!api.tileIsFree(gx,gy);
    }catch(e){}
    return true;
  }

  // Find a safe tile by nudging inward if needed
  function findSafeTile(api, gx, gy, stepX, stepY, maxSteps){
    let x=gx, y=gy;
    for(let i=0;i<=maxSteps;i++){
      if (isWalkable(api, x, y)) return {gx:x, gy:y};
      x += stepX; y += stepY;
    }
    return {gx:gx, gy:gy}; // fallback
  }

  function edgeSpawn(api, tier, axisTopBottom, isLeftOrTop, matchId){
    const un = unlockedRect(tier);
    const t  = api.TILE;

    // Larger margins to avoid water/impassables near borders
    const marginOuter = 8;            // keep off edges/water
    const marginInner = 6;            // where the search will end up at worst

    if(axisTopBottom){
      // Top/Bottom edges: x varies, y fixed close to edge but inside safe margin
      const minX = un.x0 + marginOuter, maxX = un.x1 - marginOuter;
      const span = Math.max(1, maxX - minX);
      const r    = randFromHash(matchId, (isLeftOrTop?'top':'bottom') + '|off');
      const gx0  = Math.floor(minX + r*span);
      const gy0  = isLeftOrTop ? (un.y0 + marginOuter) : (un.y1 - marginOuter);

      // Nudge inward (down from top, up from bottom) until walkable
      const stepY = isLeftOrTop ? +1 : -1;
      const safe  = findSafeTile(api, gx0, gy0, 0, stepY, marginOuter - marginInner);
      return { x: safe.gx*t, y: safe.gy*t, facing: isLeftOrTop ? 'down' : 'up' };
    }else{
      // Left/Right edges: y varies, x fixed close to edge but inside safe margin
      const minY = un.y0 + marginOuter, maxY = un.y1 - marginOuter;
      const span = Math.max(1, maxY - minY);
      const r    = randFromHash(matchId, (isLeftOrTop?'left':'right') + '|off');
      const gy0  = Math.floor(minY + r*span);
      const gx0  = isLeftOrTop ? (un.x0 + marginOuter) : (un.x1 - marginOuter);

      // Nudge inward (right from left, left from right) until walkable
      const stepX = isLeftOrTop ? +1 : -1;
      const safe  = findSafeTile(api, gx0, gy0, stepX, 0, marginOuter - marginInner);
      return { x: safe.gx*t, y: safe.gy*t, facing: isLeftOrTop ? 'right' : 'left' };
    }
  }

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

    let cur = n;
    label.textContent = 'Ready…';
    setTimeout(tick, 500);
    function tick(){
      if(cur>0){
        label.textContent = String(cur);
        cur--;
        setTimeout(tick, 800);
      }else{
        label.textContent = 'GO!';
        setTimeout(()=>{ host.remove(); }, 600);
      }
    }
  }

  // ---- main listener ----
  IZZA.on('mp-start', ({mode, matchId, players})=>{
    try{
      const api = IZZA.api;
      if(!api?.ready || !players || players.length<2) return;
      if(mode!=='v1') return; // this plugin only handles 1v1 spawns

      const tier = (localStorage.getItem('izzaMapTier') || '2');
      const axisTB = chooseAxis(matchId);          // true = top/bottom, false = left/right
      const assign = sideAssignment(matchId, players);
      const meU = normName(api.user?.username);

      // Decide sides deterministically; opposite edges guaranteed
      const amLeftOrTop = (meU === assign.leftTop);
      const spawn = edgeSpawn(api, tier, axisTB, amLeftOrTop, matchId);

      // Teleport + face
      api.player.x = spawn.x;
      api.player.y = spawn.y;
      api.player.facing = spawn.facing || 'down';

      // Tidy start
      api.setWanted?.(0);
      IZZA.emit?.('toast',{text:`1v1 vs ${(players.find(p=>normName(p.username)!==meU)||{}).username || 'opponent'}`});

      // Optional: center camera in case two clients spawned far apart
      if (api.camera) {
        api.camera.x = Math.max(0, api.player.x - api.DRAW/2);
        api.camera.y = Math.max(0, api.player.y - api.DRAW/2);
      }

      showCountdown(3);
      window.__IZZA_DUEL = { active:true, mode, matchId, axisTB,
        leftTop:assign.leftTop, rightBottom:assign.rightBottom };
    }catch(e){
      console.warn('[PvP duel] failed to start', e);
    }
  });

  IZZA.on?.('mp-end', ()=>{ window.__IZZA_DUEL = { active:false }; });
})();
</script>
