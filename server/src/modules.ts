/**
 * Fee modules, the server's side: the wallets, and the keeper that runs them.
 *
 * WHAT THIS HOLDS
 *   One secret, MODULES_SEED. From it the server works out, for each token
 *   with modules:
 *     - the WALLET that holds the pool's creator role. Curve fees can only be
 *       claimed by it, and the platform's payout of pool fees arrives in it.
 *       It never keeps anything: each pass that pays out leaves it empty.
 *     - the POT that holds the buyback share until it is spent.
 *   and one GAS TANK for all of them, which pays network fees and the rent of
 *   token accounts. The operator keeps the gas tank funded.
 *
 * WHAT A PASS DOES, per token, every MODULES_EVERY_MINUTES
 *   1. PAYOUT. One transaction claims the creator's curve fees and divides
 *      them, with whatever the wallet already held, exactly as the settings
 *      say: a share to each wallet, the rest to the pot. All of it or none of
 *      it. Nothing is paid until the amount is worth acting on.
 *   2. BUYBACK. One transaction buys the token with what the pot holds (on the
 *      curve, or on the pool once the token has graduated) and burns what it
 *      bought in the same transaction.
 *
 * WHAT KEEPS IT HONEST
 *   - There is no ledger to get out of step. Every amount is read from the
 *     chain at the moment it is used.
 *   - Every transaction is run against the chain first. One that would fail
 *     is never sent.
 *   - Two servers running at once cannot pay twice: the second one's transfers
 *     find the wallet already empty and its whole transaction fails.
 *   - The settings a token runs under are the ones its wallet's address was
 *     worked out from, and the chain says which wallet holds the role.
 *
 * WHAT IT RISKS
 *   Whoever reads MODULES_SEED can take creator fees that have not been paid
 *   out yet, the pots, and the gas tank. Never a trader's money, never the
 *   platform's share, never liquidity. Losing the seed is worse than leaking
 *   it: the creator fees of every module token would be locked for good.
 */

import { createHmac } from 'node:crypto';
import bs58 from 'bs58';
import {
  type AccountInfo,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  type TransactionInstruction,
} from '@solana/web3.js';
import {
  ACCOUNT_SIZE,
  AccountLayout,
  createAssociatedTokenAccountIdempotentInstruction,
  createBurnCheckedInstruction,
  createCloseAccountInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import type { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk';

import type { ModuleEventView, ModulePrepareResponse, ModuleView, ModulesStatus } from '../../shared/src/api.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_ACCOUNT_RENT_LAMPORTS, TOKEN_DECIMALS, TOKEN_PROGRAM_ID } from '../../shared/src/constants.js';
import {
  type GraduatedPool,
  type Market,
  MarketError,
  type TradeQuote,
  creatorClaimInstruction,
  curveSwapInstructions,
  graduatedSwapInstructions,
  loadPoolStates,
  quoteCurve,
  quoteGraduated,
} from '../../shared/src/meteora.js';
import {
  MAX_MODULE_WALLETS,
  MIN_SHARE_BPS,
  MODULE_MEMO_PREFIX,
  ModuleError,
  type ModuleSettings,
  type ModuleSettingsInput,
  type ModuleShares,
  type SplitAmounts,
  checkModuleSettings,
  checkModuleShares,
  describeModule,
  encodeModuleMemo,
  parseModuleMemo,
  planBuyback,
  planSweep,
} from '../../shared/src/modules.js';
import { type TradingPair, fromSolLamports } from '../../shared/src/quotes.js';
import { formatUnits } from '../../shared/src/units.js';
import type { Chain } from './chain.js';
import type { ModuleEventKind, ModuleRow, Store } from './db.js';
import { type AppEnv, EnvError } from './env.js';
import type { PriorityOracle } from './priority.js';

const TOKEN_PROGRAM = new PublicKey(TOKEN_PROGRAM_ID);
const ATA_PROGRAM = new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID);
const RENT = TOKEN_ACCOUNT_RENT_LAMPORTS;

/** The least one buyback spends, in SOL terms. Below it the network fee is too large a part of the buy. */
export const MIN_BUY_LAMPORTS = 5_000_000n;
/** The gas tank is never drawn below this. A pass that would do so waits for a top-up instead. */
export const GAS_FLOOR_LAMPORTS = 3_000_000n;
/** Allowed for one transaction's network fee when checking the gas tank. */
const FEE_ALLOWANCE_LAMPORTS = 200_000n;
/** The compute budget a transaction is tried with, before it is sized from what it used. */
const TRIAL_UNITS = 600_000;
/** How far back a creator's history is searched for a module memo: pages of 1,000 transactions. */
const SEARCH_PAGES = 5;
/** How often a sent transaction is looked for, and sent again. */
const CONFIRM_EVERY_MS = 2_000;
/** How long a sent transaction is watched before the pass moves on. A blockhash lasts about a minute and a half. */
const CONFIRM_DEADLINE_MS = 180_000;

/** The chain ran a transaction and it failed. Unlike an RPC that does not answer, that is final. */
class FailedOnChain extends Error {}

/**
 * How the note begins when a payout waits because a sharing wallet has no
 * account for the pair token and the server will not open one (again). A
 * token's page is told about this case by name.
 */
const WAITING_ON_ACCOUNTS = 'payout waiting on token accounts: ';

export class ModulesError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ModulesError';
    this.status = status;
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/* Keys                                                                */
/* ------------------------------------------------------------------ */

/** MODULES_SEED as its 32 bytes. */
export function moduleSeedBytes(seed: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = bs58.decode(seed.trim());
  } catch {
    throw new EnvError('MODULES_SEED is not valid base58. Paste the line `npm run modules:new` printed.');
  }
  if (bytes.length !== 32) throw new EnvError('MODULES_SEED must be 32 bytes. Paste the line `npm run modules:new` printed, whole.');
  return bytes;
}

/** A new seed, as the one line that goes into MODULES_SEED. */
export function newModuleSeed(): string {
  return bs58.encode(Keypair.generate().secretKey.subarray(0, 32));
}

function derive(seed: Uint8Array, label: string): Keypair {
  return Keypair.fromSeed(createHmac('sha256', seed).update(label, 'utf8').digest());
}

/** The wallet that pays the modules' network fees and account rent. One for the whole server. */
export function gasTankOf(seed: Uint8Array): Keypair {
  return derive(seed, 'pcf/modules/v1/gas');
}

