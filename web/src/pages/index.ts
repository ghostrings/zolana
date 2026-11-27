import '../market.css';
import type { NativeCard } from '../native-v33/catalog.mjs';
import { catalogWindow } from '../native-v33/catalog-data.mjs';
import { MARKET_PAGE_SIZE } from '../../../shared/src/api.js';
type CardToken = TokenSummary & {native?: NativeCard['native']};
type CatalogPage = Omit<TokenPageResponse,'tokens'> & {tokens: readonly CardToken[]};

import { type StatusResponse, type TokenPageResponse, type TokenSort, type TokenSummary } from '../../../shared/src/api.js';
import { INITIAL_SUPPLY_UNITS } from '../../../shared/src/constants.js';
import { percentOf } from '../../../shared/src/units.js';
import { api } from '../api.js';
import { changeChip, pairChip } from '../chips.js';
import { compactSol, decimalText, feeLabel, shortAmount, smallPrice } from '../format.js';
import { icon } from '../icons.js';
import { moduleTag } from '../module-tag.js';
import { compact } from '../pairs.js';
import { type MarketView, marketViewSearch, pageRange, pageWindow, readMarketView } from '../paging.js';
import { mountRuntime, setupMessage } from '../shell.js';
import { sparkSvg } from '../spark.js';
import { byId, escapeHtml, ghostState, initShell, setText, tokenArt } from '../ui.js';

initShell('market');

/** How the tokens on a page are laid out: detailed cards, a tight grid of tiles, or a table. */
type Layout = 'cards' | 'grid' | 'table';
const LAYOUTS: readonly Layout[] = ['cards', 'grid', 'table'];
const LAYOUT_KEY = 'pcf.market.view';
const LAYOUT_ICONS = { cards: 'cards', grid: 'grid', table: 'rows' } as const;

const grid = byId('token-grid');
const search = byId<HTMLInputElement>('search');
const sortTabs = byId('sort-tabs');
const pairFilter = byId('pair-filter');
const strips = byId('strips');
const viewToggle = byId('view-toggle');
const count = byId('market-count');
const updated = byId('market-updated');
const pager = byId('pager');
const ticker = byId('ticker');
const tickerTrack = byId('ticker-track');

/** Which page, order and search the address bar asks for. */
let view: MarketView = readMarketView(location.search);
let layout: Layout = readLayout();
/** The page on screen. Null until the first one has loaded. */
let shown: CatalogPage | null = null;
/** What the list was last built from. While it is the same, a refresh changes figures in place and rebuilds nothing. */
let built = '';
/** The tokens as they were last drawn, by mint: what a refresh is compared with. */
const drawn = new Map<string, CardToken>();
/** What each figure on screen was last set to, so one that did not change is left alone. */
const written = new WeakMap<Element, string>();
/** Counts requests, so an answer that arrives after a newer question is dropped. */
let asked = 0;
/** True while a page the visitor asked for is on its way. The background refresh waits for it. */
let turning = false;
let searchTimer: number | undefined;
/** True when tokens can be priced in more than one pair token here, which makes the totals approximate. */
let multiPair = false;
/** When the list on screen was last read from the server. */
let readAt = 0;
let tickerKey = '';
/** True once the ticker has been given a list, whether or not there was enough on it to show. */
let tickerFed = false;

function readLayout(): Layout {
  try {
    const kept = localStorage.getItem(LAYOUT_KEY);
    if ((LAYOUTS as readonly string[]).includes(kept ?? '')) return kept as Layout;
  } catch {
    // A browser that keeps nothing still gets a layout.
  }
  // A phone shows more tokens as rows than as cards.
  return matchMedia('(max-width: 600px)').matches ? 'table' : 'cards';
}

/* ---------------- What a token says about itself ---------------- */

const symbolOf = (token: CardToken): string => `$${escapeHtml(token.symbol || '???')}`;
const nameOf = (token: CardToken): string => escapeHtml(token.name || 'Unnamed token');
const hrefOf = (token: CardToken): string => token.native ? `/native-token?market=${encodeURIComponent(token.native.market)}` : `/token?mint=${encodeURIComponent(token.mint)}`;
const ringBadge = (token: CardToken): string => token.native?.registered ? '<span class="tk-ring-badge" title="Verified Privacy Rings asset: encrypted holdings supported. Market execution is public. Native markets are unaudited." aria-label="Rings asset; trades are public"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11z"/><path d="m9 12 2 2 4-4"/></svg> Rings</span>' : token.native ? '<span class="tk-tag" title="Native market; Rings registration not verified">Native</span>' : '';
const change = (token: CardToken): string => token.native ? '<span class="chg flat" data-f="chg" title="24h return unavailable for this bounded history">—</span>' : changeChip(token.change24h);

