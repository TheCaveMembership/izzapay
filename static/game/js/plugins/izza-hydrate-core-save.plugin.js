// /static/game/plugins/izza-hydrate-core-save.plugin.js
(function(){
  // ---- tiny overlay while we restore ----
  const overlay = document.createElement('div');
  Object.assign(overlay.style,{
    position:'fixed', inset:'0', background:'rgba(5,8,14,.85)', display:'flex',
    alignItems:'center', justifyContent:'center', zIndex: 99999, color:'#cfe0ff',
    fontFamily:'system-ui, -apple-system, Segoe UI, Roboto, sans-serif', fontSize:'15px'
  });
  overlay.innerHTML = `<div style="padding:14px 18px;border:1px solid #394769;border-radius:10px;background:#0b1120">
    Loading your game…</div>`;
  document.addEventListener('DOMContentLoaded', ()=> document.body.appendChild(overlay));

  function safeParse(s, fallback){ try{ return JSON.parse(s); }catch{ return fallback; } }
  function get(key, fallback){ const v = localStorage.getItem(key); return v==null? fallback : v; }
  function getJSON(key, fallback){ return safeParse(get(key, null), fallback); }
  function set(key, val){ localStorage.setItem(key, val); }
  function setJSON(key, obj){ set(key, JSON.stringify(obj)); }

  async function hydrate(){
    // Give the LS/userkey plugin a chance to init (no-op if it doesn’t exist)
    try{ if (window.izzaLS && typeof izzaLS.ready === 'function') await izzaLS.ready(); }catch{}

    // Resolve user key the same way Diagnostics shows it
    const profile = (window.__IZZA_PROFILE__) || {};
    const fromPlugin = (window.izzaUserKey && typeof izzaUserKey.get==='function') ? izzaUserKey.get() : null;
    const USER = (profile.username || profile.user || fromPlugin || get('izzaUserKey') || 'guest').toLowerCase();

    // Source-of-truth snapshot used by your new plugins
    const BANK_KEY   = `izzaBank_${USER}`;                    // {coins, items, ammo}
    const HEARTS_KEY = `izzaCurHeartSegments_${USER}`;        // optional: [..] or number
    const bank = getJSON(BANK_KEY, { coins:0, items:{}, ammo:{} });

    // Other snapshot-y keys you already have around (Diagnostics listed them)
    const missions = parseInt(get('izzaMissions') || '0', 10) || 0;
    const inventoryFromBank = Object.keys(bank.items || {});  // map bank items -> simple list

    // ---- Write the legacy keys the cores read so they “see” the same state ----
    // Core v2 blob:
    const SAVE_KEY = 'izza_save_v1';
    const legacySave = {
      coins: bank.coins|0,
      missionsCompleted: missions,
      inventory: inventoryFromBank
    };
    setJSON(SAVE_KEY, legacySave);

    // Older bits some builds still glance at:
    set('izzaCoins', String(bank.coins|0));
    if (get(HEARTS_KEY) == null) {
      // don’t invent hearts; only copy if you already track somewhere else
      // (leave as-is; Diagnostics will show “(none)” if not used)
    }

    // Nudge any HUDs/plugins to re-read
    try{ window.dispatchEvent(new Event('izza-bank-changed')); }catch{}
    // Optional: expose a quick note for Diagnostics
    console.log('[IZZA hydrate] user=%s bank=%o save=%o', USER, bank, legacySave);
  }

  // Run asap, then remove overlay
  (async function boot(){
    try{ await hydrate(); }
    finally{
      // small grace so low-end devices don’t flicker
      setTimeout(()=>{ overlay.remove(); }, 250);
    }
  })();
})();
