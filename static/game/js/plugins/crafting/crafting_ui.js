// /static/game/js/plugins/crafting/crafting_ui.js
(function(){
  const COSTS = Object.freeze({
    PER_ITEM_IC:   0,
    PER_ITEM_PI:   5,
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
    currentCategory: 'armour',
    currentPart: 'helmet',
    fireRateRequested: 0,
    dmgHearts: 0.5,
    packageCredits: null,
    createSub: 'setup',
  };
// === High-Variety Icon/Overlay Generator ==============================
// Deterministic variety using seed(name+prompt+attempt). Produces 128x128 SVGs.
// Uses gradients, masks, glows, decals, and part-aware silhouettes.
(function(){
  function hash32(str){
    let h = 2166136261 >>> 0;
    for (let i=0;i<str.length;i++){ h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function rng(seed){ let x = seed||123456789; return ()=>((x^=x<<13,x^=x>>>17,x^=x<<5)>>>0)/4294967296; }
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const pick=(r,arr)=>arr[(r()*arr.length)|0];

  // 16 curated palettes (trim/background, base, shade, accent/glow)
  const PALETTES = [
    ["#0b1020","#7b3cff","#4321a1","#ff66ff"],
    ["#0f172a","#00c2a8","#0a7a6c","#8affec"],
    ["#1f2937","#ff6a3a","#9c3e1e","#ffd0a6"],
    ["#111111","#d6a740","#8c6a1f","#ffe17a"],
    ["#151016","#c13b8a","#7b2458","#ff9ed3"],
    ["#081421","#50b0ff","#215e96","#a8ddff"],
    ["#131a12","#6bd67b","#2c6b37","#ccffd8"],
    ["#1a1113","#ff6b9a","#953457","#ffd0e1"],
    ["#0d141b","#7cf2ff","#256c73","#e3ffff"],
    ["#1a1a26","#b4b8ff","#4f52a6","#e0e2ff"],
    ["#0d0b0f","#ff9f3b","#83420e","#ffd6a8"],
    ["#0b0f14","#78ffbd","#2f7358","#d6ffe9"],
    ["#16130f","#ffc95a","#7f5620","#ffe5a0"],
    ["#0e1220","#a45bff","#4e2a91","#e3c7ff"],
    ["#091311","#7ff4cf","#2f7062","#d5fff2"],
    ["#0a0a12","#ff5f5f","#8a2e2e","#ffc4c4"],
  ];

  // Decals to overlay (runes, chevrons, stars, grid, bolt, fangs)
  function decals(r, col){
    const op = (x)=>clamp(0.6 + r()*0.35, 0.55, 0.95);
    const k = (r()*6)|0;
    switch(k){
      case 0: return `<path d="M64 40 L74 64 L64 88 L54 64 Z" fill="${col}" opacity="${op()}"/>`;
      case 1: return `<path d="M28 74 L64 88 L100 74 L100 82 L64 96 L28 82Z" fill="${col}" opacity="${op()}"/>`;
      case 2: return `<g opacity="${op()}">${Array.from({length:5},(_,i)=>`<rect x="${30+i*16}" y="56" width="6" height="6" fill="${col}"/>`).join('')}</g>`;
      case 3: return `<path d="M64 36 L82 76 L46 56 L82 56 L46 76Z" fill="${col}" opacity="${op()}"/>`;
      case 4: return `<path d="M62 44 L70 44 L64 66 L84 66 L48 96 L58 74 L44 74Z" fill="${col}" opacity="${op()}"/>`;
      default:return `<path d="M48 84 c8 2 10 8 16 8 c6 0 8-6 16-8" stroke="${col}" stroke-width="5" fill="none" opacity="${op()}"/>`;
    }
  }

  // Silhouettes per part
  function shellHelmet(base,shade){
    return `
      <path d="M20 62c0-24 22-40 40-44c6-1 10-2 20 0c18 3 40 20 40 44v20c0 8-6 14-14 14H34c-8 0-14-6-14-14V62z" fill="${base}"/>
      <rect x="28" y="78" width="72" height="12" rx="6" fill="${shade}"/>`;
  }
  function shellVest(base,shade){
    return `
      <path d="M30 36h68c8 0 14 6 14 14v44c0 8-6 14-14 14H30c-8 0-14-6-14-14V50c0-8 6-14 14-14z" fill="${base}"/>
      <rect x="34" y="56" width="60" height="14" rx="6" fill="${shade}"/>`;
  }
  function shellArms(base,shade){
    return `
      <rect x="18" y="52" width="22" height="36" rx="8" fill="${base}"/>
      <rect x="88" y="52" width="22" height="36" rx="8" fill="${base}"/>
      <rect x="22" y="66" width="14" height="12" rx="4" fill="${shade}"/>
      <rect x="92" y="66" width="14" height="12" rx="4" fill="${shade}"/>`;
  }
  function shellLegs(base,shade){
    return `
      <rect x="36" y="54" width="20" height="46" rx="6" fill="${base}"/>
      <rect x="72" y="54" width="20" height="46" rx="6" fill="${base}"/>
      <rect x="36" y="74" width="56" height="8" rx="4" fill="${shade}"/>`;
  }
  function shellGun(base,shade){
    return `
      <rect x="20" y="54" width="74" height="18" rx="4" fill="${base}"/>
      <rect x="76" y="72" width="12" height="24" rx="2" fill="${shade}"/>
      <rect x="96" y="58" width="12" height="6" fill="${base}"/>`;
  }
  function shellMelee(base,shade){
    return `
      <rect x="60" y="22" width="8" height="64" rx="2" fill="${base}"/>
      <rect x="48" y="78" width="32" height="10" rx="5" fill="${shade}"/>`;
  }

  // Horn/crest add-ons (mostly for helmets)
  function horns(r, base, shade){
    const t = (r()*3)|0;
    if (t===0) return '';
    if (t===1) return `<path d="M40 30c-8 6-12 16-12 28c8-6 18-6 26-2c0-12-4-20-14-26z" fill="${base}"/>
                       <path d="M88 30c8 6 12 16 12 28c-8-6-18-6-26-2c0-12 4-20 14-26z" fill="${base}"/>`;
    return `<path d="M34 46c-6 0-8 8-2 12c2 1 4 1 6 0c2-2 3-6 1-9c-1-2-3-3-5-3z" fill="${shade}"/>
            <path d="M94 46c6 0 8 8 2 12c-2 1-4 1-6 0c-2-2-3-6-1-9c1-2 3-3 5-3z" fill="${shade}"/>`;
  }

  // One generator to rule them all
  function genSVG({ name="", prompt="", part="helmet", seedExtra=0 } = {}){
    const seed = hash32(`${name}::${prompt}::${part}::${seedExtra}`);
    const r = rng(seed);
    const [trim, base, shade, glow] = pick(r, PALETTES);
    const bgRad = 48 + (r()*20|0);
    const useGrid = r() > 0.6;
    const useMask = r() > 0.5;
    const glowBlur = 2 + (r()*3|0);

    // choose shell by part
    const shell =
      part==="helmet" ? shellHelmet(base,shade) :
      part==="vest"   ? shellVest(base,shade)   :
      part==="arms"   ? shellArms(base,shade)   :
      part==="legs"   ? shellLegs(base,shade)   :
      part==="gun"    ? shellGun(base,shade)    :
      part==="melee"  ? shellMelee(base,shade)  :
                        shellVest(base,shade);

    // hero overlay (decal + optional horns if helmet)
    const overlay =
      (part==="helmet" ? horns(r,base,shade) : '') +
      decals(r, glow);

    // subtle grid or vignette
    const bg = useGrid
      ? Array.from({length:6},(_,i)=>`<rect x="${16+i*18}" y="16" width="2" height="96" fill="${trim}" opacity="0.18"/>`).join('')
      : `<radialGradient id="g${seed}" cx="50%" cy="40%" r="60%"><stop offset="0%" stop-color="${trim}" stop-opacity="1"/><stop offset="100%" stop-color="${trim}" stop-opacity="0.6"/></radialGradient><rect x="4" y="4" width="120" height="120" rx="14" fill="url(#g${seed})"/>`;

    // fancy mask ring
    const mask = useMask
      ? `<mask id="m${seed}">
           <rect x="0" y="0" width="128" height="128" fill="black"/>
           <circle cx="64" cy="${bgRad}" r="${bgRad}" fill="white"/>
         </mask>`
      : '';

    // glow filter
    const filter = `<filter id="f${seed}" x="-20%" y="-20%" width="140%" height="140%">
        <feGaussianBlur stdDeviation="${glowBlur}" result="b"/>
        <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>`;

    return `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <defs>
    ${filter}
    ${mask}
  </defs>
  <rect x="4" y="4" width="120" height="120" rx="14" fill="${trim}"/>
  ${bg}
  <g ${useMask ? `mask="url(#m${seed})"` : ''}>
    <g filter="url(#f${seed})">
      ${shell}
      ${overlay}
    </g>
  </g>
  <path d="M28 40 Q64 ${36+((r()*10)|0)} 100 40" stroke="#fff" stroke-opacity="${0.08 + r()*0.1}" stroke-width="${2 + (r()*2|0)}" fill="none"/>
</svg>`;
  }

  // Expose globally
  window.IzzaArtGen = { genSVG };
})();
  const API_BASE = (window.IZZA_PERSIST_BASE || '').replace(/\/+$/,'');
  const api = (p)=> (API_BASE ? API_BASE + p : p);

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
      const cleaned = txt
        .replace(/xlink:href\s*=\s*["'][^"']*["']/gi,'')
        .replace(/\son\w+\s*=\s*["'][^"']*["']/gi,'')
        .replace(/href\s*=\s*["']\s*(?!#)[^"']*["']/gi,'')
        .replace(/(javascript:|data:)/gi,'')
        .replace(/<metadata[\s\S]*?<\/metadata>/gi,'')
        .replace(/<!DOCTYPE[^>]*>/gi,'')
        .replace(/<\?xml[\s\S]*?\?>/gi,'');
      return cleaned;
    }catch(e){ return ''; }
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
  function calcTotalCost({ usePi }){ const base = usePi ? COSTS.PER_ITEM_PI : COSTS.PER_ITEM_IC; const addon = usePi ? COSTS.ADDON_PI : COSTS.ADDON_IC; return base + addon * selectedAddOnCount(); }

  // --- AI prompt: server first, then local fallback (keywords -> SVG) ---
    // --- AI prompt: server first, then local high-variety generator ---
  async function aiToSVG(prompt){
    if (STATE.aiAttemptsLeft <= 0) throw new Error('No attempts left');

    // 1) Try server (unchanged)
    try{
      const j = await serverJSON(api('/api/crafting/ai_svg'), { method:'POST', body:JSON.stringify({
        prompt,
        // Helpful hints for your server model (optional):
        meta: {
          part: STATE.currentPart,
          category: STATE.currentCategory,
          name: STATE.currentName
        }
      }) });
      if (j && j.ok && j.svg){
        const cleaned = sanitizeSVG(j.svg);
        if (!cleaned) throw new Error('SVG rejected');
        STATE.aiAttemptsLeft -= 1;
        return cleaned;
      }
    }catch{}

    // 2) Local fallback: generate a "high-end" SVG with tons of variety
    // Seed with name + prompt + remaining attempts to guarantee change each click
    const seedExtra = (COSTS.AI_ATTEMPTS - STATE.aiAttemptsLeft) + Math.floor(performance.now()%1000);
    const raw = (window.IzzaArtGen && IzzaArtGen.genSVG)
      ? IzzaArtGen.genSVG({ name: STATE.currentName||'', prompt: String(prompt||''), part: STATE.currentPart||'helmet', seedExtra })
      : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect x="16" y="28" width="96" height="72" rx="10" fill="#2c3750"/><circle cx="64" cy="64" r="22" fill="#cfe0ff"/></svg>`;

    STATE.aiAttemptsLeft -= 1;
    return sanitizeSVG(raw);
  }

  function renderTabs(){
    return `
      <div style="display:flex; gap:8px; padding:10px; border-bottom:1px solid #2a3550; background:#0f1624">
        <button class="ghost" data-tab="packages">Packages</button>
        <button class="ghost" data-tab="create">Create Item</button>
        <button class="ghost" data-tab="mine">My Creations</button>
        <div style="margin-left:auto; opacity:.7; font-size:12px">AI attempts left: <b id="aiLeft">${STATE.aiAttemptsLeft}</b></div>
      </div>`;
  }

  function renderPackages(){
    return `
      <div style="padding:14px; display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:10px">
        <div style="background:#0f1522;border:1px solid #2a3550;border-radius:10px;padding:12px">
          <div style="font-weight:700;margin-bottom:6px">Starter Forge</div>
          <div style="opacity:.85;font-size:13px;line-height:1.4">
            2× Weapons (½-heart dmg), 1× Armour set (+0.25% speed, 25% DR).<br/>Includes features & listing rights.
          </div>
          <div style="margin-top:8px;font-weight:700">Cost: 50 Pi</div>
          <div style="display:flex;gap:8px;margin-top:10px;justify-content:flex-end">
            <button class="ghost" data-buy-package="starter-50">Buy</button>
          </div>
        </div>
        <div style="background:#0f1522;border:1px solid #2a3550;border-radius:10px;padding:12px">
          <div style="font-weight:700;margin-bottom:6px">Single Item (visual)</div>
          <div style="opacity:.85;font-size:13px;">Craft 1 item (no gameplay features).</div>
          <div style="display:flex;gap:8px;margin-top:10px;justify-content:flex-end">
            <button class="ghost" data-buy-single="pi">Pay 5 Pi</button>
            <button class="ghost" data-buy-single="ic">Pay 5000 IC</button>
          </div>
        </div>
      </div>`;
  }

  function renderCreate(){
    const totalPi = calcTotalCost({ usePi:true });
    const totalIC = calcTotalCost({ usePi:false });
    const sub = STATE.createSub === 'visuals' ? 'visuals' : 'setup';

    return `
      <div class="cl-subtabs">
        <button class="${sub==='setup'?'on':''}"   data-sub="setup">Setup</button>
        <button class="${sub==='visuals'?'on':''}" data-sub="visuals">Visuals</button>
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
          <select id="partSel">
            <option value="helmet">Helmet</option>
            <option value="vest">Vest</option>
            <option value="arms">Arms</option>
            <option value="legs">Legs</option>
            <option value="gun">Gun</option>
            <option value="melee">Melee</option>
          </select>

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
            <div style="margin-top:4px">
              <label><input id="sellInPi" type="checkbox"/> Also sell bundle in Crafting Land (Pi)</label>
            </div>
          </div>
        </div>

        <div class="cl-pane cl-preview">
          <div style="display:flex; gap:10px; align-items:center">
            <div style="font-weight:700">Visuals</div>
            <div style="font-size:12px; opacity:.75">AI attempts left: <b id="aiLeft2">${STATE.aiAttemptsLeft}</b></div>
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

  async function fetchMine(){
    try{
      const j = await serverJSON(api('/api/crafting/mine'));
      return (j && j.ok && Array.isArray(j.items)) ? j.items : [];
    }catch{ return []; }
  }

  function mineCardHTML(it){
    const safeSVG = sanitizeSVG(it.svg||'');
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
        try{ window.IZZA && IZZA.emit && IZZA.emit('equip-crafted', b.dataset.equip); }catch{}
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
    };

    root.querySelectorAll('[data-tab]').forEach(b=>{
      b.addEventListener('click', ()=> setTab(b.dataset.tab));
    });

    setTab('packages');
  }

  function unmount(){ if(!STATE.root) return; STATE.root.innerHTML=''; STATE.mounted=false; }

  async function handleBuySingle(kind){
    const usePi = (kind==='pi');
    const total = calcTotalCost({ usePi });
    let res;
    if (usePi) res = await payWithPi(total, 'Craft Single Item');
    else       res = await payWithIC(total);
    const status = document.getElementById('payStatus');
    if (res && res.ok){ STATE.hasPaidForCurrentItem = true; status && (status.textContent='Paid ✓ — you can craft now.'); }
    else { status && (status.textContent='Payment failed.'); }
  }

  function bindInside(){
    const root = STATE.root;
    if(!root) return;

    STATE.root.querySelectorAll('[data-sub]').forEach(b=>{
      b.addEventListener('click', ()=>{
        STATE.createSub = (b.dataset.sub === 'visuals') ? 'visuals' : 'setup';
        const host = STATE.root.querySelector('#craftTabs');
        if (!host) return;
        const saveScroll = host.scrollTop;
        host.innerHTML = renderCreate();
        bindInside();
        host.scrollTop = saveScroll;
      }, { passive:true });
    });

    root.querySelectorAll('[data-buy-package]').forEach(btn=>{
      btn.addEventListener('click', async ()=>{
        const id = btn.dataset.buyPackage;
        const res = await payWithPi(50, `Package:${id}`);
        if(res.ok){ STATE.packageCredits = { id, items:3, featuresIncluded:true }; alert('Package unlocked — start creating!'); }
      }, { passive:true });
    });

    root.querySelectorAll('[data-buy-single]').forEach(btn=>{
      btn.addEventListener('click', ()=> handleBuySingle(btn.dataset.buySingle), { passive:true });
    });

    const payPi = root.querySelector('#payPi');
    const payIC = root.querySelector('#payIC');
    payPi && payPi.addEventListener('click', ()=> handleBuySingle('pi'), { passive:true });
    payIC && payIC.addEventListener('click', ()=> handleBuySingle('ic'), { passive:true });

    const itemName = root.querySelector('#itemName');
    if (itemName){
      itemName.value = STATE.currentName || '';
      itemName.addEventListener('input', e=>{ STATE.currentName = e.target.value; saveDraft(); }, { passive:true });
    }

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

    const catSel  = root.querySelector('#catSel');
    const partSel = root.querySelector('#partSel');
    if (catSel){  catSel.value = STATE.currentCategory; catSel.addEventListener('change', e=>{ STATE.currentCategory = e.target.value; saveDraft(); }, { passive:true }); }
    if (partSel){ partSel.value = STATE.currentPart;     partSel.addEventListener('change', e=>{ STATE.currentPart     = e.target.value; saveDraft(); }, { passive:true }); }

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

    btnAI && btnAI.addEventListener('click', async ()=>{
      try{
        const prompt = String(aiPrompt?.value||'').trim();
        if (!prompt) return;
        const svg = await aiToSVG(prompt);
        if (svgIn) svgIn.value = svg;
        if (prevHost) {
          prevHost.innerHTML = svg;
          const s = prevHost.querySelector('svg');
          if (s) { s.setAttribute('preserveAspectRatio','xMidYMid meet'); s.style.maxWidth='100%'; s.style.height='auto'; s.style.display='block'; }
          prevHost.scrollTop = prevHost.scrollHeight;
          prevHost.scrollIntoView({block:'nearest'});
        }
        STATE.currentSVG = svg;
        saveDraft();
        const m = root.querySelector('#btnMint'); if (m) m.style.display = 'inline-block';
        aiLeft();
      }catch(e){ alert('AI failed: '+e.message); }
    });

    btnPrev && btnPrev.addEventListener('click', ()=>{
      const cleaned = sanitizeSVG(svgIn?.value);
      if (!cleaned){ alert('SVG failed moderation/sanitize'); return; }
      if (prevHost) {
        prevHost.innerHTML = cleaned;
        const s = prevHost.querySelector('svg');
        if (s) { s.setAttribute('preserveAspectRatio','xMidYMid meet'); s.style.maxWidth='100%'; s.style.height='auto'; s.style.display='block'; }
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

      const freeTest = (COSTS.PER_ITEM_IC === 0 && selectedAddOnCount() === 0);
      if (!STATE.hasPaidForCurrentItem && !STATE.packageCredits && !freeTest){
        craftStatus.textContent = 'Please pay (Pi or IC) first, or buy a package.';
        return;
      }
      if (!STATE.currentSVG){ craftStatus.textContent = 'Add/Preview SVG first.'; return; }

      const sellInShop = !!root.querySelector('#sellInShop')?.checked;
      const sellInPi   = !!root.querySelector('#sellInPi')?.checked;
      const priceIC    = Math.max(COSTS.SHOP_MIN_IC, Math.min(COSTS.SHOP_MAX_IC, parseInt(root.querySelector('#shopPrice')?.value||'100',10)||100));

      try{
        const injected = (window.ArmourPacks && typeof window.ArmourPacks.injectCraftedItem==='function')
          ? window.ArmourPacks.injectCraftedItem({
              name: STATE.currentName,
              category: STATE.currentCategory,
              part: STATE.currentPart,
              svg: STATE.currentSVG,
              priceIC,
              sellInShop,
              sellInPi,
              featureFlags: STATE.featureFlags   // <— pass through for guns.js-friendly hints
            })
          : { ok:false, reason:'armour-packs-hook-missing' };

        if (injected && injected.ok){
          craftStatus.textContent = 'Crafted ✓';
          STATE.hasPaidForCurrentItem = false;
          if (STATE.packageCredits && STATE.packageCredits.items > 0){
            STATE.packageCredits.items -= 1;
            if (STATE.packageCredits.items <= 0) STATE.packageCredits = null;
          }
          try{ hydrateMine(); }catch{}
        }else{
          craftStatus.textContent = 'Mint failed: '+(injected?.reason||'armour hook missing');
        }
      }catch(e){ craftStatus.textContent = 'Error crafting: '+e.message; }
    });
  }

  window.CraftingUI = { mount, unmount };
})();
