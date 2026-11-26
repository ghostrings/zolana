/**
 * Changing the fee split: the configs a platform already has are kept for the
 * tokens launched on them, next to a new set for new launches. These tests
 * hold what a kept config must still be, how the settings name them, and what
 * an operator script says about the pairs it cannot see.
 */
import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';

import { buildTierConfig, configMismatches, economicsOfAccount, previousConfigMismatches } from '../shared/src/curve.js';
import { allowedConfigMap, creatorFeeSharePctOf } from '../shared/src/meteora.js';
import { SOL_PAIR } from '../shared/src/quotes.js';
import { DEFAULT_ECONOMICS, FEE_TIERS, type FeeTier, feeSplit, tierById } from '../shared/src/tiers.js';
import { readEnv } from '../server/src/env.js';
import { compareWithLive, coverageLines, curveSizeClashes, liveDifferenceLines, livePairIds, parseLiveSettings, retiredEnvText } from '../ops/lib.js';
import { ADDRESSES, USDC, ZEC, configAccountFrom, pairedEnv } from './fixtures.js';

const tier = tierById('tier-300') as FeeTier;
const partner = Keypair.generate().publicKey;
const solQuote = { pair: SOL_PAIR, size: { initialMarketCap: 30, migrationMarketCap: 420 } };
const before = { ...DEFAULT_ECONOMICS, creatorFeeSharePct: 30 };
const after = { ...DEFAULT_ECONOMICS, creatorFeeSharePct: 80 };

/** A config as the chain holds it, created when the creator's share was 30. */
const oldAccount = (): Record<string, unknown> => configAccountFrom(buildTierConfig(tier, before, solQuote), partner, SOL_PAIR.mint);

describe('the split a number stands for', () => {
  it('is the creator\'s share of what is left after Meteora\'s 20%', () => {
    expect(feeSplit({ creatorFeeSharePct: 30 })).toMatchObject({ creatorPct: 24, platformPct: 56, protocolPct: 20 });
    expect(feeSplit({ creatorFeeSharePct: 80 })).toMatchObject({ creatorPct: 64, platformPct: 16, protocolPct: 20 });
  });

  it('is read for each token from its own config, not from what new launches get', () => {
    expect(creatorFeeSharePctOf({ config: oldAccount() as never })).toBe(30);
    expect(creatorFeeSharePctOf({ config: configAccountFrom(buildTierConfig(tier, after, solQuote), partner, SOL_PAIR.mint) as never })).toBe(80);
  });
});

