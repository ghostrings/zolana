import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backfillAssetRegistry } from '@heliuslabs/spr/wallet';

import { SPP_PROGRAM_ID } from '../shared/src/constants.js';
import { readEnv } from '../server/src/env.js';
import { RateLimiter } from '../server/src/http.js';
import { RINGS_REGISTRY_SCAN, checkCall, countScans, proxyRouter } from '../server/src/proxy.js';

const METEORA_DBC = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';
const METEORA_DAMM = 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG';
const USER_REGISTRY = 'regi8Zf6R6kRkC7bq7b1qgqzR7m2G3c3x3wV3o3H3o3'; // any other program
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

const scan = (program: string, config?: unknown) => ({ jsonrpc: '2.0', id: '1', method: 'getProgramAccounts', params: config === undefined ? [program] : [program, config] });

/**
 * What a browser sent when a wallet holding a launched token opened the wallet
 * page, copied from the operator's report. Refusing it made the whole sync
 * fail, and the page then showed a private balance of zero.
 */
const REPORTED = {
  id: '1',
  jsonrpc: '2.0',
  method: 'getProgramAccounts',
  params: [
    'ring1GaLCuJnkUMVkX2JeZLTTX17wKsV4fZmPVzXANW',
    { commitment: 'confirmed', encoding: 'base64', filters: [{ dataSize: 48 }, { memcmp: { offset: 0, encoding: 'base64', bytes: 'BQ==' } }] },
  ],
};

/** The request the installed Rings SDK really builds for its token-registration list. */
async function sdkRegistryScan(): Promise<{ program: string; config: unknown }> {
  let captured: { program: string; config: unknown } | undefined;
  const solanaRpc = {
    getProgramAccounts(program: string, config: unknown) {
      // On the wire the SDK's big integers are plain numbers.
      captured = { program, config: JSON.parse(JSON.stringify(config, (_key, value: unknown) => (typeof value === 'bigint' ? Number(value) : value))) };
      return { send: async () => [] };
    },
  };
  const wallet = { ensureAsset: () => false };
  await backfillAssetRegistry(wallet as never, { solanaRpc, commitment: 'confirmed' } as never);
  if (!captured) throw new Error('The SDK did not ask for the registry.');
  return captured;
}

describe('the scan a Rings wallet needs', () => {
  it('is what the installed SDK asks for, and it is relayed', async () => {
    const { program, config } = await sdkRegistryScan();
    expect(program).toBe(SPP_PROGRAM_ID);
    expect(config).toEqual({
      commitment: 'confirmed',
      encoding: 'base64',
      filters: [{ dataSize: RINGS_REGISTRY_SCAN.dataSize }, { memcmp: { offset: 0, encoding: 'base64', bytes: Buffer.from([RINGS_REGISTRY_SCAN.type]).toString('base64') } }],
    });
    expect(checkCall(scan(program, config))).toBeNull();
  });

  it('is relayed exactly as the browser in the report sent it', () => {
    expect(REPORTED.params[0]).toBe(SPP_PROGRAM_ID);
    expect(checkCall(REPORTED)).toBeNull();
    // The same filters in the other order, and the type byte in the RPC's default encoding.
    expect(checkCall(scan(SPP_PROGRAM_ID, { filters: [{ memcmp: { offset: 0, encoding: 'base64', bytes: 'BQ==' } }, { dataSize: 48 }] }))).toBeNull();
    expect(checkCall(scan(SPP_PROGRAM_ID, { filters: [{ dataSize: 48 }, { memcmp: { offset: 0, bytes: '6' } }] }))).toBeNull();
  });

  it('is the only thing that can be listed from the Rings program', () => {
    const refused = [
      undefined,
      {},
      { filters: [] },
      { filters: [{ dataSize: 48 }] },
      { filters: [{ memcmp: { offset: 0, encoding: 'base64', bytes: 'BQ==' } }] },
      { filters: [{ dataSize: 100 }, { memcmp: { offset: 0, encoding: 'base64', bytes: 'BQ==' } }] },
      { filters: [{ dataSize: 48 }, { memcmp: { offset: 0, encoding: 'base64', bytes: 'AQ==' } }] },
      { filters: [{ dataSize: 48 }, { memcmp: { offset: 1, encoding: 'base64', bytes: 'BQ==' } }] },
      { filters: [{ dataSize: 48 }, { memcmp: { offset: 0, encoding: 'base64', bytes: 'BQ==' } }, { memcmp: { offset: 8, bytes: '6' } }] },
      { filters: [{ dataSize: 48 }, 'memcmp'] },
      { filters: [{ dataSize: 48 }, null] },
    ];
    for (const config of refused) {
      expect(checkCall(scan(SPP_PROGRAM_ID, config)), JSON.stringify(config)).toMatch(/Only the list of token registrations/);
    }
  });
});

describe('other scans', () => {
  it('pass for the two Meteora programs when they are filtered', () => {
    const filtered = { filters: [{ memcmp: { offset: 0, bytes: 'abc' } }] };
    expect(checkCall(scan(METEORA_DBC, filtered))).toBeNull();
    expect(checkCall(scan(METEORA_DAMM, filtered))).toBeNull();
    expect(checkCall(scan(METEORA_DBC))).toMatch(/must be filtered/);
    expect(checkCall(scan(METEORA_DAMM, { filters: [] }))).toMatch(/must be filtered/);
  });

  it('are refused for every other program, filtered or not', () => {
    for (const program of [USER_REGISTRY, TOKEN_PROGRAM, '11111111111111111111111111111111']) {
      expect(checkCall(scan(program, { filters: [{ dataSize: 48 }, { memcmp: { offset: 0, encoding: 'base64', bytes: 'BQ==' } }] }))).toMatch(/cannot be scanned/);
      expect(checkCall(scan(program))).toMatch(/cannot be scanned/);
    }
    expect(checkCall({ jsonrpc: '2.0', id: 1, method: 'getProgramAccounts' })).toMatch(/cannot be scanned/);
    expect(checkCall({ jsonrpc: '2.0', id: 1, method: 'getProgramAccounts', params: [42] })).toMatch(/cannot be scanned/);
  });

  it('are counted, so that they can be limited', () => {
    expect(countScans([REPORTED, { method: 'getBalance' }, REPORTED, null, 'x'])).toBe(2);
    expect(countScans([{ method: 'getBalance' }])).toBe(0);
  });
});

