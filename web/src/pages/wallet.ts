import '../extras.css';

import { type Address, address, isAddress } from '@solana/kit';
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';

import type { StatusResponse, TokenSummary } from '../../../shared/src/api.js';
import { GAS_RESERVE_LAMPORTS, SOL_DECIMALS, TOKEN_2022_PROGRAM_ID, TOKEN_DECIMALS, TOKEN_PROGRAM_ID } from '../../../shared/src/constants.js';
import { nativeWalletDirectory } from '../native-wallet.js';
import { readNativeAsset } from '../../../shared/src/native-asset.js';
import { outsideMintProblems, readMintFacts } from '../../../shared/src/mint.js';
import { PAY_SOL, type PayRequest, cleanAmount, cleanNote, payLink, readPayLink } from '../../../shared/src/paylink.js';
import { type PayRequestRecord, matchRequests, memoOf } from '../../../shared/src/payrecords.js';
import { SOL_MINT, historyRowsOf, isRegistered, privateBalance, privateHistory, privateHoldings } from '../../../shared/src/privacy.js';
import { pairSymbol, pairTokenByMint } from '../../../shared/src/quotes.js';
import { PUBLIC_SEND_VISIBILITY } from '../../../shared/src/transfers.js';
import { formatUnits, groupDigits, parseUnits } from '../../../shared/src/units.js';
import { PASS_MIN_PASSPHRASE, sealPass } from '../../../shared/src/viewpass.js';
import { otherAddresses } from '../address.js';
import { alertSettings, setAlertSettings } from '../alert-settings.js';
import { alertsChanged } from '../alerts.js';
import { api } from '../api.js';
import { mountCheckup } from '../checkup-ui.js';
import { connection, loadMarketEnv, publicLamports, rememberTokenProgram, tokenProgramOf } from '../chain.js';
import { explorerTx, sol } from '../format.js';
import { icon } from '../icons.js';
import { dropRequest, forgetSeen, keepMemo, keepRequest, readMemos, readRequests } from '../local-records.js';
import {
  BURN_WORD,
  RECIPIENT_HINTS,
  type RecipientKind,
  RecipientChecker,
  SEND_VISIBILITY,
  burnConfirmed,
  burnEffect,
  burnVisibility,
  classifyRecipient,
} from '../moves.js';
import { moduleTag } from '../module-tag.js';
import { inPairUnits, withUnit } from '../pairs.js';
import { qrSvg } from '../qr.js';
import { watchWallet } from '../session-bus.js';
import { mountRuntime, paintIdentity, setupMessage } from '../shell.js';
import { mountStatement } from '../statement-ui.js';
import {
  MIN_CLAIM_LAMPORTS,
  STALE_BALANCE_NOTE,
  burnFromPrivate,
  burnFromPublic,
  canReceivePrivately,
  claimRewards,
  consolidate,
  deposit,
  ensureRegistered,
  friendlyError,
  requireWalletAddress,
  rewards,
  sendPrivate,
  sendPublic,
  withdraw,
} from '../trade.js';
import { byId, deterministicAvatar, escapeHtml, initShell, setText, short, toast, tokenArt, wireCopyButtons } from '../ui.js';
import { lastUsedWallet, walletCount } from '../vault.js';
import { mountWalletPanel } from '../wallet-panel.js';
import {
  type Session,
  connectExternal,
  createGhostWallet,
  exportSecret,
  forgetGhostWallet,
  getSession,
  hasVault,
  importGhostWallet,
  knownAs,
  listExternalWallets,
  lock,
  unlockGhostWallet,
  viewingSeed,
} from '../wallet.js';

initShell('wallet');

type Move = 'deposit' | 'withdraw' | 'send' | 'burn';

const SOL = SOL_MINT as Address;

let status: StatusResponse | null = null;
let session: Session | null = null;
/** Tokens launched here that this wallet holds, held, or created: mint -> listing entry. */
const listed = new Map<string, TokenSummary>();
/** Mints already looked up, listed or not, so each is asked about once. */
const lookedUp = new Set<string>();
let move: Move = 'deposit';
/** Which balance a Send takes from: the private one (a private transfer) or the public one (an ordinary transfer). */
let sendSource: 'private' | 'public' = 'private';
/** True while the amount on screen is "all of it", set by MAX and cleared by typing. A public SOL send then empties the wallet exactly. */
let maxed = false;
let busy = false;
/** True once the private balance has been read from chain in this page, and not gone stale since. */
let synced = false;
/**
 * Why the private balance is not being shown, when it could not be read. A
 * balance that was not read is never shown as a number: zero would say the
 * funds are gone, when all that failed is this page.
 */
let syncProblem: string | null = null;
/** Whether the wallet in use is registered to receive privately. Null while that is not known. */
let registeredNow: boolean | null = null;
/**
 * A payment request that came in a link and has been neither paid nor put
 * away. It is somebody else's text: it fills in the Send form for the payer
 * to read and confirm, and never sends anything.
 */
let payRequest: PayRequest | null = null;
/** The wallet the waiting request was last opened for. A switch to another wallet opens it again there. */
let payOpenedFor: string | null = null;
/** True once the request's token and amount have been put into the form. It is done once; after that the form is the payer's. */
let payApplied = false;
let publicSol = 0n;
/**
 * Public token balances: mint -> raw amount, decimals, and the token program
 * the mint belongs to. `movable` is false for a Token-2022 token whose mint
 * carries features that change what a transfer does: it is shown, and this
 * page moves nothing of it.
 */
const publicTokens = new Map<string, { amount: bigint; decimals: number; program: string; movable: boolean }>();
const knownDecimals = new Map<string, number>([[SOL, SOL_DECIMALS]]);

/** The card of the wallet in use, the list of wallets and the address book. */
const panel = mountWalletPanel({
  session: () => session,
  busy: () => busy,
  onSwitch: async (next) => {
    session = next;
    await enterWallet(false, true);
  },
  onChange: () => renderMove(),
  onPick: (target) => {
    if (busy) return;
    openMove('send', SOL);
    byId<HTMLInputElement>('move-recipient').value = target;
    recipientTyped();
  },
});

/** Where to go after the wallet is ready. Only same-site paths are accepted. */
function nextPath(): string | null {
  const next = new URL(location.href).searchParams.get('next');
  return next && next.startsWith('/') && !next.startsWith('//') && !next.includes('\\') ? next : null;
}

/** Returns to the page that sent the visitor here, if one did. */
function leaveIfAsked(): boolean {
  const next = nextPath();
  if (!next) return false;
  location.assign(next);
  return true;
}

function network(): 'mainnet' {
  return status?.network ?? 'mainnet';
}

function statusBox(id: string, kind: 'working' | 'ok' | 'error', title: string, body = ''): void {
  byId(id).innerHTML = `<div class="status ${kind === 'working' ? '' : kind}"><b>${escapeHtml(title)}</b>${body ? `<br>${body}` : ''}</div>`;
}

function txLink(signature: string, shown = 10): string {
  return `<a class="tx-link" href="${escapeHtml(explorerTx(signature, network()))}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(signature)}">${escapeHtml(short(signature, shown, shown))}</a>`;
}

function tokenOf(mint: string): TokenSummary | undefined {
  return listed.get(mint);
}

/** Asks the listing which of these mints were launched here, so they can be shown by name and artwork. */
let nativeListed: Awaited<ReturnType<typeof nativeWalletDirectory>> = new Map();
let nativeRequested = false;
async function learnTokens(mints: readonly string[]): Promise<void> {
  // Public directory only; it never receives a wallet address or private mint list.
  nativeListed = await nativeWalletDirectory();
  const unknown = [...new Set(mints)].filter((mint) => mint !== SOL && !nativeListed.has(mint) && !lookedUp.has(mint) && isAddress(mint));
  if (unknown.length === 0) return;
  for (const mint of unknown) lookedUp.add(mint);
  try {
    for (const token of await api.tokensByMints(unknown)) listed.set(token.mint, token);
  } catch {
    // The listing is a convenience here: without it a token shows by its address.
    for (const mint of unknown) lookedUp.delete(mint);
  }
}

/** A pair token other than SOL, when `mint` is one this site prices tokens in: USDC, ZEC and the rest. */
function pairTokenOf(mint: string) {
  const token = pairTokenByMint(mint);
  return token && !token.native ? token : undefined;
}

function labelOf(mint: string): string {
  if (mint === SOL) return 'SOL';
  const token = tokenOf(mint);
  if (token?.symbol) return `$${token.symbol}`;
  const native = nativeListed.get(mint);
  if (native) return `$${native.symbol}`;
  const pairToken = pairTokenOf(mint);
  return pairToken ? pairSymbol(pairToken) : short(mint, 4, 4);
}

/** What to call an asset in full: a launched token's name, a pair token's, or that it is neither. */
function nameOf(mint: string): string {
  if (mint === SOL) return 'Solana';
  return tokenOf(mint)?.name ?? nativeListed.get(mint)?.name ?? pairTokenOf(mint)?.name ?? 'Unlisted asset';
}

async function decimalsOf(mint: string): Promise<number> {
  const cached = knownDecimals.get(mint);
  if (cached !== undefined) return cached;
  let decimals = TOKEN_DECIMALS;
  if (!tokenOf(mint)) {
    try {
      decimals = (await connection().getTokenSupply(new PublicKey(mint))).value.decimals;
    } catch {
      // Not remembered: a read that failed is asked again the next time the token is shown.
      return pairTokenOf(mint)?.expectedDecimals ?? TOKEN_DECIMALS;
    }
  }
  knownDecimals.set(mint, decimals);
  return decimals;
}

const amountText = (raw: bigint, decimals: number, maxFraction = 4): string => groupDigits(formatUnits(raw, decimals, maxFraction));

/**
 * A token's decimals when they are known for certain: read from its mint, six
 * for a token launched here, or pinned in this build for a pair token.
 * Undefined otherwise, and then no amount of it is written or typed: one
 * decimal place wrong is an amount ten times off.
 */
function sureDecimals(mint: string): number | undefined {
  if (mint === SOL) return SOL_DECIMALS;
  return knownDecimals.get(mint) ?? (tokenOf(mint) ? TOKEN_DECIMALS : pairTokenOf(mint)?.expectedDecimals);
}

/* ---------------- Views ---------------- */

function show(view: 'new' | 'locked' | 'wallet'): void {
  byId('view-new').hidden = view !== 'new';
  byId('view-locked').hidden = view !== 'locked';
  byId('view-wallet').hidden = view !== 'wallet';
}

