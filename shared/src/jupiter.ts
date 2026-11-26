/**
 * Converting through Jupiter, so a token can be paid for in SOL or USDC
 * whatever it is priced in, and so a token that was not launched here can be
 * bought and sold at all (`routes.ts`, "Outside tokens").
 *
 * This site asks Jupiter's Swap API for one thing: `GET /swap/v2/build` with
 * `transactionVersion=1`. That returns the swap as plain instructions with
 * every account written out, which is the form a Rings transaction needs, so
 * the conversion, the Meteora swap and the Rings deposit can share one atomic
 * transaction.
 *
 * Those instructions were written by somebody else and a wallet here is about
 * to sign them. Nothing is used until it has been read. `readBuild` checks the
 * answer against the question (same tokens, same amount, the slippage asked
 * for), and then every instruction against the short list of things a
 * conversion legitimately does:
 *
 *   - open a token account for the wallet itself, paid by the wallet;
 *   - wrap exactly the SOL being converted, and unwrap again afterwards;
 *   - one swap in Jupiter's own program, in a layout this file can read, that
 *     spends exactly the amount asked from the wallet's own account and pays
 *     into the wallet's own account, with no fee to anybody else, nothing kept
 *     back from a better price, and nothing passed on to a third account.
 *
 * Anything else is refused, and the wallet is asked to sign nothing. The page
 * then also runs the finished transaction against the chain and compares what
 * it would leave in the wallet (`balanceFloors` below) before signing.
 */

import { AccountRole, type Address, type Instruction, address, isAddress } from '@solana/kit';
import { PublicKey } from '@solana/web3.js';
import { AccountLayout, getAssociatedTokenAddressSync } from '@solana/spl-token';

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_ACCOUNT_RENT_LAMPORTS,
  TOKEN_PROGRAM_ID,
  WSOL_MINT,
} from './constants.js';
import { base64ToBytes } from './tx.js';

/** Jupiter's swap program (Aggregator v6). The only program a conversion's swap may run in. */
export const JUPITER_PROGRAM_ID = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';

/** Where the server asks. The browser never does: the API key stays on the server. */
export const JUPITER_BUILD_URL = 'https://api.jup.ag/swap/v2/build';

export class ConvertError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ConvertError';
    this.code = code;
  }
}

/** What is asked of Jupiter. Every field is sent; nothing is left to a default. */
export interface BuildRequest {
  readonly inputMint: string;
  readonly outputMint: string;
  /** Base units of the input token. The swap spends exactly this. */
  readonly amount: bigint;
  /** The wallet the swap is built for. It is the only signer. */
  readonly taker: string;
  readonly slippageBps: number;
  /** The most distinct accounts the swap instruction may name, which leaves room for the rest of the transaction. */
  readonly maxAccounts: number;
  /**
   * The token program each mint belongs to, as the caller read it from the
   * mint's own account on chain. Absent means the SPL Token program, which is
   * what SOL, USDC and every pair token here use. Neither is sent to Jupiter:
   * they are what its answer is checked against, because the program decides
   * where the wallet's own token account for a mint is.
   */
  readonly inputProgram?: string;
  readonly outputProgram?: string;
}

/** The token program of each side of a request: the one named, or the SPL Token program. */
export function programsOf(request: Pick<BuildRequest, 'inputProgram' | 'outputProgram'>): { readonly input: string; readonly output: string } {
  return { input: request.inputProgram ?? TOKEN_PROGRAM_ID, output: request.outputProgram ?? TOKEN_PROGRAM_ID };
}

export const MAX_ACCOUNTS_RANGE = Object.freeze({ min: 8, max: 64 });

/** The query string of a build request, the same on the server and in the tests. */
export function buildQuery(request: BuildRequest): URLSearchParams {
  return new URLSearchParams({
    inputMint: request.inputMint,
    outputMint: request.outputMint,
    amount: request.amount.toString(),
    taker: request.taker,
    slippageBps: String(request.slippageBps),
    maxAccounts: String(request.maxAccounts),
    // Version 1 instructions: every account inline, no lookup tables. A Rings transaction can carry nothing else.
    transactionVersion: '1',
  });
}

