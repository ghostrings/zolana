/**
 * Two small marks a token carries wherever it is listed: the change over a
 * day, and what it is priced in. Shared by the market and a token's own page.
 */

import type { PairRef } from '../../shared/src/api.js';
import { changeDirection, changeText } from '../../shared/src/trend.js';
import { triangle } from './icons.js';
import { escapeHtml } from './ui.js';

/**
 * The change over a day. Black and white only: a rise is filled, a fall is
 * hollow. The triangle says which way, so the figure carries no sign.
 */
export function changeChip(change: number | null | undefined): string {
  const direction = changeDirection(change);
  const text = changeText(change).replace(/^[+−]/, '');
  // A dash is "nothing to compare with yet", which is not the same as a price that did not move.
  const spoken = text === '—' ? 'No 24 hour change to show yet' : direction === 'flat' ? 'No change over 24 hours' : `${direction === 'up' ? 'Up' : 'Down'} ${text} over 24 hours`;
  return `<span class="chg ${direction}" data-f="chg" title="${spoken}">${direction === 'flat' ? '' : triangle(direction === 'up')}<span>${escapeHtml(text)}</span><span class="sr-only">${spoken}</span></span>`;
}

/** What a token is priced and traded in. Every amount shown for it is in this. */
export function pairChip(pair: Pick<PairRef, 'id' | 'symbol'>): string {
  const symbol = pair.symbol || pair.id;
  return `<span class="pairchip" title="Priced and traded in ${escapeHtml(symbol)}"><i aria-hidden="true">${escapeHtml(symbol.slice(0, 1).toUpperCase())}</i>${escapeHtml(symbol)}</span>`;
}
