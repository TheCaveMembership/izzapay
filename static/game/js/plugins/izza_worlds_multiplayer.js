/* izza_worlds_multiplayer.js — simple shard selector (no control/layout changes) */
(function(){
  if(!window.IZZA || !IZZA.api){ return; }
  const KEY = 'izzaWorldShard';
  let shard = localStorage.getItem(KEY) || '1';

  // UI: a tiny chip near the bootMsg (reuses its style, stays out of the way)
  function ensureChip(){
    let el = document.getElementById('worldChip');
    if(!el){
      el = document.createElement('button');
      el.id='worldChip';
      el.className='ghost';
      Object.assign(el.style,{
        position:'fixed', left:'12px', top:'24px', zIndex:9999,
        background:'rgba(10,12,18,.82)', border:'1px solid #394769',
        color:'#cfe0ff', padding:'4px 8px', borderRadius:'8px',
        fontSize:'12px'
      });
      document.body.appendChild(el);
      el.addEventListener('click', cycleShard);
    }
    el.textContent = `World: ${shard}`;
  }
  function cycleShard(){
    const n = (parseInt(shard,10)||1);
    shard = String(n % 5 + 1);           // cycles 1..5
    localStorage.setItem(KEY, shard);
    ensureChip();
    try{ (window.bootMsg||console.log)(`Switched to World ${shard}`); }catch{}
    // Optional: notify your presence service
    try{ fetch('/api/world/select', {method:'POST', credentials:'include', headers:{'Content-Type':'application/json'}, body:JSON.stringify({shard})}); }catch{}
  }

  ensureChip();

  // Expose for any realtime layer you wire later
  IZZA.worlds = { getShard:()=>shard };

  // Example: if you later hydrate other players, filter by shard on your server.
})();
