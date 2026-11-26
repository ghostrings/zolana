import { describe, expect, it } from 'vitest';

import { PAY_SOL } from '../shared/src/paylink.js';
import {
  type HistoryRow,
  MEMO_LIMIT,
  type PayRequestRecord,
  REQUEST_LIMIT,
  SEEN_LIMIT,
  arrivalsSince,
  firstLook,
  matchRequests,
  memoOf,
  parseMemoBook,
  parseRequestBook,
  parseSeen,
  rowKey,
  withMemo,
  withRequest,
  withoutRequest,
} from '../shared/src/payrecords.js';

const SOL = '11111111111111111111111111111111';
const TOKEN = 'Tok1111111111111111111111111111111111111111';

let made = 0;
function row(input: Partial<HistoryRow> & { slot: bigint }): HistoryRow {
  made += 1;
  return { signature: `sig${made}`, index: 0n, kind: 'privateTransfer', direction: 'inbound', asset: SOL, amount: 1_000_000_000n, ...input };
}

describe('notes kept with payments', () => {
  it('are kept by transaction, the newest replacing the one before', () => {
    let book = parseMemoBook(null);
    book = withMemo(book, { signature: 'a', at: 1, note: 'first' });
    book = withMemo(book, { signature: 'b', at: 2, to: 'Dest', note: '' });
    book = withMemo(book, { signature: 'a', at: 3, note: 'second' });
    expect(book.items.map((item) => item.signature)).toEqual(['b', 'a']);
    expect(memoOf(book, 'a')).toEqual({ signature: 'a', at: 3, note: 'second' });
    expect(memoOf(book, 'b')).toEqual({ signature: 'b', at: 2, to: 'Dest' });
    expect(memoOf(book, 'c')).toBeUndefined();
  });

  it('are not kept when there is nothing to keep', () => {
    const book = withMemo(parseMemoBook(null), { signature: 'a', at: 1, note: '   ' });
    expect(book.items).toEqual([]);
  });

  it('survive storage, and a damaged store reads as empty', () => {
    const book = withMemo(parseMemoBook(null), { signature: 'a', at: 1, to: 'Dest', note: 'rent' });
    expect(parseMemoBook(JSON.stringify(book))).toEqual(book);
    for (const raw of ['', 'not json', '[]', '{"items":5}', '{"items":[{"signature":7}]}', '{"items":[null,{"signature":"x","at":"soon"}]}']) expect(parseMemoBook(raw).items).toEqual([]);
  });

  it('clean a note again on the way out of storage', () => {
    const raw = JSON.stringify({ v: 1, items: [{ signature: 'a', at: 1, note: `line\none${String.fromCodePoint(0x202e)}` }] });
    expect(parseMemoBook(raw).items).toEqual([{ signature: 'a', at: 1, note: 'line one' }]);
  });

  it('never grow past their limit: the oldest go first', () => {
    let book = parseMemoBook(null);
    for (let index = 0; index < MEMO_LIMIT + 5; index += 1) book = withMemo(book, { signature: `s${index}`, at: index, note: 'n' });
    expect(book.items).toHaveLength(MEMO_LIMIT);
    expect(book.items[0]?.signature).toBe('s5');
  });
});

describe('requests kept in this browser', () => {
  const record = (id: string, extra: Partial<PayRequestRecord> = {}): PayRequestRecord => ({ id, at: 1, afterSlot: '100', token: PAY_SOL, amount: '1', units: '1000000000', note: 'n', ...extra });

  it('are added, replaced and removed by id', () => {
    let book = parseRequestBook(undefined);
    book = withRequest(book, record('a'));
    book = withRequest(book, record('b', { note: ' two\nlines ' }));
    book = withRequest(book, record('a', { amount: '2', units: '2000000000' }));
    expect(book.items.map((item) => [item.id, item.amount, item.note])).toEqual([
      ['b', '1', 'two lines'],
      ['a', '2', 'n'],
    ]);
    expect(withoutRequest(book, 'b').items.map((item) => item.id)).toEqual(['a']);
  });

  it('survive storage, with anything unreadable dropped', () => {
    const book = withRequest(parseRequestBook(null), record('a', { amount: null, units: null }));
    expect(parseRequestBook(JSON.stringify(book))).toEqual(book);
    const raw = JSON.stringify({ items: [{ id: 'x', at: 1, token: PAY_SOL, afterSlot: 'soon', units: '-5', amount: 7, note: 9 }, { id: 'y' }] });
    expect(parseRequestBook(raw).items).toEqual([{ id: 'x', at: 1, afterSlot: '0', token: PAY_SOL, amount: null, units: null, note: '' }]);
  });

  it('never grow past their limit', () => {
    let book = parseRequestBook(null);
    for (let index = 0; index < REQUEST_LIMIT + 3; index += 1) book = withRequest(book, record(`r${index}`));
    expect(book.items).toHaveLength(REQUEST_LIMIT);
    expect(book.items[0]?.id).toBe('r3');
  });
});

