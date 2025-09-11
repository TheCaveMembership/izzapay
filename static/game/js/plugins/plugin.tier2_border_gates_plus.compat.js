/* plugin.border_segments.dialog.js
   Directional map expansion: 6 perimeter gates → 6 missions → 6 new districts.
   Popups & dialogue included. Compatible with izza-orientation-landscape.plugin.js (fixed overlay with vw/vh).
*/
(function(){
  if(!window.IZZA || typeof IZZA.on!=='function') return;

  // ---------------- Persistence ----------------
  const KEY_SEG  = 'izzaMapSegments'; // {N,E,S,W,NE,NW}
  const KEY_PROG = 'izzaMissionProg'; // mission states/counters
  const KEY_GEAR = 'izzaGear';        // {armorLevel,equipped}
  const KEY_SK   = 'izzaSkills';      // {nitro,offroad,regen,emp,grapple}
  if(!localStorage.getItem(KEY_SEG))  localStorage.setItem(KEY_SEG, JSON.stringify({N:false,E:false,S:false,W:false,NE:false,NW:false}));
  if(!localStorage.getItem(KEY_PROG)) localStorage.setItem(KEY_PROG, JSON.stringify({armory:{hides:{cardboard:0,ratty:0,wolf:0,boar:0,raptor:0,dragon:0}}, harbor:{caught:0}}));
  if(!localStorage.getItem(KEY_GEAR)) localStorage.setItem(KEY_GEAR, JSON.stringify({armorLevel:0,equipped:false}));
  if(!localStorage.getItem(KEY_SK))   localStorage.setItem(KEY_SK,   JSON.stringify({nitro:false,offroad:false,regen:false,emp:false,grapple:false}));

  const SEG   = ()=> JSON.parse(localStorage.getItem(KEY_SEG)||'{}');
  const saveS = v  => localStorage.setItem(KEY_SEG, JSON.stringify(v));
  const PROG  = ()=> JSON.parse(localStorage.getItem(KEY_PROG)||'{}');
  const saveP = v  => localStorage.setItem(KEY_PROG, JSON.stringify(v));
  const GEAR  = ()=> JSON.parse(localStorage.getItem(KEY_GEAR)||'{}');
  const saveG = v  => localStorage.setItem(KEY_GEAR, JSON.stringify(v));
  const SKILL = ()=> JSON.parse(localStorage.getItem(KEY_SK)||'{}');
  const saveK = v  => localStorage.setItem(KEY_SK, JSON.stringify(v));

  // ---------------- Runtime ----------------
  let api=null, gates=[], B=false, A=false;
  let armoryDoor=null, carryingBox=false, boxPos=null;
  let race=null, offroad=null, harbor=null, hacker=null, roofs=null;
  const beasts=[]; // simple “targets” in the North band
  const openedCorridors=new Set();

  // ---------------- UI: Modal + Toast (orientation-safe) ----------------
  function ensureUIRoots(){
    if(document.getElementById('izzamodal')) return;
    const css = document.createElement('style');
    css.textContent = `
      #izzamodal{position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.55);z-index:9999}
      #izzamodal .card{max-width:min(92vw,540px);width:min(92vw,540px);background:#0e1522;border:1px solid #2f3d58;border-radius:12px;padding:14px;color:#dfe7ff}
      #izzamodal h3{margin:0 0 8px 0;font-size:18px}
      #izzamodal p{margin:6px 0 0 0;line-height:1.25}
      #izzamodal .actions{display:flex;gap:8px;justify-content:flex-end;margin-top:10px}
      #izzamodal button{padding:7px 12px;border-radius:9px;border:1px solid #3a4a6b;background:#24334c;color:#e9f1ff;cursor:pointer}
      #izzamodal button.primary{background:#3756a5}
      #izzatoast{position:fixed;left:50%;bottom:4vh;transform:translateX(-50%);background:#0e1522;border:1px solid #2f3d58;color:#e9f1ff;padding:8px 12px;border-radius:10px;display:none;z-index:9998;max-width:80vw}
    `;
    document.head.appendChild(css);
    const modal=document.createElement('div');
    modal.id='izzamodal';
    modal.innerHTML=`<div class="card"><h3 id="im_title"></h3><div id="im_body"></div><div class="actions" id="im_actions"></div></div>`;
    document.body.appendChild(modal);
    const toast=document.createElement('div'); toast.id='izzatoast'; document.body.appendChild(toast);
    modal.addEventListener('click',e=>{ if(e.target.id==='izzamodal') closeModal(); });
  }
  function openModal(title, htmlBody, actions){
    ensureUIRoots();
    document.getElementById('im_title').textContent=title;
    document.getElementById('im_body').innerHTML=htmlBody;
    const act=document.getElementById('im_actions'); act.innerHTML='';
    (actions||[{label:'OK',primary:true}]).forEach(a=>{
      const b=document.createElement('button'); b.textContent=a.label; if(a.primary) b.classList.add('primary');
      b.onclick=()=>{ if(a.onClick) a.onClick(); closeModal(); };
      act.appendChild(b);
    });
    const m=document.getElementById('izzamodal'); m.style.display='flex';
  }
  function closeModal(){ const m=document.getElementById('izzamodal'); if(m) m.style.display='none'; }
  let toastTimer=null;
  function toast(msg, sec){ ensureUIRoots(); const t=document.getElementById('izzatoast'); t.textContent=msg; t.style.display='block'; clearTimeout(toastTimer); toastTimer=setTimeout(()=>t.style.display='none',(sec||2200)); }

  // ---------------- SVG on-canvas ----------------
  const svgc=new Map();
  function drawSVG(ctx, svg, x,y,w,h){
    let img=svgc.get(svg); if(!img){ img=new Image(); img.src='data:image/svg+xml;utf8,'+encodeURIComponent(svg); svgc.set(svg,img); }
    if(img.complete) ctx.drawImage(img,x,y,w,h);
  }
  const SVG = {
    gate:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 10"><rect x="1" y="2" width="26" height="6" rx="3" fill="#ffd23f" stroke="#8a7300"/></svg>`,
    box:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 24"><path d="M2 8 L14 2 L26 8 L26 20 L14 22 L2 20 Z" fill="#b98e4a" stroke="#6b4a2f"/></svg>`,
    nitro:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 20"><rect x="2" y="3" width="20" height="14" rx="3" fill="#1e88e5" stroke="#111"/><circle cx="24" cy="10" r="6" fill="#90caf9" stroke="#111"/><path d="M24 6 L28 10 L24 14 Z" fill="#1565c0"/></svg>`,
    buggy:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 28"><rect x="6" y="10" width="28" height="10" rx="2" fill="#1f2a38" stroke="#111"/><path d="M8 10 L20 4 L32 10" stroke="#89f7ff" fill="none" stroke-width="2"/><circle cx="12" cy="22" r="5" fill="#000"/><circle cx="28" cy="22" r="5" fill="#000"/></svg>`,
    emp:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="12" fill="#222" stroke="#0ff"/><path d="M8 16 h16" stroke="#0ff"/><path d="M10 12 h12" stroke="#0ff"/><path d="M10 20 h12" stroke="#0ff"/></svg>`,
    fish:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 18"><ellipse cx="14" cy="9" rx="10" ry="6" fill="#26a69a" stroke="#111"/><path d="M24 9 L34 4 L34 14 Z" fill="#80cbc4" stroke="#111"/></svg>`,
    hook:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 28"><path d="M12 2 v14 c0 3 -2 6 -6 6" stroke="#ccc" fill="none" stroke-width="2"/></svg>`
  };
  function armorSVG(level){
    const path = level===0?'M2,10 L8,2 L22,2 L28,10 L26,22 L4,22 Z'
      : level===1?'M4,10 L10,2 L20,2 L26,10 L24,24 L6,24 Z'
      : level===2?'M3,9 L11,2 L19,2 L27,9 L25,26 L5,26 Z'
      : level===3?'M3,9 L11,2 L19,2 L27,9 L24,27 L6,27 Z'
      : level===4?'M2,9 L12,1 L18,1 L28,9 L24,28 L6,28 Z'
      : 'M1,8 L12,0 L18,0 L29,8 L24,29 L6,29 Z';
    const fill = ['#b98e4a','#2f6ea1','#2f9a7a','#6c7a8a','#7c5bd3','#d34444'][level]||'#b98e4a';
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 30"><path d="${path}" fill="${fill}" stroke="#111" stroke-width="1"/></svg>`;
  }

  // ---------------- Helpers ----------------
  const pg   = ()=> ({ gx: ((api.player.x+16)/api.TILE|0), gy: ((api.player.y+16)/api.TILE|0) });
  function tier2Rect(){
    // Use your core-provided unlocked rect if present; otherwise fallback typical Tier-2.
    const R=api.unlocked||{x0:10,y0:12,x1:80,y1:50};
    return {x0:R.x0,y0:R.y0,x1:R.x1,y1:R.y1};
  }
  function computeGates(){
    const U=tier2Rect(); const midX=(U.x0+U.x1>>1), midY=(U.y0+U.y1>>1);
    gates=[
      {id:'N',  x0:midX-2, y0:U.y0-1, x1:midX+2, y1:U.y0,   mission:'armory', title:'North Gate — Armory'},
      {id:'E',  x0:U.x1+0, y0:midY-2, x1:U.x1+1, y1:midY+2, mission:'race',   title:'East Gate — Street Race'},
      {id:'W',  x0:U.x0-1, y0:midY-2, x1:U.x0,   y1:midY+2, mission:'offroad',title:'West Gate — Off-road Rally'},
      {id:'S',  x0:midX-2, y0:U.y1+0, x1:midX+2, y1:U.y1+1, mission:'harbor', title:'South Gate — Harbor Derby'},
      {id:'NE', x0:U.x1+0, y0:U.y0-1, x1:U.x1+1, y1:U.y0,   mission:'hacker', title:'NE Gate — Hacker Heist'},
      {id:'NW', x0:U.x0-1, y0:U.y0-1, x1:U.x0,   y1:U.y0,   mission:'roofs',  title:'NW Gate — Rooftop Parkour'}
    ];
  }
  function gateAtPlayer(){
    const p=pg(); return gates.find(g=> p.gx>=g.x0 && p.gx<g.x1 && p.gy>=g.y0 && p.gy<g.y1);
  }

  // ---------------- Segments (per-side districts) ----------------
  function openSegment(dir){
    const s=SEG(); if(s[dir]) return; s[dir]=true; saveS(s);
    openedCorridors.add(dir); // remember corridor hole while drawing “fences”
    toast(`${dir} district unlocked!`);
  }

  // ---------------- Missions (dialogue included) ----------------
  function startMission(g){
    const s=SEG(); if(s[g.id]){ toast('This district is already open.'); return; }
    // Start popup
    openModal(g.title, missionIntroHTML(g.mission), [{label:'Let’s go',primary:true}]);

    if(g.mission==='armory') missionArmory(g);
    if(g.mission==='race')   missionRace(g);
    if(g.mission==='offroad')missionOffroad(g);
    if(g.mission==='harbor') missionHarbor(g);
    if(g.mission==='hacker') missionHacker(g);
    if(g.mission==='roofs')  missionRoofs(g);
  }
  function missionIntroHTML(kind){
    if(kind==='armory')
      return `<p>Carry the <b>Cardboard Box</b> into the new district and craft a <b>Cardboard Vest</b> ${armorSVG(0)} at the Armory. Then hunt creatures to earn hides for stronger armor.</p><p>Press <b>B</b> to interact. Press <b>A</b> near creatures to strike.</p>`;
    if(kind==='race')
      return `<p>Complete <b>3 laps</b> on the east loop. Unlock <b>Nitro</b> for vehicles.</p>`;
    if(kind==='offroad')
      return `<p>Hit all <b>5 dune checkpoints</b> to prove you can handle the wild.</p>`;
    if(kind==='harbor')
      return `<p>Time your <b>B</b> press near <b>3.0s</b> to catch <b>3 rare fish</b> and unlock <b>Regen</b>.</p>`;
    if(kind==='hacker')
      return `<p>Reach the Data Center, press <b>B</b> to plant the <b>EMP</b>, then <b>escape</b> 10 tiles away.</p>`;
    if(kind==='roofs')
      return `<p>Reach the final roof pad in <b>&lt;45s</b> to unlock the <b>Grapple</b>.</p>`;
    return `<p>Good luck.</p>`;
  }

  // Armory (North)
  function missionArmory(g){
    ensureArmoryNorth(); spawnBeastsIfNeeded('N');
    // Completion: crafting Cardboard Vest triggers opening the North district
    // Handled inside openArmory() → craftArmor()
  }
  function ensureArmoryNorth(){
    if(armoryDoor) return; const U=tier2Rect(); armoryDoor={gx:U.x0+10, gy:U.y0-20};
  }
  function spawnBeastsIfNeeded(dir){
    if(beasts.length) return;
    const U=tier2Rect(); const base={x:U.x0+8,y:U.y0-22};
    for(let i=0;i<6;i++){
      beasts.push({gx:base.x+(i*5), gy:base.y+(i%2?3:-2), kind:(i%3? 'wolf':'boar')});
    }
  }

  // Race (East)
  function buildRaceCps(){ const U=tier2Rect(), base=U.x1+8, my=(U.y0+U.y1>>1); return [{gx:base+8,gy:my-6},{gx:base+22,gy:my-2},{gx:base+16,gy:my+6},{gx:base+2,gy:my+2}]; }
  function missionRace(){ race={lap:0, idx:0, cps:buildRaceCps(), shownTip:false}; }

  // Offroad (West)
  function missionOffroad(){
    const U=tier2Rect(), gy=(U.y0+U.y1>>1)-2;
    offroad={idx:0, cps:[0,1,2,3,4].map(i=>({gx:U.x0-12-i*6, gy:gy + ((i%2)?6:-4)}))};
  }

  // Harbor (South)
  function missionHarbor(){
    const U=tier2Rect(); harbor={cast:{gx:(U.x0+U.x1>>1), gy:U.y1+2}, active:false, t:0, caught: PROG().harbor?.caught||0};
  }

  // Hacker (NE)
  function missionHacker(){
    const U=tier2Rect(); hacker={dc:{gx:U.x1+10, gy:U.y0+6}, planted:false};
  }

  // Rooftops (NW)
  function missionRoofs(){
    const U=tier2Rect(); roofs={pads:[0,1,2,3,4,5].map(i=>({gx:U.x0-12+(i*4), gy:U.y0-10-(i%2?2:0)})), running:false, t:0};
  }

  // ---------------- Armory UI + Crafting ----------------
  function openArmoryUI(){
    const pr=PROG(), g=GEAR();
    const h=pr.armory.hides;
    openModal('Armory',
      `<p>Hides — Cardboard ${h.cardboard} · Ratty ${h.ratty} · Wolf ${h.wolf} · Boar ${h.boar} · Raptor ${h.raptor} · Dragon ${h.dragon}</p>
       <div class="grid">
         ${armorEntry('Cardboard Vest','cardboard',0,g,true)}
         ${armorEntry('Kevlar I','kevlar1',1,g,true)}
         ${armorEntry('Street Kevlar II','kevlar2',2,g,true)}
         ${armorEntry('Composite III','composite3',3,g,true)}
         ${armorEntry('Scale IV','scale4',4,g,true)}
         ${armorEntry('Dragon V','dragon5',5,g,true)}
       </div>
       <p>${g.armorLevel>0?`Equipped: <b>${armorName(g.armorLevel)}</b>`:'No armor owned yet'}</p>`,
      [
        {label:'Craft Cardboard', onClick:()=> craftArmor('cardboard',0), primary:true},
        {label:'Close'}
      ]
    );
  }
  const COST = { cardboard:{cardboard:1}, kevlar1:{ratty:4}, kevlar2:{wolf:6}, composite3:{boar:8}, scale4:{raptor:10}, dragon5:{dragon:12} };
  function armorEntry(label,key,level,g){ return `<div style="display:flex;gap:8px;align-items:center;margin:6px 0"><span style="display:inline-block;width:40px;height:32px">${armorSVG(level)}</span><div style="flex:1"><b>${label}</b><br><small>Cost ${costText(COST[key])}</small></div><button ${g.armorLevel>=level?'disabled':''} data-key="${key}" data-level="${level}">Craft</button></div>`; }
  function armorName(l){ return ['Cardboard Vest','Kevlar I','Street Kevlar II','Composite III','Scale IV','Dragon V'][l]||'Armor'; }
  function costText(o){ return Object.entries(o).map(([k,v])=>`${k}:${v}`).join(', '); }
  function canAfford(h,c){ return Object.keys(c).every(k=> (h[k]|0)>=c[k]); }
  function craftArmor(key, lvl){
    const pr=PROG(), g=GEAR(), h=pr.armory.hides, cost=COST[key];
    if(lvl===0 && !carryingBox){ toast('Carry the cardboard box into the armory first'); return; }
    if(g.armorLevel>=lvl){ toast('You already own equal or better armor'); return; }
    if(!canAfford(h,cost)){ toast('Not enough materials'); return; }
    Object.keys(cost).forEach(k=> h[k]-=cost[k]); saveP(pr);
    saveG({armorLevel:lvl,equipped:true});
    toast(`${armorName(lvl)} crafted`);
    if(lvl===0){ carryingBox=false; // completion popup & open segment
      openModal('North District Opened', `<p>You crafted the <b>Cardboard Vest</b>. The <b>North corridor</b> is open. Hunt creatures for hides and craft stronger armor.</p>`,[{label:'Got it',primary:true}]);
      openSegment('N');
    }
  }

  // ---------------- Input hooks ----------------
  function hookInputs(){
    document.getElementById('btnB')?.addEventListener('click', ()=>B=true, true);
    document.getElementById('btnA')?.addEventListener('click', ()=>A=true, true);
    window.addEventListener('keydown', e=>{ const k=(e.key||'').toLowerCase(); if(k==='b') B=true; if(k==='a') A=true; }, true);
  }

  // ---------------- Boot ----------------
  IZZA.on('ready', a=>{
    api=a;
    hookInputs();
    computeGates();
    ensureUIRoots();
    if(!SEG().N) maybeSpawnBox(); // tutorial lead for north
  });

  // Lead-in Cardboard box
  function maybeSpawnBox(){
    const U=tier2Rect();
    const spots=[ {gx:(U.x0+U.x1>>1)-2, gy:U.y0+4}, {gx:U.x0+5, gy:(U.y0+U.y1>>1)+3}, {gx:(U.x0+U.x1>>1)+4, gy:U.y0+6} ];
    boxPos = spots[(Math.random()*spots.length)|0];
    openModal('Grab the Box',
      `<p>A <b>Cardboard Box</b> is nearby. Pick it up (press <b>B</b>) and carry it to the <b>North Gate</b> to start the <b>Armory</b> mission.</p>`,
      [{label:'Track it',primary:true}]
    );
  }

  // ---------------- Update: gameplay logic ----------------
  IZZA.on('update-post', ({dtSec})=>{
    if(!api) return;
    const takeB=B; B=false; const takeA=A; A=false;
    const pos=pg();

    // Interact with gates
    if(takeB){
      const g=gateAtPlayer();
      if(g) startMission(g);
      // Armory door
      if(armoryDoor && Math.abs(pos.gx-armoryDoor.gx)<=1 && Math.abs(pos.gy-armoryDoor.gy)<=1) openArmoryUI();
      // Box pickup
      if(boxPos && pos.gx===boxPos.gx && pos.gy===boxPos.gy){ carryingBox=true; boxPos=null; toast('Box picked — take it to the North Armory'); }
    }

    // Armory beasts “hit” with A
    if(beasts.length && takeA){
      const idx=beasts.findIndex(b=> Math.abs(b.gx-pos.gx)<=1 && Math.abs(b.gy-pos.gy)<=1);
      if(idx>=0){ const b=beasts.splice(idx,1)[0]; const pr=PROG(); const k=(b.kind==='wolf'?'wolf':b.kind); pr.armory.hides[k]=(pr.armory.hides[k]|0)+1; saveP(pr); toast(`Collected ${k} hide`); }
    }

    // Race
    if(race){
      if(!race.shownTip){ openModal('Race: The Loop', `<p>Hit checkpoints in order. Complete <b>3 laps</b>.</p>`,[{label:'Okay',primary:true}]); race.shownTip=true; }
      const cp=race.cps[race.idx];
      if(Math.abs(pos.gx-cp.gx)<=1 && Math.abs(pos.gy-cp.gy)<=1){
        race.idx=(race.idx+1)%race.cps.length;
        if(race.idx===0){ race.lap++; toast(`Lap ${race.lap}/3`); }
      }
      if(race.lap>=3){
        const k=SKILL(); if(!k.nitro){ k.nitro=true; saveK(k); }
        openModal('East District Opened', `<p>You won the <b>Street Race</b>. <b>Nitro</b> is now available. The <b>East corridor</b> is open.</p>`,[{label:'Nice',primary:true}]);
        openSegment('E'); race=null;
      }
    }

    // Offroad
    if(offroad){
      const cp=offroad.cps[offroad.idx];
      if(Math.abs(pos.gx-cp.gx)<=1 && Math.abs(pos.gy-cp.gy)<=1) offroad.idx++;
      if(offroad.idx>=offroad.cps.length){
        const k=SKILL(); if(!k.offroad){ k.offroad=true; saveK(k); }
        openModal('West District Opened', `<p>You cleared the <b>Off-road Rally</b>. <b>Off-road handling</b> is unlocked. The <b>West corridor</b> is open.</p>`,[{label:'Let me in',primary:true}]);
        openSegment('W'); offroad=null;
      }
    }

    // Harbor timing
    if(harbor){
      if(harbor.active){ harbor.t+=dtSec; if(harbor.t>3.6){ harbor.active=false; toast('Missed'); } }
      if(takeB && Math.abs(pos.gx-harbor.cast.gx)<=1 && Math.abs(pos.gy-harbor.cast.gy)<=1){
        if(!harbor.active){ harbor.active=true; harbor.t=0; toast('Tap B near 3.0s'); }
        else{
          const d=Math.abs(3.0-harbor.t); harbor.active=false;
          if(d<0.25 || d<0.6){ harbor.caught=(harbor.caught||0)+1; const p=PROG(); p.harbor.caught=harbor.caught; saveP(p); toast(`Fish ${harbor.caught}/3`); }
          if(harbor.caught>=3){
            const k=SKILL(); if(!k.regen){ k.regen=true; saveK(k); }
            openModal('South District Opened', `<p>You mastered the <b>Harbor Derby</b>. <b>Regen</b> unlocked. The <b>South corridor</b> is open.</p>`,[{label:'Sail out',primary:true}]);
            openSegment('S'); harbor=null;
          }
        }
      }
    }

    // Hacker
    if(hacker){
      if(takeB && Math.abs(pos.gx-hacker.dc.gx)<=1 && Math.abs(pos.gy-hacker.dc.gy)<=1 && !hacker.planted){
        hacker.planted=true; toast('EMP planted — escape 10 tiles');
      }
      if(hacker.planted && (Math.abs(pos.gx-hacker.dc.gx)>10 || Math.abs(pos.gy-hacker.dc.gy)>10)){
        const k=SKILL(); if(!k.emp){ k.emp=true; saveK(k); }
        openModal('NE District Opened', `<p><b>EMP</b> deployed. <b>EMP gadget</b> unlocked. The <b>NE corridor</b> is open.</p>`,[{label:'Ghost mode',primary:true}]);
        openSegment('NE'); hacker=null;
      }
    }

    // Rooftops
    if(roofs){
      if(!roofs.running && takeB){ roofs.running=true; roofs.t=0; toast('Go!'); }
      if(roofs.running){
        roofs.t+=dtSec;
        if(roofs.t>45){ roofs.running=false; openModal('Try Again', `<p>You ran out of time. Trigger the gate again to retry.</p>`); }
        else{
          const last=roofs.pads[roofs.pads.length-1];
          if(Math.abs(pos.gx-last.gx)<=1 && Math.abs(pos.gy-last.gy)<=1){
            const k=SKILL(); if(!k.grapple){ k.grapple=true; saveK(k); }
            openModal('NW District Opened', `<p>You cleared the <b>Rooftop Parkour</b>. <b>Grapple</b> unlocked. The <b>NW corridor</b> is open.</p>`,[{label:'Swing time',primary:true}]);
            openSegment('NW'); roofs=null;
          }
        }
      }
    }
  });

  // ---------------- Render ----------------
  IZZA.on('render-under', ()=>{
    if(!api) return;
    const ctx=document.getElementById('game').getContext('2d');
    const U=tier2Rect(); const s=SEG();

    // Gold gates (only if that side isn't open)
    for(const g of gates){
      if(s[g.id]) continue;
      const sx=(g.x0*api.DRAW - api.camera.x/api.TILE*api.DRAW);
      const sy=(g.y0*api.DRAW - api.camera.y/api.TILE*api.DRAW);
      drawSVG(ctx, SVG.gate, sx, sy, api.DRAW*2, api.DRAW*0.6);
    }

    // District paints (simple buildings & color splashes in each direction)
    drawDistrict(ctx,'N',s.N, {x0:U.x0, y0:U.y0-28, x1:U.x1+90, y1:U.y0-1}, '#3a4963');
    drawDistrict(ctx,'E',s.E, {x0:U.x1+1, y0:U.y0-12, x1:U.x1+68, y1:U.y1+12}, '#2e3850');
    drawDistrict(ctx,'W',s.W, {x0:U.x0-68, y0:U.y0-12, x1:U.x0-1, y1:U.y1+12}, '#3b435b');
    drawDistrict(ctx,'S',s.S, {x0:U.x0-20, y0:U.y1+1, x1:U.x1+20, y1:U.y1+26}, '#405063');
    drawDistrict(ctx,'NE',s.NE,{x0:U.x1+1, y0:U.y0-18, x1:U.x1+54, y1:U.y0+10}, '#334056');
    drawDistrict(ctx,'NW',s.NW,{x0:U.x0-54, y0:U.y0-18, x1:U.x0-1,  y1:U.y0+10}, '#2d3b53');

    // Cardboard Box marker
    if(boxPos && !SEG().N){
      const sx=(boxPos.gx*api.DRAW - api.camera.x/api.TILE*api.DRAW), sy=(boxPos.gy*api.DRAW - api.camera.y/api.TILE*api.DRAW);
      drawSVG(ctx, SVG.box, sx, sy, api.DRAW, api.DRAW*0.9);
    }
    // Armory building marker
    if(armoryDoor){
      const sx=(armoryDoor.gx*api.DRAW - api.camera.x/api.TILE*api.DRAW), sy=(armoryDoor.gy*api.DRAW - api.camera.y/api.TILE*api.DRAW);
      ctx.fillStyle='#364053'; ctx.fillRect(sx-3*api.DRAW, sy-5*api.DRAW, 8*api.DRAW, 8*api.DRAW);
    }

    // Race checkpoints & HUD icon
    if(race){
      ctx.strokeStyle='#ffd23f'; ctx.lineWidth=2;
      for(const cp of race.cps){
        const sx=(cp.gx*api.DRAW - api.camera.x/api.TILE*api.DRAW), sy=(cp.gy*api.DRAW - api.camera.y/api.TILE*api.DRAW);
        ctx.strokeRect(sx,sy,api.DRAW,api.DRAW);
      }
      drawSVG(ctx, SVG.nitro, 10, 80, 64, 40);
    }
    // Offroad CPs
    if(offroad){
      ctx.strokeStyle='#9c27b0'; ctx.lineWidth=2;
      for(let i=offroad.idx;i<offroad.cps.length;i++){
        const cp=offroad.cps[i];
        const sx=(cp.gx*api.DRAW - api.camera.x/api.TILE*api.DRAW), sy=(cp.gy*api.DRAW - api.camera.y/api.TILE*api.DRAW);
        ctx.strokeRect(sx,sy,api.DRAW,api.DRAW);
      }
      // kiosk buggy icon — optional flair (not interactable)
      const kx=(offroad.cps[0].gx*api.DRAW - api.camera.x/api.TILE*api.DRAW), ky=(offroad.cps[0].gy*api.DRAW - api.camera.y/api.TILE*api.DRAW);
      drawSVG(ctx, SVG.buggy, kx-8, ky-20, api.DRAW*1.8, api.DRAW*1.2);
    }
    // Harbor icons
    if(harbor){
      const sx=(harbor.cast.gx*api.DRAW - api.camera.x/api.TILE*api.DRAW), sy=(harbor.cast.gy*api.DRAW - api.camera.y/api.TILE*api.DRAW);
      drawSVG(ctx, SVG.fish, sx-8, sy-10, api.DRAW*1.6, api.DRAW*0.9);
      drawSVG(ctx, SVG.hook, sx+api.DRAW*0.6, sy-8, api.DRAW*0.6, api.DRAW*0.8);
    }
    // Hacker DC block + EMP icon
    if(hacker){
      const sx=(hacker.dc.gx*api.DRAW - api.camera.x/api.TILE*api.DRAW), sy=(hacker.dc.gy*api.DRAW - api.camera.y/api.TILE*api.DRAW);
      ctx.fillStyle='#2f3642'; ctx.fillRect(sx-3*api.DRAW, sy-4*api.DRAW, 7*api.DRAW, 7*api.DRAW);
      drawSVG(ctx, SVG.emp, sx+api.DRAW*0.2, sy-api.DRAW*1.2, api.DRAW*0.9, api.DRAW*0.9);
    }
    // Rooftop pads
    if(roofs){
      ctx.fillStyle='#66bb6a';
      for(const p of roofs.pads){
        const sx=(p.gx*api.DRAW - api.camera.x/api.TILE*api.DRAW), sy=(p.gy*api.DRAW - api.camera.y/api.TILE*api.DRAW);
        ctx.fillRect(sx,sy,api.DRAW,api.DRAW*0.4);
      }
      ctx.fillStyle='#cfe0ff'; if(roofs.running) ctx.fillText(`Time: ${roofs.t.toFixed(1)}s`, 10, 140);
    }
  });

  function drawDistrict(ctx, dir, open, area, color){
    // Draw “fence” around Tier-2, but leave a corridor if open
    const U=tier2Rect(); const cX = -api.camera.x/api.TILE*api.DRAW, cY = -api.camera.y/api.TILE*api.DRAW;
    // Base buildings for the district once open
    if(open){
      rectDim(ctx, area.x0, area.y0, area.x0+8,  area.y0+8,  color, cX, cY);
      rectDim(ctx, area.x0+12, area.y0+10, area.x0+22, area.y0+18, '#2f3a55', cX, cY);
      rectDim(ctx, area.x0+26, area.y0+6,  area.x0+34, area.y0+14, '#3b4664', cX, cY);
    }
    // Fences (soft glow lines) — skip where corridor is open
    const s=SEG();
    ctx.save(); ctx.globalAlpha=.35; ctx.fillStyle='#ffb300';
    if(dir==='N' && !s.N) ctx.fillRect(U.x0*api.DRAW+cX, (U.y0-1)*api.DRAW+cY, (U.x1-U.x0)*api.DRAW, api.DRAW*0.2);
    if(dir==='S' && !s.S) ctx.fillRect(U.x0*api.DRAW+cX, (U.y1+1)*api.DRAW+cY, (U.x1-U.x0)*api.DRAW, api.DRAW*0.2);
    if(dir==='E' && !s.E) ctx.fillRect((U.x1+1)*api.DRAW+cX, U.y0*api.DRAW+cY, api.DRAW*0.2, (U.y1-U.y0)*api.DRAW);
    if(dir==='W' && !s.W) ctx.fillRect((U.x0-1)*api.DRAW+cX, U.y0*api.DRAW+cY, api.DRAW*0.2, (U.y1-U.y0)*api.DRAW);
    if(dir==='NE' && !s.NE){ ctx.fillRect((U.x1+1)*api.DRAW+cX, (U.y0-1)*api.DRAW+cY, api.DRAW*0.2, api.DRAW*6); ctx.fillRect((U.x1-8)*api.DRAW+cX, (U.y0-1)*api.DRAW+cY, 9*api.DRAW, api.DRAW*0.2); }
    if(dir==='NW' && !s.NW){ ctx.fillRect((U.x0-1)*api.DRAW+cX, (U.y0-1)*api.DRAW+cY, api.DRAW*0.2, api.DRAW*6); ctx.fillRect((U.x0-8)*api.DRAW+cX, (U.y0-1)*api.DRAW+cY, 9*api.DRAW, api.DRAW*0.2); }
    ctx.restore();
  }
  function rectDim(ctx,gx0,gy0,gx1,gy1,col,ox,oy){
    const x=(gx0*api.DRAW+ox), y=(gy0*api.DRAW+oy), w=(gx1-gx0)*api.DRAW, h=(gy1-gy0)*api.DRAW;
    ctx.fillStyle=col; ctx.fillRect(x,y,w,h);
    ctx.fillStyle='#0d1320a8'; ctx.fillRect(x, y+h*0.7, w, h*0.3);
    ctx.fillStyle='#cfe4ff18'; ctx.fillRect(x, y, w, h*0.06);
    ctx.fillStyle='#00000033'; ctx.fillRect(x+w-2, y, 2, h);
  }

  // ---------------- Armory Door & Box positions ----------------
  function nearArmoryDoor(){ const p=pg(); return armoryDoor && Math.abs(p.gx-armoryDoor.gx)<=1 && Math.abs(p.gy-armoryDoor.gy)<=1; }

  // ---------------- Events ----------------
  IZZA.on('ready', a=>{
    // already initialized above; this second hook is harmless if core fires twice
  });

})();
