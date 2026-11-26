/**
 * Reading who a Rings transaction paid, from what the Rings indexer says
 * about it. Needs no key: on the Default Ring every output is tagged with the
 * address of the wallet that owns it, in the open.
 *
 * The SDK's client hands each tag on as 32 bytes. It is written as an address
 * here, in one place, for the server's explorer and for the statement a
 * wallet builds in the browser. (`String()` of those bytes is a list of
 * numbers, not an address: `tests/rings-chain.test.ts` holds this to what the
 * pinned SDK really returns.)
 */

import { getAddressDecoder } from '@solana/kit';

const addressDecoder = getAddressDecoder();

/** One Rings event of a transaction, reduced to what an outsider can use. */
export interface TaggedEvent {
  /** The owner tag of each output, base58. On the Default Ring it is the owning wallet's address. */
  readonly tags: readonly string[];
  readonly nullifiers: number;
  /** A deposit that needed no proof. */
  readonly proofless: boolean;
  /** The ring that authorised the event. Null on the Default Ring. */
  readonly ring: string | null;
}

export class UnreadableTag extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnreadableTag';
  }
}

/** An output tag as an address. Accepts the 32 bytes the SDK's client returns, or text that already is one. */
export function tagText(tag: unknown): string {
  if (typeof tag === 'string' && tag.length >= 32 && tag.length <= 44) return tag;
  if (tag instanceof Uint8Array && tag.length === 32) return addressDecoder.decode(tag);
  throw new UnreadableTag('The indexer returned an output tag that is not 32 bytes.');
}

/** What `getShieldedTransactionsBySignature` answers, as far as this file reads it. */
export interface SignatureLookup {
  readonly transactions: ReadonlyArray<{
    readonly eventIndex: number;
    readonly transaction: {
      readonly outputSlots: ReadonlyArray<{ readonly viewTag: unknown }>;
      readonly nullifiers: readonly unknown[];
      readonly proofless?: boolean;
      readonly ringProgramId?: unknown;
      readonly ringConfig?: unknown;
    };
  }>;
}

/** The events of one transaction, in the order they happened. Empty when the indexer has none for it. */
export function taggedEvents(lookup: SignatureLookup): TaggedEvent[] {
  return [...lookup.transactions]
    .sort((a, b) => a.eventIndex - b.eventIndex)
    .map(({ transaction }) => ({
      tags: transaction.outputSlots.map((slot) => tagText(slot.viewTag)),
      nullifiers: transaction.nullifiers.length,
      proofless: transaction.proofless === true,
      ring: transaction.ringProgramId ? String(transaction.ringProgramId) : transaction.ringConfig ? String(transaction.ringConfig) : null,
    }));
}

/**
 * The other wallets a Default Ring transaction names beside `own`: for a
 * private transfer, the wallet on the other side of it. Tags of another ring
 * are not addresses and are never read as such, so an event of one adds
 * nothing here.
 */
export function otherWallets(events: readonly TaggedEvent[], own: string): string[] {
  const seen = new Set<string>();
  for (const event of events) {
    if (event.ring !== null) continue;
    for (const tag of event.tags) if (tag !== own) seen.add(tag);
  }
  return [...seen];
}
