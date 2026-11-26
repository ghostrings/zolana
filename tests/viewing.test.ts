/**
 * Read-only access, end to end and offline: a wallet is paid and then spends,
 * with real ciphertexts made by the Rings SDK, and a reader holding only what
 * a viewing pass carries follows both. The indexer is the only thing stood in
 * for: it hands back the same transactions the chain would.
 */

import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Address, Signature } from '@solana/kit';
import bs58 from 'bs58';
import { type IndexedShieldedTransaction, LocalShieldedKeys, SOL_MINT, ShieldedKeypair, SigningKey, syncWallet } from '@heliuslabs/spr';
import { transactInstruction } from '@heliuslabs/spr/interface';

import { syntheticTransaction } from '../shared/src/ghost.js';
import { historyRowsOf, newWalletState } from '../shared/src/privacy.js';
import { derivationSeedOf, viewerKeys } from '../shared/src/viewkeys.js';
import { openPass, sealPass } from '../shared/src/viewpass.js';
import { buildLeg, setup } from './helpers.js';

const SOL = SOL_MINT as Address;

interface Landed {
  readonly slot: bigint;
  readonly signature: Signature;
  readonly transaction: IndexedShieldedTransaction;
}

const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((byte, index) => byte === b[index]);
const signatureOf = (): Signature => bs58.encode(randomBytes(64)) as Signature;

/**
 * An indexer that has read the chain up to slot `tip`, knows `landed`, and answers the three questions a sync asks.
 * Like the real one it is asked only for what came after the slot the wallet last read to, and gives only that.
 */
function indexerOf(landed: readonly Landed[], tip: bigint) {
  const asked: string[] = [];
  const page = (items: readonly Landed[], after: bigint | undefined) => ({
    context: { blockTime: 0n, slot: tip },
    data: items.filter((item) => after === undefined || item.slot > after).map((item) => ({ slot: item.slot, signature: item.signature, events: [item.transaction] })),
    paginationToken: null,
  });
  type Request = { readonly filters?: { readonly slot?: { readonly gt?: bigint } } };
  return {
    asked,
    client: {
      async getShieldedTransactionsByTags(request: Request & { readonly tags: readonly Uint8Array[] }) {
        asked.push('tags');
        return page(
          landed.filter((item) => item.transaction.outputSlots.some((slot) => request.tags.some((tag) => same(tag, slot.viewTag)))),
          request.filters?.slot?.gt,
        );
      },
      async getEncryptedUtxosByTags(_request: Request) {
        asked.push('deposits');
        return { context: { blockTime: 0n, slot: tip }, data: [], paginationToken: null };
      },
      async getShieldedTransactionsByNullifiers(request: Request & { readonly nullifiers: readonly Uint8Array[] }) {
        asked.push('nullifiers');
        return page(
          landed.filter((item) => item.transaction.nullifiers.some((nullifier) => request.nullifiers.some((wanted) => same(wanted, nullifier)))),
          request.filters?.slot?.gt,
        );
      },
    },
  };
}

let tree: Address;
let treeId: number;

beforeAll(async () => {
  ({ tree, treeId } = await setup());
});

/** A transfer as it would be indexed once it landed, from the instruction the SDK built for it. */
async function land(input: Parameters<typeof buildLeg>[0], owner: Address, slot: bigint): Promise<Landed> {
  const data = buildLeg(input);
  const instruction = await transactInstruction({ payer: input.feePayer, ownerSigners: [owner], inputTree: tree, outputTree: tree, data });
  const accounts = (instruction.accounts ?? []).map((account) => account.address);
  const signature = signatureOf();
  return { slot, signature, transaction: { ...syntheticTransaction(data, accounts, tree, treeId), slot, txSignature: signature } };
}

describe('a reader with a viewing pass', () => {
  it('sees a payment arrive and sees it spent, to the lamport, and can do nothing else', async () => {
    const seed = new Uint8Array(randomBytes(32));
    const owner = ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(new Uint8Array(seed) as never));
    const ownerAddress = owner.toSolanaSigner().address;
    const payer = ShieldedKeypair.generate();
    const payerAddress = payer.toSolanaSigner().address;

    // The pass, as the owner's browser makes it and the reader's browser opens it.
    const { address, signature } = derivationSeedOf(seed);
    const pass = await sealPass({ address, seed: signature, passphrase: 'a long passphrase', created: 1, iterations: 100_000 });
    const opened = await openPass(pass, 'a long passphrase');
    const reader = await viewerKeys(opened.address, opened.seed);
    const view = newWalletState(reader.address());

    // 1. The wallet is paid 2 SOL privately.
    const paid = await land({ from: payer, to: owner, feePayer: payerAddress, asset: SOL, noteAmount: 5_000_000_000n, sendAmount: 2_000_000_000n }, payerAddress, 100n);
    const first = indexerOf([paid], 150n);
    await syncWallet({ client: first.client as never, wallet: view, keys: reader });
    expect(view.balance(SOL).amount).toBe(2_000_000_000n);
    expect(historyRowsOf(view)).toEqual([{ signature: paid.signature, slot: 100n, index: expect.any(BigInt), kind: 'privateTransfer', direction: 'inbound', asset: SOL, amount: 2_000_000_000n }]);
    expect(first.asked).toContain('tags');

    // 2. The owner sends 0.5 SOL of it on. The reader was not told; it finds the spend by the note's nullifier.
    const held = view.balance(SOL).utxos[0];
    if (!held) throw new Error('the reader holds no note to follow');
    const spent = await land({ from: owner, to: payer, feePayer: ownerAddress, asset: SOL, noteAmount: 0n, note: held, sendAmount: 500_000_000n }, ownerAddress, 200n);
    const second = indexerOf([paid, spent], 250n);
    await syncWallet({ client: second.client as never, wallet: view, keys: reader });
    expect(view.balance(SOL).amount).toBe(1_500_000_000n);
    const rows = historyRowsOf(view);
    expect(rows.map((row) => [row.direction, row.amount, row.slot])).toEqual([
      ['inbound', 2_000_000_000n, 100n],
      ['outbound', 500_000_000n, 200n],
    ]);
    expect(second.asked).toContain('nullifiers');

    // The owner's own wallet, read with its secret key, shows exactly the same.
    const own = newWalletState(owner.shieldedAddress());
    await syncWallet({ client: indexerOf([paid, spent], 250n).client as never, wallet: own, keys: LocalShieldedKeys.fromKeypair(owner) });
    expect(historyRowsOf(own)).toEqual(rows);
    expect(own.balance(SOL).amount).toBe(view.balance(SOL).amount);

    // What the reader holds has no way to sign or to prove: the two things a transaction needs.
    for (const name of ['sign', 'prove', 'proveMerge', 'proveIndexed', 'toSolanaSigner', 'secretBytes']) expect(name in reader, name).toBe(false);
  });

  it('reads nothing with the pass of another wallet', async () => {
    const owner = ShieldedKeypair.generate();
    const payer = ShieldedKeypair.generate();
    const payerAddress = payer.toSolanaSigner().address;
    const paid = await land({ from: payer, to: owner, feePayer: payerAddress, asset: SOL, noteAmount: 5_000_000_000n, sendAmount: 2_000_000_000n }, payerAddress, 100n);
    const stranger = derivationSeedOf(new Uint8Array(randomBytes(32)));
    const reader = await viewerKeys(stranger.address, stranger.signature);
    const view = newWalletState(reader.address());
    await syncWallet({ client: indexerOf([paid], 150n).client as never, wallet: view, keys: reader });
    expect(historyRowsOf(view)).toEqual([]);
    expect(view.balances()).toEqual([]);
  });
});
