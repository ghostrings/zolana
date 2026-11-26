import '../swap.css';

import { type Address, address, isAddress } from '@solana/kit';

import type { PairRef, StatusResponse } from '../../../shared/src/api.js';
import { GAS_RESERVE_LAMPORTS } from '../../../shared/src/constants.js';
import { privateBalance } from '../../../shared/src/privacy.js';
import { type OutsideToken, RINGS_INTERFACE_RENT_LAMPORTS, ringsAssetOf } from '../../../shared/src/routes.js';
import { formatUnits, groupDigits, minusBps, parseUnits } from '../../../shared/src/units.js';
import { publicLamports, publicTokenUnits } from '../chain.js';
import { USDC_QUICK_AMOUNTS } from '../convert.js';
import { decimalText, explorerAddress, explorerTx, sol } from '../format.js';
import { ensureWallet } from '../gate.js';
import { LookupError, type TokenLookup, lookUpToken, outsideTokenOf } from '../outside.js';
import { SOL_REF, amount as pairAmount, isSol, plain, quickAmounts, tradeCap, withUnit } from '../pairs.js';
import { watchWallet } from '../session-bus.js';
import { mountRuntime, setupMessage } from '../shell.js';
import {
  type OutsideBought,
  type OutsideBuyPlan,
  type OutsideSellPlan,
  outsideBuy,
  outsideSell,
  planOutsideBuy,
  planOutsideSell,
  shieldRest,
} from '../swap-flows.js';
import { type ConversionSource, STALE_BALANCE_NOTE, friendlyError, knowAsset } from '../trade.js';
import { byId, deterministicAvatar, escapeHtml, initShell, setText, short, toast, tokenArt, wireCopyButtons } from '../ui.js';
import { type Session, getSession } from '../wallet.js';

initShell('swap');

type Side = 'buy' | 'sell';

const form = byId<HTMLFormElement>('swap-form');
const amountInput = byId<HTMLInputElement>('sw-amount');
const slippageSelect = byId<HTMLSelectElement>('sw-slippage');
const restBox = byId<HTMLInputElement>('sw-rest');
const quoteBox = byId('sw-quote');
const tradeButton = byId<HTMLButtonElement>('sw-button');
const output = byId('sw-output');
const gate = byId('sw-gate');
const lookupForm = byId<HTMLFormElement>('lookup-form');
const lookupInput = byId<HTMLInputElement>('lookup-address');
const lookupButton = byId<HTMLButtonElement>('lookup-button');
const lookupOutput = byId('lookup-output');

let status: StatusResponse | null = null;
let session: Session | null = null;
/** The token on the page, as read from chain. Null until an address has been looked up. */
let lookup: TokenLookup | null = null;
let lookupSequence = 0;
let side: Side = 'buy';
/** What is paid with, or received: SOL unless USDC was chosen. */
let counterId = 'SOL';
/** Which balance a trade draws on. */
let source: ConversionSource = 'private';
let busy = false;
/** True once the private balance has been read from chain. Until then the figures on screen are not a balance. */
let synced = false;
let syncProblem: string | null = null;

let privateCounter = 0n;
let privateToken = 0n;
let publicSol = 0n;
/** Null while it has not been read. */
let publicCounter: bigint | null = null;
let publicToken: bigint | null = null;

let buyPlan: OutsideBuyPlan | null = null;
let sellPlan: OutsideSellPlan | null = null;
let quoteSequence = 0;
let quoteTimer: number | undefined;

/* ---------------- What is on the page ---------------- */

function counter(): PairRef {
  const assets = status?.convert?.assets ?? [];
  return assets.find((asset) => asset.id === counterId) ?? assets[0] ?? SOL_REF;
}

/** The Rings asset of what is paid with or received. */
function counterAsset(): Address {
  return ringsAssetOf(counter().mint);
}

function decimals(): number {
  return lookup?.facts.decimals ?? 0;
}

/** An amount of the token on the page, grouped, cut off (never rounded up) at `maxFraction` places. */
function tokenText(units: bigint, maxFraction = 4): string {
  return groupDigits(formatUnits(units, decimals(), Math.min(decimals(), maxFraction)));
}

/** The same to the last decimal place the token has, for a line that says "exactly". */
function tokenExact(units: bigint): string {
  return groupDigits(formatUnits(units, decimals()));
}

/** An amount of SOL or USDC to its last decimal place, with its ticker. */
function exact(units: bigint, unit: PairRef): string {
  return withUnit(units, unit, unit.decimals);
}

/** What to call the token on the page in a sentence. */
function symbol(): string {
  return lookup?.symbol ?? 'the token';
}

/** The token's ticker for the chip inside the amount field, which has room for a few letters only. */
function unitLabel(): string {
  const ticker = lookup?.listed?.symbol || lookup?.name?.symbol || '';
  return ticker ? [...ticker].slice(0, 6).join('') : 'TOKEN';
}

function slippageBps(): number {
  return Number(slippageSelect.value) || status?.slippage.defaultBps || 100;
}

function txLink(signature: string): string {
  return `<a class="tx-link" href="${escapeHtml(explorerTx(signature))}" target="_blank" rel="noopener noreferrer">${escapeHtml(short(signature, 10, 10))}</a>`;
}

