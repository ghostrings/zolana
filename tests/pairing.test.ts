/**
 * Launching and trading against a pair token other than SOL: the settings, the
 * configs, what is read from chain before a pair is trusted, and the numbers
 * the pages show. Everything here runs offline.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import BN from 'bn.js';
import { type AccountInfo, Keypair, PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, ExtensionType, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { deriveDbcPoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk';

import { payoutInstructions } from '../ops/pairs.js';
import { readPageRequest, tokenPage } from '../server/src/listing.js';
import { Store } from '../server/src/db.js';
import { EnvError, configuredTiers, readEnv } from '../server/src/env.js';
import { describePair, interfaceRegistryAddress, pairRate, resolvePairs } from '../server/src/pairs.js';
import { SOL_DECIMALS, WSOL_MINT } from '../shared/src/constants.js';
import { buildTierConfig, configMismatches, planTier, solCurveQuote } from '../shared/src/curve.js';
import { type Market, MarketError, allowedConfigMap, curveStats, loadMarket, marketFromAccounts, mintDecimals, quoteFirstBuy, quoteMintOf } from '../shared/src/meteora.js';
import { pairMintNotes, pairMintProblems, readMintFacts } from '../shared/src/mint.js';
import {
  PAIR_TOKENS,
  PairError,
  SOL_PAIR,
  configEnvKey,
  curveEnvKeys,
  fromSolLamports,
  keeperRule,
  pairTokenById,
  pairTokenByMint,
  toSolValue,
  tradingPair,
  unitsPerSol,
} from '../shared/src/quotes.js';
import { quoteAssetOf } from '../shared/src/routes.js';
import { DEFAULT_ECONOMICS, FEE_TIERS, checkCurveSize, solCurveSize, tierById } from '../shared/src/tiers.js';
import { fromLegacyInstruction, legacyInstructionFields } from '../shared/src/tx.js';
import { pairsTable } from '../web/src/docs/vars.js';
import { SOL_REF, amount, compact, curveQuoteOf, inPairUnits, isSol, pairOf, plain, quickAmounts, tradeCap, withUnit } from '../web/src/pairs.js';
import { ADDRESSES, USDC, ZEC, configAccountFrom, mintAccount, pairStatuses, pairedEnv, registryAccount, resolvedOk, statusFixture } from './fixtures.js';

const partner = Keypair.generate().publicKey;
const tier300 = tierById('tier-300');
const USDC_SIZE = { initialMarketCap: 2500, migrationMarketCap: 35_000 };
const usdcQuote = { pair: USDC, size: USDC_SIZE };

describe('pair settings in the environment', () => {
  it('knows all eight pair tokens and has only SOL in use by default', () => {
    const env = readEnv({});
    expect(env.pairs.map((entry) => entry.token.id)).toEqual(PAIR_TOKENS.map((token) => token.id));
    expect(env.pairs.filter((entry) => entry.size !== undefined).map((entry) => entry.token.id)).toEqual(['SOL']);
    expect(env.pairs[0]?.size).toEqual(solCurveSize(env.economics));
    expect(env.pairs[0]?.configs).toEqual(env.configs);
    expect(configuredTiers(env)).toEqual([]);
  });

  it('names a pair’s settings after the pair, and leaves SOL’s as they always were', () => {
    expect(configEnvKey(tier300, 'SOL')).toBe('DBC_CONFIG_300');
    expect(configEnvKey(tier300, 'USDC')).toBe('DBC_CONFIG_300_USDC');
    expect(configEnvKey(tierById('tier-200'), 'HSOL')).toBe('DBC_CONFIG_200_HSOL');
    expect(curveEnvKeys('ZEC')).toEqual({ initial: 'CURVE_INITIAL_MARKET_CAP_ZEC', migration: 'CURVE_MIGRATION_MARKET_CAP_ZEC' });
    expect(curveEnvKeys('SOL')).toEqual({ initial: 'CURVE_INITIAL_MARKET_CAP_SOL', migration: 'CURVE_MIGRATION_MARKET_CAP_SOL' });
  });

  it('switches a pair on by its curve size and its config addresses', () => {
    const env = pairedEnv();
    const usdc = env.pairs.find((entry) => entry.token.id === 'USDC');
    expect(usdc?.size).toEqual(USDC_SIZE);
    expect(usdc?.configs).toEqual({ 200: undefined, 300: ADDRESSES[3], 400: undefined });
    expect(configuredTiers(env)).toEqual([
      { feeBps: 200, address: ADDRESSES[0], pairId: 'SOL' },
      { feeBps: 300, address: ADDRESSES[1], pairId: 'SOL' },
      { feeBps: 400, address: ADDRESSES[2], pairId: 'SOL' },
      { feeBps: 300, address: ADDRESSES[3], pairId: 'USDC' },
    ]);
    // A pair can be sized before any config exists: that is the state `configs:plan` works from.
    const sized = readEnv({ CURVE_INITIAL_MARKET_CAP_ZEC: '9', CURVE_MIGRATION_MARKET_CAP_ZEC: '126.5' });
    expect(sized.pairs.find((entry) => entry.token.id === 'ZEC')?.size).toEqual({ initialMarketCap: 9, migrationMarketCap: 126.5 });
  });

  it('stops on a half-set pair, naming what is missing', () => {
    expect(() => readEnv({ CURVE_INITIAL_MARKET_CAP_USDC: '2500' })).toThrow(/CURVE_MIGRATION_MARKET_CAP_USDC go together/);
    expect(() => readEnv({ CURVE_MIGRATION_MARKET_CAP_USDC: '35000' })).toThrow(EnvError);
    expect(() => readEnv({ DBC_CONFIG_300_USDC: ADDRESSES[3] })).toThrow(/DBC_CONFIG_300_USDC is set, so CURVE_INITIAL_MARKET_CAP_USDC/);
    expect(() => readEnv({ DBC_CONFIG_400_HSOL: 'not an address' })).toThrow(/DBC_CONFIG_400_HSOL must be a Solana address/);
  });

  it('accepts only plain, sensible curve sizes', () => {
    const size = (initial: string, migration: string) => () => readEnv({ CURVE_INITIAL_MARKET_CAP_USDC: initial, CURVE_MIGRATION_MARKET_CAP_USDC: migration });
    expect(size('2,500', '35000')).toThrow(/plain numbers of USDC/);
    expect(size('2.5e3', '35000')).toThrow(/plain numbers/);
    expect(size('-1', '35000')).toThrow(/plain numbers/);
    expect(size('0', '35000')).toThrow(/must be positive/);
    expect(size('35000', '2500')).toThrow(/greater than the starting market cap/);
    expect(size('2500', '2500')).toThrow(EnvError);
    expect(() => checkCurveSize({ initialMarketCap: Number.NaN, migrationMarketCap: 5 }, 'x')).toThrow();
  });

  it('refuses one config address in two places', () => {
    expect(() => pairedEnv({ DBC_CONFIG_300_USDC: ADDRESSES[1] })).toThrow(/DBC_CONFIG_300_USDC and DBC_CONFIG_300 hold the same address/);
    expect(() => pairedEnv({ DBC_CONFIG_200_USDC: ADDRESSES[3] })).toThrow(/hold the same address/);
  });
});

describe('a pair token as trading code uses it', () => {
  it('is SOL itself for SOL, and carries the mint’s own decimals for anything else', () => {
    expect(tradingPair(pairTokenById('SOL') as never, 9)).toBe(SOL_PAIR);
    expect(SOL_PAIR).toMatchObject({ id: 'SOL', mint: WSOL_MINT, decimals: SOL_DECIMALS, native: true });
    expect(USDC).toMatchObject({ id: 'USDC', symbol: 'USDC', decimals: 6, native: false });
    expect(tradingPair(pairTokenById('HSOL') as never, 9).symbol).toBe('hSOL');
    // A token with no pinned decimals takes whatever its mint has.
    expect(tradingPair(pairTokenById('RENDER') as never, 8).decimals).toBe(8);
  });

  it('refuses decimals that are not the ones the token is listed with', () => {
    expect(() => tradingPair(pairTokenById('USDC') as never, 9)).toThrow(PairError);
    expect(() => tradingPair(pairTokenById('ZEC') as never, 6)).toThrow(/expects 8/);
    expect(() => tradingPair(pairTokenById('XMR') as never, 40)).toThrow(PairError);
    expect(() => tradingPair(pairTokenById('XMR') as never, 1.5)).toThrow(PairError);
  });

  it('is found by its mint', () => {
    expect(pairTokenByMint(USDC.mint)?.id).toBe('USDC');
    expect(pairTokenByMint(WSOL_MINT)?.id).toBe('SOL');
    expect(pairTokenByMint(partner.toBase58())).toBeUndefined();
  });

  it('is held by Rings as native SOL, or under its own mint', () => {
    expect(quoteAssetOf({ pair: USDC })).toBe(USDC.mint);
    expect(quoteAssetOf({ pair: SOL_PAIR })).not.toBe(WSOL_MINT);
    expect(quoteMintOf({ pair: SOL_PAIR }).toBase58()).toBe(WSOL_MINT);
    expect(quoteMintOf({ pair: ZEC }).toBase58()).toBe(ZEC.mint);
  });
});

describe('the config of a pair', () => {
  it('is the SOL config, unchanged, when no pair is named', () => {
    for (const tier of FEE_TIERS) {
      const plain = buildTierConfig(tier, DEFAULT_ECONOMICS);
      const named = buildTierConfig(tier, DEFAULT_ECONOMICS, solCurveQuote(DEFAULT_ECONOMICS));
      expect(JSON.stringify(named)).toBe(JSON.stringify(plain));
      expect(configMismatches(tier, plain, configAccountFrom(named, partner, WSOL_MINT), partner)).toEqual([]);
    }
    const { plan } = planTier(tier300, DEFAULT_ECONOMICS, partner);
    expect(plan).toMatchObject({ pair: 'SOL', pairSymbol: 'SOL', quoteMint: WSOL_MINT, quoteDecimals: 9, envKey: 'DBC_CONFIG_300' });
    expect(plan.size).toEqual({ initialMarketCap: 30, migrationMarketCap: 420 });
  });

  for (const tier of FEE_TIERS) {
    it(`charges the same fixed ${tier.label} against USDC, in USDC, with all liquidity locked to the platform`, () => {
      const { plan, config } = planTier(tier, DEFAULT_ECONOMICS, partner, usdcQuote);
      expect(plan).toMatchObject({ pair: 'USDC', quoteMint: USDC.mint, quoteDecimals: 6, envKey: `${tier.envKey}_USDC` });
      expect(plan.feeTerms.migratedPoolFeeBps).toBe(tier.feeBps);
      expect(plan.feeTerms.curveDynamicFeeInitialized).toBe(false);
      expect(plan.summary.lockedLpBpsAtDayOne).toBe(10_000);
      expect(config.partnerPermanentLockedLiquidityPercentage).toBe(100);
      expect(config.creatorPermanentLockedLiquidityPercentage).toBe(0);
      expect(config.tokenSupply?.preMigrationTokenSupply.toString()).toBe('1000000000000000');
      expect(Number(plan.summary.encodedMigrationMarketCap)).toBeCloseTo(35_000, 0);
      // A first buy of 10 USDC pays the tier's fee in USDC base units.
      const first = quoteFirstBuy(config, 10_000_000n);
      expect(first.fee).toBe((10_000_000n * BigInt(tier.feeBps)) / 10_000n);
      expect(first.tokensOut > 0n).toBe(true);
    });
  }

  it('raises in proportion to its size: a curve 83⅓ times the SOL curve raises 83⅓ times as much', () => {
    const sol = planTier(tier300, DEFAULT_ECONOMICS, partner);
    const usdc = planTier(tier300, DEFAULT_ECONOMICS, partner, usdcQuote);
    const rate = unitsPerSol(USDC_SIZE.initialMarketCap, DEFAULT_ECONOMICS.initialMarketCapSol);
    expect(rate).toBeCloseTo(83.3333, 3);
    expect(Number(usdc.plan.summary.raisedAtGraduation) / Number(sol.plan.summary.raisedAtGraduation)).toBeCloseTo(rate, 6);
    // So a completed curve counts for the same in SOL terms whatever it is priced in.
    expect(toSolValue(usdc.config.migrationQuoteThreshold.toString(), USDC, rate)).toBeCloseTo(Number(sol.plan.summary.raisedAtGraduation), 5);
  });

  it('depends on the pair token’s decimals: the same numbers against another mint are another curve', () => {
    const six = buildTierConfig(tier300, DEFAULT_ECONOMICS, usdcQuote);
    const nine = buildTierConfig(tier300, DEFAULT_ECONOMICS, { pair: { ...USDC, decimals: 9 }, size: USDC_SIZE });
    expect(six.sqrtStartPrice.eq(nine.sqrtStartPrice)).toBe(false);
    // A server told the wrong decimals would not recognise the real config.
    const problems = configMismatches(tier300, nine, configAccountFrom(six, partner, USDC.mint), partner, USDC.mint);
    expect(problems.some((problem) => problem.startsWith('sqrtStartPrice'))).toBe(true);
    expect(problems.some((problem) => problem.startsWith('migrationQuoteThreshold'))).toBe(true);
  });

  it('is recognised on chain only under its own pair token', () => {
    const built = buildTierConfig(tier300, DEFAULT_ECONOMICS, usdcQuote);
    expect(configMismatches(tier300, built, configAccountFrom(built, partner, USDC.mint), partner, USDC.mint)).toEqual([]);
    // The same account read as a SOL config, or as another pair's.
    expect(configMismatches(tier300, built, configAccountFrom(built, partner, USDC.mint), partner).some((problem) => problem.startsWith('quoteMint'))).toBe(true);
    expect(configMismatches(tier300, built, configAccountFrom(built, partner, USDC.mint), partner, ZEC.mint)[0]).toMatch(/^quoteMint/);
    // And a SOL config is not a USDC one, whatever else matches.
    const sol = buildTierConfig(tier300, DEFAULT_ECONOMICS);
    expect(configMismatches(tier300, sol, configAccountFrom(sol, partner, WSOL_MINT), partner, USDC.mint)).toEqual([`quoteMint: on chain ${WSOL_MINT}, expected ${USDC.mint}`]);
  });

  it('builds for eight and nine decimals too', () => {
    const zec = planTier(tier300, DEFAULT_ECONOMICS, partner, { pair: ZEC, size: { initialMarketCap: 9, migrationMarketCap: 126 } });
    expect(Number(zec.plan.summary.encodedMigrationMarketCap)).toBeCloseTo(126, 2);
    expect(zec.plan.envKey).toBe('DBC_CONFIG_300_ZEC');
    const hsol = planTier(tier300, DEFAULT_ECONOMICS, partner, { pair: tradingPair(pairTokenById('hSOL') as never, 9), size: { initialMarketCap: 26, migrationMarketCap: 364 } });
    expect(Number(hsol.plan.summary.raisedAtGraduation)).toBeCloseTo(76.7664, 3);
    expect(() => planTier(tier300, DEFAULT_ECONOMICS, partner, { pair: USDC, size: { initialMarketCap: 10, migrationMarketCap: 5 } })).toThrow(/greater than the starting market cap/);
  });
});

describe('who graduates a completed curve', () => {
  const units = (whole: number, decimals: number): bigint => BigInt(Math.round(whole * 10 ** decimals));

  it('is Meteora’s keeper for SOL and USDC curves of its published sizes', () => {
    expect(keeperRule(SOL_PAIR, units(88.57, 9)).automatic).toBe(true);
    expect(keeperRule(SOL_PAIR, units(10, 9)).automatic).toBe(true);
    expect(keeperRule(SOL_PAIR, units(9.99, 9)).automatic).toBe(false);
    expect(keeperRule(USDC, units(750, 6)).automatic).toBe(true);
    expect(keeperRule(USDC, units(749.99, 6)).automatic).toBe(false);
    expect(keeperRule(SOL_PAIR, units(2, 9)).note).toMatch(/Anyone can send the graduation/);
  });

  it('is not known in advance for any other pair token', () => {
    for (const id of ['ZEC', 'NEAR', 'XMR', 'ANT', 'RENDER', 'HSOL']) {
      const rule = keeperRule(tradingPair(pairTokenById(id) as never, pairTokenById(id)?.expectedDecimals ?? 8), 10n ** 15n);
      expect(rule.automatic, id).toBeNull();
      expect(rule.note, id).toMatch(/organic score above 50/);
    }
  });

  it('is reported with each planned tier', () => {
    expect(planTier(tier300, DEFAULT_ECONOMICS, partner).plan.summary.keeper.automatic).toBe(true);
    expect(planTier(tier300, DEFAULT_ECONOMICS, partner, usdcQuote).plan.summary.keeper.automatic).toBe(true);
    expect(planTier(tier300, DEFAULT_ECONOMICS, partner, { pair: USDC, size: { initialMarketCap: 100, migrationMarketCap: 1400 } }).plan.summary.keeper.automatic).toBe(false);
  });
});

describe('comparing across pairs', () => {
  it('turns a SOL limit into a pair token’s base units, and back into SOL terms', () => {
    const rate = unitsPerSol(2500, 30);
    expect(fromSolLamports(500_000_000n, USDC, rate)).toBe(41_666_666n);
    expect(fromSolLamports(500_000_000n, SOL_PAIR, 1)).toBe(500_000_000n);
    // SOL is never converted, whatever rate it is handed.
    expect(fromSolLamports(123n, SOL_PAIR, 99)).toBe(123n);
    expect(toSolValue(41_666_666n, USDC, rate)).toBeCloseTo(0.5, 6);
    expect(toSolValue('2000000000', SOL_PAIR, 1)).toBe(2);
    expect(fromSolLamports(1_000_000_000n, ZEC, 0.3)).toBe(30_000_000n);
  });

  it('refuses a rate that is not one', () => {
    expect(() => unitsPerSol(0, 30)).toThrow(PairError);
    expect(() => unitsPerSol(2500, 0)).toThrow(PairError);
    expect(() => fromSolLamports(1n, USDC, 0)).toThrow(PairError);
    expect(() => fromSolLamports(1n, USDC, Number.NaN)).toThrow(PairError);
    // A missing rate counts for nothing in a total; it never counts as SOL.
    expect(toSolValue(5_000_000n, USDC, 0)).toBe(0);
  });

  it('takes a pair’s rate from how its curve was sized next to the SOL curve', () => {
    const env = pairedEnv();
    expect(pairRate(env.pairs[0] as never, env.economics)).toBe(1);
    expect(pairRate(env.pairs.find((entry) => entry.token.id === 'USDC') as never, env.economics)).toBeCloseTo(83.3333, 3);
    expect(pairRate(env.pairs.find((entry) => entry.token.id === 'ZEC') as never, env.economics)).toBe(0);
  });
});

describe('what a mint must be to be a pair token', () => {
  const token = pairTokenById('USDC') as NonNullable<ReturnType<typeof pairTokenById>>;
  const mint = new PublicKey(token.mint);
  const issuer = Keypair.generate().publicKey;

  it('accepts an ordinary SPL Token mint with the listed decimals', () => {
    const facts = readMintFacts(mint, mintAccount(6, { mintAuthority: issuer, freezeAuthority: issuer }));
    expect(pairMintProblems(token, facts)).toEqual([]);
    // Who controls it is said, and is not a reason to refuse it.
    expect(pairMintNotes(facts)).toHaveLength(2);
    expect(pairMintNotes(facts)[0]).toMatch(/can freeze any account/);
    expect(pairMintNotes(readMintFacts(mint, mintAccount(6)))).toEqual([]);
  });

  it('refuses the wrong decimals', () => {
    expect(pairMintProblems(token, readMintFacts(mint, mintAccount(9)))[0]).toMatch(/has 9 decimals on chain, and this build expects 6/);
  });

  it('refuses a Token-2022 mint, with or without extensions that change a transfer', () => {
    const plain2022 = pairMintProblems(token, { program: 'token-2022', decimals: 6, mintAuthority: null, freezeAuthority: null, extensions: ['MetadataPointer'], restrictive: [] });
    expect(plain2022).toHaveLength(1);
    expect(plain2022[0]).toMatch(/Token-2022 mint \(MetadataPointer\)/);
    const hooked = pairMintProblems(token, {
      program: 'token-2022',
      decimals: 6,
      mintAuthority: null,
      freezeAuthority: null,
      extensions: [ExtensionType[ExtensionType.TransferHook] as string, ExtensionType[ExtensionType.PermanentDelegate] as string],
      restrictive: ['TransferHook', 'PermanentDelegate'],
    });
    expect(hooked).toHaveLength(2);
    expect(hooked[1]).toMatch(/TransferHook, PermanentDelegate/);
  });

  it('reads the decimals of an SPL mint, and of nothing else', () => {
    expect(mintDecimals(mintAccount(6))).toBe(6);
    expect(mintDecimals(mintAccount(8))).toBe(8);
    expect(mintDecimals(mintAccount(6, { owner: TOKEN_2022_PROGRAM_ID }))).toBeNull();
    expect(mintDecimals({ owner: TOKEN_PROGRAM_ID, data: Buffer.alloc(165) })).toBeNull();
    expect(mintDecimals(null)).toBeNull();
  });
});

describe('reading the pair tokens from chain', () => {
  /** A connection that answers `getMultipleAccountsInfo` from a table, and counts the calls. */
  function connectionWith(accounts: Map<string, AccountInfo<Buffer>>): { calls: number; getMultipleAccountsInfo(keys: PublicKey[]): Promise<Array<AccountInfo<Buffer> | null>> } {
    return {
      calls: 0,
      async getMultipleAccountsInfo(keys) {
        this.calls += 1;
        return keys.map((key) => accounts.get(key.toBase58()) ?? null);
      },
    };
  }
  const env = pairedEnv({ CURVE_INITIAL_MARKET_CAP_ZEC: '9', CURVE_MIGRATION_MARKET_CAP_ZEC: '126', CURVE_INITIAL_MARKET_CAP_ANT: '45', CURVE_MIGRATION_MARKET_CAP_ANT: '630' });
  const inUse = env.pairs.filter((entry) => entry.size !== undefined);

  it('confirms a pair whose mint and Rings interface are both there, in two requests for all of them', async () => {
    const usdcMint = new PublicKey(USDC.mint);
    const zecMint = new PublicKey(ZEC.mint);
    const antMint = new PublicKey((pairTokenById('ANT') as never as { mint: string }).mint);
    const accounts = new Map<string, AccountInfo<Buffer>>([
      [usdcMint.toBase58(), mintAccount(6, { freezeAuthority: partner })],
      [(await interfaceRegistryAddress(USDC.mint)).toBase58(), registryAccount(usdcMint)],
      // ZEC: a mint, but Rings has no interface for it.
      [zecMint.toBase58(), mintAccount(8)],
      // ANT: a Token-2022 mint.
      [antMint.toBase58(), { ...mintAccount(6), owner: TOKEN_2022_PROGRAM_ID }],
      [(await interfaceRegistryAddress(antMint.toBase58())).toBase58(), registryAccount(antMint)],
    ]);
    const connection = connectionWith(accounts);
    const resolved = await resolvePairs(connection as never, inUse);
    expect(connection.calls).toBe(2);
    expect(resolved.map((result) => result.env.token.id)).toEqual(['SOL', 'USDC', 'ZEC', 'ANT']);
    const [sol, usdc, zec, ant] = resolved;
    expect(sol?.pair).toBe(SOL_PAIR);
    expect(usdc?.pair).toEqual(USDC);
    expect(usdc?.problems).toEqual([]);
    expect(usdc?.notes[0]).toMatch(/can freeze/);
    expect(zec?.pair).toBeUndefined();
    expect(zec?.hasInterface).toBe(false);
    expect(zec?.problems[0]).toMatch(/Rings has no interface for ZEC/);
    expect(ant?.pair).toBeUndefined();
    expect(ant?.problems[0]).toMatch(/Token-2022/);
  });

  it('reports a mint that is not there as a problem of that pair alone', async () => {
    const resolved = await resolvePairs(connectionWith(new Map()) as never, inUse);
    expect(resolved[0]?.pair).toBe(SOL_PAIR);
    expect(resolved[1]?.pair).toBeUndefined();
    expect(resolved[1]?.problems[0]).toMatch(/USDC: there is no account at this address/);
  });

  it('does not take an account of another program for a Rings interface', async () => {
    const usdcMint = new PublicKey(USDC.mint);
    const fake = { ...registryAccount(usdcMint), owner: SystemProgram.programId };
    const accounts = new Map<string, AccountInfo<Buffer>>([
      [usdcMint.toBase58(), mintAccount(6)],
      [(await interfaceRegistryAddress(USDC.mint)).toBase58(), fake],
    ]);
    const [, usdc] = await resolvePairs(connectionWith(accounts) as never, inUse);
    expect(usdc?.hasInterface).toBe(false);
    expect(usdc?.pair).toBeUndefined();
  });

  it('asks nothing of the chain when SOL is the only pair in use', async () => {
    const connection = connectionWith(new Map());
    const resolved = await resolvePairs(connection as never, readEnv({}).pairs.filter((entry) => entry.size !== undefined));
    expect(connection.calls).toBe(0);
    expect(resolved).toHaveLength(1);
  });
});