/** "42s", "7m", "3h", "12d": how long ago a token was launched, short enough for a card. */
function ageText(time: number): string {
  const seconds = Math.floor(Math.max(0, Date.now() - Number(time || 0)) / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

/** A price. A very small one is written the way trading screens write it: 0.0, the count of zeros, the digits. */
function priceHtml(price: string): string {
  if (price.startsWith('Below ')) return escapeHtml(price);
  const small = smallPrice(price);
  return small ? `0.0<sub>${small.zeros}</sub>${escapeHtml(small.digits)}` : escapeHtml(decimalText(price));
}

function capHtml(token: CardToken): string {
  if (token.native && !token.native.capKnown) return "—";
  return `${escapeHtml(decimalText(token.marketCap))} <i>${escapeHtml(token.pair.symbol)}</i>`;
}

/** A card has room for five digits of market cap; a tile, a phone's row and the ticker for four. */
const CARD_CAP_FROM = 100_000;
const TIGHT_CAP_FROM = 10_000;

/** Market cap cut short from `from` up: 79,724 is 79.7K. Smaller ones are written out. */
function capShortHtml(token: CardToken, from: number = TIGHT_CAP_FROM): string {
  if (token.native && !token.native.capKnown) return "—";
  const value = Number(token.marketCap);
  const short = (Number.isFinite(value) && value >= from ? shortAmount(value) : null) ?? decimalText(token.marketCap);
  return `${escapeHtml(short)} <i>${escapeHtml(token.pair.symbol)}</i>`;
}

/** A tile's market cap is the number alone: the pair stands in the line above it. */
function capTileHtml(token: CardToken): string {
  if (token.native && !token.native.capKnown) return "—";
  const value = Number(token.marketCap);
  return escapeHtml((Number.isFinite(value) && value >= TIGHT_CAP_FROM ? shortAmount(value) : null) ?? decimalText(token.marketCap));
}

/** What a token has traded since launch, on its curve and after it. */
function volumeHtml(token: CardToken): string {
  if (token.native && token.native.recentVolume === null) return '—';
  const text = compact(token.native ? token.native.recentVolume! : token.volume ?? '0', token.pair);
  const cut = text.lastIndexOf(' ');
  const partial = token.native?.incomplete ? '≥ ' : '';
  return cut > 0 ? partial + `${escapeHtml(text.slice(0, cut))} <i>${escapeHtml(text.slice(cut + 1))}</i>` : partial + escapeHtml(text);
}

const percentDone = (token: CardToken): number => (token.stage === 'curve' ? Math.round(Math.max(0, Math.min(1, token.progress)) * 100) : 100);

function stageText(token: CardToken): string {
  if (token.stage === 'graduated') return 'Graduated';
  if (token.stage === 'migrating') return 'Migrating';
  return `${percentDone(token)}%`;
}

function track(token: CardToken): string {
  const percent = percentDone(token);
  return `<span class="track${token.stage === 'curve' ? '' : ' is-done'}" role="progressbar" aria-label="Progress to graduation" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><i data-f="bar" style="width:${percent}%"></i></span>`;
}

/** The fee tier, and after it whatever else is permanent about the token: fee modules, supply burned. */
function tags(token: CardToken): string {
  const list = [`${feeLabel(token.feeBps)} fee`];
  const modules = moduleTag(token);
  if (modules) list.push(modules.charAt(0) + modules.slice(1).toLowerCase());
  const burned = BigInt(token.burned || '0');
  if (burned > 0n && !token.native) list.push(`${percentOf(burned, INITIAL_SUPPLY_UNITS)}% burned`);
  return list.map((text) => `<span class="tk-tag">${escapeHtml(text)}</span>`).join('');
}

/**
 * What the styles need to know about a token to keep it readable in a narrow
 * frame: a ticker of nine or ten letters is set a little smaller, and a pair
 * symbol longer than four letters is written once on a card, not twice.
 */
function marks(token: CardToken): string {
  return `${[...(token.symbol || '')].length >= 9 ? ' data-long' : ''}${[...(token.pair.symbol || '')].length > 4 ? ' data-unit-long' : ''}`;
}

const chartMarkup = (token: CardToken): string => token.native && (token.spark?.length ?? 0)<2 ? '<span class="tk-no-history">Awaiting trade history</span>' : sparkSvg(token.spark ?? []);
const chart = (token: CardToken): string => `<div class="tk-chart" data-f="spark" title="${token.native ? 'Recent finalized executions (up to 10 signatures)' : 'Last 24 hours'}">${chartMarkup(token)}</div>`;
const age = (token: CardToken): string => token.native && !token.createdAt ? '<span class="tk-age" title="Launch time unavailable">—</span>' : `<time class="tk-age" data-age="${token.createdAt}" title="Launched ${escapeHtml(new Date(token.createdAt).toLocaleString())}">${ageText(token.createdAt)}</time>`;

/* ---------------- The three layouts ---------------- */

function card(token: CardToken, index: number): string {
  return `<article class="tk" data-mint="${escapeHtml(token.mint)}"${marks(token)} style="--i:${index}"><a class="tk-link" href="${hrefOf(token)}">
    <div class="tk-head"><div class="token-avatar">${tokenArt(token)}</div><div class="tk-id"><div class="tk-top"><b class="tk-sym">${symbolOf(token)}</b>${change(token)}</div><div class="tk-sub">${pairChip(token.pair)}${ringBadge(token)}<span class="tk-name">${nameOf(token)}</span>${age(token)}</div></div></div>
    ${chart(token)}
    <dl class="tk-stats"><div><dt>${token.native ? 'Est. cap' : 'Market cap'}</dt><dd data-f="capcard">${capShortHtml(token, CARD_CAP_FROM)}</dd></div><div><dt>${token.native ? 'Recent volume' : 'Total volume'}</dt><dd data-f="vol">${volumeHtml(token)}</dd></div><div><dt>Price</dt><dd data-f="price">${priceHtml(token.price)}</dd></div></dl>
    <div class="tk-foot">${track(token)}<b class="tk-pct" data-f="pct">${stageText(token)}</b><span class="tk-tags">${tags(token)}</span></div>
  </a></article>`;
}

function tile(token: CardToken, index: number): string {
  return `<article class="tk tile" data-mint="${escapeHtml(token.mint)}"${marks(token)} style="--i:${index}"><a class="tk-link" href="${hrefOf(token)}">
    <div class="tile-top"><div class="token-avatar">${tokenArt(token)}</div>${ringBadge(token)}${change(token)}</div>
    <div class="tk-id"><b class="tk-sym">${symbolOf(token)}</b><span class="tk-name"><span class="tile-name">${nameOf(token)}</span><span class="tile-pair">${escapeHtml(token.pair.symbol)}</span></span></div>
    ${chart(token)}
    <div class="tile-cap"><span data-f="captile">${capTileHtml(token)}</span><b class="tk-pct" data-f="pct">${stageText(token)}</b></div>
    ${track(token)}
  </a></article>`;
}

/**
 * A row of the table. On a phone the same row is laid out as a strip: the
 * token, its chart, its market cap over its change, and how far along its
 * curve it is drawn on the line under it. `--len` is the length of the ticker,
 * which that strip keeps room for, and `--p` is that line's length.
 */
function row(token: CardToken, index: number, rank: number): string {
  return `<tr class="tk-row" data-mint="${escapeHtml(token.mint)}" data-href="${hrefOf(token)}"${marks(token)}${token.stage === 'curve' ? '' : ' data-done'} style="--i:${index};--len:${[...(token.symbol || '???')].length};--p:${percentDone(token)}%">
    <td class="c-rank">${rank}</td>
    <td class="c-token"><a class="tk-cell" href="${hrefOf(token)}"><div class="token-avatar">${tokenArt(token)}</div><div class="tk-id"><div class="tk-line"><b class="tk-sym">${symbolOf(token)}</b>${pairChip(token.pair)}${ringBadge(token)}</div><span class="tk-name"><b class="row-stage" data-f="pct">${stageText(token)}</b>${nameOf(token)}</span></div></a></td>
    <td class="num c-price" data-f="price">${priceHtml(token.price)}</td>
    <td class="num c-chg">${change(token)}</td>
    <td class="num c-cap"><span class="cap-full" data-f="cap">${capHtml(token)}</span><span class="cap-short" data-f="capshort">${capShortHtml(token)}</span></td>
    <td class="num c-vol" data-f="vol" title="${token.native ? 'Recent finalized volume only' : 'Lifetime volume'}">${volumeHtml(token)}${token.native ? ' <small>recent</small>' : ''}</td>
    <td class="c-grad"><div class="tk-grad">${track(token)}<b class="tk-pct" data-f="pct">${stageText(token)}</b></div></td>
    <td class="c-fee">${escapeHtml(feeLabel(token.feeBps))}</td>
    <td class="num c-age">${age(token)}</td>
    <td class="c-spark">${chart(token)}</td>
  </tr>`;
}

/** A column heading that also sets the order. */
function heading(label: string, sort: TokenSort): string {
  const on = view.sort === sort;
  return `<button type="button" data-sort="${sort}" aria-pressed="${on}" title="Order by ${label.toLowerCase()}">${label}</button>`;
}

function table(tokens: readonly CardToken[], firstRank: number): string {
  return `<div class="tk-table-wrap"><table class="tk-table"><thead><tr><th class="c-rank">#</th><th class="c-token">Token</th><th class="num c-price">Price</th><th class="num c-chg">24h</th><th class="num c-cap">${heading('Market cap', 'cap')}</th><th class="num c-vol">${heading('Volume', 'volume')}</th><th class="c-grad">${heading('Graduation', 'graduation')}</th><th class="c-fee">Fee</th><th class="num c-age">${heading('Age', 'new')}</th><th class="num c-spark">Chart</th></tr></thead><tbody>${tokens
    .map((token, index) => row(token, index, firstRank + index))
    .join('')}</tbody></table></div>`;
}

/** Everything about a token that is not a moving figure. When any of it changes the list is built again. */
function fixedPart(token: CardToken): string {
  return JSON.stringify([token.native?.registered,token.native?.assetId,token.native?.capKnown,token.native?.recentVolume,token.native?.recentCount,token.native?.incomplete,token.createdAt,token.mint, token.name, token.symbol, token.image, token.stage, token.feeBps, token.pair.symbol, moduleTag(token), BigInt(token.burned || '0') > 0n ? token.burned : '']);
}

/* ---------------- Drawing ---------------- */

/**
 * Sets one figure of a token on screen, if it changed. A row of the table
 * holds some figures twice, once for a wide screen and once for a narrow one,
 * so every place the figure stands is set. `moved` makes it catch the eye for
 * a moment.
 */
function write(holder: Element, field: string, html: string, moved?: 'up' | 'down'): void {
  for (const target of holder.querySelectorAll<HTMLElement>(`[data-f="${field}"]`)) {
    if (written.get(target) === html) continue;
    const first = !written.has(target);
    written.set(target, html);
    if (first) continue;
    target.innerHTML = html;
    if (!moved) continue;
    target.classList.remove('flash-up', 'flash-down');
    // Reading a layout property lets the same animation play again on a figure that is still flashing.
    void target.offsetWidth;
    target.classList.add(moved === 'up' ? 'flash-up' : 'flash-down');
  }
}

function moved(before: string | undefined, after: string): 'up' | 'down' | undefined {
  const was = Number(before);
  const is = Number(after);
  if (!Number.isFinite(was) || !Number.isFinite(is) || was === is) return undefined;
  return is > was ? 'up' : 'down';
}

/** Brings the figures of the tokens already on screen up to date, without rebuilding their cards. */
function refreshFigures(tokens: readonly CardToken[]): void {
  for (const token of tokens) {
    const holder = grid.querySelector(`[data-mint="${CSS.escape(token.mint)}"]`);
    if (!holder) continue;
    const before = drawn.get(token.mint);
    const capMoved = moved(before?.marketCap, token.marketCap);
    write(holder, 'cap', capHtml(token), capMoved);
    write(holder, 'capcard', capShortHtml(token, CARD_CAP_FROM), capMoved);
    write(holder, 'capshort', capShortHtml(token), capMoved);
    write(holder, 'captile', capTileHtml(token), capMoved);
    write(holder, 'vol', volumeHtml(token));
    write(holder, 'price', priceHtml(token.price), moved(before?.price, token.price));
    write(holder, 'pct', stageText(token));
    write(holder, 'spark', chartMarkup(token));
    const chip = holder.querySelector('[data-f="chg"]');
    const nextChip = change(token);
    if (chip && written.get(chip) !== nextChip) {
      const known = written.has(chip);
      if (known) {
        chip.outerHTML = nextChip;
        const fresh = holder.querySelector('[data-f="chg"]');
        if (fresh) written.set(fresh, nextChip);
      } else {
        written.set(chip, nextChip);
      }
    }
    // The line under a phone's row is as long as the curve is full.
    if (holder instanceof HTMLTableRowElement) holder.style.setProperty('--p', `${percentDone(token)}%`);
    for (const bar of holder.querySelectorAll<HTMLElement>('[data-f="bar"]')) {
      bar.style.width = `${percentDone(token)}%`;
      bar.parentElement?.setAttribute('aria-valuenow', String(percentDone(token)));
    }
    drawn.set(token.mint, token);
  }
}

/** Notes what every figure shows right after a build, so the first refresh has something to compare with. */
function remember(tokens: readonly CardToken[]): void {
  drawn.clear();
  for (const token of tokens) drawn.set(token.mint, token);
  refreshFigures(tokens);
}

function renderPager(): void {
  if (!shown || shown.total === 0) {
    pager.hidden = true;
    pager.innerHTML = '';
    return;
  }
  const { page, pages, size, total } = shown;
  if (pages <= 1) {
    pager.innerHTML = `<div class="pager-note">${pageRange(page, size, total)}</div>`;
    pager.hidden = false;
    return;
  }
  const numbers = pageWindow(page, pages)
    .map((item) =>
      item === 'gap'
        ? '<span class="pager-gap" aria-hidden="true">…</span>'
        : `<button type="button" class="pager-page" data-page="${item}" aria-label="Page ${item}" ${item === page ? 'aria-current="page"' : ''}>${item}</button>`,
    )
    .join('');
  pager.innerHTML = `<button type="button" class="pager-step" data-page="${page - 1}" aria-label="Previous page" ${page <= 1 ? 'disabled' : ''}>Prev</button><div class="pager-pages">${numbers}</div><button type="button" class="pager-step" data-page="${page + 1}" aria-label="Next page" ${page >= pages ? 'disabled' : ''}>Next</button><div class="pager-note">Page ${page} of ${pages} · ${pageRange(page, size, total)}</div>`;
  pager.hidden = false;
}

function emptyState(): string {
  if (view.query) {
    return ghostState(
      'NOTHING BY THAT NAME',
      `No listed token matches “${escapeHtml(view.query)}”${view.pair ? ` among those priced in ${escapeHtml(view.pair)}` : ''}. Search by ticker, by name, or by the start of a mint address.<br><br><button class="btn flat" type="button" data-clear-search>Clear the search</button>`,
    );
  }
  if (view.pair) {
    return ghostState(
      `NOTHING PRICED IN ${escapeHtml(view.pair)} YET`,
      'No token has been launched against that pair token so far.<br><br><button class="btn flat" type="button" data-clear-pair>Show every pair</button> <a class="btn flat" href="/create">Launch one</a>',
    );
  }
  return ghostState('NO TOKENS YET', 'Nothing has been launched here so far.<br><br><a class="btn flat" href="/create">Launch the first one</a>');
}

/** Draws the page on screen. `settled` skips the entrance, for a refresh of a page already being looked at. */
function render(settled: boolean): void {
  if (!shown) return;
  const { tokens, total, page, size } = shown;
  count.textContent = view.query ? `${total.toLocaleString()} match${total === 1 ? '' : 'es'}` : `${total.toLocaleString()} token${total === 1 ? '' : 's'}${view.pair ? ` priced in ${view.pair}` : ''}`;
  grid.setAttribute('aria-busy', 'false');
  const structure = JSON.stringify([layout, view.query, view.pair, view.sort, tokens.map(fixedPart)]);
  if (settled && structure === built) {
    refreshFigures(tokens);
  } else {
    built = structure;
    grid.dataset.view = layout;
    grid.classList.toggle('is-settled', settled);
    grid.innerHTML = tokens.length === 0 ? emptyState() : layout === 'table' ? table(tokens, (page - 1) * size + 1) : tokens.map(layout === 'grid' ? tile : card).join('');
    remember(tokens);
  }
  renderPager();
}

/**
 * The rows of buttons that scroll sideways when they are wider than their
 * place: each group by itself on a wide screen, the two as one row on a
 * narrow one.
 */
const SCROLLERS: readonly HTMLElement[] = [sortTabs, pairFilter, strips];

/**
 * `data-more` says on which side of a scrolling row there is more of it, and
 * the styles fade that edge, so a row that is cut off reads as one that goes on.
 */
function markStrips(): void {
  for (const row of SCROLLERS) {
    const left = row.scrollLeft > 2;
    const right = row.scrollWidth - row.clientWidth - row.scrollLeft > 2;
    row.dataset.more = left && right ? 'both' : left ? 'left' : right ? 'right' : 'none';
  }
}

/**
 * Brings the choice that may be out of sight into it: the pair, when one is
 * picked, and otherwise the order. It moves the row and never the page, and
 * it is only done when the view was set from the address, never under a
 * finger that is scrolling the row.
 */
function revealChoice(): void {
  const lit = (view.pair ? pairFilter : sortTabs).querySelector<HTMLElement>('[aria-pressed="true"]');
  if (lit) {
    for (const row of SCROLLERS) {
      if (!row.contains(lit) || row.scrollWidth <= row.clientWidth) continue;
      const frame = row.getBoundingClientRect();
      const box = lit.getBoundingClientRect();
      // Out of sight, or under the fade at either end: put it in the middle of the row.
      if (box.left < frame.left + 48 || box.right > frame.right - 48) row.scrollLeft += box.left + box.width / 2 - (frame.left + frame.width / 2);
    }
  }
  markStrips();
}

/** Lights the controls that match the view: the order, the pair, the layout. */
function syncControls(): void {
  sortTabs.querySelectorAll<HTMLButtonElement>('[data-sort]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.sort === view.sort));
  });
  pairFilter.querySelectorAll<HTMLButtonElement>('[data-pair]').forEach((button) => {
    button.setAttribute('aria-pressed', String((button.dataset.pair ?? '') === view.pair));
  });
  viewToggle.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.view === layout));
  });
  markStrips();
}

