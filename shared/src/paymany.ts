/**
 * Paying a list of wallets from a private balance, one confidential transfer
 * each: reading the list, keeping track of a run, and writing its receipt.
 *
 * WHAT A RUN IS
 *   One private transfer per line, sent one after another from the wallet in
 *   use. On chain each looks like any private transfer on the Default Ring:
 *   the two wallets are public, the token and the amount are encrypted. Sent
 *   in a row from one wallet they are also, to anyone who looks, plainly one
 *   wallet paying a list.
 *
 * NEVER TWICE
 *   A payment's signature is written down before its transaction is handed
 *   to the network. From then on the line is `sent`, and it is never built
 *   again until the chain has said what became of that signature. Landed is
 *   `paid`. Refused, rejected or too old to ever land is `failed`, which here
 *   always means that nothing moved, and is the only state a retry starts
 *   from.
 *
 * Everything in this file is pure: text in, text out. The page does the
 * storing and the sending.
 */

import { isAddress } from '@solana/kit';

import { PAY_NOTE_MAX, cleanNote } from './paylink.js';
import { csvCell, utcStamp } from './statement.js';
import { AmountError, formatUnits, parseUnits } from './units.js';

/** The most payments one run makes. A longer list is split by the person paying, not cut short here. */
export const PAY_MANY_MAX = 25;
/** The longest list text that is read at all. */
export const PAY_MANY_MAX_CHARS = 20_000;

/* ------------------------------------------------------------------ */
/* Reading the list                                                    */
/* ------------------------------------------------------------------ */

export interface PayEntry {
  /** The line of the list it came from, counted from 1. */
  readonly line: number;
  readonly to: string;
  /** Base units. */
  readonly units: bigint;
  readonly note: string;
}

export interface PayProblem {
  readonly line: number;
  /** The line as it was written, cut short. */
  readonly text: string;
  readonly problem: string;
}

export interface PayList {
  readonly entries: readonly PayEntry[];
  readonly problems: readonly PayProblem[];
  /** The sum of every entry, in base units. */
  readonly total: bigint;
  /** Addresses that are paid more than once. Allowed; pointed out so that it is on purpose. */
  readonly repeated: readonly string[];
}

const HEADER_WORDS: ReadonlySet<string> = new Set(['address', 'wallet', 'recipient', 'to', 'solana address', 'wallet address']);
/** A note made of digits alone, right after an amount, is far more often the rest of a number written with a comma or a space. */
const LOOKS_NUMERIC = /^[0-9][0-9.,]*$/;

/** What separates the parts of a line: one comma, semicolon or tab (with any spaces around it), or a run of spaces. */
const SEPARATOR = /\s*[,;\t]\s*|\s+/;

/** The text up to the first separator, and the text after it. */
function cut(text: string): [string, string] {
  const found = SEPARATOR.exec(text);
  return found ? [text.slice(0, found.index), text.slice(found.index + found[0].length)] : [text, ''];
}

/**
 * The address, the amount, the note, and the first word of the note. The
 * line is read from the left, one part at a time, so that it comes apart the
 * same way whichever separators were used and however they were mixed.
 */
function cellsOf(line: string): [string, string, string, string] {
  const [to, afterTo] = cut(line);
  const [amount, note] = cut(afterTo);
  return [to, amount, note.trim(), cut(note)[0]];
}

/**
 * Reads a pasted list: one payment per line, as `address, amount` or
 * `address, amount, note`. Commas, semicolons, tabs or spaces separate the
 * parts. Empty lines, lines starting with `#` and one heading line are
 * skipped. Every other line becomes a payment or a problem; nothing is
 * guessed, corrected or left out in silence.
 *
 * `self` is the paying wallet, which cannot pay itself.
 */
