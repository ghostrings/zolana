/**
 * prvmax: the page for a wallet's vaults. It reads the wallet and its ten
 * vaults, shows them in one table, and runs the four things a person does
 * with them: get them ready, spread a balance across them, trade from them,
 * and recall everything to one wallet.
 *
 * Every run goes one vault after another and reports each step. A run that
 * could repeat a payment (spread, buy, sell) stops at the first failure and
 * reads the chain again, so nothing is ever sent twice by pressing again
 * blind. A recall carries on past a vault that fails, because recalling a
 * vault twice cannot move anything twice.
 */

import { type Address, address, isAddress } from '@solana/kit';
import { PublicKey } from '@solana/web3.js';

import type { PairRef, StatusResponse, TokenSummary } from '../../../shared/src/api.js';
import { GAS_RESERVE_LAMPORTS, SOL_DECIMALS, TOKEN_DECIMALS } from '../../../shared/src/constants.js';
import type { GhostQuote } from '../../../shared/src/ghost.js';
import { type PrivateHolding, privateHoldings } from '../../../shared/src/privacy.js';
import { pairSymbol, pairTokenByMint } from '../../../shared/src/quotes.js';
import { formatUnits, groupDigits, minusBps, parseUnits } from '../../../shared/src/units.js';
import {
  type ActivityEntry,
  CREATOR_MESSAGE,
  GHOST_TRADE_VISIBILITY,
  MAX_VAULTS,
  SPREAD_VISIBILITY,
  TRADE_VISIBILITY,
  VAULT_GAS_MAX_LAMPORTS,
  VAULT_GAS_MIN_LAMPORTS,
  VaultError,
  type VaultSetKind,
  activityTotals,
  appendActivity,
  creatorRefused,
  gasTopUps,
  hasGas,
  otherVaultSet,
  parseActivity,
  recallVisibility,
  shareOf,
  splitEvenly,
} from '../../../shared/src/vaults.js';
import { api } from '../api.js';
import { connection, publicLamports } from '../chain.js';
import { explorerAddress, explorerTx, sol } from '../format.js';
import { ensureWallet } from '../gate.js';
import { isSol, pairOf, tradeCap, withUnit } from '../pairs.js';
import { watchWallet } from '../session-bus.js';
import { mountRuntime, setupMessage } from '../shell.js';
import { type VaultHandle, type VaultSet, openVaults, readPrefs, savePrefs, vaultsReady } from '../subwallets.js';
import { STALE_BALANCE_NOTE, canReceivePrivately, ensureRegistered, friendlyError, ghostQuote } from '../trade.js';
import { byId, escapeHtml, initShell, short, toast, wireCopyButtons } from '../ui.js';
import { PRVMAX_LOG_PREFIX, storage } from '../vault.js';
import {
  PROOF_SPACING_MS,
  type RecallResult,
  type TradeToken,
  VAULT_SOL,
  VaultNotice,
  type VaultState,
  type VaultTrade,
  fundGas,
  readVaultStates,
  recallVault,
  registerVault,
  spreadTo,
  vaultBuy,
  vaultGhost,
  vaultSell,
} from '../vault-flows.js';
import { type Session, WalletError, ownAddresses } from '../wallet.js';

initShell('prvmax');

type Tab = 'ready' | 'spread' | 'buy' | 'sell' | 'recall' | 'keys';
type Route = 'shielded' | 'ghost';
type Row = readonly [label: string, value: string, hidden: boolean];

const SOL = VAULT_SOL;
const DEFAULT_COUNT = 5;

let status: StatusResponse | null = null;
let main: Session | null = null;
let vaults: VaultSet | null = null;
let count = DEFAULT_COUNT;
/** All ten vaults as last read, in order. Empty until the first read. */
let states: VaultState[] = [];
let reading = false;
/** The wallet's own private balance: read, or why not. Never shown as a number when it was not read. */
let mainSynced = false;
let mainProblem: string | null = null;
let mainLamports: bigint | null = null;
let tab: Tab = 'ready';
let busy = false;
/** Tokens launched here, by mint, as far as this page has asked. */
const listed = new Map<string, TokenSummary>();
const lookedUp = new Set<string>();
const chainDecimals = new Map<string, number>();
/** The vaults someone unticked on each pane. Every other vault that can take part is ticked. */
const unticked: Record<'spread' | 'buy' | 'sell', Set<number>> = { spread: new Set(), buy: new Set(), sell: new Set() };
/** The vaults ticked on each pane, as last drawn. */
const picks: Record<'spread' | 'buy' | 'sell', number[]> = { spread: [], buy: [], sell: [] };
/** The token typed into Buy, once the listing has answered for it. */
let buyToken: TokenSummary | null = null;
let buyProblem = '';
let buyLookup = 0;
/** The desk's quote that is on screen, and what it was asked for. A Ghost fill never runs on numbers that were not shown. */
let ghostShown: { key: string; quote: GhostQuote; at: number } | null = null;
/** Whether the address Recall sends to can receive privately. Null while being asked; 'unknown' when the chain did not answer. */
let recallRegistered: boolean | 'unknown' | null = null;
let recallChecked = '';

/* ---------------- Small helpers ---------------- */

const fmt = (units: bigint, decimals: number, maxFraction = 4): string => groupDigits(formatUnits(units, decimals, Math.min(decimals, maxFraction)));
const select = (id: string): HTMLSelectElement => byId<HTMLSelectElement>(id);
const input = (id: string): HTMLInputElement => byId<HTMLInputElement>(id);
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
/** Public SOL to four places, and never "0" for an account that holds a little. */
const solText = (lamports: bigint): string => (lamports > 0n && lamports < 100_000n ? '<0.0001' : sol(lamports, 4));
const txLink = (signature: string): string =>
  `<a class="tx-link" href="${escapeHtml(explorerTx(signature, 'mainnet'))}" target="_blank" rel="noopener noreferrer">${escapeHtml(short(signature, 6, 6))}</a>`;

/**
 * Why something did not happen, for the person reading. A sentence this page or its flows wrote
 * is shown as written; anything from the chain or the network gets the site's usual explanation.
 */
function explain(error: unknown): string {
  return error instanceof VaultNotice || error instanceof VaultError || error instanceof WalletError ? error.message : friendlyError(error);
}

function pairByMint(mint: string): PairRef | undefined {
  return status?.pairs.find((pair) => !pair.native && pair.mint === mint);
}

function decimalsOf(mint: string): number {
  if (mint === SOL) return SOL_DECIMALS;
  if (listed.has(mint)) return TOKEN_DECIMALS;
  return pairByMint(mint)?.decimals ?? chainDecimals.get(mint) ?? TOKEN_DECIMALS;
}

function symbolOf(mint: string): string {
  if (mint === SOL) return 'SOL';
  const token = listed.get(mint);
  if (token?.symbol) return `$${token.symbol}`;
  const pairToken = pairTokenByMint(mint);
  return pairToken && !pairToken.native ? pairSymbol(pairToken) : short(mint, 4, 4);
}

const amountOf = (units: bigint, mint: string, maxFraction = 4): string => `${fmt(units, decimalsOf(mint), maxFraction)} ${symbolOf(mint)}`;

/** What a token is bought with and sold for, as Rings names it. */
const payAssetOf = (token: TokenSummary): Address => (isSol(token.pair) ? SOL : address(token.pair.mint));

/** Asks the listing about these mints, and the chain for the decimals of the ones that were not launched here. */
async function learn(mints: readonly string[]): Promise<void> {
  const unknown = [...new Set(mints)].filter((mint) => mint !== SOL && !lookedUp.has(mint) && isAddress(mint));
  if (unknown.length === 0) return;
  for (const mint of unknown) lookedUp.add(mint);
  try {
    for (const token of await api.tokensByMints(unknown)) listed.set(token.mint, token);
  } catch {
    for (const mint of unknown) lookedUp.delete(mint);
  }
  await Promise.all(
    unknown
      .filter((mint) => !listed.has(mint) && !pairByMint(mint) && !chainDecimals.has(mint))
      .map(async (mint) => {
        try {
          chainDecimals.set(mint, (await connection().getTokenSupply(new PublicKey(mint))).value.decimals);
        } catch {
          // Shown with six places until it can be read.
        }
      }),
  );
}

