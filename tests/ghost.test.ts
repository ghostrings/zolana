import { beforeAll, describe, expect, it } from 'vitest';
import { AccountRole, type Address, type Blockhash, type Instruction, getTransactionSize } from '@solana/kit';
import { SOL_MINT, ShieldedKeypair } from '@heliuslabs/spr';
import { transactInstruction, type TransactInstructionData } from '@heliuslabs/spr/interface';
import { AssetRegistry } from '@heliuslabs/spr/transaction';

import {
  GhostError,
  assertGhostMessage,
  assertIncoming,
  assertLegAccounts,
  assertPlainTransfer,
  composeGhostFill,
  decodeTransactData,
  encodeTransactData,
  readIncoming,
} from '../shared/src/ghost.js';
import { SPP_DEFAULT_TREE, TX_V1_MAX_BYTES } from '../shared/src/constants.js';
import { composeV1, decompileMessage, messageBytesOf } from '../shared/src/tx.js';
import { buildLeg, setup } from './helpers.js';

const TOKEN = 'So11111111111111111111111111111111111111112' as Address; // stands in for a launched mint
const TOKEN_ASSET_ID = 7n;
const lifetime = { blockhash: '11111111111111111111111111111111' as Blockhash, lastValidBlockHeight: 100n };

let tree: Address;
let treeId: number;
let trader: ShieldedKeypair;
let desk: ShieldedKeypair;
let traderAddress: Address;
let deskAddress: Address;
let registry: AssetRegistry;
let traderData: TransactInstructionData;
let deskData: TransactInstructionData;
let traderLeg: Instruction;
let deskLeg: Instruction;

async function instructionFor(data: TransactInstructionData, owner: Address): Promise<Instruction> {
  return transactInstruction({ payer: deskAddress, ownerSigners: [owner], inputTree: tree, outputTree: tree, data });
}

beforeAll(async () => {
  ({ tree, treeId } = await setup());
  trader = ShieldedKeypair.generate();
  desk = ShieldedKeypair.generate();
  traderAddress = trader.toSolanaSigner().address;
  deskAddress = desk.toSolanaSigner().address;
  registry = new AssetRegistry([[TOKEN_ASSET_ID, TOKEN]]);

  // A buy: the trader pays 2 SOL, the desk delivers 40,000 tokens.
  traderData = buildLeg({
    from: trader, to: desk, feePayer: deskAddress, asset: SOL_MINT, noteAmount: 5_000_000_000n, sendAmount: 2_000_000_000n, registry,
  });
  deskData = buildLeg({
    from: desk, to: trader, feePayer: deskAddress, asset: TOKEN, noteAmount: 900_000_000_000n, sendAmount: 40_000_000_000n, registry,
  });
  traderLeg = await instructionFor(traderData, traderAddress);
  deskLeg = await instructionFor(deskData, deskAddress);
});

describe('the SDK and the chain agree on the default tree', () => {
  it('derives the documented mainnet tree address', () => {
    expect(tree).toBe(SPP_DEFAULT_TREE);
  });
});

describe('leg codec', () => {
  it('round-trips to byte-identical instruction data', async () => {
    const decoded = decodeTransactData(encodeTransactData(traderData));
    const rebuilt = await instructionFor(decoded, traderAddress);
    expect(Buffer.from(rebuilt.data as Uint8Array)).toEqual(Buffer.from(traderLeg.data as Uint8Array));
    expect(rebuilt.accounts).toEqual(traderLeg.accounts);
  });

  it('rejects unknown fields, prototype keys and malformed values', () => {
    const json = JSON.parse(encodeTransactData(traderData)) as Record<string, unknown>;
    expect(() => decodeTransactData(JSON.stringify({ ...json, extra: 1 }))).toThrow(/Unexpected field/);
    expect(() => decodeTransactData('{"__proto__":{"x":1}}')).toThrow(GhostError);
    expect(() => decodeTransactData(JSON.stringify({ ...json, salt: { $b: 'AAAA' } }))).toThrow(/salt/);
    expect(() => decodeTransactData(JSON.stringify({ ...json, expiryUnixTs: { $n: '-1' } }))).toThrow(GhostError);
    expect(() => decodeTransactData('x'.repeat(20_000))).toThrow(/too large/);
    expect(() => decodeTransactData('not json')).toThrow(/JSON/);
  });
});

