/**
 * The read-only page: one wallet's private side, opened with a viewing pass.
 *
 * What is built here can read and cannot do anything else. The keys come
 * from the pass's derivation signature with no prover attached
 * (`shared/src/viewkeys.ts`), there is no signer anywhere on this page, and
 * no function on it builds a transaction. The opened pass lives in this
 * page's memory: it is written to no storage and sent to no server, and it
 * is gone when the tab is closed or the view is.
 */

import '../extras.css';

import { type LocalShieldedKeys, type Wallet, syncWallet } from '@heliuslabs/spr';

import { TOKEN_DECIMALS } from '../../../shared/src/constants.js';
import { SOL_MINT, historyRowsOf, newWalletState } from '../../../shared/src/privacy.js';
import { STATEMENT_KINDS } from '../../../shared/src/statement.js';
import { formatUnits, groupDigits } from '../../../shared/src/units.js';
import { viewerKeys } from '../../../shared/src/viewkeys.js';
import { openPass } from '../../../shared/src/viewpass.js';
import { ringsClient } from '../chain.js';
import { explorerTx, sol } from '../format.js';
import { mountRuntime, setupMessage } from '../shell.js';
import { mountStatement } from '../statement-ui.js';
import { type TokenFact, tokenFacts } from '../token-facts.js';
import { friendlyError } from '../trade.js';
import { byId, describeError, deterministicAvatar, escapeHtml, initShell, setText, short, toast } from '../ui.js';

initShell('wallet');

const SOL = SOL_MINT as string;

interface OpenView {
  readonly address: string;
  readonly name: string;
  readonly created: number;
  readonly keys: LocalShieldedKeys;
  /** This page's own copy of the wallet's notes, rebuilt from chain each time the pass is opened. */
  readonly wallet: Wallet;
}

let view: OpenView | null = null;
/** True once the wallet's notes have been read from chain for this view. */
let synced = false;
let reading = false;

function statusBox(id: string, kind: 'working' | 'ok' | 'error', title: string, body = ''): void {
  byId(id).innerHTML = `<div class="status ${kind === 'working' ? '' : kind}"><b>${escapeHtml(title)}</b>${body ? `<br>${body}` : ''}</div>`;
}

const statement = mountStatement(byId('view-statement'), {
  address: () => view?.address ?? null,
  rows: () => (view && synced ? historyRowsOf(view.wallet) : null),
  notReady: () => 'The wallet has not been read yet. Use Read again at the top of the page.',
});

function show(opened: boolean): void {
  byId('view-closed').hidden = opened;
  byId('view-opened').hidden = !opened;
}

function txLink(signature: string): string {
  return `<a class="tx-link" href="${escapeHtml(explorerTx(signature))}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(signature)}">${escapeHtml(short(signature, 4, 4))}</a>`;
}

const amountText = (raw: bigint, decimals: number, places = 4): string => groupDigits(formatUnits(raw, decimals, places));

function render(facts: Map<string, TokenFact>): void {
  const current = view;
  if (!current) return;
  const balances = current.wallet.balances().filter((balance) => balance.amount > 0n);
  const solBalance = balances.find((balance) => (balance.mint as string) === SOL)?.amount ?? 0n;
  setText('view-sol', `${sol(solBalance, 4)} SOL`);
  setText('view-sub', `Private SOL · ${balances.reduce((sum, balance) => sum + balance.utxos.length, 0)} notes in all`);

  const holdings = byId('view-holdings');
  holdings.innerHTML =
    balances.length === 0
      ? '<div class="empty-state">NOTHING HELD PRIVATELY</div>'
      : balances
          .map((balance) => {
            const mint = balance.mint as string;
            const fact = facts.get(mint) ?? { symbol: short(mint), decimals: TOKEN_DECIMALS, listed: false };
            const title = mint === SOL ? 'Solana' : fact.listed ? 'Launched on this site' : 'Unlisted asset';
            return `<article class="holding-card"><div class="holding-card-head"><div class="token-avatar">${deterministicAvatar(mint === SOL ? 'SOL' : mint)}</div><div><span class="eyebrow">${escapeHtml(fact.symbol)}</span><h3>${escapeHtml(title)}</h3></div></div><div class="holding-amount">${escapeHtml(amountText(balance.amount, fact.decimals))}</div><div class="holding-value">Encrypted, ${balance.utxos.length} note${balance.utxos.length === 1 ? '' : 's'}</div></article>`;
          })
          .join('');

  const rows = historyRowsOf(current.wallet).slice(-40).reverse();
  byId('view-history').innerHTML =
    rows.length === 0
      ? '<tr><td colspan="6">No private activity yet.</td></tr>'
      : rows
          .map((row) => {
            const fact = facts.get(row.asset) ?? { symbol: short(row.asset), decimals: TOKEN_DECIMALS, listed: false };
            const boundary = row.kind === 'deposit' || row.kind === 'publicWithdrawal';
            const direction = row.direction === 'inbound' ? 'In' : row.direction === 'outbound' ? 'Out' : 'Self';
            return `<tr><td>${escapeHtml(STATEMENT_KINDS[row.kind] ?? row.kind)}</td><td>${direction}</td><td>${escapeHtml(fact.symbol)}</td><td class="num">${escapeHtml(amountText(row.amount, fact.decimals))}</td><td>${boundary ? 'Amount public' : 'Amount encrypted'}</td><td>${txLink(row.signature)}</td></tr>`;
          })
          .join('');
}