describe('a config kept from an earlier set', () => {
  it('no longer matches the settings new launches use, which is why it takes none', () => {
    const problems = configMismatches(tier, buildTierConfig(tier, after, solQuote), oldAccount(), partner);
    expect(problems.some((problem) => problem.startsWith('creatorTradingFeePercentage'))).toBe(true);
  });

  it('is still accepted as one of the platform\'s own', () => {
    expect(previousConfigMismatches(tier, after, solQuote, oldAccount(), partner)).toEqual([]);
    expect(economicsOfAccount(oldAccount(), after).creatorFeeSharePct).toBe(30);
  });

  it('is accepted whatever its curve was sized to, and for every tier', () => {
    const resized = { pair: SOL_PAIR, size: { initialMarketCap: 10, migrationMarketCap: 100 } };
    for (const each of FEE_TIERS) {
      const account = configAccountFrom(buildTierConfig(each, before, resized), partner, SOL_PAIR.mint);
      expect(previousConfigMismatches(each, after, solQuote, account, partner), each.id).toEqual([]);
    }
  });

  it('is accepted for another pair token, against that pair', () => {
    const usdcQuote = { pair: USDC, size: { initialMarketCap: 2500, migrationMarketCap: 35_000 } };
    const account = configAccountFrom(buildTierConfig(tier, before, usdcQuote), partner, USDC.mint);
    expect(previousConfigMismatches(tier, after, usdcQuote, account, partner)).toEqual([]);
    // The same account held against the wrong pair is refused: a config is priced in exactly one token.
    const zecQuote = { pair: ZEC, size: { initialMarketCap: 2.69, migrationMarketCap: 37.7 } };
    expect(previousConfigMismatches(tier, after, zecQuote, account, partner).some((problem) => problem.startsWith('quoteMint'))).toBe(true);
  });

  it('is refused when its fees go to somebody else', () => {
    const stranger = Keypair.generate().publicKey;
    const account = configAccountFrom(buildTierConfig(tier, before, solQuote), stranger, SOL_PAIR.mint);
    const problems = previousConfigMismatches(tier, after, solQuote, account, partner);
    expect(problems.some((problem) => problem.startsWith('feeClaimer'))).toBe(true);
  });

  it('is refused when it charges another fee than its tier, or lets the fee change', () => {
    const cheap = tierById('tier-200') as FeeTier;
    expect(previousConfigMismatches(cheap, after, solQuote, oldAccount(), partner).length).toBeGreaterThan(0);
    const dynamic = oldAccount();
    (dynamic.poolFees as { dynamicFee: { initialized: number } }).dynamicFee.initialized = 1;
    expect(previousConfigMismatches(tier, after, solQuote, dynamic, partner).join(' ')).toMatch(/dynamic/i);
    const drifting = oldAccount();
    drifting.migratedPoolFeeBps = 100;
    expect(previousConfigMismatches(tier, after, solQuote, drifting, partner).length).toBeGreaterThan(0);
  });

  it('is refused when the liquidity it graduates is not all locked with the platform', () => {
    const account = oldAccount();
    account.partnerPermanentLockedLiquidityPercentage = 50;
    account.creatorPermanentLockedLiquidityPercentage = 50;
    const problems = previousConfigMismatches(tier, after, solQuote, account, partner);
    expect(problems.some((problem) => problem.startsWith('partnerPermanentLockedLiquidityPercentage'))).toBe(true);
  });

  it('is refused, not crashed on, when its own numbers make no sense', () => {
    const account = oldAccount();
    account.creatorTradingFeePercentage = 250;
    expect(previousConfigMismatches(tier, after, solQuote, account, partner)).toHaveLength(1);
  });
});

describe('the map of configs tokens are found under', () => {
  it('marks kept configs, and only those', () => {
    const map = allowedConfigMap([
      { address: ADDRESSES[0], feeBps: 300, pair: SOL_PAIR },
      { address: ADDRESSES[1], feeBps: 300, pair: SOL_PAIR, previous: true },
      { address: undefined, feeBps: 200, pair: SOL_PAIR },
    ]);
    expect(map.size).toBe(2);
    expect(map.get(ADDRESSES[0])?.previous).toBeUndefined();
    expect(map.get(ADDRESSES[1])).toMatchObject({ previous: true, tier: { feeBps: 300 } });
  });

  it('refuses one address listed twice, kept or not', () => {
    expect(() =>
      allowedConfigMap([
        { address: ADDRESSES[0], feeBps: 300, pair: SOL_PAIR },
        { address: ADDRESSES[0], feeBps: 300, pair: SOL_PAIR, previous: true },
      ]),
    ).toThrow(/more than one/);
  });
});

describe('DBC_CONFIGS_PREVIOUS', () => {
  it('is empty unless set', () => {
    expect(readEnv({}).previousConfigs).toEqual([]);
  });

  it('takes addresses separated by commas, spaces or new lines, once each', () => {
    const env = readEnv({ DBC_CONFIGS_PREVIOUS: `${ADDRESSES[3]}, ${ADDRESSES[4]}\n${ADDRESSES[5]} ${ADDRESSES[3]}` });
    expect(env.previousConfigs).toEqual([ADDRESSES[3], ADDRESSES[4], ADDRESSES[5]]);
  });

  it('refuses anything that is not an address', () => {
    expect(() => readEnv({ DBC_CONFIGS_PREVIOUS: 'tier-300' })).toThrow(/DBC_CONFIGS_PREVIOUS/);
  });

  it('refuses an address that is also a config new launches use', () => {
    expect(() => readEnv({ DBC_CONFIG_300: ADDRESSES[1], DBC_CONFIGS_PREVIOUS: ADDRESSES[1] })).toThrow(/DBC_CONFIG_300 and DBC_CONFIGS_PREVIOUS both hold/);
    expect(() => pairedEnv({ DBC_CONFIGS_PREVIOUS: ADDRESSES[3] })).toThrow(/DBC_CONFIG_300_USDC and DBC_CONFIGS_PREVIOUS both hold/);
  });
});