describe('plain-transfer rules', () => {
  it('accept an ordinary confidential transfer', () => {
    expect(() => assertPlainTransfer(traderData)).not.toThrow();
    expect(() => assertPlainTransfer(deskData)).not.toThrow();
  });

  it('refuse a leg that moves public funds', () => {
    const withDeposit = { ...traderData, interfaceTransfers: [{ kind: 'solDeposit', amount: 1_000_000_000n }] } as TransactInstructionData;
    expect(() => assertPlainTransfer(withDeposit)).toThrow(/public deposit or withdrawal/);
    const withWithdrawal = { ...traderData, interfaceTransfers: [{ kind: 'solWithdrawal', amount: 1n }] } as TransactInstructionData;
    expect(() => assertPlainTransfer(withWithdrawal)).toThrow(/public deposit or withdrawal/);
  });

  it('refuse other circuits, extra data and second trees', () => {
    expect(() => assertPlainTransfer({ ...traderData, circuit: { ...traderData.circuit, kind: 'ringAuthority' } } as TransactInstructionData)).toThrow(/owner-signed/);
    expect(() => assertPlainTransfer({ ...traderData, messages: [{ viewTag: new Uint8Array(32), data: new Uint8Array(4) }] } as TransactInstructionData)).toThrow(/messages/);
    expect(() => assertPlainTransfer({ ...traderData, dataHash: new Uint8Array(32) } as TransactInstructionData)).toThrow(/program or ring data/);
    expect(() => assertPlainTransfer({ ...traderData, treeContexts: [...traderData.treeContexts, ...traderData.treeContexts] })).toThrow(/one tree/);
    expect(() => assertPlainTransfer({ ...traderData, inputs: [...traderData.inputs, ...traderData.inputs] })).toThrow(/repeats an input/);
  });
});

describe('decrypt and verify', () => {
  const params = (data: TransactInstructionData, leg: Instruction, recipient: ShieldedKeypair) => ({
    data, instructionAccounts: (leg.accounts ?? []).map((account) => account.address), recipient, registry, tree, treeId,
  });

  it('lets the desk read exactly what the trader committed to it', async () => {
    expect(await readIncoming(params(traderData, traderLeg, desk), SOL_MINT)).toBe(2_000_000_000n);
    expect(await readIncoming(params(traderData, traderLeg, desk), TOKEN)).toBe(0n);
  });

  it('lets the trader read exactly what the desk committed to them', async () => {
    expect(await readIncoming(params(deskData, deskLeg, trader), TOKEN)).toBe(40_000_000_000n);
    await expect(assertIncoming(params(deskData, deskLeg, trader), { asset: TOKEN, minAmount: 40_000_000_000n })).resolves.toBe(40_000_000_000n);
  });

  it('rejects a short payment', async () => {
    await expect(assertIncoming(params(deskData, deskLeg, trader), { asset: TOKEN, minAmount: 40_000_000_001n })).rejects.toThrow(/promised at least/);
  });

  it('shows a third party nothing', async () => {
    const stranger = ShieldedKeypair.generate();
    expect(await readIncoming(params(traderData, traderLeg, stranger), SOL_MINT)).toBe(0n);
    expect(await readIncoming(params(deskData, deskLeg, stranger), TOKEN)).toBe(0n);
  });

  it('counts nothing when the ciphertext does not match the commitment', async () => {
    // Swap in a commitment for a different note: the ciphertext still decrypts,
    // but the note it describes is not the one the chain would record.
    const other = buildLeg({ from: trader, to: desk, feePayer: deskAddress, asset: SOL_MINT, noteAmount: 5_000_000_000n, sendAmount: 1n, registry });
    const forged = {
      ...traderData,
      outputs: traderData.outputs.map((output, index) => ({ ...output, utxoHash: other.outputs[index]?.utxoHash ?? output.utxoHash })),
    } as TransactInstructionData;
    const leg = await instructionFor(forged, traderAddress);
    expect(await readIncoming(params(forged, leg, desk), SOL_MINT)).toBe(0n);
  });

  it('counts nothing when the ciphertext is tampered with', async () => {
    const forged = {
      ...traderData,
      outputs: traderData.outputs.map((output) => {
        const data = new Uint8Array(output.data ?? []);
        if (data.length > 0) data[data.length - 1] = (data[data.length - 1] ?? 0) ^ 0xff;
        return { ...output, data };
      }),
    } as TransactInstructionData;
    const leg = await instructionFor(forged, traderAddress);
    expect(await readIncoming(params(forged, leg, desk), SOL_MINT)).toBe(0n);
  });
});

