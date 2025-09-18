// UPDATE v1.2.0 — Split API bases (Flask vs Node), route endpoints accordingly, align merchant prefill payload; keep previous sanitizeSVG hardening.
  window.IZZA_APP_BASE  = 'https://izzapay.onrender.com';   // Flask
  window.IZZA_NODE_BASE = 'https://izzagame.onrender.com';  // Node (already your default)
// Configure once:
window.CRAFT_CHECKOUT_PATH = '/checkout/d0b811e8';                  // <-- your item checkout URL path

function craftCheckoutURL({ totalPi, name, category, part }) {
  const base = (window.IZZA_APP_BASE||'').replace(/\/+$/,'');
  const p    = (window.CRAFT_CHECKOUT_PATH||'').replace(/^\/+/, ''); // "checkout/d0b811e8"
  const title= name || `${category||'armour'}/${part||'helmet'} item`;

  const q = new URLSearchParams({
    from: 'craft',
    title,
    amount: String(totalPi || 0),
    return_to: window.location.href    // we’ll bounce back to the game here
  });

  return `${base}/${p}?${q.toString()}`;
}
// --- AI prompt guidance (slot-aware + style/animation aware, no bg) ---
const SLOT_GUIDE = {
  helmet: "Helmet/headwear from a top-down 3/4 view. Stay in head slot; don't spill onto torso.",
  vest:   "Chest/torso armor plate from a top-down 3/4 view. Keep shoulders within bounds.",
  arms:   "Left/right forearms/gauntlets along the sides; leave body center clear. Two distinct sides.",
  legs:   "Two leg elements (thigh-to-shin). Balanced spacing between left and right.",
  hands:  "Weapon overlay (horizontal composition). Reads at 28px. No full character.",
  gun:    "Handheld gun (treat as hands slot; horizontal composition).",
  melee:  "Handheld melee blade/club (treat as hands slot; horizontal composition)."
};

// Map UI part to the server's slot keys
function mapPartForServer(part){
  const p = String(part||'').toLowerCase();
  if (p==='gun' || p==='melee') return 'hands';
  if (p==='helmet' || p==='vest' || p==='arms' || p==='legs' || p==='hands') return p;
  return 'helmet';
}

// Slot-specific viewBoxes (what the server expects)
const SLOT_VB = {
  helmet: '0 0 128 128',
  vest:   '0 0 128 128',
  arms:   '0 0 160 120',
  legs:   '0 0 140 140',
  hands:  '0 0 160 100',
};

/* ---------- NEW (minimal + additive): category-aware part options ---------- */
const PART_OPTIONS = {
  armour: [
    { v:'helmet', t:'Helmet' },
    { v:'vest',   t:'Vest'   },
    { v:'arms',   t:'Arms'   },
    { v:'legs',   t:'Legs'   },
  ],
  weapon: [
    { v:'gun',    t:'Gun'    },
    { v:'melee',  t:'Melee'  },
  ],
  // Keep these listed but they behave just like before (no feature logic changed)
  apparel: [
    { v:'helmet', t:'Helmet' },
    { v:'vest',   t:'Vest'   },
    { v:'arms',   t:'Arms'   },
    { v:'legs',   t:'Legs'   },
  ],
  merch: [
    { v:'helmet', t:'Helmet' },
    { v:'vest',   t:'Vest'   },
    { v:'arms',   t:'Arms'   },
    { v:'legs',   t:'Legs'   },
  ]
};

function repopulatePartOptions(catSelEl, partSelEl){
  const cat  = (catSelEl?.value || 'armour');
  const opts = PART_OPTIONS[cat] || PART_OPTIONS.armour;
  const prev = partSelEl?.value;
  partSelEl.innerHTML = opts.map(o=> `<option value="${o.v}">${o.t}</option>`).join('');
  partSelEl.value = opts.some(o=>o.v===prev) ? prev : opts[0].v;
}
/* ------------------------------------------------------------------------- */