function setLayout(next: Layout): void {
  if (next === layout) return;
  layout = next;
  try {
    localStorage.setItem(LAYOUT_KEY, next);
  } catch {
    // The choice then lasts for this visit only.
  }
  syncControls();
  built = '';
  render(false);
}

/* ---------------- Loading ---------------- */

function address(): string {
  return `${location.pathname}${marketViewSearch(view)}`;
}

function sinceRead(): string {
  if (!readAt) return '';
  const seconds = Math.floor((Date.now() - readAt) / 1000);
  return seconds < 8 ? 'Updated just now' : seconds < 90 ? `Updated ${seconds}s ago` : `Updated ${Math.floor(seconds / 60)}m ago`;
}

async function loadPage(options: { quiet?: boolean; scroll?: boolean } = {}): Promise<void> {
  const mine = ++asked;
  const quiet = options.quiet === true;
  if (!quiet) {
    turning = true;
    grid.setAttribute('aria-busy', 'true');
    grid.classList.add('is-turning');
  }
  try {
    const requestView = view;
    const [legacyFirst, catalog] = await Promise.all([api.tokenPage({...requestView,page:1}), import('../native-v33/catalog.mjs').catch(()=>null)]);
    const snapshot = catalog ? await catalog.nativeCatalog() : null;
    if (mine !== asked) return;
    const matches = catalog ? catalog.matchingNative(snapshot,requestView) : [];
    const window = catalogWindow(matches.length,legacyFirst.total,requestView.page,MARKET_PAGE_SIZE);
    const legacyRows: TokenSummary[] = [];
    if (window.legacyTake) {
      const first = Math.floor(window.legacyStart/MARKET_PAGE_SIZE)+1;
      const skip = window.legacyStart%MARKET_PAGE_SIZE;
      const pages = [first]; if (skip+window.legacyTake>MARKET_PAGE_SIZE) pages.push(first+1);
      for (const p of pages) legacyRows.push(...(p===1?legacyFirst:await api.tokenPage({...requestView,page:p})).tokens);
      legacyRows.splice(0,skip);legacyRows.splice(window.legacyTake);
    }
    const nativeRows = snapshot && catalog ? await catalog.catalogTokens(matches.slice(window.nativeStart,window.nativeEnd),snapshot) : [];
    const data: CatalogPage = {tokens:[...nativeRows,...legacyRows],total:window.total,pages:window.pages,page:window.page,size:window.size};
    if (mine === asked) byId('market-native-note').textContent = snapshot ? `${matches.length} native match${matches.length===1?'':'es'} · native first` : 'Native index unavailable · Meteora shown';
    if (mine !== asked) return;
    shown = data;
    readAt = Date.now();
    updated.textContent = sinceRead();
    // A page past the end comes back as the last page: the address follows what is shown.
    if (data.page !== view.page) {
      view = { ...view, page: data.page };
      history.replaceState(null, '', address());
    }
    render(quiet);
    if (options.scroll) byId('market').scrollIntoView({ behavior: 'smooth', block: 'start' });
    // The first page of the default order is also what the ticker runs.
    if (view.page === 1 && !view.query && !view.pair && view.sort === 'hot') renderTicker(legacyFirst.tokens);
  } catch {
    if (mine !== asked) return;
    // A refresh that fails leaves the page that is already on screen alone.
    if (!quiet || !shown) {
      shown = null;
      built = '';
      count.textContent = '— tokens';
      updated.textContent = '';
      pager.hidden = true;
      grid.setAttribute('aria-busy', 'false');
      grid.dataset.view = 'cards';
      grid.innerHTML = ghostState('THE LISTING DID NOT ANSWER', 'The server could not be reached, so there is nothing to show yet.<br><br><button class="btn flat" type="button" data-retry>Try again</button>');
    }
  } finally {
    if (mine === asked) {
      turning = false;
      grid.classList.remove('is-turning');
    }
  }
}

