import { beforeAll, describe, expect, it } from 'vitest';
import { AccountRole, type Address, type Blockhash, type Instruction, getTransactionSize } from '@solana/kit';
import { Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, decodeBurnCheckedInstruction, decodeCloseAccountInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { SOL_MINT, ShieldedKeypair } from '@heliuslabs/spr';
import { transactInstruction } from '@heliuslabs/spr/interface';

import { COMPUTE_UNITS, TOKEN_DECIMALS, TX_V1_MAX_BYTES } from '../shared/src/constants.js';
import { MarketError } from '../shared/src/meteora.js';
import { buildBurnPublic, burnInstructions } from '../shared/src/routes.js';
import { composeV1, decompileMessage, messageBytesOf } from '../shared/src/tx.js';
import { buildLeg, setup } from './helpers.js';

const owner = Keypair.generate().publicKey;
const ownerAddress = owner.toBase58() as Address;
const mint = Keypair.generate().publicKey;
const tokenAccount = getAssociatedTokenAddressSync(mint, owner);
const lifetime = { blockhash: '11111111111111111111111111111111' as Blockhash, lastValidBlockHeight: 100n };

/** A Kit instruction as the token program's own decoder expects it. */
function legacy(instruction: Instruction): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(instruction.programAddress),
    keys: (instruction.accounts ?? []).map((account) => ({
      pubkey: new PublicKey(account.address),
      isSigner: account.role === AccountRole.WRITABLE_SIGNER || account.role === AccountRole.READONLY_SIGNER,
      isWritable: account.role === AccountRole.WRITABLE || account.role === AccountRole.WRITABLE_SIGNER,
    })),
    data: Buffer.from(instruction.data ?? new Uint8Array()),
  });
}

describe('burning a launched token', () => {
  it('destroys exactly the amount asked, of exactly this token, from the owner’s own account', () => {
    const [burn, ...rest] = burnInstructions(ownerAddress, mint, 1_234_567_890n, false);
    expect(rest).toEqual([]);
    const decoded = decodeBurnCheckedInstruction(legacy(burn as Instruction));
    expect(decoded.programId.equals(TOKEN_PROGRAM_ID)).toBe(true);
    expect(decoded.keys.account.pubkey.equals(tokenAccount)).toBe(true);
    expect(decoded.keys.mint.pubkey.equals(mint)).toBe(true);
    expect(decoded.keys.owner.pubkey.equals(owner)).toBe(true);
    expect(decoded.keys.owner.isSigner).toBe(true);
    expect(decoded.data.amount).toBe(1_234_567_890n);
    // The checked form: a token with other decimals is refused by the token program.
    expect(decoded.data.decimals).toBe(TOKEN_DECIMALS);
  });

  it('closes the token account afterwards only when told the burn empties it', () => {
    const instructions = burnInstructions(ownerAddress, mint, 5n, true);
    expect(instructions).toHaveLength(2);
    const close = decodeCloseAccountInstruction(legacy(instructions[1] as Instruction));
    expect(close.keys.account.pubkey.equals(tokenAccount)).toBe(true);
    // The rent goes back to the owner, and only the owner can close it.
    expect(close.keys.destination.pubkey.equals(owner)).toBe(true);
    expect(close.keys.authority.pubkey.equals(owner)).toBe(true);
    expect(burnInstructions(ownerAddress, mint, 5n, false)).toHaveLength(1);
  });

  it('refuses an amount of nothing', () => {
    expect(() => burnInstructions(ownerAddress, mint, 0n, false)).toThrow(MarketError);
    expect(() => burnInstructions(ownerAddress, mint, -1n, true)).toThrow(MarketError);
  });

  it('names nobody but the owner as a signer', () => {
    for (const instruction of burnInstructions(ownerAddress, mint, 9n, true)) {
      const signers = (instruction.accounts ?? []).filter((account) => account.role === AccountRole.WRITABLE_SIGNER || account.role === AccountRole.READONLY_SIGNER);
      expect(signers.map((account) => account.address)).toEqual([ownerAddress]);
    }
  });
});

describe('a burn from the public balance, as a transaction', () => {
  const ctx = {
    owner: ownerAddress,
    client: { getLatestBlockhash: async () => lifetime },
    priority: () => 100_000,
  } as never;

  it('is a version 1 transaction with the burn alone, paid by the owner', async () => {
    const transaction = await buildBurnPublic(ctx, mint, 42_000_000n, false);
    const message = decompileMessage(messageBytesOf(transaction));
    expect(message.version).toBe(1);
    expect(message.feePayer).toBe(ownerAddress);
    expect(message.computeUnitLimit).toBe(COMPUTE_UNITS.publicBurn);
    expect(message.instructions).toHaveLength(1);
    expect(decodeBurnCheckedInstruction(legacy(message.instructions[0] as Instruction)).data.amount).toBe(42_000_000n);
    // The priority fee is priced on the small budget this needs, not on a trade's.
    expect(message.priorityFeeLamports).toBe(BigInt(Math.ceil((100_000 * COMPUTE_UNITS.publicBurn) / 1_000_000)));
  });

  it('also closes the account when the burn takes everything in it', async () => {
    const message = decompileMessage(messageBytesOf(await buildBurnPublic(ctx, mint, 42_000_000n, true)));
    expect(message.instructions).toHaveLength(2);
    expect(() => decodeCloseAccountInstruction(legacy(message.instructions[1] as Instruction))).not.toThrow();
  });
});

describe('a burn from the private balance, as a transaction', () => {
  let tree: Address;
  let holder: ShieldedKeypair;
  let holderAddress: Address;
  let withdrawal: Instruction;

  beforeAll(async () => {
    ({ tree } = await setup());
    holder = ShieldedKeypair.generate();
    holderAddress = holder.toSolanaSigner().address;
    // A Rings instruction of the real size and shape stands in for the withdrawal; only its proof is a placeholder.
    const data = buildLeg({ from: holder, to: ShieldedKeypair.generate(), feePayer: holderAddress, asset: SOL_MINT as Address, noteAmount: 10_000_000n, sendAmount: 4_000_000n });
    withdrawal = await transactInstruction({ payer: holderAddress, ownerSigners: [holderAddress], inputTree: tree, outputTree: tree, data });
  });

  it('fits a version 1 transaction with room to spare, in the order withdraw, burn, close', () => {
    const transaction = composeV1({
      feePayer: holderAddress,
      lifetime,
      instructions: [withdrawal, ...burnInstructions(holderAddress, mint, 4_000_000n, true)],
      computeUnitLimit: COMPUTE_UNITS.burn,
      priorityFeeLamports: 52_000n,
    });
    expect(getTransactionSize(transaction)).toBeLessThan(TX_V1_MAX_BYTES / 2);
    const message = decompileMessage(messageBytesOf(transaction));
    expect(message.computeUnitLimit).toBe(COMPUTE_UNITS.burn);
    expect(message.instructions).toHaveLength(3);
    expect(message.instructions[0]?.programAddress).toBe(withdrawal.programAddress);
    expect(decodeBurnCheckedInstruction(legacy(message.instructions[1] as Instruction)).data.amount).toBe(4_000_000n);
    expect(() => decodeCloseAccountInstruction(legacy(message.instructions[2] as Instruction))).not.toThrow();
  });

  it('reserves less compute than a trade does, and enough for one Rings instruction', () => {
    expect(COMPUTE_UNITS.burn).toBeGreaterThan(COMPUTE_UNITS.single);
    expect(COMPUTE_UNITS.burn).toBeLessThan(COMPUTE_UNITS.shieldedTrade);
  });
});
