// v1_area_chat.plugin.js — per-area chat (duel/trade centre) + bubbles + feed + language toggle + translation hook
(function(){
  const BUILD='v1.5-area-chat+username-fix+player-bubbles+z3000';
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
        if (window.RemotePlayers?.on)      return RemotePlayers.on(type, cb);
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
    sendBtn: null,
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

    const bar = document.createElement('div');
    bar.id='chatBar';
    Object.assign(bar.style,{
      position:'relative',
      margin:'8px 0 0 0',
      display:'flex', gap:'6px', alignItems:'center', zIndex:7
    });
    bar.innerHTML = `
      <button id="chatToggle" title="Chat" style="background:#1a2540;color:#cfe0ff;border:1px solid #2a3550;border-radius:8px;padding:6px 8px">💬</button>
      <input id="chatInput" type="text" placeholder="Type…" autocomplete="off" autocapitalize="sentences" spellcheck="false"
        style="flex:1;background:#0e1626;color:#e8eef7;border:1px solid #2a3550;border-radius:8px;padding:8px 10px;font-size:14px">
      <button id="chatSend" title="Send" style="background:#2ea043;color:#fff;border:0;border-radius:8px;padding:8px 10px;font-weight:700">Send</button>
      <select id="chatLang" title="Language" style="background:#0e1626;color:#cfe0ff;border:1px solid #2a3550;border-radius:8px;padding:6px 8px">
        <option value="en">EN</option><option value="es">ES</option><option value="fr">FR</option><option value="de">DE</option>
        <option value="it">IT</option><option value="pt">PT</option><option value="ru">RU</option><option value="zh">ZH</option>
        <option value="ja">JA</option><option value="ko">KO</option><option value="ar">AR</option>
      </select>
    `;
    card.after(bar);
    Chat.host = bar;
    Chat.input = bar.querySelector('#chatInput');
    Chat.sendBtn = bar.querySelector('#chatSend');
    Chat.toggleBtn = bar.querySelector('#chatToggle');

    const sel = bar.querySelector('#chatLang');
    sel.value = Chat.lang;
    sel.onchange = ()=>{
      Chat.lang = sel.value || 'en';
      try{ localStorage.setItem('izzaLang', Chat.lang); }catch{}
      IZZA?.emit?.('ui-lang-changed', { lang: Chat.lang });
    };

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

    function trySend(){
      const txt = (Chat.input.value||'').trim();
      if(!txt) return;
      sendChat(txt);
      Chat.input.value='';
    }

    Chat.input.addEventListener('keydown', (e)=>{
      if((e.key||'').toLowerCase()!=='enter') return;
      e.preventDefault();
      trySend();
    });
    Chat.sendBtn.addEventListener('click', (e)=>{ e.preventDefault(); trySend(); });

    const setTyping = v => { window.__IZZA_TYPING__ = !!v; IZZA && (IZZA.typing = !!v); };
    Chat.input.addEventListener('focus', ()=> setTyping(true));
    Chat.input.addEventListener('blur',  ()=> setTyping(false));
  }

  // ---- GLOBAL TYPING GUARD ----
  function isEditable(el){ return !!el && (el.tagName==='INPUT' || el.tagName==='TEXTAREA' || el.isContentEditable); }
  window.addEventListener('keydown', (e)=>{
    const el = document.activeElement;
    if(!isEditable(el)) return;
    const k = (e.key||'').toLowerCase();
    const block = new Set(['a','b','i',' ','arrowup','arrowdown','arrowleft','arrowright','escape']);
    if(block.has(k) || k.length===1){ e.stopImmediatePropagation(); e.stopPropagation(); }
  }, true);

  // ---- translation hook ----
  async function translateMaybe(text, from, to){
    if(!text) return text;
    if(!to || from===to) return text;
    try{
      if(typeof window.TRANSLATE_TEXT === 'function'){
        const out = await window.TRANSLATE_TEXT(text, from, to);
        return out || text;
      }
    }catch(e){ console.warn('[CHAT] translate fail', e); }
    return text;
  }

  // ---- helpers ----
  function areaRoom(){ const a = currentArea(); return (a==='duel') ? 'duel' : (a==='tc' ? 'tc' : 'world'); }
  function tsStamp(ms){ const d = ms ? new Date(ms) : new Date(); return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; }
  function escapeHTML(s){ return String(s).replace(/[&<>"']/g, m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m])); }
  const _norm = u => (u||'').toString().trim().replace(/^@+/,'').toLowerCase();

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

  // ---- bubbles ----
  const Bubbles = new Map();
  function _gameCanvas(){ return document.getElementById('game') || null; }

  function _findPeerByKey(key){
    const pools = [
      (window.__REMOTE_PLAYERS__||[]),
      (window.REMOTE_PLAYERS_API?.list?.() || []),
      (IZZA?.api?.peers || [])
    ];
    for (const arr of pools){
      for (const p of arr){
        const uname = p?.username || p?.name || p?.id || '';
        if (_norm(uname) === key) return p;
      }
    }
    return null;
  }

  function _positionBubbleNow(key, el){
    const api = IZZA?.api; const cvs = _gameCanvas(); if (!api?.ready || !cvs) return;
    const rect  = cvs.getBoundingClientRect(); const scale = api.DRAW / api.TILE;
    const meKey = _norm(api?.user?.username || 'guest');
    let sx, sy;
    if (key === meKey){ sx = (api.player.x - api.camera.x) * scale; sy = (api.player.y - api.camera.y) * scale; }
    else{ const p = _findPeerByKey(key); if (!p) return; sx = (p.x - api.camera.x) * scale; sy = (p.y - api.camera.y) * scale; }
    if (!el.offsetWidth){ requestAnimationFrame(()=> _positionBubbleNow(key, el)); return; }
    el.style.left = Math.round(rect.left + sx - el.offsetWidth/2 + 16) + 'px';
    el.style.top  = Math.round(rect.top  + sy - 36) + 'px';
    el.style.opacity = '1';
  }

  function showBubble(unameRaw, text){
    try{
      const key = _norm(unameRaw); if (!key) return;
      let b = Bubbles.get(key);
      if (!b){
        const el = document.createElement('div');
        Object.assign(el.style,{
          position:'fixed', zIndex:3000, pointerEvents:'none',
          background:'rgba(8,12,20,.92)', color:'#e8eef7',
          border:'1px solid #2a3550', borderRadius:'10px',
          padding:'4px 8px', fontSize:'12px', maxWidth:'60vw',
          whiteSpace:'pre-wrap', transform:'translateZ(0)',
          transition:'opacity 160ms linear', opacity:'0'
        });
        document.body.appendChild(el);
        b = { el, tDie: 0 }; Bubbles.set(key, b);
      }
      b.el.textContent = text; b.tDie = performance.now() + 4000;
      requestAnimationFrame(()=> _positionBubbleNow(key, b.el));
    }catch(e){ console.warn('[CHAT] bubble fail', e); }
  }

  IZZA?.on?.('render-post', ()=>{
    try{
      if (!IZZA?.api?.ready || !_gameCanvas()) return;
      const now = performance.now();
      for (const [key, b] of Array.from(Bubbles.entries())){
        _positionBubbleNow(key, b.el);
        if (now > b.tDie){ b.el.remove(); Bubbles.delete(key); }
      }
    }catch{}
  });

  ['scroll','resize','orientationchange'].forEach(evt=>{
    window.addEventListener(evt, ()=>{ for (const [key, b] of Bubbles.entries()){ _positionBubbleNow(key, b.el); } }, { passive:true });
  });

  // ---- send/recv ----
  function sendChat(text){
    const lang = Chat.lang || 'en';
    const uname = IZZA?.api?.user?.username || 'guest';
    const payload = { room: areaRoom(), from: uname, text, lang, ts: Date.now() };
    Net.send('chat-say', payload);
    appendFeedLine({from:payload.from, text, ts:payload.ts});
    showBubble(uname, text);
  }

  Net.on('chat-say', async (m)=>{
    if(!m || m.room !== areaRoom()) return;
    const myLang = Chat.lang || 'en'; let txt = m.text, meta=null;
    if(m.lang && myLang && m.lang!==myLang){
      const out = await translateMaybe(m.text, m.lang, myLang);
      if(out && out!==m.text){ txt = out; meta = { translated: `${m.lang}→${myLang}` }; }
    }
    appendFeedLine({from:m.from, text:txt, ts:m.ts, meta});
    showBubble(m.from, txt);
  });

  // ---- area tracking ----
  function refreshArea(){ Chat.area = currentArea(); }
  IZZA?.on?.('mp-start', refreshArea);
  IZZA?.on?.('mp-end',   refreshArea);
  window.addEventListener('storage', (e)=>{ if(e && e.key==='izzaTradeCentre') refreshArea(); });

  if(document.readyState==='loading'){ document.addEventListener('DOMContentLoaded', ()=>{ ensureUI(); refreshArea(); }, {once:true}); }
  else{ ensureUI(); refreshArea(); }

  window.IZZA_CHAT = window.IZZA_CHAT || {};
  window.IZZA_CHAT.showBubble = function(text='Test'){ try{ const uname = IZZA?.api?.user?.username || 'guest'; showBubble(uname, text); }catch(e){} };
})();