function renderExternalList(): void {
  const wallets = listExternalWallets();
  const html = wallets.length
    ? wallets
        .map((wallet) => {
          const icon = wallet.icon.startsWith('data:image/') ? `<img src="${escapeHtml(wallet.icon)}" alt="">` : '';
          return `<button type="button" data-external="${escapeHtml(wallet.name)}">${icon}<span>${escapeHtml(wallet.name)}</span></button>`;
        })
        .join('')
    : '<p class="small muted">No compatible wallet extension found in this browser.</p>';
  for (const id of ['external-list', 'external-list-locked']) {
    const node = byId(id);
    node.innerHTML = html;
    node.querySelectorAll<HTMLButtonElement>('[data-external]').forEach((button) => {
      button.addEventListener('click', async () => {
        if (busy) return;
        busy = true;
        button.disabled = true;
        try {
          session = await connectExternal(button.dataset.external ?? '');
          toast(`${session.label} connected`);
          if (leaveIfAsked()) return;
          await enterWallet(false);
        } catch (error) {
          toast(friendlyError(error), 'error');
        } finally {
          busy = false;
          button.disabled = false;
          openLinks();
        }
      });
    });
  }
}

async function route(): Promise<void> {
  try {
    session = await getSession();
  } catch (error) {
    session = null;
    toast(friendlyError(error), 'error');
  }
  if (session) {
    await enterWallet(false);
    return;
  }
  // No wallet is open: what was made or worked out for the last one is taken off the page.
  hideViewpass();
  statementBox.reset();
  checkupBox.reset();
  byId('request-output').innerHTML = '';
  byId('request-list').innerHTML = '';
  renderPayBanner();
  if (hasVault()) {
    // The wallet that was in use last is the one that opens.
    const last = lastUsedWallet();
    const count = walletCount();
    setText('locked-name', last?.name ?? 'Wallet 1');
    setText('locked-address', short(last?.address ?? '', 6, 6));
    setText('locked-count', count > 1 ? ` · one of ${count} wallets` : '');
    byId('unlock-stage').classList.remove('is-unlocking', 'is-open', 'is-denied');
    show('locked');
  } else {
    show('new');
  }
  renderExternalList();
  // Extensions announce themselves a moment after the page loads.
  window.setTimeout(renderExternalList, 700);
  window.setTimeout(renderExternalList, 2200);
}

/* ---------------- Create, import, unlock ---------------- */

document.querySelectorAll<HTMLButtonElement>('[data-new-tab]').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll<HTMLButtonElement>('[data-new-tab]').forEach((other) => other.classList.toggle('on', other === tab));
    byId('create-form').hidden = tab.dataset.newTab !== 'create';
    byId('import-form').hidden = tab.dataset.newTab !== 'import';
    byId('new-output').innerHTML = '';
  });
});

byId<HTMLFormElement>('create-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy) return;
  const pass = byId<HTMLInputElement>('create-pass');
  const pass2 = byId<HTMLInputElement>('create-pass2');
  if (pass.value.length < 8) return statusBox('new-output', 'error', 'PASSPHRASE TOO SHORT', 'Use at least 8 characters.');
  if (pass.value !== pass2.value) return statusBox('new-output', 'error', 'PASSPHRASES DIFFER', 'Type the same passphrase twice.');
  busy = true;
  statusBox('new-output', 'working', 'CREATING', 'Generating a key and encrypting it…');
  try {
    session = await createGhostWallet(pass.value);
    pass.value = '';
    pass2.value = '';
    await enterWallet(true);
  } catch (error) {
    statusBox('new-output', 'error', 'COULD NOT CREATE', escapeHtml(friendlyError(error)));
  } finally {
    busy = false;
    openLinks();
  }
});

byId<HTMLFormElement>('import-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy) return;
  const secret = byId<HTMLTextAreaElement>('import-secret');
  const pass = byId<HTMLInputElement>('import-pass');
  busy = true;
  statusBox('new-output', 'working', 'IMPORTING', 'Checking the key and encrypting it…');
  try {
    session = await importGhostWallet(secret.value, pass.value);
    secret.value = '';
    pass.value = '';
    if (leaveIfAsked()) return;
    await enterWallet(false);
  } catch (error) {
    statusBox('new-output', 'error', 'COULD NOT IMPORT', escapeHtml(friendlyError(error)));
  } finally {
    busy = false;
    openLinks();
  }
});

const pause = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));

byId<HTMLFormElement>('unlock-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy) return;
  const pass = byId<HTMLInputElement>('unlock-pass');
  const stage = byId('unlock-stage');
  const button = byId<HTMLButtonElement>('unlock-button');
  busy = true;
  button.disabled = true;
  button.textContent = 'Decrypting…';
  byId('unlock-output').innerHTML = '';
  stage.classList.remove('is-denied', 'is-open');
  stage.classList.add('is-unlocking');
  const started = performance.now();
  try {
    session = await unlockGhostWallet(pass.value);
    pass.value = '';
    // The scene is given long enough to be seen, never longer than a blink more than the work itself took.
    await pause(Math.max(0, 600 - (performance.now() - started)));
    stage.classList.add('is-open');
    await pause(430);
    if (leaveIfAsked()) return;
    await enterWallet(false, true);
  } catch (error) {
    stage.classList.remove('is-unlocking');
    stage.classList.add('is-denied');
    window.setTimeout(() => stage.classList.remove('is-denied'), 450);
    statusBox('unlock-output', 'error', 'COULD NOT UNLOCK', escapeHtml(friendlyError(error)));
  } finally {
    busy = false;
    button.disabled = false;
    button.textContent = 'Unlock';
    stage.classList.remove('is-unlocking');
    openLinks();
  }
});

byId<HTMLFormElement>('forget-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = byId<HTMLInputElement>('forget-confirm');
  if (input.value.trim() !== 'FORGET') {
    toast('Type FORGET to confirm.', 'error');
    return;
  }
  forgetGhostWallet();
  input.value = '';
  paintIdentity();
  toast('Wallets removed from this browser');
  void route();
});

/* ---------------- Unlocked wallet ---------------- */

function revealOnClick(id: string): void {
  const box = byId(id);
  if (box.dataset.revealReady) return;
  box.dataset.revealReady = '1';
  box.addEventListener('click', () => box.classList.add('is-shown'));
}

async function enterWallet(fresh: boolean, animate = false): Promise<void> {
  const current = session;
  if (!current) return;
  show('wallet');
  if (animate) {
    const view = byId('view-wallet');
    view.classList.add('wallet-enter');
    window.setTimeout(() => view.classList.remove('wallet-enter'), 1200);
  }
  synced = false;
  syncProblem = null;
  // Nothing of the wallet that was in use before stays on screen.
  publicSol = 0n;
  publicTokens.clear();
  setText('w-public-sol', '—');
  setText('w-private-sol', 'Syncing…');
  setText('w-notes', '—');
  setText('w-registration', 'Checking registration…');
  byId('w-register').hidden = true;
  byId('rewards-section').hidden = true;
  setText('w-address', current.address);
  // The same page anyone else can open for this address: what the chain shows about it, and nothing more.
  byId<HTMLAnchorElement>('w-seen').href = `/rings?address=${encodeURIComponent(current.address)}`;
  byId('w-export').hidden = current.kind !== 'ghost';
  byId('export-panel').hidden = true;
  setText('export-secret', '—');
  byId('w-output').innerHTML = '';
  byId('move-output').innerHTML = '';
  byId<HTMLInputElement>('move-amount').value = '';
  byId<HTMLInputElement>('move-recipient').value = '';
  recipientKind = 'empty';
  maxed = false;
  // A wallet that was just opened or switched to starts with its form put away.
  showMoveForm(false);
  panel.render();
  // Nothing of the wallet before stays in the boxes that were filled for it.
  registeredNow = null;
  byId('pay-banner').hidden = true;
  byId('request-output').innerHTML = '';
  statementBox.reset();
  checkupBox.reset();
  hideViewpass();
  renderAlerts();
  renderRequestForm();
  renderRequests();

  const backup = byId('backup-panel');
  backup.hidden = !fresh;
  if (fresh) {
    setText('backup-secret', exportSecret());
    byId('backup-secret').classList.remove('is-shown');
    revealOnClick('backup-secret');
  }
  wireCopyButtons();
  renderMove();
  renderHoldings();
  renderPublicHoldings();
  renderHistory();
  syncTabs();
  // A request that is waiting is opened afresh for the wallet just entered: its form starts empty.
  payOpenedFor = null;
  // While the page is in the middle of unlocking, this waits for it to finish.
  openLinks();

  await refreshPublic();
  if (session !== current) return;
  void refreshRegistration();
  await readPrivateBalance();
  if (session !== current) return;
  void refreshRewards();
}

/**
 * Reads the private balance from chain. On failure the page says so and
 * offers to try again. Like every read on this page it is for the wallet in
 * use when it began: if that changed meanwhile, it writes nothing.
 */
async function readPrivateBalance(): Promise<void> {
  const current = session;
  if (!current) return;
  synced = false;
  syncProblem = null;
  await refreshAll();
  if (session !== current) return;
  let problem: string | null = null;
  try {
    await current.sync();
  } catch (error) {
    problem = friendlyError(error);
  }
  if (session !== current) return;
  synced = problem === null;
  syncProblem = problem;
  await refreshAll();
}

/** After a transaction that settled: the balance on screen is trusted only if it was re-read. */
function noteSettled(result: { synced: boolean }): void {
  if (result.synced) {
    synced = true;
    syncProblem = null;
  } else {
    synced = false;
    syncProblem = STALE_BALANCE_NOTE;
  }
}

byId<HTMLButtonElement>('backup-done').addEventListener('click', () => {
  setText('backup-secret', '—');
  byId('backup-panel').hidden = true;
  leaveIfAsked();
});

byId<HTMLButtonElement>('w-lock').addEventListener('click', () => {
  lock();
  session = null;
  setText('export-secret', '—');
  setText('backup-secret', '—');
  byId('export-panel').hidden = true;
  toast('Wallet locked');
  paintIdentity();
  void route();
});

byId<HTMLButtonElement>('w-export').addEventListener('click', () => {
  try {
    setText('export-secret', exportSecret());
    byId('export-secret').classList.remove('is-shown');
    revealOnClick('export-secret');
    byId('export-panel').hidden = false;
  } catch (error) {
    toast(friendlyError(error), 'error');
  }
});

byId<HTMLButtonElement>('export-hide').addEventListener('click', () => {
  setText('export-secret', '—');
  byId('export-panel').hidden = true;
});

async function refreshRegistration(): Promise<void> {
  const current = session;
  if (!current) return;
  const button = byId<HTMLButtonElement>('w-register');
  try {
    const registered = await isRegistered(current.ctx.client, current.address);
    if (session !== current) return;
    registeredNow = registered;
    setText(
      'w-registration',
      registered
        ? 'Registered with Rings: others can send to this address privately.'
        : 'Not registered yet. Registering publishes your encryption key so others can send to this address privately.',
    );
    button.hidden = registered;
  } catch {
    if (session !== current) return;
    registeredNow = null;
    setText('w-registration', 'Registration status unavailable.');
    button.hidden = true;
  }
}

