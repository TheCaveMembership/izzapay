// v1_area_chat.plugin.js — per-area chat (duel/trade centre) + feed + read-only language + translation hook + typing guard
(function(){
  const BUILD='v1.6-area-chat+readonly-lang+translate+typing-guard+sendbtn';
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

  // ---- language: resolve once (profile -> localStorage -> browser) ----
  function resolvePlayerLang(){
    // 1) From profile injected by your auth / Pi SDK, if present
    const profLang =
      (window.__IZZA_PROFILE__ && (window.__IZZA_PROFILE__.lang || window.__IZZA_PROFILE__.language)) ||
      (IZZA?.api?.user && (IZZA.api.user.lang || IZZA.api.user.language));
    // 2) Saved pref from previous sessions
    const saved = localStorage.getItem('izzaLang');
    // 3) Browser language fallback
    const br = (navigator.language || 'en').slice(0,2).toLowerCase();

    const lang = (profLang || saved || br || 'en').slice(0,2).toLowerCase();
    try{ localStorage.setItem('izzaLang', lang); }catch{}
    return lang;
  }

  // ---- chat state ----
  const Chat = {
    lang: resolvePlayerLang(),     // display + translation target
    open: false,
    area: 'world',                 // 'tc' | 'duel' | 'world'
    host: null,
    input: null,
    sendBtn: null,
    toggleBtn: null,
    feed: null,
    langLabel: null,
    fireBtnPrevDisplay: null
  };

  function currentArea(){
    if(window.__IZZA_DUEL && __IZZA_DUEL.active) return 'duel';
    if(localStorage.getItem('izzaTradeCentre')==='1') return 'tc';
    return 'world';
  }
function currentWorldId(){ return (localStorage.getItem('izzaWorldId') || '1'); }
window.addEventListener('izza-world-changed', ()=>{ /* causes room key to change */ });
  // ---- UI: compact bar + expandable feed (lang label is read-only) ----
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
      <span id="chatLangLabel" title="Your language (for translation)"
        style="min-width:34px;text-align:center;background:#0e1626;color:#cfe0ff;border:1px solid #2a3550;border-radius:8px;padding:6px 8px;font-weight:700">
        ${Chat.lang.toUpperCase()}
      </span>
    `;
    card.after(bar);
    Chat.host = bar;
    Chat.input = bar.querySelector('#chatInput');
    Chat.sendBtn = bar.querySelector('#chatSend');
    Chat.toggleBtn = bar.querySelector('#chatToggle');
    Chat.langLabel = bar.querySelector('#chatLangLabel');

    // feed
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

    // toggle feed + hide FIRE while open
    Chat.toggleBtn.onclick = ()=>{
      Chat.open = !Chat.open;
      Chat.feed.style.display = Chat.open ? 'block' : 'none';
      const fire = document.getElementById('btnFire');
      if(fire){
        if(Chat.open){ Chat.fireBtnPrevDisplay = fire.style.display; fire.style.display='none'; }
        else{ fire.style.display = Chat.fireBtnPrevDisplay || ''; }
      }
    };

    // send helper
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

    // typing marker (optional for other subsystems)
    const setTyping = v => { window.__IZZA_TYPING__ = !!v; if(window.IZZA) IZZA.typing = !!v; };
    Chat.input.addEventListener('focus', ()=> setTyping(true));
    Chat.input.addEventListener('blur',  ()=> setTyping(false));
  }

  // ---- GLOBAL TYPING GUARD (fixes A/B/I triggering game) ----
  function isEditable(el){ return !!el && (el.tagName==='INPUT' || el.tagName==='TEXTAREA' || el.isContentEditable); }
  window.addEventListener('keydown', (e)=>{
    const el = document.activeElement;
    if(!isEditable(el)) return;
    const k = (e.key||'').toLowerCase();
    const block = new Set(['a','b','i',' ','arrowup','arrowdown','arrowleft','arrowright','escape']);
    if(block.has(k) || k.length===1){
      e.stopImmediatePropagation();
      e.stopPropagation();
    }
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
  function areaRoom(){
  const a = currentArea();
  if (a === 'duel') return 'duel';
  if (a === 'tc')   return 'tc';
  // Scope world chat to the selected world
  return 'world:' + currentWorldId();
}
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
    const lang = Chat.lang || 'en'; // mark outgoing with player's language
    const uname = (IZZA?.api?.user && (IZZA.api.user.username || IZZA.api.user.name)) || 'guest';
    const payload = { room: areaRoom(), from: uname, text, lang, ts: Date.now() };
    Net.send('chat-say', payload);
    appendFeedLine({from:payload.from, text, ts:payload.ts}); // local echo
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

  // ---- boot ----
  if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded', ()=>{ ensureUI(); refreshArea(); }, {once:true});
  }else{
    ensureUI(); refreshArea();
  }
})();
