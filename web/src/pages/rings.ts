import '../market.css';
import '../rings.css';

import {
  RING_ASSET_SORTS,
  type RingAddressView,
  type RingAsset,
  type RingAssetPage,
  type RingAssetSort,
  type RingAssetView,
  type RingFeed,
  type RingKind,
  type RingLabels,
  type RingOverview,
  type RingRow,
} from '../../../shared/src/rings-api.js';
import { WSOL_MINT } from '../../../shared/src/constants.js';
import { api } from '../api.js';
import { compactSol, explorerAddress, explorerTx } from '../format.js';
import { type IconName, icon, triangle } from '../icons.js';
import { pageRange, pageWindow } from '../paging.js';
import { amountText, looksLikeAddress, rowWords, shareText, shortAddress, signedAmount, utcTime } from '../rings-render.js';
import { mountRuntime } from '../shell.js';
import { sparkSvg } from '../spark.js';
import { byId, escapeHtml, ghostState, initShell, relativeTime, setText, tokenArt, wireCopyButtons } from '../ui.js';

initShell('rings');

type View = 'tokens' | 'live' | 'address' | 'token';

interface State {
  view: View;
  sort: RingAssetSort;
  page: number;
  query: string;
  kind: '' | RingKind;
  address: string;
  mint: string;
}

const FEED_KINDS: readonly string[] = ['', 'shield', 'unshield', 'transfer', 'trade'];
const REFRESH_MS = 20_000;

const body = byId('rg-body');
const pager = byId('rg-pager');
const count = byId('rg-count');
const updated = byId('rg-updated');
const banner = byId('rings-banner');
const views = byId('rg-views');
const sorts = byId('rg-sorts');
const kinds = byId('rg-kinds');
const search = byId<HTMLInputElement>('rg-search');
const searchForm = byId<HTMLFormElement>('rg-search-form');
const strips = byId('rg-strips');

let overview: RingOverview | null = null;
let state = readState(location.search);
let sequence = 0;
/** The live feed on screen, newest first, and where its next older page starts. */
let feedRows: RingRow[] = [];
let feedLabels: RingLabels = {};
let feedNext: string | null = null;
let shownPage: RingAssetPage | null = null;

function readState(text: string): State {
  const params = new URLSearchParams(text);
  const one = (key: string): string => (params.get(key) ?? '').trim();
  const address = one('address');
  const mint = one('token');
  const sortText = one('sort');
  const pageNumber = Number(one('page') || '1');
  const kind = one('kind');
  const view: View = looksLikeAddress(address) ? 'address' : looksLikeAddress(mint) ? 'token' : one('view') === 'live' ? 'live' : 'tokens';
  return {
    view,
    sort: (RING_ASSET_SORTS as readonly string[]).includes(sortText) ? (sortText as RingAssetSort) : 'share',
    page: Number.isInteger(pageNumber) && pageNumber >= 1 && pageNumber <= 100_000 ? pageNumber : 1,
    query: one('q').slice(0, 64),
    kind: FEED_KINDS.includes(kind) ? (kind as State['kind']) : '',
    address: view === 'address' ? address : '',
    mint: view === 'token' ? mint : '',
  };
}