export function parsePayList(text: string, decimals: number, self: string): PayList {
  const entries: PayEntry[] = [];
  const problems: PayProblem[] = [];
  if (text.length > PAY_MANY_MAX_CHARS) {
    return { entries, problems: [{ line: 0, text: '', problem: `The list is too long to read here. A run pays at most ${PAY_MANY_MAX} wallets: split it.` }], total: 0n, repeated: [] };
  }
  const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/);
  let first = true;
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const number = index + 1;
    const shown = line.length > 90 ? `${line.slice(0, 90)}…` : line;
    const [to, amountText, noteText, afterAmount] = cellsOf(line);
    const wasFirst = first;
    first = false;
    if (wasFirst && !isAddress(to) && HEADER_WORDS.has(to.toLowerCase())) continue;
    const fail = (problem: string): void => void problems.push({ line: number, text: shown, problem });

    if (!isAddress(to)) {
      fail('This does not start with a Solana address.');
      continue;
    }
    if (to === self) {
      fail('This is the wallet you are paying from.');
      continue;
    }
    if (amountText === '') {
      fail('There is no amount after the address.');
      continue;
    }
    let units: bigint;
    try {
      units = parseUnits(amountText, decimals);
    } catch (error) {
      fail(error instanceof AmountError ? `The amount cannot be read. ${error.message} Use a point for decimals and no thousands separators.` : 'The amount cannot be read.');
      continue;
    }
    if (units <= 0n) {
      fail('The amount is zero.');
      continue;
    }
    if (afterAmount !== '' && LOOKS_NUMERIC.test(afterAmount)) {
      fail(`After the amount ${amountText} comes “${afterAmount}”, which looks like the rest of a number. Write amounts with a point for decimals and no thousands separators (1000.5). If it is a note, put a word in front of it.`);
      continue;
    }
    const note = cleanNote(noteText, PAY_NOTE_MAX);
    if (cleanNote(noteText, PAY_NOTE_MAX * 4).length > PAY_NOTE_MAX) {
      fail(`The note is longer than ${PAY_NOTE_MAX} characters.`);
      continue;
    }
    if (entries.length >= PAY_MANY_MAX) {
      fail(`A run pays at most ${PAY_MANY_MAX} wallets. Put this one in a second run.`);
      continue;
    }
    entries.push({ line: number, to, units, note });
  }
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.to)) repeated.add(entry.to);
    seen.add(entry.to);
  }
  return { entries, problems, total: entries.reduce((sum, entry) => sum + entry.units, 0n), repeated: [...repeated] };
}

/* ------------------------------------------------------------------ */
/* A run                                                               */
/* ------------------------------------------------------------------ */

/**
 * `todo`    not sent. Nothing has moved.
 * `sent`    signed and handed to the network; what became of it is not known yet.
 * `paid`    landed on chain.
 * `failed`  refused before it was sent, rejected on chain, or too old to ever land. Nothing moved.
 * `left`    never part of the sending: the wallet could not be paid privately when the run was made.
 */
export type PayState = 'todo' | 'sent' | 'paid' | 'failed' | 'left';

export const PAY_STATE_LABELS: Readonly<Record<PayState, string>> = Object.freeze({
  todo: 'To pay',
  sent: 'Sent, not confirmed yet',
  paid: 'Paid',
  failed: 'Not paid',
  left: 'Left out',
});

export interface PayItem {
  readonly to: string;
  /** Base units, as a decimal string. */
  readonly units: string;
  readonly note: string;
  readonly state: PayState;
  readonly signature?: string;
  /** The last block height the sent transaction can land in, as a decimal string. */
  readonly lastValid?: string;
  /** When it was sent, and then when it was seen to have landed. Milliseconds since 1970. */
  readonly at?: number;
  /** Why it was not paid. */
  readonly reason?: string;
}

export interface PayRun {
  readonly v: 1;
  readonly id: string;
  /** The wallet that pays. */
  readonly wallet: string;
  readonly mint: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly createdAt: number;
  readonly items: readonly PayItem[];
}

export class PayRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayRunError';
  }
}

export function newRun(input: {
  readonly id: string;
  readonly wallet: string;
  readonly mint: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly now: number;
  readonly entries: readonly PayEntry[];
  /** Entries that cannot be paid privately, by their position in `entries`, with the reason. */
  readonly leftOut?: ReadonlyMap<number, string>;
}): PayRun {
  if (input.entries.length === 0 || input.entries.length > PAY_MANY_MAX) throw new PayRunError(`A run pays between 1 and ${PAY_MANY_MAX} wallets.`);
  return {
    v: 1,
    id: input.id,
    wallet: input.wallet,
    mint: input.mint,
    symbol: input.symbol,
    decimals: input.decimals,
    createdAt: input.now,
    items: input.entries.map((entry, index) => {
      const reason = input.leftOut?.get(index);
      return reason === undefined
        ? { to: entry.to, units: entry.units.toString(), note: entry.note, state: 'todo' as const }
        : { to: entry.to, units: entry.units.toString(), note: entry.note, state: 'left' as const, reason };
    }),
  };
}

function itemAt(run: PayRun, index: number): PayItem {
  const item = run.items[index];
  if (!item) throw new PayRunError('There is no such payment in this run.');
  return item;
}

