/**
 * Version 1 transaction plumbing.
 *
 * The Rings SDK builds version 1 transactions (up to 4,096 bytes, compute
 * limits in the message header, no address lookup tables). The Meteora SDKs
 * return legacy web3.js instructions. Everything is converged here into Kit
 * instructions and compiled into one v1 message, so a private leg and a public
 * swap can share a single atomic transaction.
 */

import {
  AccountRole,
  type Address,
  type Blockhash,
  type Instruction,
  type Transaction,
  type TransactionMessageBytes,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  decompileTransactionMessage,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getTransactionSize,
  pipe,
  setTransactionMessageConfig,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import type { TransactionInstruction } from '@solana/web3.js';

import { LOADED_ACCOUNTS_DATA_SIZE_LIMIT, TX_V1_MAX_ACCOUNTS, TX_V1_MAX_BYTES } from './constants.js';

export class TxError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'TxError';
    this.code = code;
  }
}

export interface Lifetime {
  readonly blockhash: Blockhash;
  readonly lastValidBlockHeight: bigint;
}

export interface ComposeInput {
  readonly feePayer: Address;
  readonly lifetime: Lifetime;
  readonly instructions: readonly Instruction[];
  readonly computeUnitLimit: number;
  /** The whole transaction's priority fee in lamports, not a price per compute unit. */
  readonly priorityFeeLamports?: bigint;
}

/**
 * A transaction's whole priority fee: a price per compute unit, in
 * micro-lamports, times the units the transaction reserves. Validators order
 * by exactly that ratio, so pricing per unit keeps a small transaction and a
 * large one equally likely to land.
 */
export function priorityFeeFor(microLamportsPerUnit: number, computeUnitLimit: number): bigint {
  if (!Number.isFinite(microLamportsPerUnit) || microLamportsPerUnit <= 0) return 0n;
  return BigInt(Math.ceil((microLamportsPerUnit * computeUnitLimit) / 1_000_000));
}

