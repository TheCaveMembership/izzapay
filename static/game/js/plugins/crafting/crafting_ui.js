// --- AI prompt guidance (slot-aware + style/animation aware, no bg) ---
var SLOT_GUIDE = {
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
  var p = String(part||'').toLowerCase();
  if (p==='gun' || p==='melee') return 'hands';
  if (p==='helmet' || p==='vest' || p==='arms' || p==='legs' || p==='hands') return p;
  return 'helmet';
}

// Slot-specific viewBoxes (what the server expects)
var SLOT_VB = {
  helmet: '0 0 128 128',
  vest:   '0 0 128 128',
  arms:   '0 0 160 120',
  legs:   '0 0 140 140',
  hands:  '0 0 160 100'
};

/* ---------- NEW (minimal + additive): category-aware part options ---------- */
var PART_OPTIONS = {
  armour: [
    { v:'helmet', t:'Helmet' },
    { v:'vest',   t:'Vest'   },
    { v:'arms',   t:'Arms'   },
    { v:'legs',   t:'Legs'   }
  ],
  weapon: [
    { v:'gun',    t:'Gun'    },
    { v:'melee',  t:'Melee'  }
  ],
  apparel: [
    { v:'helmet', t:'Helmet' },
    { v:'vest',   t:'Vest'   },
    { v:'arms',   t:'Arms'   },
    { v:'legs',   t:'Legs'   }
  ],
  merch: [
    { v:'helmet', t:'Helmet' },
    { v:'vest',   t:'Vest'   },
    { v:'arms',   t:'Arms'   },
    { v:'legs',   t:'Legs'   }
  ]
};

function repopulatePartOptions(catSelEl, partSelEl){
  var cat  = (catSelEl && catSelEl.value) || 'armour';
  var opts = PART_OPTIONS[cat] || PART_OPTIONS.armour;
  var prev = (partSelEl && partSelEl.value) || '';
  partSelEl.innerHTML = opts.map(function(o){ return '<option value="'+o.v+'">'+o.t+'</option>'; }).join('');
  partSelEl.value = opts.some(function(o){ return o.v===prev; }) ? prev : opts[0].v;
}

/* ------------------------------------------------------------------------- */

// Compose the UX prompt shown to the model (keeps constraints tight)
function composeAIPrompt(userPrompt, part, opts){
  opts = opts || {};
  var style = opts.style || 'realistic';
  var animate = !!opts.animate;

  var guide = SLOT_GUIDE[part] || '';
  var slot  = mapPartForServer(part);
  var vb    = SLOT_VB[slot] || '0 0 128 128';

  var sLow = String(style).toLowerCase();
  var styleLine = (sLow==='cartoon' || sLow==='stylized')
    ? "STYLE: Stylized/cartoon allowed, but still layered: gradients + soft shadows. Avoid flat emoji."
    : "STYLE: Realistic materials (chrome, glass, brushed steel, leather). Subtle AO and specular highlights.";

  var animLine = animate
    ? "ANIMATION: Allowed. Use lightweight loop via <animate>/<animateTransform> or CSS @keyframes. 1–2 effects max (glow pulse, flame lick). No JS."
    : "ANIMATION: Not required. Ensure static silhouette reads clearly.";

  var constraints = [
    "Item part: "+slot,
    'Use viewBox="'+vb+'". Fit art tightly with 0–2px padding; center visually.',
    "Transparent background. Do NOT draw any full-bleed background rects.",
    "Vector only: <path>, <rect>, <circle>, <polygon>, <g>, <defs>, gradients, filters (feGaussianBlur, feDropShadow). No <image>, no <foreignObject>.",
    "Must read at ~28px inventory size. Clean silhouette + controlled detail.",
    (slot==='arms'||slot==='legs') ? "Structure: two distinct side elements (no single central blob)." : null,
    (slot==='hands') ? "Structure: horizontal weapon composition." : null,
    styleLine,
    animLine
  ].filter(function(x){ return !!x; }).join(' ');

  return [ userPrompt, guide, constraints ].filter(function(x){ return !!x; }).join(' ');
}

// /static/game/js/plugins/crafting/crafting_ui.js

