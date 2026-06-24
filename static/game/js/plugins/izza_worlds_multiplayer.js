/* izza_worlds_multiplayer.js — safe world selector for real MP API */
(function(){
  if(!window.IZZA || !IZZA.api){ return; }

  const KEY = 'izzaWorldId';
  const WORLDS = ['solo','1','2','3','4'];
  const MP_BASE = window.__MP_BASE__ || '/izza-game/api/mp';

  let world = localStorage.getItem(KEY) || 'solo';
  if(!WORLDS.includes(world)) world = 'solo';
  localStorage.setItem(KEY, world);

  function label(w){
    return w === 'solo' ? 'Solo' : `World ${w}`;
  }

  async function joinWorld(w){
    if(w === 'solo') return { ok:true, world:'solo' };

    try{
      const r = await fetch(`${MP_BASE}/world/join`, {
        method:'POST',
        credentials:'include',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({ world:w, worldId:w })
      });
      return await r.json().catch(()=>({ ok:false }));
    }catch{
      return { ok:false };
    }
  }

  function ensureChip(){
    let el = document.getElementById('worldChip');
    if(!el){
      el = document.createElement('button');
      el.id='worldChip';
      el.className='ghost';
      Object.assign(el.style,{
        position:'fixed',
        left:'12px',
        top:'24px',
        zIndex:9999,
        background:'rgba(10,12,18,.82)',
        border:'1px solid #394769',
        color:'#cfe0ff',
        padding:'4px 8px',
        borderRadius:'8px',
        fontSize:'12px'
      });
      document.body.appendChild(el);
      el.addEventListener('click', cycleWorld);
    }
    el.textContent = label(world);
  }

  async function setWorld(next){
    if(!WORLDS.includes(next)) next = 'solo';

    const old = world;
    world = next;
    localStorage.setItem(KEY, world);
    ensureChip();

    const res = await joinWorld(world);
    if(world !== 'solo' && !res.ok){
      world = old;
      localStorage.setItem(KEY, old);
      ensureChip();
      try{ IZZA.emit?.('toast', { text:'Could not join world. Try again.' }); }catch{}
      return false;
    }

    try{ IZZA.api.worldId = world; }catch{}
    try{ IZZA.emit?.('world-changed', { world }); }catch{}
    try{ window.dispatchEvent(new CustomEvent('izza-world-changed', { detail:{ world } })); }catch{}

    return true;
  }

  function cycleWorld(){
    const i = WORLDS.indexOf(world);
    const next = WORLDS[(i + 1) % WORLDS.length];
    setWorld(next);
  }

  ensureChip();

  IZZA.worlds = {
    getShard:()=>world,
    getWorld:()=>world,
    setWorld
  };

  try{ IZZA.api.worldId = world; }catch{}
})();
