/**
 * prvmax: up to ten vaults behind one wallet.
 *
 * A vault is an ordinary Solana keypair with its own private balance in
 * Rings. Its key is derived from the wallet it belongs to, so there is
 * nothing new to back up, and everything a single wallet can do on this site
 * a vault can do too: it is handed to the same flows as a wallet of its own.
 *
 * What prvmax hides and what it does not is the protocol's doing, not this
 * file's:
 *
 *   spread   wallet -> vault, private transfer   both addresses public; token and amount encrypted
 *   trade    vault <-> pool                      the vault, the token and the size are public
 *   recall   vault -> wallet, private transfer   both addresses public; token and amount encrypted
 *
 * So a vault is not a disguise. Anyone can see which vaults a wallet funded.
 * What stays private is how much each one holds, and of what.
 *
 * Everything here is pure: no storage, no network. The derivation labels and
 * the message text below define the keys. Changing either one makes every
 * existing vault unreachable, so they are pinned by tests and never edited.
 */

import type { Address, Instruction, Transaction } from '@solana/kit';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';

import { GAS_RESERVE_LAMPORTS } from './constants.js';
import { type RingsContext, latestLifetime, priorityOf } from './privacy.js';
import { composeV1, fromLegacyInstruction } from './tx.js';

export const MAX_VAULTS = 10;

/** What a vault is given for network fees, temporary account rent and its one-time registration. */
export const VAULT_GAS_DEFAULT_LAMPORTS = 30_000_000n;
/** The least a vault can be set up with: the reserve every flow asks for, and room for registering and a few trades. */
export const VAULT_GAS_MIN_LAMPORTS = 20_000_000n;
export const VAULT_GAS_MAX_LAMPORTS = 200_000_000n;

/** What Solana charges per signature, in lamports. */
export const SIGNATURE_FEE_LAMPORTS = 5_000n;
/** The least an account with no data may hold. Sending less than this to an address that holds nothing is refused. */
export const SYSTEM_RENT_EXEMPT_LAMPORTS = 890_880n;

export const VAULT_COMPUTE_UNITS = Object.freeze({
  /** Up to ten plain SOL transfers. */
  gas: 20_000,
  /** One plain SOL transfer. */
  sweep: 5_000,
  /** Closing up to twelve empty token accounts. */
  close: 60_000,
  /** Opening the destination's token account when it is missing, one token transfer, one close. */
  move: 80_000,
});
/** How many empty token accounts one transaction closes. */
export const CLOSE_BATCH = 12;

export class VaultError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'VaultError';
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/* Keys                                                                */
/* ------------------------------------------------------------------ */

const ROOT_LABEL = 'privacycash.fun/prvmax/v1/root';
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