function replaced(run: PayRun, index: number, item: PayItem): PayRun {
  return { ...run, items: run.items.map((existing, position) => (position === index ? item : existing)) };
}

/**
 * Writes down a payment's signature. Only a payment that has not been sent
 * can become sent: asking for anything else is a mistake in the caller, and
 * is refused rather than risk a second transaction for one line.
 */
export function markSent(run: PayRun, index: number, signature: string, lastValid: bigint, now: number): PayRun {
  const item = itemAt(run, index);
  if (item.state !== 'todo') throw new PayRunError('This payment has already been sent or settled. It is not sent again.');
  if (signature === '' || lastValid <= 0n) throw new PayRunError('A sent payment needs its signature and the last block it can land in.');
  return replaced(run, index, { to: item.to, units: item.units, note: item.note, state: 'sent', signature, lastValid: lastValid.toString(), at: now });
}

/** The chain has the payment. */
export function markPaid(run: PayRun, index: number, now: number): PayRun {
  const item = itemAt(run, index);
  if (item.state !== 'sent') throw new PayRunError('Only a payment that was sent can be marked as paid.');
  return replaced(run, index, { ...item, state: 'paid', at: now });
}

/**
 * The payment did not happen and cannot happen any more: it was refused
 * before it left, rejected on chain, or grew too old to land. Its signature
 * is kept, so the receipt can show which transaction that was.
 */
export function markFailed(run: PayRun, index: number, reason: string): PayRun {
  const item = itemAt(run, index);
  if (item.state !== 'sent' && item.state !== 'todo') throw new PayRunError('Only a payment that has not settled can be marked as not paid.');
  return replaced(run, index, { ...item, state: 'failed', reason });
}

/** Puts every payment that did not happen back in line. Their old signatures are dropped: those transactions can never land. */
export function retryFailed(run: PayRun): PayRun {
  return { ...run, items: run.items.map((item) => (item.state === 'failed' ? { to: item.to, units: item.units, note: item.note, state: 'todo' as const } : item)) };
}

/** The next payment to send, or -1 when none is waiting. */
export function nextTodo(run: PayRun): number {
  return run.items.findIndex((item) => item.state === 'todo');
}

/** Payments that were sent and whose outcome is not known. Nothing more is sent while there is one. */
export function unsettled(run: PayRun): number[] {
  return run.items.flatMap((item, index) => (item.state === 'sent' ? [index] : []));
}

export interface PayTotals {
  readonly count: Readonly<Record<PayState, number>>;
  /** Base units by state. */
  readonly units: Readonly<Record<PayState, bigint>>;
}

export function runTotals(run: PayRun): PayTotals {
  const count: Record<PayState, number> = { todo: 0, sent: 0, paid: 0, failed: 0, left: 0 };
  const units: Record<PayState, bigint> = { todo: 0n, sent: 0n, paid: 0n, failed: 0n, left: 0n };
  for (const item of run.items) {
    count[item.state] += 1;
    units[item.state] += BigInt(item.units);
  }
  return { count, units };
}

/** True when nothing is waiting to be sent and nothing sent is still unknown. */
export function runFinished(run: PayRun): boolean {
  return run.items.every((item) => item.state !== 'todo' && item.state !== 'sent');
}

/**
 * True when two copies of a run stand at the same point: the same run, the
 * same lines, each in the same state under the same signature. A page checks
 * the copy it holds against the one on record before it sends anything, so
 * that a run moved on somewhere else (another tab) is never continued from a
 * stale copy.
 */
export function sameProgress(a: PayRun, b: PayRun): boolean {
  if (a.id !== b.id || a.wallet !== b.wallet || a.mint !== b.mint || a.items.length !== b.items.length) return false;
  return a.items.every((item, index) => {
    const other = b.items[index];
    return other !== undefined && item.to === other.to && item.units === other.units && item.state === other.state && (item.signature ?? '') === (other.signature ?? '');
  });
}

/* ------------------------------------------------------------------ */
/* The receipt                                                         */
/* ------------------------------------------------------------------ */

export const RECEIPT_COLUMNS = ['#', 'Recipient', 'Amount', 'Token', 'Status', 'Transaction', 'Date (UTC)', 'Note', 'Why not paid', 'Token address'] as const;

/**
 * The run as a file a bookkeeper can open: one row per line of the list, in
 * the list's order, paid or not. A `sent` row says in so many words that its
 * outcome is not known, so that the file never reads as proof of a payment
 * the chain has not confirmed.
 */
