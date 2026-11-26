import { createCipheriv, createDecipheriv, createHmac } from 'node:crypto';

import { ShieldedKeypair, SigningKey } from '@heliuslabs/spr';
import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

import {
  KeyringError,
  MAX_CONTACTS,
  MAX_DERIVED_INDEX,
  MAX_WALLETS,
  NAME_MAX,
  WALLET_ICONS,
  type WalletBook,
  cleanName,
  derivedSeed,
  findWallet,
  freeDerivedIndex,
  looksLikeAddress,
  nameOf,
  newBook,
  nextWalletName,
  openSeed,
  parseBook,
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
} from '../shared/src/keyring.js';
import { rootFromSeed, vaultAddresses } from '../shared/src/vaults.js';

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
const ROOT_SEED = Uint8Array.from({ length: 32 }, (_unused, index) => index + 1);
const ROOT = '9C6hybhQ6Aycep9jaUnP6uL9ZYvDjUp1aSkFWPUFJtpj';
const OTHER_SEED = Uint8Array.from({ length: 32 }, (_unused, index) => 200 - index);
const addressOf = (seed: Uint8Array): string => Keypair.fromSeed(seed).publicKey.toBase58();

/**
 * These addresses are where real money sits. If this list ever has to change
 * for a test to pass, the change being tested has moved every wallet that was
 * ever made from a first wallet and must not ship.
 */
const DERIVED: Record<number, readonly [seed: string, address: string]> = {
  1: ['5940db358ec17fbfa7da007cea19847a6170bc87024ca75f3f862d1d46917fe2', '6wHHsx3amW9gvC1YKMbVUwMffYqFa8RRm5A9EKkvsbDV'],
  2: ['115c8ad7646c31ba26ab75e8d885e3a265152cad173b10212051e723249e33d5', '6vxPZo1gEF5nNjuJpzhfzDHMk6Tmd95a3WknT15dN1E5'],
  3: ['b32a50416c8eb72878911755d9b7220f1cc08b3badbacbfdea833219a2eea5f6', '5ppeMdDMnkfJg4UmRYMm411DnFc6nAibvJF5TQjMtpbn'],
  999: ['c76bdeb0d0433dfb4bbbce2004d85de5f07ee953b82c36a0507c39811984caa5', '7sTFicDLVjGkZka8mUkUXCTdhyo4stQMTb6imLGLqG67'],
};

describe('derived wallets', () => {
  it('come out at the same addresses, for good', async () => {
    expect(addressOf(ROOT_SEED)).toBe(ROOT);
    for (const [number, [seed, address]] of Object.entries(DERIVED)) {
      const derived = await derivedSeed(ROOT_SEED, Number(number));
      expect(hex(derived)).toBe(seed);
      expect(addressOf(derived)).toBe(address);
    }
  });

  it('are plain HMAC-SHA256 under a label written out here a second time', async () => {
    for (const number of [1, 2, 17, 999]) {
      const expected = createHmac('sha256', Buffer.from(ROOT_SEED)).update(`privacycash.fun/wallets/v1/${number}`).digest('hex');
      expect(hex(await derivedSeed(ROOT_SEED, number))).toBe(expected);
    }
  });

  it('are the wallets the Rings SDK signs with', async () => {
    for (const number of [1, 2, 3]) {
      const seed = await derivedSeed(ROOT_SEED, number);
      expect(ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(new Uint8Array(seed) as never)).toSolanaSigner().address).toBe(DERIVED[number]?.[1]);
    }
  });

  it('never land on the first wallet, on each other, or on a prvmax vault of the first wallet', async () => {
    const vaults = await vaultAddresses(await rootFromSeed(ROOT_SEED));
    const derived = await Promise.all(Array.from({ length: 12 }, (_unused, index) => derivedSeed(ROOT_SEED, index + 1).then(addressOf)));
    expect(new Set([ROOT, ...vaults, ...derived]).size).toBe(1 + vaults.length + derived.length);
  });

  it('refuse a seed or a number that is not one', async () => {
    await expect(async () => derivedSeed(new Uint8Array(31), 1)).rejects.toThrow(KeyringError);
    for (const bad of [0, -1, 1.5, 1000, Number.NaN]) await expect(async () => derivedSeed(ROOT_SEED, bad)).rejects.toThrow(/numbered 1 to 999/);
  });
});

