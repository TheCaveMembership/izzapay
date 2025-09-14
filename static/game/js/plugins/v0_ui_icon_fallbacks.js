// v0_ui_icon_fallbacks.js — global UI icons for Inventory (bat/knuckles/pistol/uzi/grenade)
// UI-ONLY: not used for on-character overlays.
(function(){
  const BUILD = 'v0-ui-icon-fallbacks';
  console.log('[IZZA PLAY]', BUILD);

  if (window.svgIcon) return; // don't override if something already defined it

  window.svgIcon = function svgIcon(id, w=24, h=24){
    const W = String(w), H = String(h);
    if (id === 'bat') return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${W}" height="${H}">
      <rect x="22" y="8" width="8" height="40" fill="#8b5a2b"/><rect x="20" y="48" width="12" height="8" fill="#6f4320"/></svg>`;
    if (id === 'knuckles') return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${W}" height="${H}">
      <circle cx="20" cy="28" r="6" stroke="#cfcfcf" fill="none" stroke-width="4"/>
      <circle cx="32" cy="28" r="6" stroke="#cfcfcf" fill="none" stroke-width="4"/>
      <circle cx="44" cy="28" r="6" stroke="#cfcfcf" fill="none" stroke-width="4"/>
      <rect x="16" y="34" width="32" height="8" fill="#cfcfcf"/></svg>`;
    if (id === 'pistol') return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${W}" height="${H}">
      <rect x="14" y="26" width="30" height="8" fill="#202833"/>
      <rect x="22" y="34" width="8" height="12" fill="#444c5a"/></svg>`;
    if (id === 'uzi') return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${W}" height="${H}">
      <rect x="12" y="28" width="34" height="8" fill="#0b0e14"/>
      <rect x="36" y="22" width="12" height="6" fill="#0b0e14"/>
      <rect x="30" y="36" width="6" height="12" fill="#0b0e14"/>
      <rect x="18" y="36" width="6" height="10" fill="#0b0e14"/></svg>`;
    if (id === 'grenade') return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${W}" height="${H}">
      <rect x="28" y="22" width="8" height="5" fill="#5b7d61"/>
      <rect x="31" y="19" width="2" height="2" fill="#c3c9cc"/>
      <rect x="26" y="27" width="12" height="14" fill="#264a2b"/></svg>`;
    return ''; // unknown → no icon
  };
})();