export function receiptCsv(run: PayRun, solMint: string): string {
  const rows = run.items.map((item, index) => {
    const dated = item.state === 'paid' || item.state === 'sent';
    return [
      String(index + 1),
      csvCell(item.to, false),
      formatUnits(BigInt(item.units), run.decimals),
      csvCell(run.symbol),
      csvCell(item.state === 'sent' ? 'Sent, NOT CONFIRMED: check the transaction' : PAY_STATE_LABELS[item.state], false),
      csvCell(item.signature ?? '', false),
      dated && item.at ? utcStamp(Math.floor(item.at / 1000)) : '',
      csvCell(item.note),
      csvCell(item.state === 'failed' || item.state === 'left' ? (item.reason ?? '') : ''),
      run.mint === solMint ? '' : csvCell(run.mint, false),
    ].join(',');
  });
  return `${[RECEIPT_COLUMNS.join(','), ...rows].join('\r\n')}\r\n`;
}

export function receiptFileName(run: PayRun): string {
  const day = utcStamp(Math.floor(run.createdAt / 1000)).slice(0, 10);
  return `privacycash-payout-${day}-${run.wallet.slice(0, 4)}-${run.id.slice(0, 6)}.csv`;
}

/* ------------------------------------------------------------------ */
/* Keeping a run                                                       */
/* ------------------------------------------------------------------ */

const STATES: ReadonlySet<string> = new Set(['todo', 'sent', 'paid', 'failed', 'left']);
const UNITS = /^[1-9][0-9]{0,19}$/;
const HEIGHT = /^[1-9][0-9]{0,18}$/;
/** A transaction signature in base58: 64 bytes. */
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

function readItem(value: unknown): PayItem | null {
  if (typeof value !== 'object' || value === null) return null;
  const item = value as Record<string, unknown>;
  if (typeof item.to !== 'string' || !isAddress(item.to)) return null;
  if (typeof item.units !== 'string' || !UNITS.test(item.units)) return null;
  if (typeof item.state !== 'string' || !STATES.has(item.state)) return null;
  const state = item.state as PayState;
  const note = cleanNote(item.note, PAY_NOTE_MAX);
  const signature = typeof item.signature === 'string' && SIGNATURE.test(item.signature) ? item.signature : undefined;
  const lastValid = typeof item.lastValid === 'string' && HEIGHT.test(item.lastValid) ? item.lastValid : undefined;
  const at = typeof item.at === 'number' && Number.isFinite(item.at) && item.at > 0 ? item.at : undefined;
  const reason = typeof item.reason === 'string' ? cleanNote(item.reason, 300) : undefined;
  // A payment that was sent or paid without its signature on record is not something to act on.
  if ((state === 'sent' || state === 'paid') && signature === undefined) return null;
  if (state === 'sent' && lastValid === undefined) return null;
  return {
    to: item.to,
    units: item.units,
    note,
    state,
    ...(signature === undefined || state === 'todo' || state === 'left' ? {} : { signature }),
    ...(lastValid === undefined || state !== 'sent' ? {} : { lastValid }),
    ...(at === undefined || state === 'todo' || state === 'left' ? {} : { at }),
    ...(reason === undefined || reason === '' || (state !== 'failed' && state !== 'left') ? {} : { reason }),
  };
}

/**
 * Reads a kept run back, for the wallet it belongs to. A run that does not
 * read cleanly in every line is not used at all: half a run would hide
 * payments that were made.
 */
export function parseRun(text: string | null | undefined, wallet: string): PayRun | null {
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const run = parsed as Record<string, unknown>;
  if (run.v !== 1 || run.wallet !== wallet) return null;
  if (typeof run.id !== 'string' || !/^[0-9a-z]{6,40}$/.test(run.id)) return null;
  if (typeof run.mint !== 'string' || !isAddress(run.mint)) return null;
  if (typeof run.symbol !== 'string' || run.symbol.length === 0 || run.symbol.length > 24) return null;
  if (typeof run.decimals !== 'number' || !Number.isInteger(run.decimals) || run.decimals < 0 || run.decimals > 18) return null;
  if (typeof run.createdAt !== 'number' || !Number.isFinite(run.createdAt) || run.createdAt <= 0) return null;
  if (!Array.isArray(run.items) || run.items.length === 0 || run.items.length > PAY_MANY_MAX) return null;
  const items: PayItem[] = [];
  for (const entry of run.items) {
    const item = readItem(entry);
    if (!item) return null;
    items.push(item);
  }
  return { v: 1, id: run.id, wallet, mint: run.mint, symbol: cleanNote(run.symbol, 24), decimals: run.decimals, createdAt: run.createdAt, items };
}
