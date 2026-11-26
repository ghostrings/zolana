/**
 * Fee modules: what a token's creator can have done with their share of the
 * trading fees, without doing it by hand.
 *
 *   - FEE SHARING   up to four wallets, each paid a fixed percentage.
 *   - BUYBACK+BURN  whatever is not shared buys the token on the open market
 *                   and destroys what it bought.
 *
 * Only the creator's share is ever touched. The platform's share and
 * Meteora's are untouched, and so is every trader's money.
 *
 * HOW IT IS SWITCHED ON
 *   Meteora pays curve fees to whoever holds a pool's creator role, and only
 *   that address can claim them. A creator turns modules on by handing that
 *   role to a wallet the platform's server runs for that one token, in a
 *   transaction the creator signs. The settings travel with it as a memo, so
 *   they are on chain, signed by the creator, for anyone to read.
 *
 * WHY THE SETTINGS CANNOT BE SWAPPED
 *   The address of that wallet is worked out from the settings themselves. A
 *   pool whose creator is the wallet for "burn 50%, pay A 50%" can only ever be
 *   run with those settings: for any others the server arrives at a different
 *   address, which does not hold the role. So the chain's own record of who
 *   the creator is settles which settings apply. Nothing here can be edited
 *   afterwards; a module is permanent.
 *
 * This file is the part with no keys and no network in it: the settings, their
 * text form, and the arithmetic. Both the pages and the server use it.
 */

import { PublicKey, TransactionInstruction } from '@solana/web3.js';

/** SPL Memo, version 2. It checks that every account it is given signed the transaction. */
export const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

/** Every module memo starts with this. The number is the version of the text form. */
export const MODULE_MEMO_PREFIX = 'pcf:modules:1';

/** Shares are written in hundredths of a percent: 10000 is all of it. */
export const SHARE_TOTAL_BPS = 10_000;
/** The smallest share anything may be given: 1%. */
export const MIN_SHARE_BPS = 100;
/** How many wallets one token's fees can be shared between. */
export const MAX_MODULE_WALLETS = 4;

/**
 * The smallest SOL payment a pass makes to one wallet, in lamports. A wallet
 * that holds nothing must be left with at least 890,880 lamports or the
 * network refuses the transfer, so anything smaller waits and adds up.
 */
export const MIN_SOL_PAYMENT_LAMPORTS = 1_000_000n;

/**
 * Token accounts are opened for a module only once the fees waiting are worth
 * this many times the rent those accounts cost. It keeps a token nobody trades
 * from spending the platform's SOL.
 */
export const RENT_GUARD_MULTIPLE = 4n;

export class ModuleError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ModuleError';
    this.code = code;
  }
}

export interface ModuleShare {
  /** A wallet address. It is paid in the token's pair token: SOL to the wallet, anything else into its token account. */
  readonly address: string;
  readonly bps: number;
}

/** One token's fee modules. `burnBps` and the wallets' shares add up to exactly 10000. */
export interface ModuleSettings {
  readonly mint: string;
  /** The wallet that switched the modules on: the token's creator at that moment. */
  readonly dev: string;
  /** The share that buys the token back and burns it. 0 for none. */
  readonly burnBps: number;
  readonly wallets: readonly ModuleShare[];
}

/** What a page or a script hands in before anything has been checked. */
export interface ModuleSettingsInput {
  readonly mint?: unknown;
  readonly dev?: unknown;
  readonly burnBps?: unknown;
  readonly wallets?: unknown;
}

function canonicalAddress(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length < 32 || value.length > 44) throw new ModuleError('BAD_ADDRESS', `${what} is not a Solana address.`);
  let key: PublicKey;
  try {
    key = new PublicKey(value);
  } catch {
    throw new ModuleError('BAD_ADDRESS', `${what} is not a Solana address.`);
  }
  if (key.toBase58() !== value || key.equals(PublicKey.default)) throw new ModuleError('BAD_ADDRESS', `${what} is not a Solana address.`);
  return value;
}

function shareBps(value: unknown, what: string, allowZero: boolean): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new ModuleError('BAD_SHARE', `${what} must be a whole number of hundredths of a percent.`);
  if (value === 0 && allowZero) return 0;
  if (value < MIN_SHARE_BPS || value > SHARE_TOTAL_BPS) {
    throw new ModuleError('BAD_SHARE', `${what} must be between ${MIN_SHARE_BPS / 100}% and 100%.`);
  }
  return value;
}

/** A share as people read it: `12.5%`. */
export function percentText(bps: number): string {
  return `${Number((bps / 100).toFixed(2))}%`;
}

/** The part of the settings a creator chooses: what is burned, and who is paid what. */
export type ModuleShares = Pick<ModuleSettings, 'burnBps' | 'wallets'>;

/**
 * Checks the shares on their own, before the token they are for is known:
 * every wallet is an address listed once, every share is at least 1%, and
 * together they are exactly 100%. Throws a `ModuleError` whose message can be
 * shown as it is.
 */
