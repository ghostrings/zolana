/**
 * Pair tokens: what a launched token can be priced and traded against.
 *
 * A creator picks one at launch and it never changes: it is written into the
 * token's Meteora config, which is why every pair needs its own config per fee
 * tier. SOL is always there. Every other token in this list is switched on by
 * the operator, one pair at a time, and only after the chain has confirmed
 * three things about it: its mint is an ordinary SPL Token mint this code can
 * move, Rings has an interface for it so it can be held privately, and the
 * pair's configs are exactly the ones this code would create.
 *
 * `expectedDecimals` is pinned only where a public explorer states it. The
 * real value is always read from the mint, and a difference switches the pair
 * off instead of being trusted either way.
 */

import { SOL_DECIMALS, WSOL_MINT } from './constants.js';
import type { FeeTier } from './tiers.js';

export interface PairToken {
  /** The key this code uses for the token. Always upper case. */
  readonly id: string;
  /** The ticker as the token writes it itself, where that differs from the id. */
  readonly symbol?: string;
  readonly name: string;
  /** The mint address. For SOL, the wrapped SOL mint. */
  readonly mint: string;
  /** SOL itself: wrapped and unwrapped around every swap, and held natively by Rings. */
  readonly native: boolean;
  readonly expectedDecimals?: number;
  /** What the asset is and whose promise it rests on. Shown to creators and by the doctor. */
  readonly note: string;
}

export const SOL_PAIR_ID = 'SOL';

export const PAIR_TOKENS: readonly PairToken[] = Object.freeze([
  { id: SOL_PAIR_ID, name: 'Solana', mint: WSOL_MINT, native: true, expectedDecimals: SOL_DECIMALS, note: 'Native SOL.' },
  { id: 'USDC', name: 'USD Coin', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', native: false, expectedDecimals: 6, note: 'A dollar token issued by Circle.' },
  { id: 'ZEC', name: 'Zcash (bridged)', mint: 'A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS', native: false, expectedDecimals: 8, note: 'A bridged representation of ZEC, not Zcash itself. Its value rests on the bridge.' },
  { id: 'NEAR', name: 'NEAR (bridged)', mint: '3ZLekZYq2qkZiSpnSvabjit34tUkjSwD1JFuW9as9wBG', native: false, expectedDecimals: 9, note: 'A bridged representation of NEAR. Its value rests on the bridge.' },
  { id: 'XMR', name: 'Monero (wrapped)', mint: 'WXMRyRZhsa19ety5erZhHg4N3xj3EVN92u94422teJp', native: false, note: 'A wrapped representation of XMR, not Monero itself. Its value rests on whoever issues it.' },
  { id: 'ANT', name: 'Anthropic (tokenized share)', mint: 'ANTBTZQ1EUuTxUs3tfeampxdqTWPHmwyJmcWj4xoAyNe', native: false, note: 'Listed as a tokenized share. Such tokens can carry transfer rules set by their issuer.' },
  { id: 'RENDER', name: 'Render', mint: 'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof', native: false, note: 'The Render Network token.' },
  {
    id: 'HSOL',
    symbol: 'hSOL',
    name: 'Helius Staked SOL',
    mint: 'he1iusmfkpAdwvxLNGV8Y1iSbj4rUy6yMhEA3fotn9A',
    native: false,
    expectedDecimals: 9,
    note: 'A liquid staking token: a claim on SOL staked with the Helius validator, so its value rests on that stake pool. One hSOL is worth more than one SOL, and a little more as staking rewards accrue. The pool mints new hSOL for each deposit, so an active mint authority is expected here.',
  },
]);

export function pairTokenById(id: string): PairToken | undefined {
  return PAIR_TOKENS.find((token) => token.id === id.toUpperCase());
}

export function pairTokenByMint(mint: string): PairToken | undefined {
  return PAIR_TOKENS.find((token) => token.mint === mint);
}

/** The ticker to show for a pair token: `hSOL`, not `HSOL`. */
export function pairSymbol(token: PairToken): string {
  return token.symbol ?? token.id;
}

/* ------------------------------------------------------------------ */
/* A pair as trading code uses it                                      */
/* ------------------------------------------------------------------ */

/**
 * A pair token together with the one fact that only the chain can give: how
 * many decimals its mint has. Every amount in a pair token is parsed, quoted
 * and shown with this number, so it is never taken from a list.
 */
export interface TradingPair {
  readonly id: string;
  readonly symbol: string;
  readonly name: string;
  readonly mint: string;
  readonly decimals: number;
  readonly native: boolean;
}

export const SOL_PAIR: TradingPair = Object.freeze({
  id: SOL_PAIR_ID,
  symbol: 'SOL',
  name: 'Solana',
  mint: WSOL_MINT,
  decimals: SOL_DECIMALS,
  native: true,
});

export class PairError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PairError';
  }
}

