// IZZA hydrate: restore ONLY Bank + Inventory after all cores & map loads
(function(){
  // ---------- Mini overlay while we restore ----------
  const overlay = document.createElement('div');
  Object.assign(overlay.style,{
    position:'fixed', inset:'0', background:'rgba(5,8,14,.90)',
    display:'none', alignItems:'center', justifyContent:'center',
    zIndex:99999, color:'#cfe0ff',
    fontFamily:'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
    fontSize:'15px'
  });
  overlay.innerHTML = `<div style="padding:14px 18px;border:1px solid #394769;border-radius:10px;background:#0b1120">
    Loading your items & bank…</div>`;
  document.addEventListener('DOMContentLoaded', ()=> document.body.appendChild(overlay));

  // ---------- Utils ----------
  const log  = (...a)=> console.log('[IZZA hydrate BI]', ...a);
  const warn = (...a)=> console.warn('[IZZA hydrate BI]', ...a);
  const sleep= (ms)=> new Promise(r=>setTimeout(r, ms));

  function getLS(k,d=null){ const v=localStorage.getItem(k); return v==null? d : v; }
  function setLS(k,v){ localStorage.setItem(k,v); }
  function setJSON(k,o){ setLS(k, JSON.stringify(o)); }

  function resolveUser(){
    const profile = window.__IZZA_PROFILE__ || {};
    const fromPlugin = (window.izzaUserKey && typeof izzaUserKey.get==='function') ? izzaUserKey.get() : null;
    const u = (profile.username || profile.user || fromPlugin || getLS('izzaUserKey') || 'guest')
      .toString().toLowerCase();
    return u.replace(/[^a-z0-9-_]/g,'-');
  }

  // Treat snapshots that would zero-out a player as "empty-like"
  function isEmptyLike(s){
    if (!s || typeof s!=='object') return true;
    const inv = s.inventory || {};
    const invCount = Array.isArray(inv) ? inv.length : Object.keys(inv).length;
    const bank = s.bank || {};
    const bankCoins = Number(bank.coins||0);
    const bankItems = bank.items ? Object.keys(bank.items).length : 0;
    const bankAmmo  = bank.ammo  ? Object.keys(bank.ammo ).length : 0;
    return (invCount===0 && bankCoins===0 && bankItems===0 && bankAmmo===0);
  }

  // Accepts either:
  //  1) {version, player, coins, inventory, bank, timestamp}
  //  2) { ok:true, empty:false, snapshot:{...} }
  function unwrapSnapshot(data){
    if (!data) return null;
    if (data.snapshot) return data.snapshot;
    return data;
  }

  async function fetchValidSnapshot(user){
    // Try latest then step back a few — your API may accept ?offset=N
    const tryOffsets = [0,1,2,3,4,5];
    for (const off of tryOffsets){
      try{
        const url = `/api/state/${encodeURIComponent(user)}?offset=${off}`;
        const res = await fetch(url, { credentials:'omit' });
        if (!res.ok){ warn('GET failed', off, res.status); continue; }
        const raw = await res.json();
        const snap = unwrapSnapshot(raw);
        if (snap && !isEmptyLike(snap)) return snap;
        log(`offset ${off} empty-like; trying older…`);
      }catch(e){ warn('fetch error (offset', off, '):', e); }
    }
    return null;
  }

  // Write bank into LS mirror for plugins/UI that depend on it
  function writeBankToLocalStorage(user, bank){
    const key = `izzaBank_${user}`;
    const clean = bank && typeof bank==='object'
      ? { coins: Number(bank.coins||0),
          items: bank.items||{},
          ammo: 
