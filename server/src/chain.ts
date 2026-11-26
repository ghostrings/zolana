/**
 * Server-side chain reads: the public listing and the desk's view of each pool.
 * Everything read here is public pool state, and all of it is Solana mainnet:
 * the RPC's genesis hash is checked before anything else is asked of it.
 */

import { Decimal } from 'decimal.js';
import { Connection, PublicKey } from '@solana/web3.js';
import type { DynamicBondingCurveClient, PoolConfig } from '@meteora-ag/dynamic-bonding-curve-sdk';

import type { PairStatus, PreviousConfigStatus } from '../../shared/src/api.js';
import { MAINNET_GENESIS_HASH, TOKEN_DECIMALS, TOKEN_TOTAL_SUPPLY } from '../../shared/src/constants.js';
import { buildTierConfig, configMismatches, previousConfigMismatches } from '../../shared/src/curve.js';
import {
  type AllowedConfig,
  type GraduatedPool,
  type Market,
  allowedConfigMap,
  assertGraduatedFee,
  configFeeBps,
  createDbc,
  curveStats,
  graduatedFeeTerms,
  graduatedQuoteFees,
  loadGraduatedPool,
  loadGraduatedPools,
  loadMarket,
  loadMintSupplies,
  loadPoolConfigs,
  loadPoolStates,
  marketFromAccounts,
} from '../../shared/src/meteora.js';
import { SOL_PAIR, SOL_PAIR_ID, type TradingPair, configEnvKey, curveEnvKeys, pairSymbol, toSolValue } from '../../shared/src/quotes.js';
import { volumeFromFees } from '../../shared/src/volume.js';
import { FEE_TIERS, tierByFeeBps } from '../../shared/src/tiers.js';
import type { Store, TokenRow } from './db.js';
import { type AppEnv, type PairEnv, requireRpc } from './env.js';
import { type ResolvedPair, describePair, pairRate, resolvePairs } from './pairs.js';

const METAPLEX_PROGRAM = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const MARKET_TTL_MS = 2_500;

/** Whether a tier can take new launches, and if not, why. */
export interface TierState {
  readonly live: boolean;
  readonly problem: string | null;
}

export class WrongNetworkError extends Error {
  constructor(genesis: string) {
    super(`The RPC is not Solana mainnet (it reports genesis ${genesis}). This server runs on mainnet only.`);
    this.name = 'WrongNetworkError';
  }
}

export interface Chain {
  readonly connection: Connection;
  readonly dbc: DynamicBondingCurveClient;
  /**
   * The platform's configs that tokens can be read and traded under, by
   * address. It starts with the SOL pair's and grows as each other pair's
   * token is confirmed on chain; it is the same map throughout, so a holder
   * of it always sees the current set.
   */
  readonly allowedConfigs: ReadonlyMap<string, AllowedConfig>;
  /**
   * A token's pool as the chain has it. Answers are reused for a couple of
   * seconds; `fresh` asks the chain regardless, for a caller that knows the
   * pool has just changed.
   */
  market(mint: string, fresh?: boolean): Promise<{ market: Market; graduated: GraduatedPool | undefined }>;
  /** Resolves once the RPC has been confirmed to be mainnet-beta; rejects for any other network. */
  assertNetwork(): Promise<void>;
  /** Launch state of a SOL tier, by fee in basis points. */
  tier(feeBps: number): TierState;
  /** Every pair token, SOL first, as the pages receive it. */
  pairs(): PairStatus[];
  /** How many whole tokens of a pair count as one SOL. 1 for SOL, 0 for a pair that is not in use. */
  rate(pairId: string): number;
  /**
   * The configs kept from earlier sets that the chain has confirmed, each
   * with the creator's share it was created with. Their tokens trade and earn
   * as before; nothing new is launched on them.
   */
  previousConfigs(): PreviousConfigStatus[];
  /**
   * Compares every pair token and every configured tier with the chain. Safe
   * to call repeatedly; what has been settled is not read again. It throws
   * when the RPC cannot be read, so the caller knows to try again.
   */
  verifyTiers(): Promise<void>;
}

