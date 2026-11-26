/**
 * Whether arrival alerts are on for a wallet in this browser. Its own small
 * file, with nothing of any SDK in it, because the page shell reads it on
 * every page to decide whether there is anything to watch at all.
 */

import { storage } from './vault.js';

export const ALERTS_PREFIX = 'pcf.alerts.v1.';

export interface AlertSettings {
  /** Whether arrivals are announced for this wallet in this browser. Off until somebody turns it on. */
  readonly on: boolean;
  /** Whether an arrival is also shown as a system notification while the tab is in the background. */
  readonly system: boolean;
}

export function alertSettings(address: string): AlertSettings {
  try {
    const parsed = JSON.parse(storage('local')?.getItem(ALERTS_PREFIX + address) ?? 'null') as Partial<AlertSettings> | null;
    return { on: parsed?.on === true, system: parsed?.system === true };
  } catch {
    return { on: false, system: false };
  }
}

/** Returns false when this browser would not keep the choice. */
export function setAlertSettings(address: string, settings: AlertSettings): boolean {
  try {
    const local = storage('local');
    if (!local) return false;
    local.setItem(ALERTS_PREFIX + address, JSON.stringify({ on: settings.on, system: settings.system }));
    return true;
  } catch {
    return false;
  }
}