/** Reads the wallet's notes from chain with the pass's keys. Reads only: there is nothing here that could send. */
async function read(): Promise<void> {
  const current = view;
  if (!current || reading) return;
  reading = true;
  byId<HTMLButtonElement>('view-refresh').disabled = true;
  statusBox('view-status', 'working', 'READING', 'Reading the wallet’s encrypted notes from chain and decrypting them here…');
  try {
    const client = await ringsClient();
    await syncWallet({ client, wallet: current.wallet, keys: current.keys });
    if (view !== current) return;
    const mints = [...new Set([...current.wallet.balances().map((balance) => balance.mint as string), ...historyRowsOf(current.wallet).map((row) => row.asset)])];
    const facts = await tokenFacts(mints);
    if (view !== current) return;
    synced = true;
    render(facts);
    byId('view-status').innerHTML = '';
  } catch (error) {
    if (view !== current) return;
    statusBox('view-status', 'error', 'NOT READ', `${escapeHtml(friendlyError(error))}<br><br>Nothing is wrong with the wallet: only this page failed to read it. Use Read again.`);
  } finally {
    reading = false;
    byId<HTMLButtonElement>('view-refresh').disabled = false;
  }
}

function close(): void {
  const current = view;
  view = null;
  synced = false;
  // The keys are wiped, not just dropped.
  try {
    current?.keys.destroy();
  } catch {
    // Already gone.
  }
  statement.reset();
  byId('view-holdings').innerHTML = '';
  byId('view-history').innerHTML = '<tr><td colspan="6">Reading…</td></tr>';
  byId('view-status').innerHTML = '';
  setText('view-sol', '—');
  setText('view-address', '—');
  byId<HTMLTextAreaElement>('view-pass').value = '';
  byId<HTMLInputElement>('view-passphrase').value = '';
  byId('view-output').innerHTML = '';
  show(false);
}

byId<HTMLInputElement>('view-file-input').addEventListener('change', async (event) => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  if (file.size > 20_000) {
    statusBox('view-output', 'error', 'NOT A PASS', 'That file is far larger than a viewing pass.');
    return;
  }
  try {
    byId<HTMLTextAreaElement>('view-pass').value = (await file.text()).trim();
    byId('view-output').innerHTML = '';
    byId<HTMLInputElement>('view-passphrase').focus();
  } catch {
    statusBox('view-output', 'error', 'NOT READ', 'The file could not be read. Paste the pass instead.');
  }
});

byId<HTMLFormElement>('view-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (view || reading) return;
  const pass = byId<HTMLTextAreaElement>('view-pass');
  const passphrase = byId<HTMLInputElement>('view-passphrase');
  const button = byId<HTMLButtonElement>('view-button');
  if (!pass.value.trim()) return statusBox('view-output', 'error', 'NO PASS', 'Paste the viewing pass, or choose the file it was saved as.');
  button.disabled = true;
  statusBox('view-output', 'working', 'OPENING', 'Checking the passphrase in this browser…');
  let seed: Uint8Array | null = null;
  try {
    const opened = await openPass(pass.value, passphrase.value);
    seed = opened.seed;
    // The SDK checks here that the pass really belongs to the wallet it names.
    const keys = await viewerKeys(opened.address, seed);
    view = { address: opened.address, name: opened.name, created: opened.created, keys, wallet: newWalletState(keys.address()) };
    synced = false;
    pass.value = '';
    passphrase.value = '';
    byId('view-output').innerHTML = '';
    setText('view-name', opened.name || 'Wallet');
    setText('view-address', opened.address);
    setText('view-sol', 'Reading…');
    setText('view-sub', `Private SOL · pass made ${new Date(opened.created).toISOString().slice(0, 10)}`);
    show(true);
    window.scrollTo({ top: 0 });
    void read();
  } catch (error) {
    statusBox('view-output', 'error', 'NOT OPENED', escapeHtml(describeError(error)));
  } finally {
    seed?.fill(0);
    button.disabled = false;
  }
});

byId<HTMLButtonElement>('view-refresh').addEventListener('click', () => void read());
byId<HTMLButtonElement>('view-close').addEventListener('click', () => {
  close();
  toast('View closed');
});

void (async () => {
  const status = await mountRuntime();
  const banner = setupMessage(status);
  if (banner) {
    const node = byId('setup-banner');
    node.innerHTML = banner;
    node.hidden = false;
  }
})();
