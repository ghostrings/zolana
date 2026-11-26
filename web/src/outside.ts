/**
 * Looking up a token that was not launched here, from nothing but its
 * address. Everything this returns was read from chain just now, by this
 * page: what the mint is, who controls it, what it calls itself, and whether
 * anybody holds it privately yet. None of it comes from a list somebody
 * curated, and none of it says whether the token is worth anything.
 */

import { address, isAddress } from '@solana/kit';
import { PublicKey } from '@solana/web3.js';
import { ExtensionType, TOKEN_2022_PROGRAM_ID, getExtensionData, unpackMint } from '@solana/spl-token';

import type { TokenSummary } from '../../shared/src/api.js';
import { WSOL_MINT } from '../../shared/src/constants.js';
import { type MintFacts, outsideMintNotes, outsideMintProblems, readMintFacts } from '../../shared/src/mint.js';
import { fetchAssetId, readProtocolFacts } from '../../shared/src/privacy.js';
import { pairSymbol, pairTokenByMint } from '../../shared/src/quotes.js';
import type { OutsideToken } from '../../shared/src/routes.js';
import { type TokenName, metadataAddress, readMetaplexName, readMintName } from '../../shared/src/token-names.js';
import { api } from './api.js';
import { connection, rememberTokenProgram, ringsClient } from './chain.js';

/** Whether Rings can hold the token: it does already, the first deposit will make room for it, or nobody may add it right now. */
export type RingsPlace = 'exists' | 'first' | 'restricted' | 'unread';

export interface TokenLookup {
  readonly mint: string;
  readonly facts: MintFacts;
  /** What the token calls itself, cleaned for display. Null when it says nothing. */
  readonly name: TokenName | null;
  /** What to call it in a sentence: its own ticker, or its address cut short. */
  readonly symbol: string;
  /** The token as this site lists it, when it was launched here: it has a page of its own. */
  readonly listed: TokenSummary | null;
  /** Why it cannot be bought here. Empty when it can. */
  readonly problems: readonly string[];
  /** What a buyer should know about who controls it. */
  readonly notes: readonly string[];
  readonly place: RingsPlace;
}

export class LookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LookupError';
  }
}

const cut = (mint: string): string => `${mint.slice(0, 4)}…${mint.slice(-4)}`;

/** The token as the trade builders need it. */
export function outsideTokenOf(lookup: TokenLookup): OutsideToken {
  return { mint: lookup.mint, programId: lookup.facts.programId, symbol: lookup.symbol };
}

/** Reads everything the swap page shows about the token at `mint`. Throws `LookupError` with a sentence when there is no token there. */
export async function lookUpToken(mint: string): Promise<TokenLookup> {
  if (!isAddress(mint)) throw new LookupError('That is not a Solana address. A token is identified by the address of its mint, 32 to 44 letters and digits.');
  if (mint === WSOL_MINT || mint === '11111111111111111111111111111111') {
    throw new LookupError('That is SOL itself. SOL is what tokens are paid for with here; shield it from the wallet page.');
  }
  const key = new PublicKey(mint);
  let infos: Awaited<ReturnType<ReturnType<typeof connection>['getMultipleAccountsInfo']>>;
  try {
    infos = await connection().getMultipleAccountsInfo([key, new PublicKey(metadataAddress(mint))], 'confirmed');
  } catch {
    throw new LookupError('The chain could not be read just now. Try again in a moment.');
  }
  const [mintInfo, metadataInfo] = infos;
  if (!mintInfo) throw new LookupError('There is nothing at that address on Solana mainnet. Check that it is the token’s own address (its mint), copied whole.');
  let facts: MintFacts;
  try {
    facts = readMintFacts(key, mintInfo);
  } catch {
    throw new LookupError('That address is not a token. It may be a wallet, a token account or a pool: what is needed is the address of the token itself (its mint).');
  }
  rememberTokenProgram(mint, facts.programId);

  let name: TokenName | null = null;
  if (facts.program === 'token-2022') {
    try {
      name = readMintName(mint, getExtensionData(ExtensionType.TokenMetadata, unpackMint(key, mintInfo, TOKEN_2022_PROGRAM_ID).tlvData));
    } catch {
      name = null;
    }
  }
  name ??= readMetaplexName(mint, metadataInfo ? { owner: metadataInfo.owner.toBase58(), data: metadataInfo.data } : null);

  // The listing and Rings are each asked separately: neither failing hides what the mint itself says.
  let listed: TokenSummary | null = null;
  try {
    listed = (await api.tokensByMints([mint]))[0] ?? null;
  } catch {
    listed = null;
  }
  let place: RingsPlace = 'unread';
  try {
    const client = await ringsClient();
    if ((await fetchAssetId(client, address(mint))) !== undefined) place = 'exists';
    else place = (await readProtocolFacts(client)).splInterfaceCreationIsPermissionless ? 'first' : 'restricted';
  } catch {
    place = 'unread';
  }

  const pair = pairTokenByMint(mint);
  const symbol = listed?.symbol ? `$${listed.symbol}` : pair && !pair.native ? pairSymbol(pair) : name?.symbol || cut(mint);
  return { mint, facts, name, symbol, listed, problems: outsideMintProblems(facts), notes: outsideMintNotes(facts), place };
}