function tradable(): { ok: boolean; reason: string } {
  if (!status) return { ok: false, reason: 'The server is not reachable.' };
  if (!status.rpcConfigured) return { ok: false, reason: 'This deployment has no RPC configured.' };
  if (!status.convert?.enabled || !status.convert.anyToken) return { ok: false, reason: 'Buying tokens that were not launched here is switched off on this site.' };
  if (status.limits.tradingPaused) return { ok: false, reason: status.limits.notice ?? 'Trading through this site is paused for now. Your wallet is not affected.' };
  if (!lookup) return { ok: false, reason: 'Paste a token’s address to start.' };
  if (lookup.listed) return { ok: false, reason: 'This token was launched here. It is traded on its own page.' };
  if (lookup.problems.length > 0) return { ok: false, reason: 'This token cannot be bought or sold here. The reasons are listed with it.' };
  if (side === 'buy' && lookup.place === 'restricted') {
    return { ok: false, reason: 'Nobody holds this token privately yet, and Rings does not currently let just anyone add a token.' };
  }
  return { ok: true, reason: '' };
}

/** The operator's per-trade limit, said in words, or null when `units` of SOL or USDC is within it. */
function overLimit(units: bigint, unit: PairRef): string | null {
  const cap = tradeCap(status, unit);
  return cap > 0n && units > cap ? `Trades are limited to ${withUnit(cap, unit, 2)} each for now.` : null;
}

function parseAmount(): bigint {
  const text = amountInput.value.trim();
  if (text === '') return 0n;
  return parseUnits(text, side === 'buy' ? counter().decimals : decimals());
}

/* ---------------- The token ---------------- */

