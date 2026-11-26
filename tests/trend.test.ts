import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SPARK_POINTS, TREND_WINDOW_MS, baselineOf, changeDirection, changeOf, changeText, sparkOf } from '../shared/src/trend.js';
import { Store } from '../server/src/db.js';
import { isHashedAsset } from '../server/src/http.js';
import { Trends } from '../server/src/trend.js';

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;
const SINCE = NOW - TREND_WINDOW_MS;

describe('a card’s small chart', () => {
  it('is evenly spaced, oldest first, and ends at the price now', () => {
    const history = Array.from({ length: 25 }, (_, hour) => ({ at: SINCE + hour * HOUR, price: 1 + hour }));
    const line = sparkOf(history, SINCE, NOW);
    expect(line).toHaveLength(SPARK_POINTS);
    expect(line[0]).toBe(1);
    expect(line[line.length - 1]).toBe(25);
    // It never goes back in time: a rising history draws a line that never falls.
    for (let index = 1; index < line.length; index += 1) expect(line[index]).toBeGreaterThanOrEqual(line[index - 1] as number);
  });

  it('holds the last price through a quiet stretch instead of sloping to the next trade', () => {
    const line = sparkOf(
      [
        { at: SINCE, price: 2 },
        { at: NOW - HOUR, price: 8 },
        { at: NOW, price: 8 },
      ],
      SINCE,
      NOW,
      25,
    );
    // Twenty-five points over a day is one an hour: flat at 2 for twenty-three hours, then 8.
    expect(line.slice(0, 23).every((price) => price === 2)).toBe(true);
    expect(line.slice(23)).toEqual([8, 8]);
  });

  it('starts from the price in force when the window opened', () => {
    const line = sparkOf(
      [
        { at: SINCE - 5 * HOUR, price: 3 },
        { at: SINCE - HOUR, price: 4 },
        { at: NOW - 12 * HOUR, price: 6 },
        { at: NOW, price: 6 },
      ],
      SINCE,
      NOW,
      5,
    );
    expect(line).toEqual([4, 4, 6, 6, 6]);
  });

  it('gives a token younger than a day a chart of its own lifetime', () => {
    const born = NOW - 2 * HOUR;
    const line = sparkOf(
      [
        { at: born, price: 1 },
        { at: born + HOUR, price: 2 },
        { at: NOW, price: 3 },
      ],
      SINCE,
      NOW,
      5,
    );
    // Five points over its two hours: one every half hour.
    expect(line).toEqual([1, 1, 2, 2, 3]);
  });

  it('copes with nothing, with one point, and with points that are not prices', () => {
    expect(sparkOf([], SINCE, NOW)).toEqual([]);
    expect(sparkOf([{ at: NOW, price: 5 }], SINCE, NOW)).toEqual([5]);
    expect(sparkOf([{ at: NOW, price: 0 }], SINCE, NOW)).toEqual([]);
    expect(sparkOf([{ at: NOW - HOUR, price: Number.NaN }, { at: NOW, price: -1 }, { at: NOW, price: 7 }], SINCE, NOW)).toEqual([7]);
    // Out of order is put in order.
    expect(sparkOf([{ at: NOW, price: 9 }, { at: NOW - HOUR, price: 1 }], SINCE, NOW, 3)).toEqual([1, 1, 9]);
    // Whatever is asked for, a line has at least two points.
    expect(sparkOf([{ at: NOW - HOUR, price: 1 }, { at: NOW, price: 2 }], SINCE, NOW, 0)).toEqual([1, 2]);
  });

  it('keeps six significant digits, however small the price', () => {
    expect(sparkOf([{ at: NOW - HOUR, price: 0.000000012345678 }, { at: NOW, price: 0.000000012345678 }], SINCE, NOW, 2)).toEqual([0.0000000123457, 0.0000000123457]);
  });
});

