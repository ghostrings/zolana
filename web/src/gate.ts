/**
 * The inline wallet gate: shown wherever an action needs an unlocked wallet.
 * An existing ghost wallet is unlocked in place; anything else goes to the
 * wallet page and comes back.
 */

import { paintIdentity } from './shell.js';
import { describeError, escapeHtml, short } from './ui.js';
import { lastUsedWallet, walletCount } from './vault.js';
import { type Session, getSession, hasVault, unlockGhostWallet } from './wallet.js';

export interface GateOptions {
  /** Why a wallet is needed, in a few words: "to launch", "to trade". */
  readonly purpose: string;
  onReady(session: Session): void;
}

/** Path to the wallet page that returns here afterwards. */
export function walletHref(): string {
  return `/wallet?next=${encodeURIComponent(location.pathname + location.search)}`;
}

/**
 * Renders the gate into `container` when no wallet is unlocked and returns
 * null; returns the session (and renders nothing) when one is.
 */
export async function ensureWallet(container: HTMLElement, options: GateOptions): Promise<Session | null> {
  let session: Session | null = null;
  try {
    session = await getSession();
  } catch (error) {
    container.innerHTML = `<div class="status error"><b>WALLET UNAVAILABLE</b><br>${escapeHtml(describeError(error))}</div>`;
    return null;
  }
  if (session) {
    container.innerHTML = '';
    return session;
  }
  if (!hasVault()) {
    container.innerHTML = `<div class="gate"><h3>You need a wallet ${escapeHtml(options.purpose)}.</h3><p>A ghost wallet is made in this browser and encrypted with your passphrase. It takes a few seconds, and the keys never leave this device.</p><div class="gate-actions"><a class="btn" href="${escapeHtml(walletHref())}">Open a ghost wallet</a><a class="btn secondary" href="${escapeHtml(walletHref())}#external">Connect a wallet</a></div></div>`;
    return null;
  }
  // The wallet that was in use last is the one the passphrase opens.
  const wallet = lastUsedWallet();
  const which = wallet ? `${walletCount() > 1 ? `${wallet.name} · ` : ''}${short(wallet.address, 6, 6)}` : '';
  // Not a form of its own. On most pages the gate sits inside the page's own form, and a form written inside
  // another one is dropped by the browser: its fields stay, the form does not, and the button then submits the
  // page's form instead. So the gate is a plain box, and Unlock and Enter are handled here and go no further.
  container.innerHTML = `<div class="gate" data-gate-form><h3>Unlock your ghost wallet ${escapeHtml(options.purpose)}.</h3><p>${escapeHtml(which)}</p><div class="inline-form"><label class="field" style="margin:0"><span>Passphrase</span><input type="password" name="passphrase" placeholder=" " autocomplete="current-password" minlength="8"></label><button class="btn" type="button" data-gate-unlock>Unlock</button></div><div data-gate-error aria-live="polite"></div></div>`;
  const button = container.querySelector<HTMLButtonElement>('[data-gate-unlock]');
  const input = container.querySelector<HTMLInputElement>('input[name=passphrase]');
  const errorBox = container.querySelector<HTMLElement>('[data-gate-error]');
  if (!button || !input) return null;
  let working = false;
  const unlock = async (): Promise<void> => {
    if (working) return;
    working = true;
    button.disabled = true;
    button.textContent = 'Unlocking…';
    try {
      const unlocked = await unlockGhostWallet(input.value);
      input.value = '';
      container.innerHTML = '';
      // The header shows the wallet that is now open.
      paintIdentity();
      options.onReady(unlocked);
    } catch (error) {
      if (errorBox) errorBox.innerHTML = `<div class="status error">${escapeHtml(describeError(error))}</div>`;
      button.disabled = false;
      button.textContent = 'Unlock';
      working = false;
    }
  };
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    void unlock();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    // Enter in a field submits the form the field is in. Here it unlocks, and the page's own form is left alone.
    event.preventDefault();
    event.stopPropagation();
    void unlock();
  });
  return null;
}