/** A conversion that has been read and checked, ready to be placed in a transaction. */
export interface ConversionSwap {
  readonly inputMint: string;
  readonly outputMint: string;
  /** Base units of the input token the swap spends. */
  readonly amountIn: bigint;
  /** What Jupiter expects the swap to return, in base units of the output token. */
  readonly expectedOut: bigint;
  /**
   * The least it can return and still succeed, for anything built on top of
   * it: one unit under the minimum Jupiter states (see `readBuild`). A swap
   * that returns less fails on chain, and the whole transaction with it.
   */
  readonly minimumOut: bigint;
  readonly slippageBps: number;
  /** The venues the route passes through, for display. */
  readonly route: readonly string[];
  /**
   * How far Jupiter itself says this trade moves the price, in percent. Nothing
   * here checks it and nothing is built on it: it is only ever a reason to warn
   * somebody. Null when the answer gives no usable figure.
   */
  readonly impactPct: number | null;
  /** Setup, swap, cleanup: in the order they must run. */
  readonly instructions: readonly Instruction[];
}

/* ------------------------------------------------------------------ */
/* Reading the answer                                                  */
/* ------------------------------------------------------------------ */

interface RawAccount {
  readonly pubkey: string;
  readonly isSigner: boolean;
  readonly isWritable: boolean;
}

interface RawInstruction {
  readonly programId: string;
  readonly accounts: readonly RawAccount[];
  readonly data: Uint8Array;
}

const refuse = (what: string): ConvertError =>
  new ConvertError('UNEXPECTED', `The converter's answer was not what this site expects (${what}), so nothing was built from it.`);

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw refuse(`${what} is not an object`);
  return value as Record<string, unknown>;
}

function units(value: unknown, what: string): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value)) throw refuse(`${what} is not an amount`);
  return BigInt(value);
}

function rawInstruction(value: unknown, what: string): RawInstruction {
  const fields = record(value, what);
  if (typeof fields.programId !== 'string' || !isAddress(fields.programId)) throw refuse(`${what} names no program`);
  if (!Array.isArray(fields.accounts) || fields.accounts.length > 256) throw refuse(`${what} has no account list`);
  const accounts = fields.accounts.map((entry, index): RawAccount => {
    const account = record(entry, `${what}, account ${index}`);
    if (typeof account.pubkey !== 'string' || !isAddress(account.pubkey)) throw refuse(`${what}, account ${index} is not an address`);
    if (typeof account.isSigner !== 'boolean' || typeof account.isWritable !== 'boolean') throw refuse(`${what}, account ${index} has no roles`);
    return { pubkey: account.pubkey, isSigner: account.isSigner, isWritable: account.isWritable };
  });
  if (typeof fields.data !== 'string' || fields.data.length > 4096) throw refuse(`${what} has no data`);
  let data: Uint8Array;
  try {
    data = base64ToBytes(fields.data);
  } catch {
    throw refuse(`${what} has data that is not base64`);
  }
  return { programId: fields.programId, accounts, data };
}

function rawList(value: unknown, what: string): RawInstruction[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 16) throw refuse(`${what} is not a short list`);
  return value.map((entry, index) => rawInstruction(entry, `${what} ${index + 1}`));
}

function toInstruction(raw: RawInstruction): Instruction {
  return {
    programAddress: address(raw.programId),
    accounts: raw.accounts.map((account) => ({
      address: address(account.pubkey),
      role: account.isSigner
        ? account.isWritable
          ? AccountRole.WRITABLE_SIGNER
          : AccountRole.READONLY_SIGNER
        : account.isWritable
          ? AccountRole.WRITABLE
          : AccountRole.READONLY,
    })),
    data: raw.data,
  };
}

/** The wallet's own token account for a mint. */
function tokenAccountOf(owner: string, mint: string, tokenProgram: string = TOKEN_PROGRAM_ID): string {
  return getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner), true, new PublicKey(tokenProgram)).toBase58();
}

const u64At = (data: Uint8Array, offset: number): bigint => new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(offset, true);
const u16At = (data: Uint8Array, offset: number): number => new DataView(data.buffer, data.byteOffset, data.byteLength).getUint16(offset, true);
const u32At = (data: Uint8Array, offset: number): number => new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true);

