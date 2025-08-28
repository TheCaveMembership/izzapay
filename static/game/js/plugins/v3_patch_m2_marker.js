// v3_patch_m2_marker.js — restore Mission 2 square & start M2 on B
(function(){
  const BUILD = 'v3.patch.m2-marker.v2';
  console.log('[IZZA PATCH]', BUILD);

  // ---- replicate the core geometry so we hit the same tile ----
  const TILE = 32;
  const unlocked = { x0:18, y0:18, x1:72, y1:42 };
  const bW=10, bH=6;
  const bX = Math.floor((unlocked.x0+unlocked.x1)/2) - Math.floor(bW/2);
  const bY = unlocked.y0 + 5;
  const hRoadY       = bY + bH + 1;
  const sidewalkTopY = hRoadY - 1;
  const vRoadX       = Math.min(unlocked.x1-3, bX + bW + 6);
  const vSidewalkRightX = vRoadX + 1;

  // Mission-2 marker location = cashier/register tile
  const MARK_GX = vSidewalkRightX;
  const MARK_GY = sidewalkTopY;

  const promptEl = document.getElementById('prompt');
  const invEl    = document.getElementById('invPanel');
  const miniWrap = document.getElementById('miniWrap');
  const mapModal = document.getElementById('mapModal');
  const btnB     = document.getElementById('btnB');

  const missions = () => parseInt(localStorage.getItem('izzaMissions') || '0', 10);
  const setMissions = n => localStorage.setItem('izzaMissions', String(n|0));

  function uiOpen(){
    // if either inventory or any map is open, don’t show marker/prompt
    const invOpen  = invEl && invEl.style.display !== 'none';
    const miniOpen = miniWrap && miniWrap.style.display !== 'none';
    const bigOpen  = mapModal && mapModal.style.display !== 'none';
    return !!(invOpen || miniOpen || bigOpen);
  }

  function api(){ return (window.IZZA && IZZA.api) || null; }
  function near(ax,ay,bx,by){ return Math.abs(ax-bx) + Math.abs(ay-by) <= 1; }
  function w2s(wx, wy, a){
    const scale = a.DRAW / TILE;
    return { x: (wx - a.camera.x) * scale, y: (wy - a.camera.y) * scale };
  }

  function drawMarker(a){
    if (!a || missions() !== 1 || uiOpen()) return;

    const c = document.getElementById('game'); if(!c) return;
    const ctx = c.getContext('2d');
    const S = a.DRAW;
    const { x:sx, y:sy } = w2s(MARK_GX*TILE, MARK_GY*TILE, a);

    // pulsing blue square
    const t = (performance.now()/550)%1;
    const alpha = 0.35 + 0.35*Math.sin(t*2*Math.PI);
    ctx.save();
    ctx.fillStyle = `rgba(72,164,255,${alpha})`;
    ctx.fillRect(sx + S*0.35, sy + S*0.35, S*0.30, S*0.30);
    ctx.restore();

    // prompt if player is on/adjacent
    const px = Math.floor((a.player.x + TILE/2)/TILE);
    const py = Math.floor((a.player.y + TILE/2)/TILE);
    if(near(px,py, MARK_GX,MARK_GY) && promptEl){
      promptEl.textContent = 'Press B: Mission 2';
      promptEl.style.left  = (sx + S/2) + 'px';
      promptEl.style.top   = (sy - 8) + 'px';
      promptEl.style.display = 'block';
    }
  }

  function toast(msg, seconds=1.8){
    let h = document.getElementById('tutHint');
    if(!h){
      h = document.createElement('div'); h.id='tutHint';
      Object.assign(h.style,{
        position:'fixed', left:'12px', top:'64px', zIndex:7,
        background:'rgba(10,12,18,.85)', border:'1px solid #394769',
        color:'#cfe0ff', padding:'8px 10px', borderRadius:'10px', fontSize:'14px'
      });
      document.body.appendChild(h);
    }
    h.textContent = msg; h.style.display='block';
    clearTimeout(h._t); h._t = setTimeout(()=>{ h.style.display='none'; }, seconds*1000);
  }

  function tryStartM2(){
    const a = api(); if(!a) return false;
    if(missions() !== 1 || uiOpen()) return false;

    const px = Math.floor((a.player.x + TILE/2)/TILE);
    const py = Math.floor((a.player.y + TILE/2)/TILE);
    if(!near(px,py, MARK_GX,MARK_GY)) return false;

    setMissions(2);
    toast('Mission 2 started!');
    return true;
  }

  // intercept B key BEFORE core handles it
  window.addEventListener('keydown', (e)=>{
    if((e.key||'').toLowerCase() !== 'b') return;
    if(tryStartM2()){
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true); // capture

  // intercept the on-screen B button BEFORE core’s click handler
  if(btnB){
    btnB.addEventListener('click', (e)=>{
      if(tryStartM2()){
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    }, true); // capture
  }

  // draw after core render
  const attach = ()=>{
    if(!window.IZZA || typeof IZZA.on!=='function') return false;
    IZZA.on('render-post', ()=>{ try{ drawMarker(api()); }catch(_e){} });
    return true;
  };
  const iv = setInterval(()=>{ if(attach()) clearInterval(iv); }, 50);
})();