export function createChain(env: AppEnv, log: (message: string) => void = () => undefined, onConfigsChanged: (addresses: string[]) => void = () => undefined): Chain {
  const { rpcUrl } = requireRpc(env);
  const connection = new Connection(rpcUrl, 'confirmed');
  const dbc = createDbc(connection);
  const solEnv = env.pairs.find((entry) => entry.token.native) as PairEnv;
  // SOL needs nothing read from chain to be traded. Every other pair joins once its mint has been read.
  const allowedConfigs = allowedConfigMap(FEE_TIERS.map((tier) => ({ address: solEnv.configs[tier.feeBps], feeBps: tier.feeBps, pair: SOL_PAIR })));
  const cache = new Map<string, { at: number; value: Promise<{ market: Market; graduated: GraduatedPool | undefined }> }>();
  let networkChecked: Promise<void> | undefined;
  /** What the chain said about each pair token, by id. Absent until it has been asked and has answered. */
  const resolved = new Map<string, ResolvedPair>([[SOL_PAIR_ID, { env: solEnv, pair: SOL_PAIR, facts: undefined, problems: [], notes: [], hasInterface: true }]]);
  /** Launch state per pair and tier, keyed `<pair id>:<fee bps>`. */
  const tierStates = new Map<string, TierState>();
  const key = (pairId: string, feeBps: number): string => `${pairId}:${feeBps}`;
  const envOf = (pairId: string): PairEnv | undefined => env.pairs.find((entry) => entry.token.id === pairId);
  /** Configs kept from earlier sets, by address, once the chain has said what each one is. */
  const previous = new Map<string, PreviousConfigStatus>();
  /** Kept configs that were read and cannot be used, so they are not read again. */
  const previousRefused = new Set<string>();

  async function load(mint: string) {
    const market = await loadMarket(dbc, new PublicKey(mint), allowedConfigs);
    let graduated: GraduatedPool | undefined;
    if (market.stage === 'graduated') {
      graduated = await loadGraduatedPool(connection, market);
      // The fee promise is checked on the live pool, not assumed from the config.
      assertGraduatedFee(graduatedFeeTerms(graduated.state), market.tier);
    }
    return { market, graduated };
  }

  /** Reads the mints of the pairs the operator has sized and that have not been settled yet. */
  async function resolveNewPairs(): Promise<void> {
    const pending = env.pairs.filter((entry) => !entry.token.native && entry.size !== undefined && !resolved.has(entry.token.id));
    if (pending.length === 0) return;
    for (const result of await resolvePairs(connection, pending)) {
      const ticker = pairSymbol(result.env.token);
      resolved.set(result.env.token.id, result);
      if (!result.pair) {
        log(`pairs: ${ticker} is off. ${result.problems.join(' ')}`);
        continue;
      }
      const map = allowedConfigs as Map<string, AllowedConfig>;
      for (const tier of FEE_TIERS) {
        const address = result.env.configs[tier.feeBps];
        if (address) map.set(new PublicKey(address).toBase58(), { tier, pair: result.pair });
      }
      log(`pairs: ${ticker} confirmed on chain: an SPL Token mint with ${result.pair.decimals} decimals, and Rings has an interface for it`);
      for (const note of result.notes) log(`pairs: ${ticker}: ${note}`);
    }
    onConfigsChanged([...allowedConfigs.keys()]);
  }

  /** Compares one pair's configured tiers with the configs this server would create for them. */
  async function verifyPair(entry: PairEnv, pair: TradingPair): Promise<void> {
    const partner = env.partnerWallet ? new PublicKey(env.partnerWallet) : undefined;
    const size = entry.size;
    if (!size) return;
    const ticker = pairSymbol(entry.token);
    const name = (label: string): string => (entry.token.native ? label : `${ticker} ${label}`);
    for (const tier of FEE_TIERS) {
      const address = entry.configs[tier.feeBps];
      const state = key(entry.token.id, tier.feeBps);
      if (!address || tierStates.has(state)) continue;
      const envKey = configEnvKey(tier, entry.token.id);
      const account = await dbc.state.getPoolConfig(new PublicKey(address));
      if (!account) {
        tierStates.set(state, { live: false, problem: 'No config account exists at the configured address.' });
        log(`tiers: ${name(tier.label)}: no config account at ${address}. Check ${envKey}.`);
        continue;
      }
      let problems: string[];
      try {
        problems = configMismatches(tier, buildTierConfig(tier, env.economics, { pair, size }), account as unknown as Record<string, unknown>, partner, pair.mint);
      } catch (error) {
        problems = [error instanceof Error ? error.message : String(error)];
      }
      if (problems.length === 0) {
        tierStates.set(state, { live: true, problem: null });
        log(`tiers: ${name(tier.label)} verified against the chain (${address})`);
      } else if (problems.some((problem) => problem.startsWith('quoteMint'))) {
        // Not a matter of settings: the account at this address is a config for another pair token.
        tierStates.set(state, { live: false, problem: `The config set for this tier is not priced in ${ticker}.` });
        log(
          `tiers: ${name(tier.label)}: ${address} is not priced in ${ticker}, so it is not this pair's config. Launches on it are off, and pools under it are refused.\n    ${problems[0] as string}\n    Point ${envKey} at the config \`npm run configs:apply\` printed for it.`,
        );
      } else {
        tierStates.set(state, {
          live: false,
          problem: "This server's launch settings are not the ones this tier's config was created with.",
        });
        const sizes = entry.token.native ? 'CURVE_INITIAL_MARKET_CAP_SOL, CURVE_MIGRATION_MARKET_CAP_SOL' : `${curveEnvKeys(entry.token.id).initial}, ${curveEnvKeys(entry.token.id).migration}`;
        log(
          `tiers: ${name(tier.label)}: ${address} does not match this server's settings, so launches on it are off. Tokens already on it trade normally.\n    ${problems.join('\n    ')}\n    Set ${sizes}, CREATOR_FEE_SHARE_PCT and PARTNER_WALLET to the values the config was created with (see ops/records), or point ${envKey} at the right config.\n    If you changed the split on purpose: a config cannot be edited. \`npm run configs:retire\` prints how to keep this one for its tokens and create a new one for new launches.`,
        );
      }
    }
  }

  /**
   * Reads each config kept from an earlier set and lists it once it is shown
   * to be the platform's own. Run after the pairs are settled: a kept config
   * is recognised by the pair token it is priced in.
   */
  async function verifyPrevious(): Promise<void> {
    const partner = env.partnerWallet ? new PublicKey(env.partnerWallet) : undefined;
    let added = false;
    // All of them in one request: until they are read, the tokens launched on them are not listed.
    const pending = env.previousConfigs.filter((address) => !previous.has(address) && !previousRefused.has(address));
    if (pending.length === 0) return;
    const accounts = await loadPoolConfigs(dbc, connection, pending.map((address) => new PublicKey(address)));
    for (const [index, address] of pending.entries()) {
      const account = accounts[index] ?? null;
      const refuse = (why: string): void => {
        previousRefused.add(address);
        log(`tiers: DBC_CONFIGS_PREVIOUS: ${address} is left out, so tokens launched on it are not listed. ${why}`);
      };
      if (!account) {
        refuse('No config account exists at that address.');
        continue;
      }
      const record = account as unknown as Record<string, unknown>;
      const quoteMint = (record.quoteMint as PublicKey).toBase58();
      const entry = env.pairs.find((candidate) => candidate.token.mint === quoteMint);
      const pair = entry ? resolved.get(entry.token.id)?.pair : undefined;
      if (!entry || !entry.size || !pair) {
        const ticker = entry ? pairSymbol(entry.token) : quoteMint;
        refuse(
          entry
            ? `It is priced in ${ticker}, and the ${ticker} pair is off on this server. Set ${curveEnvKeys(entry.token.id).initial} and ${curveEnvKeys(entry.token.id).migration} to switch it on.`
            : `It is priced in ${ticker}, which is not a pair token this build knows.`,
        );
        continue;
      }
      const tier = tierByFeeBps(configFeeBps(account));
      if (!tier) {
        refuse(`It charges ${configFeeBps(account)} bps, which is not one of the tiers.`);
        continue;
      }
      const problems = previousConfigMismatches(tier, env.economics, { pair, size: entry.size }, record, partner);
      if (problems.length > 0) {
        refuse(`It is not one of this platform's configs:\n    ${problems.join('\n    ')}`);
        continue;
      }
      const creatorFeeSharePct = Number(record.creatorTradingFeePercentage);
      (allowedConfigs as Map<string, AllowedConfig>).set(address, { tier, pair, previous: true });
      previous.set(address, { address, pairId: pair.id, feeBps: tier.feeBps, creatorFeeSharePct });
      added = true;
      log(`tiers: kept config ${address} confirmed: ${pair.symbol} ${tier.label}, creator share ${creatorFeeSharePct}% of what is left of each curve fee after Meteora. No new launches on it.`);
    }
    if (added) onConfigsChanged([...allowedConfigs.keys()]);
  }

  const chain: Chain = {
    connection,
    dbc,
    allowedConfigs,
    market(mint, fresh = false) {
      const now = Date.now();
      const hit = cache.get(mint);
      if (!fresh && hit && now - hit.at < MARKET_TTL_MS) return hit.value;
      const value = chain.assertNetwork().then(() => load(mint));
      cache.set(mint, { at: now, value });
      value.catch(() => cache.delete(mint));
      if (cache.size > 2_000) cache.delete(cache.keys().next().value as string);
      return value;
    },
    assertNetwork() {
      networkChecked ??= connection.getGenesisHash().then(
        (genesis) => {
          // A wrong network is remembered: this promise stays rejected for the life of the process.
          if (genesis !== MAINNET_GENESIS_HASH) throw new WrongNetworkError(genesis);
        },
        (error: unknown) => {
          // The RPC did not answer. That is not a verdict; ask again next time.
          networkChecked = undefined;
          throw error;
        },
      );
      return networkChecked;
    },
    tier(feeBps) {
      if (!solEnv.configs[feeBps]) return { live: false, problem: 'Not created yet.' };
      return tierStates.get(key(SOL_PAIR_ID, feeBps)) ?? { live: false, problem: 'Still being checked against the chain.' };
    },
    pairs() {
      return env.pairs.map((entry) =>
        describePair(
          entry,
          env.economics,
          resolved.get(entry.token.id),
          (feeBps) => tierStates.get(key(entry.token.id, feeBps)) ?? { live: false, problem: 'Still being checked against the chain.' },
          true,
        ),
      );
    },
    rate(pairId) {
      const entry = envOf(pairId);
      return entry ? pairRate(entry, env.economics) : 0;
    },
    previousConfigs() {
      return [...previous.values()];
    },
    async verifyTiers() {
      await chain.assertNetwork();
      await resolveNewPairs();
      // Before the tiers: this is what lists the tokens of an earlier set again after a restart,
      // and it takes one request, where checking the tiers takes one per config.
      await verifyPrevious();
      for (const entry of env.pairs) {
        const pair = resolved.get(entry.token.id)?.pair;
        if (pair) await verifyPair(entry, pair);
      }
    },
  };
  return chain;
}