/**
 * The two swap instructions Jupiter's `/build` answers with, and where each
 * keeps what must be checked. Offsets are into the instruction data; indexes
 * are into its account list. Both were read off live answers and are held to
 * them by `tests/jupiter.test.ts`.
 *
 *   route_v2                  [amounts] then the route; the wallet's accounts first
 *   shared_accounts_route_v2  one id byte, then the same; Jupiter's own accounts in between
 *
 * `route_v2` has one more fixed account after the two token programs: an
 * optional account that what was bought is passed on to. Left out, it holds
 * Jupiter's own program address, which is what every answer to a request from
 * here has had. Anything else there but the wallet's own account is refused.
 */
interface SwapLayout {
  readonly name: string;
  readonly discriminator: readonly number[];
  /** in_amount u64, quoted_out_amount u64, slippage_bps u16, platform_fee_bps u16, positive_slippage_bps u16. */
  readonly amountsAt: number;
  readonly authority: number;
  readonly source: number;
  readonly destination: number;
  readonly sourceMint: number;
  readonly destinationMint: number;
  /** The token program of what is spent, and of what is bought. */
  readonly sourceProgram: number;
  readonly destinationProgram: number;
  /** Where the instruction keeps the optional account its proceeds are passed on to, when it has one. */
  readonly forward?: number;
}

const SWAP_LAYOUTS: readonly SwapLayout[] = Object.freeze([
  {
    name: 'route_v2',
    discriminator: [187, 100, 250, 204, 49, 196, 175, 20],
    amountsAt: 8,
    authority: 0,
    source: 1,
    destination: 2,
    sourceMint: 3,
    destinationMint: 4,
    sourceProgram: 5,
    destinationProgram: 6,
    forward: 7,
  },
  {
    name: 'shared_accounts_route_v2',
    discriminator: [209, 152, 83, 147, 124, 254, 216, 233],
    amountsAt: 9,
    authority: 1,
    source: 2,
    destination: 5,
    sourceMint: 6,
    destinationMint: 7,
    sourceProgram: 8,
    destinationProgram: 9,
  },
]);

function checkSwap(raw: RawInstruction, request: BuildRequest, expectedOut: bigint): void {
  if (raw.programId !== JUPITER_PROGRAM_ID) throw refuse(`the swap runs in ${raw.programId}, which is not Jupiter's program`);
  const layout = SWAP_LAYOUTS.find((candidate) => candidate.discriminator.every((byte, index) => raw.data[index] === byte));
  if (!layout) throw refuse('the swap is a kind of Jupiter instruction this site cannot read');
  if (raw.data.length < layout.amountsAt + 22) throw refuse('the swap instruction is too short');
  const account = (index: number): RawAccount => {
    const entry = raw.accounts[index];
    if (!entry) throw refuse('the swap names too few accounts');
    return entry;
  };
  if (u64At(raw.data, layout.amountsAt) !== request.amount) throw refuse('the swap would spend a different amount from the one asked');
  if (u64At(raw.data, layout.amountsAt + 8) !== expectedOut) throw refuse('the swap is priced differently from the quote it came with');
  if (u16At(raw.data, layout.amountsAt + 16) !== request.slippageBps) throw refuse('the swap carries a different slippage limit from the one asked');
  if (u16At(raw.data, layout.amountsAt + 18) !== 0) throw refuse('the swap pays a fee to somebody this site did not name');
  // The share of a better-than-quoted price the swap may keep back for a fee account. Nobody asked for one.
  if (u16At(raw.data, layout.amountsAt + 20) !== 0) throw refuse('the swap keeps part of a better price for somebody this site did not name');
  const programs = programsOf(request);
  const ownSource = tokenAccountOf(request.taker, request.inputMint, programs.input);
  const ownDestination = tokenAccountOf(request.taker, request.outputMint, programs.output);
  const authority = account(layout.authority);
  if (authority.pubkey !== request.taker || !authority.isSigner) throw refuse('the swap is not signed for by this wallet');
  if (account(layout.source).pubkey !== ownSource) throw refuse("the swap does not spend from this wallet's own token account");
  if (account(layout.destination).pubkey !== ownDestination) throw refuse("the swap does not pay into this wallet's own token account");
  if (account(layout.sourceMint).pubkey !== request.inputMint || account(layout.destinationMint).pubkey !== request.outputMint) {
    throw refuse('the swap is for different tokens from the ones asked');
  }
  if (account(layout.sourceProgram).pubkey !== programs.input || account(layout.destinationProgram).pubkey !== programs.output) {
    throw refuse('the swap moves a token with another token program than the one its mint belongs to');
  }
  if (layout.forward !== undefined) {
    const onward = account(layout.forward).pubkey;
    if (onward !== JUPITER_PROGRAM_ID && onward !== ownDestination) throw refuse("the swap passes what it buys on to an account that is not this wallet's own");
  }
}

