// izza-diagnostics.plugin.js
(function(){
  function ensureUI(){
    if(document.getElementById('izzaDiagBtn')) return;

    const btn=document.createElement('button');
    btn.id='izzaDiagBtn'; btn.textContent='🛠';
    Object.assign(btn.style,{
      position:'fixed',right:'10px',bottom:'10px',zIndex:99999,
      border:'1px solid #2b3b57',borderRadius:'10px',padding:'6px 8px',
      background:'#111b29',color:'#cfe3ff',fontSize:'16px',opacity:.8
    });
    document.body.appendChild(btn);

    const wrap=document.createElement('div');
    wrap.id='izzaDiagPanel';
    wrap.style.cssText='position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.55);z-index:99998;';
    wrap.innerHTML = `
      <div style="max-width:92vw;width:600px;max-height:80vh;overflow:auto;background:#0f1624;border:1px solid #2b3b57;border-radius:12px;padding:12px;color:#e7eef7">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <strong>IZZA Diagnostics</strong>
          <div style="display:flex;gap:8px;align-items:center">
            <button id="izzaDiagRefresh" style="background:#1f6feb;color:#fff;border:0;border-radius:6px;padding:6px 10px">Refresh</button>
            <button id="izzaDiagClose" style="background:#263447;color:#cfe3ff;border:0;border-radius:6px;padding:6px 10px">Close</button>
          </div>
        </div>
        <div id="izzaDiagBody" style="margin-top:10px;white-space:pre-wrap;font-family:ui-monospace, SFMono-Regular, Menlo, monospace;font-size:12px;line-height:1.3"></div>
        <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
          <button id="izzaDiagMigrate" style="background:#2ea043;color:#fff;border:0;border-radius:6px;padding:6px 10px">Migrate Old Bank Keys</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);

    function CANON(s){ return (s==null?'guest':String(s)).replace(/^@+/, '').toLowerCase(); }

    function gather(){
      const ukey = window.__IZZA_USERKEY__ || CANON(window.IZZA?.api?.user?.username);
      const bankKey = 'izzaBank_' + (ukey || 'guest');
      const heartsKey = 'izzaCurHeartSegments_' + (ukey || 'guest');
      const bankJSON = (window.__LS__?.jsonGet(bankKey, null) ?? null);
      const lsKeys = Object.keys(localStorage).filter(k=>/^izza/i.test(k)).sort();

      return [
        `Origin: ${location.origin}`,
        `UA: ${navigator.userAgent}`,
        `User key: ${ukey}`,
        `Bank key: ${bankKey}`,
        `Bank JSON: ${bankJSON ? JSON.stringify(bankJSON) : '(none)'}`,
        `Hearts key: ${heartsKey}`,
        `Hearts segs: ${window.__LS__?.get(heartsKey, '(none)')}`,
        `Other izza* keys:\n- ${lsKeys.join('\n- ') || '(none)'}`
      ].join('\n');
    }

    function show(){ document.getElementById('izzaDiagBody').textContent = gather(); wrap.style.display='flex'; }
    btn.onclick = show;
    wrap.querySelector('#izzaDiagClose').onclick = ()=> wrap.style.display='none';
    wrap.querySelector('#izzaDiagRefresh').onclick = ()=> document.getElementById('izzaDiagBody').textContent = gather();

    // One-click migration for any lingering @-prefixed bank keys
    wrap.querySelector('#izzaDiagMigrate').onclick = ()=>{
      const moved=[];
      const canon = s=> s.replace(/^@+/, '').toLowerCase();
      Object.keys(localStorage).forEach(k=>{
        if(/^izzaBank_@/i.test(k)){
          const raw = localStorage.getItem(k);
          const target = 'izzaBank_' + canon(k.slice('izzaBank_'.length));
          if(raw!=null && localStorage.getItem(target)==null){
            try{ localStorage.setItem(target, raw); localStorage.removeItem(k); moved.push(`${k} → ${target}`); }catch(e){}
          }
        }
      });
      alert(moved.length ? `Migrated:\n${moved.join('\n')}` : 'No old keys found.');
      document.getElementById('izzaDiagBody').textContent = gather();
      // let the UI (inventory panel etc.) refresh if listening
      window.dispatchEvent(new Event('izza-bank-changed'));
    };
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', ensureUI);
  }else{
    ensureUI();
  }
})();
