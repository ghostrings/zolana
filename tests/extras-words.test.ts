import { describe, expect, it } from 'vitest';

import { checkup } from '../shared/src/checkup.js';
import { WSOL_MINT } from '../shared/src/constants.js';
import type { RingCounterparty, RingKind, RingLabels, RingLeg, RingRow } from '../shared/src/rings-api.js';
import { arrivalLines, arrivalText, systemText } from '../web/src/alert-words.js';
import { checkupCards, coverageText, gapText } from '../web/src/checkup-words.js';

const ME = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const BOB = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const TOKEN = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const LABELS: RingLabels = { [TOKEN]: { symbol: 'USDC', decimals: 6, listed: false } };
const T0 = Date.UTC(2026, 10, 25, 7, 0);
const MINUTE = 60_000;

let made = 0;
function row(kind: RingKind, minute: number, input: { senders?: string[]; recipients?: string[]; legs?: RingLeg[] } = {}): RingRow {
  made += 1;
  return { signature: `sig${made}`, slot: 1_000 + minute, at: T0 + minute * MINUTE, kind, payer: ME, senders: input.senders ?? [ME], recipients: input.recipients ?? [], legs: input.legs ?? [], via: [], ring: null };
}
const leg = (dir: 'in' | 'out', amount: string, mint = WSOL_MINT): RingLeg => ({ mint, amount, dir });
const text = (html: string): string => html.replace(/<[^>]+>/g, '');
const cardsOf = (rows: RingRow[], counterparties: RingCounterparty[] = []) => checkupCards(checkup(rows, ME), { counterparties, labels: LABELS });