byId<HTMLButtonElement>('w-register').addEventListener('click', async () => {
  if (!session || busy) return;
  busy = true;
  try {
    await ensureRegistered(session, (message) => statusBox('w-output', 'working', 'WORKING', escapeHtml(message)));
    statusBox('w-output', 'ok', 'REGISTERED', 'This address can now receive private transfers.');
  } catch (error) {
    statusBox('w-output', 'error', 'REGISTRATION FAILED', escapeHtml(friendlyError(error)));
  } finally {
    busy = false;
    await refreshRegistration();
    await refreshPublic();
  }
});

async function refreshPublic(): Promise<void> {
  const current = session;
  if (!current) return;
  try {
    const lamports = await publicLamports(current.address);
    if (session !== current) return;
    publicSol = lamports;
    setText('w-public-sol', `${sol(publicSol, 4)} SOL`);
  } catch {
    if (session !== current) return;
    setText('w-public-sol', '—');
  }
  try {
    const accounts = await connection().getParsedTokenAccountsByOwner(new PublicKey(current.address), { programId: new PublicKey(TOKEN_PROGRAM_ID) });
    if (session !== current) return;
    publicTokens.clear();
    for (const { account } of accounts.value) {
      const info = (account.data as { parsed?: { info?: { mint?: string; tokenAmount?: { amount?: string; decimals?: number } } } }).parsed?.info;
      const amount = BigInt(info?.tokenAmount?.amount ?? '0');
      if (!info?.mint || amount <= 0n) continue;
      publicTokens.set(info.mint, { amount, decimals: info.tokenAmount?.decimals ?? TOKEN_DECIMALS, program: TOKEN_PROGRAM_ID, movable: true });
      knownDecimals.set(info.mint, info.tokenAmount?.decimals ?? TOKEN_DECIMALS);
    }
  } catch {
    // Public token balances are a convenience; SOL above is what matters for fees.
  }
  await refreshPublic2022(current);
  if (session !== current) return;
  await learnTokens([...publicTokens.keys()]);
  if (session !== current) return;
  renderPublicHoldings();
  renderRequestForm();
  renderMove();
  const requested = new URL(location.href).searchParams.get('nativeMint');
  if (!nativeRequested && requested && nativeListed.has(requested) && publicTokens.get(requested)?.movable && !busy) {
    nativeRequested = true;
    openMove('deposit', requested);
  }
}

/**
 * The wallet's public balances of Token-2022 tokens, which live under another
 * token program than the rest and so are listed separately. Only the wallet's
 * own account for each mint counts: it is the one every move here spends
 * from. Each mint is then read, to tell a token that moves like any other
 * from one that carries a fee, a hook or somebody else's hand on it.
 */
async function refreshPublic2022(current: Session): Promise<void> {
  try {
    const owner = new PublicKey(current.address);
    const program = new PublicKey(TOKEN_2022_PROGRAM_ID);
    const accounts = await connection().getParsedTokenAccountsByOwner(owner, { programId: program });
    if (session !== current) return;
    const found = new Map<string, { amount: bigint; decimals: number }>();
    for (const { pubkey, account } of accounts.value) {
      const info = (account.data as { parsed?: { info?: { mint?: string; tokenAmount?: { amount?: string; decimals?: number } } } }).parsed?.info;
      const amount = BigInt(info?.tokenAmount?.amount ?? '0');
      const decimals = info?.tokenAmount?.decimals;
      if (!info?.mint || amount <= 0n || typeof decimals !== 'number') continue;
      if (!getAssociatedTokenAddressSync(new PublicKey(info.mint), owner, false, program).equals(pubkey)) continue;
      found.set(info.mint, { amount, decimals });
    }
    const mints = [...found.keys()];
    const infos = mints.length > 0 ? await connection().getMultipleAccountsInfo(mints.map((mint) => new PublicKey(mint)), 'confirmed') : [];
    if (session !== current) return;
    for (const [mint, balance] of publicTokens) if (balance.program === TOKEN_2022_PROGRAM_ID) publicTokens.delete(mint);
    mints.forEach((mint, index) => {
      const balance = found.get(mint);
      if (!balance) return;
      let movable = false;
      try {
        movable = outsideMintProblems(readMintFacts(new PublicKey(mint), infos[index] ?? null)).length === 0;
      } catch {
        // A mint that could not be read is not moved on a guess.
        movable = false;
      }
      publicTokens.set(mint, { ...balance, program: TOKEN_2022_PROGRAM_ID, movable });
      knownDecimals.set(mint, balance.decimals);
      rememberTokenProgram(mint, TOKEN_2022_PROGRAM_ID);
    });
  } catch {
    // As above: a convenience. A wallet that holds none of these is the usual case.
  }
}

/**
 * The token program a token's accounts live under. Tokens launched here and
 * the pair tokens are SPL Token mints. Anything else is what its listing
 * above said, or what its mint says on chain.
 */
async function programFor(mint: string): Promise<string> {
  if (tokenOf(mint) || pairTokenOf(mint)) return TOKEN_PROGRAM_ID;
  return publicTokens.get(mint)?.program ?? (await tokenProgramOf(mint));
}

async function refreshAll(): Promise<void> {
  const current = session;
  if (!current) return;
  setText('w-private-sol', synced ? `${sol(privateBalance(current.ctx, SOL), 4)} SOL` : syncProblem ? 'Not read' : 'Syncing…');
  await learnTokens([...privateHoldings(current.ctx).map((holding) => holding.mint), ...privateHistory(current.ctx).map((entry) => entry.asset as string)]);
  if (session !== current) return;
  // Every token the history names is written with its own decimals, held now or not.
  await Promise.all([...new Set([...privateHoldings(current.ctx).map((holding) => holding.mint as string), ...privateHistory(current.ctx).map((entry) => entry.asset as string)])].map((mint) => decimalsOf(mint)));
  if (session !== current) return;
  const notes = privateHoldings(current.ctx).reduce((sum, holding) => sum + holding.notes, 0);
  setText('w-notes', synced ? String(notes) : '—');
  renderHoldings();
  renderHistory();
  renderRequestForm();
  renderRequests();
  renderMove();
}

/* ---------------- Holdings ---------------- */

function renderHoldings(): void {
  const grid = byId('holdings');
  if (!session) return;
  if (syncProblem) {
    grid.innerHTML = `<div class="status error"><b>YOUR PRIVATE BALANCE COULD NOT BE READ</b><br>${escapeHtml(syncProblem)}<br><br>Nothing has been lost: what you hold privately is on chain under your keys, and only this page failed to read it.<div class="row-wrap" style="margin-top:12px"><button class="btn flat" type="button" data-read-again>Try again</button></div></div>`;
    grid.querySelector<HTMLButtonElement>('[data-read-again]')?.addEventListener('click', () => {
      if (!busy) void readPrivateBalance();
    });
    return;
  }
  if (!synced) {
    grid.innerHTML = '<div class="empty-state">READING ENCRYPTED NOTES<span class="blink">_</span></div>';
    return;
  }
  const holdings = privateHoldings(session.ctx);
  if (holdings.length === 0) {
    grid.innerHTML = '<div class="empty-state">NOTHING PRIVATE YET<br><br>Shield some SOL to start, or <a href="/">find a token on the market</a>.</div>';
    return;
  }
  const swapOn = Boolean(status?.convert?.enabled && status.convert.anyToken);
  grid.innerHTML = holdings
    .map((holding) => {
      const token = tokenOf(holding.mint);
      const decimals = sureDecimals(holding.mint);
      const isSol = holding.mint === SOL;
      const pairToken = pairTokenOf(holding.mint);
      const art = isSol ? deterministicAvatar('SOL') : token ? tokenArt(token) : deterministicAvatar(pairToken ? pairSymbol(pairToken) : holding.mint);
      const name = nameOf(holding.mint);
      const mint = escapeHtml(holding.mint);
      // A token launched here is traded on its own page. Any other is bought and sold on the swap page.
      const native = nativeListed.get(holding.mint);
      const trade = native
        ? `<a class="btn flat" href="/native-token?market=${encodeURIComponent(native.address)}">Native market</a>`
        : token
        ? `<a class="btn flat" href="/token?mint=${encodeURIComponent(holding.mint)}">Trade</a>`
        : !isSol && swapOn
          ? `<a class="btn flat" href="/swap?mint=${encodeURIComponent(holding.mint)}">Swap</a>`
          : '';
      if (decimals === undefined) {
        // Held, and not shown as a number: this token's decimals could not be read, and a guess would be wrong by a factor of ten or more.
        return `<article class="holding-card"><div class="holding-card-head"><div class="token-avatar">${art}</div><div><span class="eyebrow">${escapeHtml(labelOf(holding.mint))}</span><h3>${escapeHtml(name)}</h3></div></div><div class="holding-amount">—</div><div class="holding-value">Encrypted, ${holding.notes} note${holding.notes === 1 ? '' : 's'}</div><p class="tiny dim" style="margin:10px 0 0">You hold this token, but its decimals could not be read from chain just now, so its amount is not written and it cannot be moved from here yet. Nothing is lost. Reload the page to read it again.</p></article>`;
      }
      const send = `<button class="btn flat" type="button" data-act="send" data-key="${mint}">Send</button>`;
      const out = `<button class="btn flat" type="button" data-act="withdraw" data-key="${mint}">Unshield</button>`;
      // Burning is offered for tokens launched here only: SOL and outside tokens are never burned from this page.
      const burn = token ? `<button class="btn flat" type="button" data-act="burn" data-key="private:${mint}">Burn</button>` : '';
      const merge = holding.notes > 1 ? `<button class="btn flat" type="button" data-merge="${mint}">Consolidate ${holding.notes} notes</button>` : '';
      return `<article class="holding-card"><div class="holding-card-head"><div class="token-avatar">${art}</div><div><span class="eyebrow">${escapeHtml(labelOf(holding.mint))}</span><h3>${escapeHtml(name)}</h3></div></div><div class="holding-amount">${amountText(holding.amount, decimals)}</div><div class="holding-value">Encrypted, ${holding.notes} note${holding.notes === 1 ? '' : 's'}</div><div class="row-wrap">${trade}${send}${out}${burn}${merge}</div></article>`;
    })
    .join('');
  grid.querySelectorAll<HTMLButtonElement>('[data-act]').forEach((button) => {
    button.addEventListener('click', () => {
      if (busy) return;
      // Send on a private holding is a private transfer, whatever the form was last used for.
      if (button.dataset.act === 'send') sendSource = 'private';
      openMove(button.dataset.act as Move, button.dataset.key ?? '');
    });
  });
  grid.querySelectorAll<HTMLButtonElement>('[data-merge]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!session || busy) return;
      busy = true;
      button.disabled = true;
      try {
        const landed = await consolidate(session, address(button.dataset.merge ?? ''), (message) => {
          button.textContent = message;
        });
        noteSettled(landed);
        toast('Balance consolidated');
        statusBox('move-output', 'ok', 'CONSOLIDATED', txLink(landed.signature));
      } catch (error) {
        toast(friendlyError(error), 'error');
      } finally {
        busy = false;
        await refreshAll();
        await refreshPublic();
      }
    });
  });
}

