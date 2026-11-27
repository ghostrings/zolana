import '../pay.css';

import { type Address, address } from '@solana/kit';

import { GAS_RESERVE_LAMPORTS } from '../../../shared/src/constants.js';
import {
  PAY_MANY_MAX,
  PAY_STATE_LABELS,
  type PayList,
  type PayRun,
  newRun,
  nextTodo,
  parsePayList,
  receiptCsv,
  receiptFileName,
  retryFailed,
  runFinished,
  runTotals,
  sameProgress,
  unsettled,
} from '../../../shared/src/paymany.js';
import { SOL_MINT, privateBalance, privateHoldings } from '../../../shared/src/privacy.js';
import { formatUnits, groupDigits } from '../../../shared/src/units.js';
import { creatorRefused } from '../../../shared/src/vaults.js';
import { api } from '../api.js';
import { publicLamports } from '../chain.js';
import { explorerAddress, explorerTx, sol } from '../format.js';
import { ensureWallet } from '../gate.js';
import { type Readiness, checkRecipient, payNext, settleSent } from '../pay-flows.js';
import { dropPayRun, keepPayRun, readPayRun } from '../pay-records.js';
import { watchWallet } from '../session-bus.js';
import { mountRuntime, setupMessage } from '../shell.js';
import { type TokenFact, tokenFacts } from '../token-facts.js';
import { friendlyError } from '../trade.js';
import { byId, escapeHtml, initShell, setText, short, toast, wireCopyButtons } from '../ui.js';
import { type Session, getSession, ownAddresses } from '../wallet.js';

// A tool of the wallet: it is reached from the wallet page and lights the same place in the menu.
initShell('wallet');

const SOL = SOL_MINT as string;
/** Wallets looked up at the same time while the list is being checked. */
const CHECKS_AT_ONCE = 4;

const form = byId<HTMLFormElement>('pay-form');
const assetSelect = byId<HTMLSelectElement>('pay-asset');
const listInput = byId<HTMLTextAreaElement>('pay-list');
const checkButton = byId<HTMLButtonElement>('pay-check');
const startButton = byId<HTMLButtonElement>('pay-start');
const output = byId('pay-output');
const gate = byId('pay-gate');
const reviewSection = byId('pay-review-section');
const runSection = byId('pay-run-section');
const runOutput = byId('pay-run-output');

let session: Session | null = null;
let busy = false;
/** Asked for while a run is sending: the run stops once the payment under way has settled. */
let stopAsked = false;
let facts = new Map<string, TokenFact>();
/** The list as last read, the token it was read for, and what is known about each wallet on it. */
let list: PayList | null = null;
let listMint = '';
let checks = new Map<number, Readiness | 'checking'>();
let checkSequence = 0;
/** Set when the wallet may not pay this token out to a list. */
let refusal: string | null = null;
let run: PayRun | null = null;
let receiptUrl: string | null = null;
let clearArmedUntil = 0;

const CREATOR_REFUSAL =
  'This wallet, or another wallet kept in this browser, created this token, so it cannot be paid out to a list from here. Buyers watch where a creator’s tokens go, and a run of hidden amounts to many wallets would take that away from them. Sending it to one wallet at a time, from the wallet page, stays as it was.';

function status(node: HTMLElement, kind: 'working' | 'ok' | 'error' | 'info', title: string, html: string): void {
  node.innerHTML = `<div class="status${kind === 'ok' ? ' ok' : kind === 'error' ? ' error' : ''}"><b>${escapeHtml(title)}</b><br>${html}</div>`;
}

const factOf = (mint: string): TokenFact => facts.get(mint) ?? { symbol: short(mint), decimals: 0, listed: false };
const amountText = (units: bigint | string, decimals: number): string => groupDigits(formatUnits(BigInt(units), decimals));
const walletLink = (value: string): string =>
  `<a class="tx-link pay-wallet" href="${escapeHtml(explorerAddress(value))}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(value)}">${escapeHtml(short(value, 6, 6))}</a>`;

