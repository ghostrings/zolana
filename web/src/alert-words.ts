/**
 * What an arrival alert says. Kept apart from the watcher so the wording can
 * be tested: it names an amount only when the token's decimals are known,
 * and it never says what a payment was for, only what request it fits.
 */

import type { HistoryRow, PayRequestRecord } from '../../shared/src/payrecords.js';
import { formatUnits, groupDigits } from '../../shared/src/units.js';

export interface ArrivalFact {
  readonly symbol: string;
  readonly decimals: number;
}

const OPENINGS: Readonly<Record<string, string>> = Object.freeze({
  privateTransfer: 'Private payment received',
  deposit: 'Shielded into your wallet',
  ringEntry: 'Arrived through a ring',
});

/** One arrival, in a line. */
export function arrivalText(row: Pick<HistoryRow, 'kind' | 'asset' | 'amount'>, fact: ArrivalFact | undefined, request?: Pick<PayRequestRecord, 'note'> | undefined): string {
  const opening = OPENINGS[row.kind] ?? 'Arrived in your wallet';
  const amount = fact ? `: ${groupDigits(formatUnits(row.amount, fact.decimals))} ${fact.symbol}` : '';
  const fits = request ? ` It fits ${request.note ? `your request “${request.note}”` : 'a request you made'}: the same token and amount.` : '';
  return `${opening}${amount}.${fits}`;
}

/** At most `limit` lines, and one more saying how many were left out. */
export function arrivalLines(lines: readonly string[], limit = 3): string[] {
  if (lines.length <= limit) return [...lines];
  const rest = lines.length - limit;
  return [...lines.slice(0, limit), `And ${rest} more ${rest === 1 ? 'arrival' : 'arrivals'}. See Activity in your wallet.`];
}

/** What a system notification says: that something arrived, never what or how much. */
export function systemText(count: number): string {
  return count === 1 ? 'Something arrived in your wallet.' : `${count} things arrived in your wallet.`;
}
