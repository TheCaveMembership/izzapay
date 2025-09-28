// /static/game/js/plugins/crafting/crafting_ui.js

// ========================= BASE HELPERS (single source of truth) =========================
// Core/Game side (AI, credits, crafting data)
const GAME_BASE = 'https://izzagame.onrender.com';
// IZZA Pay side (checkout, voucher codes, Pi approval/complete)
const PAY_BASE  = 'https://izzapay.onrender.com';

// Build absolute URLs to the correct origin
const gameApi = (p) => `${GAME_BASE}${String(p || '').replace(/^\/+/, '/')}`;
const payApi  = (p) => `${PAY_BASE}${String(p || '').replace(/^\/+/, '/')}`;

// ----------------------------------------------------------------------------------------

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

// --- Pi SDK bootstrap (safe, idempotent) ---
async function ensurePiInit(){
  try{
    if (!window.Pi || typeof window.Pi.init !== 'function') return false;
    if (window.__PI_INITED__) return true;

    // If your template sets a global, use it; otherwise fallback to false.
    const sandbox =
      (typeof window.PI_SANDBOX !== 'undefined' ? !!window.PI_SANDBOX : false);

    await window.Pi.init({ version: '2.0', sandbox });
    window.__PI_INITED__ = true;
    return true;
  }catch(e){
    console.warn('[craft] Pi init failed:', e);
    return false;
  }
}

/* ====== EXACT checkout-style helpers (added) ====== */
// Mirror checkout: init with optional appId + sandbox, then authenticate with recovery.
function initPiExact(){
  try{
    if (!window.Pi || !Pi.init) return false;
    // Re-init is safe; Pi SDK ignores dupes.
    const sandbox = (typeof window.PI_SANDBOX !== 'undefined') ? !!window.PI_SANDBOX : false;
    const appId   = (typeof window.PI_APP_ID   !== 'undefined') ? String(window.PI_APP_ID) : '';
    if (appId) { Pi.init({ version: "2.0", sandbox, appId }); }
    else       { Pi.init({ version: "2.0", sandbox }); }
    return true;
  }catch(e){ return false; }
}

// ===== keep ROOT endpoints here (do NOT wrap with other helpers) =====
// --- Minimal auth + buyer helpers (no email, no shipping) ---
function ensureAuthExact(){
  const scopes = ['payments','username']; // just what we need
  return Pi.authenticate(scopes, onIncompletePaymentFound);
}

function buyerPayload(){
  const uname =
    (window?.IZZA?.me?.username) ||
    (window?.IZZA?.player?.username) ||
    localStorage.getItem('pi_username') ||
    'IZZA Player';
  return { name: uname };
}
// EXACT port: recover incomplete payments via /api/pi/complete
function onIncompletePaymentFound(payment){
  try{
    const sessionId = "craft-credit"; // stable bucket for single mint credit
    const pid  = payment && (payment.identifier || payment.paymentId || payment.id);
    const txid = payment && payment.transaction && (payment.transaction.txid || payment.transaction.txID || payment.transaction.hash) || "";
    if(!pid) return;

    fetch(payApi('/api/pi/complete'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paymentId: pid,
        session_id: sessionId,
        txid,
        buyer: buyerPayload()
      })
    }).then(r => r.ok ? r.json() : null).catch(()=>{});
  }catch(_){}
}

/* ====== REPLACED to mirror checkout.html exactly ====== */
async function payWithPi(amountPi, memo){
  // init exactly like checkout
  if (!initPiExact()){
    alert('Open in Pi Browser to pay.');
    return { ok:false, reason:'no-pi' };
  }
  if (!window.Pi || typeof Pi.createPayment !== 'function'){
    alert('Pi SDK not available');
    return { ok:false, reason:'no-pi' };
  }

  try{
    const sessionId = "craft-credit"; // stable bucket for single mint credit

    // Same auth + recovery as checkout.html
    await ensureAuthExact();

    const storeName = (window.STORE_NAME || 'IZZA PAY');
    const memoText  = (storeName ? (storeName + ' — ') : '') + 'Order ' + sessionId.slice(0,8);

    const paymentData = {
      amount: Number(amountPi),
      memo: memo || memoText,
      // include buyer inside metadata, no email/phone/shipping
      metadata: { session_id: sessionId, buyer: buyerPayload() }
    };

    const res = await Pi.createPayment(paymentData, {
      onReadyForServerApproval: function(paymentId){
        return fetch(payApi('/api/pi/approve'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paymentId, session_id: sessionId })
        });
      },
      onReadyForServerCompletion: function(paymentId, txid){
        return fetch(payApi('/api/pi/complete'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            paymentId,
            session_id: sessionId,
            txid,
            buyer: buyerPayload()
          })
        }).then(r=>r.json()).catch(()=> ({}));
      },
      onCancel: function(){ /* status handled below */ },
      onError:  function(){ /* status handled below */ }
    });

    if (res && typeof res.status === 'string' && /complete/i.test(res.status)){
      return { ok:true, receipt:res };
    }
    return { ok:false, reason:(res && res.status) || 'pi-not-complete', raw:res };

  }catch(e){
    console.warn('[craft] Pi pay failed', e);
    return { ok:false, reason:String(e && e.message || e) };
  }
}
/* ====================================================== */
/* ================================================ */

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

  // Hard constraints (mirror server SYSTEM_PROMPT)
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

