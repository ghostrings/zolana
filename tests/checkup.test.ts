import { describe, expect, it } from 'vitest';

import { CHECKUP_WINDOW_MS, checkup, partOf } from '../shared/src/checkup.js';
import type { RingKind, RingLeg, RingRow } from '../shared/src/rings-api.js';

const ME = 'Me11111111111111111111111111111111111111111';
const BOB = 'Bob1111111111111111111111111111111111111111';
const DESK = 'Desk111111111111111111111111111111111111111';
const SOL = '11111111111111111111111111111111';
const TOKEN = 'Tok1111111111111111111111111111111111111111';
const MINUTE = 60_000;
const T0 = 1_764_000_000_000;

let counter = 0;
function row(kind: RingKind, minute: number, input: { senders?: string[]; recipients?: string[]; legs?: RingLeg[]; payer?: string } = {}): RingRow {
  counter += 1;
  const senders = input.senders ?? [ME];
  return {
    signature: `sig${String(counter).padStart(4, '0')}`,
    slot: 1_000 + minute,
    at: T0 + minute * MINUTE,
    kind,
    payer: input.payer ?? senders[0] ?? ME,
    senders,
    recipients: input.recipients ?? [],
    legs: input.legs ?? [],
    via: [],
    ring: null,
  };
}
const leg = (dir: 'in' | 'out', amount: string, mint = SOL): RingLeg => ({ mint, amount, dir });

describe('what a row was to one wallet', () => {
  it('tells its own shield from a payment into another wallet, and from one made to it', () => {
    expect(partOf(row('shield', 0), ME)).toBe('shield');
    expect(partOf(row('shield', 0, { recipients: [BOB] }), ME)).toBe('shield-to-other');
    expect(partOf(row('shield', 0, { senders: [BOB], recipients: [ME] }), ME)).toBe('shield-from-other');
    expect(partOf(row('shield', 0, { senders: [BOB] }), ME)).toBe('none');
  });

  it('tells its own unshield from one that paid its public address', () => {
    expect(partOf(row('unshield', 0), ME)).toBe('unshield');
    expect(partOf(row('unshield', 0, { recipients: [BOB] }), ME)).toBe('unshield');
    expect(partOf(row('unshield', 0, { senders: [BOB], recipients: [ME] }), ME)).toBe('unshield-from-other');
  });

  it('reads private transfers by side, and a two-way one as both', () => {
    expect(partOf(row('transfer', 0, { recipients: [BOB] }), ME)).toBe('private-out');
    expect(partOf(row('transfer', 0, { senders: [BOB], recipients: [ME] }), ME)).toBe('private-in');
    expect(partOf(row('swap', 0, { senders: [ME, DESK] }), ME)).toBe('private-both');
    // The receiving side was not read yet: that this wallet sent is already known.
    expect(partOf(row('private', 0), ME)).toBe('private-out');
    expect(partOf(row('private', 0, { senders: [BOB] }), ME)).toBe('none');
  });

  it('counts nothing for a row the wallet only paid the fee of, or that is no movement', () => {
    expect(partOf(row('transfer', 0, { senders: [BOB], recipients: [DESK], payer: ME }), ME)).toBe('none');
    expect(partOf(row('token', 0), ME)).toBe('none');
    expect(partOf(row('upkeep', 0), ME)).toBe('none');
    expect(partOf(row('self', 0), ME)).toBe('own');
    expect(partOf(row('trade', 0), ME)).toBe('trade');
  });
});

describe('a balance anyone can add up', () => {
  it('is reported when every move of the private balance had a public amount', () => {
    const result = checkup([row('shield', 0, { legs: [leg('in', '5000000000')] }), row('unshield', 60, { legs: [leg('out', '2000000000')] })], ME);
    expect(result.openBalance).toBe(true);
    expect(result.publicMoves).toBe(2);
    expect(result.hiddenMoves).toBe(0);
    expect(result.flows).toEqual([{ mint: SOL, shielded: 5_000_000_000n, unshielded: 2_000_000_000n }]);
  });

  it('is not reported once a private transfer has gone in or out', () => {
    const rows = [row('shield', 0, { legs: [leg('in', '5000000000')] }), row('transfer', 600, { recipients: [BOB] })];
    expect(checkup(rows, ME).openBalance).toBe(false);
    expect(checkup(rows, ME).hiddenMoves).toBe(1);
  });

  it('is not reported for a wallet with no activity at all', () => {
    expect(checkup([], ME).openBalance).toBe(false);
    expect(checkup([row('transfer', 0, { senders: [BOB], recipients: [DESK] })], ME).openBalance).toBe(false);
  });
});

