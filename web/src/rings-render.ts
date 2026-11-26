/**
 * How the Rings explorer words what it shows. Kept free of the page itself, so
 * the wording can be tested: what a row says is the whole point of the page,
 * and it must never claim more than the chain shows.
 */

import type { RingKind, RingLabels, RingLeg, RingRow } from '../../shared/src/rings-api.js';
import { WSOL_MINT } from '../../shared/src/constants.js';
import { compactUnits, formatUnits, groupDigits } from '../../shared/src/units.js';

const ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ESCAPES[character] ?? character);
}

export function shortAddress(value: string, front = 4, back = 4): string {
  return value.length <= front + back + 1 ? value : `${value.slice(0, front)}…${value.slice(-back)}`;
}

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** True for text that has the shape of a Solana address. Whether it is a wallet or a token is for the server to say. */
export function looksLikeAddress(text: string): boolean {
  return ADDRESS.test(text);
}

/** A wallet, as a link to its page here. Anything that is not an address is written out as text and linked nowhere. */
export function addressLink(value: string): string {
  if (!looksLikeAddress(value)) return `<span class="rg-addr">${esc(shortAddress(value))}</span>`;
  return `<a class="rg-addr" href="/rings?address=${encodeURIComponent(value)}" title="${esc(value)}">${esc(shortAddress(value))}</a>`;
}

/** The ticker a token goes by here, or its address cut short when it has none. */
export function tokenName(mint: string, labels: RingLabels): string {
  if (mint === WSOL_MINT) return 'SOL';
  const symbol = labels[mint]?.symbol;
  return symbol ? symbol : shortAddress(mint);
}

export function tokenLink(mint: string, labels: RingLabels): string {
  const name = esc(tokenName(mint, labels));
  if (!looksLikeAddress(mint)) return name;
  return `<a class="rg-token" href="/rings?token=${encodeURIComponent(mint)}" title="${esc(mint)}">${name}</a>`;
}

/** "1,234.5 SOL". An amount of a token whose decimals are not known is given in its smallest units, and says so. */
export function legText(leg: RingLeg, labels: RingLabels): string {
  const decimals = leg.mint === WSOL_MINT ? 9 : labels[leg.mint]?.decimals;
  let units: bigint;
  try {
    units = BigInt(leg.amount);
  } catch {
    return `? ${tokenName(leg.mint, labels)}`;
  }
  if (decimals === undefined) return `${groupDigits(units.toString())} base units of ${tokenName(leg.mint, labels)}`;
  // Four decimal places, unless that would write an amount that moved as zero: then every place it has.
  const cut = formatUnits(units, decimals, Math.min(decimals, 4));
  const text = cut === '0' && units !== 0n ? formatUnits(units, decimals) : cut;
  return `${groupDigits(text)} ${tokenName(leg.mint, labels)}`;
}

function legHtml(leg: RingLeg, labels: RingLabels): string {
  const text = legText(leg, labels);
  const name = tokenName(leg.mint, labels);
  // The token's name is the last thing in the text: it becomes the link.
  return text.endsWith(name) ? `<b>${esc(text.slice(0, text.length - name.length))}</b>${tokenLink(leg.mint, labels)}` : `<b>${esc(text)}</b>`;
}

function listOf(addresses: readonly string[], limit = 3): string {
  const shown = addresses.slice(0, limit).map(addressLink);
  const more = addresses.length - shown.length;
  if (shown.length === 0) return '';
  const joined = shown.length === 1 ? shown[0] : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
  return more > 0 ? `${joined} and ${more} more` : (joined as string);
}

export interface RowWords {
  /** One or two words for the kind of thing that happened. */
  readonly label: string;
  /** The sentence, as markup made only from escaped text and this site's own links. */
  readonly html: string;
  /** What of it is public and what is not, in a few words. */
  readonly note: string;
}

export const KIND_LABELS: Readonly<Record<RingKind, string>> = Object.freeze({
  shield: 'Shield',
  unshield: 'Unshield',
  trade: 'Pool trade',
  transfer: 'Private transfer',
  swap: 'Private swap',
  self: 'Own balance',
  private: 'Private move',
  token: 'New token',
  upkeep: 'Upkeep',
  other: 'Other',
});

