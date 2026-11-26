import { describe, expect, it } from 'vitest';
import BN from 'bn.js';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  BaseFeeMode,
  DynamicBondingCurveClient,
  MigrationFeeOption,
  SwapMode,
  getMigrationThresholdPrice,
  getQuoteFromInputAmount,
} from '@meteora-ag/dynamic-bonding-curve-sdk';

import { WSOL_MINT } from '../shared/src/constants.js';
import {
  FeeGuaranteeError,
  type TierConfigParameters,
  assertFeeGuarantee,
  buildTierConfig,
  configMismatches,
  feeTermsFromParameters,
  planTier,
} from '../shared/src/curve.js';
import { type Market, MarketError, closingBuy, quoteFirstBuy } from '../shared/src/meteora.js';
import { SOL_PAIR } from '../shared/src/quotes.js';
import { DEFAULT_ECONOMICS, type FeeTier, FEE_TIERS, feeNumeratorFromBps, tierById } from '../shared/src/tiers.js';
import { plusBps } from '../shared/src/units.js';

const partner = Keypair.generate().publicKey;

describe('fee tiers', () => {
  it('are exactly 2%, 3% and 4%', () => {
    expect(FEE_TIERS.map((tier) => tier.feeBps)).toEqual([200, 300, 400]);
    expect(feeNumeratorFromBps(200)).toBe(20_000_000);
    expect(feeNumeratorFromBps(300)).toBe(30_000_000);
    expect(feeNumeratorFromBps(400)).toBe(40_000_000);
  });

  for (const tier of FEE_TIERS) {
    describe(tier.label, () => {
      const { plan, config } = planTier(tier, DEFAULT_ECONOMICS, partner);

      it('charges the tier fee on the curve with no schedule and no dynamic fee', () => {
        const base = config.poolFees.baseFee;
        expect(base.cliffFeeNumerator.toString()).toBe(String(feeNumeratorFromBps(tier.feeBps)));
        expect(base.baseFeeMode).toBe(BaseFeeMode.FeeSchedulerLinear);
        expect(base.firstFactor).toBe(0);
        expect(base.secondFactor.toString()).toBe('0');
        expect(base.thirdFactor.toString()).toBe('0');
        expect(config.poolFees.dynamicFee).toBeNull();
      });

      it('charges the same fee after graduation', () => {
        expect(config.migrationFeeOption).toBe(MigrationFeeOption.Customizable);
        expect(config.migratedPoolFee.poolFeeBps).toBe(tier.feeBps);
        expect(config.migratedPoolFee.dynamicFee).toBe(0);
        expect(plan.feeTerms.migratedPoolFeeBps).toBe(tier.feeBps);
        expect(plan.feeTerms.migratedSchedulerConfigured).toBe(false);
      });

      it("locks all graduated liquidity in the platform's position and gives the creator none", () => {
        expect(plan.summary.lockedLpBpsAtDayOne).toBe(10_000);
        expect(config.partnerLiquidityPercentage).toBe(0);
        expect(config.creatorLiquidityPercentage).toBe(0);
        expect(config.partnerPermanentLockedLiquidityPercentage).toBe(100);
        expect(config.creatorPermanentLockedLiquidityPercentage).toBe(0);
        expect(plan.summary.platformLockedLpPct).toBe(100);
        expect(plan.summary.creatorLockedLpPct).toBe(0);
      });

      it('gives the creator 30% of the curve fee that is left after Meteora, on chain', () => {
        expect(DEFAULT_ECONOMICS.creatorFeeSharePct).toBe(30);
        expect(config.creatorTradingFeePercentage).toBe(30);
        expect(plan.summary.creatorCurveFeeSharePct).toBe(30);
        expect(plan.summary.platformCurveFeeSharePct).toBe(70);
      });

      it('keeps the locked liquidity with the platform whatever the creator earns on the curve', () => {
        for (const share of [0, 30, 50, 70, 100]) {
          const other = buildTierConfig(tier, { ...DEFAULT_ECONOMICS, creatorFeeSharePct: share });
          expect(other.creatorTradingFeePercentage).toBe(share);
          expect(other.partnerPermanentLockedLiquidityPercentage).toBe(100);
          expect(other.creatorPermanentLockedLiquidityPercentage).toBe(0);
          expect(other.partnerLiquidityPercentage).toBe(0);
          expect(other.creatorLiquidityPercentage).toBe(0);
        }
      });

      it("shows Meteora's own fee on the liquidity at graduation", () => {
        const raised = Number(plan.summary.raisedAtGraduation);
        const deposited = Number(plan.summary.depositedAsLiquidity);
        expect(plan.summary.meteoraGraduationFeeBps).toBe(20);
        expect(Number(plan.summary.meteoraGraduationFee)).toBeCloseTo(raised * 0.002, 6);
        expect(deposited).toBeCloseTo(raised * 0.998, 6);
      });

      it('keeps a fixed supply and reaches the planned graduation market cap', () => {
        expect(config.tokenSupply?.preMigrationTokenSupply.toString()).toBe('1000000000000000');
        expect(config.tokenSupply?.postMigrationTokenSupply.toString()).toBe('1000000000000000');
        expect(Number(plan.summary.encodedMigrationMarketCap)).toBeCloseTo(DEFAULT_ECONOMICS.migrationMarketCapSol, 2);
        expect(Number(plan.summary.raisedAtGraduation)).toBeGreaterThan(0);
      });

      it('takes the tier fee out of a simulated first buy, in SOL', () => {
        const amountIn = new BN(1_000_000_000); // 1 SOL
        const quote = getQuoteFromInputAmount({
          config,
          swapBaseForQuote: false,
          amountIn,
          swapMode: SwapMode.ExactIn,
          hasReferral: false,
        });
        const totalFee = quote.tradingFee.add(quote.protocolFee).add(quote.referralFee ?? new BN(0));
        // floor/ceil rounding in the program's fee math is at most one lamport here.
        const expected = amountIn.muln(tier.feeBps).divn(10_000);
        expect(totalFee.sub(expected).abs().lten(1)).toBe(true);
        expect(quote.outputAmount.gtn(0)).toBe(true);
      });
    });
  }
});