/** Moves to another view. `push` adds a step the Back button returns to. */
function go(next: MarketView, options: { push?: boolean; scroll?: boolean } = {}): void {
  view = next;
  if (options.push) history.pushState(null, '', address());
  else history.replaceState(null, '', address());
  syncControls();
  void loadPage({ scroll: options.scroll === true });
}

/* ---------------- The ticker ---------------- */

/** The most traded tokens, running along the top. With fewer than four there is nothing to run, and it stays away. */
function renderTicker(tokens: readonly CardToken[]): void {
  tickerFed = true;
  const moving = tokens.slice(0, 16);
  if (moving.length < 4) {
    ticker.hidden = true;
    tickerKey = '';
    return;
  }
  const key = JSON.stringify(moving.map((token) => [token.mint, token.symbol, token.marketCap, token.change24h ?? null, token.image]));
  if (key === tickerKey) return;
  tickerKey = key;
  const items = moving
    .map(
      (token) =>
        `<a href="${hrefOf(token)}" tabindex="-1"><span class="token-avatar">${tokenArt(token)}</span><b>${symbolOf(token)}</b>${change(token)}<span>${capShortHtml(token)}</span></a>`,
    )
    .join('');
  // Twice over, so the strip can run on without a seam.
  tickerTrack.innerHTML = items + items;
  tickerTrack.style.setProperty('--ticker-time', `${Math.max(36, moving.length * 4)}s`);
  ticker.hidden = false;
}

