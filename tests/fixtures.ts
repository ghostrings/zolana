/**
 * Shared test fixtures that need no network: a server status with pair tokens
 * in it, mint and registry accounts as the chain would hold them, and a config
 * account built from the parameters the SDK produced.
 */
import BN from 'bn.js';
import { type AccountInfo, PublicKey } from '@solana/web3.js';
import { MINT_SIZE, MintLayout, TOKEN_PROGRAM_ID } from '@solana/spl-token';

import type { PairStatus, StatusResponse } from '../shared/src/api.js';
import { SPP_PROGRAM_ID } from '../shared/src/constants.js';
import type { TierConfigParameters } from '../shared/src/curve.js';
import { pairTokenById, tradingPair } from '../shared/src/quotes.js';
import { FEE_TIERS } from '../shared/src/tiers.js';
import { CONVERT_ASSETS } from '../server/src/convert.js';
import { type AppEnv, readEnv } from '../server/src/env.js';
import { type ResolvedPair, describePair } from '../server/src/pairs.js';

/** Six addresses that parse, for config slots. They are real program and mint addresses, used only as distinct keys. */
export const ADDRESSES = [
  'So11111111111111111111111111111111111111112',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
  'ComputeBudget111111111111111111111111111111',
  'Sysvar1nstructions1111111111111111111111111',
] as const;

/** A server environment with the SOL pair's three configs set and the USDC pair sized, with one config. */
export function pairedEnv(extra: Record<string, string> = {}): AppEnv {
  return readEnv({
    DBC_CONFIG_200: ADDRESSES[0],
    DBC_CONFIG_300: ADDRESSES[1],
    DBC_CONFIG_400: ADDRESSES[2],
    CURVE_INITIAL_MARKET_CAP_USDC: '2500',
    CURVE_MIGRATION_MARKET_CAP_USDC: '35000',
    DBC_CONFIG_300_USDC: ADDRESSES[3],
    ...extra,
  });
}

/** What the chain says about a pair token that can be used: an SPL mint with `decimals`, and a Rings interface. */
export function resolvedOk(env: AppEnv, pairId: string, decimals: number, notes: string[] = []): ResolvedPair {
  const entry = env.pairs.find((candidate) => candidate.token.id === pairId);
  if (!entry) throw new Error(`no pair ${pairId}`);
  return {
    env: entry,
    pair: tradingPair(entry.token, decimals),
    facts: { program: 'spl-token', decimals, mintAuthority: null, freezeAuthority: null, extensions: [], restrictive: [] },
    problems: [],
    notes,
    hasInterface: true,
  };
}

/**
 * The pairs as a server with `pairedEnv` reports them once the chain has
 * answered: SOL live on all three tiers, USDC live on its 3% tier, the rest
 * not set up.
 */
export function pairStatuses(env: AppEnv = pairedEnv()): PairStatus[] {
  return env.pairs.map((entry) =>
    describePair(
      entry,
      env.economics,
      entry.token.id === 'USDC' ? resolvedOk(env, 'USDC', 6, ['Its issuer can freeze any account that holds it.']) : undefined,
      () => ({ live: true, problem: null }),
      true,
    ),
  );
}

export function statusFixture(overrides: Partial<StatusResponse> = {}): StatusResponse {
  const env = pairedEnv();
  const pairs = pairStatuses(env);
  return {
    network: 'mainnet',
    ready: true,
    rpcConfigured: true,
    tiers: pairs[0]?.tiers ?? [],
    pairs,
    previousConfigs: [],
    economics: env.economics,
    creatorPoolPayoutPct: 30,
    origins: ['https://privacycash.fun'],
    priorityMicroLamports: 1000,
    slippage: { defaultBps: 100, maxBps: 1000 },
    desk: { enabled: false, address: null, spreadBps: 50, maxOrderLamports: '1000000000' },
    uploads: { pinned: true, maxImageBytes: 4 * 1024 * 1024 },
    convert: { enabled: false, assets: CONVERT_ASSETS, anyToken: false },
    modules: { enabled: true, everyMinutes: 15, minLamports: '20000000', maxBuyLamports: '1000000000', maxWallets: 4, minShareBps: 100 },
    limits: { maxTradeLamports: '0', launchesPaused: false, tradingPaused: false, notice: null },
    ...overrides,
  };
}

