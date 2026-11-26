/**
 * Wallets.
 *
 * GHOST WALLET (built in, default)
 *   A Solana keypair generated in this browser. The 32-byte seed is stored
 *   encrypted with a passphrase (PBKDF2-SHA256 -> AES-256-GCM) in
 *   localStorage. While unlocked, the seed is kept in sessionStorage for this
 *   tab only, so moving between pages does not ask for the passphrase again;
 *   closing the tab or pressing Lock removes it. It signs version 1
 *   transactions itself, so it does not depend on what a browser extension
 *   supports. It is an ordinary Solana keypair: export it and import it into
 *   any wallet.
 *
 *   One browser keeps several of them under the one passphrase. The first is
 *   stored exactly as it always was; the others are derived from its seed or
 *   imported and sealed under it (`shared/src/keyring.ts`). One of them is
 *   "in use": its seed is the one in sessionStorage that every page signs
 *   with, so no page needs to know there is more than one. Beside it the tab
 *   holds the first wallet's seed, from which each of the others is made or
 *   opened at the moment it is needed, and no other key.
 *
 * EXTERNAL WALLET (Wallet Standard, beta)
 *   Any wallet extension that can sign an arbitrary message and a version 1
 *   transaction. The privacy keys are derived from the wallet's signature over
 *   the Rings derivation message; that signature is kept in sessionStorage for
 *   this tab. It grants view access and proving, never spending.
 *
 * Nothing in this file is ever sent to the server.
 */

import { getWallets } from '@wallet-standard/app';
import bs58 from 'bs58';
import {
  type Address,
  type Transaction,
  type TransactionPartialSigner,
  address,
  getAddressEncoder,
  getTransactionDecoder,
  getTransactionEncoder,
} from '@solana/kit';
import {
  LocalKeys,
  ShieldedKeypair,
  SigningKey,
  type Wallet,
  loadPersistedWallet,
  syncPersistedWallet,
  walletSnapshotCipher,
} from '@heliuslabs/spr';
import { ed25519DerivationMessage } from '@heliuslabs/spr/keypair';

import {
  type Contact,
  type WalletBook,
  type WalletEntry,
  type WalletKind,
  derivedSeed,
  findWallet,
  freeDerivedIndex,
  nameOf,
  newBook,
  openSeed,
  renamed,
  sealSeed,
  searchDerived,
  visibleWallets,
  withActive,
  withContact,
  withDerived,
  withIcon,
  withImported,
  withoutContact,
  withoutWallet,
} from '../../shared/src/keyring.js';
import { type RingsContext, newWalletState, syncRings } from '../../shared/src/privacy.js';
import { addSignature, withSignature } from '../../shared/src/signing.js';
import { messageBytesOf } from '../../shared/src/tx.js';
import { derivationSeedOf } from '../../shared/src/viewkeys.js';
import { priorityMicroLamports, ringsClient } from './chain.js';
import { RECORD_PREFIXES } from './local-records.js';
import {
  BOOK_PREFIX,
  PRVMAX_LOG_PREFIX,
  PRVMAX_PREFIX,
  SESSION_ACTIVE,
  SESSION_EXTERNAL,
  SESSION_PRVMAX,
  SESSION_ROOT,
  SESSION_SEED,
  SESSION_UNOPENED,
  STATE_PREFIX,
  VAULT_KEY,
  type Vault,
  activeWallet,
  hasVault,
  lockSession,
  readBook,
  readVault,
  saveBook,
  storage,
  vaultAddress,
} from './vault.js';

export { hasVault, isUnlocked, vaultAddress } from './vault.js';

const PBKDF2_ITERATIONS = 310_000;

export class WalletError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WalletError';
  }
}

export interface Session {
  readonly kind: 'ghost' | 'external';
  readonly address: Address;
  readonly label: string;
  readonly ctx: RingsContext;
  /** Syncs private notes and saves the encrypted snapshot. */
  sync(requireSlot?: bigint): Promise<void>;
}

const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const unb64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

async function vaultKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export function keypairFromSeed(seed: Uint8Array): ShieldedKeypair {
  if (seed.length !== 32) throw new WalletError('A wallet seed must be 32 bytes.');
  return ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(new Uint8Array(seed) as never));
}

/**
 * The Ed25519 signature of the key a seed makes, over `message`. Signing with
 * Ed25519 (RFC 8032) has no randomness in it, so these are byte for byte the
 * bytes a wallet extension holding the same key returns for the same message.
 * That is what lets a ghost wallet open the vaults an extension opens.
 */
