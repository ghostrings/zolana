import { address } from '@solana/kit';
import { PublicKey, SystemInstruction, TransactionInstruction } from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, decodeTransferInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { describe, expect, it } from 'vitest';

import { SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TX_V1_MAX_BYTES } from '../shared/src/constants.js';
import { WALLET_ICONS } from '../shared/src/keyring.js';
import { type RingsContext, SOL_MINT } from '../shared/src/privacy.js';
import {
  PUBLIC_SEND_VISIBILITY,
  SEND_COMPUTE_UNITS,
  TransferError,
  buildPublicSend,
  destinationProblem,
  publicSendInstructions,
} from '../shared/src/transfers.js';
import { decompileMessage, legacyInstructionFields, messageBytesOf, priorityFeeFor } from '../shared/src/tx.js';
import { explainError } from '../web/src/errors.js';
import { ICON_BITMAPS, ICON_SIZE, iconPath, iconSvg } from '../web/src/wallet-icons.js';

const OWNER = '9C6hybhQ6Aycep9jaUnP6uL9ZYvDjUp1aSkFWPUFJtpj';
const FRIEND = '6wHHsx3amW9gvC1YKMbVUwMffYqFa8RRm5A9EKkvsbDV';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL = address(SOL_MINT);

type Built = ReturnType<typeof publicSendInstructions>[number];

const legacy = (instruction: Built): TransactionInstruction => {
  const fields = legacyInstructionFields(instruction);
  return new TransactionInstruction({
    programId: new PublicKey(fields.programId),
    keys: fields.keys.map((key) => ({ pubkey: new PublicKey(key.pubkey), isSigner: key.isSigner, isWritable: key.isWritable })),
    data: Buffer.from(fields.data),
  });
};

/** A wallet's context, as far as these builders use it: an owner, a blockhash and a priority price. */
const context = (who: string, microLamports = 0): RingsContext =>
  ({
    owner: address(who),
    client: { getLatestBlockhash: async () => ({ blockhash: '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi', lastValidBlockHeight: 1_000n }) },
    priority: () => microLamports,
  }) as unknown as RingsContext;

describe('a public send', () => {
  it('of SOL is one plain transfer from the wallet to the recipient', () => {
    const instructions = publicSendInstructions(address(OWNER), { asset: SOL, amount: 20_000_000n, recipient: address(FRIEND) });
    expect(instructions).toHaveLength(1);
    const transfer = SystemInstruction.decodeTransfer(legacy(instructions[0] as Built));
    expect(transfer.fromPubkey.toBase58()).toBe(OWNER);
    expect(transfer.toPubkey.toBase58()).toBe(FRIEND);
    expect(transfer.lamports).toBe(20_000_000n);
  });

  it('of a token opens the recipient’s own token account if it is missing, then moves the amount from the wallet’s', () => {
    const instructions = publicSendInstructions(address(OWNER), { asset: address(USDC), amount: 10_000_000n, recipient: address(FRIEND) });
    expect(instructions).toHaveLength(2);
    const mine = getAssociatedTokenAddressSync(new PublicKey(USDC), new PublicKey(OWNER));
    const theirs = getAssociatedTokenAddressSync(new PublicKey(USDC), new PublicKey(FRIEND));

    const open = legacy(instructions[0] as Built);
    expect(open.programId.toBase58()).toBe(ASSOCIATED_TOKEN_PROGRAM_ID.toBase58());
    // 1 is CreateIdempotent: it does nothing when the account is already there, and never fails for that reason.
    expect([...open.data]).toEqual([1]);
    expect(open.keys.map((key) => key.pubkey.toBase58())).toEqual([OWNER, theirs.toBase58(), FRIEND, USDC, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID.toBase58()]);
    // The wallet pays for it and is the only signer.
    expect(open.keys.filter((key) => key.isSigner).map((key) => key.pubkey.toBase58())).toEqual([OWNER]);

    const move = decodeTransferInstruction(legacy(instructions[1] as Built));
    expect(move.programId.toBase58()).toBe(TOKEN_PROGRAM_ID.toBase58());
    expect(move.keys.source.pubkey.toBase58()).toBe(mine.toBase58());
    expect(move.keys.destination.pubkey.toBase58()).toBe(theirs.toBase58());
    expect(move.keys.owner.pubkey.toBase58()).toBe(OWNER);
    expect(move.keys.owner.isSigner).toBe(true);
    expect(move.data.amount).toBe(10_000_000n);
  });

  it('refuses the wallet itself and an amount that is not one', () => {
    expect(() => publicSendInstructions(address(OWNER), { asset: SOL, amount: 1n, recipient: address(OWNER) })).toThrow(/own address/);
    for (const amount of [0n, -5n]) {
      expect(() => publicSendInstructions(address(OWNER), { asset: SOL, amount, recipient: address(FRIEND) })).toThrow(TransferError);
      expect(() => publicSendInstructions(address(OWNER), { asset: address(USDC), amount, recipient: address(FRIEND) })).toThrow(/greater than zero/);
    }
  });

  it('is one version 1 transaction signed by the wallet alone, with a compute limit to match', async () => {
    for (const [asset, units, count] of [
      [SOL, SEND_COMPUTE_UNITS.sol, 1],
      [address(USDC), SEND_COMPUTE_UNITS.token, 2],
    ] as const) {
      const transaction = await buildPublicSend(context(OWNER, 20_000), { asset, amount: 1_000_000n, recipient: address(FRIEND) });
      const message = decompileMessage(messageBytesOf(transaction));
      expect(message.version).toBe(1);
      expect(message.feePayer).toBe(OWNER);
      expect(message.instructions).toHaveLength(count);
      expect(message.computeUnitLimit).toBe(units);
      expect(message.priorityFeeLamports).toBe(priorityFeeFor(20_000, units));
      expect(Object.keys(transaction.signatures)).toEqual([OWNER]);
      expect(messageBytesOf(transaction).length).toBeLessThan(TX_V1_MAX_BYTES);
    }
  });

  it('says of itself that nothing about it is hidden', () => {
    expect(PUBLIC_SEND_VISIBILITY.length).toBeGreaterThan(0);
    for (const [, value, hidden] of PUBLIC_SEND_VISIBILITY) {
      expect(value).toBe('PUBLIC');
      expect(hidden).toBe(false);
    }
  });
});

