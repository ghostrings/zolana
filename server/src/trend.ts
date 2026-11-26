/**
 * A token's last day as a card shows it: the small chart and the change
 * beside it. Read from the price points the indexer keeps, and remembered for
 * a short while, so a busy market page does not read them again for every
 * visitor.
 */

import { type PricePoint, SPARK_POINTS, TREND_WINDOW_MS, baselineOf, changeOf, sparkOf } from '../../shared/src/trend.js';
import type { Store, TokenRow } from './db.js';

export interface Trend {
  readonly spark: number[];
  readonly change24h: number | null;
}

/** How long an answer is reused while the token's price has not changed. */
const REMEMBER_MS = 30_000;
/** Past this many remembered tokens the memory is simply emptied: it only ever saves work. */
const REMEMBER_AT_MOST = 4_000;

export class Trends {
  readonly #store: Pick<Store, 'priceTrail'>;
  readonly #seen = new Map<string, { at: number; price: string; trend: Trend }>();

  constructor(store: Pick<Store, 'priceTrail'>) {
    this.#store = store;
  }

  of(row: Pick<TokenRow, 'mint' | 'price_sol'>, now: number = Date.now()): Trend {
    const kept = this.#seen.get(row.mint);
    if (kept && kept.price === row.price_sol && now - kept.at >= 0 && now - kept.at < REMEMBER_MS) return kept.trend;
    const since = now - TREND_WINDOW_MS;
    // Twice as many points as the chart shows, so thinning them once more loses nothing that would be seen.
    const history: PricePoint[] = this.#store
      .priceTrail(row.mint, since, TREND_WINDOW_MS / (SPARK_POINTS * 2))
      .map((point) => ({ at: point.at, price: Number(point.price) }));
    const current = Number(row.price_sol);
    const trend: Trend = {
      // The line ends at the price the listing shows now, which may be newer than the last point kept.
      spark: sparkOf([...history, { at: now, price: current }], since, now),
      change24h: changeOf(baselineOf(history, since), current),
    };
    if (this.#seen.size >= REMEMBER_AT_MOST) this.#seen.clear();
    this.#seen.set(row.mint, { at: now, price: row.price_sol, trend });
    return trend;
  }
}