export function checkModuleShares(input: Pick<ModuleSettingsInput, 'burnBps' | 'wallets'>): ModuleShares {
  const burnBps = shareBps(input.burnBps ?? 0, 'The buyback share', true);
  if (!Array.isArray(input.wallets)) throw new ModuleError('BAD_WALLETS', 'The list of wallets is missing.');
  if (input.wallets.length > MAX_MODULE_WALLETS) throw new ModuleError('TOO_MANY_WALLETS', `Fees can be shared between at most ${MAX_MODULE_WALLETS} wallets.`);
  const wallets: ModuleShare[] = [];
  const seen = new Set<string>();
  input.wallets.forEach((entry: unknown, index: number) => {
    const row = (entry ?? {}) as { address?: unknown; bps?: unknown };
    const address = canonicalAddress(row.address, `Wallet ${index + 1}`);
    if (seen.has(address)) throw new ModuleError('DUPLICATE_WALLET', `Wallet ${index + 1} is listed twice. Give it one share.`);
    seen.add(address);
    wallets.push(Object.freeze({ address, bps: shareBps(row.bps, `The share of wallet ${index + 1}`, false) }));
  });
  const total = burnBps + wallets.reduce((sum, wallet) => sum + wallet.bps, 0);
  if (total !== SHARE_TOTAL_BPS) {
    throw new ModuleError('BAD_TOTAL', `The shares add up to ${percentText(total)}. They must add up to exactly 100%.`);
  }
  return Object.freeze({ burnBps, wallets: Object.freeze(wallets) });
}

/**
 * Checks a whole set of module settings and returns them in their one
 * canonical form. Throws a `ModuleError` whose message can be shown as it is.
 *
 * These rules are part of version 1 of the memo. Settings that were valid
 * once must stay readable for as long as their token exists, so the rules may
 * be loosened in a later version and never tightened.
 */
export function checkModuleSettings(input: ModuleSettingsInput): ModuleSettings {
  const mint = canonicalAddress(input.mint, 'The token');
  const dev = canonicalAddress(input.dev, "The creator's wallet");
  const shares = checkModuleShares(input);
  const own = shares.wallets.findIndex((wallet) => wallet.address === mint);
  if (own !== -1) throw new ModuleError('BAD_WALLET', `Wallet ${own + 1} is the token's own address, not a wallet.`);
  return Object.freeze({ mint, dev, burnBps: shares.burnBps, wallets: shares.wallets });
}

/**
 * The settings as one line of text: what goes into the memo, and what the
 * module wallet's address is worked out from. One set of settings has exactly
 * one text form.
 *
 *   pcf:modules:1|mint=<mint>|dev=<wallet>|burn=5000|<wallet>=3000|<wallet>=2000
 */
export function encodeModuleMemo(settings: ModuleSettings): string {
  const checked = checkModuleSettings(settings);
  return [MODULE_MEMO_PREFIX, `mint=${checked.mint}`, `dev=${checked.dev}`, `burn=${checked.burnBps}`, ...checked.wallets.map((wallet) => `${wallet.address}=${wallet.bps}`)].join('|');
}

/**
 * Reads a memo back into settings. Strict: text that is not exactly what
 * `encodeModuleMemo` writes for some valid settings is refused, so two
 * different texts can never mean the same thing.
 */
export function parseModuleMemo(text: string): ModuleSettings {
  const bad = (): never => {
    throw new ModuleError('BAD_MEMO', 'That is not a fee module memo.');
  };
  if (typeof text !== 'string' || text.length > 400) return bad();
  const parts = text.split('|');
  if (parts.length < 4 || parts[0] !== MODULE_MEMO_PREFIX) return bad();
  const field = (part: string | undefined, name: string): string => {
    if (!part?.startsWith(`${name}=`)) return bad();
    return part.slice(name.length + 1);
  };
  const number = (value: string): number => (/^(0|[1-9][0-9]{0,4})$/.test(value) ? Number(value) : bad());
  const wallets = parts.slice(4).map((part) => {
    const at = part.indexOf('=');
    if (at <= 0) return bad();
    return { address: part.slice(0, at), bps: number(part.slice(at + 1)) };
  });
  const settings = checkModuleSettings({
    mint: field(parts[1], 'mint'),
    dev: field(parts[2], 'dev'),
    burnBps: number(field(parts[3], 'burn')),
    wallets,
  });
  if (encodeModuleMemo(settings) !== text) return bad();
  return settings;
}

/**
 * The memo instruction that carries the settings. The creator is passed as a
 * signer, so the memo program itself checks that the creator signed.
 */
export function moduleMemoInstruction(memo: string, signer: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(MEMO_PROGRAM_ID),
    keys: [{ pubkey: signer, isSigner: true, isWritable: false }],
    data: Buffer.from(memo, 'utf8'),
  });
}

/* ------------------------------------------------------------------ */
/* Arithmetic                                                          */
/* ------------------------------------------------------------------ */

/** How one amount is divided. `wallets` lines up with the settings' wallets. The parts add up to the amount exactly. */
export interface SplitAmounts {
  readonly wallets: readonly bigint[];
  readonly burn: bigint;
}

/**
 * Divides `total` by the settings. Every wallet gets its percentage rounded
 * down. What rounding leaves over (a few base units at most) goes to the
 * buyback when there is one, and to the first wallet when there is not, so
 * nothing is ever left behind.
 */
