/**
 * Solana Privacy Rings: client, wallet state, and the building blocks for
 * moving value between a public balance and a private one.
 *
 * What each operation reveals on the Default Ring (the only ring on mainnet):
 *
 *   deposit   public -> private   wallet, asset and amount are public
 *   transfer  private -> private  the two wallets are public; asset and amount are encrypted
 *   withdraw  private -> public   wallet, asset and amount are public
 *
 * Nothing in this file can change that. It is the protocol's own model.
 */

import {
  type Address,
  type Instruction,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  type Signature,
  type Transaction,
  getSignatureFromTransaction,
  isSolanaError,
  sendTransactionWithoutConfirmingFactory,
} from '@solana/kit';
import {
  MergeEncryptionScheme,
  SOL_MINT,
  SPL_TOKEN_PROGRAM_ID,
  type ShieldedAddress,
  type ShieldedKeypair,
  Wallet,
  type WalletKeys,
  buildDepositTransaction,
  buildMergeTransaction,
  buildRegistrationTransaction,
  buildSetMergeEncryptionTransaction,
  buildTransferTransaction,
  buildWithdrawalTransaction,
  createSprClient,
  getPrivateTransactions,
  syncWallet,
} from '@heliuslabs/spr';
import { getProtocolConfigAddress, getSplAssetRegistryAddress } from '@heliuslabs/spr/addresses';
import { SignedTeePolicy, type SprClient } from '@heliuslabs/spr/client';
import { getCreateSplInterfaceInstructionAsync } from '@heliuslabs/spr/instructions';
import { decodeProtocolConfig, decodeSplAssetRegistry, decodeTreeFees, type TransactInstructionData } from '@heliuslabs/spr/interface';
import { ConfidentialTransfer, ProofInputUtxo } from '@heliuslabs/spr/transaction';
import { fetchUserRecord, isWalletRegistered } from '@heliuslabs/spr/wallet';

import { COMPUTE_UNITS, NETWORK, TEE_POLICY_HOST } from './constants.js';
import { type Outcome, type StatusSeen, outcomeOf } from './desk-rules.js';
import { GHOST_LIMITS } from './ghost.js';
import type { HistoryRow } from './payrecords.js';
import { type Lifetime, instructionsOf, priorityFeeFor, wireBase64 } from './tx.js';

export { SOL_MINT };

export class RingsError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'RingsError';
    this.code = code;
  }
}

export interface RingsClientOptions {
  /** Solana JSON-RPC endpoint. In the browser this is the server's proxy, so the API key stays private. */
  readonly rpcUrl: string;
  /** Indexer and prover endpoint (`…/v1/spr`). */
  readonly sprUrl: string;
  /**
   * Where to fetch the signed prover attestation policy instead of its
   * CloudFront host, for browsers that cannot reach it cross-origin. The SDK
   * still verifies the policy's signatures against keys pinned in the SDK, so
   * a relay cannot forge one.
   */
  readonly teePolicyRelay?: string;
  /**
   * Priority price in micro-lamports per compute unit, at the time the client
   * is made. It prices the transactions the SDK builds on its own (deposit,
   * withdrawal, transfer, registration). Transactions this code composes take
   * the live price from the wallet context instead.
   */
  readonly priorityMicroLamports?: number;
  readonly fetch?: typeof globalThis.fetch;
}

/** True for loopback endpoints, where the local stack runs an unattested prover. */
function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  } catch {
    return false;
  }
}

