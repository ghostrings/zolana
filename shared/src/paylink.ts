/**
 * Payment requests as links.
 *
 * A request is a link to the wallet page with everything after the `#`: who
 * to pay, which token, how much, and a note. A browser never sends that part
 * of an address to a server, so the request reaches the payer's page and
 * nobody else. Opening one fills in the Send form for the payer to read and
 * confirm; it sends nothing by itself.
 *
 * The note does not travel on chain. The Rings SDK this site is built on has
 * no field for one on a private transfer, so a note lives in the link, and
 * afterwards in the payer's own browser beside the transaction.
 *
 * A link is somebody else's text: everything read from one is checked here
 * before a page shows or uses any of it.
 */

import { isAddress } from '@solana/kit';

/** How a request writes SOL. Any other token is written as its mint address. */
export const PAY_SOL = 'SOL';
export const PAY_NOTE_MAX = 140;

export interface PayRequest {
  /** The wallet to pay. */
  readonly to: string;
  /** `SOL`, or a token's mint address. */
  readonly token: string;
  /** A plain decimal number as a person writes it, or null when the payer chooses. */
  readonly amount: string | null;
  /** Up to 140 visible characters. Empty when there is none. */
  readonly note: string;
}

export type PayLinkRead = { readonly ok: true; readonly request: PayRequest } | { readonly ok: false; readonly problem: string };

const AMOUNT = /^(0|[1-9][0-9]{0,17})(\.[0-9]{1,12})?$/;

/**
 * A note as it may be shown: one line, no control characters, none of the
 * invisible characters that hide text or turn its direction around, and no
 * longer than a note may be.
 */
export function cleanNote(value: unknown, max: number = PAY_NOTE_MAX): string {
  if (typeof value !== 'string') return '';
  let out = '';
  let gap = false;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    // Every kind of space, tab and line break becomes one ordinary space.
    const space =
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0b ||
      code === 0x0c ||
      code === 0x0d ||
      code === 0x20 ||
      code === 0x85 ||
      code === 0xa0 ||
      code === 0x1680 ||
      (code >= 0x2000 && code <= 0x200a) ||
      code === 0x2028 ||
      code === 0x2029 ||
      code === 0x202f ||
      code === 0x205f ||
      code === 0x3000;
    if (space) {
      gap = out.length > 0;
      continue;
    }
    const hidden =
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0xad ||
      code === 0x061c ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2060 && code <= 0x2069) ||
      code === 0xfeff;
    if (hidden) continue;
    if (gap) out += ' ';
    gap = false;
    out += character;
  }
  return [...out].slice(0, max).join('').trim();
}

/** An amount as a request carries it: no needless zeros. Null when the text is not an amount, or is zero. */
export function cleanAmount(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!AMOUNT.test(text)) return null;
  const [whole = '0', fraction = ''] = text.split('.');
  const trimmed = fraction.replace(/0+$/, '');
  if (whole === '0' && trimmed === '') return null;
  return trimmed ? `${whole}.${trimmed}` : whole;
}

/** The link for a request. `origin` is the site's own address, like `https://privacycash.fun`. */
export function payLink(origin: string, request: PayRequest): string {
  const parts = [`to=${encodeURIComponent(request.to)}`];
  if (request.token !== PAY_SOL) parts.push(`token=${encodeURIComponent(request.token)}`);
  if (request.amount !== null) parts.push(`amount=${encodeURIComponent(request.amount)}`);
  const note = cleanNote(request.note);
  if (note) parts.push(`note=${encodeURIComponent(note)}`);
  return `${origin.replace(/\/+$/, '')}/wallet#pay?${parts.join('&')}`;
}

/**
 * Reads the part of an address after its `#`. Null when it is not a payment
 * request at all; otherwise the request, or what is wrong with it.
 */
export function readPayLink(fragment: string): PayLinkRead | null {
  const text = fragment.startsWith('#') ? fragment.slice(1) : fragment;
  if (!/^pay(\?|$)/i.test(text)) return null;
  const query = text.slice(text.indexOf('?') + 1);
  if (!text.includes('?') || query.length === 0) return { ok: false, problem: 'This payment link names nobody to pay.' };
  if (query.length > 2_000) return { ok: false, problem: 'This payment link is too long to be one this site made.' };
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(query);
  } catch {
    return { ok: false, problem: 'This payment link could not be read.' };
  }
  const to = (params.get('to') ?? '').trim();
  if (!isAddress(to)) return { ok: false, problem: 'This payment link does not name a Solana address to pay.' };
  const tokenText = (params.get('token') ?? PAY_SOL).trim();
  const token = tokenText.toUpperCase() === PAY_SOL ? PAY_SOL : tokenText;
  if (token !== PAY_SOL && !isAddress(token)) return { ok: false, problem: 'This payment link names a token that is not a token address.' };
  const amountText = params.get('amount');
  let amount: string | null = null;
  if (amountText !== null && amountText.trim() !== '') {
    amount = cleanAmount(amountText);
    if (amount === null) return { ok: false, problem: 'This payment link asks for an amount that is not a plain number above zero.' };
  }
  return { ok: true, request: { to, token, amount, note: cleanNote(params.get('note') ?? '') } };
}
