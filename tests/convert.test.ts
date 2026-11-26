import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { Keypair } from '@solana/web3.js';

import { CONVERT_ASSETS, KNOWN_PAIR_MINTS, Spacer, baseCap, convertRouter, isOutside, readConvertRequest } from '../server/src/convert.js';
import { EnvError, readEnv } from '../server/src/env.js';
import { RateLimiter } from '../server/src/http.js';
import { redact } from '../server/src/redact.js';
import { WSOL_MINT } from '../shared/src/constants.js';
import { JUPITER_BUILD_URL, readBuild } from '../shared/src/jupiter.js';
import { PAIR_TOKENS } from '../shared/src/quotes.js';
import { explainError } from '../web/src/errors.js';
import { BONK_MINT, USDC_MINT, ZEC_MINT, answerFor } from './jupiter-fixtures.js';

const taker = Keypair.generate().publicKey.toBase58();
const inUse = new Set([WSOL_MINT, USDC_MINT, ZEC_MINT]);
const good = { inputMint: WSOL_MINT, outputMint: ZEC_MINT, amount: '250000000', taker, slippageBps: '50', maxAccounts: '36' };

describe('what the conversion relay will ask Jupiter', () => {
  it('reads a request between SOL or USDC and a pair token in use', () => {
    expect(readConvertRequest(good, inUse, 1000)).toEqual({ inputMint: WSOL_MINT, outputMint: ZEC_MINT, amount: 250_000_000n, taker, slippageBps: 50, maxAccounts: 36 });
    expect(typeof readConvertRequest({ ...good, inputMint: ZEC_MINT, outputMint: USDC_MINT }, inUse, 1000)).toBe('object');
    expect(typeof readConvertRequest({ ...good, inputMint: USDC_MINT, outputMint: WSOL_MINT }, inUse, 1000)).toBe('object');
  });

  it('refuses a token this site has no pair for, however real it is', () => {
    const near = PAIR_TOKENS.find((token) => token.id === 'NEAR')?.mint as string;
    expect(readConvertRequest({ ...good, outputMint: near }, inUse, 1000)).toMatch(/only between SOL, USDC and the pair tokens it has in use/);
    expect(readConvertRequest({ ...good, outputMint: Keypair.generate().publicKey.toBase58() }, inUse, 1000)).toMatch(/only between/);
    // Once the pair is in use, it is accepted.
    expect(typeof readConvertRequest({ ...good, outputMint: near }, new Set([...inUse, near]), 1000)).toBe('object');
  });

  it('refuses a conversion with neither SOL nor USDC in it, and one from a token to itself', () => {
    const near = PAIR_TOKENS.find((token) => token.id === 'NEAR')?.mint as string;
    expect(readConvertRequest({ ...good, inputMint: near }, new Set([...inUse, near]), 1000)).toMatch(/must be SOL or USDC/);
    expect(readConvertRequest({ ...good, outputMint: WSOL_MINT }, inUse, 1000)).toMatch(/itself/);
  });

  it('refuses amounts, wallets, limits and sizes that are not what they should be', () => {
    for (const amount of ['0', '-5', '1.5', '1e9', '', '012', '99999999999999999999']) expect(readConvertRequest({ ...good, amount }, inUse, 1000)).toMatch(/amount/);
    expect(readConvertRequest({ ...good, taker: 'not-a-wallet' }, inUse, 1000)).toMatch(/taker/);
    for (const slippageBps of ['0', '1001', '2.5', 'rtse', '']) expect(readConvertRequest({ ...good, slippageBps }, inUse, 1000)).toMatch(/slippageBps/);
    for (const maxAccounts of ['7', '65', '20.5', '']) expect(readConvertRequest({ ...good, maxAccounts }, inUse, 1000)).toMatch(/maxAccounts/);
    expect(readConvertRequest({ ...good, inputMint: ['a', 'b'] }, inUse, 1000)).toMatch(/token addresses/);
  });

  it('knows every pair token of this build, so a request can be checked before any pair is confirmed', () => {
    for (const token of PAIR_TOKENS) expect(KNOWN_PAIR_MINTS.has(token.mint)).toBe(true);
    for (const asset of CONVERT_ASSETS) expect(KNOWN_PAIR_MINTS.has(asset.mint)).toBe(true);
  });
});