export async function createRingsClient(options: RingsClientOptions): Promise<SprClient> {
  const baseFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const relay = options.teePolicyRelay;
  const routedFetch: typeof globalThis.fetch = (input, init) => {
    if (relay !== undefined) {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      try {
        const parsed = new URL(url);
        if (parsed.hostname === TEE_POLICY_HOST) {
          return baseFetch(`${relay.replace(/\/+$/, '')}${parsed.pathname}`, init);
        }
      } catch {
        // Not an absolute URL: fall through to the plain fetch.
      }
    }
    return baseFetch(input, init);
  };
  // The prover must be attested: the SDK encrypts every proof request to an
  // enclave whose measurement matches mainnet's signed policy, and to no other.
  // (A prover on this machine itself, which only the offline tests use, has no enclave.)
  const attested = !isLoopback(options.sprUrl);
  const sdkPriority = priorityFeeFor(options.priorityMicroLamports ?? 0, COMPUTE_UNITS.single);
  return createSprClient({
    solanaRpcUrl: options.rpcUrl,
    indexerUrl: options.sprUrl,
    proverUrl: options.sprUrl,
    ...(attested ? { proverTee: SignedTeePolicy.forNetwork(NETWORK) } : {}),
    ...(sdkPriority > 0n ? { priorityFeeLamports: sdkPriority } : {}),
    fetch: routedFetch,
  });
}

/** Everything a flow needs about the connected wallet. */
export interface RingsContext {
  readonly client: SprClient;
  /** The SDK's local view of this wallet's private notes. */
  readonly wallet: Wallet;
  readonly keys: WalletKeys;
  /** Solana address: public, and the address private transfers are sent to. */
  readonly owner: Address;
  readonly shielded: ShieldedAddress;
  /** Present only for the built-in ghost wallet. Ghost fill needs it. */
  readonly keypair?: ShieldedKeypair;
  /** Adds the owner's signature. Other signatures already on the transaction are kept. */
  sign(transaction: Transaction): Promise<Transaction>;
  /**
   * The priority price right now, in micro-lamports per compute unit. Asked
   * each time a transaction is composed, so a long-lived wallet follows the
   * network. Absent means no priority fee.
   */
  priority?(): number;
}

/** The priority fee, in lamports, for a transaction of this wallet that reserves `computeUnits`. */
export function priorityOf(ctx: Pick<RingsContext, 'priority'>, computeUnits: number): bigint {
  return priorityFeeFor(ctx.priority?.() ?? 0, computeUnits);
}

export function newWalletState(shielded: ShieldedAddress): Wallet {
  return new Wallet({ identity: shielded });
}

export async function syncRings(ctx: RingsContext, requireSlot?: bigint): Promise<void> {
  await syncWallet({
    client: ctx.client,
    wallet: ctx.wallet,
    keys: ctx.keys,
    ...(requireSlot === undefined ? {} : { config: { requireSlot } }),
  });
}

/**
 * The wallet's private balance of `mint`. A mint the wallet has never learned
 * (no note of it was ever decoded) is a balance of zero; the SDK throws for it.
 */
export function privateBalance(ctx: RingsContext, mint: Address): bigint {
  try {
    return ctx.wallet.balance(mint).amount;
  } catch {
    return 0n;
  }
}

export function privateNoteCount(ctx: RingsContext, mint: Address): number {
  try {
    return ctx.wallet.balance(mint).utxos.length;
  } catch {
    return 0;
  }
}

export interface PrivateHolding {
  readonly mint: Address;
  readonly amount: bigint;
  readonly notes: number;
}

export function privateHoldings(ctx: RingsContext): PrivateHolding[] {
  return ctx.wallet
    .balances()
    .filter((balance) => balance.amount > 0n)
    .map((balance) => ({ mint: balance.mint, amount: balance.amount, notes: balance.utxos.length }));
}

export function privateHistory(ctx: RingsContext) {
  return getPrivateTransactions(ctx.wallet);
}

/**
 * A wallet's private history as plain rows: what statements, alerts and
 * payment requests are worked out from. Takes the note state alone, so a
 * read-only view of a wallet can use it too.
 */
export function historyRowsOf(wallet: Wallet): HistoryRow[] {
  return getPrivateTransactions(wallet).map((entry) => ({
    signature: entry.id.signature,
    slot: entry.id.slot,
    index: entry.id.index,
    kind: entry.kind,
    direction: entry.direction,
    asset: entry.asset,
    amount: entry.amount,
  }));
}

/* ------------------------------------------------------------------ */
/* Sending                                                             */
/* ------------------------------------------------------------------ */

export interface Landed {
  readonly signature: Signature;
  readonly slot: bigint;
}