async function loadTicker(): Promise<void> {
  // A phone does not show the strip, so it does not ask for it either.
  if (matchMedia('(max-width: 600px)').matches) return;
  try {
    renderTicker((await api.tokenPage({ page: 1, sort: 'hot', query: '' })).tokens);
  } catch {
    // The ticker is an extra: without it the page is whole.
  }
}

/* ---------------- Controls ---------------- */

viewToggle.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((button) => {
  const kind = button.dataset.view as Layout;
  button.innerHTML = icon(LAYOUT_ICONS[kind]);
  button.addEventListener('click', () => setLayout(kind));
});

sortTabs.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-sort]');
  if (!button) return;
  const sort = button.dataset.sort as TokenSort;
  if (sort !== view.sort) go({ ...view, sort, page: 1 }, { push: true });
});

pairFilter.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-pair]');
  if (!button) return;
  const pair = button.dataset.pair ?? '';
  if (pair !== view.pair) go({ ...view, pair, page: 1 }, { push: true });
});

pager.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-page]');
  if (!button || button.disabled) return;
  const page = Number(button.dataset.page);
  if (!Number.isInteger(page) || page < 1 || page === view.page) return;
  go({ ...view, page }, { push: true, scroll: true });
});

grid.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  if (target.closest('[data-clear-search]')) {
    search.value = '';
    go({ ...view, query: '', page: 1 }, { push: true });
    search.focus();
    return;
  }
  if (target.closest('[data-clear-pair]')) {
    go({ ...view, pair: '', page: 1 }, { push: true });
    return;
  }
  if (target.closest('[data-retry]')) {
    void loadPage();
    return;
  }
  const sorter = target.closest<HTMLButtonElement>('button[data-sort]');
  if (sorter) {
    const sort = sorter.dataset.sort as TokenSort;
    if (sort !== view.sort) go({ ...view, sort, page: 1 }, { push: true });
    return;
  }
  // Anywhere on a table row opens the token. Its own link is left to behave as a link, so it can open in a new tab.
  const line = target.closest<HTMLElement>('tr[data-href]');
  if (line && !target.closest('a, button') && !window.getSelection()?.toString()) location.assign(line.dataset.href ?? '/');
});

