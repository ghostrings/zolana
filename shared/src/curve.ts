/**
 * Builds the Meteora DBC config for one fee tier and derives the exact terms
 * the on-chain account must carry.
 *
 * The fee guarantee lives here:
 *  - curve fee: a fee scheduler whose start and end are the same and that has
 *    zero periods, so there is nothing to decay;
 *  - dynamic fee: disabled, on the curve and on the graduated pool;
 *  - graduated pool: `MigrationFeeOption.Customizable` with `poolFeeBps` equal
 *    to the curve fee, time-scheduler base fee mode with zero periods.
 * `assertFeeGuarantee` re-checks all of it on whatever config it is handed, the
 * freshly built one or one read back from chain.
 */

import BN from 'bn.js';
import { PublicKey } from '@solana/web3.js';
import {
  ActivationType,
  BaseFeeMode,
  CollectFeeMode,
  DammV2BaseFeeMode,
  DammV2DynamicFeeMode,
  MigratedCollectFeeMode,
  MigrationFeeOption,
  MigrationOption,
  TokenAuthorityOption,
  TokenType,
  buildCurveWithMarketCap,
  calculateLockedLiquidityBpsAtTime,
  getMigrationQuoteAmountFromThreshold,
  getMigrationThresholdPrice,
  getPriceFromSqrtPrice,
  validateConfigParameters,
} from '@meteora-ag/dynamic-bonding-curve-sdk';

import { METEORA_GRADUATION_FEE_BPS, TOKEN_DECIMALS, TOKEN_TOTAL_SUPPLY } from './constants.js';
import { type KeeperRule, SOL_PAIR, type TradingPair, configEnvKey, keeperRule } from './quotes.js';
import {
  type CurveSize,
  type FeeTier,
  type LaunchEconomics,
  PLATFORM_LOCKED_LIQUIDITY_PCT,
  checkCurveSize,
  checkEconomics,
  feeNumeratorFromBps,
  solCurveSize,
} from './tiers.js';
import { formatUnits } from './units.js';

export type TierConfigParameters = ReturnType<typeof buildCurveWithMarketCap>;

export class FeeGuaranteeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeeGuaranteeError';
  }
}

/**
 * What a curve is priced in, and how large it is in that token. A config is
 * built for exactly one of these: the pair token's decimals turn the market
 * caps into on-chain prices, so the same numbers against another token would
 * be a different curve.
 */
export interface CurveQuote {
  readonly pair: TradingPair;
  readonly size: CurveSize;
}

/** The SOL pair, sized from the economics. What every config was before other pairs existed. */
export function solCurveQuote(economics: Pick<LaunchEconomics, 'initialMarketCapSol' | 'migrationMarketCapSol'>): CurveQuote {
  return { pair: SOL_PAIR, size: solCurveSize(economics) };
}

/** Offline. No RPC, no keys. Without `quote` it builds the SOL pair's config. */
export function buildTierConfig(
  tier: FeeTier,
  economicsInput: LaunchEconomics,
  quote: CurveQuote = solCurveQuote(economicsInput),
): TierConfigParameters {
  const economics = checkEconomics(economicsInput);
  const size = checkCurveSize(quote.size, `${quote.pair.symbol} curve`);
  return buildCurveWithMarketCap({
    initialMarketCap: size.initialMarketCap,
    migrationMarketCap: size.migrationMarketCap,
    activationType: ActivationType.Timestamp,
    token: {
      tokenType: TokenType.SPLToken,
      tokenBaseDecimal: TOKEN_DECIMALS,
      tokenQuoteDecimal: quote.pair.decimals,
      // Mint authority is revoked and metadata is frozen at launch.
      tokenAuthorityOption: TokenAuthorityOption.Immutable,
      totalTokenSupply: TOKEN_TOTAL_SUPPLY,
      leftover: 0,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
        feeSchedulerParam: {
          startingFeeBps: tier.feeBps,
          endingFeeBps: tier.feeBps,
          numberOfPeriod: 0,
          totalDuration: 0,
        },
      },
      dynamicFeeEnabled: false,
      // Fees are always taken in the pair token, whichever way the trade goes.
      collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: economics.creatorFeeSharePct,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: MigrationFeeOption.Customizable,
      migrationFee: {
        feePercentage: economics.migrationFeePct,
        creatorFeePercentage: economics.creatorMigrationFeeSharePct,
      },
      migratedPoolFee: {
        collectFeeMode: MigratedCollectFeeMode.QuoteToken,
        dynamicFee: DammV2DynamicFeeMode.Disabled,
        poolFeeBps: tier.feeBps,
      },
    },
    // All graduated liquidity is locked for good, and all of it is the
    // platform's position. The creator holds no liquidity: what a creator earns
    // after graduation is paid by the platform from the fees that position collects.
    liquidityDistribution: {
      partnerLiquidityPercentage: 0,
      partnerPermanentLockedLiquidityPercentage: PLATFORM_LOCKED_LIQUIDITY_PCT,
      creatorLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 100 - PLATFORM_LOCKED_LIQUIDITY_PCT,
    },
    lockedVesting: {
      totalLockedVestingAmount: 0,
      numberOfVestingPeriod: 0,
      cliffUnlockAmount: 0,
      totalVestingDuration: 0,
      cliffDurationFromMigrationTime: 0,
    },
  });
}

