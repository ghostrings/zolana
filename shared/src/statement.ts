/**
 * A wallet's statement: its private history as a table somebody else can
 * read, for a period, with totals.
 *
 * It is built in the browser from what the wallet's own keys decrypt. The
 * server never sees a row of it. Three things the private history does not
 * carry are looked up and handed in here as `facts`: when each transaction
 * happened (from the chain), which other wallet a private transfer named
 * (public, from the Rings indexer), and the notes this browser kept.
 *
 * Everything in this file is pure, so the same code makes the statement on
 * the wallet page and on the read-only page, and the tests can hold it to
 * the cent.
 */

import type { HistoryRow } from './payrecords.js';
import { formatUnits } from './units.js';

export const STATEMENT_KINDS: Readonly<Record<string, string>> = Object.freeze({
  deposit: 'Shield',
  publicWithdrawal: 'Unshield',
  privateTransfer: 'Private transfer',
  ringEntry: 'Ring entry',
  split: 'Split',
  merge: 'Consolidation',
});

export interface StatementFacts {
  /** Block time of a slot in seconds since 1970, or null when it could not be read. */
  time(slot: bigint): number | null;
  /** How to write a token: its ticker and decimals. `native` is SOL itself, which has no token address. */
  label(mint: string): { readonly symbol: string; readonly decimals: number; readonly native?: boolean };
  /** The other wallets a transaction named in public. Empty when there are none, or they were not read. */
  others(signature: string): readonly string[];
  /** What this browser kept about a transaction it sent. */
  memo(signature: string): { readonly to?: string; readonly note?: string } | undefined;
}

export interface StatementRow {
  /** Seconds since 1970, or null when the date could not be read. */
  readonly at: number | null;
  /** `2026-11-25 07:51:09`, in UTC. Empty when undated. */
  readonly date: string;
  readonly type: string;
  readonly direction: 'In' | 'Out' | 'Self';
  readonly symbol: string;
  /** What the wallet's history calls the asset. Totals are kept by it. */
  readonly mint: string;
  /** The token's mint address as the file shows it. Empty for SOL, which is not a token and has none. */
  readonly tokenAddress: string;
  /** The amount moved, as a plain decimal number. */
  readonly amount: string;
  /** The same with its sign: what it did to the private balance. Zero for a move within the wallet. */
  readonly change: string;
  /** Base units, signed. */
  readonly delta: bigint;
  readonly decimals: number;
  /** Whether the amount was in the open on chain. */
  readonly amountOnChain: 'Public' | 'Hidden';
  /** When the same transaction also moved another token the other way: that token, as in a trade. */
  readonly tradedFor: string;
  readonly counterparty: string;
  readonly note: string;
  readonly signature: string;
  readonly slot: string;
}

export interface StatementPeriod {
  /** Seconds since 1970, inclusive. Null for no bound. */
  readonly from: number | null;
  /** Exclusive. */
  readonly to: number | null;
  readonly label: string;
}

export type PeriodKind = 'all' | 'month' | 'last-month' | 'year' | 'last-year' | 'custom';
export const PERIOD_KINDS: readonly PeriodKind[] = ['all', 'month', 'last-month', 'year', 'last-year', 'custom'];

const pad = (value: number): string => String(value).padStart(2, '0');
const dayText = (date: Date): string => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
const utc = (year: number, month: number, day = 1): number => Date.UTC(year, month, day) / 1000;