function renderToken(): void {
  const card = byId('token-card');
  const problems = byId('token-problems');
  const factsSection = byId('facts-section');
  if (!lookup) {
    card.hidden = true;
    factsSection.hidden = true;
    problems.innerHTML = '';
    return;
  }
  const { facts, name, listed, mint } = lookup;
  card.hidden = false;
  factsSection.hidden = false;
  document.title = `${lookup.symbol} — Buy any token — privacycash.fun`;
  byId('tk-avatar').innerHTML = listed ? tokenArt(listed) : deterministicAvatar(mint);
  setText('tk-name', listed?.name || name?.name || name?.symbol || 'A token with no name');
  // What a token calls itself is its creator's text. It is said as that, and never as who the token is.
  setText(
    'tk-sub',
    listed
      ? `$${listed.symbol} · launched on this site`
      : name
        ? `Calls itself ${name.symbol ? `“${name.symbol}”` : 'by that name'}. Anybody can create a token with this name: the address below is what identifies it.`
        : 'It carries no name on chain. The address below is what identifies it.',
  );
  setText('tk-address', mint);
  byId<HTMLAnchorElement>('tk-explorer').href = explorerAddress(mint);
  const pills: string[] = [`<span class="tag">${facts.program === 'token-2022' ? 'Token-2022' : 'SPL Token'}</span>`, `<span class="tag">${facts.decimals} decimals</span>`];
  if (lookup.place === 'exists') pills.push('<span class="tag">Held privately already</span>');
  if (lookup.place === 'first') pills.push('<span class="tag">Not in Rings yet</span>');
  byId('tk-pills').innerHTML = pills.join('');

  if (listed) {
    problems.innerHTML = `<div class="status"><b>LAUNCHED HERE</b><br>This token was launched on this site, so it has a page of its own, with its curve or pool, Ghost fill and its private activity.<div class="row-wrap" style="margin-top:12px"><a class="btn flat" href="/token?mint=${encodeURIComponent(mint)}">Trade it there</a></div></div>`;
  } else if (lookup.problems.length > 0) {
    problems.innerHTML = `<div class="status error"><b>THIS TOKEN CANNOT BE BOUGHT HERE</b><ul class="swap-notes">${lookup.problems.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul></div>`;
  } else if (lookup.place === 'restricted') {
    problems.innerHTML =
      '<div class="status error"><b>NOT IN RINGS, AND IT CANNOT BE ADDED NOW</b><br>A token can be held privately once Rings has a vault for it. Nobody has made one for this token, and Rings does not currently let just anyone add a token. It cannot be bought into a private balance for now.</div>';
  } else {
    problems.innerHTML = '';
  }

  const yesNo = (key: string | null, yes: string, no: string): string => (key ? `${yes} <span class="dim" title="${escapeHtml(key)}">${escapeHtml(short(key, 4, 4))}</span>` : no);
  const place =
    lookup.place === 'exists'
      ? 'Yes. Somebody has deposited it before.'
      : lookup.place === 'first'
        ? `Not yet. The first deposit creates its vault and pays about ${sol(RINGS_INTERFACE_RENT_LAMPORTS, 4)} SOL of rent for it, once.`
        : lookup.place === 'restricted'
          ? 'No, and it cannot be added right now.'
          : 'Could not be read just now.';
  byId('tk-facts').innerHTML = [
    ['Address', `<span title="${escapeHtml(mint)}">${escapeHtml(short(mint, 6, 6))}</span>`],
    ['Token program', facts.program === 'token-2022' ? `Token-2022${facts.extensions.length > 0 ? ` · ${escapeHtml(facts.extensions.join(', '))}` : ''}` : 'SPL Token'],
    ['Decimals', String(facts.decimals)],
    ['Supply', escapeHtml(groupDigits(formatUnits(facts.supply, facts.decimals, 0)))],
    ['Can more be created', yesNo(facts.mintAuthority, 'Yes, by', 'No. Nobody can.')],
    ['Can accounts be frozen', yesNo(facts.freezeAuthority, 'Yes, by', 'No. Nobody can.')],
    ['Held in Rings', escapeHtml(place)],
  ]
    .map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`)
    .join('');
  byId('tk-notes').innerHTML = lookup.notes.length > 0 ? `<ul class="swap-notes">${lookup.notes.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>` : '';
  wireCopyButtons(card);
}

/** Looks a token up by its address and puts it on the page. An address that was superseded while it was read is dropped. */
async function find(text: string, fromLink = false): Promise<void> {
  const mint = text.trim();
  const sequence = ++lookupSequence;
  lookup = null;
  // What was read for the last token says nothing about the next one.
  privateToken = 0n;
  publicToken = null;
  clearQuote();
  output.innerHTML = '';
  renderToken();
  renderForm();
  if (mint === '') {
    lookupOutput.innerHTML = '';
    quoteBox.innerHTML = '<dt>Look up a token</dt><dd>—</dd>';
    return;
  }
  lookupButton.disabled = true;
  lookupOutput.innerHTML = '<div class="status"><b>READING THE CHAIN</b><br>Looking at what is at that address…</div>';
  quoteBox.innerHTML = '<dt>Look up a token</dt><dd>…</dd>';
  let found: TokenLookup | null = null;
  let problem = '';
  try {
    found = await lookUpToken(mint);
  } catch (error) {
    problem = error instanceof LookupError ? error.message : friendlyError(error);
  }
  if (sequence !== lookupSequence) return;
  lookupButton.disabled = false;
  if (!found) {
    lookupOutput.innerHTML = `<div class="status error"><b>${fromLink ? 'THIS LINK DOES NOT LEAD TO A TOKEN' : 'NO TOKEN THERE'}</b><br>${escapeHtml(problem)}</div>`;
    quoteBox.innerHTML = '<dt>Look up a token</dt><dd>—</dd>';
    return;
  }
  lookup = found;
  lookupOutput.innerHTML = '';
  // The address stays in the address bar, so the page can be reloaded or sent to somebody.
  const url = new URL(location.href);
  url.searchParams.set('mint', found.mint);
  history.replaceState(null, '', `${url.pathname}${url.search}`);
  amountInput.value = '';
  quoteBox.innerHTML = '<dt>Enter an amount</dt><dd>—</dd>';
  renderToken();
  renderForm();
  if (session) await readPrivateBalance();
  else await refreshBalances();
}

lookupForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (busy) return;
  void find(lookupInput.value);
});

// Pasting an address is the whole of the request: there is nothing else to type.
lookupInput.addEventListener('paste', () => {
  window.setTimeout(() => {
    if (!busy && isAddress(lookupInput.value.trim())) void find(lookupInput.value);
  }, 0);
});

/* ---------------- Balances ---------------- */

async function refreshBalances(): Promise<void> {
  const current = session;
  const token = lookup;
  const unit = counter();
  if (!current) {
    privateCounter = 0n;
    privateToken = 0n;
    publicSol = 0n;
    publicCounter = null;
    publicToken = null;
    renderBalances();
    renderQuick();
    return;
  }
  privateCounter = synced ? privateBalance(current.ctx, counterAsset()) : 0n;
  privateToken = synced && token ? privateBalance(current.ctx, address(token.mint)) : 0n;
  let lamports: bigint | null = null;
  try {
    lamports = await publicLamports(current.address);
  } catch {
    lamports = null;
  }
  const heldCounter = isSol(unit) ? lamports : await publicTokenUnits(current.address, unit.mint).catch(() => null);
  const heldToken = token ? await publicTokenUnits(current.address, token.mint, token.facts.programId).catch(() => null) : null;
  // The wallet, the token or what is paid with may have changed while these were read.
  if (session !== current || lookup !== token || counter().mint !== unit.mint) return;
  if (lamports !== null) publicSol = lamports;
  publicCounter = heldCounter;
  publicToken = heldToken;
  renderBalances();
  renderQuick();
}

function renderBalances(): void {
  const unit = counter();
  const reading = !session ? '—' : syncProblem ? 'Not read' : 'Reading…';
  const ticker = lookup ? symbol() : '';
  setText('sw-private-label', 'Private balance');
  setText('sw-private-counter', session && synced ? `${pairAmount(privateCounter, unit, 4)} ${unit.symbol}` : reading);
  setText('sw-private-token', !lookup ? 'no token looked up' : !session ? '—' : synced ? `${tokenText(privateToken)} ${ticker}` : `${reading} ${ticker}`.trim());
  setText('sw-public-label', 'Public balance');
  const publicTokenText = !lookup ? '—' : !session ? '—' : publicToken === null ? 'Not read' : `${tokenText(publicToken)} ${ticker}`;
  if (isSol(unit)) {
    setText('sw-public-counter', publicTokenText);
    setText('sw-public-token', lookup ? 'in your token account' : 'no token looked up');
  } else {
    setText('sw-public-counter', !session ? '—' : publicCounter === null ? 'Not read' : `${pairAmount(publicCounter, unit, 4)} ${unit.symbol}`);
    setText('sw-public-token', publicTokenText);
  }
  setText('sw-public-sol', session ? `${sol(publicSol, 4)} SOL` : '—');
}

/** Reads the private balance from chain. On failure the page says so, and nothing is traded out of it. */
async function readPrivateBalance(): Promise<void> {
  const current = session;
  if (!current) return;
  synced = false;
  syncProblem = null;
  renderBalances();
  renderQuick();
  try {
    // A token Rings has no place for yet is simply not held privately.
    if (lookup) await knowAsset(current, address(lookup.mint)).catch(() => undefined);
    await knowAsset(current, counterAsset()).catch(() => undefined);
    await current.sync();
    if (session !== current) return;
    synced = true;
  } catch (error) {
    if (session !== current) return;
    syncProblem = friendlyError(error);
  }
  await refreshBalances();
  scheduleQuote(0);
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

/* ---------------- The form ---------------- */

/** What the chosen balance holds of what this side spends, in base units. Null while it has not been read. */
function available(): bigint | null {
  if (!session) return null;
  if (side === 'buy') return source === 'private' ? (synced ? privateCounter : null) : publicCounter;
  return source === 'private' ? (synced ? privateToken : null) : publicToken;
}

function renderCounter(): void {
  const assets = status?.convert?.assets ?? [SOL_REF];
  setText('sw-counter-label', side === 'buy' ? 'Pay with' : 'Receive');
  const chosen = counter();
  const container = byId('sw-counter-options');
  container.innerHTML = assets
    .map((asset) => `<button type="button" class="${asset.mint === chosen.mint ? 'on' : ''}" data-counter="${escapeHtml(asset.id)}" aria-pressed="${asset.mint === chosen.mint}">${escapeHtml(asset.symbol)}</button>`)
    .join('');
  container.querySelectorAll<HTMLButtonElement>('button').forEach((option) => {
    option.addEventListener('click', () => {
      const picked = option.dataset.counter ?? 'SOL';
      if (busy || picked === counterId) return;
      counterId = picked;
      // A balance read in one currency is not a balance in another: until it is read again there is none to show.
      privateCounter = 0n;
      publicCounter = null;
      if (session) synced = false;
      amountInput.value = '';
      clearQuote();
      quoteBox.innerHTML = lookup ? '<dt>Enter an amount</dt><dd>—</dd>' : '<dt>Look up a token</dt><dd>—</dd>';
      output.innerHTML = '';
      renderForm();
      // The balance of what was chosen has to be read, and the wallet may not have met that token yet.
      if (session) void readPrivateBalance();
    });
  });
}

function renderSources(): void {
  const unit = counter();
  const option = (key: ConversionSource, title: string, copy: string): string =>
    `<label class="route ${source === key ? 'is-selected' : ''}"><input type="radio" name="sw-source" value="${key}" ${source === key ? 'checked' : ''}><span><b>${title}</b><span>${escapeHtml(copy)}</span></span></label>`;
  setText('sw-source-label', side === 'buy' ? 'Pay from' : 'Sell from');
  const container = byId('sw-sources');
  container.innerHTML =
    side === 'buy'
      ? option('private', 'Private balance', `Paid out of the ${unit.symbol} you hold in Rings. Which balance it came from stays encrypted.`) +
        option('public', 'Public balance', `Paid from the wallet’s ordinary ${unit.symbol}. For a wallet that has not shielded anything yet.`)
      : option('private', 'Private balance', 'Sells what you hold in Rings. That you held it there stays encrypted until this sale.') +
        option('public', 'Public balance', 'Sells what sits in the wallet’s ordinary token account.');
  container.querySelectorAll<HTMLInputElement>('input[name=sw-source]').forEach((input) => {
    input.addEventListener('change', () => {
      if (busy) return;
      source = input.value as ConversionSource;
      renderForm();
      scheduleQuote(0);
    });
  });
}

function renderVisibility(): void {
  const row = (label: string, value: string, hidden: boolean): string => `<dt>${label}</dt><dd class="${hidden ? 'is-hidden' : 'is-public'}">${value}</dd>`;
  const rows = [
    row('Your wallet', 'PUBLIC', false),
    row('Both tokens and the trade size', 'PUBLIC', false),
    ...(source === 'private' ? [row('The balance it came from', 'ENCRYPTED', true)] : []),
    row(side === 'buy' ? 'The balance it goes into' : 'The balance it returns to', 'ENCRYPTED', true),
    row('What Jupiter is told', 'WALLET, TOKENS, AMOUNT', false),
  ];
  byId('sw-visibility').innerHTML = `<div class="visibility-title">What an observer sees</div>${rows.join('')}`;
}

function renderQuick(): void {
  const quick = byId('sw-quick');
  const unit = counter();
  const held = available();
  const where = source === 'private' ? 'Private' : 'Public';
  if (side === 'buy') {
    const sized = quickAmounts(status, unit);
    const amounts = sized.length === 0 && unit.id === 'USDC' ? USDC_QUICK_AMOUNTS : sized;
    quick.innerHTML = `${amounts.map((value) => `<button type="button" data-amount="${escapeHtml(value)}">${escapeHtml(value)}</button>`).join('')}<button type="button" data-max>MAX</button>`;
    setText('sw-amount-hint', !session ? '' : held === null ? `${where} ${unit.symbol} available: ${source === 'private' && !syncProblem ? 'reading…' : 'not read'}` : `${where} ${unit.symbol} available: ${pairAmount(held, unit, 4)}`);
  } else {
    quick.innerHTML = '<button type="button" data-share="25">25%</button><button type="button" data-share="50">50%</button><button type="button" data-share="100">MAX</button>';
    setText('sw-amount-hint', !session || !lookup ? '' : held === null ? `${where} ${symbol()} available: ${source === 'private' && !syncProblem ? 'reading…' : 'not read'}` : `${where} ${symbol()} available: ${tokenText(held, 6)}`);
  }
  quick.querySelectorAll<HTMLButtonElement>('button').forEach((option) => {
    option.addEventListener('click', () => {
      if (busy) return;
      const now = available() ?? 0n;
      if (option.dataset.amount) amountInput.value = option.dataset.amount;
      else if (option.dataset.max !== undefined) {
        // Public SOL also pays the fees, the rent of the accounts a swap opens and, for a token nobody has
        // held privately, the rent of its place in Rings. Nothing else needs anything kept back.
        const reserve = source === 'public' && isSol(unit) ? GAS_RESERVE_LAMPORTS * 2n + (lookup?.place === 'first' ? RINGS_INTERFACE_RENT_LAMPORTS : 0n) : 0n;
        amountInput.value = plain(now > reserve ? now - reserve : 0n, unit);
      } else if (option.dataset.share) {
        amountInput.value = formatUnits((now * BigInt(option.dataset.share)) / 100n, decimals());
      }
      scheduleQuote(0);
    });
  });
}

function renderForm(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-side]').forEach((tab) => tab.classList.toggle('on', tab.dataset.side === side));
  renderCounter();
  renderSources();
  renderVisibility();
  renderBalances();
  renderQuick();
  setText('sw-amount-label', side === 'buy' ? 'You pay' : 'You sell');
  setText('sw-amount-unit', side === 'buy' ? counter().symbol : unitLabel());
  byId('sw-rest-field').hidden = side !== 'buy';
  refreshButton();
}

function refreshButton(): void {
  const state = tradable();
  const verb = side === 'buy' ? 'Buy' : 'Sell';
  tradeButton.textContent = !lookup ? 'Look up a token first' : !state.ok ? 'Not available' : side === 'buy' ? `${verb} into private balance` : `${verb} for ${counter().symbol}`;
  tradeButton.disabled = busy || !state.ok;
  lookupButton.disabled = busy;
}

function renderSlippage(): void {
  const max = status?.slippage.maxBps ?? 1000;
  const fallback = status?.slippage.defaultBps ?? 100;
  const choices = [...new Set([50, 100, 300, 500, 1000, fallback])].filter((bps) => bps <= max).sort((a, b) => a - b);
  slippageSelect.innerHTML = choices.map((bps) => `<option value="${bps}" ${bps === fallback ? 'selected' : ''}>${bps / 100}%</option>`).join('');
}

/* ---------------- Quotes ---------------- */

function clearQuote(): void {
  buyPlan = null;
  sellPlan = null;
}

/** The quote on screen, when it is for exactly what the form now asks. A press trades on nothing else. */
function shownPlan(amount: bigint): OutsideBuyPlan | OutsideSellPlan | null {
  if (!lookup) return null;
  const unit = counter();
  if (side === 'buy') {
    const plan = buyPlan;
    return plan && plan.token.mint === lookup.mint && plan.paying.mint === unit.mint && plan.payAmount === amount && plan.source === source && plan.slippageBps === slippageBps() ? plan : null;
  }
  const plan = sellPlan;
  return plan && plan.token.mint === lookup.mint && plan.receiving.mint === unit.mint && plan.units === amount && plan.source === source && plan.slippageBps === slippageBps() ? plan : null;
}

function scheduleQuote(delay = 800): void {
  window.clearTimeout(quoteTimer);
  // Every quote asks Jupiter, whose allowance is shared by every visitor: wait until the typing has stopped.
  quoteTimer = window.setTimeout(() => void runQuote(), delay);
}

async function runQuote(): Promise<void> {
  const sequence = ++quoteSequence;
  window.clearTimeout(quoteTimer);
  clearQuote();
  const state = tradable();
  if (!state.ok) {
    quoteBox.innerHTML = lookup ? `<dt>Trading</dt><dd>${escapeHtml(state.reason)}</dd>` : '<dt>Look up a token</dt><dd>—</dd>';
    refreshButton();
    return;
  }
  const token = lookup as TokenLookup;
  let amount: bigint;
  try {
    amount = parseAmount();
  } catch (error) {
    quoteBox.innerHTML = `<dt>Amount</dt><dd>${escapeHtml(friendlyError(error))}</dd>`;
    return;
  }
  if (amount <= 0n) {
    quoteBox.innerHTML = '<dt>Enter an amount</dt><dd>—</dd>';
    refreshButton();
    return;
  }
  const unit = counter();
  const limit = side === 'buy' ? overLimit(amount, unit) : null;
  if (limit) {
    quoteBox.innerHTML = `<dt>Limit</dt><dd>${escapeHtml(limit)}</dd>`;
    return;
  }
  if (!session) {
    quoteBox.innerHTML = '<dt>Wallet</dt><dd>Unlock a wallet to see this quote: Jupiter builds the swap for your address.</dd>';
    return;
  }
  quoteBox.innerHTML = '<dt>Quoting</dt><dd>…</dd>';
  const wallet = session;
  const asked = { side, source, slippage: slippageBps() };
  try {
    if (asked.side === 'buy') {
      const plan = await planOutsideBuy(wallet.address, outsideTokenOf(token), unit, amount, asked.slippage, asked.source);
      if (sequence !== quoteSequence) return;
      buyPlan = plan;
    } else {
      const plan = await planOutsideSell(wallet.address, outsideTokenOf(token), unit, amount, asked.slippage, asked.source);
      if (sequence !== quoteSequence) return;
      // A sale is limited by what it pays out, which only the quote says.
      const over = overLimit(plan.swap.expectedOut, unit);
      if (over) {
        quoteBox.innerHTML = `<dt>Limit</dt><dd>${escapeHtml(over)}</dd>`;
        return;
      }
      sellPlan = plan;
    }
    renderQuote();
  } catch (error) {
    if (sequence !== quoteSequence) return;
    quoteBox.innerHTML = `<dt>No quote</dt><dd>${escapeHtml(friendlyError(error))}</dd>`;
  }
}

/** The price one whole token trades at in this quote, in what is paid or received. */
function priceText(tokenUnits: bigint, otherUnits: bigint, unit: PairRef): string {
  const whole = Number(tokenUnits) / 10 ** decimals();
  const other = Number(otherUnits) / 10 ** unit.decimals;
  if (!(whole > 0) || !(other > 0)) return '—';
  return `1 ${symbol()} ≈ ${decimalText(String(other / whole), 4)} ${unit.symbol}`;
}

function impactLine(impactPct: number | null): string {
  if (impactPct === null || impactPct < 1) return '';
  const heavy = impactPct >= 5;
  return `<dt class="${heavy ? 'is-warning' : ''}">Price impact</dt><dd class="${heavy ? 'is-warning' : ''}">About ${impactPct.toFixed(impactPct >= 10 ? 0 : 1)}%, by Jupiter’s own estimate${heavy ? '. This trade is large for what this token has in its pools: you pay well above its current price.' : ''}</dd>`;
}

function renderQuote(): void {
  const ticker = escapeHtml(symbol());
  const viaOf = (labels: readonly string[]): string => (labels.length > 0 ? `Jupiter (${escapeHtml(labels.join(' → '))})` : 'Jupiter');
  const fees = '<dt>Fees</dt><dd>None to this site or to Jupiter. The route’s own pools take theirs inside the price.</dd>';
  if (buyPlan) {
    const { paying, swap } = buyPlan;
    const above = swap.expectedOut > swap.minimumOut ? swap.expectedOut - swap.minimumOut : 0n;
    const first =
      lookup?.place === 'first'
        ? `<dt class="is-warning">First private holder</dt><dd>Nobody has held ${ticker} privately before. This buy also creates its place in Rings and pays about ${sol(RINGS_INTERFACE_RENT_LAMPORTS, 4)} SOL of rent for it, once, from your public SOL.</dd>`
        : '';
    quoteBox.innerHTML = `<dt>You receive, about</dt><dd class="quote-main">${tokenText(swap.expectedOut, 4)} ${ticker}</dd><dt>Into your private balance, at least</dt><dd>${tokenText(swap.minimumOut, 4)} ${ticker} · or nothing is sent</dd><dt>Anything above that</dt><dd>About ${tokenText(above, 4)} ${ticker}. ${
      restBox.checked ? 'Moved into your private balance right after, in a second transaction.' : 'Stays in your public token account.'
    }</dd><dt>You pay, exactly</dt><dd>${escapeHtml(exact(swap.amountIn, paying))} · ${buyPlan.source === 'public' ? 'public' : 'private'}</dd><dt>Price</dt><dd>${escapeHtml(priceText(swap.expectedOut, swap.amountIn, paying))}</dd>${impactLine(swap.impactPct)}${first}<dt>Route</dt><dd>${viaOf(swap.route)}</dd>${fees}<dt>Slippage limit</dt><dd>${(buyPlan.slippageBps / 100).toFixed(2)}%</dd>`;
    return;
  }
  if (sellPlan) {
    const { receiving, swap } = sellPlan;
    const got = (units: bigint): string => escapeHtml(withUnit(units, receiving, 6));
    quoteBox.innerHTML = `<dt>You receive, about</dt><dd class="quote-main">${got(swap.expectedOut)}</dd><dt>Into your private balance, exactly</dt><dd>${escapeHtml(exact(swap.minimumOut, receiving))} · or nothing is sent</dd><dt>Anything above that</dt><dd>Arrives as public ${escapeHtml(receiving.symbol)}</dd><dt>You sell, exactly</dt><dd>${tokenExact(swap.amountIn)} ${ticker} · ${sellPlan.source === 'public' ? 'public' : 'private'}</dd><dt>Price</dt><dd>${escapeHtml(priceText(swap.amountIn, swap.expectedOut, receiving))}</dd>${impactLine(swap.impactPct)}<dt>Route</dt><dd>${viaOf(swap.route)}</dd>${fees}<dt>Slippage limit</dt><dd>${(sellPlan.slippageBps / 100).toFixed(2)}%</dd>`;
  }
}

/* ---------------- The wallet ---------------- */

function stage(message: string): void {
  output.innerHTML = `<div class="status"><b>WORKING</b><br>${escapeHtml(message)}</div>`;
}

async function requireWallet(): Promise<Session | null> {
  if (session) return session;
  session = await ensureWallet(gate, {
    purpose: 'to trade',
    onReady(ready) {
      session = ready;
      void afterUnlock();
    },
  });
  if (session) void afterUnlock();
  return session;
}

async function afterUnlock(): Promise<void> {
  if (!session) return;
  renderForm();
  await readPrivateBalance();
}

/* ---------------- Trading ---------------- */

/**
 * What a buy left in the public token account, and the button that moves it
 * into the private balance. `note` is why it is still there, when a first try
 * did not go through.
 */
function restOffer(token: OutsideToken, amount: bigint, closeWhenEmpty: boolean, note = ''): string {
  const what = amount > 0n ? `${tokenExact(amount)} ${escapeHtml(token.symbol)} more, the part above the guaranteed minimum, is in your public token account.` : 'The token account this buy opened is empty and still open.';
  const label = amount > 0n ? 'Move it into my private balance' : 'Close it and take the rent back';
  return `<br><br>${what}${note ? ` ${escapeHtml(note)}` : ''}<div class="row-wrap" style="margin-top:12px"><button class="btn flat" type="button" data-rest data-rest-amount="${amount.toString()}" data-rest-close="${closeWhenEmpty ? '1' : ''}" data-rest-mint="${escapeHtml(token.mint)}">${label}</button></div>`;
}

/** Moves what a buy left over, and says what happened in words that go under the buy's own result. */
async function moveRest(wallet: Session, token: OutsideToken, amount: bigint, closeWhenEmpty: boolean, onStage: (message: string) => void): Promise<string> {
  try {
    const moved = await shieldRest(wallet, token, amount, closeWhenEmpty, onStage);
    noteSettled(moved);
    const said = amount > 0n ? `${tokenExact(amount)} ${escapeHtml(token.symbol)} more, the part above the guaranteed minimum, was moved into your private balance too` : 'The token account this buy opened was empty';
    return `<br><br>${said}${moved.closed ? `${amount > 0n ? ', and' : ', so'} the temporary token account was closed and its rent returned` : ''}. ${txLink(moved.signature)}${moved.synced ? '' : `<br>${escapeHtml(STALE_BALANCE_NOTE)}`}`;
  } catch (error) {
    return restOffer(token, amount, closeWhenEmpty, `Moving it did not go through: ${friendlyError(error)}`);
  }
}

function wireRest(): void {
  output.querySelectorAll<HTMLButtonElement>('[data-rest]').forEach((restButton) => {
    restButton.addEventListener('click', async () => {
      if (busy || !session || !lookup || lookup.mint !== restButton.dataset.restMint) return;
      const wallet = session;
      const token = outsideTokenOf(lookup);
      const holder = restButton.closest<HTMLElement>('.status');
      busy = true;
      refreshButton();
      restButton.disabled = true;
      const result = await moveRest(wallet, token, BigInt(restButton.dataset.restAmount ?? '0'), restButton.dataset.restClose === '1', (message) => {
        restButton.textContent = message;
      });
      // The line about what was left over is replaced by what became of it.
      if (holder) {
        const marker = holder.querySelector('[data-rest-line]');
        if (marker) marker.innerHTML = result;
      }
      busy = false;
      refreshButton();
      wireRest();
      await refreshBalances();
    });
  });
}

function bought(landed: OutsideBought, token: OutsideToken, rest: string): string {
  const first = landed.createdInterface ? `<br>This was the first deposit of ${escapeHtml(token.symbol)} into Rings, so it also paid the rent for its place there, about ${sol(RINGS_INTERFACE_RENT_LAMPORTS, 4)} SOL.` : '';
  return `<div class="status ok"><b>BOUGHT · SETTLED</b><br>${tokenExact(landed.deposited)} ${escapeHtml(token.symbol)} is in your private balance. ${txLink(landed.signature)}${first}${landed.synced ? '' : `<br>${escapeHtml(STALE_BALANCE_NOTE)}`}<span data-rest-line>${rest}</span></div>`;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy) return;
  const state = tradable();
  if (!state.ok) {
    toast(state.reason, 'error');
    return;
  }
  const wallet = await requireWallet();
  if (!wallet || !lookup) return;
  const found = lookup;
  const token = outsideTokenOf(found);
  let amount: bigint;
  try {
    amount = parseAmount();
  } catch (error) {
    toast(friendlyError(error), 'error');
    return;
  }
  if (amount <= 0n) {
    toast('Enter an amount first.', 'error');
    amountInput.focus();
    return;
  }
  if (source === 'private' && !synced) {
    output.innerHTML = `<div class="status error"><b>BALANCE NOT READ</b><br>${
      syncProblem ? `Your private balance could not be read, so nothing can be traded out of it yet. Nothing is lost. ${escapeHtml(syncProblem)}` : 'Your private balance is still being read. Try again in a moment.'
    }</div>`;
    return;
  }
  // Never trade on numbers that were not on screen: without a quote for exactly this, the quote comes first.
  const shown = shownPlan(amount);
  if (!shown) {
    await runQuote();
    if (shownPlan(amount)) toast('Here is the quote. Check it, then press again.');
    return;
  }
  const unit = counter();
  const tolerance = slippageBps();
  const trading = { side, source };

  busy = true;
  refreshButton();
  form.classList.add('is-loading');
  try {
    // A fresh quote that is worse than the one shown by more than the limit goes on screen instead,
    // to be looked at and pressed again.
    const moved = (): void => {
      renderQuote();
      output.innerHTML = '<div class="status"><b>NEW QUOTE</b><br>The price moved since the quote above was made. Check the new one, then press again. Nothing was sent.</div>';
      toast('New quote. Check it, then press again.');
    };
    stage('Asking Jupiter for the swap…');
    if (trading.side === 'buy') {
      const limit = overLimit(amount, unit);
      if (limit) throw new Error(limit);
      const plan = await planOutsideBuy(wallet.address, token, unit, amount, tolerance, trading.source);
      if (plan.swap.minimumOut < minusBps(shown.swap.minimumOut, tolerance)) {
        buyPlan = plan;
        moved();
        return;
      }
      const landed = await outsideBuy(wallet, plan, stage);
      noteSettled(landed);
      toast('Buy settled');
      amountInput.value = '';
      clearQuote();
      quoteBox.innerHTML = '<dt>Enter an amount</dt><dd>—</dd>';
      // From here on the buy has settled. What follows is about the part above its guaranteed minimum.
      let rest = '';
      if (landed.leftover === null) {
        rest = '<br><br>What the swap returned above that could not be read just now. If there is any, it is in your public token account: the wallet page shows it, and can shield it.';
      } else if (landed.leftover > 0n || landed.accountIsNew) {
        if (restBox.checked) {
          output.innerHTML = bought(landed, token, '<br><br>Moving what was left over into your private balance…');
          rest = await moveRest(wallet, token, landed.leftover, landed.accountIsNew, (message) => {
            const line = output.querySelector('[data-rest-line]');
            if (line) line.innerHTML = `<br><br>${escapeHtml(message)}`;
          });
        } else {
          rest = restOffer(token, landed.leftover, landed.accountIsNew);
        }
      }
      output.innerHTML = bought(landed, token, rest);
      wireRest();
      // Somebody else looking the token up from now on sees that it is held privately.
      if (landed.createdInterface && lookup === found) {
        lookup = { ...found, place: 'exists' };
        renderToken();
      }
    } else {
      const plan = await planOutsideSell(wallet.address, token, unit, amount, tolerance, trading.source);
      const limit = overLimit(plan.swap.expectedOut, unit);
      if (limit) throw new Error(limit);
      if (plan.swap.minimumOut < minusBps(shown.swap.minimumOut, tolerance)) {
        sellPlan = plan;
        moved();
        return;
      }
      const landed = await outsideSell(wallet, plan, stage);
      noteSettled(landed);
      toast('Sell settled');
      amountInput.value = '';
      clearQuote();
      quoteBox.innerHTML = '<dt>Enter an amount</dt><dd>—</dd>';
      output.innerHTML = `<div class="status ok"><b>SOLD · SETTLED</b><br>${escapeHtml(exact(landed.deposited, unit))} is in your private balance. Whatever the swap returned above that arrived as public ${escapeHtml(unit.symbol)}. ${txLink(landed.signature)}${landed.synced ? '' : `<br>${escapeHtml(STALE_BALANCE_NOTE)}`}</div>`;
    }
  } catch (error) {
    output.innerHTML = `<div class="status error"><b>TRADE FAILED</b><br>${escapeHtml(friendlyError(error))}</div>`;
  } finally {
    busy = false;
    form.classList.remove('is-loading');
    refreshButton();
    await refreshBalances();
  }
});

document.querySelectorAll<HTMLButtonElement>('[data-side]').forEach((tab) => {
  tab.addEventListener('click', () => {
    if (busy || tab.dataset.side === side) return;
    side = tab.dataset.side as Side;
    amountInput.value = '';
    clearQuote();
    quoteBox.innerHTML = lookup ? '<dt>Enter an amount</dt><dd>—</dd>' : '<dt>Look up a token</dt><dd>—</dd>';
    renderForm();
  });
});
amountInput.addEventListener('input', () => {
  // The quote on screen was for another amount. It goes now; the next one is asked for once the typing stops.
  if (buyPlan || sellPlan) {
    clearQuote();
    quoteBox.innerHTML = amountInput.value.trim() === '' ? '<dt>Enter an amount</dt><dd>—</dd>' : '<dt>Quoting</dt><dd>…</dd>';
  }
  scheduleQuote();
});
slippageSelect.addEventListener('change', () => scheduleQuote(0));
restBox.addEventListener('change', () => {
  if (buyPlan) renderQuote();
});

/* ---------------- Start ---------------- */

async function load(): Promise<void> {
  status = await mountRuntime();
  const banner = setupMessage(status);
  const off = status && (!status.convert?.enabled || !status.convert.anyToken);
  const node = byId('swap-banner');
  if (off) {
    node.innerHTML = '<strong>Not switched on here.</strong> Buying tokens that were not launched on this site needs the operator’s Jupiter key, and is switched off on this deployment. Tokens launched here are on the <a href="/">market</a>.';
    node.hidden = false;
  } else if (banner) {
    node.innerHTML = banner;
    node.hidden = false;
  }
  renderSlippage();
  renderForm();
  try {
    session = await getSession();
  } catch {
    session = null;
  }
  const linked = new URL(location.href).searchParams.get('mint') ?? '';
  if (linked !== '') {
    lookupInput.value = linked;
    // The balance is read once the token is known: `find` does it.
    await find(linked, true);
  } else if (session) {
    await afterUnlock();
  }
  // Something may arrive in the wallet, or leave it, while this page is open.
  window.setInterval(() => {
    if (!document.hidden && !busy && session) void refreshBalances();
  }, 30_000);
}

// The wallet can be unlocked, locked or switched from the header. Unlocking only gives this page a wallet it did
// not have. Locking or switching changes whose balances are on it, so the page starts over.
watchWallet({
  busy: () => busy,
  async changed(change) {
    if (change !== 'unlock' || session) {
      location.reload();
      return;
    }
    try {
      session = await getSession();
    } catch {
      session = null;
    }
    if (!session) return;
    gate.innerHTML = '';
    await afterUnlock();
  },
});

void load();