describe('fee guarantee', () => {
  const tier = tierById('tier-300');
  const terms = feeTermsFromParameters(buildTierConfig(tier, DEFAULT_ECONOMICS));

  it('accepts the built config', () => {
    expect(() => assertFeeGuarantee(terms, tier)).not.toThrow();
  });

  it('rejects a config whose graduated pool fee is lower', () => {
    expect(() => assertFeeGuarantee({ ...terms, migratedPoolFeeBps: 100 }, tier)).toThrow(FeeGuaranteeError);
  });

  it('rejects a curve fee that decays', () => {
    expect(() => assertFeeGuarantee({ ...terms, curveFeeFirstFactor: 10 }, tier)).toThrow(/periods/);
    expect(() => assertFeeGuarantee({ ...terms, curveFeeThirdFactor: '5' }, tier)).toThrow(/reduction/);
  });

  it('rejects any dynamic fee', () => {
    expect(() => assertFeeGuarantee({ ...terms, curveDynamicFeeInitialized: true }, tier)).toThrow(/dynamic/);
    expect(() => assertFeeGuarantee({ ...terms, migratedDynamicFee: 1 }, tier)).toThrow(/dynamic/);
  });

  it('rejects a fixed Meteora fee option, whose pool terms this config would not control', () => {
    expect(() => assertFeeGuarantee({ ...terms, migrationFeeOption: 3 }, tier)).toThrow(/customizable/);
  });

  it('rejects a graduated-pool market-cap fee schedule', () => {
    expect(() => assertFeeGuarantee({ ...terms, migratedPoolBaseFeeMode: 3 }, tier)).toThrow(/time scheduler/);
    expect(() => assertFeeGuarantee({ ...terms, migratedSchedulerConfigured: true }, tier)).toThrow(/scheduler parameters/);
  });

  it('checks a config against the tier it claims, not just any tier', () => {
    expect(() => assertFeeGuarantee(terms, tierById('tier-400'))).toThrow(FeeGuaranteeError);
  });
});