describe('a pair as the pages receive it', () => {
  const env = pairedEnv();
  const live = () => ({ live: true, problem: null });

  it('is live for SOL and for a confirmed pair, tier by tier', () => {
    const [sol, usdc] = pairStatuses(env);
    expect(sol).toMatchObject({ id: 'SOL', native: true, live: true, problem: null, unitsPerSol: 1, decimals: 9, keeperGraduates: true });
    expect(sol?.curve).toEqual({ initialMarketCap: 30, migrationMarketCap: 420 });
    expect(usdc).toMatchObject({ id: 'USDC', symbol: 'USDC', native: false, live: true, problem: null, decimals: 6, keeperGraduates: true });
    expect(usdc?.unitsPerSol).toBeCloseTo(83.3333, 3);
    // Only the tier whose config exists can take launches.
    expect(usdc?.tiers.map((tier) => [tier.feeBps, tier.live, tier.config])).toEqual([
      [200, false, null],
      [300, true, ADDRESSES[3]],
      [400, false, null],
    ]);
    expect(usdc?.tiers[0]?.problem).toBe('Not created yet.');
    expect(usdc?.holderNotes).toHaveLength(1);
  });

  it('says why a pair is off', () => {
    const usdcEnv = env.pairs.find((entry) => entry.token.id === 'USDC') as never;
    const zecEnv = env.pairs.find((entry) => entry.token.id === 'ZEC') as never;
    const notSetUp = describePair(zecEnv, env.economics, undefined, live, true);
    expect(notSetUp).toMatchObject({ live: false, curve: null, unitsPerSol: 0, keeperGraduates: null, keeperNote: '' });
    expect(notSetUp.problem).toMatch(/Not set up yet.*CURVE_INITIAL_MARKET_CAP_ZEC/);
    expect(notSetUp.decimals).toBe(8);
    expect(describePair(usdcEnv, env.economics, undefined, live, true).problem).toBe('Still being checked against the chain.');
    expect(describePair(usdcEnv, env.economics, undefined, live, false).problem).toBe('The RPC is not configured.');
    const broken = describePair(usdcEnv, env.economics, { ...resolvedOk(env, 'USDC', 6), pair: undefined, problems: ['USDC is a Token-2022 mint. This build moves SPL Token pair mints only.'] }, live, true);
    expect(broken.live).toBe(false);
    expect(broken.problem).toMatch(/Token-2022/);
    // Every tier of a pair that is off says the pair's reason, not "live".
    expect(broken.tiers.every((tier) => !tier.live && tier.problem === broken.problem)).toBe(true);
  });

  it('keeps a tier off when its config does not match, while the pair stays tradable', () => {
    const usdcEnv = env.pairs.find((entry) => entry.token.id === 'USDC') as never;
    const mismatch = describePair(usdcEnv, env.economics, resolvedOk(env, 'USDC', 6), () => ({ live: false, problem: 'This server\'s launch settings are not the ones this tier\'s config was created with.' }), true);
    expect(mismatch.problem).toBeNull();
    expect(mismatch.live).toBe(false);
    expect(mismatch.tiers[1]?.problem).toMatch(/launch settings/);
  });
});

