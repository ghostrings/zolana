/**
 * The keyring: several wallets under one passphrase.
 *
 * The first wallet is the one a browser has always had: a 32-byte seed,
 * encrypted with the passphrase. Nothing about how it is stored changes here.
 * Every other wallet hangs off it in one of two ways:
 *
 *   derived   seed n = HMAC-SHA256(first wallet's seed, "privacycash.fun/wallets/v1/" + n)
 *             Nothing new to back up: whoever restores the first wallet from its
 *             secret key can make the same wallets again, in the same order.
 *
 *   imported  a key from somewhere else, kept in this browser sealed with
 *             AES-256-GCM under a key that is itself derived from the first
 *             wallet's seed. It is only as safe as the first wallet, and it is
 *             NOT covered by the first wallet's backup: it has its own secret key.
 *
 * What a browser remembers about its wallets (which exist, their names and
 * icons, the sealed imported seeds, the contacts) is the "book". The book
 * holds no usable secret: sealed seeds open only with the first wallet's seed.
 *
 * Everything here is pure: no storage, no network, no Solana library, so the
 * page shell can read a book without loading any of that. The two labels
 * below define keys. Changing either makes existing wallets unreachable, so
 * they are pinned by tests and never edited.
 */

const DERIVE_LABEL = 'privacycash.fun/wallets/v1/';
const IMPORT_KEY_LABEL = 'privacycash.fun/wallets/v1/import-key';

/** How many wallets one browser keeps under one passphrase, the first included. */
export const MAX_WALLETS = 24;
/** The highest derivation number. Far above anything a person makes by hand. */
export const MAX_DERIVED_INDEX = 999;
export const MAX_CONTACTS = 100;
export const NAME_MAX = 24;

export class KeyringError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'KeyringError';
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/* Keys                                                                */
/* ------------------------------------------------------------------ */

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

async function hmacSha256(key: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey('raw', new Uint8Array(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', imported, new Uint8Array(message)));
}

function checkRoot(rootSeed: Uint8Array): void {
  if (rootSeed.length !== 32) throw new KeyringError('BAD_SEED', 'A wallet seed is 32 bytes.');
}

/** The 32-byte seed of derived wallet `index` (1, 2, 3, ...) under the first wallet's seed. */
export async function derivedSeed(rootSeed: Uint8Array, index: number): Promise<Uint8Array> {
  checkRoot(rootSeed);
  if (!Number.isInteger(index) || index < 1 || index > MAX_DERIVED_INDEX) throw new KeyringError('BAD_INDEX', `Derived wallets are numbered 1 to ${MAX_DERIVED_INDEX}.`);
  return hmacSha256(rootSeed, utf8(`${DERIVE_LABEL}${index}`));
}

async function sealingKey(rootSeed: Uint8Array) {
  checkRoot(rootSeed);
  const bytes = await hmacSha256(rootSeed, utf8(IMPORT_KEY_LABEL));
  try {
    return await crypto.subtle.importKey('raw', new Uint8Array(bytes), 'AES-GCM', false, ['encrypt', 'decrypt']);
  } finally {
    bytes.fill(0);
  }
}

const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

/** An imported wallet's seed as it is kept in the book. */
export interface SealedSeed {
  readonly iv: string;
  readonly ciphertext: string;
}

/**
 * Seals an imported wallet's seed for the book. The wallet's address is
 * bound in, so a sealed seed moved under another wallet's entry does not open.
 */
export async function sealSeed(rootSeed: Uint8Array, seed: Uint8Array, address: string): Promise<SealedSeed> {
  if (seed.length !== 32) throw new KeyringError('BAD_SEED', 'A wallet seed is 32 bytes.');
  const key = await sealingKey(rootSeed);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new Uint8Array(utf8(address)) }, key, new Uint8Array(seed)));
  return { iv: toBase64(iv), ciphertext: toBase64(ciphertext) };
}

