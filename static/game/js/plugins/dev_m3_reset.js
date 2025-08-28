(function(){
  const BUILD='dev-m3-reset-btn';
  console.log('[IZZA PLAY]', BUILD);

  const BTN_ID='m3ResetBtn';
  function makeBtn(){
    if(document.getElementById(BTN_ID)) return;
    const b=document.createElement('button');
    b.id=BTN_ID;
    b.textContent='M3 Reset';
    Object.assign(b.style,{
      position:'fixed', right:'18px', bottom:'118px', zIndex:20,
      padding:'8px 10px', borderRadius:'12px', border:'1px solid #2a3550',
      background:'#0f1625', color:'#cfe0ff', cursor:'pointer', opacity:.9
    });
    b.addEventListener('click', ()=>{
      localStorage.removeItem('izzaMission3'); // mark M3 not done
      localStorage.setItem('izzaMapTier','1'); // shrink map
      const cur=parseInt(localStorage.getItem('izzaMissions')||'0',10);
      if(cur>=3) localStorage.setItem('izzaMissions','2'); // re-lock pistols to test gate
      alert('Mission 3 reset.\nPage will reload…');
      location.reload();
    });
    document.body.appendChild(b);
  }

  // place after game is ready so the DOM exists
  (window.IZZA && IZZA.on) ? IZZA.on('ready', makeBtn) : window.addEventListener('load', makeBtn);
})();