/** The fee-bearing fields of a config, in one shape for built and on-chain values. */
export interface FeeTerms {
  readonly curveFeeNumerator: string;
  readonly curveFeeFirstFactor: number;
  readonly curveFeeSecondFactor: string;
  readonly curveFeeThirdFactor: string;
  readonly curveBaseFeeMode: number;
  readonly curveDynamicFeeInitialized: boolean;
  readonly collectFeeMode: number;
  readonly migrationOption: number;
  readonly migrationFeeOption: number;
  readonly migratedPoolFeeBps: number;
  readonly migratedDynamicFee: number;
  readonly migratedCollectFeeMode: number;
  readonly migratedPoolBaseFeeMode: number;
  /** True when the graduated pool carries any fee-scheduler parameter at all. */
  readonly migratedSchedulerConfigured: boolean;
}

function bnString(value: unknown): string {
  if (BN.isBN(value)) return value.toString();
  if (typeof value === 'bigint' || typeof value === 'number') return value.toString();
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '0';
  throw new FeeGuaranteeError('A fee field has an unexpected type.');
}

/** Fee terms of a config as built by the SDK, before it is sent. */
export function feeTermsFromParameters(config: TierConfigParameters): FeeTerms {
  const base = config.poolFees.baseFee;
  const scheduler = config.migratedPoolMarketCapFeeSchedulerParams;
  return {
    curveFeeNumerator: bnString(base.cliffFeeNumerator),
    curveFeeFirstFactor: Number(base.firstFactor),
    curveFeeSecondFactor: bnString(base.secondFactor),
    curveFeeThirdFactor: bnString(base.thirdFactor),
    curveBaseFeeMode: Number(base.baseFeeMode),
    curveDynamicFeeInitialized: config.poolFees.dynamicFee !== null && config.poolFees.dynamicFee !== undefined,
    collectFeeMode: Number(config.collectFeeMode),
    migrationOption: Number(config.migrationOption),
    migrationFeeOption: Number(config.migrationFeeOption),
    migratedPoolFeeBps: Number(config.migratedPoolFee.poolFeeBps),
    migratedDynamicFee: Number(config.migratedPoolFee.dynamicFee),
    migratedCollectFeeMode: Number(config.migratedPoolFee.collectFeeMode),
    migratedPoolBaseFeeMode: Number(config.migratedPoolBaseFeeMode ?? 0),
    migratedSchedulerConfigured:
      Number(scheduler?.numberOfPeriod ?? 0) !== 0 ||
      Number(scheduler?.sqrtPriceStepBps ?? 0) !== 0 ||
      Number(scheduler?.schedulerExpirationDuration ?? 0) !== 0 ||
      bnString(scheduler?.reductionFactor) !== '0',
  };
}

/**
 * The single statement of "this config charges exactly `tier.feeBps`, on the
 * curve and after graduation, forever". Throws with the offending field.
 */