/* ---------------- Balances and the token to pay with ---------------- */

async function refreshBalances(): Promise<void> {
  const current = session;
  if (!current) return;
  const mint = assetSelect.value;
  if (mint) {
    const fact = factOf(mint);
    setText('pay-private-label', `Private ${fact.symbol}`);
    setText('pay-private', amountText(privateBalance(current.ctx, mint as Address), fact.decimals));
    setText('pay-private-note', 'pays every line');
  } else {
    setText('pay-private-label', 'Private balance');
    setText('pay-private', '—');
    setText('pay-private-note', 'of the token you choose');
  }
  try {
    const lamports = await publicLamports(current.address);
    if (session !== current) return;
    setText('pay-public-sol', `${sol(lamports, 4)} SOL`);
  } catch {
    setText('pay-public-sol', 'Not read');
  }
}

async function loadHoldings(): Promise<void> {
  const current = session;
  if (!current) return;
  const holdings = privateHoldings(current.ctx);
  try {
    facts = await tokenFacts([SOL, ...holdings.map((holding) => String(holding.mint)), ...(run ? [run.mint] : [])]);
  } catch (error) {
    status(output, 'error', 'COULD NOT READ YOUR TOKENS', escapeHtml(friendlyError(error)));
    return;
  }
  if (session !== current) return;
  const before = assetSelect.value;
  // SOL first, then the rest by ticker.
  const sorted = [...holdings].sort((a, b) => (String(a.mint) === SOL ? -1 : String(b.mint) === SOL ? 1 : factOf(String(a.mint)).symbol.localeCompare(factOf(String(b.mint)).symbol)));
  assetSelect.innerHTML =
    sorted.length === 0
      ? '<option value="">Nothing held privately yet</option>'
      : sorted.map((holding) => `<option value="${escapeHtml(String(holding.mint))}">${escapeHtml(factOf(String(holding.mint)).symbol)} · ${escapeHtml(amountText(holding.amount, factOf(String(holding.mint)).decimals))} private</option>`).join('');
  assetSelect.disabled = sorted.length === 0;
  if (before && sorted.some((holding) => String(holding.mint) === before)) assetSelect.value = before;
  setText('pay-asset-hint', sorted.length === 0 ? 'Shield or buy something on the wallet page first: a run pays from a private balance.' : 'A token you hold privately. Every line of the list is paid in it.');
  await refreshBalances();
}

/* ---------------- Reading the list back ---------------- */

/** Lines of the list that can be paid privately, by their position among the readable lines. */
function readyIndexes(): number[] {
  if (!list) return [];
  return list.entries.flatMap((_entry, index) => {
    const check = checks.get(index);
    return check !== undefined && check !== 'checking' && check.ok ? [index] : [];
  });
}

function reviewState(): { checking: number; again: number; ready: number[]; readyUnits: bigint } {
  const ready = readyIndexes();
  let checking = 0;
  let again = 0;
  for (const [, check] of checks) {
    if (check === 'checking') checking += 1;
    else if (!check.ok && check.again) again += 1;
  }
  return { checking, again, ready, readyUnits: ready.reduce((sum, index) => sum + (list?.entries[index]?.units ?? 0n), 0n) };
}

