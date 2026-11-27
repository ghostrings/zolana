/**
 * Reads one transaction of the Solana Privacy Program the way an outsider can.
 *
 * Three public sources, and nothing else:
 *
 *  - the transaction itself: who signed, who paid, which programs ran;
 *  - its balance changes: what moved into or out of a Rings vault is the
 *    amount of a shield or an unshield, whatever instruction caused it;
 *  - the indexer's view of its outputs: each output of a Default Ring
 *    transaction is tagged with the address of the wallet it belongs to.
 *
 * It does not parse the program's instruction data beyond its first byte (the
 * kind of instruction), so a new instruction layout cannot make it misread an
 * amount: amounts come from the vault, and a kind it does not know is "other".
 * Everything is checked for shape before it is used, and a transaction that
 * cannot be read throws `UnreadableTransaction` instead of producing a row.
 */

import bs58 from 'bs58';
import { getCompiledTransactionMessageDecoder, getTransactionDecoder } from '@solana/kit';
import { InstructionTag } from '@heliuslabs/spr/interface';

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  DAMM_V2_PROGRAM_ID,
  DBC_PROGRAM_ID,
  SPP_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  USER_REGISTRY_PROGRAM_ID,
  WSOL_MINT,
} from '../../../shared/src/constants.js';
import type { RingKind, RingLeg } from '../../../shared/src/rings-api.js';

export class UnreadableTransaction extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnreadableTransaction';
  }
}

/* ------------------------------------------------------------------ */
/* What the RPC and the indexer hand over                              */
/* ------------------------------------------------------------------ */

export interface RawTokenBalance {
  readonly accountIndex: number;
  readonly mint: string;
  readonly owner?: string | null;
  readonly uiTokenAmount: { readonly amount: string };
}

export interface RawInnerInstruction {
  readonly programIdIndex: number;
  readonly accounts: readonly number[];
  /** Base58. */
  readonly data: string;
}

export interface RawMeta {
  readonly err: unknown;
  readonly fee: number;
  readonly preBalances: readonly number[];
  readonly postBalances: readonly number[];
  readonly preTokenBalances?: readonly RawTokenBalance[] | null;
  readonly postTokenBalances?: readonly RawTokenBalance[] | null;
  readonly innerInstructions?: ReadonlyArray<{ readonly index: number; readonly instructions: readonly RawInnerInstruction[] }> | null;
  readonly loadedAddresses?: { readonly writable?: readonly string[]; readonly readonly?: readonly string[] } | null;
}

/** The answer of `getTransaction` asked with `encoding: "base64"`. */
export interface RawTransaction {
  readonly slot: number;
  readonly blockTime?: number | null;
  readonly transaction: readonly [string, string] | readonly string[];
  readonly meta: RawMeta | null;
}

/** One Rings event of a transaction, as the indexer reports it, reduced to what is used here. */
export interface RingEvent {
  /** The owner tag of each output, base58. On the Default Ring it is the owning wallet's address. */
  readonly tags: readonly string[];
  readonly nullifiers: number;
  /** A deposit that needed no proof. */
  readonly proofless: boolean;
  /** The ring program that authorised the event. Null on the Default Ring. */
  readonly ring: string | null;
}

/* ------------------------------------------------------------------ */
/* The message                                                         */
/* ------------------------------------------------------------------ */

export interface ReadInstruction {
  readonly program: string;
  readonly accounts: readonly string[];
  /** Whether the account at the same position signed the transaction. */
  readonly signed: readonly boolean[];
  readonly data: Uint8Array;
  /** False for an instruction a program called from inside another. */
  readonly top: boolean;
}

export interface ReadMessage {
  readonly payer: string;
  readonly signers: readonly string[];
  /** Every account of the transaction, in the order balances are reported for them. */
  readonly keys: readonly string[];
  /** In the order they ran. */
  readonly instructions: readonly ReadInstruction[];
}

