import { type Address, address, isAddress } from '@solana/kit';

import type { PairRef, StatusResponse, TokenDetail } from '../../../shared/src/api.js';
import { GAS_RESERVE_LAMPORTS, INITIAL_SUPPLY_UNITS, TOKEN_DECIMALS, WSOL_MINT } from '../../../shared/src/constants.js';
import { type DeskDecline, declineCovers, floorAfterTolerance, isDeskDecline } from '../../../shared/src/desk-rules.js';
import type { GhostQuote } from '../../../shared/src/ghost.js';
import { type TradeQuote, creatorFeeSharePctOf, curveStats } from '../../../shared/src/meteora.js';
import { SOL_MINT, privateBalance, privateHistory } from '../../../shared/src/privacy.js';
import type { MarketEnv, Rewards } from '../../../shared/src/routes.js';
import { feeSplit } from '../../../shared/src/tiers.js';
import { minusBps, parseUnits, percentOf } from '../../../shared/src/units.js';
import { api } from '../api.js';
import { changeChip, pairChip } from '../chips.js';
import { type MintState, loadMarketEnv, publicLamports, publicTokenUnits, readMintState } from '../chain.js';
import { USDC_QUICK_AMOUNTS, counterOf, counterOptions } from '../convert.js';
import { decimalText, explorerAddress, explorerTx, feeLabel, marketCapText, percent, smallPrice, sol, tokens } from '../format.js';
import { ensureWallet } from '../gate.js';
import { SOL_REF, amount as pairAmount, compact, inPairUnits, isSol, pairOf, plain, quickAmounts, tradeCap, withUnit } from '../pairs.js';
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
import { watchWallet } from '../session-bus.js';
import { mountRuntime, payoutClause, setupMessage } from '../shell.js';
import {
  type ConvertedBuyPlan,
  type ConvertedSellPlan,
  MIN_CLAIM_LAMPORTS,
  QuoteMoved,
  STALE_BALANCE_NOTE,
  type ShieldedBuyPlan,
  activateModules,
  burnFromPrivate,
  burnFromPublic,
  canReceivePrivately,
  claimRewards,
  convertedBuy,
  convertedSell,
  friendlyError,
  ghostFill,
  ghostQuote,
  graduate,
  knowAsset,
  planConvertedBuy,
  planConvertedSell,
  planShieldedBuy,
  planShieldedSell,
  publicBuyToPrivate,
  rewards,
  sendPrivate,
  shieldedBuy,
  shieldedSell,
} from '../trade.js';
import { type ModulePicker, choiceText, moduleHtml, moduleTag, mountModulePicker } from '../modules.js';
import { byId, escapeHtml, initShell, relativeTime, safeImageUrl, setText, short, toast, tokenArt, wireCopyButtons } from '../ui.js';
import { type Session, getSession } from '../wallet.js';

initShell('market');

type Side = 'buy' | 'sell';
type Route = 'ghost' | 'shielded' | 'public';

const SOL = SOL_MINT as Address;
const mintParam = new URL(location.href).searchParams.get('mint') ?? '';
// The link to prvmax opens it with this token already entered.
const vaultsLink = document.querySelector<HTMLAnchorElement>('#prvmax-link');
if (vaultsLink && mintParam) vaultsLink.href = `/prvmax?mint=${encodeURIComponent(mintParam)}`;

const form = byId<HTMLFormElement>('trade-form');
const amountInput = byId<HTMLInputElement>('amount');
const slippageSelect = byId<HTMLSelectElement>('slippage');
const quoteBox = byId('quote-box');
const tradeButton = byId<HTMLButtonElement>('trade-button');
const tradeOutput = byId('trade-output');
const tradeGate = byId('trade-gate');

let status: StatusResponse | null = null;
let detail: TokenDetail | null = null;
let env: MarketEnv | null = null;
let envError = '';
let session: Session | null = null;
let side: Side = 'buy';
let route: Route = 'shielded';
let routeChosen = false;
/**
 * Why the desk passed on the last order, while Ghost fill was this page's own
 * pick and not the trader's. The page then trades the same order on the pool
 * instead of leaving a refusal on screen.
 */
let ghostDeclined: DeskDecline | null = null;
let busy = false;
/** True once the private balance has been read from chain in this page, and not gone stale since. */
let synced = false;
/** Why the private balance is not shown, when it could not be read. An unread balance is never shown as a number. */
let syncProblem: string | null = null;

/** The private balance of the token's pair token, in its base units: what a shielded buy spends. */
let privateQuote = 0n;
let privateToken = 0n;
/** Public SOL, which pays fees and temporary rent whatever the pair token is. */
let publicSol = 0n;
/** The public balance of the pair token: the wallet's SOL, or its token account for any other. Null until read. */
let publicQuote: bigint | null = null;
/** This token in the wallet's ordinary token account. Null until it has been read. */
let publicToken: bigint | null = null;
/** The token's mint account as read from chain: its supply now, and who (if anyone) can make more. Null until read. */
let mintState: MintState | null = null;

/**
 * What a buy is paid with, or a sell paid out in, when that is not the pair
 * token: `SOL` or `USDC`, converted through Jupiter inside the trade. Empty
 * for the pair token itself.
 */
let counterId = '';
/** The private and public balance of that other token. Read only while one is chosen. */
let privateCounter = 0n;
let publicCounter: bigint | null = null;

/** The quote on screen. Exactly one of these is set when the button can trade. */
let buyPlan: ShieldedBuyPlan | null = null;
let sellPlan: TradeQuote | null = null;
let deskQuote: GhostQuote | null = null;
/** When the desk's quote on screen was received. */
let deskQuoteAt = 0;
let convertedBuyPlan: ConvertedBuyPlan | null = null;
let convertedSellPlan: ConvertedSellPlan | null = null;
let quoteSequence = 0;
let quoteTimer: number | undefined;

/* ---------------- Small helpers ---------------- */

function symbol(): string {
  return detail?.symbol || 'TOKEN';
}

/**
 * Where this token's curve fees go. Read from the token's own config once the
 * pool has loaded: a token keeps the split it was launched with, whatever new
 * launches get today.
 */
function ownSplit(): ReturnType<typeof feeSplit> | null {
  if (env) return feeSplit({ creatorFeeSharePct: creatorFeeSharePctOf(env.market) });
  return status ? feeSplit(status.economics) : null;
}

function mintAddress(): Address {
  return address(mintParam);
}

function network(): 'mainnet' {
  return status?.network ?? 'mainnet';
}

/** What this token is priced and traded in. SOL until the listing has said otherwise. */
function pair(): PairRef {
  return detail?.pair ?? SOL_REF;
}

/** The pair token as Rings holds it: native SOL, or the pair token's mint. */
function quoteAsset(): Address {
  return isSol(pair()) ? SOL : address(pair().mint);
}

/** What this trade is paid with (a buy) or paid out in (a sell). The pair token unless another was chosen. */
function counter(): PairRef {
  return counterOf(status, pair(), counterId);
}

/** True when that is not the pair token, so the trade carries a conversion. */
function converting(): boolean {
  return counter().mint !== pair().mint;
}

/** That token as Rings holds it. */
function counterAsset(): Address {
  return isSol(counter()) ? SOL : address(counter().mint);
}

/** The supply now, in base units: read from chain by this page when it could be, else the listing's. Null when neither. */
function supplyNow(): bigint | null {
  if (mintState) return mintState.supply;
  return detail?.supply ? BigInt(detail.supply) : null;
}

/** Base units destroyed so far: the launch supply less the supply now. */
function burnedNow(): bigint {
  const supply = supplyNow();
  return supply === null || supply >= INITIAL_SUPPLY_UNITS ? 0n : INITIAL_SUPPLY_UNITS - supply;
}

function slippageBps(): number {
  return Number(slippageSelect.value) || status?.slippage.defaultBps || 100;
}

function ghostAvailability(): { ok: boolean; reason: string } {
  // The desk swaps a token for its pair token and nothing else.
  if (converting()) return { ok: false, reason: `Not when ${side === 'buy' ? 'paying with' : 'receiving'} another token.` };
  // The desk holds and quotes SOL only.
  if (!isSol(pair())) return { ok: false, reason: `Only for tokens priced in SOL. This one is priced in ${pair().symbol}.` };
  if (!status?.desk.enabled) return { ok: false, reason: 'The desk is offline on this deployment.' };
  if (session && session.kind !== 'ghost') return { ok: false, reason: 'Needs the built-in ghost wallet.' };
  return { ok: true, reason: '' };
}

/** The most the desk fills in one trade, on the SOL side. Zero when it is not known. */
function deskCap(): bigint {
  try {
    return BigInt(status?.desk.maxOrderLamports ?? '0');
  } catch {
    return 0n;
  }
}

/** The amount typed, or null when it does not parse. */
function typedAmount(): bigint | null {
  try {
    return parseAmount();
  } catch {
    return null;
  }
}

/** Whether the desk's last refusal still covers the order on screen. The rule is `declineCovers`. */
function ghostDeclinedNow(): boolean {
  return declineCovers(ghostDeclined, side, typedAmount(), Date.now());
}

/** Ghost fill when the desk can take the order, else the pool. Only while the trader has not picked a route. */
function defaultRoute(): Route {
  return ghostAvailability().ok && !ghostDeclinedNow() ? 'ghost' : 'shielded';
}

function tradable(): { ok: boolean; reason: string } {
  if (!status) return { ok: false, reason: 'The server is not reachable.' };
  if (!status.rpcConfigured) return { ok: false, reason: 'This deployment has no RPC configured.' };
  if (status.limits.tradingPaused) {
    return { ok: false, reason: status.limits.notice ?? 'Trading through this site is paused for now. Your wallet is not affected.' };
  }
  if (!env) return { ok: false, reason: envError || 'The pool is still loading.' };
  if (env.market.stage === 'migrating') return { ok: false, reason: 'This curve is complete and is migrating to its pool. Trading resumes in a moment.' };
  return { ok: true, reason: '' };
}

/**
 * The per-trade limit, or null when the trade is within it (or no limit is
 * set). `units` is the pair-token side of the trade, in its base units; the
 * limit is set in SOL and applies to another pair token at that pair's rate.
 */
function overLimit(units: bigint): string | null {
  const cap = tradeCap(status, pair());
  return cap > 0n && units > cap ? `Trades are limited to ${withUnit(cap, pair(), 2)} each for now.` : null;
}

function parseAmount(): bigint {
  const text = amountInput.value.trim();
  if (!text) return 0n;
  return parseUnits(text, side === 'buy' ? counter().decimals : TOKEN_DECIMALS);
}

