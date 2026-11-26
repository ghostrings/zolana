/**
 * The market's list, a page at a time. Kept apart from the HTTP layer so the
 * rule that matters here can be tested: a page holds twenty-four tokens and
 * the server never hands out more, whatever it is asked for.
 */

import { MARKET_PAGE_SIZE, TOKEN_SORTS, type TokenPageResponse, type TokenSort, type TokenSummary } from '../../shared/src/api.js';
import { pairTokenById } from '../../shared/src/quotes.js';
import { unitsOf, volumeFromFees } from '../../shared/src/volume.js';
import type { Store, TokenRow } from './db.js';

export interface PageRequest {
  /** From 1. */
  readonly page: number;
  readonly size: number;
  readonly sort: TokenSort;
  readonly query: string;
  /** A pair token's id, to list only the tokens priced in it. Empty for all of them. */
  readonly pair: string;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/**
 * What a token has traded since launch, in base units of its pair token: the
 * fees its curve and its pool have taken over its fee rate. Both are figures
 * kept on chain, so this needs none of this server's own history.
 */
export function lifetimeVolume(row: Pick<TokenRow, 'fee_lamports' | 'fee_bps'>): string {
  return volumeFromFees(unitsOf(row.fee_lamports), row.fee_bps).toString();
}

/**
 * Reads `page`, `size`, `sort`, `q` and `pair` from a request's query.
 * Anything missing, malformed or out of range becomes the default: nothing a
 * visitor types into the address bar is an error.
 */
export function readPageRequest(query: Readonly<Record<string, unknown>>): PageRequest {
  const sort = text(query.sort);
  const page = Number.parseInt(text(query.page) || '1', 10);
  // Twenty-four to a page, and never more: a smaller size may be asked for, a larger one is not served.
  const size = Number.parseInt(text(query.size) || String(MARKET_PAGE_SIZE), 10);
  return {
    page: Number.isInteger(page) && page >= 1 && page <= 1_000_000 ? page : 1,
    size: Number.isInteger(size) && size >= 1 && size <= MARKET_PAGE_SIZE ? size : MARKET_PAGE_SIZE,
    sort: (TOKEN_SORTS as readonly string[]).includes(sort) ? (sort as TokenSort) : 'hot',
    query: text(query.q).slice(0, 64),
    // Only a pair token this build knows is a filter; anything else lists everything.
    pair: pairTokenById(text(query.pair).slice(0, 16))?.id ?? '',
  };
}

/**
 * One page of the listing. A page past the end (the list shrank, or the
 * number was typed) is answered with the last page, not an empty one, and the
 * answer says which page it is.
 */
export function tokenPage(store: Pick<Store, 'tokenPage'>, request: PageRequest, listed: (row: TokenRow) => TokenSummary): TokenPageResponse {
  let page = request.page;
  const ask = (at: number) => store.tokenPage({ page: at, size: request.size, sort: request.sort, query: request.query, ...(request.pair ? { pair: request.pair } : {}) });
  let result = ask(page);
  const pages = Math.max(1, Math.ceil(result.total / request.size));
  if (page > pages) {
    page = pages;
    result = ask(page);
  }
  return { tokens: result.rows.map(listed), total: result.total, page, pages, size: request.size };
}
