/** Public constant-product pricing reference. No accounts, signing, proofs or settlement. */
export const U64_MAX = (1n << 64n) - 1n;
const BPS = 10_000n;
function u64(name, value, positive = false) {
  if (typeof value !== 'bigint' || value < (positive ? 1n : 0n) || value > U64_MAX) {
    throw new RangeError(`${name} must be a ${positive ? 'positive ' : ''}u64 bigint`);
  }
  return value;
}
function add(a, b, name) { return u64(name, a + b); }
/** Exact-input public price, fee retained in input reserve. Virtual offsets are not spendable. */
export function quoteExactIn({ reserveIn, reserveOut, virtualIn = 0n, virtualOut = 0n, amountIn, feeBps = 0n, minimumOut = 1n }) {
  u64('reserveIn', reserveIn); u64('reserveOut', reserveOut, true);
  u64('virtualIn', virtualIn); u64('virtualOut', virtualOut);
  u64('amountIn', amountIn, true); u64('minimumOut', minimumOut, true);
  u64('feeBps', feeBps);
  if (feeBps >= BPS) throw new RangeError('feeBps must be below 10000');
  const x = add(reserveIn, virtualIn, 'effective reserveIn');
  const y = add(reserveOut, virtualOut, 'effective reserveOut');
  if (x === 0n) throw new RangeError('effective reserveIn must be positive');
  const fee = (amountIn * feeBps + BPS - 1n) / BPS;
  const net = amountIn - fee;
  if (net === 0n) throw new RangeError('fee consumes entire input');
  const denominator = add(x, net, 'effective input plus net');
  const amountOut = y * net / denominator;
  if (amountOut === 0n || amountOut < minimumOut) throw new RangeError('minimum output not met');
  // Keep a strictly positive real reserve. Launch graduation is a separate state transition.
  if (amountOut >= reserveOut) throw new RangeError('insufficient real output reserve');
  const nextReserveIn = add(reserveIn, amountIn, 'next reserveIn');
  const nextReserveOut = reserveOut - amountOut;
  const nextX = add(nextReserveIn, virtualIn, 'next effective reserveIn');
  const nextY = add(nextReserveOut, virtualOut, 'next effective reserveOut');
  if (nextX * nextY < x * y) throw new Error('invariant violation');
  return Object.freeze({ amountIn, fee, net, amountOut, nextReserveIn, nextReserveOut });
}
