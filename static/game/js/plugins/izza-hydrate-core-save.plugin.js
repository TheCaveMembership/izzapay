<script>
/* IZZA hydrate — Core save (position/hearts/inventory legacy mirrors)
   - Skips MONEY if bank plugin owns it
   - Waits for real username
   - Uses canonical API base
*/
(function(){
  // ---------- API base (canonical) ----------
  const API_BASE = (function(){
    // prefer same global
    const b = (window.IZZA_PERSIST_BASE || '').replace(/\/+$/,'');
    if (b) return b + '/api';
    // or a single fixed origin (same as saver)
    return 'https://izzagame.onrender.com/api';
  })();
  const SNAP = user => `${API_BASE}/state/${encodeURIComponent(user)}`;

  // ===== tiny overlay =====
  const overlay = document.createElement('div');
  Object.assign(overlay.style,{
    position:'fixed', inset:'0', background:'rgba(5,8,14,.86)', display:'flex',
    alignItems:'center', justifyContent:'center', zIndex: 99999, color:'#cfe0ff',
    fontFamily:'system-ui, -apple-system, Segoe UI, Roboto, sans-serif', fontSize:'15px'
  });
  overlay.innerHTML = `<div style="padding:14px 18px;border:1px solid #394769;border-radius:10px;background:#0b1120">
    Restoring your game…</div>`;
  const addOverlay = ()=>{ if(!overlay.isConnected) document.body.appendChild(overlay); };
  const removeOverlay = ()=>{ if(overlay.isConnected) overlay.remove(); };

  // ===== utils =====
  const safeParse = (s, fb)=>{ try{ return JSON.parse(s); }catch{ return fb; } };
  const getLS = (k, fb=null)=> { const v=localStorage.getItem(k); return v==null? fb : v; };
  const setLS = (k, v)=> localStorage.setItem(k, v);
  const getLSJSON = (k, fb=null)=> safeParse(getLS(k, null), fb);
  const setLSJSON = (k, obj)=> setLS(k, JSON.stringify(obj));
  const sleep = (ms)=> new Promise(r=>setTimeout(r,ms));
  const waitFrames = (n=1)=> new Promise(res=>{ let left=n; function tick(){ if(--left<=0) res(); else requestAnimationFrame(tick); } requestAnimationFrame(tick); });

  const CANON = s => (s==null?'guest':String(s)).replace(/^@+/,'').toLowerCase().replace(/[^a-z0-9-_]/g,'-');

  function isEmptySnapshot(s){
    if(!s || typeof s!=='object') return true;
    if (s.version !== 1) return false;
    const coinsTop = (s.coins|0)||0;
    const invEmpty = !s.inventory || Object.keys(s.inventory).length===0;
    const bank = s.bank||{};
    const bankCoins = (bank.coins|0)||0;
    const bankEmpty = bankCoins===0 &&
      (!bank.items || Object.keys(bank.items).length===0) &&
      (!bank.ammo  || Object.keys(bank.ammo ).length===0);
    return coinsTop===0 && invEmpty && bankEmpty;
  }

  function resolveUserImmediate(){
    const p = (window.__IZZA_PROFILE__||{});
    const plug =
