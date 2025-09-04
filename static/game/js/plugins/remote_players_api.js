// Remote Players API — v1.0 (appearance + layered-sprite renderer using core assets)
(function(){
  const BUILD = 'v1.0-remote-players-api';
  console.log('[IZZA PLAY]', BUILD);

  // small helper to load the same sprite layers your core uses (tries "<name> 2.png" then "<name>.png")
  function loadImg(src){
    return new Promise((res)=>{ const i=new Image(); i.onload=()=>res(i); i.onerror=()=>res(null); i.src=src; });
  }
  async function loadLayer(kind, name){
    const base = '/static/game/sprites/' + kind + '/';
    const try2 = await loadImg(base + encodeURIComponent(name + ' 2') + '.png');
    if (try2) return { img: try2, cols: Math.max(1, Math.floor(try2.width / 32)) };
    const try1 = await loadImg(base + encodeURIComponent(name) + '.png');
    if (try1) return { img: try1, cols: Math.max(1, Math.floor(try1.width / 32)) };
    return { img: null, cols: 1 };
  }

  // tiny helpers copied to match your core timing/rows
  const DIR_INDEX = { down:0, left:2, right:1, up:3 };
  const FRAME_W=32, FRAME_H=32, WALK_FPS=8, WALK_MS=1000/WALK_FPS;
  function currentFrame(cols, moving, tMs){ if(cols<=1) return 0; if(!moving) return 1%cols; return Math.floor(tMs/WALK_MS)%cols; }

  const REMOTES = []; // active remote players we draw every frame

  // Expose a read-only appearance getter (from server-injected profile or local fallback)
  function readAppearance(){
    try{
      const p = (window.__IZZA_PROFILE__ || {});
      return {
        sprite_skin: p.sprite_skin || localStorage.getItem('sprite_skin') || 'default',
        hair:        p.hair        || localStorage.getItem('hair')        || 'short',
        outfit:      p.outfit      || localStorage.getItem('outfit')      || 'street'
      };
    }catch{ return { sprite_skin:'default', hair:'short', outfit:'street' }; }
  }

  // Public API shim
  function installPublicAPI(){
    if(!window.IZZA || !IZZA.api) return;

    // 1) IZZA.api.getAppearance()
    if(!IZZA.api.getAppearance){
      IZZA.api.getAppearance = function(){ return readAppearance(); };
    }

    // 2) IZZA.api.addRemotePlayer({ username, appearance })
    if(!IZZA.api.addRemotePlayer){
      IZZA.api.addRemotePlayer = function(opts){
        const rp = {
          username: (opts && opts.username) || 'player',
          appearance: (opts && opts.appearance) || readAppearance(),
          x:0, y:0, facing:'down', moving:false,
          _imgs:null, _cols:{body:1,outfit:1,hair:1}, animTime:0
        };
        // lazy-load sheets
        Promise.all([
          loadLayer('body',   rp.appearance.sprite_skin || 'default'),
          loadLayer('outfit', rp.appearance.outfit      || 'street'),
          loadLayer('hair',   rp.appearance.hair        || 'short')
        ]).then(([b,o,h])=>{
          rp._imgs = { body:b.img, outfit:o.img, hair:h.img };
          rp._cols = { body:b.cols, outfit:o.cols, hair:h.cols };
        });
        REMOTES.push(rp);
        return rp;
      };
    }
  }

  // renderer — draw REMOTES after the core has drawn the world & player
  function installRenderer(){
    if(window.__REMOTE_RENDER_INSTALLED__) return;
    window.__REMOTE_RENDER_INSTALLED__ = true;

    IZZA.on('render-post', ({ now })=>{
      try{
        const api=IZZA.api; if(!api || !api.ready) return;
        const cvs=document.getElementById('game'); if(!cvs) return;
        const ctx=cvs.getContext('2d');
        const S=api.DRAW, scale=S/api.TILE;

        ctx.save(); ctx.imageSmoothingEnabled=false;

        for(const p of REMOTES){
          if(!p || !p._imgs) continue;
          // simple motion check to animate walking
          p._lastX ??= p.x; p._lastY ??= p.y;
          p.moving = (Math.abs(p.x - p._lastX) + Math.abs(p.y - p._lastY)) > 0.5;
          p._lastX = p.x; p._lastY = p.y;
          if(p.moving) p.animTime = (p.animTime||0) + 16; // approx; matches ~60fps draw cadence

          const sx=(p.x - api.camera.x)*scale, sy=(p.y - api.camera.y)*scale;

          // draw layered sprite using the same row/frame logic as the core
          const row = DIR_INDEX[p.facing] || 0;
          const drawLayer = (img, cols)=>{
            if(!img) return;
            const frame = currentFrame(cols, p.moving, p.animTime||0);
            ctx.drawImage(img, frame*FRAME_W, row*FRAME_H, FRAME_W, FRAME_H, sx, sy, S, S);
          };
          drawLayer(p._imgs.body,   p._cols.body);
          drawLayer(p._imgs.outfit, p._cols.outfit);
          drawLayer(p._imgs.hair,   p._cols.hair);

          // nameplate
          ctx.fillStyle = 'rgba(8,12,20,.85)';
          ctx.fillRect(sx + S*0.02, sy - S*0.28, S*0.96, S*0.22);
          ctx.fillStyle = '#d9ecff'; ctx.font = (S*0.20)+'px monospace';
          ctx.textAlign='center'; ctx.textBaseline='middle';
          ctx.fillText(p.username||'Opponent', sx + S*0.50, sy - S*0.17, S*0.92);
        }

        ctx.restore();
      }catch{}
    });
  }

  // wait for core
  if(window.IZZA && IZZA.on){
    IZZA.on('ready', ()=>{ installPublicAPI(); installRenderer(); });
  }else{
    console.warn('remote_players_api: core not ready; include after core.');
    window.addEventListener('DOMContentLoaded', ()=>{ installPublicAPI(); installRenderer(); }, { once:true });
  }
})();
