/**
 * Notes set aside by a spend that was built and never sent.
 *
 * The Rings SDK sets the notes a spend is built on aside for two minutes. That
 * is right while the transaction is on its way, and wrong when it was never
 * sent: the wallet is then told its balance does not cover what it plainly
 * holds. These tests hold the installed SDK to that behaviour, on a wallet
 * with real notes, and hold `markSpend` and `spending` to letting go of
 * exactly what an unsent try set aside, and of nothing once a transaction has
 * gone out or may have.
 */

import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  type Address,
  type Blockhash,
  type Instruction,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  type Signature,
  SolanaError,
  type Transaction,
} from '@solana/kit';
import bs58 from 'bs58';
import { type IndexedShieldedTransaction, LocalShieldedKeys, SOL_MINT, ShieldedKeypair, type Wallet, buildWithdrawalTransaction, syncWallet } from '@heliuslabs/spr';
import { transactInstruction } from '@heliuslabs/spr/interface';

import { syntheticTransaction } from '../shared/src/ghost.js';
import { type RingsContext, markSpend, newWalletState, sendSigned, spending } from '../shared/src/privacy.js';
import { addSignature } from '../shared/src/signing.js';
import { composeV1 } from '../shared/src/tx.js';
import { explainError } from '../web/src/errors.js';
import { buildLeg, setup } from './helpers.js';

const SOL = SOL_MINT as Address;
const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((byte, index) => byte === b[index]);

let tree: Address;
let treeId: number;
beforeAll(async () => {
  ({ tree, treeId } = await setup());
});

interface Held {
  readonly wallet: Wallet;
  readonly keys: LocalShieldedKeys;
  readonly owner: Address;
  /** The indexer the wallet was read from. A build asks nothing of it before the notes are chosen. */
  readonly client: unknown;
}

/** A wallet that was paid `amounts`, one private transfer each, with real ciphertexts, read the way a browser reads it. */
async function paidWallet(amounts: readonly bigint[]): Promise<Held> {
  const owner = ShieldedKeypair.generate();
  const payer = ShieldedKeypair.generate();
  const payerAddress = payer.toSolanaSigner().address;
  const landed: Array<{ slot: bigint; signature: Signature; transaction: IndexedShieldedTransaction }> = [];
  for (const [index, amount] of amounts.entries()) {
    const data = buildLeg({ from: payer, to: owner, feePayer: payerAddress, asset: SOL, noteAmount: amount + 1_000_000_000n, sendAmount: amount });
    const instruction = await transactInstruction({ payer: payerAddress, ownerSigners: [payerAddress], inputTree: tree, outputTree: tree, data });
    const accounts = (instruction.accounts ?? []).map((account) => account.address);
    const signature = bs58.encode(randomBytes(64)) as Signature;
    const slot = 100n + BigInt(index);
    landed.push({ slot, signature, transaction: { ...syntheticTransaction(data, accounts, tree, treeId), slot, txSignature: signature } });
  }
  const tip = 500n;
  type Request = { readonly filters?: { readonly slot?: { readonly gt?: bigint } }; readonly tags?: readonly Uint8Array[] };
  const empty = { context: { blockTime: 0n, slot: tip }, data: [], paginationToken: null };
  const client = {
    async getShieldedTransactionsByTags(request: Request) {
      const after = request.filters?.slot?.gt;
      return {
        ...empty,
        data: landed
          .filter((item) => item.transaction.outputSlots.some((slot) => (request.tags ?? []).some((tag) => same(tag, slot.viewTag))))
          .filter((item) => after === undefined || item.slot > after)
          .map((item) => ({ slot: item.slot, signature: item.signature, events: [item.transaction] })),
      };
    },
    async getEncryptedUtxosByTags() {
      return empty;
    },
    async getShieldedTransactionsByNullifiers() {
      return empty;
    },
  };
  const wallet = newWalletState(owner.shieldedAddress());
  const keys = LocalShieldedKeys.fromKeypair(owner);
  await syncWallet({ client: client as never, wallet, keys });
  expect(wallet.balance(SOL).amount).toBe(amounts.reduce((sum, amount) => sum + amount, 0n));
  return { wallet, keys, owner: owner.toSolanaSigner().address, client };
}

/** Sets a note aside the way the SDK does when a spend is built on it: for two minutes from now. */
function setAsideLikeABuild(wallet: Wallet, amount: bigint): string {
  const note = wallet.utxos().find((entry) => !entry.spent && entry.utxo.amount === amount);
  if (!note) throw new Error(`no unspent note of ${amount}`);
  return wallet._reserveUtxos({ utxoHashes: [note.outputContext.hash], nowMs: BigInt(Date.now()), ttlMs: 120_000n }).id;
}

/**
 * Whether a withdrawal of `amount` can be built on this wallet's notes right
 * now. There is no prover here, so no build finishes; what is read is where it
 * stops: at the choice of notes ('held'), or later, once the notes were chosen
 * ('chosen'). A build that fails gives its own notes back, so asking changes nothing.
 */
