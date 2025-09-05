// v1_trade_centre.plugin.js — Safe-zone + proximity trade UI (additive only)
(function(){
  const FLAG = 'izzaTradeCentre';
  const isInTC = ()=> localStorage.getItem(FLAG)==='1';

  // --- tiny mp adapter (best-effort; works with your existing remote players API) ---
  const Net = (function(){
    const api = {};
    api.send = function(type, data){
      try{
        if (window.REMOTE_PLAYERS_API?.send) return window.REMOTE_PLAYERS_API.send(type, data);
        if (window.RemotePlayers?.send)      return window.RemotePlayers.send(type, data);
        if (window.IZZA?.emit)               return IZZA.emit('mp-send', {type, data});
      }catch(e){ console.warn('[TC] send failed', e); }
    };
    api.on = function(type, cb){
      try{
        if (window.REMOTE_PLAYERS_API?.on) return window.REMOTE_PLAYERS_API.on(type, cb);
        if (window.RemotePlayers?.on)      return window.RemotePlayers.on(type, cb);
        if (window.IZZA?.on)               return IZZA.on('mp-'+type, (_,{data})=>cb(data));
      }catch(e){ console.warn('[TC] on failed', e); }
    };
    return api;
  })();

  // --- Safe-zone toggles (only active if FLAG set) ---
  IZZA.on('ready', (api)=>{
    if(!isInTC()) return;

    // ===== Banner (adjusted) =====
    (function(){
      function showTradeBanner(){
        const fire = document.getElementById('btnFire');
        if (fire) fire.style.display = 'none'; // hide fire button completely

        let b = document.getElementById('tcBanner');
        if (!b) {
          b = document.createElement('div');
          b.id = 'tcBanner';
          b.textContent = 'TRADE CENTRE — Safe Zone';
          Object.assign(b.style,{
            position:'fixed',
            left:'50%',
            bottom:'140px', // raised so it sits above the FIRE button
            transform:'translateX(-50%)',
            padding:'12px 20px',
            background:'linear-gradient(90deg,#0fead4,#13b5a3)',
            color:'#0b0f17',
            fontWeight:'800',
            letterSpacing:'.5px',
            border:'1px solid #10695f',
            borderRadius:'14px',
            boxShadow:'0 6px 20px rgba(0,0,0,.45)',
            zIndex:9999,
            fontSize:'15px',
            display:'flex'
          });
          document.body.appendChild(b);
        } else {
          b.style.display = 'flex';
        }
      }

      function hideTradeBanner(){
        const fire = document.getElementById('btnFire');
        if (fire) fire.style.display = ''; // restore default

        const b = document.getElementById('tcBanner');
        if (b) b.style.display = 'none';
      }

      // Show/hide on events
      window.addEventListener('izza-tradecentre-enter', showTradeBanner);
      window.addEventListener('izza-tradecentre-leave', hideTradeBanner);

      // If we're already in the Trade Centre (FLAG set), show immediately
      showTradeBanner();
    })();

    // Disable attacks (A button & key)
    const stop = e=>{ e?.preventDefault?.(); e?.stopImmediatePropagation?.(); e?.stopPropagation?.(); };
    document.getElementById('btnA')?.addEventListener('click', stop, true);
    window.addEventListener('keydown', e=>{ if((e.key||'').toLowerCase()==='a') stop(e); }, true);

    // No cops/peds each tick
    IZZA.on('update-pre', ()=>{
      try{
        api.pedestrians.length = 0;
        api.cops.length = 0;
      }catch(_){}
    });

    // Door to leave (same door position works in TC too)
    function nearDoor(){
      const T = window.__IZZA_TRADE__?.door; if(!T) return false;
      const t=api.TILE, gx=((api.player.x+16)/t|0), gy=((api.player.y+16)/t|0);
      return Math.abs(gx-T.x)<=1 && Math.abs(gy-T.y)<=1;
    }
    function onB(e){
      if(!nearDoor()) return;
      e?.preventDefault?.(); e?.stopImmediatePropagation?.(); e?.stopPropagation?.();
      if(confirm('Leave Trade Centre?')){
        try{ localStorage.removeItem(FLAG); }catch(_){}
        location.reload();
      }
    }
    document.getElementById('btnB')?.addEventListener('click', onB, true);
    window.addEventListener('keydown', e=>{ if((e.key||'').toLowerCase()==='b') onB(e); }, true);

    // ===== Proximity Trading =====
    // UI bits
    let ui=null, state=null;
    function closeUI(){ if(ui){ ui.remove(); ui=null; state=null; } }
    function getInv(){
      try{ return (IZZA.api.getInventory && IZZA.api.getInventory()) || JSON.parse(localStorage.getItem('izzaInventory')||'{}'); }
      catch{ return {}; }
    }
    function setInv(v){
      try{ if(IZZA.api.setInventory) IZZA.api.setInventory(v); else localStorage.setItem('izzaInventory', JSON.stringify(v)); }
      catch(_){}
    }

    function buildUI(peer){
      closeUI();
      ui=document.createElement('div');
      ui.id='tradeUI';
      ui.style.cssText='position:absolute;inset:0;display:flex;align-items:center;justify-content:center;z-index:80;background:rgba(0,0,0,.5)';
      ui.innerHTML = `
        <div style="width:min(720px,94vw);background:#0f1624;border:1px solid #2b3b57;border-radius:12px;padding:12px;color:#e7eef7">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <strong style="font-size:16px">🤝 Trade</strong>
            <button id="tcClose" class="ghost" style="border-color:#445b82">Close</button>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div>
              <div style="font-weight:700;margin-bottom:6px">@${IZZA.api.user?.username||'You'}</div>
              <div id="mineBox" style="min-height:120px;background:#0c1422;border:1px solid #22314b;border-radius:10px;padding:8px"></div>
              <div style="display:flex;gap:6px;margin-top:8px">
                <button id="addItem" class="buy">Add Item</button>
                <button id="addCoins" class="buy">Add Coins</button>
              </div>
              <div style="margin-top:8px"><label><input id="mineAccept" type="checkbox"> Accept</label></div>
            </div>
            <div>
              <div style="font-weight:700;margin-bottom:6px">@${peer}</div>
              <div id="theirBox" style="min-height:120px;background:#0c1422;border:1px solid #22314b;border-radius:10px;padding:8px"></div>
              <div style="opacity:.75;margin-top:8px">Waiting for @${peer}…</div>
              <div style="margin-top:8px"><span id="theirAccept" style="opacity:.85">Not accepted</span></div>
            </div>
          </div>
          <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:10px">
            <button id="doTrade" class="buy" disabled>Complete Trade</button>
          </div>
        </div>`;
      document.body.appendChild(ui);
      ui.querySelector('#tcClose').onclick = closeUI;

      state = {
        peer,
        mine: { items:[], coins:0, accepted:false },
        theirs:{ items:[], coins:0, accepted:false }
      };

      function redraw(){
        const mineBox=ui.querySelector('#mineBox'), theirBox=ui.querySelector('#theirBox');
        mineBox.innerHTML = (state.mine.items.map(it=>`<div>- ${it}</div>`).join('')||'<div style="opacity:.6">No items</div>')
          + (state.mine.coins? `<div>+ ${state.mine.coins} IC</div>`:'');
        theirBox.innerHTML= (state.theirs.items.map(it=>`<div>- ${it}</div>`).join('')||'<div style="opacity:.6">No items</div>')
          + (state.theirs.coins? `<div>+ ${state.theirs.coins} IC</div>`:'');

        ui.querySelector('#theirAccept').textContent = state.theirs.accepted ? 'Accepted ✔' : 'Not accepted';
        ui.querySelector('#doTrade').disabled = !(state.mine.accepted && state.theirs.accepted);
      }
      redraw();

      // local actions
      ui.querySelector('#addItem').onclick = ()=>{
        const inv=getInv();
        const keys=Object.keys(inv).filter(k=> inv[k] && typeof inv[k]==='object' && (inv[k].count|0)>0);
        if(!keys.length){ alert('No stackable items to offer.'); return; }
        const k=prompt('Type item key to add:\n' + keys.join(', '));
        if(!k || !inv[k] || (inv[k].count|0)<=0) return;
        state.mine.items.push(k);
        state.mine.accepted=false; // any change cancels acceptance
        ui.querySelector('#mineAccept').checked=false;
        Net.send('tc-offer', { to:state.peer, kind:'mine', items:state.mine.items, coins:state.mine.coins, accepted:false });
        redraw();
      };
      ui.querySelector('#addCoins').onclick = ()=>{
        const max = IZZA.api.getCoins();
        const n = Math.max(0, Math.min(max, parseInt(prompt('Coins to offer (0-'+max+')','0')||'0',10)));
        state.mine.coins = n;
        state.mine.accepted=false;
        ui.querySelector('#mineAccept').checked=false;
        Net.send('tc-offer', { to:state.peer, kind:'mine', items:state.mine.items, coins:state.mine.coins, accepted:false });
        redraw();
      };
      ui.querySelector('#mineAccept').onchange = (e)=>{
        state.mine.accepted = !!e.target.checked;
        Net.send('tc-accept', { to:state.peer, accepted: state.mine.accepted });
        redraw();
      };
      ui.querySelector('#doTrade').onclick = ()=>{
        if(!(state.mine.accepted && state.theirs.accepted)) return;

        // Apply transfer locally
        const inv = getInv();
        // remove mine items
        state.mine.items.forEach(k=>{ inv[k] = inv[k]||{count:0}; inv[k].count = Math.max(0,(inv[k].count|0)-1); });
        // add theirs items
        state.theirs.items.forEach(k=>{ inv[k] = inv[k]||{count:0}; inv[k].count = (inv[k].count|0)+1; });
        setInv(inv);
        // coins
        IZZA.api.setCoins(IZZA.api.getCoins() - (state.mine.coins|0) + (state.theirs.coins|0));
        try{ window.dispatchEvent(new Event('izza-inventory-changed')); window.dispatchEvent(new Event('izza-coins-changed')); }catch(_){}

        Net.send('tc-complete', { to:state.peer });
        closeUI();
        IZZA.toast?.('Trade complete!');
      };

      // inbound updates
      Net.on('tc-offer', (d)=>{
        if(!d || d.from!==state.peer) return;
        state.theirs.items = Array.isArray(d.items)? d.items.slice(0,32) : [];
        state.theirs.coins = d.coins|0;
        state.mine.accepted=false; ui.querySelector('#mineAccept').checked=false; // they changed, unaccept me
        state.theirs.accepted=false;
        redraw();
      });
      Net.on('tc-accept', (d)=>{
        if(!d || d.from!==state.peer) return;
        state.theirs.accepted = !!d.accepted;
        redraw();
      });
      Net.on('tc-complete', (d)=>{
        if(!d || d.from!==state.peer) return;
        // Mirror application for peer’s side:
        // (Nothing to do here—we already applied locally.)
        closeUI();
        IZZA.toast?.('Trade complete!');
      });
    }

    // Proximity check + B to start trade
    function nearestPeer(){
      try{
        const me = IZZA.api.player, t=IZZA.api.TILE;
        let best=null, bestD=1e9;
        (window.__REMOTE_PLAYERS__||[]).forEach(p=>{
          const d = Math.hypot(me.x - p.x, me.y - p.y);
          if(d < bestD){ best=p; bestD=d; }
        });
        return (bestD<=48) ? best : null; // ~1.5 tiles
      }catch(_){ return null; }
    }
    function onTradeB(e){
      if (nearDoor()) return; // door handler takes priority
      const peer = nearestPeer();
      if(!peer) return;
      e?.preventDefault?.(); e?.stopImmediatePropagation?.(); e?.stopPropagation?.();
      buildUI(peer.username || peer.name || 'peer');
    }
    document.getElementById('btnB')?.addEventListener('click', onTradeB, true);
    window.addEventListener('keydown', e=>{ if((e.key||'').toLowerCase()==='b') onTradeB(e); }, true);
  });
})();