/** An 82-byte SPL Token mint account. */
export function mintAccount(decimals: number, options: { mintAuthority?: PublicKey; freezeAuthority?: PublicKey; owner?: PublicKey } = {}): AccountInfo<Buffer> {
  const data = Buffer.alloc(MINT_SIZE);
  MintLayout.encode(
    {
      mintAuthorityOption: options.mintAuthority ? 1 : 0,
      mintAuthority: options.mintAuthority ?? PublicKey.default,
      supply: 1_000_000n,
      decimals,
      isInitialized: true,
      freezeAuthorityOption: options.freezeAuthority ? 1 : 0,
      freezeAuthority: options.freezeAuthority ?? PublicKey.default,
    },
    data,
  );
  return { owner: options.owner ?? TOKEN_PROGRAM_ID, data, lamports: 1_461_600, executable: false, rentEpoch: 0 };
}

/** A Rings asset registry account for `mint`: 48 bytes, type 5, the mint, then its asset number. */
export function registryAccount(mint: PublicKey, assetId = 7n): AccountInfo<Buffer> {
  const data = Buffer.alloc(48);
  data[0] = 5;
  mint.toBuffer().copy(data, 8);
  data.writeBigUInt64LE(assetId, 40);
  return { owner: new PublicKey(SPP_PROGRAM_ID), data, lamports: 1_224_960, executable: false, rentEpoch: 0 };
}

/** What the chain would hold for a config created from `built`: the same numbers, in the account's own field names. */
export function configAccountFrom(built: TierConfigParameters, feeClaimer: PublicKey, quoteMint: string): Record<string, unknown> {
  const zero = { sqrtPrice: new BN(0), liquidity: new BN(0) };
  return {
    quoteMint: new PublicKey(quoteMint),
    feeClaimer,
    leftoverReceiver: feeClaimer,
    tokenType: built.tokenType,
    tokenDecimal: built.tokenDecimal,
    tokenUpdateAuthority: built.tokenUpdateAuthority,
    activationType: built.activationType,
    creatorTradingFeePercentage: built.creatorTradingFeePercentage,
    migrationFeePercentage: built.migrationFee.feePercentage,
    creatorMigrationFeePercentage: built.migrationFee.creatorFeePercentage,
    partnerPermanentLockedLiquidityPercentage: built.partnerPermanentLockedLiquidityPercentage,
    creatorPermanentLockedLiquidityPercentage: built.creatorPermanentLockedLiquidityPercentage,
    partnerLiquidityPercentage: built.partnerLiquidityPercentage,
    creatorLiquidityPercentage: built.creatorLiquidityPercentage,
    migrationQuoteThreshold: built.migrationQuoteThreshold,
    sqrtStartPrice: built.sqrtStartPrice,
    preMigrationTokenSupply: built.tokenSupply?.preMigrationTokenSupply,
    postMigrationTokenSupply: built.tokenSupply?.postMigrationTokenSupply,
    poolCreationFee: built.poolCreationFee,
    enableFirstSwapWithMinFee: built.enableFirstSwapWithMinFee ? 1 : 0,
    // The account stores a fixed-length curve, padded with zero points.
    curve: [...built.curve, ...Array.from({ length: Math.max(0, 20 - built.curve.length) }, () => zero)],
    poolFees: { baseFee: { ...built.poolFees.baseFee }, dynamicFee: { initialized: 0 } },
    collectFeeMode: built.collectFeeMode,
    migrationOption: built.migrationOption,
    migrationFeeOption: built.migrationFeeOption,
    migratedPoolFeeBps: built.migratedPoolFee.poolFeeBps,
    migratedDynamicFee: built.migratedPoolFee.dynamicFee,
    migratedCollectFeeMode: built.migratedPoolFee.collectFeeMode,
    migratedPoolBaseFeeMode: built.migratedPoolBaseFeeMode ?? 0,
    migratedPoolBaseFeeBytes: new Uint8Array(16),
  };
}

/** USDC as a trading pair, with the decimals its mint has. */
export const USDC = tradingPair(pairTokenById('USDC') as NonNullable<ReturnType<typeof pairTokenById>>, 6);
/** The bridged ZEC as a trading pair. */
export const ZEC = tradingPair(pairTokenById('ZEC') as NonNullable<ReturnType<typeof pairTokenById>>, 8);

export { FEE_TIERS };