async function build(held: Held, amount: bigint): Promise<{ answer: 'held' | 'chosen'; error: unknown }> {
  try {
    await buildWithdrawalTransaction({ client: held.client as never, wallet: held.wallet, keys: held.keys, feePayer: held.owner, recipient: held.owner, amount });
  } catch (error) {
    const codes: string[] = [];
    for (let at: unknown = error; at; at = (at as { cause?: unknown }).cause) codes.push(String((at as { code?: unknown }).code ?? (at as Error).message));
    return { answer: codes.some((code) => code.includes('WALLET_INSUFFICIENT_BALANCE')) ? 'held' : 'chosen', error };
  }
  throw new Error('a withdrawal was built without a prover');
}

/** A signed transaction, and an RPC whose first send does what `first` says. Confirmation never comes: the wait fails with `no confirmation`. */
async function sending(first: 'accepts' | 'refuses' | 'drops') {
  const signer = ShieldedKeypair.generate().toSolanaSigner();
  const instruction: Instruction = { programAddress: '11111111111111111111111111111111' as Address, accounts: [], data: new Uint8Array([1]) };
  const unsigned = composeV1({
    feePayer: signer.address,
    lifetime: { blockhash: '11111111111111111111111111111111' as Blockhash, lastValidBlockHeight: 100n },
    instructions: [instruction],
    computeUnitLimit: 1_000,
  });
  const signed: Transaction = await addSignature(signer, unsigned);
  let sends = 0;
  const solanaRpc = {
    sendTransaction: () => ({
      send: async () => {
        sends += 1;
        if (sends > 1) return 'signature';
        if (first === 'refuses') {
          // What the RPC answers when its own run of the transaction fails: the transaction is not sent on.
          throw new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE, { err: 'custom program error: 0x1771', logs: [], unitsConsumed: 0n } as never);
        }
        if (first === 'drops') throw new TypeError('fetch failed');
        return 'signature';
      },
    }),
  };
  const client = {
    solanaRpc,
    confirmTransaction: async () => {
      throw new Error('no confirmation');
    },
  };
  return { signed, client, sends: () => sends };
}

const contextOf = (held: Held, client: unknown = held.client): RingsContext => ({ client, wallet: held.wallet, keys: held.keys, owner: held.owner }) as unknown as RingsContext;

describe('what the installed SDK does with a note a spend was built on', () => {
  it('keeps the list this relies on', async () => {
    const held = await paidWallet([2_000_000_000n]);
    expect(typeof held.wallet._reservationEntries).toBe('function');
    expect(typeof held.wallet._releaseReservation).toBe('function');
    expect(held.wallet._reservationEntries()).toEqual([]);
    const id = setAsideLikeABuild(held.wallet, 2_000_000_000n);
    expect(held.wallet._reservationEntries().map((entry) => entry.id)).toEqual([id]);
    held.wallet._releaseReservation(id);
    expect(held.wallet._reservationEntries()).toEqual([]);
  });

  it('tells a second build the balance does not cover it, while the balance still reads in full', async () => {
    const held = await paidWallet([2_000_000_000n]);
    expect((await build(held, 1_000_000_000n)).answer).toBe('chosen');
    // Asking gave the notes back: a build that fails releases what it took.
    expect(held.wallet._reservationEntries()).toEqual([]);

    setAsideLikeABuild(held.wallet, 2_000_000_000n);
    // The page's own check passes, which is why it cannot be the one to catch this.
    expect(held.wallet.balance(SOL).amount).toBe(2_000_000_000n);
    const second = await build(held, 1_000_000_000n);
    expect(second.answer).toBe('held');
    // And this is what somebody is told: both things it can mean.
    const said = explainError(second.error);
    expect(said).toContain('does not cover this right now');
    expect(said).toContain('set aside');
  });
});