/** What the chain would hold for a config created from `built`: the same numbers, in the account's own field names. */
function accountFrom(built: TierConfigParameters, feeClaimer: PublicKey): Record<string, unknown> {
  const zero = { sqrtPrice: new BN(0), liquidity: new BN(0) };
  return {
    quoteMint: new PublicKey(WSOL_MINT),
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

describe('a config read back from chain', () => {
  const tier = tierById('tier-300');
  const built = buildTierConfig(tier, DEFAULT_ECONOMICS);

  it('matches the plan it was created from, field for field', () => {
    for (const each of FEE_TIERS) {
      const config = buildTierConfig(each, DEFAULT_ECONOMICS);
      expect(configMismatches(each, config, accountFrom(config, partner), partner)).toEqual([]);
    }
  });

  it('does not match when the server holds different launch settings', () => {
    // A config created for a small first-run curve, read by a server set to the production curve.
    const small = buildTierConfig(tier, { ...DEFAULT_ECONOMICS, initialMarketCapSol: 1, migrationMarketCapSol: 10 });
    const problems = configMismatches(tier, built, accountFrom(small, partner), partner);
    expect(problems.some((problem) => problem.startsWith('migrationQuoteThreshold'))).toBe(true);
    expect(problems.some((problem) => problem.startsWith('sqrtStartPrice'))).toBe(true);
    // And a different fee split shows up as itself.
    const split = buildTierConfig(tier, { ...DEFAULT_ECONOMICS, creatorFeeSharePct: 50 });
    expect(configMismatches(tier, built, accountFrom(split, partner), partner).some((problem) => problem.startsWith('creatorTradingFeePercentage'))).toBe(true);
  });

  it('does not match a config that locks any liquidity to the creator', () => {
    // What an earlier build of this project would have created: 70% of the locked liquidity in the creator's name.
    const account = accountFrom(built, partner);
    account.creatorPermanentLockedLiquidityPercentage = 70;
    account.partnerPermanentLockedLiquidityPercentage = 30;
    const problems = configMismatches(tier, built, account, partner);
    expect(problems.some((problem) => problem.startsWith('creatorPermanentLockedLiquidityPercentage'))).toBe(true);
    expect(problems.some((problem) => problem.startsWith('partnerPermanentLockedLiquidityPercentage'))).toBe(true);
  });

  it('checks who claims the fees, when told who should', () => {
    const stranger = Keypair.generate().publicKey;
    const problems = configMismatches(tier, built, accountFrom(built, stranger), partner);
    expect(problems.filter((problem) => /^(feeClaimer|leftoverReceiver)/.test(problem))).toHaveLength(2);
    expect(configMismatches(tier, built, accountFrom(built, stranger))).toEqual([]);
  });

  it('reports a fee that is not the tier fee, whatever else matches', () => {
    const account = accountFrom(built, partner);
    account.migratedPoolFeeBps = 100;
    expect(configMismatches(tier, built, account, partner).join(' ')).toMatch(/after graduation|graduat/i);
    const dynamic = accountFrom(built, partner);
    dynamic.poolFees = { baseFee: { ...built.poolFees.baseFee }, dynamicFee: { initialized: 1 } };
    expect(configMismatches(tier, built, dynamic, partner).join(' ')).toMatch(/dynamic/i);
  });
});

/* ------------------------------------------------------------------ */
/* Completing a curve                                                   */
/* ------------------------------------------------------------------ */

/** A pool on `built`, as the chain would hold it after `reserve` lamports of buys moved the price to `sqrtPrice`. */
function marketAt(tier: FeeTier, built: TierConfigParameters, sqrtPrice: BN, reserve: BN): Market {
  const config = {
    ...accountFrom(built, partner),
    migrationSqrtPrice: getMigrationThresholdPrice(built.migrationQuoteThreshold, built.sqrtStartPrice, built.curve),
    quoteTokenFlag: 0,
    transferFeeFlag: 0,
    transferFeeBasisPoints: 0,
  };
  const state = {
    poolState: {
      sqrtPrice,
      quoteReserve: reserve,
      activationPoint: new BN(0),
      hasSwap: reserve.isZero() ? 0 : 1,
      isMigrated: 0,
      migrationProgress: 0,
      volatilityTracker: { volatilityAccumulator: new BN(0) },
    },
  };
  return {
    mint: Keypair.generate().publicKey,
    pool: Keypair.generate().publicKey,
    configAddress: Keypair.generate().publicKey,
    config: config as unknown as Market['config'],
    state: state as unknown as Market['state'],
    tier,
    pair: SOL_PAIR,
    stage: 'curve',
    creator: partner,
    dammPool: null,
  };
}

describe('the buy that completes a curve', () => {
  const dbc = new DynamicBondingCurveClient({} as never, 'confirmed');
  const now = new BN(1);
  const sets = [
    { name: 'the first-run curve', economics: { ...DEFAULT_ECONOMICS, initialMarketCapSol: 1, migrationMarketCapSol: 10 } },
    { name: 'the production curve', economics: DEFAULT_ECONOMICS },
  ];

  for (const { name, economics } of sets) {
    for (const tier of FEE_TIERS) {
      const built = buildTierConfig(tier, economics);
      const threshold = BigInt(built.migrationQuoteThreshold.toString());
      const fresh = marketAt(tier, built, built.sqrtStartPrice, new BN(0));

      it(`${name}, ${tier.label}: takes every token the curve sells and lands exactly on graduation`, () => {
        const closing = closingBuy(dbc, fresh, now, 10n ** 15n, 100);
        expect(closing).not.toBeNull();
        if (!closing) return;
        expect(closing.completesCurve).toBe(true);
        expect(closing.mode).toBe('exact-out');
        // The chain's own arithmetic for the same exact-out swap: it stops on the graduation price
        // and the SOL that enters the curve is the whole graduation target.
        const check = dbc.pool.swapQuote2({
          virtualPool: fresh.state,
          config: fresh.config,
          swapBaseForQuote: false,
          hasReferral: false,
          eligibleForFirstSwapWithMinFee: false,
          currentPoint: now,
          slippageBps: 0,
          swapMode: SwapMode.ExactOut,
          amountOut: new BN(closing.amountOut.toString()),
        });
        expect(check.nextSqrtPrice.eq((fresh.config as unknown as { migrationSqrtPrice: BN }).migrationSqrtPrice)).toBe(true);
        expect(BigInt(check.excludedFeeInputAmount.toString())).toBe(threshold);
        expect(BigInt(check.includedTransferFeeAmountIn.toString())).toBe(closing.amountIn);
        // The fee is the tier's, on the whole cost.
        expect(closing.fee).toBe(closing.amountIn - threshold);
        expect(Number(closing.fee) / Number(closing.amountIn)).toBeCloseTo(tier.feeBps / 10_000, 6);
        // One more token unit does not exist on the curve.
        expect(() =>
          dbc.pool.swapQuote2({
            virtualPool: fresh.state,
            config: fresh.config,
            swapBaseForQuote: false,
            hasReferral: false,
            eligibleForFirstSwapWithMinFee: false,
            currentPoint: now,
            slippageBps: 0,
            swapMode: SwapMode.ExactOut,
            amountOut: new BN((closing.amountOut + 1n).toString()),
          }),
        ).toThrow();
      });

      it(`${name}, ${tier.label}: never asks for more than was offered, and is not used when the curve has room`, () => {
        const closing = closingBuy(dbc, fresh, now, 10n ** 15n, 100);
        if (!closing) throw new Error('expected a closing buy');
        const cost = closing.amountIn;
        // Offering exactly the cost fits inside the curve, so it is an ordinary buy.
        expect(closingBuy(dbc, fresh, now, cost, 100)).toBeNull();
        expect(closingBuy(dbc, fresh, now, cost / 2n, 100)).toBeNull();
        // One lamport more than the cost is the smallest offer that completes it.
        const tight = closingBuy(dbc, fresh, now, cost + 1n, 100);
        expect(tight?.amountOut).toBe(closing.amountOut);
        expect(tight?.amountIn).toBe(cost);
        expect(tight?.maximumAmountIn).toBe(cost + 1n);
        // With plenty offered, the ceiling is the cost plus the slippage allowance, not the offer.
        expect(closing.maximumAmountIn).toBe(plusBps(cost, 100));
      });

      it(`${name}, ${tier.label}: completes a curve that others have already bought into`, () => {
        // Somebody buys a third of the curve first.
        const first = dbc.pool.swapQuote2({
          virtualPool: fresh.state,
          config: fresh.config,
          swapBaseForQuote: false,
          hasReferral: false,
          eligibleForFirstSwapWithMinFee: false,
          currentPoint: now,
          slippageBps: 0,
          swapMode: SwapMode.ExactIn,
          amountIn: new BN((threshold / 3n).toString()),
        });
        const later = marketAt(tier, built, first.nextSqrtPrice, first.excludedFeeInputAmount);
        const closing = closingBuy(dbc, later, now, 10n ** 15n, 100);
        if (!closing) throw new Error('expected a closing buy');
        const check = dbc.pool.swapQuote2({
          virtualPool: later.state,
          config: later.config,
          swapBaseForQuote: false,
          hasReferral: false,
          eligibleForFirstSwapWithMinFee: false,
          currentPoint: now,
          slippageBps: 0,
          swapMode: SwapMode.ExactOut,
          amountOut: new BN(closing.amountOut.toString()),
        });
        const reserve = BigInt(first.excludedFeeInputAmount.add(check.excludedFeeInputAmount).toString());
        expect(reserve >= threshold).toBe(true);
        expect(reserve - threshold <= 2n).toBe(true);
      });
    }
  }

  it('is not offered once the curve is complete', () => {
    const tier = tierById('tier-300');
    const built = buildTierConfig(tier, DEFAULT_ECONOMICS);
    const market = { ...marketAt(tier, built, built.sqrtStartPrice, new BN(0)), stage: 'migrating' as const };
    expect(closingBuy(dbc, market, now, 10n ** 15n, 100)).toBeNull();
  });

  it('refuses a first buy larger than the whole curve, in plain words', () => {
    const built = buildTierConfig(tierById('tier-300'), { ...DEFAULT_ECONOMICS, initialMarketCapSol: 1, migrationMarketCapSol: 10 });
    expect(quoteFirstBuy(built, 2_000_000_000n).tokensOut > 0n).toBe(true);
    let caught: unknown;
    try {
      quoteFirstBuy(built, 3_000_000_000n);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MarketError);
    expect((caught as MarketError).code).toBe('TOO_LARGE');
  });
});
