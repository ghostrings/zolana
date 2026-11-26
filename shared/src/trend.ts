/**
 * The small chart on a token's card, and the change beside it.
 *
 * Both are made from the price points the server already keeps for each
 * token. Nothing here touches a database or the network, so the rules can be
 * tested: how a history is thinned to a fixed number of points, and what a
 * change is measured against.
 */

export interface PricePoint {
  /** Milliseconds since the epoch. */
  readonly at: number;
  /** Pair tokens per whole token. */
  readonly price: number;
}

/** How many points a card's chart is drawn from, at most. */
export const SPARK_POINTS = 32;

/** The stretch of time a card looks back over. */
export const TREND_WINDOW_MS = 24 * 60 * 60 * 1000;

const usable = (point: PricePoint): boolean => Number.isFinite(point.at) && Number.isFinite(point.price) && point.price > 0;

/** Six significant digits: plenty for a line a few dozen pixels tall, and short on the wire. */
const trimmed = (price: number): number => Number(price.toPrecision(6));

/**
 * A price history thinned to at most `points` values, oldest first, evenly
 * spaced in time. Each value is the last price known at its moment, so a
 * quiet stretch draws flat instead of sloping toward the next trade.
 *
 * The line starts at `since`, or at the token's first price when that is
 * later: a token two hours old gets a chart of its two hours, not a flat day
 * with a step at the end. It ends at `now`. Points that are not positive
 * numbers are ignored, and their order does not matter. With no usable point
 * the answer is empty; with one, it is that one price.
 */
export function sparkOf(history: readonly PricePoint[], since: number, now: number, points: number = SPARK_POINTS): number[] {
  const sorted = history.filter(usable).sort((a, b) => a.at - b.at);
  const first = sorted[0];
  if (!first) return [];
  const count = Math.max(2, Math.floor(points));
  const start = Math.max(since, first.at);
  const end = Math.max(now, start);
  const distinct = new Set(sorted.map((point) => point.at)).size;
  if (distinct < 2 || end <= start) return [trimmed((sorted[sorted.length - 1] as PricePoint).price)];
  const line: number[] = [];
  let cursor = 0;
  // The price in force at `start`: the last point at or before it.
  let price = first.price;
  for (let index = 0; index < count; index += 1) {
    const moment = start + ((end - start) * index) / (count - 1);
    while (cursor < sorted.length && (sorted[cursor] as PricePoint).at <= moment) {
      price = (sorted[cursor] as PricePoint).price;
      cursor += 1;
    }
    line.push(trimmed(price));
  }
  return line;
}

/**
 * The price now against an earlier one, as a fraction: 0.12 is 12% up, -0.5 is
 * half gone. Null when either price is missing or not a positive number,
 * which is shown as no change at all rather than as a number that means
 * nothing.
 */
export function changeOf(baseline: number | null | undefined, current: number): number | null {
  if (baseline === null || baseline === undefined) return null;
  if (!Number.isFinite(baseline) || !Number.isFinite(current) || baseline <= 0 || current <= 0) return null;
  const change = current / baseline - 1;
  // Rounded to a hundredth of a percent, so the same prices always give the same answer on the wire.
  const rounded = Math.round(change * 10_000) / 10_000;
  return rounded === 0 ? 0 : rounded;
}

/**
 * What a change is measured against: the last price at or before the start
 * of the window, or, for a token first seen inside the window, its first
 * price. Null with no usable point at all.
 */
export function baselineOf(history: readonly PricePoint[], since: number): number | null {
  const sorted = history.filter(usable).sort((a, b) => a.at - b.at);
  if (sorted.length === 0) return null;
  let baseline = (sorted[0] as PricePoint).price;
  for (const point of sorted) {
    if (point.at > since) break;
    baseline = point.price;
  }
  return baseline;
}

/** How a change reads on a card: "+12.4%", "−3.1%", "+1.2K%". "0%" for no change, "—" when there is none to show. */
export function changeText(change: number | null | undefined): string {
  if (change === null || change === undefined || !Number.isFinite(change)) return '—';
  const percent = change * 100;
  const size = Math.abs(percent);
  if (size < 0.05) return '0%';
  const sign = percent > 0 ? '+' : '−';
  if (size >= 100_000) return `${sign}${(size / 1000).toFixed(0)}K%`;
  if (size >= 10_000) return `${sign}${(size / 1000).toFixed(1)}K%`;
  if (size >= 1000) return `${sign}${(size / 1000).toFixed(2)}K%`;
  if (size >= 100) return `${sign}${size.toFixed(0)}%`;
  return `${sign}${size.toFixed(1)}%`;
}

/** Which way a change points, for the mark beside it. A change too small to print counts as none. */
export function changeDirection(change: number | null | undefined): 'up' | 'down' | 'flat' {
  if (change === null || change === undefined || !Number.isFinite(change) || Math.abs(change * 100) < 0.05) return 'flat';
  return change > 0 ? 'up' : 'down';
}
