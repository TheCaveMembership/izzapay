// v1_area_chat.plugin.js — per-area chat (duel/trade centre) + bubbles + feed + language toggle + translation hook
(function(){
  const BUILD='v1.3-area-chat+i18n-hook+typing-guard+sendbtn+bubble-posfix+uname-normalize';
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

    // bar (left: toggle, center: input, right: language + send)
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

    // send helper
    function trySend(){
      const txt = (Chat.input.value||'').trim();
      if(!txt) return;
      sendChat(txt);
      Chat.input.value='';
    }

    // send on Enter (Return)
    Chat.input.addEventListener('keydown', (e)=>{
      if((e.key||'').toLowerCase()!=='enter') return;
      e.preventDefault();
      trySend();
    });

    // send on button press (mobile-friendly)
    Chat.sendBtn.addEventListener('click', (e)=>{ e.preventDefault(); trySend(); });

    // Mark typing focus (optional hint for other subsystems)
    const setTyping = v => { window.__IZZA_TYPING__ = !!v; IZZA && (IZZA.typing = !!v); };
    Chat.input.addEventListener('focus', ()=> setTyping(true));
    Chat.input.addEventListener('blur',  ()=> setTyping(false));
  }

  // ---- GLOBAL TYPING GUARD (fixes A/B/I triggering game) ----
  function isEditable(el){
    return !!el && (el.tagName==='INPUT' || el.tagName==='TEXTAREA' || el.isContentEditable);
  }
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
    return text;
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
  const norm = u => (u||'').toString().trim().replace(/^@+/,'').toLowerCase();

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
  const Bubbles = new Map(); // key = normalized username -> {el, tDie, text}

  function ensureBubbleHost(){
    const cvs=document.getElementById('game'); if(!cvs) return null;
    const parent = cvs.parentElement;
    if (parent && getComputedStyle(parent).position==='static') {
      parent.style.position = 'relative';
    }
    return { cvs, parent };
  }

  function showBubble(unameRaw, text){
    try{
      const key = norm(unameRaw);
      if(!key) return;
      const host = ensureBubbleHost(); if(!host) return;
      let b=Bubbles.get(key);
      if(!b){
        const el=document.createElement('div');
        Object.assign(el.style,{
          position:'absolute', zIndex:29, pointerEvents:'none',
          background:'rgba(8,12,20,.92)', color:'#e8eef7',
          border:'1px solid #2a3550', borderRadius:'10px',
          padding:'4px 8px', fontSize:'12px', maxWidth:'180px', whiteSpace:'pre-wrap',
          transition:'opacity 160ms linear', opacity:'1'
        });
        host.parent.appendChild(el);
        b = { el, tDie:0, text:'' };
        Bubbles.set(key, b);
      }
      b.text=text; b.el.textContent=text; b.tDie = performance.now() + 4000; // ~4s

      // Try to position immediately (for snappy local display)
      const api=IZZA.api;
      if(api?.ready){
        const S=api.DRAW, scale=S/api.TILE;
        const parentRect = host.parent.getBoundingClientRect();
        const canvasRect = host.cvs.getBoundingClientRect();
        const offX = canvasRect.left - parentRect.left;
        const offY = canvasRect.top  - parentRect.top;

        const meKey = norm(api?.user?.username || api?.user?.name);
        if(key===meKey){
          const sx=(api.player.x - api.camera.x)*scale;
          const sy=(api.player.y - api.camera.y)*scale;
          positionBubble(b.el, offX, offY, sx, sy);
        }else{
          const p = findPeerByKey(key); // try remote immediately
          if(p){
            const sx=(p.x - api.camera.x)*scale, sy=(p.y - api.camera.y)*scale;
            positionBubble(b.el, offX, offY, sx, sy);
          }
        }
      }
    }catch(e){}
  }

  function positionBubble(el, offX, offY, sx, sy){
    el.style.left = (offX + sx - el.offsetWidth/2 + 16) + 'px';
    el.style.top  = (offY + sy - 36) + 'px';
    el.style.opacity = '1';
  }

  function findPeerByKey(key){
    // Try multiple sources for remote players; normalize each name
    const pools = [
      (window.__REMOTE_PLAYERS__||[]),
      (window.REMOTE_PLAYERS_API?.list?.() || []),
      (IZZA?.api?.peers || [])
    ];
    for(const arr of pools){
      for(const p of arr){
        const uname = p?.username || p?.name || p?.id || '';
        if(norm(uname)===key) return p;
      }
    }
    return null;
  }

  // Reposition & cull bubbles each frame
  IZZA.on?.('render-post', ()=>{
    try{
      const api=IZZA.api; if(!api?.ready) return;
      const host = ensureBubbleHost(); if(!host) return;
      const S=api.DRAW, scale=S/api.TILE;
      const now=performance.now();

      const parentRect = host.parent.getBoundingClientRect();
      const canvasRect = host.cvs.getBoundingClientRect();
      const offX = canvasRect.left - parentRect.left;
      const offY = canvasRect.top  - parentRect.top;

      const meKey = norm(api?.user?.username || api?.user?.name);

      // Position my bubble (if any)
      if(meKey && Bubbles.has(meKey)){
        const b=Bubbles.get(meKey);
        const sx=(api.player.x - api.camera.x)*scale;
        const sy=(api.player.y - api.camera.y)*scale;
        positionBubble(b.el, offX, offY, sx, sy);
        if(now>b.tDie){ b.el.remove(); Bubbles.delete(meKey); }
      }

      // Position remote bubbles
      for (const [key, b] of Array.from(Bubbles.entries())){
        if(key===meKey) continue;
        const p = findPeerByKey(key);
        if(p){
          const sx=(p.x - api.camera.x)*scale, sy=(p.y - api.camera.y)*scale;
          positionBubble(b.el, offX, offY, sx, sy);
        }
        if(now>b.tDie){
          b.el.remove();
          Bubbles.delete(key);
        }
      }
    }catch{}
  });

  // ---- sending & receiving ----
  function sendChat(text){
    const lang = Chat.lang || 'en';
    const uname = IZZA?.api?.user?.username || IZZA?.api?.user?.name || 'me';
    const payload = {
      room: areaRoom(),
      from: uname,
      text,
      lang,
      ts: Date.now()
    };
    Net.send('chat-say', payload);
    appendFeedLine({from:payload.from, text, ts:payload.ts}); // local echo
    showBubble(uname, text); // immediate local bubble
  }

  Net.on('chat-say', async (m)=>{
    if(!m || m.room !== areaRoom()) return; // only current-area messages
    const myLang = Chat.lang || 'en';
    let txt = m.text, meta=null;
    if(m.lang && myLang && m.lang!==myLang){
      const out = await translateMaybe(m.text, m.lang, myLang);
      if(out && out!==m.text){ txt = out; meta = { translated: `${m.lang}→${myLang}` }; }
    }
    appendFeedLine({from:m.from, text:txt, ts:m.ts, meta});
    showBubble(m.from, txt); // bubble shows translated text client-side
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
