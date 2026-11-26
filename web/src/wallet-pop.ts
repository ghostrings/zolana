/**
 * The wallet as a panel that opens from the header on every page: what a
 * wallet extension's pop-up is to a browser.
 *
 * From it a wallet is unlocked, locked and switched, its address copied or
 * shown as a QR code, and what it holds is read. It sends nothing: Shield,
 * Unshield and Send lead to the forms on the wallet page, which is the one
 * place a transfer is built and signed.
 *
 * This file is the frame and loads no SDK. What needs the keys is in
 * `wallet-pop-data.ts`, fetched when the panel first has a wallet to work
 * with, so the market, protocol and docs pages stay as light as they were.
 */

import { type IconName, icon } from './icons.js';
import { onWalletAnnounced, pageBusy, pageUsesWallet, tellPage } from './session-bus.js';
import { deterministicAvatar, escapeHtml, short, toast, tokenArt } from './ui.js';
import { activeAddress, activeWallet, hasVault, isUnlocked, lastUsedWallet, lockSession, readBook, walletCount } from './vault.js';
import { iconSvg } from './wallet-icons.js';
import type { PopAsset, PopEvent, PopPrivate, PopPublic } from './wallet-pop-data.js';

type Mode = 'none' | 'locked' | 'open';
type Heavy = typeof import('./wallet-pop-data.js');

const BUSY_NOTE = 'This page is in the middle of something. Wait for it to finish, then try again.';

let panel: HTMLElement | null = null;
let veil: HTMLElement | null = null;
let pill: HTMLAnchorElement | null = null;
let repaint: () => void = () => undefined;
/** Goes up whenever what the panel shows is no longer about the wallet in use: late answers are then dropped. */
let round = 0;
/** What the panel was last drawn for, so a repaint that changes nothing redraws nothing. */
let drawnFor = '';
let heavy: Heavy | null = null;
let tab: 'tokens' | 'activity' = 'tokens';
/** What was last read for a wallet. Kept while the panel is closed, so it does not open empty. */
interface Kept {
  readonly address: string;
  open: PopPublic | null;
  hidden: PopPrivate | null;
  /** Why the private balance is not shown, when it could not be read. */
  problem: string | null;
}
let kept: Kept | null = null;
/** True while this panel itself is changing the wallet, so it does not answer its own announcement halfway through. */
let changing = false;

const isOpen = (): boolean => panel !== null && !panel.hidden;
const mode = (): Mode => (isUnlocked() ? 'open' : hasVault() ? 'locked' : 'none');
const pause = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));

async function load(): Promise<Heavy> {
  heavy ??= await import('./wallet-pop-data.js');
  return heavy;
}

/** The address a page link should carry, so the wallet page comes back to where the visitor was. */
function walletHref(hash = ''): string {
  return `/wallet${hash}`;
}

function scene(caption: string): string {
  return `<div class="unlock-scene is-small" aria-hidden="true"><div class="unlock-rings"><i></i><i></i><i></i></div><div class="unlock-ghost"><span class="ghost-mark"></span></div><span class="unlock-caption">${caption}</span></div>`;
}

const closeCorner = `<button class="icon-btn wp-close-corner" type="button" data-wp-close aria-label="Close">${icon('close')}</button>`;

/* ---------------- The three faces ---------------- */

function noneHtml(): string {
  return `${closeCorner}<div class="wp-scroll"><div class="wp-gate">${scene('MADE IN THIS BROWSER')}<h2>Open a ghost wallet.</h2><p>A Solana wallet made in this browser and encrypted with your passphrase. No extension, no sign-up, and the keys never leave this device.</p><a class="btn wide" href="${walletHref()}">Open a ghost wallet</a><a class="btn secondary wide" href="${walletHref('#external')}">Connect a wallet extension</a></div></div>`;
}

