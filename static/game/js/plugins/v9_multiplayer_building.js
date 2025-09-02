
(function(){
  const BUILD='v1.2-mp-building+off-road+pi-friends';
  console.log('[IZZA PLAY]', BUILD);

  const M3_KEY='izzaMission3';       // must be done to show the building
  const TIER_KEY='izzaMapTier';      // used in case someone jumps straight to T2

  // ---- simple geometry helpers (tier1-style bounds reused for tier2) ----
  function unlockedRect(tier){
    // same shapes you’ve been using elsewhere
    return (tier==='2')
      ? { x0:10, y0:12, x1:80, y1:50 }
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
    return {un, bX, bY, bW, bH, hRoadY, vRoadX};
  }

  // ---- multiplayer building placement (bottom-left, nudged UP off road) ----
  // original portal sat too low; lift it ~3 tiles (and a bit left of center)
  function buildingSpot(api){
    const a = anchors(api);
    // bottom-left-ish area inside unlocked rect:
    const gx = a.un.x0 + 7;          // a little in from the left edge
    const gy = a.un.y1 - 11;         // lifted upward so it clears the road/sidewalk
    return {gx, gy};
  }

  // ---- state / locals ----
  let api=null;
  let open=false;            // modal visible?
  let near=false;            // player in “B” range?
  let lastNear=false;

  // Local friend/ratings storage (front-end placeholder until backend is wired)
  const RANK_KEY='izzaMpRanks';
  const FRIENDS_KEY='izzaFriends';
  function loadRanks(){
    try{ return JSON.parse(localStorage.getItem(RANK_KEY)) || {br10:{w:0,l:0},v1:{w:0,l:0},v2:{w:0,l:0},v3:{w:0,l:0}}; }catch{ return {br10:{w:0,l:0},v1:{w:0,l:0},v2:{w:0,l:0},v3:{w:0,l:0}}; }
  }
  function saveRanks(r){ try{ localStorage.setItem(RANK_KEY, JSON.stringify(r)); }catch{} }

  // Seed friends once (purely illustrative — real list will come from your server)
  function seedFriends(){
    try{
      const cur = JSON.parse(localStorage.getItem(FRIENDS_KEY) || 'null');
      if(cur) return cur;
      const seeded = [
        {username:'Alex', active:true,  sample:true},
        {username:'Zoe',  active:false, sample:true},
        {username:'Rin',  active:true,  sample:true},
      ];
      localStorage.setItem(FRIENDS_KEY, JSON.stringify(seeded));
      return seeded;
    }catch{ return []; }
  }
  function getFriends(){ try{ return JSON.parse(localStorage.getItem(FRIENDS_KEY)) || seedFriends(); }catch{ return seedFriends(); } }
  function setFriends(list){ try{ localStorage.setItem(FRIENDS_KEY, JSON.stringify(list)); }catch{} }

  // ---- ui bits ----
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
      <div style="background:#0f1625;border:1px solid #2a3550;border-radius:14px;
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
               style="width:100%; margin-top:8px; padding:10px; border-radius:10px;
                      background:#0c1422; border:1px solid #2a3550; color:#cfe0ff">

        <div id="mpFriends" style="margin-top:10px; display:flex; flex-direction:column; gap:10px"></div>

        <div style="display:flex; justify-content:flex-end; margin-top:16px">
          <button id="mpClose" class="mp-small">Close</button>
        </div>
      </div>
    `;

    // common pill styles
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

    document.body.appendChild(host);
    return host;
  }

  function piUsername(){
    // Your auth flow puts identity in session; in the client we cache just the username
    // (If you already inject it on window.__PI, use that instead)
    try{
      const p = JSON.parse(localStorage.getItem('piAuthUser')||'null');
      return p && p.username || (window.__PI_USER && __PI_USER.username) || IZZA?.api?.user?.username || 'player';
    }catch{ return 'player'; }
  }

  function inviteLink(){
    const u = encodeURIComponent(piUsername());
    const code = Math.random().toString(36).slice(2,10);
    // This hits your existing auth + create flow; server can record inviter/acceptor
    return `${location.origin}/auth.html?src=invite&from=${u}&code=${code}`;
  }

  function renderFriends(filter=''){
    const host = ensureModal().querySelector('#mpFriends');
    const f = getFriends().filter(x=> !filter || (x.username.toLowerCase().includes(filter.toLowerCase())));
    host.innerHTML='';
    f.forEach(fr=>{
      const row=document.createElement('div'); row.className='friend';
      row.innerHTML=`
        <div>
          <div>${fr.username} ${fr.sample?'<span class="meta">(sample)</span>':''}</div>
          <div class="meta ${fr.active?'active':'offline'}">${fr.active?'Active':'Offline'}</div>
        </div>
        <button class="mp-small" data-u="${fr.username}">Invite</button>
      `;
      row.querySelector('button').addEventListener('click', ()=>{
        // In production: call backend to send a push/notification to that username.
        IZZA.emit?.('toast',{text:`Invite sent to ${fr.username}`});
      });
      host.appendChild(row);
    });
  }

  function showModal(){
    const host=ensureModal();
    host.style.display='flex'; open=true;
    // ranks
    const r=loadRanks();
    const set=(id,val)=>{ const el=host.querySelector(id); if(el) el.querySelector('span').textContent=`${val.w}W / ${val.l}L`; };
    set('#r-br10', r.br10); set('#r-v1', r.v1); set('#r-v2', r.v2); set('#r-v3', r.v3);

    // wire buttons
    host.querySelectorAll('.mp-btn').forEach(b=>{
      b.onclick=()=>{
        const mode=b.getAttribute('data-mode');
        const nice = mode==='br10'?'Battle Royale (10)': mode==='v1'?'1v1': mode==='v2'?'2v2':'3v3';
        host.querySelector('#mpQueueMsg').textContent = `Queued for ${nice}… (waiting for match)`;
        // You’ll swap this for a websocket/HTTP call to your matchmaking
        setTimeout(()=>{ IZZA.emit?.('toast',{text:`Match found for ${nice}!`}); host.style.display='none'; open=false; }, 1200);
      };
    });

    // copy invite
    host.querySelector('#mpCopyLink').onclick=async ()=>{
      const link=inviteLink();
      try{ await navigator.clipboard.writeText(link); IZZA.emit?.('toast',{text:'Invite link copied'}); }
      catch{ prompt('Copy link:', link); }
    };

    host.querySelector('#mpClose').onclick=()=>{ host.style.display='none'; open=false; };

    // search
    const search=host.querySelector('#mpSearch');
    search.oninput=()=> renderFriends(search.value);

    renderFriends('');
  }

  function hideModal(){ const host=document.getElementById('mpLobby'); if(host){ host.style.display='none'; } open=false; }

  // ---- draw building (door glows blue, turns green when in range) ----
  function w2sX(api,wx){ return (wx - api.camera.x) * (api.DRAW/api.TILE); }
  function w2sY(api,wy){ return (wy - api.camera.y) * (api.DRAW/api.TILE); }

  function drawBuilding(){
    if(!api?.ready) return;
    if(localStorage.getItem(M3_KEY)!=='done') return;

    const t=api.TILE, S=api.DRAW, ctx=document.getElementById('game').getContext('2d');
    const spot=buildingSpot(api);
    const sx=w2sX(api, spot.gx*t), sy=w2sY(api, spot.gy*t);

    ctx.save();
    // body of building (a small dark block)
    ctx.fillStyle='#18243b';
    ctx.fillRect(sx-S*0.2, sy-S*0.9, S*1.4, S*1.2);

    // door slab position (centered) — glow depending on range
    const doorX = sx + S*0.40, doorY = sy - S*0.06;
    ctx.fillStyle = near ? 'rgba(60,200,110,0.9)' : 'rgba(60,140,255,0.9)';
    ctx.fillRect(doorX, doorY, S*0.20, S*0.12);

    // label
    ctx.fillStyle='#b7d0ff';
    ctx.font = '12px monospace';
    ctx.fillText('MULTIPLAYER', sx+S*0.14, sy-S*0.68);
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

  // ---- input: B to open even with UI up ----
  function onB(e){
    if(localStorage.getItem(M3_KEY)!=='done') return;
    if(!inRange()) return;
    showModal();
    e?.preventDefault?.(); e?.stopPropagation?.(); e?.stopImmediatePropagation?.();
  }

  // ---- hooks ----
  IZZA.on('ready', (a)=>{
    api=a;
    // B capture so it works over inventory/map, like your driving code
    window.addEventListener('keydown', e=>{ if((e.key||'').toLowerCase()==='b') onB(e); }, {capture:true, passive:true});
    const btnB=document.getElementById('btnB'); btnB && btnB.addEventListener('click', onB, true);
  });

  IZZA.on('update-post', ()=>{
    if(!api?.ready) return;
    if(localStorage.getItem(M3_KEY)!=='done') return;
    lastNear = near;
    near = inRange();
  });

  IZZA.on('render-post', ()=> drawBuilding());

})();