function renderReview(): void {
  const current = list;
  const live = session;
  reviewSection.hidden = current === null || run !== null;
  if (!current || !live || run) {
    startButton.hidden = true;
    return;
  }
  const fact = factOf(listMint);
  const state = reviewState();
  const held = privateBalance(live.ctx, listMint as Address);
  const tooMuch = state.readyUnits > held;

  byId('pay-review-problems').innerHTML =
    (current.problems.length > 0
      ? `<div class="status error"><b>${current.problems.length} LINE${current.problems.length === 1 ? '' : 'S'} COULD NOT BE READ</b><br>Fix or remove ${current.problems.length === 1 ? 'it' : 'them'}, then read the list again. Nothing is sent while a line is unread.<ul class="pay-problems">${current.problems
          .map((problem) => `<li>${problem.line > 0 ? `<b>Line ${problem.line}</b> ` : ''}${problem.text ? `<code>${escapeHtml(problem.text)}</code><br>` : ''}${escapeHtml(problem.problem)}</li>`)
          .join('')}</ul></div>`
      : '') +
    (current.repeated.length > 0
      ? `<div class="status"><b>PAID MORE THAN ONCE</b><br>${current.repeated.map((value) => walletLink(value)).join(', ')} ${current.repeated.length === 1 ? 'is' : 'are'} on the list more than once. That is allowed; make sure it is meant.</div>`
      : '') +
    (refusal ? `<div class="status error"><b>NOT THIS TOKEN</b><br>${escapeHtml(refusal)}</div>` : '');

  byId('pay-review-totals').innerHTML = [
    ['Lines read', String(current.entries.length)],
    ['Can be paid', state.checking > 0 ? `${state.ready.length} so far` : String(state.ready.length)],
    ['To pay', `${amountText(state.readyUnits, fact.decimals)} ${escapeHtml(fact.symbol)}`],
    ['You hold privately', `${amountText(held, fact.decimals)} ${escapeHtml(fact.symbol)}`],
  ]
    .map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`)
    .join('');

  byId('pay-review-table').querySelector('tbody')!.innerHTML = current.entries
    .map((entry, index) => {
      const check = checks.get(index);
      const cell =
        check === undefined || check === 'checking'
          ? '<span class="pay-state" data-state="todo">Looking it up…</span>'
          : check.ok
            ? '<span class="pay-state" data-state="paid">Yes</span>'
            : `<span class="pay-state" data-state="${check.again ? 'sent' : 'left'}">${check.again ? 'Not checked' : 'No'}</span><small>${escapeHtml(check.reason)}</small>`;
      return `<tr><td>${entry.line}</td><td>${walletLink(entry.to)}${entry.note ? `<small>${escapeHtml(entry.note)}</small>` : ''}</td><td class="num">${escapeHtml(amountText(entry.units, fact.decimals))}</td><td>${cell}</td></tr>`;
    })
    .join('');

  const blocked = current.problems.length > 0 || refusal !== null || state.checking > 0 || state.again > 0 || state.ready.length === 0 || tooMuch;
  startButton.hidden = current.entries.length === 0;
  startButton.disabled = blocked || busy;
  startButton.textContent =
    state.checking > 0
      ? `Looking up ${state.checking} wallet${state.checking === 1 ? '' : 's'}…`
      : state.ready.length === 0
        ? 'Nothing to pay'
        : `Pay ${state.ready.length} wallet${state.ready.length === 1 ? '' : 's'}: ${amountText(state.readyUnits, fact.decimals)} ${fact.symbol}`;
  if (state.checking > 0) return;
  if (current.problems.length > 0 || refusal) {
    output.innerHTML = '';
  } else if (state.again > 0) {
    status(output, 'error', 'NOT EVERY WALLET COULD BE CHECKED', `${state.again} wallet${state.again === 1 ? '' : 's'} could not be looked up just now. Read the list again in a moment: nothing is sent to a wallet that was not checked.`);
  } else if (tooMuch) {
    status(output, 'error', 'NOT ENOUGH IN YOUR PRIVATE BALANCE', `The list comes to ${escapeHtml(amountText(state.readyUnits, fact.decimals))} ${escapeHtml(fact.symbol)} and you hold ${escapeHtml(amountText(held, fact.decimals))} privately. Shield more or shorten the list.`);
  } else if (state.ready.length === 0) {
    status(output, 'error', 'NOTHING TO PAY', 'None of the wallets on the list can be paid privately. The table says why for each.');
  } else {
    const left = current.entries.length - state.ready.length;
    status(
      output,
      'info',
      'READY',
      `${state.ready.length} payment${state.ready.length === 1 ? '' : 's'}, one transaction each${left > 0 ? `. ${left} wallet${left === 1 ? '' : 's'} cannot be paid privately and will be left out; the receipt says so` : ''}. Each one pays the network fee from your public SOL: keep at least ${escapeHtml(sol(GAS_RESERVE_LAMPORTS, 3))} SOL there, or the run stops when less is left.`,
    );
  }
}

async function checkList(): Promise<void> {
  const current = list;
  if (!current) return;
  const mine = ++checkSequence;
  checks = new Map(current.entries.map((_entry, index) => [index, 'checking' as const]));
  renderReview();
  // The same wallet twice is looked up once.
  const answers = new Map<string, Promise<Readiness>>();
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      const entry = current.entries[index];
      if (!entry || mine !== checkSequence) return;
      let answer = answers.get(entry.to);
      if (!answer) {
        answer = checkRecipient(address(entry.to));
        answers.set(entry.to, answer);
      }
      const result = await answer;
      if (mine !== checkSequence) return;
      checks.set(index, result);
      renderReview();
    }
  };
  await Promise.all(Array.from({ length: Math.min(CHECKS_AT_ONCE, current.entries.length) }, () => worker()));
}

/** A token launched here may not be paid out to a list by the wallet that created it. */
async function creatorRule(mint: string, wallet: string): Promise<string | null> {
  if (mint === SOL) return null;
  const [token] = await api.tokensByMints([mint]);
  if (!token || token.mint !== mint) return null;
  return creatorRefused([token.creator], wallet, ownAddresses()) ? CREATOR_REFUSAL : null;
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  void readList();
});

async function readList(): Promise<void> {
  if (busy || run) return;
  const current = await requireWallet();
  if (!current) return;
  const mint = assetSelect.value;
  if (!mint) {
    status(output, 'error', 'CHOOSE A TOKEN', 'Pick the token the list is paid in. It has to be one you hold privately.');
    return;
  }
  if (listInput.value.trim() === '') {
    status(output, 'error', 'THE LIST IS EMPTY', 'Paste one payment per line: the address, then the amount.');
    return;
  }
  busy = true;
  checkButton.disabled = true;
  output.innerHTML = '';
  try {
    status(output, 'working', 'WORKING', 'Reading your private balance…');
    try {
      await current.sync();
    } catch {
      // The balance shown may be a little behind. Every payment checks it again before it is built.
    }
    refusal = null;
    try {
      refusal = await creatorRule(mint, current.address);
    } catch (error) {
      status(output, 'error', 'COULD NOT CHECK THIS TOKEN', `Whether this wallet created the token could not be read, so the list was not read either. ${escapeHtml(friendlyError(error))}`);
      return;
    }
    list = parsePayList(listInput.value, factOf(mint).decimals, current.address);
    listMint = mint;
    output.innerHTML = '';
    await refreshBalances();
    if (list.entries.length === 0) {
      checks = new Map();
      renderReview();
      status(output, 'error', 'NO PAYMENT COULD BE READ', list.problems.length > 0 ? 'Every line has a problem. They are listed beside this form.' : 'The list has no payments in it.');
      return;
    }
  } finally {
    busy = false;
    checkButton.disabled = false;
  }
  await checkList();
}

// A list that was read is no longer the list once it is edited, or paid in another token.
function listChanged(): void {
  if (run || list === null) return;
  list = null;
  checks = new Map();
  checkSequence += 1;
  refusal = null;
  output.innerHTML = '';
  renderReview();
}
listInput.addEventListener('input', listChanged);
assetSelect.addEventListener('change', () => {
  listChanged();
  void refreshBalances();
});

/* ---------------- A run ---------------- */

function save(next: PayRun): boolean {
  return keepPayRun(next);
}

function receiptLink(current: PayRun): string {
  if (receiptUrl) URL.revokeObjectURL(receiptUrl);
  receiptUrl = URL.createObjectURL(new Blob([receiptCsv(current, SOL)], { type: 'text/csv;charset=utf-8' }));
  return `<a class="btn secondary" href="${receiptUrl}" download="${escapeHtml(receiptFileName(current))}">Download the receipt</a>`;
}

function renderRun(): void {
  const current = run;
  runSection.hidden = current === null;
  form.classList.toggle('is-locked', current !== null);
  listInput.disabled = current !== null;
  assetSelect.disabled = current !== null || assetSelect.options.length === 0 || assetSelect.options[0]?.value === '';
  checkButton.disabled = current !== null || busy;
  if (!current) return;
  startButton.hidden = true;
  reviewSection.hidden = true;
  const totals = runTotals(current);
  const finished = runFinished(current);
  const waiting = totals.count.todo;
  const unknown = totals.count.sent;
  setText('pay-run-eyebrow', finished ? 'Finished' : busy ? 'Sending' : 'Not finished');
  setText('pay-run-title', `${totals.count.paid} of ${current.items.length - totals.count.left} paid`);
  setText(
    'pay-run-lede',
    finished
      ? totals.count.failed > 0
        ? 'Some payments did not go through. Nothing moved for those; they can be tried again.'
        : 'Every payment that could be made has landed on chain.'
      : unknown > 0
        ? 'One payment was sent and its outcome is not known yet. Nothing else is sent until it is.'
        : `Started ${new Date(current.createdAt).toISOString().slice(0, 16).replace('T', ' ')} UTC. What is marked paid has landed on chain.`,
  );
  byId('pay-run-totals').innerHTML = [
    ['Paid', `${amountText(totals.units.paid, current.decimals)} ${escapeHtml(current.symbol)}`],
    ['Still to pay', waiting + unknown > 0 ? `${amountText(totals.units.todo + totals.units.sent, current.decimals)} ${escapeHtml(current.symbol)}` : '—'],
    ['Not paid', totals.count.failed > 0 ? String(totals.count.failed) : '—'],
    ['Left out', totals.count.left > 0 ? String(totals.count.left) : '—'],
  ]
    .map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`)
    .join('');
  byId('pay-run-table').querySelector('tbody')!.innerHTML = current.items
    .map((item, index) => {
      const link = item.signature ? ` <a class="tx-link" href="${escapeHtml(explorerTx(item.signature))}" target="_blank" rel="noopener noreferrer">Transaction</a>` : '';
      const why = (item.state === 'failed' || item.state === 'left') && item.reason ? `<small>${escapeHtml(item.reason)}</small>` : '';
      return `<tr data-state="${item.state}"><td>${index + 1}</td><td>${walletLink(item.to)}${item.note ? `<small>${escapeHtml(item.note)}</small>` : ''}</td><td class="num">${escapeHtml(amountText(item.units, current.decimals))}</td><td><span class="pay-state" data-state="${item.state}">${escapeHtml(PAY_STATE_LABELS[item.state])}</span>${link}${why}</td></tr>`;
    })
    .join('');

  const actions: string[] = [];
  if (busy) {
    actions.push(`<button class="btn secondary" type="button" data-run="stop"${stopAsked ? ' disabled' : ''}>${stopAsked ? 'Stopping after this payment…' : 'Stop after this payment'}</button>`);
  } else {
    if (unknown > 0) actions.push('<button class="btn" type="button" data-run="check">Check again</button>');
    else if (waiting > 0) actions.push(`<button class="btn" type="button" data-run="continue">${totals.count.paid + totals.count.failed > 0 ? 'Continue' : 'Start'}: ${waiting} to pay</button>`);
    if (unknown === 0 && totals.count.failed > 0) actions.push(`<button class="btn secondary" type="button" data-run="retry">Try the ${totals.count.failed} unpaid again</button>`);
    actions.push(receiptLink(current));
    if (unknown === 0) {
      const armed = Date.now() < clearArmedUntil;
      actions.push(
        `<button class="btn flat" type="button" data-run="clear">${armed ? (waiting > 0 ? `Yes, clear it: ${waiting} will not be paid` : 'Yes, clear it') : finished ? 'Clear this run' : 'Clear this run without finishing'}</button>`,
      );
    }
  }
  byId('pay-run-actions').innerHTML = actions.join('');
}

