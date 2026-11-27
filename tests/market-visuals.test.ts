import { describe, expect, it } from 'vitest';
import { sampleMarketPrices } from '../server/src/listing.js';
import { sparkPath } from '../web/src/market-visuals.js';

describe('market sparkline', () => {
  it('samples no more than 32 actual observations, including endpoints', () => {
    const rows = Array.from({ length: 120 }, (_, at) => ({ at, price_sol: `${at + 1}` }));
    const points = sampleMarketPrices(rows);
    expect(points).toHaveLength(32);
    expect(points[0]).toEqual({ at: 0, price: '1' });
    expect(points.at(-1)).toEqual({ at: 119, price: '120' });
    expect(points.every((point) => rows.some((row) => row.at === point.at && row.price_sol === point.price))).toBe(true);
  });
  it('returns an explicit missing-history state rather than inventing prices', () => {
    expect(sparkPath(undefined)).toBeNull();
    expect(sparkPath([{ at: 10, price: '1' }])).toBeNull();
    expect(sparkPath([{ at: 10, price: '1' }, { at: 10, price: '2' }])).toBeNull();
    expect(sampleMarketPrices([{ at: 1, price_sol: 'NaN' }, { at: 2, price_sol: '0' }])).toEqual([]);
  });
  it('uses actual elapsed time and preserves flat histories', () => {
    expect(sparkPath([{ at: 10, price: '5' }, { at: 20, price: '5' }, { at: 50, price: '5' }])).toBe('2.00,20.00 41.00,20.00 158.00,20.00');
    expect(sparkPath([{ at: 20, price: '2' }, { at: 10, price: '1' }])).toBe('2.00,35.00 158.00,5.00');
  });
});