async function hmacSha256(key: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  // Copies, so that what is handed to the browser's crypto is backed by a plain buffer of its own.
  const imported = await crypto.subtle.importKey('raw', new Uint8Array(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', imported, new Uint8Array(message)));
}

/**
 * The root of a ghost wallet's vaults, from the wallet's own 32-byte seed.
 * Whoever restores the wallet from its secret key gets the same vaults.
 */
export function rootFromSeed(seed: Uint8Array): Promise<Uint8Array> {
  if (seed.length !== 32) throw new VaultError('BAD_SEED', 'A wallet seed is 32 bytes.');
  return hmacSha256(seed, utf8(ROOT_LABEL));
}

/**
 * What a wallet extension is asked to sign so that its vaults can be derived.
 * A wallet shows this text before signing, which is why it says what the
 * signature is worth.
 */
export function vaultKeyMessage(owner: string): Uint8Array {
  return utf8(
    `privacycash.fun prvmax, version 1\n\nSigning this creates the keys of the prvmax vaults of\n${owner}\n\nOnly sign it on privacycash.fun. Whoever holds this signature can spend what those vaults hold.`,
  );
}

/** The root of an extension wallet's vaults, from its signature over `vaultKeyMessage`. */
export function rootFromSignature(signature: Uint8Array): Promise<Uint8Array> {
  if (signature.length !== 64) throw new VaultError('BAD_SIGNATURE', 'A wallet signature is 64 bytes.');
  return hmacSha256(signature, utf8(ROOT_LABEL));
}

/** The 32-byte seed of vault `index` (1 to 10) under a root. */
export function vaultSeed(root: Uint8Array, index: number): Promise<Uint8Array> {
  if (root.length !== 32) throw new VaultError('BAD_ROOT', 'A vault root is 32 bytes.');
  if (!Number.isInteger(index) || index < 1 || index > MAX_VAULTS) throw new VaultError('BAD_INDEX', `Vaults are numbered 1 to ${MAX_VAULTS}.`);
  return hmacSha256(root, utf8(`vault/${index}`));
}

/** The Solana address of the keypair a seed makes. */
export function addressOfSeed(seed: Uint8Array): string {
  return Keypair.fromSeed(seed).publicKey.toBase58();
}

/** The addresses of all ten vaults under a root, in order. */
export async function vaultAddresses(root: Uint8Array): Promise<string[]> {
  const addresses: string[] = [];
  for (let index = 1; index <= MAX_VAULTS; index += 1) addresses.push(addressOfSeed(await vaultSeed(root, index)));
  return addresses;
}

/* ------------------------------------------------------------------ */
/* One key, two sets of vaults                                         */
/* ------------------------------------------------------------------ */

/**
 * A wallet's key leads to two sets of ten vaults.
 *
 * - `signature`: the STANDARD set. Its root is the wallet's signature over
 *   `vaultKeyMessage`. A wallet extension can give that signature, and so
 *   can a ghost wallet, which holds the key itself: Ed25519 signing has no
 *   randomness in it, so both make the same bytes and open the same vaults.
 * - `seed`: the GHOST-ONLY set. Its root is made from the wallet's seed
 *   directly, which an extension never hands out. It is what a ghost wallet
 *   was given before the two were brought together, and it stays reachable
 *   from the ghost wallet for good.
 *
 * Without this, one wallet opened once through an extension and once as a
 * ghost wallet showed two unrelated sets, with nothing to say so.
 */
export type VaultSetKind = 'seed' | 'signature';

export const otherVaultSet = (set: VaultSetKind): VaultSetKind => (set === 'seed' ? 'signature' : 'seed');

export interface VaultSetFacts {
  /** The first vault's address of each set. */
  readonly first: Readonly<Record<VaultSetKind, string>>;
  /** What this browser has on record for the wallet: the first vault of the set it showed last, and whether the person chose that set themselves. */
  readonly recorded?: { readonly check: string; readonly pinned: boolean } | null;
  /** Whether anything ever happened at each set's addresses. Null where the chain was not asked or did not answer. */
  readonly used?: Readonly<Record<VaultSetKind, boolean | null>> | null;
  /** The set the person asks for now. */
  readonly asked?: VaultSetKind | null;
}

export interface VaultSetChoice {
  readonly set: VaultSetKind;
  /** Why this one: for the page to say, and for the tests. */
  readonly reason: 'asked' | 'pinned' | 'only-used' | 'recorded' | 'new' | 'legacy';
  /** False when it was chosen without the chain's answer. Such a choice is not put on record. */
  readonly certain: boolean;
  /** Whether the other set has been used. The page says so when it has. Null when not known. */
  readonly otherUsed: boolean | null;
}

/**
 * Which of a ghost wallet's two sets to show.
 *
 * What the person asks for comes first, then a set they chose themselves
 * earlier. After that the chain decides: when exactly one set has ever been
 * used, that is the one, whatever this browser showed before, so that every
 * browser arrives at the vaults that hold something. When both or neither
 * were used, the browser's own record stands. A wallet with nothing used and
 * nothing on record starts on the standard set. And when the chain does not
 * answer, nothing changes: the recorded set, or the one every earlier
 * version showed.
 */
export function chooseVaultSet(facts: VaultSetFacts): VaultSetChoice {
  const used = facts.used ?? { seed: null, signature: null };
  const done = (set: VaultSetKind, reason: VaultSetChoice['reason'], certain: boolean): VaultSetChoice => ({ set, reason, certain, otherUsed: used[otherVaultSet(set)] });
  const recorded = facts.recorded ? (facts.recorded.check === facts.first.signature ? 'signature' : facts.recorded.check === facts.first.seed ? 'seed' : null) : null;
  if (facts.asked) return done(facts.asked, 'asked', true);
  if (recorded && facts.recorded?.pinned === true) return done(recorded, 'pinned', true);
  if (used.seed === null || used.signature === null) return done(recorded ?? 'seed', recorded ? 'recorded' : 'legacy', false);
  if (used.seed !== used.signature) return done(used.seed ? 'seed' : 'signature', 'only-used', true);
  if (recorded) return done(recorded, 'recorded', true);
  return used.seed ? done('seed', 'legacy', true) : done('signature', 'new', true);
}

/* ------------------------------------------------------------------ */
/* Amounts                                                             */
/* ------------------------------------------------------------------ */

/** `total` in `parts` shares that add up to it exactly. What does not divide goes to the first shares, one unit each. */
export function splitEvenly(total: bigint, parts: number): bigint[] {
  if (!Number.isInteger(parts) || parts < 1) throw new VaultError('BAD_PARTS', 'Choose at least one vault.');
  if (total <= 0n) throw new VaultError('BAD_AMOUNT', 'Enter an amount greater than zero.');
  const count = BigInt(parts);
  const each = total / count;
  const left = Number(total % count);
  if (each === 0n) throw new VaultError('TOO_SMALL', 'That amount is too small to split between this many vaults.');
  return Array.from({ length: parts }, (_unused, index) => each + (index < left ? 1n : 0n));
}

/** `percent` of `amount`, rounded down. 100 is all of it, exactly. */
export function shareOf(amount: bigint, percent: number): bigint {
  if (!Number.isFinite(percent) || percent <= 0 || percent > 100) throw new VaultError('BAD_PERCENT', 'A share is between 1% and 100%.');
  if (percent === 100) return amount;
  return (amount * BigInt(Math.round(percent * 100))) / 10_000n;
}

export interface GasTransfer {
  /** Position in the list that was asked about. */
  readonly index: number;
  readonly to: string;
  readonly lamports: bigint;
}

/**
 * What each vault has to be sent to hold `target` lamports of public SOL. A
 * vault already at or above the target gets nothing. A vault that holds
 * nothing at all is sent the whole target, which is always enough to open
 * its account.
 */
export function gasTopUps(vaults: ReadonlyArray<{ readonly address: string; readonly lamports: bigint }>, target: bigint): GasTransfer[] {
  if (target < VAULT_GAS_MIN_LAMPORTS || target > VAULT_GAS_MAX_LAMPORTS) {
    throw new VaultError('BAD_GAS', 'Give each vault between 0.02 and 0.2 SOL for fees.');
  }
  const transfers: GasTransfer[] = [];
  vaults.forEach((vault, index) => {
    const missing = target - vault.lamports;
    if (missing > 0n) transfers.push({ index, to: vault.address, lamports: missing });
  });
  return transfers;
}

/** True when a vault holds enough public SOL for the flows to run from it. */
export function hasGas(lamports: bigint): boolean {
  return lamports >= GAS_RESERVE_LAMPORTS;
}

/**
 * How much a vault can send away so that it is left with exactly `keep`:
 * everything but that and the fee of the transfer itself. With nothing kept
 * the vault's account is left at zero. Null when the fee and what is kept are
 * all there is, or more.
 */
export function sweepAmount(balance: bigint, priorityFeeLamports: bigint, keep = 0n): bigint | null {
  if (keep < 0n) throw new VaultError('BAD_AMOUNT', 'What a vault keeps cannot be negative.');
  const amount = balance - SIGNATURE_FEE_LAMPORTS - (priorityFeeLamports > 0n ? priorityFeeLamports : 0n) - keep;
  return amount > 0n ? amount : null;
}

/* ------------------------------------------------------------------ */
/* Who may buy what                                                    */
/* ------------------------------------------------------------------ */

/**
 * A token's creator may not use vaults with that token: not spread it, not
 * buy it, not sell it. Buyers watch what a creator holds and sells, and trades
 * from ten vault addresses would read as other people's. `creators` is every
 * address known to have made the token: the wallet that launched it and the
 * creator the pool names on chain. `own` is every other address that is this
 * person's as far as the browser knows: the wallet's vaults, and the other
 * wallets kept beside it under the same passphrase, so that switching to
 * another wallet in the same list does not step around the rule. Taking a
 * token back out of a vault is never refused.
 */
export function creatorRefused(creators: readonly string[], wallet: string, own: readonly string[]): boolean {
  return creators.some((creator) => creator !== '' && (creator === wallet || own.includes(creator)));
}

export const CREATOR_MESSAGE =
  'This wallet, or another wallet kept in this browser, created this token, so vaults cannot be used with it. Buyers watch what a creator holds and sells, and trades from ten vault addresses would read as other people’s. Trade it from the wallet itself, on the token page. Anything already in a vault can still be recalled.';

/* ------------------------------------------------------------------ */
/* What an observer sees                                               */
/* ------------------------------------------------------------------ */

type Row = readonly [label: string, value: string, hidden: boolean];

export const SPREAD_VISIBILITY: readonly Row[] = Object.freeze([
  ['Your wallet and each vault', 'PUBLIC', false],
  ['That your wallet funded those vaults', 'PUBLIC', false],
  ['Which token each vault received', 'ENCRYPTED', true],
  ['How much each vault received', 'ENCRYPTED', true],
] as const);

export const TRADE_VISIBILITY: readonly Row[] = Object.freeze([
  ['The vault that traded', 'PUBLIC', false],
  ['The token and the size of each trade', 'PUBLIC', false],
  ['That the vault belongs to your wallet', 'PUBLIC (from the spread)', false],
  ['What each vault holds before and after', 'ENCRYPTED', true],
] as const);

/** A trade with the desk: two private transfers in one transaction, and the pool is not touched. */
export const GHOST_TRADE_VISIBILITY: readonly Row[] = Object.freeze([
  ['The vault and the desk’s wallet', 'PUBLIC', false],
  ['That the two traded privately', 'PUBLIC', false],
  ['Which token', 'ENCRYPTED', true],
  ['How much, and at what price', 'ENCRYPTED', true],
  ['What the desk learns', 'THE WHOLE TRADE', false],
] as const);

export function recallVisibility(privately: boolean): readonly Row[] {
  return privately
    ? [
        ['Each vault and the wallet it pays', 'PUBLIC', false],
        ['Which tokens come back', 'ENCRYPTED', true],
        ['How much comes back', 'ENCRYPTED', true],
        ['Each vault’s public SOL, and anything in its ordinary token accounts', 'PUBLIC', false],
      ]
    : [
        ['Each vault and the wallet it pays', 'PUBLIC', false],
        ['Which tokens come back, and how much', 'PUBLIC', false],
        ['Each vault’s public SOL, and anything in its ordinary token accounts', 'PUBLIC', false],
      ];
}

/* ------------------------------------------------------------------ */
/* What was done, kept in the browser                                  */
/* ------------------------------------------------------------------ */

export interface ActivityEntry {
  readonly at: number;
  readonly kind: 'buy' | 'sell';
  /** Vault number, 1 to 10. */
  readonly vault: number;
  readonly mint: string;
  /** The pair token's id, such as SOL. */
  readonly pair: string;
  /** Base units of the pair token: the most paid for a buy, the least received for a sell. */
  readonly quote: string;
  /** Base units of the token bought or sold. */
  readonly tokens: string;
  readonly signature: string;
  /** How it traded: through the pool, in public, or with the desk. Absent in entries written before routes were recorded. */
  readonly route?: 'shielded' | 'ghost';
}

export interface ActivityTotals {
  readonly mint: string;
  readonly pair: string;
  readonly bought: bigint;
  readonly sold: bigint;
  /** Pair token paid for the buys, at most. */
  readonly spent: bigint;
  /** Pair token received from the sells, at least. */
  readonly received: bigint;
  readonly trades: number;
}

/** One line per token traded: what was bought and sold through vaults, and for how much. Newest tokens first. */
export function activityTotals(entries: readonly ActivityEntry[]): ActivityTotals[] {
  const byMint = new Map<string, { mint: string; pair: string; bought: bigint; sold: bigint; spent: bigint; received: bigint; trades: number; last: number }>();
  for (const entry of entries) {
    let tokens: bigint;
    let quote: bigint;
    try {
      tokens = BigInt(entry.tokens);
      quote = BigInt(entry.quote);
    } catch {
      continue;
    }
    const row = byMint.get(entry.mint) ?? { mint: entry.mint, pair: entry.pair, bought: 0n, sold: 0n, spent: 0n, received: 0n, trades: 0, last: 0 };
    byMint.set(entry.mint, row);
    if (entry.kind === 'buy') {
      row.bought += tokens;
      row.spent += quote;
    } else {
      row.sold += tokens;
      row.received += quote;
    }
    row.trades += 1;
    row.last = Math.max(row.last, entry.at);
  }
  return [...byMint.values()].sort((a, b) => b.last - a.last).map(({ last: _last, ...row }) => row);
}

/** The newest `limit` entries of a log with `entry` added, as they are stored. */
export function appendActivity(entries: readonly ActivityEntry[], entry: ActivityEntry, limit = 500): ActivityEntry[] {
  return [...entries, entry].slice(-limit);
}

/** Reads a stored log. Anything that is not an entry is left out, so a damaged log never stops the page. */
export function parseActivity(raw: string | null | undefined): ActivityEntry[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const entries: ActivityEntry[] = [];
  for (const item of parsed as Array<Partial<ActivityEntry> | null>) {
    if (
      item &&
      typeof item.at === 'number' &&
      (item.kind === 'buy' || item.kind === 'sell') &&
      typeof item.vault === 'number' &&
      typeof item.mint === 'string' &&
      typeof item.pair === 'string' &&
      typeof item.quote === 'string' &&
      /^[0-9]+$/.test(item.quote) &&
      typeof item.tokens === 'string' &&
      /^[0-9]+$/.test(item.tokens) &&
      typeof item.signature === 'string'
    ) {
      entries.push({
        at: item.at,
        kind: item.kind,
        vault: item.vault,
        mint: item.mint,
        pair: item.pair,
        quote: item.quote,
        tokens: item.tokens,
        signature: item.signature,
        ...(item.route === 'shielded' || item.route === 'ghost' ? { route: item.route } : {}),
      });
    }
  }
  return entries;
}

/* ------------------------------------------------------------------ */
/* The transactions that are prvmax's own                              */
/* ------------------------------------------------------------------ */

/** Plain SOL transfers from `payer`, one per vault. Pure. */
export function gasInstructions(payer: Address, transfers: readonly GasTransfer[]): Instruction[] {
  if (transfers.length === 0) throw new VaultError('NOTHING_TO_SEND', 'Every vault already has its SOL for fees.');
  if (transfers.length > MAX_VAULTS) throw new VaultError('TOO_MANY', `One wallet has at most ${MAX_VAULTS} vaults.`);
  const from = new PublicKey(payer);
  return transfers.map((transfer) => {
    if (transfer.lamports <= 0n) throw new VaultError('BAD_AMOUNT', 'A transfer must be greater than zero.');
    if (transfer.to === payer) throw new VaultError('SELF', 'A wallet does not fund itself.');
    return fromLegacyInstruction(SystemProgram.transfer({ fromPubkey: from, toPubkey: new PublicKey(transfer.to), lamports: transfer.lamports }));
  });
}

/** One transaction, signed by the wallet, that gives each vault its SOL for fees. */
export async function buildGasFunding(ctx: RingsContext, transfers: readonly GasTransfer[]): Promise<Transaction> {
  return composeV1({
    feePayer: ctx.owner,
    lifetime: await latestLifetime(ctx.client),
    instructions: gasInstructions(ctx.owner, transfers),
    computeUnitLimit: VAULT_COMPUTE_UNITS.gas,
    priorityFeeLamports: priorityOf(ctx, VAULT_COMPUTE_UNITS.gas),
  });
}

export interface Sweep {
  readonly transaction: Transaction;
  /** What arrives at the destination. The vault is left with nothing, or with exactly what it was asked to keep. */
  readonly lamports: bigint;
}

/**
 * Sends everything a vault holds in public SOL to `to`, less the fee of this
 * one transaction, so that the vault's account is left at exactly zero.
 * `balance` is what the vault holds right now. Null when the fee is all there
 * is.
 *
 * An account may hold nothing, or at least the rent-exempt minimum, and
 * nothing in between. `keep` leaves that minimum behind: the fallback for a
 * chain that charges a fee other than the one worked out here, where a
 * transfer meant to leave zero would be refused.
 */
export async function buildSweep(ctx: RingsContext, to: Address, balance: bigint, keep = 0n): Promise<Sweep | null> {
  if (to === ctx.owner) throw new VaultError('SELF', 'A vault cannot be emptied into itself.');
  const priority = priorityOf(ctx, VAULT_COMPUTE_UNITS.sweep);
  const lamports = sweepAmount(balance, priority, keep);
  if (lamports === null) return null;
  const transaction = composeV1({
    feePayer: ctx.owner,
    lifetime: await latestLifetime(ctx.client),
    instructions: [fromLegacyInstruction(SystemProgram.transfer({ fromPubkey: new PublicKey(ctx.owner), toPubkey: new PublicKey(to), lamports }))],
    computeUnitLimit: VAULT_COMPUTE_UNITS.sweep,
    priorityFeeLamports: priority,
  });
  return { transaction, lamports };
}

/** Closes empty token accounts of `owner`; their rent goes back to the owner. Pure. */
export function closeInstructions(owner: Address, accounts: readonly string[]): Instruction[] {
  if (accounts.length === 0) throw new VaultError('NOTHING_TO_CLOSE', 'There is no empty token account to close.');
  if (accounts.length > CLOSE_BATCH) throw new VaultError('TOO_MANY', `One transaction closes at most ${CLOSE_BATCH} accounts.`);
  const key = new PublicKey(owner);
  return accounts.map((account) => fromLegacyInstruction(createCloseAccountInstruction(new PublicKey(account), key, key)));
}

export async function buildCloseAccounts(ctx: RingsContext, accounts: readonly string[]): Promise<Transaction> {
  return composeV1({
    feePayer: ctx.owner,
    lifetime: await latestLifetime(ctx.client),
    instructions: closeInstructions(ctx.owner, accounts),
    computeUnitLimit: VAULT_COMPUTE_UNITS.close,
    priorityFeeLamports: priorityOf(ctx, VAULT_COMPUTE_UNITS.close),
  });
}

export interface TokenMove {
  /** The vault's token account. */
  readonly account: string;
  readonly mint: string;
  /** Everything the account holds, in base units. */
  readonly amount: bigint;
}

/**
 * Sends everything in one of `owner`'s ordinary token accounts to `to`'s
 * account for the same token, opening that account when it is missing, and
 * closes the emptied account so its rent returns to `owner`. An ordinary,
 * public token transfer: this is how a trade's leftovers of a pair token
 * leave a vault. Pure.
 */
export function moveTokenInstructions(owner: Address, to: Address, move: TokenMove): Instruction[] {
  if (to === owner) throw new VaultError('SELF', 'A vault cannot be emptied into itself.');
  if (move.amount <= 0n) throw new VaultError('BAD_AMOUNT', 'There is nothing in that token account to move.');
  const ownerKey = new PublicKey(owner);
  const toKey = new PublicKey(to);
  const mint = new PublicKey(move.mint);
  const source = new PublicKey(move.account);
  const destination = getAssociatedTokenAddressSync(mint, toKey, true);
  if (destination.equals(source)) throw new VaultError('SELF', 'That token account already belongs to the destination.');
  return [
    fromLegacyInstruction(createAssociatedTokenAccountIdempotentInstruction(ownerKey, destination, toKey, mint)),
    fromLegacyInstruction(createTransferInstruction(source, destination, ownerKey, move.amount)),
    fromLegacyInstruction(createCloseAccountInstruction(source, ownerKey, ownerKey)),
  ];
}

export async function buildMoveToken(ctx: RingsContext, to: Address, move: TokenMove): Promise<Transaction> {
  return composeV1({
    feePayer: ctx.owner,
    lifetime: await latestLifetime(ctx.client),
    instructions: moveTokenInstructions(ctx.owner, to, move),
    computeUnitLimit: VAULT_COMPUTE_UNITS.move,
    priorityFeeLamports: priorityOf(ctx, VAULT_COMPUTE_UNITS.move),
  });
}
