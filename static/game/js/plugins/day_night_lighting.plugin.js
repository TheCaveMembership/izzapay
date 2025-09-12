/* day_night_lighting.plugin.js — consentless day/night by local clock
   Night has two strengths:
     - "likely night"  around twilight → gentle dim
     - "definitely night" well past dusk or well before dawn → moderate dim
*/
(function(){
  if (!window.IZZA || typeof IZZA.on !== 'function') return;

  // Approx civil dawn/dusk by month, local time, mid-latitudes
  const DAWN_DUSK_BY_MONTH = [
    [7.5, 17.0], [7.0, 18.0], [6.5, 19.0], [6.0, 20.0],
    [5.0, 21.0], [4.8, 21.5], [5.2, 21.0], [5.8, 20.2],
    [6.5, 19.2], [7.0, 18.0], [7.2, 17.2], [7.6, 16.6]
  ];

  // Night intensity seasonal feel, a touch darker in winter
  function seasonIntensity(month){
    if (month===11 || month===0) return 1.0; // Dec, Jan
    if (month===5 || month===6)  return 0.75; // Jun, Jul
    return 0.9;
  }

  // Compute lighting state from local clock
  const STATE = {
    isNight: false,       // boolean
    nightLevel: 0.0,      // 0..1, 0.45 = likely, 1.0 = definite
    dawn: 7.0,
    dusk: 19.0,
    tintA: 0.0,           // actual overlay alpha to use
    vigA:  0.0            // vignette edge alpha
  };

  function recompute(){
    const now = new Date();
    const m   = now.getMonth();
    const h   = now.getHours() + now.getMinutes()/60;
    const [dawn, dusk] = DAWN_DUSK_BY_MONTH[m];
    STATE.dawn = dawn; STATE.dusk = dusk;

    // Twilight band, about 45 minutes
    const TW = 0.75;

    let level = 0.0;
    if (h < dawn - TW || h >= dusk + TW){
      // definitely night
      level = 1.0;
    } else if (h < dawn || h >= dusk){
      // likely night, twilight
      level = 0.45;
    } else {
      level = 0.0;
    }

    STATE.isNight    = level > 0;
    const seasonMul  = seasonIntensity(m);
    const scaled     = level * seasonMul;

    // Keep it tasteful, never too dark
    // gentle base at 0.12, max around 0.22
    STATE.tintA = Math.min(0.12 + 0.12 * scaled, 0.22);
    // vignette is slightly stronger at edges
    STATE.vigA  = Math.min(0.16 + 0.14 * scaled, 0.30);
    STATE.nightLevel = level;
  }

  Object.defineProperty(window, 'IZZA_LIGHT', { value: STATE, writable: false });

  IZZA.on('ready', api=>{
    function drawOverlay(){
      if (!STATE.isNight) return;
      const ctx = api.getOverlayContext ? api.getOverlayContext() : api.ctx;
      if (!ctx) return;
      const w = api.camera?.w || api.DRAW;
      const h = api.camera?.h || Math.round(api.DRAW * 9/16);

      // soft blue wash
      ctx.save();
      ctx.globalAlpha = STATE.tintA;
      ctx.fillStyle = 'rgba(10,14,35,1)';
      ctx.fillRect(0,0,w,h);
      ctx.globalAlpha = 1;

      // vignette
      const g = ctx.createRadialGradient(
        w*0.5, h*0.5, Math.min(w,h)*0.2,
        w*0.5, h*0.5, Math.max(w,h)*0.8
      );
      g.addColorStop(0,'rgba(0,0,0,0)');
      g.addColorStop(1,`rgba(0,0,0,${STATE.vigA})`);
      ctx.fillStyle = g;
      ctx.fillRect(0,0,w,h);
      ctx.restore();
    }

    recompute();
    IZZA.on('draw-post', drawOverlay);
    setInterval(recompute, 60*1000);
  });
})();