describe('the check-up in words', () => {
  it('says a balance can be added up, and what would change that', () => {
    const cards = cardsOf([row('shield', 0, { legs: [leg('in', '5000000000')] })]);
    expect(cards[0]?.level).toBe('warn');
    expect(cards[0]?.title).toBe('Your private balance can be added up');
    expect(text(cards[0]?.html ?? '')).toMatch(/A private transfer, in or out, is what leaves an onlooker unsure/);
  });

  it('names the amount, the gap and both transactions of a transfer that followed a shield', () => {
    const shield = row('shield', 0, { legs: [leg('in', '5000000000')] });
    const send = row('transfer', 3, { recipients: [BOB] });
    const card = cardsOf([shield, send]).find((entry) => entry.title.includes('left right after'));
    expect(card?.level).toBe('warn');
    expect(card?.title).toBe('A private transfer left right after a public amount came in');
    const words = text(card?.html ?? '');
    expect(words).toContain('5 SOL came into your private balance');
    expect(words).toContain('3 minutes later');
    expect(words).toContain('an onlooker can guess');
    expect(card?.html).toContain(`/tx/${shield.signature}`);
    expect(card?.html).toContain(`/tx/${send.signature}`);
  });

  it('counts them, and shows the latest, when there are several', () => {
    const rows = [
      row('shield', 0, { legs: [leg('in', '1000000000')] }),
      row('transfer', 1, { recipients: [BOB] }),
      row('shield', 100, { legs: [leg('in', '2500000', TOKEN)] }),
      row('transfer', 104, { recipients: [BOB] }),
    ];
    const card = cardsOf(rows).find((entry) => entry.title.includes('left right after'));
    expect(card?.title).toBe('2 private transfers left right after a public amount came in');
    expect(text(card?.html ?? '')).toMatch(/^The latest: 2\.5 USDC came into your private balance/);
  });

  it('says the same of an unshield that followed a payment', () => {
    const card = cardsOf([row('transfer', 0, { senders: [BOB], recipients: [ME] }), row('unshield', 5, { legs: [leg('out', '700000000')] })]).find((entry) => entry.title.includes('came in'));
    expect(card?.title).toBe('A public amount left right after a private transfer came in');
    expect(text(card?.html ?? '')).toContain('0.7 SOL left your private balance in public 5 minutes later');
  });

  it('never states a guess as a fact', () => {
    const rows = [row('shield', 0, { legs: [leg('in', '5000000000')] }), row('transfer', 3, { recipients: [BOB] }), row('transfer', 30, { senders: [BOB], recipients: [ME] }), row('unshield', 31, { legs: [leg('out', '1')] })];
    for (const card of cardsOf(rows)) {
      const words = text(card.html).toLowerCase();
      expect(words, card.title).not.toMatch(/\b(you sent|you were paid|was exactly|carried exactly|proves|reveals that)\b/);
      if (card.level === 'warn' && card.title !== 'Your private balance can be added up') expect(words, card.title).toMatch(/can guess/);
    }
  });

  it('says so when nothing gives an amount away', () => {
    const rows = [row('shield', 0, { legs: [leg('in', '5000000000')] }), row('transfer', 600, { recipients: [BOB] })];
    const cards = cardsOf(rows, [{ address: BOB, sent: 1, received: 0, last: T0 }]);
    expect(cards[0]).toMatchObject({ level: 'ok', title: 'Nothing here gives a hidden amount away' });
    expect(cards.some((card) => card.level === 'warn')).toBe(false);
  });

  it('does not call an empty history clean', () => {
    const cards = cardsOf([]);
    expect(cards.map((card) => card.level)).toEqual(['fact']);
  });

  it('points out payments that went out in the open', () => {
    const card = cardsOf([row('unshield', 0, { recipients: [BOB], legs: [leg('out', '100')] }), row('transfer', 900, { recipients: [BOB] })]).find((entry) => entry.level === 'note');
    expect(card?.title).toBe('1 payment went out in the open');
    expect(text(card?.html ?? '')).toMatch(/shows both wallets and the amount/);
  });

  it('lists the wallets linked to this one, as links to their public page', () => {
    const many = Array.from({ length: 8 }, (_unused, index): RingCounterparty => ({ address: index === 0 ? BOB : `${BOB.slice(0, 40)}${String(index).padStart(4, 'A')}`, sent: 1, received: 0, last: T0 }));
    const card = cardsOf([row('transfer', 0, { recipients: [BOB] })], many).at(-1);
    expect(card).toMatchObject({ level: 'fact', title: '8 wallets are linked to yours in public' });
    expect(card?.html).toContain(`href="/rings?address=${BOB}"`);
    expect(text(card?.html ?? '')).toMatch(/and 2 more\.$/);
    expect(cardsOf([], []).at(-1)?.title).toBe('No wallet is linked to yours by a private transfer');
    expect(cardsOf([row('transfer', 0, { recipients: [BOB] })], [many[0] as RingCounterparty]).at(-1)?.title).toBe('1 wallet is linked to yours in public');
  });

  it('escapes whatever a token calls itself', () => {
    const evil: RingLabels = { [TOKEN]: { symbol: '<img src=x onerror=alert(1)>', decimals: 6, listed: false } };
    const rows = [row('shield', 0, { legs: [leg('in', '1000000', TOKEN)] }), row('transfer', 1, { recipients: [BOB] })];
    const html = checkupCards(checkup(rows, ME), { counterparties: [], labels: evil })
      .map((card) => card.html)
      .join('');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('says how much it looked at', () => {
    const one = checkup([row('shield', 0, { legs: [leg('in', '1')] })], ME);
    expect(coverageText(one, { more: false, since: T0, complete: true, address: ME })).toBe('Looked at the 1 public transaction this site has read for this wallet. It has read Rings back to 2026-11-25 07:00 UTC. Anything older is not in this check-up.');
    const two = checkup([row('shield', 0, { legs: [leg('in', '1')] }), row('shield', 1, { legs: [leg('in', '1')] })], ME);
    expect(coverageText(two, { more: true, since: T0, complete: false, address: ME })).toMatch(/^Looked at the latest 2 public transactions .* and is still reading further back\. Anything older/);
    expect(coverageText(two, { more: false, since: null, complete: false, address: ME })).toBe('Looked at all 2 public transactions this site has read for this wallet. Anything older is not in this check-up.');
    expect(coverageText(checkup([], ME), { more: false, since: T0, complete: true, address: ME })).toMatch(/^This site has read no Rings activity for 7xKX…gAsU since 2026-11-25 07:00 UTC\./);
  });

  it('writes a gap in minutes', () => {
    expect(gapText(20_000)).toBe('less than a minute');
    expect(gapText(60_000)).toBe('1 minute');
    expect(gapText(14 * MINUTE + 40_000)).toBe('15 minutes');
  });
});

describe('an arrival in words', () => {
  const SOL = { symbol: 'SOL', decimals: 9 };

  it('names what arrived and how much', () => {
    expect(arrivalText({ kind: 'privateTransfer', asset: 'x', amount: 1_500_000_000n }, SOL)).toBe('Private payment received: 1.5 SOL.');
    expect(arrivalText({ kind: 'deposit', asset: 'x', amount: 12_345_000_000_000n }, SOL)).toBe('Shielded into your wallet: 12,345 SOL.');
    expect(arrivalText({ kind: 'ringEntry', asset: 'x', amount: 1n }, SOL)).toBe('Arrived through a ring: 0.000000001 SOL.');
    expect(arrivalText({ kind: 'somethingNew', asset: 'x', amount: 2_000_000n }, { symbol: '$GHO', decimals: 6 })).toBe('Arrived in your wallet: 2 $GHO.');
  });

  it('names no amount it cannot write correctly', () => {
    expect(arrivalText({ kind: 'privateTransfer', asset: 'x', amount: 1_500_000_000n }, undefined)).toBe('Private payment received.');
  });

  it('says which request a payment fits, and only that it fits', () => {
    expect(arrivalText({ kind: 'privateTransfer', asset: 'x', amount: 1_000_000_000n }, SOL, { note: 'Invoice 12' })).toBe('Private payment received: 1 SOL. It fits your request “Invoice 12”: the same token and amount.');
    expect(arrivalText({ kind: 'privateTransfer', asset: 'x', amount: 1_000_000_000n }, SOL, { note: '' })).toBe('Private payment received: 1 SOL. It fits a request you made: the same token and amount.');
  });

  it('shows three and counts the rest', () => {
    expect(arrivalLines(['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
    expect(arrivalLines(['a', 'b', 'c', 'd'])).toEqual(['a', 'b', 'c', 'And 1 more arrival. See Activity in your wallet.']);
    expect(arrivalLines(['a', 'b', 'c', 'd', 'e', 'f'])).toEqual(['a', 'b', 'c', 'And 3 more arrivals. See Activity in your wallet.']);
  });

  it('keeps a system notification to the bare fact', () => {
    expect(systemText(1)).toBe('Something arrived in your wallet.');
    expect(systemText(4)).toBe('4 things arrived in your wallet.');
    for (const count of [1, 2, 9]) expect(systemText(count)).not.toMatch(/SOL|\$|\d+\.\d/);
  });
});
