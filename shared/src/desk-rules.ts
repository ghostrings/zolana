/**
 * Rules of the Ghost desk that need no chain, so the server, the pages and the
 * tests all run the same ones.
 */

/**
 * How long a trader has to check, sign and return a fill the desk has
 * prepared. It starts when the desk has finished its own side, so a slow proof
 * on the desk's end does not eat into it.
 */
export const DESK_SIGN_WINDOW_MS = 15_000;

/**
 * Blocks past a transaction's last valid block before it is called expired.
 * The status is read after the height, and an RPC behind a load balancer can
 * answer the two from different machines: the margin is what keeps a
 * transaction that landed in its very last block from being reported as lost.
 */
export const EXPIRY_MARGIN_BLOCKS = 32n;

/**
 * The most notes of one asset the desk carries without saying so. A fill can
 * spend five; past four, the next trade of that asset may need more.
 */
export const DESK_MAX_NOTES = 4;

/** What became of a transaction that was sent. */
export type Outcome =
  /** Confirmed. */
  | { readonly kind: 'landed'; readonly slot: bigint }
  /** It reached the chain and failed there: nothing in it took effect. */
  | { readonly kind: 'rejected' }
  /** It was never included and no longer can be. */
  | { readonly kind: 'expired' }
  /** Not seen yet, and it still could land. */
  | { readonly kind: 'pending' };

/** A signature's status as an RPC reports it, reduced to what decides an outcome. */
export interface StatusSeen {
  readonly slot: bigint;
  readonly failed: boolean;
  readonly confirmed: boolean;
}

/**
 * Decides from one look at the chain. `status` is null when the RPC knows no
 * such signature; `blockHeight` is null when it could not be read, and then
 * nothing is ever called expired.
 */
export function outcomeOf(status: StatusSeen | null, blockHeight: bigint | null, lastValidBlockHeight: bigint): Outcome {
  if (status !== null) {
    if (status.failed) return { kind: 'rejected' };
    if (status.confirmed) return { kind: 'landed', slot: status.slot };
    return { kind: 'pending' };
  }
  if (blockHeight !== null && blockHeight > lastValidBlockHeight + EXPIRY_MARGIN_BLOCKS) return { kind: 'expired' };
  return { kind: 'pending' };
}

function clampBps(value: number): bigint {
  if (!Number.isFinite(value)) return 0n;
  return BigInt(Math.max(0, Math.min(10_000, Math.trunc(value))));
}

/**
 * The least a trader takes when the price may move by `toleranceBps` from the
 * quote on screen. A Ghost fill is priced twice: once for the screen, and
 * again after the trader's proof is made, because the desk holds a price only
 * for seconds. The second price is taken without asking again only when it
 * returns at least this.
 */
export function floorAfterTolerance(receive: bigint, toleranceBps: number): bigint {
  if (receive <= 0n) return 0n;
  return (receive * (10_000n - clampBps(toleranceBps))) / 10_000n;
}

/**
 * Answers that mean "the desk will not take this order", as opposed to
 * something having gone wrong. The pool can usually take the same order, so a
 * page that picked Ghost fill by itself moves on to the Shielded route.
 */
export const DESK_DECLINE_CODES: ReadonlySet<string> = new Set([
  'TOO_LARGE',
  'NO_INVENTORY',
  'NO_CAPACITY',
  'NO_INTERFACE',
  'PAIR_UNSUPPORTED',
  'DUST',
  'DESK_OFF',
  'DESK_UNAVAILABLE',
  'BUSY',
  'COOLDOWN',
]);

export function isDeskDecline(code: unknown): boolean {
  return typeof code === 'string' && DESK_DECLINE_CODES.has(code);
}

/** The desk's refusal of one order, remembered by a page that had picked Ghost fill by itself. */
export interface DeskDecline {
  readonly side: 'buy' | 'sell';
  readonly code: string;
  /** The desk's own words, to show under Ghost fill. */
  readonly reason: string;
  /** The amount that was refused, in the base units it was typed in. */
  readonly amount: bigint;
  /** When, in milliseconds since 1970. */
  readonly at: number;
}

/** How long a refusal that is not about size keeps the page off the desk. */
export const DECLINE_HOLD_MS = 30_000;

/**
 * Whether a refusal still covers the order on screen, so the page keeps that
 * order on the pool instead of asking the desk again.
 *
 * A refusal about size covers that size and everything further the same way:
 * too large covers anything at least as large, too small anything at most as
 * small. Any other refusal (nothing in stock, the desk busy or off) says
 * nothing about the next amount, so it simply holds for half a minute. The
 * other side of the market is never covered: a desk with no tokens to sell can
 * still buy.
 */
export function declineCovers(decline: DeskDecline | null, side: 'buy' | 'sell', amount: bigint | null, now: number): boolean {
  if (!decline || decline.side !== side) return false;
  if (decline.code === 'TOO_LARGE' || decline.code === 'DUST') {
    if (amount === null) return false;
    return decline.code === 'TOO_LARGE' ? amount >= decline.amount : amount <= decline.amount;
  }
  return now - decline.at < DECLINE_HOLD_MS;
}

/** One private balance of the desk, as much of it as the rules below need. */
export interface DeskHolding {
  readonly mint: string;
  readonly notes: number;
}

/** The asset split across the most notes, when that is more than the desk should carry. */
export function mostFragmented(holdings: readonly DeskHolding[], maxNotes: number = DESK_MAX_NOTES): DeskHolding | null {
  let worst: DeskHolding | null = null;
  for (const holding of holdings) {
    if (holding.notes > maxNotes && (worst === null || holding.notes > worst.notes)) worst = holding;
  }
  return worst;
}