; (function(){
  var COSTS = Object.freeze({
    PER_ITEM_IC:   0,
    PER_ITEM_PI:   0.005,
    PACKAGE_PI:    5,
    PACKAGE_IC:    10000,
    ADDON_IC:      1000,
    ADDON_PI:      1,
    SHOP_MIN_IC:   50,
    SHOP_MAX_IC:   250,
    AI_ATTEMPTS:   5
  });

  var STATE = {
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
    aiStyle: 'realistic',
    wantAnimation: false,
    currentCategory: 'armour',
    currentPart: 'helmet',
    fireRateRequested: 0,
    dmgHearts: 0.5,
    packageCredits: null,
    createSub: 'setup',
    canUseVisuals: false
  };

  var BAD_WORDS = ['badword1','badword2','slur1','slur2'];
  function moderateName(name){
    var s = String(name||'').trim();
    if (s.length < 3 || s.length > 28) return { ok:false, reason:'Name must be 3–28 chars' };
    var low = s.toLowerCase();
    for (var i=0;i<BAD_WORDS.length;i++){
      if (low.indexOf(BAD_WORDS[i])!==-1) return { ok:false, reason:'Inappropriate name' };
    }
    return { ok:true };
  }

  function sanitizeSVG(svg){
    try{
      var txt = String(svg||'');
      if (txt.length > 200000) throw new Error('SVG too large');
      if (/script|onload|onerror|foreignObject|iframe/i.test(txt)) throw new Error('Disallowed elements/attrs');

      var cleaned = txt
        .replace(/xlink:href\s*=\s*["'][^"']*["']/gi,'')
        .replace(/\son\w+\s*=\s*["'][^"']*["']/gi,'')
        .replace(/href\s*=\s*["']\s*(?!#)[^"']*["']/gi,'')
        .replace(/(javascript:|data:)/gi,'')
        .replace(/<metadata[\s\S]*?<\/metadata>/gi,'')
        .replace(/<!DOCTYPE[^>]*>/gi,'')
        .replace(/<\?xml[\s\S]*?\?>/gi,'');

      cleaned = cleaned.replace(
        /(<svg\b[^>]*\sstyle\s*=\s*["'][^"']*)\bbackground(?:-color)?\s*:[^;"']+;?/i,
        function(_, pre){ return pre; }
      );

      cleaned = cleaned.replace(
        /<rect\b[^>]*width\s*=\s*["']\s*100%\s*["'][^>]*height\s*=\s*["']\s*100%\s*["'][^>]*\/?>/gi,
        ''
      );

      var vb = /viewBox\s*=\s*["'][^"']*?(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)/i.exec(cleaned);
      if (vb){
        var w = String(parseFloat(vb[3]));
        var h = String(parseFloat(vb[4]));
        var fullRectRe = new RegExp(
          '<rect\\b[^>]*x\\s*=\\s*[\'"]?0(?:\\.0+)?[\'"]?[^>]*y\\s*=\\s*[\'"]?0(?:\\.0+)?[\'"]?[^>]*width\\s*=\\s*[\'"]?(?:'+w+'|'+Math.round(+w)+')[\'"]?[^>]*height\\s*=\\s*[\'"]?(?:'+h+'|'+Math.round(+h)+')[\'"]?[^>]*\\/?>',
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
  var MIN_AI_WAIT_MS = 10000;
  var sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };

  function showWait(text){
    var el = document.createElement('div');
    el.id = 'izza-ai-wait';
    el.style.cssText = 'position:fixed; inset:0; z-index:99999; display:flex; align-items:center; justify-content:center; background:rgba(0,0,0,.45); backdrop-filter:saturate(120%) blur(2px);';
    el.innerHTML = ''+
      '<div style="background:#0f1522; color:#e7ecff; border:1px solid #2a3550; border-radius:12px; padding:14px 16px; font-size:14px; min-width:220px; text-align:center; box-shadow:0 8px 28px rgba(0,0,0,.35);">'+
        '<div style="font-weight:700; margin-bottom:6px">Generating…</div>'+
        '<div style="opacity:.85">'+(text||'Please wait while we create your preview.')+'</div>'+
      '</div>';
    document.body.appendChild(el);
    return el;
  }
  function hideWait(node){
    try{ if (node && node.parentNode) node.parentNode.removeChild(node); }catch(e){}
  }

  function getIC(){
    try{ return parseInt(localStorage.getItem('izzaCoins')||'0',10)||0; }catch(e){ return 0; }
  }
  function setIC(v){
    try{
      localStorage.setItem('izzaCoins', String(Math.max(0, v|0)));
      window.dispatchEvent(new Event('izza-coins-changed'));
    }catch(e){}
  }

  // Force default API base to the Node service on Render.
  var API_BASE = ((window.IZZA_PERSIST_BASE && String(window.IZZA_PERSIST_BASE)) || 'https://izzagame.onrender.com').replace(/\/+$/,'');
  var api = function(p){ return API_BASE ? API_BASE + p : p; };

  function serverJSON(url, opts){
    opts = opts || {};
    var headers = (opts.headers || {});
    headers['content-type'] = 'application/json';
    var o2 = {};
    for (var k in opts) o2[k]=opts[k];
    o2.headers = headers;
    return fetch(url, o2).then(function(r){
      if(!r.ok) throw new Error('HTTP '+r.status);
      return r.json().catch(function(){ return {}; });
    });
  }

  function payWithPi(amountPi, memo){
    if (!window.Pi || typeof window.Pi.createPayment!=='function'){
      alert('Pi SDK not available'); return Promise.resolve({ ok:false, reason:'no-pi' });
    }
    try{
      var paymentData = { amount: String(amountPi), memo: memo || 'IZZA Crafting', metadata: { kind:'crafting', memo: memo||'IZZA Crafting' } };
      return window.Pi.createPayment(paymentData, {
        onReadyForServerApproval: function(paymentId){
          return serverJSON(api('/api/crafting/pi/approve'), { method:'POST', body:JSON.stringify({ paymentId: paymentId }) });
        },
        onReadyForServerCompletion: function(paymentId, txid){
          return serverJSON(api('/api/crafting/pi/complete'), { method:'POST', body:JSON.stringify({ paymentId: paymentId, txid: txid }) });
        }
      }).then(function(res){
        if (res && res.status && /complete/i.test(res.status)) return { ok:true, receipt:res };
        return { ok:false, reason:'pi-not-complete', raw:res };
      }).catch(function(e){
        console.warn('[craft] Pi pay failed', e);
        return { ok:false, reason:String(e) };
      });
    }catch(e){
      console.warn('[craft] Pi pay failed', e);
      return Promise.resolve({ ok:false, reason:String(e) });
    }
  }

  function payWithIC(amountIC){
    var cur = getIC();
    if (cur < amountIC) return Promise.resolve({ ok:false, reason:'not-enough-ic' });
    setIC(cur - amountIC);
    return serverJSON(api('/api/crafting/ic/debit'), { method:'POST', body:JSON.stringify({ amount:amountIC }) })
      .catch(function(){}).then(function(){ return { ok:true }; });
  }

  function selectedAddOnCount(){
    var n=0; for (var k in STATE.featureFlags){ if (STATE.featureFlags[k]) n++; } return n;
  }
  function calcTotalCost(cfg){
    cfg = cfg || {};
    var usePi = !!cfg.usePi;
    var includeAddons = (typeof cfg.includeAddons==='boolean') ? cfg.includeAddons : true;
    var base  = usePi ? COSTS.PER_ITEM_PI  : COSTS.PER_ITEM_IC;
    var addon = usePi ? COSTS.ADDON_PI     : COSTS.ADDON_IC;
    return base + (includeAddons ? addon * selectedAddOnCount() : 0);
  }

  // --- AI prompt: server first, then minimal fallback ---
  function aiToSVG(prompt){
    if (STATE.aiAttemptsLeft <= 0) return Promise.reject(new Error('No attempts left'));

    return serverJSON(api('/api/crafting/ai_svg'), {
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
    }).then(function(j){
      if (j && j.ok && j.svg){
        var cleaned = sanitizeSVG(j.svg);
        if (!cleaned) throw new Error('SVG rejected');
        STATE.aiAttemptsLeft -= 1;
        return cleaned;
      } else if (j && !j.ok) {
        alert('AI server error: ' + (j.reason || 'unknown'));
      }
      throw new Error('fallback');
    }).catch(function(){
      // fallback blueprint
      var raw = (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" preserveAspectRatio="xMidYMid meet">'+
        '<rect x="8" y="8" width="112" height="112" rx="14" fill="#0f1522" stroke="#2a3550" stroke-width="2"/>'+
        '<g fill="none" stroke="#2a3550" stroke-width="1">'+
          '<path d="M16 32 H112" opacity="0.6"/>'+
          '<path d="M16 56 H112" opacity="0.5"/>'+
          '<path d="M16 80 H112" opacity="0.4"/>'+
          '<path d="M16 104 H112" opacity="0.3"/>'+
        '</g>'+
        '<g opacity="0.9">'+
          '<circle cx="64" cy="64" r="22" fill="#1e2a45"/>'+
          '<path d="M48 64 Q64 48 80 64" fill="none" stroke="#3a4a72" stroke-width="3"/>'+
          '<path d="M48 72 Q64 56 80 72" fill="none" stroke="#3a4a72" stroke-width="2" opacity="0.8"/>'+
        '</g>'+
        '</svg>'
      );
      STATE.aiAttemptsLeft -= 1;
      return sanitizeSVG(raw);
    });
  }

  var TARGET_VB = {
    helmet: '0 0 128 128',
    vest:   '0 0 128 128',
    arms:   '0 0 160 120',
    legs:   '0 0 140 140',
    hands:  '0 0 160 100'
  };

  function _mapPartToSlot(p){
    p = String(p||'').toLowerCase();
    if (p==='gun' || p==='melee') return 'hands';
    return (p==='helmet'||p==='vest'||p==='arms'||p==='legs'||p==='hands') ? p : 'helmet';
  }

  function _parseVB(vbStr){
    if (!vbStr) return null;
    var m = String(vbStr).trim().split(/\s+/).map(Number);
    if (m.length !== 4 || m.some(function(n){ return !isFinite(n); })) return null;
    return { x:m[0], y:m[1], w:m[2], h:m[3] };
  }

  function _ensureMeasureHost(){
    var host = document.getElementById('izza-svg-measure-host');
    if (host) return host;
    host = document.createElement('div');
    host.id = 'izza-svg-measure-host';
    host.style.cssText = 'position:absolute;left:-99999px;top:-99999px;width:0;height:0;overflow:hidden;pointer-events:none';
    document.body.appendChild(host);
    return host;
  }

  function normalizeSvgForSlot(svgText, part){
    var safe = sanitizeSVG(svgText);
    if (!safe) return '';
    var slot = _mapPartToSlot(part);
    var targetVBStr = TARGET_VB[slot] || '0 0 128 128';
    var targetVB = _parseVB(targetVBStr);

    var measureHost = _ensureMeasureHost();
    var container = document.createElement('div');
    container.innerHTML = safe;
    var svgIn = container.querySelector('svg');
    if (!svgIn) return '';

    if (svgIn.hasAttribute('style')) {
      svgIn.setAttribute('style', svgIn.getAttribute('style').replace(/background(-color)?\s*:[^;]+;?/gi,''));
    }

    var defs = svgIn.querySelector('defs');
    var gfx = document.createElementNS('http://www.w3.org/2000/svg','g');
    Array.prototype.slice.call(svgIn.childNodes).forEach(function(n){
      if (n.nodeType!==1) return;
      var t = n.tagName && n.tagName.toLowerCase ? n.tagName.toLowerCase() : '';
      if (t==='defs'||t==='metadata'||t==='title'||t==='desc'||t==='style') return;
      gfx.appendChild(n.cloneNode(true));
    });

    var vbIn = _parseVB(svgIn.getAttribute('viewBox')) || _parseVB(targetVBStr) || {x:0,y:0,w:128,h:128};
    var meas = document.createElementNS('http://www.w3.org/2000/svg','svg');
    meas.setAttribute('xmlns','http://www.w3.org/2000/svg');
    meas.setAttribute('viewBox', vbIn.x+' '+vbIn.y+' '+vbIn.w+' '+vbIn.h);
    if (defs) meas.appendChild(defs.cloneNode(true));
    meas.appendChild(gfx);
    measureHost.appendChild(meas);

    var bbox;
    try { bbox = gfx.getBBox(); } catch (e) { bbox = null; }
    if (!bbox || bbox.width<=0 || bbox.height<=0){
      bbox = { x: vbIn.x, y: vbIn.y, width: vbIn.w, height: vbIn.h };
    }

    var pad = 1.5;
    var availW = targetVB.w - pad*2, availH = targetVB.h - pad*2;
    var s = Math.min(availW / bbox.width, availH / bbox.height);
    var scaledW = bbox.width*s, scaledH = bbox.height*s;
    var tx = (targetVB.x + pad) + (availW - scaledW)/2 - bbox.x*s;
    var ty = (targetVB.y + pad) + (availH - scaledH)/2 - bbox.y*s;

    var out = document.createElementNS('http://www.w3.org/2000/svg','svg');
    out.setAttribute('xmlns','http://www.w3.org/2000/svg');
    out.setAttribute('viewBox', targetVB.x+' '+targetVB.y+' '+targetVB.w+' '+targetVB.h);
    out.setAttribute('preserveAspectRatio','xMidYMid meet');
    out.setAttribute('data-slot', slot);

    var hasAnim = /<animate(?:Transform|Motion)?\b|@keyframes/i.test(safe);
    if (hasAnim) out.setAttribute('data-anim','1');

    if (defs) out.appendChild(defs.cloneNode(true));
    var style = svgIn.querySelector('style'); if (style) out.appendChild(style.cloneNode(true));

    var wrap = document.createElementNS('http://www.w3.org/2000/svg','g');
    wrap.setAttribute('transform', 'translate('+tx.toFixed(3)+' '+ty.toFixed(3)+') scale('+s.toFixed(5)+')');

    Array.prototype.slice.call(container.querySelectorAll('svg > *')).forEach(function(n){
      var t = n.tagName && n.tagName.toLowerCase ? n.tagName.toLowerCase() : '';
      if (!t || t==='defs'||t==='metadata'||t==='title'||t==='desc'||t==='style') return;
      wrap.appendChild(n);
    });
    out.appendChild(wrap);

    try { measureHost.removeChild(meas); } catch(e){}
    return out.outerHTML.replace(/\s{2,}/g,' ').replace(/\s+>/g,'>');
  }

  var DRAFT_KEY = 'izzaCraftDraft';
  function saveDraft(){
    try{
      localStorage.setItem(DRAFT_KEY, JSON.stringify({
        n: STATE.currentName,
        cat: STATE.currentCategory,
        part: STATE.currentPart,
        ff: STATE.featureFlags,
        svg: STATE.currentSVG
      }));
    }catch(e){}
  }
  function loadDraft(){
    try{
      var j = JSON.parse(localStorage.getItem(DRAFT_KEY)||'{}');
      if(!j) return;
      STATE.currentName      = (j.n    !== undefined ? j.n    : STATE.currentName);
      STATE.currentCategory  = (j.cat  !== undefined ? j.cat  : STATE.currentCategory);
      STATE.currentPart      = (j.part !== undefined ? j.part : STATE.currentPart);
      if (j.ff) for (var k in j.ff){ STATE.featureFlags[k]=j.ff[k]; }
      STATE.currentSVG       = (j.svg  !== undefined ? j.svg  : STATE.currentSVG);
    }catch(e){}
  }

  function renderTabs(){
    return ''+
      '<div style="display:flex; gap:8px; padding:10px; border-bottom:1px solid #2a3550; background:#0f1624">'+
        '<button class="ghost" data-tab="packages">Packages</button>'+
        '<button class="ghost" data-tab="create">Create Item</button>'+
        '<button class="ghost" data-tab="mine">My Creations</button>'+
      '</div>';
  }

  function renderPackages(){
    return ''+
      '<div style="padding:14px; display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:10px">'+
        '<div style="background:#0f1522;border:1px solid #2a3550;border-radius:10px;padding:12px">'+
          '<div style="font-weight:700;margin-bottom:6px">Starter Forge</div>'+
          '<div style="opacity:.85;font-size:13px;line-height:1.4">2× Weapons (½-heart dmg), 1× Armour set (+0.25% speed, 25% DR).<br/>Includes features & listing rights.</div>'+
          '<div style="margin-top:8px;font-weight:700">Cost: '+COSTS.PACKAGE_PI+' Pi or '+COSTS.PACKAGE_IC.toLocaleString()+' IC</div>'+
          '<div style="display:flex;gap:8px;margin-top:10px;justify-content:flex-end;flex-wrap:wrap">'+
            '<button class="ghost" data-buy-package-pi="starter-50">Pay '+COSTS.PACKAGE_PI+' Pi</button>'+
            '<button class="ghost" data-buy-package-ic="starter-50">Pay '+COSTS.PACKAGE_IC.toLocaleString()+' IC</button>'+
          '</div>'+
        '</div>'+
        '<div style="background:#0f1522;border:1px solid #2a3550;border-radius:10px;padding:12px">'+
          '<div style="font-weight:700;margin-bottom:6px">Single Item (visual)</div>'+
          '<div style="opacity:.85;font-size:13px;">Craft 1 item (no gameplay features).</div>'+
          '<div style="display:flex;gap:8px;margin-top:10px;justify-content:flex-end">'+
            '<button class="ghost" data-buy-single="pi">Pay '+COSTS.PER_ITEM_PI+' Pi</button>'+
            '<button class="ghost" data-buy-single="ic">Pay '+COSTS.PER_ITEM_IC+' IC</button>'+
          '</div>'+
        '</div>'+
        '<div style="background:#0f1522;border:1px dashed #2a3550;border-radius:10px;padding:12px">'+
          '<div style="font-weight:700;margin-bottom:6px">Crafting Land Marketplace</div>'+
          '<div style="opacity:.85;font-size:13px;">Browse player-made bundles and buy with Pi.</div>'+
          '<div style="display:flex;gap:8px;margin-top:10px;justify-content:flex-end">'+
            '<button class="ghost" id="goMarketplace">Open Marketplace</button>'+
          '</div>'+
        '</div>'+
      '</div>';
  }

  function renderCreate(){
    var totalPi = calcTotalCost({ usePi:true });
    var totalIC = calcTotalCost({ usePi:false });
    var sub = STATE.canUseVisuals ? (STATE.createSub === 'visuals' ? 'visuals' : 'setup') : 'setup';
    var visualsDisabledCls = STATE.canUseVisuals ? '' : 'disabled';

    return ''+
    '<div class="cl-subtabs">'+
      '<button class="'+(sub==='setup'?'on':'')+'" data-sub="setup">Setup</button>'+
      '<button class="'+(sub==='visuals'?'on':'')+' '+visualsDisabledCls+'" data-sub="visuals" '+(STATE.canUseVisuals?'':'disabled')+'>Visuals</button>'+
    '</div>'+
    '<div class="cl-body '+sub+'">'+
      '<div class="cl-pane cl-form">'+
        '<div style="font-weight:700;margin-bottom:6px">Item Setup</div>'+
        '<label style="display:block;margin:6px 0 4px;font-size:12px;opacity:.8">Category</label>'+
        '<select id="catSel">'+
          '<option value="armour">Armour</option>'+
          '<option value="weapon">Weapon</option>'+
          '<option value="apparel">Apparel</option>'+
          '<option value="merch">Merch/Collectible</option>'+
        '</select>'+
        '<label style="display:block;margin:8px 0 4px;font-size:12px;opacity:.8">Part / Type</label>'+
        '<select id="partSel"></select>'+
        '<label style="display:block;margin:10px 0 4px;font-size:12px;opacity:.8">Item Name</label>'+
        '<input id="itemName" type="text" maxlength="28" placeholder="Name…" style="width:100%"/>'+
        '<div style="margin-top:10px;font-weight:700">Optional Features</div>'+
        '<label><input type="checkbox" data-ff="dmgBoost"/> Weapon damage boost</label><br/>'+
        '<label><input type="checkbox" data-ff="fireRate"/> Gun fire-rate (server-capped)</label><br/>'+
        '<label><input type="checkbox" data-ff="speedBoost"/> Speed boost</label><br/>'+
        '<label><input type="checkbox" data-ff="dmgReduction"/> Armour damage reduction</label><br/>'+
        '<label><input type="checkbox" data-ff="tracerFx"/> Bullet tracer FX</label><br/>'+
        '<label><input type="checkbox" data-ff="swingFx"/> Melee swing FX</label>'+
        '<div style="margin-top:10px; font-size:13px; opacity:.85">Total (visual + selected features): <b>'+totalPi+' Pi</b> or <b>'+totalIC+' IC</b></div>'+
        '<div style="display:flex; gap:8px; margin-top:10px; flex-wrap:wrap">'+
          '<button class="ghost" id="payPi">Pay Pi</button>'+
          '<button class="ghost" id="payIC">Pay IC</button>'+
          '<span id="payStatus" style="font-size:12px; opacity:.8"></span>'+
        '</div>'+
        '<div style="margin-top:12px;border-top:1px solid #2a3550;padding-top:10px">'+
          '<div style="font-weight:700;margin-bottom:6px">Shop Listing</div>'+
          '<div style="font-size:12px;opacity:.8">Set price (server range '+COSTS.SHOP_MIN_IC+'-'+COSTS.SHOP_MAX_IC+' IC)</div>'+
          '<input id="shopPrice" type="number" min="'+COSTS.SHOP_MIN_IC+'" max="'+COSTS.SHOP_MAX_IC+'" value="100" style="width:120px"/>'+
          '<div style="margin-top:6px">'+
            '<label><input id="sellInShop" type="checkbox" checked/> List in in-game shop (IC)</label>'+
          '</div>'+
        '</div>'+
      '</div>'+
      '<div class="cl-pane cl-preview">'+
        (STATE.canUseVisuals
          ? ''+
          '<div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap">'+
            '<div style="font-weight:700">Visuals</div>'+
            '<div style="font-size:12px; opacity:.75">AI attempts left: <b id="aiLeft2">'+STATE.aiAttemptsLeft+'</b></div>'+
            '<div style="display:flex; gap:8px; align-items:center; margin-left:auto">'+
              '<label style="font-size:12px; opacity:.8">Style</label>'+
              '<select id="aiStyleSel">'+
                '<option value="realistic">Realistic</option>'+
                '<option value="cartoon">Cartoon / Stylized</option>'+
              '</select>'+
              '<label style="font-size:12px; opacity:.8; margin-left:12px">'+
                '<input type="checkbox" id="aiAnimChk"/> Add animation (premium)'+
              '</label>'+
            '</div>'+
          '</div>'+
          '<div style="display:flex; gap:10px; margin-top:6px">'+
            '<input id="aiPrompt" placeholder="Describe your item…" style="flex:1"/>'+
            '<button class="ghost" id="btnAI">AI → SVG</button>'+
          '</div>'+
          '<div style="margin-top:8px">'+
            '<label style="font-size:12px; opacity:.85">'+
              '<input id="toMerchant" type="checkbox"/>'+
              ' Create an IZZA Pay product for this item'+
            '</label>'+
          '</div>'+
          '<div style="font-size:12px; opacity:.75; margin-top:6px">or paste/edit SVG manually</div>'+
          '<textarea id="svgIn" style="width:100%; height:200px; margin-top:6px" placeholder="<svg>…</svg>"></textarea>'+
          '<div class="cl-actions" style="margin-top:8px; display:flex; gap:8px; flex-wrap:wrap">'+
            '<button class="ghost" id="btnPreview">Preview</button>'+
            '<button class="ghost" id="btnMint" style="display:none" title="Mint this item into the game!">Mint</button>'+
            '<span id="craftStatus" style="font-size:12px; opacity:.8"></span>'+
          '</div>'+
          '<div id="svgPreview" style="margin-top:10px; background:#0f1522; border:1px solid #2a3550; border-radius:10px; min-height:220px; max-height:min(60vh,520px); overflow:auto; display:flex; align-items:center; justify-content:center">'+
            '<div style="opacity:.6; font-size:12px">Preview appears here</div>'+
          '</div>'
          : ''+
          '<div style="opacity:.8; font-size:13px; padding:12px; border:1px dashed #2a3550; border-radius:10px;">'+
            'Visuals are locked. Complete payment in <b>Setup</b> or on the <b>Packages</b> tab to unlock (includes '+COSTS.AI_ATTEMPTS+' AI attempts).'+
          '</div>'
        )+
      '</div>'+
    '</div>';
  }

  function renderMine(){
    return ''+
      '<div style="padding:14px">'+
        '<div style="font-weight:700;margin-bottom:6px">My Creations</div>'+
        '<div id="mineList" style="display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:10px"></div>'+
      '</div>';
  }

  function currentUsername(){
    return (window.IZZA && window.IZZA.player && window.IZZA.player.username) ||
           (window.IZZA && window.IZZA.me && window.IZZA.me.username) ||
           localStorage.getItem('izzaPlayer') ||
           localStorage.getItem('pi_username') ||
           '';
  }

  function fetchMine(){
    try{
      var u = encodeURIComponent(currentUsername());
      if(!u) return Promise.resolve([]);
      return serverJSON(api('/api/crafting/mine?u='+u)).then(function(j){
        return (j && j.ok && Array.isArray(j.items)) ? j.items : [];
      }).catch(function(){ return []; });
    }catch(e){ return Promise.resolve([]); }
  }

  function mineCardHTML(it){
    var safeSVG = sanitizeSVG(it.svg||'');
    var inShop = !!it.inShop;
    return ''+
      '<div style="background:#0f1522;border:1px solid #2a3550;border-radius:10px;padding:10px">'+
        '<div style="font-weight:700">'+(it.name||'Untitled')+'</div>'+
        '<div style="opacity:.75;font-size:12px">'+(it.category||'?')+' / '+(it.part||'?')+'</div>'+
        '<div style="margin-top:6px;border:1px solid #2a3550;border-radius:8px;background:#0b0f17;overflow:hidden;min-height:80px">'+
          (safeSVG || '<div style="opacity:.6;padding:10px;font-size:12px">No SVG</div>')+
        '</div>'+
        '<div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">'+
          '<button class="ghost" data-copy="'+it.id+'">Copy SVG</button>'+
          '<button class="ghost" data-equip="'+it.id+'">Equip</button>'+
          (inShop
            ? '<button class="ghost" data-stats="'+it.id+'">View Shop Stats</button>'
            : '<button class="ghost" data-addshop="'+it.id+'">Add to Shop</button>')+
        '</div>'+
      '</div>';
  }

  function hydrateMine(){
    var host = STATE.root && STATE.root.querySelector('#mineList');
    if(!host) return Promise.resolve();
    host.innerHTML = '<div style="opacity:.7">Loading…</div>';
    return fetchMine().then(function(items){
      host.innerHTML = items.length
        ? items.map(mineCardHTML).join('')
        : '<div style="opacity:.7">No creations yet.</div>';

      Array.prototype.forEach.call(host.querySelectorAll('[data-copy]'), function(b){
        b.addEventListener('click', function(){
          var id = b.getAttribute('data-copy');
          var it = items.find(function(x){ return x.id===id; });
          if(!it) return;
          try{ navigator.clipboard.writeText(it.svg||'').then(function(){ alert('SVG copied'); }); }catch(e){}
        });
      });
      Array.prototype.forEach.call(host.querySelectorAll('[data-equip]'), function(b){
        b.addEventListener('click', function(){
          var id = b.getAttribute('data-equip');
          var it = items.find(function(x){ return x.id===id; });
          if (!it) return;
          try {
            localStorage.setItem('izzaLastEquipped', JSON.stringify({
              id: it.id, name: it.name, category: it.category, part: it.part, svg: it.svg
            }));
          } catch(e){}
          try { if (window.IZZA && typeof window.IZZA.emit==='function') window.IZZA.emit('equip-crafted', id); } catch(e){}
          try { if (window.IZZA && typeof window.IZZA.emit==='function') window.IZZA.emit('equip-crafted-v2', { id: it.id, name: it.name, category: it.category, part: it.part, svg: it.svg }); } catch(e){}
        });
      });
      Array.prototype.forEach.call(host.querySelectorAll('[data-addshop]'), function(b){
        b.addEventListener('click', function(){
          var id = b.getAttribute('data-addshop');
          var it = items.find(function(x){ return x.id===id; });
          if(!it) return;
          try{
            var u = encodeURIComponent(currentUsername());
            var priceIC = Math.max(COSTS.SHOP_MIN_IC, Math.min(COSTS.SHOP_MAX_IC, 100));
            serverJSON(api('/api/shop/add?u='+u), {
              method:'POST',
              body: JSON.stringify({ id: it.id, priceIC: priceIC })
            }).then(function(j){
              if (j && j.ok){ alert('Added to shop!'); hydrateMine(); }
              else { alert('Failed to add to shop'); }
            }).catch(function(){ alert('Failed to add to shop'); });
          }catch(e){ alert('Failed to add to shop'); }
        });
      });
      Array.prototype.forEach.call(host.querySelectorAll('[data-stats]'), function(b){
        b.addEventListener('click', function(){
          try{
            var id = b.getAttribute('data-stats');
            serverJSON(api('/api/shop/stats?id='+encodeURIComponent(id))).then(function(j){
              if (j && j.ok){
                var s = j.stats||{};
                alert('Sales: '+(s.sold||0)+'\nPlayer resales: '+(s.resold||0));
              } else {
                alert('No stats yet.');
              }
            }).catch(function(){ alert('Could not load stats'); });
          }catch(e){ alert('Could not load stats'); }
        });
      });
    });
  }

  function mount(rootSel){
    var root = (typeof rootSel==='string') ? document.querySelector(rootSel) : rootSel;
    if (!root) return;
    STATE.root = root;
    STATE.mounted = true;
    loadDraft();

    root.innerHTML = renderTabs()+'<div id="craftTabs"></div>';
    var tabsHost = root.querySelector('#craftTabs');

    function setTab(name){
      if(!STATE.mounted) return;
      if(name==='packages'){ tabsHost.innerHTML = renderPackages(); }
      if(name==='create'){   tabsHost.innerHTML = renderCreate(); }
      if(name==='mine'){     tabsHost.innerHTML = renderMine(); hydrateMine(); }

      bindInside();

      if (name === 'create' && STATE.canUseVisuals) {
        try {
          var el = document.getElementById('aiLeft2');
          if (el) el.textContent = STATE.aiAttemptsLeft;
        } catch(e){}
      }
    }

    Array.prototype.forEach.call(root.querySelectorAll('[data-tab]'), function(b){
      b.addEventListener('click', function(){ setTab(b.getAttribute('data-tab')); });
    });

    setTab('packages');
  }

  function unmount(){ if(!STATE.root) return; STATE.root.innerHTML=''; STATE.mounted=false; }

  function handleBuySingle(kind, cfg){
    cfg = cfg || {};
    var usePi = (kind==='pi');
    var total = calcTotalCost({ usePi: usePi, includeAddons: cfg.includeAddons!==false });
    var status = document.getElementById('payStatus');

    var payP = usePi ? payWithPi(total, cfg.includeAddons!==false ? 'Craft Item (+features)' : 'Craft Item') : payWithIC(total);
    return payP.then(function(res){
      if (res && res.ok){
        STATE.hasPaidForCurrentItem = true;
        STATE.canUseVisuals = true;
        STATE.aiAttemptsLeft = COSTS.AI_ATTEMPTS;
        if (status) status.textContent='Paid ✓ — visuals unlocked.';
        STATE.createSub = 'visuals';
        var host = STATE.root && STATE.root.querySelector('#craftTabs');
        if (host){ host.innerHTML = renderCreate(); bindInside(); }
      } else {
        if (status) status.textContent='Payment failed.';
      }
    });
  }

  function bindInside(){
    var root = STATE.root;
    if(!root) return;

    Array.prototype.forEach.call(root.querySelectorAll('[data-sub]'), function(b){
      b.addEventListener('click', function(){
        var want = (b.getAttribute('data-sub') === 'visuals') ? 'visuals' : 'setup';
        STATE.createSub = (want==='visuals' && !STATE.canUseVisuals) ? 'setup' : want;
        var host = STATE.root && STATE.root.querySelector('#craftTabs');
        if (!host) return;
        var saveScroll = host.scrollTop;
        host.innerHTML = renderCreate();
        bindInside();
        host.scrollTop = saveScroll;
      }, { passive:true });
    });

    Array.prototype.forEach.call(root.querySelectorAll('[data-buy-package-pi]'), function(btn){
      btn.addEventListener('click', function(){
        payWithPi(COSTS.PACKAGE_PI, 'Starter Forge').then(function(res){
          if(res.ok){ STATE.packageCredits = { id:'starter-50', items:3, featuresIncluded:true }; alert('Package unlocked — start creating!'); }
        });
      }, { passive:true });
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-buy-package-ic]'), function(btn){
      btn.addEventListener('click', function(){
        payWithIC(COSTS.PACKAGE_IC).then(function(res){
          if(res.ok){ STATE.packageCredits = { id:'starter-50', items:3, featuresIncluded:true }; alert('Package unlocked — start creating!'); }
        });
      }, { passive:true });
    });

    Array.prototype.forEach.call(root.querySelectorAll('[data-buy-single]'), function(btn){
      btn.addEventListener('click', function(){ handleBuySingle(btn.getAttribute('data-buy-single'), { includeAddons:false }); }, { passive:true });
    });

    var goMp = root.querySelector('#goMarketplace');
    if (goMp){
      goMp.addEventListener('click', function(){
        try{ if (window.IZZA && typeof window.IZZA.emit==='function') window.IZZA.emit('open-marketplace'); }catch(e){}
      });
    }

    var payPi = root.querySelector('#payPi');
    var payIC = root.querySelector('#payIC');
    if (payPi) payPi.addEventListener('click', function(){ handleBuySingle('pi', { includeAddons:true }); }, { passive:true });
    if (payIC) payIC.addEventListener('click', function(){ handleBuySingle('ic', { includeAddons:true }); }, { passive:true });

    var itemName = root.querySelector('#itemName');
    if (itemName){
      itemName.value = STATE.currentName || '';
      itemName.addEventListener('input', function(e){ STATE.currentName = e.target.value; saveDraft(); }, { passive:true });
    }

    Array.prototype.forEach.call(root.querySelectorAll('[data-ff]'), function(cb){
      var key = cb.getAttribute('data-ff');
      if (STATE.featureFlags && (key in STATE.featureFlags)) cb.checked = !!STATE.featureFlags[key];
      cb.addEventListener('change', function(){
        STATE.featureFlags[key] = cb.checked;
        saveDraft();
        var host = root.querySelector('#craftTabs');
        if (!host) return;
        var saveScroll = host.scrollTop;
        host.innerHTML = renderCreate();
        bindInside();
        host.scrollTop = saveScroll;
      });
    });

    var catSel  = root.querySelector('#catSel');
    var partSel = root.querySelector('#partSel');

    if (catSel && partSel){
      catSel.value = STATE.currentCategory;
      repopulatePartOptions(catSel, partSel);

      catSel.addEventListener('change', function(e){
        STATE.currentCategory = e.target.value;
        repopulatePartOptions(catSel, partSel);
        saveDraft();
      }, { passive:true });
    }

    if (partSel){
      partSel.value = STATE.currentPart;
      partSel.addEventListener('change', function(e){
        STATE.currentPart = e.target.value;
        saveDraft();
      }, { passive:true });
    }

    var aiStyleSel = root.querySelector('#aiStyleSel');
    var aiAnimChk  = root.querySelector('#aiAnimChk');
    if (aiStyleSel){
      aiStyleSel.value = STATE.aiStyle;
      aiStyleSel.addEventListener('change', function(e){ STATE.aiStyle = e.target.value; saveDraft(); });
    }
    if (aiAnimChk){
      aiAnimChk.checked = !!STATE.wantAnimation;
      aiAnimChk.addEventListener('change', function(e){ STATE.wantAnimation = !!e.target.checked; saveDraft(); });
    }

    function aiLeft(){
      var b = document.getElementById('aiLeft2');
      if (b) b.textContent = STATE.aiAttemptsLeft;
    }

    var btnAI    = root.querySelector('#btnAI');
    var aiPrompt = root.querySelector('#aiPrompt');
    var svgIn    = root.querySelector('#svgIn');
    var btnPrev  = root.querySelector('#btnPreview');
    var btnMint  = root.querySelector('#btnMint');
    var prevHost = root.querySelector('#svgPreview');
    var craftStatus = root.querySelector('#craftStatus');

    if (svgIn && STATE.currentSVG){
      svgIn.value = STATE.currentSVG;
      if (prevHost) prevHost.innerHTML = STATE.currentSVG;
    }

    if (btnAI) btnAI.addEventListener('click', function(){
      if (!btnAI) return;
      var prompt = String(aiPrompt && aiPrompt.value || '').trim();
      if (!prompt) return;

      btnAI.disabled = true;
      btnAI.setAttribute('aria-busy','true');
      btnAI.textContent = 'Generating…';
      var waitEl = showWait('Crafting your SVG preview (this can take ~5–10s)…');

      Promise.all([ aiToSVG(prompt), sleep(MIN_AI_WAIT_MS) ]).then(function(arr){
        var svg = arr[0];
        if (svgIn) svgIn.value = svg;
        if (prevHost) {
          prevHost.innerHTML = svg;
          var s = prevHost.querySelector('svg');
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
        var m = root.querySelector('#btnMint'); if (m) m.style.display = 'inline-block';
        aiLeft();
      }).catch(function(e){
        alert('AI failed: ' + (e && e.message ? e.message : e));
      }).finally ? Promise.resolve().then(function(){ hideWait(waitEl); btnAI.disabled=false; btnAI.removeAttribute('aria-busy'); btnAI.textContent='AI → SVG'; }) :
      (function(){ hideWait(waitEl); btnAI.disabled=false; btnAI.removeAttribute('aria-busy'); btnAI.textContent='AI → SVG'; })();
    });

    if (btnPrev) btnPrev.addEventListener('click', function(){
      var cleaned = sanitizeSVG(svgIn && svgIn.value);
      if (!cleaned){ alert('SVG failed moderation/sanitize'); return; }
      if (prevHost) {
        prevHost.innerHTML = cleaned;
        var s = prevHost.querySelector('svg');
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
      var m = root.querySelector('#btnMint'); if (m) m.style.display = 'inline-block';
    });

    if (btnMint) btnMint.addEventListener('click', function(){
      if (craftStatus) craftStatus.textContent = '';

      var nm = moderateName(STATE.currentName);
      if (!nm.ok){ if (craftStatus) craftStatus.textContent = nm.reason; return; }

      var freeTest = (COSTS.PER_ITEM_IC === 0 && selectedAddOnCount() === 0);
      if (!STATE.hasPaidForCurrentItem && !STATE.packageCredits && !freeTest){
        if (craftStatus) craftStatus.textContent = 'Please pay (Pi or IC) first, or buy a package.'; return;
      }
      if (!STATE.currentSVG){ if (craftStatus) craftStatus.textContent = 'Add/Preview SVG first.'; return; }

      var sellInShopEl = root.querySelector('#sellInShop');
      var sellInShop = !!(sellInShopEl && sellInShopEl.checked);
      var priceICVal = parseInt((root.querySelector('#shopPrice') && root.querySelector('#shopPrice').value) || '100', 10) || 100;
      var priceIC = Math.max(COSTS.SHOP_MIN_IC, Math.min(COSTS.SHOP_MAX_IC, priceICVal));
      var toMerchantEl = root.querySelector('#toMerchant');
      var toMerchant = !!(toMerchantEl && toMerchantEl.checked);

      try{
        var normalizedForSlot = normalizeSvgForSlot(STATE.currentSVG, STATE.currentPart);

        var injected = (window.ArmourPacks && typeof window.ArmourPacks.injectCraftedItem==='function')
          ? window.ArmourPacks.injectCraftedItem({
              name: STATE.currentName,
              category: STATE.currentCategory,
              part: STATE.currentPart,
              svg: normalizedForSlot,
              priceIC: priceIC,
              sellInShop: sellInShop,
              sellInPi: false,
              featureFlags: STATE.featureFlags
            })
          : { ok:false, reason:'armour-packs-hook-missing' };

        if (injected && injected.ok){
          if (craftStatus) craftStatus.textContent = 'Crafted ✓';
          STATE.hasPaidForCurrentItem = false;
          if (STATE.packageCredits && STATE.packageCredits.items > 0){
            STATE.packageCredits.items -= 1;
            if (STATE.packageCredits.items <= 0) STATE.packageCredits = null;
          }

          try{
            var u = encodeURIComponent(
              (window.IZZA && window.IZZA.player && window.IZZA.player.username) ||
              (window.IZZA && window.IZZA.me && window.IZZA.me.username) ||
              localStorage.getItem('izzaPlayer') ||
              localStorage.getItem('pi_username') ||
              ''
            );
            if (u) {
              serverJSON(api('/api/crafting/mine?u='+u), {
                method: 'POST',
                body: JSON.stringify({
                  name: STATE.currentName,
                  category: STATE.currentCategory,
                  part: STATE.currentPart,
                  svg: normalizedForSlot,
                  priceIC: priceIC,
                  sellInShop: sellInShop,
                  sku: '',
                  image: ''
                })
              }).catch(function(){});
            }
          }catch(e){ console.warn('[craft] persist failed:', e); }

          if (toMerchant){
            serverJSON(api('/api/merchant/create_from_craft'), {
              method:'POST',
              body: JSON.stringify({
                name: STATE.currentName,
                category: STATE.currentCategory,
                part: STATE.currentPart,
                svg: normalizedForSlot,
                priceIC: priceIC
              })
            }).catch(function(e){ console.warn('[merchant] create failed:', e); });
          }

          hydrateMine();
        }else{
          if (craftStatus) craftStatus.textContent = 'Mint failed: ' + ((injected && injected.reason) || 'armour hook missing');
        }
      }catch(e){
        if (craftStatus) craftStatus.textContent = 'Error crafting: ' + e.message;
      }
    });
  }

  // expose in case the rest of your app needs to mount/unmount
  window.CraftingLandUI = Object.freeze({
    mount: mount,
    unmount: unmount
  });
})(); // end IIFE