function lockedHtml(): string {
  const last = lastUsedWallet();
  const count = walletCount();
  const which = last ? `<b>${escapeHtml(last.name)}</b> ${escapeHtml(short(last.address, 6, 6))}${count > 1 ? `, one of ${count} wallets` : ''}` : '';
  return `${closeCorner}<div class="wp-scroll"><div class="unlock-stage wp-stage" data-wp-stage><form class="wp-gate unlock-panel" data-wp-unlock novalidate>${scene('ENCRYPTED IN THIS BROWSER')}<h2>Welcome back.</h2><p>${which}</p><label class="field"><span>Passphrase</span><input type="password" name="passphrase" placeholder=" " autocomplete="current-password" minlength="8" required></label><button class="btn wide" type="submit">Unlock</button><div data-wp-error aria-live="polite"></div><a class="wp-more" href="${walletHref()}">Open the wallet page</a></form></div></div>`;
}

function actionLink(hash: string, glyph: IconName, label: string): string {
  return `<a class="wact" href="${walletHref(hash)}"><i>${icon(glyph)}</i>${label}</a>`;
}

function openHtml(): string {
  const wallet = activeWallet();
  const address = activeAddress() ?? '';
  const name = wallet ? wallet.name : 'Wallet extension';
  const mark = wallet ? iconSvg(wallet.icon, wallet.name, deterministicAvatar(wallet.address)) : deterministicAvatar(address);
  // Only a ghost wallet has a list to switch through.
  const others = wallet ? (readBook()?.wallets.filter((entry) => entry.hidden !== true) ?? []) : [];
  const who = `<span class="wallet-icon is-small">${mark}</span><span><b>${escapeHtml(name)}</b><small>${escapeHtml(short(address, 4, 4))}</small></span>`;
  const head =
    others.length > 1
      ? `<button class="wp-who" type="button" data-wp-switch aria-expanded="false" aria-controls="wp-wallets" title="Switch wallet">${who}${icon('chevron')}</button>`
      : `<div class="wp-who">${who}</div>`;
  const list = others
    .map(
      (entry) =>
        `<button type="button" data-wp-use="${escapeHtml(entry.address)}" ${entry.address === address ? 'aria-current="true"' : ''}><span class="wallet-icon is-small">${iconSvg(entry.icon, entry.name, deterministicAvatar(entry.address))}</span>${escapeHtml(entry.name)}<small>${escapeHtml(short(entry.address, 4, 4))}</small></button>`,
    )
    .join('');
  return `<header class="wp-head">${head}<div class="wp-tools"><button class="icon-btn" type="button" data-wp-copy aria-label="Copy address" title="Copy address">${icon('copy')}</button><a class="icon-btn" href="${walletHref()}" aria-label="Open the full wallet" title="Open the full wallet">${icon('expand')}</a><button class="icon-btn" type="button" data-wp-close aria-label="Close" title="Close">${icon('close')}</button></div></header>
  <div class="wp-scroll">
  <div class="wp-wallets" id="wp-wallets" hidden>${list}<a href="${walletHref('#wallets')}">${icon('plus')}New wallet, import, rename</a></div>
  <section class="wp-balance"><span><span class="ghost-mark" aria-hidden="true"></span>Private balance</span><b class="is-waiting" data-wp-private>Reading…</b><small>Public <span data-wp-public>—</span></small><button class="icon-btn wp-refresh" type="button" data-wp-refresh aria-label="Read again" title="Read again">${icon('refresh')}</button></section>
  <nav class="wallet-actions" aria-label="Wallet actions">${actionLink('#shield', 'shield', 'Shield')}${actionLink('#unshield', 'unshield', 'Unshield')}${actionLink('#send', 'send', 'Send')}<button class="wact" type="button" data-wp-receive aria-expanded="false"><i>${icon('receive')}</i>Receive</button></nav>
  <div class="wp-receive" data-wp-receive-box hidden></div>
  <div class="wtabs" role="tablist" aria-label="What this wallet holds"><button type="button" role="tab" data-wp-tab="tokens" aria-selected="${tab === 'tokens'}">Tokens</button><button type="button" role="tab" data-wp-tab="activity" aria-selected="${tab === 'activity'}">Activity</button></div>
  <div class="wp-list" data-wp-pane="tokens" ${tab === 'tokens' ? '' : 'hidden'}></div>
  <div class="wp-list" data-wp-pane="activity" ${tab === 'activity' ? '' : 'hidden'}></div>
  </div>
  <footer class="wp-foot"><a href="/prvmax">${icon('layers')}prvmax vaults</a><button type="button" data-wp-lock>${icon('lock')}${wallet ? 'Lock' : 'Disconnect'}</button></footer>`;
}