describe('a try that was never sent gives its notes back', () => {
  it('when it fails before anything is signed', async () => {
    const held = await paidWallet([2_000_000_000n]);
    const ctx = contextOf(held);
    const failure = new Error('The trade would fail, so it was not sent.');
    await expect(
      spending(ctx, async () => {
        setAsideLikeABuild(held.wallet, 2_000_000_000n);
        expect((await build(held, 1_000_000_000n)).answer).toBe('held');
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(held.wallet._reservationEntries()).toEqual([]);
    expect((await build(held, 1_000_000_000n)).answer).toBe('chosen');
  });

  it('and only its own: what was set aside before it stays', async () => {
    const held = await paidWallet([2_000_000_000n, 3_000_000_000n]);
    const ctx = contextOf(held);
    const earlier = setAsideLikeABuild(held.wallet, 3_000_000_000n);
    await expect(
      spending(ctx, async () => {
        setAsideLikeABuild(held.wallet, 2_000_000_000n);
        throw new Error('not sent');
      }),
    ).rejects.toThrow('not sent');
    expect(held.wallet._reservationEntries().map((entry) => entry.id)).toEqual([earlier]);
    // The two SOL note is free again; the three SOL one is still on its way somewhere.
    expect((await build(held, 2_000_000_000n)).answer).toBe('chosen');
    expect((await build(held, 2_500_000_000n)).answer).toBe('held');
  });

  it('when the RPC’s own run refuses the transaction, which is then never sent on', async () => {
    const held = await paidWallet([2_000_000_000n]);
    const { signed, client, sends } = await sending('refuses');
    const ctx = contextOf(held, client);
    await expect(
      spending(ctx, async () => {
        setAsideLikeABuild(held.wallet, 2_000_000_000n);
        return sendSigned(ctx, signed);
      }),
    ).rejects.toBeInstanceOf(SolanaError);
    expect(sends()).toBe(1);
    expect(held.wallet._reservationEntries()).toEqual([]);
  });

  it('through a mark taken by hand, as the trades that try twice do', async () => {
    const held = await paidWallet([2_000_000_000n]);
    const ctx = contextOf(held);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const mark = markSpend(ctx);
      // Each try finds the notes free, because the one before gave them back.
      expect((await build(held, 1_000_000_000n)).answer).toBe('chosen');
      setAsideLikeABuild(held.wallet, 2_000_000_000n);
      mark.release();
      expect(held.wallet._reservationEntries()).toEqual([]);
    }
  });
});

describe('a try that was sent, or may have been, keeps its notes', () => {
  it('when the transaction went out and nothing was heard back', async () => {
    const held = await paidWallet([2_000_000_000n]);
    const { signed, client } = await sending('accepts');
    const ctx = contextOf(held, client);
    let id = '';
    await expect(
      spending(ctx, async () => {
        id = setAsideLikeABuild(held.wallet, 2_000_000_000n);
        return sendSigned(ctx, signed);
      }),
    ).rejects.toThrow('no confirmation');
    expect(held.wallet._reservationEntries().map((entry) => entry.id)).toEqual([id]);
    // So a second transaction cannot be built on the same notes while the first may still land.
    expect((await build(held, 1_000_000_000n)).answer).toBe('held');
  });

  it('when the connection dropped during the first send, so nobody knows', async () => {
    const held = await paidWallet([2_000_000_000n]);
    const { signed, client } = await sending('drops');
    const ctx = contextOf(held, client);
    let id = '';
    await expect(
      spending(ctx, async () => {
        id = setAsideLikeABuild(held.wallet, 2_000_000_000n);
        return sendSigned(ctx, signed);
      }),
    ).rejects.toThrow('fetch failed');
    expect(held.wallet._reservationEntries().map((entry) => entry.id)).toEqual([id]);
  });

  it('when the failure came after a send, whatever it was', async () => {
    const held = await paidWallet([2_000_000_000n]);
    const { signed, client } = await sending('accepts');
    const ctx = contextOf(held, client);
    const mark = markSpend(ctx);
    const id = setAsideLikeABuild(held.wallet, 2_000_000_000n);
    await expect(sendSigned(ctx, signed)).rejects.toThrow('no confirmation');
    mark.release();
    expect(held.wallet._reservationEntries().map((entry) => entry.id)).toEqual([id]);
  });

  it('and a send by one wallet does not hold another wallet’s notes', async () => {
    const first = await paidWallet([2_000_000_000n]);
    const second = await paidWallet([2_000_000_000n]);
    const { signed, client } = await sending('accepts');
    const mark = markSpend(contextOf(second));
    setAsideLikeABuild(second.wallet, 2_000_000_000n);
    await expect(sendSigned(contextOf(first, client), signed)).rejects.toThrow('no confirmation');
    mark.release();
    expect(second.wallet._reservationEntries()).toEqual([]);
  });
});

describe('it never gets in the way', () => {
  it('a try that works is returned as it is, and nothing is let go', async () => {
    const held = await paidWallet([2_000_000_000n]);
    const ctx = contextOf(held);
    let id = '';
    const result = await spending(ctx, async () => {
      id = setAsideLikeABuild(held.wallet, 2_000_000_000n);
      return 'landed';
    });
    expect(result).toBe('landed');
    expect(held.wallet._reservationEntries().map((entry) => entry.id)).toEqual([id]);
  });

  it('a wallet without the SDK’s list changes nothing: the try’s own error is what comes back', async () => {
    const failure = new Error('declined');
    for (const wallet of [{}, { _reservationEntries: () => { throw new Error('gone'); } }, { _reservationEntries: () => [{ id: 'a' }] }]) {
      const ctx = { wallet } as unknown as RingsContext;
      await expect(spending(ctx, async () => Promise.reject(failure))).rejects.toBe(failure);
      expect(() => markSpend(ctx).release()).not.toThrow();
    }
    // With no wallet object at all there is nothing to count sends against, so nothing is ever let go.
    const none = { wallet: undefined } as unknown as RingsContext;
    await expect(spending(none, async () => Promise.reject(failure))).rejects.toBe(failure);
  });

  it('a release that fails is swallowed: the notes come free by themselves', async () => {
    let entries: Array<{ id: string }> = [];
    let tried = 0;
    const ctx = {
      wallet: {
        _reservationEntries: () => entries,
        _releaseReservation: () => {
          tried += 1;
          throw new Error('the SDK changed');
        },
      },
    } as unknown as RingsContext;
    const failure = new Error('not sent');
    await expect(
      spending(ctx, async () => {
        entries = [{ id: 'new' }];
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(tried).toBe(1);
  });
});
