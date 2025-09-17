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
    // --- TEST PRICES (requested) ---
    PER_ITEM_IC:   0,         // single item crafting: 0 IC (testing)
    PER_ITEM_PI:   0.005,     // single item crafting: 0.005 Pi (testing)
    // --- Package (Starter Forge) ---
    PACKAGE_PI:    5,
    PACKAGE_IC:    10000,
    // --- Feature add-ons (unchanged unless you change server rules) ---
    ADDON_IC:      1000,
    ADDON_PI:      1,
    SHOP_MIN_IC:   50,
    SHOP_MAX_IC:   250,
    AI_ATTEMPTS:   5
  });

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
    createSub: 'setup',
    canUseVisuals: false       // visuals locked until successful purchase
  };

  // (Kept: name moderation + sanitizers + helpers)
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

      // strip obvious background fills so overlays are transparent
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
  function getIC(){
    try{ return parseInt(localStorage.getItem('izzaCoins')||'0',10)||0; }catch{ return 0; }
  }
  function setIC(v){
    try{
      localStorage.setItem('izzaCoins', String(Math.max(0, v|0)));
      window.dispatchEvent(new Event('izza-coins-changed'));
    }catch{}
  }

  // Force default API base to the Node service on Render.
// You can still override with window.IZZA_PERSIST_BASE if you ever need to.
const API_BASE = ((window.IZZA_PERSIST_BASE && String(window.IZZA_PERSIST_BASE)) || 'https://izzagame.onrender.com').replace(/\/+$/,'');
const api = (p)=> (API_BASE ? API_BASE + p : p);

  async function serverJSON(url, opts={}){
    const r = await fetch(url, Object.assign({ headers:{'content-type':'application/json'} }, opts));
    if(!r.ok) throw new Error('HTTP '+r.status);
    return await r.json().catch(()=> ({}));
  }

  async function payWithPi(amountPi, memo){
    if (!window.Pi || typeof window.Pi.createPayment!=='function'){
      alert('Pi SDK not available'); return { ok:false, reason:'no-pi' };
    }
    try{
      const paymentData = { amount: String(amountPi), memo: memo || 'IZZA Crafting', metadata: { kind:'crafting', memo } };
      const res = await window.Pi.createPayment(paymentData, {
        onReadyForServerApproval: async (paymentId) => {
          await serverJSON(api('/api/crafting/pi/approve'), { method:'POST', body:JSON.stringify({ paymentId }) });
        },
        onReadyForServerCompletion: async (paymentId, txid) => {
          await serverJSON(api('/api/crafting/pi/complete'), { method:'POST', body:JSON.stringify({ paymentId, txid }) });
        }
      });
      if (res && res.status && /complete/i.test(res.status)) return { ok:true, receipt:res };
      return { ok:false, reason:'pi-not-complete', raw:res };
    }catch(e){ console.warn('[craft] Pi pay failed', e); return { ok:false, reason:String(e) }; }
  }

  async function payWithIC(amountIC){
    const cur = getIC();
    if (cur < amountIC) return { ok:false, reason:'not-enough-ic' };
    setIC(cur - amountIC);
    try{ await serverJSON(api('/api/crafting/ic/debit'), { method:'POST', body:JSON.stringify({ amount:amountIC }) }); }catch{}
    return { ok:true };
  }

  function selectedAddOnCount(){ return Object.values(STATE.featureFlags).filter(Boolean).length; }
  function calcTotalCost({ usePi, includeAddons=true }){
    const base  = usePi ? COSTS.PER_ITEM_PI  : COSTS.PER_ITEM_IC;
    const addon = usePi ? COSTS.ADDON_PI     : COSTS.ADDON_IC;
    return base + (includeAddons ? addon * selectedAddOnCount() : 0);
  }

  // --- AI prompt: server first, then minimal fallback ---