const handleOf = (index: number): VaultHandle => (vaults as VaultSet).all[index - 1] as VaultHandle;
const vaultAddresses = (): string[] => (vaults ? vaults.all.map((vault) => vault.address) : []);
/** The vaults, and the other wallets kept in this browser beside the one in use: all of them count as the creator's own. */
const ownSet = (): string[] => [...vaultAddresses(), ...ownAddresses()];
const inUse = (): VaultState[] => states.filter((state) => state.index <= count);
/** Registered, and holding the public SOL the flows ask for. */
const isReady = (state: VaultState): boolean => state.registered === true && state.lamports !== null && hasGas(state.lamports);
/** What a vault holds privately of one asset. Null when its balance was not read. */
const heldOf = (state: VaultState, mint: string): bigint | null => (state.holdings === null ? null : (state.holdings.find((holding) => holding.mint === mint)?.amount ?? 0n));
const mayHold = (state: VaultState): boolean => state.lamports !== 0n || state.registered !== false || state.holdings === null || state.holdings.length > 0;
const mainHoldings = (): PrivateHolding[] => (main && mainSynced ? privateHoldings(main.ctx) : []);

function visibility(title: string, rows: readonly Row[] | null): void {
  const node = byId('px-visibility');
  node.hidden = rows === null;
  if (rows === null) return;
  node.innerHTML = `<div class="visibility-title">What an observer sees · ${escapeHtml(title)}</div>${rows
    .map(([label, value, hidden]) => `<dt>${escapeHtml(label)}</dt><dd class="${hidden ? 'is-hidden' : 'is-public'}">${escapeHtml(value)}</dd>`)
    .join('')}`;
}

