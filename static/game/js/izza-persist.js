(function(){
  const API_BASE = (window.IZZA_PERSIST_BASE || '').replace(/\/+$/,'') || ''; // e.g. '' if same host, or 'https://yourservice.onrender.com'
  function uname(){ return (IZZA?.api?.user?.username || 'guest').toString().replace(/^@+/,'').toLowerCase(); }
  function heartsMax(){ const p=IZZA.api?.player||{}; return p.maxHearts||p.heartsMax||3; }
  function getHeartSegs(){
    // your HUD code uses localStorage('izzaCurHeartSegments') if not on player obj
    const p=IZZA.api?.player||{};
    if(typeof p.heartSegs==='number') return p.heartSegs|0;
    const max = heartsMax()*3;
    const raw = parseInt(localStorage.getItem('izzaCurHeartSegments') || String(max), 10);
    return isNaN(raw) ? max : Math.max(0, Math.min(max, raw|0));
  }

  async function loadPlayerState(){
    const u = uname();
    const r = await fetch(`${API_BASE}/api/state/${encodeURIComponent(u)}`);
    const s = await r.json();

    // coins
    if(typeof s.coins === 'number' && IZZA.api?.setCoins) IZZA.api.setCoins(s.coins|0);

    // inventory
    if(IZZA.api?.setInventory && s.inventory) IZZA.api.setInventory(s.inventory);

    // bank (mirror into your localStorage-based bank so UI keeps working)
    const bankKey = 'izzaBank_'+u;
    if(s.bank) localStorage.setItem(bankKey, JSON.stringify(s.bank));

    // position
    if(IZZA.api?.player && typeof s.player?.x === 'number' && typeof s.player?.y === 'number'){
      IZZA.api.player.x = s.player.x|0;
      IZZA.api.player.y = s.player.y|0;
    }

    // hearts
    if(typeof s.player?.heartsSegs === 'number'){
      localStorage.setItem('izzaCurHeartSegments', String(s.player.heartsSegs|0));
      // if your HUD redraw function is exposed:
      if(typeof window._redrawHeartsHud === 'function') window._redrawHeartsHud();
    }
  }

  function collectPlayerState(){
    const u = uname();
    const bankKey = 'izzaBank_'+u;
    let bank = { coins:0, items:{}, ammo:{} };
    try{ bank = JSON.parse(localStorage.getItem(bankKey) || '{"coins":0,"items":{},"ammo":{}}'); }catch{}
    const inv = (IZZA.api?.getInventory && IZZA.api.getInventory()) || {};
    const coins = (IZZA.api?.getCoins && IZZA.api.getCoins()) || 0;
    const p = IZZA.api?.player||{x:0,y:0};
    const heartsSegs = getHeartSegs();
    return {
      version: 1,
      player: { x: (p.x|0), y: (p.y|0), heartsSegs },
      coins: coins|0,
      inventory: inv,
      bank,
      timestamp: Date.now()
    };
  }

  let _saveTimer=null;
  async function savePlayerState(){
    try{
      const u = uname();
      const body = collectPlayerState();
      await fetch(`${API_BASE}/api/state/${encodeURIComponent(u)}`, {
        method: 'POST',
        headers: {'content-type':'application/json'},
        body: JSON.stringify(body)
      });
    }catch(e){ /* ignore transient errors */ }
  }

  function scheduleAutoSave(){
    if(_saveTimer) clearInterval(_saveTimer);
    _saveTimer = setInterval(savePlayerState, 15000); // every 15s
    window.addEventListener('beforeunload', ()=>{ navigator.sendBeacon?.(`${API_BASE}/api/state/${encodeURIComponent(uname())}`, JSON.stringify(collectPlayerState())); });
  }

  // Run when the game reports ready
  IZZA.on('ready', async ()=>{
    await loadPlayerState();
    scheduleAutoSave();

    // Also save after bank changes (hook: deposit/withdraw buttons mutate localStorage + inventory)
    window.addEventListener('izza-bank-changed', savePlayerState);
  });
})();
