/**
 * Two public facts about a transaction that a wallet's private history does
 * not carry: when its block was made, and which wallets it named. Both are
 * read through this site's relay, both never change once they exist, and so
 * both are kept in this browser after the first read.
 *
 * Neither needs a key, and neither says anything a block explorer would not.
 */

import type { Signature } from '@solana/kit';
import type { SprClient } from '@heliuslabs/spr/client';

import { type SignatureLookup, taggedEvents } from '../../shared/src/ring-tags.js';
import { storage } from './vault.js';

const TIMES_KEY = 'pcf.times.v1';
const TAGS_KEY = 'pcf.tags.v1';
const TIMES_LIMIT = 6_000;
const TAGS_LIMIT = 3_000;
/** How many block times one request asks for. The relay takes forty calls at once. */
const TIME_BATCH = 40;
/** Lookups by signature at a time, and how long each round takes at least: about five a second. */
const TAG_ROUND = 4;
const TAG_ROUND_MS = 800;

function load<T>(key: string, valid: (value: unknown) => value is T): Map<string, T> {
  const map = new Map<string, T>();
  try {
    const parsed = JSON.parse(storage('local')?.getItem(key) ?? '{}') as Record<string, unknown> | null;
    for (const [name, value] of Object.entries(parsed ?? {})) if (valid(value)) map.set(name, value);
  } catch {
    // Starts empty: everything in it can be read again.
  }
  return map;
}

function save<T>(key: string, map: Map<string, T>, limit: number): void {
  try {
    // The newest entries are the ones kept.
    const entries = [...map.entries()].slice(-limit);
    storage('local')?.setItem(key, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // A full or closed store costs a second read next time, nothing else.
  }
}

const isSeconds = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value > 1_500_000_000 && value < 10_000_000_000;
const isTags = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.length >= 32 && entry.length <= 44);

let times: Map<string, number> | undefined;
let tags: Map<string, string[]> | undefined;

export type Progress = (done: number, total: number) => void;

/**
 * The block time of each slot, in seconds since 1970. A slot whose time
 * could not be read is absent from the answer: it is never guessed.
 */
export async function blockTimes(slots: readonly bigint[], onProgress?: Progress): Promise<Map<string, number>> {
  times ??= load(TIMES_KEY, isSeconds);
  const known = times;
  const wanted = [...new Set(slots.map((slot) => slot.toString()))];
  const missing = wanted.filter((slot) => !known.has(slot));
  let done = wanted.length - missing.length;
  onProgress?.(done, wanted.length);
  for (let start = 0; start < missing.length; start += TIME_BATCH) {
    const batch = missing.slice(start, start + TIME_BATCH);
    try {
      const response = await fetch('/api/helius', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'omit',
        body: JSON.stringify(batch.map((slot, index) => ({ jsonrpc: '2.0', id: index, method: 'getBlockTime', params: [Number(slot)] }))),
      });
      if (response.ok) {
        const answers = (await response.json()) as Array<{ id?: unknown; result?: unknown }> | { id?: unknown; result?: unknown };
        for (const answer of Array.isArray(answers) ? answers : [answers]) {
          const slot = typeof answer.id === 'number' ? batch[answer.id] : undefined;
          if (slot !== undefined && isSeconds(answer.result)) known.set(slot, answer.result);
        }
      }
    } catch {
      // These slots stay without a time, and the statement says how many rows it could not date.
    }
    done += batch.length;
    onProgress?.(done, wanted.length);
  }
  if (missing.length > 0) save(TIMES_KEY, known, TIMES_LIMIT);
  return new Map(wanted.flatMap((slot) => (known.has(slot) ? [[slot, known.get(slot) as number] as const] : [])));
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));

export interface TagsRead {
  /** Every wallet each transaction named on the Default Ring, by signature. A transaction that could not be read is absent. */
  readonly tags: Map<string, readonly string[]>;
  /** How many of the transactions asked about could not be read. */
  readonly failed: number;
}

/**
 * The wallets each of these transactions named in public: for a private
 * transfer, the sender and the receiver. Read from the Rings indexer by
 * signature, a few at a time. It stops asking after a run of failures (a
 * relay that is refusing is not asked two hundred times more) and reports
 * how many it could not read.
 */
export async function walletsNamed(client: Pick<SprClient, 'getShieldedTransactionsBySignature'>, signatures: readonly string[], onProgress?: Progress): Promise<TagsRead> {
  tags ??= load(TAGS_KEY, isTags);
  const known = tags;
  const wanted = [...new Set(signatures)];
  const missing = wanted.filter((signature) => !known.has(signature));
  let done = wanted.length - missing.length;
  let failed = 0;
  let failuresInARow = 0;
  onProgress?.(done, wanted.length);
  for (let start = 0; start < missing.length; start += TAG_ROUND) {
    if (failuresInARow >= TAG_ROUND * 2) {
      failed += missing.length - start;
      break;
    }
    const round = missing.slice(start, start + TAG_ROUND);
    const began = Date.now();
    await Promise.all(
      round.map(async (signature) => {
        try {
          const lookup = (await client.getShieldedTransactionsBySignature(signature as Signature)) as unknown as SignatureLookup;
          // Nothing for it yet: not kept, so it is asked again next time.
          if (lookup.transactions.length === 0) {
            failed += 1;
            return;
          }
          const named = new Set<string>();
          for (const event of taggedEvents(lookup)) if (event.ring === null) for (const tag of event.tags) named.add(tag);
          known.set(signature, [...named]);
          failuresInARow = 0;
        } catch {
          failed += 1;
          failuresInARow += 1;
        }
      }),
    );
    done += round.length;
    onProgress?.(done, wanted.length);
    if (start + TAG_ROUND < missing.length) await pause(Math.max(0, TAG_ROUND_MS - (Date.now() - began)));
  }
  if (missing.length > 0) save(TAGS_KEY, known, TAGS_LIMIT);
  return { tags: new Map(wanted.flatMap((signature) => (known.has(signature) ? [[signature, known.get(signature) as string[]] as const] : []))), failed };
}
