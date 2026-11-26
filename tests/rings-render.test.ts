import { describe, expect, it } from 'vitest';

import type { RingKind, RingLabels, RingRow } from '../shared/src/rings-api.js';
import { WSOL_MINT } from '../shared/src/constants.js';
import { addressLink, amountText, esc, legText, looksLikeAddress, rowWords, shareText, shortAddress, signedAmount, tokenName, utcTime } from '../web/src/rings-render.js';

const A = '8ripXsmaTTAVgvqvALD33E4MJLrAfexX9WmKzbnQvRAr';
const B = 'GjqKasTGENzKrhuicJYczxKSf3wmgSPW9TSzCMxTPg2T';
const C = '2MoVmLk3n1yfHq9vTn4mQy6Tt1RzVxw5pDRDjVfiAbCd';
const TOKEN = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const UNKNOWN = 'FyRmWCpxDVR53RGL4vnvRTPQXqLUndf4AqSaGVthi3Qi';
const labels: RingLabels = { [TOKEN]: { symbol: 'USDC', decimals: 6, listed: false } };

function row(kind: RingKind, fields: Partial<RingRow> = {}): RingRow {
  return { signature: '5'.repeat(88), slot: 1, at: 1_800_000_000_000, kind, payer: A, senders: [A], recipients: [], legs: [], via: [], ring: null, ...fields };
}