const ELSEWHERE = 'This run is being worked on in another tab of this browser. Nothing is sent from this one. Close the other tab, or carry on there.';
const MOVED_ON = 'This run was moved on somewhere else in this browser, so nothing was sent from here. What is shown now is what is on record. Press Continue to go on from it.';

/**
 * Runs `work` only while no other tab of this browser is working on the same
 * wallet's run. Two tabs sending the same run could each build the same
 * line; the browser's own lock makes that impossible where it is available,
 * and the check against the record before every payment covers where it is
 * not. Returns null when another tab holds the run.
 */
async function alone<T>(wallet: string, work: () => Promise<T>): Promise<T | null> {
  const locks = (navigator as Navigator & { locks?: { request<R>(name: string, options: { ifAvailable: boolean }, callback: (lock: unknown) => Promise<R>): Promise<R> } }).locks;
  if (!locks) return work();
  let started = false;
  try {
    return await locks.request(`pcf.payrun.${wallet}`, { ifAvailable: true }, async (lock) => {
      if (!lock) return null;
      started = true;
      return work();
    });
  } catch (error) {
    // The work itself failed: that is the caller's to hear about, and it is not run a second time.
    if (started) throw error;
    // The browser would not give out a lock at all. The check against the record before every payment still stands.
    return work();
  }
}