/**
 * The two wallets of one token's modules. They follow from the settings' own
 * text, which names the token, so different settings for the same token, or
 * the same settings for another token, give different wallets.
 */
export function moduleWallets(seed: Uint8Array, memo: string): { wallet: Keypair; pot: Keypair } {
  return { wallet: derive(seed, `pcf/modules/v1/wallet\n${memo}`), pot: derive(seed, `pcf/modules/v1/pot\n${memo}`) };
}

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

/** A token account as far as a pass needs it: what it holds, and the lamports that come back when it is closed. */
export interface TokenAccountState {
  readonly amount: bigint;
  readonly lamports: bigint;
}

/** Reads a token account. Null for a missing account and for anything that is not `owner`'s account for `mint`. */
export function tokenAccountState(info: AccountInfo<Buffer> | null, mint: PublicKey, owner: PublicKey): TokenAccountState | null {
  if (!info || !info.owner.equals(TOKEN_PROGRAM) || info.data.length !== ACCOUNT_SIZE) return null;
  const account = AccountLayout.decode(info.data);
  if (!account.mint.equals(mint) || !account.owner.equals(owner)) return null;
  return { amount: BigInt(account.amount.toString()), lamports: BigInt(info.lamports) };
}

/** Everything a pass reads about one token's modules, in one request. */
export interface ModuleAccounts {
  /** Lamports the wallet holds as plain SOL. */
  readonly walletLamports: bigint;
  /** The wallet's account for the pair token. For SOL this is a wrapped-SOL account, which exists only if something left it behind. */
  readonly walletQuote: TokenAccountState | null;
  /** The wallet's account for the token itself. A claim needs it to exist although nothing is paid into it. */
  readonly walletBase: TokenAccountState | null;
  readonly potLamports: bigint;
  readonly potQuote: TokenAccountState | null;
  /** The pot's account for the token: what a buyback lands in and is burned from. */
  readonly potBase: TokenAccountState | null;
  /** For a pair token other than SOL: each sharing wallet's account for it, in the settings' order. Empty for SOL. */
  readonly recipients: ReadonlyArray<TokenAccountState | null>;
}

const ata = (mint: PublicKey, owner: PublicKey): PublicKey => getAssociatedTokenAddressSync(mint, owner, true);

/** The addresses `readModuleAccounts` asks for, in order. */
export function moduleAccountAddresses(market: Pick<Market, 'mint' | 'pair'>, settings: ModuleSettings, wallet: PublicKey, pot: PublicKey): PublicKey[] {
  const quoteMint = new PublicKey(market.pair.mint);
  return [
    wallet,
    ata(quoteMint, wallet),
    ata(market.mint, wallet),
    pot,
    ata(quoteMint, pot),
    ata(market.mint, pot),
    ...(market.pair.native ? [] : settings.wallets.map((entry) => ata(quoteMint, new PublicKey(entry.address)))),
  ];
}

export function moduleAccountsFrom(
  market: Pick<Market, 'mint' | 'pair'>,
  settings: ModuleSettings,
  wallet: PublicKey,
  pot: PublicKey,
  infos: ReadonlyArray<AccountInfo<Buffer> | null>,
): ModuleAccounts {
  const quoteMint = new PublicKey(market.pair.mint);
  const at = (index: number): AccountInfo<Buffer> | null => infos[index] ?? null;
  return {
    walletLamports: BigInt(at(0)?.lamports ?? 0),
    walletQuote: tokenAccountState(at(1), quoteMint, wallet),
    walletBase: tokenAccountState(at(2), market.mint, wallet),
    potLamports: BigInt(at(3)?.lamports ?? 0),
    potQuote: tokenAccountState(at(4), quoteMint, pot),
    potBase: tokenAccountState(at(5), market.mint, pot),
    recipients: market.pair.native ? [] : settings.wallets.map((entry, index) => tokenAccountState(at(6 + index), quoteMint, new PublicKey(entry.address))),
  };
}

/* ------------------------------------------------------------------ */
/* Payout                                                              */
/* ------------------------------------------------------------------ */

/**
 * What the wallet has to divide besides the claim. For SOL that is its own
 * lamports plus everything in a wrapped-SOL account left behind, rent
 * included, because closing that account sends all of it to the wallet.
 */
export function heldForPayout(pair: Pick<TradingPair, 'native'>, accounts: ModuleAccounts): bigint {
  if (pair.native) return accounts.walletLamports + (accounts.walletQuote?.lamports ?? 0n);
  return accounts.walletQuote?.amount ?? 0n;
}

/**
 * How many token accounts a payout must open and leave open. The temporary
 * wrapped-SOL account of a SOL claim is not one of them: it is closed in the
 * same transaction and its rent goes straight back to the gas tank.
 */
export function accountsPayoutOpens(pair: Pick<TradingPair, 'native'>, settings: ModuleSettings, accounts: ModuleAccounts, claim: bigint): number {
  let count = 0;
  if (claim > 0n && !accounts.walletBase) count += 1;
  if (pair.native) return count;
  if (claim > 0n && !accounts.walletQuote) count += 1;
  if (settings.burnBps > 0 && !accounts.potQuote) count += 1;
  return count + accounts.recipients.filter((account) => account === null).length;
}

export interface PayoutInput {
  readonly dbc: DynamicBondingCurveClient;
  readonly market: Pick<Market, 'pool' | 'mint' | 'state' | 'pair'>;
  readonly settings: ModuleSettings;
  readonly accounts: ModuleAccounts;
  readonly gasTank: PublicKey;
  readonly wallet: PublicKey;
  readonly pot: PublicKey;
  /** Creator fees to claim, in base units of the pair token. 0 when there are none and only what is held is divided. */
  readonly claim: bigint;
  readonly split: SplitAmounts;
}

/**
 * The instructions of one payout, and the rent the gas tank lays out for it.
 *
 * For SOL the wallet ends the transaction with nothing: what it held, what a
 * left-behind wrapped account held and what the claim brings all leave again,
 * to the sharing wallets and the pot. For any other pair token the same is
 * true of its token account. Sharing wallets' token accounts are never opened
 * here; `setupInstructions` does that first, in a transaction of its own.
 *
 * Pure: it reads nothing from chain.
 */