(function(){
  const COSTS = Object.freeze({
    // --- Base craft pricing (visual mint) ---
    PER_ITEM_IC:   500,    // 500 IZZA Coins per craft (base)
    PER_ITEM_PI:   0.25,   // 0.25 Pi per craft (base)

    // --- Starter Forge package pricing (unchanged) ---
    PACKAGE_PI:    5,          // 5 Pi
    PACKAGE_IC:    10000,      // 10,000 IC

    // --- Add-on/Shop settings ---
    SHOP_MIN_IC:   50,
    SHOP_MAX_IC:   250,
    AI_ATTEMPTS:   5
  });

  // FYI conversion: 1 Pi = 2000 IZZA coins
  const COIN_PER_PI = 2000;

  const STATE = {
    root: null,
    mounted: false,
    aiAttemptsLeft: COSTS.AI_ATTEMPTS,
    hasPaidForCurrentItem: false,
    currentSVG: '',
    currentName: '',
    featureLevels: {},   // <-- needed so first toggle shows meters without switching category
    featureFlags: {
      // weapon shared
      dmgBoost: false,
      // gun only
      fireRate: false,
      tracerFx: false,
      autoFire: false,
      // melee only
      swingRate: false,
      swingFx: false,
      // armour
      dmgReduction: false, // helmet/vest only
      speedBoost: false    // legs only
    },
    aiStyle: 'realistic',
    wantAnimation: false,
    currentCategory: 'armour',
    currentPart: 'helmet',
    packageCredits: null,
    canUseVisuals: false,
    createSub: 'setup',
    mintCredits: 0,

    // FX presets
    tracerPreset: 'comet',
    swingPreset: 'arcLight',
  };

/* ==== CRAFT FEATURE METERS & PRICE RULES ==== */
/*
  Price rule (per your spec):
  - Each selected toggle adds +0.15 Pi to price.
  - If that toggle has a slider (levels 1..3), the toggle counts as level 1 baseline.
    Each extra step (2 or 3) adds +0.15 Pi again per step.
  - DR slider steps: 5% / 10% / 15% (level 1/2/3). Helmet and Vest each cap at 15%.
  NOTE: We only *display* dynamic Pi total for now, but we *charge* dynamic IZZA Coins.
*/
const TOGGLE_PI_INCREMENT = 0.15;
const CRAFT_BASE = { PI: COSTS.PER_ITEM_PI, IC: COSTS.PER_ITEM_IC };

/* Player-selectable meters (lightweight) */
const FEATURE_METERS = {
  // Weapons (guns)
  fireRate:      { key:'fireIntervalMs',  toValue:(lvl)=> Math.max(60, Math.round(170 - 30*lvl)) }, // lvl 1..3 → faster
  dmgBoost:      { key:'dmgMult',         toValue:(lvl)=> 1.0 + 0.15*lvl },                         // 1.15 / 1.30 / 1.45

  // Weapons (melee)
  swingRate:     { key:'swingIntervalMs', toValue:(lvl)=> Math.max(100, Math.round(220 - 40*lvl)) }, // 1..3

  // Armour
  dmgReduction:  { key:'drPct',           toValue:(lvl)=> 0.05*lvl },                                // 5%/10%/15% per piece
  speedBoost:    { key:'speedMult',       toValue:(lvl)=> 1.0 + 0.05*lvl },                          // +5/10/15% run speed (legs only)
};

/* UI spec (labels + where they apply) */
const METER_UI = {
  // guns
  fireRate:     { label:'Gun Fire Rate',     gate:'gun',      min:1, max:3 },
  dmgBoost:     { label:'Weapon Damage',     gate:'weapon',   min:1, max:3 },

  // melee
  swingRate:    { label:'Melee Swing Rate',  gate:'melee',    min:1, max:3 },

  // armour
  dmgReduction: { label:'Damage Reduction',  gate:'helmVest', min:1, max:3 }, // helmet/vest only (5/10/15)
  speedBoost:   { label:'Speed Boost',       gate:'legs',     min:1, max:3 },
};

/* Which toggles/meters are allowed for the current selection */
function allowedTogglesForSelection(){
  const cat  = String(STATE.currentCategory||'').toLowerCase();
  const part = String(STATE.currentPart||'').toLowerCase();

  // weapon selection
  if (cat==='weapon' && (part==='gun' || part==='hands')) {
  return { toggles:['dmgBoost','fireRate','tracerFx','autoFire'], meters:['dmgBoost','fireRate'] };
}
  if (cat==='weapon' && part==='melee') {
    return { toggles:['dmgBoost','swingRate','swingFx'], meters:['dmgBoost','swingRate'] };
  }

  // armour selection
  if (cat==='armour' && part==='legs') {
    return { toggles:['speedBoost'], meters:['speedBoost'] };
  }
  if (cat==='armour' && (part==='helmet' || part==='vest')) {
    return { toggles:['dmgReduction'], meters:['dmgReduction'] };
  }

  // other armour parts (arms) -> no special options for now
  return { toggles:[], meters:[] };
}

/* --------- CSS for meters and presets ---------- */
(function ensureCraftCSS(){
  if (document.getElementById('crafting-css')) return;
  const css = document.createElement('style'); css.id='crafting-css';
  css.textContent = `
    .meter{display:grid;grid-template-columns:140px 1fr 120px;gap:10px;align-items:center}
    @media (max-width: 480px){
      .meter{grid-template-columns:120px 1fr}
      .meter [data-out]{grid-column:1/-1; text-align:left; opacity:.8; margin-top:2px}
    }
    .preset-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px}
    .preset{border:1px solid #2a3550;border-radius:8px;padding:8px;background:#0b0f17;cursor:pointer}
    .preset.on{box-shadow:inset 0 0 0 1px #1bd760; background:#0b2b17}
    .preset svg{display:block;max-width:100%;height:auto}
    /* IMPORTANT: prevent the range control from hijacking horizontal drags globally on iOS */
    .meter input[type="range"]{ touch-action: pan-y; }
        /* Dedicated interaction box so slider drags don't bleed into the rest of the UI */
    .meter-box{
      margin-top:10px;
      border:1px solid #2a3550;
      border-radius:10px;
      background:#0b0f17;
      padding:10px;
      touch-action: pan-y;              /* vertical scroll allowed; prevents global grab */
      -webkit-tap-highlight-color:transparent;
      contain: layout paint;            /* isolates interactions/painting */
    }
    .meter-box .meter input[type="range"]{ touch-action: pan-y; } /* belt & suspenders */
  `;
  document.head.appendChild(css);
})();

/* Human preview for a meter value */
function meterPreview(mKey, lvl){
  const spec = FEATURE_METERS[mKey]; if (!spec) return '';
  try{
    const v = spec.toValue(lvl|0);
    if (mKey==='fireRate')     return `${v} ms between shots`;
    if (mKey==='swingRate')    return `${v} ms per swing`;
    if (mKey==='dmgBoost')     return `${Math.round(v*100)}% damage`;
    if (mKey==='dmgReduction') return `${Math.round(v*100)}% DR`;
    if (mKey==='speedBoost')   return `${Math.round(v*100)}% run speed`;
    return String(v);
  }catch{ return ''; }
}

/* --------- Dynamic pricing ---------- */
/* Return { pi: number, ic: number } */
function calcDynamicPrice(){
  const allow = allowedTogglesForSelection();
  const flags = STATE.featureFlags || {};
  const levels = STATE.featureLevels || {};

  let pi = CRAFT_BASE.PI; // base visual cost
  // For display only: add dynamic Pi increments
  allow.toggles.forEach(t=>{
    if (!flags[t]) return;
    // Toggle adds one step
    pi += TOGGLE_PI_INCREMENT;
    // If there is an associated meter, add extra steps above lvl=1
    if (allow.meters.includes(t)){
      const lvl = Math.max(1, parseInt(levels[t]||1,10));
      if (lvl > 1) pi += TOGGLE_PI_INCREMENT * (lvl - 1);
    }
  });

  // IC is actually charged
  const ic = Math.round(pi * COIN_PER_PI);

  return { pi: Number(pi.toFixed(2)), ic };
}

/* --------- Meters rendering (only when toggle ON) ---------- */
function renderFeatureMeters(){
  const allow = allowedTogglesForSelection();
  const rows = allow.meters
    .filter(k => STATE.featureFlags[k])
    .map(k=>{
      const ui   = METER_UI[k];
      const raw  = STATE.featureLevels?.[k];
      const lvl  = Math.max(ui.min, (typeof raw==='number' ? raw : ui.min));
      const prev = meterPreview(k, lvl);

      // Horizontal pills with inline styles to defeat any global button CSS
      const pillStyle =
        'display:inline-flex;flex:0 0 auto;width:auto;align-items:center;justify-content:center;' +
        'min-width:28px;height:28px;padding:0 10px;margin:0 6px 0 0;border-radius:6px;' +
        'border:1px solid #2a3550;background:#0b0f17;font-size:12px;font-weight:700;line-height:1;white-space:nowrap;';
      const pills = [];
      for (let i = ui.min; i <= ui.max; i++){
        pills.push(
          `<button type="button"
                   class="lvl-pill ${i===lvl?'on':''}"
                   data-m="${k}" data-lvl="${i}"
                   aria-pressed="${i===lvl?'true':'false'}"
                   style="${pillStyle}">${i}</button>`
        );
      }

      return `
        <div class="meter" data-meter="${k}"
             style="margin:8px 0;display:grid;grid-template-columns:140px 1fr 120px;gap:10px;align-items:center">
          <div style="opacity:.85;font-size:12px">${ui.label}</div>
          <div class="lvl-wrap"
               style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">${pills.join('')}</div>
          <div data-out="${k}" style="font-size:12px;opacity:.8;text-align:right">${prev}</div>
        </div>`;
    });

  const fxBlocks = [];
  if (allow.toggles.includes('tracerFx') && STATE.featureFlags?.tracerFx) fxBlocks.push(renderTracerPicker());
  if (allow.toggles.includes('swingFx')  && STATE.featureFlags?.swingFx)  fxBlocks.push(renderSwingPicker());

  if (!rows.length && !fxBlocks.length) return '';

  // Tiny CSS just for active state + responsive meter grid
  const localCSS = `
    <style>
      .lvl-pill.on{ box-shadow: inset 0 0 0 1px #1bd760; color:#b8ffd1; background:#0b2b17; }
      .lvl-pill:focus{ outline:none; box-shadow:0 0 0 2px rgba(27,215,96,.35); }
      @media (max-width:480px){
        .meter{ grid-template-columns:120px 1fr !important; }
        .meter [data-out]{ grid-column:1/-1; text-align:left; opacity:.8; margin-top:2px }
      }
      .meter-box{
        margin-top:6px;border:1px solid #2a3550;border-radius:10px;background:#0b0f17;padding:10px;
        touch-action: pan-y; -webkit-tap-highlight-color:transparent; contain:layout paint;
      }
    </style>`;

  return `
    <div style="margin-top:12px;border-top:1px solid #2a3550;padding-top:10px">
      ${localCSS}
      <div style="font-weight:700;margin-bottom:6px">Performance Meters</div>
      <div class="meter-box">
        ${rows.join('')}
        ${fxBlocks.join('')}
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:6px">
          <button class="ghost" id="metersReset">Reset</button>
        </div>
      </div>
    </div>`;
}
/* --- FX PRESETS (tiny previews) --- */
const TRACER_PRESETS = [
  { id:'comet',  name:'Comet Spark',  demo:`<svg viewBox="0 0 80 30" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g1" x1="0" x2="1"><stop offset="0" stop-opacity=".0"/><stop offset=".7" stop-opacity=".9"/></linearGradient></defs><path d="M5 15 H75" stroke="url(#g1)" stroke-width="3"/><circle cx="75" cy="15" r="3"/></svg>` },
  { id:'ember',  name:'Fire Trail',   demo:`<svg viewBox="0 0 80 30" xmlns="http://www.w3.org/2000/svg"><path d="M5 15 C30 10 45 20 75 15" stroke="orange" stroke-width="2" fill="none"/><circle cx="75" cy="15" r="3" /></svg>` },
  { id:'prism',  name:'Neon Prism',   demo:`<svg viewBox="0 0 80 30" xmlns="http://www.w3.org/2000/svg"><path d="M5 15 H75" stroke="#7af" stroke-width="2" /><path d="M5 12 H70" stroke="#fa7" stroke-width="1"/><path d="M5 18 H70" stroke="#af7" stroke-width="1"/><circle cx="75" cy="15" r="3"/></svg>` },
  { id:'stardust',name:'Stardust',    demo:`<svg viewBox="0 0 80 30" xmlns="http://www.w3.org/2000/svg"><g opacity=".8"><circle cx="10" cy="15" r="1"/><circle cx="25" cy="13" r="1"/><circle cx="40" cy="16" r="1"/></g><path d="M5 15 H75" stroke="#fff" stroke-width="1.5"/><circle cx="75" cy="15" r="2"/></svg>` },
];

const SWING_PRESETS = [
  { id:'arcLight', name:'Arc Light', demo:`<svg viewBox="0 0 80 40" xmlns="http://www.w3.org/2000/svg"><path d="M10 30 Q40 5 70 30" stroke="#7af" stroke-width="3" fill="none"/></svg>` },
  { id:'emberCut', name:'Ember Cut', demo:`<svg viewBox="0 0 80 40" xmlns="http://www.w3.org/2000/svg"><path d="M10 30 Q40 8 70 30" stroke="orange" stroke-width="2" fill="none"/><circle cx="70" cy="30" r="3"/></svg>` },
  { id:'shockwave',name:'Shockwave', demo:`<svg viewBox="0 0 80 40" xmlns="http://www.w3.org/2000/svg"><path d="M10 28 Q40 10 70 28" stroke="#fff" stroke-width="2" fill="none"/><path d="M14 30 Q40 16 66 30" stroke="#fff" stroke-width="1" fill="none" opacity=".5"/></svg>` },
];
  
function renderPresetGrid(presets, chosen, dataAttr){
  const cells = presets.map(p => `
    <div class="preset ${chosen===p.id?'on':''}" ${dataAttr}="${p.id}" title="${p.name}">
      <div style="font-size:12px;font-weight:700;margin-bottom:4px;opacity:.9">${p.name}</div>
      ${p.demo}
    </div>`).join('');
  return `<div class="preset-grid">${cells}</div>`;
}

function renderTracerPicker(){
  return `
    <div style="margin-top:12px">
      <div style="font-weight:700;margin-bottom:4px">Bullet Tracer Pattern</div>
      <div style="font-size:12px;opacity:.8;margin-bottom:6px">Pick the look that follows your bullets (sparkles, fire, neon, etc.).</div>
      ${renderPresetGrid(TRACER_PRESETS, STATE.tracerPreset, 'data-tracer')}
    </div>`;
}

function renderSwingPicker(){
  return `
    <div style="margin-top:12px">
      <div style="font-weight:700;margin-bottom:4px">Melee Swing Pattern</div>
      <div style="font-size:12px;opacity:.8;margin-bottom:6px">Choose the arc style shown when you swing.</div>
      ${renderPresetGrid(SWING_PRESETS, STATE.swingPreset, 'data-swing')}
    </div>`;
}

/* Bind sliders + fx pickers → STATE + live preview (updated to isolate slider drag) */
function bindFeatureMeters(root){
  const wrap = root?.querySelector('.cl-pane.cl-form'); if (!wrap) return;

  const updateOut = (mKey, lvl)=>{
    const out = wrap.querySelector(`[data-out="${CSS.escape(mKey)}"]`);
    if (out) out.textContent = meterPreview(mKey, lvl);
  };

  // Stop clicks inside the meter box from bubbling to any parent close/drag bars
  const meterBox = wrap.querySelector('.meter-box');
  if (meterBox){
    ['pointerdown','pointerup','click','touchstart','touchend','mousedown','mouseup']
      .forEach(ev => meterBox.addEventListener(ev, e=>{
        e.stopPropagation();
      }, { passive:true }));
  }

  // Delegate clicks on the level pills
  wrap.querySelectorAll('.lvl-pill[data-m][data-lvl]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const key = btn.getAttribute('data-m');
      const lvl = parseInt(btn.getAttribute('data-lvl'), 10) || 1;

      // Set state
      STATE.featureLevels[key] = lvl;
      saveDraft();

      // Toggle button visuals within this meter
      const meterEl = btn.closest('.meter');
      if (meterEl){
        meterEl.querySelectorAll(`.lvl-pill[data-m="${CSS.escape(key)}"]`).forEach(b=>{
          const isOn = (parseInt(b.getAttribute('data-lvl'),10) === lvl);
          b.classList.toggle('on', isOn);
          b.setAttribute('aria-pressed', isOn ? 'true' : 'false');
        });
      }

      // Preview text
      updateOut(key, lvl);

      // Update totals display live
      const totals = calcDynamicPrice();
      const piTotal = wrap.querySelector('#totalPiDisp');
      const icTotal = wrap.querySelector('#totalIcDisp');
      if (piTotal) piTotal.textContent = `${totals.pi} Pi`;
      if (icTotal) icTotal.textContent = `${totals.ic.toLocaleString()} IC`;
      const icBtn = document.getElementById('payIC');
      if (icBtn) icBtn.textContent = `Pay ${totals.ic.toLocaleString()} IC`;
      const piBtn = document.getElementById('payPi');
      if (piBtn) piBtn.textContent = `Pay ${totals.pi} Pi`;
    }, { passive:true });
  });

  // FX grid clicks (unchanged behavior)
  wrap.querySelectorAll('[data-tracer]').forEach(div=>{
    div.addEventListener('click', (e)=>{
      e.stopPropagation();
      STATE.tracerPreset = div.getAttribute('data-tracer') || 'comet';
      saveDraft();
      wrap.querySelectorAll('[data-tracer]').forEach(d=> d.classList.toggle('on', d===div));
    }, { passive:true });
  });
  wrap.querySelectorAll('[data-swing]').forEach(div=>{
    div.addEventListener('click', (e)=>{
      e.stopPropagation();
      STATE.swingPreset = div.getAttribute('data-swing') || 'arcLight';
      saveDraft();
      wrap.querySelectorAll('[data-swing]').forEach(d=> d.classList.toggle('on', d===div));
    }, { passive:true });
  });

  const reset = wrap.querySelector('#metersReset');
  if (reset){
    reset.addEventListener('click', (e)=>{
      e.stopPropagation();
      Object.keys(STATE.featureLevels||{}).forEach(k=>{
        delete STATE.featureLevels[k];
        const min = METER_UI[k]?.min ?? 1;
        // Visually set pill 1 (or min) active
        wrap.querySelectorAll(`.lvl-pill[data-m="${CSS.escape(k)}"]`).forEach(b=>{
          const isOn = (parseInt(b.getAttribute('data-lvl'),10) === min);
          b.classList.toggle('on', isOn);
          b.setAttribute('aria-pressed', isOn ? 'true' : 'false');
        });
        updateOut(k, min);
      });
      saveDraft();

      const totals = calcDynamicPrice();
      const piTotal = wrap.querySelector('#totalPiDisp');
      const icTotal = wrap.querySelector('#totalIcDisp');
      if (piTotal) piTotal.textContent = `${totals.pi} Pi`;
      if (icTotal) icTotal.textContent = `${totals.ic.toLocaleString()} IC`;
      const icBtn = document.getElementById('payIC');
      if (icBtn) icBtn.textContent = `Pay ${totals.ic.toLocaleString()} IC`;
      const piBtn = document.getElementById('payPi');
      if (piBtn) piBtn.textContent = `Pay ${totals.pi} Pi`;
    }, { passive:true });
  }
}
/* Apply selected stats onto an inventory entry (weapon/armour) */
function attachCraftStats(invKey, entry){
  try{
    const part = String(entry.part||entry.slot||'').toLowerCase();
    const isGun      = (part === 'gun' || part === 'hands'); // <— broaden
    const isMelee    = (part === 'melee');
    const isLegs     = (part === 'legs');
    const isHelmVest = (part === 'helmet' || part === 'vest');

    // NEW: harmless type stamps (helps guns/loot/pickups agree)
    if (isGun) { entry.type = 'weapon'; entry.subtype = 'gun'; entry.gun = true; }
    if (isMelee){ entry.type = 'weapon'; entry.subtype = 'melee'; }

    const L = STATE.featureLevels || {};
    const F = STATE.featureFlags  || {};
    const setIf = (flagKey, meterKey, condition) => {
      if (!F[flagKey] || !condition) return;
      const meter = FEATURE_METERS[meterKey];
      const lvl = Math.max(METER_UI[meterKey]?.min||1, parseInt(L[meterKey]||1,10));
      entry[meter.key] = meter.toValue(lvl);
    };

    // weapons
    setIf('dmgBoost','dmgBoost', isGun || isMelee);
    setIf('fireRate','fireRate', isGun && !F.autoFire);
    setIf('swingRate','swingRate', isMelee);

    // armour
    setIf('dmgReduction','dmgReduction', isHelmVest);
    setIf('speedBoost','speedBoost', isLegs);

    // FX
    entry.fx = entry.fx || {};
    if (F.tracerFx && isGun)  entry.fx.tracer = STATE.tracerPreset;
    if (F.swingFx  && isMelee) entry.fx.swing  = STATE.swingPreset;

    // Re-assert auto AFTER FX
    // inside attachCraftStats, after you've set entry.auto/autoFire/fireMode
if (isGun && F.autoFire) {
  entry.auto = true;
  entry.autoFire = true;
  entry.fireMode = 'auto';

  // Make auto cadence identical to Uzi (never pistol):
  const uziMs =
      (window.GUN_CONSTS?.uzi?.intervalMs) ||
      (window.IZZA?.bal?.uzi?.intervalMs) ||
      (window.IZZA?.config?.UZI_INTERVAL_MS) ||
      110; // sensible fallback

  entry.fireIntervalMs = uziMs;

  // Make loot & HUD treat it like an Uzi:
  entry.ammoClass = 'uzi';   // or 'smg' if that’s your canonical key
  entry.weaponClass = 'uzi'; // optional, but helps any class-based code paths
}

    entry.crafted = true;
  }catch(e){ console.warn('[craft] attachCraftStats failed', e); }
}
// Re-stamp auto onto the newest crafted gun if UI autoFire was on.
function __enforceCreatorAuto(){
  try{
    if (!STATE?.featureFlags?.autoFire) return;
    const apiObj = (window.IZZA && IZZA.api) ? IZZA.api : null;
    const inv = apiObj?.getInventory ? (apiObj.getInventory()||{}) : JSON.parse(localStorage.getItem('izzaInventory')||'{}');
    const wantName = String(STATE.currentName||'').toLowerCase();

    const key = Object.keys(inv).reverse().find(k=>{
      if(!/^craft_/.test(k)) return false;
      const e = inv[k]||{};
      const part = String(e.part||e.slot||'').toLowerCase();
      const subtype = String(e.subtype||'').toLowerCase();
      const isGunLike = (part==='gun' || part==='hands' || subtype==='gun' || e.gun===true);
      return isGunLike && (String(e.name||'').toLowerCase()===wantName);
    });
    if(!key) return;

    const it = inv[key]||{};
    const alreadyAuto = !!(it.auto || it.autoFire || String(it.fireMode||'').toLowerCase()==='auto');
    if (!alreadyAuto) {
      it.auto = true; it.autoFire = true; it.fireMode = 'auto';
      inv[key] = it;
      apiObj?.setInventory ? apiObj.setInventory(inv)
                           : localStorage.setItem('izzaInventory', JSON.stringify(inv));
      try{ window.dispatchEvent(new Event('izza-inventory-changed')); }catch{}
    }
  }catch(e){ console.warn('[craft] enforceCreatorAuto failed', e); }
}