function renderPublicHoldings(): void {
  const section = byId('public-section');
  const rows = [...publicTokens.entries()];
  section.hidden = rows.length === 0;
  if (rows.length === 0) return;
  const grid = byId('public-holdings');
  const swapOn = Boolean(status?.convert?.enabled && status.convert.anyToken);
  grid.innerHTML = rows
    .map(([mint, balance]) => {
      const token = tokenOf(mint);
      const pairToken = pairTokenOf(mint);
      const head = `<div class="holding-card-head"><div class="token-avatar">${token ? tokenArt(token) : deterministicAvatar(pairToken ? pairSymbol(pairToken) : mint)}</div><div><span class="eyebrow">${escapeHtml(labelOf(mint))}</span><h3>${escapeHtml(nameOf(mint))}</h3></div></div><div class="holding-amount">${amountText(balance.amount, balance.decimals)}</div>`;
      if (!balance.movable) {
        return `<article class="holding-card">${head}<div class="holding-value">Public, visible on chain</div><p class="tiny dim" style="margin:10px 0 0">A Token-2022 token with features that change how it moves. This page does not move it: use a wallet that handles it.</p></article>`;
      }
      const native = nativeListed.get(mint);
      const swap = native ? `<a class="btn flat" href="/native-token?market=${encodeURIComponent(native.address)}">Native market</a>` : !token && swapOn ? `<a class="btn flat" href="/swap?mint=${encodeURIComponent(mint)}">Swap</a>` : '';
      return `<article class="holding-card">${head}<div class="holding-value">Public, visible on chain</div><div class="row-wrap"><button class="btn flat" type="button" data-deposit="${escapeHtml(mint)}">Shield</button><button class="btn flat" type="button" data-send-public="${escapeHtml(mint)}">Send</button>${swap}${token ? `<button class="btn flat" type="button" data-burn-public="${escapeHtml(mint)}">Burn</button>` : ''}</div></article>`;
    })
    .join('');
  grid.querySelectorAll<HTMLButtonElement>('[data-deposit]').forEach((button) => {
    button.addEventListener('click', () => {
      const balance = publicTokens.get(button.dataset.deposit ?? '');
      openMove('deposit', button.dataset.deposit ?? '', balance ? formatUnits(balance.amount, balance.decimals) : undefined);
    });
  });
  grid.querySelectorAll<HTMLButtonElement>('[data-send-public]').forEach((button) => {
    button.addEventListener('click', () => {
      if (busy) return;
      // Send on a public balance is an ordinary transfer.
      sendSource = 'public';
      openMove('send', button.dataset.sendPublic ?? '');
    });
  });
  grid.querySelectorAll<HTMLButtonElement>('[data-burn-public]').forEach((button) => {
    button.addEventListener('click', () => openMove('burn', `public:${button.dataset.burnPublic ?? ''}`));
  });
}

function renderHistory(): void {
  const body = byId('history');
  if (!session) return;
  if (!synced) {
    body.innerHTML = `<tr><td colspan="6">${syncProblem ? 'Not read. See Private holdings on the Tokens tab.' : 'Reading encrypted notes…'}</td></tr>`;
    return;
  }
  const rows = privateHistory(session.ctx).slice(-40).reverse();
  if (rows.length === 0) {
    body.innerHTML = '<tr><td colspan="6">No private activity yet.</td></tr>';
    return;
  }
  const memos = readMemos(session.address);
  const label: Record<string, string> = {
    deposit: 'Shield',
    privateTransfer: 'Private transfer',
    ringEntry: 'Ring entry',
    publicWithdrawal: 'Unshield',
    split: 'Split',
    merge: 'Consolidation',
  };
  body.innerHTML = rows
    .map((entry) => {
      // An amount is written only with decimals that are known for certain.
      const decimals = sureDecimals(entry.asset as string);
      const boundary = entry.kind === 'deposit' || entry.kind === 'publicWithdrawal';
      const direction = entry.direction === 'inbound' ? 'In' : entry.direction === 'outbound' ? 'Out' : 'Self';
      const note = memoOf(memos, entry.id.signature)?.note;
      return `<tr><td>${escapeHtml(label[entry.kind] ?? entry.kind)}${note ? `<small class="history-note">${escapeHtml(note)}</small>` : ''}</td><td>${direction}</td><td>${escapeHtml(labelOf(entry.asset))}</td><td class="num">${decimals === undefined ? '—' : amountText(entry.amount, decimals)}</td><td>${boundary ? 'Amount public' : 'Amount encrypted'}</td><td>${txLink(entry.id.signature, 4)}</td></tr>`;
    })
    .join('');
}

/* ---------------- Move funds ---------------- */

interface MoveAsset {
  /** What the asset select carries: the mint, or for a burn the balance it comes from and the mint. */
  readonly key: string;
  readonly mint: string;
  readonly available: bigint;
  readonly decimals: number;
  /** Which balance the amount is taken from. */
  readonly source: 'private' | 'public';
}

/** The public token balances this page moves: all of them but a Token-2022 token with features it does not handle. */
function movablePublic(): Array<[string, { amount: bigint; decimals: number; program: string; movable: boolean }]> {
  return [...publicTokens.entries()].filter(([, balance]) => balance.movable);
}

function moveAssets(): MoveAsset[] {
  if (!session) return [];
  if (move === 'deposit') {
    const spendable = publicSol > GAS_RESERVE_LAMPORTS ? publicSol - GAS_RESERVE_LAMPORTS : 0n;
    return [
      { key: SOL, mint: SOL, available: spendable, decimals: SOL_DECIMALS, source: 'public' },
      ...movablePublic().map(([mint, balance]): MoveAsset => ({ key: mint, mint, available: balance.amount, decimals: balance.decimals, source: 'public' })),
    ];
  }
  if (move === 'send' && sendSource === 'public') {
    // An ordinary transfer may take all of the public SOL: MAX empties the wallet exactly.
    return [
      { key: SOL, mint: SOL, available: publicSol, decimals: SOL_DECIMALS, source: 'public' },
      ...movablePublic().map(([mint, balance]): MoveAsset => ({ key: mint, mint, available: balance.amount, decimals: balance.decimals, source: 'public' })),
    ];
  }
  // A token whose decimals are not known for certain is left out: an amount typed for it could not be read rightly.
  const holdings = privateHoldings(session.ctx).flatMap((holding): MoveAsset[] => {
    const decimals = sureDecimals(holding.mint);
    return decimals === undefined ? [] : [{ key: holding.mint, mint: holding.mint, available: holding.amount, decimals, source: 'private' }];
  });
  if (move === 'burn') {
    // Only tokens launched here can be burned here: their mint and decimals are known, and their supply is tracked.
    return [
      ...holdings.filter((asset) => tokenOf(asset.mint)).map((asset): MoveAsset => ({ ...asset, key: `private:${asset.mint}`, decimals: TOKEN_DECIMALS })),
      ...[...publicTokens.entries()]
        .filter(([mint]) => tokenOf(mint))
        .map(([mint, balance]): MoveAsset => ({ key: `public:${mint}`, mint, available: balance.amount, decimals: TOKEN_DECIMALS, source: 'public' })),
    ];
  }
  return holdings.some((holding) => holding.mint === SOL) ? holdings : [{ key: SOL, mint: SOL, available: 0n, decimals: SOL_DECIMALS, source: 'private' }, ...holdings];
}

function selectedAsset(): MoveAsset | undefined {
  const select = byId<HTMLSelectElement>('move-asset');
  return moveAssets().find((asset) => asset.key === select.value);
}

/** True when the move on screen spends from the private balance, which must have been read first. */
function spendsPrivate(asset: MoveAsset | undefined): boolean {
  return move === 'withdraw' || (move === 'send' && sendSource === 'private') || (move === 'burn' && asset?.source !== 'public');
}

/** True for a Send out of the public balance: an ordinary transfer, with nothing private about it. */
const publicSend = (): boolean => move === 'send' && sendSource === 'public';

let recipientKind: RecipientKind = 'empty';
let recipientTimer: number | undefined;
// Whether an address can receive privately is public, so it is checked as it is typed.
const recipients = new RecipientChecker((candidate) => canReceivePrivately(address(candidate)));

function renderRecipientHint(): void {
  const hint = byId('move-recipient-hint');
  const typed = byId<HTMLInputElement>('move-recipient').value.trim();
  // An address this browser has a name for is shown by that name, so a slip in a pasted address is easier to see.
  const known = typed && typed !== session?.address ? knownAs(typed) : null;
  const who = known ? `${known.own ? 'Your wallet' : 'Contact'}: ${known.name}. ` : '';
  if (publicSend()) {
    const quick = classifyRecipient(typed, session?.address ?? '');
    hint.textContent = quick === 'invalid' || quick === 'self' ? RECIPIENT_HINTS[quick] : `${who}An ordinary transfer: the address needs no registration, and everyone can see the two wallets, the token and the amount.`;
    if (quick === 'invalid' || quick === 'self') hint.dataset.state = quick;
    else delete hint.dataset.state;
  } else if (move === 'send') {
    hint.textContent = `${who}${RECIPIENT_HINTS[recipientKind]}`;
    hint.dataset.state = recipientKind;
  } else {
    hint.textContent = 'Leave it as your own address to move funds back to your public balance.';
    delete hint.dataset.state;
  }
}

function lookAtRecipient(): void {
  if (move !== 'send' || sendSource !== 'private') return;
  recipientKind = recipients.look(byId<HTMLInputElement>('move-recipient').value, session?.address ?? '', (kind) => {
    recipientKind = kind;
    renderRecipientHint();
  });
  renderRecipientHint();
}