for (const row of SCROLLERS) {
  row.addEventListener('scroll', markStrips, { passive: true });
  if ('ResizeObserver' in window) new ResizeObserver(markStrips).observe(row);
}

// A wide field says what can be searched for; a narrow one has room for two words, the narrowest for one.
const narrowScreen = matchMedia('(max-width: 820px)');
const smallScreen = matchMedia('(max-width: 359px)');
const hintSearch = (): void => {
  search.placeholder = smallScreen.matches ? 'Search' : narrowScreen.matches ? 'Search tokens' : 'Search ticker, name or address';
};
// An older Safari has the query and not this way of listening to it; the hint is then set once.
narrowScreen.addEventListener?.('change', hintSearch);
smallScreen.addEventListener?.('change', hintSearch);
hintSearch();

search.addEventListener('input', () => {
  window.clearTimeout(searchTimer);
  // Wait for a pause in the typing, then ask once.
  searchTimer = window.setTimeout(() => {
    const query = search.value.trim().slice(0, 64);
    if (query !== view.query) go({ ...view, query, page: 1 });
  }, 280);
});

// "/" goes to the search, as it does on most sites that have one; Escape leaves it.
document.addEventListener('keydown', (event) => {
  const typing = event.target instanceof HTMLElement && (event.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName));
  if (event.key === '/' && !typing && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    search.focus();
    search.select();
  } else if (event.key === 'Escape' && event.target === search) {
    search.blur();
  }
});