/** Below this, a claim costs more in fees than it is worth: in the pair token's base units. */
function minimumClaim(): bigint {
  return inPairUnits(status, pair(), MIN_CLAIM_LAMPORTS);
}

/* ---------------- Header, stats, chart ---------------- */

function renderHeader(): void {
  if (!detail) return;
  document.title = `$${detail.symbol || '???'} — privacycash.fun`;
  byId('t-avatar').innerHTML = tokenArt(detail);
  const stage = byId('t-stage');
  stage.textContent = detail.stage === 'graduated' ? 'GRADUATED' : detail.stage === 'migrating' ? 'MIGRATING' : 'CURVE LIVE';
  stage.classList.toggle('graduated', detail.stage !== 'curve');
  setText('t-symbol', `$${detail.symbol || '???'}`);
  setText('t-title', detail.name || 'Unnamed token');
  const story = byId('t-story');
  story.textContent = detail.description;
  story.hidden = !detail.description;
  // The change over a day and what it is priced in, as on its card in the market.
  byId('t-change').innerHTML = `${changeChip(detail.change24h)}${pairChip(detail.pair)}`;
  byId('t-creator').innerHTML = `<dt>Creator</dt><dd title="${escapeHtml(detail.creator)}">${escapeHtml(short(detail.creator, 4, 4))}</dd><dt>Fee</dt><dd>${escapeHtml(feeLabel(detail.feeBps))}, both phases</dd><dt>Priced in</dt><dd>${escapeHtml(detail.pair.symbol)}</dd>`;
  const links: string[] = [];
  const website = detail.website ? safeImageUrl(detail.website) : '';
  const twitter = detail.twitter ? safeImageUrl(detail.twitter) : '';
  if (website.startsWith('https://')) links.push(`<a class="tag" href="${escapeHtml(website)}" target="_blank" rel="noopener noreferrer nofollow">Website</a>`);
  if (twitter.startsWith('https://')) links.push(`<a class="tag" href="${escapeHtml(twitter)}" target="_blank" rel="noopener noreferrer nofollow">X</a>`);
  const burned = burnedNow();
  if (burned > 0n) links.push(`<a class="tag" href="#move">${escapeHtml(percentOf(burned, INITIAL_SUPPLY_UNITS))}% burned</a>`);
  const modulesTag = moduleTag(detail);
  if (modulesTag) links.push(`<a class="tag" href="#modules-section">${escapeHtml(modulesTag.charAt(0) + modulesTag.slice(1).toLowerCase())}</a>`);
  byId('t-links').innerHTML = links.join('');
}

function renderBar(element: HTMLElement, progress: number, blocks = 24): void {
  const clamped = Math.max(0, Math.min(1, progress));
  const on = Math.round(clamped * blocks);
  element.innerHTML = Array.from({ length: blocks }, (_, index) => `<i class="${index < on ? 'on' : ''}" aria-hidden="true"></i>`).join('');
  element.setAttribute('role', 'progressbar');
  element.setAttribute('aria-valuemin', '0');
  element.setAttribute('aria-valuemax', '100');
  element.setAttribute('aria-valuenow', String(Math.round(clamped * 100)));
}

function renderStats(): void {
  if (!detail) return;
  const unit = pair();
  // Live chain state when it is loaded and the token is still on its curve; the listing otherwise.
  const live = env && env.market.stage === 'curve' ? curveStats(env.market) : null;
  const price = live?.price ?? detail.price;
  // Market cap is the price times the tokens that exist now, so a burn lowers it.
  const supply = supplyNow();
  const cap = supply !== null ? marketCapText(price, supply) : (live?.marketCap ?? detail.marketCap);
  const progress = live?.progress ?? detail.progress;
  const reserve = live?.quoteReserve ?? detail.reserve;
  const threshold = live?.migrationThreshold ?? detail.threshold;
  const graduated = detail.stage !== 'curve';
  setText('t-chart-unit', `PRICE IN ${unit.symbol} PER TOKEN`);
  // A very small price is written the way the market writes it, so it fits its tile; the chart beside it has every digit.
  const priceTile = byId('t-price');
  const shortPrice = smallPrice(price);
  priceTile.innerHTML = `${shortPrice ? `0.0<sub>${shortPrice.zeros}</sub>${escapeHtml(shortPrice.digits)}` : escapeHtml(decimalText(price))} ${escapeHtml(unit.symbol)}`;
  priceTile.title = `${decimalText(price)} ${unit.symbol}`;
  setText('t-cap', `${decimalText(cap)} ${unit.symbol}`);
  setText('t-reserve-label', graduated ? 'Raised on the curve' : 'Curve reserve');
  setText('t-reserve', withUnit(reserve, unit, 2));
  // Everything traded since launch, on the curve and after it.
  setText('t-volume', compact(detail.volume ?? '0', unit));
  setText('t-grad-label', graduated ? (detail.stage === 'migrating' ? 'CURVE COMPLETE · WAITING TO GRADUATE' : 'GRADUATED TO A METEORA POOL') : `GRADUATION ${pairAmount(reserve, unit, 2)} / ${withUnit(threshold, unit, 2)}`);
  setText('t-grad-pct', graduated ? 'DONE' : percent(progress, 0));
  renderBar(byId('grad-bar'), graduated ? 1 : progress);
  setText('t-chart-note', graduated ? `FEE ${feeLabel(detail.feeBps)} · UNCHANGED` : `GRADUATION ${percent(progress, 0)}`);
  const burned = burnedNow();
  setText('t-supply', supply !== null ? tokens(supply, 2) : '—');
  setText('t-burned', supply === null ? '—' : burned > 0n ? `${tokens(burned, 2)} · ${percentOf(burned, INITIAL_SUPPLY_UNITS)}%` : 'None');
  setText('t-mintable', !mintState ? '—' : mintState.mintAuthority ? `Yes · by ${short(mintState.mintAuthority, 4, 4)}` : 'No · nobody holds the mint');
  drawChart(Number(price));
  renderGraduate();
}

function drawChart(currentPrice: number): void {
  const svg = byId('price-chart');
  if (!detail) return;
  const W = 760;
  const H = 300;
  const px = 46;
  const pt = 28;
  const pb = 42;
  const points = detail.history
    .map((point) => ({ at: point.at, price: Number(point.price) }))
    .filter((point) => Number.isFinite(point.price) && point.price > 0)
    .sort((a, b) => a.at - b.at);
  if (Number.isFinite(currentPrice) && currentPrice > 0) points.push({ at: Date.now(), price: currentPrice });
  if (points.length === 0) {
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" class="chart-label">NO PRICE YET</text>`;
    return;
  }
  const first = points[0] as { at: number; price: number };
  if (points.length === 1) points.unshift({ at: first.at - 60_000, price: first.price });
  const start = (points[0] as { at: number }).at;
  const end = (points[points.length - 1] as { at: number }).at;
  const span = Math.max(1, end - start);
  let low = Math.min(...points.map((point) => point.price));
  let high = Math.max(...points.map((point) => point.price));
  if (high === low) {
    high *= 1.05;
    low *= 0.95;
  }
  const pad = (high - low) * 0.12;
  low = Math.max(0, low - pad);
  high += pad;
  const x = (at: number) => px + ((at - start) / span) * (W - px * 2);
  const y = (price: number) => H - pb - ((price - low) / (high - low)) * (H - pt - pb);
  const path = points.map((point, index) => `${index ? 'L' : 'M'}${x(point.at).toFixed(2)},${y(point.price).toFixed(2)}`).join(' ');
  const last = points[points.length - 1] as { at: number; price: number };
  const cx = x(last.at);
  const cy = y(last.price);
  const grid = Array.from({ length: 5 }, (_, index) => {
    const gy = pt + index * ((H - pt - pb) / 4);
    return `<line x1="${px}" y1="${gy}" x2="${W - px}" y2="${gy}" class="chart-grid"/>`;
  }).join('');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = `${grid}<path d="${path} L${W - px},${H - pb} L${px},${H - pb} Z" class="curve-fill"/><path d="${path}" class="curve-line"/><line x1="${cx}" y1="${cy}" x2="${cx}" y2="${H - pb}" class="chart-marker-line"/><circle cx="${cx}" cy="${cy}" r="5" class="chart-marker"/><text x="${px}" y="${H - 14}" class="chart-label">${escapeHtml(relativeTime(start).toUpperCase())}</text><text x="${W - px}" y="${H - 14}" text-anchor="end" class="chart-label">NOW</text><text x="${Math.max(px, Math.min(W - 190, cx - 180))}" y="${Math.max(18, cy - 12)}" class="chart-current">${escapeHtml(decimalText(String(last.price)))} ${escapeHtml(pair().symbol)}</text>`;
}

/** The supply rows of the facts table: what exists now, what was burned, and whether more can ever be made. */
function supplyFacts(): string {
  const supply = supplyNow();
  const burned = burnedNow();
  const mintable = !mintState
    ? 'Not read yet'
    : mintState.mintAuthority
      ? `Yes, by ${escapeHtml(short(mintState.mintAuthority, 8, 8))}`
      : 'No · the mint has no authority, so the supply can only fall';
  return `<dt>Supply at launch</dt><dd>1,000,000,000 · 6 decimals</dd><dt>Supply now</dt><dd>${supply !== null ? escapeHtml(tokens(supply, 2)) : 'Not read yet'}</dd><dt>Burned so far</dt><dd>${
    supply === null ? 'Not read yet' : burned > 0n ? `${escapeHtml(tokens(burned, 2))} · ${escapeHtml(percentOf(burned, INITIAL_SUPPLY_UNITS, 4))}% of the launch supply` : 'None'
  }</dd><dt>Can more be minted</dt><dd>${mintable}</dd>`;
}

function renderFacts(): void {
  if (!detail) return;
  const net = network();
  const row = (label: string, value: string, id: string) =>
    `<dt>${label}</dt><dd><a class="tx-link" id="${id}" href="${escapeHtml(explorerAddress(value, net))}" target="_blank" rel="noopener noreferrer">${escapeHtml(short(value, 8, 8))}</a> <button class="icon-btn" type="button" data-copy="${escapeHtml(value)}">COPY</button></dd>`;
  const split = ownSplit();
  const pool = env?.market.dammPool?.toBase58();
  const unit = pair();
  // What the token is priced in, with the pair token's own mint for anything but SOL itself.
  const priced = isSol(unit)
    ? '<dt>Priced and traded in</dt><dd>SOL · fixed at launch</dd>'
    : `<dt>Priced and traded in</dt><dd>${escapeHtml(unit.symbol)} · fixed at launch</dd>${row(`${escapeHtml(unit.symbol)} mint`, unit.mint, 'f-pair')}`;
  byId('facts').innerHTML = `${row('Mint', detail.mint, 'f-mint')}${row('Curve pool', detail.pool, 'f-pool')}${pool ? row('Graduated pool', pool, 'f-damm') : ''}${row('Creator', detail.creator, 'f-creator')}${priced}<dt>Trading fee</dt><dd>${escapeHtml(feeLabel(detail.feeBps))} on the curve · ${escapeHtml(feeLabel(detail.feeBps))} after graduation</dd>${split && status ? `<dt>Fee split, curve</dt><dd>${split.creatorPct}% creator · ${split.platformPct}% platform · ${split.protocolPct}% Meteora</dd><dt>After graduation</dt><dd>Liquidity 100% locked, held by the platform · ${escapeHtml(payoutClause(status))}</dd>` : ''}${supplyFacts()}<dt>Created</dt><dd>${escapeHtml(relativeTime(detail.createdAt))}</dd>`;
  wireCopyButtons(byId('facts'));
}