describe('what the relay will ask Jupiter for a token that was not launched here', () => {
  const outside = { ...good, outputMint: BONK_MINT };

  it('refuses it until the operator has switched that on', () => {
    expect(readConvertRequest(outside, inUse, 1000)).toMatch(/only between SOL, USDC and the pair tokens it has in use/);
    expect(readConvertRequest(outside, inUse, 1000, false)).toMatch(/only between/);
  });

  it('then takes any token on one side, as long as SOL or USDC is on the other', () => {
    expect(readConvertRequest(outside, inUse, 1000, true)).toEqual({ inputMint: WSOL_MINT, outputMint: BONK_MINT, amount: 250_000_000n, taker, slippageBps: 50, maxAccounts: 36 });
    expect(typeof readConvertRequest({ ...good, inputMint: BONK_MINT, outputMint: USDC_MINT }, inUse, 1000, true)).toBe('object');
    // A token nobody has heard of is an address like any other.
    expect(typeof readConvertRequest({ ...good, outputMint: Keypair.generate().publicKey.toBase58() }, inUse, 1000, true)).toBe('object');
    // Two tokens with neither SOL nor USDC between them are not a trade this site makes.
    expect(readConvertRequest({ ...good, inputMint: BONK_MINT, outputMint: ZEC_MINT }, inUse, 1000, true)).toMatch(/One side of a trade must be SOL or USDC/);
    expect(readConvertRequest({ ...good, inputMint: BONK_MINT, outputMint: BONK_MINT }, inUse, 1000, true)).toMatch(/itself/);
  });

  it('still reads the rest of the request as strictly', () => {
    expect(readConvertRequest({ ...outside, amount: '1.5' }, inUse, 1000, true)).toMatch(/amount/);
    expect(readConvertRequest({ ...outside, taker: 'nobody' }, inUse, 1000, true)).toMatch(/taker/);
    expect(readConvertRequest({ ...outside, slippageBps: '1001' }, inUse, 1000, true)).toMatch(/slippageBps/);
    expect(readConvertRequest({ ...outside, outputMint: 'not-an-address' }, inUse, 1000, true)).toMatch(/token addresses/);
  });

  it('knows which requests are for such a token', () => {
    expect(isOutside({ inputMint: WSOL_MINT, outputMint: BONK_MINT }, inUse)).toBe(true);
    expect(isOutside({ inputMint: BONK_MINT, outputMint: USDC_MINT }, inUse)).toBe(true);
    expect(isOutside({ inputMint: WSOL_MINT, outputMint: ZEC_MINT }, inUse)).toBe(false);
  });
});

describe('the operator’s limit on a single trade, in SOL and in USDC', () => {
  const pairs = [
    { mint: WSOL_MINT, decimals: 9, unitsPerSol: 1 },
    { mint: USDC_MINT, decimals: 6, unitsPerSol: 76 },
  ];

  it('is the limit itself for SOL, and the same at the pair’s rate for USDC', () => {
    expect(baseCap(WSOL_MINT, 2_000_000_000n, pairs)).toBe(2_000_000_000n);
    expect(baseCap(USDC_MINT, 2_000_000_000n, pairs)).toBe(152_000_000n);
    expect(baseCap(USDC_MINT, 500_000_000n, pairs)).toBe(38_000_000n);
  });

  it('is nothing at all when the operator set none', () => {
    expect(baseCap(WSOL_MINT, 0n, pairs)).toBe(0n);
    expect(baseCap(USDC_MINT, 0n, pairs)).toBe(0n);
  });

  it('lets nothing through in a token it cannot be expressed in', () => {
    expect(baseCap(USDC_MINT, 2_000_000_000n, [{ mint: USDC_MINT, decimals: 6, unitsPerSol: 0 }])).toBe(1n);
    expect(baseCap(USDC_MINT, 2_000_000_000n, [])).toBe(1n);
  });
});

