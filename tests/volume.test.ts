import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Store } from '../server/src/db.js';
import { lifetimeVolume } from '../server/src/listing.js';
import { unitsOf, volumeFromFees, volumeFromFeesNumber } from '../shared/src/volume.js';

const SOL = 1_000_000_000n;

describe('volume, worked out from fees', () => {
  it('is the fees over the fee rate, for each of the three tiers', () => {
    // 100 SOL traded leaves 2, 3 or 4 SOL of fees. Read the other way, those fees are 100 SOL traded.
    expect(volumeFromFees(2n * SOL, 200)).toBe(100n * SOL);
    expect(volumeFromFees(3n * SOL, 300)).toBe(100n * SOL);
    expect(volumeFromFees(4n * SOL, 400)).toBe(100n * SOL);
  });

  it('is cut off, never rounded up, so it cannot overstate', () => {
    expect(volumeFromFees(1n, 300)).toBe(33n);
    expect(volumeFromFees(2n, 300)).toBe(66n);
    expect(volumeFromFees(3n, 300)).toBe(100n);
    expect(volumeFromFees(380_000_000n, 300)).toBe(12_666_666_666n);
  });

  it('is nothing without fees', () => {
    expect(volumeFromFees(0n, 300)).toBe(0n);
    expect(volumeFromFees(-5n, 300)).toBe(0n);
  });

  it('is nothing, and never a guess, for a rate no token has', () => {
    for (const rate of [0, -300, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(volumeFromFees(3n * SOL, rate)).toBe(0n);
  });

  it('keeps every digit of a figure too large for an ordinary number', () => {
    // A hundred billion SOL of fees: far beyond what a double holds exactly.
    const fees = 100_000_000_000n * SOL + 7n;
    expect(volumeFromFees(fees, 400)).toBe((fees * 10_000n) / 400n);
    expect(volumeFromFees(fees, 400).toString()).toBe('2500000000000000000175');
  });

  it('does the same for fees counted in SOL terms', () => {
    expect(volumeFromFeesNumber(0.09, 300)).toBeCloseTo(3, 12);
    expect(volumeFromFeesNumber(0.18, 300)).toBeCloseTo(6, 12);
    expect(volumeFromFeesNumber(0, 300)).toBe(0);
    expect(volumeFromFeesNumber(-1, 300)).toBe(0);
    expect(volumeFromFeesNumber(Number.NaN, 300)).toBe(0);
    expect(volumeFromFeesNumber(1, 0)).toBe(0);
  });
});

describe('base units read from text', () => {
  it('are the whole number the text holds', () => {
    expect(unitsOf('0')).toBe(0n);
    expect(unitsOf('30000000')).toBe(30_000_000n);
    expect(unitsOf('123456789012345678901234567890')).toBe(123_456_789_012_345_678_901_234_567_890n);
  });

  it('are nothing for anything else', () => {
    for (const text of ['', ' ', '-5', '1.5', '1e9', '0x10', 'abc', '12 ', '１２']) expect(unitsOf(text)).toBe(0n);
    expect(unitsOf(null)).toBe(0n);
    expect(unitsOf(undefined)).toBe(0n);
  });
});

describe('what a token has traded since launch', () => {
  it('is its lifetime fees over its own fee rate, in its pair token', () => {
    expect(lifetimeVolume({ fee_lamports: '30000000', fee_bps: 300 })).toBe('1000000000');
    expect(lifetimeVolume({ fee_lamports: '30000000', fee_bps: 200 })).toBe('1500000000');
    expect(lifetimeVolume({ fee_lamports: '30000000', fee_bps: 400 })).toBe('750000000');
  });

  it('is nothing for a token that has not traded, or whose fees could not be read', () => {
    expect(lifetimeVolume({ fee_lamports: '0', fee_bps: 300 })).toBe('0');
    expect(lifetimeVolume({ fee_lamports: '', fee_bps: 300 })).toBe('0');
    expect(lifetimeVolume({ fee_lamports: 'not a number', fee_bps: 300 })).toBe('0');
  });
});

describe('the market, ordered by what was traded', () => {
  let directory: string;
  let store: Store;
  const base = { pool: 'p', config: 'A', creator: 'c', name: 'N', uri: '', stage: 'curve', price_sol: '0.00000003', market_cap_sol: '30', progress: 0.5, reserve_lamports: '1', threshold_lamports: '1' };
  const order = (sort: 'hot' | 'volume') => store.tokenPage({ page: 1, size: 24, sort }).rows.map((row) => row.mint);

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'pcf-volume-'));
    store = new Store(directory);
    // Three tiers. The 4% token has taken the most in fees and has traded the least:
    //   two:   1.9 SOL of fees at 2% is 95 SOL traded
    //   three: 3.0 SOL of fees at 3% is 100 SOL traded
    //   four:  3.2 SOL of fees at 4% is 80 SOL traded
    store.upsertToken({ ...base, mint: 'two', symbol: 'TWO', fee_bps: 200, fee_lamports: '1900000000' }, 1_000);
    store.upsertToken({ ...base, mint: 'three', symbol: 'THREE', fee_bps: 300, fee_lamports: '3000000000' }, 2_000);
    store.upsertToken({ ...base, mint: 'four', symbol: 'FOUR', fee_bps: 400, fee_lamports: '3200000000' }, 3_000);
    // Two that have traded the same, 50 SOL each, one launched after the other, and one that has never traded.
    store.upsertToken({ ...base, mint: 'older', symbol: 'OLDER', fee_bps: 300, fee_lamports: '1500000000' }, 4_000);
    store.upsertToken({ ...base, mint: 'newer', symbol: 'NEWER', fee_bps: 300, fee_lamports: '1500000000' }, 5_000);
    store.upsertToken({ ...base, mint: 'quiet', symbol: 'QUIET', fee_bps: 300, fee_lamports: '0' }, 6_000);
  });

  afterAll(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('puts the most traded since launch first, whatever the fee tier, and the newer of two equals first', () => {
    expect(order('volume')).toEqual(['three', 'two', 'four', 'newer', 'older', 'quiet']);
  });

  it('on a day with no trades, has Trending fall back to the same order', () => {
    expect(order('hot')).toEqual(order('volume'));
  });

  it('puts what traded in the last day first on Trending, and leaves the lifetime order alone', () => {
    // The quiet token trades 2 SOL today, the 4% token 1 SOL.
    store.setVolume('quiet', '2000000000');
    store.setVolume('four', '1000000000');
    expect(order('hot')).toEqual(['quiet', 'four', 'three', 'two', 'newer', 'older']);
    expect(order('volume')).toEqual(['three', 'two', 'four', 'newer', 'older', 'quiet']);
  });

  it('adds the front page up token by token, each at its own rate', () => {
    // 95 + 100 + 80 + 50 + 50 + 0 SOL traded since launch; 3 SOL in the last day.
    expect(store.totals()).toMatchObject({ tokens: 6, volumeLamports: '375000000000', volume24hLamports: '3000000000' });
    // Not the fees over one rate for all: 11.1 SOL of fees at 3% would be 370 SOL.
    expect(store.totals().feeLamports).toBe('11100000000');
  });

  it('counts a token priced in another pair in SOL terms, from its fees in SOL terms', () => {
    // 30 USDC of fees at 3% is 1,000 USDC traded. At the pair's rate those fees are 0.36 SOL, so 12 SOL traded.
    store.upsertToken({ ...base, mint: 'usdc', symbol: 'USDC1', pair: 'USDC', fee_bps: 300, fee_lamports: '30000000', cap_sol: 1, reserve_sol: 0, fee_sol: 0.36 }, 7_000);
    expect(lifetimeVolume(store.token('usdc') as { fee_lamports: string; fee_bps: number })).toBe('1000000000');
    expect(store.totals().volumeLamports).toBe('387000000000');
    // 12 SOL traded puts it below the 50s and above the token that has never traded... which traded today, so on
    // the lifetime order it is last but one.
    expect(order('volume')).toEqual(['three', 'two', 'four', 'newer', 'older', 'usdc', 'quiet']);
  });
});
