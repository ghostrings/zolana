/**
 * What this browser keeps for the wallet extras, per wallet address: the
 * notes of payments it sent, the payment requests it made, whether alerts
 * are on and what has already been announced, the slots it sent
 * transactions in, and a payout run that is under way (`pay-records.ts`
 * reads and writes that one). All of it is in localStorage, none of it is
 * ever sent anywhere, and none of it is a key.
 *
 * Loads no SDK: the header's watcher and the wallet page both use it.
 */

import {
  type MemoBook,
  type PayMemo,
  type PayRequestRecord,
  type RequestBook,
  type SeenState,
  parseMemoBook,
  parseRequestBook,
  parseSeen,
  withMemo,
  withRequest,
  withoutRequest,
} from '../../shared/src/payrecords.js';
import { ALERTS_PREFIX } from './alert-settings.js';
import { storage } from './vault.js';

export const MEMOS_PREFIX = 'pcf.memos.v1.';
export const REQUESTS_PREFIX = 'pcf.requests.v1.';
export const SEEN_PREFIX = 'pcf.seen.v1.';
export const OWN_SLOTS_PREFIX = 'pcf.ownslots.v1.';
/** The payout run of a wallet: its list, and how far it got. */
export const PAYRUN_PREFIX = 'pcf.payrun.v1.';
/** Every prefix above, for the moment a wallet is taken out of this browser. */
export const RECORD_PREFIXES: readonly string[] = [MEMOS_PREFIX, REQUESTS_PREFIX, ALERTS_PREFIX, SEEN_PREFIX, OWN_SLOTS_PREFIX, PAYRUN_PREFIX];

function read(key: string): string | null {
  try {
    return storage('local')?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** Returns false when the browser would not keep it. Nothing depends on these records being kept. */
function write(key: string, value: string): boolean {
  try {
    const local = storage('local');
    if (!local) return false;
    local.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/* ---------------- notes kept with payments ---------------- */

export function readMemos(address: string): MemoBook {
  return parseMemoBook(read(MEMOS_PREFIX + address));
}

export function keepMemo(address: string, memo: PayMemo): void {
  const before = readMemos(address);
  const after = withMemo(before, memo);
  if (after !== before) write(MEMOS_PREFIX + address, JSON.stringify(after));
}

/* ---------------- payment requests ---------------- */

export function readRequests(address: string): RequestBook {
  return parseRequestBook(read(REQUESTS_PREFIX + address));
}

export function keepRequest(address: string, record: PayRequestRecord): boolean {
  return write(REQUESTS_PREFIX + address, JSON.stringify(withRequest(readRequests(address), record)));
}

export function dropRequest(address: string, id: string): void {
  write(REQUESTS_PREFIX + address, JSON.stringify(withoutRequest(readRequests(address), id)));
}

/* ---------------- what alerts have already announced ---------------- */

export function readSeen(address: string): SeenState | null {
  return parseSeen(read(SEEN_PREFIX + address));
}

export function keepSeen(address: string, state: SeenState): void {
  write(SEEN_PREFIX + address, JSON.stringify(state));
}

export function forgetSeen(address: string): void {
  try {
    storage('local')?.removeItem(SEEN_PREFIX + address);
  } catch {
    // Nothing to forget.
  }
}

/* ---------------- slots this browser sent in ---------------- */

const OWN_SLOT_AGE_MS = 6 * 60 * 60_000;
const OWN_SLOT_LIMIT = 200;

function ownEntries(address: string): Array<{ slot: string; at: number }> {
  try {
    const parsed = JSON.parse(read(OWN_SLOTS_PREFIX + address) ?? '[]') as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is { slot: string; at: number } => typeof entry?.slot === 'string' && /^\d{1,20}$/.test(entry.slot) && typeof entry.at === 'number');
  } catch {
    return [];
  }
}

/**
 * Remembers that this browser landed a transaction of `address` in `slot`,
 * so what that transaction brought in is not announced as an arrival.
 */
export function noteOwnSlot(address: string, slot: bigint, now: number = Date.now()): void {
  const fresh = ownEntries(address).filter((entry) => now - entry.at < OWN_SLOT_AGE_MS && entry.slot !== slot.toString());
  write(OWN_SLOTS_PREFIX + address, JSON.stringify([...fresh, { slot: slot.toString(), at: now }].slice(-OWN_SLOT_LIMIT)));
}

export function ownSlots(address: string, now: number = Date.now()): Set<string> {
  return new Set(
    ownEntries(address)
      .filter((entry) => now - entry.at < OWN_SLOT_AGE_MS)
      .map((entry) => entry.slot),
  );
}