describe('finding a token’s pool under any pair', () => {
  const baseMint = Keypair.generate().publicKey;
  const creator = Keypair.generate().publicKey;
  const solConfig = new PublicKey(ADDRESSES[1]);
  const usdcConfig = new PublicKey(ADDRESSES[3]);
  const allowed = allowedConfigMap([
    { address: ADDRESSES[1], feeBps: 300, pair: SOL_PAIR },
    { address: ADDRESSES[3], feeBps: 300, pair: USDC },
    { address: undefined, feeBps: 400, pair: USDC },
  ]);
  const built = buildTierConfig(tier300, DEFAULT_ECONOMICS, usdcQuote);
  const config = { ...configAccountFrom(built, partner, USDC.mint), migrationSqrtPrice: new BN(0) };
  const state = {
    poolState: {
      baseMint,
      config: usdcConfig,
      creator,
      sqrtPrice: built.sqrtStartPrice,
      quoteReserve: new BN(1_000_000),
      isMigrated: 0,
      migrationProgress: 0,
      creatorQuoteFee: new BN(0),
      partnerQuoteFee: new BN(0),
      metrics: { totalTradingQuoteFee: new BN(0), totalProtocolQuoteFee: new BN(0) },
    },
  };
  const usdcPool = deriveDbcPoolAddress(new PublicKey(USDC.mint), baseMint, usdcConfig);
  const solPool = deriveDbcPoolAddress(new PublicKey(WSOL_MINT), baseMint, solConfig);
  const programId = Keypair.generate().publicKey;

  /** A stand-in for the DBC client: one pool account exists, and it decodes to `state`. */
  function client(existing: PublicKey) {
    const asked: string[][] = [];
    return {
      asked,
      connection: {
        async getMultipleAccountsInfo(keys: PublicKey[]) {
          asked.push(keys.map((key) => key.toBase58()));
          return keys.map((key) => (key.equals(existing) ? { owner: programId, data: Buffer.alloc(8) } : null));
        },
      },
      program: { programId, coder: { accounts: { decode: () => state } } },
      state: { getPoolConfig: async () => config },
    };
  }

  it('maps each config to its tier and its pair, and refuses an address used twice', () => {
    expect([...allowed.keys()]).toEqual([ADDRESSES[1], ADDRESSES[3]]);
    expect(allowed.get(ADDRESSES[3])).toEqual({ tier: tier300, pair: USDC });
    expect(() => allowedConfigMap([{ address: ADDRESSES[1], feeBps: 300, pair: SOL_PAIR }, { address: ADDRESSES[1], feeBps: 300, pair: USDC }])).toThrow(/more than one tier or pair/);
    expect(() => allowedConfigMap([{ address: ADDRESSES[1], feeBps: 250, pair: SOL_PAIR }])).toThrow(MarketError);
  });

  it('looks under every config at once, each with its own pair token, and finds the USDC pool', async () => {
    const dbc = client(usdcPool);
    const market = await loadMarket(dbc as never, baseMint, allowed);
    // One request, naming the one address the pool could have under each config.
    expect(dbc.asked).toEqual([[solPool.toBase58(), usdcPool.toBase58()]]);
    expect(market.pair).toEqual(USDC);
    expect(market.pool.equals(usdcPool)).toBe(true);
    expect(market.tier).toBe(tier300);
    expect(market.stage).toBe('curve');
    expect(market.creator.equals(creator)).toBe(true);
  });

  it('says a mint was not launched here when no config has a pool for it', async () => {
    await expect(loadMarket(client(Keypair.generate().publicKey) as never, baseMint, allowed)).rejects.toMatchObject({ code: 'NOT_LISTED' });
    await expect(loadMarket(client(usdcPool) as never, baseMint, new Map())).rejects.toMatchObject({ code: 'NOT_LISTED' });
  });

  it('refuses a pool whose config is priced in something other than the pair it is listed under', () => {
    const input = { mint: baseMint, pool: usdcPool, state: state as never, config: config as never, tier: tier300 };
    expect(marketFromAccounts({ ...input, pair: USDC }).pair).toBe(USDC);
    let caught: unknown;
    try {
      marketFromAccounts({ ...input, pair: SOL_PAIR });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MarketError);
    expect((caught as MarketError).code).toBe('WRONG_QUOTE');
    expect(() => marketFromAccounts({ ...input, pair: ZEC })).toThrow(/not priced in ZEC/);
  });

  it('prices a token in its pair token, with that token’s decimals', () => {
    const market: Market = marketFromAccounts({ mint: baseMint, pool: usdcPool, state: state as never, config: config as never, tier: tier300, pair: USDC });
    const stats = curveStats(market);
    // At the start price, the market cap is the curve's starting size, in USDC.
    expect(Number(stats.marketCap)).toBeCloseTo(2500, 0);
    expect(Number(stats.price)).toBeCloseTo(2500 / 1e9, 12);
    expect(stats.quoteReserve).toBe('1000000');
    expect(stats.migrationThreshold).toBe(built.migrationQuoteThreshold.toString());
    // Read with SOL's decimals the same pool would look a thousand times smaller.
    const wrong = curveStats({ ...market, pair: { ...USDC, decimals: 9 } });
    expect(Number(wrong.marketCap)).toBeCloseTo(2.5, 3);
  });
});