describe('amounts an onlooker could guess', () => {
  it('ties a private transfer to the shield made just before it', () => {
    const shield = row('shield', 0, { legs: [leg('in', '5000000000')] });
    const send = row('transfer', 3, { recipients: [BOB] });
    const result = checkup([send, shield], ME);
    expect(result.pairs).toEqual([{ kind: 'in-then-sent', publicSignature: shield.signature, hiddenSignature: send.signature, legs: [leg('in', '5000000000')], gapMs: 3 * MINUTE, at: send.at }]);
  });

  it('ties an unshield to the private transfer received just before it', () => {
    const received = row('transfer', 0, { senders: [BOB], recipients: [ME] });
    const out = row('unshield', 5, { legs: [leg('out', '700000000')] });
    const result = checkup([received, out], ME);
    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0]).toMatchObject({ kind: 'received-then-out', publicSignature: out.signature, hiddenSignature: received.signature, gapMs: 5 * MINUTE });
    expect(result.pairs[0]?.legs).toEqual([leg('out', '700000000')]);
  });

  it('sees a trade as a public amount on both sides', () => {
    const bought = row('trade', 0, { legs: [leg('out', '1000000000'), leg('in', '250000000', TOKEN)] });
    const sent = row('transfer', 2, { recipients: [BOB] });
    const got = row('transfer', 30, { senders: [BOB], recipients: [ME] });
    const sold = row('trade', 31, { legs: [leg('out', '90000000', TOKEN), leg('in', '400000000')] });
    const result = checkup([bought, sent, got, sold], ME);
    expect(result.pairs.map((pair) => [pair.kind, pair.legs])).toEqual([
      ['received-then-out', [leg('out', '90000000', TOKEN)]],
      ['in-then-sent', [leg('in', '250000000', TOKEN)]],
    ]);
  });

  it('counts a private exchange as a move out and a move in', () => {
    const shield = row('shield', 0, { legs: [leg('in', '1000000000')] });
    const fill = row('swap', 1, { senders: [ME, DESK] });
    const out = row('unshield', 2, { legs: [leg('out', '5000000', TOKEN)] });
    expect(checkup([shield, fill, out], ME).pairs.map((pair) => pair.kind)).toEqual(['received-then-out', 'in-then-sent']);
  });

  it('leaves moves alone that are further apart than the window', () => {
    const shield = row('shield', 0, { legs: [leg('in', '5000000000')] });
    const send = row('transfer', CHECKUP_WINDOW_MS / MINUTE + 1, { recipients: [BOB] });
    expect(checkup([shield, send], ME).pairs).toEqual([]);
    expect(checkup([shield, row('transfer', CHECKUP_WINDOW_MS / MINUTE, { recipients: [BOB] })], ME).pairs).toHaveLength(1);
  });

  it('leaves moves alone when another move of the balance came between them', () => {
    const shield = row('shield', 0, { legs: [leg('in', '5000000000')] });
    const between = row('transfer', 1, { senders: [BOB], recipients: [ME] });
    const send = row('transfer', 2, { recipients: [BOB] });
    // The shield is followed by an incoming transfer, which is no pattern; the send follows that.
    expect(checkup([shield, between, send], ME).pairs).toEqual([]);
  });

  it('does not let rows that leave the private balance alone come between two moves', () => {
    const shield = row('shield', 0, { legs: [leg('in', '5000000000')] });
    const consolidation = row('self', 1);
    const paidInPublic = row('unshield', 1, { senders: [BOB], recipients: [ME], legs: [leg('out', '1')] });
    const send = row('transfer', 2, { recipients: [BOB] });
    expect(checkup([shield, consolidation, paidInPublic, send], ME).pairs).toHaveLength(1);
  });

  it('counts a row once however often it is handed in', () => {
    const shield = row('shield', 0, { legs: [leg('in', '5000000000')] });
    const send = row('transfer', 3, { recipients: [BOB] });
    const result = checkup([shield, send, shield, send], ME);
    expect(result.rows).toBe(2);
    expect(result.pairs).toHaveLength(1);
    expect(result.flows).toEqual([{ mint: SOL, shielded: 5_000_000_000n, unshielded: 0n }]);
  });
});

describe('payments in the open', () => {
  it('counts unshields to another address and shields into another wallet', () => {
    const rows = [
      row('unshield', 0, { recipients: [BOB], legs: [leg('out', '100')] }),
      row('unshield', 1, { legs: [leg('out', '100')] }),
      row('shield', 2, { recipients: [BOB], legs: [leg('in', '100')] }),
    ];
    const result = checkup(rows, ME);
    expect(result.publicPayments).toBe(2);
    // A shield into somebody else's balance is not a move of this wallet's own private balance.
    expect(result.flows).toEqual([{ mint: SOL, shielded: 0n, unshielded: 200n }]);
    expect(result.publicMoves).toBe(2);
  });
});
