// /static/game/js/plugins/crafting/crafting_ui.js
(function(){
  const COSTS = Object.freeze({
    PER_ITEM_IC:   5000,
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
    currentCategory: 'armour',   // armour | weapon | apparel | merch
    currentPart: 'helmet',       // helmet | vest | arms | legs || (weapon subtypes)
    fireRateRequested: 0,
    dmgHearts: 0.5,
    packageCredits: null, // if the user purchased a package this session
  };

  // ---------- UTIL: moderation ----------
  const BAD_WORDS = ['badword1','badword2','slur1','slur2']; // replace with your list
  function moderateName(name){
    const s = String(name||'').trim();
    if (s.length < 3 || s.length > 28) return { ok:false, reason:'Name must be 3–28 chars' };
    const low = s.toLowerCase();
    if (BAD_WORDS.some(w => low.includes(w))) return { ok:false, reason:'Inappropriate name' };
    return { ok:true };
  }

  // Strip dangerous SVG bits; keep it tight
  function sanitizeSVG(svg){
    try{
      const txt = String(svg||'');
      // quick rejects
      if (txt.length > 200_000) throw new Error('SVG too large');
      if (/script|onload|onerror|foreignObject|iframe/i.test(txt)) throw new Error('Disallowed elements/attrs');

      // remove external hrefs, javascript:, data: images (allow only inline shapes/paths)
      const cleaned = txt
        .replace(/xlink:href\s*=\s*["'][^"']*["']/gi,'')
        .replace(/\son\w+\s*=\s*["'][^"']*["']/gi,'')
        .replace(/href\s*=\s*["']\s*(?!#)[^"']*["']/gi,'')
        .replace(/(javascript:|data:)/gi,'')
        .replace(/<metadata[\s\S]*?<\/metadata>/gi,'')
        .replace(/<!DOCTYPE[^>]*>/gi,'')
        .replace(/<\?xml[\s\S]*?\?>/gi,'');
      return cleaned;
    }catch(e){
      return '';
    }
  }

  // ---------- UTIL: coins + server ----------
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

  // ---------- Pi payment (skeleton) ----------
  async function payWithPi(amountPi, memo){
    // NOTE: you likely already call Pi.init elsewhere; keep this minimal
    if (!window.Pi || typeof window.Pi.createPayment!=='function'){
      alert('Pi SDK not available'); return { ok:false, reason:'no-pi' };
    }
    try{
      const paymentData = {
        amount: String(amountPi),
        memo: memo || 'IZZA Crafting',
        metadata: { kind:'crafting', memo }
      };
      const res = await window.Pi.createPayment(paymentData, {
        onReadyForServerApproval: async (paymentId) => {
          await serverJSON('/api/crafting/pi/approve', { method:'POST', body:JSON.stringify({ paymentId }) });
        },
        onReadyForServerCompletion: async (paymentId, txid) => {
          await serverJSON('/api/crafting/pi/complete', { method:'POST', body:JSON.stringify({ paymentId, txid }) });
        }
      });
      // res.status === 'COMPLETED' usually; treat as success if so
      if (res && res.status && /complete/i.test(res.status)) return { ok:true, receipt:res };
      return { ok:false, reason:'pi-not-complete', raw:res };
    }catch(e){
      console.warn('[craft] Pi pay failed', e);
      return { ok:false, reason:String(e) };
    }
  }

  // ---------- IZZA Coin payment ----------
  async function payWithIC(amountIC){
    const cur = getIC();
    if (cur < amountIC) return { ok:false, reason:'not-enough-ic' };
    setIC(cur - amountIC);
    // optional: hit server to record spend
    try{ await serverJSON('/api/crafting/ic/debit', { method:'POST', body:JSON.stringify({ amount:amountIC }) }); }catch{}
    return { ok:true };
  }

  // ---------- Feature pricing ----------
  function selectedAddOnCount(){
    return Object.values(STATE.featureFlags).filter(Boolean).length;
  }
  function calcTotalCost({ usePi }){
    const base = usePi ? COSTS.PER_ITEM_PI : COSTS.PER_ITEM_IC;
    const addon = usePi ? COSTS.ADDON_PI   : COSTS.ADDON_IC;
    return base + addon * selectedAddOnCount();
  }

  // ---------- AI attempt (stub) ----------
  async function aiToSVG(prompt){
    if (STATE.aiAttemptsLeft <= 0) throw new Error('No attempts left');
    // call your real endpoint here
    const j = await serverJSON('/api/crafting/ai_svg', { method:'POST', body:JSON.stringify({ prompt }) });
    if (!j || !j.ok || !j.svg) throw new Error('AI failed');
    // only decrement if we can render (cheap check)
    const cleaned = sanitizeSVG(j.svg);
    if (!cleaned) throw new Error('SVG rejected by sanitizer');
    STATE.aiAttemptsLeft -= 1;
    return cleaned;
  }

  // ---------- Mount UI ----------
  function el(html){ const d=document.createElement('div'); d.innerHTML=html.trim(); return d.firstChild; }

  function renderTabs(){
    return `
      <div style="display:flex; gap:8px; padding:10px; border-bottom:1px solid #2a3550; background:#0f1624">
        <button class="ghost" data-tab="packages">Packages</button>
        <button class="ghost" data-tab="create">Create Item</button>
        <button class="ghost" data-tab="mine">My Creations</button>
        <div style="margin-left:auto; opacity:.7; font-size:12px">AI attempts left: <b id="aiLeft">${STATE.aiAttemptsLeft}</b></div>
      </div>
    `;
  }

  function renderPackages(){
    return `
      <div style="padding:14px; display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:10px">
        <div style="background:#0f1522;border:1px solid #2a3550;border-radius:10px;padding:12px">
          <div style="font-weight:700;margin-bottom:6px">Starter Forge</div>
          <div style="opacity:.85;font-size:13px;line-height:1.4">
            2× Weapons (½-heart dmg), 1× Armour set (+0.25% speed, 25% DR).<br/>
            Includes features & listing rights.
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
      </div>
    `;
  }

  function renderCreate(){
  const totalPi = calcTotalCost({ usePi:true });
  const totalIC = calcTotalCost({ usePi:false });
  return `
    <div class="cl-body">
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
        <div style="margin-top:8px; display:flex; gap:8px">
          <button class="ghost" id="btnPreview">Preview</button>
          <button class="ghost" id="btnCraft" title="Consumes your paid slot if not already paid">Craft</button>
          <span id="craftStatus" style="font-size:12px; opacity:.8"></span>
        </div>
        <div id="svgPreview" style="margin-top:10px; background:#0f1522; border:1px solid #2a3550; border-radius:10px; min-height:160px; display:flex; align-items:center; justify-content:center">
          <div style="opacity:.6; font-size:12px">Preview appears here</div>
        </div>
      </div>
    </div>
  `;
}

  function renderMine(){
    return `
      <div style="padding:14px">
        <div style="font-weight:700;margin-bottom:6px">My Creations</div>
        <div id="mineList" style="display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:10px"></div>
      </div>
    `;
  }

  // ---------- wire up ----------
  function mount(rootSel){
    const root = (typeof rootSel==='string') ? document.querySelector(rootSel) : rootSel;
    if (!root) return;
    STATE.root = root;
    STATE.mounted = true;

    root.innerHTML = `
      ${renderTabs()}
      <div id="craftTabs"></div>
    `;

    const tabsHost = root.querySelector('#craftTabs');
    const setTab = (name)=>{
      if(!STATE.mounted) return;
      if(name==='packages') tabsHost.innerHTML = renderPackages();
      if(name==='create')   tabsHost.innerHTML = renderCreate();
      if(name==='mine')     tabsHost.innerHTML = renderMine();
      bindInside();
    };

    root.querySelectorAll('[data-tab]').forEach(b=>{
      b.addEventListener('click', ()=> setTab(b.dataset.tab));
    });

    setTab('packages'); // default
  }

  function unmount(){
    if(!STATE.root) return;
    STATE.root.innerHTML = '';
    STATE.mounted = false;
  }

  async function handleBuySingle(kind){ // 'pi' or 'ic'
    const usePi = (kind==='pi');
    const total = calcTotalCost({ usePi });

    let res;
    if (usePi) res = await payWithPi(total, 'Craft Single Item');
    else       res = await payWithIC(total);

    const status = document.getElementById('payStatus');
    if (res && res.ok){
      STATE.hasPaidForCurrentItem = true;
      status && (status.textContent = 'Paid ✓ — you can craft now.');
    }else{
      status && (status.textContent = 'Payment failed.');
    }
  }

  function bindInside(){
    const root = STATE.root;
    if(!root) return;

    // Packages tab
    root.querySelectorAll('[data-buy-package]').forEach(btn=>{
      btn.addEventListener('click', async ()=>{
        const id = btn.dataset.buyPackage;
        // Pi-only purchase for packages
        const res = await payWithPi(50, `Package:${id}`);
        if(res.ok){
          // Normally fetch package credits from server
          STATE.packageCredits = { id, items:3, featuresIncluded:true };
          alert('Package unlocked — start creating!');
        }
      });
    });
    root.querySelectorAll('[data-buy-single]').forEach(btn=>{
      btn.addEventListener('click', ()=> handleBuySingle(btn.dataset.buySingle));
    });

    // Create tab
    const payPi   = root.querySelector('#payPi');
    const payIC   = root.querySelector('#payIC');
    payPi && payPi.addEventListener('click', ()=> handleBuySingle('pi'));
    payIC && payIC.addEventListener('click', ()=> handleBuySingle('ic'));

    const itemName = root.querySelector('#itemName');
    itemName && itemName.addEventListener('input', e=>{ STATE.currentName = e.target.value; });

    root.querySelectorAll('[data-ff]').forEach(cb=>{
      cb.addEventListener('change', e=>{
        STATE.featureFlags[cb.dataset.ff] = cb.checked;
        // re-render cost line quickly
        const host = root.querySelector('#craftTabs');
        if (host) {
          const saveScroll = host.scrollTop;
          host.innerHTML = renderCreate();
          bindInside();
          host.scrollTop = saveScroll;
        }
      });
    });

    const catSel  = root.querySelector('#catSel');
    const partSel = root.querySelector('#partSel');
    catSel && catSel.addEventListener('change', e=> STATE.currentCategory = e.target.value);
    partSel && partSel.addEventListener('change', e=> STATE.currentPart     = e.target.value);

    const aiLeft = ()=> {
      const a = document.getElementById('aiLeft'); if (a) a.textContent = STATE.aiAttemptsLeft;
      const b = document.getElementById('aiLeft2'); if (b) b.textContent = STATE.aiAttemptsLeft;
    };

    const btnAI   = root.querySelector('#btnAI');
    const aiPrompt= root.querySelector('#aiPrompt');
    const svgIn   = root.querySelector('#svgIn');
    const btnPrev = root.querySelector('#btnPreview');
    const btnCraft= root.querySelector('#btnCraft');
    const prevHost= root.querySelector('#svgPreview');
    const craftStatus = root.querySelector('#craftStatus');

    btnAI && btnAI.addEventListener('click', async ()=>{
      try{
        const prompt = String(aiPrompt.value||'').trim();
        if (!prompt) return;
        const svg = await aiToSVG(prompt);
        svgIn.value = svg;
        // show preview
        prevHost.innerHTML = svg;
        STATE.currentSVG = svg;
        aiLeft();
      }catch(e){
        alert('AI failed: '+e.message);
      }
    });

    btnPrev && btnPrev.addEventListener('click', ()=>{
      const cleaned = sanitizeSVG(svgIn.value);
      if (!cleaned){ alert('SVG failed moderation/sanitize'); return; }
      prevHost.innerHTML = cleaned;
      STATE.currentSVG = cleaned;
    });

    btnCraft && btnCraft.addEventListener('click', async ()=>{
      craftStatus.textContent = '';
      // name moderation
      const nm = moderateName(STATE.currentName);
      if (!nm.ok){ craftStatus.textContent = nm.reason; return; }

      // ensure paid (or package credit)
      if (!STATE.hasPaidForCurrentItem && !STATE.packageCredits){
        craftStatus.textContent = 'Please pay (Pi or IC) first, or buy a package.';
        return;
      }
      if (!STATE.currentSVG){ craftStatus.textContent = 'Add/Preview SVG first.'; return; }

      // shop price
      const sellInShop = !!root.querySelector('#sellInShop')?.checked;
      const sellInPi   = !!root.querySelector('#sellInPi')?.checked;
      const priceIC    = Math.max(COSTS.SHOP_MIN_IC, Math.min(COSTS.SHOP_MAX_IC, parseInt(root.querySelector('#shopPrice')?.value||'100',10)||100));

      // Send to server for final moderation & minting
      try{
        const payload = {
          name: STATE.currentName,
          category: STATE.currentCategory,
          part: STATE.currentPart,
          svg: STATE.currentSVG,
          features: STATE.featureFlags,
          sellInShop, sellInPi, priceIC
        };
        const res = await serverJSON('/api/crafting/mint', { method:'POST', body:JSON.stringify(payload) });
        if (res && res.ok){
          craftStatus.textContent = 'Crafted ✓';
          STATE.hasPaidForCurrentItem = false; // consume payment/credit
          // refresh "My Creations"
        }else{
          craftStatus.textContent = 'Server rejected the item';
        }
      }catch(e){
        craftStatus.textContent = 'Error crafting: '+e.message;
      }
    });
  }

  window.CraftingUI = { mount, unmount };
})();
