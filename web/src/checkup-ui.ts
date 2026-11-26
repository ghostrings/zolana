/**
 * The Check-up box on the wallet page: what this wallet's public Rings
 * activity lets an onlooker work out about it.
 *
 * It asks this site's explorer for the wallet's public rows, the same ones
 * anybody can open for any address, and works the rest out here. It needs no
 * key and reads nothing private.
 */

import { type Checkup, checkup } from '../../shared/src/checkup.js';
import type { RingAddressView, RingLabels, RingRow } from '../../shared/src/rings-api.js';
import { ApiError, api } from './api.js';
import { checkupCards, coverageText } from './checkup-words.js';
import { describeError, escapeHtml } from './ui.js';

/** How many pages of fifty rows a check-up reads at most. */
const PAGES = 4;

export interface CheckupBox {
  /** The wallet changed: what was found for the one before is taken off the screen. */
  reset(): void;
}

export function mountCheckup(root: HTMLElement, address: () => string | null): CheckupBox {
  root.innerHTML = `<div class="row-wrap"><button class="btn" type="button" data-checkup-run>Run the check-up</button></div><div data-checkup-output aria-live="polite"></div>`;
  const button = root.querySelector<HTMLButtonElement>('[data-checkup-run]') as HTMLButtonElement;
  const output = root.querySelector<HTMLElement>('[data-checkup-output]') as HTMLElement;
  let run = 0;

  const status = (kind: 'working' | 'ok' | 'error', title: string, body = ''): void => {
    output.innerHTML = `<div class="status ${kind === 'working' ? '' : kind}"><b>${escapeHtml(title)}</b>${body ? `<br>${body}` : ''}</div>`;
  };

  function show(result: Checkup, first: RingAddressView, labels: RingLabels, more: boolean): void {
    const cards = checkupCards(result, { counterparties: first.counterparties, labels });
    const { counts } = first;
    const facts: Array<[string, string]> = [
      ['Registered to receive privately', first.registered === null ? 'Not read' : first.registered ? 'Yes' : 'No'],
      ['Shields', String(counts.shields)],
      ['Unshields', String(counts.unshields)],
      ['Pool trades', String(counts.trades)],
      ['Private transfers sent', String(counts.sent)],
      ['Paid into this wallet', String(counts.received)],
    ];
    output.innerHTML = `<dl class="checkup-facts">${facts.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>
<div class="checkup-cards">${cards.map((card) => `<article class="checkup-card is-${card.level}"><h3>${escapeHtml(card.title)}</h3><p>${card.html}</p></article>`).join('')}</div>
<p class="tiny dim" style="margin:14px 0 0">${escapeHtml(coverageText(result, { more, since: first.since, complete: first.complete, address: first.address }))} <a class="tx-link" href="/rings?address=${encodeURIComponent(first.address)}">The same rows, as anyone sees them</a></p>`;
  }

  button.addEventListener('click', async () => {
    const wallet = address();
    if (!wallet) return;
    run += 1;
    const mine = run;
    const current = (): boolean => mine === run && address() === wallet;
    button.disabled = true;
    status('working', 'READING', 'Reading what the chain shows about this wallet…');
    try {
      const first = await api.ringAddress(wallet);
      const rows: RingRow[] = [...first.rows];
      const labels: Record<string, RingLabels[string]> = { ...first.labels };
      let next = first.next;
      for (let page = 1; page < PAGES && next; page += 1) {
        const view = await api.ringAddress(wallet, next);
        rows.push(...view.rows);
        Object.assign(labels, view.labels);
        next = view.next;
      }
      if (!current()) return;
      show(checkup(rows, wallet), first, labels, next !== null);
      button.textContent = 'Run it again';
    } catch (error) {
      if (!current()) return;
      if (error instanceof ApiError && error.code === 'RINGS_OFF') {
        status('error', 'NOTHING TO READ', 'This site is not following Rings activity at the moment, so the check-up has no rows to look at.');
      } else {
        status('error', 'NOT READ', escapeHtml(describeError(error)));
      }
    } finally {
      button.disabled = false;
    }
  });

  return {
    reset(): void {
      run += 1;
      output.innerHTML = '';
      button.textContent = 'Run the check-up';
    },
  };
}
