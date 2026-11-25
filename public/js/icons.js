/**
 * Sistema de iconografía vectorial minimalista (monolínea 1.75px, sin emojis).
 */
const SVG_PATHS = {
  brand:
    '<path d="M12 3L2 8l10 5 10-5-10-5z"/><path d="M6 10.5v5.5c0 1.8 2.7 3.5 6 3.5s6-1.7 6-3.5v-5.5"/><path d="M22 8v6"/>',
  list:
    '<rect x="3.5" y="4" width="17" height="16" rx="2.5"/><path d="M8 9h8"/><path d="M8 13h8"/><path d="M8 17h5"/>',
  flame:
    '<path d="M12 22c4.2 0 7-2.9 7-6.8 0-3.3-2.1-5.7-4.2-7.8-.6 2.1-1.9 3.1-3.1 3.1 0-3.1-1.3-5.6-3.2-7.5C7.9 6.2 5 9.8 5 15.2 5 19.1 7.8 22 12 22z"/>',
  leaf:
    '<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.4 19 2c1 2 2 4.2 2 8 0 5.5-4.8 10-10 10z"/><path d="M2 21c0-3 1.8-5.4 5.1-6C9.5 14.5 12 13 13 12"/>',
  zap:
    '<polygon points="13 2 4 14 11 14 10 22 20 10 13 10 13 2"/>',
  snowflake:
    '<line x1="12" y1="2" x2="12" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><path d="m20 16-4-4 4-4"/><path d="m4 8 4 4-4 4"/><path d="m16 4-4 4-4-4"/><path d="m8 20 4-4 4 4"/>',
  crown:
    '<path d="m3 18 2-11 5 4 2-6 2 6 5-4 2 11H3z"/><path d="M3 21h18"/>',
  sparkles:
    '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z"/><path d="M19 16l.9 2.1L22 19l-2.1.9L19 22l-.9-2.1L16 19l2.1-.9L19 16z"/>',
  message:
    '<path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  help:
    '<circle cx="12" cy="12" r="9"/><path d="M9.4 9a2.7 2.7 0 0 1 5.1.9c0 1.8-2.5 2.3-2.5 3.8"/><circle cx="12" cy="17" r="0.6" fill="currentColor"/>',
  logout:
    '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  search:
    '<circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16.2" y2="16.2"/>',
  x:
    '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  plus:
    '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  minus:
    '<line x1="5" y1="12" x2="19" y2="12"/>',
  chevronDown:
    '<polyline points="6 9 12 15 18 9"/>',
  chevronLeft:
    '<polyline points="15 18 9 12 15 6"/>',
  chevronRight:
    '<polyline points="9 18 15 12 9 6"/>',
  check:
    '<polyline points="20 6 9 17 4 12"/>',
  checkCircle:
    '<circle cx="12" cy="12" r="9"/><polyline points="16 9.5 10.75 14.75 8.25 12.25"/>',
  clock:
    '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/>',
  alert:
    '<circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="12.5"/><circle cx="12" cy="16" r="0.6" fill="currentColor"/>',
  info:
    '<circle cx="12" cy="12" r="9"/><line x1="12" y1="11" x2="12" y2="16"/><circle cx="12" cy="8" r="0.6" fill="currentColor"/>',
  notes:
    '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="14 3 14 9 20 9"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/>',
  play:
    '<polygon points="6 4 20 12 6 20 6 4"/>',
  pause:
    '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
  reset:
    '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><polyline points="3 3 3 8 8 8"/>',
  edit:
    '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  trash:
    '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
  calendar:
    '<rect x="3" y="4" width="18" height="17" rx="2.5"/><line x1="16" y1="2.5" x2="16" y2="6"/><line x1="8" y1="2.5" x2="8" y2="6"/><line x1="3" y1="9.5" x2="21" y2="9.5"/>',
  users:
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  book:
    '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
  pin:
    '<path d="M20 10c0 5.5-8 12-8 12s-8-6.5-8-12a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.8"/>',
  download:
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  sort:
    '<path d="m3 16 4 4 4-4"/><path d="M7 20V4"/><path d="m21 8-4-4-4 4"/><path d="M17 4v16"/>',
  filter:
    '<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>',
  send:
    '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
  award:
    '<circle cx="12" cy="8" r="6"/><path d="M15.48 12.89 17 22l-5-3-5 3 1.52-9.11"/>'
};

export function iconSvg(name, { size = 16, className = '' } = {}) {
  const body = SVG_PATHS[name] || SVG_PATHS.sparkles;
  const cls = className ? ` class="ui-icon ${className}"` : ' class="ui-icon"';
  return `<svg${cls} width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}