/* ---------------- Balances, activity, rewards ---------------- */

async function refreshBalances(): Promise<void> {
  const unit = pair();
  const native = isSol(unit);
  byId('balances').classList.toggle('has-pair', !native);
  byId('b-public-quote-cell').hidden = native;
  setText('b-public-quote-label', `Public ${unit.symbol}`);
  if (!session) {
    setText('b-private-quote', '—');
    setText('b-private-token', 'Unlock a wallet');
    setText('b-public-sol', '—');
    setText('b-public-quote', '—');
    publicToken = null;
    publicQuote = null;
    publicCounter = null;
    renderMove();
    return;
  }
  privateQuote = privateBalance(session.ctx, quoteAsset());
  privateToken = privateBalance(session.ctx, mintAddress());
  setText('b-private-quote', synced ? withUnit(privateQuote, unit, 4) : syncProblem ? 'Not read' : 'Syncing…');
  setText('b-private-token', synced ? `${tokens(privateToken, 2)} $${symbol()}` : syncProblem ? 'See your activity below' : 'Reading encrypted notes');
  let lamports: bigint | null = null;
  try {
    lamports = await publicLamports(session.address);
    publicSol = lamports;
    setText('b-public-sol', `${sol(publicSol, 4)} SOL`);
  } catch {
    setText('b-public-sol', '—');
  }
  if (native) {
    publicQuote = lamports;
  } else {
    try {
      publicQuote = await publicTokenUnits(session.address, unit.mint);
      setText('b-public-quote', withUnit(publicQuote, unit, 4));
    } catch {
      publicQuote = null;
      setText('b-public-quote', '—');
    }
  }
  try {
    publicToken = await publicTokenUnits(session.address, mintParam);
  } catch {
    publicToken = null;
  }
  if (converting()) {
    const other = counter();
    privateCounter = privateBalance(session.ctx, counterAsset());
    if (isSol(other)) publicCounter = lamports;
    else {
      try {
        publicCounter = await publicTokenUnits(session.address, other.mint);
      } catch {
        publicCounter = null;
      }
    }
  }
  renderQuick();
  renderMove();
}

function renderActivity(): void {
  const list = byId('activity');
  if (!session) {
    list.innerHTML = '<div class="empty-state">UNLOCK A WALLET TO SEE YOUR ACTIVITY</div>';
    return;
  }
  if (syncProblem) {
    list.innerHTML = `<div class="status error"><b>YOUR PRIVATE BALANCE COULD NOT BE READ</b><br>${escapeHtml(syncProblem)}<br><br>Nothing has been lost: what you hold privately is on chain under your keys, and only this page failed to read it.<div class="row-wrap" style="margin-top:12px"><button class="btn flat" type="button" data-read-again>Try again</button></div></div>`;
    list.querySelector<HTMLButtonElement>('[data-read-again]')?.addEventListener('click', () => {
      if (!busy) void readPrivateBalance();
    });
    return;
  }
  if (!synced) {
    list.innerHTML = '<div class="empty-state">READING ENCRYPTED NOTES<span class="blink">_</span></div>';
    return;
  }
  const mint = mintAddress();
  const rows = privateHistory(session.ctx)
    .filter((entry) => entry.asset === mint)
    .slice(-12)
    .reverse();
  if (rows.length === 0) {
    list.innerHTML = `<div class="empty-state">NO PRIVATE ACTIVITY IN $${escapeHtml(symbol())} YET</div>`;
    return;
  }
  const label: Record<string, string> = {
    deposit: 'DEPOSIT INTO RINGS',
    privateTransfer: 'PRIVATE TRANSFER',
    ringEntry: 'RING ENTRY',
    publicWithdrawal: 'WITHDRAWAL FROM RINGS',
    split: 'SPLIT',
    merge: 'CONSOLIDATION',
  };
  list.innerHTML = rows
    .map((entry) => {
      const inbound = entry.direction === 'inbound';
      const glyph = entry.direction === 'selfTransfer' ? '↻' : inbound ? '↓' : '↑';
      const visible = entry.kind === 'deposit' || entry.kind === 'publicWithdrawal' ? 'AMOUNT PUBLIC' : 'AMOUNT ENCRYPTED';
      return `<article class="receipt-row"><div class="receipt-glyph ${inbound ? 'buy' : 'sell'}">${glyph}</div><div><b>${escapeHtml(label[entry.kind] ?? entry.kind.toUpperCase())}</b><span>${visible}</span></div><div class="receipt-values"><b>${inbound ? '+' : entry.direction === 'outbound' ? '−' : ''}${tokens(entry.amount, 2)} $${escapeHtml(symbol())}</b><span>${escapeHtml(entry.direction.toUpperCase())}</span></div></article>`;
    })
    .join('');
}

let claimable: Rewards | null = null;

async function refreshRewards(): Promise<void> {
  const section = byId('rewards-section');
  if (!session || !env) {
    section.hidden = true;
    return;
  }
  try {
    claimable = await rewards(session, env);
  } catch {
    claimable = null;
  }
  const unit = pair();
  const total = (claimable?.curve ?? 0n) + (claimable?.pool ?? 0n);
  // With fee modules on, the creator's fees are no longer this wallet's to claim: the modules pay them out.
  // The role on chain is asked as well, because the listing learns of a hand-over a moment after it happens.
  const isCreator = detail?.creator === session.address && !detail.module && env.market.creator.toBase58() === session.address;
  const hasPosition = (claimable?.positions.length ?? 0) > 0;
  section.hidden = !(isCreator || hasPosition);
  if (section.hidden) return;
  setText('rewards-amount', withUnit(total, unit, 6));
  const parts: string[] = [];
  if (isCreator) parts.push(`${withUnit(claimable?.curve ?? 0n, unit, 6)} from curve trades`);
  if (hasPosition) parts.push(`${withUnit(claimable?.pool ?? 0n, unit, 6)} from your locked liquidity in the graduated pool`);
  // After graduation the creator holds no position: the platform's position collects the pool's fees.
  const afterGraduation =
    isCreator && status && env.market.stage === 'graduated'
      ? status.creatorPoolPayoutPct > 0
        ? ` Since graduation the platform holds the locked liquidity. It pays you ${status.creatorPoolPayoutPct}% of the pool fees it collects, as public ${unit.symbol} to this wallet, when it claims them. That payment is the platform's; no contract enforces it.`
        : ' Since graduation the platform holds the locked liquidity and keeps the pool fees.'
      : '';
  setText(
    'rewards-note',
    `${parts.join(' · ')}. Rewards are paid in ${unit.symbol}, the token this one is priced in. The claim itself is public: your wallet and the amount. It lands in your private balance in the same transaction.${afterGraduation}`,
  );
  const minimum = minimumClaim();
  byId<HTMLButtonElement>('rewards-claim').disabled = busy || total <= 0n || total < minimum;
}

byId<HTMLButtonElement>('rewards-claim').addEventListener('click', async () => {
  if (!session || !env || busy) return;
  const box = byId('rewards-output');
  busy = true;
  byId<HTMLButtonElement>('rewards-claim').disabled = true;
  try {
    const fresh = await loadMarketEnv(mintParam);
    const result = await claimRewards(session, fresh, minimumClaim(), (message) => {
      box.innerHTML = `<div class="status"><b>WORKING</b><br>${escapeHtml(message)}</div>`;
    });
    const links = result.landed
      .map((landed) => `<a class="tx-link" href="${escapeHtml(explorerTx(landed.signature, network()))}" target="_blank" rel="noopener noreferrer">${escapeHtml(short(landed.signature, 8, 8))}</a>`)
      .join(' · ');
    noteSettled(result);
    box.innerHTML = `<div class="status ok"><b>CLAIMED ${escapeHtml(withUnit(result.amount, pair(), 6))} INTO YOUR PRIVATE BALANCE</b><br>${links}${result.synced ? '' : `<br>${escapeHtml(STALE_BALANCE_NOTE)}`}</div>`;
    toast('Rewards claimed');
    env = await loadMarketEnv(mintParam).catch(() => env);
  } catch (error) {
    box.innerHTML = `<div class="status error"><b>CLAIM FAILED</b><br>${escapeHtml(friendlyError(error))}</div>`;
  } finally {
    busy = false;
    await refreshBalances();
    renderActivity();
    await refreshRewards();
  }
});

/* ---------------- Fee modules ---------------- */

const modulesForm = byId<HTMLFormElement>('modules-form');
const modulesConfirm = byId<HTMLInputElement>('modules-confirm');
const modulesButton = byId<HTMLButtonElement>('modules-button');
let modulesPicker: ModulePicker | null = null;
/** What the section showed last, so that a refresh every twenty seconds does not redraw a form somebody is typing in. */
let modulesShown = '';
/** True from the moment this page switched the modules on, so its confirmation stays up until the listing shows them. */
let modulesSwitchedOn = false;

function refreshModulesButton(): void {
  modulesButton.disabled = busy || !modulesPicker || modulesPicker.problem() !== null || modulesConfirm.value.trim() !== 'PERMANENT';
}

/**
 * The fee modules section. A token that has modules shows what they are and
 * what they have done, to everyone. A token that has none shows the form that
 * switches them on, and only to the wallet that holds its creator role.
 */