async function aiToSVG(prompt){
  if (STATE.aiAttemptsLeft <= 0) throw new Error('No attempts left');

  try{
    const j = await serverJSON(api('/api/crafting/ai_svg'), {
      method:'POST',
      body: JSON.stringify({
        prompt: composeAIPrompt(prompt, STATE.currentPart, {
          style: STATE.aiStyle,
          animate: STATE.wantAnimation
        }),
        meta: {
          part: mapPartForServer(STATE.currentPart),
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
      <div style="padding:14px; display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:10px">
        <div style="background:#0f1522;border:1px solid #2a3550;border-radius:10px;padding:12px">
          <div style="font-weight:700;margin-bottom:6px">Starter Forge</div>
          <div style="opacity:.85;font-size:13px;line-height:1.4">
            2× Weapons (½-heart dmg), 1× Armour set (+0.25% speed, 25% DR).<br/>Includes features & listing rights.
          </div>
          <div style="margin-top:8px;font-weight:700">Cost: ${COSTS.PACKAGE_PI} Pi or ${COSTS.PACKAGE_IC.toLocaleString()} IC</div>
          <div style="display:flex;gap:8px;margin-top:10px;justify-content:flex-end;flex-wrap:wrap">
            <button class="ghost" data-buy-package-pi="starter-50">Pay ${COSTS.PACKAGE_PI} Pi</button>
            <button class="ghost" data-buy-package-ic="starter-50">Pay ${COSTS.PACKAGE_IC.toLocaleString()} IC</button>
          </div>
        </div>

        <div style="background:#0f1522;border:1px solid #2a3550;border-radius:10px;padding:12px">
          <div style="font-weight:700;margin-bottom:6px">Single Item (visual)</div>
          <div style="opacity:.85;font-size:13px;">Craft 1 item (no gameplay features).</div>
          <div style="display:flex;gap:8px;margin-top:10px;justify-content:flex-end">
            <button class="ghost" data-buy-single="pi">Pay ${COSTS.PER_ITEM_PI} Pi</button>
            <button class="ghost" data-buy-single="ic">Pay ${COSTS.PER_ITEM_IC} IC</button>
          </div>
        </div>

        <div style="background:#0f1522;border:1px dashed #2a3550;border-radius:10px;padding:12px">
          <div style="font-weight:700;margin-bottom:6px">Crafting Land Marketplace</div>
          <div style="opacity:.85;font-size:13px;">Browse player-made bundles and buy with Pi.</div>
          <div style="display:flex;gap:8px;margin-top:10px;justify-content:flex-end">
            <button class="ghost" id="goMarketplace">Open Marketplace</button>
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

        <div style="display:flex; gap:8px; margin-top:10px; flex-wrap:wrap">
          <button class="ghost" id="payPi">Pay Pi</button>
          <button class="ghost" id="payIC">Pay IC</button>
          <span id="payStatus" style="font-size:12px; opacity:.8"></span>
        </div>

        <div style="margin-top:12px;border-top:1px solid #2a3550;padding-top:10px">
          <div style="font-weight:700;margin-bottom:6px">Shop Listing</div>
          <div style="font-size:12px;opacity:.8">Set price (server range ${COSTS.SHOP_MIN_IC}-${COSTS.SHOP_MAX_IC} IC)</div>
          <input id="shopPrice" type="number" min="${COSTS.SHOP_MIN_IC}" max="${COSTS.SHOP_MAX_IC}" value="100" style="width:120px"/>
          <div style="margin-top:6px">
            <label><input id="sellInShop" type="checkbox" checked/> List in in-game shop (IC)</label>
          </div>
          <!-- removed: Also sell bundle in Crafting Land (Pi) -->
        </div>
      </div>

      <div class="cl-pane cl-preview">
        ${STATE.canUseVisuals ? `
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

          <div style="margin-top:8px">
            <label style="font-size:12px; opacity:.85">
              <input id="toMerchant" type="checkbox"/>
              Create an IZZA Pay product for this item
            </label>
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
        ` : `
          <div style="opacity:.8; font-size:13px; padding:12px; border:1px dashed #2a3550; border-radius:10px;">
            Visuals are locked. Complete payment in <b>Setup</b> or on the <b>Packages</b> tab to unlock (includes ${COSTS.AI_ATTEMPTS} AI attempts).
          </div>
        `}
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

  function currentUsername(){
    // adjust if your player name lives elsewhere; these are safe fallbacks:
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
      const j = await serverJSON(api(`/api/crafting/mine?u=${u}`));
      return (j && j.ok && Array.isArray(j.items)) ? j.items : [];
    }catch{ return []; }
  }

  function mineCardHTML(it){
    const safeSVG = sanitizeSVG(it.svg||'');
    const inShop = !!it.inShop;
    return `
      <div style="background:#0f1522;border:1px solid #2a3550;border-radius:10px;padding:10px">
        <div style="font-weight:700">${it.name||'Untitled'}</div>
        <div style="opacity:.75;font-size:12px">${it.category||'?'} / ${it.part||'?'}</div>
        <div style="margin-top:6px;border:1px solid #2a3550;border-radius:8px;background:#0b0f17;overflow:hidden;min-height:80px">
          ${safeSVG || '<div style="opacity:.6;padding:10px;font-size:12px">No SVG</div>'}
        </div>
        <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
          <button class="ghost" data-copy="${it.id}">Copy SVG</button>
          <button class="ghost" data-equip="${it.id}">Equip</button>
          ${inShop
            ? `<button class="ghost" data-stats="${it.id}">View Shop Stats</button>`
            : `<button class="ghost" data-addshop="${it.id}">Add to Shop</button>`}
        </div>
      </div>`;
  }

  async function hydrateMine(){
    const host = STATE.root?.querySelector('#mineList');
    if(!host) return;
    host.innerHTML = '<div style="opacity:.7">Loading…</div>';
    const items = await fetchMine();
    host.innerHTML = items.length
      ? items.map(mineCardHTML).join('')
      : '<div style="opacity:.7">No creations yet.</div>';

    host.querySelectorAll('[data-copy]').forEach(b=>{
      b.addEventListener('click', async ()=>{
        const id = b.dataset.copy;
        const it = items.find(x=>x.id===id);
        if(!it) return;
        try{ await navigator.clipboard.writeText(it.svg||''); alert('SVG copied'); }catch{}
      });
    });
    host.querySelectorAll('[data-equip]').forEach(b=>{
      b.addEventListener('click', ()=>{
        const id = b.dataset.equip;
        const it = items.find(x=>x.id===id);
        if (!it) return;

        // Persist + fire events (you already have this)
        try {
          localStorage.setItem('izzaLastEquipped', JSON.stringify({
            id: it.id, name: it.name, category: it.category, part: it.part, svg: it.svg
          }));
        } catch {}
        try { IZZA?.emit?.('equip-crafted', id); } catch{}
        try { IZZA?.emit?.('equip-crafted-v2', { id: it.id, name: it.name, category: it.category, part: it.part, svg: it.svg }); } catch{}
      });
    });
    host.querySelectorAll('[data-addshop]').forEach(b=>{
      b.addEventListener('click', async ()=>{
        const id = b.dataset.addshop;
        const it = items.find(x=>x.id===id);
        if(!it) return;
        try{
          const u = encodeURIComponent(currentUsername());
          const priceIC = Math.max(COSTS.SHOP_MIN_IC, Math.min(COSTS.SHOP_MAX_IC, 100));
          const j = await serverJSON(api(`/api/shop/add?u=${u}`), {
            method:'POST',
            body: JSON.stringify({ id: it.id, priceIC })
          });
          if (j && j.ok){ alert('Added to shop!'); hydrateMine(); }
          else { alert('Failed to add to shop'); }
        }catch(e){ alert('Failed to add to shop'); }
      });
    });
    host.querySelectorAll('[data-stats]').forEach(b=>{
      b.addEventListener('click', async ()=>{
        try{
          const id = b.dataset.stats;
          const j = await serverJSON(api(`/api/shop/stats?id=${encodeURIComponent(id)}`));
          if (j && j.ok){
            const s = j.stats||{};
            alert(`Sales: ${s.sold||0}\nPlayer resales: ${s.resold||0}`);
          } else {
            alert('No stats yet.');
          }
        }catch(e){ alert('Could not load stats'); }
      });
    });
  }

  function mount(rootSel){
    const root = (typeof rootSel==='string') ? document.querySelector(rootSel) : rootSel;
    if (!root) return;
    STATE.root = root;
    STATE.mounted = true;
    loadDraft();

    root.innerHTML = `${renderTabs()}<div id="craftTabs"></div>`;
    const tabsHost = root.querySelector('#craftTabs');

    const setTab = (name)=>{
      if(!STATE.mounted) return;
      if(name==='packages'){ tabsHost.innerHTML = renderPackages(); }
      if(name==='create'){   tabsHost.innerHTML = renderCreate(); }
      if(name==='mine'){     tabsHost.innerHTML = renderMine(); hydrateMine(); }

      bindInside();

      // keep attempts counter in sync when entering Visuals
      if (name === 'create' && STATE.canUseVisuals) {
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

  async function handleBuySingle(kind, { includeAddons=true } = {}){
    const usePi = (kind==='pi');
    const total = calcTotalCost({ usePi, includeAddons });
    let res;
    if (usePi) res = await payWithPi(total, includeAddons ? 'Craft Item (+features)' : 'Craft Item');
    else       res = await payWithIC(total);
    const status = document.getElementById('payStatus');
    if (res && res.ok){
      STATE.hasPaidForCurrentItem = true;
      STATE.canUseVisuals = true;
      STATE.aiAttemptsLeft = COSTS.AI_ATTEMPTS; // reset attempts each purchase
      if (status) status.textContent='Paid ✓ — visuals unlocked.';
      // auto-redirect to Visuals
      STATE.createSub = 'visuals';
      const host = STATE.root?.querySelector('#craftTabs');
      if (host){ host.innerHTML = renderCreate(); bindInside(); }
    }
    else { status && (status.textContent='Payment failed.'); }
  }

  function bindInside(){
    const root = STATE.root;
    if(!root) return;

    root.querySelectorAll('[data-sub]').forEach(b=>{
      b.addEventListener('click', ()=>{
        const want = (b.dataset.sub === 'visuals') ? 'visuals' : 'setup';
        // block visuals if locked
        STATE.createSub = (want==='visuals' && !STATE.canUseVisuals) ? 'setup' : want;
        const host = STATE.root.querySelector('#craftTabs');
        if (!host) return;
        const saveScroll = host.scrollTop;
        host.innerHTML = renderCreate();
        bindInside();
        host.scrollTop = saveScroll;
      }, { passive:true });
    });

    // Packages – package payment buttons
    root.querySelectorAll('[data-buy-package-pi]').forEach(btn=>{
      btn.addEventListener('click', async ()=>{
        const res = await payWithPi(COSTS.PACKAGE_PI, 'Starter Forge');
        if(res.ok){ STATE.packageCredits = { id:'starter-50', items:3, featuresIncluded:true }; alert('Package unlocked — start creating!'); }
      }, { passive:true });
    });
    root.querySelectorAll('[data-buy-package-ic]').forEach(btn=>{
      btn.addEventListener('click', async ()=>{
        const res = await payWithIC(COSTS.PACKAGE_IC);
        if(res.ok){ STATE.packageCredits = { id:'starter-50', items:3, featuresIncluded:true }; alert('Package unlocked — start creating!'); }
      }, { passive:true });
    });

    // Packages – single item purchase (no feature addons)
    root.querySelectorAll('[data-buy-single]').forEach(btn=>{
      btn.addEventListener('click', ()=> handleBuySingle(btn.dataset.buySingle, { includeAddons:false }), { passive:true });
    });

    // Marketplace button
    const goMp = root.querySelector('#goMarketplace');
    if (goMp){
      goMp.addEventListener('click', ()=> {
        try{ IZZA?.emit?.('open-marketplace'); }catch{}
      });
    }
  // Setup Pay buttons (include addons)
  const payPi = root.querySelector('#payPi');
  const payIC = root.querySelector('#payIC');
  payPi && payPi.addEventListener('click', ()=> handleBuySingle('pi', { includeAddons:true }), { passive:true });
  payIC && payIC.addEventListener('click', ()=> handleBuySingle('ic', { includeAddons:true }), { passive:true });

  // Basic form bindings
  const itemName = root.querySelector('#itemName');
  if (itemName){
    itemName.value = STATE.currentName || '';
    itemName.addEventListener('input', e=>{ STATE.currentName = e.target.value; saveDraft(); }, { passive:true });
  }

  // Feature flags
  root.querySelectorAll('[data-ff]').forEach(cb=>{
    const key = cb.dataset.ff;
    if (STATE.featureFlags && key in STATE.featureFlags) cb.checked = !!STATE.featureFlags[key];
    cb.addEventListener('change', ()=>{
      STATE.featureFlags[key] = cb.checked;
      saveDraft();
      const host = root.querySelector('#craftTabs');
      if (!host) return;
      const saveScroll = host.scrollTop;
      host.innerHTML = renderCreate();
      bindInside();
      host.scrollTop = saveScroll;
    });
  });

  // Category/part
  const catSel  = root.querySelector('#catSel');
  const partSel = root.querySelector('#partSel');

  if (catSel && partSel){
    catSel.value = STATE.currentCategory;
    repopulatePartOptions(catSel, partSel);

    catSel.addEventListener('change', e=>{
      STATE.currentCategory = e.target.value;
      repopulatePartOptions(catSel, partSel);
      saveDraft();
    }, { passive:true });
  }

  if (partSel){
    partSel.value = STATE.currentPart;
    partSel.addEventListener('change', e=>{
      STATE.currentPart = e.target.value;
      saveDraft();
    }, { passive:true });
  }

  // Visuals controls exist only when unlocked
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

  const aiLeft = ()=> {
    const b = document.getElementById('aiLeft2');
    if (b) b.textContent = STATE.aiAttemptsLeft;
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

  // === AI generate ===
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

  // === Manual preview ===
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

  // === Mint ===
  btnMint && btnMint.addEventListener('click', async ()=>{
    craftStatus && (craftStatus.textContent = '');

    const nm = moderateName(STATE.currentName);
    if (!nm.ok){ craftStatus && (craftStatus.textContent = nm.reason); return; }

    // Require payment (single or package) unless free IC testing with no addons
    const freeTest = (COSTS.PER_ITEM_IC === 0 && selectedAddOnCount() === 0);
    if (!STATE.hasPaidForCurrentItem && !STATE.packageCredits && !freeTest){
      craftStatus && (craftStatus.textContent = 'Please pay (Pi or IC) first, or buy a package.');
      return;
    }
    if (!STATE.currentSVG){ craftStatus && (craftStatus.textContent = 'Add/Preview SVG first.'); return; }

    const sellInShop = !!root.querySelector('#sellInShop')?.checked;
    const priceIC    = Math.max(COSTS.SHOP_MIN_IC, Math.min(COSTS.SHOP_MAX_IC, parseInt(root.querySelector('#shopPrice')?.value||'100',10)||100));
    const toMerchant = !!root.querySelector('#toMerchant')?.checked;

    try{
      // Normalize only at mint-time
      const normalizedForSlot = normalizeSvgForSlot(STATE.currentSVG, STATE.currentPart);

      // Inject into game
      const injected = (window.ArmourPacks && typeof window.ArmourPacks.injectCraftedItem==='function')
        ? window.ArmourPacks.injectCraftedItem({
            name: STATE.currentName,
            category: STATE.currentCategory,
            part: STATE.currentPart,
            svg: normalizedForSlot,
            priceIC,
            sellInShop,
            sellInPi: false, // removed bundle option for single items
            featureFlags: STATE.featureFlags
          })
        : { ok:false, reason:'armour-packs-hook-missing' };

      if (injected && injected.ok){
        // Local bookkeeping
        craftStatus && (craftStatus.textContent = 'Crafted ✓');
        STATE.hasPaidForCurrentItem = false;
        if (STATE.packageCredits && STATE.packageCredits.items > 0){
          STATE.packageCredits.items -= 1;
          if (STATE.packageCredits.items <= 0) STATE.packageCredits = null;
        }

        // Persist crafted item
        try{
          const u = encodeURIComponent(
            (window?.IZZA?.player?.username) ||
            (window?.IZZA?.me?.username) ||
            localStorage.getItem('izzaPlayer') ||
            localStorage.getItem('pi_username') ||
            ''
          );
          if (u) {
            await serverJSON(api(`/api/crafting/mine?u=${u}`), {
              method: 'POST',
              body: JSON.stringify({
                name: STATE.currentName,
                category: STATE.currentCategory,
                part: STATE.currentPart,
                svg: normalizedForSlot,
                priceIC,
                sellInShop,
                sku: '',
                image: ''
              })
            });
          }
        }catch(e){ console.warn('[craft] persist failed:', e); }

        // Optional: create merchant product
        if (toMerchant){
          try{
            await serverJSON(api('/api/merchant/create_from_craft'), {
              method:'POST',
              body: JSON.stringify({
                name: STATE.currentName,
                category: STATE.currentCategory,
                part: STATE.currentPart,
                svg: normalizedForSlot,
                priceIC
              })
            });
          }catch(e){ console.warn('[merchant] create failed:', e); }
        }

        // Refresh My Creations
        try{ hydrateMine(); }catch{}

      }else{
        craftStatus && (craftStatus.textContent = 'Mint failed: ' + (injected?.reason || 'armour hook missing'));
      }
    }catch(e){
      craftStatus && (craftStatus.textContent = 'Error crafting: ' + e.message);
    }
  });
} // end bindInside
})(); // end IIFE
