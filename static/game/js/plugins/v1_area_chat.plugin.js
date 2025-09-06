// v1_area_chat.plugin.js — per-area chat (duel/trade centre) + bubbles + feed + language toggle + translation hook
(function(){
  const BUILD='v1.1-area-chat+i18n-hook';
  console.log('[IZZA PLAY]', BUILD);

  // ---- lightweight MP adapter (works with any of your 3 buses) ----
  const Net = (function(){
    const api = {};
    api.send = function(type, data){
      try{
        if (window.REMOTE_PLAYERS_API?.send) return window.REMOTE_PLAYERS_API.send(type, data);
        if (window.RemotePlayers?.send)      return window.RemotePlayers.send(type, data);
        if (window.IZZA?.emit)               return IZZA.emit('mp-send', {type, data});
      }catch(e){ console.warn('[CHAT] send failed', e); }
    };
    api.on = function(type, cb){
      try{
        if (window.REMOTE_PLAYERS_API?.on) return window.REMOTE_PLAYERS_API.on(type, cb);
        if (window.RemotePlayers?.on)      return window.RemotePlayers.on(type, cb);
        if (window.IZZA?.on)               return IZZA.on('mp-'+type, (_,{data})=>cb(data));
      }catch(e){ console.warn('[CHAT] on failed', e); }
    };
    return api;
  })();

  // ---- chat state ----
  const Chat = {
    lang: (localStorage.getItem('izzaLang')||'en'),
    open: false,
    area: 'world', // 'tc' | 'duel' | 'world'
    host: null,
    input: null,
    toggleBtn: null,
    feed: null,
    fireBtnPrevDisplay: null
  };

  function currentArea(){
    if(window.__IZZA_DUEL && __IZZA_DUEL.active) return 'duel';
    if(localStorage.getItem('izzaTradeCentre')==='1') return 'tc';
    return 'world';
  }

  // ---- UI: compact bar + expandable feed ----
  function ensureUI(){
    if(Chat.host) return;
    const card = document.getElementById('gameCard'); if(!card) return;

    // bar (left: toggle, center: input, right: language)
    const bar = document.createElement('div');
    bar.id='chatBar';
    Object.assign(bar.style,{
      position:'relative',
      margin:'8px 0 0 0',
      display:'flex', gap:'6px', alignItems:'center', zIndex:7
    });
    bar.innerHTML = `
      <button id="chatToggle" title="Chat" style="background:#1a2540;color:#cfe0ff;border:1px solid #2a3550;border-radius:8px;padding:6px 8px">💬</button>
      <input id="chatInput" type="text" placeholder="Type…" style="flex:1;background:#0e1626;color:#e8eef7;border:1px solid #2a3550;border-radius:8px;padding:8px 10px;font-size:14px">
      <select id="chatLang" title="Language" style="background:#0e1626;color:#cfe0ff;border:1px solid #2a3550;border-radius:8px;padding:6px 8px">
        <option value="en">EN</option><option value="es">ES</option><option value="fr">FR</option><option value="de">DE</option>
        <option value="it">IT</option><option value="pt">PT</option><option value="ru">RU</option><option value="zh">ZH</option>
        <option value="ja">JA</option><option value="ko">KO</option><option value="ar">AR</option>
      </select>
    `;
    card.after(bar);
    Chat.host = bar;
    Chat.input = bar.querySelector('#chatInput');
    Chat.toggleBtn = bar.querySelector('#chatToggle');

    const sel = bar.querySelector('#chatLang');
    sel.value = Chat.lang;
    sel.onchange = ()=>{
      Chat.lang = sel.value || 'en';
      try{ localStorage.setItem('izzaLang', Chat.lang); }catch{}
      // let the rest of the app react (menus, HUD, etc.)
      IZZA?.emit?.('ui-lang-changed', { lang: Chat.lang });
    };

    // feed (hidden by default; toggling hides FIRE button while open)
    const feed = document.createElement('div');
    feed.id='chatFeed';
    Object.assign(feed.style,{
      marginTop:'6px',
      display:'none',
      maxHeight:'26vh', overflow:'auto',
      background:'#0b0f17', border:'1px solid #2a3550', borderRadius:'10px', padding:'8px', color:'#dbe6ff'
    });
    card.after(feed);
    Chat.feed = feed;

    Chat.toggleBtn.onclick = ()=>{
      Chat.open = !Chat.open;
      Chat.feed.style.display = Chat.open ? 'block' : 'none';
      const fire = document.getElementById('btnFire');
      if(fire){
        if(Chat.open){ Chat.fireBtnPrevDisplay = fire.style.display; fire.style.display='none'; }
        else{ fire.style.display = Chat.fireBtnPrevDisplay || ''; }
      }
    };

    // send on Enter
    Chat.input.addEventListener('keydown', (e)=>{
      if((e.key||'').toLowerCase()!=='enter') return;
      e.preventDefault();
      const txt = (Chat.input.value||'').trim();
      if(!txt) return;
      sendChat(txt);
      Chat.input.value='';
    });
  }

  // ---- translation hook (optional) ----
  async function translateMaybe(text, from, to){
    if(!text) return text;
    if(!to || from===to) return text;
    try{
      if(typeof window.TRANSLATE_TEXT === 'function'){
        const out = await window.TRANSLATE_TEXT(text, from, to);
        return out || text;
      }
    }catch(e){ console.warn('[CHAT] translate hook failed', e); }
    return text; // fallback: original
  }

  // ---- helpers ----
  function areaRoom(){
    const a = currentArea();
    return (a==='duel') ? 'duel' : (a==='tc' ? 'tc' : 'world');
  }
  function tsStamp(ms){
    const d = ms ? new Date(ms) : new Date();
    const hh = String(d.getHours()).padStart(2,'0');
    const mm = String(d.getMinutes()).padStart(2,'0');
    return `${hh}:${mm}`;
  }
  function escapeHTML(s){ return String(s).replace(/[&<>"']/g, m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m])); }

  function appendFeedLine({from,text,ts,meta}){
    if(!Chat.feed) return;
    const line = document.createElement('div');
    line.style.padding='4px 2px';
    line.style.borderBottom='1px solid rgba(255,255,255,.06)';
    const tag = meta && meta.translated ? ` <span style="opacity:.7;font-size:12px">(${meta.translated})</span>` : '';
    line.innerHTML = `<b>@${escapeHTML(from)}</b> <span style="opacity:.7">${tsStamp(ts)}</span>${tag}<br>${escapeHTML(text)}`;
    Chat.feed.appendChild(line);
    Chat.feed.scrollTop = Chat.feed.scrollHeight;
  }

  // ---- floating bubbles above heads ----
  const Bubbles = new Map(); // username -> {el, tDie, text}
  function showBubble(uname, text){
    try{
      const cvs=document.getElementById('game'); if(!cvs) return;
      let b=Bubbles.get(uname);
      if(!b){
        const el=document.createElement('div');
        Object.assign(el.style,{
          position:'absolute', zIndex:29, pointerEvents:'none',
          background:'rgba(8,12,20,.85)', color:'#e8eef7',
          border:'1px solid #2a3550', borderRadius:'10px',
          padding:'4px 8px', fontSize:'12px', maxWidth:'180px', whiteSpace:'pre-wrap'
        });
        cvs.parentElement.style.position = cvs.parentElement.style.position || 'relative';
        cvs.parentElement.appendChild(el);
        b = { el, tDie:0, text:'' };
        Bubbles.set(uname, b);
      }
      b.text=text; b.el.textContent=text; b.tDie = performance.now() + 4000; // 4s
    }catch(e){}
  }
  IZZA.on?.('render-post', ()=>{
    try{
      const api=IZZA.api; if(!api?.ready) return;
      const cvs=document.getElementById('game'); if(!cvs) return;
      const S=api.DRAW, scale=S/api.TILE;
      const now=performance.now();

      // my bubble
      const meName = IZZA?.api?.user?.username || '';
      if(meName && Bubbles.has(meName)){
        const b=Bubbles.get(meName);
        const sx=(api.player.x - api.camera.x)*scale;
        const sy=(api.player.y - api.camera.y)*scale;
        positionBubble(b.el, cvs, sx, sy);
        if(now>b.tDie){ b.el.remove(); Bubbles.delete(meName); }
      }

      // remote players (from your remote players pool)
      const peers = (window.__REMOTE_PLAYERS__||[]);
      peers.forEach(p=>{
        const uname=p.username||p.name; if(!uname) return;
        const b=Bubbles.get(uname); if(!b) return;
        const sx=(p.x - api.camera.x)*scale, sy=(p.y - api.camera.y)*scale;
        positionBubble(b.el, cvs, sx, sy);
        if(now>b.tDie){ b.el.remove(); Bubbles.delete(uname); }
      });
    }catch{}
  });
  function positionBubble(el, cvs, sx, sy){
    const rect=cvs.getBoundingClientRect();
    // center over head; +16 to move to sprite center; raise a bit above
    el.style.left = (rect.left + sx - el.offsetWidth/2 + 16) + 'px';
    el.style.top  = (rect.top + sy - 18 - 18) + 'px';
  }

  // ---- sending & receiving ----
  function sendChat(text){
    const lang = Chat.lang || 'en';
    const payload = {
      room: areaRoom(),
      from: IZZA?.api?.user?.username || 'me',
      text,
      lang,
      ts: Date.now()
    };
    Net.send('chat-say', payload);
    appendFeedLine({from:payload.from, text, ts:payload.ts}); // immediate local echo
    showBubble(payload.from, text);
  }

  Net.on('chat-say', async (m)=>{
    if(!m || m.room !== areaRoom()) return; // only consume current area’s messages
    const myLang = Chat.lang || 'en';
    let txt = m.text, meta=null;
    if(m.lang && myLang && m.lang!==myLang){
      const out = await translateMaybe(m.text, m.lang, myLang);
      if(out && out!==m.text){ txt = out; meta = { translated: `${m.lang}→${myLang}` }; }
    }
    appendFeedLine({from:m.from, text:txt, ts:m.ts, meta});
    showBubble(m.from, txt);
  });

  // ---- area tracking ----
  function refreshArea(){ Chat.area = currentArea(); }
  IZZA.on?.('mp-start', refreshArea);
  IZZA.on?.('mp-end',   refreshArea);
  window.addEventListener('storage', (e)=>{ if(e && e.key==='izzaTradeCentre') refreshArea(); });

  // ---- mount UI when DOM ready ----
  if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded', ()=>{ ensureUI(); refreshArea(); }, {once:true});
  }else{
    ensureUI(); refreshArea();
  }

  // ---- OPTIONAL: example translator shim (no-op). Replace from server/SDK. ----
  // window.TRANSLATE_TEXT = async (text, from, to) => text;

})();