function renderModules(): void {
  const section = byId('modules-section');
  const body = byId('modules-body');
  if (!detail) return;
  if (detail.module) {
    modulesSwitchedOn = false;
    const html = moduleHtml(detail.module, detail.pair, status);
    if (modulesShown !== html) {
      modulesShown = html;
      setText('modules-title', 'Fee modules are on');
      setText('modules-lede', "This token's creator does not claim their share of the fees by hand. It is paid out automatically, exactly as set below, and that can never be changed.");
      body.innerHTML = html;
    }
    modulesForm.hidden = true;
    section.hidden = false;
    return;
  }
  if (modulesSwitchedOn) {
    // Just switched on from this page: the confirmation stays, the form goes, and the panel follows with the next reading.
    modulesForm.hidden = true;
    body.innerHTML = '';
    setText('modules-title', 'Fee modules are on');
    setText('modules-lede', 'The settings are on chain. What they do appears here from the next pass on.');
    section.hidden = false;
    return;
  }
  // The role on chain decides, not the listing: only its holder can sign the hand-over. Meteora lets it
  // move while the curve is open and again once the pool exists, not while a completed curve is migrating.
  const canSwitchOn = Boolean(status?.modules.enabled && session && env && env.market.stage !== 'migrating' && env.market.creator.toBase58() === session.address);
  if (!canSwitchOn || !session) {
    section.hidden = true;
    modulesShown = '';
    return;
  }
  if (modulesShown !== 'form') {
    modulesShown = 'form';
    setText('modules-title', 'Automate your fees');
    setText('modules-lede', 'You hold this token\'s creator role. Instead of claiming your share of the trading fees by hand, you can have it bought back and burned, shared between wallets, or both. Only you see this.');
    body.innerHTML =
      '<div class="notice is-plain">Claim any rewards waiting above first if you want them paid straight to you. Whatever is unclaimed when you switch modules on is paid out by the modules instead.</div>';
    modulesPicker = mountModulePicker(byId('modules-picker'), { status, always: true, mint: detail.mint, ownWallet: session.address, onChange: refreshModulesButton });
    modulesConfirm.value = '';
  }
  modulesForm.hidden = false;
  section.hidden = false;
  refreshModulesButton();
}

modulesConfirm.addEventListener('input', refreshModulesButton);

modulesForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!session || !modulesPicker || busy) return;
  const box = byId('modules-output');
  let choice: ReturnType<ModulePicker['read']>;
  try {
    choice = modulesPicker.read();
  } catch (error) {
    toast(friendlyError(error), 'error');
    return;
  }
  if (!choice || modulesConfirm.value.trim() !== 'PERMANENT') return;
  busy = true;
  refreshModulesButton();
  try {
    const landed = await activateModules(session, mintParam, choice, (message) => {
      box.innerHTML = `<div class="status"><b>WORKING</b><br>${escapeHtml(message)}</div>`;
    });
    box.innerHTML = `<div class="status ok"><b>FEE MODULES ARE ON</b><br>${escapeHtml(choiceText(choice))}<br><a class="tx-link" href="${escapeHtml(explorerTx(landed.signature, network()))}" target="_blank" rel="noopener noreferrer">${escapeHtml(short(landed.signature, 8, 8))}</a></div>`;
    toast('Fee modules switched on');
    modulesSwitchedOn = true;
    await refreshMarket();
  } catch (error) {
    box.innerHTML = `<div class="status error"><b>NOT SWITCHED ON</b><br>${escapeHtml(friendlyError(error))}</div>`;
  } finally {
    busy = false;
    refreshModulesButton();
    await refreshRewards();
  }
});

/* ---------------- Graduation ---------------- */

const graduateButton = byId<HTMLButtonElement>('graduate-button');

/**
 * A completed curve waits to be moved into its Meteora pool. Meteora's keeper
 * does that for the pair tokens and sizes it covers; for the rest, and for a
 * curve the keeper is slow to reach, anyone can send the move from here.
 */
function renderGraduate(): void {
  const box = byId('graduate-box');
  const stage = env?.market.stage ?? detail?.stage;
  box.hidden = stage !== 'migrating' || !status?.rpcConfigured;
  if (box.hidden) return;
  const rule = pairOf(status, pair().id);
  const keeper =
    rule?.keeperGraduates === true
      ? "Meteora's keeper moves curves like this one into their pool by itself, usually within a few minutes. The button below is for when it has not."
      : rule?.keeperGraduates === false
        ? "Meteora's keeper does not move curves of this size by itself, so somebody has to send the move, with the button below."
        : `Meteora's keeper moves a curve priced in ${pair().symbol} by itself only under conditions it sets, so this one may wait until somebody sends the move, with the button below.`;
  setText(
    'graduate-note',
    `Every token the curve sells has been bought, and trading is paused until the curve moves into its Meteora pool. ${keeper} Anyone may press it. It costs whoever does about 0.06 SOL, the rent of the new pool's accounts, and pays them nothing. The liquidity goes where the token's config says: to the platform's position, locked.`,
  );
  graduateButton.disabled = busy;
}

graduateButton.addEventListener('click', async () => {
  if (busy) return;
  const box = byId('graduate-output');
  const wallet = await requireWallet(byId('graduate-gate'), 'to graduate this curve');
  if (!wallet) return;
  busy = true;
  refreshButton();
  try {
    const landed = await graduate(wallet, mintParam, (message) => {
      box.innerHTML = `<div class="status"><b>WORKING</b><br>${escapeHtml(message)}</div>`;
    });
    box.innerHTML = `<div class="status ok"><b>GRADUATED · SETTLED</b><br><a class="tx-link" href="${escapeHtml(explorerTx(landed.signature, network()))}" target="_blank" rel="noopener noreferrer">${escapeHtml(short(landed.signature, 10, 10))}</a><br>The token now trades in its Meteora pool, at the same fee.</div>`;
    toast('Curve graduated');
  } catch (error) {
    box.innerHTML = `<div class="status error"><b>NOT GRADUATED</b><br>${escapeHtml(friendlyError(error))}</div>`;
  } finally {
    busy = false;
    refreshButton();
    await refreshBalances();
    await refreshMarket();
  }
});

/* ---------------- Trade form ---------------- */

function renderRoutes(): void {
  const ghost = ghostAvailability();
  if (!routeChosen) route = defaultRoute();
  if (route === 'ghost' && !ghost.ok) route = 'shielded';
  if (route === 'public' && side === 'sell') route = defaultRoute();
  const option = (key: Route, title: string, tag: string, copy: string, off: string) =>
    `<label class="route ${route === key ? 'is-selected' : ''} ${off ? 'is-off' : ''}"><input type="radio" name="route" value="${key}" ${route === key ? 'checked' : ''} ${off ? 'disabled' : ''}><span><b>${title}<span class="route-tag">${tag}</span></b><span>${escapeHtml(off || copy)}</span></span></label>`;
  const cap = deskCap();
  const passed = ghost.ok && !routeChosen && ghostDeclinedNow() && ghostDeclined ? ` The desk passed on this order: ${ghostDeclined.reason}` : '';
  const ghostCopy = `You and the desk swap private transfers in one co-signed transaction. Token and amount are encrypted on chain.${cap > 0n ? ` Up to ${withUnit(cap, SOL_REF, 4)} a trade.` : ''}${passed}`;
  const options = [
    option('ghost', 'Ghost fill', 'SIZE HIDDEN', ghostCopy, ghost.reason),
    option(
      'shielded',
      'Shielded route',
      'SIZE PUBLIC',
      converting()
        ? side === 'buy'
          ? 'Private balance → Jupiter → Meteora pool → private balance, in one atomic transaction. Both swaps are public.'
          : 'Private balance → Meteora pool → Jupiter → private balance, in one atomic transaction. Both swaps are public.'
        : 'Private balance → Meteora pool → private balance, in one atomic transaction. The pool trade itself is public.',
      '',
    ),
  ];
  if (side === 'buy') {
    options.push(option('public', 'Public entry', 'SIZE PUBLIC', `Pay with public ${counter().symbol} and receive straight into your private balance. For a wallet that has not deposited yet.`, ''));
  }
  const container = byId('routes');
  container.innerHTML = options.join('');
  container.querySelectorAll<HTMLInputElement>('input[name=route]').forEach((input) => {
    input.addEventListener('change', () => {
      route = input.value as Route;
      routeChosen = true;
      renderForm();
      scheduleQuote(0);
    });
  });
}

function renderVisibility(): void {
  const row = (label: string, value: string, hidden: boolean) => `<dt>${label}</dt><dd class="${hidden ? 'is-hidden' : 'is-public'}">${value}</dd>`;
  let rows: string;
  if (converting()) {
    const hiddenEnd = side === 'buy' ? 'What you hold afterwards' : 'The balance it returns to';
    rows = `${row('Your wallet', 'PUBLIC', false)}${row('Token and trade size', 'PUBLIC', false)}${row(`The conversion ${side === 'buy' ? 'from' : 'to'} ${escapeHtml(counter().symbol)}`, 'PUBLIC', false)}${route === 'public' ? '' : row('The balance it came from', 'ENCRYPTED', true)}${row(hiddenEnd, 'ENCRYPTED', true)}${row('What Jupiter is told', 'WALLET, TOKENS, AMOUNT', false)}`;
  } else if (route === 'ghost') {
    rows = `${row('Your wallet and the desk’s wallet', 'PUBLIC', false)}${row('That the two traded privately', 'PUBLIC', false)}${row('Which token', 'ENCRYPTED', true)}${row('How much, and at what price', 'ENCRYPTED', true)}${row('What the desk learns', 'YOUR TRADE', false)}`;
  } else if (route === 'shielded') {
    rows = `${row('Your wallet', 'PUBLIC', false)}${row('Token and trade size', 'PUBLIC', false)}${row('The balance it came from', 'ENCRYPTED', true)}${row('The balance it returns to', 'ENCRYPTED', true)}`;
  } else {
    rows = `${row('Your wallet', 'PUBLIC', false)}${row('Token and trade size', 'PUBLIC', false)}${row('What you hold afterwards', 'ENCRYPTED', true)}${row('Private transfers later', 'ENCRYPTED', true)}`;
  }
  byId('visibility').innerHTML = `<div class="visibility-title">What an observer sees</div>${rows}`;
}

/** What a buy on the chosen route can draw on, in the pair token's base units. Null while it has not been read. */
function buySource(): bigint | null {
  if (converting()) return route === 'public' ? publicCounter : synced ? privateCounter : null;
  if (route === 'public') return publicQuote;
  return synced ? privateQuote : null;
}

