/**
 * Pair tokens, as the chain describes them.
 *
 * The list of pair tokens is a list of addresses somebody typed. Before a
 * token is launched or traded against one, three things are read from chain:
 * what kind of mint it is and how many decimals it has, who controls it, and
 * whether Rings has an interface for it. This file does that reading, for the
 * server when it starts and for the operator scripts.
 */

import { type Connection, PublicKey } from '@solana/web3.js';
import { address } from '@solana/kit';
import { getSplAssetRegistryAddress } from '@heliuslabs/spr/addresses';
import { decodeSplAssetRegistry } from '@heliuslabs/spr/interface';

import type { PairStatus, TierStatus } from '../../shared/src/api.js';
import { SPP_PROGRAM_ID } from '../../shared/src/constants.js';
import { buildTierConfig } from '../../shared/src/curve.js';
import { type MintFacts, pairMintNotes, pairMintProblems, readMintFacts } from '../../shared/src/mint.js';
import {
  type KeeperRule,
  type PairToken,
  SOL_PAIR,
  type TradingPair,
  configEnvKey,
  curveEnvKeys,
  keeperRule,
  pairSymbol,
  tradingPair,
  unitsPerSol,
} from '../../shared/src/quotes.js';
import { type CurveSize, FEE_TIERS, type LaunchEconomics } from '../../shared/src/tiers.js';
import type { PairEnv } from './env.js';

export interface ResolvedPair {
  readonly env: PairEnv;
  /** The pair as trading code uses it, with the mint's own decimals. Undefined when the mint cannot be used. */
  readonly pair: TradingPair | undefined;
  /** What the mint is. Undefined for SOL, and when there is no mint account to read. */
  readonly facts: MintFacts | undefined;
  /** Why this pair cannot be used. Empty when it can. */
  readonly problems: readonly string[];
  /** What a holder should know about who controls the token. */
  readonly notes: readonly string[];
  /** Whether Rings has an interface for the mint, so it can be held privately. Always true for SOL. */
  readonly hasInterface: boolean;
}

/** The Rings registry account of a mint: it exists once the mint has an interface. */
export async function interfaceRegistryAddress(mint: string): Promise<PublicKey> {
  return new PublicKey(await getSplAssetRegistryAddress(address(mint)));
}