/**
 * An instruction that goes around the swap. Returns the instruction to use:
 * the same one, or for a token account that is opened, its "only if missing"
 * form, because an earlier instruction of the same transaction may already
 * have opened it.
 */
function checkAround(raw: RawInstruction, request: BuildRequest, what: string): RawInstruction {
  const { taker } = request;
  const wrapped = tokenAccountOf(taker, WSOL_MINT);
  const keys = raw.accounts.map((account) => account.pubkey);
  if (raw.programId === ASSOCIATED_TOKEN_PROGRAM_ID) {
    // Create (no data, or 0) and CreateIdempotent (1): [payer, account, wallet, mint, system program, token program].
    const create = raw.data.length === 0 || (raw.data.length === 1 && (raw.data[0] === 0 || raw.data[0] === 1));
    if (!create || keys.length < 6) throw refuse(`${what} is not the opening of a token account`);
    const [payer, account, wallet, mint, system, tokenProgram] = keys as [string, string, string, string, string, string];
    if (payer !== taker || wallet !== taker) throw refuse(`${what} opens a token account for somebody else`);
    if (system !== SYSTEM_PROGRAM_ID) throw refuse(`${what} is not a plain token account`);
    if (tokenProgram !== TOKEN_PROGRAM_ID && tokenProgram !== TOKEN_2022_PROGRAM_ID) throw refuse(`${what} uses an unknown token program`);
    if (account !== tokenAccountOf(taker, mint, tokenProgram)) throw refuse(`${what} opens an account that is not this wallet's own`);
    return { ...raw, data: Uint8Array.of(1) };
  }
  if (raw.programId === SYSTEM_PROGRAM_ID) {
    // Transfer: a u32 tag of 2, then the lamports. Only ever the SOL being converted, into the wallet's own wrapped-SOL account.
    if (raw.data.length !== 12 || u32At(raw.data, 0) !== 2 || keys.length !== 2) throw refuse(`${what} is a system instruction other than a transfer`);
    if (request.inputMint !== WSOL_MINT) throw refuse(`${what} moves SOL in a conversion that does not start from SOL`);
    if (keys[0] !== taker || keys[1] !== wrapped) throw refuse(`${what} sends SOL somewhere other than this wallet's own wrapped-SOL account`);
    if (u64At(raw.data, 4) > request.amount) throw refuse(`${what} wraps more SOL than is being converted`);
    return raw;
  }
  if (raw.programId === TOKEN_PROGRAM_ID) {
    // SyncNative (17) on the wrapped-SOL account, or CloseAccount (9) of it back to the wallet.
    if (raw.data.length === 1 && raw.data[0] === 17 && keys.length === 1 && keys[0] === wrapped) return raw;
    if (raw.data.length === 1 && raw.data[0] === 9 && keys.length === 3 && keys[0] === wrapped && keys[1] === taker && keys[2] === taker) return raw;
    throw refuse(`${what} is a token instruction other than wrapping or unwrapping this wallet's SOL`);
  }
  throw refuse(`${what} runs in ${raw.programId}, which a conversion has no use for`);
}

/**
 * Reads Jupiter's answer to `request` and returns the conversion, or throws
 * `ConvertError` saying what was wrong with it. Pure: it reads nothing but its
 * arguments.
 */
