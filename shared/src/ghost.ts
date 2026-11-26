/**
 * Ghost fill: an atomic swap made of two confidential transfers in one Solana
 * transaction, one from the trader to the desk and one from the desk to the
 * trader. Both parties sign the same transaction, so either both transfers
 * land or neither does. Nobody holds the other side's funds at any point.
 *
 * What an observer sees on chain: the two wallets, and that each sent the other
 * a confidential transfer. The asset and the amount of both legs are encrypted.
 *
 * This module is the part both sides share:
 *  - a JSON codec for the SDK's `TransactInstructionData`, so a leg travels as
 *    structured data and the receiver rebuilds the instruction itself instead
 *    of trusting opaque bytes;
 *  - `assertPlainTransfer`, the structural rules a leg must satisfy before the
 *    counterparty will sign next to it;
 *  - `readIncoming`, which decrypts a leg with the receiver's viewing key and
 *    checks every decrypted output against the commitment the instruction
 *    appends to the tree. A leg that does not commit to the promised asset and
 *    amount for the receiver is rejected before any signature is produced.
 */

import { type Address, type Instruction, type Signature, getAddressEncoder } from '@solana/kit';
import type { ShieldedKeypair } from '@heliuslabs/spr';
import type { TransactInstructionData } from '@heliuslabs/spr/interface';
import { X25519PublicKey } from '@heliuslabs/spr/keypair';
import {
  type AssetRegistry,
  type IndexedShieldedTransaction,
  decryptToBalances,
} from '@heliuslabs/spr/transaction';

import { COMPUTE_UNITS, SPP_PROGRAM_ID } from './constants.js';
import { type Lifetime, composeV1, decompileMessage, requiredSigners } from './tx.js';

export class GhostError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'GhostError';
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/* JSON codec                                                          */
/* ------------------------------------------------------------------ */

const BYTES_TAG = '$b';
const BIGINT_TAG = '$n';
const MAX_JSON_BYTES = 16_384;
const MAX_DEPTH = 8;

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  if (text.length > MAX_JSON_BYTES || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) {
    throw new GhostError('BAD_ENCODING', 'A byte field is not valid base64.');
  }
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** bigint and Uint8Array survive the trip; everything else is plain JSON. */
export function encodeTransactData(data: TransactInstructionData): string {
  return JSON.stringify(data, (_key, value: unknown) => {
    if (typeof value === 'bigint') return { [BIGINT_TAG]: value.toString() };
    if (value instanceof Uint8Array) return { [BYTES_TAG]: toBase64(value) };
    return value;
  });
}

function revive(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) throw new GhostError('BAD_ENCODING', 'The payload is nested too deeply.');
  if (value === null || typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => revive(item, depth + 1));
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length === 1 && keys[0] === BYTES_TAG) {
      if (typeof record[BYTES_TAG] !== 'string') throw new GhostError('BAD_ENCODING', 'A byte field is malformed.');
      return fromBase64(record[BYTES_TAG]);
    }
    if (keys.length === 1 && keys[0] === BIGINT_TAG) {
      const text = record[BIGINT_TAG];
      if (typeof text !== 'string' || !/^(0|[1-9][0-9]{0,39})$/.test(text)) {
        throw new GhostError('BAD_ENCODING', 'An integer field is malformed.');
      }
      return BigInt(text);
    }
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        throw new GhostError('BAD_ENCODING', 'The payload contains a forbidden key.');
      }
      out[key] = revive(record[key], depth + 1);
    }
    return out;
  }
  throw new GhostError('BAD_ENCODING', 'The payload contains an unsupported value.');
}

const TOP_LEVEL_KEYS = new Set([
  'expiryUnixTs',
  'txViewingPk',
  'salt',
  'interfaceTransfers',
  'dataHash',
  'ringDataHash',
  'outputs',
  'messages',
  'privateTxHash',
  'circuit',
  'proof',
  'inputs',
  'treeContexts',
]);

function bytesOf(value: unknown, length: number, label: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new GhostError('BAD_SHAPE', `${label} must be ${length} bytes.`);
  }
  return value;
}

function smallInt(value: unknown, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) {
    throw new GhostError('BAD_SHAPE', `${label} is out of range.`);
  }
  return value;
}

/**
 * Parses and structurally validates a leg. The result is safe to hand to the
 * SDK's `transactInstruction`, which re-checks the wire encoding itself.
 * Semantic rules (no public legs and so on) are `assertPlainTransfer`'s job.
 */
