import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { MINT_SIZE, MintLayout, TOKEN_PROGRAM_ID } from '@solana/spl-token';

import { Store } from '../server/src/db.js';
import { readPageRequest, tokenPage } from '../server/src/listing.js';
import { MARKET_PAGE_SIZE } from '../shared/src/api.js';
import { INITIAL_SUPPLY_UNITS, burnedUnits, mintSupply } from '../shared/src/meteora.js';

const CONFIG_A = 'A'.repeat(43);
const CONFIG_B = 'B'.repeat(43);
const DAY = 86_400_000;

function row(mint: string, config: string, overrides: Record<string, unknown> = {}) {
  return {
    mint,
    pool: `pool-${mint}`,
    config,
    fee_bps: 300,
    creator: 'creator',
    name: `Token ${mint}`,
    symbol: mint.toUpperCase(),
    uri: '',
    stage: 'curve',
    price_sol: '0.00000003',
    market_cap_sol: '30',
    progress: 0.1,
    reserve_lamports: '1000000000',
    threshold_lamports: '88576623265',
    fee_lamports: '30000000',
    ...overrides,
  };
}

describe('the listing store', () => {
  let directory: string;
  let store: Store;
  const now = Date.now();

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'pcf-store-'));
    store = new Store(directory);
    store.upsertToken(row('one', CONFIG_A), now - 3 * DAY);
    store.upsertToken(row('two', CONFIG_A, { stage: 'graduated', reserve_lamports: '88576623265', fee_lamports: '900000000' }), now - 2 * DAY);
    store.upsertToken(row('old', CONFIG_B), now - 5 * DAY);
    store.upsertToken(row('new', CONFIG_A), now - 60_000);
  });

  afterAll(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('serves everything until it is told which configs are the platform\'s', () => {
    expect(store.tokens().map((token) => token.mint).sort()).toEqual(['new', 'old', 'one', 'two']);
  });

  it('lists only tokens under the current configs, and keeps the rest stored', () => {
    store.setListedConfigs([CONFIG_A]);
    expect(store.tokens().map((token) => token.mint)).toEqual(['new', 'two', 'one']);
    expect(store.allTokens().map((token) => token.mint)).toEqual(['one', 'two', 'new']);
    expect(store.token('old')).toBeUndefined();
    expect(store.token('one')?.symbol).toBe('ONE');
    expect(store.knownMints().has('old')).toBe(true);
    store.setListedConfigs([CONFIG_A, CONFIG_B]);
    expect(store.token('old')?.config).toBe(CONFIG_B);
    store.setListedConfigs([]);
    expect(store.tokens()).toEqual([]);
    expect(store.totals().tokens).toBe(0);
    store.setListedConfigs([CONFIG_A]);
  });

  it('adds up the front-page totals over listed tokens only', () => {
    expect(store.totals()).toEqual({
      tokens: 3,
      graduated: 1,
      reserveLamports: '2000000000', // the two tokens still on their curves
      volumeLamports: '32000000000', // 0.96 SOL of fees since launch, at 3%: 32 SOL traded
      volume24hLamports: '0',
      feeLamports: '960000000',
    });
  });

  it('measures 24-hour volume from the right baseline', () => {
    // An old token with history: the snapshot at or before the mark.
    store.addSnapshot('one', now - 2 * DAY, '0.00000003', '10000000');
    store.addSnapshot('one', now - DAY - 60_000, '0.00000003', '20000000');
    store.addSnapshot('one', now - 3_600_000, '0.00000003', '29000000');
    expect(store.feeAt('one', now - DAY)).toBe('20000000');
    // A token first seen inside the window had taken no fees before it: baseline zero.
    store.addSnapshot('new', now - 30_000, '0.00000003', '30000000');
    expect(store.feeAt('new', now - DAY)).toBe('0');
    // An old token whose history starts late falls back to its oldest snapshot.
    store.addSnapshot('two', now - 3_600_000, '0.00000042', '850000000');
    expect(store.feeAt('two', now - DAY)).toBe('850000000');
    expect(store.feeAt('nobody', now - DAY)).toBeUndefined();
  });

  it('keeps a token\'s identity when a later pass has no name to offer', () => {
    store.upsertToken(row('one', CONFIG_A, { name: '', symbol: '', price_sol: '0.00000004' }), now);
    const token = store.token('one');
    expect(token?.name).toBe('Token one');
    expect(token?.price_sol).toBe('0.00000004');
    expect(token?.created_at).toBe(now - 3 * DAY);
  });

  it('rolls a batch back when any write in it fails', () => {
    expect(() =>
      store.transaction(() => {
        store.setVolume('one', '123');
        throw new Error('stop');
      }),
    ).toThrow('stop');
    expect(store.token('one')?.volume_24h_lamports).toBe('0');
    store.transaction(() => store.setVolume('one', '456'));
    expect(store.token('one')?.volume_24h_lamports).toBe('456');
  });
});