export function assertFeeGuarantee(terms: FeeTerms, tier: FeeTier): void {
  const expectedNumerator = feeNumeratorFromBps(tier.feeBps).toString();
  const check = (ok: boolean, message: string) => {
    if (!ok) throw new FeeGuaranteeError(`${tier.id}: ${message}`);
  };
  check(
    terms.curveFeeNumerator === expectedNumerator,
    `curve fee numerator is ${terms.curveFeeNumerator}, expected ${expectedNumerator} (${tier.label}).`,
  );
  check(
    terms.curveBaseFeeMode === BaseFeeMode.FeeSchedulerLinear,
    `curve base fee mode is ${terms.curveBaseFeeMode}, expected the linear scheduler with no periods.`,
  );
  check(terms.curveFeeFirstFactor === 0, `curve fee scheduler has ${terms.curveFeeFirstFactor} periods; it must have none.`);
  check(terms.curveFeeSecondFactor === '0', 'curve fee scheduler has a period frequency; it must be zero.');
  check(terms.curveFeeThirdFactor === '0', 'curve fee scheduler has a reduction factor; it must be zero.');
  check(!terms.curveDynamicFeeInitialized, 'the curve has a dynamic fee; it must be disabled.');
  check(terms.collectFeeMode === CollectFeeMode.QuoteToken, 'curve fees must be collected in the pair token.');
  check(terms.migrationOption === MigrationOption.MET_DAMM_V2, 'the curve must graduate to DAMM v2.');
  check(
    terms.migrationFeeOption === MigrationFeeOption.Customizable,
    'the graduated pool must use the customizable fee option so its fee is set by this config.',
  );
  check(
    terms.migratedPoolFeeBps === tier.feeBps,
    `graduated pool fee is ${terms.migratedPoolFeeBps} bps, expected ${tier.feeBps} bps.`,
  );
  check(terms.migratedDynamicFee === DammV2DynamicFeeMode.Disabled, 'the graduated pool has a dynamic fee; it must be disabled.');
  check(
    terms.migratedCollectFeeMode === MigratedCollectFeeMode.QuoteToken,
    'graduated pool fees must be collected in the pair token.',
  );
  check(
    terms.migratedPoolBaseFeeMode === DammV2BaseFeeMode.FeeTimeSchedulerLinear,
    'the graduated pool must use the time scheduler base fee mode with no periods.',
  );
  check(!terms.migratedSchedulerConfigured, 'the graduated pool carries fee scheduler parameters; it must carry none.');
}

export interface TierPlan {
  readonly tierId: string;
  readonly feeBps: number;
  readonly feeLabel: string;
  /** The pair token's id (`SOL`, `USDC`, ...), its ticker, its mint and the decimals the plan was built with. */
  readonly pair: string;
  readonly pairSymbol: string;
  readonly quoteMint: string;
  readonly quoteDecimals: number;
  readonly envKey: string;
  readonly economics: LaunchEconomics;
  /** The curve's size, in whole units of the pair token. */
  readonly size: CurveSize;
  readonly feeTerms: FeeTerms;
  /** Derived, human-readable numbers for review. Every amount is in whole units of the pair token. */
  readonly summary: {
    readonly totalSupply: string;
    readonly tokenDecimals: number;
    readonly initialMarketCap: string;
    readonly migrationMarketCap: string;
    readonly encodedMigrationMarketCap: string;
    readonly raisedAtGraduation: string;
    /** Whether Meteora's keeper graduates these curves by itself, and what happens when it does not. */
    readonly keeper: KeeperRule;
    /** What enters the graduated pool, after the platform's migration fee and Meteora's graduation fee. An estimate. */
    readonly depositedAsLiquidity: string;
    /** The platform's own migration fee. */
    readonly migrationFee: string;
    /** Meteora's fee on the liquidity at graduation, in basis points and in the pair token. An estimate from the SDK's value. */
    readonly meteoraGraduationFeeBps: number;
    readonly meteoraGraduationFee: string;
    readonly creatorCurveFeeSharePct: number;
    readonly platformCurveFeeSharePct: number;
    readonly creatorLockedLpPct: number;
    readonly platformLockedLpPct: number;
    readonly lockedLpBpsAtDayOne: number;
    readonly sqrtStartPrice: string;
    readonly migrationSqrtPrice: string;
    readonly curvePoints: number;
  };
}

/**
 * Builds one tier of one pair, validates it with the SDK's own
 * program-mirroring checks, asserts the fee guarantee, and returns the numbers
 * a human should review. Without `quote` it plans the SOL pair.
 */