export function decodeTransactData(json: string): TransactInstructionData {
  if (typeof json !== 'string' || json.length === 0 || json.length > MAX_JSON_BYTES) {
    throw new GhostError('BAD_ENCODING', 'The transfer payload is missing or too large.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new GhostError('BAD_ENCODING', 'The transfer payload is not valid JSON.');
  }
  const value = revive(parsed, 0);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GhostError('BAD_SHAPE', 'The transfer payload must be an object.');
  }
  const data = value as Record<string, unknown>;
  for (const key of Object.keys(data)) {
    if (!TOP_LEVEL_KEYS.has(key)) throw new GhostError('BAD_SHAPE', `Unexpected field: ${key}.`);
  }
  if (typeof data.expiryUnixTs !== 'bigint') throw new GhostError('BAD_SHAPE', 'expiryUnixTs must be an integer.');
  bytesOf(data.txViewingPk, 33, 'txViewingPk');
  bytesOf(data.salt, 16, 'salt');
  bytesOf(data.privateTxHash, 32, 'privateTxHash');
  for (const field of ['interfaceTransfers', 'outputs', 'messages', 'inputs', 'treeContexts'] as const) {
    if (!Array.isArray(data[field])) throw new GhostError('BAD_SHAPE', `${field} must be a list.`);
  }
  const circuit = data.circuit as Record<string, unknown> | undefined;
  if (typeof circuit !== 'object' || circuit === null || typeof circuit.kind !== 'string') {
    throw new GhostError('BAD_SHAPE', 'circuit is malformed.');
  }
  smallInt(circuit.inputs, 64, 'circuit.inputs');
  smallInt(circuit.outputs, 64, 'circuit.outputs');
  smallInt(circuit.publicAssetSlots, 8, 'circuit.publicAssetSlots');
  const proof = data.proof as Record<string, unknown> | undefined;
  if (
    typeof proof !== 'object' ||
    proof === null ||
    !(proof.a instanceof Uint8Array) ||
    !(proof.b instanceof Uint8Array) ||
    !(proof.c instanceof Uint8Array) ||
    proof.a.length + proof.b.length + proof.c.length > 512
  ) {
    throw new GhostError('BAD_SHAPE', 'proof is malformed.');
  }
  for (const [index, output] of (data.outputs as unknown[]).entries()) {
    const record = output as Record<string, unknown>;
    if (typeof record !== 'object' || record === null) throw new GhostError('BAD_SHAPE', `outputs[${index}] is malformed.`);
    bytesOf(record.utxoHash, 32, `outputs[${index}].utxoHash`);
    const tag = record.ownerTag as Record<string, unknown> | undefined;
    if (typeof tag !== 'object' || tag === null) throw new GhostError('BAD_SHAPE', `outputs[${index}].ownerTag is malformed.`);
    if (tag.kind === 'inline') bytesOf(tag.value, 32, `outputs[${index}].ownerTag.value`);
    else if (tag.kind === 'account') smallInt(tag.index, 63, `outputs[${index}].ownerTag.index`);
    else throw new GhostError('BAD_SHAPE', `outputs[${index}].ownerTag has an unknown kind.`);
    if (record.data !== undefined && !(record.data instanceof Uint8Array)) {
      throw new GhostError('BAD_SHAPE', `outputs[${index}].data must be bytes.`);
    }
  }
  for (const [index, input] of (data.inputs as unknown[]).entries()) {
    const record = input as Record<string, unknown>;
    if (typeof record !== 'object' || record === null) throw new GhostError('BAD_SHAPE', `inputs[${index}] is malformed.`);
    bytesOf(record.nullifierHash, 32, `inputs[${index}].nullifierHash`);
    smallInt(record.treeIndex, 4, `inputs[${index}].treeIndex`);
  }
  for (const [index, context] of (data.treeContexts as unknown[]).entries()) {
    const record = context as Record<string, unknown>;
    if (typeof record !== 'object' || record === null) throw new GhostError('BAD_SHAPE', `treeContexts[${index}] is malformed.`);
    smallInt(record.utxoTreeRootIndex, 65_535, `treeContexts[${index}].utxoTreeRootIndex`);
    smallInt(record.nullifierTreeRootIndex, 65_535, `treeContexts[${index}].nullifierTreeRootIndex`);
  }
  return data as unknown as TransactInstructionData;
}

/* ------------------------------------------------------------------ */
/* Structural rules for a leg                                          */
/* ------------------------------------------------------------------ */

