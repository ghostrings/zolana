/**
 * Exact decimal <-> integer conversion. Money never passes through a float.
 */

const PLAIN_DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const U64_MAX = 18_446_744_073_709_551_615n;

export class AmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AmountError';
  }
}

/** "1.5" with 9 decimals -> 1500000000n. Rejects exponents, signs and excess precision. */
export function parseUnits(value: string, decimals: number): bigint {
  const text = value.trim();
  if (!PLAIN_DECIMAL.test(text)) {
    throw new AmountError('Enter a plain positive number, like 0.5.');
  }
  const [whole = '0', fraction = ''] = text.split('.');
  if (fraction.length > decimals) {
    throw new AmountError(`At most ${decimals} decimal places are allowed.`);
  }
  const raw = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
  if (raw > U64_MAX) throw new AmountError('That amount is too large.');
  return raw;
}

/** 1500000000n with 9 decimals -> "1.5". `maxFraction` truncates, it never rounds up. */
export function formatUnits(raw: bigint, decimals: number, maxFraction = decimals): string {
  const negative = raw < 0n;
  const digits = (negative ? -raw : raw).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits
    .slice(digits.length - decimals)
    .slice(0, Math.max(0, maxFraction))
    .replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/** Thousands separators on the whole part only. */
export function groupDigits(text: string): string {
  const [whole = '0', fraction] = text.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

/** Compact display: 1234567 -> "1.23M". For labels only, never for inputs. */
export function compactUnits(raw: bigint, decimals: number): string {
  const value = Number(formatUnits(raw, decimals, 6));
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(2)}K`;
  if (abs >= 1) return value.toFixed(2);
  if (abs === 0) return '0';
  return value.toPrecision(3);
}

/**
 * `part` as a percentage of `whole`, for display: "12.5", "0.03". It is cut
 * off, never rounded up, so it cannot overstate. A share that is real but
 * smaller than the last place shown reads "<0.01" and not "0".
 */
export function percentOf(part: bigint, whole: bigint, places = 2): string {
  if (whole <= 0n || part <= 0n) return '0';
  const scaled = (part * 100n * 10n ** BigInt(places)) / whole;
  if (scaled === 0n) return `<${formatUnits(1n, places)}`;
  return formatUnits(scaled, places);
}

/** floor(amount * bps / 10_000). */
export function mulBps(amount: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0) throw new AmountError('Basis points must be a non-negative integer.');
  return (amount * BigInt(bps)) / 10_000n;
}

/** Lower bound after slippage: floor(amount * (10_000 - bps) / 10_000). */
export function minusBps(amount: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new AmountError('Slippage is out of range.');
  return (amount * BigInt(10_000 - bps)) / 10_000n;
}

/** Upper bound after slippage: ceil(amount * (10_000 + bps) / 10_000). */
export function plusBps(amount: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new AmountError('Slippage is out of range.');
  const numerator = amount * BigInt(10_000 + bps);
  return (numerator + 9_999n) / 10_000n;
}

export function assertU64(value: bigint, label: string): bigint {
  if (value < 0n || value > U64_MAX) throw new AmountError(`${label} is outside the u64 range.`);
  return value;
}

export function boundedSlippageBps(requested: unknown, max: number, fallback: number): number {
  const value = requested === undefined || requested === null || requested === '' ? fallback : Number(requested);
  if (!Number.isInteger(value) || value < 1) throw new AmountError('Slippage must be a whole number of basis points, at least 1.');
  if (value > max) throw new AmountError(`Slippage is capped at ${max / 100}%.`);
  return value;
}