export function signWithSeed(seed: Uint8Array, message: Uint8Array): Uint8Array {
  if (seed.length !== 32) throw new WalletError('A wallet seed must be 32 bytes.');
  const key = SigningKey.fromEd25519Bytes(new Uint8Array(seed) as never);
  try {
    return new Uint8Array(key.sign(message));
  } finally {
    key.destroy();
  }
}

function checkPassphrase(passphrase: string): void {
  if (passphrase.length < 8) throw new WalletError('Use a passphrase of at least 8 characters.');
}

async function storeVault(seed: Uint8Array, passphrase: string): Promise<string> {
  checkPassphrase(passphrase);
  const local = storage('local');
  if (!local) throw new WalletError('This browser blocks storage, so a wallet cannot be saved here.');
  const signerAddress = keypairFromSeed(seed).toSolanaSigner().address;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await vaultKey(passphrase, salt);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, seed as BufferSource));
  const vault: Vault = { address: signerAddress, salt: b64(salt), iv: b64(iv), ciphertext: b64(ciphertext) };
  local.setItem(VAULT_KEY, JSON.stringify(vault));
  // A first wallet is always in use right after it is made or imported.
  await openKeyring(seed, signerAddress);
  return signerAddress;
}

/** Creates a new ghost wallet. Refuses to overwrite an existing one. */
export async function createGhostWallet(passphrase: string): Promise<Session> {
  if (hasVault()) throw new WalletError('A ghost wallet already exists in this browser. Export it before replacing it.');
  const seed = crypto.getRandomValues(new Uint8Array(32));
  await storeVault(seed, passphrase);
  seed.fill(0);
  return requireSession();
}

/** Imports a Solana secret key (base58, or a JSON byte array; 64 bytes, or a 32-byte seed). */
export async function importGhostWallet(secret: string, passphrase: string, replace = false): Promise<Session> {
  if (hasVault() && !replace) throw new WalletError('A ghost wallet already exists in this browser. Export it before replacing it.');
  const seed = seedFromSecret(secret);
  await storeVault(seed, passphrase);
  seed.fill(0);
  return requireSession();
}

/** The 32-byte seed in a Solana secret key as people paste it: base58, or a JSON byte array; 64 bytes, or a bare 32-byte seed. */
function seedFromSecret(secret: string): Uint8Array {
  const trimmed = secret.trim();
  let bytes: Uint8Array;
  try {
    bytes = trimmed.startsWith('[') ? Uint8Array.from(JSON.parse(trimmed) as number[]) : bs58.decode(trimmed);
  } catch {
    throw new WalletError('That is not a Solana secret key.');
  }
  if (bytes.length !== 64 && bytes.length !== 32) throw new WalletError('A Solana secret key is 64 bytes (or a 32-byte seed).');
  const seed = bytes.slice(0, 32);
  if (bytes.length === 64) {
    const expected = getAddressEncoder().encode(keypairFromSeed(seed).toSolanaSigner().address);
    if (!expected.every((byte, index) => byte === bytes[32 + index])) {
      throw new WalletError('That secret key is inconsistent: its public half does not match its seed.');
    }
  }
  bytes.fill(0);
  return seed;
}

export async function unlockGhostWallet(passphrase: string): Promise<Session> {
  const vault = readVault();
  if (!vault) throw new WalletError('There is no ghost wallet in this browser yet.');
  let seed: Uint8Array;
  try {
    const key = await vaultKey(passphrase, unb64(vault.salt));
    seed = new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(vault.iv) as BufferSource }, key, unb64(vault.ciphertext) as BufferSource),
    );
  } catch {
    throw new WalletError('Wrong passphrase.');
  }
  // The key is what the passphrase protects; the address stored beside it is a label. Should the
  // two ever disagree, the label is corrected and the key is used as it is: a wallet is never
  // kept shut over its label. The encrypted key itself is not rewritten.
  const signs = keypairFromSeed(seed).toSolanaSigner().address;
  if (signs !== vault.address) storage('local')?.setItem(VAULT_KEY, JSON.stringify({ ...vault, address: signs }));
  await openKeyring(seed);
  seed.fill(0);
  return requireSession();
}

export function lock(): void {
  lockSession();
  cached = undefined;
}

/**
 * The unlocked ghost wallet's seed, for deriving the keys that belong to it
 * (its prvmax vaults). Null when the wallet in this tab is not a ghost wallet.
 * The caller wipes the bytes when it is done with them.
 */