describe('a card’s change', () => {
  it('is the price now against the earlier one, as a fraction', () => {
    expect(changeOf(2, 3)).toBe(0.5);
    expect(changeOf(4, 1)).toBe(-0.75);
    expect(changeOf(1, 1)).toBe(0);
    expect(changeOf(3, 3.0000001)).toBe(0);
    expect(changeOf(3, 2.9999999)).toBe(0);
  });

  it('is nothing at all when there is nothing to compare with', () => {
    expect(changeOf(null, 3)).toBeNull();
    expect(changeOf(undefined, 3)).toBeNull();
    expect(changeOf(0, 3)).toBeNull();
    expect(changeOf(2, 0)).toBeNull();
    expect(changeOf(Number.NaN, 3)).toBeNull();
    expect(changeOf(2, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('is measured from the last price before the window, or a new token’s first price', () => {
    const history = [
      { at: SINCE - 2 * HOUR, price: 1 },
      { at: SINCE - HOUR, price: 2 },
      { at: SINCE + HOUR, price: 5 },
    ];
    expect(baselineOf(history, SINCE)).toBe(2);
    expect(baselineOf(history.slice(2), SINCE)).toBe(5);
    expect(baselineOf([{ at: SINCE, price: 3 }, { at: NOW, price: 9 }], SINCE)).toBe(3);
    expect(baselineOf([], SINCE)).toBeNull();
    expect(baselineOf([{ at: NOW, price: 0 }], SINCE)).toBeNull();
  });

  it('reads the way a card prints it', () => {
    expect(changeText(0.124)).toBe('+12.4%');
    expect(changeText(-0.031)).toBe('−3.1%');
    expect(changeText(0)).toBe('0%');
    expect(changeText(0.0004)).toBe('0%');
    expect(changeText(1.5)).toBe('+150%');
    expect(changeText(12.5)).toBe('+1.25K%');
    expect(changeText(250)).toBe('+25.0K%');
    expect(changeText(2500)).toBe('+250K%');
    expect(changeText(-0.999)).toBe('−99.9%');
    expect(changeText(null)).toBe('—');
    expect(changeText(undefined)).toBe('—');
    expect(changeText(Number.NaN)).toBe('—');
    expect(changeDirection(0.2)).toBe('up');
    expect(changeDirection(-0.2)).toBe('down');
    expect(changeDirection(0.0004)).toBe('flat');
    expect(changeDirection(null)).toBe('flat');
  });
});

describe('a token’s last day, from the price points kept for it', () => {
  let directory: string;
  let store: Store;

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'pcf-trend-'));
    store = new Store(directory);
    // An old token: a point every five minutes for thirty hours, the price climbing by one each hour.
    for (let minute = 0; minute <= 30 * 60; minute += 5) store.addSnapshot('old', NOW - 30 * HOUR + minute * 60_000, String(100 + Math.floor(minute / 60)), '0');
    // A new one: first seen ninety minutes ago.
    store.addSnapshot('new', NOW - 90 * 60_000, '2', '0');
    store.addSnapshot('new', NOW - 30 * 60_000, '3', '0');
  });

  afterAll(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('thins a busy day in the database, keeping the last point of each stretch', () => {
    const trail = store.priceTrail('old', SINCE, TREND_WINDOW_MS / 64);
    // One point from before the window, then at most one per stretch of it.
    expect(trail[0]).toEqual({ at: SINCE - 5 * 60_000, price: '105' });
    expect(trail.length).toBeGreaterThan(40);
    expect(trail.length).toBeLessThanOrEqual(66);
    expect(trail[trail.length - 1]).toEqual({ at: NOW, price: '130' });
    for (let index = 1; index < trail.length; index += 1) expect((trail[index] as { at: number }).at).toBeGreaterThan((trail[index - 1] as { at: number }).at);
    expect(store.priceTrail('nobody', SINCE, HOUR)).toEqual([]);
  });

  it('gives the chart and the change a card shows', () => {
    const trends = new Trends(store);
    const old = trends.of({ mint: 'old', price_sol: '130' }, NOW);
    expect(old.spark).toHaveLength(SPARK_POINTS);
    // The price in force as the window opens is the last one from before it.
    expect(old.spark[0]).toBe(105);
    expect(old.spark[old.spark.length - 1]).toBe(130);
    // 105 a day ago, 130 now.
    expect(old.change24h).toBe(0.2381);

    const fresh = trends.of({ mint: 'new', price_sol: '4' }, NOW);
    expect(fresh.spark[0]).toBe(2);
    expect(fresh.spark[fresh.spark.length - 1]).toBe(4);
    // Against its first price: 2 then, 4 now.
    expect(fresh.change24h).toBe(1);

    // A token with no price points yet has a single price and no change.
    expect(trends.of({ mint: 'unseen', price_sol: '0.5' }, NOW)).toEqual({ spark: [0.5], change24h: null });
    expect(trends.of({ mint: 'empty', price_sol: '0' }, NOW)).toEqual({ spark: [], change24h: null });
  });

  it('remembers an answer for a moment, and forgets it when the price moves', () => {
    let reads = 0;
    const counting = new Trends({
      priceTrail: (mint, since, bucket) => {
        reads += 1;
        return store.priceTrail(mint, since, bucket);
      },
    });
    const first = counting.of({ mint: 'old', price_sol: '130' }, NOW);
    expect(counting.of({ mint: 'old', price_sol: '130' }, NOW + 5_000)).toBe(first);
    expect(reads).toBe(1);
    counting.of({ mint: 'old', price_sol: '131' }, NOW + 6_000);
    expect(reads).toBe(2);
    counting.of({ mint: 'old', price_sol: '131' }, NOW + 60_000);
    expect(reads).toBe(3);
  });
});

describe('files a browser may keep for good', () => {
  it('are the ones the build named after their contents, and nothing else', () => {
    expect(isHashedAsset('/srv/web/dist/assets/trade-DuNGBhnK.js')).toBe(true);
    expect(isHashedAsset('/srv/web/dist/assets/shell-BjQ8NSAG.css')).toBe(true);
    expect(isHashedAsset('/srv/web/dist/assets/index-Du_y9YG6.js')).toBe(true);
    expect(isHashedAsset('/srv/web/dist/assets/archivo-latin-wdth-normal-C-4mLpq2.woff2')).toBe(true);
    expect(isHashedAsset('C:\\app\\web\\dist\\assets\\wallet-DKJIykxm.js')).toBe(true);
    // Plainly named files can change between releases.
    expect(isHashedAsset('/srv/web/dist/assets/logo.png')).toBe(false);
    expect(isHashedAsset('/srv/web/dist/assets/favicon.svg')).toBe(false);
    expect(isHashedAsset('/srv/web/dist/assets/maskable-icon-512.png')).toBe(false);
    expect(isHashedAsset('/srv/web/dist/index.html')).toBe(false);
    expect(isHashedAsset('/srv/web/dist/wallet.html')).toBe(false);
    expect(isHashedAsset('/srv/web/dist/manifest.webmanifest')).toBe(false);
    // Only inside the assets folder, and only with a hash of the build's length.
    expect(isHashedAsset('/srv/web/dist/trade-DuNGBhnK.js')).toBe(false);
    expect(isHashedAsset('/srv/web/dist/assets/trade.js')).toBe(false);
    expect(isHashedAsset('/srv/web/dist/assets/trade-abc.js')).toBe(false);
  });
});