export const GHOST_LIMITS = Object.freeze({
  maxInputs: 5,
  maxOutputs: 4,
  maxOutputDataBytes: 200,
});

/**
 * A leg may only be a default-ring, owner-signed, private-to-private transfer
 * out of a single tree. In particular it may not carry a public deposit or
 * withdrawal: those move public funds of an account that signs the
 * transaction, and both parties sign.
 */
export function assertPlainTransfer(data: TransactInstructionData): void {
  const fail = (message: string): never => {
    throw new GhostError('NOT_A_PLAIN_TRANSFER', message);
  };
  if (data.circuit.kind !== 'confidentialSigner') {
    fail('Only owner-signed default-ring transfers are accepted.');
  }
  if (data.interfaceTransfers.length !== 0) fail('The transfer carries a public deposit or withdrawal.');
  if (data.dataHash !== undefined || data.ringDataHash !== undefined) fail('The transfer carries program or ring data.');
  if (data.messages.length !== 0) fail('The transfer carries extra messages.');
  if (data.treeContexts.length !== 1) fail('The transfer must spend from exactly one tree.');
  if (data.inputs.length < 1 || data.inputs.length > GHOST_LIMITS.maxInputs) {
    fail(`The transfer must spend between 1 and ${GHOST_LIMITS.maxInputs} notes. Merge the balance first.`);
  }
  if (data.inputs.some((input) => input.treeIndex !== 0)) fail('The transfer references a second tree.');
  if (data.outputs.length < 1 || data.outputs.length > GHOST_LIMITS.maxOutputs) {
    fail(`The transfer must create between 1 and ${GHOST_LIMITS.maxOutputs} notes.`);
  }
  for (const output of data.outputs) {
    if ((output.data?.length ?? 0) > GHOST_LIMITS.maxOutputDataBytes) fail('An output carries too much data.');
  }
  const nullifiers = new Set(data.inputs.map((input) => toBase64(input.nullifierHash)));
  if (nullifiers.size !== data.inputs.length) fail('The transfer repeats an input.');
}

/* ------------------------------------------------------------------ */
/* Instruction checks                                                  */
/* ------------------------------------------------------------------ */

const WRITABLE_BIT = 0b01;
const SIGNER_BIT = 0b10;

function sameBytes(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return diff === 0;
}

/**
 * Program, account addresses in order, and data all equal. Roles are compared
 * separately: compiling a message raises every occurrence of an account to the
 * highest privilege it has anywhere in that message, so an instruction read
 * back from a message can legitimately differ in role from the one put in.
 */
export function sameInstruction(a: Instruction, b: Instruction): boolean {
  if (a.programAddress !== b.programAddress) return false;
  const left = a.accounts ?? [];
  const right = b.accounts ?? [];
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index]?.address !== right[index]?.address) return false;
  }
  return sameBytes(a.data as Uint8Array | undefined, b.data as Uint8Array | undefined);
}

/** The privilege each account ends up with once these instructions share a message. */
export function mergedRoles(feePayer: Address, instructions: readonly Instruction[]): Map<Address, number> {
  const roles = new Map<Address, number>([[feePayer, WRITABLE_BIT | SIGNER_BIT]]);
  for (const instruction of instructions) {
    for (const account of instruction.accounts ?? []) {
      roles.set(account.address, (roles.get(account.address) ?? 0) | (account.role & (WRITABLE_BIT | SIGNER_BIT)));
    }
  }
  return roles;
}

/**
 * The signers of a leg must be exactly the payer and the leg's owner, and the
 * counterparty may appear in it nowhere as a signer or as a writable account.
 * This is what makes it safe to sign a transaction that contains a leg built
 * by someone else.
 */
export function assertLegAccounts(
  instruction: Instruction,
  expected: Readonly<{ payer: Address; owner: Address; counterparty: Address }>,
): void {
  if (instruction.programAddress !== SPP_PROGRAM_ID) {
    throw new GhostError('WRONG_PROGRAM', 'A leg does not call the Solana Privacy Program.');
  }
  const accounts = instruction.accounts ?? [];
  if (accounts.length === 0 || accounts[0]?.address !== expected.payer) {
    throw new GhostError('WRONG_PAYER', 'A leg names an unexpected fee payer.');
  }
  for (const [index, account] of accounts.entries()) {
    const signer = (account.role & SIGNER_BIT) !== 0;
    const writable = (account.role & WRITABLE_BIT) !== 0;
    if (signer && account.address !== expected.payer && account.address !== expected.owner) {
      throw new GhostError('UNEXPECTED_SIGNER', `A leg asks account ${index} to sign.`);
    }
    if (
      account.address === expected.counterparty &&
      expected.counterparty !== expected.payer &&
      (signer || writable)
    ) {
      throw new GhostError('COUNTERPARTY_TOUCHED', 'A leg uses the counterparty wallet as a signer or writable account.');
    }
    if (account.address === expected.payer && index !== 0 && expected.payer !== expected.owner && signer) {
      // The payer may sign once, as the payer. Anywhere else it would be
      // authorizing a spend of its own notes.
      throw new GhostError('PAYER_AS_OWNER', 'A leg lists the fee payer as a note owner.');
    }
  }
}

