/**
 * What a trade can be paid with, or paid out in, besides the token's own pair
 * token. Pure: it reads the server's status and nothing else.
 */

import type { PairRef, StatusResponse } from '../../shared/src/api.js';

/**
 * The choices for one token: its pair token first, then SOL and USDC when
 * this site converts. A token priced in SOL offers SOL and USDC; one priced
 * in ZEC offers ZEC, SOL and USDC.
 */
export function counterOptions(status: StatusResponse | null, pair: PairRef): PairRef[] {
  const options: PairRef[] = [pair];
  if (!status?.convert?.enabled) return options;
  for (const asset of status.convert.assets) {
    if (!options.some((option) => option.mint === asset.mint)) options.push(asset);
  }
  return options;
}

/** The chosen one of those, by id. Anything that is not on offer is the pair token itself. */
export function counterOf(status: StatusResponse | null, pair: PairRef, id: string): PairRef {
  return counterOptions(status, pair).find((option) => option.id === id) ?? pair;
}

/** Round amounts of USDC for the quick buttons when the site has no rate for it. */
export const USDC_QUICK_AMOUNTS: readonly string[] = Object.freeze(['10', '50', '100']);