/** Opens a sealed seed. Throws when it was sealed under another first wallet, for another address, or was altered. */
export async function openSeed(rootSeed: Uint8Array, sealed: SealedSeed, address: string): Promise<Uint8Array> {
  const key = await sealingKey(rootSeed);
  try {
    const seed = new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(fromBase64(sealed.iv)), additionalData: new Uint8Array(utf8(address)) }, key, new Uint8Array(fromBase64(sealed.ciphertext))),
    );
    if (seed.length !== 32) throw new Error('length');
    return seed;
  } catch {
    throw new KeyringError('SEALED', 'This imported wallet could not be opened. It was saved under a different first wallet, or its saved copy is damaged. Import it again from its own secret key.');
  }
}

/* ------------------------------------------------------------------ */
/* The book                                                            */
/* ------------------------------------------------------------------ */

/** The icons a wallet or a contact can wear. `auto` is a pixel mark made from its address. */
export const WALLET_ICONS: readonly string[] = Object.freeze(['auto', 'ghost', 'skull', 'cat', 'moon', 'star', 'bolt', 'heart', 'diamond', 'flame', 'key', 'eye', 'crown']);

export type WalletKind = 'root' | 'derived' | 'imported';

export interface WalletEntry {
  readonly address: string;
  readonly kind: WalletKind;
  /** The derivation number of a derived wallet. */
  readonly index?: number;
  readonly name: string;
  readonly icon: string;
  readonly createdAt: number;
  /** A derived wallet taken off the list. Its number is kept, so it can be put back and is never given to another. */
  readonly hidden?: boolean;
  /** An imported wallet's seed. */
  readonly sealed?: SealedSeed;
}

export interface Contact {
  readonly address: string;
  readonly name: string;
  readonly icon: string;
}

export interface WalletBook {
  readonly v: 1;
  /** The first wallet's address. A book belongs to one first wallet and no other. */
  readonly root: string;
  /** One past the highest derivation number on record. A search for wallets made elsewhere starts counting from here. */
  readonly next: number;
  /** The wallet in use. */
  readonly active: string;
  readonly wallets: readonly WalletEntry[];
  readonly contacts: readonly Contact[];
}

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function looksLikeAddress(text: unknown): text is string {
  return typeof text === 'string' && ADDRESS.test(text);
}

/**
 * A name as it is kept: control characters out, runs of spaces to one, no
 * more than 24 characters. Throws when nothing is left.
 */