/* ------------------------------------------------------------------ */
/* The shared transaction                                              */
/* ------------------------------------------------------------------ */

export interface GhostLegs {
  readonly desk: Address;
  readonly trader: Address;
  /** Spends the trader's notes, pays the desk. Built with `payer = desk`, `ownerSigners = [trader]`. */
  readonly traderLeg: Instruction;
  /** Spends the desk's notes, pays the trader. Built with `payer = desk`, `ownerSigners = [desk]`. */
  readonly deskLeg: Instruction;
}

/** The desk pays the fee, so a trader needs no public SOL to trade. */
export function composeGhostFill(
  legs: GhostLegs,
  lifetime: Lifetime,
  priorityFeeLamports?: bigint,
): ReturnType<typeof composeV1> {
  assertLegAccounts(legs.traderLeg, { payer: legs.desk, owner: legs.trader, counterparty: legs.desk });
  assertLegAccounts(legs.deskLeg, { payer: legs.desk, owner: legs.desk, counterparty: legs.trader });
  return composeV1({
    feePayer: legs.desk,
    lifetime,
    instructions: [legs.traderLeg, legs.deskLeg],
    computeUnitLimit: COMPUTE_UNITS.ghostFill,
    ...(priorityFeeLamports === undefined ? {} : { priorityFeeLamports }),
  });
}

/**
 * What a party checks before it signs a message it did not compile itself:
 * the message is exactly the two legs it already inspected, in order, paid for
 * by the desk, with no third instruction and no third signer.
 */
export function assertGhostMessage(messageBytes: Uint8Array, legs: GhostLegs): void {
  const message = decompileMessage(messageBytes);
  if (message.version !== 1) throw new GhostError('WRONG_VERSION', 'The transaction is not version 1.');
  if (message.feePayer !== legs.desk) throw new GhostError('WRONG_PAYER', 'The desk must pay the transaction fee.');
  if (message.instructions.length !== 2) {
    throw new GhostError('EXTRA_INSTRUCTIONS', `The transaction has ${message.instructions.length} instructions; a fill has exactly two.`);
  }
  const [first, second] = message.instructions;
  if (first === undefined || second === undefined || !sameInstruction(first, legs.traderLeg)) {
    throw new GhostError('LEG_MISMATCH', "The first instruction is not the trader's transfer.");
  }
  if (!sameInstruction(second, legs.deskLeg)) {
    throw new GhostError('LEG_MISMATCH', "The second instruction is not the desk's transfer.");
  }
  // Privileges: every account must hold exactly the role the two inspected
  // legs give it, no more. This is what stops a compiled message from quietly
  // making the trader's wallet writable or adding a signer.
  assertLegAccounts(legs.traderLeg, { payer: legs.desk, owner: legs.trader, counterparty: legs.desk });
  assertLegAccounts(legs.deskLeg, { payer: legs.desk, owner: legs.desk, counterparty: legs.trader });
  const expectedRoles = mergedRoles(legs.desk, [legs.traderLeg, legs.deskLeg]);
  for (const instruction of message.instructions) {
    for (const account of instruction.accounts ?? []) {
      const expected = expectedRoles.get(account.address);
      if (expected === undefined || (account.role & (WRITABLE_BIT | SIGNER_BIT)) !== expected) {
        throw new GhostError('ROLE_MISMATCH', 'An account has a different privilege in the transaction than in the inspected transfers.');
      }
    }
  }
  const signers = requiredSigners(message.feePayer, message.instructions);
  if (signers.length !== 2 || !signers.includes(legs.desk) || !signers.includes(legs.trader)) {
    throw new GhostError('UNEXPECTED_SIGNER', 'The transaction asks someone other than the two parties to sign.');
  }
}

/* ------------------------------------------------------------------ */
/* Decrypt-and-verify                                                  */
/* ------------------------------------------------------------------ */

