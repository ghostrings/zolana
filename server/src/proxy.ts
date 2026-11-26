/**
 * Relays the browser's Solana RPC, Rings indexer and Rings prover traffic to
 * Helius so the API key never reaches a browser.
 *
 * What passes through:
 *  - JSON-RPC: only the methods a trading client needs (see ALLOWED_METHODS).
 *  - Indexer reads: tags and nullifiers the wallet asks about. These reveal
 *    which addresses a visitor is syncing, exactly as they would to Helius
 *    directly. The server does not log request bodies.
 *  - Prover requests: the SDK encrypts each one to an attested enclave before
 *    it leaves the browser. The relay forwards ciphertext it cannot read.
 */

import type { Request, Response, Router } from 'express';
import express from 'express';

import { SPP_PROGRAM_ID, TEE_POLICY_HOST } from '../../shared/src/constants.js';
import type { AppEnv } from './env.js';
import { type RateLimiter, clientIp, sendError } from './http.js';

const ALLOWED_METHODS = new Set([
  'getAccountInfo',
  'getBalance',
  'getBlockHeight',
  'getBlockTime',
  'getEpochInfo',
  'getFeeForMessage',
  'getGenesisHash',
  'getHealth',
  'getLatestBlockhash',
  'getMinimumBalanceForRentExemption',
  'getMultipleAccounts',
  'getPriorityFeeEstimate',
  'getProgramAccounts',
  'getRecentPrioritizationFees',
  'getSignatureStatuses',
  'getSignaturesForAddress',
  'getSlot',
  'getTokenAccountBalance',
  'getTokenAccountsByOwner',
  'getTokenSupply',
  'getTransaction',
  'getVersion',
  'isBlockhashValid',
  'sendTransaction',
  'simulateTransaction',
]);

/**
 * How many entries of an address's history one call may ask for. The wallet
 * asks for one, to learn whether anything ever happened at an address it can
 * derive; a long page of somebody's history is not what this relay is for.
 */
const HISTORY_PAGE_MAX = 10;

/** Programs a browser may enumerate accounts of. Anything else is an expensive scan with no use here. */
const SCANNABLE_PROGRAMS = new Set([
  'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN',
  'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG',
]);

/**
 * The one list a wallet must be able to read from the Rings program: its token
 * registrations, each saying which asset number is which mint. The Rings SDK
 * asks for the whole list whenever a wallet holds a token its local state has
 * not seen, and that wallet's sync cannot finish without the answer: refused,
 * the wallet reads as empty although its funds are on chain.
 *
 * The scan is accepted only in exactly the shape the SDK sends (accounts of
 * this size whose first byte is this type), so nothing else in the program
 * can be enumerated through this server. `tests/relay.test.ts` holds it to
 * what the pinned SDK version really asks.
 */
export const RINGS_REGISTRY_SCAN = Object.freeze({ dataSize: 48, type: 5 });

function isRingsRegistryScan(filters: readonly unknown[]): boolean {
  if (filters.length !== 2) return false;
  let sized = false;
  let typed = false;
  for (const filter of filters) {
    if (typeof filter !== 'object' || filter === null) return false;
    const { dataSize, memcmp } = filter as { dataSize?: unknown; memcmp?: { offset?: unknown; bytes?: unknown; encoding?: unknown } };
    if (dataSize !== undefined && Number(dataSize) === RINGS_REGISTRY_SCAN.dataSize) sized = true;
    if (typeof memcmp === 'object' && memcmp !== null && Number(memcmp.offset) === 0) {
      const one = Buffer.from([RINGS_REGISTRY_SCAN.type]);
      // The SDK sends base64. Base58, the RPC's default, is one character for a byte this small.
      if (memcmp.encoding === 'base64' && memcmp.bytes === one.toString('base64')) typed = true;
      if ((memcmp.encoding === undefined || memcmp.encoding === 'base58') && memcmp.bytes === '123456789ABCDEFGH'[RINGS_REGISTRY_SCAN.type]) typed = true;
    }
  }
  return sized && typed;
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  'cookie',
  'authorization',
  'origin',
  'referer',
  'accept-encoding',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'cf-connecting-ip',
]);

