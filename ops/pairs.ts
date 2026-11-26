/**
 * Operator-side helpers for pair tokens. What a mint is on chain is read by
 * `shared/src/mint.ts`, which the server uses too; it is re-exported here for
 * the scripts.
 */

import { type PublicKey, SystemProgram, type TransactionInstruction } from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';

import { type Market, quoteMintOf } from '../shared/src/meteora.js';

export { type MintFacts, pairMintNotes, pairMintProblems, readMintFacts } from '../shared/src/mint.js';

/**
 * The instructions that pay a creator their part of a claim, out of what the
 * claim has just put in the platform's wallet: a plain SOL transfer, or for
 * another pair token a transfer between the two wallets' token accounts, with
 * the creator's opened first if it does not exist.
 */
export function payoutInstructions(market: Pick<Market, 'pair' | 'creator'>, partner: PublicKey, amount: bigint): TransactionInstruction[] {
  if (market.pair.native) return [SystemProgram.transfer({ fromPubkey: partner, toPubkey: market.creator, lamports: amount })];
  const mint = quoteMintOf(market);
  const from = getAssociatedTokenAddressSync(mint, partner);
  // A pool's creator can be a program's address (a multisig, a vault). It is paid the same way a
  // wallet is, as it would be in SOL: into the token account that belongs to that address.
  const to = getAssociatedTokenAddressSync(mint, market.creator, true);
  return [
    createAssociatedTokenAccountIdempotentInstruction(partner, to, market.creator, mint),
    // The checked form names the mint and its decimals, so it cannot move anything but this pair token.
    createTransferCheckedInstruction(from, mint, to, partner, amount, market.pair.decimals),
  ];
}


/**
 * Market caps, in a pair token, worth the same in dollars as the SOL curve's.
 * Rounded to three significant digits: these are a starting point for a
 * decision, and a config's numbers are permanent once created.
 */
export function equivalentCurve(
  sol: { initialMarketCapSol: number; migrationMarketCapSol: number },
  solPriceUsd: number,
  tokenPriceUsd: number,
): { initialMarketCap: number; migrationMarketCap: number; initialUsd: number; migrationUsd: number } {
  if (!(solPriceUsd > 0) || !(tokenPriceUsd > 0)) throw new Error('Both prices must be positive.');
  const round = (value: number): number => Number(value.toPrecision(3));
  const initialUsd = sol.initialMarketCapSol * solPriceUsd;
  const migrationUsd = sol.migrationMarketCapSol * solPriceUsd;
  return {
    initialMarketCap: round(initialUsd / tokenPriceUsd),
    migrationMarketCap: round(migrationUsd / tokenPriceUsd),
    initialUsd,
    migrationUsd,
  };
}