function plan(id: string, rows: ReadonlyArray<readonly [string, string]>): void {
  byId(id).innerHTML = rows.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${value}</dd>`).join('');
}

/** The pane's button: what it says, and whether it can be pressed. `why` is shown under the plan when it cannot. */
function setButton(label: string, why: string | null): void {
  const button = byId<HTMLButtonElement>('px-button');
  button.textContent = busy ? 'Working…' : label;
  // Nothing can be planned, or pressed, before the vaults have been read once.
  button.disabled = busy || why !== null || states.length === 0;
  button.hidden = tab === 'keys';
  button.dataset.why = why ?? '';
}

function activityKey(): string {
  return PRVMAX_LOG_PREFIX + (main?.address ?? '');
}

function readActivity(): ActivityEntry[] {
  return parseActivity(storage('local')?.getItem(activityKey()));
}

function record(index: number, kind: 'buy' | 'sell', trade: VaultTrade): void {
  const entry: ActivityEntry = { at: Date.now(), kind, vault: index, mint: trade.mint, pair: trade.pair, quote: trade.quote.toString(), tokens: trade.tokens.toString(), signature: trade.signature, route: trade.route };
  try {
    storage('local')?.setItem(activityKey(), JSON.stringify(appendActivity(readActivity(), entry)));
  } catch {
    // The list is a convenience. A browser that will not store it loses nothing that is on chain.
  }
}

/* ---------------- Progress ---------------- */

let finished: string[] = [];

function progressStart(): void {
  finished = [];
  byId('px-output').innerHTML = '';
  byId('px-progress').innerHTML = '';
}

function progressDraw(current: string): void {
  byId('px-progress').innerHTML = `<div class="status"><b>WORKING</b><br><span class="px-now">${escapeHtml(current)}</span>${finished.length ? `<ul class="px-done">${finished.map((line) => `<li>${line}</li>`).join('')}</ul>` : ''}</div>`;
}

const stage = (message: string): void => progressDraw(message);

function stepDone(html: string): void {
  finished.push(html);
  progressDraw('…');
}

function finish(kind: 'ok' | 'error', title: string, body: string): void {
  byId('px-progress').innerHTML = '';
  byId('px-output').innerHTML = `<div class="status ${kind}"><b>${escapeHtml(title)}</b><br>${body}${finished.length ? `<ul class="px-done">${finished.map((line) => `<li>${line}</li>`).join('')}</ul>` : ''}</div>`;
}

/** Runs one action with the page locked, then reads everything again whatever happened. */
async function run(work: () => Promise<void>): Promise<void> {
  if (busy || !main || !vaults) return;
  busy = true;
  progressStart();
  renderPane();
  byId('px-form').classList.add('px-busy');
  try {
    // A read that is still under way finishes first: a vault is never read and spent from at the same moment.
    await reads.catch(() => undefined);
    await work();
  } catch (error) {
    finish('error', 'STOPPED', `${escapeHtml(explain(error))}<br><br>What settled before this stays settled. The table above has been read again from the chain: look at it before pressing anything a second time.`);
  } finally {
    busy = false;
    byId('px-form').classList.remove('px-busy');
    await refresh();
  }
}

/* ---------------- Reading ---------------- */

/** One read at a time: two reads of the same vault at once would trip over each other's notes. */
let reads: Promise<void> = Promise.resolve();

function refresh(): Promise<void> {
  reads = reads.then(readEverything, readEverything);
  return reads;
}

async function readEverything(): Promise<void> {
  if (!main || !vaults) return;
  reading = true;
  byId('px-read-note').textContent = 'Reading the chain…';
  const session = main;
  // What is read belongs to the set of vaults it was read for: if another set is on screen by then, it is dropped.
  const shown = vaults;
  const readMain = (async () => {
    try {
      await session.sync();
      mainSynced = true;
      mainProblem = null;
    } catch (error) {
      mainSynced = false;
      mainProblem = friendlyError(error);
    }
    mainLamports = await publicLamports(session.address).catch(() => null);
  })();
  const [, read] = await Promise.all([readMain, readVaultStates(shown.all)]);
  if (vaults !== shown) {
    reading = false;
    return;
  }
  states = read;
  await learn([...mainHoldings().map((holding) => holding.mint), ...states.flatMap((state) => (state.holdings ?? []).map((holding) => holding.mint)), ...readActivity().map((entry) => entry.mint)]);
  reading = false;
  const unread = states.filter((state) => state.lamports === null || state.registered === null || state.holdings === null).length;
  byId('px-read-note').textContent = unread > 0 ? `${plural(unread, 'vault')} could not be read in full. Nothing is lost: press Read again.` : mainProblem ? 'Your wallet’s private balance could not be read. Press Read again.' : '';
  renderAll();
}

/* ---------------- The vault table ---------------- */

function renderVaults(): void {
  const body = byId('px-vaults');
  if (states.length === 0) {
    body.innerHTML = '<tr><td colspan="6">Reading encrypted notes<span class="blink">_</span></td></tr>';
    return;
  }
  const shown = states.filter((state) => state.index <= count || mayHold(state));
  const rows = shown.map((state) => {
    const privateSol = heldOf(state, SOL);
    const others = state.holdings === null ? 'Not read' : state.holdings.filter((holding) => holding.mint !== SOL).map((holding) => escapeHtml(amountOf(holding.amount, holding.mint, 2))).join('<br>') || '—';
    const low = state.lamports !== null && state.registered === true && !hasGas(state.lamports) ? ' <span class="px-tag">low</span>' : '';
    const rings = state.registered === null ? 'Not read' : state.registered ? 'Registered' : 'Not yet';
    const aside = state.index > count ? ' <span class="px-tag">not in use</span>' : '';
    return `<tr><td><b>${state.index}</b>${aside}</td><td><a class="tx-link" href="${escapeHtml(explorerAddress(state.address, 'mainnet'))}" target="_blank" rel="noopener noreferrer">${escapeHtml(short(state.address, 4, 4))}</a> <button class="px-copy" type="button" data-copy="${escapeHtml(state.address)}">Copy</button></td><td class="num">${state.lamports === null ? 'Not read' : solText(state.lamports)}${low}</td><td>${rings}</td><td class="num">${privateSol === null ? 'Not read' : sol(privateSol, 4)}</td><td>${others}</td></tr>`;
  });
  // A total is only a number when something was read: an unread vault is never counted as holding nothing.
  const allRead = shown.every((state) => state.lamports !== null && state.holdings !== null);
  const publicTotal = shown.some((state) => state.lamports !== null) ? sol(shown.reduce((sum, state) => sum + (state.lamports ?? 0n), 0n), 4) : '—';
  const privateTotal = shown.some((state) => state.holdings !== null) ? sol(shown.reduce((sum, state) => sum + (heldOf(state, SOL) ?? 0n), 0n), 4) : '—';
  rows.push(`<tr class="px-total"><td colspan="2">All vaults${allRead ? '' : ', as far as read'}</td><td class="num">${publicTotal}</td><td></td><td class="num">${privateTotal}</td><td></td></tr>`);
  body.innerHTML = rows.join('');
  wireCopyButtons(body);
  const unusedBeyond = states.filter((state) => state.index > count && mayHold(state)).length;
  byId('px-vault-note').innerHTML =
    unusedBeyond > 0
      ? `<p class="small muted" style="margin-top:12px">${plural(unusedBeyond, 'vault')} beyond the ${count} in use still ${unusedBeyond === 1 ? 'holds or may hold' : 'hold or may hold'} something. A recall empties ${unusedBeyond === 1 ? 'it' : 'them'} too.</p>`
      : '';
}

/* ---------------- Portfolio and activity ---------------- */

function renderPortfolio(): void {
  const body = byId('px-portfolio');
  if (states.length === 0) return;
  const byMint = new Map<string, { own: bigint; inVaults: bigint; where: number[] }>();
  const slot = (mint: string) => {
    let entry = byMint.get(mint);
    if (!entry) {
      entry = { own: 0n, inVaults: 0n, where: [] };
      byMint.set(mint, entry);
    }
    return entry;
  };
  slot(SOL);
  for (const holding of mainHoldings()) slot(holding.mint).own += holding.amount;
  for (const state of states) {
    for (const holding of state.holdings ?? []) {
      const entry = slot(holding.mint);
      entry.inVaults += holding.amount;
      entry.where.push(state.index);
    }
  }
  const unreadVaults = states.some((state) => state.holdings === null);
  const rows = [...byMint.entries()]
    .sort(([a], [b]) => (a === SOL ? -1 : b === SOL ? 1 : symbolOf(a).localeCompare(symbolOf(b))))
    .map(([mint, entry]) => {
      const token = listed.get(mint);
      const name = token ? `<a class="tx-link" href="/token?mint=${encodeURIComponent(mint)}">${escapeHtml(symbolOf(mint))}</a>` : escapeHtml(symbolOf(mint));
      const decimals = decimalsOf(mint);
      const where = entry.where.length ? `Vault${entry.where.length === 1 ? '' : 's'} ${entry.where.join(', ')}` : '—';
      return `<tr><td>${name}</td><td class="num">${mainSynced ? fmt(entry.own, decimals) : 'Not read'}</td><td class="num">${fmt(entry.inVaults, decimals)}${unreadVaults ? ' +' : ''}</td><td class="num">${mainSynced ? fmt(entry.own + entry.inVaults, decimals) : '—'}</td><td>${where}</td></tr>`;
    });
  const vaultPublic = states.reduce((sum, state) => sum + (state.lamports ?? 0n), 0n);
  rows.push(
    `<tr class="px-total"><td>Public SOL, for fees</td><td class="num">${mainLamports === null ? 'Not read' : sol(mainLamports, 4)}</td><td class="num">${sol(vaultPublic, 4)}</td><td class="num">${mainLamports === null ? '—' : sol(mainLamports + vaultPublic, 4)}</td><td>Visible to everyone</td></tr>`,
  );
  body.innerHTML = rows.join('');
}

function renderActivity(): void {
  const entries = readActivity();
  const body = byId('px-activity');
  byId('px-activity-clear').hidden = entries.length === 0;
  if (entries.length === 0) {
    body.innerHTML = '<tr><td colspan="6">Nothing yet.</td></tr>';
    return;
  }
  body.innerHTML = activityTotals(entries)
    .map((line) => {
      const pair = pairOf(status, line.pair);
      const paid = (units: bigint): string => (units === 0n ? '—' : pair ? escapeHtml(withUnit(units, pair, 4)) : `${fmt(units, SOL_DECIMALS)} ${escapeHtml(line.pair)}`);
      const tokens = (units: bigint): string => (units === 0n ? '—' : fmt(units, TOKEN_DECIMALS, 2));
      return `<tr><td><a class="tx-link" href="/token?mint=${encodeURIComponent(line.mint)}">${escapeHtml(symbolOf(line.mint))}</a></td><td class="num">${tokens(line.bought)}</td><td class="num">${paid(line.spent)}</td><td class="num">${tokens(line.sold)}</td><td class="num">${paid(line.received)}</td><td class="num">${line.trades}</td></tr>`;
    })
    .join('');
}

/* ---------------- Ticking vaults ---------------- */

/** Draws the tick boxes of a pane. A vault that cannot take part is shown, greyed, with the reason. */
function renderPicks(pane: 'spread' | 'buy' | 'sell', usable: (state: VaultState) => string | null, detail: (state: VaultState) => string): number[] {
  const candidates = inUse();
  const off = unticked[pane];
  const chosen = candidates.filter((state) => usable(state) === null && !off.has(state.index)).map((state) => state.index);
  picks[pane] = chosen;
  const node = byId(`px-${pane}-picks`);
  node.innerHTML = candidates.length
    ? candidates
        .map((state) => {
          const reason = usable(state);
          return `<label class="px-pick${reason ? ' is-off' : ''}"><input type="checkbox" value="${state.index}" ${chosen.includes(state.index) ? 'checked' : ''} ${reason || busy ? 'disabled' : ''}><span><b>Vault ${state.index}</b><small>${escapeHtml(reason ?? detail(state))}</small></span></label>`;
        })
        .join('')
    : '<p class="small muted">Reading the vaults…</p>';
  node.querySelectorAll<HTMLInputElement>('input[type=checkbox]').forEach((box) => {
    box.addEventListener('change', () => {
      if (box.checked) off.delete(Number(box.value));
      else off.add(Number(box.value));
      ghostShown = null;
      renderPane();
    });
  });
  return chosen;
}

const notReady = (state: VaultState): string | null => (state.registered === null || state.lamports === null ? 'Not read' : state.registered !== true ? 'Not registered: use Get ready' : !hasGas(state.lamports) ? 'Low on public SOL: use Get ready' : null);

/* ---------------- Panes ---------------- */

function parseGas(): bigint | null {
  try {
    const target = parseUnits(input('px-gas').value, SOL_DECIMALS);
    return target >= VAULT_GAS_MIN_LAMPORTS && target <= VAULT_GAS_MAX_LAMPORTS ? target : null;
  } catch {
    return null;
  }
}

function paneReady(): void {
  const target = parseGas();
  const chosen = inUse();
  visibility('Getting vaults ready', [
    ['Your wallet and each vault', 'PUBLIC', false],
    ['That your wallet sent each vault SOL, and how much', 'PUBLIC', false],
    ['That each vault registered with Rings', 'PUBLIC', false],
  ]);
  if (states.length === 0) {
    plan('px-ready-plan', [['Vaults', 'Reading the chain…']]);
    return setButton('Get vaults ready', 'unread');
  }
  if (target === null) {
    plan('px-ready-plan', [['Public SOL for each vault', 'Enter between 0.02 and 0.2.']]);
    return setButton('Get vaults ready', 'bad-gas');
  }
  if (chosen.some((state) => state.lamports === null || state.registered === null)) {
    plan('px-ready-plan', [['Vaults', 'Some could not be read. Press Read again above.']]);
    return setButton('Get vaults ready', 'unread');
  }
  const transfers = gasTopUps(chosen.map((state) => ({ address: state.address, lamports: state.lamports as bigint })), target);
  const total = transfers.reduce((sum, transfer) => sum + transfer.lamports, 0n);
  const toRegister = chosen.filter((state) => state.registered !== true).length;
  const short = mainLamports !== null && total > 0n && mainLamports < total + GAS_RESERVE_LAMPORTS;
  plan('px-ready-plan', [
    ['Vaults in use', String(chosen.length)],
    ['Need public SOL', transfers.length ? `${transfers.length}, ${sol(total, 4)} SOL in all` : 'None'],
    ['Your wallet’s public SOL', mainLamports === null ? 'Not read' : `${sol(mainLamports, 4)} SOL${short ? ' · not enough: this needs 0.015 more than it sends' : ''}`],
    ['Need registering', toRegister ? String(toRegister) : 'None'],
    ['Your wallet signs', transfers.length ? 'One transaction' : 'Nothing'],
  ]);
  if (transfers.length === 0 && toRegister === 0) return setButton('Every vault is ready', 'done');
  setButton('Get vaults ready', short ? 'short' : null);
}

function spreadAsset(): Address | null {
  const value = select('px-spread-asset').value;
  return value ? address(value) : null;
}

function paneSpread(): void {
  visibility('A spread', SPREAD_VISIBILITY);
  const assets = select('px-spread-asset');
  const holdings = mainHoldings();
  const before = assets.value;
  assets.innerHTML = holdings.length
    ? holdings.map((holding) => `<option value="${escapeHtml(holding.mint)}">${escapeHtml(symbolOf(holding.mint))} · ${escapeHtml(fmt(holding.amount, decimalsOf(holding.mint)))} private</option>`).join('')
    : '<option value="">Nothing in your private balance</option>';
  if (holdings.some((holding) => holding.mint === before)) assets.value = before;
  const asset = spreadAsset();
  const chosen = renderPicks('spread', notReady, (state) => {
    const held = asset ? heldOf(state, asset) : null;
    return held === null ? 'Ready' : `Holds ${fmt(held, decimalsOf(asset as string))}`;
  });
  byId('px-spread-unit').textContent = asset ? symbolOf(asset) : '—';
  if (!mainSynced) {
    plan('px-spread-plan', [['Your private balance', mainProblem ? `Could not be read: ${escapeHtml(mainProblem)}` : 'Still being read…']]);
    return setButton('Spread privately', 'unread');
  }
  if (!asset) {
    plan('px-spread-plan', [['Your private balance', 'Empty. Deposit on the <a class="tx-link" href="/wallet">Wallet page</a> first.']]);
    return setButton('Spread privately', 'empty');
  }
  const balance = holdings.find((holding) => holding.mint === asset)?.amount ?? 0n;
  byId('px-spread-hint').textContent = `Your wallet holds ${fmt(balance, decimalsOf(asset))} ${symbolOf(asset)} privately.`;
  const token = listed.get(asset);
  if (token && creatorRefused([token.creator], (main as Session).address, ownSet())) {
    plan('px-spread-plan', [['Not this token', escapeHtml(CREATOR_MESSAGE)]]);
    return setButton('Spread privately', 'creator');
  }
  let total = 0n;
  let problem = '';
  try {
    total = input('px-spread-amount').value.trim() ? parseUnits(input('px-spread-amount').value, decimalsOf(asset)) : 0n;
  } catch (error) {
    problem = explain(error);
  }
  if (!problem && total > balance) problem = 'That is more than your wallet holds privately.';
  if (!problem && chosen.length === 0) problem = 'Tick at least one vault. A vault has to be ready first.';
  let shares: bigint[] = [];
  if (!problem && total > 0n) {
    try {
      shares = splitEvenly(total, chosen.length);
    } catch (error) {
      problem = explain(error);
    }
  }
  const each = shares[0];
  plan('px-spread-plan', [
    ['Vaults', String(chosen.length)],
    ['Each receives', each === undefined ? '—' : `${escapeHtml(fmt(each, decimalsOf(asset), 6))} ${escapeHtml(symbolOf(asset))}`],
    ['Your wallet signs', (main as Session).kind === 'ghost' ? 'Nothing to confirm: the ghost wallet signs here' : `${plural(chosen.length, 'time')}, once for each vault`],
    ['Takes about', chosen.length ? `${Math.max(1, Math.round((chosen.length * (PROOF_SPACING_MS + 6_000)) / 60_000))} min, one transfer after another` : '—'],
    ...(problem ? ([['Cannot spread', escapeHtml(problem)]] as const) : []),
  ]);
  setButton(chosen.length > 1 ? `Spread privately across ${chosen.length} vaults` : 'Spread privately', problem || total <= 0n ? 'invalid' : null);
}

function slippageChoices(id: string): void {
  const node = select(id);
  if (node.options.length > 0) return;
  const max = status?.slippage.maxBps ?? 1000;
  const fallback = status?.slippage.defaultBps ?? 100;
  const choices = [...new Set([50, 100, 300, 500, 1000, fallback])].filter((bps) => bps <= max).sort((a, b) => a - b);
  node.innerHTML = choices.map((bps) => `<option value="${bps}" ${bps === fallback ? 'selected' : ''}>${bps / 100}%</option>`).join('');
}

/** Fills a Route select for a token and answers which route is chosen. The desk trades tokens priced in SOL only. */
function routeChoices(id: string, token: TokenSummary | null): Route {
  const node = select(id);
  const ghostOk = Boolean(status?.desk.enabled) && token !== null && isSol(token.pair);
  const before = node.value;
  node.innerHTML = `<option value="shielded">Shielded: through the pool, in public</option>${ghostOk ? '<option value="ghost">Ghost fill: with the desk, token and size encrypted</option>' : ''}`;
  node.value = before === 'ghost' && ghostOk ? 'ghost' : 'shielded';
  const hint = byId(`${id}-hint`);
  if (node.value === 'ghost') {
    hint.textContent = `The desk fills up to ${sol(status?.desk.maxOrderLamports ?? '0', 4)} SOL a trade, only what it has in stock, and it sees the whole trade. Its spread is ${((status?.desk.spreadBps ?? 0) / 100).toFixed(2)}%. When it cannot fill, it says so and nothing is sent.`;
  } else if (ghostOk) {
    hint.textContent = 'A trade on the pool shows the vault, the token and the size. The Ghost desk can hide the token and the size, for small trades.';
  } else if (token && !isSol(token.pair)) {
    hint.textContent = `Priced in ${token.pair.symbol}, so the Ghost desk cannot trade it: the desk holds SOL only.`;
  } else {
    hint.textContent = status?.desk.enabled ? 'A trade on the pool shows the vault, the token and the size.' : 'A trade on the pool shows the vault, the token and the size. The Ghost desk is not switched on here.';
  }
  return node.value === 'ghost' ? 'ghost' : 'shielded';
}

/** The limit beside Route means two things: how far a pool price may move, or how much worse than the quote shown the desk may quote. */
function slipLabel(id: string, route: Route): void {
  const label = byId(id).querySelector('span');
  if (label) label.textContent = route === 'ghost' ? 'Refuse a quote worse by' : 'Slippage limit';
}

function tradingPause(): string | null {
  if (!status) return 'The server is not reachable.';
  if (status.limits.tradingPaused) return status.limits.notice ?? 'Trading through this site is paused for now. Spread and recall are not affected.';
  return null;
}

interface TradeLine {
  readonly index: number;
  /** What the vault pays: pair token for a buy, the token for a sell. */
  readonly amount: bigint;
}

/** What each ticked vault would spend on the Buy pane, and the first reason it cannot go ahead. */
function buyLines(chosen: readonly number[], token: TokenSummary): { lines: TradeLine[]; problem: string } {
  const asset = payAssetOf(token);
  const share = Number(select('px-buy-share').value) || 0;
  let typed = 0n;
  if (share === 0) {
    try {
      typed = input('px-buy-amount').value.trim() ? parseUnits(input('px-buy-amount').value, token.pair.decimals) : 0n;
    } catch (error) {
      return { lines: [], problem: friendlyError(error) };
    }
    if (typed <= 0n) return { lines: [], problem: '' };
  }
  const lines: TradeLine[] = [];
  for (const index of chosen) {
    const held = heldOf(states[index - 1] as VaultState, asset) ?? 0n;
    const amount = share > 0 ? shareOf(held, share) : typed;
    if (amount <= 0n) continue;
    if (amount > held) return { lines: [], problem: `Vault ${index} holds ${fmt(held, token.pair.decimals)} ${token.pair.symbol} privately, less than that.` };
    lines.push({ index, amount });
  }
  return { lines, problem: lines.length === 0 ? 'None of the ticked vaults holds anything to spend.' : '' };
}

function tokenLine(token: TokenSummary): string {
  return `<a class="tx-link" href="/token?mint=${encodeURIComponent(token.mint)}">$${escapeHtml(token.symbol || '???')}</a> · ${escapeHtml(token.name)} · priced in ${escapeHtml(token.pair.symbol)} · ${(token.feeBps / 100).toFixed(0)}% fee · ${token.stage === 'graduated' ? 'graduated pool' : token.stage === 'migrating' ? 'migrating' : 'on its curve'}`;
}

function ghostKey(side: 'buy' | 'sell', mint: string, lines: readonly TradeLine[]): string {
  return `${side}:${mint}:${lines.map((line) => `${line.index}=${line.amount}`).join(',')}`;
}

/** The desk's quote on screen, when it is for exactly this trade and not older than a minute. */
function shownQuote(key: string): GhostQuote | null {
  return ghostShown && ghostShown.key === key && Date.now() - ghostShown.at < 60_000 ? ghostShown.quote : null;
}

function ghostRows(side: 'buy' | 'sell', token: TokenSummary, quote: GhostQuote | null): Array<readonly [string, string]> {
  if (!quote) return [['The desk’s price', 'Press the button to ask the desk for a quote. Nothing is sent until you have seen it and pressed again.']];
  const tokens = (units: string): string => `${fmt(BigInt(units), TOKEN_DECIMALS, 2)} $${escapeHtml(token.symbol)}`;
  const coins = (units: string): string => `${sol(units, 6)} SOL`;
  return [
    ['The desk’s quote, first vault', side === 'buy' ? `${coins(quote.payAmount)} buys ${tokens(quote.receiveAmount)}` : `${tokens(quote.payAmount)} sells for ${coins(quote.receiveAmount)}`],
    ['The pool would give', side === 'buy' ? tokens(quote.referenceAmount) : coins(quote.referenceAmount)],
    ['Every vault after it', 'Gets its own quote. One that is worse than this by more than the limit beside Route is refused, and the run stops.'],
  ];
}

function paneBuy(): void {
  slippageChoices('px-buy-slip');
  const token = buyToken;
  const route = routeChoices('px-buy-route', token);
  visibility(route === 'ghost' ? 'A Ghost fill from a vault' : 'A trade from a vault', route === 'ghost' ? GHOST_TRADE_VISIBILITY : TRADE_VISIBILITY);
  slipLabel('px-buy-slip-field', route);
  byId('px-buy-unit').textContent = token ? token.pair.symbol : '—';
  input('px-buy-amount').disabled = busy || select('px-buy-share').value !== '';
  const hint = byId('px-buy-token');
  if (token) hint.innerHTML = tokenLine(token);
  else hint.innerHTML = buyProblem ? escapeHtml(buyProblem) : 'Paste the address of a token launched here. Find one on the <a class="tx-link" href="/">Market</a>.';
  const asset = token ? payAssetOf(token) : null;
  const chosen = renderPicks(
    'buy',
    (state) => notReady(state) ?? (asset && (heldOf(state, asset) ?? 0n) === 0n ? `Holds no ${token?.pair.symbol ?? 'pair token'} privately` : null),
    (state) => (asset ? `Holds ${fmt(heldOf(state, asset) ?? 0n, token?.pair.decimals ?? SOL_DECIMALS)} ${token?.pair.symbol ?? ''}` : 'Ready'),
  );
  const label = route === 'ghost' ? 'Ghost fill' : 'Buy';
  const pause = tradingPause();
  if (pause) {
    plan('px-buy-plan', [['Not now', escapeHtml(pause)]]);
    return setButton(label, 'paused');
  }
  if (!token) {
    plan('px-buy-plan', [['Token', 'Enter a token address above.']]);
    return setButton(label, 'no-token');
  }
  if (creatorRefused([token.creator], (main as Session).address, ownSet())) {
    plan('px-buy-plan', [['Not this token', escapeHtml(CREATOR_MESSAGE)]]);
    return setButton(label, 'creator');
  }
  if (token.stage === 'migrating') {
    plan('px-buy-plan', [['Not now', 'This curve is complete and is migrating to its pool. Trading resumes in a moment.']]);
    return setButton(label, 'migrating');
  }
  const { lines, problem: lineProblem } = buyLines(chosen, token);
  let problem = lineProblem || (chosen.length === 0 ? `Tick at least one vault that holds ${token.pair.symbol} privately. Spread some to your vaults first.` : '');
  const cap = tradeCap(status, token.pair);
  const largest = lines.reduce((most, line) => (line.amount > most ? line.amount : most), 0n);
  if (!problem && cap > 0n && largest > cap) problem = `Trades are limited to ${withUnit(cap, token.pair, 2)} each for now. Lower what each vault spends.`;
  if (!problem && route === 'ghost' && largest > BigInt(status?.desk.maxOrderLamports ?? '0')) problem = `The desk fills up to ${sol(status?.desk.maxOrderLamports ?? '0', 4)} SOL a trade. Lower what each vault spends, or use the Shielded route.`;
  const total = lines.reduce((sum, line) => sum + line.amount, 0n);
  const key = ghostKey('buy', token.mint, lines);
  const quote = route === 'ghost' ? shownQuote(key) : null;
  plan('px-buy-plan', [
    ['Vaults buying', lines.length ? lines.map((line) => line.index).join(', ') : '—'],
    ['Each spends', lines.length ? (lines.every((line) => line.amount === largest) ? escapeHtml(withUnit(largest, token.pair, 6)) : `up to ${escapeHtml(withUnit(largest, token.pair, 6))}`) : '—'],
    ['In all, at most', lines.length ? escapeHtml(withUnit(total, token.pair, 6)) : '—'],
    ...(route === 'ghost' ? ghostRows('buy', token, lines.length && !problem ? quote : null) : ([['Price', 'Each buy is priced against the pool when its turn comes. One buy moves the price for the next.'], ['What a buy does not use', `Stays in that vault as public ${escapeHtml(token.pair.symbol)} and comes back with a recall.`]] as const)),
    ...(problem ? ([['Cannot buy', escapeHtml(problem)]] as const) : []),
  ]);
  const ready = lines.length > 0 && !problem;
  setButton(route === 'ghost' ? (quote ? `Ghost fill from ${plural(lines.length, 'vault')}` : 'Ask the desk for a quote') : `Buy from ${plural(lines.length, 'vault')}`, ready ? null : 'invalid');
}

function sellToken(): TokenSummary | null {
  return listed.get(select('px-sell-token').value) ?? null;
}

function sellLines(chosen: readonly number[], token: TokenSummary): TradeLine[] {
  const share = Number(select('px-sell-share').value) || 100;
  return chosen.map((index) => ({ index, amount: shareOf(heldOf(states[index - 1] as VaultState, token.mint) ?? 0n, share) })).filter((line) => line.amount > 0n);
}

function paneSell(): void {
  slippageChoices('px-sell-slip');
  const tokens = select('px-sell-token');
  const held = new Map<string, bigint>();
  for (const state of inUse()) for (const holding of state.holdings ?? []) if (listed.has(holding.mint)) held.set(holding.mint, (held.get(holding.mint) ?? 0n) + holding.amount);
  const before = tokens.value;
  tokens.innerHTML = held.size
    ? [...held.entries()].map(([mint, amount]) => `<option value="${escapeHtml(mint)}">${escapeHtml(symbolOf(mint))} · ${escapeHtml(fmt(amount, TOKEN_DECIMALS, 2))} across vaults</option>`).join('')
    : '<option value="">No vault holds a token launched here</option>';
  if (held.has(before)) tokens.value = before;
  const token = sellToken();
  const route = routeChoices('px-sell-route', token);
  visibility(route === 'ghost' ? 'A Ghost fill from a vault' : 'A trade from a vault', route === 'ghost' ? GHOST_TRADE_VISIBILITY : TRADE_VISIBILITY);
  slipLabel('px-sell-slip-field', route);
  byId('px-sell-hint').innerHTML = token ? tokenLine(token) : '';
  const chosen = renderPicks(
    'sell',
    (state) => notReady(state) ?? (token && (heldOf(state, token.mint) ?? 0n) === 0n ? 'Holds none of it' : null),
    (state) => (token ? `Holds ${fmt(heldOf(state, token.mint) ?? 0n, TOKEN_DECIMALS, 2)}` : 'Ready'),
  );
  const label = route === 'ghost' ? 'Ghost fill' : 'Sell';
  const pause = tradingPause();
  if (pause) {
    plan('px-sell-plan', [['Not now', escapeHtml(pause)]]);
    return setButton(label, 'paused');
  }
  if (!token) {
    plan('px-sell-plan', [['Token', 'Nothing to sell: no vault in use holds a token launched here.']]);
    return setButton(label, 'no-token');
  }
  if (creatorRefused([token.creator], (main as Session).address, ownSet())) {
    plan('px-sell-plan', [['Not this token', escapeHtml(CREATOR_MESSAGE)]]);
    return setButton(label, 'creator');
  }
  if (token.stage === 'migrating') {
    plan('px-sell-plan', [['Not now', 'This curve is complete and is migrating to its pool. Trading resumes in a moment.']]);
    return setButton(label, 'migrating');
  }
  const lines = sellLines(chosen, token);
  const total = lines.reduce((sum, line) => sum + line.amount, 0n);
  const key = ghostKey('sell', token.mint, lines);
  const quote = route === 'ghost' ? shownQuote(key) : null;
  const problem = lines.length === 0 ? 'Tick at least one vault that holds this token.' : '';
  plan('px-sell-plan', [
    ['Vaults selling', lines.length ? lines.map((line) => line.index).join(', ') : '—'],
    ['In all', lines.length ? `${fmt(total, TOKEN_DECIMALS, 2)} $${escapeHtml(token.symbol)}` : '—'],
    ...(route === 'ghost' ? ghostRows('sell', token, lines.length ? quote : null) : ([['Price', 'Each sale is priced against the pool when its turn comes. One sale moves the price for the next.'], ['What it brings in', `Goes into that vault’s private ${escapeHtml(token.pair.symbol)} balance. Anything the pool pays above the guaranteed minimum stays in the vault, in public.`]] as const)),
    ...(problem ? ([['Cannot sell', escapeHtml(problem)]] as const) : []),
  ]);
  setButton(route === 'ghost' ? (quote ? `Ghost fill from ${plural(lines.length, 'vault')}` : 'Ask the desk for a quote') : `Sell from ${plural(lines.length, 'vault')}`, problem ? 'invalid' : null);
}

/** Where a recall sends everything: the address, or why there is none yet. */
function recallTarget(): { to: Address | null; problem: string } {
  if (select('px-recall-to').value === 'self') return { to: (main as Session).address, problem: '' };
  const text = input('px-recall-address').value.trim();
  if (!text) return { to: null, problem: 'Enter the address to send everything to.' };
  if (!isAddress(text)) return { to: null, problem: 'That is not a Solana address.' };
  if (vaultAddresses().includes(text)) return { to: null, problem: 'That is one of your own vaults. Choose a wallet outside them.' };
  return { to: address(text), problem: '' };
}

function paneRecall(): void {
  const self = select('px-recall-to').value === 'self';
  byId('px-recall-address-field').hidden = self;
  const privately = select('px-recall-mode').value === 'private';
  visibility(privately ? 'A private recall' : 'A public recall', recallVisibility(privately));
  const { to, problem: targetProblem } = recallTarget();
  const hint = byId('px-recall-hint');
  let problem = targetProblem;
  if (to && privately) {
    if (recallChecked !== to) {
      recallChecked = to;
      recallRegistered = null;
      canReceivePrivately(to).then(
        (registered) => {
          if (recallChecked !== to) return;
          recallRegistered = registered;
          if (tab === 'recall') renderPane();
        },
        () => {
          if (recallChecked !== to) return;
          recallRegistered = 'unknown';
          if (tab === 'recall') renderPane();
        },
      );
    }
    if (recallRegistered === null) hint.textContent = 'Checking that this address can receive privately…';
    else if (recallRegistered === 'unknown') hint.textContent = 'This address could not be checked right now. If it is not registered, each transfer is refused before anything moves.';
    else if (recallRegistered) hint.textContent = 'Registered with Rings: it can receive privately.';
    else if (self) hint.textContent = 'Your wallet is not registered with Rings yet, so the recall registers it first: one transaction, public, once.';
    else {
      hint.textContent = 'That address is not registered with Rings, so it cannot receive privately. Its owner registers on the Wallet page here, once. Or choose Publicly.';
      problem = problem || 'The destination cannot receive privately.';
    }
  } else {
    hint.textContent = privately ? '' : 'A withdrawal shows the vault, the destination, the token and the amount. For each token the destination has no account for yet, the vault pays about 0.002 SOL to open one.';
  }
  const holding = states.filter((state) => (state.holdings?.length ?? 0) > 0).length;
  const unread = states.filter((state) => state.holdings === null).length;
  const moves = states.reduce((sum, state) => sum + (state.holdings?.length ?? 0), 0);
  const stranded = states.filter((state) => (state.holdings?.length ?? 0) > 0 && state.lamports !== null && !hasGas(state.lamports));
  plan('px-recall-plan', [
    ['Goes to', to ? escapeHtml(short(to, 6, 6)) : '—'],
    ['Vaults holding something privately', `${holding} of ${MAX_VAULTS}${unread ? `, and ${unread} not read: the recall reads ${unread === 1 ? 'it' : 'them'} again` : ''}`],
    ['Private balances to move', moves ? `${moves}, one proof each` : unread ? 'None that were read' : 'None'],
    ['Then, from every vault', 'What trades left in its token accounts, and all of its public SOL'],
    ['Your wallet signs', privately && self && recallRegistered === false ? 'Its registration, once' : 'Nothing: each vault signs for itself'],
    ['Takes about', moves ? `${Math.max(1, Math.round((moves * (PROOF_SPACING_MS + 8_000)) / 60_000))} min` : 'Under a minute'],
    ...(stranded.length ? ([['Low on public SOL', `Vault${stranded.length === 1 ? '' : 's'} ${stranded.map((state) => state.index).join(', ')}: use Get ready first, or ${stranded.length === 1 ? 'it is' : 'they are'} skipped.`]] as const) : []),
    ...(problem ? ([['Cannot recall', escapeHtml(problem)]] as const) : []),
  ]);
  setButton('Recall everything', problem || (privately && recallRegistered === null && to !== null) ? 'invalid' : null);
}

function paneKeys(): void {
  visibility('', null);
  const node = select('px-key-vault');
  if (node.options.length === 0) node.innerHTML = Array.from({ length: MAX_VAULTS }, (_unused, index) => `<option value="${index + 1}">Vault ${index + 1}</option>`).join('');
  byId('px-keys-how').textContent =
    (main as Session).kind === 'ghost'
      ? 'Your vault keys are worked out from your ghost wallet’s secret key. Restore the wallet from that key, on any device, and the same ten vaults come back with it. Lose it, and the vaults are lost with the wallet, unless you kept their keys from here.'
      : `Your vault keys are worked out from a signature ${(main as Session).label} gave this page. They come back whenever the same wallet signs the same message the same way. This page refuses to open vaults that do not match the ones it set up, instead of showing you empty ones; if you hold anything worth keeping in a vault, keep its key from here as well.`;
  setButton('', 'keys');
}

function renderPane(): void {
  if (!main || !vaults) return;
  document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((button) => {
    button.classList.toggle('on', button.dataset.tab === tab);
    button.disabled = busy;
  });
  document.querySelectorAll<HTMLElement>('[data-pane]').forEach((pane) => {
    pane.hidden = pane.dataset.pane !== tab;
  });
  if (tab === 'ready') paneReady();
  else if (tab === 'spread') paneSpread();
  else if (tab === 'buy') paneBuy();
  else if (tab === 'sell') paneSell();
  else if (tab === 'recall') paneRecall();
  else paneKeys();
}

/* ---------------- The wallet's two sets of vaults ---------------- */

// "Standard", not "shared": nothing about it is shared with anybody else.
const SET_NAME: Record<VaultSetKind, string> = { signature: 'standard', seed: 'ghost-only' };
const SET_MEANS: Record<VaultSetKind, string> = {
  signature: 'The same ten vaults open from this ghost wallet and from a wallet extension that holds its key.',
  seed: 'These ten are made from this ghost wallet’s key directly. Only the ghost wallet opens them; a wallet extension cannot.',
};

function renderSet(): void {
  if (!main || !vaults) return;
  const note = byId('px-set-note');
  const twin = byId('px-twin');
  const how = byId('px-set-how');
  const flip = byId<HTMLButtonElement>('px-set-switch');
  if (main.kind !== 'ghost') {
    note.textContent = '';
    twin.hidden = true;
    flip.hidden = true;
    how.textContent =
      'One key leads to two sets of vaults. A wallet extension opens the standard set, and a ghost wallet holding the same key opens the same one. If this address made vaults as a ghost wallet before the two were brought together, those are its ghost-only set: they are not shown here, and they open from the ghost wallet, on this page.';
    return;
  }
  const other = otherVaultSet(vaults.kind);
  note.textContent = `Vault set: ${SET_NAME[vaults.kind]}. ${SET_MEANS[vaults.kind]}${vaults.certain ? '' : ' The chain did not say which set has been used, so this is the one shown before; press Read again later.'}`;
  twin.hidden = vaults.twinUsed !== true;
  byId('px-twin-text').textContent = `It is the ${SET_NAME[other]} set. What it holds is not in the table below.`;
  how.textContent = `One key leads to two sets of vaults. This page is showing the ${SET_NAME[vaults.kind]} set. ${SET_MEANS[vaults.kind]} The other is the ${SET_NAME[other]} set${
    vaults.twinUsed === true ? ', and it has been used' : vaults.twinUsed === false ? ', and nothing has ever happened at it' : ''
  }. Both belong to this wallet and both stay reachable from here. A wallet uses one: the page picks the one that has been used, and asks nothing of you unless both have.`;
  flip.hidden = false;
  flip.textContent = `Show the ${SET_NAME[other]} set`;
  flip.disabled = busy;
  byId<HTMLButtonElement>('px-twin-show').disabled = busy;
}

/** Shows the wallet's other set, and keeps it shown: a set somebody chose themselves is not changed for them. */
async function switchSet(): Promise<void> {
  if (!main || !vaults || busy || main.kind !== 'ghost') return;
  const next = otherVaultSet(vaults.kind);
  // A read that is under way finishes first, and nothing read for one set is shown beside the other's addresses.
  await reads.catch(() => undefined);
  if (busy) return;
  states = [];
  for (const pane of ['spread', 'buy', 'sell'] as const) {
    unticked[pane].clear();
    picks[pane] = [];
  }
  ghostShown = null;
  recallRegistered = null;
  recallChecked = '';
  byId('px-key-panel').hidden = true;
  byId('px-key-secret').textContent = '—';
  byId('px-output').innerHTML = '';
  byId('px-progress').innerHTML = '';
  await open(false, next);
  toast(`Showing the ${SET_NAME[next]} set`);
}

byId('px-twin-show').addEventListener('click', () => void switchSet());
byId('px-set-switch').addEventListener('click', () => void switchSet());

function renderAll(): void {
  renderSet();
  renderVaults();
  renderPortfolio();
  renderActivity();
  renderPane();
}

/* ---------------- Actions ---------------- */

async function doReady(): Promise<void> {
  const target = parseGas();
  if (target === null || !main || !vaults) return;
  const chosen = inUse();
  const funded = await fundGas(main, chosen.map((state) => ({ address: state.address, lamports: state.lamports ?? 0n })), target, stage);
  if (funded) stepDone(`${sol(funded.total, 4)} SOL sent to ${plural(funded.transfers.length, 'vault')} · ${txLink(funded.landed.signature)}`);
  for (const state of chosen) {
    if (state.registered === true) continue;
    await registerVault(handleOf(state.index), stage);
    stepDone(`Vault ${state.index} registered with Rings`);
  }
  finish('ok', 'VAULTS READY', `${plural(chosen.length, 'vault')} can now be sent to privately and can pay ${chosen.length === 1 ? 'its' : 'their'} own fees.`);
  toast('Vaults ready');
}

async function doSpread(): Promise<void> {
  const asset = spreadAsset();
  if (!asset || !main) return;
  const chosen = [...picks.spread];
  const shares = splitEvenly(parseUnits(input('px-spread-amount').value, decimalsOf(asset)), chosen.length);
  for (const [position, index] of chosen.entries()) {
    const amount = shares[position] as bigint;
    const landed = await spreadTo(main, handleOf(index), asset, amount, stage);
    stepDone(`Vault ${index} received ${escapeHtml(amountOf(amount, asset, 6))} · ${txLink(landed.signature)}`);
    if (!landed.synced && position < chosen.length - 1) {
      // The next transfer is built from the notes this wallet holds now. If they could not be
      // re-read, it would be built from notes the last transfer already spent, so it is not built.
      stage('Reading your private balance again before the next transfer…');
      try {
        await main.sync(landed.slot);
      } catch {
        throw new VaultNotice(`The transfer to vault ${index} settled, but your wallet’s private balance could not be read again afterwards, so the vaults after it were not sent to. Press Read again, then spread what is left to them.`);
      }
    }
  }
  input('px-spread-amount').value = '';
  finish('ok', 'SPREAD · SETTLED', `${plural(chosen.length, 'private transfer')}. On chain each shows your wallet and a vault, and nothing more.`);
  toast('Spread settled');
}

async function doTrade(side: 'buy' | 'sell'): Promise<void> {
  const token = side === 'buy' ? buyToken : sellToken();
  if (!token || !vaults) return;
  const chosen = [...picks[side]];
  const lines = side === 'buy' ? buyLines(chosen, token).lines : sellLines(chosen, token);
  if (lines.length === 0) return;
  const route: Route = select(`px-${side}-route`).value === 'ghost' ? 'ghost' : 'shielded';
  const tolerance = Number(select(`px-${side}-slip`).value) || status?.slippage.defaultBps || 100;
  const subject: TradeToken = { mint: token.mint, creator: token.creator };
  const first = lines[0] as TradeLine;
  let shown: GhostQuote | null = null;
  if (route === 'ghost') {
    const key = ghostKey(side, token.mint, lines);
    shown = shownQuote(key);
    if (!shown) {
      // Never fill on numbers that were not on screen: fetch, show, and wait for a second press.
      stage('Asking the desk for a quote…');
      ghostShown = { key, quote: await ghostQuote(side, token.mint, first.amount), at: Date.now() };
      finish('ok', 'THE DESK’S QUOTE IS ABOVE', 'Check it, then press again to fill. Nothing was sent.');
      return;
    }
    ghostShown = null;
  }
  let stale = false;
  for (const line of lines) {
    const handle = handleOf(line.index);
    let trade: VaultTrade;
    if (route === 'ghost' && shown) {
      // The same price as the quote that was shown, less the tolerance, scaled to this vault's size.
      const least = minusBps((line.amount * BigInt(shown.receiveAmount)) / BigInt(shown.payAmount), tolerance);
      trade = await vaultGhost(vaults, handle, subject, side, line.amount, least, stage);
    } else {
      const rules = { slippageBps: tolerance, cap: tradeCap(status, token.pair) };
      trade = side === 'buy' ? await vaultBuy(vaults, handle, subject, line.amount, rules, stage) : await vaultSell(vaults, handle, subject, line.amount, rules, stage);
    }
    record(line.index, side, trade);
    stale ||= !trade.synced;
    const tokens = `${fmt(trade.tokens, TOKEN_DECIMALS, 2)} $${escapeHtml(token.symbol)}`;
    const coins = escapeHtml(withUnit(trade.quote, token.pair, 6));
    const exact = trade.route === 'ghost';
    stepDone(side === 'buy' ? `Vault ${line.index} bought ${tokens} for ${exact ? '' : 'at most '}${coins} · ${txLink(trade.signature)}` : `Vault ${line.index} sold ${tokens} for ${exact ? '' : 'at least '}${coins} · ${txLink(trade.signature)}`);
  }
  void api.refreshToken(token.mint).catch(() => null);
  finish('ok', `${side === 'buy' ? 'BOUGHT' : 'SOLD'} · SETTLED`, `${plural(lines.length, 'trade')} from ${plural(lines.length, 'vault')}.${stale ? `<br>${escapeHtml(STALE_BALANCE_NOTE)}` : ''}`);
  toast(side === 'buy' ? 'Buys settled' : 'Sells settled');
}

function recallLine(result: RecallResult): string {
  const parts: string[] = [];
  for (const move of result.moved) parts.push(`${escapeHtml(amountOf(move.amount, move.mint, 6))} ${move.privately ? 'privately' : 'withdrawn'} · ${txLink(move.signature)}`);
  for (const move of result.movedPublic) parts.push(`${escapeHtml(amountOf(move.amount, move.mint, 6))} from its token account, in public · ${txLink(move.signature)}`);
  if (result.closed > 0) parts.push(`${plural(result.closed, 'token account')} closed`);
  if (result.swept > 0n) parts.push(`${sol(result.swept, 6)} public SOL`);
  for (const stuck of result.left) parts.push(`<b>left behind:</b> ${escapeHtml(amountOf(stuck.amount, stuck.mint, 6))} in a token account that could not be moved (${escapeHtml(stuck.reason.slice(0, 140))}). Give the vault SOL again with Get ready and recall again, or use its key from the Keys tab`);
  if (result.note && result.note !== 'Never used.') parts.push(escapeHtml(result.note));
  return `Vault ${result.index}: ${parts.length ? parts.join('; ') : 'nothing to recall'}`;
}

async function doRecall(): Promise<void> {
  const { to } = recallTarget();
  if (!to || !main || !vaults) return;
  const privately = select('px-recall-mode').value === 'private';
  if (privately && to === main.address) await ensureRegistered(main, stage);
  let emptied = 0;
  let arrivedPrivately = false;
  const failed: number[] = [];
  for (const handle of vaults.all) {
    try {
      const result = await recallVault(handle, to, privately, stage);
      if (result.note === 'Never used.') continue;
      if (result.moved.length + result.movedPublic.length > 0 || result.swept > 0n || result.closed > 0) emptied += 1;
      arrivedPrivately ||= result.moved.some((move) => move.privately);
      stepDone(recallLine(result));
    } catch (error) {
      // One vault's failure does not hold the others back: recalling a vault again cannot move anything twice.
      failed.push(handle.index);
      stepDone(`<b>Vault ${handle.index} was not finished:</b> ${escapeHtml(explain(error))}`);
    }
  }
  if (failed.length > 0) {
    finish('error', 'RECALL NOT FINISHED', `Vault${failed.length === 1 ? '' : 's'} ${failed.join(', ')} could not be emptied this time. Whatever is listed below as moved has moved. Press Recall again for the rest: a vault that is already empty is passed over, and nothing can be moved twice.`);
    return;
  }
  finish('ok', 'RECALLED', emptied > 0 ? `${plural(emptied, 'vault')} emptied into ${escapeHtml(short(to, 6, 6))}.${arrivedPrivately ? ' What arrived privately shows in that wallet’s private balance the next time it is read.' : ''}` : 'No vault held anything.');
  toast('Recall finished');
}

/* ---------------- Wiring ---------------- */

byId<HTMLFormElement>('px-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (byId<HTMLButtonElement>('px-button').disabled) return;
  if (tab === 'ready') void run(doReady);
  else if (tab === 'spread') void run(doSpread);
  else if (tab === 'buy') void run(() => doTrade('buy'));
  else if (tab === 'sell') void run(() => doTrade('sell'));
  else if (tab === 'recall') void run(doRecall);
});

document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((button) => {
  button.addEventListener('click', () => {
    if (busy) return;
    tab = (button.dataset.tab as Tab) ?? 'ready';
    byId('px-output').innerHTML = '';
    ghostShown = null;
    hideKey();
    renderPane();
  });
});

for (const id of ['px-gas', 'px-spread-amount', 'px-buy-amount', 'px-recall-address']) {
  input(id).addEventListener('input', () => {
    ghostShown = null;
    renderPane();
  });
}
for (const id of ['px-spread-asset', 'px-buy-share', 'px-buy-route', 'px-buy-slip', 'px-sell-token', 'px-sell-share', 'px-sell-route', 'px-sell-slip', 'px-recall-to', 'px-recall-mode']) {
  select(id).addEventListener('change', () => {
    ghostShown = null;
    if (id === 'px-sell-token') unticked.sell.clear();
    renderPane();
  });
}

document.querySelectorAll<HTMLButtonElement>('[data-spread-share]').forEach((button) => {
  button.addEventListener('click', () => {
    const asset = spreadAsset();
    if (!asset || busy) return;
    const balance = mainHoldings().find((holding) => holding.mint === asset)?.amount ?? 0n;
    if (balance <= 0n) return;
    input('px-spread-amount').value = formatUnits(shareOf(balance, Number(button.dataset.spreadShare)), decimalsOf(asset));
    renderPane();
  });
});

/** Looks the typed address up in the listing, a moment after the typing stops. */
function lookUpBuyToken(): void {
  const text = input('px-buy-mint').value.trim();
  const sequence = ++buyLookup;
  buyToken = null;
  ghostShown = null;
  buyProblem = '';
  if (text && !isAddress(text)) buyProblem = 'That is not a Solana address.';
  renderPane();
  if (!text || buyProblem) return;
  window.setTimeout(async () => {
    if (sequence !== buyLookup) return;
    try {
      const [found] = await api.tokensByMints([text]);
      if (sequence !== buyLookup) return;
      if (found) {
        listed.set(found.mint, found);
        buyToken = found;
        unticked.buy.clear();
      } else {
        buyProblem = 'That token was not launched here, so it cannot be traded here.';
      }
    } catch (error) {
      if (sequence !== buyLookup) return;
      buyProblem = friendlyError(error);
    }
    renderPane();
  }, 300);
}
input('px-buy-mint').addEventListener('input', lookUpBuyToken);

select('px-count').addEventListener('change', () => {
  if (!main || !vaults || busy) return;
  count = Math.min(MAX_VAULTS, Math.max(1, Number(select('px-count').value) || DEFAULT_COUNT));
  try {
    keepPrefs();
  } catch (error) {
    toast(explain(error), 'error');
  }
  renderAll();
});

byId('px-refresh').addEventListener('click', () => {
  if (!busy && !reading) void refresh();
});

byId('px-key-show').addEventListener('click', async () => {
  if (!main || !vaults) return;
  try {
    // The key of the vault that is on screen: of the set shown, not of the wallet's other one.
    byId('px-key-secret').textContent = await vaults.secret(Number(select('px-key-vault').value) || 1);
    byId('px-key-secret').classList.remove('is-shown');
    byId('px-key-panel').hidden = false;
  } catch (error) {
    toast(explain(error), 'error');
  }
});
const hideKey = (): void => {
  byId('px-key-secret').textContent = '—';
  byId('px-key-panel').hidden = true;
};
byId('px-key-hide').addEventListener('click', hideKey);
select('px-key-vault').addEventListener('change', hideKey);
byId('px-key-secret').addEventListener('click', () => byId('px-key-secret').classList.add('is-shown'));

byId('px-activity-clear').addEventListener('click', () => {
  storage('local')?.removeItem(activityKey());
  renderActivity();
  toast('List cleared');
});

// Leaving in the middle of a run abandons the vaults that were still waiting their turn.
window.addEventListener('beforeunload', (event) => {
  if (busy) event.preventDefault();
});

/* ---------------- Opening ---------------- */

function countChoices(id: string): void {
  select(id).innerHTML = Array.from({ length: MAX_VAULTS }, (_unused, index) => `<option value="${index + 1}" ${index + 1 === count ? 'selected' : ''}>${index + 1}</option>`).join('');
}

function showOpen(problem = ''): void {
  if (!main) return;
  byId('px-open').hidden = false;
  byId('px-main').hidden = true;
  countChoices('px-open-count');
  byId('px-open-text').textContent =
    main.kind === 'ghost'
      ? 'Your vault keys are worked out from your ghost wallet’s key, here in this browser. Nothing is sent anywhere, and nothing happens on chain until you use a vault.'
      : `${main.label} will be asked to sign one message${extensionHeld() ? '' : ', twice'}. That signature is the key to your vaults: it stays in this tab, and whoever has it can spend what the vaults hold, so only ever sign it on this site.${readPrefs(main.address) ? ' It has to lead to the same vaults this browser set up before; if it does not, nothing is opened.' : ' It is asked for twice to check that your wallet signs it the same way every time. A wallet that does not could never find its vaults again, and is refused.'}`;
  byId('px-open-output').innerHTML = problem ? `<div class="status error"><b>NOT OPENED</b><br>${escapeHtml(problem)}</div>` : '';
}

/**
 * Whether anything ever happened at a set of vault addresses: one of them
 * holds SOL, or the first has a transaction to its name (getting vaults
 * ready always starts with the first). Null when the chain did not answer,
 * which is never taken for "nothing there".
 */
async function everUsed(addresses: readonly Address[]): Promise<boolean | null> {
  try {
    const accounts = await connection().getMultipleAccountsInfo(addresses.map((entry) => new PublicKey(entry)), 'confirmed');
    if (accounts.some((account) => account !== null && account.lamports > 0)) return true;
    const first = addresses[0];
    if (!first) return false;
    return (await connection().getSignaturesForAddress(new PublicKey(first), { limit: 1 }, 'confirmed')).length > 0;
  } catch {
    return null;
  }
}

/** True when this browser holds a record an extension's signature is compared with. A ghost wallet's record of its ghost-only set is not one. */
function extensionHeld(): boolean {
  const prefs = main ? readPrefs(main.address) : null;
  return prefs !== null && prefs.set !== 'seed';
}

/**
 * Puts the number of vaults, and the set this browser shows for the wallet,
 * on record: the first vault's address marks the set. A set that was chosen
 * without the chain's answer is not recorded, and an extension never writes
 * over what a ghost wallet recorded for its ghost-only set. `pinned` is for
 * a set the person chose themselves.
 */
function keepPrefs(pinned?: boolean): void {
  if (!main || !vaults) return;
  const first = (vaults.all[0] as VaultHandle).address;
  const before = readPrefs(main.address);
  const same = before?.check === first;
  if (!vaults.certain && !same) return;
  if (main.kind !== 'ghost' && before?.set === 'seed') return;
  const keepPin = pinned ?? (same && before?.pinned === true);
  savePrefs(main.address, { count, check: first, set: vaults.kind, ...(keepPin ? { pinned: true } : {}) });
}

async function open(prompt: boolean, set?: VaultSetKind): Promise<void> {
  if (!main) return;
  try {
    vaults = await openVaults(main, { prompt, used: everUsed, ...(set ? { set } : {}) });
  } catch (error) {
    vaults = null;
    showOpen(explain(error));
    return;
  }
  if (!vaults) {
    showOpen();
    return;
  }
  try {
    // The first vault's address is kept: it marks the set, and keys which do not lead to it are noticed later.
    keepPrefs(set ? true : undefined);
  } catch {
    // A browser that stores nothing still works; it only forgets the number of vaults.
  }
  byId('px-open').hidden = true;
  byId('px-main').hidden = false;
  countChoices('px-count');
  const asked = new URL(location.href).searchParams.get('mint');
  if (asked && isAddress(asked)) {
    input('px-buy-mint').value = asked;
    tab = 'buy';
    lookUpBuyToken();
  }
  renderAll();
  await refresh();
}

byId<HTMLFormElement>('px-open-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!main) return;
  const button = byId<HTMLButtonElement>('px-open-button');
  button.disabled = true;
  count = Math.min(MAX_VAULTS, Math.max(1, Number(select('px-open-count').value) || DEFAULT_COUNT));
  const stored = readPrefs(main.address);
  if (stored && stored.count !== count) savePrefs(main.address, { ...stored, count });
  await open(true);
  button.disabled = false;
});

async function enter(): Promise<void> {
  if (!main) return;
  const prefs = readPrefs(main.address);
  count = prefs?.count ?? DEFAULT_COUNT;
  // A wallet that has opened its vaults here before goes straight in when the keys are at hand.
  if (prefs && vaultsReady(main)) await open(false);
  else showOpen();
}

void (async () => {
  status = await mountRuntime();
  const banner = setupMessage(status);
  if (banner) {
    const node = byId('setup-banner');
    node.innerHTML = banner;
    node.hidden = false;
  }
  main = await ensureWallet(byId('px-gate'), {
    purpose: 'to use vaults',
    onReady: (session) => {
      main = session;
      void enter();
    },
  });
  if (main) await enter();
})();

// The vaults on this page belong to the wallet it was opened with. If that wallet is locked, unlocked or
// switched from the header, the page starts over with whichever wallet is in use then.
watchWallet({
  busy: () => busy,
  changed() {
    location.reload();
  },
});
