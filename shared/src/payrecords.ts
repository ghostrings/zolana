/**
 * What a browser remembers about payments, beside what the chain holds.
 *
 * - A MEMO goes with a transaction this browser sent: the note it was paid
 *   with, and where an unshield went. The chain carries neither in a form a
 *   wallet's private history returns, so without this a statement could not
 *   show them.
 * - A REQUEST is a payment link this browser made, kept so it can be copied
 *   again and so an incoming payment of the same token and amount can be
 *   pointed out next to it.
 * - ARRIVALS are rows of a wallet's private history that were not there the
 *   last time it was looked at, and that the wallet did not cause itself.
 *
 * Everything here is pure: text in, text out. The page does the storing.
 * Nothing in these records is ever sent anywhere.
 */

import { PAY_SOL, cleanNote } from './paylink.js';

/* ------------------------------------------------------------------ */
/* Memos                                                               */
/* ------------------------------------------------------------------ */

export interface PayMemo {
  readonly signature: string;
  /** When this browser sent it, in milliseconds since 1970. */
  readonly at: number;
  /** Where it went, when the wallet's private history would not say: an unshield's destination. */
  readonly to?: string;
  readonly note?: string;
}

export interface MemoBook {
  readonly v: 1;
  /** Oldest first. */
  readonly items: readonly PayMemo[];
}

export const MEMO_LIMIT = 500;

const isText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;

/** Reads a stored book. Never throws: anything unreadable is an empty book. */
export function parseMemoBook(raw: string | null | undefined): MemoBook {
  const items: PayMemo[] = [];
  try {
    const parsed = JSON.parse(raw ?? 'null') as { items?: unknown } | null;
    for (const entry of Array.isArray(parsed?.items) ? parsed.items : []) {
      const item = entry as Partial<PayMemo> | null;
      if (!item || !isText(item.signature, 100) || typeof item.at !== 'number' || !Number.isFinite(item.at)) continue;
      const note = cleanNote(item.note);
      items.push({ signature: item.signature, at: item.at, ...(isText(item.to, 44) ? { to: item.to } : {}), ...(note ? { note } : {}) });
    }
  } catch {
    // An empty book.
  }
  return { v: 1, items: items.slice(-MEMO_LIMIT) };
}

/** The book with one memo added. A memo for the same transaction replaces the one before it. */
export function withMemo(book: MemoBook, memo: PayMemo): MemoBook {
  const note = cleanNote(memo.note);
  if (!memo.to && !note) return book;
  const kept = book.items.filter((item) => item.signature !== memo.signature);
  const next: PayMemo = { signature: memo.signature, at: memo.at, ...(memo.to ? { to: memo.to } : {}), ...(note ? { note } : {}) };
  return { v: 1, items: [...kept, next].slice(-MEMO_LIMIT) };
}

export function memoOf(book: MemoBook, signature: string): PayMemo | undefined {
  return book.items.find((item) => item.signature === signature);
}

/* ------------------------------------------------------------------ */
/* Requests                                                            */
/* ------------------------------------------------------------------ */

export interface PayRequestRecord {
  readonly id: string;
  readonly at: number;
  /** The chain's slot when the request was made. Only payments after it can be this request's. */
  readonly afterSlot: string;
  /** `SOL`, or a mint address. */
  readonly token: string;
  /** As the request shows it, or null when the payer chooses. */
  readonly amount: string | null;
  /** The same amount in base units, when it could be worked out. Matching needs it. */
  readonly units: string | null;
  readonly note: string;
}

export interface RequestBook {
  readonly v: 1;
  /** Oldest first. */
  readonly items: readonly PayRequestRecord[];
}

export const REQUEST_LIMIT = 50;

const DIGITS = /^(0|[1-9][0-9]{0,24})$/;

export function parseRequestBook(raw: string | null | undefined): RequestBook {
  const items: PayRequestRecord[] = [];
  try {
    const parsed = JSON.parse(raw ?? 'null') as { items?: unknown } | null;
    for (const entry of Array.isArray(parsed?.items) ? parsed.items : []) {
      const item = entry as Partial<PayRequestRecord> | null;
      if (!item || !isText(item.id, 40) || typeof item.at !== 'number' || !Number.isFinite(item.at) || !isText(item.token, 44)) continue;
      items.push({
        id: item.id,
        at: item.at,
        afterSlot: typeof item.afterSlot === 'string' && DIGITS.test(item.afterSlot) ? item.afterSlot : '0',
        token: item.token,
        amount: isText(item.amount, 40) ? item.amount : null,
        units: typeof item.units === 'string' && DIGITS.test(item.units) ? item.units : null,
        note: cleanNote(item.note),
      });
    }
  } catch {
    // An empty book.
  }
  return { v: 1, items: items.slice(-REQUEST_LIMIT) };
}

export function withRequest(book: RequestBook, record: PayRequestRecord): RequestBook {
  return { v: 1, items: [...book.items.filter((item) => item.id !== record.id), { ...record, note: cleanNote(record.note) }].slice(-REQUEST_LIMIT) };
}