describe('ordinary calls', () => {
  it('pass when a wallet or a trade needs them, and are refused otherwise', () => {
    for (const method of ['getBalance', 'getAccountInfo', 'getMultipleAccounts', 'getLatestBlockhash', 'getSlot', 'getSignatureStatuses', 'sendTransaction', 'simulateTransaction', 'getTokenAccountsByOwner']) {
      expect(checkCall({ jsonrpc: '2.0', id: 1, method, params: [] }), method).toBeNull();
    }
    for (const method of ['requestAirdrop', 'getBlock', 'getLargestAccounts', 'getTokenLargestAccounts', 'getClusterNodes', '']) {
      expect(checkCall({ jsonrpc: '2.0', id: 1, method, params: [] }), method).toMatch(/not available/);
    }
    expect(checkCall(null)).toMatch(/Malformed/);
    expect(checkCall('getBalance')).toMatch(/Malformed/);
  });

  it('answer whether anything ever happened at an address, and do not serve its history', () => {
    const history = (config?: unknown) => ({ jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress', params: config === undefined ? [TOKEN_PROGRAM] : [TOKEN_PROGRAM, config] });
    // What the wallet sends when it looks for wallets made on another device.
    expect(checkCall(history({ limit: 1, commitment: 'confirmed' }))).toBeNull();
    expect(checkCall(history({ limit: 10 }))).toBeNull();
    // Without a limit the RPC would return a thousand entries.
    for (const config of [undefined, null, {}, { limit: 11 }, { limit: 1000 }, { limit: 0 }, { limit: -1 }, { limit: 1.5 }, { limit: '1' }]) {
      expect(checkCall(history(config)), JSON.stringify(config)).toMatch(/at most 10 entries/);
    }
    expect(checkCall({ jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress' })).toMatch(/at most 10 entries/);
  });
});

describe('the relay, end to end', () => {
  let upstream: Server;
  let site: Server;
  let base = '';
  const forwarded: unknown[] = [];

  beforeAll(async () => {
    // Stands in for the RPC provider: records what reaches it and answers with an empty list.
    upstream = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        forwarded.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: '1', result: [] }));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const env = readEnv({ SOLANA_RPC_URL: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/`, SPR_URL: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1/spr` });
    const app = express();
    app.use('/api', proxyRouter(env, new RateLimiter()));
    site = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => site.once('listening', resolve));
    base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => site.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  });

  const post = async (body: unknown): Promise<{ status: number; body: { error?: { code: string; message: string }; result?: unknown } }> => {
    const response = await fetch(`${base}/api/helius`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: (await response.json()) as { error?: { code: string; message: string }; result?: unknown } };
  };

  it("forwards the wallet's registry scan to the RPC provider, unchanged", async () => {
    forwarded.length = 0;
    const answer = await post(REPORTED);
    expect(answer.status).toBe(200);
    expect(answer.body.result).toEqual([]);
    expect(forwarded).toEqual([REPORTED]);
  });

  it('refuses any other scan of the Rings program without forwarding it', async () => {
    forwarded.length = 0;
    const answer = await post(scan(SPP_PROGRAM_ID, { filters: [{ dataSize: 100 }] }));
    expect(answer.status).toBe(403);
    expect(answer.body.error?.code).toBe('METHOD_NOT_ALLOWED');
    // One refused call refuses the whole batch.
    expect((await post([{ jsonrpc: '2.0', id: 1, method: 'getBalance', params: ['x'] }, scan(TOKEN_PROGRAM)])).status).toBe(403);
    expect(forwarded).toEqual([]);
  });

  it('lets one visitor run only so many scans a minute', async () => {
    let last = 0;
    for (let index = 0; index < 62; index += 1) last = (await post(REPORTED)).status;
    expect(last).toBe(429);
    // Ordinary calls are still served.
    expect((await post({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: ['x'] })).status).toBe(200);
  });
});

describe('native V33 browser discovery', () => {
  it('permits only the exact finalized schema-2 market scan', () => {
    const program='5o9DeQkYHXM3DQkzo16mAt6doaYrfhq3Q5aabWMfMy2n';
    // Base58 of the Market discriminator (dbbed53700e3c69a).
    const disc = 'dkokXHR3DTw';
    const cfg={encoding:'base64',commitment:'finalized',withContext:true,minContextSlot:474350900,filters:[{dataSize:611},{memcmp:{offset:0,bytes:disc}}]};
    expect(checkCall(scan(program,cfg))).toBeNull();
    for(const invalid of [{...cfg,filters:[]},{...cfg,filters:[{dataSize:611}]},{...cfg,filters:[{dataSize:139},cfg.filters[1]]},{...cfg,commitment:'confirmed'},{...cfg,withContext:false},{...cfg,minContextSlot:0},{...cfg,dataSlice:{offset:0,length:1}}])expect(checkCall(scan(program,invalid))).not.toBeNull();
  });
});