/* ---------------- What the wallet holds ---------------- */

function assetRow(entry: PopAsset, where: 'private' | 'public'): string {
  const art = entry.listed ? tokenArt({ image: entry.image, symbol: entry.symbol, mint: entry.mint }) : deterministicAvatar(entry.symbol);
  const inner = `<div class="token-avatar">${art}</div><div><b>${escapeHtml(entry.label)}</b><small>${escapeHtml(entry.name)}</small></div><div class="wp-amount"><b>${escapeHtml(entry.amount)}</b><span class="wp-chip is-${where}">${where}</span></div>`;
  return entry.listed ? `<a class="wp-row" href="/token?mint=${encodeURIComponent(entry.mint)}">${inner}</a>` : `<div class="wp-row">${inner}</div>`;
}

function eventRow(entry: PopEvent): string {
  const glyph: IconName = entry.direction === 'in' ? 'receive' : entry.direction === 'out' ? 'send' : 'swap';
  const sign = entry.direction === 'in' ? '+' : entry.direction === 'out' ? '−' : '';
  return `<div class="wp-row"><span class="wp-glyph">${icon(glyph)}</span><div><b>${escapeHtml(entry.title)}</b><small>${escapeHtml(entry.label)}, amount ${entry.open ? 'public' : 'encrypted'}</small></div><div class="wp-amount"><b>${sign}${escapeHtml(entry.amount)}</b></div></div>`;
}

const solAsset = (amount: string): PopAsset => ({ mint: 'SOL', label: 'SOL', name: 'Solana', image: '', symbol: 'SOL', amount, listed: false });

/** Writes whatever has been read so far into the open panel. */
function paintData(): void {
  if (!panel || mode() !== 'open') return;
  const balance = panel.querySelector<HTMLElement>('[data-wp-private]');
  const open = panel.querySelector<HTMLElement>('[data-wp-public]');
  const tokens = panel.querySelector<HTMLElement>('[data-wp-pane="tokens"]');
  const activity = panel.querySelector<HTMLElement>('[data-wp-pane="activity"]');
  if (!balance || !open || !tokens || !activity) return;
  const data = kept && kept.address === activeAddress() ? kept : null;
  if (data?.hidden) {
    balance.classList.remove('is-waiting');
    balance.innerHTML = `${escapeHtml(data.hidden.sol)} <i>SOL</i>`;
  } else {
    balance.classList.add('is-waiting');
    balance.textContent = data?.problem ? 'Not read' : 'Reading…';
  }
  open.textContent = data?.open ? `${data.open.sol} SOL` : '—';

  const rows: string[] = [];
  if (data?.hidden) {
    rows.push(assetRow(solAsset(data.hidden.sol), 'private'));
    for (const entry of data.hidden.assets) rows.push(assetRow(entry, 'private'));
  }
  if (data?.open) {
    rows.push(assetRow(solAsset(data.open.sol), 'public'));
    for (const entry of data.open.assets) rows.push(assetRow(entry, 'public'));
  }
  const problem = data?.problem
    ? `<p class="wp-note"><b>The private balance could not be read.</b>${escapeHtml(data.problem)} Nothing has been lost: it is on chain under your keys.<br><button class="btn flat" type="button" data-wp-refresh>Try again</button></p>`
    : '';
  tokens.innerHTML = rows.length > 0 ? `${rows.join('')}${problem}` : problem || '<p class="wp-note">Reading the chain…</p>';
  activity.innerHTML = data?.hidden
    ? data.hidden.events.length > 0
      ? `${data.hidden.events.map(eventRow).join('')}<p class="wp-note"><a class="tx-link" href="${walletHref('#activity')}">All private history</a></p>`
      : `<p class="wp-note"><b>No private activity yet.</b>Shield some SOL and it shows here, decrypted in this browser.</p>`
    : problem || '<p class="wp-note">Reading encrypted notes…</p>';
}