/** Compiles one unsigned v1 transaction and refuses anything over the v1 limits. */
export function composeV1(input: ComposeInput): Transaction {
  if (input.instructions.length === 0) throw new TxError('EMPTY', 'A transaction needs at least one instruction.');
  if (!Number.isInteger(input.computeUnitLimit) || input.computeUnitLimit <= 0 || input.computeUnitLimit > 1_400_000) {
    throw new TxError('COMPUTE_LIMIT', 'The compute unit limit must be between 1 and 1,400,000.');
  }
  // Counted here, before compiling, so that a transaction with too many accounts is refused with
  // this file's own error whatever the compiler would say about it.
  const accounts = countAccounts(input.feePayer, input.instructions);
  if (accounts > TX_V1_MAX_ACCOUNTS) {
    throw new TxError('TOO_MANY_ACCOUNTS', `The transaction names ${accounts} accounts; version 1 allows ${TX_V1_MAX_ACCOUNTS}.`);
  }
  const message = pipe(
    createTransactionMessage({ version: 1 }),
    (tx) => setTransactionMessageFeePayer(input.feePayer, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(input.lifetime, tx),
    (tx) =>
      setTransactionMessageConfig(
        {
          computeUnitLimit: input.computeUnitLimit,
          loadedAccountsDataSizeLimit: LOADED_ACCOUNTS_DATA_SIZE_LIMIT,
          ...(input.priorityFeeLamports === undefined || input.priorityFeeLamports <= 0n ? {} : { priorityFeeLamports: input.priorityFeeLamports }),
        },
        tx,
      ),
    (tx) => appendTransactionMessageInstructions(input.instructions, tx),
  );
  const compiled = compileTransaction(message) as Transaction;
  const size = getTransactionSize(compiled);
  if (size > TX_V1_MAX_BYTES) {
    throw new TxError('TOO_LARGE', `The transaction is ${size} bytes; version 1 allows ${TX_V1_MAX_BYTES}.`);
  }
  return compiled;
}

/** How many distinct accounts a transaction with this fee payer and these instructions names. Version 1 allows 64. */
export function countAccounts(feePayer: Address, instructions: readonly Instruction[]): number {
  const seen = new Set<string>([feePayer]);
  for (const instruction of instructions) {
    seen.add(instruction.programAddress);
    for (const account of instruction.accounts ?? []) seen.add(account.address);
  }
  return seen.size;
}

export interface DecompiledV1 {
  readonly version: number | 'legacy';
  readonly feePayer: Address;
  readonly instructions: readonly Instruction[];
  readonly lifetime: Lifetime | undefined;
  readonly computeUnitLimit: number | undefined;
  /** The whole transaction's priority fee in lamports; undefined when it carries none. */
  readonly priorityFeeLamports: bigint | undefined;
}

/** Reads a compiled message back into instructions. v1 has no lookup tables, so this needs no RPC. */
export function decompileMessage(messageBytes: Uint8Array): DecompiledV1 {
  const compiled = getCompiledTransactionMessageDecoder().decode(messageBytes);
  const message = decompileTransactionMessage(compiled as Parameters<typeof decompileTransactionMessage>[0]) as unknown as {
    version: number | 'legacy';
    feePayer: { address: Address };
    instructions: readonly Instruction[];
    lifetimeConstraint?: { blockhash?: Blockhash; lastValidBlockHeight?: bigint };
    config?: { computeUnitLimit?: number; priorityFeeLamports?: bigint };
  };
  const constraint = message.lifetimeConstraint;
  return {
    version: message.version,
    feePayer: message.feePayer.address,
    instructions: message.instructions,
    lifetime:
      constraint?.blockhash === undefined
        ? undefined
        : { blockhash: constraint.blockhash, lastValidBlockHeight: constraint.lastValidBlockHeight ?? 0n },
    computeUnitLimit: message.config?.computeUnitLimit,
    priorityFeeLamports: message.config?.priorityFeeLamports === undefined ? undefined : BigInt(message.config.priorityFeeLamports),
  };
}

/** The compiled message of a transaction as plain bytes. */
export function messageBytesOf(transaction: Transaction): Uint8Array {
  return new Uint8Array(transaction.messageBytes as unknown as Uint8Array);
}

export function instructionsOf(transaction: Transaction): readonly Instruction[] {
  return decompileMessage(messageBytesOf(transaction)).instructions;
}

/** web3.js (legacy) instruction -> Kit instruction. */
export function fromLegacyInstruction(instruction: TransactionInstruction): Instruction {
  return {
    programAddress: address(instruction.programId.toBase58()),
    accounts: instruction.keys.map((key) => ({
      address: address(key.pubkey.toBase58()),
      role: key.isSigner
        ? key.isWritable
          ? AccountRole.WRITABLE_SIGNER
          : AccountRole.READONLY_SIGNER
        : key.isWritable
          ? AccountRole.WRITABLE
          : AccountRole.READONLY,
    })),
    data: new Uint8Array(instruction.data),
  };
}

export function fromLegacyInstructions(instructions: readonly TransactionInstruction[]): Instruction[] {
  return instructions.map(fromLegacyInstruction);
}

/**
 * Kit instruction -> the plain fields of a web3.js (legacy) instruction, for
 * the operator scripts, which send legacy transactions. The caller wraps them
 * in a `TransactionInstruction`; this file stays free of web3.js at run time.
 */
export function legacyInstructionFields(instruction: Instruction): {
  programId: string;
  keys: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
  data: Uint8Array;
} {
  return {
    programId: instruction.programAddress,
    keys: (instruction.accounts ?? []).map((account) => ({
      pubkey: account.address,
      isSigner: account.role === AccountRole.WRITABLE_SIGNER || account.role === AccountRole.READONLY_SIGNER,
      isWritable: account.role === AccountRole.WRITABLE_SIGNER || account.role === AccountRole.WRITABLE,
    })),
    data: new Uint8Array(instruction.data ?? new Uint8Array()),
  };
}

/** Every address an instruction list asks to sign. */
export function requiredSigners(feePayer: Address, instructions: readonly Instruction[]): Address[] {
  const signers = new Set<Address>([feePayer]);
  for (const instruction of instructions) {
    for (const account of instruction.accounts ?? []) {
      if (account.role === AccountRole.WRITABLE_SIGNER || account.role === AccountRole.READONLY_SIGNER) {
        signers.add(account.address);
      }
    }
  }
  return [...signers];
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(text: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new TxError('BAD_BASE64', 'Expected base64.');
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function messageToBase64(transaction: Transaction): string {
  return bytesToBase64(messageBytesOf(transaction));
}

/** A transaction with no signatures yet, rebuilt from message bytes received over the wire. */
export function transactionFromMessage(messageBytes: Uint8Array, signers: readonly Address[]): Transaction {
  const signatures: Record<string, null> = {};
  for (const signer of signers) signatures[signer] = null;
  return Object.freeze({
    messageBytes: messageBytes as unknown as TransactionMessageBytes,
    signatures: Object.freeze(signatures),
  }) as unknown as Transaction;
}

export function wireBase64(transaction: Transaction): string {
  return getBase64EncodedWireTransaction(transaction);
}