describe('an imported wallet’s sealed seed', () => {
  const address = addressOf(OTHER_SEED);

  it('opens again with the same first wallet, and only for the same address', async () => {
    const sealed = await sealSeed(ROOT_SEED, OTHER_SEED, address);
    expect(sealed.ciphertext).not.toContain(Buffer.from(OTHER_SEED).toString('base64').slice(0, 12));
    expect(hex(await openSeed(ROOT_SEED, sealed, address))).toBe(hex(OTHER_SEED));
    await expect(openSeed(ROOT_SEED, sealed, ROOT)).rejects.toThrow(/could not be opened/);
    await expect(openSeed(OTHER_SEED, sealed, address)).rejects.toThrow(KeyringError);
  });

  it('is sealed freshly every time, and does not open once altered', async () => {
    const one = await sealSeed(ROOT_SEED, OTHER_SEED, address);
    const two = await sealSeed(ROOT_SEED, OTHER_SEED, address);
    expect(one.iv).not.toBe(two.iv);
    expect(one.ciphertext).not.toBe(two.ciphertext);
    const bytes = Buffer.from(one.ciphertext, 'base64');
    bytes[3] = (bytes[3] as number) ^ 1;
    await expect(openSeed(ROOT_SEED, { iv: one.iv, ciphertext: bytes.toString('base64') }, address)).rejects.toThrow(KeyringError);
    await expect(openSeed(ROOT_SEED, { iv: one.iv, ciphertext: 'not base64 !' }, address)).rejects.toThrow(KeyringError);
  });

  it('is AES-256-GCM under a key derived from the first wallet’s seed, checked here with another implementation', async () => {
    const key = createHmac('sha256', Buffer.from(ROOT_SEED)).update('privacycash.fun/wallets/v1/import-key').digest();
    expect(key.toString('hex')).toBe('01fba5bae2d35e16b56b407346ad94e276d1a2189fa21dcaf9d2d9f825bb8325');
    // Sealed here, opened by Node.
    const sealed = await sealSeed(ROOT_SEED, OTHER_SEED, address);
    const raw = Buffer.from(sealed.ciphertext, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
    decipher.setAAD(Buffer.from(address, 'utf8'));
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    expect(Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]).toString('hex')).toBe(hex(OTHER_SEED));
    // Sealed by Node, opened here.
    const iv = Buffer.alloc(12, 7);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(address, 'utf8'));
    const body = Buffer.concat([cipher.update(Buffer.from(OTHER_SEED)), cipher.final(), cipher.getAuthTag()]);
    expect(hex(await openSeed(ROOT_SEED, { iv: iv.toString('base64'), ciphertext: body.toString('base64') }, address))).toBe(hex(OTHER_SEED));
  });

  it('refuses a seed that is not one', async () => {
    await expect(sealSeed(ROOT_SEED, new Uint8Array(16), address)).rejects.toThrow(KeyringError);
    await expect(sealSeed(new Uint8Array(8), OTHER_SEED, address)).rejects.toThrow(KeyringError);
  });
});

describe('names', () => {
  it('are trimmed, flattened and cut to length', () => {
    expect(cleanName('  Trading \n\t wallet  ')).toBe('Trading wallet');
    expect(cleanName('a\u0000b\u200bc\u2028d')).toBe('a b c d');
    expect([...cleanName('x'.repeat(80))]).toHaveLength(NAME_MAX);
    expect(cleanName('<b>bold</b>')).toBe('<b>bold</b>');
    for (const empty of ['', '   ', '\u0000\u200b', null, undefined]) expect(() => cleanName(empty)).toThrow(/Give it a name/);
  });
});