describe('paying a creator in the pair token', () => {
  const creator = Keypair.generate().publicKey;

  it('is a plain SOL transfer for a SOL pool', () => {
    const [transfer, ...rest] = payoutInstructions({ pair: SOL_PAIR, creator }, partner, 5_000_000n);
    expect(rest).toEqual([]);
    expect(transfer?.programId.equals(SystemProgram.programId)).toBe(true);
    expect(transfer?.keys.map((key) => key.pubkey.toBase58())).toEqual([partner.toBase58(), creator.toBase58()]);
  });

  it('opens the creator’s token account if needed, then moves exactly that pair token', () => {
    const mint = new PublicKey(USDC.mint);
    const from = getAssociatedTokenAddressSync(mint, partner);
    const to = getAssociatedTokenAddressSync(mint, creator);
    const [open, transfer, ...rest] = payoutInstructions({ pair: USDC, creator }, partner, 1_250_000n);
    expect(rest).toEqual([]);
    expect(open?.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
    // Idempotent: an account that already exists is not an error.
    expect(open?.data[0]).toBe(1);
    expect(open?.keys.slice(0, 4).map((key) => key.pubkey.toBase58())).toEqual([partner.toBase58(), to.toBase58(), creator.toBase58(), mint.toBase58()]);
    expect(transfer?.programId.equals(TOKEN_PROGRAM_ID)).toBe(true);
    expect(transfer?.keys.map((key) => key.pubkey.toBase58())).toEqual([from.toBase58(), mint.toBase58(), to.toBase58(), partner.toBase58()]);
    // transferChecked: tag 12, the amount, then the mint's decimals.
    expect(transfer?.data[0]).toBe(12);
    expect(transfer?.data.readBigUInt64LE(1)).toBe(1_250_000n);
    expect(transfer?.data[9]).toBe(6);
  });

  it('pays a creator that is a program\u2019s address too, as a SOL payout would', () => {
    // An address off the curve: no private key exists for it, so only a program can sign for it.
    const [vault] = PublicKey.findProgramAddressSync([Buffer.from('vault')], SystemProgram.programId);
    expect(PublicKey.isOnCurve(vault.toBytes())).toBe(false);
    const mint = new PublicKey(USDC.mint);
    const to = getAssociatedTokenAddressSync(mint, vault, true);
    const [open, transfer] = payoutInstructions({ pair: USDC, creator: vault }, partner, 1n);
    expect(open?.keys[1]?.pubkey.toBase58()).toBe(to.toBase58());
    expect(open?.keys[2]?.pubkey.toBase58()).toBe(vault.toBase58());
    expect(transfer?.keys[2]?.pubkey.toBase58()).toBe(to.toBase58());
  });
});

describe('an instruction handed to the operator scripts', () => {
  it('keeps its program, its accounts, their roles and its data', () => {
    const keys = [
      { pubkey: Keypair.generate().publicKey, isSigner: true, isWritable: true },
      { pubkey: Keypair.generate().publicKey, isSigner: true, isWritable: false },
      { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true },
      { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: false },
    ];
    const original = new TransactionInstruction({ programId: Keypair.generate().publicKey, keys, data: Buffer.from([1, 2, 3, 250]) });
    const fields = legacyInstructionFields(fromLegacyInstruction(original));
    expect(fields.programId).toBe(original.programId.toBase58());
    expect(fields.keys).toEqual(keys.map((key) => ({ pubkey: key.pubkey.toBase58(), isSigner: key.isSigner, isWritable: key.isWritable })));
    expect([...fields.data]).toEqual([1, 2, 3, 250]);
  });
});

describe('the listing, with more than one pair in it', () => {
  let directory: string;
  let store: Store;
  const base = { pool: 'p', fee_bps: 300, creator: 'c', name: 'N', uri: '', stage: 'curve', progress: 0.5, threshold_lamports: '1' };

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'pcf-pairs-'));
    store = new Store(directory);
    // A SOL token of 60 SOL cap, and a USDC token of 4,000 USDC cap, which at 83⅓ USDC per SOL is 48 SOL.
    // In fees since launch: 0.09 SOL for the one, and 15 USDC for the other, which is 0.18 SOL.
    store.upsertToken({ ...base, mint: 'sol-token', config: 'A', symbol: 'SOLT', price_sol: '0.00000006', market_cap_sol: '60', reserve_lamports: '3000000000', fee_lamports: '90000000' }, 2_000);
    store.upsertToken(
      { ...base, mint: 'usdc-token', config: 'B', symbol: 'USDT', pair: 'USDC', price_sol: '0.000004', market_cap_sol: '4000', reserve_lamports: '250000000', fee_lamports: '15000000', cap_sol: 48, reserve_sol: 3, fee_sol: 0.18 },
      1_000,
    );
    store.setVolume('sol-token', '1000000000');
    store.setVolume('usdc-token', '500000000', 6);
  });

  afterAll(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('keeps each token’s own figures in its pair token', () => {
    const usdc = store.token('usdc-token');
    expect(usdc).toMatchObject({ pair: 'USDC', market_cap_sol: '4000', reserve_lamports: '250000000', volume_24h_lamports: '500000000', cap_sol: 48, volume_sol: 6 });
    // A SOL token needs nothing said: its SOL terms are its figures.
    expect(store.token('sol-token')).toMatchObject({ pair: 'SOL', cap_sol: 60, reserve_sol: 3, fee_sol: 0.09, volume_sol: 1 });
  });

  it('orders by size and by volume in SOL terms, not by the raw numbers', () => {
    const order = (sort: 'cap' | 'volume' | 'hot') => store.tokenPage({ page: 1, size: 12, sort }).rows.map((row) => row.mint);
    // 4,000 is more than 60, but 4,000 USDC is 48 SOL.
    expect(order('cap')).toEqual(['sol-token', 'usdc-token']);
    // Since launch: 15 USDC of fees at 3% is 500 USDC traded, which is 6 SOL. The SOL token's 0.09 SOL of fees is
    // 3 SOL traded. So the USDC token comes first, though 15,000,000 is the smaller raw number and it is the older token.
    expect(order('volume')).toEqual(['usdc-token', 'sol-token']);
    // In the last day: 500 USDC of volume is 6 SOL, which is more than 1 SOL.
    expect(order('hot')).toEqual(['usdc-token', 'sol-token']);
  });

  it('narrows to one pair when asked, and to nothing for a pair with no tokens', () => {
    const summary = (row: { mint: string }) => ({ mint: row.mint }) as never;
    expect(tokenPage(store, readPageRequest({ pair: 'usdc' }), summary).tokens).toEqual([{ mint: 'usdc-token' }]);
    expect(tokenPage(store, readPageRequest({ pair: 'SOL' }), summary).total).toBe(1);
    expect(tokenPage(store, readPageRequest({ pair: 'ZEC' }), summary)).toMatchObject({ tokens: [], total: 0, page: 1, pages: 1 });
    expect(tokenPage(store, readPageRequest({}), summary).total).toBe(2);
  });

  it('takes only a pair it knows as a filter', () => {
    expect(readPageRequest({ pair: 'hsol' }).pair).toBe('HSOL');
    expect(readPageRequest({ pair: 'DOGE' }).pair).toBe('');
    expect(readPageRequest({ pair: ['USDC'] }).pair).toBe('');
    expect(readPageRequest({ pair: "USDC' OR 1=1" }).pair).toBe('');
  });

  it('adds the front page up in SOL terms: SOL exactly, another pair at its rate', () => {
    expect(store.totals()).toEqual({
      tokens: 2,
      graduated: 0,
      reserveLamports: '6000000000', // 3 SOL, and 250 USDC counted as 3 SOL
      volumeLamports: '9000000000', // since launch: 3 SOL, and 500 USDC counted as 6 SOL
      volume24hLamports: '7000000000', // 1 SOL, and 500 USDC counted as 6 SOL
      feeLamports: '270000000',
    });
  });
});