function fromBase64(text: string): Uint8Array {
  if (typeof text !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new UnreadableTransaction('The transaction is not base64.');
  return new Uint8Array(Buffer.from(text, 'base64'));
}

interface CompiledShape {
  readonly header?: { readonly numSignerAccounts?: number };
  readonly staticAccounts?: readonly string[];
  /** Legacy and version 0. */
  readonly instructions?: ReadonlyArray<{ readonly programAddressIndex: number; readonly accountIndices?: readonly number[]; readonly data?: Uint8Array }>;
  /** Version 1. */
  readonly instructionHeaders?: ReadonlyArray<{ readonly programAccountIndex: number }>;
  readonly instructionPayloads?: ReadonlyArray<{ readonly instructionAccountIndices?: readonly number[]; readonly instructionData?: Uint8Array }>;
}

/** Reads a transaction's message, of any version, into addresses. Lookup-table accounts come from `meta`. */
export function readMessage(raw: RawTransaction): ReadMessage {
  const wire = Array.isArray(raw.transaction) ? raw.transaction[0] : undefined;
  if (typeof wire !== 'string') throw new UnreadableTransaction('The transaction body is missing.');
  let compiled: CompiledShape;
  try {
    const decoded = getTransactionDecoder().decode(fromBase64(wire));
    compiled = getCompiledTransactionMessageDecoder().decode(decoded.messageBytes) as unknown as CompiledShape;
  } catch (error) {
    if (error instanceof UnreadableTransaction) throw error;
    throw new UnreadableTransaction(`The transaction could not be decoded: ${error instanceof Error ? error.message : String(error)}`);
  }
  const statics = compiled.staticAccounts;
  const signerCount = compiled.header?.numSignerAccounts;
  if (!Array.isArray(statics) || statics.length === 0 || typeof signerCount !== 'number' || signerCount < 1 || signerCount > statics.length) {
    throw new UnreadableTransaction('The transaction has no readable account list.');
  }
  const loaded = raw.meta?.loadedAddresses;
  const keys: string[] = [...statics, ...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])];
  const at = (index: number): string => {
    const key = keys[index];
    if (typeof key !== 'string') throw new UnreadableTransaction('An instruction names an account the transaction does not have.');
    return key;
  };
  const build = (programIndex: number, indices: readonly number[], data: Uint8Array, top: boolean): ReadInstruction => ({
    program: at(programIndex),
    accounts: indices.map(at),
    signed: indices.map((index) => index < signerCount),
    data,
    top,
  });

  const tops: ReadInstruction[] = [];
  if (Array.isArray(compiled.instructions)) {
    for (const instruction of compiled.instructions) {
      tops.push(build(instruction.programAddressIndex, instruction.accountIndices ?? [], instruction.data ?? new Uint8Array(), true));
    }
  } else if (Array.isArray(compiled.instructionHeaders) && Array.isArray(compiled.instructionPayloads)) {
    compiled.instructionHeaders.forEach((header, index) => {
      const payload = compiled.instructionPayloads?.[index];
      tops.push(build(header.programAccountIndex, payload?.instructionAccountIndices ?? [], payload?.instructionData ?? new Uint8Array(), true));
    });
  } else {
    throw new UnreadableTransaction('The transaction has no readable instruction list.');
  }

  // Inner instructions are reported per top-level instruction; putting each group after its parent gives the order they ran in.
  const inner = new Map<number, ReadInstruction[]>();
  for (const group of raw.meta?.innerInstructions ?? []) {
    const list: ReadInstruction[] = [];
    for (const instruction of group.instructions ?? []) {
      let data: Uint8Array;
      try {
        data = instruction.data ? new Uint8Array(bs58.decode(instruction.data)) : new Uint8Array();
      } catch {
        throw new UnreadableTransaction('An inner instruction is not base58.');
      }
      list.push(build(instruction.programIdIndex, instruction.accounts ?? [], data, false));
    }
    inner.set(group.index, [...(inner.get(group.index) ?? []), ...list]);
  }
  const instructions: ReadInstruction[] = [];
  tops.forEach((instruction, index) => {
    instructions.push(instruction, ...(inner.get(index) ?? []));
  });
  return { payer: at(0), signers: keys.slice(0, signerCount), keys, instructions };
}

/* ------------------------------------------------------------------ */
/* Instruction kinds                                                   */
/* ------------------------------------------------------------------ */

/** Instructions that move somebody's funds: each produces one event in the indexer. */
const USER_TAGS: ReadonlySet<number> = new Set([
  InstructionTag.deposit,
  InstructionTag.transact,
  InstructionTag.mergeTransact,
  InstructionTag.ringDeposit,
  InstructionTag.ringTransact,
  InstructionTag.ringMergeTransact,
  InstructionTag.ringAuthorityTransact,
]);
const MERGE_TAGS: ReadonlySet<number> = new Set([InstructionTag.mergeTransact, InstructionTag.ringMergeTransact]);
/** Instructions that write a custom ring's registration: creating it, pausing it, handing it over, activating it. */
const RING_ADMIN_TAGS: ReadonlySet<number> = new Set([
  InstructionTag.createRingConfig,
  InstructionTag.updateRingConfig,
  InstructionTag.updateRingConfigOwner,
  InstructionTag.setRingActivation,
]);

/** Programs that are part of nearly every transaction and say nothing about what it was for. */
const PLUMBING: ReadonlySet<string> = new Set([
  SPP_PROGRAM_ID,
  USER_REGISTRY_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  'ComputeBudget111111111111111111111111111111',
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
  'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo',
]);