function renderQuick(): void {
  const quick = byId('quick');
  // A buy is entered in what it is paid with, which is the pair token unless another was chosen.
  const unit = counter();
  if (side === 'buy') {
    const sized = quickAmounts(status, unit);
    const amounts = sized.length === 0 && unit.id === 'USDC' ? USDC_QUICK_AMOUNTS : sized;
    quick.innerHTML = `${amounts
      .map((value) => `<button type="button" data-amount="${escapeHtml(value)}">${escapeHtml(value)}</button>`)
      .join('')}<button type="button" data-max>MAX</button>`;
    const source = buySource();
    const where = route === 'public' ? 'Public' : 'Private';
    setText(
      'amount-hint',
      !session ? '' : source === null ? `${where} ${unit.symbol} available: ${route !== 'public' && !syncProblem ? 'reading…' : 'not read'}` : `${where} ${unit.symbol} available: ${pairAmount(source, unit, 4)}`,
    );
  } else {
    quick.innerHTML = '<button type="button" data-share="25">25%</button><button type="button" data-share="50">50%</button><button type="button" data-share="100">MAX</button>';
    setText('amount-hint', !session ? '' : synced ? `Private $${symbol()} available: ${tokens(privateToken, 2)}` : `Private $${symbol()} available: ${syncProblem ? 'not read' : 'reading…'}`);
  }
  quick.querySelectorAll<HTMLButtonElement>('button').forEach((button) => {
    button.addEventListener('click', () => {
      if (button.dataset.amount) amountInput.value = button.dataset.amount;
      else if (button.dataset.max !== undefined) {
        const source = buySource() ?? 0n;
        // Public SOL also pays the fees and the temporary rent, so some of it is kept back. Nothing else needs that.
        const reserve = route === 'public' && isSol(unit) ? GAS_RESERVE_LAMPORTS * 2n : 0n;
        amountInput.value = plain(source > reserve ? source - reserve : 0n, unit);
      } else if (button.dataset.share) {
        const units = (privateToken * BigInt(button.dataset.share)) / 100n;
        amountInput.value = tokens(units, TOKEN_DECIMALS).replaceAll(',', '');
      }
      scheduleQuote(0);
    });
  });
  renderConvert();
}

/**
 * The line under the amount that says what this token is paid for in, and what
 * to do with SOL or USDC instead. Where the site converts, that is the choice
 * above the routes. Where it does not, it is a swap on Jupiter in the
 * visitor's own wallet first.
 */
function renderConvert(): void {
  const line = byId('convert-line');
  const unit = pair();
  if (status?.convert?.enabled) {
    line.hidden = !converting() && isSol(unit);
    if (line.hidden) return;
    const other = counter();
    // What else is on offer for this token: "SOL", or "SOL or USDC".
    const others = counterOptions(status, unit)
      .filter((option) => option.mint !== unit.mint)
      .map((option) => option.symbol)
      .join(' or ');
    line.innerHTML = converting()
      ? side === 'buy'
        ? `Your <b>${escapeHtml(other.symbol)}</b> is converted to ${escapeHtml(unit.symbol)} on Jupiter and the token is bought with it, in one transaction: all of it happens, or none. The little that either swap does not use stays in your wallet as public ${escapeHtml(unit.symbol)}.`
        : `The ${escapeHtml(unit.symbol)} this sale returns is converted to <b>${escapeHtml(other.symbol)}</b> on Jupiter in the same transaction: all of it happens, or none. The little either swap returns above its minimum stays in your wallet, public.`
      : side === 'buy'
        ? `This token is priced in <b>${escapeHtml(unit.symbol)}</b>. Hold ${escapeHtml(others)} instead? Choose it under “Pay with” above and it is converted in the same transaction.`
        : `This token is priced in <b>${escapeHtml(unit.symbol)}</b>, and a sale pays out in it. Rather have ${escapeHtml(others)}? Choose it under “Receive” above and it is converted in the same transaction.`;
    return;
  }
  line.hidden = isSol(unit);
  if (line.hidden) return;
  const link = `https://jup.ag/swap?sell=${encodeURIComponent(WSOL_MINT)}&buy=${encodeURIComponent(unit.mint)}`;
  line.innerHTML = `This token is bought and sold in <b>${escapeHtml(unit.symbol)}</b>, not SOL. Hold SOL or another token instead? <a class="tx-link" href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">Swap it for ${escapeHtml(unit.symbol)} on Jupiter</a>, then pay here with Public entry, or deposit it in your <a class="tx-link" href="/wallet">wallet</a> first.<span class="convert-mint">${escapeHtml(unit.symbol)} mint · ${escapeHtml(short(unit.mint, 6, 6))} <button class="icon-btn" type="button" data-copy="${escapeHtml(unit.mint)}">COPY</button></span>`;
  wireCopyButtons(line);
}

/** The choice of what a buy is paid with, or a sell paid out in. Shown only when there is a choice. */
function renderCounter(): void {
  const options = counterOptions(status, pair());
  const field = byId('counter-field');
  field.hidden = options.length < 2;
  if (field.hidden) {
    counterId = '';
    return;
  }
  setText('counter-label', side === 'buy' ? 'Pay with' : 'Receive');
  const chosen = counter();
  const container = byId('counter-options');
  container.innerHTML = options
    .map(
      (option) =>
        `<button type="button" class="${option.mint === chosen.mint ? 'on' : ''}" data-counter="${escapeHtml(option.id)}" aria-pressed="${option.mint === chosen.mint}">${escapeHtml(option.symbol)}${option.mint === pair().mint ? '' : '<i>via Jupiter</i>'}</button>`,
    )
    .join('');
  container.querySelectorAll<HTMLButtonElement>('button').forEach((button) => {
    button.addEventListener('click', () => {
      const picked = button.dataset.counter ?? '';
      const next = picked === pair().id ? '' : picked;
      if (busy || next === counterId) return;
      counterId = next;
      amountInput.value = '';
      clearQuote();
      quoteBox.innerHTML = '<dt>Enter an amount</dt><dd>—</dd>';
      tradeOutput.innerHTML = '';
      renderForm();
      // The balance of what was chosen has to be read, and the wallet may not have met that token yet.
      if (session) void readPrivateBalance();
    });
  });
}

function renderForm(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-side]').forEach((tab) => tab.classList.toggle('on', tab.dataset.side === side));
  renderCounter();
  renderRoutes();
  renderVisibility();
  renderQuick();
  setText('amount-label', side === 'buy' ? 'You pay' : 'You sell');
  setText('amount-unit', side === 'buy' ? counter().symbol : symbol());
  // On Ghost fill the limit is how far the desk's price may move between the quote on screen and the fill.
  byId('slippage-field').hidden = false;
  refreshButton();
}

function refreshButton(): void {
  const state = tradable();
  const verb = side === 'buy' ? 'Buy' : 'Sell';
  tradeButton.textContent = !state.ok ? 'Trading unavailable' : route === 'ghost' ? `${verb} · ghost fill` : route === 'shielded' ? `${verb} · shielded` : 'Buy into private balance';
  tradeButton.disabled = busy || !state.ok;
  moveButton.disabled = busy;
  graduateButton.disabled = busy;
}

function clearQuote(): void {
  buyPlan = null;
  sellPlan = null;
  deskQuote = null;
  convertedBuyPlan = null;
  convertedSellPlan = null;
}

/** True when there is a pool quote on screen that the button can trade on. */
function hasPlan(): boolean {
  return Boolean(buyPlan || sellPlan || convertedBuyPlan || convertedSellPlan);
}

function scheduleQuote(delay = 450): void {
  window.clearTimeout(quoteTimer);
  // A converted quote asks Jupiter, whose allowance is shared by every visitor: wait until the typing has stopped.
  quoteTimer = window.setTimeout(() => void runQuote(), converting() && delay > 0 ? Math.max(delay, 800) : delay);
}

async function runQuote(): Promise<void> {
  const sequence = ++quoteSequence;
  clearQuote();
  tradeOutput.innerHTML = '';
  // While the route is this page's pick, it follows the order: a size the desk passed on goes to the pool,
  // and a size it can take comes back to the desk.
  if (!routeChosen && route !== 'public' && route !== defaultRoute()) renderForm();
  const state = tradable();
  if (!state.ok) {
    quoteBox.innerHTML = `<dt>Trading</dt><dd>${escapeHtml(state.reason)}</dd>`;
    refreshButton();
    return;
  }
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
  // The limit is on the pair-token side of a trade. A converted buy is entered in another token, so it is held to it once quoted.
  const limit = side === 'buy' && !converting() ? overLimit(amount) : null;
  if (limit) {
    quoteBox.innerHTML = `<dt>Limit</dt><dd>${escapeHtml(limit)}</dd>`;
    refreshButton();
    return;
  }
  if (converting() && !session) {
    quoteBox.innerHTML = '<dt>Wallet</dt><dd>Unlock a wallet to see this quote: Jupiter builds the conversion for your address.</dd>';
    refreshButton();
    return;
  }
  quoteBox.innerHTML = '<dt>Quoting</dt><dd>…</dd>';
  try {
    if (route === 'ghost') {
      const asked = side;
      /** The desk will not take this order. When Ghost fill was the page's own pick, the pool takes it instead. */
      const declined = (code: string, reason: string, from: bigint = amount): boolean => {
        if (routeChosen) return false;
        ghostDeclined = { side: asked, code, reason, amount: from, at: Date.now() };
        renderForm();
        void runQuote();
        return true;
      };
      const cap = deskCap();
      if (side === 'buy' && cap > 0n && amount > cap) {
        const reason = `It fills up to ${withUnit(cap, SOL_REF, 4)} a trade.`;
        // Everything above the desk's own limit is refused the same way: one refusal covers all of it.
        if (declined('TOO_LARGE', reason, cap + 1n)) return;
        quoteBox.innerHTML = `<dt>Quote</dt><dd>${escapeHtml(`This is more than the desk fills in one trade. ${reason} Use the Shielded route, or a smaller size.`)}</dd>`;
        refreshButton();
        return;
      }
      let quote: GhostQuote;
      try {
        quote = await ghostQuote(side, mintParam, amount);
      } catch (error) {
        if (sequence !== quoteSequence) return;
        const code = (error as { code?: unknown } | null)?.code;
        if (isDeskDecline(code) && declined(code as string, friendlyError(error))) return;
        throw error;
      }
      if (sequence !== quoteSequence) return;
      deskQuote = quote;
      deskQuoteAt = Date.now();
    } else if (converting() && session) {
      const taker = session.address;
      if (side === 'buy') {
        const plan = await planConvertedBuy(env as MarketEnv, taker, counter(), amount, slippageBps(), route === 'public' ? 'public' : 'private');
        if (sequence !== quoteSequence) return;
        const buyLimit = overLimit(plan.swap.expectedOut);
        if (buyLimit) {
          quoteBox.innerHTML = `<dt>Limit</dt><dd>${escapeHtml(buyLimit)}</dd>`;
          refreshButton();
          return;
        }
        convertedBuyPlan = plan;
      } else {
        const plan = await planConvertedSell(env as MarketEnv, taker, counter(), amount, slippageBps());
        if (sequence !== quoteSequence) return;
        const sellLimit = overLimit(plan.sell.amountOut);
        if (sellLimit) {
          quoteBox.innerHTML = `<dt>Limit</dt><dd>${escapeHtml(sellLimit)}</dd>`;
          refreshButton();
          return;
        }
        convertedSellPlan = plan;
      }
    } else if (side === 'buy') {
      const plan = await planShieldedBuy(env as MarketEnv, amount, slippageBps());
      if (sequence !== quoteSequence) return;
      buyPlan = plan;
    } else {
      const plan = await planShieldedSell(env as MarketEnv, amount, slippageBps());
      if (sequence !== quoteSequence) return;
      const sellLimit = overLimit(plan.amountOut);
      if (sellLimit) {
        quoteBox.innerHTML = `<dt>Limit</dt><dd>${escapeHtml(sellLimit)}</dd>`;
        refreshButton();
        return;
      }
      sellPlan = plan;
    }
    renderQuote();
  } catch (error) {
    if (sequence !== quoteSequence) return;
    quoteBox.innerHTML = `<dt>Quote</dt><dd>${escapeHtml(friendlyError(error))}</dd>`;
  }
  refreshButton();
}

