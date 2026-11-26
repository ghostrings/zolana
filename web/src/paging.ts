/**
 * The market's pages: which page numbers a pager shows, and how the page,
 * the order and the search are kept in the address bar. Nothing here touches
 * a page or the network, so all of it can be tested.
 */

import { TOKEN_SORTS, type TokenSort } from '../../shared/src/api.js';

export type PagerItem = number | 'gap';

/**
 * The buttons of a pager at `page` of `pages`: the first page, the last, the
 * current one and its neighbours, with a gap wherever numbers are left out.
 * Up to seven pages are simply all shown. Past that the list always has seven
 * entries, so the pager keeps its width as someone pages through.
 */
export function pageWindow(page: number, pages: number): PagerItem[] {
  const total = Number.isFinite(pages) ? Math.max(1, Math.floor(pages)) : 1;
  const current = Math.min(total, Math.max(1, Number.isFinite(page) ? Math.floor(page) : 1));
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);
  if (current <= 4) return [1, 2, 3, 4, 5, 'gap', total];
  if (current >= total - 3) return [1, 'gap', total - 4, total - 3, total - 2, total - 1, total];
  return [1, 'gap', current - 1, current, current + 1, 'gap', total];
}

export interface MarketView {
  /** From 1. */
  readonly page: number;
  readonly sort: TokenSort;
  /** What is typed in the search box, trimmed. */
  readonly query: string;
  /** A pair token's id, to see only the tokens priced in it. Empty for all of them. */
  readonly pair: string;
}

export const DEFAULT_VIEW: MarketView = Object.freeze({ page: 1, sort: 'hot', query: '', pair: '' });

/** Reads a view from an address's query string. Anything it does not understand becomes the default. */
export function readMarketView(search: string): MarketView {
  const params = new URLSearchParams(search);
  const page = Number.parseInt(params.get('page') ?? '', 10);
  const sort = params.get('sort') ?? '';
  const pair = (params.get('pair') ?? '').trim().toUpperCase();
  return {
    page: Number.isInteger(page) && page >= 1 && page <= 1_000_000 ? page : 1,
    sort: (TOKEN_SORTS as readonly string[]).includes(sort) ? (sort as TokenSort) : DEFAULT_VIEW.sort,
    query: (params.get('q') ?? '').trim().slice(0, 64),
    // The shape of a pair id only. Whether it is one the site knows is the server's answer to give.
    pair: /^[A-Z0-9]{1,16}$/.test(pair) ? pair : '',
  };
}

/** The query string for a view, leaving out whatever is at its default. "" for the plain market. */
export function marketViewSearch(view: MarketView): string {
  const params = new URLSearchParams();
  if (view.query) params.set('q', view.query);
  if (view.pair) params.set('pair', view.pair);
  if (view.sort !== DEFAULT_VIEW.sort) params.set('sort', view.sort);
  if (view.page > 1) params.set('page', String(view.page));
  const text = params.toString();
  return text ? `?${text}` : '';
}

/** "25–48 of 57": which tokens a page shows, out of how many. */
export function pageRange(page: number, size: number, total: number): string {
  if (total <= 0) return '0 of 0';
  const first = (page - 1) * size + 1;
  const last = Math.min(total, page * size);
  return first > total ? `0 of ${total}` : `${first}–${last} of ${total}`;
}