/** Name, symbol and URI from a mint's Metaplex metadata account. */
export async function readOnChainMetadata(connection: Connection, mint: PublicKey): Promise<{ name: string; symbol: string; uri: string }> {
  const [address] = PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), METAPLEX_PROGRAM.toBuffer(), mint.toBuffer()],
    METAPLEX_PROGRAM,
  );
  const account = await connection.getAccountInfo(address, 'confirmed');
  if (!account || !account.owner.equals(METAPLEX_PROGRAM)) return { name: '', symbol: '', uri: '' };
  const data = account.data;
  let offset = 1 + 32 + 32;
  const readString = (max: number): string => {
    if (offset + 4 > data.length) return '';
    const length = data.readUInt32LE(offset);
    offset += 4;
    if (length > max || offset + length > data.length) return '';
    const value = data.subarray(offset, offset + length).toString('utf8').replace(/\0+$/, '').trim();
    offset += length;
    return value;
  };
  return { name: readString(64), symbol: readString(32), uri: readString(400) };
}

function graduatedPrice(market: Market, pool: GraduatedPool): Decimal {
  // sqrtPrice is Q64.64 of sqrt(tokenB per tokenA) in base units.
  const sqrt = new Decimal(pool.state.sqrtPrice.toString()).div(new Decimal(2).pow(64));
  const raw = sqrt.mul(sqrt);
  const aIsToken = pool.state.tokenAMint.equals(market.mint);
  const quotePerTokenRaw = aIsToken ? raw : new Decimal(1).div(raw);
  return quotePerTokenRaw.mul(new Decimal(10).pow(TOKEN_DECIMALS - market.pair.decimals));
}