function isRegistry(info: { owner: PublicKey; data: Buffer } | null): boolean {
  if (!info || info.data.length === 0 || info.owner.toBase58() !== SPP_PROGRAM_ID) return false;
  try {
    decodeSplAssetRegistry(new Uint8Array(info.data));
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads the mint and the Rings registry of each pair token, two requests for
 * all of them. A failed request throws: not being able to read is never
 * reported as a verdict about a token.
 */
export async function resolvePairs(connection: Connection, pairs: readonly PairEnv[]): Promise<ResolvedPair[]> {
  const spl = pairs.filter((entry) => !entry.token.native);
  const mints = spl.map((entry) => new PublicKey(entry.token.mint));
  const registries = await Promise.all(spl.map((entry) => interfaceRegistryAddress(entry.token.mint)));
  const [mintInfos, registryInfos] =
    spl.length === 0
      ? [[], []]
      : await Promise.all([connection.getMultipleAccountsInfo(mints, 'confirmed'), connection.getMultipleAccountsInfo(registries, 'confirmed')]);
  let next = 0;
  return pairs.map((entry): ResolvedPair => {
    if (entry.token.native) return { env: entry, pair: SOL_PAIR, facts: undefined, problems: [], notes: [], hasInterface: true };
    const index = next;
    next += 1;
    const ticker = pairSymbol(entry.token);
    const hasInterface = isRegistry(registryInfos[index] ?? null);
    let facts: MintFacts;
    try {
      facts = readMintFacts(mints[index] as PublicKey, mintInfos[index] ?? null);
    } catch (error) {
      return {
        env: entry,
        pair: undefined,
        facts: undefined,
        problems: [`${ticker}: ${error instanceof Error ? error.message : String(error)}.`],
        notes: [],
        hasInterface,
      };
    }
    const problems = pairMintProblems(entry.token, facts);
    if (!hasInterface) {
      problems.push(`Rings has no interface for ${ticker} yet, so it could not be held privately. \`npm run configs:apply\` creates one.`);
    }
    let pair: TradingPair | undefined;
    if (problems.length === 0) {
      try {
        pair = tradingPair(entry.token, facts.decimals);
      } catch (error) {
        problems.push(error instanceof Error ? error.message : String(error));
      }
    }
    return { env: entry, pair, facts, problems, notes: pairMintNotes(facts), hasInterface };
  });
}

/** How many whole pair tokens count as one SOL for this pair. 1 for SOL, 0 while the pair has no curve size. */
export function pairRate(entry: PairEnv, economics: LaunchEconomics): number {
  if (entry.token.native) return 1;
  return entry.size ? unitsPerSol(entry.size.initialMarketCap, economics.initialMarketCapSol) : 0;
}

/**
 * Whether Meteora's keeper graduates a pair's curves, worked out once per
 * pair and size: building a curve is real arithmetic, and the answer is asked
 * for on every status request.
 */
const keeperMemo = new Map<string, KeeperRule | null>();

function keeperFor(pair: TradingPair, size: CurveSize, economics: LaunchEconomics): KeeperRule | null {
  const key = JSON.stringify([pair.id, pair.mint, pair.decimals, size, economics]);
  const known = keeperMemo.get(key);
  if (known !== undefined) return known;
  let rule: KeeperRule | null = null;
  try {
    // The amount a curve raises does not depend on the fee, so one tier stands for all three.
    const built = buildTierConfig(FEE_TIERS[0] as (typeof FEE_TIERS)[number], economics, { pair, size });
    rule = keeperRule(pair, BigInt(built.migrationQuoteThreshold.toString()));
  } catch {
    // A size the curve cannot be built from is reported on each tier, where it is checked.
    rule = null;
  }
  keeperMemo.set(key, rule);
  return rule;
}

/** A tier that is not live yet, with the reason. */
const off = (problem: string): { live: boolean; problem: string | null } => ({ live: false, problem });

/**
 * One pair as the pages receive it. `resolved` is what the chain said about
 * the token, when it has been asked; `tierState` is the launch state of each
 * of its tiers, by fee in basis points.
 */
export function describePair(
  entry: PairEnv,
  economics: LaunchEconomics,
  resolved: ResolvedPair | undefined,
  tierState: (feeBps: number) => { live: boolean; problem: string | null },
  rpcConfigured: boolean,
): PairStatus {
  const { token } = entry;
  const ticker = pairSymbol(token);
  const pair = token.native ? SOL_PAIR : resolved?.pair;
  const keys = curveEnvKeys(token.id);
  let problem: string | null = null;
  if (!token.native) {
    if (!entry.size) problem = `Not set up yet. The operator sizes its curve with ${keys.initial} and ${keys.migration}, then creates its configs.`;
    else if (!rpcConfigured) problem = 'The RPC is not configured.';
    else if (!resolved) problem = 'Still being checked against the chain.';
    else if (resolved.problems.length > 0) problem = resolved.problems[0] as string;
  }
  const tiers: TierStatus[] = FEE_TIERS.map((tier) => {
    const config = entry.configs[tier.feeBps] ?? null;
    const state = problem !== null ? off(problem) : !config ? off('Not created yet.') : !rpcConfigured ? off('The RPC is not configured.') : tierState(tier.feeBps);
    return { id: tier.id, feeBps: tier.feeBps, label: tier.label, blurb: tier.blurb, config, live: state.live, problem: state.problem };
  });
  const keeper = pair && entry.size ? keeperFor(pair, entry.size, economics) : null;
  return {
    id: token.id,
    symbol: ticker,
    mint: token.mint,
    decimals: pair?.decimals ?? token.expectedDecimals ?? 0,
    name: token.name,
    native: token.native,
    note: token.note,
    curve: entry.size ? { initialMarketCap: entry.size.initialMarketCap, migrationMarketCap: entry.size.migrationMarketCap } : null,
    unitsPerSol: pairRate(entry, economics),
    tiers,
    live: tiers.some((tier) => tier.live),
    problem,
    keeperGraduates: keeper?.automatic ?? null,
    keeperNote: keeper?.note ?? '',
    holderNotes: resolved?.notes ?? [],
  };
}

/** Where each of a pair's config addresses goes in the environment. For the scripts that print them. */
export function configKeys(token: PairToken): string[] {
  return FEE_TIERS.map((tier) => configEnvKey(tier, token.id));
}
