/**
 * A wallet's check-up: what its own public Rings activity lets an onlooker
 * work out about it.
 *
 * It reads the same rows the explorer shows to anyone for that address, and
 * nothing else: no key, no other wallet's rows. So it can only ever say what
 * is already in the open. Every finding is about a pattern in the wallet's
 * own behaviour that it can change.
 *
 * On the Default Ring a private transfer hides its token and amount and
 * nothing more. What gives an amount away is what happens next to it in
 * public: a shield just before, or an unshield just after.
 */

import type { RingLeg, RingRow } from './rings-api.js';

/** How close in time a public amount and a private move must be for an onlooker to tie them together. */
export const CHECKUP_WINDOW_MS = 15 * 60_000;

/** What one row was, from the point of view of one wallet. */
export type RowPart =
  /** The wallet moved its own public funds into its private balance. Amount public. */
  | 'shield'
  /** The wallet paid public funds into somebody else's private balance. Amount public; its own private balance is untouched. */
  | 'shield-to-other'
  /** Somebody else paid into this wallet's private balance. Amount public. */
  | 'shield-from-other'
  /** The wallet moved funds out of its private balance, to itself or to another address. Amount public. */
  | 'unshield'
  /** Somebody else unshielded to this wallet's public address. Its private balance is untouched. */
  | 'unshield-from-other'
  /** Out of the private balance, through a pool, and back in. Both amounts public. */
  | 'trade'
  /** A private transfer the wallet sent. Amount hidden. */
  | 'private-out'
  /** A private transfer the wallet received. Amount hidden. */
  | 'private-in'
  /** A private exchange: the wallet sent and received in one transaction. Amounts hidden. */
  | 'private-both'
  /** The wallet rearranged its own private balance. */
  | 'own'
  /** The wallet only paid the fee, or the row is not a movement at all. */
  | 'none';

export const ROW_PARTS: readonly RowPart[] = ['shield', 'shield-to-other', 'shield-from-other', 'unshield', 'unshield-from-other', 'trade', 'private-out', 'private-in', 'private-both', 'own', 'none'];

export function partOf(row: RingRow, wallet: string): RowPart {
  const from = row.senders.includes(wallet);
  const to = row.recipients.includes(wallet);
  switch (row.kind) {
    case 'shield':
      if (from) return row.recipients.some((other) => other !== wallet) ? 'shield-to-other' : 'shield';
      return to ? 'shield-from-other' : 'none';
    case 'unshield':
      if (from) return 'unshield';
      return to ? 'unshield-from-other' : 'none';
    case 'trade':
      return from ? 'trade' : 'none';
    case 'self':
      return from ? 'own' : 'none';
    case 'swap':
      return from || to ? 'private-both' : 'none';
    case 'transfer':
      if (from && to) return 'private-both';
      if (from) return 'private-out';
      return to ? 'private-in' : 'none';
    case 'private':
      // The receiving side has not been read yet. That the wallet sent something privately is already known.
      return from ? 'private-out' : 'none';
    default:
      return 'none';
  }
}

const PUBLIC_IN: ReadonlySet<RowPart> = new Set(['shield', 'shield-from-other', 'trade']);
const PUBLIC_OUT: ReadonlySet<RowPart> = new Set(['unshield', 'trade']);
const HIDDEN_OUT: ReadonlySet<RowPart> = new Set(['private-out', 'private-both']);
const HIDDEN_IN: ReadonlySet<RowPart> = new Set(['private-in', 'private-both']);
/** Rows that change this wallet's private balance, in public or not. */
const TOUCHES: ReadonlySet<RowPart> = new Set(['shield', 'shield-from-other', 'unshield', 'trade', 'private-out', 'private-in', 'private-both']);

export interface CheckPair {
  /**
   * `in-then-sent`: a public amount came into the private balance and a
   * private move left right after. `received-then-out`: a private move came
   * in and a public amount left right after.
   */
  readonly kind: 'in-then-sent' | 'received-then-out';
  readonly publicSignature: string;
  readonly hiddenSignature: string;
  /** The public amounts an onlooker would tie to the hidden move. */
  readonly legs: readonly RingLeg[];
  readonly gapMs: number;
  /** When the later of the two happened. */
  readonly at: number;
}