/** Signs with the owner, sends, waits for confirmation, then syncs the wallet to that slot. */
export async function signAndSend(ctx: RingsContext, transaction: Transaction): Promise<Landed> {
  const signed = await ctx.sign(transaction);
  return sendSigned(ctx, signed);
}

/* ---- Notes set aside by a transaction that was never sent ---- */

/**
 * How many transactions each wallet has handed to the network from this page,
 * or may have. `spending` reads it to tell a try that never left from one
 * that did.
 */
const handedOver = new WeakMap<object, number>();

function noteHandedOver(ctx: Pick<RingsContext, 'wallet'>): void {
  // This runs right after a transaction has gone out. Nothing here may throw: a send that worked must never be reported as one that failed.
  try {
    if (typeof ctx.wallet === 'object' && ctx.wallet !== null) handedOver.set(ctx.wallet, (handedOver.get(ctx.wallet) ?? 0) + 1);
  } catch {
    // A WeakMap takes any object as a key, so there is nothing to catch. The guard is here because of where this runs.
  }
}

/** The count for a wallet, or null when it cannot be kept for this wallet at all. */
function sentSoFar(ctx: Pick<RingsContext, 'wallet'>): number | null {
  return typeof ctx.wallet === 'object' && ctx.wallet !== null ? (handedOver.get(ctx.wallet) ?? 0) : null;
}

/**
 * The first send of a transaction, which runs the RPC's own simulation. When
 * that simulation refuses the transaction it never reaches the network, and
 * the RPC says so with an error of its own. Any other failure here, a
 * connection that dropped for one, leaves it unknown whether the transaction
 * went out, and is counted as if it had.
 */
async function firstSend(ctx: Pick<RingsContext, 'wallet'>, send: () => Promise<unknown>): Promise<void> {
  try {
    await send();
  } catch (error) {
    if (!refusedInSimulation(error)) noteHandedOver(ctx);
    throw error;
  }
  noteHandedOver(ctx);
}

/**
 * True when a first send was refused by the RPC's own simulation: the
 * transaction never reached the network, so nothing can ever come of it.
 * False for every other failure of a send, after which the transaction may
 * or may not be on its way.
 */
export function refusedInSimulation(error: unknown): boolean {
  return isSolanaError(error, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE);
}

/** The ids of what the SDK currently has set aside for this wallet. The list is the SDK's own, so reading it is guarded. */
function setAside(ctx: Pick<RingsContext, 'wallet'>): string[] {
  try {
    return typeof ctx.wallet._reservationEntries === 'function' ? ctx.wallet._reservationEntries().map((entry) => entry.id) : [];
  } catch {
    return [];
  }
}

/** Taken before a spend is built. See `markSpend`. */
export interface SpendMark {
  /**
   * Lets go of the notes set aside since the mark was taken. Does nothing when
   * a transaction of this wallet has been handed to the network since then, or
   * may have been.
   */
  release(): void;
}

/**
 * The SDK sets the notes a spend is built on aside for two minutes, so that a
 * second transaction is not built on them while the first is on its way. A
 * transaction that was built and then never sent holds them for nothing, and
 * until they are let go the wallet is told that its balance does not cover
 * what it plainly holds.
 *
 * So a mark is taken before a spend is built, and when the try fails with
 * nothing sent, `release` lets go of what it set aside. Once a transaction has
 * gone out, or may have, `release` lets go of nothing: the two minutes exist
 * for exactly that case. Letting go moves no funds either way; it only decides
 * which notes the next transaction may be built on.
 */
export function markSpend(ctx: Pick<RingsContext, 'wallet'>): SpendMark {
  const before = new Set(setAside(ctx));
  const sent = sentSoFar(ctx);
  return {
    release() {
      // Where the count cannot be kept, nothing is let go: it could not be told whether a transaction went out.
      if (sent === null || sentSoFar(ctx) !== sent) return;
      try {
        if (typeof ctx.wallet._releaseReservation !== 'function') return;
        for (const id of setAside(ctx)) if (!before.has(id)) ctx.wallet._releaseReservation(id);
      } catch {
        // Nothing depends on this: the notes come free by themselves two minutes after they were set aside.
      }
    },
  };
}