function splitLine(): string {
  if (!status) return '';
  // In the graduated pool the fee goes to Meteora's protocol share and then to the one locked position, the platform's.
  if (env?.market.stage === 'graduated') {
    return `<dt>Fee goes to</dt><dd>Meteora's protocol share, then the platform's locked position · ${escapeHtml(payoutClause(status))}</dd>`;
  }
  const split = ownSplit() ?? feeSplit(status.economics);
  return `<dt>Fee split</dt><dd>${split.creatorPct}% creator · ${split.platformPct}% platform · ${split.protocolPct}% Meteora</dd>`;
}

function renderQuote(): void {
  const ticker = escapeHtml(symbol());
  const unit = pair();
  /** An amount of the pair token, with its ticker. */
  const paid = (units: bigint | string): string => escapeHtml(withUnit(units, unit, 6));
  const leftover = isSol(unit) ? 'public SOL' : `public ${escapeHtml(unit.symbol)}, in your token account`;
  if (deskQuote) {
    const buying = deskQuote.side === 'buy';
    const receive = buying ? `${tokens(deskQuote.receiveAmount, 2)} $${ticker}` : paid(deskQuote.receiveAmount);
    const pay = buying ? paid(deskQuote.payAmount) : `${tokens(deskQuote.payAmount, 2)} $${ticker}`;
    const reference = buying ? `${tokens(deskQuote.referenceAmount, 2)} $${ticker}` : paid(deskQuote.referenceAmount);
    const floorUnits = floorAfterTolerance(BigInt(deskQuote.receiveAmount), slippageBps());
    const floor = buying ? `${tokens(floorUnits, 2)} $${ticker}` : paid(floorUnits);
    quoteBox.innerHTML = `<dt>You receive, about</dt><dd class="quote-main">${receive}</dd><dt>At least</dt><dd>${floor} · or nothing is sent</dd><dt>You pay, exactly</dt><dd>${pay}</dd><dt>Pool price right now</dt><dd>${reference}</dd><dt>Desk spread</dt><dd>${(deskQuote.spreadBps / 100).toFixed(2)}%</dd><dt>Pool fee</dt><dd>${feeLabel(detail?.feeBps ?? 0)} · inside the pool price</dd><dt>Network fee</dt><dd>Paid by the desk</dd><dt>This price</dt><dd id="quote-ttl">${deskQuoteAge()}</dd>`;
    return;
  }
  const venueOf = (quote: TradeQuote): string => (quote.venue === 'curve' ? 'Meteora bonding curve' : 'Meteora DAMM v2 pool');
  const viaOf = (labels: readonly string[]): string => (labels.length > 0 ? `Jupiter (${escapeHtml(labels.join(' → '))})` : 'Jupiter');
  if (convertedBuyPlan) {
    const { paying, swap, buy, source } = convertedBuyPlan;
    const quote = buy.quote;
    const spare = swap.expectedOut > quote.amountIn ? swap.expectedOut - quote.amountIn : 0n;
    quoteBox.innerHTML = `<dt>You receive, exactly</dt><dd class="quote-main">${tokens(quote.amountOut, 2)} $${ticker}</dd><dt>You pay, exactly</dt><dd>${escapeHtml(withUnit(swap.amountIn, paying, 6))} · ${source === 'public' ? 'public' : 'private'}</dd><dt>Converted to</dt><dd>about ${paid(swap.expectedOut)}, at least ${paid(swap.minimumOut)}</dd><dt>The pool takes, about</dt><dd>${paid(quote.amountIn)}</dd><dt>Left over, about</dt><dd>${paid(spare)} · stays in your wallet, public</dd><dt>Trading fee (${feeLabel(quote.feeBps)})</dt><dd>${paid(quote.fee)}</dd>${splitLine()}<dt>Conversion fee</dt><dd>None to this site or to Jupiter. The route's own pools take theirs inside the price.</dd><dt>Venues</dt><dd>${viaOf(swap.route)}, then ${venueOf(quote)}</dd><dt>Slippage limit</dt><dd>${(convertedBuyPlan.slippageBps / 100).toFixed(2)}% in all, half for each swap</dd>${buy.completesCurve ? '<dt>This buy completes the curve</dt><dd>It takes every token the curve still sells. The token then graduates to its Meteora pool, and trading pauses while it moves.</dd>' : ''}`;
    return;
  }
  if (convertedSellPlan) {
    const { receiving, swap, sell } = convertedSellPlan;
    const got = (units: bigint): string => escapeHtml(withUnit(units, receiving, 6));
    const spare = sell.amountOut > sell.minimumAmountOut ? sell.amountOut - sell.minimumAmountOut : 0n;
    quoteBox.innerHTML = `<dt>You receive, about</dt><dd class="quote-main">${got(swap.expectedOut)}</dd><dt>Into your private balance, exactly</dt><dd>${got(swap.minimumOut)}</dd><dt>Anything above that</dt><dd>Arrives as public ${escapeHtml(receiving.symbol)}</dd><dt>The pool pays, about</dt><dd>${paid(sell.amountOut)}, at least ${paid(sell.minimumAmountOut)}</dd><dt>Converted</dt><dd>${paid(sell.minimumAmountOut)}, exactly</dd><dt>Left over, about</dt><dd>${paid(spare)} · stays in your wallet, public</dd><dt>Trading fee (${feeLabel(sell.feeBps)})</dt><dd>${paid(sell.fee)}</dd>${splitLine()}<dt>Conversion fee</dt><dd>None to this site or to Jupiter. The route's own pools take theirs inside the price.</dd><dt>Venues</dt><dd>${venueOf(sell)}, then ${viaOf(swap.route)}</dd><dt>Slippage limit</dt><dd>${(convertedSellPlan.slippageBps / 100).toFixed(2)}% in all, half for each swap</dd>`;
    return;
  }
  if (buyPlan) {
    const quote = buyPlan.quote;
    const source = `${route === 'public' ? 'public' : 'private'} ${escapeHtml(unit.symbol)}`;
    quoteBox.innerHTML = `<dt>You receive, exactly</dt><dd class="quote-main">${tokens(quote.amountOut, 2)} $${ticker}</dd><dt>Expected cost</dt><dd>${paid(quote.amountIn)}</dd><dt>You pay at most</dt><dd>${escapeHtml(pairAmount(buyPlan.spendCap, unit, 6))} ${source}</dd>${route === 'shielded' ? `<dt>Unused part of that</dt><dd>Stays as ${leftover}</dd>` : ''}<dt>Trading fee (${feeLabel(quote.feeBps)})</dt><dd>${paid(quote.fee)}</dd>${splitLine()}<dt>Venue</dt><dd>${quote.venue === 'curve' ? 'Meteora bonding curve' : 'Meteora DAMM v2 pool'}</dd>${buyPlan.completesCurve ? '<dt>This buy completes the curve</dt><dd>It takes every token the curve still sells, for less than you entered. The token then graduates to its Meteora pool, and trading pauses while it moves.</dd>' : ''}`;
    return;
  }
  if (sellPlan) {
    quoteBox.innerHTML = `<dt>You receive, about</dt><dd class="quote-main">${paid(sellPlan.amountOut)}</dd><dt>Into your private balance, exactly</dt><dd>${paid(sellPlan.minimumAmountOut)}</dd><dt>Anything above that</dt><dd>Arrives as ${leftover}</dd><dt>Trading fee (${feeLabel(sellPlan.feeBps)})</dt><dd>${paid(sellPlan.fee)}</dd>${splitLine()}<dt>Venue</dt><dd>${sellPlan.venue === 'curve' ? 'Meteora bonding curve' : 'Meteora DAMM v2 pool'}</dd>`;
  }
}

/** How old the desk's price on screen is. The desk is asked again when the button is pressed. */
function deskQuoteAge(): string {
  const seconds = Math.max(0, Math.round((Date.now() - deskQuoteAt) / 1000));
  return `${seconds < 2 ? 'Just now' : `${seconds}s old`} · asked again when you press`;
}

window.setInterval(() => {
  if (!deskQuote) return;
  const node = document.getElementById('quote-ttl');
  if (node) node.textContent = deskQuoteAge();
}, 1000);

function stage(message: string): void {
  tradeOutput.innerHTML = `<div class="status"><b>WORKING</b><br>${escapeHtml(message)}</div>`;
}

