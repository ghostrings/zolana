import { SOL_DECIMALS, TOKEN_DECIMALS } from '../../shared/src/constants.js';
import { compactUnits, formatUnits, groupDigits } from '../../shared/src/units.js';

export function sol(lamports: bigint | string, maxFraction = 4): string {
  return groupDigits(formatUnits(BigInt(lamports), SOL_DECIMALS, maxFraction));
}

export function tokens(units: bigint | string, maxFraction = 2): string {
  return groupDigits(formatUnits(BigInt(units), TOKEN_DECIMALS, maxFraction));
}

export function compactSol(lamports: bigint | string): string {
  return compactUnits(BigInt(lamports), SOL_DECIMALS);
}

export function compactTokens(units: bigint | string): string {
  return compactUnits(BigInt(units), TOKEN_DECIMALS);
}

/**
 * A decimal string (a price or a market cap, in whatever pair token it is in),
 * trimmed for display. Never uses exponent notation.
 */
export function decimalText(value: string, significant = 4): string {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return '0';
  if (number >= 1000) return groupDigits(number.toFixed(0));
  if (number >= 1) return number.toFixed(2);
  // 0.0000000512 stays 0.0000000512: enough places for `significant` digits after the leading zeros.
  const places = Math.min(18, Math.ceil(-Math.log10(number)) + significant - 1);
  return number.toFixed(places).replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * Market cap in the token's pair token: the price times every token that
 * exists now, as a decimal string for `decimalText`. For display only; nothing
 * is traded on it.
 */
export function marketCapText(price: string, supplyUnits: bigint): string {
  const value = Number(price) * (Number(supplyUnits) / 10 ** TOKEN_DECIMALS);
  return Number.isFinite(value) && value > 0 ? value.toFixed(12) : '0';
}

/**
 * A very small price the way trading screens write it: 0.0000000283 is
 * "0.0", then how many zeros follow the point (7), then "283". Null for a
 * price with fewer than four such zeros, which is short enough written out.
 */
export function smallPrice(value: string, significant = 4): { readonly zeros: number; readonly digits: string } | null {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number >= 0.0001) return null;
  const [mantissa, exponent] = number.toExponential(Math.max(1, significant) - 1).split('e');
  const zeros = -Number(exponent) - 1;
  const digits = (mantissa ?? '').replace('.', '').replace(/0+$/, '');
  return digits && Number.isInteger(zeros) && zeros >= 4 ? { zeros, digits } : null;
}

const SHORT_STEPS = [
  ['K', 1e3, 1],
  ['M', 1e6, 2],
  ['B', 1e9, 2],
  ['T', 1e12, 2],
] as const;

/**
 * A large amount cut short for a narrow place: 12,345 is "12.3K", 1,234,567
 * is "1.23M". The unit is chosen after rounding, so 999,960 is "1.00M" and
 * never "1000.0K". Below a thousand, and for what is not an amount, null:
 * the caller writes the number out.
 */
export function shortAmount(value: number): string | null {
  if (!Number.isFinite(value) || value < 1000) return null;
  for (const [letter, size, places] of SHORT_STEPS) {
    const text = (value / size).toFixed(places);
    if (Number(text) < 1000 || letter === 'T') return `${text}${letter}`;
  }
  return null;
}

export function percent(fraction: number, digits = 1): string {
  return `${(Math.max(0, Math.min(1, fraction)) * 100).toFixed(digits)}%`;
}

export function feeLabel(feeBps: number): string {
  return `${feeBps / 100}%`;
}

/** Explorer links are mainnet links. The second argument is accepted and ignored; there is no other network. */
export function explorerTx(signature: string, _network?: 'mainnet'): string {
  return `https://orbmarkets.io/tx/${encodeURIComponent(signature)}`;
}

export function explorerAddress(address: string, _network?: 'mainnet'): string {
  return `https://orbmarkets.io/address/${encodeURIComponent(address)}`;
}