describe('a database from the build before pairs', () => {
  it('gains the pair columns, with every token it holds priced in SOL', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pcf-migrate-'));
    try {
      // The tokens table exactly as the previous build created it.
      const old = new DatabaseSync(join(directory, 'privacycash.sqlite'));
      old.exec(`CREATE TABLE tokens (
        mint TEXT PRIMARY KEY, pool TEXT NOT NULL, config TEXT NOT NULL, fee_bps INTEGER NOT NULL, creator TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '', symbol TEXT NOT NULL DEFAULT '', uri TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
        image TEXT NOT NULL DEFAULT '', website TEXT NOT NULL DEFAULT '', twitter TEXT NOT NULL DEFAULT '', stage TEXT NOT NULL DEFAULT 'curve',
        price_sol TEXT NOT NULL DEFAULT '0', market_cap_sol TEXT NOT NULL DEFAULT '0', progress REAL NOT NULL DEFAULT 0,
        reserve_lamports TEXT NOT NULL DEFAULT '0', threshold_lamports TEXT NOT NULL DEFAULT '0', fee_lamports TEXT NOT NULL DEFAULT '0',
        volume_24h_lamports TEXT NOT NULL DEFAULT '0', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, supply TEXT NOT NULL DEFAULT '')`);
      old.prepare(
        `INSERT INTO tokens (mint, pool, config, fee_bps, creator, symbol, market_cap_sol, reserve_lamports, fee_lamports, volume_24h_lamports, created_at, updated_at)
         VALUES ('prv', 'p', 'A', 300, 'c', 'PRV', '41.5', '12500000000', '380000000', '2400000000', 1, 1)`,
      ).run();
      old.close();

      const store = new Store(directory);
      expect(store.token('prv')).toMatchObject({ pair: 'SOL', symbol: 'PRV', market_cap_sol: '41.5', cap_sol: 41.5, reserve_sol: 12.5, fee_sol: 0.38, volume_sol: 2.4 });
      // The volume since launch needs no column of its own: it is the fees the old build already kept, over the fee rate.
      expect(store.totals()).toMatchObject({ tokens: 1, reserveLamports: '12500000000', volumeLamports: '12666666666', volume24hLamports: '2400000000', feeLamports: '380000000' });
      store.close();
      // Opening it a second time changes nothing and loses nothing.
      const again = new Store(directory);
      expect(again.token('prv')?.cap_sol).toBe(41.5);
      again.close();
      // And the previous build can still read and write the table: it names its columns, and the new ones have defaults.
      const back = new DatabaseSync(join(directory, 'privacycash.sqlite'));
      back.prepare("INSERT INTO tokens (mint, pool, config, fee_bps, creator, created_at, updated_at) VALUES ('later', 'p', 'A', 300, 'c', 2, 2)").run();
      expect(back.prepare("SELECT pair, cap_sol FROM tokens WHERE mint = 'later'").get()).toEqual({ pair: 'SOL', cap_sol: 0 });
      back.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('amounts of a pair token in the pages', () => {
  const status = statusFixture({ limits: { maxTradeLamports: '500000000', launchesPaused: false, tradingPaused: false, notice: null } });
  const usdc = pairOf(status, 'USDC') as NonNullable<ReturnType<typeof pairOf>>;

  it('are written with the token’s own decimals and ticker, cut off and never rounded up', () => {
    expect(amount(1_234_567_890n, usdc, 2)).toBe('1,234.56');
    expect(amount(1_999_999n, usdc, 4)).toBe('1.9999');
    expect(withUnit(41_666_666n, usdc, 6)).toBe('41.666666 USDC');
    // Never more places than the token has.
    expect(withUnit(1n, usdc, 9)).toBe('0.000001 USDC');
    expect(withUnit(1_500_000_000n, SOL_REF, 4)).toBe('1.5 SOL');
    expect(compact(12_345_000_000n, usdc)).toBe('12.35K USDC');
    expect(plain(1_500_000n, usdc)).toBe('1.5');
    expect(isSol(SOL_REF)).toBe(true);
    expect(isSol(usdc)).toBe(false);
  });

  it('hold a trade to the operator’s limit at the pair’s rate', () => {
    expect(tradeCap(status, SOL_REF)).toBe(500_000_000n);
    expect(tradeCap(status, usdc)).toBe(41_666_666n);
    expect(tradeCap(statusFixture(), usdc)).toBe(0n);
    expect(tradeCap(null, usdc)).toBe(0n);
    // A pair the site does not describe cannot be measured against the limit, so nothing passes.
    expect(tradeCap(status, { id: 'DOGE', symbol: 'DOGE', mint: partner.toBase58(), decimals: 8 })).toBe(1n);
    expect(inPairUnits(status, usdc, 1_000_000n)).toBe(83_333n);
    expect(inPairUnits(status, SOL_REF, 1_000_000n)).toBe(1_000_000n);
    expect(inPairUnits(status, { id: 'DOGE', symbol: 'DOGE', mint: partner.toBase58(), decimals: 8 }, 1_000_000n)).toBe(0n);
  });

  it('offer round quick amounts in the pair token', () => {
    expect(quickAmounts(status, SOL_REF)).toEqual(['0.1', '0.5', '1']);
    expect(quickAmounts(status, usdc)).toEqual(['8', '40', '80']);
    expect(quickAmounts(status, usdc, [0.1, 0.5, 1, 2])).toEqual(['8', '40', '80', '200']);
    // A rate below one gives small amounts, written without an exponent.
    const zec = { ...usdc, id: 'ZEC', symbol: 'ZEC', decimals: 8, unitsPerSol: 0.0003 };
    expect(quickAmounts({ ...status, pairs: [zec] }, zec)).toEqual(['0.00003', '0.0001', '0.0003']);
    expect(quickAmounts(status, { id: 'DOGE', symbol: 'DOGE', mint: partner.toBase58(), decimals: 8 })).toEqual([]);
  });

  it('build the same config in the browser as the server checks against', () => {
    const quote = curveQuoteOf(usdc);
    expect(quote).toEqual({ pair: USDC, size: USDC_SIZE });
    expect(JSON.stringify(buildTierConfig(tier300, status.economics, quote))).toBe(JSON.stringify(buildTierConfig(tier300, DEFAULT_ECONOMICS, usdcQuote)));
    expect(() => curveQuoteOf(pairOf(status, 'ZEC') as never)).toThrow(/not set up/);
  });

  it('are listed for the docs, live or not', () => {
    const table = pairsTable(status);
    expect(table.split('\n')).toHaveLength(2 + PAIR_TOKENS.length);
    expect(table).toMatch(/\| \*\*SOL\*\* \| Solana \| 30 → 420 SOL of market cap \| ==Live== \|/);
    expect(table).toMatch(/\| \*\*USDC\*\* \| USD Coin \| 2,500 → 35,000 USDC of market cap \| ==Live== \|/);
    expect(table).toMatch(/\| \*\*hSOL\*\* \| Helius Staked SOL \| Not set \| Not set up \|/);
    // Before the server has answered, the list itself is still shown.
    expect(pairsTable(null).split('\n')).toHaveLength(2 + PAIR_TOKENS.length);
  });
});
