/* plugin.tier2_border_gates_plus.compat.js
   Tier 2 border gates + 6 missions (Armory, Race, Offroad, Harbor, Hacker, Rooftops)
   Compatible with izza_core_v3.js (no custom bus topics; only ready/update/render hooks).
   Renders all new sprites via inline SVG → <canvas> (no external assets).
*/
(function(){
  // ==================== Persistence ====================
  const KEY_TIER   = 'izzaMapTier';                   // '2'..'6'
  const KEY_GEAR   = 'izzaGear';                      // { armorLevel:0..5, equipped:bool }
  const KEY_SKILLS = 'izzaSkills';                    // { sprint,dodge,melee,nitro,emp,grapple,offroad,drone,regen,arena_boost }
  const KEY_PROG   = 'izzaMissionProg';               // per-mission counters { armory:{hides:{...}}, race:{laps}, offroad:{idx}, harbor:{caught}, hacker:{planted}, roofs:{best} }

  if(!localStorage.getItem(KEY_TIER))   localStorage.setItem(KEY_TIER,'2');
  if(!localStorage.getItem(KEY_GEAR))   localStorage.setItem(KEY_GEAR, JSON.stringify({armorLevel:0,equipped:false}));
  if(!localStorage.getItem(KEY_SKILLS)) localStorage.setItem(KEY_SKILLS, JSON.stringify({
    sprint:false, dodge:false, melee:false, nitro:false, emp:false, grapple:false, offroad:false, drone:false, regen:false, arena_boost:false
  }));
  if(!localStorage.getItem(KEY_PROG))   localStorage.setItem(KEY_PROG, JSON.stringify({}));

  const T = ()=> parseInt(localStorage.getItem(KEY_TIER)||'2',10);
  const S = ()=> JSON.parse(localStorage.getItem(KEY_SKILLS)||'{}');
  const G = ()=> JSON.parse(localStorage.getItem(KEY_GEAR)||'{}');
  const P = ()=> JSON.parse(localStorage.getItem(KEY_PROG)||'{}');
  const setTier = n => localStorage.setItem(KEY_TIER, String(n));
  const saveSkills = sk => localStorage.setItem(KEY_SKILLS, JSON.stringify(sk));
  const saveGear = g => localStorage.setItem(KEY_GEAR, JSON.stringify(g));
  const saveProg = pr => localStorage.setItem(KEY_PROG, JSON.stringify(pr));

  // ==================== Runtime state ====================
  let api=null;
  let gates=[];                // computed from Tier-2 unlocked rect
  let bPressed=false, aPressed=false; // edge-trigger flags (consumed in update-post)
  let carryingBox=false;
  let armoryDoor=null;         // {gx,gy}
  let raceLoop=null;           // {cps:[], lap, active}
  let offroad={kiosk:null, cps:[], idx:0, active:false};
  let harbor={cast:null, timing:0, active:false, caught:0};
  let hacker={dc:null, planted:false};
  let roofs={pads:[], running:false, t:0, best:null};
  const beasts=[];             // simple “targets” player can attack to earn hides

  // ==================== SVG → Canvas helpers ====================
  const svgCache = new Map();
  function drawSvg(ctx, svg, x, y, w, h){
    const key = svg;
    let img = svgCache.get(key);
    if(!img){
      img = new Image();
      img.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
      svgCache.set(key, img);
    }
    if(img.complete) ctx.drawImage(img, x, y, w, h);
    // (if not complete yet, the draw will start appearing next frames)
  }
  // Armor icon SVGs
  function armorSVG(level){
    const path = level===0? 'M2,10 L8,2 L22,2 L28,10 L26,22 L4,22 Z' :
                 level===1? 'M4,10 L10,2 L20,2 L26,10 L24,24 L6,24 Z' :
                 level===2? 'M3,9 L11,2 L19,2 L27,9 L25,26 L5,26 Z' :
                 level===3? 'M3,9 L11,2 L19,2 L27,9 L24,27 L6,27 Z' :
                 level===4? 'M2,9 L12,1 L18,1 L28,9 L24,28 L6,28 Z' :
                            'M1,8 L12,0 L18,0 L29,8 L24,29 L6,29 Z';
    const fill = level===0?'#b98e4a' : level===1?'#2f6ea1' : level===2?'#2f9a7a' :
                 level===3?'#6c7a8a' : level===4?'#7c5bd3' : '#d34444';
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 30"><path d="${path}" fill="${fill}" stroke="#111" stroke-width="1"/></svg>`;
  }
  const svgChip = (txt,col)=>`<svg xmlns="http://www.w3.org/2000/svg" width="88" height="32"><rect x="2" y="2" width="84" height="28" rx="10" fill="${col}" stroke="#111"/><text x="44" y="21" font-size="14" text-anchor="middle" fill="#fff" font-family="Arial">${txt}</text></svg>`;
  const svgNitro = ()=>`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 20"><rect x="2" y="3" width="20" height="14" rx="3" fill="#1e88e5" stroke="#111"/><circle cx="24" cy="10" r="6" fill="#90caf9" stroke="#111"/><path d="M24 6 L28 10 L24 14 Z" fill="#1565c0"/></svg>`;
  const svgBuggy = ()=>`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 28"><rect x="6" y="10" width="28" height="10" rx="2" fill="#1f2a38" stroke="#111"/><path d="M8 10 L20 4 L32 10" stroke="#89f7ff" fill="none" stroke-width="2"/><circle cx="12" cy="22" r="5" fill="#000"/><circle cx="28" cy="22" r="5" fill="#000"/></svg>`;
  const svgEMP   = ()=>`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="12" fill="#222" stroke="#0ff"/><path d="M8 16 h16" stroke="#0ff"/><path d="M10 12 h12" stroke="#0ff"/><path d="M10 20 h12" stroke="#0ff"/></svg>`;
  const svgFish  = ()=>`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 18"><ellipse cx="14" cy="9" rx="10" ry="6" fill="#26a69a" stroke="#111"/><path d="M24 9 L34 4 L34 14 Z" fill="#80cbc4" stroke="#111"/></svg>`;
  const svgHook  = ()=>`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 28"><path d="M12 2 v14 c0 3 -2 6 -6 6" stroke="#ccc" fill="none" stroke-width="2"/></svg>`;
  const svgGrapple=()=>`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28"><circle cx="14" cy="14" r="5" fill="#444" stroke="#111"/><path d="M14 2 v7 M14 26 v-7 M2 14 h7 M26 14 h-7" stroke="#999"/></svg>`;
  const svgBox   = ()=>`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 24"><path d="M2 8 L14 2 L26 8 L26 20 L14 22 L2 20 Z" fill="#b98e4a" stroke="#6b4a2f"/></svg>`;
  const svgGate  = ()=>`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 10"><rect x="1" y="2" width="26" height="6" rx="3" fill="#ffd23f" stroke="#8a7300"/></svg>`;

  // ==================== Input taps (B/A) ====================
  function hookInputs(){
    const btnB = document.getElementById('btnB');
    const btnA = document.getElementById('btnA');
    if(btnB) btnB.addEventListener('click', ()=>{ bPressed=true; }, true);
    if(btnA) btnA.addEventListener('click', ()=>{ aPressed=true; }, true);
    window.addEventListener('keydown', e=>{
      const k=e.key.toLowerCase();
      if(k==='b') bPressed=true;
      if(k==='a') aPressed=true;
    }, true);
  }

  // ==================== Boot ====================
  IZZA.on('ready', a=>{
    api=a;
    hookInputs();
    installSkillHooks();
    // prepare mission structures on first run
    const pr = P();
    pr.armory ||= { hides:{cardboard:0,ratty:0,wolf:0,boar:0,raptor:0,dragon:0} };
    pr.race   ||= { laps:0, active:false };
    pr.offroad||= { idx:0, active:false };
    pr.harbor ||= { caught:0 };
    pr.hacker ||= { planted:false };
    pr.roofs  ||= { best:null };
    saveProg(pr);
    // lead-in cardboard box for Tier 2
    if(T()===2) spawnCardboardBoxHint();
  });

  // ==================== Gates: placement & drawing ====================
  function computeGates(){
    const U=api.unlocked;
    const midX=(U.x0+U.x1>>1), midY=(U.y0+U.y1>>1);
    gates = [
      {id:'N',  x0:midX-2, y0:U.y0,   x1:midX+2, y1:U.y0+1, dir:'N',  mission:'armory'},
      {id:'E',  x0:U.x1-1, y0:midY-2, x1:U.x1,   y1:midY+2, dir:'E',  mission:'race'},
      {id:'W',  x0:U.x0,   y0:midY-2, x1:U.x0+1, y1:midY+2, dir:'W',  mission:'offroad'},
      {id:'S',  x0:midX-2, y0:U.y1-1, x1:midX+2, y1:U.y1,   dir:'S',  mission:'harbor'},
      {id:'NE', x0:U.x1-1, y0:U.y0,   x1:U.x1,   y1:U.y0+1, dir:'NE', mission:'hacker'},
      {id:'NW', x0:U.x0,   y0:U.y0,   x1:U.x0+1, y1:U.y0+1, dir:'NW', mission:'roofs'}
    ];
  }

  function drawGates(ctx, k){
    // “Gold glow” bars at gate tiles
    ctx.save();
    ctx.globalAlpha = 0.9;
    for(const g of gates){
      const sx=(g.x0*k - api.camera.x/api.TILE)*api.DRAW, sy=(g.y0*k - api.camera.y/api.TILE)*api.DRAW;
      drawSvg(ctx, svgGate(), sx, sy, api.DRAW*2, api.DRAW*0.5);
    }
    ctx.restore();
  }

  // ==================== Cardboard box lead-in ====================
  let boxPos=null; // {gx,gy}
  function spawnCardboardBoxHint(){
    const U=api.unlocked;
    const spots = [
      {gx:(U.x0+U.x1>>1)-2, gy:U.y0+4},
      {gx:U.x0+5,           gy:(U.y0+U.y1>>1)+3},
      {gx:(U.x0+U.x1>>1)+4, gy:U.y0+6}
    ];
    boxPos = spots[(Math.random()*spots.length)|0];
  }

  function drawBoxIfAny(ctx, k){
    if(!boxPos || T()>2 || carryingBox) return;
    const sx=(boxPos.gx*k - api.camera.x/api.TILE)*api.DRAW, sy=(boxPos.gy*k - api.camera.y/api.TILE)*api.DRAW;
    drawSvg(ctx, svgBox(), sx, sy, api.DRAW, api.DRAW*0.9);
  }

  // ==================== ARMORY UI (in-DOM modal) ====================
  function openArmoryUI(){
    const pr=P(), g=G(), h=pr.armory.hides;
    const wrap = document.getElementById('pluginArmory') || (()=>{ const d=document.createElement('div'); d.id='pluginArmory'; Object.assign(d.style,{position:'fixed',inset:'0',background:'rgba(0,0,0,.55)',zIndex:9998,display:'flex',alignItems:'center',justifyContent:'center'}); document.body.appendChild(d); return d;})();
    wrap.innerHTML = `
    <div style="background:#0f1520;border:1px solid #394769;border-radius:12px;padding:14px;min-width:320px;max-width:520px">
      <h3 style="margin:0 0 8px 0">Armory</h3>
      <div style="font-size:12px;opacity:.9;margin-bottom:8px">Hides — Cardboard ${h.cardboard} · Ratty ${h.ratty} · Wolf ${h.wolf} · Boar ${h.boar} · Raptor ${h.raptor} · Dragon ${h.dragon}</div>
      ${armorRow('Cardboard Vest','cardboard',0,g,true)}
      ${armorRow('Kevlar I','kevlar1',1,g,T()>=3)}
      ${armorRow('Street Kevlar II','kevlar2',2,g,T()>=3)}
      ${armorRow('Composite III','composite3',3,g,T()>=3)}
      ${armorRow('Scale IV','scale4',4,g,T()>=4)}
      ${armorRow('Dragon V','dragon5',5,g,T()>=5)}
      ${equipRow(g)}
      <div style="display:flex;justify-content:flex-end;margin-top:8px">
        <button id="armoryClose" style="padding:6px 10px;background:#263042;color:#cfe0ff;border:1px solid #394769;border-radius:8px">Close</button>
      </div>
    </div>`;
    wrap.onclick = (e)=>{ if(e.target.id==='pluginArmory' || e.target.id==='armoryClose') wrap.remove(); };
    wrap.querySelectorAll('.craft').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const key=btn.getAttribute('data-key'), lvl=parseInt(btn.getAttribute('data-level'),10);
        craftArmor(key,lvl); openArmoryUI(); // refresh
      });
    });
    const eq = document.getElementById('equipArmor');
    const uq = document.getElementById('unequipArmor');
    if(eq) eq.onclick=()=>{ setEquipped(true); openArmoryUI(); };
    if(uq) uq.onclick=()=>{ setEquipped(false); openArmoryUI(); };
  }
  const COST={ cardboard:{cardboard:1}, kevlar1:{ratty:4}, kevlar2:{wolf:6}, composite3:{boar:8}, scale4:{raptor:10}, dragon5:{dragon:12} };
  function armorRow(label,key,level,g,unlocked){
    const pr=P(), h=pr.armory.hides, ok=unlocked && canAfford(h,COST[key]) && g.armorLevel<level;
    const btn= ok? `<button class="craft" data-key="${key}" data-level="${level}" style="padding:6px 10px;background:#2a3a55;color:#fff;border:1px solid #394769;border-radius:8px">Craft</button>`
                  : `<button disabled style="padding:6px 10px;background:#1a2233;color:#888;border:1px solid #29344a;border-radius:8px">Craft</button>`;
    const svg = armorSVG(level);
    return `<div style="display:flex;align-items:center;gap:10px;margin:6px 0">
      <span style="width:44px;height:36px;display:inline-block">${svg}</span>
      <div style="flex:1"><b>${label}</b><br><small>Cost ${costText(COST[key])}</small></div>
      ${btn}
    </div>`;
  }
  function equipRow(g){
    if(g.armorLevel<=0) return `<p style="margin:6px 0">No armor owned yet</p>`;
    const eq=g.equipped;
    const chip = svgChip(eq?'EQUIPPED':'UNEQUIPPED', eq?'#2e7d32':'#6d4c41');
    return `<div style="display:flex;align-items:center;gap:10px;margin-top:6px">
      <span style="width:88px;height:32px;display:inline-block">${chip}</span>
      <div style="flex:1">Equipped: <b>${armorName(g.armorLevel)}</b></div>
      <button id="${eq?'unequipArmor':'equipArmor'}" style="padding:6px 10px;background:#2a3a55;color:#fff;border:1px solid #394769;border-radius:8px">${eq?'Unequip':'Equip'}</button>
    </div>`;
  }
  function canAfford(h,c){ return Object.keys(c).every(k=> (h[k]|0)>=c[k]); }
  function spend(h,c){ Object.keys(c).forEach(k=> h[k]-=c[k]); }
  function costText(o){ return Object.entries(o).map(([k,v])=>`${k}:${v}`).join(', '); }
  function armorName(l){ return l===0?'Cardboard Vest':l===1?'Kevlar I':l===2?'Street Kevlar II':l===3?'Composite III':l===4?'Scale IV':'Dragon V'; }
  function craftArmor(key, lvl){
    const pr=P(); const g=G(); const h=pr.armory.hides; const cost=COST[key];
    if(g.armorLevel>=lvl){ toast('You already own equal or better armor'); return; }
    if(lvl===0 && !carryingBox){ toast('Carry the cardboard box into the armory first'); return; }
    if(!canAfford(h,cost)){ toast('Not enough materials'); return; }
    spend(h,cost); saveProg(pr);
    if(lvl===0){ carryingBox=false; toast('Cardboard Vest crafted'); }
    saveGear({armorLevel:lvl, equipped:true});
    // expand tiers on milestones
    if(T()<3){ setTier(3); toast('Tier 3 unlocked'); }
    if(lvl>=2 && T()<4){ setTier(4); toast('Tier 4 unlocked'); }
    if(lvl>=4 && T()<5){ setTier(5); toast('Tier 5 unlocked'); }
  }
  function setEquipped(on){ const g=G(); if(g.armorLevel<=0){ toast('No armor to equip'); return; } saveGear({armorLevel:g.armorLevel, equipped:on}); toast(on?'Armor equipped':'Armor unequipped'); }

  // ==================== Damage reduction hook ====================
  IZZA.on('update-pre', ()=>{
    // core calls damage in its own systems; we just clamp once per frame if needed
    // (if you want per-hit scaling, wire in your guns plugin to call a shared "damage:incoming")
  });
  function damageReduce(amount){
    const g=G(); if(!g.equipped) return amount;
    const lvl=g.armorLevel|0;
    const pct = lvl===0?0.05 : lvl===1?0.20 : lvl===2?0.30 : lvl===3?0.40 : lvl===4?0.50 : 0.60;
    return Math.max(1, Math.round(amount*(1-pct)));
  }
  // (if you have a central damage call, wrap it there; otherwise this helper is available)

  // ==================== Skill hooks ====================
  function installSkillHooks(){
    // Nitro via button A while driving (boost hint; your core calls drawVehicle internally)
    const btnA = document.getElementById('btnA');
    if(btnA) btnA.addEventListener('click', ()=>{
      if(!S().nitro || !api.driving) return;
      try{ toast('Nitro!'); }catch{}
      // You can add speed scalar into your car physics if exposed; here we simply “nudge” camera to feel the kick.
      api.camera.x += Math.cos((api.player.angle||0)) * 12;
      api.camera.y += Math.sin((api.player.angle||0)) * 12;
    }, true);
  }

  // ==================== Missions ====================
  function startMissionForGate(g){
    switch(g.mission){
      case 'armory': missionArmoryNorth(g);  break;
      case 'race':   missionStreetRaceEast(g); break;
      case 'offroad':missionOffroadWest(g);  break;
      case 'harbor': missionHarborSouth(g);  break;
      case 'hacker': missionHackerHeistNE(g); break;
      case 'roofs':  missionRooftopParkourNW(g); break;
    }
  }

  function missionArmoryNorth(g){
    ensureBandPainted(g.dir);
    ensureArmory();
    spawnBeastsIfNeeded(g.dir);
    toast('Armory mission active: craft Cardboard, then hunt for hides');
  }
  function ensureArmory(){
    if(armoryDoor) return;
    const U=api.unlocked;
    armoryDoor = { gx: U.x0+10, gy: U.y0-20 };
  }
  function spawnBeastsIfNeeded(dir){
    if(beasts.length) return;
    for(let i=0;i<6;i++){
      const p = randBandPoint(dir);
      beasts.push({gx:p.gx, gy:p.gy, kind: pickBeastKind()});
    }
  }
  function pickBeastKind(){
    if(T()>=5) return Math.random()<0.4?'dragon':'raptor';
    if(T()>=4) return Math.random()<0.5?'boar':'wolf';
    return Math.random()<0.6?'rat':'wolf';
  }

  function missionStreetRaceEast(g){
    ensureBandPainted(g.dir);
    const U=api.unlocked, base=U.x1+8, midY=(U.y0+U.y1>>1);
    raceLoop = { cps:[{gx:base+8,gy:midY-6},{gx:base+22,gy:midY-2},{gx:base+16,gy:midY+6},{gx:base+2,gy:midY+2}], lap:0, idx:0, active:true };
    toast('Street Race: complete 3 laps to unlock NITRO');
  }

  function missionOffroadWest(g){
    ensureBandPainted(g.dir);
    const U=api.unlocked, gx=U.x0-6, gy=(U.y0+U.y1>>1)-2;
    offroad.kiosk = {gx,gy};
    offroad.cps = [0,1,2,3,4].map(i=>({gx:U.x0-12-i*6, gy:gy + ((i%2)?6:-4)}));
    offroad.idx=0; offroad.active=true;
    toast('Off-road Rally: hit all dune checkpoints');
  }

  function missionHarborSouth(g){
    ensureBandPainted(g.dir);
    const U=api.unlocked;
    harbor.cast = {gx:(U.x0+U.x1>>1), gy:U.y1+2};
    harbor.active=false; harbor.timing=0; harbor.caught= P().harbor.caught|0;
    toast('Harbor Derby: tap B near 3.0s to catch 3 rare fish');
  }

  function missionHackerHeistNE(g){
    ensureBandPainted(g.dir);
    const U=api.unlocked;
    hacker.dc = {gx:U.x1+10, gy:U.y0+6}; hacker.planted=false;
    toast('Hacker Heist: B at Data Center to plant EMP, then escape the block');
  }

  function missionRooftopParkourNW(g){
    ensureBandPainted(g.dir);
    const U=api.unlocked;
    roofs.pads=[0,1,2,3,4,5].map(i=>({gx:U.x0-12+(i*4), gy:U.y0-10 - (i%2?2:0)}));
    roofs.running=false; roofs.t=0;
    toast('Rooftop Parkour: reach the last pad under 45s to unlock Grapple');
  }

  // ==================== Update loop: input → logic ====================
  IZZA.on('update-post', ({dtSec})=>{
    if(!api?.ready) return;

    // Build gates every frame (unlocked rect can grow)
    if(!gates.length || (gates._ver!==T())){
      computeGates(); gates._ver=T();
    }

    // consume button presses once per frame
    const takeB = bPressed; bPressed=false;
    const takeA = aPressed; aPressed=false;

    // Box pick up
    if(boxPos && T()===2 && takeB){
      const pg = playerGrid();
      if(pg.gx===boxPos.gx && pg.gy===boxPos.gy){
        carryingBox=true; boxPos=null;
        toast('Picked up cardboard — take it to the North Gate Armory');
      }
    }

    // Interact with a gate (B)
    if(takeB){
      const near = gateAtPlayer();
      if(near){ startMissionForGate(near); }
    }

    // Armory door (B)
    if(armoryDoor && takeB){
      const pg=playerGrid();
      if(Math.abs(pg.gx-armoryDoor.gx)<=1 && Math.abs(pg.gy-armoryDoor.gy)<=1){
        openArmoryUI();
      }
    }

    // Beasts: “attack” to loot
    if(beasts.length && takeA){
      const pg=playerGrid();
      const idx = beasts.findIndex(b=> Math.abs(b.gx-pg.gx)<=1 && Math.abs(b.gy-pg.gy)<=1);
      if(idx>=0){
        const b = beasts.splice(idx,1)[0];
        const pr=P(); pr.armory.hides[b.kind==='rat'?'ratty':b.kind] = (pr.armory.hides[b.kind==='rat'?'ratty':b.kind]|0)+1; saveProg(pr);
        toast(`Collected ${b.kind} hide`);
      }
    }

    // Race loop
    if(raceLoop?.active){
      const pg=playerGrid(), cp=raceLoop.cps[raceLoop.idx];
      if(Math.abs(pg.gx-cp.gx)<=1 && Math.abs(pg.gy-cp.gy)<=1){
        raceLoop.idx=(raceLoop.idx+1)%raceLoop.cps.length;
        if(raceLoop.idx===0){ // lap complete
          raceLoop.lap++;
          toast(`Lap ${raceLoop.lap}/3`);
          if(raceLoop.lap>=3){
            const sk=S(); if(!sk.nitro){ sk.nitro=true; saveSkills(sk); toast('Nitro unlocked'); }
            if(T()<3){ setTier(3); }
            raceLoop.active=false;
          }
        }
      }
    }

    // Offroad checkpoints
    if(offroad.active){
      const pg=playerGrid(), cp=offroad.cps[offroad.idx];
      if(Math.abs(pg.gx-cp.gx)<=1 && Math.abs(pg.gy-cp.gy)<=1){
        offroad.idx++;
        if(offroad.idx>=offroad.cps.length){
          offroad.active=false;
          const sk=S(); if(!sk.offroad){ sk.offroad=true; saveSkills(sk); toast('Off-road handling unlocked'); }
          if(T()<4){ setTier(4); }
        }
      }
    }

    // Harbor timing mini-game
    if(harbor.cast){
      if(harbor.active) { harbor.timing += dtSec; if(harbor.timing>3.6){ harbor.active=false; toast('Missed'); } }
      if(takeB){
        const pg=playerGrid();
        if(Math.abs(pg.gx-harbor.cast.gx)<=1 && Math.abs(pg.gy-harbor.cast.gy)<=1){
          if(!harbor.active){ harbor.active=true; harbor.timing=0; toast('Tap B near 3.0s'); }
          else {
            const d=Math.abs(3.0-harbor.timing);
            harbor.active=false;
            if(d<0.25 || d<0.6){ harbor.caught++; toast(`Fish ${harbor.caught}/3`); const pr=P(); pr.harbor.caught=harbor.caught; saveProg(pr); }
            if(harbor.caught>=3){ const sk=S(); if(!sk.regen){ sk.regen=true; saveSkills(sk); toast('Regen unlocked'); } if(T()<3) setTier(3); }
          }
        }
      }
    }

    // Hacker mission
    if(hacker.dc){
      // simple camera “spot” chance while inside nearby tiles
      const pg=playerGrid();
      if(Math.abs(pg.gx-(hacker.dc.gx-4))<=3 && Math.abs(pg.gy-(hacker.dc.gy-4))<=3){
        if(Math.random()<0.02){ try{ toast('Camera spotted you'); }catch{} }
      }
      if(takeB && Math.abs(pg.gx-hacker.dc.gx)<=1 && Math.abs(pg.gy-hacker.dc.gy)<=1 && !hacker.planted){
        hacker.planted=true; toast('EMP planted — escape 10 tiles away');
      }
      if(hacker.planted){
        if(Math.abs(pg.gx-hacker.dc.gx)>10 || Math.abs(pg.gy-hacker.dc.gy)>10){
          const sk=S(); if(!sk.emp){ sk.emp=true; saveSkills(sk); toast('EMP unlocked'); }
          if(T()<4) setTier(4);
          hacker.dc=null;
        }
      }
    }

    // Rooftops
    if(roofs.pads.length){
      if(!roofs.running && takeB){ roofs.running=true; roofs.t=0; toast('Go!'); }
      if(roofs.running){
        roofs.t += dtSec;
        if(roofs.t>45){ roofs.running=false; toast('Time up'); }
        else {
          const last=roofs.pads[roofs.pads.length-1], pg=playerGrid();
          if(Math.abs(pg.gx-last.gx)<=1 && Math.abs(pg.gy-last.gy)<=1){
            roofs.running=false;
            const sk=S(); if(!sk.grapple){ sk.grapple=true; saveSkills(sk); toast('Grapple unlocked'); }
            if(T()<5) setTier(5);
            const pr=P(); pr.roofs.best = Math.min(pr.roofs.best||999, roofs.t); saveProg(pr);
          }
        }
      }
    }

  });

  // ==================== Render hooks ====================
  IZZA.on('render-under', ()=>{
    if(!api?.ready) return;
    computeGatesIfNeeded();
    const ctx=document.getElementById('game').getContext('2d');
    const k = 1; // grid-to-tile scale used below as gx*k
    // Draw gates glow bars
    drawGates(ctx,k);
    // Draw basic bands (once unlocked they’ll be visible by positions we draw elsewhere)
    drawBandBlocks(ctx);
  });

  IZZA.on('render-post', ()=>{
    if(!api?.ready) return;
    const ctx=document.getElementById('game').getContext('2d');
    const k=1;

    // draw cardboard box (lead-in)
    drawBoxIfAny(ctx,k);

    // armory building marker
    if(armoryDoor){
      const sx=(armoryDoor.gx*k - api.camera.x/api.TILE)*api.DRAW, sy=(armoryDoor.gy*k - api.camera.y/api.TILE)*api.DRAW;
      ctx.save(); ctx.globalAlpha=.95; ctx.fillStyle='#364053'; ctx.fillRect(sx-3*api.DRAW, sy-5*api.DRAW, 8*api.DRAW, 8*api.DRAW); ctx.restore();
    }

    // beasts as little colored circles
    if(beasts.length){
      ctx.save();
      for(const b of beasts){
        const sx=(b.gx*k - api.camera.x/api.TILE)*api.DRAW, sy=(b.gy*k - api.camera.y/api.TILE)*api.DRAW;
        ctx.fillStyle= b.kind==='rat'?'#8d6e63' : b.kind==='wolf'?'#90a4ae' : b.kind==='boar'?'#6d4c41' : b.kind==='raptor'?'#8e24aa' : '#d32f2f';
        ctx.beginPath(); ctx.arc(sx+api.DRAW*0.5, sy+api.DRAW*0.5, api.DRAW*0.35, 0, Math.PI*2); ctx.fill();
      }
      ctx.restore();
    }

    // race & offroad checkpoints
    if(raceLoop?.active){
      for(const cp of raceLoop.cps){
        const sx=(cp.gx*k - api.camera.x/api.TILE)*api.DRAW, sy=(cp.gy*k - api.camera.y/api.TILE)*api.DRAW;
        ctx.strokeStyle='#ffd23f'; ctx.lineWidth=2; ctx.strokeRect(sx,sy,api.DRAW,api.DRAW);
      }
      // show nitro icon on HUD corner
      drawSvg(ctx, svgNitro(), 10, 84, 64, 40);
    }

    if(offroad.active){
      for(let i=offroad.idx;i<offroad.cps.length;i++){
        const cp=offroad.cps[i];
        const sx=(cp.gx*k - api.camera.x/api.TILE)*api.DRAW, sy=(cp.gy*k - api.camera.y/api.TILE)*api.DRAW;
        ctx.strokeStyle='#9c27b0'; ctx.lineWidth=2; ctx.strokeRect(sx,sy,api.DRAW,api.DRAW);
      }
      // kiosk buggy icon
      if(offroad.kiosk){
        const sx=(offroad.kiosk.gx*k - api.camera.x/api.TILE)*api.DRAW, sy=(offroad.kiosk.gy*k - api.camera.y/api.TILE)*api.DRAW;
        drawSvg(ctx, svgBuggy(), sx, sy, api.DRAW*1.8, api.DRAW*1.2);
      }
    }

    // harbor
    if(harbor.cast){
      const sx=(harbor.cast.gx*k - api.camera.x/api.TILE)*api.DRAW, sy=(harbor.cast.gy*k - api.camera.y/api.TILE)*api.DRAW;
      drawSvg(ctx, svgFish(), sx-8, sy-10, api.DRAW*1.6, api.DRAW*0.9);
      drawSvg(ctx, svgHook(), sx+api.DRAW*0.6, sy-8, api.DRAW*0.6, api.DRAW*0.8);
    }

    // hacker
    if(hacker.dc){
      const sx=(hacker.dc.gx*k - api.camera.x/api.TILE)*api.DRAW, sy=(hacker.dc.gy*k - api.camera.y/api.TILE)*api.DRAW;
      ctx.fillStyle='#2f3642'; ctx.fillRect(sx-3*api.DRAW, sy-4*api.DRAW, 7*api.DRAW, 7*api.DRAW);
      drawSvg(ctx, svgEMP(), sx+api.DRAW*0.2, sy-api.DRAW*1.2, api.DRAW*0.9, api.DRAW*0.9);
    }

    // roofs pads
    if(roofs.pads.length){
      ctx.save(); ctx.fillStyle='#66bb6a';
      for(const p of roofs.pads){
        const sx=(p.gx*k - api.camera.x/api.TILE)*api.DRAW, sy=(p.gy*k - api.camera.y/api.TILE)*api.DRAW;
        ctx.fillRect(sx,sy,api.DRAW,api.DRAW*0.4);
      }
      ctx.restore();
      if(roofs.running){
        ctx.fillStyle='#cfe0ff';
        ctx.fillText(`Time: ${roofs.t.toFixed(1)}s`, 10, 140);
      }
      if(P().roofs.best!=null){
        ctx.fillStyle='#cfe0ff'; ctx.fillText(`Best: ${(+P().roofs.best).toFixed(1)}s`, 10, 158);
      }
    }
  });

  function computeGatesIfNeeded(){ if(!gates.length) computeGates(); }

  // ==================== Bands & flavor ====================
  const paintedBands = new Set();
  function ensureBandPainted(dir){
    if(paintedBands.has(dir)) return;
    paintedBands.add(dir);
  }
  function drawBandBlocks(ctx){
    const U=api.unlocked;
    const bands = [
      {dir:'N',  area:{x0:U.x0, y0:U.y0-28, x1:U.x1+96, y1:U.y0-1}},
      {dir:'S',  area:{x0:U.x0-24, y0:U.y1+1, x1:U.x1+24,  y1:U.y1+24}},
      {dir:'E',  area:{x0:U.x1+1,  y0:U.y0-12,x1:U.x1+60,  y1:U.y1+12}},
      {dir:'W',  area:{x0:U.x0-60, y0:U.y0-12,x1:U.x0-1,   y1:U.y1+12}},
      {dir:'NE', area:{x0:U.x1+1,  y0:U.y0-18,x1:U.x1+54,  y1:U.y0+10}},
      {dir:'NW', area:{x0:U.x0-54,y0:U.y0-18,x1:U.x0-1,    y1:U.y0+10}}
    ];
    ctx.save();
    for(const b of bands){
      if(!paintedBands.has(b.dir)) continue; // only draw if mission band has been engaged
      const ox = -api.camera.x/api.TILE*api.DRAW, oy = -api.camera.y/api.TILE*api.DRAW;
      // two simple blocks to give dimension (you already have nice depth in core)
      rectFill(ctx, b.area.x0, b.area.y0, b.area.x0+8,  b.area.y0+8, '#3a4963', ox, oy);
      rectFill(ctx, b.area.x0+12, b.area.y0+10, b.area.x0+20, b.area.y0+18, '#2e3850', ox, oy);
    }
    ctx.restore();
  }
  function rectFill(ctx, gx0,gy0,gx1,gy1, col, ox, oy){
    const x=(gx0*api.DRAW + ox), y=(gy0*api.DRAW + oy), w=(gx1-gx0)*api.DRAW, h=(gy1-gy0)*api.DRAW;
    ctx.fillStyle=col; ctx.fillRect(x,y,w,h);
    // Facade/shadow hint for “dimension”
    ctx.fillStyle='#0d1320a8'; ctx.fillRect(x, y+h*0.7, w, h*0.3);
    ctx.fillStyle='#cfe4ff18'; ctx.fillRect(x, y, w, h*0.06);
    ctx.fillStyle='#00000033'; ctx.fillRect(x+w-2, y, 2, h);
  }

  // ==================== Small helpers ====================
  function playerGrid(){ return { gx: ((api.player.x+16)/api.TILE|0), gy: ((api.player.y+16)/api.TILE|0) }; }
  function gateAtPlayer(){
    const pg=playerGrid();
    return gates.find(g=> pg.gx>=g.x0 && pg.gx<g.x1 && pg.gy>=g.y0 && pg.gy<g.y1);
  }
  function randBandPoint(dir){
    const U=api.unlocked;
    if(dir==='N') return {gx:U.x0+10+(Math.random()*60|0), gy:U.y0-24+(Math.random()*18|0)};
    if(dir==='S') return {gx:U.x0+10+(Math.random()*60|0), gy:U.y1+4+(Math.random()*18|0)};
    if(dir==='E') return {gx:U.x1+4+(Math.random()*40|0),  gy:U.y0+6+(Math.random()*20|0)};
    if(dir==='W') return {gx:U.x0-4-(Math.random()*40|0),  gy:U.y0+6+(Math.random()*20|0)};
    return {gx:U.x0+10+(Math.random()*60|0), gy:U.y0-18+(Math.random()*18|0)};
  }
  function toast(msg, sec){ try{ (window.toast||window.showHint||(()=>{}))(msg, sec||2.2); }catch{} }

})();
