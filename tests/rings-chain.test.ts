/**
 * The explorer's reads against the real Rings SDK client, with the network
 * replaced by canned answers. `tests/rings.test.ts` drives the indexer with a
 * scripted chain; this file is what holds the adapter itself to the shapes
 * the pinned SDK really returns.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Connection, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { getTreeAddress } from '@heliuslabs/spr/addresses';

import { RingRpcError, createRingChain } from '../server/src/rings/chain.js';
import { RING_READER, RingStore } from '../server/src/rings/store.js';
import { type SignatureLookup, UnreadableTag, otherWallets, tagText, taggedEvents } from '../shared/src/ring-tags.js';

const RPC = 'http://127.0.0.1:1/rpc';
const SPR = 'http://127.0.0.1:1/v1/spr';
const SIGNATURE = bs58.encode(Uint8Array.from({ length: 64 }, (_unused, index) => (index * 7 + 3) % 251));
const hash = (seed: number): string => bs58.encode(Uint8Array.from({ length: 32 }, (_unused, index) => (index + seed) % 256));
const wallet = (): string => Keypair.generate().publicKey.toBase58();

/** One output of a Rings event, as the indexer writes it on the wire. */
function wireSlot(tag: string, leaf: number): unknown {
  return { viewTag: tag, outputContext: { treeId: 0, hash: hash(leaf), tree: String(getTreeAddress(0)), leafIndex: leaf }, payload: Buffer.from('ciphertext').toString('base64') };
}

function wireEvent(eventIndex: number, tags: readonly string[], extra: Record<string, unknown> = {}): unknown {
  return {
    eventIndex,
    transaction: { slot: 300_000_000, txSignature: SIGNATURE, eventIndex, outputSlots: tags.map((tag, index) => wireSlot(tag, eventIndex * 10 + index)), messages: [], nullifiers: [hash(1), hash(2)], proofless: false, ...extra },
  };
}

/** Answers every request the SDK's client makes with `result`, and keeps what was asked. */
function indexerAnswers(result: unknown): Array<{ url: string; method: string }> {
  const asked: Array<{ url: string; method: string }> = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = JSON.parse(String(init?.body)) as { id?: unknown; method?: string };
    asked.push({ url, method: body.method ?? '' });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id ?? 1, result }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  return asked;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const chain = (fetcher?: typeof fetch) => createRingChain({ rpcUrl: RPC, sprUrl: SPR, connection: new Connection(RPC), ...(fetcher ? { fetch: fetcher } : {}) });

describe('the events of a transaction, through the real SDK client', () => {
  it('writes each output tag as the address it is', async () => {
    const alice = wallet();
    const bob = wallet();
    const asked = indexerAnswers({ context: { blockTime: 1_764_000_000, slot: 300_000_000 }, transactions: [wireEvent(0, [bob, alice])] });
    const events = await chain().events(SIGNATURE);
    expect(asked).toEqual([{ url: `${SPR}/getShieldedTransactionsBySignature`, method: 'getShieldedTransactionsBySignature' }]);
    expect(events).toEqual([{ tags: [bob, alice], nullifiers: 2, proofless: false, ring: null }]);
  });

  it('keeps the events of one transaction in the order they happened', async () => {
    const [trader, desk] = [wallet(), wallet()];
    indexerAnswers({ context: { blockTime: 1_764_000_000, slot: 300_000_000 }, transactions: [wireEvent(1, [trader, desk]), wireEvent(0, [desk, trader])] });
    const events = await chain().events(SIGNATURE);
    expect(events?.map((event) => event.tags)).toEqual([
      [desk, trader],
      [trader, desk],
    ]);
  });

  it('names the ring of an event that was not on the Default Ring', async () => {
    const ring = wallet();
    indexerAnswers({ context: { blockTime: 1_764_000_000, slot: 300_000_000 }, transactions: [wireEvent(0, [hash(40)], { ringConfig: ring })] });
    const events = await chain().events(SIGNATURE);
    expect(events?.[0]?.ring).toBe(ring);
  });

  it('answers null when the indexer has nothing for the transaction yet', async () => {
    indexerAnswers({ context: { blockTime: 1_764_000_000, slot: 300_000_000 }, transactions: [] });
    expect(await chain().events(SIGNATURE)).toBeNull();
  });
});