/** The run as it is on record, when the copy this page holds is no longer where the record is. Null when they agree. */
function movedOn(wallet: string, held: PayRun): { record: PayRun | null } | null {
  const record = readPayRun(wallet);
  return record !== null && sameProgress(record, held) ? null : { record };
}

/** Sends what is waiting, one payment at a time, until the list is done, something stops it, or a stop is asked for. */
async function sendRun(): Promise<void> {
  const current = session;
  if (!current || !run || busy) return;
  busy = true;
  stopAsked = false;
  renderRun();
  let stop: string | null = null;
  try {
    const worked = await alone(current.address, async () => {
      while (run && nextTodo(run) >= 0) {
        if (stopAsked) {
          stop = 'Stopped, as you asked. What is marked paid has landed; the rest is waiting.';
          break;
        }
        // Never from a stale copy: what this page holds has to be what is on record, before every payment.
        const moved = movedOn(current.address, run);
        if (moved) {
          run = moved.record;
          stop = MOVED_ON;
          break;
        }
        const step = await payNext(current, run, { save, stage: (message) => status(runOutput, 'working', 'WORKING', escapeHtml(message)) });
        run = step.run;
        renderRun();
        void refreshBalances();
        if (step.stop) {
          stop = step.stop;
          break;
        }
      }
      return true;
    });
    if (worked === null) stop = ELSEWHERE;
  } catch (error) {
    // Nothing in a run is meant to throw. If something on this page does, the run stops here: what is on record is what counts.
    stop = `Something went wrong on this page, so the run stopped. ${friendlyError(error)} What is marked paid has landed; press Check again or Continue to go on from the record.`;
    run = readPayRun(current.address) ?? run;
  } finally {
    busy = false;
    stopAsked = false;
  }
  renderRun();
  if (!run) {
    // The record is gone: the run was cleared in another tab while this one still showed it.
    renderReview();
    status(output, 'info', 'THE RUN WAS CLEARED', 'This run was cleared somewhere else in this browser. Nothing was sent from here.');
    return;
  }
  const totals = runTotals(run);
  if (stop === ELSEWHERE || stop === MOVED_ON) {
    status(runOutput, 'info', stop === ELSEWHERE ? 'IN ANOTHER TAB' : 'MOVED ON', escapeHtml(stop));
  } else if (stop) {
    status(runOutput, totals.count.sent > 0 ? 'info' : 'error', totals.count.sent > 0 ? 'NOT KNOWN YET' : 'THE RUN STOPPED', escapeHtml(stop));
  } else if (runFinished(run)) {
    status(
      runOutput,
      totals.count.failed > 0 ? 'info' : 'ok',
      totals.count.failed > 0 ? 'FINISHED, WITH PAYMENTS THAT DID NOT GO THROUGH' : 'ALL PAID',
      `${totals.count.paid} payment${totals.count.paid === 1 ? '' : 's'} landed: ${escapeHtml(amountText(totals.units.paid, run.decimals))} ${escapeHtml(run.symbol)} in all. On chain each shows the two wallets and nothing more. Download the receipt before you clear the run.`,
    );
    toast(totals.count.failed > 0 ? 'Run finished with unpaid lines' : 'All paid');
  }
  await loadHoldings();
}

