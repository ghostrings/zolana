/**
 * How the wallet check-up words what it found. Kept apart from the page so
 * the wording can be tested: a check-up that overstates is worse than none.
 * Every sentence is about what an onlooker COULD work out, never about what
 * anyone did work out, and each says what would take the guess away.
 */

import type { CheckPair, Checkup } from '../../shared/src/checkup.js';
import type { RingCounterparty, RingLabels } from '../../shared/src/rings-api.js';
import { explorerTx } from './format.js';
import { addressLink, esc, legText, shortAddress, utcTime } from './rings-render.js';

export interface CheckCard {
  /** `warn`: an amount or a balance can be worked out. `note`: worth knowing. `fact`: how it is for every wallet. `ok`: nothing found. */
  readonly level: 'warn' | 'note' | 'fact' | 'ok';
  readonly title: string;
  /** Markup made only from escaped text and this site's own links. */
  readonly html: string;
}

export function gapText(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (ms < 60_000) return 'less than a minute';
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

const times = (count: number, one: string, many: string): string => (count === 1 ? one : many.replace('#', String(count)));

function txLink(signature: string, text: string): string {
  return `<a class="tx-link" href="${esc(explorerTx(signature))}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>`;
}

function amounts(pair: CheckPair, labels: RingLabels): string {
  return pair.legs.map((leg) => `<b>${esc(legText(leg, labels))}</b>`).join(' and ');
}

export interface CheckupContext {
  readonly counterparties: readonly RingCounterparty[];
  readonly labels: RingLabels;
}

/** The check-up as cards, the ones that matter most first. */
export function checkupCards(result: Checkup, context: CheckupContext): CheckCard[] {
  const cards: CheckCard[] = [];
  const { labels } = context;

  if (result.openBalance) {
    cards.push({
      level: 'warn',
      title: 'Your private balance can be added up',
      html: `In the transactions looked at, every move of your private balance was a shield, an unshield or a pool trade, and each of those shows its amount. With no private transfer among them, anyone can add them up and know what you hold. A private transfer, in or out, is what leaves an onlooker unsure.`,
    });
  }

  const sent = result.pairs.filter((pair) => pair.kind === 'in-then-sent');
  const latestSent = sent[0];
  if (latestSent) {
    cards.push({
      level: 'warn',
      title: times(sent.length, 'A private transfer left right after a public amount came in', '# private transfers left right after a public amount came in'),
      html: `${sent.length > 1 ? 'The latest: ' : ''}${amounts(latestSent, labels)} came into your private balance (${txLink(latestSent.publicSignature, 'that transaction')}), and a private transfer left ${esc(gapText(latestSent.gapMs))} later (${txLink(latestSent.hiddenSignature, 'this one')}, ${esc(utcTime(latestSent.at))}). Its amount is encrypted, but an onlooker can guess it was about as much. Letting time pass between the two, or sending another amount than came in, takes the guess away.`,
    });
  }

  const out = result.pairs.filter((pair) => pair.kind === 'received-then-out');
  const latestOut = out[0];
  if (latestOut) {
    cards.push({
      level: 'warn',
      title: times(out.length, 'A public amount left right after a private transfer came in', '# times a public amount left right after a private transfer came in'),
      html: `${out.length > 1 ? 'The latest: a' : 'A'} private transfer arrived (${txLink(latestOut.hiddenSignature, 'that transaction')}), and ${amounts(latestOut, labels)} left your private balance in public ${esc(gapText(latestOut.gapMs))} later (${txLink(latestOut.publicSignature, 'this one')}, ${esc(utcTime(latestOut.at))}). An onlooker can guess the transfer carried about as much. Waiting, or taking out another amount, takes the guess away.`,
    });
  }

  if (result.publicPayments > 0) {
    cards.push({
      level: 'note',
      title: times(result.publicPayments, '1 payment went out in the open', '# payments went out in the open'),
      html: `An unshield straight to somebody else's address, or a shield into somebody else's balance, shows both wallets and the amount, like an ordinary transfer. To pay without showing the amount, use Send from your private balance: it shows the two wallets and nothing more.`,
    });
  }

  if (cards.every((card) => card.level !== 'warn') && result.rows > 0) {
    cards.unshift({
      level: 'ok',
      title: 'Nothing here gives a hidden amount away',
      html: `None of the transactions looked at pairs a private transfer with a public amount close enough in time for an onlooker to tie the two together${result.hiddenMoves > 0 ? ', and your balance cannot be added up from public amounts alone' : ''}.`,
    });
  }

  const linked = context.counterparties;
  cards.push({
    level: 'fact',
    title: linked.length === 0 ? 'No wallet is linked to yours by a private transfer' : times(linked.length, '1 wallet is linked to yours in public', `# wallets are linked to yours in public${linked.length >= 25 ? ', or more' : ''}`),
    html:
      linked.length === 0
        ? 'A private transfer hides the token and the amount, never the two wallets. None was found for this wallet in what this site has read.'
        : `A private transfer hides the token and the amount, never the two wallets. Those yours has paid, or been paid by: ${linked
            .slice(0, 6)
            .map((entry) => addressLink(entry.address))
            .join(', ')}${linked.length > 6 ? ` and ${linked.length - 6} more` : ''}.`,
  });

  return cards;
}

/** One line under the cards: how much was looked at. */
export function coverageText(result: Checkup, input: { readonly more: boolean; readonly since: number | null; readonly complete: boolean; readonly address: string }): string {
  if (result.rows === 0) {
    return `This site has read no Rings activity for ${shortAddress(input.address)}${input.since ? ` since ${utcTime(input.since)}` : ''}. A wallet that has only ever received shows up once it moves.`;
  }
  const looked = `Looked at ${result.rows === 1 ? 'the 1 public transaction' : `${input.more ? 'the latest ' : 'all '}${result.rows} public transactions`} this site has read for this wallet`;
  const reach = input.since ? `. It has read Rings back to ${utcTime(input.since)}${input.complete ? '' : ' and is still reading further back'}` : '';
  return `${looked}${reach}. Anything older is not in this check-up.`;
}
