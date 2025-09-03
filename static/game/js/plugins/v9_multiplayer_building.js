// Multiplayer Building & Lobby — v1.6.5 (adds Search button + status text)
(function(){
  const BUILD='v1.6.5-mp-building';
  console.log('[IZZA PLAY]', BUILD);

  const M3_KEY='izzaMission3';
  const TIER_KEY='izzaMapTier';

  function unlockedRect(tier){ return (tier==='2')?{x0:10,y0:12,x1:80,y1:50}:{x0:18,y0:18,x1:72,y1:42}; }
  function anchors(api){
    const tier=localStorage.getItem(TIER_KEY)||'1', un=unlockedRect(tier), bW=10,bH=6;
    const bX=((un.x0+un.x1)/2|0)-(bW/2|0), bY=un.y0+5, hRoadY=bY+bH+1, vRoadX=Math.min(un.x1-3,bX+bW+6);
    return {un,bX,bY,bW,bH,hRoadY,vRoadX};
  }
  function buildingSpot(api){ const a=anchors(api); return {gx:a.un.x0+7, gy:a.un.y1-11}; }

  let api=null, open=false, near=false;

  function ensureModal(){
    let host=document.getElementById('mpLobby');
    if(host) return host;

    host=document.createElement('div');
    host.id='mpLobby';
    Object.assign(host.style,{
      position:'fixed', inset:'0', display:'none',
      alignItems:'center', justifyContent:'center',
      background:'rgba(0,0,0,.35)', zIndex:1003
    });
    host.innerHTML=`
      <div id="mpCard" style="background:#0f1625;border:1px solid #2a3550;border-radius:14px;width:min(92vw,640px);padding:16px;color:#cfe0ff;max-height:86vh;overflow:auto;position:relative;z-index:1004">
        <div style="font-size:18px;font-weight:700;margin-bottom:8px">Play Modes</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <button class="mp-btn" data-mode="br10">Battle Royale (10)</button>
          <button class="mp-btn" data-mode="v1">1 vs 1</button>
          <button class="mp-btn" data-mode="v2">2 vs 2</button>
          <button class="mp-btn" data-mode="v3">3 vs 3</button>
        </div>
        <div id="mpQueueMsg" style="opacity:.75;margin-top:10px"></div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:14px">
          <div class="rank pill" id="r-br10">BR10 <span>0W / 0L</span></div>
          <div class="rank pill" id="r-v1">1V1 <span>0W / 0L</span></div>
          <div class="rank pill" id="r-v2">2V2 <span>0W / 0L</span></div>
          <div class="rank pill" id="r-v3">3V3 <span>0W / 0L</span></div>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-top:16px">
          <div style="font-weight:700">Friends</div>
          <button id="mpCopyLink" class="mp-small">Copy Invite Link</button>
        </div>

        <div style="display:flex;gap:8px;align-items:center;margin-top:8px">
          <input id="mpSearch" placeholder="Search players…" autocomplete="off" spellcheck="false" inputmode="text"
                 style="flex:1;padding:10px;border-radius:10px;background:#0c1422;border:1px solid #2a3550;color:#cfe0ff">
          <button id="mpSearchBtn" class="mp-small" type="button">Search</button>
        </div>
        <div id="mpSearchStatus" style="margin-top:6px;opacity:.75;font-size:12px">Type a name and press Search or Return</div>

        <div id="mpFriends" style="margin-top:10px;display:flex;flex-direction:column;gap:10px"></div>
        <div style="display:flex;justify-content:flex-end;margin-top:16px">
          <button id="mpClose" class="mp-small">Close</button>
        </div>
      </div>`;

    const style=document.createElement('style');
    style.textContent=`
      #mpLobby .mp-btn{padding:12px 10px;border-radius:12px;background:#1a2340;color:#cfe0ff;border:1px solid #2a3550;font-weight:700;}
      #mpLobby .mp-btn:active{transform:translateY(1px);}
      #mpLobby .mp-small{padding:8px 10px;border-radius:10px;background:#101827;color:#cfe0ff;border:1px solid #2a3550;}
      #mpLobby .pill{padding:8px 10px;border-radius:10px;background:#101827;border:1px solid #2a3550;display:inline-flex;gap:8px;}
      #mpLobby .friend{background:#0f1625;border:1px solid #2a3550;border-radius:12px;padding:10px;display:flex;align-items:center;justify-content:space-between;}
      #mpLobby .meta{opacity:.8;font-size:12px}
      #mpLobby .active::before{content:'• ';color:#6cf08a}
      #mpLobby .offline::before{content:'• ';color:#7a889f}`;
    document.head.appendChild(style);

    // close handlers
    host.addEventListener('click', function(e){ if(e.target===host) hideModal(); }, {passive:true});
    const btnClose = host.querySelector('#mpClose');
    if(btnClose) btnClose.addEventListener('click', hideModal, {passive:true});

    // simple visual queue text
    host.querySelectorAll('.mp-btn').forEach(function(b){
      b.addEventListener('click', function(){
        var m=b.getAttribute('data-mode');
        var nice=m==='br10'?'Battle Royale (10)': m==='v1'?'1v1': m==='v2'?'2v2':'3v3';
        var msgEl = host.querySelector('#mpQueueMsg');
        if(msgEl) msgEl.textContent='Queued for '+nice+'… (waiting for match)';
      }, {passive:true});
    });

    var copyBtn = host.querySelector('#mpCopyLink');
    if(copyBtn){
      copyBtn.addEventListener('click', async function(){
        var link=location.origin+'/izza-game/auth?src=invite&from=' + encodeURIComponent((window.IZZA && IZZA.api && IZZA.api.user && IZZA.api.user.username) || 'player');
        try{ await navigator.clipboard.writeText(link); window.IZZA && IZZA.emit && IZZA.emit('toast',{text:'Invite link copied'}); }
        catch{ prompt('Copy link:', link); }
      });
    }

    document.body.appendChild(host);
    return host;
  }

  function showModal(){
    try{
      const host=ensureModal();
      host.style.display='flex';
      open=true;
      requestAnimationFrame(function(){
        window.IZZA && IZZA.emit && IZZA.emit('ui-modal-open', { id:'mpLobby' });
      });
    }catch(err){
      console.error('[mp] modal error:', err);
      open=false;
      window.IZZA && IZZA.emit && IZZA.emit('ui-modal-close', { id:'mpLobby' });
    }
  }
  function hideModal(){
    const host=document.getElementById('mpLobby');
    if(host) host.style.display='none';
    open=false;
    window.IZZA && IZZA.emit && IZZA.emit('ui-modal-close', { id:'mpLobby' });
  }

  // ---- draw building ----
  function w2sX(api,wx){ return (wx-api.camera.x)*(api.DRAW/api.TILE); }
  function w2sY(api,wy){ return (wy-api.camera.y)*(api.DRAW/api.TILE); }
  function drawBuilding(){
    if(!api||!api.ready) return;
    if(localStorage.getItem(M3_KEY)!=='done') return;
    const t=api.TILE,S=api.DRAW,ctx=document.getElementById('game').getContext('2d');
    const spot=buildingSpot(api), sx=w2sX(api,spot.gx*t), sy=w2sY(api,spot.gy*t);
    ctx.save();
    ctx.fillStyle='#18243b'; ctx.fillRect(sx - S*0.9, sy - S*0.95, S*2.1, S*1.25);
    const doorX=sx + S*0.10, doorY=sy - S*0.02;
    ctx.fillStyle = near ? 'rgba(60,200,110,0.9)' : 'rgba(60,140,255,0.9)';
    ctx.fillRect(doorX, doorY, S*0.22, S*0.14);
    ctx.fillStyle='#b7d0ff'; ctx.font='12px monospace'; ctx.fillText('MULTIPLAYER', sx - S*0.55, sy - S*0.70);
    ctx.restore();
  }
  function playerGrid(){ const t=api.TILE; return {gx:((api.player.x+t/2)/t|0), gy:((api.player.y+t/2)/t|0)}; }
  function manhattan(ax,ay,bx,by){ return Math.abs(ax-bx)+Math.abs(ay-by); }
  function inRange(){ const p=playerGrid(), s=buildingSpot(api); return manhattan(p.gx,p.gy,s.gx,s.gy)<=1; }

  function onB(e){
    if(localStorage.getItem(M3_KEY)!=='done') return;
    if(!inRange()) return;
    showModal();
    if(e){ e.preventDefault && e.preventDefault(); e.stopPropagation && e.stopPropagation(); e.stopImmediatePropagation && e.stopImmediatePropagation(); }
  }

  if(window.IZZA && IZZA.on){
    IZZA.on('ready', function(a){
      api=a;
      window.addEventListener('keydown', function(e){ if((e.key||'').toLowerCase()==='b') onB(e); }, {capture:true, passive:false});
      var btnB=document.getElementById('btnB'); if(btnB) btnB.addEventListener('click', onB, true);
    });
    IZZA.on('update-post', function(){ if(!api||!api.ready) return; if(localStorage.getItem(M3_KEY)!=='done') return; near=inRange(); });
    IZZA.on('render-post', function(){ drawBuilding(); });
  }
})();