const DAY_MS = 86_400_000;
const REFRESH_EVERY_MS = 20_000;
const SNAPSHOT_EVERY_MS = 5 * 60_000;
const SNAPSHOT_MOVING_MS = 30_000;
const VOLUME_EVERY_MS = 5 * 60_000;
const CONFIG_TTL_MS = 30 * 60_000;

export interface Indexer {
  /** Reads one mint from chain and lists it. For a launch that has just confirmed. */
  index(mint: string): Promise<TokenRow | undefined>;
  /** Looks for pools under the platform's configs now. For when a pair's configs have just joined them. */
  discover(): void;
  stop(): void;
}

/**
 * Keeps the listing current.
 *
 * Two loops, because mainnet makes them very different in cost:
 *
 *  - REFRESH, every 20 seconds. The pools the server already knows are read in
 *    batches of a hundred accounts per call. A token on its curve costs a
 *    hundredth of a call; a graduated one costs two hundredths.
 *
 *  - DISCOVERY, every DISCOVERY_MINUTES (and once at start). It asks the RPC
 *    for every pool created under the platform's configs. That walks Meteora's
 *    whole program, which holds a very large number of accounts on mainnet, so
 *    it is slow and is not run often. It exists so that the chain, not this
 *    site's records, decides what is listed: a token created under these
 *    configs by any means appears, and nothing is lost if a browser closed
 *    before it told the server about a launch.
 *
 * A token launched through the site does not wait for discovery: the page
 * calls `index` as soon as the launch confirms.
 */