describe('what creators are paid after graduation', () => {
  it('follows the curve share when it is not set, and says that it was not', () => {
    const env = readEnv({ CREATOR_FEE_SHARE_PCT: '80' });
    expect(env.creatorPoolPayoutPct).toBe(80);
    expect(env.creatorPoolPayoutExplicit).toBe(false);
  });

  it('is its own number once set', () => {
    const env = readEnv({ CREATOR_FEE_SHARE_PCT: '80', CREATOR_POOL_PAYOUT_PCT: '30' });
    expect(env.economics.creatorFeeSharePct).toBe(80);
    expect(env.creatorPoolPayoutPct).toBe(30);
    expect(env.creatorPoolPayoutExplicit).toBe(true);
  });
});

describe('what an operator script says it is looking at', () => {
  const env = pairedEnv();
  const usdcPair = USDC;

  it('names the pairs it has configs for, and how many were kept from before', () => {
    const configs = allowedConfigMap([
      { address: ADDRESSES[0], feeBps: 200, pair: SOL_PAIR },
      { address: ADDRESSES[1], feeBps: 300, pair: SOL_PAIR },
      { address: ADDRESSES[2], feeBps: 300, pair: SOL_PAIR, previous: true },
      { address: ADDRESSES[3], feeBps: 300, pair: usdcPair },
    ]);
    const [first] = coverageLines(env, configs, new Set(['SOL', 'USDC']));
    expect(first).toBe('Looking at: SOL (3 configs, 1 kept from before), USDC (1 config).');
    expect(coverageLines(env, configs, new Set(['SOL', 'USDC']))).toHaveLength(1);
  });

  it('warns, by name, about a pair the live site has and this computer does not', () => {
    const configs = allowedConfigMap([{ address: ADDRESSES[0], feeBps: 300, pair: SOL_PAIR }]);
    const lines = coverageLines(env, configs, new Set(['SOL', 'ZEC', 'USDC']));
    expect(lines[1]).toMatch(/^NOT looking at: USDC, ZEC\. This \.env has no CURVE_\* and DBC_CONFIG_\* lines for them/);
    expect(lines[2]).toMatch(/has them switched on\. Add the lines for them to this \.env/);
  });

  it('warns about every pair it cannot see when the live site did not answer', () => {
    const configs = allowedConfigMap([{ address: ADDRESSES[0], feeBps: 300, pair: SOL_PAIR }]);
    const lines = coverageLines(env, configs, null);
    expect(lines[1]).toMatch(/^NOT looking at: USDC, ZEC, NEAR, XMR, ANT, RENDER, hSOL\./);
    expect(lines[2]).toMatch(/^If the live site has them switched on/);
  });

  it('says so when there is nothing to look at', () => {
    expect(coverageLines(env, new Map(), new Set())[0]).toMatch(/No config is set/);
  });

  it('counts a pair by the id its config is priced in', () => {
    const configs = allowedConfigMap([{ address: new PublicKey(ADDRESSES[4]).toBase58(), feeBps: 400, pair: ZEC, previous: true }]);
    expect(coverageLines(env, configs, new Set(['ZEC']))[0]).toBe('Looking at: ZEC (1 config, 1 kept from before).');
  });
});