async function requireWallet(container: HTMLElement = tradeGate, purpose = 'to trade'): Promise<Session | null> {
  if (session) return session;
  session = await ensureWallet(container, {
    purpose,
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
  renderModules();
  await readPrivateBalance();
  await refreshRewards();
}

/** Reads the private balance from chain. On failure the page says so and offers to try again. */
async function readPrivateBalance(): Promise<void> {
  if (!session) return;
  synced = false;
  syncProblem = null;
  await refreshBalances();
  renderActivity();
  try {
    await knowAsset(session, mintAddress());
    // The pair token too, so the balance a buy spends from can be read.
    await knowAsset(session, quoteAsset());
    // And whatever else was chosen to pay with. A token Rings has no interface for is simply not held privately.
    if (converting()) await knowAsset(session, counterAsset()).catch(() => undefined);
    await session.sync();
    synced = true;
  } catch (error) {
    syncProblem = friendlyError(error);
  }
  await refreshBalances();
  renderActivity();
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

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy) return;
  const state = tradable();
  if (!state.ok) {
    toast(state.reason, 'error');
    return;
  }
  const wallet = await requireWallet();
  if (!wallet) return;
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
  // Every route but Public entry spends from the private balance, which must have been read.
  if (!(side === 'buy' && route === 'public') && !synced) {
    tradeOutput.innerHTML = `<div class="status error"><b>BALANCE NOT READ</b><br>${
      syncProblem
        ? 'Your private balance could not be read, so nothing can be traded out of it yet. Nothing is lost. Use Try again under Your private activity.'
        : 'Your private balance is still being read. Try again in a moment.'
    }</div>`;
    return;
  }
  if (route === 'ghost' && !deskQuote) {
    // Never fill on numbers the trader has not seen.
    await runQuote();
    if (deskQuote) toast('Here is the quote. Check it, then press again.');
    return;
  }
  if (route !== 'ghost' && !hasPlan()) {
    await runQuote();
    if (!hasPlan()) return;
  }

  busy = true;
  refreshButton();
  form.classList.add('is-loading');
  try {
    let signature: string;
    let reread: boolean;
    if (route === 'ghost') {
      const shown = deskQuote as GhostQuote;
      const result = await ghostFill(wallet, shown, floorAfterTolerance(BigInt(shown.receiveAmount), slippageBps()), stage);
      signature = result.signature;
      reread = result.synced;
    } else {
      // Re-plan against the pool as it is now. The slippage limit bounds the difference.
      stage('Reading the pool…');
      const fresh = await loadMarketEnv(mintParam);
      env = fresh;
      if (converting()) {
        // Never trade on numbers that were not on screen: a fresh quote that is worse than the one shown
        // by more than the limit is put on screen instead, to be looked at and pressed again.
        const moved = (): void => {
          renderQuote();
          tradeOutput.innerHTML = '<div class="status"><b>NEW QUOTE</b><br>The price moved since the quote above was made. Check the new one, then press again. Nothing was sent.</div>';
          toast('New quote. Check it, then press again.');
        };
        if (side === 'buy') {
          const shown = convertedBuyPlan;
          stage('Asking Jupiter for the conversion…');
          const plan = await planConvertedBuy(fresh, wallet.address, counter(), amount, slippageBps(), route === 'public' ? 'public' : 'private');
          const limit = overLimit(plan.swap.expectedOut);
          if (limit) throw new Error(limit);
          if (shown && plan.buy.quote.amountOut < minusBps(shown.buy.quote.amountOut, slippageBps())) {
            convertedBuyPlan = plan;
            moved();
            return;
          }
          const landed = await convertedBuy(wallet, fresh, plan, stage);
          signature = landed.signature;
          reread = landed.synced;
        } else {
          const shown = convertedSellPlan;
          stage('Asking Jupiter for the conversion…');
          const plan = await planConvertedSell(fresh, wallet.address, counter(), amount, slippageBps());
          const limit = overLimit(plan.sell.amountOut);
          if (limit) throw new Error(limit);
          if (shown && plan.swap.minimumOut < minusBps(shown.swap.minimumOut, slippageBps())) {
            convertedSellPlan = plan;
            moved();
            return;
          }
          const landed = await convertedSell(wallet, fresh, plan, stage);
          signature = landed.signature;
          reread = landed.synced;
        }
      } else if (side === 'buy') {
        const limit = overLimit(amount);
        if (limit) throw new Error(limit);
        const plan = await planShieldedBuy(fresh, amount, slippageBps());
        const landed = route === 'public' ? await publicBuyToPrivate(wallet, fresh, plan, stage) : await shieldedBuy(wallet, fresh, plan, stage);
        signature = landed.signature;
        reread = landed.synced;
      } else {
        const plan = await planShieldedSell(fresh, amount, slippageBps());
        const limit = overLimit(plan.amountOut);
        if (limit) throw new Error(limit);
        const landed = await shieldedSell(wallet, fresh, plan, stage);
        signature = landed.signature;
        reread = landed.synced;
      }
    }
    noteSettled({ synced: reread });
    tradeOutput.innerHTML = `<div class="status ok"><b>${side === 'buy' ? 'BOUGHT' : 'SOLD'} · SETTLED</b><br><a class="tx-link" href="${escapeHtml(explorerTx(signature, network()))}" target="_blank" rel="noopener noreferrer">${escapeHtml(short(signature, 10, 10))}</a>${reread ? '' : `<br>${escapeHtml(STALE_BALANCE_NOTE)}`}</div>`;
    toast(side === 'buy' ? 'Buy settled' : 'Sell settled');
    amountInput.value = '';
    clearQuote();
    quoteBox.innerHTML = '<dt>Enter an amount</dt><dd>—</dd>';
    void api.refreshToken(mintParam).catch(() => null);
  } catch (error) {
    if (error instanceof QuoteMoved) {
      // The desk's price went past the limit while the proof was being made. Nothing was sent:
      // the new price goes on screen, to be taken with another press or left.
      deskQuote = error.fresh;
      deskQuoteAt = Date.now();
      renderQuote();
      tradeOutput.innerHTML = '<div class="status"><b>NEW QUOTE</b><br>The desk’s price moved past your limit while your transfer was being proved. Check the new one, then press again. Nothing was sent.</div>';
      toast('New quote. Check it, then press again.');
    } else {
      tradeOutput.innerHTML = `<div class="status error"><b>TRADE FAILED</b><br>${escapeHtml(friendlyError(error))}</div>`;
    }
  } finally {
    busy = false;
    form.classList.remove('is-loading');
    refreshButton();
    await refreshBalances();
    renderActivity();
    void refreshMarket();
  }
});

document.querySelectorAll<HTMLButtonElement>('[data-side]').forEach((tab) => {
  tab.addEventListener('click', () => {
    if (busy || tab.dataset.side === side) return;
    side = tab.dataset.side as Side;
    amountInput.value = '';
    clearQuote();
    quoteBox.innerHTML = '<dt>Enter an amount</dt><dd>—</dd>';
    renderForm();
  });
});
amountInput.addEventListener('input', () => scheduleQuote());
slippageSelect.addEventListener('change', () => scheduleQuote(0));

/* ---------------- Send or burn ---------------- */

type MoveMode = 'send' | 'burn';

const moveForm = byId<HTMLFormElement>('mv-form');
const moveAmount = byId<HTMLInputElement>('mv-amount');
const moveRecipient = byId<HTMLInputElement>('mv-recipient');
const moveSource = byId<HTMLSelectElement>('mv-source');
const moveConfirm = byId<HTMLInputElement>('mv-confirm');
const moveButton = byId<HTMLButtonElement>('mv-button');
const moveOutput = byId('mv-output');
const moveGate = byId('mv-gate');

let moveMode: MoveMode = 'send';
let recipientKind: RecipientKind = 'empty';
let recipientTimer: number | undefined;
// Whether an address can receive privately is public and needs no wallet, so it is checked as it is typed.
const recipients = new RecipientChecker((candidate) => canReceivePrivately(address(candidate)));

function burnSource(): 'private' | 'public' {
  return moveSource.value === 'public' ? 'public' : 'private';
}

/** What the amount can draw on right now, or null while that balance has not been read. */
function moveAvailable(): bigint | null {
  if (!session) return null;
  if (moveMode === 'burn' && burnSource() === 'public') return publicToken;
  return synced ? privateToken : null;
}

function moveAmountUnits(): bigint {
  const text = moveAmount.value.trim();
  return text ? parseUnits(text, TOKEN_DECIMALS) : 0n;
}

function renderRecipientHint(): void {
  const hint = byId('mv-recipient-hint');
  hint.textContent = RECIPIENT_HINTS[recipientKind];
  hint.dataset.state = recipientKind;
}

function lookAtRecipient(): void {
  recipientKind = recipients.look(moveRecipient.value, session?.address ?? '', (kind) => {
    recipientKind = kind;
    renderRecipientHint();
  });
  renderRecipientHint();
}

/** What the transfer or the burn on screen would do, in numbers. */
function renderMoveEffect(): void {
  const box = byId('mv-effect');
  const ticker = escapeHtml(symbol());
  let amount = 0n;
  let problem = '';
  try {
    amount = moveAmountUnits();
  } catch (error) {
    problem = friendlyError(error);
  }
  if (problem) {
    box.innerHTML = `<dt>Amount</dt><dd>${escapeHtml(problem)}</dd>`;
    return;
  }
  const exact = amount > 0n ? `${tokens(amount, TOKEN_DECIMALS)} $${ticker}` : '—';
  if (moveMode === 'send') {
    box.innerHTML = `<dt>They receive, exactly</dt><dd class="quote-main">${exact}</dd><dt>Arrives in</dt><dd>Their private balance</dd><dt>Fee to this site</dt><dd>None</dd><dt>Network fee</dt><dd>From your public SOL</dd><dt>Can it be taken back</dt><dd>No · only they can return it</dd>`;
    return;
  }
  const supply = supplyNow();
  const effect = supply !== null ? burnEffect(supply, amount) : null;
  box.innerHTML = `<dt>Destroyed, exactly</dt><dd class="quote-main">${exact}</dd><dt>Supply now</dt><dd>${supply !== null ? tokens(supply, 2) : 'Not read yet'}</dd><dt>Supply after</dt><dd>${effect ? tokens(effect.after, 2) : '—'}</dd><dt>This burn, of the supply now</dt><dd>${effect ? `${effect.sharePct}%` : '—'}</dd><dt>Burned in all, after this</dt><dd>${effect ? `${tokens(effect.burnedAfter, 2)} · ${effect.burnedPct}%` : '—'}</dd><dt>You get back</dt><dd>Nothing</dd><dt>Fee to this site</dt><dd>None</dd>`;
}

function renderMove(): void {
  const ticker = symbol();
  const burning = moveMode === 'burn';
  document.querySelectorAll<HTMLButtonElement>('[data-mv]').forEach((tab) => tab.classList.toggle('on', tab.dataset.mv === moveMode));
  byId('mv-source-field').hidden = !burning;
  byId('mv-recipient-field').hidden = burning;
  byId('mv-confirm-field').hidden = !burning;
  setText('mv-amount-label', burning ? 'Amount to burn' : 'Amount to send');
  setText('mv-unit', ticker);
  setText('mv-private', !session ? '—' : synced ? `${tokens(privateToken, 2)} $${ticker}` : syncProblem ? 'Not read' : 'Reading…');
  setText('mv-public', !session || publicToken === null ? '—' : `${tokens(publicToken, 2)} $${ticker}`);

  // Burning from the public account is offered only when something is there.
  const publicOption = moveSource.querySelector<HTMLOptionElement>('option[value="public"]');
  const publicHeld = publicToken !== null && publicToken > 0n;
  if (publicOption) publicOption.disabled = !publicHeld;
  if (burnSource() === 'public' && !publicHeld) moveSource.value = 'private';
  const source = burnSource();
  setText(
    'mv-source-hint',
    source === 'private'
      ? 'One transaction: the tokens leave your private balance and are destroyed by the next instruction. They are never left sitting in public.'
      : 'Burns straight from your ordinary token account. Nothing private is touched.',
  );

  const available = moveAvailable();
  const from = burning && source === 'public' ? 'Public' : 'Private';
  setText(
    'mv-hint',
    !session
      ? ''
      : available === null
        ? from === 'Public'
          ? 'Public available: not read.'
          : syncProblem
            ? 'Private available: not read. See Your private activity below.'
            : 'Private available: reading…'
        : `${from} available: ${tokens(available, 2)}`,
  );
  renderRecipientHint();
  renderMoveEffect();
  const rows = burning ? burnVisibility(source) : SEND_VISIBILITY;
  byId('mv-visibility').innerHTML = `<div class="visibility-title">What an observer sees</div>${rows
    .map(([label, value, hidden]) => `<dt>${escapeHtml(label)}</dt><dd class="${hidden ? 'is-hidden' : 'is-public'}">${escapeHtml(value)}</dd>`)
    .join('')}`;
  moveButton.textContent = burning ? `Burn $${ticker} for good` : 'Send privately';
  moveButton.classList.toggle('is-danger', burning);
  moveButton.disabled = busy;
}