export async function payoutInstructions(input: PayoutInput): Promise<{ instructions: TransactionInstruction[]; rentOutlay: bigint }> {
  const { dbc, market, settings, accounts, gasTank, wallet, pot, claim, split } = input;
  const { pair } = market;
  const quoteMint = new PublicKey(pair.mint);
  const walletQuote = ata(quoteMint, wallet);
  const instructions: TransactionInstruction[] = [];
  let rentOutlay = 0n;
  let openedWrapped = false;

  if (claim > 0n) {
    if (!accounts.walletBase) {
      instructions.push(createAssociatedTokenAccountIdempotentInstruction(gasTank, ata(market.mint, wallet), wallet, market.mint));
      rentOutlay += RENT;
    }
    if (!accounts.walletQuote) {
      instructions.push(createAssociatedTokenAccountIdempotentInstruction(gasTank, walletQuote, wallet, quoteMint));
      rentOutlay += RENT;
      openedWrapped = pair.native;
    }
    instructions.push(await creatorClaimInstruction(dbc, market, wallet, claim));
  }

  if (pair.native) {
    // Unwrap: closing the wrapped-SOL account sends everything in it to the wallet as plain SOL.
    if (claim > 0n || accounts.walletQuote) instructions.push(createCloseAccountInstruction(walletQuote, wallet, wallet));
    // The gas tank paid that account's rent a moment ago, and the close has just handed it to the wallet.
    if (openedWrapped) instructions.push(SystemProgram.transfer({ fromPubkey: wallet, toPubkey: gasTank, lamports: RENT }));
    settings.wallets.forEach((entry, index) => {
      const amount = split.wallets[index] ?? 0n;
      if (amount > 0n) instructions.push(SystemProgram.transfer({ fromPubkey: wallet, toPubkey: new PublicKey(entry.address), lamports: amount }));
    });
    if (split.burn > 0n) instructions.push(SystemProgram.transfer({ fromPubkey: wallet, toPubkey: pot, lamports: split.burn }));
    return { instructions, rentOutlay };
  }

  const potQuote = ata(quoteMint, pot);
  if (split.burn > 0n && !accounts.potQuote) {
    instructions.push(createAssociatedTokenAccountIdempotentInstruction(gasTank, potQuote, pot, quoteMint));
    rentOutlay += RENT;
  }
  // The checked form names the mint and its decimals, so it cannot move anything but this pair token.
  settings.wallets.forEach((entry, index) => {
    const amount = split.wallets[index] ?? 0n;
    if (amount > 0n) instructions.push(createTransferCheckedInstruction(walletQuote, quoteMint, ata(quoteMint, new PublicKey(entry.address)), wallet, amount, pair.decimals));
  });
  if (split.burn > 0n) instructions.push(createTransferCheckedInstruction(walletQuote, quoteMint, potQuote, wallet, split.burn, pair.decimals));
  return { instructions, rentOutlay };
}

/**
 * Opens the token accounts the sharing wallets are paid into, for a pair
 * token other than SOL, where they do not exist yet. The gas tank pays their
 * rent. Signed by the gas tank alone.
 *
 * `already` holds the wallets this was done for before. They are left out:
 * an account's owner can close it and keep its rent, so the gas tank pays
 * for each wallet's account once and never again. `opened` lists the wallets
 * this call opens an account for.
 */
export function setupInstructions(
  pair: Pick<TradingPair, 'mint'>,
  settings: ModuleSettings,
  accounts: ModuleAccounts,
  gasTank: PublicKey,
  already: ReadonlySet<string> = new Set(),
): { instructions: TransactionInstruction[]; rentOutlay: bigint; opened: string[] } {
  const quoteMint = new PublicKey(pair.mint);
  const instructions: TransactionInstruction[] = [];
  const opened: string[] = [];
  settings.wallets.forEach((entry, index) => {
    if (accounts.recipients[index] !== null || already.has(entry.address)) return;
    const owner = new PublicKey(entry.address);
    instructions.push(createAssociatedTokenAccountIdempotentInstruction(gasTank, ata(quoteMint, owner), owner, quoteMint));
    opened.push(entry.address);
  });
  return { instructions, rentOutlay: RENT * BigInt(instructions.length), opened };
}

/* ------------------------------------------------------------------ */
/* Buyback                                                             */
/* ------------------------------------------------------------------ */

/** What the pot has to spend: its SOL, or its balance of the pair token. */
export function heldForBuyback(pair: Pick<TradingPair, 'native'>, accounts: ModuleAccounts): bigint {
  return pair.native ? accounts.potLamports : (accounts.potQuote?.amount ?? 0n);
}

/**
 * Completes a buy into a buy-and-burn. `swap` is the swap as Meteora's builder
 * returned it, with the gas tank paying the rent of any account it opens.
 *
 *  - For SOL, the swap wraps the pot's SOL in a temporary account and closes
 *    it afterwards, which hands that account's rent to the pot. When the gas
 *    tank paid that rent, the pot passes it straight back.
 *  - Then everything the buy is guaranteed to return is burned, along with
 *    whatever the pot's token account already held. The buy can return a
 *    little more than its guaranteed minimum; that stays in the account and
 *    is burned by the next buyback.
 *
 * One of Meteora's two builders names an account to open only when it is
 * missing; the other always names it, and the instruction does nothing when
 * the account exists. So "the gas tank pays this rent" is decided by both: the
 * swap names the account, and the chain said it was not there.
 */
export function buybackInstructions(input: {
  readonly swap: readonly TransactionInstruction[];
  readonly market: Pick<Market, 'mint' | 'pair'>;
  readonly accounts: ModuleAccounts;
  readonly gasTank: PublicKey;
  readonly pot: PublicKey;
  readonly minimumOut: bigint;
}): { instructions: TransactionInstruction[]; rentOutlay: bigint; burn: bigint } {
  const { swap, market, accounts, gasTank, pot, minimumOut } = input;
  const quoteMint = new PublicKey(market.pair.mint);
  const potQuote = ata(quoteMint, pot);
  const potBase = ata(market.mint, pot);
  const named = (account: PublicKey): boolean =>
    swap.some((instruction) => instruction.programId.equals(ATA_PROGRAM) && instruction.keys[1]?.pubkey.equals(account) === true && instruction.keys[0]?.pubkey.equals(gasTank) === true);
  const instructions = [...swap];
  let rentOutlay = 0n;
  if (accounts.potBase === null && named(potBase)) rentOutlay += RENT;
  if (accounts.potQuote === null && named(potQuote)) {
    rentOutlay += RENT;
    if (market.pair.native) instructions.push(SystemProgram.transfer({ fromPubkey: pot, toPubkey: gasTank, lamports: RENT }));
  }
  const burn = (accounts.potBase?.amount ?? 0n) + minimumOut;
  instructions.push(createBurnCheckedInstruction(potBase, market.mint, pot, burn, TOKEN_DECIMALS));
  return { instructions, rentOutlay, burn };
}