describe('spacing requests to what the key allows', () => {
  it('lets the first through at once and makes the next ones wait their turn', () => {
    let clock = 1_000_000;
    const spacer = new Spacer(2, 2_500, () => clock);
    expect(spacer.reserve()).toBe(0);
    expect(spacer.reserve()).toBe(500);
    expect(spacer.reserve()).toBe(1000);
    // Time passing frees the queue again.
    clock += 2_000;
    expect(spacer.reserve()).toBe(0);
  });

  it('turns a request away instead of holding it when the queue is too long', () => {
    const clock = 5_000;
    const spacer = new Spacer(1, 2_500, () => clock);
    expect([spacer.reserve(), spacer.reserve(), spacer.reserve()]).toEqual([0, 1000, 2000]);
    expect(spacer.reserve()).toBeNull();
    // Being turned away does not lengthen the queue.
    expect(spacer.reserve()).toBeNull();
  });
});

describe('the conversion relay, end to end', () => {
  let site: Server;
  let base = '';
  let paused: string | null = null;
  let answer: { status: number; body: string } = { status: 200, body: '{}' };
  const asked: Array<{ url: string; key: string | null }> = [];
  const logs: string[] = [];

  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    asked.push({ url: String(input), key: headers.get('x-api-key') });
    return new Response(answer.body, { status: answer.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  beforeAll(async () => {
    const app = express();
    app.use(
      '/api/convert',
      convertRouter(
        { apiKey: 'jup-test-key-000111', requestsPerSecond: 100, maxSlippageBps: 1000, mints: () => inUse, paused: () => paused, fetch: fakeFetch, sleep: async () => undefined, log: (line) => logs.push(line) },
        new RateLimiter(),
      ),
    );
    site = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => site.once('listening', resolve));
    base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => site.close(resolve));
  });

  beforeEach(() => {
    asked.length = 0;
    logs.length = 0;
    paused = null;
  });

  const get = async (query: Record<string, string>, headers: Record<string, string> = {}) => {
    const response = await fetch(`${base}/api/convert/build?${new URLSearchParams(query).toString()}`, { headers });
    return { status: response.status, cache: response.headers.get('cache-control'), body: (await response.json()) as { error?: { code: string; message: string } } & Record<string, unknown> };
  };

  it('asks Jupiter for version 1 instructions with the operator’s key, and hands the answer back as it came', async () => {
    const request = { inputMint: WSOL_MINT, outputMint: ZEC_MINT, amount: 250_000_000n, taker, slippageBps: 50, maxAccounts: 36 };
    answer = { status: 200, body: JSON.stringify(answerFor(request)) };
    const result = await get(good);
    expect(result.status).toBe(200);
    expect(result.cache).toBe('no-store');
    expect(asked).toHaveLength(1);
    const url = new URL(asked[0]?.url as string);
    expect(`${url.origin}${url.pathname}`).toBe(JUPITER_BUILD_URL);
    expect(Object.fromEntries(url.searchParams)).toEqual({ ...good, transactionVersion: '1' });
    expect(asked[0]?.key).toBe('jup-test-key-000111');
    // What the page gets is exactly what its own check accepts.
    expect(readBuild(result.body, request).amountIn).toBe(250_000_000n);
  });

  it('never forwards anything the page added to the request', async () => {
    answer = { status: 200, body: '{}' };
    await get({ ...good, amount: '250000001', feeAccount: taker, platformFeeBps: '100', payer: taker, destinationTokenAccount: taker, transactionVersion: '0' });
    const url = new URL(asked[0]?.url as string);
    expect([...url.searchParams.keys()].sort()).toEqual(['amount', 'inputMint', 'maxAccounts', 'outputMint', 'slippageBps', 'taker', 'transactionVersion']);
    expect(url.searchParams.get('transactionVersion')).toBe('1');
  });

  it('answers the same question asked twice in a moment from what it was just told', async () => {
    answer = { status: 200, body: '{"n":1}' };
    const query = { ...good, amount: '777' };
    expect((await get(query)).body).toEqual({ n: 1 });
    answer = { status: 200, body: '{"n":2}' };
    expect((await get(query)).body).toEqual({ n: 1 });
    expect(asked).toHaveLength(1);
  });

  it('does not ask Jupiter at all for a request it would not make', async () => {
    const refused = await get({ ...good, outputMint: Keypair.generate().publicKey.toBase58() });
    expect(refused.status).toBe(400);
    expect(refused.body.error?.code).toBe('BAD_REQUEST');
    expect(asked).toHaveLength(0);
  });

  it('says there is no route when Jupiter finds none, in words a person can act on', async () => {
    answer = { status: 400, body: '{"error":"No routes found"}' };
    const result = await get({ ...good, amount: '5' });
    expect(result.status).toBe(422);
    expect(result.body.error?.code).toBe('NO_ROUTE');
    expect(result.body.error?.message).toMatch(/no route for this conversion at this size \(No routes found\)/);
    // The page shows that sentence as it is.
    expect(explainError({ name: 'ApiError', code: 'NO_ROUTE', message: result.body.error?.message })).toBe(result.body.error?.message);
  });

  it('says it is busy when Jupiter is rate limiting, and that converting is unavailable when the key is refused', async () => {
    answer = { status: 429, body: '{}' };
    const busy = await get({ ...good, amount: '6' });
    expect([busy.status, busy.body.error?.code]).toEqual([429, 'CONVERTER_BUSY']);
    answer = { status: 401, body: '{"error":"Unauthorized"}' };
    const refused = await get({ ...good, amount: '7' });
    expect([refused.status, refused.body.error?.code]).toEqual([502, 'CONVERTER_DOWN']);
    // The operator is told which setting to look at; the visitor is not shown it.
    expect(logs.join(' ')).toMatch(/JUPITER_API_KEY/);
    expect(refused.body.error?.message).not.toMatch(/key/i);
    answer = { status: 200, body: '<html>not json</html>' };
    expect((await get({ ...good, amount: '8' })).body.error?.code).toBe('CONVERTER_DOWN');
  });

  it('stops when trading through the site is paused', async () => {
    paused = 'Trading is paused while something is looked into.';
    const result = await get({ ...good, amount: '9' });
    expect([result.status, result.body.error?.code, result.body.error?.message]).toEqual([503, 'TRADING_PAUSED', paused]);
    expect(asked).toHaveLength(0);
  });

  it('is not for other websites: a request a browser marks as cross-site is refused', async () => {
    answer = { status: 200, body: '{}' };
    const result = await get({ ...good, amount: '10' }, { 'sec-fetch-site': 'cross-site' });
    expect([result.status, result.body.error?.code]).toEqual([403, 'CROSS_ORIGIN']);
    expect((await get({ ...good, amount: '10' }, { 'sec-fetch-site': 'same-origin' })).status).toBe(200);
    expect(asked).toHaveLength(1);
  });

  it('gives one visitor only so many quotes a minute', async () => {
    answer = { status: 200, body: '{}' };
    let last = 0;
    for (let index = 0; index < 45; index += 1) last = (await get({ ...good, amount: String(1000 + index) })).status;
    expect(last).toBe(429);
  });
});

