/**
 * IZZA Multiplayer Client — v1.6-lite
 * Keep B-to-open behavior intact. Only add:
 *  - token passthrough (?t=) for every request
 *  - search against /players/search
 */
(function(){
  const CFG = {
    base: (window.__MP_BASE__ || '/izza-game/api/mp'),
    ws:   (window.__MP_WS__   || '/izza-game/api/mp/ws'),
    searchDebounceMs: 250,
    minChars: 2,
  };

  function withT(url){
    const t = (window.__IZZA_T__ || '').toString().trim();
    return t ? url + (url.includes('?') ? '&' : '?') + 't=' + encodeURIComponent(t) : url;
  }

  async function jget(path){
    const r = await fetch(withT(CFG.base+path), {credentials:'include'});
    if(!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.json();
  }
  async function jpost(path, body){
    const r = await fetch(withT(CFG.base+path), {
      method:'POST', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify(body||{})
    });
    if(!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.json();
  }
  const debounced=(fn,ms)=>{ let t=null,a=null; return (...args)=>{a=args; clearTimeout(t); t=setTimeout(()=>fn(...a),ms);}};

  // ---- UI helpers (use elements injected by your working lobby) ----
  function $(s,r=document){ return r.querySelector(s); }
  function paintFriends(list){
    const host = $('#mpFriends'); if(!host) return;
    host.innerHTML='';
    if(!list || !list.length){
      const empty=document.createElement('div');
      empty.className='meta'; empty.style.opacity='.8';
      empty.textContent='Player not found — invite user to join IZZA GAME';
      host.appendChild(empty);
      return;
    }
    for(const u of list){
      const row=document.createElement('div');
      row.className='friend';
      row.innerHTML=`<div><div>${u.username}</div><div class="meta">${u.active?'Active':'Offline'}</div></div>
      <div><button class="mp-small" data-invite="${u.username}">Invite</button></div>`;
      row.querySelector('[data-invite]').addEventListener('click', async ()=>{
        try{ await jpost('/lobby/invite',{toUsername:u.username}); }catch(_){}
      });
      host.appendChild(row);
    }
  }

  // ---- data loaders ----
  let friends=[];
  async function loadFriends(){ try{ const r=await jget('/friends/list'); friends=r.friends||[]; }catch{} paintFriends(friends); }
  async function searchPlayers(q){
    if(!q || q.trim().length<CFG.minChars){ paintFriends(friends); return; }
    try{
      const r = await jget('/players/search?q='+encodeURIComponent(q.trim()));
      paintFriends((r.users||[]).map(u=>({username:u.username, active:!!u.active})));
    }catch{
      paintFriends([]);
    }
  }

  function wireSearch(){
    const input = $('#mpSearch'); if(!input) return;
    const run = debounced(()=>searchPlayers(input.value), CFG.searchDebounceMs);
    input.addEventListener('input', run);
  }

  async function start(){
    try{ await jget('/me'); }catch(e){ /* still allow lobby to open, just no friends */ }
    await loadFriends();
    wireSearch();
  }

  if(document.readyState==='complete' || document.readyState==='interactive') start();
  else addEventListener('DOMContentLoaded', start, {once:true});
})();