function renderMove(preselect?: string): void {
  if (!session) return;
  document.querySelectorAll<HTMLButtonElement>('[data-move]').forEach((tab) => tab.classList.toggle('on', tab.dataset.move === move));
  document.querySelectorAll<HTMLButtonElement>('[data-wact]').forEach((button) => button.classList.toggle('on', button.dataset.wact === move));
  const select = byId<HTMLSelectElement>('move-asset');
  const previous = preselect ?? select.value;
  const assets = moveAssets();
  select.innerHTML = assets.length
    ? assets
        .map((asset) => `<option value="${escapeHtml(asset.key)}">${escapeHtml(labelOf(asset.mint))}${move === 'burn' ? ` · ${asset.source}` : ''}</option>`)
        .join('')
    : '<option value="">Nothing here to burn</option>';
  if (assets.some((asset) => asset.key === previous)) select.value = previous;
  const recipientField = byId('move-recipient-field');
  recipientField.hidden = move === 'deposit' || move === 'burn';
  byId('move-source-field').hidden = move !== 'send';
  byId<HTMLSelectElement>('move-source').value = sendSource;
  // The other wallets on the list and the contacts, one press each.
  const picks = byId('move-picks');
  picks.innerHTML = recipientField.hidden ? '' : panel.picksHtml();
  picks.hidden = picks.innerHTML === '';
  picks.querySelectorAll<HTMLButtonElement>('[data-pick]').forEach((button) => {
    button.addEventListener('click', () => {
      byId<HTMLInputElement>('move-recipient').value = button.dataset.pick ?? '';
      recipientTyped();
    });
  });
  byId('move-confirm-field').hidden = move !== 'burn';
  const recipient = byId<HTMLInputElement>('move-recipient');
  if (move === 'withdraw') {
    setText('move-recipient-label', 'Destination Solana address');
    if (!recipient.value) recipient.value = session.address;
  } else if (move === 'send') {
    setText('move-recipient-label', 'Recipient Solana address');
    if (recipient.value === session.address) recipient.value = '';
    const quick = classifyRecipient(recipient.value, session.address);
    if (quick !== 'candidate') recipientKind = quick;
    else if (sendSource === 'private' && (recipientKind === 'empty' || recipientKind === 'invalid' || recipientKind === 'self')) lookAtRecipient();
  }
  renderRecipientHint();
  const row = (label: string, value: string, hidden: boolean) => `<dt>${escapeHtml(label)}</dt><dd class="${hidden ? 'is-hidden' : 'is-public'}">${escapeHtml(value)}</dd>`;
  const rows =
    move === 'deposit'
      ? `${row('Your wallet', 'PUBLIC', false)}${row('Asset and amount', 'PUBLIC', false)}${row('Your balance afterwards', 'ENCRYPTED', true)}`
      : move === 'withdraw'
        ? `${row('Your wallet and the destination', 'PUBLIC', false)}${row('Asset and amount', 'PUBLIC', false)}${row('What remains in your balance', 'ENCRYPTED', true)}`
        : (publicSend() ? PUBLIC_SEND_VISIBILITY : move === 'send' ? SEND_VISIBILITY : burnVisibility(selectedAsset()?.source ?? 'private')).map(([label, value, hidden]) => row(label, value, hidden)).join('');
  byId('move-visibility').innerHTML = `<div class="visibility-title">What an observer sees</div>${rows}`;
  byId('move-button').textContent = move === 'deposit' ? 'Shield into Rings' : move === 'withdraw' ? 'Unshield to public' : publicSend() ? 'Send publicly' : move === 'send' ? 'Send privately' : 'Burn for good';
  byId('move-button').classList.toggle('is-danger', move === 'burn');
  applyPayRequest();
  renderMoveHint();
  renderPayRequest();
}

function renderMoveHint(): void {
  const asset = selectedAsset();
  setText('move-unit', asset ? labelOf(asset.mint).replace('$', '') : '');
  const unread = spendsPrivate(asset) && !synced;
  setText(
    'move-hint',
    move === 'burn' && !asset
      ? 'Only tokens launched on this site can be burned here, and this wallet holds none.'
      : unread
        ? syncProblem
          ? 'Private available: not read. See Private holdings below.'
          : 'Private available: reading…'
        : asset
          ? `${asset.source === 'public' ? 'Public' : 'Private'} available: ${amountText(asset.available, asset.decimals, asset.decimals === SOL_DECIMALS ? 6 : 2)}${
              publicSend() && asset.mint === SOL ? '. MAX sends all of it and leaves nothing here for fees.' : ''
            }`
          : '',
  );
  renderMoveEffect();
}

/** For a burn: what it does to the token's supply. Hidden for every other move. */
function renderMoveEffect(): void {
  const box = byId('move-effect');
  const asset = selectedAsset();
  const token = asset ? tokenOf(asset.mint) : undefined;
  box.hidden = move !== 'burn' || !asset || !token;
  if (box.hidden || !asset || !token) return;
  let amount = 0n;
  try {
    const text = byId<HTMLInputElement>('move-amount').value.trim();
    amount = text ? parseUnits(text, asset.decimals) : 0n;
  } catch {
    amount = 0n;
  }
  const supply = token.supply ? BigInt(token.supply) : null;
  const effect = supply !== null ? burnEffect(supply, amount) : null;
  const whole = (units: bigint) => amountText(units, TOKEN_DECIMALS, 2);
  box.innerHTML = `<dt>Destroyed, exactly</dt><dd class="quote-main">${amount > 0n ? `${escapeHtml(amountText(amount, TOKEN_DECIMALS, TOKEN_DECIMALS))} ${escapeHtml(labelOf(asset.mint))}` : '—'}</dd><dt>Supply now</dt><dd>${supply !== null ? whole(supply) : 'Not read yet'}</dd><dt>Supply after</dt><dd>${effect ? whole(effect.after) : '—'}</dd><dt>This burn, of the supply now</dt><dd>${effect ? `${effect.sharePct}%` : '—'}</dd><dt>Burned in all, after this</dt><dd>${effect ? `${whole(effect.burnedAfter)} · ${effect.burnedPct}%` : '—'}</dd><dt>You get back</dt><dd>Nothing</dd>`;
}

/**
 * On a narrow screen the Move form is put away until it is asked for, so what
 * the wallet holds comes straight after its card, as in a wallet app. The round
 * buttons, a holding's buttons and a link from the header's panel all bring it
 * out; its own close button puts it away again. A wide screen has room for it
 * beside the lists and always shows it: the styles do that, this only keeps
 * the mark they read.
 */
function showMoveForm(open: boolean): void {
  document.querySelector('.wallet-side')?.classList.toggle('move-open', open);
}

/** Opens the Move form on one action for one asset, as the buttons on a holding do. */
function openMove(next: Move, key: string, amount?: string): void {
  if (busy) return;
  showMoveForm(true);
  move = next;
  maxed = false;
  byId<HTMLInputElement>('move-amount').value = amount ?? '';
  byId<HTMLInputElement>('move-confirm').value = '';
  byId<HTMLInputElement>('move-recipient').value = next === 'withdraw' && session ? session.address : '';
  recipientKind = 'empty';
  byId('move-output').innerHTML = '';
  renderMove(key);
  // A form taller than the screen is shown from its top; one that fits is put in the middle.
  const form = byId('move-form');
  form.scrollIntoView({ behavior: 'smooth', block: form.getBoundingClientRect().height > window.innerHeight * 0.8 ? 'start' : 'center' });
}

document.querySelectorAll<HTMLButtonElement>('[data-move]').forEach((tab) => {
  tab.addEventListener('click', () => {
    if (busy) return;
    move = tab.dataset.move as Move;
    maxed = false;
    byId<HTMLInputElement>('move-amount').value = '';
    byId<HTMLInputElement>('move-confirm').value = '';
    byId<HTMLInputElement>('move-recipient').value = move === 'withdraw' && session ? session.address : '';
    recipientKind = 'empty';
    byId('move-output').innerHTML = '';
    renderMove();
  });
});
byId<HTMLSelectElement>('move-asset').addEventListener('change', () => {
  maxed = false;
  renderMove();
});
byId<HTMLSelectElement>('move-source').addEventListener('change', () => {
  if (busy) return;
  sendSource = byId<HTMLSelectElement>('move-source').value === 'public' ? 'public' : 'private';
  maxed = false;
  byId<HTMLInputElement>('move-amount').value = '';
  byId('move-output').innerHTML = '';
  recipientKind = 'empty';
  renderMove();
  recipientTyped();
});
byId<HTMLInputElement>('move-amount').addEventListener('input', () => {
  maxed = false;
  renderMoveEffect();
  renderPayRequest();
});

/** What is in the recipient field changed, by typing or by a press on a wallet or a contact. */
function recipientTyped(): void {
  if (move !== 'send') return;
  renderPayRequest();
  window.clearTimeout(recipientTimer);
  if (sendSource === 'public') {
    renderRecipientHint();
    return;
  }
  // Say at once what the text alone shows; ask the chain after a pause in the typing.
  const quick = classifyRecipient(byId<HTMLInputElement>('move-recipient').value, session?.address ?? '');
  recipientKind = quick === 'candidate' ? 'checking' : quick;
  renderRecipientHint();
  if (quick === 'candidate') recipientTimer = window.setTimeout(lookAtRecipient, 350);
}
byId<HTMLInputElement>('move-recipient').addEventListener('input', recipientTyped);
document.querySelectorAll<HTMLButtonElement>('[data-move-share]').forEach((button) => {
  button.addEventListener('click', () => {
    const asset = selectedAsset();
    if (!asset) return;
    const units = (asset.available * BigInt(button.dataset.moveShare ?? '100')) / 100n;
    byId<HTMLInputElement>('move-amount').value = formatUnits(units, asset.decimals);
    maxed = button.dataset.moveShare === '100';
    renderMoveEffect();
    renderPayRequest();
  });
});

