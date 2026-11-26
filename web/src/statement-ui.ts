/**
 * The Statement box: a wallet's private history for a period, with totals
 * and a CSV file to download. The wallet page and the read-only page both
 * mount it, each handing in its own view of the history.
 *
 * Everything is put together in this browser. The server is asked for three
 * public things only: block times, the wallets a transaction named, and how
 * a token writes its amounts.
 */

import type { HistoryRow } from '../../shared/src/payrecords.js';
import { memoOf } from '../../shared/src/payrecords.js';
import { type PeriodKind, type Statement, type StatementPeriod, buildStatement, periodOf, statementCsv, statementFileName } from '../../shared/src/statement.js';
import { formatUnits, groupDigits } from '../../shared/src/units.js';
import { blockTimes, walletsNamed } from './chain-facts.js';
import { ringsClient } from './chain.js';
import { readMemos } from './local-records.js';
import { type TokenFact, tokenFacts } from './token-facts.js';
import { describeError, escapeHtml } from './ui.js';

export interface StatementSource {
  /** The wallet the statement is for, or null when none is open. */
  address(): string | null;
  /** Its private history, or null while that has not been read. */
  rows(): readonly HistoryRow[] | null;
  /** What to say when the history is not there. */
  notReady(): string;
}

export interface StatementBox {
  /** The wallet changed, or was closed: what was built for the one before is taken off the screen. */
  reset(): void;
}

const PERIODS: ReadonlyArray<readonly [PeriodKind, string]> = [
  ['all', 'All time'],
  ['month', 'This month'],
  ['last-month', 'Last month'],
  ['year', 'This year'],
  ['last-year', 'Last year'],
  ['custom', 'Between two days'],
];

let boxes = 0;

