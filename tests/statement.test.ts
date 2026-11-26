import { describe, expect, it } from 'vitest';

import type { HistoryRow } from '../shared/src/payrecords.js';
import { STATEMENT_COLUMNS, type StatementFacts, buildStatement, csvCell, parseDay, periodOf, statementCsv, statementFileName, utcStamp } from '../shared/src/statement.js';

const SOL = '11111111111111111111111111111111';
const TOKEN = 'Tok1111111111111111111111111111111111111111';
const BOB = 'Bob1111111111111111111111111111111111111111';
const DESK = 'Desk111111111111111111111111111111111111111';
const ALL = { from: null, to: null, label: 'All time' };
/** 2026-11-25 00:00:00 UTC. */
const DAY = Date.UTC(2026, 10, 25) / 1000;

function entry(signature: string, slot: bigint, input: Partial<HistoryRow> = {}): HistoryRow {
  return { signature, slot, index: 0n, kind: 'privateTransfer', direction: 'inbound', asset: SOL, amount: 1_500_000_000n, ...input };
}

function facts(extra: Partial<StatementFacts> = {}, times: Record<string, number | null> = {}): StatementFacts {
  return {
    // One slot a second from the start of the day, unless a test says otherwise.
    time: (slot) => (slot.toString() in times ? (times[slot.toString()] ?? null) : DAY + Number(slot)),
    label: (mint) => (mint === SOL ? { symbol: 'SOL', decimals: 9, native: true } : { symbol: '$GHO', decimals: 6 }),
    others: () => [],
    memo: () => undefined,
    ...extra,
  };
}

describe('a statement row', () => {
  it('says when, what, which way and how much', () => {
    const { rows } = buildStatement([entry('s1', 3_661n)], facts({ others: () => [BOB] }), ALL);
    expect(rows).toEqual([
      {
        at: DAY + 3_661,
        date: '2026-11-25 01:01:01',
        type: 'Private transfer',
        direction: 'In',
        symbol: 'SOL',
        mint: SOL,
        tokenAddress: '',
        amount: '1.5',
        change: '1.5',
        delta: 1_500_000_000n,
        decimals: 9,
        amountOnChain: 'Hidden',
        tradedFor: '',
        counterparty: BOB,
        note: '',
        signature: 's1',
        slot: '3661',
      },
    ]);
  });

  it('writes what left with a minus, and a move within the wallet as no change', () => {
    const { rows } = buildStatement(
      [
        entry('out', 1n, { direction: 'outbound', kind: 'publicWithdrawal', amount: 250_000n, asset: TOKEN }),
        entry('merge', 2n, { direction: 'selfTransfer', kind: 'merge', amount: 9_000_000_000n }),
      ],
      facts(),
      ALL,
    );
    expect(rows.map((row) => [row.type, row.direction, row.amount, row.change, row.amountOnChain])).toEqual([
      ['Unshield', 'Out', '0.25', '-0.25', 'Public'],
      ['Consolidation', 'Self', '9', '0', 'Hidden'],
    ]);
  });

  it('never rounds an amount', () => {
    const { rows } = buildStatement([entry('s', 1n, { amount: 1n }), entry('t', 2n, { amount: 123_456_789_012_345_678n })], facts(), ALL);
    expect(rows.map((row) => row.amount)).toEqual(['0.000000001', '123456789.012345678']);
  });

  it('pairs the two halves of a trade', () => {
    const { rows } = buildStatement(
      [entry('fill', 5n, { direction: 'outbound', amount: 2_000_000_000n }), entry('fill', 5n, { index: 1n, asset: TOKEN, amount: 40_000_000n })],
      facts({ others: () => [DESK] }),
      ALL,
    );
    expect(rows.map((row) => [row.symbol, row.change, row.tradedFor, row.counterparty])).toEqual([
      ['SOL', '-2', '$GHO', DESK],
      ['$GHO', '40', 'SOL', DESK],
    ]);
  });

  it('does not call two payments of one token a trade', () => {
    const { rows } = buildStatement([entry('x', 5n, { direction: 'outbound' }), entry('x', 5n, { index: 1n })], facts(), ALL);
    expect(rows.map((row) => row.tradedFor)).toEqual(['', '']);
  });

  it('shows the note and the destination this browser kept, and prefers what the chain names', () => {
    const memo = (signature: string) => (signature === 'paid' ? { to: 'KeptAddress', note: 'Invoice 12' } : signature === 'cashout' ? { to: 'Exchange' } : undefined);
    const { rows } = buildStatement(
      [entry('paid', 1n, { direction: 'outbound' }), entry('cashout', 2n, { direction: 'outbound', kind: 'publicWithdrawal' })],
      facts({ memo, others: (signature) => (signature === 'paid' ? [BOB] : []) }),
      ALL,
    );
    expect(rows.map((row) => [row.counterparty, row.note])).toEqual([
      [BOB, 'Invoice 12'],
      ['Exchange', ''],
    ]);
  });

  it('names a kind it does not know as the chain does', () => {
    expect(buildStatement([entry('s', 1n, { kind: 'somethingNew' })], facts(), ALL).rows[0]?.type).toBe('somethingNew');
  });
});

