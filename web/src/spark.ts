/**
 * The ghost chart: the small line on a token's card.
 *
 * It is drawn three times over: a faint wash under the line, the line's own
 * afterimage a little below it and out of focus, and the line. Working out
 * the shape touches neither the page nor the network, so it can be tested.
 */

export interface SparkShape {
  /** The line, as an SVG path. */
  readonly line: string;
  /** The same line closed down to the foot of the box, for the wash under it. */
  readonly area: string;
  /** Where the line ends, as fractions of the box: for the dot that marks now. */
  readonly end: { readonly x: number; readonly y: number };
}

export const SPARK_WIDTH = 120;
export const SPARK_HEIGHT = 36;

const fixed = (value: number): string => String(Math.round(value * 10) / 10);

/**
 * The path through `values`, oldest first, in a box `width` by `height`, with
 * `pad` kept clear above and below so the stroke is never cut. Corners are
 * rounded by passing through the middle of each segment, which keeps the line
 * inside the range of the values: it never draws a price that did not happen.
 * A history that never moved is a level line across the middle. Null when
 * there is nothing to draw.
 */
export function sparkShape(values: readonly number[], width: number = SPARK_WIDTH, height: number = SPARK_HEIGHT, pad = 4): SparkShape | null {
  const prices = values.filter((value) => Number.isFinite(value) && value > 0);
  if (prices.length === 0) return null;
  // One price is a level line: there is a value, and no movement to show.
  const series = prices.length === 1 ? [prices[0] as number, prices[0] as number] : prices;
  const low = Math.min(...series);
  const high = Math.max(...series);
  const span = high - low;
  const room = Math.max(1, height - pad * 2);
  const points = series.map((value, index) => ({
    x: (index / (series.length - 1)) * width,
    y: span > 0 ? pad + (1 - (value - low) / span) * room : height / 2,
  }));
  const first = points[0] as { x: number; y: number };
  const last = points[points.length - 1] as { x: number; y: number };
  let line = `M${fixed(first.x)} ${fixed(first.y)}`;
  if (points.length === 2) {
    line += `L${fixed(last.x)} ${fixed(last.y)}`;
  } else {
    for (let index = 1; index < points.length - 1; index += 1) {
      const point = points[index] as { x: number; y: number };
      const next = points[index + 1] as { x: number; y: number };
      // The last corner runs all the way to the final point; the others stop halfway to the next.
      const end = index === points.length - 2 ? next : { x: (point.x + next.x) / 2, y: (point.y + next.y) / 2 };
      line += `Q${fixed(point.x)} ${fixed(point.y)} ${fixed(end.x)} ${fixed(end.y)}`;
    }
  }
  return {
    line,
    area: `${line}L${fixed(width)} ${fixed(height)}L0 ${fixed(height)}Z`,
    end: { x: 1, y: last.y / height },
  };
}

/** Which way the line went from its first point to its last. A line of one price went nowhere. */
export function sparkDirection(values: readonly number[]): 'up' | 'down' | 'flat' {
  const prices = values.filter((value) => Number.isFinite(value) && value > 0);
  if (prices.length < 2) return 'flat';
  const first = prices[0] as number;
  const last = prices[prices.length - 1] as number;
  return last > first ? 'up' : last < first ? 'down' : 'flat';
}

/** The chart as markup. `values` come from the server as numbers; nothing in them reaches the page as text. */
export function sparkSvg(values: readonly number[]): string {
  const shape = sparkShape(values);
  if (!shape) return '<span class="spark-none" aria-hidden="true"></span>';
  const direction = sparkDirection(values);
  return `<svg class="spark is-${direction}" viewBox="0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}" preserveAspectRatio="none" aria-hidden="true" focusable="false"><path class="spark-area" d="${shape.area}"/><path class="spark-echo" d="${shape.line}"/><path class="spark-line" d="${shape.line}"/></svg><i class="spark-dot" style="top:${(shape.end.y * 100).toFixed(1)}%" aria-hidden="true"></i>`;
}
