// Multiplayer Building & Lobby — v1.5 (wider west, close fix, B-capture, modal events)
(function(){
  const BUILD='v1.5-mp-building+wider-west+close-fix+modal-events';
  console.log('[IZZA PLAY]', BUILD);

  const M3_KEY='izzaMission3';
  const TIER_KEY='izzaMapTier';

  function unlockedRect(tier){
    return (tier==='2') ? { x0:10, y0:12, x1:80, y1:50 }
                        : { x0:18, y0:18, x1:72, y1:42 };
  }
  function anchors(api){
    const tier=localStorage.getItem(TIER_KEY)||'1';
    const un=unlockedRect(tier);
    const bW=10,bH=6;
    const bX = Math.floor((un.x0+un.x1)/2) - Math.floor(bW/2);
    const bY = un.y0 + 5;
    const hRoadY = bY + bH + 1;
    const vRoadX = Math.min(un.x1-3, bX + bW + 6);
    return {un,bX,bY,bW,bH,hRoadY,vRoadX};
  }

  // Position bottom-left, lifted up from road
  function buildingSpot(api){
    const a = anchors(api);
    const gx = a.un.x0 + 7;
    const gy = a.un.y1 - 11;
    return {gx, gy};
  }

  let api=null, open=false, near=false;

  // ---- modal ----
  function ensureModal(){
    let host=document.getElementById('mpLobby');
    if(host) return host;

    host=document.createElement('div');
    host.id='mpLobby';
    Object.assign(host.style,{
      position:'fixed', inset:'0', display:'none',
      alignItems:'center', justifyContent:'center',
      background:'rgba(0,0,0,.35)', zIndex:20
    });

    host.innerHTML = `
      <div id="mpCard" style="background:#0f1625;border:1px solid #2a3550;border-radius:14px;
                  width:min(92vw,640px); padding:16px; color:#cfe0ff; max-height:86vh; overflow:auto">
        <div style="font-size:18px; font-weight:700; margin-bottom:8px">Play Modes</div>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px">
          <button class="mp-btn" data-mode="br10">Battle Royale (10)</button>
          <button class="mp-btn" data-mode="v1">1 vs 1</button>
          <button class="mp-btn" data-mode="v2">2 vs 2</button>
          <button class="mp-btn" data-mode="v3">3 vs 3</button>
        </div>
        <div id="mpQueueMsg" style="opacity:.75; margin-top:10px"></div>

        <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:14px">
          <div class="rank pill" id="r-br10">BR10 <span>0W / 0L</span></div>
          <div class="rank pill" id="r-v1">1V1 <span>0W / 0L</span></div>
          <div class="rank pill" id="r-v2">2V2 <span>0W / 0L</span></div>
          <div class="rank pill" id="r-v3">3V3 <span>0W / 0L</span></div>
        </div>

        <div style="display:flex; align-items:center; justify-content:space-between; margin-top:16px">
          <div style="font-weight:700">Friends</div>
          <button id="mpCopyLink" class="mp-small">Copy Invite Link</button>
        </div>

        <input id="mpSearch" placeholder="Search friends…"
               autocomplete="off" spellcheck="false" inputmode="text"
               style="width:100%; margin-top:8px; padding:10px; border-radius:10px;
                      background:#0c1422; border:1px solid #2a3550; color:#cfe0ff">

        <div id="mpFriends" style="margin-top:10px; display:flex; flex-direction:column; gap:10px"></div>

        <div style="display:flex; justify-content:flex-end; margin-top:16px">
          <button id="mpClose" class="mp-small">Close</button>
        </div>
      </div>
    `;

    // styles
    const style=document.createElement('style');
    style.textContent=`
      #mpLobby .mp-btn{ padding:12px 10px; border-radius:12px; background:#1a2340; color:#cfe0ff;
                        border:1px solid #2a3550; font-weight:700; }
      #mpLobby .mp-btn:active{ transform:translateY(1px); }
      #mpLobby .mp-small{ padding:8px 10px; border-radius:10px; background:#101827; color:#cfe0ff; border:1px solid #2a3550; }
      #mpLobby .pill{ padding:8px 10px; border-radius:10px; background:#101827; border:1px solid #2a3550; display:inline-flex; gap:8px; }
      #mpLobby .friend{ background:#0f1625; border:1px solid #2a3550; border-radius:12px; padding:10px; display:flex; align-items:center; justify-content:space-between; }
      #mpLobby .meta{ opacity:.8; font-size:12px }
      #mpLobby .active::before{ content:'• '; color:#6cf08a }
      #mpLobby .offline::before{ content:'• '; color:#7a889f }
    `;
    document.head.appendChild(style);

    // close handlers
    host.addEventListener('click', (e)=>{ if(e.target===host) { hideModal(); } });
    host.querySelector('#mpClose').addEventListener('click', ()=> hideModal());

    // queue buttons (placeholder; real queue handled by mp client)
    host.querySelectorAll('.mp-btn').forEach(b=>{
      b.onclick=()=>{
        const mode=b.getAttribute('data-mode');
        const nice = mode==='br10'?'Battle Royale (10)': mode==='v1'?'1v1': mode==='v2'?'2v2':'3v3';
        host.querySelector('#mpQueueMsg').textContent = `Queued for ${nice}… (waiting for match)`;
      };
    });

    // copy invite (client may override with server-provided link)
    host.querySelector('#mpCopyLink').onclick=async ()=>{
      const link = `${location.origin}/auth.html?src=invite&from=${encodeURIComponent(IZZA?.api?.user?.username||'player')}&code=${Math.random().toString(36).slice(2,10)}`;
      try{ await navigator.clipboard.writeText(link); IZZA.emit?.('toast',{text:'Invite link copied'}); }
      catch{ prompt('Copy link:', link); }
    };

    // basic empty list; real list painted by mp client
    host.querySelector('#mpFriends').innerHTML = '';

    document.body.appendChild(host);
    return host;
  }

  function showModal(){
    const host=ensureModal();
    host.style.display='flex'; open=true;
    // Let other plugins (e.g., guns) know a modal opened so they can hide Fire
    window.IZZA?.emit?.('ui-modal-open', { id:'mpLobby' });
  }
  function hideModal(){
    const host=document.getElementById('mpLobby');
    if(host){ host.style.display='none'; }
    open=false;
    window.IZZA?.emit?.('ui-modal-close', { id:'mpLobby' });
  }

  // ---- building draw ----
  function w2sX(api,wx){ return (wx - api.camera.x) * (api.DRAW/api.TILE); }
  function w2sY(api,wy){ return (wy - api.camera.y) * (api.DRAW/api.TILE); }

  function drawBuilding(){
    if(!api?.ready) return;
    if(localStorage.getItem(M3_KEY)!=='done') return;

    const t=api.TILE, S=api.DRAW, ctx=document.getElementById('game').getContext('2d');
    const spot=buildingSpot(api);
    const sx=w2sX(api, spot.gx*t), sy=w2sY(api, spot.gy*t);

    ctx.save();
    // wider to the WEST
    ctx.fillStyle='#18243b';
    ctx.fillRect(sx - S*0.9, sy - S*0.95, S*2.1, S*1.25);

    // door
    const doorX = sx + S*0.10, doorY = sy - S*0.02;
    ctx.fillStyle = near ? 'rgba(60,200,110,0.9)' : 'rgba(60,140,255,0.9)';
    ctx.fillRect(doorX, doorY, S*0.22, S*0.14);

    // label
    ctx.fillStyle='#b7d0ff';
    ctx.font = '12px monospace';
    ctx.fillText('MULTIPLAYER', sx - S*0.55, sy - S*0.70);
    ctx.restore();
  }

  function playerGrid(){
    const t=api.TILE;
    return { gx: ((api.player.x+t/2)/t|0), gy: ((api.player.y+t/2)/t|0) };
  }
  function manhattan(ax,ay,bx,by){ return Math.abs(ax-bx)+Math.abs(ay-by); }
  function inRange(){
    const {gx,gy}=playerGrid();
    const s=buildingSpot(api);
    return manhattan(gx,gy, s.gx, s.gy) <= 1;
  }

  // ---- input ----
  function onB(e){
    if(localStorage.getItem(M3_KEY)!=='done') return;
    if(!inRange()) return;
    showModal();
    e?.preventDefault?.(); e?.stopPropagation?.(); e?.stopImmediatePropagation?.();
  }

  // ---- hooks ----
  IZZA.on('ready', (a)=>{
    api=a;
    window.addEventListener('keydown', e=>{ if((e.key||'').toLowerCase()==='b') onB(e); }, {capture:true, passive:true});
    const btnB=document.getElementById('btnB'); btnB && btnB.addEventListener('click', onB, true);
  });

  IZZA.on('update-post', ()=>{
    if(!api?.ready) return;
    if(localStorage.getItem(M3_KEY)!=='done') return;
    near = inRange();
  });

  IZZA.on('render-post', ()=> drawBuilding());
})();