describe('the book', () => {
  const sealed = { iv: 'AAAAAAAAAAAAAAAA', ciphertext: 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=' };
  const imported = addressOf(OTHER_SEED);
  const stranger = 'So11111111111111111111111111111111111111112';
  const one = DERIVED[1]?.[1] as string;
  const two = DERIVED[2]?.[1] as string;

  it('starts with the first wallet alone', () => {
    const book = newBook(ROOT, 5);
    expect(book).toEqual({ v: 1, root: ROOT, next: 1, active: ROOT, wallets: [{ address: ROOT, kind: 'root', name: 'Wallet 1', icon: 'auto', createdAt: 5 }], contacts: [] });
    expect(() => newBook('not an address', 5)).toThrow(KeyringError);
    expect(looksLikeAddress(ROOT)).toBe(true);
    for (const bad of ['', 'abc', `${ROOT}0`, 'O0Il'.repeat(10), 42, null]) expect(looksLikeAddress(bad)).toBe(false);
  });

  it('gives each derived wallet the next number and never reuses one', () => {
    let book = withDerived(newBook(ROOT, 1), 1, one, 2);
    book = withDerived(book, 2, two, 3, 'Savings');
    expect(book.next).toBe(3);
    expect(book.wallets.map((wallet) => [wallet.name, wallet.index])).toEqual([['Wallet 1', undefined], ['Wallet 2', 1], ['Savings', 2]]);
    // Taken off the list, it is hidden, not forgotten; the next wallet still gets a new number.
    book = withoutWallet(withActive(book, one), one);
    expect(book.active).toBe(ROOT);
    expect(findWallet(book, one)?.hidden).toBe(true);
    expect(visibleWallets(book).map((wallet) => wallet.address)).toEqual([ROOT, two]);
    expect(book.next).toBe(3);
    expect(nextWalletName(book)).toBe('Wallet 3');
    // Put back, it is the same wallet with the same name.
    const back = withDerived(book, 1, one, 9);
    expect(findWallet(back, one)).toEqual({ address: one, kind: 'derived', index: 1, name: 'Wallet 2', icon: 'auto', createdAt: 2 });
    // The same number can never come to mean another address.
    expect(() => withDerived(book, 1, two, 9)).toThrow(/different address/);
    expect(() => withDerived(book, 3, two, 9)).toThrow(/already on the list/);
    for (const bad of [0, 1000, 2.5]) expect(() => withDerived(book, bad, stranger, 9)).toThrow(KeyringError);
  });

  it('gives a new wallet the lowest number that is free, so that making wallets brings missing ones back in order', () => {
    const three = DERIVED[3]?.[1] as string;
    // On the device where the wallets were made there are no gaps: the lowest free number is the next one.
    let book = newBook(ROOT, 1);
    expect(freeDerivedIndex(book)).toBe(1);
    book = withDerived(withDerived(book, 1, one, 2), 2, two, 3);
    expect(freeDerivedIndex(book)).toBe(3);
    // A wallet taken off the list keeps its number: pressing New wallet does not bring it back.
    expect(freeDerivedIndex(withoutWallet(book, one))).toBe(3);
    // On another device a search found wallets 2 and 3 only. Wallet 1 is what a new wallet becomes.
    let elsewhere = withDerived(withDerived(newBook(ROOT, 1), 2, two, 2), 3, three, 3);
    expect(elsewhere.next).toBe(4);
    expect(freeDerivedIndex(elsewhere)).toBe(1);
    elsewhere = withDerived(elsewhere, 1, one, 4);
    expect(freeDerivedIndex(elsewhere)).toBe(4);
    expect(freeDerivedIndex(elsewhere, 2)).toBe(4);
    expect(freeDerivedIndex(newBook(ROOT, 1), 7)).toBe(7);
    expect(freeDerivedIndex(newBook(ROOT, 1), MAX_DERIVED_INDEX + 1)).toBeNull();
    expect(freeDerivedIndex(newBook(ROOT, 1), -3)).toBe(1);
  });

  it('keeps an imported wallet with its sealed seed, and deletes both when it is removed', () => {
    let book = withImported(newBook(ROOT, 1), imported, sealed, 2, 'From Phantom');
    expect(findWallet(book, imported)).toEqual({ address: imported, kind: 'imported', name: 'From Phantom', icon: 'auto', createdAt: 2, sealed });
    expect(() => withImported(book, imported, sealed, 3)).toThrow(/already on the list/);
    expect(() => withImported(book, ROOT, sealed, 3)).toThrow(/already on the list/);
    book = withoutWallet(book, imported);
    expect(JSON.stringify(book)).not.toContain(sealed.ciphertext);
    expect(findWallet(book, imported)).toBeUndefined();
    // A key that is one of this keyring's own derived wallets is not imported a second time.
    const hidden = withoutWallet(withDerived(newBook(ROOT, 1), 1, one, 2), one);
    expect(() => withImported(hidden, one, sealed, 3)).toThrow(/Put it back/);
  });

  it('never lets the first wallet go, and stops at its limit', () => {
    expect(() => withoutWallet(newBook(ROOT, 1), ROOT)).toThrow(/cannot be removed on its own/);
    expect(() => withoutWallet(newBook(ROOT, 1), stranger)).toThrow(/not on the list/);
    let book: WalletBook = newBook(ROOT, 1);
    for (let index = 1; index < MAX_WALLETS; index += 1) book = withDerived(book, index, addressOf(Uint8Array.from({ length: 32 }, () => index)), index);
    expect(visibleWallets(book)).toHaveLength(MAX_WALLETS);
    expect(() => withDerived(book, MAX_WALLETS, stranger, 1)).toThrow(/up to 24 wallets/);
    expect(() => withImported(book, imported, sealed, 1)).toThrow(/up to 24 wallets/);
  });

  it('renames, changes icons and switches, only for wallets on the list', () => {
    let book = withDerived(newBook(ROOT, 1), 1, one, 2);
    book = withIcon(renamed(book, one, '  Degen   bag '), one, 'skull');
    expect(findWallet(book, one)).toMatchObject({ name: 'Degen bag', icon: 'skull' });
    expect(withActive(book, one).active).toBe(one);
    expect(() => withIcon(book, one, 'unicorn')).toThrow(/not one of the set/);
    expect(() => renamed(book, one, '   ')).toThrow(/Give it a name/);
    expect(() => renamed(book, stranger, 'x')).toThrow(/not on the list/);
    expect(() => withActive(book, stranger)).toThrow(/not on the list/);
    expect(() => withActive(withoutWallet(book, one), one)).toThrow(/not on the list/);
    expect(WALLET_ICONS[0]).toBe('auto');
    expect(new Set(WALLET_ICONS).size).toBe(WALLET_ICONS.length);
  });

  it('never lets two things in it share a name', () => {
    let book = withDerived(newBook(ROOT, 1), 1, one, 2, 'Trading');
    book = withContact(book, stranger, 'Alice');
    // Two wallets, or a wallet and a contact, under one name is how funds get sent to the wrong one.
    expect(() => withDerived(book, 2, two, 3, 'trading')).toThrow(/already used here/);
    expect(() => withDerived(book, 2, two, 3, ' ALICE ')).toThrow(/already used here/);
    expect(() => withImported(book, imported, sealed, 3, 'Wallet 1')).toThrow(/already used here/);
    expect(() => renamed(book, ROOT, 'Trading')).toThrow(/already used here/);
    expect(() => renamed(book, one, 'Alice')).toThrow(/already used here/);
    expect(() => withContact(book, two, 'Trading')).toThrow(/already used here/);
    expect(() => withContact(book, two, 'alice')).toThrow(/already used here/);
    // Keeping its own name, or changing only its case, is not a clash.
    expect(findWallet(renamed(book, one, 'TRADING'), one)?.name).toBe('TRADING');
    expect(withContact(book, stranger, 'Alice', 'moon').contacts[0]).toEqual({ address: stranger, name: 'Alice', icon: 'moon' });
    // A wallet taken off the list keeps its name, so that it can come back as itself.
    const hidden = withoutWallet(book, one);
    expect(() => withDerived(hidden, 2, two, 3, 'Trading')).toThrow(/already used here/);
    // A name nobody chose steps around the ones that are taken, contacts included.
    const crowded = withContact(newBook(ROOT, 1), stranger, 'Wallet 2');
    expect(nextWalletName(crowded)).toBe('Wallet 3');
    expect(findWallet(withDerived(crowded, 1, one, 2), one)?.name).toBe('Wallet 3');
  });

  it('keeps contacts apart from your own wallets', () => {
    let book = withDerived(newBook(ROOT, 1), 1, one, 2);
    book = withContact(book, stranger, ' Alice ', 'cat');
    expect(book.contacts).toEqual([{ address: stranger, name: 'Alice', icon: 'cat' }]);
    expect(withContact(book, stranger, 'Alice B').contacts).toEqual([{ address: stranger, name: 'Alice B', icon: 'auto' }]);
    expect(() => withContact(book, one, 'Mine')).toThrow(/one of your own wallets/);
    expect(() => withContact(book, 'nope', 'x')).toThrow(/not a Solana address/);
    expect(nameOf(book, stranger)).toEqual({ name: 'Alice', icon: 'cat', own: false });
    expect(nameOf(book, one)).toEqual({ name: 'Wallet 2', icon: 'auto', own: true });
    expect(nameOf(book, two)).toBeNull();
    // A contact that turns out to be one of your wallets stops being a contact.
    expect(withDerived(withContact(newBook(ROOT, 1), two, 'Was a contact'), 2, two, 3).contacts).toEqual([]);
    expect(withoutContact(book, stranger).contacts).toEqual([]);
    let full: WalletBook = newBook(ROOT, 1);
    for (let index = 0; index < MAX_CONTACTS; index += 1) full = withContact(full, addressOf(Uint8Array.from({ length: 32 }, (_unused, at) => (at === 0 ? index : 9))), `C${index}`);
    expect(() => withContact(full, stranger, 'One too many')).toThrow(/up to 100 contacts/);
  });

  it('survives being stored and read back', () => {
    let book = withDerived(newBook(ROOT, 1), 1, one, 2, 'Trading');
    book = withImported(book, imported, sealed, 3);
    book = withContact(withActive(withIcon(book, one, 'moon'), one), stranger, 'Alice');
    expect(parseBook(JSON.stringify(book), ROOT, 99)).toEqual(book);
  });

  it('reads a damaged or foreign book as a fresh one, and drops only what is not an entry', () => {
    const fresh = newBook(ROOT, 7);
    for (const raw of [null, '', 'not json', '[]', '{"root":"someone else"}', JSON.stringify({ ...fresh, root: stranger })]) expect(parseBook(raw, ROOT, 7)).toEqual(fresh);
    const messy = {
      v: 1,
      root: ROOT,
      next: 1,
      active: two,
      wallets: [
        { address: one, kind: 'derived', index: 1, name: 'Kept', icon: 'ghost', createdAt: 3 },
        { address: two, kind: 'derived', index: 1, name: 'Same number twice', icon: 'auto', createdAt: 3 },
        { address: one, kind: 'derived', index: 2, name: 'Same address twice', icon: 'auto', createdAt: 3 },
        { address: imported, kind: 'imported', name: 'No seed', icon: 'auto', createdAt: 3 },
        { address: stranger, kind: 'imported', name: '\u0000', icon: 'unicorn', createdAt: 'x', sealed },
        { address: ROOT, kind: 'derived', index: 5, name: 'Pretends to be derived', icon: 'auto', createdAt: 3 },
        { address: 'nope', kind: 'derived', index: 6, name: 'Bad address', icon: 'auto', createdAt: 3 },
        null,
        'text',
      ],
      contacts: [{ address: one, name: 'Own wallet as contact' }, { address: two, name: '  Bob  ', icon: 'star' }, { address: two, name: 'Bob again' }, { name: 'No address' }],
    };
    const read = parseBook(JSON.stringify(messy), ROOT, 7);
    expect(read.wallets).toEqual([
      { address: ROOT, kind: 'root', name: 'Wallet 1', icon: 'auto', createdAt: 7 },
      { address: one, kind: 'derived', index: 1, name: 'Kept', icon: 'ghost', createdAt: 3 },
      { address: stranger, kind: 'imported', name: 'Wallet', icon: 'auto', createdAt: 7, sealed },
    ]);
    // The wallet marked as in use was dropped, so the first wallet is in use; numbering goes on above what was read.
    expect(read.active).toBe(ROOT);
    expect(read.next).toBe(2);
    expect(read.contacts).toEqual([{ address: two, name: 'Bob', icon: 'star' }]);
  });

  it('keeps the first wallet’s own name and icon', () => {
    const book = withIcon(renamed(newBook(ROOT, 1), ROOT, 'Main'), ROOT, 'crown');
    expect(parseBook(JSON.stringify(book), ROOT, 9).wallets[0]).toEqual({ address: ROOT, kind: 'root', name: 'Main', icon: 'crown', createdAt: 1 });
  });
});

describe('looking for wallets made on another device', () => {
  const sealed = { iv: 'AAAAAAAAAAAAAAAA', ciphertext: 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=' };
  /** The real derivation, so the addresses found are the ones a browser would find. */
  const addressAt = async (index: number): Promise<string> => addressOf(await derivedSeed(ROOT_SEED, index));
  const addresses = async (...indexes: number[]): Promise<string[]> => Promise.all(indexes.map(addressAt));
  /** A chain on which something once happened at these numbers' addresses, and a record of what was asked. */
  const chain = async (...indexes: number[]) => {
    const touched = new Set(await addresses(...indexes));
    const asked: string[] = [];
    return {
      asked,
      used: async (candidate: string): Promise<boolean> => {
        asked.push(candidate);
        return touched.has(candidate);
      },
    };
  };

  it('finds every wallet that was ever used, and stops eight numbers past the last one', async () => {
    const { used, asked } = await chain(1, 2, 5);
    const search = await searchDerived(newBook(ROOT, 1), addressAt, used, 7);
    expect(search.failure).toBeUndefined();
    expect(search.found).toBe(3);
    expect(search.book.wallets.filter((wallet) => wallet.kind === 'derived').map((wallet) => [wallet.index, wallet.address, wallet.name])).toEqual([
      [1, DERIVED[1]?.[1], 'Wallet 2'],
      [2, DERIVED[2]?.[1], 'Wallet 3'],
      [5, await addressAt(5), 'Wallet 4'],
    ]);
    expect(search.book.next).toBe(6);
    // Numbers 1 to 13 were asked about: 5 was the last hit, and eight quiet ones follow it.
    expect(asked).toEqual(await addresses(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13));
    // Nothing more is found the second time, and nothing is changed.
    const again = await searchDerived(search.book, addressAt, used, 8);
    expect(again.found).toBe(0);
    expect(again.book).toBe(search.book);
  });

  it('finds nothing on a chain where nothing happened, after eight numbers', async () => {
    const { used, asked } = await chain();
    const book = newBook(ROOT, 1);
    const search = await searchDerived(book, addressAt, used, 7);
    expect(search).toEqual({ book, found: 0 });
    expect(asked).toHaveLength(8);
  });

  it('looks into the gaps below the highest number it knows', async () => {
    const start = withDerived(newBook(ROOT, 1), 3, await addressAt(3), 2);
    const { used, asked } = await chain(1);
    const search = await searchDerived(start, addressAt, used, 7);
    expect(search.found).toBe(1);
    expect(search.book.wallets.map((wallet) => wallet.index)).toEqual([undefined, 3, 1]);
    // 1 and 2 are gaps; 3 is known and not asked about; 4 to 11 are the eight past it.
    expect(asked).toEqual(await addresses(1, 2, 4, 5, 6, 7, 8, 9, 10, 11));
  });

  it('leaves alone what is already there: a wallet taken off the list, and one imported by its own key', async () => {
    const one = await addressAt(1);
    const two = await addressAt(2);
    let start = withoutWallet(withDerived(newBook(ROOT, 1), 1, one, 2), one);
    start = withImported(start, two, sealed, 3, 'By its own key');
    const { used, asked } = await chain(1, 2, 3);
    const search = await searchDerived(start, addressAt, used, 7);
    expect(search.found).toBe(1);
    expect(findWallet(search.book, one)?.hidden).toBe(true);
    expect(findWallet(search.book, two)?.kind).toBe('imported');
    expect(findWallet(search.book, await addressAt(3))?.index).toBe(3);
    expect(asked).not.toContain(one);
    expect(asked).not.toContain(two);
  });

  it('keeps what it found when the chain stops answering, and says that it stopped', async () => {
    const { used } = await chain(1, 2);
    let calls = 0;
    const flaky = async (candidate: string): Promise<boolean> => {
      calls += 1;
      if (calls === 3) throw new Error('The network did not answer.');
      return used(candidate);
    };
    const search = await searchDerived(newBook(ROOT, 1), addressAt, flaky, 7);
    expect(search.found).toBe(2);
    expect(visibleWallets(search.book)).toHaveLength(3);
    expect((search.failure as Error).message).toBe('The network did not answer.');
  });

  it('stops at a full list without losing or replacing anything', async () => {
    let full: WalletBook = newBook(ROOT, 1);
    for (let index = 1; index < MAX_WALLETS - 1; index += 1) full = withDerived(full, index, await addressAt(index), index);
    expect(visibleWallets(full)).toHaveLength(MAX_WALLETS - 1);
    const { used } = await chain(23, 24, 25);
    const search = await searchDerived(full, addressAt, used, 7);
    // One place was left: the lowest of the three takes it, and the search ends there.
    expect(search.found).toBe(1);
    expect(search.failure).toBeUndefined();
    expect(visibleWallets(search.book)).toHaveLength(MAX_WALLETS);
    expect(findWallet(search.book, await addressAt(23))?.index).toBe(23);
    expect(findWallet(search.book, await addressAt(24))).toBeUndefined();
  });
});