describe('the relay for tokens that were not launched here, end to end', () => {
  let site: Server;
  let base = '';
  let answer: { status: number; body: string } = { status: 200, body: '{}' };
  let anyToken = true;
  let cap = 2_000_000_000n;
  const asked: string[] = [];

  const fakeFetch = (async (input: string | URL | Request) => {
    asked.push(String(input));
    return new Response(answer.body, { status: answer.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  const start = async (): Promise<void> => {
    const app = express();
    app.use(
      '/api/convert',
      convertRouter(
        {
          apiKey: 'jup-test-key-000111',
          requestsPerSecond: 100,
          maxSlippageBps: 1000,
          mints: () => inUse,
          paused: () => null,
          anyToken,
          cap: (mint) => baseCap(mint, cap, [{ mint: USDC_MINT, decimals: 6, unitsPerSol: 76 }]),
          fetch: fakeFetch,
          sleep: async () => undefined,
        },
        new RateLimiter(),
      ),
    );
    site = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => site.once('listening', resolve));
    base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  };
  const stop = (): Promise<unknown> => new Promise((resolve) => site.close(resolve));

  beforeAll(start);
  afterAll(stop);
  beforeEach(() => {
    asked.length = 0;
  });

  const get = async (query: Record<string, string>) => {
    const response = await fetch(`${base}/api/convert/build?${new URLSearchParams(query).toString()}`);
    return { status: response.status, body: (await response.json()) as { error?: { code: string; message: string } } & Record<string, unknown> };
  };
  const buy = { inputMint: WSOL_MINT, outputMint: BONK_MINT, amount: '100000000', taker, slippageBps: '100', maxAccounts: '44' };
  const sell = { inputMint: BONK_MINT, outputMint: WSOL_MINT, amount: '1000000000000', taker, slippageBps: '100', maxAccounts: '44' };

  it('asks Jupiter for a buy of any token, and hands the answer back as it came', async () => {
    const request = { inputMint: WSOL_MINT, outputMint: BONK_MINT, amount: 100_000_000n, taker, slippageBps: 100, maxAccounts: 44 };
    answer = { status: 200, body: JSON.stringify(answerFor(request)) };
    const result = await get(buy);
    expect(result.status).toBe(200);
    expect(asked).toHaveLength(1);
    expect(Object.fromEntries(new URL(asked[0] as string).searchParams)).toEqual({ ...buy, transactionVersion: '1' });
    expect(readBuild(result.body, request).outputMint).toBe(BONK_MINT);
  });

  it('holds a buy to the operator’s limit before Jupiter is asked anything', async () => {
    const over = await get({ ...buy, amount: '2000000001' });
    expect([over.status, over.body.error?.code]).toEqual([422, 'OVER_LIMIT']);
    expect(over.body.error?.message).toMatch(/more than a single trade/);
    expect(asked).toHaveLength(0);
    // The page shows that sentence as it is.
    expect(explainError({ name: 'ApiError', code: 'OVER_LIMIT', message: over.body.error?.message })).toBe(over.body.error?.message);
    // In USDC the same limit applies at the pair's rate: 152 USDC here.
    const usdc = await get({ ...buy, inputMint: USDC_MINT, amount: '152000001' });
    expect(usdc.body.error?.code).toBe('OVER_LIMIT');
    expect(asked).toHaveLength(0);
    answer = { status: 200, body: '{}' };
    expect((await get({ ...buy, inputMint: USDC_MINT, amount: '152000000' })).status).toBe(200);
  });

  it('holds a sale to the limit by what Jupiter says it pays out', async () => {
    const request = { inputMint: BONK_MINT, outputMint: WSOL_MINT, amount: 1_000_000_000_000n, taker, slippageBps: 100, maxAccounts: 44 };
    answer = { status: 200, body: JSON.stringify(answerFor(request, { expectedOut: 2_000_000_001n })) };
    const over = await get(sell);
    expect([over.status, over.body.error?.code]).toEqual([422, 'OVER_LIMIT']);
    // Asked again a moment later, the answer it was just given is held to the limit the same way.
    expect((await get(sell)).body.error?.code).toBe('OVER_LIMIT');
    expect(asked).toHaveLength(1);
    const within = { ...sell, amount: '999999999999' };
    answer = { status: 200, body: JSON.stringify(answerFor({ ...request, amount: 999_999_999_999n }, { expectedOut: 2_000_000_000n })) };
    expect((await get(within)).status).toBe(200);
    // An answer that does not say what it pays is not let past the limit.
    answer = { status: 200, body: '{"outAmount":"lots"}' };
    expect((await get({ ...sell, amount: '5' })).body.error?.code).toBe('OVER_LIMIT');
  });

  it('does not apply that limit to a token launched here, whose own page holds it to its limit', async () => {
    answer = { status: 200, body: '{}' };
    const result = await get({ ...good, amount: '9000000000' });
    expect(result.status).toBe(200);
  });

  it('says there is no route for a token in words that fit a token, not a conversion', async () => {
    answer = { status: 400, body: '{"error":"No routes found"}' };
    const result = await get({ ...buy, amount: '77' });
    expect([result.status, result.body.error?.code]).toEqual([422, 'NO_ROUTE']);
    expect(result.body.error?.message).toMatch(/no route for this token at this size \(No routes found\)/);
    expect(result.body.error?.message).not.toMatch(/pair token/);
    answer = { status: 500, body: 'oops' };
    expect((await get({ ...buy, amount: '78' })).body.error?.message).not.toMatch(/pair token/);
  });

  it('with no limit set, lets any size through', async () => {
    await stop();
    cap = 0n;
    await start();
    answer = { status: 200, body: '{}' };
    expect((await get({ ...buy, amount: '900000000000' })).status).toBe(200);
  });

  it('switched off, refuses a token that was not launched here without asking Jupiter', async () => {
    await stop();
    anyToken = false;
    await start();
    const refused = await get(buy);
    expect([refused.status, refused.body.error?.code]).toEqual([400, 'BAD_REQUEST']);
    expect(asked).toHaveLength(0);
    // Converting for tokens launched here goes on as before.
    answer = { status: 200, body: '{}' };
    expect((await get(good)).status).toBe(200);
  });
});

describe('buying tokens that were not launched here, as a setting', () => {
  it('is on unless the operator says no', () => {
    expect(readEnv({}).swapAnyToken).toBe(true);
    expect(readEnv({ SWAP_ANY_TOKEN: 'YES' }).swapAnyToken).toBe(true);
    expect(readEnv({ SWAP_ANY_TOKEN: 'NO' }).swapAnyToken).toBe(false);
    expect(() => readEnv({ SWAP_ANY_TOKEN: 'off' })).toThrow(EnvError);
  });
});

describe('the Jupiter key as a setting', () => {
  it('is off until it is set, and allows one request a second unless told the plan allows more', () => {
    expect(readEnv({}).jupiterApiKey).toBeUndefined();
    expect(readEnv({ JUPITER_API_KEY: 'abcd-1234-efgh-5678' }).jupiterApiKey).toBe('abcd-1234-efgh-5678');
    expect(readEnv({ JUPITER_API_KEY: 'abcd-1234-efgh-5678' }).jupiterRps).toBe(1);
    expect(readEnv({ JUPITER_API_KEY: 'abcd-1234-efgh-5678', JUPITER_RPS: '10' }).jupiterRps).toBe(10);
  });

  it('refuses a paste gone wrong, without printing it', () => {
    let thrown: unknown;
    try {
      readEnv({ JUPITER_API_KEY: 'abcd 1234 with spaces' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(EnvError);
    expect((thrown as Error).message).toMatch(/JUPITER_API_KEY/);
    expect((thrown as Error).message).not.toMatch(/abcd/);
  });

  it('is kept out of anything this project prints', () => {
    expect(redact('request failed with x-api-key abcd-1234-efgh-5678', { JUPITER_API_KEY: 'abcd-1234-efgh-5678' })).toBe('request failed with x-api-key [JUPITER_API_KEY hidden]');
  });
});
