import { describe, expect, it } from 'vitest';

import { changeChip, pairChip } from '../web/src/chips.js';
import { shortAmount, smallPrice } from '../web/src/format.js';
import { SPARK_HEIGHT, SPARK_WIDTH, sparkDirection, sparkShape, sparkSvg } from '../web/src/spark.js';

/** Every number in a path, as [x, y] pairs in the order they are drawn. */
function coordinates(path: string): Array<[number, number]> {
  const numbers = (path.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  const pairs: Array<[number, number]> = [];
  for (let index = 0; index + 1 < numbers.length; index += 2) pairs.push([numbers[index] as number, numbers[index + 1] as number]);
  return pairs;
}

describe('the ghost chart’s shape', () => {
  it('has nothing to draw without a usable price', () => {
    expect(sparkShape([])).toBeNull();
    expect(sparkShape([0, -1, Number.NaN, Number.POSITIVE_INFINITY])).toBeNull();
  });

  it('draws one price, or a price that never moved, as a level line across the middle', () => {
    expect(sparkShape([5])?.line).toBe('M0 18L120 18');
    expect(sparkShape([5, 5, 5])?.line).toBe('M0 18Q60 18 120 18');
    expect(sparkShape([5])?.end).toEqual({ x: 1, y: 0.5 });
  });

  it('puts the lowest price at the foot and the highest at the top, clear of the edges', () => {
    const rising = sparkShape([1, 2]);
    expect(rising?.line).toBe('M0 32L120 4');
    expect(rising?.area).toBe('M0 32L120 4L120 36L0 36Z');
    expect(rising?.end.y).toBeCloseTo(4 / 36, 10);
    expect(sparkShape([2, 1])?.line).toBe('M0 4L120 32');
  });

  it('rounds the corners through the middle of each stretch and ends on the last price', () => {
    expect(sparkShape([1, 3, 2])?.line).toBe('M0 32Q60 4 120 18');
    expect(sparkShape([1, 2, 3, 4])?.line).toBe('M0 32Q40 22.7 60 18Q80 13.3 120 4');
  });

  it('leaves out prices that are not prices instead of drawing them', () => {
    expect(sparkShape([1, Number.NaN, 2, 0])?.line).toBe(sparkShape([1, 2])?.line);
  });

  it('fits another box when asked', () => {
    expect(sparkShape([1, 2], 200, 50, 5)?.line).toBe('M0 45L200 5');
    // A box too short for its own margins still gives a line, never a negative height.
    expect(sparkShape([1, 2], 10, 4, 4)?.line).toBe('M0 5L10 4');
  });

  it('never leaves its box and never goes back in time, whatever the prices', () => {
    let seed = 20_261_124;
    const random = (): number => {
      seed = (seed * 1_664_525 + 1_013_904_223) % 4_294_967_296;
      return seed / 4_294_967_296;
    };
    for (let round = 0; round < 300; round += 1) {
      const length = 1 + Math.floor(random() * 40);
      // Prices across twelve orders of magnitude, with the odd dead value mixed in.
      const values = Array.from({ length }, () => (random() < 0.08 ? 0 : 10 ** (random() * 12 - 9)));
      const shape = sparkShape(values);
      if (!values.some((value) => value > 0)) {
        expect(shape).toBeNull();
        continue;
      }
      const points = coordinates((shape as NonNullable<typeof shape>).line);
      expect(points[0]?.[0]).toBe(0);
      expect(points[points.length - 1]?.[0]).toBe(SPARK_WIDTH);
      let last = 0;
      for (const [x, y] of points) {
        expect(x).toBeGreaterThanOrEqual(last);
        expect(x).toBeLessThanOrEqual(SPARK_WIDTH);
        expect(y).toBeGreaterThanOrEqual(4);
        expect(y).toBeLessThanOrEqual(SPARK_HEIGHT - 4);
        last = x;
      }
      expect((shape as NonNullable<typeof shape>).end.y).toBeGreaterThan(0);
      expect((shape as NonNullable<typeof shape>).end.y).toBeLessThan(1);
    }
  });
});

describe('which way the ghost chart went', () => {
  it('compares the first price with the last', () => {
    expect(sparkDirection([1, 5, 2])).toBe('up');
    expect(sparkDirection([2, 5, 1])).toBe('down');
    expect(sparkDirection([2, 5, 2])).toBe('flat');
  });

  it('went nowhere with fewer than two prices', () => {
    expect(sparkDirection([])).toBe('flat');
    expect(sparkDirection([3])).toBe('flat');
    expect(sparkDirection([Number.NaN, 3, 0])).toBe('flat');
  });

  it('skips what is not a price', () => {
    expect(sparkDirection([0, 1, Number.NaN, 2])).toBe('up');
  });
});

describe('the ghost chart’s markup', () => {
  it('is an empty placeholder when there is nothing to draw', () => {
    expect(sparkSvg([])).toBe('<span class="spark-none" aria-hidden="true"></span>');
  });

  it('draws the wash, the echo and the line, and marks where the line ends', () => {
    const markup = sparkSvg([1, 2]);
    expect(markup).toContain('class="spark is-up"');
    expect(markup).toContain(`viewBox="0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}"`);
    expect(markup).toContain('<path class="spark-area" d="M0 32L120 4L120 36L0 36Z"/>');
    expect(markup).toContain('<path class="spark-echo" d="M0 32L120 4"/>');
    expect(markup).toContain('<path class="spark-line" d="M0 32L120 4"/>');
    expect(markup).toContain('style="top:11.1%"');
    expect(sparkSvg([2, 1])).toContain('class="spark is-down"');
    expect(sparkSvg([2, 2])).toContain('class="spark is-flat"');
  });

  it('is hidden from a screen reader: the change beside it says the same thing in words', () => {
    const markup = sparkSvg([1, 2, 3]);
    expect(markup.match(/aria-hidden="true"/g)).toHaveLength(2);
  });

  it('writes nothing but digits, points and path letters into the page, whatever numbers arrive', () => {
    const markup = sparkSvg([1e-12, 1e21, Number.MAX_VALUE, Number.MIN_VALUE, 3]);
    for (const [, path] of markup.matchAll(/ d="([^"]*)"/g)) expect(path).toMatch(/^[MLQZ0-9. ]+$/);
    expect(markup).toMatch(/style="top:\d+\.\d%"/);
    expect(markup).not.toMatch(/NaN|Infinity|e[+-]\d/);
  });
});

describe('a very small price', () => {
  it('is split into the count of zeros after the point and the digits that follow', () => {
    expect(smallPrice('0.0000000283')).toEqual({ zeros: 7, digits: '283' });
    expect(smallPrice('0.00001234')).toEqual({ zeros: 4, digits: '1234' });
    expect(smallPrice('0.00009999')).toEqual({ zeros: 4, digits: '9999' });
  });

  it('keeps four digits unless asked for another number', () => {
    expect(smallPrice('0.000000000123456')).toEqual({ zeros: 9, digits: '1235' });
    expect(smallPrice('0.0000000283', 2)).toEqual({ zeros: 7, digits: '28' });
    expect(smallPrice('0.0000000283', 0)).toEqual({ zeros: 7, digits: '3' });
  });

  it('is left alone when it is short enough to write out', () => {
    expect(smallPrice('0.0001')).toBeNull();
    expect(smallPrice('0.000123')).toBeNull();
    expect(smallPrice('0.5')).toBeNull();
    expect(smallPrice('42')).toBeNull();
  });

  it('is left alone when rounding would take away its fourth zero', () => {
    // 0.000099996 to four digits is 0.0001: three zeros, so it is written the ordinary way.
    expect(smallPrice('0.000099996')).toBeNull();
  });

  it('is nothing for what is not a price', () => {
    expect(smallPrice('0')).toBeNull();
    expect(smallPrice('-0.00000001')).toBeNull();
    expect(smallPrice('')).toBeNull();
    expect(smallPrice('not a number')).toBeNull();
    expect(smallPrice('Infinity')).toBeNull();
  });

  it('writes the same number back when its parts are put together', () => {
    for (const price of ['0.0000000283', '0.00001234', '0.000000000000512', '0.00000705']) {
      const parts = smallPrice(price, 6);
      expect(parts).not.toBeNull();
      const { zeros, digits } = parts as NonNullable<typeof parts>;
      expect(Number(`0.${'0'.repeat(zeros)}${digits}`)).toBeCloseTo(Number(price), 20);
    }
  });
});

describe('a large amount cut short', () => {
  it('is left to be written out below a thousand', () => {
    expect(shortAmount(0)).toBeNull();
    expect(shortAmount(999.99)).toBeNull();
  });

  it('is counted in thousands, millions, billions and trillions', () => {
    expect(shortAmount(1000)).toBe('1.0K');
    expect(shortAmount(12_345)).toBe('12.3K');
    expect(shortAmount(79_724)).toBe('79.7K');
    expect(shortAmount(1_234_567)).toBe('1.23M');
    expect(shortAmount(123_456_789_012.34)).toBe('123.46B');
    expect(shortAmount(5.5e12)).toBe('5.50T');
  });

  it('moves up a unit instead of printing a thousand of the one below', () => {
    expect(shortAmount(999_949)).toBe('999.9K');
    expect(shortAmount(999_960)).toBe('1.00M');
    expect(shortAmount(999_999_999)).toBe('1.00B');
    expect(shortAmount(999_996_000_000)).toBe('1.00T');
  });

  it('never prints four digits before the point, short of a thousand trillion', () => {
    for (let power = 3; power < 15; power += 0.137) {
      const text = shortAmount(10 ** power) as string;
      expect(text).toMatch(/^\d{1,3}\.\d{1,2}[KMBT]$/);
    }
  });

  it('is nothing for what is not an amount', () => {
    expect(shortAmount(Number.NaN)).toBeNull();
    expect(shortAmount(Number.POSITIVE_INFINITY)).toBeNull();
    expect(shortAmount(-5000)).toBeNull();
  });
});

describe('the change over a day, as a mark', () => {
  it('is filled and points up for a rise, with no sign: the triangle says which way', () => {
    const chip = changeChip(0.124);
    expect(chip).toContain('class="chg up"');
    expect(chip).toContain('<span>12.4%</span>');
    expect(chip).not.toContain('+');
    expect(chip).toContain('M5 1.5 9.2 8.5H.8z');
    expect(chip).toContain('<span class="sr-only">Up 12.4% over 24 hours</span>');
  });

  it('is hollow and points down for a fall', () => {
    const chip = changeChip(-0.031);
    expect(chip).toContain('class="chg down"');
    expect(chip).toContain('<span>3.1%</span>');
    expect(chip).not.toContain('−');
    expect(chip).toContain('M5 8.5.8 1.5h8.4z');
    expect(chip).toContain('Down 3.1% over 24 hours');
  });

  it('has no triangle when the price did not move', () => {
    for (const still of [0, 0.0004, -0.0004]) {
      const chip = changeChip(still);
      expect(chip).toContain('class="chg flat"');
      expect(chip).toContain('<span>0%</span>');
      expect(chip).not.toContain('<svg');
      expect(chip).toContain('No change over 24 hours');
    }
  });

  it('is a dash, and says so in words, when there is nothing to compare with yet', () => {
    for (const unknown of [null, undefined, Number.NaN]) {
      const chip = changeChip(unknown);
      expect(chip).toContain('class="chg flat"');
      expect(chip).toContain('<span>—</span>');
      expect(chip).toContain('No 24 hour change to show yet');
      expect(chip).not.toContain('No change over');
    }
  });

  it('shortens a very large rise', () => {
    expect(changeChip(12.5)).toContain('<span>1.25K%</span>');
    expect(changeChip(12.5)).toContain('Up 1.25K% over 24 hours');
  });

  it('carries the hook the market uses to bring it up to date in place', () => {
    expect(changeChip(0.5)).toContain('data-f="chg"');
  });
});

describe('what a token is priced in, as a mark', () => {
  it('shows the pair’s symbol and its first letter', () => {
    const chip = pairChip({ id: 'usdc', symbol: 'USDC' });
    expect(chip).toContain('<i aria-hidden="true">U</i>USDC');
    expect(chip).toContain('title="Priced and traded in USDC"');
  });

  it('falls back to the pair’s id when it has no symbol', () => {
    expect(pairChip({ id: 'zec', symbol: '' })).toContain('<i aria-hidden="true">Z</i>zec');
  });

  it('never lets a symbol become markup', () => {
    const chip = pairChip({ id: 'x', symbol: '<img src=x onerror=alert(1)>"' });
    expect(chip).not.toContain('<img');
    expect(chip).toContain('&lt;img src=x onerror=alert(1)&gt;&quot;');
    expect(chip).toContain('<i aria-hidden="true">&lt;</i>');
  });
});
