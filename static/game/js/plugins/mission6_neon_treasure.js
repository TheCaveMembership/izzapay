mission6_code_v2 = """\
/* mission6_neon_treasure.plugin.js — Mission 6: Neon Treasure Hunt
   - Trigger object near HQ (neon pedestal)
   - Collect 3 Neon Keys (SVG)
   - Unlock Neon Treasure Chest (SVG)
   - Completion gives 1000 IZZA Coins + Neon Gem item in inventory
   - Unlocks Mission 7
*/
(function(){
  window.__M6_LOADED__ = true;
  if (!window.IZZA) window.IZZA = {};
  if (typeof IZZA.on !== 'function') IZZA.on = function(){};
  if (typeof IZZA.emit !== 'function') IZZA.emit = function(){};

  let api=null;
  const M_ID=6;
  const DONE_KEY="izzaMission6_done";
  const UNLOCK_KEY="izzaMission7_unlocked";
  const COIN_REWARD=1000;

  let active=false, keysCollected=0, chestUnlocked=false;
  const KEYS=[]; // neon keys
  let triggerImg=null, keyImg=null, chestImg=null;

  function _lsSet(k,v){try{localStorage.setItem(k,v);}catch{}}
  function _missions(){try{return parseInt(localStorage.getItem('izzaMissions')||'0',10);}catch{return 0;}}
  function _setMissions(n){const cur=_missions();if(n>cur)_lsSet('izzaMissions',String(n));}

  function invRead(){try{if(IZZA?.api?.getInventory) return JSON.parse(JSON.stringify(IZZA.api.getInventory()||{}));const raw=localStorage.getItem('izzaInventory');return raw? JSON.parse(raw):{};}catch{return{};}}
  function invWrite(inv){try{if(IZZA?.api?.setInventory)IZZA.api.setInventory(inv);else localStorage.setItem('izzaInventory',JSON.stringify(inv||{}));}catch{}try{window.dispatchEvent(new Event('izza-inventory-changed'));}catch{}}
  function addItem(inv,key,name){inv[key]=inv[key]||{count:0,name};inv[key].count=(inv[key].count|0)+1;}

  function hqDoorGrid(){const t=api?.TILE||32;const d=api?.doorSpawn||{x:api?.player?.x||0,y:api?.player?.y||0};return {gx:Math.round(d.x/t),gy:Math.round(d.y/t)};}
  function trigGrid(){const h=hqDoorGrid();return {x:h.gx+7,y:h.gy-2};}

  const _cache=new Map();
  function svgToImage(svg,pxW,pxH){const key=svg+'|'+pxW+'x'+pxH;if(_cache.has(key))return _cache.get(key);const url='data:image/svg+xml;utf8,'+encodeURIComponent(svg);const img=new Image();img.width=pxW;img.height=pxH;img.src=url;_cache.set(key,img);return img;}

  function svgTrigger(){return `<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg"><rect x="40" y="40" width="120" height="120" rx="18" fill="#5b3cff"/><text x="100" y="115" text-anchor="middle" font-family="monospace" font-size="40" font-weight="900" fill="#fff">M6</text></svg>`;}
  function svgKey(){return `<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg"><circle cx="28" cy="40" r="10" stroke="#fff" stroke-width="4" fill="#5b3cff"/><rect x="36" y="38" width="20" height="4" fill="#cfa7ff"/></svg>`;}
  function svgChest(){return `<svg viewBox="0 0 120 80" xmlns="http://www.w3.org/2000/svg"><rect x="10" y="30" width="100" height="40" rx="6" fill="#5b3cff" stroke="#fff" stroke-width="3"/><rect x="10" y="20" width="100" height="20" rx="6" fill="#3a249c"/><circle cx="60" cy="50" r="6" fill="#cfa7ff"/></svg>`;}

  function placeKeys(){KEYS.length=0;const base=trigGrid();const pts=[{tx:base.x+5,ty:base.y+2},{tx:base.x-6,ty:base.y+5},{tx:base.x+8,ty:base.y-6}];for(let i=0;i<3;i++)KEYS.push({tx:pts[i].tx,ty:pts[i].ty,got:false});keyImg=svgToImage(svgKey(),api?.TILE||60,api?.TILE||60);}
  function chestGrid(){const h=hqDoorGrid();return {x:h.gx+3,y:h.gy-4};}

  function renderUnder(){try{if(!api?.ready)return;const ctx=document.getElementById('game')?.getContext('2d');if(!ctx)return;const t=api.TILE,S=api.DRAW;if(!active){const g=trigGrid();const sx=(g.x*t-api.camera.x)*(S/t)+S*0.5;const sy=(g.y*t-api.camera.y)*(S/t)+S*0.58;if(!triggerImg)triggerImg=svgToImage(svgTrigger(),(api.TILE*1.4)|0,(api.TILE*1.4)|0);if(triggerImg?.complete)ctx.drawImage(triggerImg,sx-40,sy-40,80,80);}if(active){for(const k of KEYS){if(!k.got&&keyImg?.complete){const sx=(k.tx*t-api.camera.x)*(S/t)+S*0.5;const sy=(k.ty*t-api.camera.y)*(S/t)+S*0.58;ctx.drawImage(keyImg,sx-20,sy-20,40,40);}}if(!chestUnlocked){if(!chestImg)chestImg=svgToImage(svgChest(),api?.TILE*1.2,api?.TILE*0.8);const g=chestGrid();const sx=(g.x*t-api.camera.x)*(S/t)+S*0.5;const sy=(g.y*t-api.camera.y)*(S/t)+S*0.58;if(chestImg?.complete)ctx.drawImage(chestImg,sx-40,sy-30,80,60);}}}catch{}}

  function onB(e){if(!api?.ready)return;const t=api.TILE;const g=trigGrid();const gx=((api.player.x+16)/t|0),gy=((api.player.y+16)/t|0);if(!active&&gx===g.x&&gy===g.y){e?.preventDefault?.();startMission();return;}for(const k of KEYS){if(!k.got){const cx=k.tx*t+t/2,cy=k.ty*t+t/2;const px=(api.player.x+16),py=(api.player.y+16);if(Math.hypot(px-cx,py-cy)<=t*0.9){k.got=true;keysCollected++;IZZA.toast?.('+1 Neon Key');}}}const chest=chestGrid();const cx=chest.x*t+t/2,cy=chest.y*t+t/2;const px=(api.player.x+16),py=(api.player.y+16);if(!chestUnlocked&&keysCollected>=3&&Math.hypot(px-cx,py-cy)<=t*0.9){unlockChest();}}

  function wireB(){document.getElementById('btnB')?.addEventListener('click',onB,true);window.addEventListener('keydown',e=>{if((e.key||'').toLowerCase()==='b')onB(e);},true);}

  function startMission(){active=true;keysCollected=0;chestUnlocked=false;placeKeys();IZZA.toast?.('Neon Treasure Hunt started — collect 3 Neon Keys and unlock the chest!');}
  function unlockChest(){chestUnlocked=true;finishMission();}

  function finishMission(){active=false;_setMissions(M_ID);try{localStorage.setItem(DONE_KEY,'1');}catch{}try{localStorage.setItem(UNLOCK_KEY,'1');}catch{}try{const coins=IZZA.api.getCoins?IZZA.api.getCoins():0;IZZA.api.setCoins(coins+COIN_REWARD);}catch{}const inv=invRead();addItem(inv,'neon_gem','Neon Gem');invWrite(inv);IZZA.toast?.('Mission 6 Complete — 1000 IZZA Coins + Neon Gem!');}

  IZZA.on?.('render-under',renderUnder);
  IZZA.on?.('ready',a=>{api=a;wireB();});
})();"""

mission6_path_v2 = os.path.join(out_dir,"mission6_neon_treasure.txt")
with open(mission6_path_v2,"w") as f:
    f.write(mission6_code_v2)