describe('where funds may be sent', () => {
  const wallet = { owner: SYSTEM_PROGRAM_ID, executable: false };

  it('is a wallet, or an address nothing has happened at yet', () => {
    expect(destinationProblem(null)).toBeNull();
    expect(destinationProblem(wallet)).toBeNull();
  });

  it('is never a token account, a mint, a program or an account a program runs', () => {
    expect(destinationProblem({ owner: TOKEN_PROGRAM_ID.toBase58(), executable: false })).toMatch(/token account or a token’s mint/);
    expect(destinationProblem({ owner: TOKEN_2022_PROGRAM_ID, executable: false })).toMatch(/token account or a token’s mint/);
    expect(destinationProblem({ owner: 'BPFLoaderUpgradeab1e11111111111111111111111', executable: true })).toMatch(/is a program/);
    // A program is refused as one even when the System program is named as its owner.
    expect(destinationProblem({ owner: SYSTEM_PROGRAM_ID, executable: true })).toMatch(/is a program/);
    expect(destinationProblem({ owner: 'Stake11111111111111111111111111111111111111', executable: false })).toMatch(/run by a program/);
    expect(destinationProblem({ owner: ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), executable: false })).toMatch(/run by a program/);
  });

  it('is refused in words the page shows as they are', () => {
    const refusals = [
      destinationProblem({ owner: TOKEN_PROGRAM_ID.toBase58(), executable: false }),
      destinationProblem({ owner: SYSTEM_PROGRAM_ID, executable: true }),
      destinationProblem({ owner: 'Stake11111111111111111111111111111111111111', executable: false }),
    ];
    for (const refusal of refusals) {
      expect(refusal).toMatch(/Nothing was sent\.$/);
      expect(explainError(new Error(refusal as string))).toBe(refusal);
    }
  });
});

describe('wallet icons', () => {
  it('exist for every name the keyring accepts, on a 12 by 12 grid', () => {
    const drawn = WALLET_ICONS.filter((icon) => icon !== 'auto');
    expect(Object.keys(ICON_BITMAPS).sort()).toEqual([...drawn].sort());
    for (const icon of drawn) {
      const rows = ICON_BITMAPS[icon] as readonly string[];
      expect(rows).toHaveLength(ICON_SIZE);
      for (const row of rows) expect(row).toMatch(/^[.#]{12}$/);
      // Something is drawn, and not a filled square.
      const lit = rows.join('').split('#').length - 1;
      expect(lit).toBeGreaterThan(20);
      expect(lit).toBeLessThan(ICON_SIZE * ICON_SIZE);
    }
    expect(new Set(Object.values(ICON_BITMAPS).map((rows) => rows.join(''))).size).toBe(drawn.length);
  });

  it('are drawn as one path, and fall back to the address mark for anything else', () => {
    expect(iconPath('ghost')).toMatch(/^(M\d+ \d+h\d+v1h-\d+z)+$/);
    expect(iconPath('auto')).toBe('');
    expect(iconPath('unicorn')).toBe('');
    expect(iconSvg('auto', 'Wallet 1', '<svg id="mark"/>')).toBe('<svg id="mark"/>');
    expect(iconSvg('unicorn', 'Wallet 1', '<svg id="mark"/>')).toBe('<svg id="mark"/>');
    // A name can hold anything a person types. None of it reaches the markup as markup.
    const svg = iconSvg('skull', '"><img src=x onerror=1> & co', '');
    expect(svg).toContain('aria-label="img src=x onerror=1  co icon"');
    expect(svg.match(/</g)).toHaveLength(4);
  });
});