export function planTier(
  tier: FeeTier,
  economicsInput: LaunchEconomics,
  partner: PublicKey,
  quote: CurveQuote = solCurveQuote(economicsInput),
): {
  plan: TierPlan;
  config: TierConfigParameters;
} {
  const economics = checkEconomics(economicsInput);
  const size = checkCurveSize(quote.size, `${quote.pair.symbol} curve`);
  const { pair } = quote;
  const label = pair.native ? tier.id : `${tier.id} ${pair.symbol}`;
  const config = buildTierConfig(tier, economics, { pair, size });

  validateConfigParameters({ ...config, leftoverReceiver: partner }, { feeClaimer: partner });

  const feeTerms = feeTermsFromParameters(config);
  assertFeeGuarantee(feeTerms, tier);

  const supplyRaw = BigInt(TOKEN_TOTAL_SUPPLY) * 10n ** BigInt(TOKEN_DECIMALS);
  const pre = config.tokenSupply?.preMigrationTokenSupply.toString();
  const post = config.tokenSupply?.postMigrationTokenSupply.toString();
  if (pre !== supplyRaw.toString() || post !== supplyRaw.toString()) {
    throw new FeeGuaranteeError(`${label}: the SDK did not keep the fixed ${TOKEN_TOTAL_SUPPLY} token supply.`);
  }

  const migrationSqrtPrice = getMigrationThresholdPrice(
    config.migrationQuoteThreshold,
    config.sqrtStartPrice,
    config.curve,
  );
  const encodedMarketCap = getPriceFromSqrtPrice(migrationSqrtPrice, TOKEN_DECIMALS, pair.decimals).mul(
    TOKEN_TOTAL_SUPPLY,
  );
  const drift = encodedMarketCap.sub(size.migrationMarketCap).abs().div(size.migrationMarketCap);
  if (drift.gt('0.0001')) {
    throw new FeeGuaranteeError(
      `${label}: the encoded curve graduates at ${encodedMarketCap.toFixed(4)} ${pair.symbol} market cap, not ${size.migrationMarketCap}.`,
    );
  }

  const thresholdRaw = BigInt(config.migrationQuoteThreshold.toString());
  const liquidityQuoteRaw = BigInt(
    getMigrationQuoteAmountFromThreshold(config.migrationQuoteThreshold, economics.migrationFeePct).toString(),
  );
  const lockedBps = calculateLockedLiquidityBpsAtTime(
    config.partnerPermanentLockedLiquidityPercentage,
    config.creatorPermanentLockedLiquidityPercentage,
    config.partnerLiquidityVestingInfo,
    config.creatorLiquidityVestingInfo,
    86_400,
  );
  if (lockedBps !== 10_000) {
    throw new FeeGuaranteeError(`${label}: ${lockedBps} bps of liquidity is locked at day one, expected all 10000.`);
  }
  if (
    config.partnerPermanentLockedLiquidityPercentage !== PLATFORM_LOCKED_LIQUIDITY_PCT ||
    config.creatorPermanentLockedLiquidityPercentage !== 0 ||
    config.partnerLiquidityPercentage !== 0 ||
    config.creatorLiquidityPercentage !== 0
  ) {
    throw new FeeGuaranteeError(`${label}: the locked liquidity must be held by the platform alone, and none of it by the creator.`);
  }
  // Meteora takes its own fee from the liquidity as it moves into the pool.
  const meteoraFeeRaw = (liquidityQuoteRaw * BigInt(METEORA_GRADUATION_FEE_BPS)) / 10_000n;

  const plan: TierPlan = {
    tierId: tier.id,
    feeBps: tier.feeBps,
    feeLabel: tier.label,
    pair: pair.id,
    pairSymbol: pair.symbol,
    quoteMint: pair.mint,
    quoteDecimals: pair.decimals,
    envKey: configEnvKey(tier, pair.id),
    economics,
    size,
    feeTerms,
    summary: {
      totalSupply: TOKEN_TOTAL_SUPPLY.toString(),
      tokenDecimals: TOKEN_DECIMALS,
      initialMarketCap: size.initialMarketCap.toString(),
      migrationMarketCap: size.migrationMarketCap.toString(),
      encodedMigrationMarketCap: encodedMarketCap.toFixed(6),
      raisedAtGraduation: formatUnits(thresholdRaw, pair.decimals),
      keeper: keeperRule(pair, thresholdRaw),
      depositedAsLiquidity: formatUnits(liquidityQuoteRaw - meteoraFeeRaw, pair.decimals),
      migrationFee: formatUnits(thresholdRaw - liquidityQuoteRaw, pair.decimals),
      meteoraGraduationFeeBps: METEORA_GRADUATION_FEE_BPS,
      meteoraGraduationFee: formatUnits(meteoraFeeRaw, pair.decimals),
      creatorCurveFeeSharePct: economics.creatorFeeSharePct,
      platformCurveFeeSharePct: 100 - economics.creatorFeeSharePct,
      creatorLockedLpPct: config.creatorPermanentLockedLiquidityPercentage,
      platformLockedLpPct: config.partnerPermanentLockedLiquidityPercentage,
      lockedLpBpsAtDayOne: lockedBps,
      sqrtStartPrice: config.sqrtStartPrice.toString(),
      migrationSqrtPrice: migrationSqrtPrice.toString(),
      curvePoints: config.curve.length,
    },
  };
  return { plan, config };
}

