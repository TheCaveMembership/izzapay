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

  // *** CHANGE 1: force default API base to your Node service ***
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
  function calcTotalCost({ usePi }){ const base = usePi ? COSTS.PER_ITEM_PI : COSTS.PER_ITEM_IC; const addon = usePi ? COSTS.ADDON_PI : COSTS.ADDON_IC; return base + addon * selectedAddOnCount(); }

  // *** CHANGE 2: server-first, fallback is now a tiny basic blueprint icon ***
  // --- AI prompt: server first, then minimal fallback ---
// Server-first AI; minimal fallback (simple blueprint) if the server fails.
async function aiToSVG(prompt){
  if (STATE.aiAttemptsLeft <= 0) throw new Error('No attempts left');

  // 1) Try the real AI endpoint on your Node server
  try{
    const j = await serverJSON(api('/api/crafting/ai_svg'), {
      method:'POST',
      body: JSON.stringify({
        prompt,
        meta: { part: STATE.currentPart, category: STATE.currentCategory, name: STATE.currentName }
      })
    });

    if (j && j.ok && j.svg){
      const cleaned = sanitizeSVG(j.svg);
      if (!cleaned) throw new Error('SVG rejected');
      STATE.aiAttemptsLeft -= 1;
      return cleaned;
    } else if (j && !j.ok) {
      // Show server reason (helps debug on iPhone)
      alert('AI server error: ' + (j.reason || 'unknown'));
    }
  }catch(e){
    // Network / 5xx, etc.
    alert('AI server error: ' + (e?.message || e || 'unknown'));
  }

  // 2) Minimal fallback (basic blueprint so it’s obvious it’s not the AI)
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
    const id = b.dataset.equip;
    const it = items.find(x=>x.id===id);
    if (!it) return;

    // Persist for overlay bootstrap
    try {
      localStorage.setItem('izzaLastEquipped', JSON.stringify({
        id: it.id, name: it.name, category: it.category, part: it.part, svg: it.svg
      }));
    } catch {}

    // Legacy event (id only)
    try { window.IZZA && IZZA.emit && IZZA.emit('equip-crafted', id); } catch{}

    // New event (full payload)
    try {
      window.IZZA && IZZA.emit && IZZA.emit('equip-crafted-v2', {
        id: it.id, name: it.name, category: it.category, part: it.part, svg: it.svg
      });
    } catch{}
  });
});

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
  if (!btnAI) return;
  const prompt = String(aiPrompt?.value||'').trim();
  if (!prompt) return;

  // lock UI + overlay
  btnAI.disabled = true;
  btnAI.setAttribute('aria-busy','true');
  btnAI.textContent = 'Generating…';
  const waitEl = showWait('Crafting your SVG preview (this can take ~5–10s)…');

  try{
    // Ensure at least 10s passes before we unlock/hide overlay
    const [svg] = await Promise.all([
      aiToSVG(prompt),
      sleep(MIN_AI_WAIT_MS)
    ]);

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
    (function aiLeftUpdate(){
      const a = document.getElementById('aiLeft');  if (a) a.textContent = STATE.aiAttemptsLeft;
      const b = document.getElementById('aiLeft2'); if (b) b.textContent = STATE.aiAttemptsLeft;
    })();
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
              featureFlags: STATE.featureFlags
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