/**
 * The pair filter lists the pair tokens that are in use on this site. With SOL
 * alone in use there is nothing to choose between, so the control stays hidden.
 */
function renderPairFilter(status: StatusResponse | null): void {
  const inUse = (status?.pairs ?? []).filter((pair) => pair.problem === null);
  // A pair named in the address stays selectable even when the site does not know it: the answer is then an empty list.
  const ids = [...new Set([...inUse.map((pair) => pair.id), ...(view.pair ? [view.pair] : [])])];
  const wanted = inUse.length > 1 || view.pair !== '';
  pairFilter.hidden = !wanted;
  pairFilter.innerHTML = wanted
    ? `<button type="button" data-pair="" aria-pressed="false">All pairs</button>${ids
        .map((id) => `<button type="button" data-pair="${escapeHtml(id)}" aria-pressed="false">${escapeHtml(inUse.find((pair) => pair.id === id)?.symbol ?? id)}</button>`)
        .join('')}`
    : '';
  syncControls();
  revealChoice();
}

window.addEventListener('popstate', () => {
  view = readMarketView(location.search);
  search.value = view.query;
  syncControls();
  revealChoice();
  void loadPage();
});

async function loadStats(): Promise<void> {
  try {
    const stats = await api.stats();
    setText('s-tokens', stats.tokens.toLocaleString());
    // In SOL terms. With more than one pair token in use the other pairs count at their sizing rate, hence "about".
    const about = multiPair ? '≈ ' : '';
    byId('s-reserve').innerHTML = `${about}${escapeHtml(compactSol(stats.reserveLamports))} <i>SOL</i>`;
    // Everything traded here since each token's launch.
    byId('s-volume').innerHTML = `${about}${escapeHtml(compactSol(stats.volumeLamports ?? '0'))} <i>SOL</i>`;
    setText('s-graduated', stats.graduated.toLocaleString());
  } catch {
    if (!shown) for (const id of ['s-tokens', 's-reserve', 's-volume', 's-graduated']) setText(id, '—');
  }
}

async function load(): Promise<void> {
  search.value = view.query;
  grid.dataset.view = layout;
  syncControls();
  const status = await mountRuntime();
  const banner = setupMessage(status);
  if (banner) {
    const node = byId('setup-banner');
    node.innerHTML = banner;
    node.hidden = false;
  }
  multiPair = (status?.pairs ?? []).filter((pair) => pair.problem === null).length > 1;
  renderPairFilter(status);
  await Promise.all([loadPage(), loadStats()]);
  // Anywhere but the first page of the default order, the ticker asks for its own list.
  if (!tickerFed) void loadTicker();
}

void load();

window.setInterval(() => {
  if (document.hidden) return;
  if (!turning) void loadPage({ quiet: true });
  void loadStats();
}, 15_000);

window.setInterval(() => {
  if (document.hidden) return;
  void loadTicker();
}, 60_000);

// "3m" keeps counting between refreshes, and so does how long ago the list was read.
window.setInterval(() => {
  if (document.hidden) return;
  updated.textContent = sinceRead();
}, 5_000);

window.setInterval(() => {
  if (document.hidden) return;
  grid.querySelectorAll<HTMLElement>('[data-age]').forEach((node) => {
    node.textContent = ageText(Number(node.dataset.age));
  });
}, 30_000);