/**
 * Fields of a config that follow from how large its curve is. They differ
 * between one set of configs and the next whenever a curve was resized, so a
 * config kept from an earlier set is not held to today's values of them.
 */
const SIZE_DEPENDENT = /^(migrationQuoteThreshold|sqrtStartPrice|curve\[\d+\]\.)/;

/**
 * The launch economics a config was created with, as far as its own account
 * records them: the creator's share of each curve fee, and the migration fee.
 * Everything else is taken from `base`.
 */
export function economicsOfAccount(account: Record<string, unknown>, base: LaunchEconomics): LaunchEconomics {
  return checkEconomics({
    ...base,
    creatorFeeSharePct: Number(account.creatorTradingFeePercentage),
    migrationFeePct: Number(account.migrationFeePercentage),
    creatorMigrationFeeSharePct: Number(account.creatorMigrationFeePercentage),
  });
}

/**
 * Checks a config kept from an earlier set (`DBC_CONFIGS_PREVIOUS`).
 *
 * Such a config takes no new launch, so it need not be the config this server
 * would create today. It must still be one of the platform's own: priced in
 * `quote.pair`, charging exactly `tier`'s fee on the curve and after
 * graduation with no schedule, paying its fees to `partner`, locking all
 * graduated liquidity in the platform's position, and minting the same kind
 * of token. What may differ is what an operator changes between sets: the
 * creator's share of the curve fee, the migration fee, and the curve's size.
 */