// Compose the UX prompt shown to the model (keeps constraints tight)
function composeAIPrompt(userPrompt, part, { style='realistic', animate=false } = {}){
  const guide = SLOT_GUIDE[part] || '';
  const slot  = mapPartForServer(part);
  const vb    = SLOT_VB[slot] || '0 0 128 128';

  const styleLine = (String(style).toLowerCase()==='cartoon' || String(style).toLowerCase()==='stylized')
    ? "STYLE: Stylized/cartoon allowed, but still layered: gradients + soft shadows. Avoid flat emoji."
    : "STYLE: Realistic materials (chrome, glass, brushed steel, leather). Subtle AO and specular highlights.";

  const animLine = animate
    ? "ANIMATION: Allowed. Use lightweight loop via <animate>/<animateTransform> or CSS @keyframes. 1–2 effects max (glow pulse, flame lick). No JS."
    : "ANIMATION: Not required. Ensure static silhouette reads clearly.";

  // Hard constraints (these mirror your server SYSTEM_PROMPT)
  const constraints = [
    `Item part: ${slot}`,
    `Use viewBox="${vb}". Fit art tightly with 0–2px padding; center visually.`,
    "Transparent background. Do NOT draw any full-bleed background rects.",
    "Vector only: <path>, <rect>, <circle>, <polygon>, <g>, <defs>, gradients, filters (feGaussianBlur, feDropShadow). No <image>, no <foreignObject>.",
    "Must read at ~28px inventory size. Clean silhouette + controlled detail.",
    (slot==='arms'||slot==='legs') ? "Structure: two distinct side elements (no single central blob)." : null,
    (slot==='hands') ? "Structure: horizontal weapon composition." : null,
    styleLine,
    animLine
  ].filter(Boolean).join(' ');

  return [
    userPrompt,
    guide,
    constraints
  ].filter(Boolean).join(' ');
}
// /static/game/js/plugins/crafting/crafting_ui.js
(function(){
  const COSTS = Object.freeze({
  // --- Single-item TEST pricing (keep for now) ---
  PER_ITEM_IC:   0,      // keep 0 IC for testing
  PER_ITEM_PI:   0.1,    // keep 0.10 Pi for testing

  // --- Starter Forge package pricing (fix) ---
  PACKAGE_PI:    5,          // 5 Pi
  PACKAGE_IC:    10000,      // 10,000 IC

  // --- Add-on/Shop settings (unchanged logic) ---
  ADDON_IC:      1000,
  ADDON_PI:      1,
  SHOP_MIN_IC:   50,
  SHOP_MAX_IC:   250,
  AI_ATTEMPTS:   5
});

// FYI conversion reference (no logic change): 1 Pi = 2000 IZZA coins
const COIN_PER_PI = 2000;

  const STATE = {
  root: null,
  mounted: false,
  aiAttemptsLeft: COSTS.AI_ATTEMPTS,
  hasPaidForCurrentItem: false,
  currentSVG: '',
  currentName: '',
  featureFlags: {
    dmgBoost: false,
    fireRate: false,
    speedBoost: false,
    dmgReduction: false,
    tracerFx: false,
    swingFx: false
  },
  aiStyle: 'realistic',      // 'realistic' | 'cartoon' (aka 'stylized')
  wantAnimation: false,      // creator can toggle animation
  currentCategory: 'armour',
  currentPart: 'helmet',
  fireRateRequested: 0,
  dmgHearts: 0.5,
  packageCredits: null,
      canUseVisuals: false,      // visuals locked until successful purchase
    createSub: 'setup',        // which subtab is shown: 'setup' | 'visuals'
};
  STATE.mintCredits = getMintCredits();
  // (Kept: name moderation + sanitizers + helpers)
  const BAD_WORDS = ['badword1','badword2','slur1','slur2'];
  function moderateName(name){
    const s = String(name||'').trim();
    if (s.length < 3 || s.length > 28) return { ok:false, reason:'Name must be 3–28 chars' };
    const low = s.toLowerCase();
    if (BAD_WORDS.some(w => low.includes(w))) return { ok:false, reason:'Inappropriate name' };
    return { ok:true };
  }
  
// If user returns with ?craftPaid=1, unlock visuals
function applyCraftPaidFromURL() {
  try {
    const u = new URL(window.location.href);
    if (u.searchParams.get('craftPaid') === '1') {
  // First ask server to reconcile new orders → credits
  let credited = false;
  try {
    const r = await appJSON('/api/crafting/credits/reconcile', { method:'POST' });
    credited = !!(r && r.ok);
  } catch(_) {}

  // Pull canonical number
  try { await syncCreditsFromServer(); } catch(_) {}

  // Fallback (rare): if server didn’t grant for any reason, keep the old local path
  if (!credited) {
    incMintCredits(1);
    STATE.mintCredits = getMintCredits();
  }

  STATE.hasPaidForCurrentItem = false;
  STATE.canUseVisuals = false;
  STATE.aiAttemptsLeft = COSTS.AI_ATTEMPTS;
  STATE.createSub = 'setup';

  // Clean URL
  u.searchParams.delete('craftPaid');
  const clean = u.pathname + (u.search ? '?' + u.searchParams.toString() : '') + u.hash;
  history.replaceState(null, '', clean);

  // Re-render Create to show Setup (with Next if fields ready)
  const host = STATE.root?.querySelector('#craftTabs');
  if (host) { host.innerHTML = renderCreate(); bindInside(); }
}

  function sanitizeSVG(svg){
  try{
    const txt = String(svg||'');
    if (txt.length > 200_000) throw new Error('SVG too large');
    if (/script|onload|onerror|foreignObject|iframe/i.test(txt)) throw new Error('Disallowed elements/attrs');

    // base clean
    let cleaned = txt
      .replace(/xlink:href\s*=\s*["'][^"']*["']/gi,'')
      .replace(/\son\w+\s*=\s*["'][^"']*["']/gi,'')
      .replace(/href\s*=\s*["']\s*(?!#)[^"']*["']/gi,'')
      .replace(/(javascript:|data:)/gi,'')
      .replace(/<metadata[\s\S]*?<\/metadata>/gi,'')
      .replace(/<!DOCTYPE[^>]*>/gi,'')
      .replace(/<\?xml[\s\S]*?\?>/gi,'');

    // --- NEW: strip obvious "background" fills so overlays are transparent ---
    // 1) Remove inline CSS background on the <svg> tag
    cleaned = cleaned.replace(
      /(<svg\b[^>]*\sstyle\s*=\s*["'][^"']*)\bbackground(?:-color)?\s*:[^;"']+;?/i,
      (_, pre)=> pre
    );

    // 2) Kill <rect> that clearly cover the whole canvas (100% x 100%)
    cleaned = cleaned.replace(
      /<rect\b[^>]*width\s*=\s*["']\s*100%\s*["'][^>]*height\s*=\s*["']\s*100%\s*["'][^>]*\/?>/gi,
      ''
    );

    // 3) Kill full-bleed <rect x="0" y="0" width=VBW height=VBH> (common sizes)
    const vb = /viewBox\s*=\s*["'][^"']*?(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)/i.exec(cleaned);
    if (vb){
      const w = String(parseFloat(vb[3]));
      const h = String(parseFloat(vb[4]));
      const fullRectRe = new RegExp(
        `<rect\\b[^>]*x\\s*=\\s*['"]?0(?:\\.0+)?['"]?[^>]*y\\s*=\\s*['"]?0(?:\\.0+)?['"]?[^>]*width\\s*=\\s*['"]?(?:${w}|${Math.round(+w)})['"]?[^>]*height\\s*=\\s*['"]?(?:${h}|${Math.round(+h)})['"]?[^>]*\\/?>`,
        'gi'
      );
      cleaned = cleaned.replace(fullRectRe, '');
    } else {
      // fallback for common canvases
      cleaned = cleaned.replace(
        /<rect\b[^>]*x\s*=\s*["']?0(?:\.0+)?["']?[^>]*y\s*=\s*["']?0(?:\.0+)?["']?[^>]*width\s*=\s*["']?(?:128|256|512|1024)["']?[^>]*height\s*=\s*["']?(?:128|256|512|1024)["']?[^>]*\/?>/gi,
        ''
      );
    }

    // 4) Remove <rect> marked as background via id/class
    cleaned = cleaned.replace(/<rect\b[^>]*(id|class)\s*=\s*["'][^"']*(?:\bbg\b|\bbackground\b|\bbackdrop\b)[^"']*["'][^>]*\/?>/gi,'');

    return cleaned;
  }catch(e){ return ''; }
}
// --- UI helpers for AI wait state ---
const MIN_AI_WAIT_MS = 10_000;
const sleep = (ms)=> new Promise(r=>setTimeout(r, ms));

function showWait(text){
  const el = document.createElement('div');
  el.id = 'izza-ai-wait';
  el.style.cssText = `
    position:fixed; inset:0; z-index:99999;
    display:flex; align-items:center; justify-content:center;
    background:rgba(0,0,0,.45); backdrop-filter:saturate(120%) blur(2px);
  `;
  el.innerHTML = `
    <div style="
      background:#0f1522; color:#e7ecff; border:1px solid #2a3550;
      border-radius:12px; padding:14px 16px; font-size:14px;
      min-width:220px; text-align:center; box-shadow:0 8px 28px rgba(0,0,0,.35);
    ">
      <div style="font-weight:700; margin-bottom:6px">Generating…</div>
      <div style="opacity:.85">${text||'Please wait while we create your preview.'}</div>
    </div>`;
  document.body.appendChild(el);
  return el;
}
function hideWait(node){
  try{ node && node.parentNode && node.parentNode.removeChild(node); }catch{}
}
  // === IZZA Coins (game wallet) helpers — use IZZA.api if available; fall back to localStorage ===
function getIC(){
  try{
    if (IZZA?.api?.getCoins) return IZZA.api.getCoins()|0;
    const p = IZZA?.api?.player;
    if (p && typeof p.coins === 'number') return p.coins|0;
    return parseInt(localStorage.getItem('izzaCoins')||'0',10) || 0;
  }catch{ return 0; }
}

function setIC(v){
  try{
    const n = Math.max(0, v|0);
    if (IZZA?.api?.setCoins) {
      IZZA.api.setCoins(n);
    } else if (IZZA?.api?.player && typeof IZZA.api.player === 'object') {
      IZZA.api.player.coins = n;
    }
    // keep local mirror so UI still works if api isn’t ready yet
    localStorage.setItem('izzaCoins', String(n));
    try{ window.dispatchEvent(new Event('izza-coins-changed')); }catch{}
  }catch{}
}
 
// === MINT CREDITS (stackable; 1 credit = 5 AI attempts) =====================
function getMintCredits(){
  try { return parseInt(localStorage.getItem('izzaMintCredits')||'0',10) || 0; } catch { return 0; }
}
function setMintCredits(v){
  try{
    const n = Math.max(0, v|0);
    localStorage.setItem('izzaMintCredits', String(n));
    window.dispatchEvent(new Event('izza-mint-credits-changed'));
  }catch{}
}
function incMintCredits(delta=1){ setMintCredits(getMintCredits() + (delta|0)); }
function consumeMintCredit(){
  const n = getMintCredits();
  if (n <= 0) return false;
  setMintCredits(n - 1);
  return true;
}
// ============================================================================
  
// === API bases: Flask app vs Node service ===
// Flask (APP_BASE) handles payments, creations, merchant bridge (same-origin)
const APP_BASE  = (window.IZZA_APP_BASE && String(window.IZZA_APP_BASE).replace(/\/+$/,'')) || '';
// Node (NODE_BASE) handles AI/translate and game-side extras
const NODE_BASE = (window.IZZA_NODE_BASE && String(window.IZZA_NODE_BASE).replace(/\/+$/,'')) || 'https://izzagame.onrender.com';

const app  = (p)=> APP_BASE + p;   // Flask
const node = (p)=> NODE_BASE + p;  // Node

async function appJSON(url, opts={}) {
  const r = await fetch(app(url), Object.assign({ headers:{'content-type':'application/json'}, credentials:'include' }, opts));
  if (!r.ok) throw new Error('HTTP ' + r.status);
  try { return await r.json(); } catch { return {}; }
}
async function nodeJSON(url, opts={}) {
  const r = await fetch(node(url), Object.assign({ headers:{'content-type':'application/json'} }, opts));
  if (!r.ok) throw new Error('HTTP ' + r.status);
  try { return await r.json(); } catch { return {}; }
}
// --- NEW: server → client credit sync (canonical) ---
async function syncCreditsFromServer(){
  try{
    const j = await appJSON('/api/crafting/credits', { method: 'GET' });
    if (j && j.ok && Number.isFinite(j.credits)) {
      setMintCredits(j.credits);
      STATE.mintCredits = getMintCredits();
      const bal = STATE.root?.querySelector('#mintBalance');
      if (bal) bal.innerHTML = `Credits: <b>${STATE.mintCredits}</b>`;
    }
  }catch(e){ /* non-fatal */ }
}
  // === CREDIT HELPERS ==========================================================
async function grantOneCredit(reason){
  try{
    const j = await appJSON('/api/crafting/credits/add', {
      method: 'POST',
      body: JSON.stringify({ qty: 1, reason: String(reason||'manual') })
    });
    return !!(j && j.ok);
  }catch(_){ return false; }
}
  async function payWithPi(amountPi, memo){
    if (!window.Pi || typeof window.Pi.createPayment!=='function'){
      alert('Pi SDK not available'); return { ok:false, reason:'no-pi' };
    }
    try{
      const paymentData = { amount: String(amountPi), memo: memo || 'IZZA Crafting', metadata: { kind:'crafting', memo } };
      const res = await window.Pi.createPayment(paymentData, {
        onReadyForServerApproval: async (paymentId) => {
          await appJSON('/api/crafting/pi/approve', { method:'POST', body:JSON.stringify({ paymentId }) });
        },
        onReadyForServerCompletion: async (paymentId, txid) => {
          await appJSON('/api/crafting/pi/complete', { method:'POST', body:JSON.stringify({ paymentId, txid }) });
        }
      });
      if (res && res.status && /complete/i.test(res.status)) return { ok:true, receipt:res };
      return { ok:false, reason:'pi-not-complete', raw:res };
    }catch(e){ console.warn('[craft] Pi pay failed', e); return { ok:false, reason:String(e) }; }
  }

  // Replace the payWithIC function
// Replace the entire payWithIC with this
async function payWithIC(amountIC){
  // 0 IC promo/test: grant a credit on the server
  if ((amountIC|0) === 0){
    const ok = await grantOneCredit('ic-0');
    if (ok){
      try { await syncCreditsFromServer(); } catch(_) {}
      return { ok:true, granted:true, amountIC:0 };
    }
    // last-resort local fallback so UI can proceed even if server missing
    try { incMintCredits(1); } catch(_){}
    return { ok:true, granted:true, amountIC:0, local:true };
  }

  // Normal debit path (non-zero): use Flask via appJSON so cookies & CORS are right
  const cur = getIC();
  if (cur < amountIC) return { ok:false, reason:'not-enough-ic' };
  setIC(cur - amountIC);
  try{
    await appJSON('/api/crafting/ic/debit', {
      method:'POST',
      body: JSON.stringify({ amount: amountIC })
    });
    await syncCreditsFromServer(); // refresh canonical balance
  }catch(_){}
  return { ok:true };
}
  function selectedAddOnCount(){ return Object.values(STATE.featureFlags).filter(Boolean).length; }
  function calcTotalCost({ usePi }){ const base = usePi ? COSTS.PER_ITEM_PI : COSTS.PER_ITEM_IC; const addon = usePi ? COSTS.ADDON_PI : COSTS.ADDON_IC; return base + addon * selectedAddOnCount(); }

  // *** CHANGE 2: server-first, fallback is now a tiny basic blueprint icon ***
  // --- AI prompt: server first, then minimal fallback ---
// Server-first AI; minimal fallback (simple blueprint) if the server fails.
async function aiToSVG(prompt){
  if (STATE.aiAttemptsLeft <= 0) throw new Error('No attempts left');

  try{
    const j = await nodeJSON('/api/crafting/ai_svg', {
      method:'POST',
      body: JSON.stringify({
        prompt: composeAIPrompt(prompt, STATE.currentPart, {
          style: STATE.aiStyle,
          animate: STATE.wantAnimation
        }),
        meta: {
          part: mapPartForServer(STATE.currentPart),   // hands for gun/melee
          category: STATE.currentCategory,
          name: STATE.currentName,
          style: STATE.aiStyle,         // <-- new
          animate: STATE.wantAnimation, // <-- new
          animationPaid: false          // UI will set true after purchase when you wire the upsell
        }
      })
    });

    if (j && j.ok && j.svg){
      const cleaned = sanitizeSVG(j.svg);
      if (!cleaned) throw new Error('SVG rejected');
      STATE.aiAttemptsLeft -= 1;
      return cleaned;
    } else if (j && !j.ok) {
      alert('AI server error: ' + (j.reason || 'unknown'));
    }
  }catch(e){
    alert('AI server error: ' + (e?.message || e || 'unknown'));
  }

  // fallback blueprint
  const raw = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" preserveAspectRatio="xMidYMid meet">
      <rect x="8" y="8" width="112" height="112" rx="14" fill="#0f1522" stroke="#2a3550" stroke-width="2"/>
      <g fill="none" stroke="#2a3550" stroke-width="1">
        <path d="M16 32 H112" opacity="0.6"/>
        <path d="M16 56 H112" opacity="0.5"/>
        <path d="M16 80 H112" opacity="0.4"/>
        <path d="M16 104 H112" opacity="0.3"/>
      </g>
      <g opacity="0.9">
        <circle cx="64" cy="64" r="22" fill="#1e2a45"/>
        <path d="M48 64 Q64 48 80 64" fill="none" stroke="#3a4a72" stroke-width="3"/>
        <path d="M48 72 Q64 56 80 72" fill="none" stroke="#3a4a72" stroke-width="2" opacity="0.8"/>
      </g>
    </svg>
  `.trim();

  STATE.aiAttemptsLeft -= 1;
  return sanitizeSVG(raw);
}
// --- Slot viewBoxes used by the engine (same as server) ---
const TARGET_VB = {
  helmet: '0 0 128 128',
  vest:   '0 0 128 128',
  arms:   '0 0 160 120',
  legs:   '0 0 140 140',
  hands:  '0 0 160 100'
};

// Gun/melee map to "hands" for slot fitting
function _mapPartToSlot(p){
  p = String(p||'').toLowerCase();
  if (p==='gun' || p==='melee') return 'hands';
  return (p==='helmet'||p==='vest'||p==='arms'||p==='legs'||p==='hands') ? p : 'helmet';
}

function _parseVB(vbStr){
  if (!vbStr) return null;
  const m = String(vbStr).trim().split(/\s+/).map(Number);
  if (m.length !== 4 || m.some(n=>!Number.isFinite(n))) return null;
  return { x:m[0], y:m[1], w:m[2], h:m[3] };
}

function _ensureMeasureHost(){
  let host = document.getElementById('izza-svg-measure-host');
  if (host) return host;
  host = document.createElement('div');
  host.id = 'izza-svg-measure-host';
  host.style.cssText = 'position:absolute;left:-99999px;top:-99999px;width:0;height:0;overflow:hidden;pointer-events:none';
  document.body.appendChild(host);
  return host;
}

/**
 * normalizeSvgForSlot(svgText, part)
 *  - Sanitize -> measure tight bbox -> scale & center into the target slot viewBox
 *  - Transparent background preserved
 *  - Adds data-slot + data-anim (if present)
 */
function normalizeSvgForSlot(svgText, part){
  const safe = sanitizeSVG(svgText);
  if (!safe) return '';
  const slot = _mapPartToSlot(part);
  const targetVBStr = TARGET_VB[slot] || '0 0 128 128';
  const targetVB = _parseVB(targetVBStr);

  const measureHost = _ensureMeasureHost();
  const container = document.createElement('div');
  container.innerHTML = safe;
  const svgIn = container.querySelector('svg');
  if (!svgIn) return '';

  // Strip any background from root style
  if (svgIn.hasAttribute('style')) {
    svgIn.setAttribute('style', svgIn.getAttribute('style').replace(/background(-color)?\s*:[^;]+;?/gi,''));
  }

  // Copy visible nodes (skip defs/title/desc/style)
  const defs = svgIn.querySelector('defs');
  const gfx = document.createElementNS('http://www.w3.org/2000/svg','g');
  Array.from(svgIn.childNodes).forEach(n=>{
    if (n.nodeType!==1) return;
    const t = n.tagName.toLowerCase();
    if (t==='defs'||t==='metadata'||t==='title'||t==='desc'||t==='style') return;
    gfx.appendChild(n.cloneNode(true));
  });

  // Measure tight bbox
  const vbIn = _parseVB(svgIn.getAttribute('viewBox')) || _parseVB(targetVBStr) || {x:0,y:0,w:128,h:128};
  const meas = document.createElementNS('http://www.w3.org/2000/svg','svg');
  meas.setAttribute('xmlns','http://www.w3.org/2000/svg');
  meas.setAttribute('viewBox', `${vbIn.x} ${vbIn.y} ${vbIn.w} ${vbIn.h}`);
  if (defs) meas.appendChild(defs.cloneNode(true));
  meas.appendChild(gfx);
  measureHost.appendChild(meas);

  let bbox;
  try { bbox = gfx.getBBox(); } catch { bbox = null; }
  if (!bbox || bbox.width<=0 || bbox.height<=0){
    bbox = { x: vbIn.x, y: vbIn.y, width: vbIn.w, height: vbIn.h };
  }

  // Fit with tiny padding
  const pad = 1.5;
  const availW = targetVB.w - pad*2, availH = targetVB.h - pad*2;
  const s = Math.min(availW / bbox.width, availH / bbox.height);
  const scaledW = bbox.width*s, scaledH = bbox.height*s;
  const tx = (targetVB.x + pad) + (availW - scaledW)/2 - bbox.x*s;
  const ty = (targetVB.y + pad) + (availH - scaledH)/2 - bbox.y*s;

  // Build output
  const out = document.createElementNS('http://www.w3.org/2000/svg','svg');
  out.setAttribute('xmlns','http://www.w3.org/2000/svg');
  out.setAttribute('viewBox', `${targetVB.x} ${targetVB.y} ${targetVB.w} ${targetVB.h}`);
  out.setAttribute('preserveAspectRatio','xMidYMid meet');
  out.setAttribute('data-slot', slot);

  const hasAnim = /<animate(?:Transform|Motion)?\b|@keyframes/i.test(safe);
  if (hasAnim) out.setAttribute('data-anim','1');

  if (defs) out.appendChild(defs.cloneNode(true));
  const style = svgIn.querySelector('style'); if (style) out.appendChild(style.cloneNode(true));

  const wrap = document.createElementNS('http://www.w3.org/2000/svg','g');
  wrap.setAttribute('transform', `translate(${tx.toFixed(3)} ${ty.toFixed(3)}) scale(${s.toFixed(5)})`);

  // Append original visible nodes (from original svg, not measured clones)
  Array.from(container.querySelectorAll('svg > *')).forEach(n=>{
    const t = n.tagName?.toLowerCase?.();
    if (!t || t==='defs'||t==='metadata'||t==='title'||t==='desc'||t==='style') return;
    wrap.appendChild(n);
  });
  out.appendChild(wrap);

  try { measureHost.removeChild(meas); } catch {}
  return out.outerHTML.replace(/\s{2,}/g,' ').replace(/\s+>/g,'>');
}
  const DRAFT_KEY = 'izzaCraftDraft';
  function saveDraft(){
    try{
      localStorage.setItem(DRAFT_KEY, JSON.stringify({
        n: STATE.currentName,
        cat: STATE.currentCategory,
        part: STATE.currentPart,
        ff: STATE.featureFlags,
        svg: STATE.currentSVG
      }));
    }catch{}
  }
  function loadDraft(){
    try{
      const j = JSON.parse(localStorage.getItem(DRAFT_KEY)||'{}');
      if(!j) return;
      STATE.currentName      = j.n    ?? STATE.currentName;
      STATE.currentCategory  = j.cat  ?? STATE.currentCategory;
      STATE.currentPart      = j.part ?? STATE.currentPart;
      if (j.ff) Object.assign(STATE.featureFlags, j.ff);
      STATE.currentSVG       = j.svg  ?? STATE.currentSVG;
    }catch{}
  }

  function renderTabs(){
    return `
      <div style="display:flex; gap:8px; padding:10px; border-bottom:1px solid #2a3550; background:#0f1624">
        <button class="ghost" data-tab="packages">Packages</button>
        <button class="ghost" data-tab="create">Create Item</button>
        <button class="ghost" data-tab="mine">My Creations</button>
      </div>`;
  }

  function renderPackages(){
  return `
    <div style="padding:14px;">
      <!-- Top toolbar with Marketplace button -->
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px">
        <div style="font-weight:700;opacity:.85">Packages</div>
        <div style="margin-left:auto">
          <button class="ghost" id="goMarketplace">Browse Crafting Land Marketplace</button>
        </div>
      </div>

      <div style="background:#0b111c;border:1px dashed #2a3550;border-radius:10px;padding:10px;margin-bottom:12px;font-size:13px;opacity:.9">
        Coming soon: <b>Battle Packs & Bundles!</b> (multi-mint credits + bonuses)
      </div>

      <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:10px">
        <!-- Starter Forge (disabled actions for now) -->
        <div style="background:#0f1522;border:1px solid #2a3550;border-radius:10px;padding:12px">
          <div style="font-weight:700;margin-bottom:6px">Starter Forge</div>
          <div style="opacity:.85;font-size:13px;line-height:1.4">
            2× Weapons (½-heart dmg), 1× Armour set (+0.25% speed, 25% DR).<br/>Includes features & listing rights.
          </div>
          <div style="margin-top:8px;font-weight:700">
            Cost: ${COSTS.PACKAGE_PI} Pi or ${COSTS.PACKAGE_IC.toLocaleString()} IC
          </div>
          <div style="display:flex;gap:8px;margin-top:10px;justify-content:flex-end;flex-wrap:wrap">
            <button class="ghost" data-buy-package="pi">Pay ${COSTS.PACKAGE_PI} Pi</button>
            <button class="ghost" data-buy-package="ic">Pay ${COSTS.PACKAGE_IC.toLocaleString()} IC</button>
          </div>
          <div style="margin-top:8px;font-size:12px;opacity:.75">Coming soon — bundles are not active yet.</div>
        </div>

        <!-- Single Item (visual) -->
        <div style="background:#0f1522;border:1px solid #2a3550;border-radius:10px;padding:12px">
          <div style="font-weight:700;margin-bottom:6px">Single Item (visual)</div>
          <div style="opacity:.85;font-size:13px;">Craft 1 item (no gameplay features).</div>
          <div style="display:flex;gap:8px;margin-top:10px;justify-content:flex-end;flex-wrap:wrap">
            <!-- These now just route to Create → Setup; payment happens there -->
            <button class="ghost" data-go-single="pi">Pay ${COSTS.PER_ITEM_PI} Pi</button>
            <button class="ghost" data-go-single="ic">Pay ${COSTS.PER_ITEM_IC.toLocaleString()} IC</button>
          </div>
        </div>
      </div>
    </div>`;
}

  function renderCreate(){
  const totalPi = calcTotalCost({ usePi:true });
  const totalIC = calcTotalCost({ usePi:false });
  const sub = STATE.canUseVisuals ? (STATE.createSub === 'visuals' ? 'visuals' : 'setup') : 'setup';
  const visualsDisabledCls = STATE.canUseVisuals ? '' : 'disabled';

  return `
    <div class="cl-subtabs">
      <button class="${sub==='setup'?'on':''}"   data-sub="setup">Setup</button>
      <button class="${sub==='visuals'?'on':''} ${visualsDisabledCls}" data-sub="visuals" ${STATE.canUseVisuals?'':'disabled'}>Visuals</button>
    </div>

    <div class="cl-body ${sub}">
      <div class="cl-pane cl-form">
        <div style="font-weight:700;margin-bottom:6px">Item Setup</div>

        <label style="display:block;margin:6px 0 4px;font-size:12px;opacity:.8">Category</label>
        <select id="catSel">
          <option value="armour">Armour</option>
          <option value="weapon">Weapon</option>
          <option value="apparel">Apparel</option>
          <option value="merch">Merch/Collectible</option>
        </select>

        <label style="display:block;margin:8px 0 4px;font-size:12px;opacity:.8">Part / Type</label>
        <!-- options are populated dynamically to keep Weapon => Gun/Melee only -->
        <select id="partSel"></select>

        <label style="display:block;margin:10px 0 4px;font-size:12px;opacity:.8">Item Name</label>
        <input id="itemName" type="text" maxlength="28" placeholder="Name…" style="width:100%"/>

        <div style="margin-top:10px;font-weight:700">Optional Features</div>
        <label><input type="checkbox" data-ff="dmgBoost"/> Weapon damage boost</label><br/>
        <label><input type="checkbox" data-ff="fireRate"/> Gun fire-rate (server-capped)</label><br/>
        <label><input type="checkbox" data-ff="speedBoost"/> Speed boost</label><br/>
        <label><input type="checkbox" data-ff="dmgReduction"/> Armour damage reduction</label><br/>
        <label><input type="checkbox" data-ff="tracerFx"/> Bullet tracer FX</label><br/>
        <label><input type="checkbox" data-ff="swingFx"/> Melee swing FX</label>

        <div style="margin-top:10px; font-size:13px; opacity:.85">
          Total (visual + selected features): <b>${totalPi} Pi</b> or <b>${totalIC} IC</b>
        </div>

        <div style="display:flex; gap:8px; margin-top:10px; flex-wrap:wrap; align-items:center">
  <button class="ghost" id="payPi">Pay ${COSTS.PER_ITEM_PI} Pi</button>
  <button class="ghost" id="payIC">Pay ${COSTS.PER_ITEM_IC.toLocaleString()} IC</button>
  <span id="payStatus" style="font-size:12px; opacity:.8"></span>
  <span id="mintBalance" style="margin-left:auto; font-size:12px; opacity:.85">
    Credits: <b>${STATE.mintCredits ?? 0}</b>
  </span>
</div>

<!-- NEXT → Visuals (only shows when fields ok & credits > 0) -->
<div id="nextRow" style="display:none; margin-top:10px">
  <button class="ghost" id="goNext">Next → Visuals</button>
  <span id="nextHint" style="font-size:12px; opacity:.8"></span>
</div>

        <!-- SINGLE Shop Listing block (no duplicates) -->
        <div style="margin-top:12px;border-top:1px solid #2a3550;padding-top:10px">
          <div style="font-weight:700;margin-bottom:6px">Shop Listing</div>
          <div style="font-size:12px;opacity:.8">Set price (server range ${COSTS.SHOP_MIN_IC}-${COSTS.SHOP_MAX_IC} IC)</div>
          <input id="shopPrice" type="number" min="${COSTS.SHOP_MIN_IC}" max="${COSTS.SHOP_MAX_IC}" value="100" style="width:120px"/>
          <div style="margin-top:6px">
            <label><input id="sellInShop" type="checkbox" checked/> List in in-game shop (IC)</label><br/>
            <label><input id="sellInPi" type="checkbox"/> Also list in my IZZA Pay merchant dashboard</label>
          </div>
        </div>
      </div>

      <div class="cl-pane cl-preview">
        <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap">
          <div style="font-weight:700">Visuals</div>
          <div style="font-size:12px; opacity:.75">AI attempts left: <b id="aiLeft2">${STATE.aiAttemptsLeft}</b></div>

        <!-- Style / Animation controls -->
          <div style="display:flex; gap:8px; align-items:center; margin-left:auto">
            <label style="font-size:12px; opacity:.8">Style</label>
            <select id="aiStyleSel">
              <option value="realistic">Realistic</option>
              <option value="cartoon">Cartoon / Stylized</option>
            </select>
            <label style="font-size:12px; opacity:.8; margin-left:12px">
              <input type="checkbox" id="aiAnimChk"/> Add animation (premium)
            </label>
          </div>
        </div>

        <div style="display:flex; gap:10px; margin-top:6px">
          <input id="aiPrompt" placeholder="Describe your item…" style="flex:1"/>
          <button class="ghost" id="btnAI">AI → SVG</button>
        </div>
        <div style="font-size:12px; opacity:.75; margin-top:6px">or paste/edit SVG manually</div>
        <textarea id="svgIn" style="width:100%; height:200px; margin-top:6px" placeholder="<svg>…</svg>"></textarea>

        <div class="cl-actions" style="margin-top:8px; display:flex; gap:8px; flex-wrap:wrap">
          <button class="ghost" id="btnPreview">Preview</button>
          <button class="ghost" id="btnMint" style="display:none" title="Mint this item into the game!">Mint</button>
          <span id="craftStatus" style="font-size:12px; opacity:.8"></span>
        </div>

        <div id="svgPreview"
             style="margin-top:10px; background:#0f1522; border:1px solid #2a3550; border-radius:10px;
                    min-height:220px; max-height:min(60vh,520px); overflow:auto;
                    display:flex; align-items:center; justify-content:center">
          <div style="opacity:.6; font-size:12px">Preview appears here</div>
        </div>
      </div>
    </div>`;
}
  function renderMine(){
    return `
      <div style="padding:14px">
        <div style="font-weight:700;margin-bottom:6px">My Creations</div>
        <div id="mineList" style="display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:10px"></div>
      </div>`;
  }
  // --- NEW: Crafting Land Marketplace view (internal page) ---
  function renderMarketplace(){
    return `
      <div style="padding:14px">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <div style="font-weight:700">Crafting Land Marketplace</div>
          <div style="margin-left:auto;display:flex;gap:8px;flex-wrap:wrap">
            <button class="ghost" id="mpBack">← Back to Packages</button>
          </div>
        </div>
        <div style="opacity:.85;font-size:13px;margin-top:6px">
          Browse player-created bundles offered for Pi.
        </div>

        <div id="mpList" style="margin-top:10px; display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:10px">
          <div style="opacity:.7">Loading…</div>
        </div>
      </div>`;
  }
  // ---- Shop Stats Modal (simple) ----
function ensureStatsModal(){
  let m = document.getElementById('shopStatsModal');
  if (m) return m;
  m = document.createElement('div');
  m.id = 'shopStatsModal';
  m.style.cssText = 'position:fixed;inset:0;display:none;align-items:center;justify-content:center;z-index:100000;background:rgba(0,0,0,.45);backdrop-filter:blur(2px)';
  m.innerHTML = `
    <div style="background:#0f1522;border:1px solid #2a3550;border-radius:12px;min-width:280px;max-width:92vw;padding:12px 14px;color:#e7ecff">
      <div style="display:flex;gap:8px;align-items:center">
        <div style="font-weight:700">Shop Stats</div>
        <button class="ghost" id="statsClose" style="margin-left:auto">Close</button>
      </div>
      <div id="statsBody" style="margin-top:8px;font-size:13px;opacity:.95">Loading…</div>
    </div>`;
  document.body.appendChild(m);
  m.querySelector('#statsClose').addEventListener('click', ()=> m.style.display='none');
  m.addEventListener('click', (e)=> { if (e.target===m) m.style.display='none'; });
  return m;
}

async function openStatsModal(itemId){
  const modal = ensureStatsModal();
  const body = modal.querySelector('#statsBody');
  modal.style.display = 'flex';
  body.textContent = 'Loading…';
  try{
    // your server should return: { ok:true, stats:{ purchases: n, resales: n, revenueIC: n, revenuePi: n } }
    const j = await appJSON(`/api/shop/stats?itemId=${encodeURIComponent(itemId)}`);
    const st = (j && j.ok && j.stats) ? j.stats : { purchases:0, resales:0, revenueIC:0, revenuePi:0 };
    body.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <div><div style="opacity:.7;font-size:12px">Purchases</div><div style="font-weight:700">${st.purchases|0}</div></div>
        <div><div style="opacity:.7;font-size:12px">Resales to Shop</div><div style="font-weight:700">${st.resales|0}</div></div>
        <div><div style="opacity:.7;font-size:12px">Revenue (IC)</div><div style="font-weight:700">${(st.revenueIC||0).toLocaleString()}</div></div>
        <div><div style="opacity:.7;font-size:12px">Revenue (Pi)</div><div style="font-weight:700">${st.revenuePi||0}</div></div>
      </div>`;
  }catch(e){
    body.textContent = 'Failed to load stats.';
  }
}

async function addToShop(itemId){
  try{
    // Optional: you can prompt for price here or use the stored price from creation
    // Server expects { ok:true } and will mark the item as inShop=true server-side
    const j = await appJSON('/api/shop/add', {
      method:'POST',
      body: JSON.stringify({ itemId })
    });
    return !!(j && j.ok);
  }catch{
    return false;
  }
}
  function currentUsername(){
  // adjust if your player name lives elsewhere; these are safe fallbacks:
  return (window?.IZZA?.player?.username)
      || (window?.IZZA?.me?.username)
      || localStorage.getItem('izzaPlayer')     // if you store it
      || localStorage.getItem('pi_username')    // if you store it
      || '';
}

// REPLACE THE ENTIRE fetchMine FUNCTION WITH THIS
async function fetchMine(){
  try{
    const uName = currentUsername() || '';
    const url = uName ? `/api/crafting/mine?u=${encodeURIComponent(uName)}` : `/api/crafting/mine`;
    // Crafting/mine lives on Flask → use appJSON (APP_BASE)
    const j = await appJSON(url, { method: 'GET' });
    return (j && j.ok && Array.isArray(j.items)) ? j.items : [];
  }catch(e){
    console.warn('[craft] fetchMine failed:', e);
    return [];
  }
}

  function mineCardHTML(it){
  const safeSVG = sanitizeSVG(it.svg||'');
  const listed = !!it.inShop; // server should return this boolean for each item
  const primaryBtn = listed
    ? `<button class="ghost" data-stats="${it.id}">View Shop Stats</button>`
    : `<button class="ghost" data-addshop="${it.id}">Add to Shop</button>`;

  return `
    <div style="background:#0f1522;border:1px solid #2a3550;border-radius:10px;padding:10px">
      <div style="font-weight:700">${it.name||'Untitled'}</div>
      <div style="opacity:.75;font-size:12px">${it.category||'?'} / ${it.part||'?'}</div>
      <div style="margin-top:6px;border:1px solid #2a3550;border-radius:8px;background:#0b0f17;overflow:hidden;min-height:80px">
        ${safeSVG || '<div style="opacity:.6;padding:10px;font-size:12px">No SVG</div>'}
      </div>
      <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;justify-content:flex-end">
        <button class="ghost" data-copy="${it.id}">Copy SVG</button>
        <button class="ghost" data-equip="${it.id}">Equip</button>
        ${primaryBtn}
      </div>
    </div>`;
}
  // --- NEW: Marketplace bundle card renderer ---
  function marketplaceCardHTML(b){
    // Expecting fields like: { id, name, svg, pricePi, creator }
    const safeSVG = sanitizeSVG(b.svg || '');
    const price = (typeof b.pricePi === 'number' ? b.pricePi : b.pricePi ? Number(b.pricePi) : null);
    const priceLabel = (price != null && isFinite(price)) ? `${price} Pi` : '—';

    return `
      <div style="background:#0f1522;border:1px solid #2a3550;border-radius:10px;padding:10px">
        <div style="display:flex;gap:6px;align-items:center;justify-content:space-between">
          <div style="font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${b.name || 'Bundle'}</div>
          <div style="font-size:12px;opacity:.75">${priceLabel}</div>
        </div>
        <div style="opacity:.75;font-size:12px;margin-top:2px">
          by ${b.creator || 'unknown'}
        </div>
        <div style="margin-top:6px;border:1px solid #2a3550;border-radius:8px;background:#0b0f17;overflow:hidden;min-height:80px">
          ${safeSVG || '<div style="opacity:.6;padding:10px;font-size:12px">No preview</div>'}
        </div>
        <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;justify-content:flex-end">
          <button class="ghost" data-mp-view="${b.id}">View</button>
          <button class="ghost" data-mp-buy="${b.id}">Buy</button>
        </div>
      </div>`;
  }

// CSS.escape ponyfill (safe if native missing)
if (!window.CSS) window.CSS = {};
if (!CSS.escape) {
  // MDN ponyfill
  CSS.escape = function(value) {
    const str = String(value);
    const length = str.length;
    let result = '';
    let index = -1;
    while (++index < length) {
      const codeUnit = str.charCodeAt(index);
      // Null character
      if (codeUnit === 0x0000) {
        result += '\uFFFD';
        continue;
      }
      // Control characters
      if (
        (codeUnit >= 0x0001 && codeUnit <= 0x001F) ||
        codeUnit === 0x007F
      ) {
        result += '\\' + codeUnit.toString(16) + ' ';
        continue;
      }
      // Start with a digit, or a hyphen followed by a digit
      if (
        (index === 0 && codeUnit >= 0x0030 && codeUnit <= 0x0039) ||
        (index === 1 &&
          codeUnit >= 0x0030 && codeUnit <= 0x0039 &&
          str.charCodeAt(0) === 0x002D)
      ) {
        result += '\\' + codeUnit.toString(16) + ' ';
        continue;
      }
      // Safe characters
      if (
        codeUnit === 0x002D || codeUnit === 0x005F || // - _
        (codeUnit >= 0x0030 && codeUnit <= 0x0039) || // 0-9
        (codeUnit >= 0x0041 && codeUnit <= 0x005A) || // A-Z
        (codeUnit >= 0x0061 && codeUnit <= 0x007A)    // a-z
      ) {
        result += str.charAt(index);
        continue;
      }
      // Everything else
      result += '\\' + str.charAt(index);
    }
    return result;
  };
}

  async function hydrateMine(){
  const host = STATE.root?.querySelector('#mineList');
  if (!host) return;

  // Loading state
  host.innerHTML = '<div style="opacity:.7">Loading…</div>';

  // Pull items
  const items = await fetchMine();

  // Render cards
  host.innerHTML = (items && items.length)
    ? items.map(mineCardHTML).join('')
    : '<div style="opacity:.7">No creations yet.</div>';

  // --- COPY SVG ---
  host.querySelectorAll('[data-copy]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const id = btn.dataset.copy;
      const it = items.find(x => String(x.id) === String(id));
      if (!it) return;
      const text = it.svg || '';
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
        } else {
          // fallback
          const ta = document.createElement('textarea');
          ta.value = text; document.body.appendChild(ta);
          ta.select(); try{ document.execCommand('copy'); }catch{}
          document.body.removeChild(ta);
        }
        alert('SVG copied');
      } catch {}
    }, { passive:true });
  });

  // --- EQUIP ---
  host.querySelectorAll('[data-equip]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const id = btn.dataset.equip;
      const it = items.find(x => String(x.id) === String(id));
      if (!it) return;

      // Persist last equipped
      try {
        localStorage.setItem('izzaLastEquipped', JSON.stringify({
          id: it.id, name: it.name, category: it.category, part: it.part, svg: it.svg
        }));
      } catch {}

      // Game events (both old + new)
      try { IZZA?.emit?.('equip-crafted', it.id); } catch {}
      try { IZZA?.emit?.('equip-crafted-v2', {
        id: it.id, name: it.name, category: it.category, part: it.part, svg: it.svg
      }); } catch {}
    }, { passive:true });
  });

  // --- ADD TO SHOP ---
  host.querySelectorAll('[data-addshop]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const id = btn.dataset.addshop;
      btn.disabled = true;
      const prev = btn.textContent;
      btn.textContent = 'Adding…';
      const ok = await addToShop(id);
      if (ok){
        // swap button to "View Shop Stats" and wire it
        btn.outerHTML = `<button class="ghost" data-stats="${id}">View Shop Stats</button>`;
        const statsBtn = host.querySelector(`[data-stats="${CSS.escape(String(id))}"]`);
        if (statsBtn){
          statsBtn.addEventListener('click', ()=> openStatsModal(id), { passive:true });
        }
      } else {
        alert('Failed to add to shop');
        btn.disabled = false;
        btn.textContent = prev || 'Add to Shop';
      }
    }, { passive:true });
  });

  // --- VIEW STATS ---
  host.querySelectorAll('[data-stats]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const id = btn.dataset.stats;
      if (id) openStatsModal(id);
    }, { passive:true });
  });
}
    // --- NEW: Marketplace data fetcher ---
  async function fetchMarketplace(){
    try{
      // Placeholder endpoint; your server should return: { ok:true, bundles:[{id,name,svg,pricePi,creator}, ...] }
      const j = await appJSON('/api/marketplace/list');
      return (j && j.ok && Array.isArray(j.bundles)) ? j.bundles : [];
    }catch{
      return [];
    }
  }

  // --- NEW: Marketplace hydrator ---
  async function hydrateMarketplace(){
    const host = STATE.root?.querySelector('#mpList');
    if (!host) return;
    host.innerHTML = '<div style="opacity:.7">Loading…</div>';

    const bundles = await fetchMarketplace();

    host.innerHTML = bundles.length
      ? bundles.map(marketplaceCardHTML).join('')
      : '<div style="opacity:.7">No bundles yet. Creators can publish bundles from My Creations.</div>';

    // Wire "View" and "Buy" buttons (they can be no-ops for now, or emit your events)
    host.querySelectorAll('[data-mp-view]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const id = btn.dataset.mpView;
        try { IZZA?.emit?.('marketplace-view', { id }); } catch {}
        alert('Bundle details would open here (implement in-game).');
      });
    });

    host.querySelectorAll('[data-mp-buy]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const id = btn.dataset.mpBuy;
        try { IZZA?.emit?.('marketplace-buy', { id }); } catch {}
        alert('Purchase flow would start here (implement in-game / server).');
      });
    });
  }
  async function mount(rootSel){
  const root = (typeof rootSel==='string') ? document.querySelector(rootSel) : rootSel;
  if (!root) return;
  STATE.root = root;
  STATE.mounted = true;
  loadDraft();
applyCraftPaidFromURL();
await syncCreditsFromServer(); // NEW: server is the source of truth
// Try server-side reconcile (same idea as /orders page)
try {
  await appJSON('/api/crafting/credits/reconcile', { method:'POST' });
  await syncCreditsFromServer(); // pull updated credit count after reconcile
} catch(_) { /* non-fatal */ }
  root.innerHTML = `${renderTabs()}<div id="craftTabs"></div>`;
  const tabsHost = root.querySelector('#craftTabs');

  const setTab = (name)=>{
    if(!STATE.mounted) return;
    if(name==='packages'){ tabsHost.innerHTML = renderPackages(); }
    if(name==='create'){   tabsHost.innerHTML = renderCreate(); }
        // keep attempts counter in sync when entering Visuals
    if (name === 'create' && STATE.canUseVisuals) {
      try {
        const el = document.getElementById('aiLeft2');
        if (el) el.textContent = STATE.aiAttemptsLeft;
      } catch {}
    }
    if(name==='mine'){     tabsHost.innerHTML = renderMine(); hydrateMine(); }

    bindInside();

    // immediately sync the attempts counter when entering Create
    if (name === 'create') {
      try {
        const el = document.getElementById('aiLeft2');
        if (el) el.textContent = STATE.aiAttemptsLeft;
      } catch {}
    }
  };

  root.querySelectorAll('[data-tab]').forEach(b=>{
    b.addEventListener('click', ()=> setTab(b.dataset.tab));
  });

  setTab('packages');
}

  function unmount(){ if(!STATE.root) return; STATE.root.innerHTML=''; STATE.mounted=false; }

    // REPLACE the whole function starting at "async function handleBuySingle(kind){" with this:
// handleBuySingle — keep only this version
async function handleBuySingle(kind){
  const usePi = (kind === 'pi');
  const total = calcTotalCost({ usePi });

  if (usePi) {
    const url = craftCheckoutURL({
      totalPi: total,
      name: STATE.currentName,
      category: STATE.currentCategory,
      part: STATE.currentPart
    });
    try { (window.top || window).location.assign(url); }
    catch { window.location.href = url; }
    return;
  }

  // IC path stays local
  const res = await payWithIC(total);
  const status = document.getElementById('payStatus');
    if (res && res.ok){
  // Server already persisted the credit; pull the canonical number
  await syncCreditsFromServer();

    STATE.hasPaidForCurrentItem = false;
    STATE.canUseVisuals = false;
    STATE.aiAttemptsLeft = COSTS.AI_ATTEMPTS;

    if (status) status.textContent = 'Credit added ✓ — fill the fields, then tap Next to open Visuals.';
    const host = STATE.root?.querySelector('#craftTabs');
    if (host){ host.innerHTML = renderCreate(); bindInside(); }
  } else {
    if (status) status.textContent='Payment failed.';
    STATE.canUseVisuals = false;
  }
}
  function bindInside(){
  const root = STATE.root;
  if(!root) return;

  // --- helpers (scoped to this bind) ---
  const getEl = (sel)=> root.querySelector(sel);
  const fieldsReady = ()=>{
    const cat  = getEl('#catSel')?.value?.trim();
    const part = getEl('#partSel')?.value?.trim();
    const name = getEl('#itemName')?.value?.trim();
    STATE.currentCategory = cat || STATE.currentCategory;
    STATE.currentPart     = part || STATE.currentPart;
    STATE.currentName     = name || STATE.currentName;
    return Boolean(cat && part && name && name.length >= 3);
  };
    const setPayEnabled = ()=>{
    const ready = fieldsReady();
    const payPi = getEl('#payPi');
    const payIC = getEl('#payIC');
    if (payPi){ payPi.disabled = !ready; payPi.title = ready ? '' : 'Fill Category, Part, and Name first'; }
    if (payIC){ payIC.disabled = !ready; payIC.title = ready ? '' : 'Fill Category, Part, and Name first'; }

    // Next row logic
    const nextRow  = getEl('#nextRow');
    const nextHint = getEl('#nextHint');
    const credits  = STATE.mintCredits ?? 0;
    if (nextRow){
      const canShow = ready && credits > 0;
      nextRow.style.display = canShow ? 'block' : 'none';
      if (!canShow && nextHint) {
        nextHint.textContent = credits > 0 ? '' : 'Buy a credit to continue.';
      } else if (nextHint) {
        nextHint.textContent = '';
      }
    }
    // balance label
    const bal = getEl('#mintBalance');
    if (bal) bal.innerHTML = `Credits: <b>${credits}</b>`;
  };
  const toCreateSetup = ()=>{
    STATE.createSub = 'setup';
    STATE.hasPaidForCurrentItem = false;
    STATE.canUseVisuals = false;
    const tabs = STATE.root?.querySelectorAll('[data-tab]');
    const createBtn = Array.from(tabs||[]).find(b=>b.dataset.tab==='create');
    if (createBtn) createBtn.click();
    else {
      const host = STATE.root?.querySelector('#craftTabs');
      if (host){ host.innerHTML = renderCreate(); bindInside(); }
    }
  };
  const aiLeft = ()=> {
    const a = document.getElementById('aiLeft');  if (a) a.textContent = STATE.aiAttemptsLeft;
    const b = document.getElementById('aiLeft2'); if (b) b.textContent = STATE.aiAttemptsLeft;
  };

  // ===================== PACKAGES TAB WIRING =====================
  const goMp = getEl('#goMarketplace');
  if (goMp){
    goMp.addEventListener('click', async ()=>{
      try{ IZZA?.emit?.('open-marketplace'); }catch{}
      const host = STATE.root?.querySelector('#craftTabs');
      if (!host) return;
      const saveScroll = host.scrollTop;
      host.innerHTML = renderMarketplace();
      const back = STATE.root.querySelector('#mpBack');
      if (back){
        back.addEventListener('click', ()=>{
          host.innerHTML = renderPackages();
          bindInside();
          host.scrollTop = saveScroll;
        });
      }
      await hydrateMarketplace();
    });
  }

  // Bundle/package buttons → coming soon (no payment)
  root.querySelectorAll('[data-buy-package]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      alert('Coming soon: Battle Packs & Bundles!');
    }, { passive:true });
  });

  // Single Item buttons on Packages card → route to Create → Setup (no payment yet)
  root.querySelectorAll('[data-go-single]').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    toCreateSetup();
    const status = document.getElementById('payStatus');
    if (status) status.textContent = 'Choose Category, Part, and Name, then pay to unlock Visuals.';
  }, { passive:true });
});

  // ===================== CREATE TAB WIRING =====================

  // Inputs: Category / Part / Name
  const itemName = getEl('#itemName');
  const catSel   = getEl('#catSel');
  const partSel  = getEl('#partSel');

  // Initialize select values & options
  if (catSel && partSel){
    catSel.value = STATE.currentCategory;
    repopulatePartOptions(catSel, partSel);
  }
  if (partSel){ partSel.value = STATE.currentPart; }
  if (itemName){ itemName.value = STATE.currentName || ''; }

  // React to changes → save + toggle pay buttons
  if (itemName){
    itemName.addEventListener('input', e=>{
      STATE.currentName = e.target.value;
      setPayEnabled();
      try{ saveDraft(); }catch{}
    }, { passive:true });
  }
  if (catSel){
    catSel.addEventListener('change', e=>{
      STATE.currentCategory = e.target.value;
      repopulatePartOptions(catSel, partSel);
      setPayEnabled();
      try{ saveDraft(); }catch{}
    }, { passive:true });
  }
  if (partSel){
    partSel.addEventListener('change', e=>{
      STATE.currentPart = e.target.value;
      setPayEnabled();
      try{ saveDraft(); }catch{}
    }, { passive:true });
  }

  // Optional features (rerender to recompute totals)
  root.querySelectorAll('[data-ff]').forEach(cb=>{
    const key = cb.dataset.ff;
    if (STATE.featureFlags && key in STATE.featureFlags) cb.checked = !!STATE.featureFlags[key];
    cb.addEventListener('change', ()=>{
      STATE.featureFlags[key] = cb.checked;
      try{ saveDraft(); }catch{}
      const host = root.querySelector('#craftTabs');
      if (!host) return;
      const saveScroll = host.scrollTop;
      host.innerHTML = renderCreate();
      bindInside();
      host.scrollTop = saveScroll;
    });
  });

  // Pay buttons (on Create → Setup): disabled until fieldsReady()
  const payPi = getEl('#payPi');
  const payIC = getEl('#payIC');
  setPayEnabled();
  if (payPi) payPi.addEventListener('click', ()=> handleBuySingle('pi'), { passive:true });
  if (payIC) payIC.addEventListener('click', ()=> handleBuySingle('ic'), { passive:true });
      // Next → Visuals (consume one credit)
  const nextBtn = getEl('#goNext');
  if (nextBtn){
    nextBtn.addEventListener('click', ()=>{
      if (!fieldsReady()) return;
      if (!consumeMintCredit()) return; // no credit

      STATE.mintCredits = getMintCredits();
      STATE.canUseVisuals = true;
      STATE.createSub = 'visuals';
      STATE.aiAttemptsLeft = COSTS.AI_ATTEMPTS;

      const host = STATE.root?.querySelector('#craftTabs');
      if (host){ host.innerHTML = renderCreate(); bindInside(); }

      // sync attempts immediately
      try{
        const el = document.getElementById('aiLeft2');
        if (el) el.textContent = STATE.aiAttemptsLeft;
      }catch{}
    }, { passive:true });
  }

  // Style / Animation selections
  const aiStyleSel = getEl('#aiStyleSel');
  const aiAnimChk  = getEl('#aiAnimChk');
  if (aiStyleSel){
    aiStyleSel.value = STATE.aiStyle;
    aiStyleSel.addEventListener('change', e=>{ STATE.aiStyle = e.target.value; try{ saveDraft(); }catch{} });
  }
  if (aiAnimChk){
    aiAnimChk.checked = !!STATE.wantAnimation;
    aiAnimChk.addEventListener('change', e=>{ STATE.wantAnimation = !!e.target.checked; try{ saveDraft(); }catch{} });
  }

  // Visuals panel widgets
  const btnAI    = getEl('#btnAI');
  const aiPrompt = getEl('#aiPrompt');
  const svgIn    = getEl('#svgIn');
  const btnPrev  = getEl('#btnPreview');
  const btnMint  = getEl('#btnMint');
  const prevHost = getEl('#svgPreview');
  const craftStatus = getEl('#craftStatus');

  // Restore current SVG if any
  if (svgIn && STATE.currentSVG){
    svgIn.value = STATE.currentSVG;
    if (prevHost) prevHost.innerHTML = STATE.currentSVG;
  }

  // AI → SVG
  if (btnAI){
    btnAI.addEventListener('click', async ()=>{
      const prompt = String(aiPrompt?.value||'').trim();
      if (!prompt) return;
      btnAI.disabled = true;
      btnAI.setAttribute('aria-busy','true');
      btnAI.textContent = 'Generating…';
      const waitEl = showWait('Crafting your SVG preview…');
      try{
        const [svg] = await Promise.all([ aiToSVG(prompt), sleep(MIN_AI_WAIT_MS) ]);
        if (svgIn) svgIn.value = svg;
        if (prevHost) {
          prevHost.innerHTML = svg;
          const s = prevHost.querySelector('svg');
          if (s){
            s.setAttribute('preserveAspectRatio','xMidYMid meet');
            s.style.maxWidth='100%';
            s.style.height='auto';
            s.style.display='block';
          }
          prevHost.scrollTop = prevHost.scrollHeight;
          prevHost.scrollIntoView({block:'nearest'});
        }
        STATE.currentSVG = svg;
        try{ saveDraft(); }catch{}
        if (btnMint) btnMint.style.display = 'inline-block';
        aiLeft();
      }catch(e){
        alert('AI failed: ' + (e?.message || e));
      }finally{
        hideWait(waitEl);
        btnAI.disabled = false;
        btnAI.removeAttribute('aria-busy');
        btnAI.textContent = 'AI → SVG';
      }
    });
  }

  // Manual preview
  if (btnPrev){
    btnPrev.addEventListener('click', ()=>{
      const cleaned = sanitizeSVG(svgIn?.value);
      if (!cleaned){ alert('SVG failed moderation/sanitize'); return; }
      if (prevHost) {
        prevHost.innerHTML = cleaned;
        const s = prevHost.querySelector('svg');
        if (s){
          s.setAttribute('preserveAspectRatio','xMidYMid meet');
          s.style.maxWidth='100%';
          s.style.height='auto';
          s.style.display='block';
        }
        prevHost.scrollTop = prevHost.scrollHeight;
        prevHost.scrollIntoView({block:'nearest'});
      }
      STATE.currentSVG = cleaned;
      try{ saveDraft(); }catch{}
      if (btnMint) btnMint.style.display = 'inline-block';
    });
  }

  // Mint (full handler with redirect to Setup on success)
  if (btnMint){
    btnMint.addEventListener('click', async ()=>{
      if (!craftStatus) return;
      craftStatus.textContent = '';

      // Basic checks
      const nm = moderateName(STATE.currentName);
      if (!nm.ok){ craftStatus.textContent = nm.reason; return; }

      const freeTest = (COSTS.PER_ITEM_IC === 0 && Object.values(STATE.featureFlags).every(v=>!v));
const unlocked = STATE.canUseVisuals || STATE.hasPaidForCurrentItem || STATE.packageCredits || freeTest;
if (!unlocked){
  craftStatus.textContent = 'Use a credit (Next) or pay first.';
  return;
}
      if (!STATE.currentSVG){ craftStatus.textContent = 'Add/Preview SVG first.'; return; }

      const sellInShop = !!getEl('#sellInShop')?.checked;
      const sellInPi   = !!getEl('#sellInPi')?.checked;
      const priceIC    = Math.max(
        COSTS.SHOP_MIN_IC,
        Math.min(COSTS.SHOP_MAX_IC, parseInt(getEl('#shopPrice')?.value||'100',10)||100)
      );

      try{
        const normalizedForSlot = normalizeSvgForSlot(STATE.currentSVG, STATE.currentPart);

        const injected = await (
  window.ArmourPacks && typeof window.ArmourPacks.injectCraftedItem === 'function'
    ? window.ArmourPacks.injectCraftedItem({
        name: STATE.currentName,
        category: STATE.currentCategory,
        part: STATE.currentPart,
        svg: normalizedForSlot,
        priceIC,
        sellInShop,
        sellInPi,
        featureFlags: STATE.featureFlags
      })
    : { ok: false, reason: 'armour-packs-hook-missing' }
);
        if (injected && injected.ok){
          craftStatus.textContent = 'Crafted ✓';

          // Persist minted item to "Mine" (server reads user from session; no username needed)
try {
  await appJSON('/api/crafting/mine', {
    method: 'POST',
    body: JSON.stringify({
      name: STATE.currentName,
      category: STATE.currentCategory,
      part: STATE.currentPart,
      svg: normalizedForSlot,
      sku: '',
      image: ''
    })
  });
} catch(e) { /* non-fatal */ }

          try{ hydrateMine(); }catch{}
// If player asked to also list in IZZA Pay merchant dashboard, open it with prefilled data
if (sellInPi) {
  try {
    const r = await 
appJSON('/api/merchant/create_product_from_craft', {
      method: 'POST',
      body: JSON.stringify({
        name: STATE.currentName,
        image: '',
        price_pi: 0,
        description: `${STATE.currentCategory} / ${STATE.currentPart}`,
        crafted_item_id: ''
      })
    });
    if (r && r.ok && r.dashboardUrl) {
      window.location.href = r.dashboardUrl;
      return; // stop the reset because we’re navigating
    }
  } catch(e) {
    console.warn('IZZA Pay prefill failed', e);
  }
}
          // Reset for next single item & return to Setup
          STATE.hasPaidForCurrentItem = false;
          STATE.canUseVisuals = false;
          STATE.createSub = 'setup';
          // Keep their category/part/name as-is (faster flow), but clear the SVG & preview
          STATE.currentSVG = '';
          if (svgIn) svgIn.value = '';
          if (prevHost) prevHost.innerHTML = `<div style="opacity:.6; font-size:12px">Preview appears here</div>`;

          // Re-render Create → Setup so Pay buttons reappear (disabled state handled by setPayEnabled)
          const host = STATE.root?.querySelector('#craftTabs');
          if (host){
            host.innerHTML = renderCreate();
            bindInside();
          }
        } else {
          craftStatus.textContent = 'Mint failed: ' + (injected?.reason || 'armour hook missing');
        }
      }catch(e){
        craftStatus.textContent = 'Error crafting: ' + e.message;
      }
    });
  }

  // Make sure pay buttons state is correct on entry
  setPayEnabled();
  // Keep attempts label fresh if present
  aiLeft();

  // --- SHOP card actions in "My Creations" (if that tab is mounted) ---
  root.querySelectorAll('[data-addshop]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const id = btn.dataset.addshop;
      btn.disabled = true;
      const prev = btn.textContent;
      btn.textContent = 'Adding…';
      const ok = await addToShop(id);
      if (ok){
        btn.outerHTML = `<button class="ghost" data-stats="${id}">View Shop Stats</button>`;
        const statsBtn = root.querySelector(`[data-stats="${CSS.escape(String(id))}"]`);
        if (statsBtn){
          statsBtn.addEventListener('click', ()=> openStatsModal(id), { passive:true });
        }
      } else {
        alert('Failed to add to shop');
        btn.disabled = false;
        btn.textContent = prev || 'Add to Shop';
      }
    }, { passive:true });
  });

  root.querySelectorAll('[data-stats]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const id = btn.dataset.stats;
      if (id) openStatsModal(id);
    }, { passive:true });
});
    }
window.CraftingUI = { mount, unmount };
})();