/** Runs `work`, which builds a spend from the private balance and sends it. If it fails with nothing sent, the notes it set aside are let go. */
export async function spending<T>(ctx: Pick<RingsContext, 'wallet'>, work: () => Promise<T>): Promise<T> {
  const mark = markSpend(ctx);
  try {
    return await work();
  } catch (error) {
    mark.release();
    throw error;
  }
}

const RESEND_EVERY_MS = 2_000;

export async function sendSigned(ctx: RingsContext, signed: Transaction): Promise<Landed> {
  const send = sendTransactionWithoutConfirmingFactory({ rpc: ctx.client.solanaRpc });
  const wire = signed as Parameters<typeof send>[0];
  // The first send runs the RPC's preflight simulation, so a transaction that
  // would fail is refused here, with its logs, and never reaches the network.
  await firstSend(ctx, () => send(wire, { commitment: 'confirmed' }));
  const signature = getSignatureFromTransaction(signed);
  // Mainnet drops transactions that are sent once. The same signed bytes are
  // sent again every two seconds until the transaction confirms or the wait
  // gives up; a repeat of a landed transaction is ignored by the network.
  let waiting = true;
  const resend = (async () => {
    while (waiting) {
      await new Promise((resolve) => setTimeout(resolve, RESEND_EVERY_MS));
      if (!waiting) break;
      try {
        await send(wire, { commitment: 'confirmed', skipPreflight: true, maxRetries: 0n });
      } catch {
        // Already processed, or the blockhash has expired: the confirmation below is what decides.
      }
    }
  })();
  let slot: bigint;
  try {
    slot = await ctx.client.confirmTransaction(signature);
  } finally {
    waiting = false;
    void resend;
  }
  try {
    await syncRings(ctx, slot);
  } catch {
    // The transaction landed. A slow indexer must not turn that into an error;
    // the next sync catches up.
  }
  return { signature, slot };
}

/** How `sendAndSettle` waits. Tests replace the clock; nothing else should. */
export interface SettleOptions {
  /** The longest to go on looking after the first send, in milliseconds. */
  readonly maxWaitMs?: number;
  /** Milliseconds between two looks at the chain. */
  readonly pollMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

/**
 * Sends a signed transaction and stays with it until the chain has decided:
 * landed, rejected, or too old to ever land. Unlike `sendSigned` it does not
 * give up on the first RPC hiccup or after a fixed wait, so its answer can be
 * told to a counterparty as fact. `pending` comes back only when the RPC
 * itself stopped answering for the whole wait.
 *
 * The first send runs the RPC's own simulation and throws when that refuses
 * the transaction: nothing was sent then.
 */
export async function sendAndSettle(
  ctx: RingsContext,
  signed: Transaction,
  lastValidBlockHeight: bigint,
  options: SettleOptions = {},
): Promise<Outcome> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const maxWaitMs = options.maxWaitMs ?? 120_000;
  const pollMs = options.pollMs ?? 1_000;
  const rpc = ctx.client.solanaRpc;
  const send = sendTransactionWithoutConfirmingFactory({ rpc });
  const wire = signed as Parameters<typeof send>[0];
  await firstSend(ctx, () => send(wire, { commitment: 'confirmed' }));
  const signature = getSignatureFromTransaction(signed);
  const started = now();
  let lastSend = started;
  for (;;) {
    await sleep(pollMs);
    let answered = false;
    let height: bigint | null = null;
    let status: StatusSeen | null = null;
    // Height first, status second: a transaction that made its last block is visible by the time it is asked for.
    // Without a height nothing is ever called expired, but a landing or a rejection is still seen.
    try {
      height = BigInt(await rpc.getBlockHeight({ commitment: 'confirmed' }).send());
    } catch {
      height = null;
    }
    try {
      const { value } = await rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }).send();
      answered = true;
      const seen = value[0];
      if (seen) {
        status = {
          slot: BigInt(seen.slot),
          failed: seen.err !== null,
          confirmed: seen.confirmationStatus === 'confirmed' || seen.confirmationStatus === 'finalized',
        };
      }
    } catch {
      // An RPC that did not answer decides nothing either way.
    }
    if (answered) {
      const outcome = outcomeOf(status, height, lastValidBlockHeight);
      if (outcome.kind === 'landed') {
        try {
          await syncRings(ctx, outcome.slot);
        } catch {
          // It landed. A slow indexer must not turn that into an error; the next sync catches up.
        }
      }
      if (outcome.kind !== 'pending') return outcome;
    }
    if (now() - started >= maxWaitMs) return { kind: 'pending' };
    if (now() - lastSend >= RESEND_EVERY_MS) {
      lastSend = now();
      try {
        await send(wire, { commitment: 'confirmed', skipPreflight: true, maxRetries: 0n });
      } catch {
        // Already processed, or too old: the look at the chain above is what decides.
      }
    }
  }
}