export function splitAmounts(total: bigint, settings: Pick<ModuleSettings, 'burnBps' | 'wallets'>): SplitAmounts {
  if (total < 0n) throw new ModuleError('BAD_AMOUNT', 'An amount to divide cannot be negative.');
  const wallets = settings.wallets.map((wallet) => (total * BigInt(wallet.bps)) / BigInt(SHARE_TOTAL_BPS));
  const paid = wallets.reduce((sum, amount) => sum + amount, 0n);
  const rest = total - paid;
  if (settings.burnBps > 0) return { wallets, burn: rest };
  if (wallets.length === 0) throw new ModuleError('BAD_SETTINGS', 'These settings give the fees to nobody.');
  wallets[0] = (wallets[0] as bigint) + rest;
  return { wallets, burn: 0n };
}

/** What the server reads about a token before it decides whether to pay out. Amounts are base units of the pair token. */
export interface SweepState {
  /** True for a token priced in SOL: payments are lamports sent to wallets, and each must leave its wallet rent-exempt. */
  readonly native: boolean;
  /** The creator's curve fees that have not been claimed yet. */
  readonly claimable: bigint;
  /** What the module's wallet already holds, for instance a payout of pool fees after graduation. */
  readonly held: bigint;
  /** The least worth acting on. */
  readonly minimum: bigint;
  /** Rent of the accounts this pass would have to open and leave open, as base units of the pair token at the pair's rate. */
  readonly rentToOpen: bigint;
}

export type SweepPlan =
  | { readonly action: 'wait'; readonly total: bigint; readonly reason: string }
  | { readonly action: 'pay'; readonly total: bigint; readonly claim: bigint; readonly split: SplitAmounts };

/**
 * Decides whether a pass pays out, and how much to whom. It pays everything or
 * nothing: when it pays, the module's wallet is left empty.
 */
export function planSweep(state: SweepState, settings: Pick<ModuleSettings, 'burnBps' | 'wallets'>): SweepPlan {
  const total = state.claimable + state.held;
  if (total <= 0n) return { action: 'wait', total, reason: 'nothing has been earned yet' };
  const floor = state.rentToOpen * RENT_GUARD_MULTIPLE > state.minimum ? state.rentToOpen * RENT_GUARD_MULTIPLE : state.minimum;
  if (total < floor) return { action: 'wait', total, reason: 'the fees waiting are below the smallest amount a pass acts on' };
  const split = splitAmounts(total, settings);
  const smallest = state.native ? MIN_SOL_PAYMENT_LAMPORTS : 1n;
  const parts = [...split.wallets, ...(settings.burnBps > 0 ? [split.burn] : [])];
  if (parts.some((amount) => amount < smallest)) {
    return { action: 'wait', total, reason: 'the smallest share is not yet large enough to be sent' };
  }
  return { action: 'pay', total, claim: state.claimable, split };
}

/** What the server reads about a buyback pot. Amounts are base units of the pair token. */
export interface BuybackState {
  readonly native: boolean;
  /** What the pot holds. */
  readonly held: bigint;
  /** The least worth spending on one buy. */
  readonly minimum: bigint;
  /** The most one pass spends. */
  readonly maximum: bigint;
  /** Rent of the accounts the buy would have to open and leave open, at the pair's rate. */
  readonly rentToOpen: bigint;
}

export type BuybackPlan = { readonly action: 'wait'; readonly reason: string } | { readonly action: 'buy'; readonly spend: bigint };

/**
 * Decides how much a pot spends this pass. For SOL the pot is left either
 * empty or with enough to stay rent-exempt, never in between.
 */
export function planBuyback(state: BuybackState): BuybackPlan {
  if (state.held <= 0n) return { action: 'wait', reason: 'the pot is empty' };
  if (state.maximum <= 0n) return { action: 'wait', reason: 'buybacks are capped at zero' };
  const floor = state.rentToOpen * RENT_GUARD_MULTIPLE > state.minimum ? state.rentToOpen * RENT_GUARD_MULTIPLE : state.minimum;
  if (state.held < floor) return { action: 'wait', reason: 'the pot is below the smallest buy' };
  if (state.held <= state.maximum) return { action: 'buy', spend: state.held };
  // A little over the cap is better than leaving a remainder too small to exist as an account.
  if (state.native && state.held - state.maximum < MIN_SOL_PAYMENT_LAMPORTS) return { action: 'buy', spend: state.held };
  return { action: 'buy', spend: state.maximum };
}

/** One line a person can read: `50% buyback and burn · 30% to 7xKX…9fQa · 20% to 3mNp…Zz1k`. */
export function describeModule(settings: Pick<ModuleSettings, 'burnBps' | 'wallets'>, short: (address: string) => string = (address) => address): string {
  const parts: string[] = [];
  if (settings.burnBps > 0) parts.push(`${percentText(settings.burnBps)} buyback and burn`);
  for (const wallet of settings.wallets) parts.push(`${percentText(wallet.bps)} to ${short(wallet.address)}`);
  return parts.join(' · ');
}
