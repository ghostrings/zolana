/**
 * Trading volume, worked out from the fees a token's pools have taken.
 *
 * A token's fee is one rate for its whole life, on the curve and in the pool
 * it graduates to, and it is always taken in the pair token: on a buy from
 * what the buyer pays in, on a sell from what the seller is paid out. So the
 * fees collected over any stretch of time, divided by that rate, are what was
 * traded in that stretch, in the pair token and before the fee.
 *
 * Over a token's whole life the fees are a figure the pools themselves keep
 * on chain, so the volume since launch needs no history of this server's own:
 * it is right from the first time a token is read, however late that is.
 */

const BPS = 10_000n;

/**
 * What was traded for `fees` to have been collected at `feeBps`, in the same
 * base units as the fees. Zero when there are no fees, and zero for a rate
 * that is not a whole number of basis points above nothing: no token here
 * has one, and a volume is never made up.
 */
export function volumeFromFees(fees: bigint, feeBps: number): bigint {
  if (fees <= 0n || !Number.isInteger(feeBps) || feeBps <= 0) return 0n;
  return (fees * BPS) / BigInt(feeBps);
}

/** The same for a figure that is not in base units: fees counted in SOL terms, as a plain number. */
export function volumeFromFeesNumber(fees: number, feeBps: number): number {
  if (!Number.isFinite(fees) || fees <= 0 || !Number.isInteger(feeBps) || feeBps <= 0) return 0;
  return (fees * 10_000) / feeBps;
}

/** Base units held as text in the database or on the wire. Anything that is not a whole number counts as nothing. */
export function unitsOf(text: string | null | undefined): bigint {
  return typeof text === 'string' && /^\d{1,60}$/.test(text) ? BigInt(text) : 0n;
}