/** Looks at the chain for payments that were sent and never seen to settle. Sends nothing. */
async function checkAgain(quiet = false): Promise<void> {
  const current = session;
  if (!current || !run || busy || unsettled(run).length === 0) return;
  busy = true;
  renderRun();
  try {
    const held = run;
    const settled = await alone(current.address, async () => {
      const moved = movedOn(current.address, held);
      if (moved) return moved;
      return settleSent(current, held, { save, stage: (message) => status(runOutput, 'working', 'WORKING', escapeHtml(message)) });
    });
    if (settled === null) {
      status(runOutput, 'info', 'IN ANOTHER TAB', escapeHtml(ELSEWHERE));
    } else if ('record' in settled) {
      run = settled.record;
      status(runOutput, 'info', 'MOVED ON', escapeHtml(MOVED_ON));
    } else {
      run = settled.run;
      if (settled.problem) status(runOutput, 'error', 'COULD NOT BE LOOKED UP', escapeHtml(settled.problem));
      else if (settled.unknown > 0) {
        status(runOutput, 'info', 'NOT DECIDED YET', 'The network has not included that payment and can still do so for about another minute. Check again then. Nothing else is sent in the meantime.');
      } else if (!quiet) status(runOutput, 'ok', 'KNOWN NOW', 'Every payment that was sent has an answer from the chain. The table shows it.');
      else runOutput.innerHTML = '';
    }
  } catch (error) {
    status(runOutput, 'error', 'COULD NOT BE LOOKED UP', escapeHtml(friendlyError(error)));
    run = readPayRun(current.address) ?? run;
  } finally {
    busy = false;
  }
  renderRun();
  void refreshBalances();
}