/* ------------------------------------------------------------------ */
/* The service                                                         */
/* ------------------------------------------------------------------ */

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Every module memo found in the `memo` field the RPC returns with a transaction's signature. */
export function memosIn(field: string | null | undefined): string[] {
  if (!field) return [];
  // The field reads `[length] text`, with several memos joined by `; `. A module memo has no spaces in it.
  return field.match(new RegExp(`${MODULE_MEMO_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\|[^\\s;]+`, 'g')) ?? [];
}

export interface ModulesPublic {
  readonly enabled: boolean;
  readonly dryRun: boolean;
  readonly everyMinutes: number;
  readonly gasTank: { readonly address: string; readonly lamports: string | null };
  readonly modules: ReadonlyArray<{
    readonly mint: string;
    readonly symbol: string;
    readonly dev: string;
    readonly wallet: string;
    readonly pot: string | null;
    readonly settings: string;
    readonly paid: string;
    readonly spent: string;
    readonly burned: string;
    readonly lastPassAt: number;
    readonly stalled: boolean;
  }>;
}

export class Modules {
  readonly #env: AppEnv;
  readonly #chain: Chain;
  readonly #store: Store;
  readonly #log: (message: string) => void;
  readonly #priority: PriorityOracle;
  /** Waiting between looks at a sent transaction. A test hands in one that does not wait. */
  readonly #pause: (ms: number) => Promise<void>;
  readonly #seed: Uint8Array;
  readonly #gas: Keypair;
  /** What the list pages show for each module token, kept in memory so a page of tokens costs no lookups. */
  readonly #summaries = new Map<string, { burnBps: number; wallets: number }>();
  #timer: NodeJS.Timeout | undefined;
  #running = false;
  #stopped = false;
  #gasLamports: bigint | null = null;
  #gasReadAt = 0;
  #lastGasComplaint = 0;
  readonly #complaints = new Map<string, number>();

  constructor(env: AppEnv, chain: Chain, store: Store, log: (message: string) => void, priority: PriorityOracle, pause: (ms: number) => Promise<void> = sleep) {
    if (!env.modules.seed || !env.modules.gasTank) throw new EnvError('Fee modules need MODULES_SEED and MODULES_GAS_TANK.');
    this.#env = env;
    this.#chain = chain;
    this.#store = store;
    this.#log = log;
    this.#priority = priority;
    this.#pause = pause;
    this.#seed = moduleSeedBytes(env.modules.seed);
    this.#gas = gasTankOf(this.#seed);
    if (this.#gas.publicKey.toBase58() !== env.modules.gasTank) {
      throw new EnvError(
        'MODULES_SEED is not the seed MODULES_GAS_TANK belongs to. Either the seed was pasted incompletely or it was replaced. Do not run with a different seed: the creator fees of every token that already has modules can only be reached with the original one. Put the original MODULES_SEED back.',
      );
    }
    for (const row of store.modules()) this.#remember(row);
  }

