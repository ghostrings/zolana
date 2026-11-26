/**
 * Sending a token privately and burning one: the parts both the token page
 * and the wallet page say and check. Nothing here touches a page or signs
 * anything, so all of it can be tested.
 */

import { isAddress } from '@solana/kit';

import { INITIAL_SUPPLY_UNITS } from '../../shared/src/constants.js';
import { percentOf } from '../../shared/src/units.js';

/* ---------------- Who can be sent to ---------------- */

export type RecipientKind = 'empty' | 'invalid' | 'self' | 'checking' | 'registered' | 'unregistered' | 'unknown';

/** What the text alone says about a recipient. A `candidate` is a real address: only the chain knows the rest. */
export function classifyRecipient(text: string, own: string): 'empty' | 'invalid' | 'self' | 'candidate' {
  const value = text.trim();
  if (!value) return 'empty';
  if (!isAddress(value)) return 'invalid';
  if (value === own) return 'self';
  return 'candidate';
}

/** One line under the recipient field for each state. */
export const RECIPIENT_HINTS: Readonly<Record<RecipientKind, string>> = Object.freeze({
  empty: 'A wallet can receive privately once its owner has registered it with Rings. That is one press of Register on the Wallet page, one time.',
  invalid: 'That is not a Solana address.',
  self: 'That is your own address.',
  checking: 'Checking that this address can receive privately…',
  registered: 'Registered with Rings: it can receive this privately.',
  unregistered:
    'This address has not registered a private wallet, so it cannot receive a private transfer yet. Its owner opens the Wallet page here and presses Register, once. To pay an address that will not register, withdraw to it instead: that is public.',
  unknown: 'This address could not be checked right now. If it is not registered the transfer is refused before anything moves.',
});

/** True for the states in which sending can go ahead. */
export function recipientUsable(kind: RecipientKind): boolean {
  return kind === 'registered' || kind === 'unknown';
}

/**
 * Follows what is typed into a recipient field. An address that is known to be
 * registered is remembered, because registration is permanent; one that is not
 * is asked about again every time, because its owner may have registered since.
 */
export class RecipientChecker {
  readonly #registered = new Set<string>();
  readonly #ask: (address: string) => Promise<boolean>;
  #sequence = 0;

  constructor(ask: (address: string) => Promise<boolean>) {
    this.#ask = ask;
  }

  /**
   * The state right now. When the chain has to be asked the answer is
   * `checking`, and `onAnswer` is called once it is in, unless something newer
   * has been typed meanwhile.
   */
  look(text: string, own: string, onAnswer: (kind: RecipientKind) => void): RecipientKind {
    const sequence = ++this.#sequence;
    const first = classifyRecipient(text, own);
    if (first !== 'candidate') return first;
    const address = text.trim();
    if (this.#registered.has(address)) return 'registered';
    this.#ask(address).then(
      (registered) => {
        if (registered) this.#registered.add(address);
        if (sequence === this.#sequence) onAnswer(registered ? 'registered' : 'unregistered');
      },
      () => {
        if (sequence === this.#sequence) onAnswer('unknown');
      },
    );
    return 'checking';
  }
}

/* ---------------- What an observer sees ---------------- */

/** One line of a "what an observer sees" list: what it is about, what it reads, and whether that is hidden. */
export type VisibilityRow = readonly [label: string, value: string, hidden: boolean];

/** A private transfer of a token: the two wallets show, the rest is ciphertext. */
export const SEND_VISIBILITY: readonly VisibilityRow[] = Object.freeze([
  ['Your wallet and the recipient’s', 'PUBLIC', false],
  ['That one sent the other something', 'PUBLIC', false],
  ['Which token', 'ENCRYPTED', true],
  ['How much', 'ENCRYPTED', true],
] as const);

/**
 * A burn. It lowers the supply everyone reads, so the burn itself cannot be
 * hidden: what stays private is whatever the wallet still holds in Rings.
 */
export function burnVisibility(source: 'private' | 'public'): readonly VisibilityRow[] {
  return [
    ['Your wallet', 'PUBLIC', false],
    ['Which token, and how much was burned', 'PUBLIC', false],
    ['The new, lower supply', 'PUBLIC', false],
    source === 'private' ? ['What you still hold in your private balance', 'ENCRYPTED', true] : ['What is left in your public account', 'PUBLIC', false],
  ];
}

/* ---------------- What a burn does to the supply ---------------- */

export interface BurnEffect {
  /** The supply once the burn has landed, in base units. */
  readonly after: bigint;
  /** The burn as a percentage of the supply before it. */
  readonly sharePct: string;
  /** Everything burned once this lands, in base units: the launch supply less `after`. */
  readonly burnedAfter: bigint;
  /** That total as a percentage of the launch supply. */
  readonly burnedPct: string;
}

/** What burning `amount` does to a supply of `supply`. Null when the amount is not one that can be burned. */
export function burnEffect(supply: bigint, amount: bigint): BurnEffect | null {
  if (amount <= 0n || supply <= 0n || amount > supply) return null;
  const after = supply - amount;
  const burnedAfter = after >= INITIAL_SUPPLY_UNITS ? 0n : INITIAL_SUPPLY_UNITS - after;
  return {
    after,
    sharePct: percentOf(amount, supply, 4),
    burnedAfter,
    burnedPct: percentOf(burnedAfter, INITIAL_SUPPLY_UNITS, 4),
  };
}

/** The word typed to confirm a burn. */
export const BURN_WORD = 'BURN';

export function burnConfirmed(text: string): boolean {
  return text.trim().toUpperCase() === BURN_WORD;
}