/** `2026-11-25 07:51:09` in UTC. */
export function utcStamp(seconds: number): string {
  const date = new Date(seconds * 1000);
  return `${dayText(date)} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

/** Reads `2026-11-25` as the start of that day in UTC. Null when it is not a date that exists. */
export function parseDay(text: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.getTime() / 1000;
}

/**
 * The bounds of a period, in UTC. For `custom`, `from` and `to` are days as
 * `YYYY-MM-DD`, both included; either may be left out. Null when the days
 * given are not days, or are the wrong way round.
 */
export function periodOf(kind: PeriodKind, now: Date, from = '', to = ''): StatementPeriod | null {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const monthName = (y: number, m: number): string => `${y}-${pad(m + 1)}`;
  switch (kind) {
    case 'all':
      return { from: null, to: null, label: 'All time' };
    case 'month':
      return { from: utc(year, month), to: utc(year, month + 1), label: monthName(year, month) };
    case 'last-month': {
      const start = new Date(Date.UTC(year, month - 1, 1));
      return { from: start.getTime() / 1000, to: utc(year, month), label: monthName(start.getUTCFullYear(), start.getUTCMonth()) };
    }
    case 'year':
      return { from: utc(year, 0), to: utc(year + 1, 0), label: String(year) };
    case 'last-year':
      return { from: utc(year - 1, 0), to: utc(year, 0), label: String(year - 1) };
    case 'custom': {
      const start = from.trim() ? parseDay(from) : null;
      const endDay = to.trim() ? parseDay(to) : null;
      if ((from.trim() && start === null) || (to.trim() && endDay === null)) return null;
      const end = endDay === null ? null : endDay + 86_400;
      if (start !== null && end !== null && end <= start) return null;
      const label = start === null && end === null ? 'All time' : `${start === null ? 'start' : dayText(new Date(start * 1000))} to ${endDay === null ? 'now' : dayText(new Date(endDay * 1000))}`;
      return { from: start, to: end, label };
    }
    default:
      return null;
  }
}

export interface Statement {
  /** Oldest first. Undated rows, which can belong to any period, come first of all. */
  readonly rows: readonly StatementRow[];
  /** Rows whose date could not be read. They are in `rows`, at the top. */
  readonly undated: number;
  readonly totals: readonly StatementTotal[];
}

export interface StatementTotal {
  readonly mint: string;
  readonly symbol: string;
  readonly decimals: number;
  /** Base units that came into the private balance, and that left it, over the rows. */
  readonly received: bigint;
  readonly sent: bigint;
  readonly rows: number;
}

/**
 * Builds the statement of `entries` for `period`. A row with a date outside
 * the period is left out; a row without one is kept and counted in
 * `undated`, because leaving a transaction out of a statement without saying
 * so is the one thing a statement must never do.
 */
export function buildStatement(entries: readonly HistoryRow[], facts: StatementFacts, period: StatementPeriod): Statement {
  // What else each transaction moved, to pair the two halves of a trade.
  const bySignature = new Map<string, HistoryRow[]>();
  for (const entry of entries) bySignature.set(entry.signature, [...(bySignature.get(entry.signature) ?? []), entry]);

  const rows: StatementRow[] = [];
  let undated = 0;
  for (const entry of entries) {
    const at = facts.time(entry.slot);
    if (at === null) undated += 1;
    else if ((period.from !== null && at < period.from) || (period.to !== null && at >= period.to)) continue;
    const { symbol, decimals, native } = facts.label(entry.asset);
    const direction = entry.direction === 'inbound' ? 'In' : entry.direction === 'outbound' ? 'Out' : 'Self';
    const delta = direction === 'In' ? entry.amount : direction === 'Out' ? -entry.amount : 0n;
    const memo = facts.memo(entry.signature);
    const siblings = (bySignature.get(entry.signature) ?? []).filter((other) => other.asset !== entry.asset && other.direction !== 'selfTransfer' && other.direction !== entry.direction && direction !== 'Self');
    const others = facts.others(entry.signature);
    const boundary = entry.kind === 'deposit' || entry.kind === 'publicWithdrawal';
    rows.push({
      at,
      date: at === null ? '' : utcStamp(at),
      type: STATEMENT_KINDS[entry.kind] ?? entry.kind,
      direction,
      symbol,
      mint: entry.asset,
      tokenAddress: native === true ? '' : entry.asset,
      amount: formatUnits(entry.amount, decimals),
      change: delta === 0n ? '0' : formatUnits(delta, decimals),
      delta,
      decimals,
      amountOnChain: boundary ? 'Public' : 'Hidden',
      tradedFor: [...new Set(siblings.map((other) => facts.label(other.asset).symbol))].join(' '),
      counterparty: others.length > 0 ? others.join(' ') : (memo?.to ?? ''),
      note: memo?.note ?? '',
      signature: entry.signature,
      slot: entry.slot.toString(),
    });
  }
  rows.sort((a, b) => {
    if (a.at === null || b.at === null) return a.at === b.at ? 0 : a.at === null ? -1 : 1;
    if (a.at !== b.at) return a.at - b.at;
    return a.slot === b.slot ? 0 : BigInt(a.slot) < BigInt(b.slot) ? -1 : 1;
  });

  const totals = new Map<string, { symbol: string; decimals: number; received: bigint; sent: bigint; rows: number }>();
  for (const row of rows) {
    const total = totals.get(row.mint) ?? { symbol: row.symbol, decimals: row.decimals, received: 0n, sent: 0n, rows: 0 };
    if (row.delta > 0n) total.received += row.delta;
    if (row.delta < 0n) total.sent += -row.delta;
    total.rows += 1;
    totals.set(row.mint, total);
  }
  return { rows, undated, totals: [...totals.entries()].map(([mint, total]) => ({ mint, ...total })) };
}

/* ------------------------------------------------------------------ */
/* CSV                                                                 */
/* ------------------------------------------------------------------ */

export const STATEMENT_COLUMNS = ['Date (UTC)', 'Type', 'Direction', 'Token', 'Amount', 'Change', 'Amount on chain', 'Traded for', 'Counterparty', 'Note', 'Transaction', 'Slot', 'Token address'] as const;

/**
 * One cell of a CSV file. Text that somebody else wrote (a token's ticker, a
 * note) could start with a character a spreadsheet takes for a formula; such
 * a cell gets an apostrophe in front, which a spreadsheet shows as text. A
 * cell with a comma, a quote or a line break is quoted.
 */
export function csvCell(value: string, foreign = true): string {
  let text = value;
  if (foreign && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** The statement as a CSV file: a header line and one line a row, CRLF between them, as spreadsheets expect. */
export function statementCsv(rows: readonly StatementRow[]): string {
  const lines = [STATEMENT_COLUMNS.map((column) => csvCell(column, false)).join(',')];
  for (const row of rows) {
    lines.push(
      [
        csvCell(row.date, false),
        csvCell(row.type),
        csvCell(row.direction, false),
        csvCell(row.symbol),
        // Numbers this file wrote itself: a leading minus is a minus.
        csvCell(row.amount, false),
        csvCell(row.change, false),
        csvCell(row.amountOnChain, false),
        csvCell(row.tradedFor),
        csvCell(row.counterparty),
        csvCell(row.note),
        csvCell(row.signature),
        csvCell(row.slot, false),
        csvCell(row.tokenAddress),
      ].join(','),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}

/** A file name for a statement: letters, digits, dots and dashes only. */
export function statementFileName(address: string, period: StatementPeriod): string {
  const tidy = (text: string): string => text.replace(/[^A-Za-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '');
  return `privacycash-statement-${tidy(address.slice(0, 8))}-${tidy(period.label.toLowerCase())}.csv`;
}