const UPSTREAM_TIMEOUT_MS = 60_000;

/** Why a JSON-RPC call is not relayed, or null when it is. */
export function checkCall(call: unknown): string | null {
  if (typeof call !== 'object' || call === null) return 'Malformed JSON-RPC call.';
  const { method, params } = call as { method?: unknown; params?: unknown };
  if (typeof method !== 'string' || !ALLOWED_METHODS.has(method)) return `Method not available through this relay: ${String(method)}`;
  if (method === 'getProgramAccounts') {
    const program = Array.isArray(params) ? params[0] : undefined;
    const config = Array.isArray(params) ? (params[1] as { filters?: unknown[] } | undefined) : undefined;
    const filters = Array.isArray(config?.filters) ? config.filters : [];
    if (program === SPP_PROGRAM_ID) {
      return isRingsRegistryScan(filters) ? null : 'Only the list of token registrations can be read from the Rings program through this relay.';
    }
    if (typeof program !== 'string' || !SCANNABLE_PROGRAMS.has(program)) return 'That program cannot be scanned through this relay.';
    if (filters.length === 0) return 'Program scans must be filtered.';
  }
  if (method === 'getSignaturesForAddress') {
    const config = Array.isArray(params) ? (params[1] as { limit?: unknown } | null | undefined) : undefined;
    const limit = config?.limit;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > HISTORY_PAGE_MAX) {
      return `An address's history is served at most ${HISTORY_PAGE_MAX} entries at a time through this relay.`;
    }
  }
  return null;
}

/** How many of these calls enumerate a program's accounts. */
export function countScans(calls: readonly unknown[]): number {
  return calls.filter((call) => typeof call === 'object' && call !== null && (call as { method?: unknown }).method === 'getProgramAccounts').length;
}

function forwardHeaders(request: Request): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  return headers;
}