/** Reads the wallet in use from chain: what is public first, then what only its keys can open. */
async function read(): Promise<void> {
  const address = activeAddress();
  if (!panel || !address || mode() !== 'open') return;
  const mine = ++round;
  if (!kept || kept.address !== address) kept = { address, open: null, hidden: null, problem: null };
  else kept = { ...kept, problem: null };
  const fresh = kept;
  panel.querySelector('[data-wp-refresh]')?.classList.add('is-turning');
  // Figures from the last read stay up, dimmed, until the new ones arrive.
  panel.querySelector('[data-wp-private]')?.classList.toggle('is-stale', fresh.hidden !== null);
  paintData();
  const still = (): boolean => mine === round && kept === fresh;
  try {
    const data = await load();
    if (!still()) return;
    const publicRead = data
      .readPublic(address)
      .then((result) => {
        if (!still()) return;
        fresh.open = result;
        paintData();
      })
      .catch(() => undefined);
    try {
      // A page that works with the wallet saves its own notes; anywhere else this read may save them for next time.
      fresh.hidden = await data.readPrivate(address, !pageUsesWallet());
    } catch (error) {
      if (!still()) return;
      fresh.problem = data.explain(error);
    }
    await publicRead;
  } catch {
    if (!still()) return;
    fresh.problem = 'The wallet could not be loaded. Check your connection.';
  }
  if (!still()) return;
  panel.querySelector('[data-wp-refresh]')?.classList.remove('is-turning');
  panel.querySelector('[data-wp-private]')?.classList.remove('is-stale');
  paintData();
}

/* ---------------- Drawing ---------------- */

function signature(): string {
  const wallet = activeWallet();
  return JSON.stringify([mode(), activeAddress(), wallet?.name, wallet?.icon, readBook()?.wallets.map((entry) => [entry.address, entry.name, entry.icon, entry.hidden === true])]);
}

function render(): void {
  if (!panel) return;
  drawnFor = signature();
  const now = mode();
  panel.innerHTML = now === 'open' ? openHtml() : now === 'locked' ? lockedHtml() : noneHtml();
  if (now === 'open') paintData();
}

/** On a phone the panel is a sheet over the page, and the page under it holds still. */
function holdPage(held: boolean): void {
  document.body.classList.toggle('wp-held', held && matchMedia('(max-width: 600px)').matches);
}

function open(): void {
  build();
  if (!panel || !veil) return;
  panel.hidden = false;
  veil.hidden = false;
  holdPage(true);
  pill?.setAttribute('aria-expanded', 'true');
  render();
  if (mode() === 'open') void read();
  // The passphrase field takes the keys at once; otherwise the panel itself does, so Escape and Tab work from inside it.
  const field = panel.querySelector<HTMLInputElement>('input[name="passphrase"]');
  if (field && !matchMedia('(max-width: 600px)').matches) field.focus();
  else panel.focus();
}

function close(returnFocus = true): void {
  if (!panel || !veil || panel.hidden) return;
  panel.hidden = true;
  veil.hidden = true;
  holdPage(false);
  pill?.setAttribute('aria-expanded', 'false');
  // Anything typed into the passphrase field goes with the panel.
  panel.innerHTML = '';
  round += 1;
  if (returnFocus) pill?.focus();
}

/* ---------------- What the panel does ---------------- */

