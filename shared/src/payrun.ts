/**
 * Sending a payout run: one payment at a time, each seen through to a
 * definite end before the next one is built.
 *
 * This file holds the order things happen in and nothing else. What a
 * payment is made of (the proof, the wallet's signature, the network) comes
 * in as `PayPorts`, so the order can be held to its promises in tests with
 * every kind of failure, and the page plugs in the real thing.
 *
 * THE PROMISES
 *  - A payment's signature is on record BEFORE its transaction is handed to
 *    the network. If it cannot be written down, the payment is not sent.
 *  - A payment on record as sent is never built a second time. Whenever what
 *    became of it is not known, the run stops, and nothing else is sent
 *    until a look at the chain has settled it.
 *  - "Not paid" is only ever said of a payment that cannot land any more:
 *    refused before it left, rejected on chain, or too old.
 */

import type { Outcome } from './desk-rules.js';
import { type PayItem, type PayRun, markFailed, markPaid, markSent, nextTodo, unsettled } from './paymany.js';

/** A transaction as the ports hand it around. This file never looks inside one. */
export interface PayPorts<Tx> {
  /** The wallet these ports pay from. */
  readonly wallet: string;
  /** Throws, with words for the person paying, when the payment cannot be afforded right now. Builds nothing. */
  ready(run: PayRun, item: PayItem): Promise<void>;
  /** Marks what the wallet has set aside so far; `release` frees what a payment that was never sent set aside since. */
  mark(): { release(): void };
  /** Builds the payment, unsigned, and says which block is the last it can land in. */
  build(run: PayRun, item: PayItem): Promise<{ readonly transaction: Tx; readonly lastValid: bigint }>;
  /** Asks the wallet to sign. Returns the signed transaction and its signature. */
  sign(transaction: Tx): Promise<{ readonly signed: Tx; readonly signature: string }>;
  /** Hands it to the network and stays with it until the chain has decided. Throws when the first send fails. */
  send(signed: Tx, lastValid: bigint): Promise<Outcome>;
  /** True when a failed send was refused in the RPC's own simulation, so the transaction never left. */
  neverLeft(error: unknown): boolean;
  /** One look at the chain for a transaction sent earlier. Throws when the network does not answer. */
  lookUp(signature: string, lastValid: bigint): Promise<Outcome>;
  /** Called once for every payment seen to have landed. Must not throw. */
  landed(item: PayItem, signature: string, slot: bigint): Promise<void>;
  /** An error, in words for the person paying. */
  explain(error: unknown): string;
}

export interface PayHooks {
  /** Writes the run down. False when it could not be kept. */
  save(run: PayRun): boolean;
  stage(message: string): void;
  readonly now?: () => number;
}

export interface PayStep {
  /** The run after this step. */
  readonly run: PayRun;
  /** Why the run stops here. Null when the next payment can go ahead. */
  readonly stop: string | null;
}

export const PAY_NOT_KEPT =
  'This browser would not keep the progress of the run, so the payment was not sent and nothing moved. A run needs somewhere to write down what it has paid: check that this is not a private window and that the browser has storage left.';

export const PAY_REJECTED = 'The chain rejected it. Nothing moved.';
export const PAY_EXPIRED = 'The network never included it, and it is now too old to land. Nothing moved.';

const unknownOutcome = (label: string): string =>
  `It is not known yet whether ${label} went through: the network stopped answering while it was being sent. Nothing else is sent until that is known. Press “Check again” in a minute.`;

const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * Sends the next payment of the run that is waiting, and stays with it until
 * the chain has decided. Never throws: whatever happens comes back as the
 * run and, when the run cannot go on, the reason.
 */