describe('comparing this computer with the live site', () => {
  const fresh = (): string => Keypair.generate().publicKey.toBase58();
  const zec = [fresh(), fresh(), fresh()] as const;
  const tiers = (addresses: readonly (string | null)[]) => [200, 300, 400].map((feeBps, index) => ({ id: `tier-${feeBps}`, feeBps, label: `${feeBps / 100}%`, config: addresses[index] ?? null, live: addresses[index] != null, problem: null }));
  /** What `/api/status` answers on a site with SOL and ZEC in use, ANT known and not set up. */
  const body = (extra: Record<string, unknown> = {}) => ({
    network: 'mainnet',
    pairs: [
      { id: 'SOL', symbol: 'SOL', native: true, live: true, curve: { initialMarketCap: 30, migrationMarketCap: 420 }, tiers: tiers([ADDRESSES[0], ADDRESSES[1], ADDRESSES[2]]) },
      { id: 'ZEC', symbol: 'ZEC', native: false, live: true, curve: { initialMarketCap: 2.69, migrationMarketCap: 37.7 }, tiers: tiers(zec) },
      { id: 'ANT', symbol: 'ANT', native: false, live: false, curve: null, tiers: tiers([null, null, null]) },
    ],
    ...extra,
  });
  const site = (extra: Record<string, unknown> = {}) => {
    const parsed = parseLiveSettings('https://example.org', body(extra));
    if (!parsed) throw new Error('not parsed');
    return parsed;
  };
  const solOnly = { DBC_CONFIG_200: ADDRESSES[0], DBC_CONFIG_300: ADDRESSES[1], DBC_CONFIG_400: ADDRESSES[2] };
  const zecLines = ['CURVE_INITIAL_MARKET_CAP_ZEC=2.69', 'CURVE_MIGRATION_MARKET_CAP_ZEC=37.7', `DBC_CONFIG_200_ZEC=${zec[0]}`, `DBC_CONFIG_300_ZEC=${zec[1]}`, `DBC_CONFIG_400_ZEC=${zec[2]}`];
  const asEnv = (lines: readonly string[]): Record<string, string> => Object.fromEntries(lines.map((line) => line.split('=') as [string, string]));

  it('reads the pairs, their curve sizes and their config addresses from the status', () => {
    const live = site();
    expect(live.origin).toBe('https://example.org');
    expect(live.pairs.map((pair) => [pair.id, pair.curve?.initialMarketCap ?? null, pair.configs.length])).toEqual([['SOL', 30, 3], ['ZEC', 2.69, 3], ['ANT', null, 0]]);
    expect(live.pairs[1]?.configs).toEqual([{ feeBps: 200, address: zec[0] }, { feeBps: 300, address: zec[1] }, { feeBps: 400, address: zec[2] }]);
    expect(live.previous).toEqual([]);
    expect([...(livePairIds(live) ?? [])]).toEqual(['SOL', 'ZEC']);
    expect(livePairIds(null)).toBeNull();
  });

  it('leaves out whatever is not what a site of this project sends', () => {
    expect(parseLiveSettings('o', null)).toBeNull();
    expect(parseLiveSettings('o', { pairs: 'no' })).toBeNull();
    const live = parseLiveSettings('o', {
      pairs: [
        null,
        { id: 7 },
        { id: 'zec; rm -rf', curve: null, tiers: [] },
        { id: 'ZEC', curve: { initialMarketCap: '2.69', migrationMarketCap: 37.7 }, tiers: [{ feeBps: 300, config: 'not an address' }, { feeBps: 250, config: zec[0] }, { feeBps: 400, config: zec[2] }, null] },
      ],
      previousConfigs: [{ address: zec[1], pairId: 'ZEC', feeBps: 300 }, { address: 'nope', pairId: 'ZEC' }, 5],
    });
    expect(live?.pairs).toEqual([{ id: 'ZEC', curve: null, configs: [{ feeBps: 400, address: zec[2] }] }]);
    expect(live?.previous).toEqual([{ address: zec[1], pairId: 'ZEC' }]);
  });

  it('writes out, whole, the lines of a pair the live site uses and this computer has never heard of', () => {
    const env = readEnv(solOnly);
    expect(compareWithLive(env, site())).toEqual({ add: zecLines, differs: [] });
    const lines = liveDifferenceLines(env, site());
    expect(lines[0]).toBe('  https://example.org uses 5 settings that the .env on this computer does not have.');
    // The settings themselves start in the first column, so a selection of them pastes into .env as it is.
    expect(lines.filter((line) => /^[A-Z0-9_]+=\S+$/.test(line))).toEqual(zecLines);
    // And with those lines in place there is nothing left to say.
    const complete = readEnv({ ...solOnly, ...asEnv(zecLines) });
    expect(compareWithLive(complete, site())).toEqual({ add: [], differs: [] });
    expect(liveDifferenceLines(complete, site())).toEqual([]);
    expect(liveDifferenceLines(env, null)).toEqual([]);
  });

  it('asks only for the one config line that is missing when the pair is otherwise here', () => {
    const env = readEnv({ ...solOnly, ...asEnv(zecLines.filter((line) => !line.startsWith('DBC_CONFIG_400_ZEC'))) });
    expect(compareWithLive(env, site())).toEqual({ add: [`DBC_CONFIG_400_ZEC=${zec[2]}`], differs: [] });
  });

  it('says so when a curve is sized differently here, for SOL as for any other pair', () => {
    const env = readEnv({ ...solOnly, ...asEnv(zecLines), CURVE_INITIAL_MARKET_CAP_SOL: '28', CURVE_MIGRATION_MARKET_CAP_ZEC: '40' });
    const { add, differs } = compareWithLive(env, site());
    expect(add).toEqual([]);
    expect(differs).toHaveLength(2);
    expect(differs[0]).toMatch(/^CURVE_INITIAL_MARKET_CAP_SOL \/ CURVE_MIGRATION_MARKET_CAP_SOL are 28 \/ 420 here and 30 \/ 420 on the live site/);
    expect(differs[1]).toMatch(/^CURVE_INITIAL_MARKET_CAP_ZEC \/ CURVE_MIGRATION_MARKET_CAP_ZEC are 2\.69 \/ 40 here and 2\.69 \/ 37\.7 on the live site/);
    expect(curveSizeClashes(env, site(), ['SOL', 'ZEC', 'ANT', 'USDC'])).toHaveLength(2);
    expect(curveSizeClashes(env, site(), ['ZEC'])[0]).toMatch(/^ZEC: .* are 2\.69 \/ 40 here and 2\.69 \/ 37\.7 on https:\/\/example\.org\.$/);
    expect(curveSizeClashes(readEnv({ ...solOnly, ...asEnv(zecLines) }), site(), ['SOL', 'ZEC'])).toEqual([]);
  });

  it('says so when a tier points at another config here than on the live site', () => {
    const other = fresh();
    const env = readEnv({ ...solOnly, ...asEnv(zecLines), DBC_CONFIG_300_ZEC: other });
    const { add, differs } = compareWithLive(env, site());
    expect(add).toEqual([]);
    expect(differs).toEqual([`DBC_CONFIG_300_ZEC is ${other} here. The live site uses ${zec[1]}, which this .env neither uses nor keeps.`]);
  });

  it('has nothing to say in the middle of a change of split, where this computer is a step ahead', () => {
    // Here the old set is already kept and the new one created; the live site still launches on the old one.
    const created = [fresh(), fresh(), fresh(), fresh(), fresh(), fresh()];
    const env = readEnv({
      DBC_CONFIG_200: created[0] as string,
      DBC_CONFIG_300: created[1] as string,
      DBC_CONFIG_400: created[2] as string,
      CURVE_INITIAL_MARKET_CAP_ZEC: '2.69',
      CURVE_MIGRATION_MARKET_CAP_ZEC: '37.7',
      DBC_CONFIG_200_ZEC: created[3] as string,
      DBC_CONFIG_300_ZEC: created[4] as string,
      DBC_CONFIG_400_ZEC: created[5] as string,
      DBC_CONFIGS_PREVIOUS: [ADDRESSES[0], ADDRESSES[1], ADDRESSES[2], ...zec].join(','),
      CREATOR_FEE_SHARE_PCT: '80',
      CREATOR_POOL_PAYOUT_PCT: '30',
    });
    expect(compareWithLive(env, site())).toEqual({ add: [], differs: [] });
    // Just before that, with the old lines turned into comments and nothing created yet: the same.
    const retired = readEnv({ CURVE_INITIAL_MARKET_CAP_ZEC: '2.69', CURVE_MIGRATION_MARKET_CAP_ZEC: '37.7', DBC_CONFIGS_PREVIOUS: [ADDRESSES[0], ADDRESSES[1], ADDRESSES[2], ...zec].join(',') });
    expect(compareWithLive(retired, site())).toEqual({ add: [], differs: [] });
  });

  it('names the configs the live site keeps from before and this computer does not', () => {
    const old = [fresh(), fresh()];
    const live = site({ previousConfigs: [{ address: old[0], pairId: 'SOL', feeBps: 300, creatorFeeSharePct: 30 }, { address: old[1], pairId: 'NEAR', feeBps: 200, creatorFeeSharePct: 30 }] });
    const env = readEnv({ ...solOnly, ...asEnv(zecLines), DBC_CONFIGS_PREVIOUS: old[0] as string });
    expect(compareWithLive(env, live).differs).toEqual([`The live site keeps 1 config from an earlier set that this .env does not. DBC_CONFIGS_PREVIOUS here must hold it too: ${old[1]}`]);
    expect([...(livePairIds(live) ?? [])].sort()).toEqual(['NEAR', 'SOL', 'ZEC']);
  });
});