export function cleanName(text: unknown): string {
  const cleaned = [...String(text ?? '').replace(/[\p{C}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim()].slice(0, NAME_MAX).join('').trim();
  if (!cleaned) throw new KeyringError('BAD_NAME', 'Give it a name.');
  return cleaned;
}

const iconOr = (icon: unknown): string => (typeof icon === 'string' && WALLET_ICONS.includes(icon) ? icon : 'auto');

export function newBook(root: string, now: number): WalletBook {
  if (!looksLikeAddress(root)) throw new KeyringError('BAD_ADDRESS', 'That is not a Solana address.');
  return { v: 1, root, next: 1, active: root, wallets: [{ address: root, kind: 'root', name: 'Wallet 1', icon: 'auto', createdAt: now }], contacts: [] };
}

function readSealed(value: unknown): SealedSeed | null {
  const sealed = value as Partial<SealedSeed> | null;
  if (!sealed || typeof sealed.iv !== 'string' || typeof sealed.ciphertext !== 'string') return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(sealed.iv) || !/^[A-Za-z0-9+/]+={0,2}$/.test(sealed.ciphertext)) return null;
  return { iv: sealed.iv, ciphertext: sealed.ciphertext };
}

/**
 * Reads a stored book for the first wallet `root`. Whatever is not a valid
 * entry is left out, and a book that cannot be read at all, or belongs to
 * another first wallet, is replaced by a fresh one: a damaged book never
 * keeps a wallet from opening. The first wallet is always there, first.
 */
export function parseBook(raw: string | null | undefined, root: string, now: number): WalletBook {
  const fresh = newBook(root, now);
  if (!raw) return fresh;
  let parsed: Partial<WalletBook> | null;
  try {
    parsed = JSON.parse(raw) as Partial<WalletBook> | null;
  } catch {
    return fresh;
  }
  if (!parsed || typeof parsed !== 'object' || parsed.root !== root || !Array.isArray(parsed.wallets)) return fresh;
  const seen = new Set<string>([root]);
  const usedIndexes = new Set<number>();
  const rootEntry = (parsed.wallets as Array<Partial<WalletEntry> | null>).find((entry) => entry?.kind === 'root' && entry.address === root);
  const wallets: WalletEntry[] = [
    {
      address: root,
      kind: 'root',
      name: safeName(rootEntry?.name, 'Wallet 1'),
      icon: iconOr(rootEntry?.icon),
      createdAt: typeof rootEntry?.createdAt === 'number' ? rootEntry.createdAt : now,
    },
  ];
  for (const entry of parsed.wallets as Array<Partial<WalletEntry> | null>) {
    if (!entry || !looksLikeAddress(entry.address) || seen.has(entry.address)) continue;
    const base = { address: entry.address, name: safeName(entry.name, 'Wallet'), icon: iconOr(entry.icon), createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : now };
    if (entry.kind === 'derived') {
      const index = entry.index;
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 1 || index > MAX_DERIVED_INDEX || usedIndexes.has(index)) continue;
      usedIndexes.add(index);
      wallets.push({ ...base, kind: 'derived', index, ...(entry.hidden === true ? { hidden: true } : {}) });
    } else if (entry.kind === 'imported') {
      const sealed = readSealed(entry.sealed);
      if (!sealed) continue;
      wallets.push({ ...base, kind: 'imported', sealed });
    } else {
      continue;
    }
    seen.add(entry.address);
  }
  const contacts: Contact[] = [];
  if (Array.isArray(parsed.contacts)) {
    for (const contact of parsed.contacts as Array<Partial<Contact> | null>) {
      if (!contact || !looksLikeAddress(contact.address) || seen.has(contact.address) || contacts.some((other) => other.address === contact.address)) continue;
      if (contacts.length >= MAX_CONTACTS) break;
      contacts.push({ address: contact.address, name: safeName(contact.name, 'Contact'), icon: iconOr(contact.icon) });
    }
  }
  const highest = Math.max(0, ...usedIndexes);
  const next = Math.max(typeof parsed.next === 'number' && Number.isInteger(parsed.next) && parsed.next >= 1 ? parsed.next : 1, highest + 1);
  const active = wallets.some((wallet) => wallet.address === parsed?.active && wallet.hidden !== true) ? (parsed.active as string) : root;
  return { v: 1, root, next, active, wallets, contacts };
}

function safeName(value: unknown, fallback: string): string {
  try {
    return cleanName(value);
  } catch {
    return fallback;
  }
}

export const visibleWallets = (book: WalletBook): WalletEntry[] => book.wallets.filter((wallet) => wallet.hidden !== true);
export const findWallet = (book: WalletBook, address: string): WalletEntry | undefined => book.wallets.find((wallet) => wallet.address === address);

const namesIn = (book: WalletBook, except?: string): Set<string> =>
  new Set([...book.wallets, ...book.contacts].filter((entry) => entry.address !== except).map((entry) => entry.name.toLowerCase()));

/** "Wallet 2", "Wallet 3", ...: the first such name nothing in the book has. */
export function nextWalletName(book: WalletBook): string {
  const taken = namesIn(book);
  for (let number = visibleWallets(book).length + 1; ; number += 1) {
    if (!taken.has(`wallet ${number}`)) return `Wallet ${number}`;
  }
}

/**
 * A name as it is kept, and not one something else in the book already has:
 * two wallets, or a wallet and a contact, under one name is how funds get
 * sent to the wrong one. `except` is the address being renamed.
 */
function freeName(book: WalletBook, text: unknown, except?: string): string {
  const name = cleanName(text);
  if (namesIn(book, except).has(name.toLowerCase())) throw new KeyringError('NAME_TAKEN', 'That name is already used here. Pick another.');
  return name;
}

/**
 * The lowest derivation number, from `from` up, that no wallet in the book
 * has; those taken off the list still have theirs. Null when none is left.
 *
 * A new wallet takes the lowest free number, not the one after the highest:
 * on the device where the wallets were made the two are the same, and on
 * another device it means that making wallets brings back, in the order they
 * were first made, any that a search did not find.
 */
