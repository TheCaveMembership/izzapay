// v1_area_chat.plugin.js — per-area chat (duel/trade centre) + feed + language toggle + translation hook (no bubbles)
(function(){
  const BUILD='v1.6-area-chat+nobubbles+typing-guard+translate';
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

    // Enter submits
    Chat.input.addEventListener('keydown', (e)=>{
      if((e.key||'').toLowerCase()!=='enter') return;
      e.preventDefault();
      trySend();
    });
    // Button submits (mobile)
    Chat.sendBtn.addEventListener('click', (e)=>{ e.preventDefault(); trySend(); });

    // Typing marker (optional signal to other subsystems)
    const setTyping = v => { window.__IZZA_TYPING__ = !!v; IZZA && (IZZA.typing = !!v); };
    Chat.input.addEventListener('focus', ()=> setTyping(true));
    Chat.input.addEventListener('blur',  ()=> setTyping(false));
  }

  // ---- GLOBAL TYPING GUARD (let inputs type; block the game) ----
  function isEditable(el){ return !!el && (el.tagName==='INPUT' || el.tagName==='TEXTAREA' || el.isContentEditable); }
  function swallowForInputs(e){
    const el = document.activeElement;
    if(!isEditable(el)) return;
    // Do NOT preventDefault: we want the character to enter the field.
    e.stopImmediatePropagation();
    e.stopPropagation();
  }
  window.addEventListener('keydown', swallowForInputs, true);
  window.addEventListener('keyup',   swallowForInputs, true);

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

  // ---- send/recv ----
  function sendChat(text){
    const lang = Chat.lang || 'en';
    const uname = IZZA?.api?.user?.username || 'guest';
    const payload = { room: areaRoom(), from: uname, text, lang, ts: Date.now() };
    Net.send('chat-say', payload);
    appendFeedLine({from:payload.from, text, ts:payload.ts}); // local feed echo
  }

  Net.on('chat-say', async (m)=>{
    if(!m || m.room !== areaRoom()) return;
    const myLang = Chat.lang || 'en';
    let txt = m.text, meta=null;
    if(m.lang && myLang && m.lang!==myLang){
      const out = await translateMaybe(m.text, m.lang, myLang);
      if(out && out!==m.text){ txt = out; meta = { translated: `${m.lang}→${myLang}` }; }
    }
    appendFeedLine({from:m.from, text:txt, ts:m.ts, meta});
  });

  // ---- area tracking ----
  function refreshArea(){ Chat.area = currentArea(); }
  IZZA?.on?.('mp-start', refreshArea);
  IZZA?.on?.('mp-end',   refreshArea);
  window.addEventListener('storage', (e)=>{ if(e && e.key==='izzaTradeCentre') refreshArea(); });

  // ---- mount ----
  if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded', ()=>{ ensureUI(); refreshArea(); }, {once:true});
  }else{
    ensureUI(); refreshArea();
  }
})();
