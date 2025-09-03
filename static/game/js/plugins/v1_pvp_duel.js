// PvP Duel bootstrap — v1.1
// Spawns players at opposite edges; consumes pending match payload if needed.
(function(){
  const BUILD='v1.1-pvp-duel-opposite-edges-pending-safe';
  console.log('[IZZA PLAY]', BUILD);

  // ---- helpers ----
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
  function chooseAxis(matchId){ return randFromHash(String(matchId),'axis') >= 0.5; }
  function sideAssignment(matchId, players){
    const a = players[0].username, b = players[1].username;
    const sorted = [a,b].sort();
    const flip = randFromHash(String(matchId),'flip') >= 0.5;
    const leftTop = flip ? sorted[1] : sorted[0];
    const rightBottom = flip ? sorted[0] : sorted[1];
    return { leftTop, rightBottom };
  }
  function edgeSpawn(api, tier, axisTopBottom, isLeftOrTop, matchId){
    const un = unlockedRect(tier);
    const t  = api.TILE;
    const margin = 2;
    if(axisTopBottom){
      const minX = un.x0 + margin, maxX = un.x1 - margin;
      const span = maxX - minX;
      const r    = randFromHash(String(matchId), (isLeftOrTop?'top':'bottom') + '|off');
      const gx   = Math.floor(minX + r*span);
      const gy   = isLeftOrTop ? un.y0 + margin : un.y1 - margin;
      return { x: gx*t, y: gy*t, facing: isLeftOrTop ? 'down' : 'up' };
    }else{
      const minY = un.y0 + margin, maxY = un.y1 - margin;
      const span = maxY - minY;
      const r    = randFromHash(String(matchId), (isLeftOrTop?'left':'right') + '|off');
      const gy   = Math.floor(minY + r*span);
      const gx   = isLeftOrTop ? un.x0 + margin : un.x1 - margin;
      return { x: gx*t, y: gy*t, facing: isLeftOrTop ? 'right' : 'left' };
    }
  }

  // ---- countdown HUD ----
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
      if(cur>0){ label.textContent = String(cur); cur--; setTimeout(tick, 800); }
      else{ label.textContent = 'GO!'; setTimeout(()=>{ host.remove(); }, 600); }
    }
  }

  function beginDuel(payload){
    try{
      const {mode, matchId, players} = payload || {};
      if(mode!=='v1' || !Array.isArray(players) || players.length<2) return;
      const api = IZZA.api;
      if(!api?.ready) return;

      const tier = localStorage.getItem('izzaMapTier') || '2';
      const axisTB = chooseAxis(matchId);
      const assign = sideAssignment(matchId, players);
      const meU = api.user?.username || 'player';
      const amLeftOrTop = (meU === assign.leftTop);
      const spawn = edgeSpawn(api, tier, axisTB, amLeftOrTop, matchId);

      // Teleport + face
      api.player.x = spawn.x;
      api.player.y = spawn.y;
      api.player.facing = spawn.facing || 'down';

      // Clean start
      api.setWanted?.(0);
      window.__IZZA_DUEL = { active:true, mode, matchId, axisTB, leftTop:assign.leftTop, rightBottom:assign.rightBottom };

      showCountdown(3);
      IZZA.emit?.('toast',{text:`1v1 vs ${players.find(p=>p.username!==meU)?.username || 'opponent'} — good luck!`});
    }catch(e){
      console.warn('[PvP duel] failed to start', e);
    }
  }

  // Fire when mp-start is emitted
  IZZA.on?.('mp-start', beginDuel);

  // Also consume any pending start that the client stashed before we were ready
  const drainPending = ()=>{
    if(window.__MP_START_PENDING){
      const p = window.__MP_START_PENDING; delete window.__MP_START_PENDING;
      beginDuel(p);
    }
  };
  if(IZZA.on){ IZZA.on('ready', drainPending); }
  // In case IZZA.ready has already fired before this plugin loaded:
  setTimeout(drainPending, 0);

  // Optional: reset flag if something ends the duel
  IZZA.on?.('mp-end', ()=>{ window.__IZZA_DUEL = { active:false }; });

})();