async function unlock(form: HTMLFormElement): Promise<void> {
  const input = form.querySelector<HTMLInputElement>('input[name="passphrase"]');
  const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  const errorBox = form.querySelector<HTMLElement>('[data-wp-error]');
  const stage = panel?.querySelector<HTMLElement>('[data-wp-stage]');
  if (!input || !button || !errorBox || !stage || changing) return;
  const fail = (message: string): void => {
    errorBox.innerHTML = `<div class="status error">${escapeHtml(message)}</div>`;
  };
  if (pageBusy()) return fail(BUSY_NOTE);
  if (input.value.length < 8) return fail('A passphrase has at least 8 characters.');
  changing = true;
  button.disabled = true;
  button.textContent = 'Decrypting…';
  errorBox.innerHTML = '';
  stage.classList.remove('is-denied', 'is-open');
  stage.classList.add('is-unlocking');
  const started = performance.now();
  try {
    const data = await load();
    await data.unlock(input.value);
    input.value = '';
    // The scene is given long enough to be seen, never much longer than the work itself took.
    await pause(Math.max(0, 500 - (performance.now() - started)));
    stage.classList.add('is-open');
    await pause(380);
    repaint();
    await tellPage('unlock');
    if (isOpen()) {
      render();
      void read();
    }
  } catch (error) {
    stage.classList.remove('is-unlocking');
    stage.classList.add('is-denied');
    window.setTimeout(() => stage.classList.remove('is-denied'), 450);
    fail(heavy ? heavy.explain(error) : 'The wallet could not be loaded. Check your connection.');
    button.disabled = false;
    button.textContent = 'Unlock';
  } finally {
    changing = false;
  }
}

async function lockWallet(): Promise<void> {
  if (changing) return;
  if (pageBusy()) return toast(BUSY_NOTE, 'error');
  changing = true;
  try {
    // A page that works with the wallet has the wallet's own code loaded, and that is what forgets the session there.
    if (heavy || pageUsesWallet()) (await load()).lockNow();
    else lockSession();
    kept = null;
    round += 1;
    repaint();
    toast('Wallet locked');
    await tellPage('lock');
    if (isOpen()) render();
  } catch {
    lockSession();
    repaint();
    if (isOpen()) render();
  } finally {
    changing = false;
  }
}

async function useWallet(address: string): Promise<void> {
  if (changing || address === activeAddress()) return;
  if (pageBusy()) return toast(BUSY_NOTE, 'error');
  changing = true;
  try {
    const data = await load();
    await data.switchTo(address);
    round += 1;
    repaint();
    toast('Wallet switched');
    await tellPage('switch');
    if (isOpen()) {
      render();
      void read();
    }
  } catch (error) {
    toast(heavy ? heavy.explain(error) : 'That wallet could not be opened.', 'error');
    if (isOpen()) render();
  } finally {
    changing = false;
  }
}

async function copyAddress(): Promise<void> {
  const address = activeAddress();
  if (!address) return;
  try {
    await navigator.clipboard.writeText(address);
    toast('Address copied');
  } catch {
    toast('Clipboard blocked. Use Receive to see the address.', 'error');
  }
}

async function toggleReceive(button: HTMLElement): Promise<void> {
  const box = panel?.querySelector<HTMLElement>('[data-wp-receive-box]');
  const address = activeAddress();
  if (!box || !address) return;
  const show = box.hidden;
  box.hidden = !show;
  button.setAttribute('aria-expanded', String(show));
  button.classList.toggle('on', show);
  if (!show) return;
  box.innerHTML = `<div class="qr-box" role="img" aria-label="This wallet's address as a QR code"></div><div><p>Anything sent to this address arrives in the public balance. To be sent to privately, the wallet must be registered with Rings: the wallet page says whether it is.</p><code>${escapeHtml(address)}</code><button class="btn flat" type="button" data-wp-copy>Copy address</button></div>`;
  try {
    const { qrSvg } = await import('./qr.js');
    const holder = box.querySelector('.qr-box');
    if (holder && activeAddress() === address) holder.innerHTML = qrSvg(address);
  } catch {
    // The address is there in writing all the same.
  }
}