/** The trading view of a listed pair token, given the decimals read from its mint. */
export function tradingPair(token: PairToken, decimals: number): TradingPair {
  if (token.native) return SOL_PAIR;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new PairError(`${pairSymbol(token)}: ${decimals} is not a number of decimals a mint can have.`);
  }
  if (token.expectedDecimals !== undefined && token.expectedDecimals !== decimals) {
    throw new PairError(`${pairSymbol(token)}: the mint has ${decimals} decimals, and this build expects ${token.expectedDecimals}. The address may be a different token.`);
  }
  return Object.freeze({ id: token.id, symbol: pairSymbol(token), name: token.name, mint: token.mint, decimals, native: false });
}

/* ------------------------------------------------------------------ */
/* Environment names                                                   */
/* ------------------------------------------------------------------ */

/**
 * The environment variable that holds one tier's config address for a pair.
 * SOL keeps the names it has always had (`DBC_CONFIG_300`); every other pair
 * adds its id (`DBC_CONFIG_300_USDC`).
 */
export function configEnvKey(tier: Pick<FeeTier, 'envKey'>, pairId: string): string {
  return pairId === SOL_PAIR_ID ? tier.envKey : `${tier.envKey}_${pairId}`;
}

/** The two variables that size a pair's curve, in whole units of the pair token. */
export function curveEnvKeys(pairId: string): { readonly initial: string; readonly migration: string } {
  return { initial: `CURVE_INITIAL_MARKET_CAP_${pairId}`, migration: `CURVE_MIGRATION_MARKET_CAP_${pairId}` };
}

/* ------------------------------------------------------------------ */
/* Comparing across pairs                                              */
/* ------------------------------------------------------------------ */

/**
 * How many whole pair tokens stand for one SOL, taken from how the operator
 * sized the two curves: a pair whose curve starts at 2,500 where the SOL curve
 * starts at 30 counts 83.33 of its tokens as one SOL.
 *
 * This is not a price and is never used to move money. It exists so that
 * tokens on different pairs can be put in one order, added into one total and
 * held to one per-trade limit. It is as right as the curve sizes were on the
 * day they were chosen, and it drifts with the market after that.
 */
export function unitsPerSol(pairInitialMarketCap: number, solInitialMarketCap: number): number {
  if (!(pairInitialMarketCap > 0) || !(solInitialMarketCap > 0)) throw new PairError('Curve sizes must be positive.');
  return pairInitialMarketCap / solInitialMarketCap;
}

/** A SOL amount, in lamports, as base units of a pair token at that pair's rate. Rounded down. */
export function fromSolLamports(lamports: bigint, pair: Pick<TradingPair, 'decimals' | 'native'>, rate: number): bigint {
  if (pair.native) return lamports;
  if (!(rate > 0) || !Number.isFinite(rate)) throw new PairError('The pair has no rate.');
  const whole = (Number(lamports) / 10 ** SOL_DECIMALS) * rate;
  return BigInt(Math.floor(whole * 10 ** pair.decimals));
}

/** Base units of a pair token as whole SOL at that pair's rate. For ordering and totals only. */
export function toSolValue(units: bigint | string, pair: Pick<TradingPair, 'decimals' | 'native'>, rate: number): number {
  const whole = Number(units) / 10 ** pair.decimals;
  if (pair.native) return whole;
  return rate > 0 && Number.isFinite(rate) ? whole / rate : 0;
}

/* ------------------------------------------------------------------ */
/* Graduation                                                          */
/* ------------------------------------------------------------------ */

/**
 * Whether Meteora's keeper moves a completed curve to its pool by itself.
 * `true` and `false` are Meteora's published thresholds (10 SOL, 750 USDC).
 * `null` means it depends on things this code cannot see: for any other pair
 * token Meteora's keeper acts only if Jupiter lists the token as verified with
 * an organic score above 50 and the curve raises more than 750 dollars' worth.
 */
export interface KeeperRule {
  readonly automatic: boolean | null;
  readonly note: string;
}

const KEEPER_MINIMUM: Readonly<Record<string, number>> = Object.freeze({ SOL: 10, USDC: 750 });

export function keeperRule(pair: Pick<TradingPair, 'id' | 'symbol' | 'decimals'>, thresholdUnits: bigint): KeeperRule {
  const minimum = KEEPER_MINIMUM[pair.id];
  if (minimum === undefined) {
    return {
      automatic: null,
      note: `Meteora's keeper graduates a ${pair.symbol} curve by itself only if Jupiter lists ${pair.symbol} as verified with an organic score above 50 and the curve raises more than 750 dollars' worth. Otherwise anyone can send the graduation from the token's page, or the operator with \`npm run migrate\`.`,
    };
  }
  const raised = Number(thresholdUnits) / 10 ** pair.decimals;
  return raised >= minimum
    ? { automatic: true, note: `Automatic, by Meteora's keeper (${minimum} ${pair.symbol} or more).` }
    : { automatic: false, note: `By hand: under the ${minimum} ${pair.symbol} Meteora's keeper needs. Anyone can send the graduation from the token's page, or the operator with \`npm run migrate\`.` };
}
