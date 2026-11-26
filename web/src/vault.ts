/**
 * What the page shell needs to know about the wallet without loading any SDK:
 * whether one exists in this browser, whether it is unlocked in this tab, and
 * its public address. Storage keys are shared with `wallet.ts`.
 */

import { type WalletBook, type WalletEntry, findWallet, parseBook } from '../../shared/src/keyring.js';

/** The first wallet: its address, and its seed encrypted with the passphrase. Its shape has never changed. */
export const VAULT_KEY = 'pcf.vault.v1';
/** The seed of the wallet IN USE in this tab. Every page signs with this one and needs to know nothing else. */
export const SESSION_SEED = 'pcf.session.seed';
/** The first wallet's seed, while unlocked: what the other wallets are made from and opened with. */
export const SESSION_ROOT = 'pcf.session.root';
/** The addresses of imported wallets whose saved key this tab tried and could not open. No key is kept here. */
export const SESSION_UNOPENED = 'pcf.session.unopened';
/** The address of the wallet in use. */
export const SESSION_ACTIVE = 'pcf.session.active';
/** What this browser remembers of the wallets under one first wallet: names, icons, sealed imported seeds, contacts. */
export const BOOK_PREFIX = 'pcf.wallets.v1.';
export const SESSION_EXTERNAL = 'pcf.session.external';
/** The root of an extension wallet's prvmax vaults, for this tab only. A ghost wallet's root follows from its seed. */
export const SESSION_PRVMAX = 'pcf.session.prvmax';
export const STATE_PREFIX = 'pcf.state.v1.';
/** What a wallet chose for its prvmax vaults: how many are shown, and the address the first one must have. */
export const PRVMAX_PREFIX = 'pcf.prvmax.v1.';
/** What was traded through a wallet's vaults, kept in this browser only. */
export const PRVMAX_LOG_PREFIX = 'pcf.prvmax.log.v1.';

export interface Vault {
  readonly address: string;
  readonly salt: string;
  readonly iv: string;
  readonly ciphertext: string;
}

export function storage(kind: 'local' | 'session'): Storage | null {
  try {
    return kind === 'local' ? localStorage : sessionStorage;
  } catch {
    return null;
  }
}

export function readVault(): Vault | null {
  try {
    const raw = storage('local')?.getItem(VAULT_KEY);
    if (!raw) return null;
    const vault = JSON.parse(raw) as Vault;
    return typeof vault.address === 'string' && typeof vault.ciphertext === 'string' ? vault : null;
  } catch {
    return null;
  }
}

export function hasVault(): boolean {
  return readVault() !== null;
}

export function vaultAddress(): string | null {
  return readVault()?.address ?? null;
}

export function isUnlocked(): boolean {
  return Boolean(storage('session')?.getItem(SESSION_SEED) || storage('session')?.getItem(SESSION_EXTERNAL));
}

/** The book of the first wallet in this browser, or null when there is no wallet here. Never throws: a damaged book reads as a fresh one. */
export function readBook(): WalletBook | null {
  const root = vaultAddress();
  if (!root) return null;
  try {
    return parseBook(storage('local')?.getItem(BOOK_PREFIX + root), root, Date.now());
  } catch {
    return null;
  }
}

/** Stores a book. Returns false when this browser would not keep it; the wallets themselves are unaffected. */
export function saveBook(book: WalletBook): boolean {
  try {
    const local = storage('local');
    if (!local) return false;
    local.setItem(BOOK_PREFIX + book.root, JSON.stringify(book));
    return true;
  } catch {
    return false;
  }
}

/** Forgets everything this tab holds while unlocked. The encrypted wallets stay in the browser. */
export function lockSession(): void {
  const session = storage('session');
  for (const key of [SESSION_SEED, SESSION_ROOT, SESSION_UNOPENED, SESSION_ACTIVE, SESSION_EXTERNAL, SESSION_PRVMAX]) session?.removeItem(key);
}

/** The ghost wallet in use in this tab, as the book has it: for the header, which loads no SDK. Null when locked. */
export function activeWallet(): WalletEntry | null {
  const session = storage('session');
  if (!session?.getItem(SESSION_SEED)) return null;
  const book = readBook();
  if (!book) return null;
  return findWallet(book, session.getItem(SESSION_ACTIVE) ?? book.root) ?? null;
}

/**
 * The ghost wallet this browser would use: the one in use in this tab, or,
 * while locked, the one that was in use last and opens with the passphrase.
 * Null when there is no ghost wallet here.
 */
export function lastUsedWallet(): WalletEntry | null {
  const book = readBook();
  if (!book) return null;
  const session = storage('session');
  const inUse = session?.getItem(SESSION_SEED) ? session.getItem(SESSION_ACTIVE) : null;
  return findWallet(book, inUse ?? book.active) ?? findWallet(book, book.root) ?? null;
}

/** How many wallets are on this browser's list. Zero when there is no ghost wallet here. */
export function walletCount(): number {
  return readBook()?.wallets.filter((wallet) => wallet.hidden !== true).length ?? 0;
}

/** The address of the wallet unlocked in this tab, or null. */
export function activeAddress(): string | null {
  const session = storage('session');
  if (session?.getItem(SESSION_SEED)) return session.getItem(SESSION_ACTIVE) ?? vaultAddress();
  try {
    const external = session?.getItem(SESSION_EXTERNAL);
    if (!external) return null;
    const parsed = JSON.parse(external) as { address?: unknown };
    return typeof parsed.address === 'string' ? parsed.address : null;
  } catch {
    return null;
  }
}