function showTab(next: 'tokens' | 'activity'): void {
  tab = next;
  panel?.querySelectorAll<HTMLElement>('[data-wp-tab]').forEach((button) => button.setAttribute('aria-selected', String(button.dataset.wpTab === next)));
  panel?.querySelectorAll<HTMLElement>('[data-wp-pane]').forEach((pane) => {
    pane.hidden = pane.dataset.wpPane !== next;
  });
}

function onClick(event: MouseEvent): void {
  const target = event.target as HTMLElement;
  if (target.closest('[data-wp-close]')) return close();
  if (target.closest('[data-wp-copy]')) return void copyAddress();
  if (target.closest('[data-wp-lock]')) return void lockWallet();
  if (target.closest('[data-wp-refresh]')) return void read();
  const receive = target.closest<HTMLElement>('[data-wp-receive]');
  if (receive) return void toggleReceive(receive);
  const tabButton = target.closest<HTMLElement>('[data-wp-tab]');
  if (tabButton) return showTab(tabButton.dataset.wpTab === 'activity' ? 'activity' : 'tokens');
  const switcher = target.closest<HTMLElement>('[data-wp-switch]');
  if (switcher) {
    const list = panel?.querySelector<HTMLElement>('#wp-wallets');
    if (list) {
      list.hidden = !list.hidden;
      switcher.setAttribute('aria-expanded', String(!list.hidden));
    }
    return;
  }
  const use = target.closest<HTMLElement>('[data-wp-use]');
  if (use) return void useWallet(use.dataset.wpUse ?? '');
  // A link leads somewhere: the panel gets out of the way, and stays out if the link was to this same page.
  if (target.closest('a[href]')) close(false);
}

function build(): void {
  if (panel) return;
  veil = document.createElement('div');
  veil.className = 'wp-veil';
  veil.hidden = true;
  veil.addEventListener('click', () => close());
  panel = document.createElement('aside');
  panel.className = 'wp';
  panel.id = 'wallet-pop';
  panel.hidden = true;
  panel.tabIndex = -1;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Wallet');
  panel.addEventListener('click', onClick);
  panel.addEventListener('submit', (event) => {
    const form = (event.target as HTMLElement).closest<HTMLFormElement>('[data-wp-unlock]');
    if (!form) return;
    event.preventDefault();
    void unlock(form);
  });
  document.body.append(veil, panel);
}

/**
 * Wires the header's wallet button to the panel. `paint` draws the button
 * again after the wallet in use changed. Without this the button is a plain
 * link to the wallet page, which is also what a new tab or a press with a
 * modifier key still gets.
 */
export function mountWalletPop(paint: () => void): void {
  if (pill) return;
  pill = document.querySelector<HTMLAnchorElement>('[data-identity]');
  if (!pill) return;
  repaint = paint;
  pill.setAttribute('role', 'button');
  pill.setAttribute('aria-controls', 'wallet-pop');
  pill.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    // With no wallet in this browser there is nothing to show yet: the button goes straight to the page that makes one.
    if (mode() === 'none' && !isOpen()) return;
    event.preventDefault();
    if (isOpen()) close();
    else open();
  });
  // It is a link dressed as a button, and a button answers to the space bar.
  pill.addEventListener('keydown', (event) => {
    if (event.key !== ' ' || mode() === 'none') return;
    event.preventDefault();
    if (isOpen()) close();
    else open();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isOpen()) {
      event.preventDefault();
      close();
    }
  });
  // A page changed the wallet in use, or its name or icon: an open panel follows.
  onWalletAnnounced(() => {
    if (!isOpen() || changing || signature() === drawnFor) return;
    round += 1;
    render();
    if (mode() === 'open') void read();
  });
}