function stateSearch(next: State): string {
  const params = new URLSearchParams();
  if (next.view === 'address') params.set('address', next.address);
  else if (next.view === 'token') params.set('token', next.mint);
  else if (next.view === 'live') {
    params.set('view', 'live');
    if (next.kind) params.set('kind', next.kind);
  } else {
    if (next.sort !== 'share') params.set('sort', next.sort);
    if (next.query) params.set('q', next.query);
    if (next.page > 1) params.set('page', String(next.page));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

function go(next: State, options: { push?: boolean; scroll?: boolean } = {}): void {
  state = next;
  const url = `${location.pathname}${stateSearch(next)}`;
  if (options.push) history.pushState(null, '', url);
  else history.replaceState(null, '', url);
  syncControls();
  void load();
  if (options.scroll) byId('rings').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ---------------- small pieces ---------------- */

const KIND_ICONS: Readonly<Record<RingKind, IconName>> = {
  shield: 'shield',
  unshield: 'unshield',
  trade: 'swap',
  transfer: 'send',
  swap: 'swap',
  self: 'refresh',
  private: 'lock',
  token: 'plus',
  upkeep: 'clock',
  other: 'clock',
};

function flowChip(units: string, decimals: number, window: string): string {
  const flow = signedAmount(units, decimals);
  const spoken = flow.direction === 'flat' ? `No net movement over ${window}` : `${flow.direction === 'up' ? 'More went in than came out' : 'More came out than went in'} over ${window}: ${flow.text}`;
  return `<span class="chg ${flow.direction}" title="${escapeHtml(spoken)}">${flow.direction === 'flat' ? '' : triangle(flow.direction === 'up')}<span>${escapeHtml(flow.text.replace(/^[+−]/, ''))}</span><span class="sr-only">${escapeHtml(spoken)}</span></span>`;
}

function assetName(asset: RingAsset): { symbol: string; name: string } {
  if (asset.mint === WSOL_MINT) return { symbol: 'SOL', name: 'Solana' };
  return { symbol: asset.symbol || shortAddress(asset.mint), name: asset.name || (asset.symbol ? '' : 'No name on record') };
}

function feedRow(row: RingRow, labels: RingLabels): string {
  const words = rowWords(row, labels);
  const time = row.at > 0 ? `<time datetime="${new Date(row.at).toISOString()}" title="${escapeHtml(utcTime(row.at))}">${escapeHtml(relativeTime(row.at))}</time>` : '';
  return `<li class="rg-row" data-kind="${row.kind}"><span class="rg-kind">${icon(KIND_ICONS[row.kind] ?? 'clock')}<span>${escapeHtml(words.label)}</span></span><div class="rg-what"><p>${words.html}</p>${words.note ? `<small>${escapeHtml(words.note)}</small>` : ''}</div><div class="rg-when">${time}<a class="tx-link" href="${escapeHtml(explorerTx(row.signature))}" target="_blank" rel="noopener noreferrer" title="Open the transaction in an explorer">${escapeHtml(shortAddress(row.signature, 5, 5))}</a></div></li>`;
}

function feedList(rows: readonly RingRow[], labels: RingLabels): string {
  return `<ol class="rg-feed">${rows.map((row) => feedRow(row, labels)).join('')}</ol>`;
}

function fact(label: string, value: string, title = ''): string {
  return `<div${title ? ` title="${escapeHtml(title)}"` : ''}><dt>${escapeHtml(label)}</dt><dd>${value}</dd></div>`;
}

function dateText(at: number | null): string {
  return at ? escapeHtml(utcTime(at).slice(0, 10)) : '—';
}

/** History that has not all been read yet is said, wherever a count or a list depends on it. */
function historyNote(since: number | null, complete: boolean): string {
  if (complete || since === null) return '';
  return `<p class="rg-partial">This site is still reading earlier history. What is shown starts on ${dateText(since)}; anything before that is not here yet.</p>`;
}

/* ---------------- views ---------------- */

function renderTokens(page: RingAssetPage): void {
  shownPage = page;
  if (page.assets.length === 0) {
    body.innerHTML = state.query
      ? ghostState('NOTHING BY THAT NAME', 'No token registered with Rings matches. A wallet address opens that wallet instead: paste the whole address.')
      : ghostState('NO TOKENS READ YET', 'The registry is read within a minute of this server starting.');
    return;
  }
  const rows = page.assets
    .map((asset) => {
      const { symbol, name } = assetName(asset);
      const share = shareText(asset.shareBps, asset.shielded);
      const width = asset.shareBps === null ? 0 : Math.max(asset.shielded === '0' ? 0 : 2, Math.min(100, asset.shareBps / 100));
      const href = `/rings?token=${encodeURIComponent(asset.mint)}`;
      const here = asset.listed ? '<span class="rg-here" title="Launched on this site">HERE</span>' : '';
      return `<tr data-held="${asset.shielded === '0' ? 'no' : 'yes'}"><td class="c-token"><a class="rg-tok" href="${href}"><span class="rg-art">${tokenArt({ image: asset.image, symbol: asset.symbol, mint: asset.mint })}</span><span class="rg-tokname"><b>${escapeHtml(symbol)}${here}</b><i>${escapeHtml(name)}</i></span></a></td><td class="num c-held">${escapeHtml(amountText(asset.shielded, asset.decimals))}</td><td class="num c-share"><span>${escapeHtml(share)}</span><span class="rg-bar" aria-hidden="true"><i style="width:${width.toFixed(2)}%"></i></span></td><td class="num c-24">${flowChip(asset.flow24h, asset.decimals, '24 hours')}</td><td class="num c-7">${flowChip(asset.flow7d, asset.decimals, '7 days')}</td><td class="c-chart">${asset.trail.length > 1 ? `<span class="rg-spark">${sparkSvg(asset.trail.map((value) => value + 0.02))}</span>` : '<span class="rg-flat" aria-hidden="true"></span>'}</td><td class="num c-moves">${asset.moves24h > 0 ? String(asset.moves24h) : '—'}</td></tr>`;
    })
    .join('');
  body.innerHTML = `<div class="rg-table-wrap"><table class="rg-table"><thead><tr><th class="c-token" scope="col">Token</th><th class="num c-held" scope="col" title="Everything of the token that anyone holds privately: the balance of its Rings vault">Held privately</th><th class="num c-share" scope="col" title="That amount as a share of the token’s supply">Of supply</th><th class="num c-24" scope="col" title="Shielded less unshielded over the last 24 hours">Net, 24h</th><th class="num c-7" scope="col" title="Shielded less unshielded over the last 7 days">Net, 7d</th><th class="c-chart" scope="col" title="The amount held privately over the last 7 days">7 days</th><th class="num c-moves" scope="col" title="Shields and unshields in the last 24 hours">Moves</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function renderPager(): void {
  const page = state.view === 'tokens' ? shownPage : null;
  if (!page || page.total === 0) {
    pager.hidden = true;
    pager.innerHTML = '';
    return;
  }
  if (page.pages <= 1) {
    pager.innerHTML = `<div class="pager-note">${pageRange(page.page, page.size, page.total)}</div>`;
    pager.hidden = false;
    return;
  }
  const numbers = pageWindow(page.page, page.pages)
    .map((item) => (item === 'gap' ? '<span class="pager-gap" aria-hidden="true">…</span>' : `<button type="button" class="pager-page" data-page="${item}" aria-label="Page ${item}" ${item === page.page ? 'aria-current="page"' : ''}>${item}</button>`))
    .join('');
  pager.innerHTML = `<button type="button" class="pager-step" data-page="${page.page - 1}" aria-label="Previous page" ${page.page <= 1 ? 'disabled' : ''}>Prev</button><div class="pager-pages">${numbers}</div><button type="button" class="pager-step" data-page="${page.page + 1}" aria-label="Next page" ${page.page >= page.pages ? 'disabled' : ''}>Next</button><div class="pager-note">${pageRange(page.page, page.size, page.total)}</div>`;
  pager.hidden = false;
}

function renderFeed(): void {
  if (feedRows.length === 0) {
    body.innerHTML = ghostState('NOTHING HERE YET', state.kind ? 'Nothing of that kind has been read yet.' : 'The first transactions appear within a minute of this server starting.');
    return;
  }
  body.innerHTML = `${feedList(feedRows, feedLabels)}${feedNext ? '<div class="rg-more"><button type="button" class="btn flat" data-older>Older</button></div>' : ''}`;
}

function renderAddress(view: RingAddressView): void {
  const { counts } = view;
  const total = counts.shields + counts.unshields + counts.trades + counts.sent + counts.received + counts.own;
  const registered = view.registered === null ? '—' : view.registered ? 'Yes' : 'No';
  const others = view.counterparties
    .map(
      (other) =>
        `<li><a class="rg-addr" href="/rings?address=${encodeURIComponent(other.address)}" title="${escapeHtml(other.address)}">${escapeHtml(shortAddress(other.address, 6, 6))}</a><span>${other.sent > 0 ? `paid ${other.sent}×` : ''}${other.sent > 0 && other.received > 0 ? ' · ' : ''}${other.received > 0 ? `was paid by it ${other.received}×` : ''}</span><time>${escapeHtml(relativeTime(other.last))}</time></li>`,
    )
    .join('');
  const head = `<section class="rg-head"><div class="rg-head-id"><span class="rg-eyebrow">Wallet</span><code class="rg-full">${escapeHtml(view.address)}</code><div class="rg-head-links"><button class="icon-btn" type="button" data-copy="${escapeHtml(view.address)}">COPY</button><a class="tx-link" href="${escapeHtml(explorerAddress(view.address))}" target="_blank" rel="noopener noreferrer">Explorer</a></div></div><dl class="rg-facts">${fact('Registered with Rings', registered, 'Whether the wallet has a public record that lets others pay it privately')}${fact('First seen', dateText(view.first))}${fact('Last seen', view.last ? escapeHtml(relativeTime(view.last)) : '—')}${fact('Shields', String(counts.shields))}${fact('Unshields', String(counts.unshields))}${fact('Pool trades', String(counts.trades))}${fact('Paid privately', String(counts.sent), 'Private payments this wallet made')}${fact('Was paid privately', String(counts.received), 'Private payments made to this wallet')}</dl><p class="rg-explain">This is what anyone can read about this wallet on Rings: when it moved funds in or out and how much, and which wallets it paid or was paid by. What it holds privately, and the token and amount of each private payment, are not here. Nobody but the wallet can read them.</p>${historyNote(view.since, view.complete)}</section>`;
  const list = view.rows.length > 0 ? `${feedList(view.rows, view.labels)}${view.next ? `<div class="rg-more"><button type="button" class="btn flat" data-older-address="${escapeHtml(view.next)}">Older</button></div>` : ''}` : '';
  const empty = total === 0 && view.rows.length === 0 ? ghostState('NOTHING ON RINGS', view.registered ? 'This wallet is registered and has moved nothing that has been read here.' : 'Nothing this site has read involves this wallet.') : '';
  body.innerHTML = `${head}${others ? `<section class="rg-block"><h2>Wallets it dealt with privately</h2><ul class="rg-others">${others}</ul><p class="rg-small">A private payment shows the two wallets. How often they dealt is public; what they sent is not.</p></section>` : ''}${list ? `<section class="rg-block"><h2>Activity</h2>${list}</section>` : ''}${empty}`;
  wireCopyButtons(body);
}

function renderToken(view: RingAssetView): void {
  const { asset } = view;
  const { symbol, name } = assetName(asset);
  const trade = asset.listed ? `<a class="btn secondary" href="/token?mint=${encodeURIComponent(asset.mint)}">Open its page here</a>` : '';
  const head = `<section class="rg-head"><div class="rg-head-id rg-head-token"><span class="rg-art rg-art-big">${tokenArt({ image: asset.image, symbol: asset.symbol, mint: asset.mint })}</span><div><span class="rg-eyebrow">Token in Rings</span><h2 class="rg-title">${escapeHtml(symbol)}${name ? `<i>${escapeHtml(name)}</i>` : ''}</h2><code class="rg-full">${escapeHtml(asset.mint)}</code><div class="rg-head-links"><button class="icon-btn" type="button" data-copy="${escapeHtml(asset.mint)}">COPY</button><a class="tx-link" href="${escapeHtml(explorerAddress(asset.mint))}" target="_blank" rel="noopener noreferrer">Explorer</a>${trade}</div></div></div><dl class="rg-facts">${fact('Held privately', escapeHtml(amountText(asset.shielded, asset.decimals)), 'The balance of the token’s Rings vault: everything of it that anyone holds privately')}${fact('Of supply', escapeHtml(shareText(asset.shareBps, asset.shielded)))}${fact('Net, 24h', flowChip(asset.flow24h, asset.decimals, '24 hours'))}${fact('Net, 7d', flowChip(asset.flow7d, asset.decimals, '7 days'))}${fact('Wallets that shielded it', String(view.shielders))}${fact('Wallets that unshielded it', String(view.unshielders))}</dl>${asset.trail.length > 1 ? `<div class="rg-chart" title="The amount held privately over the last 7 days"><span class="rg-spark">${sparkSvg(asset.trail.map((value) => value + 0.02))}</span></div>` : ''}<p class="rg-explain">How much of this token is held privately is exact: it all sits in one vault. How many wallets hold it privately cannot be counted, by anyone: a private payment does not say which token it carries, so a wallet that was paid in it looks like any other.</p>${overview ? historyNote(overview.since, overview.complete) : ''}</section>`;
  const list = view.rows.length > 0 ? `<section class="rg-block"><h2>Latest public movements</h2>${feedList(view.rows, view.labels)}</section>` : ghostState('NO PUBLIC MOVEMENTS READ', 'Nobody has shielded or unshielded this token in the history read so far.');
  body.innerHTML = `${head}${list}`;
  wireCopyButtons(body);
}

/* ---------------- loading ---------------- */

function renderOverview(): void {
  if (!overview) return;
  if (!overview.enabled) {
    banner.hidden = false;
    banner.textContent = 'This site is not following Rings right now, so there is nothing to show here.';
    return;
  }
  banner.hidden = true;
  setText('r-tokens', overview.tokens.toLocaleString('en-US'));
  setText('r-wallets', overview.wallets === null ? '—' : overview.wallets.toLocaleString('en-US'));
  setText('r-moves', overview.tx24h.toLocaleString('en-US'));
  setText('r-sol', compactSol(overview.solShielded));
  updated.textContent = overview.through ? `Read up to ${relativeTime(overview.through)}${overview.complete ? '' : ' · still reading earlier history'}` : 'Starting to read';
}

function failed(error: unknown): void {
  const message = error instanceof Error ? error.message : 'This could not be loaded.';
  body.innerHTML = ghostState('COULD NOT LOAD', `${escapeHtml(message)} <button type="button" class="btn flat" data-retry>Try again</button>`);
  count.textContent = '';
}

async function load(options: { quiet?: boolean } = {}): Promise<void> {
  const mine = ++sequence;
  if (!options.quiet) body.setAttribute('aria-busy', 'true');
  try {
    overview = await api.ringOverview();
    if (mine !== sequence) return;
    renderOverview();
    if (!overview.enabled) {
      body.innerHTML = ghostState('NOT FOLLOWING RINGS', 'The operator has switched the explorer off on this server.');
      count.textContent = '';
      pager.hidden = true;
      return;
    }
    if (state.view === 'tokens') {
      const page = await api.ringTokens({ sort: state.sort, page: state.page, query: state.query });
      if (mine !== sequence) return;
      renderTokens(page);
      count.textContent = state.query ? `${page.total.toLocaleString('en-US')} match${page.total === 1 ? '' : 'es'}` : `${page.total.toLocaleString('en-US')} token${page.total === 1 ? '' : 's'} registered with Rings`;
    } else if (state.view === 'live') {
      const feed: RingFeed = await api.ringFeed({ kind: state.kind });
      if (mine !== sequence) return;
      // A refresh keeps the older pages already on screen and puts what is new above them.
      const known = new Set(feed.rows.map((row) => row.signature));
      const older = options.quiet ? feedRows.filter((row) => !known.has(row.signature) && row.at <= (feed.rows[feed.rows.length - 1]?.at ?? 0)) : [];
      feedRows = [...feed.rows, ...older];
      feedLabels = { ...feedLabels, ...feed.labels };
      if (older.length === 0) feedNext = feed.next;
      renderFeed();
      count.textContent = `${overview.shields24h} shield${overview.shields24h === 1 ? '' : 's'}, ${overview.unshields24h} unshield${overview.unshields24h === 1 ? '' : 's'} and ${overview.transfers24h} private transfer${overview.transfers24h === 1 ? '' : 's'} in the last 24 hours`;
    } else if (state.view === 'address') {
      const view = await api.ringAddress(state.address);
      if (mine !== sequence) return;
      renderAddress(view);
      count.textContent = 'One wallet, as anyone can see it';
    } else {
      const view = await api.ringToken(state.mint);
      if (mine !== sequence) return;
      renderToken(view);
      count.textContent = 'One token, as anyone can see it';
    }
    renderPager();
  } catch (error) {
    if (mine !== sequence) return;
    if (!options.quiet) failed(error);
  } finally {
    if (mine === sequence) body.setAttribute('aria-busy', 'false');
  }
}

function syncControls(): void {
  const list = state.view === 'tokens' || state.view === 'live';
  views.querySelectorAll<HTMLButtonElement>('button[data-view]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.view === state.view)));
  sorts.hidden = state.view !== 'tokens';
  kinds.hidden = state.view !== 'live';
  sorts.querySelectorAll<HTMLButtonElement>('button[data-sort]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.sort === state.sort)));
  kinds.querySelectorAll<HTMLButtonElement>('button[data-kind]').forEach((button) => button.setAttribute('aria-pressed', String((button.dataset.kind ?? '') === state.kind)));
  if (document.activeElement !== search) search.value = state.view === 'address' ? state.address : state.view === 'token' ? state.mint : state.query;
  if (!list) pager.hidden = true;
  markStrips();
}

/** The row of controls scrolls sideways on a phone; a fade says there is more to one side. */
function markStrips(): void {
  const room = strips.scrollWidth - strips.clientWidth;
  if (room <= 4) return void strips.removeAttribute('data-more');
  const left = strips.scrollLeft > 4;
  const right = strips.scrollLeft < room - 4;
  strips.dataset.more = left && right ? 'both' : left ? 'left' : right ? 'right' : '';
  if (!left && !right) strips.removeAttribute('data-more');
}

views.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-view]');
  if (!button) return;
  const view = button.dataset.view === 'live' ? 'live' : 'tokens';
  if (view === state.view) return;
  feedRows = [];
  feedNext = null;
  search.value = '';
  go({ ...state, view, page: 1, query: '', address: '', mint: '' }, { push: true });
});

sorts.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-sort]');
  const sort = button?.dataset.sort as RingAssetSort | undefined;
  if (!sort || !(RING_ASSET_SORTS as readonly string[]).includes(sort) || sort === state.sort) return;
  go({ ...state, sort, page: 1 }, { push: true });
});

kinds.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-kind]');
  if (!button) return;
  const kind = (button.dataset.kind ?? '') as State['kind'];
  if (!FEED_KINDS.includes(kind) || kind === state.kind) return;
  feedRows = [];
  feedNext = null;
  go({ ...state, kind }, { push: true });
});

pager.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-page]');
  if (!button || button.disabled) return;
  const page = Number(button.dataset.page);
  if (!Number.isInteger(page) || page < 1 || page === state.page) return;
  go({ ...state, page }, { push: true, scroll: true });
});

let searchTimer: number | undefined;
/** A whole address opens that wallet or that token. Anything else filters the tokens by name. */
function runSearch(submitted: boolean): void {
  const text = search.value.trim();
  if (looksLikeAddress(text)) {
    if (!submitted) return;
    // A token registered with Rings opens as a token; any other address is a wallet.
    void api
      .ringToken(text)
      .then(() => go({ ...state, view: 'token', mint: text, address: '', query: '', page: 1 }, { push: true }))
      .catch(() => go({ ...state, view: 'address', address: text, mint: '', query: '', page: 1 }, { push: true }));
    return;
  }
  if (state.view !== 'tokens' && !submitted && !text) return;
  go({ ...state, view: 'tokens', query: text.slice(0, 64), page: 1, address: '', mint: '' }, { push: submitted });
}

search.addEventListener('input', () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => runSearch(false), 300);
});
searchForm.addEventListener('submit', (event) => {
  event.preventDefault();
  window.clearTimeout(searchTimer);
  runSearch(true);
});

body.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  if (target.closest('[data-retry]')) return void load();
  const older = target.closest<HTMLButtonElement>('[data-older]');
  if (older && feedNext) {
    older.disabled = true;
    void api
      .ringFeed({ kind: state.kind, before: feedNext })
      .then((feed) => {
        const known = new Set(feedRows.map((row) => row.signature));
        feedRows = [...feedRows, ...feed.rows.filter((row) => !known.has(row.signature))];
        feedLabels = { ...feedLabels, ...feed.labels };
        feedNext = feed.next;
        renderFeed();
      })
      .catch(() => {
        older.disabled = false;
      });
    return;
  }
  const olderAddress = target.closest<HTMLButtonElement>('[data-older-address]');
  if (olderAddress?.dataset.olderAddress && state.view === 'address') {
    olderAddress.disabled = true;
    const address = state.address;
    void api
      .ringAddress(address, olderAddress.dataset.olderAddress)
      .then((view) => {
        if (state.view !== 'address' || state.address !== address) return;
        const holder = olderAddress.closest('.rg-more');
        const list = holder?.previousElementSibling;
        if (!holder || !list) return;
        list.insertAdjacentHTML('beforeend', view.rows.map((row) => feedRow(row, view.labels)).join(''));
        if (view.next) {
          olderAddress.dataset.olderAddress = view.next;
          olderAddress.disabled = false;
        } else holder.remove();
      })
      .catch(() => {
        olderAddress.disabled = false;
      });
  }
});

window.addEventListener('popstate', () => {
  state = readState(location.search);
  feedRows = [];
  feedNext = null;
  syncControls();
  void load();
});
strips.addEventListener('scroll', markStrips, { passive: true });
window.addEventListener('resize', markStrips);

// What is on screen is read again while the page is being looked at. The token and wallet views are
// left alone: they are read when opened, and a list that grows under a reader is no help.
window.setInterval(() => {
  if (document.hidden || (state.view !== 'tokens' && state.view !== 'live')) return;
  if (document.activeElement === search && search.value.trim() !== state.query) return;
  void load({ quiet: true });
}, REFRESH_MS);

syncControls();
void mountRuntime();
void load();