export async function payNext<Tx>(ports: PayPorts<Tx>, run: PayRun, hooks: PayHooks): Promise<PayStep> {
  const now = hooks.now ?? Date.now;
  if (run.wallet !== ports.wallet) return { run, stop: 'This run belongs to another wallet. Switch to that wallet to continue it.' };
  if (unsettled(run).length > 0) return { run, stop: 'A payment of this run was sent and its outcome is not known yet. Nothing else is sent until it is.' };
  const index = nextTodo(run);
  const item = run.items[index];
  if (index < 0 || !item) return { run, stop: null };
  const label = `payment ${index + 1} of ${run.items.length}`;

  // 1. Nothing is built unless it can be paid for.
  try {
    await ports.ready(run, item);
  } catch (error) {
    return { run, stop: `${capital(label)} was not sent. ${ports.explain(error)}` };
  }

  // 2. Build and sign. Until the signature is on record, anything that goes wrong leaves the line exactly as it was.
  const mark = ports.mark();
  let signed: Tx;
  let signature: string;
  let lastValid: bigint;
  try {
    hooks.stage(`Proving ${label}…`);
    const built = await ports.build(run, item);
    lastValid = built.lastValid;
    hooks.stage(`Sign ${label} in your wallet…`);
    ({ signed, signature } = await ports.sign(built.transaction));
  } catch (error) {
    mark.release();
    return { run, stop: `${capital(label)} was not sent. ${ports.explain(error)}` };
  }

  // 3. The signature goes on record before the transaction goes anywhere.
  let current: PayRun;
  try {
    current = markSent(run, index, signature, lastValid, now());
  } catch (error) {
    mark.release();
    return { run, stop: `${capital(label)} was not sent. ${error instanceof Error ? error.message : 'It could not be recorded.'}` };
  }
  if (!hooks.save(current)) {
    mark.release();
    return { run, stop: PAY_NOT_KEPT };
  }

  // 4. Send, and stay with it until the chain has decided.
  hooks.stage(`Sending ${label}…`);
  let outcome: Outcome;
  try {
    outcome = await ports.send(signed, lastValid);
  } catch (error) {
    if (!ports.neverLeft(error)) return { run: current, stop: unknownOutcome(label) };
    // Refused by the RPC's own simulation: the transaction never left, so nothing can come of it.
    mark.release();
    const why = ports.explain(error);
    const refused = markFailed(current, index, `Refused before it was sent. ${why}`);
    hooks.save(refused);
    return { run: refused, stop: `${capital(label)} was refused before it was sent, so nothing moved. ${why}` };
  }
  if (outcome.kind === 'pending') return { run: current, stop: unknownOutcome(label) };
  if (outcome.kind === 'landed') {
    const paid = markPaid(current, index, now());
    hooks.save(paid);
    await ports.landed(item, signature, outcome.slot);
    return { run: paid, stop: null };
  }
  const reason = outcome.kind === 'rejected' ? PAY_REJECTED : PAY_EXPIRED;
  const failed = markFailed(current, index, reason);
  hooks.save(failed);
  return { run: failed, stop: `${capital(label)} did not go through. ${reason} The rest of the run is waiting: continue when you are ready.` };
}

export interface Settling {
  readonly run: PayRun;
  /** Payments whose outcome is still not known after this look. */
  readonly unknown: number;
  /** Set when the network could not be asked at all. */
  readonly problem: string | null;
}

/**
 * Looks at the chain for every payment that was sent and never seen to land
 * or fail, and writes down what it finds. Sends nothing.
 */
export async function settleSent<Tx>(ports: PayPorts<Tx>, run: PayRun, hooks: PayHooks): Promise<Settling> {
  const now = hooks.now ?? Date.now;
  let current = run;
  let unknown = 0;
  let problem: string | null = null;
  if (run.wallet !== ports.wallet) return { run, unknown: unsettled(run).length, problem: 'This run belongs to another wallet.' };
  for (const index of unsettled(run)) {
    const item = current.items[index];
    if (!item?.signature || !item.lastValid) continue;
    let outcome: Outcome;
    try {
      hooks.stage(`Looking up payment ${index + 1} of ${run.items.length} on chain…`);
      outcome = await ports.lookUp(item.signature, BigInt(item.lastValid));
    } catch {
      unknown += 1;
      problem = 'The network did not answer, so nothing could be looked up. Try again in a moment.';
      continue;
    }
    if (outcome.kind === 'pending') {
      unknown += 1;
      continue;
    }
    if (outcome.kind === 'landed') {
      current = markPaid(current, index, now());
      hooks.save(current);
      await ports.landed(item, item.signature, outcome.slot);
      continue;
    }
    current = markFailed(current, index, outcome.kind === 'rejected' ? PAY_REJECTED : PAY_EXPIRED);
    hooks.save(current);
  }
  return { run: current, unknown, problem };
}