byId<HTMLFormElement>('move-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!session || busy) return;
  const asset = selectedAsset();
  if (!asset) {
    if (move === 'burn') statusBox('move-output', 'error', 'NOTHING TO BURN', 'Only tokens launched on this site can be burned here, and this wallet holds none.');
    return;
  }
  let amount: bigint;
  try {
    amount = parseUnits(byId<HTMLInputElement>('move-amount').value, asset.decimals);
  } catch (error) {
    statusBox('move-output', 'error', 'CHECK THE AMOUNT', escapeHtml(friendlyError(error)));
    return;
  }
  if (amount <= 0n) return statusBox('move-output', 'error', 'CHECK THE AMOUNT', 'Enter an amount greater than zero.');
  if (spendsPrivate(asset) && !synced) {
    return statusBox(
      'move-output',
      'error',
      'BALANCE NOT READ',
      syncProblem
        ? 'Your private balance could not be read, so nothing can be moved out of it yet. Nothing is lost. Use Try again under Private holdings.'
        : 'Your private balance is still being read. Try again in a moment.',
    );
  }
  if (amount > asset.available) return statusBox('move-output', 'error', 'NOT ENOUGH', `You have ${amountText(asset.available, asset.decimals, 6)} available.`);
  const recipientText = byId<HTMLInputElement>('move-recipient').value.trim();
  if (move === 'withdraw' && !isAddress(recipientText)) {
    return statusBox('move-output', 'error', 'CHECK THE ADDRESS', 'That is not a Solana address.');
  }
  if (move === 'send') {
    const first = classifyRecipient(recipientText, session.address);
    if (first !== 'candidate') {
      recipientKind = first;
      renderRecipientHint();
      return statusBox('move-output', 'error', 'CHECK THE ADDRESS', first === 'empty' ? 'Enter the recipient’s Solana address.' : escapeHtml(RECIPIENT_HINTS[first]));
    }
  }
  if (move === 'burn' && !burnConfirmed(byId<HTMLInputElement>('move-confirm').value)) {
    byId<HTMLInputElement>('move-confirm').focus();
    return statusBox('move-output', 'error', 'CONFIRM THE BURN', `Type ${BURN_WORD} in the box to confirm. A burn cannot be undone.`);
  }
  busy = true;
  const form = byId('move-form');
  form.classList.add('is-loading');
  const stage = (message: string) => statusBox('move-output', 'working', 'WORKING', escapeHtml(message));
  try {
    const mint = address(asset.mint);
    if (move === 'deposit' && nativeListed.has(asset.mint)) {
      stage('Verifying the native mint’s Privacy Rings registration…');
      if ((await readNativeAsset(connection(), asset.mint)).state !== 'registered') throw new Error('Native asset registration is not verified. Open its native token page first.');
    }
    // Where a token's accounts are depends on the token program its mint belongs to.
    const program = asset.mint === SOL || move === 'burn' ? TOKEN_PROGRAM_ID : await programFor(asset.mint);
    let signature: string;
    /** Null when nothing private moved, so the private balance on screen is neither confirmed nor stale. */
    let reread: boolean | null;
    /** What actually left, when that can differ from what was typed: a MAX send of public SOL. */
    let sentUnits = amount;
    if (move === 'burn' && asset.source === 'public') {
      signature = (await burnFromPublic(session, mint, amount, stage)).signature;
      reread = null;
    } else if (publicSend()) {
      const landed = await sendPublic(
        session,
        mint,
        amount,
        address(recipientText),
        maxed && asset.mint === SOL,
        stage,
        program === TOKEN_2022_PROGRAM_ID ? { decimals: asset.decimals } : undefined,
      );
      signature = landed.signature;
      sentUnits = landed.amount;
      reread = null;
    } else {
      if (move === 'send') {
        stage('Checking that the recipient can receive privately…');
        let registered: boolean | null;
        try {
          registered = await canReceivePrivately(address(recipientText));
        } catch {
          // Not being able to ask is not a no: the transfer itself is refused if the address is not registered.
          registered = null;
        }
        if (registered === false) {
          recipientKind = 'unregistered';
          renderRecipientHint();
          statusBox('move-output', 'error', 'RECIPIENT NOT REGISTERED', escapeHtml(RECIPIENT_HINTS.unregistered));
          return;
        }
      }
      if (move === 'withdraw' && recipientText !== session.address) {
        // Unshielding to somebody else's address: it has to be a wallet, not a token account or a program.
        stage('Checking the destination…');
        await requireWalletAddress(address(recipientText));
      }
      const landed =
        move === 'deposit'
          ? await deposit(session, mint, amount, stage, program)
          : move === 'withdraw'
            ? await withdraw(session, mint, amount, address(recipientText), stage, program)
            : move === 'send'
              ? await sendPrivate(session, mint, amount, address(recipientText), stage)
              : await burnFromPrivate(session, mint, amount, stage);
      signature = landed.signature;
      reread = landed.synced;
      noteSettled(landed);
    }
    // The request this payment answers, if the form was still paying the address it asked for.
    const paid = move === 'send' && payRequest !== null && payRequest.to === recipientText ? payRequest : null;
    try {
      if (move === 'send' && !publicSend()) {
        // A private history row names no recipient and carries no note: this browser keeps both beside the transaction.
        keepMemo(session.address, { signature, at: Date.now(), to: recipientText, ...(paid?.note ? { note: paid.note } : {}) });
      } else if (move === 'withdraw' && recipientText !== session.address) {
        keepMemo(session.address, { signature, at: Date.now(), to: recipientText });
      }
    } catch {
      // The money has moved. A note that could not be kept must never be told as a payment that failed.
    }
    if (paid) {
      payRequest = null;
      payOpenedFor = null;
    }
    const done = move === 'deposit' ? 'SHIELDED' : move === 'withdraw' ? 'UNSHIELDED' : publicSend() ? 'SENT' : move === 'send' ? 'SENT PRIVATELY' : 'BURNED';
    const detail = publicSend()
      ? `<br>${escapeHtml(amountText(sentUnits, asset.decimals, asset.decimals))} ${escapeHtml(labelOf(asset.mint))} sent, in public.`
      : move === 'send'
        ? `<br>On chain this shows the two wallets and nothing more. It appears in their private balance the next time their wallet reads it.${
            paid?.note ? `<br>Your note is kept with this payment in this browser, not on chain: “${escapeHtml(paid.note)}”` : ''
          }`
        : move === 'burn'
          ? `<br>${escapeHtml(amountText(amount, asset.decimals, asset.decimals))} ${escapeHtml(labelOf(asset.mint))} destroyed for good.`
          : '';
    statusBox('move-output', 'ok', done, `${txLink(signature)}${detail}${reread === false ? `<br>${escapeHtml(STALE_BALANCE_NOTE)}` : ''}`);
    toast(publicSend() ? 'Sent' : move === 'send' ? 'Private transfer sent' : move === 'deposit' ? 'Shielded' : move === 'withdraw' ? 'Unshielded' : 'Burn settled');
    maxed = false;
    byId<HTMLInputElement>('move-amount').value = '';
    byId<HTMLInputElement>('move-confirm').value = '';
    if (move === 'burn') {
      // The listing learns the new supply, and this page shows it.
      await api.refreshToken(asset.mint).catch(() => null);
      for (const token of await api.tokensByMints([asset.mint]).catch(() => [])) listed.set(token.mint, token);
    }
  } catch (error) {
    statusBox('move-output', 'error', 'NOT COMPLETED', escapeHtml(friendlyError(error)));
  } finally {
    busy = false;
    form.classList.remove('is-loading');
    await refreshPublic();
    await refreshAll();
    openLinks();
  }
});

/* ---------------- A payment request that came in a link ---------------- */

/** A payment link was opened with no wallet open: say that it is waiting, since nothing else on screen would. */
function renderPayBanner(): void {
  const node = byId('pay-banner');
  const read = session ? null : readPayLink(location.hash);
  node.hidden = !read;
  if (!read) return;
  node.innerHTML = read.ok
    ? '<strong>A payment request is waiting.</strong> Unlock or create a wallet and it opens in Send, for you to check before anything is sent.'
    : `<strong>This payment link cannot be used.</strong> ${escapeHtml(read.problem)}`;
}

const requestMint = (request: PayRequest): string => (request.token === PAY_SOL ? SOL : request.token);

/** Opens Send for the request that is waiting, for the wallet in use. Fills in nothing it cannot stand behind. */
function openPayRequest(): void {
  const request = payRequest;
  if (!request || !session || busy) return;
  payOpenedFor = session.address;
  payApplied = false;
  sendSource = 'private';
  openMove('send', requestMint(request));
  // To the wallet in use there is nothing to send: the card says so, and the recipient stays empty.
  if (request.to !== session.address) {
    byId<HTMLInputElement>('move-recipient').value = request.to;
    recipientTyped();
  }
  renderPayRequest();
}

/**
 * Puts the request's token and amount into the form, once, at the moment the
 * wallet turns out to hold that token. Until then the amount stays empty: an
 * amount meant for one token is never left standing next to another.
 */
function applyPayRequest(): void {
  const request = payRequest;
  if (!request || payApplied || !session || move !== 'send' || request.to === session.address) return;
  const mint = requestMint(request);
  const asset = moveAssets().find((candidate) => candidate.key === mint);
  if (!asset) return;
  byId<HTMLSelectElement>('move-asset').value = mint;
  if (request.amount !== null) {
    try {
      parseUnits(request.amount, asset.decimals);
      byId<HTMLInputElement>('move-amount').value = request.amount;
    } catch {
      // More decimal places than the token has: the card says so, and the amount is left for the payer.
    }
  }
  payApplied = true;
}

/** What stands between the request and the form as it is now, in a sentence. Empty when they agree. */
function payRequestGap(request: PayRequest, wallet: string): string {
  const mint = requestMint(request);
  const token = labelOf(mint);
  if (request.to === wallet) {
    return 'This link asks for a payment to the wallet in use. Switch to the wallet you want to pay from: the request waits here until you put it away.';
  }
  if (move !== 'send') return 'Open Send to pay it.';
  const asset = selectedAsset();
  if (!moveAssets().some((candidate) => candidate.key === mint)) {
    if (sendSource === 'private') return synced ? `You hold no ${token} privately. Shield some first, or choose your public balance under “Send from”.` : syncProblem ? 'Your private balance could not be read, so the form is not filled in yet.' : 'Reading your private balance…';
    return `Your public balance holds no ${token}.`;
  }
  if (!asset || asset.mint !== mint) return `The form is set to ${asset ? labelOf(asset.mint) : 'another token'}, not the token asked for.`;
  if (byId<HTMLInputElement>('move-recipient').value.trim() !== request.to) return 'The recipient in the form is not the address asked for.';
  if (request.amount !== null) {
    let asked: bigint;
    try {
      asked = parseUnits(request.amount, asset.decimals);
    } catch {
      return `The amount asked for has more decimal places than ${token} has. Ask for a new link, or enter the amount yourself.`;
    }
    const typed = byId<HTMLInputElement>('move-amount').value.trim();
    let entered: bigint | null = null;
    try {
      entered = typed ? parseUnits(typed, asset.decimals) : null;
    } catch {
      entered = null;
    }
    if (entered !== asked) return 'The amount in the form is not the amount asked for.';
    // Everything matches. What is left to say is whether the balance it would come from covers it.
    if ((asset.source === 'public' || synced) && asked > asset.available) {
      const have = `${amountText(asset.available, asset.decimals, 6)} ${token}`;
      return asset.source === 'public'
        ? `Your public balance holds ${have}, which does not cover this.`
        : `You hold ${have} privately, which does not cover this. Shield more first, or choose your public balance under “Send from”.`;
    }
  }
  return '';
}

function renderPayRequest(): void {
  const node = byId('pay-request');
  const request = payRequest;
  node.hidden = !request || !session;
  if (!request || !session) {
    node.innerHTML = '';
    return;
  }
  const mint = requestMint(request);
  const token = labelOf(mint);
  const known = request.to === session.address ? null : knownAs(request.to);
  const asked = request.amount === null ? `Any amount of ${token}` : `${groupDigits(request.amount)} ${token}`;
  const gap = payRequestGap(request, session.address);
  node.innerHTML = `<div class="pay-request-head"><span class="eyebrow">Payment request</span><button class="btn flat" type="button" data-pay-dismiss>Put away</button></div>
<div class="pay-request-amount">${escapeHtml(asked)}</div>
<dl class="pay-request-facts"><dt>To</dt><dd><span class="pay-request-address">${escapeHtml(request.to)}</span>${known ? `<small>${known.own ? 'Your wallet' : 'Contact'}: ${escapeHtml(known.name)}</small>` : ''}</dd>${
    mint === SOL ? '' : `<dt>Token</dt><dd><span class="pay-request-address">${escapeHtml(mint)}</span>${tokenOf(mint) ? `<small>${escapeHtml(nameOf(mint))}, launched here</small>` : ''}</dd>`
  }${request.note ? `<dt>Note</dt><dd>“${escapeHtml(request.note)}”</dd>` : ''}</dl>
${gap ? `<p class="pay-request-gap">${escapeHtml(gap)}</p>` : ''}
<p class="tiny dim">This came in a link, and anyone can make a link. Check the address with whoever asked you. Nothing is sent until you press the button below.</p>`;
  node.querySelector<HTMLButtonElement>('[data-pay-dismiss]')?.addEventListener('click', () => {
    payRequest = null;
    payOpenedFor = null;
    renderPayRequest();
  });
}

