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

  // === Prompt→Concept Icon Engine (general-purpose, composite, rotating) ===
  (function(){
    // --- utils --------------------------------------------------------------
    function hash32(str){ let h=2166136261>>>0; for(let i=0;i<str.length;i++){h^=str.charCodeAt(i); h=Math.imul(h,16777619);} return h>>>0; }
    function rng(seed){ let x=seed||123456789; return ()=>((x^=x<<13,x^=x>>>17,x^=x<<5)>>>0)/4294967296; }
    const pick=(r,a)=>a[(r()*a.length)|0], clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
    const lc=s=>String(s||'').toLowerCase();

    // --- palettes + bias ----------------------------------------------------
    const PALETTES = [
      ["#0f1624","#7b3cff","#4321a1","#ff66ff"],["#0f172a","#00c2a8","#0a7a6c","#8affec"],
      ["#1f2937","#ff6a3a","#9c3e1e","#ffd0a6"],["#101014","#d6a740","#8c6a1f","#ffe17a"],
      ["#120e1a","#ff6b9a","#953457","#ffd0e1"],["#0a121a","#50b0ff","#215e96","#a8ddff"],
      ["#11160f","#6bd67b","#2c6b37","#ccffd8"],["#0d141b","#7cf2ff","#256c73","#e3ffff"]
    ];
    function biasPalette(prompt, r){
      const p=lc(prompt);
      if(/gold|royal/.test(p))  return ["#0e0a0a","#d6a740","#8c6a1f","#ffe17a"];
      if(/red|scarlet/.test(p)) return ["#0a0a12","#ff5f5f","#8a2e2e","#ffb3b3"];
      if(/purple|violet/.test(p)) return ["#0f1624","#7b3cff","#4321a1","#ff66ff"];
      if(/emerald|green/.test(p)) return ["#11160f","#6bd67b","#2c6b37","#ccffd8"];
      if(/aqua|cyan|teal/.test(p)) return ["#0f172a","#00c2a8","#0a7a6c","#8affec"];
      return pick(r, PALETTES);
    }

    // --- prompt → tags ------------------------------------------------------
    const LEX = {
      weapon: /(gun|pistol|rifle|blaster|uzi|melee|sword|blade|dagger|katana|spear)\b/,
      ride: /\b(ride|riding|mounted|on top of)\b/,
      face: /\b(face|mask|skull|head|clown|smile|angry|happy)\b/,
      animal: /\b(dinosaur|dragon|t-rex|trex|raptor|cat|dog|wolf|lion|tiger|bird)\b/,
      decor: /\b(wing|crown|flame|flames|star|halo|rune|sigil|crest|skull|heart|lightning)\b/,
      style: /\b(retro|pixel|neon|cyber|steampunk|tribal|graffiti|glow|shiny)\b/
    };
    function parsePrompt(prompt){
      const p=lc(prompt);
      const tags=new Set();
      const m=(re,tag)=>{ if(re.test(p)) tags.add(tag); };
      // high-level
      if(LEX.weapon.test(p)) tags.add("weapon");
      if(LEX.ride.test(p)) tags.add("ride");
      if(LEX.face.test(p)) tags.add("face");
      if(LEX.animal.test(p)) tags.add("animal");
      if(LEX.decor.test(p)) tags.add("decor");
      if(LEX.style.test(p)) tags.add("style");
      // specific nouns we want to keep literally for fallback glyphs
      (p.match(/[a-z0-9]+/g)||[]).forEach(t=>{
        if(["a","the","and","of","on","with"].includes(t)) return;
        if(t.length>2) tags.add("kw:"+t);
      });
      // detail nouns
      if(/\bclown\b/.test(p)) tags.add("clown");
      if(/\bdino(saur)?|t-?rex|raptor\b/.test(p)) tags.add("dino");
      if(/\bgun|pistol|rifle|blaster|uzi\b/.test(p)) tags.add("gun");
      if(/\bmelee|sword|blade|dagger|katana|spear\b/.test(p)) tags.add("melee");
      return Array.from(tags);
    }

    // --- defs (glow + optional gold gradient + vignette) --------------------
    function defsFx(seed, glow, wantGold){
      const gid=`g${seed}`, fid=`f${seed}`, bid=`b${seed}`;
      const gold = wantGold ? `
        <linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#fff4c4"/><stop offset="40%" stop-color="#ffd36e"/>
          <stop offset="70%" stop-color="#d6a740"/><stop offset="100%" stop-color="#8c6a1f"/>
        </linearGradient>` : '';
      return `
        <filter id="${fid}" x="-25%" y="-25%" width="150%" height="150%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="1.8" result="b"/>
          <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
        <radialGradient id="${bid}" cx="50%" cy="45%" r="62%">
          <stop offset="0%" stop-color="${glow}" stop-opacity="0.30"/>
          <stop offset="100%" stop-color="${glow}" stop-opacity="0"/>
        </radialGradient>
        ${gold}
      `;
    }

    // --- primitives ---------------------------------------------------------
    const rect=(x,y,w,h,rx,f,op=1,tr="")=>`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx||0}" fill="${f}" opacity="${op}" ${tr?`transform="${tr}"`:''}/>`;
    const circ=(cx,cy,r,f,op=1,tr="")=>`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${f}" opacity="${op}" ${tr?`transform="${tr}"`:''}/>`;
    const path=(d,f,sw=0,sc="none",op=1,tr="")=>`<path d="${d}" fill="${f}" stroke="${sc}" stroke-width="${sw}" opacity="${op}" ${tr?`transform="${tr}"`:''}/>`;
    const ell =(cx,cy,rx,ry,f,op=1,tr="")=>`<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${f}" opacity="${op}" ${tr?`transform="${tr}"`:''}/>`;
    const line=(x1,y1,x2,y2,sw,sc,op=1)=>`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${sc}" stroke-width="${sw}" opacity="${op}"/>`;

    // --- frames -------------------------------------------------------------
    function frameGun(base,shade,trim){
      return `
        ${rect(18,52,78,18,4,base)}
        ${rect(74,70,12,22,2,shade)}
        ${rect(96,56,12,6,base)}
        ${rect(44,40,24,8,2,trim,0.7)}
      `;
    }
    function frameMelee(base,shade){
      return `${rect(60,22,8,58,3,base)}${rect(48,78,32,10,5,shade)}`;
    }
    function crestShell(part,base,shade){
      if(part==="helmet") return `${path("M24,60 C24,38 42,22 64,18 C86,22 104,38 104,60 v20 c0,8 -6,14 -14,14 H38 c-8,0 -14,-6 -14,-14 z", base)}${rect(30,78,68,10,6,shade)}`;
      if(part==="vest")   return `${rect(26,40,76,58,10,base)}${rect(34,60,60,12,6,shade)}`;
      if(part==="arms")   return `${rect(18,54,22,34,8,base)}${rect(88,54,22,34,8,base)}${rect(24,66,10,10,3,shade)}${rect(94,66,10,10,3,shade)}`;
      if(part==="legs")   return `${rect(36,56,20,44,6,base)}${rect(72,56,20,44,6,base)}${rect(36,76,56,8,4,shade)}`;
      return `${rect(26,40,76,58,10,base)}${rect(34,60,60,12,6,shade)}`;
    }

    // --- motifs (faces, animals, props) ------------------------------------
    function clownFace(r, base, glow){
      const hat = path("M40,40 L88,40 L64,20 Z", glow, 0, "none", 1, "");
      const face= ell(64,64,20,18,"#ffe6cc");
      const eyes= `${circ(56,60,3,"#222")}${circ(72,60,3,"#222")}`;
      const nose= circ(64,66,4,"#ff4a4a");
      const smile= path("M52,72 Q64,82 76,72","none",3,"#222",1);
      return `<g>${hat}${face}${eyes}${nose}${smile}</g>`;
    }
    function dinoBody(r, base, shade, glow){
      const body = path("M36,86 C36,64 60,52 78,56 C98,60 110,70 110,86 Z", base);
      const belly= path("M42,86 C44,74 60,64 78,68 C92,71 102,78 104,86 Z", shade,0,"none",0.9);
      const eye  = circ(92,72,2,"#111");
      const back = line(46,68,86,60,3,glow,0.4);
      return `<g>${body}${belly}${eye}${back}</g>`;
    }
    function crown(glow){ return path("M36,46 L48,36 L60,46 L72,36 L84,46 L84,50 L36,50 Z", "url(#bkg)", 2, glow, 0.9); }
    function wings(glow){ return `<g opacity="0.7">${path("M26,70 C26,56 40,52 50,60 C44,66 40,72 36,78 Z","none",2,glow)}${path("M102,70 C102,56 88,52 78,60 C84,66 88,72 92,78 Z","none",2,glow)}</g>`; }
    function flames(glow){ return `<g opacity="0.75">${path("M64,96 C58,90 60,80 64,74 C68,80 70,90 64,96 Z", glow)}${path("M72,96 C66,90 68,80 72,74 C76,80 78,90 72,96 Z", glow,0,"none",0.8)}</g>`; }

    // Fallback glyph stack when noun is unknown
    function abstractGlyphs(r, glow, trim){
      const n=4+(r()*4|0); let g='';
      for(let i=0;i<n;i++){
        const x=24+(r()*80|0), y=24+(r()*80|0), s=6+(r()*16|0), rot=(r()*360|0);
        g += rect(x,y,s,s,2,glow,0.25+0.35*r(),`rotate(${rot} ${x+s/2} ${y+s/2})`);
      }
      g += circ(64,64,22,glow,0.15);
      g += rect(30,30,68,68,12,trim,0.12);
      return `<g filter="url(#fX)">${g}</g>`;
    }

    // --- layout: ride composition ------------------------------------------
    function composeRide(r, rider, mount, extras){
      // slight vertical stack with jitter & rotation
      return `
        <g transform="translate(0,-6) rotate(${(r()*6-3)|0} 64 64)">
          ${mount}
          <g transform="translate(0,-18)">${rider}</g>
          ${extras||''}
        </g>`;
    }

    // --- main ---------------------------------------------------------------
    function genSVG({ name="", prompt="", part="helmet", seedExtra=0 } = {}){
      const seed = hash32(`${name}::${prompt}::${part}::${seedExtra}`);
      const r = rng(seed);
      const [trim, base, shade, glow] = biasPalette(prompt, r);
      const tags = parsePrompt(prompt);
      const wantGold = /gold|golden/.test(lc(prompt));
      const defs = defsFx(seed, glow, wantGold);

      // background + subtle vignette
      const bg = `
        <rect x="4" y="4" width="120" height="120" rx="14" fill="${trim}"/>
        <rect x="4" y="4" width="120" height="120" rx="14" fill="url(#b${seed})"/>
      `;

      // frame or crest shell
      const isGun   = tags.includes("gun")   || (tags.includes("weapon") && /gun|pistol|rifle|blaster|uzi/.test(lc(prompt)));
      const isMelee = tags.includes("melee") || (tags.includes("weapon") && /sword|blade|dagger|katana|spear/.test(lc(prompt)));
      const frame = isGun ? frameGun(base,shade,trim) : isMelee ? frameMelee(base,shade) : crestShell(part, base, shade);

      // rider/mount logic
      const wantRide = tags.includes("ride") || /\b(on|riding|mounted)\b/.test(lc(prompt));
      const rider = tags.includes("clown") ? clownFace(r, base, glow) :
                    tags.includes("face")  ? clownFace(r, base, glow) : null;
      const mount = tags.includes("dino")  ? dinoBody(r, base, shade, glow) : null;

      // extras by decor tags
      let deco = '';
      if(/\bcrown\b/.test(lc(prompt)))  deco += crown(glow);
      if(/\bwing/.test(lc(prompt)))     deco += wings(glow);
      if(/\bflame|flames\b/.test(lc(prompt))) deco += flames(glow);

      // fallback if neither rider nor mount described
      let mascot='';
      if (rider && mount && wantRide) mascot = composeRide(r, rider, mount, deco);
      else if (rider && !mount)       mascot = `<g transform="translate(0,-4)">${rider}${deco}</g>`;
      else if (!rider && mount)       mascot = `<g>${mount}${deco}</g>`;
      else                            mascot = abstractGlyphs(r, glow, trim);

      // mask vignette id
      const vignId = `b${seed}`;
      const out = `
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
    <defs>
      ${defs}
      <radialGradient id="${vignId}" cx="50%" cy="45%" r="62%">
        <stop offset="0%" stop-color="${glow}" stop-opacity="0.15"/>
        <stop offset="100%" stop-color="${glow}" stop-opacity="0"/>
      </radialGradient>
    </defs>
    ${bg}
    <g filter="url(#f${seed})">
      ${frame}
      ${mascot}
    </g>
    <path d="M28 40 Q64 ${36+((r()*10)|0)} 100 40" stroke="#fff" stroke-opacity="${0.06 + r()*0.08}" stroke-width="${2 + (r()*2|0)}" fill="none"/>
  </svg>`;
      return out;
    }

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