/**
 * One look at the chain for a transaction that was handed to the network
 * earlier: landed, rejected, too old to ever land, or not decided yet. It
 * sends nothing. It throws when the RPC does not answer for the signature,
 * because no answer decides nothing either way.
 */
export async function lookUpSent(client: SprClient, signature: Signature, lastValidBlockHeight: bigint): Promise<Outcome> {
  const rpc = client.solanaRpc;
  // Height first, status second, as in `sendAndSettle`: a transaction that made its last block is visible by the time it is asked for.
  let height: bigint | null;
  try {
    height = BigInt(await rpc.getBlockHeight({ commitment: 'confirmed' }).send());
  } catch {
    height = null;
  }
  const { value } = await rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }).send();
  const seen = value[0];
  const status: StatusSeen | null = seen
    ? { slot: BigInt(seen.slot), failed: seen.err !== null, confirmed: seen.confirmationStatus === 'confirmed' || seen.confirmationStatus === 'finalized' }
    : null;
  // A failure is final only once its block is confirmed. Before that it may sit on a fork that is dropped,
  // and the same transaction can still land on the fork that is kept.
  if (status !== null && status.failed && !status.confirmed) return { kind: 'pending' };
  return outcomeOf(status, height, lastValidBlockHeight);
}

/**
 * `sendAndSettle`, for a caller that will build the same payment again when
 * it is told the first one was rejected. For that caller a rejection has to
 * be final, so one that was seen before its block was confirmed is looked at
 * again until it is confirmed, or turns out to have landed after all. If
 * neither happens within the wait, the answer is `pending`: not known.
 */
export async function sendAndSettleFinal(
  ctx: RingsContext,
  signed: Transaction,
  lastValidBlockHeight: bigint,
  options: SettleOptions = {},
): Promise<Outcome> {
  const outcome = await sendAndSettle(ctx, signed, lastValidBlockHeight, options);
  if (outcome.kind !== 'rejected') return outcome;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const signature = getSignatureFromTransaction(signed);
  for (let look = 0; look < 30; look += 1) {
    try {
      const again = await lookUpSent(ctx.client, signature, lastValidBlockHeight);
      if (again.kind !== 'pending') return again;
    } catch {
      // An RPC that did not answer decides nothing either way.
    }
    await sleep(options.pollMs ?? 1_000);
  }
  return { kind: 'pending' };
}

export interface Simulation {
  readonly ok: boolean;
  /** The most telling log line, or the raw error, when the run failed. */
  readonly error: string;
  readonly logs: readonly string[];
  /** Compute units the run used, when the RPC reports them. */
  readonly unitsConsumed: bigint | undefined;
  /**
   * The accounts asked for with `watch`, as the run would leave them, in the
   * same order. Null for an account that would not exist. Empty when nothing
   * was watched or the RPC did not answer for them.
   */
  readonly accounts: ReadonlyArray<{ readonly lamports: bigint; readonly data: Uint8Array } | null>;
}

/**
 * Runs a transaction against current chain state without sending it.
 * Signatures are not checked, so this works before anyone has signed.
 * `watch` names accounts whose state after the run is wanted back.
 */