describe('arrivals', () => {
  it('announces nothing that was there at the first look', () => {
    const rows = [row({ slot: 10n }), row({ slot: 11n })];
    const state = firstLook(rows);
    expect(arrivalsSince(state, rows).arrivals).toEqual([]);
  });

  it('announces an incoming private transfer once', () => {
    const before = [row({ slot: 10n })];
    const state = firstLook(before);
    const paid = row({ slot: 20n, amount: 5n });
    const look = arrivalsSince(state, [...before, paid]);
    expect(look.arrivals).toEqual([paid]);
    expect(arrivalsSince(look.state, [...before, paid]).arrivals).toEqual([]);
  });

  it('announces a shield into the wallet, and a ring entry', () => {
    const state = firstLook([]);
    const rows = [row({ slot: 5n, kind: 'deposit' }), row({ slot: 6n, kind: 'ringEntry' })];
    expect(arrivalsSince(state, rows).arrivals).toEqual(rows);
  });

  it('leaves out what the wallet sent, and its own consolidations', () => {
    const state = firstLook([]);
    const rows = [row({ slot: 5n, direction: 'outbound' }), row({ slot: 6n, direction: 'selfTransfer', kind: 'merge' })];
    expect(arrivalsSince(state, rows).arrivals).toEqual([]);
  });

  it('leaves out the incoming half of a trade the wallet made itself', () => {
    const state = firstLook([]);
    const out = row({ slot: 9n, direction: 'outbound', asset: SOL });
    const back: HistoryRow = { ...row({ slot: 9n, asset: TOKEN }), signature: out.signature, index: 1n };
    expect(arrivalsSince(state, [out, back]).arrivals).toEqual([]);
  });

  it('leaves out what landed in a slot this browser sent a transaction in', () => {
    const state = firstLook([]);
    const own = row({ slot: 30n, kind: 'deposit' });
    const other = row({ slot: 31n, kind: 'deposit' });
    expect(arrivalsSince(state, [own, other], new Set(['30'])).arrivals).toEqual([other]);
    // It is still marked as seen, so it is not announced later either.
    expect(arrivalsSince(arrivalsSince(state, [own, other], new Set(['30'])).state, [own, other]).arrivals).toEqual([]);
  });

  it('leaves out a row that carries nothing', () => {
    expect(arrivalsSince(firstLook([]), [row({ slot: 1n, amount: 0n })]).arrivals).toEqual([]);
  });

  it('gives arrivals oldest first', () => {
    const state = firstLook([]);
    const late = row({ slot: 9n });
    const early = row({ slot: 3n });
    expect(arrivalsSince(state, [late, early]).arrivals).toEqual([early, late]);
  });

  it('keeps working past the number of rows it remembers by key', () => {
    const old = Array.from({ length: SEEN_LIMIT + 50 }, (_unused, index) => row({ slot: BigInt(1_000 + index) }));
    const state = firstLook(old);
    expect(state.keys).toHaveLength(SEEN_LIMIT);
    expect(state.floor).toBe('1050');
    // None of the old rows is announced, although the oldest fifty are no longer remembered by key.
    expect(arrivalsSince(state, old).arrivals).toEqual([]);
    const paid = row({ slot: 5_000n });
    const look = arrivalsSince(state, [...old, paid]);
    expect(look.arrivals).toEqual([paid]);
    expect(BigInt(look.state.floor) >= 1050n).toBe(true);
    expect(arrivalsSince(look.state, [...old, paid]).arrivals).toEqual([]);
  });

  it('reads its state back from storage, and takes anything else as no state', () => {
    const state = firstLook([row({ slot: 4n })]);
    expect(parseSeen(JSON.stringify(state))).toEqual(state);
    for (const raw of [null, '', 'x', '{}', '{"keys":[],"floor":-1}', '{"keys":"a","floor":"1"}']) expect(parseSeen(raw)).toBeNull();
  });

  it('tells two rows of one transaction apart', () => {
    expect(rowKey({ signature: 's', index: 0n })).not.toBe(rowKey({ signature: 's', index: 1n }));
  });
});

describe('requests and the payments that fit them', () => {
  const request = (id: string, at: number, extra: Partial<PayRequestRecord> = {}): PayRequestRecord => ({ id, at, afterSlot: '100', token: PAY_SOL, amount: '1', units: '1000000000', note: '', ...extra });

  it('fits a payment of the same token and exactly the amount, made later', () => {
    const paid = row({ slot: 150n });
    expect(matchRequests([request('a', 1)], [paid], SOL)).toEqual(new Map([['a', paid]]));
  });

  it('does not fit another amount, another token, or an earlier payment', () => {
    expect(matchRequests([request('a', 1)], [row({ slot: 150n, amount: 999_999_999n })], SOL).size).toBe(0);
    expect(matchRequests([request('a', 1)], [row({ slot: 150n, asset: TOKEN })], SOL).size).toBe(0);
    expect(matchRequests([request('a', 1)], [row({ slot: 100n })], SOL).size).toBe(0);
    expect(matchRequests([request('a', 1, { token: TOKEN })], [row({ slot: 150n, asset: TOKEN })], SOL).size).toBe(1);
  });

  it('does not fit a shield, a payment the wallet sent, or a request without an amount', () => {
    expect(matchRequests([request('a', 1)], [row({ slot: 150n, kind: 'deposit' })], SOL).size).toBe(0);
    expect(matchRequests([request('a', 1)], [row({ slot: 150n, direction: 'outbound' })], SOL).size).toBe(0);
    expect(matchRequests([request('a', 1, { amount: null, units: null })], [row({ slot: 150n })], SOL).size).toBe(0);
  });

  it('gives each payment to one request, the oldest request first', () => {
    const first = row({ slot: 150n });
    const second = row({ slot: 160n });
    const matches = matchRequests([request('newer', 20), request('older', 10)], [second, first], SOL);
    expect(matches.get('older')).toBe(first);
    expect(matches.get('newer')).toBe(second);
    expect(matchRequests([request('newer', 20), request('older', 10)], [first], SOL)).toEqual(new Map([['older', first]]));
  });
});
