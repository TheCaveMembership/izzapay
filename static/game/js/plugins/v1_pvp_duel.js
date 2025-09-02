// PvP Duel bootstrap — v1.0
// Spawns players at randomized opposite edges on mp-start
(function(){
  const BUILD='v1.0-pvp-duel-opposite-edges';
  console.log('[IZZA PLAY]', BUILD);

  // ---- helpers ----
  function randFromHash(str, salt){
    // simple deterministic 0..1 based on string + salt
    let h = 2166136261 >>> 0;
    const s = (str + '|' + (salt||'')).toString();
    for(let i=0;i<s.length;i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    // xorshift
    h ^= h << 13; h ^= h >>> 17; h ^= h << 5;
    return ((h>>>0) % 100000) / 100000;
  }

  function unlockedRect(tier){
    // Mirror your other plugins; Tier 2 duel happens here by default
    return (tier==='2') ? { x0:10, y0:12, x1:80, y1:50 }
                        : { x0:18, y0:18, x1:72, y1:42 };
  }

  function chooseAxis(matchId){
    // 50/50: false => Left/Right, true => Top/Bottom
    return randFromHash(matchId,'axis') >= 0.5;
  }

  function sideAssignment(matchId, players){
    // players: [{username}, ...] — we only care about first two for v1
    // Randomize which username gets which side each match (but deterministic per matchId)
    const a = players[0].username;
    const b = players[1].username;
    // lexicographic order baseline, then flip by hash
    const sorted = [a,b].sort();
    const flip = randFromHash(matchId,'flip') >= 0.5; // flip about half the time
    const leftTop = flip ? sorted[1] : sorted[0];
    const rightBottom = flip ? sorted[0] : sorted[1];
    return { leftTop, rightBottom };
  }

  function edgeSpawn(api, tier, axisTopBottom, isLeftOrTop, matchId){
    const un = unlockedRect(tier);
    const t  = api.TILE;

    // random offset along the edge, leaving a small margin
    const margin = 2;
    if(axisTopBottom){
      // Top/Bottom edges: x varies, y fixed
      const minX = un.x0 + margin, maxX = un.x1 - margin;
      const span = maxX - minX;
      const r    = randFromHash(matchId, (isLeftOrTop?'top':'bottom') + '|off');
      const gx   = Math.floor(minX + r*span);
      const gy   = isLeftOrTop ? un.y0 + margin : un.y1 - margin;
      return { x: gx*t, y: gy*t, facing: isLeftOrTop ? 'down' : 'up' };
    }else{
      // Left/Right edges: y varies, x fixed
      const minY = un.y0 + margin, maxY = un.y1 - margin;
      const span = maxY - minY;
      const r    = randFromHash(matchId, (isLeftOrTop?'left':'right') + '|off');
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

      // Only handle 1v1 (v1) here. Other modes can reuse this approach.
      if(mode!=='v1'){ return; }

      const tier = localStorage.getItem('izzaMapTier') || '2';
      const axisTB = chooseAxis(matchId); // true = top/bottom, false = left/right
      const assign = sideAssignment(matchId, players);
      const meU = api.user?.username || 'player';

      // Decide which side this client gets
      const amLeftOrTop = (meU === assign.leftTop);
      const spawn = edgeSpawn(api, tier, axisTB, amLeftOrTop, matchId);

      // Teleport + face
      api.player.x = spawn.x;
      api.player.y = spawn.y;
      api.player.facing = spawn.facing || 'down';

      // Optional: reset wanted level for a clean duel start
      api.setWanted?.(0);

      // Flag a simple “duel active” state (if other plugins want to check)
      window.__IZZA_DUEL = { active:true, mode, matchId, axisTB, leftTop:assign.leftTop, rightBottom:assign.rightBottom };

      // Small countdown overlay
      showCountdown(3);

      // Friendly note
      IZZA.emit?.('toast',{text:`1v1 vs ${players.find(p=>p.username!==meU)?.username || 'opponent'} — good luck!`});
    }catch(e){
      console.warn('[PvP duel] failed to start', e);
    }
  });

  // Optional: if you later need to clear duel state on your own event
  IZZA.on?.('mp-end', ()=>{
    window.__IZZA_DUEL = { active:false };
  });

})();