const PLACEHOLDER_SIGNATURE = '1'.repeat(64) as Signature;

/**
 * The view an indexer would return for this instruction once it lands, built
 * from the instruction itself. Leaf indexes are not part of a transact output's
 * commitment, so placeholders are fine.
 */
export function syntheticTransaction(
  data: TransactInstructionData,
  instructionAccounts: readonly Address[],
  tree: Address,
  treeId: number,
): IndexedShieldedTransaction {
  const encoder = getAddressEncoder();
  const outputSlots = data.outputs.map((output, index) => {
    let viewTag: Uint8Array;
    if (output.ownerTag.kind === 'inline') {
      viewTag = output.ownerTag.value;
    } else {
      const account = instructionAccounts[output.ownerTag.index];
      if (account === undefined) throw new GhostError('BAD_SHAPE', 'An output names an account that is not in the instruction.');
      viewTag = new Uint8Array(encoder.encode(account));
    }
    return {
      viewTag: viewTag as IndexedShieldedTransaction['outputSlots'][number]['viewTag'],
      outputContext: { hash: output.utxoHash, tree, treeId, leafIndex: BigInt(index) },
      payload: output.data ?? new Uint8Array(),
    };
  });
  return {
    slot: 0n,
    txSignature: PLACEHOLDER_SIGNATURE,
    txViewingPublicKey: X25519PublicKey.fromBytes(data.txViewingPk),
    salt: data.salt,
    outputSlots,
    messages: [],
    nullifiers: data.inputs.map((input) => input.nullifierHash),
    proofless: false,
  };
}

export interface IncomingParams {
  readonly data: TransactInstructionData;
  /** Addresses of the instruction built from `data`, in order. */
  readonly instructionAccounts: readonly Address[];
  readonly recipient: ShieldedKeypair;
  /** Must already map the expected asset's id to its mint. */
  readonly registry: AssetRegistry;
  readonly tree: Address;
  readonly treeId: number;
}

/**
 * Decrypts every output addressed to `recipient` and returns the amount of
 * `asset` they add up to. An output only counts when the decrypted note hashes
 * to the commitment the instruction appends, with `recipient` as its owner.
 */
export async function readIncoming(params: IncomingParams, asset: Address): Promise<bigint> {
  const transaction = syntheticTransaction(params.data, params.instructionAccounts, params.tree, params.treeId);
  const balances = await decryptToBalances({
    keypair: params.recipient,
    registry: params.registry,
    transactions: [transaction],
  });
  return balances.balance(asset).amount;
}

export async function assertIncoming(
  params: IncomingParams,
  expected: Readonly<{ asset: Address; minAmount: bigint }>,
): Promise<bigint> {
  const received = await readIncoming(params, expected.asset);
  if (received < expected.minAmount) {
    throw new GhostError(
      'UNDERPAID',
      `The counterparty's transfer commits ${received.toString()} units to you; the quote promised at least ${expected.minAmount.toString()}.`,
    );
  }
  return received;
}

/* ------------------------------------------------------------------ */
/* Wire types                                                          */
/* ------------------------------------------------------------------ */

export type GhostSide = 'buy' | 'sell';

export interface GhostQuote {
  readonly id: string;
  readonly side: GhostSide;
  readonly mint: string;
  readonly desk: string;
  /** What the trader sends, in base units, and the mint it is denominated in. */
  readonly payAsset: string;
  readonly payAmount: string;
  /** What the trader receives. */
  readonly receiveAsset: string;
  readonly receiveAmount: string;
  /** What the same trade would return on the public curve right now, for comparison. */
  readonly referenceAmount: string;
  readonly spreadBps: number;
  readonly expiresAtMs: number;
}

export interface GhostPrepareRequest {
  readonly quoteId: string;
  readonly trader: string;
  /** `encodeTransactData` of the trader's leg. */
  readonly leg: string;
}

export interface GhostPrepareResponse {
  readonly quoteId: string;
  /** `encodeTransactData` of the desk's leg, so the trader can decrypt and check it. */
  readonly deskLeg: string;
  /** Base64 of the compiled v1 transaction message both parties sign. */
  readonly message: string;
  /** When the desk stops waiting for the trader's signature, in milliseconds since 1970. */
  readonly signByMs?: number;
}

export interface GhostSubmitRequest {
  readonly quoteId: string;
  /** Base64 of the trader's 64-byte signature over `message`. */
  readonly signature: string;
}

export interface GhostSubmitResponse {
  readonly signature: string;
  readonly slot: string;
}
