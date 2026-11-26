/**
 * Signature handling for transactions more than one party signs.
 */

import {
  type Address,
  type SignatureBytes,
  type Transaction,
  type TransactionPartialSigner,
  getPublicKeyFromAddress,
  verifySignature,
} from '@solana/kit';

import { messageBytesOf } from './tx.js';

/** Adds one signer's signature and keeps every signature already present. */
export async function addSignature(signer: TransactionPartialSigner, transaction: Transaction): Promise<Transaction> {
  if (!(signer.address in transaction.signatures)) {
    throw new Error('This wallet is not a signer of the transaction.');
  }
  const [produced] = await signer.signTransactions([transaction as Parameters<TransactionPartialSigner['signTransactions']>[0][number]]);
  const signature = produced?.[signer.address];
  if (!signature) throw new Error('The wallet did not return a signature.');
  return withSignature(transaction, signer.address, signature);
}

/** Places an externally produced signature into its slot, preserving signer order. */
export function withSignature(transaction: Transaction, signer: Address, signature: Uint8Array): Transaction {
  if (!(signer in transaction.signatures)) throw new Error('That address is not a signer of the transaction.');
  if (signature.length !== 64) throw new Error('A signature must be 64 bytes.');
  const signatures: Record<string, SignatureBytes | null> = {};
  for (const [address, existing] of Object.entries(transaction.signatures)) {
    signatures[address] = address === signer ? (signature as SignatureBytes) : (existing as SignatureBytes | null);
  }
  return Object.freeze({ ...transaction, signatures: Object.freeze(signatures) }) as unknown as Transaction;
}

/** True when `signature` is `signer`'s Ed25519 signature over the transaction's message. */
export async function isValidSignature(transaction: Transaction, signer: Address, signature: Uint8Array): Promise<boolean> {
  if (signature.length !== 64) return false;
  const key = await getPublicKeyFromAddress(signer);
  return verifySignature(key, signature as SignatureBytes, messageBytesOf(transaction));
}

export function isFullySigned(transaction: Transaction): boolean {
  return Object.values(transaction.signatures).every((signature) => signature !== null);
}
