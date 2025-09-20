// izza_ai_wiring.js — client wiring for /api/crafting/ai_svg
// depends on core v3 being loaded first

(function(){
  const BUILD = 'ai-wiring-v1';
  console.log('[IZZA PLUGIN]', BUILD);

  // === config ===
  const CFG = {
    endpoint: '/api/crafting/ai_svg' // <-- your server route from index.js
  };

  // quick client-side SVG sanity (extra belt & suspenders)
  function safeInlineSvg(svg){
    try{
      let t = String(svg||'').trim();
      if(!t) return '';
      if(t.length > 200000) t = t.slice(0,200000);
      if(!/^<svg\b[^>]*>[\s\S]*<\/svg>\s*$/i.test(t)) return '';
      if (/(<!DOCTYPE|<script|\son\w+=|<iframe|<foreignObject)/i.test(t)) return '';
      if (/\b(xlink:href|href)\s*=\s*['"](?!#)/i.test(t)) return '';
      return t;
    }catch{ return ''; }
  }

  async function aiSVG(prompt, meta){
    const body = { prompt, meta: meta || {} };
    const r = await fetch(CFG.endpoint, {
      method: 'POST',
      credentials: 'include',                // <-- important (matches your server CORS)
      headers: { 'content-type':'application/json' },
      body: JSON.stringify(body)
    });
    const j = await r.json().catch(()=>({}));
    if(!j || !j.ok || !j.svg) throw new Error(j.reason || 'ai_svg failed');
    const svg = safeInlineSvg(j.svg);
    if(!svg) throw new Error('client-sanitize-fail');
    return { svg, style:j.style, animated:!!j.animated, animationStripped:!!j.animationStripped, priceIC:j.priceIC|0 };
  }

  // Convert the AI SVG into an inventory item your Armoury/UI already understands.
  // part: 'helmet' | 'vest' | 'arms' | 'legs' | 'hands'  (matches your server)
  function addCraftToInventory({name, part, svg, type='armor', equippable=true}){
    const api = (window.IZZA && IZZA.api) || null;
    if(!api || typeof api.getInventory!=='function' || typeof api.setInventory!=='function'){
      throw new Error('IZZA.api inventory not ready');
    }
    const inv = api.getInventory() || {};
    const key = ('craft_' + (name||'item')).toLowerCase().replace(/[^a-z0-9_]+/g,'_').slice(0,40);

    // If it already exists, bump count; else create
    const cur = inv[key] || {};
    inv[key] = Object.assign({}, cur, {
      type,                      // 'armor' or 'consumable' or 'weapon'
      name: name || 'AI Item',
      part: part || 'helmet',    // used by your panel & equip logic
      iconSvg: svg,              // your panel shows inline <svg> already
      svg,                       // keep full; future: you may split iconSvg vs full overlay
      equippable: !!equippable,
      count: (cur.count|0) + 1,
      // optional bridges; leave empty unless you intend a weapon mapping:
      // coreWeapon: 'pistol' | 'bat'
    });

    api.setInventory(inv);
    try{ window.dispatchEvent(new Event('izza-inventory-changed')); }catch{}
    try{ (window.toast||console.log)('Crafted: '+ (name||key)); }catch{}
  }

  // Public helper: craft + inject
  async function craftArmorSVG(prompt, {name, part='helmet', style='auto', animate=false, animationPaid=false} = {}){
    const { svg } = await aiSVG(prompt, {
      part, name, style, animate, animationPaid
    });
    addCraftToInventory({ name: name || prompt.slice(0,24), part, svg, type:'armor', equippable:true });
    return true;
  }

  // Optional: consumables (food/potions) — these will show Eat/Drink buttons in your panel
  async function craftConsumableSVG(prompt, {name, kind='food'} = {}){
    const part = 'hands'; // small horizontal icon works fine for consumables
    const { svg } = await aiSVG(prompt, { part, name, style:'cartoon' });
    const api = (window.IZZA && IZZA.api) || null;
    if(!api) throw new Error('IZZA.api not ready');
    const inv = api.getInventory() || {};
    const key = ('craft_' + (name||kind)).toLowerCase().replace(/[^a-z0-9_]+/g,'_').slice(0,40);
    const cur = inv[key] || {};
    inv[key] = Object.assign({}, cur, {
      type: 'consumable',
      name: name || (kind==='potion' ? 'Tonic' : 'Food'),
      part,
      iconSvg: svg,
      svg,
      count: (cur.count|0) + 1,
      equippable: false,               // not equippable
      eatable: (kind==='food'),        // your panel converts to “Eat”
      drinkable: (kind!=='food')       // your panel converts to “Drink”
    });
    api.setInventory(inv);
    try{ window.dispatchEvent(new Event('izza-inventory-changed')); }catch{}
    return true;
  }

  // Hook into the game bus when ready (optional: auto-test craft after tier-2)
  IZZA?.on?.('ready', ()=>{
    console.log('[IZZA PLUGIN] ai-wiring ready');
    // Example: auto-unlock demo after tier-2 (missions ≥ 3)
    try{
      const missions = IZZA.api.getMissionCount?.()|0;
      if(missions >= 3){
        // small delayed demo craft — comment out in production
        // craftArmorSVG('gold angel wings armor but futuristic', { name:'Angel Wings', part:'vest', style:'stylized' });
      }
    }catch{}
  });

  // Expose a tiny API so you can call from anywhere (buttons, dev console, other plugins)
  window.IZZA_AI = {
    craftArmorSVG,
    craftConsumableSVG,
    addCraftToInventory
  };
})();