byId('pay-run-actions').addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-run]');
  if (!button || !run) return;
  const action = button.dataset.run;
  if (action === 'stop') {
    stopAsked = true;
    renderRun();
  } else if (busy) {
    return;
  } else if (action === 'continue') {
    void sendRun();
  } else if (action === 'check') {
    void checkAgain();
  } else if (action === 'retry') {
    const moved = movedOn(run.wallet, run);
    if (moved) {
      run = moved.record;
      renderRun();
      status(runOutput, 'info', 'MOVED ON', escapeHtml(MOVED_ON));
      return;
    }
    const next = retryFailed(run);
    if (!save(next)) {
      status(runOutput, 'error', 'NOT CHANGED', 'This browser would not keep the change, so nothing was put back in line.');
      return;
    }
    run = next;
    renderRun();
    void sendRun();
  } else if (action === 'clear') {
    if (unsettled(run).length > 0) return;
    if (Date.now() >= clearArmedUntil) {
      clearArmedUntil = Date.now() + 6_000;
      renderRun();
      window.setTimeout(() => {
        if (Date.now() >= clearArmedUntil && run && !busy) renderRun();
      }, 6_100);
      return;
    }
    clearArmedUntil = 0;
    dropPayRun(run.wallet);
    run = null;
    list = null;
    checks = new Map();
    listInput.value = '';
    runOutput.innerHTML = '';
    output.innerHTML = '';
    if (receiptUrl) URL.revokeObjectURL(receiptUrl);
    receiptUrl = null;
    renderRun();
    renderReview();
    void loadHoldings();
  }
});

