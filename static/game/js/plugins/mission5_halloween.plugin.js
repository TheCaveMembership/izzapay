/* mission5_halloween.plugin.js
   IZZA Mission 5 — “Night of the Lantern”
   - Unlocks after Mission 4 completes (full cardboard set) → places jack-o’-lantern near HQ.
   - Taking lantern starts 5-minute night run: collect 3 pumpkins + werewolf spawns while moving.
   - Craft “Pumpkin Armour” (helm, vest, arms, legs) at Armoury: total DR ≈ 20%, fast legs.
   - All art/FX inline SVG; no external assets. Graceful fallbacks if engine helpers are missing.
*/
(function(){
  if (!window.IZZA || typeof IZZA.on !== 'function') return;

  // -------------------- handles --------------------
  let api=null, DRAW=null;
  let TILE=60; // fallback
  const NS = 'mission5-halloween';

  // -------------------- tiny armour recipe registry --------------------
  // Lets you quickly add future craftable sets without touching core.
  const ArmourRecipes = {
    pumpkin: {
      needs: { jack_o_lantern:1, pumpkin_piece:3 },
      grants: [
        { id:'armor_pumpkin_helm', qty:1, meta:{ dr:0.05, set:'pumpkin' } },
        { id:'armor_pumpkin_vest', qty:1, meta:{ dr:0.08, set:'pumpkin' } },
        { id:'armor_pumpkin_arms', qty:1, meta:{ dr:0.02, set:'pumpkin' } },
        { id:'armor_pumpkin_legs', qty:1, meta:{ dr:0.05, set:'pumpkin', speed:0.28 } } // near-car speed
      ],
      setMeta: { totalDR:0.20, legSpeed:'car-like' },
      craftedTitle: 'Pumpkin Armour Crafted!'
    }
  };
  function canCraft(setKey){
    const r = ArmourRecipes[setKey]; if (!r) return false;
    return Object.entries(r.needs).every(([id,n])=> invHas(id, n));
  }
  function doCraft(setKey){
    const r = ArmourRecipes[setKey]; if (!r) return false;
    // consume
    Object.entries(r.needs).forEach(([id,n])=> invRemove(id, n));
    // grant
    r.grants.forEach(g=> invAdd(g.id, g.qty||1, g.meta||{}));
    // meta
    try{ api?.gear?.setMeta?.(setKey+'_set', r.setMeta||{}); }catch{}
    return true;
  }

  // -------------------- helpers --------------------
  function emit(ev, payload){ try{ IZZA.emit(ev, payload||{}); }catch(e){} }

  function getHQDoorTile(){
    if (api?.getHQDoorTile){
      const t = api.getHQDoorTile();
      if (t && Number.isFinite(t.tx) && Number.isFinite(t.ty)) return t;
    }
    if (api?.getHQDoor){
      const p = api.getHQDoor();
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)){
        return { tx: Math.round(p.x/TILE), ty: Math.round(p.y/TILE) };
      }
    }
    const b=document.body, tx=Number(b.getAttribute('data-hq-tx')), ty=Number(b.getAttribute('data-hq-ty'));
    if (Number.isFinite(tx) && Number.isFinite(ty)) return {tx,ty};
    return { tx:100, ty:100 };
  }
  function tileToWorld(tx,ty){ return { x:(tx+0.5)*TILE, y:(ty+0.5)*TILE }; }
  function dist(a,b){ const dx=a.x-b.x, dy=a.y-b.y; return Math.hypot(dx,dy); }
  function playerPos(){
    if (api?.player) return { x: api.player.x, y: api.player.y };
    if (api?.getPlayer){ const p=api.getPlayer(); if (p) return {x:p.x,y:p.y}; }
    return { x:0, y:0 };
  }
  function inArmoury(){
    if (api?.inZone) return api.inZone('armoury')===true;
    if (api?.getPOI){ const a=api.getPOI('armoury'); if (a) return dist(playerPos(), a) < 2.2*TILE; }
    return false;
  }

  // inventory fallbacks
  const INV_CACHE={};
  function invHas(id,n){ n=n|0; if(n<=0) return true;
    if (api?.inventory?.count) return (api.inventory.count(id)|0) >= n;
    return (INV_CACHE[id]||0) >= n;
  }
  function invAdd(id,n,meta){ n=n||1;
    if (api?.inventory?.add) api.inventory.add({ id, qty:n, meta: meta||{} });
    else { INV_CACHE[id]=(INV_CACHE[id]||0)+n; emit('inventory-add',{id,qty:n,meta:meta||{}}); }
  }
  function invRemove(id,n){ n=n||1;
    if (api?.inventory?.remove) api.inventory.remove({ id, qty:n });
    else { INV_CACHE[id]=Math.max(0,(INV_CACHE[id]||0)-n); emit('inventory-remove',{id,qty:n}); }
  }

  function uiAgentPopup(title, body){
    if (api?.UI?.popup){ api.UI.popup({ style:'agent', title, body, timeout:2000 }); return; }
    const el=document.createElement('div');
    el.style.cssText='position:absolute;left:50%;top:18%;transform:translateX(-50%);background:rgba(10,12,20,0.92);color:#b6ffec;padding:14px 18px;border:2px solid #36f;border-radius:8px;font-family:monospace;z-index:9999';
    el.innerHTML=`<strong>${title}</strong><div>${body}</div>`;
    (document.getElementById('gameCard')||document.body).appendChild(el);
    setTimeout(()=>el.remove(),2000);
  }
  function missionCompletePopup(n){
    uiAgentPopup('Mission Completed', `You’ve completed mission ${n}.`);
    emit('missions-updated', { completed:n });
    try{ api?.inventory?.setMeta?.('missionsCompleted', n); }catch{}
  }

  // SVG add/remove with safe z-index above canvas
  function addSVG(id, svg, x, y, w, h){
    // Prefer staged DRAW api
    if (DRAW?.addSVG) return DRAW.addSVG({ id, svg, x, y, w, h, layer:'world', anchor:'center', z: 5500 });
    let host=document.getElementById(id);
    if (!host){
      host=document.createElement('div'); host.id=id;
      host.style.position='absolute'; host.style.pointerEvents='none'; host.style.zIndex='5500';
      (document.getElementById('gameCard')||document.body).appendChild(host);
    }
    host.innerHTML=svg;
    host.style.left=(x-w/2)+'px'; host.style.top=(y-h/2)+'px';
    host.style.width=w+'px'; host.style.height=h+'px';
    return host;
  }
  function removeSVG(id){
    if (DRAW?.remove) return DRAW.remove(id);
    const n=document.getElementById(id); if(n&&n.parentNode) n.parentNode.removeChild(n);
  }

  // -------------------- Night overlay --------------------
  let nightOn=false;
  function setNight(on){
    if (on===nightOn) return;
    nightOn=on;
    if (on){
      addOverlay('m5-night','radial-gradient(ellipse at 50% 45%, rgba(0,0,0,0.25) 0%, rgba(0,0,0,0.8) 70%)',5000);
      addOverlay('m5-night-blue','rgba(30,60,120,0.15)',5001,true);
    }else{
      ['m5-night','m5-night-blue'].forEach(id=>{ const n=document.getElementById(id); if(n) n.remove(); });
    }
    emit('world-night-overlay',{on});
  }
  function addOverlay(id, bg, z, isFlat){
    let d=document.getElementById(id);
    if(!d){ d=document.createElement('div'); d.id=id; (document.getElementById('gameCard')||document.body).appendChild(d); }
    Object.assign(d.style,{ position:'absolute', inset:0, pointerEvents:'none', zIndex:String(z) });
    d.style.background = isFlat ? bg : bg;
    d.style.mixBlendMode = isFlat ? 'screen' : 'multiply';
  }

  // -------------------- Mission state --------------------
  let jackPlaced=false, jackId='m5_jack', jackTile=null;
  let pumpkinsPlaced=false;
  const pumpkinIds=['m5_p1','m5_p2','m5_p3'];
  const pumpkinTiles=[];
  let mission5Active=false, mission5StartTime=0;
  const MISSION_MS=5*60*1000;

  let werewolfTimer=0, lastMovePos=null;
  const WEREWOLF_COOLDOWN=30*1000;

  // -------------------- SVGs --------------------
  function svgJackLantern(){ return `
<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
 <defs>
   <radialGradient id="g" cx="50%" cy="50%" r="60%">
     <stop offset="0%" stop-color="#ffb347"/>
     <stop offset="60%" stop-color="#ff7b00"/>
     <stop offset="100%" stop-color="#792900"/>
   </radialGradient>
   <linearGradient id="stem" x1="0" y1="0" x2="0" y2="1">
     <stop offset="0%" stop-color="#3b7a2a"/><stop offset="100%" stop-color="#1f4419"/>
   </linearGradient>
   <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
     <feGaussianBlur stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
   </filter>
 </defs>
 <ellipse cx="100" cy="110" rx="78" ry="70" fill="url(#g)" stroke="#552200" stroke-width="6"/>
 <rect x="92" y="30" width="16" height="28" rx="6" fill="url(#stem)"/>
 <polygon points="60,90 85,110 35,110" fill="#ffd23f" filter="url(#glow)"/>
 <polygon points="140,90 165,110 115,110" fill="#ffd23f" filter="url(#glow)"/>
 <path d="M45 140 Q100 175 155 140 Q140 150 100 155 Q60 150 45 140 Z" fill="#ffd23f" filter="url(#glow)"/>
 <path d="M100 45 V175 M75 50 V170 M125 50 V170" stroke="rgba(255,200,120,0.22)" stroke-width="2"/>
 <g id="haha" opacity="0.95">
   <text x="100" y="80" text-anchor="middle" font-size="22" fill="#ffd23f" style="font-family:'Joker',monospace;">HA HA HA</text>
 </g>
 <animate xlink:href="#haha" attributeName="transform" type="translate" from="0,0" to="0,-40" dur="2.4s" repeatCount="indefinite"/>
 <animate xlink:href="#haha" attributeName="opacity" from="0" to="1" dur="0.2s" begin="0s" fill="freeze"/>
</svg>`;}
  function svgPumpkinSmall(){ return `
<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg">
 <defs>
  <radialGradient id="gp" cx="50%" cy="50%" r="60%"><stop offset="0%" stop-color="#ffb347"/>
  <stop offset="60%" stop-color="#ff7b00"/><stop offset="100%" stop-color="#7a2f00"/></radialGradient>
 </defs>
 <ellipse cx="40" cy="44" rx="28" ry="24" fill="url(#gp)" stroke="#552200" stroke-width="4"/>
 <rect x="35" y="18" width="8" height="10" rx="3" fill="#2c5e22"/>
</svg>`;}
  function svgWerewolf(){ return `
<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg">
 <defs>
  <linearGradient id="fur" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#4c4c4c"/><stop offset="100%" stop-color="#1f1f1f"/></linearGradient>
  <filter id="shadow" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="#000" flood-opacity="0.7"/></filter>
 </defs>
 <circle cx="60" cy="60" r="40" fill="url(#fur)" filter="url(#shadow)"/>
 <polygon points="30,30 45,20 38,42" fill="#2a2a2a"/><polygon points="90,30 75,20 82,42" fill="#2a2a2a"/>
 <circle cx="45" cy="60" r="6" fill="#ffd23f"/><circle cx="75" cy="60" r="6" fill="#ffd23f"/>
 <path d="M38 82 Q60 70 82 82" stroke="#ffd23f" stroke-width="4" fill="none"/>
</svg>`;}
  function svgPumpkinArmorIcon(){ return `
<svg viewBox="0 0 200 160" xmlns="http://www.w3.org/2000/svg">
 <rect x="15" y="20" width="170" height="120" rx="10" fill="#1a1329" stroke="#6c3cff" stroke-width="4"/>
 <g transform="translate(22,12) scale(0.85)">
  <path d="M30 90 L60 40 L140 40 L170 90 L140 110 L60 110 Z" fill="#ff7b00" stroke="#3b1b00" stroke-width="6"/>
  <circle cx="70" cy="78" r="10" fill="#b97fff"/><circle cx="130" cy="78" r="10" fill="#b97fff"/>
  <rect x="92" y="84" width="16" height="6" rx="3" fill="#b97fff"/>
  <polygon points="30,88 12,76 30,70" fill="#b97fff"/><polygon points="170,88 188,76 170,70" fill="#b97fff"/>
  <polygon points="98,28 102,10 106,28" fill="#b97fff"/>
 </g>
</svg>`;}

  // -------------------- placement logic --------------------
  function placeJack(){
    if (jackPlaced) return;

    function _do(){
      if (!api || !api.TILE || !api.camera) return false;
      const hq=getHQDoorTile();
      jackTile = { tx: hq.tx + 5, ty: hq.ty - 4 };
      const w=TILE*3.0, h=TILE*3.0;
      const p=tileToWorld(jackTile.tx, jackTile.ty);
      addSVG(jackId, svgJackLantern(), p.x, p.y, w, h);
      jackPlaced=true;

      // laugh loop every 2.5s
      if (!placeJack.lolTimer){
        placeJack.lolTimer=setInterval(()=> emit('sfx',{kind:'jack-HA',vol:0.6}), 2500);
      }
      return true;
    }
    if(!_do()){ requestAnimationFrame(()=>{ if(!_do()){ setTimeout(_do,120); } }); }
  }
  function removeJack(){
    if (!jackPlaced) return;
    removeSVG(jackId);
    if (placeJack.lolTimer){ clearInterval(placeJack.lolTimer); placeJack.lolTimer=null; }
    jackPlaced=false;
  }

  function computePumpkinTiles(){
    pumpkinTiles.length=0;
    const hq=getHQDoorTile();
    const p1={ tx: hq.tx - 15, ty: hq.ty + 10 };
    const p2={ tx: p1.tx - 20, ty: p1.ty + 13 };
    const p3={ tx: hq.tx + 8,  ty: hq.ty - 13 };
    pumpkinTiles.push(p1,p2,p3);
  }
  function placePumpkins(){
    if (pumpkinsPlaced) return;
    computePumpkinTiles();
    for (let i=0;i<3;i++){
      const id=pumpkinIds[i], t=pumpkinTiles[i], p=tileToWorld(t.tx,t.ty);
      addSVG(id, svgPumpkinSmall(), p.x, p.y, TILE*1.6, TILE*1.6);
    }
    pumpkinsPlaced=true;
  }
  function removePumpkins(){
    if (!pumpkinsPlaced) return;
    for (const id of pumpkinIds) removeSVG(id);
    pumpkinsPlaced=false;
  }

  // -------------------- werewolves --------------------
  function playerIsMoving(){
    const pos=playerPos();
    if(!lastMovePos){ lastMovePos=pos; return false; }
    const d=dist(pos,lastMovePos); lastMovePos=pos; return d>0.35*TILE;
  }
  function spawnWerewolf(){
    const where=playerPos();
    if (api?.spawnNPC){
      api.spawnNPC({
        kind:'werewolf',
        x: where.x + (Math.random()*TILE*2 - TILE),
        y: where.y + (Math.random()*TILE*2 - TILE),
        hostile:true, attackDamage:12, chaseRange:TILE*10,
        onDeath:()=> emit('loot-drop',{kind:'hide_dragon',qty:1})
      });
    }else{
      const id=`m5_w_${Date.now()%1e7}`;
      addSVG(id, svgWerewolf(), where.x, where.y, TILE*2.0, TILE*2.0);
      const born=performance.now();
      const loop=()=>{
        const now=performance.now();
        if(!nightOn || (now-born)>30000){ removeSVG(id); return; }
        const me=document.getElementById(id); if(!me) return;
        if (dist(playerPos(), { x: parseFloat(me.style.left)||where.x, y: parseFloat(me.style.top)||where.y }) < TILE*1.6){
          emit('player-damage',{amount:8, src:'werewolf'});
        }
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    }
    emit('sfx',{kind:'werewolf-spawn',vol:0.8});
  }
  function tickWerewolf(now){
    if (!mission5Active || !nightOn) return;
    if (now >= werewolfTimer){
      if (playerIsMoving()) spawnWerewolf();
      werewolfTimer = now + WEREWOLF_COOLDOWN;
    }
  }

  // -------------------- interactions --------------------
  function nearTile(tx,ty,radPx){ const p=tileToWorld(tx,ty); return dist(playerPos(),p) <= (radPx||TILE*1.2); }
  function onButtonB(){
    if (jackPlaced && nearTile(jackTile.tx, jackTile.ty)){ showNightIntro(); return; }
    if (pumpkinsPlaced){
      for(let i=0;i<3;i++){
        const t=pumpkinTiles[i];
        if (nearTile(t.tx,t.ty,TILE*1.2)){
          const id=pumpkinIds[i]; removeSVG(id);
          invAdd('pumpkin_piece',1);
          emit('toast',{text:'+1 Pumpkin',kind:'loot'});
          pumpkinTiles[i]={tx:99999,ty:99999};
          break;
        }
      }
    }
  }

  function showNightIntro(){
    const title='WELCOME TO IZZA CITY AT NIGHT';
    const body="Avoid the riff raft at night around these parts. Collect all 3 pumpkins within 5 minutes and bring them to the armoury to craft Pumpkin Armour!";
    const opts=[ {id:'take',label:'Take Jack-o’-Lantern'}, {id:'leave',label:'Leave it'} ];
    if (api?.UI?.choice){
      api.UI.choice({ title, body, spooky:true, options:opts, onChoose:(id)=> id==='take' ? acceptNightMission() : null });
    } else {
      if (confirm(title+"\n\n"+body+"\n\nStart Mission 5?")) acceptNightMission();
    }
  }

  function acceptNightMission(){
    invAdd('jack_o_lantern',1);
    emit('celebrate',{style:'spray-skull'});
    setNight(true);
    mission5Active=true;
    mission5StartTime=performance.now();
    removeJack();
    placePumpkins();
    werewolfTimer = mission5StartTime + 500;
    emit('mission-timer',{id:'m5',ms:MISSION_MS,start:mission5StartTime});
    emit('toast',{text:'Mission 5 started: collect 3 pumpkins and craft Pumpkin Armour!',kind:'mission'});
  }

  // -------------------- crafting --------------------
  function tryCraft(setKey){
    if (!mission5Active || !inArmoury()) return false;
    if (!canCraft(setKey)) return false;

    if (!doCraft(setKey)) return false;

    if (api?.UI?.popupSVG) api.UI.popupSVG({ title: ArmourRecipes[setKey].craftedTitle||'Armour Crafted!', svg: svgPumpkinArmorIcon(), timeout:2200 });
    else uiAgentPopup(ArmourRecipes[setKey].craftedTitle||'Armour Crafted!', 'Set bonus applied.');

    // finish mission 5
    mission5Active=false;
    setNight(false);
    removePumpkins();
    missionCompletePopup(5);
    emit('mission-complete',{ id:5, name:'Night of the Lantern' });
    return true;
  }

  // -------------------- wiring --------------------
  IZZA.on('ready', ({ api:__api })=>{
    api=__api||api||{}; DRAW=api?.DRAW||null; TILE=api?.TILE||TILE;
    // (Optional) advertise mission to a central registry if your core supports it
    try { api?.missions?.register?.({ id:5, name:'Night of the Lantern', ns:NS }); } catch {}
  });

  // Mission 4 completion → place lantern (support multiple signal styles)
  IZZA.on('mission-complete', ({id})=>{ if(id===4) placeJack(); });
  IZZA.on('armor-crafted',   ({kind,set})=>{ if(kind==='cardboard'||set==='cardboard') placeJack(); });
  IZZA.on('gear-crafted',    ({kind,set})=>{ if(kind==='cardboard'||set==='cardboard') placeJack(); });

  // Inputs
  IZZA.on('button-B', onButtonB);
  IZZA.on('button-A', ()=>{ if (tryCraft('pumpkin')) emit('sfx',{kind:'craft-complete',vol:0.9}); });
  IZZA.on('armoury-open', ()=>{ tryCraft('pumpkin'); });

  // Ticks
  IZZA.on('update-post', ({now})=>{
    if (!mission5Active) return;
    tickWerewolf(now);
    if ((now - mission5StartTime) > MISSION_MS){
      mission5Active=false; setNight(false); removePumpkins();
      emit('toast',{ text:'Mission 5 failed — time expired.', kind:'fail' });
      setTimeout(placeJack, 800); // allow retry
    }
  });

  // Resume & cleanup
  IZZA.on('resume', ({inventoryMeta})=>{
    const m=(inventoryMeta?.missionsCompleted|0)||0;
    if (m>=4 && !jackPlaced) placeJack();
  });
  IZZA.on('render-ready', ()=>{ if (!jackPlaced) placeJack(); });
  IZZA.on('shutdown', ()=>{ removeJack(); removePumpkins(); setNight(false); });

})();