describe('the shared transaction', () => {
  it('fits both legs in one v1 transaction with only the two parties signing', () => {
    const transaction = composeGhostFill({ desk: deskAddress, trader: traderAddress, traderLeg, deskLeg }, lifetime);
    expect(getTransactionSize(transaction)).toBeLessThan(TX_V1_MAX_BYTES);
    expect(Object.keys(transaction.signatures).sort()).toEqual([deskAddress, traderAddress].sort());
    const message = decompileMessage(messageBytesOf(transaction));
    expect(message.version).toBe(1);
    expect(message.feePayer).toBe(deskAddress);
    expect(message.instructions).toHaveLength(2);
    expect(() => assertGhostMessage(messageBytesOf(transaction), { desk: deskAddress, trader: traderAddress, traderLeg, deskLeg })).not.toThrow();
  });

  it('is refused when a third instruction is slipped in', () => {
    const drain: Instruction = {
      programAddress: '11111111111111111111111111111111' as Address,
      accounts: [
        { address: traderAddress, role: AccountRole.WRITABLE_SIGNER },
        { address: deskAddress, role: AccountRole.WRITABLE },
      ],
      data: new Uint8Array([2, 0, 0, 0, 0, 202, 154, 59, 0, 0, 0, 0]),
    };
    const transaction = composeV1({ feePayer: deskAddress, lifetime, instructions: [traderLeg, deskLeg, drain], computeUnitLimit: 700_000 });
    expect(() => assertGhostMessage(messageBytesOf(transaction), { desk: deskAddress, trader: traderAddress, traderLeg, deskLeg })).toThrow(/exactly two/);
  });

  it('is refused when a leg differs from the one that was inspected', async () => {
    const other = buildLeg({ from: desk, to: trader, feePayer: deskAddress, asset: TOKEN, noteAmount: 900_000_000_000n, sendAmount: 1n, registry });
    const swapped = await instructionFor(other, deskAddress);
    const transaction = composeV1({ feePayer: deskAddress, lifetime, instructions: [traderLeg, swapped], computeUnitLimit: 700_000 });
    expect(() => assertGhostMessage(messageBytesOf(transaction), { desk: deskAddress, trader: traderAddress, traderLeg, deskLeg })).toThrow(/desk's transfer/);
  });

  it('is refused when someone else pays, or the legs are reordered', () => {
    const reordered = composeV1({ feePayer: deskAddress, lifetime, instructions: [deskLeg, traderLeg], computeUnitLimit: 700_000 });
    expect(() => assertGhostMessage(messageBytesOf(reordered), { desk: deskAddress, trader: traderAddress, traderLeg, deskLeg })).toThrow(GhostError);
    const wrongPayer = composeV1({ feePayer: traderAddress, lifetime, instructions: [traderLeg, deskLeg], computeUnitLimit: 700_000 });
    expect(() => assertGhostMessage(messageBytesOf(wrongPayer), { desk: deskAddress, trader: traderAddress, traderLeg, deskLeg })).toThrow(/desk must pay/);
  });
});

describe('priority fee', () => {
  it('is carried in the message header and paid by the desk, without changing what the trader checks', () => {
    const plain = composeGhostFill({ desk: deskAddress, trader: traderAddress, traderLeg, deskLeg }, lifetime);
    const paid = composeGhostFill({ desk: deskAddress, trader: traderAddress, traderLeg, deskLeg }, lifetime, 14_000n);
    expect(decompileMessage(messageBytesOf(plain)).priorityFeeLamports).toBeUndefined();
    const read = decompileMessage(messageBytesOf(paid));
    expect(read.priorityFeeLamports).toBe(14_000n);
    expect(read.feePayer).toBe(deskAddress);
    expect(read.instructions).toHaveLength(2);
    expect(() => assertGhostMessage(messageBytesOf(paid), { desk: deskAddress, trader: traderAddress, traderLeg, deskLeg })).not.toThrow();
  });

  it('is left out when it is zero', () => {
    const transaction = composeV1({ feePayer: deskAddress, lifetime, instructions: [traderLeg], computeUnitLimit: 450_000, priorityFeeLamports: 0n });
    expect(decompileMessage(messageBytesOf(transaction)).priorityFeeLamports).toBeUndefined();
  });
});

describe('message-level privileges', () => {
  it("is refused when the trader's wallet is made writable", () => {
    const widened: Instruction = {
      ...traderLeg,
      accounts: (traderLeg.accounts ?? []).map((account) =>
        account.address === traderAddress ? { address: account.address, role: AccountRole.WRITABLE_SIGNER } : account,
      ),
    };
    const transaction = composeV1({ feePayer: deskAddress, lifetime, instructions: [widened, deskLeg], computeUnitLimit: 700_000 });
    let code = '';
    try {
      assertGhostMessage(messageBytesOf(transaction), { desk: deskAddress, trader: traderAddress, traderLeg, deskLeg });
    } catch (error) {
      code = (error as GhostError).code;
    }
    expect(code).toBe('ROLE_MISMATCH');
  });
});

describe('leg account rules', () => {
  it("refuse a desk leg that makes the trader's wallet a signer or writable", async () => {
    const hostile: Instruction = {
      ...deskLeg,
      accounts: [...(deskLeg.accounts ?? []), { address: traderAddress, role: AccountRole.WRITABLE }],
    };
    expect(() => assertLegAccounts(hostile, { payer: deskAddress, owner: deskAddress, counterparty: traderAddress })).toThrow(/counterparty/);
    const signer: Instruction = {
      ...deskLeg,
      accounts: [...(deskLeg.accounts ?? []), { address: traderAddress, role: AccountRole.READONLY_SIGNER }],
    };
    expect(() => assertLegAccounts(signer, { payer: deskAddress, owner: deskAddress, counterparty: traderAddress })).toThrow(GhostError);
  });

  it('refuse a trader leg that lists the desk as a note owner', async () => {
    const asOwner = await transactInstruction({ payer: deskAddress, ownerSigners: [deskAddress], inputTree: tree, outputTree: tree, data: traderData });
    expect(() => assertLegAccounts(asOwner, { payer: deskAddress, owner: traderAddress, counterparty: deskAddress })).toThrow(/note owner/);
  });

  it('refuse a leg for another program', () => {
    const other: Instruction = { ...traderLeg, programAddress: '11111111111111111111111111111111' as Address };
    expect(() => assertLegAccounts(other, { payer: deskAddress, owner: traderAddress, counterparty: deskAddress })).toThrow(/Privacy Program/);
  });
});