export async function simulate(client: SprClient, transaction: Transaction, watch: readonly Address[] = []): Promise<Simulation> {
  const config = {
    encoding: 'base64',
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: 'confirmed',
    ...(watch.length === 0 ? {} : { accounts: { encoding: 'base64', addresses: [...watch] } }),
  };
  // Called as a method of the RPC object, exactly as before; only the types are loosened, because
  // the answer's shape depends on the options and this reads the two optional parts of it.
  const rpc = client.solanaRpc as unknown as {
    simulateTransaction(
      wire: string,
      options: typeof config,
    ): { send(): Promise<{ value: { err: unknown; logs?: readonly string[] | null; unitsConsumed?: bigint | number | null; accounts?: ReadonlyArray<SimulatedAccount | null> | null } }> };
  };
  const result = await rpc.simulateTransaction(wireBase64(transaction), config).send();
  const logs = result.value.logs ?? [];
  const unitsConsumed = result.value.unitsConsumed === undefined || result.value.unitsConsumed === null ? undefined : BigInt(result.value.unitsConsumed);
  const accounts = (result.value.accounts ?? []).map((account) => (account ? { lamports: BigInt(account.lamports), data: simulatedData(account.data) } : null));
  if (!result.value.err) return { ok: true, error: '', logs, unitsConsumed, accounts };
  const telling = [...logs].reverse().find((entry) => /error|failed|insufficient|exceeded/i.test(entry));
  const raw = JSON.stringify(result.value.err, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value));
  return { ok: false, error: telling ?? raw, logs, unitsConsumed, accounts };
}

/** An account in a simulation's answer: its data arrives as `[base64, "base64"]`. */
interface SimulatedAccount {
  readonly lamports: bigint | number;
  readonly data: readonly [string, string] | string;
}