async function relay(upstream: string, request: Request, response: Response, body: Buffer | undefined): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const result = await fetch(upstream, {
      method: request.method,
      headers: forwardHeaders(request),
      ...(body === undefined || request.method === 'GET' || request.method === 'HEAD' ? {} : { body }),
      redirect: 'error',
      signal: controller.signal,
    });
    response.status(result.status);
    result.headers.forEach((value, name) => {
      const lower = name.toLowerCase();
      if (HOP_BY_HOP.has(lower) || lower === 'content-encoding' || lower === 'set-cookie' || lower.startsWith('access-control-')) return;
      response.setHeader(name, value);
    });
    response.setHeader('cache-control', 'no-store');
    response.end(Buffer.from(await result.arrayBuffer()));
  } catch {
    sendError(response, 502, 'UPSTREAM', 'The RPC provider did not answer. Try again.');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `mainnet` resolves once the RPC behind this relay has been confirmed to be
 * Solana mainnet, and rejects otherwise. Nothing is relayed until it resolves,
 * so a browser can never be handed another network through this server.
 */
export function proxyRouter(env: AppEnv, limiter: RateLimiter, mainnet?: () => Promise<void>): Router {
  const router = express.Router();
  const rpcUrl = env.heliusRpcUrl;
  const sprUrl = env.heliusSprUrl;

  /** True when the request may go on; otherwise the error has been sent. */
  async function confirmedMainnet(response: Response): Promise<boolean> {
    if (!mainnet) return true;
    try {
      await mainnet();
      return true;
    } catch {
      sendError(response, 503, 'NETWORK_UNCONFIRMED', 'This server has not confirmed that its RPC is Solana mainnet, so it is not relaying.');
      return false;
    }
  }

  // Solana JSON-RPC.
  router.post('/helius', express.json({ limit: '256kb', type: () => true }), async (request, response) => {
    if (!rpcUrl) return sendError(response, 503, 'NOT_CONFIGURED', 'The RPC is not configured on this server.');
    if (!limiter.take(`rpc:${clientIp(request)}`, 600, 60_000)) return sendError(response, 429, 'RATE_LIMITED', 'Too many requests. Slow down.');
    const payload: unknown = request.body;
    const calls = Array.isArray(payload) ? payload : [payload];
    if (calls.length === 0 || calls.length > 40) return sendError(response, 400, 'BAD_REQUEST', 'Send between 1 and 40 calls.');
    for (const call of calls) {
      const problem = checkCall(call);
      if (problem) return sendError(response, 403, 'METHOD_NOT_ALLOWED', problem);
    }
    // Scans are the heavy calls. A page needs one or two; a visitor gets sixty a minute.
    for (let scan = countScans(calls); scan > 0; scan -= 1) {
      if (!limiter.take(`scan:${clientIp(request)}`, 60, 60_000)) return sendError(response, 429, 'RATE_LIMITED', 'Too many requests. Slow down.');
    }
    if (!(await confirmedMainnet(response))) return;
    await relay(rpcUrl, request, response, Buffer.from(JSON.stringify(payload)));
  });

  // Rings indexer and prover: `/v1/spr/...` on the same Helius host.
  router.all('/helius/v1/spr{/*rest}', express.raw({ limit: '4mb', type: () => true }), async (request, response) => {
    if (!sprUrl) return sendError(response, 503, 'NOT_CONFIGURED', 'The Rings endpoint is not configured on this server.');
    if (!limiter.take(`spr:${clientIp(request)}`, 400, 60_000)) return sendError(response, 429, 'RATE_LIMITED', 'Too many requests. Slow down.');
    if (!['GET', 'POST', 'HEAD'].includes(request.method)) return sendError(response, 405, 'METHOD', 'Unsupported method.');
    const rest = request.path.slice('/helius/v1/spr'.length);
    if (rest.includes('..') || rest.includes('//') || !/^[A-Za-z0-9/_.\-]*$/.test(rest)) {
      return sendError(response, 400, 'BAD_PATH', 'Unsupported path.');
    }
    // A proof is the one expensive call here: it is billed per request to this server's key.
    if (request.method === 'POST' && (rest === '/prove' || rest.startsWith('/prove/'))) {
      const ip = clientIp(request);
      if (!limiter.take(`proof:${ip}`, env.proofsPerMinutePerIp, 60_000) || !limiter.take(`proof-hour:${ip}`, env.proofsPerMinutePerIp * 10, 3_600_000)) {
        return sendError(response, 429, 'RATE_LIMITED', 'Too many proofs from this address. Wait a minute and try again.');
      }
      if (!limiter.take('proof:site-day', env.proofsDailyLimit, 86_400_000)) {
        return sendError(response, 429, 'PROOF_BUDGET', 'The site has reached its proving budget for today. Private transactions resume when it resets.');
      }
    }
    const upstream = new URL(sprUrl);
    upstream.pathname = `${upstream.pathname.replace(/\/+$/, '')}${rest}`;
    for (const [key, value] of Object.entries(request.query)) {
      if (key.toLowerCase() === 'api-key' || typeof value !== 'string') continue;
      upstream.searchParams.set(key, value);
    }
    const body = Buffer.isBuffer(request.body) && request.body.length > 0 ? request.body : undefined;
    if (!(await confirmedMainnet(response))) return;
    await relay(upstream.toString(), request, response, body);
  });

  // The signed prover attestation policy. The SDK verifies its signatures against pinned keys.
  router.get('/tee-policy/tee-policy/:file', async (request, response) => {
    const file = request.params.file;
    // Mainnet's policy and no other: a prover attested for a test network is never accepted.
    if (file !== 'mainnet.json') return sendError(response, 404, 'NOT_FOUND', 'Unknown policy.');
    if (!limiter.take(`tee:${clientIp(request)}`, 60, 60_000)) return sendError(response, 429, 'RATE_LIMITED', 'Too many requests.');
    await relay(`https://${TEE_POLICY_HOST}/tee-policy/${file}`, request, response, undefined);
  });

  return router;
}