describe('a period', () => {
  const now = new Date(Date.UTC(2026, 10, 25, 7, 51));

  it('is a calendar month or year in UTC', () => {
    expect(periodOf('month', now)).toEqual({ from: Date.UTC(2026, 10, 1) / 1000, to: Date.UTC(2026, 11, 1) / 1000, label: '2026-11' });
    expect(periodOf('last-month', now)).toEqual({ from: Date.UTC(2026, 9, 1) / 1000, to: Date.UTC(2026, 10, 1) / 1000, label: '2026-10' });
    expect(periodOf('year', now)).toEqual({ from: Date.UTC(2026, 0, 1) / 1000, to: Date.UTC(2027, 0, 1) / 1000, label: '2026' });
    expect(periodOf('last-year', now)).toEqual({ from: Date.UTC(2025, 0, 1) / 1000, to: Date.UTC(2026, 0, 1) / 1000, label: '2025' });
    expect(periodOf('all', now)).toEqual({ from: null, to: null, label: 'All time' });
  });

  it('crosses a year end going back a month', () => {
    expect(periodOf('last-month', new Date(Date.UTC(2027, 0, 15)))).toEqual({ from: Date.UTC(2026, 11, 1) / 1000, to: Date.UTC(2027, 0, 1) / 1000, label: '2026-12' });
  });

  it('takes two days, both included, either left out', () => {
    expect(periodOf('custom', now, '2026-11-01', '2026-11-25')).toEqual({ from: Date.UTC(2026, 10, 1) / 1000, to: Date.UTC(2026, 10, 26) / 1000, label: '2026-11-01 to 2026-11-25' });
    expect(periodOf('custom', now, '2026-11-25', '2026-11-25')).toEqual({ from: DAY, to: DAY + 86_400, label: '2026-11-25 to 2026-11-25' });
    expect(periodOf('custom', now, '', '2026-11-25')?.from).toBeNull();
    expect(periodOf('custom', now, '2026-11-01', '')).toEqual({ from: Date.UTC(2026, 10, 1) / 1000, to: null, label: '2026-11-01 to now' });
    expect(periodOf('custom', now, '', '')?.label).toBe('All time');
  });

  it('refuses days that are not days, or the wrong way round', () => {
    expect(periodOf('custom', now, '2026-02-30', '')).toBeNull();
    expect(periodOf('custom', now, '25/11/2026', '')).toBeNull();
    expect(periodOf('custom', now, '2026-11-25', '2026-11-24')).toBeNull();
    expect(parseDay('2024-02-29')).toBe(Date.UTC(2024, 1, 29) / 1000);
    expect(parseDay('2026-13-01')).toBeNull();
  });

  it('keeps a row on its first second and drops it on the first second after', () => {
    const period = { from: DAY, to: DAY + 86_400, label: 'day' };
    const rows = [entry('before', 1n), entry('first', 2n), entry('last', 3n), entry('after', 4n)];
    const times = { '1': DAY - 1, '2': DAY, '3': DAY + 86_399, '4': DAY + 86_400 };
    expect(buildStatement(rows, facts({}, times), period).rows.map((row) => row.signature)).toEqual(['first', 'last']);
  });
});

describe('a statement', () => {
  it('runs oldest first, whatever order the history came in', () => {
    const { rows } = buildStatement([entry('c', 30n), entry('a', 10n), entry('b', 20n)], facts(), ALL);
    expect(rows.map((row) => row.signature)).toEqual(['a', 'b', 'c']);
  });

  it('keeps a row it could not date, says how many, and puts them first', () => {
    const period = { from: DAY, to: DAY + 86_400, label: 'day' };
    const statement = buildStatement([entry('dated', 10n), entry('undated', 99n), entry('outside', 5n)], facts({}, { '99': null, '5': DAY - 50 }), period);
    expect(statement.rows.map((row) => [row.signature, row.date])).toEqual([
      ['undated', ''],
      ['dated', '2026-11-25 00:00:10'],
    ]);
    expect(statement.undated).toBe(1);
  });

  it('adds up what came in and what left, for each token, and leaves moves within the wallet out', () => {
    const { totals } = buildStatement(
      [
        entry('a', 1n, { amount: 5_000_000_000n }),
        entry('b', 2n, { direction: 'outbound', amount: 1_250_000_000n }),
        entry('c', 3n, { direction: 'selfTransfer', kind: 'merge', amount: 3_750_000_000n }),
        entry('d', 4n, { asset: TOKEN, amount: 7n }),
      ],
      facts(),
      ALL,
    );
    expect(totals).toEqual([
      { mint: SOL, symbol: 'SOL', decimals: 9, received: 5_000_000_000n, sent: 1_250_000_000n, rows: 3 },
      { mint: TOKEN, symbol: '$GHO', decimals: 6, received: 7n, sent: 0n, rows: 1 },
    ]);
  });

  it('is empty for an empty history', () => {
    expect(buildStatement([], facts(), ALL)).toEqual({ rows: [], undated: 0, totals: [] });
  });
});