function simulatedData(data: SimulatedAccount['data']): Uint8Array {
  const text = typeof data === 'string' ? data : data[0];
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export async function latestLifetime(client: SprClient): Promise<Lifetime> {
  const lifetime = await client.getLatestBlockhash();
  return { blockhash: lifetime.blockhash, lastValidBlockHeight: lifetime.lastValidBlockHeight };
}

/* ------------------------------------------------------------------ */
/* Registration                                                        */
/* ------------------------------------------------------------------ */

export async function isRegistered(client: SprClient, owner: Address): Promise<boolean> {
  return isWalletRegistered({ rpc: client, owner });
}

/**
 * The one-time transactions that let this wallet receive private transfers by
 * its Solana address and let its balance be consolidated: the registry record,
 * then the merge encryption setting. Empty when both already exist.
 */
export async function registrationTransactions(ctx: RingsContext): Promise<Transaction[]> {
  const transactions: Transaction[] = [];
  const registration = await buildRegistrationTransaction({
    client: ctx.client,
    owner: ctx.owner,
    address: ctx.shielded,
  });
  if (registration !== undefined) transactions.push(registration);
  const record = registration === undefined ? await fetchUserRecord({ rpc: ctx.client, owner: ctx.owner }) : undefined;
  const mergeEnabled = record !== undefined && record.mergeEncryption === MergeEncryptionScheme.PoseidonCtrV1;
  if (!mergeEnabled) {
    const merge = await buildSetMergeEncryptionTransaction({
      client: ctx.client,
      owner: ctx.owner,
      scheme: MergeEncryptionScheme.PoseidonCtrV1,
    });
    if (merge !== undefined) transactions.push(merge);
  }
  return transactions;
}

/* ------------------------------------------------------------------ */
/* Whole-transaction builders                                          */
/* ------------------------------------------------------------------ */

export interface DepositParams {
  readonly asset: Address;
  readonly amount: bigint;
  /** Required for SPL assets: the public token account the deposit is taken from. */
  readonly sourceTokenAccount?: Address;
  readonly tokenProgram?: Address;
}

/** public -> private. Asset, amount and wallet are public. No proof is needed. */
export function depositTransaction(ctx: RingsContext, params: DepositParams): Promise<Transaction> {
  return buildDepositTransaction({
    client: ctx.client,
    feePayer: ctx.owner,
    recipient: ctx.shielded,
    amount: params.amount,
    ...(params.asset === SOL_MINT
      ? {}
      : {
          asset: params.asset,
          ...(params.sourceTokenAccount === undefined ? {} : { splTokenAccount: params.sourceTokenAccount }),
          splTokenProgram: params.tokenProgram ?? SPL_TOKEN_PROGRAM_ID,
        }),
  });
}

export interface WithdrawParams {
  readonly asset: Address;
  readonly amount: bigint;
  readonly recipient: Address;
  readonly tokenProgram?: Address;
}

/** private -> public. Asset, amount and both wallets are public. */
export function withdrawTransaction(ctx: RingsContext, params: WithdrawParams): Promise<Transaction> {
  return buildWithdrawalTransaction({
    client: ctx.client,
    wallet: ctx.wallet,
    keys: ctx.keys,
    feePayer: ctx.owner,
    recipient: params.recipient,
    amount: params.amount,
    ...(params.asset === SOL_MINT ? {} : { asset: params.asset, splTokenProgram: params.tokenProgram ?? SPL_TOKEN_PROGRAM_ID }),
  });
}

/** private -> private, to a Solana address. The two wallets are public; asset and amount are encrypted. */
export function transferTransaction(
  ctx: RingsContext,
  params: Readonly<{ asset: Address; amount: bigint; recipient: Address }>,
): Promise<Transaction> {
  return buildTransferTransaction({
    client: ctx.client,
    wallet: ctx.wallet,
    keys: ctx.keys,
    feePayer: ctx.owner,
    recipient: params.recipient,
    amount: params.amount,
    ...(params.asset === SOL_MINT ? {} : { asset: params.asset }),
  });
}

/** Consolidates a fragmented balance into one note. Spends nothing and changes no owner. */
export function mergeTransaction(ctx: RingsContext, asset: Address): Promise<Transaction> {
  return buildMergeTransaction({
    client: ctx.client,
    wallet: ctx.wallet,
    keys: ctx.keys,
    feePayer: ctx.owner,
    ...(asset === SOL_MINT ? {} : { asset }),
  });
}

/* ------------------------------------------------------------------ */
/* Instruction-level builders, for composing with a public swap        */
/* ------------------------------------------------------------------ */

export async function withdrawInstructions(ctx: RingsContext, params: WithdrawParams): Promise<Instruction[]> {
  return [...instructionsOf(await withdrawTransaction(ctx, params))];
}

export async function depositInstructions(ctx: RingsContext, params: DepositParams): Promise<Instruction[]> {
  return [...instructionsOf(await depositTransaction(ctx, params))];
}

/* ------------------------------------------------------------------ */
/* Protocol state                                                      */
/* ------------------------------------------------------------------ */

export interface ProtocolFacts {
  readonly splInterfaceCreationIsPermissionless: boolean;
  readonly treeCreationIsPermissionless: boolean;
  readonly ringActivationIsPermissionless: boolean;
  readonly protocolAuthority: Address;
  /**
   * The tree's fee field as SDK 0.9.0-alpha decodes it. That SDK predates the
   * deployed 1.0 program's per-tree fee layout, so treat this as indicative
   * only; the program charges whatever its own schedule says, capped on chain
   * at 1,000,000 lamports per tree written.
   */
  readonly treeFeeFieldLamports: bigint | null;
}

export async function readProtocolFacts(client: SprClient): Promise<ProtocolFacts> {
  const account = await client.getAccount(await getProtocolConfigAddress());
  if (!account) throw new RingsError('NO_PROTOCOL_CONFIG', 'The Solana Privacy Program could not be read from this RPC.');
  const config = decodeProtocolConfig(account.data);
  let treeFeeFieldLamports: bigint | null = null;
  try {
    const tree = await client.getAccount(client.tree);
    if (tree) treeFeeFieldLamports = decodeTreeFees(tree.data).fees.feePerNullifier;
  } catch {
    treeFeeFieldLamports = null;
  }
  return {
    splInterfaceCreationIsPermissionless: config.splInterfaceCreationIsPermissionless,
    treeCreationIsPermissionless: config.treeCreationIsPermissionless,
    ringActivationIsPermissionless: config.ringActivationIsPermissionless,
    protocolAuthority: config.authority,
    treeFeeFieldLamports,
  };
}

/** The Rings asset id of a mint, or `undefined` when the mint has no private interface yet. */
export async function fetchAssetId(client: SprClient, mint: Address): Promise<bigint | undefined> {
  if (mint === SOL_MINT) return 1n;
  const account = await client.getAccount(await getSplAssetRegistryAddress(mint));
  if (!account || account.data.length === 0) return undefined;
  return decodeSplAssetRegistry(account.data).assetId;
}

/** Creates a mint's private interface (registry entry and vault). The authority pays the rent. */
export function createInterfaceInstruction(authority: Address, mint: Address, tokenProgram: Address = SPL_TOKEN_PROGRAM_ID): Promise<Instruction> {
  return getCreateSplInterfaceInstructionAsync({ authority, mint, tokenProgram });
}

/* ------------------------------------------------------------------ */
/* Ghost fill leg                                                      */
/* ------------------------------------------------------------------ */

export interface GhostLegParams {
  readonly asset: Address;
  readonly amount: bigint;
  /** The counterparty's registered shielded address. */
  readonly recipient: ShieldedAddress;
  /** Who pays the transaction fee. In a Ghost fill this is the desk. */
  readonly feePayer: Address;
  /**
   * Spend exactly these notes instead of choosing among the balance. Only the
   * desk's own dry run uses it, to put two legs that do not share a note into
   * one transaction.
   */
  readonly notes?: ReturnType<Wallet['balance']>['utxos'];
}

/**
 * Builds and proves one private-to-private transfer and returns it as
 * structured data, not as a transaction: the caller hands it to the
 * counterparty, who rebuilds the instruction and places it next to their own.
 * The proof authorizes nothing on its own. The owner's signature over the
 * whole Solana transaction does.
 */
export async function buildGhostLeg(ctx: RingsContext, params: GhostLegParams): Promise<TransactInstructionData> {
  const keypair = ctx.keypair;
  if (!keypair) {
    throw new RingsError('GHOST_WALLET_REQUIRED', 'Ghost fill needs the built-in ghost wallet. Use the Shielded route with an external wallet.');
  }
  if (params.amount <= 0n) throw new RingsError('BAD_AMOUNT', 'The amount must be greater than zero.');
  const balance = ctx.wallet.balance(params.asset);
  if (balance.amount < params.amount) {
    throw new RingsError('INSUFFICIENT_PRIVATE_BALANCE', 'Your private balance does not cover this trade.');
  }
  // Largest notes first, so as few as possible are spent.
  const notes = [...(params.notes ?? balance.utxos)].sort((a, b) => (a.amount === b.amount ? 0 : a.amount > b.amount ? -1 : 1));
  const selected: typeof notes = [];
  let covered = 0n;
  for (const note of notes) {
    if (covered >= params.amount) break;
    selected.push(note);
    covered += note.amount;
  }
  if (covered < params.amount) {
    throw new RingsError('INSUFFICIENT_PRIVATE_BALANCE', 'The notes given do not cover this amount.');
  }
  if (selected.length > GHOST_LIMITS.maxInputs) {
    throw new RingsError(
      'TOO_FRAGMENTED',
      `This trade needs ${selected.length} notes; a fill can spend ${GHOST_LIMITS.maxInputs}. Consolidate the balance in the wallet first.`,
    );
  }
  const transfer = new ConfidentialTransfer(
    ctx.shielded,
    selected.map((note) => ProofInputUtxo.fromKeypair(note, keypair)),
    params.feePayer,
  );
  transfer.send(params.recipient, params.asset, params.amount);
  const proofInputs = transfer.sign(keypair, ctx.wallet.registry);
  return ctx.client.proveTransact(proofInputs, ctx.keys);
}