/** The sentence with its markup taken out: what a reader sees. */
function text(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

describe('what a row of the explorer says', () => {
  it('says a shield in full: who, what and how much', () => {
    const words = rowWords(row('shield', { legs: [{ mint: WSOL_MINT, amount: '1500000000', dir: 'in' }] }), labels);
    expect(text(words.html)).toBe('8rip…vRAr shielded 1.5 SOL');
    expect(words.note).toBe('Wallet, token and amount are public.');
    const gift = rowWords(row('shield', { recipients: [B], legs: [{ mint: TOKEN, amount: '25000000', dir: 'in' }] }), labels);
    expect(text(gift.html)).toBe('8rip…vRAr shielded 25 USDC, into the private balance of GjqK…Pg2T');
  });

  it('says an unshield, and who it was paid out to when that is somebody else', () => {
    const own = rowWords(row('unshield', { legs: [{ mint: TOKEN, amount: '1234567890', dir: 'out' }] }), labels);
    expect(text(own.html)).toBe('8rip…vRAr unshielded 1,234.5678 USDC');
    const paid = rowWords(row('unshield', { recipients: [B], legs: [{ mint: TOKEN, amount: '1000000', dir: 'out' }] }), labels);
    expect(text(paid.html)).toBe('8rip…vRAr unshielded 1 USDC, paid out to GjqK…Pg2T');
  });

  it('says a private transfer with the two wallets and no amount, because there is none to read', () => {
    const words = rowWords(row('transfer', { recipients: [B] }), labels);
    expect(text(words.html)).toBe('8rip…vRAr paid GjqK…Pg2T privately');
    expect(words.note).toBe('Token and amount are encrypted.');
    expect(words.html).not.toMatch(/\d{5,}/);
    const many = rowWords(row('transfer', { recipients: [B, C, TOKEN, UNKNOWN, WSOL_MINT] }), labels);
    expect(text(many.html)).toBe('8rip…vRAr paid GjqK…Pg2T, 2MoV…AbCd and EPjF…Dt1v and 2 more privately');
  });

  it('does not name a payer when the chain does not show one', () => {
    const words = rowWords(row('transfer', { payer: C, senders: [], recipients: [A, B] }), labels);
    expect(text(words.html)).toBe('A private transfer between 8rip…vRAr and GjqK…Pg2T');
    expect(words.note).toContain('Which of them paid is not public either.');
  });

  it('says a swap between two wallets, a pool trade with its venue, and a wallet’s own move', () => {
    expect(text(rowWords(row('swap', { senders: [A, B] }), labels).html)).toBe('8rip…vRAr and GjqK…Pg2T paid each other privately, in one transaction');
    const trade = rowWords(row('trade', { legs: [{ mint: WSOL_MINT, amount: '2000000000', dir: 'out' }, { mint: TOKEN, amount: '310000000', dir: 'in' }], via: ['Meteora curve'] }), labels);
    expect(text(trade.html)).toBe('8rip…vRAr traded 2 SOL for 310 USDC through Meteora curve');
    expect(trade.note).toContain('The trade itself is public.');
    expect(text(rowWords(row('self'), labels).html)).toBe('8rip…vRAr moved its own private balance');
  });

  it('says what it has not read yet instead of guessing', () => {
    expect(rowWords(row('private'), labels).note).toContain('Who was paid has not been read yet.');
    expect(text(rowWords(row('private', { ring: 'RingProgram1111111111111111111111111111111' }), labels).html)).toBe('8rip…vRAr moved funds inside another ring');
    expect(text(rowWords(row('token'), labels).html)).toBe('8rip…vRAr registered a token with Rings');
    expect(rowWords(row('other'), labels).html).toBe('A transaction this site does not read');
  });

  it('never writes an amount that moved as zero', () => {
    expect(legText({ mint: TOKEN, amount: '5', dir: 'out' }, labels)).toBe('0.000005 USDC');
    expect(legText({ mint: WSOL_MINT, amount: '1', dir: 'in' }, labels)).toBe('0.000000001 SOL');
    expect(legText({ mint: TOKEN, amount: '0', dir: 'in' }, labels)).toBe('0 USDC');
  });

  it('gives an amount of a token it knows nothing about in its smallest units, and says so', () => {
    expect(legText({ mint: UNKNOWN, amount: '123456789', dir: 'in' }, labels)).toBe('123,456,789 base units of FyRm…i3Qi');
    expect(legText({ mint: TOKEN, amount: 'not a number', dir: 'in' }, labels)).toBe('? USDC');
  });

  it('keeps anything that is not an address out of its links, and escapes what it writes', () => {
    const hostile = '"><img src=x onerror=alert(1)>';
    const words = rowWords(row('transfer', { senders: [hostile], recipients: [B], via: ['<b>x</b>'] }), { [TOKEN]: { symbol: '<script>', decimals: 6, listed: false } });
    expect(words.html).not.toContain('<img');
    expect(words.html).not.toContain('<script');
    expect(addressLink(hostile)).not.toContain('href');
    expect(addressLink(A)).toContain(`href="/rings?address=${A}"`);
    const traded = rowWords(row('trade', { legs: [{ mint: TOKEN, amount: '1', dir: 'out' }, { mint: WSOL_MINT, amount: '1', dir: 'in' }], via: ['<b>x</b>'] }), { [TOKEN]: { symbol: '<script>', decimals: 6, listed: false } });
    expect(traded.html).not.toContain('<script');
    expect(traded.html).not.toContain('<b>x</b>');
    expect(esc('<a href="x">&\'')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  });
});

describe('small formatters', () => {
  it('tell an address from anything else by its shape', () => {
    expect(looksLikeAddress(A)).toBe(true);
    expect(looksLikeAddress(WSOL_MINT)).toBe(true);
    for (const bad of ['', 'hush', A.slice(0, 20), `${A}${A}`, A.replace('8', '0'), `${A.slice(0, 43)}l`, ' ' + A]) expect(looksLikeAddress(bad)).toBe(false);
  });

  it('name a token by its ticker, SOL as SOL, and anything unnamed by its address', () => {
    expect(tokenName(WSOL_MINT, {})).toBe('SOL');
    expect(tokenName(TOKEN, labels)).toBe('USDC');
    expect(tokenName(UNKNOWN, labels)).toBe('FyRm…i3Qi');
    expect(shortAddress('short')).toBe('short');
  });

  it('write a net movement with its direction, and nothing as a dash', () => {
    expect(signedAmount('1200000000', 6)).toEqual({ text: '+1.20K', direction: 'up' });
    expect(signedAmount('-350000000', 6)).toEqual({ text: '−350.00', direction: 'down' });
    expect(signedAmount('0', 6)).toEqual({ text: '—', direction: 'flat' });
    expect(signedAmount('x', 6)).toEqual({ text: '—', direction: 'flat' });
  });

  it('write a share of supply, and do not round a real holding down to nothing', () => {
    expect(shareText(2500, '1')).toBe('25.0%');
    expect(shareText(140, '1')).toBe('1.40%');
    expect(shareText(1, '1')).toBe('0.01%');
    expect(shareText(0, '120000000')).toBe('<0.01%');
    expect(shareText(0, '0')).toBe('0%');
    expect(shareText(null, '5')).toBe('—');
    expect(shareText(10_000, '1')).toBe('100.0%');
  });

  it('write amounts short, and times the same for every reader', () => {
    expect(amountText('412000000000000', 6)).toBe('412.00M');
    expect(amountText('oops', 6)).toBe('—');
    expect(utcTime(1_800_000_000_000)).toBe('2027-01-15 08:00 UTC');
    expect(utcTime(0)).toBe('');
  });
});