/* ---------------- Creator rewards ---------------- */

async function refreshRewards(): Promise<void> {
  const section = byId('rewards-section');
  const current = session;
  if (!current || !status?.rpcConfigured) {
    section.hidden = true;
    return;
  }
  let mine: TokenSummary[] = [];
  try {
    mine = (await api.tokensByCreator(current.address)).slice(0, 12);
  } catch {
    mine = [];
  }
  if (session !== current) return;
  for (const token of mine) listed.set(token.mint, token);
  section.hidden = mine.length === 0;
  if (mine.length === 0) return;
  const grid = byId('rewards');
  grid.innerHTML = mine
    .map(
      (token) =>
        `<article class="holding-card" data-reward-card="${escapeHtml(token.mint)}"><div class="holding-card-head"><div class="token-avatar">${tokenArt(token)}</div><div><span class="eyebrow">$${escapeHtml(token.symbol)}</span><h3>${escapeHtml(token.name)}</h3></div></div><div class="holding-amount" data-reward-amount>…</div><div class="holding-value" data-reward-note>READING THE POOL</div><div class="row-wrap"><button class="btn flat" type="button" data-reward-claim disabled>Claim privately</button><a class="btn flat" href="/token?mint=${encodeURIComponent(token.mint)}">Open</a></div></article>`,
    )
    .join('');
  for (const token of mine) {
    if (session !== current) return;
    const card = grid.querySelector<HTMLElement>(`[data-reward-card="${token.mint}"]`);
    if (!card) continue;
    const amountNode = card.querySelector<HTMLElement>('[data-reward-amount]');
    const noteNode = card.querySelector<HTMLElement>('[data-reward-note]');
    const button = card.querySelector<HTMLButtonElement>('[data-reward-claim]');
    if (!amountNode || !noteNode || !button) continue;
    if (token.modules) {
      // With fee modules on there is nothing to claim by hand: the modules pay the fees out.
      amountNode.textContent = 'AUTOMATIC';
      noteNode.textContent = moduleTag(token) ? `${moduleTag(token)} · FEE MODULES` : 'FEE MODULES';
      button.disabled = true;
      button.textContent = 'Paid out automatically';
      continue;
    }
    try {
      const env = await loadMarketEnv(token.mint);
      const available = await rewards(current, env);
      if (session !== current) return;
      // Rewards are paid in the token's pair token, so that is what they are counted in.
      const unit = token.pair;
      const minimum = inPairUnits(status, unit, MIN_CLAIM_LAMPORTS);
      const total = available.curve + available.pool;
      amountNode.textContent = withUnit(total, unit, 6);
      // A creator holds no pool position: after graduation the platform pays the creator's share itself.
      noteNode.textContent =
        available.positions.length > 0
          ? `CURVE ${withUnit(available.curve, unit, 4)} · POOL ${withUnit(available.pool, unit, 4)}`
          : `CURVE ${withUnit(available.curve, unit, 4)}`;
      button.disabled = total <= 0n || total < minimum;
      button.addEventListener('click', async () => {
        if (!session || busy) return;
        busy = true;
        button.disabled = true;
        try {
          const fresh = await loadMarketEnv(token.mint);
          const result = await claimRewards(session, fresh, minimum, (message) => {
            noteNode.textContent = message.toUpperCase();
          });
          noteSettled(result);
          toast(`Claimed ${withUnit(result.amount, unit, 6)} into your private balance`);
        } catch (error) {
          toast(friendlyError(error), 'error');
        } finally {
          busy = false;
          await refreshPublic();
          await refreshAll();
          void refreshRewards();
        }
      });
    } catch (error) {
      if (session !== current) return;
      amountNode.textContent = '—';
      noteNode.textContent = friendlyError(error).toUpperCase().slice(0, 80);
    }
  }
}

/* ---------------- Asking for a payment ---------------- */

/** Tokens a request can ask for: SOL, then every token this wallet holds, held or launched. */
function requestTokens(): string[] {
  const mints = new Set<string>();
  if (session) for (const holding of privateHoldings(session.ctx)) if (holding.mint !== SOL) mints.add(holding.mint);
  for (const mint of publicTokens.keys()) mints.add(mint);
  for (const mint of listed.keys()) mints.add(mint);
  return [PAY_SOL, ...mints];
}

function renderRequestForm(): void {
  const select = byId<HTMLSelectElement>('request-token');
  const before = select.value;
  const tokens = requestTokens();
  select.innerHTML = tokens.map((token) => `<option value="${escapeHtml(token)}">${escapeHtml(token === PAY_SOL ? 'SOL' : labelOf(token))}</option>`).join('');
  if (tokens.includes(before)) select.value = before;
}

const requestAsked = (record: Pick<PayRequestRecord, 'token' | 'amount'>): string => {
  const token = record.token === PAY_SOL ? 'SOL' : labelOf(record.token);
  return record.amount === null ? `Any amount of ${token}` : `${groupDigits(record.amount)} ${token}`;
};

/** The requests made in this browser for the wallet in use, newest first, each with a payment that fits it when there is one. */
function renderRequests(): void {
  const node = byId('request-list');
  if (!session) {
    node.innerHTML = '';
    return;
  }
  const wallet = session.address;
  const requests = readRequests(wallet).items;
  if (requests.length === 0) {
    node.innerHTML = '';
    return;
  }
  const fits = synced ? matchRequests(requests, historyRowsOf(session.ctx.wallet), SOL) : new Map();
  node.innerHTML = `<h3 class="request-list-title">Requests made in this browser</h3>${[...requests]
    .reverse()
    .map((record) => {
      const fit = fits.get(record.id) as { signature: string } | undefined;
      const made = new Date(record.at).toISOString().slice(0, 16).replace('T', ' ');
      return `<article class="request-item"><div><b>${escapeHtml(requestAsked(record))}</b>${record.note ? `<span>“${escapeHtml(record.note)}”</span>` : ''}<small>Made ${escapeHtml(made)} UTC</small>${
        fit ? `<small class="request-fit">An incoming private transfer of exactly this amount arrived after you made it: ${txLink(fit.signature, 4)}. The chain does not say what a payment was for.</small>` : ''
      }</div><div class="row-wrap"><button class="btn flat" type="button" data-request-copy="${escapeHtml(record.id)}">Copy link</button><button class="btn flat" type="button" data-request-drop="${escapeHtml(record.id)}">Remove</button></div></article>`;
    })
    .join('')}`;
  node.querySelectorAll<HTMLButtonElement>('[data-request-copy]').forEach((button) => {
    button.addEventListener('click', async () => {
      const record = requests.find((entry) => entry.id === button.dataset.requestCopy);
      if (!record) return;
      try {
        await navigator.clipboard.writeText(payLink(location.origin, { to: wallet, token: record.token, amount: record.amount, note: record.note }));
        toast('Link copied');
      } catch {
        toast('Clipboard blocked. Make the link again and copy it by hand.', 'error');
      }
    });
  });
  node.querySelectorAll<HTMLButtonElement>('[data-request-drop]').forEach((button) => {
    button.addEventListener('click', () => {
      dropRequest(wallet, button.dataset.requestDrop ?? '');
      renderRequests();
    });
  });
}

byId<HTMLFormElement>('request-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const current = session;
  if (!current) return;
  const token = byId<HTMLSelectElement>('request-token').value || PAY_SOL;
  const mint = token === PAY_SOL ? SOL : token;
  const typed = byId<HTMLInputElement>('request-amount').value.trim();
  const note = cleanNote(byId<HTMLInputElement>('request-note').value);
  let amount: string | null = null;
  let units: string | null = null;
  if (typed) {
    amount = cleanAmount(typed);
    if (amount === null) {
      return statusBox('request-output', 'error', 'CHECK THE AMOUNT', 'Enter a plain number above zero, like 0.5, or leave it empty to let the payer choose.');
    }
    // Asks the chain when the token has not been met yet. What it could not read is not guessed at.
    await decimalsOf(mint);
    const decimals = sureDecimals(mint);
    if (decimals === undefined) {
      return statusBox('request-output', 'error', 'TRY AGAIN IN A MOMENT', 'The decimals of that token could not be read from chain just now, so an amount of it cannot be written yet.');
    }
    try {
      units = parseUnits(amount, decimals).toString();
    } catch (error) {
      return statusBox('request-output', 'error', 'CHECK THE AMOUNT', escapeHtml(friendlyError(error)));
    }
  }
  if (registeredNow === false) {
    return statusBox('request-output', 'error', 'REGISTER FIRST', 'This wallet is not registered with Rings yet, so nobody can pay it privately. Press Register on the card above, then make the link.');
  }
  // Only a payment later than this moment can be this request's: the newest slot this wallet knows, or the chain's own if it answers quickly.
  let afterSlot = 0n;
  if (synced) for (const row of historyRowsOf(current.ctx.wallet)) if (row.slot > afterSlot) afterSlot = row.slot;
  try {
    const now = BigInt(await Promise.race([connection().getSlot('confirmed'), new Promise<never>((_resolve, reject) => window.setTimeout(() => reject(new Error('slow')), 3_000))]));
    if (now > afterSlot) afterSlot = now;
  } catch {
    // The wallet's own newest slot is used.
  }
  if (session !== current) return;
  const link = payLink(location.origin, { to: current.address, token, amount, note });
  const kept = keepRequest(current.address, { id: crypto.randomUUID(), at: Date.now(), afterSlot: afterSlot.toString(), token, amount, units, note });
  byId('request-output').innerHTML = `<div class="status ok"><b>LINK READY</b><br>Send it to whoever is paying. ${escapeHtml(requestAsked({ token, amount }))}${note ? `, “${escapeHtml(note)}”` : ''}.${
    kept ? '' : ' This browser would not keep it in the list below.'
  }</div><div class="request-link"><div class="qr-box" role="img" aria-label="The payment link as a QR code">${qrSvg(link)}</div><div class="request-link-text" id="request-link-text">${escapeHtml(link)}</div></div><div class="row-wrap" style="margin-top:12px"><button class="btn flat" type="button" data-copy data-copy-target="#request-link-text">Copy link</button></div>`;
  wireCopyButtons(byId('request-output'));
  renderRequests();
});

/* ---------------- Statement and check-up ---------------- */

const statementBox = mountStatement(byId('statement'), {
  address: () => session?.address ?? null,
  rows: () => (session && synced ? historyRowsOf(session.ctx.wallet) : null),
  notReady: () => (syncProblem ? 'Your private balance could not be read. Use Try again under Private holdings on the Tokens tab.' : 'Your private history is still being read. Try again in a moment.'),
});

const checkupBox = mountCheckup(byId('checkup'), () => session?.address ?? null);

