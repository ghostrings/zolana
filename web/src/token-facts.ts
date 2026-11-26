/**
 * How to write an amount of a token: its ticker and its decimals. For a
 * statement these must be right or absent, never assumed: an amount written
 * with the wrong number of decimals is wrong by a factor of ten or more, and
 * a statement is the one place nobody would notice.
 *
 * SOL and tokens launched on this site are known. Every other token's
 * decimals are read from its mint on chain; when that read fails, this
 * throws, and the caller says which token it could not write.
 */

import { PublicKey } from '@solana/web3.js';

import { SOL_DECIMALS, TOKEN_DECIMALS } from '../../shared/src/constants.js';
import { SOL_MINT } from '../../shared/src/privacy.js';
import { pairSymbol, pairTokenByMint } from '../../shared/src/quotes.js';
import { api } from './api.js';
import { connection } from './chain.js';

export interface TokenFact {
  /** `SOL`, `$TICKER`, a pair token's ticker, or the mint address cut short. */
  readonly symbol: string;
  readonly decimals: number;
  /** Launched on this site. */
  readonly listed: boolean;
  /** SOL itself: not a token, so it has no mint address. */
  readonly native?: boolean;
}

export class TokenFactsError extends Error {
  readonly mint: string;
  constructor(mint: string) {
    super(`The decimals of the token ${mint} could not be read from chain just now, so its amounts cannot be written. Try again in a moment.`);
    this.name = 'TokenFactsError';
    this.mint = mint;
  }
}

const SOL = SOL_MINT as string;
const known = new Map<string, TokenFact>([[SOL, { symbol: 'SOL', decimals: SOL_DECIMALS, listed: false, native: true }]]);
const cut = (mint: string): string => (mint.length <= 9 ? mint : `${mint.slice(0, 4)}…${mint.slice(-4)}`);

/** The facts of each of these tokens. Throws `TokenFactsError` for the first one whose decimals cannot be had. */
export async function tokenFacts(mints: readonly string[]): Promise<Map<string, TokenFact>> {
  const wanted = [...new Set(mints)];
  const missing = wanted.filter((mint) => !known.has(mint));
  const found = new Map<string, TokenFact>();
  if (missing.length > 0) {
    // Which of them were launched here: those are six-decimal tokens by construction.
    let listingRead = true;
    try {
      for (const token of await api.tokensByMints(missing)) known.set(token.mint, { symbol: `$${token.symbol || '???'}`, decimals: TOKEN_DECIMALS, listed: true });
    } catch {
      listingRead = false;
    }
    for (const mint of missing) {
      if (known.has(mint)) continue;
      let decimals: number;
      try {
        decimals = (await connection().getTokenSupply(new PublicKey(mint))).value.decimals;
      } catch {
        throw new TokenFactsError(mint);
      }
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new TokenFactsError(mint);
      const pair = pairTokenByMint(mint);
      const fact: TokenFact = { symbol: pair && !pair.native ? pairSymbol(pair) : cut(mint), decimals, listed: false };
      found.set(mint, fact);
      // Without the listing a token launched here would be remembered by its address instead of its ticker.
      if (listingRead) known.set(mint, fact);
    }
  }
  return new Map(wanted.map((mint) => [mint, (known.get(mint) ?? found.get(mint)) as TokenFact]));
}