// Light window to run the enforcer (next tick + a short follow-up)
function __scheduleAutoEnforce(){
  setTimeout(__enforceCreatorAuto, 0);
  setTimeout(__enforceCreatorAuto, 50);
}
/* After the craft is injected by armoury/inventory, stamp the stats */
function __applyStatsToNewestCraft(){
  try{
    const apiObj = (window.IZZA && IZZA.api) ? IZZA.api : null;
    const inv = apiObj?.getInventory ? (apiObj.getInventory()||{}) : JSON.parse(localStorage.getItem('izzaInventory')||'{}');
    // Find newest craft_* by part/name
    const wantName = String(STATE.currentName||'').toLowerCase();
    const wantPart = String(STATE.currentPart||'').toLowerCase();
    const key = Object.keys(inv).reverse().find(k=>{
      if(!/^craft_/.test(k)) return false;
      const e=inv[k]||{};
      return (String(e.name||'').toLowerCase()===wantName) && (String(e.part||e.slot||'').toLowerCase()===wantPart || wantPart==='gun' || wantPart==='melee');
    });
    if(!key) return;
    attachCraftStats(key, inv[key]);
    apiObj?.setInventory ? apiObj.setInventory(inv) : localStorage.setItem('izzaInventory', JSON.stringify(inv));
    try{ window.dispatchEvent(new Event('izza-inventory-changed')); }catch{}
    __scheduleAutoEnforce();
  }catch(e){ console.warn('[craft] __applyStatsToNewestCraft skipped', e); }
}