/** Reads one line of CSV the way a spreadsheet does. */
function cellsOf(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted) {
      if (character !== '"') current += character;
      else if (line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === ',') {
      cells.push(current);
      current = '';
    } else current += character;
  }
  cells.push(current);
  return cells;
}

describe('the CSV file', () => {
  it('has a header and one line a row, with CRLF', () => {
    const { rows } = buildStatement([entry('s1', 3_661n)], facts({ others: () => [BOB] }), ALL);
    const csv = statementCsv(rows);
    expect(csv).toBe(`${STATEMENT_COLUMNS.join(',')}\r\n2026-11-25 01:01:01,Private transfer,In,SOL,1.5,1.5,Hidden,,${BOB},,s1,3661,\r\n`);
  });

  it('gives a token its address, and SOL none: SOL is not a token', () => {
    const lines = statementCsv(buildStatement([entry('a', 1n), entry('b', 2n, { asset: TOKEN, amount: 5n })], facts(), ALL).rows).trimEnd().split('\r\n');
    expect(cellsOf(lines[1] ?? '').at(-1)).toBe('');
    expect(cellsOf(lines[2] ?? '').at(-1)).toBe(TOKEN);
  });

  it('keeps a minus on a number, and takes the sting out of text that looks like a formula', () => {
    const evil = { symbol: '=HYPERLINK("http://x","SOL")', decimals: 9 };
    const { rows } = buildStatement([entry('s1', 1n, { direction: 'outbound' })], facts({ label: () => evil, memo: () => ({ note: '+1 for you, "friend"' }) }), ALL);
    const line = statementCsv(rows).split('\r\n')[1] ?? '';
    expect(line).toContain(',-1.5,');
    expect(line).toContain(`"'=HYPERLINK(""http://x"",""SOL"")"`);
    expect(line).toContain(`"'+1 for you, ""friend"""`);
  });

  it('quotes a cell with a comma, a quote or a line break, and leaves the rest bare', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell('@cmd')).toBe("'@cmd");
    expect(csvCell('-5')).toBe("'-5");
    expect(csvCell('-5', false)).toBe('-5');
    expect(csvCell('\tx')).toBe("'\tx");
    expect(csvCell('')).toBe('');
  });

  it('gives every line as many cells as the header', () => {
    const rows = buildStatement([entry('a', 1n), entry('b', 2n, { direction: 'outbound', kind: 'publicWithdrawal' })], facts({ memo: () => ({ note: 'a, b' }) }), ALL).rows;
    const lines = statementCsv(rows).trimEnd().split('\r\n');
    const parsed = lines.map(cellsOf);
    expect(parsed.map((cells) => cells.length)).toEqual([STATEMENT_COLUMNS.length, STATEMENT_COLUMNS.length, STATEMENT_COLUMNS.length]);
    expect(parsed[0]).toEqual([...STATEMENT_COLUMNS]);
    // What a spreadsheet reads back is what was written.
    expect(parsed[1]?.[9]).toBe('a, b');
    expect(parsed[2]?.[1]).toBe('Unshield');
  });

  it('names its file with nothing a file system minds', () => {
    expect(statementFileName('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', { from: 1, to: 2, label: '2026-11-01 to 2026-11-25' })).toBe('privacycash-statement-7xKXtg2C-2026-11-01-to-2026-11-25.csv');
    expect(statementFileName('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', { from: null, to: null, label: 'All time' })).toBe('privacycash-statement-7xKXtg2C-all-time.csv');
  });
});

describe('a time stamp', () => {
  it('is written in UTC', () => {
    expect(utcStamp(0)).toBe('1970-01-01 00:00:00');
    expect(utcStamp(Date.UTC(2026, 11, 31, 23, 59, 59) / 1000)).toBe('2026-12-31 23:59:59');
  });
});