export function previousConfigMismatches(
  tier: FeeTier,
  economics: LaunchEconomics,
  quote: CurveQuote,
  account: Record<string, unknown>,
  partner?: PublicKey,
): string[] {
  let built: TierConfigParameters;
  try {
    built = buildTierConfig(tier, economicsOfAccount(account, economics), quote);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  return configMismatches(tier, built, account, partner, quote.pair.mint).filter((problem) => !SIZE_DEPENDENT.test(problem));
}

/** Minimal view of an on-chain `PoolConfig` account, as the SDK's state reader returns it. */
export interface OnChainConfigLike {
  poolFees: {
    baseFee: {
      cliffFeeNumerator: unknown;
      firstFactor: unknown;
      secondFactor: unknown;
      thirdFactor: unknown;
      baseFeeMode: unknown;
    };
    dynamicFee: { initialized: unknown };
  };
  collectFeeMode: unknown;
  migrationOption: unknown;
  migrationFeeOption: unknown;
  migratedPoolFeeBps: unknown;
  migratedDynamicFee: unknown;
  migratedCollectFeeMode: unknown;
  migratedPoolBaseFeeMode?: unknown;
  /** Packed scheduler parameters of the graduated pool's base fee. All zero means "no schedule". */
  migratedPoolBaseFeeBytes?: ArrayLike<number>;
}

/** Fee terms of a config account read back from chain. */
export function feeTermsFromAccount(account: OnChainConfigLike): FeeTerms {
  const base = account.poolFees.baseFee;
  const schedulerBytes = Array.from(account.migratedPoolBaseFeeBytes ?? []);
  return {
    curveFeeNumerator: bnString(base.cliffFeeNumerator),
    curveFeeFirstFactor: Number(base.firstFactor),
    curveFeeSecondFactor: bnString(base.secondFactor),
    curveFeeThirdFactor: bnString(base.thirdFactor),
    curveBaseFeeMode: Number(base.baseFeeMode),
    curveDynamicFeeInitialized: Number(account.poolFees.dynamicFee.initialized) !== 0,
    collectFeeMode: Number(account.collectFeeMode),
    migrationOption: Number(account.migrationOption),
    migrationFeeOption: Number(account.migrationFeeOption),
    migratedPoolFeeBps: Number(account.migratedPoolFeeBps),
    migratedDynamicFee: Number(account.migratedDynamicFee),
    migratedCollectFeeMode: Number(account.migratedCollectFeeMode),
    migratedPoolBaseFeeMode: Number(account.migratedPoolBaseFeeMode ?? 0),
    migratedSchedulerConfigured: schedulerBytes.some((byte) => byte !== 0),
  };
}

/**
 * Every field of an on-chain config that the plan determines, compared one by
 * one with what `buildTierConfig` produces. An empty result means the account
 * is exactly the config this code would create for `tier`, against the pair
 * token whose mint is `quoteMint`, with these economics.
 *
 * It matters twice. After creating a config, it proves the chain holds what
 * was planned. And every time the server starts, it proves the server's own
 * economics settings are the ones its configs were created with: the price of
 * a launch's first buy is computed from those settings, before the pool exists.
 *
 * `partner` is the wallet that must be the fee claimer; leave it out to skip
 * that check. `quoteMint` is the pair token the config must be priced in; left
 * out, it is SOL.
 */
export function configMismatches(
  tier: FeeTier,
  built: TierConfigParameters,
  account: Record<string, unknown>,
  partner?: PublicKey,
  quoteMint: string = SOL_PAIR.mint,
): string[] {
  const problems: string[] = [];
  const same = (label: string, actual: unknown, expected: unknown) => {
    const a = String(actual);
    const e = String(expected);
    if (a !== e) problems.push(`${label}: on chain ${a}, expected ${e}`);
  };
  same('quoteMint', (account.quoteMint as PublicKey).toBase58(), quoteMint);
  if (partner) {
    same('feeClaimer', (account.feeClaimer as PublicKey).toBase58(), partner.toBase58());
    same('leftoverReceiver', (account.leftoverReceiver as PublicKey).toBase58(), partner.toBase58());
  }
  same('tokenType', account.tokenType, built.tokenType);
  same('tokenDecimal', account.tokenDecimal, TOKEN_DECIMALS);
  same('tokenUpdateAuthority', account.tokenUpdateAuthority, built.tokenUpdateAuthority);
  same('activationType', account.activationType, built.activationType);
  same('creatorTradingFeePercentage', account.creatorTradingFeePercentage, built.creatorTradingFeePercentage);
  same('migrationFeePercentage', account.migrationFeePercentage, built.migrationFee.feePercentage);
  same('creatorMigrationFeePercentage', account.creatorMigrationFeePercentage, built.migrationFee.creatorFeePercentage);
  same('partnerPermanentLockedLiquidityPercentage', account.partnerPermanentLockedLiquidityPercentage, built.partnerPermanentLockedLiquidityPercentage);
  same('creatorPermanentLockedLiquidityPercentage', account.creatorPermanentLockedLiquidityPercentage, built.creatorPermanentLockedLiquidityPercentage);
  same('partnerLiquidityPercentage', account.partnerLiquidityPercentage, built.partnerLiquidityPercentage);
  same('creatorLiquidityPercentage', account.creatorLiquidityPercentage, built.creatorLiquidityPercentage);
  same('migrationQuoteThreshold', account.migrationQuoteThreshold, built.migrationQuoteThreshold);
  same('sqrtStartPrice', account.sqrtStartPrice, built.sqrtStartPrice);
  same('preMigrationTokenSupply', account.preMigrationTokenSupply, built.tokenSupply?.preMigrationTokenSupply);
  same('postMigrationTokenSupply', account.postMigrationTokenSupply, built.tokenSupply?.postMigrationTokenSupply);
  same('poolCreationFee', account.poolCreationFee, built.poolCreationFee);
  same('enableFirstSwapWithMinFee', Number(account.enableFirstSwapWithMinFee), built.enableFirstSwapWithMinFee ? 1 : 0);
  const curve = (account.curve ?? []) as Array<{ sqrtPrice: unknown; liquidity: unknown }>;
  built.curve.forEach((point, index) => {
    same(`curve[${index}].sqrtPrice`, curve[index]?.sqrtPrice, point.sqrtPrice);
    same(`curve[${index}].liquidity`, curve[index]?.liquidity, point.liquidity);
  });
  for (let index = built.curve.length; index < curve.length; index += 1) {
    same(`curve[${index}].sqrtPrice`, curve[index]?.sqrtPrice, 0);
    same(`curve[${index}].liquidity`, curve[index]?.liquidity, 0);
  }
  try {
    assertFeeGuarantee(feeTermsFromAccount(account as unknown as OnChainConfigLike), tier);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  return problems;
}