/* Hook your existing mirror step — call right after you mirror the craft */
(function(){
  const _origMirrorToMine = (typeof mirrorInjectedInventoryToMine==='function') ? mirrorInjectedInventoryToMine : null;
  if (_origMirrorToMine){
    window.mirrorInjectedInventoryToMine = function(injected){
      // Always run the original first
      _origMirrorToMine(injected);

      // Then apply stat stamping and auto‐fire enforcement deterministically
      setTimeout(__applyStatsToNewestCraft, 0);
      __scheduleAutoEnforce();
    };
  }
})();

/* Credit badge helpers */
function applyCreditState(n){
  const next = Math.max(0, n|0);
  STATE.mintCredits   = next;
  STATE.canUseVisuals = next > 0;
  setCraftingCredits(next);           // <— persist + notify
  updateTabsHeaderCredits();
}
function totalMintCredits(){
  const singles = (STATE.mintCredits | 0);
  const pkg = (STATE.packageCredits && (STATE.packageCredits.items | 0)) || 0;
  return singles + pkg;
}
function updateTabsHeaderCredits(){
  try{
    const wrap = STATE.root?.querySelector('[data-tab="create"]');
    if (!wrap) return;
    const have = totalMintCredits();
    const label = 'Create Item';

    const old = wrap.querySelector('.cl-credit-badge');
    if (old) old.remove();

    if (have > 0){
      const b = document.createElement('span');
      b.className = 'cl-credit-badge';
      b.textContent = String(have);
      b.style.cssText = `
        display:inline-block; margin-left:6px; padding:0 6px; min-width:18px; height:18px;
        line-height:18px; font-size:11px; font-weight:700; border-radius:6px;
        background:#0b2b17; border:1px solid #1bd760; color:#b8ffd1; vertical-align:middle;
      `;
      if (!/Create Item/i.test(wrap.textContent)) wrap.textContent = label;
      wrap.appendChild(b);
    } else {
      wrap.textContent = label;
    }
  }catch(_){}
}