export function withoutRequest(book: RequestBook, id: string): RequestBook {
  return { v: 1, items: book.items.filter((item) => item.id !== id) };
}

/* ------------------------------------------------------------------ */
/* History rows, arrivals and matches                                  */
/* ------------------------------------------------------------------ */

/** One row of a wallet's private history, reduced to what is used here. */
export interface HistoryRow {
  readonly signature: string;
  readonly slot: bigint;
  readonly index: bigint;
  readonly kind: string;
  readonly direction: 'inbound' | 'outbound' | 'selfTransfer';
  /** The token's mint address; SOL's is the one the Rings SDK uses for it. */
  readonly asset: string;
  readonly amount: bigint;
}

export const rowKey = (row: Pick<HistoryRow, 'signature' | 'index'>): string => `${row.signature}:${row.index.toString()}`;

/** Which rows a wallet has already been told about. */
export interface SeenState {
  readonly v: 1;
  /** The newest rows, by key. */
  readonly keys: readonly string[];
  /** Rows in a slot before this one are taken as seen. Zero while every row still fits in `keys`. */
  readonly floor: string;
}

export const SEEN_LIMIT = 400;
const ARRIVAL_KINDS: ReadonlySet<string> = new Set(['privateTransfer', 'deposit', 'ringEntry']);

const bySlot = (a: HistoryRow, b: HistoryRow): number => (a.slot === b.slot ? (a.index === b.index ? 0 : a.index < b.index ? -1 : 1) : a.slot < b.slot ? -1 : 1);

function seenOf(rows: readonly HistoryRow[], floorBefore: bigint): SeenState {
  const ordered = [...rows].sort(bySlot);
  const newest = ordered.slice(-SEEN_LIMIT);
  const oldest = newest[0];
  const floor = ordered.length > SEEN_LIMIT && oldest ? oldest.slot : 0n;
  return { v: 1, keys: newest.map(rowKey), floor: (floor > floorBefore ? floor : floorBefore).toString() };
}

/** The first look at a wallet: everything it holds now counts as seen, so nothing old is announced. */
export function firstLook(rows: readonly HistoryRow[]): SeenState {
  return seenOf(rows, 0n);
}

export function parseSeen(raw: string | null | undefined): SeenState | null {
  try {
    const parsed = JSON.parse(raw ?? 'null') as Partial<SeenState> | null;
    if (!parsed || !Array.isArray(parsed.keys) || typeof parsed.floor !== 'string' || !DIGITS.test(parsed.floor)) return null;
    return { v: 1, keys: parsed.keys.filter((key): key is string => typeof key === 'string' && key.length <= 140).slice(-SEEN_LIMIT), floor: parsed.floor };
  } catch {
    return null;
  }
}

/**
 * What arrived since the last look. An arrival is an incoming row that was
 * not seen before and that the wallet did not cause: not the incoming half of
 * its own trade (the same transaction also took something out), and not in a
 * slot this browser itself just sent a transaction in (`ownSlots`).
 */
export function arrivalsSince(state: SeenState, rows: readonly HistoryRow[], ownSlots: ReadonlySet<string> = new Set()): { arrivals: HistoryRow[]; state: SeenState } {
  const seen = new Set(state.keys);
  const floor = BigInt(state.floor);
  // Transactions in which this wallet also sent, or moved its own notes about.
  const caused = new Set<string>();
  for (const row of rows) if (row.direction !== 'inbound') caused.add(row.signature);
  const arrivals = rows
    .filter(
      (row) =>
        row.direction === 'inbound' &&
        ARRIVAL_KINDS.has(row.kind) &&
        row.amount > 0n &&
        row.slot >= floor &&
        !seen.has(rowKey(row)) &&
        !caused.has(row.signature) &&
        !ownSlots.has(row.slot.toString()),
    )
    .sort(bySlot);
  return { arrivals, state: seenOf(rows, floor) };
}

/**
 * Which requests an incoming payment fits: the same token, exactly the
 * amount asked for, and later than the request. Each payment is given to one
 * request at most, the oldest first. A fit is a likeness and no more: the
 * chain does not say what a payment was for.
 */
export function matchRequests(requests: readonly PayRequestRecord[], rows: readonly HistoryRow[], solMint: string): Map<string, HistoryRow> {
  const incoming = rows.filter((row) => row.direction === 'inbound' && row.kind === 'privateTransfer').sort(bySlot);
  const used = new Set<string>();
  const matches = new Map<string, HistoryRow>();
  for (const request of [...requests].sort((a, b) => a.at - b.at)) {
    if (request.units === null) continue;
    const mint = request.token === PAY_SOL ? solMint : request.token;
    const units = BigInt(request.units);
    const after = BigInt(request.afterSlot);
    const found = incoming.find((row) => !used.has(rowKey(row)) && row.asset === mint && row.amount === units && row.slot > after);
    if (found) {
      used.add(rowKey(found));
      matches.set(request.id, found);
    }
  }
  return matches;
}
