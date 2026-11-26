/**
 * How the header's wallet panel and the page under it keep in step.
 *
 * Both can unlock a wallet, lock it or switch to another one. A page that
 * works with the wallet says so here: whether it is in the middle of
 * something that must not be interrupted, and what to do when the wallet
 * changed without it. The panel asks before it changes anything, and tells
 * the page afterwards.
 *
 * Nothing here loads an SDK: every page includes it.
 */

export type WalletChange = 'unlock' | 'lock' | 'switch';

export interface WalletWatcher {
  /** True while the page is sending something, or is otherwise not to be interrupted. */
  busy(): boolean;
  /** The wallet in use changed from outside the page. The page brings itself up to date, or loads again. */
  changed(change: WalletChange): void | Promise<void>;
}

let watcher: WalletWatcher | null = null;

/** Called once by a page that works with the wallet. */
export function watchWallet(next: WalletWatcher): void {
  watcher = next;
}

/** True when the page under the panel works with the wallet itself. */
export function pageUsesWallet(): boolean {
  return watcher !== null;
}

/** True while the page must not have the wallet changed under it. A page that fails to answer counts as busy. */
export function pageBusy(): boolean {
  if (!watcher) return false;
  try {
    return watcher.busy() === true;
  } catch {
    return true;
  }
}

/** Tells the page that the wallet in use changed. */
export async function tellPage(change: WalletChange): Promise<void> {
  await watcher?.changed(change);
}

const ANNOUNCED = 'pcf:wallet';

/** The wallet in use, its name or its icon changed: whatever shows them draws itself again. */
export function announceWallet(): void {
  document.dispatchEvent(new CustomEvent(ANNOUNCED));
}

export function onWalletAnnounced(handler: () => void): void {
  document.addEventListener(ANNOUNCED, handler);
}
