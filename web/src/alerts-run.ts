/**
 * Arrival alerts: the working half, loaded only once alerts are on.
 *
 * One look reads the wallet's private history through the header panel's own
 * view of the wallet (so it never touches the notes a page is building a
 * transaction from), compares it with what was seen at the last look, and
 * says what is new. The first look after alerts are turned on announces
 * nothing: it only notes where the history stands.
 */

import { SOL_MINT } from '../../shared/src/privacy.js';
import { arrivalsSince, firstLook, matchRequests, rowKey } from '../../shared/src/payrecords.js';
import type { AlertSettings } from './alert-settings.js';
import { arrivalLines, arrivalText, systemText } from './alert-words.js';
import { keepSeen, ownSlots, readRequests, readSeen } from './local-records.js';
import { pageUsesWallet } from './session-bus.js';
import { type TokenFact, tokenFacts } from './token-facts.js';
import { toast } from './ui.js';
import { activeAddress } from './vault.js';
import { forgetReader, readRows } from './wallet-pop-data.js';

/** How long an arrival stays on screen. */
const SHOWN_MS = 9_000;
/** What arrived while the tab was in the background, for when it is looked at again. */
let pending: string[] = [];

export const ARRIVAL_EVENT = 'pcf:arrival';

function show(lines: readonly string[]): void {
  for (const line of arrivalLines(lines)) toast(line, 'ok', SHOWN_MS);
}

/** The tab is in view again: what arrived meanwhile is shown now. */
export function showPending(): void {
  if (pending.length === 0 || document.hidden) return;
  const lines = pending;
  pending = [];
  show(lines);
}

/** No wallet is open in this tab any more: the view of the last one, with its keys, is dropped. */
export function forget(): void {
  pending = [];
  forgetReader();
}

export async function look(address: string, settings: AlertSettings): Promise<void> {
  // A page that works with the wallet keeps its own copy of the notes; this read then saves none.
  const rows = await readRows(address, !pageUsesWallet());
  if (activeAddress() !== address) return;
  const seen = readSeen(address);
  if (!seen) {
    keepSeen(address, firstLook(rows));
    return;
  }
  const { arrivals, state } = arrivalsSince(seen, rows, ownSlots(address));
  keepSeen(address, state);
  if (arrivals.length === 0) return;

  let facts = new Map<string, TokenFact>();
  try {
    facts = await tokenFacts(arrivals.map((row) => row.asset));
  } catch {
    // Without a token's decimals its amount is not written; that something arrived is still said.
  }
  const requests = readRequests(address).items;
  const fits = new Map([...matchRequests(requests, rows, SOL_MINT as string)].map(([id, row]) => [rowKey(row), requests.find((request) => request.id === id)] as const));
  const lines = arrivals.map((row) => arrivalText(row, facts.get(row.asset), fits.get(rowKey(row))));

  if (document.hidden) {
    pending = [...pending, ...lines].slice(-20);
    if (settings.system && 'Notification' in window && Notification.permission === 'granted') {
      try {
        new Notification('privacycash.fun', { body: systemText(arrivals.length), tag: 'pcf-arrival' });
      } catch {
        // A browser that will not show it has still kept the lines for later.
      }
    }
  } else {
    show(lines);
  }
  // A page that shows this wallet's balance reads it again.
  document.dispatchEvent(new CustomEvent(ARRIVAL_EVENT, { detail: { address, count: arrivals.length } }));
}
