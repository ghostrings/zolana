/**
 * Arrival alerts: the light half, which every page loads.
 *
 * It decides WHEN to look and nothing else. With alerts off for the wallet in
 * use, which is how it starts for everyone, it does nothing at all: no timer,
 * no request, no SDK. With them on it loads the working half
 * (`alerts-run.ts`) and has it read the wallet's private history about every
 * minute and a half while the tab is in view, and every four minutes while
 * it is in the background.
 *
 * Looking is a read by the wallet's own keys, through the same relay every
 * wallet read uses. Nothing is registered anywhere, and nobody is told that
 * a wallet is being watched.
 */

import { alertSettings } from './alert-settings.js';
import { onWalletAnnounced, pageBusy } from './session-bus.js';
import { activeAddress } from './vault.js';

const FIRST_LOOK_MS = 8_000;
const IN_VIEW_MS = 90_000;
const IN_BACKGROUND_MS = 240_000;
const BUSY_RETRY_MS = 15_000;

type Runner = typeof import('./alerts-run.js');

let started = false;
let timer: number | undefined;
let looking = false;
let runner: Promise<Runner> | undefined;

function schedule(ms: number): void {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void look(), ms);
}

async function look(): Promise<void> {
  const address = activeAddress();
  const settings = address ? alertSettings(address) : null;
  // Nothing to watch: the next change of wallet or of the setting starts it again.
  if (!address || !settings?.on) return;
  if (looking || pageBusy()) {
    schedule(BUSY_RETRY_MS);
    return;
  }
  looking = true;
  try {
    runner ??= import('./alerts-run.js');
    await (await runner).look(address, settings);
  } catch {
    // A look that failed is simply tried again at the next turn.
    runner = undefined;
  } finally {
    looking = false;
    schedule(document.hidden ? IN_BACKGROUND_MS : IN_VIEW_MS);
  }
}

/** Called once by the page shell. */
export function startAlerts(): void {
  if (started) return;
  started = true;
  schedule(FIRST_LOOK_MS);
  // A wallet was unlocked, locked or switched: look soon, for whichever is in use now.
  onWalletAnnounced(() => {
    // Locked: the working half lets go of the keys it was reading with.
    if (!activeAddress()) void runner?.then((run) => run.forget()).catch(() => undefined);
    schedule(FIRST_LOOK_MS);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    void runner?.then((run) => run.showPending()).catch(() => undefined);
    schedule(2_000);
  });
}

/** The setting was changed on the wallet page: act on it now. */
export function alertsChanged(): void {
  schedule(1_000);
}
