// /static/game/js/plugins/v6_ui_exclusive.js
(function () {
  const BUILD = 'v6-ui-exclusive(inv↔map)';
  console.log('[IZZA PLAY]', BUILD);

  // --- dom helpers ---
  const $ = (s) => document.querySelector(s);
  const invHost   = () => $('#invPanel');
  const miniWrap  = () => $('#miniWrap');
  const mapModal  = () => $('#mapModal');

  function isInvOpen()  { const h=invHost();  return !!(h && h.style.display !== 'none'); }
  function closeInv()   { const h=invHost();  if(h) h.style.display = 'none'; }
  function openInv()    { const h=invHost();  if(h){ h.style.display='block'; } }
  function closeMap()   { const m=mapModal(); if(m) m.style.display = 'none'; }
  function hideMini()   { const m=miniWrap(); if(m) m.style.display  = 'none'; }

  // If inventory is opening, ensure map/minimap are closed/hidden
  function beforeInventoryToggle() {
    closeMap();
    hideMini();
  }
  // If map/minimap is opening, ensure inventory is closed
  function beforeMapToggle() {
    closeInv();
  }

  // --- intercept keyboard "I" before core's listener ---
  window.addEventListener('keydown', (e) => {
    const k = e.key && e.key.toLowerCase();
    if (k === 'i') beforeInventoryToggle();
  }, true /* capture so we run before bubble listeners (core) */);

  // --- intercept inventory button click before core's listener ---
  const btnI = document.getElementById('btnI');
  if (btnI) {
    btnI.addEventListener('click', () => beforeInventoryToggle(), true);
  }

  // --- when Map button is clicked, close inventory first ---
  const btnMap = document.getElementById('btnMap');
  if (btnMap) {
    btnMap.addEventListener('click', () => beforeMapToggle(), true);
  }

  // --- when clicking the minimap (opens big map), close inventory first ---
  const mini = miniWrap();
  if (mini) {
    mini.addEventListener('click', () => beforeMapToggle(), true);
  }

  // --- when big map opens via backdrop/close button, we don't need extras.
  // But if *something else* opens inventory (future code), ensure exclusivity:
  // Observe inventory DOM display changes and react.
  const host = invHost();
  if (host && 'MutationObserver' in window) {
    new MutationObserver(() => {
      if (isInvOpen()) { closeMap(); hideMini(); }
    }).observe(host, { attributes: true, attributeFilter: ['style'] });
  }
})();
