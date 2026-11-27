import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';

import {
  PAY_MANY_MAX,
  PAY_MANY_MAX_CHARS,
  PayRunError,
  type PayRun,
  markFailed,
  markPaid,
  markSent,
  newRun,
  nextTodo,
  parsePayList,
  parseRun,
  receiptCsv,
  receiptFileName,
  retryFailed,
  runFinished,
  runTotals,
  sameProgress,
  unsettled,
} from '../shared/src/paymany.js';

const fresh = (): string => Keypair.generate().publicKey.toBase58();
const ME = fresh();
const A = fresh();
const B = fresh();
const C = fresh();
const SOL = 'So11111111111111111111111111111111111111112';
const SIG = '5'.repeat(88);
const SIG2 = '4'.repeat(87);
const NOW = 1_800_000_000_000;

describe('reading a pasted list', () => {
  it('reads one payment per line, whatever separates the parts', () => {
    const list = parsePayList(`${A}, 1.5\n${B};2;rent for March\n${C}\t0.000000001\tsmallest\n${A} 3 a note in words`, 9, ME);
    expect(list.problems).toEqual([]);
    expect(list.entries).toEqual([
      { line: 1, to: A, units: 1_500_000_000n, note: '' },
      { line: 2, to: B, units: 2_000_000_000n, note: 'rent for March' },
      { line: 3, to: C, units: 1n, note: 'smallest' },
      { line: 4, to: A, units: 3_000_000_000n, note: 'a note in words' },
    ]);
    expect(list.total).toBe(6_500_000_001n);
    expect(list.repeated).toEqual([A]);
  });

  it('skips empty lines, comments, one heading line and a byte-order mark, and keeps the line numbers of the file', () => {
    const list = parsePayList(`﻿address,amount,note\r\n\r\n# the team\r\n${A},1\r\n   \r\n${B},2,ok\r\n`, 6, ME);
    expect(list.problems).toEqual([]);
    expect(list.entries.map((entry) => [entry.line, entry.to, entry.units])).toEqual([
      [4, A, 1_000_000n],
      [6, B, 2_000_000n],
    ]);
    // A heading is skipped only where a heading can be: on the first line.
    expect(parsePayList(`${A},1\nwallet,amount`, 6, ME).problems).toHaveLength(1);
  });

  it('turns every line it cannot stand behind into a problem, and pays none of them', () => {
    const lines = [
      'not-an-address, 1',
      `${ME}, 1`,
      `${A}`,
      `${A}, 0`,
      `${A}, 0.0000001`,
      `${A}, 1e3`,
      `${A}, -1`,
      `${A}, abc`,
      `${A}, 1, ${'x'.repeat(141)}`,
    ];
    const list = parsePayList(lines.join('\n'), 6, ME);
    expect(list.entries).toEqual([]);
    expect(list.problems.map((problem) => problem.line)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(list.problems[0]?.problem).toContain('does not start with a Solana address');
    expect(list.problems[1]?.problem).toBe('This is the wallet you are paying from.');
    expect(list.problems[2]?.problem).toBe('There is no amount after the address.');
    expect(list.problems[3]?.problem).toBe('The amount is zero.');
    expect(list.problems[4]?.problem).toContain('At most 6 decimal places');
    expect(list.problems[8]?.problem).toContain('longer than 140 characters');
    expect(list.total).toBe(0n);
  });

  it('never reads a number written with a comma or a space as a smaller number with a note', () => {
    // Each of these would otherwise pay 1 where 1,000 or 1.5 was meant.
    for (const line of [`${A}, 1,000`, `${A}, 1,000, rent`, `${A}, 1,5`, `${A} 1 000`, `${A} 1 000 rent`, `${A}\t1\t000`, `${A}; 1; 5`, `${A}, 1,000.50`, `${A} 1,000`, `${A} 1,000 rent`, `${A} 1 000,5`, `${A} , 1 , 000`]) {
      const list = parsePayList(line, 6, ME);
      expect(list.entries, line).toEqual([]);
      expect(list.problems[0]?.problem, line).toContain('looks like the rest of a number');
    }
    // An amount that is itself malformed is caught as an amount.
    for (const line of [`${A} 1.000.5`, `${A}, 1_000`, `${A}, $5`, `${A}, 1.`, `${A}, .5`]) {
      const list = parsePayList(line, 6, ME);
      expect(list.entries, line).toEqual([]);
      expect(list.problems[0]?.problem, line).toContain('The amount cannot be read');
    }
    // An empty part is not skipped over: the amount is the second part of the line, or the line is not read.
    expect(parsePayList(`${A},,5`, 6, ME).problems[0]?.problem).toBe('There is no amount after the address.');
    expect(parsePayList(`,${A},5`, 6, ME).problems[0]?.problem).toContain('does not start with a Solana address');
    // A note keeps its own commas.
    expect(parsePayList(`${A}, 2.5, rent, March and April`, 6, ME).entries[0]).toMatchObject({ units: 2_500_000n, note: 'rent, March and April' });
    // A note that starts with a word is a note, digits and all.
    expect(parsePayList(`${A}, 5, invoice 1042`, 6, ME).entries[0]).toMatchObject({ units: 5_000_000n, note: 'invoice 1042' });
  });

  it('cleans a note the way a payment link’s note is cleaned', () => {
    const list = parsePayList(`${A}, 1, two‮words\u0007  here`, 6, ME);
    expect(list.entries[0]?.note).toBe('twowords here');
  });

  it('pays at most twenty-five wallets a run, and says which lines are over', () => {
    const lines = Array.from({ length: PAY_MANY_MAX + 2 }, () => `${fresh()}, 1`);
    const list = parsePayList(lines.join('\n'), 6, ME);
    expect(list.entries).toHaveLength(PAY_MANY_MAX);
    expect(list.problems.map((problem) => problem.line)).toEqual([PAY_MANY_MAX + 1, PAY_MANY_MAX + 2]);
    expect(list.problems[0]?.problem).toContain('at most 25 wallets');
    expect(list.total).toBe(BigInt(PAY_MANY_MAX) * 1_000_000n);
    const huge = parsePayList('x'.repeat(PAY_MANY_MAX_CHARS + 1), 6, ME);
    expect(huge.entries).toEqual([]);
    expect(huge.problems[0]?.problem).toContain('too long to read');
  });
});

function runOf(count = 3, leftOut?: ReadonlyMap<number, string>): PayRun {
  const to = [A, B, C, fresh(), fresh()].slice(0, count);
  return newRun({
    id: 'abcdef012345',
    wallet: ME,
    mint: SOL,
    symbol: 'SOL',
    decimals: 9,
    now: NOW,
    entries: to.map((address, index) => ({ line: index + 1, to: address, units: BigInt(index + 1) * 1_000_000_000n, note: index === 1 ? 'second' : '' })),
    ...(leftOut ? { leftOut } : {}),
  });
}

describe('a run', () => {
  it('starts with everything to pay, except what cannot be paid privately', () => {
    const run = runOf(3, new Map([[2, 'Not registered.']]));
    expect(run.items.map((item) => item.state)).toEqual(['todo', 'todo', 'left']);
    expect(run.items[2]).toMatchObject({ reason: 'Not registered.', units: '3000000000' });
    expect(nextTodo(run)).toBe(0);
    expect(unsettled(run)).toEqual([]);
    expect(runFinished(run)).toBe(false);
    expect(() => newRun({ id: 'abcdef', wallet: ME, mint: SOL, symbol: 'SOL', decimals: 9, now: NOW, entries: [] })).toThrow(PayRunError);
  });

  it('lets a payment be sent once, and only once', () => {
    const sent = markSent(runOf(), 0, SIG, 500n, NOW + 1);
    expect(sent.items[0]).toEqual({ to: A, units: '1000000000', note: '', state: 'sent', signature: SIG, lastValid: '500', at: NOW + 1 });
    expect(unsettled(sent)).toEqual([0]);
    expect(nextTodo(sent)).toBe(1);
    expect(() => markSent(sent, 0, SIG2, 600n, NOW + 2)).toThrow('It is not sent again');
    const paid = markPaid(sent, 0, NOW + 3);
    expect(() => markSent(paid, 0, SIG2, 600n, NOW + 4)).toThrow('It is not sent again');
    expect(() => markSent(runOf(), 0, '', 500n, NOW)).toThrow(PayRunError);
    expect(() => markSent(runOf(), 0, SIG, 0n, NOW)).toThrow(PayRunError);
    expect(() => markSent(runOf(), 9, SIG, 500n, NOW)).toThrow('no such payment');
  });

  it('calls a payment paid only after it was sent, and failed only while it is not settled', () => {
    const run = runOf();
    expect(() => markPaid(run, 0, NOW)).toThrow(PayRunError);
    const sent = markSent(run, 0, SIG, 500n, NOW);
    const paid = markPaid(sent, 0, NOW + 5);
    expect(paid.items[0]).toMatchObject({ state: 'paid', signature: SIG, at: NOW + 5 });
    expect(() => markFailed(paid, 0, 'no')).toThrow(PayRunError);
    const failed = markFailed(sent, 0, 'The chain rejected it. Nothing moved.');
    expect(failed.items[0]).toMatchObject({ state: 'failed', signature: SIG, reason: 'The chain rejected it. Nothing moved.' });
    expect(markFailed(run, 1, 'Refused before it was sent.').items[1]).toMatchObject({ state: 'failed', reason: 'Refused before it was sent.' });
  });

  it('puts what did not happen back in line, and nothing else', () => {
    let run = runOf(4, new Map([[3, 'Not registered.']]));
    run = markPaid(markSent(run, 0, SIG, 500n, NOW), 0, NOW);
    run = markFailed(markSent(run, 1, SIG2, 600n, NOW), 1, 'expired');
    run = markSent(run, 2, SIG, 700n, NOW);
    const again = retryFailed(run);
    expect(again.items.map((item) => item.state)).toEqual(['paid', 'todo', 'sent', 'left']);
    expect(again.items[1]).toEqual({ to: B, units: '2000000000', note: 'second', state: 'todo' }); // the dead signature is gone
    expect(again.items[0]?.signature).toBe(SIG);
  });

  it('adds up what was paid and what was not', () => {
    let run = runOf(5, new Map([[4, 'Not registered.']]));
    run = markPaid(markSent(run, 0, SIG, 500n, NOW), 0, NOW);
    run = markFailed(markSent(run, 1, SIG2, 500n, NOW), 1, 'rejected');
    run = markSent(run, 2, SIG, 500n, NOW);
    const totals = runTotals(run);
    expect(totals.count).toEqual({ paid: 1, failed: 1, sent: 1, todo: 1, left: 1 });
    expect(totals.units).toEqual({ paid: 1_000_000_000n, failed: 2_000_000_000n, sent: 3_000_000_000n, todo: 4_000_000_000n, left: 5_000_000_000n });
    expect(runFinished(run)).toBe(false);
    const done = markPaid(markSent(markPaid(run, 2, NOW), 3, SIG2, 500n, NOW), 3, NOW);
    expect(runFinished(done)).toBe(true); // a failed line does not keep a run open; it can be tried again
  });
});

describe('two copies of a run', () => {
  it('stand at the same point only when every line is in the same state under the same signature', () => {
    const run = runOf();
    const sent = markSent(run, 0, SIG, 500n, NOW);
    const paid = markPaid(sent, 0, NOW + 9);
    expect(sameProgress(run, runOf())).toBe(true); // made again from the same list: the same point
    const first = run.items[0] as PayRun['items'][number];
    expect(sameProgress(run, { ...run, items: [{ ...first, to: fresh() }, ...run.items.slice(1)] })).toBe(false); // another wallet on a line
    expect(sameProgress(run, { ...run, items: [{ ...first, units: '7' }, ...run.items.slice(1)] })).toBe(false); // another amount
    expect(sameProgress(run, { ...run })).toBe(true);
    expect(sameProgress(run, sent)).toBe(false);
    expect(sameProgress(sent, paid)).toBe(false);
    // The record read back from storage is the same point as the copy that wrote it, whatever was tidied on the way.
    expect(sameProgress(paid, parseRun(JSON.stringify(paid), ME) as PayRun)).toBe(true);
    expect(sameProgress(sent, parseRun(JSON.stringify(sent), ME) as PayRun)).toBe(true);
    // The same line sent again under another signature is not the same point.
    expect(sameProgress(sent, markSent(run, 0, SIG2, 500n, NOW))).toBe(false);
    expect(sameProgress(run, { ...run, id: 'another0run' })).toBe(false);
    expect(sameProgress(run, { ...run, items: run.items.slice(0, 2) })).toBe(false);
  });
});

describe('the receipt', () => {
  it('has one row per line of the list, paid or not, and never calls an unconfirmed payment paid', () => {
    let run = runOf(4, new Map([[3, 'This wallet has not registered with Rings.']]));
    run = markPaid(markSent(run, 0, SIG, 500n, NOW), 0, NOW + 61_000);
    run = markFailed(markSent(run, 1, SIG2, 500n, NOW), 1, 'The chain rejected it. Nothing moved.');
    run = markSent(run, 2, SIG, 500n, NOW + 5_000);
    const rows = receiptCsv(run, SOL).split('\r\n');
    expect(rows[0]).toBe('#,Recipient,Amount,Token,Status,Transaction,Date (UTC),Note,Why not paid,Token address');
    expect(rows[1]).toBe(`1,${A},1,SOL,Paid,${SIG},2027-01-15 08:01:01,,,`);
    expect(rows[2]).toBe(`2,${B},2,SOL,Not paid,${SIG2},,second,The chain rejected it. Nothing moved.,`);
    expect(rows[3]).toBe(`3,${C},3,SOL,"Sent, NOT CONFIRMED: check the transaction",${SIG},2027-01-15 08:00:05,,,`);
    expect(rows[4]).toContain(',Left out,,,,This wallet has not registered with Rings.,');
    expect(rows[5]).toBe('');
    expect(rows).toHaveLength(6);
  });

  it('writes a token’s address, and keeps a note from being run as a formula', () => {
    const mint = fresh();
    const run = newRun({ id: 'abcdef', wallet: ME, mint, symbol: '$COIN', decimals: 6, now: NOW, entries: [{ line: 1, to: A, units: 1_250_500_000n, note: '=HYPERLINK("x"), two' }] });
    const row = receiptCsv(run, SOL).split('\r\n')[1] ?? '';
    expect(row).toBe(`1,${A},1250.5,$COIN,To pay,,,"'=HYPERLINK(""x""), two",,${mint}`);
  });

  it('is named after the day, the wallet and the run', () => {
    expect(receiptFileName(runOf())).toBe(`privacycash-payout-2027-01-15-${ME.slice(0, 4)}-abcdef.csv`);
  });
});

describe('a run kept in the browser', () => {
  it('reads back exactly as it was written', () => {
    let run = runOf(4, new Map([[3, 'Not registered.']]));
    run = markPaid(markSent(run, 0, SIG, 500n, NOW), 0, NOW + 1);
    run = markFailed(markSent(run, 1, SIG2, 600n, NOW), 1, 'expired');
    run = markSent(run, 2, SIG, 700n, NOW + 2);
    const back = parseRun(JSON.stringify(run), ME);
    expect(back?.items.map((item) => item.state)).toEqual(['paid', 'failed', 'sent', 'left']);
    expect(back?.items[0]).toEqual({ to: A, units: '1000000000', note: '', state: 'paid', signature: SIG, at: NOW + 1 });
    expect(back?.items[2]).toEqual({ to: C, units: '3000000000', note: '', state: 'sent', signature: SIG, lastValid: '700', at: NOW + 2 });
    expect(back?.items[1]).toMatchObject({ state: 'failed', signature: SIG2, reason: 'expired' });
    expect(back?.items[3]).toEqual({ to: run.items[3]?.to, units: '4000000000', note: '', state: 'left', reason: 'Not registered.' });
    expect(parseRun(JSON.stringify(back), ME)).toEqual(back);
  });

  it('is not used at all when any of it does not read cleanly, or it belongs to another wallet', () => {
    const run = markSent(runOf(), 0, SIG, 500n, NOW);
    const text = JSON.stringify(run);
    expect(parseRun(text, ME)).not.toBeNull();
    expect(parseRun(text, A)).toBeNull();
    expect(parseRun(null, ME)).toBeNull();
    expect(parseRun('', ME)).toBeNull();
    expect(parseRun('{', ME)).toBeNull();
    expect(parseRun('[]', ME)).toBeNull();
    const broken = (change: (copy: Record<string, unknown> & { items: Array<Record<string, unknown>> }) => void): PayRun | null => {
      const copy = JSON.parse(text) as Record<string, unknown> & { items: Array<Record<string, unknown>> };
      change(copy);
      return parseRun(JSON.stringify(copy), ME);
    };
    expect(broken((copy) => void (copy.v = 2))).toBeNull();
    expect(broken((copy) => void (copy.decimals = 1.5))).toBeNull();
    expect(broken((copy) => void (copy.items = []))).toBeNull();
    expect(broken((copy) => void ((copy.items[1] as Record<string, unknown>).units = '-5'))).toBeNull();
    expect(broken((copy) => void ((copy.items[1] as Record<string, unknown>).to = 'x'))).toBeNull();
    expect(broken((copy) => void ((copy.items[1] as Record<string, unknown>).state = 'done'))).toBeNull();
    // A payment on record as sent or paid has to come with its signature: half a record is not acted on.
    expect(broken((copy) => void delete (copy.items[0] as Record<string, unknown>).signature)).toBeNull();
    expect(broken((copy) => void delete (copy.items[0] as Record<string, unknown>).lastValid)).toBeNull();
    expect(broken((copy) => void ((copy.items[1] as Record<string, unknown>).state = 'paid'))).toBeNull();
  });
});