startButton.addEventListener('click', () => {
  const current = session;
  if (!current || !list || busy || run) return;
  const state = reviewState();
  if (list.problems.length > 0 || refusal || state.checking > 0 || state.again > 0 || state.ready.length === 0) return;
  if (state.readyUnits > privateBalance(current.ctx, listMint as Address)) return;
  const fact = factOf(listMint);
  const leftOut = new Map<number, string>();
  for (const [index] of list.entries.entries()) {
    const check = checks.get(index);
    if (check !== undefined && check !== 'checking' && !check.ok) leftOut.set(index, check.reason);
  }
  const id = Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const made = newRun({ id, wallet: current.address, mint: listMint, symbol: fact.symbol, decimals: fact.decimals, now: Date.now(), entries: list.entries, leftOut });
  if (!save(made)) {
    status(output, 'error', 'NOT STARTED', 'This browser would not keep the run, so nothing was sent. A run needs somewhere to write down what it has paid: check that this is not a private window and that the browser has storage left.');
    return;
  }
  run = made;
  output.innerHTML = '';
  renderRun();
  runSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  void sendRun();
});

/* ---------------- Wallet ---------------- */

async function afterUnlock(): Promise<void> {
  const current = session;
  if (!current) return;
  gate.innerHTML = '';
  run = readPayRun(current.address);
  try {
    await current.sync();
  } catch {
    // What is shown may be a little behind; every payment reads the balance again before it is built.
  }
  if (session !== current) return;
  await loadHoldings();
  renderRun();
  renderReview();
  if (run && unsettled(run).length > 0) {
    // A run that was interrupted while a payment was on its way: find out what became of it before anything else.
    await checkAgain(true);
  } else if (run && !runFinished(run)) {
    status(runOutput, 'info', 'A RUN IS WAITING', 'This run was not finished. What is marked paid has landed on chain; nothing is sent again. Continue it, or clear it.');
  }
}

async function requireWallet(): Promise<Session | null> {
  if (session) return session;
  session = await ensureWallet(gate, {
    purpose: 'to pay',
    onReady(ready) {
      session = ready;
      void afterUnlock();
    },
  });
  if (session) await afterUnlock();
  return session;
}

window.addEventListener('beforeunload', (event) => {
  if (!busy || !run) return;
  // A payment is being sent. Leaving does not undo it, and the run picks it up again; the browser asks first all the same.
  event.preventDefault();
});

async function load(): Promise<void> {
  const runtime = await mountRuntime();
  const banner = setupMessage(runtime);
  if (banner) {
    const node = byId('pay-banner');
    node.innerHTML = banner;
    node.hidden = false;
  }
  setText('pay-list-hint', `Up to ${PAY_MANY_MAX} lines. Amounts with a point for decimals and no thousands separators: 1250.5`);
  wireCopyButtons();
  try {
    session = await getSession();
  } catch {
    session = null;
  }
  if (session) await afterUnlock();
  else await requireWallet();
  window.setInterval(() => {
    if (!document.hidden && !busy && session) void refreshBalances();
  }, 30_000);
}

// The wallet can be unlocked, locked or switched from the header. Unlocking only gives this page a wallet it did
// not have. Locking or switching changes whose run and whose balance are on it, so the page starts over.
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
    if (session) await afterUnlock();
  },
});

void load();