export function freeDerivedIndex(book: WalletBook, from = 1): number | null {
  const taken = new Set(book.wallets.filter((wallet) => wallet.kind === 'derived').map((wallet) => wallet.index));
  for (let index = Math.max(1, Math.trunc(from)); index <= MAX_DERIVED_INDEX; index += 1) {
    if (!taken.has(index)) return index;
  }
  return null;
}

function requireRoom(book: WalletBook): void {
  if (visibleWallets(book).length >= MAX_WALLETS) throw new KeyringError('FULL', `One browser keeps up to ${MAX_WALLETS} wallets. Remove one first.`);
}

function replaceWallet(book: WalletBook, address: string, change: (wallet: WalletEntry) => WalletEntry): WalletBook {
  if (!findWallet(book, address)) throw new KeyringError('NO_WALLET', 'That wallet is not on the list.');
  return { ...book, wallets: book.wallets.map((wallet) => (wallet.address === address ? change(wallet) : wallet)) };
}

/**
 * The book with derived wallet `index` on it, at `address`. A wallet with
 * that number that was taken off the list is put back as it was.
 */
export function withDerived(book: WalletBook, index: number, address: string, now: number, name?: string): WalletBook {
  if (!looksLikeAddress(address)) throw new KeyringError('BAD_ADDRESS', 'That is not a Solana address.');
  if (!Number.isInteger(index) || index < 1 || index > MAX_DERIVED_INDEX) throw new KeyringError('BAD_INDEX', `Derived wallets are numbered 1 to ${MAX_DERIVED_INDEX}.`);
  const sameNumber = book.wallets.find((wallet) => wallet.kind === 'derived' && wallet.index === index);
  if (sameNumber) {
    if (sameNumber.address !== address) throw new KeyringError('MISMATCH', 'This wallet number leads to a different address than the one on record. Nothing was changed.');
    if (sameNumber.hidden !== true) return book;
    requireRoom(book);
    return replaceWallet(book, address, ({ hidden: _hidden, ...wallet }) => wallet);
  }
  if (findWallet(book, address)) throw new KeyringError('DUPLICATE', 'That wallet is already on the list.');
  requireRoom(book);
  const entry: WalletEntry = { address, kind: 'derived', index, name: name === undefined ? nextWalletName(book) : freeName(book, name), icon: 'auto', createdAt: now };
  return { ...book, next: Math.max(book.next, index + 1), wallets: [...book.wallets, entry], contacts: book.contacts.filter((contact) => contact.address !== address) };
}

export interface DerivedSearch {
  readonly book: WalletBook;
  /** How many wallets were added. */
  readonly found: number;
  /** What stopped the search early, when something did. Whatever was found before it is in `book`. */
  readonly failure?: unknown;
}

/**
 * Looks for derived wallets that exist but are not in the book: on another
 * device the book starts empty while the wallets are still on chain.
 *
 * Every number without a wallet is tried, lowest first. `addressAt` gives the
 * address a number leads to, and `used` says whether anything ever happened
 * at an address. Those are added. The search ends after `span` numbers in a
 * row, past the highest one known, at which nothing was found, or when the
 * list is full. It never removes or changes a wallet that is already there.
 */
export async function searchDerived(
  start: WalletBook,
  addressAt: (index: number) => Promise<string>,
  used: (address: string) => Promise<boolean>,
  now: number,
  span = 8,
): Promise<DerivedSearch> {
  let book = start;
  let found = 0;
  let quiet = 0;
  try {
    for (let index = 1; index <= MAX_DERIVED_INDEX && quiet < span; index += 1) {
      const beyond = index >= book.next;
      if (book.wallets.some((wallet) => wallet.kind === 'derived' && wallet.index === index)) continue;
      const candidate = await addressAt(index);
      // An address already here under its own key (it was imported) is not listed twice.
      if (!findWallet(book, candidate) && (await used(candidate))) {
        if (visibleWallets(book).length >= MAX_WALLETS) break;
        book = withDerived(book, index, candidate, now);
        found += 1;
        quiet = 0;
      } else if (beyond) {
        quiet += 1;
      }
    }
  } catch (failure) {
    return { book, found, failure };
  }
  return { book, found };
}

