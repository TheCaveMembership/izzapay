// Multiplayer Building (Tier 2) — v1.0
// A small glowing building at the bottom-left of Tier 2.
// Press B near the door to open the Multiplayer Lobby (BR 10, 3v3, 2v2, 1v1).
// Includes a friends list, invite links, and win/loss ranking.
// Backend hooks are stubbed as IZZA.emit(...) so you can wire your real services.
(function(){
  const BUILD = 'v1.0-mp-building+friends+lobby';
  console.log('[IZZA PLAY]', BUILD);

  const M3_KEY       = 'izzaMission3';
  const MAP_TIER_KEY = 'izzaMapTier';

  // --- map geometry helpers (matching your other plugins) ---
  function unlockedRectTier2(){ return {x0:10, y0:12, x1:80, y1:50}; }

  // Place building near bottom-left, just above the hood area.
  // Building footprint: 3×3 tiles; door is centered on north edge.
  const BUILDING = (()=> {
    const un = unlockedRectTier2();
    const w=3, h=3;
    const gx = un.x0 + 4;
    const gy = un.y1 - (h + 4);
    return {
      x0: gx, y0: gy, x1: gx + (w-1), y1: gy + (h-1),
      doorGX: gx + 1, doorGY: gy - 0  // “front” side (north edge) for the glow
    };
  })();

  // Interaction
  const INTERACT_R = 1; // Manhattan ≤ 1 from door
  let api=null;

  // --- simple state / storage ---
  // Ranking is stored per-mode in localStorage under izzaMP.rank
  // Friends are under izzaMP.friends: [{id,name,active}]
  // Invitations are share-links (stub) that contain a friend id.
  const LS_KEY = 'izzaMP';
  function readMP(){
    try{ return JSON.parse(localStorage.getItem(LS_KEY)||'{}'); }catch{ return {}; }
  }
  function writeMP(obj){
    try{ localStorage.setItem(LS_KEY, JSON.stringify(obj||{})); }catch{}
  }
  function getRank(mode){
    const mp=readMP(); const r = (mp.rank||{})[mode] || {w:0,l:0};
    return r;
  }
  function bumpRank(mode, win){
    const mp=readMP(); mp.rank=mp.rank||{};
    const r = mp.rank[mode] || {w:0,l:0};
    if(win) r.w++; else r.l++;
    mp.rank[mode]=r; writeMP(mp);
  }
  function getFriends(){
    const mp=readMP(); return mp.friends || [];
  }
  function setFriends(list){
    const mp=readMP(); mp.friends = list; writeMP(mp);
  }
  function addFriend(friend){
    const cur=getFriends(); if(!cur.find(f=>f.id===friend.id)){ cur.push(friend); setFriends(cur); }
  }

  // --- utils ---
  const t=()=> api.TILE;
  const S=()=> api.DRAW;
  const w2sX=wx=>(wx - api.camera.x) * (S()/t());
  const w2sY=wy=>(wy - api.camera.y) * (S()/t());
  function playerGrid(){
    return {
      gx: ((api.player.x + t()/2)/t())|0,
      gy: ((api.player.y + t()/2)/t())|0
    };
  }
  function nearDoor(){
    const {gx,gy} = playerGrid();
    return (Math.abs(gx - BUILDING.doorGX) + Math.abs(gy - BUILDING.doorGY)) <= INTERACT_R;
  }
  function m3Done(){
    try{
      if(localStorage.getItem(M3_KEY)==='done') return true;
      const ms = (api.getMissionCount&&api.getMissionCount())||0;
      return ms>=3;
    }catch{ return false; }
  }
  function tier2(){ return localStorage.getItem(MAP_TIER_KEY)==='2'; }

  // --- drawing ---
  function drawBuilding(){
    if(!m3Done() || !tier2()) return;
    const ctx = document.getElementById('game').getContext('2d');
    const S32 = S(); // 32 to screen scale
    const x0 = w2sX(BUILDING.x0*t()), y0 = w2sY(BUILDING.y0*t());
    const W  = (BUILDING.x1 - BUILDING.x0 + 1) * S32;
    const H  = (BUILDING.y1 - BUILDING.y0 + 1) * S32;

    // Body
    ctx.save();
    ctx.fillStyle = '#223046';
    ctx.fillRect(x0, y0, W, H);
    ctx.strokeStyle = '#2f3b58';
    ctx.lineWidth = 2;
    ctx.strokeRect(x0+1, y0+1, W-2, H-2);

    // Sign (top)
    ctx.fillStyle = '#0f1625';
    ctx.fillRect(x0 + S32*0.3, y0 + S32*0.15, W - S32*0.6, S32*0.5);
    ctx.font = 'bold 12px sans-serif';
    ctx.fillStyle = '#9fd6ff';
    ctx.textAlign='center';
    ctx.fillText('MULTIPLAYER', x0 + W/2, y0 + S32*0.48 + 4);

    // Door glow
    const doorSX = w2sX(BUILDING.doorGX*t()), doorSY = w2sY(BUILDING.doorGY*t());
    const pulse = 0.45 + 0.25*Math.sin(performance.now()/250);
    const inRange = nearDoor();
    ctx.fillStyle = inRange ? `rgba(80,255,120,${pulse})` : `rgba(70,160,255,${pulse})`;
    ctx.fillRect(doorSX + S32*0.12, doorSY + S32*0.10, S32*0.76, S32*0.80);
    ctx.restore();
  }

  // --- lobby modal ---
  function ensureLobby(){
    let host = document.getElementById('mpLobby');
    if(host) return host;

    host = document.createElement('div');
    host.id = 'mpLobby';
    host.className='backdrop';
    Object.assign(host.style,{
      position:'fixed', inset:'0', display:'none', alignItems:'center', justifyContent:'center',
      background:'rgba(0,0,0,.40)', zIndex: 30
    });

    host.innerHTML = `
      <div style="background:#0f1625; border:1px solid #2a3550; border-radius:14px; width:min(92vw, 880px); max-height:88vh; overflow:auto; padding:16px">
        <div style="display:flex; gap:14px; flex-wrap:wrap; align-items:stretch">
          <div style="flex:1 1 320px; min-width:320px">
            <div style="font-weight:700; font-size:16px; margin-bottom:8px">Play Modes</div>
            <div style="display:grid; grid-template-columns: repeat(2, minmax(140px,1fr)); gap:10px">
              <button class="mpQueue" data-mode="br10">Battle Royale (10)</button>
              <button class="mpQueue" data-mode="1v1">1 vs 1</button>
              <button class="mpQueue" data-mode="2v2">2 vs 2</button>
              <button class="mpQueue" data-mode="3v3">3 vs 3</button>
            </div>
            <div id="mpQueueState" style="margin-top:10px; font-size:12px; opacity:.85"></div>

            <div style="margin-top:14px">
              <div style="font-weight:700; font-size:14px; margin-bottom:6px">Your Rank</div>
              <div id="mpRanks" style="display:grid; grid-template-columns: repeat(4,1fr); gap:8px; font-size:12px"></div>
            </div>
          </div>

          <div style="flex:1 1 360px; min-width:320px">
            <div style="display:flex; align-items:center; justify-content:space-between; gap:8px">
              <div style="font-weight:700; font-size:16px">Friends</div>
              <div>
                <button id="mpInviteLink" class="ghost">Copy Invite Link</button>
              </div>
            </div>
            <div style="margin:8px 0">
              <input id="mpFriendSearch" type="text" placeholder="Search friends..." style="width:100%; padding:8px; border-radius:8px; border:1px solid #2a3550; background:#0b1220; color:#cfe0ff" />
            </div>
            <div id="mpFriends" style="display:flex; flex-direction:column; gap:6px; max-height:48vh; overflow:auto"></div>
          </div>
        </div>

        <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:14px">
          <button id="mpClose" class="ghost">Close</button>
        </div>
      </div>
    `;
    document.body.appendChild(host);

    // Styles for buttons quickly
    host.querySelectorAll('button').forEach(b=>{
      b.style.padding='10px 12px';
      b.style.background = b.classList.contains('ghost') ? '#101827' : '#1b2640';
      b.style.border='1px solid #2a3550';
      b.style.color='#cfe0ff';
      b.style.borderRadius='10px';
      b.style.fontWeight='700';
      b.style.cursor='pointer';
    });

    // Bind
    host.addEventListener('click', (e)=>{ if(e.target===host) host.style.display='none'; });
    host.querySelector('#mpClose').addEventListener('click', ()=> host.style.display='none');

    host.querySelectorAll('.mpQueue').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const mode = btn.getAttribute('data-mode');
        host.querySelector('#mpQueueState').textContent = `Queued for ${mode}… (waiting for match)`;
        // Backend hook (wire your real queue/matchmaking)
        IZZA.emit?.('mp-queue', { mode });
      });
    });

    host.querySelector('#mpInviteLink').addEventListener('click', async ()=>{
      // Generate a fake invite (use your PI-authorized user id, we stub a random one)
      const me = (readMP().me) || { id: localStorage.getItem('pi_uid') || ('pi_'+Math.random().toString(36).slice(2,9)), name: localStorage.getItem('pi_name') || 'You' };
      const link = `${location.origin}${location.pathname}#invite=${encodeURIComponent(me.id)}`;
      try{
        await navigator.clipboard.writeText(link);
        toast('Invite link copied!');
      }catch{
        prompt('Copy this invite link:', link);
      }
      IZZA.emit?.('mp-invite-link', { link });
    });

    // Friend search
    const q = host.querySelector('#mpFriendSearch');
    q.addEventListener('input', ()=> renderFriends(q.value||''));
    return host;
  }

  function toast(msg, seconds=2.2){
    let h=document.getElementById('tutHint');
    if(!h){ h=document.createElement('div'); h.id='tutHint';
      Object.assign(h.style,{position:'fixed', left:'12px', top:'64px', zIndex:40, background:'rgba(10,12,18,.88)', border:'1px solid #394769', color:'#cfe0ff', padding:'8px 10px', borderRadius:'10px', fontSize:'14px', maxWidth:'70vw'});
      document.body.appendChild(h);
    }
    h.textContent=msg; h.style.display='block';
    clearTimeout(h._t); h._t=setTimeout(()=>{ h.style.display='none'; }, seconds*1000);
  }

  // --- lobby rendering ---
  function renderRanks(){
    const host = document.querySelector('#mpRanks'); if(!host) return;
    const modes = ['br10','1v1','2v2','3v3'];
    host.innerHTML = '';
    modes.forEach(m=>{
      const r = getRank(m);
      const div = document.createElement('div');
      div.style.background='#0b1220';
      div.style.border='1px solid #2a3550';
      div.style.borderRadius='10px';
      div.style.padding='8px';
      div.innerHTML = `<div style="opacity:.8">${m.toUpperCase()}</div><div style="font-size:13px; margin-top:2px"><b>${r.w}</b>W / <b>${r.l}</b>L</div>`;
      host.appendChild(div);
    });
  }

  function renderFriends(filter){
    const list = document.querySelector('#mpFriends'); if(!list) return;
    const f = getFriends();
    const q = (filter||'').trim().toLowerCase();
    const show = f.filter(x=> !q || (x.name||'').toLowerCase().includes(q) || (x.id||'').toLowerCase().includes(q));
    list.innerHTML='';
    if(!show.length){
      const empty=document.createElement('div');
      empty.style.opacity='.8'; empty.textContent='No friends yet.';
      list.appendChild(empty); return;
    }
    show.forEach(fr=>{
      const row=document.createElement('div');
      row.style.display='flex'; row.style.alignItems='center'; row.style.justifyContent='space-between';
      row.style.gap='10px'; row.style.padding='8px'; row.style.background='#0b1220'; row.style.border='1px solid #2a3550'; row.style.borderRadius='10px';
      const left=document.createElement('div');
      left.innerHTML = `<div style="font-weight:700">${fr.name||fr.id}</div><div style="font-size:12px; opacity:.8">${fr.active?'● Active':'○ Offline'}</div>`;
      const btn=document.createElement('button');
      btn.textContent='Invite';
      Object.assign(btn.style,{padding:'6px 10px', background:'#1b2640', color:'#cfe0ff', border:'1px solid #2a3550', borderRadius:'8px', cursor:'pointer', fontWeight:'700'});
      btn.addEventListener('click', ()=>{
        IZZA.emit?.('mp-invite', { to: fr.id });
        toast(`Invited ${fr.name||fr.id}`);
      });
      row.appendChild(left); row.appendChild(btn);
      list.appendChild(row);
    });
  }

  function openLobby(){
    const host = ensureLobby();
    renderRanks();
    renderFriends('');
    host.style.display='flex';
  }

  // --- B to interact (even if inv/map open) ---
  function onB(e){
    if(!api?.ready || !m3Done() || !tier2()) return;
    if(!nearDoor()) return;
    // open lobby
    e?.preventDefault?.(); e?.stopPropagation?.(); e?.stopImmediatePropagation?.();
    openLobby();
  }

  // --- accept invites from link (fake friend-onboarding) ---
  function checkInviteHash(){
    try{
      const m = /#invite=([^&]+)/.exec(location.hash);
      if(!m) return;
      const friendId = decodeURIComponent(m[1]);
      // Add invited friend as “active” for demo; in real flow you’d resolve name via backend
      addFriend({ id: friendId, name: friendId, active: true });
      // clear hash
      history.replaceState(null, '', location.pathname + location.search);
      toast('Friend added from invite link.');
    }catch{}
  }

  // --- hooks ---
  IZZA.on('ready', (a)=>{
    api=a;
    checkInviteHash();

    // Key capture so B works even with other UI open
    window.addEventListener('keydown', (e)=>{ if((e.key||'').toLowerCase()==='b') onB(e); }, {capture:true, passive:false});
    const btnB=document.getElementById('btnB'); btnB && btnB.addEventListener('click', onB, true);

    // Provide an example of rank bump from outside (wire your match results to this)
    // Usage example somewhere else: IZZA.emit('mp-match-result', {mode:'1v1', win:true})
    IZZA.on?.('mp-match-result', ({mode,win})=>{
      if(!mode) return;
      bumpRank(mode, !!win);
      if(document.getElementById('mpLobby')?.style.display==='flex'){ renderRanks(); }
    });

    // Seed a fake "self" profile if missing (uses existing PI auth data if present)
    const mp=readMP();
    if(!mp.me){
      mp.me = {
        id: localStorage.getItem('pi_uid') || ('pi_'+Math.random().toString(36).slice(2,9)),
        name: localStorage.getItem('pi_name') || 'You'
      };
      writeMP(mp);
    }

    // Seed a couple example friends if empty
    if(getFriends().length===0){
      setFriends([
        {id:'pi_alex', name:'Alex', active:true},
        {id:'pi_zoe',  name:'Zoe',  active:false},
        {id:'pi_rin',  name:'Rin',  active:true}
      ]);
    }
  });

  IZZA.on('render-post', ()=>{
    if(!api?.ready) return;
    drawBuilding();
  });

})();