describe('retiring the configs in a .env', () => {
  const kept = [ADDRESSES[0], ADDRESSES[1], ADDRESSES[2], ADDRESSES[3]];
  const before = [
    '# my settings',
    'PORT=8080',
    `DBC_CONFIG_200=${ADDRESSES[0]}`,
    `DBC_CONFIG_300=${ADDRESSES[1]}`,
    `  DBC_CONFIG_400 = ${ADDRESSES[2]}`,
    'CURVE_INITIAL_MARKET_CAP_USDC=2500',
    'CURVE_MIGRATION_MARKET_CAP_USDC=35000',
    `DBC_CONFIG_300_USDC=${ADDRESSES[3]}`,
    'DBC_CONFIG_200_USDC=',
    '# DBC_CONFIG_400_USDC=',
    'CREATOR_FEE_SHARE_PCT=30',
    `DBC_CONFIGS_PREVIOUS=${ADDRESSES[4]}`,
    '',
    '',
  ];
  /** What Node makes of a .env: its `NAME=value` lines, comments and blanks left out. */
  const parse = (text: string): Record<string, string> =>
    Object.fromEntries(
      text
        .split(/\r?\n/)
        .filter((line) => line.trim() !== '' && !line.trim().startsWith('#'))
        .map((line) => [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()] as const),
    );

  it('turns every config line that holds an address into a comment, and nothing else', () => {
    const result = retiredEnvText(before.join('\n'), [...kept, ADDRESSES[4]]);
    expect(result.retired).toEqual(['DBC_CONFIG_200', 'DBC_CONFIG_300', 'DBC_CONFIG_400', 'DBC_CONFIG_300_USDC']);
    const lines = result.text.split('\n');
    expect(lines[2]).toBe(`# kept in DBC_CONFIGS_PREVIOUS: DBC_CONFIG_200=${ADDRESSES[0]}`);
    expect(lines[4]).toBe(`# kept in DBC_CONFIGS_PREVIOUS: DBC_CONFIG_400 = ${ADDRESSES[2]}`);
    // Untouched: the key, the curve sizes, the empty line, the commented line, the split.
    expect(lines.slice(0, 2)).toEqual(before.slice(0, 2));
    expect(lines).toContain('CURVE_INITIAL_MARKET_CAP_USDC=2500');
    expect(lines).toContain('DBC_CONFIG_200_USDC=');
    expect(lines).toContain('# DBC_CONFIG_400_USDC=');
    expect(lines).toContain('CREATOR_FEE_SHARE_PCT=30');
    // One line for the kept configs, at the end, in place of the old one.
    expect(lines.filter((line) => line.startsWith('DBC_CONFIGS_PREVIOUS='))).toEqual([`DBC_CONFIGS_PREVIOUS=${[...kept, ADDRESSES[4]].join(',')}`]);
    expect(lines[lines.length - 1]).toBe('');
    expect(lines[lines.length - 2]).toMatch(/^DBC_CONFIGS_PREVIOUS=/);
  });

  it('gives an environment the server accepts: no config in use, every old one kept', () => {
    const env = readEnv(parse(retiredEnvText(before.join('\n'), [...kept, ADDRESSES[4]]).text));
    expect(env.previousConfigs).toEqual([...kept, ADDRESSES[4]]);
    expect(env.pairs.every((pair) => FEE_TIERS.every((each) => pair.configs[each.feeBps] === undefined))).toBe(true);
    // The pair stays switched on by its size, ready for `configs:apply` to create its new configs.
    expect(env.pairs.find((pair) => pair.token.id === 'USDC')?.size).toEqual({ initialMarketCap: 2500, migrationMarketCap: 35_000 });
    // Before the edit the same file with the line added by hand would have been refused.
    expect(() => readEnv({ ...parse(before.join('\n')), DBC_CONFIGS_PREVIOUS: kept.join(',') })).toThrow(/both hold/);
  });

  it('sets the new split where the old one stood, and writes the payout down when the file did not state it', () => {
    const result = retiredEnvText(before.join('\n'), kept, { creatorFeeSharePct: 80, creatorPoolPayoutPct: 30 });
    const lines = result.text.split('\n');
    expect(lines.filter((line) => line.startsWith('CREATOR_FEE_SHARE_PCT='))).toEqual(['CREATOR_FEE_SHARE_PCT=80']);
    expect(lines.indexOf('CREATOR_FEE_SHARE_PCT=80')).toBe(before.indexOf('CREATOR_FEE_SHARE_PCT=30'));
    expect(lines.filter((line) => line.startsWith('CREATOR_POOL_PAYOUT_PCT='))).toEqual(['CREATOR_POOL_PAYOUT_PCT=30']);
    const env = readEnv(parse(result.text));
    expect(env.economics.creatorFeeSharePct).toBe(80);
    expect(env.creatorPoolPayoutPct).toBe(30);
    expect(env.creatorPoolPayoutExplicit).toBe(true);
  });

  it('leaves a payout the file already states exactly as it is', () => {
    const stated = [...before.slice(0, -2), 'CREATOR_POOL_PAYOUT_PCT=25', ''];
    const result = retiredEnvText(stated.join('\n'), kept, { creatorFeeSharePct: 80, creatorPoolPayoutPct: 30 });
    expect(result.text.split('\n').filter((line) => line.startsWith('CREATOR_POOL_PAYOUT_PCT='))).toEqual(['CREATOR_POOL_PAYOUT_PCT=25']);
    expect(readEnv(parse(result.text)).creatorPoolPayoutPct).toBe(25);
  });

  it('adds the split when the file never named it', () => {
    const result = retiredEnvText(`PORT=8080\nDBC_CONFIG_300=${ADDRESSES[1]}\n`, [ADDRESSES[1]], { creatorFeeSharePct: 80, creatorPoolPayoutPct: 30 });
    const env = readEnv(parse(result.text));
    expect(env.economics.creatorFeeSharePct).toBe(80);
    expect(env.creatorPoolPayoutPct).toBe(30);
    expect(env.previousConfigs).toEqual([ADDRESSES[1]]);
  });

  it('keeps Windows line endings', () => {
    const result = retiredEnvText(before.join('\r\n'), kept);
    expect(result.text.split('\r\n')).toHaveLength(result.text.split('\n').length);
    expect(result.text.includes('\r\n')).toBe(true);
    expect(result.text.replaceAll('\r\n', '').includes('\n')).toBe(false);
  });

  it('changes nothing but the last line when there is no config to retire', () => {
    const result = retiredEnvText('PORT=8080\n', kept);
    expect(result.retired).toEqual([]);
    expect(result.text.startsWith('PORT=8080\n')).toBe(true);
  });
});