/** The book with an imported wallet on it. */
export function withImported(book: WalletBook, address: string, sealed: SealedSeed, now: number, name?: string): WalletBook {
  if (!looksLikeAddress(address)) throw new KeyringError('BAD_ADDRESS', 'That is not a Solana address.');
  const existing = findWallet(book, address);
  if (existing && existing.hidden !== true) throw new KeyringError('DUPLICATE', 'That wallet is already on the list.');
  if (existing) throw new KeyringError('DUPLICATE', 'That key is one of the wallets made from your first wallet. Put it back from the list of removed wallets instead.');
  requireRoom(book);
  const entry: WalletEntry = { address, kind: 'imported', name: name === undefined ? nextWalletName(book) : freeName(book, name), icon: 'auto', createdAt: now, sealed };
  return { ...book, wallets: [...book.wallets, entry], contacts: book.contacts.filter((contact) => contact.address !== address) };
}

export function renamed(book: WalletBook, address: string, name: string): WalletBook {
  const clean = freeName(book, name, address);
  return replaceWallet(book, address, (wallet) => ({ ...wallet, name: clean }));
}

export function withIcon(book: WalletBook, address: string, icon: string): WalletBook {
  if (!WALLET_ICONS.includes(icon)) throw new KeyringError('BAD_ICON', 'That icon is not one of the set.');
  return replaceWallet(book, address, (wallet) => ({ ...wallet, icon }));
}

export function withActive(book: WalletBook, address: string): WalletBook {
  const wallet = findWallet(book, address);
  if (!wallet || wallet.hidden === true) throw new KeyringError('NO_WALLET', 'That wallet is not on the list.');
  return { ...book, active: address };
}

/**
 * The book without a wallet. The first wallet cannot be taken off. A derived
 * wallet is only hidden: its key can always be made again, and its number is
 * never reused. An imported wallet's sealed seed is deleted, which cannot be
 * undone from here.
 */
export function withoutWallet(book: WalletBook, address: string): WalletBook {
  const wallet = findWallet(book, address);
  if (!wallet) throw new KeyringError('NO_WALLET', 'That wallet is not on the list.');
  if (wallet.kind === 'root') throw new KeyringError('ROOT', 'The first wallet cannot be removed on its own. Every other wallet here depends on it.');
  const active = book.active === address ? book.root : book.active;
  if (wallet.kind === 'derived') return { ...replaceWallet(book, address, (entry) => ({ ...entry, hidden: true })), active };
  return { ...book, active, wallets: book.wallets.filter((entry) => entry.address !== address) };
}

/** The book with a contact added, or renamed when the address is already one. */
export function withContact(book: WalletBook, address: string, name: string, icon = 'auto'): WalletBook {
  if (!looksLikeAddress(address)) throw new KeyringError('BAD_ADDRESS', 'That is not a Solana address.');
  if (book.wallets.some((wallet) => wallet.address === address && wallet.hidden !== true)) throw new KeyringError('OWN', 'That is one of your own wallets. It is already offered wherever you send.');
  const entry: Contact = { address, name: freeName(book, name, address), icon: iconOr(icon) };
  if (book.contacts.some((contact) => contact.address === address)) return { ...book, contacts: book.contacts.map((contact) => (contact.address === address ? entry : contact)) };
  if (book.contacts.length >= MAX_CONTACTS) throw new KeyringError('FULL', `The address book holds up to ${MAX_CONTACTS} contacts. Remove one first.`);
  return { ...book, contacts: [...book.contacts, entry] };
}

export function withoutContact(book: WalletBook, address: string): WalletBook {
  return { ...book, contacts: book.contacts.filter((contact) => contact.address !== address) };
}

/** What this browser calls an address: one of its wallets, a contact, or nothing. */
export function nameOf(book: WalletBook, address: string): { name: string; icon: string; own: boolean } | null {
  const wallet = book.wallets.find((entry) => entry.address === address && entry.hidden !== true);
  if (wallet) return { name: wallet.name, icon: wallet.icon, own: true };
  const contact = book.contacts.find((entry) => entry.address === address);
  return contact ? { name: contact.name, icon: contact.icon, own: false } : null;
}
