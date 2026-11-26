/**
 * Pair tokens in the pages: finding one in the server's status, and writing
 * amounts of it. Every amount on this site that is priced in a pair token
 * goes through here, so it is always formatted with that token's own decimals
 * and carries that token's ticker.
 */

import type { PairRef, PairStatus, StatusResponse } from '../../shared/src/api.js';
import { SOL_DECIMALS, WSOL_MINT } from '../../shared/src/constants.js';
import type { CurveQuote } from '../../shared/src/curve.js';
import { type TradingPair, fromSolLamports } from '../../shared/src/quotes.js';
import { compactUnits, formatUnits, groupDigits } from '../../shared/src/units.js';

/** SOL, for the moments before the server's status has loaded. */
export const SOL_REF: PairRef = Object.freeze({ id: 'SOL', symbol: 'SOL', mint: WSOL_MINT, decimals: SOL_DECIMALS });

export function isSol(pair: Pick<PairRef, 'id'>): boolean {
  return pair.id === SOL_REF.id;
}

/** A pair by id, as the server describes it. */
export function pairOf(status: StatusResponse | null, id: string): PairStatus | undefined {
  return status?.pairs.find((pair) => pair.id === id);
}

/** How many decimal places to show for an amount of this pair token: never more than it has. */
export function places(pair: Pick<PairRef, 'decimals'>, wanted: number): number {
  return Math.max(0, Math.min(pair.decimals, wanted));
}

/** "1,234.5": base units of a pair token as a grouped number, cut off (never rounded up) at `maxFraction` places. */
export function amount(units: bigint | string, pair: Pick<PairRef, 'decimals'>, maxFraction = 4): string {
  return groupDigits(formatUnits(BigInt(units), pair.decimals, places(pair, maxFraction)));
}

/** The same with the ticker: "1,234.5 USDC". */
export function withUnit(units: bigint | string, pair: PairRef, maxFraction = 4): string {
  return `${amount(units, pair, maxFraction)} ${pair.symbol}`;
}

/** "1.23K USDC": for labels only, never for inputs. */
export function compact(units: bigint | string, pair: PairRef): string {
  return `${compactUnits(BigInt(units), pair.decimals)} ${pair.symbol}`;
}

/** Base units as plain text an amount field accepts back: every decimal, no separators. */
export function plain(units: bigint, pair: Pick<PairRef, 'decimals'>): string {
  return formatUnits(units, pair.decimals);
}

/**
 * The operator's per-trade limit for a token priced in this pair, in the pair
 * token's base units, or 0n when there is none. The limit is set in SOL; for
 * another pair token it applies at that pair's rate.
 */
export function tradeCap(status: StatusResponse | null, pair: PairRef): bigint {
  const cap = BigInt(status?.limits.maxTradeLamports || '0');
  if (cap <= 0n) return 0n;
  if (isSol(pair)) return cap;
  const rate = pairOf(status, pair.id)?.unitsPerSol ?? 0;
  // A pair with no rate cannot be held to the limit, so nothing is let through at all.
  return rate > 0 ? fromSolLamports(cap, { decimals: pair.decimals, native: false }, rate) : 1n;
}

/** A SOL amount, in lamports, as base units of a pair token at that pair's rate. 0n when the pair has no rate. */
export function inPairUnits(status: StatusResponse | null, pair: PairRef, lamports: bigint): bigint {
  if (isSol(pair)) return lamports;
  const rate = pairOf(status, pair.id)?.unitsPerSol ?? 0;
  return rate > 0 ? fromSolLamports(lamports, { decimals: pair.decimals, native: false }, rate) : 0n;
}

/**
 * Round sizes for the quick-amount buttons: what 0.1, 0.5, 1 and 2 SOL come to
 * in this pair token, each rounded to one leading digit. They are only a
 * convenience for typing; the rate behind them is not a price.
 */
export function quickAmounts(status: StatusResponse | null, pair: PairRef, sizesInSol: readonly number[] = [0.1, 0.5, 1]): string[] {
  const rate = isSol(pair) ? 1 : (pairOf(status, pair.id)?.unitsPerSol ?? 0);
  if (!(rate > 0)) return [];
  const seen = new Set<string>();
  for (const size of sizesInSol) {
    const rounded = Number((size * rate).toPrecision(1));
    if (!(rounded > 0)) continue;
    // Plain decimal text, never an exponent, and never more places than the token has.
    const text = rounded.toFixed(pair.decimals).replace(/\.?0+$/, '');
    if (text !== '' && text !== '0') seen.add(text);
  }
  return [...seen];
}

/** What a curve of this pair is priced in and how large it is, for building its config in the browser. */
export function curveQuoteOf(pair: PairStatus): CurveQuote {
  if (!pair.curve) throw new Error(`The ${pair.symbol} pair is not set up on this site yet.`);
  return { pair: tradingPairOf(pair), size: pair.curve };
}

export function tradingPairOf(pair: PairStatus): TradingPair {
  return { id: pair.id, symbol: pair.symbol, name: pair.name, mint: pair.mint, decimals: pair.decimals, native: pair.native };
}
