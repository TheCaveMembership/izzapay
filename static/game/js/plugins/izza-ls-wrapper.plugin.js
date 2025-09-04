// izza-ls-wrapper.plugin.js
(function(){
  const ok = (()=>{ try{
    const T='__ls_probe__'+Math.random().toString(36).slice(2);
    localStorage.setItem(T,'1'); localStorage.removeItem(T);
    return true;
  }catch(e){ return false; }})();

  window.__LS__ = {
    get(k, def=null){ try{ const v=localStorage.getItem(k); return v==null?def:v; }catch(e){ return def; } },
    set(k, v){ try{ localStorage.setItem(k, v); return true; }catch(e){ return false; } },
    jsonGet(k, def){ try{ const v=localStorage.getItem(k); return v==null?def:JSON.parse(v); }catch(e){ return def; } },
    jsonSet(k, obj){ try{ localStorage.setItem(k, JSON.stringify(obj)); return true; }catch(e){ return false; } }
  };

  // Gentle on-screen hint if storage is not writable (iOS private mode / storage pressure)
  function bootMsg(txt, color){
    try{
      let el=document.getElementById('bootMsg'); if(!el){ el=document.createElement('div'); el.id='bootMsg';
        Object.assign(el.style,{position:'fixed',left:'12px',top:'48px',zIndex:9999,background:'rgba(10,12,18,.92)',
          border:'1px solid #394769',color:'#cfe0ff',padding:'6px 8px',borderRadius:'8px',fontSize:'12px',maxWidth:'74vw',pointerEvents:'none'});
        document.body.appendChild(el);
      }
      el.style.display='block'; el.style.borderColor=color||'#ffd23f'; el.textContent=txt;
      clearTimeout(el._t); el._t=setTimeout(()=>el.style.display='none', 4500);
    }catch(e){}
  }

  if(!ok){
    bootMsg('Storage is restricted. Progress may not save.', '#ff6b6b');
  }
})();