/* (Kept: name moderation + sanitizers + helpers) */
const BAD_WORDS = ['badword1','badword2','slur1','slur2'];
function moderateName(name){
  const s = String(name||'').trim();
  if (s.length < 3 || s.length > 28) return { ok:false, reason:'Name must be 3–28 chars' };
  const low = s.toLowerCase();
  if (BAD_WORDS.some(w => low.includes(w))) return { ok:false, reason:'Inappropriate name' };
  return { ok:true };
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

    // strip "background" fills to keep transparency
    cleaned = cleaned.replace(
      /(<svg\b[^>]*\sstyle\s*=\s*["'][^"']*)\bbackground(?:-color)?\s*:[^;"']+;?/i,
      (_, pre)=> pre
    );

    cleaned = cleaned.replace(
      /<rect\b[^>]*width\s*=\s*["']\s*100%\s*["'][^>]*height\s*=\s*["']\s*100%\s*["'][^>]*\/?>/gi,
      ''
    );

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
      cleaned = cleaned.replace(
        /<rect\b[^>]*x\s*=\s*["']?0(?:\.0+)?["']?[^>]*y\s*=\s*["']?0(?:\.0+)?["']?[^>]*width\s*=\s*["']?(?:128|256|512|1024)["']?[^>]*height\s*=\s*["']?(?:128|256|512|1024)["']?[^>]*\/?>/gi,
        ''
      );
    }

    cleaned = cleaned.replace(/<rect\b[^>]*(id|class)\s*=\s*["'][^"']*(?:\bbg\b|\bbackground\b|\bbackdrop\b)[^"']*["'][^>]*\/?>/gi,'');

    return cleaned;
  }catch(e){ return ''; }
}

/* Mirror the armoury-injected inventory entry into "My Creations" */
function mirrorInjectedInventoryToMine(injected){
  try{
    const apiObj = (window.IZZA && IZZA.api) ? IZZA.api : null;
    if (!apiObj || typeof apiObj.getInventory !== 'function') return;

    const inv = apiObj.getInventory() || {};

    // Prefer an explicit id/key returned by the injector (best case)
    let id = injected && (injected.id || injected.key) || '';

    // Fallback: find the new craft_* by name/part if injector didn't return an id
    if (!id){
      const wantName = String(STATE.currentName||'').toLowerCase();
      const wantPart = String(STATE.currentPart||'').toLowerCase();
      id = Object.keys(inv).find(k=>{
        if (!/^craft_/.test(k)) return false;
        const e = inv[k];
        const nm = String(e?.name||'').toLowerCase();
        const pt = String(e?.part||'').toLowerCase();
        return (nm === wantName) && (!pt || pt === wantPart);
      }) || '';
    }

    const entry = id && inv[id];
    if (!entry) return; // nothing to mirror

    // Pick an icon/overlay the player will actually see in the card
    const svg = entry.overlaySvg || entry.iconSvg || STATE.currentSVG || '';

    addMintToMineLocal({
      id,
      name: entry.name || STATE.currentName || 'Untitled',
      category: entry.category || STATE.currentCategory || 'armour',
      part: entry.part || STATE.currentPart || 'helmet',
      svg
    });
  }catch(e){
    console.warn('[craft] mirrorInjectedInventoryToMine failed', e);
  }
}
if (_origMirrorToMine){
  window.mirrorInjectedInventoryToMine = function(injected){
    _origMirrorToMine(injected);
    setTimeout(__applyStatsToNewestCraft, 0);
    __scheduleAutoEnforce(); // <-- add this line
  };
}
/* --- UI helpers for AI wait state --- */
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

function getIC(){
  try{ return parseInt(localStorage.getItem('izzaCoins')||'0',10)||0; }catch{ return 0; }
}
function setIC(v){
  try{
    localStorage.setItem('izzaCoins', String(Math.max(0, v|0)));
    window.dispatchEvent(new Event('izza-coins-changed'));
  }catch{}
}

  
/* ======================================== */

/* Generic JSON helper (credentials included) */
async function serverJSON(url, opts = {}) {
  const r = await fetch(url, Object.assign({
    headers: { 'content-type': 'application/json' },
    credentials: 'include'
  }, opts));
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return await r.json().catch(() => ({}));
}

/* ---- Single source of truth for voucher redemption (izzapay) ---- */
async function redeemMintCode(codeRaw){
  try{
    const code = String(codeRaw||'').trim().toUpperCase();
    const r = await fetch(payApi('/api/mint_codes/consume'), {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body: JSON.stringify({ code })
    });
    let j = {};
    try { j = await r.json(); } catch {}
    if (r.ok && j && j.ok) return j; // { ok:true, creditsAdded: 1 }
    return { ok:false,
             reason: j.reason || (r.status===404?'invalid' : r.status===400?'used' : 'network') };
  }catch(_){
    return { ok:false, reason:'network' };
  }
}

/* --- credit reconcile (server-first) --- */
async function reconcileCraftCredits(){
  try{
    await fetch(gameApi('/api/crafting/credits/reconcile'), {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      credentials:'include'
    });
  }catch(_){ /* soft-fail */ }
}

async function payWithIC(amountIC){
  const cur = getIC();
  if (cur < amountIC) return { ok:false, reason:'not-enough-ic' };
  setIC(cur - amountIC);
  try{ await serverJSON(gameApi('/api/crafting/ic/debit'), { method:'POST', body:JSON.stringify({ amount:amountIC }) }); }catch{}
  return { ok:true };
}

/* --- REQUIRED-FIELDS VALIDATION (Create tab only) --- */
function isCreateFormValid(){
  const hasCat  = !!STATE.currentCategory;
  const hasPart = !!STATE.currentPart;
  const nm = moderateName(STATE.currentName || '');
  return hasCat && hasPart && nm.ok;
}

function updatePayButtonsState(){
  const root = STATE.root;
  if(!root) return;
  const ok = isCreateFormValid();

  const pi = root.querySelector('#payPi');
  const ic = root.querySelector('#payIC');
  [pi, ic].forEach(btn=>{
    if (!btn) return;
    btn.disabled = !ok;
    btn.title = ok ? '' : 'Fill Category, Part/Type, and Item Name first';
  });

  const status = root.querySelector('#payStatus');
  if (status){
    status.textContent = ok ? '' : 'Fill Category, Part/Type, and Item Name to enable Pay.';
  }
}

/* --- AI prompt: server first, then minimal fallback --- */
async function aiToSVG(prompt){
  if (STATE.aiAttemptsLeft <= 0) throw new Error('No attempts left');

  try{
    const j = await serverJSON(gameApi('/api/crafting/ai_svg'), {
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
          style: STATE.aiStyle,
          animate: STATE.wantAnimation,
          animationPaid: false
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

/* --- Slot viewBoxes used by the engine (same as server) --- */
const TARGET_VB = {
  helmet: '0 0 128 128',
  vest:   '0 0 128 128',
  arms:   '0 0 160 120',
  legs:   '0 0 140 140',
  hands:  '0 0 160 100'
};

/* Gun/melee map to "hands" for slot fitting */
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

  // Append original visible nodes
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
      fl: STATE.featureLevels,      // persist meter levels
      svg: STATE.currentSVG,
      tracer: STATE.tracerPreset,
      swing: STATE.swingPreset,
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
    if (j.fl) Object.assign(STATE.featureLevels, j.fl);
    STATE.currentSVG       = j.svg  ?? STATE.currentSVG;
    STATE.tracerPreset     = j.tracer || STATE.tracerPreset;
    STATE.swingPreset      = j.swing  || STATE.swingPreset;
  }catch{}
}

/* ---------- UI: toggles block based on selection ---------- */
function renderFeatureToggles(){
  const allow = allowedTogglesForSelection();
  const flags = STATE.featureFlags || {};
  const blocks = [];

  const push = (key, label, hint='')=>{
    if (!allow.toggles.includes(key)) return;
    const checked = flags[key] ? 'checked' : '';
    const title = hint ? ` title="${hint}"` : '';
    blocks.push(`<label><input type="checkbox" data-ff="${key}" ${checked}${title}/> ${label}</label>`);
  };

  // weapon shared
  push('dmgBoost','Weapon damage boost');

  // gun-only
push('fireRate','Gun fire-rate','Uzi can be fastest; pistol = single tap → one shot (engine caps per gun).');
push('tracerFx','Bullet tracer FX');
push('autoFire','Automatic (hold to fire)'); // <— NEW

  // melee-only
  push('swingRate','Melee swing rate');
  push('swingFx','Melee swing FX');

  // armour
  push('speedBoost','Speed boost');
  push('dmgReduction','Armour damage reduction','Helmet/Vest only; 15% each piece. Max 30% when both equipped.');

  return blocks.length
    ? `<div style="margin-top:10px;font-weight:700">Optional Features</div>
       ${blocks.join('<br/>')}`
    : '';
}

function renderTabs(){
  const have = totalMintCredits();
  const badge = (have > 0)
    ? `<span class="cl-credit-badge"
        style="display:inline-block;margin-left:6px;padding:0 6px;min-width:18px;height:18px;line-height:18px;
               font-size:11px;font-weight:700;border-radius:6px;background:#0b2b17;border:1px solid #1bd760;color:#b8ffd1;vertical-align:middle;">
         ${have}
       </span>`
    : '';

  return `
    <div style="display:flex; gap:8px; padding:10px; border-bottom:1px solid #2a3550; background:#0f1624">
      <button class="ghost" data-tab="packages">Packages</button>
      <button class="ghost" data-tab="create">Create Item${badge}</button>
    </div>`;
}

function renderPackages(){
  return `
    <div style="padding:14px;">
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px">
        <div style="font-weight:700;opacity:.85">Packages</div>
        <div style="margin-left:auto">
          <button class="ghost" id="goMarketplace">Browse Crafting Land Marketplace</button>
        </div>
      </div>

      <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:10px">
        <div style="background:#0f1522;border:1px solid #2a3550;border-radius:10px;padding:12px">
          <div style="font-weight:700;margin-bottom:6px">Single In-Game Item Mint</div>
          <div style="opacity:.85;font-size:13px;">(Craft 1 item)</div>
          <div style="display:flex;gap:8px;margin-top:10px;justify-content:flex-end;flex-wrap:wrap">
            <button class="ghost" id="pkGoCreate">Create Now</button>
          </div>
        </div>

        <div style="background:#0f1522;border:1px solid #2a3550;border-radius:10px;padding:12px">
          <div style="font-weight:700;margin-bottom:6px">Starter Forge</div>
          <div style="opacity:.85;font-size:13px;line-height:1.4">
            2× Weapons (½-heart dmg), 1× Armour set (+0.25% speed, 25% DR).<br/>Includes features & listing rights.
          </div>
          <div style="margin-top:8px;font-weight:700">
            Cost: ${COSTS.PACKAGE_PI} Pi or ${COSTS.PACKAGE_IC.toLocaleString()} IC
          </div>
          <div style="margin-top:10px;opacity:.7;font-weight:700">Coming soon!</div>
        </div>
      </div>
    </div>`;
}

function renderCreate(){
  const totals = calcDynamicPrice();

  const sub = STATE.canUseVisuals
    ? (STATE.createSub === 'visuals' ? 'visuals' : 'setup')
    : 'setup';

  const visualsDisabledCls = STATE.canUseVisuals ? '' : 'disabled';

  const visualsCreditStyle = STATE.canUseVisuals
    ? 'box-shadow:inset 0 0 0 1px #1bd760; color:#b8ffd1; background:#0b2b17;'
    : '';

  const togglesHTML = renderFeatureToggles();
  const metersHTML  = renderFeatureMeters();

  return `
    <div class="cl-subtabs" style="display:flex;flex-direction:column;gap:6px">
      <button class="${sub==='setup'?'on':''}" data-sub="setup" style="flex:0 0 auto">Setup</button>
      <button class="${sub==='visuals'?'on':''} ${visualsDisabledCls}"
              data-sub="visuals"
              ${STATE.canUseVisuals ? '' : 'disabled'}
              style="flex:0 0 auto; ${visualsCreditStyle}">Visuals</button>
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
        <select id="partSel"></select>

        <label style="display:block;margin:10px 0 4px;font-size:12px;opacity:.8">Item Name</label>
        <input id="itemName" type="text" maxlength="28" placeholder="Name…" style="width:100%"/>

        ${togglesHTML || ''}

        <div style="margin-top:10px; font-size:13px; opacity:.85">
          Total (base + features): <b id="totalPiDisp">${totals.pi} Pi</b> or <b id="totalIcDisp">${totals.ic.toLocaleString()} IC</b>
        </div>

        <div style="display:flex; gap:8px; margin-top:10px; flex-wrap:wrap">
          <!-- Keep Pi button fixed for now (display only shows dynamic) -->
          <button class="ghost" id="payPi">Pay ${COSTS.PER_ITEM_PI} Pi</button>
          <!-- IC button reflects dynamic price and is actually charged -->
          <button class="ghost" id="payIC">Pay ${totals.ic.toLocaleString()} IC</button>
          <span id="payStatus" style="font-size:12px; opacity:.8"></span>
        </div>

        ${metersHTML}

        <div style="margin-top:12px; border-top:1px solid #2a3550; padding-top:10px">
          <div style="font-weight:700; margin-bottom:6px">Have a code?</div>
          <div style="display:flex; gap:8px; flex-wrap:wrap">
            <input id="redeemCode" placeholder="IZZA-XXXX-XXXX-XXXX" style="flex:1; min-width:220px"/>
            <button class="ghost" id="btnRedeem">Redeem</button>
          </div>
          <div id="redeemStatus" style="font-size:12px; opacity:.8; margin-top:6px"></div>
        </div>

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

/* --- NEW: Crafting Land Marketplace view (internal page) --- */
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

/* ---- Shop Stats Modal (simple) ---- */
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
    const j = await serverJSON(gameApi(`/api/shop/stats?itemId=${encodeURIComponent(itemId)}`));
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
    const j = await serverJSON(gameApi('/api/shop/add'), {
      method:'POST',
      body: JSON.stringify({ itemId })
    });
    return !!(j && j.ok);
  }catch{
    return false;
  }
}

function currentUsername(){
  return (window?.IZZA?.player?.username)
      || (window?.IZZA?.me?.username)
      || localStorage.getItem('izzaPlayer')
      || localStorage.getItem('pi_username')
      || '';
}

async function fetchMine(){
  try{
    const u = encodeURIComponent(currentUsername());
    if(!u) return [];
    const j = await serverJSON(gameApi(`/api/crafting/mine?u=${u}`));
    return (j && j.ok && Array.isArray(j.items)) ? j.items : [];
  }catch{ return []; }
}

function mineCardHTML(it){
  const safeSVG = sanitizeSVG(it.svg||'');
  const listed = !!it.inShop;
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

/* --- ADD: local prepend into "My Creations" without changing anything else --- */
function addMintToMineLocal(item){
  const host = STATE.root?.querySelector('#mineList');
  if (!host) return;

  host.insertAdjacentHTML('afterbegin', mineCardHTML(Object.assign({ inShop:false }, item)));

  const card = host.firstElementChild;
  if (!card) return;

  const copyBtn = card.querySelector('[data-copy]');
  if (copyBtn){
    copyBtn.addEventListener('click', async ()=>{
      try { await (navigator.clipboard?.writeText(item.svg || '')); alert('SVG copied'); } catch {}
    }, { passive:true });
  }

  const equipBtn = card.querySelector('[data-equip]');
  if (equipBtn){
    equipBtn.addEventListener('click', ()=>{
      try {
        localStorage.setItem('izzaLastEquipped', JSON.stringify({
          id:item.id, name:item.name, category:item.category, part:item.part, svg:item.svg
        }));
      } catch {}
      const BUS = (window.parent && window.parent.IZZA) ? window.parent.IZZA : window.IZZA;
      try { BUS?.emit?.('equip-crafted', item.id); } catch {}
      try { BUS?.emit?.('equip-crafted-v2', {
        id:item.id, name:item.name, category:item.category, part:item.part, svg:item.svg
      }); } catch {}
    }, { passive:true });
  }

  const addShopBtn = card.querySelector('[data-addshop]');
  if (addShopBtn){
    addShopBtn.addEventListener('click', async ()=>{
      const id = item.id;
      addShopBtn.disabled = true;
      const prev = addShopBtn.textContent;
      addShopBtn.textContent = 'Adding…';
      const ok = await addToShop(id);
      if (ok){
        addShopBtn.outerHTML = `<button class="ghost" data-stats="${id}">View Shop Stats</button>`;
        const statsBtn = card.querySelector(`[data-stats="${CSS.escape(String(id))}"]`);
        if (statsBtn){
          statsBtn.addEventListener('click', ()=> openStatsModal(id), { passive:true });
        }
      } else {
        alert('Failed to add to shop');
        addShopBtn.disabled = false;
        addShopBtn.textContent = prev || 'Add to Shop';
      }
    }, { passive:true });
  }
}

/* --- NEW: Marketplace bundle card renderer --- */
function marketplaceCardHTML(b){
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

/* CSS.escape ponyfill (safe if native missing) */
if (!window.CSS) window.CSS = {};
if (!CSS.escape) {
  CSS.escape = function(value) {
    const str = String(value);
    const length = str.length;
    let result = '';
    let index = -1;
    while (++index < length) {
      const codeUnit = str.charCodeAt(index);
      if (codeUnit === 0x0000) { result += '\uFFFD'; continue; }
      if ((codeUnit >= 0x0001 && codeUnit <= 0x001F) || codeUnit === 0x007F) {
        result += '\\' + codeUnit.toString(16) + ' '; continue;
      }
      if ((index === 0 && codeUnit >= 0x0030 && codeUnit <= 0x0039) ||
          (index === 1 && codeUnit >= 0x0030 && codeUnit <= 0x0039 && str.charCodeAt(0) === 0x002D)) {
        result += '\\' + codeUnit.toString(16) + ' '; continue;
      }
      if (codeUnit === 0x002D || codeUnit === 0x005F ||
          (codeUnit >= 0x0030 && codeUnit <= 0x0039) ||
          (codeUnit >= 0x0041 && codeUnit <= 0x005A) ||
          (codeUnit >= 0x0061 && codeUnit <= 0x007A)) {
        result += str.charAt(index); continue;
      }
      result += '\\' + str.charAt(index);
    }
    return result;
  };
}

/* ---------- hydrate "My Creations" ---------- */
async function hydrateMine(){
  const host = STATE.root?.querySelector('#mineList');
  if (!host) return;

  host.innerHTML = '<div style="opacity:.7">Loading…</div>';

  const items = await fetchMine();

  host.innerHTML = (items && items.length)
    ? items.map(mineCardHTML).join('')
    : '<div style="opacity:.7">No creations yet.</div>';

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
          const ta = document.createElement('textarea');
          ta.value = text; document.body.appendChild(ta);
          ta.select(); try{ document.execCommand('copy'); }catch{}
          document.body.removeChild(ta);
        }
        alert('SVG copied');
      } catch {}
    }, { passive:true });
  });

  host.querySelectorAll('[data-equip]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const id = btn.dataset.equip;
      const it = items.find(x => String(x.id) === String(id));
      if (!it) return;

      try {
        localStorage.setItem('izzaLastEquipped', JSON.stringify({
          id: it.id, name: it.name, category: it.category, part: it.part, svg: it.svg
        }));
      } catch {}

      const BUS = (window.parent && window.parent.IZZA) ? window.parent.IZZA : window.IZZA;
      try { BUS?.emit?.('equip-crafted', it.id); } catch {}
      try { BUS?.emit?.('equip-crafted-v2', {
        id: it.id, name: it.name, category: it.category, part: it.part, svg: it.svg
      }); } catch {}
    }, { passive:true });
  });

  host.querySelectorAll('[data-addshop]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const id = btn.dataset.addshop;
      btn.disabled = true;
      const prev = btn.textContent;
      btn.textContent = 'Adding…';
      const ok = await addToShop(id);
      if (ok){
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

  host.querySelectorAll('[data-stats]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const id = btn.dataset.stats;
      if (id) openStatsModal(id);
    }, { passive:true });
  });
}

/* ---------- Marketplace (internal) ---------- */
async function fetchMarketplace(){
  try{
    const j = await serverJSON(gameApi('/api/marketplace/list'));
    return (j && j.ok && Array.isArray(j.bundles)) ? j.bundles : [];
  }catch{
    return [];
  }
}

async function hydrateMarketplace(){
  const host = STATE.root?.querySelector('#mpList');
  if (!host) return;
  host.innerHTML = '<div style="opacity:.7">Loading…</div>';

  const bundles = await fetchMarketplace();

  host.innerHTML = bundles.length
    ? bundles.map(marketplaceCardHTML).join('')
    : '<div style="opacity:.7">No bundles yet. Creators can publish bundles from My Creations.</div>';

  host.querySelectorAll('[data-mp-view]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const id = btn.dataset.mpView;
      const BUS = (window.parent && window.parent.IZZA) ? window.parent.IZZA : window.IZZA;
      try { BUS?.emit?.('marketplace-view', { id }); } catch {}
      alert('Bundle details would open here (implement in-game).');
    });
  });

  host.querySelectorAll('[data-mp-buy]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const id = btn.dataset.mpBuy;
      const BUS = (window.parent && window.parent.IZZA) ? window.parent.IZZA : window.IZZA;
      try { BUS?.emit?.('marketplace-buy', { id }); } catch {}
      alert('Purchase flow would start here (implement in-game / server).');
    });
  });
}
/* ===== CRAFTING CREDITS PERSISTENCE (cookie-mirrored) ===== */
function _readCookie(name){
  return (document.cookie.split('; ').find(s => s.startsWith(name+'=')) || '')
    .split('=').slice(1).join('=') || '';
}
function _writeCookie(name, value){
  try{
    const v    = encodeURIComponent(String(value));
    const base = `${name}=${v}; Path=/; Max-Age=${60*60*24*365}; SameSite=None; Secure`;

    // Always set for the current host
    document.cookie = base;

    // If we're on a subdomain of onrender.com, also set the parent domain
    const host = location.hostname;
    if (host.endsWith('.onrender.com')) {
      document.cookie = `${name}=${v}; Path=/; Domain=.onrender.com; Max-Age=${60*60*24*365}; SameSite=None; Secure`;
    }
  }catch(_){}
}

function getCraftingCredits(){
  try{
    // 1) local fast path
    const rawLocal =
      localStorage.getItem('izzaCrafting') ??
      localStorage.getItem('craftingCredits') ??
      localStorage.getItem('izzaCraftCredits');

    // 2) cookie fallback (cross-subdomain)
    const rawCookie = _readCookie('izzaCrafting');

    const nLocal  = parseInt(rawLocal, 10);
    const nCookie = parseInt(rawCookie, 10);

    const n = Math.max(
      Number.isFinite(nLocal)  ? nLocal  : 0,
      Number.isFinite(nCookie) ? nCookie : 0
    );
    return Math.max(0, n|0);
  }catch{ return 0; }
}

// Only increase unless mode === 'burn'
function setCraftingCredits(n, mode){
  try{
    const incoming = Math.max(0, n|0);
    const current  = getCraftingCredits(); // reads max(local, cookie)
    const value    = (mode === 'burn' || incoming > current) ? incoming : current;

    // write both local and cookie mirrors
    localStorage.setItem('izzaCrafting',       String(value));
    localStorage.setItem('craftingCredits',    String(value));
    localStorage.setItem('izzaCraftCredits',   String(value));
    _writeCookie('izzaCrafting', String(value));

    window.dispatchEvent(new Event('izza-crafting-changed'));
  }catch{}
}
/* ---------- Mount / Unmount ---------- */
async function mount(rootSel){
  const root = (typeof rootSel==='string') ? document.querySelector(rootSel) : rootSel;
  if (!root) return;
  STATE.root = root;
  STATE.mounted = true;

  // 1) Seed credits immediately from persisted storage (survive close/reopen)
  try{
    const persisted =
      (typeof getCraftingCredits === 'function')
        ? (getCraftingCredits() | 0)
        : (
            parseInt(
              localStorage.getItem('izzaCrafting') ??
              localStorage.getItem('craftingCredits') ??
              localStorage.getItem('izzaCraftCredits') ?? '0',
              10
            ) | 0
          );
    STATE.mintCredits   = persisted;
    STATE.canUseVisuals = persisted > 0;
  }catch{}

  loadDraft();

  // Best-effort server reconcile first (doesn't mutate local if it fails)
  await reconcileCraftCredits();

  root.innerHTML = `${renderTabs()}<div id="craftTabs"></div>`;
  const tabsHost = root.querySelector('#craftTabs');

  // If you already have credits, land on Create immediately
  let initialTab = ((STATE.mintCredits|0) > 0) ? 'create' : 'packages';

  // ---- SAFE CREDIT SEEDING (do not let server zero-out local) ----
  try{
    // Read local persisted credits (works even if getCraftingCredits helper isn't present)
    const local =
      (typeof getCraftingCredits === 'function')
        ? (getCraftingCredits() | 0)
        : (
            parseInt(
              localStorage.getItem('izzaCrafting') ??
              localStorage.getItem('craftingCredits') ??
              localStorage.getItem('izzaCraftCredits') ?? '0',
              10
            ) | 0
          );

    const s = await serverJSON(gameApi('/api/crafting/credits/status')); // { ok:true, credits:number }
    if (s && s.ok && Number.isFinite(s.credits)){
      const server = s.credits | 0;
      const effective = Math.max(local, server);   // <- never downgrade
      if (typeof applyCreditState === 'function'){
        applyCreditState(effective);               // also persists via your helper, if implemented
      } else {
        STATE.mintCredits   = effective;
        STATE.canUseVisuals = effective > 0;
      }
      updateTabsHeaderCredits();
      if (effective > 0){
        STATE.aiAttemptsLeft = COSTS.AI_ATTEMPTS;
        STATE.createSub = 'setup';
        initialTab = 'create';
      }
    } else {
      // server not ok -> stick with local
      if (typeof applyCreditState === 'function'){
        applyCreditState(local);
      } else {
        STATE.mintCredits   = local;
        STATE.canUseVisuals = local > 0;
      }
      updateTabsHeaderCredits();
    }
  }catch(_){
    // network/parse error -> stick with local
    const local =
      (typeof getCraftingCredits === 'function')
        ? (getCraftingCredits() | 0)
        : (
            parseInt(
              localStorage.getItem('izzaCrafting') ??
              localStorage.getItem('craftingCredits') ??
              localStorage.getItem('izzaCraftCredits') ?? '0',
              10
            ) | 0
          );
    if (typeof applyCreditState === 'function'){
      applyCreditState(local);
    } else {
      STATE.mintCredits   = local;
      STATE.canUseVisuals = local > 0;
    }
    updateTabsHeaderCredits();
  }
  // ----------------------------------------------------------------

  if (!window.__izzaReconHook){
    document.addEventListener('visibilitychange', ()=>{
      if (!document.hidden) reconcileCraftCredits();
    }, { passive:true });
    window.__izzaReconHook = true;
  }

  const setTab = (name)=>{
    if(!STATE.mounted) return;
    if(name==='packages'){ tabsHost.innerHTML = renderPackages(); }
    if(name==='create'){   tabsHost.innerHTML = renderCreate(); }
    if(name==='mine'){     tabsHost.innerHTML = renderMine(); hydrateMine(); }

    bindInside();
    _syncVisualsTabStyle(); // reflect seeded/updated credits on the Visuals sub-tab

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

  setTab(initialTab);
}

function unmount(){
  if(!STATE.root) return;
  STATE.root.innerHTML='';
  STATE.mounted=false;
}

/* ---------- Single purchase buttons ---------- */
async function handleBuySingle(kind, enforceForm){
  if (enforceForm && !isCreateFormValid()){
    const status = document.getElementById('payStatus');
    if (status) status.textContent = 'Fill Category, Part/Type, and Item Name first.';
    updatePayButtonsState();
    return;
  }

  const usePi = (kind === 'pi');

  if (usePi) {
    const status = document.getElementById('payStatus');
    if (status) status.textContent = 'Opening IZZA Pay checkout…';
    // Keep Pi checkout fixed at base for now
    location.href = 'https://izzapay.onrender.com/checkout/d0b811e8';
    return;
  }

  // Dynamic IC total based on toggles + levels
  const total = calcDynamicPrice().ic;
  const res = await payWithIC(total);

  const status = document.getElementById('payStatus');
  if (res && res.ok){
    applyCreditState((STATE.mintCredits|0) + 1);
    STATE.aiAttemptsLeft = COSTS.AI_ATTEMPTS;
    if (status) status.textContent = 'Paid ✓ — visual credit granted.';
    updateTabsHeaderCredits();
    STATE.createSub = 'setup';
    const host = STATE.root?.querySelector('#craftTabs');
    if (host){ host.innerHTML = renderCreate(); bindInside(); }
  } else {
    if (status) status.textContent='Payment failed.';
  }
}

/* ---------- Visuals tab highlight ---------- */
function _syncVisualsTabStyle(){
  try{
    const vb = STATE.root?.querySelector('.cl-subtabs [data-sub="visuals"]');
    if (!vb) return;
    const hasCredit = (STATE.mintCredits|0) > 0 || (STATE.packageCredits && STATE.packageCredits.items > 0);
    if (hasCredit){
      vb.style.background   = '#0b2b17';
      vb.style.boxShadow    = '0 0 0 1px #1bd760 inset';
      vb.style.color        = '#b8ffd1';
      vb.title = 'You have mint credit available';
    } else {
      vb.style.background   = '';
      vb.style.boxShadow    = '';
      vb.style.color        = '';
      vb.title = '';
    }
  }catch(_){}
}

/* ---------- Bind inside current tab ---------- */
function bindInside(){
  const root = STATE.root;
  if(!root) return;

  const goMp = root.querySelector('#goMarketplace');
  if (goMp){
    goMp.addEventListener('click', async ()=>{
      const BUS = (window.parent && window.parent.IZZA) ? window.parent.IZZA : window.IZZA;
      try{ BUS?.emit?.('open-marketplace'); }catch{}
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

  const goCreateBtn = root.querySelector('#pkGoCreate');
  if (goCreateBtn){
    goCreateBtn.addEventListener('click', ()=>{
      STATE.createSub = 'setup';
      const createTabBtn = STATE.root?.querySelector('[data-tab="create"]');
      if (createTabBtn) {
        createTabBtn.click();
      } else {
        const host = STATE.root?.querySelector('#craftTabs');
        if (host){ host.innerHTML = renderCreate(); bindInside(); }
      }
    }, { passive:true });
  }

  root.querySelectorAll('[data-buy-package]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const kind = btn.dataset.buyPackage; // 'pi' | 'ic'
      let res;
      if (kind === 'pi') {
        res = await payWithPi(COSTS.PACKAGE_PI, 'Package:starter-50');
      } else {
        res = await payWithIC(COSTS.PACKAGE_IC);
      }

      if (res && res.ok){
        STATE.packageCredits = { id:'starter-50', items:3, featuresIncluded:true };
        STATE.hasPaidForCurrentItem = true;
        STATE.canUseVisuals = true;
        STATE.aiAttemptsLeft = COSTS.AI_ATTEMPTS;
        STATE.createSub = 'visuals';

        try {
          const tabs = STATE.root?.querySelectorAll('[data-tab]');
          const createBtn = Array.from(tabs||[]).find(b=>b.dataset.tab==='create');
          if (createBtn) createBtn.click();
          else {
            const host = STATE.root?.querySelector('#craftTabs');
            if (host){ host.innerHTML = renderCreate(); bindInside(); }
          }
        } catch {}
      } else {
        alert('Payment failed');
      }
    }, { passive:true });
  });

  root.querySelectorAll('[data-buy-single]').forEach(btn=>{
    btn.addEventListener('click', ()=> handleBuySingle(btn.dataset.buySingle), { passive:true });
  });
  const payPi = root.querySelector('#payPi');
  const payIC = root.querySelector('#payIC');
  payPi && payPi.addEventListener('click', ()=> handleBuySingle('pi', true), { passive:true });
  payIC && payIC.addEventListener('click', ()=> handleBuySingle('ic', true), { passive:true });

  const redeemInput = root.querySelector('#redeemCode');
  const redeemBtn   = root.querySelector('#btnRedeem');
  const redeemStat  = root.querySelector('#redeemStatus');

  if (redeemBtn){
    redeemBtn.addEventListener('click', async ()=>{
      const code = redeemInput?.value || '';
      if (!/^[A-Z0-9-]{8,36}$/i.test(code)) {
        redeemStat.textContent = 'Enter a valid code.';
        return;
      }
      redeemBtn.disabled = true;
      redeemStat.textContent = 'Checking code…';

      const r = await redeemMintCode(code);
      redeemBtn.disabled = false;

      if (r && r.ok){
        applyCreditState((STATE.mintCredits|0) + (r.creditsAdded||1));
        updateTabsHeaderCredits();
        redeemStat.textContent = 'Redeemed ✓ — mint credit added.';
      } else {
        const reasons = { invalid:'Code not found.', used:'Code already used.', expired:'Code expired.', network:'Network error.' };
        redeemStat.textContent = reasons[r?.reason] || 'Unable to redeem this code.';
      }
    }, { passive:true });
  }

  const itemName = root.querySelector('#itemName');
  if (itemName){
    itemName.value = STATE.currentName || '';
    itemName.addEventListener('input', e=>{
      STATE.currentName = e.target.value;
      saveDraft();
      updatePayButtonsState();
    }, { passive:true });
  }

  const aiStyleSel = root.querySelector('#aiStyleSel');
  const aiAnimChk  = root.querySelector('#aiAnimChk');
  if (aiStyleSel){
    aiStyleSel.value = STATE.aiStyle;
    aiStyleSel.addEventListener('change', e=>{ STATE.aiStyle = e.target.value; saveDraft(); });
  }
  if (aiAnimChk){
    aiAnimChk.checked = !!STATE.wantAnimation;
    aiAnimChk.addEventListener('change', e=>{ STATE.wantAnimation = !!e.target.checked; saveDraft(); });
  }

  // Feature checkboxes (selection-aware)
  root.querySelectorAll('[data-ff]').forEach(cb=>{
    const key = cb.dataset.ff;
    const allow = allowedTogglesForSelection();
    // Initialize checked state from STATE
    if (STATE.featureFlags && key in STATE.featureFlags) cb.checked = !!STATE.featureFlags[key];
    // Disable checkboxes that are not allowed for current selection
    if (!allow.toggles.includes(key)) {
      cb.checked = false;
      cb.disabled = true;
    } else {
      cb.disabled = false;
    }

    cb.addEventListener('change', ()=>{
      STATE.featureFlags[key] = cb.checked;
      // If a meter exists for this toggle and we just turned it on with no level → set to 1
      const hasMeter = allow.meters.includes(key);
      if (cb.checked && hasMeter && (STATE.featureLevels[key] == null || STATE.featureLevels[key] === 0)) {
        STATE.featureLevels[key] = METER_UI[key]?.min ?? 1;
      }
      if (!cb.checked && hasMeter) {
        delete STATE.featureLevels[key];
      }
      saveDraft();

      // Re-render to show/hide meters + recalc totals
      const host = root.querySelector('#craftTabs');
      if (!host) return;
      const saveScroll = host.scrollTop;
      host.innerHTML = renderCreate();
      bindInside();
      bindFeatureMeters(STATE.root);
      host.scrollTop = saveScroll;
    });
  });

  const catSel  = root.querySelector('#catSel');
  const partSel = root.querySelector('#partSel');

  if (catSel && partSel){
    catSel.value = STATE.currentCategory;
    repopulatePartOptions(catSel, partSel);

    catSel.addEventListener('change', e=>{
      STATE.currentCategory = e.target.value;
      repopulatePartOptions(catSel, partSel);
      STATE.currentPart = (partSel && partSel.value) ? partSel.value : STATE.currentPart;
      // Clear feature flags/levels when switching categories/parts to avoid invalid combos
      STATE.featureFlags = Object.fromEntries(Object.keys(STATE.featureFlags).map(k=>[k,false]));
      STATE.featureLevels = {};
      saveDraft();
      updatePayButtonsState();
      const host = STATE.root?.querySelector('#craftTabs');
      if (host){
        const saveScroll = host.scrollTop;
        host.innerHTML = renderCreate();
        bindInside();
        bindFeatureMeters(STATE.root);
        host.scrollTop = saveScroll;
      }
    }, { passive:true });
  }

  if (partSel){
    partSel.value = STATE.currentPart;
    partSel.addEventListener('change', e=>{
      STATE.currentPart = e.target.value;
      // Reset flags/levels for invalid ones on part change
      STATE.featureFlags = Object.fromEntries(Object.keys(STATE.featureFlags).map(k=>[k,false]));
      STATE.featureLevels = {};
      saveDraft();
      updatePayButtonsState();
      const host = STATE.root?.querySelector('#craftTabs');
      if (host){
        const saveScroll = host.scrollTop;
        host.innerHTML = renderCreate();
        bindInside();
        bindFeatureMeters(STATE.root);
        host.scrollTop = saveScroll;
      }
    }, { passive:true });
  }

  updatePayButtonsState();

  const aiLeft = ()=> {
    const a = document.getElementById('aiLeft');  if (a) a.textContent = STATE.aiAttemptsLeft;
    const b = document.getElementById('aiLeft2'); if (b) b.textContent = STATE.aiAttemptsLeft;
  };

  const btnAI    = root.querySelector('#btnAI');
  const aiPrompt = root.querySelector('#aiPrompt');
  const svgIn    = root.querySelector('#svgIn');
  const btnPrev  = root.querySelector('#btnPreview');
  const btnMint  = root.querySelector('#btnMint');
  const prevHost = root.querySelector('#svgPreview');
  const craftStatus = root.querySelector('#craftStatus');

  if (svgIn && STATE.currentSVG){
    svgIn.value = STATE.currentSVG;
    prevHost && (prevHost.innerHTML = STATE.currentSVG);
  }

  // Sub-tab switching
  root.querySelectorAll('[data-sub]').forEach(b=>{
    b.addEventListener('click', ()=>{
      const next = b.dataset.sub;
      if (next === 'visuals' && !STATE.canUseVisuals) return;
      STATE.createSub = next;
      const host = STATE.root?.querySelector('#craftTabs');
      if (host){
        host.innerHTML = renderCreate();
        bindInside();
        bindFeatureMeters(STATE.root);
        _syncVisualsTabStyle();
      }
    }, { passive:true });
  });

  // ===== Handlers =====
  btnAI && btnAI.addEventListener('click', async ()=>{
    if (!btnAI) return;
    const prompt = String(aiPrompt?.value||'').trim();
    if (!prompt) return;

    btnAI.disabled = true;
    btnAI.setAttribute('aria-busy','true');
    btnAI.textContent = 'Generating…';
    const waitEl = showWait('Crafting your SVG preview (this can take ~5–10s)…');

    try{
      const [svg] = await Promise.all([ aiToSVG(prompt), sleep(MIN_AI_WAIT_MS) ]);
      if (svgIn) svgIn.value = svg;
      if (prevHost) {
        prevHost.innerHTML = svg;
        const s = prevHost.querySelector('svg');
        if (s) {
          s.setAttribute('preserveAspectRatio','xMidYMid meet');
          s.style.maxWidth='100%';
          s.style.height='auto';
          s.style.display='block';
        }
        prevHost.scrollTop = prevHost.scrollHeight;
        prevHost.scrollIntoView({block:'nearest'});
      }
      STATE.currentSVG = svg;
      saveDraft();
      const m = root.querySelector('#btnMint'); if (m) m.style.display = 'inline-block';
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

  btnPrev && btnPrev.addEventListener('click', ()=>{
    const cleaned = sanitizeSVG(svgIn?.value);
    if (!cleaned){ alert('SVG failed moderation/sanitize'); return; }
    if (prevHost) {
      prevHost.innerHTML = cleaned;
      const s = prevHost.querySelector('svg');
      if (s) {
        s.setAttribute('preserveAspectRatio','xMidYMid meet');
        s.style.maxWidth='100%';
        s.style.height='auto';
        s.style.display='block';
      }
      prevHost.scrollTop = prevHost.scrollHeight;
      prevHost.scrollIntoView({block:'nearest'});
    }
    STATE.currentSVG = cleaned;
    saveDraft();
    const m = root.querySelector('#btnMint'); if (m) m.style.display = 'inline-block';
  });

  btnMint && btnMint.addEventListener('click', async ()=>{
    craftStatus.textContent = '';

    const nm = moderateName(STATE.currentName);
    if (!nm.ok){ craftStatus.textContent = nm.reason; return; }

    const hasCredit  = totalMintCredits() > 0;
    if (!hasCredit){
      craftStatus.textContent = 'Please pay (Pi or IC) first, or buy a package.';
      return;
    }
    if (!STATE.currentSVG){ craftStatus.textContent = 'Add/Preview SVG first.'; return; }

    const sellInShop = !!root.querySelector('#sellInShop')?.checked;
    const sellInPi   = !!root.querySelector('#sellInPi')?.checked;
    const priceIC    = Math.max(COSTS.SHOP_MIN_IC, Math.min(COSTS.SHOP_MAX_IC, parseInt(root.querySelector('#shopPrice')?.value||'100',10)||100));

    try{
      const normalizedForSlot = normalizeSvgForSlot(STATE.currentSVG, STATE.currentPart);

      const injected = (window.ArmourPacks && typeof window.ArmourPacks.injectCraftedItem==='function')
        ? window.ArmourPacks.injectCraftedItem({
            name: STATE.currentName,
            category: STATE.currentCategory,
            part: STATE.currentPart,
            svg: normalizedForSlot,
            priceIC,
            sellInShop,
            sellInPi,
            featureFlags: STATE.featureFlags,
            tracerPreset: STATE.tracerPreset,
            swingPreset: STATE.swingPreset
          })
        : { ok:false, reason:'armour-packs-hook-missing' };

      if (injected && injected.ok){
        // ---- SUCCESS: Minted ----
        craftStatus.textContent = 'Crafted ✓';

        // Handle credit burn (single or package)
        if (STATE.packageCredits && STATE.packageCredits.items > 0){
          STATE.packageCredits.items -= 1;
          if (STATE.packageCredits.items <= 0) STATE.packageCredits = null;
        } else if (typeof STATE.mintCredits === 'number') {
          STATE.mintCredits = Math.max(0, (STATE.mintCredits|0) - 1);
        }
        STATE.canUseVisuals = totalMintCredits() > 0;
        // Persist singles to storage + refresh header badge now that we burned a credit
        setCraftingCredits(STATE.mintCredits | 0, 'burn');   // allow downgrade only on burn
        updateTabsHeaderCredits();                   // updates the “Create Item” badge
        _syncVisualsTabStyle();                      // reflect whether Visuals should be enabled

        // Persist + get craftedId (from inject OR server)
        let craftedId = injected.id || null;
        try {
          const u = encodeURIComponent(
            (window?.IZZA?.player?.username)
            || (window?.IZZA?.me?.username)
            || localStorage.getItem('izzaPlayer')
            || localStorage.getItem('pi_username')
            || ''
          );
          if (u) {
            const resp = await serverJSON(gameApi(`/api/crafting/mine?u=${u}`), {
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
            if (resp && resp.ok && resp.id && !craftedId) craftedId = resp.id;
          }
        } catch(e) {
          console.warn('[craft] persist failed:', e);
        }

        // Mirror into My Creations + optional refresh
        try { mirrorInjectedInventoryToMine(injected); } catch {}
        try { hydrateMine(); } catch {}

        // After a successful Mint: return to Setup
        STATE.createSub = 'setup';
        const host = STATE.root?.querySelector('#craftTabs');
        if (host){
          host.innerHTML = renderCreate();
          bindInside();
          bindFeatureMeters(STATE.root);
          _syncVisualsTabStyle();
        }

        // Optional IZZA Pay merchant handoff
        if (sellInPi && craftedId) {
          const BUS = (window.parent && window.parent.IZZA) ? window.parent.IZZA : window.IZZA;
          try { BUS?.emit?.('merchant-handoff', { craftedId }); } catch {}
          const qs = new URLSearchParams({ attach: String(craftedId) });
          try {
            const t = localStorage.getItem('izzaBearer') || '';
            if (t) qs.set('t', t);
          } catch {}
          location.href = `/merchant?${qs.toString()}`;
        }
      } else {
        craftStatus.textContent = 'Mint failed: ' + (injected?.reason || 'armour hook missing');
      }
    }catch(e){
      craftStatus.textContent = 'Error crafting: ' + e.message;
    }
  }); // <-- closes btnMint handler

  // finally, wire sliders/meters + presets on initial render
  bindFeatureMeters(STATE.root);

  // Make sure totals reflect any persisted draft immediately
  const totals = calcDynamicPrice();
  const piTotal = root.querySelector('#totalPiDisp');
  const icTotal = root.querySelector('#totalIcDisp');
  if (piTotal) piTotal.textContent = `${totals.pi} Pi`;
  if (icTotal) icTotal.textContent = `${totals.ic.toLocaleString()} IC`;
  const icBtn = document.getElementById('payIC');
  if (icBtn) icBtn.textContent = `Pay ${totals.ic.toLocaleString()} IC`;
  const piBtn = document.getElementById('payPi');
  if (piBtn) piBtn.textContent = `Pay ${totals.pi} Pi`;

  _syncVisualsTabStyle();
} // <-- closes bindInside()

/* ---------- Public API ---------- */
window.CraftingUI = { mount, unmount };
})(); // <-- closes IIFE
