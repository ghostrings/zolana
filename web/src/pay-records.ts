/**
 * Where a payout run is kept while it is under way: in this browser, under
 * the paying wallet's address, and nowhere else. It holds the list (who is
 * paid how much, and the notes) and each payment's signature, so that a run
 * interrupted by a closed tab or a lost connection can be picked up without
 * paying anybody twice.
 *
 * Unlike the other records of `local-records.ts`, a run that cannot be kept
 * is not a convenience lost: `keepPayRun` says so, and the page sends nothing
 * it could not first write down.
 */

import { type PayRun, parseRun } from '../../shared/src/paymany.js';
import { PAYRUN_PREFIX } from './local-records.js';
import { storage } from './vault.js';

export function readPayRun(address: string): PayRun | null {
  try {
    return parseRun(storage('local')?.getItem(PAYRUN_PREFIX + address), address);
  } catch {
    return null;
  }
}

/** True only when the run is in storage exactly as given: it is read back and compared. */
export function keepPayRun(run: PayRun): boolean {
  try {
    const local = storage('local');
    if (!local) return false;
    const text = JSON.stringify(run);
    local.setItem(PAYRUN_PREFIX + run.wallet, text);
    return local.getItem(PAYRUN_PREFIX + run.wallet) === text;
  } catch {
    return false;
  }
}

export function dropPayRun(address: string): void {
  try {
    storage('local')?.removeItem(PAYRUN_PREFIX + address);
  } catch {
    // Nothing to do: a run that cannot be removed is shown again, with everything that was paid.
  }
}
