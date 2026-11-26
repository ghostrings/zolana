import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';

import { PAY_NOTE_MAX, PAY_SOL, cleanAmount, cleanNote, payLink, readPayLink } from '../shared/src/paylink.js';

const TO = Keypair.generate().publicKey.toBase58();
const MINT = Keypair.generate().publicKey.toBase58();
const ORIGIN = 'https://privacycash.fun';
const code = (...points: number[]): string => String.fromCodePoint(...points);

const fragmentOf = (link: string): string => link.slice(link.indexOf('#'));

describe('a payment link', () => {
  it('carries the request after the #, where a browser sends it to no server', () => {
    const link = payLink(ORIGIN, { to: TO, token: PAY_SOL, amount: '1.5', note: 'Invoice 12' });
    expect(link).toBe(`${ORIGIN}/wallet#pay?to=${TO}&amount=1.5&note=Invoice%2012`);
    expect(new URL(link).search).toBe('');
    expect(new URL(link).pathname).toBe('/wallet');
  });

  it('comes back exactly as it was made', () => {
    for (const request of [
      { to: TO, token: PAY_SOL, amount: '1.5', note: 'Invoice 12' },
      { to: TO, token: MINT, amount: '250', note: '' },
      { to: TO, token: PAY_SOL, amount: null, note: 'Thanks & see you: 50% + tip?' },
      { to: TO, token: MINT, amount: '0.000001', note: `caf${code(0xe9)} ${code(0x1f47b)} #7` },
    ]) {
      expect(readPayLink(fragmentOf(payLink(ORIGIN, request)))).toEqual({ ok: true, request });
    }
  });

  it('is not seen in the fragments this page already uses', () => {
    for (const fragment of ['', '#', '#send', '#receive', '#activity', '#payments', '#paying?to=x']) expect(readPayLink(fragment)).toBeNull();
  });

  it('reads the fragment with or without its #, and SOL in any case', () => {
    expect(readPayLink(`pay?to=${TO}&token=sol`)).toEqual({ ok: true, request: { to: TO, token: PAY_SOL, amount: null, note: '' } });
    expect(readPayLink(`#PAY?to=${TO}`)).toEqual({ ok: true, request: { to: TO, token: PAY_SOL, amount: null, note: '' } });
  });

  it('says what is wrong with a link it cannot use', () => {
    const problem = (fragment: string): string => {
      const read = readPayLink(fragment);
      return read && !read.ok ? read.problem : 'no problem';
    };
    expect(problem('#pay')).toMatch(/nobody to pay/);
    expect(problem('#pay?')).toMatch(/nobody to pay/);
    expect(problem('#pay?amount=1')).toMatch(/Solana address/);
    expect(problem(`#pay?to=${TO.slice(0, -2)}`)).toMatch(/Solana address/);
    expect(problem(`#pay?to=${TO}&token=USDC`)).toMatch(/token/);
    for (const amount of ['-1', '1e9', '0', '0.0', '1,5', 'abc', '1.', '.5', '01', '1.0000000000001', '9'.repeat(19)]) {
      expect(problem(`#pay?to=${TO}&amount=${encodeURIComponent(amount)}`), amount).toMatch(/amount/);
    }
    expect(problem(`#pay?to=${TO}&note=${'x'.repeat(2_100)}`)).toMatch(/too long/);
  });

  it('never hands on markup or hidden characters from a note', () => {
    const note = `<img src=x onerror=alert(1)>${code(0x202e)}evil${code(0x200b)}${code(0x0000)}\n\n  next`;
    const read = readPayLink(`#pay?to=${TO}&note=${encodeURIComponent(note)}`);
    expect(read).toEqual({ ok: true, request: { to: TO, token: PAY_SOL, amount: null, note: '<img src=x onerror=alert(1)>evil next' } });
  });
});

describe('a note', () => {
  it('is one line of visible characters', () => {
    expect(cleanNote('  two\t\twords \n here ')).toBe('two words here');
    expect(cleanNote(`a${code(0xa0)}b${code(0x3000)}c${code(0x2009)}d`)).toBe('a b c d');
    expect(cleanNote(`x${code(0x200d)}y${code(0xfeff)}z${code(0x2066)}!${code(0x00ad)}`)).toBe('xyz!');
    expect(cleanNote(42)).toBe('');
    expect(cleanNote(null)).toBe('');
  });

  it('is cut to its length in characters, not in bytes', () => {
    const ghosts = code(0x1f47b).repeat(PAY_NOTE_MAX + 10);
    expect([...cleanNote(ghosts)]).toHaveLength(PAY_NOTE_MAX);
    expect(cleanNote('a'.repeat(500))).toHaveLength(PAY_NOTE_MAX);
  });
});

describe('an amount in a request', () => {
  it('is kept as written, without needless zeros', () => {
    expect(cleanAmount('1.50')).toBe('1.5');
    expect(cleanAmount(' 10 ')).toBe('10');
    expect(cleanAmount('0.000001')).toBe('0.000001');
    expect(cleanAmount('3.000')).toBe('3');
  });

  it('is refused when it is not a plain number above zero', () => {
    for (const text of ['', '0', '0.000', '-2', '+2', '1e3', '0x10', '1 000', 'NaN', 'Infinity']) expect(cleanAmount(text), text).toBeNull();
    expect(cleanAmount(5)).toBeNull();
  });
});
