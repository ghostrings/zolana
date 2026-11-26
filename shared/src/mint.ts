/**
 * Reads what a mint really is on chain, and decides whether it can be a pair
 * token here, or be bought and held here at all. Used before anything is
 * built on a token that is only known by its address: by the server when it
 * starts, by the operator scripts before they create a config, by the doctor,
 * and by the swap page for a token that was not launched here.
 */

import type { AccountInfo, PublicKey } from '@solana/web3.js';
import { ExtensionType, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getExtensionTypes, unpackMint } from '@solana/spl-token';

import { type PairToken, pairSymbol } from './quotes.js';

export interface MintFacts {
  readonly program: 'spl-token' | 'token-2022';
  /** The address of that token program. It decides where a wallet's own token account for the mint is. */
  readonly programId: string;
  /** False for an account of a token program that was allocated but never made into a mint. */
  readonly initialized: boolean;
  readonly decimals: number;
  /** Base units in existence right now. */
  readonly supply: bigint;
  /** Who can create more of it. Null when nobody can. */
  readonly mintAuthority: string | null;
  /** Who can freeze any account that holds it. Null when nobody can. */
  readonly freezeAuthority: string | null;
  /** Token-2022 extensions on the mint, by name. Empty for an SPL Token mint. */
  readonly extensions: readonly string[];
  /**
   * Extensions that change what a transfer does or who controls the tokens:
   * hooks, transfer fees, a permanent delegate, non-transferable, frozen by
   * default, pausable. A pool or a pooled private balance cannot treat such a
   * token as an ordinary one.
   */
  readonly restrictive: readonly string[];
}

const RESTRICTIVE = /TransferHook|TransferFee|PermanentDelegate|NonTransferable|DefaultAccountState|Pausable/;

export function readMintFacts(address: PublicKey, info: AccountInfo<Buffer> | null): MintFacts {
  if (!info) throw new Error('there is no account at this address');
  const token2022 = info.owner.equals(TOKEN_2022_PROGRAM_ID);
  if (!token2022 && !info.owner.equals(TOKEN_PROGRAM_ID)) {
    throw new Error(`the account is owned by ${info.owner.toBase58()}, which is not a token program`);
  }
  const mint = unpackMint(address, info, token2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID);
  const extensions = token2022
    ? getExtensionTypes(mint.tlvData).map((type) => ExtensionType[type] ?? `extension ${type}`)
    : [];
  return {
    program: token2022 ? 'token-2022' : 'spl-token',
    programId: (token2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID).toBase58(),
    initialized: mint.isInitialized,
    decimals: mint.decimals,
    supply: mint.supply,
    mintAuthority: mint.mintAuthority?.toBase58() ?? null,
    freezeAuthority: mint.freezeAuthority?.toBase58() ?? null,
    extensions,
    restrictive: extensions.filter((name) => RESTRICTIVE.test(name)),
  };
}

/**
 * Why a mint cannot be used as a pair token by this build. Empty when it can.
 *
 * Every route here moves the pair token with the SPL Token program: out of a
 * private balance, through a Meteora pool and back, in one transaction whose
 * amounts are fixed before it is signed. A Token-2022 mint is refused, with or
 * without extensions, because none of that has been built or run for it. A
 * mint whose decimals are not the ones this build was told to expect is
 * refused because the address may not be the token it is listed as.
 */
export function pairMintProblems(token: PairToken, facts: MintFacts): string[] {
  const ticker = pairSymbol(token);
  const problems: string[] = [];
  if (facts.program === 'token-2022') {
    problems.push(
      `${ticker} is a Token-2022 mint${facts.extensions.length > 0 ? ` (${facts.extensions.join(', ')})` : ''}. This build moves SPL Token pair mints only.`,
    );
  }
  if (facts.restrictive.length > 0) {
    problems.push(`${ticker} carries extensions that change what a transfer does: ${facts.restrictive.join(', ')}.`);
  }
  if (token.expectedDecimals !== undefined && token.expectedDecimals !== facts.decimals) {
    problems.push(`${ticker} has ${facts.decimals} decimals on chain, and this build expects ${token.expectedDecimals}. The address may be a different token.`);
  }
  return problems;
}

/** What a holder of the pair token should know about who controls it. Not a reason to refuse it. */
export function pairMintNotes(facts: MintFacts): string[] {
  const notes: string[] = [];
  if (facts.freezeAuthority) notes.push(`Its issuer (${facts.freezeAuthority}) can freeze any account that holds it, a pool's and a private balance's vault included.`);
  if (facts.mintAuthority) notes.push(`More of it can be minted, by ${facts.mintAuthority}.`);
  return notes;
}

/* ------------------------------------------------------------------ */
/* Tokens that were not launched here                                  */
/* ------------------------------------------------------------------ */

/**
 * Token-2022 extensions that only describe a token: its name and picture, and
 * the group it belongs to. None of them changes what a transfer does, what a
 * balance means or who controls the tokens, so a token that carries only
 * these moves exactly like an SPL Token one. Rings accepts them as well.
 */
export const DESCRIPTIVE_EXTENSIONS: ReadonlySet<string> = new Set(['MetadataPointer', 'TokenMetadata', 'GroupPointer', 'TokenGroup', 'GroupMemberPointer', 'TokenGroupMember']);

/** The most decimals a token may have and still have its amounts written here. */
export const MOST_DECIMALS = 18;

/**
 * Why a token that was not launched here cannot be bought, held or sold
 * through this site. Empty when it can.
 *
 * Buying one is a swap on Jupiter followed by a deposit into Rings of an
 * amount fixed before anything is signed. That only holds for a token whose
 * transfers are plain transfers: what is sent is what arrives, nobody else
 * can move or freeze it by a rule of the mint, and one unit is one unit. A
 * Token-2022 mint with any extension outside the descriptive ones is refused,
 * whatever Rings itself would accept: a transfer fee would make the amounts
 * disagree, a hook runs somebody else's program in the middle of the trade,
 * and a permanent delegate can take the tokens back out of anybody's account.
 */
export function outsideMintProblems(facts: MintFacts): string[] {
  const problems: string[] = [];
  if (!facts.initialized) problems.push('This address belongs to a token program but was never made into a token.');
  if (!Number.isInteger(facts.decimals) || facts.decimals < 0 || facts.decimals > MOST_DECIMALS) {
    problems.push(`It has ${facts.decimals} decimals, more than this site writes amounts with.`);
  }
  const other = facts.extensions.filter((name) => !DESCRIPTIVE_EXTENSIONS.has(name));
  if (other.length > 0) {
    problems.push(
      `It is a Token-2022 token with features that change how it moves or who controls it: ${other.join(', ')}. This site buys and holds only tokens whose transfers are plain transfers.`,
    );
  }
  return problems;
}

/** What somebody about to buy a token should know about who controls it. Read from its mint; not a reason to refuse it. */
export function outsideMintNotes(facts: MintFacts): string[] {
  const notes: string[] = [];
  if (facts.freezeAuthority) notes.push(`Its issuer can freeze any account that holds it, the Rings vault behind every private balance of it included. The key that can: ${facts.freezeAuthority}.`);
  if (facts.mintAuthority) notes.push(`More of it can be created at any time, by ${facts.mintAuthority}.`);
  return notes;
}