export function ghostSeed(): Uint8Array | null {
  const raw = storage('session')?.getItem(SESSION_SEED);
  return raw ? unb64(raw) : null;
}

/** The standard 64-byte Solana secret key, base58. Anyone who has it controls the wallet. */
export function exportSecret(): string {
  const raw = storage('session')?.getItem(SESSION_SEED);
  if (!raw) throw new WalletError('Unlock the ghost wallet first.');
  const seed = unb64(raw);
  const publicKey = getAddressEncoder().encode(keypairFromSeed(seed).toSolanaSigner().address);
  const secret = new Uint8Array(64);
  secret.set(seed, 0);
  secret.set(publicKey, 32);
  const text = bs58.encode(secret);
  seed.fill(0);
  secret.fill(0);
  return text;
}

/**
 * The address of the wallet in use and its Rings derivation signature: what a
 * viewing pass is sealed from (`shared/src/viewpass.ts`). The signature
 * rebuilds the wallet's viewing and nullifier keys and no key that signs. A
 * ghost wallet makes it from its seed; for a wallet extension it is the
 * signature it gave when it connected. The caller wipes the bytes when done.
 */
export function viewingSeed(): { address: Address; signature: Uint8Array } {
  const session = storage('session');
  const seedText = session?.getItem(SESSION_SEED);
  if (seedText) {
    const seed = unb64(seedText);
    try {
      return derivationSeedOf(seed);
    } finally {
      seed.fill(0);
    }
  }
  const externalText = session?.getItem(SESSION_EXTERNAL);
  if (externalText) {
    const external = JSON.parse(externalText) as { address: string; seed: string };
    const signature = unb64(external.seed);
    if (signature.length !== 64) throw new WalletError('Reconnect the wallet first.');
    return { address: address(external.address), signature };
  }
  throw new WalletError('Unlock or connect a wallet first.');
}

/**
 * Removes the first wallet from this browser, and with it everything that
 * hangs off it: the list of wallets made from it, the sealed seeds of the
 * imported ones, and what was cached for each. The caller must have confirmed
 * that the secret keys worth keeping are saved.
 */
export function forgetGhostWallet(): void {
  const vault = readVault();
  const book = readBook();
  const local = storage('local');
  local?.removeItem(VAULT_KEY);
  const addresses = new Set<string>([...(vault ? [vault.address] : []), ...(book?.wallets.map((wallet) => wallet.address) ?? [])]);
  for (const address of addresses) forgetCaches(address);
  if (vault) local?.removeItem(BOOK_PREFIX + vault.address);
  lock();
}

/**
 * What this browser cached for one wallet: its decrypted notes, its prvmax settings, its list of vault trades,
 * and what the wallet extras kept (payment notes, requests made, alert settings).
 */
function forgetCaches(address: string): void {
  const local = storage('local');
  for (const prefix of [STATE_PREFIX, PRVMAX_PREFIX, PRVMAX_LOG_PREFIX, ...RECORD_PREFIXES]) local?.removeItem(prefix + address);
}

/* ------------------------------------------------------------------ */
/* The keyring: several wallets under the one passphrase               */
/* ------------------------------------------------------------------ */

const addressOfSeed = (seed: Uint8Array): Address => keypairFromSeed(seed).toSolanaSigner().address;

const IMPORT_UNOPENED = 'This imported wallet could not be opened in this browser. Remove it and import it again from its own secret key.';