describe('the market, a page at a time', () => {
  let directory: string;
  let store: Store;
  const now = Date.now();
  // Thirty tokens under the platform's config: t01 is the oldest, t30 the newest.
  const names = Array.from({ length: 30 }, (_, index) => `t${String(index + 1).padStart(2, '0')}`);

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'pcf-pages-'));
    store = new Store(directory);
    names.forEach((name, index) => {
      store.upsertToken(row(name, CONFIG_A, { name: `Ghost ${name}`, creator: index % 2 === 0 ? 'even' : 'odd', market_cap_sol: String(30 + index), progress: index / 100 }), now - (30 - index) * 60_000);
      store.setVolume(name, String((index % 7) * 1_000_000_000));
    });
    store.upsertToken(row('other', CONFIG_B, { name: 'Ghost elsewhere' }), now);
    store.upsertToken(row('pct', CONFIG_A, { name: '100% real', symbol: 'A_B' }), now - 3_600_000);
    store.setListedConfigs([CONFIG_A]);
  });

  afterAll(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('serves twelve at a time and says how many there are in all', () => {
    const first = store.tokenPage({ page: 1, size: 12, sort: 'new' });
    expect(first.total).toBe(31);
    expect(first.rows.map((token) => token.mint)).toEqual([...names].reverse().slice(0, 12));
    const third = store.tokenPage({ page: 3, size: 12, sort: 'new' });
    expect(third.rows).toHaveLength(7);
    expect(store.tokenPage({ page: 4, size: 12, sort: 'new' }).rows).toEqual([]);
    // Every token appears on exactly one page.
    const seen = [1, 2, 3].flatMap((page) => store.tokenPage({ page, size: 12, sort: 'new' }).rows.map((token) => token.mint));
    expect(new Set(seen).size).toBe(31);
  });

  it('leaves out tokens that are not under the platform’s configs', () => {
    expect(store.tokenPage({ page: 1, size: 48, sort: 'new' }).rows.some((token) => token.mint === 'other')).toBe(false);
    expect(store.tokenPage({ page: 1, size: 12, sort: 'new', query: 'elsewhere' }).total).toBe(0);
  });

  it('orders by market cap, by volume and by graduation, as numbers', () => {
    expect(store.tokenPage({ page: 1, size: 3, sort: 'cap' }).rows.map((token) => token.mint)).toEqual(['t30', 't29', 't28']);
    expect(store.tokenPage({ page: 1, size: 3, sort: 'graduation' }).rows.map((token) => token.mint)).toEqual(['t30', 't29', 't28']);
    // Volume is what was traded since launch: the fees a token has taken over its fee rate. Fees are stored as
    // text: 1 SOL of them must sort above 0.9 SOL, which text ordering would get wrong.
    store.upsertToken(row('t01', CONFIG_A, { name: 'Ghost t01', creator: 'even', market_cap_sol: '30', progress: 0, fee_lamports: '1000000000' }), now);
    store.upsertToken(row('t02', CONFIG_A, { name: 'Ghost t02', creator: 'odd', market_cap_sol: '31', progress: 0.01, fee_lamports: '900000000' }), now);
    const byVolume = store.tokenPage({ page: 1, size: 3, sort: 'volume' }).rows.map((token) => token.mint);
    // The rest have all traded the same, so the newest of them is next.
    expect(byVolume).toEqual(['t01', 't02', 't30']);
    // Hot is the last day's volume first, also as a number: 10 SOL above 9 SOL.
    store.setVolume('t03', '10000000000');
    store.setVolume('t04', '9000000000');
    const hot = store.tokenPage({ page: 1, size: 5, sort: 'hot' }).rows.map((token) => token.mint);
    expect(hot.slice(0, 2)).toEqual(['t03', 't04']);
    // Then four that traded 6 SOL each in the last day and the same since launch: the newer first.
    expect(hot.slice(2)).toEqual(['t28', 't21', 't14']);
  });

  it('searches tickers and names anywhere, addresses from the start, whatever the case', () => {
    expect(store.tokenPage({ page: 1, size: 12, sort: 'new', query: 'GHOST T0' }).total).toBe(9);
    expect(store.tokenPage({ page: 1, size: 12, sort: 'new', query: 't17' }).rows.map((token) => token.mint)).toEqual(['t17']);
    expect(store.tokenPage({ page: 1, size: 12, sort: 'new', query: '  T17 ' }).total).toBe(1);
    expect(store.tokenPage({ page: 1, size: 12, sort: 'new', query: 'nothing like it' }).total).toBe(0);
    // The search characters % and _ mean themselves.
    expect(store.tokenPage({ page: 1, size: 12, sort: 'new', query: '100%' }).rows.map((token) => token.mint)).toEqual(['pct']);
    expect(store.tokenPage({ page: 1, size: 12, sort: 'new', query: 'a_b' }).rows.map((token) => token.mint)).toEqual(['pct']);
    expect(store.tokenPage({ page: 1, size: 12, sort: 'new', query: '%' }).total).toBe(1);
    expect(store.tokenPage({ page: 1, size: 12, sort: 'new', query: "'; DROP TABLE tokens; --" }).total).toBe(0);
    expect(store.tokenPage({ page: 1, size: 12, sort: 'new' }).total).toBe(31);
  });

  it('bounds the page size and the page number it is asked for', () => {
    expect(store.tokenPage({ page: 1, size: 1000, sort: 'new' }).rows).toHaveLength(31);
    expect(store.tokenPage({ page: 0, size: 12, sort: 'new' }).rows).toHaveLength(12);
    expect(store.tokenPage({ page: -4, size: 0, sort: 'new' }).rows).toHaveLength(1);
  });

  it('never serves more than twenty-four to a page, whatever it is asked for', () => {
    const summary = (token: { mint: string }) => ({ mint: token.mint }) as never;
    expect(MARKET_PAGE_SIZE).toBe(24);
    for (const size of ['48', '25', '1000', '0', '-3', 'lots', '']) {
      const request = readPageRequest({ size });
      expect(request.size, size).toBe(24);
      expect(tokenPage(store, request, summary).tokens, size).toHaveLength(24);
    }
    // A smaller page may be asked for.
    const five = tokenPage(store, readPageRequest({ size: '5' }), summary);
    expect(five).toMatchObject({ size: 5, pages: 7, total: 31 });
    expect(five.tokens).toHaveLength(5);
    // An array or an object where a value was expected is not taken as one.
    expect(readPageRequest({ size: ['48'], page: { a: 1 }, sort: 7, q: null })).toEqual({ page: 1, size: 24, sort: 'hot', query: '', pair: '' });
  });

  it('reads the page, the order and the search, and defaults what it cannot use', () => {
    expect(readPageRequest({})).toEqual({ page: 1, size: 24, sort: 'hot', query: '', pair: '' });
    expect(readPageRequest({ page: '3', sort: 'cap', q: '  ghost ' })).toEqual({ page: 3, size: 24, sort: 'cap', query: 'ghost', pair: '' });
    expect(readPageRequest({ page: '0', sort: 'best' })).toEqual({ page: 1, size: 24, sort: 'hot', query: '', pair: '' });
    expect(readPageRequest({ page: '99999999' }).page).toBe(1);
    expect(readPageRequest({ q: 'x'.repeat(300) }).query).toHaveLength(64);
  });

  it('answers a page past the end with the last page, and says which page that is', () => {
    const summary = (token: { mint: string }) => ({ mint: token.mint }) as never;
    const first = tokenPage(store, readPageRequest({ sort: 'new' }), summary);
    expect(first).toMatchObject({ page: 1, pages: 2, total: 31, size: 24 });
    const past = tokenPage(store, readPageRequest({ page: '40', sort: 'new' }), summary);
    expect(past).toMatchObject({ page: 2, pages: 2, total: 31 });
    expect(past.tokens).toHaveLength(7);
    // The two pages together are the whole list, each token once.
    const all = [1, 2].flatMap((page) => tokenPage(store, readPageRequest({ page: String(page), sort: 'new' }), summary).tokens.map((token) => token.mint));
    expect(new Set(all).size).toBe(31);
    // A smaller page still turns as it did: three of twelve.
    const twelve = tokenPage(store, readPageRequest({ page: '40', sort: 'new', size: '12' }), summary);
    expect(twelve).toMatchObject({ page: 3, pages: 3, total: 31, size: 12 });
    // A search with no match is one empty page, not an error.
    expect(tokenPage(store, readPageRequest({ q: 'nothing like it', page: '5' }), summary)).toEqual({ tokens: [], total: 0, page: 1, pages: 1, size: 24 });
  });

  it('looks tokens up by mint and by creator, for a wallet', () => {
    expect(store.tokensByMints(['t03', 't30', 'unknown', 'other']).map((token) => token.mint).sort()).toEqual(['t03', 't30']);
    expect(store.tokensByMints([])).toEqual([]);
    const mine = store.tokensByCreator('even');
    expect(mine).toHaveLength(15);
    expect(mine[0]?.mint).toBe('t29');
    expect(store.tokensByCreator('nobody')).toEqual([]);
  });
});