describe('output tags', () => {
  it('reads 32 bytes as an address, and leaves an address as it is', () => {
    const key = Keypair.generate().publicKey;
    expect(tagText(new Uint8Array(key.toBytes()))).toBe(key.toBase58());
    expect(tagText(key.toBase58())).toBe(key.toBase58());
  });

  it('refuses anything else, the list of numbers String() makes of bytes included', () => {
    expect(() => tagText(String(new Uint8Array(32)))).toThrow(UnreadableTag);
    expect(() => tagText(new Uint8Array(31))).toThrow(UnreadableTag);
    expect(() => tagText(undefined)).toThrow(UnreadableTag);
  });

  it('lists the other wallets of a transaction once each, and never reads another ring as addresses', () => {
    const [me, other, third] = [wallet(), wallet(), wallet()];
    const lookup: SignatureLookup = {
      transactions: [
        { eventIndex: 0, transaction: { outputSlots: [{ viewTag: other }, { viewTag: me }], nullifiers: [1], proofless: false } },
        { eventIndex: 1, transaction: { outputSlots: [{ viewTag: me }, { viewTag: other }], nullifiers: [1], proofless: false } },
        { eventIndex: 2, transaction: { outputSlots: [{ viewTag: third }], nullifiers: [1], proofless: false, ringProgramId: wallet() } },
      ],
    };
    expect(otherWallets(taggedEvents(lookup), me)).toEqual([other]);
    expect(otherWallets([], me)).toEqual([]);
  });
});

describe('a raw transaction, through the adapter', () => {
  const answer = (body: unknown): typeof fetch => (async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;

  it('hands a transaction on, and answers null for one the RPC does not have', async () => {
    const raw = { slot: 5, blockTime: 1_764_000_000, transaction: ['AAAA', 'base64'], meta: { err: null, fee: 5000, preBalances: [], postBalances: [] } };
    expect(await chain(answer({ jsonrpc: '2.0', id: 1, result: raw })).transaction(SIGNATURE)).toEqual(raw);
    expect(await chain(answer({ jsonrpc: '2.0', id: 1, result: null })).transaction(SIGNATURE)).toBeNull();
  });

  it('refuses an answer that is not a transaction', async () => {
    await expect(chain(answer({ jsonrpc: '2.0', id: 1, result: { slot: '5' } })).transaction(SIGNATURE)).rejects.toThrow(RingRpcError);
  });

  it('asks again with a higher version when the RPC says the transaction needs one, in either wording', async () => {
    for (const message of [
      'Transaction version (2) is not supported by the requesting client. Please try the request again with the following configuration parameter: "maxSupportedTransactionVersion": 2',
      'Transaction version (2) is not supported by the requesting client. Please try the request again with maxSupportedTransactionVersion set to 2',
    ]) {
      const versions: unknown[] = [];
      const raw = { slot: 5, transaction: ['AAAA', 'base64'], meta: null };
      const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { params: [string, { maxSupportedTransactionVersion: number }] };
        versions.push(body.params[1].maxSupportedTransactionVersion);
        const result = body.params[1].maxSupportedTransactionVersion >= 2 ? { result: raw } : { error: { code: -32015, message } };
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, ...result }), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch;
      expect(await chain(fetcher).transaction(SIGNATURE)).toEqual(raw);
      expect(versions).toEqual([1, 2]);
    }
  });

  it('reads token names from the answer of getAssetBatch', async () => {
    const mint = wallet();
    const names = await chain(answer({ jsonrpc: '2.0', id: 1, result: [{ id: mint, content: { metadata: { name: 'Ghost', symbol: 'GHO' } } }, null, { id: 7 }] })).names([mint]);
    expect([...names.entries()]).toEqual([[mint, { symbol: 'GHO', name: 'Ghost' }]]);
  });
});

describe('rows an earlier release read differently', () => {
  const row = (signature: string, recipients: string[]) => ({ signature, slot: 5, at: 1_764_000_000_000, kind: 'transfer' as const, payer: 'payer', senders: ['payer'], recipients, legs: [], via: [], ring: null, partial: false });

  it('are dropped once, with the marks of how far history was read, and tokens are kept', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pcf-rings-reader-'));
    const store = new RingStore(directory);
    try {
      // What release v21 would have left: a recipient written as a list of numbers, and history marked as read.
      store.save(row('old', [String(new Uint8Array(32))]));
      store.setMeta('head', 'old');
      store.setMeta('tail', 'old');
      store.setMeta('tailDone', '1');
      store.setMeta('wallets', '12');
      store.addAssets([{ mint: 'mint', assetId: '7', vault: 'vault' }], 1);
      expect(store.count()).toBe(1);

      expect(store.startOver()).toBe(true);
      expect(store.count()).toBe(0);
      expect(store.addressRows('payer', 10)).toEqual([]);
      expect([store.meta('head'), store.meta('tail'), store.meta('tailDone')]).toEqual([undefined, undefined, undefined]);
      expect(store.meta('reader')).toBe(String(RING_READER));
      // What does not depend on how a transaction is read stays.
      expect(store.meta('wallets')).toBe('12');
      expect(store.asset('mint')?.vault).toBe('vault');

      // From here on rows are this reader's: nothing more is dropped, on this start or any later one.
      store.save(row('new', ['recipient']));
      expect(store.startOver()).toBe(false);
      expect(store.count()).toBe(1);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('are not looked for in a database that starts empty', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pcf-rings-reader-'));
    const store = new RingStore(directory);
    try {
      expect(store.startOver()).toBe(false);
      expect(store.meta('reader')).toBe(String(RING_READER));
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
