// Remote Players API — v2.3
// Matches core v3.17 tinting (skin tone + hair color) and slot/equipped armor
// Smooth interpolation + last-good composite fallback (no blue-box flicker)
// SOLO-aware + REST presence (unchanged endpoints)
(function(){
  const BUILD = 'v2.3-remote-players-core317-tint+equipped-slots';
  console.log('[IZZA PLAY]', BUILD);

  // -------- config / helpers ----------
  const MP_BASE = (window.__MP_BASE__ || '/izza-game/api/mp');
  const TOK = (window.__IZZA_T__ || '').toString();
  const withTok = (p) => TOK ? p + (p.includes('?') ? '&' : '?') + 't=' + encodeURIComponent(TOK) : p;

  async function jget(p){
    const r = await fetch(withTok(MP_BASE+p), { credentials:'include' });
    if(!r.ok) throw new Error(`${r.status} ${r.statusText}`); return r.json();
  }
  async function jpost(p,b){
    const r = await fetch(withTok(MP_BASE+p), { method:'POST', credentials:'include', headers:{'Content-Type':'application/json'}, body:JSON.stringify(b||{}) });
    if(!r.ok) throw new Error(`${r.status} ${r.statusText}`); return r.json();
  }

  const getWorld = ()=> localStorage.getItem('izzaWorldId') || 'solo';
  const isMPWorld = ()=> { const w = getWorld(); return w!=='solo'; };

  // ---- profile appearance ----
  function readAppearance(){
    try{
      const p = window.__IZZA_PROFILE__ || {};
      const a = p.appearance || p || {};
      return {
        username: p.username || 'guest',
        body_type: a.body_type || 'male',
        sprite_skin: a.sprite_skin || 'default',
        skin_tone: a.skin_tone || 'light',
        outfit: a.outfit || 'street',
        hair: a.hair || 'short',
        hair_color: a.hair_color || 'black',
        female_outfit_color: a.female_outfit_color || 'blue'
      };
    }catch{ return { body_type:'male', sprite_skin:'default', hair:'short', outfit:'street', skin_tone:'light', hair_color:'black', female_outfit_color:'blue' }; }
  }

  // ---- inventory (reads your core store if exposed) ----
  function readInventory(){
    // Prefer your core’s getInventory() if present (keeps slot/equipped flags)
    try{ if (typeof IZZA?.api?.getInventory==='function') return IZZA.api.getInventory() || {}; }catch{}
    // Fallback to older exposure
    const inv = {};
    try{ Object.assign(inv, (IZZA?.api?.getArmory?.())||{}); }catch{}
    try{ inv.crafted = (IZZA?.api?.getCraftedItems?.())||{}; }catch{}
    return inv;
  }

  // -------- remote players store ----------
  const REMOTES = [];
  const byName = Object.create(null);

  function clearRemotePlayers(){
    REMOTES.splice(0, REMOTES.length);
    for (const k in byName) delete byName[k];
    try{ if (window.IZZA?.api) IZZA.api.remotePlayers = REMOTES; }catch{}
  }

  // ---------- ASSETS & TINTING (matches core v3.17) ----------
  const FRAME_W=32, FRAME_H=32, ROWS=4;
  const DIR_INDEX = { down:0, right:1, left:2, up:3 };

  function loadImg(src){
    return new Promise((res)=>{ const i=new Image(); i.onload=()=>res(i); i.onerror=()=>res(null); i.src=src; });
  }
  async function loadLayer(kind, name){
    const base = '/static/game/sprites/' + kind + '/';
    const try2 = await loadImg(base + encodeURIComponent(name + ' 2') + '.png');
    if (try2) return { img: try2, cols: Math.max(1, Math.floor(try2.width / FRAME_W)) };
    const try1 = await loadImg(base + encodeURIComponent(name) + '.png');
    if (try1) return { img: try1, cols: Math.max(1, Math.floor(try1.width / FRAME_W)) };
    return { img: null, cols: 1 };
  }
  function emptyLayer(){ const c=document.createElement('canvas'); c.width=32; c.height=32; return {img:c, cols:1}; }

  // ==== same ramps as core ====
  const SKIN_BASE = ["#F7D7C6","#E8BEA8","#D6A48E"];
  const SKIN_TO = {
    light:  ["#FFE7D6","#F3C6A7","#D8A187"],
    medium: ["#F1BD94","#D79A73","#B67955"],
    tan:    ["#E2A878","#C88756","#9F663C"],
    dark:   ["#B9825B","#9A6644","#714A31"],
    deep:   ["#8B5A3B","#6A402A","#432818"]
  };
  const FEMALE_DRESS_BASE = ["#7AB6FF","#4E84E3","#2F5CB5"];
  const FEMALE_DRESS_TO = {
    blue:   ["#7AB6FF","#4E84E3","#2F5CB5"],
    red:    ["#FF7A7A","#E24C4C","#B12F2F"],
    green:  ["#7DD68A","#4CB56B","#2F7F47"],
    purple: ["#B796FF","#8C6BE0","#6A49B8"],
    yellow: ["#FFE08A","#E7C45A","#B89433"],
    pink:   ["#FFA6D6","#E57CB2","#C45C96"],
    black:  ["#3A3A3D","#232326","#0E0E10"],
    white:  ["#FFFFFF","#E6E6E6","#C9C9C9"],
    brown:  ["#A87854","#7C563A","#593D29"],
    orange: ["#FFB46A","#E4873A","#B65E1F"]
  };
  const HAIR_TO = {
    black:  ["#2C2C31","#17171B","#0A0A0D"],
    brown:  ["#7A5336","#5C3E28","#3E2B1B"],
    blonde: ["#FBE58F","#E5C35A","#B89433"],
    red:    ["#E65F35","#B54426","#8E321A"],
    white:  ["#FFFFFF","#E6E6E6","#C9C9C9"],
    blue:   ["#7AB6FF","#4E84E3","#2F5CB5"],
    green:  ["#7DD68A","#4CB56B","#2F7F47"],
    pink:   ["#FFA6D6","#E57CB2","#C45C96"]
  };

  const hexToRgb = h => { const n=parseInt(String(h).replace('#',''),16); return {r:(n>>16)&255,g:(n>>8)&255,b:n&255}; };
  const dist2 = (a,b)=>{const dr=a.r-b.r,dg=a.g-b.g,db=a.b-b.b;return dr*dr+dg*dg+db*db;};

  function extractThreeToneRamp(img){
    const w=img.width,h=img.height;
    const oc=document.createElement('canvas'); oc.width=w; oc.height=h;
    const c=oc.getContext('2d',{willReadFrequently:true});
    c.imageSmoothingEnabled=false; c.drawImage(img,0,0);
    const d=c.getImageData(0,0,w,h).data;
    function lum(r,g,b){ return 0.2126*r + 0.7152*g + 0.0722*b; }
    const samples=[];
    for(let i=0;i<d.length;i+=16){
      const a=d[i+3]; if(a<12) continue;
      const r=d[i],g=d[i+1],b=d[i+2];
      samples.push({r,g,b,L:lum(r,g,b)});
    }
    if(samples.length<12) return ["#C8C8C8","#9C9C9C","#6E6E6E"];
    samples.sort((a,b)=>a.L-b.L);
    const pick = q => {
      const idx = Math.max(0, Math.min(samples.length-1, Math.floor(q*(samples.length-1))));
      const s = samples[idx];
      return '#'+s.r.toString(16).padStart(2,'0')+s.g.toString(16).padStart(2,'0')+s.b.toString(16).padStart(2,'0');
    };
    return [pick(0.2), pick(0.55), pick(0.85)];
  }
  function paletteSwapCanvas(img, fromRampHex, toRampHex, tolerance=2000){
    const from = fromRampHex.map(hexToRgb), to = toRampHex.map(hexToRgb);
    const c=document.createElement('canvas'); c.width=img.width; c.height=img.height;
    const g=c.getContext('2d',{willReadFrequently:true}); g.imageSmoothingEnabled=false; g.drawImage(img,0,0);
    const id=g.getImageData(0,0,c.width,c.height), d=id.data;
    for(let i=0;i<d.length;i+=4){
      if(d[i+3]===0) continue;
      const p={r:d[i],g:d[i+1],b:d[i+2]};
      let k=0, best=1e9; for(let j=0;j<from.length;j++){ const s=dist2(p,from[j]); if(s<best){best=s;k=j;} }
      if(best<=tolerance){ const t=to[k]||to[1]||to[0]; d[i]=t.r; d[i+1]=t.g; d[i+2]=t.b; }
    }
    g.putImageData(id,0,0);
    return c;
  }
  function overlayTintCanvas(img, hex, strength=1.0){
    const w=img.width,h=img.height;
    const oc=document.createElement('canvas'); oc.width=w; oc.height=h;
    const c=oc.getContext('2d',{willReadFrequently:true});
    c.imageSmoothingEnabled=false; c.drawImage(img,0,0);
    const id=c.getImageData(0,0,w,h), d=id.data;
    const n = parseInt(String(hex).replace('#',''),16);
    const tr=(n>>16)&255, tg=(n>>8)&255, tb=(n>>0)&255;
    function ov(a,b){a/=255;b/=255;const o=(a<.5)?(2*a*b):(1-2*(1-a)*(1-b));return Math.round(o*255); }
    for(let i=0;i<d.length;i+=4){
      if(d[i+3]===0) continue;
      const r=ov(d[i],tr), g=ov(d[i+1],tg), b=ov(d[i+2],tb);
      d[i]=Math.round(d[i]*(1-strength)+r*strength);
      d[i+1]=Math.round(d[i+1]*(1-strength)+g*strength);
      d[i+2]=Math.round(d[i+2]*(1-strength)+b*strength);
    }
    c.putImageData(id,0,0);
    return oc;
  }

  function tintBodyLayer(pack, ap){
    try{
      const isFemale = (ap.body_type==='female');
      const skin = SKIN_TO[ap.skin_tone] || SKIN_TO.light;
      let canvas = paletteSwapCanvas(pack.img, SKIN_BASE, skin, 4000);
      if(isFemale){
        const dress = FEMALE_DRESS_TO[ap.female_outfit_color] || FEMALE_DRESS_TO.blue;
        canvas = paletteSwapCanvas(canvas, FEMALE_DRESS_BASE, dress, 4000);
      }
      return { img: canvas, cols: pack.cols };
    }catch{ return pack; }
  }
  function tintHairLayer(pack, ap){
    try{
      const target = HAIR_TO[ap.hair_color] || HAIR_TO.black;
      const detected = extractThreeToneRamp(pack.img);
      let canvas = paletteSwapCanvas(pack.img, detected, target, 4000);

      // tiny diff test; if no visible change, force overlay
      const g = canvas.getContext('2d'), before = document.createElement('canvas');
      before.width=pack.img.width; before.height=pack.img.height;
      const gb=before.getContext('2d'); gb.imageSmoothingEnabled=false; gb.drawImage(pack.img,0,0);
      const A = gb.getImageData(0,0,before.width,before.height).data;
      const B = g.getImageData(0,0,canvas.width,canvas.height).data;
      let diffs=0; for(let i=0;i<B.length;i+=16){ if(A[i]!==B[i]||A[i+1]!==B[i+1]||A[i+2]!==B[i+2]){ diffs++; if(diffs>20) break; } }
      if(diffs<=20) canvas = overlayTintCanvas(pack.img, target[1], 1.0);

      return { img: canvas, cols: pack.cols };
    }catch{ return pack; }
  }

  // ---- layer order (hair under helm/hat) ----
  const LAYER_ORDER = [ 'body', 'legs', 'arms', 'outfit', 'hair', 'vest', 'helm', 'hat', 'weapon' ];

  // Map your inventory slot/id to sprite folder + name
  function invToLayers(inv, ap){
    const layers = [];

    // base sheets (note: outfit is skipped for female, like core)
    const bodyName = ap.body_type==='female' ? `${ap.sprite_skin}__female_wide` : ap.sprite_skin;
    layers.push({ kind:'body',   name: bodyName, _tint:'body' });
    if(ap.body_type!=='female') layers.push({ kind:'outfit', name: ap.outfit || 'street' });
    layers.push({ kind:'hair',   name: ap.hair   || 'short', _tint:'hair' });

    // Equipped-first: look for entries with slot + equipped
    const slotMap = { head:'helm', chest:'vest', legs:'legs', arms:'arms', hat:'hat' };
    Object.keys(inv||{}).forEach(id=>{
      const e = inv[id];
      if(!e || typeof e!=='object') return;
      const on = !!(e.equipped || e.equip || (e.equippedCount|0)>0);
      if(!on) return;

      // Prefer explicit slot
      const slot = (e.slot||'').toLowerCase();
      const kind = slotMap[slot] || (
        /helmet|helm/i.test(id) ? 'helm' :
        /vest|chest/i.test(id)  ? 'vest' :
        /legs|pants/i.test(id)  ? 'legs' :
        /arms|sleeve/i.test(id) ? 'arms' :
        /hat|crown/i.test(id)   ? 'hat'  : null
      );
      if(!kind) return;

      // Derive sprite name (normalize: “CardboardHelmet” → “cardboard_helm”)
      const base = String(id).replace(/([a-z])([A-Z])/g,'$1_$2').toLowerCase();
      let name = base;
      // common transforms for your sets
      name = name
        .replace(/helmet|_helmet/g,'_helm')
        .replace(/_chest/g,'_vest')
        .replace(/_arms$/,'_arms')
        .replace(/_legs$/,'_legs');

      // If set prefix present (cardboard/pumpkin), prefer "<set>_<part>"
      // e.g. "cardboardHelmet" -> "cardboard_helm"
      if(/cardboard/.test(name)||/pumpkin/.test(name)){
        const set = /cardboard/.test(name) ? 'cardboard' : 'pumpkin';
        const part = (kind==='helm'?'helm':kind);
        name = `${set}_${part}`;
      }

      layers.push({ kind, name });
    });

    // If no explicit weapon via equipped crafted, still show held weapon from core HUD? (skip here)
    layers.sort((a,b)=> LAYER_ORDER.indexOf(a.kind) - LAYER_ORDER.indexOf(b.kind));
    return layers;
  }

  // skinKey = hash of appearance + “equipped view” (so swaps trigger rebuild)
  function makeSkinKey(ap, inv){
    try{
      const eqBits=[];
      Object.keys(inv||{}).forEach(k=>{
        const e=inv[k];
        if(!e||typeof e!=='object') return;
        if(e.slot && (e.equipped||e.equip||(e.equippedCount|0)>0)) eqBits.push(e.slot+':'+k);
      });
      eqBits.sort();
      const key = {
        body: ap.body_type+'|'+ap.sprite_skin+'|'+ap.skin_tone+'|'+ap.female_outfit_color,
        hair: ap.hair+'|'+ap.hair_color,
        outfit: ap.outfit,
        eq: eqBits
      };
      return JSON.stringify(key);
    }catch{ return 'default'; }
  }

  const SKIN_CACHE = Object.create(null); // skinKey -> {img, cols}

  async function buildComposite(ap, inv){
    const layers = invToLayers(inv, ap);

    // Load all base sheets (no tint yet)
    const loaded = await Promise.all(layers.map(l=> loadLayer(l.kind, l.name)));
    // Apply tints on the fly to *matching* layers
    for(let i=0;i<layers.length;i++){
      const meta = layers[i];
      if(!loaded[i] || !loaded[i].img) continue;
      if(meta._tint==='body') loaded[i] = tintBodyLayer(loaded[i], ap);
      else if(meta._tint==='hair') loaded[i] = tintHairLayer(loaded[i], ap);
    }

    const cols = Math.max(1, ...loaded.map(x=>x?.cols||1));
    const cvs = document.createElement('canvas');
    cvs.width  = cols*FRAME_W;
    cvs.height = ROWS*FRAME_H;
    const ctx = cvs.getContext('2d');
    ctx.imageSmoothingEnabled = false;

    for(let row=0; row<ROWS; row++){
      for(let col=0; col<cols; col++){
        const dx = col*FRAME_W, dy = row*FRAME_H;
        for(let i=0;i<layers.length;i++){
          const lay = loaded[i];
          if(!lay || !lay.img) continue;
          const srcCol = Math.min(col, (lay.cols||1)-1);
          ctx.drawImage(lay.img, srcCol*FRAME_W, row*FRAME_H, FRAME_W, FRAME_H, dx, dy, FRAME_W, FRAME_H);
        }
      }
    }
    return { img:cvs, cols };
  }

  async function getComposite(ap, inv){
    const skinKey = makeSkinKey(ap, inv);
    if(SKIN_CACHE[skinKey]) return SKIN_CACHE[skinKey];
    // Build lazily; placeholder entry avoids flicker
    const ph = SKIN_CACHE[skinKey] = { img:null, cols:1, _pending:true };
    buildComposite(ap, inv)
      .then(c=>{ SKIN_CACHE[skinKey] = c; })
      .catch(()=>{ /* keep placeholder */ })
      .finally(()=>{ ph._pending=false; });
    return ph;
  }

  // ---------- INTERPOLATION BUFFER (slightly larger for smoothness) ----------
  const BUFFER_MS = 180;
  const STALE_MS  = 5000;
  const MAX_SNAP  = 24;

  function pushSnap(rp, x, y, facing){
    const t = Date.now();
    const last = rp.buf[rp.buf.length-1];
    // dedupe identical snaps
    if(last && last.x===x && last.y===y && last.facing===facing) { rp.lastPacket=t; return; }
    rp.buf.push({t, x, y, facing});
    if(rp.buf.length>MAX_SNAP) rp.buf.splice(0, rp.buf.length-MAX_SNAP);
    rp.lastPacket = t;
  }
  function sampleBuffered(rp, now){
    const target = now - BUFFER_MS;
    const b = rp.buf;
    if(!b.length){
      return { x:rp.x, y:rp.y, facing:rp.facing };
    }
    let i=b.length-1;
    while(i>0 && b[i-1].t>target) i--;
    const a = b[Math.max(0,i-1)];
    const c = b[i];
    if(!a || !c){ return { x:c?.x??rp.x, y:c?.y??rp.y, facing:c?.facing??rp.facing }; }
    if(c.t===a.t){ return { x:c.x, y:c.y, facing:c.facing }; }
    const t = (target - a.t) / (c.t - a.t);
    const lerp=(p,q)=> p + (q-p)*Math.max(0,Math.min(1,t));
    return { x: lerp(a.x,c.x), y: lerp(a.y,c.y), facing: (t>0.5?c.facing:a.facing) };
  }

  // ---------- remote struct ----------
  function makeRemote(opts){
    const rp = {
      username: (opts && opts.username) || 'player',
      ap: (opts && opts.appearance) || readAppearance(),
      inv: (opts && opts.inv) || {},
      x: +((opts && opts.x) ?? 0), y: +((opts && opts.y) ?? 0),
      facing: (opts && opts.facing) || 'down',
      buf: [], lastPacket: 0,
      composite: { img:null, cols:1 }, compositeKey:'',
      lastGoodComposite: null,
      _bodyOnly: null
    };
    rp.compositeKey = makeSkinKey(rp.ap, rp.inv);
    getComposite(rp.ap, rp.inv).then(c=>{ rp.composite = c; if(c && c.img) rp.lastGoodComposite = c; });
    // prepare body-only tinted fallback
    (async ()=>{
      const bodyName = rp.ap.body_type==='female' ? `${rp.ap.sprite_skin}__female_wide` : rp.ap.sprite_skin;
      const raw = await loadLayer('body', bodyName) || emptyLayer();
      const tin = tintBodyLayer(raw, rp.ap);
      rp._bodyOnly = tin;
    })();
    pushSnap(rp, rp.x, rp.y, rp.facing);
    return rp;
  }

  function upsertRemote(p){
    const u = String(p?.username||'').trim(); if(!u) return;
    let rp = byName[u];
    if(!rp){ rp = byName[u] = makeRemote(p); REMOTES.push(rp); }

    if (typeof p.x==='number' || typeof p.y==='number'){
      pushSnap(rp, (p.x??rp.x), (p.y??rp.y), p.facing||rp.facing);
      rp.x = p.x??rp.x; rp.y = p.y??rp.y;
    }
    if (p.facing) rp.facing = p.facing;

    if (p.appearance) rp.ap = p.appearance;
    if (p.inv)        rp.inv = p.inv;

    const key = makeSkinKey(rp.ap, rp.inv);
    if(key !== rp.compositeKey){
      rp.compositeKey = key;
      getComposite(rp.ap, rp.inv).then(c=>{ rp.composite = c; if(c && c.img) rp.lastGoodComposite = c; });
    }
  }

  function pruneStale(now){
    for(let i=REMOTES.length-1;i>=0;i--){
      const rp=REMOTES[i];
      if(now - (rp.lastPacket||0) > STALE_MS){
        REMOTES.splice(i,1); delete byName[rp.username];
      }
    }
  }

  // ---------- renderer ----------
  function installRenderer(){
    if(window.__REMOTE_RENDER_INSTALLED__) return;
    window.__REMOTE_RENDER_INSTALLED__ = true;

    IZZA.on('render-post', ({ now })=>{
      try{
        const api = IZZA.api; if(!api || !api.ready) return;
        if(!isMPWorld()) return;

        pruneStale(now);

        const cvs = document.getElementById('game'); if(!cvs) return;
        const ctx = cvs.getContext('2d');
        const S=api.DRAW, scale=S/api.TILE;

        ctx.save(); ctx.imageSmoothingEnabled=false;

        for(const p of REMOTES){
          const snap = sampleBuffered(p, now);
          const sx=(snap.x - api.camera.x)*scale, sy=(snap.y - api.camera.y)*scale;
          const row = DIR_INDEX[snap.facing] || 0;

          // Prefer current composite, else last-good, else tinted body, else small box
          let comp = (p.composite && p.composite.img) ? p.composite : (p.lastGoodComposite || null);
          if(comp && comp.img){
            const cols = Math.max(1, comp.cols|0);
            const t = Math.floor(now/120)%cols;
            ctx.drawImage(comp.img, t*FRAME_W, row*FRAME_H, FRAME_W, FRAME_H, sx, sy, S, S);
          }else if(p._bodyOnly && p._bodyOnly.img){
            const cols = Math.max(1, p._bodyOnly.cols|0);
            const t = Math.floor(now/120)%cols;
            ctx.drawImage(p._bodyOnly.img, t*FRAME_W, row*FRAME_H, FRAME_W, FRAME_H, sx, sy, S, S);
          }else{
            ctx.fillStyle='rgba(60,90,150,0.85)';
            ctx.fillRect(sx, sy, S, S);
          }

          // nameplate
          ctx.fillStyle = 'rgba(8,12,20,.85)';
          ctx.fillRect(sx + S*0.02, sy - S*0.28, S*0.96, S*0.22);
          ctx.fillStyle = '#d9ecff'; ctx.font = (S*0.20)+'px monospace';
          ctx.textAlign='center'; ctx.textBaseline='middle';
          ctx.fillText(p.username||'Opponent', sx + S*0.50, sy - S*0.17, S*0.92);
        }

        ctx.restore();
      }catch(e){}
    });
  }

  // ---------- Modes ----------
  function setMultiplayerMode(on){
    try{
      IZZA?.api?.setMultiplayerMode?.(!!on);

      const nodes = document.querySelectorAll(
        '[data-ui="mission-hud"], #missionHud, .mission-hud, .mission-prompt, [data-ui="mission-prompt"]'
      );
      nodes.forEach(n=> n.style.display = on ? 'none' : '');

      window.dispatchEvent(new CustomEvent('izza-missions-toggle', { detail:{ enabled: !on }}));
    }catch{}
  }

  function setDuelMode(on){
    try{
      const hideSel = [
        '.npc', '[data-npc]', '.pedestrian', '[data-role="npc"]',
        '.cop', '[data-cop]', '.police', '.swat', '.military', '[data-role="cop"]'
      ].join(',');

      document.querySelectorAll(hideSel).forEach(n=>{
        if(on){
          if(!n.dataset._oldVis){ n.dataset._oldVis = n.style.visibility || ''; }
          n.style.visibility = 'hidden';
        }else{
          if('_oldVis' in n.dataset){ n.style.visibility = n.dataset._oldVis; delete n.dataset._oldVis; }
          else n.style.visibility = '';
        }
      });

      window.dispatchEvent(new CustomEvent('izza-duel-toggle', { detail:{ on: !!on }}));
    }catch{}
  }

  // ---------- REST presence poll/push ----------
  let lastRosterTs = 0;
  let tickT=null, rosterT=null, heartbeatT=null;

  async function sendHeartbeat(){
    if(!isMPWorld()) return;
    try{
      const me = (IZZA?.api?.player) || {x:0,y:0,facing:'down'};
      await jpost('/world/heartbeat', {
        x: me.x|0, y: me.y|0, facing: me.facing||'down',
        appearance: readAppearance(),
        inv: readInventory()
      });
    }catch(e){}
  }
  async function sendPos(){
    if(!isMPWorld()) return;
    try{
      const me = (IZZA?.api?.player) || {x:0,y:0,facing:'down'};
      await jpost('/world/pos', { x: me.x|0, y: me.y|0, facing: me.facing||'down' });
    }catch(e){}
  }
  async function pullRoster(){
    if(!isMPWorld()) return;
    try{
      const r = await jget('/world/roster?since=' + encodeURIComponent(lastRosterTs||0));
      if(r && r.ok){
        if(Array.isArray(r.players)){
          r.players.forEach(upsertRemote);
        }
        if(typeof r.serverNow==='number') lastRosterTs = r.serverNow;
      }
    }catch(e){}
  }

  function armTimers(){
    disarmTimers();
    if(!isMPWorld()) return;
    heartbeatT = setInterval(sendHeartbeat, 4000);
    tickT      = setInterval(sendPos,      400);
    rosterT    = setInterval(pullRoster,   600);   // a touch faster than before for steadier buffer
    sendHeartbeat();
    pullRoster();
  }
  function disarmTimers(){
    if(heartbeatT){ clearInterval(heartbeatT); heartbeatT=null; }
    if(tickT){ clearInterval(tickT); tickT=null; }
    if(rosterT){ clearInterval(rosterT); rosterT=null; }
  }

  // Push updated loadout immediately on changes (equipped/crafted/etc)
  function wireLoadoutPushOnce(){
    if (wireLoadoutPushOnce._done) return;
    wireLoadoutPushOnce._done = true;

    const bump = ()=>{ if(!isMPWorld()) return;
      try{
        const me = (IZZA?.api?.player)||{x:0,y:0,facing:'down'};
        jpost('/world/heartbeat', {
          x: me.x|0, y: me.y|0, facing: me.facing||'down',
          appearance: readAppearance(),
          inv: readInventory()
        }).catch(()=>{});
      }catch{}
    };

    ['inventory-changed','armor-equipped','gear-crafted','armor-crafted','resume','izza-inventory-changed']
      .forEach(ev=> { try{ IZZA?.on?.(ev, bump); }catch{} });
    // Also watch localStorage changes from other tabs
    window.addEventListener('storage', (e)=>{ if(e.key==='izzaInventory') bump(); });
  }

  // ---------- public bridge ----------
  const localListeners = Object.create(null);
  function listen(type, cb){ (localListeners[type] ||= []).push(cb); }
  function fanout(type, data){ (localListeners[type]||[]).forEach(fn=>{ try{ fn(data); }catch(e){ console.warn(e); } }); }

  const REMOTE_PLAYERS_API = window.REMOTE_PLAYERS_API = window.REMOTE_PLAYERS_API || {
    send(type, data){
      if(type==='join-world'){
        try{ jpost('/world/join', { world: String(data.world||'1') }); }catch{}
        onWorldChanged(String(data.world||'1'));
      }else if(type==='worlds-counts'){
        jget('/worlds/counts').then(j=> fanout('worlds-counts', j||{})).catch(()=>{});
      }else if(type==='players-get'){
        pullRoster();
      }
    },
    on(type, cb){ listen(type, cb); }
  };

  // ---------- world-change handling ----------
  function onWorldChanged(nextWorld){
    clearRemotePlayers();
    if(nextWorld==='solo'){
      disarmTimers();
      setMultiplayerMode(false);
      setDuelMode(false);
      return;
    }
    setMultiplayerMode(true);
    setDuelMode(false);
    lastRosterTs = 0;
    armTimers();
  }

  try{ IZZA?.on?.('world-changed', ({ world })=> onWorldChanged(world)); }catch{}
  window.addEventListener('storage', (ev)=>{
    if (ev.key==='izzaWorldId'){
      onWorldChanged(String(ev.newValue||'solo'));
    }
  });

  // ---------- Duel wiring ----------
  (function wireDuelToggles(){
    try{ IZZA?.on?.('mp-start',  ()=> setDuelMode(true)); }catch{}
    try{ IZZA?.on?.('mp-finish', ()=> setDuelMode(false)); }catch{}
    try{ IZZA?.on?.('duel-round-start',   ()=> setDuelMode(true)); }catch{}
    try{ IZZA?.on?.('duel-match-finish',  ()=> setDuelMode(false)); }catch{}
  })();

  // ---------- renderer + boot ----------
  function installPublicAPI(){
    if(!window.IZZA || !IZZA.api) return;
    IZZA.api.remotePlayers = REMOTES;
    if(!IZZA.api.clearRemotePlayers) IZZA.api.clearRemotePlayers = clearRemotePlayers;
    if(!IZZA.api.getAppearance) IZZA.api.getAppearance = readAppearance;
    if(!IZZA.api.getInventorySnapshot) IZZA.api.getInventorySnapshot = readInventory;
    IZZA.api.setDuelMode = setDuelMode;
  }

  function boot(){
    installPublicAPI();
    installRenderer();
    wireLoadoutPushOnce();
    onWorldChanged(getWorld());
  }

  if(window.IZZA && IZZA.on){
    IZZA.on('ready', boot);
  }else if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded', boot, { once:true });
  }else{
    boot();
  }
})();