export function readBuild(body: unknown, request: BuildRequest): ConversionSwap {
  const fields = record(body, 'the answer');
  if (fields.inputMint !== request.inputMint || fields.outputMint !== request.outputMint) throw refuse('it is for different tokens');
  if (units(fields.inAmount, 'inAmount') !== request.amount) throw refuse('it is for a different amount');
  if (fields.swapMode !== 'ExactIn') throw refuse('it is not an exact-in swap');
  if (fields.transactionVersion !== 1) throw refuse('it is not for a version 1 transaction');
  const tables = fields.addressesByLookupTableAddress;
  if (tables !== undefined && tables !== null && Object.keys(record(tables, 'the lookup tables')).length > 0) throw refuse('it needs address lookup tables');
  if (fields.tipInstruction !== undefined && fields.tipInstruction !== null) throw refuse('it carries a tip nobody asked for');
  if (typeof fields.slippageBps === 'number' && fields.slippageBps !== request.slippageBps) throw refuse('it uses a different slippage limit');

  const expectedOut = units(fields.outAmount, 'outAmount');
  const statedMinimum = units(fields.otherAmountThreshold, 'otherAmountThreshold');
  // The floor must be the one the slippage asked for implies, never a looser one.
  const impliedFloor = (expectedOut * BigInt(10_000 - request.slippageBps)) / 10_000n;
  if (statedMinimum > expectedOut || statedMinimum < impliedFloor) throw refuse('its minimum does not follow from its quote and the slippage asked');
  // Jupiter states its floor rounded up. The swap itself carries the quote and the slippage, not
  // the floor, and what it enforces from them may be that figure rounded down. Everything built
  // on "the least this returns" therefore counts on one unit less than Jupiter states.
  const minimumOut = statedMinimum - 1n;
  if (expectedOut <= 0n || minimumOut <= 0n) throw new ConvertError('DUST', 'This amount is too small to convert.');

  for (const account of [request.taker, request.inputMint, request.outputMint]) {
    if (!isAddress(account)) throw refuse('the request itself is malformed');
  }
  if (!Number.isInteger(request.slippageBps) || request.slippageBps < 0 || request.slippageBps > 10_000) throw refuse('the request itself is malformed');
  for (const program of Object.values(programsOf(request))) {
    if (program !== TOKEN_PROGRAM_ID && program !== TOKEN_2022_PROGRAM_ID) throw refuse('the request itself names a token program this site does not use');
  }

  const setup = rawList(fields.setupInstructions, 'setup instruction');
  const swap = rawInstruction(fields.swapInstruction, 'the swap instruction');
  const cleanup = fields.cleanupInstruction === undefined || fields.cleanupInstruction === null ? [] : [rawInstruction(fields.cleanupInstruction, 'the cleanup instruction')];
  const other = rawList(fields.otherInstructions, 'extra instruction');

  // Nobody but this wallet may be asked to sign anything.
  for (const instruction of [...setup, swap, ...cleanup, ...other]) {
    if (instruction.accounts.some((account) => account.isSigner && account.pubkey !== request.taker)) throw refuse('it needs a signature from somebody else');
  }
  checkSwap(swap, request, expectedOut);
  const before = setup.map((instruction, index) => checkAround(instruction, request, `setup instruction ${index + 1}`));
  const after = [...cleanup, ...other].map((instruction, index) => checkAround(instruction, request, `closing instruction ${index + 1}`));

  const route: string[] = [];
  if (Array.isArray(fields.routePlan)) {
    for (const step of fields.routePlan.slice(0, 8)) {
      const label = (step as { swapInfo?: { label?: unknown } } | null)?.swapInfo?.label;
      if (typeof label === 'string' && label.length > 0 && !route.includes(label)) route.push(label.slice(0, 40));
    }
  }
  return Object.freeze({
    inputMint: request.inputMint,
    outputMint: request.outputMint,
    amountIn: request.amount,
    expectedOut,
    minimumOut,
    slippageBps: request.slippageBps,
    route: Object.freeze(route),
    impactPct: impactOf(fields.priceImpactPct),
    instructions: Object.freeze([...before, swap, ...after].map(toInstruction)),
  });
}

/** Jupiter writes its price impact as a ratio in text ("0.0123" is 1.23%). Anything that is not such a figure is no figure. */
function impactOf(value: unknown): number | null {
  if (typeof value !== 'string' || !/^-?[0-9]{1,3}(\.[0-9]{1,40})?$/.test(value)) return null;
  const ratio = Number(value);
  if (!Number.isFinite(ratio)) return null;
  // A trade that improves the price has no impact to warn about.
  return Math.min(100, Math.max(0, ratio * 100));
}