/* ---------------- Alerts ---------------- */

function renderAlerts(): void {
  const on = byId<HTMLInputElement>('alerts-on');
  const system = byId<HTMLInputElement>('alerts-system');
  const settings = session ? alertSettings(session.address) : { on: false, system: false };
  on.checked = settings.on;
  system.checked = settings.on && settings.system;
  system.disabled = !settings.on;
  setText('alerts-note', settings.on ? 'On for this wallet, in this browser. It looks about every minute and a half while this site is open and the wallet is unlocked, less often in a background tab.' : 'Off. Alerts are kept per wallet and per browser.');
}

byId<HTMLInputElement>('alerts-on').addEventListener('change', () => {
  if (!session) return;
  const on = byId<HTMLInputElement>('alerts-on').checked;
  // Turning them on starts from now: nothing that is already in the history is announced.
  if (on) forgetSeen(session.address);
  if (!setAlertSettings(session.address, { on, system: on && alertSettings(session.address).system })) toast('This browser would not keep the setting.', 'error');
  renderAlerts();
  alertsChanged();
});

byId<HTMLInputElement>('alerts-system').addEventListener('change', async () => {
  const current = session;
  if (!current) return;
  const box = byId<HTMLInputElement>('alerts-system');
  let system = box.checked;
  if (system) {
    if (!('Notification' in window)) {
      system = false;
      toast('This browser has no system notifications.', 'error');
    } else {
      let permission: NotificationPermission = Notification.permission;
      if (permission === 'default') {
        try {
          permission = await Notification.requestPermission();
        } catch {
          permission = 'denied';
        }
      }
      if (permission !== 'granted') {
        system = false;
        toast('Notifications are blocked for this site in your browser’s settings.', 'error');
      }
    }
  }
  if (session !== current) return;
  setAlertSettings(current.address, { on: alertSettings(current.address).on, system });
  renderAlerts();
  alertsChanged();
});

// The watcher found something new for this wallet: the balance on screen is read again.
document.addEventListener('pcf:arrival', (event) => {
  const detail = (event as CustomEvent<{ address?: string }>).detail;
  if (!busy && session && detail?.address === session.address) void readPrivateBalance();
});

/* ---------------- Viewing pass ---------------- */

const VIEW_WORD = 'VIEW';
let viewpassFile: string | null = null;

function hideViewpass(): void {
  if (viewpassFile) URL.revokeObjectURL(viewpassFile);
  viewpassFile = null;
  setText('viewpass-text', '—');
  byId('viewpass-result').hidden = true;
  byId('viewpass-output').innerHTML = '';
  byId<HTMLInputElement>('viewpass-pass').value = '';
  byId<HTMLInputElement>('viewpass-confirm').value = '';
  byId<HTMLAnchorElement>('viewpass-file').href = '#';
}

byId<HTMLButtonElement>('viewpass-hide').addEventListener('click', hideViewpass);

byId<HTMLFormElement>('viewpass-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const current = session;
  if (!current || busy) return;
  const pass = byId<HTMLInputElement>('viewpass-pass');
  const confirm = byId<HTMLInputElement>('viewpass-confirm');
  if (pass.value.length < PASS_MIN_PASSPHRASE) {
    return statusBox('viewpass-output', 'error', 'PASSPHRASE TOO SHORT', `Use at least ${PASS_MIN_PASSPHRASE} characters. Whoever gets hold of the pass can try passphrases for as long as they like.`);
  }
  if (confirm.value.trim().toUpperCase() !== VIEW_WORD) {
    confirm.focus();
    return statusBox('viewpass-output', 'error', 'CONFIRM IT', `Type ${VIEW_WORD} in the box. A pass shows its holder everything this wallet does privately, and it cannot be taken back.`);
  }
  busy = true;
  statusBox('viewpass-output', 'working', 'SEALING', 'Making the pass in this browser…');
  let signature: Uint8Array | null = null;
  try {
    const seed = viewingSeed();
    signature = seed.signature;
    if (seed.address !== current.address) throw new Error('The wallet in use changed. Open the Keys tab again.');
    const text = await sealPass({ address: seed.address, seed: signature, passphrase: pass.value, created: Date.now(), name: byId('w-name').textContent ?? '' });
    if (session !== current) return;
    hideViewpass();
    viewpassFile = URL.createObjectURL(new Blob([`${text}\n`], { type: 'text/plain;charset=utf-8' }));
    const file = byId<HTMLAnchorElement>('viewpass-file');
    file.href = viewpassFile;
    file.download = `privacycash-viewing-pass-${current.address.slice(0, 8)}.txt`;
    setText('viewpass-text', text);
    byId('viewpass-result').hidden = false;
    statusBox('viewpass-output', 'ok', 'PASS READY', `It reads ${escapeHtml(short(current.address, 6, 6))} and nothing else. This site keeps no copy: save it now, and give the passphrase to the reader by another route.`);
  } catch (error) {
    statusBox('viewpass-output', 'error', 'NOT MADE', escapeHtml(friendlyError(error)));
  } finally {
    signature?.fill(0);
    busy = false;
  }
});

/* ---------------- The wallet's own tabs, and links into this page ---------------- */

const WALLET_TABS = ['tokens', 'activity', 'wallets', 'contacts', 'privacy', 'security'] as const;
type WalletTab = (typeof WALLET_TABS)[number];
/** What comes after the # in a link that opens the form on one of its tabs. */
const MOVE_LINKS: Readonly<Record<string, Move>> = Object.freeze({ shield: 'deposit', unshield: 'withdraw', send: 'send', burn: 'burn' });

const tabButton = (tab: WalletTab): HTMLElement | null => document.querySelector<HTMLElement>(`[data-wtab="${tab}"]`);

function showTab(tab: WalletTab): void {
  document.querySelectorAll<HTMLElement>('[data-wtab]').forEach((button) => button.setAttribute('aria-selected', String(button.dataset.wtab === tab)));
  document.querySelectorAll<HTMLElement>('[data-wpane]').forEach((pane) => {
    pane.hidden = pane.dataset.wpane !== tab;
  });
}

/**
 * The Wallets and Contacts tabs are for ghost wallets. With a wallet extension
 * connected their sections are hidden, and their tabs go with them.
 */
function syncTabs(): void {
  for (const [tab, section] of [
    ['wallets', 'wallets-section'],
    ['contacts', 'contacts-section'],
  ] as const) {
    const button = tabButton(tab);
    if (!button) continue;
    button.hidden = byId(section).hidden;
    if (button.hidden && button.getAttribute('aria-selected') === 'true') showTab('tokens');
  }
}

for (const section of ['wallets-section', 'contacts-section']) {
  new MutationObserver(syncTabs).observe(byId(section), { attributes: true, attributeFilter: ['hidden'] });
}

document.querySelectorAll<HTMLElement>('[data-wtab]').forEach((button) => {
  button.addEventListener('click', () => showTab(button.dataset.wtab as WalletTab));
});

// The round buttons on the card: each opens the form on its tab. Receive is wired with the card itself.
const WACT_ICONS = { deposit: 'shield', withdraw: 'unshield', send: 'send' } as const;
document.querySelectorAll<HTMLButtonElement>('[data-wact]').forEach((button) => {
  const act = button.dataset.wact as keyof typeof WACT_ICONS;
  const holder = button.querySelector('i');
  if (holder) holder.innerHTML = icon(WACT_ICONS[act]);
  button.addEventListener('click', () => {
    if (busy) return;
    // Send from the card is a private transfer, whatever the form was last used for.
    if (act === 'send') sendSource = 'private';
    openMove(act, SOL);
  });
});
{
  const holder = byId('w-receive').querySelector('i');
  if (holder) holder.innerHTML = icon('receive');
  byId('w-lock').innerHTML = icon('lock');
  const close = byId('move-close');
  close.innerHTML = icon('close');
  // Not while something is being sent: what it reports is written in this form.
  close.addEventListener('click', () => {
    if (!busy) showMoveForm(false);
  });
}

/**
 * Does what the address asked for after its #: opens a tab, opens the form
 * on Shield, Unshield, Send or Burn, or shows the QR code. The header's
 * wallet panel links here this way. It waits for a wallet to be open, and
 * then drops the fragment, so a reload does not do it twice.
 */
function followLink(): 'pay' | 'other' | null {
  if (!session || byId('view-wallet').hidden) return null;
  // A payment request is read first, and as it was written: an address is not the same in lower case.
  const request = readPayLink(location.hash);
  if (request) {
    history.replaceState(null, '', `${location.pathname}${location.search}`);
    if (!request.ok) {
      statusBox('w-output', 'error', 'PAYMENT LINK NOT USED', escapeHtml(request.problem));
      return 'other';
    }
    payRequest = request.request;
    payOpenedFor = null;
    return 'pay';
  }
  const wanted = location.hash.slice(1).toLowerCase();
  if (!wanted) return null;
  const moveTo = MOVE_LINKS[wanted];
  if ((WALLET_TABS as readonly string[]).includes(wanted)) {
    const button = tabButton(wanted as WalletTab);
    if (button && !button.hidden) {
      showTab(wanted as WalletTab);
      button.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  } else if (moveTo) {
    if (busy) return null;
    if (moveTo === 'send') sendSource = 'private';
    openMove(moveTo, SOL);
  } else if (wanted === 'receive') {
    if (byId('receive-panel').hidden) byId('w-receive').click();
    byId('receive-panel').scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else {
    return null;
  }
  history.replaceState(null, '', `${location.pathname}${location.search}`);
  return 'other';
}

/**
 * Follows the link in the address, and opens a payment request that is
 * waiting, once a wallet is open and the page is not in the middle of
 * something. Unlocking calls it again when it is done, because a link that
 * arrived while the passphrase was being checked would otherwise be left
 * where it was.
 */
function openLinks(): void {
  if (busy || !session || byId('view-wallet').hidden) return;
  followLink();
  if (payRequest && payOpenedFor !== session.address) openPayRequest();
}

window.addEventListener('hashchange', () => {
  if (session) openLinks();
  else renderPayBanner();
});

// The header's wallet panel can unlock, lock or switch the wallet too. Whatever it did, this page looks at which
// wallet is in use now and starts from there, as it does when it loads.
watchWallet({
  busy: () => busy,
  async changed() {
    await route();
  },
});

/* ---------------- Start ---------------- */

void (async () => {
  status = await mountRuntime();
  const banner = setupMessage(status);
  if (banner) {
    const node = byId('setup-banner');
    node.innerHTML = banner;
    node.hidden = false;
  }
  const elsewhere = otherAddresses(status?.origins, location.origin);
  if (elsewhere.length > 0) {
    const note = byId('other-address-note');
    note.textContent = `Looking for a wallet you already made? This site also runs at ${elsewhere.join(' and ')}, and a browser keeps each address apart. A ghost wallet made there shows only there: copy its secret key on that address, then use Import here.`;
    note.hidden = false;
  }
  await route();
})();