export function mountStatement(root: HTMLElement, source: StatementSource): StatementBox {
  boxes += 1;
  const id = `st${boxes}`;
  root.innerHTML = `<form class="statement-form" novalidate>
<label class="field"><span>Period</span><select id="${id}-period">${PERIODS.map(([value, label]) => `<option value="${value}">${escapeHtml(label)}</option>`).join('')}</select><div class="hint">Months, years and days are counted in UTC, like the dates in the file.</div></label>
<div class="grid-2 statement-days" id="${id}-days" hidden><label class="field"><span>From</span><input type="date" id="${id}-from"></label><label class="field"><span>To, included</span><input type="date" id="${id}-to"></label></div>
<button class="btn" type="submit" id="${id}-build">Build statement</button>
</form>
<div id="${id}-output" aria-live="polite"></div>`;
  const node = <T extends HTMLElement>(name: string): T => root.querySelector<T>(`#${id}-${name}`) as T;
  const output = node('output');
  const periodSelect = node<HTMLSelectElement>('period');
  let run = 0;
  let download: string | null = null;

  const status = (kind: 'working' | 'ok' | 'error', title: string, body = ''): void => {
    output.innerHTML = `<div class="status ${kind === 'working' ? '' : kind}"><b>${escapeHtml(title)}</b>${body ? `<br>${body}` : ''}</div>`;
  };

  function clear(): void {
    run += 1;
    if (download) URL.revokeObjectURL(download);
    download = null;
    output.innerHTML = '';
  }

  periodSelect.addEventListener('change', () => {
    node('days').hidden = periodSelect.value !== 'custom';
  });

  function show(statement: Statement, period: StatementPeriod, address: string, unread: number): void {
    const { rows, totals, undated } = statement;
    if (rows.length === 0) {
      status('ok', 'NOTHING IN THIS PERIOD', `No private activity of this wallet falls in ${escapeHtml(period.label)}.`);
      return;
    }
    if (download) URL.revokeObjectURL(download);
    download = URL.createObjectURL(new Blob([statementCsv(rows)], { type: 'text/csv;charset=utf-8' }));
    const amount = (units: bigint, decimals: number): string => escapeHtml(groupDigits(formatUnits(units, decimals)));
    const net = (received: bigint, sent: bigint, decimals: number): string => {
      const value = received - sent;
      return `${value > 0n ? '+' : ''}${escapeHtml(groupDigits(formatUnits(value, decimals)))}`;
    };
    const lines = totals
      .map(
        (total) =>
          `<tr><td>${escapeHtml(total.symbol)}</td><td class="num">${amount(total.received, total.decimals)}</td><td class="num">${amount(total.sent, total.decimals)}</td><td class="num">${net(total.received, total.sent, total.decimals)}</td><td class="num">${total.rows}</td></tr>`,
      )
      .join('');
    const notes: string[] = [];
    if (undated > 0) {
      notes.push(
        `<b>${undated === 1 ? '1 transaction has' : `${undated} transactions have`} no date</b>: the chain did not give one just now. ${undated === 1 ? 'It is' : 'They are'} at the top of the file, and may belong to another period. Build again in a moment to date ${undated === 1 ? 'it' : 'them'}.`,
      );
    }
    if (unread > 0) {
      notes.push(`For ${unread === 1 ? '1 private transfer' : `${unread} private transfers`} the other wallet could not be read just now, so that cell is empty. Build again in a moment to fill it in.`);
    }
    output.innerHTML = `<div class="status ok"><b>STATEMENT READY</b><br>${escapeHtml(period.label)} · ${rows.length === 1 ? '1 row' : `${rows.length} rows`}</div>
<div class="table-wrap statement-totals"><table><thead><tr><th>Token</th><th class="num">Came in</th><th class="num">Went out</th><th class="num">Net</th><th class="num">Rows</th></tr></thead><tbody>${lines}</tbody></table></div>
${notes.map((note) => `<p class="small muted statement-note">${note}</p>`).join('')}
<div class="row-wrap" style="margin-top:14px"><a class="btn" href="${download}" download="${escapeHtml(statementFileName(address, period))}">Download CSV</a></div>
<p class="tiny dim" style="margin:12px 0 0">One line a row: date, type, direction, token, amount, the change to the private balance, whether the amount was public, what it was traded for, the other wallet, the note this browser kept, the transaction and the token's address. A move within the wallet, like a consolidation, is listed with no change.</p>`;
  }

  root.querySelector('form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const address = source.address();
    const history = source.rows();
    if (!address || !history) {
      status('error', 'NOT READ YET', escapeHtml(source.notReady()));
      return;
    }
    const period = periodOf(periodSelect.value as PeriodKind, new Date(), node<HTMLInputElement>('from').value, node<HTMLInputElement>('to').value);
    if (!period) {
      status('error', 'CHECK THE DAYS', 'Pick days that exist, with the first no later than the last.');
      return;
    }
    run += 1;
    const mine = run;
    const current = (): boolean => mine === run && source.address() === address;
    const button = node<HTMLButtonElement>('build');
    button.disabled = true;
    try {
      if (history.length === 0) {
        status('ok', 'NOTHING YET', 'This wallet has no private activity to put in a statement.');
        return;
      }
      status('working', 'BUILDING', 'Reading how each token writes its amounts…');
      const facts: Map<string, TokenFact> = await tokenFacts(history.map((row) => row.asset));
      if (!current()) return;
      const times = await blockTimes(
        history.map((row) => row.slot),
        (done, total) => {
          if (current()) status('working', 'BUILDING', `Reading dates from the chain: ${done} of ${total}.`);
        },
      );
      if (!current()) return;
      // Only rows that can end up in the statement are asked about: the dated ones in the period, and the undated ones.
      const inPeriod = history.filter((row) => {
        const at = times.get(row.slot.toString());
        return at === undefined || ((period.from === null || at >= period.from) && (period.to === null || at < period.to));
      });
      const transfers = [...new Set(inPeriod.filter((row) => row.kind === 'privateTransfer').map((row) => row.signature))];
      let named = new Map<string, readonly string[]>();
      let unread = 0;
      if (transfers.length > 0) {
        const read = await walletsNamed(await ringsClient(), transfers, (done, total) => {
          if (current()) status('working', 'BUILDING', `Reading which wallet each private transfer named: ${done} of ${total}.`);
        });
        named = read.tags;
        unread = transfers.filter((signature) => !named.has(signature)).length;
      }
      if (!current()) return;
      const memos = readMemos(address);
      const statement = buildStatement(
        history,
        {
          time: (slot) => times.get(slot.toString()) ?? null,
          label: (mint) => facts.get(mint) ?? { symbol: mint, decimals: 0 },
          others: (signature) => (named.get(signature) ?? []).filter((wallet) => wallet !== address),
          memo: (signature) => memoOf(memos, signature),
        },
        period,
      );
      show(statement, period, address, unread);
    } catch (error) {
      if (current()) status('error', 'NOT BUILT', escapeHtml(describeError(error)));
    } finally {
      button.disabled = false;
    }
  });

  return { reset: clear };
}