export function startIndexer(chain: Chain, store: Store, env: AppEnv, log: (message: string) => void): Indexer {
  let stopped = false;
  let refreshing = false;
  let discovering = false;
  const lastSnapshot = new Map<string, { at: number; price: string }>();
  const lastVolume = new Map<string, number>();
  const lastComplaint = new Map<string, number>();
  let lastRefreshComplaint = 0;
  const configs = new Map<string, { at: number; config: PoolConfig }>();

  /** Logs a per-token problem at most once an hour. */
  function complain(mint: string, error: unknown): void {
    const now = Date.now();
    if (now - (lastComplaint.get(mint) ?? 0) < 3_600_000) return;
    lastComplaint.set(mint, now);
    log(`indexer: ${mint}: ${error instanceof Error ? error.message : String(error)}`);
  }

  async function configOf(address: string): Promise<PoolConfig> {
    const hit = configs.get(address);
    if (hit && Date.now() - hit.at < CONFIG_TTL_MS) return hit.config;
    const config = await chain.dbc.state.getPoolConfig(new PublicKey(address));
    if (!config) throw new Error(`config ${address} could not be read`);
    configs.set(address, { at: Date.now(), config });
    return config;
  }

  /**
   * Writes one token's current state. `known` is its stored row, if it has
   * one. `supply` is the mint's supply as just read, or null when it could not
   * be read this time, in which case the stored value stands.
   */
  function record(
    market: Market,
    graduated: GraduatedPool | undefined,
    known: TokenRow | undefined,
    meta: { name: string; symbol: string; uri: string },
    now: number,
    supply: bigint | null = null,
  ): void {
    const mint = market.mint.toBase58();
    const stats = curveStats(market);
    const pool = market.state.poolState;
    const { pair } = market;
    // How many whole pair tokens count as one SOL: for ordering and totals across pairs, never for money.
    const rate = chain.rate(pair.id);
    const supplyText = supply !== null ? supply.toString() : (known?.supply ?? '');
    // Market cap is the price times the tokens that exist now, so a burn lowers it.
    const wholeTokens = supplyText ? new Decimal(supplyText).div(new Decimal(10).pow(TOKEN_DECIMALS)) : new Decimal(TOKEN_TOTAL_SUPPLY);
    let price = stats.price;
    let marketCap = new Decimal(stats.price).mul(wholeTokens).toFixed(6);
    // Cumulative fees in the pair token across both phases, so the 24-hour difference carries through graduation.
    let totalFee = BigInt(pool.metrics.totalTradingQuoteFee.toString()) + BigInt(pool.metrics.totalProtocolQuoteFee.toString());
    if (graduated) {
      const live = graduatedPrice(market, graduated);
      price = live.toFixed(12);
      marketCap = live.mul(wholeTokens).toFixed(6);
      totalFee += graduatedQuoteFees(market, graduated);
    } else if (market.stage === 'graduated' && known) {
      // The pool could not be read this time: keep the last price and fee total, never fall back to the curve's.
      price = known.price_sol;
      marketCap = known.market_cap_sol;
      totalFee = BigInt(known.fee_lamports || '0');
    }
    const fee = totalFee.toString();
    const changed =
      !known ||
      known.stage !== market.stage ||
      known.price_sol !== price ||
      known.fee_lamports !== fee ||
      known.reserve_lamports !== stats.quoteReserve ||
      known.supply !== supplyText ||
      known.pair !== pair.id ||
      (meta.name !== '' && known.name !== meta.name);
    if (changed) {
      store.upsertToken(
        {
          mint,
          pool: market.pool.toBase58(),
          config: market.configAddress.toBase58(),
          fee_bps: market.tier.feeBps,
          creator: market.creator.toBase58(),
          name: meta.name,
          symbol: meta.symbol,
          uri: meta.uri,
          stage: market.stage,
          pair: pair.id,
          price_sol: price,
          market_cap_sol: marketCap,
          progress: stats.progress,
          reserve_lamports: stats.quoteReserve,
          threshold_lamports: stats.migrationThreshold,
          fee_lamports: fee,
          supply: supplyText,
          cap_sol: pair.native ? Number(marketCap) : rate > 0 ? Number(marketCap) / rate : 0,
          reserve_sol: toSolValue(stats.quoteReserve, pair, rate),
          fee_sol: toSolValue(fee, pair, rate),
        },
        now,
      );
    }
    // The description and artwork uploaded through this site are joined on once, when the token is first listed.
    if (!known && meta.uri) attachListingFromUri(store, mint, meta.uri);

    // A point every five minutes, and sooner (at most every 30 seconds) while the price is moving.
    const last = lastSnapshot.get(mint);
    const moved = last !== undefined && last.price !== price && now - last.at >= SNAPSHOT_MOVING_MS;
    if (last === undefined || moved || now - last.at >= SNAPSHOT_EVERY_MS) {
      store.addSnapshot(mint, now, price, fee);
      lastSnapshot.set(mint, { at: now, price });
    }
    // Volume in the pair token over 24 hours: fees taken in that time divided by the fee rate.
    if (changed || now - (lastVolume.get(mint) ?? 0) >= VOLUME_EVERY_MS) {
      const before = store.feeAt(mint, now - DAY_MS);
      const delta = before === undefined ? 0n : totalFee - BigInt(before);
      const volume = volumeFromFees(delta, market.tier.feeBps);
      store.setVolume(mint, volume.toString(), toSolValue(volume, pair, rate));
      lastVolume.set(mint, now);
    }
  }

  async function refresh(): Promise<void> {
    if (refreshing || stopped) return;
    refreshing = true;
    try {
      await chain.assertNetwork();
      const now = Date.now();
      const rows = store.allTokens();
      for (const [configAddress, { tier, pair }] of chain.allowedConfigs) {
        const group = rows.filter((row) => row.config === configAddress);
        if (group.length === 0) continue;
        const config = await configOf(configAddress);
        const states = await loadPoolStates(chain.dbc, chain.connection, group.map((row) => new PublicKey(row.pool)));
        // The supply of each mint, which is how burns are seen. A failed read keeps the last value.
        const supplies = await loadMintSupplies(chain.connection, group.map((row) => new PublicKey(row.mint))).catch(() => [] as Array<bigint | null>);
        const supplyByMint = new Map<string, bigint | null>(group.map((row, index) => [row.mint, supplies[index] ?? null]));
        const markets: Array<{ row: TokenRow; market: Market }> = [];
        group.forEach((row, index) => {
          const state = states[index];
          if (!state) return;
          try {
            markets.push({ row, market: marketFromAccounts({ mint: new PublicKey(row.mint), pool: new PublicKey(row.pool), state, config, tier, pair }) });
          } catch (error) {
            complain(row.mint, error);
          }
        });
        const graduatedMarkets = markets.filter((entry) => entry.market.stage === 'graduated' && entry.market.dammPool);
        const pools = await loadGraduatedPools(chain.connection, graduatedMarkets.map((entry) => entry.market.dammPool as PublicKey));
        const graduatedByMint = new Map<string, GraduatedPool>();
        graduatedMarkets.forEach((entry, index) => {
          const pool = pools[index];
          if (!pool) return;
          try {
            // The fee promise is checked on the live pool every pass, not assumed from the config.
            assertGraduatedFee(graduatedFeeTerms(pool.state), tier);
            graduatedByMint.set(entry.row.mint, pool);
          } catch (error) {
            complain(entry.row.mint, error);
          }
        });
        store.transaction(() => {
          for (const { row, market } of markets) {
            try {
              record(market, graduatedByMint.get(row.mint), row, { name: '', symbol: '', uri: '' }, now, supplyByMint.get(row.mint) ?? null);
            } catch (error) {
              complain(row.mint, error);
            }
          }
        });
      }
      store.pruneSnapshots(now - 8 * DAY_MS);
    } catch (error) {
      // An RPC outage would otherwise write this line every 20 seconds.
      if (Date.now() - lastRefreshComplaint >= 60_000) {
        lastRefreshComplaint = Date.now();
        log(`indexer: refresh: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      refreshing = false;
    }
  }

  async function supplyOf(mint: PublicKey): Promise<bigint | null> {
    return (await loadMintSupplies(chain.connection, [mint]).catch(() => [null]))[0] ?? null;
  }

  async function addToken(market: Market, graduated: GraduatedPool | undefined, now: number): Promise<void> {
    const meta = await readOnChainMetadata(chain.connection, market.mint);
    record(market, graduated, undefined, meta, now, await supplyOf(market.mint));
  }

  async function discover(): Promise<void> {
    if (discovering || stopped) return;
    discovering = true;
    try {
      await chain.assertNetwork();
      let found = 0;
      for (const [configAddress, { tier, pair }] of chain.allowedConfigs) {
        const [config, pools] = await Promise.all([configOf(configAddress), chain.dbc.state.getPoolsByConfig(configAddress)]);
        const known = store.knownMints();
        for (const { publicKey: pool, account } of pools) {
          const mint = account.poolState.baseMint;
          if (known.has(mint.toBase58())) continue;
          try {
            const market = marketFromAccounts({ mint, pool, state: account, config, tier, pair });
            let graduated: GraduatedPool | undefined;
            if (market.stage === 'graduated') {
              graduated = await loadGraduatedPool(chain.connection, market);
              assertGraduatedFee(graduatedFeeTerms(graduated.state), tier);
            }
            await addToken(market, graduated, Date.now());
            found += 1;
          } catch (error) {
            complain(mint.toBase58(), error);
          }
        }
      }
      if (found > 0) log(`indexer: discovery listed ${found} token(s) the server had not seen`);
    } catch (error) {
      // On mainnet this scan is heavy and an RPC may refuse or time it out. The listing does not depend on it.
      log(`indexer: discovery did not complete (${error instanceof Error ? error.message : String(error)}). Tokens launched through the site are listed regardless.`);
    } finally {
      discovering = false;
    }
  }

  const refreshTimer = setInterval(() => void refresh(), REFRESH_EVERY_MS);
  refreshTimer.unref();
  let discoveryTimer: NodeJS.Timeout | undefined;
  if (env.discoveryMinutes > 0) {
    void discover().then(() => refresh());
    discoveryTimer = setInterval(() => void discover(), env.discoveryMinutes * 60_000);
    discoveryTimer.unref();
  } else {
    void refresh();
  }

  return {
    async index(mint) {
      const { market, graduated } = await chain.market(mint);
      const known = store.token(mint);
      const meta = known?.name ? { name: '', symbol: '', uri: '' } : await readOnChainMetadata(chain.connection, market.mint);
      record(market, graduated, known, meta, Date.now(), await supplyOf(market.mint));
      return store.token(mint);
    },
    discover() {
      if (env.discoveryMinutes > 0) void discover().then(() => refresh());
    },
    stop() {
      stopped = true;
      clearInterval(refreshTimer);
      if (discoveryTimer) clearInterval(discoveryTimer);
    },
  };
}

/**
 * Links a token to the description and artwork uploaded through this site.
 * Only metadata this server itself stored is used; it never fetches a URI it
 * was handed by a mint.
 */
export function attachListingFromUri(store: Store, mint: string, uri: string): void {
  if (!uri) return;
  const row = store.metadataByUri(uri);
  if (!row) return;
  store.attachListing(mint, { description: row.description, image: row.image, website: row.website, twitter: row.twitter });
}