export interface CheckFlow {
  readonly mint: string;
  /** Base units the wallet itself shielded, and unshielded, in the rows looked at. */
  readonly shielded: bigint;
  readonly unshielded: bigint;
}

export interface Checkup {
  /** How many rows were looked at. */
  readonly rows: number;
  readonly parts: Readonly<Record<RowPart, number>>;
  /** Moves of the private balance whose amount is public, and those whose amount is hidden. */
  readonly publicMoves: number;
  readonly hiddenMoves: number;
  /**
   * True when every move of the private balance in these rows had a public
   * amount: anyone can add them up, so the balance is not private in effect.
   */
  readonly openBalance: boolean;
  /** Newest first. */
  readonly pairs: readonly CheckPair[];
  /** Payments that left the wallet with destination and amount in the open. */
  readonly publicPayments: number;
  readonly flows: readonly CheckFlow[];
}

/**
 * Works a wallet's check-up out of its public rows. The rows may come in any
 * order; a row that appears twice is counted once.
 */
export function checkup(rows: readonly RingRow[], wallet: string, windowMs: number = CHECKUP_WINDOW_MS): Checkup {
  const unique = new Map<string, RingRow>();
  for (const row of rows) unique.set(row.signature, row);
  const ordered = [...unique.values()].sort((a, b) => a.at - b.at || a.slot - b.slot || (a.signature < b.signature ? -1 : 1));

  const parts = Object.fromEntries(ROW_PARTS.map((part) => [part, 0])) as Record<RowPart, number>;
  const flows = new Map<string, { shielded: bigint; unshielded: bigint }>();
  const touching: Array<{ row: RingRow; part: RowPart }> = [];
  let publicPayments = 0;

  for (const row of ordered) {
    const part = partOf(row, wallet);
    parts[part] += 1;
    if (TOUCHES.has(part)) touching.push({ row, part });
    if (part === 'shield-to-other' || (part === 'unshield' && row.recipients.some((other) => other !== wallet))) publicPayments += 1;
    if (part === 'shield' || part === 'unshield' || part === 'trade') {
      for (const leg of row.legs) {
        const flow = flows.get(leg.mint) ?? { shielded: 0n, unshielded: 0n };
        let amount = 0n;
        try {
          amount = BigInt(leg.amount);
        } catch {
          amount = 0n;
        }
        if (leg.dir === 'in') flow.shielded += amount;
        else flow.unshielded += amount;
        flows.set(leg.mint, flow);
      }
    }
  }

  const pairs: CheckPair[] = [];
  for (let index = 1; index < touching.length; index += 1) {
    const before = touching[index - 1];
    const after = touching[index];
    if (!before || !after) continue;
    const gapMs = after.row.at - before.row.at;
    if (gapMs < 0 || gapMs > windowMs) continue;
    if (PUBLIC_IN.has(before.part) && HIDDEN_OUT.has(after.part)) {
      const legs = before.row.legs.filter((leg) => leg.dir === 'in');
      if (legs.length > 0) pairs.push({ kind: 'in-then-sent', publicSignature: before.row.signature, hiddenSignature: after.row.signature, legs, gapMs, at: after.row.at });
    }
    if (HIDDEN_IN.has(before.part) && PUBLIC_OUT.has(after.part)) {
      const legs = after.row.legs.filter((leg) => leg.dir === 'out');
      if (legs.length > 0) pairs.push({ kind: 'received-then-out', publicSignature: after.row.signature, hiddenSignature: before.row.signature, legs, gapMs, at: after.row.at });
    }
  }
  pairs.sort((a, b) => b.at - a.at);

  const publicMoves = parts.shield + parts['shield-from-other'] + parts.unshield + parts.trade;
  const hiddenMoves = parts['private-out'] + parts['private-in'] + parts['private-both'];
  return {
    rows: ordered.length,
    parts,
    publicMoves,
    hiddenMoves,
    openBalance: publicMoves > 0 && hiddenMoves === 0,
    pairs,
    publicPayments,
    flows: [...flows.entries()].map(([mint, flow]) => ({ mint, ...flow })),
  };
}