/* ------------------------------------------------------------------ */
/* What the finished transaction may leave behind                      */
/* ------------------------------------------------------------------ */

/**
 * A balance that must not end up below `minimum` once the whole transaction
 * has run. A conversion's instructions are checked one by one above; this is
 * the other half: the finished transaction is run against the chain before it
 * is signed, and what it would leave in the wallet is compared with these.
 */
export interface BalanceFloor {
  readonly account: Address;
  /** `lamports` reads the account's SOL; `token` reads a token account's balance. */
  readonly kind: 'lamports' | 'token';
  /** What the balance is, in words: "your public USDC". */
  readonly label: string;
  readonly minimum: bigint;
}

export interface AccountSnapshot {
  readonly lamports: bigint;
  readonly data: Uint8Array;
}

/** The balance a floor is about, in an account as read from chain. A missing account holds nothing. */
export function balanceIn(kind: BalanceFloor['kind'], account: AccountSnapshot | null): bigint {
  if (!account) return 0n;
  if (kind === 'lamports') return account.lamports;
  if (account.data.length < AccountLayout.span) return 0n;
  return AccountLayout.decode(account.data).amount;
}

/** The floors a run would break, in words. Empty when it breaks none. `after` lines up with `floors`. */
export function floorsBroken(floors: readonly BalanceFloor[], after: ReadonlyArray<AccountSnapshot | null>): string[] {
  const broken: string[] = [];
  floors.forEach((floor, index) => {
    const snapshot = after[index];
    // A run that did not report an account cannot vouch for it.
    if (snapshot === undefined) broken.push(`${floor.label} could not be checked`);
    else if (balanceIn(floor.kind, snapshot) < floor.minimum) broken.push(`it would leave ${floor.label} lower than this trade allows`);
  });
  return broken;
}

/**
 * What a transaction may take from the wallet's SOL beyond what the trade
 * itself spends: the rent of each token account it opens, and an allowance
 * for network and Rings fees. The priority fee is added by the caller.
 */
export const CONVERSION_FEE_ALLOWANCE_LAMPORTS = 5_000_000n;

export function solOverhead(instructions: readonly Instruction[]): bigint {
  const opened = instructions.filter((instruction) => instruction.programAddress === ASSOCIATED_TOKEN_PROGRAM_ID).length;
  return BigInt(opened) * TOKEN_ACCOUNT_RENT_LAMPORTS + CONVERSION_FEE_ALLOWANCE_LAMPORTS;
}

/* ------------------------------------------------------------------ */
/* Sizing                                                              */
/* ------------------------------------------------------------------ */

/**
 * A converted trade is two swaps, and each needs room to move. The slippage
 * limit somebody chose is split between them, so the whole trade stays inside
 * it: half for the conversion, half for the pool.
 */
export function legSlippageBps(totalBps: number): number {
  return Math.max(10, Math.floor(totalBps / 2));
}

/**
 * How many accounts the conversion's swap may name. The rest of a version 1
 * transaction's 64 go to the Meteora swap and the Rings instructions, more of
 * them when a private balance is spent in the same transaction.
 */
export const CONVERSION_ACCOUNTS = Object.freeze({ fromPublic: 44, fromPrivate: 36, smallest: 14 });

/**
 * The same for a token that was not launched here, where Jupiter's swap is the
 * only swap in the transaction. The rest of the 64 go to the Rings withdrawal
 * and deposit, to creating the token's place in Rings when this is its first
 * deposit, and to the extra notes a split balance spends. A transaction built
 * to these has at least nine accounts to spare from a private balance and six
 * from a public one (`tests/outside.test.ts` holds them to that).
 */
export const OUTSIDE_ACCOUNTS = Object.freeze({ fromPublic: 50, fromPrivate: 44, smallest: 14 });

/** The compute a converted trade reserves: what a run used, and a fifth more. */
export function tunedComputeLimit(unitsConsumed: bigint | number | undefined): number {
  const ceiling = 1_400_000;
  if (unitsConsumed === undefined) return ceiling;
  const used = Number(unitsConsumed);
  if (!Number.isFinite(used) || used <= 0) return ceiling;
  return Math.min(ceiling, Math.ceil(used * 1.2) + 20_000);
}
