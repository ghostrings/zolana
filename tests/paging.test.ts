import { describe, expect, it } from 'vitest';

import { MARKET_PAGE_SIZE } from '../shared/src/api.js';
import { DEFAULT_VIEW, marketViewSearch, pageRange, pageWindow, readMarketView } from '../web/src/paging.js';

describe('the market’s pager', () => {
  it('shows every page while there are seven or fewer', () => {
    expect(pageWindow(1, 1)).toEqual([1]);
    expect(pageWindow(3, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(pageWindow(7, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('keeps the first, the last, the current page and its neighbours when there are more', () => {
    expect(pageWindow(1, 20)).toEqual([1, 2, 3, 4, 5, 'gap', 20]);
    expect(pageWindow(4, 20)).toEqual([1, 2, 3, 4, 5, 'gap', 20]);
    expect(pageWindow(5, 20)).toEqual([1, 'gap', 4, 5, 6, 'gap', 20]);
    expect(pageWindow(10, 20)).toEqual([1, 'gap', 9, 10, 11, 'gap', 20]);
    expect(pageWindow(16, 20)).toEqual([1, 'gap', 15, 16, 17, 'gap', 20]);
    expect(pageWindow(17, 20)).toEqual([1, 'gap', 16, 17, 18, 19, 20]);
    expect(pageWindow(20, 20)).toEqual([1, 'gap', 16, 17, 18, 19, 20]);
  });

  it('always offers the current page, and its neighbours when it has them', () => {
    for (const pages of [1, 2, 7, 8, 9, 30, 500]) {
      for (let page = 1; page <= pages; page += 1) {
        const shown = pageWindow(page, pages);
        expect(shown).toContain(page);
        expect(shown).toContain(1);
        expect(shown).toContain(pages);
        if (page > 1) expect(shown).toContain(page - 1);
        if (page < pages) expect(shown).toContain(page + 1);
        // Never wider than seven, never the same number twice, always rising.
        expect(shown.length).toBeLessThanOrEqual(7);
        const numbers = shown.filter((item): item is number => item !== 'gap');
        expect(new Set(numbers).size).toBe(numbers.length);
        expect([...numbers].sort((a, b) => a - b)).toEqual(numbers);
        // A gap always stands for at least one page left out.
        shown.forEach((item, at) => {
          if (item === 'gap') expect((shown[at + 1] as number) - (shown[at - 1] as number)).toBeGreaterThan(1);
        });
      }
    }
  });

  it('copes with a page or a count that makes no sense', () => {
    expect(pageWindow(0, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(pageWindow(99, 3)).toEqual([1, 2, 3]);
    expect(pageWindow(2, 0)).toEqual([1]);
    expect(pageWindow(Number.NaN, Number.NaN)).toEqual([1]);
  });

  it('says which tokens a page shows', () => {
    expect(pageRange(1, MARKET_PAGE_SIZE, 57)).toBe('1–24 of 57');
    expect(pageRange(2, MARKET_PAGE_SIZE, 57)).toBe('25–48 of 57');
    expect(pageRange(3, MARKET_PAGE_SIZE, 57)).toBe('49–57 of 57');
    expect(pageRange(4, MARKET_PAGE_SIZE, 57)).toBe('0 of 57');
    expect(pageRange(1, MARKET_PAGE_SIZE, 1)).toBe('1–1 of 1');
    expect(pageRange(1, MARKET_PAGE_SIZE, 0)).toBe('0 of 0');
  });

  it('is twenty-four to a page', () => {
    expect(MARKET_PAGE_SIZE).toBe(24);
  });
});

describe('the market’s address', () => {
  it('reads a page, an order and a search', () => {
    expect(readMarketView('')).toEqual(DEFAULT_VIEW);
    expect(readMarketView('?page=3&sort=new&q=ghost')).toEqual({ page: 3, sort: 'new', query: 'ghost', pair: '' });
    expect(readMarketView('?q=%20PRV%20')).toEqual({ page: 1, sort: 'hot', query: 'PRV', pair: '' });
    // A pair is part of the view: any case in the address, and only the shape of an id.
    expect(readMarketView('?pair=usdc&page=2')).toEqual({ page: 2, sort: 'hot', query: '', pair: 'USDC' });
    expect(readMarketView('?pair=hSOL').pair).toBe('HSOL');
  });

  it('falls back to the default for anything it does not understand', () => {
    expect(readMarketView('?page=0')).toEqual(DEFAULT_VIEW);
    expect(readMarketView('?page=-2&sort=worst')).toEqual(DEFAULT_VIEW);
    expect(readMarketView('?page=abc')).toEqual(DEFAULT_VIEW);
    expect(readMarketView('?page=2.5').page).toBe(2);
    expect(readMarketView('?pair=%3Cscript%3E').pair).toBe('');
    expect(readMarketView(`?pair=${'A'.repeat(40)}`).pair).toBe('');
    expect(readMarketView(`?q=${'x'.repeat(200)}`).query).toHaveLength(64);
  });

  it('writes only what differs from the default, and reads its own writing back', () => {
    expect(marketViewSearch(DEFAULT_VIEW)).toBe('');
    expect(marketViewSearch({ page: 2, sort: 'hot', query: '', pair: '' })).toBe('?page=2');
    expect(marketViewSearch({ page: 1, sort: 'cap', query: '', pair: '' })).toBe('?sort=cap');
    expect(marketViewSearch({ page: 1, sort: 'hot', query: '', pair: 'USDC' })).toBe('?pair=USDC');
    const view = { page: 4, sort: 'graduation', query: '100% real & more', pair: 'ZEC' } as const;
    expect(readMarketView(marketViewSearch(view))).toEqual(view);
  });
});