describe('a token’s supply', () => {
  it('is kept when a later pass could not read it, and replaced when it could', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pcf-supply-'));
    const store = new Store(directory);
    store.upsertToken({ ...row('burny', CONFIG_A), supply: '1000000000000000' }, 1);
    expect(store.token('burny')?.supply).toBe('1000000000000000');
    store.upsertToken(row('burny', CONFIG_A), 2);
    expect(store.token('burny')?.supply).toBe('1000000000000000');
    store.upsertToken({ ...row('burny', CONFIG_A), supply: '999000000000000' }, 3);
    expect(store.token('burny')?.supply).toBe('999000000000000');
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('is added to a database made before supplies were tracked', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pcf-old-'));
    const old = new DatabaseSync(join(directory, 'privacycash.sqlite'));
    old.exec(`CREATE TABLE tokens (mint TEXT PRIMARY KEY, pool TEXT NOT NULL, config TEXT NOT NULL, fee_bps INTEGER NOT NULL, creator TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', symbol TEXT NOT NULL DEFAULT '', uri TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', image TEXT NOT NULL DEFAULT '', website TEXT NOT NULL DEFAULT '', twitter TEXT NOT NULL DEFAULT '', stage TEXT NOT NULL DEFAULT 'curve', price_sol TEXT NOT NULL DEFAULT '0', market_cap_sol TEXT NOT NULL DEFAULT '0', progress REAL NOT NULL DEFAULT 0, reserve_lamports TEXT NOT NULL DEFAULT '0', threshold_lamports TEXT NOT NULL DEFAULT '0', fee_lamports TEXT NOT NULL DEFAULT '0', volume_24h_lamports TEXT NOT NULL DEFAULT '0', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
    old.prepare('INSERT INTO tokens (mint, pool, config, fee_bps, creator, name, symbol, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('prv', 'pool', CONFIG_A, 300, 'creator', 'privacyCASH', 'PRV', 1, 1);
    old.close();
    const store = new Store(directory);
    expect(store.token('prv')).toMatchObject({ symbol: 'PRV', supply: '' });
    store.upsertToken({ ...row('prv', CONFIG_A), supply: '5' }, 2);
    expect(store.token('prv')?.supply).toBe('5');
    // Opening it again changes nothing.
    store.close();
    const again = new Store(directory);
    expect(again.token('prv')?.supply).toBe('5');
    again.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('is read from a mint account, and from nothing else', () => {
    const data = Buffer.alloc(MINT_SIZE);
    MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 987_654_321_000_000n, decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, data);
    expect(mintSupply({ owner: TOKEN_PROGRAM_ID, data })).toBe(987_654_321_000_000n);
    expect(mintSupply(null)).toBeNull();
    expect(mintSupply({ owner: Keypair.generate().publicKey, data })).toBeNull();
    expect(mintSupply({ owner: TOKEN_PROGRAM_ID, data: Buffer.alloc(165) })).toBeNull();
  });

  it('says how much has been burned', () => {
    expect(INITIAL_SUPPLY_UNITS).toBe(1_000_000_000_000_000n);
    expect(burnedUnits(INITIAL_SUPPLY_UNITS)).toBe(0n);
    expect(burnedUnits(INITIAL_SUPPLY_UNITS - 1_500_000n)).toBe(1_500_000n);
    expect(burnedUnits(0n)).toBe(INITIAL_SUPPLY_UNITS);
    expect(burnedUnits(null)).toBe(0n);
    expect(burnedUnits(undefined)).toBe(0n);
    expect(burnedUnits(INITIAL_SUPPLY_UNITS + 5n)).toBe(0n);
  });
});