/** Names for the programs a Rings transaction most often also calls. Anything else is shown by address. */
export const KNOWN_PROGRAMS: Readonly<Record<string, string>> = Object.freeze({
  [DBC_PROGRAM_ID]: 'Meteora curve',
  [DAMM_V2_PROGRAM_ID]: 'Meteora pool',
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: 'Jupiter',
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': 'pump.fun',
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: 'PumpSwap',
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: 'Meteora DLMM',
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: 'Orca',
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: 'Raydium',
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'Raydium',
  CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: 'Raydium',
});

/* ------------------------------------------------------------------ */
/* Decoding                                                            */
/* ------------------------------------------------------------------ */

export interface DecodeContext {
  /** The account that holds every privately held lamport. */
  readonly solVault: string;
  /** The Rings vault of a mint, when it has been worked out. Asked only for mints the transaction touches. */
  readonly vaultOf: (mint: string) => string | undefined;
}

export interface DecodedRing {
  readonly kind: RingKind;
  readonly payer: string;
  readonly senders: readonly string[];
  readonly recipients: readonly string[];
  readonly legs: readonly RingLeg[];
  readonly via: readonly string[];
  readonly ring: string | null;
  /** True when the receiving side could not be read because the indexer had no events for it yet. */
  readonly partial: boolean;
  /** Mints whose vault balance this transaction changed. */
  readonly touched: readonly string[];
  /** True when the transaction registered a custom ring or changed a ring's registration. */
  readonly ringAdmin: boolean;
}

function unique(values: Iterable<string>): string[] {
  return [...new Set(values)];
}

function lamportsOf(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return BigInt(Math.round(value));
  if (typeof value === 'string' && /^\d{1,30}$/.test(value)) return BigInt(value);
  throw new UnreadableTransaction('A balance is not a number.');
}

function unitsOf(balance: RawTokenBalance | undefined): bigint {
  const text = balance?.uiTokenAmount?.amount;
  return typeof text === 'string' && /^\d{1,40}$/.test(text) ? BigInt(text) : 0n;
}

/** What moved into or out of the Rings vaults, and who was on the public end of it. */
function vaultMoves(message: ReadMessage, meta: RawMeta, context: DecodeContext): { legs: RingLeg[]; publicTo: string[] } {
  const legs: RingLeg[] = [];
  const publicTo: string[] = [];
  const pre = meta.preBalances;
  const post = meta.postBalances;
  if (!Array.isArray(pre) || !Array.isArray(post) || pre.length !== post.length) throw new UnreadableTransaction('The balance lists are missing.');

  const solIndex = message.keys.indexOf(context.solVault);
  if (solIndex >= 0 && solIndex < pre.length) {
    const delta = lamportsOf(post[solIndex]) - lamportsOf(pre[solIndex]);
    if (delta !== 0n) {
      legs.push({ mint: WSOL_MINT, amount: (delta < 0n ? -delta : delta).toString(), dir: delta > 0n ? 'in' : 'out' });
      if (delta < 0n) {
        // Whoever ended with more lamports than they started with received it. The payer also paid the fee.
        message.keys.forEach((key, index) => {
          if (index === solIndex || index >= pre.length) return;
          const gain = lamportsOf(post[index]) - lamportsOf(pre[index]) + (index === 0 ? lamportsOf(meta.fee) : 0n);
          if (gain > 0n) publicTo.push(key);
        });
      }
    }
  }

  const before = new Map<number, RawTokenBalance>();
  const after = new Map<number, RawTokenBalance>();
  for (const balance of meta.preTokenBalances ?? []) before.set(balance.accountIndex, balance);
  for (const balance of meta.postTokenBalances ?? []) after.set(balance.accountIndex, balance);
  const deltas = new Map<string, bigint>();
  const indexes = new Set<number>([...before.keys(), ...after.keys()]);
  for (const index of indexes) {
    const entry = after.get(index) ?? before.get(index);
    const mint = entry?.mint;
    const key = message.keys[index];
    if (typeof mint !== 'string' || typeof key !== 'string') continue;
    if (context.vaultOf(mint) !== key) continue;
    const delta = unitsOf(after.get(index)) - unitsOf(before.get(index));
    if (delta !== 0n) deltas.set(mint, (deltas.get(mint) ?? 0n) + delta);
  }
  for (const [mint, delta] of deltas) {
    legs.push({ mint, amount: (delta < 0n ? -delta : delta).toString(), dir: delta > 0n ? 'in' : 'out' });
    if (delta >= 0n) continue;
    for (const index of indexes) {
      const entry = after.get(index) ?? before.get(index);
      if (entry?.mint !== mint || context.vaultOf(mint) === message.keys[index]) continue;
      const owner = entry.owner;
      if (typeof owner === 'string' && owner && unitsOf(after.get(index)) > unitsOf(before.get(index))) publicTo.push(owner);
    }
  }
  return { legs, publicTo: unique(publicTo) };
}