function moveStage(message: string): void {
  moveOutput.innerHTML = `<div class="status"><b>WORKING</b><br>${escapeHtml(message)}</div>`;
}

function moveProblem(title: string, body: string): void {
  moveOutput.innerHTML = `<div class="status error"><b>${escapeHtml(title)}</b><br>${escapeHtml(body)}</div>`;
}

document.querySelectorAll<HTMLButtonElement>('[data-mv]').forEach((tab) => {
  tab.addEventListener('click', () => {
    if (busy || tab.dataset.mv === moveMode) return;
    moveMode = tab.dataset.mv as MoveMode;
    moveAmount.value = '';
    moveConfirm.value = '';
    moveOutput.innerHTML = '';
    renderMove();
  });
});

moveSource.addEventListener('change', () => {
  moveAmount.value = '';
  renderMove();
});

moveAmount.addEventListener('input', renderMoveEffect);

moveRecipient.addEventListener('input', () => {
  window.clearTimeout(recipientTimer);
  // Say at once what the text alone shows; ask the chain after a pause in the typing.
  const quick = classifyRecipient(moveRecipient.value, session?.address ?? '');
  recipientKind = quick === 'candidate' ? 'checking' : quick;
  renderRecipientHint();
  if (quick === 'candidate') recipientTimer = window.setTimeout(lookAtRecipient, 350);
});

document.querySelectorAll<HTMLButtonElement>('[data-mv-share]').forEach((button) => {
  button.addEventListener('click', () => {
    const available = moveAvailable();
    if (available === null) return;
    const units = (available * BigInt(button.dataset.mvShare ?? '100')) / 100n;
    moveAmount.value = tokens(units, TOKEN_DECIMALS).replaceAll(',', '');
    renderMoveEffect();
  });
});

moveForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy) return;
  if (!status?.rpcConfigured) {
    moveProblem('NOT AVAILABLE', 'This deployment has no RPC configured, so nothing on chain can be reached.');
    return;
  }
  const burning = moveMode === 'burn';
  const wallet = await requireWallet(moveGate, burning ? 'to burn' : 'to send');
  if (!wallet) return;
  let amount: bigint;
  try {
    amount = moveAmountUnits();
  } catch (error) {
    moveProblem('CHECK THE AMOUNT', friendlyError(error));
    return;
  }
  if (amount <= 0n) {
    moveProblem('CHECK THE AMOUNT', 'Enter an amount greater than zero.');
    moveAmount.focus();
    return;
  }
  const source = burning ? burnSource() : 'private';
  if (source === 'private' && !synced) {
    moveProblem(
      'BALANCE NOT READ',
      syncProblem
        ? 'Your private balance could not be read, so nothing can be moved out of it yet. Nothing is lost. Use Try again under Your private activity.'
        : 'Your private balance is still being read. Try again in a moment.',
    );
    return;
  }
  const available = source === 'public' ? (publicToken ?? 0n) : privateToken;
  if (amount > available) {
    moveProblem('NOT ENOUGH', `You have ${tokens(available, TOKEN_DECIMALS)} $${symbol()} in your ${source === 'public' ? 'public token account' : 'private balance'}.`);
    return;
  }
  if (burning) {
    if (!burnConfirmed(moveConfirm.value)) {
      moveProblem('CONFIRM THE BURN', `Type ${BURN_WORD} in the box to confirm. A burn cannot be undone.`);
      moveConfirm.focus();
      return;
    }
  } else {
    const first = classifyRecipient(moveRecipient.value, wallet.address);
    if (first !== 'candidate') {
      recipientKind = first;
      renderRecipientHint();
      moveProblem('CHECK THE ADDRESS', first === 'empty' ? 'Enter the recipient’s Solana address.' : RECIPIENT_HINTS[first]);
      moveRecipient.focus();
      return;
    }
  }

  busy = true;
  refreshButton();
  moveForm.classList.add('is-loading');
  const ticker = escapeHtml(symbol());
  const exact = `${tokens(amount, TOKEN_DECIMALS)} $${ticker}`;
  const link = (signature: string) =>
    `<a class="tx-link" href="${escapeHtml(explorerTx(signature, network()))}" target="_blank" rel="noopener noreferrer">${escapeHtml(short(signature, 10, 10))}</a>`;
  try {
    if (burning) {
      if (source === 'private') {
        const landed = await burnFromPrivate(wallet, mintAddress(), amount, moveStage);
        noteSettled(landed);
        moveOutput.innerHTML = `<div class="status ok"><b>BURNED · SETTLED</b><br>${exact} destroyed for good.<br>${link(landed.signature)}${landed.synced ? '' : `<br>${escapeHtml(STALE_BALANCE_NOTE)}`}</div>`;
      } else {
        // Nothing private moved, so what this page knows of the private balance is untouched.
        const landed = await burnFromPublic(wallet, mintAddress(), amount, moveStage);
        moveOutput.innerHTML = `<div class="status ok"><b>BURNED · SETTLED</b><br>${exact} destroyed for good.<br>${link(landed.signature)}</div>`;
      }
      toast('Burn settled');
      moveConfirm.value = '';
      void api.refreshToken(mintParam).catch(() => null);
    } else {
      const recipient = address(moveRecipient.value.trim());
      moveStage('Checking that the recipient can receive privately…');
      let registered: boolean | null;
      try {
        registered = await canReceivePrivately(recipient);
      } catch {
        // Not being able to ask is not a no: the transfer itself is refused if the address is not registered.
        registered = null;
      }
      if (registered === false) {
        recipientKind = 'unregistered';
        renderRecipientHint();
        moveProblem('RECIPIENT NOT REGISTERED', RECIPIENT_HINTS.unregistered);
        return;
      }
      const landed = await sendPrivate(wallet, mintAddress(), amount, recipient, moveStage);
      noteSettled(landed);
      moveOutput.innerHTML = `<div class="status ok"><b>SENT PRIVATELY · SETTLED</b><br>${exact} to ${escapeHtml(short(recipient, 6, 6))}.<br>${link(landed.signature)}<br>On chain this shows the two wallets and nothing more. It appears in their private balance the next time their wallet reads it.${landed.synced ? '' : `<br>${escapeHtml(STALE_BALANCE_NOTE)}`}</div>`;
      toast('Private transfer sent');
    }
    moveAmount.value = '';
  } catch (error) {
    moveProblem(burning ? 'NOT BURNED' : 'NOT SENT', friendlyError(error));
  } finally {
    busy = false;
    moveForm.classList.remove('is-loading');
    refreshButton();
    await refreshBalances();
    renderActivity();
    if (burning) void refreshMarket();
  }
});

/* ---------------- Loading ---------------- */

function renderSlippage(): void {
  const max = status?.slippage.maxBps ?? 1000;
  const fallback = status?.slippage.defaultBps ?? 100;
  const choices = [...new Set([50, 100, 300, 500, 1000, fallback])].filter((bps) => bps <= max).sort((a, b) => a - b);
  slippageSelect.innerHTML = choices.map((bps) => `<option value="${bps}" ${bps === fallback ? 'selected' : ''}>${bps / 100}%</option>`).join('');
}

async function refreshMarket(): Promise<void> {
  try {
    detail = await api.token(mintParam);
  } catch {
    // Keep showing the last listing.
  }
  if (status?.rpcConfigured) {
    try {
      env = await loadMarketEnv(mintParam);
      envError = '';
    } catch (error) {
      if (!env) envError = friendlyError(error);
    }
    try {
      mintState = (await readMintState(mintParam)) ?? mintState;
    } catch {
      // Keep the last reading; the listing's supply stands in until there is one.
    }
  }
  renderHeader();
  renderStats();
  renderFacts();
  renderModules();
  renderMoveEffect();
  refreshButton();
}

function notFound(message: string): void {
  byId('token-loading').innerHTML = `<h2>CURVE NOT FOUND</h2><p>${escapeHtml(message)}</p><a class="btn" href="/">Back to market</a>`;
}

async function load(): Promise<void> {
  status = await mountRuntime();
  if (!isAddress(mintParam)) {
    notFound('That link does not carry a valid token address.');
    return;
  }
  try {
    detail = await api.token(mintParam);
  } catch {
    // A token launched seconds ago may not be listed yet: ask the server to look at the chain.
    const listed = await api.refreshToken(mintParam).catch(() => null);
    if (listed) detail = await api.token(mintParam).catch(() => null);
  }
  if (!detail) {
    notFound('No token with that address was launched on this platform.');
    return;
  }
  byId('token-loading').hidden = true;
  byId('token-body').hidden = false;
  const banner = setupMessage(status);
  if (banner) {
    const node = byId('token-banner');
    node.innerHTML = banner;
    node.hidden = false;
  }
  renderSlippage();
  renderHeader();
  renderStats();
  renderFacts();
  renderForm();
  renderActivity();
  await refreshBalances();

  await refreshMarket();
  if (envError) {
    const node = byId('token-banner');
    node.innerHTML = `<strong>The pool could not be read.</strong> ${escapeHtml(envError)}`;
    node.hidden = false;
  }
  try {
    session = await getSession();
  } catch {
    session = null;
  }
  if (session) await afterUnlock();
  else renderForm();

  window.setInterval(() => {
    if (!document.hidden && !busy) void refreshMarket();
  }, 20_000);
}

// The wallet can be unlocked, locked or switched from the header. Unlocking only gives this page a wallet it did
// not have. Locking or switching changes whose balances, activity and rewards are on it, so the page starts over.
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
    for (const gate of [tradeGate, moveGate, byId('graduate-gate')]) gate.innerHTML = '';
    await afterUnlock();
  },
});

void load();
