/**
 * The interface's own icons: one weight of line, drawn on a 24 by 24 grid,
 * taking the colour of the text around them. Kept as strings so the pages
 * that build their markup as text can drop one in.
 */

const PATHS = {
  market: '<path d="M3 20h18M6 20v-8M12 20V5M18 20v-5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  wallet:
    '<path d="M3.5 8A2.5 2.5 0 0 1 6 5.5h11.5a1.5 1.5 0 0 1 1.5 1.5v1.5"/><path d="M3.5 8v9A2.5 2.5 0 0 0 6 19.5h12.5a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2H6A2.5 2.5 0 0 1 3.5 8Z"/><path d="M16.5 14h.01"/>',
  layers: '<path d="m12 3 9 4.5-9 4.5-9-4.5L12 3Z"/><path d="m3 12 9 4.5 9-4.5"/><path d="m3 16.5 9 4.5 9-4.5"/>',
  docs: '<path d="M6.5 3H14l4.5 4.5V19a2 2 0 0 1-2 2h-10a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/><path d="M14 3v4.5h4.5M8.5 12.5h7M8.5 16.5h7"/>',
  shield: '<path d="M12 3 4.5 6v5.5c0 4.6 3.1 8 7.5 9.5 4.4-1.5 7.5-4.9 7.5-9.5V6L12 3Z"/><path d="M12 8.5v6.5M9.5 12.5 12 15l2.5-2.5"/>',
  unshield: '<path d="M12 3 4.5 6v5.5c0 4.6 3.1 8 7.5 9.5 4.4-1.5 7.5-4.9 7.5-9.5V6L12 3Z"/><path d="M12 15V8.5M9.5 11 12 8.5l2.5 2.5"/>',
  send: '<path d="M7 17 17 7M9 7h8v8"/>',
  receive: '<path d="M17 7 7 17M15 17H7V9"/>',
  copy: '<rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2.5"/><path d="M15.5 8.5v-2a2 2 0 0 0-2-2H6.5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  expand: '<path d="M14 4h6v6M20 4l-7.5 7.5M10 5.5H6.5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V14"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.5-4L4 8.5M4 4v4.5h4.5M4 13a8 8 0 0 0 14.5 4L20 15.5M20 20v-4.5h-4.5"/>',
  cards: '<rect x="3.5" y="4" width="7.5" height="16" rx="2"/><rect x="13" y="4" width="7.5" height="16" rx="2"/>',
  grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>',
  rows: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  swap: '<path d="M7 4 3.5 7.5 7 11M3.5 7.5H20M17 13l3.5 3.5L17 20M20.5 16.5H4"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  key: '<circle cx="8" cy="15.5" r="4"/><path d="m11 12.5 8.5-8.5M16.5 7l2.5 2.5"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/>',
  rings: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.5"/>',
} as const;

export type IconName = keyof typeof PATHS;

/** An icon as an inline SVG. It is decoration: whatever it sits beside carries the words. */
export function icon(name: IconName, extraClass = ''): string {
  return `<svg class="icon${extraClass ? ` ${extraClass}` : ''}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${PATHS[name]}</svg>`;
}

/** The small solid triangle beside a change: up, or down. */
export function triangle(up: boolean): string {
  return `<svg class="tri" viewBox="0 0 10 10" aria-hidden="true" focusable="false"><path d="${up ? 'M5 1.5 9.2 8.5H.8z' : 'M5 8.5.8 1.5h8.4z'}"/></svg>`;
}
