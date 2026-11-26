/**
 * Offline builders for tests. They use the real SDK end to end except for the
 * Groth16 proof, which needs the remote prover: a correctly sized placeholder
 * stands in for it. Everything a counterparty checks before signing (encoding,
 * accounts, ciphertexts, commitments) is real.
 */
import { randomBytes } from 'node:crypto';
import type { Address } from '@solana/kit';
import { ShieldedKeypair, initializePoseidon } from '@heliuslabs/spr';
import { getTreeAddress } from '@heliuslabs/spr/addresses';
import { DEFAULT_TREE_ID, type TransactInstructionData } from '@heliuslabs/spr/interface';
import { prepareTransfer } from '@heliuslabs/spr/internal';
import { AssetRegistry, ConfidentialTransfer, ProofInputUtxo, Utxo } from '@heliuslabs/spr/transaction';

export const PLACEHOLDER_PROOF = Object.freeze({
  a: new Uint8Array(32),
  b: new Uint8Array(128),
  c: new Uint8Array(32),
});

function blinding(): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set(randomBytes(31), 1);
  return bytes;
}

function root(seed: number): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes[31] = seed;
  return bytes;
}

export async function setup(): Promise<{ tree: Address; treeId: number }> {
  await initializePoseidon();
  return { tree: await getTreeAddress(DEFAULT_TREE_ID as never), treeId: DEFAULT_TREE_ID };
}

export interface LegInput {
  readonly from: ShieldedKeypair;
  readonly to: ShieldedKeypair;
  readonly feePayer: Address;
  readonly asset: Address;
  /** Size of the single note being spent. */
  readonly noteAmount: bigint;
  /** Spend this note, one the sender really holds, instead of a made-up one of `noteAmount`. */
  readonly note?: Utxo;
  readonly sendAmount: bigint;
  readonly registry?: AssetRegistry;
}

/** One confidential transfer leg, as `client.proveTransact` would return it. */
export function buildLeg(input: LegInput): TransactInstructionData {
  const owner = input.from.shieldedAddress();
  const note =
    input.note ??
    new Utxo({
      owner: owner.signingPublicKey,
      asset: input.asset,
      amount: input.noteAmount,
      blinding: blinding() as never,
    });
  const transfer = new ConfidentialTransfer(owner, [ProofInputUtxo.fromKeypair(note, input.from)], input.feePayer);
  transfer.send(input.to.shieldedAddress(), input.asset, input.sendAmount);
  const proofInputs = transfer.sign(input.from, input.registry ?? new AssetRegistry());
  const assembled = prepareTransfer(proofInputs).finish([
    {
      treeId: DEFAULT_TREE_ID as never,
      slot: { id: DEFAULT_TREE_ID, utxoRoot: root(1) as never, nullifierRoot: root(2) as never },
      utxoRootIndex: 3,
      nullifierRootIndex: 4,
    },
  ]);
  return { ...assembled.instructionData, proof: PLACEHOLDER_PROOF as never };
}