  #remember(row: ModuleRow): void {
    let wallets = 0;
    try {
      wallets = (JSON.parse(row.wallets) as unknown[]).length;
    } catch {
      wallets = 0;
    }
    this.#summaries.set(row.mint, { burnBps: row.burn_bps, wallets });
  }

  get gasTank(): string {
    return this.#gas.publicKey.toBase58();
  }

  info(): ModulesStatus {
    return {
      enabled: true,
      everyMinutes: this.#env.modules.everyMinutes,
      minLamports: this.#env.modules.minLamports.toString(),
      maxBuyLamports: this.#env.modules.maxBuyLamports.toString(),
      maxWallets: MAX_MODULE_WALLETS,
      minShareBps: MIN_SHARE_BPS,
    };
  }

  /** What a list of tokens shows for one of them. Null for a token without modules. */
  summary(mint: string): { burnBps: number; wallets: number } | null {
    return this.#summaries.get(mint) ?? null;
  }

  /** A token's modules as its page shows them. */
  view(mint: string): ModuleView | null {
    return moduleView(this.#store, mint);
  }

  /** Everything about the modules that is public anyway, for the operator's status command. */
  async overview(): Promise<ModulesPublic> {
    const lamports = await this.#gasBalance(30_000).catch(() => null);
    return {
      enabled: true,
      dryRun: this.#env.modules.dryRun,
      everyMinutes: this.#env.modules.everyMinutes,
      gasTank: { address: this.gasTank, lamports: lamports === null ? null : lamports.toString() },
      modules: this.#store.modules().map((row) => ({
        mint: row.mint,
        symbol: this.#store.token(row.mint)?.symbol ?? '',
        dev: row.dev,
        wallet: row.wallet,
        pot: row.burn_bps > 0 ? row.pot : null,
        settings: describeModule({ burnBps: row.burn_bps, wallets: JSON.parse(row.wallets) as Array<{ address: string; bps: number }> }),
        paid: row.paid,
        spent: row.spent,
        burned: row.burned,
        lastPassAt: row.last_pass_at,
        stalled: row.last_error !== '',
      })),
    };
  }

  async #gasBalance(maxAgeMs: number): Promise<bigint> {
    if (this.#gasLamports !== null && Date.now() - this.#gasReadAt < maxAgeMs) return this.#gasLamports;
    this.#gasLamports = BigInt(await this.#chain.connection.getBalance(this.#gas.publicKey, 'confirmed'));
    this.#gasReadAt = Date.now();
    return this.#gasLamports;
  }

  /* ---------------- switching on ---------------- */

  /** What `shared/src/modules.ts` makes of a request, or a refusal a page can show. */
  #checked<T>(check: () => T): T {
    try {
      return check();
    } catch (error) {
      if (error instanceof ModuleError) throw new ModulesError(400, error.code, error.message);
      throw error;
    }
  }

  /**
   * Reads each sharing wallet from chain and refuses what could not be paid: a
   * token account, a program's account, or one of this server's own wallets.
   * A wallet that holds nothing does not exist on chain yet, which is fine.
   */
  async #checkWallets(settings: ModuleShares, own: ReadonlySet<string>): Promise<void> {
    if (settings.wallets.length === 0) return;
    const infos = await this.#chain.connection.getMultipleAccountsInfo(settings.wallets.map((entry) => new PublicKey(entry.address)), 'confirmed');
    settings.wallets.forEach((entry, index) => {
      const info = infos[index] ?? null;
      if (own.has(entry.address)) throw new ModulesError(400, 'BAD_WALLET', `Wallet ${index + 1} is one of this server's own module wallets.`);
      if (info && (!info.owner.equals(SystemProgram.programId) || info.executable)) {
        throw new ModulesError(
          400,
          'BAD_WALLET',
          `Wallet ${index + 1} (${entry.address}) is not an ordinary wallet: it is a token account or belongs to a program. Use the address of the wallet itself.`,
        );
      }
    });
  }

  /** Runs a chain read for a visitor. An RPC that does not answer becomes a sentence they can act on, not a server error. */
  async #read<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ModulesError || error instanceof MarketError) throw error;
      throw new ModulesError(503, 'CHAIN_UNREACHABLE', 'The server could not read the chain just now. Nothing was changed. Try again in a moment.');
    }
  }

  /**
   * Looks over settings for a token that does not exist yet, so that a launch
   * is not started with settings that could never be switched on. It checks
   * the shares and what each wallet is on chain. It keeps nothing and offers
   * no wallet: that is `prepare`, once the token is listed.
   */
  async check(body: { burnBps?: unknown; wallets?: unknown }): Promise<{ ok: true }> {
    const settings = this.#checked(() => checkModuleShares(body ?? {}));
    await this.#read(async () => {
      await this.#chain.assertNetwork();
      await this.#checkWallets(settings, new Set([this.gasTank]));
    });
    return { ok: true };
  }

  /**
   * Checks the settings a creator wants and says where the creator role must
   * go for them to apply. Nothing is switched on here: that happens when the
   * creator's own transaction hands the role over.
   *
   * A module wallet is offered only for a token this server lists, and only
   * to the wallet the chain names as that token's creator right now. Module
   * wallets come from nowhere else, so whenever one holds a creator role, the
   * wallet its settings name as `dev` really was that token's creator.
   */
  async prepare(body: ModuleSettingsInput): Promise<ModulePrepareResponse> {
    const settings = this.#checked(() => checkModuleSettings(body ?? {}));
    if (this.#store.module(settings.mint)) {
      throw new ModulesError(409, 'ALREADY_ON', "This token's fee modules are already on. They are permanent and cannot be changed.");
    }
    if (!this.#store.token(settings.mint)) {
      throw new ModulesError(404, 'NOT_LISTED', 'This token is not listed here yet. A token launched a moment ago takes a few seconds to appear; try again then.');
    }
    const memo = encodeModuleMemo(settings);
    const { wallet, pot } = moduleWallets(this.#seed, memo);
    await this.#read(async () => {
      await this.#chain.assertNetwork();
      const { market } = await this.#chain.market(settings.mint);
      if (market.creator.toBase58() !== settings.dev) {
        throw new ModulesError(403, 'NOT_CREATOR', "Only the wallet that holds this token's creator role can switch its fee modules on.");
      }
      await this.#checkWallets(settings, new Set([this.gasTank, wallet.publicKey.toBase58(), pot.publicKey.toBase58()]));
    });
    this.#store.saveModuleOffer({ wallet: wallet.publicKey.toBase58(), mint: settings.mint, memo }, Date.now());
    return { wallet: wallet.publicKey.toBase58(), memo };
  }

  /**
   * Accepts `memo` as a token's settings if, and only if, the wallet this
   * server derives from it is the one that holds the pool's creator role on
   * chain. That one comparison is the whole test: nobody can make it pass for
   * settings the creator did not hand the role to.
   */
  #accept(mint: string, creator: string, memo: string): ModuleRow | undefined {
    let settings: ModuleSettings;
    try {
      settings = parseModuleMemo(memo);
    } catch {
      return undefined;
    }
    if (settings.mint !== mint) return undefined;
    const { wallet, pot } = moduleWallets(this.#seed, memo);
    if (wallet.publicKey.toBase58() !== creator) return undefined;
    const saved = this.#store.saveModule({
      mint,
      dev: settings.dev,
      wallet: creator,
      pot: pot.publicKey.toBase58(),
      memo,
      burn_bps: settings.burnBps,
      wallets: JSON.stringify(settings.wallets),
      activated_at: Date.now(),
    });
    const row = this.#store.module(mint);
    if (row) {
      this.#remember(row);
      // A token first listed after its modules were switched on carries the module's wallet as creator.
      this.#store.setTokenCreator(mint, row.dev);
    }
    if (saved) this.#log(`modules: ${mint} now runs fee modules: ${describeModule(settings)}. Switched on by ${settings.dev}; the creator role is held by ${creator}.`);
    return row;
  }

  /**
   * True when a listed token's creator, as the listing recorded it, is a wallet
   * this server offered for that token: the role was handed over before the
   * token was first read. Costs one lookup, so a page can ask on every view.
   */
  offered(mint: string, listedCreator: string): boolean {
    return !this.#summaries.has(mint) && this.#store.moduleOffer(listedCreator)?.mint === mint;
  }

  /**
   * Looks at a token and records its modules if its creator role is held by
   * one of this server's module wallets. `memo` may be handed in by anyone: it
   * only counts if the chain agrees with it. Cheap when there is nothing new.
   */
  async adopt(mint: string, memo?: string): Promise<ModuleRow | undefined> {
    const known = this.#store.module(mint);
    if (known) return known;
    const hint = typeof memo === 'string' && memo.length <= 400 ? memo : undefined;
    const attempt = (creator: string): ModuleRow | undefined => {
      const candidates: string[] = [];
      if (hint !== undefined) candidates.push(hint);
      const offer = this.#store.moduleOffer(creator);
      if (offer && offer.mint === mint) candidates.push(offer.memo);
      for (const candidate of candidates) {
        const row = this.#accept(mint, creator, candidate);
        if (row) return row;
      }
      return undefined;
    };
    const { market } = await this.#chain.market(mint);
    const creator = market.creator.toBase58();
    const row = attempt(creator);
    if (row || hint === undefined) return row;
    // A page sends the memo the moment its hand-over confirms, and this server's last read of the
    // pool may be a second older than that. The memo names the wallet that held the role until
    // then: if that is still the creator seen here, the read is from before, so the chain is asked.
    let dev: string;
    try {
      const settings = parseModuleMemo(hint);
      if (settings.mint !== mint) return undefined;
      dev = settings.dev;
    } catch {
      return undefined;
    }
    if (dev !== creator) return undefined;
    const now = (await this.#chain.market(mint, true)).market.creator.toBase58();
    return now === creator ? undefined : attempt(now);
  }

  /** The module memos in an address's recent history, newest first. */
  async #memosOf(address: string): Promise<string[]> {
    const found: string[] = [];
    let before: string | undefined;
    for (let page = 0; page < SEARCH_PAGES; page += 1) {
      const batch = await this.#chain.connection.getSignaturesForAddress(new PublicKey(address), before ? { limit: 1000, before } : { limit: 1000 }, 'confirmed');
      for (const entry of batch) if (!entry.err) found.push(...memosIn(entry.memo));
      const last = batch[batch.length - 1];
      if (batch.length < 1000 || !last) break;
      before = last.signature;
    }
    return found;
  }

  /**
   * For a token with no modules on record: is its creator one of this
   * server's module wallets after all? First the offers this server made, then
   * the chain itself, which is how modules are found again after the database
   * was lost. A creator that was searched once is not searched again.
   */
  async #discover(mint: string, creator: string, memoCache: Map<string, string[]>): Promise<void> {
    const offer = this.#store.moduleOffer(creator);
    if (offer && offer.mint === mint && this.#accept(mint, creator, offer.memo)) return;
    if (this.#store.moduleExamined(mint)?.creator === creator) return;
    let memos = memoCache.get(creator);
    if (!memos) {
      memos = await this.#memosOf(creator);
      memoCache.set(creator, memos);
    }
    for (const memo of memos) if (this.#accept(mint, creator, memo)) return;
    this.#store.markModuleExamined(mint, creator, Date.now());
  }

  /* ---------------- the keeper ---------------- */

  start(): void {
    const mode = this.#env.modules.dryRun ? 'DRY RUN: everything is worked out and checked against the chain, nothing is sent' : 'live';
    this.#log(
      `modules: on (${mode}). A pass every ${this.#env.modules.everyMinutes} minutes. Gas tank ${this.gasTank}: keep it funded with SOL, it pays the network fees and the rent of token accounts.`,
    );
    const schedule = (delayMs: number): void => {
      if (this.#stopped) return;
      this.#timer = setTimeout(() => {
        void this.pass().finally(() => schedule(this.#env.modules.everyMinutes * 60_000));
      }, delayMs);
      this.#timer.unref();
    };
    // The first pass waits for the listing and the pair tokens to be read.
    schedule(45_000);
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
  }

  #complain(key: string, message: string): void {
    const now = Date.now();
    if (now - (this.#complaints.get(key) ?? 0) < 3_600_000) return;
    this.#complaints.set(key, now);
    this.#log(message);
  }

  /** One pass over every listed token. Never runs twice at once; never throws. */
  async pass(): Promise<void> {
    if (this.#running || this.#stopped) return;
    this.#running = true;
    try {
      await this.#chain.assertNetwork();
      const rows = this.#store.allTokens();
      // Which tokens have handed their creator role to one of this server's wallets.
      const unknown = rows.filter((row) => !this.#store.module(row.mint));
      if (unknown.length > 0) {
        const states = await loadPoolStates(this.#chain.dbc, this.#chain.connection, unknown.map((row) => new PublicKey(row.pool)));
        const memoCache = new Map<string, string[]>();
        for (const [index, row] of unknown.entries()) {
          const state = states[index];
          if (!state) continue;
          await this.#discover(row.mint, state.poolState.creator.toBase58(), memoCache).catch((error: unknown) =>
            this.#complain(`discover:${row.mint}`, `modules: ${row.mint}: could not look for its modules (${error instanceof Error ? error.message : String(error)})`),
          );
        }
      }
      const modules = this.#store.modules();
      if (modules.length === 0) return;
      const gas = await this.#gasBalance(0);
      if (gas < GAS_FLOOR_LAMPORTS + FEE_ALLOWANCE_LAMPORTS) {
        if (Date.now() - this.#lastGasComplaint >= 3_600_000) {
          this.#lastGasComplaint = Date.now();
          this.#log(`modules: the gas tank ${this.gasTank} holds ${formatUnits(gas, 9)} SOL, which is too little to send anything. Send it SOL; nothing is lost meanwhile, fees keep accruing where they are.`);
        }
        return;
      }
      for (const row of modules) {
        if (this.#stopped) break;
        // Only tokens that are listed right now: a token under a config this server no longer has is left alone.
        if (!this.#store.token(row.mint)) continue;
        try {
          await this.#run(row);
          this.#store.noteModulePass(row.mint, Date.now(), '');
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.#store.noteModulePass(row.mint, Date.now(), message);
          this.#complain(`run:${row.mint}`, `modules: ${row.mint}: this pass did not finish and will be tried again. ${message}`);
        }
      }
    } catch (error) {
      this.#complain('pass', `modules: a pass could not start (${error instanceof Error ? error.message : String(error)}). It runs again in ${this.#env.modules.everyMinutes} minutes.`);
    } finally {
      this.#running = false;
    }
  }

  async #run(row: ModuleRow): Promise<void> {
    let { market, graduated } = await this.#chain.market(row.mint);
    const settings = parseModuleMemo(row.memo);
    const keys = moduleWallets(this.#seed, row.memo);
    if (keys.wallet.publicKey.toBase58() !== row.wallet) throw new Error("this server's seed does not give this token's module wallet");
    if (market.creator.toBase58() !== row.wallet) throw new Error("the pool's creator role is not held by this token's module wallet");
    const { pair } = market;
    const rate = this.#chain.rate(pair.id);
    if (!pair.native && !(rate > 0)) throw new Error(`the ${pair.symbol} pair has no rate on this server, so its amounts cannot be sized`);
    const inPair = (lamports: bigint): bigint => fromSolLamports(lamports, pair, rate);
    const { connection, dbc } = this.#chain;
    const wallet = keys.wallet.publicKey;
    const pot = keys.pot.publicKey;
    const read = async (): Promise<ModuleAccounts> =>
      moduleAccountsFrom(market, settings, wallet, pot, await connection.getMultipleAccountsInfo(moduleAccountAddresses(market, settings, wallet, pot), 'confirmed'));
    let accounts = await read();
    const label = this.#store.token(row.mint)?.symbol || row.mint;
    const show = (units: bigint): string => `${formatUnits(units, pair.decimals)} ${pair.symbol}`;

    // The two steps are independent: a payout that cannot go ahead does not hold back a buyback from
    // a pot that was filled earlier. Whatever stopped either is reported once both have had their turn.
    const problems: string[] = [];
    const step = async (work: () => Promise<void>): Promise<void> => {
      try {
        await work();
      } catch (error) {
        problems.push(error instanceof Error ? error.message : String(error));
      }
    };

    /* 1. Payout */
    await step(async () => {
      const claimable = BigInt(market.state.poolState.creatorQuoteFee.toString());
      const plan = planSweep(
        {
          native: pair.native,
          claimable,
          held: heldForPayout(pair, accounts),
          minimum: inPair(this.#env.modules.minLamports),
          rentToOpen: inPair(RENT * BigInt(accountsPayoutOpens(pair, settings, accounts, claimable))),
        },
        settings,
      );
      if (plan.action !== 'pay') return;
      const missing = accounts.recipients.filter((account) => account === null).length;
      if (missing > 0) {
        // The wallets' token accounts first, in a transaction of their own. The payout follows on the next pass.
        // Each wallet's account is opened once. Its owner can close it and keep the rent the gas tank paid,
        // so opening it again whenever it is missing would hand that rent out on every pass.
        const setup = setupInstructions(pair, settings, accounts, this.#gas.publicKey, this.#store.moduleOpened(row.mint));
        if (setup.opened.length === 0) {
          throw new Error(
            `${WAITING_ON_ACCOUNTS}${missing} sharing wallet${missing === 1 ? ' has' : 's have'} no ${pair.symbol} account. This server opened one for each wallet once, and it does not do that a second time. The payout goes ahead once every sharing wallet holds a ${pair.symbol} account.`,
          );
        }
        const count = setup.opened.length;
        const signature = await this.#send(`${label}: opening ${count} token account${count === 1 ? '' : 's'}`, setup.instructions, [], setup.rentOutlay);
        if (signature) {
          this.#record(row.mint, 'setup', signature, 0n, 0n);
          this.#store.markModuleOpened(row.mint, setup.opened, Date.now());
        }
        return;
      }
      const built = await payoutInstructions({ dbc, market, settings, accounts, gasTank: this.#gas.publicKey, wallet, pot, claim: plan.claim, split: plan.split });
      const paid = plan.split.wallets.reduce((sum, amount) => sum + amount, 0n);
      const signature = await this.#send(
        `${label}: paying out ${show(plan.total)} (${show(paid)} to ${settings.wallets.length} wallet${settings.wallets.length === 1 ? '' : 's'}, ${show(plan.split.burn)} to the buyback pot)`,
        built.instructions,
        [keys.wallet],
        built.rentOutlay,
      );
      if (!signature) return;
      this.#record(row.mint, 'payout', signature, plan.total, 0n, { paid });
      // Read again: the pot has just been paid, and the buyback below spends what it really holds,
      // at the price the pool has now rather than the one it had before the payout confirmed.
      accounts = await read();
      ({ market, graduated } = await this.#chain.market(row.mint, true));
    });

    /* 2. Buyback and burn */
    await step(async () => {
      if (settings.burnBps === 0 || this.#env.pauseTrading || market.stage === 'migrating') return;
      const buy = planBuyback({
        native: pair.native,
        held: heldForBuyback(pair, accounts),
        minimum: inPair(MIN_BUY_LAMPORTS),
        maximum: inPair(this.#env.modules.maxBuyLamports),
        rentToOpen: inPair(accounts.potBase ? 0n : RENT),
      });
      if (buy.action !== 'buy') return;
      const quoted = await this.#quote(market, graduated, buy.spend, inPair(MIN_BUY_LAMPORTS));
      if (!quoted) return;
      const swap =
        market.stage === 'curve'
          ? await curveSwapInstructions(dbc, market, pot, quoted, this.#gas.publicKey)
          : await graduatedSwapInstructions(connection, market, graduated as GraduatedPool, pot, quoted, this.#gas.publicKey);
      const built = buybackInstructions({ swap, market, accounts, gasTank: this.#gas.publicKey, pot, minimumOut: quoted.minimumAmountOut });
      const signature = await this.#send(
        `${label}: buying back with ${show(quoted.amountIn)} and burning ${formatUnits(built.burn, TOKEN_DECIMALS)} tokens`,
        built.instructions,
        [keys.pot],
        built.rentOutlay,
      );
      if (signature) this.#record(row.mint, 'buyback', signature, quoted.amountIn, built.burn, { spent: quoted.amountIn, burned: built.burn });
    });

    if (problems.length > 0) throw new Error(problems.join(' '));
  }

  /**
   * A buy of `spend` of the pair token, or the largest smaller one the curve
   * can still fill: near graduation a curve has little left to sell, and a buy
   * for more than that cannot be filled as asked. Null when not even the
   * smallest buy fits; the pot then waits for the token to graduate.
   */
  async #quote(market: Market, graduated: GraduatedPool | undefined, spend: bigint, smallest: bigint): Promise<TradeQuote | null> {
    const request = (amount: bigint) => ({ side: 'buy' as const, mode: 'exact-in' as const, amount, slippageBps: this.#env.modules.slippageBps });
    if (market.stage === 'graduated') {
      if (!graduated) throw new Error('the graduated pool could not be read');
      return quoteGraduated(this.#chain.connection, market, graduated, request(spend));
    }
    let amount = spend;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        return await quoteCurve(this.#chain.dbc, this.#chain.connection, market, request(amount));
      } catch (error) {
        if (!(error instanceof MarketError)) throw error;
        if (error.code === 'DUST' || error.code === 'CURVE_CLOSED' || error.code === 'NOT_ACTIVE') return null;
        if (error.code !== 'TOO_LARGE') throw error;
        amount /= 2n;
        if (amount < smallest) return null;
      }
    }
    return null;
  }

  #record(mint: string, kind: ModuleEventKind, signature: string, quote: bigint, tokens: bigint, totals: { paid?: bigint; spent?: bigint; burned?: bigint } = {}): void {
    this.#store.addModuleEvent({ mint, kind, signature, quote: quote.toString(), tokens: tokens.toString(), at: Date.now() }, totals);
  }

  /**
   * Runs a transaction against the chain, and sends it only if that run
   * succeeded. The gas tank pays the fee. Returns the signature once the
   * transaction has confirmed, or null in a dry run, where nothing is sent.
   * `rentOutlay` is the rent the gas tank lays out, so that a pass which
   * would drain it waits instead.
   */
  async #send(label: string, instructions: readonly TransactionInstruction[], signers: readonly Keypair[], rentOutlay: bigint): Promise<string | null> {
    if (instructions.length === 0) throw new Error(`${label}: nothing to send`);
    const { connection } = this.#chain;
    const gas = await this.#gasBalance(0);
    if (gas < rentOutlay + FEE_ALLOWANCE_LAMPORTS + GAS_FLOOR_LAMPORTS) {
      throw new Error(`the gas tank ${this.gasTank} holds ${formatUnits(gas, 9)} SOL, too little for this. Send it SOL.`);
    }
    const latest = await connection.getLatestBlockhash('confirmed');
    const price = this.#priority.current();
    const others = signers.filter((signer) => !signer.publicKey.equals(this.#gas.publicKey));
    const build = (units: number): Transaction => {
      const transaction = new Transaction({ feePayer: this.#gas.publicKey, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight });
      transaction.add(ComputeBudgetProgram.setComputeUnitLimit({ units }));
      if (price > 0) transaction.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }));
      transaction.add(...instructions);
      transaction.sign(this.#gas, ...others);
      return transaction;
    };
    const simulation = await connection.simulateTransaction(build(TRIAL_UNITS));
    if (simulation.value.err) {
      const logs = (simulation.value.logs ?? []).slice(-6).join(' | ');
      throw new Error(`${label}: it would fail, so it was not sent: ${JSON.stringify(simulation.value.err)} ${logs}`);
    }
    if (this.#env.modules.dryRun) {
      this.#log(`modules: DRY RUN, not sent: ${label}. It passed its run against the chain.`);
      return null;
    }
    const used = simulation.value.unitsConsumed ?? TRIAL_UNITS;
    const transaction = build(Math.min(1_400_000, Math.ceil(used * 1.25) + 20_000));
    const raw = transaction.serialize();
    const signature = bs58.encode(transaction.signature as Buffer);
    // A send can fail without saying whether the transaction went out, and mainnet drops transactions
    // that are sent once. So the same signed bytes are sent again, harmlessly, until the chain answers.
    let refusal = '';
    const push = async (): Promise<void> => {
      try {
        await connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 });
        refusal = '';
      } catch (error) {
        refusal = error instanceof Error ? error.message : String(error);
      }
    };
    const settled = async (searchHistory: boolean): Promise<boolean> => {
      const status = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: searchHistory })).value[0];
      // Only what a majority of the network has voted on counts, for a failure as much as for a success.
      const voted = status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized';
      if (voted && status?.err) throw new FailedOnChain(`${label}: transaction ${signature} failed on chain: ${JSON.stringify(status.err)}`);
      return voted;
    };
    await push();
    const deadline = Date.now() + CONFIRM_DEADLINE_MS;
    for (;;) {
      await this.#pause(CONFIRM_EVERY_MS);
      let expired = false;
      try {
        if (await settled(false)) break;
        expired = (await connection.getBlockHeight('confirmed')) > latest.lastValidBlockHeight;
      } catch (error) {
        if (error instanceof FailedOnChain) throw error;
        // The RPC did not answer. That says nothing about the transaction: ask again.
      }
      if (expired || Date.now() > deadline) {
        // Look once more, properly, before saying it did not land.
        await this.#pause(4_000);
        let landed: boolean;
        try {
          landed = await settled(true);
        } catch (error) {
          if (error instanceof FailedOnChain) throw error;
          throw new Error(`${label}: the RPC did not answer, so it is not known whether transaction ${signature} confirmed. The next pass reads the chain and carries on from what it finds.`);
        }
        if (landed) break;
        const why = refusal ? ` The RPC refused it: ${refusal.slice(0, 200)}.` : '';
        throw new Error(
          expired
            ? `${label}: transaction ${signature} expired before it confirmed.${why} Nothing moved; the next pass reads the chain again.`
            : `${label}: transaction ${signature} was not seen to confirm in three minutes.${why} The next pass reads the chain and carries on from what it finds.`,
        );
      }
      await push();
    }
    this.#gasLamports = null;
    this.#log(`modules: ${label}. ${signature}`);
    return signature;
  }
}

/**
 * A token's modules as its page shows them, read from the database alone. A
 * token keeps its modules on chain whether or not this server is running them
 * right now, so its page says so either way.
 */
export function moduleView(store: Store, mint: string): ModuleView | null {
  const row = store.module(mint);
  if (!row) return null;
  const events: ModuleEventView[] = store.moduleEvents(mint, 20).map((event) => ({
    kind: event.kind,
    signature: event.signature,
    at: event.at,
    quote: event.quote,
    tokens: event.tokens,
  }));
  return {
    dev: row.dev,
    wallet: row.wallet,
    pot: row.burn_bps > 0 ? row.pot : null,
    burnBps: row.burn_bps,
    wallets: JSON.parse(row.wallets) as Array<{ address: string; bps: number }>,
    memo: row.memo,
    since: row.activated_at,
    totals: { paid: row.paid, spent: row.spent, burned: row.burned },
    events,
    lastPassAt: row.last_pass_at,
    stalled: row.last_error !== '',
    needsAccounts: row.last_error.startsWith(WAITING_ON_ACCOUNTS),
  };
}

/** What a list of tokens shows for one that has modules, read from the database alone. Null for a token without. */
export function moduleSummary(store: Store, mint: string): { burnBps: number; wallets: number } | null {
  const row = store.module(mint);
  if (!row) return null;
  let wallets = 0;
  try {
    wallets = (JSON.parse(row.wallets) as unknown[]).length;
  } catch {
    wallets = 0;
  }
  return { burnBps: row.burn_bps, wallets };
}

/** What `/api/status` says about modules on a server that does not run them. */
export function modulesOff(env: AppEnv): ModulesStatus {
  return {
    enabled: false,
    everyMinutes: env.modules.everyMinutes,
    minLamports: env.modules.minLamports.toString(),
    maxBuyLamports: env.modules.maxBuyLamports.toString(),
    maxWallets: MAX_MODULE_WALLETS,
    minShareBps: MIN_SHARE_BPS,
  };
}