const HIDDEN = 'Token and amount are encrypted.';
const PUBLIC = 'Wallet, token and amount are public.';

/** A row of the explorer in words. Nothing is said that the chain does not show. */
export function rowWords(row: RingRow, labels: RingLabels): RowWords {
  const who = listOf(row.senders) || addressLink(row.payer);
  const venue = row.via.length > 0 ? ` through ${row.via.map((name) => esc(looksLikeAddress(name) ? shortAddress(name) : name)).join(', ')}` : '';
  const into = row.legs.filter((leg) => leg.dir === 'in');
  const out = row.legs.filter((leg) => leg.dir === 'out');
  const amounts = (legs: readonly RingLeg[]): string => legs.map((leg) => legHtml(leg, labels)).join(' and ');
  const label = KIND_LABELS[row.kind] ?? 'Other';
  switch (row.kind) {
    case 'shield': {
      const paid = listOf(row.recipients);
      return { label, html: `${who} shielded ${amounts(into)}${paid ? `, into the private balance of ${paid}` : ''}`, note: PUBLIC };
    }
    case 'unshield': {
      const paid = listOf(row.recipients);
      return { label, html: `${who} unshielded ${amounts(out)}${paid ? `, paid out to ${paid}` : ''}`, note: PUBLIC };
    }
    case 'trade':
      return {
        label,
        html: `${who} traded ${amounts(out)} for ${amounts(into)}${venue}`,
        note: 'Out of a private balance and back into it. The trade itself is public.',
      };
    case 'transfer': {
      if (row.senders.length === 0) {
        return { label, html: `A private transfer between ${listOf(row.recipients, 4)}`, note: `${HIDDEN} Which of them paid is not public either.` };
      }
      return { label, html: `${who} paid ${listOf(row.recipients)} privately`, note: HIDDEN };
    }
    case 'swap':
      return { label, html: `${who} paid each other privately, in one transaction`, note: `${HIDDEN} On both sides.` };
    case 'self':
      return { label, html: `${who} moved its own private balance`, note: 'Nothing left the wallet. What it holds is encrypted.' };
    case 'private':
      if (row.ring) return { label, html: `${who} moved funds inside another ring`, note: 'Not the Default Ring: this site does not read who was paid.' };
      return { label, html: `${who} made a private move`, note: `${HIDDEN} Who was paid has not been read yet.` };
    case 'token':
      return { label, html: `${addressLink(row.payer)} registered a token with Rings`, note: 'It can be held privately from now on.' };
    case 'upkeep':
      return { label, html: 'The protocol tidied its own accounts', note: 'Nobody’s funds moved.' };
    default:
      return { label, html: 'A transaction this site does not read', note: '' };
  }
}

/** "+1.20K" or "−350": a net movement, with its direction and nothing else. Zero is a dash. */
export function signedAmount(units: string, decimals: number): { text: string; direction: 'up' | 'down' | 'flat' } {
  let value: bigint;
  try {
    value = BigInt(units);
  } catch {
    return { text: '—', direction: 'flat' };
  }
  if (value === 0n) return { text: '—', direction: 'flat' };
  const magnitude = compactUnits(value < 0n ? -value : value, decimals);
  return value > 0n ? { text: `+${magnitude}`, direction: 'up' } : { text: `−${magnitude}`, direction: 'down' };
}

/** A share of supply held privately. A share too small to round to a hundredth of a percent still shows as held. */
export function shareText(shareBps: number | null, shielded: string): string {
  if (shareBps === null) return '—';
  if (shareBps === 0) return shielded === '0' ? '0%' : '<0.01%';
  return `${(shareBps / 100).toFixed(shareBps >= 1000 ? 1 : 2)}%`;
}

export function amountText(units: string, decimals: number): string {
  try {
    return compactUnits(BigInt(units), decimals);
  } catch {
    return '—';
  }
}

/** The date and time of a row, the same for every visitor: UTC. */
export function utcTime(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return '';
  return `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