/** Imported wallets whose saved key this tab tried and could not open. They are listed as such. */
function unopened(): string[] {
  try {
    const parsed = JSON.parse(storage('session')?.getItem(SESSION_UNOPENED) ?? '[]') as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

function markUnopened(target: string, failed: boolean): void {
  const before = unopened();
  if (before.includes(target) === failed) return;
  storage('session')?.setItem(SESSION_UNOPENED, JSON.stringify(failed ? [...before, target] : before.filter((entry) => entry !== target)));
}

/**
 * The first wallet's seed, while unlocked. A tab that was unlocked before
 * there could be more than one wallet holds only the seed in use, which was
 * the first wallet's: that tab is brought up to date here. The caller wipes
 * the bytes when it is done with them.
 */
function rootSeed(): Uint8Array {
  const session = storage('session');
  const root = vaultAddress();
  const stored = session?.getItem(SESSION_ROOT);
  const legacy = stored || session?.getItem(SESSION_ACTIVE) ? null : session?.getItem(SESSION_SEED);
  const raw = stored ?? legacy;
  if (!raw || !root) throw new WalletError('Unlock the ghost wallet first.');
  const seed = unb64(raw);
  if (seed.length !== 32 || addressOfSeed(seed) !== root) {
    seed.fill(0);
    throw new WalletError('Lock the wallet and unlock it again.');
  }
  if (!stored) {
    session?.setItem(SESSION_ROOT, raw);
    session?.setItem(SESSION_ACTIVE, root);
  }
  return seed;
}

function requireBook(): WalletBook {
  const book = readBook();
  if (!book) throw new WalletError('There is no ghost wallet in this browser yet.');
  return book;
}

function keepBook(book: WalletBook): void {
  if (!saveBook(book)) throw new WalletError('This browser would not store the change, so nothing was changed.');
}

/** The seed of one wallet on the list. Checked against the address on record before it is handed out. */
async function seedFor(entry: WalletEntry): Promise<Uint8Array> {
  if (entry.kind === 'root') return rootSeed();
  if (entry.kind === 'derived') {
    const root = rootSeed();
    try {
      const seed = await derivedSeed(root, entry.index ?? 0);
      if (addressOfSeed(seed) !== entry.address) {
        seed.fill(0);
        throw new WalletError('This wallet’s key no longer leads to the address on record, so it was not opened. Nothing has been changed.');
      }
      return seed;
    } finally {
      root.fill(0);
    }
  }
  // An imported wallet's seed is not kept in the tab: its sealed copy is opened each time it is needed.
  const root = rootSeed();
  try {
    if (!entry.sealed) throw new Error('not sealed');
    const seed = await openSeed(root, entry.sealed, entry.address);
    if (addressOfSeed(seed) !== entry.address) {
      seed.fill(0);
      throw new Error('another address');
    }
    markUnopened(entry.address, false);
    return seed;
  } catch {
    markUnopened(entry.address, true);
    throw new WalletError(IMPORT_UNOPENED);
  } finally {
    root.fill(0);
  }
}

/**
 * Puts the keyring into this tab: the first wallet's seed and the seed of
 * the wallet in use. `use` names the wallet to use; otherwise it is the one
 * that was in use last. Each imported wallet's sealed key is tried once, so
 * the list can say which could not be opened. A wallet that cannot be opened
 * never keeps the others, or the first, shut.
 */
async function openKeyring(root: Uint8Array, use?: string): Promise<void> {
  const rootAddress = addressOfSeed(root);
  if (rootAddress !== vaultAddress()) throw new WalletError('That key is not this browser’s first wallet.');
  const session = storage('session');
  if (!session) throw new WalletError('This browser blocks storage, so a wallet cannot be unlocked here.');
  const book = readBook() ?? newBook(rootAddress, Date.now());
  const failed: string[] = [];
  for (const wallet of book.wallets) {
    if (wallet.kind !== 'imported') continue;
    try {
      if (!wallet.sealed) throw new Error('not sealed');
      const seed = await openSeed(root, wallet.sealed, wallet.address);
      const matches = addressOfSeed(seed) === wallet.address;
      seed.fill(0);
      if (!matches) throw new Error('another address');
    } catch {
      // Listed as a wallet that could not be opened; the page says so.
      failed.push(wallet.address);
    }
  }
  lockSession();
  session.setItem(SESSION_ROOT, b64(root));
  session.setItem(SESSION_UNOPENED, JSON.stringify(failed));
  session.setItem(SESSION_ACTIVE, rootAddress);
  session.setItem(SESSION_SEED, b64(root));
  const wanted = findWallet(book, use ?? book.active);
  if (wanted && wanted.hidden !== true && wanted.kind !== 'root') {
    try {
      const seed = await seedFor(wanted);
      session.setItem(SESSION_SEED, b64(seed));
      session.setItem(SESSION_ACTIVE, wanted.address);
      seed.fill(0);
    } catch {
      // The first wallet is in use instead.
    }
  }
  const active = session.getItem(SESSION_ACTIVE) ?? rootAddress;
  saveBook(book.active === active ? book : { ...book, active });
  cached = undefined;
}

export interface WalletInfo {
  readonly address: Address;
  readonly kind: WalletKind;
  readonly name: string;
  readonly icon: string;
  /** The wallet every page is signing with right now. */
  readonly active: boolean;
  /** False for an imported wallet whose saved key this tab tried and could not open. */
  readonly usable: boolean;
}

/** True when a ghost wallet is unlocked in this tab, so its wallets can be listed, added and switched. */
export function keyringOpen(): boolean {
  const session = storage('session');
  return Boolean(hasVault() && session?.getItem(SESSION_SEED) && !session.getItem(SESSION_EXTERNAL));
}

function info(wallet: WalletEntry, active: string, failed: readonly string[]): WalletInfo {
  return { address: wallet.address as Address, kind: wallet.kind, name: wallet.name, icon: wallet.icon, active: wallet.address === active, usable: wallet.kind !== 'imported' || !failed.includes(wallet.address) };
}

/** The wallets on the list, the first one first. Empty when no ghost wallet is unlocked. */
export function listWallets(): WalletInfo[] {
  if (!keyringOpen()) return [];
  const book = readBook();
  if (!book) return [];
  const active = storage('session')?.getItem(SESSION_ACTIVE) ?? book.root;
  const failed = unopened();
  return visibleWallets(book).map((wallet) => info(wallet, active, failed));
}

/** Derived wallets that were taken off the list. Each can be put back. */
export function removedWallets(): WalletInfo[] {
  const book = keyringOpen() ? readBook() : null;
  return book ? book.wallets.filter((wallet) => wallet.hidden === true).map((wallet) => info(wallet, '', [])) : [];
}

/** Starts using one of the wallets on the list. Every page signs with it from here on. */
export async function useWallet(target: string): Promise<Session> {
  const book = requireBook();
  const wallet = findWallet(book, target);
  if (!wallet || wallet.hidden === true) throw new WalletError('That wallet is not on the list.');
  const seed = await seedFor(wallet);
  const session = storage('session');
  session?.setItem(SESSION_SEED, b64(seed));
  seed.fill(0);
  session?.setItem(SESSION_ACTIVE, wallet.address);
  session?.removeItem(SESSION_EXTERNAL);
  session?.removeItem(SESSION_PRVMAX);
  saveBook(withActive(book, wallet.address));
  return requireSession();
}

/**
 * Makes a new wallet from the first wallet's key and starts using it. There
 * is nothing new to back up: the first wallet's secret key makes it again.
 */
export async function createWallet(name?: string): Promise<Session> {
  const book = requireBook();
  const root = rootSeed();
  let made: Address;
  let index = freeDerivedIndex(book);
  try {
    for (;;) {
      if (index === null) throw new WalletError('This first wallet has made as many wallets as it can.');
      const seed = await derivedSeed(root, index);
      made = addressOfSeed(seed);
      seed.fill(0);
      // A number whose wallet is already here (it was imported by its own key) is passed over.
      if (!findWallet(book, made)) break;
      index = freeDerivedIndex(book, index + 1);
    }
  } finally {
    root.fill(0);
  }
  keepBook(withDerived(book, index, made, Date.now(), name));
  return useWallet(made);
}

/**
 * Adds a wallet from its own secret key and starts using it. Its seed is
 * sealed under the first wallet's key and kept in this browser only. It is
 * not covered by the first wallet's backup.
 */
export async function importWallet(secret: string, name?: string): Promise<Session> {
  const book = requireBook();
  const seed = seedFromSecret(secret);
  const root = rootSeed();
  try {
    const imported = addressOfSeed(seed);
    const sealed = await sealSeed(root, seed, imported);
    keepBook(withImported(book, imported, sealed, Date.now(), name));
    markUnopened(imported, false);
    return await useWallet(imported);
  } finally {
    seed.fill(0);
    root.fill(0);
  }
}

export function renameWallet(target: string, name: string): void {
  keepBook(renamed(requireBook(), target, name));
  cached = undefined;
}

export function setWalletIcon(target: string, icon: string): void {
  keepBook(withIcon(requireBook(), target, icon));
}

/**
 * Takes a wallet off the list. A derived wallet is only hidden and can be put
 * back. An imported wallet's saved key is deleted from this browser: without
 * its own secret key it cannot be brought back. Returns the session now in
 * use when that changed.
 */
export async function removeWallet(target: string): Promise<Session | null> {
  const book = requireBook();
  const wallet = findWallet(book, target);
  const wasActive = (storage('session')?.getItem(SESSION_ACTIVE) ?? book.root) === target;
  keepBook(withoutWallet(book, target));
  if (wallet?.kind === 'imported') {
    markUnopened(target, false);
    forgetCaches(target);
  }
  return wasActive ? useWallet(book.root) : null;
}

/** Puts a removed derived wallet back on the list. */
export function restoreWallet(target: string): void {
  const book = requireBook();
  const wallet = findWallet(book, target);
  if (!wallet || wallet.kind !== 'derived' || wallet.index === undefined) throw new WalletError('That wallet cannot be put back from here.');
  keepBook(withDerived(book, wallet.index, wallet.address, Date.now()));
}

/**
 * Looks for wallets this first wallet has made that are not on the list: on
 * a new device the list starts empty, while the wallets still exist on
 * chain. `used` says of an address whether anything ever happened at it.
 * Returns how many were added. What was found before a failure is kept, and
 * the failure is then thrown.
 */
export async function findWallets(used: (candidate: Address) => Promise<boolean>): Promise<number> {
  const root = rootSeed();
  try {
    const search = await searchDerived(
      requireBook(),
      async (index) => {
        const seed = await derivedSeed(root, index);
        try {
          return addressOfSeed(seed);
        } finally {
          seed.fill(0);
        }
      },
      (candidate) => used(candidate as Address),
      Date.now(),
    );
    if (search.found > 0) keepBook(search.book);
    if (search.failure !== undefined) throw search.failure;
    return search.found;
  } finally {
    root.fill(0);
  }
}

/** The standard 64-byte Solana secret key of one wallet on the list, base58. Anyone who has it controls that wallet. */
export async function walletSecret(target: string): Promise<string> {
  const wallet = findWallet(requireBook(), target);
  if (!wallet) throw new WalletError('That wallet is not on the list.');
  const seed = await seedFor(wallet);
  const secret = new Uint8Array(64);
  secret.set(seed, 0);
  secret.set(getAddressEncoder().encode(wallet.address as Address), 32);
  const text = bs58.encode(secret);
  seed.fill(0);
  secret.fill(0);
  return text;
}

/**
 * Every address that is this person's as far as this browser knows: the
 * wallets on the list and those taken off it. Empty unless a ghost wallet is
 * unlocked. Used where a rule is about a person, not about one address.
 */
export function ownAddresses(): string[] {
  const book = keyringOpen() ? readBook() : null;
  return book ? book.wallets.map((wallet) => wallet.address) : [];
}

/** The address book: names this browser gives to other people's addresses. */
export function listContacts(): Contact[] {
  return [...(readBook()?.contacts ?? [])];
}

export function saveContact(target: string, name: string, icon?: string): void {
  keepBook(withContact(requireBook(), target, name, icon));
}

export function removeContact(target: string): void {
  keepBook(withoutContact(requireBook(), target));
}

/** What this browser calls an address: one of its own wallets, a contact, or null. */
export function knownAs(target: string): { name: string; icon: string; own: boolean } | null {
  const book = readBook();
  return book ? nameOf(book, target) : null;
}

/* ------------------------------------------------------------------ */
/* External wallets                                                    */
/* ------------------------------------------------------------------ */

interface StandardAccount {
  readonly address: string;
  readonly publicKey: Uint8Array;
}
interface StandardWallet {
  readonly name: string;
  readonly icon: string;
  readonly chains: readonly string[];
  readonly accounts: readonly StandardAccount[];
  readonly features: Record<string, Record<string, (...inputs: unknown[]) => Promise<unknown>>>;
}

export interface ExternalWalletInfo {
  readonly name: string;
  readonly icon: string;
}

function standardWallets(): StandardWallet[] {
  return (getWallets().get() as unknown as StandardWallet[]).filter(
    (wallet) =>
      wallet.chains.some((chain) => chain.startsWith('solana:')) &&
      'standard:connect' in wallet.features &&
      'solana:signMessage' in wallet.features &&
      'solana:signTransaction' in wallet.features,
  );
}

export function listExternalWallets(): ExternalWalletInfo[] {
  return standardWallets().map((wallet) => ({ name: wallet.name, icon: wallet.icon }));
}

async function connectStandard(name: string): Promise<{ wallet: StandardWallet; account: StandardAccount }> {
  const wallet = standardWallets().find((candidate) => candidate.name === name);
  if (!wallet) throw new WalletError(`${name} is not available in this browser.`);
  const connect = wallet.features['standard:connect']?.connect;
  if (!connect) throw new WalletError(`${name} cannot connect.`);
  const result = (await connect()) as { accounts?: readonly StandardAccount[] };
  const account = result.accounts?.[0] ?? wallet.accounts[0];
  if (!account) throw new WalletError(`${name} did not share an account.`);
  return { wallet, account };
}

/**
 * Connects a wallet extension and derives its privacy keys. The wallet is
 * asked to sign the Rings derivation message once; that signature never
 * leaves this tab.
 */
export async function connectExternal(name: string): Promise<Session> {
  const { wallet, account } = await connectStandard(name);
  const signMessage = wallet.features['solana:signMessage']?.signMessage;
  if (!signMessage) throw new WalletError(`${name} cannot sign messages.`);
  const message = ed25519DerivationMessage(new Uint8Array(account.publicKey) as never);
  const [signed] = (await signMessage({ account, message })) as Array<{ signature: Uint8Array; signedMessage: Uint8Array }>;
  if (!signed || signed.signature.length !== 64) throw new WalletError(`${name} did not return a signature.`);
  if (signed.signedMessage.length !== message.length || !signed.signedMessage.every((byte, index) => byte === message[index])) {
    throw new WalletError(`${name} changed the message before signing it, so its privacy keys cannot be derived. Use the ghost wallet instead.`);
  }
  // An extension takes the tab over: the ghost wallets are locked, not left open beside it.
  lockSession();
  storage('session')?.setItem(SESSION_EXTERNAL, JSON.stringify({ name, address: account.address, seed: b64(signed.signature) }));
  cached = undefined;
  try {
    return await requireSession();
  } catch (error) {
    // A wallet whose privacy keys could not be made is not left half connected in the tab.
    lockSession();
    cached = undefined;
    throw error;
  }
}

/**
 * Has the connected wallet extension sign `message` and returns the 64-byte
 * signature. The wallet shows the message first. Refused when the extension
 * is on another account than the one this tab is connected to, or signs
 * something other than what it was given.
 */
export async function signWithExternal(message: Uint8Array): Promise<Uint8Array> {
  const raw = storage('session')?.getItem(SESSION_EXTERNAL);
  if (!raw) throw new WalletError('Connect a wallet first.');
  const external = JSON.parse(raw) as { name: string; address: string };
  const { wallet, account } = await connectStandard(external.name);
  if (account.address !== external.address) throw new WalletError('The wallet switched accounts. Reconnect it.');
  const signMessage = wallet.features['solana:signMessage']?.signMessage;
  if (!signMessage) throw new WalletError(`${external.name} cannot sign messages.`);
  const [signed] = (await signMessage({ account, message })) as Array<{ signature: Uint8Array; signedMessage: Uint8Array }>;
  if (!signed || signed.signature.length !== 64) throw new WalletError(`${external.name} did not return a signature.`);
  if (signed.signedMessage.length !== message.length || !signed.signedMessage.every((byte, index) => byte === message[index])) {
    throw new WalletError(`${external.name} changed the message before signing it. Nothing was derived from it.`);
  }
  return new Uint8Array(signed.signature);
}

/* ------------------------------------------------------------------ */
/* Session                                                             */
/* ------------------------------------------------------------------ */

let cached: Promise<Session | null> | undefined;

/** The unlocked wallet, or null when there is none. Does not prompt. */
export function getSession(): Promise<Session | null> {
  cached ??= buildSession().catch((error) => {
    cached = undefined;
    throw error;
  });
  return cached;
}

export async function requireSession(): Promise<Session> {
  cached = undefined;
  const session = await getSession();
  if (!session) throw new WalletError('Unlock or create a wallet first.');
  return session;
}

/**
 * A session for a keypair held in this browser: the ghost wallet, and each of
 * its prvmax vaults. It signs by itself, and keeps an encrypted snapshot of
 * its private notes in this browser under its own address.
 */
export async function sessionFromKeypair(keypair: ShieldedKeypair, label: string, options: { readonly keep?: boolean } = {}): Promise<Session> {
  const client = await ringsClient();
  const signer = keypair.toSolanaSigner();
  const shielded = keypair.shieldedAddress();
  const keys = LocalKeys.fromKeypair(keypair, client.proofService);
  const local = storage('local');
  const stateKey = STATE_PREFIX + signer.address;
  // A second view of a wallet (`readerSession`) starts from the saved snapshot but may be told not to write one,
  // so that it never replaces what the page working with the wallet has saved.
  const keep = options.keep !== false;
  const store = {
    load: async () => local?.getItem(stateKey) ?? undefined,
    save: async (snapshot: string) => {
      if (keep) local?.setItem(stateKey, snapshot);
    },
  };
  const cipher = walletSnapshotCipher(keypair);
  let wallet: Wallet;
  try {
    wallet = (await loadPersistedWallet({ store, cipher })) ?? newWalletState(shielded);
  } catch {
    // A snapshot that fails its integrity check is discarded; chain is the source of truth.
    local?.removeItem(stateKey);
    wallet = newWalletState(shielded);
  }
  const ctx: RingsContext = {
    client,
    wallet,
    keys,
    owner: signer.address,
    shielded,
    keypair,
    sign: (transaction) => addSignature(signer as TransactionPartialSigner, transaction),
    priority: priorityMicroLamports,
  };
  return {
    kind: 'ghost',
    address: signer.address,
    label,
    ctx,
    async sync(requireSlot) {
      try {
        await syncPersistedWallet({ client, wallet, keys, store, cipher, ...(requireSlot === undefined ? {} : { config: { requireSlot } }) });
      } catch {
        await syncRings(ctx, requireSlot);
      }
    },
  };
}

/**
 * A second view of the wallet in use, with note state of its own, for reading
 * balances. The header's wallet panel reads through one of these, so a read
 * there never touches the state a page is building a transaction from: the
 * two share the keys and nothing else. With `keep` false it also leaves the
 * saved snapshot of the notes alone. Null when no wallet is unlocked.
 */
export function readerSession(keep: boolean): Promise<Session | null> {
  return buildSession(keep);
}

async function buildSession(keep = true): Promise<Session | null> {
  const session = storage('session');
  const seedText = session?.getItem(SESSION_SEED);
  const externalText = session?.getItem(SESSION_EXTERNAL);
  if (!seedText && !externalText) return null;
  const client = await ringsClient();

  if (seedText) {
    const seed = unb64(seedText);
    const keypair = keypairFromSeed(seed);
    seed.fill(0);
    // The key that signs says which wallet is in use. A label that disagrees with it is corrected, never the other way round.
    const signs = keypair.toSolanaSigner().address;
    const labelled = session?.getItem(SESSION_ACTIVE);
    if (labelled && labelled !== signs) session?.setItem(SESSION_ACTIVE, signs);
    return sessionFromKeypair(keypair, activeWallet()?.name ?? 'Ghost wallet', { keep });
  }

  const external = JSON.parse(externalText as string) as { name: string; address: string; seed: string };
  const owner = address(external.address);
  const keys = LocalKeys.fromDerivationSeed({ solanaPublicKey: owner, derivationSeed: unb64(external.seed) }, client.proofService);
  const shielded = keys.address();
  // Mainnet only: a wallet extension is never asked to sign for another cluster.
  const chain = 'solana:mainnet';
  const ctx: RingsContext = {
    client,
    wallet: newWalletState(shielded),
    keys,
    owner,
    shielded,
    priority: priorityMicroLamports,
    async sign(transaction: Transaction): Promise<Transaction> {
      const { wallet, account } = await connectStandard(external.name);
      if (account.address !== external.address) throw new WalletError('The wallet switched accounts. Reconnect it.');
      const signTransaction = wallet.features['solana:signTransaction']?.signTransaction;
      if (!signTransaction) throw new WalletError(`${external.name} cannot sign transactions.`);
      const wire = new Uint8Array(getTransactionEncoder().encode(transaction));
      let outputs: Array<{ signedTransaction: Uint8Array }>;
      try {
        outputs = (await signTransaction({ account, transaction: wire, chain })) as Array<{ signedTransaction: Uint8Array }>;
      } catch (error) {
        throw new WalletError(
          `${external.name} could not sign this transaction. It may not support version 1 transactions yet; the ghost wallet does. (${error instanceof Error ? error.message : 'rejected'})`,
        );
      }
      const signedBytes = outputs[0]?.signedTransaction;
      if (!signedBytes) throw new WalletError(`${external.name} returned nothing.`);
      const decoded = getTransactionDecoder().decode(signedBytes) as Transaction;
      const original = messageBytesOf(transaction);
      const returned = messageBytesOf(decoded);
      if (original.length !== returned.length || !original.every((byte, index) => byte === returned[index])) {
        throw new WalletError(`${external.name} changed the transaction before signing. It was not sent.`);
      }
      const signature = decoded.signatures[owner];
      if (!signature) throw new WalletError(`${external.name} did not sign.`);
      return withSignature(transaction, owner, signature as Uint8Array);
    },
  };
  return {
    kind: 'external',
    address: owner,
    label: external.name,
    ctx,
    sync: (requireSlot) => syncRings(ctx, requireSlot),
  };
}
