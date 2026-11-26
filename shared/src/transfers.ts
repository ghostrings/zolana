/**
 * Ordinary transfers out of a wallet's public balance: SOL, or a token from
 * the wallet's own token account. Nothing here touches a private balance, and
 * nothing about such a transfer is hidden: the two wallets, the token and the
 * amount are all on chain.
 */

import type { Address, Instruction, Transaction } from '@solana/kit';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';

import { SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from './constants.js';
import { type RingsContext, SOL_MINT, latestLifetime, priorityOf } from './privacy.js';
import { composeV1, fromLegacyInstruction } from './tx.js';

export class TransferError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'TransferError';
    this.code = code;
  }
}

export const SEND_COMPUTE_UNITS = Object.freeze({
  /** One plain SOL transfer. */
  sol: 5_000,
  /** Opening the recipient's token account when it is missing, and one token transfer. */
  token: 80_000,
});

/** What the chain holds at an address, as far as sending to it is concerned. Null when nothing has happened there yet. */
export interface DestinationAccount {
  readonly owner: string;
  readonly executable: boolean;
}

/**
 * Why an address must not be sent to, or null when it may be. A wallet is an
 * account of the System program, or an address nothing has happened at yet.
 * Anything else (a token account, a token's mint, a program, an account a
 * program runs) is refused: what is sent to one of those is often stuck for
 * good, and pasting a token account in place of its wallet is an easy slip.
 */
export function destinationProblem(account: DestinationAccount | null): string | null {
  if (!account) return null;
  if (account.executable) return 'That address is a program, not a wallet. Nothing was sent.';
  if (account.owner === TOKEN_PROGRAM_ID || account.owner === TOKEN_2022_PROGRAM_ID) {
    return 'That address is a token account or a token’s mint, not a wallet. Use the address of the wallet itself. Nothing was sent.';
  }
  if (account.owner !== SYSTEM_PROGRAM_ID) return 'That address is an account run by a program, not a wallet, so funds sent to it could be stuck. Nothing was sent.';
  return null;
}

export interface PublicSend {
  /** `SOL_MINT` for SOL, otherwise the token's mint. */
  readonly asset: Address;
  /** Base units. */
  readonly amount: bigint;
  readonly recipient: Address;
  /**
   * For a token of the Token-2022 program: that program, and the token's
   * decimals as its mint has them. Absent for SOL and for an SPL Token mint.
   */
  readonly token2022?: { readonly decimals: number };
}

/**
 * The instructions of a public transfer from `owner`. SOL is a plain system
 * transfer. A token leaves the owner's own token account for the recipient's,
 * which is opened first when it does not exist, paid for by the owner. Pure.
 */
export function publicSendInstructions(owner: Address, send: PublicSend): Instruction[] {
  if (send.recipient === owner) throw new TransferError('SELF', 'That is this wallet’s own address.');
  if (send.amount <= 0n) throw new TransferError('BAD_AMOUNT', 'Enter an amount greater than zero.');
  const from = new PublicKey(owner);
  const to = new PublicKey(send.recipient);
  if (send.asset === SOL_MINT) return [fromLegacyInstruction(SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: send.amount }))];
  const mint = new PublicKey(send.asset);
  if (send.token2022) {
    // A Token-2022 token: its accounts are the ones that program gives, and the transfer names
    // the mint and its decimals, so it cannot move anything but this token.
    const { decimals } = send.token2022;
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new TransferError('BAD_TOKEN', 'The decimals of this token could not be read, so nothing was built.');
    const program = new PublicKey(TOKEN_2022_PROGRAM_ID);
    const source = getAssociatedTokenAddressSync(mint, from, true, program);
    const destination = getAssociatedTokenAddressSync(mint, to, true, program);
    return [
      fromLegacyInstruction(createAssociatedTokenAccountIdempotentInstruction(from, destination, to, mint, program)),
      fromLegacyInstruction(createTransferCheckedInstruction(source, mint, destination, from, send.amount, decimals, [], program)),
    ];
  }
  const source = getAssociatedTokenAddressSync(mint, from, true);
  const destination = getAssociatedTokenAddressSync(mint, to, true);
  return [
    fromLegacyInstruction(createAssociatedTokenAccountIdempotentInstruction(from, destination, to, mint)),
    fromLegacyInstruction(createTransferInstruction(source, destination, from, send.amount)),
  ];
}

/** One transaction, signed by the wallet alone, that makes a public transfer. */
export async function buildPublicSend(ctx: RingsContext, send: PublicSend): Promise<Transaction> {
  const units = send.asset === SOL_MINT ? SEND_COMPUTE_UNITS.sol : SEND_COMPUTE_UNITS.token;
  return composeV1({
    feePayer: ctx.owner,
    lifetime: await latestLifetime(ctx.client),
    instructions: publicSendInstructions(ctx.owner, send),
    computeUnitLimit: units,
    priorityFeeLamports: priorityOf(ctx, units),
  });
}

type Row = readonly [label: string, value: string, hidden: boolean];

/** A public transfer hides nothing. */
export const PUBLIC_SEND_VISIBILITY: readonly Row[] = Object.freeze([
  ['Your wallet and the recipient’s', 'PUBLIC', false],
  ['Which token', 'PUBLIC', false],
  ['How much', 'PUBLIC', false],
] as const);
