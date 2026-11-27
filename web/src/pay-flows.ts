/**
 * A payout run, with the real thing plugged in: the wallet in use, the Rings
 * SDK and the network. The order of a run and its promises are in
 * `shared/src/payrun.ts`; this file only says what each step is made of.
 *
 * Each payment is the same private transfer the wallet page sends, built by
 * the same SDK call. It is then followed until the chain has decided
 * (`sendAndSettleFinal`), not until a timer runs out, because a list is paid
 * without a person reading every result.
 */

import { type Address, type Signature, type Transaction, address, getSignatureFromTransaction } from '@solana/kit';

import type { PayItem, PayRun } from '../../shared/src/paymany.js';
import { type PayHooks, type PayPorts, type PayStep, type Settling, payNext as payNextWith, settleSent as settleSentWith } from '../../shared/src/payrun.js';
import { latestLifetime, lookUpSent, markSpend, privateBalance, refusedInSimulation, sendAndSettleFinal, transferTransaction } from '../../shared/src/privacy.js';
import { carriedLastValid } from '../../shared/src/tx.js';
import { keepMemo } from './local-records.js';
import { FlowError, afterLanding, canReceivePrivately, friendlyError, knowAsset, requireGas, requireWalletAddress } from './trade.js';
import type { Session } from './wallet.js';

export type { PayHooks, PayStep, Settling };

/**
 * The last block a built transaction can land in. The SDK's transaction
 * carries it. Should it ever not, the newest lifetime is asked for instead:
 * that is read after the transaction was built, so it is never earlier than
 * the transaction's own, and nothing is called too old before it is.
 */
async function lastValidOf(session: Session, transaction: Transaction): Promise<bigint> {
  return carriedLastValid(transaction) ?? (await latestLifetime(session.ctx.client)).lastValidBlockHeight;
}

/**
 * The server lets one visitor ask for a limited number of proofs a minute
 * (twelve, unless the operator set another figure). Every payment needs one,
 * so payments are started at least this far apart: a full run then stays
 * under the limit instead of stopping halfway with "too many requests".
 */
export const PAY_PROOF_SPACING_MS = 6_000;
let lastProofAt = 0;

async function proofTurn(): Promise<void> {
  const wait = lastProofAt + PAY_PROOF_SPACING_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastProofAt = Date.now();
}

/** What each step of a run is, for this wallet. */
export function portsOf(session: Session): PayPorts<Transaction> {
  const { ctx } = session;
  return {
    wallet: session.address,

    async ready(run: PayRun, item: PayItem) {
      await requireGas(session);
      const asset = address(run.mint);
      await knowAsset(session, asset);
      if (privateBalance(ctx, asset) < BigInt(item.units)) throw new FlowError(`Your private balance of ${run.symbol} no longer covers it.`);
    },

    mark: () => markSpend(ctx),

    async build(run: PayRun, item: PayItem) {
      await proofTurn();
      const transaction = await transferTransaction(ctx, { asset: address(run.mint), amount: BigInt(item.units), recipient: address(item.to) });
      return { transaction, lastValid: await lastValidOf(session, transaction) };
    },

    async sign(transaction: Transaction) {
      const signed = await ctx.sign(transaction);
      return { signed, signature: getSignatureFromTransaction(signed) };
    },

    // A rejection is acted on (the line can be sent again), so it is only taken once its block is confirmed.
    send: (signed: Transaction, lastValid: bigint) => sendAndSettleFinal(ctx, signed, lastValid),

    neverLeft: refusedInSimulation,

    lookUp: (signature: string, lastValid: bigint) => lookUpSent(ctx.client, signature as Signature, lastValid),

    async landed(item: PayItem, signature: string, slot: bigint) {
      try {
        // A private history row names no recipient and carries no note: this browser keeps both beside the transaction.
        keepMemo(session.address, { signature, at: Date.now(), to: item.to, ...(item.note ? { note: item.note } : {}) });
      } catch {
        // The money has moved. A note that could not be kept must never be told as a payment that failed.
      }
      await afterLanding(session, slot);
    },

    explain: friendlyError,
  };
}

/** Sends the next payment that is waiting, and stays with it until the chain has decided. Never throws. */
export function payNext(session: Session, run: PayRun, hooks: PayHooks): Promise<PayStep> {
  return payNextWith(portsOf(session), run, hooks);
}

/** Looks at the chain for every payment that was sent and never seen to land or fail. Sends nothing. */
export function settleSent(session: Session, run: PayRun, hooks: PayHooks): Promise<Settling> {
  return settleSentWith(portsOf(session), run, hooks);
}

/* ------------------------------------------------------------------ */
/* Before a run                                                        */
/* ------------------------------------------------------------------ */

export type Readiness =
  | { readonly ok: true }
  /** `again` is true when the check itself could not be made, so asking again may give another answer. */
  | { readonly ok: false; readonly reason: string; readonly again: boolean };

export const NOT_REGISTERED_REASON =
  'This wallet has not registered with Rings, so it cannot be paid privately yet. Its owner registers by opening a private balance once, here or in any app that uses Rings.';

/**
 * Whether a wallet on the list can be paid privately right now: it has to be
 * a wallet (not a token account, a mint or a program), and registered with
 * Rings. Reads two public accounts and signs nothing.
 */
export async function checkRecipient(to: Address): Promise<Readiness> {
  try {
    await requireWalletAddress(to);
  } catch (error) {
    if (error instanceof FlowError) return { ok: false, reason: error.message.replace(/ Nothing was sent\.$/, ''), again: false };
    return { ok: false, reason: 'This address could not be looked at just now.', again: true };
  }
  let registered: boolean;
  try {
    registered = await canReceivePrivately(to);
  } catch {
    return { ok: false, reason: 'Whether this wallet can be paid privately could not be read just now.', again: true };
  }
  return registered ? { ok: true } : { ok: false, reason: NOT_REGISTERED_REASON, again: false };
}