/**
 * Decodes one successful transaction. `events` is the indexer's view of it, or
 * null when the indexer had none yet: the public side is still exact then, and
 * the row is marked partial so the receiving side is read later.
 */
export function decodeRing(raw: RawTransaction, events: readonly RingEvent[] | null, context: DecodeContext): DecodedRing {
  const meta = raw.meta;
  if (!meta) throw new UnreadableTransaction('The transaction has no result attached.');
  const message = readMessage(raw);
  const ours = message.instructions.filter((instruction) => instruction.program === SPP_PROGRAM_ID);
  const tags = ours.map((instruction) => instruction.data[0]).filter((tag): tag is number => typeof tag === 'number');
  const user = ours.filter((instruction) => USER_TAGS.has(instruction.data[0] ?? -1));
  const via = unique(
    message.instructions
      .filter((instruction) => instruction.top && !PLUMBING.has(instruction.program))
      .map((instruction) => KNOWN_PROGRAMS[instruction.program] ?? instruction.program),
  );
  const ringAdmin = tags.some((tag) => RING_ADMIN_TAGS.has(tag));
  const base = { payer: message.payer, via, ring: null as string | null, partial: false, touched: [] as string[], ringAdmin };

  if (user.length === 0) {
    const kind: RingKind = tags.includes(InstructionTag.createSplInterface) ? 'token' : tags.length > 0 ? 'upkeep' : 'other';
    return { ...base, kind, senders: [], recipients: [], legs: [] };
  }

  const { legs, publicTo } = vaultMoves(message, meta, context);
  const touched = unique(legs.map((leg) => leg.mint));

  const ring = events?.find((event) => event.ring !== null)?.ring ?? null;
  // One event per instruction, in order, is what lets an instruction be read together with its own outputs.
  const paired = events !== null && ring === null && events.length === user.length;

  // Whose funds an instruction moved: the signers it names after its fee payer, or the fee payer alone.
  const fromOf = (instruction: ReadInstruction, event?: RingEvent): string[] => {
    const named = instruction.accounts.filter((_account, index) => index > 0 && instruction.signed[index]);
    if (named.length > 0) return unique(named);
    const payer = instruction.accounts[0] ?? message.payer;
    // Nobody but the fee payer signed. When the instruction spends notes and none of its outputs is
    // the payer's, the payer is relaying for an owner who signed inside the proof: whose funds moved
    // is then not something this reading can tell, and it does not guess.
    if (event && event.nullifiers > 0 && event.tags.length > 0 && !event.tags.includes(payer)) return [];
    return [payer];
  };
  const senders = unique(user.flatMap((instruction, index) => fromOf(instruction, paired ? events?.[index] : undefined)));

  let recipients: string[] = [];
  let swap = false;
  if (events && ring === null) {
    if (paired) {
      // Each instruction's outputs belong to whoever it paid, and to its own sender as change.
      const paid = user.map((instruction, index) => {
        const from = new Set(fromOf(instruction, events[index]));
        return unique((events[index]?.tags ?? []).filter((tag) => !from.has(tag)));
      });
      recipients = unique(paid.flat());
      swap = user.length >= 2 && senders.length === 2 && recipients.length > 0 && recipients.every((address) => senders.includes(address)) && paid.every((list) => list.length > 0);
    } else {
      const from = new Set(senders);
      recipients = unique(events.flatMap((event) => event.tags).filter((tag) => !from.has(tag)));
    }
  }

  const into = legs.some((leg) => leg.dir === 'in');
  const out = legs.some((leg) => leg.dir === 'out');
  let kind: RingKind;
  let partial = false;
  if (into && out) {
    kind = 'trade';
    recipients = [];
  } else if (into) {
    kind = 'shield';
    if (events === null) partial = true;
  } else if (out) {
    kind = 'unshield';
    // The public end of a withdrawal is on chain; the indexer adds nothing to it.
    recipients = publicTo.filter((address) => !senders.includes(address));
  } else if (ring !== null) {
    kind = 'private';
    recipients = [];
  } else if (events === null) {
    kind = 'private';
    partial = true;
  } else if (recipients.length === 0) {
    kind = 'self';
  } else if (swap) {
    kind = 'swap';
    recipients = recipients.filter((address) => !senders.includes(address));
  } else if (user.every((instruction) => MERGE_TAGS.has(instruction.data[0] ?? -1))) {
    kind = 'self';
    recipients = [];
  } else {
    kind = 'transfer';
  }
  return { ...base, kind, senders, recipients, legs, ring, partial, touched };
}

/** True when the first byte of an instruction says it registers a token with Rings. */
export function registersToken(raw: RawTransaction): boolean {
  try {
    return readMessage(raw).instructions.some((instruction) => instruction.program === SPP_PROGRAM_ID && instruction.data[0] === InstructionTag.createSplInterface);
  } catch {
    return false;
  }
}
